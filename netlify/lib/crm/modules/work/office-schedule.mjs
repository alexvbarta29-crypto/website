// Work module, office part: what the schedule reads and works out (design
// §5.5 "Arrival windows", "Assignment and availability", "Route order",
// "Booking hint", §9.2 Schedule). Pure helpers first (no I/O, unit-tested),
// then the reads the schedule routes make from index blobs (never one
// record per row):
//
//   arrivalWindow(visit, hours)   the customer's wording: "at 8:00 AM",
//                                 "arriving between 8:00 and 10:00 AM",
//                                 "anytime between 8:00 AM and 6:00 PM" (D16)
//   visitVars(visit, hours)       the template variables of a visit
//   slotWarnings(slot, env)       conflicts that warn, never block: holiday,
//                                 closed or outside hours, not working then,
//                                 time off, another visit or a timed task
//                                 (estimate visit, meeting, personal block)
//   townHints(slot, rows)         "Crew is already in Mound on Wed, Nov 19"
//   routeOrder(stops, base)       nearest neighbour + 2-opt over haversine
//                                 miles, never placing a visit after one
//                                 whose arrival window ends earlier
//   scheduleRange(...)            visits, timed tasks and time off for days
//   capacityOf(from, to, env)     how many visits each day can take (the
//                                 crew's number, less whoever is off; 0
//                                 when closed), for the month's fill bars

import { readIndex, getRecords, getSetting } from "../../../crm-store.mjs";
import { DEFAULT_HOURS, DEFAULT_CALENDAR, isHoliday, thanksgiving, dowOfDate, addLocalDays, localDate, localTime, isLocalDate, zonedToUtc } from "../../core/clock.mjs";
import { InputError } from "../../core/errors.mjs";
import { haversineMi } from "../contacts/display.mjs";

// ------------------------------------------------------------ times and words

export const toMin = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
export const fromMin = (n) => `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
// "08:00" → "8:00 AM"
export function clock12(hhmm) {
  const n = toMin(hhmm);
  if (n === null) return "";
  const h = Math.floor(n / 60) % 24;
  return `${((h + 11) % 12) + 1}:${String(n % 60).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}
// "08:00", "10:00" → "8:00 and 10:00 AM"; "11:00", "13:00" → "11:00 AM and 1:00 PM"
export function betweenText(a, b) {
  const x = clock12(a), y = clock12(b);
  if (!x || !y) return x || y;
  const [tx, px] = x.split(" ");
  return px === y.split(" ")[1] ? `${tx} and ${y}` : `${x} and ${y}`;
}

const DATE_FMT = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
// "2026-11-19" → "Thu, Nov 19" (a local date, read at noon UTC so it never shifts)
export const dateText = (date) => (isLocalDate(date) ? DATE_FMT.format(new Date(date + "T12:00:00Z")) : "");

// The business hours of a date: ["08:00", "18:00"] or null (closed, a holiday).
export function hoursOn(date, hours = DEFAULT_HOURS, calendar = DEFAULT_CALENDAR) {
  if (!isLocalDate(date)) return null;
  if (isHoliday(date, calendar)) return null;
  const span = (hours || DEFAULT_HOURS)[dowOfDate(date)];
  return Array.isArray(span) && span.length === 2 ? span : null;
}

// When a visit's arrival window ends, in minutes of the day (exact: the
// start; anytime: closing time, else the end of the day).
export function windowEnd(visit, hours = DEFAULT_HOURS) {
  const start = toMin(visit.start) ?? 0;
  const w = visit.window || {};
  if (visit.date_only || w.type === "anytime") {
    const span = (hours || DEFAULT_HOURS)[dowOfDate(visit.date)];
    return Array.isArray(span) ? toMin(span[1]) : 24 * 60;
  }
  if (w.type === "exact") return start;
  return Math.min(24 * 60 - 1, start + (Number(w.minutes) || 0));
}

// The customer's wording of the arrival window (§5.5, D16).
export function arrivalWindow(visit, hours = DEFAULT_HOURS) {
  const w = visit.window || {};
  if (visit.date_only || w.type === "anytime") {
    const span = (hours || DEFAULT_HOURS)[dowOfDate(visit.date)];
    const [a, b] = Array.isArray(span) ? span : (DEFAULT_HOURS[1] || ["08:00", "18:00"]);
    return `anytime between ${clock12(a)} and ${clock12(b)}`;
  }
  if (w.type === "exact" || !(Number(w.minutes) > 0)) return `at ${clock12(visit.start)}`;
  return `arriving between ${betweenText(visit.start, fromMin(windowEnd(visit, hours)))}`;
}

