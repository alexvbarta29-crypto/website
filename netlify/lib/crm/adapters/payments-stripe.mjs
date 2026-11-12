// Barta CRM: the Stripe payments driver (design §6.1, §6.2; M5).
//
// Raw REST with fetch (no SDK, §0 rule 15): form-encoded bodies,
// Authorization: Bearer, Stripe-Version pinned, AbortSignal.timeout(8000)
// on every call, and every POST carries Idempotency-Key = {purpose}:{record
// id} with no attempt counter, so re-issuing an ambiguous call inside
// Stripe's 24 h window returns the first result (§7.3).
//
// THE OWNER'S STRIPE RULES (they override anything looser in the design):
//   1. Nothing calls Stripe unless payments are explicitly in "test" mode
//      with a TEST key (sk_test_ / rk_test_) or in "live" mode after cutover
//      with a live key. Each driver checks its key's prefix before every
//      call and refuses (StripeKeyRefused) without making it: a live key in
//      the test slot, or a test key in the live slot, is never used.
//      Which driver runs at all is decided by the money module's gate
//      (money/gate.mjs), which keeps everything dry-run until the owner
//      connects keys and refuses a live key while Rotor is in charge.
//   2. In any mode the CRM never creates, updates or deletes a Stripe
//      Customer or payment method it didn't create: ensureCustomer only
//      finds or (after cutover) creates customers carrying the CRM's own
//      metadata.crm_contact_id; nothing here ever sets a default payment
//      method, edits metadata or detaches anything.
//   3. This file is tested only against a mocked fetch.
//
// registerStripeDrivers() puts the live and test drivers in the adapter
// layer (adapters/index.mjs); dry-run stays core's (adapters/dry-run.mjs).

import { createHmac, timingSafeEqual } from "node:crypto";
import { registerAdapter } from "./index.mjs";
import { nowMs } from "../core/clock.mjs";

export const STRIPE_API = "https://api.stripe.com/v1";
export const STRIPE_VERSION = "2024-06-20";
export const TIMEOUT_MS = 8000;
export const WEBHOOK_TOLERANCE_S = 300;
const KEY_ENV = Object.freeze({ live: "STRIPE_SECRET_KEY", test: "STRIPE_TEST_SECRET_KEY" });
const KEY_RE = Object.freeze({ live: /^(sk|rk)_live_[A-Za-z0-9]{8,}$/, test: /^(sk|rk)_test_[A-Za-z0-9]{8,}$/ });

export class StripeKeyRefused extends Error {
  constructor(mode) { super(mode === "live" ? "The live Stripe key isn't a live key." : "The test Stripe key isn't a test key."); this.name = "StripeKeyRefused"; this.code = "stripe_key"; }
}
export class StripeError extends Error {
  constructor(status, body) {
    const e = (body && body.error) || {};
    super(e.message ? "Stripe said no." : `Stripe answered ${status}.`);
    this.name = "StripeError";
    this.status = status;
    this.code = String(e.decline_code || e.code || e.type || "stripe_error").slice(0, 60);
    this.stripe = { type: e.type || null, code: e.code || null, decline_code: e.decline_code || null, payment_intent: e.payment_intent || null };
    this.transient = status === 429 || status >= 500;
  }
}

// What kind of key a value is (never the value itself): "live" | "test" | "missing" | "other".
export function keyKind(v) {
  const s = String(v || "");
  if (!s) return "missing";
  if (KEY_RE.live.test(s)) return "live";
  if (KEY_RE.test.test(s)) return "test";
  return "other";
}

// a[b][c]=... form encoding of nested objects and arrays (Stripe's style).
export function formEncode(obj, prefix = "", out = []) {
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((x, i) => {
        if (x !== null && typeof x === "object") formEncode(x, `${key}[${i}]`, out);
        else out.push(`${encodeURIComponent(`${key}[]`)}=${encodeURIComponent(String(x))}`);
      });
    } else if (typeof v === "object") formEncode(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out.join("&");
}

