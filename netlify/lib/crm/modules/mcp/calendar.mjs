// Calendar feed (iCal): a private, revocable link a person's Google
// Calendar or Apple Calendar subscribes to, so their visits show on their
// own phone calendar and follow the schedule as it changes.
//
//   GET    /calendar-feed          account:own   whether mine is on: { on, scope, last4, created_at, can_all }
//   POST   /calendar-feed {scope}  account:own   turn it on, or get a NEW link (the old one stops): the link, shown once
//   PATCH  /calendar-feed {scope}  account:own   mine (my visits) or all (everyone's, for the office)
//   DELETE /calendar-feed          account:own   turn it off (the link stops at once)
//   GET    /cal/:token             public        the feed itself (text/calendar), /api/crm/cal/bcal_….ics
//
// Who: anyone who sees the schedule (schedule:read). A technician's feed
// holds their own visits only; an owner or the office may pick everyone's.
// What: each visit's day and time in America/Chicago (a VTIMEZONE block;
// a visit with no time is an all-day event), the customer's FIRST NAME,
// the town and the service. Never a last name, phone, email, street,
// gate code, note or price. Cancelled visits drop out. The window is 30
// days back to 120 days ahead, read from the visit index on every fetch,
// so a moved visit moves on the next refresh.
//
// The token is "bcal_" + 32 random bytes (base64url), stored only as its
// sha256: ptr/cal-feed/{sha256} = { user_id } and the person's own
// ptr/cal-feed-user/{uid} = { hash, scope, last4, created_at }. A fetch
// needs both to agree, so a new link or "off" kills the old one even if
// a delete was lost. A disabled person's feed stops too.

import { createHash, randomBytes } from "node:crypto";
import { getRaw, settledWrite, deleteRaw, readIndex, getRecord, appendEvent } from "../../../crm-store.mjs";
import { now, nowIso, localDate, addLocalDays, TZ } from "../../core/clock.mjs";
import { InputError, ForbiddenError, ConflictError } from "../../core/errors.mjs";
import { holds } from "../../core/perms.mjs";
import { CANONICAL_ORIGIN } from "../../core/context.mjs";
import { loadPermissions } from "../../core/auth.mjs";

export const TOKEN_RE = /^bcal_[A-Za-z0-9_-]{43}$/;
export const SCOPES = Object.freeze(["mine", "all"]);
export const DAYS_BACK = 30;
export const DAYS_AHEAD = 120;
const HOST = "bartawindowwashing.com";

const sha = (s) => createHash("sha256").update(String(s)).digest("hex");
const TOKEN_KEY = (hash) => `ptr/cal-feed/${hash}`;
const USER_KEY = (uid) => `ptr/cal-feed-user/${uid}`;
export const newToken = () => "bcal_" + randomBytes(32).toString("base64url");
export const feedUrl = (token) => `${CANONICAL_ORIGIN}/api/crm/cal/${token}.ics`;
const strip = (d) => { if (!d) return d; const { _w, ...rest } = d; return rest; };

// ------------------------------------------------------------ who may have what

function mayFeed(user, permissions) {
  const h = holds(user, "schedule:read", permissions);
  if (!h) return null;
  return { all: h === true };                                  // "own" (a tech): their visits only
}

async function mine(uid) {
  const got = await getRaw(USER_KEY(uid));
  return got && got.data ? { doc: strip(got.data), etag: got.etag } : null;
}
const view = (doc, may) => ({ on: !!doc, scope: doc ? doc.scope : null, last4: doc ? doc.last4 : null, created_at: doc ? doc.created_at : null, can_all: !!(may && may.all) });

function needFeed(ctx) {
  const may = mayFeed(ctx.user, ctx.permissions);
  if (!may) throw new ForbiddenError("A calendar feed is for people who see the schedule.");
  return may;
}
function scopeFrom(body, may, fallback = "mine") {
  const s = body && body.scope !== undefined ? body.scope : fallback;
  if (!SCOPES.includes(s)) throw new InputError("Pick your visits or everyone's.", "scope");
  if (s === "all" && !may.all) throw new ForbiddenError("Everyone's visits are for the office.");
  return s;
}

async function getFeed(ctx) {
  const may = needFeed(ctx);
  const m = await mine(ctx.user.id);
  return { data: view(m && m.doc, may) };
}

// On, or a new link: the old token stops working. → { token, doc, rotated }
export async function issueFeed(userId, scope) {
  const had = await mine(userId);
  const token = newToken();
  const hash = sha(token);
  const at = nowIso();
  const t = await settledWrite(TOKEN_KEY(hash), { user_id: userId, created_at: at }, { onlyIfNew: true });
  if (!t.ok) throw new ConflictError("Try again.");
  const doc = { hash, scope, last4: token.slice(-4), created_at: at };
  const w = await settledWrite(USER_KEY(userId), doc, had ? { onlyIfMatch: had.etag } : { onlyIfNew: true });
  if (!w.ok) { await deleteRaw(TOKEN_KEY(hash)).catch(() => {}); throw new ConflictError("This changed on another phone. Try again."); }
  if (had && had.doc.hash) await deleteRaw(TOKEN_KEY(had.doc.hash)).catch(() => {});
  return { token, doc, rotated: !!had };
}

