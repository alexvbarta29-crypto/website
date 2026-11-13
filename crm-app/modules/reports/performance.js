// My performance (the Nov 2026 layout, after Flyra's): what you sold this
// week, month or year, the running total day by day, jobs and plans sold,
// your average job and the yearly plan money (ARR), and your streak of days
// in a row with a sale (this month's days as a grid). Share sends a short
// summary (the Web Share API when the phone has it, else it's copied).
// GET /me/performance (reports.leaderboard's numbers, for one person).

import { html, attrs, icon, toast } from "../../core/ui.js";
import { money, roleLabel } from "../../core/format.js";
import { ensureStyles, avatar } from "./kit.js";

const PERIODS = [["week", "This week"], ["month", "This month"], ["year", "This year"]];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const dollars = (c) => money(c || 0).replace(/\.00$/, "");
export const soldHeading = (s) => (s.period === "week" ? "Sold this week" : s.period === "year" ? `Sold in ${s.from.slice(0, 4)}` : `Sold in ${MONTHS[Number(s.from.slice(5, 7)) - 1]}`);
const shortDay = (d) => `${MONTHS[Number(d.slice(5, 7)) - 1].slice(0, 3)} ${Number(d.slice(8, 10))}`;

// The running total as a line (an SVG drawn here; no chart library).
export function sparkline(series = [], { w = 320, h = 90 } = {}) {
  const max = Math.max(1, ...series.map((x) => x.cents));
  const pts = series.map((x, i) => [series.length > 1 ? (i / (series.length - 1)) * w : w, h - 4 - (x.cents / max) * (h - 10)]);
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1] || [w, h - 4];
  return html`<svg class="pf-line" ${attrs({ viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: "none", role: "img", "aria-label": `Running total, ${dollars(series.length ? series[series.length - 1].cents : 0)} by today` })}><path ${attrs({ d: d || `M0 ${h - 4} L${w} ${h - 4}` })} fill="none" stroke="#db3a29" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"></path><circle ${attrs({ cx: last[0].toFixed(1), cy: last[1].toFixed(1), r: "4" })} fill="#db3a29"></circle></svg>`;
}

export default {
  title: "My performance",
  async load(params, ctx) {
    ensureStyles();
    const period = ctx.keep.period || "month";
    const r = await ctx.api(`/me/performance?period=${period}`, { cache: false });
    return { ...r.data, period };
  },
  render(s, ctx) {
    const u = ctx.user || {};
    const grid = (s.streak && s.streak.grid) || [];
    return html`<div class="stack pf-page">
      <div class="rp-bar"><label class="rp-sel"><span class="sr">Period</span><select data-period>${PERIODS.map(([k, l]) => html`<option ${attrs({ value: k, selected: s.period === k })}>${l}</option>`)}</select></label>
        <button type="button" class="rnd" data-share aria-label="Share">${icon("share")}</button></div>
      <section class="card pf-card">
        <div class="pf-who">${avatar({ name: u.name, color: u.color })}<div><h2>${u.name || "You"}</h2><p>${roleLabel(u.role)}, Barta Window Washing</p></div></div>
        <div class="pf-k">${soldHeading(s)}</div>
        <div class="pf-big num">${dollars(s.sold_cents)}</div>
        ${s.sold_cents ? html`<p class="muted">${s.count === 1 ? "1 sale" : `${s.count} sales`}</p>` : html`<p class="muted">Nothing sold ${s.period === "week" ? "this week" : s.period === "year" ? "this year" : "this month"}</p>`}
        ${sparkline(s.series)}
        <div class="pf-axis"><span>${shortDay(s.from)}</span><span>Today</span></div>
        <div class="pf-tiles">
          <div><span>Jobs</span><b class="num">${dollars(s.jobs.cents)}</b><small>${s.jobs.count} sold</small></div>
          <div><span>Plans</span><b class="num">${dollars(s.plans.cents)}</b><small>${s.plans.count === 1 ? "1 plan" : `${s.plans.count} plans`}</small></div>
          <div><span>Average job</span><b class="num">${s.avg_cents === null ? "-" : dollars(s.avg_cents)}</b><small>${dollars(s.arr_cents)} ARR</small></div>
        </div>
      </section>
      <section class="card pf-streak"><div class="pf-k">Streak</div><div class="pf-days">${s.streak.days === 1 ? "1 day" : `${s.streak.days} days`}</div>
        <div class="pf-grid" role="img" ${attrs({ "aria-label": `${s.streak.with_sale} of ${grid.length} days with a sale` })}>${grid.map((g) => html`<i ${attrs({ class: g.sale ? "on" : "", title: g.d })}></i>`)}</div>
        <p class="muted small">${s.streak.with_sale} of ${grid.length} ${grid.length === 1 ? "day" : "days"} with a sale</p></section>
    </div>`;
  },
  events: {
    "change [data-period]": (e, el, ctx) => { ctx.keep.period = el.value; ctx.refresh(); },
    "click [data-share]": async (e, el, ctx) => {
      const s = ctx.state;
      const text = `${soldHeading(s)}: ${dollars(s.sold_cents)} (${s.count} ${s.count === 1 ? "sale" : "sales"}), jobs ${dollars(s.jobs.cents)}, plans ${dollars(s.plans.cents)}. Streak: ${s.streak.days} ${s.streak.days === 1 ? "day" : "days"}.`;
      try {
        if (navigator.share) { await navigator.share({ title: "My performance", text }); return; }
        await navigator.clipboard.writeText(text);
        toast("Copied. Paste it anywhere.");
      } catch (err) { if (!err || err.name !== "AbortError") toast("Couldn't share from this browser.", { bad: true }); }
    },
  },
};
