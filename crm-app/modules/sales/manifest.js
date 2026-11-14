// Client manifest of the "sales" module (M2b, design §11.3, §9.2): Calls
// (the call list: today's follow-up steps), one follow-up, one deal, starting a follow-up,
// logging a call, Tasks and one task, the contact's Sales tab, a Today card,
// Settings → Cadences, and Signs & flyers (QR codes for signs and flyers). Screens load with dynamic import(). No data,
// keys or customer names ever go in crm-app/ (§2.3).

export default {
  name: "sales",
  routes: [
    { path: "/calls", load: () => import("./calls.js"), title: "Calls", perm: "sales:work", parent: "/today", skeleton: "list" },
    // the Sales tab's first screens (the Nov 2026 layout, after Rotor's): Pipeline, then Leads
    { path: "/pipeline", load: () => import("./pipeline.js"), title: "Pipeline", perm: "sales:work", parent: "/today", skeleton: "list" },
    { path: "/leads", load: () => import("./leads.js"), title: "Leads", perm: "sales:work", parent: "/today", skeleton: "list" },
    { path: "/calls/log", load: () => import("./log.js"), title: "Log a call", perm: "sales:work", parent: "/calls" },
    { path: "/calls/log/:contact", load: () => import("./log.js"), title: "Log a call", perm: "sales:work", parent: "/contacts/:contact" },
    { path: "/enrollments/:id", load: () => import("./enrollment.js"), title: "Follow-up", perm: "sales:work", parent: "/calls" },
    { path: "/deals/:id", load: () => import("./deal.js"), title: "Deal", perm: "sales:work", parent: "/calls" },
    { path: "/sales/enroll/:contact", load: () => import("./enroll.js"), title: "Start a follow-up", perm: "sales:work", parent: "/contacts/:contact" },
    { path: "/tasks", load: () => import("./tasks.js"), title: "Tasks", perm: "tasks:read", parent: "/today", skeleton: "list" },
    // making a task is the office's (a technician holds tasks:write only for their own tasks)
    { path: "/tasks/new", load: () => import("./task.js"), title: "New task", perm: "sales:work", parent: "/tasks" },
    { path: "/tasks/new/:contact", load: () => import("./task.js"), title: "New task", perm: "sales:work", parent: "/contacts/:contact" },
    { path: "/tasks/:id", load: () => import("./task.js"), title: "Task", perm: "tasks:read", parent: "/tasks" },
    { path: "/settings/cadences", load: () => import("./cadences.js"), title: "Cadences", perm: "cadences:configure", parent: "/settings", skeleton: "list" },
    { path: "/settings/cadences/:id", load: () => import("./cadence.js"), title: "Cadence", perm: "cadences:configure", parent: "/settings/cadences" },
    // Signs & flyers: QR codes for yard signs, door hangers and flyers, their scans and leads (owners and the office)
    { path: "/signs", load: () => import("./signs.js"), title: "Signs & flyers", perm: "signs:manage", parent: "/today", skeleton: "list" },
    { path: "/signs/new", load: () => import("./sign-form.js"), title: "New code", perm: "signs:manage", parent: "/signs" },
    { path: "/signs/:id", load: () => import("./sign.js"), title: "Code", perm: "signs:manage", parent: "/signs" },
  ],
  nav: [
    { where: "more", section: "sales", label: "Pipeline", path: "/pipeline", perm: "sales:work", order: 18, icon: "pipeline" },
    { where: "more", section: "sales", label: "Leads", path: "/leads", perm: "sales:work", order: 19, icon: "target" },
    { where: "more", section: "sales", label: "Calls", path: "/calls", perm: "sales:work", order: 20, icon: "phone" },
    { where: "more", section: "sales", label: "Tasks", path: "/tasks", perm: "tasks:read", order: 22, icon: "check" },
    { where: "more", section: "sales", label: "Signs & flyers", path: "/signs", perm: "signs:manage", order: 24, icon: "grid" },
  ],
  creates: [
    { label: "Log a call", path: "/calls/log", perm: "sales:work", order: 30, icon: "phone" },
    { label: "New task", path: "/tasks/new", perm: "sales:work", order: 40, icon: "check" },
  ],
  contactTabs: [{ key: "sales", label: "Sales", order: 40, place: "more", heading: "Follow-ups and tasks", perm: "sales:work", load: () => import("./contact-tab.js") }],
  visitActions: [],
  // one card on Today: calls due now and leads that need attention (the office), my tasks (everyone)
  // (home: false: on the office's Home the same counts are "Needs you" rows from the server's attention)
  todayCards: [{ key: "sales", perm: "tasks:read", order: 20, home: false, load: () => import("./today-card.js") }],
  settings: [
    { label: "Cadences", path: "/settings/cadences", perm: "cadences:configure", icon: "phone", order: 40 },
  ],
  styles: ["./sales.css"],
};
