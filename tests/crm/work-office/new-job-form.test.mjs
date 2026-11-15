// The New job form (Flyra's sheet, Nov 15): what POST /jobs takes from it
// beyond the lines and the first visit: its discounts ("Add discount"),
// the checklist it picked (one by key, or none), the salesperson, and
// "Notify the customer" off (no confirmation text for that booking; a
// later move is confirmed as usual). Synthetic data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, customer, store, drain, outbox, pin, AS } from "./fixtures.mjs";

const LINE = { title: "Exterior window cleaning", unit_cents: 30000, service_type: "Residential Window Cleaning" };

test("New job: discounts, a picked checklist (or none), the salesperson", async () => {
  const { t, owner, tech } = await setup();
  try {
    const c = await customer(owner);
    const r = await t.api("/jobs", { method: "POST", as: owner, body: {
      contact_id: c.id, lines: [LINE], discounts: [{ name: "Neighbor deal", type: "fixed", value: 2500 }, { type: "percentage", value: 1000 }],
      checklist_key: "gutters", sold_by: owner.id, client_id: "nj-form-0001",
      visit: { date: "2026-11-24", start: "08:00", end: "10:00", window: { type: "window", minutes: 120 }, assignee_ids: [tech.id] },
    } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const job = (await store.getRecord("job", r.body.data.job.id)).data;
    assert.deepEqual(job.discounts.map((d) => [d.id, d.name, d.type, d.value]), [["dc_1", "Neighbor deal", "fixed", 2500], ["dc_2", "Discount", "percentage", 1000]]);
    assert.equal(job.totals.total_cents, 30000 - 3000 - 2500, "percent first, then the amount");
    assert.equal(job.checklist_key, "gutters");
    assert.equal(job.sold_by, owner.id);
    assert.equal(r.body.data.visit.checklist.template_key, "gutters", "the picked checklist, not the one by service type");

    const none = await t.api("/jobs", { method: "POST", as: owner, body: { contact_id: c.id, lines: [LINE], checklist_key: "none", client_id: "nj-form-0002", visit: { date: "2026-11-25", start: "08:00", end: "10:00" } } });
    assert.equal(none.status, 201, JSON.stringify(none.body));
    assert.deepEqual(none.body.data.visit.checklist.items, [], "no checklist");

    const auto = await t.api("/jobs", { method: "POST", as: owner, body: { contact_id: c.id, lines: [LINE], client_id: "nj-form-0003", visit: { date: "2026-11-26", start: "08:00", end: "10:00" } } });
    assert.equal(auto.body.data.visit.checklist.template_key, "windows_exterior", "nothing picked: by the work, as before");

    for (const bad of [{ checklist_key: "Not A Key" }, { sold_by: "us_00000000000000000000" }, { sold_by: "nobody" }, { discounts: [{ type: "fixed", value: 0 }] }]) {
      const x = await t.api("/jobs", { method: "POST", as: owner, body: { contact_id: c.id, lines: [LINE], ...bad } });
      assert.equal(x.status, 400, JSON.stringify(bad));
    }
  } finally { t.done(); }
});

test("Notify the customer off: no confirmation for that booking; moved later, it is confirmed", async () => {
  const { t, owner, tech } = await setup();
  try {
    const c = await customer(owner);
    const quiet = await t.api("/jobs", { method: "POST", as: owner, body: { contact_id: c.id, lines: [LINE], client_id: "nj-form-0101", visit: { date: "2026-12-08", start: "08:00", end: "10:00", assignee_ids: [tech.id], notify: false } } });
    assert.equal(quiet.status, 201, JSON.stringify(quiet.body));
    const v = quiet.body.data.visit;
    assert.equal(v.no_confirm, "2026-12-08 08:00");
    const loud = await t.api("/jobs", { method: "POST", as: owner, body: { contact_id: c.id, lines: [LINE], client_id: "nj-form-0102", visit: { date: "2026-12-09", start: "08:00", end: "10:00", assignee_ids: [tech.id] } } });
    const v2 = loud.body.data.visit;
    assert.equal(v2.no_confirm, undefined);
    await drain(t, 4);
    pin("2026-11-17T15:20:00Z"); await drain(t, 4);
    const conf = (id) => outbox(t).filter((o) => o.template_key === "visit_confirm" && o.related && o.related.visit_id === id);
    assert.equal(conf(v.id).length, 0, "notify off: nothing");
    assert.equal(conf(v2.id).length, 1, "notify on: the usual dry-run confirmation");
    // moved later: confirmed at the new time
    const cur = await store.getRecord("visit", v.id);
    const mv = await t.api(`/visits/${v.id}`, { method: "PATCH", as: owner, ifMatch: cur.etag, body: { date: "2026-12-10" } });
    assert.equal(mv.status, 200, JSON.stringify(mv.body));
    await drain(t, 4);
    pin("2026-11-17T15:40:00Z"); await drain(t, 4);
    assert.equal(conf(v.id).length, 1, "the move is confirmed");
    // POST /visits takes it too (a multi-day job's other days)
    const more = await t.api("/visits", { method: "POST", as: owner, body: { job_id: quiet.body.data.job.id, date: "2026-12-11", start: "08:00", end: "10:00", notify: false, client_id: "nj-form-0103-v2" } });
    assert.equal(more.status, 201, JSON.stringify(more.body));
    assert.equal(more.body.data.visit.no_confirm, "2026-12-11 08:00");
  } finally { t.done(); }
});

test("the salesperson of a New job is its seller for payroll when no plan or quote names one", async () => {
  const { t, owner } = await setup();
  try {
    const P = await import("../../../netlify/lib/crm/modules/payroll/periods.mjs");
    const c = await customer(owner);
    const r = await t.api("/jobs", { method: "POST", as: owner, body: { contact_id: c.id, lines: [LINE], sold_by: owner.id, client_id: "nj-form-0201" } });
    const id = r.body.data.job.id;
    await store.updateRecord("job", id, (j) => ({ ...j, status: "completed", completed_at: "2026-11-17T16:00:00.000Z" }), AS(owner));
    const users = [{ id: owner.id, name: "Olive Owner", first_name: "Olive", pay: { commission_bp: { salesman: 500 } } }];
    const { jobs } = await store.withStoreScope({ requestId: "t" }, () => P.finishedJobs("2026-11-01", "2026-11-30", users, { min_segment_minutes: 0 }));
    const j = jobs.find((x) => x.id === id);
    assert.ok(j, "the finished job is there");
    assert.equal(j.own_seller, owner.id);
  } finally { t.done(); }
});
