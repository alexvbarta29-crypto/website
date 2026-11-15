// Service module: the Jobs tab's tiles (guide-gaps S15a, SJ1, SJ8) and the
// rows behind each one.
//
//   GET /jobs/stats?tile=   the tiles (count and $), and with ?tile= that
//                           tile's rows (Open: every open job),
//                           each with `due` (what its invoices
//                           still owe). Today, Tomorrow, Next week, Next
//                           month go by the job's next open visit; Past week
//                           and Past month by the day it was done; Overdue is
//                           a booked job whose day went by (or the stale
//                           flag); Pending has no visit yet; In progress is
//                           under way; Paid is done with its invoice paid;
//                           Done and Cancelled are this year's.
//
// Reads the jobs index (open, this year, last year when the past month
// reaches back into it) and the invoices index (open, this year); with
// ?tile=, Rotor's Address and Start time for those rows from the visits
// index (the three months most of them fall in) and the places index: ten
// reads at most, never a record.

import { readIndex } from "../../../crm-store.mjs";
import { now, localDate, addLocalDays } from "../../core/clock.mjs";

export const JOB_TILES = Object.freeze([
  ["open", "Open"], ["today", "Today"], ["tomorrow", "Tomorrow"], ["next_week", "Next week"], ["next_month", "Next month"], ["past_week", "Past week"], ["past_month", "Past month"],
  ["overdue", "Overdue"], ["pending", "Pending"], ["in_progress", "In progress"], ["paid", "Paid"], ["done", "Done"], ["cancelled", "Cancelled"],
]);
export const TILE_KEYS = Object.freeze(JOB_TILES.map(([k]) => k));
const OPEN = new Set(["unscheduled", "scheduled", "in_progress"]);
const dayOf = (iso) => { const t = Date.parse(iso || ""); return Number.isFinite(t) ? localDate(new Date(t)) : ""; };

// The tiles one job row is in (pure). today: the company's day; paid: Set of job ids whose invoice is paid.
export function tilesOf(r, today, { paid = new Set() } = {}) {
  const out = [];
  if (OPEN.has(r.st)) {
    const nv = r.nv || null;
    out.push("open");
    if (nv === today) out.push("today");
    if (nv && nv === addLocalDays(today, 1)) out.push("tomorrow");
    if (nv && nv > today && nv <= addLocalDays(today, 7)) out.push("next_week");
    if (nv && nv > today && nv <= addLocalDays(today, 30)) out.push("next_month");
    if (r.stale || (nv && nv < today)) out.push("overdue");
    if (r.st === "unscheduled" && !nv) out.push("pending");
    if (r.st === "in_progress") out.push("in_progress");
    return out;
  }
  if (r.st === "completed") {
    const d = dayOf(r.done);
    if (d === today) out.push("today");
    if (d && d < today && d >= addLocalDays(today, -7)) out.push("past_week");
    if (d && d < today && d >= addLocalDays(today, -30)) out.push("past_month");
    if (d.slice(0, 4) === today.slice(0, 4)) out.push("done");
    if (paid.has(r.id)) out.push("paid");
    return out;
  }
  if (r.st === "cancelled" && dayOf(r.u).slice(0, 4) === today.slice(0, 4)) out.push("cancelled");
  return out;
}

// → { tiles: [{ key, label, count, cents }], rows: { [key]: [row] } } (pure)
export function jobTiles(rows, today, { paid = new Set(), due = new Map() } = {}) {
  const by = Object.fromEntries(TILE_KEYS.map((k) => [k, []]));
  const seen = new Set();
  for (const r of rows) {
    if (!r || !r.id || seen.has(r.id)) continue;
    seen.add(r.id);
    const row = due.has(r.id) ? { ...r, due: due.get(r.id) } : r;
    for (const k of tilesOf(r, today, { paid })) by[k].push(row);
  }
  const amount = (list) => list.reduce((s, r) => s + (r.bill !== false ? r.tot || 0 : 0), 0);
  return { tiles: JOB_TILES.map(([key, label]) => ({ key, label, count: by[key].length, cents: amount(by[key]) })), rows: by };
}

