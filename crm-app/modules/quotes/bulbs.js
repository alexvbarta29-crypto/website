// The lights mockup's drawing (the owner, Nov 16: an automatic mockup of the
// customer's house for a Christmas lights quote). Ported from Barta Light
// Studio (netlify/lib/lights-page.mjs, "10-lights.js"): the same C9 bulbs
// with their socket and dark green wire, the same glow, light spill on the
// trim and night look, the same colors and spacing, so a mockup made here
// and one finished in Light Studio match. Plus the fallback when Claude
// can't mark the house: a small edge finder (detectRoofline) that looks for
// the strongest level edge and the two roof slopes over it.
//
// Pure functions (bulb placement, the edge finder) run in node for the
// tests; renderMockup() needs a canvas (the browser).

export const COLORS = Object.freeze({
  warm: "#ffc988", cool: "#e4edff", pure: "#d4ecf5", red: "#ff2a1e", green: "#1fe060", blue: "#2e63ff", gold: "#ffb11a", orange: "#ff6a12",
});
// The chips on the mockup sheet (Light Studio's palettes of the same names).
export const PALETTES = Object.freeze([
  { id: "warm", name: "Warm white", colors: ["warm"] },
  { id: "pure", name: "Pure white", colors: ["pure"] },
  { id: "multi", name: "Multicolor", colors: ["red", "green", "blue", "gold", "orange"] },
]);
export const SIZES = Object.freeze([{ id: "s", name: "Small", k: 0.8 }, { id: "m", name: "Medium", k: 1 }, { id: "l", name: "Large", k: 1.3 }]);
export const C9 = Object.freeze({ round: 1.3, glow: 5.2, size: 1.55, spacing: 11 });
const WIRE = "#1f3a20";
const MINI = { bush: { size: 0.36, gap: 0.42 }, tree: { size: 0.4, gap: 0.5 } };
const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const dist = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);

export const paletteColors = (id) => (PALETTES.find((p) => p.id === id) || PALETTES[0]).colors;

// ------------------------------------------------------------ placement (pure)

// One straight run of C9 bulbs from a to b; skipA / skipB leave out an end
// bulb another run already has (corners, peaks). The bulbs stand upright
// on the wire, as clipped on a gutter (their light falls on the house).
export function genLine(o) {
  const a = o.a, b = o.b;
  const L = dist(a[0], a[1], b[0], b[1]);
  const lights = [], sockets = [];
  const r = Math.max(0.3, o.size);
  if (L < 0.5) return { lights, sockets, r };
  const tx = (b[0] - a[0]) / L, ty = (b[1] - a[1]) / L;
  let nx = ty, ny = -tx;
  if (ny > 0.0001 || (Math.abs(ny) <= 0.0001 && nx > 0)) { nx = -nx; ny = -ny; }
  const spacing = Math.max(1.5, o.spacing);
  const seq = o.colors && o.colors.length ? o.colors : ["warm"];
  const n = Math.max(1, Math.round(L / spacing));
  const h = r * C9.round;
  const off = h * 0.92;
  for (let i = 0; i <= n; i++) {
    if ((i === 0 && o.skipA) || (i === n && o.skipB && n > 0)) continue;
    const d = (i * L) / n;
    const x = a[0] + tx * d, y = a[1] + ty * d;
    const hex = COLORS[seq[(i + (o.offset || 0)) % seq.length]] || COLORS.warm;
    lights.push({ x: x + nx * off, y: y + ny * off, r, h, ang: Math.atan2(ny, nx), hex, sr: Math.max(spacing * 1.8, r * 10) });
    sockets.push(x, y, nx, ny);
  }
  return { lights, sockets, r };
}

