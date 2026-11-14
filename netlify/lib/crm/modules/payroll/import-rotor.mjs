// Import phase 31 (design §10.2): Rotor's payroll export → pay_period +
// pay_line. Rotor groups paid lines by a payroll run (paid_at), not by a
// period, so each run becomes one paid pay_period spanning the Sunday-to-
// Saturday weeks its lines fall in, and each paid line a pay_line with its
// line_key and type kept (rotor-ops §9.2). Rotor's estimated hourly lines
// (not paid yet) are not imported: the CRM works those out itself.
//
// A line's label is "Job #0000516" (Rotor's line_label starts with the
// customer's name, which a pay sheet doesn't need). Users come from the team
// map (rotor member → CRM user); a line for a member the map doesn't know
// is skipped with a warning.

import { idForRotor, isId } from "../../core/ids.mjs";
import { localDate, addLocalDays } from "../../core/clock.mjs";
import { RowError } from "../contacts/import-rotor.mjs";
import { rotorKey } from "../contacts/display.mjs";
import { weekOf, LINE_TYPES } from "./compute.mjs";

const ROTOR_ID = /^(?!\.+$)[A-Za-z0-9_.-]{1,64}$/;
const plain = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const iso = (v) => (v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
const int = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)));
const str = (v, max = 200) => (v === null || v === undefined ? "" : String(v)).trim().slice(0, max);

export function normalizePayroll(row) {
  if (!plain(row)) throw new RowError("row");
  const id = str(row.id, 80);
  if (!ROTOR_ID.test(id)) throw new RowError("id");
  const user = str(row.user_id, 80);
  if (!ROTOR_ID.test(user)) throw new RowError("user_id");
  const paid = iso(row.paid_at);
  const status = str(row.status, 40).toLowerCase();
  const amount = int(row.amount_cents);
  if (amount === null && status === "paid") throw new RowError("amount_cents");
  const at = iso(row.event_at) || iso(row.line_period_start) || paid;
  const type = str(row.line_type, 40).toLowerCase();
  return {
    id, user, status, paid_at: paid, paid_by: str(row.paid_by_user_id, 80) || null, at,
    type: LINE_TYPES.includes(type) ? type : "adjustment", type_raw: type || null,
    line_key: str(row.line_key, 290) || `rotor:${id}`, detail: str(row.line_detail, 120),
    basis: int(row.basis_amount_cents), amount: amount || 0, hours: Number.isFinite(Number(row.hours)) && row.hours !== null ? Math.round(Number(row.hours) * 10000) / 10000 : null,
    rate_pct: Number.isFinite(Number(row.rate_percent)) && row.rate_percent !== null ? Number(row.rate_percent) : null, per_hour: int(row.rate_cents_per_hour),
    job_id: str(row.job_id, 80) || null, timesheet_id: row.timesheet_id === null || row.timesheet_id === undefined ? null : str(row.timesheet_id, 80),
    estimated: row.estimated_amount_cents !== undefined && !type,
  };
}

const runKey = (paidAt) => `run-${String(paidAt).replace(/[^0-9]/g, "").slice(0, 17)}`;

// All rows once: each paid run's weeks and its totals per person.
export async function preparePayroll(rows, ctx) {
  const runs = {};
  for (const row of rows) {
    let r;
    try { r = normalizePayroll(row); } catch { continue; }
    if (r.status !== "paid" || !r.paid_at || r.estimated) continue;
    const k = runKey(r.paid_at);
    const day = localDate(new Date(r.at || r.paid_at));
    const run = runs[k] ||= { paid_at: r.paid_at, paid_by: r.paid_by, from: day, to: day, totals: {} };
    if (day < run.from) run.from = day;
    if (day > run.to) run.to = day;
    const uid = ctx && ctx.users ? ctx.users.get(r.user) : null;
    if (!isId(uid, "user")) continue;
    const t = run.totals[uid] ||= { minutes: 0, regular_hours: 0, ot_hours: 0, hourly_cents: 0, ot_cents: 0, commission_cents: 0, tips_cents: 0, adjustments_cents: 0, total_cents: 0, model_applied: "rotor" };
    if (r.type === "hourly") { t.hourly_cents += r.amount; t.minutes += Math.round((r.hours || 0) * 60); t.regular_hours = Math.round((t.minutes / 60) * 100) / 100; }
    else if (r.type === "overtime") t.ot_cents += r.amount;
    else if (r.type.endsWith("_commission")) t.commission_cents += r.amount;
    else if (r.type === "tip") t.tips_cents += r.amount;
    else t.adjustments_cents += r.amount;
    t.total_cents += r.amount;
  }
  return { runs };
}

