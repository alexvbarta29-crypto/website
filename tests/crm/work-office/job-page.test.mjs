// The Rotor-style job page's two new abilities (Nov 2026, Track B):
//   "+ Add discount" on the Pricing card: PATCH /jobs/:id { discounts } (an
//     amount or a percent, a name if given), priced into the job's totals and
//     into the invoice made from the job;
//   "Create Invoice": POST /jobs/:id/invoice (the job's own invoice slot, so
//     marking the job done later never bills it twice).
// Synthetic data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, customer, job, visit, store, AS, drain } from "./fixtures.mjs";

const { formDiscounts, mergeDiscounts } = await import("../../../netlify/lib/crm/modules/work/office-routes.mjs");
const etagOf = async (type, id) => (await store.getRecord(type, id)).etag;
const patch = (t, as, id, body) => etagOf("job", id).then((e) => t.api(`/jobs/${id}`, { method: "PATCH", as, ifMatch: e, body }));

test("formDiscounts: an amount or a percent, a name if given; anything else is refused with its field", () => {
  assert.equal(formDiscounts(undefined), undefined);
  assert.deepEqual(formDiscounts([{ type: "fixed", value: 2500, name: " Neighbor deal ", scope: { type: "initial" }, def_id: "x" }, { type: "percentage", value: 1000 }]),
    [{ name: "Neighbor deal", type: "fixed", value: 2500 }, { type: "percentage", value: 1000 }], "never a scope or a catalog id from the page");
  assert.deepEqual(formDiscounts([{ id: "dc_1", type: "fixed", value: 1 }]), [{ id: "dc_1", type: "fixed", value: 1 }]);
  assert.deepEqual(formDiscounts([{ id: "<script>", type: "fixed", value: 1 }]), [{ type: "fixed", value: 1 }], "a strange id is dropped");
  const why = (list) => { try { formDiscounts(list); return null; } catch (e) { return e.field || e.message; } };
  assert.equal(why("nope"), "discounts");
  assert.equal(why(Array.from({ length: 21 }, () => ({ type: "fixed", value: 1 }))), "discounts");
  assert.equal(why([null]), "discounts.0");
  assert.equal(why([{ type: "bogus", value: 1 }]), "discounts.0.type");
  for (const value of [0, -5, 1.5, "100", 100000001, null]) assert.equal(why([{ type: "fixed", value }]), "discounts.0.value", String(value));
  for (const value of [0, 10001, 12.5]) assert.equal(why([{ type: "percentage", value }]), "discounts.0.value", String(value));
  assert.equal(why([{ type: "percentage", value: 10000 }]), null, "100% is allowed (never below $0)");
});

test("mergeDiscounts: by id a discount keeps its scope and catalog id; a new one covers every visit; one left out is gone", () => {
  const stored = [{ id: "dc_3", def_id: "dd_00000000000000000001", name: "Plan discount", type: "fixed", value: 3550, scope: { type: "after_initial" }, stack_group: "plan" }];
  assert.deepEqual(mergeDiscounts(stored, [{ id: "dc_3", type: "fixed", value: 3000 }, { type: "percentage", value: 500, name: "Senior" }]), [
    { id: "dc_3", def_id: "dd_00000000000000000001", name: "Plan discount", type: "fixed", value: 3000, scope: { type: "after_initial" }, stack_group: "plan" },
    { id: "dc_4", name: "Senior", type: "percentage", value: 500, scope: { type: "all" } },
  ]);
  assert.deepEqual(mergeDiscounts(stored, []), []);
  assert.deepEqual(mergeDiscounts([], [{ type: "fixed", value: 100 }]), [{ id: "dc_1", name: "Discount", type: "fixed", value: 100, scope: { type: "all" } }], "a name is optional");
  assert.equal(mergeDiscounts(stored, [{ id: "dc_3", type: "fixed", value: 1 }, { id: "dc_3", type: "fixed", value: 2 }])[1].id, "dc_4", "an id used twice: the second is new");
});

