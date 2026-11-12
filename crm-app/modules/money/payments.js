// Payments (design §9.2 "Payments"): one month at a time, what came in
// (after refunds), tips, card fees, by method; each payment opens its
// invoice. Practice (test) payments are listed and marked, never counted.

import { html, attrs } from "../../core/ui.js";
import { money } from "../../core/format.js";
import { ensureStyles, METHOD, paymentRow, emptyCard, monthLabel, addMonth, thisMonth } from "./kit.js";

async function load(params, ctx) {
  ensureStyles();
  const month = ctx.keep.month || thisMonth();
  const method = ctx.keep.method || "";
  const r = await ctx.api(`/payments?month=${encodeURIComponent(month)}${method ? `&method=${encodeURIComponent(method)}` : ""}`, { cache: false });
  return { rows: r.data || [], totals: (r.meta && r.meta.totals) || {}, by: (r.meta && r.meta.by_method) || {}, month, method };
}

export default {
  load,
  render(s) {
    const t = s.totals;
    const methods = Object.keys(s.by).sort((a, b) => s.by[b] - s.by[a]);
    return html`<div class="stack">
      <div class="mn-month"><button type="button" class="btn" data-month="-1" aria-label="The month before">‹</button><b>${monthLabel(s.month)}</b><button type="button" class="btn" data-month="1" aria-label="The month after" ${attrs({ disabled: s.month >= thisMonth() })}>›</button></div>
      <div class="mn-tot">
        <div class="stat"><b>${money(t.collected_cents || 0)}</b><small>came in (after refunds)</small></div>
        <div class="stat"><b>${money(t.tips_cents || 0)}</b><small>tips for the crew</small></div>
        <div class="stat"><b>${money(t.fees_cents || 0)}</b><small>card fees</small></div>
        <div class="stat"><b>${money(t.refunds_cents || 0)}</b><small>refunded</small></div>
      </div>
      ${methods.length > 1 || s.method ? html`<div class="chips" role="tablist"><button type="button" class="chip" data-method="" ${attrs({ "aria-pressed": String(!s.method) })}>All</button>${[...new Set([...methods, s.method].filter(Boolean))].map((m) => html`<button type="button" class="chip" ${attrs({ "data-method": m, "aria-pressed": String(s.method === m) })}>${METHOD[m] || m}${s.by[m] ? html` <span class="n">${money(s.by[m])}</span>` : ""}</button>`)}</div>` : ""}
      ${t.simulated ? html`<p class="foot-note">${t.simulated} practice payment${t.simulated === 1 ? "" : "s"} (marked "test") ${t.simulated === 1 ? "is" : "are"} listed but never counted.</p>` : ""}
      ${s.rows.length ? html`<ul class="list tbl">${s.rows.map((p) => paymentRow(p))}</ul>` : emptyCard("No payments this month", "Payments land here as they come in.")}
    </div>`;
  },
  events: {
    "click [data-month]": (e, el, ctx) => { ctx.keep.month = addMonth(ctx.state.month, Number(el.dataset.month)); ctx.refresh(); },
    "click [data-method]": (e, el, ctx) => { ctx.keep.method = el.dataset.method; ctx.refresh(); },
  },
};
