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

// What the M2c runner does with an import phase's output, enough for these
// tests (§10.7, simplified): a new record is created with its `import`
// block; one the import made before takes the newly mapped rotorFields (the
// "untouched" case); a CRM-created record the resolution linked (no
// `import` yet: an intake contact) fills only its empty fields and gains
// `import`. Then the pointers, then the extras.
const { getType } = await import("../../../netlify/lib/crm/core/registry.mjs");
const { createHash } = await import("node:crypto");
const getPath = (o, p) => p.split(".").reduce((x, k) => (x == null ? undefined : x[k]), o);
const setPath = (o, p, v) => { const ks = p.split("."); let x = o; for (const k of ks.slice(0, -1)) { if (!x[k] || typeof x[k] !== "object") x[k] = {}; x = x[k]; } x[ks[ks.length - 1]] = v; };
const blank = (v) => v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length) || (v && typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length);
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
export async function applyImport(out, { run_id = "imp_test", extras } = {}) {
  for (const r of out.records || []) {
    const fields = (getType(r.type) && getType(r.type).rotorFields) || [];
    const mapped = Object.fromEntries(fields.map((f) => [f, getPath(r.data, f)]).filter(([, v]) => v !== undefined));
    const imp = { run_id, at: new Date(0).toISOString(), hash: createHash("sha256").update(JSON.stringify(canon(mapped))).digest("hex") };
    try {
      await store.createRecord(r.type, { ...r.data, import: imp }, IMPORT);
    } catch (e) {
      if (e.name !== "ExistsError") throw e;
      await store.updateRecord(r.type, r.data.id, (cur) => {
        const next = JSON.parse(JSON.stringify(cur));
        for (const [f, v] of Object.entries(mapped)) if (cur.import || blank(getPath(cur, f))) setPath(next, f, v);
        next.import = imp;
        return next;
      }, IMPORT);
    }
  }
  for (const p of out.pointers || []) {
    if (p.list) await store.updatePointerList(p.kind, p.key, (l) => [...l, p.value.id]);
    else await store.claimPointer(p.kind, p.key, p.value);
  }
  return extras ? extras(out, IMPORT) : null;
}
