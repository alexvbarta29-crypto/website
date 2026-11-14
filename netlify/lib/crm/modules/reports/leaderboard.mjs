// Reports module: the leaderboard and "My performance" (the Nov 2026
// layout, after Rotor's Leaderboard and Flyra's My performance pages). One
// service, `reports.leaderboard`, that the Leaderboard screen, My
// performance and any module (has()/call()) use (Home dropped its card on
// Nov 14):
//
//   reports.leaderboard({ metric, from, to }) → { metric, from, to, people: [person], unassigned, rows: [row] }
//     metric  sales | revenue | avg | agreements | autopay | techs
//     person  { id, name, first_name, initials, color, sales, sold_cents, avg_cents, plans, signed,
//               signed_pct, agreements, autopay, arr_cents, jobs, visits, done_cents, value, rank,
//               plans_sold, jobs_sold }
//   or asked by board (Home's old card) and the same answer comes back:
//     ({ board: "sales" | "techs", period: "today" | "week" | "month" | "year", month: "yyyy-mm", from, to })
//     board sales = the sold money (recurring plans' ARR, jobs' first visits), techs = jobs done $;
//     from/to win, then month (that calendar month, up to today), then period (default this month)
//     row     { user_id, name, first_name, initials, color, count, value_cents, arr_cents, note, rank }
//             the people with something to show, best first ("2 plans sold, 1 job sold", "5 jobs done")
//
// Where the numbers come from (indexes only, each read once; imported Rotor
// records count the same as the CRM's own). The owner's Nov 14 check: the
// board once dated a sale by the quote's last change (every Rotor import
// touches every quote, so November held all-time sales) and called the sold
// money, first visits included, ARR. Now:
//   sold day  a quote's sale (approved_at, else converted_at: the index's
//             `sd`); a plan's its creation (an imported plan keeps Rotor's)
//   jobs sold quotes approved or turned into work in the period whose chosen
//             option is not a plan (the index's `pk`), worth the first visit;
//             a plan sold for one season that doesn't renew (Rotor's
//             One-Time lights) counts as a job too, worth its sale value
//   plans sold the recurring plans (Home's recursOn) made in the period and
//             not cancelled or expired, credited to the plan's seller
//             (sold_by, the index's `sb`; an imported plan's matched Rotor
//             rep), else the seller of that customer's latest sold quote;
//             ARR = the same per-plan year Home's ARR counts (planArr: the
//             index's `ay`, a 3-year lights term one season a year)
//   sold      jobs sold + plans sold, worth first visits + ARR
//   techs     jobs finished in the period (jobs index, the year's shard),
//             their total split between the people on them, and visits done
//             (visits index, the months' shards)
// A plan quote counts once, as its plan (the plans index), never also as a
// quote. No record is read, only indexes: about 6 to 10 storage calls
// whatever the period (a year of visits is 12 month shards, read only for
// "techs").

import { readIndex } from "../../../crm-store.mjs";
import { now, localDate, addLocalDays, dowOfDate } from "../../core/clock.mjs";
import { InputError } from "../../core/errors.mjs";
import { planArr, recursOn } from "../system/home-kpis.mjs";

