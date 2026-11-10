// Barta CRM module "quotes" (M3a): price book, pricing engine, discounts, options, the quote lifecycle and portal approval.
// Stub created in M1.1 so the quotes track only edits inside this directory;
// the manifest grows with the module (design §11.3 lists every key).

import { defineModule } from "../../core/registry.mjs";
import { types } from "./types.mjs";

export default defineModule({
  name: "quotes",
  types,
});