function seeded(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
function hashPts(pts) {
  let h = 2166136261;
  for (const p of pts) { h = Math.imul(h ^ Math.round(p[0] * 10), 16777619); h = Math.imul(h ^ Math.round(p[1] * 10), 16777619); }
  return h >>> 0;
}
export function inPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
// Bushes and trees: mini lights spread evenly over the traced area, like net lights.
export function genFill(o) {
  const m = MINI[o.kind] || MINI.bush;
  const pts = o.pts || [];
  if (pts.length < 3) return [];
  const r = Math.max(0.25, o.size * m.size);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
  let gap = Math.max(1.2, o.spacing * m.gap);
  const area = (x1 - x0) * (y1 - y0);
  if (area / (gap * gap * 0.866) > 6000) gap = Math.sqrt(area / (6000 * 0.866));
  const seq = o.colors && o.colors.length ? o.colors : ["warm"];
  const rand = seeded(hashPts(pts));
  const out = [];
  const dy = gap * 0.866;
  let row = 0;
  for (let y = y0 + dy / 2; y < y1; y += dy, row++) {
    for (let x = x0 + (row % 2 ? gap / 2 : 0); x < x1; x += gap) {
      const jx = x + (rand() - 0.5) * gap * 0.6, jy = y + (rand() - 0.5) * dy * 0.6;
      const pick = rand();
      if (!inPoly(jx, jy, pts)) continue;
      out.push({ x: jx, y: jy, r, h: r, ang: -Math.PI / 2, hex: COLORS[seq[Math.floor(pick * seq.length) % seq.length]] || COLORS.warm, sr: Math.max(gap * 1.7, r * 9) });
    }
  }
  return out;
}

// The marked lines → drawable runs (Light Studio's runs()): each roof
// polyline becomes straight runs, a corner or peak shared by two runs gets
// one bulb. w, h: the photo's size; size: the bulb size (1 = Light Studio's
// default); palette: a PALETTES id.
export function runsOf(lines, { w, h, size = 1, palette = "warm" } = {}) {
  const u = Math.hypot(w, h) / 1000;
  const colors = paletteColors(palette);
  const bulb = C9.size * u * size, spacing = C9.spacing * u * size;
  const seen = [];
  const used = (p) => seen.some((q) => Math.abs(q[0] - p[0]) < 0.75 && Math.abs(q[1] - p[1]) < 0.75);
  const out = [];
  for (const l of lines || []) {
    const pts = (l.points || []).filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (l.kind === "bush" || l.kind === "tree") {
      if (pts.length >= 3) out.push({ kind: l.kind, pts, size: bulb, spacing, colors });
      continue;
    }
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      out.push({ a, b, size: bulb, spacing, colors, skipA: used(a), skipB: used(b) });
      seen.push(a, b);
    }
  }
  return out;
}

const genShape = (o) => (o.kind === "bush" || o.kind === "tree" ? { lights: genFill(o), sockets: [] } : genLine(o));

// Every bulb of a mockup, in photo pixels. → [{ x, y, r, hex, ... }]
export function placeBulbs(lines, opts) {
  return runsOf(lines, opts).flatMap((r) => genShape(r).lights);
}

// ------------------------------------------------------------ the edge finder (pure)

// RGBA pixels → gray (0-255) in a Float32Array.
export function toGray(rgba, w, h) {
  const g = new Float32Array(w * h);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = rgba[j] * 0.299 + rgba[j + 1] * 0.587 + rgba[j + 2] * 0.114;
  return g;
}