// One call. → the parsed JSON. Throws StripeError (4xx/5xx), a TimeoutError-ish
// AbortError on timeout (the caller's op/marker settles it), StripeKeyRefused.
export async function stripeRequest(mode, method, path, params = {}, { idempotencyKey, env = process.env, fetchImpl, version = STRIPE_VERSION } = {}) {
  const key = env[KEY_ENV[mode]];
  if (keyKind(key) !== mode) throw new StripeKeyRefused(mode);
  if (method === "POST" && !idempotencyKey) throw new TypeError("stripe: every POST carries an Idempotency-Key");
  const f = fetchImpl || globalThis.fetch;
  const qs = method === "GET" ? formEncode(params) : "";
  const url = `${STRIPE_API}${path}${qs ? (path.includes("?") ? "&" : "?") + qs : ""}`;
  const headers = { Authorization: `Bearer ${key}`, "Stripe-Version": version };
  if (method === "POST") { headers["Content-Type"] = "application/x-www-form-urlencoded"; headers["Idempotency-Key"] = idempotencyKey; }
  const res = await f(url, { method, headers, body: method === "POST" ? formEncode(params) : undefined, signal: AbortSignal.timeout(TIMEOUT_MS) });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) throw new StripeError(res.status, body);
  return body;
}

const metaOf = (m = {}) => Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => [k, String(v).slice(0, 500)]));
const secs = (ms) => Math.floor(ms / 1000);
const feeOf = (pi) => {
  const ch = pi && typeof pi.latest_charge === "object" ? pi.latest_charge : null;
  const bt = ch && typeof ch.balance_transaction === "object" ? ch.balance_transaction : null;
  return bt && Number.isSafeInteger(bt.fee) ? bt.fee : undefined;
};
const chargeIdOf = (pi) => (pi && pi.latest_charge ? (typeof pi.latest_charge === "string" ? pi.latest_charge : pi.latest_charge.id) : undefined);

// A PaymentIntent's status as the CRM reads it.
export function piStatus(pi) {
  switch (pi && pi.status) {
    case "succeeded": return "succeeded";
    case "processing": return "processing";
    case "requires_action": return "requires_action";
    case "canceled": return "canceled";
    case "requires_payment_method": return "failed";
    default: return "pending";
  }
}

