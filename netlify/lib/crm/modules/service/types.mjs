// Service module: the request record (scratchpad simplify/guide-gaps.md S4).
//
//   request   an ask for work or an on-site look: who (contact, property),
//             where it came from (portal, website, phone, office, import),
//             the services and timing they named, notes and photos, who
//             works it, the assessment (an estimate visit task with a time,
//             so it shows on the Schedule), and what it became (a quote or a
//             job) or why it was closed. Index "requests": an "open" shard
//             (new, assessment booked, assessed) and one per year for the
//             converted and closed ones.
//
// The CRM's own record: Rotor's requests stay in Rotor (rotorFields empty).

import { defineType } from "../../core/registry.mjs";
import { InputError } from "../../core/errors.mjs";
import { shape, str, enumValue, arr, isoTime, id as idOf, date as dateOf, time as timeOf } from "../../core/validate.mjs";

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

export const REQUEST_SOURCES = Object.freeze(["portal", "website", "phone", "office", "import"]);
export const REQUEST_STATUSES = Object.freeze(["new", "assessment_booked", "assessed", "converted", "closed"]);
export const OPEN_REQUEST = Object.freeze(["new", "assessment_booked", "assessed"]);
export const CLOSE_REASONS = Object.freeze(["no_answer", "not_interested", "too_far", "duplicate", "spam", "other"]);

const sortOf = (iso) => String(iso || "").replace(/[^0-9]/g, "").slice(0, 17).padEnd(17, "0");

function validateAssessment(v, f) {
  if (v === undefined || v === null) return undefined;
  if (!isObj(v)) throw new InputError("Expected the assessment.", f);
  const out = shape(v, {
    date: (x, ff) => dateOf(x, { field: ff, required: true }),
    start: (x, ff) => timeOf(x, { field: ff, required: true }),
    end: (x, ff) => timeOf(x, { field: ff, required: true }),
    user_id: (x, ff) => idOf(x, "user", { field: ff }),
    task_id: (x, ff) => idOf(x, "task", { field: ff }),
    done_at: (x, ff) => isoTime(x, { field: ff }),
  });
  if (out.end <= out.start) throw new InputError("The assessment ends after it starts.", `${f}.end`);
  return out;
}

export function validateRequest(data, { op } = {}) {
  const stored = op === "update";
  return shape(data, {
    contact_id: (v, f) => idOf(v, "contact", { field: f, required: true }),
    contact_name: (v, f) => str(v, { field: f, max: 120 }) || undefined,
    property_id: (v, f) => idOf(v, "property", { field: f }),
    source: (v, f) => enumValue(v, REQUEST_SOURCES, { field: f, stored }) || "office",
    services: (v, f) => arr(v, (x, ff) => str(x, { field: ff, max: 60, required: true }), { field: f, max: 12 }),
    timing: (v, f) => str(v, { field: f, max: 60 }) || undefined,
    notes: (v, f) => str(v, { field: f, max: 4000, trim: false }),
    photo_ids: (v, f) => arr(v, (x, ff) => idOf(x, "file", { field: ff, required: true }), { field: f, max: 10 }),
    status: (v, f) => enumValue(v, REQUEST_STATUSES, { field: f, stored }) || "new",
    assignee_id: (v, f) => idOf(v, "user", { field: f }),
    assessment: validateAssessment,
    converted: (v, f) => {
      if (v === undefined || v === null) return undefined;
      if (!isObj(v)) throw new InputError("Expected what it became.", f);
      return shape(v, { quote_id: (x, ff) => idOf(x, "quote", { field: ff }), job_id: (x, ff) => idOf(x, "job", { field: ff }), at: (x, ff) => isoTime(x, { field: ff }) });
    },
    closed_reason: (v, f) => enumValue(v, CLOSE_REASONS, { field: f, stored }),
    closed_note: (v, f) => str(v, { field: f, max: 300 }) || undefined,
    closed_at: (v, f) => isoTime(v, { field: f }),
    task_id: (v, f) => idOf(v, "task", { field: f }),
  });
}

export function requestShard(r) {
  if (OPEN_REQUEST.includes(r.status)) return "open";
  const y = String((r.converted && r.converted.at) || r.closed_at || r.updated_at || r.created_at || "").slice(0, 4);
  return /^\d{4}$/.test(y) ? y : "open";
}
export const requestRow = (r) => ({
  c: r.contact_id, cn: r.contact_name || "", st: r.status, src: r.source || "office", svc: (r.services || []).slice(0, 4), tm: r.timing || null,
  as: r.assignee_id || null, ad: (r.assessment && r.assessment.date) || null, au: (r.assessment && r.assessment.user_id) || null,
  cv: r.converted ? (r.converted.job_id ? "job" : "quote") : null, ph: (r.photo_ids || []).length, pr: r.property_id || null,
  at: r.created_at, u: r.updated_at,
});

export const requestType = defineType({
  type: "request",
  prefix: "rq",
  v: 1,
  validate: validateRequest,
  rotorFields: [],
  techFields: ["id"],
  readPerm: "requests:read",
  indexes: [{ name: "requests", shard: (r) => (r.deleted_at ? null : requestShard(r)), row: requestRow }],
  rels: [{ rel: "contact-requests", parent: (r) => r.contact_id, sort: (r) => sortOf(r.created_at) }],
  summary: (r) => ({ id: r.id, status: r.status, source: r.source }),
  example: () => ({
    contact_id: "ct_0000000000000000000a", contact_name: "Pat Example", source: "phone", services: ["Exterior windows"], timing: "This month",
    notes: "Two story, a dog in the back yard.", photo_ids: [], status: "new",
  }),
});

export const types = [requestType];
