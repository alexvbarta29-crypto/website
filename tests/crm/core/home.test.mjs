// Home (design §9.2 "Today" for owners, §5.9; industry spec 13.1): GET
// /home and its pure parts (home-kpis.mjs). Who gets what (the numbers for
// reports:read or the office sign-in, never a technician; today's visits
// for schedule:read; "Needs you" by each row's permission), where each
// number comes from (the Rotor snapshot until the CRM's records cover the
// business), the request budget, and the extension points it reads.
// Synthetic data only (tests/e2e/seed.mjs, tests/helpers/office-snapshot.mjs).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { crmTest } from "../../helpers/crm-http.mjs";
import { sealedSnapshot, syntheticSnapshot } from "../../helpers/office-snapshot.mjs";

const store = await import("../../../netlify/lib/crm-store.mjs");
const K = await import("../../../netlify/lib/crm/modules/system/home-kpis.mjs");
const H = await import("../../../netlify/lib/crm/modules/system/home.mjs");
const R = await import("../../../netlify/lib/crm/core/registry.mjs");
const { navFor } = await import("../../../netlify/lib/crm/modules/system/me.mjs");

// ------------------------------------------------------------ pure

test("the Rotor snapshot as Home reads it: this month, the year against last year, the week's leads", () => {
  const r = K.rotorNumbers(syntheticSnapshot("2026-11-16"), "2026-11-17");
  assert.equal(r.as_of, "2026-11-16");
  assert.deepEqual(r.month, { key: "2026-11", label: "Nov", current: true, through: 16 });
  assert.equal(r.collected_ytd, Math.round(syntheticSnapshot("2026-11-16").revenue.collected_ytd * 100), "cents, like the rest of the CRM");
  assert.equal(r.weekly.length, 12);
  assert.equal(r.weekly[11].key, "2026-11-16");
  assert.equal(r.weekly[11].label, "Nov 16");
  assert.equal(r.monthly.length, 12);
  assert.ok(r.monthly.every((m) => Number.isInteger(m.cur) && Number.isInteger(m.prev)));
  assert.deepEqual(r.leads_week, { value: r.leads[11].value, key: "2026-11-16", current: true });
  const k = K.homeKpis({ rotor: r, today: "2026-11-17" });
  assert.deepEqual(k.tiles.map((t) => t.key), ["collected_month", "collected_ytd", "jobs_month", "avg_ticket", "close_rate", "active_plans", "leads_week", "quotes_out"]);
  assert.ok(k.tiles.every((t) => t.source === "rotor"));
  const tile = (key) => k.tiles.find((t) => t.key === key);
  assert.equal(tile("collected_month").label, "Collected this month");
  assert.equal(tile("collected_month").note, "Nov 1–16");
  assert.equal(tile("collected_ytd").delta.up, true);
  assert.equal(tile("collected_ytd").delta.vs, "vs 2025");
  assert.match(tile("active_plans").note, /^\$[\d,]+ on the books$/);
  assert.deepEqual(k.source, { rotor: { as_of: "2026-11-16" }, crm: false });
  assert.equal(k.money.weekly.length, 12);
  assert.ok(k.money.weekly.every((w) => w.source === "rotor"));
  assert.equal(k.jobs.visits_next.length, 4);
  assert.equal(k.jobs.visits_next[0].label, "Nov 16");
});

test("a snapshot from an earlier month says which month; an old week's leads say which week", () => {
  const r = K.rotorNumbers(syntheticSnapshot("2026-10-28"), "2026-11-17");
  const k = K.homeKpis({ rotor: r, today: "2026-11-17" });
  const tile = (key) => k.tiles.find((t) => t.key === key);
  assert.equal(tile("collected_month").label, "Collected in Oct");
  assert.equal(tile("collected_month").note, "Oct 1–28");
  assert.equal(tile("leads_week").note, "week of Oct 26");
  assert.equal(r.leads_week.current, false);
});

