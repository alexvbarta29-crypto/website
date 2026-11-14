// Record types of the payroll module: pay_period, pay_line (design §3.3,
// §5.8). Each is a defineType() object with rotorFields, techFields and
// example() (§3.14).
//
//   pay_period  one pay period (Sunday to Saturday, one or two weeks):
//               open → locked → paid. While open its lines are worked out
//               live from the time, jobs and tips (compute.mjs) and `totals`
//               is the last recompute; locking freezes the lines into the
//               record (`lines`, `totals`), so a lock is one write and a
//               crash can never leave half a pay sheet. One per start date:
//               ptr/period/{start_on}. Rows of ix/pay-periods.
//   pay_line    a line someone wrote down rather than one worked out: the
//               owner's adjustments and bonuses, late time that closed into
//               a locked week (an adjustment in the next open period), and
//               Rotor's paid lines (import phase 31). One per line_key:
//               ptr/payline/{lineKey} (":" becomes "--", §3.2), Rotor's by
//               ptr/rotor/payline/{id}. Listed per period
//               (rel/period-lines) and per person (rel/user-paylines).
//
// Neither mirrors Rotor (pay is the CRM's own arithmetic) and neither is a
// shadow record. Index rows hold no notes.

import { defineType } from "../../core/registry.mjs";
import { isId } from "../../core/ids.mjs";
import { tsKey, isLocalDate, dowOfDate, addLocalDays } from "../../core/clock.mjs";
import { InputError } from "../../core/errors.mjs";
import { shape, str, enumValue, int, isoTime } from "../../core/validate.mjs";
import { rotorKey } from "../contacts/display.mjs";
import { LINE_TYPES } from "./compute.mjs";

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const clean = (o) => { for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k]; return o; };
const isoOpt = (v, f) => isoTime(v, { field: f }) || undefined;
const strOpt = (max) => (v, f) => str(v, { field: f, max }) || undefined;
const sortOf = (at) => tsKey(new Date(Date.parse(at) || 0));

export const PERIOD_STATUSES = Object.freeze(["open", "locked", "paid"]);
export const LINE_STATUSES = Object.freeze(["draft", "approved", "paid", "void"]);
export const MAX_FROZEN_LINES = 600;

// A line_key as a pointer key: ":" → "--" (§3.2), lowercased, key-safe characters only.
export const lineKeyPtr = (k) => String(k || "").toLowerCase().replace(/:/g, "--").replace(/[^a-z0-9\-_.@]/g, "_").slice(0, 300);

const userId = (v, f) => { if (!isId(v, "user")) throw new InputError("Pick a person on the team.", f); return v; };

// ------------------------------------------------------------ pay_period

export function validatePeriod(data, { op } = {}) {
  const stored = op === "update";
  const imported = !!(data && (data.import || data.rotor));
  const out = shape(data, {
    start_on: (v, f) => {
      if (!isLocalDate(v)) throw new InputError("Pick the first day.", f);
      if (!stored && dowOfDate(v) !== 0 && !imported) throw new InputError("A pay period starts on a Sunday.", f);
      return v;
    },
    end_on: (v, f) => { if (!isLocalDate(v)) throw new InputError("Pick the last day.", f); return v; },
    weeks: (v, f) => int(v ?? 1, { field: f, min: 1, max: 9 }),
    status: (v, f) => enumValue(v, PERIOD_STATUSES, { field: f, stored }) || "open",
    locked_at: isoOpt, locked_by: strOpt(80), paid_at: isoOpt, paid_by: strOpt(80), computed_at: isoOpt,
    totals: (v) => (isObj(v) ? { ...v } : {}),
    lines: (v, f) => {
      if (v === undefined || v === null) return undefined;
      if (!Array.isArray(v) || v.length > MAX_FROZEN_LINES) throw new InputError("Too many lines.", f);
      return v.filter(isObj).map((l) => ({ ...l }));
    },
    unlocks: (v) => (Array.isArray(v) ? v.filter(isObj).slice(-20) : undefined),
    timesheets_locked: (v) => (v === true ? true : undefined),
    note: strOpt(500),
    rotor: (v) => (isObj(v) ? { ...v } : undefined),
  });
  if (out.end_on < out.start_on) throw new InputError("It ends after it starts.", "end_on");
  if (!stored && !imported && out.end_on !== addLocalDays(out.start_on, 7 * out.weeks - 1)) throw new InputError("A period is whole weeks, Sunday to Saturday.", "end_on");
  return clean(out);
}

