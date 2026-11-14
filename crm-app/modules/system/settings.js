// Settings (design §9.2; the Nov 2026 tidy-up, then the owner's "there is
// still way too much stuff, just make it more organized"): iOS's and
// Rotor's settings. The hub is a search field and a short list of GROUP
// rows (Business, Team, Services & pricing, Messages, Payments,
// Connections, Rotor & data, This phone), each a coloured tile, the group's
// name, a grey line naming what is inside and a chevron; a group opens its
// own page (#/settings/g/:key, settings-group.js) with its rows in one
// inset card. A group with one row this person may open goes straight to
// that screen; a group with none is hidden. Typing in the search field
// lists every row of every group, flat, each with its group's name under
// it; clearing it shows the groups again. Then About: the app version and
// whether the background work runs.
//
// LAYOUT below is the one place that says which screen sits in which group
// and what it is called; a row shows when its screen is there and this
// person may open it (the module's own settings entry, or Menu entry,
// decides; else the route's permission). A module's settings entry LAYOUT
// doesn't name lands at the end of its `section`'s group (the old section
// keys map to the new groups: SECTION_TO_GROUP), else at the end of
// Business: nothing disappears.

import { html, icon, attrs } from "../../core/ui.js";
import { MANIFESTS } from "../index.js";
import { APP_VERSION } from "../../version.js";
import { ago } from "../../core/format.js";
import { pickTheme } from "../../core/nav.js";

// [key, group name, icon, tile colour, [[path, label, icon, short], ...]]; "short" makes the group's grey line.
// "#theme" is the Light or dark picker (per device).
export const LAYOUT = Object.freeze([
  ["business", "Business", "building", "blue", [
    ["/settings/company", "Company details", "building", "company"],
    ["/settings/service-area", "Service area", "map", "service area"],
    ["/settings/hours", "Hours & holidays", "clock", "hours"],
    ["/settings/tracking", "Tracking link", "route", "tracking link"]]],
  ["team", "Team", "team", "green", [
    ["/team", "Team", "team", "team"],
    ["/settings/permissions", "Permissions", "shield", "permissions"],
    ["/settings/payroll", "Payroll & pay rates", "pay", "payroll"]]],
  ["services", "Services & pricing", "money", "amber", [
    ["/settings/pricing", "Prices & price book", "money", "prices"],
    ["/settings/discounts", "Discounts", "money", "discounts"],
    ["/settings/plans", "Plans & perks", "swap", "plans"],
    ["/settings/agreement-templates", "Agreements", "doc", "agreements"],
    ["/settings/checklists", "Checklists", "check", "checklists"],
    ["/settings/schedule", "Crew & forecast", "truck", "crew"]]],
  ["messages", "Messages", "text", "teal", [
    ["/templates", "Message templates", "doc", "templates"],
    ["/automations", "Automatic messages", "bolt", "automatic messages"],
    ["/settings/cadences", "Follow-up cadences", "phone", "follow-ups"],
    ["/settings/messaging", "Quiet hours & opt-out", "text", "quiet hours"],
    ["/settings/texting", "Texting & email setup", "mail", "texting"],
    ["/settings/numbers", "Business numbers", "phone", "numbers"],
    ["/settings/muted", "Muted contacts", "pause", "muted"],
    ["/settings/reviews", "Reviews", "star", "reviews"],
    ["/approvals", "Approvals", "check", "approvals"],
    ["/outbox", "Outbox (not sent)", "send", "outbox"]]],
  ["payments", "Payments", "receipt", "green", [
    ["/settings/payments", "Payments & card fees", "money", "payments and card fees"]]],
  ["connections", "Connections", "plug", "red", [
    ["/settings/integrations", "Integrations", "plug", "integrations"],
    ["/settings/claude", "Claude connector", "plug", "Claude"],
    ["/settings/intake", "Where website leads go", "contacts", "website leads"],
    ["/settings/lead-hooks", "Facebook lead forms", "plug", "Facebook"],
    ["/settings/maps", "Maps & team map", "map", "maps"],
    ["/settings/knock", "Door to door", "map", "door to door"]]],
  ["data", "Rotor & data", "data", "grey", [
    ["/import", "Import from Rotor", "data", "import"],
    ["/cutover", "Switch from Rotor", "bolt", "switch"],
    ["/settings/data", "Data & backups", "data", "backups"],
    ["/settings/dashboard", "Dashboard numbers", "chart", "dashboard"],
    ["/activity", "Activity log", "clock", "activity"],
    ["/legacy/customers", "Rotor's first customer list", "contacts", "first list"],
    ["/tools/rotor", "Open Rotor", "link", "Rotor"]]],
  ["phone", "This phone", "tabbar", "purple", [
    ["#theme", "Light or dark", "sun", "light or dark"],
    ["/tab-bar", "Tab bar", "tabbar", "tab bar"],
    ["/calendar-feed", "Calendar feed", "today", "calendar"]]],
]);
// A module's settings entry may name its section by an old key (before the groups) or a group's own key.
export const SECTION_TO_GROUP = Object.freeze({
  company: "business", team: "team", pricing: "services", plans: "services", schedule: "services",
  messages: "messages", payments: "payments", maps: "connections", data: "data", look: "phone",
  ...Object.fromEntries(LAYOUT.map(([k]) => [k, k])),
});
// where a module's setting with no (known) section goes
export const FALLBACK_GROUP = "business";

