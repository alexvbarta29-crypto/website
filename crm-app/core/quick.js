// Barta CRM client: the phone shell's two overlays (the Nov 2026 layout,
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

import { html, render, icon, attrs, sheet, toast } from "./ui.js";
import { api } from "./api.js";
import { initials, ago } from "./format.js";
import * as router from "./router.js";

// The + sheet's things to make, in the owner's order, from the manifests' creates
// (which nav.js already kept to this person's permissions and routes).
const MAKE = [
  ["/contacts/new", "Customer", "contacts", "contacts:write"], ["/leads/new", "Lead", "target"], ["/quotes/new", "Quote", "doc"], ["/jobs/new", "Job", "schedule"],
  ["/plans/new", "Plan", "swap"], ["/invoices/new", "Invoice", "money"], ["/tasks/new", "Task", "check"],
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

const avatarStyle = (u) => (u && /^#[0-9a-f]{6}$/i.test(u.color || "") ? `background:${u.color}` : null);

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
    },
  });
  s.el.classList.add("menu-sheet");
  const head = s.el.querySelector(".sheet-head");
  const btns = document.createElement("div");
  btns.className = "ms-btns";
  render(btns, html`${can("tasks:write") ? html`<button type="button" class="rnd" data-bug aria-label="Report a problem">${icon("bug")}</button>` : ""}<a class="rnd ms-me" href="#/me" data-close ${attrs({ style: avatarStyle(user), "aria-label": `${user.name || "My account"}: my account` })}>${initials(user.name)}</a>`);
  head.insertBefore(btns, head.querySelector("[data-sheet-x]"));
  // the latest reply nobody has read yet, one tap from its thread
  if (can("inbox:read")) {
    api("/inbox?filter=unread", { cache: false }).then((r) => {
      const c = ((r && r.data) || []).find((x) => x.last_direction === "in" || x.unread);
      const box = s.el.querySelector(".ms-reply");
      if (!c || !box) return;
      render(box, html`<a class="ms-replycard" ${attrs({ href: "#/inbox/" + encodeURIComponent(c.id) })} data-close>
        <span class="ms-av">${initials(c.contact_name)}</span>
        <span class="who"><span class="nm">${c.contact_name || "Someone"} replied ${c.last_at ? ago(c.last_at) : ""}</span><span class="sub">${c.last_preview || ""}</span></span>
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
