// Dry run (design §6.1, §3.10; the owner's Stripe rules; §11.4 M5
// dry-run.test.mjs): until the owner connects keys nothing reaches Stripe;
// the practice Checkout stands in, and only for a sandboxed customer. A
// customer Rotor still bills can't be taken through it, whatever is asked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, customer, testContact, importedCustomer, openInvoice, invoiceOf, recs, outbox, texts, drain, scope, store, uuid, saveCard, portalCookie, PJSON, IPHONE, IMPORT, AS, CO, CH, GATE, AUTOMATION } from "./fixtures.mjs";

const importedInvoice = (c) => scope(async () => (await store.createRecord("invoice", {
  number: "INV-0555", seq: "imported", n: 555, kind: "standard", contact_id: c.id, status: "open", issued_on: "2026-11-01", due_on: "2026-11-01",
  lines: [{ id: "ln_1", kind: "service", description: "Exterior window cleaning", qty_milli: 1000, unit_cents: 29500, total_cents: 29500 }],
  import: { run_id: "ir_00000000000000000001", at: "2026-11-08T00:00:00.000Z", hash: "2".repeat(64) }, rotor: { invoice_id: "5f0c1b2a-0000-4000-8000-000000000555", status_raw: "sent", total_cents_raw: 29500 },
}, IMPORT)).data);

