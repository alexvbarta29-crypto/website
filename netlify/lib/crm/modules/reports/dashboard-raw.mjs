// The dashboard feed (design §5.9 "Dashboard feed (G34)", §6.10):
// dashboardRaw(asOf) returns exactly the raw.json keys
// build/office_dashboard.mjs buildSnapshot() reads (docs/DASHBOARD.md), each
// in Rotor's report shape ({ range, totals, buckets: [{ key, count, sum_cents }] }),
// from the CRM's own records: the daily rollups for payments and leads, the
// indexes for the rest. /dashboard builds its picture from it when
// cfg/dashboard.source is "crm" (netlify/functions/dashboard.mjs); otherwise
// it keeps opening the sealed Rotor snapshot. Aggregates only: no names but
// the team's.

import { readIndex } from "../../../crm-store.mjs";
import { addLocalDays, dowOfDate, isLocalDate, localDate } from "../../core/clock.mjs";
import { InputError } from "../../core/errors.mjs";
import { daysIn, prevMonth, nextMonth, daysInMonth, sellerOf, planSellers } from "./rollup.mjs";

const rows = async (name, shard) => { try { return (await readIndex(name, shard)).rows || []; } catch { return []; } };
const sum = (list, f) => list.reduce((a, x) => a + (f(x) || 0), 0);
const monday = (d) => addLocalDays(d, -((dowOfDate(d) + 6) % 7));
const dayOf = (iso) => (typeof iso === "string" && iso ? (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : localDate(new Date(iso))) : null);
const report = (range, buckets) => ({ range, totals: { count: sum(buckets, (b) => b.count), sum_cents: sum(buckets, (b) => b.sum_cents || 0) }, buckets });
const FREQ = { biannual: "Semi-Annual", quarterly: "Quarterly", monthly: "Monthly", lights_annual: "Annual", custom: "Custom" };
const JOB = { unscheduled: "Pending", scheduled: "Scheduled", in_progress: "In Progress", completed: "Completed", cancelled: "Cancelled" };
const QUOTE = { draft: "draft", sent: "sent", viewed: "sent", approved: "approved", converted: "converted", declined: "rejected", changes_requested: "modification_requested" };

function monthBuckets(days, from, to, f) {
  const out = [];
  for (let m = from.slice(0, 7); m <= to.slice(0, 7) && out.length < 26; m = nextMonth(m)) {
    const d = days.filter((x) => x.date.slice(0, 7) === m);
    out.push({ key: m, ...f(d) });
  }
  return out;
}
const pay = (d) => ({ count: sum(d, (x) => x.payments), sum_cents: sum(d, (x) => x.revenue_cents) });
const typeBuckets = (d) => [
  { key: "invoice", count: sum(d, (x) => x.payments), sum_cents: sum(d, (x) => x.revenue_cents + x.refunds_cents) },
  { key: "refund", count: sum(d, (x) => x.refunds || 0), sum_cents: sum(d, (x) => x.refunds_cents) },
];
const leadsOf = (d) => ({ count: sum(d, (x) => sum(Object.values(x.leads_new), (n) => n)) });
const bySource = (d, field) => {
  const o = {};
  for (const x of d) for (const [k, n] of Object.entries(x[field] || {})) o[k] = (o[k] || 0) + n;
  return Object.entries(o).sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ key, count }));
};

