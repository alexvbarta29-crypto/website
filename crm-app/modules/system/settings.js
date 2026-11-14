// Settings (design §9.2; the Nov 2026 tidy-up, "concise but full of
// capabilities"; then Rotor's and iOS's look: a search field on top that
// filters the rows by name, each row a small coloured tile, the label and a
// chevron, in inset cards under caps labels; the rare sections, Import &
// data and Maps & door to door, start folded, remembered on this device;
// owner-only rows carry an Owner badge): one hub, every setting in exactly one place, in plain
// sections: Company, Team & permissions, Pricing & services, Plans &
// agreements, Schedule, Messages & automations, Payments, Maps & door to
// door, Import & data, Appearance. LAYOUT below is the one place that says
// which screen sits in which section and what it is called; a row shows
// when its screen is there and this person may open it (the module's own
// settings entry, or Menu entry, decides; else the route's permission). A
// module's settings entry LAYOUT doesn't name lands in its `section`, or
// in More. Then About: the app version and whether the background work
// runs.

import { html, icon, attrs } from "../../core/ui.js";
import { MANIFESTS } from "../index.js";
import { APP_VERSION } from "../../version.js";
import { ago } from "../../core/format.js";
import { pickTheme } from "../../core/nav.js";

// [key, section title, [[path, label, icon], ...]]; "#theme" is the Light or dark picker (per device).
export const LAYOUT = Object.freeze([
  ["company", "Company", [["/settings/company", "Company details", "building"], ["/settings/service-area", "Service area", "map"]]],
  ["team", "Team & permissions", [["/team", "Team", "team"], ["/settings/permissions", "Permissions", "shield"], ["/settings/payroll", "Payroll & pay rates", "pay"]]],
  ["pricing", "Pricing & services", [["/settings/pricing", "Prices & price book", "money"], ["/settings/discounts", "Discounts", "money"]]],
  ["plans", "Plans & agreements", [["/settings/plans", "Plans & perks", "swap"], ["/settings/agreement-templates", "Agreements", "doc"]]],
  ["schedule", "Schedule", [["/settings/hours", "Hours & holidays", "clock"], ["/settings/schedule", "Crew & forecast", "truck"], ["/settings/checklists", "Checklists", "check"], ["/settings/tracking", "Tracking link", "route"]]],
  ["messages", "Messages & automations", [["/templates", "Message templates", "doc"], ["/automations", "Automations", "bolt"], ["/settings/cadences", "Follow-up cadences", "phone"], ["/settings/messaging", "Quiet hours & opt-out", "text"], ["/settings/texting", "Texting & email setup", "mail"]]],
  ["payments", "Payments", [["/settings/payments", "Payments & card fees", "money"]]],
  ["maps", "Maps & door to door", [["/settings/knock", "Door to door", "map"], ["/settings/maps", "Maps & team map", "map"]]],
  ["data", "Import & data", [["/import", "Import from Rotor", "data"], ["/cutover", "Switch from Rotor", "bolt"], ["/settings/integrations", "Integrations", "plug"], ["/settings/claude", "Claude connector", "plug"], ["/settings/intake", "Where website leads go", "contacts"], ["/settings/lead-hooks", "Facebook lead forms", "plug"], ["/settings/data", "Data & backups", "data"], ["/settings/dashboard", "Dashboard numbers", "chart"], ["/activity", "Activity log", "clock"], ["/legacy/customers", "Rotor's first customer list", "contacts"], ["/tools/rotor", "Open Rotor", "link"]]],
  ["look", "Appearance", [["#theme", "Light or dark", "sun"], ["/tab-bar", "Tab bar", "tabbar"], ["/calendar-feed", "Calendar feed", "today"]]],
]);
const KEYS = new Set(LAYOUT.map(([k]) => k));

// The rows this person gets, by section (pure: the tests call it). → [{ key, label, items: [{ path, label, icon, owner }] }]
export function sections(can, manifests = MANIFESTS) {
  const settings = manifests.flatMap((m) => m.settings || []);
  const navs = manifests.flatMap((m) => m.nav || []);
  const routes = manifests.flatMap((m) => m.routes || []);
  const named = new Set(LAYOUT.flatMap(([, , rows]) => rows.map(([p]) => p)));
  const open = (path) => {
    if (path === "#theme") return true;
    const own = settings.find((x) => x.path === path) || navs.find((x) => x.path === path);
    // (exactly, else a route with a param: /tools/rotor is /tools/:id)
    const r = routes.find((x) => x.path === path) || routes.find((x) => x.path.includes(":") && new RegExp("^" + x.path.replace(/:[a-z_]+/gi, "[^/]+") + "$").test(path));
    if (!r) return false;
    return own ? !own.perm || can(own.perm) === true : !r.perm || can(r.perm) === true;
  };
  const ownerOnly = (path) => { const own = settings.find((x) => x.path === path); return !!(own && own.owner); };
  const out = LAYOUT.map(([key, label, rows]) => ({ key, label, items: rows.filter(([p]) => open(p)).map(([path, l, ic]) => ({ path, label: l, icon: ic, owner: ownerOnly(path) })) }));
  const more = { key: "more", label: "More", items: [] };
  for (const x of settings.filter((e) => !named.has(e.path)).sort((a, b) => (a.order || 50) - (b.order || 50))) {
    if (!open(x.path)) continue;
    const into = KEYS.has(x.section) ? out.find((s) => s.key === x.section) : more;
    into.items.push({ path: x.path, label: x.label, icon: x.icon || "gear", owner: !!x.owner });
  }
  return [...out, more].filter((s) => s.items.length);
}

