// Barta CRM module "mcp" (M7c): the MCP endpoint that lets Claude run the business through the CRM.
// Stub created in M1.1 so the mcp track only edits inside this directory;
// the manifest grows with the module (design §11.3 lists every key).

import { defineModule } from "../../core/registry.mjs";
import { types } from "./types.mjs";

export default defineModule({
  name: "mcp",
  types,
});
