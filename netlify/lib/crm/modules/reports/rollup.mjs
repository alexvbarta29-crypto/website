// Reports: the daily rollups (design §5.9). One row per local day, kept per
// month in ix/reports/daily/{yyyy-mm} (derived, rebuilt at will, never
// backed up), built from the indexes only:
//
//   payments      ix/payments/{month}      revenue (Σ succeeded payments − refunds), tips, fees, by method,
//                                          by customer source; simulated (dry-run) payments never count
//   jobs          ix/jobs/{year}           work completed (billable totals after discounts), by service,
//                                          per person (split equally), callbacks (touch-ups)
//   visits        ix/visits/{month}        visits completed
//   invoices      ix/invoices/open|{year}  invoices issued
//   quotes        ix/quotes/open|{year}    sent, won (approved or converted), lost (declined), per seller
//                                          (sold_by) and per customer source
//   plans         ix/plans                 started (by catalog), cancelled, and at the night's run the
//                                          active plans and their monthly value
//   contacts      ix/contacts              new leads and customers by source (the row's `ca`)
//   time          ix/timesheets/{month}    service hours per person (closed, approved, locked)
//   reviews       ix/reviews               new reviews, rating, per technician credited
// A test contact (flags.test) never counts (D35).
//
// buildMonth() is pure (tests hand-total a fixture day against it);
// monthDays() reads the cached month, building it when it is missing, the
// current month when its copy is older than FRESH_MS, or when asked to.
// The reports.rollup sweep (01:30) rebuilds yesterday's month final and
// adds what only the night knows: the active plans, MRR, and each new
// lead's time to first touch (from their contact's stats).

import { readIndex, getRaw, settledWrite, getRecords } from "../../../crm-store.mjs";
import { now, nowIso, localDate, addLocalDays, dowOfDate, zonedToUtc, isLocalDate, DEFAULT_HOURS, isHoliday } from "../../core/clock.mjs";
import { safeErr } from "../../../referral-lib.mjs";

