// Home (the owner's Nov 12 choice: Rotor's phone Home with the best of
// Flyra's, as cards each person shows, hides and orders): GET /home, the
// cards' own reads and Edit Home, and the pure parts (home-kpis.mjs). Who
// gets which card, where the money comes from (the Money card is Rotor's:
// Week | Month, Collected and Scheduled side by side per day; Collected is
// the CRM's payments after cutover or while the latest Rotor import is 3
// days old or less, else Rotor's snapshot; Scheduled and ARR from the
// CRM's visits and plans), the clock, the agenda, goals, the leaderboard service
// gate, and the request budget (a card that is off costs no read).
// Synthetic data only (tests/e2e/seed.mjs, tests/helpers/office-snapshot.mjs).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { crmTest } from "../../helpers/crm-http.mjs";
import { pin } from "../../helpers/crm-clock.mjs";
import { sealedSnapshot, syntheticSnapshot } from "../../helpers/office-snapshot.mjs";

const store = await import("../../../netlify/lib/crm-store.mjs");
const K = await import("../../../netlify/lib/crm/modules/system/home-kpis.mjs");
const H = await import("../../../netlify/lib/crm/modules/system/home.mjs");
const S = await import("../../../netlify/lib/crm/core/services.mjs");
const { navFor } = await import("../../../netlify/lib/crm/modules/system/me.mjs");

const sum = (xs) => xs.reduce((a, x) => a + (x || 0), 0);
const TODAY = "2026-11-17";

// ------------------------------------------------------------ pure: periods and money

test("the periods: This week, This month, Last 3 months, This year, a custom range", () => {
  assert.deepEqual(K.periodOf("week", TODAY), { period: "week", from: "2026-11-16", to: "2026-11-22", label: "Nov 16 – 22" });
  assert.deepEqual(K.periodOf("month", TODAY), { period: "month", from: "2026-11-01", to: "2026-11-30", label: "November" });
  assert.deepEqual(K.periodOf("3m", TODAY), { period: "3m", from: "2026-09-01", to: "2026-11-30", label: "September – November" });
  assert.deepEqual(K.periodOf("3m", "2026-01-10"), { period: "3m", from: "2025-11-01", to: "2026-01-31", label: "November – January" });
  assert.deepEqual(K.periodOf("year", TODAY), { period: "year", from: "2026-01-01", to: "2026-12-31", label: "2026" });
  assert.deepEqual(K.periodOf("custom", TODAY, { from: "2026-10-28", to: "2026-11-03" }), { period: "custom", from: "2026-10-28", to: "2026-11-03", label: "Oct 28 – Nov 3" });
  assert.throws(() => K.periodOf("custom", TODAY, { from: "2026-11-03", to: "2026-10-28" }), /comes after/);
  assert.throws(() => K.periodOf("custom", TODAY, { from: "2025-01-01", to: "2026-11-03" }), /year at most/);
  assert.throws(() => K.periodOf("custom", TODAY, { from: "nope", to: "2026-11-03" }), /first and the last day/);
  assert.equal(K.periodOf("anything else", TODAY).period, "month");
});

test("Rotor's collected: the snapshot's month totals and its weeks; a period it doesn't hold is null", () => {
  const snap = syntheticSnapshot("2026-11-16");
  const cents = (d) => Math.round(d * 100);
  const month = K.rotorCollected(snap, K.periodOf("month", TODAY), TODAY);
  assert.equal(month.total, cents(snap.revenue.this_month));
  assert.equal(month.grain, "week");
  assert.deepEqual(month.points.map((p) => p.key), ["2026-11-02", "2026-11-09", "2026-11-16"], "Rotor's weeks that start in the month");
  assert.equal(month.through, "2026-11-16");
  const card = K.moneyCard({ metric: "collected", p: K.periodOf("month", TODAY), series: month, source: "rotor", asOf: snap.as_of });
  assert.equal(card.avg, Math.round(card.total / 16), "per day, through the snapshot's day");
  assert.deepEqual([card.peak.key, card.peak.label], ["2026-11-02", "week of Nov 2"]);
  // three months: the months' totals, its weeks for the chart
  const m3 = K.rotorCollected(snap, K.periodOf("3m", TODAY), TODAY);
  const monthly = Object.fromEntries(snap.revenue.monthly.map((m) => [m.key, cents(m.cur)]));
  assert.equal(m3.total, monthly["2026-09"] + monthly["2026-10"] + cents(snap.revenue.this_month));
  assert.ok(m3.points.every((p) => p.key >= "2026-09-01") && m3.points.length >= 10);
  // the year: its months, the ones ahead null
  const y = K.rotorCollected(snap, K.periodOf("year", TODAY), TODAY);
  assert.equal(y.grain, "month");
  assert.equal(y.points.length, 12);
  assert.equal(y.points[11].value, null, "December is ahead");
  assert.equal(y.total, sum(y.points.map((p) => p.value)));
  // this week: Rotor's week, no chart
  const w = K.rotorCollected(snap, K.periodOf("week", TODAY), TODAY);
  assert.equal(w.total, cents(snap.revenue.weekly.find((x) => x.key === "2026-11-16").value));
  assert.deepEqual(w.points, []);
  // what the snapshot doesn't hold: a custom range, or a month after its day
  assert.equal(K.rotorCollected(snap, K.periodOf("custom", TODAY, { from: "2026-11-01", to: "2026-11-10" }), TODAY).total, null);
  assert.equal(K.rotorCollected(syntheticSnapshot("2026-10-28"), K.periodOf("month", TODAY), TODAY).total, null, "November isn't in an October snapshot");
  assert.equal(K.rotorCollected({ as_of: "not a date" }, K.periodOf("month", TODAY), TODAY), null);
});

