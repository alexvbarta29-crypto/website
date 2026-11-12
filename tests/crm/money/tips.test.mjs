// Tips (design §5.6, §8.5, D3; §11.4 M5 tips.test.mjs): the server works the
// tip out from the choice and the balance (never an amount the page sent),
// a custom tip is capped, and every tip is split evenly across the techs on
// the visit, as data Payroll reads.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, testContact, jobInvoice, openInvoice, invoiceOf, paymentOf, recs, scope, store, uuid, portalCookie, PJSON, B, CO, AS } from "./fixtures.mjs";

test("computeTip: a percent the settings offer, of the balance, rounded half up; a custom amount capped at the balance and at $500; anything else refused", () => {
  assert.deepEqual(B.computeTip(29500, "0"), { tip_cents: 0, capped: false });
  assert.deepEqual(B.computeTip(29500, "10"), { tip_cents: 2950, capped: false });
  assert.deepEqual(B.computeTip(29500, "15"), { tip_cents: 4425, capped: false });
  assert.deepEqual(B.computeTip(29500, "20"), { tip_cents: 5900, capped: false });
  assert.equal(B.computeTip(3333, "15").tip_cents, 500, "499.95 rounds to 500");
  assert.equal(B.computeTip(1, "10").tip_cents, 0);
  assert.throws(() => B.computeTip(29500, "25"), RangeError, "25% isn't offered");
  assert.throws(() => B.computeTip(29500, "1500"), RangeError);
  assert.throws(() => B.computeTip(29500, "-10"), RangeError);
  assert.throws(() => B.computeTip(29500, "15; drop"), RangeError);
  assert.equal(B.computeTip(29500, "25", undefined, { tip_options_bp: [0, 2500] }).tip_cents, 7375, "the owner's own choices");
  assert.equal(B.computeTip(29500, "0", undefined, { tip_options_bp: [1500] }).tip_cents, 0, "no tip is always a choice");
  // custom
  assert.deepEqual(B.computeTip(29500, "custom", 1234), { tip_cents: 1234, capped: false });
  assert.deepEqual(B.computeTip(29500, "custom", 999999), { tip_cents: 29500, capped: true }, "never more than the invoice itself");
  assert.deepEqual(B.computeTip(120000, "custom", 999999), { tip_cents: 50000, capped: true }, "never more than $500");
  assert.deepEqual(B.computeTip(120000, "custom", 999999, { tip_custom_max_cents: 10000 }), { tip_cents: 10000, capped: true });
  assert.equal(B.computeTip(29500, "custom", -500).tip_cents, 0);
  assert.equal(B.computeTip(29500, "custom", "abc").tip_cents, 0);
  assert.equal(B.computeTip(29500, "custom", 12.5).tip_cents, 0, "cents are whole numbers");
});

test("splitTip: even shares, the odd cent to the first; nobody on the visit means no lines", () => {
  assert.deepEqual(B.splitTip(2950, ["us_a", "us_b"]), [{ user_id: "us_a", cents: 1475 }, { user_id: "us_b", cents: 1475 }]);
  assert.deepEqual(B.splitTip(1000, ["us_a", "us_b", "us_c"]).map((x) => x.cents), [334, 333, 333]);
  assert.equal(B.splitTip(1000, ["us_a", "us_b", "us_c"]).reduce((s, x) => s + x.cents, 0), 1000);
  assert.deepEqual(B.splitTip(500, ["us_a", "us_a"]), [{ user_id: "us_a", cents: 500 }], "a tech listed twice is one tech");
  assert.deepEqual(B.splitTip(500, []), []);
  assert.deepEqual(B.splitTip(0, ["us_a"]), []);
});

