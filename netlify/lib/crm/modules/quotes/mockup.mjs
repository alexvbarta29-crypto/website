// Quotes module: the automatic Christmas lights mockup (the owner, Nov 16:
// "say you do a Christmas lights quote and you hit Mockup, have that mockup
// just generate an automatic mockup of the person's house"). Two short
// calls, each well inside a function's time limit:
//
//   POST /lights-mockup/photo {property_id, refresh?}  quotes:write
//        → { photo: { url, w, h, at } } | { photo: null, reason }
//        The house from the street: Google Street View aimed at the property
//        (its map point, else a geocode of its address), the same aim as
//        Light Studio's lookup (lib/lights-streetview-core.mjs). Cached per
//        property in crm-files at mkp/{propertyId}/street, so Regenerate and
//        a second look cost Google nothing.
//   GET  /lights-mockup/:property/photo.jpg            quotes:read
//        The cached photo (same origin, so the app's CSP and canvas allow it).
//   POST /lights-mockup/lines {property_id, regenerate?}  quotes:write
//        → { source: "claude", lines: [{ kind, points: [[x, y], ...] }], w, h }
//        | { source: "none", reason, lines: [] }
//        Claude's vision model finds the eaves, the gutter lines and the
//        roof's sloped edges up to each peak (and the bushes and trees out
//        front) and answers JSON polylines in the photo's pixels. Only the
//        photo goes to the model: never a name, phone, address or note.
//        The answer is checked (parseLines) and cached at
//        mkp/{propertyId}/lines; "regenerate" asks again.
//
// The app draws the C9 bulbs itself (crm-app/modules/quotes/bulbs.js, ported
// from Light Studio). When the key is missing, the day's budget is spent,
// the model is slow or answers nothing usable, the answer says why and the
// app falls back to its own edge finder, else to Light Studio with the photo.
//
// Server key: ANTHROPIC_API_KEY (Netlify env; never logged, never sent to
// the browser). Budget: CRM_MOCKUP_DAILY_MAX model calls a day (default 40)
// across the company, and 6 a minute per person. Model: Claude Opus 5.5 at
// low effort, structured JSON output, the instructions cached.

import { getRecord, getRaw, putRaw, listKeys, deleteRaw } from "../../../crm-store.mjs";
import { isId } from "../../core/ids.mjs";
import { localDate, now, nowMs, tsKey, nowIso } from "../../core/clock.mjs";
import { InputError, NotFoundError, ConflictError, RateLimited } from "../../core/errors.mjs";
import { aimAt } from "../../../lights-streetview-core.mjs";
import { safeErr } from "../../../referral-lib.mjs";

export const GOOGLE = "https://maps.googleapis.com/maps/api";
export const GOOGLE_TIMEOUT_MS = 4000;
export const CLAUDE_URL = "https://api.anthropic.com/v1/messages";
export const CLAUDE_MODEL = "claude-opus-5-5";
export const CLAUDE_VERSION = "2026-10-21";
export const CLAUDE_BETA = "server-side-fallback-2026-07-01";
// a function answers within its limit: the model gets 8.5 s, the rest is ours
export const CLAUDE_TIMEOUT_MS = 8500;
export const DAILY_MAX = 40;
export const PER_MINUTE = 6;
export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
export const LINE_KINDS = Object.freeze(["eave", "rake", "bush", "tree"]);
export const MAX_LINES = 40;
export const MAX_POINTS = 40;

const photoKey = (pid) => `mkp/${pid}/street`;
const linesKey = (pid) => `mkp/${pid}/lines`;
const dayPrefix = (day) => `mkd/${day}/`;

// ------------------------------------------------------------ the photo

// JPEG width and height from its SOF marker (no decoding). → { w, h } | null
export function jpegSize(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i += 1; continue; }
    const m = b[i + 1];
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    const len = (b[i + 2] << 8) | b[i + 3];
    if ((m >= 0xc0 && m <= 0xc3) || (m >= 0xc5 && m <= 0xc7) || (m >= 0xc9 && m <= 0xcb) || (m >= 0xcd && m <= 0xcf)) {
      const h = (b[i + 5] << 8) | b[i + 6], w = (b[i + 7] << 8) | b[i + 8];
      return w > 0 && h > 0 ? { w, h } : null;
    }
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

