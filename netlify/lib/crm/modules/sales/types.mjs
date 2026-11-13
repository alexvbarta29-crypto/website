// Record types of the sales module: deal, cadence, enrollment, task (design
// §3.3, §5.2). Each is a defineType() object with rotorFields, techFields
// and example() (§3.14).
//
// The three things Rotor kept in one "pipeline" are separate here (R9):
//   deal        is this sale open, quoted, won, lost or abandoned
//   cadence     a timed script of touches (Settings → Cadences)
//   enrollment  one contact working through one cadence (one open per
//               contact and cadence: ptr/enroll/{cid}--{cadenceId}, claimed
//               with the open-pointer rule by enroll.mjs, not by the type)
//   task        a to-do, an incident, a touch-up, an estimate visit...
//
// Validators keep unknown fields and keep a stored enum value this code
// doesn't know (§3.14 schema rules). Index rows use short keys and never
// hold notes or message bodies (§3.5).

import { defineType } from "../../core/registry.mjs";
import { isId } from "../../core/ids.mjs";
import { tsKey, nowIso, isLocalDate, isLocalTime, localDate, now } from "../../core/clock.mjs";
import { InputError } from "../../core/errors.mjs";
import { shape, str, enumValue, bool, arr, isoTime, int } from "../../core/validate.mjs";
import { truncate } from "../../core/text.mjs";
import { rotorKey } from "../contacts/display.mjs";

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const sortOf = (at) => tsKey(new Date(Date.parse(at) || 0));

// ------------------------------------------------------------ vocabulary

export const DEAL_STATUSES = Object.freeze(["open", "quoted", "won", "lost", "abandoned"]);
export const OPEN_DEAL = Object.freeze(["open", "quoted"]);
export const DEAL_LINES = Object.freeze(["windows", "gutters", "lights", "mixed", "other"]);
export const LOST_REASONS = Object.freeze(["price", "timing", "competitor", "no_response", "out_of_area", "spam", "other"]);

export const ENROLLMENT_STATUSES = Object.freeze(["active", "paused", "completed", "stopped", "archived"]);
export const OPEN_ENROLLMENT = Object.freeze(["active", "paused"]);
// §5.2's reasons, plus quote_sent (the new-lead cadence hands over to the
// estimate follow-up) and wrong_number (a call outcome).
export const STOP_REASONS = Object.freeze(["replied", "inbound_call", "booked", "opted_out", "won", "lost", "manual", "expired", "duplicate", "imported", "quote_sent", "wrong_number"]);
export const CALL_OUTCOMES = Object.freeze(["calling", "no_answer", "voicemail", "spoke", "booked", "not_interested", "wrong_number"]);

export const STEP_ACTIONS = Object.freeze(["call_then_text", "text", "call", "email", "task", "archive_quote"]);
export const TEXT_ACTIONS = Object.freeze(["call_then_text", "text"]);
export const WINDOWED = Object.freeze(["call_then_text", "text", "call", "email"]);
export const OFFERS = Object.freeze(["followup_50", "ten_free_screens"]);
export const ENTRY_ON = Object.freeze(["lead.created", "quote.sent", "tag.added", "manual"]);
export const EXIT_ON = Object.freeze(["reply", "inbound_call", "booked", "quote_sent", "quote_approved", "quote_declined", "changes_requested", "opted_out", "won", "lost"]);
export const ON_REPLY = Object.freeze(["pause", "stop"]);
export const UNATTENDED = Object.freeze(["wait", "text_anyway"]);
export const MAX_STEPS = 30;
export const MAX_HISTORY = 60;
export const MAX_DEAL_HISTORY = 30;

export const TASK_KINDS = Object.freeze(["todo", "call", "estimate_visit", "incident", "touch_up", "follow_up", "personal", "meeting", "approval"]);
export const TASK_PRIORITIES = Object.freeze(["low", "medium", "high"]);
export const TASK_STATUSES = Object.freeze(["open", "in_progress", "waiting", "done", "cancelled"]);
export const OPEN_TASK = Object.freeze(["open", "in_progress", "waiting"]);
export const APPROVAL_KINDS = Object.freeze(["late_cancel_fee", "clawback", "overpayment", "two_stripe_customers", "card_failed"]);

