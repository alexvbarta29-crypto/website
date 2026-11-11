// Money module: Stripe's webhook (design §6.2 "Webhook", "Sharing an
// account with Rotor"; decision D2).
//
//   POST /api/crm/hooks/stripe        live events (STRIPE_WEBHOOK_SECRET)
//   POST /api/crm/hooks/stripe-test   test-mode events (STRIPE_TEST_WEBHOOK_SECRET)
//
// An endpoint is open only while payments really run in its mode
// (money/gate.mjs: test with a test key, live after cutover); otherwise it
// answers 404 and nothing is read. Then:
//   1. the signature (t, v1 = HMAC-SHA256 of `${t}.${raw}`, constant time,
//      5 minutes); a bad one answers 401;
//   2. done/stripe-event/{sha(id)}: an event already applied answers 200;
//   3. OWNERSHIP. Barta's Stripe account may be the one Rotor charges
//      through, so this endpoint sees Rotor's charges, refunds and disputes
//      too. An event is acted on only when its object is one the CRM made:
//      a Checkout Session the CRM recorded (ptr/checkout) or whose metadata
//      names a CRM invoice or contact that exists; a PaymentIntent the same
//      way or one the CRM has a payment record for; a charge, refund or
//      dispute of such a payment. Everything else is counted in
//      sys/health.stripe_foreign_events and answered 200, untouched;
//   4. the object is RE-FETCHED and its current state applied (events
//      arrive out of order), through the same handlers every other path
//      uses (checkout.mjs), then the event is marked done. Any failure
//      answers 500 so Stripe retries (up to 3 days).

import { createHash } from "node:crypto";
import { claimMarker, advanceMarker, getRecord, readPointer } from "../../../crm-store.mjs";
import { isId } from "../../core/ids.mjs";
import { nowMs, nowIso } from "../../core/clock.mjs";
import { fail } from "../../core/http.mjs";
import { updateHealth } from "../../core/lanes.mjs";
import { notify, approvers } from "../../core/notify.mjs";
import { updateStats } from "../../../crm-store.mjs";
import { stripeKey } from "../contacts/display.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { verifyWebhook } from "../../adapters/payments-stripe.mjs";
import { payments } from "./gate.mjs";
import { payId } from "./upsert.mjs";
import { applyCheckoutSession, applyPaymentIntent, applySetupIntent, readSession } from "./checkout.mjs";
import { applyStripeRefund } from "./refunds.mjs";
import { moneyStats, STATS_DEFAULTS } from "./common.mjs";

const sha = (s) => createHash("sha256").update(String(s)).digest("hex");
export const HANDLED = Object.freeze([
  "checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed", "checkout.session.expired",
  "payment_intent.processing", "payment_intent.succeeded", "payment_intent.payment_failed", "charge.refunded", "setup_intent.succeeded",
  "payment_method.detached", "charge.dispute.created",
]);

const meta = (o) => (o && o.metadata) || {};
const exists = async (type, id) => isId(id, type) && !!(await getRecord(type, id).catch(() => null));
const paymentOfPi = async (pi) => (pi ? getRecord("payment", payId.pi(typeof pi === "string" ? pi : pi.id)).catch(() => null) : null);

// Is this event's object one the CRM made? → { ours, payment? }
export async function ownership(event, { sor } = {}) {
  const o = (event.data && event.data.object) || {};
  const m = meta(o);
  const t = event.type;
  if (t.startsWith("checkout.session.")) {
    if (await readSession(o.id)) return { ours: true };
    return { ours: (await exists("invoice", m.crm_invoice_id)) || (o.mode === "setup" && await exists("contact", m.crm_contact_id)) };
  }
  if (t.startsWith("payment_intent.")) {
    if (await exists("invoice", m.crm_invoice_id)) return { ours: true };
    const g = await paymentOfPi(o.id);
    return { ours: !!g, payment: g ? g.data : null };
  }
  if (t === "charge.refunded" || t === "charge.dispute.created") {
    const g = await paymentOfPi(o.payment_intent);
    return { ours: !!g, payment: g ? g.data : null };
  }
  if (t === "setup_intent.succeeded") return { ours: await exists("contact", m.crm_contact_id) };
  if (t === "payment_method.detached") {
    // after cutover only, and only a method the CRM saved on a customer the CRM made
    if (sor !== "crm") return { ours: false };
    const cus = (event.data.previous_attributes && event.data.previous_attributes.customer) || o.customer;
    if (!cus) return { ours: false };
    const ptr = await readPointer("stripe-cus", stripeKey(typeof cus === "string" ? cus : cus.id)).catch(() => null);
    for (const cid of ((ptr && (ptr.ids || (ptr.id ? [ptr.id] : []))) || []).slice(0, 3)) {
      const st = await moneyStats(cid);
      if ((st.stripe.crm_created_ids || []).includes(typeof cus === "string" ? cus : cus.id) && st.stripe.default_pm && st.stripe.default_pm.id === o.id) return { ours: true, contact_id: cid };
    }
    return { ours: false };
  }
  return { ours: false };
}

