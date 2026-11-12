// Bank payments (design §5.6 "ACH", D32; §11.4 M5 ach.test.mjs): a bank
// payment is "processing" for days: it blocks charges and new Checkouts and
// sends no receipt; when it clears the invoice is paid and the receipt goes
// once; when it fails the invoice reopens and the customer is told.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, testContact, openInvoice, invoiceOf, paymentOf, recs, texts, drain, advance, minutes, scope, saveCard, portalCookie, PJSON, IPHONE, B, CH, CARDS, AUTOMATION } from "./fixtures.mjs";

async function payByBank(t, c, inv, method) {
  const cookie = await portalCookie(t, c.id, { kind: "invoice", id: inv.id });
  const co = await t.portal(`/api/portal/invoices/${inv.id}/checkout`, { method: "POST", headers: PJSON, cookie, body: { tip_choice: "0" } });
  assert.equal(co.status, 200, JSON.stringify(co.body));
  const sid = co.body.data.url.split("/").pop();
  const page = await t.portal(`/p/dry-checkout/${sid}`, { headers: { "user-agent": IPHONE } });
  assert.match(page.text, /data-method="ach"/, "the practice Checkout offers a bank account beside the card (D32)");
  const done = await t.portal(`/api/portal/dry-checkout/${sid}`, { method: "POST", headers: PJSON, body: { action: "pay", method } });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  return { cookie, sid, back: done.body.data.location };
}

test("a bank payment that clears: processing blocks a charge and a second Checkout and sends no receipt; then it succeeds, once", async () => {
  const { t, owner } = await setup();
  try {
    const c = await testContact(owner);
    await saveCard(c);
    const inv = await openInvoice(t, owner, c);
    const { cookie, back } = await payByBank(t, c, inv, "ach");
    let p = recs(t, "payment")[0];
    assert.deepEqual([p.status, p.method, p.simulated, p.amount_cents], ["processing", "ach", true, 29500]);
    assert.match(p.stripe.payment_method_id, /^dry_pm_ach_/);
    let now = await invoiceOf(inv.id);
    assert.deepEqual([now.status, now.paid_cents, now.balance_cents], ["open", 0, 29500], "only money that arrived counts");
    assert.equal(B.isProcessing(now), true);
    // the customer's pages say so
    const ret = await t.portal(back, { cookie, headers: { "user-agent": IPHONE } });
    assert.match(ret.text, /Your bank payment is on its way/);
    const page = await t.portal(`/p/invoice/${inv.id}`, { cookie, headers: { "user-agent": IPHONE } });
    assert.match(page.text, /A bank payment is on its way for this invoice/);
    assert.doesNotMatch(page.text, /data-pay-btn/);
    // no second Checkout, no charge of the card on file, by a person or by the worker
    const again = await t.portal(`/api/portal/invoices/${inv.id}/checkout`, { method: "POST", headers: PJSON, cookie, body: { tip_choice: "0" } });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, "processing");
    const charge = await t.api(`/invoices/${inv.id}/charge`, { method: "POST", as: owner, body: {} });
    assert.equal(charge.status, 409);
    assert.match(charge.body.error.message, /bank payment is still clearing/);
    const direct = await scope(() => CH.chargeInvoice(inv.id, { origin: "retry", by: "system:retry" }, AUTOMATION));
    assert.deepEqual([direct.result, direct.code], ["refused", "processing"]);
    assert.equal((await t.api(`/invoices/${inv.id}`, { as: owner })).body.data.can.charge, false);
    // the worker passes while it clears: nothing is sent, no reminder either
    await drain(t);
    assert.equal(texts(t, "payment_receipt").length, 0, "no receipt for money that hasn't arrived");
    assert.equal((await paymentOf(p.id)).status, "processing");
    // it clears (the practice driver settles on the pass after the next)
    advance(minutes(2));
    await drain(t);
    p = await paymentOf(p.id);
    assert.equal(p.status, "succeeded");
    now = await invoiceOf(inv.id);
    assert.deepEqual([now.status, now.paid_cents, now.balance_cents], ["paid", 29500, 0]);
    assert.equal(texts(t, "payment_receipt").length, 1);
    await drain(t);
    assert.equal(texts(t, "payment_receipt").length, 1);
    assert.equal(recs(t, "payment").length, 1);
  } finally { t.done(); }
});

test("a bank payment that fails: the invoice is open again with its whole balance, the customer gets the card link, the bank account is marked failed", async () => {
  const { t, owner } = await setup();
  try {
    const c = await testContact(owner);
    const inv = await openInvoice(t, owner, c);
    const cookie = await portalCookie(t, c.id, { kind: "invoice", id: inv.id });
    const co = await t.portal(`/api/portal/invoices/${inv.id}/checkout`, { method: "POST", headers: PJSON, cookie, body: { tip_choice: "10", save_card: true } });
    const sid = co.body.data.url.split("/").pop();
    const done = await t.portal(`/api/portal/dry-checkout/${sid}`, { method: "POST", headers: PJSON, body: { action: "pay", method: "ach_fail" } });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const p = recs(t, "payment")[0];
    assert.deepEqual([p.status, p.tip_cents], ["processing", 2950]);
    assert.equal((await scope(() => CARDS.cardStatus(c.id))).pm.kind, "us_bank_account", "the bank account they chose to save is on file");
    await drain(t);
    assert.equal(texts(t, "payment_failed").length, 0);
    advance(minutes(2));
    await drain(t);
    const failed = await paymentOf(p.id);
    assert.deepEqual([failed.status, failed.failure_code], ["failed", "ach_debit_failed"]);
    const now = await invoiceOf(inv.id);
    assert.deepEqual([now.status, now.paid_cents, now.tips_cents, now.balance_cents], ["open", 0, 0, 29500]);
    assert.equal(B.isProcessing(now), false);
    assert.equal(texts(t, "payment_receipt").length, 0);
    assert.equal(texts(t, "payment_failed").length, 1, "payment.failed ran");
    assert.match(texts(t, "payment_failed")[0].body, /didn't go through for invoice SINV-0001 \(\$295\.00\)/);
    assert.equal((await scope(() => CARDS.cardStatus(c.id))).status, "failed");
    // they can pay again now
    const again = await t.portal(`/api/portal/invoices/${inv.id}/checkout`, { method: "POST", headers: PJSON, cookie, body: { tip_choice: "0" } });
    assert.equal(again.status, 200);
    // a second pass changes nothing
    advance(minutes(2));
    await drain(t);
    assert.equal(texts(t, "payment_failed").length, 1);
    assert.equal((await paymentOf(p.id)).status, "failed");
  } finally { t.done(); }
});

test("a saved bank account charged off-session (autopay): processing first, the lock off, then settled on a later pass", async () => {
  const { t, owner } = await setup();
  try {
    const c = await testContact(owner);
    await saveCard(c, "dry_pm_ach");
    const inv = await openInvoice(t, owner, c);
    const out = await scope(() => CH.chargeInvoice(inv.id, { origin: "autopay", by: "system:autopay" }, AUTOMATION));
    assert.equal(out.result, "processing");
    let now = await invoiceOf(inv.id);
    assert.equal(now.charging, undefined);
    assert.equal(B.isProcessing(now), true);
    assert.deepEqual(now.autopay.attempts.map((a) => a.result), ["processing"]);
    assert.equal((await paymentOf(out.payment_id)).method, "ach");
    advance(minutes(2));
    await drain(t);
    now = await invoiceOf(inv.id);
    assert.equal(now.status, "paid");
    assert.equal(texts(t, "payment_receipt").length, 1);
  } finally { t.done(); }
});
