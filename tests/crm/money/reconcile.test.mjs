// Reconciliation (design §7.6 money.reconcile; §11.4 M5 reconcile.test.mjs):
// the payment records are the truth; an invoice whose `applied` map is
// damaged (an entry lost, stale, or left behind by a function that died
// between two writes) is rebuilt from them, and the customer's balance and
// lifetime paid are worked out again from the indexes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, customer, testContact, importedCustomer, openInvoice, invoiceOf, recs, texts, drain, scope, store, uuid, piObject, U, CO, REC, COMMON, AS, AUTOMATION, HOOK, IMPORT } from "./fixtures.mjs";

const sweepCtx = () => ({ cursor: null, budget: null, write: () => AUTOMATION, mode: AUTOMATION.mode });
const stats = async (id) => ((await scope(() => store.getRecord("contact_stats", id))) || { data: {} }).data.money || {};
const damage = (id, fn) => scope(() => store.updateRecord("invoice", id, (inv) => ({ ...inv, applied: fn({ ...(inv.applied || {}) }) }), AUTOMATION));

test("a damaged applied map is rebuilt from the payment records: a lost entry, a stale status, a wrong amount, an entry of nothing", async () => {
  const { t, owner } = await setup();
  try {
    const c = await testContact(owner);
    const inv = await openInvoice(t, owner, c);
    const cash = await t.api(`/invoices/${inv.id}/payments`, { method: "POST", as: owner, body: { method: "cash", amount_cents: 10000, client_id: uuid(71) } });
    const check = await t.api(`/invoices/${inv.id}/payments`, { method: "POST", as: owner, body: { method: "check", amount_cents: 19500, tip_cents: 1000, reference: "1042", client_id: uuid(72) } });
    const back = await t.api(`/payments/${cash.body.data.payment.id}/refund`, { method: "POST", as: owner, body: { amount_cents: 2500, reason: "A screen was missed", client_id: uuid(73) } });
    assert.equal(back.status, 201);
    const good = await invoiceOf(inv.id);
    assert.deepEqual([good.status, good.paid_cents, good.refunded_cents, good.tips_cents, good.balance_cents], ["open", 29500, 2500, 1000, 2500]);
    assert.equal(Object.keys(good.applied).length, 3);
    assert.equal(await scope(() => REC.reconcileInvoice(inv.id, AUTOMATION)), false, "nothing to repair");
    const [idCash, idCheck, idRefund] = [cash.body.data.payment.id, check.body.data.payment.id, back.body.data.refund.id];

    // 1. an entry lost (the function died between the payment write and the invoice's)
    await damage(inv.id, (a) => { delete a[idCheck]; return a; });
    let bad = await invoiceOf(inv.id);
    assert.deepEqual([bad.paid_cents, bad.balance_cents], [10000, 22000], "the damage shows: the invoice thinks it is owed more");
    assert.equal(await scope(() => REC.reconcileInvoice(inv.id, AUTOMATION)), true);
    assert.deepEqual(await invoiceOf(inv.id).then((x) => [x.paid_cents, x.refunded_cents, x.tips_cents, x.balance_cents]), [29500, 2500, 1000, 2500]);

    // 2. a stale status, a wrong amount, and an entry for a payment that doesn't exist: one pass of the sweep
    await damage(inv.id, (a) => ({ ...a, [idCheck]: { ...a[idCheck], status: "processing" }, [idRefund]: { ...a[idRefund], amount_cents: 25 }, pm_00000000000000000000: { kind: "payment", amount_cents: 999999, tip_cents: 0, status: "succeeded", at: "2026-11-17T15:00:00.000Z" } }));
    bad = await invoiceOf(inv.id);
    assert.equal(bad.status, "paid", "the phantom payment makes it look paid");
    const out = await scope(() => REC.reconcileSweep(sweepCtx()));
    assert.match(out.result, /repaired 1/);
    const fixed = await invoiceOf(inv.id);
    assert.deepEqual([fixed.status, fixed.paid_cents, fixed.refunded_cents, fixed.tips_cents, fixed.balance_cents, fixed.excess_cents], ["open", 29500, 2500, 1000, 2500, 0]);
    assert.deepEqual(Object.keys(fixed.applied).sort(), [idCash, idCheck, idRefund].sort());
    assert.equal(fixed.applied[idCheck].at, good.applied[idCheck].at, "an entry that was right keeps its time");
    // the owners are told, plainly
    const health = t.stores.data.json("sys/health");
    assert.ok((health.alerts || []).some((a) => /1 invoice had payments out of step and was repaired/.test(a.text || a.message || JSON.stringify(a))));
    // a second pass repairs nothing
    assert.match((await scope(() => REC.reconcileSweep(sweepCtx()))).result, /repaired 0/);
  } finally { t.done(); }
});