async function newFeed(ctx) {
  const may = needFeed(ctx);
  const had = await mine(ctx.user.id);
  const scope = scopeFrom(ctx.body, may, had ? had.doc.scope : "mine");
  const { token, doc, rotated } = await issueFeed(ctx.user.id, scope);
  await appendEvent("user", ctx.user.id, { action: rotated ? "calendar_feed_rotated" : "calendar_feed_on", by: ctx.user.id, origin: "api", scope }).catch(() => {});
  const url = feedUrl(token);
  return { status: 201, data: { ...view(doc, may), url, webcal_url: url.replace(/^https:/, "webcal:") } };
}

async function patchFeed(ctx) {
  const may = needFeed(ctx);
  const had = await mine(ctx.user.id);
  if (!had) throw new InputError("Turn the calendar feed on first.", "scope");
  const scope = scopeFrom(ctx.body, may, had.doc.scope);
  if (scope !== had.doc.scope) {
    const w = await settledWrite(USER_KEY(ctx.user.id), { ...had.doc, scope }, { onlyIfMatch: had.etag });
    if (!w.ok) throw new ConflictError("This changed on another phone. Try again.");
  }
  return { data: view({ ...had.doc, scope }, may) };
}

async function deleteFeed(ctx) {
  const had = await mine(ctx.user.id);
  if (had) {
    await deleteRaw(USER_KEY(ctx.user.id));
    if (had.doc.hash) await deleteRaw(TOKEN_KEY(had.doc.hash)).catch(() => {});
    await appendEvent("user", ctx.user.id, { action: "calendar_feed_off", by: ctx.user.id, origin: "api" }).catch(() => {});
  }
  return { data: { on: false } };
}

// ------------------------------------------------------------ iCalendar

// RFC 5545 TEXT: backslash, semicolon, comma and newlines escaped.
export const icsText = (s) => String(s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
// Lines longer than 75 octets fold onto continuation lines (never inside a UTF-8 character).
export function fold(line) {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const out = [];
  let cur = "";
  let len = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch, "utf8");
    const max = out.length ? 74 : 75;
    if (len + n > max) { out.push(cur); cur = ""; len = 0; }
    cur += ch; len += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}
const stamp = (iso) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const dateVal = (d) => d.replace(/-/g, "");
const localVal = (d, hhmm) => `${dateVal(d)}T${hhmm.replace(":", "")}00`;
const addMin = (hhmm, n) => { const t = Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5)) + n; const c = Math.min(t, 23 * 60 + 59); return `${String(Math.floor(c / 60)).padStart(2, "0")}:${String(c % 60).padStart(2, "0")}`; };
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const clock12 = (hhmm) => { const h = Number(hhmm.slice(0, 2)); const m = hhmm.slice(3); return `${h % 12 || 12}${m === "00" ? "" : ":" + m} ${h < 12 ? "am" : "pm"}`; };

export const VTIMEZONE = [
  "BEGIN:VTIMEZONE", `TZID:${TZ}`, `X-LIC-LOCATION:${TZ}`,
  "BEGIN:DAYLIGHT", "TZOFFSETFROM:-0600", "TZOFFSETTO:-0500", "TZNAME:CDT", "DTSTART:19700308T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU", "END:DAYLIGHT",
  "BEGIN:STANDARD", "TZOFFSETFROM:-0500", "TZOFFSETTO:-0600", "TZNAME:CST", "DTSTART:19701101T020000", "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU", "END:STANDARD",
  "END:VTIMEZONE",
];

