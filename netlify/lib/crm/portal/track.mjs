// Barta CRM portal: the "on the way" tracking page (docs/CRM-WORK.md
// "Tracking link"), registered by the work module (work/track.mjs).
//
// When a tech taps On my way, the customer's text carries a short link,
// /p/track/{code} (10 base62 characters, kept only as trk/{sha256(code)}).
// The page shows the tech's first name and initials, the vehicle when the
// owner turned that on (Settings → Tracking link), the ETA and, while the
// tech is on the way, a dot on a small map around the house.
//
// What the page never shows:
//   - other customers or the route: only the tech's latest point is used,
//     never the trail, and never a point closer than MIN_MOVE_M to where
//     they tapped On my way (that is the last customer's driveway);
//   - an exact location: the dot is an offset from the house rounded to
//     ROUND_M metres, and no coordinates leave the server (the house sits
//     at the middle of the drawing; the page doesn't need its address);
//   - any location once the visit has started, after location_until (the
//     tap + 2 hours), when the tech is no longer on the visit, or when the
//     team map's sharing is off or the tech is clocked out.
// The ETA comes from the tech's shared location (the team map is on, the
// tech is clocked in, the point is under STALE_S old): straight-line miles
// × 1.3 at 35 mph. Otherwise the page shows the arrival window (and what
// the tech typed when they tapped On my way).
//
// GET pages never change anything; the link needs no cookie (anyone the
// customer forwards it to sees the same, which is why it shows so little).

import { createHash, createHmac } from "node:crypto";
import { getRaw, settledWrite, getRecord, getSetting } from "../../crm-store.mjs";
import { CANONICAL_ORIGIN, keySalt } from "../core/context.mjs";
import { now, nowMs, localDate, zonedToUtc } from "../core/clock.mjs";
import { isId } from "../core/ids.mjs";
import { esc } from "../core/text.mjs";

export const LOCATION_MINUTES = 120;     // a dot for at most 2 hours after On my way
export const STALE_S = 600;              // a point older than 10 minutes isn't "live"
export const MIN_MOVE_M = 400;           // no dot until they're this far from where they tapped
export const ROUND_M = 50;               // the dot's offset from the house, rounded
export const ARRIVING_M = 150;           // "pulling up now"
export const TRACK_DEFAULTS = Object.freeze({ enabled: true, show_vehicle: false, vehicles: {}, location_minutes: LOCATION_MINUTES });
const CODE_RE = /^[0-9A-Za-z]{10}$/;
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const sha = (s) => createHash("sha256").update(String(s)).digest("hex");
export const trackKey = (code) => `trk/${sha(code)}`;
export const isTrackCode = (s) => CODE_RE.test(String(s || ""));

// The code of one tap (pure given the salt): the same visit and client id
// (a double tap, a retry) make the same link.
export function trackCode(visitId, tapKey) {
  const mac = createHmac("sha256", keySalt() || "dev-only").update(`track:${visitId}:${tapKey}`).digest();
  let code = "";
  for (const b of mac) { if (b < 248) code += BASE62[b % 62]; if (code.length === 10) break; }
  return code;
}

// Makes (once) the link of an On my way tap. → { code, url } | null when the owner turned links off.
export async function createTrackLink({ visit, userId, at, tapKey, settings }) {
  const s = { ...TRACK_DEFAULTS, ...(settings || {}) };
  if (!s.enabled) return null;
  const code = trackCode(visit.id, tapKey || at);
  const t0 = Date.parse(at) || nowMs();
  const minutes = Number.isInteger(s.location_minutes) && s.location_minutes > 0 ? Math.min(s.location_minutes, 240) : LOCATION_MINUTES;
  // the page itself lasts until the end of the next day (it says how the visit went), the dot 2 hours
  const day = localDate(new Date(t0));
  const [y, m, d] = day.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  const value = {
    visit_id: visit.id, contact_id: visit.contact_id, user_id: userId, created_at: new Date(t0).toISOString(),
    location_until: new Date(t0 + minutes * 60000).toISOString(), expires_at: zonedToUtc(next, "23:59").toISOString(),
  };
  await settledWrite(trackKey(code), value, { onlyIfNew: true }).catch(() => {});
  return { code, url: `${CANONICAL_ORIGIN}/p/track/${code}` };
}

