// Schedule (design §9.2): Month (the default: the month as a grid, Sunday
// first, each day's visits as chips in the team's colors, and the chosen
// day's list beside the grid on a computer, under it on a phone), Week
// (each person's visits per day: who is busy), Day (a tech switcher and the
// day's visits and timed tasks in time order, with their warnings), List
// (the next two weeks as an agenda) and To book (the tray: jobs waiting for
// a visit, plan visits and takedowns due by the month). Tap a visit to open
// it; Book from the tray; the route and the rain-day move from the day.
//
// The month is one read (GET /schedule?month=, the leading and trailing
// days too); picking a day inside it never reads again. Arrow keys move
// the chosen day on a computer (Page Up / Page Down a month).

import { html, icon, attrs, toast } from "../../core/ui.js";
import { dateShort, dateLong, plural, money, clock } from "../../core/format.js";
import {
  ensureStyles, officeView, today, addDays, weekStart, dow, dowShort, dayNum, dayLabel, isDate, slotText, range, visitPill, faces, names, loadUsers, team, userById,
  kindLabel, scheduleSheet, emptyCard, toMin,
} from "./office-kit.js";

const VIEWS = [["month", "Month"], ["week", "Week"], ["day", "Day"], ["list", "List"], ["tray", "To book"]];
const DEAD = ["cancelled", "no_access"];
const CHIPS = 3;                       // chips a day cell shows on a computer before "+N more"
const DOTS = 3;                        // dots a day cell shows on a phone

// ------------------------------------------------------------ the month grid

// The month view's days (US layout): the Sunday on or before the 1st to the
// Saturday on or after the last day. The server works out the same range
// (monthGridRange in office-schedule.mjs).
export function monthGrid(ym) {
  const [y, m] = ym.split("-").map(Number);
  const first = `${ym}-01`;
  const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const start = addDays(first, -dow(first));
  const end = addDays(last, 6 - dow(last));
  const days = [];
  for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);
  return { start, end, days, weeks: Array.from({ length: days.length / 7 }, (_, i) => days.slice(i * 7, i * 7 + 7)) };
}
export const shiftMonth = (ym, n) => { const [y, m] = ym.split("-").map(Number); return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7); };
const monthName = (ym) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", year: "numeric" }).format(new Date(ym + "-15T12:00:00Z"));
// "Thursday, Nov 12": the day list's head
const PANEL_DAY = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "short", day: "numeric" });
export const panelDay = (d) => PANEL_DAY.format(new Date(d + "T12:00:00Z"));
// "8a", "12:30p": a chip's time
export function shortTime(hhmm) {
  const n = toMin(hhmm);
  if (n === null) return "";
  const h = Math.floor(n / 60) % 24, mm = n % 60;
  return `${((h + 11) % 12) + 1}${mm ? ":" + String(mm).padStart(2, "0") : ""}${h < 12 ? "a" : "p"}`;
}
// "Alex W.": a chip's customer
export function shortName(name) {
  const w = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!w.length) return "Customer";
  return w.length > 1 ? `${w[0]} ${w[w.length - 1][0].toUpperCase()}.` : w[0];
}
const loaded = (s, d) => !!(s.data && s.data.kind === "month" && d >= s.data.from && d <= s.data.to);

// ------------------------------------------------------------ reads

async function fetchView(ctx, s) {
  if (s.view === "tray") {
    const r = await ctx.api(`/schedule/unscheduled?month=${s.month}`, { cache: false });
    s.tray = r.data;
    return;
  }
  if (s.view === "month") {
    // no month asked for: the server's this month, and its today chosen (the phone's clock may be off)
    if (!s.cal && s.date) s.cal = s.date.slice(0, 7);
    const r = await ctx.api(`/schedule?month=${s.cal || "now"}&amounts=1`, { cache: false });
    s.today = r.data.today || s.today;
    s.cal = r.data.month || s.cal;
    if (!s.date || !(s.date >= r.data.from && s.date <= r.data.to)) s.date = s.today && s.today.slice(0, 7) === s.cal ? s.today : `${s.cal}-01`;
    s.data = { ...r.data, kind: "month" };
    return;
  }
  if (!s.date) {
    // no day asked for: the server's today (the phone's clock may be off)
    const r = await ctx.api("/schedule", { cache: false });
    s.date = r.data.from || today();
    s.today = r.data.today || s.today;
    if (s.view === "day") { s.data = r.data; return; }
  }
  const [from, to] = s.view === "day" ? [s.date, s.date] : s.view === "week" ? [weekStart(s.date), addDays(weekStart(s.date), 6)] : [s.date, addDays(s.date, 13)];
  const r = await ctx.api(`/schedule?from=${from}&to=${to}`, { cache: false });
  s.today = r.data.today || s.today;
  s.data = { ...r.data, from, to };
}

