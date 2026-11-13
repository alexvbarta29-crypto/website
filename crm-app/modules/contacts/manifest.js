// Client manifest of the "contacts" module (M2a, design §11.3, §9.2): the
// Contacts tab (it replaces the first slice's Customers list, which stays
// reachable from the list's footer until the import goes live), one contact,
// New lead / edit, the tech's Quick lead, a property, Merge review and
// Settings → Lead webhooks. Screens load with dynamic import(). No data,
// keys or customer names ever go in crm-app/ (§2.3).

export default {
  name: "contacts",
  routes: [
    // split: on a wide screen (1000 px and up) a contact opens beside the list (core/router.js)
    { path: "/contacts", load: () => import("./list.js"), title: "Customers", perm: "contacts:read_all", skeleton: "list", split: true },
    { path: "/contacts/new", load: () => import("./edit.js"), title: "New lead", perm: "contacts:write", parent: "/contacts" },
    { path: "/contacts/:id", load: () => import("./contact.js"), title: "Contact", perm: "contacts:read", parent: "/contacts" },
    { path: "/contacts/:id/edit", load: () => import("./edit.js"), title: "Edit contact", perm: "contacts:write", parent: "/contacts/:id" },
    { path: "/leads/new", load: () => import("./quick.js"), title: "Quick lead", perm: "leads:create", parent: "/today" },
    { path: "/properties/:id", load: () => import("./property.js"), title: "Property", perm: "contacts:read", parent: "/contacts" },
    { path: "/merge", load: () => import("./merge.js"), title: "Merge review", perm: "contacts:merge", parent: "/contacts", skeleton: "list" },
    { path: "/settings/lead-hooks", load: () => import("./hooks.js"), title: "Lead webhooks", perm: "settings:owner", parent: "/settings" },
  ],
  nav: [
    { where: "more", section: "customers", label: "Contacts", path: "/contacts", perm: "contacts:read_all", order: 38, icon: "contacts" },
    { where: "more", section: "customers", label: "Merge review", path: "/merge", perm: "contacts:merge", order: 40, icon: "copy" },
  ],
  // one entry: the office gets the full form, a tech the quick one (quick.js decides)
  creates: [{ label: "New lead", path: "/leads/new", perm: "leads:create", order: 10, icon: "contacts" }],
  contactTabs: [],
  visitActions: [],
  todayCards: [],
  settings: [
    { label: "Lead webhooks (Meta via Zapier)", path: "/settings/lead-hooks", perm: "settings:owner", icon: "plug", order: 84, owner: true },
  ],
  styles: ["./contacts.css"],
};
