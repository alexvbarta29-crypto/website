// The map services, stubbed for the phone checks (tests/e2e/map.spec.mjs):
// nothing leaves the machine. stubMaps(ctx) answers the browser's requests
// to the map hosts the CSP allows (core/map-sources.mjs's defaults:
// tiles.openfreemap.org for the streets, basemap.nationalmap.gov for the
// aerial view) with a made-up style and tiles drawn here: a small grid of
// "Example" streets and houses near Delano's center, no fonts, no sprites.
// The requests still go to the real host names, so the page's CSP is
// tested as it is in production.
import { deflateSync } from "node:zlib";
import { GRID } from "./map-seed.mjs";

const r6 = (x) => Math.round(x * 1e6) / 1e6;
function features() {
  const streets = [];
  const houses = [];
  for (let s = -1; s <= 7; s++) {
    const lat = GRID.lat + (s - 3) * GRID.dLat * 2 - GRID.dLat;
    streets.push({ type: "Feature", properties: { kind: "street" }, geometry: { type: "LineString", coordinates: [[r6(GRID.lng - 9 * GRID.dLng), r6(lat)], [r6(GRID.lng + 9 * GRID.dLng), r6(lat)]] } });
  }
  for (let a = -9; a <= 9; a += 3) {
    const lng = GRID.lng + (a - 0.5) * GRID.dLng;
    streets.push({ type: "Feature", properties: { kind: "avenue" }, geometry: { type: "LineString", coordinates: [[r6(lng), r6(GRID.lat - 9 * GRID.dLat)], [r6(lng), r6(GRID.lat + 9 * GRID.dLat)]] } });
  }
  for (let s = 0; s < 7; s++) {
    for (let n = -2; n < 15; n++) {
      const lat = GRID.lat + (s - 3) * GRID.dLat * 2 + 0.00028;
      const lng = GRID.lng + (n - 6) * GRID.dLng;
      const w = 0.00042, h = 0.0003;
      houses.push({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[[r6(lng - w), r6(lat - h)], [r6(lng + w), r6(lat - h)], [r6(lng + w), r6(lat + h)], [r6(lng - w), r6(lat + h)], [r6(lng - w), r6(lat - h)]]] } });
    }
  }
  return { streets, houses };
}

export function stubStyle() {
  const f = features();
  return {
    version: 8, name: "e2e stub",
    sources: {
      streets: { type: "geojson", data: { type: "FeatureCollection", features: f.streets } },
      houses: { type: "geojson", data: { type: "FeatureCollection", features: f.houses } },
      // an empty vector source on the real host, as OpenFreeMap's style has one
      lakes: { type: "geojson", data: { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[[r6(GRID.lng + 9 * GRID.dLng), r6(GRID.lat - 4 * GRID.dLat)], [r6(GRID.lng + 16 * GRID.dLng), r6(GRID.lat - 4 * GRID.dLat)], [r6(GRID.lng + 16 * GRID.dLng), r6(GRID.lat + 6 * GRID.dLat)], [r6(GRID.lng + 9 * GRID.dLng), r6(GRID.lat + 6 * GRID.dLat)], [r6(GRID.lng + 9 * GRID.dLng), r6(GRID.lat - 4 * GRID.dLat)]]] } }] } },
    },
    layers: [
      { id: "land", type: "background", paint: { "background-color": "#f2efe9" } },
      { id: "water", type: "fill", source: "lakes", paint: { "fill-color": "#a8cfe8" } },
      { id: "casing", type: "line", source: "streets", paint: { "line-color": "#d6d0c4", "line-width": ["interpolate", ["linear"], ["zoom"], 12, 3, 18, 22] } },
      { id: "road", type: "line", source: "streets", paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 12, 2, 18, 18] } },
      { id: "building", type: "fill", source: "houses", minzoom: 14, paint: { "fill-color": "#ddd5cc", "fill-outline-color": "#c9bfb4" } },
    ],
  };
}

// A 256 x 256 PNG of one color (the aerial stub's tile).
export function pngTile([r, g, b] = [96, 122, 82]) {
  const w = 256, h = 256;
  const crc = (buf) => { let c = ~0; for (const x of buf) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  // fields and tree rows (a made-up texture, nothing real)
  const rows = Array.from({ length: h }, (_, y) => {
    const out = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++) {
      const field = ((Math.floor(x / 64) + Math.floor(y / 48)) % 3) * 12;
      const tree = (x * 13 + y * 7) % 23 < 5 ? -22 : 0;
      out[1 + x * 3] = Math.max(0, r + field + tree + ((x * 7) % 11));
      out[2 + x * 3] = Math.max(0, g + field / 2 + tree + ((y * 5) % 9));
      out[3 + x * 3] = Math.max(0, b + tree / 2);
    }
    return out;
  });
  const raw = Buffer.concat(rows);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// Answers the map hosts for this browser context. → { calls } (each URL the map asked for)
export async function stubMaps(ctx) {
  const calls = [];
  const style = JSON.stringify(stubStyle());
  const tile = pngTile();
  await ctx.route("https://tiles.openfreemap.org/**", (route) => { calls.push(route.request().url()); return route.fulfill({ status: 200, contentType: "application/json", body: style, headers: { "access-control-allow-origin": "*" } }); });
  await ctx.route("https://basemap.nationalmap.gov/**", (route) => { calls.push(route.request().url()); return route.fulfill({ status: 200, contentType: "image/png", body: tile, headers: { "access-control-allow-origin": "*" } }); });
  return { calls };
}
