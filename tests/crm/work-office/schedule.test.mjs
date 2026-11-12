// M4a acceptance (design §11.4 "schedule.test.mjs"): GET /schedule returns
// visits and timed tasks; a visit overlapping an estimate task warns. Plus
// the other warnings (never blocking), the booking hint and the tray.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, customer, job, visit, store, AS, SCH, OFF, LINES } from "./fixtures.mjs";

const task = (as, fields) => store.createRecord("task", { title: "Estimate at the Example house", kind: "estimate_visit", priority: "medium", status: "open", ...fields }, AS(as));

test("GET /schedule returns visits and timed tasks; a visit overlapping an estimate task warns", async () => {
  const { t, owner, tech, tech2 } = await setup();
  try {
    const c = await customer(owner, {}, { town: "Mound" });
    const j = await job(owner, c);
    const v = await visit(owner, j, { date: "2026-11-24", start: "09:00", end: "11:00", assignee_ids: [tech.id] });
    const other = await visit(owner, await job(owner, await customer(owner)), { date: "2026-11-24", start: "13:00", end: "15:00", assignee_ids: [tech2.id] });
    // Tuesday Nov 24, 10:00-11:00 local = 16:00-17:00 UTC
    await task(owner, { due_at: "2026-11-24T16:00:00.000Z", end_at: "2026-11-24T17:00:00.000Z", assignee_ids: [tech.id] });
    await task(owner, { title: "Call back", kind: "call", due_at: "2026-11-24T16:00:00.000Z", end_at: "2026-11-24T17:00:00.000Z", assignee_ids: [tech.id] });
    await task(owner, { title: "Dentist", kind: "personal", due_at: "2026-11-25T16:00:00.000Z", assignee_ids: [tech.id] });   // no end: not a block

    const r = await t.api("/schedule?from=2026-11-23&to=2026-11-29", { as: owner });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const d = r.body.data;
    assert.deepEqual(d.visits.map((x) => x.id).sort(), [v.id, other.id].sort());
    assert.equal(d.tasks.length, 1, "only timed estimate visits, meetings and personal blocks");
    assert.equal(d.tasks[0].kind, "estimate_visit");
    assert.deepEqual([d.tasks[0].date, d.tasks[0].start, d.tasks[0].end], ["2026-11-24", "10:00", "11:00"]);
    const w = d.warnings[v.id] || [];
    assert.ok(w.some((x) => x.code === "overlap_task" && x.user_id === tech.id), JSON.stringify(w));
    assert.equal(d.warnings[other.id], undefined, "no warning for the other tech");

    // one tech's view
    const one = await t.api(`/schedule?from=2026-11-24&to=2026-11-24&users=${tech2.id}`, { as: owner });
    assert.deepEqual(one.body.data.visits.map((x) => x.id), [other.id]);
    assert.equal(one.body.data.tasks.length, 0);

    // techs work from their own day, never the schedule
    assert.equal((await t.api("/schedule?from=2026-11-23&to=2026-11-29", { as: tech })).status, 403);
    assert.equal((await t.api("/schedule/unscheduled", { as: tech })).status, 403);
    assert.equal((await t.api("/schedule?from=2026-11-01&to=2027-01-30", { as: owner })).status, 400, "a range of 6 weeks at most");
  } finally { t.done(); }
});

test("the slot check warns (holiday, closed, outside hours, not working, time off, another visit) and hints a crew in town", async () => {
  const { t, owner, tech, tech2 } = await setup();
  try {
    await store.updateRecord("user", tech.id, (u) => ({ ...u, availability: [1, 2, 3, 4, 5].map((dow) => ({ dow, start: "08:00", end: "16:00" })) }), AS(owner));
    const c = await customer(owner, {}, { town: "Mound" });
    await visit(owner, await job(owner, c), { date: "2026-11-24", start: "09:00", end: "11:00", assignee_ids: [tech2.id] });
    const off = await t.api("/time-off", { method: "POST", as: owner, body: { user_id: tech2.id, date: "2026-11-25", reason: "Vacation" } });
    assert.equal(off.status, 201, JSON.stringify(off.body));
    const codes = async (q) => {
      const r = await t.api(`/schedule/check?${q}`, { as: owner });
      assert.equal(r.status, 200);
      return { w: r.body.data.warnings.map((x) => x.code), h: r.body.data.hints.map((x) => x.code), msg: r.body.data.warnings.map((x) => x.message) };
    };
    assert.deepEqual((await codes(`date=2026-11-26&start=09:00&end=11:00`)).w, ["holiday"], "Thanksgiving");
    assert.ok((await codes(`date=2026-11-22&start=09:00&end=11:00`)).w.includes("closed"), "Sunday");
    assert.ok((await codes(`date=2026-11-24&start=17:00&end=19:00`)).w.includes("outside_hours"));
    assert.deepEqual((await codes(`date=2026-11-24&start=15:00&end=17:00&users=${tech.id}`)).w, ["unavailable"], "works 8-4 that day");
    const mine = await codes(`date=2026-11-24&start=10:00&end=12:00&users=${tech2.id}&town=Mound`);
    assert.deepEqual(mine.w, ["overlap_visit"]);
    assert.deepEqual(mine.h, ["crew_in_town"]);
    assert.ok(mine.msg[0].includes("Tess"), "names the tech");
    const vac = await codes(`date=2026-11-25&start=09:00&end=11:00&users=${tech2.id}`);
    assert.deepEqual(vac.w, ["time_off"]);
    // a booking still goes through: warnings never block
    const j2 = await job(owner, await customer(owner));
    const b = await t.api("/visits", { method: "POST", as: owner, body: { job_id: j2.id, date: "2026-11-25", start: "09:00", end: "11:00", window: { type: "window", minutes: 120 }, assignee_ids: [tech2.id] } });
    assert.equal(b.status, 201, JSON.stringify(b.body));
    assert.deepEqual(b.body.meta.warnings.map((x) => x.code), ["time_off"]);
  } finally { t.done(); }
});

