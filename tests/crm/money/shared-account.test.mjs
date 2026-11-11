// Sharing Barta's Stripe account with Rotor (design §6.2, §13 D2; the
// owner's Stripe rules; §11.4 M5 shared-account.test.mjs). In test mode,
// with a test key and a mocked Stripe (nothing here reaches the network):
// the webhook acts only on objects the CRM made and counts the rest; before
// the switch no request writes a Stripe customer or payment method; a
// customer Rotor bills is never taken to Stripe at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, testContact, importedCustomer, openInvoice, invoiceOf, paymentOf, recs, outbox, texts, drain, scope, store, uuid, portalCookie, PJSON, IPHONE, U, CH, CARDS, AS, AUTOMATION } from "./fixtures.mjs";
const S = await import("../../../netlify/lib/crm/adapters/payments-stripe.mjs");
const { deployContext } = await import("../../../netlify/lib/crm/core/context.mjs");
// what the worker's scope carries on the live site (the payments gate reads the deploy from it)
const live = (fn) => store.withStoreScope({ requestId: "test", deploy: deployContext(new Request("https://www.bartawindowwashing.com/"), {}) }, fn);

const TEST = "sk_" + "test_" + "e5f6g7h8".repeat(3);
const LIVE = "sk_" + "live_" + "a1b2c3d4".repeat(3);
const WHSEC = "whsec_" + "test-endpoint-not-real";
const CUS = "cus_" + "Test" + "ModeMade01";
const ENV = { CONTEXT: "production", CRM_PRODUCTION: "1", CRM_KEY_SALT: "test-salt-not-real", STRIPE_SECRET_KEY: LIVE, STRIPE_TEST_SECRET_KEY: TEST, STRIPE_TEST_WEBHOOK_SECRET: WHSEC, STRIPE_WEBHOOK_SECRET: undefined };

// Stripe, mocked: answers from `objects` and keeps every request.
function stripe() {
  const calls = [];
  const objects = new Map();
  const real = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(typeof url === "string" ? url : url.url);
    if (u.host !== "api.stripe.com") return real(url, init);
    const call = { method: init.method || "GET", path: u.pathname.replace(/^\/v1/, ""), auth: (init.headers || {}).Authorization, idem: (init.headers || {})["Idempotency-Key"], body: init.body ? Object.fromEntries(new URLSearchParams(init.body)) : {}, raw: String(init.body || "") };
    calls.push(call);
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status });
    if (call.method === "POST" && call.path === "/checkout/sessions") {
      n += 1;
      const id = `cs_test_${n}`;
      objects.set(id, { id, object: "checkout.session", livemode: false, mode: call.body.mode, status: "open", metadata: { crm_invoice_id: call.body["metadata[crm_invoice_id]"], crm_contact_id: call.body["metadata[crm_contact_id]"], tip_cents: call.body["metadata[tip_cents]"] } });
      return json({ id, url: `https://checkout.stripe.com/c/pay/${id}`, expires_at: 1795000000 });
    }
    if (call.method === "POST" && /^\/checkout\/sessions\/[^/]+\/expire$/.test(call.path)) return json({ id: call.path.split("/")[3], status: "expired" });
    if (call.method === "POST" && call.path === "/payment_intents") {
      if (call.body.payment_method === "pm_test_declines") return json({ error: { type: "card_error", code: "card_declined", decline_code: "generic_decline", payment_intent: { id: "pi_test_declined", status: "requires_payment_method" } } }, 402);
      return json({ id: "pi_test_offsession", status: "succeeded", livemode: false, latest_charge: { id: "ch_test_off", balance_transaction: { fee: 741 } } });
    }
    if (call.method === "POST" && call.path === "/refunds") return json({ id: "re_test_1", status: "succeeded" });
    if (call.method === "GET") {
      const id = decodeURIComponent(call.path.split("/").pop());
      if (objects.has(id)) return json(objects.get(id));
      if (/\/payment_methods$/.test(call.path)) return json({ data: [] });
      return json({ error: { type: "invalid_request_error", message: "No such object" } }, 404);
    }
    return json({ error: { type: "invalid_request_error", message: "not in this test" } }, 400);
  };
  return { calls, objects, restore: () => { globalThis.fetch = real; } };
}

