// Barta CRM client: directions and a simple route sketch (design §2.3
// map.js, §9.2 "Route"). No map SDK in v1: directions always leave the
// CRM through openExternal() (a new tab, or the phone's maps app from the
// top window), and a day's stops are drawn as a small SVG of numbered dots.

import { html, openExternal } from "./ui.js";

const q = (address) => {
  if (!address) return "";
  if (typeof address === "string") return address.trim();
  if (Number.isFinite(address.lat) && Number.isFinite(address.lng)) return `${address.lat},${address.lng}`;
  return [address.street1, address.street2, address.city, address.state, address.zip].filter(Boolean).join(", ");
};

export const isApple = () => typeof navigator !== "undefined" && /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent || "");

// The directions URL for an address or { lat, lng }: Apple Maps on Apple
// devices (opens the app), Google Maps elsewhere.
export function directionsUrl(address, { apple = isApple() } = {}) {
  const dest = encodeURIComponent(q(address));
  return apple ? `maps://?daddr=${dest}` : `https://www.google.com/maps/dir/?api=1&destination=${dest}`;
}

// attrs for an <a> that opens directions outside the frame.
export const directionsLink = (address, opts) => openExternal(directionsUrl(address, opts));

// A route sketch: stops [{ lat, lng, label }] in drive order → html`<svg>`.
export function routeSketch(stops, { width = 320, height = 200, pad = 18 } = {}) {
  const pts = (stops || []).filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng));
  if (!pts.length) return html`<svg class="route" viewBox="${`0 0 ${width} ${height}`}" role="img" aria-label="No stops with a location"></svg>`;
  const lats = pts.map((p) => p.lat), lngs = pts.map((p) => p.lng);
  const [minLat, maxLat, minLng, maxLng] = [Math.min(...lats), Math.max(...lats), Math.min(...lngs), Math.max(...lngs)];
  const sx = (width - 2 * pad) / Math.max(1e-6, maxLng - minLng);
  const sy = (height - 2 * pad) / Math.max(1e-6, maxLat - minLat);
  const s = Math.min(sx, sy);
  const xy = (p) => [pad + (p.lng - minLng) * s + ((width - 2 * pad) - (maxLng - minLng) * s) / 2, height - pad - (p.lat - minLat) * s - ((height - 2 * pad) - (maxLat - minLat) * s) / 2];
  const coords = pts.map(xy).map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
  const path = coords.map(([x, y], i) => `${i ? "L" : "M"}${x} ${y}`).join(" ");
  return html`<svg class="route" viewBox="${`0 0 ${width} ${height}`}" role="img" aria-label="${`${pts.length} stops`}">
    <path d="${path}" fill="none" stroke="#fb4d3d" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="1 6"></path>
    ${coords.map(([x, y], i) => html`<g><circle cx="${x}" cy="${y}" r="11" fill="#16161b"></circle><text x="${x}" y="${y + 4}" text-anchor="middle" font-size="11" font-weight="700" fill="#fff">${i + 1}</text><title>${pts[i].label || ""}</title></g>`)}
  </svg>`;
}