// "Residential Window Cleaning", "Exterior Cleaning::Gutters" → "window cleaning and exterior cleaning".
// "Exterior Cleaning" says what the job's title says it is, when it does
// (gutters, a house wash, pressure washing).
export function serviceList(types = [], title = "") {
  const t0 = String(title || "").toLowerCase();
  const exterior = /gutter/.test(t0) ? "gutter cleaning" : /house wash|soft wash/.test(t0) ? "house washing" : /pressure|power wash/.test(t0) ? "pressure washing" : "exterior cleaning";
  const words = [...new Set((types || []).map((t) => String(t || "").split("::")[0].trim()).filter(Boolean).map((t) => {
    const l = t.toLowerCase();
    if (/window/.test(l)) return "window cleaning";
    if (/gutter/.test(l)) return "gutter cleaning";
    if (/light/.test(l)) return "Christmas lights";
    if (l === "exterior cleaning") return exterior;
    return l;
  }))];
  if (!words.length) return "your service";
  return words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

// The template variables of a visit (§5.7.3: visit_date, visit_time, arrival_window, town, service_list).
export function visitVars(visit, hours = DEFAULT_HOURS) {
  return {
    visit_date: dateText(visit.date),
    visit_time: visit.date_only ? null : clock12(visit.start),
    arrival_window: arrivalWindow(visit, hours),
    ...(visit.town ? { town: visit.town } : {}),
    service_list: serviceList(visit.service_types, visit.job_title),
  };
}

// ------------------------------------------------------------ conflicts

const overlaps = (a0, a1, b0, b1) => a0 < b1 && b0 < a1;
const firstName = (u) => (u && (u.first_name || String(u.name || "").split(/\s+/)[0])) || "Someone";
const DEAD = new Set(["cancelled", "no_access"]);
export const TIMED_TASK_KINDS = Object.freeze(["estimate_visit", "meeting", "personal"]);
const TASK_LABEL = { estimate_visit: "an estimate visit", meeting: "a meeting", personal: "a personal block" };

// A timed task row (tasks/open: due, end in UTC) as a local slot, or null.
export function taskSlot(row) {
  if (!row || !TIMED_TASK_KINDS.includes(row.k) || !row.due || !row.end) return null;
  const s = new Date(row.due), e = new Date(row.end);
  if (!Number.isFinite(s.getTime()) || !Number.isFinite(e.getTime()) || e <= s) return null;
  const date = localDate(s);
  const endDate = localDate(e);
  return { id: row.id, kind: row.k, title: row.t || "", date, start: localTime(s), end: endDate === date ? localTime(e) : "23:59", a: row.a || [], c: row.c || null, cn: row.cn || "" };
}

// The Day view's "Sales rep" columns: open sales tasks with a time on
// from..to (estimate visits, meetings, calls and follow-ups to make, and
// personal blocks), as { id, kind, title, date, start, end, a, c, cn, pr,
// do }. A call or follow-up with no end takes 30 minutes; one due at
// midnight has no real time (do: true, "anytime that day").
export const SALES_KINDS = Object.freeze(["estimate_visit", "meeting", "call", "follow_up", "personal"]);
export function salesSlots(rows = [], from, to) {
  const out = [];
  for (const r of rows) {
    if (!r || !SALES_KINDS.includes(r.k) || !r.due) continue;
    const s = new Date(r.due);
    if (!Number.isFinite(s.getTime())) continue;
    const date = localDate(s);
    if (date < from || date > to) continue;
    const start = localTime(s);
    const e = r.end ? new Date(r.end) : null;
    const end = e && Number.isFinite(e.getTime()) && e > s ? (localDate(e) === date ? localTime(e) : "23:59") : fromMin(Math.min(23 * 60 + 59, toMin(start) + 30));
    out.push({ id: r.id, kind: r.k, title: r.t || "", date, start, end, a: r.a || [], c: r.c || null, cn: r.cn || "", pr: r.pr || null, ...(start === "00:00" && !r.end ? { do: true } : {}) });
  }
  return out.sort((x, y) => (x.date + x.start).localeCompare(y.date + y.start));
}

// Warnings for a slot (never blocking): [{ code, user_id?, ref?, message }].
// slot = { date, start, end, assignee_ids, visit_id? }; env = { visits: visit
// rows that day, tasks: taskSlot()s that day, timeOff: time-off rows, users:
// Map(id → user record), hours, calendar }.
export function slotWarnings(slot, env = {}) {
  const out = [];
  const { date, start, end } = slot;
  const s = toMin(start), e = toMin(end);
  if (!isLocalDate(date) || s === null || e === null) return out;
  const hours = env.hours || DEFAULT_HOURS;
  const calendar = env.calendar || DEFAULT_CALENDAR;
  if (isHoliday(date, calendar)) {
    const name = date === thanksgiving(Number(date.slice(0, 4))) ? "Thanksgiving" : date.slice(5) === "12-25" ? "Christmas" : "a holiday";
    out.push({ code: "holiday", message: `That's ${name}.` });
  }
  const span = (hours || {})[dowOfDate(date)];
  if (!Array.isArray(span)) out.push({ code: "closed", message: "We're closed that day." });
  else if (s < toMin(span[0]) || e > toMin(span[1])) out.push({ code: "outside_hours", message: `Outside business hours (${clock12(span[0])} to ${clock12(span[1])}).` });
  const users = env.users instanceof Map ? env.users : new Map();
  const slotS = zonedToUtc(date, fromMin(Math.min(s, 1439))).getTime();
  const slotE = zonedToUtc(date, fromMin(Math.min(e, 1439))).getTime();
  for (const uid of slot.assignee_ids || []) {
    const u = users.get(uid);
    const who = firstName(u);
    const avail = u && Array.isArray(u.availability) ? u.availability : null;
    if (avail && avail.length) {
      const dow = dowOfDate(date);
      const fits = avail.some((x) => x && x.dow === dow && toMin(x.start) <= s && toMin(x.end) >= e);
      if (!fits) out.push({ code: "unavailable", user_id: uid, message: `${who} isn't usually working then.` });
    }
    for (const t of env.timeOff || []) {
      if (t.uid !== uid || t.av) continue;
      const ts = Date.parse(t.s), te = t.e ? Date.parse(t.e) : Infinity;
      if (overlaps(slotS, slotE, ts, te)) out.push({ code: "time_off", user_id: uid, ref: t.id, message: `${who} is off${t.r ? ` (${t.r})` : ""}.` });
    }
    for (const v of env.visits || []) {
      if (v.id === slot.visit_id || v.d !== date || DEAD.has(v.st) || !(v.a || []).includes(uid)) continue;
      if (overlaps(s, e, toMin(v.s), toMin(v.e))) out.push({ code: "overlap_visit", user_id: uid, ref: v.id, message: `${who} has another visit ${clock12(v.s)} to ${clock12(v.e)}${v.town ? ` in ${v.town}` : ""}.` });
    }
    for (const t of env.tasks || []) {
      if (t.date !== date || !(t.a || []).includes(uid)) continue;
      if (overlaps(s, e, toMin(t.start), toMin(t.end))) out.push({ code: "overlap_task", user_id: uid, ref: t.id, message: `${who} has ${TASK_LABEL[t.kind] || "something booked"} ${clock12(t.start)} to ${clock12(t.end)}.` });
    }
  }
  return out;
}

// "Crew is already in {town} on {date}" (P1, cheap): other visits that day
// in the same town.
export function townHints(slot, rows = []) {
  const town = String(slot.town || "").trim().toLowerCase();
  if (!town) return [];
  const same = rows.filter((v) => v.id !== slot.visit_id && v.d === slot.date && !DEAD.has(v.st) && String(v.town || "").trim().toLowerCase() === town);
  return same.length ? [{ code: "crew_in_town", message: `Crew is already in ${slot.town} on ${dateText(slot.date)} (${same.length === 1 ? "1 visit" : `${same.length} visits`}).` }] : [];
}

// ------------------------------------------------------------ route order

const pt = (g) => (Array.isArray(g) ? { lat: g[0], lng: g[1] } : g && Number.isFinite(g.lat) ? g : null);
const dist = (a, b) => haversineMi(a, b) ?? 0;
const pathLen = (start, pts) => pts.reduce((sum, p, i) => sum + dist(i ? pts[i - 1].p : start, p.p), 0);

function nearestFirst(start, list) {
  const left = [...list];
  const out = [];
  let at = start;
  while (left.length) {
    let bi = 0, bd = Infinity;
    left.forEach((x, i) => { const d = dist(at, x.p); if (d < bd - 1e-9 || (Math.abs(d - bd) <= 1e-9 && x.id < left[bi].id)) { bd = d; bi = i; } });
    const [next] = left.splice(bi, 1);
    out.push(next);
    at = next.p;
  }
  return out;
}

// 2-opt on an open path that starts at `start` (fixed) and ends anywhere.
function twoOpt(start, pts) {
  let best = pts.slice();
  let bestLen = pathLen(start, best);
  let improved = true;
  for (let guard = 0; improved && guard < 50; guard++) {
    improved = false;
    for (let i = 0; i < best.length - 1; i++) {
      for (let j = i + 1; j < best.length; j++) {
        const cand = [...best.slice(0, i), ...best.slice(i, j + 1).reverse(), ...best.slice(j + 1)];
        const len = pathLen(start, cand);
        if (len < bestLen - 1e-9) { best = cand; bestLen = len; improved = true; }
      }
    }
  }
  return best;
}

// stops: [{ id, geo, start, wend (minutes the window ends) }]; base: { lat, lng }.
// → { order: [ids], no_geo: [ids], miles }. Visits are grouped by when
// their window ends (a visit never goes after one whose window ends
// earlier); each group is driven nearest-first then improved by 2-opt
// from wherever the previous group finished. A stop without a map point
// keeps its place by start time at the end of its group.
export function routeOrder(stops = [], base = null) {
  const groups = new Map();
  for (const s of stops) {
    const k = Number.isFinite(s.wend) ? s.wend : 24 * 60;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  let at = pt(base) || null;
  const order = [];
  const noGeo = [];
  let miles = 0;
  for (const k of [...groups.keys()].sort((a, b) => a - b)) {
    const g = groups.get(k);
    const located = g.filter((s) => pt(s.geo)).map((s) => ({ id: s.id, p: pt(s.geo) }));
    const blind = g.filter((s) => !pt(s.geo)).sort((a, b) => String(a.start).localeCompare(String(b.start)) || (a.id < b.id ? -1 : 1));
    if (located.length) {
      const start = at || located[0].p;
      const path = twoOpt(start, nearestFirst(start, located));
      miles += pathLen(start, path);
      order.push(...path.map((x) => x.id));
      at = path[path.length - 1].p;
    }
    order.push(...blind.map((s) => s.id));
    noGeo.push(...blind.map((s) => s.id));
  }
  return { order, no_geo: noGeo, miles: Math.round(miles * 10) / 10 };
}

// ------------------------------------------------------------ how full a day is

// The people a day's capacity counts: active technicians.
export const crewOf = (userRows = []) => userRows.filter((u) => u && u.is_technician && (u.status === undefined || u.status === "active")).map((u) => u.id);

// Who is off for a whole working day: an all-day time off, or one that
// covers the day's hours (an "available" exception never counts).
export function offOn(date, timeOff = [], hours = DEFAULT_HOURS, calendar = DEFAULT_CALENDAR) {
  const span = hoursOn(date, hours, calendar);
  if (!span) return [];
  const open = zonedToUtc(date, span[0]).getTime(), close = zonedToUtc(date, span[1]).getTime();
  const out = new Set();
  for (const t of timeOff || []) {
    if (!t || t.av || !t.uid) continue;
    const s = Date.parse(t.s), e = t.e ? Date.parse(t.e) : Infinity;
    if (Number.isFinite(s) && s <= open && e >= close) out.add(t.uid);
  }
  return [...out];
}

// How many visits each day of from..to can take: { per_day, per_person,
// days: { date: n }, off: { date: [user ids] } }. per_day is the crew's
// number (cfg/work.visits_per_day); a closed day or a holiday takes 0; a
// day someone on the crew is off takes their share less (the crew's
// number times the share still working, rounded). per_person (one
// person's share, at least 1) is what the bar measures when the schedule
// shows one person.
export function capacityOf(from, to, { perDay = 8, crew = [], timeOff = [], hours = DEFAULT_HOURS, calendar = DEFAULT_CALENDAR } = {}) {
  const n = Math.max(1, Math.round(Number(perDay) || 8));
  const size = crew.length;
  const out = { per_day: n, per_person: Math.max(1, Math.round(n / Math.max(1, size))), days: {}, off: {} };
  for (let d = from, guard = 0; d <= to && guard < 62; d = addLocalDays(d, 1), guard++) {
    if (!hoursOn(d, hours, calendar)) { out.days[d] = 0; continue; }
    const off = size ? offOn(d, timeOff, hours, calendar).filter((u) => crew.includes(u)) : [];
    if (off.length) out.off[d] = off;
    out.days[d] = size ? Math.round((n * (size - off.length)) / size) : n;
  }
  return out;
}

// ------------------------------------------------------------ reads

export const MAX_RANGE_DAYS = 42;

// The "to book" tray of a month (jobs/open rows): jobs with no visit that
// are due by then (no target month, or one up to it), oldest target first.
export const toBookRows = (rows, month) => rows.filter((r) => r.st === "unscheduled" && (!r.tm || r.tm <= month))
  .sort((a, b) => String(a.tm || "").localeCompare(String(b.tm || "")) || String(a.u).localeCompare(String(b.u)));

// The months (yyyy-mm) a date range touches.
export function monthsOf(from, to) {
  const out = [];
  let y = Number(from.slice(0, 4)), m = Number(from.slice(5, 7));
  const end = to.slice(0, 7);
  for (let i = 0; i < 24; i++) {
    const k = `${y}-${String(m).padStart(2, "0")}`;
    out.push(k);
    if (k >= end) break;
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

// The month view's days (US layout): the Sunday on or before the 1st to the
// Saturday on or after the last day, 4 to 6 weeks (never over MAX_RANGE_DAYS).
export function monthGridRange(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || ""))) throw new InputError("Use a month like 2026-11.", "month");
  const [y, m] = month.split("-").map(Number);
  const first = `${month}-01`;
  const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return [addLocalDays(first, -dowOfDate(first)), addLocalDays(last, 6 - dowOfDate(last))];
}

export function checkRange(from, to) {
  if (!isLocalDate(from) || !isLocalDate(to)) throw new InputError("Use dates like 2026-11-17.", "from");
  if (to < from) throw new InputError("The range ends after it starts.", "to");
  if (Date.parse(to) - Date.parse(from) > MAX_RANGE_DAYS * 86400000) throw new InputError(`Look at ${MAX_RANGE_DAYS} days at most.`, "to");
}

// Visit rows dated from..to (from the visits/{yyyy-mm} index shards).
export async function visitRows(from, to, opts = {}) {
  const shards = await Promise.all(monthsOf(from, to).map((m) => readIndex("visits", m, opts)));
  return { rows: shards.flatMap((s) => s.rows).filter((r) => r.d >= from && r.d <= to), stale: shards.some((s) => s.stale) };
}

export async function calendarEnv(opts = {}) {
  const [hours, calendar] = await Promise.all([getSetting("hours", opts).catch(() => ({ ...DEFAULT_HOURS })), getSetting("calendar", opts).catch(() => ({ ...DEFAULT_CALENDAR }))]);
  return { hours, calendar };
}

// Everything the schedule shows for a range of days, with each visit's
// warnings. users: user ids to keep (empty = everyone).
// sales: also the sales tasks with a time (salesSlots), from the same read.
export async function scheduleRange({ from, to, users = [], sales = false }, opts = {}) {
  checkRange(from, to);
  const [{ rows, stale }, tasksIx, offIx, env] = await Promise.all([visitRows(from, to, opts), readIndex("tasks/open", "", opts), readIndex("time-off", "", opts), calendarEnv(opts)]);
  const want = (a) => !users.length || (a || []).some((u) => users.includes(u));
  const visits = rows.filter((r) => want(r.a) || (!users.length && !(r.a || []).length));
  const tasks = tasksIx.rows.map(taskSlot).filter((t) => t && t.date >= from && t.date <= to && want(t.a));
  const fromT = Date.parse(`${from}T00:00:00Z`) - 86400000, toT = Date.parse(`${addLocalDays(to, 1)}T00:00:00Z`) + 86400000;
  const timeOff = offIx.rows.filter((t) => Date.parse(t.s) < toT && (!t.e || Date.parse(t.e) > fromT) && (!users.length || users.includes(t.uid)));
  const uids = [...new Set(visits.flatMap((v) => v.a || []))].slice(0, 20);
  const recs = await getRecords("user", uids, opts);
  const userMap = new Map(recs.filter(Boolean).map((g) => [g.data.id, g.data]));
  const byDay = new Map();
  for (const v of rows) { if (!byDay.has(v.d)) byDay.set(v.d, []); byDay.get(v.d).push(v); }
  const warnings = {};
  for (const v of visits) {
    if (DEAD.has(v.st) || v.st === "completed") continue;
    const w = slotWarnings({ date: v.d, start: v.s, end: v.e, assignee_ids: v.a || [], visit_id: v.id }, { visits: byDay.get(v.d) || [], tasks: tasks.filter((t) => t.date === v.d), timeOff, users: userMap, ...env });
    if (w.length) warnings[v.id] = w;
  }
  return { visits, tasks, time_off: timeOff, warnings, stale, hours: env.hours, calendar: env.calendar, ...(sales ? { sales: salesSlots(tasksIx.rows, from, to).filter((t) => !users.length || want(t.a)) } : {}) };
}

// Each visit's job total as `amt` in cents (the month view's day list, for
// people who may see prices), from the jobs index only: open jobs and the
// years closed jobs are filed under (the range's years up to this one).
// A no-charge job, or one with no row yet, gets no amount.
// openRows: the jobs/open rows when the caller already read them.
export async function withAmounts(visits, { from, to, today, openRows }, opts = {}) {
  const want = new Set(visits.map((v) => v.j).filter(Boolean));
  if (!want.size) return visits;
  const thisYear = String(today).slice(0, 4);
  const years = [...new Set([from.slice(0, 4), to.slice(0, 4), thisYear])].filter((y) => y <= thisYear);
  const shards = await Promise.all([...(openRows ? [] : ["open"]), ...years].map((s) => readIndex("jobs", s, opts)));
  if (openRows) shards.push({ rows: openRows });
  const tot = new Map();
  for (const s of shards) for (const r of s.rows) if (want.has(r.id) && r.bill !== false && Number.isFinite(r.tot) && r.tot > 0) tot.set(r.id, r.tot);
  return visits.map((v) => (tot.has(v.j) ? { ...v, amt: tot.get(v.j) } : v));
}

// Paid or not for each finished visit with an amount (the Day view's red
// $): `pd` 1 when its job's invoice is paid, 0 when one is still owed or
// none was made yet. Read from Money's invoices index (open, and the years
// closed ones are filed under); without Money there are no rows and no marks.
export async function withPaid(visits, { today }, opts = {}) {
  const done = visits.filter((v) => v.st === "completed" && v.amt > 0 && v.j);
  if (!done.length) return visits;
  const want = new Set(done.map((v) => v.j));
  const thisYear = String(today).slice(0, 4);
  const years = [...new Set([...done.map((v) => String(v.d).slice(0, 4)), thisYear])].filter((y) => /^\d{4}$/.test(y) && y <= thisYear);
  const shards = await Promise.all(["open", ...years].map((sh) => readIndex("invoices", sh, opts).catch(() => ({ rows: [] }))));
  const state = new Map();
  for (const sh of shards) {
    for (const r of sh.rows || []) {
      if (!r || !r.j || !want.has(r.j) || ["void", "uncollectible"].includes(r.st)) continue;
      if (["draft", "open"].includes(r.st) && (r.bal || 0) > 0) state.set(r.j, "due");
      else if (r.st === "paid" && state.get(r.j) !== "due") state.set(r.j, "paid");
    }
  }
  return visits.map((v) => (v.st === "completed" && v.amt > 0 && v.j ? { ...v, pd: state.get(v.j) === "paid" ? 1 : 0 } : v));
}

// Warnings and hints for one proposed slot (the schedule sheet asks while you pick).
export async function checkSlot(slot, opts = {}) {
  const [{ rows }, tasksIx, offIx, env, recs] = await Promise.all([
    visitRows(slot.date, slot.date, opts), readIndex("tasks/open", "", opts), readIndex("time-off", "", opts), calendarEnv(opts),
    getRecords("user", (slot.assignee_ids || []).slice(0, 8), opts),
  ]);
  const users = new Map(recs.filter(Boolean).map((g) => [g.data.id, g.data]));
  const tasks = tasksIx.rows.map(taskSlot).filter((t) => t && t.date === slot.date);
  return {
    warnings: slotWarnings(slot, { visits: rows, tasks, timeOff: offIx.rows, users, ...env }),
    hints: townHints(slot, rows),
  };
}

export { localDate };
