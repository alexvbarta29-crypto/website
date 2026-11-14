// Payroll's API (design §5.8 "Endpoints", §4.5):
//
//   GET  /payroll/periods                         payroll:read_all  the periods, newest first
//   POST /payroll/periods { start_on }            payroll:run       start a period (a Sunday)
//   GET  /payroll/periods/:id                     payroll:read_all  everyone's totals and lines
//   GET  /payroll/periods/:id/sheet/:userId       payroll:read_all  one person's printable pay sheet (HTML)
//   GET  /payroll/periods/:id/export.csv          payroll:read_all  every line and total (CSV)
//   POST /payroll/periods/:id/recompute|lock|unlock|paid             payroll:run
//   POST /payroll/periods/:id/adjustments { user_id, amount_cents, note, type? }   payroll:run
//   POST /payroll/lines/:id/void                  payroll:run       strike an adjustment out (open periods)
//   GET  /payroll/scoreboard?from=&to=            payroll:read_own  the crew scoreboard (a person without
//                                                                   payroll:read_all or reports:read sees their own row)
//   GET  /me/pay/sheet?period=                    payroll:read_own  one's own printable pay sheet
//   GET  /me/pay (work's route) answers from payroll.myPay once this module is here.
//
// Looking at someone else's pay is an audited read (§3.8).

import { InputError, NotFoundError } from "../../core/errors.mjs";
import { isId } from "../../core/ids.mjs";
import { auditRead } from "../../core/audit.mjs";
import { getRecord } from "../../../crm-store.mjs";
import {
  listPeriods, ensurePeriod, startParam, periodDetail, recompute, lockPeriod, unlockPeriod, markPaid, addAdjustment, voidLine, scoreboard,
  periodFor, sheetOf, today, periodEnd,
} from "./periods.mjs";
import { weekOf } from "./compute.mjs";
import { sheetHtml, htmlResponse, csvResponse, periodCsv } from "./sheet.mjs";

const R = (method, path, perm, subject, handler, extra = {}) => ({ method, path, auth: "session", perm, subject, mode: "inline", handler, ...extra });
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const list = async () => ({ data: await listPeriods() });
const create = async (ctx) => ({ data: { period: await ensurePeriod(startParam((ctx.body || {}).start_on), ctx) } });
const detail = async (ctx) => {
  const d = await periodDetail(ctx.params.id);
  return { data: d, etag: d.etag };
};

async function sheetRoute(ctx) {
  const uid = ctx.params.userId;
  if (!isId(uid, "user")) throw new NotFoundError("That person isn't on the team.");
  const d = await periodDetail(ctx.params.id);
  const u = d.people.find((p) => p.id === uid) || (await getRecord("user", uid).then((g) => (g ? { id: uid, name: g.data.name } : null)));
  if (!u) throw new NotFoundError("That person isn't on the team.");
  if (uid !== ctx.user.id) await auditRead(ctx, "pay_period", d.period.id, "pay_sheet_view", { subject_user: uid });
  return htmlResponse(sheetHtml({ period: d.period, user: u, lines: d.lines.filter((l) => l.user_id === uid), totals: d.totals[uid] || {} }));
}

async function csvRoute(ctx) {
  const d = await periodDetail(ctx.params.id);
  await auditRead(ctx, "pay_period", d.period.id, "export", { rows: d.lines.length });
  return csvResponse(periodCsv(d), `barta-pay-${d.period.start_on}.csv`);
}

const action = (fn) => async (ctx) => ({ data: await fn(ctx.params.id, ctx) });
const adjust = async (ctx) => ({ data: { line: await addAdjustment(ctx.params.id, ctx.body || {}, ctx) } });
const voidRoute = async (ctx) => ({ data: { line: await voidLine(ctx.params.id, ctx) } });

async function boardRoute(ctx) {
  const t = today();
  const from = ctx.query.get("from") || weekOf(t);
  const to = ctx.query.get("to") || t;
  if (!DATE.test(from) || !DATE.test(to)) throw new InputError("Pick the dates.", "from");
  const all = ctx.can("payroll:read_all") || ctx.can("reports:read");
  return { data: { ...(await scoreboard({ from, to, onlyUser: all ? null : ctx.user.id })), all } };
}

async function mySheet(ctx) {
  const date = ctx.query.get("period") || today();
  if (!DATE.test(date)) throw new InputError("Pick a week.", "period");
  const p = (await periodFor(date)) || { id: null, start_on: weekOf(date), end_on: periodEnd(weekOf(date)), weeks: 1, status: "open", totals: {} };
  const s = await sheetOf(p, { onlyUser: ctx.user.id });
  const name = ctx.user.name || [ctx.user.first_name, ctx.user.last_name].filter(Boolean).join(" ") || "Your pay";
  return htmlResponse(sheetHtml({ period: p, user: { id: ctx.user.id, name }, lines: s.lines, totals: s.totals[ctx.user.id] || {} }));
}

export const payrollRoutes = [
  R("GET", "/payroll/periods", "payroll:read_all", "none", list),
  R("POST", "/payroll/periods", "payroll:run", "none", create),
  R("GET", "/payroll/periods/:id", "payroll:read_all", "required", detail, { maxCalls: 200 }),
  R("GET", "/payroll/periods/:id/sheet/:userId", "payroll:read_all", "required", sheetRoute, { maxCalls: 200 }),
  R("GET", "/payroll/periods/:id/export.csv", "payroll:read_all", "required", csvRoute, { maxCalls: 200 }),
  R("POST", "/payroll/periods/:id/recompute", "payroll:run", "required", action(recompute), { maxCalls: 200 }),
  R("POST", "/payroll/periods/:id/lock", "payroll:run", "required", action(lockPeriod), { maxCalls: 260 }),
  R("POST", "/payroll/periods/:id/unlock", "payroll:run", "required", action(unlockPeriod), { maxCalls: 160 }),
  R("POST", "/payroll/periods/:id/paid", "payroll:run", "required", action(markPaid), { maxCalls: 120 }),
  R("POST", "/payroll/periods/:id/adjustments", "payroll:run", "required", adjust, { maxCalls: 40 }),
  R("POST", "/payroll/lines/:id/void", "payroll:run", "required", voidRoute, { maxCalls: 40 }),
  R("GET", "/payroll/scoreboard", "payroll:read_own", "none", boardRoute, { maxCalls: 260 }),
  R("GET", "/me/pay/sheet", "payroll:read_own", "none", mySheet, { maxCalls: 200 }),
];
