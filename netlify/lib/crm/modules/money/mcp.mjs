// Money module: Claude's money tools (design §6.9; the MCP endpoint itself
// arrives with M7c, which reads every module's mcpTools). Reads, and one
// customer-facing action (send an invoice: effect "contact", so through an
// API key it becomes a pending action an owner approves). Nothing here
// charges or refunds: payments:charge and payments:refund can never be on a
// key (§4.9).

import { getRecord, readIndex } from "../../../crm-store.mjs";
import { isId } from "../../core/ids.mjs";
import { today } from "./common.mjs";
import { paymentsOf, sendInvoice } from "./invoices.mjs";
import { previewAutopay, nextMonth, thisMonth, MONTH_RE } from "./autopay.mjs";

const brief = (r, day) => ({ id: r.id, number: r.n, contact_id: r.c, contact_name: r.cn, kind: r.k, status: r.st, total_cents: r.tot, balance_cents: r.bal, due_on: r.due, overdue: r.st === "open" && !!r.due && r.due < day && r.bal > 0, autopay_failed: !!r.af });

export const mcpTools = [
  {
    name: "list_invoices", effect: "read", perm: "invoices:read_all",
    description: "Open invoices (status open, overdue, draft or failed autopay): number, customer, total and balance in cents, due date.",
    inputSchema: { type: "object", properties: { status: { type: "string", enum: ["open", "overdue", "draft", "failed"] } }, additionalProperties: false },
    run: async (input = {}) => {
      const day = today();
      const rows = (await readIndex("invoices", "open")).rows.map((r) => brief(r, day));
      const st = input.status || "open";
      return { invoices: rows.filter((r) => (st === "overdue" ? r.overdue : st === "draft" ? r.status === "draft" : st === "failed" ? r.autopay_failed : r.status === "open")).slice(0, 100) };
    },
  },
  {
    name: "get_invoice", effect: "read", perm: "invoices:read_all",
    description: "One invoice: lines, totals, payments and refunds on it, balance, sends and autopay attempts (cents).",
    inputSchema: { type: "object", properties: { invoice_id: { type: "string" } }, required: ["invoice_id"], additionalProperties: false },
    run: async (input = {}) => {
      const g = isId(input.invoice_id, "invoice") ? await getRecord("invoice", input.invoice_id) : null;
      if (!g || g.data.deleted_at) return { found: false };
      const i = g.data;
      const pays = await paymentsOf(i.id);
      return {
        found: true, id: i.id, number: i.number, kind: i.kind, status: i.status, contact_id: i.contact_id, lines: (i.lines || []).map((l) => ({ kind: l.kind, description: l.description, total_cents: l.total_cents })),
        total_cents: i.total_cents, paid_cents: i.paid_cents, refunded_cents: i.refunded_cents, balance_cents: i.balance_cents, issued_on: i.issued_on || null, due_on: i.due_on || null, sent_at: i.sent_at || null,
        payments: pays.map((p) => ({ id: p.id, kind: p.kind, method: p.method, status: p.status, amount_cents: p.amount_cents, tip_cents: p.tip_cents, received_on: p.received_on })),
        autopay_attempts: ((i.autopay && i.autopay.attempts) || []).map((a) => ({ at: a.at, result: a.result, code: a.code || null })),
      };
    },
  },
  {
    name: "list_payments", effect: "read", perm: "invoices:read_all",
    description: "Payments and refunds of a month (YYYY-MM, default this month): method, status, amount and tip in cents. Test (simulated) payments are flagged.",
    inputSchema: { type: "object", properties: { month: { type: "string" } }, additionalProperties: false },
    run: async (input = {}) => {
      const month = MONTH_RE.test(String(input.month || "")) ? input.month : thisMonth();
      const rows = (await readIndex("payments", month)).rows;
      return { month, payments: rows.slice(0, 200).map((r) => ({ id: r.id, contact_id: r.c, invoice_id: r.inv, kind: r.k, method: r.m, status: r.st, amount_cents: r.a, tip_cents: r.tip, received_on: r.on, simulated: !!r.sim })) };
    },
  },
  {
    name: "preview_autopay", effect: "read", perm: "invoices:read_all",
    description: "What the 1st-of-month run would bill for a month (YYYY-MM, default next month): each plan, its amount, whether a usable card is on file, and whether Rotor still bills it (would_charge). Nothing is charged.",
    inputSchema: { type: "object", properties: { month: { type: "string" } }, additionalProperties: false },
    run: async (input = {}, ctx = {}) => {
      const month = MONTH_RE.test(String(input.month || "")) ? input.month : nextMonth(thisMonth());
      const p = await previewAutopay(month, { mode: ctx.mode });
      return { month, totals: p.totals, items: p.items.slice(0, 200).map((i) => ({ plan_id: i.plan_id, contact_id: i.contact_id, plan: i.plan_name, amount_cents: i.amount_cents, card: i.card, would: i.would })) };
    },
  },
  {
    name: "send_invoice", effect: "contact", perm: "invoices:send",
    description: "Text and/or email a customer the link to an open invoice (it opens their pay page). Dry-run until the CRM is live.",
    inputSchema: { type: "object", properties: { invoice_id: { type: "string" }, channels: { type: "array", items: { type: "string", enum: ["sms", "email"] } } }, required: ["invoice_id"], additionalProperties: false },
    run: async (input = {}, ctx = {}) => {
      const inv = await sendInvoice(input.invoice_id, { channels: Array.isArray(input.channels) && input.channels.length ? input.channels : ["sms"] }, ctx);
      return { invoice_id: inv.id, status: inv.status };
    },
  },
];
