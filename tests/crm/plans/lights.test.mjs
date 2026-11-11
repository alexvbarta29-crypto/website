// M3b gate: "the lights op creates install, takedown and season record"
// (design §5.4 "Christmas lights seasons", D9, D30): a lights plan's season,
// a one-time lights quote's season (quote.converted), the season following
// its jobs, the bin that stores it (and the property remembers), a warranty
// visit, the board, and the January takedown sweep.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, staffPlan, customer, planOf, recOf, finishRun, drain, pin, scope, store, WORK, LT, AS, fakeServices } from "./fixtures.mjs";

const LIGHTS = [
  { title: "Christmas Light Installation", qty_milli: 150000, unit_cents: 800, unit: "ft", service_type: "Christmas Lights", description: "Roofline 150 ft. Colors: warm white, red" },
  { title: "Christmas Light Materials", qty_milli: 150000, unit_cents: 200, unit: "ft", service_type: "Christmas Lights", scope: { type: "initial" } },
  { title: "Takedown and Storage", qty_milli: 1000, unit_cents: 0, service_type: "Christmas Lights" },
];
const EARLY = [{ key: "early_bird", name: "Early Bird", type: "percentage", value: 5000, scope: { type: "initial" } }];

test("a lights plan: install, takedown and the season record in one op; the season follows its jobs; the bin stores it", async () => {
  const { t, owner, tech } = await setup();
  try {
    const { plan } = await staffPlan(t, owner, { catalog_key: "lights_annual", lines: LIGHTS, discounts: EARLY });
    assert.equal(plan.kind, "lights_annual");
    assert.equal(plan.billing.mode, "after_visit");
    assert.equal(plan.season_install_ids.length, 1);
    const s = await recOf("season_install", plan.season_install_ids[0]);
    assert.equal(s.season, 2026);
    assert.equal(s.status, "sold");
    assert.equal(s.plan_id, plan.id);
    assert.equal(s.footage_ft, 150);
    assert.deepEqual(s.colors, ["warm_white", "red"]);
    assert.equal(s.early_bird, true);
    assert.equal(t.stores.data.json(`ptr/season/${s.property_id}--2026`).id, s.id, "one season per property and year");
    const install = await recOf("job", s.install_job_id);
    assert.equal(install.kind, "lights_install");
    assert.equal(install.target_month, "2026-11");
    assert.equal(install.totals.total_cents, 75000, "($1,200 + $300) at 50% off, the takedown line on its own job");
    assert.ok(!install.lines.some((l) => /takedown/i.test(l.title)));
    assert.equal(plan.ordinals[0].job_id, install.id, "the plan's visit is the install");
    const takedown = await recOf("job", s.takedown_job_id);
    assert.equal(takedown.kind, "lights_takedown");
    assert.equal(takedown.status, "unscheduled");
    assert.equal(takedown.target_month, "2027-01");
    assert.equal(takedown.billable, false);
    assert.deepEqual(takedown.lines.map((l) => [l.title, l.total_cents]), [["Takedown + storage (included)", 0]]);
    // the install booked and done, the takedown booked and done
    const W = { write: () => AS(owner) };
    await scope(() => WORK.createVisit({ job_id: install.id, date: "2026-11-20", start: "09:00", end: "12:00", assignee_ids: [tech.id] }, W));
    await drain(t, 2);
    assert.equal((await recOf("season_install", s.id)).status, "install_scheduled");
    await scope(() => WORK.completeJob(install.id, W));
    await drain(t, 2);
    const s2 = await recOf("season_install", s.id);
    assert.equal(s2.status, "installed");
    assert.equal(s2.installed_on, "2026-11-17");
    assert.equal((await planOf(plan.id)).ordinals[0].status, "completed");
    pin("2027-01-06T15:00:00Z");
    const o2 = await t.user("owner");
    await scope(() => WORK.createVisit({ job_id: takedown.id, date: "2027-01-08", start: "09:00", end: "11:00", assignee_ids: [tech.id] }, { write: () => AS(o2) }));
    await drain(t, 2);
    assert.equal((await recOf("season_install", s.id)).status, "takedown_scheduled");
    await scope(() => WORK.completeJob(takedown.id, { write: () => AS(o2) }));
    await drain(t, 2);
    assert.equal((await recOf("season_install", s.id)).status, "taken_down");
    const board = await t.api("/lights/seasons/2026", { as: o2 });
    assert.equal(board.status, 200);
    assert.equal(board.body.data.needs_bin, 1);
    assert.equal(board.body.data.footage_ft, 150);
    // the crew's bin: stored, and the property remembers it
    const g = await t.api(`/lights/installs/${s.id}`, { method: "PATCH", as: o2, body: { bin_id: "B-14" } });
    assert.equal(g.status, 200, JSON.stringify(g.body));
    assert.equal(g.body.data.status, "stored");
    const prop = await recOf("property", s.property_id);
    assert.equal(prop.lights.bin_id, "B-14");
    assert.equal(prop.lights.last_season, 2026);
    assert.equal((await t.api(`/lights/installs/${s.id}`, { method: "PATCH", as: o2, body: { colors: ["purple"] } })).status, 400);
    assert.equal((await t.api("/lights/seasons/1999", { as: o2 })).status, 404);
  } finally { t.done(); }
});

