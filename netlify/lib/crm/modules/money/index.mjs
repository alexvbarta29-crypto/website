// Barta CRM module "money" (M5): invoices, payments, tips, refunds, deposits, credits and autopay.
// Stub created in M1.1 so the money track only edits inside this directory;
// the manifest grows with the module (design §11.3 lists every key).

import { defineModule } from "../../core/registry.mjs";
import { types } from "./types.mjs";

export default defineModule({
  name: "money",
  types,
});
