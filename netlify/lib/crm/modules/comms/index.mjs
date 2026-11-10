// Barta CRM module "comms" (M6): conversations, messages, templates, automations, campaigns and reviews.
// Stub created in M1.1 so the comms track only edits inside this directory;
// the manifest grows with the module (design §11.3 lists every key).

import { defineModule } from "../../core/registry.mjs";
import { types } from "./types.mjs";

export default defineModule({
  name: "comms",
  types,
});
