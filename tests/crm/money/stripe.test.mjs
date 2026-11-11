// The Stripe driver (design §6.2; the owner's Stripe rules). It is tested
// ONLY against a mocked fetch: nothing here reaches the network. What it
// may send, with which key, and what it must never send (a write to a
// Stripe customer or payment method it didn't make).
import { test } from "node:test";
import assert from "node:assert/strict";

const S = await import("../../../netlify/lib/crm/adapters/payments-stripe.mjs");

// made-up keys, built in pieces so nothing here looks like a real one
const LIVE = "sk_" + "live_" + "a1b2c3d4".repeat(3);
const TEST = "sk_" + "test_" + "e5f6g7h8".repeat(3);
const RTEST = "rk_" + "test_" + "e5f6g7h8".repeat(3);
const CUS = "cus_" + "Made" + "ByTheCrm01";

// A fetch that answers from a list of [method, path regexp, answer] routes and keeps what was asked.
function mock(routes = []) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const call = { method: init.method || "GET", path: u.pathname.replace(/^\/v1/, ""), query: Object.fromEntries(u.searchParams), headers: init.headers || {}, body: init.body ? Object.fromEntries(new URLSearchParams(init.body)) : null, raw: init.body || "", signal: init.signal };
    calls.push(call);
    assert.equal(u.origin, "https://api.stripe.com");
    const r = routes.find(([m, re]) => m === call.method && re.test(call.path));
    if (!r) return new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "no such route in this test" } }), { status: 404 });
    const out = typeof r[2] === "function" ? r[2](call) : r[2];
    return out instanceof Response ? out : new Response(JSON.stringify(out), { status: 200 });
  };
  return { calls, fetchImpl };
}
const driver = (mode, routes, env) => { const m = mock(routes); return { ...m, d: S.stripeDriver(mode, { fetchImpl: m.fetchImpl, env: env || { STRIPE_SECRET_KEY: LIVE, STRIPE_TEST_SECRET_KEY: TEST } }) }; };
const INV = { id: "in_00000000000000000001", number: "INV-0610", contact_id: "ct_00000000000000000001", wv: 3 };

test("keys: only a test key in test mode and a live key in live mode; anything else is refused before any request", async () => {
  assert.equal(S.keyKind(LIVE), "live");
  assert.equal(S.keyKind(TEST), "test");
  assert.equal(S.keyKind(RTEST), "test", "a restricted test key");
  assert.equal(S.keyKind("rk_" + "live_" + "z".repeat(20)), "live");
  assert.equal(S.keyKind(""), "missing");
  assert.equal(S.keyKind(undefined), "missing");
  assert.equal(S.keyKind("pk_" + "test_" + "z".repeat(20)), "other", "a publishable key is not a secret key");
  assert.equal(S.keyKind("whatever"), "other");
  for (const [mode, env] of [
    ["test", { STRIPE_TEST_SECRET_KEY: LIVE }],             // a live key pasted into the test slot
    ["test", { STRIPE_SECRET_KEY: TEST }],                  // the test key in the wrong variable
    ["test", {}],
    ["live", { STRIPE_SECRET_KEY: TEST }],
    ["live", { STRIPE_SECRET_KEY: "nonsense" }],
    ["live", { STRIPE_TEST_SECRET_KEY: LIVE }],
  ]) {
    const { d, calls } = driver(mode, [], env);
    await assert.rejects(() => d.chargeSaved({ payment_method_id: "pm_1", amount_cents: 100, idempotencyKey: "charge:x" }), S.StripeKeyRefused);
    await assert.rejects(() => d.retrieve("payment_intent", "pi_1"), S.StripeKeyRefused);
    await assert.rejects(() => d.checkoutPayment({ invoice: INV, amount_cents: 100, idempotencyKey: "checkout:x" }), S.StripeKeyRefused);
    await assert.rejects(() => d.refund({ payment_intent_id: "pi_1", amount_cents: 100, idempotencyKey: "refund:x" }), S.StripeKeyRefused);
    assert.equal(calls.length, 0, `${mode} ${JSON.stringify(Object.keys(env))}: nothing was sent`);
  }
  assert.throws(() => S.stripeDriver("dry_run"), TypeError);
  const e = new S.StripeKeyRefused("test");
  assert.doesNotMatch(e.message, /sk_|rk_/, "the refusal never repeats a key");
});

