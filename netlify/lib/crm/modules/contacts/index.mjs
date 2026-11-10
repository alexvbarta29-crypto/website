// Barta CRM module "contacts" (M2a): people and businesses, properties, tags, sources, consent, matching, merge and lead intake.
// Stub created in M1.1 so the contacts track only edits inside this directory;
// the manifest grows with the module (design §11.3 lists every key).

import { defineModule } from "../../core/registry.mjs";
import { types } from "./types.mjs";

export default defineModule({
  name: "contacts",
  types,
});
