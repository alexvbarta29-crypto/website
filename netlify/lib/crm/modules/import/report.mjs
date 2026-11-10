// The reconciliation report and the id map (design §10.8, §10.3).
//
// imp/{runId}/report (JSON) and its CSV, written when a run finishes:
//   - counts per phase: Rotor rows read; CRM records created / updated /
//     unchanged / linked / conflicted, skipped with the reason (invalid row,
//     taken pointer, ...), and the phases waiting for a module with how
//     many staged rows wait for it;
//   - money, Rotor's side, from the staged rows (Σ invoice total_cents by
//     status; Σ payments by method, type and year, refunds and tips), so the
//     owner can compare with Rotor's own reports; the CRM's side arrives
//     with Money (M5);
//   - integrity: taken pointers, payments with no invoice, timers still
//     running, visits whose job isn't in the export;
//   - data quality: every warning code the mappers raised (phones fixed or
//     rejected, states repaired, ...), suppressions, merge candidates;
//   - pass/fail: no unresolved conflict (money: once Money ships).
// Counts and codes only: the report holds no name, phone, email or address.
//
// The id map: every ptr/rotor/{type}/{rotorId} → CRM id, written in parts
// imp/{runId}/idmap/{nnnn} at the end of the run and served as one CSV
// (an owner download, audited).

import { getRaw, putRaw, listKeys } from "../../../crm-store.mjs";
import { nowIso } from "../../core/clock.mjs";
import { typeOf } from "../../core/ids.mjs";
import { csvCell } from "../../../referral-lib.mjs";
import { MODULE_LABELS, phaseLabel } from "./catalog.mjs";
import { readChunk } from "./staging.mjs";

export const IDMAP_BATCH = 500;
export const reportKey = (runId) => `imp/${runId}/report`;
export const idmapPrefix = (runId) => `imp/${runId}/idmap/`;
export const idmapKey = (runId, n) => `imp/${runId}/idmap/${String(n).padStart(4, "0")}`;
export const conflictsPrefix = (runId) => `imp/${runId}/conflicts/`;

const inc = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };
const sumRecords = (st, k) => Object.values(st.records || {}).reduce((s, r) => s + (r[k] || 0), 0);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// Every staged row of an entity (the report's money and integrity sums).
async function* stagedRows(runId, state, entity) {
  for (const n of state.chunks[entity] || []) {
    const c = await readChunk(runId, entity, n);
    for (const row of (c && c.rows) || []) yield row;
  }
}

// Rotor's money, from the staged invoices and payments. Pure over rows.
export async function moneyFromRows(invoices, payments) {
  const inv = { count: 0, total_cents: 0, by_status: {} };
  for await (const r of invoices) {
    if (!r || typeof r !== "object") continue;
    const s = String(r.status || "unknown").slice(0, 30);
    inv.count += 1;
    inv.total_cents += num(r.total_cents);
    const b = (inv.by_status[s] ||= { count: 0, cents: 0 });
    b.count += 1; b.cents += num(r.total_cents);
  }
  const pay = { count: 0, net_cents: 0, tips_cents: 0, refunds_cents: 0, failed: 0, unlinked: 0, by_method: {}, by_type: {}, by_year: {} };
  for await (const r of payments) {
    if (!r || typeof r !== "object") continue;
    pay.count += 1;
    if (String(r.status) === "failed") { pay.failed += 1; continue; }
    const amount = num(r.total_amount_cents) - num(r.tip_cents);
    const type = String(r.payment_type || "invoice").slice(0, 20);
    if (type === "refund") pay.refunds_cents += num(r.total_amount_cents);
    else pay.net_cents += amount;
    pay.tips_cents += num(r.tip_cents);
    if (!r.invoice_id) pay.unlinked += 1;
    inc(pay.by_method, String(r.payment_method || "unknown").slice(0, 30), amount);
    inc(pay.by_type, type, num(r.total_amount_cents));
    const y = String(r.payment_date || r.created_at || "").slice(0, 4);
    if (/^\d{4}$/.test(y)) inc(pay.by_year, y, amount);
  }
  return { invoices: inv, payments: pay };
}