async function load(params, ctx) {
  ensureStyles();
  if (!officeView()) return { denied: true };
  const q = new URLSearchParams((location.hash.split("?")[1]) || "");
  const k = ctx.keep;
  const asked = isDate(q.get("date")) ? q.get("date") : null;
  const s = {
    view: VIEWS.some(([v]) => v === q.get("view")) ? q.get("view") : k.view || "month",
    date: asked || k.date || null, cal: asked ? asked.slice(0, 7) : k.cal || null, tech: k.tech || null, today: k.today || null,
    month: k.month || today().slice(0, 7), users: team(await loadUsers(ctx).catch(() => [])), data: null, tray: null,
  };
  await fetchView(ctx, s);
  return s;
}

const keep = (ctx) => { const s = ctx.state; Object.assign(ctx.keep, { view: s.view, date: s.date, cal: s.cal, tech: s.tech, month: s.month, today: s.today }); };
async function reload(ctx) {
  keep(ctx);
  try { await fetchView(ctx, ctx.state); } catch (e) { toast(e.message, { bad: true }); }
  keep(ctx);
  ctx.rerender();
}
// Choose a day in the month view: no read when the grid already holds it.
function pick(ctx, d, { focus = false, scroll = false } = {}) {
  const s = ctx.state;
  s.date = d;
  s.focusDay = focus;
  s.scrollDay = scroll;
  if (loaded(s, d)) { keep(ctx); ctx.rerender(); return; }
  s.cal = d.slice(0, 7);
  reload(ctx);
}
const todayOf = (s) => s.today || today();

// ------------------------------------------------------------ pieces

