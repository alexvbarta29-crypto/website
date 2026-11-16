// Home: the first screen the office sees (the owner's Nov 12 choice, cards
// each person shows, hides and orders with Edit Home, saved on the server).
// Nov 15, the owner with two screenshots of Flyra's phone app: "Make the
// home page look like Flyra". One read (GET /home) brings the header and
// the data of the cards that are on:
//
//   the top     no card: a soft warm glow behind it (dark: dark grey with a
//               faint red to the near-black canvas), white to light grey
//               (light), Barta's red for the line, the bars and what's
//               picked, never blue (Nov 16, the owner: "make it my
//               business colors, not the blue"); "Good evening" small and grey, the first
//               name big, the bell; Revenue | ARR (Revenue first) and the
//               period (1W 1M 3M 1Y YTD: a small sheet on a phone, chips
//               on a computer); the period's name in caps, the big number
//               (a tap opens Payments or Plans), AVG and PEAK on the right;
//               one thin line across the width with the values at the
//               left, a faint grid and a dotted baseline; under it what a
//               tap on the line reads out, and "Updated 5:16 PM" (or where
//               Collected comes from). ARR is by month: the next 12
//               months first (Nov 16, "the ARR for next year per month":
//               ARR projected at each month's end from today's plans, "In
//               12 months" and the change to it), or the past (Nov 15:
//               6M 1Y YTD All, its change since the period began and this
//               month's); today's ARR the big number, a bar a month with
//               its MRR on it ("show the MRR in all 12 months", Nov 15: no
//               axis, no grid, this month lit), the short month names,
//               and under them the month picked (a tap): its MRR and ARR,
//               the plans renewing and ending in it (ahead) or added and
//               lost (past)
//   Clock in    compact: TIMESHEET, today's hours, Clock In / Clock Out
//   Today       Daily | Weekly | Monthly with arrows, the visits (a color
//               bar per tech, customer, "Job · 8:00 AM – 12:00 PM", who,
//               the time), and TASKS WITHOUT DUE DATE (folds); Monthly is
//               a month calendar (dots per day) and the picked day's visits
//   Tasks (Upcoming ▾, Add), Goals (owners add)
//   Edit Home   show, hide and order the cards (the money stays on top)
// The Leaderboard and Inbox cards left Home on Nov 16 (the owner: "I don't
// need to see the leaderboard ... I also don't need my inbox on the home
// page"): the full Leaderboard is the Menu's, the Inbox the bar's.
//
// On a computer (Flyra's dashboard) two columns: the money (a card there)
// and Today on the left, the clock and Tasks on the right, Goals across. A tech never comes here (today.js keeps their own
// day). Creating is the shell's New / + button.

import { html, icon, attrs, toast, sheet, delegate, render } from "../../core/ui.js";
import { dateLong, dateShort, plural, dateTime, initials, clock, time as fmtTime, localDate } from "../../core/format.js";
import { uuid } from "../../core/api.js";
import * as router from "../../core/router.js";
import { flyraLine, monthBars, srTable } from "./home-charts.js";

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
// a bar's MRR (Nov 15, "showing the MRR in all 12 months"): "$154", "$3.2k", "$32k", "$1.2M";
// tight (a phone too narrow for the "$"): "154", "3.2k"
export const mrrShort = (cents, tight = false) => {
  if (cents === null || cents === undefined || !Number.isFinite(Number(cents))) return "-";
  const d = Math.round(Number(cents) / 100);
  const a = Math.abs(d);
  const body = a >= 1e6 ? `${+(a / 1e6).toFixed(a < 1e7 ? 1 : 0)}M` : a >= 1000 ? `${+(a / 1000).toFixed(a < 9950 ? 1 : 0)}k` : String(a);
  return `${d < 0 ? "−" : ""}${tight ? "" : "$"}${body}`;
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
};
const ic = (name) => LOCAL[name] || icon(name);
const avatar = (p, cls = "hm-av") => html`<span class="${cls}" ${attrs({ style: colorOk(p.color) ? `background:${p.color}` : null, title: p.name || null })} aria-hidden="true">${initials(p.name || p.first_name)}</span>`;

// ------------------------------------------------------------ where a tap goes

const open = (ctx, path) => {
  const m = path && router.match(path.split("?")[0]);
  return m && (!m.route.perm || ctx.can(m.route.perm)) ? "#" + path : null;
};

// ------------------------------------------------------------ the cards' names (Edit Home)

