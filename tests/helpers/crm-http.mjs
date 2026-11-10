// Test helper: the CRM API harness every module uses (design §12.3).
//
//   const t = await crmTest({ now: "2026-11-17T15:00:00Z" });   // fresh stores, pinned clock, strict fetch, low PBKDF2 cost
//   const alex = await t.user("owner", { login: "owner1" });     // an active user + session cookie, straight in the store
//   const res = await t.api("/users", { method: "POST", as: alex, body: {...} });   // → { status, body, headers }
//   await t.auth("/auth/login", { body: {...} });                // the sign-in function (crm-auth.mjs)
//   await t.page("/crm", { as: alex });                          // crm.mjs → { status, text, headers }
//   await t.office("/office", { as: alex });                     // office.mjs
//   t.device();                                                // a signed barta_dev cookie (a phone the server knows)
//   t.fetchCalls(); t.logs(); t.done();
//
// Requests go to https://www.bartawindowwashing.com unless `host` says
// otherwise, with X-CRM: 1, JSON and the app's version header added. The
// office cookie (`office: true`) is the real one for OFFICE_PASSWORD.

import { mock } from "node:test";
import { createCrmStores, useCrmStores, clearCrmStores } from "./crm-memory-store.mjs";
import { strictFetch } from "./crm-fetch.mjs";
import { pin, unpin } from "./crm-clock.mjs";

export const HOST = "https://www.bartawindowwashing.com";
export const OFFICE_PASSWORD = "test-password";
export const PASSWORD = "correct horse battery";
process.env.OFFICE_PASSWORD = process.env.OFFICE_PASSWORD || OFFICE_PASSWORD;

const lights = await import("../../netlify/lib/lights-auth.mjs");
const store = await import("../../netlify/lib/crm-store.mjs");
const sessions = await import("../../netlify/lib/crm/core/sessions.mjs");
const auth = await import("../../netlify/lib/crm/core/auth.mjs");
const passwords = await import("../../netlify/lib/crm/core/passwords.mjs");
const { APP_VERSION } = await import("../../crm-app/version.js");
const crmApi = (await import("../../netlify/functions/crm-api.mjs")).default;
const crmAuth = (await import("../../netlify/functions/crm-auth.mjs")).default;
const crmPage = (await import("../../netlify/functions/crm.mjs")).default;
const officeFn = (await import("../../netlify/functions/office.mjs")).default;

let officeCookieValue = null;
export const officeCookie = () => (officeCookieValue ||= "barta_office=" + lights.derive(process.env.OFFICE_PASSWORD));

let seq = 0;
const NAMES = { owner: ["Olive", "Owner"], admin: ["Ada", "Admin"], tech: ["Theo", "Tech"] };

export async function crmTest({ now = "2026-11-17T15:00:00Z", env = {}, quiet = true } = {}) {
  const stores = useCrmStores(createCrmStores());
  pin(now);
  globalThis.__crmPbkdf2Iterations = 1000;
  sessions.clearSessionCache();
  auth.clearPermissionsCache();
  const savedEnv = {};
  for (const [k, v] of Object.entries(env)) { savedEnv[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const net = strictFetch([]);
  const logs = [];
  const spies = quiet ? ["error", "log", "warn"].map((m) => mock.method(console, m, (...a) => logs.push(`${m}: ${a.map(String).join(" ")}`))) : [];

  const cookieOf = (opts = {}) => {
    const parts = [];
    if (opts.as && opts.as.cookie) parts.push(opts.as.cookie);
    if (opts.office) parts.push(officeCookie());
    if (opts.cookie) parts.push(opts.cookie);
    return parts.join("; ");
  };
  const request = (path, opts = {}) => {
    const method = (opts.method || "GET").toUpperCase();
    const headers = new Headers(opts.headers || {});
    const c = cookieOf(opts);
    if (c) headers.set("cookie", c);
    if (opts.raw === undefined && method !== "GET" && method !== "HEAD" && method !== "DELETE" && !headers.has("content-type")) headers.set("content-type", "application/json");
    if (opts.csrf !== false && !headers.has("x-crm")) headers.set("x-crm", "1");
    if (opts.client !== false && !headers.has("x-crm-client")) headers.set("x-crm-client", APP_VERSION);
    if (opts.ifMatch) headers.set("if-match", opts.ifMatch);
    if (opts.idem) headers.set("idempotency-key", opts.idem);
    const body = opts.raw !== undefined ? opts.raw : opts.body !== undefined && method !== "GET" && method !== "HEAD" ? JSON.stringify(opts.body) : undefined;
    return new Request((opts.host || HOST) + path, { method, headers, body });
  };
  const asJson = async (res) => {
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: res.status, body, headers: res.headers, text };
  };
  const asText = async (res) => ({ status: res.status, text: await res.text(), headers: res.headers });

  const t = {
    stores,
    logs: () => logs,
    fetchCalls: () => net.calls,
    officeCookie,
    request,
    async user(role = "owner", o = {}) {
      seq += 1;
      const [first, last] = NAMES[role] || ["Pat", "Person"];
      const login = o.login || `${role}${seq}`;
      const password = o.password || PASSWORD;
      const status = o.status || "active";
      const data = {
        login, name: o.name || `${first} ${last}${seq}`, role, status, is_technician: o.is_technician ?? role === "tech",
        password: status === "invited" ? null : await passwords.hashPassword(password), session_epoch: 0,
        grants: o.grants || [], denies: o.denies || [], ...(o.extra || {}),
      };
      const rec = await store.createRecord("user", data, { by: "system", origin: "api", actor_kind: "user", requestId: "test" });
      let cookie = null;
      if (status === "active" && o.session !== false) {
        const ses = await sessions.createSession(rec.data, new Request(HOST + "/crm", { headers: { "user-agent": o.ua || "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1" } }), {});
        cookie = ses.cookie.split(";")[0];
      }
      return { id: rec.data.id, login, password, user: rec.data, etag: rec.etag, cookie };
    },
    async bootstrap(owner) {
      await store.settledWrite(auth.BOOTSTRAP_KEY, { state: "done", user_id: owner ? owner.id : "us_00000000000000000000", at: new Date().toISOString() }, { onlyIfNew: true });
    },
    api: async (path, opts = {}) => asJson(await crmApi(request("/api/crm" + path, opts), opts.context || {})),
    auth: async (path, opts = {}) => asJson(await crmAuth(request("/api/crm" + path, { method: "POST", ...opts }), opts.context || {})),
    page: async (path, opts = {}) => asText(await crmPage(request(path, { csrf: false, client: false, ...opts }), opts.context || {})),
    office: async (path, opts = {}) => asText(await officeFn(request(path, { csrf: false, client: false, ...opts }), opts.context || {})),
    // A device cookie the server issued (signed), as "barta_dev=...".
    device: () => "barta_dev=" + sessions.newDeviceCookie().value,
    // Cookies a response set, as "name=value" strings.
    setCookies: (res) => (res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get("set-cookie")].filter(Boolean)),
    cookieFrom(res, name) {
      const c = t.setCookies(res).find((x) => x.startsWith(name + "="));
      return c ? c.split(";")[0] : null;
    },
    done() {
      for (const s of spies) s.mock.restore();
      for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      net.restore();
      unpin();
      sessions.clearSessionCache();
      auth.clearPermissionsCache();
      delete globalThis.__crmPbkdf2Iterations;
      clearCrmStores();
    },
  };
  return t;
}
