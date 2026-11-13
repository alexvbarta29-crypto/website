// Home (the owner's Nov 12 choice: today's schedule and the money this
// month, nothing more): GET /home and its pure parts (home-kpis.mjs). Who
// gets what (the money for reports:read or the office sign-in, never a
// technician; today's visits for schedule:read), where the money comes from
// (the Rotor snapshot until cutover, the CRM's own payments after), the
// day off ("Next up"), the request budget, and what Home no longer reads.
// Synthetic data only (tests/e2e/seed.mjs, tests/helpers/office-snapshot.mjs).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { crmTest } from "../../helpers/crm-http.mjs";
import { pin } from "../../helpers/crm-clock.mjs";
import { sealedSnapshot, syntheticSnapshot } from "../../helpers/office-snapshot.mjs";

const store = await import("../../../netlify/lib/crm-store.mjs");
const K = await import("../../../netlify/lib/crm/modules/system/home-kpis.mjs");
const H = await import("../../../netlify/lib/crm/modules/system/home.mjs");
const R = await import("../../../netlify/lib/crm/core/registry.mjs");
const { navFor } = await import("../../../netlify/lib/crm/modules/system/me.mjs");

const sum = (xs) => xs.reduce((a, x) => a + (x || 0), 0);

// ------------------------------------------------------------ pure

test("the month's weeks: Monday to Sunday, cut at the 1st and the month's end, every day once", () => {
  // November 2026 starts on a Sunday: Nov 1 alone, then five Monday weeks, the last cut at the 30th
  assert.deepEqual(K.monthWeeks("2026-11").map((w) => [w.from, w.to, w.label]), [
    ["2026-11-01", "2026-11-01", "Nov 1"], ["2026-11-02", "2026-11-08", "Nov 2"], ["2026-11-09", "2026-11-15", "Nov 9"],
    ["2026-11-16", "2026-11-22", "Nov 16"], ["2026-11-23", "2026-11-29", "Nov 23"], ["2026-11-30", "2026-11-30", "Nov 30"]]);
  // June 2026 starts on a Monday: no short first week
  assert.deepEqual(K.monthWeeks("2026-06").map((w) => w.from), ["2026-06-01", "2026-06-08", "2026-06-15", "2026-06-22", "2026-06-29"]);
  for (const m of ["2026-02", "2028-02", "2026-03", "2026-12", "2027-01"]) {
    const w = K.monthWeeks(m);
    const days = sum(w.map((x) => (Date.parse(x.to) - Date.parse(x.from)) / 86400000 + 1));
    assert.equal(days, new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5)), 0)).getUTCDate(), m);
    for (let i = 1; i < w.length; i++) assert.equal(new Date(w[i].from + "T12:00:00Z").getUTCDay(), 1, `${m}: ${w[i].from} is a Monday`);
  }
  assert.equal(K.spanLabel("2026-11-02", "2026-11-08"), "Nov 2–8");
  assert.equal(K.spanLabel("2026-11-01", "2026-11-01"), "Nov 1");
});

