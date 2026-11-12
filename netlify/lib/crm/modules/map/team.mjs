// Map module: the live team map (docs/CRM-MAP.md "Team map").
//
// While someone is clocked in AND has the app open, their phone sends where
// it is every ~2 minutes (and on clock in, visit start and finish); the
// office sees each person's last position, how fresh it is, their current
// or next visit and the day's route. Nothing is kept when they're clocked
// out or the app is closed (a web app can't run in the background: an
// installed iPhone web app shares only while it is open on screen).
//
// Consent and limits:
//   - cfg/map.team_map.enabled (the company) and .people (each person, by
//     an owner) must both say yes; the phone also asks once, and the
//     person's own browser asks for the location permission;
//   - the server refuses a position from someone who isn't clocked in
//     (ptr/clock: an open shift) and stores nothing;
//   - one blob a person a day: loc/day/{yyyy-mm-dd}/{uid} = { pts:
//     [[lat, lng, epoch s, accuracy m, why]] } kept under MAX_TRAIL points
//     (geo.mjs thin), so the latest position is its last point;
//   - loc/ is never backed up, never audited (raw keys, not records), and
//     map.retention deletes days older than retention_days (default 30).
//
//   GET  /map/sharing     time:own        is my phone asked to share now? { sharing, reason, every_s }
//   POST /map/position    time:own        { lat, lng, acc?, why? } → { sharing, every_s }
//   GET  /map/team?date   team_map:read   the office's map: people, positions, trails, visits
//   POST /map/team/forget settings:owner  delete every stored position now

import { getRaw, settledWrite, readIndex, getSetting, listKeys, deleteRaw } from "../../../crm-store.mjs";
import { InputError } from "../../core/errors.mjs";
import { now, nowMs, nowIso, localDate, addLocalDays, isLocalDate } from "../../core/clock.mjs";
import { mapSources } from "../../core/map-sources.mjs";
import { openSheetOf } from "../work/timesheets.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { thin } from "./geo.mjs";

export const MAX_TRAIL = 240;            // points a person a day (every 2 min for 8 h)
export const MIN_GAP_S = 25;             // a timed position closer than this to the last is skipped
export const WHY = Object.freeze({ interval: "i", clock_in: "c", visit_start: "s", visit_finish: "f", open: "o" });
export const TEAM_DEFAULTS = Object.freeze({ enabled: false, people: [], every_s: 120, retention_days: 30 });
export const dayKey = (date, uid) => `loc/day/${date}/${uid}`;

export async function teamSettings(opts = {}) {
  const s = await getSetting("map", opts);
  return { ...TEAM_DEFAULTS, ...((s && s.team_map) || {}) };
}

// Is this person's phone to share now? → { sharing, reason?, every_s, sheet? }
export async function sharingFor(user) {
  const tm = await teamSettings();
  if (!tm.enabled) return { sharing: false, reason: "off", every_s: tm.every_s };
  if (!(tm.people || []).includes(user.id)) return { sharing: false, reason: "not_you", every_s: tm.every_s };
  const sheet = await openSheetOf(user.id);
  if (!sheet) return { sharing: false, reason: "clocked_out", every_s: tm.every_s };
  return { sharing: true, every_s: tm.every_s, sheet };
}

export async function sharingRoute(ctx) {
  const s = await sharingFor(ctx.user);
  return { data: { sharing: s.sharing, ...(s.reason ? { reason: s.reason } : {}), every_s: s.every_s } };
}

const coord = (v, f, lim) => { if (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > lim) throw new InputError("That isn't a place on the map.", f); return Math.round(v * 1e5) / 1e5; };

