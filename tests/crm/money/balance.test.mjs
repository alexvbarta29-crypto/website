// The pure money rules and the applied map (design §5.6 "The pure balance
// mutator"; §11.4 M5 balance.test.mjs): only succeeded entries count; a
// payment and a refund racing on one invoice both land in `applied`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, customer, openInvoice, invoiceOf, scope, store, B, U, RF, AS, uuid, recs } from "./fixtures.mjs";

const inv = (o = {}) => ({ status: "open", total_cents: 30000, applied: {}, ...o });
const e = (kind, amount, status, tip = 0) => ({ kind, amount_cents: amount, tip_cents: tip, status });

test("totalsOf: service and fee lines add, discounts and credits take off, never below $0", () => {
  const t = B.totalsOf([
    { kind: "service", total_cents: 29500 }, { kind: "fee", total_cents: 300 }, { kind: "discount", total_cents: -5000 },
    { kind: "deposit_credit", total_cents: -10000 }, { kind: "credit", total_cents: -2500 },
  ]);
  assert.deepEqual(t, { subtotal_cents: 29800, discount_cents: 5000, credit_cents: 12500, tax_cents: 0, total_cents: 12300 });
  assert.equal(B.totalsOf([{ kind: "service", total_cents: 1000 }, { kind: "credit", total_cents: -5000 }]).total_cents, 0);
});

test("derive: only succeeded entries count; pending, processing, failed and canceled never do", () => {
  const d = B.derive(inv({ applied: {
    pm_a: e("payment", 10000, "succeeded", 1500), pm_b: e("payment", 5000, "processing"), pm_c: e("payment", 7000, "failed"),
    pm_d: e("payment", 9000, "pending"), pm_e: e("payment", 2000, "canceled"), pm_f: e("refund", 3000, "succeeded"), pm_g: e("refund", 1000, "pending"),
  } }));
  assert.equal(d.paid_cents, 10000);
  assert.equal(d.refunded_cents, 3000);
  assert.equal(d.tips_cents, 1500);
  assert.equal(d.balance_cents, 23000);
  assert.equal(d.excess_cents, 0);
  assert.equal(d.status, "open");
  assert.equal(B.isProcessing(d), true);
  assert.equal(B.isPartiallyPaid(d), true);
});

test("derive: open ⇄ paid follow the money; a refund reopens; draft, void and uncollectible are people's", () => {
  const paid = B.derive(inv({ applied: { pm_a: e("payment", 30000, "succeeded") } }), { at: "2026-11-17T15:00:00.000Z" });
  assert.equal(paid.status, "paid");
  assert.equal(paid.balance_cents, 0);
  assert.equal(paid.paid_at, "2026-11-17T15:00:00.000Z");
  const reopened = B.derive({ ...paid, applied: { ...paid.applied, pm_r: e("refund", 4000, "succeeded") } });
  assert.equal(reopened.status, "open", "a refund makes a balance: open again");
  assert.equal(reopened.balance_cents, 4000);
  assert.equal(reopened.paid_at, undefined);
  for (const st of ["draft", "void", "uncollectible"]) assert.equal(B.derive(inv({ status: st, applied: { pm_a: e("payment", 30000, "succeeded") } })).status, st);
  // over the total: excess, never a negative balance; on a void invoice everything paid is excess
  const over = B.derive(inv({ applied: { pm_a: e("payment", 30000, "succeeded"), pm_b: e("payment", 5000, "succeeded") } }));
  assert.deepEqual([over.balance_cents, over.excess_cents, over.status], [0, 5000, "paid"]);
  const voided = B.derive(inv({ status: "void", applied: { pm_a: e("payment", 5000, "succeeded") } }));
  assert.deepEqual([voided.balance_cents, voided.excess_cents], [0, 5000]);
});

test("forward: a status moves only forward by rank, and a terminal one never changes", () => {
  assert.equal(B.forward("pending", "processing"), "processing");
  assert.equal(B.forward("processing", "pending"), "processing");
  assert.equal(B.forward("processing", "succeeded"), "succeeded");
  for (const term of ["succeeded", "failed", "canceled"]) for (const next of ["pending", "processing", "succeeded", "failed", "canceled"]) assert.equal(B.forward(term, next), term);
});

test("flags: overdue needs open, a due date before today and a balance", () => {
  const base = B.derive(inv({ due_on: "2026-11-10" }));
  assert.equal(B.isOverdue(base, "2026-11-17"), true);
  assert.equal(B.isOverdue(base, "2026-11-10"), false, "due today is not overdue");
  assert.equal(B.isOverdue({ ...base, status: "draft" }, "2026-11-17"), false);
  assert.equal(B.isOverdue(B.derive(inv({ due_on: "2026-11-10", applied: { pm_a: e("payment", 30000, "succeeded") } })), "2026-11-17"), false);
});

test("a payment and a refund racing on one invoice both land in applied; the balance is right whoever wins", async () => {
  const { t, owner } = await setup();
  try {
    const c = await customer(owner);
    const invoice = await openInvoice(t, owner, c, { cents: 30000 });
    // a first payment of $200 by check
    const p1 = await t.api(`/invoices/${invoice.id}/payments`, { method: "POST", as: owner, body: { method: "check", amount_cents: 20000, reference: "1042", client_id: uuid(1) } });
    assert.equal(p1.status, 201, JSON.stringify(p1.body));
    // at the same moment: the last $100 in cash, and a $50 refund of the check
    const [a, b] = await Promise.all([
      t.api(`/invoices/${invoice.id}/payments`, { method: "POST", as: owner, body: { method: "cash", amount_cents: 10000, client_id: uuid(2) } }),
      t.api(`/payments/${p1.body.data.payment.id}/refund`, { method: "POST", as: owner, body: { amount_cents: 5000, reason: "Missed a window", client_id: uuid(3) } }),
    ]);
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.equal(b.status, 201, JSON.stringify(b.body));
    const after = await invoiceOf(invoice.id);
    assert.equal(Object.keys(after.applied).length, 3, "the check, the cash and the refund are all in the map");
    assert.equal(after.paid_cents, 30000);
    assert.equal(after.refunded_cents, 5000);
    assert.equal(after.balance_cents, 5000);
    assert.equal(after.status, "open", "the refund left $50 to pay");
    assert.equal(recs(t, "payment").length, 3);
    // a payment that is only processing never counts
    await scope(() => U.upsertPayment({ id: U.payId.pi("pi_test_processing"), contact_id: c.id, invoice_id: invoice.id, kind: "payment", method: "ach", status: "processing", amount_cents: 5000, tip_split: [] }, AS(owner)));
    const proc = await invoiceOf(invoice.id);
    assert.equal(proc.paid_cents, 30000, "a processing payment doesn't count");
    assert.equal(proc.status, "open");
    assert.equal(B.isProcessing(proc), true);
    assert.ok(RF && store);
  } finally { t.done(); }
});
