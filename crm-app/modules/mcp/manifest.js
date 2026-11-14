// Client manifest of the "mcp" module (M7c): Settings → Claude connector
// (connect claude.ai with approvals, the connected apps, a read-only
// connector link or a key that can ask, see the tools, revoke), the
// Connect Claude consent screen and the Calendar feed (a private iCal link of your visits for
// Google or Apple Calendar: Settings → Appearance for the office, My
// account for everyone). Screens load with dynamic import(). No data, keys
// or customer names ever go in crm-app/ (§2.3).

export default {
  name: "mcp",
  routes: [
    { path: "/settings/claude", load: () => import("./claude.js"), title: "Claude connector", perm: "api_keys:own", parent: "/settings" },
    // claude.ai's "Connect" lands here (OAuth consent): the app, where it goes back to, Allow or Don't allow
    { path: "/claude-connect/:rid", load: () => import("./connect.js"), title: "Connect Claude", perm: "api_keys:own", parent: "/settings/claude" },
    { path: "/calendar-feed", load: () => import("./calendar.js"), title: "Calendar feed", perm: "schedule:read", parent: "/me" },
  ],
  nav: [],
  creates: [],
  contactTabs: [],
  visitActions: [],
  todayCards: [],
  settings: [
    { label: "Claude connector", path: "/settings/claude", perm: "api_keys:own", icon: "plug", order: 84, section: "data" },
    { label: "Calendar feed", path: "/calendar-feed", perm: "schedule:read", icon: "today", order: 96, section: "look" },
  ],
  styles: [],
};
