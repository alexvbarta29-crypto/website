// Home: the first screen the office sees. The owner's Nov 12 choice ("so
// much stuff"): two things and nothing more, from one read (GET /home):
//
//   the date, "Morning, {first name}" and the bell
//   Today: the day's visits in time order (time, customer, town, the work,
//     who goes, status), "2 of 7 done", the Schedule; on a day with
//     nothing booked, the next day that has visits ("Next up: Monday")
//   Money this month: collected so far (the big number), one line against
//     the same point last year, one chart (collected per week this month)
//     and "See more" to the full dashboards (Menu → Admin → Dashboard)
//
// A phone shows Today first, then Money; a computer wider than 1,200 px
// puts them side by side (Today the wider), a smaller one stacks them.
// Under them, for an owner or office person who goes out on visits, their
// own day with the clock (the work module's "My visits" card; nothing, and
// no read, for one who doesn't). The modules' other cards stay off Home.
// What needs attention is the bell's and the tab's dot (GET /me/badges);
// creating is the New button (the header on a computer, the coral button
// on a phone). Numbers say where they come from ("From Rotor · updated
// Nov 16") until the CRM keeps the money. A tech never comes here
// (today.js keeps their own day).

import { html, icon, attrs } from "../../core/ui.js";
import { dateLong, dateShort, plural, dateTime, initials, clock } from "../../core/format.js";
import * as router from "../../core/router.js";
import { loadCards, drawCards, wireCards } from "./cards.js";
import { columns, srTable } from "./home-charts.js";

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

