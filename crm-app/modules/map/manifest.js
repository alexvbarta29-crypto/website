// Client manifest of the "map" module (docs/CRM-MAP.md): Door to door (the
// knock map, its report and areas), the Team map, their settings, a Today
// card for a technician who knocks doors, and start(): the phone's side of
// the team map (location sharing while on the clock, sharing.js), loaded
// in the background after the app starts. This file is part of the app
// shell (precached), so it imports nothing; a screen's file a phone hasn't
// cached never stops the app from starting offline.

export default {
  name: "map",
  routes: [
    { path: "/knock", load: () => import("./knock.js"), title: "Door to door", perm: "canvass:use", parent: "/today" },
    // "Map" as a top-level screen (a tab the person pins, the bar's switcher): no parent, no back arrow
    { path: "/map", load: () => import("./knock.js"), title: "Map", perm: "canvass:use" },
    { path: "/knock/report", load: () => import("./report.js"), title: "Door-to-door report", perm: "canvass:use", parent: "/knock", skeleton: "list" },
    { path: "/knock/areas", load: () => import("./areas.js"), title: "Areas", perm: "canvass:use", parent: "/knock", skeleton: "list" },
    { path: "/team-map", load: () => import("./team.js"), title: "Team map", perm: "team_map:read", parent: "/today" },
    { path: "/settings/knock", load: () => import("./settings-knock.js"), title: "Door to door", perm: "settings:general", parent: "/settings" },
    { path: "/settings/maps", load: () => import("./settings-maps.js"), title: "Maps and the team map", perm: "settings:owner", parent: "/settings" },
  ],
  nav: [
    // for the bar's switcher (a pinnable "Map"): core's nav reads only "more" entries today, so this lists nowhere yet
    { where: "tab", key: "map", label: "Map", path: "/map", perm: "canvass:use", order: 26, icon: "map" },
    { where: "more", section: "sales", label: "Door to door", path: "/knock", perm: "canvass:use", order: 26, icon: "map" },
    { where: "more", section: "work", label: "Team map", path: "/team-map", perm: "team_map:read", order: 27, icon: "team" },
  ],
  creates: [],
  contactTabs: [],
  visitActions: [],
  // a technician's way in (home: false: the office has the Menu)
  todayCards: [{ key: "map", perm: "canvass:use", order: 45, home: false, load: () => import("./today-card.js") }],
  settings: [
    { label: "Door to door", path: "/settings/knock", perm: "settings:general", icon: "map", order: 60 },
    { label: "Maps and the team map", path: "/settings/maps", perm: "settings:owner", icon: "map", order: 61, owner: true },
  ],
  // after the app starts (main.js): the team map's location sharing, for whoever is asked to share
  start(app) { import("./sharing.js").then((m) => m.start(app)).catch(() => {}); },
};
