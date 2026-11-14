// Client manifest of the "automations" module: the custom automation
// builder (Messages & automations → Automations → one of yours): the
// editor (when, only if, then with waits, stop when, the plain-English
// sentence, a test run on a customer) and each one's run history. The list
// itself is the Automations screen (system/automations.js). Screens load
// with dynamic import(). No data, keys or customer names ever go in
// crm-app/ (§2.3).

export default {
  name: "automations",
  routes: [
    { path: "/automations/flow/:id", load: () => import("./editor.js"), title: "Automation", perm: "automations:configure", parent: "/automations" },
    { path: "/automations/flow/:id/runs", load: () => import("./runs.js"), title: "Run history", perm: "automations:configure", parent: "/automations/flow/:id", skeleton: "list" },
  ],
  nav: [],
  creates: [],
  contactTabs: [],
  visitActions: [],
  todayCards: [],
  settings: [],
  styles: ["./automations.css"],
};
