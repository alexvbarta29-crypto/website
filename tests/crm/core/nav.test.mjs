// The phone shell and the sidebar (the Nov 2026 look, then the owner's
// "make it like Rotor"): the office's bar is Home · Schedule · Inbox · Map ·
// Menu (the Menu last: it opens the drawer, not a page), each person may
// pick up to five places of their own (Customize Tabs, saved on their user
// record; a pinned Visits is the Schedule now), the drawer is Rotor's four
// groups (Home, Inbox, Schedule | Customers, Leads, Pipelines, Power Dialer
// | Service, Financials, Tasks, Map | Analytics, Marketing) with sub-lists,
// every screen of the old Menu reachable, the gear for Settings; the desk's
// sidebar is the same drawer; the + and the desk's New are one list (the
// most used first), and the "What moved" note shows once per person.
import { test } from "node:test";
import assert from "node:assert/strict";
import { crmTest } from "../../helpers/crm-http.mjs";

const { MANIFESTS } = await import("../../../crm-app/modules/index.js");
const router = await import("../../../crm-app/core/router.js");
router.register(MANIFESTS);
const nav = await import("../../../crm-app/core/nav.js");
const quick = nav;
const { navFor, OFFICE_NAV } = await import("../../../netlify/lib/crm/modules/system/me.mjs");
const { ROLE_DEFAULTS, roleDefault } = await import("../../../netlify/lib/crm/core/perms.mjs");
await import("../../../netlify/lib/crm/modules/index.mjs");   // the modules' own permissions (the map's canvass:use)

const canOf = (role, office = true) => (p) => (p === "office:tools" ? office && role === "owner" : roleDefault(role, p) === true);
const planFor = (role, user = {}) => nav.plan({ nav: navFor({ role, ...user }), manifests: MANIFESTS, can: canOf(role), user: { id: "us_0000000000000000000a", role, name: "Pat Example", ...user } });

test("the office's bar: Home · Schedule · Inbox · Map · Menu, the Menu last (the drawer); a tech's is unchanged", () => {
  const p = planFor("owner");
  assert.deepEqual(p.bar.map((t) => t.label), ["Home", "Schedule", "Inbox", "Map", "Menu"]);
  assert.equal(p.bar[p.bar.length - 1].sheet, true, "the Menu opens the drawer");
  assert.equal(p.menu.key, "menu");
  assert.equal(nav.isTabRoot("/menu"), false, "the Menu page has a back arrow");
  assert.equal(nav.isTabRoot("/schedule"), true);
  assert.equal(nav.isTabRoot("/contacts"), true, "Customers, from the drawer, is top-level: no back button");
  assert.equal(nav.isTabRoot("/settings"), true, "Settings, the drawer's gear, too");
  assert.equal(nav.isTabRoot("/contacts/new"), false);
  assert.deepEqual(nav.TABS.sales.group.map(([, l]) => l), ["Pipeline", "Leads", "Calls", "Quotes", "Tasks"]);
  const t = nav.plan({ nav: navFor({ role: "tech" }), manifests: MANIFESTS, can: (x) => !!ROLE_DEFAULTS.tech[x], user: { id: "us_t", role: "tech" } });
  assert.deepEqual(t.bar.map((x) => x.label), ["Today", "Inbox", "Time", "Pay", "Me"]);
  assert.equal(t.menu, null, "no Menu for a tech");
  assert.deepEqual(nav.drawerGroups(), [], "no drawer for a tech");
  assert.equal(nav.drawerGear(), null, "a tech's bar is the tech app's: no Customize Tabs");
  assert.deepEqual(OFFICE_NAV, ["home", "schedule", "inbox", "map", "menu"]);
});