const CARD_NAMES = { clock: "Clock in", money: "Revenue and ARR", agenda: "Today", tasks: "Tasks", goals: "Goals" };
const CARD_NOTES = { clock: "Today's hours and the clock", money: "Always at the top of Home", agenda: "Visits and tasks without a due date", tasks: "Upcoming and overdue tasks", goals: "Monthly revenue and jobs goals" };
// a computer's two columns (Flyra's dashboard): the money and Today on the left, the short cards on the right, Goals across
const COLUMN = { money: "a", agenda: "a", clock: "b", tasks: "b", goals: "w" };

// ------------------------------------------------------------ Clock in (compact)

function clockCard(s, ctx) {
  const c = s.home.cards.clock;
  if (!c) return "";
  const on = !!c.open;
  const time = open(ctx, "/time");
  const line = on ? `Since ${fmtTime(c.open.start_at)}${c.open.category && c.open.category !== "service" ? ` · ${c.open.category === "sales" ? "Sales" : "Office"}` : ""}` : "Choose a role when you clock in";
  const main = html`<span class="hm-eyebrow"><span class="${"hm-dot" + (on ? " on" : "")}" aria-hidden="true"></span><span id="hm-clock-h">Timesheet</span></span>
      <span class="hm-hours" ${attrs({ "data-since": on ? c.open.start_at : null, "data-base": String(c.minutes || 0) })}>${hoursMin(c.minutes)}</span>
      <span class="hm-line">${line}</span>`;
  return html`<section class="hm-card hm-c-clock" data-card="clock" aria-labelledby="hm-clock-h">
    ${time ? html`<a class="hm-clock-main" href="${time}" aria-label="${`Timesheet, ${hoursMin(c.minutes)} today. Open your time`}">${main}</a>` : html`<div class="hm-clock-main">${main}</div>`}
    <button type="button" class="hm-pill" data-hm="clock" data-act="${on ? "out" : "in"}">${ic(on ? "stop" : "play")}${on ? "Clock Out" : "Clock In"}</button>
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

// ------------------------------------------------------------ the money (the top of Home, Flyra's)

const MISSING = {
  "no-key": "Rotor's numbers show here once the office data key is set in Netlify (OFFICE_DATA_KEY).",
  "bad-key": "Rotor's numbers can't be opened with this site's office data key. Re-seal the dashboard snapshot (docs/DASHBOARD.md).",
};
// a segmented switch (Revenue | ARR, Daily | Weekly | Monthly)
const seg = (name, items, current, label, cls = "") => html`<div class="${"hm-seg" + (cls ? " " + cls : "")}" role="group" aria-label="${label}">${items.map(([k, l]) => html`<button type="button" class="${k === current ? "on" : ""}" ${attrs({ "data-hm": name, "data-v": k, "aria-pressed": k === current ? "true" : "false" })}>${l}</button>`)}</div>`;
// where Collected comes from (ARR is always the CRM's own)
export function moneyNote(m) {
  if (!m || m.loading) return "";
  if (m.source === "import") return m.as_of ? `From Rotor's import of ${day(m.as_of)}` : "From Rotor's import";
  if (m.source === "rotor") return m.as_of ? `From Rotor · updated ${day(m.as_of)}` : "From Rotor";
  return m.updated_at ? `Updated ${fmtTime(m.updated_at)}` : "";
}
// a view's line: its points' days and values (null where it has no point)
export function lineSeries(v) {
  const pts = (v && v.points) || [];
  return { keys: pts.map((x) => x.key), values: pts.map((x) => (x.value === null || x.value === undefined ? null : x.value)) };
}
// Flyra's period menu: 1W 1M 3M 1Y, and YTD (Revenue)
export const RANGES = [["1w", "1W", "This week"], ["1m", "1M", "This month"], ["3m", "3M", "The last 3 months"], ["1y", "1Y", "The last 12 months"], ["ytd", "YTD", "This year"]];
// ARR by month: the next 12 months first (the owner's Nov 16 ask), then the past (Nov 15): 6M, a year, YTD and All
export const ARR_RANGES = [["next12", "Next year", "The next 12 months"], ["6m", "Past 6M", "The past 6 months"], ["1y", "Past year", "The past 12 months"], ["ytd", "YTD", "This year so far"], ["all", "All", "Since the first plan"]];
const rangesOf = (view) => (view === "arr" ? ARR_RANGES : RANGES);
// the range on screen: each view keeps its own
const rangeKey = (view) => (view === "arr" ? "arrRange" : "range");
// "+$1,200 (3.2%)", "−$400 (1.1%)", "No change"
export function changeText(a) {
  if (!a || a.change === null || a.change === undefined) return "";
  if (!a.change) return "No change";
  const pct = a.pct === null || a.pct === undefined ? "" : ` (${Math.abs(a.pct).toLocaleString("en-US", { maximumFractionDigits: 1 })}%)`;
  return `${a.change > 0 ? "+" : ""}${usd(a.change)}${pct}`;
}
// "+$1,200" (the change alone, where room is short)
const changeShort = (a) => (!a || a.change === null || a.change === undefined ? "-" : !a.change ? "$0" : `${a.change > 0 ? "+" : ""}${usd(a.change)}`);
// "+3.2%", "−1.1%" (a change's share of where it started), "" without one
export const pctText = (a) => (!a || a.pct === null || a.pct === undefined || !a.change ? "" : `${a.pct > 0 ? "+" : "−"}${Math.abs(a.pct).toLocaleString("en-US", { maximumFractionDigits: 1 })}%`);
const toneOf = (c) => (c > 0 ? "up" : c < 0 ? "down" : "");
// the right-hand pair: Revenue's AVG and PEAK (a best week or month from Rotor's snapshot);
// ARR's change since the period began ($ and %) and this month's change (by month, Nov 15),
// or its change and MRR (an older per-day answer)
export function sideStats(view, v) {
  if (!v || v.loading) return [["…", "…"], ["…", "…"]].map(([k, val], i) => ({ key: i ? "b" : "a", label: view === "arr" ? (v && v.ahead ? (i ? "Change" : "In 12 months") : i ? "This month" : "Change") : i ? "Peak" : "Avg", value: val }));
  // ARR ahead (Nov 16): where it ends up in 12 months, and the change to it ($ and %)
  if (view === "arr" && v.ahead) {
    const none = v.total === null;
    const last = v.points && v.points.length ? v.points[v.points.length - 1] : null;
    return [
      { key: "a", label: "In 12 months", value: none ? "-" : usd(v.end), title: none || !last ? "" : `ARR at the end of ${pointWords(v, last.key)}` },
      { key: "b", label: "Change", value: none ? "-" : changeShort(v), sub: none ? "" : pctText(v), tone: toneOf(v.change), title: none ? "" : `${changeText(v)} by the end of ${last ? pointWords(v, last.key) : "the year"}` },
    ];
  }
  if (view === "arr" && v.month_change !== undefined) {
    const none = v.total === null;
    const since = v.points && v.points.length ? `since the start of ${pointWords(v, v.points[0].key)}` : "";
    return [
      { key: "a", label: "Change", value: none ? "-" : changeShort(v), sub: none ? "" : pctText(v), tone: toneOf(v.change), title: none ? "" : `${changeText(v)} ${since}`.trim() },
      { key: "b", label: "This month", value: none ? "-" : changeShort({ change: v.month_change }), tone: toneOf(v.month_change), title: none ? "" : `${changeShort({ change: v.month_change })} this month` },
    ];
  }
  if (view === "arr") {
    return [{ key: "a", label: "Change", value: v.total === null ? "-" : changeShort(v), tone: toneOf(v.change), title: changeText(v) }, { key: "b", label: "MRR", value: usd(v.mrr) }];
  }
  const best = v.grain === "week" ? "Best week" : v.grain === "month" ? "Best month" : "Peak";
  return [{ key: "a", label: "Avg", value: usd(v.avg), title: "Average a day" }, { key: "b", label: best, value: v.peak ? usd(v.peak.value) : "-", title: v.peak ? v.peak.label : "" }];
}
// the caps label over the big number: the range's name (NOVEMBER, NOV 16 – 22, SEPTEMBER – NOVEMBER, 2026)
const periodWords = (v) => (v && v.label) || "";
// the axis: Flyra's plain numbers ("250", "1.5K")
export const axisShort = (cents) => usdShort(cents).replace("$", "");

