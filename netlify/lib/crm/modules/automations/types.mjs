// Automations module: record types.
//
// flow (prefix af): one custom automation, as catalog.mjs cleanFlow() keeps
//   it, plus deleted_at (a delete is soft: its run history stays readable).
//   Listed by trigger (rel/flows-by-trigger/{trigger}, value { on }) so an
//   event or the daily check reads one listing.
// flow_run (prefix ar): one start of a flow for one record (an event) or
//   for the day's list (a daily trigger; members[] are the contacts), with
//   the plan it follows (the steps and stop conditions as they were when it
//   started), where it is, and each step's outcome. Listed by flow
//   (rel/flow-runs/{flowId}). Bookkeeping like the run log: not a record
//   Rotor has, never a shadow, no audit row per write.

import { defineType } from "../../core/registry.mjs";
import { isId } from "../../core/ids.mjs";
import { tsKey } from "../../core/clock.mjs";
import { InputError } from "../../core/errors.mjs";
import { shape, str, enumValue, isoTime, int } from "../../core/validate.mjs";
import { cleanFlow } from "./catalog.mjs";

export const RUN_STATUSES = Object.freeze(["running", "waiting", "done", "stopped", "skipped", "failed"]);
export const STEP_STATUSES = Object.freeze(["pending", "waiting", "done", "queued", "would", "skipped", "bulk", "failed", "held"]);
const sortOf = (iso) => tsKey(new Date(Date.parse(iso || 0) || 0));
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

function validateFlow(data, { op } = {}) {
  const clean = cleanFlow(data);
  return { ...data, ...clean };
}

export const flowType = defineType({
  type: "flow",
  prefix: "af",
  v: 1,
  validate: validateFlow,
  rotorFields: [],
  techFields: ["id"],
  readPerm: "automations:configure",
  shadow: false,
  rels: [{ rel: "flows-by-trigger", parent: (r) => (r.deleted_at ? null : r.trigger && r.trigger.type), sort: (r) => sortOf(r.created_at), value: (r) => ({ on: r.enabled === true }) }],
  summary: (r) => ({ id: r.id, name: r.name, enabled: r.enabled === true }),
  example: () => ({
    name: "Quote follow-up", enabled: false, trigger: { type: "quote.sent" }, conditions: [],
    steps: [{ id: "s1", type: "text", template_key: "flow_quote_day3", wait: { n: 3, unit: "days" }, at: "10:00", business_hours: true }, { id: "s2", type: "task", title: "Call about their quote", assign: "owner" }],
    stop: [{ field: "replied", op: "yes" }], limits: { per_contact_days: 1 },
  }),
});

function validateRun(data, { op } = {}) {
  const stored = op === "update";
  const out = shape(data, {
    flow_id: (v, f) => { if (!isId(v, "flow")) throw new InputError("A run belongs to an automation.", f); return v; },
    flow_name: (v, f) => str(v, { field: f, max: 80 }),
    status: (v, f) => enumValue(v, RUN_STATUSES, { field: f, stored }) || "running",
    contact_id: (v, f) => (v === undefined || v === null ? undefined : isId(v, "contact") ? v : (() => { throw new InputError("That isn't a contact.", f); })()),
    started_at: (v, f) => isoTime(v, { field: f, required: true }),
    finished_at: (v, f) => isoTime(v, { field: f }),
    next_at: (v, f) => (v === null ? null : isoTime(v, { field: f })),
    step: (v, f) => int(v ?? 0, { field: f, min: 0, max: 100 }),
  });
  if (!Array.isArray(out.plan)) throw new InputError("A run needs its steps.", "plan");
  if (!Array.isArray(out.steps)) out.steps = out.plan.map(() => ({ status: "pending" }));
  if (out.members !== undefined && (!Array.isArray(out.members) || out.members.length > 200)) throw new InputError("At most 200 at a time.", "members");
  if (out.out !== undefined && !isObj(out.out)) throw new InputError("Expected who left the run.", "out");
  return out;
}

export const flowRunType = defineType({
  type: "flow_run",
  prefix: "ar",
  v: 1,
  validate: validateRun,
  rotorFields: [],
  techFields: ["id"],
  readPerm: "automations:configure",
  shadow: false,
  audit: false,
  rels: [{ rel: "flow-runs", parent: (r) => r.flow_id, sort: (r) => sortOf(r.started_at), value: (r) => ({ s: r.status, c: r.contact_id || null, n: r.members ? r.members.length : 1, t: r.test ? 1 : 0 }) }],
  summary: (r) => ({ id: r.id, flow_id: r.flow_id, status: r.status }),
  example: () => ({
    flow_id: "af_00000000000000000001", flow_name: "Quote follow-up", status: "done", trigger: { kind: "event", event: "quote.sent" },
    subject: { type: "contact", id: "ct_00000000000000000001" }, contact_id: "ct_00000000000000000001", started_at: "2026-11-17T15:00:00.000Z",
    plan: [{ id: "s1", type: "tag_add", tag: "Example" }], stop: [], steps: [{ status: "done", at: "2026-11-17T15:00:00.000Z", result: "done" }], step: 1,
  }),
});

export const types = [flowType, flowRunType];
