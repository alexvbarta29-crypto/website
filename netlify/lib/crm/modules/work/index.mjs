// Barta CRM module "work": jobs, visits, scheduling, assignment,
// checklists, photos, timers, timesheets and availability (design §5.5).
// docs/CRM-WORK.md describes it.
//
// Two parts, two tracks (§11.2, §11.3: parts are plain objects with the
// same keys as a module, merged by the registry):
//   office (M4a, this file composes it): types.mjs (job, visit,
//     checklist_template, time_off), states.mjs (both state machines, the
//     field transitions included), office.mjs (writing jobs and visits,
//     work.createJobs / work.cancelJobs, the job rule, listeners, stats,
//     merge, seeds), office-schedule.mjs (what the schedule reads and works
//     out: windows, warnings, route order), office-moveday.mjs (the rain-day
//     move), office-routes.mjs (the API), automations.mjs (visit.confirm,
//     the reminders, work.stale, work.stats, templates), import-rotor.mjs
//     (§10.2 rows 3, 22, 23)
//   field (M4b): field.mjs and its files (timers, timesheets, the tech's day)
//
// The tech app's extension points: changeVisit(id, event, opts) in
// office.mjs (every visit change, the field events included, goes through
// states.mjs and keeps the job in step), and the client's visitActions
// (crm-app/modules/work/manifest.js).

import { defineModule } from "../../core/registry.mjs";
import { InputError } from "../../core/errors.mjs";
import { isLocalTime } from "../../core/clock.mjs";
import { isPlainObject } from "../../core/validate.mjs";
import { types } from "./types.mjs";
import field from "./field.mjs";
import { workRoutes } from "./office-routes.mjs";
import { visitListRoutes } from "./visit-list.mjs";
import "./office-moveday.mjs";
import {
  createJobs, cancelJobs, listeners, statsParts, onMergeWork, seedChecklists, WORK_DEFAULTS,
} from "./office.mjs";
import { automations, sweeps, TEMPLATES, staleCount } from "./automations.mjs";
import { phases } from "./import-rotor.mjs";

function validateWork(v) {
  const src = isPlainObject(v) ? v : {};
  const out = {};
  const num = (k, min, max) => {
    if (src[k] === undefined) return;
    if (!Number.isInteger(src[k]) || src[k] < min || src[k] > max) throw new InputError(`Use a whole number from ${min} to ${max}.`, k);
    out[k] = src[k];
  };
  num("stale_in_progress_days", 1, 30);
  num("timer_autoclose_after_min", 15, 720);
  num("reopen_days", 0, 60);
  num("default_window_minutes", 15, 720);
  num("default_duration_min", 15, 720);
  num("confirm_skip_within_days", 0, 14);
  num("late_cancel_hours", 0, 168);
  for (const k of ["clock_flag_at", "clock_autoclose_at"]) {
    if (src[k] === undefined) continue;
    if (!isLocalTime(src[k])) throw new InputError("Use a time like 19:00.", k);
    out[k] = src[k];
  }
  return out;
}

const office = {
  types,
  statsParts,
  settings: { work: { defaults: { ...WORK_DEFAULTS }, validate: validateWork, perm: "settings:general" } },
  routes: [...workRoutes, ...visitListRoutes],
  events: listeners,
  emits: [
    "job.created", "job.scheduled", "job.completed", "job.reopened", "job.cancelled",
    "visit.scheduled", "visit.rescheduled", "visit.assigned", "visit.cancelled", "visit.completed", "visit.no_access",
  ],
  services: {
    // (jobs, opId, scope, ctx) → job_ids
    "work.createJobs": (jobs, opId, scope, ctx) => createJobs(jobs, opId, scope, ctx || {}),
    // (job_ids, reason, opId, ctx) → { cancelled, skipped }
    "work.cancelJobs": (ids, reason, opId, ctx) => cancelJobs(ids, reason, opId, ctx || {}),
  },
  needs: ["contacts.resolve", "notify.users", "bulk.create"],
  sweeps,
  automations,
  templates: TEMPLATES,
  seeds: [{ v: 1, run: seedChecklists }],
  onMerge: onMergeWork,
  attention: [{ key: "work.stale", label: "Stale jobs", perm: "schedule:write", count: () => staleCount(), link: "#/jobs?status=stale" }],
  pushKinds: ["visit_assigned", "visit_changed", "visit_cancelled"],
  activityKinds: {
    "visit.scheduled": { label: "Visit booked", icon: "schedule" },
    "visit.completed": { label: "Visit done", icon: "check" },
    "visit.cancelled": { label: "Visit cancelled", icon: "schedule" },
    "visit.no_access": { label: "No access at the visit", icon: "schedule" },
  },
  exportTypes: ["job", "visit", "checklist_template", "time_off"],
  importPhases: phases,
};

export default defineModule({
  name: "work",
  parts: [office, field],
});
