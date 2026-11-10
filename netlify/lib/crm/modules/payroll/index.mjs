// Barta CRM module "payroll" (M7a): pay periods, pay lines, commissions and tips.
// Stub created in M1.1 so the payroll track only edits inside this directory;
// the manifest grows with the module (design §11.3 lists every key).

import { defineModule } from "../../core/registry.mjs";
import { types } from "./types.mjs";

export default defineModule({
  name: "payroll",
  types,
});
