// Barta CRM module "plans" (M3b): service plans, agreements and Christmas lights seasons.
// Stub created in M1.1 so the plans track only edits inside this directory;
// the manifest grows with the module (design §11.3 lists every key).

import { defineModule } from "../../core/registry.mjs";
import { types } from "./types.mjs";

export default defineModule({
  name: "plans",
  types,
});
