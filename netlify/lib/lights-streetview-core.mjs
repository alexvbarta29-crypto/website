// Street View geometry shared by Barta Light Studio's lookup
// (netlify/functions/lights-streetview.mjs) and the CRM's automatic lights
// mockup (crm/modules/quotes/mockup.mjs): compass bearings, distances, a
// point along a bearing, and how to aim the camera at a house so the whole
// roofline fits. Pure functions, no network.

const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

// Compass bearing from a to b, 0-360.
export function bearing(a, b) {
  const p1 = toRad(a.lat), p2 = toRad(b.lat), dl = toRad(b.lng - a.lng);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// Meters between a and b.
export function meters(a, b) {
  const R = 6371000, p1 = toRad(a.lat), p2 = toRad(b.lat);
  const h = Math.sin(toRad(b.lat - a.lat) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(toRad(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// The point d meters from a along compass bearing b.
export function offset(a, b, d) {
  const R = 6371000, br = toRad(b), p1 = toRad(a.lat), l1 = toRad(a.lng), q = d / R;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(q) + Math.cos(p1) * Math.sin(q) * Math.cos(br));
  const l2 = l1 + Math.atan2(Math.sin(br) * Math.sin(q) * Math.cos(p1), Math.cos(q) - Math.sin(p1) * Math.sin(p2));
  return { lat: toDeg(p2), lng: toDeg(l2) };
}

// The camera from a panorama at `from` toward the house: closer houses need
// a wider, higher view to fit the roofline, with room to crop.
export function aimAt(from, house) {
  const d = meters(from, house);
  return {
    heading: Math.round(bearing(from, house)),
    pitch: d < 18 ? 14 : d < 35 ? 10 : 6,
    fov: d < 18 ? 115 : d < 35 ? 105 : 95,
  };
}
