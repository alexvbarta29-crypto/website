// Barta CRM client: the tab bar, the drawer, the top bar, the + button, the
// Sales switch and the sidebar (design §9.1; the Nov 2026 layout, then the
// owner's "make it like Rotor": Rotor's phone app, with everything the desk
// can do).
//
// The drawer (Rotor's desktop-style menu, Nov 2026): the Menu tab and the
// round hamburger of a top-level screen open it from the left. Our logo and
// an X on top; four groups split by thin lines: Home, Inbox, Schedule |
// Customers, Leads, Pipelines, Power Dialer | Service, Financials, Tasks,
// Map | Analytics, Marketing. A row with a dot opens its own list inside the
// drawer ("‹ Service" goes back): Service (jobs, visits, quotes, plans,
// lights...), Financials, Analytics, Marketing, and Customers or Map when
// the person has two screens there. DRAWER below is the one place that says
// where each screen sits and what it is called; a row shows only when its
// screen is there and this person may open it; a module's Menu entry it
// doesn't name lands in a last group, so every screen stays one or two taps
// away. The settings gear sits alone at the bottom (Tab bar for someone
// without Settings). #/menu draws the same drawer as a page; on a computer
// the sidebar is the same drawer, its lists folding open in place.
//
// The phone bar (Rotor's): a floating glass pill, icons only (the labels
// stay for screen readers), the current icon red with a dot under it, red
// badges; the red round + beside it (openQuick: search, then the things to
// make). The office's standard bar is Home · Schedule · Inbox · Map · Menu;
// each person may pick up to five places of their own (Customize Tabs:
// system/tab-bar.js, saved on their user record: users.tabs; me.mjs
// navFor), the Menu always last. A long press on the bar opens Customize
// Tabs. A tech's bar is Today · Inbox · Time · Pay · Me, as before. A tab
// shows only once a module has registered its screen.
//
// The top bar of a top-level screen (a tab's, or one the drawer lists): a
// round hamburger on the left; on the right the round search (the + overlay's
// search), the time, a round help (Report a problem, What moved, the
// calendar feed) and the person's initials (My account, Light or dark,
// Customize Tabs, Sign out). The screen's large title sits under it with its
// own round buttons (search, filter, and a coral + for that screen's "new");
// deeper screens get a round back button. The Sales tab (for someone who
// pins it) is Pipeline, Leads, Calls, Quotes and Tasks, one tap apart in a
// switch under the header. The bar hides while an input has focus. A
// one-time "What moved" note (whatMoved below) says it once per person.
//
// On a computer or a tablet (900 px and up) the same pieces become a
// desktop CRM: a dark left sidebar (the white logo, the drawer's groups,
// Settings and who is signed in at the bottom, the current screen lit with
// a coral bar, the badges) and, in the header, a search box (GET /search:
// names, phones, streets, Q-/INV- numbers), a New button (the same creates)
// and the person's menu. CSS decides which set shows; one codebase.

import { html, render, sheet, icon, attrs, toast, rnd, actionSheet } from "./ui.js";
import { initials, time as fmtTime } from "./format.js";
import { api } from "./api.js";
import * as router from "./router.js";

export const TABS = Object.freeze({
  home: { label: "Home", paths: ["/today"], icon: "home" },
  today: { label: "Today", paths: ["/today"], icon: "today" },
  inbox: { label: "Inbox", paths: ["/inbox"], icon: "mail" },
  contacts: { label: "Customers", paths: ["/contacts"], icon: "contacts" },
  schedule: { label: "Schedule", paths: ["/schedule"], icon: "cal12" },
  // one tab, several screens: the switch under the header goes between them (Pipeline once its screen exists)
  sales: { label: "Sales", group: [["/pipeline", "Pipeline"], ["/leads", "Leads"], ["/calls", "Calls"], ["/quotes", "Quotes"], ["/tasks", "Tasks"]], icon: "pipeline" },
  // places a person may put on their own bar instead (Menu → Tab bar)
  leads: { label: "Leads", paths: ["/leads"], icon: "target" },
  pipeline: { label: "Pipeline", paths: ["/pipeline"], icon: "pipeline" },
  leaderboard: { label: "Leaders", paths: ["/leaderboard"], icon: "trophy" },
  map: { label: "Map", paths: ["/map"], icon: "map" },
  quotes: { label: "Quotes", paths: ["/quotes"], icon: "doc" },
  plans: { label: "Plans", paths: ["/plans"], icon: "schedule" },
  invoices: { label: "Invoices", paths: ["/invoices"], icon: "money" },
  // always last on the office's bar: opens the drawer (openDrawer); /menu is its page
  menu: { label: "Menu", paths: ["/menu"], icon: "menu", sheet: true },
  time: { label: "Time", paths: ["/time"], icon: "time" },
  pay: { label: "Pay", paths: ["/pay"], icon: "pay" },
  me: { label: "Me", paths: ["/me"], icon: "me" },
  // an app shell cached before Home (its bar had Dashboard and More): see normalize()
  dashboard: { label: "Dashboard", paths: ["/dashboard"], icon: "chart" },
  more: { label: "More", more: true, icon: "more" },
});
// What each place's own "new" is (the coral + in a top-level screen's header; else the + sheet).
const PLACE_NEW = { contacts: ["/contacts/new", "/leads/new"], schedule: ["/jobs/new"], inbox: ["/inbox/new"], sales: ["/leads/new"], leads: ["/leads/new"], pipeline: ["/leads/new"], quotes: ["/quotes/new"], plans: ["/plans/new"], invoices: ["/invoices/new"] };

// The drawer: four groups, in order. A row is { key, label, icon, path } or,
// with a dot, { key, label, icon, sub: [[path, label, icon], ...] } (its own
// list; one that only one screen of is open to this person is that screen;
// `main` names the screen the row stands for then, keeping the row's name).
// A module's Menu entry for the same path decides who may see it (and its
// icon); else the route's permission. A path may carry a query (a view).
export const DRAWER = Object.freeze([
  [
    { key: "home", label: "Home", icon: "home", path: "/today" },
    { key: "inbox", label: "Inbox", icon: "inbox", path: "/inbox", count: "inbox" },
    { key: "schedule", label: "Schedule", icon: "cal12", path: "/schedule" },
  ],
  [
    { key: "customers", label: "Customers", icon: "contacts", main: "/contacts", sub: [["/contacts", "Customers", "contacts"], ["/merge", "Merge review", "copy"]] },
    { key: "leads", label: "Leads", icon: "target", path: "/leads" },
    { key: "pipelines", label: "Pipelines", icon: "pipeline", path: "/pipeline" },
    { key: "dialer", label: "Power Dialer", icon: "phone", path: "/calls" },
  ],
  [
    { key: "service", label: "Service", icon: "hammer", sub: [["/jobs", "Jobs", "list"], ["/schedule?view=list", "Visits", "cal"], ["/schedule?view=tray", "To book", "clock"], ["/quotes", "Quotes", "doc"], ["/plans", "Plans", "swap"], ["/plans/due", "Plan visits to book", "cal"], ["/lights", "Lights season", "bulb"], ["/tools/lights", "Light Studio", "bulb"], ["/team-map", "Team map", "team"], ["/time", "Time", "time"], ["/timesheets", "Timesheets", "clock"], ["/pay", "Pay", "pay"]] },
    { key: "financials", label: "Financials", icon: "money", sub: [["/invoices", "Invoices", "receipt"], ["/payments", "Payments", "money"], ["/autopay", "Autopay", "clock"], ["/payroll", "Payroll", "pay"], ["/tools/purchases", "Purchases", "cart"]] },
    { key: "tasks", label: "Tasks", icon: "check", path: "/tasks" },
    { key: "map", label: "Map", icon: "map", main: "/map", sub: [["/map", "Door to door", "map"], ["/team-map", "Team map", "team"]] },
  ],
  [
    { key: "analytics", label: "Analytics", icon: "chart", sub: [["/reports", "Reports", "chart"], ["/dashboard", "Dashboard", "grid"], ["/leaderboard", "Leaderboard", "trophy"], ["/performance", "My performance", "trend"]] },
    { key: "marketing", label: "Marketing", icon: "send", sub: [["/campaigns", "Campaigns", "send"], ["/approvals", "Approvals", "check"], ["/reviews", "Reviews", "check"], ["/signs", "Signs & flyers", "grid"], ["/tools/giveaway", "Giveaway", "gift"], ["/outbox", "Outbox", "send"], ["/templates", "Message templates", "doc"], ["/automations", "Automations", "bolt"], ["/settings/cadences", "Follow-up cadences", "phone"]] },
  ],
]);
// Set up once: in the Settings hub (system/settings.js) for whoever may open
// Settings (the drawer may list them too: Marketing's templates and
// automations); anyone else finds them in the drawer's last group.
export const IN_SETTINGS = Object.freeze(["/templates", "/automations", "/team", "/activity", "/import", "/tab-bar", "/tools/rotor", "/legacy/customers"]);
// Old Menu entries that are now part of another screen (their links redirect
// or still open), and what has its own button (Settings: the gear; My
// account: the person's initials; the Tab bar: Customize Tabs).
const GONE = new Set(["/visits", "/tools/followups", "/settings", "/me", "/tab-bar", "/menu"]);
// Two paths, one screen: the bar's Map is Door to door.
const SAME = Object.freeze({ "/knock": "/map" });

