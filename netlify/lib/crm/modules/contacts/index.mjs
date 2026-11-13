// Barta CRM module "contacts" (M2a): people and businesses, properties, tags,
// sources, consent, matching, merge and lead intake (design §5.1, §6.7,
// §6.8, §10.2 rows 6-12 and 36). docs/CRM-CONTACTS.md describes it.
//
// Files: types.mjs (contact, property, merge_candidate), display.mjs (names,
// phones, addresses, the service-area tier; the legacy list's helpers live
// here too), match.mjs (resolve, findMatches, merge candidates), intake.mjs
// (intakeLead), hook.mjs (the website's dual-write after Rotor),
// webhook.mjs (POST /hooks/lead/:token and its tokens), merge.mjs (the
// merge op and runs), properties.mjs (ensureProperty, geocoding),
// stats.mjs (the contacts stats part, lifecycle), routes.mjs (the API),
// import-rotor.mjs (the import phases).

import { defineModule } from "../../core/registry.mjs";
import { readIndex } from "../../../crm-store.mjs";
import "../../adapters/maps-google.mjs";
import { types } from "./types.mjs";
import { contactRoutes } from "./routes.mjs";
import { webhookRoutes } from "./webhook.mjs";
import { intakeService } from "./intake.mjs";
import { resolveId, findMatches } from "./match.mjs";
import { ensureProperty, runGeocode } from "./properties.mjs";
import { onMergeContacts } from "./merge.mjs";
import { statsParts, lifecycleListeners, runContactStats } from "./stats.mjs";
import { phases } from "./import-rotor.mjs";

async function pendingCandidates() {
  const ix = await readIndex("merge-candidates", "");
  return ix.rows.filter((r) => r.st === "pending").length;
}

export default defineModule({
  name: "contacts",
  types,
  statsParts,
  routes: [...contactRoutes, ...webhookRoutes],
  events: lifecycleListeners,
  emits: ["lead.created", "contact.merged", "consent.changed"],
  services: {
    // (input, { origin, rotor? }, ctx) → { ok, contact_id, created, deal_id?, enrollment_id? } (§6.8)
    "contacts.intake": intakeService,
    // (contact_id, ctx) → contact_id: follows merging_into / merged_into
    "contacts.resolve": (id, ctx) => resolveId(id, ctx),
    // ({ phones, emails, first_name, last_name, zip }, ctx) → [{ id, reason, confidence }]
    "contacts.findMatches": (q, ctx) => findMatches(q, ctx),
    // (contact_id, address, ctx) → property_id
    "contacts.ensureProperty": (cid, address, ctx) => ensureProperty(cid, address, ctx),
  },
  // optional (Signs & flyers): a lead from a sign's QR code names it
  needs: ["sales.enroll", "sales.qrResolve", "sales.qrLead"],
  sweeps: [
    { key: "contacts.stats", label: "Contact stats and lifecycle", lane: "bulk", every: "daily", at_local: "02:30", mutates: true, run: runContactStats },
    { key: "contacts.geocode", label: "Map points for properties", lane: "bulk", every: "pass", mutates: true, run: runGeocode },
  ],
  onMerge: onMergeContacts,
  attention: [{ key: "contacts.merge_candidates", label: "Possible duplicates", perm: "contacts:merge", count: pendingCandidates, link: "#/merge" }],
  activityKinds: {
    "lead.intake": { label: "Website request", icon: "inbox" },
    note: { label: "Note", icon: "doc" },
    "contact.merged": { label: "Merged a duplicate", icon: "contacts" },
  },
  exportTypes: ["contact", "property", "merge_candidate"],
  importPhases: phases,
});
