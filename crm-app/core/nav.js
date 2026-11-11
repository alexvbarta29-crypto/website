// Barta CRM client: the bottom tab bar, the Sales switch, the Menu's
// sections and the create button (design §9.1).
//
// Tabs (core only): owners and the office get Home · Inbox · Schedule ·
// Customers · Sales · Menu; techs get Today · Inbox · Time · Pay · Me. A tab
// shows only once a module has registered its screen (Inbox arrives with
// comms, M6), so nothing is broken before its milestone. Home is /today
// (old #/today links and every screen's parent keep working), the Sales
// tab is Leads & calls with Quotes and Tasks one tap away in a switch under
// the header, and Menu is a full page of every other screen in labelled
// sections, built from the manifests' `nav: [{ where: "more", section,
// ... }]` entries (sections below; an entry without one lands in "More").
// The coral create button lists the manifests' `creates` on Customers,
// Schedule and Sales (and a tech's Today; Home has its quick actions). The bar hides while an input has focus (the keyboard
// is up) and sits above the home indicator.
//
// On a computer or a tablet (900 px and up) the same pieces become a
// desktop CRM: a left sidebar (the logo, Home, then every Menu section as
// a collapsible group, the current screen lit, the badges, who is signed
// in) and, in the header, a search box (GET /search: names, phones,
// streets, Q-/INV- numbers), a New button (the same creates) and the
// person's menu. CSS decides which set shows; one codebase.

import { html, render, sheet, icon, attrs, toast } from "./ui.js";
import { initials } from "./format.js";
import { api } from "./api.js";
import * as router from "./router.js";

export const TABS = Object.freeze({
  home: { label: "Home", paths: ["/today"], icon: "home" },
  today: { label: "Today", paths: ["/today"], icon: "today" },
  inbox: { label: "Inbox", paths: ["/inbox"], icon: "inbox" },
  contacts: { label: "Customers", paths: ["/contacts", "/legacy/customers"], icon: "contacts" },
  schedule: { label: "Schedule", paths: ["/schedule"], icon: "schedule" },
  // one tab, three screens: the switch under the header goes between them
  sales: { label: "Sales", group: [["/calls", "Calls"], ["/quotes", "Quotes"], ["/tasks", "Tasks"]], icon: "sales" },
  menu: { label: "Menu", paths: ["/menu"], icon: "grid" },
  time: { label: "Time", paths: ["/time"], icon: "time" },
  pay: { label: "Pay", paths: ["/pay"], icon: "pay" },
  me: { label: "Me", paths: ["/me"], icon: "me" },
  // an app shell cached before Home (its bar had Dashboard and More): see normalize()
  dashboard: { label: "Dashboard", paths: ["/dashboard"], icon: "chart" },
  more: { label: "More", more: true, icon: "more" },
});
// (Home has its own quick actions row in the button's place)
const CREATE_ON = new Set(["today", "contacts", "schedule", "sales"]);

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

// The office's bar from a shell cached before Home (Today · Inbox · Contacts ·
// Schedule · Dashboard · More) is today's bar; a tech's is unchanged.
export function normalize(nav) {
  const list = Array.isArray(nav) ? nav : [];
  return list.includes("more") || list.includes("dashboard") ? ["home", "inbox", "schedule", "contacts", "sales", "menu"] : list;
}