test("a payment whose invoice never heard of it makes the invoice paid when the sweep adds it: invoice.paid goes out once, no second receipt", async () => {
  const { t, owner } = await setup();
  try {
    const c = await testContact(owner);
    const inv = await openInvoice(t, owner, c);
    await scope(() => CO.applyPaymentIntent(piObject("pi_rec_1", inv), HOOK));
    await drain(t);
    assert.equal(texts(t, "payment_receipt").length, 1);
    // as if the invoice write had never landed
    await damage(inv.id, () => ({}));
    assert.equal((await invoiceOf(inv.id)).status, "open");
    assert.equal(await scope(() => REC.reconcileInvoice(inv.id, AUTOMATION)), true);
    const now = await invoiceOf(inv.id);
    assert.deepEqual([now.status, now.balance_cents], ["paid", 0]);
    assert.equal(now.applied[U.payId.pi("pi_rec_1")].status, "succeeded");
    await drain(t);
    assert.equal(texts(t, "payment_receipt").length, 1, "the receipt belongs to the payment, which never changed");
    assert.equal(texts(t, "invoice_overdue").length, 0);
  } finally { t.done(); }
});

test("the customer's money stats: what they owe follows their open invoices, lifetime paid follows real payments; the sweep puts right what a write missed and gives imported customers their balance", async () => {
  const { t, owner } = await setup();
  try {
    const c = await customer(owner);
    const a = await openInvoice(t, owner, c, { cents: 29500 });
    const b = await openInvoice(t, owner, c, { cents: 12000 });
    assert.equal((await stats(c.id)).open_balance_cents, 41500);
    await t.api(`/invoices/${a.id}/payments`, { method: "POST", as: owner, body: { method: "check", amount_cents: 29500, tip_cents: 500, client_id: uuid(81) } });
    let s = await stats(c.id);
    assert.deepEqual([s.open_balance_cents, s.lifetime_cents], [12000, 30000]);
    const pid = recs(t, "payment")[0].id;
    await t.api(`/payments/${pid}/refund`, { method: "POST", as: owner, body: { amount_cents: 10000, reason: "Streaks on two panes", client_id: uuid(82) } });
    s = await stats(c.id);
    assert.deepEqual([s.open_balance_cents, s.lifetime_cents], [22000, 20000], "the refund reopened $100 and came off lifetime");
    await t.api(`/invoices/${b.id}/void`, { method: "POST", as: owner, body: { reason: "Billed twice" } });
    assert.equal((await stats(c.id)).open_balance_cents, 10000);
    // the contacts list row carries it (the tech's "Balance due" badge and the contact's header read it)
    const row = (await scope(() => store.readIndex("contacts", (t.stores.data.keys("ix/contacts/")[0] || "").split("/").pop()))).rows.find((r) => r.id === c.id);
    assert.deepEqual([row.mb, row.ml], [10000, 20000]);
    // a practice payment never counts toward lifetime
    const tc = await testContact(owner);
    const ti = await openInvoice(t, owner, tc);
    await scope(() => CO.applyPaymentIntent(piObject("pi_sim", ti), HOOK, { simulated: true }));
    assert.deepEqual(await stats(tc.id).then((x) => [x.open_balance_cents, x.lifetime_cents]), [0, 0]);

    // an imported customer with an open Rotor invoice and an old payment: the import writes no stats; the sweep does
    const rc = await importedCustomer();
    await scope(() => store.createRecord("invoice", { number: "INV-0560", seq: "imported", n: 560, kind: "standard", contact_id: rc.id, status: "open", issued_on: "2026-11-01", due_on: "2026-11-01", lines: [{ id: "ln_1", kind: "service", description: "Windows", qty_milli: 1000, unit_cents: 18000, total_cents: 18000 }], import: { run_id: "ir_00000000000000000001", at: "2026-11-08T00:00:00.000Z", hash: "3".repeat(64) }, rotor: { status_raw: "sent", total_cents_raw: 18000 } }, IMPORT));
    await scope(() => store.createRecord("payment", { id: U.payId.client(uuid(83)), contact_id: rc.id, kind: "payment", method: "card", status: "succeeded", amount_cents: 26000, tip_cents: 1000, received_on: "2026-06-03", import: { run_id: "ir_00000000000000000001", at: "2026-11-08T00:00:00.000Z", hash: "4".repeat(64) } }, IMPORT));
    assert.deepEqual(await stats(rc.id).then((x) => [x.open_balance_cents || 0, x.lifetime_cents || 0]), [0, 0]);
    // and one of our own stats writes "never landed"
    await scope(() => store.updateStats(c.id, "money", (p) => ({ ...p, open_balance_cents: 0, lifetime_cents: 123 }), AUTOMATION));
    const hourly = await scope(() => COMMON.refreshMoneyStats({ write: () => AUTOMATION }));
    assert.equal(hourly.progress, 2);
    assert.equal((await stats(rc.id)).open_balance_cents, 18000);
    assert.deepEqual(await stats(c.id).then((x) => [x.open_balance_cents, x.lifetime_cents]), [10000, 123], "the hourly pass checks balances only");
    const nightly = await scope(() => COMMON.refreshMoneyStats({ write: () => AUTOMATION }, { lifetime: true }));
    assert.equal(nightly.progress, 2);
    assert.equal((await stats(c.id)).lifetime_cents, 20000);
    assert.equal((await stats(rc.id)).lifetime_cents, 27000);
    assert.equal((await scope(() => COMMON.refreshMoneyStats({ write: () => AUTOMATION }, { lifetime: true }))).progress, 0, "nothing left to fix");
    // the card on file is untouched by any of it
    assert.equal((await stats(c.id)).stripe.card_status, "none");
  } finally { t.done(); }
});
