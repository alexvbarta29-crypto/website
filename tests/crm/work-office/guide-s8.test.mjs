// The Rotor guide's Schedule gaps (guide-gaps S8, SC4, SC7, SC10, SC12): time
// blocks (time_off kind "block"), the Pending jobs of the dates on screen
// (and the overdue ones), the holidays' names, every person's route on one
// day for the Map tab.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, customer, SCH } from "./fixtures.mjs";

test("the pure pieces: pending by dates, blocks, holiday names, everyone's routes", () => {
  const rows = [
    { id: "jb_1", st: "unscheduled", tm: "2026-11", u: "1", tot: 100 }, { id: "jb_2", st: "unscheduled", tm: "2026-10", u: "2" },
    { id: "jb_3", st: "unscheduled", tm: null, u: "3" }, { id: "jb_4", st: "scheduled", tm: "2026-11", u: "4" }, { id: "jb_5", st: "unscheduled", tm: "2027-01", u: "5" },
  ];
  assert.deepEqual(SCH.pendingRows(rows, "2026-11-15", "2026-11-21").map((r) => r.id), ["jb_3", "jb_1"], "due these dates, or with no month");
  assert.deepEqual(SCH.pendingRows(rows, "2026-11-15", "2026-11-21", { overdue: true }).map((r) => r.id).sort(), ["jb_1", "jb_2", "jb_3"]);
  const blocks = SCH.blocksOf([{ id: "to_1", uid: "us_1", s: "2026-11-24T18:00:00.000Z", e: "2026-11-24T19:00:00.000Z", r: "Lunch", k: "block" }, { id: "to_2", uid: "us_1", s: "2026-11-24T00:00:00.000Z", e: null, r: "Off" }], "2026-11-23", "2026-11-29");
  assert.deepEqual(blocks, [{ id: "to_1", user_id: "us_1", date: "2026-11-24", start: "12:00", end: "13:00", label: "Lunch" }]);
  assert.deepEqual(SCH.holidaysIn("2026-11-22", "2026-11-28"), { "2026-11-26": "Thanksgiving" });
  assert.deepEqual(SCH.holidaysIn("2026-12-20", "2026-12-26", { rules: ["christmas"], dates: ["2026-12-24"] }), { "2026-12-24": "Closed", "2026-12-25": "Christmas" });
  const r = SCH.dayRoutes([
    { id: "vs_1", a: ["us_1"], o: { us_1: 2 }, s: "09:00", e: "10:00", st: "scheduled", cn: "Pat", geo: [45, -93.8] },
    { id: "vs_2", a: ["us_1"], o: { us_1: 1 }, s: "11:00", e: "12:00", st: "scheduled", cn: "Sam", pr: "pr_1" },
    { id: "vs_3", a: [], s: "13:00", e: "14:00", st: "scheduled", cn: "Lee" },
    { id: "vs_4", a: ["us_2"], s: "13:00", e: "14:00", st: "cancelled", cn: "Gone" },
  ], new Map([["pr_1", { geo: { lat: 45.1, lng: -93.7 } }]]));
  assert.deepEqual(r.routes.map((x) => [x.user_id, x.stops.map((s) => s.id)]), [["us_1", ["vs_2", "vs_1"]]], "in drive order; cancelled left out");
  assert.deepEqual(r.routes[0].stops[0].geo, [45.1, -93.7], "the property's map point");
  assert.equal(r.no_person, 1);
  assert.equal(r.no_address, 1);
});

