// Record types of the work module's office part (M4a): job, visit,
// checklist_template, time_off (design §3.3, §5.5). Each is a defineType()
// object with rotorFields, techFields and example() (§3.14). The field
// part's timer and timesheet live in types-field.mjs (M4b).
//
// The visit is what goes on the calendar; the job is what gets billed; a
// plan generates jobs. Both mirror Rotor (mirrored: true), so automation
// may create them only for sandboxed contacts before cutover (§3.10).
//
// Derived fields (never rotorFields): a job's schedule summary, its
// assignee_ids (everyone on its live visits), contact_name and totals; a
// visit's start_utc/end_utc (computed here from the local date and times,
// DST-safe), and the summaries the schedule rows show without reading the
// job (job_number, job_kind, job_title, service_types, contact_name, town,
// address_line, geo). Validators keep unknown fields and a stored enum
// value this code doesn't know (§3.14 schema rules). Index rows use short
// keys and never hold notes.

import { defineType } from "../../core/registry.mjs";
import { isId } from "../../core/ids.mjs";
import { tsKey, zonedToUtc, isLocalDate, isLocalTime, TZ } from "../../core/clock.mjs";
import { InputError } from "../../core/errors.mjs";
import { shape, str, enumValue, bool, arr, isoTime, int } from "../../core/validate.mjs";
import { lineTotal, roundHalfUp, sumCents } from "../../core/money.mjs";
import { rotorKey } from "../contacts/display.mjs";
import { JOB_STATUSES, VISIT_STATUSES, OPEN_JOB } from "./states.mjs";

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const sortOf = (at) => tsKey(new Date(Date.parse(at) || 0));

// ------------------------------------------------------------ vocabulary

export const JOB_KINDS = Object.freeze(["standard", "touch_up", "warranty", "lights_install", "lights_takedown", "lights_warranty"]);
export const NOT_BILLABLE = Object.freeze(["touch_up", "warranty", "lights_takedown", "lights_warranty"]);
export const WINDOW_TYPES = Object.freeze(["exact", "window", "anytime"]);
export const DEFAULT_WINDOW = Object.freeze({ type: "window", minutes: 120 });
export const CHECK_KINDS = Object.freeze(["check", "photo", "count", "text"]);
export const PHOTO_TAGS = Object.freeze(["before", "after", "issue", "other"]);
export const SCOPE_TYPES = Object.freeze(["all", "initial", "after_initial", "specific"]);
export const MAX_ASSIGNEES = 8;
export const MAX_LINES = 60;
export const MAX_VISITS_PER_JOB = 60;
const KEY_RE = /^[a-z][a-z0-9_]{1,39}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

// ------------------------------------------------------------ shared field checks

const idOf = (type) => (v, f) => {
  if (v === undefined || v === null || v === "") return undefined;
  if (!isId(v, type)) throw new InputError("That id doesn't look right.", f);
  return v;
};
const requiredId = (type, msg) => (v, f) => {
  if (!isId(v, type)) throw new InputError(msg, f);
  return v;
};
const ids = (type, max = 50) => (v, f) => [...new Set(arr(v, (x, ff) => {
  if (!isId(x, type)) throw new InputError("That id doesn't look right.", ff);
  return x;
}, { field: f, max }))];
const isoOpt = (v, f) => isoTime(v, { field: f });
const strOpt = (max) => (v, f) => str(v, { field: f, max }) || undefined;
const dateOpt = (v, f) => {
  if (v === undefined || v === null || v === "") return undefined;
  if (!isLocalDate(v)) throw new InputError("Use a date like 2026-11-17.", f);
  return v;
};
const strList = (max, each = 80) => (v, f) => [...new Set(arr(v, (x, ff) => str(x, { field: ff, max: each }), { field: f, max }).filter(Boolean))];

function validateScope(v, f) {
  if (v === undefined || v === null) return { type: "all" };
  if (!isObj(v)) throw new InputError("Expected which visits it covers.", f);
  const type = enumValue(v.type, SCOPE_TYPES, { field: `${f}.type`, stored: true }) || "all";
  if (type !== "specific") return { ...v, type };
  const visits = arr(v.visits ?? v.selectedJobs, (x, ff) => int(x, { field: ff, min: 1, max: 100, required: true }), { field: `${f}.visits`, max: 60 });
  const out = { ...v, type, visits: [...new Set(visits)].sort((a, b) => a - b) };
  delete out.selectedJobs;
  return out;
}