export const METRICS = Object.freeze(["sales", "revenue", "avg", "agreements", "autopay", "techs"]);
export const PERIODS = Object.freeze(["today", "week", "month", "year"]);
const SOLD = ["approved", "converted"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// A named period → { from, to } (local dates; the week starts on Monday).
export function periodRange(period = "month", today = localDate(now())) {
  if (period === "today") return { from: today, to: today };
  if (period === "week") return { from: addLocalDays(today, -((dowOfDate(today) + 6) % 7)), to: today };
  if (period === "year") return { from: `${today.slice(0, 4)}-01-01`, to: today };
  return { from: `${today.slice(0, 7)}-01`, to: today };
}

const initials = (s) => String(s || "").trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";
const dayOf = (iso) => (typeof iso === "string" && iso ? localDate(new Date(iso)) : null);
const inRange = (d, from, to) => !!d && d >= from && d <= to;
const months = (from, to) => {
  const out = [];
  let m = from.slice(0, 7);
  while (m <= to.slice(0, 7) && out.length < 25) {
    out.push(m);
    const [y, mm] = m.split("-").map(Number);
    m = mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, "0")}`;
  }
  return out;
};
const years = (from, to) => [...new Set([from.slice(0, 4), to.slice(0, 4)])];
const rows = async (name, shard) => { try { return (await readIndex(name, shard)).rows || []; } catch { return []; } };

// The day a quote was sold. A row from before Nov 14 has no `sd` until the
// nightly list check rebuilds it: an imported quote's last change is the
// import itself, so its creation (Rotor's); the CRM's own its last change.
export function soldOn(q) {
  if (q.sd) return dayOf(q.sd);
  return dayOf(q.sd === undefined && !q.im ? q.u || q.at : q.at);
}
// The chosen option is a plan (counted as its plan, from the plans index).
export const isPlanQuote = (q) => (q.pk !== undefined ? q.pk === 1 : Number.isSafeInteger(q.annual) || (Array.isArray(q.k) && q.k.length > 0 && q.k.every((x) => x === "plan")));
// A job quote's value: the first visit.
export const jobValue = (q) => (Number.isSafeInteger(q.first) && q.first > 0 ? q.first : 0);
// A plan made (sold) and still standing: → { day, recurring, arr, value } | null
const PLAN_SOLD = new Set(["pending", "active", "cancelling", "paused"]);
export function planSale(pl) {
  const day = dayOf(pl.at);
  if (!day || !PLAN_SOLD.has(pl.st)) return null;
  const recurring = recursOn(pl, day);
  const arr = recurring ? planArr(pl) : 0;
  return { day, recurring, arr, value: recurring ? arr : Math.max(0, Math.round(Number(pl.sv) || 0)) };
}

// The sold quotes in the range (and every sold quote, for crediting plans by customer).
async function soldQuotes(from, to) {
  const shards = ["open", ...years(from, to)];
  const all = (await Promise.all(shards.map((s) => rows("quotes", s)))).flat().filter((q) => SOLD.includes(q.st));
  const seen = new Set();
  const uniq = all.filter((q) => (seen.has(q.id) ? false : seen.add(q.id)));
  return { inRange: uniq.filter((q) => inRange(soldOn(q), from, to)), all: uniq };
}
// Who sold a plan: its own seller, else the seller of that customer's latest sold quote.
function planSeller(all, who) {
  const byCustomer = new Map();
  for (const q of [...all].sort((a, b) => String(soldOn(a) || "").localeCompare(String(soldOn(b) || "")))) if (q.c) byCustomer.set(q.c, who(q.by));
  return (pl) => who(pl.sb) || byCustomer.get(pl.c) || null;
}

// The people who can be on the board, and who a sold_by names.
async function people() {
  const us = (await rows("users", "")).filter((u) => u.status !== "disabled");
  const byName = new Map();
  for (const u of us) for (const n of [u.name, u.first_name, u.login]) if (n) byName.set(String(n).trim().toLowerCase(), u.id);
  const who = (by) => {
    if (!by) return null;
    if (us.some((u) => u.id === by)) return by;
    const k = String(by).trim().toLowerCase();
    return byName.get(k) || byName.get(k.split(/\s+/)[0]) || null;
  };
  return { us, who };
}

// Home's card names a board, a period or a month; the screens name a metric and dates.
const BOARD = { sales: "revenue", techs: "techs" };
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const nextMonth = (m) => { const [y, mm] = m.split("-").map(Number); return mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, "0")}`; };
export function boardInput(input = {}, today = localDate(now())) {
  const metric = input.metric || (input.board ? BOARD[input.board] : null) || "revenue";
  if (input.board && !BOARD[input.board] && !input.metric) throw new InputError("Pick the sales or the techs board.", "board");
  if (input.from && input.to) return { metric, from: input.from, to: input.to };
  if (input.month) {
    if (!MONTH.test(input.month)) throw new InputError("Pick a month.", "month");
    const from = `${input.month}-01`, last = addLocalDays(`${nextMonth(input.month)}-01`, -1);
    const to = last < today ? last : today;   // this month: up to today
    return { metric, from, to: to < from ? from : to };
  }
  if (input.period && !PERIODS.includes(input.period)) throw new InputError("Pick today, this week, this month or this year.", "period");
  return { metric, ...periodRange(input.period || "month", today) };
}
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
// The short line under a name on Home's card.
function noteOf(p, metric) {
  if (metric === "techs") return [p.jobs ? `${plural(p.jobs, "job", "jobs")} done` : "", p.visits && !p.jobs ? `${plural(p.visits, "visit", "visits")} done` : ""].filter(Boolean).join(", ");
  return [p.plans_sold ? `${plural(p.plans_sold, "plan", "plans")} sold` : "", p.jobs_sold ? `${plural(p.jobs_sold, "job", "jobs")} sold` : ""].filter(Boolean).join(", ");
}
const rowOf = (p, metric) => ({
  user_id: p.id, name: p.name, first_name: p.first_name, initials: p.initials, color: p.color,
  count: metric === "techs" ? p.jobs : p.sales, value_cents: metric === "techs" ? p.done_cents : p.sold_cents,
  arr_cents: p.arr_cents, note: noteOf(p, metric), rank: p.rank,
});