test("the practice Checkout is refused for a customer Rotor still bills: an imported invoice, and an invoice typed in for them", async () => {
  const { t, owner } = await setup();
  try {
    const c = await importedCustomer();
    const imp = await importedInvoice(c);
    assert.equal(imp.shadow, undefined);
    const typed = await openInvoice(t, owner, c);
    assert.equal(typed.shadow, true, "made in the CRM while Rotor is in charge");
    for (const inv of [imp, typed]) {
      const cookie = await portalCookie(t, c.id, { kind: "invoice", id: inv.id });
      const page = await t.portal(`/p/invoice/${inv.id}`, { cookie, headers: { "user-agent": IPHONE } });
      assert.equal(page.status, 200);
      assert.match(page.text, /\$295\.00/);
      assert.match(page.text, /Online payment for this invoice opens soon/);
      assert.doesNotMatch(page.text, /data-pay-btn/, "no Pay button");
      const co = await t.portal(`/api/portal/invoices/${inv.id}/checkout`, { method: "POST", headers: PJSON, cookie, body: { tip_choice: "0" } });
      assert.equal(co.status, 409);
      assert.equal(co.body.error.code, "not_yet");
      // even a session someone forged a record for can't be completed
      const sid = `dry_cs_${(inv === imp ? "ab12" : "cd34").repeat(6)}`;
      await scope(() => store.claimPointer("checkout", CO.sessionKey(sid), { id: inv.id, kind: "payment", contact_id: c.id, amount_cents: 29500, tip_cents: 0, expires_at: "2026-11-17T16:00:00.000Z", status: "open", dry: true, sid }));
      const forged = await t.portal(`/api/portal/dry-checkout/${sid}`, { method: "POST", headers: PJSON, body: { action: "pay", method: "card" } });
      assert.equal(forged.status, 409);
      assert.equal(forged.body.error.code, "not_sandboxed");
    }
    // Rotor's own invoice is read here and changed in Rotor: every button is off and every route says so
    const seen = await t.api(`/invoices/${imp.id}`, { as: owner });
    assert.equal(seen.body.data.rotor_owned, true);
    assert.deepEqual(Object.values(seen.body.data.can), new Array(Object.keys(seen.body.data.can).length).fill(false));
    for (const [path, body] of [["payments", { method: "cash", amount_cents: 29500, client_id: uuid(1) }], ["send", { channels: ["sms"] }], ["void", { reason: "Paid in Rotor" }], ["write-off", {}], ["charge", {}], ["issue", {}]]) {
      const r = await t.api(`/invoices/${imp.id}/${path}`, { method: "POST", as: owner, body });
      assert.equal(r.status, 409, path);
      assert.match(r.body.error.message, /still Rotor's until the switch/, path);
    }
    assert.equal((await t.api(`/invoices/${imp.id}`, { method: "PATCH", as: owner, ifMatch: seen.body.data.etag, body: { office_note: "x" } })).status, 409);
    assert.equal((await invoiceOf(imp.id)).wv, imp.wv, "untouched");
    // the one the office typed in is theirs: cash can be written down on it, but its card button is off
    const mine = await t.api(`/invoices/${typed.id}`, { as: owner });
    assert.deepEqual([mine.body.data.rotor_owned, mine.body.data.can.record, mine.body.data.can.charge, mine.body.data.can.card_link], [false, true, false, false]);
    // no card charge either, by a person's tap or the worker; a card can't be added online
    await saveCard(c);
    const run = await t.api(`/invoices/${typed.id}/charge`, { method: "POST", as: owner, body: {} });
    assert.equal(run.status, 202);
    await drain(t);
    const res = (await t.api(`/runs/${run.body.data.run_id}`, { as: owner })).body.data;
    assert.equal(res.result.status, "would_charge");
    const direct = await scope(() => CH.chargeInvoice(imp.id, { origin: "retry", by: "system:retry" }, AUTOMATION));
    assert.equal(direct.result, "would_charge");
    const card = await portalCookie(t, c.id, { kind: "card" });
    assert.equal((await t.portal("/api/portal/card/checkout", { method: "POST", headers: PJSON, cookie: card, body: {} })).status, 409);
    assert.equal(recs(t, "payment").length, 0);
    assert.equal(outbox(t, "checkout").length + outbox(t, "charge").length + outbox(t, "setup").length, 0, "nothing reached even the practice driver");
    assert.deepEqual((await invoiceOf(imp.id)).applied || {}, {});
    assert.equal((await invoiceOf(imp.id)).charging, undefined);
    // the rule, plainly
    assert.equal(await scope(() => GATE.mayMoveMoney(imp, { sor: "rotor" })), false);
    assert.equal(await scope(() => GATE.mayMoveMoney(typed, { sor: "rotor" })), false);
    assert.equal(await scope(() => GATE.mayMoveMoney(imp, { sor: "crm" })), true, "after the switch the CRM bills everyone");
    // the practice driver itself refuses a call that doesn't say its subject is sandboxed
    const { dryRun } = await import("../../../netlify/lib/crm/adapters/dry-run.mjs");
    await assert.rejects(() => scope(() => dryRun.payments.chargeSaved({ payment_method_id: "dry_pm_card", amount_cents: 100 })), /only touches test contacts/);
  } finally { t.done(); }
});

test("a test contact goes all the way through: the page says test mode, a card payment with a tip, a decline, cancel; none of it counts as revenue", async () => {
  const { t, owner } = await setup();
  try {
    const c = await testContact(owner);
    const made = await customer(owner);                         // a contact typed into the CRM (never in Rotor) is sandboxed too
    assert.equal(await scope(() => GATE.mayMoveMoney(made, { sor: "rotor" })), true);
    const inv = await openInvoice(t, owner, c);
    const cookie = await portalCookie(t, c.id, { kind: "invoice", id: inv.id });
    const page = await t.portal(`/p/invoice/${inv.id}`, { cookie, headers: { "user-agent": IPHONE } });
    assert.match(page.text, /Test mode: nothing is really charged/);
    assert.match(page.text, /data-pay-btn/);
    assert.match(page.text, /name="tip_choice" value="15"/);
    assert.match(page.text, /money-invoice\.js/);
    assert.doesNotMatch(page.text, /<script(?![^>]*\bsrc=)[^>]*>/i, "no inline script");
    const co = await t.portal(`/api/portal/invoices/${inv.id}/checkout`, { method: "POST", headers: PJSON, cookie, body: { tip_choice: "20" } });
    assert.equal(co.status, 200, JSON.stringify(co.body));
    assert.match(co.body.data.url, /^\/p\/dry-checkout\/dry_cs_[0-9a-f]{24}$/);
    assert.equal(co.body.data.tip_cents, 5900);
    const sid = co.body.data.url.split("/").pop();
    const dry = await t.portal(co.body.data.url, { headers: { "user-agent": IPHONE } });
    assert.equal(dry.status, 200);
    assert.match(dry.text, /Test checkout\. This stands in for Stripe/);
    assert.match(dry.text, /\$354\.00/);
    // declined: the customer sees why and can try again; nothing is recorded
    const no = await t.portal(`/api/portal/dry-checkout/${sid}`, { method: "POST", headers: PJSON, body: { action: "decline" } });
    assert.equal(no.status, 409);
    assert.equal(no.body.error.code, "card_declined");
    assert.equal(recs(t, "payment").length, 0);
    // cancel goes back to the invoice
    const back = await t.portal(`/api/portal/dry-checkout/${sid}`, { method: "POST", headers: PJSON, body: { action: "cancel" } });
    assert.equal(back.body.data.location, `/p/invoice/${inv.id}`);
    // pay
    const ok = await t.portal(`/api/portal/dry-checkout/${sid}`, { method: "POST", headers: PJSON, body: { action: "pay", method: "card" } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const ret = await t.portal(ok.body.data.location, { cookie, headers: { "user-agent": IPHONE } });
    assert.match(ret.text, /Paid\. Thank you!/);
    const p = recs(t, "payment")[0];
    assert.deepEqual([p.status, p.simulated, p.amount_cents, p.tip_cents, p.card.last4], ["succeeded", true, 29500, 5900, "4242"]);
    assert.equal((await invoiceOf(inv.id)).status, "paid");
    // tapping Pay again on the finished Checkout goes to the same place and pays nothing more
    const twice = await t.portal(`/api/portal/dry-checkout/${sid}`, { method: "POST", headers: PJSON, body: { action: "pay", method: "card" } });
    assert.equal(twice.body.data.location, ok.body.data.location);
    assert.equal(recs(t, "payment").length, 1);
    await drain(t);
    assert.equal(texts(t, "payment_receipt").length, 1);
    const paid = await t.portal(`/p/invoice/${inv.id}`, { cookie, headers: { "user-agent": IPHONE } });
    assert.match(paid.text, /Paid in full/);
    assert.match(paid.text, new RegExp(`/p/invoice/${inv.id}/receipt/${p.id}`));
    const receipt = await t.portal(`/p/invoice/${inv.id}/receipt/${p.id}`, { cookie, headers: { "user-agent": IPHONE } });
    assert.match(receipt.text, /Tip for the crew<\/dt><dd>\$59\.00/);
    // practice money is listed, marked, and never counted
    const sum = (await t.api("/money/summary", { as: owner })).body.data;
    assert.deepEqual([sum.revenue_cents, sum.tips_cents, sum.payments], [0, 0, 0]);
    const list = await t.api("/payments?month=2026-11", { as: owner });
    assert.equal(list.body.data.length, 1);
    assert.ok(list.body.data[0].sim, "marked as practice");
    assert.deepEqual([list.body.meta.totals.collected_cents, list.body.meta.totals.simulated], [0, 1]);
    assert.equal(t.fetchCalls().length, 0, "nothing left the process");
  } finally { t.done(); }
});

test("the mode: dry run by default; a wish for live while Rotor is in charge stays dry run and says why; Settings refuses to switch", async () => {
  const { t, owner, admin } = await setup();
  try {
    const st = await t.api("/money/status", { as: owner });
    assert.equal(st.status, 200);
    assert.deepEqual([st.body.data.mode, st.body.data.wanted, st.body.data.refused, st.body.data.system_of_record], ["dry_run", "dry_run", null, "rotor"]);
    assert.equal((await t.api("/money/status", { as: admin })).status, 403, "owners only");
    const live = await t.api("/money/payments-mode", { method: "POST", as: owner, body: { mode: "live" } });
    assert.equal(live.status, 409);
    assert.match(live.body.error.message, /Live payments wait for the switch from Rotor/);
    const test = await t.api("/money/payments-mode", { method: "POST", as: owner, body: { mode: "test" } });
    assert.equal(test.status, 409);
    assert.match(test.body.error.message, /no test Stripe key yet/);
    assert.equal((await t.api("/money/payments-mode", { method: "POST", as: owner, body: { mode: "everything" } })).status, 400);
    // the pure rule, every case (key values are made up and never real)
    const liveKey = "sk_" + "live_" + "x".repeat(24), testKey = "sk_" + "test_" + "y".repeat(24), prod = (await import("../../../netlify/lib/crm/core/context.mjs")).deployContext(null, {}, { CRM_PRODUCTION: "1" });
    const r = (want, sor, env) => GATE.resolvePayments({ deploy: prod, settings: { payments: { mode: want } }, mode: { system_of_record: sor }, env });
    assert.deepEqual([r("dry_run", "rotor", { STRIPE_SECRET_KEY: liveKey, STRIPE_TEST_SECRET_KEY: testKey }).mode], ["dry_run"], "keys alone change nothing");
    assert.deepEqual((({ mode, refused }) => [mode, refused])(r("live", "rotor", { STRIPE_SECRET_KEY: liveKey })), ["dry_run", "live_waits_for_cutover"]);
    assert.deepEqual((({ mode, refused }) => [mode, refused])(r("live", "rotor", { STRIPE_SECRET_KEY: liveKey, STRIPE_TEST_SECRET_KEY: testKey })), ["dry_run", "live_waits_for_cutover"], "never quietly turned into test");
    assert.deepEqual((({ mode, refused }) => [mode, refused])(r("test", "rotor", { STRIPE_TEST_SECRET_KEY: testKey })), ["test", null]);
    assert.deepEqual((({ mode, refused }) => [mode, refused])(r("test", "rotor", { STRIPE_TEST_SECRET_KEY: liveKey })), ["dry_run", "live_key_in_test_slot"], "a live key in the test slot is never used");
    assert.deepEqual((({ mode, refused }) => [mode, refused])(r("test", "rotor", {})), ["dry_run", "test_key_missing"]);
    assert.deepEqual((({ mode, refused }) => [mode, refused])(r("live", "crm", { STRIPE_SECRET_KEY: liveKey })), ["live", null]);
    assert.deepEqual((({ mode, refused }) => [mode, refused])(r("live", "crm", { STRIPE_SECRET_KEY: testKey })), ["dry_run", "test_key_in_live_slot"]);
    const preview = GATE.resolvePayments({ deploy: (await import("../../../netlify/lib/crm/core/context.mjs")).deployContext(null, {}, {}), settings: { payments: { mode: "test" } }, mode: { system_of_record: "rotor" }, env: { STRIPE_TEST_SECRET_KEY: testKey } });
    assert.deepEqual([preview.mode, preview.refused], ["dry_run", "not_production"], "a preview or a local copy never reaches Stripe");
    assert.equal(r("off", "crm", { STRIPE_SECRET_KEY: liveKey }).mode, "off");
  } finally { t.done(); }
});
