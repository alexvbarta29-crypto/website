// Money module: refunds (design §5.6 "Refunds"; owners only, payments:refund).
//
// A refund is its own payment row (kind "refund") that lands in the
// invoice's applied map; the invoice reopens when a balance appears.
// Partial or full, never more than the customer paid (amount + tip): the
// amount is RESERVED on the original payment by CAS first
// (upsert.reserveRefund, keyed by the request's client uuid), so two owners
// refunding at once can't pass it, and a retried request is the same refund.
//   card / bank   Stripe refund (Idempotency-Key refund:{requestId},
//                 metadata crm_payment_id + crm_refund_request); the row's id
//                 derives from the Stripe refund id, so charge.refunded and
//                 the owner's request land on one row. A simulated (dry-run)
//                 payment is refunded by the dry-run driver.
//   cash / check  recorded only (the money goes back by hand).
// A refund comes out of the invoice amount first, then the tip; the tip
// part is split back across the same techs (data for Payroll).

import { getRecord } from "../../../crm-store.mjs";
import { isId } from "../../core/ids.mjs";
import { ConflictError, InputError } from "../../core/errors.mjs";
import { dryRun } from "../../adapters/dry-run.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { splitTip } from "./balance.mjs";
import { W, sysModeOf, today } from "./common.mjs";
import { upsertPayment, payId, reserveRefund, settleRefund, getPayment, isClientId } from "./upsert.mjs";
import { payments, mayMoveMoney } from "./gate.mjs";

const REFUND_STATUS = { succeeded: "succeeded", pending: "processing", failed: "failed", canceled: "canceled" };

// The refund row of a reservation, upserted (every path). → the upsert result
export async function recordRefund(payment, { request_id, refund_id, status = "succeeded", split, reason, simulated, by } = {}, ctx = {}) {
  const id = refund_id ? payId.re(refund_id) : payId.client(request_id);
  const users = (payment.tip_split || []).map((x) => x.user_id);
  return upsertPayment({
    id, contact_id: payment.contact_id, contact_name: payment.contact_name, invoice_id: payment.invoice_id, invoice_number: payment.invoice_number, job_id: payment.job_id, plan_id: payment.plan_id,
    kind: "refund", method: payment.method, status, amount_cents: split.amount_cents, tip_cents: split.tip_cents, fee_cents: 0, received_on: today(), refund_of: payment.id,
    refund_reason: reason ? String(reason).slice(0, 300) : undefined, tip_split: splitTip(split.tip_cents, users),
    ...(refund_id ? { stripe: { refund_id, ...(payment.stripe && payment.stripe.payment_intent_id ? { payment_intent_id: payment.stripe.payment_intent_id } : {}) } } : {}),
    ...(simulated ? { simulated: true } : {}), recorded_by: by || W(ctx).by || "system",
  }, ctx);
}

