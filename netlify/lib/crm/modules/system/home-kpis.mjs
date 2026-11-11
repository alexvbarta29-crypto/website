// Home's numbers (design §9.2 "Today" for owners, §5.9 KPI definitions;
// industry spec 13.1 "Owner dashboard"): the month's KPI tiles and the
// Money, Sales, Plans and Jobs cards with their charts. Pure: no I/O, no
// clock (callers pass today, a local YYYY-MM-DD).
//
// Each number comes from the CRM's own records once they cover the
// business (a finished Rotor import, or the CRM is the system of record),
// else from the office dashboard's sealed Rotor snapshot
// (build/office_dashboard.mjs, docs/DASHBOARD.md), labelled "From Rotor ·
// updated <date>" on screen. The CRM keeps no money yet (Money, M5) and no
// lead counts per week (Reports, M7b): those stay Rotor's until a provider
// gives them, and a provider's series takes over only from the day its
// data starts (mergeSeries), the snapshot filling the weeks and months
// before. Nothing here invents a zero: a number nobody has is left out.
//
//   rotorNumbers(snapshot, today)   the snapshot as Home reads it
//   crmNumbers({ today, ... rows }) the same numbers from index rows
//   homeKpis({ rotor, crm, today }) → { tiles, money, sales, plans, jobs, source }

import { addLocalDays, dowOfDate, localDate, isLocalDate } from "../../core/clock.mjs";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DEAD_VISIT = new Set(["cancelled", "no_access"]);
export const TARGETS = Object.freeze({ close_rate: [40, 50], avg_ticket_cents: 30000 });

const num = (v) => (v === null || v === undefined || v === "" || typeof v === "boolean" || !Number.isFinite(Number(v)) ? null : Number(v));
const list = (v) => (Array.isArray(v) ? v : []);
// the snapshot keeps dollars (two decimals at most); Home works in cents like the rest of the CRM
export const toCents = (dollars) => (num(dollars) === null ? null : Math.round(Number(dollars) * 100));
export const monthLabel = (key) => MONTHS[Number(String(key).slice(5, 7)) - 1] || "";
export const weekLabel = (key) => `${monthLabel(key)} ${Number(String(key).slice(8, 10))}`;
// the Monday of a local date's week (Rotor's weeks start on Monday)
export const weekStart = (date) => addLocalDays(date, -((dowOfDate(date) + 6) % 7));
const sum = (xs) => xs.reduce((a, x) => a + (num(x) || 0), 0);
// "$80,390" (whole dollars, for a note under a number)
export const dollars = (cents) => "$" + Math.round((num(cents) || 0) / 100).toLocaleString("en-US");

// ------------------------------------------------------------ Rotor

// The snapshot (build/office_dashboard.mjs buildSnapshot) as Home reads it.
// A snapshot from an earlier month says which month its "this month" is.
export function rotorNumbers(snap, today) {
  if (!snap || typeof snap !== "object" || !isLocalDate(snap.as_of)) return null;
  const R = snap.revenue || {}, S = snap.sales || {}, P = snap.plans || {}, O = snap.ops || {};
  const asOf = snap.as_of;
  const month = asOf.slice(0, 7);
  const monthRow = list(R.monthly).find((m) => m && m.key === month) || null;
  const leads = list(S.leads_weekly).filter((w) => w && isLocalDate(w.key)).map((w) => ({ key: w.key, label: weekLabel(w.key), value: num(w.value) || 0 }));
  const last = leads[leads.length - 1] || null;
  const q = S.quotes || {};
  return {
    as_of: asOf,
    month: { key: month, label: monthLabel(month), current: month === today.slice(0, 7), through: Number(asOf.slice(8, 10)) },
    collected_month: toCents(R.this_month),
    paid_jobs_month: monthRow ? num(monthRow.jobs) : null,
    collected_ytd: toCents(R.collected_ytd),
    collected_ytd_prev: toCents(R.collected_ytd_prev),
    year: num(snap.year) || Number(asOf.slice(0, 4)),
    avg_ticket: toCents(R.avg_ticket),
    close_rate: num(S.close_rate),
    quotes: { out: num(q.sent), won: num(q.won), lost: num(q.rejected), changes: num(q.changes) },
    active_plans: num(P.recurring),
    plans_worth: toCents(P.recurring_value),
    recurring_share: num(P.recurring_share),
    plan_mix: list(P.mix).filter((m) => m && m.label).map((m) => ({ label: String(m.label), value: num(m.value) || 0 })),
    leads,
    leads_week: last ? { value: last.value, key: last.key, current: last.key === weekStart(today) } : null,
    leads_4w: leads.length ? sum(leads.slice(-4).map((w) => w.value)) : null,
    weekly: list(R.weekly).filter((w) => w && isLocalDate(w.key)).map((w) => ({ key: w.key, label: weekLabel(w.key), value: toCents(w.value) || 0 })),
    monthly: list(R.monthly).filter((m) => m && /^\d{4}-\d{2}$/.test(m.key)).map((m) => ({ key: m.key, label: monthLabel(m.key), cur: toCents(m.cur) || 0, prev: toCents(m.prev) || 0 })),
    visits_next: list(O.visits_next).filter((v) => v && isLocalDate(v.key)).map((v) => ({ key: v.key, label: weekLabel(v.key), value: num(v.value) || 0 })),
    jobs_unscheduled: num(O.jobs_unscheduled),
  };
}

