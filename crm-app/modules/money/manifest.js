// Client manifest of the "money" module (M5, design §11.3, §9.2): Invoices
// (list + detail on a wide screen), one invoice, a new invoice, Payments,
// Autopay (the preview for the 1st and past runs), the contact's Money tab,
// "Collect payment" on the Visit screen, the money strip on Home, and
// Settings → Payments. Screens load with dynamic import(). No data, keys or
// customer names ever go in crm-app/ (§2.3).

export default {
  name: "money",
  routes: [
    // split: on a wide screen an invoice opens beside the list (core/router.js)
    { path: "/invoices", load: () => import("./invoices.js"), title: "Invoices", perm: "invoices:read_all", parent: "/today", skeleton: "list", split: true },
    { path: "/invoices/new", load: () => import("./invoice-new.js"), title: "New invoice", perm: "invoices:write", parent: "/invoices" },
    { path: "/invoices/new/:contact", load: () => import("./invoice-new.js"), title: "New invoice", perm: "invoices:write", parent: "/contacts/:contact" },
    { path: "/invoices/:id", load: () => import("./invoice.js"), title: "Invoice", perm: "invoices:read_all", parent: "/invoices" },
    { path: "/payments", load: () => import("./payments.js"), title: "Payments", perm: "invoices:read_all", parent: "/today", skeleton: "list" },
    { path: "/autopay", load: () => import("./autopay.js"), title: "Autopay", perm: "invoices:read_all", parent: "/today", skeleton: "list" },
    { path: "/autopay/:id", load: () => import("./autopay-run.js"), title: "Autopay run", perm: "invoices:read_all", parent: "/autopay", skeleton: "list" },
    { path: "/settings/payments", load: () => import("./settings.js"), title: "Payments", perm: "settings:owner", parent: "/settings" },
  ],
  nav: [
    { where: "more", section: "money", label: "Invoices", path: "/invoices", perm: "invoices:read_all", order: 40, icon: "doc" },
    { where: "more", section: "money", label: "Payments", path: "/payments", perm: "invoices:read_all", order: 42, icon: "money" },
    { where: "more", section: "money", label: "Autopay", path: "/autopay", perm: "invoices:read_all", order: 44, icon: "clock" },
  ],
  creates: [{ label: "New invoice", path: "/invoices/new", perm: "invoices:write", order: 27, icon: "money" }],
  contactTabs: [{ key: "money", label: "Money", order: 55, load: () => import("./contact-tab.js") }],
  // on the single Visit screen (work/visit.js): the office and the visit's own techs
  visitActions: [{ key: "money.collect", label: "Collect payment", when: "any", perm: "payments:record", order: 30, icon: "money", load: () => import("./visit-collect.js") }],
  // the money strip on Home (amounts; the counts are Needs-you rows, declared on the server)
  todayCards: [{ key: "money", perm: "invoices:read_all", order: 30, load: () => import("./today-card.js") }],
  settings: [{ label: "Payments", path: "/settings/payments", perm: "settings:owner", icon: "money", order: 36, owner: true }],
  styles: ["./money.css"],
};