async function getJson(url, fetchImpl) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS) });
  if (!res.ok) throw Object.assign(new Error(`google ${res.status}`), { status: res.status });
  return res.json();
}

const oneLine = (a) => [a.street1, a.city, [a.state || "MN", a.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");

// The street photo of a property, aimed at the house. → { bytes, w, h, pano } | { reason }
export async function streetPhoto(property, { env = process.env, fetchImpl = fetch } = {}) {
  const key = String(env.GOOGLE_MAPS_API_KEY || "").trim();
  if (!key) return { reason: "streetview_off" };
  try {
    let house = property.geo && Number.isFinite(property.geo.lat) && Number.isFinite(property.geo.lng) ? { lat: property.geo.lat, lng: property.geo.lng } : null;
    if (!house) {
      const address = oneLine(property.address || {});
      if (!address || address.length > 300) return { reason: "no_address" };
      const geo = await getJson(`${GOOGLE}/geocode/json?${new URLSearchParams({ address, components: "country:US", key })}`, fetchImpl);
      if (geo.status === "REQUEST_DENIED") return { reason: "streetview_off" };
      const loc = geo.status === "OK" && geo.results && geo.results[0] && geo.results[0].geometry && geo.results[0].geometry.location;
      if (!loc) return { reason: "not_found" };
      house = { lat: loc.lat, lng: loc.lng };
    }
    let meta = null;
    for (const q of [{ radius: "60", source: "outdoor" }, { radius: "150", source: "outdoor" }]) {
      const m = await getJson(`${GOOGLE}/streetview/metadata?${new URLSearchParams({ location: `${house.lat},${house.lng}`, ...q, key })}`, fetchImpl);
      if (m.status === "REQUEST_DENIED") return { reason: "streetview_off" };
      if (m.status === "OK" && m.pano_id) { meta = m; break; }
    }
    if (!meta) return { reason: "no_imagery" };
    const aim = aimAt(meta.location || house, house);
    const res = await fetchImpl(`${GOOGLE}/streetview?${new URLSearchParams({ size: "640x480", pano: meta.pano_id, heading: String(aim.heading), pitch: String(aim.pitch), fov: String(aim.fov), return_error_code: "true", key })}`, { signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS) });
    if (!res.ok) return { reason: res.status === 404 ? "no_imagery" : res.status === 403 ? "streetview_off" : "google_error" };
    const bytes = new Uint8Array(await res.arrayBuffer());
    const size = jpegSize(bytes);
    if (!size || bytes.length > MAX_PHOTO_BYTES) return { reason: "google_error" };
    return { bytes, ...size, pano: String(meta.pano_id).slice(0, 120), heading: aim.heading };
  } catch (e) {
    console.error(`crm:mockup: Street View didn't answer (${e && e.status ? `HTTP ${e.status}` : safeErr(e)})`);
    return { reason: "google_error" };
  }
}

async function propertyOf(id) {
  if (!isId(id, "property")) throw new InputError("Pick the house first.", "property_id");
  const g = await getRecord("property", id);
  if (!g || g.data.deleted_at) throw new NotFoundError("That property isn't there.");
  return g.data;
}

const photoUrl = (pid, at) => `/api/crm/lights-mockup/${encodeURIComponent(pid)}/photo.jpg?v=${encodeURIComponent(String(at || "").replace(/[^0-9a-z]/gi, "").slice(0, 20))}`;

async function cachedPhoto(pid) {
  const got = await getRaw(photoKey(pid), { kind: "files", type: "arrayBuffer" }).catch(() => null);
  if (!got || !got.data) return null;
  const m = got.metadata || {};
  return { bytes: new Uint8Array(got.data), w: m.w, h: m.h, at: m.at };
}

export async function photoRoute(ctx, opts = {}) {
  const b = ctx.body || {};
  const p = await propertyOf(b.property_id);
  if (b.refresh !== true) {
    const c = await cachedPhoto(p.id);
    if (c && c.w && c.h) return { data: { photo: { url: photoUrl(p.id, c.at), w: c.w, h: c.h, at: c.at } } };
  }
  const got = await streetPhoto(p, opts);
  if (!got.bytes) return { data: { photo: null, reason: got.reason } };
  const at = nowIso();
  await putRaw(photoKey(p.id), got.bytes, { metadata: { w: got.w, h: got.h, at, source: "streetview" } }, { kind: "files" });
  await deleteRaw(linesKey(p.id)).catch(() => {});
  return { data: { photo: { url: photoUrl(p.id, at), w: got.w, h: got.h, at } } };
}

export async function photoFileRoute(ctx) {
  const p = await propertyOf(ctx.params.property);
  const c = await cachedPhoto(p.id);
  if (!c) throw new NotFoundError("No photo yet.");
  return new Response(c.bytes, {
    status: 200,
    headers: { "Content-Type": "image/jpeg", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox", "Cache-Control": "private, max-age=86400", "Content-Disposition": "inline; filename=house.jpg" },
  });
}

// ------------------------------------------------------------ what the model answers

export const LINES_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["house_found", "lines"],
  properties: {
    house_found: { type: "boolean" },
    lines: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "points"],
        properties: {
          kind: { type: "string", enum: [...LINE_KINDS] },
          points: { type: "array", items: { type: "object", additionalProperties: false, required: ["x", "y"], properties: { x: { type: "number" }, y: { type: "number" } } } },
        },
      },
    },
  },
});

