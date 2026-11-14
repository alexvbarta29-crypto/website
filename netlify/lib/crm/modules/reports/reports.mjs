// The Reports screen's numbers (design §5.9, §9.2 Reports): each report is
// tiles (with the previous period of the same length to compare), a series
// grouped by day, week (Monday) or month for the chart, and tables that
// export as CSV. Everything but "owed" and "payroll" comes from the daily
// rollups (rollup.mjs); owed is the open invoices index live, payroll the
// pay periods.
//
//   revenue  collected (cash: payments − refunds), invoiced, work completed, tips; by method, service, source
//   sales    quotes sent / won / lost, close rate, average ticket; by person (sold_by) and by source
//   leads    new leads and customers by source, time to first touch (business hours), plan adoption
//   plans    active now, MRR / ARR, started, cancelled, churn; by catalog
//   jobs     jobs and visits completed, average ticket, revenue per tech-hour, callbacks; per tech
//   team     per tech: hours, job value, revenue per hour, reviews a week, callbacks (the scoreboard's targets)
//   owed     open balances and their age (current, 1-30, 31-60, 61-90, over 90 days past due)
//   payroll  pay periods in the range: pay, hours, overtime, tips, per person
// Simulated (dry-run) payments and test contacts never count (rollup.mjs).

import { readIndex, getRecords } from "../../../crm-store.mjs";
import { addLocalDays, dowOfDate, isLocalDate } from "../../core/clock.mjs";
import { InputError, NotFoundError } from "../../core/errors.mjs";
import { daysIn, today, planSellers, sellerOf, daysInMonth, SOLD } from "./rollup.mjs";

