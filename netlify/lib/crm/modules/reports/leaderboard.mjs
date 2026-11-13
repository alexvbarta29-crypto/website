// Reports module: the leaderboard and "My performance" (the Nov 2026
// layout, after Rotor's Leaderboard and Flyra's My performance pages). One
// service, `reports.leaderboard`, that the Leaderboard screen, My
// performance and Home's card (has()/call()) all use:
//
//   reports.leaderboard({ metric, from, to }) → { metric, from, to, people: [person], unassigned }
//     metric  sales | revenue | avg | agreements | autopay | techs
//     person  { id, name, first_name, initials, color, sales, sold_cents, avg_cents, plans, signed,
//               signed_pct, agreements, autopay, arr_cents, jobs, visits, done_cents, value, rank }
//
// Where the numbers come from (indexes only, each read once; imported Rotor
// records count the same as the CRM's own):
//   sold      a quote approved or turned into work (quotes index: the "open"
//             shard holds the approved, a year's shard the converted), on
//             the day it last changed, credited to its seller (sold_by: a
//             user id, or for an imported quote Rotor's rep name, matched to
//             a person by name; anyone else is "Unassigned"); its value is
//             the plan's yearly amount for a plan option, else the first visit
//   plans     plans set up in the period (plans index), credited to the
//             seller of that customer's sold quote; signed = its agreement
//             signed; autopay = on autopay; ARR = the plan's sale value
//   techs     jobs finished in the period (jobs index, the year's shard),
//             their total split between the people on them, and visits done
//             (visits index, the months' shards)
// No record is read, only indexes: about 6 to 10 storage calls whatever the
// period (a year of visits is 12 month shards, read only for "techs").

import { readIndex } from "../../../crm-store.mjs";
import { now, localDate, addLocalDays, dowOfDate } from "../../core/clock.mjs";
import { InputError } from "../../core/errors.mjs";

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

// A sold quote's value: the plan's yearly amount, else the first visit.
export const soldValue = (q) => (Number.isSafeInteger(q.annual) && q.annual > 0 ? q.annual : Number.isSafeInteger(q.first) ? q.first : 0);

// The sold quotes in the range (and every sold quote, for crediting plans by customer).
async function soldQuotes(from, to) {
  const shards = ["open", ...years(from, to)];
  const all = (await Promise.all(shards.map((s) => rows("quotes", s)))).flat().filter((q) => SOLD.includes(q.st));
  const seen = new Set();
  const uniq = all.filter((q) => (seen.has(q.id) ? false : seen.add(q.id)));
  return { inRange: uniq.filter((q) => inRange(dayOf(q.u || q.at), from, to)), all: uniq };
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

const blank = (u) => ({
  id: u ? u.id : null, name: u ? u.name || u.login : "Unassigned", first_name: u ? u.first_name || String(u.name || "").split(/\s+/)[0] : "Unassigned",
  initials: u ? initials(u.name || u.login) : "?", color: u ? u.color || null : null, role: u ? u.role : null,
  sales: 0, sold_cents: 0, avg_cents: 0, plans: 0, signed: 0, signed_pct: null, agreements: 0, autopay: 0, arr_cents: 0, jobs: 0, visits: 0, done_cents: 0,
});

const VALUE = {
  sales: (p) => p.sales, revenue: (p) => p.sold_cents, avg: (p) => p.avg_cents, agreements: (p) => p.agreements, autopay: (p) => p.autopay, techs: (p) => p.done_cents,
};

export async function leaderboard({ metric = "revenue", from, to } = {}) {
  if (!METRICS.includes(metric)) throw new InputError("Pick one of the board's measures.", "metric");
  const r = from && to ? { from, to } : periodRange("month");
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
      const p = get(who(q.by));
      p.sales += 1;
      p.sold_cents += soldValue(q);
    }
    // a plan is credited to the seller of that customer's latest sold quote
    const sellerOf = new Map();
    for (const q of [...all].sort((a, b) => String(a.u || "").localeCompare(String(b.u || "")))) if (q.c) sellerOf.set(q.c, who(q.by));
    for (const pl of plans) {
      if (!inRange(dayOf(pl.at), r.from, r.to) || pl.st === "cancelled") continue;
      const p = get(sellerOf.get(pl.c) || null);
      p.plans += 1;
      p.arr_cents += pl.sv || 0;
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
  return { metric, from: r.from, to: r.to, people: list, unassigned: none };
}

// My performance: what this person sold in the period, by day, and the streak.
export async function performance(userId, { period = "month", today = localDate(now()) } = {}) {
  if (!PERIODS.includes(period) || period === "today") throw new InputError("Pick this week, this month or this year.", "period");
  const r = periodRange(period, today);
  const { who } = await people();
  const [{ inRange: sold, all }, plans] = await Promise.all([soldQuotes(r.from, r.to), rows("plans", "")]);
  const mine = sold.filter((q) => who(q.by) === userId);
  const byDay = new Map();
  let jobsC = 0, jobsN = 0, plansC = 0, plansN = 0, arr = 0;
  for (const q of mine) {
    const d = dayOf(q.u || q.at);
    const v = soldValue(q);
    byDay.set(d, (byDay.get(d) || 0) + v);
    if (Number.isSafeInteger(q.annual) && q.annual > 0) { plansC += v; plansN += 1; arr += q.annual; } else { jobsC += v; jobsN += 1; }
  }
  // plans set up for the customers this person sold to count as their plans too
  const myCustomers = new Set(all.filter((q) => who(q.by) === userId).map((q) => q.c).filter(Boolean));
  const myPlans = plans.filter((p) => myCustomers.has(p.c) && inRange(dayOf(p.at), r.from, r.to) && p.st !== "cancelled");
  if (!plansN && myPlans.length) { plansN = myPlans.length; plansC = myPlans.reduce((n, p) => n + (p.sv || 0), 0); arr = plansC; }
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
    period, from: r.from, to: r.to, sold_cents: total, count: mine.length, series,
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
