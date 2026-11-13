// Money module: hosted Checkout (design §5.6 "Pay link", §6.2, §8.1, §8.5).
//
// Texts and emails never carry a Stripe URL: they open the portal's invoice
// page, which makes a FRESH Checkout Session when Pay is tapped (1 hour),
// with the tip worked out on the server (balance.computeTip), refused while
// a card charge is in flight or a bank payment is clearing. Each session is
// recorded twice: on the invoice (checkout_sessions, so a charge can expire
// it first) and at ptr/checkout/{sha256(session id)} (what the session is
// for: the dry-run Checkout page and the return page read it).
//
// One handler applies a session's result, whichever way it arrives (§5.6):
//   applyCheckoutSession(session)   a Stripe Checkout Session object (from
//                                   the webhook's re-fetch, the return page's
//                                   re-fetch, or the dry-run Checkout page,
//                                   which builds the same shape)
//   applyPaymentIntent(pi)          payment_intent.* events and their re-fetch
//   applySetupIntent(si)            a card saved in setup mode
// All of them end in upsertPayment / recordSavedMethod, so every path lands
// on the same records.
//
// Dry-run (the default until the owner connects keys): /p/dry-checkout/{id}
// stands in for Stripe (Pay with a card, Pay by bank, a bank payment that
// fails, a decline, cancel), for sandboxed subjects only; a bank payment
// stays processing until the next worker pass settles it (money.dry_settle).

import { createHash, randomBytes } from "node:crypto";
import { getRecord, updateRecord, claimPointer, readPointer, getRaw, settledWrite, readIndex, getRecords } from "../../../crm-store.mjs";
import { isId } from "../../core/ids.mjs";
import { nowIso, nowMs, now, localDate } from "../../core/clock.mjs";
import { CANONICAL_ORIGIN } from "../../core/context.mjs";
import { ConflictError, InputError, NotFoundError } from "../../core/errors.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { computeTip, isProcessing, chargingLive } from "./balance.mjs";
import { W, moneySettings, sysModeOf, liveContact, moneyStats, touchMoneyStats } from "./common.mjs";
import { upsertPayment, payId, tipSplitFor } from "./upsert.mjs";
import { payments, mayMoveMoney } from "./gate.mjs";
import { recordSavedMethod, markMethodFailed } from "./cards.mjs";

export const SESSION_MS = 60 * 60 * 1000;
const sha = (s) => createHash("sha256").update(String(s)).digest("hex");
export const sessionKey = (sid) => sha(sid).slice(0, 40);
const RETURN = `${CANONICAL_ORIGIN}/p/return?cs={CHECKOUT_SESSION_ID}`;

export async function readSession(sid) {
  if (typeof sid !== "string" || sid.length < 8 || sid.length > 200) return null;
  return readPointer("checkout", sessionKey(sid));
}
async function writeSession(sid, mutate) {
  const key = `ptr/checkout/${sessionKey(sid)}`;
  for (let i = 0; i < 4; i++) {
    const got = await getRaw(key);
    if (!got || !got.data) return null;
    const { _w, ...cur } = got.data;
    const next = mutate({ ...cur });
    if (!next) return cur;
    const w = await settledWrite(key, { ...next, at: nowIso() }, { onlyIfMatch: got.etag });
    if (w.ok) return next;
  }
  return null;
}

// ------------------------------------------------------------ starting a session (portal)

// Why this invoice can't be paid online right now, or null. → { code, message } | null
export async function payRefusal(inv, { sor } = {}) {
  if (!inv || inv.deleted_at) return { code: "missing", message: "That invoice isn't here." };
  if (inv.status === "paid") return { code: "paid", message: "This invoice is paid. Thank you!" };
  if (inv.status !== "open") return { code: "not_open", message: "This invoice can't be paid online. Call or text us." };
  if (!(inv.balance_cents > 0)) return { code: "paid", message: "Nothing is left to pay." };
  if (chargingLive(inv, nowMs())) return { code: "charging", message: "We're charging your card on file right now. Check back in a few minutes." };
  if (isProcessing(inv)) return { code: "processing", message: "A bank payment is on its way for this invoice. It clears in a few days." };
  if (!(await mayMoveMoney(inv, { sor }))) return { code: "not_yet", message: "Online payment for this invoice opens soon. Call or text us to pay." };
  return null;
}

