// Money module: one payment, one record (design §5.6 "One payment, one
// record").
//
// A card payment can arrive by four paths (the worker's synchronous charge
// result, payment_intent.succeeded, checkout.session.completed, the dry-run
// Checkout) and a refund by two (the owner's request, charge.refunded).
// Every path calls upsertPayment():
//   - the payment id is DERIVED from the provider object
//     (payId.pi(payment_intent_id), payId.re(refund_id), payId.client(uuid)
//     for cash and checks, idForRotor for imported rows), so every path
//     lands on the same record; the record is the dedupe;
//   - created with onlyIfNew; if it exists, its status moves forward only
//     by rank (pending < processing < succeeded | failed | canceled) and a
//     terminal status never changes;
//   - then the invoice's applied[paymentId] entry is CASed (forward only,
//     too) and the invoice's money is derived again from the whole map;
//   - payment.succeeded / payment.failed / payment.processing and
//     invoice.paid are emitted ONLY by the CAS that moved the record into
//     that state, so receipts, review triggers and tip lines fire once.
//
// Refunds reserve their amount on the original payment by CAS first
// (refunds[] entries keyed by the request id), so two owners refunding at
// once can never pass amount + tip.

import { createRecord, getRecord, updateRecord, addActivity } from "../../../crm-store.mjs";
import { deriveId, isId } from "../../core/ids.mjs";
import { nowIso, now } from "../../core/clock.mjs";
import { ExistsError, InputError, ConflictError, NotFoundError } from "../../core/errors.mjs";
import { emit } from "../../core/events.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { forward, refundSplit, splitTip } from "./balance.mjs";
import { W, touchMoneyStats, today } from "./common.mjs";

// Deterministic payment ids (§5.6).
export const payId = Object.freeze({
  pi: (paymentIntentId) => deriveId("payment", `pi:${paymentIntentId}`),
  re: (refundId) => deriveId("payment", `re:${refundId}`),
  client: (uuid) => deriveId("payment", `c:${uuid}`),
});
export const attemptId = (invoiceId, n) => deriveId("payment", `att:${invoiceId}:${n}`);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isClientId = (s) => typeof s === "string" && UUID_RE.test(s);

const EVENT_FOR = { processing: "payment.processing", succeeded: "payment.succeeded", failed: "payment.failed" };

function eventPayload(p, extra = {}) {
  return {
    id: p.id, wv: p.wv, payment_id: p.id, contact_id: p.contact_id, amount_cents: p.amount_cents || 0, tip_cents: p.tip_cents || 0, kind: p.kind, method: p.method,
    ...(p.invoice_id ? { invoice_id: p.invoice_id } : {}), ...(p.simulated ? { simulated: true } : {}), ...extra,
  };
}

async function emitSafe(name, payload, ctx) {
  await emit(name, payload, W(ctx)).catch((e) => console.error(`crm:money: ${name} not queued (${safeErr(e)})`));
}

// The fields a later path may add to an existing payment without moving it
// (the fee from the balance transaction, the charge id, the card).
function fill(p, spec) {
  const next = { ...p };
  if (!(next.fee_cents > 0) && spec.fee_cents > 0) next.fee_cents = spec.fee_cents;
  if (spec.stripe) next.stripe = { ...(spec.stripe || {}), ...(p.stripe || {}), ...Object.fromEntries(Object.entries(spec.stripe).filter(([k, v]) => v && !(p.stripe && p.stripe[k]))) };
  if (spec.card && !p.card) next.card = spec.card;
  if (spec.failure_code && !p.failure_code) next.failure_code = spec.failure_code;
  if (!p.invoice_id && spec.invoice_id) next.invoice_id = spec.invoice_id;
  return next;
}

// → { payment, created, transitioned: status | null, invoice: { data, paidNow } | null }
export async function upsertPayment(spec, ctx = {}) {
  if (!isId(spec.id, "payment")) throw new InputError("A payment needs its id.", "id");
  const w = W(ctx);
  const data = {
    ...spec, received_on: spec.received_on || today(), recorded_by: spec.recorded_by || w.by || "system",
    tip_cents: spec.tip_cents || 0, fee_cents: spec.fee_cents || 0, amount_cents: spec.amount_cents || 0,
  };
  let payment;
  let created = false;
  let transitioned = null;
  try {
    payment = (await createRecord("payment", data, w)).data;
    created = true;
    transitioned = payment.status;
  } catch (e) {
    if (!(e instanceof ExistsError)) throw e;
    let from = null;
    const r = await updateRecord("payment", spec.id, (p) => {
      from = p.status;
      const status = forward(p.status, spec.status);
      const next = fill({ ...p, status }, spec);
      return JSON.stringify(next) === JSON.stringify(p) ? null : next;
    }, w);
    payment = r.data;
    if (r.changed && from !== payment.status) transitioned = payment.status;
  }
  let invoice = null;
  if (payment.invoice_id) invoice = await applyToInvoice(payment.invoice_id, payment, ctx);
  if (transitioned && EVENT_FOR[transitioned] && payment.kind === "payment") await emitSafe(EVENT_FOR[transitioned], eventPayload(payment), ctx);
  if (transitioned === "succeeded" && payment.kind === "refund") await emitSafe("payment.refunded", eventPayload(payment, { refund_of: payment.refund_of || null }), ctx);
  if (transitioned === "succeeded" && payment.kind === "payment") await addActivity(payment.contact_id, "payment.succeeded", payment.id, now()).catch(() => {});
  await touchMoneyStats(payment.contact_id, ctx);
  return { payment, created, transitioned, invoice };
}

