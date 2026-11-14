// The "on the way" page (/p/track/{code}; netlify/lib/crm/portal/track.mjs):
// while the tech is on the way it asks GET /api/portal/track/{code} every
// 30 seconds (60 without a live location) and redraws the ETA and the small
// map: the house in the middle, the tech's dot as an offset from it (the
// server sends no coordinates, only east and north metres, rounded). It
// stops asking once the visit has started, is done, or the live part ended.
// No inline script (the portal's CSP): everything is built with DOM calls.

const $ = (sel, root = document) => root.querySelector(sel);
const SVG = "http://www.w3.org/2000/svg";
const W = 320;
const H = 200;

function el(name, attrs = {}, parent) {
  const n = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  if (parent) parent.appendChild(n);
  return n;
}

// A round scale for the distance, so the dot sits inside the ring: 0.25 to 50 miles.
function scaleOf(m) {
  const miles = Math.max(m, 300) / 1609.344;
  const steps = [0.25, 0.5, 1, 1.5, 2, 3, 5, 10, 20, 50];
  return steps.find((s) => s >= miles) || steps[steps.length - 1];
}

function drawMap(box, east, north, dist, color) {
  box.textContent = "";
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, "aria-hidden": "true", focusable: "false" }, box);
  // a quiet map-like ground: blocks and two roads, so it reads as a map, not a chart
  el("rect", { x: 0, y: 0, width: W, height: H, fill: "#eef1f4" }, svg);
  for (let x = -20; x < W; x += 52) for (let y = -14; y < H; y += 44) el("rect", { x: x + 6, y: y + 6, width: 40, height: 32, rx: 6, fill: "#e3e8ee" }, svg);
  el("rect", { x: 0, y: H / 2 - 7, width: W, height: 14, fill: "#fff" }, svg);
  el("rect", { x: W / 2 - 7, y: 0, width: 14, height: H, fill: "#fff" }, svg);
  const miles = scaleOf(Math.max(dist || 0, Math.hypot(east, north)));
  const ringPx = 78;
  const k = ringPx / (miles * 1609.344);
  el("circle", { cx: W / 2, cy: H / 2, r: ringPx, fill: "none", stroke: "#b8c2cc", "stroke-width": 1.5, "stroke-dasharray": "4 5" }, svg);
  const label = el("text", { x: W / 2 + ringPx * 0.72 + 4, y: H / 2 - ringPx * 0.72, fill: "#5d6672", "font-size": 12, "font-family": "system-ui, sans-serif" }, svg);
  label.textContent = `${miles} mi`;
  // the house
  const hx = W / 2;
  const hy = H / 2;
  el("circle", { cx: hx, cy: hy, r: 15, fill: "#16161b" }, svg);
  el("path", { d: `M${hx - 7} ${hy + 1} L${hx} ${hy - 7} L${hx + 7} ${hy + 1} V${hy + 7} H${hx - 7} Z`, fill: "#fff" }, svg);
  // the tech: clamped inside the drawing
  const px = Math.max(14, Math.min(W - 14, hx + east * k));
  const py = Math.max(14, Math.min(H - 14, hy - north * k));
  el("circle", { cx: px, cy: py, r: 11, fill: color, class: "tk-pulse" }, svg);
  el("circle", { cx: px, cy: py, r: 9, fill: color, stroke: "#fff", "stroke-width": 3 }, svg);
}

function show(node, on) { if (node) node.hidden = !on; }
function text(node, value) { if (node) { node.textContent = value || ""; node.hidden = !value; } }

function paint(box, v) {
  box.setAttribute("data-tk-state", v.state);
  text($("[data-tk-headline]", box), v.headline);
  text($("[data-tk-sub]", box), v.sub || "");
  text($("[data-tk-window]", box), v.window_text);
  show($("[data-tk-live]", box), v.state === "on_the_way");
  const eta = v.eta || {};
  text($("[data-tk-eta]", box), eta.text || "");
  text($("[data-tk-at]", box), eta.at_text || "");
  text($("[data-tk-said]", box), eta.said || "");
  const map = $("[data-tk-map]", box);
  if (map) {
    if (v.map) { map.hidden = false; drawMap(map, v.map.east, v.map.north, v.map.distance_m, "#fb4d3d"); }
    else { map.hidden = true; map.textContent = ""; }
  }
  const cap = $("[data-tk-cap]", box);
  show(cap, eta.source === "live");
  const age = $("[data-tk-age]", box);
  if (age) age.textContent = v.map && v.map.age_s > 90 ? `Updated ${Math.round(v.map.age_s / 60)} min ago` : "Updated just now";
  document.title = v.headline;
}

async function poll(box, code) {
  let wait = Number(box.getAttribute("data-tk-refresh")) || 0;
  let misses = 0;
  while (wait > 0) {
    await new Promise((r) => setTimeout(r, wait * 1000));
    if (document.visibilityState === "hidden") { await new Promise((r) => document.addEventListener("visibilitychange", r, { once: true })); }
    try {
      const res = await fetch(`/api/portal/track/${encodeURIComponent(code)}`, { credentials: "same-origin", headers: { Accept: "application/json" }, cache: "no-store" });
      if (res.status === 404 || res.status === 410) { location.reload(); return; }
      const out = await res.json();
      if (!out || out.ok !== true) throw new Error("bad answer");
      misses = 0;
      paint(box, out.data);
      wait = Number(out.data.refresh_s) || 0;
    } catch (e) {
      misses += 1;
      wait = Math.min(120, 30 * (misses + 1));
    }
  }
}

function start() {
  const box = $("[data-track-code]");
  if (!box) return;
  const map = $("[data-tk-map]", box);
  if (map && !map.hidden && map.getAttribute("data-east") !== "") {
    drawMap(map, Number(map.getAttribute("data-east")), Number(map.getAttribute("data-north")), Number(map.getAttribute("data-dist")), "#fb4d3d");
  }
  poll(box, box.getAttribute("data-track-code"));
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
}