test("PATCH /jobs/:id discounts: priced into the totals (percent first, never below $0), kept by id, removed, refused when closed; the office only", async () => {
  const { t, owner, tech } = await setup();
  try {
    const c = await customer(owner);
    const j = await job(owner, c, { lines: [{ title: "Exterior window cleaning", qty_milli: 1000, unit_cents: 29500 }, { title: "Screens", qty_milli: 12000, unit_cents: 500 }] });
    assert.equal(j.totals.total_cents, 35500);
    let r = await patch(t, owner, j.id, { discounts: [{ type: "fixed", value: 2500, name: "Neighbor deal" }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    let now = r.body.data.job;
    assert.deepEqual([now.totals.subtotal_cents, now.totals.discount_cents, now.totals.total_cents], [35500, 2500, 33000]);
    assert.deepEqual(now.discounts.map((d) => [d.id, d.name, d.type, d.value, d.scope.type]), [["dc_1", "Neighbor deal", "fixed", 2500, "all"]]);
    // a percent on top: 10% of $355 = $35.50 first, then $25
    r = await patch(t, owner, j.id, { discounts: [{ id: "dc_1", type: "fixed", value: 2500, name: "Neighbor deal" }, { type: "percentage", value: 1000 }] });
    now = r.body.data.job;
    assert.deepEqual([now.totals.discount_cents, now.totals.total_cents], [6050, 29450]);
    assert.equal(now.discounts[1].name, "Discount", "no name given: Discount");
    // never below $0
    r = await patch(t, owner, j.id, { discounts: [{ type: "fixed", value: 99999900 }] });
    assert.equal(r.body.data.job.totals.total_cents, 0);
    // a notes save without discounts leaves them alone; an empty list removes them
    r = await patch(t, owner, j.id, { crew_notes: "Dog in the yard" });
    assert.equal(r.body.data.job.discounts.length, 1);
    r = await patch(t, owner, j.id, { discounts: [] });
    assert.deepEqual([r.body.data.job.discounts.length, r.body.data.job.totals.total_cents], [0, 35500]);
    // hostile input
    r = await patch(t, owner, j.id, { discounts: [{ type: "fixed", value: -100 }] });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.field, "discounts.0.value");
    r = await patch(t, owner, j.id, { discounts: [{ type: "fixed", value: 100, name: "<img src=x onerror=alert(1)>".repeat(20) }] });
    assert.equal(r.status, 200, "a long name is cut, stored as text");
    assert.equal(r.body.data.job.discounts[0].name.length, 120);
    // a tech can't
    assert.equal((await patch(t, tech, j.id, { discounts: [] })).status, 403);
    // closed: the same list is fine, a change is refused
    await t.api(`/jobs/${j.id}/cancel`, { method: "POST", as: owner, body: { reason: "Moved away" } });
    const kept = (await store.getRecord("job", j.id)).data.discounts.map((d) => ({ id: d.id, name: d.name, type: d.type, value: d.value }));
    assert.equal((await patch(t, owner, j.id, { discounts: kept, crew_notes: "x" })).status, 200);
    r = await patch(t, owner, j.id, { discounts: [] });
    assert.equal(r.status, 409);
    assert.match(r.body.error.message, /closed/);
  } finally { t.done(); }
});

test("Create Invoice from the job: the discount is an invoice line, the totals match; asked again it's the same invoice; marking the job done never bills it twice", async () => {
  const { t, owner } = await setup();
  try {
    const c = await customer(owner);
    const j = await job(owner, c, { lines: [{ title: "Exterior window cleaning", qty_milli: 1000, unit_cents: 29500 }, { title: "Screens", qty_milli: 12000, unit_cents: 500 }] });
    await visit(owner, j, { date: "2026-11-17", start: "08:00", end: "10:00" });
    await patch(t, owner, j.id, { discounts: [{ type: "fixed", value: 3550, name: "Neighbor deal" }] });
    let r = await t.api(`/jobs/${j.id}/invoice`, { method: "POST", as: owner, body: { issue: false } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const inv = r.body.data.invoice;
    assert.equal(inv.status, "draft", "a draft the office looks over and sends");
    assert.deepEqual(inv.lines.filter((l) => l.kind === "discount").map((l) => [l.description, l.total_cents]), [["Neighbor deal", -3550]]);
    assert.equal(inv.total_cents, 31950, "the job's total");
    assert.deepEqual(inv.job_ids, [j.id]);
    await drain(t);
    assert.deepEqual((await store.getRecord("job", j.id)).data.invoice_ids, [inv.id], "the job knows its invoice");
    r = await t.api(`/jobs/${j.id}/invoice`, { method: "POST", as: owner, body: { issue: false } });
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.data.invoice.id, r.body.data.existed], [inv.id, true], "the same one, never a second");
    // the job's invoices for its page: the contact's rows, this job's marked
    const rows = (await t.api(`/invoices?contact=${c.id}`, { as: owner })).body.data;
    assert.deepEqual(rows.filter((x) => x.j === j.id).map((x) => x.id), [inv.id]);
    // done: the completion's own invoice is the same slot
    assert.equal((await t.api(`/jobs/${j.id}/complete`, { method: "POST", as: owner, body: {} })).status, 200);
    await drain(t, 6);
    const all = (await t.api(`/invoices?contact=${c.id}`, { as: owner })).body.data.filter((x) => x.j === j.id && x.st !== "void");
    assert.equal(all.length, 1, "one invoice for the job");
  } finally { t.done(); }
});

test("Create Invoice refuses what isn't billed: a job with nothing to bill", async () => {
  const { t, owner } = await setup();
  try {
    const c = await customer(owner);
    const j = await job(owner, c, { lines: [{ title: "Free touch-up", qty_milli: 1000, unit_cents: 0 }] });
    const r = await t.api(`/jobs/${j.id}/invoice`, { method: "POST", as: owner, body: { issue: false } });
    assert.equal(r.status, 409);
    assert.match(r.body.error.message, /nothing to bill/);
  } finally { t.done(); }
});
