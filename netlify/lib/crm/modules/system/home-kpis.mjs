// Home's pure parts (the owner's Nov 12 choice: Rotor's phone Home and the
// best of Flyra's, as cards each person shows, hides and orders). No I/O,
// no clock: callers pass today (a local YYYY-MM-DD) and the rows they read.
//
//   periodOf(period, today, { from, to })   This week · This month · Last 3 months · This year · Custom
//   rotorCollected(snap, p, today)          Rotor's sealed snapshot: totals and its weeks or months
//   crmCollected(rows, p, today)            the CRM's payments, per day (after cutover)
//   scheduledDays(visits, jobs, p)          the value of the visits booked, per day
//   arrDays(plans, p, today)                annual recurring revenue of the live plans, per day
//   moneyCard({ metric, p, series, ... })   → the Money card (total, AVG / PEAK or CHANGE, goal)
//   clockToday(rows, uid, today, nowMs)     the Timesheet card: today's minutes, the open shift
//   agendaOf(visits, users, p)              the Agenda's rows (Daily · Weekly · Monthly)
//   tasksOf(rows, user, { all })            open tasks (the Agenda's "without due date", the Tasks card)
//   inboxOf(rows)                           the Inbox card (unread first)
//   layoutOf(saved, available)              the person's cards, in their order
//   validateGoals(v)                        the owners' monthly goals (settings document "goals")
//
// Money says where it comes from: Rotor's snapshot until cutover (no
// per-day numbers there: its weeks, or its months for a year, carry the
// chart), the CRM's own payments index after (counted as GET
// /money/summary counts revenue). Scheduled and ARR are the CRM's own
// visits and plans. Nothing invents a zero: a number nobody has is null
// (the screen shows "-").

