// The Financials tab's server pieces (the Rotor guide's FI1, FI4, FP1, FP3,
// FO1, FR2-FR5; guide-gaps S17-S20): the Invoices tiles (due today, paid
// this month), the Payments tiles, the Tip report, the Tax report (the
// CRM charges none; Rotor's imported tax shows), Payouts (read only, not
// connected), and Payroll's Closed step, by-job view and warnings.
// Synthetic people only; a pinned clock; nothing leaves (dry run).
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, customer, openInvoice, jobInvoice, store, scope, AS, uuid } from "./fixtures.mjs";

const MR = await import("../../../netlify/lib/crm/modules/money/routes.mjs");
const RX = await import("../../../netlify/lib/crm/modules/money/reports-extra.mjs");
const PP = await import("../../../netlify/lib/crm/modules/payroll/periods.mjs");

test("paymentTiles, tipsOf, taxOf, byJob (pure)", () => {
  const rows = [
    { k: "payment", m: "card", st: "succeeded", a: 10000, tip: 1000, fee: 320 },
    { k: "payment", m: "check", st: "succeeded", a: 5000, tip: 0, fee: 0 },
    { k: "payment", m: "cash", st: "succeeded", a: 2000, tip: 500, fee: 0, sim: 1 },
    { k: "refund", m: "card", st: "succeeded", a: 3000, tip: 0 },
    { k: "payment", m: "card", st: "failed", a: 9999, tip: 0 },
  ];
  const t = MR.paymentTiles(rows);
  assert.deepEqual(t.total, { n: 2, cents: 13000 }, "after refunds; practice and failed ones never count");
  assert.deepEqual(t.stripe, { n: 1, cents: 11000 });
  assert.deepEqual(t.cash_check, { n: 1, cents: 5000 });
  assert.deepEqual(t.tips, { n: 1, cents: 1000 });
  assert.deepEqual(t.refunds, { n: 1, cents: 3000 });
  assert.deepEqual(t.fees, { n: 1, cents: 320 });

  const tips = RX.tipsOf([
    { kind: "payment", status: "succeeded", tip_cents: 1000, tip_split: [{ user_id: "us_a", cents: 600 }, { user_id: "us_b", cents: 400 }], received_on: "2026-11-02", contact_name: "Pat" },
    { kind: "payment", status: "succeeded", tip_cents: 500, received_on: "2026-11-01" },
    { kind: "payment", status: "succeeded", tip_cents: 700, simulated: true },
  ], new Map([["us_a", "Theo"], ["us_b", "Tess"]]));
  assert.equal(tips.total_cents, 1500);
  assert.deepEqual(tips.people, { us_a: 600, us_b: 400, unsplit: 500 });
  assert.equal(tips.rows[1].split, "Theo 6.00; Tess 4.00");

  const tax = RX.taxOf([
    { status: "paid", paid_at: "2026-10-05T15:00:00Z", total_cents: 10750, lines: [{ description: "Windows", total_cents: 10000 }, { description: "Sales tax (imported)", total_cents: 750 }] },
    { status: "paid", paid_at: "2026-10-09T15:00:00Z", total_cents: 20000, lines: [{ description: "Gutters", total_cents: 20000 }] },
    { status: "open", total_cents: 999 },
    { status: "paid", paid_at: "2025-12-31T15:00:00Z", total_cents: 5000, lines: [] },
  ], "2026-01-01", "2026-12-31");
  assert.deepEqual(tax, [{ month: "2026-10", sales_cents: 30000, taxable_cents: 10000, exempt_cents: 20000, tax_cents: 750 }]);

  const g = PP.byJob([
    { user_id: "us_a", type: "technician_commission", amount_cents: 4000, label: "Job #885", source: { job_id: "jb_1" } },
    { user_id: "us_b", type: "technician_commission", amount_cents: 3000, label: "Job #885", source: { job_id: "jb_1" } },
    { user_id: "us_a", type: "tip", amount_cents: 500, source: { job_id: "jb_1" } },
    { user_id: "us_a", type: "hourly", amount_cents: 20000, source: {} },
    { user_id: "us_b", type: "technician_commission", amount_cents: 9999, status: "void", source: { job_id: "jb_2" } },
  ], [{ id: "us_a", name: "Theo" }, { id: "us_b", name: "Tess" }]);
  assert.equal(g.length, 2, "a struck-out line counts for nothing");
  assert.deepEqual(g[0], { job_id: "jb_1", label: "Job #885", people: [{ name: "Theo", cents: 4500 }, { name: "Tess", cents: 3000 }], commission_cents: 7000, tips_cents: 500, other_cents: 0, total_cents: 7500 });
  assert.equal(g[1].job_id, null, "the lines with no job last");
});

