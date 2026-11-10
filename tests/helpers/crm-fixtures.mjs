// Test helper: fixtures and fakes every CRM test shares (design §11.4
// "Uses", §11.5, §12.5). Synthetic data only: made-up names, 555 numbers,
// example.com emails.
//
//   const restore = fakeServices({ "work.createJobs": async (jobs) => [...] });   // fakes for services not merged yet
//   const S = stores();                       // fresh memory stores in use (crm-store's override)
//   const deploy = devDeploy();               // a branded deploy for a local run (stores crm--dev)
//   const m = fixtureModule({ types: [...], events: {...}, queue: {...} });   // a module with a unique name
//   const T = fixtureType("widget", "zw", { indexes, rels });                 // a defineType fixture
//   make("user", { name: "Pat Example" });    // a type's example() with overrides
//   const sleep = virtualSleep();             // for runLane: advances the pinned clock instead of waiting
//   const kicks = recordKicks();              // lane kicks recorded instead of sent; kicks.list, kicks.restore()
//   person(3) → { first_name, last_name, phone: "+17635550103", email: "pat.example3@example.com" }

import { createCrmStores, useCrmStores, clearCrmStores } from "./crm-memory-store.mjs";
import { advance } from "./crm-clock.mjs";

const registry = await import("../../netlify/lib/crm/core/registry.mjs");
const services = await import("../../netlify/lib/crm/core/services.mjs");
const lanes = await import("../../netlify/lib/crm/core/lanes.mjs");
const { deployContext } = await import("../../netlify/lib/crm/core/context.mjs");

export const HOST = "https://www.bartawindowwashing.com";

// Fakes for services whose provider has not merged yet (or to steer a
// test). → restore().
export function fakeServices(map) {
  const undo = Object.entries(map).map(([name, fn]) => services.__swapServiceForTests(name, fn));
  return () => { for (const u of undo.reverse()) u(); };
}

export function stores(opts) {
  return useCrmStores(createCrmStores(opts));
}
export { clearCrmStores };

// A deploy object for a local run (context "dev": stores crm--dev, no side effects).
export const devDeploy = (env = {}) => deployContext(new Request(HOST + "/"), {}, env);

let seq = 0;
// A module with a unique name (the registry lives for the whole test file).
export function fixtureModule(manifest = {}) {
  seq += 1;
  return registry.registerModule({ name: `fixture-${seq}`, ...manifest });
}

// A record type for tests: two-letter prefix (use z?), envelope only, any
// fields kept; rotorFields/techFields/example filled in.
export function fixtureType(type, prefix, extra = {}) {
  return registry.defineType({
    type, prefix, v: 1,
    validate: (d) => d,
    rotorFields: ["rotor"], techFields: ["id"],
    example: () => ({ name: "Sample Item", status: "open" }),
    shadow: false,
    ...extra,
  });
}

export function make(type, overrides = {}) {
  const def = registry.requireType(type);
  return { ...def.example(), ...overrides };
}

// For runLane({ sleep }): moves the pinned clock forward and reports the
// time as slept, so a sleeping worker takes no real time.
export function virtualSleep(log = []) {
  const fn = async (ms) => { log.push(ms); advance(ms); return ms; };
  fn.log = log;
  return fn;
}

// Lane kicks recorded instead of sent.
export function recordKicks() {
  const list = [];
  lanes.setKicker((lane, reason) => { list.push({ lane, reason }); });
  return { list, restore: () => lanes.setKicker(null) };
}

const FIRST = ["Pat", "Sam", "Alex", "Jordan", "Casey", "Riley", "Morgan", "Taylor"];
const LAST = ["Example", "Sample", "Testcase", "Placeholder"];
// A synthetic person (555 numbers, example.com addresses).
export function person(n = 1) {
  const first = FIRST[n % FIRST.length];
  const last = LAST[n % LAST.length];
  return { first_name: first, last_name: last, phone: `+1763555${String(100 + (n % 100)).padStart(4, "0")}`, email: `${first.toLowerCase()}.${last.toLowerCase()}${n}@example.com` };
}

// Synthetic bytes of each file type (magic bytes + padding).
export const BYTES = Object.freeze({
  jpeg: () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, ...new Array(64).fill(7)]),
  png: () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(64).fill(3)]),
  webp: () => new Uint8Array([...Buffer.from("RIFF"), 0x40, 0, 0, 0, ...Buffer.from("WEBPVP8 "), ...new Array(48).fill(1)]),
  pdf: () => new Uint8Array([...Buffer.from("%PDF-1.7\n"), ...new Array(64).fill(32)]),
  html: () => new Uint8Array(Buffer.from("<!doctype html><html><script>alert(1)</script></html>")),
  svg: () => new Uint8Array(Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')),
  unknown: () => new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
});

// ------------------------------------------------------------ contacts before M2a
// The contact type ships with M2a; until then tests write synthetic contact
// records straight into rec/contact/{id} (onlyIfNew), shaped like §5.1.
//   const c = await seedContact(3, { consent: { sms_marketing: { state: "granted" } } });
//   await seedStats(c.id, { comms: { first_sms: { "+17633143400": "2026-01-01T00:00:00Z" } } });
const store = await import("../../netlify/lib/crm-store.mjs");
const ids = await import("../../netlify/lib/crm/core/ids.mjs");
const clock = await import("../../netlify/lib/crm/core/clock.mjs");

export async function seedContact(n = 1, overrides = {}) {
  const p = person(n);
  const id = overrides.id || ids.newId("contact");
  const at = clock.nowIso();
  const consent = { sms_service: { state: "granted", source: "website_form" }, sms_marketing: { state: "unknown" }, email_marketing: { state: "unknown" }, ...(overrides.consent || {}) };
  const rec = {
    id, type: "contact", v: 1, wv: 1, kind: "person", first_name: p.first_name, last_name: p.last_name, company_name: "",
    display_name: `${p.first_name} ${p.last_name}`, phones: [{ e164: p.phone, label: "mobile", primary: true, sms: true }],
    emails: [{ address: p.email, label: "personal", primary: true }], lifecycle: "customer", tags: [], notes: "", watcher_ids: [],
    billing_address: { street1: `${100 + (n % 100)} Example Ave`, city: "Delano", state: "MN", zip: "55328", country: "US" },
    flags: {}, shadow: true, created_at: at, created_by: "system", updated_at: at, updated_by: "system",
    ...overrides, consent,
  };
  await store.settledWrite(`rec/contact/${id}`, rec, { onlyIfNew: true });
  return rec;
}

// An imported contact (Rotor's): not sandboxed, so automation only reports on it before cutover.
export const seedImportedContact = (n, overrides = {}) => seedContact(n, { shadow: undefined, created_by: "import", import: { run_id: "ir_00000000000000000001", at: "2026-11-08T00:00:00.000Z", hash: "0".repeat(64) }, ...overrides });

export async function seedStats(contactId, parts = {}) {
  const rec = { id: contactId, type: "contact_stats", v: 1, wv: 1, created_at: clock.nowIso(), ...parts };
  await store.settledWrite(`rec/contact_stats/${contactId}`, rec, { onlyIfNew: true });
  return rec;
}
