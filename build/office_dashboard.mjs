#!/usr/bin/env node
// Turn a folder of raw Rotor report results into the office dashboard's
// snapshot, and seal it for the public repo (docs/DASHBOARD.md).
//
//   node build/office_dashboard.mjs raw.json            # seal into netlify/data/
//   node build/office_dashboard.mjs raw.json --print    # just print the snapshot
//
// raw.json holds Rotor's own report outputs, one per key (the exact queries
// are listed in docs/DASHBOARD.md). It has customer details in it, so keep it
// out of the repo; only the sealed, aggregate-only snapshot is committed.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { seal } from "../netlify/lib/office-data.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dollars = (cents) => Math.round(Number(cents || 0)) / 100;
const buckets = (r) => (r && Array.isArray(r.buckets) ? r.buckets : []);
const byKey = (r) => Object.fromEntries(buckets(r).map((b) => [b.key, b]));
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (key) => MONTHS[Number(key.slice(5, 7)) - 1];
const weekLabel = (key) => `${MONTHS[Number(key.slice(5, 7)) - 1]} ${Number(key.slice(8, 10))}`;

// Group small or messy source names so the chart reads cleanly.
const LEAD_SOURCE = { "Referral Program": "Referral", "Referral program": "Referral", "Website quote form": "Website", "Facebook Messenger": "Facebook", Email: "Other" };
const CUSTOMER_SOURCE = { "Website quote form": "Website", "Family / Friends": "Referral", "Door Hanger": "Door to door", "Door to Door": "Door to door", "Yard Sign": "Signs", Signage: "Signs" };
const NOT_NEW = new Set(["Returning Customer", "Markate Import", "Test", ""]);

function grouped(r, map, skip = new Set(), minShare = 0.02) {
  const out = {};
  let total = 0;
  for (const b of buckets(r)) {
    if (skip.has(b.key)) continue;
    const k = map[b.key] || b.key;
    out[k] = (out[k] || 0) + b.count;
    total += b.count;
  }
  let rows = Object.entries(out).map(([label, value]) => ({ label, value }));
  const small = rows.filter((x) => x.label !== "Other" && x.value / total < minShare);
  if (small.length) {
    const other = rows.find((x) => x.label === "Other") || { label: "Other", value: 0 };
    other.value += small.reduce((s, x) => s + x.value, 0);
    rows = rows.filter((x) => !small.includes(x) && x.label !== "Other").concat(other);
  }
  return rows.sort((a, b) => (a.label === "Other") - (b.label === "Other") || b.value - a.value);
}

