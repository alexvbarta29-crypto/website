// Barta CRM module "payroll" (M7a): pay periods, pay sheets from the time,
// jobs and tips, commissions, adjustments, lock and paid, the crew
// scoreboard (design §5.8, §9.2 Payroll, §9.3 Pay, §10.2 row 31, D3).
// docs/CRM-PAYROLL.md describes it.
//
// Files: settings.mjs (cfg/payroll, the pay rates), compute.mjs (the pure
// arithmetic: hours, overtime, commissions, tips, the models), types.mjs
// (pay_period, pay_line), periods.mjs (inputs, lock / unlock / paid,
// adjustments, late time, the person's own pay, the scoreboard, the
// sweep), sheet.mjs (the printable pay sheet, CSV), routes.mjs (the API),
// import-rotor.mjs (phase 31). The CRM works pay out; it never runs payroll
// or moves money.

import { defineModule } from "../../core/registry.mjs";
import { readIndex } from "../../../crm-store.mjs";
import { types } from "./types.mjs";
import { PAYROLL_DEFAULTS, validatePayroll } from "./settings.mjs";
import { payrollRoutes } from "./routes.mjs";
import { lateAdjustment, periodStatus, myPay, recomputeSweep, today } from "./periods.mjs";
import { payrollPhase } from "./import-rotor.mjs";

// Home's "Needs you": pay periods that are over and still open.
const toLock = async () => (await readIndex("pay-periods", "")).rows.filter((r) => r.st === "open" && r.e < today()).length;

export default defineModule({
  name: "payroll",
  types,
  settings: { payroll: { defaults: { ...PAYROLL_DEFAULTS, scoreboard_user_ids: [], goals: { ...PAYROLL_DEFAULTS.goals } }, validate: validatePayroll, perm: "settings:owner" } },
  routes: payrollRoutes,
  services: {
    // (input: { user_id, minutes, category, start_at, end_at, timesheet_id, note }, ctx) → pay_line (late time into a locked week)
    "payroll.addAdjustment": (input, ctx) => lateAdjustment(input, ctx || {}),
    // ({ user_id, at }) → "open" | "locked" | "paid" | null
    "payroll.periodStatus": (input) => periodStatus(input || {}),
    // ({ user_id, period }) → the person's own pay (GET /me/pay)
    "payroll.myPay": (input, ctx) => myPay(input || {}, ctx || {}),
  },
  sweeps: [
    // this week's period, the open ones recomputed (draft lines), and shifts a lock left to lock: CRM-only records
    { key: "payroll.recompute", label: "Pay periods kept current", lane: "bulk", every: "daily", at_local: "04:00", mutates: true, run: (ctx) => recomputeSweep(ctx) },
  ],
  approvals: [
    { kind: "payroll.lock", label: "Pay periods to lock", perm: "payroll:run", count: toLock, link: "#/payroll" },
  ],
  activityKinds: {},
  exportTypes: ["pay_period", "pay_line"],
  importPhases: [payrollPhase],
});
