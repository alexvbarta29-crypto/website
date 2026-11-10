// The contact's Quotes tab (design §9.2 Contact → Sales "quotes"): every
// quote of this contact, newest first, and New quote for them. (Sales owns
// the Sales tab; this sits beside it.)

import { html, icon } from "../../core/ui.js";
import { ensureStyles, quoteRow } from "./kit.js";

export default {
  async load(params, ctx) {
    ensureStyles();
    if (!ctx.can("quotes:read")) return { denied: true };
    const r = await ctx.api(`/quotes?contact=${encodeURIComponent(params.id)}`, { cache: false });
    return { id: params.id, rows: r.data || [] };
  },
  render(s, ctx) {
    if (s.denied) return html`<div class="card empty"><h2>Not for this login</h2><p>Quotes are for the office.</p></div>`;
    return html`<div class="stack">
      ${ctx.can("quotes:write") ? html`<div class="btn-row" style="margin-top:0"><a class="btn primary" href="${"#/quotes/new/" + encodeURIComponent(s.id)}">${icon("doc")}New quote</a></div>` : ""}
      ${s.rows.length ? html`<ul class="list">${s.rows.map(quoteRow)}</ul>` : html`<p class="muted small">No quotes yet.</p>`}
    </div>`;
  },
};
