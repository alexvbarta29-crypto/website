// Barta CRM module "work" (M4a (office) + M4b (field)): jobs, visits, scheduling, assignment, checklists, photos, timers, timesheets and availability (design §5.5).
// Stub created in M1.1 so the tracks only edit inside their own files:
// M4a owns this file, types.mjs, states.mjs and the office part; M4b owns
// field.mjs and types-field.mjs, which this module composes as a part
// (§11.3: parts are plain objects with the same keys as a module).

import { defineModule } from "../../core/registry.mjs";
import { types } from "./types.mjs";
import field from "./field.mjs";

export default defineModule({
  name: "work",
  parts: [{ types }, field],
});