test("the CRM's collected (after cutover): succeeded payments less refunds, tips in, dry-run never; days ahead null", () => {
  const pay = (on, a, extra = {}) => ({ k: "payment", st: "succeeded", on, a, tip: 0, sim: 0, ...extra });
  const rows = [pay("2026-11-01", 20000), pay("2026-11-03", 30000, { tip: 4500 }), pay("2026-11-03", 1000, { k: "refund" }), pay("2026-11-10", 99900, { sim: 1 }), pay("2026-11-12", 50000, { st: "failed" }), pay("2026-11-18", 70000)];
  const p = K.periodOf("month", TODAY);
  const s = K.crmCollected(rows, p, TODAY);
  assert.equal(s.total, 20000 + 34500 - 1000);
  assert.equal(s.points.length, 30);
  assert.equal(s.points.find((x) => x.key === "2026-11-03").value, 33500);
  assert.equal(s.points.find((x) => x.key === "2026-11-18").value, null, "a day still ahead");
  const card = K.moneyCard({ metric: "collected", p, series: s, source: "crm", goals: { revenue_month_cents: 100000 } });
  assert.equal(card.avg, Math.round(53500 / 17));
  assert.deepEqual([card.peak.value, card.peak.label], [33500, "Nov 3"]);
  assert.deepEqual(card.goal, { target: 100000, value: 53500, pct: 54 }, "the month's revenue goal under the big number");
  assert.equal(K.moneyCard({ metric: "collected", p: K.periodOf("week", TODAY), series: s, source: "crm", goals: { revenue_month_cents: 100000 } }).goal, null, "the goal is a month's");
  assert.equal(K.collectedOf([{ k: "refund", st: "succeeded", on: "2026-11-02", a: 100, tip: 0 }], "2026-11-01", "2026-11-30"), -100);
});

test("scheduled: the value of the visits booked, a job's total once on its first visit, dead and unbilled ones out", () => {
  const jobs = new Map([["jb_a", { tot: 30000 }], ["jb_b", { tot: 50000 }], ["jb_c", { tot: 9000, bill: false }]]);
  const v = (d, j, extra = {}) => ({ d, j, st: "scheduled", ord: 1, ...extra });
  const visits = [v("2026-11-17", "jb_a"), v("2026-11-17", "jb_b"), v("2026-11-18", "jb_b", { ord: 2 }), v("2026-11-19", "jb_a", { st: "cancelled" }), v("2026-11-20", "jb_c"), v("2026-11-21", "jb_x"), v("2026-12-01", "jb_a")];
  const s = K.scheduledDays(visits, jobs, K.periodOf("week", TODAY));
  assert.equal(s.total, 80000);
  assert.deepEqual(s.points.map((p) => p.value), [0, 80000, 0, 0, 0, 0, 0]);
  const card = K.moneyCard({ metric: "scheduled", p: K.periodOf("week", TODAY), series: s, source: "crm" });
  assert.deepEqual([card.avg, card.peak.label], [Math.round(80000 / 7), "Nov 17"]);
});

test("ARR: each live plan's term value scaled to a year; the change over the period; no plans at all is null", () => {
  // a first-term quarterly plan (12 months: its sale value is a year), a renewed quarterly term (3 months × 4),
  // one cancelled from Nov 10, one waiting for a signature
  const plans = [
    { st: "active", ck: "quarterly", sv: 100000, at: "2026-03-02T15:00:00Z", te: "2027-03-01" },
    { st: "active", ck: "quarterly", sv: 25000, at: "2024-03-02T15:00:00Z", te: "2027-01-01" },
    { st: "ended", ck: "biannual", sv: 40000, at: "2026-02-01T15:00:00Z", te: "2027-02-01", eff: "2026-11-10" },
    { st: "pending", ck: "monthly", sv: 300000, at: "2026-11-05T15:00:00Z", te: "2027-11-05" },
    { st: "active", ck: "quarterly", sv: 100000, at: "2026-11-12T15:00:00Z", te: "2027-11-12" },
  ];
  assert.equal(K.planArr(plans[0]), 100000);
  assert.equal(K.planArr(plans[1]), 100000, "a 3-month renewal term × 4");
  const s = K.arrDays(plans, K.periodOf("month", TODAY), TODAY);
  assert.equal(s.total, 300000, "two old plans and the new one");
  assert.equal(s.points.find((p) => p.key === "2026-11-09").value, 240000, "the cancelled plan still counts before Nov 10");
  assert.equal(s.points.find((p) => p.key === "2026-11-18").value, null);
  const card = K.moneyCard({ metric: "arr", p: K.periodOf("month", TODAY), series: s, source: "crm" });
  assert.equal(card.change, 300000 - 240000, "Nov 1 had the cancelled one; the new plan came on Nov 12");
  assert.equal(card.avg, null);
  assert.equal(K.arrDays([], K.periodOf("month", TODAY), TODAY), null);
});

test("the Money line is a running total: it climbs to the big number, a partial last bucket never dives, gaps stay gaps", async () => {
  const { cumulative } = await import("../../../crm-app/modules/system/home-charts.js");
  const snap = syntheticSnapshot("2026-11-16");
  const month = K.rotorCollected(snap, K.periodOf("month", TODAY), TODAY);
  const run = cumulative(month.points, month.total);
  assert.deepEqual(run.map((p) => p.own), month.points.map((p) => p.value), "each point keeps its own amount");
  assert.equal(run.at(-1).value, month.total, "the line ends at the big number (Nov 1, before the first Monday, folded into the first point)");
  for (let i = 1; i < run.length; i++) assert.ok(run[i].value >= run[i - 1].value, "never down");
  const days = cumulative([{ value: 100 }, { value: 0 }, { value: 50 }, { value: null }], 150);
  assert.deepEqual(days.map((p) => [p.value, p.own]), [[100, 100], [100, 0], [150, 50], [null, null]]);
});

// ------------------------------------------------------------ pure: the other cards