// POST /api/portal/invoices/:id/checkout { tip_choice, custom_tip_cents?, save_card }
// → { url } (409 while a charge or a bank payment is in flight). opts.via
// "qr": the page was opened from the pay code (the portal decides it from
// the session's link, never from the request), kept with the session so the
// payment says so.
export async function startInvoiceCheckout(invoiceId, contactId, body = {}, ctx = {}, { via } = {}) {
  const g = isId(invoiceId, "invoice") ? await getRecord("invoice", invoiceId) : null;
  if (!g || g.data.contact_id !== contactId) throw new NotFoundError("That invoice isn't here.");
  const inv = g.data;
  const mode = await sysModeOf(ctx);
  const why = await payRefusal(inv, { sor: mode.system_of_record });
  if (why) throw new ConflictError(why.message, { code: why.code });
  const settings = await moneySettings();
  let tip;
  // a deposit or a fee takes no tip, whatever the page sent (the page doesn't offer one)
  if (["deposit", "fee"].includes(inv.kind)) tip = { tip_cents: 0, capped: false };
  else try { tip = computeTip(inv.balance_cents, body.tip_choice ?? "0", body.custom_tip_cents, settings); } catch { throw new InputError("Pick a tip.", "tip_choice"); }
  const p = await payments({ mode });
  if (!p.impl) throw new ConflictError("Online payment is paused right now. Call or text us.", { code: "paused" });
  const contact = await liveContact(inv.contact_id);
  const st = await moneyStats(inv.contact_id);
  const saveCard = body.save_card === true;
  let customerId = st.stripe.crm_customer_id || null;
  if (saveCard && !customerId && p.mode === "live") {
    const c = await p.impl.ensureCustomer({ contact, allowCreate: true });
    customerId = c.customer_id;
  }
  const requestId = randomBytes(12).toString("hex");
  const methods = settings.ach ? ["card", "us_bank_account"] : ["card"];      // D32: a bank account beside cards
  const s = await p.impl.checkoutPayment({
    invoice: inv, amount_cents: inv.balance_cents, tip_cents: tip.tip_cents, customer_id: customerId, save_card: saveCard, methods,
    success_url: RETURN, cancel_url: `${CANONICAL_ORIGIN}/p/invoice/${inv.id}`, idempotencyKey: `checkout:${requestId}`, expires_at_ms: nowMs() + SESSION_MS,
    sandboxed: true, outbox: { contact_id: inv.contact_id, to: "•••", related: { invoice_id: inv.id }, subject_ref: { type: "invoice", id: inv.id }, ctx: W(ctx) },
  });
  const expires = s.expires_at || new Date(nowMs() + SESSION_MS).toISOString();
  await claimPointer("checkout", sessionKey(s.session_id), {
    id: inv.id, kind: "payment", contact_id: inv.contact_id, amount_cents: inv.balance_cents, tip_cents: tip.tip_cents, save_card: saveCard,
    expires_at: expires, status: "open", dry: p.mode === "dry_run", sid: p.mode === "dry_run" ? s.session_id : undefined, ach: methods.includes("us_bank_account"),
    ...(via === "qr" ? { via: "qr" } : {}),
  });
  // recorded on the invoice; a charge that started meanwhile expires it at once
  let raced = false;
  await updateRecord("invoice", inv.id, (x) => {
    if (chargingLive(x, nowMs())) { raced = true; return null; }
    return { ...x, checkout_sessions: [...(x.checkout_sessions || []).filter((c) => c.status === "open" || c.status === "complete").slice(-15), { id: s.session_id, expires_at: expires, status: "open", amount_cents: inv.balance_cents, tip_cents: tip.tip_cents, ...(saveCard ? { save_card: true } : {}), created_at: nowIso(), ...(p.mode === "dry_run" ? { dry: true } : {}), ...(via === "qr" ? { via: "qr" } : {}) }] };
  }, W(ctx));
  if (raced) {
    await expireOne(p, s.session_id).catch(() => {});
    throw new ConflictError("We're charging your card on file right now. Check back in a few minutes.", { code: "charging" });
  }
  return { url: s.url, tip_cents: tip.tip_cents, capped: tip.capped };
}