const TEMPLATE_KEY_RE = /^[a-z][a-z0-9_]{1,39}$/;
const CADENCE_KEY_RE = /^[a-z][a-z0-9_]{1,39}$/;

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
const userIds = (v, f) => ids("user", 20)(v, f);
const isoOpt = (v, f) => isoTime(v, { field: f });

// ------------------------------------------------------------ deal

// "Exterior Window Cleaning", "Gutter Cleaning" → windows / gutters / lights / mixed / other.
export function lineOf(services = []) {
  const lines = new Set();
  for (const s of services) {
    const t = String(s || "").toLowerCase();
    if (/light/.test(t)) lines.add("lights");
    else if (/gutter/.test(t)) lines.add("gutters");
    else if (/window|screen|track|glass/.test(t)) lines.add("windows");
    else if (t) lines.add("other");
  }
  if (!lines.size) return "other";
  return lines.size > 1 ? "mixed" : [...lines][0];
}
export const titleOf = (services = []) => (services.length ? truncate(services.join(" + "), 120) : "New lead");

function validateSource(v, f) {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "string") return { source: str(v, { field: `${f}.source`, max: 60 }) || "Other" };
  if (!isObj(v)) throw new InputError("Pick where they came from.", f);
  return { ...v, source: str(v.source, { field: `${f}.source`, max: 60 }) || "Other" };
}

function validateDealHistory(v, f) {
  const list = arr(v, (x, ff) => {
    if (!isObj(x)) throw new InputError("Expected a history row.", ff);
    return { ...x, at: isoTime(x.at, { field: `${ff}.at` }) || null, kind: str(x.kind, { field: `${ff}.kind`, max: 40 }) || "note" };
  }, { field: f, max: 500 });
  return list.slice(-MAX_DEAL_HISTORY);
}

export function validateDeal(data, { op, before } = {}) {
  const stored = op === "update";
  const out = shape(data, {
    contact_id: requiredId("contact", "A deal belongs to a contact."),
    property_id: idOf("property"),
    services: (v, f) => [...new Set(arr(v, (x, ff) => str(x, { field: ff, max: 80 }), { field: f, max: 20 }).filter(Boolean))],
    line: (v, f) => enumValue(v, DEAL_LINES, { field: f, stored }),
    title: (v, f) => str(v, { field: f, max: 120 }) || undefined,
    source: (v, f) => validateSource(v, f),
    status: (v, f) => enumValue(v, DEAL_STATUSES, { field: f, stored }) || "open",
    value_cents: (v, f) => int(v, { field: f, min: 0, max: 100000000 }),
    quote_ids: (v, f) => ids("quote")(v, f),
    job_ids: (v, f) => ids("job")(v, f),
    plan_ids: (v, f) => ids("plan")(v, f),
    owner_id: idOf("user"),
    sold_by: idOf("user"),
    opened_at: isoOpt,
    quoted_at: isoOpt,
    won_at: isoOpt,
    lost_at: isoOpt,
    abandoned_at: isoOpt,
    last_activity_at: isoOpt,
    lost_reason: (v, f) => enumValue(v, LOST_REASONS, { field: f, stored }),
    lost_note: (v, f) => str(v, { field: f, max: 500 }) || undefined,
    history: (v, f) => validateDealHistory(v, f),
    contact_name: (v, f) => str(v, { field: f, max: 120 }) || undefined,
  });
  if (!out.line) out.line = lineOf(out.services);
  if (!out.title) out.title = titleOf(out.services);
  if (!out.opened_at) out.opened_at = (before && before.opened_at) || out.created_at || nowIso();
  if (out.status !== "lost" && !stored) { delete out.lost_reason; delete out.lost_note; }
  return out;
}

