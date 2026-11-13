// The interactive map the door-to-door and team maps share (docs/CRM-MAP.md
// "The map stack"): MapLibre GL JS, vendored in crm-app/vendor/maplibre-gl/
// (BSD-3-Clause, its CSP build: the worker is a file of ours, so the CSP
// stays worker-src 'self'), loaded only when a map screen opens. The street
// map and the aerial view come from the server (core/map-sources.mjs:
// OpenFreeMap and USGS by default, swappable by env), and the CSP lets the
// page reach exactly those hosts.
//
// createMap(el, { sources, center, zoom }) → a handle:
//   ready            a promise: the map drew its first style (or the blank one)
//   setAerial(on)    the aerial photos under the labels
//   setData(name, featureCollection)   one of LAYERS' sources
//   onTap(fn)        fn({ lng, lat, hit: { layer, props } | null })
//   flyTo([lng, lat], zoom?) · fit(bounds) · center() · zoom() · remove()
// With no signal (or a style that won't load) it falls back to a blank
// background: pins, areas and your position still draw; the streets come
// back with signal. Our own buttons and attribution: no map-library
// controls (they are 29 px; ours are 44).

const BASE = "/crm-app/vendor/maplibre-gl/";
export const LIB = { js: BASE + "maplibre-gl-csp.js", worker: BASE + "maplibre-gl-csp-worker.js", css: BASE + "maplibre-gl.css" };
export const BLANK_STYLE = Object.freeze({ version: 8, sources: {}, layers: [{ id: "mp-bg", type: "background", paint: { "background-color": "#eef0eb" } }] });
const HIT_PX = 22;   // half of a 44 px tap target around a pin

let libP = null;
export function loadLibrary() {
  if (typeof window === "undefined") return Promise.reject(new Error("No window"));
  if (window.maplibregl) return Promise.resolve(window.maplibregl);
  if (libP) return libP;
  libP = new Promise((resolve, reject) => {
    if (!document.querySelector(`link[href="${LIB.css}"]`)) {
      const l = document.createElement("link");
      l.rel = "stylesheet";
      l.href = LIB.css;
      document.head.appendChild(l);
    }
    const s = document.createElement("script");
    s.src = LIB.js;
    s.async = true;
    s.addEventListener("load", () => {
      if (!window.maplibregl) { libP = null; reject(new Error("The map didn't start on this phone.")); return; }
      try { window.maplibregl.setWorkerUrl(LIB.worker); } catch (e) { /* older build */ }
      resolve(window.maplibregl);
    });
    s.addEventListener("error", () => { libP = null; s.remove(); reject(new Error("The map needs signal the first time. Try again when you have some.")); });
    document.head.appendChild(s);
  });
  return libP;
}

// The canvas images our symbol layers use (drawn here: no sprite to fetch).
function house(fill, stroke, size = 30) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  const s = size / 24;
  g.scale(s, s);
  g.beginPath();
  g.moveTo(12, 2.5); g.lineTo(21.5, 10.5); g.lineTo(19, 10.5); g.lineTo(19, 21); g.lineTo(5, 21); g.lineTo(5, 10.5); g.lineTo(2.5, 10.5); g.closePath();
  g.fillStyle = fill; g.fill();
  g.lineWidth = 1.8; g.strokeStyle = stroke; g.lineJoin = "round"; g.stroke();
  g.fillStyle = stroke; g.fillRect(10, 14.5, 4, 6.5);
  const d = g.getImageData(0, 0, size, size);
  return { width: size, height: size, data: new Uint8Array(d.data.buffer) };
}