test("nothing invents a zero: with no snapshot and no CRM coverage there are no tiles and no cards", () => {
  const k = K.homeKpis({ rotor: null, crm: null, today: "2026-11-17" });
  assert.deepEqual(k.tiles, []);
  assert.equal(k.money, null);
  assert.equal(k.sales, null);
  assert.equal(k.plans, null);
  assert.equal(k.jobs, null);
  assert.equal(K.rotorNumbers({ as_of: "not a date" }, "2026-11-17"), null);
  // a snapshot missing a part leaves that tile out
  const snap = syntheticSnapshot("2026-11-16");
  delete snap.sales;
  const tiles = K.homeKpis({ rotor: K.rotorNumbers(snap, "2026-11-17"), today: "2026-11-17" }).tiles.map((t) => t.key);
  assert.ok(!tiles.includes("close_rate") && !tiles.includes("leads_week") && !tiles.includes("quotes_out"), tiles.join(", "));
});

test("the CRM's own numbers (§5.9): jobs this month, average ticket, close rate, plans, the next four weeks", () => {
  const job = (st, done, tot, bill = true) => ({ st, done, tot, bill });
  const c = K.crmNumbers({
    today: "2026-11-17",
    jobsYear: [job("completed", "2026-11-03T16:00:00Z", 30000), job("completed", "2026-11-10T16:00:00Z", 40000), job("completed", "2026-10-02T16:00:00Z", 20000),
      job("completed", "2026-11-12T16:00:00Z", 0, false), job("cancelled", null, 50000),
      // completed late on Oct 31 in Delano (Nov 1 in UTC) is October's
      job("completed", "2026-11-01T03:30:00Z", 10000)],
    jobsOpen: [{ st: "unscheduled" }, { st: "unscheduled" }, { st: "scheduled" }],
    quotesOpen: [{ st: "sent" }, { st: "viewed" }, { st: "approved" }, { st: "changes_requested" }, { st: "draft" }],
    quotesYear: [{ st: "converted", u: "2026-06-01T15:00:00Z" }, { st: "declined", u: "2026-07-01T15:00:00Z" }, { st: "archived", sent: "2026-05-01T15:00:00Z", u: "2026-05-09T15:00:00Z" }, { st: "archived", sent: null, u: "2026-05-09T15:00:00Z" }],
    plans: [{ st: "active", ck: "quarterly", sv: 100000 }, { st: "cancelling", ck: "biannual", sv: 50000 }, { st: "pending", ck: "quarterly", sv: 90000 }, { st: "active", ck: "lights_annual", k: "lights_annual", sv: 120000 }],
    visits: [{ d: "2026-11-16", st: "completed" }, { d: "2026-11-22", st: "scheduled" }, { d: "2026-11-23", st: "scheduled" }, { d: "2026-11-24", st: "cancelled" }, { d: "2026-12-13", st: "scheduled" }, { d: "2026-12-14", st: "scheduled" }],
  });
  assert.equal(c.jobs_month, 2, "billable jobs completed in November (local time)");
  assert.equal(c.avg_ticket, 25000, "work completed ÷ billable jobs completed this year");
  assert.equal(c.close_rate, 50, "won (approved, converted) ÷ won + lost (declined, archived after sending)");
  assert.deepEqual(c.quotes, { out: 2, won: 2, lost: 2, changes: 1 });
  assert.equal(c.active_plans, 3);
  assert.equal(c.plans_worth, 270000);
  assert.deepEqual(c.plan_mix.map((m) => m.label), ["Biannual", "Christmas lights", "Quarterly"]);
  assert.deepEqual(c.visits_next.map((w) => [w.key, w.value]), [["2026-11-16", 2], ["2026-11-23", 1], ["2026-11-30", 0], ["2026-12-07", 1]]);
  assert.equal(c.jobs_unscheduled, 2);
  // the CRM's numbers win where it has them; Rotor keeps money and leads
  const k = K.homeKpis({ rotor: K.rotorNumbers(syntheticSnapshot("2026-11-16"), "2026-11-17"), crm: c, today: "2026-11-17" });
  const src = Object.fromEntries(k.tiles.map((t) => [t.key, t.source]));
  assert.deepEqual(src, { collected_month: "rotor", collected_ytd: "rotor", jobs_month: "crm", avg_ticket: "crm", close_rate: "crm", active_plans: "crm", leads_week: "rotor", quotes_out: "crm" });
  assert.equal(k.tiles.find((t) => t.key === "jobs_month").note, "Nov so far");
  assert.equal(k.source.crm, true);
  // a CRM number nobody has yet (no quote decided this year) falls back to Rotor's
  const k2 = K.homeKpis({ rotor: K.rotorNumbers(syntheticSnapshot("2026-11-16"), "2026-11-17"), crm: { ...c, close_rate: null }, today: "2026-11-17" });
  assert.equal(k2.tiles.find((t) => t.key === "close_rate").source, "rotor");
});