export const dealRow = (r) => ({
  c: r.contact_id, cn: r.contact_name || "", t: r.title, st: r.status, v: r.value_cents ?? null, op: r.opened_at || null,
  la: r.last_activity_at || null, ow: r.owner_id || null, u: r.updated_at,
});

export const dealType = defineType({
  type: "deal",
  prefix: "dl",
  v: 1,
  validate: validateDeal,
  // §3.3's list plus what the opportunities phase maps (its history and dates)
  rotorFields: ["services", "value_cents", "status", "lost_reason", "rotor", "history", "opened_at", "won_at", "lost_at", "abandoned_at"],
  techFields: ["id"],
  readPerm: "sales:work",
  indexes: [{ name: "deals/open", shard: (r) => (OPEN_DEAL.includes(r.status) ? "" : null), row: dealRow }],
  rels: [{ rel: "contact-deals", parent: (r) => r.contact_id, sort: (r) => sortOf(r.opened_at || r.created_at) }],
  summary: (r) => ({ id: r.id, title: r.title, status: r.status }),
  example: () => ({
    contact_id: "ct_0000000000000000000a", title: "Windows + screens", services: ["Exterior Window Cleaning", "Screen Cleaning"], line: "windows",
    source: { source: "Website quote form" }, status: "open", quote_ids: [], job_ids: [], plan_ids: [], history: [], opened_at: "2026-11-17T15:00:00.000Z",
  }),
});

// ------------------------------------------------------------ cadence

function validateWindow(v, f, required) {
  if (v === undefined || v === null) {
    if (required) throw new InputError("Pick a time window.", f);
    return undefined;
  }
  if (!isObj(v) || !isLocalTime(v.start) || !isLocalTime(v.end) || v.start >= v.end) throw new InputError("Use a window like 09:00 to 10:00.", f);
  return { start: v.start, end: v.end };
}

function validateStep(v, f, { stored }) {
  if (!isObj(v)) throw new InputError("Expected a step.", f);
  const action = enumValue(v.action, STEP_ACTIONS, { field: `${f}.action`, required: true, stored });
  const out = {
    ...v,
    day: int(v.day, { field: `${f}.day`, min: 1, max: 60, required: true }),
    action,
    label: str(v.label, { field: `${f}.label`, max: 80 }) || "",
  };
  out.window = validateWindow(v.window, `${f}.window`, WINDOWED.includes(action));
  if (!out.window) delete out.window;
  if (TEXT_ACTIONS.includes(action) || action === "email") {
    const k = String(v.template_key ?? "").trim();
    if (!TEMPLATE_KEY_RE.test(k)) throw new InputError("Pick the text this step sends.", `${f}.template_key`);
    out.template_key = k;
  } else if (v.template_key !== undefined && v.template_key !== null && v.template_key !== "") {
    if (!TEMPLATE_KEY_RE.test(String(v.template_key))) throw new InputError("That isn't a template.", `${f}.template_key`);
  } else delete out.template_key;
  if (v.offer === undefined || v.offer === null || v.offer === "") delete out.offer;
  else out.offer = enumValue(v.offer, OFFERS, { field: `${f}.offer`, stored });
  out.review_before_send = bool(v.review_before_send ?? false, { field: `${f}.review_before_send` });
  out.archive_quote = bool(v.archive_quote ?? false, { field: `${f}.archive_quote` });
  if (!out.archive_quote) delete out.archive_quote;
  if (action === "task") out.task_title = str(v.task_title, { field: `${f}.task_title`, max: 120 }) || "Follow up";
  else if (v.task_title !== undefined) delete out.task_title;
  return out;
}

