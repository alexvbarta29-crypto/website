// Barta CRM core: the parallel-run guard's store backstop (design §0 rule 12,
// §3.10 "The parallel-run guard", second enforcement).
//
// While sys/mode.system_of_record is "rotor", automation (sweeps, listeners,
// queue handlers, automations: ctx.actor_kind === "automation") may create
// or change only sandboxed records. crm-store calls these checks on every
// write; they throw ParallelRunGuard, which the automation engine catches
// and turns into an `alog/... would-<action>` row. Imports (origin "import")
// and people (actor_kind "user", portal, an approved pending action) are
// never stopped here. Derived data (contact_stats, index rows, markers,
// alog, outbox, runs) does not go through these checks.
//
// Pure functions: crm-store reads the contact and passes it in.

import { ParallelRunGuard } from "./errors.mjs";
import { sandboxed } from "./context.mjs";

// Types whose records mirror Rotor's and must not be created for an imported
// customer by automation before cutover (§3.10).
export const MIRRORED_TYPES = Object.freeze(["job", "visit", "invoice", "payment", "message", "conversation", "quote", "plan", "agreement"]);

const sorOf = (ctx) => (ctx && ctx.mode && ctx.mode.system_of_record) || "rotor";

// Whether the guard applies to this write at all.
export function guardActive(ctx) {
  if (!ctx || ctx.actor_kind !== "automation") return false;
  if (ctx.origin === "import") return false;
  return sorOf(ctx) !== "crm";
}

// Value at a dotted path ("flags.vendor").
export function pick(obj, path) {
  let cur = obj;
  for (const k of String(path).split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = cur[k];
  }
  return cur;
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// The rotorFields (dotted paths) whose values differ between two versions.
export function rotorFieldsChanged(fields, before, after) {
  return (fields || []).filter((f) => !same(pick(before, f), pick(after, f)));
}

// Automation creating a mirrored record: allowed only for a sandboxed contact.
export function checkCreate({ def, record, contact, ctx }) {
  if (!guardActive(ctx) || !def || !def.mirrored) return;
  if (contact && sandboxed(contact, contact)) return;
  throw new ParallelRunGuard("Rotor is still in charge of this customer.", { type: def.type, action: "create", subject: record && record.id });
}

// Automation changing an imported record: rotorFields must stay as the import left them.
export function checkUpdate({ def, before, after, contact, ctx }) {
  if (!guardActive(ctx) || !def || !before || !before.import) return;
  if (sandboxed(before, contact)) return;
  const fields = rotorFieldsChanged(def.rotorFields, before, after);
  if (fields.length) throw new ParallelRunGuard("Rotor is still in charge of this record.", { type: def.type, action: "update", subject: before.id, fields });
}

// Automation deleting an imported record is a change Rotor would not know about either.
export function checkDelete({ def, before, contact, ctx }) {
  if (!guardActive(ctx) || !def || !before || !before.import) return;
  if (sandboxed(before, contact)) return;
  throw new ParallelRunGuard("Rotor is still in charge of this record.", { type: def.type, action: "delete", subject: before.id });
}