// The grey line under a group: what is inside, short enough for one line on an iPhone SE.
export function caption(items, max = 34) {
  const words = items.map((x) => x.short || x.label.toLowerCase());
  let out = "";
  let n = 0;
  for (; n < words.length; n++) {
    const next = (out ? out + ", " : "") + words[n];
    const tail = n + 1 < words.length ? " and more".length : 0;
    if (n > 0 && next.length + tail > max) break;
    out = next;
  }
  if (n < words.length) out += " and more";
  return out.charAt(0).toUpperCase() + out.slice(1);
}

// The groups this person gets (pure: the tests call it).
// → [{ key, label, icon, tint, caption, items: [{ path, label, icon, owner, short }] }], empty groups left out.
export function groups(can, manifests = MANIFESTS) {
  const settings = manifests.flatMap((m) => m.settings || []);
  const navs = manifests.flatMap((m) => m.nav || []);
  const routes = manifests.flatMap((m) => m.routes || []);
  const named = new Set(LAYOUT.flatMap(([, , , , rows]) => rows.map(([p]) => p)));
  const open = (path) => {
    if (path === "#theme") return true;
    const own = settings.find((x) => x.path === path) || navs.find((x) => x.path === path);
    // (exactly, else a route with a param: /tools/rotor is /tools/:id)
    const r = routes.find((x) => x.path === path) || routes.find((x) => x.path.includes(":") && new RegExp("^" + x.path.replace(/:[a-z_]+/gi, "[^/]+") + "$").test(path));
    if (!r) return false;
    return own ? !own.perm || can(own.perm) === true : !r.perm || can(r.perm) === true;
  };
  const ownerOnly = (path) => { const own = settings.find((x) => x.path === path); return !!(own && own.owner); };
  const out = LAYOUT.map(([key, label, ic, tint, rows]) => ({ key, label, icon: ic, tint,
    items: rows.filter(([p]) => open(p)).map(([path, l, i, short]) => ({ path, label: l, icon: i, owner: ownerOnly(path), short })) }));
  for (const x of settings.filter((e) => !named.has(e.path)).sort((a, b) => (a.order || 50) - (b.order || 50))) {
    if (!open(x.path)) continue;
    const into = out.find((g) => g.key === (SECTION_TO_GROUP[x.section] || FALLBACK_GROUP));
    into.items.push({ path: x.path, label: x.label, icon: x.icon || "gear", owner: !!x.owner, short: x.label.toLowerCase() });
  }
  return out.filter((g) => g.items.length).map((g) => ({ ...g, caption: caption(g.items) }));
}
// One group by its key (the group page), or null.
export const group = (can, key, manifests = MANIFESTS) => groups(can, manifests).find((g) => g.key === key) || null;
// (the name the old tests and callers knew)
export const sections = groups;

