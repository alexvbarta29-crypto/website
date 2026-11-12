// Rotor's invoices and payments in the CRM (design §10.2 rows 27-30, §10.5,
// §10.8; the M5 gate "imported invoices and payments reconcile to Rotor to
// the cent"). A synthetic export goes through the real import run (M2c's
// framework, on the bulk lane); nothing here calls Rotor.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, importExport, generate, store } from "../import/fixtures.mjs";

const IMP = await import("../../../netlify/lib/crm/modules/money/import-rotor.mjs");
const B = await import("../../../netlify/lib/crm/modules/money/balance.mjs");
const CR = await import("../../../netlify/lib/crm/modules/money/credits.mjs");
const ids = await import("../../../netlify/lib/crm/core/ids.mjs");
const scope = (fn) => store.withStoreScope({ requestId: "test" }, fn);
const rec = async (type, rid) => { const g = await scope(() => store.getRecord(type, ids.idForRotor(type, rid))); return g ? g.data : null; };

test("the pure maps: numbers, line kinds, cents from dollars, lines made to add up to Rotor's total", () => {
  assert.deepEqual(IMP.parseNumber("INV-0605"), { seq: "invoice", n: 605, kind: "standard" });
  assert.deepEqual(IMP.parseNumber("INV-123456"), { seq: "invoice", n: 123456, kind: "standard" });
  assert.deepEqual(IMP.parseNumber("D-999566"), { seq: "deposit", n: 999566, kind: "deposit" });
  assert.equal(IMP.parseNumber("QB-17").seq, "imported");
  assert.equal(IMP.lineKind("Already Paid", "", -1000), "deposit_credit");
  assert.equal(IMP.lineKind("Deposit D-999566", "credit", -15000), "deposit_credit");
  assert.equal(IMP.lineKind("Referral Credit", "credit", -2500), "credit");
  assert.equal(IMP.lineKind("Gift Card", "", -500), "credit");
  assert.equal(IMP.lineKind("Card Fee", "service", 300), "fee");
  assert.equal(IMP.lineKind("Bi-Annual Discount", "", -5000), "discount");
  assert.equal(IMP.lineKind("Exterior Window Cleaning", "service", 29500), "service");
  // an imported (dollars) line: "243.1" is 24310 cents, never 24309
  const l = IMP.mapLine({ title: "Exterior Window Cleaning", quantity: 1, unit_price: 243.1, total_price: 243.1 }, 0);
  assert.deepEqual([l.unit_cents, l.total_cents, l.kind, l.shape], [24310, 24310, "service", "imported"]);
  // a native (cents) line, negative for a discount
  const d = IMP.mapLine({ description: "Total Discount", quantity: 1, unit_amount: -5000, kind: "discount" }, 1);
  assert.deepEqual([d.total_cents, d.kind, d.shape], [-5000, "discount", "native"]);
  // the plan discount Rotor took without a line: one line makes the lines equal the total
  const fixed = IMP.reconcileLines([l], { subtotal_cents: 19310, tax_cents: 0, total_cents: 19310 });
  assert.equal(fixed[1].description, "Plan discount (imported)");
  assert.equal(B.totalsOf(fixed).total_cents, 19310);
  // the one invoice with sales tax
  const taxed = IMP.reconcileLines([IMP.mapLine({ title: "Gutter Cleaning", quantity: 1, unit_price: 299, total_price: 299 }, 0)], { subtotal_cents: 29900, tax_cents: 2093, total_cents: 31993 });
  assert.equal(B.totalsOf(taxed).total_cents, 31993);
  // whole-hour noon dates are local dates; anything else is an instant in Delano
  assert.equal(IMP.dateOf("2026-04-13T12:00:00+00:00"), "2026-04-13");
  assert.equal(IMP.dateOf("2026-11-05T02:18:34.958975+00:00"), "2026-11-04");
});

