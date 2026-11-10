// The API dispatcher's pipeline (design §2.2; acceptance tests of M1.2):
// envelopes, CSRF, the client version, idempotency, the body cap, the
// request budget and what a tech sees of a 412.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { crmTest } from "../../helpers/crm-http.mjs";

const { registerModule, defineType } = await import("../../../netlify/lib/crm/core/registry.mjs");
const { createRecord, updateRecord, getRaw, idemBegin } = await import("../../../netlify/lib/crm-store.mjs");
const { MIN_CLIENT, compareVersions } = await import("../../../netlify/lib/crm/core/http.mjs");
const { compileRoutes, matchRoute } = await import("../../../netlify/lib/crm/core/router.mjs");
const { InputError } = await import("../../../netlify/lib/crm/core/errors.mjs");

let runs = 0;
const thing = defineType({
  type: "zz_thing", prefix: "zz", v: 1,
  validate: (d) => ({ ...d, name: String(d.name || "") }),
  rotorFields: [], techFields: ["id", "type", "name"], shadow: false,
  example: () => ({ name: "Sample", notes: "secret" }),
});
registerModule({
  name: "zz-router-test",
  types: [thing],
  routes: [
    { method: "POST", path: "/zz/echo", auth: "session", perm: "account:own", subject: "none", mode: "inline", handler: async (ctx) => { runs += 1; return { status: 201, data: { got: ctx.body, n: runs } }; } },
    { method: "POST", path: "/zz/boom", auth: "session", perm: "account:own", subject: "none", mode: "inline", handler: async () => { runs += 1; throw new Error("kaput"); } },
    { method: "POST", path: "/zz/bad", auth: "session", perm: "account:own", subject: "none", mode: "inline", handler: async () => { runs += 1; throw new InputError("Nope.", "name"); } },
    { method: "POST", path: "/zz/replay", auth: "session", perm: "account:own", subject: "none", mode: "inline", replaySafe: true, handler: async () => ({ data: { ok: 1 } }) },
    { method: "GET", path: "/zz/calls", auth: "session", perm: "account:own", subject: "none", mode: "inline", maxCalls: 6, handler: async () => { for (let i = 0; i < 10; i++) await getRaw("zz/nothing-" + i); return { data: 1 }; } },
    { method: "GET", path: "/zz/hang", auth: "session", perm: "account:own", subject: "none", mode: "inline", budgetMs: 900, handler: async () => { await getRaw("zz/hang"); return { data: 1 }; } },
    { method: "GET", path: "/zz/items/new", auth: "session", perm: "account:own", subject: "none", mode: "inline", handler: async () => ({ data: "literal" }) },
    { method: "GET", path: "/zz/items/:id", auth: "session", perm: "account:own", subject: "required", mode: "inline", handler: async (ctx) => ({ data: ctx.params.id }) },
    { method: "PATCH", path: "/zz/items/:id", auth: "session", perm: "account:own", subject: "required", mode: "inline", handler: async (ctx) => {
      const r = await updateRecord("zz_thing", ctx.params.id, (rec) => ({ ...rec, ...ctx.body }), ctx.write({ ifMatch: ctx.ifMatch }));
      return { data: { id: r.data.id, name: r.data.name }, etag: r.etag };
    } },
  ],
});

let t;
afterEach(() => { if (t) t.done(); t = null; });

