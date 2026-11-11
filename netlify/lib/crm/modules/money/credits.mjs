// Money module: account credits and overpayments (design §5.6 "Credit",
// "Overpayment"; D33).
//
// A contact's credit is a ledger of credit rows (rel/contact-credits, each
// row's value carries its amount and status, so the balance is one
// listing): issued credits (+, available), credits used on an invoice (−,
// applied). An overpayment is held, not spendable, until an owner decides:
// keep it as credit for the next visit (→ available) or refund it (the
// refund brings the invoice's excess, and so the row, to 0 → settled).
//
// money.overpay (listener on payment.succeeded and payment.refunded): an
// invoice whose excess_cents > 0 keeps EXACTLY ONE overpayment credit row
// (id derived from the invoice, amount = excess by CAS) and one approval
// task for the owners. Before cutover it acts only for sandboxed invoices.

import { getRecord, createRecord, updateRecord, listRel, addActivity } from "../../../crm-store.mjs";
import { deriveId, isId } from "../../core/ids.mjs";
import { now } from "../../core/clock.mjs";
import { ExistsError, InputError, ForbiddenError, NotFoundError, ConflictError } from "../../core/errors.mjs";
import { getType } from "../../core/registry.mjs";
import { approvers } from "../../core/notify.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { CREDIT_KINDS } from "./types.mjs";
import { W, moneySettings, liveContact, nameOf } from "./common.mjs";

export const ISSUE_KINDS = Object.freeze(["referral", "gift_card", "goodwill"]);
export const overpayCreditId = (invoiceId) => deriveId("credit", `over:${invoiceId}`);
export const overpayTaskId = (invoiceId) => deriveId("task", `over:${invoiceId}`, "money.overpay", 1);

// The spendable credit: Σ available rows + Σ applied (negative) rows.
export async function availableCredit(contactId) {
  if (!isId(contactId, "contact")) return 0;
  const rows = await listRel("contact-credits", contactId, { limit: 500 });
  const n = rows.filter((r) => r.value && ["available", "applied"].includes(r.value.s)).reduce((s, r) => s + (Number.isSafeInteger(r.value.a) ? r.value.a : 0), 0);
  return Math.max(0, n);
}

export async function creditsOf(contactId) {
  const rows = await listRel("contact-credits", contactId, { limit: 200 });
  const recs = [];
  for (const r of rows.slice(0, 100)) { const g = await getRecord("credit", r.id).catch(() => null); if (g) recs.push(g.data); }
  return { balance_cents: await availableCredit(contactId), held_cents: rows.filter((r) => r.value && r.value.s === "held").reduce((s, r) => s + (r.value.a || 0), 0), credits: recs };
}

// POST /contacts/:id/credits { kind, amount_cents, note, client_id } (credits:issue;
// an admin up to cfg/money.credit_cap_admin_cents, $100).
export async function issueCredit(contactId, body = {}, ctx) {
  const c = await liveContact(contactId);
  if (!c) throw new NotFoundError("That contact isn't here.");
  const kind = String(body.kind || "goodwill");
  if (!ISSUE_KINDS.includes(kind)) throw new InputError("Pick referral, gift card or goodwill.", "kind");
  const amt = body.amount_cents;
  if (!Number.isSafeInteger(amt) || amt <= 0 || amt > 500000) throw new InputError("Enter an amount up to $5,000.", "amount_cents");
  const note = String(body.note || "").trim();
  if (note.length < 2) throw new InputError("Say what it's for.", "note");
  const settings = await moneySettings();
  if (ctx.user && ctx.user.role !== "owner" && amt > settings.credit_cap_admin_cents) throw new ForbiddenError(`Credits over $${settings.credit_cap_admin_cents / 100} need an owner.`);
  const id = typeof body.client_id === "string" && /^[0-9a-f-]{36}$/i.test(body.client_id) ? deriveId("credit", `c:${body.client_id}`) : undefined;
  try {
    const r = await createRecord("credit", { ...(id ? { id } : {}), contact_id: c.id, kind, status: "available", amount_cents: amt, note: note.slice(0, 500), issued_by: ctx.user ? ctx.user.id : "system" }, ctx.write());
    await addActivity(c.id, "credit.issued", r.data.id, now()).catch(() => {});
    return r.data;
  } catch (e) {
    if (e instanceof ExistsError && id) return (await getRecord("credit", id)).data;
    throw e;
  }
}