const sum = (totals, k) => Object.values(totals || {}).reduce((a, t) => a + ((t && t[k]) || 0), 0);
export const periodRow = (r) => ({
  s: r.start_on, e: r.end_on, w: r.weeks || 1, st: r.status, tot: sum(r.totals, "total_cents"), hrs: Math.round(sum(r.totals, "minutes") / 6) / 10,
  tips: sum(r.totals, "tips_cents"), n: Object.keys(r.totals || {}).length, im: r.import ? 1 : 0, ca: r.computed_at || null, u: r.updated_at,
});

export const periodType = defineType({
  type: "pay_period",
  prefix: "pp",
  v: 1,
  validate: validatePeriod,
  rotorFields: ["rotor"],
  techFields: ["id", "type", "start_on", "end_on", "weeks", "status", "paid_at", "created_at", "updated_at"],
  readPerm: "payroll:read_all",
  shadow: false,
  indexes: [{ name: "pay-periods", shard: (r) => (r.deleted_at ? null : ""), row: periodRow }],
  pointers: [{ kind: "period", key: (r) => (r.deleted_at || r.rotor ? null : r.start_on) }],
  summary: (r) => ({ id: r.id, start_on: r.start_on, end_on: r.end_on, status: r.status }),
  example: () => ({ start_on: "2026-11-15", end_on: "2026-11-21", weeks: 1, status: "open", totals: {} }),
});

// ------------------------------------------------------------ pay_line

export function validateLine(data, { op } = {}) {
  const stored = op === "update";
  const out = shape(data, {
    user_id: userId,
    period_id: (v, f) => { if (!isId(v, "pay_period")) throw new InputError("Which pay period?", f); return v; },
    // the line's kind (Rotor's line_type; a record's own `type` is "pay_line")
    line_type: (v, f) => enumValue(v, LINE_TYPES, { field: f, stored, required: true }),
    line_key: (v, f) => str(v, { field: f, max: 300, required: true }),
    label: (v, f) => str(v, { field: f, max: 120 }) || "Adjustment",
    detail: (v, f) => str(v, { field: f, max: 300 }) || "",
    basis_cents: (v, f) => int(v, { field: f, min: -100000000, max: 100000000 }),
    rate_bp: (v, f) => int(v, { field: f, min: 0, max: 10000 }),
    hours: (v, f) => (v === undefined || v === null ? undefined : typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 10000 ? v : (() => { throw new InputError("Hours must be a number.", f); })()),
    rate_cents_per_hour: (v, f) => int(v, { field: f, min: 0, max: 1000000 }),
    amount_cents: (v, f) => int(v, { field: f, min: -10000000, max: 10000000, required: true }),
    source: (v) => (isObj(v) ? Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === "string" && x.length <= 80)) : {}),
    status: (v, f) => enumValue(v, LINE_STATUSES, { field: f, stored }) || "draft",
    paid_at: isoOpt, paid_by: strOpt(80),
    note: strOpt(500),
    created_for: strOpt(40),
    rotor: (v) => (isObj(v) ? { ...v } : undefined),
  });
  return clean(out);
}

export const lineRow = (r) => ({ uid: r.user_id, pp: r.period_id, t: r.line_type, a: r.amount_cents, st: r.status, u: r.updated_at });

export const lineType = defineType({
  type: "pay_line",
  prefix: "py",
  v: 1,
  validate: validateLine,
  rotorFields: ["rotor", "user_id", "line_type", "line_key", "label", "detail", "basis_cents", "rate_bp", "hours", "rate_cents_per_hour", "amount_cents", "status", "paid_at"],
  techFields: ["id", "type", "line_type", "user_id", "period_id", "label", "detail", "basis_cents", "rate_bp", "hours", "rate_cents_per_hour", "amount_cents", "status", "paid_at", "note", "line_key", "created_at", "updated_at"],
  readPerm: "payroll:read_all",
  shadow: false,
  rels: [
    { rel: "period-lines", parent: (r) => (r.deleted_at ? null : r.period_id), sort: (r) => sortOf(r.created_at) },
    { rel: "user-paylines", parent: (r) => (r.deleted_at ? null : r.user_id), sort: (r) => sortOf(r.created_at) },
  ],
  pointers: [
    { kind: "payline", key: (r) => (r.deleted_at ? null : lineKeyPtr(r.line_key)) },
    { kind: "rotor/payline", key: (r) => (r.rotor && r.rotor.payroll_line_id ? rotorKey(r.rotor.payroll_line_id) : null) },
  ],
  summary: (r) => ({ id: r.id, user_id: r.user_id, line_type: r.line_type, amount_cents: r.amount_cents, status: r.status }),
  example: () => ({ user_id: "us_0000000000000000000a", period_id: "pp_0000000000000000000a", line_type: "bonus", line_key: "bonus:sample", label: "Review bonus", detail: "Two reviews this week", amount_cents: 2000, status: "draft", source: {} }),
});

export const types = [periodType, lineType];
