// Money module: the card (or bank account) on file (design §6.2 "Save a
// card", "Card verification sweep"; §5.1 the money stats part).
//
// The method a charge uses is the one RECORDED by the CRM (on the plan,
// billing.payment_method_id, or the contact's stats.money.stripe.default_pm),
// never "whatever Stripe's default is". card_status: none | on_file |
// verified | missing_in_stripe | expired | failed.
//
//   cardFor(contactId, plan?)   → { usable, payment_method_id, customer_id, mandate_id, kind, status }
//   cardStatus(contactId)       the money.cardStatus service → { status, pm }
//   recordSavedMethod(...)      a card saved in Checkout (setup or "save this
//                               card"): stats, the contact's plans that want a
//                               card, then card.saved (Plans activates a plan
//                               that waited for it)
//   verifyCards (sweep)         read-only: list each CRM customer's methods.
//                               Only with a real driver: in dry-run nothing is
//                               known, so nothing is marked missing.

import { getRecord, getRecords, updateRecord, updateStats, listRel, listKeys, readPointer, readIndex } from "../../../crm-store.mjs";
import { isId } from "../../core/ids.mjs";
import { now, localDate, addLocalDays } from "../../core/clock.mjs";
import { emit } from "../../core/events.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { W, moneyStats, STATS_DEFAULTS, mapLimit } from "./common.mjs";
import { payments } from "./gate.mjs";

export const USABLE = Object.freeze(["on_file", "verified"]);

export async function cardFor(contactId, plan = null) {
  const st = await moneyStats(contactId);
  const s = st.stripe || {};
  const pm = s.default_pm || null;
  const bill = (plan && plan.billing) || {};
  const id = bill.payment_method_id || (pm && pm.id) || null;
  const usable = !!id && USABLE.includes(s.card_status || "none");
  return {
    usable, status: s.card_status || "none", payment_method_id: id, customer_id: bill.stripe_customer_id || s.crm_customer_id || (s.customer_ids || [])[0] || null,
    mandate_id: (pm && pm.id === id && pm.mandate_id) || bill.mandate_id || null, kind: (pm && pm.kind) || "card", brand: pm && pm.brand, last4: pm && pm.last4,
    exp_month: pm && pm.exp_month, exp_year: pm && pm.exp_year,
  };
}

// money.cardStatus (§11.3): (contact_id, ctx) → { status, pm? }
export async function cardStatus(contactId) {
  const st = await moneyStats(contactId);
  const s = st.stripe || {};
  const pm = s.default_pm;
  return { status: s.card_status || "none", ...(pm ? { pm: { kind: pm.kind || "card", brand: pm.brand || null, last4: pm.last4 || null, exp_month: pm.exp_month || null, exp_year: pm.exp_year || null } } : {}) };
}

// A method saved in Checkout. pm: { id, kind, brand, last4, exp_month,
// exp_year, mandate_id }, customer_id (the CRM's own, or null in dry-run).
export async function recordSavedMethod(contactId, pm, { customer_id, created_customer = false } = {}, ctx = {}) {
  if (!isId(contactId, "contact") || !pm || !pm.id) return null;
  const w = W(ctx);
  const r = await updateStats(contactId, "money", (p) => {
    const stripe = { ...STATS_DEFAULTS.stripe, ...((p && p.stripe) || {}) };
    const next = {
      ...STATS_DEFAULTS, ...p,
      stripe: {
        ...stripe, card_status: "on_file",
        default_pm: { id: pm.id, kind: pm.kind === "us_bank_account" ? "us_bank_account" : "card", ...(pm.brand ? { brand: String(pm.brand).slice(0, 20) } : {}), ...(pm.last4 ? { last4: String(pm.last4).slice(-4) } : {}), ...(pm.exp_month ? { exp_month: pm.exp_month, exp_year: pm.exp_year } : {}), ...(pm.mandate_id ? { mandate_id: pm.mandate_id } : {}), saved_at: now().toISOString() },
        ...(customer_id ? { crm_customer_id: customer_id, customer_ids: [...new Set([...(stripe.customer_ids || []), customer_id])] } : {}),
        ...(created_customer && customer_id ? { crm_created_ids: [...new Set([...(stripe.crm_created_ids || []), customer_id])] } : {}),
      },
    };
    return JSON.stringify(next) === JSON.stringify(p) ? null : next;
  }, w);
  // every live plan of this contact that wants a card charges this one (§6.2)
  const rows = await listRel("contact-plans", contactId, { limit: 50 }).catch(() => []);
  for (const g of (await getRecords("plan", rows.map((x) => x.id))).filter(Boolean)) {
    const plan = g.data;
    if (!["pending", "active", "paused", "cancelling"].includes(plan.status) || !(plan.billing && (plan.billing.autopay || plan.billing.card_required))) continue;
    await updateRecord("plan", plan.id, (p) => (p.billing && p.billing.payment_method_id === pm.id ? null : { ...p, billing: { ...p.billing, payment_method_id: pm.id, ...(customer_id ? { stripe_customer_id: customer_id } : {}), ...(pm.mandate_id ? { mandate_id: pm.mandate_id } : {}), pm_kind: pm.kind === "us_bank_account" ? "us_bank_account" : "card" } }), w)
      .catch((e) => console.error(`crm:money: a plan didn't get its card (${safeErr(e)})`));
  }
  if (r && r.changed) {
    await emit("card.saved", { id: contactId, wv: r.data.wv, contact_id: contactId, pm: pm.kind === "us_bank_account" ? "us_bank_account" : "card" }, w)
      .catch((e) => console.error(`crm:money: card.saved not queued (${safeErr(e)})`));
  }
  return r ? r.data : null;
}