test("the Invoices tiles: due today and paid this month; the Tax and Tip reports as CSV; Payouts not connected", async () => {
  const { t, owner, tech } = await setup();
  try {
    const c = await customer(owner);
    await openInvoice(t, owner, c, { cents: 12300 });
    const r = await t.api("/invoices?status=due_today", { as: owner });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.meta.counts.due_today, 1, "issued today, due today");
    assert.equal(r.body.meta.totals.due_today_cents, 12300);
    assert.equal(r.body.data.length, 1);
    assert.equal(typeof r.body.meta.counts.paid_month, "number");
    const tax = await t.api("/invoices/tax.csv", { as: owner });
    assert.equal(tax.status, 200);
    assert.match(String(tax.headers.get("content-type")), /text\/csv/);
    assert.match(tax.text || tax.body, /month,sales,taxable_sales,exempt_sales,tax_collected[\s\S]*The CRM charges no sales tax/);
    const tips = await t.api("/payments/tips.csv?month=2026-11", { as: owner });
    assert.equal(tips.status, 200);
    assert.match(tips.text || tips.body, /date,customer_or_person,invoice,method,tip,split/);
    assert.equal((await t.api("/payments/tips.csv?month=nope", { as: owner })).status, 400);
    assert.equal((await t.api("/invoices/tax.csv", { as: tech })).status, 403);
    const po = await t.api("/payouts", { as: owner });
    assert.equal(po.status, 200);
    assert.equal(po.body.meta.connected, false, "no read-only key: nothing is read from Stripe");
    assert.deepEqual(po.body.data, []);
    const pay = await t.api("/payments?month=2026-11&group=stripe", { as: owner });
    assert.ok(pay.body.meta.tiles && pay.body.meta.tiles.total, "the tiles ride on the list");
  } finally { t.done(); }
});

test("Payroll: Closed after Paid (never before), and the period's warnings and by-job view", async () => {
  const { t, owner } = await setup();
  try {
    const W = AS(owner);
    const mk = (type, data) => scope(() => store.createRecord(type, { ...(globalThis.__R || {}), ...data }, W)).then((r) => r.data);
    const reg = await import("../../../netlify/lib/crm/core/registry.mjs");
    const ex = (type) => reg.getType(type).example();
    const paid = await mk("pay_period", { ...ex("pay_period"), start_on: "2026-10-25", end_on: "2026-10-31", weeks: 1, status: "paid", totals: {}, lines: [] });
    const open = await mk("pay_period", { ...ex("pay_period"), start_on: "2026-11-08", end_on: "2026-11-14", weeks: 1, status: "open", totals: {} });
    assert.equal((await t.api(`/payroll/periods/${open.id}/close`, { method: "POST", as: owner, body: {} })).status, 409, "paid first");
    const c = await t.api(`/payroll/periods/${paid.id}/close`, { method: "POST", as: owner, body: {} });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.equal(c.body.data.period.status, "closed");
    assert.equal((await t.api(`/payroll/periods/${paid.id}/unlock`, { method: "POST", as: owner, body: { reason: "x" } })).status, 409, "closed stays as paid");
    assert.equal(await PP.periodStatus({ at: "2026-10-28T15:00:00Z" }), "paid", "the work module reads a closed period as paid");
    const d = await t.api(`/payroll/periods/${open.id}`, { as: owner });
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.ok(Array.isArray(d.body.data.by_job));
    assert.ok(Array.isArray(d.body.data.warnings.nobody));
    assert.equal(typeof d.body.data.warnings.timers, "number");
  } finally { t.done(); }
});

void jobInvoice; void uuid;