// The driver for one mode ("live" | "test"). opts.fetchImpl and opts.env for tests.
export function stripeDriver(mode, opts = {}) {
  if (!KEY_ENV[mode]) throw new TypeError(`stripe: unknown mode ${mode}`);
  const call = (method, path, params, more = {}) => stripeRequest(mode, method, path, params, { ...opts, ...more, env: opts.env || process.env });
  return Object.freeze({
    mode,
    // Finds the CRM's own customer for a contact (stats first, then a Search
    // by metadata.crm_contact_id); creates one only when the caller allows it
    // (live, after cutover). Never touches a customer the CRM didn't create.
    async ensureCustomer({ contact, crmCustomerId, allowCreate = false, idempotencyKey } = {}) {
      if (crmCustomerId) return { customer_id: crmCustomerId };
      const cid = contact && contact.id;
      if (!cid) return { customer_id: null };
      const found = await call("GET", "/customers/search", { query: `metadata['crm_contact_id']:'${String(cid).replace(/'/g, "")}'`, limit: 1 });
      const hit = found && Array.isArray(found.data) ? found.data.find((c) => c && c.metadata && c.metadata.crm_contact_id === cid) : null;
      if (hit) return { customer_id: hit.id, found: true };
      if (!allowCreate) return { customer_id: null };
      const email = contact.emails && contact.emails[0] && contact.emails[0].address;
      const created = await call("POST", "/customers", { metadata: { crm_contact_id: cid }, ...(email ? { email } : {}), name: [contact.first_name, contact.last_name].filter(Boolean).join(" ").slice(0, 120) || undefined }, { idempotencyKey: idempotencyKey || `customer:${cid}` });
      return { customer_id: created.id, created: true };
    },
    async checkoutPayment({ invoice, amount_cents, tip_cents = 0, customer_id, save_card, success_url, cancel_url, idempotencyKey, methods = ["card"], expires_at_ms, metadata = {} } = {}) {
      const items = [{ quantity: 1, price_data: { currency: "usd", unit_amount: amount_cents, product_data: { name: `Invoice ${invoice.number}`.slice(0, 120) } } }];
      if (tip_cents > 0) items.push({ quantity: 1, price_data: { currency: "usd", unit_amount: tip_cents, product_data: { name: "Tip for the crew" } } });
      const meta = metaOf({ crm_invoice_id: invoice.id, crm_contact_id: invoice.contact_id, crm_invoice_wv: invoice.wv, tip_cents, ...metadata });
      const s = await call("POST", "/checkout/sessions", {
        mode: "payment", line_items: items, success_url, cancel_url, ...(customer_id ? { customer: customer_id } : {}),
        payment_method_types: methods, expires_at: expires_at_ms ? secs(expires_at_ms) : undefined, metadata: meta,
        payment_intent_data: { metadata: meta, ...(save_card ? { setup_future_usage: "off_session" } : {}) },
      }, { idempotencyKey });
      return { url: s.url, session_id: s.id, expires_at: s.expires_at ? new Date(s.expires_at * 1000).toISOString() : undefined };
    },
    async checkoutSetup({ customer_id, contact_id, success_url, cancel_url, methods = ["card"], idempotencyKey, metadata = {} } = {}) {
      const meta = metaOf({ crm_contact_id: contact_id, ...metadata });
      const s = await call("POST", "/checkout/sessions", {
        mode: "setup", ...(customer_id ? { customer: customer_id } : {}), payment_method_types: methods, success_url, cancel_url, metadata: meta,
        setup_intent_data: { metadata: meta }, ...(methods.length && !customer_id ? { currency: "usd" } : {}),
      }, { idempotencyKey });
      return { url: s.url, session_id: s.id, expires_at: s.expires_at ? new Date(s.expires_at * 1000).toISOString() : undefined };
    },
    async expireCheckout(sessionId, { idempotencyKey } = {}) {
      try {
        const s = await call("POST", `/checkout/sessions/${encodeURIComponent(sessionId)}/expire`, {}, { idempotencyKey: idempotencyKey || `expire:${sessionId}` });
        return { status: s.status };
      } catch (e) {
        // already complete or expired: Stripe refuses the expire; read what it is
        if (e instanceof StripeError && e.status === 400) {
          const s = await call("GET", `/checkout/sessions/${encodeURIComponent(sessionId)}`, {});
          return { status: s.status };
        }
        throw e;
      }
    },
    async chargeSaved({ customer_id, payment_method_id, mandate_id, amount_cents, description, metadata = {}, idempotencyKey } = {}) {
      try {
        const pi = await call("POST", "/payment_intents", {
          amount: amount_cents, currency: "usd", ...(customer_id ? { customer: customer_id } : {}), payment_method: payment_method_id, off_session: "true", confirm: "true",
          ...(mandate_id ? { mandate: mandate_id } : {}), description: description ? String(description).slice(0, 300) : undefined, metadata: metaOf(metadata),
          expand: ["latest_charge.balance_transaction"],
        }, { idempotencyKey });
        return { status: piStatus(pi), payment_intent_id: pi.id, charge_id: chargeIdOf(pi), fee_cents: feeOf(pi), ...(pi.last_payment_error ? { failure_code: String(pi.last_payment_error.decline_code || pi.last_payment_error.code || "failed") } : {}) };
      } catch (e) {
        // a decline answers 402 with the PaymentIntent it made: that's a failed charge, not an error
        if (e instanceof StripeError && e.stripe.payment_intent && e.stripe.payment_intent.id) {
          return { status: "failed", payment_intent_id: e.stripe.payment_intent.id, failure_code: e.code };
        }
        throw e;
      }
    },
    // Settles an ambiguous charge (§7.3): the PaymentIntent with our attempt id, if any.
    async findPaymentIntent({ attempt_id } = {}) {
      const r = await call("GET", "/payment_intents/search", { query: `metadata['crm_attempt_id']:'${String(attempt_id || "").replace(/'/g, "")}'`, limit: 1 });
      const pi = r && Array.isArray(r.data) ? r.data[0] : null;
      return pi ? { payment_intent_id: pi.id, status: piStatus(pi) } : null;
    },
    // Webhooks re-fetch the object and apply its CURRENT state (events arrive out of order).
    async retrieve(kind, id) {
      const path = { payment_intent: "/payment_intents/", checkout_session: "/checkout/sessions/", refund: "/refunds/", setup_intent: "/setup_intents/", charge: "/charges/" }[kind];
      if (!path) throw new TypeError(`stripe: can't retrieve ${kind}`);
      const expand = {
        payment_intent: ["latest_charge.balance_transaction", "payment_method"],
        checkout_session: ["payment_intent", "payment_intent.latest_charge.balance_transaction", "payment_intent.payment_method", "setup_intent", "setup_intent.payment_method"],
        setup_intent: ["payment_method"],
        refund: [], charge: ["refunds"],
      }[kind];
      return call("GET", path + encodeURIComponent(id), expand.length ? { expand } : {});
    },
    async refund({ payment_intent_id, amount_cents, reason, idempotencyKey, metadata = {} } = {}) {
      const r = await call("POST", "/refunds", { payment_intent: payment_intent_id, amount: amount_cents, ...(reason ? { reason: "requested_by_customer" } : {}), metadata: metaOf(metadata) }, { idempotencyKey });
      return { status: r.status === "succeeded" ? "succeeded" : r.status === "failed" || r.status === "canceled" ? "failed" : "pending", refund_id: r.id };
    },
    // Read-only (§6.2 card verification).
    async listPaymentMethods({ customer_id } = {}) {
      if (!customer_id) return [];
      const out = [];
      for (const type of ["card", "us_bank_account"]) {
        const r = await call("GET", `/customers/${encodeURIComponent(customer_id)}/payment_methods`, { type, limit: 20 });
        for (const pm of (r && r.data) || []) {
          out.push({ id: pm.id, kind: pm.type, brand: pm.card ? pm.card.brand : pm.us_bank_account ? pm.us_bank_account.bank_name : undefined, last4: pm.card ? pm.card.last4 : pm.us_bank_account ? pm.us_bank_account.last4 : undefined, exp_month: pm.card ? pm.card.exp_month : undefined, exp_year: pm.card ? pm.card.exp_year : undefined });
        }
      }
      return out;
    },
    verifyWebhook: (raw, header, secret, nowS) => verifyWebhook(raw, header, secret, nowS),
  });
}