// One line of a job (the quotes module's Line shape, §5.3). Prices are
// integer cents and quantities integer thousandths; total_cents is the
// override's cents, else lineTotal(qty_milli, unit_cents), unless the line
// came with a total (imported job lines: Rotor's total is per job).
export function validateLine(v, f) {
  if (!isObj(v)) throw new InputError("Expected a line.", f);
  const out = shape(v, {
    id: (x, ff) => {
      const s = str(x, { field: ff, max: 80 });
      if (!s) throw new InputError("A line needs an id.", ff);
      return s;
    },
    price_item_id: idOf("price_item"),
    title: (x, ff) => str(x, { field: ff, max: 160, required: true }),
    description: (x, ff) => str(x, { field: ff, max: 1000 }) || undefined,
    qty_milli: (x, ff) => int(x ?? 1000, { field: ff, min: 0, max: 1000000000 }),
    unit_cents: (x, ff) => int(x ?? 0, { field: ff, min: -100000000, max: 100000000 }),
    engine_cents: (x, ff) => int(x, { field: ff, min: -100000000, max: 100000000 }),
    total_cents: (x, ff) => int(x, { field: ff, min: -100000000, max: 1000000000 }),
    scope: (x, ff) => validateScope(x, ff),
    optional: (x, ff) => (x === undefined ? undefined : bool(x, { field: ff })),
    selected: (x, ff) => (x === undefined ? undefined : bool(x, { field: ff })),
    service_type: strOpt(120),
    tier: strOpt(120),
    upsell_user_id: idOf("user"),
    override: (x, ff) => {
      if (x === undefined || x === null) return undefined;
      if (!isObj(x)) throw new InputError("Expected a price override.", ff);
      return { ...x, cents: int(x.cents, { field: `${ff}.cents`, min: -100000000, max: 1000000000, required: true }), reason: str(x.reason, { field: `${ff}.reason`, max: 200 }) || "override" };
    },
    show: (x) => (isObj(x) ? { qty: x.qty !== false, unit: x.unit !== false, description: x.description === true } : { qty: true, unit: true, description: false }),
  }, { field: f });
  if (out.total_cents === undefined) out.total_cents = out.override ? out.override.cents : lineTotal({ unit_cents: out.unit_cents, qty_milli: out.qty_milli });
  return out;
}

export function validateDiscount(v, f) {
  if (!isObj(v)) throw new InputError("Expected a discount.", f);
  const type = enumValue(v.type, ["fixed", "percentage"], { field: `${f}.type`, required: true, stored: true });
  return {
    ...v,
    id: str(v.id, { field: `${f}.id`, max: 80 }) || `d${Math.abs(hashish(JSON.stringify(v))) % 1e9}`,
    def_id: idOf("discount_def")(v.def_id, `${f}.def_id`),
    name: str(v.name, { field: `${f}.name`, max: 120 }) || "Discount",
    type,
    value: int(v.value, { field: `${f}.value`, min: 0, max: type === "percentage" ? 10000 : 100000000, required: true }),
    scope: validateScope(v.scope, `${f}.scope`),
    reason: str(v.reason, { field: `${f}.reason`, max: 200 }) || undefined,
  };
}
function hashish(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }
const clean = (o) => { for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k]; return o; };

// Does a line or discount scope cover visit n of a plan term (1-based)?
export function scopeCovers(scope, n = 1) {
  const s = scope || { type: "all" };
  if (s.type === "initial") return n === 1;
  if (s.type === "after_initial") return n > 1;
  if (s.type === "specific") return Array.isArray(s.visits) && s.visits.includes(n);
  return true;
}