export function buildSnapshot(raw) {
  const asOf = raw.as_of;
  const year = Number(asOf.slice(0, 4));

  // Revenue: money collected (Rotor payments), this year vs last.
  const cur = byKey(raw.payments_by_month);
  const prev = byKey(raw.payments_by_month_prev);
  const monthly = buckets(raw.payments_by_month).map((b) => {
    const lastYearKey = `${Number(b.key.slice(0, 4)) - 1}${b.key.slice(4)}`;
    return { key: b.key, label: monthLabel(b.key), cur: dollars(b.sum_cents), prev: dollars(prev[lastYearKey]?.sum_cents), jobs: b.count };
  });
  const ytdType = byKey(raw.payments_ytd_by_type);
  const ytdPrevType = byKey(raw.payments_ytd_by_type_prev);
  const collectedYtd = dollars(ytdType.invoice?.sum_cents);
  const collectedYtdPrev = dollars(ytdPrevType.invoice?.sum_cents);
  const paymentsYtd = ytdType.invoice?.count || 0;
  const weekly = buckets(raw.payments_by_week).map((b) => ({ key: b.key, label: weekLabel(b.key), value: dollars(b.sum_cents), count: b.count }));
  const thisMonth = cur[asOf.slice(0, 7)] || { sum_cents: 0, count: 0 };

  // Sales: leads, quotes, close rate.
  const leadsWeekly = buckets(raw.leads_by_week).map((b) => ({ key: b.key, label: weekLabel(b.key), value: b.count }));
  const q = raw.quotes_by_status || {};
  const won = (q.approved || 0) + (q.converted || 0);
  const answered = won + (q.rejected || 0) + (q.modification_requested || 0);
  const outForAnswer = q.sent || 0;
  const decided = answered + outForAnswer;
  const closeRate = decided ? won / decided : 0;

  // Plans: active agreements in Rotor (one-time jobs are agreements too).
  const plans = (raw.service_plans_active && raw.service_plans_active.data) || [];
  const names = Object.fromEntries((raw.members || []).map((m) => [m.user_id, m.name.split(" ")[0]]));
  const FREQ = { "Semi-Annual": "Biannual", Quarterly: "Quarterly", Monthly: "Monthly", Annual: "Christmas lights" };
  const mix = {};
  const reps = {};
  let recurring = 0;
  let recurringValue = 0;
  for (const p of plans) {
    const f = p.service_frequency || "One-Time";
    const rep = names[p.sold_by] || "Not set";
    reps[rep] = (reps[rep] || 0) + 1;
    if (f === "One-Time") continue;
    const label = FREQ[f] || f;
    mix[label] = mix[label] || { label, value: 0, worth: 0 };
    mix[label].value += 1;
    mix[label].worth += Number(p.sale_value || 0);
    recurring += 1;
    recurringValue += Number(p.sale_value || 0);
  }
  const planMix = Object.values(mix).sort((a, b) => b.value - a.value).map((x) => ({ ...x, worth: Math.round(x.worth) }));
  const repRows = Object.entries(reps).map(([label, value]) => ({ label, value })).sort((a, b) => (a.label === "Not set") - (b.label === "Not set") || b.value - a.value);

  // Operations: jobs, visits, invoices.
  const JOB_ORDER = ["Pending", "Scheduled", "In Progress", "Completed", "Cancelled"];
  const jobs = byKey(raw.jobs_by_status);
  const jobRows = JOB_ORDER.filter((k) => jobs[k]).map((k) => ({ label: k === "Pending" ? "Not scheduled yet" : k, value: jobs[k].count }));
  const inv = byKey(raw.invoices_by_status);
  const amt = (k) => dollars(inv[k]?.sum_cents);
  const cnt = (k) => inv[k]?.count || 0;
  const owed = { count: cnt("open") + cnt("sent") + cnt("overdue") + cnt("partially_paid"), amount: amt("open") + amt("sent") + amt("overdue") + amt("partially_paid") };
  const visitsNext = buckets(raw.visits_next_weeks).map((b) => ({ key: b.key, label: `Week of ${weekLabel(b.key)}`, value: b.count }));
  const visitsMonthly = buckets(raw.visits_by_month).map((b) => ({ key: b.key, label: monthLabel(b.key), value: b.count }));

  // What to act on, biggest money first.
  const todo = [];
  if (cnt("draft")) todo.push({ level: "serious", title: `${cnt("draft")} invoices still in draft`, detail: `$${Math.round(amt("draft")).toLocaleString("en-US")} not sent to customers yet`, href: "https://app.getrotor.com" });
  if (cnt("overdue") || cnt("failed")) todo.push({ level: "critical", title: `${cnt("overdue") + cnt("failed")} overdue or failed payments`, detail: `$${Math.round(amt("overdue") + amt("failed")).toLocaleString("en-US")} to chase`, href: "https://app.getrotor.com" });
  if (outForAnswer) todo.push({ level: "warning", title: `${outForAnswer} quotes waiting on an answer`, detail: "Follow up with the estimate playbook", href: "https://app.getrotor.com" });
  if (q.draft) todo.push({ level: "warning", title: `${q.draft} quotes never sent`, detail: "Drafts sitting in Rotor", href: "https://app.getrotor.com" });
  if (jobs.Pending?.count) todo.push({ level: "warning", title: `${jobs.Pending.count} jobs not scheduled`, detail: "Sold work without a date", href: "https://app.getrotor.com" });

  return {
    v: 1,
    as_of: asOf,
    year,
    revenue: {
      collected_ytd: collectedYtd,
      collected_ytd_prev: collectedYtdPrev,
      refunds_ytd: dollars(ytdType.refund?.sum_cents),
      payments_ytd: paymentsYtd,
      avg_ticket: paymentsYtd ? Math.round(collectedYtd / paymentsYtd) : 0,
      this_month: dollars(thisMonth.sum_cents),
      this_month_label: monthLabel(asOf.slice(0, 7)),
      monthly,
      weekly,
    },
    sales: {
      leads_total: raw.leads_by_source?.totals?.count || leadsWeekly.reduce((s, x) => s + x.value, 0),
      leads_weekly: leadsWeekly,
      lead_sources: grouped(raw.leads_by_source, LEAD_SOURCE),
      customer_sources: grouped(raw.customers_by_source, CUSTOMER_SOURCE, NOT_NEW),
      quotes: { sent: outForAnswer, won, rejected: q.rejected || 0, changes: q.modification_requested || 0, draft: q.draft || 0 },
      close_rate: Math.round(closeRate * 1000) / 10,
    },
    plans: {
      active_agreements: plans.length,
      recurring,
      recurring_value: Math.round(recurringValue),
      recurring_share: plans.length ? Math.round((recurring / plans.length) * 100) : 0,
      mix: planMix,
      by_rep: repRows,
      created_monthly: buckets(raw.plans_created_by_month).map((b) => ({ key: b.key, label: monthLabel(b.key), value: b.count })),
      cancelled_12m: raw.plan_cancellations?.totals?.count || 0,
    },
    ops: {
      jobs: jobRows,
      jobs_unscheduled: jobs.Pending?.count || 0,
      visits_next: visitsNext,
      visits_this_week: visitsNext[0]?.value || 0,
      visits_monthly: visitsMonthly,
      owed,
      draft_invoices: { count: cnt("draft"), amount: amt("draft") },
      overdue: { count: cnt("overdue") + cnt("failed"), amount: amt("overdue") + amt("failed") },
    },
    todo,
    targets: { close_rate: [40, 50], avg_ticket: 300, recurring_share: 50 },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const file = process.argv[2];
  if (!file) { console.error("usage: node build/office_dashboard.mjs raw.json [--print]"); process.exit(1); }
  const snap = buildSnapshot(JSON.parse(readFileSync(file, "utf8")));
  if (process.argv.includes("--print")) { console.log(JSON.stringify(snap, null, 2)); process.exit(0); }
  const pub = readFileSync(path.join(ROOT, "build/office-dashboard-public.pem"), "utf8");
  const out = path.join(ROOT, "netlify/data/office-dashboard.sealed.mjs");
  writeFileSync(out, `// Encrypted office dashboard snapshot (docs/DASHBOARD.md). Written by\n// build/office_dashboard.mjs; only the site's server can open it.\nexport default ${JSON.stringify(seal(snap, pub))};\n`);
  console.log(`sealed snapshot as of ${snap.as_of} -> ${path.relative(ROOT, out)}`);
}
