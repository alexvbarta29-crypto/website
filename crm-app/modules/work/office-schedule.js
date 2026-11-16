// Schedule (design §9.2), laid out like Rotor's phone schedule with the best
// of Flyra's (the owner's choice):
//   - the head: the month as a big title (tap: pick a month or a date) and
//     a row of round buttons: Search (a visit by customer or address in
//     what's on screen), Map of the day, Go to a date, Who (one person or
//     everyone) and the gear (what the cards show, cancelled hidden or not);
//   - the views: Month (the default) · List · Day · 3 Day · Week, with a
//     week strip (Sunday first, today in a coral circle) on List, Day and
//     3 Day; To book (the tray) from the month's "N to book";
//   - Month (Rotor's grid, Nov 15: "make the monthly calendar look like
//     Rotor more"): the weekday row, the number at the top left (today in
//     the red circle), weekends shaded; on a computer Rotor's blocks
//     (customer, time, price in the status color: Not started grey, In
//     progress blue, Finished green, done and cancelled faded) and "+N
//     more" under Rotor's head (the views, < > the month, Today, the tools,
//     More Actions); on a phone a dot a visit in its status color. Each day
//     also shows how full it is, the forecast and a mark on past days with
//     visits nobody closed; the chosen day's list (Rotor's rows: a stripe
//     and a tag in the status color) beside the grid on a computer, under
//     it on a phone ("Open day", or "No jobs on ..." and Add job);
//   - Day: a column per person (Unassigned first; "Technician"), each head
//     with visits done of all and the money, or the sales side ("Sales
//     rep": estimate visits, meetings and calls with a time), on a time grid
//     with a red line at the current time; more than two columns scroll
//     sideways on a phone; 3 Day: three days side by side.
//
// A phone is simple, like Rotor's (Nov 15, the owner: "the monthly version
// is just way too much, just do what Rotor does"; flyHead below): "November
// ⌄" with one short line under it, the ‹ › pill and ONE round filter button
// (everything else lives in its sheet), then Rotor's segmented Month · List ·
// Day · 3 Day · Week. A phone's month is only the grid (the day numbers, a
// dot on a day with work, today outlined, the chosen day filled) and under
// it the chosen day: "Fri, Nov 13", "1 job · $195", Open day ›, and its
// visits as plain rows (time, customer, service, amount, a status dot); the
// fullness, the forecast and the not-closed marks stay in the cells' labels
// and on a desk. A dashed "To book (6)" chip sits above Day, 3 Day and Week;
// a long press on a visit opens Move or reassign (the desk's drag and drop).
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

import { html, icon, attrs, toast, sheet, sheetOpen, raw, render, actionSheet, sheetPage, listRow, listCard, toggle, formRows, formRow, addressAttrs } from "../../core/ui.js";
import { dateShort, dateLong, plural, money, clock } from "../../core/format.js";
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
const VIEWS = [["month", "Month"], ["list", "List"], ["day", "Day"], ["3day", "3 Day"], ["week", "Week"], ["map", "Map"]];
const ALL_VIEWS = [...VIEWS.map(([k]) => k), "tray"];
const CHIPS = 5;                       // chips a day cell shows on a computer before "+N more" (Rotor's tall cells)
const DOTS = 4;                        // a phone's dots a day before "+N"
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
// "Fri, Nov 13": a phone's day head (Flyra's)
const PHONE_DAY = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
export { shortTime, shortName, capFor, fullness, notClosed };
// Rotor's month (Nov 15, "make the monthly calendar look like Rotor more"):
// its status colors on the chips, the dots and the day's rows (Not started
// grey, In progress blue, Finished green; done and cancelled faded). A
// chip's time is the short "8a", so the customer's name fits beside it.
const ROTOR_ST = { scheduled: ["ns", "Not started"], en_route: ["ns", "On the way"], in_progress: ["ip", "In progress"], paused: ["ip", "Paused"], completed: ["fin", "Finished"], cancelled: ["x", "Cancelled"], no_access: ["x", "No access"] };
export const rotorStatus = (st) => ROTOR_ST[st] || ROTOR_ST.scheduled;
export const rotorTag = (st) => html`<span class="${"wk-rtag st-" + rotorStatus(st)[0]}">${rotorStatus(st)[1]}</span>`;
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
  if (s.view === "map") {
    // every person's route on the day (guide-gaps SC10, Flyra's Map view)
    const r = await ctx.api(`/schedule/routes?date=${s.date}`, { cache: false });
    s.data = { ...r.data, kind: "map", visits: [], from: s.date, to: s.date };
    return;
  }
  const [from, to] = rangeOf(s.view, s.date);
  const extra = s.view === "day" || s.view === "3day" ? `&amounts=1&pay=1${s.view === "day" && s.by === "sales" ? "&sales=1" : ""}` : s.view === "list" ? "&amounts=1&pay=1" : s.view === "week" ? "&amounts=1" : "";
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

// The month's To book count for a phone's chip (the jobs the tray would list).
async function fetchToBook(ctx) {
  const s = ctx.state;
  const month = String(s.date || today()).slice(0, 7);
  s.tbBusy = true;
  try { const r = await ctx.api(`/schedule/unscheduled?month=${month}`, { cache: false }); s.toBook = { month, n: ((r.data && r.data.jobs) || []).length }; } catch (e) { s.toBook = { month, n: 0 }; }
  s.tbBusy = false;
  ctx.keep.toBook = s.toBook;
  paint(ctx);
}