// POST /api/portal/card/checkout: save a card (or a bank account) for the plan.
export async function startSetupCheckout(contactId, ctx = {}) {
  const contact = await liveContact(contactId);
  if (!contact) throw new NotFoundError("We couldn't find your account.");
  const mode = await sysModeOf(ctx);
  if (!(await mayMoveMoney(contact, { sor: mode.system_of_record, contact }))) throw new ConflictError("Adding a card online opens soon. Call or text us and we'll help.", { code: "not_yet" });
  const settings = await moneySettings();
  const p = await payments({ mode });
  if (!p.impl) throw new ConflictError("Adding a card is paused right now. Call or text us.", { code: "paused" });
  const st = await moneyStats(contactId);
  let customerId = st.stripe.crm_customer_id || null;
  let created = false;
  if (!customerId && p.mode === "live") { const c = await p.impl.ensureCustomer({ contact, allowCreate: true }); customerId = c.customer_id; created = !!c.created; }
  const requestId = randomBytes(12).toString("hex");
  const methods = settings.ach ? ["card", "us_bank_account"] : ["card"];
  const s = await p.impl.checkoutSetup({
    customer_id: customerId, contact_id: contactId, success_url: RETURN, cancel_url: `${CANONICAL_ORIGIN}/p/card`, methods, idempotencyKey: `setup:${requestId}`,
    sandboxed: true, outbox: { contact_id: contactId, to: "•••", related: {}, ctx: W(ctx) },
  });
  await claimPointer("checkout", sessionKey(s.session_id), {
    id: contactId, kind: "setup", contact_id: contactId, expires_at: s.expires_at || new Date(nowMs() + SESSION_MS).toISOString(), status: "open", dry: p.mode === "dry_run",
    sid: p.mode === "dry_run" ? s.session_id : undefined, customer_id: customerId || undefined, created_customer: created || undefined, ach: methods.includes("us_bank_account"),
  });
  return { url: s.url };
}

// ------------------------------------------------------------ expiring sessions before a charge

async function expireOne(p, sid) {
  const r = await p.impl.expireCheckout(sid, { idempotencyKey: `expire:${sid}` });
  return (r && r.status) || "expired";
}

// Every open session recorded on the invoice is expired (one that already
// completed is applied first). → how many were expired.
export async function expireSessionsOf(invoiceId, ctx = {}) {
  const g = await getRecord("invoice", invoiceId);
  if (!g) return 0;
  const open = (g.data.checkout_sessions || []).filter((s) => s.status === "open");
  if (!open.length) return 0;
  const mode = await sysModeOf(ctx);
  const p = await payments({ mode });
  const done = {};
  for (const s of open) {
    let status = "expired";
    if (s.dry || !p.impl || p.mode === "dry_run") {
      const ptr = await readSession(s.id);
      status = ptr && ptr.status === "complete" ? "complete" : "expired";
    } else {
      try {
        status = await expireOne(p, s.id);
        if (status === "complete") {
          const full = await p.impl.retrieve("checkout_session", s.id);
          if (full) await applyCheckoutSession(full, ctx);
        }
      } catch (e) { console.error(`crm:money: a checkout session couldn't be expired (${safeErr(e)})`); status = "open"; }
    }
    done[s.id] = status;
    if (status === "expired") await writeSession(s.id, (x) => (x.status === "open" ? { ...x, status: "expired" } : null)).catch(() => null);
  }
  await updateRecord("invoice", invoiceId, (inv) => {
    const list = (inv.checkout_sessions || []).map((s) => (done[s.id] && s.status === "open" ? { ...s, status: done[s.id] === "complete" ? "complete" : done[s.id] === "open" ? "open" : "expired" } : s));
    return JSON.stringify(list) === JSON.stringify(inv.checkout_sessions || []) ? null : { ...inv, checkout_sessions: list };
  }, W(ctx));
  return Object.values(done).filter((s) => s === "expired").length;
}

