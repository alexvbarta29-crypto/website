// Fixtures for the comms tests (design §12.5, §12.6): synthetic people only
// (555 numbers, example.com addresses), the API harness with fresh memory
// stores and a pinned clock, a production-like deploy whose Twilio and
// Postmark secrets are made up, and a fetch that answers only the routes a
// test declares (anything else fails the test: nothing reaches the network).

import { createHmac } from "node:crypto";
import { crmTest, HOST } from "../../helpers/crm-http.mjs";
import { seedContact } from "../../helpers/crm-fixtures.mjs";

export const store = await import("../../../netlify/lib/crm-store.mjs");
export const CV = await import("../../../netlify/lib/crm/modules/comms/conversations.mjs");
export const TW = await import("../../../netlify/lib/crm/adapters/sms-twilio.mjs");
export { seedContact, HOST };

export const SID = "AC" + "0123456789abcdef".repeat(2);      // a made-up account id, built here so no id-shaped text sits in the repo
export const TOKEN = "test-auth-token-not-real";
export const TEST_FROM = "+17635550111";
export const STAFF = "+17635550150";
export const PROD_ENV = { CONTEXT: "production", CRM_PRODUCTION: "1", CRM_KEY_SALT: "test-salt-not-real", TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: TOKEN, POSTMARK_SERVER_TOKEN: "pm-test-token", POSTMARK_WEBHOOK_TOKEN: "pm-hook-token" };
export const W = (by = "system") => ({ by, origin: "api", actor_kind: "user", requestId: "test" });
export const scope = (fn) => store.withStoreScope({ requestId: "test" }, fn);

// Replaces fetch with declared routes: [{ match: RegExp | string, respond(url, init) }].
export function mockFetch(routes = []) {
  const saved = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push({ url, method: (init.method || "GET").toUpperCase(), headers: init.headers || {}, body: typeof init.body === "string" ? init.body : null });
    const r = routes.find((x) => (x.match instanceof RegExp ? x.match.test(url) : url.includes(x.match)));
    if (!r) throw new TypeError(`mockFetch: undeclared request to ${new URL(url).host}`);
    return r.respond(url, init);
  };
  return { calls, restore() { globalThis.fetch = saved; } };
}

// The production deploy with Twilio and Postmark "connected" in test mode:
// the team's phone and address on the allowlists, a separate test number.
export async function connected({ now = "2026-11-17T15:00:00Z", sms = {}, email = {}, env = {} } = {}) {
  const t = await crmTest({ now, env: { ...PROD_ENV, ...env } });
  const owner = await t.user("owner");
  await t.bootstrap(owner);
  const cur = await store.getSettingWithEtag("integrations");
  await store.putSetting("integrations", {
    ...cur.data,
    sms: { ...cur.data.sms, mode: "test", test_from: TEST_FROM, test_allowlist: [STAFF], ...sms },
    email: { ...cur.data.email, mode: "test", test_allowlist: ["staff@example.com"], ...email },
  }, { ...W(owner.id), ifMatch: cur.etag || "new" });
  return { t, owner };
}

// A staff test contact (flags.test: sandboxed, so automation may write on it before cutover).
export const staffContact = (n = 50, o = {}) => scope(async () => {
  const c = await seedContact(n, { phones: [{ e164: STAFF, label: "mobile", primary: true, sms: true }], emails: [{ address: "staff@example.com", label: "work", primary: true }], flags: { test: true }, ...o });
  // (seedContact writes the record alone: the phone lookup an inbound text needs is added here)
  for (const ph of c.phones || []) await store.updatePointerList("phone", store.hk("phone", ph.e164), (ids) => [...ids, c.id]);
  return c;
});

// A signed Twilio webhook request body and headers.
export function twilioForm(params, url = TW.SMS_HOOK, token = TOKEN) {
  const body = new URLSearchParams(params).toString();
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return { raw: body, headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": createHmac("sha1", token).update(Buffer.from(data, "utf8")).digest("base64") } };
}
let sidN = 0;
export const smsSid = () => "SM" + String(++sidN).padStart(32, "0");
export const inbound = (t, params, o = {}) => {
  const p = { AccountSid: SID, MessageSid: smsSid(), From: STAFF, To: TEST_FROM, Body: "Hello", NumMedia: "0", ...params };
  const f = twilioForm(p, o.url, o.token);
  return t.api("/hooks/twilio/sms", { method: "POST", raw: f.raw, headers: { ...f.headers, ...(o.headers || {}) }, csrf: false, client: false }).then((res) => ({ ...res, params: p }));
};
export const statusCb = (t, params, { m = "abc123", token } = {}) => {
  const url = `${TW.STATUS_HOOK}?m=${m}`;
  const f = twilioForm({ AccountSid: SID, ...params }, url, token);
  return t.api(`/hooks/twilio/status?m=${m}`, { method: "POST", raw: f.raw, headers: f.headers, csrf: false, client: false });
};
// Runs the fast lane until its queue is empty (bounded).
export async function drain(t, n = 6) { for (let i = 0; i < n && t.stores.data.keys("q/").length; i++) await t.runWorker({ lane: "fast" }); }
export const writes = (calls, re) => calls.filter((c) => ["set", "setJSON", "delete"].includes(c.op) && re.test(c.key || ""));