test("Rotor's money: this month, the year against the same dates last year, the weeks adding up to the month", () => {
  const snap = syntheticSnapshot("2026-11-16");
  const m = K.rotorMoney(snap, "2026-11-17");
  assert.equal(m.source, "rotor");
  assert.equal(m.as_of, "2026-11-16");
  assert.deepEqual(m.month, { key: "2026-11", label: "Nov", current: true, through: 16 });
  assert.equal(m.collected, Math.round(snap.revenue.this_month * 100), "cents, like the rest of the CRM");
  assert.deepEqual(m.compare, { kind: "ytd", cur: Math.round(snap.revenue.collected_ytd * 100), prev: Math.round(snap.revenue.collected_ytd_prev * 100), pct: 24, up: true, year: 2025 });
  const week = (k) => Math.round(snap.revenue.weekly.find((w) => w.key === k).value * 100);
  assert.deepEqual(m.weeks.map((w) => [w.from, w.value]), [
    ["2026-11-01", m.collected - week("2026-11-02") - week("2026-11-09") - week("2026-11-16")],   // the days before the first Monday
    ["2026-11-02", week("2026-11-02")], ["2026-11-09", week("2026-11-09")], ["2026-11-16", week("2026-11-16")],   // Rotor's own weeks
    ["2026-11-23", null], ["2026-11-30", null]]);   // still ahead: no value, never a zero
  assert.ok(m.weeks[0].value > 0);
  assert.equal(sum(m.weeks.map((w) => w.value)), m.collected, "the bars add up to the big number");
  // October 2026 starts on a Thursday: Oct 1-4 are the month less its Monday weeks
  const oct = K.rotorMoney(syntheticSnapshot("2026-10-28"), "2026-11-17");
  assert.deepEqual(oct.month, { key: "2026-10", label: "Oct", current: false, through: 28 }, "an older snapshot says which month");
  assert.deepEqual(oct.weeks.map((w) => w.from), ["2026-10-01", "2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"]);
  assert.equal(sum(oct.weeks.map((w) => w.value)), oct.collected);
});

test("Rotor's money leaves out what it doesn't have: no zero is invented", () => {
  assert.equal(K.rotorMoney(null, "2026-11-17"), null);
  assert.equal(K.rotorMoney({ as_of: "not a date" }, "2026-11-17"), null);
  const noRevenue = syntheticSnapshot("2026-11-16");
  delete noRevenue.revenue;
  assert.equal(K.rotorMoney(noRevenue, "2026-11-17"), null, "no month total: no money card numbers");
  const snap = syntheticSnapshot("2026-11-16");
  snap.revenue.weekly = [];
  snap.revenue.collected_ytd_prev = 0;
  const m = K.rotorMoney(snap, "2026-11-17");
  assert.deepEqual(m.weeks, [], "no weeks: no chart");
  assert.equal(m.compare, null, "a first year in Rotor: no line against last year");
  // weeks that add up to more than the month: the short first week has no bar rather than a wrong one
  const odd = syntheticSnapshot("2026-11-16");
  odd.revenue.weekly.find((w) => w.key === "2026-11-02").value = 999999;
  const o = K.rotorMoney(odd, "2026-11-17");
  assert.equal(o.weeks[0].value, null);
  assert.equal(o.weeks[1].value, 99999900);
});

test("the CRM's money: succeeded payments less refunds, tips in, dry-run never; against the same days last year", () => {
  const pay = (on, a, extra = {}) => ({ k: "payment", st: "succeeded", on, a, tip: 0, sim: 0, ...extra });
  const month = [
    pay("2026-11-01", 20000), pay("2026-11-03", 30000, { tip: 4500 }), pay("2026-11-10", 15000),
    { ...pay("2026-11-11", 2500), k: "refund" },
    pay("2026-11-12", 99900, { sim: 1 }),          // a practice (dry-run) card payment
    pay("2026-11-12", 50000, { st: "failed" }),
    pay("2026-11-18", 70000),                        // after today (a payment dated ahead): not yet
  ];
  const lastYear = [pay("2025-11-02", 40000), pay("2025-11-17", 10000), pay("2025-11-18", 90000), pay("2025-10-31", 50000)];
  const m = K.crmMoney({ today: "2026-11-17", month, lastYear });
  assert.equal(m.source, "crm");
  assert.equal(m.as_of, "2026-11-17");
  assert.deepEqual(m.month, { key: "2026-11", label: "Nov", current: true, through: 17 });
  assert.equal(m.collected, 20000 + 34500 + 15000 - 2500);
  assert.deepEqual(m.compare, { kind: "month", cur: 67000, prev: 50000, pct: 34, up: true, year: 2025, from: "2025-11-01", to: "2025-11-17" });
  assert.deepEqual(m.weeks.map((w) => [w.from, w.value]), [["2026-11-01", 20000], ["2026-11-02", 34500], ["2026-11-09", 12500], ["2026-11-16", 0], ["2026-11-23", null], ["2026-11-30", null]]);
  assert.equal(sum(m.weeks.map((w) => w.value)), m.collected);
  // no payments a year back (history not that far): no line, never "up 100%"
  assert.equal(K.crmMoney({ today: "2026-11-17", month, lastYear: [] }).compare, null);
  // Feb 29 compares with Feb 1-28 a year earlier
  const leap = K.crmMoney({ today: "2028-02-29", month: [pay("2028-02-10", 1000)], lastYear: [pay("2027-02-28", 500)] });
  assert.deepEqual([leap.compare.to, leap.compare.pct], ["2027-02-28", 100]);
  assert.equal(K.collectedOf([{ k: "refund", st: "succeeded", on: "2026-11-02", a: 100, tip: 0 }], "2026-11-01", "2026-11-30"), -100, "a month of refunds reads below zero");
});

