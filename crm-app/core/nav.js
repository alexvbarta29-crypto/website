// Barta CRM client: the bottom tab bar, the More sheet and the create
// button (design §9.1).
//
// Tabs (core only): owners and admins get Today · Inbox · Contacts ·
// Schedule · More; techs get Today · Inbox · Time · Pay · Me. A tab shows
// only once a module has registered its screen (a capability that needs a
// later milestone is hidden, not broken), so before M2 Contacts opens the
// first slice's Customers list. More lists every manifest's
// `nav: [{ where: "more", ... }]` entry the person may open, then My
// account and Sign out. The coral create button lists the manifests'
// `creates` on Today, Contacts and Schedule. The bar hides while an input
// has focus (the keyboard is up) and sits above the home indicator.

import { html, render, sheet, icon } from "./ui.js";
import * as router from "./router.js";

export const TABS = Object.freeze({
  today: { label: "Today", paths: ["/today"], icon: "today" },
  inbox: { label: "Inbox", paths: ["/inbox"], icon: "inbox" },
  contacts: { label: "Contacts", paths: ["/contacts", "/legacy/customers"], icon: "contacts" },
  schedule: { label: "Schedule", paths: ["/schedule"], icon: "schedule" },
  dashboard: { label: "Dashboard", paths: ["/dashboard"], icon: "chart" },
  time: { label: "Time", paths: ["/time"], icon: "time" },
  pay: { label: "Pay", paths: ["/pay"], icon: "pay" },
  me: { label: "Me", paths: ["/me"], icon: "me" },
  more: { label: "More", more: true, icon: "more" },
});
const CREATE_ON = new Set(["today", "contacts", "schedule"]);

let st = { tabs: [], more: [], creates: [], can: () => false, onSignOut: () => {}, badges: {} };

const allowed = (perm) => !perm || st.can(perm);
const routeOk = (path) => {
  const m = router.match(path);
  return !!m && allowed(m.route.perm);
};

// mount({ nav: ["today", ...], manifests, can, onSignOut })
export function mount({ nav, manifests, can, onSignOut }) {
  st.can = can;
  st.onSignOut = onSignOut;
  st.more = manifests.flatMap((m) => (m.nav || []).filter((n) => n.where === "more")).filter((n) => allowed(n.perm) && routeOk(n.path)).sort((a, b) => (a.order || 50) - (b.order || 50));
  st.creates = manifests.flatMap((m) => m.creates || []).filter((c) => allowed(c.perm) && routeOk(c.path)).sort((a, b) => (a.order || 50) - (b.order || 50));
  st.tabs = [];
  for (const key of nav || []) {
    const t = TABS[key];
    if (!t) continue;
    if (t.more) { st.tabs.push({ key, ...t }); continue; }
    const path = t.paths.find(routeOk);
    if (path) st.tabs.push({ key, ...t, path });
  }
  const box = document.getElementById("tabs");
  render(box, html`${st.tabs.map((t) => (t.more
    ? html`<button type="button" class="tab" data-tab="${t.key}" data-more>${icon(t.icon)}<span>${t.label}</span></button>`
    : html`<a class="tab" data-tab="${t.key}" href="${"#" + t.path}">${icon(t.icon)}<span>${t.label}</span><span class="badge" hidden></span></a>`))}`);
  box.addEventListener("click", (e) => { if (e.target.closest("[data-more]")) openMore(); });
  document.getElementById("app").classList.toggle("no-tabs", st.tabs.length < 2);

  // Hide the bar while typing (iOS puts the keyboard over it otherwise).
  const app = document.getElementById("app");
  const typing = (el) => !!el && (el.tagName === "TEXTAREA" || el.tagName === "SELECT" || (el.tagName === "INPUT" && !["checkbox", "radio", "button", "submit"].includes(el.type)));
  document.addEventListener("focusin", (e) => { if (typing(e.target)) app.classList.add("typing"); });
  document.addEventListener("focusout", () => setTimeout(() => { if (!typing(document.activeElement)) app.classList.remove("typing"); }, 60));
}

export const isTabRoot = (path) => st.tabs.some((t) => t.path === path);

// Marks the tab of the current screen; shows the create button where it belongs.
export function update(path) {
  // The nearest tab or More entry up the parent chain decides the highlight.
  let active = null;
  let viaMore = false;
  for (const p of router.chain(path)) {
    active = st.tabs.find((t) => !t.more && t.path === p) || null;
    if (active) break;
    if (st.more.some((n) => n.path === p)) { viaMore = true; break; }
  }
  document.querySelectorAll("#tabs [data-tab]").forEach((el) => {
    const t = st.tabs.find((x) => x.key === el.dataset.tab);
    const on = !!t && (t.more ? viaMore : active === t);
    if (on) el.setAttribute("aria-current", "page"); else el.removeAttribute("aria-current");
  });
  let fab = document.getElementById("fab");
  const want = st.creates.length > 0 && !!active && CREATE_ON.has(active.key) && active.path === path;
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
  for (const [key, n] of Object.entries(st.badges)) {
    const b = document.querySelector(`#tabs [data-tab="${key}"] .badge`);
    if (!b) continue;
    b.hidden = !n;
    b.textContent = n > 99 ? "99+" : String(n);
  }
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

function openCreate() {
  const s = sheet({
    title: "Create",
    body: html`<ul class="menu">${st.creates.map((c) => html`<li><a href="${"#" + c.path}" data-close>${icon(c.icon || "plus")}<span>${c.label}</span></a></li>`)}</ul>`,
    events: { "click [data-close]": () => s.close() },
  });
}
