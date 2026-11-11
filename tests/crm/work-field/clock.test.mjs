// Forgotten clock-ins and timers (design §5.5, §7.6 work.clock and
// work.timers, §11.4 M4b "clock.test.mjs"): a 19:00 push "Still clocked
// in?"; a shift closed at the later of the day's last visit end + 2 h and
// 21:00, marked auto_closed; a stale clock/ pointer never blocks a
// clock-in; a forgotten visit timer closed at its visit's end + 2 h.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pin, minutes } from "../../helpers/crm-clock.mjs";
import { setup, customer, job, visit, clock, store, queued, AS, AUTOMATION, TS, TM, live, post, rec, sheets, timers } from "./fixtures.mjs";

const { automationCtx } = await import("../../../netlify/lib/crm/core/activity.mjs");
const sweep = (key) => automationCtx({ mode: { system_of_record: "rotor", paused: false }, key, requestId: "test" });
const pushes = (t, kind) => queued(t, "notify.deliver").filter((q) => !kind || q.data.note.kind === kind);

test("19:00: one push to whoever is still clocked in; 21:00 (or the last visit's end + 2 h, if later): the shift closes for review", async () => {
  const { t, owner, tech, tech2 } = await setup("2026-11-17T14:00:00Z");     // 08:00 in Delano
  try {
    const c = await customer(owner);
    // Theo's day ends at 10:00; Tess has a late one, 19:00-20:00
    await visit(owner, await job(owner, c), { date: "2026-11-17", start: "08:00", end: "10:00", assignee_ids: [tech.id] });
    await visit(owner, await job(owner, c), { date: "2026-11-17", start: "19:00", end: "20:00", assignee_ids: [tech2.id] });
    await post(t, tech, "/clock", live({ action: "in" }));
    await post(t, tech2, "/clock", live({ action: "in" }));

    pin("2026-11-18T00:30:00Z");                         // 18:30: nothing yet
    await TS.clockSweep(sweep("work.clock"));
    assert.equal(pushes(t, "clock_reminder").length, 0);
    pin("2026-11-18T01:05:00Z");                         // 19:05
    await TS.clockSweep(sweep("work.clock"));
    const first = pushes(t, "clock_reminder");
    assert.equal(first.length, 2, "one push each");
    assert.match(first[0].data.note.title, /Still clocked in\?/);
    assert.equal(first[0].data.note.link, "/time");
    await TS.clockSweep(sweep("work.clock"));
    assert.equal(pushes(t, "clock_reminder").length, 2, "never twice");

    pin("2026-11-18T03:10:00Z");                         // 21:10
    await TS.clockSweep(sweep("work.clock"));
    const theo = sheets(t).find((s) => s.user_id === tech.id);
    assert.equal(theo.status, "closed");
    assert.equal(theo.end_at, "2026-11-18T03:00:00.000Z", "closed at 21:00, not when the sweep ran");
    assert.equal(theo.auto_closed.reason, "forgotten");
    assert.ok(theo.flags.includes("auto_closed"), "flagged for review");
    assert.equal(theo.minutes, 13 * 60);
    const tess = sheets(t).find((s) => s.user_id === tech2.id);
    assert.equal(tess.status, "open", "Tess's last visit ends at 20:00: her shift closes at 22:00");
    pin("2026-11-18T04:01:00Z");                         // 22:01
    await TS.clockSweep(sweep("work.clock"));
    const tess2 = sheets(t).find((s) => s.user_id === tech2.id);
    assert.equal(tess2.end_at, "2026-11-18T04:00:00.000Z");
    assert.ok(tess2.auto_closed);
    // the office hears about it too
    assert.ok(pushes(t).some((q) => q.data.users.includes(owner.id) && /closed for review/.test(q.data.note.title)));
    // and the office sees it flagged on Timesheets
    const wk = await t.api("/timesheets?week=2026-11-17", { as: owner });
    const row = wk.body.data.weeks.find((w) => w.user_id === tech.id).entries[0];
    assert.equal(row.ac, true);
  } finally { t.done(); }
});