// The totals of a job (pure, integer cents): the lines that cover its
// ordinal (an optional line only when selected), percentage discounts
// first (basis points, capped at 100%), then fixed ones, never below $0.
export function jobTotals(lines = [], discounts = [], n = 1) {
  const on = lines.filter((l) => l && scopeCovers(l.scope, n) && !(l.optional && l.selected !== true));
  const subtotal = sumCents(on.map((l) => (Number.isSafeInteger(l.total_cents) ? l.total_cents : 0)));
  const ds = discounts.filter((d) => d && scopeCovers(d.scope, n));
  const bp = Math.min(10000, ds.filter((d) => d.type === "percentage").reduce((s, d) => s + (d.value || 0), 0));
  const pct = subtotal > 0 ? roundHalfUp(subtotal * bp, 10000) : 0;
  const fixed = ds.filter((d) => d.type === "fixed").reduce((s, d) => s + (d.value || 0), 0);
  const discount = Math.max(0, Math.min(Math.max(0, subtotal), pct + fixed));
  return { subtotal_cents: subtotal, discount_cents: discount, total_cents: subtotal - discount };
}

// "0000885" (job) or "S-000001" (a shadow number before cutover, §3.9).
export const JOB_NUMBER_FORMATS = Object.freeze({ job: { prefix: "", pad: 7 }, "job-shadow": { prefix: "S-", pad: 6 } });
export function jobNumberLabel(n, seq = "job", formats = JOB_NUMBER_FORMATS) {
  const f = (formats && formats[seq]) || JOB_NUMBER_FORMATS[seq] || JOB_NUMBER_FORMATS.job;
  return `${f.prefix || ""}${String(n).padStart(Number.isInteger(f.pad) ? f.pad : 0, "0")}`;
}

// ------------------------------------------------------------ job

export function validateJob(data, { op } = {}) {
  const stored = op === "update";
  const out = shape(data, {
    number: (v, f) => int(v, { field: f, min: 0, max: 999999999, required: true }),
    seq: (v, f) => enumValue(v, ["job", "job-shadow"], { field: f, stored }) || "job",
    number_label: (v, f) => str(v, { field: f, max: 24 }) || undefined,
    contact_id: requiredId("contact", "A job belongs to a contact."),
    property_id: idOf("property"),
    plan_id: idOf("plan"),
    plan_ordinal: (v, f) => {
      if (v === undefined || v === null) return undefined;
      if (!isObj(v)) throw new InputError("Expected the plan visit.", f);
      return { ...v, term: int(v.term ?? 1, { field: `${f}.term`, min: 1, max: 100 }), n: int(v.n, { field: `${f}.n`, min: 1, max: 100, required: true }) };
    },
    quote_id: idOf("quote"),
    deal_id: idOf("deal"),
    season_install_id: idOf("season_install"),
    kind: (v, f) => enumValue(v, JOB_KINDS, { field: f, stored }) || "standard",
    title: (v, f) => str(v, { field: f, max: 160 }) || undefined,
    service_types: strList(20, 120),
    lines: (v, f) => arr(v, validateLine, { field: f, max: MAX_LINES }),
    discounts: (v, f) => arr(v, validateDiscount, { field: f, max: 20 }),
    billable: (v, f) => (v === undefined || v === null ? undefined : bool(v, { field: f })),
    status: (v, f) => enumValue(v, JOB_STATUSES, { field: f, stored }) || "unscheduled",
    target_month: (v, f) => {
      if (v === undefined || v === null || v === "") return undefined;
      if (!MONTH_RE.test(String(v))) throw new InputError("Use a month like 2027-01.", f);
      return v;
    },
    visit_ids: ids("visit", MAX_VISITS_PER_JOB),
    invoice_ids: ids("invoice", 50),
    assignee_ids: ids("user", 20),
    schedule: (v) => (isObj(v) ? { ...v } : undefined),
    started_at: isoOpt,
    completed_at: isoOpt,
    completed_by: strOpt(80),
    cancelled_at: isoOpt,
    cancel_reason: strOpt(300),
    reopened_at: isoOpt,
    office_notes: (v, f) => str(v, { field: f, max: 4000, trim: false }),
    crew_notes: (v, f) => str(v, { field: f, max: 2000, trim: false }),
    review: (v) => (isObj(v) ? { ...v } : {}),
    contact_name: strOpt(120),
    origin: (v, f) => str(v, { field: f, max: 40 }) || undefined,
  });
  if (!out.title) out.title = titleFromLines(out.lines, out.kind);
  if (out.billable === undefined) out.billable = !NOT_BILLABLE.includes(out.kind);
  out.totals = jobTotals(out.lines, out.discounts, (out.plan_ordinal && out.plan_ordinal.n) || 1);
  if (!out.number_label) out.number_label = jobNumberLabel(out.number, out.seq);
  return clean(out);
}