// Step ids (s1, s2, ...): kept as the editor sends them back, new steps get
// the next unused number (step_seq never goes down, so an id is never
// reused). A client that sends no ids at all keeps the old ids by position.
// A removed step's id maps to the next step that survived (moved), so an
// enrollment on it carries on there. steps_v counts changes to the steps.
export const STEP_ID_RE = /^s[1-9]\d{0,5}$/;
const MAX_MOVED = 200;
const idNum = (id) => (typeof id === "string" && STEP_ID_RE.test(id) ? Number(id.slice(1)) : 0);
const stripN = (steps) => JSON.stringify((steps || []).map(({ n, ...st }) => st));
function stepIds(out, before) {
  const prevSteps = (before && Array.isArray(before.steps)) ? before.steps : [];
  const prevIds = prevSteps.map((st, i) => (STEP_ID_RE.test(String(st.id || "")) ? st.id : `s${i + 1}`));
  const incoming = out.steps || [];
  const anyId = incoming.some((st) => STEP_ID_RE.test(String(st.id || "")));
  let seq = Math.max(Number(before && before.step_seq) || 0, ...prevIds.map(idNum), ...incoming.map((st) => idNum(st.id)), 0);
  const used = new Set();
  out.steps = incoming.map((st, i) => {
    let id = STEP_ID_RE.test(String(st.id || "")) && !used.has(st.id) ? st.id : null;
    if (!id && !anyId && prevIds[i] && !used.has(prevIds[i])) id = prevIds[i];
    if (!id) { seq += 1; id = `s${seq}`; }
    used.add(id);
    return { ...st, id, n: i + 1 };
  });
  out.step_seq = Math.max(seq, ...out.steps.map((st) => idNum(st.id)), 0);
  const moved = { ...((before && before.moved) || {}) };
  prevIds.forEach((id, i) => {
    if (used.has(id)) { delete moved[id]; return; }
    moved[id] = prevIds.slice(i + 1).find((x) => used.has(x)) || null;
  });
  const keys = Object.keys(moved);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_MOVED))) delete moved[k];
  if (Object.keys(moved).length) out.moved = moved; else delete out.moved;
  const changed = !before || stripN(before.steps) !== stripN(out.steps);
  out.steps_v = (Number(before && before.steps_v) || (before ? 1 : 0)) + (changed ? 1 : 0);
}

export function validateCadence(data, { op, before } = {}) {
  const stored = op === "update";
  const out = shape(data, {
    key: (v, f) => {
      const k = String(v ?? "").trim();
      if (!CADENCE_KEY_RE.test(k)) throw new InputError("Use a short key of lowercase letters, digits and _, like new_lead.", f);
      if (before && before.key && before.key !== k) throw new InputError("A cadence's key never changes.", f);
      return k;
    },
    name: (v, f) => str(v, { field: f, max: 80, required: true }),
    active: (v, f) => (v === undefined ? true : bool(v, { field: f })),
    board_only: (v, f) => bool(v ?? false, { field: f }),
    entry: (v, f) => {
      const e = isObj(v) ? { ...v } : {};
      if (v !== undefined && v !== null && !isObj(v)) throw new InputError("Expected when someone joins.", f);
      e.on = enumValue(e.on, ENTRY_ON, { field: `${f}.on`, stored }) || "manual";
      if (e.sources !== undefined) e.sources = [...new Set(arr(e.sources, (x, ff) => str(x, { field: ff, max: 60 }), { field: `${f}.sources`, max: 40 }).filter(Boolean))];
      if (e.exclude_tags !== undefined) e.exclude_tags = [...new Set(arr(e.exclude_tags, (x, ff) => str(x, { field: ff, max: 40 }), { field: `${f}.exclude_tags`, max: 20 }).filter(Boolean))];
      if (e.tag !== undefined) e.tag = str(e.tag, { field: `${f}.tag`, max: 40 }) || undefined;
      for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
      return e;
    },
    exit_on: (v, f) => [...new Set(arr(v, (x, ff) => enumValue(x, EXIT_ON, { field: ff, stored: true }), { field: f, max: 20 }).filter(Boolean))],
    on_reply: (v, f) => enumValue(v, ON_REPLY, { field: f, stored }) || "pause",
    unattended: (v, f) => enumValue(v, UNATTENDED, { field: f, stored }) || "wait",
    steps: (v, f) => arr(v, (x, ff) => validateStep(x, ff, { stored }), { field: f, max: MAX_STEPS }),
    board_stages: (v, f) => arr(v, (x, ff) => str(x, { field: ff, max: 60 }), { field: f, max: 20 }).filter(Boolean),
    description: (v, f) => str(v, { field: f, max: 300 }) || undefined,
  });
  // steps are numbered in order and keep their ids; their days never go backwards
  stepIds(out, before);
  for (let i = 1; i < out.steps.length; i++) {
    if (out.steps[i].day < out.steps[i - 1].day) throw new InputError("Steps go in day order.", `steps.${i}.day`);
  }
  if (out.board_only && out.steps.length) throw new InputError("A board has no steps.", "steps");
  // D7 / D21: a cadence whose texts are read before sending never texts on its own
  if (out.unattended === "text_anyway" && out.steps.some((s) => s.review_before_send)) {
    throw new InputError("This cadence's texts are read before sending, so they can't go out on their own. Pick \"wait\".", "unattended");
  }
  return out;
}

