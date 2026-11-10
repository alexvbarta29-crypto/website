// Fixtures for the contacts module's tests (design §12.5): synthetic people
// only (made-up names, 555 numbers, example.com emails).

import { createCrmStores, useCrmStores, clearCrmStores } from "../../helpers/crm-memory-store.mjs";
import { pin, unpin } from "../../helpers/crm-clock.mjs";

export const store = await import("../../../netlify/lib/crm-store.mjs");
await import("../../../netlify/lib/crm/modules/index.mjs");
export const intake = await import("../../../netlify/lib/crm/modules/contacts/intake.mjs");
export const match = await import("../../../netlify/lib/crm/modules/contacts/match.mjs");
export const merge = await import("../../../netlify/lib/crm/modules/contacts/merge.mjs");
export const hook = await import("../../../netlify/lib/crm/modules/contacts/hook.mjs");
export const ids = await import("../../../netlify/lib/crm/core/ids.mjs");

// A person write (an office user), and the worker's.
export const PERSON = { by: "us_0000000000000000000a", origin: "api", actor_kind: "user", requestId: "test" };
export const IMPORT = { by: "import", origin: "import", actor_kind: "import", requestId: "test" };

// Fresh memory stores, a pinned clock and fast lease polls. → { S, done }
export function fresh(at = "2026-11-17T15:00:00Z") {
  const S = useCrmStores(createCrmStores());
  pin(at);
  globalThis.__crmSleepScale = 0.01;
  hook.clearModeCache();
  return {
    S,
    done() { clearCrmStores(); unpin(); delete globalThis.__crmSleepScale; hook.clearModeCache(); },
  };
}

export const lead = (n = 42, extra = {}) => ({
  first_name: "Pat", last_name: "Example", phone: `(763) 555-01${String(n).padStart(2, "0")}`, email: `pat.example${n}@example.com`,
  address: { street1: `${100 + n} Example Ave`, city: "Delano", state: "MN", zip: "55328" },
  services: ["Exterior Window Cleaning"], notes: `Customer notes:\nPlease call after 5.\n\nServices: Exterior Window Cleaning`,
  source: "Website quote form", consent: { sms_service: true }, ...extra,
});

export const contactKeys = (S) => S.data.keys("rec/contact/");
export async function contact(id) { const g = await store.getRecord("contact", id); return g && g.data; }

// A contact created the way the office would (a person's write).
export async function makeContact(fields = {}, ctx = PERSON) {
  const r = await store.createRecord("contact", {
    first_name: "Sam", last_name: "Sample", phones: [{ e164: "+17635550150" }], emails: [{ address: "sam.sample@example.com" }],
    lifecycle: "lead", source: { source: "Phone Call" }, ...fields,
  }, ctx);
  return r.data;
}

// What the import runner does with an import phase's output: since M2c this
// is the real runner's applyOutput() (netlify/lib/crm/modules/import/
// runner.mjs): records written with field ownership (a new record gets its
// `import` block and base; one the import made before takes Rotor's new
// values unless someone edited them; a CRM-created record the resolution
// linked fills only its empty fields), then the pointers, then the extras
// (contacts' applyExtras). The write context is the import's, without bulk
// (these tests read the index rows). With `phase` and `row`, the records get
// the runner's source for that row ("<entity>:<row id>", whose entity gives
// the rank), else one source for everything. → the extras' counts.
const { applyOutput } = await import("../../../netlify/lib/crm/modules/import/runner.mjs");
export async function applyImport(out, { run_id = "ir_00000000000000000001", extras, phase = null, row = null } = {}) {
  const ph = { records: {}, skipped: {}, warnings: {}, pointers: { claimed: 0, listed: 0, taken: 0 }, extras: { patched: 0, stats: 0, suppressed: 0, candidates: 0 }, kept_fields: 0, errors: [] };
  const o = extras ? out : { records: out.records, pointers: out.pointers, warnings: out.warnings };
  const rid = row && (row.id || row.user_id);
  const source = phase && rid ? `${phase.entity}:${rid}` : null;
  await applyOutput(o, { runId: run_id, ph, ctx: IMPORT, source, entity: phase ? phase.entity : null, state: { types: [] } });
  return ph.extras;
}