test("404 and 405 come in the envelope; literal paths beat parameters", async () => {
  t = await crmTest();
  const o = await t.user("owner");
  let r = await t.api("/nope", { as: o });
  assert.equal(r.status, 404);
  assert.deepEqual(r.body, { ok: false, error: { code: "not_found", message: "Not found." } });
  r = await t.api("/me", { method: "DELETE", as: o });
  assert.equal(r.status, 405);
  assert.equal(r.headers.get("allow"), "GET");
  assert.equal((await t.api("/zz/items/new", { as: o })).body.data, "literal");
  assert.equal((await t.api("/zz/items/abc", { as: o })).body.data, "abc");
  const m = matchRoute(compileRoutes([{ method: "GET", path: "/a/:x" }, { method: "GET", path: "/a/b" }]), "GET", "/a/b");
  assert.equal(m.route.path, "/a/b");
  r = await t.api("/me");
  assert.equal(r.status, 401);
  assert.equal(r.body.error.code, "signed_out");
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal(r.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal(r.headers.get("referrer-policy"), "same-origin");
});

test("CSRF: a cookie-authenticated write needs X-CRM, JSON and a same-origin (or absent) Origin", async () => {
  t = await crmTest();
  const o = await t.user("owner");
  assert.equal((await t.api("/zz/echo", { method: "POST", as: o, body: {}, csrf: false })).status, 403);
  assert.equal((await t.api("/zz/echo", { method: "POST", as: o, body: {}, headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal((await t.api("/zz/echo", { method: "POST", as: o, raw: "a=b", headers: { "content-type": "application/x-www-form-urlencoded" } })).status, 403);
  assert.equal((await t.api("/zz/echo", { method: "POST", as: o, body: {}, headers: { origin: "https://www.bartawindowwashing.com" } })).status, 201);
  assert.equal((await t.api("/zz/echo", { method: "POST", as: o, body: {} })).status, 201);
});

test("426 for an old client, except replaySafe routes, which take the previous version", async () => {
  t = await crmTest();
  const o = await t.user("owner");
  const r = await t.api("/zz/echo", { method: "POST", as: o, body: {}, headers: { "x-crm-client": "2020.01.01-1" } });
  assert.equal(r.status, 426);
  assert.equal(r.body.error.code, "client_outdated");
  assert.equal((await t.api("/zz/replay", { method: "POST", as: o, body: {}, headers: { "x-crm-client": MIN_CLIENT } })).status, 200);
  assert.equal((await t.api("/zz/replay", { method: "POST", as: o, body: {}, headers: { "x-crm-client": "2020.01.01-1" } })).status, 426);
  assert.equal(compareVersions("2026.11.10-10", "2026.11.10-9"), 1);
  assert.equal(compareVersions("2026.11.09-9", "2026.11.10-1"), -1);
});

test("Idempotency-Key: replay answers identically and runs once; pending → 409; another body → 422; a 5xx deletes the record", async () => {
  t = await crmTest();
  const o = await t.user("owner");
  runs = 0;
  const key = "11111111-2222-4333-8444-555555555555";
  const a = await t.api("/zz/echo", { method: "POST", as: o, idem: key, body: { x: 1 } });
  const b = await t.api("/zz/echo", { method: "POST", as: o, idem: key, body: { x: 1 } });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.deepEqual(b.body, a.body);
  assert.equal(b.headers.get("idempotent-replay"), "true");
  assert.equal(runs, 1, "the handler ran once");
  const c = await t.api("/zz/echo", { method: "POST", as: o, idem: key, body: { x: 2 } });
  assert.equal(c.status, 422);
  assert.equal(c.body.error.code, "idempotency_mismatch");
  // a request still running
  const k2 = "22222222-2222-4333-8444-555555555555";
  assert.deepEqual(await idemBegin(o.id, k2, "whatever"), { state: "new" });
  const p = await t.api("/zz/echo", { method: "POST", as: o, idem: k2, body: {} });
  assert.equal(p.status, 409);
  assert.equal(p.body.error.code, "in_progress");
  assert.equal(p.headers.get("retry-after"), "2");
  // a 500 leaves no record, so the retry runs again
  const k3 = "33333333-2222-4333-8444-555555555555";
  runs = 0;
  assert.equal((await t.api("/zz/boom", { method: "POST", as: o, idem: k3, body: {} })).status, 500);
  assert.equal(await getRaw(`idem/${o.id}/${k3}`), null);
  assert.equal((await t.api("/zz/boom", { method: "POST", as: o, idem: k3, body: {} })).status, 500);
  assert.equal(runs, 2);
  // a definitive 400 is stored and replayed
  const k4 = "44444444-2222-4333-8444-555555555555";
  runs = 0;
  const d1 = await t.api("/zz/bad", { method: "POST", as: o, idem: k4, body: {} });
  const d2 = await t.api("/zz/bad", { method: "POST", as: o, idem: k4, body: {} });
  assert.equal(d1.status, 400);
  assert.deepEqual(d2.body, d1.body);
  assert.equal(runs, 1);
  // error bodies carry no stack and no record data
  const boom = await t.api("/zz/boom", { method: "POST", as: o, body: {} });
  assert.deepEqual(boom.body, { ok: false, error: { code: "failed", message: "Something went wrong. Try again." } });
});

test("the body cap answers 413 before the handler runs", async () => {
  t = await crmTest();
  const o = await t.user("owner");
  runs = 0;
  const json = { "content-type": "application/json" };
  const r = await t.api("/zz/echo", { method: "POST", as: o, headers: json, raw: JSON.stringify({ x: "a".repeat(300 * 1024) }) });
  assert.equal(r.status, 413);
  assert.equal(runs, 0);
  const bad = await t.api("/zz/echo", { method: "POST", as: o, headers: json, raw: "{not json" });
  assert.equal(bad.status, 400);
});

test("maxCalls: going over the Blobs-call budget is a BudgetError (503 busy); a hanging store answers inside the budget", async () => {
  t = await crmTest();
  const o = await t.user("owner");
  const r = await t.api("/zz/calls", { as: o });
  assert.equal(r.status, 503);
  assert.equal(r.body.error.code, "busy");
  t.stores.data.hang({ op: "getWithMetadata", key: "zz/hang", times: 10 });
  const t0 = performance.now();
  const h = await t.api("/zz/hang", { as: o });
  const took = performance.now() - t0;
  assert.equal(h.status, 503);
  assert.ok(took < 3000, `answered in ${Math.round(took)} ms`);
});

test("a 412 carries the current record, cut to techFields for a tech", async () => {
  t = await crmTest();
  const o = await t.user("owner");
  const te = await t.user("tech");
  const made = await createRecord("zz_thing", { name: "First", notes: "office only" }, { by: o.id, origin: "api", actor_kind: "user" });
  await updateRecord("zz_thing", made.data.id, (r) => ({ ...r, name: "Second" }), { by: o.id, origin: "api", actor_kind: "user" });
  const asOwner = await t.api(`/zz/items/${made.data.id}`, { method: "PATCH", as: o, ifMatch: made.etag, body: { name: "Mine" } });
  assert.equal(asOwner.status, 412);
  assert.equal(asOwner.body.error.code, "stale");
  assert.equal(asOwner.body.error.details.current.notes, "office only");
  assert.equal(asOwner.body.error.details.current._w, undefined, "no writer nonce");
  assert.ok(asOwner.body.error.details.etag);
  const asTech = await t.api(`/zz/items/${made.data.id}`, { method: "PATCH", as: te, ifMatch: made.etag, body: { name: "Mine" } });
  assert.equal(asTech.status, 412);
  assert.deepEqual(Object.keys(asTech.body.error.details.current).sort(), ["id", "name", "type"]);
  assert.equal(asTech.body.error.details.current.name, "Second");
  const ok = await t.api(`/zz/items/${made.data.id}`, { method: "PATCH", as: o, ifMatch: asOwner.body.error.details.etag, body: { name: "Third" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.name, "Third");
  assert.ok(ok.headers.get("etag"));
});

test("a production deploy on another host gets a 308 to the canonical host; without its settings, 503 setup_needed", async () => {
  t = await crmTest({ env: { CRM_PRODUCTION: "1", CRM_KEY_SALT: "test-salt" } });
  const o = await t.user("owner");
  const r = await t.api("/me", { as: o, host: "https://bartawindowwashing.netlify.app", context: { deploy: { context: "production" } } });
  assert.equal(r.status, 308);
  assert.equal(r.headers.get("location"), "https://www.bartawindowwashing.com/api/crm/me");
  assert.equal((await t.api("/me", { as: o, context: { deploy: { context: "production" } } })).status, 200);
  delete process.env.CRM_KEY_SALT;
  try {
    const s = await t.api("/me", { as: o, context: { deploy: { context: "production" } } });
    assert.equal(s.status, 503);
    assert.equal(s.body.error.code, "setup_needed");
  } finally { process.env.CRM_KEY_SALT = "test-salt"; }
});
