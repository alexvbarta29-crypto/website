// Home's money (the owner's Nov 12 choice: Home shows today's schedule and
// "Money this month", nothing more): collected this month, one line against
// the same point last year, and the month's weeks for one chart. Pure: no
// I/O, no clock (callers pass today, a local YYYY-MM-DD).
//
// Until cutover the numbers are the office dashboard's sealed Rotor snapshot
// (build/office_dashboard.mjs, docs/DASHBOARD.md), labelled "From Rotor ·
// updated <date>" on screen: Rotor takes the payments while it is the
// system of record. Once the CRM is (sys/mode system_of_record "crm") they
// are the CRM's own payments index (money module, payments/{yyyy-mm}),
// counted as GET /money/summary counts revenue. Nothing here invents a
// zero: a number nobody has is left out.
//
//   rotorMoney(snapshot, today)                    the snapshot as Home reads it
//   crmMoney({ today, month, lastYear })           the same from two payments shards
//   → { source, as_of, month: { key, label, current, through }, collected,
//       compare: { kind: "ytd" | "month", cur, prev, pct, up, year, from?, to? } | null,
//       weeks: [{ key, from, to, label, value | null }] }
//
// The comparison is against the same point last year (a seasonal business:
// November against October always looks down). Rotor's snapshot has the
// year so far against the same dates a year earlier, not the month by
// day, so that is its line; the CRM has every payment's date, so its line
// is this month so far against the same days a year earlier.
//
// The chart's weeks are the month's Monday-to-Sunday weeks cut at the 1st
// and the month's end, so the bars add up to the big number. Rotor's weeks
// are whole Monday weeks (its last 12, the current one through as_of): a
// week that starts in the month is exact, and the days before the month's
// first Monday are what the month collected less those weeks. Weeks after
// the data's last day have no value (an empty slot, not a zero).

import { addLocalDays, dowOfDate, isLocalDate } from "../../core/clock.mjs";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const num = (v) => (v === null || v === undefined || v === "" || typeof v === "boolean" || !Number.isFinite(Number(v)) ? null : Number(v));
const list = (v) => (Array.isArray(v) ? v : []);
// the snapshot keeps dollars (two decimals at most); Home works in cents like the rest of the CRM
export const toCents = (dollars) => (num(dollars) === null ? null : Math.round(Number(dollars) * 100));
export const monthLabel = (key) => MONTHS[Number(String(key).slice(5, 7)) - 1] || "";
export const dayLabel = (date) => `${monthLabel(date)} ${Number(String(date).slice(8, 10))}`;
// the Monday of a local date's week (Rotor's weeks start on Monday)
export const weekStart = (date) => addLocalDays(date, -((dowOfDate(date) + 6) % 7));
const daysIn = (monthKey) => new Date(Date.UTC(Number(monthKey.slice(0, 4)), Number(monthKey.slice(5, 7)), 0)).getUTCDate();
const pad = (n) => String(n).padStart(2, "0");
// "Nov 1–16" (one day: "Nov 1")
export const spanLabel = (from, to) => (from === to ? dayLabel(from) : `${dayLabel(from)}–${Number(to.slice(8, 10))}`);

// The month's Monday-to-Sunday weeks, cut at its first and last day.
// → [{ key, from, to, label }] (key = from)
export function monthWeeks(monthKey) {
  const first = `${monthKey}-01`, last = `${monthKey}-${pad(daysIn(monthKey))}`;
  const out = [];
  for (let from = first; from <= last;) {
    const sunday = addLocalDays(weekStart(from), 6);
    const to = sunday < last ? sunday : last;
    out.push({ key: from, from, to, label: dayLabel(from) });
    from = addLocalDays(to, 1);
  }
  return out;
}

const pct = (cur, prev) => (num(prev) > 0 && num(cur) !== null ? Math.round(((cur - prev) / prev) * 100) : null);
function compareOf(kind, cur, prev, extra) {
  const p = pct(cur, prev);
  return p === null ? null : { kind, cur, prev, pct: p, up: p >= 0, ...extra };
}

// ------------------------------------------------------------ Rotor

// The snapshot (build/office_dashboard.mjs buildSnapshot) as Home reads it.
// A snapshot from an earlier month says which month its "this month" is.
export function rotorMoney(snap, today) {
  if (!snap || typeof snap !== "object" || !isLocalDate(snap.as_of)) return null;
  const R = snap.revenue || {};
  const collected = toCents(R.this_month);
  if (collected === null) return null;
  const asOf = snap.as_of;
  const month = asOf.slice(0, 7);
  const year = num(snap.year) || Number(asOf.slice(0, 4));
  const weekly = new Map(list(R.weekly).filter((w) => w && isLocalDate(w.key)).map((w) => [w.key, toCents(w.value)]));
  let weeks = [];
  if (weekly.size) {
    weeks = monthWeeks(month).map((w) => ({ ...w, value: null }));
    let known = 0;
    for (const w of weeks) {
      if (w.from > asOf || dowOfDate(w.from) !== 1) continue;
      // a week inside Rotor's last 12 with no bucket collected nothing
      w.value = weekly.get(w.from) ?? 0;
      known += w.value;
    }
    const lead = weeks[0];
    if (dowOfDate(lead.from) !== 1 && lead.from <= asOf) {
      const rest = collected - known;
      lead.value = rest >= 0 ? rest : null;   // the month and its weeks disagree: no bar rather than a wrong one
    }
  }
  return {
    source: "rotor",
    as_of: asOf,
    month: { key: month, label: monthLabel(month), current: month === today.slice(0, 7), through: Number(asOf.slice(8, 10)) },
    collected,
    compare: compareOf("ytd", toCents(R.collected_ytd), toCents(R.collected_ytd_prev), { year: year - 1 }),
    weeks,
  };
}

// ------------------------------------------------------------ the CRM

// Collected between two local dates from payments index rows, as GET
// /money/summary counts revenue (§5.6, cash basis): succeeded payments less
// succeeded refunds, tips in, simulated (dry-run) payments never.
export function collectedOf(rows, from, to) {
  let n = 0;
  for (const r of list(rows)) {
    if (!r || r.st !== "succeeded" || r.sim || !(r.on >= from && r.on <= to)) continue;
    const v = (num(r.a) || 0) + (num(r.tip) || 0);
    if (r.k === "payment") n += v;
    else if (r.k === "refund") n -= v;
  }
  return n;
}

// month: this month's payments rows; lastYear: the same month a year
// earlier (its shard; empty when the CRM has no payments that far back).
export function crmMoney({ today, month = [], lastYear = [] }) {
  const key = today.slice(0, 7);
  const first = `${key}-01`;
  const collected = collectedOf(month, first, today);
  const prevKey = `${Number(key.slice(0, 4)) - 1}${key.slice(4)}`;
  const prevTo = `${prevKey}-${pad(Math.min(Number(today.slice(8, 10)), daysIn(prevKey)))}`;
  const weeks = monthWeeks(key).map((w) => ({ ...w, value: w.from > today ? null : collectedOf(month, w.from, w.to < today ? w.to : today) }));
  return {
    source: "crm",
    as_of: today,
    month: { key, label: monthLabel(key), current: true, through: Number(today.slice(8, 10)) },
    collected,
    compare: compareOf("month", collected, collectedOf(lastYear, `${prevKey}-01`, prevTo), { year: Number(prevKey.slice(0, 4)), from: `${prevKey}-01`, to: prevTo }),
    weeks,
  };
}
