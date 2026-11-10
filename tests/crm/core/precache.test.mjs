// The CRM's service worker and precache (design §2.5, §11.1 rule 8;
// acceptance test of M1.2): PRECACHE is exactly the files under crm-app/,
// VERSION is APP_VERSION, the server's MIN_CLIENT is not newer, and the
// worker never caches an /api/ URL or the never-cached pages (run in a
// sandbox with fake caches and fetch).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const { appFiles, appVersion, rewrite } = await import("../../../build/crm_precache.mjs");
const { APP_VERSION } = await import("../../../crm-app/version.js");
const { MIN_CLIENT, MIN_REPLAY_CLIENT, compareVersions } = await import("../../../netlify/lib/crm/core/http.mjs");

const SW = readFileSync("crm-sw.js", "utf8");
const ORIGIN = "https://www.bartawindowwashing.com";

function loadSw(source, { network } = {}) {
  const handlers = {};
  const puts = [];
  const adds = [];
  const store = new Map();
  const cacheFor = (name) => ({
    async put(req, res) { const u = typeof req === "string" ? req : req.url; puts.push({ name, url: u }); store.set(name + " " + new URL(u, ORIGIN).pathname, res); },
    async add(u) { adds.push({ name, url: u }); },
    async addAll(list) { for (const u of list) adds.push({ name, url: u }); },
    async match(req) { const u = typeof req === "string" ? req : req.url; return store.get(name + " " + new URL(u, ORIGIN).pathname) || undefined; },
    async delete(u) { return store.delete(name + " " + new URL(u, ORIGIN).pathname); },
  });
  const fetchCalls = [];
  const sandbox = {
    self: { addEventListener: (type, fn) => { handlers[type] = fn; }, skipWaiting: async () => {}, clients: { claim: async () => {} } },
    caches: { open: async (n) => cacheFor(n), keys: async () => [], delete: async () => true, match: async () => undefined },
    location: { origin: ORIGIN },
    fetch: async (req, init) => { fetchCalls.push(typeof req === "string" ? req : req.url); return network ? network(req, init) : new Response("ok", { status: 200 }); },
    Response, Request, URL, Promise, console,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  const fire = async (url, { mode = "no-cors", method = "GET" } = {}) => {
    let responded = null;
    const waits = [];
    const event = {
      request: { url: new URL(url, ORIGIN).href, method, mode },
      respondWith: (p) => { responded = p; },
      waitUntil: (p) => { waits.push(p); },
    };
    handlers.fetch(event);
    const res = responded ? await responded : null;
    await Promise.allSettled(waits);
    return { responded: !!responded, res };
  };
  const install = async () => { const w = []; handlers.install({ waitUntil: (p) => w.push(p) }); await Promise.all(w); };
  return { handlers, puts, adds, fire, install, fetchCalls };
}

test("PRECACHE is exactly the files under crm-app/, and VERSION, APP_VERSION and MIN_CLIENT agree", () => {
  const m = /const PRECACHE = (\[[\s\S]*?\n\]);/.exec(SW);
  assert.ok(m, "crm-sw.js has a PRECACHE list");
  const list = JSON.parse(m[1].replace(/,\n\]$/, "\n]"));
  assert.deepEqual(list, appFiles(), "run node build/crm_precache.mjs");
  assert.ok(list.includes("/crm-app/main.js") && list.includes("/crm-app/styles/crm.css") && list.includes("/crm-app/version.js"));
  const v = /const VERSION = "([^"]+)";/.exec(SW)[1];
  assert.equal(v, APP_VERSION);
  assert.equal(appVersion(), APP_VERSION);
  assert.equal(rewrite(SW, APP_VERSION, appFiles()), SW, "build/crm_precache.mjs --check passes");
  assert.ok(compareVersions(MIN_CLIENT, APP_VERSION) <= 0, "the server never refuses the app it ships");
  assert.ok(compareVersions(MIN_REPLAY_CLIENT, MIN_CLIENT) <= 0);
});

test("the service worker never caches /api/, /crm/legacy, /crm/login, /crm/setup or /crm/invite; the shell only when it is the shell", async () => {
  const sw = loadSw(SW, {
    network: (req) => {
      const u = typeof req === "string" ? req : req.url;
      if (new URL(u, ORIGIN).pathname === "/crm") return new Response("<p>shell</p>", { status: 200, headers: { "X-CRM-Shell": "1" } });
      return new Response("{}", { status: 200 });
    },
  });
  await sw.install();
  assert.ok(sw.adds.some((a) => a.url === "/crm-app/main.js"), "the app files are precached at install");
  assert.ok(sw.adds.every((a) => !a.url.startsWith("/api/")));
  for (const url of ["/api/crm/me", "/api/crm/auth/login", "/crm/legacy", "/crm/legacy?import=1", "/crm/login", "/crm/setup", "/crm/invite/us_x.y"]) {
    const r = await sw.fire(url, { mode: url.startsWith("/api") ? "cors" : "navigate" });
    assert.equal(r.responded, false, `${url} goes to the network untouched`);
  }
  assert.equal((await sw.fire("/api/crm/import", { method: "POST" })).responded, false);
  const shell = await sw.fire("/crm", { mode: "navigate" });
  assert.equal(shell.responded, true);
  await sw.fire("/crm-app/main.js");
  assert.deepEqual(sw.puts.map((p) => new URL(p.url, ORIGIN).pathname), ["/crm"], "the only put is the shell");
  assert.ok(sw.puts.every((p) => !/\/api\//.test(p.url)));
  // a shell answer that is a redirect to sign-in is never kept
  const out = loadSw(SW, { network: () => new Response(null, { status: 302, headers: { Location: "/crm/login" } }) });
  await out.fire("/crm", { mode: "navigate" });
  assert.equal(out.puts.length, 0);
});

test("make_deploy ships crm-app/ and crm-sw.js, and netlify.toml re-checks them on every load", () => {
  const py = readFileSync("build/make_deploy.py", "utf8");
  assert.match(py, /CRM_APP_DIR = "crm-app"/);
  assert.match(py, /"crm-sw\.js"/);
  const toml = readFileSync("netlify.toml", "utf8");
  assert.match(toml, /for = "\/crm-app\/\*"\s*\n\s*\[headers\.values\]\s*\n\s*Cache-Control = "no-cache"/);
  assert.match(toml, /for = "\/crm-sw\.js"\s*\n\s*\[headers\.values\]\s*\n\s*Cache-Control = "no-cache"/);
  // nothing under crm-app/ may hold data: no phone numbers (but 555 examples) or emails
  for (const f of appFiles()) {
    const src = readFileSync("." + f, "utf8");
    assert.doesNotMatch(src, /\b\d{3}[-.)\s]*(?!555)\d{3}[-.\s]\d{4}\b/, f);
    assert.doesNotMatch(src, /[A-Za-z0-9._%+-]+@(?!example\.com)[A-Za-z0-9.-]+\.[a-z]{2,}/, f);
  }
});
