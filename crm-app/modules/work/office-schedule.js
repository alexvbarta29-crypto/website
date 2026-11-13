// Schedule (design §9.2), laid out like Rotor's phone schedule with the best
// of Flyra's (the owner's choice):
//   - the head: the month as a big title (tap: pick a month or a date) and
//     a row of round buttons: Search (a visit by customer or address in
//     what's on screen), Map of the day, Go to a date, Who (one person or
//     everyone) and the gear (what the cards show, cancelled hidden or not);
//   - the views: Month (the default) · List · Day · 3 Day · Week, with a
//     week strip (Sunday first, today in a coral circle) on List, Day and
//     3 Day; To book (the tray) from the month's "N to book";
//   - Month: each day shows how full it is against what the crew can do,
//     the forecast for the next days and a mark on past days with visits
//     nobody closed; the chosen day's list beside the grid on a computer,
//     under it on a phone ("Open day", or "No jobs on ..." and Add job);
//   - Day: a column per person (Unassigned first; "Technician"), each head
//     with visits done of all and the money, or the sales side ("Sales
//     rep": estimate visits, meetings and calls with a time), on a time grid
//     with a red line at the current time; more than two columns scroll
//     sideways on a phone; 3 Day: three days side by side.
//
// On a desk (1,100 px and up; office-board.js, office-vpanel.js): a click
// on a visit opens it in a side panel (the address says ?visit=, Esc
// closes), and a visit can be dragged to another day, time or person (Week,
// Day, 3 Day) or a job from the To book tray onto a day, with an undo bar.
//
// The month is one read (GET /schedule?month=, the leading and trailing
// days too, with each day's capacity and the To book count); picking a day
// inside it never reads again. The forecast is its own small read (GET
// /schedule/weather) after the grid is on screen. Arrow keys move the
// chosen day on a computer (Page Up / Page Down a month).

import { html, icon, attrs, toast, sheet, sheetOpen, raw, render } from "../../core/ui.js";
import { dateShort, dateLong, plural, money, clock } from "../../core/format.js";
import { busy } from "../../core/forms.js";
import {
  ensureStyles, officeView, today, addDays, dow, dowShort, dayNum, dayLabel, isDate, slotText, range, visitPill, faces, names, loadUsers, team,
  kindLabel, scheduleSheet, emptyCard, toMin,
} from "./office-kit.js";
import {
  shortTime, shortName, colorOf, capFor, fullness, notClosed, liveOn, fillBar, weekBoard, dayColumns, salesColumns, threeDay, deskTray, dndEvents, dropVisit, dropJob,
  undoChange, DEAD, sundayOf, nowMinutes, loadCards, saveCards, cardBits, CARD_DEFAULTS,
} from "./office-board.js";
import { wxMark, wxLine, wxWords, dayWx, WX_ICONS } from "./office-weather.js";
import { panelView, openPanel, closePanel, moveFromPanel, assignSheet, wide, isVisitId } from "./office-vpanel.js";

// the segmented control, in Rotor's order (Month first: the owner's default)
const VIEWS = [["month", "Month"], ["list", "List"], ["day", "Day"], ["3day", "3 Day"], ["week", "Week"]];
const ALL_VIEWS = [...VIEWS.map(([k]) => k), "tray"];
const CHIPS = 3;                       // chips a day cell shows on a computer before "+N more"
const WX_FRESH_MS = 30 * 60000;        // the forecast is read again after half an hour
const UNDO_MS = 12000;                 // how long the undo bar stays
const STRIP = ["day", "3day", "list"]; // the views with the week strip

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
const MONTH_LONG = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long" });
const MONTH_SHORT = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short" });
const monthName = (ym) => `${MONTH_LONG.format(new Date(ym + "-15T12:00:00Z"))} ${ym.slice(0, 4)}`;
// "Thursday, Nov 12": the day list's head
const PANEL_DAY = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "short", day: "numeric" });
export const panelDay = (d) => PANEL_DAY.format(new Date(d + "T12:00:00Z"));
export { shortTime, shortName, capFor, fullness, notClosed };
const loaded = (s, d) => !!(s.data && s.data.kind === "month" && d >= s.data.from && d <= s.data.to);

// ------------------------------------------------------------ reads

// The days a view reads.
export function rangeOf(view, date) {
  if (view === "day") return [date, date];
  if (view === "3day") return [date, addDays(date, 2)];
  if (view === "week") return [sundayOf(date), addDays(sundayOf(date), 6)];
  return [date, addDays(date, 13)];
}

async function fetchView(ctx, s) {
  s.nowMin = nowMinutes();
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
    if (Number.isInteger(r.data.to_book)) s.toBook = { month: s.cal, n: r.data.to_book };
    return;
  }
  if (!s.date) {
    // no day asked for: the server's today (the phone's clock may be off)
    const r = await ctx.api("/schedule", { cache: false });
    s.date = r.data.from || today();
    s.today = r.data.today || s.today;
  }
  const [from, to] = rangeOf(s.view, s.date);
  const extra = s.view === "day" || s.view === "3day" ? `&amounts=1&pay=1${s.view === "day" && s.by === "sales" ? "&sales=1" : ""}` : s.view === "list" ? "&amounts=1" : "";
  const r = await ctx.api(`/schedule?from=${from}&to=${to}${extra}`, { cache: false });
  s.today = r.data.today || s.today;
  if (Number.isInteger(r.data.now_min)) s.nowMin = r.data.now_min;     // the server's time (the red line)
  s.data = { ...r.data, from, to };
}

// This screen's life: async answers redraw only the screen that asked.
let live = 0;
const paint = (ctx) => { if (ctx.state && (ctx.state.live === undefined || ctx.state.live === live)) ctx.rerender(); };
const meId = (ctx) => (ctx && ctx.user && ctx.user.id) || null;

async function load(params, ctx) {
  ensureStyles();
  if (!officeView()) return { denied: true };
  const q = new URLSearchParams((location.hash.split("?")[1]) || "");
  const k = ctx.keep;
  const asked = isDate(q.get("date")) ? q.get("date") : null;
  const vid = q.get("visit");
  const view = ALL_VIEWS.includes(q.get("view")) ? q.get("view") : ALL_VIEWS.includes(k.view) ? k.view : "month";
  const s = {
    view, by: q.get("by") === "sales" || (!q.get("by") && k.by === "sales") ? "sales" : "tech",
    date: asked || k.date || null, cal: asked ? asked.slice(0, 7) : k.cal || null, tech: k.tech || null, today: k.today || null,
    month: k.month || today().slice(0, 7), users: team(await loadUsers(ctx).catch(() => [])), data: null, tray: null,
    toBook: k.toBook || null, wx: k.wx && Date.now() - (k.wx.got || 0) < WX_FRESH_MS ? k.wx : null,
    panel: null, pendingVisit: isVisitId(vid) ? vid : null, dtray: null, undo: null, cards: loadCards(meId(ctx)),
  };
  await fetchView(ctx, s);
  s.live = ++live;
  Object.assign(k, { toBook: s.toBook, today: s.today });
  return s;
}

