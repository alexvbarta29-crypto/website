// MCP module (M7c): the Rotor-compatible report tools (design §6.9).
// report_invoices, report_payments, report_jobs, report_visits and
// report_service_plans take Rotor's arguments (start, end, group_by,
// date_field) and answer Rotor's shape { range, totals, buckets }, so
// Alex's prompts ("what did we bill last month") move over unchanged.
// They read the indexes only (no record reads): a year's invoices are two
// shards, a month's payments or visits one.
//
// Money is in cents. Test (simulated) payments are left out; void and
// draft invoices are not "billed".

import { readIndex } from "../../../crm-store.mjs";
import { now, localDate, addLocalDays, isLocalDate } from "../../core/clock.mjs";
import { InputError } from "../../core/errors.mjs";

export const GROUPS = Object.freeze(["day", "week", "month", "none"]);
const MAX_DAYS = 400;

// { start, end } local dates (default: this month so far); end ≥ start, at most MAX_DAYS.
export function rangeOf(input = {}) {
  const today = localDate(now());
  const start = isLocalDate(input.start) ? input.start : today.slice(0, 8) + "01";
  const end = isLocalDate(input.end) ? input.end : today;
  if (end < start) throw new InputError("The end comes before the start.", "end");
  const days = (Date.parse(end + "T12:00:00Z") - Date.parse(start + "T12:00:00Z")) / 86400000;
  if (days > MAX_DAYS) throw new InputError("Ask for 400 days or fewer at a time.", "end");
  const group = GROUPS.includes(input.group_by) ? input.group_by : "month";
  return { start, end, group_by: group };
}
const monthsBetween = (start, end) => {
  const out = [];
  let [y, m] = start.slice(0, 7).split("-").map(Number);
  const [ey, em] = end.slice(0, 7).split("-").map(Number);
  while (y < ey || (y === ey && m <= em)) { out.push(`${y}-${String(m).padStart(2, "0")}`); m += 1; if (m > 12) { m = 1; y += 1; } }
  return out;
};
const yearsBetween = (start, end) => { const out = []; for (let y = Number(start.slice(0, 4)); y <= Number(end.slice(0, 4)); y++) out.push(String(y)); return out; };
// Monday of the date's week
const weekOf = (d) => { const dow = new Date(d + "T12:00:00Z").getUTCDay(); return addLocalDays(d, -((dow + 6) % 7)); };
const bucketKey = (d, group) => (group === "day" ? d : group === "week" ? weekOf(d) : group === "month" ? d.slice(0, 7) : "all");
const dayOf = (v) => (typeof v === "string" && v.length >= 10 ? (v.length === 10 ? v : localDate(new Date(v))) : null);

// rows → { range, totals, buckets } with add(row) → { key: number } per row
function rollup(range, rows, dateOf, add) {
  const totals = { count: 0 };
  const buckets = new Map();
  for (const r of rows) {
    const d = dateOf(r);
    if (!d || d < range.start || d > range.end) continue;
    const vals = add(r);
    if (!vals) continue;
    const k = bucketKey(d, range.group_by);
    const b = buckets.get(k) || { period: k, count: 0 };
    b.count += 1; totals.count += 1;
    for (const [f, n] of Object.entries(vals)) {
      if (typeof n !== "number") continue;
      b[f] = (b[f] || 0) + n;
      totals[f] = (totals[f] || 0) + n;
    }
    buckets.set(k, b);
  }
  return { range, totals, buckets: [...buckets.values()].sort((a, b) => a.period.localeCompare(b.period)) };
}

async function shards(name, keys) {
  const got = await Promise.all(keys.map((k) => readIndex(name, k)));
  return { rows: got.flatMap((g) => g.rows), stale: got.some((g) => g.stale) };
}

// Invoices by issue date (date_field "issued", the default) or creation ("created").
export async function reportInvoices(input = {}) {
  const range = rangeOf(input);
  const { rows, stale } = await shards("invoices", ["open", ...yearsBetween(range.start, range.end)]);
  const field = input.date_field === "created" ? "created" : "issued";
  const out = rollup(range, rows, (r) => (field === "created" ? dayOf(r.at) : dayOf(r.iss)), (r) => {
    if (r.st === "void" || r.st === "draft") return null;
    return { billed_cents: r.tot || 0, paid_cents: r.paid || 0, balance_cents: r.bal || 0, tips_cents: r.tip || 0 };
  });
  return { ...out, date_field: field, stale, note: "Billed = invoices issued in the range (not drafts or voided ones), in cents." };
}

// Payments received (succeeded), by received date; refunds counted apart; simulated (test) ones left out.
export async function reportPayments(input = {}) {
  const range = rangeOf(input);
  const { rows, stale } = await shards("payments", monthsBetween(range.start, range.end));
  const out = rollup(range, rows, (r) => dayOf(r.on), (r) => {
    if (r.sim || r.st !== "succeeded") return null;
    return { collected_cents: r.k === "refund" ? 0 : r.a || 0, tips_cents: r.tip || 0, refunded_cents: (r.k === "refund" ? r.a || 0 : 0) + (r.rf || 0), fees_cents: r.fee || 0 };
  });
  return { ...out, date_field: "received", stale, note: "Succeeded payments only; test payments are left out. Cents." };
}

// Jobs completed (date_field "completed", the default) or first visited ("scheduled").
export async function reportJobs(input = {}) {
  const range = rangeOf(input);
  const { rows, stale } = await shards("jobs", ["open", ...yearsBetween(range.start, range.end)]);
  const field = input.date_field === "scheduled" ? "scheduled" : "completed";
  const out = rollup(range, rows, (r) => (field === "scheduled" ? dayOf(r.fv || r.nv) : dayOf(r.done)), (r) => {
    if (r.st === "cancelled") return null;
    if (field === "completed" && r.st !== "completed") return null;
    return { total_cents: r.tot || 0, billable: r.bill ? 1 : 0 };
  });
  return { ...out, date_field: field, stale };
}

// Visits by date, with a count per status.
export async function reportVisits(input = {}) {
  const range = rangeOf(input);
  const { rows, stale } = await shards("visits", monthsBetween(range.start, range.end));
  const out = rollup(range, rows, (r) => r.d, (r) => ({ [`status_${r.st}`]: 1 }));
  return { ...out, date_field: "date", stale };
}

// Plans started in the range (by when they were made), by status.
export async function reportServicePlans(input = {}) {
  const range = rangeOf(input);
  const ix = await readIndex("plans", "");
  const out = rollup(range, ix.rows, (r) => dayOf(r.at), (r) => ({ [`status_${r.st}`]: 1, sale_value_cents: r.sv || 0 }));
  const active = ix.rows.filter((r) => r.st === "active").length;
  return { ...out, date_field: "created", stale: ix.stale, active_now: active };
}
