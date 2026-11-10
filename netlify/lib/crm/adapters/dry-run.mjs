// Barta CRM: the dry-run implementations of every integration (design §6.1
// "Dry-run", §0 rule 11). They never call fetch: each one writes an outbox
// record ("would have sent", core/outbox.mjs) and returns a simulated
// result in the same shape the live driver returns, so every caller runs
// the same code before and after an integration goes live.
//
// Magic values make every failure path testable end to end:
//   SMS to +1 763 555 0199          → failed, code 30007 (carrier filtered)
//   email to bounce@example.com     → failed, code "bounce"
//   payment method dry_pm_decline   → failed, card_declined
//   dry_pm_auth                     → requires_action
//   dry_pm_ach                      → processing (then succeeded, M5)
//   dry_pm_ach_fail                 → processing (then failed, M5)
//
// Dry-run money touches only sandboxed subjects (§6.1): a charge, refund
// or checkout whose caller does not say `sandboxed: true` is refused with
// ParallelRunGuard, and the caller writes its would-charge row instead.

import { createHash, randomBytes } from "node:crypto";
import { recordOutbox } from "../core/outbox.mjs";
import { ParallelRunGuard } from "../core/errors.mjs";
import { smsSegments, truncate } from "../core/text.mjs";
import { nowMs } from "../core/clock.mjs";

export const MAGIC = Object.freeze({
  smsFail: "+17635550199",
  emailBounce: "bounce@example.com",
  pmDecline: "dry_pm_decline",
  pmAuth: "dry_pm_auth",
  pmAch: "dry_pm_ach",
  pmAchFail: "dry_pm_ach_fail",
});

const o = (x) => x || {};
const e164 = (s) => { let d = String(s || "").replace(/\D/g, ""); if (d.length === 10) d = "1" + d; return "+" + d; };
const sessionId = () => "dry_cs_" + randomBytes(12).toString("hex");
const requireSandboxed = (args, action) => {
  if (!args || args.sandboxed !== true) throw new ParallelRunGuard("Dry-run money only touches test contacts and shadow records.", { action });
};

async function write(kind, args, extra) {
  const ob = o(args.outbox);
  return recordOutbox({ kind, mode: "dry_run", ...ob, ...extra }, o(ob.ctx));
}

export const dryRun = Object.freeze({
  sms: Object.freeze({
    async send(args) {
      const failed = e164(args.to) === MAGIC.smsFail;
      const segments = smsSegments(args.body);
      const simulated = failed ? { status: "failed", code: "30007" } : { status: "sent" };
      const rec = await write("sms", args, { to: args.to, body: args.body, segments, simulated });
      return { status: simulated.status, ...(failed ? { error_code: "30007" } : {}), segments, provider_id: null, simulated: true, outbox_id: rec.id };
    },
    // An ambiguous dry-run send cannot happen (nothing leaves the process).
    async findSent() { return null; },
  }),
  email: Object.freeze({
    async send(args) {
      const bounce = String(args.to || "").trim().toLowerCase() === MAGIC.emailBounce;
      const simulated = bounce ? { status: "failed", code: "bounce" } : { status: "sent" };
      const rec = await write("email", args, { to: args.to, subject: args.subject || "", body: args.text, simulated });
      return { status: simulated.status, ...(bounce ? { error_code: "bounce" } : {}), provider_id: null, simulated: true, outbox_id: rec.id };
    },
    async findSent() { return null; },
  }),
  push: Object.freeze({
    // Staff push: the outbox shows what a phone would have shown.
    async push(args) {
      const p = typeof args.payload === "string" ? (() => { try { return JSON.parse(args.payload); } catch { return { body: args.payload }; } })() : o(args.payload);
      const rec = await write("push", args, { to_masked: "staff phone", subject: truncate(p.title || "", 80), body: truncate(p.body || "", 300), staff: true, simulated: { status: "sent" } });
      return { status: "sent", simulated: true, outbox_id: rec.id };
    },
  }),
  payments: Object.freeze({
    async ensureCustomer(args) {
      const id = o(args.contact).id || "x";
      return { customer_id: "dry_cus_" + createHash("sha256").update(id).digest("hex").slice(0, 14) };
    },
    async checkoutPayment(args) {
      requireSandboxed(args, "checkout");
      const session = sessionId();
      await write("checkout", args, { amount_cents: (args.amount_cents || 0) + (args.tip_cents || 0), simulated: { status: "open" }, body: `Checkout ${session}` });
      return { url: `/p/dry-checkout/${session}`, session_id: session, expires_at: new Date(nowMs() + 3600000).toISOString() };
    },
    async checkoutSetup(args) {
      requireSandboxed(args, "setup");
      const session = sessionId();
      await write("setup", args, { simulated: { status: "open" }, body: `Card setup ${session}` });
      return { url: `/p/dry-checkout/${session}`, session_id: session };
    },
    async expireCheckout() { return { status: "expired" }; },
    async chargeSaved(args) {
      requireSandboxed(args, "charge");
      const pm = String(args.payment_method_id || "");
      const pi = "dry_pi_" + createHash("sha256").update(String(args.idempotencyKey || pm)).digest("hex").slice(0, 16);
      let r;
      if (pm === MAGIC.pmDecline) r = { status: "failed", failure_code: "card_declined" };
      else if (pm === MAGIC.pmAuth) r = { status: "requires_action" };
      else if (pm === MAGIC.pmAch || pm === MAGIC.pmAchFail) r = { status: "processing" };
      else r = { status: "succeeded", charge_id: pi.replace("dry_pi_", "dry_ch_"), fee_cents: 0 };
      await write("charge", args, { amount_cents: args.amount_cents, simulated: { status: r.status, ...(r.failure_code ? { code: r.failure_code } : {}) } });
      return { payment_intent_id: pi, ...r };
    },
    async findPaymentIntent() { return null; },
    async retrieve() { return null; },
    async refund(args) {
      requireSandboxed(args, "refund");
      await write("refund", args, { amount_cents: args.amount_cents, simulated: { status: "succeeded" } });
      return { status: "succeeded", refund_id: "dry_re_" + createHash("sha256").update(String(args.idempotencyKey || "")).digest("hex").slice(0, 16) };
    },
    async listPaymentMethods() { return []; },
    verifyWebhook() { throw new Error("dry-run: there are no webhooks to verify"); },
  }),
  maps: Object.freeze({ async geocode() { return null; } }),
  reviews: Object.freeze({ async listReviews() { return []; } }),
  meta: Object.freeze({
    async sendEvent(args) {
      await write("meta_event", args, { body: String(o(args).event || "event"), simulated: { status: "sent" } });
      return { status: "sent", simulated: true };
    },
  }),
});