// "$10,453" (whole dollars: a dashboard number, not an invoice)
export const usd = (cents) => {
  const n = Math.round((Number(cents) || 0) / 100);
  return (n < 0 ? "−$" : "$") + Math.abs(n).toLocaleString("en-US");
};
// "$6K", "$12.5K", "$1.2M" (axis ticks)
export const usdShort = (cents) => {
  const d = (Number(cents) || 0) / 100;
  if (Math.abs(d) >= 1e6) return `$${+(d / 1e6).toFixed(1)}M`;
  if (Math.abs(d) >= 1000) return `$${+(d / 1000).toFixed(d % 1000 ? 1 : 0)}K`;
  return `$${Math.round(d)}`;
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const isDate = (ymd) => /^\d{4}-\d{2}-\d{2}$/.test(ymd || "");
const day = (ymd) => `${MONTHS[Number(ymd.slice(5, 7)) - 1]} ${Number(ymd.slice(8, 10))}`;
// "Nov 1–16" (one day: "Nov 1")
export const span = (from, to) => (!isDate(from) ? "" : !isDate(to) || from === to ? day(from) : `${day(from)}–${Number(to.slice(8, 10))}`);
const weekday = (ymd) => DAYS[new Date(ymd + "T12:00:00Z").getUTCDay()];
// "tomorrow", "Monday" (this coming week), "Mon, Nov 30" (later)
export const nextLabel = (next) => (next.days <= 1 ? "tomorrow" : next.days < 7 ? weekday(next.date) : dateShort(next.date));
const greeting = (d) => {
  const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", hourCycle: "h23" }).format(d));
  return h < 12 ? "Morning" : h < 17 ? "Afternoon" : "Evening";
};

// ------------------------------------------------------------ where a tap goes

const open = (ctx, path) => {
  const m = path && router.match(path.split("?")[0]);
  return m && (!m.route.perm || ctx.can(m.route.perm)) ? "#" + path : null;
};

const VISIT_STATUS = { scheduled: null, en_route: ["On the way", "blue"], in_progress: ["Working", "amber"], paused: ["Paused", "amber"], completed: ["Done", "green"] };
const colorOk = (c) => /^#[0-9a-f]{6}$/i.test(c || "");

// ------------------------------------------------------------ Today

function visitTime(v) {
  if (v.date_only) return html`<span class="hv-time"><b>Any</b><small>time</small></span>`;
  const [t, ap] = clock(v.start).split(" ");
  return html`<span class="hv-time"><b>${t}</b><small>${ap}</small></span>`;
}
function people(list) {
  if (!list || !list.length) return html`<span class="hv-people"><span class="hv-av none" title="Nobody assigned">?</span><span class="sr">Nobody assigned</span></span>`;
  return html`<span class="hv-people">${list.slice(0, 3).map((p) => html`<span class="hv-av" ${attrs({ style: colorOk(p.color) ? `background:${p.color}` : null, title: p.name })} aria-hidden="true">${initials(p.name || p.first_name)}</span>`)}<span class="sr">${list.map((p) => p.first_name || p.name).join(", ")}</span></span>`;
}
function visitRows(list, ctx) {
  return html`<ul class="hm-visits">${list.map((v) => {
    const stt = VISIT_STATUS[v.status];
    const href = open(ctx, `/visits/${v.id}`);
    const body = html`${visitTime(v)}<span class="who"><span class="nm">${v.name || "Customer"}</span><span class="sub">${[v.town, v.title].filter(Boolean).join(" · ")}</span></span>${stt ? html`<span class="${"pill " + stt[1]}">${stt[0]}</span>` : ""}${people(v.people)}`;
    const cls = "hv-row" + (v.status === "completed" ? " done" : "");
    return html`<li>${href ? html`<a class="${cls}" href="${href}">${body}</a>` : html`<div class="${cls}">${body}</div>`}</li>`;
  })}</ul>`;
}

function today(s, ctx) {
  const d = s.home.today;
  if (!d) return "";
  const c = d.counts || { visits: 0, done: 0 };
  const sched = open(ctx, "/schedule");
  const visits = d.visits || [];
  const next = d.next;
  const share = c.visits ? Math.round((c.done / c.visits) * 100) : 0;
  return html`<section class="card hm-card hm-today" aria-labelledby="hm-today-h">
    <div class="hm-card-h"><h3 id="hm-today-h">Today</h3>${sched ? html`<a class="hm-more" href="${sched}">Schedule</a>` : ""}</div>
    ${visits.length ? html`<div class="hm-progress"><span class="hm-done">${c.done} of ${plural(c.visits, "visit")} done</span><span class="hm-track" aria-hidden="true"><span class="hm-fill" ${attrs({ style: `width:${share}%` })}></span></span></div>
      ${visitRows(visits, ctx)}
      ${c.visits > visits.length ? html`<a class="hm-more-row" href="${sched || "#/today"}"><span>${plural(c.visits - visits.length, "more visit")}</span><span class="hm-more">Schedule</span></a>` : ""}`
      : html`<div class="hm-empty"><span class="art">${icon("sun")}</span><div><b>Nothing booked today</b>${next ? "" : html`<p>Nothing on the schedule in the next few weeks.</p>`}</div></div>
      ${next ? html`<h4 class="hm-next-h">Next up: ${nextLabel(next)} <span class="hm-dim">${next.days > 1 && next.days < 7 ? `${dateShort(next.date).replace(/^\w+, /, "")} · ` : ""}${plural(next.count, "visit")}</span></h4>${visitRows(next.visits || [], ctx)}${next.count > (next.visits || []).length ? html`<a class="hm-more-row" href="${sched || "#/today"}"><span>${plural(next.count - next.visits.length, "more visit")}</span><span class="hm-more">Schedule</span></a>` : ""}` : ""}`}
  </section>`;
}

// ------------------------------------------------------------ Money this month

const MISSING = {
  "no-key": "Money shows here once the office data key is set in Netlify (OFFICE_DATA_KEY).",
  "bad-key": "Rotor's numbers can't be opened with this site's office data key. Re-seal the dashboard snapshot (docs/DASHBOARD.md).",
};

function compareLine(m) {
  const c = m.compare;
  if (!c) return "";
  const what = c.kind === "ytd" ? `this year vs the same dates in ${c.year}` : `vs ${span(c.from, c.to)}, ${c.year} (${usd(c.prev)})`;
  return html`<p class="hm-cmp"><span class="${"hm-delta " + (c.up ? "up" : "down")}"><span aria-hidden="true">${c.up ? "▲" : "▼"}</span> ${Math.abs(c.pct)}%<span class="sr"> ${c.up ? "up" : "down"}</span></span><span>${what}</span></p>`;
}

// the weeks as the chart reads them: through the data's last day ("so far")
const weekRead = (m, w) => {
  const to = w.to > m.as_of ? m.as_of : w.to;
  return `${span(w.from, to)}${w.to > m.as_of ? ", so far" : ""}`;
};

function moneyCard(s, ctx) {
  const m = s.home.money;
  const why = s.home.money_missing;
  if (!m && !why) return "";
  if (!m) {
    return html`<section class="card hm-card hm-money" aria-labelledby="hm-money-h"><div class="hm-card-h"><h3 id="hm-money-h">Money this month</h3></div><p class="hm-note">${MISSING[why] || "Money shows here once Rotor's numbers are in."}</p></section>`;
  }
  const more = open(ctx, "/dashboard/money") || open(ctx, "/payments");
  const src = m.source === "rotor" ? `From Rotor · updated ${day(m.as_of)}` : "From the CRM";
  const weeks = (m.weeks || []).filter((w) => w.value !== null && w.value !== undefined);
  const chart = weeks.length && weeks.some((w) => w.value > 0);
  return html`<section class="card hm-card hm-money" aria-labelledby="hm-money-h">
    <div class="hm-card-h"><h3 id="hm-money-h">${m.month.current ? "Money this month" : `Money in ${m.month.label}`}</h3></div>
    <div class="hm-big">${usd(m.collected)}</div>
    <p class="hm-sub">collected ${span(`${m.month.key}-01`, `${m.month.key}-${String(m.month.through).padStart(2, "0")}`)}</p>
    ${compareLine(m)}
    ${chart ? html`<div class="hc-head"><span class="hc-title">Per week</span><span class="hc-read" id="read-weeks" aria-live="polite"><b></b> <span></span></span></div>
      <div class="hc" data-chart="weeks" tabindex="0" role="group" aria-label="Collected per week this month. Arrow keys read each week."></div>
      ${srTable("Collected per week this month", ["Week", "Collected"], weeks.map((w) => [weekRead(m, w), usd(w.value)]))}`
      : m.collected ? "" : html`<p class="hm-note">No money in yet this month.</p>`}
    ${more ? html`<a class="hm-more-row" href="${more}"><span>${src}</span><span class="hm-more">See more</span></a>` : html`<p class="hm-more-row"><span>${src}</span></p>`}
  </section>`;
}

// ------------------------------------------------------------ the screen

// The one module card Home keeps: My visits with the clock (work, M4b).
const HOME_CARDS = new Set(["field"]);

export default {
  title: "Home",
  async load(params, ctx) {
    const [, home, cards] = await Promise.all([ensureStyles(), ctx.api("/home").then((r) => r.data), loadCards(ctx, (c) => HOME_CARDS.has(c.key))]);
    // the server's clock and day (a phone's may be off)
    const now = home && home.now && Number.isFinite(Date.parse(home.now)) ? new Date(home.now) : new Date();
    return { now, user: ctx.user || {}, home: home || {}, cards };
  },
  render(s, ctx) {
    const n = Number(s.home.notifications) || 0;
    const mode = s.home.mode || {};
    // My visits, only when it has something to show (one who goes out on visits)
    const extra = drawCards(s.cards, ctx).filter((c) => c !== "");
    return html`<div class="stack hm">
      <div class="hm-head">
        <div class="hello who"><div class="date">${dateLong(s.now)}</div><h2>${greeting(s.now)}, ${s.user.first_name || (s.user.name || "").split(" ")[0] || "there"}</h2></div>
        <a class="icon-btn bell" href="#/notifications" aria-label="${n ? `Notifications, ${n} new` : "Notifications"}">${icon("bell")}${n ? html`<span class="badge">${n > 99 ? "99+" : n}</span>` : ""}</a>
      </div>
      ${mode.paused ? html`<a class="card alert hm-alert" href="#/settings/data"><h2>The CRM is paused</h2><p>${mode.paused_reason === "restore" ? "A backup was restored. " : ""}Nothing is texted, emailed, charged or automated${mode.paused_at ? ` since ${dateTime(mode.paused_at)}` : ""}. An owner resumes it on Settings → Data.</p></a>` : ""}
      <div class="hm-grid">
        ${today(s, ctx)}
        ${moneyCard(s, ctx)}
      </div>
      ${extra.length ? html`<div class="hm-extra">${extra}</div>` : ""}
    </div>`;
  },
  mount(view, s, ctx) {
    if (ctx) wireCards(view, s.cards, ctx);
    const m = s.home.money;
    const el = view.querySelector('[data-chart="weeks"]');
    const chart = m && el ? columns(el, { rows: m.weeks, fmt: usd, axis: usdShort, read: (w) => weekRead(m, w), readout: view.querySelector("#read-weeks"), height: 132 }) : null;
    this._off = () => { if (chart) chart.destroy(); };
  },
  unmount() { if (this._off) { this._off(); this._off = null; } },
};
