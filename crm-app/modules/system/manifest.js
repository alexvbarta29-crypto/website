// Client manifest of the core "system" module (design §11.3, §9.2): Home
// (/today: the office's first screen, a tech's Today), the Menu page, My
// account, Team, the first slice's Customers list (which the Contacts tab
// opens until M2a's Contacts screen replaces it) and, since M1.3,
// Settings, Automations, Templates, Outbox, Activity, Approvals and the
// notifications bell. Screens load with dynamic import(). No data, keys or
// customer names ever go in crm-app/ (§2.3).
//
// nav entries (where: "more") say who may open each screen from the Menu;
// where it sits and what it is called there is core/nav.js MENU (and, for
// the setup screens, the Settings hub's own layout in settings.js).

export default {
  name: "system",
  routes: [
    { path: "/today", load: () => import("./today.js"), title: (u) => (u && u.role === "tech" ? "Today" : "Home") },
    // the Menu is the top bar's button, not a tab: it has a back arrow (to where you were, or Home)
    { path: "/menu", load: () => import("./menu.js"), title: "Menu", parent: "/today" },
    { path: "/me", load: () => import("./me.js"), title: "My account", perm: "account:own", parent: "/today" },
    // Menu → Tab bar: the places on this person's phone bar (users.tabs)
    { path: "/tab-bar", load: () => import("./tab-bar.js"), title: "Tab bar", perm: "account:own", parent: "/settings", skeleton: "list" },
    { path: "/team", load: () => import("./team.js"), title: "Team", perm: "users:manage", parent: "/settings", skeleton: "list" },
    { path: "/team/:id", load: () => import("./person.js"), title: "Person", perm: "users:manage", parent: "/team" },
    // Rotor's first customer list (the first slice's), until the Rotor import goes live: Settings → Import & data
    { path: "/legacy/customers", load: () => import("./legacy.js"), title: "Rotor's first customer list", perm: "contacts:read_all", parent: "/settings" },
    { path: "/notifications", load: () => import("./notifications.js"), title: "Notifications", perm: "account:own", parent: "/today", skeleton: "list" },
    { path: "/approvals", load: () => import("./approvals.js"), title: "Approvals", perm: "campaigns:send", parent: "/today", skeleton: "list" },
    { path: "/automations", load: () => import("./automations.js"), title: "Automations", perm: "automations:configure", parent: "/settings", skeleton: "list" },
    { path: "/templates", load: () => import("./templates.js"), title: "Message templates", perm: "templates:edit", parent: "/settings", skeleton: "list" },
    { path: "/templates/new", load: () => import("./template.js"), title: "New template", perm: "templates:edit", parent: "/templates" },
    { path: "/templates/:id", load: () => import("./template.js"), title: "Template", perm: "templates:edit", parent: "/templates" },
    { path: "/outbox", load: () => import("./outbox.js"), title: "Outbox", perm: "outbox:read", parent: "/today", skeleton: "list" },
    { path: "/activity", load: () => import("./activity.js"), title: "Activity log", perm: "audit:read", parent: "/settings", skeleton: "list" },
    { path: "/settings", load: () => import("./settings.js"), title: "Settings", perm: "settings:general", parent: "/today", skeleton: "list" },
    { path: "/settings/company", load: () => import("./settings-general.js"), title: "Company", perm: "settings:general", parent: "/settings" },
    { path: "/settings/hours", load: () => import("./settings-general.js"), title: "Hours & holidays", perm: "settings:general", parent: "/settings" },
    { path: "/settings/service-area", load: () => import("./settings-general.js"), title: "Service area", perm: "settings:general", parent: "/settings" },
    { path: "/settings/schedule", load: () => import("./settings-general.js"), title: "Crew & forecast", perm: "settings:general", parent: "/settings" },
    { path: "/settings/messaging", load: () => import("./settings-messaging.js"), title: "Quiet hours & opt-out", perm: "settings:messaging", parent: "/settings" },
    { path: "/settings/integrations", load: () => import("./settings-integrations.js"), title: "Integrations", perm: "settings:owner", parent: "/settings" },
    { path: "/settings/intake", load: () => import("./settings-integrations.js"), title: "Intake mode", perm: "settings:owner", parent: "/settings" },
    { path: "/settings/data", load: () => import("./settings-data.js"), title: "Data & backups", perm: "audit:read", parent: "/settings" },
    { path: "/settings/permissions", load: () => import("./settings-permissions.js"), title: "Permissions", perm: "settings:owner", parent: "/settings" },
    // The office's dashboards and tools, inside the CRM (office sign-in only).
    // (the office dashboard, Rotor's snapshot: Reports opens it; old #money links land on a view)
    { path: "/dashboard", load: () => import("./dashboard.js"), title: "Office dashboard", perm: "office:tools", parent: "/reports" },
    { path: "/dashboard/:view", load: () => import("./dashboard.js"), title: "Office dashboard", perm: "office:tools", parent: "/dashboard" },
    { path: "/tools/:id", load: () => import("./tool.js"), title: "Office tool", perm: "office:tools", parent: "/menu" },
  ],
  nav: [
    { where: "more", section: "messages", label: "Approvals", path: "/approvals", perm: "campaigns:send", order: 10, icon: "check" },
    { where: "more", section: "messages", label: "Automations", path: "/automations", perm: "automations:configure", order: 60, icon: "bolt" },
    { where: "more", section: "messages", label: "Templates", path: "/templates", perm: "templates:edit", order: 62, icon: "doc" },
    { where: "more", section: "messages", label: "Outbox", path: "/outbox", perm: "outbox:read", order: 64, icon: "send" },
    { where: "more", section: "admin", label: "Activity", path: "/activity", perm: "audit:read", order: 66, icon: "clock" },
    { where: "more", section: "office", label: "Light Studio", path: "/tools/lights", perm: "office:tools", order: 70, icon: "bulb" },
    { where: "more", section: "office", label: "Purchases", path: "/tools/purchases", perm: "office:tools", order: 72, icon: "cart" },
    { where: "more", section: "office", label: "Giveaway", path: "/tools/giveaway", perm: "office:tools", order: 73, icon: "gift" },
    { where: "more", section: "office", label: "Rotor", path: "/tools/rotor", perm: "office:tools", order: 74, icon: "link" },
    { where: "more", section: "admin", label: "Settings", path: "/settings", perm: "settings:general", order: 80, icon: "gear" },
    { where: "more", section: "admin", label: "Team", path: "/team", perm: "users:manage", order: 90, icon: "team" },
    { where: "more", section: "admin", label: "My account", path: "/me", perm: "account:own", order: 99, icon: "me" },
    { where: "more", section: "admin", label: "Tab bar", path: "/tab-bar", perm: "account:own", order: 97, icon: "tabbar" },
  ],
  creates: [],
  contactTabs: [],
  visitActions: [],
  todayCards: [],
  settings: [
    { label: "Company", path: "/settings/company", perm: "settings:general", icon: "building", order: 10 },
    { label: "Hours & holidays", path: "/settings/hours", perm: "settings:general", icon: "clock", order: 12 },
    { label: "Service area", path: "/settings/service-area", perm: "settings:general", icon: "map", order: 14 },
    { label: "Crew & forecast", path: "/settings/schedule", perm: "settings:general", icon: "truck", order: 16 },
    { label: "Quiet hours & opt-out", path: "/settings/messaging", perm: "settings:messaging", icon: "text", order: 30 },
    { label: "Permissions", path: "/settings/permissions", perm: "settings:owner", icon: "shield", order: 70, owner: true },
    { label: "Integrations", path: "/settings/integrations", perm: "settings:owner", icon: "plug", order: 80, owner: true },
    { label: "Intake mode", path: "/settings/intake", perm: "settings:owner", icon: "contacts", order: 82, owner: true },
    { label: "Data & backups", path: "/settings/data", perm: "audit:read", icon: "data", order: 90 },
  ],
  styles: [],
};
