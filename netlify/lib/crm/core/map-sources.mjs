// Barta CRM core: where the interactive maps come from (docs/CRM-MAP.md).
//
// One config picks the street map and the aerial view, and the CRM pages'
// CSP (core/http.mjs) allows exactly those hosts in connect-src, nothing
// more. The map library itself (MapLibre GL JS, BSD-3-Clause) is vendored
// in crm-app/vendor/maplibre-gl/ and served from the site.
//
//   CRM_MAP_STREETS       openfreemap (default: no key, no sign-up, free
//                         for commercial use; © OpenStreetMap contributors)
//                         | maptiler (needs CRM_MAP_STREETS_KEY)
//   CRM_MAP_AERIAL        usgs (default: USGS The National Map orthoimagery,
//                         U.S. public domain, no key) | esri (World Imagery,
//                         sharper; needs CRM_MAP_AERIAL_KEY from an ArcGIS
//                         Location Platform account) | off
//   CRM_MAP_STREETS_KEY / CRM_MAP_AERIAL_KEY
//                         the provider's browser key. A tile key travels to
//                         the browser by design: restrict it to the site's
//                         address in the provider's console.
//
// A keyed provider without its key falls back to the default, so a typo
// in Netlify never leaves the map blank. What the browser sends these
// hosts: tile, style and font requests (map coordinates and zoom), never
// a customer's name or address.

export const STREETS = Object.freeze({
  openfreemap: Object.freeze({
    label: "OpenFreeMap",
    style: "https://tiles.openfreemap.org/styles/liberty",
    hosts: Object.freeze(["https://tiles.openfreemap.org"]),
    attribution: "OpenFreeMap © OpenMapTiles Data from OpenStreetMap",
    key: false,
  }),
  maptiler: Object.freeze({
    label: "MapTiler",
    style: "https://api.maptiler.com/maps/streets-v2/style.json?key={key}",
    hosts: Object.freeze(["https://api.maptiler.com"]),
    attribution: "© MapTiler © OpenStreetMap contributors",
    key: true,
  }),
});

export const AERIAL = Object.freeze({
  usgs: Object.freeze({
    label: "USGS aerial",
    tiles: "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}",
    maxzoom: 16,
    hosts: Object.freeze(["https://basemap.nationalmap.gov"]),
    attribution: "Aerial: USGS The National Map, USDA NAIP",
    key: false,
  }),
  esri: Object.freeze({
    label: "Esri World Imagery",
    tiles: "https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?token={key}",
    maxzoom: 19,
    hosts: Object.freeze(["https://ibasemaps-api.arcgis.com"]),
    attribution: "Aerial: Esri, Maxar, Earthstar Geographics",
    key: true,
  }),
});

export const DEFAULT_STREETS = "openfreemap";
export const DEFAULT_AERIAL = "usgs";
const KEY_RE = /^[A-Za-z0-9._-]{8,300}$/;

const pick = (table, want, def, key) => {
  const name = Object.hasOwn(table, want) ? want : def;
  const p = table[name];
  if (p.key && !(typeof key === "string" && KEY_RE.test(key))) return { name: def, p: table[def], waiting: name };
  return { name, p };
};

// → { streets: { name, label, style, attribution, waiting_for_key? },
//     aerial: { name, label, tiles, maxzoom, attribution, ... } | null,
//     hosts: [origin, ...] }  (what the browser may reach, sorted as listed)
export function mapSources(env = process.env) {
  const e = env || {};
  const s = pick(STREETS, String(e.CRM_MAP_STREETS || DEFAULT_STREETS).toLowerCase(), DEFAULT_STREETS, e.CRM_MAP_STREETS_KEY);
  const wantAerial = String(e.CRM_MAP_AERIAL || DEFAULT_AERIAL).toLowerCase();
  const a = wantAerial === "off" ? null : pick(AERIAL, wantAerial, DEFAULT_AERIAL, e.CRM_MAP_AERIAL_KEY);
  const fill = (u, k) => String(u).replace("{key}", encodeURIComponent(k || ""));
  const streets = { name: s.name, label: s.p.label, style: fill(s.p.style, e.CRM_MAP_STREETS_KEY), attribution: s.p.attribution, ...(s.waiting ? { waiting_for_key: s.waiting } : {}) };
  const aerial = a ? { name: a.name, label: a.p.label, tiles: fill(a.p.tiles, e.CRM_MAP_AERIAL_KEY), maxzoom: a.p.maxzoom, attribution: a.p.attribution, ...(a.waiting ? { waiting_for_key: a.waiting } : {}) } : null;
  const hosts = [...new Set([...s.p.hosts, ...(a ? a.p.hosts : [])])];
  return { streets, aerial, hosts };
}

// The origins the CRM pages may connect to for maps (the CSP).
export const mapHosts = (env = process.env) => mapSources(env).hosts;