import { addLocalDays, dowOfDate, localDate, isLocalDate } from "../../core/clock.mjs";
import { InputError } from "../../core/errors.mjs";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const num = (v) => (v === null || v === undefined || v === "" || typeof v === "boolean" || !Number.isFinite(Number(v)) ? null : Number(v));
const list = (v) => (Array.isArray(v) ? v : []);
const pad = (n) => String(n).padStart(2, "0");
// the snapshot keeps dollars (two decimals at most); Home works in cents like the rest of the CRM
export const toCents = (dollars) => (num(dollars) === null ? null : Math.round(Number(dollars) * 100));
export const monthLabel = (key) => MONTHS[Number(String(key).slice(5, 7)) - 1] || "";
export const dayLabel = (date) => `${monthLabel(date)} ${Number(String(date).slice(8, 10))}`;
// the Monday of a local date's week (Rotor's weeks start on Monday)
export const weekStart = (date) => addLocalDays(date, -((dowOfDate(date) + 6) % 7));
export const daysIn = (monthKey) => new Date(Date.UTC(Number(monthKey.slice(0, 4)), Number(monthKey.slice(5, 7)), 0)).getUTCDate();
const monthEnd = (key) => `${key}-${pad(daysIn(key))}`;
const addMonths = (key, n) => { const t = Number(key.slice(0, 4)) * 12 + Number(key.slice(5, 7)) - 1 + n; return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`; };
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
// "Nov 9 – 15", "Oct 28 – Nov 3"
export const spanLabel = (from, to) => (from === to ? dayLabel(from) : from.slice(0, 7) === to.slice(0, 7) ? `${dayLabel(from)} – ${Number(to.slice(8, 10))}` : `${dayLabel(from)} – ${dayLabel(to)}`);
export function dates(from, to) {
  const out = [];
  for (let d = from; d <= to && out.length < 400; d = addLocalDays(d, 1)) out.push(d);
  return out;
}
// the month keys a range touches
export function monthsOf(from, to) {
  const out = [];
  for (let m = from.slice(0, 7); m <= to.slice(0, 7) && out.length < 14; m = addMonths(m, 1)) out.push(m);
  return out;
}

// ------------------------------------------------------------ periods

export const PERIODS = Object.freeze(["week", "month", "3m", "year", "custom"]);
export const MAX_CUSTOM_DAYS = 366;

// → { period, from, to, label }
export function periodOf(period, today, { from, to } = {}) {
  const month = today.slice(0, 7);
  if (period === "week") { const f = weekStart(today); return { period, from: f, to: addLocalDays(f, 6), label: spanLabel(f, addLocalDays(f, 6)) }; }
  if (period === "3m") { const f = `${addMonths(month, -2)}-01`; return { period, from: f, to: monthEnd(month), label: `${MONTHS_LONG[Number(f.slice(5, 7)) - 1]} – ${MONTHS_LONG[Number(month.slice(5, 7)) - 1]}` }; }
  if (period === "year") return { period, from: `${today.slice(0, 4)}-01-01`, to: `${today.slice(0, 4)}-12-31`, label: today.slice(0, 4) };
  if (period === "custom") {
    if (!isLocalDate(from) || !isLocalDate(to)) throw new InputError("Pick the first and the last day.", "from");
    if (to < from) throw new InputError("The last day comes after the first.", "to");
    if (daysBetween(from, to) >= MAX_CUSTOM_DAYS) throw new InputError("A year at most.", "to");
    return { period, from, to, label: spanLabel(from, to) };
  }
  return { period: "month", from: `${month}-01`, to: monthEnd(month), label: MONTHS_LONG[Number(month.slice(5, 7)) - 1] };
}

// ------------------------------------------------------------ collected

// Collected between two local dates from payments index rows, as GET
// /money/summary counts revenue (§5.6, cash basis): succeeded payments less
// succeeded refunds, tips in, simulated (dry-run) payments never.
export function collectedOf(rows, from, to) {
  let n = 0;
  for (const r of list(rows)) {
    if (!r || r.st !== "succeeded" || r.sim || !(r.on >= from && r.on <= to)) continue;
    const v = (num(r.a) || 0) + (num(r.tip) || 0);
    if (r.k === "payment") n += v;
    else if (r.k === "refund") n -= v;
  }
  return n;
}

// The CRM's own payments (after cutover): every day of the period, days
// still ahead null. → { total, grain: "day", points }
export function crmCollected(rows, p, today) {
  const byDay = new Map();
  for (const r of list(rows)) {
    if (!r || r.st !== "succeeded" || r.sim || !(r.on >= p.from && r.on <= p.to)) continue;
    const v = (num(r.a) || 0) + (num(r.tip) || 0);
    byDay.set(r.on, (byDay.get(r.on) || 0) + (r.k === "refund" ? -v : r.k === "payment" ? v : 0));
  }
  const points = dates(p.from, p.to).map((d) => ({ key: d, label: dayLabel(d), from: d, to: d, value: d > today ? null : byDay.get(d) || 0 }));
  return { total: points.reduce((a, x) => a + (x.value || 0), 0), grain: "day", points, through: today < p.to ? today : p.to };
}

// Rotor's sealed snapshot (build/office_dashboard.mjs): its month totals
// (12 months to as_of) and its Monday weeks (the last 12). A total the
// snapshot doesn't hold is null; the chart is its weeks (a week or a
// month, three months) or its months (a year). → { total, grain, points, through }
export function rotorCollected(snap, p, today) {
  if (!snap || typeof snap !== "object" || !isLocalDate(snap.as_of)) return null;
  const R = snap.revenue || {};
  const asOf = snap.as_of;
  const through = asOf < p.to ? asOf : p.to;
  const monthly = new Map(list(R.monthly).filter((m) => m && /^\d{4}-\d{2}$/.test(m.key)).map((m) => [m.key, toCents(m.cur)]));
  if (toCents(R.this_month) !== null) monthly.set(asOf.slice(0, 7), toCents(R.this_month));
  const weekly = list(R.weekly).filter((w) => w && isLocalDate(w.key)).map((w) => ({ key: w.key, value: toCents(w.value) || 0 }));
  const sumMonths = (keys) => (keys.every((k) => k > asOf.slice(0, 7) || monthly.has(k)) && keys.some((k) => monthly.has(k)) ? keys.reduce((a, k) => a + (monthly.get(k) || 0), 0) : null);
  let total = null, grain = null, points = [];
  if (p.period === "week") {
    const w = weekly.find((x) => x.key === p.from);
    total = w ? w.value : null;
  } else if (p.period === "month" || p.period === "3m" || p.period === "year") {
    const keys = monthsOf(p.from, p.to);
    total = sumMonths(keys);
    if (p.period === "year") {
      grain = "month";
      points = keys.map((k) => ({ key: k, label: monthLabel(k), from: `${k}-01`, to: monthEnd(k), value: k > asOf.slice(0, 7) ? null : monthly.has(k) ? monthly.get(k) : null }));
    } else {
      grain = "week";
      // Rotor's weeks that start in the period (a week starting the day before the 1st is last month's)
      points = weekly.filter((w) => w.key >= p.from && w.key <= p.to).map((w) => ({ key: w.key, label: dayLabel(w.key), from: w.key, to: addLocalDays(w.key, 6), value: w.value }));
    }
  }
  if (total === null) points = [];
  return { total, grain: points.length > 1 ? grain : null, points: points.length > 1 ? points : [], through, as_of: asOf };
}

// ------------------------------------------------------------ scheduled

const DEAD_VISIT = new Set(["cancelled", "no_access"]);
// A visit carries its job's total when it is the job's first visit (a job
// of several days counts once); the others carry nothing.
export function visitValue(v, jobs) {
  if ((v.ord || 1) !== 1) return 0;
  const j = jobs.get(v.j);
  return j && j.bill !== false ? num(j.tot) || 0 : 0;
}
// jobs: Map(job id → index row). → { total, grain: "day", points }
export function scheduledDays(visits, jobs, p) {
  const byDay = new Map();
  for (const v of list(visits)) {
    if (!v || DEAD_VISIT.has(v.st) || !(v.d >= p.from && v.d <= p.to)) continue;
    byDay.set(v.d, (byDay.get(v.d) || 0) + visitValue(v, jobs));
  }
  const points = dates(p.from, p.to).map((d) => ({ key: d, label: dayLabel(d), from: d, to: d, value: byDay.get(d) || 0 }));
  return { total: points.reduce((a, x) => a + x.value, 0), grain: "day", points, through: p.to };
}

// ------------------------------------------------------------ ARR

// Annual recurring revenue of a live plan: its per-visit price × visits a
// year, which is its current term's sale value scaled to a year (a first
// term is 12 months; a renewal term the catalog's renews_every_months). A
// plan whose current term ends more than a year after it was made has
// been renewed.
const RENEW_MONTHS = { biannual: 6, quarterly: 3, monthly: 1, lights_annual: 12, custom: 6 };
const LIVE_PLAN = new Set(["active", "cancelling", "paused"]);
export function planArr(r) {
  const sv = num(r.sv) || 0;
  if (sv <= 0) return 0;
  const start = localOf(r.at), end = r.te || null;
  const firstTerm = !end || !start || daysBetween(start, end) <= 380;
  const months = firstTerm ? 12 : RENEW_MONTHS[r.ck] || (r.k === "lights_annual" ? 12 : 6);
  return Math.round((sv * 12) / months);
}
const localOf = (iso) => { const t = Date.parse(iso || ""); return Number.isFinite(t) ? localDate(new Date(t)) : ""; };
// A plan counts from the day it was made (if it's live or ended later)
// to the day its cancellation takes effect.
export function arrOn(plans, d) {
  let n = 0;
  for (const r of list(plans)) {
    if (!r) continue;
    const start = localOf(r.at);
    if (!start || start > d) continue;
    const live = LIVE_PLAN.has(r.st);
    const endedAfter = !live && r.eff && r.eff > d;
    if (live ? !(r.eff && r.eff <= d) : endedAfter) n += planArr(r);
  }
  return n;
}
// → { total (the period's last day, or today), change (over the period), grain: "day", points } | null without any plan
export function arrDays(plans, p, today) {
  if (!list(plans).length) return null;
  const end = today < p.to ? today : p.to;
  if (end < p.from) return { total: arrOn(plans, p.from), change: 0, grain: null, points: [], through: p.from };
  const points = dates(p.from, p.to).map((d) => ({ key: d, label: dayLabel(d), from: d, to: d, value: d > end ? null : arrOn(plans, d) }));
  const total = arrOn(plans, end);
  return { total, change: total - arrOn(plans, addLocalDays(p.from, -1)), grain: "day", points, through: end };
}

// ------------------------------------------------------------ the Money card

const pct = (v, of) => (num(of) > 0 && num(v) !== null ? Math.round((v / of) * 100) : null);
// → { metric, period, from, to, label, source, as_of, total, grain, points, avg, peak, change, goal }
export function moneyCard({ metric, p, series, source, asOf = null, goals = null }) {
  const s = series || { total: null, grain: null, points: [] };
  const out = { metric, period: p.period, from: p.from, to: p.to, label: p.label, source, as_of: asOf, total: num(s.total), grain: s.grain || null, points: s.points || [], avg: null, peak: null, change: null, goal: null };
  if (metric === "arr") out.change = num(s.change);
  else if (out.total !== null) {
    const through = s.through || p.to;
    const days = Math.max(1, daysBetween(p.from, through < p.from ? p.from : through) + 1);
    out.avg = Math.round(out.total / days);
    const best = out.points.filter((x) => x.value !== null).reduce((b, x) => (!b || x.value > b.value ? x : b), null);
    out.peak = best && best.value > 0 ? { value: best.value, key: best.key, label: out.grain === "day" ? best.label : out.grain === "week" ? `week of ${best.label}` : best.label } : null;
  }
  // the month's revenue goal, under the big number
  const target = goals && num(goals.revenue_month_cents);
  if (metric === "collected" && p.period === "month" && target > 0 && out.total !== null) out.goal = { target, value: out.total, pct: pct(out.total, target) };
  return out;
}

// ------------------------------------------------------------ the Timesheet card

const COUNTED = new Set(["closed", "approved", "locked"]);
// Today's minutes (finished shifts that count, and the open one so far)
// and the open shift, from the timesheets index (this month's shard).
export function clockToday(rows, uid, today, nowMs) {
  let minutes = 0, open = null;
  for (const r of list(rows)) {
    if (!r || r.uid !== uid) continue;
    if (r.st === "open" && !r.e) {
      if (!open || String(r.s) > String(open.start_at)) open = { start_at: r.s, category: r.cat || "service" };
      if (r.d === today) minutes += Math.max(0, Math.round((nowMs - Date.parse(r.s)) / 60000));
    } else if (r.d === today && COUNTED.has(r.st)) minutes += num(r.min) || 0;
  }
  return { minutes, open };
}

// ------------------------------------------------------------ the Agenda

export const AGENDA_VIEWS = Object.freeze(["day", "week", "month"]);
// → { from, to }
export function agendaRange(view, date) {
  if (view === "week") { const f = weekStart(date); return { from: f, to: addLocalDays(f, 6) }; }
  if (view === "month") return { from: `${date.slice(0, 7)}-01`, to: monthEnd(date.slice(0, 7)) };
  return { from: date, to: date };
}
const KIND = { lights_install: "Lights install", lights_takedown: "Lights takedown", lights_warranty: "Lights warranty", touch_up: "Touch-up", warranty: "Warranty visit" };
const byTime = (a, b) => String(a.d).localeCompare(String(b.d)) || (a.do ? 1 : 0) - (b.do ? 1 : 0) || String(a.s || "").localeCompare(String(b.s || "")) || String(a.id).localeCompare(String(b.id));
// users: index rows; → [{ id, date, start, end, date_only, name, kind, status, people }]
export function agendaOf(visits, users, { from, to }, max = 120) {
  const people = new Map(list(users).map((u) => [u.id, u]));
  const person = (id) => { const u = people.get(id); return { id, name: (u && u.name) || "", first_name: (u && u.first_name) || "", color: (u && u.color) || null }; };
  const rows = list(visits).filter((v) => v && !DEAD_VISIT.has(v.st) && v.d >= from && v.d <= to).sort(byTime);
  return {
    count: rows.length,
    items: rows.slice(0, max).map((v) => ({
      id: v.id, date: v.d, start: v.s || null, end: v.e || null, date_only: !!v.do, name: v.cn || "", town: v.town || "",
      kind: v.pl ? "Plan visit" : KIND[v.k] || "Job", status: v.st, people: (v.a || []).slice(0, 4).map(person),
    })),
  };
}

// ------------------------------------------------------------ tasks and the inbox

const TASK_ORDER = { in_progress: 0, open: 1, waiting: 2 };
// Open tasks: an owner's whole team's, anyone else's own. → [{ id, title, status, due, contact }]
export function tasksOf(rows, user, { all = false, max = 60 } = {}) {
  return list(rows).filter((r) => r && (all || (r.a || []).includes(user.id)))
    .sort((a, b) => (a.due ? 0 : 1) - (b.due ? 0 : 1) || String(a.due || "").localeCompare(String(b.due || "")) || (TASK_ORDER[a.st] ?? 3) - (TASK_ORDER[b.st] ?? 3) || String(b.u || "").localeCompare(String(a.u || "")))
    .slice(0, max).map((r) => ({ id: r.id, title: r.t || "Task", status: r.st, due: r.due || null, contact: r.cn || "" }));
}
// The latest conversations, unread first. → [{ id, name, preview, at, unread, channel, needs_reply }]
export function inboxOf(rows, max = 5) {
  return list(rows).filter((r) => r && r.st === "open")
    .sort((a, b) => (b.u > 0 ? 1 : 0) - (a.u > 0 ? 1 : 0) || String(b.la || "").localeCompare(String(a.la || "")))
    .slice(0, max).map((r) => ({ id: r.id, name: r.n || "Someone", preview: String(r.p || "").slice(0, 120), at: r.la || null, unread: num(r.u) || 0, channel: r.ch || "sms", needs_reply: !!r.nr }));
}

// ------------------------------------------------------------ the leaderboard

// The reports module's "reports.leaderboard" answer (another track; the
// card is hidden while the service is missing), read leniently:
// { rows: [{ user_id, name, color?, value_cents, count?, note? }] } or the rows alone.
export function normalizeBoard(r, board, month) {
  const rows = Array.isArray(r) ? r : r && Array.isArray(r.rows) ? r.rows : [];
  return {
    board, month, title: `${MONTHS_LONG[Number(month.slice(5, 7)) - 1]} Leaderboard`,
    rows: rows.filter((x) => x && typeof x === "object").slice(0, 10).map((x, i) => {
      const count = num(x.count);
      return {
        rank: num(x.rank) || i + 1, id: String(x.user_id || x.id || ""), name: String(x.name || x.user_name || "").slice(0, 60), color: /^#[0-9a-f]{6}$/i.test(x.color || "") ? x.color : null,
        value: num(x.value_cents ?? x.arr_cents ?? x.amount_cents ?? x.revenue_cents), unit: board === "sales" ? "ARR" : null,
        note: String(x.note || (count === null ? "" : board === "sales" ? `${count} sold` : `${count} ${count === 1 ? "job" : "jobs"} done`)).slice(0, 80),
      };
    }),
  };
}

// ------------------------------------------------------------ the person's cards

// Flyra's Home (Nov 13, "make it look more like Flyra"): the money, then
// the Leaderboard, Today, Inbox, Tasks and Goals. The clock sits under the
// money and is on by default only for someone who clocks in for field work
// (is_technician; `clock: true`), anyone else adds it in Edit Home.
export const CARDS = Object.freeze(["money", "clock", "leaderboard", "agenda", "inbox", "tasks", "goals"]);
export const DEFAULT_ON = Object.freeze(["money", "leaderboard", "agenda", "inbox", "tasks", "goals"]);
// The saved order first (cards no longer open to this person dropped),
// then any card they may have that the saved list doesn't name (on when
// it is one of the defaults). → [{ key, on }]
export function layoutOf(saved, available, { clock = false } = {}) {
  const can = new Set(available);
  const out = [];
  const seen = new Set();
  for (const c of list(saved && saved.cards)) {
    if (!c || !can.has(c.key) || seen.has(c.key)) continue;
    seen.add(c.key);
    out.push({ key: c.key, on: c.on !== false });
  }
  for (const k of CARDS) if (can.has(k) && !seen.has(k)) out.push({ key: k, on: k === "clock" ? !!clock : DEFAULT_ON.includes(k) });
  return out;
}
// A layout as sent by Edit Home. → { cards: [{ key, on }] }
export function validateLayout(v) {
  if (!v || typeof v !== "object" || !Array.isArray(v.cards)) throw new InputError("Send the cards in their order.", "cards");
  const seen = new Set();
  const cards = [];
  for (const c of v.cards.slice(0, CARDS.length)) {
    if (!c || !CARDS.includes(c.key)) throw new InputError("That isn't a Home card.", "cards");
    if (seen.has(c.key)) continue;
    seen.add(c.key);
    cards.push({ key: c.key, on: c.on !== false });
  }
  return { cards };
}

// ------------------------------------------------------------ goals

// The owners' monthly goals (settings document "goals"): revenue in cents
// and jobs completed, each optional.
export const GOALS_DEFAULTS = Object.freeze({ revenue_month_cents: null, jobs_month: null });
export function validateGoals(v) {
  const out = {};
  const one = (k, max) => {
    const x = v[k];
    if (x === null || x === undefined || x === "") { out[k] = null; return; }
    if (!Number.isInteger(x) || x < 1 || x > max) throw new InputError(k === "jobs_month" ? "Jobs: a whole number from 1." : "Revenue: a whole dollar amount from $1.", k);
    out[k] = x;
  };
  one("revenue_month_cents", 100000000000);
  one("jobs_month", 100000);
  return out;
}
// Jobs completed in a month (the CRM's jobs index, this year's closed shard).
export function jobsDoneIn(rows, monthKey) {
  return list(rows).filter((r) => r && r.st === "completed" && r.bill !== false && r.done && localOf(r.done).slice(0, 7) === monthKey).length;
}
