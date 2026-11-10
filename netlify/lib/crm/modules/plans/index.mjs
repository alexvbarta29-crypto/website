// Barta CRM module "plans" (M3b): care plans, agreements and Christmas
// lights seasons (design §5.4, §8.1, §9.2, §10.2 rows 17, 19-21, 25, §11.4
// M3b; decisions D9, D10, D27, D29, D30). docs/CRM-PLANS.md describes it.
//
// Files: types.mjs (plan, agreement_template, agreement, season_install),
// catalog.mjs (cfg/plans_catalog, cfg/lights), machine.mjs (the state
// machine and the term/ordinal arithmetic, pure), texts.mjs (the agreement
// drafts and message templates), agreements.mjs (templates, rendering,
// plans.agreementForOption, agreements, signing), plans.mjs (the lifecycle,
// plans.fromQuoteOption, actions, listeners, sweeps), lights.mjs (seasons),
// signatures.mjs (request signatures in bulk), automations.mjs
// (agreement.sent, agreement.unsigned, plan.renewal_notice, lights.rebook
// and the sweeps), render.mjs and portal.mjs (the customer's agreement,
// hub and login pages), routes.mjs (the staff API), import-rotor.mjs
// (import phases), mcp.mjs (Claude's plan tools).

import { defineModule } from "../../core/registry.mjs";
import { getRecord, updateRecord, listRel, readIndex } from "../../../crm-store.mjs";
import { defineFileOwner } from "../../core/files.mjs";
import { localDate, now } from "../../core/clock.mjs";
import { types } from "./types.mjs";
import { CATALOG_DEFAULTS, LIGHTS_DEFAULTS, validateCatalog, validateLights } from "./catalog.mjs";
import { TEMPLATES } from "./texts.mjs";
import { agreementForOption, seedAgreementTemplates } from "./agreements.mjs";
import { fromQuoteOption, listeners, touchPlanStats, W } from "./plans.mjs";
import "./signatures.mjs";
import { automations, sweeps } from "./automations.mjs";
import { portalRoutes } from "./portal.mjs";
import { planRoutes } from "./routes.mjs";
import { phases } from "./import-rotor.mjs";
import { mcpTools } from "./mcp.mjs";

// The drawn signature on an agreement (stored by the sign step; staff read it).
defineFileOwner("agreement", {
  canRead: (ctx) => ctx.can("plans:read"),
  canEdit: () => false,
});

// §5.1 merge: b's plans, agreements and lights seasons move to the survivor a.
async function onMergePlans(a, b, ctx = {}) {
  const w = W(ctx);
  const survivor = await getRecord("contact", a);
  const s = survivor && survivor.data;
  const name = s ? s.display_name || [s.first_name, s.last_name].filter(Boolean).join(" ") : undefined;
  for (const [type, rel] of [["plan", "contact-plans"], ["agreement", "contact-agreements"], ["season_install", "contact-seasons"]]) {
    for (const row of await listRel(rel, b, { limit: 500 })) {
      await updateRecord(type, row.id, (r) => (r.contact_id === b ? { ...r, contact_id: a, ...(name ? { contact_name: name } : {}) } : null), w).catch(() => null);
    }
  }
  await touchPlanStats(a, w);
}

const thisMonth = () => localDate(now()).slice(0, 7);
const dueCount = async () => (await readIndex("plans", "")).rows.filter((r) => ["active", "cancelling"].includes(r.st) && r.due && r.due <= thisMonth()).length;
const unsignedCount = async () => (await readIndex("agreements", "pending")).rows.filter((r) => ["sent", "viewed"].includes(r.st)).length;
const draftTemplates = async () => (await readIndex("agreement-templates", "")).rows.filter((r) => r.act !== false && !r.ap && (r.ck || []).length).length;
const clawbacks = async () => (await readIndex("plans", "")).rows.filter((r) => r.cb).length;

export default defineModule({
  name: "plans",
  types,
  statsParts: {
    // the plans part of ContactStats (§5.1): the contact's live plans (the index row's pl)
    plans: { defaults: { active_plan_ids: [] }, row: (p) => ({ pl: (p && p.active_plan_ids) || [] }) },
  },
  settings: {
    plans_catalog: { defaults: { ...CATALOG_DEFAULTS }, validate: validateCatalog, perm: "settings:owner" },
    lights: { defaults: { ...LIGHTS_DEFAULTS }, validate: validateLights, perm: "settings:owner" },
  },
  routes: planRoutes,
  portalRoutes,
  events: listeners,
  emits: ["plan.activated", "plan.paused", "plan.cancelled", "plan.renewed", "agreement.signed", "agreement.sent"],
  services: {
    // (quote, version, option, ctx) → { template_id, template_version, body_rendered, body_sha256 } | null
    "plans.agreementForOption": (quote, version, option) => agreementForOption(quote, version, option),
    // (quote, version, option, opId, { signature? }, ctx) → { plan_id, agreement_id?, job_ids }
    "plans.fromQuoteOption": (quote, version, option, opId, opts, ctx) => fromQuoteOption(quote, version, option, opId, opts || {}, ctx || {}),
  },
  needs: ["work.createJobs", "work.cancelJobs", "quotes.price", "bulk.create", "notify.users", "money.cardStatus", "contacts.findMatches"],
  sweeps,
  automations,
  templates: TEMPLATES,
  seeds: [{ v: 1, run: seedAgreementTemplates }],
  onMerge: onMergePlans,
  attention: [
    { key: "plans.due", label: "Plan visits to book", perm: "plans:read", count: dueCount, link: "#/plans/due" },
    { key: "agreements.unsigned", label: "Unsigned agreements", perm: "plans:read", count: unsignedCount, link: "#/plans?status=pending" },
  ],
  approvals: [
    { kind: "agreement_templates", label: "Agreement texts to approve", perm: "agreement_templates:edit", count: draftTemplates, link: "#/settings/agreement-templates" },
    { kind: "plans.clawback", label: "Clawbacks to bill", perm: "plans:cancel", count: clawbacks, link: "#/plans?status=clawback" },
  ],
  pushKinds: ["agreement_signed"],
  activityKinds: {
    "plan.created": { label: "Plan set up", icon: "check" },
    "plan.activated": { label: "Plan active", icon: "check" },
    "plan.paused": { label: "Plan paused", icon: "schedule" },
    "plan.cancelled": { label: "Plan cancelled", icon: "doc" },
    "plan.renewed": { label: "Plan renewed", icon: "check" },
  },
  exportTypes: ["plan", "agreement_template", "agreement", "season_install"],
  mcpTools,
  importPhases: phases,
});
