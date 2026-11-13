// Barta CRM client: the tab bar, the Menu sheet, the + button, the Sales
// switch and the sidebar (design §9.1; the Nov 2026 layout: Rotor's and
// Flyra's phone apps, the best of both).
//
// The phone (Nov 2026, "make it look more like Flyra"): Flyra's floating
// glass pill inset from the screen's edges, just above the home indicator,
// with labels under the icons and the current place on a lighter round
// highlight (its icon coral). The office's default bar is Flyra's: Home ·
// Schedule · Inbox · Map · Menu (Customers, Leads, Pipeline and the rest are
// in the Menu); each person may pick up to five places of their own (Menu →
// Tab bar, saved on their user record: users.tabs; me.mjs navFor), the Menu
// always last; six places go icon-only (Rotor's). A tech's bar is Today ·
// Inbox · Time · Pay · Me, as before. A tab shows only once a module has
// registered its screen (Map arrives with its module, for whoever may open
// it). The Menu is not a page: its button opens a sheet of every other
// screen (openMenuSheet below). Beside the pill, a round glass + dims the
// screen and stacks the things to make above it, with a search on top
// (openQuick below). Top-level screens get a large title on the left and
// round buttons on the right (search, and a coral + for that screen's own
// "new"); deeper screens get a round back button.
// The Sales tab is Pipeline (when its screen exists), Leads & calls, Quotes
// and Tasks, one tap apart in a switch under the header. The bar hides
// while an input has focus (the keyboard is up). A one-time "What moved"
// note (whatMoved below) tells each person, once per device, about the bar.
//
// On a computer or a tablet (900 px and up) the same pieces become a
// desktop CRM: a dark left sidebar (the white logo; the same places as the
// phone's bar, in the same order; a divider; every Menu section as a
// collapsible group, less what those places already hold; Settings, Team
// and who is signed in at the bottom; the current screen lit with a coral
// bar; the badges) and, in the header, a search box (GET /search: names,
// phones, streets, Q-/INV- numbers), a New button (the same creates) and
// the person's menu. CSS decides which set shows; one codebase.

import { html, render, sheet, icon, attrs, toast } from "./ui.js";
import { pickTheme } from "./theme.js";
import { initials, ago } from "./format.js";
import { api } from "./api.js";
import * as router from "./router.js";

export const TABS = Object.freeze({
  home: { label: "Home", paths: ["/today"], icon: "home" },
  today: { label: "Today", paths: ["/today"], icon: "today" },
  inbox: { label: "Inbox", paths: ["/inbox"], icon: "mail" },
  contacts: { label: "Customers", paths: ["/contacts", "/legacy/customers"], icon: "contacts" },
  schedule: { label: "Schedule", paths: ["/schedule"], icon: "cal12" },
  // one tab, several screens: the switch under the header goes between them (Pipeline once its screen exists)
  sales: { label: "Sales", group: [["/pipeline", "Pipeline"], ["/leads", "Leads"], ["/calls", "Calls"], ["/quotes", "Quotes"], ["/tasks", "Tasks"]], icon: "pipeline" },
  // places a person may put on their own bar instead (Menu → Tab bar)
  leads: { label: "Leads", paths: ["/leads"], icon: "target" },
  pipeline: { label: "Pipeline", paths: ["/pipeline"], icon: "pipeline" },
  visits: { label: "Visits", paths: ["/visits"], icon: "truck" },
  leaderboard: { label: "Leaders", paths: ["/leaderboard"], icon: "trophy" },
  map: { label: "Map", paths: ["/map"], icon: "map" },
  quotes: { label: "Quotes", paths: ["/quotes"], icon: "doc" },
  plans: { label: "Plans", paths: ["/plans"], icon: "schedule" },
  invoices: { label: "Invoices", paths: ["/invoices"], icon: "money" },
  // always last on the office's bar: opens the Menu sheet (openMenuSheet); /menu is its page
  menu: { label: "Menu", paths: ["/menu"], icon: "menu", sheet: true },
  time: { label: "Time", paths: ["/time"], icon: "time" },
  pay: { label: "Pay", paths: ["/pay"], icon: "pay" },
  me: { label: "Me", paths: ["/me"], icon: "me" },
  // an app shell cached before Home (its bar had Dashboard and More): see normalize()
  dashboard: { label: "Dashboard", paths: ["/dashboard"], icon: "chart" },
  more: { label: "More", more: true, icon: "more" },
});
// What each place's own "new" is (the coral + in a top-level screen's header; else the + sheet).
const PLACE_NEW = { contacts: ["/contacts/new", "/leads/new"], schedule: ["/jobs/new"], visits: ["/jobs/new"], inbox: ["/inbox/new"], sales: ["/leads/new"], leads: ["/leads/new"], pipeline: ["/leads/new"], quotes: ["/quotes/new"], plans: ["/plans/new"], invoices: ["/invoices/new"] };