const hook = (t, event, { secret = WHSEC, path = "/hooks/stripe-test", header } = {}) => {
  const raw = JSON.stringify(event);
  return t.api(path, { method: "POST", raw, csrf: false, client: false, headers: { "content-type": "application/json", "stripe-signature": header !== undefined ? header : S.signWebhook(raw, secret, Math.floor(Date.parse("2026-11-17T15:00:00Z") / 1000)) } });
};
const foreign = (t) => (t.stores.data.json("sys/health") || {}).stripe_foreign_events || 0;
const pm = { id: "pm_test_visa", type: "card", card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 } };

test("test mode on a shared account: the CRM's own Checkout is applied from the webhook; Rotor's charges, refunds and sessions are ignored and counted; no customer or card is ever written", async () => {
  const { t, owner } = await setup(undefined, { env: ENV });
  const net = stripe();
  try {
    // the owner turns on test mode (a test key is there); live is refused while Rotor is in charge even with a live key there
    assert.equal((await t.api("/money/payments-mode", { method: "POST", as: owner, body: { mode: "live" } })).status, 409);
    const on = await t.api("/money/payments-mode", { method: "POST", as: owner, body: { mode: "test" } });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.deepEqual([on.body.data.mode, on.body.data.keys.STRIPE_TEST_SECRET_KEY, on.body.data.keys.STRIPE_SECRET_KEY, on.body.data.keys.STRIPE_TEST_WEBHOOK_SECRET], ["test", "test", "live", "set"]);
    assert.doesNotMatch(JSON.stringify(on.body), /sk_|whsec_/, "names and kinds only, never a value");

    const c = await testContact(owner);
    const inv = await openInvoice(t, owner, c);
    const cookie = await portalCookie(t, c.id, { kind: "invoice", id: inv.id });
    const page = await t.portal(`/p/invoice/${inv.id}`, { cookie, headers: { "user-agent": IPHONE } });
    assert.doesNotMatch(page.text, /Test mode: nothing is really charged/, "that line is the practice driver's");
    const co = await t.portal(`/api/portal/invoices/${inv.id}/checkout`, { method: "POST", headers: PJSON, cookie, body: { tip_choice: "10", save_card: true } });
    assert.equal(co.status, 200, JSON.stringify(co.body));
    assert.equal(co.body.data.url, "https://checkout.stripe.com/c/pay/cs_test_1");
    const made = net.calls.at(-1);
    assert.deepEqual([made.method, made.path, made.auth], ["POST", "/checkout/sessions", `Bearer ${TEST}`]);
    assert.match(made.idem, /^checkout:[0-9a-f]{24}$/);
    assert.equal(made.body.customer, undefined, "before the switch the CRM makes no Stripe customer");
    assert.equal(made.body["line_items[1][price_data][unit_amount]"], "2950");
    // the practice Checkout doesn't exist in test mode
    assert.equal((await t.portal("/p/dry-checkout/dry_cs_" + "ab12".repeat(6), { headers: { "user-agent": IPHONE } })).status, 404);

    // Stripe finishes the Checkout; its webhook says so (the handler re-reads the session, never trusts the event)
    const pi = { id: "pi_test_1", object: "payment_intent", livemode: false, status: "succeeded", amount: 32450, amount_received: 32450, metadata: { crm_invoice_id: inv.id, crm_contact_id: c.id, tip_cents: "2950" }, payment_method: pm, customer: CUS, setup_future_usage: "off_session", latest_charge: { id: "ch_test_1", balance_transaction: { fee: 971 } } };
    net.objects.set("cs_test_1", { ...net.objects.get("cs_test_1"), status: "complete", payment_status: "paid", payment_intent: pi, customer: CUS });
    net.objects.set("pi_test_1", pi);
    const before = net.calls.length;
    const done = await hook(t, { id: "evt_1", type: "checkout.session.completed", livemode: false, data: { object: { id: "cs_test_1", mode: "payment", metadata: {} } } });
    assert.deepEqual([done.status, done.body.data], [200, { applied: true }]);
    assert.deepEqual(net.calls.slice(before).map((x) => `${x.method} ${x.path}`), ["GET /checkout/sessions/cs_test_1"]);
    const p = await paymentOf(U.payId.pi("pi_test_1"));
    assert.deepEqual([p.status, p.simulated, p.amount_cents, p.tip_cents, p.fee_cents, p.card.last4, p.stripe.checkout_session_id], ["succeeded", undefined, 29500, 2950, 971, "4242", "cs_test_1"]);
    assert.equal((await invoiceOf(inv.id)).status, "paid");
    // the same event again, and the PaymentIntent's own event after it: one payment
    assert.deepEqual((await hook(t, { id: "evt_1", type: "checkout.session.completed", livemode: false, data: { object: { id: "cs_test_1", mode: "payment" } } })).body.data, { already: true });
    assert.deepEqual((await hook(t, { id: "evt_2", type: "payment_intent.succeeded", livemode: false, data: { object: { id: "pi_test_1", metadata: { crm_invoice_id: inv.id } } } })).body.data, { applied: true });
    assert.equal(recs(t, "payment").length, 1);
    // the card they chose to save: recorded as a test-mode card on the CRM's own (Checkout-made) customer
    const st = (await scope(() => store.getRecord("contact_stats", c.id))).data.money.stripe;
    assert.deepEqual([st.card_status, st.default_pm.id, st.default_pm.mode, st.crm_customer_id, st.crm_created_ids], ["on_file", "pm_test_visa", "test", CUS, [CUS]]);

    // --- Rotor's traffic on the same endpoint: nothing of it is read, fetched or stored
    assert.equal(foreign(t), 0);
    const quiet = net.calls.length;
    const rotorEvents = [
      { id: "evt_r1", type: "payment_intent.succeeded", data: { object: { id: "pi_rotor_1", amount: 24500, metadata: { rotor_invoice: "8812" } } } },
      { id: "evt_r2", type: "charge.refunded", data: { object: { id: "ch_rotor_1", payment_intent: "pi_rotor_1", amount_refunded: 24500 } } },
      { id: "evt_r3", type: "checkout.session.completed", data: { object: { id: "cs_rotor_1", mode: "payment", metadata: {} } } },
      { id: "evt_r4", type: "payment_intent.payment_failed", data: { object: { id: "pi_rotor_2", metadata: {} } } },
      { id: "evt_r5", type: "charge.dispute.created", data: { object: { id: "dp_rotor_1", payment_intent: "pi_rotor_1" } } },
      { id: "evt_r6", type: "setup_intent.succeeded", data: { object: { id: "seti_rotor_1", metadata: {} } } },
      // metadata that only looks like ours: an invoice id that doesn't exist here
      { id: "evt_r7", type: "payment_intent.succeeded", data: { object: { id: "pi_rotor_3", metadata: { crm_invoice_id: "in_00000000000000000000" } } } },
      // a card detached from one of Rotor's customers: before the switch never ours, whoever it is
      { id: "evt_r8", type: "payment_method.detached", data: { object: { id: "pm_test_visa", customer: null }, previous_attributes: { customer: CUS } } },
    ];
    for (const e of rotorEvents) {
      const r = await hook(t, { ...e, livemode: false });
      assert.deepEqual([r.status, r.body.data], [200, { ignored: "foreign" }], e.id);
    }
    assert.equal(foreign(t), rotorEvents.length, "each one is counted (Settings → Payments shows the number)");
    assert.equal(net.calls.length, quiet, "not one request to Stripe about them");
    assert.equal(recs(t, "payment").length, 1);
    assert.equal(t.stores.data.keys("done/stripe-event/").length, 2, "only our two events left a marker");
    // an event type the CRM doesn't handle, a live event on the test endpoint: ignored without counting
    assert.deepEqual((await hook(t, { id: "evt_x1", type: "customer.updated", livemode: false, data: { object: { id: CUS } } })).body.data, { ignored: "type" });
    assert.deepEqual((await hook(t, { id: "evt_x2", type: "payment_intent.succeeded", livemode: true, data: { object: { id: "pi_test_1", metadata: { crm_invoice_id: inv.id } } } })).body.data, { ignored: "mode" });
    // a bad signature, an old one, another secret; and the live endpoint is closed while Rotor is in charge
    const ev = { id: "evt_bad", type: "payment_intent.succeeded", livemode: false, data: { object: { id: "pi_test_1", metadata: { crm_invoice_id: inv.id } } } };
    assert.equal((await hook(t, ev, { secret: "whsec_" + "someone-elses" })).status, 401);
    assert.equal((await hook(t, ev, { header: "t=1,v1=" + "0".repeat(64) })).status, 401);
    assert.equal((await hook(t, ev, { header: "" })).status, 401);
    assert.equal((await hook(t, ev, { path: "/hooks/stripe" })).status, 404);
    assert.equal(recs(t, "payment").length, 1);

    // --- the saved test card, charged off-session; a decline; a refund; the weekly card check
    const inv2 = await openInvoice(t, owner, c, { cents: 24500 });
    const out = await live(() => CH.chargeInvoice(inv2.id, { origin: "staff", by: owner.id }, AS(owner)));
    assert.equal(out.result, "succeeded");
    const ch = net.calls.at(-1);
    assert.deepEqual([ch.method, ch.path, ch.idem, ch.body.customer, ch.body.payment_method, ch.body.amount, ch.body.off_session, ch.body["metadata[crm_attempt_id]"]], ["POST", "/payment_intents", `charge:${out.attempt_id}`, CUS, "pm_test_visa", "24500", "true", out.attempt_id]);
    assert.equal((await paymentOf(out.payment_id)).simulated, undefined);
    assert.equal((await paymentOf(out.payment_id)).fee_cents, 741);
    const back = await t.api(`/payments/${out.payment_id}/refund`, { method: "POST", as: owner, body: { amount_cents: 4500, reason: "Missed two panes", client_id: uuid(91) } });
    assert.equal(back.status, 201, JSON.stringify(back.body));
    const rf = net.calls.at(-1);
    assert.deepEqual([rf.path, rf.idem, rf.body.payment_intent, rf.body.amount, rf.body["metadata[crm_payment_id]"]], ["/refunds", `refund:${uuid(91)}`, "pi_test_offsession", "4500", out.payment_id]);
    assert.doesNotMatch(rf.raw, /Missed/, "the office's note stays in the CRM");
    assert.equal(back.body.data.refund.id, U.payId.re("re_test_1"));
    // charge.refunded for that refund lands on the same row
    net.objects.set("ch_test_off", { id: "ch_test_off", payment_intent: "pi_test_offsession", refunds: { data: [{ id: "re_test_1", amount: 4500, status: "succeeded", metadata: { crm_refund_request: uuid(91) } }] } });
    assert.deepEqual((await hook(t, { id: "evt_3", type: "charge.refunded", livemode: false, data: { object: { id: "ch_test_off", payment_intent: "pi_test_offsession" } } })).body.data, { applied: true });
    assert.equal(recs(t, "payment").filter((x) => x.kind === "refund").length, 1);
    assert.equal((await paymentOf(out.payment_id)).refunded_cents, 4500);
    // a card that declines in test mode
    await scope(() => CARDS.recordSavedMethod(c.id, { id: "pm_test_declines", kind: "card", brand: "visa", last4: "0002", mode: "test" }, { customer_id: CUS }, AS(owner)));
    const inv3 = await openInvoice(t, owner, c, { cents: 5000 });
    const no = await live(() => CH.chargeInvoice(inv3.id, { origin: "staff", by: owner.id }, AS(owner)));
    assert.deepEqual([no.result, no.code], ["failed", "generic_decline"]);
    // a practice card can't be charged through Stripe
    await scope(() => CARDS.recordSavedMethod(c.id, { id: "dry_pm_card_ok", kind: "card", brand: "visa", last4: "4242" }, {}, AS(owner)));
    const posts = net.calls.filter((x) => x.method === "POST").length;
    const dry = await live(() => CH.chargeInvoice(inv3.id, { origin: "staff", by: owner.id }, AS(owner)));
    assert.deepEqual([dry.result, dry.code], ["refused", "no_card"]);
    assert.equal(net.calls.filter((x) => x.method === "POST").length, posts);
    // the weekly check reads the CRM's own customer's methods (read-only)
    const mark = net.calls.length;
    await live(() => CARDS.verifyCards({ deploy: (store.currentScope() || {}).deploy, mode: AUTOMATION.mode, write: () => AUTOMATION, budget: null, cursor: null }));
    assert.ok(net.calls.slice(mark).every((x) => x.method === "GET"));

    // --- a customer Rotor bills never reaches Stripe, whatever is asked
    const rc = await importedCustomer();
    const rinv = await openInvoice(t, owner, rc);
    const rcookie = await portalCookie(t, rc.id, { kind: "invoice", id: rinv.id });
    const quiet2 = net.calls.length;
    assert.equal((await t.portal(`/api/portal/invoices/${rinv.id}/checkout`, { method: "POST", headers: PJSON, cookie: rcookie, body: { tip_choice: "0" } })).status, 409);
    const rcard = await portalCookie(t, rc.id, { kind: "card" });
    assert.equal((await t.portal("/api/portal/card/checkout", { method: "POST", headers: PJSON, cookie: rcard, body: {} })).status, 409);
    assert.equal((await live(() => CH.chargeInvoice(rinv.id, { origin: "autopay", by: "system:autopay" }, AUTOMATION))).result, "would_charge");
    assert.equal(net.calls.length, quiet2);

    // --- the whole conversation with Stripe, looked at once: the test key only; no customer or payment method was written
    assert.ok(net.calls.length > 5);
    for (const x of net.calls) {
      assert.equal(x.auth, `Bearer ${TEST}`, "never the live key");
      assert.ok(["GET", "POST"].includes(x.method));
      assert.ok(!(x.method !== "GET" && /^\/customers(\/|$)/.test(x.path)), `no write to a customer: ${x.method} ${x.path}`);
      assert.doesNotMatch(x.path, /^\/payment_methods/, "no payment method is attached, detached or changed");
      assert.doesNotMatch(x.raw, /invoice_settings|default_payment_method|customer_update|default_source/);
      if (x.method === "POST") assert.ok(x.idem, "every POST carries its Idempotency-Key");
    }
    assert.deepEqual([...new Set(net.calls.filter((x) => x.method === "POST").map((x) => x.path.replace(/cs_test_\d+/, "{id}")))].sort(), ["/checkout/sessions", "/payment_intents", "/refunds"]);
    await drain(t);
    assert.equal(outbox(t, "charge").length + outbox(t, "checkout").length, 0, "nothing went through the practice driver in test mode");
    assert.ok(texts(t, "payment_receipt").length >= 1);
  } finally { net.restore(); t.done(); }
});

