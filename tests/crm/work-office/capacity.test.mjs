// How full each day is (the month's fill bars), the days nobody closed and
// the To book count: the server's capacity (cfg/work.visits_per_day, the
// hours, the holidays, who is off), what GET /schedule answers, and the
// client's math and marks. Synthetic people only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, customer, job, visit, store, SCH, OFF, AS, LINES } from "./fixtures.mjs";

globalThis.window = globalThis.window || { __crm: { session: { perms: { "schedule:read": true, "schedule:write": true } } } };
const B = await import("../../../crm-app/modules/work/office-board.js");
const SC = await import("../../../crm-app/modules/work/office-schedule.js");
const text = (safe) => String(safe);

test("capacity: the crew's number a day, 0 when closed or a holiday, less a share for each person off the whole day", () => {
  const crew = ["us_a", "us_b"];
  const off = [
    { uid: "us_a", s: "2026-11-18T06:00:00.000Z", e: "2026-11-19T06:00:00.000Z", ad: true },          // Wednesday, all day
    { uid: "us_b", s: "2026-11-19T15:00:00.000Z", e: "2026-11-19T17:00:00.000Z", ad: false },         // Thursday, two hours: still working
    { uid: "us_b", s: "2026-11-20T00:00:00.000Z", e: "2026-11-21T06:00:00.000Z", av: true },          // an "available" exception never counts
    { uid: "us_x", s: "2026-11-17T06:00:00.000Z", e: "2026-11-18T06:00:00.000Z", ad: true },          // not on the crew
  ];
  const c = SCH.capacityOf("2026-11-15", "2026-11-28", { perDay: 8, crew, timeOff: off });
  assert.equal(c.per_day, 8);
  assert.equal(c.per_person, 4);
  assert.equal(c.days["2026-11-15"], 0, "Sunday: closed");
  assert.equal(c.days["2026-11-17"], 8);
  assert.equal(c.days["2026-11-18"], 4, "one of two off: half");
  assert.deepEqual(c.off["2026-11-18"], ["us_a"]);
  assert.equal(c.days["2026-11-19"], 8, "a few hours off is still a working day");
  assert.equal(c.days["2026-11-20"], 8);
  assert.equal(c.days["2026-11-26"], 0, "Thanksgiving");
  assert.equal(SCH.capacityOf("2026-11-17", "2026-11-17", { perDay: 8, crew: [] }).days["2026-11-17"], 8, "no technicians: the crew's number");
  assert.equal(SCH.capacityOf("2026-11-17", "2026-11-17", { perDay: 7, crew: ["a", "b", "c"] }).per_person, 2);
  assert.equal(SCH.capacityOf("2026-11-18", "2026-11-18", { perDay: 8, crew: ["us_a", "us_b", "us_c"], timeOff: off }).days["2026-11-18"], 5, "two of three working: 8 × 2/3, rounded");
  assert.deepEqual(SCH.crewOf([{ id: "a", is_technician: true, status: "active" }, { id: "b", is_technician: true, status: "disabled" }, { id: "c", is_technician: false }]), ["a"]);
  // DST: a day off across the November change still covers the working day
  assert.deepEqual(SCH.offOn("2026-11-02", [{ uid: "u", s: "2026-11-01T05:00:00.000Z", e: "2026-11-03T06:00:00.000Z", ad: true }]), ["u"]);
});

