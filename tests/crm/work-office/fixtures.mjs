// Fixtures for the work module's office tests (design §12.5): synthetic
// people only (made-up names, 555 numbers, example.com emails), a pinned
// clock (America/Chicago; Tuesday 2026-11-17 09:00 unless a test pins
// another time).

import { crmTest } from "../../helpers/crm-http.mjs";
import { pin } from "../../helpers/crm-clock.mjs";

export const store = await import("../../../netlify/lib/crm-store.mjs");
await import("../../../netlify/lib/crm/modules/index.mjs");
export const ids = await import("../../../netlify/lib/crm/core/ids.mjs");
export const clock = await import("../../../netlify/lib/crm/core/clock.mjs");
export const T = await import("../../../netlify/lib/crm/core/templates.mjs");
export const OFF = await import("../../../netlify/lib/crm/modules/work/office.mjs");
export const SCH = await import("../../../netlify/lib/crm/modules/work/office-schedule.mjs");
export const ST = await import("../../../netlify/lib/crm/modules/work/states.mjs");
export const TY = await import("../../../netlify/lib/crm/modules/work/types.mjs");
export const AU = await import("../../../netlify/lib/crm/modules/work/automations.mjs");
export const MD = await import("../../../netlify/lib/crm/modules/work/office-moveday.mjs");
export const IMP = await import("../../../netlify/lib/crm/modules/work/import-rotor.mjs");
export const services = await import("../../../netlify/lib/crm/core/services.mjs");
export const ops = await import("../../../netlify/lib/crm/core/ops.mjs");
const sweeps = await import("../../../netlify/lib/crm/core/sweeps.mjs");
export { pin };

export const AS = (user) => ({ by: user.id, origin: "api", actor_kind: "user", requestId: "test" });
export const AUTOMATION = { by: "system:test", origin: "worker", actor_kind: "automation", requestId: "test", mode: { system_of_record: "rotor", paused: false } };
export const IMPORT = { by: "import", origin: "import", actor_kind: "import", requestId: "test" };

// Tuesday 2026-11-17 09:00 in Delano (15:00 UTC).
export const TUE_0900 = "2026-11-17T15:00:00Z";

export async function setup(now = TUE_0900) {
  const t = await crmTest({ now });
  globalThis.__crmSleepScale = 0.01;
  sweeps.clearSweepCache();
  sweeps.clearSeedCache();
  const owner = await t.user("owner", { extra: { first_name: "Olive" } });
  const admin = await t.user("admin");
  const tech = await t.user("tech", { extra: { first_name: "Theo" } });
  const tech2 = await t.user("tech", { extra: { first_name: "Tess" } });
  await OFF.seedChecklists({ write: () => AUTOMATION });
  await T.seedTemplates(AUTOMATION);
  T.clearTemplateSeedCache();
  const done = t.done.bind(t);
  t.done = () => { delete globalThis.__crmSleepScale; done(); };
  return { t, owner, admin, tech, tech2 };
}

let n = 0;
// A customer the office typed in (a shadow contact while Rotor is in charge), with a property.
export async function customer(as, fields = {}, { town = "Delano", geo } = {}) {
  n += 1;
  const c = (await store.createRecord("contact", {
    first_name: "Pat", last_name: `Sample${n}`, phones: [{ e164: `+1763555${String(300 + (n % 600)).padStart(4, "0")}`, sms: true }],
    emails: [{ address: `pat.sample${n}@example.com` }], lifecycle: "customer", source: { source: "Website quote form" },
    consent: { sms_service: { state: "granted", source: "website_form" } },
    billing_address: { street1: `${100 + n} Example Ave`, city: town, state: "MN", zip: "55328" }, ...fields,
  }, as.id ? AS(as) : as)).data;
  const p = (await store.createRecord("property", {
    contact_id: c.id, label: "Home", address: { street1: `${100 + n} Example Ave`, city: town, state: "MN", zip: "55328", country: "US" }, access: { gate_code: "1234" }, assets: {}, photo_ids: [],
    ...(geo ? { geo: { lat: geo[0], lng: geo[1], source: "manual", at: "2026-11-01T00:00:00.000Z" } } : {}),
  }, as.id ? AS(as) : as)).data;
  await store.updateRecord("contact", c.id, (x) => ({ ...x, primary_property_id: p.id }), as.id ? AS(as) : as);
  return { ...c, primary_property_id: p.id, property: p };
}

// A customer the Rotor import brought in (not sandboxed before cutover).
export async function importedCustomer(fields = {}) {
  n += 1;
  const c = (await store.createRecord("contact", {
    first_name: "Robin", last_name: `Imported${n}`, phones: [{ e164: `+1763555${String(1300 + (n % 600)).padStart(4, "0")}`, sms: true }], lifecycle: "customer",
    consent: { sms_service: { state: "granted", source: "import" } },
    source: { source: "Returning Customer" }, billing_address: { street1: `${200 + n} Example Ave`, city: "Mound", state: "MN", zip: "55364" },
    import: { run_id: "ir_00000000000000000001", at: "2026-11-08T00:00:00.000Z", hash: "0".repeat(64) }, ...fields,
  }, IMPORT)).data;
  return c;
}

export const LINES = [{ title: "Exterior window cleaning", qty_milli: 1000, unit_cents: 29500, service_type: "Residential Window Cleaning" }];

// A job made by the office (work.createJobs, scope "manual").
export async function job(as, contact, spec = {}, opId = `test-op-${++n}`) {
  const [id] = await OFF.createJobs([{ contact_id: contact.id, kind: "standard", lines: LINES, ...spec }], opId, "manual", as.id ? AS(as) : as);
  return (await store.getRecord("job", id)).data;
}

export async function visit(as, jobRec, slot = {}) {
  const r = await OFF.createVisit({ job_id: jobRec.id, date: "2026-11-19", start: "08:00", end: "10:00", window: { type: "window", minutes: 120 }, assignee_ids: [], ...slot }, as.id ? AS(as) : as);
  return r.visit;
}

export const outbox = (t) => t.stores.data.keys("rec/outbox/").map((k) => t.stores.data.json(k));
export const notes = (t) => t.stores.data.keys("rec/notification/").map((k) => t.stores.data.json(k));
export const queued = (t, kind) => t.stores.data.keys("q/").map((k) => t.stores.data.json(k)).filter((x) => !kind || x.kind === kind);

// Runs the fast lane until the queue holds nothing due (a few passes).
export async function drain(t, passes = 4) {
  for (let i = 0; i < passes; i++) await t.runWorker({ lane: "fast" });
}
