// Times from the device (design §2.5, §11.4 M4b "client-at.test.mjs"): an
// offline replay is recorded at its client_at only when it was queued
// offline, |client_at − queued_at| < 2 min and client_at lies within the
// last 7 days; otherwise it becomes a time entry pending approval. A
// replay into a week payroll locked becomes an adjustment pay line in the
// next open period and the owners are told (§5.8).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeServices } from "../../helpers/crm-fixtures.mjs";
import { advance, hours, minutes, days } from "../../helpers/crm-clock.mjs";
import { setup, customer, job, visit, clock, store, queued, AS, TS, offline, live, post, sheets, timers, rec, cid } from "./fixtures.mjs";

const ago = (ms) => new Date(clock.nowMs() - ms).toISOString();

test("judgeTime: the rules, on their edges", () => {
  const t = Date.parse("2026-11-17T15:00:00Z");
  const at = (ms) => new Date(t - ms).toISOString();
  assert.deepEqual(TS.judgeTime({ client_at: at(hours(1)) }, t), { at: new Date(t).toISOString(), trusted: true, source: "server" }, "a live request: the server's time");
  const ok = TS.judgeTime({ queued_offline: true, client_at: at(hours(3)), queued_at: at(hours(3) - minutes(1)) }, t);
  assert.equal(ok.trusted, true);
  assert.equal(ok.at, at(hours(3)), "recorded at the device's time");
  assert.equal(TS.judgeTime({ queued_offline: true, client_at: at(hours(3)), queued_at: at(hours(3) - minutes(2)) }, t).reason, "queued_mismatch", "2 minutes apart is too far");
  assert.equal(TS.judgeTime({ queued_offline: true, client_at: at(hours(3)), queued_at: at(hours(3) + 119000) }, t).trusted, true, "just under 2 minutes, either way");
  assert.equal(TS.judgeTime({ queued_offline: true, client_at: at(days(7) - minutes(1)), queued_at: at(days(7) - minutes(1)) }, t).trusted, true, "inside 7 days");
  const old = TS.judgeTime({ queued_offline: true, client_at: at(days(7) + minutes(1)), queued_at: at(days(7) + minutes(1)) }, t);
  assert.equal(old.reason, "too_old");
  assert.equal(old.at, at(days(7)), "the claim is kept, never older than 7 days");
  const ahead = TS.judgeTime({ queued_offline: true, client_at: at(-minutes(5)), queued_at: at(-minutes(5)) }, t);
  assert.equal(ahead.reason, "future");
  assert.equal(ahead.at, new Date(t).toISOString(), "a phone ahead of the server never records a time to come");
  assert.equal(TS.judgeTime({ queued_offline: true }, t).reason, "no_device_time");
});

test("clock in and out offline: accepted at the device's times; out of the rules, a pending entry for the office", async () => {
  const { t, tech, tech2 } = await setup();
  try {
    // inside the rules: recorded at the phone's times, a plain closed shift
    const inAt = ago(hours(3));
    let r = await post(t, tech, "/clock", offline({ action: "in" }, inAt));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.data.open.start_at, inAt);
    const outAt = ago(minutes(30));
    r = await post(t, tech, "/clock", offline({ action: "out" }, outAt));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const s1 = r.body.data.closed;
    assert.equal(s1.end_at, outAt);
    assert.equal(s1.status, "closed");
    assert.equal(s1.minutes, 150);
    assert.equal(s1.pending, undefined);

    // queued 3 minutes after the claimed time: the start is a claim the office decides on
    r = await post(t, tech2, "/clock", offline({ action: "in" }, ago(hours(2)), { queuedAt: ago(hours(2) - minutes(3)) }));
    assert.equal(r.status, 201);
    assert.equal(r.body.data.open.status, "open", "still an open shift: the tech is working");
    assert.equal(r.body.data.open.pending.reason, "queued_mismatch");
    r = await post(t, tech2, "/clock", live({ action: "out" }));
    assert.equal(r.body.data.closed.status, "pending_approval", "a shift with a time the server didn't take waits for approval");
    // it never counts toward pay until approved
    const est = await post(t, tech2, "/clock", live({ action: "in" }));
    assert.equal(est.status, 201);
    const pay = await t.api("/me/pay", { as: tech2 });
    assert.equal(pay.body.data.estimate.minutes, 0, "pending minutes aren't paid");
    assert.equal(pay.body.data.estimate.pending_min, 120);

    // a device time from 8 days ago: pending, kept as the phone said (clamped to 7 days)
    const third = await t.user("tech");
    r = await post(t, third, "/clock", offline({ action: "in" }, ago(days(8))));
    assert.equal(r.body.data.open.pending.reason, "too_old");
    assert.equal(r.body.data.open.start_at, ago(days(7)));
    // a phone whose clock runs ahead: never a time to come
    const fourth = await t.user("tech");
    r = await post(t, fourth, "/clock", offline({ action: "in" }, ago(-minutes(30))));
    assert.equal(r.body.data.open.pending.reason, "future");
    assert.equal(r.body.data.open.start_at, clock.nowIso());
    // online: the server's time, whatever the phone's clock says
    const fifth = await t.user("tech");
    r = await post(t, fifth, "/clock", { action: "in", client_id: cid(), client_at: ago(hours(5)) });
    assert.equal(r.body.data.open.start_at, clock.nowIso());
    assert.equal(r.body.data.open.pending, undefined);

    // the office sees the pending entries and decides
    const office = await t.api("/timesheets", { as: (await t.user("owner")) });
    assert.equal(office.status, 200);
    assert.ok(office.body.data.pending.length >= 1);
  } finally { t.done(); }
});

