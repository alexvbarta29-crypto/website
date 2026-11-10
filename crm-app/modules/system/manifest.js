// Client manifest of the core "system" module (design §11.3): Today (empty
// until the modules add their cards), My account, Team, and the first
// slice's Customers list, which the Contacts tab opens until M2a's
// Contacts screen replaces it. Screens load with dynamic import(). No data,
// keys or customer names ever go in crm-app/ (§2.3).

export default {
  name: "system",
  routes: [
    { path: "/today", load: () => import("./today.js"), title: "Today" },
    { path: "/me", load: () => import("./me.js"), title: "My account", perm: "account:own", parent: "/today" },
    { path: "/team", load: () => import("./team.js"), title: "Team", perm: "users:manage", parent: "/today" },
    { path: "/team/:id", load: () => import("./person.js"), title: "Person", perm: "users:manage", parent: "/team" },
    { path: "/legacy/customers", load: () => import("./legacy.js"), title: "Customers", perm: "contacts:read_all" },
  ],
  nav: [
    { where: "more", label: "Team", path: "/team", perm: "users:manage", order: 90, icon: "team" },
    { where: "more", label: "My account", path: "/me", perm: "account:own", order: 99, icon: "me" },
  ],
  creates: [],
  contactTabs: [],
  visitActions: [],
  todayCards: [],
  settings: [],
  styles: [],
};