// Kept word for word between calls so the prompt cache holds (no dates, no ids in here).
export const SYSTEM_PROMPT = `You mark where Christmas lights would be installed on a house, for a lights installer's sales mockup.

You get one street-level photo of a house (Google Street View). Find the edges a crew hangs C9 bulbs on and answer them as polylines in the photo's own pixel coordinates: x from 0 at the left edge to the photo's width, y from 0 at the top edge to the photo's height. The photo's size is given with it.

Kinds of line:
- "eave": a roofline edge that runs roughly level, where the roof ends over the wall: the gutter line or fascia board. Follow the bottom edge of the roof (the top of the gutter when there is one).
- "rake": a sloped roof edge that climbs to a peak and comes back down (a gable). Give it as one polyline from the low corner up to the peak and down to the other low corner when both sides show.
- "bush": the outline of a shrub or hedge in front of the house, as a closed polygon of 4 to 12 points around its visible shape.
- "tree": the outline of a small ornamental tree near the house, as a closed polygon of 4 to 12 points.

Rules:
- Only the house the photo is aimed at (the one nearest the middle of the photo). Ignore neighbors, cars, fences, power lines, shadows and the street.
- Trace the edges you can actually see. Where a tree or another object hides part of a roof edge, end the line at the hidden part and start a new line after it.
- Each roof section, dormer and garage roof is its own line. Corners and peaks are points on the line; the points go in order along the edge.
- Put points on the edge itself, within a few pixels. Use as few points as follow the edge: 2 for a straight run, 3 for a simple gable.
- Garage doors, windows, railings and the ground are never lines.
- At most 20 roof lines and 6 bushes or trees. If the photo shows no house clearly (blurry, blocked, inside a building, no roof in view), answer house_found false and no lines.`;

const finite = (v) => typeof v === "number" && Number.isFinite(v);
const len = (pts) => pts.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);

