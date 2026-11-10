// Fixtures for the sales module's tests (design §12.5): synthetic people
// only (made-up names, 555 numbers, example.com emails), a pinned clock
// (America/Chicago; Tuesday 2026-11-17 unless a test pins another time).

import { crmTest } from "../../helpers/crm-http.mjs";
import { pin } from "../../helpers/crm-clock.mjs";

export const store = await import("../../../netlify/lib/crm-store.mjs");
await import("../../../netlify/lib/crm/modules/index.mjs");
export const ids = await import("../../../netlify/lib/crm/core/ids.mjs");
export const clock = await import("../../../netlify/lib/crm/core/clock.mjs");
export const C = await import("../../../netlify/lib/crm/modules/sales/cadence.mjs");
export const SEED = await import("../../../netlify/lib/crm/modules/sales/seed.mjs");
export const E = await import("../../../netlify/lib/crm/modules/sales/enroll.mjs");
export const D = await import("../../../netlify/lib/crm/modules/sales/deals.mjs");
export const CALLS = await import("../../../netlify/lib/crm/modules/sales/calls.mjs");
export const AUTO = await import("../../../netlify/lib/crm/modules/sales/automations.mjs");
export const T = await import("../../../netlify/lib/crm/core/templates.mjs");
export const intake = await import("../../../netlify/lib/crm/modules/contacts/intake.mjs");
export const hook = await import("../../../netlify/lib/crm/modules/contacts/hook.mjs");
export { pin };

// Write contexts: a person (the office), automation, the import.
export const AS = (user) => ({ by: user.id, origin: "api", actor_kind: "user", requestId: "test" });
export const AUTOMATION = { by: "system:test", origin: "worker", actor_kind: "automation", requestId: "test", mode: { system_of_record: "rotor", paused: false } };
export const IMPORT = { by: "import", origin: "import", actor_kind: "import", requestId: "test" };

// Tuesday 2026-11-17 08:55 in Delano (14:55 UTC).
export const TUE_0855 = "2026-11-17T14:55:00Z";

// A harness with an owner, an admin and a tech, the seeds written (cadences
// and templates) and fast lease polls.
export async function setup(now = TUE_0855) {
  const t = await crmTest({ now });
  globalThis.__crmSleepScale = 0.01;
  hook.clearModeCache();
  const owner = await t.user("owner", { extra: { first_name: "Alex" } });
  const admin = await t.user("admin");
  const tech = await t.user("tech");
  await SEED.seedCadences({ write: () => AUTOMATION });
  await T.seedTemplates(AUTOMATION);
  T.clearTemplateSeedCache();
  const done = t.done.bind(t);
  t.done = () => {
    if (process.env.SALES_LOGS) { const bad = t.logs().filter((l) => /^error:|^warn:/.test(l)); if (bad.length) (globalThis.__salesLogs ||= []).push(...bad); }
    delete globalThis.__crmSleepScale; hook.clearModeCache(); done();
    if (process.env.SALES_LOGS && globalThis.__salesLogs) { import("node:fs").then((fs) => fs.appendFileSync(process.env.SALES_LOGS, globalThis.__salesLogs.splice(0).join("\n") + "\n")); }
  };
  return { t, owner, admin, tech };
}

let n = 0;
// A lead the office typed in (a person's create: a shadow contact while Rotor is in charge).
export async function makeLead(as, fields = {}) {
  n += 1;
  const r = await store.createRecord("contact", {
    first_name: "Pat", last_name: `Sample${n}`, phones: [{ e164: `+1763555${String(200 + (n % 700)).padStart(4, "0")}`, sms: true }],
    emails: [{ address: `pat.sample${n}@example.com` }], lifecycle: "lead", source: { source: "Website quote form" },
    consent: { sms_service: { state: "granted", source: "website_form" } },
    billing_address: { street1: `${100 + n} Example Ave`, city: "Delano", state: "MN", zip: "55328" }, ...fields,
  }, AS(as));
  return r.data;
}

// A contact the Rotor import brought in (not sandboxed before cutover).
export async function importedContact(fields = {}) {
  n += 1;
  const r = await store.createRecord("contact", {
    first_name: "Robin", last_name: `Imported${n}`, phones: [{ e164: `+1763555${String(1200 + (n % 700)).padStart(4, "0")}` }], lifecycle: "lead",
    source: { source: "Meta Ads" }, import: { run_id: "ir_00000000000000000001", at: "2026-11-08T00:00:00.000Z", hash: "0".repeat(64) }, ...fields,
  }, IMPORT);
  return r.data;
}

export const enrollment = async (id) => (await store.getRecord("enrollment", id)).data;
export const deal = async (id) => (await store.getRecord("deal", id)).data;
export const outbox = (t) => t.stores.data.keys("rec/outbox/").map((k) => t.stores.data.json(k));
export const alog = (t) => t.stores.data.keys("alog/");

// Local wall time of an ISO instant: "Tue 09:00".
export function local(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][clock.localDow(d)];
  return `${day} ${clock.localDate(d).slice(5)} ${clock.localTime(d)}`;
}

// Drains the fast lane (queue items, sweeps) a few passes.
export async function drain(t, passes = 4) {
  for (let i = 0; i < passes; i++) await t.runWorker({ lane: "fast" });
}
