// Barta CRM module "mcp" (M7c): the MCP endpoint that lets Claude run the
// business through the CRM (design §6.9, §4.9), and each person's private
// calendar feed (iCal) of their visits.
//
//   server.mjs    POST /mcp (header key), POST /mcp/:key (path key), GET /mcp/connect
//   tools.mjs     this module's tools (reads through the CRM's own routes, Rotor-compatible
//                 reports, and the asks that wait for an owner); the other modules' tools
//                 come from their manifests' mcpTools
//   actions.mjs   a change through Claude = a pending action an owner approves (kind "mcp.tool");
//                 confirm tokens for the staff-side destructive tools
//   untrusted.mjs customer-written text wrapped as untrusted_customer_text
//   reports.mjs   report_invoices, report_payments, report_jobs, report_visits, report_service_plans
//   calendar.mjs  GET/POST/PATCH/DELETE /calendar-feed, GET /cal/:token (text/calendar)
//
// docs/CRM-MCP.md says how the owner connects Claude and subscribes a calendar.

import { defineModule } from "../../core/registry.mjs";
import { types } from "./types.mjs";
import { mcpRoutes } from "./server.mjs";
import { calendarRoutes } from "./calendar.mjs";
import { tools } from "./tools.mjs";

export default defineModule({
  name: "mcp",
  types,
  routes: [...mcpRoutes, ...calendarRoutes],
  mcpTools: tools,
});