// mount({ nav: ["home", ...], manifests, can, onSignOut, user })
export function mount({ nav, manifests, can, onSignOut, user }) {
  st.can = can;
  st.onSignOut = onSignOut;
  st.user = user || null;
  st.more = manifests.flatMap((m) => (m.nav || []).filter((n) => n.where === "more")).filter((n) => allowed(n.perm) && routeOk(n.path)).sort((a, b) => (a.order || 50) - (b.order || 50));
  st.creates = manifests.flatMap((m) => m.creates || []).filter((c) => allowed(c.perm) && routeOk(c.path)).sort((a, b) => (a.order || 50) - (b.order || 50));
  st.tabs = [];
  for (const key of normalize(nav)) {
    const t = TABS[key];
    if (!t) continue;
    if (t.more) { st.tabs.push({ key, ...t, roots: [] }); continue; }
    if (t.group) {
      const segs = t.group.filter(([p]) => routeOk(p));
      if (segs.length) st.tabs.push({ key, ...t, path: segs[0][0], roots: segs.map(([p]) => p), segs });
      continue;
    }
    const path = t.paths.find(routeOk);
    if (path) st.tabs.push({ key, ...t, path, roots: [path] });
  }
  const box = document.getElementById("tabs");
  render(box, html`${st.tabs.map((t) => (t.more
    ? html`<button type="button" class="tab" data-tab="${t.key}" data-more>${icon(t.icon)}<span>${t.label}</span></button>`
    : html`<a class="tab" data-tab="${t.key}" href="${"#" + t.path}">${icon(t.icon)}<span>${t.label}</span><span class="badge" hidden></span></a>`))}`);
  box.addEventListener("click", (e) => { if (e.target.closest("[data-more]")) openMore(); });
  document.getElementById("app").classList.toggle("no-tabs", st.tabs.length < 2);

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

  // Hide the bar while typing (iOS puts the keyboard over it otherwise).
  const app = document.getElementById("app");
  const typing = (el) => !!el && (el.tagName === "TEXTAREA" || el.tagName === "SELECT" || (el.tagName === "INPUT" && !["checkbox", "radio", "button", "submit"].includes(el.type)));
  document.addEventListener("focusin", (e) => { if (typing(e.target)) app.classList.add("typing"); });
  document.addEventListener("focusout", () => setTimeout(() => { if (!typing(document.activeElement)) app.classList.remove("typing"); }, 60));
}

export const isTabRoot = (path) => st.tabs.some((t) => (t.roots || []).includes(path));

// Marks the tab of the current screen; shows the switch and the create button where they belong.
export function update(path) {
  // The nearest tab or More entry up the parent chain decides the highlight.
  let active = null;
  let viaMore = false;
  for (const p of router.chain(path)) {
    active = st.tabs.find((t) => !t.more && (t.roots || []).includes(p)) || null;
    if (active) break;
    // a screen the Menu lists: the Menu tab is lit (the More button on an older bar)
    if (st.more.some((n) => n.path === p)) { viaMore = true; active = st.tabs.find((t) => t.key === "menu") || null; break; }
  }
  document.querySelectorAll("#tabs [data-tab]").forEach((el) => {
    const t = st.tabs.find((x) => x.key === el.dataset.tab);
    const on = !!t && (t.more ? viaMore : active === t);
    if (on) el.setAttribute("aria-current", "page"); else el.removeAttribute("aria-current");
    // a tab of several screens opens the one you were last on
    if (t && t.segs && on && t.roots.includes(path)) el.setAttribute("href", "#" + path);
  });
  const atRoot = !!active && active.roots.includes(path);
  // the sidebar: the nearest entry up the chain is lit
  const items = [...document.querySelectorAll("#side [data-path]")];
  let lit = null;
  for (const p of router.chain(path)) { lit = items.find((a) => a.dataset.path === p) || null; if (lit) break; }
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
  let fab = document.getElementById("fab");
  const want = st.creates.length > 0 && atRoot && CREATE_ON.has(active.key);
  if (want && !fab) {
    fab = document.createElement("button");
    fab.type = "button";
    fab.id = "fab";
    fab.className = "fab";
    fab.setAttribute("aria-label", "Create");
    render(fab, icon("plus"));
    fab.addEventListener("click", openCreate);
    document.getElementById("app").appendChild(fab);
  } else if (!want && fab) fab.remove();
}

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

function openCreate() {
  const s = sheet({
    title: "Create",
    body: html`<ul class="menu">${st.creates.map((c) => html`<li><a href="${"#" + c.path}" data-close>${icon(c.icon || "plus")}<span>${c.label}</span></a></li>`)}</ul>`,
    events: { "click [data-close]": () => s.close() },
  });
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

const sideItem = (path, label, ic, key) => html`<a class="side-item" href="${"#" + path}" ${attrs({ "data-path": path.split("?")[0] === path ? path : null, "data-tab": key || null })}>${icon(ic || "list")}<span class="sl">${label}</span>${key ? html`<span class="badge" hidden></span>` : ""}</a>`;

function mountDesk() {
  const app = document.getElementById("app");
  if (!app || document.getElementById("side")) return;
  const office = st.tabs.some((t) => t.key === "menu");
  const shut = shutGroups();
  const side = document.createElement("nav");
  side.id = "side";
  side.className = "app-side";
  side.setAttribute("aria-label", "CRM sections");
  const top = st.tabs.filter((t) => !t.more && (office ? ["home", "inbox"].includes(t.key) : t.key !== "menu"));
  const u = st.user || {};
  render(side, html`<a class="side-logo" href="#/today"><img src="/assets/img/logo-bww.png" alt="Barta Window Washing" width="148" height="40"></a>
    <div class="side-scroll">
      ${top.map((t) => sideItem(t.path, t.label, t.icon, t.key))}
      ${office ? menuSections().map((sec) => html`<section class="${"side-grp sec-" + sec.key + (shut.has(sec.key) ? " shut" : "")}" data-grp="${sec.key}">
        <button type="button" class="side-h" ${attrs({ "aria-expanded": String(!shut.has(sec.key)) })}><span>${sec.label}</span><span class="side-chev" aria-hidden="true"></span></button>
        <div class="side-items">${sec.items.map((n) => sideItem(n.path, n.label, n.icon))}</div>
      </section>`) : ""}
    </div>
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
