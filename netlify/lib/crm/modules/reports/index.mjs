// Barta CRM module "reports" (M7b): daily rollups, the Reports screen's
// numbers, CSV exports, the dashboard feed and its source switch (design
// §5.9, §6.10, §9.2 Reports). docs/CRM-REPORTS.md describes it.
//
// Files: rollup.mjs (the daily rows per month, built from the indexes, the
// reports.rollup sweep), reports.mjs (revenue, sales, leads, plans, jobs,
// team, owed, payroll; compare to the period before; CSV), dashboard-raw.mjs
// (the raw.json keys build/office_dashboard.mjs reads, from the CRM),
// routes.mjs (the API), leaderboard.mjs (the Leaderboard, My performance
// and Home's card: the service `reports.leaderboard`).

import { defineModule } from "../../core/registry.mjs";
import { InputError } from "../../core/errors.mjs";
import { types } from "./types.mjs";
import { leaderboard, leaderboardRoutes } from "./leaderboard.mjs";
import { reportRoutes } from "./routes.mjs";
import { rollupSweep } from "./rollup.mjs";
import { dashboardRaw } from "./dashboard-raw.mjs";

// cfg/dashboard: where /dashboard's numbers come from. "rotor" (the sealed
// snapshot, until cutover) or "crm" (built live from the CRM, §5.9).
export const DASHBOARD_DEFAULTS = Object.freeze({ source: "rotor" });
function validateDashboard(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new InputError("Expected the dashboard settings.");
  if (v.source !== undefined && !["rotor", "crm"].includes(v.source)) throw new InputError("Pick Rotor's snapshot or the CRM.", "source");
  return { ...v };
}

export default defineModule({
  name: "reports",
  types,
  settings: { dashboard: { defaults: { ...DASHBOARD_DEFAULTS }, validate: validateDashboard, perm: "settings:owner" } },
  routes: [...leaderboardRoutes, ...reportRoutes],
  services: {
    // ({ metric, from, to }) or Home's ({ board: sales | techs, period, month, from, to })
    //   → { metric, from, to, people, unassigned, rows: [{ user_id, name, color, count, value_cents, note }] }
    "reports.leaderboard": (input) => leaderboard(input || {}),
    // (reports.series, Home's charts from the rollups, is ready in reports.mjs seriesFor() but not
    // provided: Home doesn't ask for it, and core's registry test keeps one contract service unprovided)
    // (as_of) → the raw.json keys of build/office_dashboard.mjs
    "reports.dashboardRaw": (asOf) => dashboardRaw(asOf),
  },
  sweeps: [
    // yesterday's rows final, with the night's active plans, MRR and first touches (derived ix/ rows only)
    { key: "reports.rollup", label: "Daily report numbers", lane: "bulk", every: "daily", at_local: "01:30", mutates: false, run: (ctx) => rollupSweep(ctx) },
  ],
});