test("the tab bar: Home · Schedule · Inbox · Customers · Sales · Menu for the office; techs keep theirs", () => {
  assert.deepEqual(navFor({ role: "owner" }), ["home", "schedule", "inbox", "contacts", "sales", "menu"]);
  assert.deepEqual(navFor({ role: "admin" }), ["home", "schedule", "inbox", "contacts", "sales", "menu"]);
  assert.deepEqual(navFor({ role: "tech" }), ["today", "inbox", "time", "pay", "me"]);
});

// ------------------------------------------------------------ GET /home

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

// the storage calls one request made (the memory store records each)
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

test("an owner's Home: today's visits in time order with who and where, how many are done, and Rotor's money", async () => {
  const res = await t.api("/home", { as: fx.owner });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const d = res.body.data;
  assert.equal(d.date, "2026-11-17");
  assert.deepEqual(Object.keys(d).sort(), ["date", "mode", "money", "money_missing", "notifications", "now", "today"], "two things (and the bell), nothing more");
  // today: the seed's four visits, in time order, each with its people
  assert.equal(d.today.counts.visits, 4);
  assert.equal(d.today.counts.done, 0);
  assert.equal(d.today.next, null, "a day with visits has no 'next up'");
  assert.deepEqual(d.today.visits.map((v) => v.start), [...d.today.visits.map((v) => v.start)].sort());
  for (const v of d.today.visits) {
    assert.match(v.id, /^vs_/);
    assert.ok(v.name && v.town && v.title && v.people.length, JSON.stringify(v));
    assert.ok(v.people.every((p) => p.first_name && p.color));
    assert.equal(v.contact_id, undefined, "names for the list, no contact ids");
  }
  // the money: Rotor's numbers until cutover
  assert.equal(d.money.source, "rotor");
  assert.equal(d.money.as_of, "2026-11-16");
  assert.equal(d.money.compare.kind, "ytd");
  assert.equal(d.money.weeks.length, 6);
  assert.equal(sum(d.money.weeks.map((w) => w.value)), d.money.collected);
  assert.equal(d.money_missing, null);
  assert.equal(typeof d.notifications, "number");
  assert.deepEqual(d.mode, { paused: false, paused_at: null, paused_reason: null });
  // a visit done shows in the count
  await store.withStoreScope({ requestId: "home-done" }, async () => {
    const WORK = await import("../../../netlify/lib/crm/modules/work/office.mjs");
    await WORK.changeVisit(d.today.visits[0].id, "office_complete", { ctx: { by: "system:test", origin: "api", actor_kind: "user", requestId: "home-done", mode: { system_of_record: "rotor", paused: false } } });
  });
  const after1 = (await t.api("/home", { as: fx.owner })).body.data.today;
  assert.deepEqual(after1.counts, { visits: 4, done: 1 });
  assert.equal(after1.visits.find((v) => v.id === d.today.visits[0].id).status, "completed");
});

