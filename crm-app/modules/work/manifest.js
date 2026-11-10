// Client manifest of the "work" module (design §11.3, §9.2): the office
// part (M4a) and the field part (M4b), merged, each track editing only its
// own object below. Screens load with dynamic import(); this file is part
// of the app shell (precached), so it imports nothing. No data, keys or
// customer names ever go in crm-app/ (§2.3).
//
// Office screens: Schedule (day, week, list, to book), a tech's Route, the
// rain-day move, Time off, Jobs and one job, New job, the single Visit
// screen (office part; M4b's field panel and Money's "Collect payment"
// arrive through visitActions, the contract below), the contact's Work
// tab, today's visits on Today, Settings → Checklists.

const office = {
  routes: [
    { path: "/schedule", load: () => import("./office-schedule.js"), title: "Schedule", perm: "schedule:read", skeleton: "list" },
    { path: "/schedule/route/:date/:user", load: () => import("./office-route.js"), title: "Route", perm: "schedule:read", parent: "/schedule" },
    { path: "/schedule/move-day", load: () => import("./office-moveday.js"), title: "Rain day", perm: "schedule:write", parent: "/schedule" },
    { path: "/schedule/time-off", load: () => import("./office-timeoff.js"), title: "Time off", perm: "schedule:write", parent: "/schedule", skeleton: "list" },
    { path: "/jobs", load: () => import("./office-jobs.js"), title: "Jobs", perm: "schedule:read", parent: "/schedule", skeleton: "list" },
    { path: "/jobs/new", load: () => import("./office-job-new.js"), title: "New job", perm: "schedule:write", parent: "/jobs" },
    { path: "/jobs/new/:contact", load: () => import("./office-job-new.js"), title: "New job", perm: "schedule:write", parent: "/contacts/:contact" },
    { path: "/jobs/:id", load: () => import("./office-job.js"), title: "Job", perm: "schedule:read", parent: "/jobs" },
    // the office opens visits from the Schedule; a tech's way back from a deep link lands on its "Open Today" card
    { path: "/visits/:id", load: () => import("./visit.js"), title: "Visit", perm: "schedule:read", parent: "/schedule" },
    { path: "/settings/checklists", load: () => import("./office-checklists.js"), title: "Checklists", perm: "settings:general", parent: "/settings", skeleton: "list" },
    { path: "/settings/checklists/:id", load: () => import("./office-checklist.js"), title: "Checklist", perm: "settings:general", parent: "/settings/checklists" },
  ],
  nav: [{ where: "more", label: "Jobs", path: "/jobs", perm: "schedule:write", order: 24, icon: "list" }],
  creates: [{ label: "New job", path: "/jobs/new", perm: "schedule:write", order: 25, icon: "schedule" }],
  contactTabs: [{ key: "work", label: "Work", order: 50, load: () => import("./office-contact-tab.js") }],
  visitActions: [],
  // today's visits by person, and jobs that need a look (the office)
  todayCards: [{ key: "work", perm: "schedule:write", order: 15, load: () => import("./office-today-card.js") }],
  settings: [{ label: "Checklists", path: "/settings/checklists", perm: "settings:general", icon: "check", order: 50 }],
  styles: ["./office-styles.css"],
};

// The field part (M4b owns this object, with work/visit-field.js and
// work/tech-*.js; design §11.4).
//
// visitActions appear on the single Visit screen (work/visit.js, M4a):
//   { key, label, when: "assignee" | "office" | "any", order?, perm?, icon?,
//     panel?: true, load: () => import("./visit-field.js") }
// A panel module default-exports { load?(data, ctx) → state,
// render(state, ctx) → html``, events? } and is drawn inline under the
// visit's head; its events get (event, el, ctx) with ctx.data (what GET
// /visits/:id answered: { visit, job, contact, property, people, can }),
// ctx.state (the panel's own state), ctx.rerender() and ctx.refresh(). A
// button module default-exports { run(data, ctx) } and runs on tap. Money's
// "Collect payment" lives in the money manifest's visitActions the same way.
const field = {
  routes: [],
  nav: [],
  creates: [],
  contactTabs: [],
  visitActions: [],
  todayCards: [],
  settings: [],
  styles: [],
};

const merge = (k) => [...(office[k] || []), ...(field[k] || [])];

export default {
  name: "work",
  routes: merge("routes"),
  nav: merge("nav"),
  creates: merge("creates"),
  contactTabs: merge("contactTabs"),
  visitActions: merge("visitActions"),
  todayCards: merge("todayCards"),
  settings: merge("settings"),
  styles: merge("styles"),
};
