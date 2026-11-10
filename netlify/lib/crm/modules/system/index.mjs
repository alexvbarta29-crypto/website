// Barta CRM module "system" (core, M1): users, team, settings, audit,
// outbox, files, runs, health, export, backups, API keys, templates,
// automation settings, notifications, suppressions, bulk runs, pending
// actions, push, search and the legacy customer list (design §11.2).
// M1.1 shipped the contact_stats type and the "stats.update" service; M1.2
// added the user type, the team and session routes, /me, /me/badges, the
// auth and permissions settings and the legacy Customers routes. M1.3 (part
// A, the engine) adds the file, run and pending_action types, the core
// settings documents and /settings, audit, files, runs, health, backups,
// export, approvals and API key routes, the core sweeps (system.seed,
// auth.sessions, backup.nightly, index.verify, files.backup, files.purge,
// backup.offsite) and the queue kinds "evt" (event listeners) and
// "pending.run" (approved actions). Part B adds templates, automations,
// the sender, bulk runs, notifications, push, outbox and suppressions.

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
import { CORE_SWEEPS } from "../../core/sweeps.mjs";
import { runListener } from "../../core/queue.mjs";
import { runApprovedAction } from "../../core/pending.mjs";
import "../../core/worker.mjs";

export default defineModule({
  name: "system",
  types,
  settings: systemSettings,
  routes: [...meRoutes, ...userRoutes, ...legacyRoutes, ...settingsRoutes, ...adminRoutes, ...auditRoutes, ...fileRoutes, ...pendingRoutes, ...apiKeyRoutes],
  sweeps: [...CORE_SWEEPS],
  queue: {
    // one item per event listener, marker done/evt/{event_id}--{module} (§11.3)
    evt: { handler: runListener, mutates: true },
    // an approved pending action, run once as the approver (§6.9)
    "pending.run": { handler: runApprovedAction, mutates: true },
  },
  services: {
    // (contact_id, part, mutate, ctx): the only way a module writes its ContactStats part (§5.1, §11.3)
    "stats.update": (contactId, part, mutate, ctx) => updateStats(contactId, part, mutate, ctx),
  },
});