// ARR by month: the month picked on the bars (this month to start with: the last bar of the past, the first ahead)
export function monthPicked(v, key) {
  const pts = ((v && v.points) || []).filter((x) => x.value !== null && x.value !== undefined);
  return pts.find((x) => x.key === key) || (v && v.ahead ? pts[0] : pts[pts.length - 1]) || null;
}
// a month's MRR: its ARR / 12 (an older server's points carry none)
export const mrrOf = (x) => (!x || x.value === null || x.value === undefined ? null : Number.isFinite(x.mrr) ? x.mrr : Math.round(x.value / 12));
const plansWord = (n) => `${Number(n || 0).toLocaleString("en-US")} ${n === 1 ? "plan" : "plans"}`;
// the picked month's readout: the month, its MRR and ARR at the month's end, the plans added and lost in it;
// ahead (Nov 16): projected, the plans renewing and ending in it (and starting, when one does)
export function monthRead(x, ahead = false) {
  if (!x) return "";
  const when = `${MONTHS[Number(x.key.slice(5, 7)) - 1].slice(0, 3)} ${x.key.slice(0, 4)}`;
  if (ahead) {
    return html`<p class="mr-h">${when}<small>Projected</small></p><div class="mr-a"><span>MRR</span><b>${usd(mrrOf(x))}</b></div><div><span>ARR</span><b>${usd(x.value)}</b></div><div><span>Renewing</span><b>${plansWord(x.renewing)}</b></div><div><span>Ending</span><b class="${x.ending ? "down" : ""}">${plansWord(x.ending)}</b></div>${x.starting ? html`<div><span>Starting</span><b class="up">${plansWord(x.starting)}</b></div>` : ""}`;
  }
  return html`<p class="mr-h">${when}</p><div class="mr-a"><span>MRR</span><b>${usd(mrrOf(x))}</b></div><div><span>ARR</span><b>${usd(x.value)}</b></div><div><span>Added</span><b class="${x.added ? "up" : ""}">${plansWord(x.added)}</b></div><div><span>Lost</span><b class="${x.lost ? "down" : ""}">${plansWord(x.lost)}</b></div>`;
}