test("GET /schedule?month= carries each day's capacity, the To book count and a new visit's defaults; Schedule settings change the crew's number", async () => {
  const { t, owner, admin, tech, tech2 } = await setup();
  try {
    const c = await customer(owner);
    await job(owner, c);                                                       // to book this month
    await job(owner, c, { target_month: "2026-12" });                          // due later
    await visit(owner, await job(owner, c), { date: "2026-11-24", assignee_ids: [tech.id] });
    await t.api("/time-off", { method: "POST", as: owner, body: { user_id: tech2.id, date: "2026-11-25", reason: "Off" } });
    const r = await t.api("/schedule?month=2026-11", { as: owner });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const d = r.body.data;
    assert.equal(d.to_book, 1, "the tray's rule: due by the month");
    assert.equal((await t.api("/schedule/unscheduled?month=2026-11", { as: owner })).body.data.jobs.length, d.to_book, "the same count as the tray");
    assert.equal(d.capacity.per_day, 8, "the default");
    assert.equal(d.capacity.days["2026-11-22"], 0, "Sunday");
    assert.equal(d.capacity.days["2026-11-24"], 8);
    assert.equal(d.capacity.days["2026-11-25"], 4, "Tess off: her share less (two technicians)");
    assert.deepEqual(d.capacity.off["2026-11-25"], [tech2.id]);
    assert.deepEqual(d.defaults, { duration_min: 120, window_min: 120 });
    assert.equal(d.weather, true);
    // Schedule settings (the month's Change): 10 a day
    const got = await t.api("/settings/work", { as: admin });
    assert.equal(got.status, 200);
    const put = await t.api("/settings/work", { method: "PUT", as: admin, ifMatch: got.body.data.etag || "new", body: { ...got.body.data.data, visits_per_day: 10 } });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal((await t.api("/schedule?month=2026-11", { as: owner })).body.data.capacity.days["2026-11-24"], 10);
    for (const bad of [0, 61, 2.5, "8"]) assert.equal((await t.api("/settings/work", { method: "PUT", as: admin, ifMatch: put.body.data.etag, body: { ...put.body.data.data, visits_per_day: bad } })).status, 400, String(bad));
    // a week or a day carries capacity too; a technician gets none of it
    const wk = await t.api("/schedule?from=2026-11-22&to=2026-11-28", { as: owner });
    assert.equal(wk.body.data.capacity.days["2026-11-24"], 10);
    assert.equal(wk.body.data.to_book, undefined);
    assert.equal((await t.api("/schedule?month=2026-11", { as: tech })).status, 403);
  } finally { t.done(); }
});

test("GET /schedule?pay=1: a finished visit's job paid or not (the red $), only with prices; ?sales=1: the sales side's appointments", async () => {
  const { t, owner, tech } = await setup();
  try {
    const c = await customer(owner);
    const done = await visit(owner, await job(owner, c), { date: "2026-11-17", assignee_ids: [tech.id] });
    await OFF.changeVisit(done.id, "office_complete", { ctx: AS(owner) });
    const paid = await visit(owner, await job(owner, c), { date: "2026-11-17", start: "10:00", end: "12:00", assignee_ids: [tech.id] });
    await OFF.changeVisit(paid.id, "office_complete", { ctx: AS(owner) });
    // a paid invoice for the second job (Money's index row shape)
    await store.applyIndexRow("invoices", "2026", "in_00000000000000000001", "invoice", { j: paid.job_id, st: "paid", bal: 0, tot: 29500 }, 1);
    const r = await t.api("/schedule?from=2026-11-17&to=2026-11-17&amounts=1&pay=1", { as: owner });
    const by = Object.fromEntries(r.body.data.visits.map((v) => [v.id, v]));
    assert.equal(by[done.id].pd, 0, "done, no paid invoice: unpaid");
    assert.equal(by[paid.id].pd, 1, "done and paid");
    const plain = await t.api("/schedule?from=2026-11-17&to=2026-11-17&pay=1", { as: owner });
    assert.ok(plain.body.data.visits.every((v) => v.pd === undefined), "no amounts, no pay state");
    // sales appointments with a time, by person
    const at = (hhmm) => new Date(Date.parse(`2026-11-17T${hhmm}:00-06:00`)).toISOString();
    await store.createRecord("task", { title: "Estimate", kind: "estimate_visit", priority: "medium", status: "open", assignee_ids: [owner.id], due_at: at("11:00"), end_at: at("12:00") }, AS(owner));
    await store.createRecord("task", { title: "Call back", kind: "call", priority: "medium", status: "open", assignee_ids: [owner.id], due_at: at("14:30") }, AS(owner));
    await store.createRecord("task", { title: "Buy ladder hooks", kind: "todo", priority: "low", status: "open", assignee_ids: [owner.id], due_at: at("09:00") }, AS(owner));
    const s = await t.api("/schedule?from=2026-11-17&to=2026-11-17&sales=1", { as: owner });
    assert.deepEqual(s.body.data.sales.map((x) => [x.kind, x.start, x.end]), [["estimate_visit", "11:00", "12:00"], ["call", "14:30", "15:00"]], "a call takes 30 minutes; a to-do isn't an appointment");
    assert.equal((await t.api("/schedule?from=2026-11-17&to=2026-11-17", { as: owner })).body.data.sales, undefined);
    const noTasks = await t.user("admin", { denies: ["tasks:read"] });
    assert.equal((await t.api("/schedule?from=2026-11-17&to=2026-11-17&sales=1", { as: noTasks })).body.data.sales, undefined, "only with tasks:read");
    assert.deepEqual(SCH.salesSlots([{ id: "tk_1", k: "call", due: at("00:00"), a: [] }], "2026-11-17", "2026-11-17")[0].do, true, "due at midnight: any time that day");
  } finally { t.done(); }
});