// ------------------------------------------------------------ applying results (every path)

const metaOf = (o) => (o && o.metadata) || {};
const idOf = (x) => (x && typeof x === "object" ? x.id : x || null);

// Where a Stripe object lives: the practice driver, Stripe's test data, or the live account.
const modeOf = (o, simulated) => (simulated ? "dry_run" : o && o.livemode === true ? "live" : o && o.livemode === false ? "test" : null);

function pmFacts(pm) {
  if (!pm || typeof pm !== "object") return null;
  if (pm.type === "us_bank_account") return { id: pm.id, kind: "us_bank_account", brand: (pm.us_bank_account && pm.us_bank_account.bank_name) || "Bank", last4: pm.us_bank_account && pm.us_bank_account.last4 };
  return { id: pm.id, kind: "card", brand: pm.card && pm.card.brand, last4: pm.card && pm.card.last4, exp_month: pm.card && pm.card.exp_month, exp_year: pm.card && pm.card.exp_year };
}
const feeOf = (pi) => { const ch = pi && typeof pi.latest_charge === "object" ? pi.latest_charge : null; const bt = ch && typeof ch.balance_transaction === "object" ? ch.balance_transaction : null; return bt && Number.isSafeInteger(bt.fee) ? bt.fee : 0; };
const PI_STATUS = { succeeded: "succeeded", processing: "processing", canceled: "canceled", requires_payment_method: "failed" };

// A PaymentIntent the CRM made (its metadata names the invoice), applied as
// it is now. → the upsert result | null (not ours).
export async function applyPaymentIntent(pi, ctx = {}, { tip_cents, session_id, simulated, via } = {}) {
  const m = metaOf(pi);
  const invoiceId = m.crm_invoice_id;
  if (!isId(invoiceId, "invoice")) return null;
  const g = await getRecord("invoice", invoiceId);
  if (!g) return null;
  const inv = g.data;
  const status = PI_STATUS[pi.status] || "pending";
  const tip = Number.isSafeInteger(tip_cents) ? tip_cents : Number.isSafeInteger(Number(m.tip_cents)) ? Number(m.tip_cents) : 0;
  const total = Number.isSafeInteger(pi.amount_received) && pi.amount_received > 0 ? pi.amount_received : pi.amount || 0;
  const pm = pmFacts(pi.payment_method);
  const kind = pm ? pm.kind : (pi.payment_method_types || []).includes("us_bank_account") && !(pi.payment_method_types || []).includes("card") ? "us_bank_account" : "card";
  const amount = Math.max(0, total - tip);
  const out = await upsertPayment({
    id: payId.pi(pi.id), contact_id: inv.contact_id, contact_name: inv.contact_name, invoice_id: inv.id, invoice_number: inv.number, job_id: (inv.job_ids || [])[0], plan_id: inv.plan_id,
    kind: "payment", method: kind === "us_bank_account" ? "ach" : "card", status, amount_cents: amount, tip_cents: tip, fee_cents: feeOf(pi),
    tip_split: await tipSplitFor(inv, tip),
    stripe: { payment_intent_id: pi.id, ...(typeof pi.latest_charge === "string" ? { charge_id: pi.latest_charge } : pi.latest_charge && pi.latest_charge.id ? { charge_id: pi.latest_charge.id } : {}), ...(session_id ? { checkout_session_id: session_id } : {}), ...(m.crm_attempt_id ? { attempt_id: m.crm_attempt_id } : {}), ...(pm ? { payment_method_id: pm.id } : {}) },
    ...(pm ? { card: { brand: pm.brand, last4: pm.last4, kind: pm.kind } } : {}),
    ...(status === "failed" && pi.last_payment_error ? { failure_code: String(pi.last_payment_error.decline_code || pi.last_payment_error.code || "failed").slice(0, 60) } : {}),
    ...(simulated ? { simulated: true } : {}), ...(via === "qr" ? { via: "qr" } : {}), recorded_by: "stripe",
  }, ctx);
  if (out.transitioned === "failed") await markMethodFailed(inv.contact_id, ctx);
  // a card saved with the payment ("save this card for my plan")
  if (pm && pi.setup_future_usage === "off_session" && status !== "failed") {
    await recordSavedMethod(inv.contact_id, { ...pm, mandate_id: pi.mandate || undefined, mode: modeOf(pi, simulated) || undefined }, { customer_id: idOf(pi.customer) }, ctx);
  }
  return out;
}

