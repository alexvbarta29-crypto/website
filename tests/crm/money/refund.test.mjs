// Refunds (design §5.6 "Refunds"; §11.4 M5 refund.test.mjs): two owners
// refunding together never exceed amount + tip; the same request twice is
// one refund; the invoice reopens; a refund is the invoice amount first,
// then the tip (split back across the same techs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, testContact, importedCustomer, jobInvoice, openInvoice, invoiceOf, paymentOf, recs, outbox, drain, scope, store, uuid, portalCookie, PJSON, U, IMPORT } from "./fixtures.mjs";

const refund = (t, as, paymentId, amount, n, reason = "They were double charged") => t.api(`/payments/${paymentId}/refund`, { method: "POST", as, body: { amount_cents: amount, reason, client_id: uuid(n) } });

test("two owners refunding the same payment at once: the total never passes amount + tip", async () => {
  const { t, owner, owner2, admin, tech, tech2 } = await setup();
  try {
    const c = await testContact(owner);
    const { invoice } = await jobInvoice(t, owner, c, { techs: [tech, tech2] });
    const paid = await t.api(`/invoices/${invoice.id}/payments`, { method: "POST", as: owner, body: { method: "cash", amount_cents: 29500, tip_cents: 3000, client_id: uuid(1) } });
    assert.equal(paid.status, 201);
    const pid = paid.body.data.payment.id;
    assert.equal(paid.body.data.invoice.status, "paid");
    // $200 each, together: only one fits under $325
    const [a, b] = await Promise.all([refund(t, owner, pid, 20000, 11), refund(t, owner2, pid, 20000, 12)]);
    assert.deepEqual([a.status, b.status].sort(), [201, 409], JSON.stringify([a.body, b.body]));
    const lost = a.status === 409 ? a : b;
    assert.match(lost.body.error.message, /more than is left to refund/);
    let p = await paymentOf(pid);
    assert.equal(p.refunded_cents, 20000);
    // the rest, to the cent: the invoice amount first ($95 left of it), then the tip ($30)
    const rest = await refund(t, owner2, pid, 12500, 13);
    assert.equal(rest.status, 201, JSON.stringify(rest.body));
    assert.deepEqual([rest.body.data.refund.amount_cents, rest.body.data.refund.tip_cents], [9500, 3000]);
    assert.deepEqual(rest.body.data.refund.tip_split.map((x) => x.cents), [1500, 1500], "the tip comes back off the same techs");
    assert.deepEqual(rest.body.data.refund.tip_split.map((x) => x.user_id).sort(), [tech.id, tech2.id].sort());
    // nothing is left: one more cent is refused
    const over = await refund(t, owner, pid, 1, 14);
    assert.equal(over.status, 409);
    p = await paymentOf(pid);
    assert.equal(p.refunded_cents, 32500);
    assert.equal(p.refunded_tip_cents, 3000);
    const refunds = recs(t, "payment").filter((x) => x.kind === "refund");
    assert.equal(refunds.length, 2);
    assert.equal(refunds.reduce((s, x) => s + x.amount_cents + x.tip_cents, 0), 32500);
    // the invoice is open again, owing all of it
    const inv = await invoiceOf(invoice.id);
    assert.deepEqual([inv.status, inv.paid_cents, inv.refunded_cents, inv.balance_cents, inv.tips_cents], ["open", 29500, 29500, 29500, 0]);
    // owners only
    assert.equal((await refund(t, admin, pid, 100, 15)).status, 403);
    assert.equal((await refund(t, tech, pid, 100, 16)).status, 403);
  } finally { t.done(); }
});

