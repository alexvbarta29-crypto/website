// Pieces the map screens share (docs/CRM-MAP.md): the stylesheet, the pin
// type words and colors, geometry (the same point-in-polygon as the
// server's geo.mjs; a test checks they agree), a few icons, and what the
// phone's outbox holds for the knock map (pins dropped with no signal). No
// data here, only how things work (design §2.3).

import { raw, html } from "../../core/ui.js";

let styled = false;
export function ensureStyles() {
  if (styled || typeof document === "undefined") return;
  styled = true;
  const href = "/crm-app/modules/map/map.css";
  if (document.querySelector(`link[href="${href}"]`)) return;
  const l = document.createElement("link");
  l.rel = "stylesheet";
  l.href = href;
  document.head.appendChild(l);
}

const svg = (d) => raw(`<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${d}</svg>`);
export const MICONS = {
  locate: svg('<circle cx="12" cy="12" r="3.5"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3"/><circle cx="12" cy="12" r="7.5"/>'),
  pin: svg('<path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.4"/>'),
  layers: svg('<path d="m12 4 8.5 4.5L12 13 3.5 8.5z"/><path d="m3.5 12.5 8.5 4.5 8.5-4.5M3.5 16.5 12 21l8.5-4.5"/>'),
  walk: svg('<circle cx="13" cy="4.5" r="1.8"/><path d="M10 21l2-6-2.5-2.5L11 8l3 1.5 2 3.5M9.5 12.5 7 14M14 15l2 6"/>'),
  stop: svg('<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>'),
  draw: svg('<path d="M4 18 9 6l6 9 5-7"/><circle cx="4" cy="18" r="1.6"/><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="15" r="1.6"/><circle cx="20" cy="8" r="1.6"/>'),
  undo: svg('<path d="M9 7 4.5 11.5 9 16"/><path d="M5 11.5h9a5 5 0 0 1 0 10h-2"/>'),
  info: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.5v.01"/>'),
  door: svg('<rect x="6" y="3.5" width="12" height="17" rx="1.5"/><circle cx="14.5" cy="12.5" r="1"/>'),
  arrow: svg('<path d="M20 4 4.5 10.8l6.8 1.9 1.9 6.8z"/>'),
  filter: svg('<path d="M4 5h16l-6.2 7.6V19l-3.6-1.8v-4.6z"/>'),
  satellite: svg('<path d="m8.5 8.5 3 3M12.5 4.5l7 7-2 2-7-7zM4.5 12.5l7 7 2-2-7-7z"/><path d="M15.5 15.5c1 1 1 2.6 0 3.6M18.5 13c2.2 2.2 2.2 5.4 0 7"/>'),
  people: svg('<circle cx="9" cy="9" r="3"/><path d="M3.5 19c.6-3 2.8-4.6 5.5-4.6s4.9 1.6 5.5 4.6"/><circle cx="17" cy="9.5" r="2.4"/><path d="M15.5 14.6c2.6-.3 4.4 1.2 5 4.4"/>'),
};

// ------------------------------------------------------------ pin types

export const OUTCOME_LABELS = {
  not_home: "No answer", talked: "Talked (come back)", interested: "Interested", not_interested: "Not interested", booked: "Booked", skip: "Don't knock",
};
export const OUTCOMES = Object.keys(OUTCOME_LABELS);
export const CONVERSATIONS = new Set(["talked", "interested", "not_interested", "booked"]);
export const typeMap = (types) => new Map((types || []).map((t) => [t.key, t]));
export const colorOf = (types, key) => (typeMap(types).get(key) || {}).color || "#808080";
export const labelOf = (types, key, fallback = "Pin") => (typeMap(types).get(key) || {}).label || fallback;
// Text on a color: white unless the color is light.
export function inkOn(hex) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})/i.exec(String(hex || ""));
  if (!m) return "#fff";
  const h = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.179 ? "#16161b" : "#fff";
}
export const swatch = (color) => html`<span class="mp-sw" style="${"background:" + (/^#[0-9a-f]{3,8}$/i.test(color || "") ? color : "#808080")}" aria-hidden="true"></span>`;

// ------------------------------------------------------------ geometry

// [lng, lat] inside [[lng, lat], ...] (on an edge counts): the server's geo.mjs, the same rule.
export function pointInPolygon(pt, poly) {
  if (!Array.isArray(pt) || !Array.isArray(poly) || poly.length < 3) return false;
  const [x, y] = pt;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const EPS = 1e-12;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    const cross = (x - xi) * (yj - yi) - (y - yi) * (xj - xi);
    if (Math.abs(cross) < EPS && x >= Math.min(xi, xj) - EPS && x <= Math.max(xi, xj) + EPS && y >= Math.min(yi, yj) - EPS && y <= Math.max(yi, yj) + EPS) return true;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export function bboxOf(points) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of points || []) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
  return Number.isFinite(w) ? [[w, s], [e, n]] : null;
}

// ------------------------------------------------------------ words

export function freshness(ageS) {
  if (!Number.isFinite(ageS)) return "";
  if (ageS < 60) return "just now";
  const m = Math.round(ageS / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} h ${String(m % 60).padStart(2, "0")} m ago` : "yesterday or earlier";
}
export const staleness = (ageS, everyS = 120) => (!Number.isFinite(ageS) ? "none" : ageS <= everyS * 2.5 ? "fresh" : ageS <= 30 * 60 ? "late" : "old");
export const addressLine = (a) => (a ? [a.street1, [a.city, a.state].filter(Boolean).join(", "), a.zip].filter(Boolean).join(" ").replace(/ ,/g, ",") : "");
export const deviceToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());

// ------------------------------------------------------------ the phone's outbox

// Pins waiting on this phone (outbox items) laid over the server's: new
// pins (POST /map/pins) as pending dots, changes (PATCH /map/pins/:id) on
// their pin. items: outbox items; pins: the server's rows ({ id, la, ln, t, ... }).
export function overlayPins(pins, items, me) {
  const out = (pins || []).map((p) => ({ ...p }));
  const byId = new Map(out.map((p) => [p.id, p]));
  for (const i of items || []) {
    if (!i || !i.body || i.refused) continue;
    if (i.method === "POST" && i.path === "/map/pins" && Number.isFinite(i.body.lat) && Number.isFinite(i.body.lng)) {
      out.push({ id: "wait-" + i.body.client_id, la: i.body.lat, ln: i.body.lng, t: i.body.type_key, c: me, pending: true, d: deviceToday(), n: 1, ...(i.body.follow_up_on ? { fu: i.body.follow_up_on } : {}) });
      continue;
    }
    const m = /^\/map\/pins\/([^/]+)$/.exec(i.path || "");
    if (i.method === "PATCH" && m && byId.has(m[1])) {
      const p = byId.get(m[1]);
      if (i.body.type_key) p.t = i.body.type_key;
      if (i.body.follow_up_on !== undefined) { if (i.body.follow_up_on) p.fu = i.body.follow_up_on; else delete p.fu; }
      p.pending = true;
    }
  }
  return out;
}
