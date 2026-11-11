// Completing a visit (design §5.5, §11.4 M4b "complete.test.mjs"): the
// required checklist items gate it (B13), and it stops every assignee's
// running timer on the visit; the job follows (M4a's job rule).
import { test } from "node:test";
import assert from "node:assert/strict";
import { advance, minutes } from "../../helpers/crm-clock.mjs";
import { BYTES } from "../../helpers/crm-fixtures.mjs";
import { setup, customer, job, visit, clock, store, live, offline, post, patch, timers, rec, sheets } from "./fixtures.mjs";

const jpeg = () => Buffer.from(BYTES.jpeg()).toString("base64");

async function day(t, owner, tech, tech2) {
  const c = await customer(owner);
  const j = await job(owner, c);
  const v = await visit(owner, j, { date: "2026-11-17", start: "09:00", end: "11:00", assignee_ids: [tech.id, tech2.id] });
  return { c, j, v };
}

test("completion stops every assignee's running timer, closes the visit at its time and finishes the job", async () => {
  const { t, owner, tech, tech2 } = await setup();
  try {
    const { j, v } = await day(t, owner, tech, tech2);
    assert.equal(v.checklist.template_key, "windows_exterior", "the visit copied the exterior windows checklist");
    let r = await post(t, tech, `/visits/${v.id}/timer`, live({ action: "start" }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await post(t, tech2, `/visits/${v.id}/timer`, live({ action: "start" }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(timers(t).filter((x) => !x.end_at).length, 2, "both running");
    advance(minutes(95));

    // the required items gate it
    r = await post(t, tech, `/visits/${v.id}/complete`, live());
    assert.equal(r.status, 400);
    assert.equal(r.body.error.field, "checklist");
    assert.match(r.body.error.message, /Walk-around before photo, After photo, Gate closed/);
    // a photo item is done by its photo; a tick can't stand in for it
    assert.equal((await patch(t, tech, `/visits/${v.id}/checklist`, { key: "after_photo", done: true })).status, 400);
    r = await post(t, tech, `/visits/${v.id}/photos`, live({ data: jpeg(), thumb: jpeg(), tag: "before", item: "walkaround_photo" }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    r = await post(t, tech2, `/visits/${v.id}/photos`, live({ data: jpeg(), tag: "after", item: "after_photo" }));
    assert.equal(r.status, 201);
    r = await patch(t, tech2, `/visits/${v.id}/checklist`, { key: "gate_closed", done: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const ticked = r.body.data.visit.checklist.items.find((i) => i.key === "gate_closed");
    assert.equal(ticked.done_at, clock.nowIso());
    assert.equal(ticked.done_by, tech2.id);

    const doneAt = clock.nowIso();
    r = await post(t, tech, `/visits/${v.id}/complete`, live());
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.visit.status, "completed");
    assert.equal(r.body.data.visit.completion.at, doneAt);
    assert.equal(r.body.data.stopped, 2, "both people's timers stopped");
    const segs = timers(t).filter((x) => x.visit_id === v.id);
    assert.ok(segs.every((x) => x.end_at === doneAt), "every segment closed at the completion");
    assert.deepEqual(segs.map((x) => x.minutes), [95, 95]);
    assert.equal((await rec("visit", v.id)).minutes_worked, 190, "minutes worked: both people's segments");
    assert.equal((await store.readIndex("timers", "active")).rows.length, 0, "nothing left running");
    assert.equal((await rec("job", j.id)).status, "completed", "the job's last visit is done: the job is done");
    // the shifts stay open: finishing a visit isn't clocking out
    assert.equal(sheets(t).filter((s) => s.status === "open").length, 2);
    // a second tap answers the same
    r = await post(t, tech2, `/visits/${v.id}/complete`, live());
    assert.equal(r.status, 200);
    assert.equal(r.body.data.already, true);
  } finally { t.done(); }
});

test("done without the timer: a booked visit goes under way and done in one tap; pause and resume keep segments", async () => {
  const { t, owner, tech, tech2 } = await setup();
  try {
    const c = await customer(owner);
    const j = await job(owner, c, { kind: "touch_up", lines: [{ title: "Touch-up", unit_cents: 0 }] });
    const v = await visit(owner, j, { date: "2026-11-17", start: "09:00", end: "10:00", assignee_ids: [tech.id] });
    assert.deepEqual(v.checklist.items, [], "a touch-up with no service gets no list");
    let r = await post(t, tech, `/visits/${v.id}/timer`, live({ action: "start" }));
    advance(minutes(20));
    r = await post(t, tech, `/visits/${v.id}/timer`, live({ action: "pause" }));
    assert.equal(r.body.data.visit.status, "paused");
    assert.equal(r.body.data.visit.minutes_worked, 20);
    advance(minutes(10));
    r = await post(t, tech, `/visits/${v.id}/timer`, live({ action: "start" }));
    assert.equal(r.body.data.visit.status, "in_progress", "resumed");
    advance(minutes(15));
    r = await post(t, tech, `/visits/${v.id}/timer`, live({ action: "finish" }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.visit.status, "completed");
    assert.equal(r.body.data.visit.minutes_worked, 35, "two segments, the pause left out");

    const v2 = await visit(owner, await job(owner, c, { kind: "touch_up", lines: [{ title: "Touch-up", unit_cents: 0 }] }), { date: "2026-11-17", start: "13:00", end: "14:00", assignee_ids: [tech2.id] });
    r = await post(t, tech2, `/visits/${v2.id}/complete`, live());
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.visit.status, "completed");
  } finally { t.done(); }
});

test("completed offline with the checklist short, or after the office cancelled it: a pending entry, never forced", async () => {
  const { t, owner, admin, tech, tech2 } = await setup();
  try {
    const { v } = await day(t, owner, tech, tech2);
    await post(t, tech, `/visits/${v.id}/timer`, live({ action: "start" }));
    const at = new Date(clock.nowMs() + minutes(40)).toISOString();
    advance(minutes(60));
    let r = await post(t, tech, `/visits/${v.id}/complete`, offline({}, at));
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.equal(r.body.data.pending, true);
    const entry = await rec("timesheet", r.body.data.pending_entry_id);
    assert.equal(entry.status, "pending_approval");
    assert.equal(entry.pending.reason, "conflict");
    assert.equal(entry.pending.action, "complete");
    assert.match(entry.pending.detail, /Finish the checklist first/);
    assert.equal(entry.start_at, at, "what the phone said, kept for the office");
    assert.equal((await rec("visit", v.id)).status, "in_progress", "the visit is as it was");

    // the office cancels; the tech's offline pause replays afterwards
    const c2 = await post(t, admin, `/visits/${v.id}/cancel`, { reason: "Customer called" });
    assert.equal(c2.status, 200, JSON.stringify(c2.body));
    r = await post(t, tech2, `/visits/${v.id}/timer`, offline({ action: "start" }, new Date(clock.nowMs() - minutes(5)).toISOString()));
    assert.equal(r.status, 202, "a start on a cancelled visit waits for the office");
    assert.equal((await rec("visit", v.id)).status, "cancelled", "and the cancel stands");
    // live, the same is a plain refusal
    r = await post(t, tech2, `/visits/${v.id}/timer`, live({ action: "start" }));
    assert.equal(r.status, 409);
  } finally { t.done(); }
});