// The Pending jobs of the dates on screen (guide-gaps SC4, Rotor's Pending Jobs panel; synced with the view).
async function fetchPending(ctx) {
  const s = ctx.state;
  const [from, to] = rangeOf(s.view, s.date);
  const key = `${from}|${to}|${s.pendOverdue ? 1 : 0}`;
  s.pendBusy = true;
  try { const r = await ctx.api(`/schedule/unscheduled?from=${from}&to=${to}${s.pendOverdue ? "&overdue=1" : ""}`, { cache: false }); s.pend = { key, from, to, jobs: r.data.jobs || [], total: r.data.total_cents || 0 }; } catch (e) { s.pend = { key, from, to, jobs: [], total: 0, failed: true }; }
  s.pendBusy = false;
  paint(ctx);
}
const pendKey = (s) => { const [from, to] = rangeOf(s.view, s.date); return `${from}|${to}|${s.pendOverdue ? 1 : 0}`; };
function pendingChip(s) {
  const p = s.pend && s.pend.key === pendKey(s) ? s.pend : null;
  if (!p) return "";
  const n = p.jobs.length;
  return html`<div class="wk-phone wk-tbchip-w"><button type="button" class="rs-dashed wk-tbchip" data-pending ${attrs({ "aria-label": `Pending: ${plural(n, "job")} to book for these dates` })}>${icon("clock")}<span>${`Pending ${n}`}</span><span class="chev" aria-hidden="true"></span></button></div>`;
}
function pendingPage(ctx) {
  const s = ctx.state;
  const body = () => {
    const p = s.pend || { jobs: [] };
    const rows = p.jobs.map((j) => listRow({ title: j.cn || "Customer", amount: prices(ctx) && j.tot ? j.tot : null, sub: [j.n, j.t, j.tm ? `due ${j.tm}` : "no due month"].filter(Boolean).join(" · "), tag: j.pl ? "Plan" : null, href: "#/jobs/" + encodeURIComponent(j.id), action: { icon: "cal", label: `Schedule ${j.cn || "this job"}`, href: "#/jobs/" + encodeURIComponent(j.id) } }));
    return html`<p class="rs-sub">${p.from ? `${dateShort(p.from)}${p.to !== p.from ? ` to ${dateShort(p.to)}` : ""}: jobs waiting for a day, as the schedule moves.` : ""}</p>
      ${formRows([formRow("Include overdue", toggle(!!s.pendOverdue, { data: { "pend-overdue": true }, label: "Include overdue" }), { hint: "jobs due before these dates" })])}
      ${listCard(rows, { label: "Pending jobs", empty: "Nothing waiting for these dates." })}`;
  };
  const pg = sheetPage({
    title: "Pending jobs", body: () => body(),
    events: {
      "click [data-pend-overdue]": async () => { s.pendOverdue = !s.pendOverdue; await fetchPending(ctx); pg.set(body()); },
      "click a[href]": () => setTimeout(() => pg.close(), 0),
    },
  });
}

// Block time (guide-gaps SC7, Rotor's Time Blocks): part of one day held for someone, grey on the Day grid.
function blockSheet(ctx) {
  const s = ctx.state;
  const d = s.date || todayOf(s);
  const people = s.users.filter((u) => u.status !== "disabled");
  const sh = sheet({
    title: "Block time",
    body: html`<form class="form" id="wk-block-f" novalidate><div class="err" data-form-err hidden></div>
      <label class="field"><span>Who</span><select name="user_id">${people.map((u) => html`<option ${attrs({ value: u.id, selected: u.id === s.tech })}>${u.name}</option>`)}</select></label>
      <label class="field"><span>Day</span><input type="date" name="date" ${attrs({ value: d })} required></label>
      <div class="addr-grid"><label class="field"><span>From</span><input type="time" name="start" value="12:00" step="900" required></label><label class="field"><span>To</span><input type="time" name="end" value="13:00" step="900" required></label></div>
      <label class="field"><span>What for</span><input name="reason" maxlength="60" placeholder="Lunch, truck service, training"></label>
      <button type="submit" class="btn primary block">Block it</button></form>`,
    events: {
      "submit #wk-block-f": async (e, form) => {
        e.preventDefault();
        const v = Object.fromEntries(new FormData(form));
        try { await ctx.api("/time-off", { method: "POST", body: { user_id: v.user_id, date: v.date, start: v.start, end: v.end, reason: v.reason || "Blocked", kind: "block" } }); sh.close(); toast("Time blocked"); reload(ctx); }
        catch (err) { const box = form.querySelector("[data-form-err]"); box.hidden = false; box.textContent = err.message || "That didn't save."; }
      },
    },
  });
}

