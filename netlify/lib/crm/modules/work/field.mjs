// The field part of the work module (M4b): the tech's day, what the people
// on a visit do there, timers and timesheets (design §5.5, §9.3, §2.5).
// Composed by work/index.mjs as a part, so M4b never edits the module's
// index. docs/CRM-WORK.md (field sections) describes it.
//
//   types-field.mjs    timer, timesheet
//   techday.mjs        GET /tech/day (the day payload the phone keeps offline)
//   visit-actions.mjs  on my way, running late, timers, checklist, notes,
//                      photos, upsell lines, complete, no access, incident,
//                      clock in/out; the "visit" file owner
//   timers.mjs         segments, the work.timers sweep, import phase 24
//   timesheets.mjs     shifts, device times, pending entries, weekly
//                      approval, the pay estimate (D3), the work.clock
//                      sweep, the person's and the office's routes, import
//                      phase 26
//
// It changes visits only through the office part's changeVisit() and the
// field transitions states.mjs already holds (on_my_way, running_late,
// start, pause, finish, no_access).

import { types } from "./types-field.mjs";
import { techDayRoutes } from "./techday.mjs";
import { fieldVisitRoutes } from "./visit-actions.mjs";
import { timersSweep, timerPhase, forgottenCount } from "./timers.mjs";
import { timesheetRoutes, clockSweep, timesheetPhase, pendingCount, weeksToApprove } from "./timesheets.mjs";

// Templates in Barta's voice (barta-rules §8): no "Reply STOP" (the sender
// adds the opt-out footer, D5), no em dashes.
export const FIELD_TEMPLATES = [
  { key: "on_my_way", name: "On my way", channel: "sms", category: "service",
    body: "Hi {{first_name|there}}, it's {{tech_first_name}} with {{company_name}}. I'm on my way and should be there in about {{eta_minutes}} minutes." },
  { key: "running_late", name: "Running late", channel: "sms", category: "service",
    body: "Hi {{first_name|there}}, it's {{tech_first_name}} with {{company_name}}. I'm running a little behind and should be there in about {{eta_minutes}} minutes. Thanks for your patience!" },
];

// The manual automations (§5.7.4): a tech's tap sends them, right away or
// not at all; the owner can turn them off or pick another template.
const manual = (key, label, template) => ({
  key, label, trigger: "manual", category: "service", imported: "no", mutates: false,
  defaults: { enabled: true, channels: ["sms"], template_keys: [template] },
  run: async () => ({ result: "skipped:manual" }),
});

export default {
  types,
  routes: [...techDayRoutes, ...fieldVisitRoutes, ...timesheetRoutes],
  sweeps: [
    { key: "work.timers", label: "Forgotten visit timers", lane: "fast", every: "pass", mutates: true, run: timersSweep },
    { key: "work.clock", label: "Forgotten clock-ins", lane: "fast", every: "pass", mutates: true, run: clockSweep },
  ],
  automations: [
    manual("visit.on_my_way", "On my way", "on_my_way"),
    manual("visit.running_late", "Running late", "running_late"),
  ],
  templates: FIELD_TEMPLATES,
  pushKinds: ["clock_reminder"],
  attention: [{ key: "work.timers", label: "Timers running for hours", perm: "time:edit_others", count: () => forgottenCount(), link: "#/timesheets" }],
  approvals: [
    { key: "work.time_entries", label: "Time entries to approve", perm: "time:edit_others", count: () => pendingCount(), link: "#/timesheets" },
    { key: "work.time_weeks", label: "Timesheet weeks to approve", perm: "time:edit_others", count: () => weeksToApprove(), link: "#/timesheets" },
  ],
  exportTypes: ["timer", "timesheet"],
  importPhases: [timerPhase, timesheetPhase],
};
