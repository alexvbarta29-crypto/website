// Home (the owner's Nov 12 choice: Rotor's phone Home with the best of
// Flyra's, as cards each person shows, hides and orders): GET /home, the
// cards' own reads and Edit Home, and the pure parts (home-kpis.mjs). Who
// gets which card, where the money comes from (Rotor's snapshot until
// cutover, the CRM's payments after; Scheduled and ARR from the CRM's
// visits and plans), the clock, the agenda, goals, the leaderboard service
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
  assert.deepEqual(K.layoutOf(null, all), [{ key: "clock", on: true }, { key: "money", on: true }, { key: "agenda", on: true }, { key: "inbox", on: false }, { key: "tasks", on: false }, { key: "goals", on: false }]);
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

test("the tab bar: Home · Inbox · Schedule · Customers · Sales · Menu for the office; techs keep theirs", () => {
  assert.deepEqual(navFor({ role: "owner" }), ["home", "inbox", "schedule", "contacts", "sales", "menu"]);
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

test("an owner's Home: the header, Clock in, Money and Today on; the others offered in Edit Home, off", async () => {
  const res = await t.api("/home", { as: fx.owner });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const d = res.body.data;
  assert.equal(d.date, TODAY);
  assert.equal(d.user.first_name, "Olive");
  assert.deepEqual(d.layout, [{ key: "clock", on: true }, { key: "money", on: true }, { key: "agenda", on: true }, { key: "inbox", on: false }, { key: "tasks", on: false }, { key: "goals", on: false }], "no leaderboard without the reports module's service");
  assert.deepEqual(Object.keys(d.cards).sort(), ["agenda", "clock", "money"], "a card that is off isn't computed");
  assert.deepEqual(d.cards.clock, { minutes: 0, open: null });
  // money: Rotor's numbers until cutover, this month
  const m = d.cards.money;
  assert.deepEqual([m.metric, m.period, m.source, m.as_of, m.label], ["collected", "month", "rotor", "2026-11-16", "November"]);
  assert.equal(m.total, Math.round(syntheticSnapshot("2026-11-16").revenue.this_month * 100));
  assert.equal(m.goal, null, "no goal set");
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
  assert.ok(withOffice.cards.money && withOffice.cards.money.total > 0, "the office sign-in opens the office dashboard's numbers");
  for (const office of [false, true]) {
    const res = await t.api("/home", { as: fx.tech, office });
    assert.equal(res.status, 200);
    assert.deepEqual({ ...res.body.data, now: null }, { date: TODAY, now: null, user: null, mode: null, notifications: null, layout: [], cards: {} }, "a technician never gets Home");
    assert.equal((await t.api("/home/money", { as: fx.tech, office })).status, 403);
    assert.equal((await t.api("/home/layout", { method: "PUT", as: fx.tech, body: { cards: [] } })).status, 400);
  }
  assert.equal((await t.api("/home", { office: true })).status, 401, "the office cookie alone is not a CRM sign-in");
});

test("the budget: a cold default Home is 12 storage calls, each read once, nothing for the cards that are off", async () => {
  await cold();
  const { res, calls } = await counted("/home", { as: fx.owner, office: true });
  assert.equal(res.status, 200);
  const keys = calls.map((c) => c.replace(/^\S+ /, "").replace(/us_\w+\/?$/, "{user}").replace(/^ses\/\w+$/, "ses/{id}")).sort();
  assert.deepEqual(keys, ["cfg/goals", "cfg/permissions", "ix/tasks/open", "ix/timesheets/2026-11", "ix/users", "ix/visits/2026-11", "ptr/home/{user}", "rec/user/{user}", "rel/user-unread/{user}", "ses/{id}", "sys/auth-epoch", "sys/mode"], calls.join("\n"));
  assert.equal(new Set(calls).size, calls.length, "nothing read twice");
  assert.ok(!calls.some((c) => c.includes("ix-dirty/")), "no dirty markers");
  for (const gone of ["ix/inbox/open", "ix/jobs/open", "ix/plans", "ix/sales-attention", "ix/merge-candidates", "sys/health", "ix/import-runs"]) assert.ok(!calls.some((c) => c.endsWith(" " + gone)), `${gone} is not read`);
});

test("Edit Home: the person's cards on, off and in their order, saved per person; the others' untouched", async () => {
  const save = (as, cards) => t.api("/home/layout", { method: "PUT", as, body: { cards } });
  const r = await save(fx.owner, [{ key: "tasks", on: true }, { key: "agenda", on: true }, { key: "money", on: true }, { key: "clock", on: false }, { key: "inbox", on: true }, { key: "goals", on: true }, { key: "leaderboard", on: true }]);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data.layout.map((c) => `${c.key}:${c.on}`), ["tasks:true", "agenda:true", "money:true", "clock:false", "inbox:true", "goals:true"], "the leaderboard isn't open to them (no service): dropped");
  const d = await home(fx.owner);
  assert.deepEqual(d.layout.filter((c) => c.on).map((c) => c.key), ["tasks", "agenda", "money", "inbox", "goals"]);
  assert.deepEqual(Object.keys(d.cards).sort(), ["agenda", "goals", "inbox", "money", "tasks"], "the clock is off: not read");
  assert.ok(Array.isArray(d.cards.tasks.items) && d.cards.tasks.can_add);
  assert.ok(Array.isArray(d.cards.inbox.items));
  assert.deepEqual(d.cards.goals, { month: "2026-11", revenue: null, jobs: null, can_edit: true });
  // another person's Home is their own
  assert.deepEqual((await home(fx.admin)).layout.filter((c) => c.on).map((c) => c.key), ["clock", "money", "agenda"]);
  // hostile input
  assert.equal((await save(fx.owner, [{ key: "../../etc" }])).status, 400);
  assert.equal((await t.api("/home/layout", { method: "PUT", as: fx.owner, body: { cards: "all" } })).status, 400);
  // back to the defaults for the tests below
  assert.equal((await save(fx.owner, [{ key: "clock", on: true }, { key: "money", on: true }, { key: "agenda", on: true }])).status, 200);
});

test("goals: owners set a monthly revenue and jobs goal; the Money card shows the revenue's progress", async () => {
  assert.equal((await t.api("/settings/goals", { method: "PUT", as: fx.admin, ifMatch: "new", body: { revenue_month_cents: 100 } })).status, 403, "owners only");
  const put = await t.api("/settings/goals", { method: "PUT", as: fx.owner, ifMatch: "new", body: { revenue_month_cents: 2500000, jobs_month: 60 } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal((await t.api("/settings/goals", { method: "PUT", as: fx.owner, ifMatch: put.body.data.etag, body: { revenue_month_cents: -1 } })).status, 400);
  const m = (await home(fx.owner)).cards.money;
  assert.deepEqual([m.goal.target, m.goal.value], [2500000, m.total]);
  assert.equal(m.goal.pct, Math.round((m.total / 2500000) * 100));
  await t.api("/home/layout", { method: "PUT", as: fx.owner, body: { cards: [{ key: "goals", on: true }] } });
  const g = (await home(fx.owner)).cards.goals;
  assert.deepEqual([g.revenue.target, g.revenue.value, g.jobs.target], [2500000, m.total, 60]);
  assert.equal(g.jobs.value, syntheticSnapshot("2026-11-16").revenue.monthly.find((x) => x.key === "2026-11").jobs, "Rotor's paid jobs until cutover");
  await t.api("/home/layout", { method: "PUT", as: fx.owner, body: { cards: [] } });
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
    assert.deepEqual([m.source, m.total, m.grain], ["crm", 30000 + 13800 - 5000, "day"]);
    assert.equal(m.points.find((p) => p.key === "2026-11-16").value, 13800);
    assert.ok(m.updated_at);
  } finally { await setMode("rotor"); }
});

test("the clock: Clock in from Home shows the open shift; Clock out adds its minutes to today's", async () => {
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
  assert.equal((await t.api("/home/leaderboard", { as: fx.owner })).status, 404);
  const asked = [];
  const put = S.__swapServiceForTests("reports.leaderboard", async (q) => { asked.push(q.board); return { rows: [{ user_id: fx.owner.id, name: "Olive Owner", value_cents: 120000, count: 2 }] }; });
  try {
    assert.ok((await home(fx.owner)).layout.some((c) => c.key === "leaderboard" && !c.on), "offered, off until added");
    await t.api("/home/layout", { method: "PUT", as: fx.owner, body: { cards: [{ key: "leaderboard", on: true }] } });
    const b = (await home(fx.owner)).cards.leaderboard;
    assert.deepEqual([b.board, b.title, b.rows[0].name, b.rows[0].value, b.rows[0].note], ["sales", "November Leaderboard", "Olive Owner", 120000, "2 sold"]);
    const techs = (await t.api("/home/leaderboard?board=techs", { as: fx.owner })).body.data;
    assert.equal(techs.board, "techs");
    assert.deepEqual(asked, ["sales", "techs"]);
    assert.ok(!(await home(fx.noReports)).layout.some((c) => c.key === "leaderboard"), "money people only");
  } finally {
    put();
    await t.api("/home/layout", { method: "PUT", as: fx.owner, body: { cards: [] } });
  }
  assert.ok(!(await home(fx.owner)).layout.some((c) => c.key === "leaderboard"), "gone again with the service");
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
    assert.deepEqual([d.cards.money.total, d.cards.money.missing], [null, "no-key"]);
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
