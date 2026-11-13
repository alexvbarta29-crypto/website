// Budget samples for the reports module's routes (read by
// tests/crm/core/budget.test.mjs): the leaderboard over a year (every
// measure reads indexes only; Techs reads the year's month shards) and My
// performance.
export default {
  "GET /leaderboard": (fx) => ({ as: fx.owner, path: "/leaderboard?metric=techs&period=year" }),
  "GET /me/performance": (fx) => ({ as: fx.owner, path: "/me/performance?period=year" }),
};
