// Client manifest of the "quotes" module (M3a, design §11.3, §9.2): the
// Quotes list, one quote (status, versions, the customer's view, Send,
// Present to customer, Approve by phone, Convert), the builder (pane
// counter or square feet, services, one-time and plan options side by
// side), the lights quote, the contact's Quotes tab, and Settings →
// Pricing & price book, Discounts. Screens load with dynamic import(). No
// data, keys or customer names ever go in crm-app/ (§2.3).

export default {
  name: "quotes",
  routes: [
    { path: "/quotes", load: () => import("./list.js"), title: "Quotes", perm: "quotes:read", parent: "/today", skeleton: "list" },
    { path: "/quotes/new", load: () => import("./builder.js"), title: "New quote", perm: "quotes:write", parent: "/quotes" },
    { path: "/quotes/new/:contact", load: () => import("./builder.js"), title: "New quote", perm: "quotes:write", parent: "/contacts/:contact" },
    { path: "/quotes/:id", load: () => import("./view.js"), title: "Quote", perm: "quotes:read", parent: "/quotes" },
    { path: "/quotes/:id/edit", load: () => import("./builder.js"), title: "Edit quote", perm: "quotes:write", parent: "/quotes/:id" },
    { path: "/quotes/:id/lights", load: () => import("./lights.js"), title: "Lights quote", perm: "quotes:write", parent: "/quotes/:id/edit" },
    { path: "/settings/pricing", load: () => import("./settings.js"), title: "Pricing & price book", perm: "settings:owner", parent: "/settings" },
    { path: "/settings/discounts", load: () => import("./discounts.js"), title: "Discounts", perm: "quotes:read", parent: "/settings" },
  ],
  nav: [{ where: "more", label: "Quotes", path: "/quotes", perm: "quotes:read", order: 30, icon: "doc" }],
  creates: [{ label: "New quote", path: "/quotes/new", perm: "quotes:write", order: 20, icon: "doc" }],
  contactTabs: [{ key: "quotes", label: "Quotes", order: 45, load: () => import("./contact-tab.js") }],
  visitActions: [],
  todayCards: [],
  settings: [
    { label: "Pricing & price book", path: "/settings/pricing", perm: "settings:owner", icon: "money", order: 30, owner: true },
    { label: "Discounts", path: "/settings/discounts", perm: "quotes:read", icon: "money", order: 32 },
  ],
  styles: ["./quotes.css"],
};
