// Client manifest of the "import" module (M2c, design §10, §9.2): the
// Import screen (More → Import from Rotor, owners): start an import (the
// one-run upload key is shown once), the upload's progress, the team map,
// the phases as they run, conflicts to settle, the report and the id map.
// Screens load with dynamic import(). No data, keys or customer names ever
// go in crm-app/ (§2.3). M8: the automatic daily import key (auto-key.js)
// and the switch from Rotor (cutover-checklist.js, cutover-preview.js,
// cutover-runbook.js; owners: cutover:run).

export default {
  name: "import",
  routes: [
    { path: "/import", load: () => import("./list.js"), title: "Import from Rotor", perm: "import:run", parent: "/settings", skeleton: "list" },
    { path: "/import/:id", load: () => import("./run.js"), title: "Import", perm: "import:run", parent: "/import" },
    { path: "/import/:id/conflicts", load: () => import("./conflicts.js"), title: "Conflicts", perm: "import:run", parent: "/import/:id", skeleton: "list" },
    { path: "/import/auto", load: () => import("./auto-key.js"), title: "Automatic daily import", perm: "import:run", parent: "/import" },
    { path: "/cutover", load: () => import("./cutover-checklist.js"), title: "Switch from Rotor", perm: "cutover:run", parent: "/settings" },
    { path: "/cutover/preview", load: () => import("./cutover-preview.js"), title: "Switch-over preview", perm: "cutover:run", parent: "/cutover" },
    { path: "/cutover/runbook", load: () => import("./cutover-runbook.js"), title: "Switch-over runbook", perm: "cutover:run", parent: "/cutover" },
  ],
  nav: [
    { where: "more", section: "customers", label: "Import from Rotor", path: "/import", perm: "import:run", order: 86, icon: "data" },
  ],
  creates: [],
  contactTabs: [],
  visitActions: [],
  todayCards: [],
  settings: [
    { label: "Import from Rotor", path: "/import", perm: "import:run", icon: "data", order: 92, owner: true },
    { label: "Switch from Rotor", path: "/cutover", perm: "cutover:run", icon: "bolt", order: 93, owner: true },
  ],
  styles: ["./import.css"],
};