// A charge on the method failed for good (a decline, a failed bank debit).
export async function markMethodFailed(contactId, ctx = {}) {
  if (!isId(contactId, "contact")) return;
  await updateStats(contactId, "money", (p) => {
    const stripe = { ...STATS_DEFAULTS.stripe, ...((p && p.stripe) || {}) };
    if (stripe.card_status === "failed" || !stripe.default_pm) return null;
    return { ...STATS_DEFAULTS, ...p, stripe: { ...stripe, card_status: "failed" } };
  }, W(ctx)).catch(() => null);
}

// ------------------------------------------------------------ payments.verify_cards

// Weekly (bulk lane), read-only: each contact with a Stripe customer id
// (ptr/stripe-cus) gets card_status verified / missing_in_stripe / expired.
// Nothing runs in dry-run (nothing would be known) or while paused.
export async function verifyCards(ctx) {
  const p = await payments({ deploy: ctx.deploy, mode: ctx.mode || undefined });
  if (p.mode !== "live" && p.mode !== "test") return { result: `skipped:${p.mode}` };
  const keys = await listKeys("ptr/stripe-cus/");
  const start = ctx.cursor && typeof ctx.cursor.i === "number" ? ctx.cursor.i : 0;
  let i = start;
  let checked = 0;
  const ym = localDate(now()).slice(0, 7);
  for (; i < keys.length; i++) {
    if (ctx.budget && ctx.budget.left() < 10000) return { done: false, cursor: { i }, progress: checked };
    const ptr = await readPointer("stripe-cus", keys[i].split("/").pop()).catch(() => null);
    for (const contactId of ((ptr && (ptr.ids || (ptr.id ? [ptr.id] : []))) || []).filter((x) => isId(x, "contact")).slice(0, 3)) {
      const st = await moneyStats(contactId);
      const s = st.stripe || {};
      // test mode sees only the test account's customers: only ones the CRM made there
      const ids = p.mode === "test" ? (s.crm_created_ids || []) : (s.customer_ids || []);
      if (!ids.length) continue;
      let methods = [];
      try {
        for (const cus of ids.slice(0, 3)) methods.push(...await p.impl.listPaymentMethods({ customer_id: cus }));
      } catch (e) { console.error(`crm:money: card check failed (${safeErr(e)})`); continue; }
      const want = s.default_pm && s.default_pm.id;
      const have = want ? methods.find((m) => m.id === want) : methods[0];
      const expired = (m) => m && m.exp_year && `${m.exp_year}-${String(m.exp_month).padStart(2, "0")}` < ym;
      const status = !have ? "missing_in_stripe" : expired(have) ? "expired" : "verified";
      await updateStats(contactId, "money", (cur) => {
        const stripe = { ...STATS_DEFAULTS.stripe, ...((cur && cur.stripe) || {}) };
        const next = { ...STATS_DEFAULTS, ...cur, stripe: { ...stripe, card_status: status, ...(have && !stripe.default_pm ? { default_pm: { id: have.id, kind: have.kind, brand: have.brand, last4: have.last4, exp_month: have.exp_month, exp_year: have.exp_year } } : {}), verified_at: now().toISOString() } };
        return next;
      }, ctx.write ? ctx.write() : W(ctx)).catch(() => null);
      checked += 1;
    }
  }
  return { progress: checked, result: `checked ${checked}` };
}

// "Autopay plans without a usable card": Settings and the autopay preview.
export async function plansWithoutCard() {
  const rows = (await readIndex("plans", "")).rows.filter((r) => ["active", "pending", "cancelling"].includes(r.st) && r.ap);
  const ids = [...new Set(rows.map((r) => r.c))].slice(0, 300);
  const cards = new Map((await mapLimit(ids, 12, async (id) => [id, await cardFor(id)])).map(([id, c]) => [id, c]));
  const n = rows.filter((r) => { const c = cards.get(r.c); return !c || !c.usable; }).length;
  return { plans: rows.length, without_card: n };
}

// card.expiring (sweep, off by default, P1): contacts with an active
// autopay plan whose card on file runs out within 30 days.
export async function expiringCards(day) {
  const rows = (await readIndex("plans", "")).rows.filter((r) => ["active", "cancelling"].includes(r.st) && r.ap);
  const until = addLocalDays(day, 30).slice(0, 7);
  const out = [];
  const seen = new Set();
  for (const r of rows.slice(0, 400)) {
    if (seen.has(r.c)) continue;
    seen.add(r.c);
    const c = await cardFor(r.c);
    if (!c.usable || c.kind !== "card" || !c.exp_year) continue;
    const ym = `${c.exp_year}-${String(c.exp_month).padStart(2, "0")}`;
    if (ym <= until && ym >= day.slice(0, 7)) out.push({ contact_id: r.c, plan_id: r.id, ym });
  }
  return out;
}

export { getRecord };