export function titleFromLines(lines = [], kind = "standard") {
  const names = [...new Set((lines || []).map((l) => String((l && l.title) || "").trim()).filter(Boolean))];
  if (!names.length) return ({ touch_up: "Touch-up", warranty: "Warranty visit", lights_install: "Christmas lights install", lights_takedown: "Christmas lights takedown", lights_warranty: "Lights warranty visit" })[kind] || "Job";
  const t = names.slice(0, 2).join(" + ") + (names.length > 2 ? ` + ${names.length - 2} more` : "");
  return t.length > 160 ? t.slice(0, 157) + "..." : t;
}

// The jobs index: open jobs in "open", closed ones by the year they closed.
export function jobShard(r) {
  if (OPEN_JOB.includes(r.status)) return "open";
  const at = r.status === "cancelled" ? r.cancelled_at : r.completed_at;
  const y = String(at || r.updated_at || r.created_at || "").slice(0, 4);
  return /^\d{4}$/.test(y) ? y : "open";
}
export const jobRow = (r) => ({
  n: r.number_label || String(r.number), num: r.number, c: r.contact_id, cn: r.contact_name || "", t: r.title, pl: r.plan_id || null, st: r.status, k: r.kind,
  tm: r.target_month || null, nv: (r.schedule && r.schedule.open_on) || null, lv: (r.schedule && r.schedule.last_on) || null, fv: (r.schedule && r.schedule.first_on) || null,
  sa: r.started_at || null, tot: r.totals ? r.totals.total_cents : 0, bill: r.billable !== false, a: r.assignee_ids || [], pr: r.property_id || null,
  svc: (r.service_types || []).slice(0, 4), done: r.completed_at || null, u: r.updated_at,
});

export const JOB_TECH_FIELDS = Object.freeze(["id", "type", "v", "wv", "number", "number_label", "contact_id", "property_id", "kind", "title", "service_types", "lines", "discounts",
  "totals", "billable", "status", "crew_notes", "visit_ids", "assignee_ids", "contact_name", "target_month", "schedule", "created_at", "updated_at"]);

export const jobType = defineType({
  type: "job",
  prefix: "jb",
  v: 1,
  validate: validateJob,
  rotorFields: ["number", "kind", "title", "service_types", "lines", "discounts", "status", "target_month", "crew_notes", "rotor"],
  mirrored: true,
  techFields: [...JOB_TECH_FIELDS],
  readPerm: "schedule:read",
  indexes: [{ name: "jobs", shard: jobShard, row: jobRow }],
  rels: [
    { rel: "contact-jobs", parent: (r) => r.contact_id, sort: (r) => sortOf(r.created_at) },
    { rel: "plan-jobs", parent: (r) => r.plan_id || null, sort: (r) => `${String((r.plan_ordinal && r.plan_ordinal.term) || 1).padStart(3, "0")}.${String((r.plan_ordinal && r.plan_ordinal.n) || 0).padStart(3, "0")}` },
  ],
  pointers: [
    { kind: "job-no", key: (r) => (r.seq === "job-shadow" ? null : String(r.number)) },
    { kind: "job-shadow-no", key: (r) => (r.seq === "job-shadow" ? String(r.number) : null) },
    { kind: "rotor/job", key: (r) => (r.rotor && r.rotor.job_id ? rotorKey(r.rotor.job_id) : null) },
  ],
  summary: (r) => ({ id: r.id, number: r.number_label || String(r.number), title: r.title, status: r.status }),
  example: () => ({
    number: 1, seq: "job-shadow", contact_id: "ct_0000000000000000000a", property_id: "pr_0000000000000000000a", kind: "standard", title: "Exterior window cleaning",
    service_types: ["Residential Window Cleaning"], lines: [{ id: "ln_1", title: "Exterior window cleaning", qty_milli: 1000, unit_cents: 29500, scope: { type: "all" } }],
    discounts: [], status: "unscheduled", visit_ids: [], invoice_ids: [], office_notes: "", crew_notes: "Dog in the back yard.", review: {},
  }),
});

// ------------------------------------------------------------ visit