export async function readTrack(code) {
  if (!isTrackCode(code)) return null;
  const got = await getRaw(trackKey(code));
  return got && got.data ? got.data : null;
}

// ------------------------------------------------------------ words

const clockText = (hhmm) => {
  const [h, m] = String(hhmm || "08:00").split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
};
const add = (hhmm, min) => { const [h, m] = String(hhmm || "08:00").split(":").map(Number); const t = h * 60 + m + min; return `${Math.floor(t / 60) % 24}:${String(t % 60).padStart(2, "0")}`; };

// "Arriving between 10:00 AM and 12:00 PM" (a visit's arrival window, for the customer).
export function arrivalText(v) {
  const w = (v && v.window) || {};
  if (v && (v.date_only || w.type === "anytime")) return "Anytime that day";
  if (w.type === "window" && w.minutes) return `Arriving between ${clockText(v.start)} and ${clockText(add(v.start, w.minutes))}`;
  return `Arriving at ${clockText(v && v.start)}`;
}
// "10:20 AM" from an instant (America/Chicago).
export function timeOfDay(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" }).format(d);
}

// ------------------------------------------------------------ geometry (pure)

const R = 6371000;
const rad = (x) => (x * Math.PI) / 180;
export function metresBetween(a, b) {
  const dLat = rad(b[0] - a[0]);
  const dLng = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
// East and north metres from the house to a point, rounded to ROUND_M.
export function offsetFrom(home, p) {
  const east = rad(p[1] - home[1]) * R * Math.cos(rad(home[0]));
  const north = rad(p[0] - home[0]) * R;
  const r = (x) => Math.round(x / ROUND_M) * ROUND_M;
  return { east: r(east), north: r(north) };
}
// Minutes to drive: straight-line miles × 1.3 at 35 mph (the tech app's rule), at least 1.
export const driveMinutes = (m) => Math.max(1, Math.round((((m / 1609.344) * 1.3) / 35) * 60));

const pointOf = (g) => (Array.isArray(g) && Number.isFinite(g[0]) && Number.isFinite(g[1]) ? [g[0], g[1]] : g && Number.isFinite(g.lat) && Number.isFinite(g.lng) ? [g.lat, g.lng] : null);

// What the page shows (pure). trk: the link; visit; tech { first_name, name, color };
// live: { sharing, pts: [[lat, lng, epoch s, acc, why]] } | null; home: [lat, lng] | null.
// → { state, headline, tech, vehicle, window_text, eta, map, refresh_s }
export function trackView({ trk, visit, tech, vehicle, live, home, t = nowMs() }) {
  const first = String((tech && (tech.first_name || String(tech.name || "").split(/\s+/)[0])) || "").trim() || "Your tech";
  const parts = String((tech && tech.name) || first).trim().split(/\s+/);
  const initials = ((parts[0] || "?")[0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
  const techOut = { first_name: first, initials, color: /^#[0-9a-f]{6}$/i.test((tech && tech.color) || "") ? tech.color : "#16161b" };
  const st = visit.status;
  const onVisit = (visit.assignee_ids || []).includes(trk.user_id);
  const omw = visit.on_my_way || {};
  const late = Array.isArray(visit.running_late) && visit.running_late.length ? visit.running_late[visit.running_late.length - 1] : null;
  const said = late && late.eta_min ? { at: late.at, eta_min: late.eta_min } : omw.eta_min ? { at: omw.at, eta_min: omw.eta_min } : null;
  const saidText = said ? `${first} said about ${said.eta_min} minutes at ${timeOfDay(said.at)}` : null;
  const out = { tech: techOut, vehicle: vehicle || null, window_text: arrivalText(visit), eta: null, map: null, refresh_s: null };
  if (["in_progress", "paused"].includes(st)) return { ...out, state: "started", headline: `${first} is here`, sub: "Your visit has started." };
  if (st === "completed") return { ...out, state: "done", headline: "All done!", sub: "Thanks for having us. Call or text us anytime." };
  if (["cancelled", "no_access"].includes(st)) return { ...out, state: "off", headline: "This visit isn't happening right now", sub: "Call or text us and we'll sort it out." };
  if (st !== "en_route" || !onVisit) return { ...out, state: "scheduled", headline: "We'll see you soon", sub: out.window_text };
  const until = Date.parse(trk.location_until) || 0;
  const base = { ...out, state: "on_the_way", headline: `${first} is on the way`, refresh_s: 60 };
  const fallback = { ...base, eta: { source: "window", text: out.window_text, said: saidText } };
  if (t >= until) return { ...fallback, refresh_s: null, sub: "Live location has ended for this visit." };
  if (!live || !live.sharing || !home) return fallback;
  const tapAt = Math.floor((Date.parse(omw.at || trk.created_at) || 0) / 1000);
  const pts = (live.pts || []).filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2]));
  const after = pts.filter((p) => p[2] >= tapAt - 60);
  const last = after[after.length - 1];
  if (!last || Math.floor(t / 1000) - last[2] > STALE_S) return fallback;
  const here = [last[0], last[1]];
  const dist = metresBetween(here, home);
  const mins = driveMinutes(dist);
  const arrive = new Date(t + mins * 60000).toISOString();
  const eta = dist <= ARRIVING_M ? { source: "live", minutes: 0, text: "Pulling up now", said: saidText } : { source: "live", minutes: mins, text: `About ${mins} minute${mins === 1 ? "" : "s"} away`, at_text: `Around ${timeOfDay(arrive)}`, said: saidText };
  // where they tapped On my way (the last stop): no dot until they've left it behind
  const origin = pointOf(omw.geo) || (after[0] ? [after[0][0], after[0][1]] : here);
  const moved = metresBetween(origin, here) >= MIN_MOVE_M;
  const map = moved || dist <= ARRIVING_M ? { ...offsetFrom(home, dist <= ARRIVING_M ? home : here), distance_m: Math.round(dist / ROUND_M) * ROUND_M, age_s: Math.max(0, Math.floor(t / 1000) - last[2]) } : null;
  return { ...base, eta, map, refresh_s: 30 };
}

// Everything the page needs for one code, read in a few calls. → view | { missing } | { ended }
export async function trackState(code) {
  const trk = await readTrack(code);
  if (!trk) return { missing: true };
  if (!(Date.parse(trk.expires_at) > nowMs())) return { ended: true };
  const v = isId(trk.visit_id, "visit") ? await getRecord("visit", trk.visit_id).catch(() => null) : null;
  if (!v || v.data.deleted_at || v.data.contact_id !== trk.contact_id) return { missing: true };
  const visit = v.data;
  const [u, settings] = await Promise.all([
    isId(trk.user_id, "user") ? getRecord("user", trk.user_id).catch(() => null) : null,
    getSetting("tracking").catch(() => ({ ...TRACK_DEFAULTS })),
  ]);
  const tech = u ? u.data : null;
  const s = { ...TRACK_DEFAULTS, ...(settings || {}) };
  const vehicle = s.show_vehicle && s.vehicles && typeof s.vehicles[trk.user_id] === "string" ? s.vehicles[trk.user_id].slice(0, 60) : null;
  let live = null;
  let home = pointOf(visit.geo);
  const wantLive = visit.status === "en_route" && (visit.assignee_ids || []).includes(trk.user_id) && nowMs() < (Date.parse(trk.location_until) || 0) && tech;
  if (wantLive) {
    const { sharingFor, dayKey } = await import("../modules/map/team.mjs");
    const sharing = await sharingFor(tech).catch(() => ({ sharing: false }));
    if (sharing.sharing) {
      const day = await getRaw(dayKey(localDate(now()), tech.id)).catch(() => null);
      live = { sharing: true, pts: (day && day.data && Array.isArray(day.data.pts) ? day.data.pts : []).slice(-40) };
      if (!home && isId(visit.property_id, "property")) {
        const p = await getRecord("property", visit.property_id).catch(() => null);
        home = p ? pointOf(p.data.geo) : null;
      }
    }
  }
  return trackView({ trk, visit, tech, vehicle, live, home });
}

// ------------------------------------------------------------ the page

const STYLE = `<style>
.tk-head{display:flex;align-items:center;gap:14px}
.tk-ava{flex:0 0 auto;width:56px;height:56px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font:800 20px/1 'Cabinet Grotesk',system-ui,sans-serif;letter-spacing:.02em}
.tk-head h1{margin:0}
.tk-sub{margin:4px 0 0}
.tk-eta{font:800 30px/1.1 'Cabinet Grotesk',system-ui,sans-serif;letter-spacing:-.015em;color:var(--ink);margin:4px 0 2px}
.tk-meta{margin:2px 0 0;font-size:15px}
.tk-map{position:relative;margin:14px 0 0;border-radius:16px;overflow:hidden;background:#eef1f4;border:1px solid var(--line)}
.tk-map svg{display:block;width:100%;height:auto}
.tk-cap{display:flex;justify-content:space-between;gap:10px;font-size:13px;color:var(--muted);margin-top:8px}
.tk-pill{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;background:#eafaf0;color:#14713d;font-size:13px;font-weight:600}
.tk-pill i{width:8px;height:8px;border-radius:50%;background:#22a05a}
.tk-veh{margin-top:12px;padding:12px 14px;border-radius:14px;background:var(--mist);font-size:15px}
@media (prefers-reduced-motion:no-preference){.tk-pulse{animation:tkp 1.8s ease-out infinite;transform-origin:center;transform-box:fill-box}@keyframes tkp{0%{opacity:.55;transform:scale(1)}100%{opacity:0;transform:scale(2.6)}}}
</style>`;

// The page body for a view (server-rendered; crm-app/portal/track.js keeps it fresh).
export function trackPage(code, view) {
  const v = view;
  const ava = `<span class="tk-ava" style="background:${esc(v.tech.color)}" aria-hidden="true" data-tk-initials>${esc(v.tech.initials)}</span>`;
  const eta = v.eta ? `<p class="tk-eta" data-tk-eta>${esc(v.eta.text)}</p>${v.eta.at_text ? `<p class="tk-meta muted" data-tk-at>${esc(v.eta.at_text)}</p>` : `<p class="tk-meta muted" data-tk-at hidden></p>`}${v.eta.said ? `<p class="tk-meta muted small" data-tk-said>${esc(v.eta.said)}</p>` : `<p class="tk-meta muted small" data-tk-said hidden></p>`}` : `<p class="tk-eta" data-tk-eta hidden></p><p class="tk-meta muted" data-tk-at hidden></p><p class="tk-meta muted small" data-tk-said hidden></p>`;
  const live = v.eta && v.eta.source === "live";
  return {
    title: v.headline,
    body: `${STYLE}<section class="card" data-track-code="${esc(code)}" data-tk-state="${esc(v.state)}" data-tk-refresh="${esc(v.refresh_s || "")}">
<div class="tk-head">${ava}<div><h1 data-tk-headline>${esc(v.headline)}</h1><p class="tk-sub" data-tk-sub${v.sub ? "" : " hidden"}>${esc(v.sub || "")}</p></div></div>
<div data-tk-live${v.state === "on_the_way" ? "" : " hidden"}>${eta}
<div class="tk-map" data-tk-map${v.map ? "" : " hidden"} data-east="${esc(v.map ? v.map.east : "")}" data-north="${esc(v.map ? v.map.north : "")}" data-dist="${esc(v.map ? v.map.distance_m : "")}" role="img" aria-label="A small map: your home in the middle and ${esc(v.tech.first_name)} on the way"></div>
<div class="tk-cap"${live ? "" : " hidden"} data-tk-cap><span class="tk-pill"><i></i>Live</span><span data-tk-age>${v.map && v.map.age_s > 90 ? `Updated ${Math.round(v.map.age_s / 60)} min ago` : "Updated just now"}</span></div>
</div>
${v.vehicle ? `<p class="tk-veh">Look for ${esc(v.vehicle)}.</p>` : ""}
<p class="small muted" style="margin-top:14px" data-tk-window>${esc(v.window_text)}</p>
</section>
<section class="card"><h2>Need us?</h2><p>Gate code, a dog in the yard, or running out the door? Call or text us and we'll pass it along.</p><div class="row"><a class="btn ghost" href="tel:+17633143400">Call us</a><a class="btn ghost" href="sms:+17633143400">Text us</a></div></section>`,
  };
}

export const ENDED = ["That link has ended", "Tracking links work for a day or so. Call or text us if you need anything."];
