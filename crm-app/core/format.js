// Barta CRM client: how numbers, dates and phones read on screen (design
// §9.4): money as "$1,234.50" (integer cents in, never floats), dates as
// "Wed, Nov 19" in America/Chicago whatever the phone's zone, times as
// "8:00 AM", windows as "8:00–10:00 AM", phones as "(763) 555-0100".
// Pure functions: node --test can import this file.

export const TZ = "America/Chicago";

export function money(cents, { sign = false } = {}) {
  if (cents === null || cents === undefined || cents === "") return "";
  const n = typeof cents === "bigint" ? cents : BigInt(Math.trunc(Number(cents)));
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const dollars = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const c = (abs % 100n).toString().padStart(2, "0");
  return `${neg ? "−" : sign ? "+" : ""}$${dollars}.${c}`;
}

const fmt = (opts) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, ...opts });
const F = {
  short: fmt({ weekday: "short", month: "short", day: "numeric" }),
  long: fmt({ weekday: "long", month: "long", day: "numeric" }),
  dateYear: fmt({ month: "short", day: "numeric", year: "numeric" }),
  time: fmt({ hour: "numeric", minute: "2-digit" }),
  ymd: fmt({ year: "numeric", month: "2-digit", day: "2-digit" }),
};
const toDate = (d) => (d instanceof Date ? d : new Date(d));
const valid = (d) => d instanceof Date && !Number.isNaN(d.getTime());

// A YYYY-MM-DD local date is read at noon UTC so it never shifts a day.
const fromLocal = (s) => (typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + "T18:00:00Z") : toDate(s));

export const dateShort = (d) => { const x = fromLocal(d); return valid(x) ? F.short.format(x) : ""; };      // "Wed, Nov 19"
export const dateLong = (d) => { const x = fromLocal(d); return valid(x) ? F.long.format(x) : ""; };        // "Wednesday, November 19"
export const dateYear = (d) => { const x = fromLocal(d); return valid(x) ? F.dateYear.format(x) : ""; };    // "Nov 19, 2026"
export const time = (d) => { const x = toDate(d); return valid(x) ? F.time.format(x) : ""; };               // "8:00 AM"
export const dateTime = (d) => (valid(toDate(d)) ? `${dateShort(d)} · ${time(d)}` : "");

// "YYYY-MM-DD" of an instant in the company's zone.
export function localDate(d = new Date()) {
  const p = Object.fromEntries(F.ymd.formatToParts(toDate(d)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

// "HH:MM" (24 h) → "8:00 AM"
export function clock(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ""));
  if (!m) return "";
  const h = Number(m[1]);
  return `${((h + 11) % 12) + 1}:${m[2]} ${h < 12 ? "AM" : "PM"}`;
}
// "08:00", "10:00" → "8:00–10:00 AM" (one AM/PM when both share it)
export function timeWindow(start, end) {
  const a = clock(start), b = clock(end);
  if (!a || !b) return a || b || "";
  const [ta, pa] = a.split(" "), [tb, pb] = b.split(" ");
  return pa === pb ? `${ta}–${tb} ${pb}` : `${a}–${b}`;
}

export function phone(v) {
  let d = String(v || "").replace(/\D/g, "");
  if (d.length === 11 && d[0] === "1") d = d.slice(1);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(v || "");
}

// "just now", "5 min ago", "3 h ago", "yesterday", "Nov 3"
export function ago(d, now = new Date()) {
  const x = toDate(d);
  if (!valid(x)) return "";
  const s = Math.round((toDate(now) - x) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 2 * 86400) return "yesterday";
  return dateShort(x);
}

export const initials = (name) => String(name || "").trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";
export const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
export const roleLabel = (r) => ({ owner: "Owner", admin: "Office", tech: "Technician" })[r] || r || "";