// Stripe-Signature: t=<unix>,v1=<hex>[,v1=...]. HMAC-SHA256 of `${t}.${raw}`
// with the endpoint secret, compared in constant time, at most 5 minutes
// old (either way). → the parsed event; throws on anything else.
export function verifyWebhook(raw, header, secret, nowS = Math.floor(nowMs() / 1000)) {
  if (!secret || typeof secret !== "string") throw new Error("webhook: no secret");
  const parts = String(header || "").split(",").map((x) => x.trim().split("="));
  const t = Number((parts.find(([k]) => k === "t") || [])[1]);
  const sigs = parts.filter(([k, v]) => k === "v1" && /^[0-9a-f]{64}$/.test(v || "")).map(([, v]) => v);
  if (!Number.isSafeInteger(t) || !sigs.length) throw new Error("webhook: bad signature header");
  if (Math.abs(nowS - t) > WEBHOOK_TOLERANCE_S) throw new Error("webhook: too old");
  const body = typeof raw === "string" ? raw : Buffer.from(raw || []).toString("utf8");
  const want = createHmac("sha256", secret).update(`${t}.${body}`).digest();
  const ok = sigs.some((s) => { const got = Buffer.from(s, "hex"); return got.length === want.length && timingSafeEqual(got, want); });
  if (!ok) throw new Error("webhook: signature mismatch");
  const event = JSON.parse(body);
  if (!event || typeof event.id !== "string" || typeof event.type !== "string") throw new Error("webhook: not an event");
  return event;
}

// A signature header for a body (tests and the owner's own checks).
export function signWebhook(raw, secret, t = Math.floor(nowMs() / 1000)) {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex")}`;
}

let registered = false;
export function registerStripeDrivers() {
  if (registered) return;
  registered = true;
  registerAdapter("payments", "live", stripeDriver("live"));
  registerAdapter("payments", "test", stripeDriver("test"));
}