function moneyTop(s, ctx) {
  const m = s.home.cards.money;
  if (!m) return "";
  const ui = s.ui.money;
  const view = ui.view;
  const range = ui[rangeKey(view)];
  const ranges = rangesOf(view);
  const v = view === "arr" ? m.arr_view : m.revenue_view;
  const loading = !v || !!v.loading;
  const target = view === "arr" ? open(ctx, "/plans") : open(ctx, "/payments");
  const ser = loading ? null : lineSeries(v);
  const drawn = !!ser && ser.values.some((x) => x !== null && x > 0);
  // ARR by month (Nov 15): bars, a readout of the month picked
  const months = !loading && view === "arr" && v.grain === "month";
  const ahead = months && !!v.ahead;
  const stats = sideStats(view, v);
  const big = loading ? "…" : usd(v.total);
  const what = view === "arr" ? "ARR" : "Collected";
  const head = html`<span class="hm-mbig"><span class="sr">${what}, </span>${big}</span>`;
  const note = view === "arr" ? (loading ? "" : `${Number(v.plans || 0).toLocaleString("en-US")} active ${v.plans === 1 ? "plan" : "plans"}${v.total ? ` · MRR ${usd(v.mrr)}` : ""}`) : "";
  const updated = loading ? "" : view === "arr" ? (v.updated_at || m.updated_at ? `Updated ${fmtTime(v.updated_at || m.updated_at)}` : "") : moneyNote(v);
  const grainWord = v && (v.grain === "week" ? "week" : v.grain === "month" ? "month" : "day");
  const shown = (r) => (ranges.find((x) => x[0] === r) || ranges[0]);
  return html`<section class="hm-money" data-card="money" ${attrs({ "data-view": view })} aria-labelledby="hm-m-h">
    <div class="hm-mrow">
      ${seg("m-view", [["revenue", "Revenue"], ["arr", "ARR"]], view, "Revenue or ARR", "hm-mview")}
      <div class="hm-ranges" role="group" aria-label="Period">${ranges.map(([k, l, words]) => html`<button type="button" class="${k === range ? "on" : ""}" ${attrs({ "data-hm": "m-range", "data-v": k, "aria-pressed": k === range ? "true" : "false", "aria-label": words })}>${l}</button>`)}</div>
      <button type="button" class="hm-range" data-hm="m-ranges" aria-haspopup="dialog" aria-label="${`Period: ${shown(range)[2]}`}"><span>${shown(range)[1]}</span>${ic("chevron-down")}</button>
    </div>
    <h3 class="hm-mper" id="hm-m-h"><span class="sr">${view === "arr" ? "ARR" : "Revenue"}, </span>${periodWords(v)}</h3>
    <div class="hm-mhead" ${attrs({ "aria-busy": loading ? "true" : "false" })}>
      <div class="hm-mmain">
        ${target ? html`<a class="hm-mlink" href="${target}">${head}</a>` : head}
      </div>
      <dl class="hm-stats">${stats.map((x) => html`<div ${attrs({ title: x.title || null })}><dt>${x.label}</dt><dd class="${x.tone || ""}">${x.value}${x.sub ? html`<small>${x.sub}</small>` : ""}</dd></div>`)}</dl>
    </div>
    ${!loading && view === "revenue" && v.missing ? html`<p class="hm-note">${MISSING[v.missing] || "Rotor's numbers aren't in yet."}</p>` : ""}
    ${loading ? html`<div class="hc hf" aria-hidden="true"></div>`
      : drawn && months ? html`<p class="hm-bcap" aria-hidden="true">${ahead ? "Projected MRR by month" : "MRR by month"}<span>ARR ÷ 12</span></p>
        <div class="hc hf hb" data-chart="arr" tabindex="0" role="group" aria-label="${`${ahead ? "Projected MRR" : "MRR"} at the end of each month (ARR divided by 12), ${v.label || ""}. Arrow keys pick a month.`}"></div>
        <div class="hm-mread" id="hm-mread" aria-live="polite">${monthRead(monthPicked(v, ui.arrMonth), ahead)}</div>
        ${ahead ? srTable(`Projected MRR and ARR at the end of each month, ${v.label || ""}`, ["Month", "MRR", "ARR", "Plans renewing", "Plans ending", "Plans starting"], v.points.map((x) => [pointWords(v, x.key), usd(mrrOf(x)), usd(x.value), String(x.renewing), String(x.ending), String(x.starting)]))
          : srTable(`MRR and ARR at the end of each month, ${v.label || ""}`, ["Month", "MRR", "ARR", "Plans added", "Plans lost"], v.points.filter((x) => x.value !== null).map((x) => [pointWords(v, x.key), usd(mrrOf(x)), usd(x.value), String(x.added), String(x.lost)]))}`
      : drawn ? html`<div class="hc hf" data-chart="${view}" tabindex="0" role="group" aria-label="${`${what} by ${grainWord}, ${v.label || ""}. Arrow keys read each point.`}"></div>
        ${srTable(`${what} by ${grainWord}, ${v.label || ""}`, [v.grain === "week" ? "Week of" : v.grain === "month" ? "Month" : "Day", what], ser.keys.map((k, i) => [k, i]).filter(([, i]) => ser.values[i] !== null).map(([k, i]) => [pointWords(v, k), usd(ser.values[i])]))}`
      : html`<p class="hm-note hm-nochart">${view === "arr" ? (v.total === null ? "ARR shows here once there are plans." : "No recurring plans in this period.") : v.missing ? "" : v.total === null ? "Nothing counted for this period yet." : "Nothing collected in this period."}</p>`}
    <div class="hm-mfoot"><span class="hm-read" id="read-${view}" aria-live="polite">${note}</span><span class="hm-upd">${updated}</span></div>
  </section>`;
}
// a point's words: a day ("Nov 13"), a week ("Week of Nov 9"), a month ("Oct 2026")
function pointWords(v, k) {
  if (v.grain === "week") return `Week of ${day(k)}`;
  if (v.grain === "month" || /^\d{4}-\d{2}$/.test(k)) return `${MONTHS[Number(k.slice(5, 7)) - 1].slice(0, 3)} ${k.slice(0, 4)}`;
  return day(k);
}