// The Map tab: every person's booked route on the day, a color each, chips to show or hide a person, and
// what can't be drawn (no one on it, no map point). Keyless: the stops drawn to scale, like the Route sketch.
export function routesSvg(routes, colors = new Map(), hidden = new Set(), { width = 340, height = 260, pad = 20 } = {}) {
  const shown = routes.filter((r) => !hidden.has(r.user_id));
  const pts = shown.flatMap((r) => r.stops.filter((x) => Array.isArray(x.geo)).map((x) => ({ lat: x.geo[0], lng: x.geo[1] })));
  if (!pts.length) return html`<svg class="route wk-maps" ${attrs({ viewBox: `0 0 ${width} ${height}` })} role="img" aria-label="No stops with a map point"></svg>`;
  const lats = pts.map((p) => p.lat), lngs = pts.map((p) => p.lng);
  const [a, b, c, d] = [Math.min(...lats), Math.max(...lats), Math.min(...lngs), Math.max(...lngs)];
  const k = Math.min((width - 2 * pad) / Math.max(1e-6, d - c), (height - 2 * pad) / Math.max(1e-6, b - a));
  const xy = (g) => [Math.round((pad + (g[1] - c) * k + ((width - 2 * pad) - (d - c) * k) / 2) * 10) / 10, Math.round((height - pad - (g[0] - a) * k - ((height - 2 * pad) - (b - a) * k) / 2) * 10) / 10];
  return html`<svg class="route wk-maps" ${attrs({ viewBox: `0 0 ${width} ${height}` })} role="img" ${attrs({ "aria-label": `${shown.length} ${shown.length === 1 ? "route" : "routes"}, ${pts.length} stops` })}>
    ${shown.map((r) => {
      const at = r.stops.filter((x) => Array.isArray(x.geo)).map((x) => ({ x, p: xy(x.geo) }));
      const col = colors.get(r.user_id) || "#4a4a52";
      return html`<g><path ${attrs({ d: at.map(({ p }, i) => `${i ? "L" : "M"}${p[0]} ${p[1]}`).join(" "), fill: "none", stroke: col, "stroke-width": "3", "stroke-linecap": "round", "stroke-linejoin": "round" })}></path>
        ${at.map(({ x, p }) => html`<g><circle ${attrs({ cx: p[0], cy: p[1], r: "10", fill: col })}></circle><text ${attrs({ x: p[0], y: p[1] + 4, "text-anchor": "middle", "font-size": "10", "font-weight": "700", fill: "#fff" })}>${String(x.n)}</text><title>${x.cn || ""}</title></g>`)}</g>`;
    })}
  </svg>`;
}
function mapView(s) {
  const routes = (s.data && s.data.routes) || [];
  const colors = new Map(s.users.map((u) => [u.id, u.color || "#4a4a52"]));
  const hidden = new Set(s.mapHide || []);
  const name = (id) => (s.users.find((u) => u.id === id) || {}).name || "Someone";
  return html`<div class="wk-mapv">
    ${routes.length ? html`<div class="rs-chips wk-mapchips" role="group" aria-label="People">${routes.map((r) => html`<button type="button" class="rs-chip" ${attrs({ "data-maphide": r.user_id, "aria-pressed": hidden.has(r.user_id) ? "false" : "true" })}><span class="wk-dot" ${attrs({ style: `background:${colors.get(r.user_id) || "#4a4a52"}` })}></span>${name(r.user_id)} · ${String(r.stops.length)}</button>`)}</div>` : ""}
    <div class="rs-card wk-mapcard">${routesSvg(routes, colors, hidden)}</div>
    <p class="small muted wk-count">${[routes.length ? "" : "Nobody has a stop on this day.", s.data && s.data.no_person ? `${plural(s.data.no_person, "visit")} with no technician` : "", s.data && s.data.no_address ? `${plural(s.data.no_address, "stop")} without a map point` : ""].filter(Boolean).join(" · ")}</p>
    ${routes.length ? listCard(routes.map((r) => listRow({ title: name(r.user_id), sub: `${plural(r.stops.length, "stop")}${r.stops[0] && r.stops[0].s ? ` · from ${clock(r.stops[0].s)}` : ""}`, href: `#/schedule/route/${s.date}/${encodeURIComponent(r.user_id)}`, initials: null })), { label: "Routes" }) : ""}
  </div>`;
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
  // (the List is also the old Visits screen: a finished visit whose job isn't paid gets the red $)
  const unpaid = v.st === "completed" && !!b.price && v.amt > 0 && v.pd === 0;
  return html`<li><a class="row wk-visit ${DEAD.includes(v.st) ? "dead" : ""}" href="${"#/visits/" + encodeURIComponent(v.id)}" ${attrs({ "data-vopen": v.id })}>
    <span class="wk-time num">${v.do ? html`<b>Any</b>` : html`<b>${t0}</b><small>${v.e}</small>`}</span>
    <span class="who"><span class="nm">${b.title}</span><span class="sub">${[b.where, b.service || (s.cards && s.cards.service === false ? "" : v.jn)].filter(Boolean).join(" · ")}</span>
      <span class="sub">${slotText(v)}</span></span>
    <span class="end wk-end">${unpaid ? html`<i class="wk-unpaid" ${attrs({ title: "Not paid yet", "aria-label": "Not paid yet" })}>$</i>` : ""}${b.price ? html`<b class="wk-amt num">${b.price}</b>` : ""}${faces(s.users, v.a)}${v.st === "scheduled" ? warnBadge(w) : visitPill(v.st)}</span>
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
  dots: SVG('<circle cx="5.5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18.5" cy="12" r="1.6"/>'),
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

// A phone's head, simple like Rotor's (the owner, Nov 15: "the monthly
// version is just way too much, just do what Rotor does"): the month as the
// title ("November ⌄": pick a month or a day) and one short line under it
// (the month's "Revenue $X", or the day shown; a holiday's name), the ‹ ›
// pill and ONE round button: the filter sheet (Who, the columns, Show on
// cards, cancelled, Find a visit, the map, Go to a date, To book, Rain day,
// Time off, Block time, the settings). Under it Rotor's segmented views:
// Month · List · Day · 3 Day · Week (the Map is in the sheet). Every view
// shares it on a phone; a desk keeps its own head (head() above, rotorBar).
const PHONE_VIEWS = [["month", "Month"], ["list", "List"], ["day", "Day"], ["3day", "3 Day"], ["week", "Week"]];
const WEEKDAY_LONG = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long" });
// "Today", "Tomorrow", "Yesterday", else the weekday (the date is the line under it)
export function dayTitle(d, t) {
  if (d === t) return "Today";
  if (d === addDays(t, 1)) return "Tomorrow";
  if (d === addDays(t, -1)) return "Yesterday";
  return WEEKDAY_LONG.format(new Date(d + "T12:00:00Z"));
}
// What the filter changes from the plain schedule (its button is lit).
const filtered = (s) => !!(s.tech || s.by === "sales" || (s.cards && s.cards.hideCancelled));
// The booked money of the visits shown (cancelled left out; one person's when Who says so).
const booked = (s, keep = () => true) => ((s.data && s.data.visits) || []).filter((v) => keep(v) && !DEAD.includes(v.st) && (!s.tech || (v.a || []).includes(s.tech))).reduce((n, v) => n + (Number(v.amt) > 0 ? Number(v.amt) : 0), 0);
const dollars = (c) => money(c).replace(/\.00$/, "");
function flyHead(s, ctx) {
  const t = todayOf(s);
  const ym = (s.view === "month" ? s.cal : s.view === "tray" ? s.month : String(s.date || t).slice(0, 7)) || t.slice(0, 7);
  const mid = new Date(ym + "-15T12:00:00Z");
  // "November" this year; "Jan 2027" another
  const name = ym.slice(0, 4) === t.slice(0, 4) ? MONTH_LONG.format(mid) : `${MONTH_SHORT.format(mid)} ${ym.slice(0, 4)}`;
  const day = ["day", "3day", "map"].includes(s.view) && s.date;
  const got = s.data && s.data.kind !== "map";
  // the one line: the month's money (Flyra's "Revenue $195"), a day's, or the dates on screen (SC11); a holiday's name on a day (SC12)
  const sum = !prices(ctx) || !got ? 0 : s.view === "month" ? booked(s, (v) => v.d.slice(0, 7) === s.cal) : s.view === "day" ? booked(s, (v) => v.d === s.date) : ["3day", "week", "list"].includes(s.view) ? booked(s) : 0;
  const hol = day && s.data && s.data.holidays ? s.data.holidays[s.date] : null;
  const when = day ? html`${dayTitle(s.date, t)} · ${MONTH_SHORT.format(new Date(s.date + "T12:00:00Z"))} ${dayNum(s.date)}${hol ? html` <span class="wk-hol">${hol}</span>` : ""}`
    : s.view === "week" && s.date ? `Week of ${dateShort(sundayOf(s.date))}` : s.view === "list" && s.date ? `From ${dateShort(s.date)}` : s.view === "tray" ? "To book" : "";
  const money0 = sum ? html`<b class="wk-ftotal num" ${attrs({ title: s.view === "month" ? "Booked this month" : "Booked in these dates" })}>${dollars(sum)}</b>` : "";
  const count = s.view === "month" && got && !prices(ctx) ? plural((s.data.visits || []).filter((v) => v.d.slice(0, 7) === s.cal && !DEAD.includes(v.st) && (!s.tech || (v.a || []).includes(s.tech))).length, "job") : "";
  const sub = s.view === "month" ? (sum ? html`Revenue ${money0}` : count) : html`${when}${when && sum ? " · " : ""}${money0}`;
  // back to today when the screen is somewhere else
  const away = s.view === "month" ? !!s.cal && s.cal !== t.slice(0, 7) : s.view !== "tray" && !!s.date && s.date !== t;
  // the ‹ › of each view: a month, a day, three days, a week (the List's two weeks go by the week)
  const step = { month: "cal", day: "day", "3day": "day3", week: "week", list: "week", map: "day" }[s.view] || null;
  const unit = { month: "month", day: "day", "3day": "three days", week: "week", list: "week", map: "day" }[s.view];
  const arrow = (dir) => html`<button type="button" class="wk-fh-b" ${attrs({ [`data-${step}`]: String(dir), "aria-label": `${dir < 0 ? "Previous" : "Next"} ${unit}` })}>${icon(dir < 0 ? "chevleft" : "chevright")}</button>`;
  const why = [s.tech ? names(s.users, [s.tech]) : "", s.by === "sales" ? "columns by sales rep" : "", s.cards && s.cards.hideCancelled ? "cancelled hidden" : ""].filter(Boolean).join(", ");
  return html`<div class="wk-fly">
    <div class="wk-fh-row">
      <div class="wk-fh-t">
        <button type="button" class="wk-fh-title" data-mpick ${attrs({ "aria-haspopup": "dialog", "aria-label": `${monthName(ym)}: pick a month or a day` })}><span class="t">${name}</span>${I.caret}</button>
        ${sub || away ? html`<div class="wk-fh-subrow">${sub ? html`<p class="wk-fh-sub">${sub}</p>` : ""}${away ? html`<button type="button" class="wk-ftoday" data-ftoday>Today</button>` : ""}</div>` : ""}
      </div>
      ${step ? html`<div class="wk-fh-pill wk-fh-nav" role="group" ${attrs({ "aria-label": `Earlier or later ${unit}` })}>${arrow(-1)}${arrow(1)}</div>` : ""}
      <button type="button" class="${"wk-fh-round" + (filtered(s) ? " on" : "")}" data-fsheet ${attrs({ "aria-label": `Filter and tools${why ? ": " + why : ""}`, "aria-haspopup": "dialog" })}>${I.filter}</button>
    </div>
    <div class="wk-fseg" role="tablist" aria-label="View">${PHONE_VIEWS.map(([k, label]) => html`<button type="button" class="wk-fseg-b" role="tab" ${attrs({ "data-fview": k, "aria-selected": String(s.view === k) })}>${label}</button>`)}</div>
  </div>`;
}

// The phone's "To book (6)" chip above Day, 3 Day and Week (a desk has the tray beside them).
function toBookChip(s) {
  const n = s.toBook && s.toBook.month === String(s.date || "").slice(0, 7) ? s.toBook.n : null;
  return n ? html`<div class="wk-phone wk-tbchip-w"><button type="button" class="rs-dashed wk-tbchip" data-totray ${attrs({ "aria-label": `${n} ${n === 1 ? "job" : "jobs"} to book: open To book` })}>${icon("clock")}<span>${`To book (${n})`}</span><span class="chev" aria-hidden="true"></span></button></div>` : "";
}

// The phone's ONE filter sheet: everything the desk's tools pill and More Actions hold.
function filterSheet(ctx) {
  const s = ctx.state;
  const who = s.tech ? names(s.users, [s.tech]) : "Everyone";
  const tb = s.toBook && (s.view === "month" ? s.toBook.month === s.cal : s.toBook.month === String(s.date || "").slice(0, 7)) ? s.toBook.n : null;
  const d = s.date || todayOf(s);
  const byCols = (by) => { s.by = by; s.view = "day"; reload(ctx); };
  actionSheet("Schedule options", [
    [{ label: `Who: ${who}`, icon: "people", hint: "one person or everyone", run: () => whoSheet(ctx), data: { filter: true } },
      { label: "Columns by technician", icon: s.by !== "sales" ? "check" : "team", hint: "Day", run: () => byCols("tech") },
      { label: "Columns by sales rep", icon: s.by === "sales" ? "check" : "sales", hint: "Day", run: () => byCols("sales") }],
    [{ label: "Show on cards", icon: "gear", hint: "name, service, price, address", run: () => cardsSheet(ctx), data: { cards: true } },
      { label: s.cards && s.cards.hideCancelled ? "Show cancelled visits" : "Hide cancelled visits", icon: "close", run: () => { s.cards = { ...s.cards, hideCancelled: !(s.cards && s.cards.hideCancelled) }; saveCards(meId(ctx), s.cards); paint(ctx); } }],
    [{ label: "Find a visit", icon: "search", hint: "customer, address, job", run: () => searchSheet(ctx), data: { search: true } },
      { label: "Map of the day", icon: "map", hint: dateShort(d), run: () => mapSheet(ctx), data: { mapday: true } },
      { label: "Everyone's routes", icon: "route", hint: dateShort(d), run: () => setView(ctx, "map"), data: { vpick: "map" } },
      { label: "Go to a date", icon: "cal", run: () => jumpSheet(ctx), data: { jump: true } }],
    [canWrite(ctx) && { label: tb ? `${tb} to book` : "To book", icon: "clock", hint: "jobs waiting for a day", run: () => toTray(ctx), data: { totray: true } },
      canWrite(ctx) && { label: "Rain day", icon: "sun", hint: `move ${dateShort(d)}`, href: `#/schedule/move-day?date=${d}` },
      canWrite(ctx) && { label: "Time off", icon: "clock", href: "#/schedule/time-off" },
      canWrite(ctx) && { label: "Block time", icon: "pause", hint: "part of a day, on the grid", run: () => blockSheet(ctx), data: { block: true } },
      ctx.can && ctx.can("settings:general") && { label: "Schedule settings", icon: "gear", href: "#/settings/schedule" }],
  ]);
}
function toTray(ctx) { const s = ctx.state; s.month = s.view === "month" ? s.cal || s.month : String(s.date || todayOf(s)).slice(0, 7); s.view = "tray"; reload(ctx); }

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
    <div class="wk-sdays">${days.map((d) => { const hol = s.data && s.data.holidays ? s.data.holidays[d] : null; return html`<button type="button" class="${"wk-sday" + (d === t ? " today" : "") + (d === s.date ? " sel" : span.includes(d) ? " span" : "") + (hol ? " hol" : "")}" ${attrs({ "data-sday": d, "aria-pressed": String(d === s.date), "aria-current": d === t ? "date" : false, "aria-label": dateLong(d) + (hol ? `, ${hol}` : ""), title: hol || null })}>
      <span>${dowShort(d)[0]}</span><b class="num">${dayNum(d)}</b></button>`; })}</div>
    <button type="button" class="icon-btn wk-sarrow" data-sweek="1" aria-label="Week after"><span class="flip">${icon("back")}</span></button>
  </div>`;
}

// ------------------------------------------------------------ Month

// A day of the month (Rotor's cell): the number at the top left (today in
// the red circle), the forecast and the mark of a day nobody closed at the
// right; on a computer Rotor's blocks (Tasks: N first, then each visit:
// customer, time, price, in its status color with its person's stripe)
// and "+N more"; on a phone a dot a visit in its status color; the fill bar
// (booked of what the crew can do) at the bottom.
function dayCell(s, d, ctx) {
  const items = dayItems(s, d);
  const live = items.filter((x) => x.k === "t" || !DEAD.includes(x.v.st));
  const booked = liveOn(s.data.visits, d, s.tech).length;
  const f = fullness(booked, capFor(s.data.capacity, d, s.tech));
  const open = notClosed(s.data.visits, d, todayOf(s), s.tech);
  const w = dayWx(s.wx, d);
  const t = todayOf(s);
  const cls = ["wk-mday", d.slice(0, 7) !== s.cal ? "out" : "", d === t ? "today" : "", d === s.date ? "sel" : "", [0, 6].includes(dow(d)) ? "wkend" : "", open ? "unclosed" : ""].filter(Boolean).join(" ");
  const tasks = items.filter((x) => x.k === "t");
  const visits = items.filter((x) => x.k === "v");
  const blocks = [...(tasks.length ? [{ k: "tasks", n: tasks.length }] : []), ...visits];
  const chips = blocks.length > CHIPS ? blocks.slice(0, CHIPS - 1) : blocks;
  const dots = visits.length > DOTS ? visits.slice(0, DOTS - 1) : visits;
  const label = [
    `${dateLong(d)}: ${live.length ? plural(live.length, "visit") : "nothing booked"}`,
    f && f.level !== "closed" && f.level !== "open" ? f.label : f && f.level === "closed" ? "closed" : "",
    open ? `${plural(open, "visit")} not marked done` : "", w ? wxWords(w) : "", d === t ? "today" : "",
  ].filter(Boolean).join(", ");
  const chip = (x) => {
    if (x.k === "tasks") return html`<span class="wk-mchip task"><span class="nm">${`Tasks: ${x.n}`}</span></span>`;
    const b = cardBits(x.v, s.cards, { prices: prices(ctx) });
    return html`<span class="${"wk-mchip st-" + rotorStatus(x.v.st)[0]}" ${attrs({ style: `--c:${colorOf(s.users, x.v.a)}` })}><span class="nm">${b.short}</span><span class="tm num">${x.v.do ? "Any" : shortTime(x.v.s)}</span>${b.price ? html`<b class="amt num">${b.price}</b>` : ""}</span>`;
  };
  return html`<button type="button" class="${cls}" ${attrs({ "data-mday": d, "aria-pressed": String(d === s.date), "aria-current": d === t ? "date" : false, "aria-label": label, tabindex: d === s.date ? "0" : "-1" })}>
    <span class="wk-mtop" aria-hidden="true"><span class="wk-mnum num">${dayNum(d)}</span>${open ? html`<i class="wk-mopen" ${attrs({ title: `${plural(open, "visit")} not marked done` })}></i>` : ""}${wxMark(w, { pop: true, cls: "wk-wx wk-mwx" })}</span>
    ${live.length ? html`<i class="${"wk-mjob" + (open ? " open" : "")}" aria-hidden="true"></i>` : ""}
    <span class="wk-mchips" aria-hidden="true">${chips.map(chip)}${blocks.length > chips.length ? html`<span class="wk-mmore">+${blocks.length - chips.length} more</span>` : ""}</span>
    ${visits.length ? html`<span class="wk-mdots" aria-hidden="true">${dots.map((x) => html`<i class="${"st-" + rotorStatus(x.v.st)[0]}"></i>`)}${visits.length > dots.length ? html`<b class="num">+${visits.length - dots.length}</b>` : ""}</span>` : ""}
    <span class="wk-mfill" aria-hidden="true">${f && f.level !== "closed" ? fillBar(f, { count: booked || "" }) : ""}</span>
  </button>`;
}

function dayRow(s, v, ctx) {
  const w = (s.data.warnings || {})[v.id];
  const state = DEAD.includes(v.st) ? "dead" : v.st === "completed" ? "done" : "";
  const b = cardBits(v, s.cards, { prices: prices(ctx) });
  const where = s.cards && s.cards.address ? v.ad || v.town || "" : v.ad || v.town || "";
  return html`<li><a class="${"wk-drow st-" + rotorStatus(v.st)[0] + (state ? " " + state : "")}" href="${"#/visits/" + encodeURIComponent(v.id)}" ${attrs({ "data-vopen": v.id })}>
    <span class="wk-dt num" ${attrs({ title: slotText(v) })}>${v.do ? html`<b>Anytime</b><small>Time not set</small>` : html`<b>${clock(v.s)}</b><small>to ${clock(v.e)}</small>`}</span>
    <span class="who"><span class="nm">${b.title}</span>${where && b.title !== where ? html`<span ${attrs({ class: "sub wk-dwhere" + (s.cards && s.cards.address ? " on" : ""), ...addressAttrs(v.ad && where === v.ad ? v.ad : "") })}>${where}</span>` : ""}${b.service ? html`<span class="sub">${b.service}</span>` : ""}<span class="sub wk-dwhen num">${v.do ? "Anytime" : `${clock(v.s)} to ${clock(v.e)}`}</span></span>
    <span class="wk-dend"><span class="wk-dtop">${v.st === "scheduled" ? warnBadge(w) : ""}${rotorTag(v.st)}</span><span class="wk-dbot">${b.price ? html`<b class="wk-amt num">${b.price}</b>` : ""}${(v.a || []).length ? faces(s.users, v.a) : html`<span class="wk-nobody">Nobody yet</span>`}</span></span>
  </a></li>`;
}
function dayTaskRow(t) {
  return html`<li><a class="wk-drow task" href="${"#/tasks/" + encodeURIComponent(t.id)}">
    <span class="wk-dt num"><b>${clock(t.start)}</b><small>to ${clock(t.end)}</small></span>
    <span class="who"><span class="nm">${t.title || "Busy"}</span><span class="sub">${t.kind === "estimate_visit" ? "Estimate visit" : t.kind === "meeting" ? "Meeting" : "Personal"}${t.cn ? ` · ${t.cn}` : ""}</span><span class="sub wk-dwhen num">${clock(t.start)} to ${clock(t.end)}</span></span>
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
  // a phone's head is Flyra's: "Fri, Nov 13" and under it "1 job · $195"
  const sum = prices(ctx) ? booked(s, (v) => v.d === d) : 0;
  const jobs = [plural(live, "job"), tasks ? plural(tasks, "task") : ""].filter(Boolean).join(", ") + who + (sum ? ` · ${dollars(sum)}` : "");
  return html`<section class="wk-dayp card" aria-labelledby="wk-dayp-h" aria-live="polite">
    <header class="wk-dayp-h">
      <div class="wk-dayp-t"><h2 id="wk-dayp-h"><span class="wk-dayp-l">${panelDay(d)}<span class="wk-dayp-n"> · ${count}${who}</span></span><span class="wk-dayp-s">${PHONE_DAY.format(new Date(d + "T12:00:00Z"))}<small class="num">${jobs}</small></span></h2>
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
  const visits = (s.data.visits || []).filter((v) => v.d.slice(0, 7) === s.cal && !DEAD.includes(v.st) && (!s.tech || (v.a || []).includes(s.tech)));
  const tb = s.toBook && s.toBook.month === s.cal ? s.toBook.n : null;
  const cap = s.data.capacity;
  const perDay = cap ? (s.tech ? cap.per_person : cap.per_day) : null;
  return html`<div class="wk-month">
    <div class="wk-cal card">
      <div class="wk-mgrid" role="group" ${attrs({ "aria-label": `${monthName(s.cal)}: pick a day`, "data-weeks": String(g.weeks.length) })}>
        <div class="wk-mdow" aria-hidden="true">${g.weeks[0].map((d) => html`<span><span class="l">${dowShort(d)}</span><span class="i">${dowShort(d)[0]}</span></span>`)}</div>
        ${g.weeks.map((w) => html`<div class="wk-mweek">${w.map((d) => dayCell(s, d, ctx))}</div>`)}
      </div>
      <div class="wk-mfoot">
        <p class="small muted"><span class="wk-mkey wk-mcount num">${plural(visits.length, "visit")}${s.tech ? ` for ${names(s.users, [s.tech])}` : ""}</span>${["ns", "ip", "fin"].map((k) => html`<span class="wk-mkey"><i class="${"wk-mswatch st-" + k}"></i>${{ ns: "Not started", ip: "In progress", fin: "Finished" }[k]}</span>`)}${perDay ? html`<span class="wk-mkey"><span class="wk-fbar"><i></i></span>Booked of ${perDay} a day${s.tech ? ` for ${names(s.users, [s.tech])}` : ""}</span>` : ""}<span class="wk-mkey"><i class="wk-mopen"></i>Not marked done</span>${s.wx && Object.keys(s.wx.days || {}).length ? html`<span class="wk-mkey">Forecast: National Weather Service</span>` : ""}</p>
        ${tb ? html`<button type="button" class="wk-ftobook" data-totray ${attrs({ "aria-label": `${tb} ${tb === 1 ? "job" : "jobs"} to book: open To book` })}><span class="num">${tb}</span> to book<span aria-hidden="true"> ›</span></button>` : ""}
        ${ctx && ctx.can && ctx.can("settings:general") ? html`<button type="button" class="btn small" data-schedset>${icon("gear")}Change</button>` : ""}
      </div>
    </div>
    ${dayPanel(s, ctx)}
  </div>`;
}

// A desk's head on the month (Rotor's): the views, then ‹ › the month and
// Today, then To book, the round tools (Find a visit, Map of the day, Who,
// what the cards show) and More Actions. A phone keeps its own head (flyHead).
function rotorBar(s, ctx) {
  const t = todayOf(s);
  const ym = s.cal || t.slice(0, 7);
  const mid = new Date(ym + "-15T12:00:00Z");
  const tb = s.toBook && s.toBook.month === ym ? s.toBook.n : null;
  const who = s.tech ? names(s.users, [s.tech]) : "Everyone";
  return html`<div class="wk-rbar">
    ${viewTabs(s)}
    <div class="wk-rnav" role="group" aria-label="Month">
      <button type="button" class="wk-rbtn" data-cal="-1" aria-label="Previous month">${icon("back")}</button>
      <button type="button" class="wk-rbtn" data-cal="1" aria-label="Next month"><span class="flip">${icon("back")}</span></button>
      <button type="button" class="wk-rbtn wk-rdate" data-mpick ${attrs({ "aria-haspopup": "dialog", "aria-label": `${monthName(ym)}: pick a month or a day` })}>${icon("schedule")}<span class="wk-mtitle">${`${MONTH_SHORT.format(mid)} ${ym.slice(0, 4)}`}</span></button>
      <button type="button" class="wk-rbtn wk-rtoday" data-cal="today" ${attrs({ "aria-pressed": String(ym === t.slice(0, 7) && s.date === t) })}>Today</button>
    </div>
    <div class="wk-rtools">
      ${tb ? html`<button type="button" class="wk-mtobook" data-totray ${attrs({ "aria-label": `${tb} ${tb === 1 ? "job" : "jobs"} to book: open To book` })}>${icon("clock")}<span class="num">${tb}</span> to book</button>` : ""}
      <div class="wk-tools" role="group" aria-label="Schedule tools">
        <button type="button" class="wk-round" data-search aria-label="Find a visit">${icon("search")}</button>
        <button type="button" class="wk-round" data-mapday aria-label="Map of the day">${I.pin}</button>
        <button type="button" class="${"wk-round" + (s.tech ? " on" : "")}" data-filter ${attrs({ "aria-label": `Who: ${who}`, "aria-pressed": String(!!s.tech) })}>${I.filter}</button>
        <button type="button" class="wk-round" data-cards aria-label="What the cards show">${icon("gear")}</button>
      </div>
      <button type="button" class="wk-rmore" data-more aria-haspopup="dialog">${I.dots}More Actions</button>
    </div>
  </div>`;
}

// More Actions (Rotor's red button): booking, the tray, time blocks, time off, a rain day, the settings.
function moreSheet(ctx) {
  const s = ctx.state;
  const d = s.date || todayOf(s);
  const tb = s.toBook && s.toBook.month === (s.cal || d.slice(0, 7)) ? s.toBook.n : null;
  actionSheet("More actions", [
    [canWrite(ctx) && { label: "Book a job", icon: "plus", hint: dateShort(d), href: `#/jobs/new?book=1&date=${d}` },
      canWrite(ctx) && { label: tb ? `${tb} to book` : "To book", icon: "clock", hint: "jobs waiting for a day", run: () => toTray(ctx), data: { totray: true } }],
    [canWrite(ctx) && { label: "Block time", icon: "pause", hint: "part of a day, on the grid", run: () => blockSheet(ctx), data: { block: true } },
      canWrite(ctx) && { label: "Time off", icon: "clock", href: "#/schedule/time-off" },
      canWrite(ctx) && { label: "Rain day", icon: "sun", hint: `move ${dateShort(d)}`, href: `#/schedule/move-day?date=${d}` }],
    [{ label: "Show on cards", icon: "gear", hint: "name, service, price, address", run: () => cardsSheet(ctx), data: { cards: true } },
      ctx.can && ctx.can("settings:general") && { label: "Schedule settings", icon: "gear", href: "#/settings/schedule" }],
  ]);
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
      <thead><tr>${days.map((d) => { const hol = s.data.holidays && s.data.holidays[d]; return html`<th scope="col" class="${(d === t ? "today" : "") + (hol ? " hol" : "")}" ${attrs({ title: hol || null })}><span>${dowShort(d).slice(0, 2)}</span><b class="num">${dayNum(d)}</b>${hol ? html`<small class="wk-hol">${hol.slice(0, 5)}</small>` : ""}</th>`; })}</tr></thead>
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
    return q.trim() ? (hits.length ? html`<ul class="list">${hits.map((v) => html`<li><a class="row" href="${"#/visits/" + encodeURIComponent(v.id)}" ${attrs({ "data-vjump": v.id, ...addressAttrs(v.ad || "") })}><span class="who"><span class="nm">${v.cn || "Customer"}</span><span class="sub">${[dateShort(v.d), v.do ? "anytime" : clock(v.s), v.town].filter(Boolean).join(" · ")}</span></span>${visitPill(v.st)}</a></li>`)}</ul>`
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

// Schedule settings (cfg/work: the crew's visits a day, the forecast) are in
// Settings → Services & pricing → Crew & forecast (system/settings-general.js), one place.

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

// A phone's long press on a visit (the desk's drag and drop): read it, then
// Move (day, time, people), Assign (who goes) or open it.
const LONG_PRESS_MS = 500;
let press = null;
async function pressSheet(ctx, id) {
  let r;
  try { r = await ctx.api(`/visits/${encodeURIComponent(id)}`, { cache: false }); } catch (e) { toast((e && e.message) || "That visit didn't load.", { bad: true }); return; }
  const p = { id, data: r.data, etag: r.etag };
  const v = r.data.visit || {};
  const can = r.data.can || {};
  const done = () => { toast("Saved the change."); refreshAll(ctx); };
  actionSheet("Move or reassign", [
    [can.move && { label: "Move", icon: "cal", hint: "day, time, people", run: () => moveFromPanel(ctx, done, p), data: { pmove: true } },
      can.office && ["scheduled", "en_route", "in_progress", "paused"].includes(v.status) && { label: "Assign", icon: "team", hint: "who goes", run: () => assignSheet(ctx, done, p), data: { passign: true } }],
    [{ label: "Open visit", icon: "doc", hint: [r.data.contact && r.data.contact.display_name, dateShort(v.date)].filter(Boolean).join(" · "), href: "#/visits/" + encodeURIComponent(id) }],
  ]);
}

function setView(ctx, view) {
  const s = ctx.state;
  if (!ALL_VIEWS.includes(view)) return;
  s.view = view;
  if (s.view === "month") { s.cal = s.date ? s.date.slice(0, 7) : null; s.data = null; }
  reload(ctx);
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
      ${month ? rotorBar(s, ctx) : html`${head(s, ctx)}<div class="wk-bar">${viewTabs(s)}</div>`}
      ${STRIP.includes(s.view) && s.date ? weekStrip(s) : ""}
      ${whoChip(s)}
      ${["day", "3day", "week", "list"].includes(s.view) && canWrite(ctx) ? pendingChip(s) || toBookChip(s) : ""}
      ${month ? monthView(s, ctx) : s.view === "day" ? dayView(s, ctx) : s.view === "3day" ? threeView(s, ctx) : s.view === "week" ? weekView(s, ctx) : s.view === "list" ? listView(s, ctx) : s.view === "map" ? mapView(s) : trayView(s)}
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
    // (the forecast turned off in Settings: a kept copy goes too)
    if (s.data && s.data.weather === false && s.wx) { s.wx = null; delete ctx.keep.wx; }
    if (["month", "week", "day", "3day"].includes(s.view) && s.data && s.data.weather !== false && !s.wx && !s.wxBusy) fetchWeather(ctx);
    if (["week", "day", "3day"].includes(s.view) && !(s.view === "day" && s.by === "sales") && wide() && canWrite(ctx) && s.date && (!s.dtray || s.dtray.month !== s.date.slice(0, 7)) && !s.dtrayBusy) fetchDeskTray(ctx);
    // a phone: the To book count for the chip and the filter (a desk has the tray itself)
    if (["week", "day", "3day", "list"].includes(s.view) && !wide() && canWrite(ctx) && s.date && (!s.toBook || s.toBook.month !== s.date.slice(0, 7)) && !s.tbBusy) fetchToBook(ctx);
    // the Pending jobs of the dates on screen (the chip follows the view)
    if (["week", "day", "3day", "list"].includes(s.view) && canWrite(ctx) && s.date && (!s.pend || s.pend.key !== pendKey(s)) && !s.pendBusy) fetchPending(ctx);
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
    // a phone's filter sheet (the views are the segmented row)
    "click [data-fsheet]": (e, el, ctx) => filterSheet(ctx),
    "click [data-more]": (e, el, ctx) => moreSheet(ctx),
    "click [data-ftoday]": (e, el, ctx) => { const s = ctx.state; if (s.view === "month") s.cal = null; s.date = null; reload(ctx); },
    "click [data-day3]": (e, el, ctx) => { const s = ctx.state; s.date = addDays(s.date, 3 * Number(el.dataset.day3)); reload(ctx); },
    "click [data-view]": (e, el, ctx) => setView(ctx, el.dataset.view),
    "click [data-fview]": (e, el, ctx) => setView(ctx, el.dataset.fview),
    "click [data-by]": (e, el, ctx) => { const s = ctx.state; s.by = el.dataset.by === "sales" ? "sales" : "tech"; reload(ctx); },
    "click [data-totray]": (e, el, ctx) => toTray(ctx),
    "click [data-pending]": (e, el, ctx) => pendingPage(ctx),
    "click [data-maphide]": (e, el, ctx) => { const s = ctx.state; const h = new Set(s.mapHide || []); if (h.has(el.dataset.maphide)) h.delete(el.dataset.maphide); else h.add(el.dataset.maphide); s.mapHide = [...h]; paint(ctx); },
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
    "click [data-schedset]": (e, el, ctx) => ctx.go("/settings/schedule"),
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
    // a phone: a long press on a visit is the desk's drag, "Move or reassign" (a tap still opens it)
    "pointerdown [data-vopen]": (e, el, ctx) => {
      if (wide() || !canWrite(ctx) || (e.pointerType === "mouse" && e.button > 0)) return;
      if (press) clearTimeout(press.t);
      // (a long press on the visit's address line copies the address instead: core/ui.js)
      if (e.target && e.target.closest && e.target.closest("[data-address]")) { press = null; return; }
      const id = el.dataset.vopen;
      press = { id, x: e.clientX, y: e.clientY, fired: false };
      press.t = setTimeout(() => {
        if (!press || press.id !== id) return;
        press.fired = true;
        // the click that ends this press is eaten (above); a later tap opens visits again
        const p0 = press;
        document.addEventListener("pointerup", () => setTimeout(() => { if (press === p0) press = null; }, 350), { once: true, capture: true });
        try { navigator.vibrate && navigator.vibrate(12); } catch (x) { /* fine */ }
        pressSheet(ctx, id);
      }, LONG_PRESS_MS);
    },
    "pointermove [data-vopen]": (e) => { if (press && !press.fired && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) { clearTimeout(press.t); press = null; } },
    "pointerup [data-vopen]": () => { if (press && !press.fired) { clearTimeout(press.t); press = null; } },
    "pointercancel [data-vopen]": () => { if (press && !press.fired) { clearTimeout(press.t); press = null; } },
    "contextmenu [data-vopen]": (e) => { if (!wide()) e.preventDefault(); },
    // a visit on a desk: the side panel (a modified click still opens it the browser's way)
    "click [data-vopen]": (e, el, ctx) => {
      // (the click that ends a long press opens nothing: the sheet is up)
      if (press && press.fired) { e.preventDefault(); press = null; return; }
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
