// The M1.1 platform probe (design §3.10, §3.13, §11.4 M1.1 gate): each
// function kind records its deploy signal into the scratch store crm-probe,
// the request and background kinds time 20 conditional writes, and nothing
// touches the CRM data store or the network.
import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createCrmStores, useCrmStores, clearCrmStores } from "../../helpers/crm-memory-store.mjs";

process.env.OFFICE_PASSWORD = "test-password";
const { derive } = await import("../../../netlify/lib/lights-auth.mjs");
const probeMod = await import("../../../netlify/functions/crm-probe.mjs");
const cronMod = await import("../../../netlify/functions/crm-cron.mjs");
const workerMod = await import("../../../netlify/functions/crm-worker-background.mjs");
const P = await import("../../../netlify/lib/crm/core/probe.mjs");
const { setNow } = await import("../../../netlify/lib/crm/core/clock.mjs");

const cookie = "barta_office=" + derive("test-password");
const PROD = { deploy: { context: "production", id: "dep1" } };
let S, savedFetch, kicks, quiet;
beforeEach(() => {
  S = useCrmStores(createCrmStores());
  setNow("2026-11-17T15:00:00Z");
  savedFetch = globalThis.fetch;
  kicks = [];
  globalThis.fetch = async (url, init = {}) => { kicks.push({ url: String(url), init }); return new Response(null, { status: 202 }); };
  quiet = ["log", "error"].map((m) => mock.method(console, m, () => {}));
});
afterEach(() => {
  globalThis.fetch = savedFetch;
  for (const q of quiet) q.mock.restore();
  clearCrmStores();
  setNow(null);
});

const get = (url = "https://www.bartawindowwashing.com/api/crm-probe", headers = { cookie }, context = PROD) => probeMod.default(new Request(url, { headers }), context);

test("the functions are wired as the design says: a path, a 15-minute schedule, a background file", () => {
  assert.deepEqual(probeMod.config, { path: "/api/crm-probe" });
  assert.deepEqual(cronMod.config, { schedule: "*/15 * * * *" });
  assert.equal(cronMod.CRON, cronMod.config.schedule);
  assert.equal(workerMod.config, undefined, "default URL /.netlify/functions/crm-worker-background");
  assert.match(readFileSync("netlify/functions/crm-cron.mjs", "utf8"), /export const config = \{ schedule: "\*\/15 \* \* \* \*" \};/, "a literal Netlify can read without running the file");
});

test("GET /api/crm-probe needs the office sign-in", async () => {
  const res = await get(undefined, {});
  assert.equal(res.status, 401);
  assert.deepEqual(S.probe.keys(), []);
});

test("a request records its facts; the report says what setup is missing, as booleans only", async () => {
  const res = await get();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const { data } = await res.json();
  const facts = data.facts["request--production"];
  assert.equal(facts.context_signal, true);
  assert.equal(facts.context_value, "production");
  assert.equal(facts.crm_production, false);
  assert.equal(facts.deploy.setup_needed, true);
  assert.equal(facts.deploy.signal, "context");
  assert.equal(facts.runs, 1);
  assert.deepEqual(data.setup.missing, ["CRM_PRODUCTION", "CRM_KEY_SALT", "CRM_SETUP_CODE"]);
  assert.deepEqual(S.data.keys(), [], "the probe never touches the CRM data store");
  await get();
  assert.equal(S.probe.json("facts/request--production").runs, 2);
});

test("on production, a non-canonical host is redirected before anything runs", async () => {
  const res = await get("https://bartawindowwashing.netlify.app/api/crm-probe");
  assert.equal(res.status, 308);
  assert.equal(res.headers.get("location"), "https://www.bartawindowwashing.com/api/crm-probe");
  assert.deepEqual(S.probe.keys(), []);
});