test("a provider's series takes over from the day its data starts; Rotor keeps the weeks before", () => {
  const rows = [{ key: "2026-10-26", value: 1 }, { key: "2026-11-02", value: 2 }, { key: "2026-11-09", value: 3 }];
  assert.deepEqual(K.mergeSeries(rows, null).map((r) => r.source), ["rotor", "rotor", "rotor"]);
  const m = K.mergeSeries(rows, { since: "2026-11-02", values: { "2026-10-26": 9, "2026-11-02": 20, "2026-11-09": 30 } });
  assert.deepEqual(m.map((r) => [r.value, r.source]), [[1, "rotor"], [20, "crm"], [30, "crm"]]);
  const months = K.mergeSeries([{ key: "2026-10", cur: 5 }, { key: "2026-11", cur: 6 }], { since: "2026-11-01", values: { "2026-10": 1, "2026-11": 7 } }, "cur");
  assert.deepEqual(months.map((r) => [r.cur, r.source]), [[5, "rotor"], [7, "crm"]]);
});

test("the tab bar: Home · Inbox · Schedule · Customers · Sales · Menu for the office; techs keep theirs", () => {
  assert.deepEqual(navFor({ role: "owner" }), ["home", "inbox", "schedule", "contacts", "sales", "menu"]);
  assert.deepEqual(navFor({ role: "admin" }), ["home", "inbox", "schedule", "contacts", "sales", "menu"]);
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

test("an owner's Home: the Rotor numbers, today's visits with who and where, and what needs them", async () => {
  const res = await t.api("/home", { as: fx.owner });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const d = res.body.data;
  assert.equal(d.date, "2026-11-17");
  assert.equal(d.kpis.source.rotor.as_of, "2026-11-16");
  assert.equal(d.kpis.source.crm, false, "no import yet: the CRM's records don't cover the business");
  assert.equal(d.kpis.tiles.length, 8);
  assert.ok(d.kpis.tiles.every((x) => x.source === "rotor"));
  assert.equal(d.kpis.money.weekly.length, 12);
  // today: the seed's four visits, in time order, each with its people
  assert.equal(d.today.counts.visits, 4);
  assert.deepEqual(d.today.visits.map((v) => v.start), [...d.today.visits.map((v) => v.start)].sort());
  for (const v of d.today.visits) {
    assert.match(v.id, /^vs_/);
    assert.ok(v.name && v.town && v.people.length, JSON.stringify(v));
    assert.ok(v.people.every((p) => p.first_name && p.color));
    assert.equal(v.contact_id, undefined, "names for the list, no contact ids");
  }
  assert.ok(d.today.counts.to_book >= 1, "the to-book tray");
  assert.equal(d.today.counts.plan_due, d.needs.find((r) => r.key === "plans.due").count);
  // needs you: rows with a count, in order, each linking to its screen
  const keys = d.needs.map((r) => r.key);
  for (const k of ["sales.calls_due", "quotes.waiting", "agreements.unsigned", "plans.due"]) assert.ok(keys.includes(k), `${k} in ${keys.join(", ")}`);
  assert.ok(d.needs.every((r) => r.count > 0 && /^#\//.test(r.link)));
  assert.ok(keys.indexOf("sales.calls_due") < keys.indexOf("plans.due"));
  assert.deepEqual(d.mode, { paused: false, paused_at: null, paused_reason: null });
});

test("who sees what: the numbers need reports:read or the office sign-in; a technician gets nothing", async () => {
  const admin = (await t.api("/home", { as: fx.admin })).body.data;
  assert.ok(admin.kpis && admin.kpis.tiles.length, "the office has reports:read");
  const denied = (await t.api("/home", { as: fx.noReports })).body.data;
  assert.equal(denied.kpis, null, "reports:read taken away: no numbers");
  assert.ok(denied.today, "the schedule still");
  const withOffice = (await t.api("/home", { as: fx.noReports, office: true })).body.data;
  assert.ok(withOffice.kpis && withOffice.kpis.tiles.length, "the office sign-in opens the office dashboard's numbers");
  for (const office of [false, true]) {
    const res = await t.api("/home", { as: fx.tech, office });
    assert.equal(res.status, 200);
    assert.deepEqual({ ...res.body.data, now: null }, { date: "2026-11-17", now: null, mode: null, kpis: null, today: null, needs: [] }, "a technician never gets the numbers, the schedule or the office's rows");
    assert.ok(!/ct_|vs_|us_/.test(res.text), "no record ids");
  }
  assert.equal((await t.api("/home", { office: true })).status, 401, "the office cookie alone is not a CRM sign-in");
  assert.equal((await t.api("/home", {})).status, 401);
});

test("badge: false rows are on Home but never light the tab's dot", async () => {
  const sales = R.getModule("sales").attention.find((a) => a.key === "sales.calls_due");
  const quotes = R.getModule("quotes").attention.find((a) => a.key === "quotes.waiting");
  assert.equal(sales.badge, false);
  assert.equal(quotes.badge, false);
  const home = (await t.api("/home", { as: fx.owner })).body.data.needs;
  const badges = (await t.api("/me/badges", { as: fx.owner })).body.data;
  const quiet = new Set(R.allModules().flatMap((m) => m.attention.filter((a) => a.badge === false).map((a) => a.key)));
  assert.ok(quiet.has("sales.tasks_mine"));
  const badgeRows = home.filter((r) => r.kind === "attention" && !quiet.has(r.key)).reduce((a, r) => a + r.count, 0);
  assert.equal(badges.attention, badgeRows, "the dot counts the attention rows without badge: false");
});

test("the budget: a cold Home stays under 25 storage calls, each index read once", async () => {
  // a fresh instance: the session and permissions caches are empty
  (await import("../../../netlify/lib/crm/core/sessions.mjs")).clearSessionCache();
  (await import("../../../netlify/lib/crm/core/auth.mjs")).clearPermissionsCache();
  const { res, calls } = await counted("/home", { as: fx.owner, office: true });
  assert.equal(res.status, 200);
  assert.ok(calls.length <= 25, `${calls.length} calls:\n${calls.join("\n")}`);
  const reads = calls.filter((c) => c.includes(" ix/"));
  assert.equal(new Set(reads).size, reads.length, "no index read twice");
  assert.ok(!calls.some((c) => c.includes("ix-dirty/")), "no dirty markers (a summary doesn't say 'stale')");
  assert.ok(!calls.some((c) => /^list/.test(c)), "counts from indexes, never a listing");
});

test("after a Rotor import (or cutover) the CRM's own numbers take over, still inside the budget", async () => {
  await store.withStoreScope({ requestId: "home-mode" }, async () => {
    const cur = await store.getRaw("sys/mode");
    await store.settledWrite("sys/mode", { system_of_record: "crm", paused: false, cutover_n: 1 }, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
  });
  try {
    (await import("../../../netlify/lib/crm/core/sessions.mjs")).clearSessionCache();
    (await import("../../../netlify/lib/crm/core/auth.mjs")).clearPermissionsCache();
    const { res, calls } = await counted("/home", { as: fx.owner, office: true });
    assert.equal(res.status, 200);
    assert.ok(calls.length <= 25, `${calls.length} calls:\n${calls.join("\n")}`);
    const d = res.body.data.kpis;
    assert.equal(d.source.crm, true);
    const src = Object.fromEntries(d.tiles.map((x) => [x.key, x.source]));
    assert.equal(src.active_plans, "crm");
    assert.equal(src.jobs_month, "crm");
    assert.equal(src.quotes_out, "crm");
    assert.equal(src.collected_month, "rotor", "money stays Rotor's until Money (M5) keeps it");
    assert.equal(d.tiles.find((x) => x.key === "active_plans").value, 2, "the seed's two live plans");
    assert.equal(d.jobs.source, "crm");
    assert.equal(d.jobs.visits_next.length, 4);
  } finally {
    await store.withStoreScope({ requestId: "home-mode" }, async () => {
      const cur = await store.getRaw("sys/mode");
      await store.settledWrite("sys/mode", { system_of_record: "rotor", paused: false, cutover_n: 1 }, { onlyIfMatch: cur.etag });
    });
  }
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
    assert.deepEqual(d.kpis.tiles, []);
    assert.equal(d.kpis.source.rotor, null);
    assert.equal(d.kpis.source.rotor_missing, "no-key");
    assert.ok(!JSON.stringify(d).includes(KEY.slice(0, 12)));
  } finally {
    process.env.OFFICE_DATA_KEY = saved;
    H.clearSnapshotCache();
  }
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
  assert.deepEqual(nav.normalize(["today", "inbox", "contacts", "schedule", "dashboard", "more"]), ["home", "inbox", "schedule", "contacts", "sales", "menu"]);
  assert.deepEqual(nav.normalize(["today", "inbox", "time", "pay", "me"]), ["today", "inbox", "time", "pay", "me"]);
  assert.deepEqual(nav.normalize(navFor({ role: "owner" })), navFor({ role: "owner" }));
  for (const key of navFor({ role: "owner" })) assert.ok(nav.TABS[key], `a tab for ${key}`);
  assert.deepEqual(nav.TABS.sales.group.map(([p]) => p), ["/calls", "/quotes", "/tasks"]);
  // Home is /today: old #/today links, every screen's parent and the default route keep working
  const sys = MANIFESTS.find((m) => m.name === "system");
  const today = sys.routes.find((r) => r.path === "/today");
  assert.equal(today.title({ role: "owner" }), "Home");
  assert.equal(today.title({ role: "admin" }), "Home");
  assert.equal(today.title({ role: "tech" }), "Today");
  assert.ok(sys.routes.some((r) => r.path === "/menu"));
  // the Dashboard is out of the bar, still reachable (Home's "See more", Menu → Admin, old office links)
  assert.ok(!navFor({ role: "owner" }).includes("dashboard"));
  assert.ok(sys.routes.some((r) => r.path === "/dashboard/:view"));
  assert.ok(entries.some((n) => n.path === "/dashboard" && n.section === "admin"));
});

test("the office's Today cards are Home's server rows (home: false); new cards still land on Home", async () => {
  const { MANIFESTS } = await import("../../../crm-app/modules/index.js");
  const cards = MANIFESTS.flatMap((m) => (m.todayCards || []).map((c) => ({ ...c, module: m.name })));
  // one card lands on Home: My visits with the clock, for an owner or office person who goes out on visits (M4b; empty for one who doesn't)
  assert.deepEqual(cards.filter((c) => c.home !== false).map((c) => `${c.module}:${c.key}`), ["work:field"], "every other card of today is covered by an attention row or Home's Today");
  const rows = R.allModules().flatMap((m) => [...m.attention.map((a) => a.key), ...m.approvals.map((a) => a.kind)]);
  for (const k of ["sales.attention", "sales.calls_due", "sales.tasks_mine", "plans.due", "agreements.unsigned", "agreement_templates", "plans.clawback", "work.stale", "work.time_entries", "work.time_weeks"]) assert.ok(rows.includes(k), k);
});

test("the reports module's series (when it ships) takes over from the day its data starts; Rotor keeps the weeks before", async () => {
  const S = await import("../../../netlify/lib/crm/core/services.mjs");
  const asked = [];
  const put = S.__swapServiceForTests("reports.series", async ({ metric, group, keys }) => {
    asked.push(`${metric}/${group}/${keys.length}`);
    const since = "2026-11-01";
    return { since, values: Object.fromEntries(keys.filter((k) => (k.length === 7 ? `${k}-01` : k) >= since).map((k) => [k, metric === "leads" ? 7 : 123400])) };
  });
  try {
    const d = (await t.api("/home", { as: fx.owner })).body.data.kpis;
    assert.deepEqual(asked.sort(), ["collected/month/12", "collected/week/12", "leads/week/12"]);
    const weeks = d.money.weekly;
    assert.deepEqual(weeks.filter((w) => w.source === "crm").map((w) => [w.key, w.value]), [["2026-11-02", 123400], ["2026-11-09", 123400], ["2026-11-16", 123400]]);
    assert.ok(weeks.filter((w) => w.key < "2026-11-01").every((w) => w.source === "rotor"), "the weeks before stay Rotor's");
    assert.equal(d.money.monthly.find((m) => m.key === "2026-11").source, "crm");
    assert.equal(d.money.monthly.find((m) => m.key === "2026-10").source, "rotor");
    assert.equal(d.sales.leads.at(-1).value, 7);
  } finally { put(); }
  // a provider that fails leaves Rotor's series as they were
  const put2 = S.__swapServiceForTests("reports.series", async () => { throw new Error("rollup missing"); });
  try {
    const d = (await t.api("/home", { as: fx.owner })).body.data.kpis;
    assert.ok(d.money.weekly.every((w) => w.source === "rotor"));
  } finally { put2(); }
});
