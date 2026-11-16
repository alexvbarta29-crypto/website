// Home's pure parts (the owner's Nov 12 choice: Rotor's phone Home and the
// best of Flyra's, as cards each person shows, hides and orders). No I/O,
// no clock: callers pass today (a local YYYY-MM-DD) and the rows they read.
//
//   periodOf(period, today, { from, to })   This week · This month · Last 3 months · 12 months · This year · Custom
//   rotorCollected(snap, p, today)          Rotor's sealed snapshot: totals and its weeks or months
//   crmCollected(rows, p, today)            the CRM's payments, per day (after cutover)
//   scheduledDays(visits, jobs, p)          the value of the visits booked, per day
//   arrDays(plans, p, today)                annual recurring revenue of the live plans, per day
//   arrView(plans, p, today)                → the money card's ARR view (Nov 14): ARR, its change, active plans, MRR, the line (older clients)
//   arrMonths(plans, from, to, today)       ARR (and MRR, ARR / 12) at each month's end, the plans added and lost in it
//   arrMonthView(plans, range, today)       → the top's ARR view by month (Nov 15): 6M 1Y YTD All
//   arrForward(plans, from, months, today)  ARR projected at each month's end ahead, the plans renewing, ending and starting
//   arrForwardView(plans, today)            → the top's ARR view ahead (Nov 16, the default): the next 12 months
//   moneyCard({ metric, p, series, ... })   → one metric over a period (the older Collected | Scheduled | ARR card)
//   latestImport(runs, today)               the newest finished Rotor import and whether it is fresh (3 days)
//   moneyPair({ p, collected, scheduled })  → Rotor's Money card: Collected and Scheduled side by side, one chart (older clients)
//   revenueView({ p, collected, ... })      → the top of Home's Revenue view (Nov 15, Flyra's): Collected, its daily average and peak, the line
//   clockToday(rows, uid, today, nowMs)     the Timesheet card: today's minutes, the open shift
//   agendaOf(visits, users, p)              the Agenda's rows (Daily · Weekly · Monthly)
//   tasksOf(rows, user, { all })            open tasks (the Agenda's "without due date", the Tasks card)
//   layoutOf(saved, available)              the person's cards, in their order
//   validateGoals(v)                        the owners' monthly goals (settings document "goals")
//
// Money says where it comes from. Collected: the CRM's own payments index
// (counted as GET /money/summary counts revenue) after cutover, and before
// it too while the latest finished Rotor import is 3 days old or less (the
// import brings Rotor's payments in, so the CRM has them per day);
// otherwise Rotor's sealed snapshot (no per-day numbers there: its weeks,
// or its months for a year, carry the chart). Scheduled and ARR are the
// CRM's own visits and plans. Nothing invents a zero: a number nobody has
// is null (the screen shows "-").

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

export const PERIODS = Object.freeze(["week", "month", "3m", "1y", "year", "custom"]);
export const MAX_CUSTOM_DAYS = 366;