export const cadenceRow = (r) => ({ k: r.key, n: r.name, act: r.active !== false, bo: !!r.board_only, s: (r.steps || []).length, ua: r.unattended || "wait", on: (r.entry && r.entry.on) || "manual", sv: r.steps_v || 0, u: r.updated_at });

export const cadenceType = defineType({
  type: "cadence",
  prefix: "cd",
  v: 1,
  validate: validateCadence,
  rotorFields: ["rotor"],
  techFields: ["id", "key", "name"],
  readPerm: "sales:work",
  shadow: false,
  indexes: [{ name: "cadences", shard: () => "", row: cadenceRow }],
  pointers: [
    { kind: "cadence-key", key: (r) => r.key },
    { kind: "rotor/pipeline", key: (r) => (r.rotor && r.rotor.pipeline_id ? rotorKey(r.rotor.pipeline_id) : null) },
  ],
  summary: (r) => ({ id: r.id, key: r.key, name: r.name }),
  example: () => ({
    key: "sample_cadence", name: "Sample cadence", active: true, board_only: false, entry: { on: "manual" }, exit_on: ["reply"], on_reply: "pause", unattended: "wait",
    steps: [{ n: 1, day: 1, window: { start: "09:00", end: "10:00" }, action: "call_then_text", template_key: "cad_new_1", review_before_send: false, label: "Day 1 - Call + text" }],
  }),
});

// ------------------------------------------------------------ enrollment

function validateHistory(v, f) {
  const list = arr(v, (x, ff) => {
    if (!isObj(x)) throw new InputError("Expected a history row.", ff);
    return { ...x, n: Number.isSafeInteger(x.n) ? x.n : 0, at: isoTime(x.at, { field: `${ff}.at` }) || nowIso(), action: str(x.action, { field: `${ff}.action`, max: 30 }) || "note" };
  }, { field: f, max: 1000 });
  return list.slice(-MAX_HISTORY);
}

