// Plan visits due (design §9.2 "Plan visits due", B12): the visits due this
// month (or by the month picked) that have no visit booked yet, grouped by
// town so a day in one town fills up. Tap Book to open the job and its
// book sheet.

import { html, attrs } from "../../core/ui.js";
import { ensureStyles, monthLabel, thisMonth, emptyCard } from "./kit.js";

async function load(params, ctx) {
  ensureStyles();
  const month = ctx.keep.month || thisMonth();
  const r = await ctx.api(`/plans/due?month=${encodeURIComponent(month)}`, { cache: false });
  return { month, visits: (r.data && r.data.visits) || [] };
}

const nextMonth = (m) => { const [y, mo] = m.split("-").map(Number); return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`; };

export default {
  title: "Plan visits to book",
  load,
  render(s) {
    const cur = thisMonth();
    const towns = [...new Set(s.visits.map((v) => v.town || "Town not set"))];
    return html`<div class="stack">
      <div class="chips" role="tablist">${[cur, nextMonth(cur)].map((m) => html`<button type="button" class="chip" ${attrs({ "data-month": m, "aria-pressed": String(s.month === m) })}>By ${monthLabel(m)}</button>`)}</div>
      ${s.visits.length ? towns.map((t) => html`<p class="pl-town">${t}</p><ul class="list">${s.visits.filter((v) => (v.town || "Town not set") === t).map((v) => html`<li>${v.job_id
        ? html`<a class="row" href="${"#/jobs/" + encodeURIComponent(v.job_id)}"><span class="who"><span class="nm">${v.contact_name || "No name"}</span><span class="sub">${v.plan_name} · visit ${v.n} · due ${monthLabel(v.target_month)}${v.overdue ? " (overdue)" : ""}</span></span><span class="end"><span class="pill ${v.overdue ? "red" : "amber"}">Book</span><span class="chev" aria-hidden="true"></span></span></a>`
        : html`<a class="row" href="${"#/plans/" + encodeURIComponent(v.plan_id)}"><span class="who"><span class="nm">${v.contact_name || "No name"}</span><span class="sub">${v.plan_name} · visit ${v.n} · its job is on the way</span></span><span class="chev" aria-hidden="true"></span></a>`}</li>`)}</ul>`)
        : emptyCard("Nothing to book", `Every plan visit due by ${monthLabel(s.month)} is on the schedule.`)}
    </div>`;
  },
  events: {
    "click [data-month]": (e, el, ctx) => { ctx.keep.month = el.dataset.month; ctx.refresh(); },
  },
};