test("a stale clock/ pointer never blocks clocking in", async () => {
  const { t, owner, tech, tech2 } = await setup("2026-11-17T14:00:00Z");
  try {
    // forgotten yesterday, no sweep ran since
    await post(t, tech, "/clock", live({ action: "in" }));
    pin("2026-11-18T14:00:00Z");
    let r = await post(t, tech, "/clock", live({ action: "in" }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.data.closed_forgotten.end_at, "2026-11-18T03:00:00.000Z", "yesterday's shift closed at its 21:00 first");
    assert.equal(r.body.data.open.start_at, clock.nowIso());
    assert.equal(store && t.stores.data.json(`ptr/clock/${tech.id}`).id, r.body.data.open.id);

    // a pointer to a shift that is closed, or isn't there at all
    await store.settledWrite(`ptr/clock/${tech2.id}`, { id: "ts_00000000000000000000", at: clock.nowIso() }, { onlyIfNew: true });
    r = await post(t, tech2, "/clock", live({ action: "in" }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    r = await post(t, tech2, "/clock", live({ action: "out" }));
    assert.equal(r.body.data.closed.status, "closed");
    r = await post(t, tech2, "/clock", live({ action: "in", category: "office" }));
    assert.equal(r.status, 201, "the pointer names a closed shift: free");
    assert.equal(r.body.data.open.category, "office");
    // clocked in already today: the same shift
    r = await post(t, tech2, "/clock", live({ action: "in" }));
    assert.equal(r.status, 200);
    assert.equal(r.body.data.already, true);
    // a clock-out with nothing open, live: said plainly
    const other = await t.user("tech");
    r = await post(t, other, "/clock", live({ action: "out" }));
    assert.equal(r.status, 409);
    void owner;
  } finally { t.done(); }
});

test("clocking out pauses the person's running visit timer", async () => {
  const { t, owner, tech } = await setup("2026-11-17T15:00:00Z");
  try {
    const v = await visit(owner, await job(owner, await customer(owner)), { date: "2026-11-17", start: "09:00", end: "11:00", assignee_ids: [tech.id] });
    await post(t, tech, `/visits/${v.id}/timer`, live({ action: "start" }));
    pin("2026-11-17T15:45:00Z");
    const r = await post(t, tech, "/clock", live({ action: "out" }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.paused, 1);
    const seg = timers(t)[0];
    assert.equal(seg.end_at, "2026-11-17T15:45:00.000Z");
    const after = await rec("visit", v.id);
    assert.equal(after.status, "paused");
    assert.equal(after.minutes_worked, 45);
  } finally { t.done(); }
});

test("work.timers: a forgotten timer closes at its visit's end + 2 h (never before the visit's planned length + 2 h)", async () => {
  const { t, owner, tech, tech2 } = await setup("2026-11-17T14:00:00Z");
  try {
    const c = await customer(owner);
    const v = await visit(owner, await job(owner, c), { date: "2026-11-17", start: "08:00", end: "10:00", assignee_ids: [tech.id] });
    await post(t, tech, `/visits/${v.id}/timer`, live({ action: "start" }));
    // Tess started her 08:00-10:00 visit late, at 11:00
    const v2 = await visit(owner, await job(owner, c), { date: "2026-11-17", start: "08:00", end: "10:00", assignee_ids: [tech2.id] });
    pin("2026-11-17T17:00:00Z");
    await post(t, tech2, `/visits/${v2.id}/timer`, live({ action: "start" }));
    pin("2026-11-17T18:05:00Z");                       // 12:05
    await TM.timersSweep(sweep("work.timers"));
    const a = timers(t).find((x) => x.visit_id === v.id);
    assert.equal(a.end_at, "2026-11-17T18:00:00.000Z", "closed at 10:00 + 2 h");
    assert.equal(a.auto_closed.reason, "stale");
    assert.equal(a.minutes, 240);
    assert.equal((await rec("visit", v.id)).status, "paused", "no timer runs on it: paused, not working");
    const b = timers(t).find((x) => x.visit_id === v2.id);
    assert.equal(b.end_at, undefined, "a late start keeps its planned 2 hours + 2");
    pin("2026-11-17T21:01:00Z");                       // 15:01
    await TM.timersSweep(sweep("work.timers"));
    assert.equal(timers(t).find((x) => x.visit_id === v2.id).end_at, "2026-11-17T21:00:00.000Z");
    // the shift is flagged for review, and the people heard
    const theo = sheets(t).find((s) => s.user_id === tech.id);
    assert.ok(theo.flags.includes("timer_auto_closed"));
    assert.ok(pushes(t).some((q) => q.data.users.includes(tech.id) && /Timer stopped/.test(q.data.note.title)));
    assert.ok(pushes(t).some((q) => q.data.users.includes(owner.id) && /forgotten timer/.test(q.data.note.title)));
  } finally { t.done(); }
});

test("before cutover, a timer Rotor still owns is only reported (a would- row), never closed by a sweep", async () => {
  const { t, owner } = await setup("2026-11-18T15:00:00Z");
  try {
    const IMPORT = { by: "import", origin: "import", actor_kind: "import", requestId: "test" };
    const tr = await store.createRecord("timer", { user_ids: [], start_at: "2026-11-17T14:00:00.000Z", import: { run_id: "ir_00000000000000000001", at: "2026-11-08T00:00:00.000Z", hash: "0".repeat(64) } }, IMPORT);
    await TM.timersSweep(sweep("work.timers"));
    assert.equal((await rec("timer", tr.data.id)).end_at, undefined);
    const alog = t.stores.data.keys("alog/");
    assert.ok(alog.some((k) => k.includes("work.timers") && k.includes("would-close")), "the would- row");
    void owner; void AS; void AUTOMATION;
  } finally { t.done(); }
});

test("the sweeps are registered on the fast lane, every pass", async () => {
  const { t } = await setup();
  try {
    const R = await import("../../../netlify/lib/crm/core/registry.mjs");
    for (const key of ["work.timers", "work.clock"]) {
      const s = R.allSweeps().find((x) => x.key === key);
      assert.ok(s, key);
      assert.equal(s.lane, "fast");
      assert.equal(s.every, "pass");
      assert.equal(s.mutates, true);
    }
    await t.runWorker({ lane: "fast" });
  } finally { t.done(); }
});
