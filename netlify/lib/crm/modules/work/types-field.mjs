// Record types of the work module's field part (M4b): timer, timesheet
// (design §3.3, §5.5). Each is a defineType() object with rotorFields,
// techFields and example() (§3.14).
//
//   timer      one segment of work on a visit by one person (start → pause
//              closes it, resume opens the next); a visit's minutes_worked
//              is the sum of its closed segments. Rotor has segments with
//              no visit (kept: visit_id is optional). Open segments are
//              rows of ix/timers/active (the office's "timers to check"),
//              listed per visit (rel/visit-timers) and per person
//              (rel/user-timers). One running segment per (visit, person):
//              the "one open" pointer ptr/timer/{visitId}--{uid}, claimed
//              by timers.mjs (§3.7).
//   timesheet  a shift: clock in → clock out, by category (service, sales,
//              office). Status open → closed → approved (an owner or the
//              office approves the week) → locked (payroll locks the
//              period). pending_approval is a time the server did not take
//              on its own (a device time it could not trust, a replay that
//              no longer fit, §2.5); rejected and adjusted entries never
//              count for pay (an adjusted one became a payroll adjustment
//              line because its week was locked, §5.8). One open shift per
//              person: ptr/clock/{uid} (timesheets.mjs). Rows of
//              ix/timesheets/{yyyy-mm} (the local month of the start).
//
// Minutes are derived from start_at and end_at on every write (whole
// minutes, never negative). Validators keep unknown fields and stored enum
// values this code doesn't know (§3.14 schema rules). Index rows never hold
// notes.

import { defineType } from "../../core/registry.mjs";
import { isId } from "../../core/ids.mjs";
import { tsKey, localDate } from "../../core/clock.mjs";
import { InputError } from "../../core/errors.mjs";
import { shape, str, enumValue, arr, isoTime, int } from "../../core/validate.mjs";
import { rotorKey } from "../contacts/display.mjs";

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const clean = (o) => { for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k]; return o; };
const sortOf = (at) => tsKey(new Date(Date.parse(at) || 0));

export const CATEGORIES = Object.freeze(["service", "sales", "office"]);
export const SHEET_STATUSES = Object.freeze(["open", "closed", "pending_approval", "approved", "locked", "rejected", "adjusted"]);
// what counts toward hours and pay (pending entries count only once approved, §5.8)
export const PAID_STATUSES = Object.freeze(["closed", "approved", "locked"]);
export const MAX_SHIFT_MIN = 24 * 60;

const idOf = (type) => (v, f) => {
  if (v === undefined || v === null || v === "") return undefined;
  if (!isId(v, type)) throw new InputError("That id doesn't look right.", f);
  return v;
};
const userIds = (max) => (v, f) => [...new Set(arr(v, (x, ff) => {
  if (!isId(x, "user")) throw new InputError("Pick people on the team.", ff);
  return x;
}, { field: f, max }))];
const isoOpt = (v, f) => isoTime(v, { field: f });
const strOpt = (max) => (v, f) => str(v, { field: f, max }) || undefined;
const geoOf = (v, f) => {
  if (v === undefined || v === null) return undefined;
  const lat = Array.isArray(v) ? v[0] : v.lat;
  const lng = Array.isArray(v) ? v[1] : v.lng;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new InputError("That location isn't valid.", f);
  return [Math.round(lat * 1e5) / 1e5, Math.round(lng * 1e5) / 1e5];
};
const objOpt = (v) => (isObj(v) ? { ...v } : undefined);
const CLIENT_RE = /^[A-Za-z0-9-]{8,64}$/;
const clientOpt = (v, f) => {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || !CLIENT_RE.test(v)) throw new InputError("That client id doesn't look right.", f);
  return v.toLowerCase();
};

// Whole minutes between two instants (never negative).
export function minutesBetween(startIso, endIso) {
  const a = Date.parse(startIso), b = Date.parse(endIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.round((b - a) / 60000));
}

function endsAfter(out) {
  if (out.end_at && Date.parse(out.end_at) < Date.parse(out.start_at)) throw new InputError("It ends after it starts.", "end_at");
  if (out.end_at) out.minutes = minutesBetween(out.start_at, out.end_at);
  else delete out.minutes;
}

// ------------------------------------------------------------ timer

export function validateTimer(data) {
  const out = shape(data, {
    visit_id: idOf("visit"),
    job_id: idOf("job"),
    user_ids: userIds(8),
    start_at: (v, f) => isoTime(v, { field: f, required: true }),
    end_at: isoOpt,
    start_geo: geoOf,
    end_geo: geoOf,
    auto_closed: objOpt,
    client_at: isoOpt,
    client_id: clientOpt,
    end_client_id: clientOpt,
    unverified: (v) => (v === true ? true : undefined),
  });
  endsAfter(out);
  return clean(out);
}

export const timerRow = (r) => ({ v: r.visit_id || null, j: r.job_id || null, u: r.user_ids || [], s: r.start_at, d: localDate(new Date(r.start_at)), un: r.unverified === true });

// One user-timers relation per person slot (a segment has at most a few).
const userTimerRel = (i) => ({ rel: "user-timers", parent: (r) => (Array.isArray(r.user_ids) && r.user_ids[i]) || null, sort: (r) => sortOf(r.start_at) });

export const TIMER_TECH_FIELDS = Object.freeze(["id", "type", "v", "wv", "visit_id", "job_id", "user_ids", "start_at", "end_at", "minutes", "auto_closed", "unverified", "created_at", "updated_at"]);

