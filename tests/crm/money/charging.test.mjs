// The charging lock (design §5.6 "Off-session charge"; §11.4 M5
// charging.test.mjs): a charge first expires the open Checkout Sessions of
// its invoice and blocks the portal's Pay while it runs; what it charges is
// the balance re-read after the lock, never the one it started with.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, testContact, openInvoice, invoiceOf, paymentOf, recs, outbox, scope, store, saveCard, portalCookie, PJSON, IPHONE, uuid, U, CO, CH, B, AS, AUTOMATION } from "./fixtures.mjs";

const checkout = (t, inv, cookie, body = { tip_choice: "0" }) => t.portal(`/api/portal/invoices/${inv.id}/checkout`, { method: "POST", headers: PJSON, cookie, body });
const lockNow = (inv, n = 1) => scope(() => store.updateRecord("invoice", inv.id, (x) => ({ ...x, charging: { by: "system", until: new Date(Date.parse("2026-11-17T15:00:00Z") + CH.LOCK_MS).toISOString(), attempt_id: U.attemptId(inv.id, n), n }, charge_n: n }), AUTOMATION));

test("a charge expires the customer's open Checkout first: the stale link can't be paid, and one payment is made", async () => {
  const { t, owner } = await setup();
  try {
    const c = await testContact(owner);
    await saveCard(c);
    const inv = await openInvoice(t, owner, c);
    const cookie = await portalCookie(t, c.id, { kind: "invoice", id: inv.id });
    // the customer taps Pay and leaves the Checkout page open
    const co = await checkout(t, inv, cookie, { tip_choice: "15" });
    assert.equal(co.status, 200, JSON.stringify(co.body));
    const sid = co.body.data.url.split("/").pop();
    assert.deepEqual((await invoiceOf(inv.id)).checkout_sessions.map((s) => [s.id, s.status]), [[sid, "open"]]);
    // meanwhile the office charges the card on file
    const out = await scope(() => CH.chargeInvoice(inv.id, { origin: "staff", by: owner.id }, AS(owner)));
    assert.equal(out.result, "succeeded");
    const now = await invoiceOf(inv.id);
    assert.deepEqual(now.checkout_sessions.map((s) => [s.id, s.status]), [[sid, "expired"]]);
    assert.equal((await scope(() => CO.readSession(sid))).status, "expired");
    assert.equal(now.status, "paid");
    // the customer comes back to the old Checkout page and taps Pay
    const late = await t.portal(`/api/portal/dry-checkout/${sid}`, { method: "POST", headers: PJSON, body: { action: "pay", method: "card" } });
    assert.equal(late.status, 409);
    assert.equal(late.body.error.code, "expired");
    const page = await t.portal(`/p/dry-checkout/${sid}`, { headers: { "user-agent": IPHONE } });
    assert.match(page.text, /This checkout is expired/);
    assert.equal(recs(t, "payment").length, 1, "one payment: the charge");
  } finally { t.done(); }
});

test("while the lock is live the portal's Pay answers 409, the page says why, and cash can't be recorded either", async () => {
  const { t, owner } = await setup();
  try {
    const c = await testContact(owner);
    await saveCard(c);
    const inv = await openInvoice(t, owner, c);
    const cookie = await portalCookie(t, c.id, { kind: "invoice", id: inv.id });
    await lockNow(inv);
    const co = await checkout(t, inv, cookie);
    assert.equal(co.status, 409);
    assert.equal(co.body.error.code, "charging");
    assert.equal(outbox(t, "checkout").length, 0, "no session was made");
    const page = await t.portal(`/p/invoice/${inv.id}`, { cookie, headers: { "user-agent": IPHONE } });
    assert.equal(page.status, 200);
    assert.match(page.text, /charging your card on file right now/);
    assert.doesNotMatch(page.text, /data-pay-btn/);
    const cash = await t.api(`/invoices/${inv.id}/payments`, { method: "POST", as: owner, body: { method: "cash", amount_cents: 5000, client_id: uuid(41) } });
    assert.equal(cash.status, 409);
    // a second charge can't start under a live lock (another attempt number)
    assert.equal(B.chargeRefusal(await invoiceOf(inv.id), Date.parse("2026-11-17T15:00:00Z")), "charging");
    const second = await t.api(`/invoices/${inv.id}/charge`, { method: "POST", as: owner, body: {} });
    assert.equal(second.status, 409);
    // a lock nobody finished runs out by itself after 10 minutes
    assert.equal(B.chargeRefusal(await invoiceOf(inv.id), Date.parse("2026-11-17T15:00:00Z") + CH.LOCK_MS + 1), null);
  } finally { t.done(); }
});