export async function buildReport(runId, state) {
  const as_of = state.as_of || null;
  const phases = [];
  const quality = {};
  const totals = { read: 0, created: 0, updated: 0, unchanged: 0, linked: 0, conflicted: 0, skipped: 0, kept_fields: 0 };
  const waiting = [];
  let pointersTaken = 0, suppressed = 0, candidates = 0;
  for (const p of state.plan) {
    const st = state.phases[p.name] || {};
    const stagedRowsCount = state.rows && state.rows[p.entity] != null ? state.rows[p.entity] : null;
    const row = {
      name: p.name, label: phaseLabel(p.name), module: p.module, entity: p.entity, status: st.status || "pending", waiting_for: st.waiting_for || null,
      read: st.read || 0, records: st.records || {}, skipped: st.skipped || {}, pointers: st.pointers || {}, extras: st.extras || {}, warnings: st.warnings || {},
      errors: (st.errors || []).slice(0, 20), kept_fields: st.kept_fields || 0,
    };
    phases.push(row);
    totals.read += row.read;
    for (const k of ["created", "updated", "unchanged", "conflicted"]) totals[k] += sumRecords(st, k);
    totals.linked += sumRecords(st, "linked") + sumRecords(st, "relinked");
    totals.skipped += Object.values(row.skipped).reduce((s, n) => s + n, 0);
    totals.kept_fields += row.kept_fields;
    for (const [code, n] of Object.entries(row.warnings)) inc(quality, code, n);
    pointersTaken += (row.pointers && row.pointers.taken) || 0;
    suppressed += (row.extras && row.extras.suppressed) || 0;
    candidates += (row.extras && row.extras.candidates) || 0;
    if (row.status === "waiting") waiting.push({ phase: p.name, label: row.label, module: p.module, module_label: MODULE_LABELS[st.waiting_for] || MODULE_LABELS[p.module] || null, waiting_for: st.waiting_for || p.module, entity: p.entity, chunks: (state.chunks[p.entity] || []).length, rows: stagedRowsCount });
  }
  // Rotor's money and the integrity counts, from the staged rows
  const money = await moneyFromRows(stagedRows(runId, state, "invoices"), stagedRows(runId, state, "payments"));
  const integrity = { pointers_taken: pointersTaken, payments_without_invoice: money.payments.unlinked, timers_running: 0, visits_without_job: 0 };
  for await (const t of stagedRows(runId, state, "visit_timers")) if (t && (t.is_active === true || (t.start && !t.end))) integrity.timers_running += 1;
  const jobIds = new Set();
  for await (const j of stagedRows(runId, state, "jobs")) if (j && j.id) jobIds.add(String(j.id));
  for await (const v of stagedRows(runId, state, "visits")) if (v && v.job_id && !jobIds.has(String(v.job_id))) integrity.visits_without_job += 1;
  const conflictsOpen = (await listKeys(conflictsPrefix(runId))).length;
  const summary = {
    ...totals, conflicts_open: conflictsOpen, phases: state.plan.length,
    phases_done: phases.filter((p) => p.status === "done" || p.status === "empty").length, phases_waiting: waiting.length,
    suppressed, merge_candidates: candidates, pass: conflictsOpen === 0, money_checked: false,
  };
  const report = {
    v: 1, run_id: runId, as_of, generated_at: nowIso(), summary, phases, waiting,
    money: { rotor: money, crm: null, note: "The CRM's side of the money comparison arrives with Money (M5)." },
    integrity, quality: { warnings: quality, suppressions: suppressed, merge_candidates: candidates },
  };
  await putRaw(reportKey(runId), report);
  return report;
}

export async function readReport(runId, opts = {}) {
  const got = await getRaw(reportKey(runId), opts);
  return got && got.data ? got.data : null;
}