export async function postPosition(ctx) {
  const b = ctx.body || {};
  const lat = coord(b.lat, "lat", 90);
  const lng = coord(b.lng, "lng", 180);
  const acc = Number.isFinite(b.acc) && b.acc >= 0 ? Math.min(99999, Math.round(b.acc)) : null;
  const why = Object.hasOwn(WHY, b.why) ? WHY[b.why] : "i";
  const s = await sharingFor(ctx.user);
  if (!s.sharing) return { data: { sharing: false, reason: s.reason, every_s: s.every_s } };
  const t = Math.floor(nowMs() / 1000);
  const date = localDate(now());
  const key = dayKey(date, ctx.user.id);
  for (let i = 0; i < 4; i++) {
    const cur = await getRaw(key);
    const pts = cur && cur.data && Array.isArray(cur.data.pts) ? cur.data.pts : [];
    const last = pts[pts.length - 1];
    if (last && why === "i" && t - last[2] < MIN_GAP_S) return { data: { sharing: true, every_s: s.every_s, kept: false } };
    const next = { uid: ctx.user.id, day: date, pts: thin([...pts, [lat, lng, t, acc, why]], MAX_TRAIL) };
    const w = await settledWrite(key, next, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
    if (w.ok) return { data: { sharing: true, every_s: s.every_s, kept: true } };
  }
  return { data: { sharing: true, every_s: s.every_s, kept: false } };
}

// ------------------------------------------------------------ the office's map

const order = (uid) => (v) => {
  const o = v.o;
  const n = o && typeof o === "object" ? o[uid] : Number.isFinite(o) ? o : null;
  return Number.isFinite(n) ? n : 999;
};
const OPEN = new Set(["en_route", "in_progress", "paused"]);
const shortName = (cn) => {
  const p = String(cn || "").trim().split(/\s+/).filter(Boolean);
  return p.length > 1 ? `${p[0]} ${p[p.length - 1][0].toUpperCase()}.` : p[0] || "Customer";
};

export async function teamMap(ctx) {
  const t = localDate(now());
  const date = isLocalDate(ctx.query.get("date")) ? ctx.query.get("date") : t;
  const tm = await teamSettings();
  if (date > t || date < addLocalDays(t, -tm.retention_days)) throw new InputError(`Pick a day in the last ${tm.retention_days} days.`, "date");
  const [users, visits, sheets] = await Promise.all([
    readIndex("users", ""), readIndex("visits", date.slice(0, 7)), readIndex("timesheets", date.slice(0, 7)),
  ]);
  const people = users.rows.filter((u) => u.status === "active" && (u.is_technician || (tm.people || []).includes(u.id)));
  const sharing = new Set(tm.enabled ? tm.people || [] : []);
  const trails = new Map();
  await Promise.all(people.filter((u) => sharing.has(u.id)).map(async (u) => {
    try { const g = await getRaw(dayKey(date, u.id)); if (g && g.data && Array.isArray(g.data.pts)) trails.set(u.id, g.data.pts); } catch (e) {
      console.error(`crm:map: a position day wasn't read (${safeErr(e)})`);
    }
  }));
  const nowS = Math.floor(nowMs() / 1000);
  const out = people.map((u) => {
    const mine = visits.rows.filter((v) => v.d === date && (v.a || []).includes(u.id) && v.st !== "cancelled").sort((a, b) => order(u.id)(a) - order(u.id)(b) || String(a.s || "").localeCompare(String(b.s || "")));
    const stops = mine.map((v) => ({ id: v.id, name: shortName(v.cn), town: v.town || "", s: v.s || null, e: v.e || null, st: v.st, geo: Array.isArray(v.geo) ? v.geo : v.geo && Number.isFinite(v.geo.lat) ? [v.geo.lat, v.geo.lng] : null, svc: v.svc || [] }));
    const current = stops.find((v) => OPEN.has(v.st)) || null;
    const next = stops.find((v) => v.st === "scheduled") || null;
    const pts = trails.get(u.id) || [];
    const last = pts[pts.length - 1];
    const open = sheets.rows.some((r) => r.uid === u.id && !r.e && r.st === "open");
    return {
      id: u.id, name: u.name, first_name: u.first_name || String(u.name || "").split(/\s+/)[0], color: u.color || "#16161b",
      sharing: sharing.has(u.id), clocked_in: date === t ? open : null,
      ...(last ? { last: { lat: last[0], lng: last[1], at: new Date(last[2] * 1000).toISOString(), age_s: Math.max(0, nowS - last[2]), acc: last[3] } } : {}),
      trail: pts.map((p) => [p[0], p[1], p[2]]),
      visits: stops, current, next,
    };
  });
  return { data: { date, today: t, enabled: !!tm.enabled, every_s: tm.every_s, retention_days: tm.retention_days, sources: mapSources(), people: out } };
}

// ------------------------------------------------------------ retention

export const MAX_DELETES = 400;
// The map.retention sweep (daily): position days older than retention_days,
// and reverse-geocoding cache months older than two. → { done, cursor?, result }
export async function runRetention(ctx = {}) {
  const tm = await teamSettings();
  const cutoff = addLocalDays(localDate(now()), -Math.max(1, Number(tm.retention_days) || 30));
  const month = (d, n) => { const [y, m] = d.split("-").map(Number); const x = new Date(Date.UTC(y, m - 1 - n, 1)); return x.toISOString().slice(0, 7); };
  const oldMonth = month(localDate(now()), 2);
  let deleted = 0;
  const left = () => (ctx.budget ? ctx.budget.left() : Infinity);
  const drop = async (keys) => {
    for (const k of keys) {
      if (deleted >= MAX_DELETES || left() < 3000) return false;
      await deleteRaw(k);
      deleted += 1;
    }
    return true;
  };
  const days = await listKeys("loc/day/", { directories: true });
  for (const d of days.directories.map((x) => x.replace(/\/+$/, "").split("/").pop()).filter((x) => isLocalDate(x) && x < cutoff).sort()) {
    if (!(await drop(await listKeys(`loc/day/${d}/`)))) return { done: false, result: `deleted:${deleted}` };
  }
  const revs = await listKeys("geo/rev/", { directories: true });
  for (const m of revs.directories.map((x) => x.replace(/\/+$/, "").split("/").pop()).filter((x) => /^\d{4}-\d{2}$/.test(x) && x < oldMonth).sort()) {
    if (!(await drop(await listKeys(`geo/rev/${m}/`)))) return { done: false, result: `deleted:${deleted}` };
  }
  return { done: true, result: `deleted:${deleted}` };
}

// POST /map/team/forget: every stored position, now (the owner's button).
export async function forgetPositions(ctx) {
  const r = await runRetentionAll(ctx.budget);
  return { data: r };
}
async function runRetentionAll(budget) {
  const keys = await listKeys("loc/");
  let deleted = 0;
  for (const k of keys) {
    if (budget && budget.left() < 1500) break;
    if (deleted >= 18) break;            // a request's storage budget: the button says when more are left
    await deleteRaw(k);
    deleted += 1;
  }
  return { deleted, more: keys.length > deleted, at: nowIso() };
}