test("a request: Bearer key, the pinned version, form encoding, a timeout, and an Idempotency-Key on every POST", async () => {
  assert.equal(S.formEncode({ a: 1, b: { c: "x y", d: [1, 2] }, e: [{ f: 1 }, { f: 2 }], g: null, h: undefined, i: "é&=" }), "a=1&b%5Bc%5D=x%20y&b%5Bd%5D%5B%5D=1&b%5Bd%5D%5B%5D=2&e%5B0%5D%5Bf%5D=1&e%5B1%5D%5Bf%5D=2&i=%C3%A9%26%3D");
  const { calls, fetchImpl } = mock([["POST", /^\/refunds$/, { id: "re_1", status: "succeeded" }], ["GET", /^\/payment_intents\/pi_1$/, { id: "pi_1", status: "succeeded" }]]);
  const env = { STRIPE_TEST_SECRET_KEY: TEST };
  await S.stripeRequest("test", "POST", "/refunds", { payment_intent: "pi_1", amount: 500 }, { idempotencyKey: "refund:abc", env, fetchImpl });
  const c = calls[0];
  assert.equal(c.headers.Authorization, `Bearer ${TEST}`);
  assert.equal(c.headers["Stripe-Version"], "2024-06-20");
  assert.equal(c.headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.equal(c.headers["Idempotency-Key"], "refund:abc");
  assert.deepEqual(c.body, { payment_intent: "pi_1", amount: "500" });
  assert.ok(c.signal instanceof AbortSignal, "every call has its 8 s timeout");
  await assert.rejects(() => S.stripeRequest("test", "POST", "/refunds", {}, { env, fetchImpl }), /Idempotency-Key/);
  assert.equal(calls.length, 1, "a POST without its key is never sent");
  await S.stripeRequest("test", "GET", "/payment_intents/pi_1", { expand: ["latest_charge.balance_transaction"] }, { env, fetchImpl });
  assert.equal(calls[1].headers["Idempotency-Key"], undefined);
  assert.equal(calls[1].raw, "", "a GET has no body");
  assert.deepEqual(calls[1].query, { "expand[]": "latest_charge.balance_transaction" });
  // errors: what Stripe said becomes a code, never a customer's details; 429 and 5xx are worth another try
  const bad = mock([["POST", /^\/refunds$/, () => new Response(JSON.stringify({ error: { type: "card_error", code: "card_declined", decline_code: "insufficient_funds", message: "Your card has insufficient funds. pat@example.com" } }), { status: 402 })]]);
  const err = await S.stripeRequest("test", "POST", "/refunds", {}, { idempotencyKey: "k", env, fetchImpl: bad.fetchImpl }).catch((x) => x);
  assert.ok(err instanceof S.StripeError);
  assert.deepEqual([err.status, err.code, err.transient, err.message], [402, "insufficient_funds", false, "Stripe said no."]);
  const busy = mock([["POST", /^\/refunds$/, () => new Response("oops", { status: 503 })]]);
  const e2 = await S.stripeRequest("test", "POST", "/refunds", {}, { idempotencyKey: "k", env, fetchImpl: busy.fetchImpl }).catch((x) => x);
  assert.deepEqual([e2.status, e2.transient], [503, true]);
});

test("Checkout: a payment (the tip its own line, the invoice named in metadata, a card saved only when asked) and a card set-up", async () => {
  const { d, calls } = driver("test", [["POST", /^\/checkout\/sessions$/, { id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1", expires_at: 1795000000 }]]);
  const s = await d.checkoutPayment({ invoice: INV, amount_cents: 29500, tip_cents: 2950, save_card: false, methods: ["card", "us_bank_account"], success_url: "https://www.bartawindowwashing.com/p/return?cs={CHECKOUT_SESSION_ID}", cancel_url: "https://www.bartawindowwashing.com/p/invoice/in_00000000000000000001", idempotencyKey: "checkout:req1", expires_at_ms: 1795000000000 });
  assert.deepEqual(s, { url: "https://checkout.stripe.com/c/pay/cs_test_1", session_id: "cs_test_1", expires_at: new Date(1795000000000).toISOString() });
  const b = calls[0].body;
  assert.equal(calls[0].headers["Idempotency-Key"], "checkout:req1");
  assert.equal(b.mode, "payment");
  assert.deepEqual([b["line_items[0][price_data][unit_amount]"], b["line_items[0][price_data][product_data][name]"], b["line_items[0][price_data][currency]"]], ["29500", "Invoice INV-0610", "usd"]);
  assert.deepEqual([b["line_items[1][price_data][unit_amount]"], b["line_items[1][price_data][product_data][name]"]], ["2950", "Tip for the crew"]);
  assert.deepEqual([b["metadata[crm_invoice_id]"], b["metadata[crm_contact_id]"], b["metadata[tip_cents]"]], [INV.id, INV.contact_id, "2950"]);
  assert.equal(b["payment_intent_data[metadata][crm_invoice_id]"], INV.id, "the PaymentIntent carries it too: that is how a webhook knows it is ours");
  assert.equal(b.expires_at, "1795000000");
  assert.match(calls[0].raw, /payment_method_types%5B%5D=card&payment_method_types%5B%5D=us_bank_account/);
  assert.equal(b.customer, undefined, "no customer unless the CRM has its own");
  assert.equal(b["payment_intent_data[setup_future_usage]"], undefined, "nothing is saved unless asked");
  assert.equal(b.customer_update, undefined);
  assert.match(b.success_url, /\/p\/return\?cs=\{CHECKOUT_SESSION_ID\}$/, "no portal token ever goes to Stripe");
  await d.checkoutPayment({ invoice: INV, amount_cents: 29500, customer_id: CUS, save_card: true, idempotencyKey: "checkout:req2" });
  assert.equal(calls[1].body.customer, CUS);
  assert.equal(calls[1].body["payment_intent_data[setup_future_usage]"], "off_session");
  assert.equal(calls[1].body["line_items[1][quantity]"], undefined, "no tip line when there is no tip");
  await d.checkoutSetup({ customer_id: CUS, contact_id: INV.contact_id, methods: ["card"], success_url: "https://www.bartawindowwashing.com/p/return?cs={CHECKOUT_SESSION_ID}", cancel_url: "https://www.bartawindowwashing.com/p/card", idempotencyKey: "setup:req3" });
  const su = calls[2].body;
  assert.deepEqual([su.mode, su.customer, su["metadata[crm_contact_id]"], su["setup_intent_data[metadata][crm_contact_id]"]], ["setup", CUS, INV.contact_id, INV.contact_id]);
  assert.equal(calls[2].headers["Idempotency-Key"], "setup:req3");
});

test("expiring a Checkout, charging a saved card (one Idempotency-Key per attempt; a decline is an answer, not an error), finding an ambiguous charge", async () => {
  const { d, calls } = driver("live", [
    ["POST", /^\/checkout\/sessions\/cs_open\/expire$/, { id: "cs_open", status: "expired" }],
    ["POST", /^\/checkout\/sessions\/cs_done\/expire$/, () => new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "Only Checkout Sessions with a status in [\"open\"] can be expired." } }), { status: 400 })],
    ["GET", /^\/checkout\/sessions\/cs_done$/, { id: "cs_done", status: "complete" }],
    ["POST", /^\/payment_intents$/, (c) => (c.body.payment_method === "pm_decline"
      ? new Response(JSON.stringify({ error: { type: "card_error", code: "card_declined", decline_code: "do_not_honor", payment_intent: { id: "pi_declined", status: "requires_payment_method" } } }), { status: 402 })
      : c.body.payment_method === "pm_3ds" ? { id: "pi_3ds", status: "requires_action" }
      : c.body.payment_method === "pm_bank" ? { id: "pi_bank", status: "processing", latest_charge: "ch_bank" }
      : { id: "pi_ok", status: "succeeded", latest_charge: { id: "ch_ok", balance_transaction: { fee: 741 } } })],
    ["GET", /^\/payment_intents\/search$/, { data: [{ id: "pi_ok", status: "succeeded" }] }],
  ]);
  assert.deepEqual(await d.expireCheckout("cs_open"), { status: "expired" });
  assert.equal(calls[0].headers["Idempotency-Key"], "expire:cs_open");
  assert.deepEqual(await d.expireCheckout("cs_done"), { status: "complete" }, "one that already completed is reported, so its payment is applied first");
  const args = { customer_id: CUS, amount_cents: 24500, description: "Invoice INV-0611", metadata: { crm_invoice_id: INV.id, crm_contact_id: INV.contact_id, crm_attempt_id: "pm_att000000000000000001" }, idempotencyKey: "charge:pm_att000000000000000001" };
  const ok = await d.chargeSaved({ ...args, payment_method_id: "pm_ok" });
  assert.deepEqual(ok, { status: "succeeded", payment_intent_id: "pi_ok", charge_id: "ch_ok", fee_cents: 741 });
  const sent = calls.at(-1);
  assert.equal(sent.headers.Authorization, `Bearer ${LIVE}`);
  assert.equal(sent.headers["Idempotency-Key"], "charge:pm_att000000000000000001", "the attempt id, no counter: a re-issued call gets Stripe's first answer");
  assert.deepEqual([sent.body.amount, sent.body.currency, sent.body.customer, sent.body.payment_method, sent.body.off_session, sent.body.confirm], ["24500", "usd", CUS, "pm_ok", "true", "true"]);
  assert.deepEqual([sent.body["metadata[crm_invoice_id]"], sent.body["metadata[crm_attempt_id]"]], [INV.id, "pm_att000000000000000001"]);
  assert.deepEqual(await d.chargeSaved({ ...args, payment_method_id: "pm_decline" }), { status: "failed", payment_intent_id: "pi_declined", failure_code: "do_not_honor" });
  assert.equal((await d.chargeSaved({ ...args, payment_method_id: "pm_3ds" })).status, "requires_action");
  assert.deepEqual(await d.chargeSaved({ ...args, payment_method_id: "pm_bank", mandate_id: "mandate_1" }), { status: "processing", payment_intent_id: "pi_bank", charge_id: "ch_bank", fee_cents: undefined });
  assert.equal(calls.at(-1).body.mandate, "mandate_1");
  assert.deepEqual(await d.findPaymentIntent({ attempt_id: "pm_att000000000000000001" }), { payment_intent_id: "pi_ok", status: "succeeded" });
  assert.equal(calls.at(-1).query.query, "metadata['crm_attempt_id']:'pm_att000000000000000001'");
  for (const [st, want] of [["succeeded", "succeeded"], ["processing", "processing"], ["requires_action", "requires_action"], ["canceled", "canceled"], ["requires_payment_method", "failed"], ["requires_confirmation", "pending"], [undefined, "pending"]]) assert.equal(S.piStatus({ status: st }), want);
});

test("customers: the CRM finds or makes only its own (metadata crm_contact_id); it never updates, deletes, attaches or detaches anything", async () => {
  const contact = { id: "ct_00000000000000000001", first_name: "Pat", last_name: "Sample", emails: [{ address: "pat.sample@example.com" }] };
  const routes = (found) => [
    ["GET", /^\/customers\/search$/, { data: found }],
    ["POST", /^\/customers$/, { id: CUS, metadata: { crm_contact_id: contact.id } }],
    ["GET", /^\/customers\/[^/]+\/payment_methods$/, (c) => ({ data: c.query.type === "card" ? [{ id: "pm_1", type: "card", card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 } }] : [] })],
    ["POST", /^\/refunds$/, { id: "re_1", status: "pending" }],
    ["GET", /^\/(payment_intents|checkout\/sessions|setup_intents|refunds|charges)\/[^/]+$/, { id: "x", status: "succeeded" }],
  ];
  // the CRM already knows its customer: no request at all
  let x = driver("live", routes([]));
  assert.deepEqual(await x.d.ensureCustomer({ contact, crmCustomerId: CUS }), { customer_id: CUS });
  assert.equal(x.calls.length, 0);
  // not known, and not allowed to make one (before the switch): a read-only search, nothing written
  assert.deepEqual(await x.d.ensureCustomer({ contact }), { customer_id: null });
  assert.deepEqual(x.calls.map((c) => `${c.method} ${c.path}`), ["GET /customers/search"]);
  assert.equal(x.calls[0].query.query, "metadata['crm_contact_id']:'ct_00000000000000000001'");
  // a customer with the same email that Rotor made is NOT taken: only one carrying the CRM's own metadata
  x = driver("live", routes([{ id: "cus_" + "RotorMade" + "00001", email: "pat.sample@example.com", metadata: {} }]));
  assert.deepEqual(await x.d.ensureCustomer({ contact }), { customer_id: null });
  // the CRM's own from before is found
  x = driver("live", routes([{ id: CUS, metadata: { crm_contact_id: contact.id } }]));
  assert.deepEqual(await x.d.ensureCustomer({ contact, allowCreate: true }), { customer_id: CUS, found: true });
  assert.ok(x.calls.every((c) => c.method === "GET"));
  // after the switch, when none exists: one is made, carrying the contact's id, keyed so a retry can't make two
  x = driver("live", routes([]));
  assert.deepEqual(await x.d.ensureCustomer({ contact, allowCreate: true }), { customer_id: CUS, created: true });
  const made = x.calls.find((c) => c.method === "POST");
  assert.deepEqual([made.path, made.headers["Idempotency-Key"], made.body["metadata[crm_contact_id]"], made.body.email, made.body.name], ["/customers", "customer:ct_00000000000000000001", contact.id, "pat.sample@example.com", "Pat Sample"]);
  assert.equal(made.body["invoice_settings[default_payment_method]"], undefined);
  // everything else the driver can do, then the whole list of what it sent
  assert.deepEqual(await x.d.listPaymentMethods({ customer_id: CUS }), [{ id: "pm_1", kind: "card", brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 }]);
  assert.deepEqual(await x.d.listPaymentMethods({}), []);
  assert.deepEqual(await x.d.refund({ payment_intent_id: "pi_1", amount_cents: 500, reason: "Streaks", idempotencyKey: "refund:u1", metadata: { crm_payment_id: "pm_00000000000000000001", crm_refund_request: "u1" } }), { status: "pending", refund_id: "re_1" });
  const rf = x.calls.at(-1).body;
  assert.deepEqual([rf.payment_intent, rf.amount, rf.reason, rf["metadata[crm_payment_id]"]], ["pi_1", "500", "requested_by_customer", "pm_00000000000000000001"], "the office's own words stay in the CRM");
  for (const kind of ["payment_intent", "checkout_session", "setup_intent", "refund", "charge"]) await x.d.retrieve(kind, "x");
  await assert.rejects(() => x.d.retrieve("customer", CUS), TypeError, "the driver has no way to read a customer object, let alone change one");
  const writes = x.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`);
  assert.deepEqual(writes, ["POST /customers", "POST /refunds"]);
  for (const c of x.calls) {
    assert.ok(["GET", "POST"].includes(c.method), "never DELETE");
    assert.doesNotMatch(c.path, /^\/customers\/cus_[^/]+$/, "never a write or read of one customer object");
    assert.doesNotMatch(c.path, /\/(attach|detach)$/);
    assert.doesNotMatch(c.raw, /invoice_settings|default_payment_method|default_source/);
  }
  // the charge expands the fee; a charge's refunds are read for charge.refunded
  assert.match(x.calls.find((c) => c.path === "/charges/x").headers.Authorization, /^Bearer /);
  assert.deepEqual(x.calls.find((c) => c.path === "/charges/x").query, { "expand[]": "refunds" });
});

test("the webhook signature: HMAC-SHA256 of t.body with the endpoint's secret, constant time, five minutes; anything else is refused", () => {
  const secret = "whsec_" + "not-a-real-secret";
  const body = JSON.stringify({ id: "evt_1", type: "payment_intent.succeeded", livemode: false, data: { object: { id: "pi_1" } } });
  const now = 1795000000;
  const header = S.signWebhook(body, secret, now);
  assert.match(header, /^t=1795000000,v1=[0-9a-f]{64}$/);
  assert.equal(S.verifyWebhook(body, header, secret, now).id, "evt_1");
  assert.equal(S.verifyWebhook(Buffer.from(body), header, secret, now + 299).type, "payment_intent.succeeded", "raw bytes, as the function receives them");
  // Stripe rolls secrets by sending two v1 values: either may match
  assert.equal(S.verifyWebhook(body, `t=${now},v1=${"0".repeat(64)},${header.split(",")[1]}`, secret, now).id, "evt_1");
  assert.throws(() => S.verifyWebhook(body, header, secret, now + 301), /too old/);
  assert.throws(() => S.verifyWebhook(body, header, secret, now - 301), /too old/);
  assert.throws(() => S.verifyWebhook(body.replace("pi_1", "pi_2"), header, secret, now), /mismatch/, "a changed body");
  assert.throws(() => S.verifyWebhook(body, header, secret + "x", now), /mismatch/, "another endpoint's secret");
  assert.throws(() => S.verifyWebhook(body, `t=${now},v1=${"0".repeat(64)}`, secret, now), /mismatch/);
  assert.throws(() => S.verifyWebhook(body, `t=${now},v0=${header.split("=").pop()}`, secret, now), /bad signature header/);
  assert.throws(() => S.verifyWebhook(body, "", secret, now), /bad signature header/);
  assert.throws(() => S.verifyWebhook(body, null, secret, now), /bad signature header/);
  assert.throws(() => S.verifyWebhook(body, header, "", now), /no secret/);
  const notEvent = JSON.stringify({ hello: "there" });
  assert.throws(() => S.verifyWebhook(notEvent, S.signWebhook(notEvent, secret, now), secret, now), /not an event/);
});
