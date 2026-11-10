// Schedule (design §9.2): Day (a tech switcher and the day's visits and
// timed tasks in time order, with their warnings), Week (each person's
// visits per day: who is busy), List (the next two weeks as an agenda) and
// To book (the tray: jobs waiting for a visit, plan visits and takedowns
// due by the month). Tap a visit to open it; Book from the tray; the
// route and the rain-day move from the day.

import { html, icon, attrs, toast } from "../../core/ui.js";
import { dateShort, plural } from "../../core/format.js";
import {
  ensureStyles, officeView, today, addDays, weekStart, dowShort, dayNum, dayLabel, isDate, slotText, range, visitPill, faces, names, loadUsers, team,
  kindLabel, scheduleSheet, emptyCard, toMin,
} from "./office-kit.js";

const VIEWS = [["day", "Day"], ["week", "Week"], ["list", "List"], ["tray", "To book"]];
const DEAD = ["cancelled", "no_access"];

async function fetchView(ctx, s) {
  if (s.view === "tray") {
    const r = await ctx.api(`/schedule/unscheduled?month=${s.month}`, { cache: false });
    s.tray = r.data;
    return;
  }
  if (!s.date) {
    // no day asked for: the server's today (the phone's clock may be off)
    const r = await ctx.api("/schedule", { cache: false });
    s.date = r.data.from || today();
    if (s.view === "day") { s.data = r.data; return; }
  }
  const [from, to] = s.view === "day" ? [s.date, s.date] : s.view === "week" ? [weekStart(s.date), addDays(weekStart(s.date), 6)] : [s.date, addDays(s.date, 13)];
  const r = await ctx.api(`/schedule?from=${from}&to=${to}`, { cache: false });
  s.data = { ...r.data, from, to };
}

async function load(params, ctx) {
  ensureStyles();
  if (!officeView()) return { denied: true };
  const q = new URLSearchParams((location.hash.split("?")[1]) || "");
  const k = ctx.keep;
  const s = {
    view: VIEWS.some(([v]) => v === q.get("view")) ? q.get("view") : k.view || "day", date: isDate(q.get("date")) ? q.get("date") : k.date || null, tech: k.tech || null,
    month: k.month || today().slice(0, 7), users: team(await loadUsers(ctx).catch(() => [])), data: null, tray: null,
  };
  await fetchView(ctx, s);
  return s;
}

const keep = (ctx) => { const s = ctx.state; Object.assign(ctx.keep, { view: s.view, date: s.date, tech: s.tech, month: s.month }); };
async function reload(ctx) {
  keep(ctx);
  try { await fetchView(ctx, ctx.state); } catch (e) { toast(e.message, { bad: true }); }
  ctx.rerender();
}

// ------------------------------------------------------------ pieces

const warnBadge = (w) => (w && w.length ? html`<span class="pill amber" ${attrs({ title: w.map((x) => x.message).join(" ") })}>${icon("bell")}${w.length}</span>` : "");

function visitRow(s, v) {
  const w = (s.data.warnings || {})[v.id];
  const t0 = v.do ? "Day" : v.s;
  return html`<li><a class="row wk-visit ${DEAD.includes(v.st) ? "dead" : ""}" href="${"#/visits/" + encodeURIComponent(v.id)}">
    <span class="wk-time num">${v.do ? html`<b>Any</b>` : html`<b>${t0}</b><small>${v.e}</small>`}</span>
    <span class="who"><span class="nm">${v.cn || "Customer"}</span><span class="sub">${[v.town, v.t || v.jn].filter(Boolean).join(" · ")}</span>
      <span class="sub">${slotText(v)}</span></span>
    <span class="end wk-end">${faces(s.users, v.a)}${v.st === "scheduled" ? warnBadge(w) : visitPill(v.st)}</span>
  </a></li>`;
}

function taskRow(t) {
  return html`<li><a class="row wk-task" href="${"#/tasks/" + encodeURIComponent(t.id)}">
    <span class="wk-time num"><b>${t.start}</b><small>${t.end}</small></span>
    <span class="who"><span class="nm">${t.title || "Busy"}</span><span class="sub">${t.kind === "estimate_visit" ? "Estimate visit" : t.kind === "meeting" ? "Meeting" : "Personal"}${t.cn ? ` · ${t.cn}` : ""}</span></span>
    <span class="end"><span class="pill">${icon("clock")}Task</span></span>
  </a></li>`;
}