test("the tray: unscheduled jobs due by the month (takedowns targeted for January wait until then)", async () => {
  const { t, owner } = await setup();
  try {
    const c = await customer(owner);
    const now_ = await job(owner, c, { title: "Window cleaning" });
    const jan = await job(owner, c, { kind: "lights_takedown", lines: [], target_month: "2027-01" });
    const booked = await job(owner, c);
    await visit(owner, booked);
    const nov = await t.api("/schedule/unscheduled?month=2026-11", { as: owner });
    assert.equal(nov.status, 200);
    assert.deepEqual(nov.body.data.jobs.map((r) => r.id), [now_.id]);
    assert.equal(nov.body.data.later, 1);
    const janR = await t.api("/schedule/unscheduled?month=2027-01", { as: owner });
    assert.deepEqual(janR.body.data.jobs.map((r) => r.id).sort(), [now_.id, jan.id].sort());
    assert.equal(janR.body.data.jobs.find((r) => r.id === jan.id).k, "lights_takedown");
    assert.equal(janR.body.data.jobs.find((r) => r.id === jan.id).bill, false, "takedowns are not billed");
  } finally { t.done(); }
});

test("the month view: GET /schedule?month= reads the whole grid (Sunday first, the leading and trailing days) in one request, with job totals for people who may see prices", async () => {
  const { t, owner, admin, tech } = await setup();
  try {
    assert.deepEqual(SCH.monthGridRange("2026-11"), ["2026-11-01", "2026-12-05"], "November 2026 starts on a Sunday: five weeks");
    assert.deepEqual(SCH.monthGridRange("2026-08"), ["2026-07-26", "2026-09-05"], "August 2026: six weeks, 42 days");
    assert.deepEqual(SCH.monthGridRange("2026-02"), ["2026-02-01", "2026-02-28"], "February 2026: four weeks");
    assert.deepEqual(SCH.monthGridRange("2027-03"), ["2027-02-28", "2027-04-03"], "a month over the DST change");
    for (const bad of ["2026-13", "2026-1", "nope", ""]) assert.throws(() => SCH.monthGridRange(bad), /month like/);

    const c = await customer(owner, {}, { town: "Mound" });
    const lead = await visit(owner, await job(owner, c), { date: "2026-11-01", start: "09:00", end: "11:00", assignee_ids: [tech.id] });
    const trail = await visit(owner, await job(owner, c, { lines: [{ ...LINES[0], unit_cents: 41000 }] }), { date: "2026-12-04", start: "13:00", end: "15:00", assignee_ids: [tech.id] });
    const free = await visit(owner, await job(owner, c, { kind: "touch_up", lines: [{ title: "Touch-up", qty_milli: 1000, unit_cents: 0 }] }), { date: "2026-11-20" });
    await visit(owner, await job(owner, c), { date: "2026-12-06" });            // the Sunday after the grid
    await visit(owner, await job(owner, c), { date: "2026-10-31" });            // the Saturday before it

    const r = await t.api("/schedule?month=2026-11&amounts=1", { as: owner });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const d = r.body.data;
    assert.deepEqual([d.from, d.to, d.month, d.today], ["2026-11-01", "2026-12-05", "2026-11", "2026-11-17"]);
    assert.deepEqual(d.visits.map((v) => v.id).sort(), [lead.id, trail.id, free.id].sort(), "the grid's days, the trailing week too");
    const byId = Object.fromEntries(d.visits.map((v) => [v.id, v]));
    assert.equal(byId[lead.id].amt, 29500, "the job's total");
    assert.equal(byId[trail.id].amt, 41000);
    assert.equal(byId[free.id].amt, undefined, "a no-charge job shows no amount");
    // ?month=now is the server's month; without amounts=1 there are none
    const now_ = await t.api("/schedule?month=now", { as: admin });
    assert.deepEqual([now_.body.data.from, now_.body.data.to, now_.body.data.month], ["2026-11-01", "2026-12-05", "2026-11"]);
    assert.ok(now_.body.data.visits.every((v) => v.amt === undefined));
    // someone denied visit prices gets the month without them
    const quiet = await t.user("admin", { denies: ["visits:prices"] });
    const q = await t.api("/schedule?month=2026-11&amounts=1", { as: quiet });
    assert.equal(q.status, 200);
    assert.ok(q.body.data.visits.length === 3 && q.body.data.visits.every((v) => v.amt === undefined));
    // a closed job is found in the year it closed
    await OFF.changeVisit(lead.id, "office_complete", { ctx: AS(owner) });
    const after = await t.api("/schedule?month=2026-11&amounts=1", { as: owner });
    assert.equal(after.body.data.visits.find((v) => v.id === lead.id).amt, 29500, "done: from jobs/2026");
    assert.equal((await t.api("/schedule?month=2026-13", { as: owner })).status, 400);
    assert.equal((await t.api("/schedule?month=2026-11", { as: tech })).status, 403, "a tech never sees the office's schedule");
  } finally { t.done(); }
});
