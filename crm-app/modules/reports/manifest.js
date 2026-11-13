// Client manifest of the "reports" module (M7b): routes, nav entries, create
// buttons, contact tabs, visit actions, Today cards and settings screens
// (design §11.3). Stub created in M1.1; screens load with dynamic import().
// No data, keys or customer names ever go in crm-app/ (§2.3).
//
// Since the Nov 2026 layout: the Leaderboard (Rotor's podium) and My
// performance (Flyra's), both from the service reports.leaderboard.

export default {
  name: "reports",
  routes: [
    { path: "/leaderboard", load: () => import("./leaderboard.js"), title: "Leaderboard", perm: "reports:read", parent: "/today" },
    { path: "/performance", load: () => import("./performance.js"), title: "My performance", perm: "account:own", parent: "/today" },
  ],
  nav: [
    { where: "more", section: "sales", label: "Leaderboard", path: "/leaderboard", perm: "reports:read", order: 34, icon: "trophy" },
    { where: "more", section: "sales", label: "My performance", path: "/performance", perm: "account:own", order: 35, icon: "trend" },
  ],
  creates: [],
  contactTabs: [],
  visitActions: [],
  todayCards: [],
  settings: [],
  styles: ["./reports.css"],
};