const blank = (u) => ({
  id: u ? u.id : null, name: u ? u.name || u.login : "Unassigned", first_name: u ? u.first_name || String(u.name || "").split(/\s+/)[0] : "Unassigned",
  initials: u ? initials(u.name || u.login) : "?", color: u ? u.color || null : null, role: u ? u.role : null,
  sales: 0, sold_cents: 0, plans_sold: 0, jobs_sold: 0, avg_cents: 0, plans: 0, signed: 0, signed_pct: null, agreements: 0, autopay: 0, arr_cents: 0, jobs: 0, visits: 0, done_cents: 0,
});

const VALUE = {
  sales: (p) => p.sales, revenue: (p) => p.sold_cents, avg: (p) => p.avg_cents, agreements: (p) => p.agreements, autopay: (p) => p.autopay, techs: (p) => p.done_cents,
};

export async function leaderboard(input = {}) {
  const { metric, ...r } = boardInput(input);
  if (!METRICS.includes(metric)) throw new InputError("Pick one of the board's measures.", "metric");
  if (!DATE.test(r.from) || !DATE.test(r.to) || r.to < r.from) throw new InputError("Pick a period.", "from");
  const { us, who } = await people();
  const board = new Map(us.filter((u) => u.role !== "tech" || metric === "techs" || u.is_technician).map((u) => [u.id, blank(u)]));
  const none = blank(null);
  const get = (id) => (id && board.has(id) ? board.get(id) : id && us.find((u) => u.id === id) ? (board.set(id, blank(us.find((u) => u.id === id))), board.get(id)) : none);
  if (metric === "techs") {
    for (const u of us) if (u.is_technician || u.role === "tech") get(u.id);
    const [jobs, visits] = await Promise.all([
      Promise.all(years(r.from, r.to).map((y) => rows("jobs", y))).then((x) => x.flat()),
      Promise.all(months(r.from, r.to).map((m) => rows("visits", m))).then((x) => x.flat()),
    ]);
    for (const j of jobs) {
      if (j.st !== "completed" || !inRange(dayOf(j.done), r.from, r.to)) continue;
      const crew = (j.a || []).filter((id) => board.has(id) || us.some((u) => u.id === id));
      if (!crew.length) { none.jobs += 1; none.done_cents += j.tot || 0; continue; }
      const share = Math.round((j.tot || 0) / crew.length);
      for (const id of crew) { const p = get(id); p.jobs += 1; p.done_cents += share; }
    }
    for (const v of visits) if (v.st === "completed" && inRange(v.d, r.from, r.to)) for (const id of v.a || []) if (us.some((u) => u.id === id)) get(id).visits += 1;
  } else {
    const [{ inRange: sold, all }, plans] = await Promise.all([soldQuotes(r.from, r.to), rows("plans", "")]);
    for (const q of sold) {
      if (isPlanQuote(q)) continue;   // counted as its plan
      const p = get(who(q.by));
      p.sales += 1;
      p.jobs_sold += 1;
      p.sold_cents += jobValue(q);
    }
    const sellerOf = planSeller(all, who);
    for (const pl of plans) {
      const sale = planSale(pl);
      if (!sale || !inRange(sale.day, r.from, r.to)) continue;
      const p = get(sellerOf(pl));
      p.sales += 1;
      p.sold_cents += sale.value;
      if (sale.recurring) { p.plans_sold += 1; p.arr_cents += sale.arr; } else p.jobs_sold += 1;
      p.plans += 1;
      if (pl.ag === "signed") { p.signed += 1; p.agreements += 1; }
      if (pl.ap) p.autopay += 1;
    }
  }
  const list = [...board.values()];
  for (const p of [...list, none]) {
    p.avg_cents = p.sales ? Math.round(p.sold_cents / p.sales) : 0;
    p.signed_pct = p.plans ? Math.round((p.signed / p.plans) * 100) : null;
    p.value = VALUE[metric](p);
  }
  list.sort((a, b) => b.value - a.value || b.sales - a.sales || String(a.name).localeCompare(String(b.name)));
  list.forEach((p, i) => { p.rank = i + 1; });
  none.rank = list.length + 1;
  const shown = list.filter((p) => p.value > 0 || (metric === "techs" ? p.jobs || p.visits : p.sales));
  return { metric, from: r.from, to: r.to, people: list, unassigned: none, rows: shown.map((p) => rowOf(p, metric)) };
}

