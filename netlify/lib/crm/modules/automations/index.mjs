// Barta CRM module "automations": the custom automation builder ("when X
// happens, if Y, then do Z after a wait"), Flyra and Rotor style, on top of
// the core automation engine (core/automations.mjs: markers, the sender,
// the guard, the run log, bulk runs). docs/CRM-AUTOMATIONS.md describes it.
//
// Files: catalog.mjs (triggers, conditions, steps, starters, the plain-
// English summary; pure), when.mjs (when a step is due; pure), facts.mjs
// (what a condition reads), types.mjs (flow, flow_run), engine.mjs
// (starting, the steps, the caps, a test run), routes.mjs (the API).

import { defineModule } from "../../core/registry.mjs";
import { InputError } from "../../core/errors.mjs";
import { isPlainObject } from "../../core/validate.mjs";
import { types } from "./types.mjs";
import { EVENT_TRIGGERS, TEMPLATES } from "./catalog.mjs";
import { onEvent, runStep, dailySweep, pruneSweep, SEND_DEFS, FLOW_SETTINGS } from "./engine.mjs";
import { flowRoutes } from "./routes.mjs";

function validateFlowSettings(v) {
  const src = isPlainObject(v) ? v : {};
  const out = {};
  const num = (k, min, max) => {
    if (src[k] === undefined) return;
    if (!Number.isInteger(src[k]) || src[k] < min || src[k] > max) throw new InputError(`Use a whole number from ${min} to ${max}.`, k);
    out[k] = src[k];
  };
  num("max_texts_per_day", 1, 10);
  num("max_runs_per_day", 1, 2000);
  return out;
}

// every event a trigger names, one listener each (the daily ones have none)
const listeners = Object.fromEntries(EVENT_TRIGGERS.map((name) => [name, { handler: onEvent, mutates: true }]));

export default defineModule({
  name: "automations",
  types,
  settings: { flows: { defaults: { ...FLOW_SETTINGS }, validate: validateFlowSettings, perm: "automations:configure" } },
  routes: flowRoutes,
  events: listeners,
  queue: { "flow.step": { handler: runStep, mutates: true } },
  sweeps: [
    { key: "flows.daily", label: "Daily automations", lane: "fast", every: "pass", mutates: true, run: (ctx) => dailySweep(ctx) },
    { key: "flows.prune", label: "Old daily text counts", lane: "bulk", every: "daily", at_local: "03:40", mutates: false, maintenance: true, run: () => pruneSweep() },
  ],
  automations: SEND_DEFS,
  templates: TEMPLATES,
  needs: ["notify.users", "sales.createTask", "sales.dealOf", "sales.markDeal", "sales.enroll", "contacts.tag", "contacts.setOwner"],
});