// POST /payments/:id/refund { amount_cents, reason, client_id }
export async function refundPayment(paymentId, body = {}, ctx = {}) {
  const amount = body.amount_cents;
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new InputError("How much goes back?", "amount_cents");
  const reason = String(body.reason || "").trim();
  if (reason.length < 2) throw new InputError("Say why (the office reads this later).", "reason");
  if (!isClientId(body.client_id)) throw new InputError("This refund needs its request id.", "client_id");
  const requestId = body.client_id.toLowerCase();
  const { data: p0 } = await getPayment(paymentId);
  if (p0.import && !["cash", "check", "other", "imported"].includes(p0.method)) throw new ConflictError("This card payment was made in Rotor. Refund it there.", { code: "not_ours" });
  const res = await reserveRefund(paymentId, requestId, amount, ctx);
  const payment = res.payment;
  const split = { amount_cents: res.split.amount_cents, tip_cents: res.split.tip_cents };
  if (res.already) {
    // the same request again: its refund row (made, or being made)
    split.amount_cents = res.already.amount_cents - (res.already.tip_cents || 0);
    if (res.already.status === "failed") throw new ConflictError("That refund didn't go through. Start a new one.", { code: "refund_failed" });
    if (res.already.status === "done") {
      const id = res.already.refund_id ? payId.re(res.already.refund_id) : payId.client(requestId);
      const g = await getRecord("payment", id);
      if (g) return { refund: g.data, payment };
    }
  }
  const viaStripe = ["card", "ach"].includes(payment.method) && payment.stripe && payment.stripe.payment_intent_id;
  let refundId = null;
  let status = "succeeded";
  if (viaStripe) {
    const mode = await sysModeOf(ctx);
    let impl = null;
    if (payment.simulated) {
      // dry-run money touches only sandboxed subjects (§6.1)
      const inv = isId(payment.invoice_id, "invoice") ? ((await getRecord("invoice", payment.invoice_id).catch(() => null)) || {}).data : null;
      if (!(await mayMoveMoney(inv || payment, { sor: mode.system_of_record }))) { await settleRefund(paymentId, requestId, { status: "failed" }, ctx); throw new ConflictError("Test refunds are for test contacts only."); }
      impl = dryRun.payments;
    } else {
      const p = await payments({ mode });
      if (!p.impl || p.mode === "dry_run") { await settleRefund(paymentId, requestId, { status: "failed" }, ctx); throw new ConflictError("Card payments aren't connected right now, so this refund can't be sent to the card.", { code: "not_connected" }); }
      impl = p.impl;
    }
    try {
      const r = await impl.refund({
        payment_intent_id: payment.stripe.payment_intent_id, amount_cents: amount, reason, idempotencyKey: `refund:${requestId}`, metadata: { crm_payment_id: payment.id, crm_refund_request: requestId },
        sandboxed: true, outbox: { contact_id: payment.contact_id, to: "•••", related: { payment_id: payment.id, ...(payment.invoice_id ? { invoice_id: payment.invoice_id } : {}) }, ctx: W(ctx) },
      });
      refundId = r.refund_id;
      status = REFUND_STATUS[r.status] || "processing";
    } catch (e) {
      if (e && e.transient) throw e;                       // ambiguous: the same request (same key) settles it
      console.error(`crm:money: a refund was refused (${safeErr(e)})`);
      await settleRefund(paymentId, requestId, { status: "failed" }, ctx);
      throw new ConflictError("The refund didn't go through. Nothing was sent back.", { code: "refund_refused" });
    }
    if (status === "failed" || status === "canceled") { await settleRefund(paymentId, requestId, { status: "failed" }, ctx); throw new ConflictError("The refund didn't go through. Nothing was sent back.", { code: "refund_refused" }); }
  }
  await settleRefund(paymentId, requestId, { status: "done", ...(refundId ? { refund_id: refundId } : {}) }, ctx);
  const out = await recordRefund(payment, { request_id: requestId, refund_id: refundId, status, split, reason, simulated: payment.simulated, by: W(ctx).by }, ctx);
  return { refund: out.payment, payment: (await getPayment(paymentId)).data, invoice: out.invoice ? out.invoice.data : null };
}

// A Stripe Refund object for one of OUR payments (charge.refunded, or a
// refund made in Stripe's dashboard): reserved under the request it names
// (or its own id), then the same row.
export async function applyStripeRefund(refund, payment, ctx = {}) {
  if (!refund || !refund.id || !payment || payment.kind !== "payment") return null;
  const known = (payment.refunds || []).find((x) => x.refund_id === refund.id);
  const requestId = known ? known.request_id : (refund.metadata && isClientId(refund.metadata.crm_refund_request) ? refund.metadata.crm_refund_request.toLowerCase() : `stripe:${refund.id}`);
  let split;
  if (known) split = { amount_cents: known.amount_cents - (known.tip_cents || 0), tip_cents: known.tip_cents || 0 };
  else {
    let res;
    try { res = await reserveRefund(payment.id, requestId, refund.amount, ctx); } catch (e) {
      if (e instanceof ConflictError) { console.error("crm:money: a Stripe refund is bigger than what the CRM has left on the payment"); return null; }
      throw e;
    }
    split = res.already ? { amount_cents: res.already.amount_cents - (res.already.tip_cents || 0), tip_cents: res.already.tip_cents || 0 } : res.split;
  }
  const status = REFUND_STATUS[refund.status] || "processing";
  if (status === "failed" || status === "canceled") { await settleRefund(payment.id, requestId, { status: "failed" }, ctx); }
  else await settleRefund(payment.id, requestId, { status: "done", refund_id: refund.id }, ctx);
  return recordRefund(payment, { request_id: requestId, refund_id: refund.id, status, split, reason: refund.reason || "Refunded in Stripe", by: "stripe" }, ctx);
}