test("the portal: the server charges the tip it worked out, whatever amount the page claims; a custom tip is capped; a deposit takes no tip", async () => {
  const { t, owner, tech, tech2 } = await setup();
  try {
    const c = await testContact(owner);
    const { invoice } = await jobInvoice(t, owner, c, { techs: [tech, tech2] });
    const cookie = await portalCookie(t, c.id, { kind: "invoice", id: invoice.id });
    const post = (body) => t.portal(`/api/portal/invoices/${invoice.id}/checkout`, { method: "POST", headers: PJSON, cookie, body });
    // a tampered page: asks for 15% and claims that is one cent, and that the invoice is $1
    const a = await post({ tip_choice: "15", tip_cents: 1, amount_cents: 100, balance_cents: 100, total_cents: 101 });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(a.body.data.tip_cents, 4425);
    let s = (await invoiceOf(invoice.id)).checkout_sessions.at(-1);
    assert.deepEqual([s.amount_cents, s.tip_cents], [29500, 4425]);
    // a choice that isn't offered, and nonsense
    assert.equal((await post({ tip_choice: "50" })).status, 400);
    assert.equal((await post({ tip_choice: "custom", custom_tip_cents: "lots" })).status, 400);
    // a custom tip over the cap is brought down to the invoice's own amount
    const b = await post({ tip_choice: "custom", custom_tip_cents: 9999999 });
    assert.equal(b.status, 200);
    assert.equal(b.body.data.tip_cents, 29500);
    const sid = b.body.data.url.split("/").pop();
    const done = await t.portal(`/api/portal/dry-checkout/${sid}`, { method: "POST", headers: PJSON, body: { action: "pay", method: "card" } });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const p = recs(t, "payment")[0];
    assert.deepEqual([p.amount_cents, p.tip_cents, p.total_cents], [29500, 29500, 59000]);
    // every cent of it to the two techs on the visit, evenly: this is what Payroll reads
    assert.deepEqual(p.tip_split.map((x) => [x.user_id, x.cents]).sort(), [[tech.id, 14750], [tech2.id, 14750]].sort());
    // a tip is never part of the invoice: paid in full, nothing over
    const inv = await invoiceOf(invoice.id);
    assert.deepEqual([inv.status, inv.paid_cents, inv.tips_cents, inv.balance_cents, inv.excess_cents], ["paid", 29500, 29500, 0, 0]);
    // a deposit: the page offers no tip and the server takes none even if asked
    const dep = await scope(async () => (await store.createRecord("invoice", { number: "SD-0001", seq: "deposit-shadow", n: 1, kind: "deposit", contact_id: c.id, status: "open", issued_on: "2026-11-17", due_on: "2026-11-17", lines: [{ id: "ln_1", kind: "service", description: "Deposit", qty_milli: 1000, unit_cents: 10000, total_cents: 10000 }] }, AS(owner))).data);
    const dc = await portalCookie(t, c.id, { kind: "invoice", id: dep.id });
    const page = await t.portal(`/p/invoice/${dep.id}`, { cookie: dc });
    assert.doesNotMatch(page.text, /tip_choice/);
    const d = await t.portal(`/api/portal/invoices/${dep.id}/checkout`, { method: "POST", headers: PJSON, cookie: dc, body: { tip_choice: "20" } });
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.equal(d.body.data.tip_cents, 0);
  } finally { t.done(); }
});

test("a cash tip the tech writes down on the visit goes to that visit's techs; the office can see who got what; a tech sees only their own visit", async () => {
  const { t, owner, tech, tech2 } = await setup();
  try {
    const c = await testContact(owner);
    const { invoice, visit } = await jobInvoice(t, owner, c, { techs: [tech] });
    const other = await jobInvoice(t, owner, await testContact(owner), { techs: [tech2] });
    const pay = await t.api(`/visits/${visit.id}/payments`, { method: "POST", as: tech, body: { method: "cash", amount_cents: 29500, tip_cents: 2001, client_id: uuid(61) } });
    assert.equal(pay.status, 201, JSON.stringify(pay.body));
    assert.deepEqual(Object.keys(pay.body.data.invoice).sort(), ["balance_cents", "id", "number", "status"], "a tech gets the short view (D11: no prices beyond what's left)");
    assert.equal(pay.body.data.invoice.status, "paid");
    const p = await paymentOf(pay.body.data.payment.id);
    assert.deepEqual(p.tip_split, [{ user_id: tech.id, cents: 2001 }]);
    assert.equal(p.recorded_by, tech.id);
    assert.equal(p.job_id, invoice.job_ids[0]);
    // the same tap again (a slow answer): one payment
    const again = await t.api(`/visits/${visit.id}/payments`, { method: "POST", as: tech, body: { method: "cash", amount_cents: 29500, tip_cents: 2001, client_id: uuid(61) } });
    assert.equal(again.status, 200);
    assert.equal(recs(t, "payment").length, 1);
    // not their visit: not theirs to collect on, or even to see
    assert.equal((await t.api(`/visits/${other.visit.id}/payments`, { method: "POST", as: tech, body: { method: "cash", amount_cents: 100, client_id: uuid(62) } })).status, 404);
    assert.equal((await t.api(`/visits/${other.visit.id}/payment`, { as: tech })).status, 404);
    assert.equal((await t.api(`/invoices/${other.invoice.id}`, { as: tech })).status, 404);
    assert.equal((await t.api("/invoices", { as: tech })).status, 403);
    assert.equal((await t.api("/payments", { as: tech })).status, 403);
    // a tip can't be bigger than makes sense, or negative
    assert.equal((await t.api(`/visits/${other.visit.id}/payments`, { method: "POST", as: tech2, body: { method: "cash", amount_cents: 100, tip_cents: -5, client_id: uuid(63) } })).status, 400);
    assert.equal((await t.api(`/visits/${other.visit.id}/payments`, { method: "POST", as: tech2, body: { method: "card", amount_cents: 100, client_id: uuid(64) } })).status, 400, "a tech records cash or a check; cards go through the customer's own phone");
    // the office's month: tips are their own number
    const list = await t.api("/payments?month=2026-11", { as: owner });
    assert.deepEqual([list.body.meta.totals.tips_cents, list.body.meta.totals.collected_cents], [2001, 31501]);
  } finally { t.done(); }
});
