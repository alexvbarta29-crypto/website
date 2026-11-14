// Client manifest of the "payroll" module (M7a): Payroll (the office's pay
// periods, pay sheets and the crew scoreboard), a period's pay sheets, and
// Settings → Payroll (the rules and each person's pay). The technician's
// own Pay screen stays the work module's #/pay: it draws payroll's view
// (pay-view.js) once GET /me/pay answers from payroll (design §9.2, §9.3).
// No data, keys or customer names ever go in crm-app/ (§2.3).

export default {
  name: "payroll",
  routes: [
    { path: "/payroll", load: () => import("./payroll.js"), title: "Payroll", perm: "payroll:read_all", parent: "/today", skeleton: "list" },
    { path: "/payroll/:id", load: () => import("./period.js"), title: "Pay period", perm: "payroll:read_all", parent: "/payroll" },
    { path: "/settings/payroll", load: () => import("./settings.js"), title: "Payroll", perm: "settings:owner", parent: "/settings" },
  ],
  nav: [
    { where: "more", section: "work", label: "Payroll", path: "/payroll", perm: "payroll:read_all", order: 29, icon: "pay" },
  ],
  creates: [],
  contactTabs: [],
  visitActions: [],
  todayCards: [],
  settings: [{ label: "Payroll", path: "/settings/payroll", perm: "settings:owner", icon: "pay", order: 38, owner: true }],
  styles: ["./payroll.css"],
};