const ownerPill = html`<span class="pill set-own">Owner</span>`;
const tile = (ic, tint) => html`<span ${attrs({ class: "set-ic " + (tint || "grey"), "aria-hidden": "true" })}>${icon(ic || "gear")}</span>`;
// A setting's row (a group page, a search result): the tile, the label, a grey line (`sub`), Owner, the chevron.
export function settingRow(x, tint, { sub = null, hidden = false, group: g = null } = {}) {
  const line = sub || (x.path === "#theme" ? "This device" : null);
  const inner = html`${tile(x.icon, tint)}<span class="who"><span class="nm">${x.label}</span>${line ? html`<span class="sub">${line}</span>` : ""}</span><span class="end">${x.owner ? ownerPill : ""}<span class="chev" aria-hidden="true"></span></span>`;
  // (a search result knows its group: data-in is its key, data-grp its name, which the search also matches)
  const li = { "data-label": x.label.toLowerCase(), "data-in": g ? g.key : null, "data-grp": g ? g.label.toLowerCase() : null, hidden };
  return x.path === "#theme"
    ? html`<li ${attrs(li)}><button type="button" class="row set-row" data-theme-row>${inner}</button></li>`
    : html`<li ${attrs(li)}><a class="row set-row" ${attrs({ href: "#" + x.path })}>${inner}</a></li>`;
}
// A group's row on the hub: its own page, or the one screen in it.
function groupRow(g) {
  const only = g.items.length === 1 ? g.items[0] : null;
  const inner = html`${tile(g.icon, g.tint)}<span class="who"><span class="nm">${g.label}</span><span class="sub">${g.caption}</span></span><span class="end"><span class="chev" aria-hidden="true"></span></span>`;
  if (only && only.path === "#theme") return html`<li><button type="button" class="row set-row set-grp-row" data-theme-row ${attrs({ "data-group": g.key })}>${inner}</button></li>`;
  return html`<li><a class="row set-row set-grp-row" ${attrs({ href: "#" + (only ? only.path : "/settings/g/" + g.key), "data-group": g.key })}>${inner}</a></li>`;
}
// The hub's cards, iOS-style: the business ones, the outside world, this phone.
const CARDS = [["business", "team", "services", "messages", "payments"], ["connections", "data"], ["phone"]];

// The search lists every row of every group (by name, or its group's name).
function filter(view, q) {
  const t = String(q || "").trim().toLowerCase();
  const res = view.querySelector(".set-res");
  const grp = view.querySelector(".set-groups");
  let n = 0;
  for (const li of view.querySelectorAll(".set-res li[data-label]")) {
    const on = !!t && (li.dataset.label.includes(t) || String(li.dataset.grp || "").includes(t));
    li.hidden = !on;
    if (on) n++;
  }
  if (res) res.hidden = !t || !n;
  if (grp) grp.hidden = !!t;
  const none = view.querySelector(".set-none");
  if (none) none.hidden = !t || n > 0;
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
    const gs = groups(ctx.can);
    const q = String(s.q || "").trim().toLowerCase();
    const hit = (x, g) => !!q && (x.label.toLowerCase().includes(q) || g.label.toLowerCase().includes(q));
    const all = gs.flatMap((g) => g.items.map((x) => ({ x, g })));
    const found = all.filter(({ x, g }) => hit(x, g)).length;
    return html`<div class="rs-page set-hub">
      <label class="set-find">${icon("search")}<span class="sr">Search settings</span><input type="search" data-set-q ${attrs({ value: s.q || "", placeholder: "Search settings", autocomplete: "off", enterkeyhint: "search" })}></label>
      <p ${attrs({ class: "muted set-none", hidden: !q || found > 0 })}>No setting by that name.</p>
      <ul ${attrs({ class: "list set-list set-res", "aria-label": "Search results", hidden: !found })}>${all.map(({ x, g }) => settingRow(x, g.tint, { sub: g.label, hidden: !hit(x, g), group: g }))}</ul>
      <div ${attrs({ class: "set-groups", hidden: !!q })}>
        ${CARDS.map((keys) => gs.filter((g) => keys.includes(g.key))).filter((c) => c.length).map((c) => html`<ul class="list set-list" aria-label="Settings groups">${c.map(groupRow)}</ul>`)}
      </div>
      <h2 class="rs-label">About</h2>
      <div class="rs-card">
        <dl class="kv">
          <dt>App version</dt><dd class="num">${APP_VERSION}</dd>
          ${h ? html`<dt>Background work</dt><dd>${lane("fast") === "ok" && lane("bulk") === "ok" ? "Running" : lane("fast") === "never" ? "Not started yet" : "Check Data & backups"}${h.lanes && h.lanes.fast && h.lanes.fast.last_pass_at ? html` · <span class="muted">${ago(h.lanes.fast.last_pass_at)}</span>` : ""}</dd>` : ""}
          <dt>Rotor</dt><dd>Still in charge until the switch-over</dd>
        </dl>
      </div>
    </div>`;
  },
  events: {
    "click [data-theme-row]": () => pickTheme(),
    "input [data-set-q]": (e, el, ctx) => { ctx.state.q = ctx.keep.q = el.value; filter(el.closest(".set-hub"), el.value); },
  },
};