test("each person's own tab bar: up to five of the main places, the Menu always last; unknown ones dropped", () => {
  assert.deepEqual(navFor({ role: "owner", tabs: ["home", "pipeline", "leaderboard", "leads", "map"] }), ["home", "pipeline", "leaderboard", "leads", "map", "menu"]);
  assert.deepEqual(navFor({ role: "owner", tabs: ["home", "visits", "schedule", "leads"] }), ["home", "schedule", "leads", "menu"], "a pinned Visits is the Schedule now (once)");
  assert.deepEqual(nav.normalize(["home", "visits", "map", "menu"]), ["home", "schedule", "map", "menu"], "a cached bar too");
  assert.deepEqual(navFor({ role: "admin", tabs: ["schedule", "nope", "schedule"] }), ["schedule", "menu"]);
  assert.deepEqual(navFor({ role: "owner", tabs: [] }), OFFICE_NAV, "none picked: the standard bar");
  assert.deepEqual(navFor({ role: "tech", tabs: ["home"] }), ["today", "inbox", "time", "pay", "me"], "a tech's bar is the tech app's");
  // a place whose screen isn't there yet (the Map before its module) simply doesn't show
  const p = planFor("owner", { tabs: ["home", "pipeline", "leaderboard", "map"] });
  assert.deepEqual(p.bar.map((t) => t.key), ["home", "pipeline", "leaderboard", ...(router.has("/map") && canOf("owner")("canvass:use") ? ["map"] : []), "menu"]);
  assert.ok(router.has("/map"), "the Map is there (the maps module) and may be a tab (where: tab)");
  assert.equal(nav.isTabRoot("/map"), p.bar.some((t) => t.key === "map"), "a pinned Map is a top-level screen: no back arrow");
});

