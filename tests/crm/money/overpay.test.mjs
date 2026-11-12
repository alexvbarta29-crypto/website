// Overpayments (design §5.6 "Overpayment"; §11.4 M5 overpay.test.mjs): a
// stale pay link paid after the office took cash makes a held credit row
// and ONE approval task; an owner refunds the extra or keeps it as credit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, testContact, openInvoice, invoiceOf, recs, drain, scope, portalCookie, PJSON, uuid, piObject, sessionObject, CO, CR, HOOK } from "./fixtures.mjs";

// the module's attention and approval rows, as the tab's dot counts them (Home no longer lists them)
const needs = () => scope(async () => {
  const m = (await import("../../../netlify/lib/crm/core/registry.mjs")).getModule("money");
  const out = [];
  for (const a of [...m.attention, ...m.approvals]) { const n = await a.count({}); if (n) out.push([a.key || a.kind, n]); }
  return out;
});

async function overpaid(t, owner) {
  const c = await testContact(owner);
  const inv = await openInvoice(t, owner, c);
  const cookie = await portalCookie(t, c.id, { kind: "invoice", id: inv.id });
  // the customer opens Checkout from the text ...
  const co = await t.portal(`/api/portal/invoices/${inv.id}/checkout`, { method: "POST", headers: PJSON, cookie, body: { tip_choice: "0" } });
  assert.equal(co.status, 200, JSON.stringify(co.body));
  const sid = co.body.data.url.split("/").pop();
  // ... then pays the tech in cash at the door
  const cash = await t.api(`/invoices/${inv.id}/payments`, { method: "POST", as: owner, body: { method: "cash", amount_cents: 29500, client_id: uuid(51) } });
  assert.equal(cash.body.data.invoice.status, "paid");
  // ... and that evening finishes the Checkout they had left open (Stripe took the card: the webhook tells us)
  const pi = piObject("pi_overpay", inv, { amount: 29500 });
  const out = await scope(() => CO.applyCheckoutSession(sessionObject(sid, inv, pi), HOOK));
  assert.equal(out.transitioned, "succeeded");
  return { c, inv, sid, pi, payment: out.payment };
}

test("a stale link paid after cash: the invoice shows the extra, a held credit row and one approval task; never two", async () => {
  const { t, owner } = await setup();
  try {
    const { inv, sid, pi, payment } = await overpaid(t, owner);
    let now = await invoiceOf(inv.id);
    assert.deepEqual([now.status, now.paid_cents, now.balance_cents, now.excess_cents], ["paid", 59000, 0, 29500]);
    await drain(t);
    // the event again, and a second look by the nightly pass: still one of each
    await scope(() => CO.applyCheckoutSession(sessionObject(sid, inv, pi), HOOK));
    await scope(() => CR.keepOverpayment(now, { mayAct: () => true, would: async () => {}, write: () => HOOK }));
    await drain(t);
    const credits = recs(t, "credit");
    assert.equal(credits.length, 1);
    assert.deepEqual([credits[0].kind, credits[0].status, credits[0].amount_cents, credits[0].source_invoice_id], ["overpayment", "held", 29500, inv.id]);
    const tasks = recs(t, "task").filter((x) => x.approval && x.approval.kind === "overpayment");
    assert.equal(tasks.length, 1);
    assert.match(tasks[0].title, /Overpaid \$295\.00 on SINV-0001: refund or keep as credit/);
    // a held credit is not spendable: the next invoice doesn't take it
    assert.equal((await scope(() => CR.availableCredit(inv.contact_id))), 0);
    // an owner's approval row (the tab's dot); the Invoices list has its chip
    assert.deepEqual(await needs(t, owner), [["money.overpayment", 1]]);
    const list = await t.api("/invoices?status=overpaid", { as: owner });
    assert.deepEqual(list.body.data.map((r) => [r.id, r.ex]), [[inv.id, 29500]]);
    assert.equal(list.body.meta.counts.overpaid, 1);
    // the owner refunds the extra from the card payment: settled, nothing left to decide
    const no = await t.api(`/payments/${payment.id}/refund`, { method: "POST", as: owner, body: { amount_cents: 29500, reason: "Paid twice", client_id: uuid(52) } });
    assert.equal(no.status, 409, "a real card payment can't be sent back while payments are in dry run");
    const cashId = recs(t, "payment").find((p) => p.method === "cash").id;
    const back = await t.api(`/payments/${cashId}/refund`, { method: "POST", as: owner, body: { amount_cents: 29500, reason: "Paid twice: cash handed back", client_id: uuid(53) } });
    assert.equal(back.status, 201, JSON.stringify(back.body));
    await drain(t);
    now = await invoiceOf(inv.id);
    assert.deepEqual([now.status, now.excess_cents, now.balance_cents], ["paid", 0, 0]);
    assert.deepEqual(recs(t, "credit").map((cr) => [cr.status, cr.amount_cents]), [["settled", 0]]);
    assert.deepEqual(await needs(t, owner), []);
    assert.equal(recs(t, "task").filter((x) => x.approval && x.approval.kind === "overpayment").length, 1);
  } finally { t.done(); }
});

test("the owner keeps the extra as credit: it becomes spendable, the invoice is decided, and the next invoice uses it", async () => {
  const { t, owner, admin } = await setup();
  try {
    const { c, inv } = await overpaid(t, owner);
    await drain(t);
    const held = recs(t, "credit")[0];
    assert.equal((await t.api(`/credits/${held.id}/keep`, { method: "POST", as: admin, body: {} })).status, 403, "owners decide");
    const keep = await t.api(`/credits/${held.id}/keep`, { method: "POST", as: owner, body: {} });
    assert.equal(keep.status, 200, JSON.stringify(keep.body));
    assert.equal(keep.body.data.credit.status, "available");
    const now = await invoiceOf(inv.id);
    assert.equal(now.excess_kept, true);
    assert.deepEqual(await needs(t, owner), []);
    assert.equal((await t.api("/invoices?status=overpaid", { as: owner })).body.data.length, 0);
    // a later look at the same invoice never takes the kept credit back
    await scope(() => CR.keepOverpayment(now, { mayAct: () => true, would: async () => {}, write: () => HOOK }));
    assert.equal(recs(t, "credit")[0].status, "available");
    assert.equal(await scope(() => CR.availableCredit(c.id)), 29500);
    // the next invoice takes it off
    const next = await t.api("/invoices", { method: "POST", as: owner, body: { contact_id: c.id, lines: [{ description: "Screens", unit_cents: 10000 }], issue: true, client_id: uuid(54) } });
    assert.equal(next.status, 201, JSON.stringify(next.body));
    const n = next.body.data.invoice;
    assert.deepEqual([n.total_cents, n.status], [0, "paid"]);
    assert.ok(n.lines.some((l) => l.kind === "credit" && l.total_cents === -10000));
    assert.equal(await scope(() => CR.availableCredit(c.id)), 19500);
  } finally { t.done(); }
});