// Our sources and layers, drawn over whatever style is under them.
const LAYERS = {
  areas: [
    { id: "mp-areas-fill", type: "fill", paint: { "fill-color": ["get", "color"], "fill-opacity": ["case", ["==", ["get", "mine"], true], 0.16, 0.08] } },
    { id: "mp-areas-line", type: "line", filter: ["!=", ["get", "mine"], true], paint: { "line-color": ["get", "color"], "line-width": 2, "line-dasharray": [2, 1.5] } },
    { id: "mp-areas-mine", type: "line", filter: ["==", ["get", "mine"], true], paint: { "line-color": ["get", "color"], "line-width": 3.5 } },
  ],
  trails: [{ id: "mp-trails", type: "line", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": ["get", "color"], "line-width": 3, "line-opacity": 0.55 } }],
  routes: [{ id: "mp-routes", type: "line", layout: { "line-cap": "round" }, paint: { "line-color": ["get", "color"], "line-width": 2, "line-dasharray": [1, 2] } }],
  places: [{ id: "mp-places", type: "symbol", layout: { "icon-image": ["case", ["==", ["get", "k"], "lead"], "mp-lead", ["==", ["get", "k"], "former"], "mp-former", "mp-customer"], "icon-allow-overlap": true, "icon-ignore-placement": true, "icon-size": ["interpolate", ["linear"], ["zoom"], 11, 0.55, 16, 0.9, 19, 1.15] } }],
  stops: [{ id: "mp-stops", type: "circle", paint: { "circle-radius": 7, "circle-color": "#fff", "circle-stroke-color": ["get", "color"], "circle-stroke-width": 3 } }],
  pins: [
    { id: "mp-pins-due", type: "circle", filter: ["==", ["get", "due"], true], paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 7, 17, 15], "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": "#b7791f", "circle-stroke-width": 3 } },
    { id: "mp-pins", type: "circle", paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 3.5, 16, 8, 19, 11], "circle-color": ["get", "color"], "circle-stroke-color": ["case", ["==", ["get", "pending"], true], "#16161b", "#ffffff"], "circle-stroke-width": ["case", ["==", ["get", "pending"], true], 2.5, 2], "circle-opacity": ["case", ["==", ["get", "pending"], true], 0.6, 1] } },
  ],
  draw: [
    { id: "mp-draw-line", type: "line", paint: { "line-color": "#db3a29", "line-width": 3 } },
    { id: "mp-draw-pts", type: "circle", filter: ["==", ["geometry-type"], "Point"], paint: { "circle-radius": 7, "circle-color": "#fff", "circle-stroke-color": "#db3a29", "circle-stroke-width": 3 } },
  ],
  me: [
    { id: "mp-me-halo", type: "circle", paint: { "circle-radius": 18, "circle-color": "#2563eb", "circle-opacity": 0.16 } },
    { id: "mp-me", type: "circle", paint: { "circle-radius": 8, "circle-color": "#2563eb", "circle-stroke-color": "#fff", "circle-stroke-width": 3 } },
  ],
};
const ORDER = ["areas", "trails", "routes", "places", "stops", "pins", "draw", "me"];
const TAPPABLE = ["mp-pins", "mp-places", "mp-stops"];
export const empty = () => ({ type: "FeatureCollection", features: [] });

export async function createMap(el, { sources, center, zoom = 15, aerial = false } = {}) {
  const gl = await loadLibrary();
  const data = Object.fromEntries(ORDER.map((k) => [k, empty()]));
  const taps = [];
  const state = { aerial, blank: false, loaded: false };
  const online = typeof navigator === "undefined" || navigator.onLine !== false;
  const style = online && sources && sources.streets && sources.streets.style ? sources.streets.style : BLANK_STYLE;
  state.blank = style === BLANK_STYLE;
  let map;
  try {
    map = new gl.Map({
      container: el, style, center: [center.lng, center.lat], zoom, maxZoom: 19.5, minZoom: 6,
      attributionControl: false, dragRotate: false, pitchWithRotate: false, touchPitch: false, renderWorldCopies: false, fadeDuration: 0,
    });
  } catch (e) {
    throw new Error("This phone can't draw the map (WebGL is off).");
  }
  try { map.touchZoomRotate.disableRotation(); } catch (e) { /* fine */ }
  // an error from a tile or the style never reaches the console as an error of ours
  map.on("error", (e) => { if (!state.loaded && !state.blank) toBlank(); });

  const firstSymbol = () => { const l = (map.getStyle().layers || []).find((x) => x.type === "symbol"); return l ? l.id : undefined; };
  function addOurs() {
    for (const [name, fill, stroke] of [["mp-customer", "#13a165", "#ffffff"], ["mp-lead", "#ffffff", "#2563eb"], ["mp-former", "#c9c9cf", "#ffffff"]]) {
      if (!map.hasImage(name)) { try { map.addImage(name, house(fill, stroke), { pixelRatio: 1.25 }); } catch (e) { /* no canvas: circles still draw */ } }
    }
    if (sources && sources.aerial && !map.getSource("mp-aerial")) {
      map.addSource("mp-aerial", { type: "raster", tiles: [sources.aerial.tiles], tileSize: 256, maxzoom: sources.aerial.maxzoom || 16 });
      map.addLayer({ id: "mp-aerial", type: "raster", source: "mp-aerial", layout: { visibility: state.aerial ? "visible" : "none" } }, firstSymbol());
    }
    for (const k of ORDER) {
      if (!map.getSource("mp-" + k)) map.addSource("mp-" + k, { type: "geojson", data: data[k] });
      for (const l of LAYERS[k]) if (!map.getLayer(l.id)) map.addLayer({ ...l, source: "mp-" + k });
    }
  }
  let resolveReady;
  const ready = new Promise((r) => { resolveReady = r; });
  map.on("style.load", () => { state.loaded = true; addOurs(); resolveReady(); });
  function toBlank() {
    if (state.blank) return;
    state.blank = true;
    try { map.setStyle(BLANK_STYLE); } catch (e) { /* removed */ }
  }
  // a style that never answers (a slow line): the blank one after 9 s
  const slow = setTimeout(() => { if (!state.loaded) toBlank(); }, 9000);

  map.on("click", (e) => {
    const { x, y } = e.point;
    let hit = null;
    try {
      const layers = TAPPABLE.filter((id) => map.getLayer(id));
      const feats = layers.length ? map.queryRenderedFeatures([[x - HIT_PX, y - HIT_PX], [x + HIT_PX, y + HIT_PX]], { layers }) : [];
      if (feats.length) {
        // the nearest feature to the finger
        const near = feats.map((f) => { const c = f.geometry.coordinates; const p = map.project(c); return { f, d: (p.x - x) ** 2 + (p.y - y) ** 2 }; }).sort((a, b) => a.d - b.d)[0].f;
        hit = { layer: near.layer.id, props: near.properties, at: near.geometry.coordinates };
      }
    } catch (err) { hit = null; }
    for (const fn of taps) { try { fn({ lng: e.lngLat.lng, lat: e.lngLat.lat, hit }); } catch (err) { /* a handler failed */ } }
  });

  const handle = {
    map, ready, state,
    get isBlank() { return state.blank; },
    setAerial(on) {
      state.aerial = !!on;
      if (map.getLayer("mp-aerial")) map.setLayoutProperty("mp-aerial", "visibility", state.aerial ? "visible" : "none");
    },
    setData(name, fc) {
      data[name] = fc || empty();
      const s = map.getSource("mp-" + name);
      if (s) s.setData(data[name]);
    },
    onTap(fn) { taps.push(fn); },
    flyTo(lngLat, z) { map.easeTo({ center: lngLat, ...(z ? { zoom: z } : {}), duration: 600 }); },
    jumpTo(lngLat, z) { map.jumpTo({ center: lngLat, ...(z ? { zoom: z } : {}) }); },
    fit(bounds, maxZoom = 17) { if (bounds) map.fitBounds(bounds, { padding: 60, maxZoom, duration: 500 }); },
    center() { const c = map.getCenter(); return { lng: c.lng, lat: c.lat }; },
    zoom() { return map.getZoom(); },
    resize() { try { map.resize(); } catch (e) { /* gone */ } },
    // an element of ours pinned to a place (the team map's people): → { move([lng, lat]), remove() }
    marker(element, lngLat) {
      const m = new gl.Marker({ element, anchor: "center" }).setLngLat(lngLat).addTo(map);
      return { move: (ll) => m.setLngLat(ll), remove: () => m.remove() };
    },
    remove() { clearTimeout(slow); try { map.remove(); } catch (e) { /* gone */ } },
  };
  return handle;
}