test("who sees what: the money needs reports:read or the office sign-in; a technician gets nothing", async () => {
  const admin = (await t.api("/home", { as: fx.admin })).body.data;
  assert.ok(admin.money && admin.money.collected > 0, "the office has reports:read");
  const denied = (await t.api("/home", { as: fx.noReports })).body.data;
  assert.equal(denied.money, null, "reports:read taken away: no money");
  assert.equal(denied.money_missing, null, "and no reason either: it isn't theirs to see");
  assert.ok(denied.today, "the schedule still");
  const withOffice = (await t.api("/home", { as: fx.noReports, office: true })).body.data;
  assert.ok(withOffice.money && withOffice.money.collected > 0, "the office sign-in opens the office dashboard's numbers");
  for (const office of [false, true]) {
    const res = await t.api("/home", { as: fx.tech, office });
    assert.equal(res.status, 200);
    assert.deepEqual({ ...res.body.data, now: null }, { date: "2026-11-17", now: null, mode: null, today: null, money: null, money_missing: null, notifications: null }, "a technician never gets the money, the schedule or the office's rows");
    assert.ok(!/ct_|vs_|us_/.test(res.text), "no record ids");
  }
  assert.equal((await t.api("/home", { office: true })).status, 401, "the office cookie alone is not a CRM sign-in");
  assert.equal((await t.api("/home", {})).status, 401);
});

test("the budget: a cold Home is 8 storage calls (it was 23), each read once, nothing Home no longer shows", async () => {
  await cold();
  const { res, calls } = await counted("/home", { as: fx.owner, office: true });
  assert.equal(res.status, 200);
  const keys = calls.map((c) => c.replace(/^\S+ /, "").replace(/us_\w+\/?$/, "{user}").replace(/^ses\/\w+$/, "ses/{id}"));
  assert.deepEqual(keys.sort(), ["cfg/permissions", "ix/users", "ix/visits/2026-11", "rec/user/{user}", "rel/user-unread/{user}", "ses/{id}", "sys/auth-epoch", "sys/mode"], calls.join("\n"));
  assert.ok(calls.length <= H.HOME_MAX_CALLS - 15, `${calls.length} calls`);
  assert.equal(new Set(calls).size, calls.length, "nothing read twice");
  assert.ok(!calls.some((c) => c.includes("ix-dirty/")), "no dirty markers (a summary doesn't say 'stale')");
  assert.deepEqual(calls.filter((c) => /^list/.test(c)).map((c) => c.split("/").slice(0, 2).join("/")), ["list rel/user-unread"], "the bell's count is the one listing");
  // what Home no longer shows, it no longer reads: the attention counts, the to-book tray, the import runs, the job and quote numbers
  for (const gone of ["ix/sales-attention", "ix/merge-candidates", "ix/tasks/open", "ix/jobs/open", "ix/import-runs", "ix/quotes/open", "ix/plans", "ix/pending-actions", "sys/health"]) {
    assert.ok(!calls.some((c) => c.endsWith(" " + gone)), `${gone} is not read`);
  }
});

test("after cutover the money is the CRM's own payments: two more reads, still the same card", async () => {
  const O = { by: "system:test", origin: "api", actor_kind: "user", requestId: "home-pay", mode: { system_of_record: "crm", paused: false } };
  const contact = fx.world.contacts.customer || Object.values(fx.world.contacts).find((x) => typeof x === "string" && x.startsWith("ct_"));
  await store.withStoreScope({ requestId: "home-pay" }, async () => {
    for (const [on, cents, extra] of [["2026-11-02", 30000, {}], ["2026-11-16", 12000, { tip_cents: 1800 }], ["2026-11-03", 5000, { kind: "refund" }], ["2026-11-10", 77700, { simulated: true }], ["2025-11-05", 20000, {}], ["2025-11-20", 99900, {}]]) {
      await store.createRecord("payment", { contact_id: contact, kind: "payment", method: "check", status: "succeeded", amount_cents: cents, received_on: on, ...extra }, O);
    }
  });
  await setMode("crm");
  try {
    await cold();
    const { res, calls } = await counted("/home", { as: fx.owner, office: true });
    assert.equal(res.status, 200);
    const reads = calls.filter((c) => c.includes(" ix/payments/"));
    assert.deepEqual(reads.map((c) => c.split(" ")[1]).sort(), ["ix/payments/2025-11", "ix/payments/2026-11"], "this month and the same month a year back");
    assert.equal(calls.length, 10, calls.join("\n"));
    const m = res.body.data.money;
    assert.equal(m.source, "crm");
    assert.equal(m.collected, 30000 + 13800 - 5000, "the dry-run payment never counts");
    assert.deepEqual([m.compare.kind, m.compare.prev, m.compare.to], ["month", 20000, "2025-11-17"]);
    assert.deepEqual(m.weeks.map((w) => w.value), [0, 25000, 0, 13800, null, null]);
    assert.equal(res.body.data.money_missing, null);
  } finally { await setMode("rotor"); }
});