test("the same request twice is one refund; a card payment made in practice mode goes back through the practice driver", async () => {
  const { t, owner } = await setup();
  try {
    const c = await testContact(owner);
    const inv = await openInvoice(t, owner, c);
    const cookie = await portalCookie(t, c.id, { kind: "invoice", id: inv.id });
    const co = await t.portal(`/api/portal/invoices/${inv.id}/checkout`, { method: "POST", headers: PJSON, cookie, body: { tip_choice: "10" } });
    assert.equal(co.status, 200, JSON.stringify(co.body));
    const sid = co.body.data.url.split("/").pop();
    const done = await t.portal(`/api/portal/dry-checkout/${sid}`, { method: "POST", headers: PJSON, body: { action: "pay", method: "card" } });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const p = recs(t, "payment")[0];
    assert.deepEqual([p.status, p.simulated, p.amount_cents, p.tip_cents], ["succeeded", true, 29500, 2950]);
    // the owner taps Refund, the answer is lost, the app sends the same request again
    const first = await refund(t, owner, p.id, 10000, 21);
    const again = await refund(t, owner, p.id, 10000, 21);
    assert.equal(first.status, 201);
    assert.equal(again.status, 201);
    assert.equal(again.body.data.refund.id, first.body.data.refund.id);
    assert.equal(recs(t, "payment").filter((x) => x.kind === "refund").length, 1);
    assert.equal(outbox(t, "refund").length, 1, "one refund reached the (practice) driver");
    assert.equal(first.body.data.refund.simulated, true);
    assert.equal(first.body.data.refund.refund_of, p.id);
    assert.equal((await paymentOf(p.id)).refunded_cents, 10000);
    const now = await invoiceOf(inv.id);
    assert.deepEqual([now.status, now.balance_cents], ["open", 10000]);
    // what a refund needs
    assert.equal((await t.api(`/payments/${p.id}/refund`, { method: "POST", as: owner, body: { amount_cents: 100, client_id: uuid(22) } })).status, 400, "a reason");
    assert.equal((await t.api(`/payments/${p.id}/refund`, { method: "POST", as: owner, body: { amount_cents: 0, reason: "why", client_id: uuid(23) } })).status, 400, "an amount");
    assert.equal((await t.api(`/payments/${p.id}/refund`, { method: "POST", as: owner, body: { amount_cents: 100, reason: "why" } })).status, 400, "its request id");
    await drain(t);
  } finally { t.done(); }
});

test("a refund Stripe reports (charge.refunded) and the owner's own request are the same row; a card payment Rotor made is refunded in Rotor", async () => {
  const { t, owner } = await setup();
  try {
    const RF = await import("../../../netlify/lib/crm/modules/money/refunds.mjs");
    const CO = await import("../../../netlify/lib/crm/modules/money/checkout.mjs");
    const { piObject, HOOK } = await import("./fixtures.mjs");
    const c = await testContact(owner);
    const inv = await openInvoice(t, owner, c);
    const out = await scope(() => CO.applyPaymentIntent(piObject("pi_refund_1", inv, { tip: 1000 }), HOOK));
    const pay = out.payment;
    // a refund made in Stripe's dashboard arrives as charge.refunded, twice
    const re = { id: "re_test_1", amount: 5000, status: "succeeded", reason: "requested_by_customer" };
    const r1 = await scope(async () => RF.applyStripeRefund(re, (await store.getRecord("payment", pay.id)).data, HOOK));
    const r2 = await scope(async () => RF.applyStripeRefund(re, (await store.getRecord("payment", pay.id)).data, HOOK));
    assert.equal(r1.payment.id, U.payId.re("re_test_1"));
    assert.equal(r2.payment.id, r1.payment.id);
    assert.equal(r2.created, false);
    assert.equal((await paymentOf(pay.id)).refunded_cents, 5000);
    // one bigger than what is left is not applied (and says so in the log)
    const big = await scope(async () => RF.applyStripeRefund({ id: "re_test_2", amount: 99999, status: "succeeded" }, (await store.getRecord("payment", pay.id)).data, HOOK));
    assert.equal(big, null);
    assert.equal(recs(t, "payment").filter((x) => x.kind === "refund").length, 1);
    // a real card payment while payments are in dry run can't be sent back from here: nothing is reserved for good
    const no = await refund(t, owner, pay.id, 1000, 31);
    assert.equal(no.status, 409);
    assert.match(no.body.error.message, /aren't connected right now/);
    assert.equal((await paymentOf(pay.id)).refunded_cents, 5000, "the failed try released its reservation");
    // Rotor's own card payment (imported): refunded in Rotor, never from here
    const rc = await importedCustomer();
    const imported = await scope(() => store.createRecord("payment", { id: U.payId.client(uuid(900)), contact_id: rc.id, kind: "payment", method: "card", status: "succeeded", amount_cents: 20000, tip_cents: 0, received_on: "2026-10-01", import: { run_id: "ir_00000000000000000001", at: "2026-11-08T00:00:00.000Z", hash: "1".repeat(64) } }, IMPORT));
    const ro = await refund(t, owner, imported.data.id, 1000, 32);
    assert.equal(ro.status, 409);
    assert.match(ro.body.error.message, /made in Rotor\. Refund it there/);
  } finally { t.done(); }
});