// A GeoJSON point / line / polygon feature.
export const point = (lng, lat, props = {}) => ({ type: "Feature", geometry: { type: "Point", coordinates: [lng, lat] }, properties: props });
export const line = (coords, props = {}) => ({ type: "Feature", geometry: { type: "LineString", coordinates: coords }, properties: props });
export const polygon = (ring, props = {}) => ({ type: "Feature", geometry: { type: "Polygon", coordinates: [[...ring, ring[0]]] }, properties: props });
export const collection = (features) => ({ type: "FeatureCollection", features: features.filter(Boolean) });

// The map's credits: the providers' own words, from the server's config (never from a style's HTML).
export function credits(sources, { aerial = false } = {}) {
  const out = [];
  if (sources && sources.streets) out.push(sources.streets.attribution);
  if (aerial && sources && sources.aerial) out.push(sources.aerial.attribution);
  out.push("Map: MapLibre");
  return out.join(" · ");
}

// Where the phone is: one reading (→ { lat, lng, acc } | null) or a watch (→ stop()).
export function locateOnce({ timeout = 8000 } = {}) {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return resolve(null);
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve(null); } }, timeout + 500);
    navigator.geolocation.getCurrentPosition(
      (p) => { if (done) return; done = true; clearTimeout(t); resolve({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }); },
      (e) => { if (done) return; done = true; clearTimeout(t); resolve(e && e.code === 1 ? { denied: true } : null); },
      { enableHighAccuracy: true, timeout, maximumAge: 15000 },
    );
  });
}
export function watchPosition(onPos, onDenied) {
  if (typeof navigator === "undefined" || !navigator.geolocation) { if (onDenied) onDenied(); return () => {}; }
  const id = navigator.geolocation.watchPosition(
    (p) => onPos({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
    (e) => { if (e && e.code === 1 && onDenied) onDenied(); },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
  );
  return () => { try { navigator.geolocation.clearWatch(id); } catch (e) { /* gone */ } };
}

// The screen stays on while knocking (the Wake Lock API; Safari 16.4+).
export function keepAwake() {
  let lock = null;
  let on = true;
  const take = async () => { try { if (on && navigator.wakeLock && document.visibilityState === "visible") lock = await navigator.wakeLock.request("screen"); } catch (e) { lock = null; } };
  const again = () => { if (document.visibilityState === "visible") take(); };
  document.addEventListener("visibilitychange", again);
  take();
  return {
    get supported() { return typeof navigator !== "undefined" && !!navigator.wakeLock; },
    release() { on = false; document.removeEventListener("visibilitychange", again); try { if (lock) lock.release(); } catch (e) { /* gone */ } lock = null; },
  };
}