test("Rotor's Money card (pure): the latest finished import and its age, the week or month of a day, Rotor's weeks", () => {
  // the newest finished import by its export's day (else the day it finished); an unfinished one never counts
  const runs = [{ id: "ir_a", st: "done", asof: "2026-11-09", fin: "2026-11-09T20:00:00Z" }, { id: "ir_b", st: "done", fin: "2026-11-14T03:00:00Z" }, { id: "ir_c", st: "running", asof: "2026-11-17" }, { id: "ir_d", st: "failed", asof: "2026-11-16" }];
  assert.deepEqual(K.latestImport(runs, TODAY), { date: "2026-11-13", age: 4, fresh: false }, "finished 9 PM Nov 13 in Delano: 4 days old");
  assert.deepEqual(K.latestImport([...runs, { id: "ir_e", st: "done", asof: "2026-11-14" }], TODAY), { date: "2026-11-14", age: 3, fresh: true }, "3 days old is fresh");
  assert.equal(K.latestImport([{ st: "cancelled", asof: "2026-11-17" }, null, "x"], TODAY), null);
  assert.equal(K.latestImport([], TODAY), null);
  assert.equal(K.IMPORT_FRESH_DAYS, 3);
  // the period of a day: Monday's week, or the month with its year
  assert.deepEqual(K.pairPeriod("month", "2026-10-09"), { period: "month", from: "2026-10-01", to: "2026-10-31", label: "October 2026" });
  assert.deepEqual(K.pairPeriod("week", "2026-11-01"), { period: "week", from: "2026-10-26", to: "2026-11-01", label: "Oct 26 – Nov 1" });
  // Rotor's weekly Collected: Scheduled is summed to the same weeks (one scale); a week that began before the month counts from the 1st
  const p = K.pairPeriod("month", TODAY);
  const days = K.dates(p.from, p.to).map((d) => ({ key: d, label: K.dayLabel(d), value: d === "2026-11-01" ? 100 : d === "2026-11-03" ? 200 : d === "2026-11-08" ? 50 : d === "2026-11-30" ? 7 : 0 }));
  assert.deepEqual(K.byWeek(days, p).map((x) => [x.key, x.to, x.value]), [["2026-11-01", "2026-11-01", 100], ["2026-11-02", "2026-11-08", 250], ["2026-11-09", "2026-11-15", 0], ["2026-11-16", "2026-11-22", 0], ["2026-11-23", "2026-11-29", 0], ["2026-11-30", "2026-11-30", 7]]);
  const snap = syntheticSnapshot("2026-11-16");
  const weekly = K.moneyPair({ p, collected: K.rotorCollected(snap, p, TODAY), scheduled: { total: 357, points: days }, source: "rotor", asOf: "2026-11-16", arr: 480000 });
  assert.equal(weekly.grain, "week");
  assert.deepEqual(weekly.collected.points.map((x) => x.key), ["2026-11-02", "2026-11-09", "2026-11-16"]);
  assert.equal(weekly.collected.total, Math.round(snap.revenue.this_month * 100));
  assert.deepEqual([weekly.scheduled.total, weekly.scheduled.points.length, weekly.arr, weekly.source, weekly.as_of, weekly.label], [357, 6, 480000, "rotor", "2026-11-16", "November 2026"]);
  // per day (the CRM's payments): both lines per day; Rotor's one week total has no points; nothing counted yet is null, not $0
  const daily = K.moneyPair({ p, collected: K.crmCollected([{ st: "succeeded", k: "payment", a: 5000, on: "2026-11-03" }], p, "2026-11-13"), scheduled: { total: 357, points: days }, source: "import", asOf: "2026-11-13" });
  assert.equal(daily.grain, "day");
  assert.equal(daily.collected.points.length, 30);
  assert.deepEqual([daily.collected.total, daily.collected.points[2].value, daily.collected.points[12].value, daily.collected.points[13].value], [5000, 5000, 0, null], "through the import's day");
  const wk = K.pairPeriod("week", TODAY);
  const one = K.moneyPair({ p: wk, collected: K.rotorCollected(snap, wk, TODAY), scheduled: { total: 0, points: [] }, source: "rotor" });
  assert.deepEqual([one.grain, one.collected.points], ["day", []]);
  assert.equal(one.collected.total, Math.round(snap.revenue.weekly.find((w) => w.key === "2026-11-16").value * 100));
  const ahead = K.moneyPair({ p: K.pairPeriod("month", "2026-12-05"), collected: K.crmCollected([], K.pairPeriod("month", "2026-12-05"), "2026-11-13"), scheduled: null, source: "import" });
  assert.deepEqual([ahead.collected.total, ahead.scheduled.total, ahead.arr], [null, null, null]);
});

test("the clock: today's finished shifts and the open one so far; nobody else's", () => {
  const now = Date.parse("2026-11-17T18:00:00Z");
  const rows = [
    { uid: "us_me", st: "closed", d: TODAY, min: 95, s: "2026-11-17T13:00:00Z", e: "2026-11-17T14:35:00Z" },
    { uid: "us_me", st: "open", d: TODAY, s: "2026-11-17T17:00:00Z", e: null, cat: "sales" },
    { uid: "us_me", st: "closed", d: "2026-11-16", min: 300 },
    { uid: "us_other", st: "open", d: TODAY, s: "2026-11-17T12:00:00Z" },
    { uid: "us_me", st: "rejected", d: TODAY, min: 60 },
  ];
  assert.deepEqual(K.clockToday(rows, "us_me", TODAY, now), { minutes: 95 + 60, open: { start_at: "2026-11-17T17:00:00Z", category: "sales" } });
  assert.deepEqual(K.clockToday([], "us_me", TODAY, now), { minutes: 0, open: null });
});

test("the agenda: a day, a week or a month of visits in time order with who goes; tasks and the inbox", () => {
  assert.deepEqual(K.agendaRange("day", TODAY), { from: TODAY, to: TODAY });
  assert.deepEqual(K.agendaRange("week", TODAY), { from: "2026-11-16", to: "2026-11-22" });
  assert.deepEqual(K.agendaRange("month", TODAY), { from: "2026-11-01", to: "2026-11-30" });
  const users = [{ id: "us_a", name: "Theo Tech", first_name: "Theo", color: "#0a7d55" }];
  const visits = [
    { id: "vs_2", d: TODAY, s: "13:00", e: "15:00", cn: "Pat Example", st: "scheduled", a: ["us_a"] },
    { id: "vs_1", d: TODAY, s: "08:00", e: "12:00", cn: "Sam Sample", st: "completed", a: ["us_a", "us_gone"], pl: "pl_1" },
    { id: "vs_3", d: TODAY, do: true, cn: "Lee Demo", st: "scheduled", a: [], k: "lights_install" },
    { id: "vs_4", d: TODAY, s: "09:00", cn: "Dana Tester", st: "cancelled", a: [] },
    { id: "vs_5", d: "2026-11-18", s: "09:00", cn: "Chris Demo", st: "scheduled", a: [] },
  ];
  const day = K.agendaOf(visits, users, K.agendaRange("day", TODAY));
  assert.equal(day.count, 3);
  assert.deepEqual(day.items.map((v) => [v.id, v.kind]), [["vs_1", "Plan visit"], ["vs_2", "Job"], ["vs_3", "Lights install"]]);
  assert.deepEqual(day.items[0].people.map((p) => [p.first_name, p.color]), [["Theo", "#0a7d55"], ["", null]]);
  assert.equal(K.agendaOf(visits, users, K.agendaRange("week", TODAY)).count, 4);
  // Monthly's calendar gets the whole month (a busy one too), so every day has its dots and its list
  const busy = Array.from({ length: 300 }, (_, i) => ({ id: `vs_b${i}`, d: `2026-11-${String((i % 30) + 1).padStart(2, "0")}`, s: "09:00", e: "10:00", cn: "Pat Example", st: "scheduled", a: ["us_a"] }));
  const month = K.agendaOf(busy, users, K.agendaRange("month", TODAY), K.AGENDA_MAX.month);
  assert.deepEqual([month.count, month.items.length, new Set(month.items.map((v) => v.date)).size], [300, 300, 30]);
  assert.equal(K.agendaOf(busy, users, K.agendaRange("month", TODAY), K.AGENDA_MAX.day).items.length, 120, "a day or a week keeps its 120");
  const me = { id: "us_me" };
  const tasks = [
    { id: "tk_1", t: "Call back", st: "open", due: null, a: ["us_me"], u: "2026-11-10" },
    { id: "tk_2", t: "Check spouts", st: "in_progress", due: "2026-11-18T15:00:00Z", a: ["us_me"] },
    { id: "tk_3", t: "Someone else's", st: "open", due: null, a: ["us_x"] },
  ];
  assert.deepEqual(K.tasksOf(tasks, me).map((t) => t.id), ["tk_2", "tk_1"], "their own, due ones first");
  assert.deepEqual(K.tasksOf(tasks, me, { all: true }).map((t) => t.id).sort(), ["tk_1", "tk_2", "tk_3"], "an owner's whole team's");
  const convs = [{ id: "cv_1", n: "A", st: "open", la: "2026-11-17T10:00:00Z", u: 0 }, { id: "cv_2", n: "B", st: "open", la: "2026-11-16T10:00:00Z", u: 2 }, { id: "cv_3", n: "C", st: "done", la: "2026-11-17T12:00:00Z", u: 1 }];
  assert.deepEqual(K.inboxOf(convs).map((c) => [c.id, c.unread]), [["cv_2", 2], ["cv_1", 0]], "unread first, open ones only");
});

