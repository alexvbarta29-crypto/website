// Home (design §9.2 "Today" for owners and the office; industry spec 13.1
// "Owner dashboard"): the first screen the office sees, everything in one
// scroll of cards, from one read (GET /home) and the bell's count:
//
//   the date, a greeting and the bell
//   money this month: the big number, the year against last year, and the
//     weekly columns (12 weeks)
//   quick actions: New lead, New quote, Book a visit, Log a call
//   Today: the counts (visits, done, to book, plan visits due) and the
//     day's visits (time, customer, town, who, status), each to its visit
//   Needs you: one row per kind with its count, each to its screen
//   This month: the KPI tiles, two to a row
//   Sales, Plans, Jobs and Money cards with their charts, each with
//     "See more" (the Dashboard's view on a phone with the office sign-in,
//     else the module's own screen)
//
// Numbers say where they come from ("From Rotor · updated Nov 16") until
// the CRM's own records cover them. A tech never comes here (today.js
// keeps their own day).

import { html, icon, attrs } from "../../core/ui.js";
import { dateLong, dateShort, plural, dateTime, initials, clock } from "../../core/format.js";
import * as router from "../../core/router.js";
import { MANIFESTS } from "../index.js";
import { columns, srTable } from "./home-charts.js";

// The stylesheet, loaded once; the screen waits for it (a second at most),
// so its first paint is already laid out and the charts measure their cards.
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
const count = (n) => Number(n || 0).toLocaleString("en-US");
const pct = (n) => `${Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;
const fmtOf = (t) => (t.fmt === "money" ? usd(t.value) : t.fmt === "pct" ? pct(t.value) : count(t.value));
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDate = (ymd) => (/^\d{4}-\d{2}-\d{2}$/.test(ymd || "") ? `${MONTHS[Number(ymd.slice(5, 7)) - 1]} ${Number(ymd.slice(8, 10))}` : "");
const greeting = (d) => {
  const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", hourCycle: "h23" }).format(d));
  return h < 12 ? "Morning" : h < 17 ? "Afternoon" : "Evening";
};

// ------------------------------------------------------------ where a tap goes

const open = (ctx, path) => {
  const m = path && router.match(path.split("?")[0]);
  return m && (!m.route.perm || ctx.can(m.route.perm)) ? "#" + path : null;
};
// The Dashboard's view when this phone has the office sign-in, else the module's screen.
const seeMore = (ctx, view, fallback) => (view && open(ctx, `/dashboard/${view}`)) || (fallback ? open(ctx, fallback) : null);
const TILE_FALLBACK = { jobs_month: "/jobs", close_rate: "/quotes", active_plans: "/plans", leads_week: "/calls", quotes_out: "/quotes?status=sent" };

const QUICK = [
  { label: "New lead", path: "/leads/new", icon: "contacts" },
  { label: "New quote", path: "/quotes/new", icon: "doc" },
  { label: "Book a visit", path: "/jobs/new", icon: "schedule" },
  { label: "Log a call", path: "/calls/log", icon: "phone" },
];

// Needs you: an icon and a tint per kind of row
const NEED_ICON = [[/^health\./, "shield"], [/^sales\./, "phone"], [/^quotes\./, "doc"], [/^(agreements|agreement_)/, "doc"], [/^plans\./, "schedule"], [/^approvals\./, "check"], [/^contacts\./, "contacts"], [/^work\./, "list"], [/^import\./, "data"], [/^(money|invoices|payments)\./, "money"], [/^(comms|inbox)\./, "inbox"]];
const needIcon = (key) => (NEED_ICON.find(([re]) => re.test(key)) || [null, "bell"])[1];

const VISIT_STATUS = { scheduled: null, en_route: ["On the way", "blue"], in_progress: ["Working", "amber"], paused: ["Paused", "amber"], completed: ["Done", "green"] };
const colorOk = (c) => /^#[0-9a-f]{6}$/i.test(c || "");

// ------------------------------------------------------------ pieces

function sourceLine(src) {
  if (!src) return "";
  const r = src.rotor ? `updated ${shortDate(src.rotor.as_of)}` : "";
  if (src.crm && src.rotor) return `From the CRM, and Rotor (${r}) for money and leads`;
  if (src.crm) return "From the CRM";
  return src.rotor ? `From Rotor · ${r}` : "";
}

function hero(s, ctx) {
  const k = s.home.kpis;
  const month = k && k.tiles.find((t) => t.key === "collected_month");
  if (!month) return "";
  const ytd = k.tiles.find((t) => t.key === "collected_ytd");
  const more = seeMore(ctx, "money", null);
  const weeks = k.money && k.money.weekly.length ? k.money.weekly : null;
  const src = month.source === "rotor" && k.source.rotor ? `From Rotor · updated ${shortDate(k.source.rotor.as_of)}` : "From the CRM";
  return html`<section class="card hm-hero" aria-label="Money this month">
    <div class="hm-row"><span class="hm-label">${month.label}</span><span class="hm-src">${month.note}</span></div>
    <div class="hm-big">${usd(month.value)}</div>
    ${ytd ? html`<div class="hm-ytd">${ytd.delta ? html`<span class="${"hm-delta " + (ytd.delta.up ? "up" : "down")}"><span aria-hidden="true">${ytd.delta.up ? "▲" : "▼"}</span> ${Math.abs(ytd.delta.pct)}% <span class="sr">${ytd.delta.up ? "up" : "down"}</span></span>` : ""}<span>${usd(ytd.value)} this year${ytd.delta ? ` ${ytd.delta.vs}` : ""}</span></div>` : ""}
    ${weeks ? html`<div class="hc-head"><span class="hc-title">Collected per week</span><span class="hc-read" id="read-weekly" aria-live="polite"><b></b> <span></span></span></div>
      <div class="hc" data-chart="weekly" tabindex="0" role="group" aria-label="Collected per week, last 12 weeks. Arrow keys read each week."></div>
      ${srTable("Collected per week", ["Week of", "Collected"], weeks.map((w) => [w.label, usd(w.value)]))}` : ""}
    ${more ? html`<a class="hm-more-row" href="${more}"><span>${src}</span><span class="hm-more">See more</span></a>` : src ? html`<p class="hm-more-row"><span>${src}</span></p>` : ""}
  </section>`;
}

function quick(ctx) {
  const items = QUICK.map((q) => ({ ...q, href: open(ctx, q.path) })).filter((q) => q.href);
  if (!items.length) return "";
  return html`<nav class="hm-quick" aria-label="Quick actions">${items.map((q) => html`<a class="hm-qa" href="${q.href}"><span class="qi">${icon(q.icon)}</span><span class="ql">${q.label}</span></a>`)}</nav>`;
}

function visitTime(v) {
  if (v.date_only) return html`<span class="hv-time"><b>Any</b><small>time</small></span>`;
  const st = clock(v.start);
  const [t, ap] = st.split(" ");
  return html`<span class="hv-time"><b>${t}</b><small>${ap}</small></span>`;
}
function people(list) {
  if (!list || !list.length) return html`<span class="hv-people"><span class="hv-av none" title="Nobody assigned">?</span></span>`;
  return html`<span class="hv-people">${list.slice(0, 3).map((p) => html`<span class="hv-av" ${attrs({ style: colorOk(p.color) ? `background:${p.color}` : null, title: p.name })}>${initials(p.name || p.first_name)}</span>`)}<span class="sr">${list.map((p) => p.first_name || p.name).join(", ")}</span></span>`;
}

function today(s, ctx) {
  const d = s.home.today;
  if (!d) return "";
  const c = d.counts || {};
  const sched = open(ctx, "/schedule");
  const tray = open(ctx, "/schedule?view=tray");
  const due = open(ctx, "/plans/due");
  const stat = (n, label, href) => (href ? html`<a class="hm-stat" href="${href}"><b>${count(n)}</b><span>${label}</span></a>` : html`<span class="hm-stat"><b>${count(n)}</b><span>${label}</span></span>`);
  const visits = d.visits || [];
  return html`<section class="card hm-card hm-today" aria-label="Today">
    <div class="hm-card-h"><h3>Today <span class="hm-dim">${dateShort(d.date)}</span></h3>${sched ? html`<a class="hm-more" href="${sched}">Schedule</a>` : ""}</div>
    <div class="hm-stats">
      ${stat(c.visits, c.visits === 1 ? "visit" : "visits", sched)}
      ${stat(c.done, "done", null)}
      ${stat(c.to_book, "to book", tray)}
      ${c.plan_due === null || c.plan_due === undefined ? "" : stat(c.plan_due, "plan visits due", due)}
    </div>
    ${visits.length ? html`<ul class="hm-visits">${visits.map((v) => {
      const stt = VISIT_STATUS[v.status];
      const href = open(ctx, `/visits/${v.id}`);
      const body = html`${visitTime(v)}<span class="who"><span class="nm">${v.name || "Customer"}</span><span class="sub">${[v.town, v.title].filter(Boolean).join(" · ")}</span></span>${stt ? html`<span class="${"pill " + stt[1]}">${stt[0]}</span>` : ""}${people(v.people)}`;
      return html`<li>${href ? html`<a class="hv-row" href="${href}">${body}</a>` : html`<div class="hv-row">${body}</div>`}</li>`;
    })}</ul>${c.visits > visits.length ? html`<a class="hm-more-row" href="${sched || "#/today"}"><span>${plural(c.visits - visits.length, "more visit")}</span><span class="hm-more">Schedule</span></a>` : ""}`
      : html`<div class="hm-empty"><span class="art">${icon("sun")}</span><div><b>No visits booked today</b><p>${c.to_book ? `${plural(c.to_book, "job")} waiting to be booked.` : "A quiet day on the schedule."}</p></div>${open(ctx, "/jobs/new") ? html`<a class="btn" href="#/jobs/new">Book a visit</a>` : ""}</div>`}
  </section>`;
}

function needs(s) {
  const rows = s.home.needs || [];
  const b = s.badges || {};
  const total = rows.reduce((a, r) => a + r.count, 0);
  return html`<section class="card hm-card hm-needs" aria-label="Needs you">
    <div class="hm-card-h"><h3>Needs you</h3>${total ? html`<span class="hm-total">${count(total)}</span>` : ""}</div>
    ${rows.length ? html`<ul class="hm-rows">${rows.map((r) => html`<li><a class="hm-need" ${attrs({ href: r.link || "#/today" })}><span class="${"ni " + r.kind}">${icon(needIcon(r.key))}</span><span class="nl">${r.label}</span><span class="nn">${count(r.count)}</span><span class="chev" aria-hidden="true"></span></a></li>`)}</ul>`
      : html`<div class="hm-clear"><span class="art">${icon("check")}</span><span><b>You're all caught up</b><small>${b.notifications ? `${plural(b.notifications, "notification")} under the bell.` : "Nothing waiting on you right now."}</small></span></div>`}
  </section>`;
}

function kpiGrid(s, ctx, skip) {
  const k = s.home.kpis;
  if (!k) return "";
  const tiles = k.tiles.filter((t) => !skip.has(t.key));
  if (!tiles.length && !k.tiles.length) {
    const why = k.source && k.source.rotor_missing;
    return html`<section class="card hm-card hm-nonum"><div class="hm-card-h"><h3>Your numbers</h3></div><p>${why === "no-key" ? "Revenue, close rate and plans show here once the office data key is set in Netlify (OFFICE_DATA_KEY), or once the Rotor import has run." : why === "bad-key" ? "The Rotor numbers can't be opened with this site's office data key. Re-seal the dashboard snapshot (docs/DASHBOARD.md)." : "Revenue, close rate and plans show here once the Rotor numbers or the import are in."}</p></section>`;
  }
  if (!tiles.length) return "";
  const mixed = k.source.crm && tiles.some((t) => t.source === "rotor") && tiles.some((t) => t.source === "crm");
  return html`<section class="hm-sec" aria-label="This month">
    <div class="hm-sec-h"><h3 class="section-h">This month</h3><span class="hm-src">${sourceLine(k.source)}</span></div>
    <div class="hm-kpis">${tiles.map((t) => {
      const href = seeMore(ctx, t.view, TILE_FALLBACK[t.key]);
      const inner = html`<span class="hm-label">${t.label}${mixed && t.source === "rotor" ? html` <span class="hm-tag">Rotor</span>` : ""}</span>
        <span class="hm-val">${fmtOf(t)}</span>
        <span class="hm-note">${t.target ? html`<span class="${"hm-dot " + (t.target.ok ? "ok" : "low")}" aria-hidden="true"></span><span class="sr">${t.target.ok ? "On target" : "Below target"}, </span>` : ""}${t.delta ? html`<span class="${"hm-delta " + (t.delta.up ? "up" : "down")}">${t.delta.up ? "▲" : "▼"} ${Math.abs(t.delta.pct)}%</span> ` : ""}${t.note || ""}</span>`;
      return href ? html`<a class="hm-kpi" href="${href}">${inner}</a>` : html`<div class="hm-kpi">${inner}</div>`;
    })}</div>
  </section>`;
}

const mini = (items) => html`<div class="hm-mini">${items.filter(Boolean).map(([label, value, href]) => (href ? html`<a href="${href}"><b>${value}</b><span>${label}</span></a>` : html`<div><b>${value}</b><span>${label}</span></div>`))}</div>`;
const cardHead = (title, href, src) => html`<div class="hm-card-h"><h3>${title}${src ? html` <span class="hm-dim">${src}</span>` : ""}</h3>${href ? html`<a class="hm-more" href="${href}">See more</a>` : ""}</div>`;
const srcTag = (k, part) => (part && part.source === "rotor" && k.source.crm ? "Rotor" : "");

function salesCard(s, ctx) {
  const k = s.home.kpis;
  const c = k && k.sales;
  if (!c) return "";
  const q = c.quotes || {};
  const leads = c.leads && c.leads.length ? c.leads : null;
  return html`<section class="card hm-card hm-sales" aria-label="Sales">
    ${cardHead("Sales", seeMore(ctx, "sales", "/calls"), "")}
    ${mini([
      c.leads_4w === null || c.leads_4w === undefined ? null : ["new leads in 4 weeks", count(c.leads_4w), open(ctx, "/calls")],
      c.close_rate === null || c.close_rate === undefined ? null : ["close rate", pct(c.close_rate), open(ctx, "/quotes")],
      q.out === null || q.out === undefined ? null : ["quotes out", count(q.out), open(ctx, "/quotes?status=sent")],
    ])}
    ${leads ? html`<div class="hc-head"><span class="hc-title">New leads per week</span><span class="hc-read" id="read-leads" aria-live="polite"><b></b> <span></span></span></div>
      <div class="hc" data-chart="leads" tabindex="0" role="group" aria-label="New leads per week, last 12 weeks. Arrow keys read each week."></div>
      ${srTable("New leads per week", ["Week of", "Leads"], leads.map((w) => [w.label, count(w.value)]))}` : ""}
    ${q.won !== null && q.won !== undefined && (q.won || q.lost) ? html`<p class="hm-foot-note">${count(q.won)} quotes won, ${count(q.lost || 0)} lost${q.changes ? `, ${count(q.changes)} asking for changes` : ""}.</p>` : ""}
  </section>`;
}

function plansCard(s, ctx) {
  const k = s.home.kpis;
  const c = k && k.plans;
  if (!c) return "";
  const due = s.home.today ? s.home.today.counts.plan_due : null;
  const mix = (c.mix || []).slice(0, 5);
  const max = Math.max(1, ...mix.map((m) => m.value));
  return html`<section class="card hm-card hm-plans" aria-label="Plans">
    ${cardHead("Plans", seeMore(ctx, "plans", "/plans"), "")}
    ${mini([
      c.active === null || c.active === undefined ? null : ["active plans", count(c.active), open(ctx, "/plans")],
      c.worth ? ["on the books", usd(c.worth), null] : null,
      due === null || due === undefined ? (c.recurring_share !== null && c.recurring_share !== undefined ? ["recurring", pct(c.recurring_share), null] : null) : ["visits to book", count(due), open(ctx, "/plans/due")],
    ])}
    ${mix.length ? html`<div class="hc-title hm-mix-h">Plan mix</div><ul class="hm-bars">${mix.map((m) => html`<li><span class="bl">${m.label}</span><span class="bt"><span class="bf" ${attrs({ style: `width:${Math.max(2, Math.round((m.value / max) * 100))}%` })}></span></span><span class="bv">${count(m.value)}</span></li>`)}</ul>` : ""}
  </section>`;
}

function jobsCard(s, ctx) {
  const k = s.home.kpis;
  const c = k && k.jobs;
  if (!c) return "";
  const d = s.home.today;
  const next = c.visits_next && c.visits_next.length ? c.visits_next : null;
  return html`<section class="card hm-card hm-jobs" aria-label="Jobs">
    ${cardHead("Jobs", seeMore(ctx, "jobs", "/schedule"), "")}
    ${mini([
      c.done_month === null || c.done_month === undefined ? null : ["jobs this month", count(c.done_month), open(ctx, "/jobs")],
      c.unscheduled === null || c.unscheduled === undefined ? null : ["not scheduled", count(c.unscheduled), open(ctx, "/schedule?view=tray")],
      d ? ["visits today", count(d.counts.visits), open(ctx, "/schedule")] : null,
    ])}
    ${next ? html`<div class="hc-head"><span class="hc-title">Visits, next 4 weeks</span><span class="hc-read" id="read-visits" aria-live="polite"><b></b> <span></span></span></div>
      <div class="hc hc-short" data-chart="visits" tabindex="0" role="group" aria-label="Visits booked per week, the next four weeks. Arrow keys read each week."></div>
      ${srTable("Visits per week", ["Week of", "Visits"], next.map((w) => [w.label, count(w.value)]))}` : ""}
  </section>`;
}

function moneyCard(s, ctx) {
  const k = s.home.kpis;
  const m = k && k.money;
  if (!m || !m.monthly || !m.monthly.length) return "";
  const y = m.year || new Date().getFullYear();
  return html`<section class="card hm-card hm-money" aria-label="Money by month">
    ${cardHead("Collected by month", seeMore(ctx, "money", null), "")}
    <div class="hc-head"><span class="hm-legend"><span class="sw cur"></span>${y}<span class="sw prev"></span>${y - 1}</span><span class="hc-read" id="read-monthly" aria-live="polite"><b></b> <span></span></span></div>
    <div class="hc" data-chart="monthly" tabindex="0" role="group" aria-label="${`Collected each month in ${y} beside ${y - 1}. Arrow keys read each month.`}"></div>
    ${srTable(`Collected by month, ${y} and ${y - 1}`, ["Month", String(y), String(y - 1)], m.monthly.map((r) => [r.label, usd(r.cur), usd(r.prev)]))}
  </section>`;
}

// The modules' own cards (manifest todayCards), but for those whose counts
// are already "Needs you" rows here (home: false): a module that ships a
// card of its own (Money's strip, say) shows up under Needs you.
async function moduleCards(ctx) {
  const defs = MANIFESTS.flatMap((m) => m.todayCards || []).filter((c) => c && c.home !== false && typeof c.load === "function" && (!c.perm || ctx.can(c.perm))).sort((a, b) => (a.order || 50) - (b.order || 50));
  const out = await Promise.all(defs.map(async (c) => {
    try { const mod = (await c.load()).default; return { mod, state: mod.load ? await mod.load(ctx) : {} }; } catch (e) { return null; }
  }));
  return out.filter(Boolean);
}

// ------------------------------------------------------------ the screen

export default {
  title: "Home",
  async load(params, ctx) {
    const [, home, badges, cards] = await Promise.all([
      ensureStyles(),
      ctx.api("/home").then((r) => r.data),
      ctx.api("/me/badges", { cache: false }).then((r) => r.data).catch(() => null),
      moduleCards(ctx),
    ]);
    // the server's clock and day (a phone's may be off)
    const now = home && home.now && Number.isFinite(Date.parse(home.now)) ? new Date(home.now) : new Date();
    return { now, user: ctx.user || {}, home: home || {}, badges, cards };
  },
  render(s, ctx) {
    const b = s.badges || {};
    const mode = s.home.mode || {};
    const k = s.home.kpis;
    const heroShown = !!(k && k.tiles.some((t) => t.key === "collected_month"));
    const skip = new Set(heroShown ? ["collected_month", "collected_ytd"] : []);
    const src = k ? sourceLine(k.source) : "";
    return html`<div class="stack hm">
      <div class="hm-head">
        <div class="hello who"><div class="date">${dateLong(s.now)}</div><h2>${greeting(s.now)}, ${s.user.first_name || (s.user.name || "").split(" ")[0] || "there"}</h2></div>
        <a class="icon-btn bell" href="#/notifications" aria-label="${b.notifications ? `Notifications, ${b.notifications} new` : "Notifications"}">${icon("bell")}${b.notifications ? html`<span class="badge">${b.notifications > 99 ? "99+" : b.notifications}</span>` : ""}</a>
      </div>
      ${mode.paused ? html`<a class="card alert hm-alert" href="#/settings/data"><h2>The CRM is paused</h2><p>${mode.paused_reason === "restore" ? "A backup was restored. " : ""}Nothing is texted, emailed, charged or automated${mode.paused_at ? ` since ${dateTime(mode.paused_at)}` : ""}. An owner resumes it on Settings → Data.</p></a>` : ""}
      ${hero(s, ctx)}
      ${quick(ctx)}
      ${today(s, ctx)}
      ${needs(s)}
      ${(s.cards || []).length ? html`<div class="hm-extra">${s.cards.map((c) => { try { return c.mod.render(c.state, ctx); } catch (e) { return ""; } })}</div>` : ""}
      ${kpiGrid(s, ctx, skip)}
      ${salesCard(s, ctx)}
      ${plansCard(s, ctx)}
      ${jobsCard(s, ctx)}
      ${moneyCard(s, ctx)}
      ${src ? html`<p class="foot-note hm-foot">${src}. Today's visits and what needs you are the CRM's own.</p>` : ""}
    </div>`;
  },
  mount(view, s) {
    const k = s.home.kpis;
    const charts = [];
    const add = (key, spec) => {
      const el = view.querySelector(`[data-chart="${key}"]`);
      if (el) charts.push(columns(el, { ...spec, readout: view.querySelector(`#read-${key}`) }));
    };
    if (k && k.money) {
      add("weekly", { rows: k.money.weekly, fmt: usd, axis: usdShort, read: (r) => `week of ${r.label}`, height: 132 });
      add("monthly", { rows: k.money.monthly, value: (r) => r.cur, prev: (r) => r.prev, fmt: usd, axis: usdShort, read: (r) => `${r.label}, ${usd(r.prev)} a year earlier`, height: 140 });
    }
    if (k && k.sales && k.sales.leads && k.sales.leads.length) add("leads", { rows: k.sales.leads, fmt: (v) => plural(v, "lead"), axis: (v) => String(v), read: (r) => `week of ${r.label}`, height: 112, whole: true });
    if (k && k.jobs && k.jobs.visits_next && k.jobs.visits_next.length) add("visits", { rows: k.jobs.visits_next, fmt: (v) => plural(v, "visit"), axis: (v) => String(v), read: (r) => `week of ${r.label}`, height: 104, whole: true });
    this._off = () => charts.forEach((c) => c.destroy());
  },
  unmount() { if (this._off) { this._off(); this._off = null; } },
};