// A view's own read over a range (the one on screen; the other is read when it is switched to)
async function loadView(s, ctx, view, range) {
  if (view === "arr") s.ui.money.arrMonth = null;
  const key = view === "arr" ? "arr_view" : "revenue_view";
  const my = (s.moneyTokens[view] = (s.moneyTokens[view] || 0) + 1);
  const money = s.home.cards.money;
  const cur = money[key] || null;
  money[key] = { ...(cur || {}), loading: true };
  ctx.rerender();
  try {
    const r = await ctx.api(`/home/money?${new URLSearchParams({ metric: view, range })}`, { cache: false });
    if (my === s.moneyTokens[view]) money[key] = { ...r.data, range };
  } catch (e) {
    if (my === s.moneyTokens[view]) { money[key] = { ...(cur || {}), loading: false }; toast((e && e.message) || "That didn't load.", { bad: true }); }
  }
  if (my === s.moneyTokens[view]) ctx.rerender();
}
// the range on screen (each view keeps its own: Revenue 1M, ARR the next 12 months to start with)
function pickRange(s, ctx, range) {
  const view = s.ui.money.view;
  if (!rangesOf(view).some((r) => r[0] === range)) return;
  s.ui.money[rangeKey(view)] = range;
  const m = s.home.cards.money;
  const key = view === "arr" ? "arr_view" : "revenue_view";
  if (m[key] && m[key].range === range && !m[key].loading) { ctx.rerender(); return; }
  loadView(s, ctx, view, range);
}
function pickView(s, ctx, view) {
  s.ui.money.view = view;
  const m = s.home.cards.money;
  const v = view === "arr" ? m.arr_view : m.revenue_view;
  const range = s.ui.money[rangeKey(view)];
  // (an older server's ARR is per day: read it again by month)
  if (!v || (v.range || "1m") !== range || (view === "arr" && v.total !== null && v.grain !== "month")) loadView(s, ctx, view, range);
  else ctx.rerender();
}
function rangeSheet(s, ctx) {
  const cur = s.ui.money[rangeKey(s.ui.money.view)];
  const sh = sheet({
    title: "Period",
    className: "hm-range-sheet",
    body: html`<ul class="hm-rlist">${rangesOf(s.ui.money.view).map(([k, l, words]) => html`<li><button type="button" class="${"hm-ropt" + (k === cur ? " on" : "")}" ${attrs({ "data-r": k, "aria-pressed": k === cur ? "true" : "false" })}><b>${l}</b><span>${words}</span>${k === cur ? icon("check") : ""}</button></li>`)}</ul>`,
    events: {
      "click [data-r]": (e, b) => {
        sh.close();
        pickRange(s, ctx, b.dataset.r);
        setTimeout(() => { const t = document.querySelector('.hm [data-hm="m-ranges"]'); if (t) t.focus({ preventScroll: true }); }, 280);
      },
    },
  });
}
// ------------------------------------------------------------ Today (the agenda)