test("the API: a time block on the schedule; Pending by dates; the holidays; GET /schedule/routes", async () => {
  const { t, owner, tech } = await setup();
  try {
    // a block: part of one day only
    const bad = await t.api("/time-off", { method: "POST", as: owner, body: { user_id: tech.id, date: "2026-11-24", kind: "block", reason: "Truck service" } });
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
    const b = await t.api("/time-off", { method: "POST", as: owner, body: { user_id: tech.id, date: "2026-11-24", start: "12:00", end: "13:00", kind: "block", reason: "Truck service" } });
    assert.equal(b.status, 201, JSON.stringify(b.body));
    assert.equal(b.body.data.time_off.kind, "block");
    const sc = await t.api("/schedule?from=2026-11-22&to=2026-11-28", { as: owner });
    assert.equal(sc.status, 200);
    assert.deepEqual(sc.body.data.blocks.map((x) => [x.user_id, x.date, x.start, x.end, x.label]), [[tech.id, "2026-11-24", "12:00", "13:00", "Truck service"]]);
    assert.deepEqual(sc.body.data.holidays, { "2026-11-26": "Thanksgiving" });
    // pending: a job due this month, and one due last month (overdue)
    const c = await customer(owner, {}, { geo: [45.07, -93.79] });
    const j1 = await t.api("/jobs", { method: "POST", as: owner, body: { contact_id: c.id, target_month: "2026-11", lines: [{ title: "Windows", unit_cents: 25000, service_type: "Exterior Cleaning" }] } });
    assert.equal(j1.status, 201, JSON.stringify(j1.body));
    const j2 = await t.api("/jobs", { method: "POST", as: owner, body: { contact_id: c.id, target_month: "2026-10", lines: [{ title: "Gutters", unit_cents: 15000, service_type: "Exterior Cleaning" }] } });
    let p = await t.api("/schedule/unscheduled?from=2026-11-22&to=2026-11-28", { as: owner });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.deepEqual(p.body.data.jobs.map((x) => x.id), [j1.body.data.job.id]);
    p = await t.api("/schedule/unscheduled?from=2026-11-22&to=2026-11-28&overdue=1", { as: owner });
    assert.deepEqual(p.body.data.jobs.map((x) => x.id), [j2.body.data.job.id, j1.body.data.job.id]);
    assert.equal(p.body.data.total_cents, 40000);
    assert.equal((await t.api("/schedule/unscheduled?from=2026-11-28&to=2026-11-22", { as: owner })).status, 400);
    // everyone's route on a day
    const v = await t.api("/visits", { method: "POST", as: owner, body: { job_id: j1.body.data.job.id, date: "2026-11-24", start: "08:00", end: "10:00", window: { type: "exact" }, assignee_ids: [tech.id] } });
    assert.equal(v.status, 201, JSON.stringify(v.body));
    const r = await t.api("/schedule/routes?date=2026-11-24", { as: owner });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.data.routes.map((x) => [x.user_id, x.stops.length]), [[tech.id, 1]]);
    assert.ok(Array.isArray(r.body.data.routes[0].stops[0].geo), "the stop's map point");
    assert.equal(r.body.data.no_person, 0);
    assert.equal((await t.api("/schedule/routes?date=nope", { as: owner })).status, 400);
    assert.equal((await t.api("/schedule/routes?date=2026-11-24", { as: tech })).status, 403);
  } finally { t.done(); }
});

test("the Map tab's drawing: a route per person in their color, a hidden person left out, nothing without map points", async () => {
  const S = await import("../../../crm-app/modules/work/office-schedule.js");
  const routes = [
    { user_id: "us_1", stops: [{ id: "v1", n: 1, cn: "Pat <b>", geo: [45, -93.8] }, { id: "v2", n: 2, cn: "Sam", geo: [45.1, -93.7] }] },
    { user_id: "us_2", stops: [{ id: "v3", n: 1, cn: "Lee", geo: [45.05, -93.75] }] },
  ];
  const h = String(S.routesSvg(routes, new Map([["us_1", "#ff0000"], ["us_2", "#00aa00"]])));
  assert.match(h, /stroke="#ff0000"/);
  assert.match(h, /stroke="#00aa00"/);
  assert.equal((h.match(/<circle/g) || []).length, 3);
  assert.ok(!h.includes("<b>"), "escaped");
  assert.equal((String(S.routesSvg(routes, new Map(), new Set(["us_1"]))).match(/<circle/g) || []).length, 1, "a hidden person");
  assert.match(String(S.routesSvg([{ user_id: "us_1", stops: [{ id: "v1", n: 1, geo: null }] }])), /No stops with a map point/);
});