// An owner keeps a held overpayment as credit for the next visit.
export async function releaseCredit(creditId, ctx) {
  if (!isId(creditId, "credit")) throw new NotFoundError("That credit isn't here.");
  const r = await updateRecord("credit", creditId, (cr) => {
    if (cr.status === "available") return null;
    if (cr.status !== "held") throw new ConflictError("Only a held overpayment can be kept as credit.");
    if (!(cr.amount_cents > 0)) throw new ConflictError("Nothing is left of this overpayment.");
    return { ...cr, status: "available", note: `${cr.note || ""} Kept as credit.`.trim().slice(0, 500) };
  }, ctx.write());
  // the invoice's overpayment is decided: it leaves the "to decide" list
  if (isId(r.data.source_invoice_id, "invoice")) await updateRecord("invoice", r.data.source_invoice_id, (inv) => (inv.excess_kept ? null : { ...inv, excess_kept: true }), ctx.write()).catch(() => null);
  return r.data;
}

// ------------------------------------------------------------ money.overpay

export async function onOverpay(event, h) {
  const p = event.payload || {};
  if (!isId(p.invoice_id, "invoice")) return { result: "skipped:no_invoice" };
  const g = await getRecord("invoice", p.invoice_id);
  if (!g) return { result: "skipped:gone" };
  return keepOverpayment(g.data, h.ctx);
}

export async function keepOverpayment(inv, actx) {
  const id = overpayCreditId(inv.id);
  const had = await getRecord("credit", id);
  const excess = inv.excess_cents || 0;
  if (!had && excess <= 0) return { result: "skipped:no_excess" };
  if (!actx.mayAct({ record: inv })) { await actx.would(inv, "credit", { excess_cents: [null, excess] }); return { result: "would-credit" }; }
  const w = actx.write();
  if (!had) {
    try {
      await createRecord("credit", { id, contact_id: inv.contact_id, kind: "overpayment", status: "held", amount_cents: excess, source_invoice_id: inv.id, note: `Overpaid on ${inv.number}` }, w);
    } catch (e) { if (!(e instanceof ExistsError)) throw e; }
  }
  // the row follows the excess (a refund of it brings it to 0: settled)
  await updateRecord("credit", id, (cr) => {
    if (cr.status === "available") return null;                // the owner kept it as credit: it's theirs now
    const status = excess <= 0 ? "settled" : "held";
    const next = { ...cr, amount_cents: excess, status };
    return JSON.stringify(next) === JSON.stringify(cr) ? null : next;
  }, w);
  if (excess > 0) await overpayTask(inv, excess, w);
  return { result: excess > 0 ? "held" : "settled" };
}

async function overpayTask(inv, excess, w) {
  if (!getType("task")) return;
  const id = overpayTaskId(inv.id);
  if (await getRecord("task", id)) return;
  const c = await liveContact(inv.contact_id);
  try {
    await createRecord("task", {
      id, title: `Overpaid $${(excess / 100).toFixed(2)} on ${inv.number}: refund or keep as credit`.slice(0, 160), kind: "approval", priority: "medium", status: "open",
      contact_id: inv.contact_id, contact_name: nameOf(c) || undefined, assignee_ids: (await approvers().catch(() => [])).slice(0, 3),
      approval: { kind: "overpayment", ref_id: inv.id }, notes: "Refund the extra from the payment on the invoice, or keep it as credit for their next visit (Invoice → Keep as credit).",
    }, w);
  } catch (e) {
    if (!(e instanceof ExistsError)) console.error(`crm:money: overpayment task not made (${safeErr(e)})`);
  }
}

export { CREDIT_KINDS };
