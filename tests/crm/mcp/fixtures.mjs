// Fixtures for the mcp module's tests (design §12.5): synthetic people only
// (made-up names, 555 numbers, example.com emails), a pinned clock
// (America/Chicago; Tuesday 2026-11-17 09:00 unless a test pins another).

import { crmTest } from "../../helpers/crm-http.mjs";

export const store = await import("../../../netlify/lib/crm-store.mjs");
await import("../../../netlify/lib/crm/modules/index.mjs");
export const R = await import("../../../netlify/lib/crm/core/registry.mjs");
export const T = await import("../../../netlify/lib/crm/core/templates.mjs");
export const S = await import("../../../netlify/lib/crm/modules/mcp/server.mjs");
export const A = await import("../../../netlify/lib/crm/modules/mcp/actions.mjs");
export const CAL = await import("../../../netlify/lib/crm/modules/mcp/calendar.mjs");
const sweeps = await import("../../../netlify/lib/crm/core/sweeps.mjs");

export const AS = (user) => ({ by: user.id, origin: "api", actor_kind: "user", requestId: "test" });
export const SYSTEM = { by: "system:test", origin: "worker", actor_kind: "automation", requestId: "test", mode: { system_of_record: "rotor", paused: false } };
export const TUE_0900 = "2026-11-17T15:00:00Z";

export async function setup(now = TUE_0900) {
  const t = await crmTest({ now });
  globalThis.__crmSleepScale = 0.01;
  sweeps.clearSweepCache();
  sweeps.clearSeedCache();
  const owner = await t.user("owner", { extra: { first_name: "Olive" } });
  const owner2 = await t.user("owner", { extra: { first_name: "Otto" } });
  const admin = await t.user("admin", { extra: { first_name: "Ada" } });
  const tech = await t.user("tech", { extra: { first_name: "Theo" } });
  const tech2 = await t.user("tech", { extra: { first_name: "Tess" } });
  await T.seedTemplates(SYSTEM);
  T.clearTemplateSeedCache();
  const done = t.done.bind(t);
  t.done = () => { delete globalThis.__crmSleepScale; done(); };
  return { t, owner, owner2, admin, tech, tech2 };
}

// A key made through the API, as a person makes one in the CRM. → { key, id, scopes, kind }
export async function makeKey(t, who, body = {}) {
  const r = await t.api("/api-keys", { method: "POST", as: who, body: { name: "Claude", ...body } });
  if (r.status !== 201) throw new Error(`key not made: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data;
}

let rid = 0;
// One JSON-RPC message (or a batch) to POST /api/crm/mcp[/key]. → { status, body, headers }
export function rpc(t, { key, pathKey, msg, method, params, headers = {} } = {}) {
  rid += 1;
  const m = msg !== undefined ? msg : { jsonrpc: "2.0", id: rid, method, ...(params ? { params } : {}) };
  const h = { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers };
  if (key) h.authorization = `Bearer ${key}`;
  return t.api(pathKey ? `/mcp/${pathKey}` : "/mcp", { method: "POST", body: m, headers: h, csrf: false, client: false });
}
// tools/call → the parsed text result: { result, isError, raw }
export async function call(t, key, name, args = {}, more = {}) {
  const r = await rpc(t, { key, method: "tools/call", params: { name, arguments: args }, ...more });
  if (r.status !== 200 || !r.body || !r.body.result) return { status: r.status, body: r.body };
  const res = r.body.result;
  let parsed = null;
  try { parsed = JSON.parse(res.content[0].text); } catch { parsed = res.content[0].text; }
  return { status: r.status, result: parsed, isError: !!res.isError };
}
export const toolNames = async (t, opts) => ((await rpc(t, { ...opts, method: "tools/list" })).body.result.tools || []).map((x) => x.name);

let n = 0;
export async function customer(as, fields = {}, { town = "Delano" } = {}) {
  n += 1;
  return (await store.createRecord("contact", {
    first_name: "Pat", last_name: `Sample${n}`, phones: [{ e164: `+1763555${String(200 + n).padStart(4, "0")}`, sms: true, primary: true }],
    emails: [{ address: `pat.sample${n}@example.com`, primary: true }], lifecycle: "customer", source: { source: "Website quote form" },
    consent: { sms_service: { state: "granted", source: "website_form" } }, notes: "Gate code 4321. Dog in the yard.",
    billing_address: { street1: `${100 + n} Example Ave`, city: town, state: "MN", zip: "55328" }, ...fields,
  }, AS(as))).data;
}

// A visit straight into the store (the work module's type): its index row is what the feed reads.
export async function visit(as, contact, { date, start = "08:00", end = "10:00", assignee_ids = [], status = "scheduled", town = "Delano", date_only, services = ["Residential Window Cleaning"] } = {}) {
  const def = R.getType("visit");
  return (await store.createRecord("visit", {
    ...def.example(), job_id: "jb_0000000000000000000a", contact_id: contact.id, property_id: null, date, start, end, assignee_ids, status,
    contact_name: `${contact.first_name} ${contact.last_name}`, town, address_line: "100 Example Ave", service_types: services, tech_notes: "Gate code 4321",
    ...(date_only ? { date_only: true } : {}),
  }, AS(as))).data;
}

export async function drain(t, n = 6) {
  for (let i = 0; i < n && t.stores.data.keys("q/").length; i++) await t.runWorker({ lane: "fast" });
}
