// Sales module: Claude's sales tools (design §6.9; the MCP endpoint itself
// arrives with M7c, which reads every module's mcpTools). Each tool names its
// effect and permission; a write through an API key becomes a pending
// action an owner approves (M7c), never a direct change.
//
//   sales_call_list   who to call now, by window (read)
//   sales_lead        one contact's deals, follow-ups and open tasks (read)
//   sales_log_call    log a call's outcome (write: a pending action)

import { callList } from "./calls.mjs";
import { enrollmentsOf } from "./enroll.mjs";
import { relRecords, contactOf, nameOf } from "./common.mjs";
import { OPEN_TASK } from "./types.mjs";

const brief = (r) => ({ enrollment_id: r.id, contact_id: r.contact_id, name: r.name, cadence: r.cadence, step: r.n, label: r.label, due: r.due, overdue: !!r.overdue, waiting_text: !!r.pending });

export const mcpTools = [
  {
    name: "sales_call_list", effect: "read", perm: "sales:work",
    description: "Leads to call now and later today, grouped as the Leads & calls screen shows them.",
    inputSchema: { type: "object", properties: { date: { type: "string", description: "YYYY-MM-DD (default today)" } }, additionalProperties: false },
    run: async (input = {}) => {
      const d = await callList({ date: input.date });
      return { due: d.due.map(brief), later: d.later.map(brief), paused: d.paused.map(brief), counts: d.counts, sms_mode: d.sms_mode };
    },
  },
  {
    name: "sales_lead", effect: "read", perm: "sales:work",
    description: "One contact's deals, follow-up cadences and open tasks.",
    inputSchema: { type: "object", properties: { contact_id: { type: "string" } }, required: ["contact_id"], additionalProperties: false },
    run: async (input = {}, ctx = {}) => {
      const c = await contactOf(input.contact_id, ctx);
      if (!c) return { found: false };
      const [deals, enrollments, tasks] = await Promise.all([relRecords("contact-deals", "deal", c.id), enrollmentsOf(c.id), relRecords("contact-tasks", "task", c.id)]);
      return {
        found: true, contact_id: c.id, name: nameOf(c),
        deals: deals.map((d) => ({ id: d.id, title: d.title, status: d.status, value_cents: d.value_cents ?? null })),
        enrollments: enrollments.map((e) => ({ id: e.id, cadence: e.cadence_key, status: e.status, step: e.step_n, due: e.next_due_at || null })),
        open_tasks: tasks.filter((t) => OPEN_TASK.includes(t.status)).map((t) => ({ id: t.id, title: t.title, due_at: t.due_at || null })),
      };
    },
  },
  {
    name: "sales_log_call", effect: "write", perm: "sales:work",
    description: "Log the outcome of a call to a lead (no_answer, voicemail, spoke, booked, not_interested, wrong_number).",
    inputSchema: {
      type: "object",
      properties: { contact_id: { type: "string" }, enrollment_id: { type: "string" }, outcome: { type: "string", enum: ["no_answer", "voicemail", "spoke", "booked", "not_interested", "wrong_number"] }, note: { type: "string" } },
      required: ["contact_id", "outcome"], additionalProperties: false,
    },
    run: async (input = {}, ctx = {}) => {
      const { logCall } = await import("./calls.mjs");
      const r = await logCall({ ...input, direction: "out" }, ctx);
      return { logged: true, next: r.data.next ? r.data.next.kind : "none" };
    },
  },
];
