// Client manifest of the "service" module (the Rotor guide's Service
// section, scratchpad simplify/guide-gaps.md §2.9): Service → Requests (the
// list, one request, a new one), "Request" in the + list, and the
// contact's Requests card. The Jobs, Quotes and Plans tabs stay their own
// modules' screens. No data, keys or customer names ever go in crm-app/.

export default {
  name: "service",
  routes: [
    { path: "/requests", load: () => import("./requests.js"), title: "Requests", perm: "requests:read", parent: "/today", skeleton: "list" },
    { path: "/requests/new", load: () => import("./request-new.js"), title: "New request", perm: "requests:write", parent: "/requests" },
    { path: "/requests/new/:contact", load: () => import("./request-new.js"), title: "New request", perm: "requests:write", parent: "/contacts/:contact" },
    { path: "/requests/:id", load: () => import("./request.js"), title: "Request", perm: "requests:read", parent: "/requests" },
  ],
  nav: [],
  creates: [{ label: "Request", path: "/requests/new", perm: "requests:write", order: 21, icon: "clipboard", hint: "Someone asks for work or a look" }],
  contactTabs: [{ key: "requests", label: "Requests", order: 46, place: "docs", perm: "requests:read", load: () => import("./contact-tab.js") }],
  visitActions: [],
  todayCards: [],
  settings: [],
  styles: ["./service.css"],
};
