// Barta CRM module "import" (M2c (+ M8 cutover)): the Rotor import framework: staging, id map, dedupe review, reconciliation report, parallel run and cutover.
// Stub created in M1.1 so the import track only edits inside this directory;
// the manifest grows with the module (design §11.3 lists every key).

import { defineModule } from "../../core/registry.mjs";
import { types } from "./types.mjs";

export default defineModule({
  name: "import",
  types,
});