// A Checkout Session, as it is now (§6.2 webhooks re-fetch; the dry-run page builds it).
export async function applyCheckoutSession(session, ctx = {}, { simulated } = {}) {
  if (!session || typeof session.id !== "string") return null;
  const m = metaOf(session);
  if (session.mode === "setup") return applySetupSession(session, ctx, { simulated });
  if (!isId(m.crm_invoice_id, "invoice")) return null;
  let out = null;
  if (session.status === "complete" || session.status === "expired") {
    await updateRecord("invoice", m.crm_invoice_id, (inv) => {
      const list = (inv.checkout_sessions || []).map((s) => (s.id === session.id && s.status === "open" ? { ...s, status: session.status } : s));
      return JSON.stringify(list) === JSON.stringify(inv.checkout_sessions || []) ? null : { ...inv, checkout_sessions: list };
    }, W(ctx)).catch(() => null);
    await writeSession(session.id, (x) => (x.status === "open" ? { ...x, status: session.status } : null)).catch(() => null);
  }
  const pi = session.payment_intent;
  if (pi && typeof pi === "object") {
    const tip = Number.isSafeInteger(Number(m.tip_cents)) ? Number(m.tip_cents) : 0;
    // a session started from the pay code: the payment says so (scan.mjs)
    const ptr = await readSession(session.id).catch(() => null);
    out = await applyPaymentIntent({ ...pi, metadata: { ...metaOf(session), ...metaOf(pi) } }, ctx, { tip_cents: tip, session_id: session.id, simulated, via: ptr && ptr.via === "qr" ? "qr" : undefined });
  }
  return out;
}

async function applySetupSession(session, ctx, { simulated } = {}) {
  const si = session.setup_intent;
  const m = metaOf(session);
  if (session.status === "complete" || session.status === "expired") await writeSession(session.id, (x) => (x.status === "open" ? { ...x, status: session.status } : null)).catch(() => null);
  if (!si || typeof si !== "object" || si.status !== "succeeded" || !isId(m.crm_contact_id, "contact")) return null;
  return applySetupIntent({ ...si, metadata: { ...m, ...metaOf(si) } }, ctx, { simulated, customer_id: idOf(session.customer) });
}

export async function applySetupIntent(si, ctx = {}, { customer_id, simulated } = {}) {
  const m = metaOf(si);
  if (!isId(m.crm_contact_id, "contact") || si.status !== "succeeded") return null;
  const pm = pmFacts(si.payment_method) || (typeof si.payment_method === "string" ? { id: si.payment_method, kind: "card" } : null);
  if (!pm) return null;
  const mandate = idOf(si.mandate);
  return recordSavedMethod(m.crm_contact_id, { ...pm, ...(mandate ? { mandate_id: mandate } : {}), mode: modeOf(si, simulated) || undefined }, { customer_id: customer_id || idOf(si.customer) || null }, ctx);
}

// ------------------------------------------------------------ the dry-run Checkout (/p/dry-checkout/:session)

const DRY_PM = { card: "dry_pm_card", ach: "dry_pm_ach", ach_fail: "dry_pm_ach_fail" };

