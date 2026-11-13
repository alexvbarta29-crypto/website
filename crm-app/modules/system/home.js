// Home: the first screen the office sees (the owner's Nov 12 choice: Rotor's
// phone Home with the best of Flyra's, as cards each person shows, hides
// and orders with Edit Home, saved on the server). One read (GET /home)
// brings the header and the data of the cards that are on:
//
//   the avatar, "Welcome back, {first name}", the date, the bell
//   Clock in     TIMESHEET, today's hours, Clock In / Clock Out (POST /clock)
//   Money        Collected | Scheduled | ARR, a period (This week, This
//                month, Last 3 months, This year, Custom range), the big
//                number with AVG / PEAK (or CHANGE for ARR), the month's
//                goal, one line chart, where the numbers come from
//   Today        Daily | Weekly | Monthly with arrows, the visits (a color
//                bar per tech, customer, "Job · 8:00 AM – 12:00 PM", who,
//                the time), and TASKS WITHOUT DUE DATE (folds)
//   (added in Edit Home) Leaderboard (the reports module's, when it is
//                there), Inbox, Tasks (Upcoming ▾, Add), Goals (owners add)
//   Edit Home    show, hide and order the cards
//
// A tech never comes here (today.js keeps their own day). Creating is the
// shell's New / + button.

import { html, icon, attrs, toast, sheet, delegate } from "../../core/ui.js";
import { dateLong, dateShort, plural, dateTime, initials, clock, time as fmtTime, ago, localDate } from "../../core/format.js";
import { uuid } from "../../core/api.js";
import * as router from "../../core/router.js";
import { lineChart, srTable } from "./home-charts.js";

// The stylesheet, loaded once; the screen waits for it (a second at most),
// so its first paint is already laid out and the chart measures its card.
let styled = null;
function ensureStyles() {
  if (typeof document === "undefined") return Promise.resolve();
  if (!styled) {
    styled = new Promise((ok) => {
      const l = document.createElement("link");
      l.rel = "stylesheet";
      l.href = "/crm-app/modules/system/home.css";
      l.addEventListener("load", () => ok());
      l.addEventListener("error", () => ok());
      setTimeout(ok, 1000);
      document.head.appendChild(l);
    });
  }
  return styled;
}

// ------------------------------------------------------------ how numbers read