test("the tab bar is saved on the person's own record (PATCH /users/:id { tabs }) and comes back with /me", async () => {
  const t = await crmTest({ now: "2026-11-17T15:00:00.000Z" });
  try {
    const owner = await t.user("owner");
    const tech = await t.user("tech");
    const me = await t.api("/me", { as: owner });
    let r = await t.api(`/users/${owner.id}`, { as: owner, method: "PATCH", ifMatch: me.body.data.etag, body: { tabs: ["home", "visits", "leads"] } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const again = await t.api("/me", { as: owner });
    assert.deepEqual(again.body.data.nav, ["home", "schedule", "leads", "menu"], "an old pinned Visits comes back as the Schedule");
    assert.deepEqual(again.body.data.user.tabs, ["home", "visits", "leads"]);
    r = await t.api(`/users/${owner.id}`, { as: owner, method: "PATCH", ifMatch: again.body.data.etag, body: { tabs: ["home", "a", "b", "c", "d", "e"] } });
    assert.equal(r.status, 400, "six, or one that isn't a place: refused");
    const tm = await t.api("/me", { as: tech });
    r = await t.api(`/users/${tech.id}`, { as: tech, method: "PATCH", ifMatch: tm.body.data.etag, body: { tabs: ["visits"] } });
    assert.equal(r.status, 200, "anyone may keep their own");
    assert.deepEqual((await t.api("/me", { as: tech })).body.data.nav, ["today", "inbox", "time", "pay", "me"], "but a tech's bar stays the tech app's");
    r = await t.api(`/users/${owner.id}`, { as: tech, method: "PATCH", ifMatch: '"x"', body: { tabs: ["home"] } });
    assert.equal(r.status, 403, "nobody else's");
  } finally { t.done(); }
});

test("the desk's sidebar: the drawer's groups (its lists fold open), Settings at the bottom; a tech's: the bar's places", () => {
  const p = planFor("owner");
  assert.deepEqual(p.side.top, [], "no second copy of the bar");
  assert.deepEqual(p.side.groups.map((g) => g.map((it) => it.label)), nav.drawerGroups().map((g) => g.map((it) => it.label)), "the same rows as the drawer");
  const paths = p.side.groups.flat().flatMap((it) => (it.sub ? it.sub.map((x) => x.path) : [it.path]));
  for (const there of ["/today", "/schedule", "/inbox", "/contacts", "/pipeline", "/leads", "/calls", "/quotes", "/tasks", "/jobs", "/plans", "/invoices", "/payments", "/campaigns", "/leaderboard", "/map", "/team-map"]) assert.ok(paths.includes(there), `${there} is reachable on a desk`);
  assert.deepEqual(p.side.bottom.map((n) => n.label), ["Settings"]);
  assert.deepEqual(planFor("admin").side.bottom.map((n) => n.label), ["Settings"]);
  const t = nav.plan({ nav: navFor({ role: "tech" }), manifests: MANIFESTS, can: (x) => !!ROLE_DEFAULTS.tech[x], user: { id: "us_t", role: "tech" } });
  assert.deepEqual(t.side.top.map((x) => x.label), ["Today", "Inbox", "Time", "Pay", "Me"]);
  assert.deepEqual(t.side.groups, []);
});

test("the drawer: Rotor's four groups, a dot for a row with its own list, every screen of the old Menu reachable, each once; the gear", () => {
  planFor("owner");
  const g = nav.drawerGroups();
  const rows = g.map((x) => x.map((it) => it.label));
  assert.deepEqual(rows, [["Home", "Inbox", "Schedule"], ["Customers", "Leads", "Pipelines", "Power Dialer"], ["Service", "Financials", "Tasks", "Map"], ["Analytics", "Marketing"]]);
  const sub = (k) => (g.flat().find((it) => it.key === k).sub || []).map((x) => x.label);
  assert.deepEqual(sub("service"), ["Jobs", "Visits", "To book", "Quotes", "Plans", "Plan visits to book", "Lights season", "Light Studio", "Time", "Timesheets", "Pay"]);
  assert.deepEqual(sub("financials"), ["Invoices", "Payments", "Autopay", "Payroll", "Purchases"]);
  assert.deepEqual(sub("analytics"), ["Reports", "Dashboard", "Leaderboard", "My performance"]);
  assert.deepEqual(sub("marketing"), ["Campaigns", "Approvals", "Reviews", "Signs & flyers", "Giveaway", "Outbox", "Message templates", "Automations", "Follow-up cadences"]);
  assert.deepEqual(sub("map"), ["Door to door", "Team map"], "Map: both, so a list (the Team map not also under Service)");
  assert.deepEqual(sub("customers"), ["Customers", "Merge review"]);
  assert.equal(g.flat().find((it) => it.key === "inbox").count, "inbox", "Inbox carries the unread count");
  const all = g.flat().flatMap((it) => (it.sub ? it.sub.map((x) => x.path) : [it.path]));
  assert.equal(new Set(all).size, all.length, "each screen once");
  // every screen the old Menu had (Nov 2026: Work, Sales, Customers, Money, Marketing & messages)
  for (const old of ["/schedule", "/jobs", "/plans", "/lights", "/team-map", "/timesheets", "/time", "/pay", "/payroll", "/pipeline", "/leads", "/calls", "/quotes", "/tasks", "/map",
    "/tools/lights", "/leaderboard", "/performance", "/contacts", "/merge", "/invoices", "/payments", "/autopay", "/reports", "/tools/purchases", "/inbox", "/campaigns", "/approvals", "/reviews", "/signs", "/tools/giveaway", "/outbox"]) assert.ok(all.includes(old), `${old} is in the drawer`);
  for (const x of all) assert.equal(nav.isTabRoot(x.split("?")[0]), true, `${x}: a drawer screen is top-level`);
  assert.deepEqual(nav.drawerGear(), { path: "/settings", label: "Settings" });
  // someone who can't open Settings: the setup screens they may open are in the drawer (a last group), the gear is Customize Tabs
  nav.plan({ nav: navFor({ role: "admin" }), manifests: MANIFESTS, can: (x) => x !== "settings:general" && canOf("admin")(x), user: { id: "us_b", role: "admin" } });
  const g2 = nav.drawerGroups().flat().flatMap((it) => (it.sub ? it.sub.map((x) => x.path) : [it.path]));
  assert.ok(g2.includes("/templates") && g2.includes("/automations"), "not hidden from someone without Settings");
  assert.ok(g2.includes("/team") || !canOf("admin")("users:manage"), "Team in the last group");
  assert.ok(!g2.includes("/settings"));
  assert.equal(nav.drawerGear().tabs, true, "the gear opens Customize Tabs");
  // a pinned bar without Home: Home still leads the drawer
  planFor("owner", { tabs: ["pipeline", "contacts"] });
  assert.equal(nav.drawerGroups()[0][0].path, "/today");
  // only one screen of a list open: the row is that screen (a Map with no Team map is the Map)
  nav.plan({ nav: navFor({ role: "owner" }), manifests: MANIFESTS, can: (x) => x !== "team_map:read" && canOf("owner")(x), user: { id: "us_c", role: "owner" } });
  const m = nav.drawerGroups().flat().find((it) => it.key === "map");
  assert.deepEqual([m.label, m.path, m.sub], ["Map", "/map", undefined]);
});

test("Customize Tabs: up to five above the line, the rest under MORE MENU; + and −, moves by one, a drop past five", async () => {
  const T = await import("../../../crm-app/modules/system/tab-bar.js");
  let s = { picked: ["home", "schedule", "inbox", "map"], rest: ["contacts", "leads", "quotes"] };
  s = T.toggle(s, "quotes");
  assert.deepEqual(s.picked, ["home", "schedule", "inbox", "map", "quotes"]);
  assert.equal(T.toggle(s, "leads"), null, "a sixth: refused");
  assert.deepEqual(T.toggle(s, "map").rest[0], "map", "taken off: first under the line");
  assert.deepEqual(T.step(s, "schedule", -1).picked.slice(0, 2), ["schedule", "home"], "up one");
  const down = T.step(s, "quotes", 1);
  assert.deepEqual([down.picked, down.rest[0]], [["home", "schedule", "inbox", "map"], "quotes"], "down past the line: off the bar");
  const up = T.step(down, "quotes", -1);
  assert.deepEqual(up.picked, ["home", "schedule", "inbox", "map", "quotes"], "and back");
  assert.deepEqual(T.settle(["home", "schedule", "inbox", "map", "quotes", "leads", "|", "contacts"]), { picked: ["home", "schedule", "inbox", "map", "quotes"], rest: ["leads", "contacts"] }, "dropped as a sixth: the last goes below the line");
  assert.deepEqual(T.STANDARD, ["home", "schedule", "inbox", "map"]);
  const h = String(T.tabsList(s));
  assert.match(h, /data-ctb-line/);
  assert.match(h, /More menu/);
  assert.match(h, /data-ctb-out="home"[\s\S]*data-ctb-line[\s\S]*data-ctb-in="contacts"/);
  assert.doesNotMatch(h, /—/);
});

test("the + and the desk's New: one list, the most used first, each once", () => {
  planFor("owner");
  const creates = MANIFESTS.flatMap((m) => m.creates || []);
  assert.deepEqual(quick.quickCreates(creates, canOf("owner")).map((c) => c.label), ["Lead or customer", "Quote", "Job", "Invoice", "Plan", "Task"]);
  assert.deepEqual(quick.quickCreates(creates.filter((c) => c.path === "/leads/new"), (p) => !!ROLE_DEFAULTS.tech[p]).map((c) => c.label), ["Lead"], "a tech: a quick lead");
});

test("What moved: once per person on this device; a browser that keeps nothing never nags", () => {
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  try {
    planFor("owner");
    assert.equal(nav.wantsMoved("us_a"), true, "the office, first time");
    nav.seenMoved("us_a");
    assert.equal(nav.wantsMoved("us_a"), false, "then never again");
    assert.equal(nav.wantsMoved("us_b"), true, "someone else on the same phone still gets it");
    assert.ok(store.has(`${nav.MOVED_KEY}:us_a`));
    nav.plan({ nav: navFor({ role: "tech" }), manifests: MANIFESTS, can: (x) => !!ROLE_DEFAULTS.tech[x], user: { id: "us_t", role: "tech" } });
    assert.equal(nav.wantsMoved("us_t"), false, "a tech's bar didn't change");
    planFor("owner");
    globalThis.localStorage = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    assert.equal(nav.wantsMoved("us_c"), false);
    assert.match(nav.MOVED_TEXT.phone, /Menu is a drawer/);
    assert.doesNotMatch(nav.MOVED_TEXT.phone + nav.MOVED_TEXT.desk, /—/, "no em dashes");
  } finally { delete globalThis.localStorage; }
});
