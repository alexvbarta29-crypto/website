// Barta CRM module "reports" (M7b): daily rollups, KPI reports and the dashboard feed.
// Stub created in M1.1 so the reports track only edits inside this directory;
// the manifest grows with the module (design §11.3 lists every key).
//
// Since the Nov 2026 layout: the leaderboard and My performance
// (leaderboard.mjs), with the service `reports.leaderboard` the Leaderboard
// screen, My performance and Home's card use.

import { defineModule } from "../../core/registry.mjs";
import { types } from "./types.mjs";
import { leaderboard, leaderboardRoutes } from "./leaderboard.mjs";

export default defineModule({
  name: "reports",
  types,
  routes: leaderboardRoutes,
  services: {
    // ({ metric, from, to }) → { metric, from, to, people, unassigned }
    "reports.leaderboard": (input) => leaderboard(input || {}),
  },
});