// "$10,453" (whole dollars: a dashboard number, not an invoice); null → "-"
export const usd = (cents) => {
  if (cents === null || cents === undefined || !Number.isFinite(Number(cents))) return "-";
  const n = Math.round(Number(cents) / 100);
  return (n < 0 ? "−$" : "$") + Math.abs(n).toLocaleString("en-US");
};
// "$6K", "$12.5K", "$1.2M" (axis ticks)
export const usdShort = (cents) => {
  const d = (Number(cents) || 0) / 100;
  if (Math.abs(d) >= 1e6) return `$${+(d / 1e6).toFixed(1)}M`;
  if (Math.abs(d) >= 1000) return `$${+(d / 1000).toFixed(d % 1000 ? 1 : 0)}K`;
  return `$${Math.round(d)}`;
};
const signed = (cents) => (cents === null || cents === undefined ? "-" : (cents > 0 ? "+" : "") + usd(cents));
// "0h 0m"
export const hoursMin = (min) => { const m = Math.max(0, Math.round(Number(min) || 0)); return `${Math.floor(m / 60)}h ${m % 60}m`; };
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const day = (ymd) => `${MONTHS[Number(ymd.slice(5, 7)) - 1].slice(0, 3)} ${Number(ymd.slice(8, 10))}`;
const addDays = (ymd, n) => new Date(Date.parse(ymd + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const addMonths = (ymd, n) => { const t = Number(ymd.slice(0, 4)) * 12 + Number(ymd.slice(5, 7)) - 1 + n; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}-01`; };
const monday = (ymd) => addDays(ymd, -((new Date(ymd + "T12:00:00Z").getUTCDay() + 6) % 7));
// "8:00 AM – 12:00 PM", "12:00 – 2:00 PM"
export function timeRange(start, end) {
  if (!start) return "Any time";
  const a = clock(start), b = end ? clock(end) : "";
  if (!b) return a;
  const [at, ap] = a.split(" "), [bt, bp] = b.split(" ");
  return ap === bp ? `${at} – ${bt} ${bp}` : `${a} – ${b}`;
}
const colorOk = (c) => /^#[0-9a-f]{6}$/i.test(c || "");
// Home's own small icons (the shared set has no chevrons or play/stop)
const svg = (d) => html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const LOCAL = {
  play: svg(html`<path d="M8 5.5v13l10.5-6.5z"/>`),
  stop: svg(html`<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>`),
  "chevron-down": svg(html`<path d="m6 9 6 6 6-6"/>`),
  "chevron-up": svg(html`<path d="m6 15 6-6 6 6"/>`),
  "chevron-left": svg(html`<path d="m15 6-6 6 6 6"/>`),
  "chevron-right": svg(html`<path d="m9 6 6 6-6 6"/>`),
};
const ic = (name) => LOCAL[name] || icon(name);
const avatar = (p, cls = "hm-av") => html`<span class="${cls}" ${attrs({ style: colorOk(p.color) ? `background:${p.color}` : null, title: p.name || null })} aria-hidden="true">${initials(p.name || p.first_name)}</span>`;

// ------------------------------------------------------------ where a tap goes

const open = (ctx, path) => {
  const m = path && router.match(path.split("?")[0]);
  return m && (!m.route.perm || ctx.can(m.route.perm)) ? "#" + path : null;
};

// ------------------------------------------------------------ the cards' names (Edit Home)

const CARD_NAMES = { clock: "Clock in", money: "Money", agenda: "Today", leaderboard: "Leaderboard", inbox: "Inbox", tasks: "Tasks", goals: "Goals" };
const CARD_NOTES = { clock: "Today's hours and the clock", money: "Collected, scheduled and ARR", agenda: "Visits and tasks without a due date", leaderboard: "Sales and techs this month", inbox: "The latest conversations", tasks: "Upcoming and overdue tasks", goals: "Monthly revenue and jobs goals" };

// ------------------------------------------------------------ Clock in

function clockCard(s, ctx) {
  const c = s.home.cards.clock;
  if (!c) return "";
  const on = !!c.open;
  const time = open(ctx, "/time");
  return html`<section class="hm-card hm-c-clock" data-card="clock" aria-labelledby="hm-clock-h">
    <div class="hm-clock">
      <span class="hm-tile" aria-hidden="true">${icon("time")}</span>
      <div class="hm-clock-main">
        <div class="hm-eyebrow"><span class="${"hm-dot" + (on ? " on" : "")}" aria-hidden="true"></span><span id="hm-clock-h">Timesheet</span></div>
        <div class="hm-hours" ${attrs({ "data-since": on ? c.open.start_at : null, "data-base": String(c.minutes || 0) })}>${hoursMin(c.minutes)}</div>
        <p class="hm-line">${on ? `On the clock since ${fmtTime(c.open.start_at)}${c.open.category && c.open.category !== "service" ? ` · ${c.open.category === "sales" ? "Sales" : "Office"}` : ""}` : "Choose a role when you clock in"}</p>
      </div>
      ${time ? html`<a class="hm-round" href="${time}" aria-label="Open your time">${icon("link")}</a>` : ""}
    </div>
    <div class="hm-clock-act"><button type="button" class="hm-pill" data-hm="clock" data-act="${on ? "out" : "in"}">${ic(on ? "stop" : "play")}${on ? "Clock Out" : "Clock In"}</button></div>
  </section>`;
}

function pickRole() {
  return new Promise((resolve) => {
    let picked = null;
    const sh = sheet({
      title: "Clock in for",
      body: html`<ul class="hm-pick">${[["service", "Service", "Visits and field work"], ["sales", "Sales", "Estimates and sales calls"], ["office", "Office", "Office work"]].map(([k, l, n]) => html`<li><button type="button" class="btn block" ${attrs({ "data-role": k })}><b>${l}</b><small>${n}</small></button></li>`)}</ul>`,
      onClose: () => resolve(picked),
      events: { "click [data-role]": (e, b) => { picked = b.dataset.role; sh.close(); } },
    });
  });
}

async function clockAction(action, ctx) {
  let category = "service";
  if (action === "in") { category = await pickRole(); if (!category) return; }
  try {
    const r = await ctx.api("/clock", { method: "POST", body: { action, ...(action === "in" ? { category } : {}), client_id: uuid(), client_at: new Date().toISOString() } });
    const d = (r && r.data) || {};
    toast(d.pending ? d.message || "It waits for the office." : d.already ? "You're already clocked in." : action === "in" ? "Clocked in" : "Clocked out");
  } catch (e) {
    toast((e && e.message) || "That didn't work.", { bad: true });
  }
  ctx.refresh();
}

// ------------------------------------------------------------ Money

const METRICS = [["collected", "Collected"], ["scheduled", "Scheduled"], ["arr", "ARR"]];
const PERIOD_NAMES = { week: "This week", month: "This month", "3m": "Last 3 months", year: "This year", custom: "Custom range" };
const MISSING = {
  "no-key": "Rotor's numbers show here once the office data key is set in Netlify (OFFICE_DATA_KEY).",
  "bad-key": "Rotor's numbers can't be opened with this site's office data key. Re-seal the dashboard snapshot (docs/DASHBOARD.md).",
};
const PEAK = { day: "Peak day", week: "Peak week", month: "Peak month" };

const seg = (name, items, current, label, cls = "") => html`<div class="${"hm-seg" + (cls ? " " + cls : "")}" role="group" aria-label="${label}">${items.map(([k, l]) => html`<button type="button" class="${k === current ? "on" : ""}" ${attrs({ "data-hm": name, "data-v": k, "aria-pressed": k === current ? "true" : "false" })}>${l}</button>`)}</div>`;

function moneyCard(s, ctx) {
  const m = s.home.cards.money;
  if (!m) return "";
  const ui = s.ui.money;
  const more = open(ctx, "/dashboard/money") || open(ctx, "/payments");
  const pts = (m.points || []).filter((x) => x.value !== null && x.value !== undefined);
  const chart = !m.loading && pts.length > 1 && pts.some((x) => x.value !== 0);
  const src = m.source === "rotor" ? (m.as_of ? `From Rotor · updated ${day(m.as_of)}` : "From Rotor") : m.updated_at ? `Updated ${fmtTime(m.updated_at)}` : "";
  const stats = m.metric === "arr"
    ? html`<div class="hm-stats"><div><span>Change</span><b class="${m.change > 0 ? "up" : m.change < 0 ? "down" : ""}">${signed(m.change)}</b></div></div>`
    : html`<div class="hm-stats"><div><span>Avg / day</span><b>${usd(m.avg)}</b></div><div><span>${PEAK[m.grain] || "Peak"}</span><b>${m.peak ? usd(m.peak.value) : "-"}</b></div></div>`;
  return html`<section class="hm-card hm-c-money" data-card="money" aria-label="Money">
    ${seg("metric", METRICS, ui.metric, "What to show", "full")}
    <div class="hm-row2">
      <div class="hm-eyebrow">${m.metric === "arr" ? "Annual recurring revenue" : m.label}</div>
      <div class="hm-menu-wrap"><button type="button" class="hm-period" data-hm="period" aria-haspopup="true" aria-expanded="${ui.menu ? "true" : "false"}">${ui.period === "custom" ? "Custom" : PERIOD_NAMES[ui.period]}${ic("chevron-down")}</button>
        ${ui.menu ? html`<ul class="hm-menu" role="menu">${["week", "month", "3m", "year"].map((k) => html`<li><button type="button" role="menuitemradio" ${attrs({ "data-hm": "pick-period", "data-v": k, "aria-checked": ui.period === k ? "true" : "false" })}><span class="ck" aria-hidden="true">${ui.period === k ? icon("check") : ""}</span>${PERIOD_NAMES[k]}</button></li>`)}<li class="sep"><button type="button" role="menuitem" data-hm="custom">Custom range…</button></li></ul>` : ""}
      </div>
    </div>
    <div class="hm-money-row"><div class="hm-big" ${attrs({ "aria-busy": m.loading ? "true" : null })}>${m.loading ? "…" : usd(m.total)}</div>${m.loading ? "" : stats}</div>
    ${m.goal ? html`<div class="hm-goal"><span class="hm-track" aria-hidden="true"><span class="hm-fill" ${attrs({ style: `width:${Math.min(100, Math.max(0, m.goal.pct || 0))}%` })}></span></span><span>${m.goal.pct}% of the ${usd(m.goal.target)} goal</span></div>` : ""}
    ${m.missing ? html`<p class="hm-note">${MISSING[m.missing] || "Rotor's numbers aren't in yet."}</p>` : ""}
    ${chart ? html`<div class="hc-head"><span class="hc-read" id="read-money" aria-live="polite"><b></b> <span></span></span></div>
      <div class="hc" data-chart="money" tabindex="0" role="group" aria-label="${`${METRICS.find((x) => x[0] === m.metric)[1]} over ${m.label}. Arrow keys read each point.`}"></div>
      ${srTable(`${METRICS.find((x) => x[0] === m.metric)[1]}, ${m.label}`, [m.grain === "month" ? "Month" : m.grain === "week" ? "Week of" : "Day", "Amount"], pts.map((x) => [x.label, usd(x.value)]))}`
      : m.loading || m.missing || m.total === null ? "" : html`<p class="hm-note">${m.metric === "arr" ? "No plans have started yet." : m.metric === "scheduled" ? "Nothing booked in this period." : "Nothing collected yet in this period."}</p>`}
    <div class="hm-foot"><span>${src}</span>${more ? html`<a class="hm-more" href="${more}">See more</a>` : ""}</div>
  </section>`;
}

async function loadMoney(s, ctx) {
  const ui = s.ui.money;
  const q = new URLSearchParams({ metric: ui.metric, period: ui.period, ...(ui.period === "custom" ? { from: ui.from, to: ui.to } : {}) });
  const my = (s.moneyToken = (s.moneyToken || 0) + 1);
  s.home.cards.money = { ...(s.home.cards.money || {}), metric: ui.metric, loading: true };
  ctx.rerender();
  try {
    const r = await ctx.api(`/home/money?${q}`, { cache: false });
    if (my === s.moneyToken) s.home.cards.money = r.data;
  } catch (e) {
    if (my === s.moneyToken) { s.home.cards.money = { ...s.home.cards.money, loading: false, total: null, points: [] }; toast((e && e.message) || "That didn't load.", { bad: true }); }
  }
  if (my === s.moneyToken) ctx.rerender();
}

function customRange(s, ctx) {
  const today = localDate(s.now);
  const sh = sheet({
    title: "Custom range",
    body: html`<form class="form" data-range>
      <label class="field"><span>First day</span><input type="date" name="from" required value="${s.ui.money.from || addDays(today, -29)}" max="${today}"></label>
      <label class="field"><span>Last day</span><input type="date" name="to" required value="${s.ui.money.to || today}"></label>
      <button type="submit" class="btn primary block">Show</button></form>`,
    events: {
      "submit [data-range]": (e, f) => {
        e.preventDefault();
        const from = f.elements.from.value, to = f.elements.to.value;
        if (!from || !to || to < from) { toast("The last day comes after the first.", { bad: true }); return; }
        Object.assign(s.ui.money, { period: "custom", from, to, menu: false });
        sh.close();
        loadMoney(s, ctx);
      },
    },
  });
}

// ------------------------------------------------------------ Today (the agenda)

const VIEWS = [["day", "Daily"], ["week", "Weekly"], ["month", "Monthly"]];
const STATUS_WORD = { en_route: "On the way", in_progress: "Working", paused: "Paused", completed: "Done" };
const TASK_PILL = { open: ["Open", "blue"], in_progress: ["In progress", "amber"], waiting: ["Waiting", ""] };

function agendaTitle(a) {
  if (a.view === "week") return a.from.slice(0, 7) === a.to.slice(0, 7) ? `${day(a.from)} – ${Number(a.to.slice(8, 10))}` : `${day(a.from)} – ${day(a.to)}`;
  if (a.view === "month") return `${MONTHS[Number(a.from.slice(5, 7)) - 1]} ${a.from.slice(0, 4)}`;
  return dateLong(a.date);
}
function agendaRow(v, ctx) {
  const href = open(ctx, `/visits/${v.id}`);
  const first = (v.people || [])[0];
  const bar = first && colorOk(first.color) ? first.color : "#b9b9c2";
  const word = STATUS_WORD[v.status];
  const body = html`<span class="who"><b>${v.name || "Customer"}</b><small>${v.kind} · ${v.date_only ? "Any time" : timeRange(v.start, v.end)}${word ? ` · ${word}` : ""}</small></span>
    <span class="hm-avs">${(v.people || []).slice(0, 3).map((p) => avatar(p, "hm-av sm"))}${(v.people || []).length ? html`<span class="sr">${v.people.map((p) => p.first_name || p.name).join(", ")}</span>` : html`<span class="sr">Nobody assigned</span>`}</span>
    <span class="hm-time">${v.date_only ? "Any time" : clock(v.start)}</span><span class="chev" aria-hidden="true"></span>`;
  const cls = "hm-item" + (v.status === "completed" ? " done" : "");
  return html`<li>${href ? html`<a class="${cls}" href="${href}" ${attrs({ style: `--bar:${bar}` })}>${body}</a>` : html`<div class="${cls}" ${attrs({ style: `--bar:${bar}` })}>${body}</div>`}</li>`;
}
function agendaCard(s, ctx) {
  const a = s.home.cards.agenda;
  if (!a) return "";
  const items = a.items || [];
  let rows;
  if (a.view === "day") rows = html`<ul class="hm-items">${items.map((v) => agendaRow(v, ctx))}</ul>`;
  else {
    const days = [...new Set(items.map((v) => v.date))];
    rows = days.map((d) => html`<h4 class="hm-day">${dateShort(d)}</h4><ul class="hm-items">${items.filter((v) => v.date === d).map((v) => agendaRow(v, ctx))}</ul>`);
  }
  const tasks = a.tasks;
  const openT = s.ui.tasksOpen;
  const word = a.view === "day" ? (a.date === localDate(s.now) ? "today" : "that day") : a.view === "week" ? "that week" : "that month";
  return html`<section class="hm-card hm-c-agenda" data-card="agenda" aria-labelledby="hm-ag-h">
    ${seg("view", VIEWS, a.view, "Daily, weekly or monthly", "full")}
    <div class="hm-ag-head"><div class="t"><h3 id="hm-ag-h">${agendaTitle(a)}</h3><span>${a.loading ? "…" : plural(a.count || 0, "item")}</span></div>
      <div class="hm-arrows"><button type="button" class="hm-round" data-hm="ag-move" data-v="-1" aria-label="Earlier">${ic("chevron-left")}</button><button type="button" class="hm-round" data-hm="ag-move" data-v="1" aria-label="Later">${ic("chevron-right")}</button></div></div>
    ${a.loading ? html`<p class="hm-note" aria-busy="true">Loading…</p>` : items.length ? rows : html`<div class="hm-empty"><span class="art">${icon("schedule")}</span><b>Nothing scheduled for ${word}</b><p>Visits show up here as they're booked.</p></div>`}
    ${(a.count || 0) > items.length ? html`<a class="hm-more-row" href="${open(ctx, "/schedule") || "#/schedule"}">${plural(a.count - items.length, "more visit")} on the Schedule</a>` : ""}
    ${tasks && tasks.length ? html`<div class="hm-tasks">
      <button type="button" class="hm-tasks-h" data-hm="tasks-fold" aria-expanded="${openT ? "true" : "false"}"><span>Tasks without due date <b>${tasks.length}</b></span>${ic(openT ? "chevron-up" : "chevron-down")}</button>
      ${openT ? html`<ul class="hm-task-list">${tasks.slice(0, 20).map((t) => taskRow(t, ctx))}</ul>` : ""}</div>` : ""}
  </section>`;
}
function taskRow(t, ctx, { due = false } = {}) {
  const pill = TASK_PILL[t.status] || ["Open", "blue"];
  const href = open(ctx, `/tasks/${t.id}`);
  const late = t.due && Date.parse(t.due) < Date.now();
  const body = html`<span class="who"><b>${t.title}</b>${due && t.due ? html`<small class="${late ? "late" : ""}">${late ? "Overdue · " : ""}${dateTime(t.due)}</small>` : t.contact ? html`<small>${t.contact}</small>` : ""}</span><span class="${"pill " + pill[1]}">${pill[0]}</span>`;
  return html`<li>${href ? html`<a class="hm-task" href="${href}">${body}</a>` : html`<div class="hm-task">${body}</div>`}</li>`;
}

async function loadAgenda(s, ctx, view, date) {
  const tasks = s.home.cards.agenda.tasks;
  const my = (s.agendaToken = (s.agendaToken || 0) + 1);
  s.home.cards.agenda = { ...s.home.cards.agenda, view, date, loading: true };
  ctx.rerender();
  try {
    const r = await ctx.api(`/home/agenda?${new URLSearchParams({ view, date })}`, { cache: false });
    if (my === s.agendaToken) s.home.cards.agenda = { ...r.data, tasks };
  } catch (e) {
    if (my === s.agendaToken) { s.home.cards.agenda = { ...s.home.cards.agenda, loading: false, items: [], count: 0 }; toast((e && e.message) || "That didn't load.", { bad: true }); }
  }
  if (my === s.agendaToken) ctx.rerender();
}
function moveAgenda(s, ctx, dir) {
  const a = s.home.cards.agenda;
  const d = a.view === "month" ? addMonths(a.date, dir) : a.view === "week" ? addDays(monday(a.date), 7 * dir) : addDays(a.date, dir);
  loadAgenda(s, ctx, a.view, d);
}

// ------------------------------------------------------------ the cards added in Edit Home

function leaderboardCard(s, ctx) {
  const b = s.home.cards.leaderboard;
  if (!b) return "";
  const rows = b.rows || [];
  const full = open(ctx, "/leaderboard");
  return html`<section class="hm-card hm-c-board" data-card="leaderboard" aria-labelledby="hm-lb-h">
    <div class="hm-bar"><h3 id="hm-lb-h">${b.title || "Leaderboard"}</h3>${seg("board", [["sales", "Sales"], ["techs", "Techs"]], b.board || "sales", "Sales or techs")}</div>
    ${rows.length ? html`<ol class="hm-board">${rows.map((r) => html`<li><span class="rank">${r.rank}</span>${avatar(r)}<span class="who"><b>${r.name || "Someone"}</b>${r.note ? html`<small>${r.note}</small>` : ""}</span><span class="val">${usd(r.value)}${r.unit ? html` <small>${r.unit}</small>` : ""}</span></li>`)}</ol>`
      : html`<div class="hm-empty"><span class="art">${icon("chart")}</span><b>Nobody on the board yet</b><p>${b.board === "techs" ? "Jobs done this month show here." : "Plans and quotes sold this month show here."}</p></div>`}
    ${full ? html`<div class="hm-foot"><span></span><a class="hm-more" href="${full}">See the leaderboard</a></div>` : ""}
  </section>`;
}

function inboxCard(s, ctx) {
  const c = s.home.cards.inbox;
  if (!c) return "";
  const items = c.items || [];
  const all = open(ctx, "/inbox");
  return html`<section class="hm-card hm-c-inbox" data-card="inbox" aria-labelledby="hm-in-h">
    <div class="hm-bar"><h3 id="hm-in-h">Inbox</h3>${all ? html`<a class="hm-more" href="${all}">Open</a>` : ""}</div>
    ${items.length ? html`<ul class="hm-convs">${items.map((v) => { const href = open(ctx, `/inbox/${v.id}`); const body = html`${avatar({ name: v.name })}<span class="who"><b>${v.name}</b><small>${v.preview}</small></span><span class="end"><small>${v.at ? ago(v.at) : ""}</small>${v.unread ? html`<span class="hm-unread" aria-label="${`${v.unread} unread`}"></span>` : ""}</span>`; return html`<li>${href ? html`<a class="${"hm-conv" + (v.unread ? " unread" : "")}" href="${href}">${body}</a>` : html`<div class="hm-conv">${body}</div>`}</li>`; })}</ul>`
      : html`<div class="hm-empty"><span class="art">${icon("inbox")}</span><b>No recent conversations</b><p>New conversations will appear here.</p></div>`}
  </section>`;
}

const TASK_FILTERS = [["upcoming", "Upcoming"], ["overdue", "Overdue"], ["none", "No due date"], ["all", "All"]];
function tasksCard(s, ctx) {
  const c = s.home.cards.tasks;
  if (!c) return "";
  const f = s.ui.taskFilter;
  const nowMs = Date.now();
  const items = (c.items || []).filter((t) => (f === "upcoming" ? t.due && Date.parse(t.due) >= nowMs : f === "overdue" ? t.due && Date.parse(t.due) < nowMs : f === "none" ? !t.due : true));
  const add = c.can_add ? open(ctx, "/tasks/new") : null;
  return html`<section class="hm-card hm-c-tasks" data-card="tasks" aria-labelledby="hm-tk-h">
    <div class="hm-bar"><h3 id="hm-tk-h">Tasks</h3><span class="hm-bar-end">
      <label class="hm-select"><span class="sr">Which tasks</span><select data-hm-change="task-filter">${TASK_FILTERS.map(([k, l]) => html`<option value="${k}" ${attrs({ selected: k === f })}>${l}</option>`)}</select>${ic("chevron-down")}</label>
      ${add ? html`<a class="hm-chip" href="${add}">Add</a>` : ""}</span></div>
    ${items.length ? html`<ul class="hm-task-list">${items.slice(0, 8).map((t) => taskRow(t, ctx, { due: true }))}</ul>`
      : html`<div class="hm-empty"><span class="art">${icon("check")}</span><b>No tasks found</b></div>`}
  </section>`;
}

function goalsCard(s, ctx) {
  const g = s.home.cards.goals;
  if (!g) return "";
  const rows = [];
  if (g.revenue) rows.push(["Revenue this month", g.revenue.value, g.revenue.target, usd]);
  if (g.jobs) rows.push(["Jobs this month", g.jobs.value, g.jobs.target, (n) => (n === null || n === undefined ? "-" : Number(n).toLocaleString("en-US"))]);
  return html`<section class="hm-card hm-c-goals" data-card="goals" aria-labelledby="hm-gl-h">
    <div class="hm-bar"><h3 id="hm-gl-h">Goals</h3>${g.can_edit ? html`<button type="button" class="hm-chip" data-hm="goals">${rows.length ? "Edit" : "Add"}</button>` : ""}</div>
    ${rows.length ? html`<ul class="hm-goals">${rows.map(([label, v, target, fmt]) => { const p = v === null || v === undefined ? null : Math.round((v / target) * 100); return html`<li><div class="hm-goal-h"><span>${label}</span><b>${fmt(v)} <small>of ${fmt(target)}</small></b></div><span class="hm-track" aria-hidden="true"><span class="hm-fill" ${attrs({ style: `width:${Math.min(100, Math.max(0, p || 0))}%` })}></span></span><small class="hm-pct">${p === null ? "Not counted yet" : `${p}%`}</small></li>`; })}</ul>`
      : html`<div class="hm-empty"><b>No goals yet</b><p>${g.can_edit ? "Tap Add to set a monthly revenue or jobs goal and track progress here." : "An owner can set a monthly revenue or jobs goal."}</p></div>`}
  </section>`;
}

async function editGoals(ctx) {
  let doc;
  try { doc = (await ctx.api("/settings/goals", { cache: false })).data; } catch (e) { toast((e && e.message) || "That didn't load.", { bad: true }); return; }
  const g = doc.data || {};
  const sh = sheet({
    title: "Monthly goals",
    body: html`<form class="form" data-goals>
      <label class="field"><span>Revenue a month ($)</span><input type="number" name="revenue" inputmode="numeric" min="1" step="1" value="${g.revenue_month_cents ? String(Math.round(g.revenue_month_cents / 100)) : ""}" placeholder="No goal"></label>
      <label class="field"><span>Jobs completed a month</span><input type="number" name="jobs" inputmode="numeric" min="1" step="1" value="${g.jobs_month ? String(g.jobs_month) : ""}" placeholder="No goal"></label>
      <p class="small">Leave one empty for no goal. Progress shows on the Goals card, and the revenue goal under Money for this month.</p>
      <button type="submit" class="btn primary block">Save goals</button></form>`,
    events: {
      "submit [data-goals]": async (e, f) => {
        e.preventDefault();
        const n = (v) => (String(v || "").trim() === "" ? null : Math.round(Number(v)));
        const rev = n(f.elements.revenue.value), jobs = n(f.elements.jobs.value);
        if ((rev !== null && !(rev >= 1)) || (jobs !== null && !(jobs >= 1))) { toast("Whole numbers from 1, or empty.", { bad: true }); return; }
        try {
          await ctx.api("/settings/goals", { method: "PUT", ifMatch: doc.etag || "new", body: { revenue_month_cents: rev === null ? null : rev * 100, jobs_month: jobs } });
          sh.close();
          toast("Goals saved");
          ctx.refresh();
        } catch (err) { toast((err && err.message) || "That didn't save.", { bad: true }); }
      },
    },
  });
}

// ------------------------------------------------------------ Edit Home

function editHome(s, ctx) {
  const cards = s.home.layout || [];
  if (!cards.length) return;
  const sh = sheet({
    title: "Edit Home",
    body: html`<p class="small">Show the cards you want, in your order. Only you see this.</p>
      <ul class="hm-edit-list">${cards.map((c) => html`<li ${attrs({ "data-key": c.key })}>
        <label class="hm-switch"><input type="checkbox" ${attrs({ checked: c.on })}><span class="who"><b>${CARD_NAMES[c.key] || c.key}</b><small>${CARD_NOTES[c.key] || ""}</small></span></label>
        <button type="button" class="hm-round sm" data-mv="-1" aria-label="${`Move ${CARD_NAMES[c.key]} up`}">${ic("chevron-up")}</button><button type="button" class="hm-round sm" data-mv="1" aria-label="${`Move ${CARD_NAMES[c.key]} down`}">${ic("chevron-down")}</button>
      </li>`)}</ul>
      <button type="button" class="btn primary block" data-save>Save</button>`,
    events: {
      "click [data-mv]": (e, b) => {
        const li = b.closest("li");
        if (b.dataset.mv === "-1" && li.previousElementSibling) li.parentNode.insertBefore(li, li.previousElementSibling);
        else if (b.dataset.mv === "1" && li.nextElementSibling) li.parentNode.insertBefore(li.nextElementSibling, li);
        b.focus();
      },
      "click [data-save]": async (e, b, root) => {
        const list = (b.closest(".sheet") || document).querySelectorAll(".hm-edit-list li");
        const next = [...list].map((li) => ({ key: li.dataset.key, on: li.querySelector("input").checked }));
        b.disabled = true;
        try {
          await ctx.api("/home/layout", { method: "PUT", body: { cards: next } });
          sh.close();
          toast("Home saved");
          ctx.refresh();
        } catch (err) { b.disabled = false; toast((err && err.message) || "That didn't save.", { bad: true }); }
      },
    },
  });
}

// ------------------------------------------------------------ the screen

const DRAW = { clock: clockCard, money: moneyCard, agenda: agendaCard, leaderboard: leaderboardCard, inbox: inboxCard, tasks: tasksCard, goals: goalsCard };
const FOLD_KEY = "barta-home-tasks-open";
const remembered = () => { try { return localStorage.getItem(FOLD_KEY) !== "0"; } catch (e) { return true; } };

export default {
  title: "Home",
  async load(params, ctx) {
    const [, home] = await Promise.all([ensureStyles(), ctx.api("/home").then((r) => r.data)]);
    // the server's clock and day (a phone's may be off)
    const now = home && home.now && Number.isFinite(Date.parse(home.now)) ? new Date(home.now) : new Date();
    const h = home || {};
    h.cards = h.cards || {};
    return {
      now, user: ctx.user || {}, home: h,
      ui: { money: { metric: "collected", period: "month", menu: false }, taskFilter: "upcoming", tasksOpen: remembered() },
      edit: typeof location !== "undefined" && /[?&]edit=1\b/.test(location.hash),
    };
  },
  render(s, ctx) {
    const u = s.home.user || s.user || {};
    const first = u.first_name || (u.name || "").split(" ")[0] || "there";
    const n = Number(s.home.notifications) || 0;
    const mode = s.home.mode || {};
    const shown = (s.home.layout || []).filter((c) => c.on && DRAW[c.key] && s.home.cards[c.key]);
    return html`<div class="stack hm">
      <header class="hm-head">
        ${avatar({ name: u.name || first, first_name: first, color: u.color }, "hm-av lg")}
        <div class="hm-hello"><h2>Welcome back, ${first}</h2><div class="date">${dateLong(s.now)}</div></div>
        <a class="hm-round bell" href="#/notifications" aria-label="${n ? `Notifications, ${n} new` : "Notifications"}">${icon("bell")}${n ? html`<span class="badge">${n > 99 ? "99+" : n}</span>` : ""}</a>
      </header>
      ${mode.paused ? html`<a class="card alert hm-alert" href="#/settings/data"><h2>The CRM is paused</h2><p>${mode.paused_reason === "restore" ? "A backup was restored. " : ""}Nothing is texted, emailed, charged or automated${mode.paused_at ? ` since ${dateTime(mode.paused_at)}` : ""}. An owner resumes it on Settings → Data.</p></a>` : ""}
      <div class="hm-grid">${shown.map((c) => DRAW[c.key](s, ctx))}</div>
      ${shown.length ? "" : html`<div class="hm-card hm-empty"><b>Your Home is empty</b><p>Pick the cards you want with Edit Home.</p></div>`}
      ${(s.home.layout || []).length ? html`<div class="hm-edit"><button type="button" class="hm-chip" data-hm="edit">${icon("gear")}Edit Home</button></div>` : ""}
    </div>`;
  },
  mount(view, s, ctx) {
    if (this._off) { this._off(); this._off = null; }
    const root = view.querySelector(".hm");
    if (!root || !ctx) return;
    const off = [];
    off.push(delegate(root, {
      "click [data-hm]": (e, el) => {
        const what = el.dataset.hm, v = el.dataset.v;
        if (what !== "period" && what !== "pick-period" && s.ui.money.menu) s.ui.money.menu = false;
        if (what === "clock") return clockAction(el.dataset.act, ctx);
        if (what === "metric") { if (s.ui.money.metric !== v) { s.ui.money.metric = v; loadMoney(s, ctx); } return; }
        if (what === "period") { s.ui.money.menu = !s.ui.money.menu; ctx.rerender(); return; }
        if (what === "pick-period") { s.ui.money.menu = false; s.ui.money.period = v; loadMoney(s, ctx); return; }
        if (what === "custom") { s.ui.money.menu = false; ctx.rerender(); customRange(s, ctx); return; }
        if (what === "view") { const a = s.home.cards.agenda; if (a.view !== v) loadAgenda(s, ctx, v, a.date); return; }
        if (what === "ag-move") { moveAgenda(s, ctx, Number(v)); return; }
        if (what === "tasks-fold") { s.ui.tasksOpen = !s.ui.tasksOpen; try { localStorage.setItem(FOLD_KEY, s.ui.tasksOpen ? "1" : "0"); } catch (x) { /* no storage */ } ctx.rerender(); return; }
        if (what === "board") { loadBoard(s, ctx, v); return; }
        if (what === "goals") { editGoals(ctx); return; }
        if (what === "edit") { editHome(s, ctx); return; }
      },
      "change [data-hm-change]": (e, el) => { if (el.dataset.hmChange === "task-filter") { s.ui.taskFilter = el.value; ctx.rerender(); } },
      // a tap anywhere else closes the period menu
      "click": (e) => { if (s.ui.money.menu && !e.target.closest(".hm-menu-wrap")) { s.ui.money.menu = false; ctx.rerender(); } },
    }));
    // the chart
    const m = s.home.cards.money;
    const el = root.querySelector('[data-chart="money"]');
    if (m && el) {
      // Rotor's week or month that runs past its snapshot's day is "so far"
      const sofar = (x) => (m.as_of && x.to > m.as_of ? ", so far" : "");
      const read = (x) => (m.grain === "week" ? `week of ${x.label}${sofar(x)}` : m.grain === "month" ? `${x.label}${sofar(x)}` : x.label);
      off.push(lineChart(el, { rows: m.points, fmt: usd, axis: usdShort, read, readout: root.querySelector("#read-money"), height: 168, start: localDate(s.now) }).destroy);
    }
    // the clock's hours move on while Home is on screen
    const hours = root.querySelector(".hm-hours[data-since]");
    if (hours) {
      const base = Number(hours.dataset.base) || 0, t0 = Date.now();
      const timer = setInterval(() => { hours.textContent = hoursMin(base + (Date.now() - t0) / 60000); }, 30000);
      off.push(() => clearInterval(timer));
    }
    if (s.edit) { s.edit = false; setTimeout(() => editHome(s, ctx), 0); }
    this._off = () => off.forEach((f) => { try { f(); } catch (x) { /* gone */ } });
  },
  unmount() { if (this._off) { this._off(); this._off = null; } },
};

async function loadBoard(s, ctx, board) {
  const b = s.home.cards.leaderboard;
  if (!b || b.board === board) return;
  s.home.cards.leaderboard = { ...b, board, rows: [] };
  ctx.rerender();
  try {
    const r = await ctx.api(`/home/leaderboard?board=${encodeURIComponent(board)}`, { cache: false });
    if (r.data) s.home.cards.leaderboard = r.data;
  } catch (e) { toast((e && e.message) || "That didn't load.", { bad: true }); }
  ctx.rerender();
}
