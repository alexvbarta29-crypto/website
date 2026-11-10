// Barta CRM module "sales" (M2b): deals, follow-up cadences, enrollments, tasks and calls.
// Stub created in M1.1 so the sales track only edits inside this directory;
// the manifest grows with the module (design §11.3 lists every key).

import { defineModule } from "../../core/registry.mjs";
import { types } from "./types.mjs";

export default defineModule({
  name: "sales",
  types,
});