let st = { tabs: [], more: [], creates: [], can: () => false, onSignOut: () => {}, badges: {}, user: null };

const allowed = (perm) => !perm || st.can(perm);
// a nav path may carry a query (#/schedule?view=tray): its route decides
const routeOk = (path) => {
  const m = router.match(String(path).split("?")[0]);
  return !!m && allowed(m.route.perm);
};

// The office's standard bar (me.mjs OFFICE_NAV): Flyra's.
export const STANDARD = Object.freeze(["home", "schedule", "inbox", "map", "menu"]);
// The office's bar from a shell cached before Home (Today · Inbox · Contacts ·
// Schedule · Dashboard · More) is today's bar; a tech's is unchanged. A
// pinned Visits is the Schedule now (its List view).
export const MERGED_TABS = Object.freeze({ visits: "schedule" });
export function normalize(nav) {
  const list = Array.isArray(nav) ? nav : [];
  if (list.includes("more") || list.includes("dashboard")) return [...STANDARD];
  return [...new Set(list.map((k) => MERGED_TABS[k] || k))];
}

// What this person gets (no DOM; the tests call it with the router's
// routes registered): the bar's tabs, the Menu (the top bar's button, or
// null for a tech), the Menu's entries and the creates, and the sidebar's
// layout. → { bar, menu, side: { top, groups, bottom } }
export function plan({ nav, manifests, can, user = null }) {
  st.manifests = manifests;
  st.navAll = manifests.flatMap((m) => m.nav || []).filter((n) => n && n.where === "more");
  st.can = can;
  st.user = user || null;
  st.more = manifests.flatMap((m) => (m.nav || []).filter((n) => n.where === "more")).filter((n) => allowed(n.perm) && routeOk(n.path)).sort((a, b) => (a.order || 50) - (b.order || 50));
  st.creates = manifests.flatMap((m) => m.creates || []).filter((c) => allowed(c.perm) && routeOk(c.path)).sort((a, b) => (a.order || 50) - (b.order || 50));
  // places a module offers for the bar (nav: [{ where: "tab", key, path, label?, icon? }], e.g. the Map)
  const extra = {};
  for (const n of manifests.flatMap((m) => (m.nav || []).filter((x) => x && x.where === "tab" && x.key && x.path))) {
    if (!TABS[n.key] && !extra[n.key]) extra[n.key] = { label: n.label || n.key, paths: [n.path], icon: n.icon || "list" };
  }
  st.extraTabs = extra;
  st.tabs = normalize(nav).map((key) => placeTab(key, extra)).filter(Boolean);
  // the screens the Menu lists are top-level too (a large title, no back button when you came from another top-level screen)
  st.menuPaths = menuDest() ? drawerPaths() : new Set();
  return { bar: barTabs(), menu: menuDest(), side: sideLayout() };
}

// A place of the bar, with the screens it stands for (null when none is open to this person).
function placeTab(key, extra = st.extraTabs || {}) {
  const t = TABS[key] || extra[key];
  if (!t) return null;
  if (t.more) return { key, ...t, roots: [] };
  if (t.group) {
    const segs = t.group.filter(([p]) => routeOk(p));
    return segs.length ? { key, ...t, path: segs[0][0], roots: segs.map(([p]) => p), segs } : null;
  }
  const path = t.paths.find(routeOk);
  return path ? { key, ...t, path, roots: [path] } : null;
}

// mount({ nav: ["home", ...], manifests, can, onSignOut, user })
export function mount({ nav, manifests, can, onSignOut, user }) {
  st.onSignOut = onSignOut;
  plan({ nav, manifests, can, user });
  const box = document.getElementById("tabs");
  drawBar();
  box.addEventListener("click", (e) => {
    if (pressed) { pressed = false; e.preventDefault(); return; }
    if (e.target.closest("[data-more]")) openMore();
    if (e.target.closest("[data-menu]")) openDrawer();
  });
  longPress(box);
  // Rotor's floating bar: icons only, the current one red with a dot, the red round +
  document.getElementById("app").classList.add("rs-shell");
  mountRound();
  mountTopBar();

  // the switch between a tab's screens (Sales: Calls · Quotes · Tasks), under the header
  if (!document.getElementById("subnav")) {
    const sub = document.createElement("nav");
    sub.id = "subnav";
    sub.className = "seg-bar subnav";
    sub.hidden = true;
    const view = document.getElementById("view");
    view.parentNode.insertBefore(sub, view);
  }

  mountDesk();
  whatMoved();

  // Hide the bar while typing (iOS puts the keyboard over it otherwise).
  const app = document.getElementById("app");
  const typing = (el) => !!el && (el.tagName === "TEXTAREA" || el.tagName === "SELECT" || (el.tagName === "INPUT" && !["checkbox", "radio", "button", "submit"].includes(el.type)));
  document.addEventListener("focusin", (e) => { if (typing(e.target)) app.classList.add("typing"); });
  document.addEventListener("focusout", () => setTimeout(() => { if (!typing(document.activeElement)) app.classList.remove("typing"); }, 60));
}

// The bar: every place, the Menu last (a button: it opens the drawer).
const barTabs = () => st.tabs;
const menuDest = () => st.tabs.find((t) => t.sheet) || null;
const tabRoot = (path) => st.tabs.some((t) => !t.sheet && (t.roots || []).includes(path));
const topLevel = (path) => tabRoot(path) || (!!st.menuPaths && st.menuPaths.has(path));
// A tab's own screen never shows a back button; nor does one the Menu lists
// when it was opened from another top-level screen (Home → Menu → Customers),
// while from deeper in (a contact → its payments) the round back button stays.
export const isTabRoot = (path) => tabRoot(path) || (topLevel(path) && (() => { const p = router.previous ? router.previous() : null; return !p || topLevel(p.split("?")[0]); })());