// The model's answer (an object or its JSON text) → { lines, usable }:
// known kinds only; points as [x, y] inside the photo (a point a little
// outside is pulled to the edge, one far outside drops the line); tiny and
// duplicate points dropped; roof lines shorter than 4% of the width dropped;
// usable when at least one roof line is left.
export function parseLines(answer, w, h) {
  let a = answer;
  if (typeof a === "string") { try { a = JSON.parse(a); } catch { return { lines: [], usable: false }; } }
  if (!a || typeof a !== "object" || !Array.isArray(a.lines) || !(w > 0) || !(h > 0)) return { lines: [], usable: false };
  if (a.house_found === false) return { lines: [], usable: false };
  const slackX = w * 0.05, slackY = h * 0.05;
  const out = [];
  for (const l of a.lines.slice(0, MAX_LINES * 2)) {
    if (!l || typeof l !== "object" || !LINE_KINDS.includes(l.kind) || !Array.isArray(l.points)) continue;
    const pts = [];
    let bad = false;
    for (const p of l.points.slice(0, MAX_POINTS)) {
      const x = Array.isArray(p) ? p[0] : p && p.x, y = Array.isArray(p) ? p[1] : p && p.y;
      if (!finite(x) || !finite(y) || x < -slackX || x > w + slackX || y < -slackY || y > h + slackY) { bad = true; break; }
      const q = [Math.round(Math.min(w, Math.max(0, x)) * 10) / 10, Math.round(Math.min(h, Math.max(0, y)) * 10) / 10];
      const last = pts[pts.length - 1];
      if (last && Math.hypot(q[0] - last[0], q[1] - last[1]) < 2) continue;
      pts.push(q);
    }
    if (bad) continue;
    const shape = l.kind === "bush" || l.kind === "tree";
    if (shape) {
      if (pts.length < 3) continue;
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      if (Math.max(...xs) - Math.min(...xs) < 6 || Math.max(...ys) - Math.min(...ys) < 6) continue;
    } else if (pts.length < 2 || len(pts) < w * 0.04) continue;
    out.push({ kind: l.kind, points: pts });
    if (out.length >= MAX_LINES) break;
  }
  return { lines: out, usable: out.some((l) => l.kind === "eave" || l.kind === "rake") };
}

// ------------------------------------------------------------ the call

// One call to Claude's vision model. → { ok: true, answer, usage } | { ok: false, reason }
// Never logs the photo, the prompt or the answer: only the HTTP status, time and token counts.
export async function askClaude({ bytes, w, h }, { env = process.env, fetchImpl = fetch, timeoutMs = CLAUDE_TIMEOUT_MS } = {}) {
  const key = String(env.ANTHROPIC_API_KEY || "").trim();
  if (!key) return { ok: false, reason: "no_key" };
  const body = {
    model: CLAUDE_MODEL,
    max_tokens: 8000,
    // the decline fallback runs the same request on Anthropic's recommended model
    fallbacks: "default",
    output_config: { effort: "low", format: { type: "json_schema", schema: LINES_SCHEMA } },
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: Buffer.from(bytes).toString("base64") } },
        { type: "text", text: `The photo is ${w} pixels wide and ${h} pixels tall. Mark the lights lines on the house it is aimed at.` },
      ],
    }],
  };
  const t0 = performance.now();
  const took = () => Math.round(performance.now() - t0);
  const send = (b, beta) => fetchImpl(CLAUDE_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": CLAUDE_VERSION, ...(beta ? { "anthropic-beta": CLAUDE_BETA } : {}) },
    body: JSON.stringify(b),
    signal: AbortSignal.timeout(Math.max(1000, timeoutMs - took())),
  });
  let res;
  try {
    res = await send(body, true);
    // an account without the decline-fallback beta answers 400 at once: ask again without it
    if (res.status === 400) {
      const { fallbacks, ...plain } = body;
      res = await send(plain, false);
    }
  } catch (e) {
    const timeout = e && (e.name === "TimeoutError" || e.name === "AbortError");
    console.error(`crm:mockup: Claude ${timeout ? "timed out" : "didn't answer"} after ${took()} ms`);
    return { ok: false, reason: timeout ? "timeout" : "unreachable" };
  }
  if (!res.ok) {
    // 429 / 500 / 529 are worth a later try; 400 / 401 / 403 / 404 are setup problems
    const s = res.status;
    console.error(`crm:mockup: Claude answered HTTP ${s} after ${took()} ms`);
    return { ok: false, reason: s === 429 || s >= 500 ? "busy" : s === 401 || s === 403 ? "key_refused" : "model_error" };
  }
  let msg;
  try { msg = await res.json(); } catch { return { ok: false, reason: "unusable" }; }
  const usage = msg && msg.usage ? { in: msg.usage.input_tokens || 0, out: msg.usage.output_tokens || 0, cache_read: msg.usage.cache_read_input_tokens || 0 } : null;
  console.log(`crm:mockup: Claude ${msg && msg.stop_reason} in ${took()} ms${usage ? `, ${usage.in} in / ${usage.out} out / ${usage.cache_read} cached tokens` : ""}`);
  if (!msg || msg.stop_reason === "refusal") return { ok: false, reason: "refused" };
  if (msg.stop_reason === "max_tokens") return { ok: false, reason: "unusable" };
  const text = (Array.isArray(msg.content) ? msg.content : []).filter((b) => b && b.type === "text").map((b) => b.text).join("");
  let answer;
  try { answer = JSON.parse(text); } catch { return { ok: false, reason: "unusable" }; }
  return { ok: true, answer, usage };
}

