// Barta CRM module "comms" (M6): conversations, messages, campaigns and
// reviews (design §5.7, §6.3, §6.4, §6.6, §11.4 "M6 Comms").
// The manifest grows below as the parts land; each part lives in its own file.

import { defineModule } from "../../core/registry.mjs";
import { InputError } from "../../core/errors.mjs";
import { types } from "./types.mjs";
import { phases } from "./import-rotor.mjs";
import { defineFileOwner } from "../../core/files.mjs";
import { techVisibleContacts } from "../../core/perms.mjs";

// A message's files (imported attachments, MMS): whoever may read the
// thread; a tech only for a contact on their own visits. Never edited.
defineFileOwner("message", {
  canRead: async (ctx, msg) => {
    if (ctx.can("inbox:read")) return true;
    if (!ctx.user || !ctx.holds || ctx.holds("inbox:read") !== "own") return false;
    return ctx.can("inbox:read", { type: "message", record: msg, visible: (await techVisibleContacts(ctx.user.id)).has(msg.contact_id) });
  },
  canEdit: () => false,
});

function validatePinTypes(v) {
  const list = v && Array.isArray(v.types) ? v.types : [];
  if (list.length > 50) throw new InputError("Up to 50 pin types.", "types");
  return { types: list.map((t) => ({ rotor_id: String((t && t.rotor_id) || "").slice(0, 64), label: String((t && t.label) || "").slice(0, 40), color: String((t && t.color) || "").slice(0, 9), active: !(t && t.active === false) })).filter((t) => t.label) };
}

export default defineModule({
  name: "comms",
  types,
  settings: {
    // Rotor's eight map pin types (§10.2 row 35), kept for a later knock map
    pin_types: { defaults: { types: [] }, validate: validatePinTypes, perm: "settings:general" },
  },
  exportTypes: ["conversation", "message", "campaign", "review"],
  importPhases: phases,
});
