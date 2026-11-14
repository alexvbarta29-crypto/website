// Settings (design §9.2; the Nov 2026 tidy-up, "concise but full of
// capabilities"): one hub, every setting in exactly one place, in plain
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
  ["team", "Team & permissions", [["/team", "Team", "team"], ["/settings/permissions", "Permissions", "shield"]]],
  ["pricing", "Pricing & services", [["/settings/pricing", "Prices & price book", "money"], ["/settings/discounts", "Discounts", "money"]]],
  ["plans", "Plans & agreements", [["/settings/plans", "Plans & perks", "swap"], ["/settings/agreement-templates", "Agreements", "doc"]]],
  ["schedule", "Schedule", [["/settings/hours", "Hours & holidays", "clock"], ["/settings/schedule", "Crew & forecast", "truck"], ["/settings/checklists", "Checklists", "check"], ["/settings/tracking", "Tracking link", "route"]]],
  ["messages", "Messages & automations", [["/templates", "Message templates", "doc"], ["/automations", "Automations", "bolt"], ["/settings/cadences", "Follow-up cadences", "phone"], ["/settings/messaging", "Quiet hours & opt-out", "text"], ["/settings/texting", "Texting & email setup", "mail"]]],
  ["payments", "Payments", [["/settings/payments", "Payments & card fees", "money"]]],
  ["maps", "Maps & door to door", [["/settings/knock", "Door to door", "map"], ["/settings/maps", "Maps & team map", "map"]]],
  ["data", "Import & data", [["/import", "Import from Rotor", "data"], ["/settings/integrations", "Integrations", "plug"], ["/settings/intake", "Where website leads go", "contacts"], ["/settings/lead-hooks", "Facebook lead forms", "plug"], ["/settings/data", "Data & backups", "data"], ["/activity", "Activity log", "clock"], ["/legacy/customers", "Rotor's first customer list", "contacts"], ["/tools/rotor", "Open Rotor", "link"]]],
  ["look", "Appearance", [["#theme", "Light or dark", "sun"], ["/tab-bar", "Tab bar", "tabbar"]]],
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

const row = (x) => (x.path === "#theme"
  ? html`<li><button type="button" class="row" data-theme-row><span class="ico">${icon(x.icon)}</span><span class="who"><span class="nm">${x.label}</span><span class="sub">This device</span></span><span class="end"><span class="chev" aria-hidden="true"></span></span></button></li>`
  : html`<li><a class="row" ${attrs({ href: "#" + x.path })}><span class="ico">${icon(x.icon || "gear")}</span><span class="who"><span class="nm">${x.label}</span></span><span class="end"><span class="chev" aria-hidden="true"></span></span></a></li>`);

export default {
  title: "Settings",
  async load(params, ctx) {
    let health = null;
    if (ctx.can("audit:read")) { try { health = (await ctx.api("/admin/health", { cache: false })).data; } catch (e) { health = null; } }
    return { health };
  },
  render(s, ctx) {
    const h = s.health;
    const lane = (k) => (h && h.status ? h.status[k] : "never");
    return html`<div class="stack set-hub">
      ${sections(ctx.can).map((sec) => html`<section ${attrs({ "aria-label": sec.label, "data-sec": sec.key })}><div class="section-h">${sec.label}</div><ul class="list">${sec.items.map(row)}</ul></section>`)}
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
  events: {
    "click [data-theme-row]": () => pickTheme(),
  },
};