// → { period, from, to, label }
export function periodOf(period, today, { from, to } = {}) {
  const month = today.slice(0, 7);
  if (period === "week") { const f = weekStart(today); return { period, from: f, to: addLocalDays(f, 6), label: spanLabel(f, addLocalDays(f, 6)) }; }
  if (period === "3m") { const f = `${addMonths(month, -2)}-01`; return { period, from: f, to: monthEnd(month), label: `${MONTHS_LONG[Number(f.slice(5, 7)) - 1]} – ${MONTHS_LONG[Number(month.slice(5, 7)) - 1]}` }; }
  // 12 months: this month and the 11 before it
  if (period === "1y") { const f = `${addMonths(month, -11)}-01`; return { period, from: f, to: monthEnd(month), label: `${monthLabel(f)} ${f.slice(0, 4)} – ${monthLabel(month)} ${month.slice(0, 4)}` }; }
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
  } else if (p.period === "month" || p.period === "3m" || p.period === "year" || p.period === "1y") {
    const keys = monthsOf(p.from, p.to);
    total = sumMonths(keys);
    if (p.period === "year" || p.period === "1y") {
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

// Annual recurring revenue of a live plan (the owner's Nov 14 check
// against Rotor): one year of its visit prices, the index row's `ay`. In a
// first term that is Rotor's sale value (per-visit prices × visits a year,
// a first-visit discount included; a 3-year lights term counts one
// season), after a renewal the regular prices. A row from before Nov 14 has
// no `ay` until the nightly list check or the next import rebuilds it: its
// term's sale value scaled to a year (a first term is 12 months; a renewal
// term the catalog's renews_every_months).
const RENEW_MONTHS = { biannual: 6, quarterly: 3, monthly: 1, lights_annual: 12, custom: 6 };
const LIVE_PLAN = new Set(["active", "cancelling", "paused"]);
export function planArr(r) {
  if (num(r.ay) !== null) return Math.max(0, Math.round(num(r.ay)));
  const sv = num(r.sv) || 0;
  if (sv <= 0) return 0;
  const start = localOf(r.at), end = r.te || null;
  const firstTerm = !end || !start || daysBetween(start, end) <= 380;
  const months = firstTerm ? 12 : RENEW_MONTHS[r.ck] || (r.k === "lights_annual" ? 12 : 6);
  return Math.round((sv * 12) / months);
}
// Revenue that recurs on day d: a plan that renews, or one that doesn't
// until its term ends. Never a hidden one-time series, nor a lights plan
// sold for one season without renewing (a one-time install, like Rotor's
// One-Time lights: it expires after its season).
export function recursOn(r, d) {
  if (r.k === "one_time_series") return false;
  if (r.ar !== 0) return true;
  if (r.k === "lights_annual" && (num(r.tm) || 12) <= 12) return false;
  return !(r.te && r.te < d);
}
const localOf = (iso) => { const t = Date.parse(iso || ""); return Number.isFinite(t) ? localDate(new Date(t)) : ""; };
// A plan counts from the day it was made (if it's live or ended later)
// to the day its cancellation takes effect.
// → { cents, plans } on day d (plans: how many count)
export function arrAt(plans, d) {
  let n = 0, count = 0;
  for (const r of list(plans)) {
    if (!r) continue;
    const start = localOf(r.at);
    if (!start || start > d || !recursOn(r, d)) continue;
    const live = LIVE_PLAN.has(r.st);
    const endedAfter = !live && r.eff && r.eff > d;
    if (live ? !(r.eff && r.eff <= d) : endedAfter) { n += planArr(r); count += 1; }
  }
  return { cents: n, plans: count };
}
export const arrOn = (plans, d) => arrAt(plans, d).cents;
// → { total (the period's last day, or today), change (over the period), grain: "day", points } | null without any plan
export function arrDays(plans, p, today) {
  if (!list(plans).length) return null;
  const end = today < p.to ? today : p.to;
  if (end < p.from) return { total: arrOn(plans, p.from), change: 0, grain: null, points: [], through: p.from };
  const points = dates(p.from, p.to).map((d) => ({ key: d, label: dayLabel(d), from: d, to: d, value: d > end ? null : arrOn(plans, d) }));
  const total = arrOn(plans, end);
  return { total, change: total - arrOn(plans, addLocalDays(p.from, -1)), grain: "day", points, through: end };
}

// The money card's ARR view (the owner's Nov 14 ask, Flyra's ARR switch):
// ARR on the period's last day (or today), its change since the day before
// the period ($ and %), the plans counted, MRR (ARR ÷ 12) and the line per
// day. No plan at all: total null (the screen shows "-").
// → { period, from, to, label, total, change, pct, plans, mrr, grain, points, through }
export function arrView(plans, p, today) {
  const base = { period: p.period, from: p.from, to: p.to, label: p.label };
  const s = arrDays(plans, p, today);
  if (!s) return { ...base, total: null, change: null, pct: null, plans: 0, mrr: null, grain: null, points: [], through: today < p.to ? today : p.to };
  const end = s.through;
  const before = s.total - s.change;
  return {
    ...base, total: s.total, change: s.change, pct: before > 0 ? Math.round((s.change / before) * 1000) / 10 : null,
    plans: arrAt(plans, end).plans, mrr: Math.round(s.total / 12), grain: s.grain, points: s.points, through: end,
  };
}
// The ARR view's older ranges (per day): Flyra's 1W 1M 3M 1Y, and YTD.
export const ARR_RANGES = Object.freeze({ "1w": "week", "1m": "month", "3m": "3m", "1y": "1y", ytd: "year" });

// ------------------------------------------------------------ ARR by month (Nov 15)

// The days a plan counts toward ARR, as arrAt counts them: from the day it
// was made to the day before its cancellation takes effect (or, for one
// that doesn't renew, the day after its term ends). → { start, stop } (it
// counts on start <= d < stop; stop null: still counting) | null (never)
export function planWindow(r) {
  if (!r) return null;
  const start = localOf(r.at);
  if (!start || r.k === "one_time_series") return null;
  if (r.ar === 0 && r.k === "lights_annual" && (num(r.tm) || 12) <= 12) return null;
  let stop = r.eff || null;
  if (!LIVE_PLAN.has(r.st) && !stop) return null;
  if (r.ar === 0 && isLocalDate(r.te)) { const after = addLocalDays(r.te, 1); if (!stop || after < stop) stop = after; }
  return stop && stop <= start ? null : { start, stop };
}
// The owner's Nov 15 ask ("ARR by month on the home page"): ARR at the end
// of each month from fromMonth to toMonth (the current month: today; a
// month still ahead: null), with the plans that started counting in it and
// those that stopped (a plan made and cancelled in the same month is both).
// Month ends are local days (America/Chicago): a plan made at 11:30 PM on
// Oct 31 is October's, whatever the UTC date. Each month's MRR is its ARR / 12
// (Nov 15, "ARR with showing the MRR in all 12 months": a label on each bar).
// → [{ key, label, from, to, value, mrr, plans, added, lost, added_cents, lost_cents }]
export const MAX_ARR_MONTHS = 120;
export function arrMonths(plans, fromMonth, toMonth, today) {
  const rows = list(plans).filter(Boolean);
  const windows = rows.map((r) => [r, planWindow(r)]).filter(([, w]) => w);
  const out = [];
  for (let m = fromMonth; m <= toMonth && out.length < MAX_ARR_MONTHS; m = addMonths(m, 1)) {
    const from = `${m}-01`;
    if (from > today) { out.push({ key: m, label: monthLabel(m), from, to: monthEnd(m), value: null, mrr: null, plans: null, added: null, lost: null, added_cents: null, lost_cents: null }); continue; }
    const to = monthEnd(m) > today ? today : monthEnd(m);
    const prev = addLocalDays(from, -1);
    let added = 0, lost = 0, addedCents = 0, lostCents = 0;
    for (const [r, w] of windows) {
      if (w.start > prev && w.start <= to) { added += 1; addedCents += planArr(r); }
      if (w.stop && w.stop > prev && w.stop <= to) { lost += 1; lostCents += planArr(r); }
    }
    const at = arrAt(rows, to);
    out.push({ key: m, label: monthLabel(m), from, to, value: at.cents, mrr: Math.round(at.cents / 12), plans: at.plans, added, lost, added_cents: addedCents, lost_cents: lostCents });
  }
  return out;
}
// The ARR view's ranges by month: the last 6 months, 12 months (the
// default), this year, and All (since the first plan's month).
export const ARR_MONTH_RANGES = Object.freeze({ next12: "The next 12 months", "6m": "The last 6 months", "1y": "The last 12 months", ytd: "This year", all: "Since the first plan" });
// "Jun – Nov 2026", "Dec 2025 – Nov 2026", "November 2026"
const monthSpan = (a, b) => (a === b ? `${MONTHS_LONG[Number(a.slice(5, 7)) - 1]} ${a.slice(0, 4)}` : a.slice(0, 4) === b.slice(0, 4) ? `${monthLabel(a)} – ${monthLabel(b)} ${b.slice(0, 4)}` : `${monthLabel(a)} ${a.slice(0, 4)} – ${monthLabel(b)} ${b.slice(0, 4)}`);
// The top's ARR view by month: ARR today (the big number), its change since
// the period began (the end of the month before its first) in $ and %,
// this month's change (since the end of last month), the plans counted,
// MRR, and a point per month. No plan at all: total null (the screen shows "-").
// → { period: "months", range, from, to, label, total, change, pct, month_change, plans, mrr, grain: "month", points, through }
export function arrMonthView(plans, range, today) {
  const toMonth = today.slice(0, 7);
  let fromMonth = range === "6m" ? addMonths(toMonth, -5) : range === "ytd" ? `${toMonth.slice(0, 4)}-01` : addMonths(toMonth, -11);
  if (range === "all") {
    const first = list(plans).map(planWindow).filter(Boolean).reduce((a, w) => (!a || w.start < a ? w.start : a), "");
    fromMonth = first && first.slice(0, 7) < toMonth ? first.slice(0, 7) : toMonth;
  }
  if (fromMonth < addMonths(toMonth, -(MAX_ARR_MONTHS - 1))) fromMonth = addMonths(toMonth, -(MAX_ARR_MONTHS - 1));
  const base = { period: "months", range, from: `${fromMonth}-01`, to: today, label: monthSpan(fromMonth, toMonth), grain: "month", through: today };
  if (!list(plans).length) return { ...base, total: null, change: null, pct: null, month_change: null, plans: 0, mrr: null, grain: null, points: [] };
  const points = arrMonths(plans, fromMonth, toMonth, today);
  const now = arrAt(plans, today);
  const before = arrOn(plans, addLocalDays(`${fromMonth}-01`, -1));
  const lastMonth = arrOn(plans, addLocalDays(`${toMonth}-01`, -1));
  const change = now.cents - before;
  return {
    ...base, total: now.cents, change, pct: before > 0 ? Math.round((change / before) * 1000) / 10 : null,
    month_change: now.cents - lastMonth, plans: now.plans, mrr: Math.round(now.cents / 12), points,
  };
}

// ------------------------------------------------------------ ARR ahead by month (Nov 16)

// One plan's ARR from today on, as today's plans stand (no new sales, no
// cancellations nobody has asked for yet). Only what counts today, or is
// signed and starts later: a pending (unsigned) or draft plan, a hidden
// one-time series and a one-season lights plan never count, as for ARR on
// a day. A signed plan whose first term starts after today (`so`, a 2027
// start) counts from that day. A term that ends ahead: a plan that renews
// goes on at a year of its regular visits (`ry`, else `ay`), one that
// doesn't renew stops the day after. A cancellation that takes effect
// ahead stops it that day.
// → { start, stop, renew, before, after } (it counts on start <= d < stop;
// stop null: still counting; on and after renew it is worth `after`) | null
export function planAhead(r, today) {
  if (!r || r.k === "one_time_series") return null;
  let start = localOf(r.at);
  if (!start || !recursOn(r, today)) return null;
  const live = LIVE_PLAN.has(r.st);
  // counted today (as arrAt counts), or ended for good
  if (live ? r.eff && r.eff <= today : !(r.eff && r.eff > today)) return null;
  if (start > today) return null;
  if (isLocalDate(r.so) && r.so > today && r.so > start) start = r.so;
  const before = planArr(r);
  let stop = isLocalDate(r.eff) ? r.eff : null, renew = null, after = before;
  if (isLocalDate(r.te) && r.te >= today) {
    const next = addLocalDays(r.te, 1);
    if (r.ar === 0) { if (!stop || next < stop) stop = next; }
    else { renew = next; after = num(r.ry) !== null ? Math.max(0, Math.round(num(r.ry))) : before; }
  }
  if (stop && stop <= start) return null;
  if (renew && stop && renew >= stop) renew = null;
  return { start, stop, renew, before, after: renew ? after : before };
}
const aheadOn = (w, d) => (w.start <= d && (!w.stop || d < w.stop) ? (w.renew && d >= w.renew ? w.after : w.before) : null);
// The owner's Nov 16 ask ("the ARR for next year per month"): ARR projected
// at the end of each of `months` months from fromMonth, from today's plans
// (planAhead), each month's MRR (ARR / 12), and the plans that renew, end
// and start in it (renewing_cents: what the renewals change; ending_cents:
// the ARR that stops; starting_cents: the ARR that starts). Month ends are
// local days (America/Chicago).
// → [{ key, label, from, to, value, mrr, plans, renewing, renewing_cents, ending, ending_cents, starting, starting_cents }]
export function arrForward(plans, fromMonth, months, today) {
  const ws = list(plans).map((r) => planAhead(r, today)).filter(Boolean);
  const out = [];
  const n = Math.max(0, Math.min(MAX_ARR_MONTHS, Math.floor(Number(months) || 0)));
  for (let i = 0, m = fromMonth; i < n; i++, m = addMonths(m, 1)) {
    const from = `${m}-01`, to = monthEnd(m);
    let value = 0, count = 0, renewing = 0, renewingCents = 0, ending = 0, endingCents = 0, starting = 0, startingCents = 0;
    for (const w of ws) {
      const v = aheadOn(w, to);
      if (v !== null) { value += v; count += 1; }
      if (w.renew && w.renew > from && w.renew <= addLocalDays(to, 1) && w.renew > today) { renewing += 1; renewingCents += w.after - w.before; }
      if (w.stop && w.stop >= from && w.stop <= to && w.stop > today) { ending += 1; endingCents += aheadOn(w, addLocalDays(w.stop, -1)) || 0; }
      if (w.start > today && w.start >= from && w.start <= to) { starting += 1; startingCents += aheadOn(w, w.start) || 0; }
    }
    out.push({ key: m, label: monthLabel(m), from, to, value, mrr: Math.round(value / 12), plans: count, renewing, renewing_cents: renewingCents, ending, ending_cents: endingCents, starting, starting_cents: startingCents });
  }
  return out;
}
// The top's ARR view ahead (Nov 16, the default ARR period): ARR today (the
// big number, as every ARR view has it), the plans counted and MRR; ARR at
// the end of this month and the 11 after it; where it ends up ("In 12
// months": the last month's end) and the change to it ($ and %). No plan at
// all: total null (the screen shows "-").
// → { period: "months", range: "next12", ahead: true, from, to, label, total, end, change, pct, plans, mrr, grain: "month", points, through }
export const ARR_AHEAD_MONTHS = 12;
export function arrForwardView(plans, today, months = ARR_AHEAD_MONTHS) {
  const fromMonth = today.slice(0, 7), toMonth = addMonths(fromMonth, months - 1);
  const base = { period: "months", range: "next12", ahead: true, from: today, to: monthEnd(toMonth), label: monthSpan(fromMonth, toMonth), grain: "month", through: today };
  if (!list(plans).length) return { ...base, total: null, end: null, change: null, pct: null, plans: 0, mrr: null, grain: null, points: [] };
  const points = arrForward(plans, fromMonth, months, today);
  const now = arrAt(plans, today);
  const end = points.length ? points[points.length - 1].value : now.cents;
  const change = end - now.cents;
  return { ...base, total: now.cents, end, change, pct: now.cents > 0 ? Math.round((change / now.cents) * 1000) / 10 : null, plans: now.plans, mrr: Math.round(now.cents / 12), points };
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

// ------------------------------------------------------------ Rotor's Money card (Nov 13)

// Rotor's own Home: Week | Month with arrows, Collected and Scheduled side
// by side, one chart with both lines per day. Collected per day needs the
// CRM's payments: after cutover, or while the latest finished Rotor import
// (it brings Rotor's payments in) is IMPORT_FRESH_DAYS old or less.
export const IMPORT_FRESH_DAYS = 3;
export const PAIR_PERIODS = Object.freeze(["week", "month"]);
// import-runs index rows (st, asof = the export's day, fin) → { date, age, fresh } | null
export function latestImport(rows, today) {
  let best = null;
  for (const r of list(rows)) {
    if (!r || r.st !== "done") continue;
    const d = isLocalDate(r.asof) ? r.asof : localOf(r.fin);
    if (isLocalDate(d) && (!best || d > best)) best = d;
  }
  if (!best) return null;
  const age = Math.max(0, daysBetween(best, today));
  return { date: best, age, fresh: age <= IMPORT_FRESH_DAYS };
}
// The week (Monday first) or the month that holds a day; a month says its year.
export function pairPeriod(kind, date) {
  const p = periodOf(kind === "week" ? "week" : "month", date);
  return p.period === "month" ? { ...p, label: `${p.label} ${p.from.slice(0, 4)}` } : p;
}
// Daily points summed into the period's weeks (a week that began before the
// period counts from its first day), for a chart whose Collected is weekly.
export function byWeek(points, p) {
  const m = new Map();
  for (const x of list(points)) {
    if (!x || x.value === null || x.value === undefined) continue;
    const w = weekStart(x.key);
    const k = w < p.from ? p.from : w;
    m.set(k, (m.get(k) || 0) + x.value);
  }
  return [...m].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, value]) => {
    const end = addLocalDays(weekStart(k), 6);
    return { key: k, label: dayLabel(k), from: k, to: end > p.to ? p.to : end, value };
  });
}
const pointOf = (x) => ({ key: x.key, label: x.label, from: x.from || x.key, to: x.to || x.key, value: x.value === undefined ? null : x.value });
// → { period, from, to, label, grain, collected: { total, points }, scheduled: { total, points }, arr, source, as_of, missing }
// grain "day": both lines per day; "week": Rotor's snapshot weeks, Scheduled summed to the same weeks so
// the two lines share one scale. A Collected with no days counted yet is null, not $0.
export function moneyPair({ p, collected, scheduled, source, asOf = null, arr = null, missing = null }) {
  const c = collected || { total: null, grain: null, points: [] };
  const s = scheduled || { total: null, points: [] };
  const weekly = c.grain === "week" && list(c.points).length > 1;
  const cPoints = c.grain === "day" || weekly ? list(c.points).map(pointOf) : [];
  let cTotal = num(c.total);
  if (c.grain === "day" && cPoints.every((x) => x.value === null)) cTotal = null;
  return {
    period: p.period, from: p.from, to: p.to, label: p.label, grain: weekly ? "week" : "day",
    collected: { total: cTotal, points: cPoints },
    scheduled: { total: num(s.total), points: (weekly ? byWeek(s.points, p) : list(s.points)).map(pointOf) },
    arr: num(arr), source, as_of: asOf, missing,
  };
}