// The fallback when Claude can't mark the house: Sobel edges in the upper
// 85% of the photo, a Hough vote for the strongest near-level edge in the
// upper 72% (the eave) and the strongest rising and falling slopes above it (the gable).
// gray: Float32Array (w × h). → { lines, score } or null when too weak to
// trust (then Light Studio opens with the photo, so the owner draws them).
export function detectRoofline(gray, w, h) {
  if (!gray || w < 32 || h < 32) return null;
  const H = Math.floor(h * 0.85);
  const mag = new Float32Array(w * h), gxA = new Float32Array(w * h), gyA = new Float32Array(w * h);
  let sum = 0, sum2 = 0, n = 0;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const tl = gray[i - w - 1], t = gray[i - w], tr = gray[i - w + 1], l = gray[i - 1], r = gray[i + 1], bl = gray[i + w - 1], b = gray[i + w], br = gray[i + w + 1];
      const gx = tr + 2 * r + br - tl - 2 * l - bl;
      const gy = bl + 2 * b + br - tl - 2 * t - tr;
      const m = Math.hypot(gx, gy);
      mag[i] = m; gxA[i] = gx; gyA[i] = gy;
      sum += m; sum2 += m * m; n += 1;
    }
  }
  if (!n) return null;
  const mean = sum / n, sd = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
  const thr = Math.max(60, mean + 1.5 * sd);
  const edges = [];
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; if (mag[i] >= thr) edges.push(i); }
  if (edges.length < w * 0.2) return null;
  // best line of one family: angles in degrees (image y down; negative rises to the right)
  const best = (angles, keep) => {
    let top = null;
    for (const deg of angles) {
      const a = (deg * Math.PI) / 180, tan = Math.tan(a), dx = Math.cos(a), dy = Math.sin(a);
      const votes = new Map();
      for (const i of edges) {
        const x = i % w, y = (i - x) / w;
        if (keep && !keep(x, y)) continue;
        const m = mag[i];
        // the gradient must cross the line, not run along it
        if (Math.abs((gxA[i] * dx + gyA[i] * dy) / m) > 0.45) continue;
        const c = Math.round(y - x * tan);
        votes.set(c, (votes.get(c) || 0) + m);
      }
      for (const [c, v] of votes) {
        const s = v + (votes.get(c - 1) || 0) * 0.5 + (votes.get(c + 1) || 0) * 0.5;
        if (!top || s > top.v) top = { deg, tan, c, v: s };
      }
    }
    return top;
  };
  // the longest stretch of a line with edges under it (gaps up to 6% of the width)
  const extent = (line, x0 = 1, x1 = w - 2, keep) => {
    const gapMax = Math.max(4, Math.round(w * 0.06));
    let runStart = -1, lastHit = -1, bestRun = null, hits = 0, runHits = 0;
    for (let x = x0; x <= x1; x++) {
      const yc = line.c + x * line.tan;
      let hit = false;
      for (let d = -2; d <= 2 && !hit; d++) {
        const y = Math.round(yc) + d;
        if (y < 1 || y >= H - 1 || (keep && !keep(x, y))) continue;
        if (mag[y * w + x] >= thr) hit = true;
      }
      if (hit) {
        if (runStart < 0 || x - lastHit > gapMax) { runStart = x; runHits = 0; }
        lastHit = x; runHits += 1; hits += 1;
        if (!bestRun || x - runStart > bestRun.b - bestRun.a) bestRun = { a: runStart, b: x, hits: runHits };
      }
    }
    if (!bestRun) return null;
    const span = bestRun.b - bestRun.a + 1;
    return { a: bestRun.a, b: bestRun.b, support: bestRun.hits / span, hits };
  };
  const range = (from, to, step = 1) => { const out = []; for (let d = from; d <= to + 1e-9; d += step) out.push(d); return out; };
  // the eave sits in the upper 72% (lower down: the lawn, the curb, the street)
  const upper = (x, y) => y < h * 0.72;
  const eave = best(range(-8, 8), upper);
  if (!eave) return null;
  const ex = extent(eave, 1, w - 2, upper);
  if (!ex || (ex.b - ex.a) < w * 0.25 || ex.support < 0.45) return null;
  const yAt = (line, x) => line.c + x * line.tan;
  const P = (x, y) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
  const lines = [{ kind: "eave", points: [P(ex.a, yAt(eave, ex.a)), P(ex.b, yAt(eave, ex.b))] }];
  let score = ex.support * ((ex.b - ex.a) / w);
  // the gable over it: a rising and a falling slope between the eave's ends, meeting above it
  const yE = Math.min(yAt(eave, ex.a), yAt(eave, ex.b));
  const above = (x, y) => x >= ex.a && x <= ex.b && y < yE - 3;
  const left = best(range(-50, -15), above), right = best(range(15, 50), above);
  if (left && right) {
    const px = (right.c - left.c) / (left.tan - right.tan);
    const py = yAt(left, px);
    const xl = clamp((yE - left.c) / left.tan, ex.a, ex.b), xr = clamp((yE - right.c) / right.tan, ex.a, ex.b);
    const lx = extent(left, Math.round(Math.min(xl, px)), Math.round(Math.max(xl, px)), above);
    const rx = extent(right, Math.round(Math.min(xr, px)), Math.round(Math.max(xr, px)), above);
    const tall = yE - py;
    if (px > xl && px < xr && tall > h * 0.05 && lx && rx && lx.support > 0.35 && rx.support > 0.35) {
      lines.push({ kind: "rake", points: [P(xl, yAt(eave, xl)), P(px, py), P(xr, yAt(eave, xr))] });
      score += 0.25 * (lx.support + rx.support);
    }
  }
  return { lines, score: Math.round(score * 1000) / 1000 };
}

// ------------------------------------------------------------ drawing (canvas)