// ------------------------------------------------------------ the CRM

const PLAN_LABEL = { biannual: "Biannual", quarterly: "Quarterly", monthly: "Monthly", lights_annual: "Christmas lights", custom: "Custom" };
const LIVE_PLAN = new Set(["active", "cancelling"]);
const localOf = (iso) => { const t = Date.parse(iso || ""); return Number.isFinite(t) ? localDate(new Date(t)) : ""; };

// The same numbers from the CRM's index rows (§5.9): jobs (open and this
// year's closed shard), quotes (open and this year's), plans, the visits
// of the next four weeks. Average ticket = work completed ÷ billable jobs
// completed (this year); close rate = quotes won ÷ (won + lost), closed
// this year (a quote archived after it was sent counts as lost).
export function crmNumbers({ today, jobsYear = [], jobsOpen = [], quotesOpen = [], quotesYear = [], plans = [], visits = [] }) {
  const month = today.slice(0, 7), year = today.slice(0, 4);
  const done = jobsYear.filter((r) => r && r.st === "completed" && r.bill !== false && r.done);
  const doneYear = done.filter((r) => localOf(r.done).slice(0, 4) === year);
  const doneMonth = doneYear.filter((r) => localOf(r.done).slice(0, 7) === month);
  const closedYear = quotesYear.filter((r) => r && localOf(r.u || r.at).slice(0, 4) === year);
  const won = quotesOpen.filter((r) => r && r.st === "approved").length + closedYear.filter((r) => r.st === "converted").length;
  const lost = closedYear.filter((r) => r.st === "declined" || (r.st === "archived" && r.sent)).length;
  const live = plans.filter((r) => r && LIVE_PLAN.has(r.st));
  const mix = new Map();
  for (const p of live) { const l = PLAN_LABEL[p.ck] || (p.k === "lights_annual" ? "Christmas lights" : "Other"); mix.set(l, (mix.get(l) || 0) + 1); }
  const mon = weekStart(today);
  const weeks = [0, 1, 2, 3].map((i) => addLocalDays(mon, i * 7));
  const visitsNext = weeks.map((w) => {
    const end = addLocalDays(w, 6);
    return { key: w, label: weekLabel(w), value: visits.filter((v) => v && !DEAD_VISIT.has(v.st) && v.d >= w && v.d <= end).length };
  });
  return {
    jobs_month: doneMonth.length,
    avg_ticket: doneYear.length ? Math.round(sum(doneYear.map((r) => r.tot)) / doneYear.length) : null,
    close_rate: won + lost ? Math.round((won / (won + lost)) * 1000) / 10 : null,
    quotes: { out: quotesOpen.filter((r) => r && (r.st === "sent" || r.st === "viewed")).length, won, lost, changes: quotesOpen.filter((r) => r && r.st === "changes_requested").length },
    active_plans: live.length,
    plans_worth: sum(live.map((r) => r.sv)),
    plan_mix: [...mix.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value || a.label.localeCompare(b.label)),
    visits_next: visitsNext,
    jobs_unscheduled: jobsOpen.filter((r) => r && r.st === "unscheduled").length,
  };
}

// A provider's series over Rotor's: from the day the provider's data
// starts (`since`, a local date) its values win; the snapshot keeps the
// weeks or months before it. rows: Rotor's [{ key, label, ...value }];
// values: { key → value } from the provider. → rows with `source` each.
export function mergeSeries(rows, provider, field = "value") {
  if (!provider || !isLocalDate(provider.since) || !provider.values) return rows.map((r) => ({ ...r, source: "rotor" }));
  return rows.map((r) => {
    const startsOn = /^\d{4}-\d{2}$/.test(r.key) ? `${r.key}-01` : r.key;
    const v = provider.values[r.key];
    return startsOn >= provider.since && num(v) !== null ? { ...r, [field]: num(v), source: "crm" } : { ...r, source: "rotor" };
  });
}

// ------------------------------------------------------------ the tiles and cards

// One number from the CRM when it has it, else from Rotor, else nothing.
const pick = (crm, rotor, key) => (crm && num(crm[key]) !== null ? { v: num(crm[key]), source: "crm" } : rotor && num(rotor[key]) !== null ? { v: num(rotor[key]), source: "rotor" } : null);
const delta = (cur, prev) => (num(prev) > 0 && num(cur) !== null ? Math.round(((cur - prev) / prev) * 100) : null);