test("the person's cards: their order first, then the defaults; a card they can't have is dropped", () => {
  const all = ["clock", "money", "agenda", "inbox", "tasks", "goals"];
  // Flyra's Home: the money, then the cards; the clock only for someone who clocks in for field work
  assert.deepEqual(K.layoutOf(null, all), [{ key: "money", on: true }, { key: "clock", on: false }, { key: "agenda", on: true }, { key: "inbox", on: true }, { key: "tasks", on: true }, { key: "goals", on: true }]);
  assert.deepEqual(K.layoutOf(null, all, { clock: true }).slice(0, 2), [{ key: "money", on: true }, { key: "clock", on: true }], "a technician-owner gets the clock");
  assert.deepEqual(K.layoutOf({ cards: [{ key: "tasks", on: true }, { key: "money", on: false }, { key: "leaderboard", on: true }] }, ["money", "agenda", "tasks"]),
    [{ key: "tasks", on: true }, { key: "money", on: false }, { key: "agenda", on: true }], "the leaderboard isn't open to them; agenda wasn't saved: its default");
  assert.deepEqual(K.validateLayout({ cards: [{ key: "agenda" }, { key: "agenda", on: false }, { key: "money", on: false }] }), { cards: [{ key: "agenda", on: true }, { key: "money", on: false }] });
  assert.throws(() => K.validateLayout({ cards: [{ key: "<script>" }] }), /isn't a Home card/);
  assert.throws(() => K.validateLayout({}), /cards/);
  assert.deepEqual(K.validateGoals({ revenue_month_cents: 2500000, jobs_month: "" }), { revenue_month_cents: 2500000, jobs_month: null });
  assert.throws(() => K.validateGoals({ revenue_month_cents: -5 }), /Revenue/);
  assert.throws(() => K.validateGoals({ jobs_month: 2.5 }), /Jobs/);
  // the reports module's leaderboard, read leniently
  const b = K.normalizeBoard({ rows: [{ user_id: "us_a", name: "Olive Owner", value_cents: 125000, count: 3 }, { name: "Theo Tech", arr_cents: 50000, note: "<b>2 plans</b>", color: "javascript:x" }] }, "sales", "2026-11");
  assert.equal(b.title, "November Leaderboard");
  assert.deepEqual(b.rows.map((r) => [r.rank, r.name, r.value, r.unit, r.note, r.color]), [[1, "Olive Owner", 125000, "ARR", "3 sold", null], [2, "Theo Tech", 50000, "ARR", "<b>2 plans</b>", null]]);
  assert.deepEqual(K.normalizeBoard(null, "techs", "2026-11").rows, []);
});

test("the tab bar: Home · Schedule · Inbox · Map · Menu for the office (Flyra's); techs keep theirs", () => {
  assert.deepEqual(navFor({ role: "owner" }), ["home", "schedule", "inbox", "map", "menu"]);
  assert.deepEqual(navFor({ role: "admin" }), ["home", "schedule", "inbox", "map", "menu"]);
  assert.deepEqual(navFor({ role: "tech" }), ["today", "inbox", "time", "pay", "me"]);
});

// ------------------------------------------------------------ GET /home and the cards' reads

const KEY = randomBytes(32).toString("base64");
let t, fx;
before(async () => {
  t = await crmTest({ now: "2026-11-17T15:00:00Z", env: { OFFICE_DATA_KEY: KEY } });
  globalThis.__crmOfficeSnapshot = sealedSnapshot(KEY, "2026-11-16");
  H.clearSnapshotCache();
  fx = {
    owner: await t.user("owner"), admin: await t.user("admin"), tech: await t.user("tech"),
    noReports: await t.user("admin", { denies: ["reports:read"] }),
  };
  const { seed } = await import("../../e2e/seed.mjs");
  fx.world = await store.withStoreScope({ requestId: "home-seed" }, () => seed({ contacts: 6 }));
  for (let i = 0; i < 4 && t.stores.data.keys("q/").length; i++) await t.runWorker({ lane: "fast" });
});
after(() => { delete globalThis.__crmOfficeSnapshot; H.clearSnapshotCache(); t.done(); });

async function counted(path, opts) {
  const c0 = t.stores.data.calls.length;
  const res = await t.api(path, opts);
  return { res, calls: t.stores.data.calls.slice(c0).map((c) => `${c.op} ${c.key}`) };
}
const cold = async () => {
  (await import("../../../netlify/lib/crm/core/sessions.mjs")).clearSessionCache();
  (await import("../../../netlify/lib/crm/core/auth.mjs")).clearPermissionsCache();
};
async function setMode(sor) {
  await store.withStoreScope({ requestId: "home-mode" }, async () => {
    const cur = await store.getRaw("sys/mode");
    await store.settledWrite("sys/mode", { system_of_record: sor, paused: false, cutover_n: 1 }, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
  });
}
const home = async (as, opts = {}) => (await t.api("/home", { as, ...opts })).body.data;

test("an owner's Home (Flyra's): the header, Money, the Leaderboard, Today, Inbox, Tasks and Goals on; the clock offered, off for someone who doesn't clock in", async () => {
  const res = await t.api("/home", { as: fx.owner });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const d = res.body.data;
  assert.equal(d.date, TODAY);
  assert.equal(d.user.first_name, "Olive");
  assert.deepEqual(d.layout, [{ key: "money", on: true }, { key: "clock", on: false }, { key: "leaderboard", on: true }, { key: "agenda", on: true }, { key: "inbox", on: true }, { key: "tasks", on: true }, { key: "goals", on: true }], "the leaderboard is offered (the reports module's service is merged), on");
  assert.deepEqual(Object.keys(d.cards).sort(), ["agenda", "goals", "inbox", "leaderboard", "money", "tasks"], "a card that is off isn't computed");
  assert.equal(d.cards.clock, undefined, "the clock is off: not read");
  // money: Rotor's card, this month: Collected from Rotor's snapshot (no import yet) by its weeks, Scheduled per week with it, the ARR
  const m = d.cards.money;
  assert.deepEqual([m.period, m.from, m.to, m.source, m.as_of, m.label, m.grain], ["month", "2026-11-01", "2026-11-30", "rotor", "2026-11-16", "November 2026", "week"]);
  assert.equal(m.collected.total, Math.round(syntheticSnapshot("2026-11-16").revenue.this_month * 100));
  assert.ok(m.collected.points.length > 1 && m.collected.points.every((x) => x.key >= m.from && x.key <= m.to));
  assert.ok(m.scheduled.total > 0, "the seed's jobs have prices");
  assert.equal(m.scheduled.total, sum(m.scheduled.points.map((x) => x.value)));
  assert.ok(m.arr > 0, "the seed's live plans");
  assert.equal(m.goal, undefined, "no goal on the card (the Goals card has it)");
  // today: the seed's four visits, with who goes, and the open tasks without a due date
  const a = d.cards.agenda;
  assert.deepEqual([a.view, a.date, a.count], ["day", TODAY, 4]);
  for (const v of a.items) {
    assert.match(v.id, /^vs_/);
    assert.ok(v.name && v.start && v.kind && v.people.length && v.people.every((p) => p.first_name && p.color), JSON.stringify(v));
    assert.equal(v.contact_id, undefined, "names for the list, no contact ids");
  }
  assert.deepEqual(a.items.map((v) => v.start), [...a.items.map((v) => v.start)].sort());
  assert.ok(Array.isArray(a.tasks) && a.tasks.every((x) => !x.due && x.title));
  assert.equal(typeof d.notifications, "number");
});

test("who sees what: the money needs reports:read or the office sign-in; a technician gets nothing", async () => {
  const admin = await home(fx.admin);
  assert.ok(admin.cards.money && admin.layout.some((c) => c.key === "goals"), "the office has reports:read");
  const denied = await home(fx.noReports);
  assert.ok(!denied.layout.some((c) => ["money", "goals", "leaderboard"].includes(c.key)), JSON.stringify(denied.layout));
  assert.equal(denied.cards.money, undefined);
  assert.ok(denied.cards.agenda, "the schedule still");
  assert.equal((await t.api("/home/money", { as: fx.noReports })).status, 403);
  const withOffice = await home(fx.noReports, { office: true });
  assert.ok(withOffice.cards.money && withOffice.cards.money.collected.total > 0, "the office sign-in opens the office dashboard's numbers");
  for (const office of [false, true]) {
    const res = await t.api("/home", { as: fx.tech, office });
    assert.equal(res.status, 200);
    assert.deepEqual({ ...res.body.data, now: null }, { date: TODAY, now: null, user: null, mode: null, notifications: null, layout: [], cards: {} }, "a technician never gets Home");
    assert.equal((await t.api("/home/money", { as: fx.tech, office })).status, 403);
    assert.equal((await t.api("/home/money?period=week", { as: fx.tech, office })).status, 403);
    assert.equal((await t.api("/home/layout", { method: "PUT", as: fx.tech, body: { cards: [] } })).status, 400);
  }
  assert.equal((await t.api("/home", { office: true })).status, 401, "the office cookie alone is not a CRM sign-in");
});

test("the budget: a cold default Home is 18 storage calls, each read once, nothing for the cards that are off", async () => {
  await cold();
  const { res, calls } = await counted("/home", { as: fx.owner, office: true });
  assert.equal(res.status, 200);
  const keys = calls.map((c) => c.replace(/^\S+ /, "").replace(/us_\w+\/?$/, "{user}").replace(/^ses\/\w+$/, "ses/{id}")).sort();
  // (Flyra's Home: the inbox's open index for Inbox; the plans and quotes for the Leaderboard's sales; the clock is off: no timesheets;
  // Rotor's Money card: the import runs (is the latest fresh?), the month's visits shared with Today, the jobs for their value, the plans for the ARR)
  assert.deepEqual(keys, ["cfg/goals", "cfg/permissions", "ix/import-runs", "ix/inbox/open", "ix/jobs/2026", "ix/jobs/open", "ix/plans", "ix/quotes/2026", "ix/quotes/open", "ix/tasks/open", "ix/users", "ix/visits/2026-11", "ptr/home/{user}", "rec/user/{user}", "rel/user-unread/{user}", "ses/{id}", "sys/auth-epoch", "sys/mode"], calls.join("\n"));
  assert.ok(keys.length <= 18, `${keys.length} calls`);
  assert.equal(new Set(calls).size, calls.length, "nothing read twice");
  assert.ok(!calls.some((c) => c.includes("ix-dirty/")), "no dirty markers");
  for (const gone of ["ix/sales-attention", "ix/merge-candidates", "sys/health", "ix/payments/2026-11"]) assert.ok(!calls.some((c) => c.endsWith(" " + gone)), `${gone} is not read`);
});

test("Edit Home: the person's cards on, off and in their order, saved per person; the others' untouched", async () => {
  const save = (as, cards) => t.api("/home/layout", { method: "PUT", as, body: { cards } });
  const r = await save(fx.owner, [{ key: "tasks", on: true }, { key: "agenda", on: true }, { key: "money", on: true }, { key: "clock", on: false }, { key: "inbox", on: true }, { key: "goals", on: true }, { key: "leaderboard", on: true }]);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data.layout.map((c) => `${c.key}:${c.on}`), ["tasks:true", "agenda:true", "money:true", "clock:false", "inbox:true", "goals:true", "leaderboard:true"]);
  const d = await home(fx.owner);
  assert.deepEqual(d.layout.filter((c) => c.on).map((c) => c.key), ["tasks", "agenda", "money", "inbox", "goals", "leaderboard"]);
  assert.deepEqual(Object.keys(d.cards).sort(), ["agenda", "goals", "inbox", "leaderboard", "money", "tasks"], "the clock is off: not read");
  assert.ok(Array.isArray(d.cards.leaderboard.rows), "the reports module's own rows");
  // without the reports module's service the card isn't open to them: dropped
  const hide = S.__swapServiceForTests("reports.leaderboard", null);
  try {
    const r2 = await save(fx.owner, [{ key: "tasks", on: true }, { key: "leaderboard", on: true }]);
    assert.ok(!r2.body.data.layout.some((c) => c.key === "leaderboard"));
  } finally { hide(); }
  assert.ok(Array.isArray(d.cards.tasks.items) && d.cards.tasks.can_add);
  assert.ok(Array.isArray(d.cards.inbox.items));
  assert.deepEqual(d.cards.goals, { month: "2026-11", revenue: null, jobs: null, can_edit: true });
  // another person's Home is their own
  assert.deepEqual((await home(fx.admin)).layout.filter((c) => c.on).map((c) => c.key), ["money", "leaderboard", "agenda", "inbox", "tasks", "goals"]);
  // hostile input
  assert.equal((await save(fx.owner, [{ key: "../../etc" }])).status, 400);
  assert.equal((await t.api("/home/layout", { method: "PUT", as: fx.owner, body: { cards: "all" } })).status, 400);
  // back to the defaults for the tests below
  assert.equal((await save(fx.owner, [{ key: "money", on: true }, { key: "clock", on: true }, { key: "agenda", on: true }])).status, 200);
});

test("goals: owners set a monthly revenue and jobs goal; the Money card shows the revenue's progress", async () => {
  assert.equal((await t.api("/settings/goals", { method: "PUT", as: fx.admin, ifMatch: "new", body: { revenue_month_cents: 100 } })).status, 403, "owners only");
  const put = await t.api("/settings/goals", { method: "PUT", as: fx.owner, ifMatch: "new", body: { revenue_month_cents: 2500000, jobs_month: 60 } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal((await t.api("/settings/goals", { method: "PUT", as: fx.owner, ifMatch: put.body.data.etag, body: { revenue_month_cents: -1 } })).status, 400);
  const m = (await home(fx.owner)).cards.money;
  assert.equal(m.goal, undefined, "Rotor's card has no goal line");
  await t.api("/home/layout", { method: "PUT", as: fx.owner, body: { cards: [{ key: "goals", on: true }] } });
  const g = (await home(fx.owner)).cards.goals;
  assert.deepEqual([g.revenue.target, g.revenue.value, g.jobs.target], [2500000, m.collected.total, 60], "the month's Collected, as the Money card counts it");
  assert.equal(g.jobs.value, syntheticSnapshot("2026-11-16").revenue.monthly.find((x) => x.key === "2026-11").jobs, "Rotor's paid jobs until cutover");
  await t.api("/home/layout", { method: "PUT", as: fx.owner, body: { cards: [] } });
});

test("Rotor's card's own read: Week | Month of any day (the arrows), both lines; bad input refused; inside its budget", async () => {
  const get = async (q) => t.api(`/home/money?${new URLSearchParams(q)}`, { as: fx.owner });
  const month = (await get({ period: "month" })).body.data;
  assert.deepEqual([month.period, month.from, month.label, month.source], ["month", "2026-11-01", "November 2026", "rotor"]);
  const week = (await get({ period: "week", date: TODAY })).body.data;
  assert.deepEqual([week.from, week.to, week.label, week.grain], ["2026-11-16", "2026-11-22", "Nov 16 – 22", "day"]);
  assert.equal(week.collected.total, Math.round(syntheticSnapshot("2026-11-16").revenue.weekly.find((w) => w.key === "2026-11-16").value * 100), "Rotor's week total, no points");
  assert.deepEqual(week.collected.points, []);
  assert.equal(week.scheduled.points.length, 7);
  assert.equal(week.scheduled.total, sum(week.scheduled.points.map((x) => x.value)));
  const oct = (await get({ period: "month", date: "2026-10-31" })).body.data;
  assert.deepEqual([oct.from, oct.to, oct.label], ["2026-10-01", "2026-10-31", "October 2026"]);
  assert.equal(oct.collected.total, Math.round(syntheticSnapshot("2026-11-16").revenue.monthly.find((x) => x.key === "2026-10").cur * 100), "the previous month from Rotor's months");
  const dec = (await get({ period: "month", date: "2026-12-01" })).body.data;
  assert.equal(dec.collected.total, null, "a month ahead of Rotor's snapshot: '-'");
  assert.equal((await get({ period: "year" })).status, 400);
  assert.equal((await get({ period: "week", date: "tomorrow" })).status, 400);
  assert.equal((await get({ period: "week", date: "2040-01-01" })).status, 400);
  await cold();
  const { res, calls } = await counted("/home/money?period=month&date=2026-10-15", { as: fx.owner });
  assert.equal(res.status, 200);
  assert.ok(calls.length <= 14, `${calls.length} calls`);
});

test("Collected follows the latest Rotor import: per day from the CRM's payments while it is 3 days old or less, Rotor's snapshot after", async () => {
  const O = { by: "system:test", origin: "api", actor_kind: "user", requestId: "home-import", mode: { system_of_record: "rotor", paused: false } };
  const contact = fx.world.contacts.customer;
  let run;
  await store.withStoreScope({ requestId: "home-import" }, async () => {
    // a finished import of the Nov 14 export (synthetic: counts only) and the payments it brought in
    run = (await store.createRecord("import_run", { status: "done", as_of: "2026-11-14", requested_by: "system" }, O)).data;
    for (const [on, cents, extra] of [["2026-11-04", 41000, {}], ["2026-11-12", 9000, { tip_cents: 500 }], ["2026-11-12", 2000, { kind: "refund" }], ["2026-11-13", 6600, { simulated: true }], ["2026-10-30", 9900, {}]]) {
      await store.createRecord("payment", { contact_id: contact, kind: "payment", method: "check", status: "succeeded", amount_cents: cents, received_on: on, ...extra }, O);
    }
  });
  try {
    await cold();
    const { res, calls } = await counted("/home", { as: fx.owner, office: true });
    const m = res.body.data.cards.money;
    assert.deepEqual([m.source, m.as_of, m.grain], ["import", "2026-11-14", "day"]);
    assert.equal(m.collected.total, 41000 + 9500 - 2000, "as /money/summary counts: refunds out, tips in, dry-run never");
    assert.equal(m.collected.points.length, 30);
    assert.deepEqual(["2026-11-04", "2026-11-12", "2026-11-14", "2026-11-15"].map((k) => m.collected.points.find((x) => x.key === k).value), [41000, 7500, 0, null], "through the import's day");
    assert.equal(m.scheduled.points.length, 30, "Scheduled per day");
    assert.deepEqual(res.body.data.cards.goals.revenue, { target: 2500000, value: m.collected.total }, "the Goals card counts the same");
    // one more read (this month's payments), still each once
    assert.ok(calls.some((c) => c.endsWith(" ix/payments/2026-11")));
    assert.ok(calls.length <= 19, `${calls.length} calls`);
    assert.equal(new Set(calls).size, calls.length);
    // October through the arrows: the CRM's payments too
    const oct = (await t.api("/home/money?period=month&date=2026-10-01", { as: fx.owner })).body.data;
    assert.deepEqual([oct.source, oct.collected.total], ["import", 9900]);
    // four days old: back to Rotor's snapshot and its weeks
    pin("2026-11-18T15:00:00Z");
    const stale = (await home(fx.owner)).cards.money;
    assert.deepEqual([stale.source, stale.as_of, stale.grain], ["rotor", "2026-11-16", "week"]);
  } finally {
    pin("2026-11-17T15:00:00Z");
    await store.withStoreScope({ requestId: "home-import" }, () => store.updateRecord("import_run", run.id, (r) => ({ ...r, status: "cancelled" }), O));
  }
  assert.equal((await home(fx.owner)).cards.money.source, "rotor");
});

test("the Money card's reads: Scheduled from the CRM's visits, ARR from its plans, Collected by period; bad input refused", async () => {
  const get = async (q) => t.api(`/home/money?${new URLSearchParams(q)}`, { as: fx.owner });
  const sch = (await get({ metric: "scheduled", period: "month" })).body.data;
  assert.equal(sch.source, "crm");
  assert.ok(sch.total > 0, "the seed's jobs have prices");
  assert.equal(sch.points.length, 30);
  assert.equal(sch.total, sum(sch.points.map((p) => p.value)));
  assert.ok(sch.peak && sch.avg > 0);
  const arr = (await get({ metric: "arr", period: "month" })).body.data;
  assert.ok(arr.total > 0, "the seed's live plans");
  assert.equal(typeof arr.change, "number");
  for (const period of ["week", "3m", "year"]) {
    const c = (await get({ metric: "collected", period })).body.data;
    assert.equal(c.period, period);
    assert.equal(c.source, "rotor");
    assert.ok(c.total > 0, period);
  }
  const custom = (await get({ metric: "collected", period: "custom", from: "2026-11-01", to: "2026-11-10" })).body.data;
  assert.deepEqual([custom.total, custom.label], [null, "Nov 1 – 10"], "Rotor's snapshot has no custom range: '-'");
  assert.equal((await get({ metric: "profit" })).status, 400);
  assert.equal((await get({ period: "decade" })).status, 400);
  assert.equal((await get({ period: "custom", from: "2026-11-10", to: "2026-11-01" })).status, 400);
  // a year of scheduled stays inside the route's budget
  await cold();
  const { res, calls } = await counted(`/home/money?${new URLSearchParams({ metric: "scheduled", period: "year" })}`, { as: fx.owner });
  assert.equal(res.status, 200);
  assert.ok(calls.length <= 22, `${calls.length} calls`);
});

test("after cutover the collected money is the CRM's own payments, by day", async () => {
  const O = { by: "system:test", origin: "api", actor_kind: "user", requestId: "home-pay", mode: { system_of_record: "crm", paused: false } };
  const contact = fx.world.contacts.customer;
  await store.withStoreScope({ requestId: "home-pay" }, async () => {
    for (const [on, cents, extra] of [["2026-11-02", 30000, {}], ["2026-11-16", 12000, { tip_cents: 1800 }], ["2026-11-03", 5000, { kind: "refund" }], ["2026-11-10", 77700, { simulated: true }]]) {
      await store.createRecord("payment", { contact_id: contact, kind: "payment", method: "check", status: "succeeded", amount_cents: cents, received_on: on, ...extra }, O);
    }
  });
  await setMode("crm");
  try {
    const m = (await home(fx.owner)).cards.money;
    assert.deepEqual([m.source, m.as_of, m.grain], ["crm", null, "day"]);
    // (the import test's payments are in the CRM too: Nov 4 and 12)
    assert.equal(m.collected.total, 30000 + 13800 - 5000 + 41000 + 9500 - 2000);
    assert.equal(m.collected.points.find((p) => p.key === "2026-11-16").value, 13800);
    assert.equal(m.collected.points.find((p) => p.key === "2026-11-18").value, null, "a day ahead");
    assert.ok(m.updated_at);
    const old = (await t.api("/home/money?metric=collected&period=month", { as: fx.owner })).body.data;
    assert.equal(old.total, m.collected.total, "the older one-metric read agrees");
  } finally { await setMode("rotor"); }
});

test("the clock: Clock in from Home shows the open shift; Clock out adds its minutes to today's", async () => {
  // (off by default for an owner who doesn't go out on visits: Edit Home turns it on)
  assert.equal((await t.api("/home/layout", { method: "PUT", as: fx.owner, body: { cards: [{ key: "money", on: true }, { key: "clock", on: true }] } })).status, 200);
  try {
    const cin = await t.api("/clock", { method: "POST", as: fx.owner, body: { action: "in", category: "sales", client_id: randomUUID(), client_at: "2026-11-17T15:00:00Z" } });
    assert.ok([200, 201].includes(cin.status), JSON.stringify(cin.body));
    pin("2026-11-17T16:30:00Z");
    const on = (await home(fx.owner)).cards.clock;
    assert.deepEqual([on.open && on.open.category, on.minutes], ["sales", 90]);
    const out = await t.api("/clock", { method: "POST", as: fx.owner, body: { action: "out", client_id: randomUUID(), client_at: "2026-11-17T16:30:00Z" } });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const off = (await home(fx.owner)).cards.clock;
    assert.deepEqual([off.open, off.minutes], [null, 90]);
  } finally { pin("2026-11-17T15:00:00Z"); }
});

test("the agenda's own read: a week and a month; a day with nothing booked is empty", async () => {
  const get = async (q) => (await t.api(`/home/agenda?${new URLSearchParams(q)}`, { as: fx.owner })).body.data;
  const week = await get({ view: "week", date: TODAY });
  assert.deepEqual([week.from, week.to], ["2026-11-16", "2026-11-22"]);
  assert.ok(week.count >= 4);
  assert.ok((await get({ view: "month", date: TODAY })).count >= week.count);
  const empty = await get({ view: "day", date: "2026-11-15" });
  assert.deepEqual([empty.count, empty.items], [0, []]);
  assert.equal((await t.api("/home/agenda?view=year", { as: fx.owner })).status, 400);
  assert.equal((await t.api("/home/agenda?date=tomorrow", { as: fx.owner })).status, 400);
});

test("the leaderboard waits for the reports module's service: hidden without it, its rows with it", async () => {
  const hide = S.__swapServiceForTests("reports.leaderboard", null);
  try {
    assert.equal((await t.api("/home/leaderboard", { as: fx.owner })).status, 404);
    assert.ok(!(await home(fx.owner)).layout.some((c) => c.key === "leaderboard"), "hidden without the service");
  } finally { hide(); }
  const asked = [];
  const put = S.__swapServiceForTests("reports.leaderboard", async (q) => { asked.push(q.board); return { rows: [{ user_id: fx.owner.id, name: "Olive Owner", value_cents: 120000, count: 2 }] }; });
  try {
    assert.ok((await home(fx.owner)).layout.some((c) => c.key === "leaderboard"), "offered");
    await t.api("/home/layout", { method: "PUT", as: fx.owner, body: { cards: [{ key: "leaderboard", on: true }] } });
    const b = (await home(fx.owner)).cards.leaderboard;
    assert.deepEqual([b.board, b.title, b.rows[0].name, b.rows[0].value, b.rows[0].note], ["sales", "November Leaderboard", "Olive Owner", 120000, "2 sold"]);
    const techs = (await t.api("/home/leaderboard?board=techs", { as: fx.owner })).body.data;
    assert.equal(techs.board, "techs");
    assert.deepEqual(asked.slice(-2), ["sales", "techs"]);
    assert.ok(asked.every((b) => b === "sales" || b === "techs"));
    assert.ok(!(await home(fx.noReports)).layout.some((c) => c.key === "leaderboard"), "money people only");
  } finally {
    put();
    await t.api("/home/layout", { method: "PUT", as: fx.owner, body: { cards: [] } });
  }
  // the reports module's own answer: rows Home reads (name, colour, the money, a short note)
  const real = await t.api("/home/leaderboard?board=techs", { as: fx.owner });
  assert.equal(real.status, 200, JSON.stringify(real.body));
  assert.ok(Array.isArray(real.body.data.rows) && real.body.data.rows.every((x) => x.name && typeof x.value === "number"));
});

test("the snapshot is opened once per warm instance, and a missing key says why without numbers", async () => {
  H.clearSnapshotCache();
  const a = H.officeSnapshot();
  assert.equal(H.officeSnapshot(), a);
  assert.deepEqual(H.officeSnapshot({ OFFICE_DATA_KEY: "" }), { ok: false, reason: "no-key" });
  H.clearSnapshotCache();
  const saved = process.env.OFFICE_DATA_KEY;
  delete process.env.OFFICE_DATA_KEY;
  try {
    const d = await home(fx.owner);
    assert.deepEqual([d.cards.money.collected.total, d.cards.money.missing, d.cards.money.source], [null, "no-key", "rotor"]);
    assert.ok(d.cards.money.scheduled.total > 0, "Scheduled is the CRM's own");
    assert.ok(!JSON.stringify(d).includes(KEY.slice(0, 12)));
  } finally {
    process.env.OFFICE_DATA_KEY = saved;
    H.clearSnapshotCache();
  }
});

// ------------------------------------------------------------ the client

test("Home keeps the modules' Today cards off; Edit Home is in My account; the Menu and Home's route", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../../../crm-app/modules/system/home.js", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/cards\.js|loadCards|\/me\/badges/.test(src), "no module cards, no badges call");
  assert.match(fs.readFileSync(new URL("../../../crm-app/modules/system/me.js", import.meta.url), "utf8"), /#\/today\?edit=1/);
  const { MANIFESTS } = await import("../../../crm-app/modules/index.js");
  const sys = MANIFESTS.find((m) => m.name === "system");
  const today = sys.routes.find((r) => r.path === "/today");
  assert.equal(today.title({ role: "owner" }), "Home");
  assert.equal(today.title({ role: "tech" }), "Today");
  assert.ok(sys.routes.some((r) => r.path === "/dashboard/:view"), "the full dashboards stay (Money's See more)");
});

// ------------------------------------------------------------ the client's navigation

test("the Menu: every manifest's Menu entry names a known section; an older shell's bar becomes today's", async () => {
  const nav = await import("../../../crm-app/core/nav.js");
  const { MANIFESTS } = await import("../../../crm-app/modules/index.js");
  const entries = MANIFESTS.flatMap((m) => (m.nav || []).filter((n) => n.where === "more").map((n) => ({ ...n, module: m.name })));
  assert.ok(entries.length >= 20);
  // every Menu entry has one place: a Menu group (core/nav.js MENU), the Settings hub, or (Settings, My account) its own button
  const placed = new Set([...Object.values(nav.MENU).flat().map(([p]) => p), ...nav.IN_SETTINGS, "/settings", "/me"]);
  assert.deepEqual(entries.filter((n) => !placed.has(n.path)).map((n) => `${n.module}: ${n.label}`), [], "each entry has its place");
  assert.deepEqual(nav.SECTIONS.map(([, l]) => l), ["Work", "Sales", "Customers", "Money", "Marketing & messages", "More"]);
  assert.deepEqual(nav.normalize(["today", "inbox", "contacts", "schedule", "dashboard", "more"]), ["home", "schedule", "inbox", "map", "menu"]);
  assert.deepEqual(nav.normalize(["today", "inbox", "time", "pay", "me"]), ["today", "inbox", "time", "pay", "me"]);
  assert.deepEqual(nav.normalize(navFor({ role: "owner" })), navFor({ role: "owner" }));
  for (const key of navFor({ role: "owner" })) assert.ok(nav.TABS[key], `a tab for ${key}`);
  assert.deepEqual(nav.TABS.sales.group.map(([p]) => p), ["/pipeline", "/leads", "/calls", "/quotes", "/tasks"]);
  const sys = MANIFESTS.find((m) => m.name === "system");
  assert.ok(sys.routes.some((r) => r.path === "/menu"));
  // the dashboards are Reports: out of the bar, still reachable (Money's "See more", Menu → Money → Reports, old office links)
  assert.ok(!navFor({ role: "owner" }).includes("dashboard"));
  assert.ok(sys.routes.some((r) => r.path === "/dashboard/:view"));
  assert.ok(nav.MENU.money.some(([p, l]) => p === "/dashboard" && l === "Reports"));
});
