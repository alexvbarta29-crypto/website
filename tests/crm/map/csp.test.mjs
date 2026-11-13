// The map stack and the CSP (docs/CRM-MAP.md "The map stack"): the CRM's
// pages may reach exactly the map hosts the env picks (OpenFreeMap and USGS
// by default), nothing else leaves 'self'; a keyed provider without its key
// falls back to the default; the shell sends this deploy's CSP.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { crmTest } from "../../helpers/crm-http.mjs";

const { mapSources, mapHosts, STREETS, AERIAL } = await import("../../../netlify/lib/crm/core/map-sources.mjs");
const { CSP, cspFor, currentCsp } = await import("../../../netlify/lib/crm/core/http.mjs");

let t;
afterEach(() => { if (t) t.done(); t = null; });
const connect = (csp) => /connect-src ([^;]+)/.exec(csp)[1].split(" ");
const KEY = "AAPKexample0000000000synthetic";

test("by default: OpenFreeMap's streets and USGS aerial, no key; the CSP adds exactly their two hosts to connect-src and nothing else", () => {
  const s = mapSources({});
  assert.equal(s.streets.style, "https://tiles.openfreemap.org/styles/liberty");
  assert.equal(s.aerial.tiles, "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}");
  assert.equal(s.aerial.maxzoom, 16);
  assert.deepEqual(s.hosts, ["https://tiles.openfreemap.org", "https://basemap.nationalmap.gov"]);
  assert.deepEqual(connect(CSP), ["'self'", "https://tiles.openfreemap.org", "https://basemap.nationalmap.gov"]);
  for (const d of ["script-src 'self'", "worker-src 'self'", "img-src 'self' data: blob:", "default-src 'self'", "frame-ancestors 'self'"]) assert.ok(CSP.includes(d + ";") || CSP.endsWith(d), d);
  assert.doesNotMatch(CSP, /unsafe-eval|\*|blob: https|worker-src [^;]*blob/);
  for (const p of [...Object.values(STREETS), ...Object.values(AERIAL)]) for (const h of p.hosts) assert.match(h, /^https:\/\/[a-z0-9.-]+$/, "exact hosts, no wildcard");
});

test("one config swaps the provider: aerial off, Esri with its key, MapTiler with its key; a keyed one without its key stays on the default", () => {
  assert.deepEqual(mapHosts({ CRM_MAP_AERIAL: "off" }), ["https://tiles.openfreemap.org"]);
  assert.equal(mapSources({ CRM_MAP_AERIAL: "off" }).aerial, null);
  const esri = mapSources({ CRM_MAP_AERIAL: "esri", CRM_MAP_AERIAL_KEY: KEY });
  assert.equal(esri.aerial.name, "esri");
  assert.ok(esri.aerial.tiles.endsWith("?token=" + KEY));
  assert.deepEqual(connect(cspFor({ CRM_MAP_AERIAL: "esri", CRM_MAP_AERIAL_KEY: KEY })), ["'self'", "https://tiles.openfreemap.org", "https://ibasemaps-api.arcgis.com"]);
  const noKey = mapSources({ CRM_MAP_AERIAL: "esri" });
  assert.deepEqual([noKey.aerial.name, noKey.aerial.waiting_for_key], ["usgs", "esri"]);
  assert.deepEqual(connect(cspFor({ CRM_MAP_AERIAL: "esri" })), ["'self'", "https://tiles.openfreemap.org", "https://basemap.nationalmap.gov"]);
  const mt = mapSources({ CRM_MAP_STREETS: "maptiler", CRM_MAP_STREETS_KEY: KEY });
  assert.equal(mt.streets.style, "https://api.maptiler.com/maps/streets-v2/style.json?key=" + KEY);
  assert.deepEqual(mapSources({ CRM_MAP_STREETS: "nonsense" }).streets.name, "openfreemap");
  assert.deepEqual(mapSources({ CRM_MAP_STREETS_KEY: "short" }).streets.name, "openfreemap");
});

test("the shell and the sign-in page send this deploy's CSP", async () => {
  t = await crmTest({ env: { CRM_MAP_AERIAL: "off" } });
  const o = await t.user("owner");
  await t.bootstrap(o);
  for (const [p, opts] of [["/crm", { as: o }], ["/crm/login", {}]]) {
    const r = await t.page(p, opts);
    assert.equal(r.headers.get("content-security-policy"), cspFor({ CRM_MAP_AERIAL: "off" }), p);
  }
  assert.equal(currentCsp({}), CSP);
});