test("the import: every invoice and payment lands, balances follow the payments, and the money reconciles to the cent", async () => {
  const { t, owner } = await setup();
  try {
    const ex = generate({ scale: 0.06, seed: 31 });
    const r = await importExport(t, owner, ex);
    assert.equal(r.run.status, "done", JSON.stringify(r.run.summary));
    const rep = (await t.api(`/import/runs/${r.ir.id}/report`, { as: owner })).body.data;
    const phase = Object.fromEntries(rep.phases.map((p) => [p.name, p]));
    assert.equal(phase["money.invoices"].status, "done");
    assert.equal(phase["money.payments"].status, "done");
    assert.equal(phase["money.invoices"].read, ex.invoices.length);
    assert.equal(phase["money.payments"].read, ex.payments.length);
    // the report: Rotor's sums against the CRM's, to the cent
    assert.equal(rep.summary.money_checked, true);
    assert.deepEqual(rep.money.crm.diffs, [], "no difference between Rotor's money and the CRM's");
    assert.equal(rep.money.crm.ok, true);
    assert.equal(rep.money.crm.invoices.count, ex.invoices.length);
    assert.equal(rep.money.crm.invoices.total_cents, ex.invoices.reduce((s, i) => s + i.total_cents, 0));
    const live = ex.payments.filter((p) => p.status !== "failed");
    assert.equal(rep.money.crm.payments.net_cents, live.filter((p) => p.payment_type !== "refund").reduce((s, p) => s + p.total_amount_cents - p.tip_cents, 0));
    assert.equal(rep.money.crm.payments.refunds_cents, live.filter((p) => p.payment_type === "refund").reduce((s, p) => s + p.total_amount_cents, 0));
    assert.equal(rep.money.crm.payments.tips_cents, live.reduce((s, p) => s + p.tip_cents, 0));
    assert.deepEqual(rep.money.crm.payments.by_method, rep.money.rotor.payments.by_method);
    assert.deepEqual(rep.money.crm.payments.by_year, rep.money.rotor.payments.by_year);

    // one invoice, closely: number kept, total Rotor's, each payment in its applied map
    for (const row of ex.invoices) {
      const inv = await rec("invoice", row.id);
      assert.ok(inv, "every invoice row is a record");
      assert.equal(inv.number, row.invoice_number, "the number is kept as it is");
      assert.equal(inv.total_cents, row.total_cents, "Rotor's total is the total");
      assert.equal(B.totalsOf(inv.lines).total_cents, row.total_cents, "and the lines add up to it");
      assert.equal(inv.kind, /^D-/.test(row.invoice_number) ? "deposit" : "standard");
      assert.equal(inv.rotor.status_raw, row.status);
      assert.ok(inv.import && !inv.shadow, "an imported record, not a shadow");
      const pays = ex.payments.filter((p) => p.invoice_id === row.id);
      assert.equal(Object.keys(inv.applied).length, pays.length);
      const paid = pays.filter((p) => p.status === "succeeded" && p.payment_type === "invoice").reduce((s, p) => s + p.total_amount_cents - p.tip_cents, 0);
      const refunded = pays.filter((p) => p.status === "succeeded" && p.payment_type === "refund").reduce((s, p) => s + p.total_amount_cents, 0);
      assert.equal(inv.paid_cents, paid);
      assert.equal(inv.refunded_cents, refunded);
      assert.equal(inv.balance_cents, Math.max(0, row.total_cents - paid + refunded));
      if (row.status === "draft") assert.equal(inv.status, "draft");
      else if (row.status === "void") assert.equal(inv.status, "void");
      else assert.equal(inv.status, inv.balance_cents === 0 ? "paid" : "open", "everything else follows the payments");
    }
    // payments: methods, refunds, tips to the job's techs, references masked
    let tipped = 0;
    for (const row of ex.payments) {
      const p = await rec("payment", row.id);
      assert.ok(p, "every payment row is a record");
      assert.equal(p.method, { stripe: "card", tap_to_pay: "card", check: "check", cash: "cash", other: "other", "Imported-Data": "imported" }[row.payment_method]);
      assert.equal(p.kind, row.payment_type === "refund" ? "refund" : "payment");
      assert.equal(p.amount_cents + p.tip_cents, row.total_amount_cents);
      assert.equal(p.tip_cents, row.tip_cents);
      assert.equal(p.fee_cents, row.processing_fee_cents);
      assert.equal(p.rotor.method_raw, row.payment_method);
      if (p.reference) assert.doesNotMatch(p.reference, /\d{8,}/, "bank numbers typed from a check are masked");
      if (p.tip_split.length) { tipped += 1; assert.equal(p.tip_split.reduce((s, x) => s + x.cents, 0), p.tip_cents, "the tip split adds up to the tip"); }
    }
    assert.ok(tipped > 0, "some tips went to the job's techs");
    // credits on invoice lines are history only: nobody gets a balance from them (D33)
    const credits = t.stores.data.keys("rec/credit/").map((k) => t.stores.data.json(k));
    assert.ok(credits.length > 0, "credit lines kept as history rows");
    for (const c of credits) {
      assert.equal(c.status, "settled");
      assert.equal(await scope(() => CR.availableCredit(c.contact_id)), 0);
    }
    // Rotor's statuses against what the payments say (synthetic statuses are random: mismatches are listed, not hidden)
    assert.equal(rep.money.crm.status_mismatches, rep.money.crm.mismatches.length);
    assert.ok(rep.money.crm.mismatches.every((m) => m.number && m.rotor_status));

    // the same export again: nothing is created, nothing changes
    const before = new Map(t.stores.data.keys("rec/").filter((k) => /^rec\/(invoice|payment|credit)\//.test(k)).map((k) => [k, t.stores.data.etagOf(k)]));
    const again = await importExport(t, owner, ex);
    assert.equal(again.run.status, "done");
    assert.equal(again.run.summary.created, 0);
    assert.equal(again.run.summary.updated, 0);
    const changed = [...before.keys()].filter((k) => before.get(k) !== t.stores.data.etagOf(k));
    assert.deepEqual(changed, [], "no invoice, payment or credit was written again");
  } finally { t.done(); }
});

test("an imported invoice in the app: listed, its payments shown, and never touched by automation", async () => {
  const { t, owner } = await setup();
  try {
    const ex = generate({ scale: 0.03, seed: 32 });
    await importExport(t, owner, ex);
    const paidRow = ex.invoices.find((i) => ex.payments.some((p) => p.invoice_id === i.id && p.status === "succeeded" && p.payment_type === "invoice"));
    const inv = await rec("invoice", paidRow.id);
    const one = await t.api(`/invoices/${inv.id}`, { as: owner });
    assert.equal(one.status, 200, JSON.stringify(one.body));
    assert.equal(one.body.data.invoice.number, paidRow.invoice_number);
    assert.ok(one.body.data.payments.length >= 1);
    assert.equal(one.body.data.sandboxed, false, "Rotor's invoice is not a sandbox record");
    assert.equal(one.body.data.online, inv.status === "open" ? "not_yet" : "paid", "no online payment for a Rotor invoice before the switch");
    // the contact's Money tab
    const tab = await t.api(`/money/contacts/${inv.contact_id}`, { as: owner });
    assert.equal(tab.status, 200, JSON.stringify(tab.body));
    assert.ok(tab.body.data.invoices.some((r) => r.id === inv.id));
    // a week of sweeps leaves every imported invoice and payment exactly as the import wrote it
    const snap = () => new Map(t.stores.data.keys("rec/").filter((k) => /^rec\/(invoice|payment)\//.test(k)).map((k) => [k, t.stores.data.etagOf(k)]));
    const before = snap();
    for (let i = 0; i < 4; i++) { await t.runWorker({ lane: "fast" }); await t.runWorker({ lane: "bulk" }); }
    const after = snap();
    assert.deepEqual([...after.keys()].filter((k) => before.get(k) !== after.get(k)), [], "no automation wrote to Rotor's money");
    assert.equal(after.size, before.size, "and none made an invoice or a payment");
  } finally { t.done(); }
});