test("a day with nothing booked shows the next day with visits, from the next month's shard if need be", async () => {
  try {
    // the Monday before the seed's day: nothing booked (the seed books the 17th and the 18th)
    pin("2026-11-16T15:00:00Z");
    const mon = (await t.api("/home", { as: fx.owner })).body.data.today;
    assert.equal(mon.date, "2026-11-16");
    assert.deepEqual(mon.counts, { visits: 0, done: 0 });
    assert.deepEqual(mon.visits, []);
    assert.equal(mon.next.date, "2026-11-17");
    assert.equal(mon.next.days, 1);
    assert.equal(mon.next.count, 4);
    assert.deepEqual(mon.next.visits.map((v) => v.start), [...mon.next.visits.map((v) => v.start)].sort());
    assert.ok(mon.next.visits.every((v) => v.name && v.people.length));
    // the last day of October: nothing left in October's shard, so November's is read too (one more read)
    pin("2026-10-31T15:00:00Z");
    await cold();
    const { res, calls } = await counted("/home", { as: fx.owner });
    const oct = res.body.data.today;
    assert.equal(oct.next.date >= "2026-11-01", true, JSON.stringify(oct.next));
    assert.deepEqual(calls.filter((c) => c.includes(" ix/visits/")).map((c) => c.split(" ")[1]), ["ix/visits/2026-10", "ix/visits/2026-11"]);
  } finally { pin("2026-11-17T15:00:00Z"); }
});

test("the snapshot is opened once per warm instance, and a missing key says why without numbers", async () => {
  H.clearSnapshotCache();
  const a = H.officeSnapshot();
  assert.equal(H.officeSnapshot(), a, "the same decoded snapshot");
  assert.equal(a.ok, true);
  const none = H.officeSnapshot({ OFFICE_DATA_KEY: "" });
  assert.deepEqual(none, { ok: false, reason: "no-key" });
  H.clearSnapshotCache();
  const saved = process.env.OFFICE_DATA_KEY;
  delete process.env.OFFICE_DATA_KEY;
  try {
    const d = (await t.api("/home", { as: fx.owner })).body.data;
    assert.equal(d.money, null);
    assert.equal(d.money_missing, "no-key");
    assert.ok(d.today, "the day still shows");
    assert.ok(!JSON.stringify(d).includes(KEY.slice(0, 12)));
  } finally {
    process.env.OFFICE_DATA_KEY = saved;
    H.clearSnapshotCache();
  }
});

