// Crew payroll for /payroll, read from Rotor's open API (docs/PAYROLL.md).
//
//   GET /open-api/timesheets     (scope timesheets:read) → hours per shift
//   GET /open-api/serviced-jobs  (scope jobs:read)       → tips per job
//
// Rotor's open API has no pay rates, so the hourly rate comes from Netlify
// env vars: PAYROLL_DEFAULT_RATE (dollars, default 20) and PAYROLL_RATES, a
// JSON object of per-person overrides keyed by Rotor user id or full name,
// e.g. {"Gustov Huotari": 21}. Pay per shift matches Rotor's own payroll
// run: exact clock-in to clock-out time × rate, rounded to the cent per shift.
// A tip belongs to the job's service date and is split evenly between the
// technicians on the job.

const BASE = "https://api.getrotor.com/open-api";
const API_VERSION = "1.1.0";
const TIMEOUT_MS = 8000;
const PAGE = 1000;
const MAX_PAGES = 20;
export const TZ = "America/Chicago";
export const DEFAULT_OWNERS = ["Alex Barta", "Jacob Barta"];

export class RotorError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------- dates (all in the company's time zone) ----------
const YMD = /^\d{4}-\d{2}-\d{2}$/;
export const isYmd = (s) => typeof s === "string" && YMD.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z"));
export const daysBetween = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
export function offsetFor(ymd) {
  try {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "longOffset" })
      .formatToParts(new Date(ymd + "T12:00:00Z")).find((x) => x.type === "timeZoneName");
    const o = p && p.value.replace("GMT", "");
    return /^[+-]\d\d:\d\d$/.test(o) ? o : "-06:00";
  } catch { return "-06:00"; }
}
export const startIso = (ymd) => `${ymd}T00:00:00${offsetFor(ymd)}`;
export const endIso = (ymd) => `${ymd}T23:59:59${offsetFor(ymd)}`;

// ---------- Rotor ----------
async function getPage(path, params, key, fetchImpl) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, String(v));
  let res;
  try {
    res = await fetchImpl(url, {
      headers: { "x-api-key": key, "rotor-api-version": API_VERSION, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new RotorError(0, "Rotor didn't answer (" + ((err && err.name) || "error") + ")");
  }
  if (!res.ok) throw new RotorError(res.status, "Rotor answered HTTP " + res.status + " for " + path);
  return res.json();
}

async function getAll(path, params, key, fetchImpl) {
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const body = await getPage(path, { ...params, page, limit: PAGE }, key, fetchImpl);
    out.push(...((body && body.data) || []));
    if (!(body && body.pagination && body.pagination.has_more)) break;
  }
  return out;
}

/** Raw timesheets and serviced jobs for a pay period (inclusive YYYY-MM-DD dates). */
export async function fetchPeriod(start, end, { key, fetchImpl = fetch } = {}) {
  const [timesheets, jobs] = await Promise.all([
    getAll("/timesheets", { start_date: startIso(start), end_date: endIso(end) }, key, fetchImpl),
    getAll("/serviced-jobs", {
      only_completed: "false",
      service_date_range_start: startIso(start),
      service_date_range_end: endIso(end),
    }, key, fetchImpl),
  ]);
  return { timesheets, jobs };
}

// ---------- config ----------
export function readRates(env = process.env) {
  const dflt = Number(env.PAYROLL_DEFAULT_RATE);
  const defaultCents = Number.isFinite(dflt) && dflt >= 0 ? Math.round(dflt * 100) : 2000;
  const byKey = {};
  try {
    const raw = env.PAYROLL_RATES ? JSON.parse(env.PAYROLL_RATES) : {};
    for (const [k, v] of Object.entries(raw || {})) {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) byKey[String(k).trim().toLowerCase()] = Math.round(n * 100);
    }
  } catch { /* bad JSON: everyone gets the default */ }
  return { defaultCents, byKey };
}

export function readOwners(env = process.env) {
  const list = env.PAYROLL_OWNERS ? String(env.PAYROLL_OWNERS).split(",") : DEFAULT_OWNERS;
  return new Set(list.map((s) => s.trim().toLowerCase()).filter(Boolean));
}

// ---------- the pay sheets ----------
/**
 * People with their shifts and tip shares for the period.
 * @returns {{id, name, owner, shifts: object[], tips: object[]}[]}
 */
export function buildPayroll({ timesheets = [], jobs = [], rates = readRates({}), owners = new Set() }) {
  const people = new Map();
  const person = (id, name) => {
    const key = id || ("name:" + name);
    if (!people.has(key)) people.set(key, { id: key, name: name || "Team member", owner: false, shifts: [], tips: [] });
    const p = people.get(key);
    if (name && p.name === "Team member") p.name = name;
    return p;
  };
  const rateFor = (p) => {
    const hit = rates.byKey[String(p.id).toLowerCase()] ?? rates.byKey[String(p.name).toLowerCase()];
    return hit ?? rates.defaultCents;
  };

  for (const t of timesheets) {
    if (!t || !t.start) continue;
    const u = t.user || {};
    const p = person(u.user_id, u.name);
    const active = !t.end;
    const hours = t.end
      ? Math.max(0, (Date.parse(t.end) - Date.parse(t.start)) / 3600000)
      : (t.duration_minutes != null ? t.duration_minutes / 60 : 0);
    p.shifts.push({ id: t.id, start: t.start, end: t.end || null, active, hours });
  }

  for (const j of jobs) {
    const tipCents = (j.payments || [])
      .filter((pay) => pay && pay.status === "succeeded" && Number(pay.tip) > 0)
      .reduce((s, pay) => s + Math.round(Number(pay.tip) * 100), 0);
    const techs = (j.technicians || []).filter((t) => t && (t.user_id || t.name));
    if (!tipCents || !techs.length) continue;
    const c = j.customer || {};
    const customer = c.company_name || [c.first_name, c.last_name].filter(Boolean).join(" ");
    const share = Math.round(tipCents / techs.length);
    for (const t of techs) {
      person(t.user_id, t.name).tips.push({
        job_id: j.id, customer, date: j.service_date || null,
        tip_cents: tipCents, split: techs.length, share_cents: share,
      });
    }
  }

  const out = [];
  for (const p of people.values()) {
    const rate = rateFor(p);
    p.owner = owners.has(String(p.name).toLowerCase());
    p.shifts.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    p.tips.sort((a, b) => Date.parse(a.date || 0) - Date.parse(b.date || 0));
    for (const s of p.shifts) { s.rate_cents = rate; s.amount_cents = Math.round(s.hours * rate); }
    out.push(p);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
