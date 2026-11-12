// Settings → Agreement templates (design §9.2, §5.4, D10): the agreement
// texts, each marked approved or "Draft, needs owner approval". Nothing is
// sent, or shown on a quote, from a text that isn't approved.

import { html, icon } from "../../core/ui.js";
import { ensureStyles, PLAN_NAMES, emptyCard } from "./kit.js";

export default {
  title: "Agreement templates",
  async load(params, ctx) {
    ensureStyles();
    const r = await ctx.api("/agreement-templates", { cache: false });
    return { rows: r.data || [] };
  },
  render(s) {
    if (!s.rows.length) return emptyCard("No agreement texts yet", "The drafts arrive with the next update.");
    return html`<div class="stack"><p class="small muted">Drafts written from Barta's rules. An owner reads, edits and approves each one before it can go to a customer.</p>
      <ul class="list">${s.rows.map((t) => html`<li><a class="row" href="${"#/settings/agreement-templates/" + encodeURIComponent(t.id)}"><span class="ico">${icon("doc")}</span>
        <span class="who"><span class="nm">${t.name}</span><span class="sub">${(t.catalog_keys || []).map((k) => PLAN_NAMES[k] || k).join(", ") || "Not used by a plan"} · version ${t.version}</span>${t.suggested ? html`<span class="sub pl-new">New wording</span>` : ""}</span>
        <span class="end"><span class="${"pill " + (t.approved ? "green" : t.active ? "amber" : "")}">${t.approved ? "Approved" : t.active ? "Needs approval" : "Off"}</span><span class="chev" aria-hidden="true"></span></span></a></li>`)}</ul></div>`;
  },
};