function validateWindow(v, f) {
  if (v === undefined || v === null) return { ...DEFAULT_WINDOW };
  if (!isObj(v)) throw new InputError("Pick an arrival window.", f);
  const type = enumValue(v.type, WINDOW_TYPES, { field: `${f}.type`, stored: true }) || "window";
  const minutes = type === "window" ? int(v.minutes ?? 120, { field: `${f}.minutes`, min: 15, max: 720 }) : 0;
  return { ...v, type, minutes };
}

function validateChecklist(v, f) {
  if (v === undefined || v === null) return { items: [] };
  if (!isObj(v)) throw new InputError("Expected a checklist.", f);
  const items = arr(v.items, (x, ff) => {
    if (!isObj(x)) throw new InputError("Expected a checklist item.", ff);
    const key = str(x.key, { field: `${ff}.key`, max: 40 });
    if (!KEY_RE.test(key)) throw new InputError("That item needs a short key.", `${ff}.key`);
    return { ...x, key, label: str(x.label, { field: `${ff}.label`, max: 120, required: true }), required: x.required === true, kind: enumValue(x.kind, CHECK_KINDS, { field: `${ff}.kind`, stored: true }) || "check" };
  }, { field: `${f}.items`, max: 40 });
  return { ...v, ...(v.template_key ? { template_key: str(v.template_key, { field: `${f}.template_key`, max: 40 }) } : {}), items };
}

// The UTC instants of a local date and times (DST-safe, core/clock).
export function slotUtc(date, start, end) {
  return { start_utc: zonedToUtc(date, start).toISOString(), end_utc: zonedToUtc(date, end).toISOString() };
}

export function validateVisit(data, { op } = {}) {
  const stored = op === "update";
  const out = shape(data, {
    job_id: requiredId("job", "A visit belongs to a job."),
    contact_id: requiredId("contact", "A visit belongs to a contact."),
    property_id: idOf("property"),
    ordering: (v, f) => int(v ?? 1, { field: f, min: 1, max: 1000 }),
    date: (v, f) => { if (!isLocalDate(v)) throw new InputError("Pick a date.", f); return v; },
    start: (v, f) => { if (!isLocalTime(v)) throw new InputError("Pick a start time.", f); return v; },
    end: (v, f) => { if (!isLocalTime(v)) throw new InputError("Pick an end time.", f); return v; },
    date_only: (v) => (v === true ? true : undefined),
    window: (v, f) => validateWindow(v, f),
    assignee_ids: ids("user", MAX_ASSIGNEES),
    crew_rotor_id: (v, f) => int(v, { field: f, min: 0, max: 1e12 }),
    route_order: (v, f) => int(v, { field: f, min: 1, max: 1000 }),
    status: (v, f) => enumValue(v, VISIT_STATUSES, { field: f, stored }) || "scheduled",
    on_my_way: (v) => (isObj(v) ? { ...v } : undefined),
    running_late: (v, f) => (v === undefined || v === null ? undefined : arr(v, (x) => (isObj(x) ? { ...x } : null), { field: f, max: 20 }).filter(Boolean)),
    moved_by_op: strOpt(200),
    checklist: (v, f) => validateChecklist(v, f),
    photos: (v, f) => arr(v, (x, ff) => {
      if (!isObj(x) || !isId(x.file_id, "file")) throw new InputError("Expected a photo.", ff);
      return { ...x, tag: enumValue(x.tag, PHOTO_TAGS, { field: `${ff}.tag`, stored: true }) || "other", customer_visible: x.customer_visible === true };
    }, { field: f, max: 200 }),
    tech_notes: (v, f) => str(v, { field: f, max: 4000, trim: false }),
    minutes_worked: (v, f) => int(v, { field: f, min: 0, max: 100000 }),
    completion: (v) => (isObj(v) ? { ...v } : undefined),
    late_cancel: (v) => (v === true ? true : undefined),
    reminders: (v) => (isObj(v) ? { ...v } : undefined),
    no_access: (v) => (isObj(v) ? { ...v } : undefined),
    cancelled_at: isoOpt,
    cancel_reason: strOpt(300),
    // summaries the schedule shows without reading the job (§3.5 visits row)
    job_number: strOpt(24),
    job_kind: (v, f) => enumValue(v, JOB_KINDS, { field: f, stored: true }),
    job_title: strOpt(160),
    service_types: strList(20, 120),
    plan_id: idOf("plan"),
    contact_name: strOpt(120),
    town: strOpt(80),
    address_line: strOpt(240),
    geo: (v, f) => {
      if (v === undefined || v === null) return undefined;
      const lat = Array.isArray(v) ? v[0] : v.lat;
      const lng = Array.isArray(v) ? v[1] : v.lng;
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new InputError("That map point isn't valid.", f);
      return [lat, lng];
    },
  });
  if (out.end <= out.start) throw new InputError("The visit ends after it starts.", "end");
  out.tz = TZ;
  Object.assign(out, slotUtc(out.date, out.start, out.end));
  return clean(out);
}