// Applies one of our events (the object re-fetched first).
export async function applyEvent(event, impl, ctx, own = {}) {
  const o = (event.data && event.data.object) || {};
  const t = event.type;
  if (t.startsWith("checkout.session.")) {
    const full = (await impl.retrieve("checkout_session", o.id)) || o;
    return applyCheckoutSession(full, ctx);
  }
  if (t.startsWith("payment_intent.")) {
    const full = (await impl.retrieve("payment_intent", o.id)) || o;
    // a PaymentIntent of ours whose metadata lost the invoice (older code): the record knows it
    const m = meta(full);
    const fixed = !m.crm_invoice_id && own.payment && own.payment.invoice_id ? { ...full, metadata: { ...m, crm_invoice_id: own.payment.invoice_id, tip_cents: own.payment.tip_cents || 0 } } : full;
    return applyPaymentIntent(fixed, ctx);
  }
  if (t === "charge.refunded") {
    const full = (await impl.retrieve("charge", o.id)) || o;
    const list = (full.refunds && Array.isArray(full.refunds.data) ? full.refunds.data : []);
    let n = 0;
    for (const r of list.slice(0, 20)) {
      const p = await getRecord("payment", own.payment.id);
      if (await applyStripeRefund(r, p.data, ctx)) n += 1;
    }
    return { refunds: n };
  }
  if (t === "setup_intent.succeeded") {
    const full = (await impl.retrieve("setup_intent", o.id)) || o;
    return applySetupIntent(full, ctx);
  }
  if (t === "payment_method.detached" && own.contact_id) {
    await updateStats(own.contact_id, "money", (p) => {
      const stripe = { ...STATS_DEFAULTS.stripe, ...((p && p.stripe) || {}) };
      return stripe.card_status === "missing_in_stripe" ? null : { ...STATS_DEFAULTS, ...p, stripe: { ...stripe, card_status: "missing_in_stripe" } };
    }, ctx);
    return { detached: true };
  }
  if (t === "charge.dispute.created" && own.payment) {
    const people = await approvers().catch(() => []);
    await notify(people.slice(0, 10), { kind: "payment_failed", title: "A card payment is disputed", body: "The customer's bank opened a dispute. Answer it in Stripe within the deadline.", link: own.payment.invoice_id ? `/invoices/${own.payment.invoice_id}` : "/payments" }, ctx).catch(() => {});
    return { dispute: true };
  }
  return null;
}

async function hook(ctx, endpoint) {
  const env = process.env;
  const mode = await ctx.sysMode();
  const gate = await payments({ deploy: ctx.deploy, mode });
  const secret = endpoint === "live" ? env.STRIPE_WEBHOOK_SECRET : env.STRIPE_TEST_WEBHOOK_SECRET;
  // closed unless payments really run in this endpoint's mode
  if (gate.mode !== endpoint || !secret || !gate.impl) return fail("not_found", "Not found.", 404);
  let event;
  try {
    event = verifyWebhook(ctx.raw, ctx.req.headers.get("stripe-signature"), secret, Math.floor(nowMs() / 1000));
  } catch {
    return fail("bad_signature", "That signature isn't right.", 401);
  }
  // a live event on the test endpoint (or the other way round) is never ours
  if (typeof event.livemode === "boolean" && event.livemode !== (endpoint === "live")) return { data: { ignored: "mode" } };
  if (!HANDLED.includes(event.type)) return { data: { ignored: "type" } };
  const wctx = { by: "hook:stripe", origin: "hook", actor_kind: "automation", requestId: ctx.requestId, mode };
  const own = await ownership(event, { sor: mode.system_of_record });
  if (!own.ours) {
    await updateHealth((h) => ({ ...h, stripe_foreign_events: (h.stripe_foreign_events || 0) + 1, stripe_foreign_at: nowIso() }));
    return { data: { ignored: "foreign" } };
  }
  const claim = await claimMarker("done", "stripe-event", sha(event.id).slice(0, 40), { holder: `hook.${ctx.requestId}`, leaseMs: 30000 });
  if (!claim.ok) {
    const st = claim.marker && claim.marker.state;
    if (st === "done" || st === "unknown") return { data: { already: true } };
    return fail("busy", "This event is being applied. Send it again.", 503, { headers: { "Retry-After": "5" } });
  }
  try {
    await applyEvent(event, gate.impl, wctx, own);
  } catch (e) {
    console.error(`crm:money: a Stripe event wasn't applied (${safeErr(e)})`);
    await advanceMarker(claim.marker, { state: "failed", code: "apply_failed", retry_at: nowIso() }).catch(() => {});
    return fail("failed", "That didn't apply. Send it again.", 500);
  }
  await advanceMarker(claim.marker, { state: "done", result: event.type.slice(0, 60) }).catch(() => {});
  return { data: { applied: true } };
}

const route = (path, endpoint) => ({
  method: "POST", path, auth: "hook", perm: null, subject: "none", mode: "inline", body: "raw", idempotent: false, maxBody: 512 * 1024, maxCalls: 90, handler: (ctx) => hook(ctx, endpoint),
});
export const webhookRoutes = [route("/hooks/stripe", "live"), route("/hooks/stripe-test", "test")];
