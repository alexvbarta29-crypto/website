// Plans module: Claude's plan tools (design §6.9; the MCP endpoint itself
// arrives with M7c, which reads every module's mcpTools). Reads, one staff
// write (skip a visit), and the customer-facing ones as effect "contact"
// (pause, cancel, send an agreement): through an API key those become a
// pending action an owner approves (M7c), never a direct change.

import { getRecord } from "../../../crm-store.mjs";
import { isId } from "../../core/ids.mjs";
import { now, localDate } from "../../core/clock.mjs";
import { cancelQuote, ordinalTotals } from "./machine.mjs";
import { listPlans, plansDueList, startAction } from "./plans.mjs";
import { agreementForPlan, sendAgreement } from "./agreements.mjs";

const brief = (r) => ({ id: r.id, contact_id: r.c, contact_name: r.cn, plan: r.nm, catalog: r.ck, status: r.st, next_month: r.nx, autopay: !!r.ap, agreement: r.ag, term_end: r.te });

export const mcpTools = [
  {
    name: "list_plans", effect: "read", perm: "plans:read",
    description: "Care and lights plans: status, next visit month, autopay and agreement status. Filter by status (active, pending, paused, cancelling, cancelled, expired, due).",
    inputSchema: { type: "object", properties: { status: { type: "string" }, contact_id: { type: "string" } }, additionalProperties: false },
    run: async (input = {}) => ({ plans: (await listPlans({ status: input.status, contact: isId(input.contact_id, "contact") ? input.contact_id : undefined })).slice(0, 100).map(brief) }),
  },
  {
    name: "get_plan", effect: "read", perm: "plans:read",
    description: "One plan: terms, billing mode, perks, policy and every visit (term, number, target month, status, price in cents).",
    inputSchema: { type: "object", properties: { plan_id: { type: "string" } }, required: ["plan_id"], additionalProperties: false },
    run: async (input = {}) => {
      if (!isId(input.plan_id, "plan")) return { found: false };
      const g = await getRecord("plan", input.plan_id);
      if (!g || g.data.deleted_at) return { found: false };
      const p = g.data;
      return {
        found: true, id: p.id, name: p.name, status: p.status, pending_reasons: p.pending_reasons, contact_id: p.contact_id, catalog: p.catalog_key, term: p.term, billing: p.billing, perks: p.perks, policy: p.policy,
        agreement: p.agreement_status, sale_value_cents: p.sale_value_cents, visits: (p.ordinals || []).map((o) => ({ term: o.term, n: o.n, target_month: o.target_month, status: o.status, job_id: o.job_id || null, total_cents: ordinalTotals(p, o).total_cents })),
      };
    },
  },
  {
    name: "list_plan_visits_due", effect: "read", perm: "plans:read",
    description: "Plan visits due by a month (YYYY-MM, default this month) that have no visit booked yet, grouped by town.",
    inputSchema: { type: "object", properties: { month: { type: "string" } }, additionalProperties: false },
    run: async (input = {}) => plansDueList({ month: input.month }),
  },
  {
    name: "preview_plan_cancel", effect: "read", perm: "plans:read",
    description: "What cancelling a plan would mean: the effective date and the first-visit discount owed back (cents). Nothing changes.",
    inputSchema: { type: "object", properties: { plan_id: { type: "string" }, requested_on: { type: "string" } }, required: ["plan_id"], additionalProperties: false },
    run: async (input = {}) => {
      const g = isId(input.plan_id, "plan") ? await getRecord("plan", input.plan_id) : null;
      if (!g) return { found: false };
      return { found: true, ...cancelQuote(g.data, /^\d{4}-\d{2}-\d{2}$/.test(String(input.requested_on || "")) ? input.requested_on : localDate(now())) };
    },
  },
  {
    name: "skip_plan_visit", effect: "write", perm: "plans:write",
    description: "Skip one visit of a plan (no credit; the plan goes on). term defaults to 1.",
    inputSchema: { type: "object", properties: { plan_id: { type: "string" }, term: { type: "integer" }, n: { type: "integer" } }, required: ["plan_id", "n"], additionalProperties: false },
    run: async (input = {}, ctx = {}) => startAction(input.plan_id, "skip", { term: input.term || 1, n: input.n }, ctx),
  },
  {
    name: "pause_plan", effect: "contact", perm: "plans:write",
    description: "Pause a plan from a date (optionally until a date); booked visits in that time come off the schedule and the customer is told.",
    inputSchema: { type: "object", properties: { plan_id: { type: "string" }, from: { type: "string" }, until: { type: "string" }, reason: { type: "string" } }, required: ["plan_id"], additionalProperties: false },
    run: async (input = {}, ctx = {}) => startAction(input.plan_id, "pause", { from: input.from, until: input.until, reason: input.reason }, ctx),
  },
  {
    name: "cancel_plan", effect: "contact", perm: "plans:cancel",
    description: "Cancel a plan by the policy (7 days' notice inside the first term, else the end of the current term). Preview it first with preview_plan_cancel.",
    inputSchema: { type: "object", properties: { plan_id: { type: "string" }, reason: { type: "string", enum: ["price", "moving", "service", "not_needed", "other"] }, note: { type: "string" } }, required: ["plan_id", "reason"], additionalProperties: false },
    run: async (input = {}, ctx = {}) => startAction(input.plan_id, "cancel", { reason: input.reason, note: input.note }, ctx),
  },
  {
    name: "send_agreement", effect: "contact", perm: "agreements:send",
    description: "Send a plan's agreement to sign by text (the template's text must be owner-approved).",
    inputSchema: { type: "object", properties: { plan_id: { type: "string" } }, required: ["plan_id"], additionalProperties: false },
    run: async (input = {}, ctx = {}) => {
      const a = await agreementForPlan(input.plan_id, {}, ctx);
      const r = await sendAgreement(a.data.id, { channels: ["sms"] }, ctx);
      return { agreement_id: r.data.id, status: r.data.status };
    },
  },
];