// CAS the invoice's applied entry for one payment (forward only). → { data, paidNow, changed }
export async function applyToInvoice(invoiceId, p, ctx = {}) {
  const w = W(ctx);
  const g = await getRecord("invoice", invoiceId);
  if (!g) return null;
  let wasPaid = g.data.status === "paid";
  const r = await updateRecord("invoice", invoiceId, (inv) => {
    wasPaid = inv.status === "paid";
    const cur = (inv.applied || {})[p.id];
    const status = cur ? forward(cur.status, p.status) : p.status;
    const entry = {
      kind: p.kind, amount_cents: p.amount_cents || 0, tip_cents: p.tip_cents || 0, status,
      ...(p.simulated ? { simulated: true } : {}), at: (cur && cur.at) || nowIso(),
    };
    if (cur && JSON.stringify(cur) === JSON.stringify(entry)) return null;
    const next = { ...inv, applied: { ...(inv.applied || {}), [p.id]: entry } };
    // the off-session charge this payment answers is over
    if (next.charging && p.stripe && p.stripe.attempt_id && next.charging.attempt_id === p.stripe.attempt_id && status !== "pending") delete next.charging;
    return next;
  }, w);
  const paidNow = r.changed && !wasPaid && r.data.status === "paid";
  if (paidNow) {
    await emitSafe("invoice.paid", { id: r.data.id, wv: r.data.wv, invoice_id: r.data.id, contact_id: r.data.contact_id, amount_cents: r.data.total_cents || 0 }, ctx);
    await addActivity(r.data.contact_id, "invoice.paid", r.data.id, now()).catch(() => {});
  }
  return { data: r.data, paidNow, changed: r.changed };
}

// ------------------------------------------------------------ tips

// The techs a payment's tip goes to: everyone on the visits of the invoice's
// jobs (the job's assignee list is kept from its live visits), equal split.
export async function tipSplitFor(invoice, tipCents) {
  if (!(tipCents > 0) || !invoice) return [];
  const ids = [];
  for (const jid of (invoice.job_ids || []).slice(0, 5)) {
    const j = isId(jid, "job") ? await getRecord("job", jid).catch(() => null) : null;
    for (const u of (j && j.data.assignee_ids) || []) if (isId(u, "user") && !ids.includes(u)) ids.push(u);
  }
  return splitTip(tipCents, ids);
}

// ------------------------------------------------------------ refunds

// Reserves a refund on the original payment (CAS). → { payment, split, reservation, already }
export async function reserveRefund(paymentId, requestId, amount, ctx = {}) {
  let split = null;
  let already = null;
  const r = await updateRecord("payment", paymentId, (p) => {
    if (p.kind !== "payment") throw new ConflictError("Only a payment can be refunded.");
    if (p.status !== "succeeded") throw new ConflictError(p.status === "processing" ? "This payment hasn't cleared yet. Refund it once it has." : "Only a payment that went through can be refunded.");
    const list = p.refunds || [];
    const had = list.find((x) => x.request_id === requestId);
    if (had) { already = had; split = { amount_cents: had.amount_cents, tip_cents: had.tip_cents || 0 }; return null; }
    const live = list.filter((x) => x.status !== "failed");
    const done = { amount_cents: live.reduce((s, x) => s + x.amount_cents, 0), tip_cents: live.reduce((s, x) => s + (x.tip_cents || 0), 0) };
    split = refundSplit(p, amount, done);
    if (!split) throw new ConflictError(`That's more than is left to refund (${((p.amount_cents + p.tip_cents) - done.amount_cents - done.tip_cents) / 100} dollars).`, { code: "refund_cap" });
    const entry = { request_id: requestId, amount_cents: split.amount_cents + split.tip_cents, tip_cents: split.tip_cents, status: "reserved", at: nowIso() };
    return { ...p, refunds: [...list, entry], refunded_cents: done.amount_cents + done.tip_cents + entry.amount_cents, refunded_tip_cents: done.tip_cents + split.tip_cents };
  }, W(ctx));
  return { payment: r.data, split, already };
}

// Marks a reservation done (with the provider's refund id) or failed (released).
export async function settleRefund(paymentId, requestId, { status, refund_id } = {}, ctx = {}) {
  return updateRecord("payment", paymentId, (p) => {
    const list = (p.refunds || []).map((x) => (x.request_id === requestId && x.status === "reserved" ? { ...x, status, ...(refund_id ? { refund_id } : {}) } : x));
    if (JSON.stringify(list) === JSON.stringify(p.refunds || [])) return null;
    const live = list.filter((x) => x.status !== "failed");
    return { ...p, refunds: list, refunded_cents: live.reduce((s, x) => s + x.amount_cents, 0), refunded_tip_cents: live.reduce((s, x) => s + (x.tip_cents || 0), 0) };
  }, W(ctx));
}

export async function getPayment(id) {
  if (!isId(id, "payment")) throw new NotFoundError("That payment isn't here.");
  const g = await getRecord("payment", id);
  if (!g || g.data.deleted_at) throw new NotFoundError("That payment isn't here.");
  return g;
}
