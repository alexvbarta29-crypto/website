// Barta CRM module "system" (core, M1): users, team, settings, audit,
// outbox, files, runs, health, export, backups, API keys, templates,
// automation settings, notifications, suppressions, bulk runs, pending
// actions, push, search and the legacy customer list (design §11.2).
// M1.1 ships the contact_stats type and the "stats.update" service; the
// routes and the rest arrive in M1.2 and M1.3.

import { defineModule } from "../../core/registry.mjs";
import { updateStats } from "../../../crm-store.mjs";
import { types } from "./types.mjs";

export default defineModule({
  name: "system",
  types,
  services: {
    // (contact_id, part, mutate, ctx): the only way a module writes its ContactStats part (§5.1, §11.3)
    "stats.update": (contactId, part, mutate, ctx) => updateStats(contactId, part, mutate, ctx),
  },
});
