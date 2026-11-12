// The map module's client side (docs/CRM-MAP.md): the vendored map library
// is byte for byte the published MapLibre GL JS 5.24.0 (its CSP build, with
// its license), the manifest's routes and permissions, and the pure helpers
// the screens use (what the phone's outbox holds laid over the pins, the
// report's date ranges, words for freshness).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";

const KIT = await import("../../../crm-app/modules/map/kit.js");
const MAN = (await import("../../../crm-app/modules/map/manifest.js")).default;
const REP = await import("../../../crm-app/modules/map/report.js");
const R = await import("../../../netlify/lib/crm/core/registry.mjs");
await import("../../../netlify/lib/crm/modules/index.mjs");

const VENDOR = "crm-app/vendor/maplibre-gl/";
const PINNED = {
  "LICENSE.txt": "ee5fc05a0677eaf69601d2c7db0d9ecd6cc27c3abc1d0733bc9ed34707cf8ef2",
  "maplibre-gl-csp-worker.js": "f950e7b15c49c8b9c7bb52136df2a2df2f6f03b83b8927774573fc98b067f7f0",
  "maplibre-gl-csp.js": "a1f1847bac64aa00acbf80fbb79b2c5af24d8eecaaa5e2ad14080fab81f1de95",
  "maplibre-gl.css": "ab1e70d59ec40465bae7e7030da2f3ccf28133fd502e62bd598eefbadfd7a732",
};

test("the vendored MapLibre GL JS is exactly the published 5.24.0 files, with its BSD license", () => {
  assert.deepEqual(readdirSync(VENDOR).sort(), Object.keys(PINNED).sort());
  for (const [f, sha] of Object.entries(PINNED)) assert.equal(createHash("sha256").update(readFileSync(VENDOR + f)).digest("hex"), sha, f);
  assert.match(readFileSync(VENDOR + "maplibre-gl-csp.js", "utf8").slice(0, 200), /MapLibre GL JS[\s\S]*@license 3-Clause BSD[\s\S]*v5\.24\.0/);
  assert.match(readFileSync(VENDOR + "LICENSE.txt", "utf8"), /Redistribution and use in source and binary forms/);
  // the screens load the CSP build and its worker file (worker-src 'self'), never a blob worker
  const mv = readFileSync("crm-app/modules/map/mapview.js", "utf8");
  assert.match(mv, /maplibre-gl-csp\.js/);
  assert.match(mv, /setWorkerUrl\(LIB\.worker\)/);
  assert.match(mv, /attributionControl: false/, "our own credits, never the style's HTML");
});

test("the manifest: Door to door for canvass:use, the Team map for team_map:read, settings by their permissions, the background start", () => {
  const perms = new Set(R.allPerms().map((p) => p.key));
  for (const r of MAN.routes) assert.ok(!r.perm || perms.has(r.perm) || ["settings:general", "settings:owner"].includes(r.perm), r.path);
  assert.equal(MAN.routes.find((r) => r.path === "/knock").perm, "canvass:use");
  assert.equal(MAN.routes.find((r) => r.path === "/team-map").perm, "team_map:read");
  assert.deepEqual(MAN.nav.map((n) => [n.section, n.label]), [["sales", "Door to door"], ["work", "Team map"]]);
  assert.equal(typeof MAN.start, "function");
  const roles = Object.fromEntries(R.allPerms().filter((p) => p.module === "map").map((p) => [p.key, p.roles]));
  assert.deepEqual(roles["canvass:use"], { owner: true, admin: true, tech: false });
  assert.deepEqual(roles["team_map:read"], { owner: true, admin: true, tech: false });
});

test("pins waiting on the phone are laid over the server's: a new one as a pending dot, a change on its pin; refused ones aren't", () => {
  const pins = [{ id: "pn_a", la: 45, ln: -93, t: "not_home" }];
  const items = [
    { method: "POST", path: "/map/pins", body: { client_id: "c1", lat: 45.1, lng: -93.1, type_key: "interested", follow_up_on: "2026-11-18" } },
    { method: "PATCH", path: "/map/pins/pn_a", body: { client_id: "c2", type_key: "booked" } },
    { method: "POST", path: "/map/pins", body: { client_id: "c3", lat: 45.2, lng: -93.2, type_key: "booked" }, refused: { status: 400 } },
    { method: "POST", path: "/visits/vs_x/notes", body: { text: "x" } },
  ];
  const out = KIT.overlayPins(pins, items, "us_me");
  assert.equal(out.length, 2);
  assert.deepEqual([out[0].t, out[0].pending], ["booked", true]);
  assert.deepEqual([out[1].id, out[1].t, out[1].pending, out[1].fu, out[1].c], ["wait-c1", "interested", true, "2026-11-18", "us_me"]);
  assert.equal(pins[0].t, "not_home", "the server's rows aren't changed");
});

test("words and ranges: freshness, staleness, the report's presets, text on a color", () => {
  assert.equal(KIT.freshness(30), "just now");
  assert.equal(KIT.freshness(125), "2 min ago");
  assert.equal(KIT.freshness(3 * 3600 + 120), "3 h 02 m ago");
  assert.equal(KIT.staleness(200, 120), "fresh");
  assert.equal(KIT.staleness(900, 120), "late");
  assert.equal(KIT.staleness(7200, 120), "old");
  assert.deepEqual(REP.presetRange("week", "2026-11-19"), { from: "2026-11-15", to: "2026-11-19", group: "day" });
  assert.deepEqual(REP.presetRange("month", "2026-11-19"), { from: "2026-11-01", to: "2026-11-19", group: "day" });
  assert.deepEqual(REP.presetRange("last30", "2026-11-19").group, "week");
  assert.equal(KIT.inkOn("#16161b"), "#fff");
  assert.equal(KIT.inkOn("#d0b116"), "#16161b");
  assert.equal(KIT.addressLine({ street1: "100 Example Ave", city: "Delano", state: "MN", zip: "55328" }), "100 Example Ave Delano, MN 55328");
});
