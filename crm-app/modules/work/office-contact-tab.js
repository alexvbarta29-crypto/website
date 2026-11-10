// The contact's Work tab (design §9.2 Contact → Work): the next visits,
// the open jobs (and the ones done before), recent visits, and New job.
// A contact tab renders inside the Contact screen: everything here is a
// link to a work screen.

import { html, icon } from "../../core/ui.js";
import { money, dateShort } from "../../core/format.js";
import { ensureStyles, officeView, slotText, visitPill, jobPill, kindLabel } from "./office-kit.js";

const OPEN = ["unscheduled", "scheduled", "in_progress"];

export default {
  async load(params, ctx) {
    ensureStyles();
    if (!officeView()) return { denied: true };
    return (await ctx.api(`/work/contacts/${encodeURIComponent(params.id)}`, { cache: false })).data;
  },
  render(s, ctx) {
    if (s.denied) return html`<div class="card empty"><h2>Not for this login</h2><p>Jobs are for the office.</p></div>`;
    const id = encodeURIComponent(s.contact.id);
    const open = (s.jobs || []).filter((j) => OPEN.includes(j.status));
    const closed = (s.jobs || []).filter((j) => !OPEN.includes(j.status)).slice(0, 10);
    const vrow = (v) => html`<li><a class="row" href="${"#/visits/" + encodeURIComponent(v.id)}"><span class="who"><span class="nm">${dateShort(v.date)}</span><span class="sub">${slotText(v)}${v.job_title ? ` · ${v.job_title}` : ""}</span></span><span class="end">${visitPill(v.status)}<span class="chev" aria-hidden="true"></span></span></a></li>`;
    const jrow = (j) => html`<li><a class="row" href="${"#/jobs/" + encodeURIComponent(j.id)}"><span class="who"><span class="nm">${j.title}</span><span class="sub">${[j.number_label, j.kind !== "standard" ? kindLabel(j.kind) : null, j.status === "unscheduled" && j.target_month ? `due ${j.target_month}` : null, j.completed_at ? `done ${dateShort(j.completed_at)}` : null].filter(Boolean).join(" · ")}</span></span>
      <span class="end">${j.totals ? html`<span class="small num">${money(j.totals.total_cents)}</span>` : ""}${jobPill(j.status)}</span></a></li>`;
    return html`<div class="stack">
      ${ctx && ctx.can && ctx.can("schedule:write") ? html`<div class="btn-row"><a class="btn primary" href="${"#/jobs/new/" + id}">${icon("plus")}New job</a></div>` : ""}
      <div class="section-h">Coming up</div>
      ${(s.upcoming || []).length ? html`<ul class="list">${s.upcoming.map(vrow)}</ul>` : html`<p class="muted small">No visit booked.</p>`}
      <div class="section-h">Open jobs</div>
      ${open.length ? html`<ul class="list">${open.map(jrow)}</ul>` : html`<p class="muted small">No open job.</p>`}
      ${(s.past || []).length ? html`<div class="section-h">Recent visits</div><ul class="list">${s.past.slice(0, 8).map(vrow)}</ul>` : ""}
      ${closed.length ? html`<div class="section-h">Done and cancelled</div><ul class="list">${closed.map(jrow)}</ul>` : ""}
    </div>`;
  },
};