// ------------------------------------------------------------ the budget

export const dailyMax = (env = process.env) => {
  const n = Number(env.CRM_MOCKUP_DAILY_MAX);
  return Number.isSafeInteger(n) && n >= 0 && n <= 1000 ? n : DAILY_MAX;
};

// Each model call is its own small key mkd/{day}/{ts}--{user}--{rand} (a
// fresh key, so calls at the same moment all count; no read-then-write).
// → null when allowed (and counted), else the reason.
export async function spend(userId, env = process.env) {
  const day = localDate(now());
  const keys = await listKeys(dayPrefix(day));
  if (keys.length >= dailyMax(env)) return "daily_limit";
  const since = tsKey(new Date(nowMs() - 60000));
  const who = String(userId || "x").replace(/[^a-z0-9_]/g, "").slice(0, 40) || "x";
  const recent = keys.filter((k) => k.slice(dayPrefix(day).length) >= since && k.includes(`--${who}--`)).length;
  if (recent >= PER_MINUTE) return "per_minute";
  await putRaw(`${dayPrefix(day)}${tsKey()}--${who}--${Math.random().toString(36).slice(2, 8)}`, { at: nowIso() });
  return null;
}

// The quotes.expire sweep's tail: day counters older than two days go.
export async function pruneBudget() {
  const { directories } = await listKeys("mkd/", { directories: true });
  const cut = localDate(new Date(nowMs() - 2 * 86400000));
  let n = 0;
  for (const d of directories || []) {
    const day = String(d).replace(/^mkd\//, "").replace(/\/$/, "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day >= cut) continue;
    for (const k of await listKeys(`mkd/${day}/`)) { await deleteRaw(k); n += 1; }
  }
  return n;
}

export async function linesRoute(ctx, opts = {}) {
  const b = ctx.body || {};
  const p = await propertyOf(b.property_id);
  const photo = await cachedPhoto(p.id);
  if (!photo || !photo.w || !photo.h) throw new ConflictError("Get the house photo first.");
  if (b.regenerate !== true) {
    const c = await getRaw(linesKey(p.id)).catch(() => null);
    if (c && c.data && c.data.at === photo.at && Array.isArray(c.data.lines) && c.data.lines.length) return { data: { source: "claude", lines: c.data.lines, w: photo.w, h: photo.h, cached: true } };
  }
  const env = opts.env || process.env;
  const none = (reason) => ({ data: { source: "none", reason, lines: [], w: photo.w, h: photo.h } });
  if (!String(env.ANTHROPIC_API_KEY || "").trim()) return none("no_key");
  const over = await spend(ctx.user && ctx.user.id, env);
  if (over === "per_minute") throw new RateLimited("That's a lot of mockups in a minute. Wait a moment and try again.", 60);
  if (over) return none(over);
  const got = await askClaude(photo, opts);
  if (!got.ok) return none(got.reason);
  const parsed = parseLines(got.answer, photo.w, photo.h);
  if (!parsed.usable) return none("unusable");
  await putRaw(linesKey(p.id), { at: photo.at, lines: parsed.lines, model: CLAUDE_MODEL, made_at: nowIso() }).catch(() => {});
  return { data: { source: "claude", lines: parsed.lines, w: photo.w, h: photo.h } };
}

const R = (method, path, perm, handler, extra = {}) => ({ method, path, auth: "session", perm, subject: "none", mode: "inline", handler, ...extra });

export const mockupRoutes = [
  R("POST", "/lights-mockup/photo", "quotes:write", (ctx) => photoRoute(ctx), { maxCalls: 12, budgetMs: 9500 }),
  R("GET", "/lights-mockup/:property/photo.jpg", "quotes:read", photoFileRoute),
  R("POST", "/lights-mockup/lines", "quotes:write", (ctx) => linesRoute(ctx), { maxCalls: 12, budgetMs: 9800, idempotent: false }),
];
