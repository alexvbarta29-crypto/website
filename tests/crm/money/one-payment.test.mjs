// One payment, one record (design §5.6; §11.4 M5 one-payment.test.mjs): the
// synchronous charge result, payment_intent.succeeded and
// checkout.session.completed for one PaymentIntent make one payment record,
// one receipt and one tip line, in whatever order and however often they
// arrive.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, testContact, jobInvoice, invoiceOf, paymentOf, recs, texts, outbox, drain, scope, saveCard, piObject, sessionObject, U, CO, CH, HOOK, AUTOMATION, B } from "./fixtures.mjs";

test("a Checkout payment with a tip: the session, the PaymentIntent event and a late repeat land on one record; one receipt; the tip split once", async () => {
  const { t, owner, tech, tech2 } = await setup();
  try {
    const c = await testContact(owner);
    const { invoice } = await jobInvoice(t, owner, c, { techs: [tech, tech2] });
    assert.equal(invoice.status, "open");
    assert.equal(invoice.balance_cents, 29500);
    const tip = B.computeTip(29500, "10", undefined, {}).tip_cents;
    assert.equal(tip, 2950);
    const pi = piObject("pi_test_one", invoice, { tip });
    const cs = sessionObject("cs_test_one", invoice, pi, { tip });
    // the three paths at once (the webhook's two events and the return page's own re-fetch)
    const outs = await Promise.all([
      scope(() => CO.applyCheckoutSession(cs, HOOK)),
      scope(() => CO.applyPaymentIntent(pi, HOOK)),
      scope(() => CO.applyCheckoutSession(cs, HOOK)),
    ]);
    assert.equal(outs.filter((o) => o.created).length, 1, "one path made the record; the others found it");
    assert.equal(outs.filter((o) => o.transitioned === "succeeded").length, 1, "one path moved it to succeeded");
    // ... and Stripe sends the event again the next day
    const late = await scope(() => CO.applyPaymentIntent(pi, HOOK));
    assert.equal(late.created, false);
    assert.equal(late.transitioned, null);

    const pays = recs(t, "payment");
    assert.equal(pays.length, 1);
    const p = pays[0];
    assert.equal(p.id, U.payId.pi("pi_test_one"));
    assert.deepEqual([p.status, p.method, p.amount_cents, p.tip_cents, p.total_cents, p.fee_cents], ["succeeded", "card", 29500, 2950, 32450, 886]);
    assert.equal(p.stripe.checkout_session_id, "cs_test_one");
    // the tip: one line per tech on the visit, split evenly, on the one record
    assert.deepEqual(p.tip_split.map((x) => x.user_id).sort(), [tech.id, tech2.id].sort());
    assert.deepEqual(p.tip_split.map((x) => x.cents), [1475, 1475]);
    const inv = await invoiceOf(invoice.id);
    assert.deepEqual(Object.keys(inv.applied), [p.id]);
    assert.deepEqual([inv.status, inv.paid_cents, inv.tips_cents, inv.balance_cents, inv.excess_cents], ["paid", 29500, 2950, 0, 0]);

    await drain(t);
    assert.equal(texts(t, "payment_receipt").length, 1, "one receipt text");
    assert.equal(outbox(t, "email").filter((o) => o.template_key === "payment_receipt_email").length, 1, "one receipt email");
    assert.match(texts(t, "payment_receipt")[0].body, /We got your payment for invoice SINV-0001/);
    // one marker per channel for this payment: the receipt can't go twice
    assert.deepEqual(t.stores.data.keys("done-dry/payment.receipt/").map((k) => k.split("/").pop()).sort(), [p.id, `${p.id}--email`].sort());
    // a later pass sends nothing more
    await drain(t);
    assert.equal(texts(t, "payment_receipt").length, 1);
  } finally { t.done(); }
});

test("an off-session charge: the charge's own answer and payment_intent.succeeded for the same PaymentIntent are one payment and one receipt", async () => {
  const { t, owner, tech } = await setup();
  try {
    const c = await testContact(owner);
    await saveCard(c);
    const { invoice } = await jobInvoice(t, owner, c, { techs: [tech] });
    const out = await scope(() => CH.chargeInvoice(invoice.id, { origin: "staff", by: owner.id }, AUTOMATION));
    assert.equal(out.result, "succeeded");
    const p = await paymentOf(out.payment_id);
    assert.equal(p.simulated, true);
    assert.equal(p.stripe.attempt_id, out.attempt_id);
    // the webhook's event for the very same PaymentIntent, and once more
    const pi = { ...piObject(p.stripe.payment_intent_id, invoice, { amount: 29500, attempt: out.attempt_id }), payment_method: { id: "dry_pm_card_ok", type: "card", card: { brand: "visa", last4: "4242" } } };
    const again = await scope(() => CO.applyPaymentIntent(pi, HOOK));
    assert.equal(again.created, false);
    assert.equal(again.transitioned, null);
    assert.equal(again.payment.id, p.id);
    assert.equal(again.payment.fee_cents, 886, "the later path only fills in what the first didn't know (the fee)");
    // the same attempt started twice (a double tap, a resumed worker) is the same charge
    const twice = await scope(() => CH.chargeInvoice(invoice.id, { origin: "staff", by: owner.id, n: 1 }, AUTOMATION));
    assert.equal(twice.payment_id, p.id);
    assert.equal(recs(t, "payment").length, 1);
    assert.equal(outbox(t, "charge").length, 1, "one charge reached the (dry-run) driver");
    const inv = await invoiceOf(invoice.id);
    assert.equal(inv.status, "paid");
    assert.equal(inv.charging, undefined, "the lock is off");
    assert.deepEqual(inv.autopay.attempts.map((a) => [a.n, a.result]), [[1, "succeeded"]]);
    await drain(t);
    assert.equal(texts(t, "payment_receipt").length, 1);
  } finally { t.done(); }
});