export const visitShard = (r) => (isLocalDate(r.date) ? r.date.slice(0, 7) : null);
export const visitRow = (r) => ({
  j: r.job_id, jn: r.job_number || "", c: r.contact_id, cn: r.contact_name || "", pr: r.property_id || null, town: r.town || "", ad: r.address_line || "",
  d: r.date, s: r.start, e: r.end, w: { t: (r.window && r.window.type) || "window", m: (r.window && r.window.minutes) || 0 }, a: r.assignee_ids || [], st: r.status,
  o: r.route_order || null, svc: (r.service_types || []).slice(0, 4), k: r.job_kind || "standard", t: r.job_title || "", pl: r.plan_id || null, geo: r.geo || null,
  ord: r.ordering || 1, do: r.date_only === true, mv: r.moved_by_op ? 1 : 0, u: r.updated_at,
});

export const VISIT_TECH_FIELDS = Object.freeze(["id", "type", "v", "wv", "job_id", "contact_id", "property_id", "ordering", "date", "start", "end", "tz", "start_utc", "end_utc", "date_only",
  "window", "assignee_ids", "route_order", "status", "on_my_way", "running_late", "checklist", "photos", "tech_notes", "minutes_worked", "completion",
  "job_number", "job_kind", "job_title", "service_types", "contact_name", "town", "address_line", "geo", "created_at", "updated_at"]);

// One tech-visits relation per assignee slot (a visit has at most 8):
// rel/tech-visits/{uid}/{date}--{visitId}, the tech's window lookup (§4.6).
const techRel = (i) => ({ rel: "tech-visits", parent: (r) => (Array.isArray(r.assignee_ids) && r.assignee_ids[i]) || null, sort: (r) => r.date });

export const visitType = defineType({
  type: "visit",
  prefix: "vs",
  v: 1,
  validate: validateVisit,
  rotorFields: ["date", "start", "end", "window", "assignee_ids", "status", "ordering", "date_only", "rotor"],
  mirrored: true,
  techFields: [...VISIT_TECH_FIELDS],
  readPerm: "schedule:read",
  indexes: [{ name: "visits", shard: visitShard, row: visitRow }],
  rels: [
    { rel: "job-visits", parent: (r) => r.job_id, sort: (r) => r.date },
    ...Array.from({ length: MAX_ASSIGNEES }, (_, i) => techRel(i)),
  ],
  pointers: [{ kind: "rotor/visit", key: (r) => (r.rotor && r.rotor.visit_id !== undefined && r.rotor.visit_id !== null ? rotorKey(r.rotor.visit_id) : null) }],
  summary: (r) => ({ id: r.id, date: r.date, start: r.start, status: r.status }),
  example: () => ({
    job_id: "jb_0000000000000000000a", contact_id: "ct_0000000000000000000a", property_id: "pr_0000000000000000000a", ordering: 1,
    date: "2026-11-19", start: "08:00", end: "10:00", window: { type: "window", minutes: 120 }, assignee_ids: [], status: "scheduled",
    checklist: { items: [] }, photos: [], tech_notes: "", job_number: "S-000001", job_kind: "standard", job_title: "Exterior window cleaning",
    service_types: ["Residential Window Cleaning"], contact_name: "Pat Example", town: "Delano",
  }),
});

// ------------------------------------------------------------ checklist_template