test("a one-time lights job from a quote (\"this season only\"): the takedown and the season record from quote.converted", async () => {
  const { t, owner } = await setup();
  try {
    const c = await customer(owner);
    // what the quotes convert step makes through work.createJobs (scope quotes)
    const [jobId] = await scope(async () => (await import("../../../netlify/lib/crm/core/services.mjs")).call("work.createJobs", [{ contact_id: c.id, property_id: c.primary_property_id, kind: "lights_install", title: "Christmas lights (SQ-0001)", lines: LIGHTS.map((l, i) => ({ id: `ln_${i}`, ...l })), discounts: [], quote_id: "qt_00000000000000000001", billable: true }], "convert--qt_00000000000000000001--1", "quotes", AS(owner)));
    await scope(async () => (await import("../../../netlify/lib/crm/core/events.mjs")).emit("quote.converted", { id: "qt_00000000000000000001", wv: 5, quote_id: "qt_00000000000000000001", version_id: "qv_00000000000000000001", contact_id: c.id, job_ids: [jobId] }, AS(owner)));
    await drain(t, 3);
    const seasons = t.stores.data.keys("rec/season_install/").map((k) => t.stores.data.json(k));
    assert.equal(seasons.length, 1);
    assert.equal(seasons[0].install_job_id, jobId);
    assert.equal(seasons[0].quote_id, "qt_00000000000000000001");
    const td = await recOf("job", seasons[0].takedown_job_id);
    assert.equal(td.kind, "lights_takedown");
    assert.equal(td.target_month, "2027-01");
    // the same event again: nothing twice
    await scope(async () => (await import("../../../netlify/lib/crm/core/events.mjs")).emit("quote.converted", { id: "qt_00000000000000000001", wv: 6, quote_id: "qt_00000000000000000001", version_id: "qv_00000000000000000001", contact_id: c.id, job_ids: [jobId] }, AS(owner)));
    await drain(t, 3);
    assert.equal(t.stores.data.keys("rec/season_install/").length, 1);
    assert.equal(t.stores.data.keys("rec/job/").filter((k) => t.stores.data.json(k).kind === "lights_takedown").length, 1);
    // a warranty fix: a $0 job linked to the season
    const w = await t.api(`/lights/installs/${seasons[0].id}/warranty`, { method: "POST", as: owner, body: { notes: "Two bulbs out on the garage run." } });
    assert.equal(w.status, 201, JSON.stringify(w.body));
    const wj = await recOf("job", w.body.data.job_id);
    assert.equal(wj.kind, "lights_warranty");
    assert.equal(wj.billable, false);
    assert.equal(wj.totals.total_cents, 0);
    assert.deepEqual(w.body.data.season.warranty_job_ids, [wj.id]);
  } finally { t.done(); }
});

test("lights.takedown_due (Jan 2): an installed season with no takedown job gets one; the office hears how many to book", async () => {
  const { t, owner } = await setup("2026-12-20T15:00:00Z");
  try {
    const c = await customer(owner);
    const s = await scope(async () => (await store.createRecord("season_install", { contact_id: c.id, property_id: c.primary_property_id, season: 2026, status: "installed", warranty_job_ids: [], design_file_ids: [], footage_ft: 80 }, AS(owner))).data);
    pin("2027-01-02T13:00:00Z");
    await drain(t, 2);
    const s2 = await recOf("season_install", s.id);
    assert.ok(s2.takedown_job_id, "a takedown job");
    const td = await recOf("job", s2.takedown_job_id);
    assert.equal(td.target_month, "2027-01");
    assert.ok(t.stores.data.keys("rec/notification/").map((k) => t.stores.data.json(k)).some((n) => n.title === "Takedowns to book"));
  } finally { t.done(); }
});

test("the pure helpers: install month, footage, colors, lines without the takedown", () => {
  assert.equal(LT.installMonth(2026, "2026-09-01", {}), "2026-11");
  assert.equal(LT.installMonth(2026, "2026-12-03", {}), "2026-12");
  assert.equal(LT.footageOf([{ unit: "ft", title: "Christmas Light Installation", qty_milli: 151500 }]), 152);
  assert.deepEqual(LT.colorsOf([{ description: "Colors: red, green" }]), ["red", "green"]);
  assert.deepEqual(LT.installLines([{ id: "a", title: "Lights" }, { id: "b", title: "Takedown and Storage" }, { id: "c", title: "In-Season Material Warranty", category: "warranty" }]).map((l) => l.id), ["a"]);
  assert.equal(LT.seasonStatusFor({ status: "sold" }, { status: "completed" }, { status: "unscheduled" }), "installed");
  assert.equal(LT.seasonStatusFor({ status: "stored" }, { status: "completed" }, { status: "completed" }), "stored");
  assert.equal(fakeServices !== undefined, true);
});
