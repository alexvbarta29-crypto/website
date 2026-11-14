// The reports API (design §5.9 "Endpoints"):
//
//   GET  /reports/summary?from=&to=                     reports:read   the headline tiles, with the period before
//   GET  /reports/:name?from=&to=&group=day|week|month   reports:read   one report (revenue, sales, leads, plans,
//                                                                       jobs, team, owed, payroll; ops and money
//                                                                       are names for jobs and revenue)
//   GET  /reports/:name.csv?...                         reports:read   the same as CSV (an audited export)
//   POST /reports/rebuild { from, to }                  reports:read   those months' rollups built again
//   GET  /reports/dashboard-raw?as_of=                  reports:read   the dashboard feed (Rotor's report shapes)
//
// reports:read is the owners' and the office's (a technician's "own"
// reports:read opens no report); payroll's report also needs payroll:read_all.

import { InputError, ForbiddenError } from "../../core/errors.mjs";
import { isLocalDate } from "../../core/clock.mjs";
import { auditRead } from "../../core/audit.mjs";
import { csvCell } from "../../../referral-lib.mjs";
import { report, summary, reportCsv } from "./reports.mjs";
import { rebuild, today } from "./rollup.mjs";
import { dashboardRaw } from "./dashboard-raw.mjs";

const R = (method, path, perm, handler, extra = {}) => ({ method, path, auth: "session", perm, subject: "none", mode: "inline", handler, ...extra });
const q = (ctx) => ({ from: ctx.query.get("from") || undefined, to: ctx.query.get("to") || undefined, group: ctx.query.get("group") || undefined, range: ctx.query.get("range") || undefined });
const csvLine = (cells) => cells.map((c) => csvCell(c)).join(",");

async function one(ctx) {
  let name = String(ctx.params.name || "");
  const csv = name.endsWith(".csv");
  if (csv) name = name.slice(0, -4);
  if (name === "payroll" && !ctx.can("payroll:read_all")) throw new ForbiddenError("You don't have access to that.");
  const rep = await report(name, q(ctx));
  if (!csv) return { data: rep };
  await auditRead(ctx, "report", rep.name, "export", { from: rep.from, to: rep.to });
  return new Response(reportCsv(rep, csvLine), {
    status: 200,
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="barta-${rep.name}-${rep.from}-to-${rep.to}.csv"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex, nofollow" },
  });
}

async function rebuildRoute(ctx) {
  const b = ctx.body || {};
  if (!isLocalDate(b.from) || !isLocalDate(b.to) || b.to < b.from) throw new InputError("Pick the first and the last day.", "from");
  return { data: await rebuild(b.from, b.to) };
}

async function raw(ctx) {
  const asOf = ctx.query.get("as_of") || today();
  if (!isLocalDate(asOf)) throw new InputError("Pick the as-of date.", "as_of");
  return { data: await dashboardRaw(asOf) };
}

export const reportRoutes = [
  R("GET", "/reports/summary", "reports:read", async (ctx) => ({ data: await summary(q(ctx)) }), { maxCalls: 160 }),
  R("GET", "/reports/dashboard-raw", "reports:read", raw, { maxCalls: 260, budgetMs: 9000 }),
  R("POST", "/reports/rebuild", "reports:read", rebuildRoute, { maxCalls: 260, budgetMs: 9000 }),
  R("GET", "/reports/:name", "reports:read", one, { maxCalls: 160 }),
];
