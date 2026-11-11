// The phone checks' local server (design §12.4; docs/CRM.md "Phone checks").
// A small node:http server, no Netlify CLI: every Netlify Function of the
// repo at its configured path (/office, /crm*, /api/crm/*, /p/*, /dashboard,
// /lights, /playbook, ...) and the static files (crm-app/, crm-sw.js,
// office-sw.js, assets/, the site's pages) straight from the working tree.
//
//   import { start } from "./server.mjs";
//   const srv = await start();            // a free port; srv.url, srv.seed(), srv.now(), srv.setLatency(ms), srv.close()
//   node tests/e2e/server.mjs [port]      // by hand: port 8796, seeded, for a walk in a browser
//
// It runs the CRM on the memory stores (tests/helpers/crm-memory-store.mjs),
// in the "dev" deploy context, so every send stays a dry-run outbox row.
// The clock starts at Tuesday 2026-11-17 09:00 in Delano (CRM_TEST_NOW to
// change it) and runs on from there. A local first owner works like
// production's automatic setup: OFFICE_PASSWORD is "test-password" and
// OFFICE_DATA_KEY is a throwaway key made at start (never the real one, so
// the dashboard says it can't open its data; Home reads a made-up Rotor
// snapshot sealed for that key, tests/helpers/office-snapshot.mjs, as of
// CRM_TEST_SNAPSHOT_AS_OF, Monday 2026-11-16). Nothing leaves this machine:
// fetch() from the functions may only reach this server (no Rotor, no
// Twilio, no Google), and the worker lanes run in-process every 2 s.
import http from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const OFFICE_PASSWORD = "test-password";
export const START_AT = process.env.CRM_TEST_NOW || "2026-11-17T15:00:00Z";

process.env.OFFICE_PASSWORD = OFFICE_PASSWORD;
process.env.OFFICE_DATA_KEY = randomBytes(32).toString("base64");
for (const k of ["CONTEXT", "CRM_PRODUCTION", "CRM_SETUP_CODE", "CRM_KEY_SALT", "CRM_AUTO_SETUP", "ROTOR_API_KEY"]) delete process.env[k];

const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const { createCrmStores, useCrmStores } = await imp("tests/helpers/crm-memory-store.mjs");
useCrmStores(createCrmStores({ shuffle: false }), { sleepScale: 0.05 });
const clock = await imp("netlify/lib/crm/core/clock.mjs");
const store = await imp("netlify/lib/crm-store.mjs");
const { deployContext } = await imp("netlify/lib/crm/core/context.mjs");
await imp("netlify/lib/crm/modules/index.mjs");
const lanes = await imp("netlify/lib/crm/core/lanes.mjs");
const { sealedSnapshot } = await imp("tests/helpers/office-snapshot.mjs");
globalThis.__crmOfficeSnapshot = sealedSnapshot(process.env.OFFICE_DATA_KEY, process.env.CRM_TEST_SNAPSHOT_AS_OF || "2026-11-16");
const worker = await imp("netlify/lib/crm/core/worker.mjs");

// The clock: START_AT, running on with real time (sessions, "due now").
const base = Date.parse(START_AT);
const t0 = Date.now();
const tick = () => clock.setNow(base + (Date.now() - t0));
tick();
setInterval(tick, 50).unref();

// fetch() from the functions: this server only.
const realFetch = globalThis.fetch;
let selfOrigin = null;
globalThis.fetch = async (input, init) => {
  const u = new URL(typeof input === "string" ? input : input.url);
  if (selfOrigin && u.origin === selfOrigin) return realFetch(input, init);
  throw new TypeError(`e2e server: no network (${u.host})`);
};
lanes.setKicker(() => {});

const TYPES = { ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript", ".css": "text/css; charset=utf-8", ".webmanifest": "application/manifest+json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".html": "text/html; charset=utf-8", ".webp": "image/webp", ".ico": "image/x-icon", ".json": "application/json", ".txt": "text/plain; charset=utf-8" };
// Functions that only pass on another service's answer (Google reviews, Street View, the
// Business Profile, Rotor): with no network here a 5xx from them is expected, not a fault.
const NEEDS_NETWORK = new Set(["review-stats.mjs", "reviews.mjs", "lights-streetview.mjs", "gbp-mcp.mjs", "lead.mjs"]);
// Shipped static files only (build/make_deploy.py ships these, never tests/, netlify/ or docs/).
const NOT_STATIC = /^\/(netlify|tests|build|docs|config|node_modules|\.git)(\/|$)/;

