// Barta CRM core: the one clock and the calendar (design §7.4, §12.6).
//
// now() is the only source of "what time is it" in netlify/lib/crm/**: tests
// pin it with setNow(), so nothing depends on the real date (the lesson of
// the giveaway tests that broke when the giveaway closed). Elapsed-time
// measurements for timeouts and budgets use performance.now() instead,
// which is monotonic and never a date.
//
// Business time is America/Chicago. Conversions use Intl.DateTimeFormat
// offset probing (no library), so the DST changes (2026-11-01, 2027-03-14,
// 2027-11-07) are handled by the platform's time-zone data:
//   - a local time that happens twice (fall back, 01:00-01:59) resolves to
//     the first occurrence (CDT);
//   - a local time that never happens (spring forward, 02:00-02:59) moves
//     forward by the gap (02:30 becomes 03:30 CDT).

export const TZ = "America/Chicago";

let pinned = null;

// The current time as a new Date (a pinned copy in tests).
export function now() {
  return pinned === null ? new Date() : new Date(pinned);
}
export const nowMs = () => now().getTime();
export const nowIso = () => now().toISOString();

// Pins now() to a Date, an ISO string or epoch ms; null unpins.
export function setNow(at) {
  if (at === null || at === undefined) { pinned = null; return; }
  const ms = at instanceof Date ? at.getTime() : typeof at === "number" ? at : Date.parse(at);
  if (!Number.isFinite(ms)) throw new TypeError("setNow: not a time");
  pinned = ms;
}
export const isPinned = () => pinned !== null;

const toDate = (d) => (d instanceof Date ? d : new Date(d));
const pad = (n, w = 2) => String(n).padStart(w, "0");

const fmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short",
});
const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// { y, m, d, hh, mm, ss, dow } of an instant in America/Chicago.
export function localParts(d) {
  const out = {};
  for (const p of fmt.formatToParts(toDate(d))) out[p.type] = p.value;
  return { y: +out.year, m: +out.month, d: +out.day, hh: +out.hour % 24, mm: +out.minute, ss: +out.second, dow: DOW[out.weekday] };
}

export function localDate(d) { const p = localParts(d); return `${pad(p.y, 4)}-${pad(p.m)}-${pad(p.d)}`; }
export function localTime(d) { const p = localParts(d); return `${pad(p.hh)}:${pad(p.mm)}`; }
export function localDow(d) { return localParts(d).dow; }

// Minutes the local wall clock is ahead of UTC at an instant (-300 or -360 here).
export function offsetMinutes(ms) {
  const p = localParts(new Date(ms));
  const wall = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
  return Math.round((wall - Math.floor(ms / 1000) * 1000) / 60000);
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const isLocalDate = (s) => typeof s === "string" && DATE_RE.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z")) && new Date(s + "T00:00:00Z").toISOString().slice(0, 10) === s;
export const isLocalTime = (s) => typeof s === "string" && TIME_RE.test(s);

// The UTC instant of a local date and "HH:MM" in America/Chicago.
export function zonedToUtc(date, hhmm = "00:00") {
  if (!isLocalDate(date)) throw new TypeError("zonedToUtc: date must be YYYY-MM-DD");
  if (!isLocalTime(hhmm)) throw new TypeError("zonedToUtc: time must be HH:MM");
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = hhmm.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const before = offsetMinutes(guess - 86400000);
  const after = offsetMinutes(guess + 86400000);
  const candidates = [...new Set([guess - before * 60000, guess - after * 60000])].sort((a, b) => a - b);
  const fits = candidates.filter((c) => localDate(c) === date && localTime(c) === hhmm);
  if (fits.length) return new Date(fits[0]);          // first occurrence on a fall-back day
  return new Date(guess - before * 60000);            // inside the spring-forward gap: shifted forward
}

// "YYYY-MM-DD" plus n calendar days.
export function addLocalDays(date, n) {
  if (!isLocalDate(date)) throw new TypeError("addLocalDays: date must be YYYY-MM-DD");
  const t = Date.parse(date + "T00:00:00Z") + Math.trunc(n) * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

export const startOfLocalDay = (d) => zonedToUtc(localDate(d), "00:00");

// Day of week (0 = Sunday) of a local date string.
export const dowOfDate = (date) => new Date(date + "T12:00:00Z").getUTCDay();

// Sortable UTC key: yyyymmddthhmmssmmmz (design §3.2).
export function tsKey(d = now()) {
  return toDate(d).toISOString().replace(/[-:.]/g, "").toLowerCase();
}
const TSKEY_RE = /^(\d{4})(\d{2})(\d{2})t(\d{2})(\d{2})(\d{2})(\d{3})z$/;
export function fromTsKey(k) {
  const m = TSKEY_RE.exec(String(k));
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]));
}
export const isTsKey = (k) => TSKEY_RE.test(String(k));

// --- calendar ---------------------------------------------------------------

// cfg/hours defaults (website hours, C19); null = closed.
export const DEFAULT_HOURS = Object.freeze({
  0: null, 1: ["08:00", "18:00"], 2: ["08:00", "18:00"], 3: ["08:00", "18:00"],
  4: ["08:00", "18:00"], 5: ["08:00", "18:00"], 6: ["08:00", "17:00"],
});
// cfg/calendar defaults: rule names plus extra dates the owner adds (G39).
export const DEFAULT_CALENDAR = Object.freeze({ rules: ["thanksgiving", "christmas"], dates: [] });

export function thanksgiving(year) {
  const firstDow = new Date(Date.UTC(year, 10, 1)).getUTCDay();
  const firstThu = 1 + ((4 - firstDow + 7) % 7);
  return `${year}-11-${pad(firstThu + 21)}`;
}

export function isHoliday(date, calendar = DEFAULT_CALENDAR) {
  if (!isLocalDate(date)) return false;
  const year = +date.slice(0, 4);
  const rules = (calendar && calendar.rules) || [];
  if (rules.includes("thanksgiving") && date === thanksgiving(year)) return true;
  if (rules.includes("christmas") && date.slice(5) === "12-25") return true;
  return Array.isArray(calendar && calendar.dates) && calendar.dates.includes(date);
}

// Whether the business is open at an instant (cfg/hours shape: dow → [from, to] | null).
export function isBusinessOpen(d, hours = DEFAULT_HOURS, calendar = DEFAULT_CALENDAR) {
  const date = localDate(d);
  if (isHoliday(date, calendar)) return false;
  const span = hours[localDow(d)];
  if (!span) return false;
  const t = localTime(d);
  return t >= span[0] && t < span[1];
}

// The earliest instant at or after d that a rule allows (quiet hours, §7.5).
// rule = { from: "HH:MM", to: "HH:MM", days?: [0..6] (default every day),
//          skipHolidays?: boolean, calendar? }. Searches up to 21 days ahead.
export function nextAllowed(d, rule) {
  const at = toDate(d);
  const days = Array.isArray(rule.days) ? rule.days : [0, 1, 2, 3, 4, 5, 6];
  let date = localDate(at);
  for (let i = 0; i < 21; i++, date = addLocalDays(date, 1)) {
    if (!days.includes(dowOfDate(date))) continue;
    if (rule.skipHolidays && isHoliday(date, rule.calendar || DEFAULT_CALENDAR)) continue;
    const start = zonedToUtc(date, rule.from);
    const end = zonedToUtc(date, rule.to);
    if (at < start) return start;
    if (at < end) return new Date(at);
  }
  throw new RangeError("nextAllowed: no allowed time in the next 21 days");
}