export function validateEnrollment(data, { op } = {}) {
  const stored = op === "update";
  const out = shape(data, {
    contact_id: requiredId("contact", "An enrollment belongs to a contact."),
    cadence_id: requiredId("cadence", "Pick a cadence."),
    cadence_key: (v, f) => str(v, { field: f, max: 40 }) || undefined,
    deal_id: idOf("deal"),
    quote_id: idOf("quote"),
    status: (v, f) => enumValue(v, ENROLLMENT_STATUSES, { field: f, stored }) || "active",
    stop_reason: (v, f) => enumValue(v, STOP_REASONS, { field: f, stored }),
    step_n: (v, f) => int(v ?? 1, { field: f, min: 0, max: 1000 }),
    step_id: (v, f) => {
      if (v === undefined || v === null || v === "") return undefined;
      if (!STEP_ID_RE.test(String(v))) throw new InputError("That isn't a step.", f);
      return v;
    },
    steps_v: (v, f) => (v === undefined || v === null ? undefined : int(v, { field: f, min: 0, max: 1e9 })),
    next_due_at: isoOpt,
    due_end: isoOpt,
    day1: (v, f) => {
      if (v === undefined || v === null || v === "") return undefined;
      if (!isLocalDate(v)) throw new InputError("Use a date like 2026-11-17.", f);
      return v;
    },
    history: (v, f) => validateHistory(v, f),
    started_at: isoOpt,
    ended_at: isoOpt,
    paused_at: isoOpt,
    paused_reason: (v, f) => str(v, { field: f, max: 40 }) || undefined,
    pending: (v, f) => {
      if (v === undefined || v === null) return undefined;
      if (!isObj(v) || !["hand", "compose"].includes(v.kind) || !Number.isSafeInteger(v.n)) throw new InputError("Expected a pending text.", f);
      return { ...v, text: v.text === undefined ? undefined : str(v.text, { field: `${f}.text`, max: 1600, trim: false }) };
    },
    cur: (v, f) => {
      if (v === undefined || v === null) return undefined;
      if (!isObj(v)) throw new InputError("Expected the current step.", f);
      return { ...v };
    },
    contact_name: (v, f) => str(v, { field: f, max: 120 }) || undefined,
    owner_id: idOf("user"),
    last_touch_at: isoOpt,
  });
  if (!out.started_at) out.started_at = out.created_at || nowIso();
  if (out.pending && out.pending.text === undefined) delete out.pending.text;
  return out;
}

export const enrollmentRow = (r) => {
  const cur = r.cur || {};
  return {
    c: r.contact_id, cn: r.contact_name || "", cad: r.cadence_key || null, cd: r.cadence_id, n: r.step_n, lbl: cur.label || "", act: cur.action || null,
    sid: r.step_id || null, sv: r.steps_v || 0,
    rbs: !!cur.rbs, due: r.next_due_at || null, de: r.due_end || null, st: r.status, pd: r.pending ? r.pending.kind : null, pn: r.pending ? r.pending.n : null,
    ph: (r.pending && r.pending.hold_until) || null,
    dl: r.deal_id || null, sa: r.started_at || null, lt: r.last_touch_at || null, ps: r.paused_at || null, pr: r.paused_reason || null, ow: r.owner_id || null,
    ...(r.source_label ? { sl: r.source_label } : {}), u: r.updated_at,
  };
};

export const enrollmentType = defineType({
  type: "enrollment",
  prefix: "en",
  v: 1,
  validate: validateEnrollment,
  // §3.3's list plus what the opportunities phase maps (the step its stage stands for, when, whose)
  rotorFields: ["status", "stop_reason", "history", "rotor", "step_n", "cur", "started_at", "ended_at", "deal_id", "owner_id"],
  techFields: ["id"],
  readPerm: "sales:work",
  indexes: [{ name: "enrollments/active", shard: (r) => (OPEN_ENROLLMENT.includes(r.status) ? "" : null), row: enrollmentRow }],
  rels: [{ rel: "contact-enrollments", parent: (r) => r.contact_id, sort: (r) => sortOf(r.started_at || r.created_at) }],
  // the Rotor opportunities an imported enrollment collapses (§10.2 row 14)
  pointers: [{ kind: "rotor/opportunity", keys: (r) => ((r.rotor && Array.isArray(r.rotor.opportunity_ids)) ? r.rotor.opportunity_ids.map(rotorKey).filter(Boolean) : []) }],
  summary: (r) => ({ id: r.id, cadence_key: r.cadence_key, status: r.status, step_n: r.step_n }),
  example: () => ({
    contact_id: "ct_0000000000000000000a", cadence_id: "cd_0000000000000000000a", cadence_key: "new_lead", status: "active", step_n: 1, history: [],
    day1: "2026-11-17", next_due_at: "2026-11-17T15:00:00.000Z", due_end: "2026-11-17T16:00:00.000Z", started_at: "2026-11-17T14:55:00.000Z",
  }),
});

