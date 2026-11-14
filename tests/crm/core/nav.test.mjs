// The phone shell and the sidebar (the Nov 2026 look: Flyra's phone app
// first; the tidy-up: "concise but full of capabilities"): the office's bar
// is Flyra's, Home · Schedule · Inbox · Map · Menu (the Menu last, a sheet,
// not a page), each person may pick up to five places of their own (saved
// on their user record; a pinned Visits is the Schedule now), the Menu is
// five groups (Work, Sales, Customers, Money, Marketing & messages) and
// Settings, each screen once and never what the bar holds, the setup
// screens in Settings, the desk's sidebar is the same places then the same
// groups with Settings at the bottom, the + and the desk's New are one list
// (the most used first), and the "What moved" note shows once per person.
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

test("the office's bar: Home · Schedule · Inbox · Map · Menu (Flyra's), the Menu last and a sheet; a tech's is unchanged", () => {
  const p = planFor("owner");
  assert.deepEqual(p.bar.map((t) => t.label), ["Home", "Schedule", "Inbox", "Map", "Menu"]);
  assert.equal(p.bar[p.bar.length - 1].sheet, true, "the Menu opens the sheet");
  assert.equal(p.menu.key, "menu");
  assert.equal(nav.isTabRoot("/menu"), false, "the Menu page has a back arrow");
  assert.equal(nav.isTabRoot("/schedule"), true);
  assert.equal(nav.isTabRoot("/contacts"), true, "Customers, from the Menu, is top-level: no back button");
  assert.equal(nav.isTabRoot("/contacts/new"), false);
  assert.deepEqual(nav.TABS.sales.group.map(([, l]) => l), ["Pipeline", "Leads", "Calls", "Quotes", "Tasks"]);
  const t = nav.plan({ nav: navFor({ role: "tech" }), manifests: MANIFESTS, can: (x) => !!ROLE_DEFAULTS.tech[x], user: { id: "us_t", role: "tech" } });
  assert.deepEqual(t.bar.map((x) => x.label), ["Today", "Inbox", "Time", "Pay", "Me"]);
  assert.equal(t.menu, null, "no Menu for a tech");
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

test("the desk's sidebar: the bar's places first in the bar's order, then the Menu's five groups less those, Settings at the bottom", () => {
  const p = planFor("owner");
  assert.deepEqual(p.side.top.map((t) => t.label), ["Home", "Schedule", "Inbox", "Map"], "the bar's places");
  assert.deepEqual(p.side.groups.map((g) => g.label), ["Work", "Sales", "Customers", "Money", "Marketing & messages"]);
  const paths = p.side.groups.flatMap((g) => g.items.map((n) => n.path));
  assert.equal(new Set(paths).size, paths.length, "each screen once");
  for (const taken of ["/today", "/schedule", "/inbox", "/map", "/knock", "/settings", "/team", "/me", "/templates", "/automations", "/activity", "/import", "/tab-bar", "/visits", "/schedule?view=tray", "/tools/followups"]) assert.ok(!paths.includes(taken), `${taken} isn't in a group`);
  for (const there of ["/contacts", "/pipeline", "/leads", "/calls", "/quotes", "/tasks", "/jobs", "/plans", "/invoices", "/payments", "/campaigns", "/leaderboard"]) assert.ok(paths.includes(there), `${there} is reachable on a desk`);
  assert.deepEqual(p.side.bottom.map((n) => n.label), ["Settings"]);
  assert.deepEqual(planFor("admin").side.bottom.map((n) => n.label), ["Settings"]);
});

test("the Menu: five groups and Settings, each screen once under one name, none the bar holds; setup screens in Settings", () => {
  planFor("owner");
  const g = nav.menuGroups();
  assert.deepEqual(g.map((x) => x.label || x.key), ["Work", "Sales", "Customers", "Money", "Marketing & messages", "you"]);
  assert.deepEqual(g[g.length - 1].items.map((n) => n.label), ["Settings"]);
  const all = g.flatMap((x) => x.items.map((n) => n.path));
  assert.equal(new Set(all).size, all.length, "each once");
  const labels = g.flatMap((x) => x.items.map((n) => n.label));
  assert.equal(new Set(labels).size, labels.length, "no two with one name");
  for (const gone of ["/schedule", "/inbox", "/map", "/knock", "/templates", "/automations", "/team", "/activity", "/import", "/tab-bar", "/visits", "/tools/followups", "/dashboard/money"]) assert.ok(!all.includes(gone), `${gone} isn't in the Menu`);
  assert.deepEqual(g[1].items.slice(0, 5).map((n) => n.label), ["Pipeline", "Leads", "Calls", "Quotes", "Tasks"], "Sales: the Sales tab's screens first");
  assert.ok(g[3].items.some((n) => n.path === "/dashboard" && n.label === "Reports"), "the dashboards are Reports, under Money");
  for (const x of all) assert.equal(nav.isTabRoot(x.split("?")[0]), true, `${x}: a Menu screen is top-level`);
  // someone who can't open Settings still finds a setup screen they may open (here: templates) in the Menu
  nav.plan({ nav: navFor({ role: "admin" }), manifests: MANIFESTS, can: (x) => x !== "settings:general" && canOf("admin")(x), user: { id: "us_b", role: "admin" } });
  const g2 = nav.menuGroups().flatMap((x) => x.items.map((n) => n.path));
  assert.ok(g2.includes("/templates") && g2.includes("/automations"), "not hidden from someone without Settings");
  assert.ok(!g2.includes("/settings"));
  // a pinned bar without Home: Home leads the Menu
  planFor("owner", { tabs: ["pipeline", "contacts"] });
  assert.equal(nav.menuGroups()[0].items[0].path, "/today");
  assert.ok(nav.menuGroups().flatMap((x) => x.items.map((n) => n.path)).includes("/schedule"), "the Schedule, off the bar, is under Work");
});

test("the + and the desk's New: one list, the most used first, each once", () => {
  planFor("owner");
  const creates = MANIFESTS.flatMap((m) => m.creates || []);
  assert.deepEqual(quick.quickCreates(creates, canOf("owner")).map((c) => c.label), ["Lead or customer", "Quote", "Job", "Invoice", "Plan", "Task", "Log a call", "Text someone"]);
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
    assert.match(nav.MOVED_TEXT.phone, /Menu/);
    assert.doesNotMatch(nav.MOVED_TEXT.phone + nav.MOVED_TEXT.desk, /—/, "no em dashes");
  } finally { delete globalThis.localStorage; }
});