test("with a test key but the mode left at dry run, or on a copy that isn't the live site, Stripe is never called and the webhooks are closed", async () => {
  const { t, owner } = await setup(undefined, { env: ENV });
  const net = stripe();
  try {
    assert.equal((await t.api("/money/status", { as: owner })).body.data.mode, "dry_run", "keys alone switch nothing on");
    const c = await testContact(owner);
    const inv = await openInvoice(t, owner, c);
    const cookie = await portalCookie(t, c.id, { kind: "invoice", id: inv.id });
    const co = await t.portal(`/api/portal/invoices/${inv.id}/checkout`, { method: "POST", headers: PJSON, cookie, body: { tip_choice: "0" } });
    assert.match(co.body.data.url, /^\/p\/dry-checkout\//);
    const ev = { id: "evt_1", type: "payment_intent.succeeded", livemode: false, data: { object: { id: "pi_1", metadata: { crm_invoice_id: inv.id } } } };
    assert.equal((await hook(t, ev)).status, 404, "the test endpoint is closed unless test mode is on");
    assert.equal((await hook(t, ev, { path: "/hooks/stripe" })).status, 404);
    assert.equal((await invoiceOf(inv.id)).status, "open");
    assert.equal(net.calls.length, 0);
  } finally { net.restore(); t.done(); }
});