export const FRESH_MS = 10 * 60 * 1000;
const KEY = (m) => `ix/reports/daily/${m}`;
const dayOf = (iso) => (typeof iso === "string" && iso ? (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : localDate(new Date(iso))) : null);
const inc = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; return o; };
export const today = () => localDate(now());
export const nextMonth = (m) => { const [y, mm] = m.split("-").map(Number); return mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, "0")}`; };
export const prevMonth = (m) => { const [y, mm] = m.split("-").map(Number); return mm === 1 ? `${y - 1}-12` : `${y}-${String(mm - 1).padStart(2, "0")}`; };
export const daysInMonth = (m) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate();
export function monthsBetween(from, to) {
  const out = [];
  for (let m = from.slice(0, 7); m <= to.slice(0, 7) && out.length < 40; m = nextMonth(m)) out.push(m);
  return out;
}
export const SOLD = ["approved", "converted"];
export const LOST = ["declined"];

export function blankDay(date) {
  return {
    date, revenue_cents: 0, refunds_cents: 0, refunds: 0, tips_cents: 0, fees_cents: 0, payments: 0, payments_by_method: {}, revenue_by_source: {},
    work_completed_cents: 0, jobs_completed: 0, billable_jobs: 0, callbacks: 0, work_by_service: {}, visits_completed: 0,
    invoices_issued: 0, invoices_issued_cents: 0, leads_new: {}, customers_new: {}, first_touch_minutes: [],
    quotes_sent: 0, quotes_sent_cents: 0, quotes_won: 0, quotes_won_cents: 0, quotes_lost: 0, won_by_source: {}, lost_by_source: {}, sent_by_source: {},
    sold_by: {}, plans_started: {}, plans_started_cents: 0, plans_started_by: {}, plans_cancelled: {}, tech: {}, reviews_new: 0, reviews_rating_sum: 0,
  };
}

const soldValue = (q) => (Number.isSafeInteger(q.annual) && q.annual > 0 ? q.annual : Number.isSafeInteger(q.first) ? q.first : 0);

// Who a sold_by names: a user id, or an imported quote's Rotor rep (matched by name or first name).
export function sellerOf(users) {
  const byName = new Map();
  for (const u of users) for (const n of [u.name, u.first_name, u.login]) if (n) byName.set(String(n).trim().toLowerCase(), u.id);
  const ids = new Set(users.map((u) => u.id));
  return (by) => {
    if (!by) return "unassigned";
    if (ids.has(by)) return by;
    const k = String(by).trim().toLowerCase();
    return byName.get(k) || byName.get(k.split(/\s+/)[0]) || "unassigned";
  };
}

// The seller credited with a customer's plan: the seller of their latest sold quote.
export function planSellers(quotes, who) {
  const out = new Map();
  for (const q of [...quotes].filter((x) => SOLD.includes(x.st)).sort((a, b) => String(a.u || "").localeCompare(String(b.u || "")))) if (q.c) out.set(q.c, who(q.by));
  return out;
}

// One month's day rows from index rows (pure). data: { payments, jobs, visits, invoices, quotes, plans, contacts, sheets, reviews, users }
export function buildMonth(month, data) {
  const days = {};
  const D = (d) => (d && d.slice(0, 7) === month ? (days[d] ||= blankDay(d)) : null);
  const contacts = new Map((data.contacts || []).map((c) => [c.id, c]));
  const isTest = (cid) => { const c = cid && contacts.get(cid); return !!(c && c.fl && c.fl.test); };
  const srcOf = (cid) => { const c = cid && contacts.get(cid); return (c && c.src) || "Unknown"; };
  const who = sellerOf(data.users || []);
  const tech = (row, uid) => (row.tech[uid] ||= { minutes: 0, job_value_cents: 0, jobs: 0, callbacks: 0, reviews: 0, upsell_cents: 0 });

  for (const p of data.payments || []) {
    if (p.st !== "succeeded" || p.sim || isTest(p.c)) continue;
    const row = D(p.on);
    if (!row) continue;
    const amount = (p.a || 0) + (p.tip || 0);
    if (p.k === "refund") { row.refunds_cents += amount; row.refunds += 1; row.revenue_cents -= amount; row.tips_cents -= p.tip || 0; continue; }
    if (p.k !== "payment") continue;
    row.revenue_cents += amount; row.tips_cents += p.tip || 0; row.fees_cents += p.fee || 0; row.payments += 1;
    inc(row.payments_by_method, p.m || "other", amount);
    inc(row.revenue_by_source, srcOf(p.c), amount);
  }
  const seenJob = new Set();
  for (const j of data.jobs || []) {
    if (seenJob.has(j.id)) continue;
    seenJob.add(j.id);
    if (j.st !== "completed" || isTest(j.c)) continue;
    const row = D(dayOf(j.done));
    if (!row) continue;
    const crew = j.a || [];
    if (j.k === "touch_up") { row.callbacks += 1; for (const uid of crew) tech(row, uid).callbacks += 1; continue; }
    row.jobs_completed += 1;
    if (j.bill === false) continue;
    row.billable_jobs += 1;
    row.work_completed_cents += j.tot || 0;
    inc(row.work_by_service, (j.svc && j.svc[0]) || "Other", j.tot || 0);
    if (crew.length) {
      const share = Math.floor((j.tot || 0) / crew.length);
      crew.forEach((uid, i) => { const t = tech(row, uid); t.jobs += 1; t.job_value_cents += share + (i === 0 ? (j.tot || 0) - share * crew.length : 0); });
    }
  }
  for (const v of data.visits || []) if (v.st === "completed" && !isTest(v.c)) { const row = D(v.d); if (row) row.visits_completed += 1; }
  const seenInv = new Set();
  for (const i of data.invoices || []) {
    if (seenInv.has(i.id) || !i.iss || isTest(i.c) || i.st === "draft" || i.st === "void") continue;
    seenInv.add(i.id);
    const row = D(i.iss);
    if (row) { row.invoices_issued += 1; row.invoices_issued_cents += i.tot || 0; }
  }
  const seenQ = new Set();
  const quotes = (data.quotes || []).filter((q) => (seenQ.has(q.id) ? false : seenQ.add(q.id)) && !isTest(q.c));
  const by = (row, uid) => (row.sold_by[uid] ||= { sent: 0, won: 0, won_cents: 0, lost: 0, plans: 0, plans_cents: 0 });
  for (const q of quotes) {
    const src = srcOf(q.c);
    const seller = who(q.by);
    const sent = D(dayOf(q.sent));
    if (sent) { sent.quotes_sent += 1; sent.quotes_sent_cents += soldValue(q); inc(sent.sent_by_source, src); by(sent, seller).sent += 1; }
    const closed = D(dayOf(q.u || q.at));
    if (closed && SOLD.includes(q.st)) { closed.quotes_won += 1; closed.quotes_won_cents += soldValue(q); inc(closed.won_by_source, src); const s = by(closed, seller); s.won += 1; s.won_cents += soldValue(q); }
    if (closed && LOST.includes(q.st)) { closed.quotes_lost += 1; inc(closed.lost_by_source, src); by(closed, seller).lost += 1; }
  }
  const sellerOfPlan = planSellers(quotes, who);
  for (const p of data.plans || []) {
    if (isTest(p.c)) continue;
    const start = D(dayOf(p.at));
    if (start && !["draft"].includes(p.st)) {
      inc(start.plans_started, p.ck || "custom");
      start.plans_started_cents += p.sv || 0;
      const s = by(start, sellerOfPlan.get(p.c) || "unassigned");
      s.plans += 1; s.plans_cents += p.sv || 0;
      inc(start.plans_started_by, sellerOfPlan.get(p.c) || "unassigned");
    }
    if (["cancelled", "cancelling"].includes(p.st)) { const end = D(p.eff || dayOf(p.u)); if (end) inc(end.plans_cancelled, p.ck || "custom"); }
  }
  for (const c of data.contacts || []) {
    if (c.fl && (c.fl.test || c.fl.vendor)) continue;
    const row = D(dayOf(c.ca));
    if (!row) continue;
    inc(row.leads_new, c.src || "Unknown");
    if (c.lc === "customer" || c.lc === "former_customer") inc(row.customers_new, c.src || "Unknown");
  }
  for (const s of data.sheets || []) {
    if ((s.cat || "service") !== "service" || !["closed", "approved", "locked"].includes(s.st)) continue;
    const row = D(s.d || dayOf(s.s));
    if (row) tech(row, s.uid).minutes += s.min || 0;
  }
  for (const r of data.reviews || []) {
    const row = D(dayOf(r.at));
    if (!row) continue;
    row.reviews_new += 1; row.reviews_rating_sum += Number(r.r) || 0;
    for (const uid of r.t || []) tech(row, uid).reviews += 1;
  }
  return days;
}

// ------------------------------------------------------------ reading the indexes

const rows = async (name, shard) => { try { return (await readIndex(name, shard)).rows || []; } catch { return []; } };
const memo = new WeakMap();
// The shared indexes, read once per request however many months are built.
function shared(cache, name, shard) {
  const k = `${name}|${shard}`;
  if (!cache.has(k)) cache.set(k, rows(name, shard));
  return cache.get(k);
}

export async function monthData(month, cache = new Map()) {
  const y = month.slice(0, 4);
  const [payments, visits, sheets, jobsY, jobsOpen, invY, invOpen, quotesY, quotesOpen, plans, contacts, reviews, users] = await Promise.all([
    rows("payments", month), rows("visits", month), rows("timesheets", month),
    shared(cache, "jobs", y), shared(cache, "jobs", "open"), shared(cache, "invoices", y), shared(cache, "invoices", "open"),
    shared(cache, "quotes", y), shared(cache, "quotes", "open"), shared(cache, "plans", ""), shared(cache, "contacts", ""), shared(cache, "reviews", ""), shared(cache, "users", ""),
  ]);
  return { payments, visits, sheets, jobs: [...jobsY, ...jobsOpen], invoices: [...invY, ...invOpen], quotes: [...quotesY, ...quotesOpen], plans, contacts, reviews, users };
}

// The cached month; built (and kept) when missing, stale or asked for.
export async function monthDays(month, { cache = new Map(), rebuild = false, extra = null } = {}) {
  const cur = await getRaw(KEY(month)).catch(() => null);
  const doc = cur && cur.data;
  const thisMonth = today().slice(0, 7);
  const stale = !doc || doc.v !== 1 || rebuild || (month >= thisMonth && Date.parse(doc.built_at || 0) < now().getTime() - FRESH_MS) || (month < thisMonth && doc.partial);
  if (!stale) return doc.days || {};
  const data = await monthData(month, cache);
  const days = buildMonth(month, data);
  // what only a night run knows (active plans, first touch) is kept from the copy before
  for (const [d, row] of Object.entries((doc && doc.days) || {})) {
    if (!days[d] && (row.active_plans_eod !== undefined || (row.first_touch_minutes || []).length)) days[d] = blankDay(d);
    if (!days[d]) continue;
    if (row.active_plans_eod !== undefined) { days[d].active_plans_eod = row.active_plans_eod; days[d].mrr_cents_eod = row.mrr_cents_eod; }
    if ((row.first_touch_minutes || []).length) days[d].first_touch_minutes = row.first_touch_minutes;
  }
  if (extra) for (const [d, x] of Object.entries(extra)) Object.assign(days[d] ||= blankDay(d), x);
  const next = { v: 1, month, built_at: nowIso(), partial: month >= thisMonth, days };
  try {
    await settledWrite(KEY(month), next, cur && cur.etag ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
  } catch (e) {
    console.error(`crm:reports: a month not kept (${safeErr(e)})`);   // the answer still stands
  }
  return days;
}

// Day rows from..to (inclusive), every day present.
export async function daysIn(from, to, opts = {}) {
  const cache = opts.cache || new Map();
  const months = monthsBetween(from, to);
  const got = await Promise.all(months.map((m) => monthDays(m, { cache, rebuild: opts.rebuild })));
  const all = Object.assign({}, ...got);
  const out = [];
  for (let d = from; d <= to && out.length < 800; d = addLocalDays(d, 1)) out.push(all[d] || blankDay(d));
  return out;
}

// ------------------------------------------------------------ first touch (business minutes)

// Minutes the business was open between two instants (cfg/hours defaults, holidays off).
export function businessMinutes(fromIso, toIso, hours = DEFAULT_HOURS) {
  const a = Date.parse(fromIso), b = Date.parse(toIso);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 0;
  let total = 0;
  for (let d = localDate(new Date(a)), i = 0; d <= localDate(new Date(b)) && i < 400; d = addLocalDays(d, 1), i++) {
    const span = hours[dowOfDate(d)];
    if (!span || isHoliday(d)) continue;
    const s = Math.max(a, zonedToUtc(d, span[0]).getTime());
    const e = Math.min(b, zonedToUtc(d, span[1]).getTime());
    if (e > s) total += (e - s) / 60000;
  }
  return Math.round(total);
}

// The first outbound touch on a lead from its stats (first text on any
// number, the last call and last contact as of tonight: for a lead from
// yesterday that is its first).
export function firstTouchOf(createdIso, stats) {
  const s = stats || {};
  const sys = s.system || {}, sales = s.sales || {};
  const times = [...Object.values(sys.first_sms || {}), sys.last_contacted_at, sales.last_called_at, sales.last_touch_at]
    .filter((x) => typeof x === "string" && Date.parse(x) >= Date.parse(createdIso));
  return times.length ? times.sort()[0] : null;
}

// ------------------------------------------------------------ the reports.rollup sweep (01:30)

export async function rollupSweep(ctx = {}) {
  const t = today();
  const y = addLocalDays(t, -1);
  const cache = new Map();
  const extra = {};
  // the active plans and their monthly value at the end of yesterday
  const plans = await shared(cache, "plans", "");
  const contacts = new Map((await shared(cache, "contacts", "")).map((c) => [c.id, c]));
  const live = plans.filter((p) => p.st === "active" && !(contacts.get(p.c) && contacts.get(p.c).fl && contacts.get(p.c).fl.test));
  extra[y] = { active_plans_eod: live.length, mrr_cents_eod: Math.round(live.reduce((a, p) => a + (p.sv || 0), 0) / 12) };
  // yesterday's leads: minutes to the first touch, business hours only
  const fresh = [...contacts.values()].filter((c) => dayOf(c.ca) === y && !(c.fl && (c.fl.test || c.fl.vendor))).slice(0, 60);
  if (fresh.length) {
    const stats = new Map((await getRecords("contact_stats", fresh.map((c) => c.id)).catch(() => [])).filter(Boolean).map((g) => [g.data.id, g.data]));
    const mins = [];
    for (const c of fresh) {
      const first = firstTouchOf(c.ca, stats.get(c.id));
      if (first) mins.push(businessMinutes(c.ca, first));
    }
    extra[y].first_touch_minutes = mins;
  }
  await monthDays(y.slice(0, 7), { cache, rebuild: true, extra });
  if (y.slice(0, 7) !== t.slice(0, 7)) await monthDays(t.slice(0, 7), { cache, rebuild: true });
  void ctx;
  return { done: true, progress: 1, result: `rolled up ${y}` };
}

// POST /reports/rebuild { from, to }: those months built again from the indexes.
export async function rebuild(from, to) {
  if (!isLocalDate(from) || !isLocalDate(to) || to < from) throw new TypeError("dates");
  const cache = new Map();
  const months = monthsBetween(from, to).slice(0, 36);
  for (const m of months) await monthDays(m, { cache, rebuild: true });
  return { months };
}

export { memo as _memo };