// "Pat Example" → "Pat" (a first name only, whatever the row holds)
export const firstName = (full) => String(full || "").trim().split(/\s+/)[0].replace(/[^\p{L}\p{M}'.-]/gu, "").slice(0, 30);
const SERVICE_SHORT = { "Residential Window Cleaning": "Window cleaning", "Commercial Window Cleaning": "Window cleaning", "Gutter Cleaning": "Gutters", "Christmas Lights": "Christmas lights" };
const serviceOf = (r) => {
  const svc = (Array.isArray(r.svc) ? r.svc : []).map((s) => SERVICE_SHORT[String(s).split("::")[0]] || String(s).split("::")[0]).filter(Boolean);
  return [...new Set(svc)].slice(0, 3).join(", ") || (r.k === "lights_install" ? "Christmas lights" : "Visit");
};
const STATUS_NOTE = { completed: "Done", no_access: "No access", in_progress: "In progress", en_route: "On the way", paused: "Paused" };

// One VEVENT for an index row of ix/visits/{month} (contact name → first name only).
export function visitEvent(r, { crew = null, stampAt }) {
  const who = firstName(r.cn);
  const summary = [who, r.town, serviceOf(r)].filter(Boolean).join(" · ");
  const timed = r.do !== true && HHMM.test(r.s || "");
  const lines = ["BEGIN:VEVENT", `UID:${r.id}@${HOST}`, `DTSTAMP:${stampAt}`];
  if (timed) {
    const end = HHMM.test(r.e || "") && r.e > r.s ? r.e : addMin(r.s, (r.w && r.w.m) || 120);
    lines.push(`DTSTART;TZID=${TZ}:${localVal(r.d, r.s)}`, `DTEND;TZID=${TZ}:${localVal(r.d, end)}`);
  } else {
    lines.push(`DTSTART;VALUE=DATE:${dateVal(r.d)}`, `DTEND;VALUE=DATE:${dateVal(addLocalDays(r.d, 1))}`);
  }
  const desc = [
    timed && r.w && r.w.t === "window" ? `Arrival window ${clock12(r.s)} to ${clock12(HHMM.test(r.e || "") && r.e > r.s ? r.e : addMin(r.s, (r.w && r.w.m) || 120))}` : "",
    crew ? `Crew: ${crew}` : "", STATUS_NOTE[r.st] || "", `Open in the CRM: ${CANONICAL_ORIGIN}/crm#/visits/${r.id}`,
  ].filter(Boolean).join("\n");
  lines.push(`SUMMARY:${icsText(summary)}`);
  if (r.town) lines.push(`LOCATION:${icsText(r.town)}`);
  lines.push(`DESCRIPTION:${icsText(desc)}`, "STATUS:CONFIRMED", "TRANSP:OPAQUE");
  if (r.u) { try { lines.push(`LAST-MODIFIED:${stamp(r.u)}`); } catch { /* an odd stamp is left out */ } }
  lines.push("END:VEVENT");
  return lines;
}

export function buildCalendar(rows, { name, crewOf = null } = {}) {
  const stampAt = stamp(nowIso());
  const out = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Barta Window Washing//CRM calendar feed//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsText(name || "Barta visits")}`, `X-WR-TIMEZONE:${TZ}`, "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H", ...VTIMEZONE];
  for (const r of rows) out.push(...visitEvent(r, { crew: crewOf ? crewOf(r) : null, stampAt }));
  out.push("END:VCALENDAR");
  return out.map(fold).join("\r\n") + "\r\n";
}

const monthsOf = (from, to) => {
  const out = [];
  let [y, m] = from.slice(0, 7).split("-").map(Number);
  const [ey, em] = to.slice(0, 7).split("-").map(Number);
  while (y < ey || (y === ey && m <= em)) { out.push(`${y}-${String(m).padStart(2, "0")}`); m += 1; if (m > 12) { m = 1; y += 1; } }
  return out;
};

// The rows a feed holds: the window's visits (not cancelled), mine or everyone's.
export async function feedRows(user, scope) {
  const today = localDate(now());
  const from = addLocalDays(today, -DAYS_BACK);
  const to = addLocalDays(today, DAYS_AHEAD);
  const got = await Promise.all(monthsOf(from, to).map((m) => readIndex("visits", m)));
  return got.flatMap((g) => g.rows)
    .filter((r) => r && r.d >= from && r.d <= to && r.st !== "cancelled")
    .filter((r) => scope === "all" || (Array.isArray(r.a) && r.a.includes(user.id)))
    .sort((a, b) => (a.d + (a.s || "")).localeCompare(b.d + (b.s || "")) || String(a.id).localeCompare(String(b.id)));
}

const notFound = () => new Response("Not found\n", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

async function serveFeed(ctx) {
  const raw = String(ctx.params.token || "").replace(/\.ics$/i, "");
  if (!TOKEN_RE.test(raw)) return notFound();
  const hash = sha(raw);
  const t = await getRaw(TOKEN_KEY(hash));
  if (!t || !t.data || !t.data.user_id) return notFound();
  const [m, u] = await Promise.all([mine(t.data.user_id), getRecord("user", t.data.user_id)]);
  const user = u && u.data;
  if (!m || m.doc.hash !== hash || !user || user.status !== "active") return notFound();
  const may = mayFeed(user, await loadPermissions());
  if (!may) return notFound();
  const scope = m.doc.scope === "all" && may.all ? "all" : "mine";
  const rows = await feedRows(user, scope);
  let crewOf = null;
  if (scope === "all") {
    const ix = await readIndex("users", "");
    const names = new Map(ix.rows.map((x) => [x.id, x.first_name || firstName(x.name)]));
    crewOf = (r) => (r.a || []).map((id) => names.get(id)).filter(Boolean).join(", ");
  }
  const who = user.first_name || firstName(user.name);
  const body = buildCalendar(rows, { name: scope === "all" ? "Barta: everyone's visits" : `Barta visits (${who})`, crewOf });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": 'inline; filename="barta-visits.ics"', "Cache-Control": "private, max-age=300" } });
}

const S = (method, path, handler, more = {}) => ({ method, path, auth: "session", perm: "account:own", subject: "none", mode: "inline", handler, ...more });
export const calendarRoutes = [
  S("GET", "/calendar-feed", getFeed),
  S("POST", "/calendar-feed", newFeed, { secret: true, idempotent: false }),
  S("PATCH", "/calendar-feed", patchFeed),
  S("DELETE", "/calendar-feed", deleteFeed),
  { method: "GET", path: "/cal/:token", auth: "public", perm: null, subject: "none", mode: "inline", handler: serveFeed, maxCalls: 30 },
];