test("the charge is for the balance as it is after the lock: a payment that landed first is not charged again", async () => {
  const { t, owner } = await setup();
  try {
    const c = await testContact(owner);
    await saveCard(c);
    const inv = await openInvoice(t, owner, c);
    // the worker took the lock for attempt 1 and died before charging ...
    await lockNow(inv, 1);
    // ... and a $100 payment the bank had been clearing landed meanwhile
    await scope(() => U.upsertPayment({ id: U.payId.client(uuid(42)), contact_id: c.id, invoice_id: inv.id, invoice_number: inv.number, kind: "payment", method: "check", status: "succeeded", amount_cents: 10000, tip_cents: 0 }, AS(owner)));
    assert.equal((await invoiceOf(inv.id)).balance_cents, 19500);
    // the next pass resumes the same attempt
    const out = await scope(() => CH.chargeInvoice(inv.id, { origin: "autopay", by: "system:autopay", n: 1 }, AUTOMATION));
    assert.equal(out.result, "succeeded");
    assert.equal(out.amount_cents, 19500);
    const p = await paymentOf(out.payment_id);
    assert.equal(p.amount_cents, 19500, "the re-read balance, not the $295 the invoice had when the charge began");
    assert.deepEqual(outbox(t, "charge").map((o) => o.amount_cents), [19500]);
    const now = await invoiceOf(inv.id);
    assert.deepEqual([now.status, now.paid_cents, now.balance_cents, now.excess_cents], ["paid", 29500, 0, 0]);
    assert.equal(now.charging, undefined);
    // paid in full by the time a charge gets there: nothing is charged, the lock comes off
    const inv2 = await openInvoice(t, owner, c);
    await lockNow(inv2, 1);
    await scope(() => U.upsertPayment({ id: U.payId.client(uuid(43)), contact_id: c.id, invoice_id: inv2.id, invoice_number: inv2.number, kind: "payment", method: "cash", status: "succeeded", amount_cents: 29500, tip_cents: 0 }, AS(owner)));
    const none = await scope(() => CH.chargeInvoice(inv2.id, { origin: "autopay", by: "system:autopay", n: 1 }, AUTOMATION));
    assert.deepEqual([none.result, none.code], ["refused", "paid"]);
    assert.equal(outbox(t, "charge").length, 1);
    assert.equal((await invoiceOf(inv2.id)).charging, undefined);
  } finally { t.done(); }
});

test("a declined card: the attempt is on the invoice, a retry day is set for autopay, the customer gets the card link, and after the last retry an owner gets a task", async () => {
  const { t, owner } = await setup();
  try {
    const { texts, drain, advance, days } = await import("./fixtures.mjs");
    const c = await testContact(owner);
    await saveCard(c, "dry_pm_decline");
    const inv = await openInvoice(t, owner, c);
    const a1 = await scope(() => CH.chargeInvoice(inv.id, { origin: "autopay", by: "system:autopay" }, AUTOMATION));
    assert.deepEqual([a1.result, a1.code], ["failed", "card_declined"]);
    let now = await invoiceOf(inv.id);
    assert.equal(now.status, "open");
    assert.equal(now.autopay.attempts.length, 1);
    assert.equal(now.autopay.next_attempt_at, "2026-11-20T15:00:00.000Z", "3 days on, 9 AM Central");
    assert.equal(B.autopayFailed(now), true);
    await drain(t);
    assert.equal(texts(t, "payment_failed").length, 1);
    assert.match(texts(t, "payment_failed")[0].body, /Your card didn't go through for invoice/);
    assert.equal((await t.api(`/invoices?status=failed`, { as: owner })).body.data.length, 1);
    // the retry sweep on its day, then the last one
    advance(days(3) + 60000);
    await drain(t, 2);
    now = await invoiceOf(inv.id);
    assert.equal(now.autopay.attempts.length, 2, "the retry ran on its day");
    advance(days(4) + 60000);
    await drain(t, 2);
    now = await invoiceOf(inv.id);
    assert.equal(now.autopay.attempts.length, 3);
    assert.equal(now.autopay.next_attempt_at, undefined, "no more tries");
    const task = recs(t, "task").find((x) => x.approval && x.approval.kind === "card_failed");
    assert.ok(task, "an owner is asked to step in");
    assert.match(task.title, /Card failed 3 times/);
    advance(days(10));
    await drain(t, 2);
    assert.equal((await invoiceOf(inv.id)).autopay.attempts.length, 3);
    assert.equal(recs(t, "task").filter((x) => x.approval && x.approval.kind === "card_failed").length, 1);
  } finally { t.done(); }
});
