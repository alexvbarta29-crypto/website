// Client manifest of the "plans" module (M3b, design §11.3, §9.2): Plans,
// one plan, a new plan, plan visits due, the lights season board, the
// contact's Plans tab, the plans card on Today, Settings → Plans catalog &
// perks and Agreement templates. Screens load with dynamic import(). No
// data, keys or customer names ever go in crm-app/ (§2.3).

export default {
  name: "plans",
  routes: [
    { path: "/plans", load: () => import("./list.js"), title: "Plans", perm: "plans:read", parent: "/today", skeleton: "list" },
    { path: "/plans/new", load: () => import("./new.js"), title: "New plan", perm: "plans:write", parent: "/plans" },
    { path: "/plans/new/:contact", load: () => import("./new.js"), title: "New plan", perm: "plans:write", parent: "/contacts/:contact" },
    { path: "/plans/due", load: () => import("./due.js"), title: "Plan visits to book", perm: "plans:read", parent: "/plans", skeleton: "list" },
    { path: "/plans/:id", load: () => import("./plan.js"), title: "Plan", perm: "plans:read", parent: "/plans" },
    { path: "/lights", load: () => import("./lights.js"), title: "Lights season", perm: "plans:read", parent: "/plans", skeleton: "list" },
    { path: "/lights/:season", load: () => import("./lights.js"), title: "Lights season", perm: "plans:read", parent: "/plans", skeleton: "list" },
    { path: "/settings/plans", load: () => import("./settings.js"), title: "Plans catalog & perks", perm: "settings:owner", parent: "/settings" },
    { path: "/settings/agreement-templates", load: () => import("./templates.js"), title: "Agreement templates", perm: "plans:read", parent: "/settings" },
    { path: "/settings/agreement-templates/:id", load: () => import("./template.js"), title: "Agreement", perm: "plans:read", parent: "/settings/agreement-templates" },
  ],
  nav: [
    { where: "more", label: "Plans", path: "/plans", perm: "plans:read", order: 32, icon: "schedule" },
    { where: "more", label: "Lights season", path: "/lights", perm: "plans:read", order: 36, icon: "gift" },
  ],
  creates: [{ label: "New plan", path: "/plans/new", perm: "plans:write", order: 22, icon: "schedule" }],
  contactTabs: [{ key: "plans", label: "Plans", order: 47, load: () => import("./contact-tab.js") }],
  visitActions: [],
  todayCards: [{ key: "plans", perm: "plans:read", order: 25, load: () => import("./today-card.js") }],
  settings: [
    { label: "Plans catalog & perks", path: "/settings/plans", perm: "settings:owner", icon: "schedule", order: 34, owner: true },
    { label: "Agreement templates", path: "/settings/agreement-templates", perm: "plans:read", icon: "doc", order: 35 },
  ],
  styles: ["./plans.css"],
};