// What the dry-run page shows for a session id. → { ptr, invoice? } | null
export async function drySession(sid) {
  if (!/^dry_cs_[0-9a-f]{24}$/.test(String(sid || ""))) return null;
  const ptr = await readSession(sid);
  if (!ptr || !ptr.dry) return null;
  const invoice = ptr.kind === "payment" && isId(ptr.id, "invoice") ? ((await getRecord("invoice", ptr.id).catch(() => null)) || {}).data || null : null;
  return { ptr, invoice };
}

// The dry-run page's buttons, through the same handler a webhook uses.
// action: pay | decline | cancel; method: card | ach | ach_fail.
// → { location } | { error, message }
export async function completeDryCheckout(sid, { action, method = "card" } = {}, ctx = {}) {
  const d = await drySession(sid);
  if (!d) throw new NotFoundError("This test checkout isn't here.");
  const { ptr } = d;
  if (ptr.status !== "open" || Date.parse(ptr.expires_at) <= nowMs()) {
    if (ptr.status === "complete") return { location: `/p/return?cs=${encodeURIComponent(sid)}` };
    return { error: "expired", message: "This checkout expired. Go back and tap Pay again." };
  }
  // dry-run money touches only sandboxed subjects (§6.1)
  const mode = await sysModeOf(ctx);
  const subject = d.invoice || (await liveContact(ptr.contact_id));
  if (!subject || !(await mayMoveMoney(subject, { sor: mode.system_of_record }))) throw new ConflictError("Test checkouts are for test contacts only.", { code: "not_sandboxed" });
  const back = ptr.kind === "payment" ? `/p/invoice/${ptr.id}` : "/p/card";
  if (action === "cancel") return { location: back };
  if (action === "decline") return { error: "card_declined", message: "Your card was declined. Try another card." };
  if (action !== "pay") throw new InputError("Pick Pay, Decline or Cancel.", "action");
  if (d.invoice && (d.invoice.status !== "open" || d.invoice.balance_cents <= 0 || chargingLive(d.invoice, nowMs()) || isProcessing(d.invoice))) {
    return { error: "changed", message: "This invoice changed. Go back to see it." };
  }
  const pmKind = method === "ach" || method === "ach_fail" ? "us_bank_account" : "card";
  if (pmKind === "us_bank_account" && !ptr.ach) throw new InputError("Pay by card on this one.", "method");
  const pmId = `${DRY_PM[method] || DRY_PM.card}_${sid.slice(-8)}`;
  const pm = pmKind === "card" ? { id: pmId, type: "card", card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: Number(localDate(now()).slice(0, 4)) + 3 } } : { id: pmId, type: "us_bank_account", us_bank_account: { bank_name: "Test Bank", last4: "6789" } };
  const meta = { crm_invoice_id: ptr.kind === "payment" ? ptr.id : undefined, crm_contact_id: ptr.contact_id, tip_cents: ptr.tip_cents || 0 };
  let session;
  if (ptr.kind === "payment") {
    const processing = pmKind === "us_bank_account";
    const total = (ptr.amount_cents || 0) + (ptr.tip_cents || 0);
    session = {
      id: sid, mode: "payment", status: "complete", payment_status: processing ? "unpaid" : "paid", metadata: meta, amount_total: total,
      payment_intent: { id: `dry_pi_${sha(sid).slice(0, 16)}`, status: processing ? "processing" : "succeeded", amount: total, amount_received: processing ? 0 : total, metadata: meta, payment_method: pm, setup_future_usage: ptr.save_card ? "off_session" : undefined, latest_charge: processing ? null : { id: `dry_ch_${sha(sid).slice(0, 16)}`, balance_transaction: { fee: 0 } } },
    };
  } else {
    session = { id: sid, mode: "setup", status: "complete", metadata: meta, setup_intent: { id: `dry_si_${sha(sid).slice(0, 16)}`, status: "succeeded", payment_method: pm, metadata: meta, ...(pmKind === "us_bank_account" ? { mandate: `dry_mandate_${sid.slice(-8)}` } : {}) } };
  }
  await applyCheckoutSession(session, ctx, { simulated: true });
  return { location: `/p/return?cs=${encodeURIComponent(sid)}` };
}