export const REPORTS = Object.freeze(["revenue", "sales", "leads", "plans", "jobs", "team", "owed", "payroll"]);
export const GROUPS = Object.freeze(["day", "week", "month"]);
export const MAX_DAYS = 400;
const ALIAS = { ops: "jobs", money: "revenue" };
const rows = async (name, shard) => { try { return (await readIndex(name, shard)).rows || []; } catch { return []; } };
const sum = (list, f) => list.reduce((a, x) => a + (f(x) || 0), 0);
const merge = (list, f) => { const o = {}; for (const x of list) for (const [k, v] of Object.entries(f(x) || {})) o[k] = (o[k] || 0) + v; return o; };
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
const median = (list) => { const s = [...list].sort((a, b) => a - b); if (!s.length) return null; const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dLabel = (d) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;
const CATALOG = { biannual: "Biannual", quarterly: "Quarterly", monthly: "Monthly", lights_annual: "Christmas lights", custom: "Custom" };
const METHOD = { card: "Card", ach: "Bank (ACH)", cash: "Cash", check: "Check", other: "Other", credit: "Credit", imported: "Imported" };

// ------------------------------------------------------------ ranges

// A named range, from the server's today (the screen sends the name, so a phone's clock never matters).
export const RANGES = Object.freeze(["week", "month", "last_month", "3m", "year", "12m"]);
export function namedRange(name, t = today()) {
  const firstOf = (d) => `${d.slice(0, 7)}-01`;
  const prevFirst = (d) => firstOf(addLocalDays(firstOf(d), -1));
  if (name === "week") return { from: addLocalDays(t, -((dowOfDate(t) + 6) % 7)), to: t };
  if (name === "last_month") return { from: prevFirst(t), to: addLocalDays(firstOf(t), -1) };
  if (name === "3m") return { from: prevFirst(prevFirst(t)), to: t };
  if (name === "year") return { from: `${t.slice(0, 4)}-01-01`, to: t };
  if (name === "12m") return { from: addLocalDays(t, -364), to: t };
  return { from: firstOf(t), to: t };
}
export function rangeOf(q = {}) {
  const t = today();
  const named = !q.from && !q.to && RANGES.includes(q.range) ? namedRange(q.range, t) : null;
  const from = named ? named.from : q.from || `${t.slice(0, 7)}-01`;
  const to = named ? named.to : q.to || t;
  if (!isLocalDate(from) || !isLocalDate(to)) throw new InputError("Pick the first and the last day.", "from");
  if (to < from) throw new InputError("The last day comes after the first.", "to");
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  if (days > MAX_DAYS) throw new InputError("A year at most.", "to");
  const group = GROUPS.includes(q.group) ? q.group : days > 92 ? "month" : days > 31 ? "week" : "day";
  const prevTo = addLocalDays(from, -1);
  return { from, to, days, group, prev: { from: addLocalDays(prevTo, -(days - 1)), to: prevTo } };
}
const bucketOf = (d, group) => (group === "month" ? d.slice(0, 7) : group === "week" ? addLocalDays(d, -((dowOfDate(d) + 6) % 7)) : d);
export function bucketLabel(k, group) {
  if (group === "month") return `${MONTHS[Number(k.slice(5, 7)) - 1]} ${k.slice(2, 4)}`;
  return dLabel(k);
}
function buckets(days, group) {
  const keys = [];
  const by = new Map();
  for (const d of days) {
    const k = bucketOf(d.date, group);
    if (!by.has(k)) { by.set(k, []); keys.push(k); }
    by.get(k).push(d);
  }
  return { keys, by };
}
const series = (b, label, key, f) => ({ key, label, values: b.keys.map((k) => f(b.by.get(k))) });
const tile = (key, label, value, prev, unit = "count", extra = {}) => ({ key, label, value, prev: prev === undefined ? null : prev, unit, ...extra });

// ------------------------------------------------------------ people

async function team() {
  return (await rows("users", "")).map((u) => ({ id: u.id, name: u.name || u.login, first_name: u.first_name, login: u.login, role: u.role, color: u.color || null, is_technician: !!u.is_technician, status: u.status }));
}
const nameOf = (users) => { const m = new Map(users.map((u) => [u.id, u.name])); return (id) => (id === "unassigned" ? "Unassigned" : m.get(id) || "Someone gone"); };

// ------------------------------------------------------------ the reports

function revenue(cur, prev, b) {
  const t = (d) => ({ collected: sum(d, (x) => x.revenue_cents), invoiced: sum(d, (x) => x.invoices_issued_cents), work: sum(d, (x) => x.work_completed_cents), tips: sum(d, (x) => x.tips_cents), refunds: sum(d, (x) => x.refunds_cents), payments: sum(d, (x) => x.payments), fees: sum(d, (x) => x.fees_cents) });
  const c = t(cur), p = t(prev);
  const method = merge(cur, (x) => x.payments_by_method), service = merge(cur, (x) => x.work_by_service), source = merge(cur, (x) => x.revenue_by_source);
  const share = (o) => Object.entries(o).sort((a, b2) => b2[1] - a[1]);
  return {
    tiles: [tile("collected", "Collected", c.collected, p.collected, "cents"), tile("invoiced", "Invoiced", c.invoiced, p.invoiced, "cents"), tile("work", "Work completed", c.work, p.work, "cents"), tile("tips", "Tips", c.tips, p.tips, "cents"), tile("refunds", "Refunded", c.refunds, p.refunds, "cents"), tile("payments", "Payments", c.payments, p.payments)],
    series: [series(b, "Collected", "collected", (d) => sum(d, (x) => x.revenue_cents)), series(b, "Invoiced", "invoiced", (d) => sum(d, (x) => x.invoices_issued_cents))],
    unit: "cents",
    tables: [
      { key: "by_period", title: "By period", head: ["Period", "Collected", "Invoiced", "Work completed", "Tips"], money: [1, 2, 3, 4], rows: b.keys.map((k) => { const d = b.by.get(k); return [k, sum(d, (x) => x.revenue_cents), sum(d, (x) => x.invoices_issued_cents), sum(d, (x) => x.work_completed_cents), sum(d, (x) => x.tips_cents)]; }) },
      { key: "by_service", title: "Work completed by service", head: ["Service", "Work completed", "Share"], money: [1], rows: share(service).map(([k, v]) => [k, v, pct(v, c.work)]) },
      { key: "by_source", title: "Collected by customer source", head: ["Source", "Collected", "Share"], money: [1], rows: share(source).map(([k, v]) => [k, v, pct(v, c.collected)]) },
      { key: "by_method", title: "Collected by method", head: ["Method", "Collected"], money: [1], rows: share(method).map(([k, v]) => [METHOD[k] || k, v]) },
    ],
  };
}

function sales(cur, prev, b, users) {
  const t = (d) => {
    const won = sum(d, (x) => x.quotes_won), lost = sum(d, (x) => x.quotes_lost);
    const jobs = sum(d, (x) => x.billable_jobs), work = sum(d, (x) => x.work_completed_cents);
    return { sent: sum(d, (x) => x.quotes_sent), won, lost, won_cents: sum(d, (x) => x.quotes_won_cents), close: pct(won, won + lost), avg: jobs ? Math.round(work / jobs) : null, plans: sum(d, (x) => sum(Object.values(x.plans_started), (n) => n)) };
  };
  const c = t(cur), p = t(prev);
  const who = nameOf(users);
  const people = {};
  for (const d of cur) for (const [uid, s] of Object.entries(d.sold_by || {})) { const o = people[uid] ||= { sent: 0, won: 0, won_cents: 0, lost: 0, plans: 0, plans_cents: 0 }; for (const k of Object.keys(o)) o[k] += s[k] || 0; }
  const sent = merge(cur, (x) => x.sent_by_source), won = merge(cur, (x) => x.won_by_source), lost = merge(cur, (x) => x.lost_by_source);
  const sources = [...new Set([...Object.keys(sent), ...Object.keys(won), ...Object.keys(lost)])];
  return {
    tiles: [tile("sent", "Quotes sent", c.sent, p.sent), tile("won", "Quotes won", c.won, p.won), tile("won_cents", "Sold", c.won_cents, p.won_cents, "cents"), tile("close", "Close rate", c.close, p.close, "pct", { target: [40, 50] }), tile("avg", "Average ticket", c.avg, p.avg, "cents", { target: 30000 }), tile("plans", "Plans sold", c.plans, p.plans)],
    series: [series(b, "Sent", "sent", (d) => sum(d, (x) => x.quotes_sent)), series(b, "Won", "won", (d) => sum(d, (x) => x.quotes_won))],
    unit: "count",
    tables: [
      { key: "by_person", title: "By person (sold by)", head: ["Person", "Quotes sent", "Won", "Sold", "Close rate", "Plans started", "Plan value"], money: [3, 6], pctCols: [4], rows: Object.entries(people).sort((a, b2) => b2[1].won_cents - a[1].won_cents).map(([uid, s]) => [who(uid), s.sent, s.won, s.won_cents, pct(s.won, s.won + s.lost), s.plans, s.plans_cents]) },
      { key: "by_source", title: "By lead source", head: ["Source", "Quotes sent", "Won", "Lost", "Close rate"], pctCols: [4], rows: sources.sort((a, b2) => (won[b2] || 0) - (won[a] || 0)).map((s) => [s, sent[s] || 0, won[s] || 0, lost[s] || 0, pct(won[s] || 0, (won[s] || 0) + (lost[s] || 0))]) },
    ],
  };
}

function leads(cur, prev, b) {
  const t = (d) => {
    const leadsN = sum(d, (x) => sum(Object.values(x.leads_new), (n) => n)), cust = sum(d, (x) => sum(Object.values(x.customers_new), (n) => n));
    const plans = sum(d, (x) => sum(Object.values(x.plans_started), (n) => n));
    return { leads: leadsN, customers: cust, touch: median(d.flatMap((x) => x.first_touch_minutes || [])), adoption: pct(plans, cust) };
  };
  const c = t(cur), p = t(prev);
  const by = merge(cur, (x) => x.leads_new), cust = merge(cur, (x) => x.customers_new), won = merge(cur, (x) => x.won_by_source), sent = merge(cur, (x) => x.sent_by_source), lost = merge(cur, (x) => x.lost_by_source);
  const touches = cur.flatMap((x) => x.first_touch_minutes || []);
  const speed = [["Under 5 min", 0, 5], ["5-30 min", 5, 30], ["30 min - 2 h", 30, 120], ["2 h - 1 day", 120, 600], ["Over a day", 600, Infinity]];
  return {
    tiles: [tile("leads", "New leads", c.leads, p.leads), tile("customers", "New customers", c.customers, p.customers), tile("touch", "Time to first touch", c.touch, p.touch, "minutes", { note: "median, business hours" }), tile("adoption", "Plan adoption", c.adoption, p.adoption, "pct", { target: 50 })],
    series: [series(b, "Leads", "leads", (d) => sum(d, (x) => sum(Object.values(x.leads_new), (n) => n))), series(b, "Customers", "customers", (d) => sum(d, (x) => sum(Object.values(x.customers_new), (n) => n)))],
    unit: "count",
    tables: [
      { key: "by_source", title: "By source", head: ["Source", "Leads", "Became customers", "Quotes sent", "Won", "Close rate"], pctCols: [5], rows: Object.keys({ ...by, ...won }).sort((a, b2) => (by[b2] || 0) - (by[a] || 0)).map((s) => [s, by[s] || 0, cust[s] || 0, sent[s] || 0, won[s] || 0, pct(won[s] || 0, (won[s] || 0) + (lost[s] || 0))]) },
      { key: "speed", title: "Time to first touch", head: ["Within", "Leads"], rows: speed.map(([l, lo, hi]) => [l, touches.filter((m) => m >= lo && m < hi).length]) },
    ],
  };
}

async function plans(cur, prev, b) {
  const all = await rows("plans", "");
  const contacts = new Map((await rows("contacts", "")).map((c) => [c.id, c]));
  const live = all.filter((p) => p.st === "active" && !(contacts.get(p.c) && contacts.get(p.c).fl && contacts.get(p.c).fl.test));
  const mrr = Math.round(sum(live, (p) => p.sv) / 12);
  const t = (d) => ({ started: sum(d, (x) => sum(Object.values(x.plans_started), (n) => n)), started_cents: sum(d, (x) => x.plans_started_cents), cancelled: sum(d, (x) => sum(Object.values(x.plans_cancelled), (n) => n)) });
  const c = t(cur), p = t(prev);
  // churn: cancelled in the period ÷ active at its start (active now − started + cancelled)
  const atStart = Math.max(0, live.length - c.started + c.cancelled);
  const started = merge(cur, (x) => x.plans_started), cancelled = merge(cur, (x) => x.plans_cancelled);
  const byCat = {};
  for (const pl of live) { const o = byCat[pl.ck || "custom"] ||= { n: 0, arr: 0 }; o.n += 1; o.arr += pl.sv || 0; }
  const snaps = cur.filter((x) => x.active_plans_eod !== undefined);
  return {
    tiles: [tile("active", "Active plans", live.length, null), tile("mrr", "MRR", mrr, null, "cents"), tile("arr", "ARR", mrr * 12, null, "cents"), tile("started", "Started", c.started, p.started), tile("cancelled", "Cancelled", c.cancelled, p.cancelled), tile("churn", "Churn", pct(c.cancelled, atStart), null, "pct", { target: 2, lower: true })],
    series: [series(b, "Started", "started", (d) => sum(d, (x) => sum(Object.values(x.plans_started), (n) => n))), series(b, "Cancelled", "cancelled", (d) => sum(d, (x) => sum(Object.values(x.plans_cancelled), (n) => n)))],
    unit: "count",
    tables: [
      { key: "by_plan", title: "By plan", head: ["Plan", "Active now", "ARR", "Started", "Cancelled"], money: [2], rows: Object.keys({ ...byCat, ...started, ...cancelled }).map((k) => [CATALOG[k] || k, (byCat[k] || {}).n || 0, (byCat[k] || {}).arr || 0, started[k] || 0, cancelled[k] || 0]) },
      ...(snaps.length ? [{ key: "active", title: "Active plans each night", head: ["Day", "Active", "MRR"], money: [2], rows: snaps.map((x) => [x.date, x.active_plans_eod, x.mrr_cents_eod || 0]) }] : []),
    ],
  };
}

function techRows(days, users) {
  const per = {};
  for (const d of days) for (const [uid, x] of Object.entries(d.tech || {})) { const o = per[uid] ||= { minutes: 0, job_value_cents: 0, jobs: 0, callbacks: 0, reviews: 0 }; for (const k of Object.keys(o)) o[k] += x[k] || 0; }
  const who = nameOf(users);
  return Object.entries(per).filter(([uid]) => users.some((u) => u.id === uid)).map(([uid, o]) => ({ uid, name: who(uid), ...o, per_hour: o.minutes ? Math.round((o.job_value_cents * 60) / o.minutes) : null }));
}

function jobs(cur, prev, b, users) {
  const t = (d) => {
    const tr = techRows(d, users);
    const minutes = sum(tr, (x) => x.minutes), value = sum(tr, (x) => x.job_value_cents);
    const billable = sum(d, (x) => x.billable_jobs), work = sum(d, (x) => x.work_completed_cents), cb = sum(d, (x) => x.callbacks);
    return { jobs: sum(d, (x) => x.jobs_completed), visits: sum(d, (x) => x.visits_completed), work, avg: billable ? Math.round(work / billable) : null, per_hour: minutes ? Math.round((value * 60) / minutes) : null, callbacks: pct(cb, billable + cb) };
  };
  const c = t(cur), p = t(prev);
  return {
    tiles: [tile("jobs", "Jobs completed", c.jobs, p.jobs), tile("visits", "Visits completed", c.visits, p.visits), tile("work", "Work completed", c.work, p.work, "cents"), tile("avg", "Average ticket", c.avg, p.avg, "cents", { target: 30000 }), tile("per_hour", "Revenue per tech-hour", c.per_hour, p.per_hour, "cents", { target: 12500 }), tile("callbacks", "Callbacks", c.callbacks, p.callbacks, "pct", { target: 2, lower: true })],
    series: [series(b, "Work completed", "work", (d) => sum(d, (x) => x.work_completed_cents))],
    unit: "cents",
    tables: [
      { key: "by_period", title: "By period", head: ["Period", "Jobs", "Visits", "Work completed", "Callbacks"], money: [3], rows: b.keys.map((k) => { const d = b.by.get(k); return [k, sum(d, (x) => x.jobs_completed), sum(d, (x) => x.visits_completed), sum(d, (x) => x.work_completed_cents), sum(d, (x) => x.callbacks)]; }) },
      { key: "by_tech", title: "Per person (job value split between the crew)", head: ["Person", "Service hours", "Job value", "Per hour", "Jobs", "Callbacks"], money: [2, 3], rows: techRows(cur, users).sort((a, b2) => b2.job_value_cents - a.job_value_cents).map((x) => [x.name, Math.round((x.minutes / 60) * 10) / 10, x.job_value_cents, x.per_hour, x.jobs, x.callbacks]) },
    ],
  };
}

function teamReport(cur, prev, b, users, days) {
  const tr = techRows(cur, users).filter((x) => users.some((u) => u.id === x.uid && (u.role === "tech" || u.is_technician)));
  const weeks = Math.max(1, days / 7);
  const t = (d) => { const r = techRows(d, users); const m = sum(r, (x) => x.minutes); return { hours: Math.round((m / 60) * 10) / 10, value: sum(r, (x) => x.job_value_cents), per_hour: m ? Math.round((sum(r, (x) => x.job_value_cents) * 60) / m) : null, reviews: sum(d, (x) => x.reviews_new) }; };
  const c = t(cur), p = t(prev);
  return {
    tiles: [tile("hours", "Service hours", c.hours, p.hours, "hours"), tile("value", "Job value", c.value, p.value, "cents"), tile("per_hour", "Revenue per hour", c.per_hour, p.per_hour, "cents", { target: 12500 }), tile("reviews", "New reviews", c.reviews, p.reviews)],
    series: [series(b, "Job value", "value", (d) => sum(techRows(d, users), (x) => x.job_value_cents))],
    unit: "cents",
    tables: [{ key: "by_tech", title: "The crew", head: ["Person", "Hours", "Job value", "Per hour", "Reviews a week", "Callbacks"], money: [2, 3], rows: tr.sort((a, b2) => (b2.per_hour || 0) - (a.per_hour || 0)).map((x) => [x.name, Math.round((x.minutes / 60) * 10) / 10, x.job_value_cents, x.per_hour, Math.round((x.reviews / weeks) * 10) / 10, x.callbacks]) }],
  };
}

// Money owed: the open invoices, live.
export async function owed() {
  const t = today();
  const open = (await rows("invoices", "open")).filter((r) => r.st === "open" && (r.bal || 0) > 0 && !r.sim);
  const contacts = new Map((await rows("contacts", "")).map((c) => [c.id, c]));
  const real = open.filter((r) => !(contacts.get(r.c) && contacts.get(r.c).fl && contacts.get(r.c).fl.test));
  const late = (r) => (r.due && r.due < t ? Math.round((Date.parse(t) - Date.parse(r.due)) / 86400000) : 0);
  const AGES = [["Not due yet", -1, 0], ["1-30 days late", 1, 30], ["31-60 days late", 31, 60], ["61-90 days late", 61, 90], ["Over 90 days late", 91, Infinity]];
  const age = AGES.map(([label, lo, hi]) => { const l = real.filter((r) => (lo < 0 ? late(r) === 0 : late(r) >= lo && late(r) <= hi)); return [label, l.length, sum(l, (r) => r.bal)]; });
  const total = sum(real, (r) => r.bal), overdue = sum(real.filter((r) => late(r) > 0), (r) => r.bal);
  return {
    tiles: [tile("open", "Owed", total, null, "cents"), tile("overdue", "Past due", overdue, null, "cents"), tile("count", "Open invoices", real.length, null), tile("over60", "Over 60 days", sum(real.filter((r) => late(r) > 60), (r) => r.bal), null, "cents")],
    series: [], unit: "cents", live: true,
    tables: [
      { key: "aging", title: "Aging", head: ["Age", "Invoices", "Owed"], money: [2], rows: age },
      { key: "largest", title: "Largest balances", head: ["Invoice", "Customer", "Owed", "Due", "Days late"], money: [2], links: { 0: "invoice" }, rows: [...real].sort((a, b) => b.bal - a.bal).slice(0, 25).map((r) => [r.n ? `#${r.n}` : "Invoice", r.cn || "", r.bal, r.due || "", late(r)]), ids: [...real].sort((a, b) => b.bal - a.bal).slice(0, 25).map((r) => r.id) },
    ],
  };
}

// Pay periods that start in the range.
export async function payrollSummary(from, to) {
  const list = (await rows("pay-periods", "")).filter((r) => r.s >= from && r.s <= to).sort((a, b) => String(a.s).localeCompare(String(b.s)));
  const recs = (await getRecords("pay_period", list.slice(-16).map((r) => r.id))).filter(Boolean).map((g) => g.data);
  const users = await team();
  const who = nameOf(users);
  const per = {};
  for (const p of recs) for (const [uid, t] of Object.entries(p.totals || {})) { const o = per[uid] ||= { hours: 0, ot: 0, hourly: 0, commission: 0, tips: 0, adj: 0, total: 0 }; o.hours += t.regular_hours || 0; o.ot += t.ot_hours || 0; o.hourly += (t.hourly_cents || 0) + (t.ot_cents || 0); o.commission += t.commission_cents || 0; o.tips += t.tips_cents || 0; o.adj += t.adjustments_cents || 0; o.total += t.total_cents || 0; }
  const total = sum(Object.values(per), (o) => o.total);
  const STATUS = { open: "Open", locked: "Locked", paid: "Paid" };
  return {
    tiles: [tile("total", "Total pay", total, null, "cents"), tile("hours", "Hours", Math.round(sum(Object.values(per), (o) => o.hours) * 10) / 10, null, "hours"), tile("ot", "Overtime hours", Math.round(sum(Object.values(per), (o) => o.ot) * 10) / 10, null, "hours"), tile("tips", "Tips paid out", sum(Object.values(per), (o) => o.tips), null, "cents")],
    series: [], unit: "cents",
    tables: [
      { key: "periods", title: "Pay periods", head: ["Period", "Status", "People", "Hours", "Pay"], money: [4], links: { 0: "pay_period" }, ids: list.map((r) => r.id), rows: list.map((r) => [`${dLabel(r.s)} – ${dLabel(r.e)}`, STATUS[r.st] || r.st, r.n || 0, r.hrs || 0, r.tot || 0]) },
      { key: "people", title: "Per person (open periods: the latest worked-out totals)", head: ["Person", "Hours", "Overtime", "Hourly pay", "Commission", "Tips", "Adjustments", "Total"], money: [3, 4, 5, 6, 7], rows: Object.entries(per).sort((a, b) => b[1].total - a[1].total).map(([uid, o]) => [who(uid), Math.round(o.hours * 100) / 100, Math.round(o.ot * 100) / 100, o.hourly, o.commission, o.tips, o.adj, o.total]) },
    ],
  };
}

// → { name, from, to, group, prev, keys, labels, tiles, series, tables, unit }
export async function report(nameIn, q = {}) {
  const name = ALIAS[nameIn] || nameIn;
  if (!REPORTS.includes(name)) throw new NotFoundError("There is no such report.");
  const r = rangeOf(q);
  const base = { name, from: r.from, to: r.to, group: r.group, prev: r.prev, today: today() };
  if (name === "owed") return { ...base, keys: [], labels: [], ...(await owed()) };
  if (name === "payroll") return { ...base, keys: [], labels: [], ...(await payrollSummary(r.from, r.to)) };
  const cache = new Map();
  const [cur, prev, users] = await Promise.all([daysIn(r.from, r.to, { cache }), daysIn(r.prev.from, r.prev.to, { cache }), team()]);
  const b = buckets(cur, r.group);
  const out = name === "revenue" ? revenue(cur, prev, b) : name === "sales" ? sales(cur, prev, b, users) : name === "leads" ? leads(cur, prev, b)
    : name === "plans" ? await plans(cur, prev, b) : name === "jobs" ? jobs(cur, prev, b, users) : teamReport(cur, prev, b, users, r.days);
  return { ...base, keys: b.keys, labels: b.keys.map((k) => bucketLabel(k, r.group)), ...out };
}

// The headline numbers (GET /reports/summary): one tile of each.
export async function summary(q = {}) {
  const r = rangeOf(q);
  const cache = new Map();
  const [cur, prev, users] = await Promise.all([daysIn(r.from, r.to, { cache }), daysIn(r.prev.from, r.prev.to, { cache }), team()]);
  const b = buckets(cur, r.group);
  const pick = (o, key) => o.tiles.find((t) => t.key === key);
  const rev = revenue(cur, prev, b), sal = sales(cur, prev, b, users), ld = leads(cur, prev, b), jb = jobs(cur, prev, b, users);
  return { from: r.from, to: r.to, prev: r.prev, tiles: [pick(rev, "collected"), pick(rev, "invoiced"), pick(jb, "work"), pick(sal, "close"), pick(sal, "avg"), pick(ld, "leads"), pick(jb, "per_hour"), pick(jb, "callbacks")].filter(Boolean) };
}

// CSV of a report: each table, then the series.
export function reportCsv(rep, csvLine) {
  const out = [csvLine(["report", rep.name, "from", rep.from, "to", rep.to])];
  const cell = (t, i, v) => ((t.money || []).includes(i) && Number.isFinite(v) ? (v / 100).toFixed(2) : v === null || v === undefined ? "" : v);
  for (const t of rep.tables || []) {
    out.push("", csvLine([t.title]), csvLine(t.head));
    for (const row of t.rows) out.push(csvLine(row.map((v, i) => cell(t, i, v))));
  }
  if ((rep.series || []).length) {
    out.push("", csvLine(["Series"]), csvLine(["Period", ...rep.series.map((s) => s.label)]));
    rep.keys.forEach((k, i) => out.push(csvLine([k, ...rep.series.map((s) => (rep.unit === "cents" ? ((s.values[i] || 0) / 100).toFixed(2) : s.values[i]))])));
  }
  return out.join("\r\n") + "\r\n";
}

// reports.series (Home's charts from the rollups; services.mjs contract):
// ({ metric: "collected" | "leads", group: "week" | "month", keys }) → { since, values } | null
export async function seriesFor({ metric, group, keys } = {}) {
  if (!["collected", "leads"].includes(metric) || !["week", "month"].includes(group) || !Array.isArray(keys) || !keys.length) return null;
  const sorted = [...keys].sort();
  const from = group === "month" ? `${sorted[0]}-01` : sorted[0];
  const lastKey = sorted[sorted.length - 1];
  const to = group === "month" ? `${lastKey}-${String(daysInMonth(lastKey)).padStart(2, "0")}` : addLocalDays(lastKey, 6);
  const end = to > today() ? today() : to;
  if (end < from) return { since: null, values: {} };
  const days = await daysIn(from, end);
  const values = {};
  for (const d of days) {
    const k = group === "month" ? d.date.slice(0, 7) : bucketOf(d.date, "week");
    values[k] = (values[k] || 0) + (metric === "collected" ? d.revenue_cents : sum(Object.values(d.leads_new), (n) => n));
  }
  return { since: from, values: Object.fromEntries(keys.map((k) => [k, values[k] || 0])) };
}

export { SOLD, planSellers, sellerOf };