const VIEWS = [["day", "Daily"], ["week", "Weekly"], ["month", "Monthly"]];
const STATUS_WORD = { en_route: "On the way", in_progress: "Working", paused: "Paused", completed: "Done" };
// (no blue on Home, Nov 16: Open is the plain grey pill)
const TASK_PILL = { open: ["Open", ""], in_progress: ["In progress", "amber"], waiting: ["Waiting", ""] };

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
  const pill = TASK_PILL[t.status] || ["Open", ""];
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

// ------------------------------------------------------------ Tasks and Goals

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
      <ul class="hm-edit-list">${[...cards].sort((a, b) => (a.key === "money" ? -1 : b.key === "money" ? 1 : 0)).map((c) => html`<li ${attrs({ "data-key": c.key })}>
        <label class="hm-switch"><input type="checkbox" ${attrs({ checked: c.on })}><span class="who"><b>${CARD_NAMES[c.key] || c.key}</b><small>${CARD_NOTES[c.key] || ""}</small></span></label>
        ${c.key === "money" ? "" : html`<button type="button" class="hm-round sm" data-mv="-1" aria-label="${`Move ${CARD_NAMES[c.key]} up`}">${ic("chevron-up")}</button><button type="button" class="hm-round sm" data-mv="1" aria-label="${`Move ${CARD_NAMES[c.key]} down`}">${ic("chevron-down")}</button>`}
      </li>`)}</ul>
      <button type="button" class="btn primary block" data-save>Save</button>`,
    events: {
      "click [data-mv]": (e, b) => {
        const li = b.closest("li");
        // (the money stays first: it is the top of Home)
        if (b.dataset.mv === "-1" && li.previousElementSibling && li.previousElementSibling.dataset.key !== "money") li.parentNode.insertBefore(li, li.previousElementSibling);
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

const DRAW = { clock: clockCard, money: moneyTop, agenda: agendaCard, tasks: tasksCard, goals: goalsCard };
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
      // Revenue first, this month (Flyra's)
      ui: { money: { view: "revenue", range: "1m", arrRange: "next12", arrMonth: null }, taskFilter: "upcoming", tasksOpen: remembered() },
      moneyTokens: {},
      edit: typeof location !== "undefined" && /[?&]edit=1\b/.test(location.hash),
    };
  },
  render(s, ctx) {
    const u = s.home.user || s.user || {};
    const first = u.first_name || (u.name || "").split(" ")[0] || "there";
    const n = Number(s.home.notifications) || 0;
    const mode = s.home.mode || {};
    // the money first (the top of Home), then the person's order; on a computer each card in its column
    const shown = (s.home.layout || []).filter((c) => c.on && DRAW[c.key] && s.home.cards[c.key]).sort((a, b) => (a.key === "money" ? -1 : b.key === "money" ? 1 : 0));
    const slot = (c, i) => html`<div class="hm-slot" ${attrs({ "data-slot": c.key, style: `order:${i}` })}>${DRAW[c.key](s, ctx)}</div>`;
    const col = (k) => shown.map((c, i) => [c, i]).filter(([c]) => (COLUMN[c.key] || "b") === k).map(([c, i]) => slot(c, i));
    return html`<div class="stack hm">
      <header class="hm-head">
        <div class="hm-hello"><p class="hm-greet">${greeting(s.now)}</p><h2>${first}</h2><span class="sr">${dateLong(s.now)}</span></div>
        <a class="rnd bell" href="#/notifications" aria-label="${n ? `Notifications, ${n} new` : "Notifications"}">${icon("bell")}${n ? html`<span class="badge">${n > 99 ? "99+" : n}</span>` : ""}</a>
      </header>
      ${mode.paused ? html`<a class="card alert hm-alert" href="#/settings/data"><h2>The CRM is paused</h2><p>${mode.paused_reason === "restore" ? "A backup was restored. " : ""}Nothing is texted, emailed, charged or automated${mode.paused_at ? ` since ${dateTime(mode.paused_at)}` : ""}. An owner resumes it on Settings → Data.</p></a>` : ""}
      <div class="hm-grid"><div class="hm-col a">${col("a")}</div><div class="hm-col b">${col("b")}</div><div class="hm-col w">${col("w")}</div></div>
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
        if (what === "m-view") {
          if (s.ui.money.view === v) return;
          pickView(s, ctx, v);
          const b = view.querySelector(`[data-hm="m-view"][data-v="${v}"]`);
          if (b) b.focus({ preventScroll: true });
          return;
        }
        if (what === "m-range") { if (s.ui.money[rangeKey(s.ui.money.view)] !== v) pickRange(s, ctx, v); return; }
        if (what === "m-ranges") { rangeSheet(s, ctx); return; }
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
        if (what === "goals") { editGoals(ctx); return; }
        if (what === "edit") { editHome(s, ctx); return; }
      },
      "change [data-hm-change]": (e, el) => { if (el.dataset.hmChange === "task-filter") { s.ui.taskFilter = el.value; ctx.rerender(); } },
    }));
    // the top's line (the view on screen)
    const m = s.home.cards.money;
    const mv = m && (s.ui.money.view === "arr" ? m.arr_view : m.revenue_view);
    const el = root.querySelector(`[data-chart="${s.ui.money.view}"]`);
    if (mv && el && !mv.loading && s.ui.money.view === "arr" && mv.grain === "month") {
      // ARR by month: each bar its month's MRR; a tap picks a month, its readout under the bars
      const pts = mv.points || [];
      const rd = root.querySelector("#hm-mread");
      const last = pts.filter((x) => x.value !== null && x.value !== undefined).pop();
      off.push(monthBars(el, {
        keys: pts.map((x) => x.key), labels: pts.map((x) => x.label), values: pts.map(mrrOf), value: mrrShort,
        now: String(mv.through || mv.to || "").slice(0, 7) || (last && last.key),
        start: (monthPicked(mv, s.ui.money.arrMonth) || {}).key,
        onRead: (i) => { s.ui.money.arrMonth = pts[i].key; if (rd) render(rd, monthRead(pts[i], !!mv.ahead)); },
      }).destroy);
    } else if (mv && el && !mv.loading) {
      const ser = lineSeries(mv);
      const rd = root.querySelector(".hm-read");
      const rest = rd ? rd.textContent : "";
      off.push(flyraLine(el, {
        keys: ser.keys, values: ser.values, axis: axisShort,
        onRead: (i) => { if (rd) rd.textContent = i === null ? rest : `${pointWords(mv, ser.keys[i])} · ${usd(ser.values[i])}`; },
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