// money.dry_settle (every fast pass): a simulated bank payment clears (or
// fails, dry_pm_ach_fail) on the next pass after it was made (§6.1).
export async function drySettle(ctx) {
  const months = [localDate(now()).slice(0, 7)];
  const d = new Date(now()); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1);
  months.push(d.toISOString().slice(0, 7));
  let n = 0;
  for (const m of months) {
    const rows = (await readIndex("payments", m)).rows.filter((r) => r.st === "processing" && r.sim && r.pmk);
    for (const r of rows.slice(0, 50)) {
      const g = await getRecord("payment", r.id);
      const p = g && g.data;
      if (!p || p.status !== "processing" || !p.simulated || Date.parse(p.updated_at) > nowMs() - 1000) continue;
      const fail = /^dry_pm_ach_fail/.test((p.stripe && p.stripe.payment_method_id) || "");
      const out = await upsertPayment({ ...p, status: fail ? "failed" : "succeeded", ...(fail ? { failure_code: "ach_debit_failed" } : {}) }, ctx.write ? ctx.write() : ctx);
      if (fail && out.transitioned === "failed") await markMethodFailed(p.contact_id, ctx.write ? ctx.write() : ctx);
      n += 1;
    }
  }
  return { progress: n };
}

// ------------------------------------------------------------ the return page (/p/return?cs=)

// What the customer sees after Checkout, resolved on the server with their
// portal cookie (no portal token ever goes to Stripe). → { kind, title, text, invoice?, payment? }
export async function resolveReturn(sid, session, ctx = {}) {
  const ptr = await readSession(sid);
  if (!ptr || ptr.contact_id !== session.contact_id) return null;
  if (!ptr.dry && ptr.status === "open") {
    // Stripe's success_url can beat its webhook: read the session ourselves
    try {
      const p = await payments({ mode: await sysModeOf(ctx) });
      if (p.impl && p.mode !== "dry_run") { const full = await p.impl.retrieve("checkout_session", sid); if (full) await applyCheckoutSession(full, ctx); }
    } catch (e) { console.error(`crm:money: the return page couldn't read the session (${safeErr(e)})`); }
  }
  // where "back" goes: the page this session's link opens
  const sc = session.scope || {};
  const back = sc.kind === "quote" ? { href: `/p/quote/${sc.id}`, label: "Back to your quote" } : sc.kind === "hub" ? { href: "/p/hub", label: "Back to your account" } : sc.kind === "card" ? { href: "/p/card", label: "Back" } : sc.kind === "invoice" ? { href: `/p/invoice/${sc.id}`, label: "See your invoice" } : null;
  if (ptr.kind === "setup") {
    const st = await moneyStats(ptr.contact_id);
    const pm = st.stripe.default_pm;
    const r = pm ? { kind: "card", title: "You're all set", text: `${pm.kind === "us_bank_account" ? "Your bank account" : `Your ${pm.brand ? String(pm.brand).toUpperCase() : "card"} ending ${pm.last4 || ""}`} is on file. Thank you!` } : { kind: "pending", title: "Thank you", text: "We're saving your card. It'll show on your account in a moment." };
    return { ...r, back };
  }
  const g = isId(ptr.id, "invoice") ? await getRecord("invoice", ptr.id).catch(() => null) : null;
  const inv = g && g.data;
  if (!inv) return null;
  const pays = Object.entries(inv.applied || {}).filter(([, e]) => e.kind === "payment");
  if (pays.some(([, e]) => e.status === "processing")) return { kind: "processing", title: "Your bank payment is on its way", text: "Bank payments take a few days to clear. We'll text you a receipt when it does.", back };
  if (inv.status === "paid") return { kind: "paid", title: "Paid. Thank you!", text: "Your receipt is on its way by text or email.", back };
  return { kind: "pending", title: "Thank you", text: "We're confirming your payment. You'll get a receipt by text or email in a moment.", back };
}

export { getRecords, touchMoneyStats };
