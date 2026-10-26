// /lights/streetview — address → Street View for Barta Light Studio. Google is
// stubbed; nothing leaves the machine.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.LIGHTS_PASSWORD = "test-password";
const { derive } = await import("../netlify/lib/lights-auth.mjs");
const mod = await import("../netlify/functions/lights-streetview.mjs");
const sv = mod.default;
const cookie = "barta_lights=" + derive("test-password");

const realFetch = globalThis.fetch;
let calls;
function google(routes) {
  calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    for (const [part, reply] of routes) {
      if (u.includes(part)) {
        const r = typeof reply === "function" ? reply(u) : reply;
        if (r instanceof Response) return r;
        return Response.json(r);
      }
    }
    throw new Error("unexpected " + u);
  };
}
const HOUSE = { lat: 45.0416, lng: -93.7889 };
const PANO = { lat: 45.0415, lng: -93.7892 };
const okRoutes = () => [
  ["/geocode/json", { status: "OK", results: [{ formatted_address: "123 Main St, Delano, MN 55328, USA", geometry: { location: HOUSE } }] }],
  ["/streetview/metadata", { status: "OK", pano_id: "AbCdEfGhIjKl_123", location: PANO }],
  ["/streetview?", () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { headers: { "content-type": "image/jpeg" } })],
];
const get = (qs, c = cookie) => sv(new Request("https://x.test/lights/streetview?" + qs, { headers: c ? { cookie: c } : {} }));

beforeEach(() => { process.env.GOOGLE_MAPS_API_KEY = "k-test"; });
afterEach(() => { globalThis.fetch = realFetch; delete process.env.GOOGLE_MAPS_API_KEY; });

test("signed-out browsers get nothing and Google isn't called", async () => {
  google(okRoutes());
  const res = await get("address=123+Main+St", "");
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0);
});

test("address finds the panorama and aims it at the house", async () => {
  google(okRoutes());
  const res = await get("address=" + encodeURIComponent("123 Main St, Delano"));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.pano, "AbCdEfGhIjKl_123");
  assert.equal(body.address, "123 Main St, Delano, MN 55328, USA");
  assert.equal(body.heading, Math.round(mod.bearing(PANO, HOUSE)));
  assert.ok(body.heading > 45 && body.heading < 90, "house is east-north-east of the camera");
  assert.ok(calls.every((u) => u.includes("key=k-test")));
});

test("the view image comes back as a JPEG", async () => {
  google(okRoutes());
  const res = await get("pano=AbCdEfGhIjKl_123&heading=60&pitch=8&fov=80");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/jpeg");
  assert.match(calls[0], /size=640x480/);
  assert.match(calls[0], /pano=AbCdEfGhIjKl_123/);
});

test("bad view parameters are refused before calling Google", async () => {
  google(okRoutes());
  assert.equal((await get("pano=../../etc&heading=60&pitch=8&fov=80")).status, 400);
  assert.equal((await get("pano=AbCdEfGhIjKl_123&heading=999&pitch=8&fov=80")).status, 400);
  assert.equal(calls.length, 0);
});

test("unknown address and no Street View say so", async () => {
  google([["/geocode/json", { status: "ZERO_RESULTS", results: [] }]]);
  assert.equal((await (await get("address=nowhere")).json()).error, "not_found");
  google([okRoutes()[0], ["/streetview/metadata", { status: "ZERO_RESULTS" }]]);
  assert.equal((await (await get("address=farm")).json()).error, "no_imagery");
});

test("without a Google key it says Street View isn't set up", async () => {
  delete process.env.GOOGLE_MAPS_API_KEY;
  google(okRoutes());
  const res = await get("address=123+Main+St");
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, "not_configured");
});