// The rare sections start folded ("Import & data · 11"); one opened stays open on this device.
export const FOLDED = Object.freeze(["maps", "data"]);
const OPEN_KEY = "crm-set-open";
const openSet = () => { try { return new Set(JSON.parse(localStorage.getItem(OPEN_KEY) || "[]")); } catch (e) { return new Set(); } };
function keepOpen(key, on) {
  try { const set = openSet(); if (on) set.add(key); else set.delete(key); localStorage.setItem(OPEN_KEY, JSON.stringify([...set])); } catch (e) { /* this browser keeps nothing */ }
}
// The row's tile colour (iOS Settings): one per section.
const TINT = { company: "blue", team: "green", pricing: "amber", plans: "green", schedule: "red", messages: "blue", payments: "green", maps: "teal", data: "grey", look: "purple", more: "grey" };

const owner = html`<span class="pill set-own">Owner</span>`;
const row = (x, tint) => {
  const inner = html`<span ${attrs({ class: "set-ic " + tint, "aria-hidden": "true" })}>${icon(x.icon || "gear")}</span><span class="who"><span class="nm">${x.label}</span>${x.path === "#theme" ? html`<span class="sub">This device</span>` : ""}</span><span class="end">${x.owner ? owner : ""}<span class="chev" aria-hidden="true"></span></span>`;
  return x.path === "#theme"
    ? html`<li ${attrs({ "data-label": x.label.toLowerCase() })}><button type="button" class="row set-row" data-theme-row>${inner}</button></li>`
    : html`<li ${attrs({ "data-label": x.label.toLowerCase() })}><a class="row set-row" ${attrs({ href: "#" + x.path })}>${inner}</a></li>`;
};

// One section: its caps label and its rows in an inset card; a folded one is a disclosure row with the count.
function section(sec, shut) {
  const tint = TINT[sec.key] || "grey";
  const fold = FOLDED.includes(sec.key);
  return html`<section ${attrs({ class: "set-sec" + (shut ? " shut" : ""), "aria-label": sec.label, "data-sec": sec.key })}>
    ${fold ? html`<button type="button" class="set-fold" ${attrs({ "data-fold": sec.key, "aria-expanded": shut ? "false" : "true" })}><span class="section-h">${sec.label}</span><span class="set-cnt">${String(sec.items.length)}</span><span class="side-chev" aria-hidden="true"></span></button>` : html`<div class="section-h">${sec.label}</div>`}
    <ul class="list set-list">${sec.items.map((x) => row(x, tint))}</ul>
  </section>`;
}

// The search field filters the rows in place (by name); a match in a folded section shows it.
function filter(view, q) {
  const t = String(q || "").trim().toLowerCase();
  let any = false;
  for (const sec of view.querySelectorAll(".set-sec")) {
    let n = 0;
    for (const li of sec.querySelectorAll("li[data-label]")) { const on = !t || li.dataset.label.includes(t); li.hidden = !on; if (on) n++; }
    sec.hidden = !!t && !n;
    sec.classList.toggle("found", !!t && n > 0);
    if (n) any = true;
  }
  const none = view.querySelector(".set-none");
  if (none) none.hidden = !t || any;
}

export default {
  title: "Settings",
  async load(params, ctx) {
    let health = null;
    if (ctx.can("audit:read")) { try { health = (await ctx.api("/admin/health", { cache: false })).data; } catch (e) { health = null; } }
    return { health, q: ctx.keep.q || "" };
  },
  render(s, ctx) {
    const h = s.health;
    const lane = (k) => (h && h.status ? h.status[k] : "never");
    const opened = openSet();
    return html`<div class="stack set-hub">
      <label class="set-find">${icon("search")}<span class="sr">Search settings</span><input type="search" data-set-q ${attrs({ value: s.q || "", placeholder: "Search settings", autocomplete: "off", enterkeyhint: "search" })}></label>
      <p class="muted set-none" hidden>No setting by that name.</p>
      ${sections(ctx.can).map((sec) => section(sec, FOLDED.includes(sec.key) && !opened.has(sec.key)))}
      <div class="section-h">About</div>
      <div class="card">
        <dl class="kv">
          <dt>App version</dt><dd class="num">${APP_VERSION}</dd>
          ${h ? html`<dt>Background work</dt><dd>${lane("fast") === "ok" && lane("bulk") === "ok" ? "Running" : lane("fast") === "never" ? "Not started yet" : "Check Data & backups"}${h.lanes && h.lanes.fast && h.lanes.fast.last_pass_at ? html` · <span class="muted">${ago(h.lanes.fast.last_pass_at)}</span>` : ""}</dd>` : ""}
          <dt>Rotor</dt><dd>Still in charge until the switch-over</dd>
        </dl>
      </div>
    </div>`;
  },
  mount(view, s) { if (s.q) filter(view, s.q); },
  events: {
    "click [data-theme-row]": () => pickTheme(),
    "input [data-set-q]": (e, el, ctx) => { ctx.state.q = ctx.keep.q = el.value; filter(el.closest(".set-hub"), el.value); },
    "click [data-fold]": (e, el) => {
      const sec = el.closest(".set-sec");
      const shut = !sec.classList.contains("shut");
      sec.classList.toggle("shut", shut);
      el.setAttribute("aria-expanded", String(!shut));
      keepOpen(el.dataset.fold, !shut);
    },
  },
};
