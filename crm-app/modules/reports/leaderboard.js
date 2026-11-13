// Leaderboard (the Nov 2026 layout, after Rotor's): who sold the most,
// today, this week, this month or this year, by sales, sold revenue,
// average sale, agreements signed, plans on autopay, or for the crew (Techs:
// jobs finished and their amount). A podium for the top three, then every
// rep with their sales and how many of their plans are signed; you are
// outlined in coral. From the CRM's own quotes and plans (imported Rotor
// records too): GET /leaderboard (reports.leaderboard).

import { html, attrs } from "../../core/ui.js";
import { money } from "../../core/format.js";
import { ensureStyles, avatar, PERIOD_LABEL } from "./kit.js";

export const METRICS = [["sales", "Sales"], ["revenue", "Revenue"], ["avg", "Avg"], ["agreements", "Agreements"], ["autopay", "Auto-pay"], ["techs", "Techs"]];
const dollars = (c) => money(c || 0).replace(/\.00$/, "");
export const valueText = (metric, p) => (["revenue", "avg", "techs"].includes(metric) ? dollars(p.value) : String(p.value || 0));
export function subText(metric, p) {
  if (metric === "techs") return `${p.jobs === 1 ? "1 job" : `${p.jobs} jobs`} · ${p.visits === 1 ? "1 visit" : `${p.visits} visits`}`;
  const s = `${p.sales} ${p.sales === 1 ? "sale" : "sales"}`;
  return p.signed_pct === null || p.signed_pct === undefined ? s : `${s} · ${p.signed_pct}% signed`;
}

export default {
  title: "Leaderboard",
  async load(params, ctx) {
    ensureStyles();
    const metric = ctx.keep.metric || "revenue";
    const period = ctx.keep.period || "month";
    const r = await ctx.api(`/leaderboard?metric=${metric}&period=${period}`, { cache: false });
    return { ...r.data, metric, period };
  },
  render(s) {
    const people = s.people || [];
    const top = people.slice(0, 3);
    const podium = [top[1], top[0], top[2]].map((p, i) => (p ? { p, place: [2, 1, 3][i] } : null));
    return html`<div class="stack rp-page">
      <div class="rp-bar">
        <label class="rp-sel"><span class="sr">Period</span><select data-period>${Object.entries(PERIOD_LABEL).map(([k, l]) => html`<option ${attrs({ value: k, selected: s.period === k })}>${l}</option>`)}</select></label>
      </div>
      <div class="chips rp-chips" role="group" aria-label="Measure">${METRICS.map(([k, l]) => html`<button type="button" class="chip" ${attrs({ "data-metric": k, "aria-pressed": String(s.metric === k) })}>${l}</button>`)}</div>
      ${people.length ? html`<div class="rp-podium">${podium.map((x) => (x ? html`<div ${attrs({ class: "rp-step p" + x.place })}>
        ${avatar(x.p, "big ring" + x.place)}<span class="rp-who">${x.p.first_name || x.p.name}</span><b class="num">${valueText(s.metric, x.p)}</b>
        <span class="rp-block">${String(x.place)}</span></div>` : html`<div class="rp-step empty"></div>`))}</div>` : ""}
      <div class="section-h rp-h">${s.metric === "techs" ? "The crew" : "All reps"}</div>
      <ol class="rp-list">${[...people, ...(s.unassigned && (s.unassigned.value || s.unassigned.sales || s.unassigned.jobs) ? [s.unassigned] : [])].map((p) => html`<li ${attrs({ class: "rp-row" + (p.id && p.id === s.me ? " me" : "") })}>
        <span class="rp-rank">${String(p.rank)}</span>${avatar(p)}
        <span class="who"><span class="nm">${p.name}${p.id && p.id === s.me ? " · You" : ""}</span><span class="sub">${subText(s.metric, p)}</span></span>
        <b class="num rp-v">${valueText(s.metric, p)}</b></li>`)}</ol>
      ${people.length ? "" : html`<div class="card empty"><h2>No one on the board yet</h2><p>Sales show here once quotes are approved.</p></div>`}
    </div>`;
  },
  events: {
    "click [data-metric]": (e, el, ctx) => { ctx.keep.metric = el.dataset.metric; ctx.refresh(); },
    "change [data-period]": (e, el, ctx) => { ctx.keep.period = el.value; ctx.refresh(); },
  },
};