const sprites = new Map();
function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
  return c;
}
const hexToRgb = (hex) => { const v = parseInt(hex.slice(1), 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; };
const rgbToHex = (rgb) => "#" + rgb.map((x) => clamp(Math.round(x), 0, 255).toString(16).padStart(2, "0")).join("");
const mixHex = (a, b, t) => { const A = hexToRgb(a), B = hexToRgb(b); return rgbToHex(A.map((x, i) => x + (B[i] - x) * t)); };
const reset = (ctx) => { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over"; ctx.filter = "none"; };

function glowSprite(hex) {
  const key = "g" + hex;
  if (sprites.has(key)) return sprites.get(key);
  const s = makeCanvas(128, 128), c = s.getContext("2d");
  const [r, g, b] = hexToRgb(hex);
  const gr = c.createRadialGradient(64, 64, 0, 64, 64, 64);
  for (const [t, al] of [[0, 1], [0.05, 0.92], [0.1, 0.62], [0.18, 0.32], [0.3, 0.14], [0.46, 0.055], [0.7, 0.016], [1, 0]]) gr.addColorStop(t, `rgba(${r},${g},${b},${al})`);
  c.fillStyle = gr; c.fillRect(0, 0, 128, 128);
  sprites.set(key, s);
  return s;
}
function spillSprite(hex) {
  const key = "s" + hex;
  if (sprites.has(key)) return sprites.get(key);
  const cy = 40, R = 88;
  const cv = makeCanvas(128, 128), c = cv.getContext("2d");
  const [r, g, b] = hexToRgb(hex);
  const gr = c.createRadialGradient(64, cy, 0, 64, cy, R);
  for (const [t, al] of [[0, 0.95], [0.2, 0.62], [0.42, 0.3], [0.68, 0.08], [1, 0]]) gr.addColorStop(t, `rgba(${r},${g},${b},${al})`);
  c.fillStyle = gr; c.fillRect(0, 0, 128, 128);
  c.globalCompositeOperation = "destination-in";
  const lg = c.createLinearGradient(0, cy - 44, 0, cy + 6);
  lg.addColorStop(0, "rgba(0,0,0,0)"); lg.addColorStop(1, "rgba(0,0,0,1)");
  c.fillStyle = lg; c.fillRect(0, 0, 128, 128);
  const s = { cv, cx: 64, cy, R };
  sprites.set(key, s);
  return s;
}
function bulbSprite(hex) {
  const key = "b" + hex;
  if (sprites.has(key)) return sprites.get(key);
  const core = mixHex(hex, "#ffffff", 0.9), mid = mixHex(hex, "#ffffff", 0.5), edge = mixHex(hex, "#000000", 0.18);
  const s = makeCanvas(64, 64), c = s.getContext("2d");
  c.beginPath(); c.arc(32, 32, 31, 0, TAU);
  const g = c.createRadialGradient(32, 32, 0, 32, 32, 31);
  g.addColorStop(0, core); g.addColorStop(0.36, mid); g.addColorStop(0.74, hex); g.addColorStop(1, edge);
  c.fillStyle = g; c.fill();
  c.globalAlpha = 0.35; c.fillStyle = "#ffffff";
  c.beginPath(); c.ellipse(22, 21, 5.5, 8, -0.7, 0, TAU); c.fill();
  sprites.set(key, s);
  return s;
}
const coreHex = (hex) => mixHex(hex, "#ffffff", 0.6);

// Dusk: less color, a blue-grey multiply, the sky darker at the top.
function applyNight(ctx, W, H, n) {
  reset(ctx);
  if (n <= 0.001) return;
  ctx.globalCompositeOperation = "saturation"; ctx.globalAlpha = 0.5 * n; ctx.fillStyle = "#808080"; ctx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = "multiply"; ctx.globalAlpha = 1; ctx.fillStyle = mixHex("#ffffff", "#28324f", Math.pow(n, 0.85) * 0.95); ctx.fillRect(0, 0, W, H);
  const g = ctx.createLinearGradient(0, 0, 0, H * 0.72);
  g.addColorStop(0, `rgba(8,11,26,${0.6 * n})`); g.addColorStop(1, "rgba(8,11,26,0)");
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  reset(ctx);
}

// The photo with its lights into `out` (a canvas at `scale` × the photo's
// size). o: { photo (image or canvas), w, h, lines, size, palette, night }.
// → the number of bulbs drawn.
export function renderMockup(out, o) {
  const scale = out.width / o.w;
  const W = out.width, H = out.height;
  const ctx = out.getContext("2d");
  reset(ctx);
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(o.photo, 0, 0, W, H);
  const runs = runsOf(o.lines, { w: o.w, h: o.h, size: o.size || 1, palette: o.palette || "warm" });
  const packs = runs.map(genShape);
  const all = packs.flatMap((p) => p.lights);
  const night = clamp(o.night ?? 0.6, 0, 1);
  let base = null;
  if (night > 0.001 && all.length) {
    base = makeCanvas(W, H);
    base.getContext("2d").drawImage(out, 0, 0);
  }
  applyNight(ctx, W, H, night);
  if (base) {
    // light spilling onto the trim under each bulb
    const q = 4, lw = Math.max(1, Math.ceil(W / q)), lh = Math.max(1, Math.ceil(H / q));
    const lm = makeCanvas(lw, lh), l = lm.getContext("2d");
    l.fillStyle = "#000"; l.fillRect(0, 0, lw, lh);
    l.globalCompositeOperation = "lighter"; l.globalAlpha = 0.36;
    const ks = scale / q;
    for (const L of all) {
      const sp = spillSprite(L.hex);
      const k = (L.sr * ks) / sp.R, t = L.ang + Math.PI / 2, c = Math.cos(t) * k, s = Math.sin(t) * k;
      l.setTransform(c, s, -s, c, L.x * ks, L.y * ks);
      l.drawImage(sp.cv, -sp.cx, -sp.cy);
    }
    reset(l);
    const tmp = makeCanvas(W, H), t = tmp.getContext("2d");
    t.imageSmoothingEnabled = true; t.imageSmoothingQuality = "high";
    t.globalCompositeOperation = "copy"; t.drawImage(lm, 0, 0, W, H);
    t.globalCompositeOperation = "multiply"; t.drawImage(base, 0, 0);
    const amt = 0.8 * night * 1.9;
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = clamp(amt, 0, 1); ctx.drawImage(tmp, 0, 0);
    if (amt > 1) { ctx.globalAlpha = clamp(amt - 1, 0, 1); ctx.drawImage(tmp, 0, 0); }
    ctx.globalAlpha = clamp(0.08 * amt, 0, 1); ctx.drawImage(lm, 0, 0, W, H);
    reset(ctx);
  }
  // the wire and sockets, then halos, bulbs and hot centers
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  const wire = night > 0.001 ? mixHex(WIRE, "#05070d", 0.78 * night) : WIRE;
  ctx.lineCap = "round"; ctx.strokeStyle = wire; ctx.fillStyle = wire;
  runs.forEach((o2, i) => {
    const p = packs[i];
    if (!p.sockets || !p.sockets.length) return;
    ctx.lineWidth = Math.max(0.45, p.r * 0.42);
    ctx.beginPath(); ctx.moveTo(o2.a[0], o2.a[1]); ctx.lineTo(o2.b[0], o2.b[1]); ctx.stroke();
    const r = p.r, sk = p.sockets;
    ctx.beginPath();
    for (let j = 0; j < sk.length; j += 4) {
      const x = sk[j], y = sk[j + 1], nx = sk[j + 2], ny = sk[j + 3], px = -ny, py = nx;
      const w2 = r * 0.62, a = r * 0.15, bb = r * 0.95;
      ctx.moveTo(x + px * w2 - nx * a, y + py * w2 - ny * a);
      ctx.lineTo(x - px * w2 - nx * a, y - py * w2 - ny * a);
      ctx.lineTo(x - px * w2 * 0.85 + nx * bb, y - py * w2 * 0.85 + ny * bb);
      ctx.lineTo(x + px * w2 * 0.85 + nx * bb, y + py * w2 * 0.85 + ny * bb);
      ctx.closePath();
    }
    ctx.fill();
  });
  const haloA = 0.5 + 0.5 * night, haloS = 0.55 + 0.45 * night;
  ctx.globalCompositeOperation = "lighter";
  for (const L of all) {
    const R = L.r * C9.glow * haloS;
    ctx.globalAlpha = clamp(haloA * 0.9, 0, 1);
    ctx.drawImage(glowSprite(L.hex), L.x - R, L.y - R, R * 2, R * 2);
  }
  ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
  for (const L of all) {
    const t = L.ang + Math.PI / 2, c = Math.cos(t) * scale, s = Math.sin(t) * scale;
    ctx.setTransform(c, s, -s, c, L.x * scale, L.y * scale);
    ctx.drawImage(bulbSprite(L.hex), -L.h, -L.h, L.h * 2, L.h * 2);
  }
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.globalCompositeOperation = "lighter";
  ctx.globalAlpha = clamp(0.38 + 0.44 * night, 0, 1);
  for (const L of all) {
    const R = L.r * 1.9;
    ctx.drawImage(glowSprite(coreHex(L.hex)), L.x - R, L.y - R, R * 2, R * 2);
  }
  reset(ctx);
  return all.length;
}