test("what needs attention stays with the bell and the tab's dot (GET /me/badges), not on Home", async () => {
  const badges = (await t.api("/me/badges", { as: fx.owner })).body.data;
  for (const k of ["attention", "approvals", "notifications", "inbox_unread"]) assert.equal(typeof badges[k], "number", k);
  // the modules' attention and approval rows are still declared for the dot and their own screens
  const rows = R.allModules().flatMap((m) => [...m.attention.map((a) => a.key), ...m.approvals.map((a) => a.kind)]);
  for (const k of ["sales.attention", "plans.due", "agreements.unsigned", "contacts.merge_candidates", "work.stale", "invoices.overdue"]) assert.ok(rows.includes(k), k);
  // and Home's client reads only GET /home: no badges call, no quick actions
  const src = readFileSync(new URL("../../../crm-app/modules/system/home.js", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/\/me\/badges|\/leads\/new|\/calls\/log/.test(src), "home.js asks for nothing Home no longer shows");
  assert.equal((src.match(/ctx\.api\(/g) || []).length, 1, "one read");
});

test("of the modules' Today cards, Home keeps only My visits with the clock (one who goes out on visits)", async () => {
  const { MANIFESTS } = await import("../../../crm-app/modules/index.js");
  const cards = MANIFESTS.flatMap((m) => (m.todayCards || []).map((c) => ({ ...c, module: m.name })));
  const src = readFileSync(new URL("../../../crm-app/modules/system/home.js", import.meta.url), "utf8");
  const keep = new Set(JSON.parse(/const HOME_CARDS = new Set\((\[[^\]]*\])\)/.exec(src)[1]));
  assert.deepEqual(cards.filter((c) => keep.has(c.key)).map((c) => `${c.module}:${c.key}`), ["work:field"], "the money strip, the sales, plans and office cards stay off Home");
  // the card asks the server nothing for one who doesn't go out on visits
  const field = await cards.find((c) => c.key === "field").load();
  assert.deepEqual(await field.default.load({ user: { role: "owner", is_technician: false }, can: () => true, api: () => { throw new Error("no read"); } }), { none: true });
});

// ------------------------------------------------------------ the client's navigation

test("the Menu: every manifest's Menu entry names a known section; an older shell's bar becomes today's", async () => {
  const nav = await import("../../../crm-app/core/nav.js");
  const { MANIFESTS } = await import("../../../crm-app/modules/index.js");
  const known = new Set(nav.SECTIONS.map(([k]) => k));
  const entries = MANIFESTS.flatMap((m) => (m.nav || []).filter((n) => n.where === "more").map((n) => ({ ...n, module: m.name })));
  assert.ok(entries.length >= 20);
  assert.deepEqual(entries.filter((n) => !known.has(n.section)).map((n) => `${n.module}: ${n.label}`), [], "each entry says its section");
  for (const want of ["work", "sales", "customers", "messages", "office", "admin"]) assert.ok(entries.some((n) => n.section === want), want);
  assert.deepEqual(nav.normalize(["today", "inbox", "contacts", "schedule", "dashboard", "more"]), ["home", "schedule", "inbox", "contacts", "sales", "menu"]);
  assert.deepEqual(nav.normalize(["today", "inbox", "time", "pay", "me"]), ["today", "inbox", "time", "pay", "me"]);
  assert.deepEqual(nav.normalize(navFor({ role: "owner" })), navFor({ role: "owner" }));
  for (const key of navFor({ role: "owner" })) assert.ok(nav.TABS[key], `a tab for ${key}`);
  assert.deepEqual(nav.TABS.sales.group.map(([p]) => p), ["/pipeline", "/leads", "/calls", "/quotes", "/tasks"]);
  // Home is /today: old #/today links, every screen's parent and the default route keep working
  const sys = MANIFESTS.find((m) => m.name === "system");
  const today = sys.routes.find((r) => r.path === "/today");
  assert.equal(today.title({ role: "owner" }), "Home");
  assert.equal(today.title({ role: "admin" }), "Home");
  assert.equal(today.title({ role: "tech" }), "Today");
  assert.ok(sys.routes.some((r) => r.path === "/menu"));
  // the Dashboard is out of the bar, still reachable (Money's "See more", Menu → Admin, old office links)
  assert.ok(!navFor({ role: "owner" }).includes("dashboard"));
  assert.ok(sys.routes.some((r) => r.path === "/dashboard/:view"));
  assert.ok(entries.some((n) => n.path === "/dashboard" && n.section === "admin"));
});
