// Budget samples for the reports module's routes (read by
// tests/crm/core/budget.test.mjs): the leaderboard over a year (every
// measure reads indexes only; Techs reads the year's month shards), My
// performance, and the Reports screen at its widest: a year compared with
// the year before (two years of month rollups built cold), the summary,
// owed, payroll, a CSV, a rebuild of a year and the dashboard feed (two
// years of months, built cold).
export default {
  "GET /leaderboard": (fx) => ({ as: fx.owner, path: "/leaderboard?metric=techs&period=year" }),
  "GET /me/performance": (fx) => ({ as: fx.owner, path: "/me/performance?period=year" }),
  "GET /reports/summary": (fx) => ({ as: fx.owner, path: "/reports/summary?from=2026-01-01&to=2026-11-17" }),
  "GET /reports/:name": (fx) => ({ as: fx.owner, path: "/reports/sales.csv?from=2025-11-18&to=2026-11-17&group=month" }),
  "POST /reports/rebuild": (fx) => ({ as: fx.owner, path: "/reports/rebuild", body: { from: "2025-12-01", to: "2026-11-17" } }),
  "GET /reports/dashboard-raw": (fx) => ({ as: fx.owner, path: "/reports/dashboard-raw?as_of=2026-11-17" }),
};
