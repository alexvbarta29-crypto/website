// The plans card on Today (design §9.2 Today): plan visits to book this
// month, agreements waiting for a signature, and for owners the agreement
// texts to approve and clawbacks to bill.

import { html, icon } from "../../core/ui.js";
import { plural } from "../../core/format.js";
import { ensureStyles, thisMonth } from "./kit.js";

export default {
  async load(ctx) {
    ensureStyles();
    const [plans, ags, tpls] = await Promise.all([
      ctx.api("/plans", { cache: false }).catch(() => null),
      ctx.api("/agreements", { cache: false }).catch(() => null),
      ctx.can("agreement_templates:edit") ? ctx.api("/agreement-templates", { cache: false }).catch(() => null) : null,
    ]);
    const counts = (plans && plans.meta && plans.meta.counts) || {};
    return {
      due: counts.due || 0, clawbacks: ctx.can("plans:cancel") ? counts.clawback || 0 : 0,
      unsigned: ((ags && ags.data) || []).filter((a) => ["sent", "viewed"].includes(a.status)).length,
      drafts: ((tpls && tpls.data) || []).filter((t) => !t.approved && t.active !== false && (t.catalog_keys || []).length).length,
      month: thisMonth(),
    };
  },
  render(s) {
    if (!s.due && !s.unsigned && !s.drafts && !s.clawbacks) return html``;
    return html`<div class="section-h">Plans</div><div class="links">
      ${s.due ? html`<a class="tile" href="#/plans/due">${icon("schedule")}<span>${plural(s.due, "plan visit")} to book</span><span class="n">${s.due}</span></a>` : ""}
      ${s.unsigned ? html`<a class="tile" href="#/plans?status=pending">${icon("doc")}<span>${plural(s.unsigned, "agreement")} not signed</span><span class="n">${s.unsigned}</span></a>` : ""}
      ${s.drafts ? html`<a class="tile" href="#/settings/agreement-templates">${icon("check")}<span>${plural(s.drafts, "agreement text")} to approve</span><span class="n">${s.drafts}</span></a>` : ""}
      ${s.clawbacks ? html`<a class="tile" href="#/plans?status=clawback">${icon("money")}<span>${plural(s.clawbacks, "clawback")} to bill</span><span class="n">${s.clawbacks}</span></a>` : ""}
    </div>`;
  },
};