async function mapPayroll(r, ctx) {
  if (r.status !== "paid" || !r.paid_at || r.estimated) return { warnings: ["payroll_not_paid_skipped"] };
  const uid = ((ctx && ctx.users) || new Map()).get(r.user);
  if (!isId(uid, "user")) return { warnings: ["payroll_user_unknown"] };
  const k = runKey(r.paid_at);
  const run = (ctx.prepared && ctx.prepared.runs && ctx.prepared.runs[k]) || { paid_at: r.paid_at, paid_by: r.paid_by, from: localDate(new Date(r.at || r.paid_at)), to: localDate(new Date(r.at || r.paid_at)), totals: {} };
  const periodId = idForRotor("pay_period", k);
  const start = weekOf(run.from);
  const end = addLocalDays(weekOf(run.to), 6);
  const weeks = Math.max(1, Math.round((Date.parse(end) - Date.parse(start)) / (7 * 86400000)) + 0);
  const paidBy = (run.paid_by && ctx.users.get(run.paid_by)) || "import";
  const job = r.job_id ? await ctx.lookup("job", r.job_id) : null;
  const sheet = r.timesheet_id ? await ctx.lookup("timesheet", r.timesheet_id) : null;
  const id = idForRotor("pay_line", r.id);
  const label = r.type === "hourly" ? "Hourly pay" : r.type === "tip" ? "Tip" : /#\s*\d+/.test(r.detail) ? r.detail.replace(/^.*?(#\s*\d+).*$/, "Job $1") : r.type.replace(/_/g, " ");
  return {
    records: [
      { type: "pay_period", source: `payroll:${k}`, data: { id: periodId, start_on: start, end_on: end, weeks: Math.min(9, weeks), status: "paid", paid_at: run.paid_at, paid_by: paidBy, totals: run.totals, rotor: { run: k, paid_at: run.paid_at } } },
      { type: "pay_line", data: {
        id, user_id: uid, period_id: periodId, line_type: r.type, line_key: r.line_key, label, detail: r.type === "hourly" ? r.detail : "From Rotor's payroll",
        ...(r.basis !== null ? { basis_cents: r.basis } : {}), ...(r.rate_pct !== null ? { rate_bp: Math.max(0, Math.min(10000, Math.round(r.rate_pct * 100))) } : {}),
        ...(r.hours !== null ? { hours: r.hours } : {}), ...(r.per_hour !== null ? { rate_cents_per_hour: r.per_hour } : {}),
        amount_cents: r.amount, status: "paid", paid_at: r.paid_at, paid_by: (r.paid_by && ctx.users.get(r.paid_by)) || "import",
        source: { ...(job ? { job_id: job } : {}), ...(sheet ? { timesheet_id: sheet } : {}) },
        rotor: { payroll_line_id: r.id, line_type_raw: r.type_raw },
      } },
    ],
    pointers: [{ kind: "rotor/payline", key: rotorKey(r.id), value: { id } }],
  };
}

export const payrollPhase = { name: "payroll.payroll", entity: "payroll", after: ["system.users"], normalize: normalizePayroll, prepare: preparePayroll, map: mapPayroll };