test("the client's month: fill levels, one person's share, the days nobody closed, the To book count, the forecast", () => {
  const cap = { per_day: 8, per_person: 4, days: { "2026-11-17": 8, "2026-11-18": 4, "2026-11-22": 0 }, off: { "2026-11-18": ["us_t"] } };
  assert.equal(B.capFor(cap, "2026-11-17"), 8);
  assert.equal(B.capFor(cap, "2026-11-17", "us_t"), 4, "one person: their share");
  assert.equal(B.capFor(cap, "2026-11-18", "us_t"), 0, "one person off");
  assert.equal(B.capFor(cap, "2026-11-22", "us_t"), 0, "closed");
  assert.equal(B.capFor(cap, "2026-12-01"), null, "a day the server said nothing about: no bar");
  assert.deepEqual(B.fullness(0, 8), { level: "open", pct: 0, label: "0 of 8 booked" });
  assert.equal(B.fullness(3, 8).level, "some");
  assert.equal(B.fullness(6, 8).level, "busy");
  assert.deepEqual(B.fullness(8, 8), { level: "full", pct: 100, label: "8 of 8 booked, full" });
  assert.deepEqual(B.fullness(9, 8), { level: "over", pct: 100, label: "9 of 8 booked, over" });
  assert.deepEqual(B.fullness(0, 0), { level: "closed", pct: 0, label: "Closed" });
  assert.equal(B.fullness(2, 0).level, "shut", "visits on a closed day");
  assert.equal(B.fullness(2, null), null);
  const v = (d, st, a = ["us_t"]) => ({ id: `vs_${d}${st}`, d, st, a });
  const visits = [v("2026-11-16", "scheduled"), v("2026-11-16", "in_progress", ["us_u"]), v("2026-11-16", "completed"), v("2026-11-16", "cancelled"), v("2026-11-17", "scheduled"), v("2026-11-18", "scheduled")];
  assert.equal(B.notClosed(visits, "2026-11-16", "2026-11-17"), 2, "booked and under way, a past day");
  assert.equal(B.notClosed(visits, "2026-11-16", "2026-11-17", "us_t"), 1, "one person");
  assert.equal(B.notClosed(visits, "2026-11-17", "2026-11-17"), 0, "today isn't past");
  assert.equal(B.notClosed(visits, "2026-11-18", "2026-11-17"), 0);
  assert.equal(B.liveOn(visits, "2026-11-16").length, 3, "cancelled doesn't count");

  const U1 = "us_0000000000000000000t";
  const users = [{ id: U1, name: "Theo Tech", color: "#2563eb", is_technician: true }];
  const row = (o) => ({ id: "vs_00000000000000000001", j: "jb_1", cn: "Pat Sample", town: "Delano", d: "2026-11-16", s: "08:00", e: "10:00", w: { t: "window", m: 120 }, a: [U1], st: "scheduled", ...o });
  const data = { kind: "month", from: "2026-11-01", to: "2026-12-05", month: "2026-11", today: "2026-11-17", visits: [row(), row({ id: "vs_00000000000000000002", d: "2026-11-17" }), row({ id: "vs_00000000000000000003", d: "2026-11-22" })], tasks: [], warnings: {},
    capacity: { per_day: 8, per_person: 8, days: { "2026-11-16": 8, "2026-11-17": 8, "2026-11-22": 0 }, off: {} } };
  const wx = { days: { "2026-11-17": { hi: 41, lo: 24, pop: 0, icon: "sun", text: "Sunny" }, "2026-11-19": { hi: 44, lo: 33, pop: 70, icon: "rain", text: "Rain Showers Likely" } } };
  const s = { view: "month", cal: "2026-11", date: "2026-11-17", today: "2026-11-17", tech: null, month: "2026-11", users, data, wx, toBook: { month: "2026-11", n: 3 }, cards: { ...B.CARD_DEFAULTS } };
  const ctx = (perms = null) => ({ can: (p) => (perms ? perms.includes(p) : true), keep: {} });
  const h = text(SC.default.render(s, ctx()));
  assert.match(h, /data-mday="2026-11-17"[^>]*aria-label="[^"]*1 visit, 1 of 8 booked/, "the count and the fill in the label");
  assert.match(h, /class="wk-fill lvl-some" title="1 of 8 booked"><span class="wk-fcount num">1<\/span><span class="wk-fbar"><i style="width:13%"><\/i>/, "count and bar");
  assert.match(h, /class="wk-mday[^"]*unclosed"[^>]*data-mday="2026-11-16"[^>]*aria-label="[^"]*1 visit not marked done/, "the past day nobody closed");
  assert.match(h, /class="wk-mopen" title="1 visit not marked done"/);
  assert.match(h, /data-mday="2026-11-22"[\s\S]*?wk-fill lvl-shut/, "a visit on a closed Sunday");
  assert.match(h, /data-totray aria-label="3 jobs to book: open To book">[\s\S]*3<\/span> to book/, "the To book count, opening the tray");
  assert.match(h, /data-mday="2026-11-19"[^>]*aria-label="[^"]*Rain Showers Likely, high 44°, 70% chance of rain"[\s\S]*?wx-rain[\s\S]*?44°<\/b><em class="num">70%<\/em>/, "the forecast: icon, high, chance");
  assert.match(h, /Sunny · High 41°/, "the chosen day's forecast in its list");
  assert.match(h, /Forecast: National Weather Service/);
  assert.match(h, /data-schedset/, "Change (settings:general)");
  assert.doesNotMatch(text(SC.default.render(s, ctx(["schedule:read", "schedule:write"]))), /data-schedset/);
  assert.match(h, /href="#\/schedule\/move-day\?date=2026-11-17"[^>]*>[\s\S]*Move this day/, "the rain-day move from the day's list");
  const past = text(SC.default.render({ ...s, date: "2026-11-16" }, ctx()));
  assert.doesNotMatch(past, /Move this day/, "never for a day gone by");
  assert.match(past, /1 visit here isn&#39;t marked done yet/);
  // the To book link opens the tray on the month shown
  const c1 = { ...ctx(), state: { ...s }, keep: {}, rerender() {}, api: async () => ({ data: { month: "2026-11", jobs: [], later: 0 } }) };
  SC.default.events["click [data-totray]"]({}, { dataset: {} }, c1);
  assert.deepEqual([c1.state.view, c1.state.month], ["tray", "2026-11"]);
});
