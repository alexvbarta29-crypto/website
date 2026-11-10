// Barta CRM module "reports" (M7b): daily rollups, KPI reports and the dashboard feed.
// Stub created in M1.1 so the reports track only edits inside this directory;
// the manifest grows with the module (design §11.3 lists every key).

import { defineModule } from "../../core/registry.mjs";
import { types } from "./types.mjs";

export default defineModule({
  name: "reports",
  types,
});
