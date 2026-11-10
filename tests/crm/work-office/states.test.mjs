// The job and visit state machines (design §5.5, §12.2): table-first, every
// (state, event) pair in the tables is exercised, and every pair not in a
// table throws InputError("transition").
import { test } from "node:test";
import assert from "node:assert/strict";
import { ST } from "./fixtures.mjs";

const { JOB_STATES, VISIT_STATES, JOB_STATUSES, VISIT_STATUSES, JOB_EVENTS, VISIT_EVENTS, transition, jobPath, jobStatusFromVisits, jobSchedule, jobAssignees, checklistMissing, canReopen } = ST;

// The design's tables (§5.5), written out again: a change to states.mjs that
// drops one of these fails here.
const DESIGN_JOB = [
  ["unscheduled", "schedule", "scheduled"], ["scheduled", "start", "in_progress"], ["scheduled", "complete", "completed"], ["in_progress", "complete", "completed"],
  ["completed", "reopen", "scheduled"], ["unscheduled", "cancel", "cancelled"], ["scheduled", "cancel", "cancelled"], ["in_progress", "cancel", "cancelled"],
];
const DESIGN_VISIT = [
  ["scheduled", "reschedule", "scheduled"], ["scheduled", "on_my_way", "en_route"], ["scheduled", "start", "in_progress"], ["en_route", "start", "in_progress"],
  ["paused", "start", "in_progress"], ["in_progress", "pause", "paused"], ["in_progress", "finish", "completed"], ["paused", "finish", "completed"],
  ["scheduled", "no_access", "no_access"], ["en_route", "no_access", "no_access"], ["completed", "reopen", "in_progress"],
  ...["scheduled", "en_route", "in_progress", "paused", "no_access", "cancelled"].map((s) => [s, "cancel", "cancelled"]),
];

test("every pair of the design's job table holds", () => {
  for (const [from, ev, to] of DESIGN_JOB) assert.equal(transition(JOB_STATES, from, ev), to, `${from} --${ev}-->`);
});

test("every pair of the design's visit table holds, the field transitions included", () => {
  for (const [from, ev, to] of DESIGN_VISIT) assert.equal(transition(VISIT_STATES, from, ev), to, `${from} --${ev}-->`);
  for (const ev of ST.FIELD_EVENTS) assert.ok(VISIT_EVENTS.includes(ev), `${ev} is in the table for the tech app`);
});

test("every (state, event) pair: in the table → its state, otherwise InputError transition", () => {
  for (const [table, states, events] of [[JOB_STATES, JOB_STATUSES, JOB_EVENTS], [VISIT_STATES, VISIT_STATUSES, VISIT_EVENTS]]) {
    assert.deepEqual(Object.keys(table).sort(), [...states].sort(), "a row per status");
    for (const s of states) {
      for (const ev of [...events, "fly", "__proto__", "constructor"]) {
        if (Object.hasOwn(table[s], ev)) assert.equal(transition(table, s, ev), table[s][ev]);
        else assert.throws(() => transition(table, s, ev), (e) => e.name === "InputError" && e.field === "transition", `${s} --${ev}--> must throw`);
      }
    }
    assert.throws(() => transition(table, "nope", events[0]), (e) => e.field === "transition");
  }
  assert.throws(() => transition(VISIT_STATES, "completed", "finish"), /isn't possible/);
  assert.throws(() => transition(JOB_STATES, "cancelled", "reopen"), /isn't possible/);
});

test("jobPath walks the table; no way → transition error", () => {
  assert.deepEqual(jobPath("scheduled", "scheduled"), []);
  assert.deepEqual(jobPath("unscheduled", "scheduled"), ["schedule"]);
  assert.deepEqual(jobPath("unscheduled", "in_progress"), ["schedule", "start"]);
  assert.deepEqual(jobPath("completed", "in_progress"), ["reopen", "start"]);
  assert.deepEqual(jobPath("in_progress", "unscheduled"), ["stop", "unschedule"]);
  assert.throws(() => jobPath("cancelled", "scheduled"), (e) => e.field === "transition");
});

test("the job follows its visits", () => {
  const v = (status, date = "2026-11-19", a = []) => ({ status, date, assignee_ids: a });
  assert.equal(jobStatusFromVisits({ status: "unscheduled" }, []), "unscheduled");
  assert.equal(jobStatusFromVisits({ status: "unscheduled" }, [v("scheduled")]), "scheduled");
  assert.equal(jobStatusFromVisits({ status: "scheduled" }, [v("scheduled"), v("en_route")]), "in_progress");
  assert.equal(jobStatusFromVisits({ status: "in_progress" }, [v("paused")]), "in_progress");
  assert.equal(jobStatusFromVisits({ status: "in_progress" }, [v("completed"), v("scheduled")]), "scheduled");
  assert.equal(jobStatusFromVisits({ status: "in_progress" }, [v("completed"), v("cancelled")]), "completed", "the last live visit done");
  assert.equal(jobStatusFromVisits({ status: "scheduled" }, [v("cancelled"), v("no_access")]), "unscheduled", "nothing live: back to the tray");
  assert.equal(jobStatusFromVisits({ status: "cancelled" }, [v("scheduled")]), "cancelled", "a cancelled job stays cancelled");
  const s = jobSchedule([v("completed", "2026-11-02"), v("scheduled", "2026-11-20"), v("scheduled", "2026-11-18"), v("cancelled", "2026-12-01")]);
  assert.deepEqual(s, { first_on: "2026-11-02", last_on: "2026-11-20", open_on: "2026-11-18", visits: 3, done: 1 });
  assert.deepEqual(jobAssignees([v("scheduled", "x", ["us_a"]), v("completed", "x", ["us_b", "us_a"]), v("cancelled", "x", ["us_c"])]).sort(), ["us_a", "us_b"]);
});

test("required checklist items gate finish; reopen within the window", () => {
  const visit = { checklist: { items: [{ key: "a", label: "Before photo", required: true }, { key: "b", label: "Glass", required: false }, { key: "c", label: "Gate closed", required: true, done_at: "x" }] } };
  assert.deepEqual(checklistMissing(visit), ["Before photo"]);
  assert.deepEqual(checklistMissing({}), []);
  const now = new Date("2026-11-17T15:00:00Z");
  assert.equal(canReopen({ status: "completed", completion: { at: "2026-11-12T15:00:00Z" } }, now, 7), true);
  assert.equal(canReopen({ status: "completed", completion: { at: "2026-11-09T15:00:00Z" } }, now, 7), false);
  assert.equal(canReopen({ status: "scheduled" }, now, 7), false);
});