// The top of Home's Revenue view (the owner's Nov 15 ask: "make the home
// page look like Flyra"): over 1W 1M 3M 1Y YTD, Collected (wherever
// collectedFor found it), its average a day and its best day (Rotor's
// snapshot has weeks or months, so its best week or month), and the line.
// A Collected with no day counted yet is null, never $0.
export const REVENUE_RANGES = Object.freeze({ "1w": "week", "1m": "month", "3m": "3m", "1y": "1y", ytd: "year" });
// → { period, range, from, to, label, source, as_of, missing, total, avg, peak, grain, points }
export function revenueView({ p, range = "1m", collected, source, asOf = null, missing = null }) {
  const c = collected && collected.grain === "day" && list(collected.points).every((x) => x.value === null) ? { ...collected, total: null } : collected;
  const card = moneyCard({ metric: "collected", p, series: c, source, asOf });
  if (card.total === null) { card.avg = null; card.peak = null; }
  const { metric, goal, change, ...rest } = card;
  return { ...rest, range, missing, points: card.points.map(pointOf) };
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
// how many visits a view sends: Monthly's calendar needs every day's (its dots and the picked day's list)
export const AGENDA_MAX = Object.freeze({ day: 120, week: 120, month: 600 });
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

// ------------------------------------------------------------ tasks

const TASK_ORDER = { in_progress: 0, open: 1, waiting: 2 };
// Open tasks: an owner's whole team's, anyone else's own. → [{ id, title, status, due, contact }]
export function tasksOf(rows, user, { all = false, max = 60 } = {}) {
  return list(rows).filter((r) => r && (all || (r.a || []).includes(user.id)))
    .sort((a, b) => (a.due ? 0 : 1) - (b.due ? 0 : 1) || String(a.due || "").localeCompare(String(b.due || "")) || (TASK_ORDER[a.st] ?? 3) - (TASK_ORDER[b.st] ?? 3) || String(b.u || "").localeCompare(String(a.u || "")))
    .slice(0, max).map((r) => ({ id: r.id, title: r.t || "Task", status: r.st, due: r.due || null, contact: r.cn || "" }));
}

// ------------------------------------------------------------ the person's cards

// Flyra's Home (Nov 13, "make it look more like Flyra"; Nov 15 "make the
// home page look like Flyra"): the money at the top (Revenue | ARR), then
// Today, Tasks and Goals. The Leaderboard and Inbox cards left Home on Nov
// 16 (the owner: "I don't need to see the leaderboard ... I also don't
// need my inbox on the home page"): the Leaderboard is the Menu's, the
// Inbox the bar's, and a saved layout naming them just drops them
// (RETIRED). The clock is on by default only for someone who clocks in
// for field work (is_technician; `clock: true`), anyone else adds it in
// Edit Home.
export const CARDS = Object.freeze(["money", "clock", "agenda", "tasks", "goals"]);
export const DEFAULT_ON = Object.freeze(["money", "agenda", "tasks", "goals"]);
export const RETIRED_CARDS = Object.freeze(["leaderboard", "inbox"]);
// The saved order first (cards no longer open to this person dropped),
// then any card they may have that the saved list doesn't name (on when
// it is one of the defaults), each after the card it follows in CARDS.
// → [{ key, on }]
export function layoutOf(saved, available, { clock = false } = {}) {
  const can = new Set(available);
  const out = [];
  const seen = new Set();
  for (const c of list(saved && saved.cards)) {
    if (!c || !can.has(c.key) || seen.has(c.key)) continue;
    seen.add(c.key);
    out.push({ key: c.key, on: c.on !== false });
  }
  for (const [i, k] of CARDS.entries()) {
    if (!can.has(k) || seen.has(k)) continue;
    const card = { key: k, on: k === "clock" ? !!clock : DEFAULT_ON.includes(k) };
    seen.add(k);
    const before = CARDS.slice(0, i).reverse().find((b) => out.some((c) => c.key === b));
    const at = before ? out.findIndex((c) => c.key === before) + 1 : 0;
    out.splice(at, 0, card);
  }
  return out;
}
// A layout as sent by Edit Home. → { cards: [{ key, on }] }
export function validateLayout(v) {
  if (!v || typeof v !== "object" || !Array.isArray(v.cards)) throw new InputError("Send the cards in their order.", "cards");
  const seen = new Set();
  const cards = [];
  for (const c of v.cards.slice(0, CARDS.length + RETIRED_CARDS.length)) {
    // (an older phone's Edit Home still sends the cards Home no longer has: they drop)
    if (c && RETIRED_CARDS.includes(c.key)) continue;
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