// Each tile's order: what's next first for days ahead, the newest first behind.
const ORDER = {
  ahead: (a, b) => String(a.nv || "9999").localeCompare(String(b.nv || "9999")) || String(a.n).localeCompare(String(b.n)),
  behind: (a, b) => String(b.done || b.u || "").localeCompare(String(a.done || a.u || "")),
};
const BEHIND = new Set(["past_week", "past_month", "done", "paid", "cancelled"]);

// What the jobs' invoices still owe ({ job id → cents }) and the jobs whose invoice is paid, from the invoices index.
export function moneyOf(openInvoices, closedInvoices) {
  const due = new Map();
  const paid = new Set();
  for (const r of openInvoices || []) {
    if (!r || !r.j || !["draft", "open"].includes(r.st) || !(r.bal > 0)) continue;
    due.set(r.j, (due.get(r.j) || 0) + r.bal);
  }
  for (const r of closedInvoices || []) if (r && r.j && r.st === "paid" && !due.has(r.j)) paid.add(r.j);
  return { due, paid };
}

// Rotor's Address and Start date columns (pure): each row's visit on its day
// (the next open one, else the last) gives the place and the start time
// (`ad`, `at`); without one, the job's property from the places index. rows:
// jobs index rows; visits: visits index rows; places: places index rows.
export const rowDay = (r) => r.nv || r.lv || r.fv || null;
export function withPlaces(rows, visits = [], places = []) {
  const byJob = new Map();
  for (const v of visits || []) {
    if (!v || !v.j || v.st === "cancelled") continue;
    const k = `${v.j}|${v.d}`;
    const cur = byJob.get(k);
    if (!cur || String(v.s || "") < String(cur.s || "")) byJob.set(k, v);
  }
  const place = new Map((places || []).filter((p) => p && p.id && p.a).map((p) => [p.id, p.a]));
  return (rows || []).map((r) => {
    const v = byJob.get(`${r.id}|${rowDay(r)}`);
    const ad = (v && (v.ad || v.town)) || (r.pr && place.get(r.pr)) || null;
    const at = v && !v.do && v.s ? v.s : null;
    return ad || at ? { ...r, ...(ad ? { ad } : {}), ...(at ? { at } : {}) } : r;
  });
}
// The months most of the rows' days fall in (three at most).
export function monthsOf(rows, max = 3) {
  const n = new Map();
  for (const r of rows || []) { const d = rowDay(r); if (d && /^\d{4}-\d{2}/.test(d)) n.set(d.slice(0, 7), (n.get(d.slice(0, 7)) || 0) + 1); }
  return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max).map(([m]) => m);
}

export async function jobStats({ tile = null, today = localDate(now()) } = {}) {
  const year = today.slice(0, 4);
  const lastYear = String(Number(year) - 1);
  const reachBack = addLocalDays(today, -30).slice(0, 4) !== year;
  const none = { rows: [], stale: false };
  const [open, closed, before, invOpen, invYear] = await Promise.all([
    readIndex("jobs", "open"), readIndex("jobs", year).catch(() => none), reachBack ? readIndex("jobs", lastYear).catch(() => none) : none,
    readIndex("invoices", "open").catch(() => none), readIndex("invoices", year).catch(() => none),
  ]);
  const { due, paid } = moneyOf(invOpen.rows, invYear.rows);
  const out = jobTiles([...open.rows, ...closed.rows, ...before.rows], today, { paid, due });
  const data = { today, tiles: out.tiles };
  if (tile && out.rows[tile]) {
    const rows = out.rows[tile].slice().sort(BEHIND.has(tile) ? ORDER.behind : ORDER.ahead).slice(0, 500);
    const [places, ...months] = await Promise.all([
      rows.some((r) => r.pr) ? readIndex("places", "").catch(() => none) : none,
      ...monthsOf(rows).map((m) => readIndex("visits", m).catch(() => none)),
    ]);
    data.rows = withPlaces(rows, months.flatMap((x) => x.rows), places.rows);
  }
  return { data, stale: !!(open.stale || closed.stale) };
}
