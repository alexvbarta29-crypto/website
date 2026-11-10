// The registry, services and events (design §11.3): every module stub is
// registered, and a manifest with an unknown key, a missing `mutates`,
// `category`, `imported`, `perm` or `rotorFields`, or a duplicate fails at
// import time.
import { test } from "node:test";
import assert from "node:assert/strict";

const { MODULES } = await import("../../../netlify/lib/crm/modules/index.mjs");
const R = await import("../../../netlify/lib/crm/core/registry.mjs");
const services = await import("../../../netlify/lib/crm/core/services.mjs");
const { emit, eventId, listenerMarker, EVENTS } = await import("../../../netlify/lib/crm/core/events.mjs");
const { RegistryError, ServiceMissing } = await import("../../../netlify/lib/crm/core/errors.mjs");
const { MANIFESTS } = await import("../../../crm-app/modules/index.js");

const NAMES = ["system", "contacts", "sales", "import", "quotes", "plans", "work", "money", "comms", "payroll", "reports", "mcp"];
const route = (extra = {}) => ({ method: "GET", path: "/x", auth: "session", perm: "x:read", subject: "none", mode: "inline", handler: async () => ({}), ...extra });
const fn = async () => {};

test("every module directory is registered, server and client", () => {
  assert.deepEqual(MODULES.map((m) => m.name), NAMES);
  assert.deepEqual(R.allModules().map((m) => m.name), NAMES);
  assert.deepEqual(MANIFESTS.map((m) => m.name), NAMES);
  for (const m of MANIFESTS) for (const k of ["routes", "nav", "creates", "contactTabs", "visitActions", "todayCards", "settings"]) assert.ok(Array.isArray(m[k]), `${m.name}.${k}`);
  assert.ok(R.getType("contact_stats"));
  assert.equal(services.providerOf("stats.update"), "system");
});

test("manifests are validated", () => {
  assert.throws(() => R.defineModule({ name: "t1", colour: "red" }), /unknown key "colour"/);
  assert.throws(() => R.defineModule({ name: "t2", sweeps: [{ key: "t2.x", lane: "fast", every: "daily", run: fn }] }), /must declare mutates/);
  assert.throws(() => R.defineModule({ name: "t3", queue: { "t3.q": { handler: fn } } }), /must declare mutates/);
  assert.throws(() => R.defineModule({ name: "t4", events: { "job.completed": { handler: fn } } }), /must declare mutates/);
  assert.throws(() => R.defineModule({ name: "t5", automations: [{ key: "a", trigger: "event:x", imported: "no", mutates: false, run: fn }] }), /category/);
  assert.throws(() => R.defineModule({ name: "t6", automations: [{ key: "a", trigger: "event:x", category: "service", mutates: false, run: fn }] }), /imported/);
  assert.throws(() => R.defineModule({ name: "t7", routes: [route({ perm: undefined })] }), /perm is required/);
  assert.throws(() => R.defineModule({ name: "t8", routes: [route({ perm: null })] }), /only public and hook routes/);
  assert.throws(() => R.defineModule({ name: "t9", routes: [route({ subject: undefined })] }), /subject is required/);
  assert.throws(() => R.defineModule({ name: "t10", routes: [route({ mode: undefined })] }), /mode is required/);
  assert.throws(() => R.defineModule({ name: "t11", routes: [route({ auth: "cookie" })] }), /auth is required/);
  assert.throws(() => R.defineModule({ name: "t12", settings: { s: { defaults: {}, validate: fn } } }), /needs a perm/);
  assert.throws(() => R.defineType({ type: "thing", prefix: "th", v: 1, validate: fn, techFields: [], example: fn }), /rotorFields is required/);
  assert.throws(() => R.defineType({ type: "thing", prefix: "th", v: 1, validate: fn, rotorFields: [], example: fn }), /techFields is required/);
  assert.throws(() => R.defineType({ type: "thing", prefix: "th", v: 1, validate: fn, rotorFields: [], techFields: [] }), /example\(\) is required/);
  assert.ok(R.defineModule({ name: "t13", routes: [route({ auth: "public", perm: null })] }));
});

test("duplicates across modules fail registration and leave nothing half-registered", () => {
  R.registerModule({ name: "dup-a", routes: [route({ path: "/dup" })], perms: [{ key: "dup:read", label: "Read", roles: { owner: true } }] });
  assert.throws(() => R.registerModule({ name: "dup-b", sweeps: [{ key: "dup-b.s", lane: "fast", every: "pass", mutates: false, run: fn }], routes: [route({ path: "/dup" })] }), RegistryError);
  assert.equal(R.getModule("dup-b"), null);
  assert.ok(!R.allSweeps().some((s) => s.key === "dup-b.s"), "the sweep of the refused module is not registered");
  assert.throws(() => R.registerModule({ name: "dup-c", perms: [{ key: "dup:read", label: "Again", roles: {} }] }), /permission dup:read/);
  assert.throws(() => R.registerModule({ name: "system" }), /registered twice/);
});

test("a module with two tracks composes its parts", () => {
  const office = { routes: [route({ path: "/office-part" })], services: {} };
  const field = { routes: [route({ path: "/field-part" })], queue: { "comp.q": { handler: fn, mutates: false } } };
  const m = R.defineModule({ name: "comp", parts: [office, field] });
  assert.deepEqual(m.routes.map((r) => r.path), ["/office-part", "/field-part"]);
  assert.ok(m.queue["comp.q"]);
  assert.throws(() => R.defineModule({ name: "comp2", parts: [{ queue: { q: { handler: fn, mutates: false } } }, { queue: { q: { handler: fn, mutates: false } } }] }), /declared twice/);
  assert.ok(R.getModule("work"), "work composes its office and field parts");
});

test("services: a missing one says so; only the contract's module may provide it", async () => {
  await assert.rejects(services.call("work.createJobs", []), ServiceMissing);
  assert.equal(services.has("work.createJobs"), false);
  assert.throws(() => services.provide("work.createJobs", fn, { module: "quotes" }), /belongs to work/);
  services.provide("t.custom", async (x) => x * 2, { module: "anything" });
  assert.equal(await services.call("t.custom", 21), 42);
});

test("events: one id per write counter, payload checked, undeclared events refused", async () => {
  R.registerModule({ name: "listener-mod", events: { "job.completed": { handler: fn, mutates: false } } });
  const payload = { id: "jb_0000000000000000000a", wv: 3, job_id: "jb_0000000000000000000a", contact_id: "ct_1", kind: "one_time", billable: true, total_cents: 24310, assignee_ids: [] };
  const a = await emit("job.completed", payload, { by: "us_a" });
  const b = await emit("job.completed", payload);
  const c = await emit("job.completed", { ...payload, wv: 5 });
  assert.equal(a.event.event_id, b.event.event_id, "a retried request is the same event");
  assert.notEqual(a.event.event_id, c.event.event_id, "reopened and completed again is a new event");
  assert.equal(a.event.event_id, eventId(payload.id, 3));
  assert.deepEqual(a.listeners, ["listener-mod"]);
  assert.deepEqual(listenerMarker(a.event.event_id, "money"), { ns: "done", scope: "evt", key: `${a.event.event_id}--money` });
  await assert.rejects(emit("job.exploded", payload), RegistryError);
  await assert.rejects(emit("job.completed", { ...payload, total_cents: undefined }), /needs total_cents/);
  await assert.rejects(emit("job.completed", { job_id: "x" }), /record id and wv/);
  assert.ok(Object.isFrozen(EVENTS));
});
