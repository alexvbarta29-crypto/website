// Map module: pure geometry (no storage, no network). The client has its
// own copy of pointInPolygon in crm-app/modules/map/kit.js; the tests check
// both agree.
//
//   pointInPolygon([lng, lat], [[lng, lat], ...])   ray casting; a point on
//                                                    an edge counts as inside
//   bboxOf(polygon) → [w, s, e, n]
//   parseBbox("w,s,e,n") → [w, s, e, n] | null     (sane, at most ~1.5° wide)
//   inBbox(lng, lat, bbox)
//   thin(points, max)                              a breadcrumb kept under max
//                                                    points, the newest whole

const EPS = 1e-12;

export function pointInPolygon(pt, poly) {
  if (!Array.isArray(pt) || !Array.isArray(poly) || poly.length < 3) return false;
  const [x, y] = pt;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    // on the edge: inside
    const cross = (x - xi) * (yj - yi) - (y - yi) * (xj - xi);
    if (Math.abs(cross) < EPS && x >= Math.min(xi, xj) - EPS && x <= Math.max(xi, xj) + EPS && y >= Math.min(yi, yj) - EPS && y <= Math.max(yi, yj) + EPS) return true;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function bboxOf(poly) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of poly || []) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
  return [w, s, e, n];
}

export const MAX_BBOX_DEG = 1.5;
export function parseBbox(v) {
  if (typeof v !== "string" || !v) return null;
  const p = v.split(",").map(Number);
  if (p.length !== 4 || !p.every(Number.isFinite)) return null;
  const [w, s, e, n] = p;
  if (Math.abs(s) > 90 || Math.abs(n) > 90 || Math.abs(w) > 180 || Math.abs(e) > 180 || s > n || w > e) return null;
  if (e - w > MAX_BBOX_DEG || n - s > MAX_BBOX_DEG) return null;
  return [w, s, e, n];
}
export const inBbox = (x, y, b) => !b || (x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3]);

// Keeps a breadcrumb under `max` points: the newest half untouched, the
// older half every other point (so a long day keeps its shape).
export function thin(points, max) {
  if (!Array.isArray(points) || points.length <= max) return points || [];
  const keepNew = Math.floor(max / 2);
  const old = points.slice(0, points.length - keepNew);
  const fresh = points.slice(points.length - keepNew);
  const room = max - keepNew;
  const step = old.length / room;
  const out = [];
  for (let i = 0; i < room; i++) out.push(old[Math.floor(i * step)]);
  return [...out, ...fresh];
}

// Metres between two [lng, lat] points (equirectangular: fine at street scale).
export function metres(a, b) {
  const R = 6371000;
  const rad = Math.PI / 180;
  const x = (b[0] - a[0]) * rad * Math.cos(((a[1] + b[1]) / 2) * rad);
  const y = (b[1] - a[1]) * rad;
  return Math.sqrt(x * x + y * y) * R;
}
