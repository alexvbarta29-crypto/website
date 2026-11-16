// The phone shell and the sidebar (the Nov 2026 look, then the owner's
// "make it like Rotor"): the office's bar is Home · Schedule · Inbox · Map ·
// Menu (the Menu last: it slides up Flyra's Menu, not a page), each person
// may pick up to five places of their own (Customize Tabs, saved on their
// user record; a pinned Visits is the Schedule now), the Menu is Flyra's
// cards holding everything Rotor's menu has (MENU: Home to Leads, the four
// tiles, Sales, Money, Reports, Marketing, Tab bar and Settings) read from
// one table, SECTIONS (K0 of the Rotor guide: each section opens on the tab
// used last, its tabs a segmented row, its rare screens its "..."), every
// screen of the old Menu reachable, each in one place; the desk's sidebar is
// the sections in the Menu's order; the + and the desk's New
// are one list (the most used first), and "What moved" shows once per person.
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

test("the office's bar: Home · Schedule · Inbox · Map · Menu, the Menu last (it slides up the Menu); a tech's is unchanged", () => {
  const p = planFor("owner");
  assert.deepEqual(p.bar.map((t) => t.label), ["Home", "Schedule", "Inbox", "Map", "Menu"]);
  assert.equal(p.bar[p.bar.length - 1].sheet, true, "the Menu opens the Menu sheet");
  assert.equal(p.menu.key, "menu");
  assert.equal(nav.isTabRoot("/menu"), false, "the Menu page has a back arrow");
  assert.equal(nav.isTabRoot("/schedule"), true);
  assert.equal(nav.isTabRoot("/contacts"), true, "Customers, from the Menu, is top-level: no back button");
  assert.equal(nav.isTabRoot("/settings"), true, "Settings, the Menu's last row, too");
  assert.equal(nav.isTabRoot("/contacts/new"), false);
  assert.deepEqual(nav.TABS.sales.group.map(([, l]) => l), ["Pipeline", "Leads", "Calls", "Quotes", "Tasks"]);
  const t = nav.plan({ nav: navFor({ role: "tech" }), manifests: MANIFESTS, can: (x) => !!ROLE_DEFAULTS.tech[x], user: { id: "us_t", role: "tech" } });
  assert.deepEqual(t.bar.map((x) => x.label), ["Today", "Inbox", "Time", "Pay", "Me"]);
  assert.equal(t.menu, null, "no Menu for a tech");
  assert.deepEqual(nav.drawerGroups(), [], "no Menu for a tech");
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

test("the desk's sidebar: the sections in the Menu's order (no lists to fold), Settings at the bottom; a tech's: the bar's places", () => {
  const p = planFor("owner");
  assert.deepEqual(p.side.top, [], "no second copy of the bar");
  assert.deepEqual(p.side.groups.map((g) => g.map((it) => it.label)), nav.drawerGroups().map((g) => g.map((it) => it.label)), "the same sections as the Menu holds");
  assert.ok(p.side.groups.flat().every((it) => !it.sub), "no sub-lists");
  const paths = p.side.groups.flat().flatMap((it) => [...it.tabs.map((t) => t.base), ...it.more.map((m) => m.path)]);
  for (const there of ["/today", "/schedule", "/inbox", "/contacts", "/pipeline", "/leads", "/calls", "/quotes", "/tasks", "/jobs", "/plans", "/invoices", "/payments", "/campaigns", "/leaderboard", "/map", "/team-map"]) assert.ok(paths.includes(there), `${there} is reachable on a desk`);
  assert.deepEqual(p.side.bottom.map((n) => n.label), ["Settings"]);
  assert.deepEqual(planFor("admin").side.bottom.map((n) => n.label), ["Settings"]);
  const t = nav.plan({ nav: navFor({ role: "tech" }), manifests: MANIFESTS, can: (x) => !!ROLE_DEFAULTS.tech[x], user: { id: "us_t", role: "tech" } });
  assert.deepEqual(t.side.top.map((x) => x.label), ["Today", "Inbox", "Time", "Pay", "Me"]);
  assert.deepEqual(t.side.groups, []);
});

test("the sections: in the Menu's order and cards (the desk's rail), no sub-lists, each section on its first open tab; the gear; a last group", () => {
  planFor("owner");
  const g = nav.drawerGroups();
  assert.deepEqual(g.map((x) => x.map((it) => it.label)), [["Home", "Schedule", "Inbox", "Customers", "Leads"], ["Service", "Financials"], ["Pipelines", "Power Dialer", "Tasks"], ["Map", "Analytics", "Marketing"]]);
  const row = (k) => g.flat().find((it) => it.key === k);
  const tabs = (k) => row(k).tabs.map((t) => t.label);
  const more = (k) => row(k).more.map((m) => m.label);
  // the tabs that exist today (Requests, Payouts, Referrals, Forms, Queue and Call logs wait for their screens)
  assert.deepEqual(tabs("service"), ["Requests", "Quotes", "Jobs", "Plans"]);
  assert.deepEqual(tabs("financials"), ["Invoices", "Payments", "Payouts", "Payroll", "Expenses"]);
  assert.deepEqual(tabs("marketing"), ["Workflows", "Campaigns", "Reviews", "Templates"]);
  for (const k of ["home", "inbox", "schedule", "customers", "map", "analytics"]) assert.equal(row(k).tabs.length, 1, `${k}: one screen, no tabs yet`);
  assert.deepEqual(tabs("dialer"), ["Dialer", "Queue", "Call logs"], "the Power Dialer's three tabs");
  // (Track 2: Leads and Pipelines draw List | Board, Tasks Board | List)
  // Leads: its List | Board, then QR codes (the signs); Forms and Referrals wait for their screens
  assert.deepEqual(row("leads").tabs.map((t) => [t.label, t.path]), [["List", "/leads?view=list"], ["Board", "/leads?view=board"], ["QR codes", "/signs"]]);
  assert.deepEqual(tabs("pipelines"), ["List", "Board"]);
  assert.deepEqual(tabs("tasks"), ["Board", "List"]);
  assert.deepEqual([row("service").path, row("financials").path, row("marketing").path, row("analytics").path, row("dialer").path], ["/requests", "/invoices", "/automations", "/reports", "/calls"], "the first open tab");
  // the rare screens in a section's "..."
  assert.deepEqual(more("inbox"), ["Outbox (not sent)", "Approvals", "Team inboxes"]);
  assert.deepEqual(more("financials"), ["Autopay run", "Timesheets"]);
  assert.deepEqual(more("analytics"), ["Office dashboard", "Leaderboard"]);
  assert.deepEqual(more("marketing"), [], "Marketing keeps what goes out: workflows, campaigns, reviews, templates");
  assert.deepEqual(more("leads"), ["Text blast", "Giveaway"], "the Lead report waits for its screen; Giveaway until Forms lists it");
  assert.deepEqual(more("pipelines"), ["Manage pipelines"]);
  assert.deepEqual(more("map"), ["Team map", "Door report"]);
  assert.deepEqual(more("service"), ["Light Studio"]);
  assert.equal(row("inbox").count, "inbox", "Inbox carries the unread count");
  // every screen the old drawer had: a tab, a "...", a link in its own screen, or the person's sheet
  // (a section's view tabs share one screen: Leads List | Board is /leads once)
  const all = g.flat().flatMap((it) => [...new Set(it.tabs.map((t) => t.base)), ...it.more.map((m) => m.path)]);
  assert.equal(new Set(all).size, all.length, "each screen once");
  for (const old of ["/schedule", "/jobs", "/plans", "/team-map", "/timesheets", "/payroll", "/pipeline", "/leads", "/calls", "/quotes", "/tasks", "/map",
    "/tools/lights", "/leaderboard", "/contacts", "/invoices", "/payments", "/autopay", "/reports", "/inbox", "/campaigns", "/approvals", "/reviews", "/signs", "/tools/giveaway", "/outbox",
    "/dashboard", "/templates", "/automations", "/settings/cadences"]) assert.ok(all.includes(old), `${old} is in a section`);
  for (const [p, home] of Object.entries(nav.IN_SCREEN)) assert.ok(all.includes(home), `${p} lives in ${home}`);
  // (Purchases waits in Financials' "..." until Expenses is there; then the Expenses screen's own "..." links it)
  assert.equal(nav.sectionByKey("financials").more.find(([p]) => p === "/tools/purchases")[3], "/expenses");
  assert.ok(all.includes("/expenses"), "Expenses, Purchases' home now");
  assert.deepEqual(nav.ME_ROWS.map(([p]) => p), ["/time", "/pay", "/performance"], "My time, My pay, My performance: the person's sheet");
  // a section's tabs are top-level (no back button from another top-level screen); its "..." screens sit deeper
  for (const it of g.flat()) for (const t of it.tabs) assert.equal(nav.isTabRoot(t.base), true, `${t.base}: a tab is top-level`);
  for (const it of g.flat()) for (const m of it.more) assert.equal(nav.isTabRoot(m.path), false, `${m.path}: a "..." screen has a back button`);
  assert.deepEqual(nav.drawerGear(), { path: "/settings", label: "Settings" });
  // someone who can't open Settings: the setup screens they may open are in the drawer (a last group), the gear is Customize Tabs
  nav.plan({ nav: navFor({ role: "admin" }), manifests: MANIFESTS, can: (x) => x !== "settings:general" && canOf("admin")(x), user: { id: "us_b", role: "admin" } });
  const g2 = nav.drawerGroups().flat().flatMap((it) => it.tabs.map((t) => t.base));
  assert.ok(g2.includes("/templates") && g2.includes("/automations"), "not hidden from someone without Settings");
  assert.ok(g2.includes("/team") || !canOf("admin")("users:manage"), "Team in the last group");
  assert.ok(!g2.includes("/settings"));
  assert.equal(nav.drawerGear().tabs, true, "the gear opens Customize Tabs");
  // a pinned bar without Home: Home still leads the drawer
  planFor("owner", { tabs: ["pipeline", "contacts"] });
  assert.equal(nav.drawerGroups()[0][0].path, "/today");
});

test("the Menu (Flyra's): its cards from MENU and SECTIONS, everything Rotor's menu has, badges on rows, a row waits for its screen, nothing lost", async () => {
  const { ICONS } = await import("../../../crm-app/core/ui.js");
  planFor("owner");
  const m = nav.menuGroups();
  const rows = (g) => g.items.map((it) => it.label);
  assert.deepEqual(m.map((g) => [g.label, g.kind, rows(g)]), [
    [null, "rows", ["Home", "Schedule", "Inbox", "Customers", "Leads"]],
    [null, "tiles", ["Jobs", "Quotes", "Invoices", "Plans"]],
    ["Sales", "rows", ["Pipelines", "Power Dialer", "Requests", "Tasks"]],
    ["Money", "rows", ["Payments", "Payouts", "Payroll", "Expenses"]],
    [null, "rows", ["Leaderboard", "Map", "Reports", "Automations"]],
    ["Marketing", "rows", ["Campaigns", "Reviews", "Templates", "QR codes"]],
    [null, "rows", ["Tab bar", "Settings"]],
  ]);
  const at = (label) => m.flatMap((g) => g.items).find((it) => it.label === label);
  // a section's row opens it on the tab used last; a screen's row opens that screen
  assert.deepEqual(["Leads", "Pipelines", "Tasks", "Jobs", "Requests", "Payroll", "Leaderboard", "Reports", "Automations", "QR codes", "Settings"].map((l) => at(l).href),
    ["/leads?view=list", "/pipeline?view=list", "/tasks?view=board", "/jobs", "/requests", "/payroll", "/leaderboard", "/reports", "/automations", "/signs", "/settings"]);
  assert.deepEqual(["Jobs", "Payroll", "Leaderboard", "QR codes"].map((l) => at(l).sec), ["service", "financials", "analytics", "leads"], "each screen lights its own section");
  // badges: the Inbox's unread, the Invoices tile's overdue, Tasks' overdue; a Money row carries none of Financials'
  assert.deepEqual(["Inbox", "Invoices", "Tasks", "Payments", "Payouts"].map((l) => at(l).count), ["inbox", "overdue", "tasks_overdue", null, null]);
  assert.deepEqual(at("Tab bar").preview, ["home", "cal12", "mail", "map"], "the bar's icons, the Menu left out");
  for (const it of m.flatMap((g) => g.items)) assert.ok(ICONS[it.icon], `${it.label}: icon ${it.icon}`);
  assert.doesNotMatch(JSON.stringify(nav.MENU) + JSON.stringify(m), /\u2014|—/, "no em dashes");
  // nothing lost: every section this person has is a row or holds one; its other tabs and "..." screens are on that screen
  const secs = new Set(m.flatMap((g) => g.items).map((it) => it.sec).filter(Boolean));
  for (const it of nav.drawerGroups().flat()) assert.ok(secs.has(it.key), `${it.key} is in the Menu`);
  const reach = new Set(m.flatMap((g) => g.items).flatMap((it) => [it.href && it.href.split("?")[0], ...(it.paths || [])]));
  for (const p of ["/outbox", "/approvals", "/settings/inboxes", "/campaigns/new?kind=blast", "/tools/giveaway", "/settings/cadences", "/calls/queue", "/calls/logs", "/tools/lights", "/autopay", "/timesheets", "/team-map", "/knock/report", "/dashboard", "/signs", "/invoices", "/expenses", "/templates"]) assert.ok(reach.has(p), `${p} is reachable from the Menu`);
  // the html: rows are links with the section's screens (the e2e helper reads them), the Tab bar a button, a chevron on each
  const h = String(nav.menuBody(m));
  assert.match(h, /<a class="fm-row" href="#\/inbox" data-fm-go="\/inbox" data-fm-sec="inbox" data-fm-paths="\/inbox \/outbox \/approvals \/settings\/inboxes">/);
  assert.match(h, /<ul class="fm-card fm-tiles"\s*>[\s\S]*?<a class="fm-tile" href="#\/jobs"/);
  assert.match(h, /<h3 class="fm-cap">Money<\/h3>/);
  assert.match(h, /<button type="button" class="fm-row" data-fm-tabs aria-haspopup="dialog">/);
  assert.equal((h.match(/class="fm-chev"/g) || []).length, 4 + 5 + 4 + 4 + 4 + 2, "a chevron on every row (the tiles have none)");
  globalThis.document = { querySelectorAll: () => [] };   // (setBadges also paints the bar; no page here)
  try {
    nav.setBadges({ inbox: 3, overdue: 120 });
    const hb = String(nav.menuBody(m));
    assert.match(hb, /Inbox<\/span><span class="fm-n">3<\/span>/);
    assert.match(hb, /<span class="fm-tn">99\+<\/span><\/span><span class="fm-tl">Invoices/);
    nav.setBadges({});
  } finally { delete globalThis.document; }
  // a row waits for its screen and its permission: no payroll, no Payroll row; no Settings, no Settings row (the Tab bar stays)
  nav.plan({ nav: navFor({ role: "admin" }), manifests: MANIFESTS, can: (x) => x !== "payroll:read_all" && x !== "settings:general" && canOf("admin")(x), user: { id: "us_m1", role: "admin" } });
  const a = nav.menuGroups();
  assert.deepEqual(rows(a.find((g) => g.label === "Money")), ["Payments", "Payouts", "Expenses"]);
  assert.deepEqual(rows(a[a.length - 1]), ["Tab bar"]);
  // the Leaderboard row follows it into the Analytics Team tab once that tab is drawn
  const rep = router.match("/reports").route;
  rep.views = ["overview", "sales", "plans", "team", "all"];
  try {
    planFor("owner");
    const lb = nav.menuGroups().flatMap((g) => g.items).find((it) => it.label === "Leaderboard");
    assert.equal(lb.href, "/reports?tab=team");
  } finally { delete rep.views; }
  // a section no row names for this person (Financials through Timesheets only): its own row in a last card, before the Tab bar
  nav.plan({ nav: navFor({ role: "admin" }), manifests: MANIFESTS, can: (x) => !["payroll:read_all", "invoices:read_all", "expenses:read"].includes(x) && canOf("admin")(x), user: { id: "us_m2", role: "admin" } });
  const r = nav.menuGroups();
  assert.ok(!r.some((g) => g.label === "Money"), "a card left empty goes");
  assert.deepEqual(r[r.length - 2].items.map((it) => [it.label, it.href]), [["Financials", "/timesheets"]]);
  assert.deepEqual(rows(r[r.length - 1]), ["Tab bar", "Settings"]);
  // a technician: no Menu
  nav.plan({ nav: navFor({ role: "tech" }), manifests: MANIFESTS, can: (x) => !!ROLE_DEFAULTS.tech[x], user: { id: "us_t", role: "tech" } });
  assert.deepEqual(nav.menuGroups(), []);
});

test("SECTIONS: one table; every client screen has exactly one home; plain words; the icons exist", async () => {
  const { ICONS } = await import("../../../crm-app/core/ui.js");
  const S = await import("../../../crm-app/modules/system/settings.js");
  const { readFileSync } = await import("node:fs");
  assert.deepEqual(nav.SECTIONS.map((x) => x.key), ["home", "inbox", "schedule", "customers", "leads", "pipelines", "dialer", "service", "financials", "tasks", "map", "analytics", "marketing"]);
  // each screen in exactly one section (its path, a tab or its "...")
  const owner = new Map();
  for (const sec of nav.SECTIONS) {
    const mine = new Set([sec.path, ...(sec.tabs || []).map((t) => t[2]), ...(sec.more || []).map(([p]) => p)]);
    for (const p of mine) { assert.ok(!owner.has(p), `${p} is in ${owner.get(p)} and ${sec.key}`); owner.set(p, sec.key); }
    assert.ok(ICONS[sec.icon], `${sec.key}: icon ${sec.icon}`);
    for (const [, , ic] of sec.more || []) assert.ok(ICONS[ic], `${sec.key}: icon ${ic}`);
    for (const t of sec.tabs || []) assert.equal(t[2].split("?")[0], t[2], "a tab's view is its 4th field, never in the path");
  }
  for (const p of [...Object.keys(nav.IN_SCREEN), ...nav.ME_ROWS.map(([x]) => x)]) assert.ok(!owner.has(p), `${p} has one home`);
  const words = JSON.stringify([nav.SECTIONS, nav.ME_ROWS, nav.WHERE, nav.MOVED_TEXT]);
  assert.doesNotMatch(words, /\u2014|—/, "no em dashes");
  // every client route a person opens on its own (no :param, not a "new", not an old redirect) has a home: a
  // section, its own screen's link, the person's sheet, the Settings hub, the help sheet, Home; or it is reached from its parent screen
  const routes = MANIFESTS.flatMap((m) => (m.routes || []).map((r) => ({ ...r, module: m.name })));
  const settings = new Set(S.LAYOUT.flatMap(([, , , , rows]) => rows.map(([p]) => p)));
  const homes = new Set([...owner.keys(), ...Object.keys(nav.IN_SCREEN), ...nav.ME_ROWS.map(([p]) => p), ...settings, "/settings", "/me", "/notifications", "/calendar-feed", "/knock", "/menu", "/kit"]);
  const reached = (r) => homes.has(r.path) || (r.parent && !r.parent.includes(":") && (homes.has(r.parent) || routes.some((x) => x.path === r.parent && reached(x))));
  const lost = routes.filter((r) => !r.redirect && !r.path.includes(":") && !/\/new$/.test(r.path) && !reached(r)).map((r) => `${r.module}: ${r.path}`);
  assert.deepEqual(lost, [], "every screen can be found");
  // a screen whose home is a link in another screen: that screen's file really links it
  for (const [p, home] of Object.entries(nav.IN_SCREEN)) {
    const mod = routes.find((r) => r.path === home).module;
    const files = MANIFESTS.find((m) => m.name === mod).routes.filter((r) => r.path === home).map((r) => String(r.load));
    assert.ok(files.length, `${home} is a route`);
    const src = readFileSync(`crm-app/modules/${mod}/list.js`, "utf8");
    assert.match(src, new RegExp(`#${p.replace("/", "\\/")}\\b`), `${home} links ${p}`);
  }
});

test("SECTIONS and permissions: a tab shows when its screen is there and this person may open it; one tab: no row of tabs", () => {
  // the office (admin): no Light Studio, no Purchases, no Giveaway, no office dashboard (office tools are the owner's)
  nav.plan({ nav: navFor({ role: "admin" }), manifests: MANIFESTS, can: canOf("admin", false), user: { id: "us_ad", role: "admin" } });
  const row = (k) => nav.drawerGroups().flat().find((it) => it.key === k);
  assert.deepEqual(row("service").more, [], "no Light Studio without the office tools");
  assert.ok(!row("financials").more.some((m) => m.path === "/tools/purchases"));
  // someone who may open only Payments of Financials: the row opens Payments, no row of tabs
  nav.plan({ nav: navFor({ role: "admin" }), manifests: MANIFESTS, can: (x) => !["payroll:read_all", "expenses:read"].includes(x) && canOf("admin")(x), user: { id: "us_ad2", role: "admin" } });
  assert.deepEqual(row("financials").tabs.map((t) => t.label), ["Invoices", "Payments", "Payouts"]);
  const fin = nav.sectionByKey("financials");
  assert.match(String(nav.sectionTabs(fin, "payments")), /role="tablist" aria-label="Financials"[\s\S]*href="#\/invoices"[\s\S]*href="#\/payments" class="rs-seg-b" role="tab" aria-selected="true"/);
  nav.plan({ nav: navFor({ role: "admin" }), manifests: MANIFESTS, can: (x) => !["payroll:read_all", "invoices:read_all", "expenses:read"].includes(x) && canOf("admin")(x), user: { id: "us_ad3", role: "admin" } });
  assert.deepEqual([row("financials").path, row("financials").more], ["/timesheets", []], "no tab open: the row opens its first \"...\" screen (nothing is lost)");
  nav.plan({ nav: navFor({ role: "admin" }), manifests: MANIFESTS, can: (x) => !["payroll:read_all", "invoices:read_all", "time:edit_others", "expenses:read"].includes(x) && canOf("admin")(x), user: { id: "us_ad3", role: "admin" } });
  assert.equal(row("financials"), undefined, "nothing of Financials open: no row");
  assert.equal(String(nav.sectionTabs("financials")), "", "and no tabs");
  // a technician: no drawer, no sections
  nav.plan({ nav: navFor({ role: "tech" }), manifests: MANIFESTS, can: (x) => !!ROLE_DEFAULTS.tech[x], user: { id: "us_t", role: "tech" } });
  assert.deepEqual(nav.drawerGroups(), []);
  // a view tab waits for its screen to draw that view (Leads: List | Board once leads.js declares views)
  const leads = router.match("/leads").route;
  const had = leads.views;
  delete leads.views;
  planFor("owner");
  assert.deepEqual(row("leads").tabs.map((t) => t.label), ["Leads", "QR codes"]);
  assert.match(String(nav.sectionTabs("leads", "list")), /href="#\/leads" class="rs-seg-b" role="tab" aria-selected="true"[\s\S]*href="#\/signs"/, "the list stays the first tab");
  leads.views = ["list", "board"];
  try {
    planFor("owner");
    assert.deepEqual(row("leads").tabs.map((t) => [t.label, t.path]), [["List", "/leads?view=list"], ["Board", "/leads?view=board"], ["QR codes", "/signs"]]);
    assert.equal(nav.sectionAt("/leads", new URLSearchParams("view=board")).cur.key, "board");
    assert.equal(nav.sectionAt("/leads", new URLSearchParams("")).cur.key, "list", "no view asked: the first");
    assert.match(String(nav.sectionTabs("leads", "board")), /href="#\/leads\?view=board" class="rs-seg-b" role="tab" aria-selected="true"/);
  } finally { leads.views = had; }
  // Analytics' views are ?tab= (the section's param)
  const rep = router.match("/reports").route;
  rep.views = ["overview", "sales", "plans", "team", "all"];
  try {
    planFor("owner");
    assert.deepEqual(row("analytics").tabs.map((t) => t.path), ["/reports?tab=overview", "/reports?tab=sales", "/reports?tab=plans", "/reports?tab=team", "/reports?tab=all"]);
    assert.deepEqual(row("analytics").more.map((m) => m.label), ["Office dashboard"], "the Team tab holds the Leaderboard: it leaves the \"...\"");
    assert.match(String(nav.sectionTabs("analytics", "sales")), /class="rs-seg scroll"/, "five tabs: the row scrolls");
  } finally { delete rep.views; }
});

test("sections: the screen's section up its parent chain; the tab used last, per person, opens next", () => {
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  try {
    planFor("owner");
    assert.equal(nav.sectionOf("/jobs/jb_1").key, "service");
    assert.equal(nav.sectionOf("/quotes/q_1/edit").key, "service");
    assert.equal(nav.sectionOf("/settings/cadences").key, "pipelines");
    assert.equal(nav.sectionOf("/knock").key, "map", "the Map's other name");
    assert.equal(nav.sectionOf("/autopay/ap_1").key, "financials");
    assert.equal(nav.sectionOf("/settings/company").key, "home", "Settings hangs off Home");
    const at = nav.sectionAt("/plans", new URLSearchParams(""));
    assert.deepEqual([at.sec.key, at.cur.key, at.tabs.length], ["service", "plans", 4]);
    assert.equal(nav.sectionAt("/autopay"), null, "a \"...\" screen is no tab");
    const row = () => nav.drawerGroups().flat().find((it) => it.key === "service");
    assert.equal(row().path, "/requests", "first time: the first tab");
    nav.rememberTab(nav.sectionByKey("service"), "plans");
    assert.equal(store.get("crm-sec:us_0000000000000000000a:service"), "plans", "crm-sec:<uid>:<key>");
    assert.equal(row().path, "/plans", "then the tab used last");
    // another person on the same phone has their own
    nav.plan({ nav: navFor({ role: "owner" }), manifests: MANIFESTS, can: canOf("owner"), user: { id: "us_other", role: "owner" } });
    assert.equal(row().path, "/requests");
    // a remembered tab that is no longer open: the first again
    store.set("crm-sec:us_other:service", "gone");
    assert.equal(row().path, "/requests");
    // a browser that keeps nothing: the first, and nothing breaks
    globalThis.localStorage = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    nav.rememberTab(nav.sectionByKey("service"), "jobs");
    assert.equal(row().path, "/requests");
  } finally { delete globalThis.localStorage; }
});

test("a section's tab whose route comes later (Requests, Payouts...) shows once a module registers it, first in its place", () => {
  router.register([{ name: "fake", routes: [{ path: "/requests", load: async () => ({ default: {} }), title: "Requests", perm: "quotes:read" }, { path: "/payouts", load: async () => ({ default: {} }), title: "Payouts", perm: "invoices:read_all" }] }]);
  planFor("owner");
  const row = (k) => nav.drawerGroups().flat().find((it) => it.key === k);
  assert.deepEqual(row("service").tabs.map((t) => t.label), ["Requests", "Quotes", "Jobs", "Plans"]);
  assert.deepEqual(row("financials").tabs.map((t) => t.label), ["Invoices", "Payments", "Payouts", "Payroll", "Expenses"]);
  assert.equal(nav.isTabRoot("/requests"), true);
  assert.deepEqual(row("financials").more.map((m) => m.label), ["Autopay run", "Timesheets"], "Expenses (a real module now) has taken Purchases in");
  router.register([{ name: "fake2", routes: [{ path: "/expenses", load: async () => ({ default: {} }), title: "Expenses", perm: "invoices:read_all" }, { path: "/forms", load: async () => ({ default: {} }), title: "Forms", perm: "contacts:read_all" }] }]);
  planFor("owner");
  assert.deepEqual(row("financials").tabs.map((t) => t.label), ["Invoices", "Payments", "Payouts", "Payroll", "Expenses"]);
  assert.deepEqual(row("financials").more.map((m) => m.label), ["Autopay run", "Timesheets"], "Expenses takes Purchases in");
  assert.deepEqual(row("leads").tabs.map((t) => t.label), ["List", "Board", "Forms", "QR codes"]);
  assert.ok(!row("leads").more.some((m) => m.label === "Giveaway"), "Forms lists the Giveaway");
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
  const made = quick.quickCreates(creates, canOf("owner"));
  assert.deepEqual(made.map((c) => c.label), ["Lead", "Customer", "Quote", "Job", "Request", "Task", "Invoice", "Plan"], "the Rotor guide's order (F8); Lead and Customer two buttons (the owner, Nov 2026)");
  assert.deepEqual(made.slice(0, 2).map((c) => [c.path, c.icon]), [["/contacts/new", "target"], ["/contacts/new?as=customer", "user"]], "one form: a lead, or ?as=customer; each its own icon");
  assert.deepEqual(quick.quickCreates([...creates, { path: "/requests/new", label: "Request" }], canOf("owner")).map((c) => c.label).slice(4, 6), ["Request", "Task"], "Request once a module offers its create");
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
    assert.match(nav.MOVED_TEXT.phone, /Menu holds everything/);
    assert.doesNotMatch(nav.MOVED_TEXT.phone + nav.MOVED_TEXT.desk, /—/, "no em dashes");
  } finally { delete globalThis.localStorage; }
});