function drawBar() {
  const box = document.getElementById("tabs");
  if (!box) return;
  box.classList.add("pill");
  box.classList.toggle("six", st.tabs.length > 5);
  render(box, html`${st.tabs.map((t) => (t.more
    ? html`<button type="button" class="tab" data-tab="${t.key}" data-more>${icon(t.icon)}<span class="tl">${t.label}</span></button>`
    : t.sheet
      ? html`<button type="button" class="tab" data-tab="${t.key}" data-menu aria-haspopup="dialog">${icon(t.icon)}<span class="tl">${t.label}</span><span class="badge" hidden></span></button>`
      : html`<a class="tab" data-tab="${t.key}" href="${"#" + t.path}">${icon(t.icon)}<span class="tl">${t.label}</span><span class="badge" hidden></span></a>`))}`);
  document.getElementById("app").classList.toggle("no-tabs", st.tabs.length < 2);
}

// A new tab bar (Menu → Tab bar saved): the bar and the sidebar again.
export function setTabs(nav) {
  plan({ nav, manifests: st.manifests, can: st.can, user: st.user });
  drawBar();
  const side = document.getElementById("side");
  if (side) { side.remove(); const f = document.getElementById("top-find"); const t = document.getElementById("top-tools"); if (f) f.remove(); if (t) t.remove(); }
  mountDesk();
  setBadges(st.badges);
  update(router.currentPath());
}

// The round buttons of a top-level screen's header (a phone): search, and a coral + for its own "new".
function mountRound() {
  const top = document.getElementById("top");
  if (!top || document.getElementById("top-rnd")) return;
  const r = document.createElement("div");
  r.id = "top-rnd";
  r.className = "top-rnd";
  top.appendChild(r);
  r.addEventListener("click", (e) => {
    if (e.target.closest("[data-rnd-search]")) openQuick({ creates: [], search: true, can: st.can });
    else if (e.target.closest("[data-rnd-new]") && !e.target.closest("a")) openQuick({ creates: quickCreates(st.creates, st.can), search: st.can("contacts:read_all"), can: st.can });
  });
}
function drawRound(active, big) {
  const r = document.getElementById("top-rnd");
  if (!r) return;
  const app = document.getElementById("app");
  if (app) app.classList.remove("own-new");
  if (!big) { render(r, html``); return; }
  const own = active && (PLACE_NEW[active.key] || []).find((p) => st.creates.some((c) => c.path === p) || (p === "/contacts/new" && st.can("contacts:write") && routeOk(p)));
  // the screen's own round buttons (screenButtons: search, filter, ...), then a coral + where the place makes something of its own
  // (the coral + is the screen's "new": on a phone the header's own New button steps aside, one way to make it)
  if (app && own) app.classList.add("own-new");
  render(r, html`<span class="rnd-own"></span>${own ? html`<a class="rnd coral" ${attrs({ href: "#" + own, "aria-label": "New" })}>${icon("plus")}</a>` : ""}`);
}

// A top-level screen's own round buttons in the header on a phone (Rotor's
// and Flyra's: search, filter, archive, a call log...), before the coral +.
// A screen calls it from mount(): [{ key, icon, label, on?, badge? }] and
// what a tap does. A desk has its own header (they don't show there).
export function screenButtons(list = [], onTap = () => {}) {
  const r = document.getElementById("top-rnd");
  if (!r) return;
  let box = r.querySelector(".rnd-own");
  if (!box) { box = document.createElement("span"); box.className = "rnd-own"; r.prepend(box); }
  render(box, html`${list.map((b) => html`<button type="button" class="${"rnd" + (b.on ? " on" : "")}" ${attrs({ "data-own": b.key, "aria-label": b.label, "aria-pressed": b.pressed === undefined ? null : String(!!b.pressed), "aria-expanded": b.expanded === undefined ? null : String(!!b.expanded) })}>${icon(b.icon)}${b.badge ? html`<span class="badge">${b.badge > 99 ? "99+" : b.badge}</span>` : ""}</button>`)}`);
  box.onclick = (e) => { const b = e.target.closest("[data-own]"); if (b) onTap(b.dataset.own, b, e); };
}

// A list's search behind the round search button (a phone, a top-level
// screen; Rotor's): the screen gives its search field the class
// "find-field" (and "open" while it holds text or was opened, findOpen
// below); the button opens and closes it in place. On a desk, or a screen
// deeper in, the field always shows (crm.css).
export const findOpen = (s, ctx) => !!((s && s.q) || (ctx && ctx.keep && ctx.keep.find));
export function findButton(view, ctx, label = "Search") {
  const field = () => view.querySelector(".find-field");
  if (!field()) return;
  screenButtons([{ key: "find", icon: "search", label, on: field().classList.contains("open"), expanded: field().classList.contains("open") }], (key, b) => {
    const f = field();
    if (!f) return;
    const input = f.querySelector("input");
    const open = !f.classList.contains("open") || !!(input && input.value);
    f.classList.toggle("open", open);
    if (ctx && ctx.keep) ctx.keep.find = open;
    b.classList.toggle("on", open);
    b.setAttribute("aria-expanded", String(open));
    if (open && input) input.focus();
  });
}

// Marks the tab of the current screen; shows the switch and the create button where they belong.
export function update(path) {
  // The nearest tab or More entry up the parent chain decides the highlight.
  let active = null;
  let viaMore = false;
  const menu = menuDest();
  for (const p of router.chain(path)) {
    // the Menu and the screens it lists light no tab (the More button on an older bar)
    if (menu && menu.roots.includes(p)) { viaMore = true; break; }
    active = barTabs().find((t) => !t.more && (t.roots || []).includes(p)) || null;
    if (active) break;
    if (inMenu(p)) { viaMore = true; break; }
  }
  document.querySelectorAll("#tabs [data-tab]").forEach((el) => {
    const t = st.tabs.find((x) => x.key === el.dataset.tab);
    // the Menu's button is lit on the screens the Menu lists
    const on = !!t && (t.more || t.sheet ? viaMore : active === t);
    if (on) el.setAttribute("aria-current", "page"); else el.removeAttribute("aria-current");
    // a tab of several screens opens the one you were last on
    if (t && t.segs && on && t.roots.includes(path)) el.setAttribute("href", "#" + path);
  });
  const atRoot = !!active && active.roots.includes(path);
  // the sidebar: the nearest entry up the chain is lit
  const items = [...document.querySelectorAll("#side [data-path]")];
  // (an item may stand for several screens: Sales is Calls, Quotes and Tasks)
  const holds = (a, p) => (a.dataset.paths || a.dataset.path).split(" ").includes(p);
  let lit = null;
  for (const p of router.chain(path)) { lit = items.find((a) => holds(a, p)) || null; if (lit) break; }
  for (const a of items) { if (a === lit) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); }
  if (lit) { const g = lit.closest(".side-grp"); if (g && g.classList.contains("shut")) toggleGroup(g, false); }
  const sub = document.getElementById("subnav");
  if (sub) {
    const segs = atRoot && active.segs && active.segs.length > 1 ? active.segs : null;
    sub.hidden = !segs;
    if (segs) {
      sub.setAttribute("aria-label", active.label);
      render(sub, html`<div class="seg-track">${segs.map(([p, label]) => html`<a class="${"seg" + (p === path ? " on" : "")}" href="${"#" + p}" ${attrs({ "aria-current": p === path ? "page" : false })}>${label}</a>`)}</div>`);
    } else render(sub, html``);
  }
  // a top-level screen (a tab's, or one the Menu lists): the large title, the round buttons and the +
  const big = atRoot || (!active && inMenu(path));
  const app = document.getElementById("app");
  if (app) app.classList.toggle("big-top", big);
  // the office's Home brings its own header (the avatar, Welcome back, the bell): the bar's title steps aside on a phone
  // (and so does the Schedule, Flyra's: its big title and pills are its own)
  if (app) app.classList.toggle("own-head", (path === "/today" && !st.tabs.some((t) => t.key === "today")) || (path === "/schedule" && !!menuDest()));
  drawRound(active || (big ? { key: placeOf(path) } : null), big);
  let fab = document.getElementById("fab");
  const creates = quickCreates(st.creates, st.can);
  // (Rotor: the + is always beside the bar)
  const want = st.tabs.length >= 2 && (creates.length > 0 || st.can("contacts:read_all"));
  if (app) app.classList.toggle("no-fab", !want);
  if (want && !fab) {
    fab = document.createElement("button");
    fab.type = "button";
    fab.id = "fab";
    fab.className = "fab";
    fab.setAttribute("aria-label", "New, or search");
    fab.setAttribute("aria-haspopup", "dialog");
    render(fab, icon("plus"));
    fab.addEventListener("click", () => openQuick({ creates: quickCreates(st.creates, st.can), search: st.can("contacts:read_all"), can: st.can }));
    document.getElementById("app").appendChild(fab);
  } else if (!want && fab) fab.remove();
}
// A screen the Menu lists (or a module's Menu entry): top-level, and it lights the Menu button.
const inMenu = (p) => (!!st.menuPaths && st.menuPaths.has(p)) || st.more.some((n) => n.path === p);
// The place (a TABS key) a path is the screen of.
const placeOf = (path) => (Object.entries(TABS).find(([, t]) => (t.paths || []).includes(path) || (t.group || []).some(([p]) => p === path)) || [null])[0];

export function setBadges({ inbox = 0, today = 0 } = {}) {
  st.badges = { inbox, today };
  // the office's Home is the tech's Today: one count, whichever tab this bar has
  for (const [key, n] of [["inbox", inbox], ["today", today], ["home", today]]) {
    for (const b of document.querySelectorAll(`#tabs [data-tab="${key}"] .badge, #side [data-tab="${key}"] .badge`)) {
      b.hidden = !n;
      b.textContent = n > 99 ? "99+" : String(n);
    }
  }
}

// May this person open a screen the drawer names? A module's Menu entry for
// the path decides (Jobs: whoever books); else the route's permission.
function visible(path) {
  const own = (st.navAll || []).find((n) => n.path === path);
  return own ? st.more.includes(own) : routeOk(path);
}
const hasSettings = () => routeOk("/settings") && st.more.some((n) => n.path === "/settings");

// The drawer's groups for this person (pure: the tests call it with the
// router's routes registered): [[{ key, label, icon, path?, paths, sub? }]],
// each row only when one of its screens is open to them, a row with one
// screen left a plain link; a last group holds a module's Menu entry no row
// names (and the setup screens for someone without Settings). The office
// only: a tech has no drawer.
export function drawerGroups() {
  if (!menuDest()) return [];
  const settings = hasSettings();
  const named = new Set();
  const mapBoth = visible("/map") && visible("/team-map");
  const groups = DRAWER.map((g) => g.map((it) => {
    if (!it.sub) {
      for (const p of [it.path]) named.add(p.split("?")[0]);
      return visible(it.path) ? { key: it.key, label: it.label, icon: it.icon, path: it.path, paths: [it.path.split("?")[0]], count: it.count || null } : null;
    }
    for (const [p] of it.sub) named.add(p.split("?")[0]);
    // the Team map sits under Map when the person has both, else under Service
    const sub = it.sub.filter(([p]) => visible(p) && !(it.key === "service" && p === "/team-map" && mapBoth))
      .map(([path, label, ic]) => ({ path, label, icon: ((st.navAll || []).find((n) => n.path === path) || {}).icon || ic }));
    if (!sub.length) return null;
    if (sub.length === 1) {
      const only = sub[0];
      return { key: it.key, label: it.main && only.path === it.main ? it.label : only.label, icon: it.main && only.path === it.main ? it.icon : only.icon, path: only.path, paths: [only.path.split("?")[0]] };
    }
    return { key: it.key, label: it.label, icon: it.icon, sub, paths: [...new Set(sub.map((x) => x.path.split("?")[0]))] };
  }).filter(Boolean)).filter((g) => g.length);
  for (const [p, same] of Object.entries(SAME)) if (named.has(same)) named.add(p);
  // what no row names: a module's own Menu entry (and, for someone without Settings, the setup screens)
  const rest = st.more.filter((n) => !named.has(n.path) && !GONE.has(n.path) && !(settings && IN_SETTINGS.includes(n.path)))
    .map((n) => ({ key: "x" + n.path, label: n.label, icon: n.icon || "list", path: n.path, paths: [n.path] }));
  if (rest.length) groups.push(rest);
  return groups;
}
// The gear at the bottom: Settings, or Customize Tabs for someone without Settings.
export function drawerGear() {
  if (!menuDest()) return null;
  if (hasSettings()) return { path: "/settings", label: "Settings" };
  return routeOk("/tab-bar") ? { tabs: true, label: "Customize Tabs" } : null;
}
// Every screen the drawer opens (they are top-level: a large title, no back button from another top-level screen).
const drawerPaths = () => { const g = drawerGear(); return new Set([...drawerGroups().flat().flatMap((it) => it.paths), ...(g && g.path ? [g.path] : [])]); };
export const signOut = () => st.onSignOut();

function openMore() {
  const s = sheet({
    title: "More",
    body: html`<ul class="menu">
      ${st.more.map((n) => html`<li><a href="${"#" + n.path}" data-close>${icon(n.icon || "list")}<span>${n.label}</span></a></li>`)}
      ${st.more.some((n) => n.path === "/me") || isTabRoot("/me") ? "" : html`<li><a href="#/me" data-close>${icon("me")}<span>My account</span></a></li>`}
      <li><button type="button" class="danger" data-signout>${icon("out")}<span>Sign out of this phone</span></button></li>
    </ul>`,
    events: {
      "click [data-close]": () => s.close(),
      "click [data-signout]": () => { s.close(); st.onSignOut(); },
    },
  });
}


// ------------------------------------------------------------ "What moved" (once per person, per device)

// The release that changed the bar says so once, in one line under the top
// bar, and then leaves people alone: "Got it" or a tap on the Menu and it
// never shows again for that person on that phone or
// computer (kept in localStorage under their id; a browser that keeps
// nothing never shows it, rather than showing it every time). A tech's bar
// didn't change: nothing to say.
export const MOVED_KEY = "crm-moved-5";
export const MOVED_TEXT = Object.freeze({
  phone: "The Menu is a drawer now, like Rotor's: Service, Financials, Analytics and Marketing open their own lists. Old links still work.",
  desk: "The sidebar is Rotor's now: Service, Financials, Analytics and Marketing fold open in place. Old links still work.",
});
const movedKey = (uid) => (uid ? `${MOVED_KEY}:${uid}` : null);
const me = () => (st.user && st.user.id) || null;
export function movedSeen(uid = me()) {
  const k = movedKey(uid);
  if (!k) return true;
  try { return !!localStorage.getItem(k); } catch (e) { return true; }
}
export function seenMoved(uid = me()) {
  const k = movedKey(uid);
  try { if (k) localStorage.setItem(k, "1"); } catch (e) { /* nothing kept here */ }
  const el = typeof document !== "undefined" ? document.getElementById("moved") : null;
  if (el) el.remove();
}
// Whether this person gets the note: the office (a Menu that moved), once.
export const wantsMoved = (uid = me()) => !!menuDest() && !movedSeen(uid);
// (Said once as a toast, never a banner over the screen: then it is seen.
// It never pushes another toast aside: with one showing it waits for the
// next start.)
function whatMoved() {
  if (!wantsMoved()) return;
  const desk = !!document.getElementById("side") && typeof matchMedia === "function" && matchMedia("(min-width: 900px)").matches;
  setTimeout(() => {
    const box = document.getElementById("toasts");
    if (!box || box.firstChild || !wantsMoved()) return;
    seenMoved();
    toast(desk ? MOVED_TEXT.desk : MOVED_TEXT.phone, { ms: 5000 });
  }, 500);
}

// ------------------------------------------------------------ the desktop chrome

// A list of the sidebar (Service, Financials...) folds open in place; the
// ones a person opened stay open on this computer.
const OPEN_KEY = "crm-side-open";
const openGroups = () => { try { return new Set(JSON.parse(localStorage.getItem(OPEN_KEY) || "[]")); } catch (e) { return new Set(); } };
function toggleGroup(g, shut) {
  g.classList.toggle("shut", shut);
  const b = g.querySelector(".side-h");
  if (b) b.setAttribute("aria-expanded", String(!shut));
  try {
    const set = openGroups();
    if (shut) set.delete(g.dataset.grp); else set.add(g.dataset.grp);
    localStorage.setItem(OPEN_KEY, JSON.stringify([...set]));
  } catch (e) { /* a private window: shut every time */ }
}

const sideItem = (path, label, ic, key, paths) => html`<a class="side-item" href="${"#" + path}" ${attrs({ "data-path": path.split("?")[0] === path ? path : null, "data-paths": paths && paths.length > 1 ? paths.join(" ") : null, "data-tab": key || null })}>${icon(ic || "list")}<span class="sl">${label}</span>${key ? html`<span class="badge" hidden></span>` : ""}</a>`;

// What the sidebar holds (pure, for the tests): for the office, the
// drawer's groups (a row with its own list folds open in place) and
// Settings at the bottom (above who is signed in; My account is that card);
// for a tech, the bar's places.
export const SIDE_BOTTOM = Object.freeze(["/settings"]);
export function sideLayout() {
  const top = barTabs().filter((t) => !t.more && !t.sheet);
  if (!menuDest()) return { top, groups: [], bottom: [] };
  const bottom = SIDE_BOTTOM.map((p) => st.more.find((n) => n.path === p)).filter(Boolean);
  return { top: [], groups: drawerGroups(), bottom };
}
// the badge a row carries (Home: what needs you; Inbox: unread)
const BADGE_KEY = { home: "home", inbox: "inbox" };

function mountDesk() {
  const app = document.getElementById("app");
  if (!app || document.getElementById("side")) return;
  const opened = openGroups();
  const side = document.createElement("nav");
  side.id = "side";
  side.className = "app-side";
  side.setAttribute("aria-label", "CRM sections");
  const { top, groups, bottom } = sideLayout();
  const u = st.user || {};
  const row = (it) => (it.sub
    ? html`<section class="${"side-grp sec-" + it.key + (opened.has(it.key) ? "" : " shut")}" data-grp="${it.key}">
        <button type="button" class="side-h" ${attrs({ "aria-expanded": String(opened.has(it.key)) })}>${icon(it.icon)}<span class="sl">${it.label}</span><span class="side-chev" aria-hidden="true"></span></button>
        <div class="side-items">${it.sub.map((n) => sideItem(n.path, n.label, n.icon))}</div>
      </section>`
    : sideItem(it.path, it.label, it.icon, BADGE_KEY[it.key] || null));
  render(side, html`<a class="side-logo" href="#/today"><img src="/assets/img/logo-bww-white.png" alt="Barta Window Washing" width="128" height="35"></a>
    <div class="side-scroll">
      ${top.length ? html`<div class="side-main">${top.map((t) => sideItem(t.path, t.label, t.icon, t.key, t.roots))}</div>` : ""}
      ${groups.map((g, i) => html`${i ? html`<div class="side-div" role="separator"></div>` : ""}<div class="side-main">${g.map(row)}</div>`)}
    </div>
    ${bottom.length ? html`<div class="side-foot">${bottom.map((n) => sideItem(n.path, n.label, n.icon))}</div>` : ""}
    <a class="side-me" href="#/me"><span class="avatar" ${attrs({ style: /^#[0-9a-f]{6}$/i.test(u.color || "") ? `background:${u.color}` : null })}>${initials(u.name)}</span><span class="who"><span class="nm">${u.name || "My account"}</span><span class="sub">${u.role === "owner" ? "Owner" : u.role === "admin" ? "Office" : "Technician"}</span></span></a>`);
  app.appendChild(side);
  app.classList.add("has-side");
  side.addEventListener("click", (e) => {
    const h = e.target.closest(".side-h");
    if (h) toggleGroup(h.closest(".side-grp"), !h.closest(".side-grp").classList.contains("shut"));
  });

  // the header's tools: search, New, the person's menu
  const topBar = document.getElementById("top");
  const tools = document.createElement("div");
  tools.id = "top-tools";
  tools.className = "top-tools";
  const canSearch = st.can("contacts:read_all");
  // search before the screen's own action button, New and the person after it
  const find = document.createElement("div");
  find.id = "top-find";
  find.className = "top-tools top-find";
  render(find, canSearch ? html`<form class="top-search" role="search" id="top-search" autocomplete="off">${icon("search")}<label class="sr" for="top-q">Search</label><input id="top-q" type="search" placeholder="Search customers or Q-1234" ${attrs({ autocomplete: "off", spellcheck: "false" })}><div class="pop search-pop" id="search-pop" hidden></div></form>` : html``);
  const makes = quickCreates(st.creates, st.can);
  render(tools, html`${makes.length ? html`<div class="top-new"><button type="button" class="btn primary" id="top-new" aria-haspopup="true" aria-expanded="false">${icon("plus")}New</button><div class="pop" id="new-pop" hidden><ul class="menu">${makes.map((c) => html`<li><a href="${"#" + c.path}">${icon(c.icon || "plus")}<span>${c.label}</span></a></li>`)}</ul></div></div>` : ""}
    <div class="top-me"><button type="button" class="top-av" id="top-me" aria-haspopup="true" aria-expanded="false" ${attrs({ "aria-label": `${u.name || "My account"}: account menu`, style: /^#[0-9a-f]{6}$/i.test(u.color || "") ? `background:${u.color}` : null })}>${initials(u.name)}</button><div class="pop" id="me-pop" hidden><p class="pop-who"><b>${u.name || ""}</b><span>${u.role === "owner" ? "Owner" : u.role === "admin" ? "Office" : "Technician"}</span></p><ul class="menu"><li><a href="#/me">${icon("me")}<span>My account</span></a></li><li><button type="button" class="danger" data-signout>${icon("out")}<span>Sign out</span></button></li></ul></div></div>`);
  topBar.insertBefore(find, document.getElementById("top-act"));
  topBar.appendChild(tools);
  const pops = () => [...topBar.querySelectorAll(".top-tools .pop")];
  const closePops = (except) => { for (const p of pops()) if (p !== except) { p.hidden = true; const b = p.parentNode.querySelector("[aria-expanded]"); if (b) b.setAttribute("aria-expanded", "false"); } };
  const toggle = (btn, pop) => { const open = pop.hidden; closePops(pop); pop.hidden = !open; btn.setAttribute("aria-expanded", String(open)); };
  find.addEventListener("click", (e) => { if (e.target.closest(".pop a")) { closePops(); const q = document.getElementById("top-q"); if (q) q.value = ""; } });
  tools.addEventListener("click", (e) => {
    const nb = e.target.closest("#top-new");
    if (nb) { toggle(nb, document.getElementById("new-pop")); return; }
    const mb = e.target.closest("#top-me");
    if (mb) { toggle(mb, document.getElementById("me-pop")); return; }
    if (e.target.closest("[data-signout]")) { closePops(); st.onSignOut(); return; }
    if (e.target.closest(".pop a")) { closePops(); const q = document.getElementById("top-q"); if (q && e.target.closest(".search-pop")) q.value = ""; }
  });
  document.addEventListener("click", (e) => { if (!e.target.closest || !e.target.closest(".top-tools")) closePops(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePops(); });
  window.addEventListener("hashchange", () => closePops());
  if (canSearch) searchBox();
}

// The header's search: as you type, the people and the document numbers it finds.
function searchBox() {
  const form = document.getElementById("top-search");
  const input = document.getElementById("top-q");
  const pop = document.getElementById("search-pop");
  let timer = null;
  let seq = 0;
  const NUM_PATH = { quote: "/quotes/", job: "/jobs/" };
  const show = (res, q) => {
    const nums = (res.numbers || []).filter((n) => NUM_PATH[n.type] && router.has(NUM_PATH[n.type] + n.id));
    const people = res.contacts || [];
    render(pop, nums.length || people.length ? html`<ul class="menu">
      ${nums.map((n) => html`<li><a href="${"#" + NUM_PATH[n.type] + encodeURIComponent(n.id)}">${icon(n.type === "quote" ? "doc" : "list")}<span>${n.label}</span></a></li>`)}
      ${people.map((c) => html`<li><a href="${"#/contacts/" + encodeURIComponent(c.id)}">${icon("contacts")}<span class="who"><span class="nm">${c.name}</span>${c.sub ? html`<span class="sub">${c.sub}</span>` : ""}</span></a></li>`)}
    </ul>` : html`<p class="pop-empty">Nobody matches "${q}".</p>`);
    pop.hidden = false;
  };
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { pop.hidden = true; return; }
    timer = setTimeout(async () => {
      const my = ++seq;
      try {
        const r = await api(`/search?q=${encodeURIComponent(q)}`, { cache: false });
        if (my === seq && input.value.trim() === q) show(r.data || {}, q);
      } catch (e) { if (my === seq) { pop.hidden = true; toast(e.message || "Search didn't answer.", { bad: true }); } }
    }, 220);
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const first = pop.querySelector("a[href]");
    if (first && !pop.hidden) { location.hash = first.getAttribute("href").slice(1); input.value = ""; pop.hidden = true; }
  });
  input.addEventListener("keydown", (e) => { if (e.key === "ArrowDown") { const a = pop.querySelector("a"); if (a) { e.preventDefault(); a.focus(); } } });
}

// ------------------------------------------------------------ the + overlay
//
//   openQuick({ creates, search, can })   the round red + (Rotor's): the
//       screen blurs, a search field sits at the top ("Search customers,
//       jobs, tasks...": GET /search, people and Q-/INV- numbers), and the
//       things to make stack above the + as pills with round icons: Lead or
//       customer, Quote, Job, Invoice, Plan, Task (each only for someone who
//       may). The + turns into an ×. A tap outside, the ×, Escape or going
//       anywhere closes it.
// (It lives here, not in a file of its own, so a phone that starts with no
// signal has it in the app it already keeps.)

// The things to make: one list for the phone's + and the desk's New, the
// most used first (a call comes in: a lead, a quote, a job), each once. The
// office's full form makes a lead or a customer; someone who may not use it
// (a tech at a door) gets the quick lead instead. From the manifests'
// creates (which nav.js already kept to this person's permissions and
// routes).
const MAKE = [
  ["/contacts/new", "Lead or customer", "userplus", "contacts:write"], ["/leads/new", "Lead", "target"], ["/quotes/new", "Quote", "clipboard"], ["/jobs/new", "Job", "hammer"],
  ["/invoices/new", "Invoice", "receipt"], ["/plans/new", "Plan", "swap"], ["/tasks/new", "Task", "check"],
];
// (Log a call and Text someone are their own screens' +: Calls, the Inbox.)
export function quickCreates(creates = [], can = () => false) {
  const have = new Set(creates.map((c) => c.path));
  const full = can("contacts:write") && router.has("/contacts/new");
  return MAKE.filter(([path, , , perm]) => (perm ? can(perm) && router.has(path) : have.has(path) && !(path === "/leads/new" && full))).map(([path, label, ic]) => ({ path, label, icon: ic }));
}

let openQ = null;
export function closeQuick() { if (openQ) openQ(); }

export function openQuick({ creates = [], search = false, can = () => false } = {}) {
  if (openQ) { openQ(); return; }
  const layer = document.getElementById("layer") || document.body;
  const el = document.createElement("div");
  el.className = "qk";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-label", search && !creates.length ? "Search" : "Make something new");
  render(el, html`<div class="qk-back" data-qk-x></div>
    ${search ? html`<form class="qk-search" role="search" autocomplete="off">${icon("search")}<label class="sr" for="qk-q">Search</label><input id="qk-q" type="search" placeholder="Search customers, jobs, tasks..." ${attrs({ autocomplete: "off", spellcheck: "false", enterkeyhint: "search" })}></form><div class="qk-res" hidden></div>` : ""}
    ${creates.length ? html`<ul class="qk-list">${creates.map((c) => html`<li><a class="qk-pill" ${attrs({ href: "#" + c.path })} data-qk-go><span class="qk-ic">${icon(c.icon)}</span><span>${c.label}</span></a></li>`)}</ul>` : ""}
    <button type="button" class="qk-x" data-qk-x aria-label="Close">${icon("close")}</button>`);
  layer.appendChild(el);
  document.body.classList.add("qk-on");
  const prev = document.activeElement;
  let closed = false;
  const onKey = (e) => { if (e.key === "Escape") close(); };
  const onHash = () => close();
  function close() {
    if (closed) return;
    closed = true;
    openQ = null;
    el.classList.remove("on");
    document.body.classList.remove("qk-on");
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("hashchange", onHash);
    setTimeout(() => el.remove(), 200);
    if (prev && prev.focus) { try { prev.focus({ preventScroll: true }); } catch (e) { /* gone */ } }
  }
  openQ = close;
  el.addEventListener("click", (e) => { if (e.target.closest("[data-qk-x]") || e.target.closest("[data-qk-go]") || e.target.closest(".qk-res a")) close(); });
  document.addEventListener("keydown", onKey);
  window.addEventListener("hashchange", onHash);
  if (search) searchInto(el.querySelector(".qk-search"), el.querySelector("#qk-q"), el.querySelector(".qk-res"));
  requestAnimationFrame(() => {
    el.classList.add("on");
    const q = el.querySelector("#qk-q");
    if (q && !creates.length) q.focus();
  });
  return close;
}

// Search as you type: the people and document numbers GET /search finds.
export function searchInto(form, input, out) {
  let timer = null;
  let seq = 0;
  const NUM = { quote: "/quotes/", job: "/jobs/", invoice: "/invoices/" };
  const show = (res, q) => {
    const nums = (res.numbers || []).filter((n) => NUM[n.type] && router.has(NUM[n.type] + n.id));
    const people = res.contacts || [];
    render(out, nums.length || people.length ? html`<ul class="menu">
      ${nums.map((n) => html`<li><a href="${"#" + NUM[n.type] + encodeURIComponent(n.id)}">${icon(n.type === "quote" ? "doc" : "list")}<span>${n.label}</span></a></li>`)}
      ${people.map((c) => html`<li><a href="${"#/contacts/" + encodeURIComponent(c.id)}">${icon("contacts")}<span class="who"><span class="nm">${c.name}</span>${c.sub ? html`<span class="sub">${c.sub}</span>` : ""}</span></a></li>`)}
    </ul>` : html`<p class="pop-empty">Nobody matches "${q}".</p>`);
    out.hidden = false;
  };
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { out.hidden = true; return; }
    timer = setTimeout(async () => {
      const my = ++seq;
      try {
        const r = await api(`/search?q=${encodeURIComponent(q)}`, { cache: false });
        if (my === seq && input.value.trim() === q) show(r.data || {}, q);
      } catch (e) { if (my === seq) { out.hidden = true; toast(e.message || "Search didn't answer.", { bad: true }); } }
    }, 220);
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const first = out.querySelector("a[href]");
    if (first && !out.hidden) location.hash = first.getAttribute("href").slice(1);
  });
}

// ------------------------------------------------------------ the drawer (Rotor's menu)
//
// openDrawer() slides it in from the left over a dimmed, blurred screen;
// the X, a tap outside, a swipe to the left, Escape or going anywhere
// closes it. A row with a dot shows its own list in its place ("‹ Service"
// goes back). drawerList() is the same rows for the #/menu page.

// The row of the screen on show (the nearest up its parent chain), and the list it sits in.
function currentRow(groups) {
  const chain = router.chain(router.currentPath());
  for (const p of chain) {
    for (const it of groups.flat()) {
      if (it.sub) { const x = it.sub.find((n) => n.path === p); if (x) return { row: it, sub: x }; }
      else if (it.path === p) return { row: it, sub: null };
    }
  }
  return { row: null, sub: null };
}

// The rows (html): the groups split by thin lines, or one row's own list.
// expand: every list open in place, under its row's name (the #/menu page has the room).
export function drawerList(groups, { open = null, expand = false } = {}) {
  const cur = currentRow(groups);
  const n = st.badges.inbox || 0;
  const link = (it, on) => html`<a class="dr-row" ${attrs({ href: "#" + it.path, "aria-current": on ? "page" : null, "data-dr-go": it.path })}><span class="dr-ic">${icon(it.icon || "list")}</span><span class="dr-l">${it.label}</span>${it.count === "inbox" && n ? html`<span class="dr-n">${n > 99 ? "99+" : String(n)}</span>` : ""}</a>`;
  const row = (it) => (it.sub
    ? html`<button type="button" class="dr-row" ${attrs({ "data-dr-sub": it.key, "aria-current": cur.row === it ? "true" : null })}><span class="dr-ic">${icon(it.icon)}</span><span class="dr-l">${it.label}</span><span class="dr-dot" aria-hidden="true"></span><span class="sr">, ${it.sub.length} screens</span></button>`
    : link(it, cur.row === it));
  if (expand) {
    return html`${groups.map((g) => html`<ul class="dr-grp">${g.map((it) => html`<li>${it.sub
      ? html`<div class="dr-sub" ${attrs({ "data-dr-list": it.key })}><h3 class="dr-h"><span class="dr-ic">${icon(it.icon)}</span><span class="dr-l">${it.label}</span></h3><ul class="dr-in">${it.sub.map((x) => html`<li>${link(x, cur.sub === x)}</li>`)}</ul></div>`
      : link(it, cur.row === it)}</li>`)}</ul>`)}`;
  }
  const list = open ? groups.flat().find((it) => it.key === open && it.sub) : null;
  if (list) {
    return html`<button type="button" class="dr-row dr-back" data-dr-back><span class="dr-ic">${icon("chevleft")}</span><span class="dr-l">${list.label}</span></button>
      <ul class="dr-grp" ${attrs({ "aria-label": list.label })}>${list.sub.map((x) => html`<li>${link(x, cur.sub === x)}</li>`)}</ul>`;
  }
  return html`${groups.map((g) => html`<ul class="dr-grp">${g.map((it) => html`<li>${row(it)}</li>`)}</ul>`)}`;
}
// The gear at the bottom (Settings, or Customize Tabs for someone without Settings).
export function drawerFoot() {
  const g = drawerGear();
  if (!g) return html``;
  return g.path ? rnd("gear", g.label, { href: "#" + g.path, data: { "dr-gear": true } }) : rnd("gear", g.label, { data: { "dr-tabs": true }, popup: true });
}
// Our logo, the dark or the white one with the theme.
export const drawerLogo = () => html`<a class="dr-logo" href="#/today" data-dr-go="/today"><img class="lg-l" src="/assets/img/logo-bww.png" alt="Barta Window Washing" width="128" height="35"><img class="lg-d" src="/assets/img/logo-bww-white.png" alt="Barta Window Washing" width="128" height="35"></a>`;

let drawerClose = null;
// → true when it was open (the edge swipe closes it before going back)
export function closeDrawer() { if (!drawerClose) return false; drawerClose(); return true; }

export function openDrawer() {
  if (drawerClose) return drawerClose;
  if (!menuDest()) return null;
  closeQuick();
  const layer = document.getElementById("layer") || document.body;
  const back = document.createElement("div");
  back.className = "dr-scrim";
  back.setAttribute("data-dr-x", "");
  const el = document.createElement("nav");
  el.className = "drawer";
  el.id = "drawer";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-label", "Menu");
  el.tabIndex = -1;
  render(el, html`<div class="dr-head">${drawerLogo()}${rnd("close", "Close the menu", { tone: "grey", sm: true, data: { "dr-x": true } })}</div><div class="dr-body"></div><div class="dr-foot">${drawerFoot()}</div>`);
  const body = el.querySelector(".dr-body");
  let open = null;
  const draw = () => render(body, drawerList(drawerGroups(), { open }));
  draw();
  layer.appendChild(back);
  layer.appendChild(el);
  document.body.classList.add("dr-on");
  const prev = document.activeElement;
  let closed = false;
  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
  const onHash = () => close();
  function close() {
    if (closed) return;
    closed = true;
    drawerClose = null;
    el.classList.remove("on");
    back.classList.remove("on");
    document.body.classList.remove("dr-on");
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("hashchange", onHash);
    setTimeout(() => { el.remove(); back.remove(); }, 240);
    if (prev && prev.focus && prev.isConnected) { try { prev.focus({ preventScroll: true }); } catch (e) { /* gone */ } }
  }
  drawerClose = close;
  back.addEventListener("click", close);
  el.addEventListener("click", (e) => {
    if (e.target.closest("[data-dr-x]")) { close(); return; }
    const sub = e.target.closest("[data-dr-sub]");
    if (sub) { open = sub.dataset.drSub; draw(); const b = body.querySelector("[data-dr-back]"); if (b) b.focus(); return; }
    if (e.target.closest("[data-dr-back]")) { const k = open; open = null; draw(); const b = body.querySelector(`[data-dr-sub="${k}"]`); if (b) b.focus(); return; }
    if (e.target.closest("[data-dr-tabs]")) { close(); openCustomizeTabs(); return; }
    // the screen already on show: just close
    const go = e.target.closest("a[href]");
    if (go && go.getAttribute("href") === location.hash) close();
  });
  // a swipe to the left closes it
  let x0 = null, dx = 0;
  el.addEventListener("touchstart", (e) => { x0 = e.touches[0].clientX; dx = 0; }, { passive: true });
  el.addEventListener("touchmove", (e) => {
    if (x0 === null) return;
    dx = Math.min(0, e.touches[0].clientX - x0);
    if (dx < -6) { el.style.transition = "none"; el.style.transform = `translateX(${dx}px)`; }
  }, { passive: true });
  el.addEventListener("touchend", () => {
    if (x0 === null) return;
    el.style.transition = "";
    el.style.transform = "";
    if (dx < -60) close();
    x0 = null; dx = 0;
  });
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("hashchange", onHash);
  requestAnimationFrame(() => {
    back.classList.add("on");
    el.classList.add("on");
    const x = el.querySelector("[data-dr-x]");
    try { (x || el).focus({ preventScroll: true }); } catch (e) { /* old Safari */ }
  });
  return close;
}

// Customize Tabs (system/tab-bar.js), loaded when asked for.
export function openCustomizeTabs() {
  return import("../modules/system/tab-bar.js").then((m) => m.openCustomize({ can: st.can })).catch(() => { toast("That didn't open. Try again.", { bad: true }); });
}

// A long press on the bar: Customize Tabs (the office's bar; a tech's is the tech app's).
let pressed = false;
function longPress(box) {
  let t = null, x0 = 0, y0 = 0;
  const stop = () => { clearTimeout(t); t = null; };
  box.addEventListener("pointerdown", (e) => {
    if (!menuDest() || !routeOk("/tab-bar")) return;
    x0 = e.clientX; y0 = e.clientY;
    stop();
    t = setTimeout(() => { t = null; pressed = true; setTimeout(() => { pressed = false; }, 900); openCustomizeTabs(); }, 550);
  });
  box.addEventListener("pointermove", (e) => { if (t && Math.hypot(e.clientX - x0, e.clientY - y0) > 10) stop(); });
  for (const ev of ["pointerup", "pointercancel", "pointerleave"]) box.addEventListener(ev, stop);
  box.addEventListener("contextmenu", (e) => { if (menuDest()) e.preventDefault(); });
}

// ------------------------------------------------------------ the top bar of a top-level screen (a phone)
//
// Rotor's: the round hamburger (the drawer) on the left; the round search,
// the time, the round help and the person's initials on the right. The
// screen's own large title sits under it (CSS: .big-top).

function mountTopBar() {
  const top = document.getElementById("top");
  if (!top || !menuDest() || document.getElementById("top-bar")) return;
  const u = st.user || {};
  const bar = document.createElement("div");
  bar.id = "top-bar";
  bar.className = "top-bar";
  render(bar, html`${rnd("menu", "Menu", { data: { "tb-menu": true }, popup: true })}<span class="tb-gap"></span>
    ${st.can("contacts:read_all") ? rnd("search", "Search", { data: { "tb-search": true }, popup: true }) : ""}
    <span class="tb-time num" id="tb-time" aria-hidden="true"></span>
    ${rnd("help", "Help", { data: { "tb-help": true }, popup: true })}
    <button type="button" class="rnd tb-av" data-tb-me aria-haspopup="dialog" ${attrs({ "aria-label": `${u.name || "My account"}: account`, style: /^#[0-9a-f]{6}$/i.test(u.color || "") ? `background:${u.color};color:#fff` : null })}>${initials(u.name)}</button>`);
  top.insertBefore(bar, top.firstChild);
  bar.addEventListener("click", (e) => {
    if (e.target.closest("[data-tb-menu]")) openDrawer();
    else if (e.target.closest("[data-tb-search]")) openQuick({ creates: [], search: true, can: st.can });
    else if (e.target.closest("[data-tb-help]")) helpSheet();
    else if (e.target.closest("[data-tb-me]")) meSheet();
  });
  const tick = () => { const el = document.getElementById("tb-time"); if (el) el.textContent = fmtTime(new Date()); };
  tick();
  setInterval(tick, 15000);
}

// The round help: Report a problem, What moved, the calendar feed.
export function helpSheet() {
  return actionSheet("Help", [[
    st.can("tasks:write") && { label: "Report a problem", icon: "bug", run: () => reportProblem(), data: { bug: true } },
    { label: "What moved", icon: "help", hint: "the new menu", run: () => movedSheet(), data: { moved: true } },
    routeOk("/calendar-feed") && { label: "Calendar feed help", icon: "today", href: "#/calendar-feed" },
  ]]);
}
// The person's initials: My account, Light or dark, Customize Tabs, Sign out.
export function meSheet() {
  const u = st.user || {};
  const theme = (THEMES.find(([k]) => k === themeChoice()) || [null, ""])[1];
  return actionSheet(u.name || "My account", [
    [routeOk("/me") && { label: "My account", icon: "me", href: "#/me" },
      { label: "Light or dark", icon: "sun", hint: theme, run: () => pickTheme(), data: { "theme-btn": true } },
      routeOk("/tab-bar") && { label: "Customize Tabs", icon: "tabbar", run: () => openCustomizeTabs(), data: { "tabs-btn": true } }],
    [{ label: "Sign out of this phone", icon: "out", danger: true, run: () => st.onSignOut(), data: { signout: true } }],
  ]);
}
function movedSheet() {
  return sheet({
    title: "What moved",
    body: html`<div class="moved-sheet"><p>${MOVED_TEXT.phone}</p>
      <ul class="moved-list"><li>The Menu tab and the round button top left open the menu, like Rotor's.</li><li>Jobs, visits, quotes and plans are under Service; invoices, payments and payroll under Financials; reports under Analytics; campaigns, reviews and templates under Marketing.</li><li>Settings is the gear at the bottom of the menu.</li><li>Your tabs: hold the bar, or your initials, then Customize Tabs.</li></ul></div>`,
  });
}

// "Report a problem": a task for the owners with what went wrong (and where).
function reportProblem() {
  const where = router.currentPath();
  const s = sheet({
    title: "Report a problem",
    body: html`<form class="form" data-bug-form novalidate><p class="muted small">Say what happened and what you expected. Alex and Jacob get it as a task.</p>
      <label class="field"><span>What went wrong</span><textarea name="t" rows="4" maxlength="600" required></textarea></label>
      <button type="submit" class="btn primary block">Send it</button></form>`,
    events: {
      "submit [data-bug-form]": async (e, f) => {
        e.preventDefault();
        const t = String(f.elements.t.value || "").trim();
        if (!t) { toast("Write it down first.", { bad: true }); return; }
        try {
          await api("/tasks", { method: "POST", body: { title: `App problem (${where}): ${t}`.slice(0, 150), kind: "todo" } });
          s.close();
          toast("Sent. Thank you.");
        } catch (err) { toast(err.message || "That didn't send.", { bad: true }); }
      },
    },
  });
}

// ------------------------------------------------------------ Light, Dark or Automatic
//
// Light, Dark or Automatic (the owner, Nov 2026: Flyra's
// dark look first, Rotor's light one a tap away). The choice belongs to the
// phone or computer it was made on (localStorage "crm-theme"; a browser
// that keeps nothing gets the default, Dark). crm.css holds every color as
// a token and html[data-theme] picks the set: "light", or dark otherwise.
// Automatic follows the phone's own setting and changes with it. The
// office shell around the frame (/office) hears crm:theme and matches its
// own background and status bar color.
//
//   applyTheme()       at start (main.js), before the first screen draws
//   themeChoice()      "light" | "dark" | "auto"
//   setTheme(v)        saves and applies
//   pickTheme()        the sheet: Light · Dark · Automatic (the Menu's sun
//                      button and My account)

export const THEME_KEY = "crm-theme";
export const THEMES = Object.freeze([["light", "Light"], ["dark", "Dark"], ["auto", "Automatic"]]);
export const DEFAULT_THEME = "dark";
// the canvas of each (the status bar and the frame behind the app match it)
export const CANVAS = Object.freeze({ light: "#f2f2f7", dark: "#111214" });

let mem = null;   // a browser that keeps nothing: the choice lasts until the page closes
const known = (v) => THEMES.some(([k]) => k === v);
export function themeChoice() {
  let v = null;
  try { v = localStorage.getItem(THEME_KEY); } catch (e) { /* nothing kept here */ }
  return known(v) ? v : known(mem) ? mem : DEFAULT_THEME;
}

const media = () => (typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null);
// What shows now: an explicit choice, or the phone's own setting for Automatic.
export function resolveTheme(v = themeChoice(), systemDark = !!(media() && media().matches)) {
  if (v === "light" || v === "dark") return v;
  return systemDark ? "dark" : "light";
}

let listening = false;
export function applyTheme() {
  if (typeof document === "undefined") return DEFAULT_THEME;
  const t = resolveTheme();
  document.documentElement.dataset.theme = t;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", CANVAS[t]);
  try { if (window.parent !== window) window.parent.postMessage({ type: "crm:theme", theme: t, canvas: CANVAS[t] }, location.origin); } catch (e) { /* no shell */ }
  const m = media();
  if (m && !listening) {
    listening = true;
    const onChange = () => { if (themeChoice() === "auto") applyTheme(); };
    if (m.addEventListener) m.addEventListener("change", onChange); else if (m.addListener) m.addListener(onChange);
  }
  return t;
}

export function setTheme(v) {
  if (!known(v)) return applyTheme();
  mem = v;
  try { localStorage.setItem(THEME_KEY, v); } catch (e) { /* this browser keeps nothing: for now only */ }
  return applyTheme();
}

// The sheet: Light · Dark · Automatic, the current one ticked.
export function pickTheme({ onPick } = {}) {
  const now = themeChoice();
  const s = sheet({
    title: "Appearance",
    body: html`<ul class="menu theme-pick" role="radiogroup" aria-label="Appearance">${THEMES.map(([k, l]) => html`<li><button type="button" role="radio" ${attrs({ "data-theme-pick": k, "aria-checked": k === now ? "true" : "false" })}>${icon(k === "light" ? "sun" : k === "dark" ? "moon" : "auto")}<span>${l}</span>${k === now ? html`<span class="theme-ck">${icon("check")}</span>` : ""}</button></li>`)}</ul>
      <p class="small muted">Automatic follows this phone's own setting. Saved on this device.</p>`,
    events: {
      "click [data-theme-pick]": (e, b) => {
        setTheme(b.dataset.themePick);
        s.close();
        toast(`${THEMES.find(([k]) => k === b.dataset.themePick)[1]} on this device`);
        if (onPick) onPick(themeChoice());
      },
    },
  });
  return s;
}