// ------------------------------------------------------------ task

export function validateTask(data, { op, before } = {}) {
  const stored = op === "update";
  const out = shape(data, {
    title: (v, f) => str(v, { field: f, max: 160, required: true }),
    kind: (v, f) => enumValue(v, TASK_KINDS, { field: f, stored }) || "todo",
    priority: (v, f) => enumValue(v, TASK_PRIORITIES, { field: f, stored }),
    status: (v, f) => enumValue(v, TASK_STATUSES, { field: f, stored }) || "open",
    due_at: isoOpt,
    end_at: isoOpt,
    contact_id: idOf("contact"),
    property_id: idOf("property"),
    job_id: idOf("job"),
    visit_id: idOf("visit"),
    enrollment_id: idOf("enrollment"),
    deal_id: idOf("deal"),
    approval: (v, f) => {
      if (v === undefined || v === null) return undefined;
      if (!isObj(v) || typeof v.ref_id !== "string") throw new InputError("Expected an approval.", f);
      return { ...v, kind: enumValue(v.kind, APPROVAL_KINDS, { field: `${f}.kind`, required: true, stored: true }) };
    },
    assignee_ids: userIds,
    notes: (v, f) => str(v, { field: f, max: 4000, trim: false }),
    done_at: isoOpt,
    done_by: (v, f) => str(v, { field: f, max: 80 }) || undefined,
    reported_on: (v, f) => {
      if (v === undefined || v === null || v === "") return undefined;
      if (!isLocalDate(v)) throw new InputError("Use a date like 2026-11-17.", f);
      return v;
    },
    contact_name: (v, f) => str(v, { field: f, max: 120 }) || undefined,
  });
  if (!out.priority) out.priority = out.kind === "incident" ? "high" : "medium";
  if (out.kind === "incident" && !out.reported_on) out.reported_on = (before && before.reported_on) || localDate(now());
  if (out.due_at && out.end_at && Date.parse(out.end_at) < Date.parse(out.due_at)) throw new InputError("The end comes after the start.", "end_at");
  if (out.status === "done" && !out.done_at) out.done_at = nowIso();
  if (out.status !== "done" && out.done_at && !stored) delete out.done_at;
  return out;
}

export const taskRow = (r) => ({
  t: r.title, k: r.kind, pr: r.priority, st: r.status, due: r.due_at || null, end: r.end_at || null, c: r.contact_id || null, cn: r.contact_name || "",
  a: r.assignee_ids || [], rep: r.reported_on || null, en: r.enrollment_id || null, u: r.updated_at,
});

export const taskType = defineType({
  type: "task",
  prefix: "tk",
  v: 1,
  validate: validateTask,
  rotorFields: ["title", "kind", "priority", "status", "due_at", "end_at", "contact_id", "assignee_ids", "notes", "rotor"],
  techFields: ["id", "title", "kind", "priority", "status", "due_at", "end_at", "assignee_ids", "reported_on", "done_at"],
  readPerm: "tasks:read",
  indexes: [{ name: "tasks/open", shard: (r) => (OPEN_TASK.includes(r.status) ? "" : null), row: taskRow }],
  rels: [
    { rel: "contact-tasks", parent: (r) => r.contact_id || null, sort: (r) => sortOf(r.created_at) },
    { rel: "user-tasks", parent: (r) => (Array.isArray(r.assignee_ids) && r.assignee_ids[0]) || null, sort: (r) => sortOf(r.created_at) },
  ],
  pointers: [{ kind: "rotor/task", key: (r) => (r.rotor && r.rotor.task_id ? rotorKey(r.rotor.task_id) : null) }],
  summary: (r) => ({ id: r.id, title: r.title, kind: r.kind, status: r.status }),
  example: () => ({ title: "Call back after 3:30", kind: "call", priority: "medium", status: "open", assignee_ids: [], notes: "" }),
});

export const types = [dealType, cadenceType, enrollmentType, taskType];
export { clone };
