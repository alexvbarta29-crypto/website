// The phone shell and the sidebar (the Nov 2026 layout: the best of Rotor's
// and Flyra's phone apps): the office's bar is Home · Schedule · Inbox ·
// Customers · Sales · Menu (the Menu last, a sheet, not a page), each person
// may pick up to five places of their own (saved on their user record), the
// desk's sidebar leads with the same places in the same order then the
// folded groups and Settings and Team at the bottom, the Menu sheet's
// groups follow Flyra's order, the + offers what the person may make, and
// the "What moved" note shows once per person.
import { test } from "node:test";
import assert from "node:assert/strict";
import { crmTest } from "../../helpers/crm-http.mjs";

const { MANIFESTS } = await import("../../../crm-app/modules/index.js");
const router = await import("../../../crm-app/core/router.js");
router.register(MANIFESTS);
const nav = await import("../../../crm-app/core/nav.js");
const quick = await import("../../../crm-app/core/quick.js");
const { navFor, OFFICE_NAV } = await import("../../../netlify/lib/crm/modules/system/me.mjs");
const { ROLE_DEFAULTS } = await import("../../../netlify/lib/crm/core/perms.mjs");

const canOf = (role, office = true) => (p) => (p === "office:tools" ? office && role === "owner" : !!ROLE_DEFAULTS[role][p]);
const planFor = (role, user = {}) => nav.plan({ nav: navFor({ role, ...user }), manifests: MANIFESTS, can: canOf(role), user: { id: "us_0000000000000000000a", role, name: "Pat Example", ...user } });

test("the office's bar: Home · Schedule · Inbox · Customers · Sales · Menu, the Menu last and a sheet; a tech's is unchanged", () => {
  const p = planFor("owner");
  assert.deepEqual(p.bar.map((t) => t.label), ["Home", "Schedule", "Inbox", "Customers", "Sales", "Menu"]);
  assert.equal(p.bar[p.bar.length - 1].sheet, true, "the Menu opens the sheet");
  assert.equal(p.menu.key, "menu");
  assert.equal(nav.isTabRoot("/menu"), false, "the Menu page has a back arrow");
  assert.equal(nav.isTabRoot("/schedule"), true);
  assert.deepEqual(nav.TABS.sales.group.map(([, l]) => l), ["Pipeline", "Leads", "Calls", "Quotes", "Tasks"]);
  const t = nav.plan({ nav: navFor({ role: "tech" }), manifests: MANIFESTS, can: (x) => !!ROLE_DEFAULTS.tech[x], user: { id: "us_t", role: "tech" } });
  assert.deepEqual(t.bar.map((x) => x.label), ["Today", "Inbox", "Time", "Pay", "Me"]);
  assert.equal(t.menu, null, "no Menu for a tech");
  assert.deepEqual(OFFICE_NAV, ["home", "schedule", "inbox", "contacts", "sales", "menu"]);
});

test("each person's own tab bar: up to five of the main places, the Menu always last; unknown ones dropped", () => {
  assert.deepEqual(navFor({ role: "owner", tabs: ["home", "visits", "leaderboard", "leads", "map"] }), ["home", "visits", "leaderboard", "leads", "map", "menu"]);
  assert.deepEqual(navFor({ role: "admin", tabs: ["schedule", "nope", "schedule"] }), ["schedule", "menu"]);
  assert.deepEqual(navFor({ role: "owner", tabs: [] }), OFFICE_NAV, "none picked: the standard bar");
  assert.deepEqual(navFor({ role: "tech", tabs: ["home"] }), ["today", "inbox", "time", "pay", "me"], "a tech's bar is the tech app's");
  // a place whose screen isn't there yet (the Map before its module) simply doesn't show
  const p = planFor("owner", { tabs: ["home", "visits", "leaderboard", "map"] });
  assert.deepEqual(p.bar.map((t) => t.key), ["home", "visits", "leaderboard", ...(router.has("/map") ? ["map"] : []), "menu"]);
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
    assert.deepEqual(again.body.data.nav, ["home", "visits", "leads", "menu"]);
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

test("the desk's sidebar: the bar's places first in the bar's order, then the folded groups less those, Settings and Team at the bottom", () => {
  const p = planFor("owner");
  assert.deepEqual(p.side.top.map((t) => t.label), ["Home", "Schedule", "Inbox", "Customers", "Sales"]);
  const groups = p.side.groups.map((g) => g.key);
  assert.deepEqual(groups, ["work", "sales", "customers", "money", "messages", "office", "admin"].filter((k) => groups.includes(k)), "the Menu's order");
  const paths = p.side.groups.flatMap((g) => g.items.map((n) => n.path));
  for (const taken of ["/schedule", "/contacts", "/pipeline", "/leads", "/calls", "/quotes", "/tasks", "/settings", "/team", "/me"]) assert.ok(!paths.includes(taken), `${taken} isn't repeated in a group`);
  assert.ok(paths.includes("/schedule?view=tray"), "To book stays under Work");
  assert.ok(paths.includes("/visits") && paths.includes("/leaderboard"), "the new screens are reachable on a desk");
  assert.deepEqual(p.side.bottom.map((n) => n.label), ["Settings", "Team"]);
  assert.deepEqual(planFor("admin").side.bottom.map((n) => n.label), ["Settings"], "Team is the owners'");
});

test("the Menu sheet's groups (Flyra's order), each place once; the + offers what this person may make", () => {
  planFor("owner");
  const g = nav.menuGroups();
  assert.deepEqual(g[0].items.map((n) => n.label), ["Home", "Schedule", "Inbox", "Customers", "Leads", "Pipeline"]);
  assert.equal(g[1].two, true);
  assert.deepEqual(g[1].items.map((n) => n.label), ["Quotes", "Plans"]);
  assert.ok(["My performance", "Leaderboard", "Visits"].every((l) => g[2].items.some((n) => n.label === l)));
  assert.deepEqual(g[g.length - 1].items.map((n) => n.label), ["Tab bar", "Settings"]);
  const all = g.flatMap((x) => x.items.map((n) => n.path));
  assert.equal(new Set(all).size, all.length, "each once");
  const creates = MANIFESTS.flatMap((m) => m.creates || []);
  assert.deepEqual(quick.quickCreates(creates, canOf("owner")).map((c) => c.label), ["Customer", "Lead", "Quote", "Job", "Plan", "Invoice", "Task"]);
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
