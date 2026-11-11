// Client manifest of the "import" module (M2c, design §10, §9.2): the
// Import screen (More → Import from Rotor, owners): start an import (the
// one-run upload key is shown once), the upload's progress, the team map,
// the phases as they run, conflicts to settle, the report and the id map.
// Screens load with dynamic import(). No data, keys or customer names ever
// go in crm-app/ (§2.3).

export default {
  name: "import",
  routes: [
    { path: "/import", load: () => import("./list.js"), title: "Import from Rotor", perm: "import:run", parent: "/today", skeleton: "list" },
    { path: "/import/:id", load: () => import("./run.js"), title: "Import", perm: "import:run", parent: "/import" },
    { path: "/import/:id/conflicts", load: () => import("./conflicts.js"), title: "Conflicts", perm: "import:run", parent: "/import/:id", skeleton: "list" },
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
  ],
  styles: ["./import.css"],
};
