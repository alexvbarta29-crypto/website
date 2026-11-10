// Settings (design §9.2 "Settings"): the sections this person may open,
// from every module's manifest (settings: [...]), owner-only ones marked,
// then About (the app version, the workers' health, what arrives later).
// Sections of modules that haven't shipped yet (Pricing, Plans, Cadences,
// Payments, Payroll...) appear once their milestone lands.

import { html, icon } from "../../core/ui.js";
import { MANIFESTS } from "../index.js";
import { APP_VERSION } from "../../version.js";
import { ago } from "../../core/format.js";

const LATER = ["Pricing & price book", "Discounts", "Plans catalog & perks", "Agreement templates", "Checklists", "Cadences", "Numbering", "Payments", "Payroll", "Cutover"];

export default {
  title: "Settings",
  async load(params, ctx) {
    let health = null;
    if (ctx.can("audit:read")) { try { health = (await ctx.api("/admin/health", { cache: false })).data; } catch (e) { health = null; } }
    return { health };
  },
  render(s, ctx) {
    const items = MANIFESTS.flatMap((m) => m.settings || []).filter((x) => !x.perm || ctx.can(x.perm)).sort((a, b) => (a.order || 50) - (b.order || 50));
    const h = s.health;
    const lane = (k) => (h && h.status ? h.status[k] : "never");
    return html`<div class="stack">
      <ul class="list">${items.map((x) => html`<li><a class="row" href="${"#" + x.path}">
        <span class="ico">${icon(x.icon || "gear")}</span>
        <span class="who"><span class="nm">${x.label}</span>${x.owner ? html`<span class="sub">Owners only</span>` : ""}</span>
        <span class="end"><span class="chev" aria-hidden="true"></span></span>
      </a></li>`)}</ul>
      <div class="section-h">About</div>
      <div class="card">
        <dl class="kv">
          <dt>App version</dt><dd class="num">${APP_VERSION}</dd>
          ${h ? html`<dt>Workers</dt><dd>${lane("fast") === "ok" && lane("bulk") === "ok" ? "Running" : lane("fast") === "never" ? "Not started yet" : "Check Data"}${h.lanes && h.lanes.fast && h.lanes.fast.last_pass_at ? html` · <span class="muted">${ago(h.lanes.fast.last_pass_at)}</span>` : ""}</dd>` : ""}
          <dt>Rotor</dt><dd>Still in charge until the switch-over</dd>
        </dl>
        <p class="small">Arriving with later parts of the CRM: ${LATER.join(", ")}.</p>
      </div>
    </div>`;
  },
};