// → { tiles: [{ key, label, value, fmt, note, delta?, source, view, target? }],
//     money, sales, plans, jobs (each { source, ... } | null), source: { rotor, crm } }
export function homeKpis({ rotor = null, crm = null, today, extra = {} }) {
  const tiles = [];
  const add = (t) => { if (t && t.value !== null && t.value !== undefined) tiles.push(t); };
  const m = rotor && rotor.month;
  const span = m ? (m.through > 1 ? `${m.label} 1–${m.through}` : `${m.label} 1`) : "";
  if (rotor && rotor.collected_month !== null) {
    add({ key: "collected_month", label: m.current ? "Collected this month" : `Collected in ${m.label}`, value: rotor.collected_month, fmt: "money", note: span, source: "rotor", view: "money" });
  }
  if (rotor && rotor.collected_ytd !== null) {
    const d = delta(rotor.collected_ytd, rotor.collected_ytd_prev);
    add({ key: "collected_ytd", label: "Collected this year", value: rotor.collected_ytd, fmt: "money", source: "rotor", view: "money",
      delta: d === null ? null : { pct: d, up: d >= 0, vs: `vs ${rotor.year - 1}` }, note: rotor.collected_ytd_prev ? null : "first year in Rotor" });
  }
  const jobs = crm ? { v: crm.jobs_month, source: "crm" } : rotor && rotor.paid_jobs_month !== null ? { v: rotor.paid_jobs_month, source: "rotor" } : null;
  if (jobs) add({ key: "jobs_month", label: "Jobs completed", value: jobs.v, fmt: "count", source: jobs.source, view: "jobs", note: jobs.source === "crm" ? `${monthLabelOf(today)} so far` : `paid, ${span}` });
  const avg = pick(crm, rotor, "avg_ticket");
  if (avg) add({ key: "avg_ticket", label: "Average ticket", value: avg.v, fmt: "money", source: avg.source, view: "money", note: "this year, goal $300+", target: { ok: avg.v >= TARGETS.avg_ticket_cents } });
  const close = pick(crm, rotor, "close_rate");
  if (close) add({ key: "close_rate", label: "Close rate", value: close.v, fmt: "pct", source: close.source, view: "sales", note: "goal 40–50%", target: { ok: close.v >= TARGETS.close_rate[0] } });
  const plans = pick(crm, rotor, "active_plans");
  if (plans) {
    const worth = plans.source === "crm" ? crm.plans_worth : rotor.plans_worth;
    add({ key: "active_plans", label: "Active plans", value: plans.v, fmt: "count", source: plans.source, view: "plans", note: num(worth) ? `${dollars(worth)} on the books` : null });
  }
  if (rotor && rotor.leads_week) {
    add({ key: "leads_week", label: "New leads", value: rotor.leads_week.value, fmt: "count", source: "rotor", view: "sales", note: rotor.leads_week.current ? "this week" : `week of ${weekLabel(rotor.leads_week.key)}` });
  }
  const out = crm ? { v: crm.quotes.out, source: "crm" } : rotor && num(rotor.quotes.out) !== null ? { v: rotor.quotes.out, source: "rotor" } : null;
  if (out) add({ key: "quotes_out", label: "Quotes out", value: out.v, fmt: "count", source: out.source, view: "sales", note: "waiting on an answer" });

  const money = rotor && (rotor.weekly.length || rotor.monthly.length) ? {
    source: "rotor",
    weekly: mergeSeries(rotor.weekly, extra.weekly || null),
    monthly: mergeSeries(rotor.monthly, extra.monthly || null, "cur"),
    year: rotor.year,
  } : null;
  const quotes = crm ? crm.quotes : rotor ? rotor.quotes : null;
  const sales = rotor || crm ? {
    source: crm ? "crm" : "rotor",
    leads: rotor ? mergeSeries(rotor.leads, extra.leads || null) : [],
    leads_4w: rotor ? rotor.leads_4w : null,
    close_rate: close ? close.v : null,
    quotes,
  } : null;
  const planSrc = crm || rotor;
  const plansCard = planSrc ? { source: crm ? "crm" : "rotor", active: planSrc.active_plans, worth: planSrc.plans_worth, mix: planSrc.plan_mix || [], recurring_share: crm ? null : rotor.recurring_share } : null;
  const jobsCard = crm || rotor ? {
    source: crm ? "crm" : "rotor",
    done_month: jobs ? jobs.v : null,
    unscheduled: crm ? crm.jobs_unscheduled : rotor.jobs_unscheduled,
    visits_next: crm ? crm.visits_next : rotor.visits_next,
  } : null;
  return {
    tiles, money, sales, plans: plansCard, jobs: jobsCard,
    source: { rotor: rotor ? { as_of: rotor.as_of } : null, crm: !!crm },
  };
}

const monthLabelOf = (date) => monthLabel(date.slice(0, 7));