const keep = (ctx) => { const s = ctx.state; Object.assign(ctx.keep, { view: s.view, by: s.by, date: s.date, cal: s.cal, tech: s.tech, month: s.month, today: s.today, toBook: s.toBook, wx: s.wx }); };
async function reload(ctx) {
  keep(ctx);
  try { await fetchView(ctx, ctx.state); } catch (e) { toast(e.message, { bad: true }); }
  keep(ctx);
  paint(ctx);
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
// Go to a day in whatever view this is (the strip, the date picker, search).
function goDate(ctx, d) {
  const s = ctx.state;
  if (s.view === "month") { if (loaded(s, d)) { pick(ctx, d); return; } s.cal = d.slice(0, 7); }
  if (s.view === "tray") s.view = "day";
  s.date = d;
  reload(ctx);
}
const todayOf = (s) => s.today || today();
const canWrite = (ctx) => !!(ctx && ctx.can && ctx.can("schedule:write"));

// The forecast (after the grid is drawn; never in the way when it's missing).
async function fetchWeather(ctx) {
  const s = ctx.state;
  s.wxBusy = true;
  try { const r = await ctx.api("/schedule/weather"); s.wx = { days: (r.data && r.data.days) || {}, state: r.data && r.data.state, got: Date.now() }; } catch (e) { s.wx = { days: {}, state: "none", got: Date.now() }; }
  s.wxBusy = false;
  if (ctx.state.live === live) { ctx.keep.wx = s.wx; paint(ctx); }
}
// The tray beside the desk's week and days (the month of the day shown).
async function fetchDeskTray(ctx) {
  const s = ctx.state;
  const month = String(s.date || today()).slice(0, 7);
  s.dtrayBusy = true;
  try { const r = await ctx.api(`/schedule/unscheduled?month=${month}`, { cache: false }); s.dtray = { ...r.data, month }; } catch (e) { s.dtray = { jobs: [], later: 0, month, failed: true }; }
  s.dtrayBusy = false;
  paint(ctx);
}

// What every view draws from: cancelled visits left out when the gear says so.
const shown = (s) => (s.cards && s.cards.hideCancelled && s.data ? { ...s, data: { ...s.data, visits: (s.data.visits || []).filter((v) => !DEAD.includes(v.st)) } } : s);

// ------------------------------------------------------------ pieces

const warnBadge = (w) => (w && w.length ? html`<span class="pill amber" ${attrs({ title: w.map((x) => x.message).join(" ") })}>${icon("bell")}${w.length}</span>` : "");
const prices = (ctx) => !!(ctx && ctx.can && ctx.can("visits:prices"));

function visitRow(s, v, ctx) {
  const w = (s.data.warnings || {})[v.id];
  const t0 = v.do ? "Day" : v.s;
  const b = cardBits(v, s.cards, { prices: prices(ctx) });
  return html`<li><a class="row wk-visit ${DEAD.includes(v.st) ? "dead" : ""}" href="${"#/visits/" + encodeURIComponent(v.id)}" ${attrs({ "data-vopen": v.id })}>
    <span class="wk-time num">${v.do ? html`<b>Any</b>` : html`<b>${t0}</b><small>${v.e}</small>`}</span>
    <span class="who"><span class="nm">${b.title}</span><span class="sub">${[b.where, b.service || (s.cards && s.cards.service === false ? "" : v.jn)].filter(Boolean).join(" · ")}</span>
      <span class="sub">${slotText(v)}</span></span>
    <span class="end wk-end">${b.price ? html`<b class="wk-amt num">${b.price}</b>` : ""}${faces(s.users, v.a)}${v.st === "scheduled" ? warnBadge(w) : visitPill(v.st)}</span>
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

// ------------------------------------------------------------ the head (Rotor's), the views, the week strip

const SVG = (d) => raw(`<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${d}</svg>`);
const I = {
  pin: SVG('<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0C18.5 15.4 12 21 12 21z"/><circle cx="12" cy="10" r="2.4"/>'),
  filter: SVG('<path d="M4 5h16l-6.2 7.4V19l-3.6-1.8v-4.8z"/>'),
  caret: SVG('<path d="m6.5 9.5 5.5 5.5 5.5-5.5"/>'),
};

function head(s, ctx) {
  const ym = s.view === "month" ? s.cal : s.view === "tray" ? s.month : String(s.date || todayOf(s)).slice(0, 7);
  const mid = new Date(ym + "-15T12:00:00Z");
  const thisYear = ym.slice(0, 4) === todayOf(s).slice(0, 4);
  const who = s.tech ? names(s.users, [s.tech]) : "Everyone";
  return html`<div class="wk-top">
    <button type="button" class="wk-title" data-mpick ${attrs({ "aria-haspopup": "dialog", "aria-label": `${monthName(ym)}: pick a month or a day` })}>
      <span class="wk-tname"><span class="long">${MONTH_LONG.format(mid)} <span class="wk-tylong num">${ym.slice(0, 4)}</span></span><span class="short">${MONTH_SHORT.format(mid)}</span>${I.caret}</span>
      <span class="${"wk-tyear num" + (thisYear ? " same" : "")}">${ym.slice(0, 4)}</span>
    </button>
    <div class="wk-tools" role="group" aria-label="Schedule tools">
      <button type="button" class="wk-round" data-search aria-label="Find a visit">${icon("search")}</button>
      <button type="button" class="wk-round" data-mapday aria-label="Map of the day">${I.pin}</button>
      <button type="button" class="wk-round" data-jump aria-label="Go to a date">${icon("schedule")}</button>
      <button type="button" class="${"wk-round" + (s.tech ? " on" : "")}" data-filter ${attrs({ "aria-label": `Who: ${who}`, "aria-pressed": String(!!s.tech) })}>${I.filter}</button>
      <button type="button" class="wk-round" data-cards aria-label="What the cards show">${icon("gear")}</button>
    </div>
  </div>`;
}

// A phone's head (Flyra's, Nov 13): the big title ("Nov 2026"; "Today" and
// the date under it on a day), the < > pill at the right; under it the view
// pill (Month ⌄: Day, Week, Month, Technician, Sales rep, List, 3 Day, and
// Map of the day) and the round tools pill (find a visit, who, Show on
// cards). A desk keeps Rotor's head and the segmented views (head above).
const FLY_VIEWS = [["day:tech", "Day"], ["week", "Week"], ["month", "Month"], ["day:tech*", "Technician"], ["day:sales", "Sales rep"], ["list", "List"], ["3day", "3 Day"]];
const MONTH_DAY = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", day: "numeric" });
const WEEKDAY_LONG = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long" });
function flyLabel(s) {
  if (s.view === "day") return s.by === "sales" ? "Sales rep" : "Day";
  return (VIEWS.find(([k]) => k === s.view) || [null, s.view === "tray" ? "To book" : "Month"])[1];
}
// "Today", "Tomorrow", "Yesterday", else the weekday (the date is the line under it)
export function dayTitle(d, t) {
  if (d === t) return "Today";
  if (d === addDays(t, 1)) return "Tomorrow";
  if (d === addDays(t, -1)) return "Yesterday";
  return WEEKDAY_LONG.format(new Date(d + "T12:00:00Z"));
}
function flyHead(s, ctx) {
  const t = todayOf(s);
  const ym = s.view === "month" ? s.cal : s.view === "tray" ? s.month : String(s.date || t).slice(0, 7);
  const mid = new Date((ym || t.slice(0, 7)) + "-15T12:00:00Z");
  const day = s.view === "day" && s.date;
  const title = day ? dayTitle(s.date, t) : s.view === "tray" ? "To book" : `${MONTH_SHORT.format(mid)} ${String(ym).slice(0, 4)}`;
  const sub = day ? MONTH_DAY.format(new Date(s.date + "T12:00:00Z")) : "";
  // the day's total (Flyra's "November 13 · $195"), for someone who sees prices
  const total = day && prices(ctx) && s.data ? (s.data.visits || []).filter((v) => v.d === s.date && !DEAD.includes(v.st) && (!s.tech || (v.a || []).includes(s.tech))).reduce((n, v) => n + (Number(v.amt) > 0 ? Number(v.amt) : 0), 0) : 0;
  // back to today (Flyra's "↺ Today") when the screen is somewhere else
  const away = s.view === "month" ? !!s.cal && s.cal !== t.slice(0, 7) : s.view !== "tray" && !!s.date && s.date !== t;
  const tb = s.view === "month" && s.toBook && s.toBook.month === s.cal ? s.toBook.n : null;
  const step = s.view === "month" ? "data-cal" : s.view === "day" ? "data-day" : s.view === "3day" ? "data-day3" : s.view === "tray" ? null : "data-week";
  const arrows = step ? html`<div class="wk-fpill wk-farrows" role="group" aria-label="Earlier or later">
      <button type="button" ${attrs({ [step]: s.view === "tray" ? null : "-1", "aria-label": "Earlier" })}>${icon("chevleft")}</button><button type="button" ${attrs({ [step]: "1", "aria-label": "Later" })}>${icon("chevright")}</button></div>` : "";
  const label = flyLabel(s);
  return html`<div class="wk-fly">
    <div class="wk-frow1"><button type="button" class="wk-ftitle" data-mpick ${attrs({ "aria-haspopup": "dialog", "aria-label": `${title}${sub ? ", " + sub : ""}: pick a month or a day` })}><span class="t">${title}</span>${sub ? html`<span class="s">${sub}${total ? html` · <b class="wk-ftotal num">${money(total).replace(/\.00$/, "")}</b>` : ""}</span>` : ""}</button>
      <span class="wk-fright">${away ? html`<button type="button" class="wk-ftoday" data-ftoday>${icon("undo")}Today</button>` : ""}${arrows}</span></div>
    <div class="wk-frow2">
      <div class="wk-fmenu-wrap"><button type="button" class="wk-fpill wk-fview" data-vmenu ${attrs({ "aria-haspopup": "true", "aria-expanded": String(!!s.vmenu) })}>${label}${icon("chevdown")}</button>
        ${s.vmenu ? html`<ul class="wk-fmenu" role="menu">${FLY_VIEWS.map(([k, l]) => { const on = k === "day:tech" ? s.view === "day" && s.by !== "sales" && !s.byTech : k === "day:tech*" ? s.view === "day" && s.by !== "sales" && !!s.byTech : k === "day:sales" ? s.view === "day" && s.by === "sales" : s.view === k; return html`<li><button type="button" role="menuitemradio" ${attrs({ "data-fview": k, "aria-checked": String(on) })}><span class="ck" aria-hidden="true">${on ? icon("check") : ""}</span>${l}</button></li>`; })}
          <li class="sep"><button type="button" role="menuitem" data-mapday>${icon("map")}Map of the day</button></li>${tb ? html`<li><button type="button" role="menuitem" data-totray>${icon("clock")}${tb} to book</button></li>` : ""}</ul>` : ""}</div>
      <div class="wk-fpill wk-ftools" role="group" aria-label="Schedule tools">
        <button type="button" data-search aria-label="Find a visit">${icon("search")}</button>
        <button type="button" ${attrs({ class: s.tech ? "on" : null, "data-filter": "", "aria-label": `Who: ${s.tech ? names(s.users, [s.tech]) : "Everyone"}`, "aria-pressed": String(!!s.tech) })}>${icon("people")}</button>
        <button type="button" data-cards aria-label="Show on cards">${icon("gear")}</button>
      </div>
    </div>
  </div>`;
}

function viewTabs(s) {
  return html`<div class="wk-views" role="tablist" aria-label="View">${VIEWS.map(([k, label]) => html`<button type="button" class="wk-view" role="tab" ${attrs({ "data-view": k, "aria-selected": String(s.view === k) })}>${label}</button>`)}</div>`;
}

// One person shown (the Who button): a chip to show everyone again.
const whoChip = (s) => (s.tech ? html`<div class="wk-who-on"><button type="button" class="chip" data-tech="" ${attrs({ "aria-label": `Showing ${names(s.users, [s.tech])}: show everyone` })}><span class="wk-dot" ${attrs({ style: `background:${colorOf(s.users, [s.tech])}` })}></span>${names(s.users, [s.tech])}<span aria-hidden="true">✕</span></button></div>` : "");

// The week strip: Sunday first; today in a coral circle; the chosen day (and
// a 3 Day view's other two) marked. Swipe or the arrows for another week.
export function weekStrip(s) {
  const sun = sundayOf(s.date);
  const days = Array.from({ length: 7 }, (_, i) => addDays(sun, i));
  const t = todayOf(s);
  const span = s.view === "3day" ? [s.date, addDays(s.date, 1), addDays(s.date, 2)] : [s.date];
  return html`<div class="wk-strip" data-strip role="group" ${attrs({ "aria-label": `Week of ${dateShort(sun)}` })}>
    <button type="button" class="icon-btn wk-sarrow" data-sweek="-1" aria-label="Week before">${icon("back")}</button>
    <div class="wk-sdays">${days.map((d) => html`<button type="button" class="${"wk-sday" + (d === t ? " today" : "") + (d === s.date ? " sel" : span.includes(d) ? " span" : "")}" ${attrs({ "data-sday": d, "aria-pressed": String(d === s.date), "aria-current": d === t ? "date" : false, "aria-label": dateLong(d) })}>
      <span>${dowShort(d)[0]}</span><b class="num">${dayNum(d)}</b></button>`)}</div>
    <button type="button" class="icon-btn wk-sarrow" data-sweek="1" aria-label="Week after"><span class="flip">${icon("back")}</span></button>
  </div>`;
}

// ------------------------------------------------------------ Month

function dayCell(s, d) {
  const items = dayItems(s, d);
  const live = items.filter((x) => x.k === "t" || !DEAD.includes(x.v.st));
  const booked = liveOn(s.data.visits, d, s.tech).length;
  const f = fullness(booked, capFor(s.data.capacity, d, s.tech));
  const open = notClosed(s.data.visits, d, todayOf(s), s.tech);
  const w = dayWx(s.wx, d);
  const t = todayOf(s);
  const cls = ["wk-mday", d.slice(0, 7) !== s.cal ? "out" : "", d === t ? "today" : "", d === s.date ? "sel" : "", [0, 6].includes(dow(d)) ? "wkend" : "", open ? "unclosed" : ""].filter(Boolean).join(" ");
  const chips = items.length > CHIPS ? items.slice(0, CHIPS - 1) : items;
  const label = [
    `${dateLong(d)}: ${live.length ? plural(live.length, "visit") : "nothing booked"}`,
    f && f.level !== "closed" && f.level !== "open" ? f.label : f && f.level === "closed" ? "closed" : "",
    open ? `${plural(open, "visit")} not marked done` : "", w ? wxWords(w) : "", d === t ? "today" : "",
  ].filter(Boolean).join(", ");
  return html`<button type="button" class="${cls}" ${attrs({ "data-mday": d, "aria-pressed": String(d === s.date), "aria-current": d === t ? "date" : false, "aria-label": label, tabindex: d === s.date ? "0" : "-1" })}>
    <span class="wk-mtop" aria-hidden="true"><span class="wk-mnum num">${dayNum(d)}</span>${open ? html`<i class="wk-mopen" ${attrs({ title: `${plural(open, "visit")} not marked done` })}></i>` : ""}${wxMark(w, { pop: true, cls: "wk-wx wk-mwx" })}</span>
    <span class="wk-mchips" aria-hidden="true">${chips.map((x) => (x.k === "v"
      ? html`<span class="${"wk-mchip" + (DEAD.includes(x.v.st) ? " dead" : x.v.st === "completed" ? " done" : "")}" ${attrs({ style: `--c:${colorOf(s.users, x.v.a)}` })}><b class="num">${x.v.do ? "Any" : shortTime(x.v.s)}</b> ${cardBits(x.v, s.cards).short}</span>`
      : html`<span class="wk-mchip task"><b class="num">${shortTime(x.t.start)}</b> ${x.t.title || "Busy"}</span>`))}${items.length > chips.length ? html`<span class="wk-mmore">+${items.length - chips.length} more</span>` : ""}</span>
    <span class="wk-mfill" aria-hidden="true">${f && f.level !== "closed" ? fillBar(f, { count: booked || "" }) : ""}</span>
  </button>`;
}

function dayRow(s, v, ctx) {
  const w = (s.data.warnings || {})[v.id];
  const state = DEAD.includes(v.st) ? "dead" : v.st === "completed" ? "done" : "";
  const b = cardBits(v, s.cards, { prices: prices(ctx) });
  const where = s.cards && s.cards.address ? v.ad || v.town || "" : v.ad || v.town || "";
  return html`<li><a class="${"wk-drow" + (state ? " " + state : "")}" href="${"#/visits/" + encodeURIComponent(v.id)}" ${attrs({ "data-vopen": v.id })}>
    <span class="wk-dt num" ${attrs({ title: slotText(v) })}>${v.do ? html`<b>Anytime</b><small>Time not set</small>` : html`<b>${clock(v.s)}</b><small>to ${clock(v.e)}</small>`}</span>
    <span class="who"><span class="nm">${b.title}</span>${where && b.title !== where ? html`<span class="sub">${where}</span>` : ""}${b.service ? html`<span class="sub">${b.service}</span>` : ""}</span>
    <span class="wk-dend"><span class="wk-dtop">${v.st === "scheduled" ? warnBadge(w) : ""}${visitPill(v.st)}</span><span class="wk-dbot">${b.price ? html`<b class="wk-amt num">${b.price}</b>` : ""}${(v.a || []).length ? faces(s.users, v.a) : html`<span class="wk-nobody">Nobody yet</span>`}</span></span>
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
  const canBook = canWrite(ctx);
  const count = [plural(live, "visit"), tasks ? plural(tasks, "task") : ""].filter(Boolean).join(", ");
  const f = fullness(live, capFor(s.data.capacity, d, s.tech));
  const open = notClosed(s.data.visits, d, todayOf(s), s.tech);
  const w = dayWx(s.wx, d);
  return html`<section class="wk-dayp card" aria-labelledby="wk-dayp-h" aria-live="polite">
    <header class="wk-dayp-h">
      <div class="wk-dayp-t"><h2 id="wk-dayp-h">${panelDay(d)}<span class="wk-dayp-n"> · ${count}${who}</span></h2>
        <button type="button" class="wk-openday" ${attrs({ "data-goday": d, "data-gotech": s.tech || "" })}>Open day<span aria-hidden="true">›</span></button></div>
      ${w || (f && f.level !== "open") ? html`<div class="wk-dayp-info">${wxLine(w)}${f && f.level !== "open" ? html`<span class="${"wk-dayp-cap lvl-" + f.level}">${f.label}</span>` : ""}</div>` : ""}
      ${open ? html`<p class="wk-dayp-open">${plural(open, "visit")} here ${open === 1 ? "isn't" : "aren't"} marked done yet.</p>` : ""}
      ${items.length ? html`<div class="wk-dayp-acts">
        ${s.tech ? html`<a class="btn small" href="${`#/schedule/route/${d}/${encodeURIComponent(s.tech)}`}">${icon("map")}Route</a>` : ""}
        ${canBook ? html`<a class="btn small" href="${`#/jobs/new?book=1&date=${d}`}">${icon("plus")}Book</a>` : ""}
        ${canBook && d >= todayOf(s) && live ? html`<a class="btn small" href="${`#/schedule/move-day?date=${d}`}">${WX_ICONS.rain}Move this day</a>` : ""}
      </div>` : ""}
    </header>
    ${items.length ? html`<ul class="wk-drows">${items.map((x) => (x.k === "v" ? dayRow(s, x.v, ctx) : dayTaskRow(x.t)))}</ul>`
      : html`<div class="wk-dempty"><p><b>Nothing booked</b><span>${s.tech ? `${names(s.users, [s.tech])} has no jobs on ${dateShort(d)}.` : `No jobs on ${dateShort(d)}`}</span></p>
        ${canBook ? html`<a class="btn primary" href="${`#/jobs/new?book=1&date=${d}`}">${icon("plus")}Add job</a>` : ""}</div>`}
  </section>`;
}

function monthView(s, ctx) {
  const g = monthGrid(s.cal);
  const t = todayOf(s);
  const visits = (s.data.visits || []).filter((v) => v.d.slice(0, 7) === s.cal && !DEAD.includes(v.st) && (!s.tech || (v.a || []).includes(s.tech)));
  const tb = s.toBook && s.toBook.month === s.cal ? s.toBook.n : null;
  const cap = s.data.capacity;
  const perDay = cap ? (s.tech ? cap.per_person : cap.per_day) : null;
  return html`<div class="wk-month">
    <div class="wk-cal card">
      <div class="wk-mhead">
        <div class="wk-mname"><h2 class="wk-mtitle">${monthName(s.cal)}</h2><span class="wk-mcount small muted num">${plural(visits.length, "visit")}${s.tech ? ` for ${names(s.users, [s.tech])}` : ""}</span></div>
        ${tb ? html`<button type="button" class="wk-mtobook" data-totray ${attrs({ "aria-label": `${tb} ${tb === 1 ? "job" : "jobs"} to book: open To book` })}>${icon("clock")}<span class="num">${tb}</span> to book</button>` : ""}
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
      <div class="wk-mfoot">
        <p class="small muted">${perDay ? html`<span class="wk-mkey"><span class="wk-fbar"><i></i></span>Booked of ${perDay} a day${s.tech ? ` for ${names(s.users, [s.tech])}` : ""}</span>` : ""}<span class="wk-mkey"><i class="wk-mopen"></i>Not marked done</span>${s.wx && Object.keys(s.wx.days || {}).length ? html`<span class="wk-mkey">Forecast: National Weather Service</span>` : ""}</p>
        ${tb ? html`<button type="button" class="wk-ftobook" data-totray ${attrs({ "aria-label": `${tb} ${tb === 1 ? "job" : "jobs"} to book: open To book` })}><span class="num">${tb}</span> to book<span aria-hidden="true"> ›</span></button>` : ""}
        ${ctx && ctx.can && ctx.can("settings:general") ? html`<button type="button" class="btn small" data-schedset>${icon("gear")}Change</button>` : ""}
      </div>
    </div>
    ${dayPanel(s, ctx)}
  </div>`;
}

// ------------------------------------------------------------ Day, 3 Day, Week, List, To book

function dayView(s, ctx) {
  const visits = (s.data.visits || []).filter((v) => v.d === s.date && !DEAD.includes(v.st) && (!s.tech || (v.a || []).includes(s.tech)));
  const w = dayWx(s.wx, s.date);
  const sales = s.by === "sales";
  return html`
    <div class="wk-dbar">
      <div class="wk-by" role="group" aria-label="Columns by">
        <button type="button" class="chip" ${attrs({ "data-by": "tech", "aria-pressed": String(!sales) })}>Technician</button>
        <button type="button" class="chip" ${attrs({ "data-by": "sales", "aria-pressed": String(sales) })}>Sales rep</button>
      </div>
      ${w ? html`<span class="wk-daywx">${wxLine(w)}</span>` : ""}
    </div>
    <div class="${"wk-dgrid" + (!sales && canWrite(ctx) ? " with-tray" : "")}">${sales ? salesColumns(s, ctx) : dayColumns(s, ctx)}${sales ? "" : deskTray(s, ctx)}</div>
    <p class="small muted wk-count">${sales ? plural((s.data.sales || []).filter((x) => x.date === s.date).length, "sales appointment") : plural(visits.length, "visit")}${s.tech ? ` for ${names(s.users, [s.tech])}` : ""}${canWrite(ctx) && !sales ? html`<span class="wk-deskonly"> Drag a visit to another time or person.</span>` : ""}</p>
    <div class="btn-row">
      ${s.tech ? html`<a class="btn" href="${`#/schedule/route/${s.date}/${encodeURIComponent(s.tech)}`}">${icon("map")}Route</a>` : ""}
      <a class="btn" href="${`#/schedule/move-day?date=${s.date}`}">${icon("sun")}Rain day</a>
      <a class="btn" href="#/schedule/time-off">${icon("clock")}Time off</a>
      ${s.date !== todayOf(s) ? html`<button type="button" class="btn" data-day="today">Today</button>` : ""}
    </div>`;
}

function threeView(s, ctx) {
  return html`<div class="${"wk-dgrid" + (canWrite(ctx) ? " with-tray" : "")}">${threeDay(s, ctx)}${deskTray(s, ctx)}</div>
    <p class="small muted wk-count">Tap a day's head to open it.${canWrite(ctx) ? html`<span class="wk-deskonly"> Drag a visit to another day or time.</span>` : ""}</p>`;
}

function weekView(s, ctx) {
  const start = sundayOf(s.date);
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
    <div class="wk-phone"><div class="card wk-weekcard"><table class="wk-week">
      <thead><tr>${days.map((d) => html`<th scope="col" class="${d === t ? "today" : ""}"><span>${dowShort(d).slice(0, 2)}</span><b class="num">${dayNum(d)}</b></th>`)}</tr></thead>
      ${people.map((u) => html`<tbody><tr class="wk-wname"><th scope="rowgroup" colspan="7"><span class="wk-dot" ${attrs({ style: `background:${u.color || "#4a4a52"}` })}></span>${u.name}</th></tr><tr>${days.map((d) => cell(u.id, d))}</tr></tbody>`)}
      ${nobody ? html`<tbody><tr class="wk-wname"><th scope="rowgroup" colspan="7" class="muted">Nobody yet</th></tr><tr>${days.map((d) => cell(null, d))}</tr></tbody>` : ""}
    </table></div></div>
    <div class="wk-desk">${weekBoard({ ...s, tech: null }, ctx)}${deskTray(s, ctx)}</div>
    <p class="small muted wk-count">${plural(visits.length, "visit")} this week.<span class="wk-phoneonly"> Tap a day to open it.</span>${canWrite(ctx) ? html`<span class="wk-deskonly"> Drag a visit to another day or person.</span>` : ""}</p>`;
}

function listView(s, ctx) {
  const days = Array.from({ length: 14 }, (_, i) => addDays(s.data.from || s.date, i));
  const withAny = days.filter((d) => dayItems(s, d).length);
  return html`${withAny.length ? withAny.map((d) => html`<div class="section-h">${dayLabel(d)}</div><ul class="list">${dayItems(s, d).map((x) => (x.k === "v" ? visitRow(s, x.v, ctx) : taskRow(x.t)))}</ul>`)
    : emptyCard("Nothing in the next two weeks", "Book visits from a job, or from To book.")}`;
}

function trayView(s) {
  const t = s.tray || { jobs: [], later: 0 };
  const name = monthName(s.month);
  return html`
    <div class="daybar"><button type="button" class="icon-btn" ${attrs({ "data-month": shiftMonth(s.month, -1), "aria-label": "Month before" })}>${icon("back")}</button><span class="d">To book · due by ${name}</span><button type="button" class="icon-btn" ${attrs({ "data-month": shiftMonth(s.month, 1), "aria-label": "Next month" })}><span class="flip">${icon("back")}</span></button></div>
    ${t.jobs.length ? html`<ul class="list">${t.jobs.map((j) => html`<li class="wk-trayrow">
      <a class="row" href="${"#/jobs/" + encodeURIComponent(j.id)}"><span class="who"><span class="nm">${j.cn || "Customer"}</span><span class="sub">${j.n} · ${j.t}</span><span class="sub">${[kindLabel(j.k), j.tm ? `due ${j.tm}` : null, j.pl ? "plan visit" : null].filter(Boolean).join(" · ")}</span></span></a>
      <button type="button" class="btn primary wk-book" ${attrs({ "data-book": j.id, "data-town": "" })}>Book</button>
    </li>`)}</ul>` : emptyCard("Nothing waiting", "Jobs without a visit show up here, with plan visits and takedowns once they're due.", "check")}
    ${t.later ? html`<p class="small muted wk-count">${plural(t.later, "more job")} due after ${name}.</p>` : ""}`;
}

// ------------------------------------------------------------ the sheets behind the head's buttons

// The title: a month (this year's and the next) or any day.
function monthSheet(ctx) {
  const s = ctx.state;
  const cur = s.view === "month" ? s.cal : String(s.date || todayOf(s)).slice(0, 7);
  let year = Number(cur.slice(0, 4));
  const body = () => html`<div class="wk-mpicker">
    <div class="daybar"><button type="button" class="icon-btn" data-py="-1" aria-label="Year before">${icon("back")}</button><span class="d num">${year}</span><button type="button" class="icon-btn" data-py="1" aria-label="Year after"><span class="flip">${icon("back")}</span></button></div>
    <div class="wk-months">${Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`).map((ym) => html`<button type="button" class="${"chip" + (ym === todayOf(s).slice(0, 7) ? " now" : "")}" ${attrs({ "data-pm": ym, "aria-pressed": String(ym === cur) })}>${MONTH_SHORT.format(new Date(ym + "-15T12:00:00Z"))}</button>`)}</div>
    <form class="form wk-jumpf" data-jumpf novalidate><label class="field"><span>Or go to a day</span><input type="date" name="d" ${attrs({ value: s.date || todayOf(s) })}></label>
      <div class="btn-row"><button type="button" class="btn" data-pday="today">Today</button><button type="submit" class="btn primary">Go</button></div></form>
  </div>`;
  const sh = sheet({
    title: "Pick a month",
    body: body(),
    events: {
      "click [data-py]": (e, b) => { year += Number(b.dataset.py); sh.set(body()); },
      "click [data-pm]": (e, b) => {
        sh.close();
        const ym = b.dataset.pm;
        if (s.view === "month") { s.cal = ym; s.date = null; reload(ctx); return; }
        const day = Math.min(dayNum(s.date || `${ym}-01`), new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate());
        goDate(ctx, `${ym}-${String(day).padStart(2, "0")}`);
      },
      "click [data-pday]": () => { sh.close(); goToday(ctx); },
      "submit [data-jumpf]": (e, f) => { e.preventDefault(); const d = f.querySelector("[name=d]").value; if (!isDate(d)) return; sh.close(); goDate(ctx, d); },
    },
  });
}
function goToday(ctx) {
  const s = ctx.state;
  if (s.view === "month") { s.cal = null; s.date = null; reload(ctx); return; }
  goDate(ctx, todayOf(s));
}
// Go to a date (Rotor's calendar button).
function jumpSheet(ctx) {
  const s = ctx.state;
  const sh = sheet({
    title: "Go to a date",
    body: html`<form class="form" data-jumpf novalidate><label class="field"><span>Day</span><input type="date" name="d" ${attrs({ value: s.date || todayOf(s) })}></label>
      <div class="btn-row"><button type="button" class="btn" data-pday="today">Today</button><button type="submit" class="btn primary">Go</button></div></form>`,
    events: {
      "click [data-pday]": () => { sh.close(); goToday(ctx); },
      "submit [data-jumpf]": (e, f) => { e.preventDefault(); const d = f.querySelector("[name=d]").value; if (!isDate(d)) return; sh.close(); goDate(ctx, d); },
    },
  });
}
// Who: everyone, or one person.
function whoSheet(ctx) {
  const s = ctx.state;
  const sh = sheet({
    title: "Who to show",
    body: html`<div class="wk-people wk-whos" role="group" aria-label="Who">
      <button type="button" class="chip" ${attrs({ "data-tech": "", "aria-pressed": String(!s.tech) })}>Everyone</button>
      ${s.users.map((u) => html`<button type="button" class="chip" ${attrs({ "data-tech": u.id, "aria-pressed": String(s.tech === u.id) })}><span class="wk-dot" ${attrs({ style: `background:${u.color || "#4a4a52"}` })}></span>${u.name}</button>`)}
    </div>`,
    events: { "click [data-tech]": (e, b) => { sh.close(); setTech(ctx, b.dataset.tech || null); } },
  });
}
function setTech(ctx, id) { const s = ctx.state; s.tech = id; keep(ctx); paint(ctx); }
// The gear: what the cards show (Flyra's "Show on cards"), saved for this person on this device.
function cardsSheet(ctx) {
  const s = ctx.state;
  const c = { ...CARD_DEFAULTS, ...s.cards };
  const box = (k, label) => html`<label class="check"><input type="checkbox" ${attrs({ name: k, checked: !!c[k] })}><span>${label}</span></label>`;
  const sh = sheet({
    title: "Show on cards",
    body: html`<form class="form" data-cardsf novalidate>
      <div class="wk-cardopts">${box("name", "Customer name")}${box("service", "Service")}${prices(ctx) ? box("price", "Price") : ""}${box("address", "Address")}</div>
      <div class="wk-cardopts">${box("hideCancelled", "Hide cancelled jobs")}</div>
      <p class="small muted">Saved for you on this device.</p>
    </form>`,
    events: {
      "change [data-cardsf] input": (e, el) => {
        s.cards = { ...s.cards, [el.name]: el.checked };
        saveCards(meId(ctx), s.cards);
        paint(ctx);
      },
    },
  });
  return sh;
}
// Search: a visit by customer, address, town or job number among what's on screen.
export function searchVisits(visits, q, limit = 12) {
  const words = String(q || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return (visits || []).filter((v) => { const hay = [v.cn, v.ad, v.town, v.jn, v.t].filter(Boolean).join(" ").toLowerCase(); return words.every((w) => hay.includes(w)); })
    .sort((a, b) => (a.d + (a.s || "")).localeCompare(b.d + (b.s || ""))).slice(0, limit);
}
function searchSheet(ctx) {
  const s = ctx.state;
  const visits = (s.data && s.data.visits) || [];
  const where = s.data && s.data.from ? (s.data.from === s.data.to ? dateShort(s.data.from) : `${dateShort(s.data.from)} to ${dateShort(s.data.to)}`) : "";
  const results = (q) => {
    const hits = searchVisits(visits, q);
    return q.trim() ? (hits.length ? html`<ul class="list">${hits.map((v) => html`<li><a class="row" href="${"#/visits/" + encodeURIComponent(v.id)}" ${attrs({ "data-vjump": v.id })}><span class="who"><span class="nm">${v.cn || "Customer"}</span><span class="sub">${[dateShort(v.d), v.do ? "anytime" : clock(v.s), v.town].filter(Boolean).join(" · ")}</span></span>${visitPill(v.st)}</a></li>`)}</ul>`
      : html`<p class="muted">No visit matches on ${where || "this schedule"}.</p>`) : html`<p class="small muted">Searching ${plural(visits.length, "visit")}${where ? `, ${where}` : ""}.</p>`;
  };
  const sh = sheet({
    title: "Find a visit",
    body: html`<div class="form"><label class="field"><span>Customer, address or job number</span><input type="search" name="q" autocomplete="off" enterkeyhint="search"></label><div data-hits>${results("")}</div></div>`,
    events: {
      "input [name=q]": (e, el) => { const box = sh.el.querySelector("[data-hits]"); if (box) render(box, results(el.value)); },
      "click [data-vjump]": (e, a) => {
        const v = visits.find((x) => x.id === a.dataset.vjump);
        if (!v) return;
        if (!wide()) { sh.close(); return; }                     // a phone: the link opens the visit
        e.preventDefault();
        sh.close();
        jumpTo(ctx, v);
      },
    },
  });
  try { sh.el.querySelector("[name=q]").focus(); } catch (e) { /* fine */ }
}
// A found visit: its day chosen (in the month: picked; elsewhere: that day) and its panel open.
function jumpTo(ctx, v) {
  const s = ctx.state;
  if (s.view === "month") { if (loaded(s, v.d)) pick(ctx, v.d); else goDate(ctx, v.d); } else if (!(s.data && v.d >= s.data.from && v.d <= s.data.to)) goDate(ctx, v.d);
  openPanel(ctx, v.id, hooks(ctx));
}
// Map of the day: the live Team map (the maps module, team_map:read; today
// and the days it keeps) and each person's route that day.
function mapSheet(ctx) {
  const s = ctx.state;
  const d = s.date || todayOf(s);
  const visits = ((s.data && s.data.visits) || []).filter((v) => v.d === d && !DEAD.includes(v.st));
  const ppl = s.users.filter((u) => visits.some((v) => (v.a || []).includes(u.id)) && (!s.tech || u.id === s.tech));
  const team = ctx.can && ctx.can("team_map:read") && d <= todayOf(s) ? (d === todayOf(s) ? "#/team-map" : `#/team-map?date=${d}`) : null;
  sheet({
    title: `Map of ${dateShort(d)}`,
    body: html`${team ? html`<div class="btn-row"><a class="btn primary block" href="${team}">${I.pin}Open the team map</a></div>` : ""}${ppl.length ? html`<p class="small muted">Each person's stops in drive order, with directions.</p><ul class="list">${ppl.map((u) => html`<li><a class="row" href="${`#/schedule/route/${d}/${encodeURIComponent(u.id)}`}"><span class="wk-dot big" ${attrs({ style: `background:${u.color || "#4a4a52"}` })}></span><span class="who"><span class="nm">${u.name}</span><span class="sub">${plural(visits.filter((v) => (v.a || []).includes(u.id)).length, "stop")}</span></span><span class="chev" aria-hidden="true"></span></a></li>`)}</ul>`
      : html`<p class="muted">Nobody has a stop on ${dateShort(d)}.</p>`}`,
  });
}

// ------------------------------------------------------------ the desk: panel, drops, undo

const hooks = (ctx, extra = {}) => ({ paint: () => paint(ctx), ...extra });

// After a change: the schedule again (and the tray, and the open panel, quietly).
async function refreshAll(ctx) {
  const s = ctx.state;
  s.dtray = null;
  await reload(ctx);
  if (s.panel && s.live === live) openPanel(ctx, s.panel.id, hooks(ctx, { url: false, quiet: true }));
}

let undoSeq = 0;
function offerUndo(ctx, text, u) {
  const s = ctx.state;
  const n = ++undoSeq;
  s.undo = { text, u, n };
  setTimeout(() => { if (ctx.state.undo && ctx.state.undo.n === n) { ctx.state.undo = null; paint(ctx); } }, UNDO_MS);
}

async function onDrop(ctx, d, t) {
  const s = ctx.state;
  if (s.dropping) return;
  s.dropping = true;
  let res;
  try {
    res = d.kind === "job" ? await dropJob(ctx, d, t, { data: s.data, users: s.users }) : await dropVisit(ctx, d, t, { users: s.users });
  } finally { s.dropping = false; }
  if (res.nothing || res.cancelled) return;
  if (!res.ok) {
    toast(res.message || "That didn't work.", { bad: true });
    if (res.reload) await refreshAll(ctx);
    return;
  }
  const w = res.warnings || [];
  offerUndo(ctx, w.length ? `${res.text} Heads up: ${w[0].message}` : res.text, res.undo);
  await refreshAll(ctx);
}
const DND = dndEvents(onDrop);

// Schedule settings (cfg/work): how many visits a day the crew can do, and the forecast on or off.
async function settingsSheet(ctx) {
  let doc;
  try { const r = await ctx.api("/settings/work", { cache: false }); doc = { data: r.data.data || {}, etag: r.data.etag || "new" }; } catch (e) { toast(e.message || "That didn't load.", { bad: true }); return; }
  const sh = sheet({
    title: "Schedule settings",
    body: html`<form class="form" id="wk-sset" novalidate>
      <div class="err" data-form-err hidden></div>
      <label class="field" data-field="visits_per_day"><span>Visits a day the whole crew can do</span><input type="number" name="visits_per_day" min="1" max="60" step="1" inputmode="numeric" ${attrs({ value: String(doc.data.visits_per_day || 8) })}><small class="hint">The month's bars fill against this. A day someone is off counts their share less.</small></label>
      <label class="check"><input type="checkbox" name="weather" ${attrs({ checked: doc.data.weather !== false })}><span>Show the forecast on the schedule (from the National Weather Service, for the service area's center)</span></label>
      <button type="submit" class="btn primary block">Save</button>
    </form>`,
    events: {
      "submit #wk-sset": async (e, form) => {
        e.preventDefault();
        const err = form.querySelector("[data-form-err]");
        err.hidden = true;
        const n = Number(form.querySelector("[name=visits_per_day]").value);
        if (!Number.isInteger(n) || n < 1 || n > 60) { err.textContent = "Use a whole number from 1 to 60."; err.hidden = false; return; }
        const btn = form.querySelector("[type=submit]");
        busy(btn, true, "Saving…");
        try {
          await ctx.api("/settings/work", { method: "PUT", body: { ...doc.data, visits_per_day: n, weather: form.querySelector("[name=weather]").checked }, ifMatch: doc.etag });
          sh.close();
          toast("Saved");
          ctx.state.wx = null;
          delete ctx.keep.wx;
          reload(ctx);
        } catch (x) {
          busy(btn, false);
          err.textContent = x.status === 412 ? "Someone else just changed these settings. Close this and try again." : x.message || "That didn't save.";
          err.hidden = false;
        }
      },
    },
  });
}

// Esc closes the panel (a sheet on top closes first: core/ui.js handles that one).
let keyCtx = null;
let keysOn = false;
function onKey(e) {
  if (e.key !== "Escape" || e.defaultPrevented || !keyCtx || sheetOpen()) return;
  const s = keyCtx.state;
  if (!s || !s.panel || s.live !== live) return;
  e.preventDefault();
  closePanel(keyCtx, hooks(keyCtx));
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

let swipeX = null;

export default {
  title: "Schedule",
  load,
  // the top button books (a new job and its visit); Time off sits with the day's buttons
  action: (s, ctx) => (s.denied || !ctx.can("schedule:write") ? null : { label: "Book", run: () => ctx.go("/jobs/new?book=1") }),
  render(raw0, ctx) {
    if (raw0.denied) return html`<div class="stack"><div class="card empty"><div class="art">${icon("schedule")}</div><h2>Your day is on Today</h2><p>The full schedule is for the office.</p><div class="btn-row"><a class="btn primary" href="#/today">Open Today</a></div></div></div>`;
    const s = shown(raw0);
    const month = s.view === "month";
    // a read that failed (no signal) leaves nothing to draw: say so, with a retry
    if (!s.data && s.view !== "tray") {
      return html`<div class="stack wk">${flyHead(s, ctx)}${head(s, ctx)}<div class="wk-bar">${viewTabs(s)}</div>
        <div class="card empty"><div class="art">${icon("schedule")}</div><h2>The schedule didn't load</h2><p>Check the signal and try again.</p><div class="btn-row"><button type="button" class="btn primary" ${attrs({ "data-view": s.view })}>Try again</button></div></div></div>`;
    }
    const wideView = month || ["week", "day", "3day"].includes(s.view);
    return html`<div class="${"stack wk wk-v-" + s.view + (wideView ? " wk-wide" : "") + (s.panel ? " wk-sided" : "")}">
      ${flyHead(s, ctx)}
      ${head(s, ctx)}
      <div class="wk-bar">${viewTabs(s)}</div>
      ${STRIP.includes(s.view) && s.date ? weekStrip(s) : ""}
      ${whoChip(s)}
      ${month ? monthView(s, ctx) : s.view === "day" ? dayView(s, ctx) : s.view === "3day" ? threeView(s, ctx) : s.view === "week" ? weekView(s, ctx) : s.view === "list" ? listView(s, ctx) : trayView(s)}
      ${s.data && s.data.stale ? html`<p class="foot-note">The schedule's list is being rebuilt; a change from the last minute may be missing.</p>` : ""}
      ${panelView(s, ctx)}
      ${s.undo ? html`<div class="wk-undo" role="status"><span>${s.undo.text}</span><button type="button" class="btn small" data-undo>Undo</button><button type="button" class="icon-btn wk-undo-x" data-undo-x aria-label="Dismiss">✕</button></div>` : ""}
    </div>`;
  },
  mount(el, s, ctx) {
    if (s.denied || !ctx) return;
    keyCtx = ctx;
    if (!keysOn && typeof document !== "undefined") { document.addEventListener("keydown", onKey); keysOn = true; }
    // a shared link to a visit: its panel on a desk, its screen on a phone
    if (s.pendingVisit) {
      const id = s.pendingVisit;
      s.pendingVisit = null;
      if (wide()) openPanel(ctx, id, hooks(ctx, { url: false }));
      else { ctx.go(`/visits/${encodeURIComponent(id)}`, { replace: true }); return; }
    }
    if (["month", "week", "day", "3day"].includes(s.view) && s.data && s.data.weather !== false && !s.wx && !s.wxBusy) fetchWeather(ctx);
    if (["week", "day", "3day"].includes(s.view) && !(s.view === "day" && s.by === "sales") && wide() && canWrite(ctx) && s.date && (!s.dtray || s.dtray.month !== s.date.slice(0, 7)) && !s.dtrayBusy) fetchDeskTray(ctx);
    if (s.panel && s.panel.focus && !s.panel.loading) {
      s.panel.focus = false;
      const h = el.querySelector("#wk-side-title");
      if (h) { try { h.focus({ preventScroll: true }); } catch (e) { /* old Safari */ } }
    }
    if (s.back) {
      // the one on screen (a phone's list and a desk's board both carry it)
      const b = [...el.querySelectorAll(`[data-vopen="${s.back}"]`)].find((x) => x.offsetParent !== null);
      s.back = null;
      if (b) { try { b.focus({ preventScroll: true }); } catch (e) { /* old Safari */ } }
    }
    if (s.focusStrip) {
      s.focusStrip = false;
      const b = el.querySelector(`[data-sday="${s.date}"]`);
      if (b) { try { b.focus({ preventScroll: true }); } catch (e) { /* old Safari */ } }
    }
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
  unmount() {
    live += 1;
    keyCtx = null;
    if (keysOn && typeof document !== "undefined") { document.removeEventListener("keydown", onKey); keysOn = false; }
  },
  events: {
    // a phone's view pill (Flyra's menu): Day, Week, Month, Technician, Sales rep, List, 3 Day
    "click [data-vmenu]": (e, el, ctx) => { ctx.state.vmenu = !ctx.state.vmenu; paint(ctx); },
    "click [data-fview]": (e, el, ctx) => {
      const s = ctx.state;
      const [view, by] = el.dataset.fview.split(":");
      s.vmenu = false;
      s.byTech = el.dataset.fview === "day:tech*";
      if (view === "day") s.by = by === "sales" ? "sales" : "tech";
      if (s.view === view && view !== "day") { paint(ctx); return; }
      s.view = view;
      if (s.view === "month") { s.cal = s.date ? s.date.slice(0, 7) : null; s.data = null; }
      reload(ctx);
    },
    "click [data-ftoday]": (e, el, ctx) => { const s = ctx.state; if (s.view === "month") s.cal = null; s.date = null; reload(ctx); },
    "click [data-day3]": (e, el, ctx) => { const s = ctx.state; s.date = addDays(s.date, 3 * Number(el.dataset.day3)); reload(ctx); },
    // a tap anywhere else closes the view menu
    "click": (e, el, ctx) => { if (ctx.state.vmenu && !e.target.closest(".wk-fmenu-wrap")) { ctx.state.vmenu = false; paint(ctx); } },
    "click [data-view]": (e, el, ctx) => {
      const s = ctx.state;
      s.view = el.dataset.view;
      if (s.view === "month") { s.cal = s.date ? s.date.slice(0, 7) : null; s.data = null; }
      reload(ctx);
    },
    "click [data-by]": (e, el, ctx) => { const s = ctx.state; s.by = el.dataset.by === "sales" ? "sales" : "tech"; reload(ctx); },
    "click [data-totray]": (e, el, ctx) => { const s = ctx.state; s.month = s.cal || s.month; s.view = "tray"; reload(ctx); },
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
    "click [data-tech]": (e, el, ctx) => setTech(ctx, el.dataset.tech || null),
    "click [data-goday]": (e, el, ctx) => { const s = ctx.state; s.date = el.dataset.goday; s.tech = el.dataset.gotech || null; s.view = "day"; reload(ctx); },
    "click [data-book]": (e, el, ctx) => {
      scheduleSheet(ctx, { job_id: el.dataset.book, title: "Book a visit", onDone: () => refreshAll(ctx) });
    },
    "click [data-schedset]": (e, el, ctx) => settingsSheet(ctx),
    // the head's buttons
    "click [data-mpick]": (e, el, ctx) => monthSheet(ctx),
    "click [data-search]": (e, el, ctx) => searchSheet(ctx),
    "click [data-mapday]": (e, el, ctx) => mapSheet(ctx),
    "click [data-jump]": (e, el, ctx) => jumpSheet(ctx),
    "click [data-filter]": (e, el, ctx) => whoSheet(ctx),
    "click [data-cards]": (e, el, ctx) => cardsSheet(ctx),
    // the week strip: a day, another week (the arrows, a swipe, the arrow keys)
    "click [data-sday]": (e, el, ctx) => goDate(ctx, el.dataset.sday),
    "click [data-sweek]": (e, el, ctx) => goDate(ctx, addDays(ctx.state.date, 7 * Number(el.dataset.sweek))),
    "keydown [data-sday]": (e, el, ctx) => {
      const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
      if (!step) return;
      e.preventDefault();
      ctx.state.focusStrip = true;
      goDate(ctx, addDays(el.dataset.sday, step));
    },
    "touchstart [data-strip]": (e) => { swipeX = e.touches && e.touches[0] ? e.touches[0].clientX : null; },
    "touchend [data-strip]": (e, el, ctx) => {
      if (swipeX === null || !e.changedTouches || !e.changedTouches[0]) return;
      const dx = e.changedTouches[0].clientX - swipeX;
      swipeX = null;
      if (Math.abs(dx) > 48) goDate(ctx, addDays(ctx.state.date, dx < 0 ? 7 : -7));
    },
    // a visit on a desk: the side panel (a modified click still opens it the browser's way)
    "click [data-vopen]": (e, el, ctx) => {
      if (!wide() || e.defaultPrevented || e.button > 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      openPanel(ctx, el.dataset.vopen, hooks(ctx));
    },
    "click [data-pclose]": (e, el, ctx) => closePanel(ctx, hooks(ctx)),
    "click [data-pmove]": (e, el, ctx) => moveFromPanel(ctx, ({ before, after }) => {
      const p = ctx.state.panel;
      if (after && p) offerUndo(ctx, "Saved the change.", { kind: "visit", id: p.id, before, after });
      refreshAll(ctx);
    }),
    "click [data-passign]": (e, el, ctx) => assignSheet(ctx, ({ before, after }) => {
      const p = ctx.state.panel;
      if (p) offerUndo(ctx, after.assignee_ids.length ? `Now with ${names(ctx.state.users, after.assignee_ids)}.` : "Now with nobody.", { kind: "visit", id: p.id, before, after });
      refreshAll(ctx);
    }),
    "click [data-undo]": async (e, el, ctx) => {
      const s = ctx.state;
      const u = s.undo;
      if (!u) return;
      s.undo = null;
      paint(ctx);
      const r = await undoChange(ctx, u.u);
      toast(r.ok ? r.text || "Undone." : r.message || "That didn't undo.", { bad: !r.ok });
      await refreshAll(ctx);
    },
    "click [data-undo-x]": (e, el, ctx) => { ctx.state.undo = null; paint(ctx); },
    ...DND,
  },
};

export { toMin, range };
