// Core "system" module (core, M1): users, team, settings, audit, outbox,
// files, runs, health, export, backups, API keys, templates, automation
// settings, notifications, suppressions, bulk runs, pending actions, push,
// search and the legacy customer list (design §11.2).
// M1.1 shipped the contact_stats type and the "stats.update" service; M1.2
// added the user type, the team and session routes, /me, /me/badges, the
// auth and permissions settings and the legacy Customers routes. M1.3 part
// A (the engine) added the file, run and pending_action types, the core
// settings documents and /settings, audit, files, runs, health, backups,
// export, approvals and API key routes, the core sweeps and the queue
// kinds "evt" and "pending.run". Part B adds messaging: the template,
// outbox, notification and bulk_run types, the comms stats part (written by
// the sender), the templates, automations, notifications, outbox,
// suppressions, bulk-run, messages, push, search and permissions routes,
// the services bulk.create, notify.users and the default messages.sink,
// the queue kinds for automations, scheduled sends and notifications, and
// the templates.seed and notifications.prune sweeps. Home (GET /home, the
// owner's first screen: the numbers, today's visits, what needs you) reads
// every module's attention and approvals rows and the Rotor snapshot.

import { defineModule } from "../../core/registry.mjs";
import { updateStats } from "../../../crm-store.mjs";
import { types } from "./types.mjs";
import { userRoutes } from "./users.mjs";
import { meRoutes } from "./me.mjs";
import { legacyRoutes } from "./legacy.mjs";
import { systemSettings, settingsRoutes } from "./settings.mjs";
import { adminRoutes } from "./admin.mjs";
import { auditRoutes } from "./audit.mjs";
import { fileRoutes } from "./files.mjs";
import { pendingRoutes } from "./pending.mjs";
import { apiKeyRoutes } from "./apikeys.mjs";
import { commsRoutes } from "./comms.mjs";
import { searchRoutes } from "./search.mjs";
import { permissionRoutes } from "./permissions.mjs";
import { homeRoutes } from "./home.mjs";
import { seedTemplates } from "../../core/templates.mjs";
import { runEventAutomation, runSendStep } from "../../core/automations.mjs";
import { runQueuedSend, coreMessagesSink } from "../../core/send.mjs";
import { deliverNotification, notifyUsers, pruneNotifications } from "../../core/notify.mjs";
import { bulkCreate } from "../../core/bulk.mjs";
import { CORE_SWEEPS } from "../../core/sweeps.mjs";
import { runListener } from "../../core/queue.mjs";
import { runApprovedAction } from "../../core/pending.mjs";
import "../../core/worker.mjs";

export default defineModule({
  name: "system",
  types,
  settings: systemSettings,
  routes: [...meRoutes, ...userRoutes, ...legacyRoutes, ...settingsRoutes, ...adminRoutes, ...auditRoutes, ...fileRoutes, ...pendingRoutes, ...apiKeyRoutes,
    ...commsRoutes, ...searchRoutes, ...permissionRoutes, ...homeRoutes],
  // the comms part of ContactStats (§5.1): written by core's sender in test/live mode
  // (first text per sending number, last contact); comms (M6) adds last_inbound_at
  statsParts: {
    comms: {
      defaults: { first_sms: {}, last_contacted_at: null, last_inbound_at: null },
      // `lca`, not `lc`: the contact part's `lc` is the lifecycle (§3.5), and a row's parts share one object
      row: (p) => ({ lca: (p && p.last_contacted_at) || null, li: (p && p.last_inbound_at) || null }),
    },
  },
  sweeps: [
    ...CORE_SWEEPS,
    // modules' built-in templates, once each (owner edits are never overwritten)
    { key: "templates.seed", label: "Built-in templates", lane: "fast", every: "pass", mutates: true, run: async (ctx) => { const r = await seedTemplates(ctx.write(), { budget: ctx.budget }); return { progress: r.created, done: r.done }; } },
    { key: "notifications.prune", label: "Old notifications", lane: "fast", every: "daily", at_local: "03:30", mutates: false, maintenance: true, run: pruneNotifications },
  ],
  queue: {
    // one item per event listener, marker done/evt/{event_id}--{module} (§11.3)
    evt: { handler: runListener, mutates: true },
    // an approved pending action, run once as the approver (§6.9)
    "pending.run": { handler: runApprovedAction, mutates: true },
    // an automation triggered by an event (marker done/evt/{event_id}--auto.{key})
    "automation.event": { handler: runEventAutomation, mutates: true },
    // one due step of an automation: re-checked, then sent (marker {ns}/{automation}/{step})
    "automation.send": { handler: runSendStep, mutates: false },
    // a person's send that waited for quiet hours or its send_at
    "send.message": { handler: runQueuedSend, mutates: false },
    // staff notifications: one per person, then web push
    "notify.deliver": { handler: deliverNotification, mutates: false },
  },
  services: {
    // (contact_id, part, mutate, ctx): the only way a module writes its ContactStats part (§5.1, §11.3)
    "stats.update": (contactId, part, mutate, ctx) => updateStats(contactId, part, mutate, ctx),
    // ({ kind, recipients, template_key, vars?, related?, requested_by }, ctx) → bulk_run_id (§5.7.4)
    "bulk.create": bulkCreate,
    // (user_ids, { kind, title, body, link }, ctx): in-app + push (§5.7.7)
    "notify.users": notifyUsers,
    // (message, ctx) → { outbox_id? }: core's default; comms (M6) provides the real sink
    "messages.sink": coreMessagesSink,
  },
});
