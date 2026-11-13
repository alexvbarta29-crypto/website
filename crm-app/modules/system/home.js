// Home: the first screen the office sees (the owner's Nov 12 choice, cards
// each person shows, hides and orders with Edit Home, saved on the server;
// Nov 13: "make it look more like Flyra", so Flyra's Home: the greeting and
// the name big, the money on the canvas under them, then Flyra's cards).
// One read (GET /home) brings the header and the data of the cards that
// are on:
//
//   "Good evening", the first name, the bell
//   Clock in     TIMESHEET, today's hours, Clock In / Clock Out (POST /clock)
//   Money        Rotor's card (the owner's Nov 13 ask): Week | Month, the
//                round ‹ › arrows, share and fold; Collected and Scheduled
//                side by side; one chart with both lines per day (Collected
//                coral, Scheduled grey) and a readout on tap; where
//                Collected comes from; under the card the ARR and See more
//   Today        Daily | Weekly | Monthly with arrows, the visits (a color
//                bar per tech, customer, "Job · 8:00 AM – 12:00 PM", who,
//                the time), and TASKS WITHOUT DUE DATE (folds); Monthly is
//                a month calendar (dots per day) and the picked day's visits
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
import { pairChart, srTable } from "./home-charts.js";

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
// Flyra's greeting, by the hour in the company's zone
const HOUR = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", hourCycle: "h23" });
export const greeting = (d) => { const h = Number(HOUR.format(d instanceof Date ? d : new Date(d))) % 24; return h < 5 ? "Good evening" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening"; };
// Home's own small icons (the shared set has no chevrons or play/stop)
const svg = (d) => html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const LOCAL = {
  play: svg(html`<path d="M8 5.5v13l10.5-6.5z"/>`),
  stop: svg(html`<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>`),
  "chevron-down": svg(html`<path d="m6 9 6 6 6-6"/>`),
  "chevron-up": svg(html`<path d="m6 15 6-6 6 6"/>`),
  "chevron-left": svg(html`<path d="m15 6-6 6 6 6"/>`),
  "chevron-right": svg(html`<path d="m9 6 6 6-6 6"/>`),
  share: svg(html`<circle cx="18" cy="5.5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="18.5" r="2.5"/><path d="m8.2 10.8 7.6-4.1M8.2 13.2l7.6 4.1"/>`),
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
const CARD_NOTES = { clock: "Today's hours and the clock", money: "Collected and scheduled by week or month, and ARR", agenda: "Visits and tasks without a due date", leaderboard: "Sales and techs this month", inbox: "The latest conversations", tasks: "Upcoming and overdue tasks", goals: "Monthly revenue and jobs goals" };

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

// ------------------------------------------------------------ Money (Rotor's card)

const MISSING = {
  "no-key": "Rotor's numbers show here once the office data key is set in Netlify (OFFICE_DATA_KEY).",
  "bad-key": "Rotor's numbers can't be opened with this site's office data key. Re-seal the dashboard snapshot (docs/DASHBOARD.md).",
};
// a segmented switch (Week | Month, Daily | Weekly | Monthly, Sales | Techs)
const seg = (name, items, current, label, cls = "") => html`<div class="${"hm-seg" + (cls ? " " + cls : "")}" role="group" aria-label="${label}">${items.map(([k, l]) => html`<button type="button" class="${k === current ? "on" : ""}" ${attrs({ "data-hm": name, "data-v": k, "aria-pressed": k === current ? "true" : "false" })}>${l}</button>`)}</div>`;
const MONEY_PERIODS = [["week", "Week"], ["month", "Month"]];
const FOLD_MONEY = "barta-home-money-folded";
const moneyFolded = () => { try { return localStorage.getItem(FOLD_MONEY) === "1"; } catch (e) { return false; } };
// where Collected comes from (Scheduled and ARR are always the CRM's own)
export function moneyNote(m) {
  if (!m || m.loading) return "";
  if (m.source === "import") return m.as_of ? `From Rotor's import of ${day(m.as_of)}` : "From Rotor's import";
  if (m.source === "rotor") return m.as_of ? `From Rotor · updated ${day(m.as_of)}` : "From Rotor";
  return m.updated_at ? `Updated ${fmtTime(m.updated_at)}` : "";
}
// the period's days, and each line's value on them (null where it has no point)
export function moneySeries(m) {
  const keys = [];
  for (let d = m.from; d && d <= m.to && keys.length < 62; d = addDays(d, 1)) keys.push(d);
  const on = (pts) => { const by = new Map((pts || []).map((x) => [x.key, x])); return keys.map((k) => (by.has(k) && by.get(k).value !== null && by.get(k).value !== undefined ? by.get(k).value : null)); };
  return { keys, collected: on(m.collected && m.collected.points), scheduled: on(m.scheduled && m.scheduled.points) };
}
// a weekly point's words ("week of Nov 9"), a day's ("Nov 13")
const pointWords = (m, k) => (m.grain === "week" ? `Week of ${day(k)}` : day(k));
export const shareText = (m) => `${m.label}: Collected ${usd(m.collected && m.collected.total)}, Scheduled ${usd(m.scheduled && m.scheduled.total)}`;

function moneyCard(s, ctx) {
  const m = s.home.cards.money;
  if (!m) return "";
  const ui = s.ui.money;
  const more = open(ctx, "/dashboard/money") || open(ctx, "/payments");
  const loading = !!m.loading;
  const c = m.collected || {}, sc = m.scheduled || {};
  const ser = loading ? null : moneySeries(m);
  const drawn = !!ser && [...ser.collected, ...ser.scheduled].some((v) => v);
  const word = ui.period === "week" ? "week" : "month";
  const note = moneyNote(m);
  const big = (v) => (loading ? "…" : usd(v));
  const long = !loading && [c.total, sc.total].some((v) => usd(v).length > 7);
  return html`<div class="hm-money" data-card="money">
    <section class="hm-card hm-c-money" aria-labelledby="hm-m-h">
      <div class="hm-mtop">
        ${seg("m-period", MONEY_PERIODS, ui.period, "Week or month")}
        <div class="hm-mtools">
          <button type="button" class="hm-round" data-hm="m-move" data-v="-1" aria-label="${`Previous ${word}`}">${ic("chevron-left")}</button>
          <button type="button" class="hm-round" data-hm="m-move" data-v="1" aria-label="${`Next ${word}`}">${ic("chevron-right")}</button>
          <button type="button" class="hm-round" data-hm="m-share" aria-label="Share these numbers">${ic("share")}</button>
          <button type="button" class="hm-round" data-hm="m-fold" aria-expanded="${ui.folded ? "false" : "true"}" aria-label="${ui.folded ? "Show the chart" : "Fold the chart"}">${ic(ui.folded ? "chevron-down" : "chevron-up")}</button>
        </div>
      </div>
      <h3 class="hm-mper" id="hm-m-h">${m.label || ""}</h3>
      <div class="${"hm-pair" + (long ? " long" : "")}" ${attrs({ "aria-busy": loading ? "true" : null })}>
        <div class="hm-pv"><span>Collected</span><b>${big(c.total)}</b></div>
        <div class="hm-pv"><span>Scheduled</span><b>${big(sc.total)}</b></div>
      </div>
      ${m.missing ? html`<p class="hm-note">${MISSING[m.missing] || "Rotor's numbers aren't in yet."}</p>` : ""}
      ${ui.folded || loading ? "" : drawn ? html`<div class="hc-read2" id="read-money" aria-live="polite"><span class="d"></span><span class="k c"><i aria-hidden="true"></i>Collected <b></b></span><span class="k s"><i aria-hidden="true"></i>Scheduled <b></b></span></div>
        <div class="hc hc-pair" data-chart="money" tabindex="0" role="group" aria-label="${`Collected and scheduled, ${m.label}. Arrow keys read each ${m.grain === "week" ? "week" : "day"}.`}"></div>
        ${srTable(`Collected and scheduled, ${m.label}`, [m.grain === "week" ? "Week of" : "Day", "Collected", "Scheduled"], ser.keys.map((k, i) => [k, i]).filter(([, i]) => ser.collected[i] !== null || (ser.scheduled[i] !== null && (m.grain === "week" || ser.scheduled[i] !== 0))).map(([k, i]) => [day(k), ser.collected[i] === null ? "-" : usd(ser.collected[i]), ser.scheduled[i] === null ? "-" : usd(ser.scheduled[i])]))}`
        : m.missing ? "" : html`<p class="hm-note">Nothing collected or booked in this ${word}.</p>`}
      ${note ? html`<div class="hm-foot hm-mfoot"><span>${note}</span></div>` : ""}
    </section>
    ${m.arr !== null && m.arr !== undefined ? html`<p class="hm-arr"><span>ARR <b>${usd(m.arr)}</b></span>${more ? html`<span aria-hidden="true"> · </span><a class="hm-more" href="${more}">See more</a>` : ""}</p>`
      : more ? html`<p class="hm-arr"><a class="hm-more" href="${more}">See more</a></p>` : ""}
  </div>`;
}

async function loadMoney(s, ctx) {
  const ui = s.ui.money;
  const my = (s.moneyToken = (s.moneyToken || 0) + 1);
  s.home.cards.money = { ...(s.home.cards.money || {}), loading: true };
  ctx.rerender();
  try {
    const r = await ctx.api(`/home/money?${new URLSearchParams({ period: ui.period, date: ui.date })}`, { cache: false });
    if (my === s.moneyToken) s.home.cards.money = r.data;
  } catch (e) {
    if (my === s.moneyToken) { s.home.cards.money = { ...s.home.cards.money, loading: false, collected: { total: null, points: [] }, scheduled: { total: null, points: [] } }; toast((e && e.message) || "That didn't load.", { bad: true }); }
  }
  if (my === s.moneyToken) ctx.rerender();
}
// Week | Month keeps today when it is in the period on screen, else that period's first day
function pickMoneyPeriod(s, ctx, kind) {
  const m = s.home.cards.money || {};
  const t = localDate(s.now);
  s.ui.money.period = kind;
  s.ui.money.date = m.from && t >= m.from && t <= m.to ? t : m.from || t;
  loadMoney(s, ctx);
}
function moveMoney(s, ctx, dir) {
  const m = s.home.cards.money || {};
  const from = m.from || localDate(s.now);
  s.ui.money.date = s.ui.money.period === "week" ? addDays(monday(from), 7 * dir) : addMonths(from, dir);
  loadMoney(s, ctx);
}
async function shareMoney(m) {
  if (!m || m.loading) return;
  const text = shareText(m);
  try {
    if (typeof navigator !== "undefined" && navigator.share) { await navigator.share({ title: "Money", text }); return; }
  } catch (e) { if (e && e.name === "AbortError") return; }
  try { await navigator.clipboard.writeText(text); toast("Copied"); } catch (e) { toast(text); }
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
// Monthly (the owner's Nov 13 ask, Rotor's look): a month calendar, Sunday
// first, each day's number with up to three dots (a dot a visit, in its
// tech's color), today a coral circle, the chosen day outlined; under it the
// chosen day's visits. Picking a day draws again from the month already read.
const DOW = ["S", "M", "T", "W", "T", "F", "S"];
const dowOf = (ymd) => new Date(ymd + "T12:00:00Z").getUTCDay();
// the days on the grid: the Sunday on or before the 1st to the Saturday on or after the last
export function monthCells(ym) {
  const first = `${ym}-01`, last = addDays(addMonths(first, 1), -1);
  const out = [];
  for (let d = addDays(first, -dowOf(first)); d <= addDays(last, 6 - dowOf(last)); d = addDays(d, 1)) out.push(d);
  return out;
}
// the chosen day: the one tapped in this month, else today when it's in it, else the first day with visits, else the 1st
export function monthPick(picked, ym, today, items) {
  if (picked && picked.slice(0, 7) === ym) return picked;
  if (today && today.slice(0, 7) === ym) return today;
  const first = (items || []).find((v) => v && String(v.date).slice(0, 7) === ym);
  return first ? first.date : `${ym}-01`;
}
const barOf = (v) => { const p = (v.people || [])[0]; return p && colorOk(p.color) ? p.color : "#b9b9c2"; };
function agendaMonth(s, ctx, a) {
  const ym = String(a.date || a.from).slice(0, 7);
  const items = a.loading ? [] : (a.items || []).filter((v) => String(v.date).slice(0, 7) === ym);
  const by = new Map();
  for (const v of items) { if (!by.has(v.date)) by.set(v.date, []); by.get(v.date).push(v); }
  const t = localDate(s.now);
  const pick = monthPick(s.ui.agDay, ym, t, items);
  const title = `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
  const cell = (d) => {
    if (d.slice(0, 7) !== ym) return html`<span class="hm-cd out" aria-hidden="true"><span class="n">${Number(d.slice(8, 10))}</span></span>`;
    const on = by.get(d) || [];
    const cls = "hm-cd" + (d === t ? " today" : "") + (d === pick ? " sel" : "");
    return html`<button type="button" class="${cls}" ${attrs({ "data-hm": "ag-day", "data-v": d, "aria-pressed": d === pick ? "true" : "false", "aria-current": d === t ? "date" : null, "aria-label": `${dateLong(d)}: ${on.length ? plural(on.length, "item") : "nothing booked"}${d === t ? ", today" : ""}` })}>
      <span class="n">${Number(d.slice(8, 10))}</span><span class="dots" aria-hidden="true">${on.slice(0, 3).map((v) => html`<i ${attrs({ style: `--c:${barOf(v)}` })}></i>`)}</span></button>`;
  };
  const list = by.get(pick) || [];
  return html`<div class="hm-ag-top">${seg("view", VIEWS, a.view, "Daily, weekly or monthly")}
      <div class="hm-arrows"><button type="button" class="hm-round" data-hm="ag-move" data-v="-1" aria-label="Previous month">${ic("chevron-left")}</button><button type="button" class="hm-round" data-hm="ag-move" data-v="1" aria-label="Next month">${ic("chevron-right")}</button></div></div>
    <div class="hm-ag-head hm-ag-month"><h3 id="hm-ag-h">${title}</h3><span>${a.loading ? "…" : plural(a.count || 0, "item")}</span></div>
    <div class="hm-cal" role="group" aria-label="${title}: pick a day">
      <div class="hm-cal-dow" aria-hidden="true">${DOW.map((x) => html`<span>${x}</span>`)}</div>
      <div class="hm-cal-days">${monthCells(ym).map(cell)}</div>
    </div>
    ${a.loading ? html`<p class="hm-note" aria-busy="true">Loading…</p>` : html`<div class="hm-selday" aria-live="polite">
      <h4 class="hm-selh"><span class="d">${dateShort(pick)}</span><span class="sr"> · </span><span class="c">${plural(list.length, "item")}</span></h4>
      ${list.length ? html`<ul class="hm-items">${list.map((v) => agendaRow(v, ctx))}</ul>` : html`<div class="hm-empty hm-empty-day"><b>Nothing booked</b><p>No visits on ${dateShort(pick)}.</p></div>`}</div>`}`;
}
function agendaCard(s, ctx) {
  const a = s.home.cards.agenda;
  if (!a) return "";
  const items = a.items || [];
  let rows;
  if (a.view === "day") rows = html`<ul class="hm-items">${items.map((v) => agendaRow(v, ctx))}</ul>`;
  else if (a.view === "week") {
    const days = [...new Set(items.map((v) => v.date))];
    rows = days.map((d) => html`<h4 class="hm-day">${dateShort(d)}</h4><ul class="hm-items">${items.filter((v) => v.date === d).map((v) => agendaRow(v, ctx))}</ul>`);
  }
  const tasks = a.tasks;
  const openT = s.ui.tasksOpen;
  const word = a.view === "day" ? (a.date === localDate(s.now) ? "today" : "that day") : a.view === "week" ? "that week" : "that month";
  const today = a.view === "day" && a.date === localDate(s.now);
  return html`<section class="${"hm-card hm-c-agenda" + (a.view === "month" ? " hm-ag-m" : "")}" data-card="agenda" aria-labelledby="hm-ag-h">
    ${a.view === "month" ? agendaMonth(s, ctx, a) : html`<div class="hm-ag-head"><div class="t"><h3 id="hm-ag-h">${today ? "Today" : agendaTitle(a)}</h3><span>${today ? `${dateShort(a.date)} · ` : ""}${a.loading ? "…" : plural(a.count || 0, "item")}</span></div>
      <div class="hm-arrows"><button type="button" class="hm-round" data-hm="ag-move" data-v="-1" aria-label="Earlier">${ic("chevron-left")}</button><button type="button" class="hm-round" data-hm="ag-move" data-v="1" aria-label="Later">${ic("chevron-right")}</button></div></div>
    ${seg("view", VIEWS, a.view, "Daily, weekly or monthly", "full")}
    ${a.loading ? html`<p class="hm-note" aria-busy="true">Loading…</p>` : items.length ? rows : html`<div class="hm-empty"><span class="art">${icon("cal12")}</span><b>Nothing scheduled for ${word}</b><p>Your jobs and tasks will appear here.</p></div>`}`}
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
  s.ui.agDay = null;
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
    ${rows.length ? html`<ol class="hm-board">${rows.map((r) => html`<li><span class="rank">${r.rank}</span>${avatar({ name: r.name }, "hm-av ol")}<span class="who"><b>${r.name || "Someone"}</b>${r.note ? html`<small>${r.note}</small>` : ""}</span><span class="val">${usd(r.value)}${r.unit ? html` <small>${r.unit}</small>` : ""}</span></li>`)}</ol>`
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
    ${items.length ? html`<ul class="hm-convs">${items.map((v) => { const href = open(ctx, `/inbox/${v.id}`); const body = html`${avatar({ name: v.name }, "hm-av ol")}<span class="who"><b>${v.name}</b><small>${v.preview}</small></span><span class="end"><small>${v.at ? ago(v.at) : ""}</small>${v.unread ? html`<span class="hm-unread" aria-label="${`${v.unread} unread`}"></span>` : ""}</span>`; return html`<li>${href ? html`<a class="${"hm-conv" + (v.unread ? " unread" : "")}" href="${href}">${body}</a>` : html`<div class="hm-conv">${body}</div>`}</li>`; })}</ul>`
      : html`<div class="hm-empty"><span class="art plain">${icon("inbox")}</span><b>No recent conversations</b><p>New conversations will appear here.</p></div>`}
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
  return html`<section class="${"hm-card hm-c-goals" + (rows.length ? "" : " hm-plain")}" data-card="goals" aria-labelledby="hm-gl-h">
    <div class="hm-bar"><h3 id="hm-gl-h">Goals</h3>${g.can_edit ? html`<button type="button" class="hm-chip" data-hm="goals">${rows.length ? "Edit" : "Add"}</button>` : ""}</div>
    ${rows.length ? html`<ul class="hm-goals">${rows.map(([label, v, target, fmt]) => { const p = v === null || v === undefined ? null : Math.round((v / target) * 100); return html`<li><div class="hm-goal-h"><span>${label}</span><b>${fmt(v)} <small>of ${fmt(target)}</small></b></div><span class="hm-track" aria-hidden="true"><span class="hm-fill" ${attrs({ style: `width:${Math.min(100, Math.max(0, p || 0))}%` })}></span></span><small class="hm-pct">${p === null ? "Not counted yet" : `${p}%`}</small></li>`; })}</ul>`
      : html`<div class="hm-empty"><b>No goals yet</b><p>${g.can_edit ? "Tap Add to set a revenue or jobs goal and track progress here." : "An owner can set a monthly revenue or jobs goal."}</p></div>`}
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
      <p class="small">Leave one empty for no goal. Progress shows on the Goals card.</p>
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
      ui: { money: { period: "month", date: localDate(now), folded: moneyFolded() }, taskFilter: "upcoming", tasksOpen: remembered() },
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
        <div class="hm-hello"><p class="hm-greet">${greeting(s.now)}</p><h2>${first}</h2><span class="sr">${dateLong(s.now)}</span></div>
        <a class="rnd bell" href="#/notifications" aria-label="${n ? `Notifications, ${n} new` : "Notifications"}">${icon("bell")}${n ? html`<span class="badge">${n > 99 ? "99+" : n}</span>` : ""}</a>
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
        if (what === "clock") return clockAction(el.dataset.act, ctx);
        if (what === "m-period") { if (s.ui.money.period !== v) pickMoneyPeriod(s, ctx, v); return; }
        if (what === "m-move") { moveMoney(s, ctx, Number(v)); return; }
        if (what === "m-share") { shareMoney(s.home.cards.money); return; }
        if (what === "m-fold") {
          s.ui.money.folded = !s.ui.money.folded;
          try { localStorage.setItem(FOLD_MONEY, s.ui.money.folded ? "1" : "0"); } catch (x) { /* no storage */ }
          ctx.rerender();
          const b = view.querySelector('[data-hm="m-fold"]');
          if (b) b.focus({ preventScroll: true });
          return;
        }
        if (what === "view") {
          const a = s.home.cards.agenda;
          if (a.view === v) return;
          // from Monthly, Daily and Weekly open on the day picked on the calendar
          const d = a.view === "month" && a.from ? monthPick(s.ui.agDay, String(a.date || a.from).slice(0, 7), localDate(s.now), a.items) : a.date;
          s.ui.agDay = null;
          loadAgenda(s, ctx, v, d);
          return;
        }
        if (what === "ag-day") {
          // the month is already read: only the list under the calendar changes
          s.ui.agDay = v;
          ctx.rerender();
          if (!e.detail) { const b = view.querySelector(`[data-hm="ag-day"][data-v="${v}"]`); if (b) b.focus({ preventScroll: true }); }
          return;
        }
        if (what === "ag-move") { moveAgenda(s, ctx, Number(v)); return; }
        if (what === "tasks-fold") { s.ui.tasksOpen = !s.ui.tasksOpen; try { localStorage.setItem(FOLD_KEY, s.ui.tasksOpen ? "1" : "0"); } catch (x) { /* no storage */ } ctx.rerender(); return; }
        if (what === "board") { loadBoard(s, ctx, v); return; }
        if (what === "goals") { editGoals(ctx); return; }
        if (what === "edit") { editHome(s, ctx); return; }
      },
      "change [data-hm-change]": (e, el) => { if (el.dataset.hmChange === "task-filter") { s.ui.taskFilter = el.value; ctx.rerender(); } },
    }));
    // the chart
    const m = s.home.cards.money;
    const el = root.querySelector('[data-chart="money"]');
    if (m && el && !m.loading) {
      const ser = moneySeries(m);
      const rd = root.querySelector("#read-money");
      const put = (sel, v) => { const b = rd && rd.querySelector(sel); if (b) b.textContent = v; };
      const onRead = (i) => {
        put(".d", pointWords(m, ser.keys[i]));
        put(".c b", ser.collected[i] === null ? "-" : usd(ser.collected[i]));
        put(".s b", ser.scheduled[i] === null ? "-" : usd(ser.scheduled[i]));
      };
      // Rotor's weekly Collected is drawn through its weeks; so is Scheduled then (one scale)
      const join = m.grain === "week";
      off.push(pairChart(el, {
        keys: ser.keys, label: (i) => day(ser.keys[i]), axis: usdShort, onRead, height: 190, start: localDate(s.now),
        series: [{ cls: "hc-line s", dot: "s", values: ser.scheduled, join }, { cls: "hc-line c", dot: "c", values: ser.collected, join }],
      }).destroy);
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
