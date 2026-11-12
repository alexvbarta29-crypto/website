// Events out of order (design §5.6, §6.2; §11.4 M5 order.test.mjs): what is
// applied is the object's state as re-fetched, never what an old event
// said, and a terminal status never moves back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, testContact, openInvoice, invoiceOf, paymentOf, recs, texts, drain, scope, piObject, U, CO, B, HOOK } from "./fixtures.mjs";
const WH = await import("../../../netlify/lib/crm/modules/money/webhook.mjs");

test("succeeded then a late processing: the payment stays succeeded, the invoice stays paid, nothing fires twice", async () => {
  const { t, owner } = await setup();
  try {
    const c = await testContact(owner);
    const inv = await openInvoice(t, owner, c);
    const ok = await scope(() => CO.applyPaymentIntent(piObject("pi_order_1", inv), HOOK));
    assert.equal(ok.transitioned, "succeeded");
    // payment_intent.processing arrives after payment_intent.succeeded, carrying its old snapshot
    const late = await scope(() => CO.applyPaymentIntent(piObject("pi_order_1", inv, { status: "processing" }), HOOK));
    assert.equal(late.transitioned, null);
    assert.equal(late.payment.status, "succeeded");
    // ... and a stale "failed" for the same intent changes nothing either
    const stale = await scope(() => CO.applyPaymentIntent({ ...piObject("pi_order_1", inv, { status: "requires_payment_method" }), last_payment_error: { code: "card_declined" } }, HOOK));
    assert.equal(stale.payment.status, "succeeded");
    assert.equal(stale.payment.failure_code, undefined);
    const now = await invoiceOf(inv.id);
    assert.equal(now.status, "paid");
    assert.equal(now.applied[U.payId.pi("pi_order_1")].status, "succeeded");
    await drain(t);
    assert.equal(texts(t, "payment_receipt").length, 1);
    assert.equal(texts(t, "payment_failed").length, 0);
  } finally { t.done(); }
});

test("the webhook applies the re-fetched object: an old event about an intent that has since succeeded lands as succeeded", async () => {
  const { t, owner } = await setup();
  try {
    const c = await testContact(owner);
    const inv = await openInvoice(t, owner, c);
    const asked = [];
    // the driver's retrieve answers with the object as it is NOW
    const impl = { retrieve: async (kind, id) => { asked.push(`${kind}:${id}`); return piObject(id, inv, { status: "succeeded" }); } };
    const event = { id: "evt_old", type: "payment_intent.processing", data: { object: piObject("pi_order_2", inv, { status: "processing" }) } };
    const own = await scope(() => WH.ownership(event, { sor: "rotor" }));
    assert.equal(own.ours, true);
    const out = await scope(() => WH.applyEvent(event, impl, HOOK, own));
    assert.deepEqual(asked, ["payment_intent:pi_order_2"]);
    assert.equal(out.payment.status, "succeeded");
    assert.equal((await invoiceOf(inv.id)).status, "paid");
  } finally { t.done(); }
});

test("forward only: pending → processing → succeeded; failed and canceled are final; the invoice's entry follows the same rule", async () => {
  const { t, owner } = await setup();
  try {
    assert.equal(B.forward("pending", "processing"), "processing");
    assert.equal(B.forward("processing", "pending"), "processing");
    assert.equal(B.forward("processing", "succeeded"), "succeeded");
    assert.equal(B.forward("processing", "failed"), "failed");
    for (const end of ["succeeded", "failed", "canceled"]) for (const next of ["pending", "processing", "succeeded", "failed", "canceled"]) assert.equal(B.forward(end, next), end, `${end} never becomes ${next}`);
    const c = await testContact(owner);
    const inv = await openInvoice(t, owner, c);
    // a bank payment: processing, then it fails; a late "succeeded" snapshot can't revive it
    await scope(() => CO.applyPaymentIntent({ ...piObject("pi_order_3", inv, { status: "processing" }), payment_method: { id: "pm_bank", type: "us_bank_account", us_bank_account: { bank_name: "Test Bank", last4: "6789" } } }, HOOK));
    assert.equal(B.isProcessing(await invoiceOf(inv.id)), true);
    const failed = await scope(() => CO.applyPaymentIntent({ ...piObject("pi_order_3", inv, { status: "requires_payment_method" }), last_payment_error: { code: "ach_debit_failed" } }, HOOK));
    assert.equal(failed.transitioned, "failed");
    const zombie = await scope(() => CO.applyPaymentIntent(piObject("pi_order_3", inv, { status: "succeeded" }), HOOK));
    assert.equal(zombie.payment.status, "failed");
    assert.equal(zombie.transitioned, null);
    const now = await invoiceOf(inv.id);
    assert.deepEqual([now.status, now.paid_cents, now.balance_cents], ["open", 0, 29500]);
    assert.equal(now.applied[U.payId.pi("pi_order_3")].status, "failed");
    assert.equal((await paymentOf(U.payId.pi("pi_order_3"))).method, "ach");
    assert.equal(recs(t, "payment").length, 1);
  } finally { t.done(); }
});