test("a visit timer started offline: recorded at the device time; started out of the rules, the clock-in it makes waits for approval", async () => {
  const { t, owner, tech, tech2 } = await setup();
  try {
    const c = await customer(owner);
    const v = await visit(owner, await job(owner, c), { date: "2026-11-17", start: "08:00", end: "10:00", assignee_ids: [tech.id, tech2.id] });
    const startAt = ago(minutes(50));
    let r = await post(t, tech, `/visits/${v.id}/timer`, offline({ action: "start" }, startAt));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.timer.start_at, startAt);
    assert.equal(r.body.data.timer.unverified, undefined);
    assert.equal(r.body.data.clock.open.start_at, startAt, "starting work while clocked out clocks in, at the same time");
    assert.equal(r.body.data.visit.status, "in_progress");

    r = await post(t, tech2, `/visits/${v.id}/timer`, offline({ action: "start" }, ago(minutes(40)), { queuedAt: ago(minutes(30)) }));
    assert.equal(r.status, 200);
    assert.equal(r.body.data.timer.unverified, true, "the segment says its time is the phone's claim");
    assert.equal(r.body.data.clock.open.pending.reason, "queued_mismatch", "and the shift it opened is pending");
    const sh = sheets(t).find((s) => s.user_id === tech2.id);
    assert.equal(sh.status, "open");
    assert.ok(timers(t).every((x) => x.visit_id === v.id));
  } finally { t.done(); }
});

test("a replay into a week payroll locked: an adjustment pay line in the next open period, and the owners are told", async () => {
  const { t, owner, tech } = await setup("2026-11-24T15:00:00Z");
  const calls = [];
  const restore = fakeServices({
    "payroll.periodStatus": async ({ at }) => (at < "2026-11-22T06:00:00.000Z" ? "locked" : "open"),
    "payroll.addAdjustment": async (input) => { calls.push(input); return { id: "py_adjustment_fake_0001" }; },
  });
  try {
    // offline last Friday (a locked week), replayed today
    const inAt = "2026-11-20T14:00:00.000Z";
    const outAt = "2026-11-20T22:30:00.000Z";
    const r1 = await post(t, tech, "/clock", offline({ action: "in" }, inAt));
    assert.equal(r1.status, 201, JSON.stringify(r1.body));
    const before = queued(t, "notify.deliver").length;
    const r2 = await post(t, tech, "/clock", offline({ action: "out" }, outAt));
    assert.equal(r2.status, 200, JSON.stringify(r2.body));
    const s = await rec("timesheet", r2.body.data.closed.id);
    assert.equal(s.status, "adjusted", "the locked week never changes: the shift becomes an adjustment");
    assert.equal(s.minutes, 510);
    assert.equal(calls.length, 1);
    assert.deepEqual({ user: calls[0].user_id, min: calls[0].minutes, ts: calls[0].timesheet_id }, { user: tech.id, min: 510, ts: s.id });
    assert.match(calls[0].note, /Late time entry: 510 min on 2026-11-20/);
    assert.equal(s.adjustment.line, "py_adjustment_fake_0001");
    const told = queued(t, "notify.deliver").slice(before).map((q) => q.data);
    assert.ok(told.some((d) => d.users.includes(owner.id) && /locked/.test(d.note.title + d.note.body)), "the owner is told");
    // pay for that week leaves it out (it's paid as the adjustment)
    const pay = await t.api("/me/pay?period=2026-11-15", { as: tech });
    assert.equal(pay.body.data.estimate.minutes, 0);
  } finally { restore(); t.done(); }
});

test("before payroll ships: a locked week (its shifts locked) keeps a late replay as a pending entry and tells the owners", async () => {
  const { t, owner, tech } = await setup("2026-11-24T15:00:00Z");
  try {
    await store.createRecord("timesheet", { user_id: tech.id, category: "service", start_at: "2026-11-17T14:00:00.000Z", end_at: "2026-11-17T22:00:00.000Z", status: "locked", notes: [], edits: [] }, AS(owner));
    await post(t, tech, "/clock", offline({ action: "in" }, "2026-11-19T14:00:00.000Z"));
    const before = queued(t, "notify.deliver").length;
    const r = await post(t, tech, "/clock", offline({ action: "out" }, "2026-11-19T20:00:00.000Z"));
    const s = await rec("timesheet", r.body.data.closed.id);
    assert.equal(s.status, "pending_approval");
    assert.equal(s.pending.reason, "locked_period");
    assert.ok(queued(t, "notify.deliver").slice(before).some((q) => q.data.users.includes(owner.id)));
    // approving it would change the locked week: refused until payroll can take an adjustment
    const d = await post(t, owner, `/timesheets/${s.id}/decide`, { decision: "approve" });
    assert.equal(d.status, 409, JSON.stringify(d.body));
  } finally { t.done(); }
});