const warnBadge = (w) => (w && w.length ? html`<span class="pill amber" ${attrs({ title: w.map((x) => x.message).join(" ") })}>${icon("bell")}${w.length}</span>` : "");
const colorOf = (s, ids) => { const u = userById(s.users, (ids || [])[0]); return (u && /^#[0-9a-f]{6}$/i.test(u.color || "") && u.color) || "#85858d"; };
const amount = (ctx, v) => (v.amt && ctx && ctx.can && ctx.can("visits:prices") ? html`<b class="wk-amt num">${money(v.amt).replace(/\.00$/, "")}</b>` : "");

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
  return html`<div class="chips wk-techs" role="group" aria-label="Who">
    <button type="button" class="chip" ${attrs({ "data-tech": "", "aria-pressed": String(!s.tech) })}>Everyone</button>
    ${s.users.map((u) => html`<button type="button" class="chip" ${attrs({ "data-tech": u.id, "aria-pressed": String(s.tech === u.id) })}><span class="wk-dot" ${attrs({ style: `background:${u.color || "#4a4a52"}` })}></span>${String(u.name || "").split(/\s+/)[0]}</button>`)}
  </div>`;
}

// ------------------------------------------------------------ Month

function dayCell(s, d) {
  const items = dayItems(s, d);
  const live = items.filter((x) => x.k === "t" || !DEAD.includes(x.v.st));
  const t = todayOf(s);
  const cls = ["wk-mday", d.slice(0, 7) !== s.cal ? "out" : "", d === t ? "today" : "", d === s.date ? "sel" : "", [0, 6].includes(dow(d)) ? "wkend" : ""].filter(Boolean).join(" ");
  const shown = items.length > CHIPS ? items.slice(0, CHIPS - 1) : items;
  const label = `${dateLong(d)}: ${live.length ? plural(live.length, "visit") : "nothing booked"}${d === t ? ", today" : ""}`;
  return html`<button type="button" class="${cls}" ${attrs({ "data-mday": d, "aria-pressed": String(d === s.date), "aria-current": d === t ? "date" : false, "aria-label": label, tabindex: d === s.date ? "0" : "-1" })}>
    <span class="wk-mnum num">${dayNum(d)}</span>
    <span class="wk-mchips" aria-hidden="true">${shown.map((x) => (x.k === "v"
      ? html`<span class="${"wk-mchip" + (DEAD.includes(x.v.st) ? " dead" : x.v.st === "completed" ? " done" : "")}" ${attrs({ style: `--c:${colorOf(s, x.v.a)}` })}><b class="num">${x.v.do ? "Any" : shortTime(x.v.s)}</b> ${shortName(x.v.cn)}</span>`
      : html`<span class="wk-mchip task"><b class="num">${shortTime(x.t.start)}</b> ${x.t.title || "Busy"}</span>`))}${items.length > shown.length ? html`<span class="wk-mmore">+${items.length - shown.length} more</span>` : ""}</span>
    <span class="wk-mdots" aria-hidden="true">${live.slice(0, DOTS).map((x) => html`<i ${attrs({ style: `--c:${x.k === "v" ? colorOf(s, x.v.a) : "#85858d"}` })}></i>`)}${live.length > DOTS ? html`<em class="num">+${live.length - DOTS}</em>` : ""}</span>
  </button>`;
}

function dayRow(s, v, ctx) {
  const w = (s.data.warnings || {})[v.id];
  const state = DEAD.includes(v.st) ? "dead" : v.st === "completed" ? "done" : "";
  const where = v.ad || v.town || "";
  const what = v.t || (v.svc || []).join(", ") || v.jn || "";
  return html`<li><a class="${"wk-drow" + (state ? " " + state : "")}" href="${"#/visits/" + encodeURIComponent(v.id)}">
    <span class="wk-dt num" ${attrs({ title: slotText(v) })}>${v.do ? html`<b>Anytime</b><small>Time not set</small>` : html`<b>${clock(v.s)}</b><small>to ${clock(v.e)}</small>`}</span>
    <span class="who"><span class="nm">${v.cn || "Customer"}</span>${where ? html`<span class="sub">${where}</span>` : ""}${what ? html`<span class="sub">${what}</span>` : ""}</span>
    <span class="wk-dend"><span class="wk-dtop">${v.st === "scheduled" ? warnBadge(w) : ""}${visitPill(v.st)}</span><span class="wk-dbot">${amount(ctx, v)}${(v.a || []).length ? faces(s.users, v.a) : html`<span class="wk-nobody">Nobody yet</span>`}</span></span>
  </a></li>`;
}
function dayTaskRow(t) {
  return html`<li><a class="wk-drow task" href="${"#/tasks/" + encodeURIComponent(t.id)}">
    <span class="wk-dt num"><b>${clock(t.start)}</b><small>to ${clock(t.end)}</small></span>
    <span class="who"><span class="nm">${t.title || "Busy"}</span><span class="sub">${t.kind === "estimate_visit" ? "Estimate visit" : t.kind === "meeting" ? "Meeting" : "Personal"}${t.cn ? ` · ${t.cn}` : ""}</span></span>
    <span class="wk-dend"><span class="pill">${icon("clock")}Task</span></span>
  </a></li>`;
}

function dayPanel(s, ctx) {
  const d = s.date;
  const items = dayItems(s, d);
  const live = items.filter((x) => x.k === "v" && !DEAD.includes(x.v.st)).length;
  const tasks = items.filter((x) => x.k === "t").length;
  const who = s.tech ? ` for ${names(s.users, [s.tech])}` : "";
  const canBook = !!(ctx && ctx.can && ctx.can("schedule:write"));
  const count = [plural(live, "visit"), tasks ? plural(tasks, "task") : ""].filter(Boolean).join(", ");
  return html`<section class="wk-dayp card" aria-labelledby="wk-dayp-h" aria-live="polite">
    <header class="wk-dayp-h">
      <h2 id="wk-dayp-h">${panelDay(d)}<span class="wk-dayp-n"> · ${count}${who}</span></h2>
      <div class="wk-dayp-acts">
        <button type="button" class="btn small" ${attrs({ "data-goday": d, "data-gotech": s.tech || "" })}>${icon("list")}Open day</button>
        ${s.tech ? html`<a class="btn small" href="${`#/schedule/route/${d}/${encodeURIComponent(s.tech)}`}">${icon("map")}Route</a>` : ""}
        ${canBook ? html`<a class="btn small" href="${`#/jobs/new?book=1&date=${d}`}">${icon("plus")}Book</a>` : ""}
      </div>
    </header>
    ${items.length ? html`<ul class="wk-drows">${items.map((x) => (x.k === "v" ? dayRow(s, x.v, ctx) : dayTaskRow(x.t)))}</ul>`
      : html`<div class="wk-dempty"><div class="art">${icon("sun")}</div><p><b>Nothing booked</b><span>${s.tech ? `${names(s.users, [s.tech])} has nothing on ${dateShort(d)}.` : `No visits on ${dateShort(d)}.`}</span></p></div>`}
  </section>`;
}

function monthView(s, ctx) {
  const g = monthGrid(s.cal);
  const t = todayOf(s);
  const visits = (s.data.visits || []).filter((v) => v.d.slice(0, 7) === s.cal && !DEAD.includes(v.st) && (!s.tech || (v.a || []).includes(s.tech)));
  return html`<div class="wk-month">
    <div class="wk-cal card">
      <div class="wk-mhead">
        <div class="wk-mname"><h2 class="wk-mtitle">${monthName(s.cal)}</h2><span class="wk-mcount small muted num">${plural(visits.length, "visit")}${s.tech ? ` for ${names(s.users, [s.tech])}` : ""}</span></div>
        <div class="wk-mnav">
          ${s.cal !== t.slice(0, 7) || s.date !== t ? html`<button type="button" class="btn small" data-cal="today">Today</button>` : ""}
          <button type="button" class="icon-btn" data-cal="-1" aria-label="Previous month">${icon("back")}</button>
          <button type="button" class="icon-btn" data-cal="1" aria-label="Next month"><span class="flip">${icon("back")}</span></button>
        </div>
      </div>
      <div class="wk-mgrid" role="group" ${attrs({ "aria-label": `${monthName(s.cal)}: pick a day`, "data-weeks": String(g.weeks.length) })}>
        <div class="wk-mdow" aria-hidden="true">${g.weeks[0].map((d) => html`<span>${dowShort(d)}</span>`)}</div>
        ${g.weeks.map((w) => html`<div class="wk-mweek">${w.map((d) => dayCell(s, d))}</div>`)}
      </div>
    </div>
    ${dayPanel(s, ctx)}
  </div>`;
}

// ------------------------------------------------------------ Day, Week, List, To book

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
      ${s.date !== todayOf(s) ? html`<button type="button" class="btn" data-day="today">Today</button>` : ""}
    </div>`;
}

function weekView(s) {
  const start = weekStart(s.date);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const visits = (s.data.visits || []).filter((v) => !DEAD.includes(v.st));
  const count = (uid, d) => visits.filter((v) => v.d === d && (uid ? (v.a || []).includes(uid) : !(v.a || []).length)).length;
  const people = s.users.filter((u) => u.is_technician || visits.some((v) => (v.a || []).includes(u.id)));
  const nobody = days.some((d) => count(null, d));
  const t = todayOf(s);
  const cell = (uid, d) => {
    const n = count(uid, d);
    return html`<td><button type="button" class="${"wk-cell" + (n ? " on" : "") + (d === t ? " today" : "")}" ${attrs({ "data-goday": d, "data-gotech": uid || "", "aria-label": `${n} on ${dateShort(d)}` })}>${n || ""}</button></td>`;
  };
  return html`
    <div class="daybar"><button type="button" class="icon-btn" data-week="-1" aria-label="Week before">${icon("back")}</button><span class="d">${dateShort(start)} – ${dateShort(days[6])}</span><button type="button" class="icon-btn" data-week="1" aria-label="Next week"><span class="flip">${icon("back")}</span></button></div>
    <div class="card wk-weekcard"><table class="wk-week">
      <thead><tr>${days.map((d) => html`<th scope="col" class="${d === t ? "today" : ""}"><span>${dowShort(d).slice(0, 2)}</span><b class="num">${dayNum(d)}</b></th>`)}</tr></thead>
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
  const name = monthName(s.month);
  return html`
    <div class="daybar"><button type="button" class="icon-btn" ${attrs({ "data-month": shiftMonth(s.month, -1), "aria-label": "Month before" })}>${icon("back")}</button><span class="d">Due by ${name}</span><button type="button" class="icon-btn" ${attrs({ "data-month": shiftMonth(s.month, 1), "aria-label": "Next month" })}><span class="flip">${icon("back")}</span></button></div>
    ${t.jobs.length ? html`<ul class="list">${t.jobs.map((j) => html`<li class="wk-trayrow">
      <a class="row" href="${"#/jobs/" + encodeURIComponent(j.id)}"><span class="who"><span class="nm">${j.cn || "Customer"}</span><span class="sub">${j.n} · ${j.t}</span><span class="sub">${[kindLabel(j.k), j.tm ? `due ${j.tm}` : null, j.pl ? "plan visit" : null].filter(Boolean).join(" · ")}</span></span></a>
      <button type="button" class="btn primary wk-book" ${attrs({ "data-book": j.id, "data-town": "" })}>Book</button>
    </li>`)}</ul>` : emptyCard("Nothing waiting", "Jobs without a visit show up here, with plan visits and takedowns once they're due.", "check")}
    ${t.later ? html`<p class="small muted wk-count">${plural(t.later, "more job")} due after ${name}.</p>` : ""}`;
}