// The Menu's sections, in order (a nav entry's `section`; unknown → "more").
export const SECTIONS = Object.freeze([
  ["work", "Work"], ["sales", "Sales"], ["customers", "Customers"], ["money", "Money"], ["messages", "Messages & automations"],
  ["office", "Office tools"], ["admin", "Admin"], ["more", "More"],
]);
const SECTION_KEYS = new Set(SECTIONS.map(([k]) => k));

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
// Schedule · Dashboard · More) is today's bar; a tech's is unchanged.
export function normalize(nav) {
  const list = Array.isArray(nav) ? nav : [];
  return list.includes("more") || list.includes("dashboard") ? [...STANDARD] : list;
}

// What this person gets (no DOM; the tests call it with the router's
// routes registered): the bar's tabs, the Menu (the top bar's button, or
// null for a tech), the Menu's entries and the creates, and the sidebar's
// layout. → { bar, menu, side: { top, groups, bottom } }
export function plan({ nav, manifests, can, user = null }) {
  st.manifests = manifests;
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
  st.menuPaths = menuDest() ? new Set(menuGroups().flatMap((g) => g.items.map((n) => n.path.split("?")[0]))) : new Set();
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
    if (e.target.closest("[data-more]")) openMore();
    if (e.target.closest("[data-menu]")) openMenuSheet({ user: st.user, can: st.can, groups: menuGroups(), onSignOut: st.onSignOut });
  });
  mountRound();

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

// The bar: every place, the Menu last (a button: it opens the sheet).
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
  if (!big) { render(r, html``); return; }
  const own = active && (PLACE_NEW[active.key] || []).find((p) => st.creates.some((c) => c.path === p) || (p === "/contacts/new" && st.can("contacts:write") && routeOk(p)));
  // the screen's own round buttons (screenButtons: search, filter, ...), then a coral + where the place makes something of its own
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
    if (st.more.some((n) => n.path === p)) { viaMore = true; break; }
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
  const big = atRoot || (!active && st.more.some((n) => n.path === path));
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

// The Menu's sections: [{ key, label, items: [nav entries] }], empty ones left out.
export function menuSections() {
  return SECTIONS.map(([key, label]) => ({ key, label, items: st.more.filter((n) => (SECTION_KEYS.has(n.section) ? n.section : "more") === key) })).filter((s) => s.items.length);
}
export const signOut = () => st.onSignOut();