test("POST times 20 conditional writes (needs X-CRM: 1) and stores p50/p95", async () => {
  const url = "https://www.bartawindowwashing.com/api/crm-probe";
  const no = await probeMod.default(new Request(url, { method: "POST", headers: { cookie } }), PROD);
  assert.equal(no.status, 403);
  const res = await probeMod.default(new Request(url, { method: "POST", headers: { cookie, "x-crm": "1" } }), PROD);
  assert.equal(res.status, 200);
  const { latency } = (await res.json()).data;
  assert.equal(latency.n, 20);
  assert.equal(latency.ok, 20);
  assert.equal(typeof latency.p95, "number");
  assert.equal(latency.suggested_max_calls, 25);
  assert.equal(S.probe.json("latency/request--production").n, 20);
  const writes = S.probe.calls.filter((c) => c.op === "setJSON" && c.key === "latency/scratch--request");
  assert.equal(writes.length, 20);
  assert.ok(writes.every((c) => c.opts.onlyIfNew || c.opts.onlyIfMatch), "conditional writes");
});

test("a slow production store lowers the suggested maxCalls", () => {
  assert.equal(P.suggestedMaxCalls(100), 25);
  assert.equal(P.suggestedMaxCalls(150), 25);
  assert.equal(P.suggestedMaxCalls(200), 25, "never above the default");
  assert.equal(P.suggestedMaxCalls(400), 15);
});

test("the cron records the scheduled kind and kicks the background function on the canonical host with the secret", async () => {
  const res = await cronMod.default(new Request("https://whatever.netlify.app/.netlify/functions/crm-cron", { method: "POST" }), PROD);
  assert.equal(res.status, 204);
  assert.ok(S.probe.json("facts/scheduled--production"));
  const secret = S.probe.json("secret/worker").secret;
  assert.match(secret, /^[0-9a-f]{64}$/);
  assert.equal(kicks.length, 1);
  assert.equal(kicks[0].url, "https://www.bartawindowwashing.com/.netlify/functions/crm-worker-background");
  assert.equal(kicks[0].init.headers["x-crm-worker"], secret);
  assert.ok(kicks[0].init.signal, "the kick has a timeout");
  await cronMod.default(new Request("https://x/", { method: "POST" }), PROD);
  assert.equal(S.probe.json("secret/worker").secret, secret, "the secret is made once");
});

test("the background function ignores calls without the secret, records its facts and measures at most hourly", async () => {
  await cronMod.default(new Request("https://x/", { method: "POST" }), PROD);
  const secret = S.probe.json("secret/worker").secret;
  const url = "https://www.bartawindowwashing.com/.netlify/functions/crm-worker-background";
  const refused = await workerMod.default(new Request(url, { method: "POST", headers: { "x-crm-worker": "nope" } }), PROD);
  assert.equal(refused.status, 401);
  assert.equal(S.probe.json("facts/background--production"), null);
  const ok = await workerMod.default(new Request(url, { method: "POST", headers: { "x-crm-worker": secret } }), PROD);
  assert.equal(ok.status, 202);
  const facts = S.probe.json("facts/background--production");
  assert.equal(facts.kind, "background");
  assert.equal(S.probe.json("latency/background--production").n, 20);
  const before = S.probe.calls.length;
  await workerMod.default(new Request(url, { method: "POST", headers: { "x-crm-worker": secret } }), PROD);
  const scratch = S.probe.calls.slice(before).filter((c) => c.key === "latency/scratch--background" && c.op === "setJSON");
  assert.equal(scratch.length, 0, "not again within the hour");
  setNow("2026-11-17T16:00:01Z");
  await workerMod.default(new Request(url, { method: "POST", headers: { "x-crm-worker": secret } }), PROD);
  assert.equal(S.probe.json("latency/background--production").at, "2026-11-17T16:00:01.000Z");
  assert.deepEqual(S.data.keys(), []);
});

test("a function kind without the context signal is recorded as such (CRM_PRODUCTION alone decides)", async () => {
  const facts = P.runtimeFacts("background", new Request("https://www.bartawindowwashing.com/x"), {}, { CRM_PRODUCTION: "1" });
  assert.equal(facts.context_signal, false);
  assert.equal(facts.crm_production, true);
  assert.equal(facts.deploy.signal, "env");
  assert.equal(facts.deploy.prod, true);
  assert.throws(() => P.runtimeFacts("edge", new Request("https://x/"), {}, {}), TypeError);
});
