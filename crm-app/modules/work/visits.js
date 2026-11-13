// Visits (the Nov 2026 layout, after Rotor's Visits screen; in the Menu,
// and a place a person may put on their tab bar): one day's visits as
// cards, a coral day header with the count, each card with the customer,
// which visit of the job it is (n/m), the time, how long the crew worked,
// the amount, a red $ while it is unpaid, and the status (Not started, In
// progress, Finished). The day moves with the arrows; GET /visits?date=.

import { html, icon, attrs } from "../../core/ui.js";
import { money, dateShort, clock } from "../../core/format.js";
import { ensureStyles as officeStyles, addDays } from "./office-kit.js";

let styled = false;
function ensureStyles() {
  officeStyles();
  if (styled || typeof document === "undefined") return;
  styled = true;
  const l = document.createElement("link");
  l.rel = "stylesheet";
  l.href = "/crm-app/modules/work/visit-styles.css";
  document.head.appendChild(l);
}

const STATUS = {
  scheduled: ["Not started", "grey"], en_route: ["On the way", "blue"], in_progress: ["In progress", "blue"], paused: ["Paused", "amber"],
  completed: ["Finished", "green"], no_access: ["No access", "red"], cancelled: ["Cancelled", "grey"],
};
const worked = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`);

export function visitCard(v) {
  const [label, tone] = STATUS[v.status] || [v.status, "grey"];
  return html`<li><a class="vl-card" ${attrs({ href: "#/visits/" + encodeURIComponent(v.id) })}>
    <span class="vl-top"><span class="vl-name">${v.contact_name || "Customer"}</span>${v.unpaid ? html`<span class="vl-due" title="Not paid yet" aria-label="Not paid yet">$</span>` : ""}<span ${attrs({ class: "vl-st " + tone })}>${label}</span></span>
    <span class="vl-mid"><span class="vl-n">${`${v.n}/${v.m}`}</span>${v.plan ? html`<span class="vl-plan">Plan</span>` : ""}${v.job_title ? html`<span class="vl-job">${v.job_title}</span>` : ""}</span>
    <span class="vl-bot"><span>${v.date_only || !v.start ? "Any time" : clock(v.start)}</span>${v.minutes ? html`<span class="vl-time">${icon("clock")}${worked(v.minutes)}</span>` : ""}${v.amount_cents ? html`<b class="num">${money(v.amount_cents).replace(/\.00$/, "")}</b>` : ""}</span>
  </a></li>`;
}

export default {
  title: "Visits",
  async load(params, ctx) {
    ensureStyles();
    // the server's today unless a day was picked (a phone's clock may be off)
    const r = await ctx.api(`/visits${ctx.keep.date ? `?date=${encodeURIComponent(ctx.keep.date)}` : ""}`);
    return { ...r.data, offline: !!r.offline };
  },
  render(s) {
    const head = s.date === s.today ? "Today" : s.date === addDays(s.today, 1) ? "Tomorrow" : s.date === addDays(s.today, -1) ? "Yesterday" : dateShort(s.date);
    const n = (s.visits || []).length;
    return html`<div class="stack vl-page">
      ${s.offline ? html`<div class="note">Offline: the last copy on this phone.</div>` : ""}
      <div class="vl-day"><button type="button" class="rnd" data-day="-1" aria-label="The day before">${icon("back")}</button>
        <h2 class="vl-h">${head}<span>${n === 1 ? "1 visit" : `${n} visits`}</span></h2>
        <button type="button" class="rnd" data-day="1" aria-label="The day after"><span class="flip">${icon("back")}</span></button></div>
      ${n ? html`<ul class="vl-list">${s.visits.map(visitCard)}</ul>` : html`<div class="card empty"><div class="art">${icon("truck")}</div><h2>No visits ${head === "Today" ? "today" : "that day"}</h2><p>Booked visits show here, in time order.</p></div>`}
    </div>`;
  },
  events: {
    "click [data-day]": (e, el, ctx) => { ctx.keep.date = addDays(ctx.state.date, Number(el.dataset.day)); ctx.refresh(); },
  },
};
