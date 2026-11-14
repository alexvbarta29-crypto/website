// Pay (design §9.3 "Pay", §5.8, D3): the person's own pay, only theirs.
// Until payroll arrives (M7a) it is an estimate from their clocked hours:
// Sunday to Saturday weeks, overtime over 40 hours at 1.5x, at their rate
// (D3: $20 an hour for service when the office hasn't set one). Time
// waiting for the office isn't counted until it's approved. Past weeks
// below; payroll's pay sheets replace this when it ships.

import { html, icon, attrs } from "../../core/ui.js";
import { money, dateShort, time as fmtTime } from "../../core/format.js";
import { ensureStyles, hm, hours, CATEGORY, offlineLine } from "./tech-kit.js";

const addDays = (date, n) => new Date(Date.parse(date + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const periodQuery = () => { try { return new URLSearchParams(location.hash.split("?")[1] || "").get("period") || ""; } catch (e) { return ""; } };

export default {
  title: "Pay",
  async load(params, ctx) {
    ensureStyles();
    const p = periodQuery();
    const r = await ctx.api(`/me/pay${p ? `?period=${encodeURIComponent(p)}` : ""}`);
    const s = { ...r.data, offline: !!r.offline, as_of: r.as_of || null };
    // payroll (M7a) answers with the real pay: its own view draws it
    if (s.payroll) { s.view = (await import("../payroll/pay-view.js")).default; if (s.view.load) await s.view.load(s, ctx); }
    return s;
  },
  render(s, ctx) {
    if (s.view) return s.view.render(s, ctx);
    const e = s.estimate || {};
    const start = s.period && s.period.start_on;
    const cats = Object.entries(e.by_category || {});
    return html`<div class="stack">
      <div class="tf-weekbar"><a class="icon-btn" ${attrs({ href: `#/pay?period=${addDays(start, -7)}`, "aria-label": "Week before" })}>${icon("back")}</a><span class="d">${dateShort(start)} – ${dateShort(s.period.end_on)}</span><a class="icon-btn" ${attrs({ href: `#/pay?period=${addDays(start, 7)}`, "aria-label": "Next week" })}><span class="flip">${icon("back")}</span></a></div>
      ${offlineLine({ offline: s.offline, as_of: s.as_of, what: "Your pay" })}
      <div class="card">
        <div class="tf-total"><b>${money(e.total_cents || 0)}</b><span>estimate for the week<br>${hm(e.minutes || 0)} worked</span></div>
        <dl class="tf-money">
          ${cats.length > 1 ? cats.map(([c, m]) => html`<dt>${CATEGORY[c] || c}</dt><dd>${hours(m)} h at ${money((e.rates || {})[c] || 0)}</dd>`) : ""}
          <dt>Regular hours</dt><dd>${hours(e.regular_min)} h</dd>
          <dt>Overtime (over ${s.ot_threshold_hours || 40} h, ${s.ot_multiplier || 1.5}x)</dt><dd>${hours(e.ot_min)} h</dd>
          <dt>Rate</dt><dd>${money(e.rate_cents || 0)} an hour${e.rate_is_default ? " (standard)" : ""}</dd>
          <dt>Regular pay</dt><dd>${money(e.regular_cents || 0)}</dd>
          <dt>Overtime pay</dt><dd>${money(e.ot_cents || 0)}</dd>
          <dt class="tot">Estimate</dt><dd class="tot">${money(e.total_cents || 0)}</dd>
        </dl>
        ${e.pending_min ? html`<p class="warn-box" style="margin-top:12px">${hm(e.pending_min)} is waiting for the office and isn't counted yet.</p>` : ""}
        ${e.open_min ? html`<p class="small muted" style="margin-top:10px">You're on the clock: the shift counts once you clock out.</p>` : ""}
        <p class="small muted" style="margin-top:10px">${s.note || "An estimate from your clocked hours. Your pay sheet comes from payroll."} Tips and commissions show once payroll is set up.</p>
      </div>
      ${(s.past || []).length ? html`<div class="section-h">Earlier weeks</div><ul class="list">${s.past.map((w) => html`<li><a class="row" ${attrs({ href: `#/pay?period=${w.week_start}` })}><span class="who"><span class="nm">${dateShort(w.week_start)} – ${dateShort(w.week_end)}</span><span class="sub">${hm(w.minutes)}${w.ot_min ? ` · ${hm(w.ot_min)} overtime` : ""}</span></span><span class="end num">${money(w.total_cents)}</span><span class="chev" aria-hidden="true"></span></a></li>`)}</ul>` : ""}
    </div>`;
  },
};
