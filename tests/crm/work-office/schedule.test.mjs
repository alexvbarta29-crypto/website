// M4a acceptance (design §11.4 "schedule.test.mjs"): GET /schedule returns
// visits and timed tasks; a visit overlapping an estimate task warns. Plus
// the other warnings (never blocking), the booking hint and the tray.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, customer, job, visit, store, AS } from "./fixtures.mjs";

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