function dayItems(s, date) {
  const mine = (a) => !s.tech || (a || []).includes(s.tech);
  const visits = (s.data.visits || []).filter((v) => v.d === date && mine(v.a));
  const tasks = (s.data.tasks || []).filter((t) => t.date === date && mine(t.a));
  return [...visits.map((v) => ({ k: "v", at: v.do ? "00:00" : v.s, v })), ...tasks.map((t) => ({ k: "t", at: t.start, t }))]
    .sort((a, b) => a.at.localeCompare(b.at) || (a.k === "v" ? -1 : 1));
}

function techChips(s) {
  return html`<div class="chips" role="tablist" aria-label="Who">
    <button type="button" class="chip" ${attrs({ "data-tech": "", "aria-pressed": String(!s.tech) })}>Everyone</button>
    ${s.users.map((u) => html`<button type="button" class="chip" ${attrs({ "data-tech": u.id, "aria-pressed": String(s.tech === u.id) })}><span class="wk-dot" ${attrs({ style: `background:${u.color || "#4a4a52"}` })}></span>${String(u.name || "").split(/\s+/)[0]}</button>`)}
  </div>`;
}

function dayView(s) {
  const items = dayItems(s, s.date);
  const live = items.filter((x) => x.k === "v" && !DEAD.includes(x.v.st));
  return html`
    <div class="daybar"><button type="button" class="icon-btn" data-day="-1" aria-label="Day before">${icon("back")}</button><span class="d">${dayLabel(s.date)}</span><button type="button" class="icon-btn" data-day="1" aria-label="Next day"><span class="flip">${icon("back")}</span></button></div>
    ${techChips(s)}
    ${items.length ? html`<ul class="list">${items.map((x) => (x.k === "v" ? visitRow(s, x.v) : taskRow(x.t)))}</ul>` : emptyCard("Nothing booked", s.tech ? `${names(s.users, [s.tech])} has nothing this day.` : "No visits or estimate visits this day.")}
    <p class="small muted wk-count">${plural(live.length, "visit")}${s.tech ? ` for ${names(s.users, [s.tech])}` : ""}</p>
    <div class="btn-row">
      ${s.tech ? html`<a class="btn" href="${`#/schedule/route/${s.date}/${encodeURIComponent(s.tech)}`}">${icon("map")}Route</a>` : ""}
      <a class="btn" href="${`#/schedule/move-day?date=${s.date}`}">${icon("sun")}Rain day</a>
      <a class="btn" href="#/schedule/time-off">${icon("clock")}Time off</a>
      ${s.date !== today() ? html`<button type="button" class="btn" data-day="today">Today</button>` : ""}
    </div>`;
}

function weekView(s) {
  const start = weekStart(s.date);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const visits = (s.data.visits || []).filter((v) => !DEAD.includes(v.st));
  const count = (uid, d) => visits.filter((v) => v.d === d && (uid ? (v.a || []).includes(uid) : !(v.a || []).length)).length;
  const people = s.users.filter((u) => u.is_technician || visits.some((v) => (v.a || []).includes(u.id)));
  const nobody = days.some((d) => count(null, d));
  const cell = (uid, d) => {
    const n = count(uid, d);
    return html`<td><button type="button" class="${"wk-cell" + (n ? " on" : "") + (d === today() ? " today" : "")}" ${attrs({ "data-goday": d, "data-gotech": uid || "", "aria-label": `${n} on ${dateShort(d)}` })}>${n || ""}</button></td>`;
  };
  return html`
    <div class="daybar"><button type="button" class="icon-btn" data-week="-1" aria-label="Week before">${icon("back")}</button><span class="d">${dateShort(start)} – ${dateShort(days[6])}</span><button type="button" class="icon-btn" data-week="1" aria-label="Next week"><span class="flip">${icon("back")}</span></button></div>
    <div class="card wk-weekcard"><table class="wk-week">
      <thead><tr>${days.map((d) => html`<th scope="col" class="${d === today() ? "today" : ""}"><span>${dowShort(d).slice(0, 2)}</span><b class="num">${dayNum(d)}</b></th>`)}</tr></thead>
      ${people.map((u) => html`<tbody><tr class="wk-wname"><th scope="rowgroup" colspan="7"><span class="wk-dot" ${attrs({ style: `background:${u.color || "#4a4a52"}` })}></span>${u.name}</th></tr><tr>${days.map((d) => cell(u.id, d))}</tr></tbody>`)}
      ${nobody ? html`<tbody><tr class="wk-wname"><th scope="rowgroup" colspan="7" class="muted">Nobody yet</th></tr><tr>${days.map((d) => cell(null, d))}</tr></tbody>` : ""}
    </table></div>
    <p class="small muted wk-count">${plural(visits.length, "visit")} this week. Tap a day to open it.</p>`;
}

function listView(s) {
  const days = Array.from({ length: 14 }, (_, i) => addDays(s.data.from || s.date, i));
  const withAny = days.filter((d) => dayItems(s, d).length);
  return html`${techChips(s)}
    ${withAny.length ? withAny.map((d) => html`<div class="section-h">${dayLabel(d)}</div><ul class="list">${dayItems(s, d).map((x) => (x.k === "v" ? visitRow(s, x.v) : taskRow(x.t)))}</ul>`)
    : emptyCard("Nothing in the next two weeks", "Book visits from a job, or from To book.")}`;
}

function trayView(s) {
  const t = s.tray || { jobs: [], later: 0 };
  const monthName = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", year: "numeric" }).format(new Date(s.month + "-15T12:00:00Z"));
  const shift = (n) => { const [y, m] = s.month.split("-").map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); };
  return html`
    <div class="daybar"><button type="button" class="icon-btn" ${attrs({ "data-month": shift(-1), "aria-label": "Month before" })}>${icon("back")}</button><span class="d">Due by ${monthName}</span><button type="button" class="icon-btn" ${attrs({ "data-month": shift(1), "aria-label": "Next month" })}><span class="flip">${icon("back")}</span></button></div>
    ${t.jobs.length ? html`<ul class="list">${t.jobs.map((j) => html`<li class="wk-trayrow">
      <a class="row" href="${"#/jobs/" + encodeURIComponent(j.id)}"><span class="who"><span class="nm">${j.cn || "Customer"}</span><span class="sub">${j.n} · ${j.t}</span><span class="sub">${[kindLabel(j.k), j.tm ? `due ${j.tm}` : null, j.pl ? "plan visit" : null].filter(Boolean).join(" · ")}</span></span></a>
      <button type="button" class="btn primary wk-book" ${attrs({ "data-book": j.id, "data-town": "" })}>Book</button>
    </li>`)}</ul>` : emptyCard("Nothing waiting", "Jobs without a visit show up here, with plan visits and takedowns once they're due.", "check")}
    ${t.later ? html`<p class="small muted wk-count">${plural(t.later, "more job")} due after ${monthName}.</p>` : ""}`;
}

export default {
  title: "Schedule",
  load,
  // the top button books (a new job and its visit); Time off sits with the day's buttons
  action: (s, ctx) => (s.denied || !ctx.can("schedule:write") ? null : { label: "Book", run: () => ctx.go("/jobs/new?book=1") }),
  render(s) {
    if (s.denied) return html`<div class="stack"><div class="card empty"><div class="art">${icon("schedule")}</div><h2>Your day is on Today</h2><p>The full schedule is for the office.</p><div class="btn-row"><a class="btn primary" href="#/today">Open Today</a></div></div></div>`;
    return html`<div class="stack wk">
      <div class="chips" role="tablist" aria-label="View">${VIEWS.map(([k, label]) => html`<button type="button" class="chip" role="tab" ${attrs({ "data-view": k, "aria-pressed": String(s.view === k) })}>${label}</button>`)}</div>
      ${s.view === "day" ? dayView(s) : s.view === "week" ? weekView(s) : s.view === "list" ? listView(s) : trayView(s)}
      ${s.data && s.data.stale ? html`<p class="foot-note">The schedule's list is being rebuilt; a change from the last minute may be missing.</p>` : ""}
    </div>`;
  },
  events: {
    "click [data-view]": (e, el, ctx) => { ctx.state.view = el.dataset.view; reload(ctx); },
    "click [data-day]": (e, el, ctx) => { const s = ctx.state; s.date = el.dataset.day === "today" ? null : addDays(s.date, Number(el.dataset.day)); reload(ctx); },
    "click [data-week]": (e, el, ctx) => { const s = ctx.state; s.date = addDays(s.date, 7 * Number(el.dataset.week)); reload(ctx); },
    "click [data-month]": (e, el, ctx) => { ctx.state.month = el.dataset.month; reload(ctx); },
    "click [data-tech]": (e, el, ctx) => { ctx.state.tech = el.dataset.tech || null; keep(ctx); ctx.rerender(); },
    "click [data-goday]": (e, el, ctx) => { const s = ctx.state; s.date = el.dataset.goday; s.tech = el.dataset.gotech || null; s.view = "day"; reload(ctx); },
    "click [data-book]": (e, el, ctx) => {
      scheduleSheet(ctx, { job_id: el.dataset.book, title: "Book a visit", onDone: () => reload(ctx) });
    },
  },
};

export { toMin, range };
