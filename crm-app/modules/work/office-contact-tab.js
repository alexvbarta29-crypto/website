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
// On a phone (ctx.phone; Rotor's phone app, Nov 15): SCHEDULED JOBS is one
// list by date (the last two done, then the booked ones: a calendar, the
// date and the job's number, the pill, the $), PENDING JOBS reads the month
// in italics with its Pending pill and $, a red Schedule on the next one and
// a round "..." on the others; a long press on any of them (or that "...")
// opens Schedule and Delay (the contact page's sheet: data-pend-hold,
// data-pend-more).

import { html, icon, pillBtn, statusPill, rnd, attrs } from "../../core/ui.js";
import { money, dateShort, dateYear, localDate } from "../../core/format.js";
import { ensureStyles, officeView, slotText, visitPill, jobPill, kindLabel, addDays } from "./office-kit.js";
import { isoFromLocal } from "./tech-kit.js";

const OPEN = ["unscheduled", "scheduled", "in_progress"];
const planPill = html`<span class="pill green">Plan</span>`;
const avg = (list) => { const v = list.map((j) => j.totals && j.totals.total_cents).filter(Number.isSafeInteger); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null; };

// The Service tab's tiles (Rotor's): Scheduled jobs x/y, Avg completed job, Avg future job (pure).
export function workTiles(jobs = []) {
  const live = jobs.filter((j) => j.status !== "cancelled");
  const booked = live.filter((j) => j.status === "scheduled" || j.status === "in_progress");
  const done = live.filter((j) => j.status === "completed");
  const future = live.filter((j) => OPEN.includes(j.status));
  const a = avg(done), b = avg(future);
  return [
    { key: "jobs", label: "Scheduled jobs", value: `${booked.length}/${live.length}` },
    { key: "avg_done", label: "Avg completed job", value: a === null ? "-" : money(a).replace(/\.00$/, "") },
    { key: "avg_future", label: "Avg future job", value: b === null ? "-" : money(b).replace(/\.00$/, "") },
  ];
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthText = (m) => (/^\d{4}-\d{2}$/.test(String(m || "")) ? `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}` : "");
const amount = (j) => (j && j.totals && Number.isSafeInteger(j.totals.total_cents) ? money(j.totals.total_cents).replace(/\.00$/, "") : "");
// Rotor's Pending Jobs row: the month it is due, a Pending pill, the job; its $, Delay and Schedule (the job's page books it).
const pendingRow = (j, write) => html`<li class="ct-pend"><a class="row" href="${"#/jobs/" + encodeURIComponent(j.id)}"><span class="who"><span class="nm ct-when">${icon("cal")}${monthText(j.target_month) || "Not booked"}${statusPill("Pending", "blue")}</span><span class="sub">${[j.number_label, j.title].filter(Boolean).join(" · ")}</span></span><span class="end">${amount(j) ? html`<span class="num">${amount(j)}</span>` : ""}</span></a>
  ${write ? html`<span class="ct-pend-acts">${pillBtn("Delay", { icon: "clock", data: { "job-delay": j.id }, aria: `Delay ${j.title || "this job"}` })}${pillBtn("Schedule", { tone: "red", href: "#/jobs/" + encodeURIComponent(j.id), aria: `Schedule ${j.title || "this job"}` })}</span>` : ""}</li>`;

// Rotor's phone rows (pure html): a visit by its date, and a job to book by its month.
export const phoneVisitRow = (v, jobs = []) => {
  const j = jobs.find((x) => x.id === v.job_id);
  return html`<li><a class="row ct-jr" href="${"#/visits/" + encodeURIComponent(v.id)}"><span class="ico">${icon("cal")}</span>
    <span class="who"><span class="nm">${dateYear(v.date)}</span><span class="sub">${[v.job_number || (j && j.number_label), v.plan_id ? "Plan" : null].filter(Boolean).join(" · ") || slotText(v)}</span></span>
    <span class="end">${visitPill(v.status)}${amount(j) ? html`<span class="num ct-jr-a">${amount(j)}</span>` : ""}</span></a></li>`;
};
export const phonePendingRow = (j, write, first) => html`<li ${attrs({ class: "ct-pj", "data-hold": "", "data-pend-hold": j.id })}><a class="row" href="${"#/jobs/" + encodeURIComponent(j.id)}"><span class="ico">${icon("cal")}</span>
    <span class="who"><span class="nm"><i>${monthText(j.target_month) || "Not booked"}</i></span><span class="sub ct-when">${statusPill("Pending", "blue")}${j.number_label || ""}</span></span>
    <span class="end">${amount(j) ? html`<span class="num ct-jr-a">${amount(j)}</span>` : ""}</span></a>
  ${write ? (first ? pillBtn("Schedule", { tone: "red", href: "#/jobs/" + encodeURIComponent(j.id), aria: `Schedule ${j.title || "this job"}` }) : rnd("more", `Schedule or delay ${j.title || "this job"}`, { tone: "grey", sm: true, popup: true, data: { "pend-more": j.id } })) : ""}</li>`;
// A phone's Scheduled Jobs: the last two visits done, then every booked one, by date.
export function phoneVisits(past = [], upcoming = []) {
  const done = [...past].sort((a, b) => String(a.date).localeCompare(String(b.date))).slice(-2);
  const ahead = [...upcoming].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return [...done, ...ahead];
}

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

// Rotor's Scheduled Jobs row: the date and its pill; the job and the time; the job's $ on the right.
const vrow = (v, jobs = []) => {
  const j = jobs.find((x) => x.id === v.job_id);
  return html`<li><a class="row" href="${"#/visits/" + encodeURIComponent(v.id)}"><span class="who"><span class="nm ct-when">${icon("cal")}${dateShort(v.date)}${visitPill(v.status)}</span><span class="sub">${[v.job_number || (j && j.number_label), slotText(v), v.job_title].filter(Boolean).join(" · ")}</span></span><span class="end">${v.plan_id ? planPill : ""}${amount(j) ? html`<span class="num">${amount(j)}</span>` : ""}<span class="chev" aria-hidden="true"></span></span></a></li>`;
};
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
  tiles(s) { return s && !s.denied ? workTiles(s.jobs || []) : []; },
  // The contact page's Visits card (Rotor's, Nov 2026): the next visits and the open one-time jobs, recent and
  // finished work under them, a round + to book; Book a job in the page's "...".
  cards(s, ctx) {
    if (!s || s.denied) return [];
    const open = (s.jobs || []).filter((j) => OPEN.includes(j.status) && j.status !== "unscheduled" && !j.plan_id);
    const pending = (s.jobs || []).filter((j) => j.status === "unscheduled").sort((a, b) => String(a.target_month || "9999").localeCompare(String(b.target_month || "9999")));
    const closed = (s.jobs || []).filter((j) => !OPEN.includes(j.status)).slice(0, 10);
    const up = s.upcoming || [];
    const any = up.length || open.length || (s.past || []).length || closed.length;
    // Rotor's Service tab: Scheduled Jobs, then Pending Jobs (to book: a dashed card with Delay and Schedule)
    const write = !!(ctx && ctx.can && ctx.can("schedule:write"));
    const jobs = s.jobs || [];
    const phone = !!(ctx && ctx.phone);
    const out = pending.length ? [{ key: "pending", tab: "service", title: `Pending Jobs (${pending.length})`, cls: phone ? null : "ct-pending", body: html`<ul class="list">${pending.map((j, i) => (phone ? phonePendingRow(j, write, i === 0) : pendingRow(j, write)))}</ul>` }] : [];
    if (phone) {
      const list = phoneVisits(s.past || [], up);
      return [{ key: "visits", tab: "service", title: "Scheduled Jobs", empty: "No visit booked",
        add: write ? { label: "Book a job", short: "New Job", href: "#/jobs/new/" + encodeURIComponent(s.contact.id) } : null,
        body: list.length || open.length || closed.length ? html`${list.length ? html`<ul class="list">${list.map((v) => phoneVisitRow(v, jobs))}</ul>` : html`<p class="rs-empty">No visit booked</p>`}
          ${open.length ? html`<h4 class="ct-sub-h">One-time jobs</h4><ul class="list">${open.map(jrow)}</ul>` : ""}
          ${closed.length ? html`<h4 class="ct-sub-h">Done and cancelled</h4><ul class="list">${closed.map(jrow)}</ul>` : ""}` : null }, ...out];
    }
    return [{ key: "visits", tab: "service", title: "Scheduled Jobs", count: up.length ? (up.length === 1 ? "1 coming up" : `${up.length} coming up`) : null, empty: "No visit booked",
      add: write ? { label: "Book a job", short: "New Job", href: "#/jobs/new/" + encodeURIComponent(s.contact.id) } : null,
      body: any ? html`${up.length ? html`<ul class="list">${up.map((v) => vrow(v, jobs))}</ul>` : html`<p class="rs-empty">No visit booked</p>`}
        ${open.length ? html`<h4 class="ct-sub-h">One-time jobs</h4><ul class="list">${open.map(jrow)}</ul>` : ""}
        ${(s.past || []).length ? html`<h4 class="ct-sub-h">Recent visits</h4><ul class="list">${s.past.slice(0, 8).map((v) => vrow(v, jobs))}</ul>` : ""}
        ${closed.length ? html`<h4 class="ct-sub-h">Done and cancelled</h4><ul class="list">${closed.map(jrow)}</ul>` : ""}` : null }, ...out];
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
      ${(s.upcoming || []).length ? html`<ul class="list">${s.upcoming.map((v) => vrow(v, s.jobs || []))}</ul>` : html`<p class="muted small">No visit booked.</p>`}
      <div class="section-h">${section ? "One-time jobs" : "Open jobs"}</div>
      ${open.length ? html`<ul class="list">${open.map(jrow)}</ul>` : html`<p class="muted small">No open one-time job.</p>`}
      ${(s.past || []).length ? html`<div class="section-h">Recent visits</div><ul class="list">${s.past.slice(0, 8).map((v) => vrow(v, s.jobs || []))}</ul>` : ""}
      ${closed.length ? html`<div class="section-h">Done and cancelled</div><ul class="list">${closed.map(jrow)}</ul>` : ""}
    </div>`;
  },
};
