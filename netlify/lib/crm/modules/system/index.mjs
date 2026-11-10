// Barta CRM module "system" (core, M1): users, team, settings, audit,
// outbox, files, runs, health, export, backups, API keys, templates,
// automation settings, notifications, suppressions, bulk runs, pending
// actions, push, search and the legacy customer list (design §11.2).
// M1.1 shipped the contact_stats type and the "stats.update" service; M1.2
// adds the user type, the team and session routes, /me, /me/badges, the
// auth and permissions settings and the legacy Customers routes; M1.3 adds
// the rest.

import { defineModule } from "../../core/registry.mjs";
import { updateStats } from "../../../crm-store.mjs";
import { types } from "./types.mjs";
import { userRoutes } from "./users.mjs";
import { meRoutes } from "./me.mjs";
import { legacyRoutes } from "./legacy.mjs";
import { systemSettings } from "./settings.mjs";

export default defineModule({
  name: "system",
  types,
  settings: systemSettings,
  routes: [...meRoutes, ...userRoutes, ...legacyRoutes],
  services: {
    // (contact_id, part, mutate, ctx): the only way a module writes its ContactStats part (§5.1, §11.3)
    "stats.update": (contactId, part, mutate, ctx) => updateStats(contactId, part, mutate, ctx),
  },
});