async function functions() {
  const out = [];
  const dir = path.join(ROOT, "netlify/functions");
  for (const f of (await readdir(dir)).sort()) {
    if (!f.endsWith(".mjs")) continue;
    const m = await import(pathToFileURL(path.join(dir, f)).href);
    const cfg = m.config || {};
    for (const p of [].concat(cfg.path || [])) out.push({ p, excluded: [].concat(cfg.excludedPath || []), fn: m.default, name: f });
  }
  return out.sort((a, b) => b.p.replace("*", "").length - a.p.replace("*", "").length);
}
const hit = (pattern, pathname) => (pattern.endsWith("/*") ? pathname.startsWith(pattern.slice(0, -1)) || pathname === pattern.slice(0, -2) : pattern === pathname);

// Starts the server (port 0 = any free port). → { url, port, seed(opts), now(), setLatency(ms), close(), errors }
export async function start({ port = 0 } = {}) {
  const fns = await functions();
  const match = (pathname) => fns.find((r) => hit(r.p, pathname) && !r.excluded.some((x) => hit(x, pathname)));
  const errors = [];                    // functions that threw or answered 5xx
  let n = 0;
  let latency = 0;                      // ms before every answer: a slow line, the same for the page and its service workers
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, selfOrigin || "http://localhost");
    if (latency) await new Promise((ok) => setTimeout(ok, latency));
    try {
      const r = match(url.pathname);
      if (r) {
        const body = ["GET", "HEAD"].includes(req.method) ? undefined : await new Promise((ok) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => ok(Buffer.concat(c))); });
        const out = await r.fn(new Request(url, { method: req.method, headers: req.headers, body }), { site: {}, geo: {}, ip: "127.0.0.1", requestId: "e2e-" + (++n), waitUntil: (p) => { Promise.resolve(p).catch(() => {}); } });
        if (out.status >= 500 && !NEEDS_NETWORK.has(r.name)) errors.push(`${out.status} ${req.method} ${url.pathname} (${r.name})`);
        const headers = {};
        out.headers.forEach((v, k) => { if (k !== "set-cookie") headers[k] = v; });
        const cookies = out.headers.getSetCookie ? out.headers.getSetCookie() : [];
        if (cookies.length) headers["set-cookie"] = cookies;
        res.writeHead(out.status, headers);
        res.end(Buffer.from(await out.arrayBuffer()));
        return;
      }
      let p = decodeURIComponent(url.pathname);
      if (p.endsWith("/")) p += "index.html";
      if (p.includes("..") || NOT_STATIC.test(p)) { res.writeHead(404); res.end("not found"); return; }
      const file = await readFile(path.join(ROOT, p)).catch(() => null);
      if (!file) { res.writeHead(404, { "Content-Type": "text/plain" }); res.end("not found"); return; }
      const h = { "Content-Type": TYPES[path.extname(p)] || "application/octet-stream" };
      if (p.startsWith("/crm-app/") || p === "/crm-sw.js" || p === "/office-sw.js") h["Cache-Control"] = "no-cache";
      if (p.startsWith("/crm-app/")) h["X-Content-Type-Options"] = "nosniff";
      res.writeHead(200, h);
      res.end(req.method === "HEAD" ? undefined : file);
    } catch (e) {
      errors.push(`threw ${req.method} ${url.pathname}: ${e && e.message}`);
      if (!res.headersSent) res.writeHead(500);
      res.end("server error");
    }
  });
  await new Promise((ok) => server.listen(port, "127.0.0.1", ok));
  const real = server.address().port;
  // "localhost" (not 127.0.0.1): a secure context, so service workers run
  selfOrigin = `http://localhost:${real}`;
  const dev = deployContext(new Request(selfOrigin + "/"), {});
  let busy = false;
  const lanesTimer = setInterval(() => {
    if (busy) return;
    busy = true;
    store.withStoreScope({ deploy: dev, requestId: "e2e-lanes" }, async () => {
      await worker.runOnce("bulk", { deploy: dev });
      await worker.runOnce("fast", { deploy: dev });
    }).catch((e) => errors.push("lanes: " + (e && e.message))).finally(() => { busy = false; });
  }, 2000);
  lanesTimer.unref();
  return {
    url: selfOrigin,
    port: real,
    errors,
    now: () => clock.nowIso(),
    setLatency: (ms) => { latency = Math.max(0, Number(ms) || 0); },
    async seed(opts = {}) {
      const { seed } = await import("./seed.mjs");
      return store.withStoreScope({ deploy: dev, requestId: "e2e-seed" }, () => seed(opts));
    },
    close: () => new Promise((ok) => { clearInterval(lanesTimer); server.closeAllConnections?.(); server.close(() => ok()); }),
  };
}

// By hand: node tests/e2e/server.mjs [port]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const srv = await start({ port: Number(process.argv[2]) || 8796 });
  const s = await srv.seed();
  console.log(`e2e server on ${srv.url} (clock ${srv.now()}); sign in as ${Object.values(s.users).map((u) => u.login).join(", ")} with "${s.password}", office password "${OFFICE_PASSWORD}"`);
}