export async function dashboardRaw(asOf) {
  if (!isLocalDate(asOf)) throw new InputError("Pick the as-of date.", "as_of");
  const m = asOf.slice(0, 7);
  let first = m;
  for (let i = 0; i < 11; i++) first = prevMonth(first);
  const from12 = `${first}-01`, to12 = `${m}-${String(daysInMonth(m)).padStart(2, "0")}`;
  const y1 = (d) => `${Number(d.slice(0, 4)) - 1}${d.slice(4)}`;
  const fromPrev = y1(from12), toPrev = `${y1(m)}-${String(daysInMonth(y1(m))).padStart(2, "0")}`;
  const yearStart = `${asOf.slice(0, 4)}-01-01`;
  const asOfPrev = asOf.endsWith("-02-29") ? `${y1(asOf).slice(0, 7)}-28` : y1(asOf);
  const cache = new Map();
  const end = asOf;
  const [days, prevDays] = await Promise.all([daysIn(from12, end, { cache }), daysIn(fromPrev, toPrev, { cache })]);
  const ytd = days.filter((x) => x.date >= yearStart && x.date <= asOf);
  const ytdPrev = (await daysIn(`${y1(yearStart)}`, asOfPrev, { cache })).filter((x) => x.date <= asOfPrev);
  const week0 = addLocalDays(monday(asOf), -77);
  const weeks = [];
  for (let w = week0; w <= asOf; w = addLocalDays(w, 7)) weeks.push(w);
  const weekly = (f) => weeks.map((w) => ({ key: w, ...f(days.filter((x) => x.date >= w && x.date <= addLocalDays(w, 6) && x.date <= asOf)) }));

  const [invOpen, invY, invY0, jobsOpen, jobsY, jobsY0, plans, quotesOpen, quotesY, quotesY0, users, contacts] = await Promise.all([
    rows("invoices", "open"), rows("invoices", asOf.slice(0, 4)), rows("invoices", String(Number(asOf.slice(0, 4)) - 1)),
    rows("jobs", "open"), rows("jobs", asOf.slice(0, 4)), rows("jobs", String(Number(asOf.slice(0, 4)) - 1)),
    rows("plans", ""), rows("quotes", "open"), rows("quotes", asOf.slice(0, 4)), rows("quotes", String(Number(asOf.slice(0, 4)) - 1)),
    rows("users", ""), rows("contacts", ""),
  ]);
  const testIds = new Set(contacts.filter((c) => c.fl && c.fl.test).map((c) => c.id));
  const real = (r) => !testIds.has(r.c);
  const within12 = (d) => !!d && d >= from12 && d <= asOf;

  // invoices issued in the last 12 months (and every open one), by Rotor's statuses
  const seen = new Set();
  const inv = {};
  for (const r of [...invOpen, ...invY, ...invY0]) {
    if (seen.has(r.id) || !real(r) || r.sim) continue;
    seen.add(r.id);
    if (!(r.st === "open" || r.st === "draft" || within12(dayOf(r.iss || r.at)))) continue;
    const key = r.st === "open" ? (r.due && r.due < asOf ? "overdue" : r.pp ? "partially_paid" : r.sent ? "sent" : "open") : r.st === "uncollectible" ? "failed" : r.st;
    const b = inv[key] ||= { key, count: 0, sum_cents: 0 };
    b.count += 1;
    b.sum_cents += r.st === "open" ? r.bal || 0 : r.tot || 0;
  }
  // jobs: the open ones by status, and those finished or cancelled in the last 12 months
  const jobs = {};
  const seenJ = new Set();
  for (const j of [...jobsOpen, ...jobsY, ...jobsY0]) {
    if (seenJ.has(j.id) || !real(j)) continue;
    seenJ.add(j.id);
    if (j.st === "completed" && !within12(dayOf(j.done))) continue;
    if (j.st === "cancelled" && !within12(dayOf(j.u))) continue;
    const key = JOB[j.st] || j.st;
    (jobs[key] ||= { key, count: 0 }).count += 1;
  }
  // visits: the last 12 months, and the next four Monday weeks
  const vMonths = [];
  for (let mm = first; mm <= m; mm = nextMonth(mm)) vMonths.push(mm);
  const nextMon = addLocalDays(monday(asOf), 7);
  const ahead = [nextMon, addLocalDays(nextMon, 7), addLocalDays(nextMon, 14), addLocalDays(nextMon, 21)];
  const aheadMonths = [...new Set([nextMon.slice(0, 7), addLocalDays(nextMon, 27).slice(0, 7)])];
  const vRows = await Promise.all([...new Set([...vMonths, ...aheadMonths])].map((mm) => rows("visits", mm).then((r) => [mm, r])));
  const visitsBy = new Map(vRows);
  const live = (v) => v.st !== "cancelled" && real(v);
  const visitsByMonth = vMonths.map((mm) => ({ key: mm, count: (visitsBy.get(mm) || []).filter(live).length }));
  const allAhead = aheadMonths.flatMap((mm) => visitsBy.get(mm) || []).filter(live);
  const visitsNext = ahead.map((w) => ({ key: w, count: allAhead.filter((v) => v.d >= w && v.d <= addLocalDays(w, 6)).length }));
  // plans
  const realPlans = plans.filter(real);
  const created = {};
  for (const p of realPlans) { const d = dayOf(p.at); if (within12(d)) created[d.slice(0, 7)] = (created[d.slice(0, 7)] || 0) + 1; }
  const cancelled = realPlans.filter((p) => ["cancelled", "cancelling"].includes(p.st) && within12(p.eff || dayOf(p.u))).length;
  // quotes by Rotor's status words (the dashboard's close rate)
  const qs = {};
  const seenQ = new Set();
  const allQuotes = [...quotesOpen, ...quotesY, ...quotesY0].filter((q) => (seenQ.has(q.id) ? false : seenQ.add(q.id)) && real(q));
  for (const q of allQuotes) { const k = QUOTE[q.st]; if (k) qs[k] = (qs[k] || 0) + 1; }
  // the active plans as Rotor lists them: frequency, sale value (dollars), seller
  const who = sellerOf(users.map((u) => ({ id: u.id, name: u.name, first_name: u.first_name, login: u.login })));
  const sellers = planSellers(allQuotes, who);
  const active = realPlans.filter((p) => p.st === "active").map((p) => ({ service_frequency: FREQ[p.ck] || "Custom", sale_value: Math.round(p.sv || 0) / 100, sold_by: (sellers.get(p.c) && sellers.get(p.c) !== "unassigned" ? sellers.get(p.c) : null) }));

  const range = { start: from12, end: asOf };
  return {
    as_of: asOf, source: "crm",
    payments_by_month: report(range, monthBuckets(days, from12, to12, pay)),
    payments_by_month_prev: report({ start: fromPrev, end: toPrev }, monthBuckets(prevDays, fromPrev, toPrev, pay)),
    payments_ytd_by_type: report({ start: yearStart, end: asOf }, typeBuckets(ytd)),
    payments_ytd_by_type_prev: report({ start: y1(yearStart), end: asOfPrev }, typeBuckets(ytdPrev)),
    payments_by_week: report({ start: week0, end: asOf }, weekly(pay)),
    leads_by_week: report({ start: week0, end: asOf }, weekly(leadsOf)),
    leads_by_source: report(range, bySource(days, "leads_new")),
    customers_by_source: report(range, bySource(days, "customers_new")),
    invoices_by_status: report(range, Object.values(inv)),
    jobs_by_status: report(range, Object.values(jobs)),
    visits_by_month: report(range, visitsByMonth),
    visits_next_weeks: report({ start: nextMon, end: addLocalDays(nextMon, 27) }, visitsNext),
    plans_created_by_month: report(range, Object.entries(created).sort().map(([key, count]) => ({ key, count }))),
    plan_cancellations: report(range, [{ key: "cancelled", count: cancelled }]),
    quotes_by_status: { draft: qs.draft || 0, sent: qs.sent || 0, approved: qs.approved || 0, converted: qs.converted || 0, rejected: qs.rejected || 0, modification_requested: qs.modification_requested || 0 },
    members: users.filter((u) => u.status !== "disabled").map((u) => ({ user_id: u.id, name: u.name || u.login || "Someone" })),
    service_plans_active: { data: active },
  };
}
