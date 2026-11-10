// Barta CRM module "sales" (M2b): deals, follow-up cadences, enrollments,
// tasks and calls (design §5.2, §5.7.4 lead.*, §7.6, §9.2 Leads & calls,
// Tasks, the contact's Sales tab, Settings → Cadences, §10.2 rows 13-15).
// docs/CRM-SALES.md describes it.
//
// Files: types.mjs (deal, cadence, enrollment, task), cadence.mjs (step
// timing and the enrollment's steps, pure), seed.mjs (the seeded cadences
// and texts), common.mjs (shared helpers), deals.mjs (deal status,
// sales.markDeal), enroll.mjs (enrollments, sales.enroll, sales.stopAll, a
// step's text), calls.mjs (calls, the call list, needs attention),
// tasks.mjs, listeners.mjs (lead.created, quote.*, job.completed,
// consent.changed, message.inbound, call.logged), automations.mjs (lead.ack,
// lead.alert, lead.attention and the sweeps), routes.mjs (the API),
// import-rotor.mjs (import phases), playbook.mjs (the office Follow-ups
// page's wording), mcp.mjs (Claude's sales tools).

import { defineModule } from "../../core/registry.mjs";
import { InputError } from "../../core/errors.mjs";
import { isLocalTime } from "../../core/clock.mjs";
import { isPlainObject } from "../../core/validate.mjs";
import { types } from "./types.mjs";
import { TEMPLATES, seedCadences } from "./seed.mjs";
import { SALES_DEFAULTS } from "./common.mjs";
import { enroll, stopAll } from "./enroll.mjs";
import { markDeal } from "./deals.mjs";
import { SALES_STATS } from "./calls.mjs";
import { listeners } from "./listeners.mjs";
import { automations, sweeps, attentionCount } from "./automations.mjs";
import { salesRoutes } from "./routes.mjs";
import { onMergeSales } from "./merge.mjs";
import { phases } from "./import-rotor.mjs";
import { mcpTools } from "./mcp.mjs";

function validateSales(v) {
  const src = isPlainObject(v) ? v : {};
  const out = {};
  const num = (k, min, max) => {
    if (src[k] === undefined) return;
    if (!Number.isInteger(src[k]) || src[k] < min || src[k] > max) throw new InputError(`Use a whole number from ${min} to ${max}.`, k);
    out[k] = src[k];
  };
  num("attention_hours", 1, 168);
  num("paused_attention_days", 1, 30);
  num("abandon_days", 7, 365);
  num("expire_days", 1, 90);
  num("ack_delay_min", 0, 120);
  num("calling_minutes", 5, 120);
  if (src.day_cutoff !== undefined) {
    if (!isLocalTime(src.day_cutoff)) throw new InputError("Use a time like 17:00.", "day_cutoff");
    out.day_cutoff = src.day_cutoff;
  }
  return out;
}

export default defineModule({
  name: "sales",
  types,
  statsParts: {
    // the sales part of ContactStats (§5.1): written by calls and texts
    sales: { defaults: { ...SALES_STATS }, row: (p) => ({ slc: (p && p.last_called_at) || null }) },
  },
  settings: { sales: { defaults: { ...SALES_DEFAULTS }, validate: validateSales, perm: "cadences:configure" } },
  routes: salesRoutes,
  events: listeners,
  emits: ["call.logged"],
  services: {
    // (contact_id, cadence_key, { quote_id?, deal_id? }, ctx) → enrollment_id | null
    "sales.enroll": (cid, key, opts, ctx) => enroll(cid, key, opts || {}, ctx || {}),
    // (contact_id, reason, ctx) → n
    "sales.stopAll": (cid, reason, ctx) => stopAll(cid, reason, ctx || {}),
    // (deal_id, status, { reason?, quote_id?, job_id?, plan_id? }, ctx)
    "sales.markDeal": (id, status, opts, ctx) => markDeal(id, status, opts || {}, ctx || {}),
  },
  // optional, from Quotes (M3a): the offer and archive steps of the estimate follow-up
  needs: ["contacts.resolve", "quotes.applyOffer", "quotes.archive"],
  sweeps,
  automations,
  templates: TEMPLATES,
  seeds: [{ v: 1, run: seedCadences }],
  onMerge: onMergeSales,
  attention: [{ key: "sales.attention", label: "Leads that need a call", perm: "sales:work", count: () => attentionCount(), link: "#/calls" }],
  pushKinds: ["new_lead"],
  activityKinds: {
    "call.no_answer": { label: "Called: no answer", icon: "phone" },
    "call.voicemail": { label: "Called: left a voicemail", icon: "phone" },
    "call.spoke": { label: "Called and talked", icon: "phone" },
    "call.booked": { label: "Called: booked", icon: "phone" },
    "call.not_interested": { label: "Called: not interested", icon: "phone" },
    "call.wrong_number": { label: "Called: wrong number", icon: "phone" },
    "call.in": { label: "They called in", icon: "phone" },
    "cadence.started": { label: "Follow-up started", icon: "clock" },
    "cadence.text_by_hand": { label: "Follow-up text sent by hand", icon: "text" },
    task: { label: "Task", icon: "check" },
  },
  exportTypes: ["deal", "cadence", "enrollment", "task"],
  mcpTools,
  importPhases: phases,
});