// My performance: what this person sold in the period, by day, and the streak.
export async function performance(userId, { period = "month", today = localDate(now()) } = {}) {
  if (!PERIODS.includes(period) || period === "today") throw new InputError("Pick this week, this month or this year.", "period");
  const r = periodRange(period, today);
  const { who } = await people();
  const [{ inRange: sold, all }, plans] = await Promise.all([soldQuotes(r.from, r.to), rows("plans", "")]);
  const byDay = new Map();
  let jobsC = 0, jobsN = 0, plansC = 0, plansN = 0, arr = 0, count = 0;
  for (const q of sold) {
    if (isPlanQuote(q) || who(q.by) !== userId) continue;
    const v = jobValue(q);
    const d = soldOn(q);
    byDay.set(d, (byDay.get(d) || 0) + v);
    jobsC += v; jobsN += 1; count += 1;
  }
  const sellerOf = planSeller(all, who);
  for (const pl of plans) {
    const sale = planSale(pl);
    if (!sale || !inRange(sale.day, r.from, r.to) || sellerOf(pl) !== userId) continue;
    byDay.set(sale.day, (byDay.get(sale.day) || 0) + sale.value);
    count += 1;
    if (sale.recurring) { plansC += sale.arr; plansN += 1; arr += sale.arr; } else { jobsC += sale.value; jobsN += 1; }
  }
  // the running total, day by day from the start to today
  const series = [];
  let run = 0;
  for (let d = r.from, i = 0; d <= r.to && i < 370; d = addLocalDays(d, 1), i++) { run += byDay.get(d) || 0; series.push({ d, cents: run }); }
  // the streak: days in a row with a sale up to today (yesterday counts while today has none yet)
  let streak = 0;
  for (let d = byDay.get(today) ? today : addLocalDays(today, -1), i = 0; byDay.get(d) && i < 400; d = addLocalDays(d, -1), i++) streak += 1;
  const monthStart = `${today.slice(0, 7)}-01`;
  const grid = [];
  for (let d = monthStart, i = 0; d <= today && i < 31; d = addLocalDays(d, 1), i++) grid.push({ d, sale: !!byDay.get(d) });
  const total = jobsC + plansC;
  return {
    period, from: r.from, to: r.to, sold_cents: total, count, series,
    jobs: { cents: jobsC, count: jobsN }, plans: { cents: plansC, count: plansN }, avg_cents: jobsN ? Math.round(jobsC / jobsN) : null, arr_cents: arr,
    streak: { days: streak, grid, with_sale: grid.filter((g) => g.sale).length },
  };
}

const R = (method, path, perm, handler, extra = {}) => ({ method, path, auth: "session", perm, subject: "none", mode: "inline", handler, ...extra });

export const leaderboardRoutes = [
  // the office and anyone who sells (a technician's "own" reports:read never opens a list)
  R("GET", "/leaderboard", "reports:read", async (ctx) => {
    const metric = ctx.query.get("metric") || "revenue";
    const period = ctx.query.get("period") || "month";
    if (!PERIODS.includes(period)) throw new InputError("Pick today, this week, this month or this year.", "period");
    return { data: { ...(await leaderboard({ metric, ...periodRange(period) })), period, me: ctx.user.id } };
  }),
  R("GET", "/me/performance", "account:own", async (ctx) => {
    const period = ctx.query.get("period") || "month";
    return { data: await performance(ctx.user.id, { period }) };
  }),
];
