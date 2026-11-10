// Record types of the core "system" module (design §3.3). M1.1 defines the
// contact_stats sidecar (§5.1), which updateStats() writes; M1.2 and M1.3
// add user, file, run, outbox, pending_action, template and notification.

import { defineType } from "../../core/registry.mjs";
import { isId } from "../../core/ids.mjs";
import { InputError } from "../../core/errors.mjs";
import { contactShard, statsIndexRow, STATS_INDEX, STATS_INDEX_PART } from "../../core/stats.mjs";

// rec/contact_stats/{contactId}: envelope + one part per owning module.
// Written only by crm-store updateStats(); never a user edit, never imported
// (rotorFields empty), never shown to a tech (techFields = id only).
export const contactStatsType = defineType({
  type: "contact_stats",
  prefix: null,
  idType: "contact",
  v: 1,
  validate(data) {
    if (!isId(data.id, "contact")) throw new InputError("contact_stats needs a contact id.", "id");
    return data;
  },
  rotorFields: [],
  techFields: ["id"],
  shadow: false,
  audit: false,
  indexes: [{
    name: STATS_INDEX,
    part: STATS_INDEX_PART,
    primary: false,
    shard: (r) => contactShard(r.id),
    row: (r) => statsIndexRow(r),
  }],
  example: () => ({ id: "ct_0000000000000000000a", type: "contact_stats", v: 1, wv: 1 }),
});

export const types = [contactStatsType];