export function validateChecklistTemplate(data, { before } = {}) {
  const out = shape(data, {
    key: (v, f) => {
      const k = String(v ?? "").trim();
      if (!KEY_RE.test(k)) throw new InputError("Use a short key of lowercase letters, digits and _, like windows_exterior.", f);
      if (before && before.key && before.key !== k) throw new InputError("A checklist's key never changes.", f);
      return k;
    },
    name: (v, f) => str(v, { field: f, max: 80, required: true }),
    service_types: strList(20, 120),
    job_kinds: (v, f) => [...new Set(arr(v, (x, ff) => enumValue(x, JOB_KINDS, { field: ff, stored: true }), { field: f, max: 6 }).filter(Boolean))],
    items: (v, f) => {
      const list = arr(v, (x, ff) => {
        if (!isObj(x)) throw new InputError("Expected an item.", ff);
        const key = String(x.key ?? "").trim();
        if (!KEY_RE.test(key)) throw new InputError("Each item needs a short key.", `${ff}.key`);
        return { key, label: str(x.label, { field: `${ff}.label`, max: 120, required: true }), required: x.required === true, kind: enumValue(x.kind, CHECK_KINDS, { field: `${ff}.kind`, stored: true }) || "check" };
      }, { field: f, max: 40 });
      const keys = new Set();
      list.forEach((x, i) => { if (keys.has(x.key)) throw new InputError("Two items share a key.", `${f}.${i}.key`); keys.add(x.key); });
      return list;
    },
    active: (v, f) => (v === undefined ? true : bool(v, { field: f })),
    order: (v, f) => int(v ?? 50, { field: f, min: 0, max: 1000 }),
  });
  return out;
}

export const checklistRow = (r) => ({ k: r.key, n: r.name, svc: r.service_types || [], jk: r.job_kinds || [], ni: (r.items || []).length, nr: (r.items || []).filter((i) => i.required).length, act: r.active !== false, o: r.order ?? 50, u: r.updated_at });

export const checklistTemplateType = defineType({
  type: "checklist_template",
  prefix: "ck",
  v: 1,
  validate: validateChecklistTemplate,
  rotorFields: [],
  techFields: ["id", "key", "name", "items"],
  readPerm: "schedule:read",
  shadow: false,
  indexes: [{ name: "checklists", shard: () => "", row: checklistRow }],
  pointers: [{ kind: "checklist-key", key: (r) => r.key }],
  summary: (r) => ({ id: r.id, key: r.key, name: r.name }),
  example: () => ({ key: "sample_list", name: "Sample checklist", service_types: ["Residential Window Cleaning"], job_kinds: [], items: [{ key: "glass", label: "Glass", required: false, kind: "check" }], active: true, order: 50 }),
});

// ------------------------------------------------------------ time_off

export function validateTimeOff(data) {
  const out = shape(data, {
    user_id: requiredId("user", "Pick someone on the team."),
    start_at: (v, f) => isoTime(v, { field: f, required: true }),
    end_at: isoOpt,
    available: (v, f) => (v === undefined ? false : bool(v, { field: f })),
    reason: (v, f) => str(v, { field: f, max: 120 }) || "",
    all_day: (v) => (v === true ? true : undefined),
  });
  if (out.end_at && Date.parse(out.end_at) < Date.parse(out.start_at)) throw new InputError("It ends after it starts.", "end_at");
  return clean(out);
}

export const timeOffRow = (r) => ({ uid: r.user_id, s: r.start_at, e: r.end_at || null, av: r.available === true, r: String(r.reason || "").slice(0, 60), ad: r.all_day === true, u: r.updated_at });

export const timeOffType = defineType({
  type: "time_off",
  prefix: "to",
  v: 1,
  validate: validateTimeOff,
  rotorFields: ["user_id", "start_at", "end_at", "available", "reason", "rotor"],
  techFields: ["id", "user_id", "start_at", "end_at", "available"],
  readPerm: "schedule:read",
  shadow: false,
  indexes: [{ name: "time-off", shard: () => "", row: timeOffRow }],
  pointers: [{ kind: "rotor/time_off", key: (r) => (r.rotor && r.rotor.exception_id !== undefined && r.rotor.exception_id !== null ? rotorKey(r.rotor.exception_id) : null) }],
  summary: (r) => ({ id: r.id, user_id: r.user_id, start_at: r.start_at, end_at: r.end_at || null }),
  example: () => ({ user_id: "us_0000000000000000000a", start_at: "2026-11-20T14:00:00.000Z", end_at: "2026-11-21T00:00:00.000Z", available: false, reason: "Vacation" }),
});

export const types = [jobType, visitType, checklistTemplateType, timeOffType];
