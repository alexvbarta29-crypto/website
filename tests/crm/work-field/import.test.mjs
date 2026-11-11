// The field part's Rotor import phases (design §10.2 rows 24 and 26)
// through the M2c runner on a synthetic export: visit timers (people from
// assigned_to, segments with no visit kept, a segment still running closed
// with auto_closed and reported) and timesheets (closed; approved before
// the last payroll run); a second run changes nothing. The phases read an
// export someone made; nothing calls Rotor.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, importExport, generate, store, rotorSnapshot } from "../import/fixtures.mjs";

const { idForRotor } = await import("../../../netlify/lib/crm/core/ids.mjs");
const { rotorKey } = await import("../../../netlify/lib/crm/modules/contacts/display.mjs");
const TM = await import("../../../netlify/lib/crm/modules/work/timers.mjs");
const TS = await import("../../../netlify/lib/crm/modules/work/timesheets.mjs");

test("visit timers and timesheets from a Rotor export, twice", async () => {
  const { t, owner, tech1, tech2 } = await setup();
  try {
    const ex = generate({ scale: 0.03, seed: 24 });
    const drew = ex.members.find((m) => m.name === "Drew Example");
    const emery = ex.members.find((m) => m.name === "Emery Example");
    const v0 = ex.visits[0];
    ex.visit_timers = [
      { id: 25001, visit_id: v0.id, job_id: v0.job_id, start: "2026-10-26T12:58:25.448+00:00", end: "2026-10-26T16:13:46.498+00:00", duration_minutes: 195, is_active: false, assigned_to: [drew.user_id, emery.user_id], start_location: [45.106, -93.741], end_location: [45.083, -93.73] },
      { id: 25002, visit_id: null, job_id: null, start: "2026-07-27T14:00:00+00:00", end: "2026-07-27T14:03:00+00:00", duration_minutes: 3, is_active: false, assigned_to: [], start_location: null, end_location: null },
      { id: 25003, visit_id: null, job_id: null, start: "2026-09-15T14:00:00+00:00", end: null, duration_minutes: null, is_active: true, assigned_to: [drew.user_id], start_location: [45.1, -93.7], end_location: null },
    ];
    ex.timesheets = [
      { id: 8601, user_id: drew.user_id, category: "service", start: "2026-09-29T12:42:00+00:00", end: "2026-09-29T16:34:00+00:00", duration_minutes: 232, is_active: false, notes: [], start_location: [45.036, -93.786], end_location: [45.055, -93.777], created_at: "2026-09-29T12:42:00+00:00" },
      { id: 8602, user_id: emery.user_id, category: "service", start: "2026-10-09T12:34:13.199+00:00", end: "2026-10-09T23:19:46.962+00:00", duration_minutes: 646, is_active: false, notes: [], start_location: null, end_location: null, created_at: "2026-10-09T12:34:13.320+00:00" },
      { id: 8603, user_id: drew.user_id, category: "office", start: "2026-11-02T14:00:00+00:00", end: null, duration_minutes: null, is_active: true, notes: ["Synthetic: forgot to clock out"], start_location: null, end_location: null, created_at: "2026-11-02T14:00:00+00:00" },
    ];
    const first = await importExport(t, owner, ex);
    assert.equal(first.run.status, "done", JSON.stringify(first.run.summary));

    const timers = t.stores.data.keys("rec/timer/").map((k) => t.stores.data.json(k));
    assert.equal(timers.length, 3);
    const a = timers.find((x) => x.rotor.timer_id === "25001");
    assert.equal(a.id, idForRotor("timer", "25001"));
    assert.equal(a.visit_id, idForRotor("visit", String(v0.id)));
    assert.deepEqual(a.user_ids.sort(), [tech1.id, tech2.id].sort(), "people from assigned_to, mapped to the team");
    assert.equal(a.minutes, 195);
    assert.deepEqual(a.start_geo, [45.106, -93.741]);
    assert.equal(a.created_by, "import");
    assert.equal(t.stores.data.json(`ptr/rotor/timer/${rotorKey("25001")}`).id, a.id);
    const loose = timers.find((x) => x.rotor.timer_id === "25002");
    assert.equal(loose.visit_id, undefined, "a segment with no visit is kept");
    const running = timers.find((x) => x.rotor.timer_id === "25003");
    assert.ok(running.end_at, "a segment Rotor still has running is closed");
    assert.equal(running.end_at, "2026-09-16T01:00:00.000Z", "at 20:00 that day (no visit)");
    assert.equal(running.auto_closed.reason, "stale");
    assert.equal((await store.readIndex("timers", "active")).rows.length, 0, "nothing imported runs");

    const sheets = t.stores.data.keys("rec/timesheet/").map((k) => t.stores.data.json(k));
    assert.equal(sheets.length, 3);
    const s1 = sheets.find((x) => x.rotor.timesheet_id === "8601");
    assert.equal(s1.user_id, tech1.id);
    assert.equal(s1.status, "approved", "before the last payroll run (Oct 1)");
    assert.equal(s1.minutes, 232);
    const s2 = sheets.find((x) => x.rotor.timesheet_id === "8602");
    assert.equal(s2.status, "closed", "after it: for the next approval");
    const s3 = sheets.find((x) => x.rotor.timesheet_id === "8603");
    assert.equal(s3.end_at, "2026-11-03T03:00:00.000Z", "still open in Rotor: closed at 21:00 for review");
    assert.equal(s3.category, "office");
    assert.ok(s3.flags.includes("auto_closed"));
    assert.equal(s3.notes[0].text, "Synthetic: forgot to clock out");
    assert.equal(t.stores.data.keys("ptr/clock/").length, 0, "no clock pointers: nobody is clocked in by an import");
    const oct = await store.readIndex("timesheets", "2026-10");
    assert.ok(oct.rows.some((r) => r.id === s2.id), "the index was rebuilt");
    const wk = await t.api("/timesheets?week=2026-10-09", { as: owner });
    assert.equal(wk.body.data.weeks.find((w) => w.user_id === tech2.id).minutes, 646);

    // the same export again: nothing created, nothing conflicted, Rotor's fields byte-identical
    const snap = await rotorSnapshot(t.stores, ["timer", "timesheet"]);
    const again = await importExport(t, owner, ex);
    assert.equal(again.run.status, "done");
    assert.equal(again.run.summary.created, 0);
    assert.equal(again.run.summary.conflicted, 0);
    assert.deepEqual(await rotorSnapshot(t.stores, ["timer", "timesheet"]), snap);
  } finally { t.done(); }
});

test("normalize refuses what isn't a timer or a timesheet", () => {
  assert.throws(() => TM.normalizeTimer({ id: "x/y", start: "2026-10-01T00:00:00Z" }), /id/);
  assert.throws(() => TM.normalizeTimer({ id: 1, start: "nope" }), /start/);
  assert.throws(() => TM.normalizeTimer({ id: 1, start: "2026-10-01T00:00:00Z", assigned_to: "a" }), /assigned_to/);
  assert.throws(() => TS.normalizeTimesheet({ id: 2, user_id: "../x", start: "2026-10-01T00:00:00Z" }), /user_id/);
  assert.equal(TS.normalizeTimesheet({ id: 2, user_id: "u1", start: "2026-10-01T00:00:00Z", category: "lunch" }).category, "service");
});
