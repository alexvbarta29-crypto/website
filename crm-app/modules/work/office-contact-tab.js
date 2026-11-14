// The contact's work (design §9.2 Contact → Work; on the contact page since
// the Nov 2026 layout, the "Upcoming visits" section): the next visits (a
// plan's marked as such), the open one-time jobs (a plan's jobs live with
// the plan, the "Service plan" section), recent visits, and New job. It
// renders inside the Contact screen: everything here is a link to a work
// screen. It also tells the contact page the next visit (header) and the
// visit reminders still to go out (queued: the automations' own schedule,
// 10:00 two weeks and two days before; Settings → Automations can change
// them). cards() and actions(): the contact page's Visits card and its
// "..." row, Book a job (Nov 2026, Rotor's lead and customer pages).

import { html, icon } from "../../core/ui.js";
import { money, dateShort, localDate } from "../../core/format.js";
import { ensureStyles, officeView, slotText, visitPill, jobPill, kindLabel, addDays } from "./office-kit.js";
import { isoFromLocal } from "./tech-kit.js";

const OPEN = ["unscheduled", "scheduled", "in_progress"];
const planPill = html`<span class="pill green">Plan</span>`;

// The visit reminders (work automations visit.reminder_14d and _2d) still to
// come for the booked visits, at their default 10:00. → [{ at, label, sub, href }]
export function remindersAhead(upcoming = [], now = new Date()) {
  const out = [];
  const today = localDate(now);
  for (const v of upcoming) {
    if (!v || v.status !== "scheduled" || !v.date) continue;
    for (const [days, label] of [[14, "Visit reminder, 2 weeks before"], [2, "Visit reminder, 2 days before"]]) {
      const day = addDays(v.date, -days);
      if (day < today) continue;
      const at = isoFromLocal(day, "10:00");
      if (Date.parse(at) <= now.getTime()) continue;
      out.push({ at, label, sub: `for ${dateShort(v.date)}`, href: "#/visits/" + encodeURIComponent(v.id), icon: "text" });
    }
  }
  return out;
}

const vrow = (v) => html`<li><a class="row" href="${"#/visits/" + encodeURIComponent(v.id)}"><span class="who"><span class="nm">${dateShort(v.date)}</span><span class="sub">${slotText(v)}${v.job_title ? ` · ${v.job_title}` : ""}</span></span><span class="end">${v.plan_id ? planPill : ""}${visitPill(v.status)}<span class="chev" aria-hidden="true"></span></span></a></li>`;
const jrow = (j) => html`<li><a class="row" href="${"#/jobs/" + encodeURIComponent(j.id)}"><span class="who"><span class="nm">${j.title}</span><span class="sub">${[j.number_label, j.kind !== "standard" ? kindLabel(j.kind) : null, j.status === "unscheduled" && j.target_month ? `due ${j.target_month}` : null, j.completed_at ? `done ${dateShort(j.completed_at)}` : null].filter(Boolean).join(" · ")}</span></span>
  <span class="end">${j.totals ? html`<span class="small num">${money(j.totals.total_cents)}</span>` : ""}${j.plan_id ? planPill : ""}${jobPill(j.status)}</span></a></li>`;

export default {
  async load(params, ctx) {
    ensureStyles();
    if (!officeView()) return { denied: true };
    return (await ctx.api(`/work/contacts/${encodeURIComponent(params.id)}`, { cache: false })).data;
  },
  header(s) {
    const next = (s.upcoming || []).find((v) => v.status !== "cancelled");
    return { next_visit: next ? next.date : null };
  },
  queued(s) { return remindersAhead(s.upcoming || []); },
  // The contact page's Visits card (Rotor's, Nov 2026): the next visits and the open one-time jobs, recent and
  // finished work under them, a round + to book; Book a job in the page's "...".
  cards(s, ctx) {
    if (!s || s.denied) return [];
    const open = (s.jobs || []).filter((j) => OPEN.includes(j.status) && !j.plan_id);
    const closed = (s.jobs || []).filter((j) => !OPEN.includes(j.status)).slice(0, 10);
    const up = s.upcoming || [];
    const any = up.length || open.length || (s.past || []).length || closed.length;
    return [{ key: "visits", tab: "details", title: "Visits", count: up.length ? (up.length === 1 ? "1 coming up" : `${up.length} coming up`) : null, empty: "No visit booked",
      add: ctx && ctx.can && ctx.can("schedule:write") ? { label: "Book a job", href: "#/jobs/new/" + encodeURIComponent(s.contact.id) } : null,
      body: any ? html`${up.length ? html`<ul class="list">${up.map(vrow)}</ul>` : html`<p class="rs-empty">No visit booked</p>`}
        ${open.length ? html`<h4 class="ct-sub-h">One-time jobs</h4><ul class="list">${open.map(jrow)}</ul>` : ""}
        ${(s.past || []).length ? html`<h4 class="ct-sub-h">Recent visits</h4><ul class="list">${s.past.slice(0, 8).map(vrow)}</ul>` : ""}
        ${closed.length ? html`<h4 class="ct-sub-h">Done and cancelled</h4><ul class="list">${closed.map(jrow)}</ul>` : ""}` : null }];
  },
  actions(s, ctx) {
    if (!s || s.denied || !(ctx && ctx.can && ctx.can("schedule:write"))) return [];
    return [{ key: "book", label: "Book a job", icon: "cal", href: "#/jobs/new/" + encodeURIComponent(s.contact.id), data: { book: true } }];
  },
  render(s, ctx) {
    if (s.denied) return html`<div class="card empty"><h2>Not for this login</h2><p>Jobs are for the office.</p></div>`;
    const id = encodeURIComponent(s.contact.id);
    const open = (s.jobs || []).filter((j) => OPEN.includes(j.status) && !j.plan_id);
    const closed = (s.jobs || []).filter((j) => !OPEN.includes(j.status)).slice(0, 10);
    const section = !!(ctx && ctx.section);
    return html`<div class="stack">
      ${ctx && ctx.can && ctx.can("schedule:write") ? html`<div class="btn-row"><a class="btn primary" href="${"#/jobs/new/" + id}">${icon("plus")}New job</a></div>` : ""}
      ${section ? "" : html`<div class="section-h">Coming up</div>`}
      ${(s.upcoming || []).length ? html`<ul class="list">${s.upcoming.map(vrow)}</ul>` : html`<p class="muted small">No visit booked.</p>`}
      <div class="section-h">${section ? "One-time jobs" : "Open jobs"}</div>
      ${open.length ? html`<ul class="list">${open.map(jrow)}</ul>` : html`<p class="muted small">No open one-time job.</p>`}
      ${(s.past || []).length ? html`<div class="section-h">Recent visits</div><ul class="list">${s.past.slice(0, 8).map(vrow)}</ul>` : ""}
      ${closed.length ? html`<div class="section-h">Done and cancelled</div><ul class="list">${closed.map(jrow)}</ul>` : ""}
    </div>`;
  },
};