const csvLine = (cells) => cells.map((c) => csvCell(c === null || c === undefined ? "" : typeof c === "object" ? JSON.stringify(c) : c)).join(",");

// The report as CSV: section, phase, metric, value (one fact a line).
export function reportCsv(report) {
  const lines = [csvLine(["section", "phase", "metric", "value"])];
  const s = report.summary || {};
  for (const [k, v] of Object.entries(s)) lines.push(csvLine(["summary", "", k, v]));
  for (const p of report.phases || []) {
    lines.push(csvLine(["phase", p.name, "status", p.status]));
    lines.push(csvLine(["phase", p.name, "read", p.read]));
    for (const [type, counts] of Object.entries(p.records || {})) for (const [k, v] of Object.entries(counts)) lines.push(csvLine(["phase", p.name, `${type}.${k}`, v]));
    for (const [k, v] of Object.entries(p.skipped || {})) lines.push(csvLine(["phase", p.name, `skipped.${k}`, v]));
    for (const [k, v] of Object.entries(p.warnings || {})) lines.push(csvLine(["phase", p.name, `warning.${k}`, v]));
    if (p.waiting_for) lines.push(csvLine(["phase", p.name, "waiting_for", p.waiting_for]));
  }
  const m = (report.money && report.money.rotor) || {};
  if (m.invoices) {
    lines.push(csvLine(["money", "rotor", "invoices.count", m.invoices.count]));
    lines.push(csvLine(["money", "rotor", "invoices.total_cents", m.invoices.total_cents]));
    for (const [st, b] of Object.entries(m.invoices.by_status || {})) lines.push(csvLine(["money", "rotor", `invoices.${st}.cents`, b.cents]));
  }
  if (m.payments) {
    for (const k of ["count", "net_cents", "tips_cents", "refunds_cents", "failed", "unlinked"]) lines.push(csvLine(["money", "rotor", `payments.${k}`, m.payments[k]]));
    for (const g of ["by_method", "by_type", "by_year"]) for (const [k, v] of Object.entries(m.payments[g] || {})) lines.push(csvLine(["money", "rotor", `payments.${g}.${k}`, v]));
  }
  for (const [k, v] of Object.entries(report.integrity || {})) lines.push(csvLine(["integrity", "", k, v]));
  for (const [k, v] of Object.entries((report.quality && report.quality.warnings) || {})) lines.push(csvLine(["quality", "", k, v]));
  return lines.join("\r\n") + "\r\n";
}

// ------------------------------------------------------------ the id map

const PTR_RE = /^ptr\/rotor\/([a-z0-9_-]{1,40})\/(.+)$/;

// One part of the id map: the pointers in `keys` → [rotor type, Rotor id, CRM id, CRM type].
export async function buildIdMapPart(runId, n, keys) {
  const vals = [];
  for (let i = 0; i < keys.length; i += 16) {
    vals.push(...await Promise.all(keys.slice(i, i + 16).map(async (k) => {
      const m = PTR_RE.exec(k);
      if (!m) return null;
      const got = await getRaw(k);
      const id = got && got.data && typeof got.data.id === "string" ? got.data.id : null;
      return id ? [m[1], m[2], id, typeOf(id) || ""] : null;
    })));
  }
  await putRaw(idmapKey(runId, n), { rows: vals.filter(Boolean), at: nowIso() });
}

export async function idMapCsv(runId, opts = {}) {
  const parts = (await listKeys(idmapPrefix(runId), {}, opts)).sort();
  const lines = [csvLine(["rotor_type", "rotor_id", "crm_id", "crm_type"])];
  const got = await Promise.all(parts.map((k) => getRaw(k, opts)));
  for (const g of got) for (const r of (g && g.data && g.data.rows) || []) lines.push(csvLine(r));
  return { csv: lines.join("\r\n") + "\r\n", rows: lines.length - 1, parts: parts.length };
}

