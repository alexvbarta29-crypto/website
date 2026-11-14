// The person's own Pay (design §9.3 "Pay", §5.8), drawn inside the work
// module's #/pay once GET /me/pay answers from payroll: the period's pay so
// far (or final, once the office locks it), what it is made of line by line
// (hours, overtime, commissions, tips, bonuses), time still waiting for the
// office, their own row of the crew scoreboard, earlier weeks, and their
// printable pay sheet. Only ever their own.

import { html, attrs, icon } from "../../core/ui.js";
import { offlineLine } from "../work/tech-kit.js";
import { ensureStyles, statusPill, span, dollars, hrs, lineRow, totalsGrid, addDays, MODEL } from "./kit.js";

const HEAD = { open: "So far this period", locked: "Final pay for the period", paid: "Paid for the period" };

export default {
  load() { ensureStyles(); },
  render(s) {
    const p = s.period || {};
    const t = s.totals || {};
    const start = p.start_on;
    const b = s.scoreboard;
    const g = s.goals || {};
    return html`<div class="stack py-page">
      <div class="tf-weekbar"><a class="icon-btn" ${attrs({ href: `#/pay?period=${addDays(start, -7)}`, "aria-label": "Week before" })}>${icon("back")}</a><span class="d">${span(p.start_on, p.end_on)}</span><a class="icon-btn" ${attrs({ href: `#/pay?period=${addDays(p.end_on, 1)}`, "aria-label": "Next week" })}><span class="flip">${icon("back")}</span></a></div>
      ${offlineLine({ offline: s.offline, as_of: s.as_of, what: "Your pay" })}
      <section class="card py-hero" data-my-pay>
        <span class="k">${HEAD[p.status] || HEAD.open}</span>
        <span class="big">${dollars(t.total_cents || 0)}</span>
        <span class="meta">${statusPill(p.status)}<span>${MODEL[s.model] || "Hourly"}</span></span>
        ${totalsGrid(t)}
        ${t.adjustments_cents ? html`<p class="py-note">Bonuses and adjustments: ${dollars(t.adjustments_cents)}</p>` : ""}
        ${t.pending_minutes ? html`<p class="py-warn">${hrs(t.pending_minutes / 60)} waits for the office and isn't counted yet.</p>` : ""}
        <p class="py-note">${s.note || ""}</p>
        <div class="py-acts"><a class="btn" ${attrs({ href: `/api/crm/me/pay/sheet?period=${encodeURIComponent(start || "")}`, target: "_blank", rel: "noopener" })}>My pay sheet</a></div>
      </section>
      ${(s.lines || []).length ? html`<section class="card"><h2>What it's made of</h2><ul class="py-lines">${s.lines.map((l) => lineRow(l))}</ul></section>` : html`<section class="card empty"><h2>Nothing yet this period</h2><p>Approved time, finished jobs and tips show here as they come in.</p></section>`}
      ${b ? html`<section class="card"><h2>Your scoreboard</h2>
        <div class="py-tiles">
          <div><span>Per hour</span><b>${b.revenue_per_hour_cents === null ? "-" : dollars(b.revenue_per_hour_cents)}</b><small>goal ${dollars(g.revenue_per_hour_cents || 12500)}</small></div>
          <div><span>Reviews</span><b>${String(b.reviews)}</b><small>goal ${g.reviews_per_week || 2} a week</small></div>
          <div><span>Upsells</span><b>${dollars(b.upsell_cents)}</b><small>${b.upsell_share_pct === null || b.upsell_share_pct === undefined ? "of your jobs" : `${b.upsell_share_pct}% of your jobs`}</small></div>
          <div><span>Callbacks</span><b>${String(b.callbacks)}</b><small>goal under ${g.callbacks_pct || 2}%</small></div>
        </div></section>` : ""}
      ${(s.past || []).length ? html`<div class="section-h">Earlier weeks</div><ul class="list">${s.past.map((w) => html`<li><a class="row" ${attrs({ href: `#/pay?period=${w.week_start}` })}><span class="who"><span class="nm">${span(w.week_start, w.week_end)}</span><span class="sub">${hrs((w.minutes || 0) / 60)}${w.ot_min ? ` · ${hrs(w.ot_min / 60)} overtime` : ""}${w.status ? ` · ${w.status === "paid" ? "paid" : w.status === "locked" ? "final" : "not final"}` : " · hours only"}</span></span><span class="end num">${dollars(w.total_cents)}</span><span class="chev" aria-hidden="true"></span></a></li>`)}</ul>` : ""}
    </div>`;
  },
};