// ------------------------------------------------------------ keys (Month)

const STEP = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
function key(e, el, ctx) {
  const s = ctx.state;
  const d = el.dataset.mday;
  let next = null;
  if (STEP[e.key] !== undefined) next = addDays(d, STEP[e.key]);
  else if (e.key === "Home") next = addDays(d, -dow(d));
  else if (e.key === "End") next = addDays(d, 6 - dow(d));
  else if (e.key === "PageUp" || e.key === "PageDown") {
    const ym = shiftMonth(d.slice(0, 7), e.key === "PageUp" ? -1 : 1);
    const last = Number(new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate());
    next = `${ym}-${String(Math.min(dayNum(d), last)).padStart(2, "0")}`;
  }
  if (!next) return;
  e.preventDefault();
  // a day past the grid turns the month; one in its leading or trailing week stays in this grid
  if (!loaded(s, next) || e.key === "PageUp" || e.key === "PageDown") { s.cal = next.slice(0, 7); s.data = null; }
  pick(ctx, next, { focus: true });
}

export default {
  title: "Schedule",
  load,
  // the top button books (a new job and its visit); Time off sits with the day's buttons
  action: (s, ctx) => (s.denied || !ctx.can("schedule:write") ? null : { label: "Book", run: () => ctx.go("/jobs/new?book=1") }),
  render(s, ctx) {
    if (s.denied) return html`<div class="stack"><div class="card empty"><div class="art">${icon("schedule")}</div><h2>Your day is on Today</h2><p>The full schedule is for the office.</p><div class="btn-row"><a class="btn primary" href="#/today">Open Today</a></div></div></div>`;
    const month = s.view === "month";
    // a read that failed (no signal) leaves nothing to draw: say so, with a retry
    if (!s.data && s.view !== "tray") {
      return html`<div class="stack wk"><div class="wk-bar"><div class="wk-views" role="tablist" aria-label="View">${VIEWS.map(([k, label]) => html`<button type="button" class="wk-view" role="tab" ${attrs({ "data-view": k, "aria-selected": String(s.view === k) })}>${label}</button>`)}</div></div>
        <div class="card empty"><div class="art">${icon("schedule")}</div><h2>The schedule didn't load</h2><p>Check the signal and try again.</p><div class="btn-row"><button type="button" class="btn primary" ${attrs({ "data-view": s.view })}>Try again</button></div></div></div>`;
    }
    return html`<div class="${"stack wk" + (month ? " wk-wide" : "")}">
      <div class="wk-bar">
        <div class="wk-views" role="tablist" aria-label="View">${VIEWS.map(([k, label]) => html`<button type="button" class="wk-view" role="tab" ${attrs({ "data-view": k, "aria-selected": String(s.view === k) })}>${label}</button>`)}</div>
        ${month ? techChips(s) : ""}
      </div>
      ${month ? monthView(s, ctx) : s.view === "day" ? dayView(s) : s.view === "week" ? weekView(s) : s.view === "list" ? listView(s) : trayView(s)}
      ${s.data && s.data.stale ? html`<p class="foot-note">The schedule's list is being rebuilt; a change from the last minute may be missing.</p>` : ""}
    </div>`;
  },
  mount(el, s) {
    if (s.view !== "month") return;
    if (s.focusDay) {
      s.focusDay = false;
      const b = el.querySelector(`[data-mday="${s.date}"]`);
      if (b) { try { b.focus({ preventScroll: false }); } catch (e) { /* old Safari */ } }
    }
    if (s.scrollDay) {
      s.scrollDay = false;
      // a phone: the day's list sits under the grid; bring its head into view when it's out of sight
      const p = el.querySelector(".wk-dayp");
      const v = el.closest(".view") || el;
      if (p && v.getBoundingClientRect && p.getBoundingClientRect().top > v.getBoundingClientRect().bottom - 96) {
        try { p.scrollIntoView({ block: "start", behavior: "smooth" }); } catch (e) { /* old Safari */ }
      }
    }
  },
  events: {
    "click [data-view]": (e, el, ctx) => {
      const s = ctx.state;
      s.view = el.dataset.view;
      if (s.view === "month") { s.cal = s.date ? s.date.slice(0, 7) : null; s.data = null; }
      reload(ctx);
    },
    "click [data-mday]": (e, el, ctx) => pick(ctx, el.dataset.mday, { scroll: true }),
    "keydown [data-mday]": key,
    "click [data-cal]": (e, el, ctx) => {
      const s = ctx.state;
      if (el.dataset.cal === "today") { s.cal = null; s.date = null; }
      else { s.cal = shiftMonth(s.cal || todayOf(s).slice(0, 7), Number(el.dataset.cal)); s.date = null; }
      reload(ctx);
    },
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
