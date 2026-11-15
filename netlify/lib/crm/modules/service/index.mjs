// Barta CRM module "service" (the Rotor guide's Service section,
// scratchpad simplify/guide-gaps.md §2.9, S4, S15, S45b): requests and
// assessments (types.mjs, requests.mjs), the Jobs tab's tiles (jobs.mjs)
// and the job page's quick actions (actions.mjs). Jobs and visits stay the
// work module's; this one reads their index and makes jobs through
// work.createJobs.

import { defineModule } from "../../core/registry.mjs";
import { types } from "./types.mjs";
import { serviceRoutes } from "./routes.mjs";
import { TEMPLATES } from "./actions.mjs";
import { requestFromPortal, assessmentsDue } from "./requests.mjs";

export default defineModule({
  name: "service",
  types,
  perms: [
    { key: "requests:read", label: "See requests and assessments", roles: { owner: true, admin: true, tech: false } },
    { key: "requests:write", label: "Work requests: book assessments, convert, close", roles: { owner: true, admin: true, tech: false } },
  ],
  routes: serviceRoutes,
  templates: TEMPLATES,
  services: {
    // ({ contact, task, services, timing, notes, property_id, photo_ids }, w) → request (the portal's /p/request)
    "service.requestFromPortal": (input, w) => requestFromPortal(input || {}, w || {}),
    // (date) → { key: "assessments", count, overdue } (Home's Due today)
    "service.dueToday": (date) => assessmentsDue(date || undefined),
  },
  exportTypes: ["request"],
});