// The Menu sheet's groups (Flyra's order): the main places; Quotes and
// Plans side by side; Leaderboard, Map, Reports, Automations; then every
// other Menu section; then Tab bar and Settings. Only what this person may
// open, each once. → [{ key, label?, two?: true, items: [{ path, label, icon }] }]
export function menuGroups() {
  const can = (p) => routeOk(p);
  const item = (path, label, ic) => (can(path) ? { path, label, icon: ic } : null);
  const fromNav = (path) => st.more.find((n) => n.path === path) || null;
  const seen = new Set();
  const take = (list) => list.filter(Boolean).filter((x) => (seen.has(x.path) ? false : seen.add(x.path)));
  const groups = [
    { key: "places", items: take([item("/today", st.user && st.user.role === "tech" ? "Today" : "Home", "home"), item("/schedule", "Schedule", "schedule"), item("/inbox", "Inbox", "inbox"), item("/contacts", "Customers", "contacts"), item("/leads", "Leads", "target"), item("/pipeline", "Pipeline", "pipeline")]) },
    { key: "docs", two: true, items: take([item("/quotes", "Quotes", "doc"), item("/plans", "Plans", "swap")]) },
    { key: "perf", items: take([item("/performance", "My performance", "trend"), item("/leaderboard", "Leaderboard", "trophy"), item("/visits", "Visits", "truck"), item("/map", "Map", "map"), fromNav("/dashboard") ? item("/dashboard", "Reports", "chart") : null, fromNav("/automations") ? item("/automations", "Automations", "bolt") : null]) },
  ];
  const last = take([item("/tab-bar", "Tab bar", "tabbar"), fromNav("/settings") ? item("/settings", "Settings", "gear") : null]);
  for (const sec of menuSections()) {
    const items = take(sec.items.filter((n) => !["/settings", "/me", "/tab-bar"].includes(n.path)).map((n) => ({ path: n.path, label: n.label, icon: n.icon })));
    if (items.length) groups.push({ key: sec.key, label: sec.label, items });
  }
  groups.push({ key: "you", items: last });
  return groups.filter((g) => g.items.length);
}

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
export const MOVED_KEY = "crm-moved-3";
export const MOVED_TEXT = Object.freeze({
  phone: "New look: Customers, Leads and Pipeline are in the Menu.",
  desk: "Home, Schedule, Inbox and Map now lead the sidebar. Everything else is where it was.",
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
// (Said once as a toast, never a banner over the screen: then it is seen.)
function whatMoved() {
  if (!wantsMoved()) return;
  const desk = !!document.getElementById("side") && typeof matchMedia === "function" && matchMedia("(min-width: 900px)").matches;
  seenMoved();
  setTimeout(() => toast(desk ? MOVED_TEXT.desk : MOVED_TEXT.phone, { ms: 5000 }), 1200);
}

// ------------------------------------------------------------ the desktop chrome

const CLOSED_KEY = "crm-side-shut";
const shutGroups = () => { try { return new Set(JSON.parse(localStorage.getItem(CLOSED_KEY) || "[]")); } catch (e) { return new Set(); } };
function toggleGroup(g, shut) {
  g.classList.toggle("shut", shut);
  const b = g.querySelector(".side-h");
  if (b) b.setAttribute("aria-expanded", String(!shut));
  try {
    const set = shutGroups();
    if (shut) set.add(g.dataset.grp); else set.delete(g.dataset.grp);
    localStorage.setItem(CLOSED_KEY, JSON.stringify([...set]));
  } catch (e) { /* a private window: open every time */ }
}

const sideItem = (path, label, ic, key, paths) => html`<a class="side-item" href="${"#" + path}" ${attrs({ "data-path": path.split("?")[0] === path ? path : null, "data-paths": paths && paths.length > 1 ? paths.join(" ") : null, "data-tab": key || null })}>${icon(ic || "list")}<span class="sl">${label}</span>${key ? html`<span class="badge" hidden></span>` : ""}</a>`;

// What the sidebar holds (pure, for the tests): the bar's places first, in
// the bar's order; then, for the office, the Menu's sections as groups less
// what those places already open; Settings and Team at the bottom (above
// who is signed in; My account is that card).
export const SIDE_BOTTOM = Object.freeze(["/settings", "/team"]);
// (A desk keeps Customers and Sales near the top too, after the bar's places,
// now that the phone's bar is Flyra's and has them in its Menu.)
export const DESK_PLACES = Object.freeze(["contacts", "sales"]);
export function sideLayout() {
  let top = barTabs().filter((t) => !t.more && !t.sheet);
  if (!menuDest()) return { top, groups: [], bottom: [] };
  const have = new Set(top.flatMap((t) => [t.key, ...(t.roots || [])]));
  top = top.concat(DESK_PLACES.map((k) => placeTab(k)).filter((t) => t && !have.has(t.key) && !(t.roots || []).some((r) => have.has(r))));
  const taken = new Set(top.flatMap((t) => t.roots || []));
  const groups = menuSections()
    .map((sec) => ({ ...sec, items: sec.items.filter((n) => !taken.has(n.path) && !SIDE_BOTTOM.includes(n.path) && n.path !== "/me") }))
    .filter((sec) => sec.items.length);
  const bottom = SIDE_BOTTOM.map((p) => st.more.find((n) => n.path === p)).filter(Boolean);
  return { top, groups, bottom };
}

function mountDesk() {
  const app = document.getElementById("app");
  if (!app || document.getElementById("side")) return;
  const shut = shutGroups();
  const side = document.createElement("nav");
  side.id = "side";
  side.className = "app-side";
  side.setAttribute("aria-label", "CRM sections");
  const { top, groups, bottom } = sideLayout();
  const u = st.user || {};
  render(side, html`<a class="side-logo" href="#/today"><img src="/assets/img/logo-bww-white.png" alt="Barta Window Washing" width="128" height="35"></a>
    <div class="side-scroll">
      <div class="side-main">${top.map((t) => sideItem(t.path, t.label, t.icon, t.key, t.roots))}</div>
      ${groups.length ? html`<div class="side-div" role="separator"></div>` : ""}
      ${groups.map((sec) => html`<section class="${"side-grp sec-" + sec.key + (shut.has(sec.key) ? " shut" : "")}" data-grp="${sec.key}">
        <button type="button" class="side-h" ${attrs({ "aria-expanded": String(!shut.has(sec.key)) })}><span>${sec.label}</span><span class="side-chev" aria-hidden="true"></span></button>
        <div class="side-items">${sec.items.map((n) => sideItem(n.path, n.label, n.icon))}</div>
      </section>`)}
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
  render(tools, html`${st.creates.length ? html`<div class="top-new"><button type="button" class="btn primary" id="top-new" aria-haspopup="true" aria-expanded="false">${icon("plus")}New</button><div class="pop" id="new-pop" hidden><ul class="menu">${st.creates.map((c) => html`<li><a href="${"#" + c.path}">${icon(c.icon || "plus")}<span>${c.label}</span></a></li>`)}</ul></div></div>` : ""}
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

// ------------------------------------------------------------ the + overlay and the Menu sheet
//
// the best of Rotor's and Flyra's phone apps; core/nav.js opens them).
//
//   openQuick({ creates, search, can })   the round coral + (Rotor): the screen
//       blurs, a search field sits at the top ("Search customers, jobs,
//       tasks...": GET /search, people and Q-/INV- numbers), and the things to
//       make stack above the + as white pills with round icons (Flyra):
//       Customer, Lead, Quote, Job, Plan, Invoice, Task (each only for someone
//       who may). The + turns into an ×. A tap outside, the ×, Escape or
//       going anywhere closes it.
//   openMenuSheet({ user, can, groups })  the Menu (Flyra): a sheet from the
//       bottom with a large "Menu" title, round buttons (report a problem,
//       the person's initials → My account), the latest reply nobody has
//       read yet, then every other screen in rounded groups (nav.js
//       menuGroups: the main places; Quotes | Plans; Leaderboard, Map,
//       Reports, Automations; the Menu's sections; Tab bar and Settings).
// (They live here, not in a file of their own, so a phone that starts with
// no signal has them in the app it already keeps.)

// The + sheet's things to make, in Flyra's order (its Estimate is our Quote,
// its Subscription our Plan; no Expense), from the manifests' creates
// (which nav.js already kept to this person's permissions and routes).
const MAKE = [
  ["/contacts/new", "Customer", "userplus", "contacts:write"], ["/leads/new", "Lead", "target"], ["/invoices/new", "Invoice", "receipt"], ["/quotes/new", "Quote", "clipboard"],
  ["/plans/new", "Plan", "swap"], ["/jobs/new", "Job", "hammer"], ["/tasks/new", "Task", "check"],
];
export function quickCreates(creates = [], can = () => false) {
  const have = new Set(creates.map((c) => c.path));
  return MAKE.filter(([path, , , perm]) => (perm ? can(perm) && router.has(path) : have.has(path))).map(([path, label, ic]) => ({ path, label, icon: ic }));
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

// ------------------------------------------------------------ the Menu sheet

export function menuRows(groups) {
  return html`${groups.map((g) => (g.two
    ? html`<div class="ms-two">${g.items.map((n) => html`<a class="ms-tile" ${attrs({ href: "#" + n.path })} data-close>${icon(n.icon || "list")}<span>${n.label}</span></a>`)}</div>`
    : html`<section class="ms-grp" ${attrs({ "aria-label": g.label || null })}>${g.label ? html`<h3 class="ms-h">${g.label}</h3>` : ""}<ul class="ms-list">${g.items.map((n) => html`<li><a class="ms-row" ${attrs({ href: "#" + n.path })} data-close><span class="ms-ic">${icon(n.icon || "list")}</span><span class="ms-l">${n.label}</span><span class="chev" aria-hidden="true"></span></a></li>`)}</ul></section>`))}`;
}

export function openMenuSheet({ user = {}, can = () => false, groups = [] } = {}) {
  closeQuick();
  const s = sheet({
    title: "Menu",
    body: html`<div class="ms-reply" hidden></div>${menuRows(groups)}`,
    events: {
      "click [data-close]": () => s.close(),
      "click [data-bug]": () => { s.close(); reportProblem(); },
      "click [data-theme-btn]": () => { s.close(); pickTheme(); },
    },
  });
  s.el.classList.add("menu-sheet");
  const head = s.el.querySelector(".sheet-head");
  const btns = document.createElement("div");
  btns.className = "ms-btns";
  render(btns, html`${can("tasks:write") ? html`<button type="button" class="rnd" data-bug aria-label="Report a problem">${icon("bug")}</button>` : ""}<button type="button" class="rnd" data-theme-btn aria-label="Light or dark">${icon("sun")}</button><a class="rnd ms-me" href="#/me" data-close ${attrs({ "aria-label": `${user.name || "My account"}: my account` })}>${initials(user.name)}</a>`);
  head.insertBefore(btns, head.querySelector("[data-sheet-x]"));
  // the latest reply nobody has read yet, one tap from its thread
  if (can("inbox:read")) {
    api("/inbox?filter=unread", { cache: false }).then((r) => {
      const c = ((r && r.data) || []).find((x) => x.last_direction === "in" || x.unread);
      const box = s.el.querySelector(".ms-reply");
      if (!c || !box) return;
      render(box, html`<a class="ms-replycard" ${attrs({ href: "#/inbox/" + encodeURIComponent(c.id) })} data-close>
        <span class="ms-av">${initials(c.contact_name)}</span>
        <span class="who"><span class="nm">${c.contact_name || "Someone"} replied${c.last_at ? html` <small>${ago(c.last_at)}</small>` : ""}</span><span class="sub">${c.last_preview || ""}</span></span>
        <span class="ms-go">Reply</span></a>`);
      box.hidden = false;
    }).catch(() => {});
  }
  return s;
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