export const timerType = defineType({
  type: "timer",
  prefix: "tm",
  v: 1,
  validate: validateTimer,
  rotorFields: ["user_ids", "start_at", "end_at", "minutes", "rotor"],
  techFields: [...TIMER_TECH_FIELDS],
  readPerm: "time:edit_others",
  indexes: [{ name: "timers", shard: (r) => (!r.end_at ? "active" : null), row: timerRow }],
  rels: [
    { rel: "visit-timers", parent: (r) => r.visit_id || null, sort: (r) => sortOf(r.start_at) },
    ...Array.from({ length: 4 }, (_, i) => userTimerRel(i)),
  ],
  pointers: [{ kind: "rotor/timer", key: (r) => (r.rotor && r.rotor.timer_id !== undefined && r.rotor.timer_id !== null ? rotorKey(r.rotor.timer_id) : null) }],
  summary: (r) => ({ id: r.id, visit_id: r.visit_id || null, start_at: r.start_at, end_at: r.end_at || null }),
  example: () => ({ visit_id: "vs_0000000000000000000a", job_id: "jb_0000000000000000000a", user_ids: ["us_0000000000000000000a"], start_at: "2026-11-17T14:02:00.000Z", end_at: "2026-11-17T16:10:00.000Z" }),
});

// ------------------------------------------------------------ timesheet

function validateNote(x, f) {
  if (!isObj(x)) throw new InputError("Expected a note.", f);
  return { ...x, at: isoTime(x.at, { field: `${f}.at` }) || undefined, by: str(x.by, { field: `${f}.by`, max: 80 }) || undefined, text: str(x.text, { field: `${f}.text`, max: 500, required: true }) };
}
function validateEdit(x, f) {
  if (!isObj(x)) throw new InputError("Expected an edit.", f);
  return { ...x, by: str(x.by, { field: `${f}.by`, max: 80 }), at: isoTime(x.at, { field: `${f}.at` }), field: str(x.field, { field: `${f}.field`, max: 40 }), reason: str(x.reason, { field: `${f}.reason`, max: 300 }) };
}

export function validateTimesheet(data, { op } = {}) {
  const stored = op === "update";
  const out = shape(data, {
    user_id: (v, f) => { if (!isId(v, "user")) throw new InputError("Whose time is it?", f); return v; },
    category: (v, f) => enumValue(v, CATEGORIES, { field: f, stored }) || "service",
    start_at: (v, f) => isoTime(v, { field: f, required: true }),
    end_at: isoOpt,
    start_geo: geoOf,
    end_geo: geoOf,
    notes: (v, f) => arr(v, validateNote, { field: f, max: 50 }),
    status: (v, f) => enumValue(v, SHEET_STATUSES, { field: f, stored }) || "open",
    auto_closed: objOpt,
    client_at: isoOpt,
    queued_at: isoOpt,
    received_at: isoOpt,
    edits: (v, f) => arr(v, validateEdit, { field: f, max: 100 }),
    pending: objOpt,
    adjustment: objOpt,
    flags: (v, f) => [...new Set(arr(v, (x, ff) => str(x, { field: ff, max: 40 }), { field: f, max: 20 }).filter(Boolean))],
    approved_at: isoOpt,
    approved_by: strOpt(80),
    reminded_at: isoOpt,
    client_id: clientOpt,
    end_client_id: clientOpt,
    visit_id: idOf("visit"),
    timer_id: idOf("timer"),
  });
  if (out.status === "open" && out.end_at) throw new InputError("An open shift has no end yet.", "end_at");
  endsAfter(out);
  if (out.minutes !== undefined && out.minutes > MAX_SHIFT_MIN * 7) throw new InputError("That shift is too long.", "end_at");
  return clean(out);
}

export const sheetShard = (r) => localDate(new Date(r.start_at)).slice(0, 7);
export const sheetRow = (r) => ({
  uid: r.user_id, cat: r.category, s: r.start_at, e: r.end_at || null, min: r.minutes ?? null, st: r.status, pend: r.status === "pending_approval",
  ac: !!r.auto_closed, ed: (r.edits || []).length, fl: (r.flags || []).slice(0, 6), d: localDate(new Date(r.start_at)), why: r.pending && r.pending.reason ? String(r.pending.reason).slice(0, 30) : null, u: r.updated_at,
});

export const TIMESHEET_TECH_FIELDS = Object.freeze(["id", "type", "v", "wv", "user_id", "category", "start_at", "end_at", "minutes", "notes", "status", "auto_closed", "pending", "flags", "edits", "created_at", "updated_at"]);

export const timesheetType = defineType({
  type: "timesheet",
  prefix: "ts",
  v: 1,
  validate: validateTimesheet,
  rotorFields: ["user_id", "start_at", "end_at", "minutes", "category", "rotor"],
  techFields: [...TIMESHEET_TECH_FIELDS],
  readPerm: "time:edit_others",
  indexes: [{ name: "timesheets", shard: sheetShard, row: sheetRow }],
  rels: [{ rel: "user-timesheets", parent: (r) => r.user_id, sort: (r) => sortOf(r.start_at) }],
  pointers: [{ kind: "rotor/timesheet", key: (r) => (r.rotor && r.rotor.timesheet_id !== undefined && r.rotor.timesheet_id !== null ? rotorKey(r.rotor.timesheet_id) : null) }],
  summary: (r) => ({ id: r.id, user_id: r.user_id, start_at: r.start_at, end_at: r.end_at || null, status: r.status }),
  example: () => ({ user_id: "us_0000000000000000000a", category: "service", start_at: "2026-11-17T13:30:00.000Z", end_at: "2026-11-17T22:15:00.000Z", status: "closed", notes: [], edits: [] }),
});

export const types = [timerType, timesheetType];
