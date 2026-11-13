// Work module: the Visits list (the Nov 2026 layout, after Rotor's Visits
// screen): one day's visits as cards, in time order, each with the
// customer, which visit of the job it is (n/m), the time, how long the crew
// worked, the job's amount, a red $ while its invoice is unpaid, and the
// status (Not started, In progress, Finished).
//
//   GET /visits?date=YYYY-MM-DD     (the office; a day, today by default)
//     → { date, today, visits: [{ id, contact_name, n, m, start, end, date_only, minutes, amount_cents, unpaid, status }] }
//
// Reads: the month's visits index, the visit records of that day (for the
// minutes worked; at most 40), the jobs index (open and that year) for the
// amounts and the open invoices for what is unpaid: about 45 calls on a
// full day, under the route's own budget.

import { readIndex, getRecords } from "../../../crm-store.mjs";
import { now, localDate, isLocalDate } from "../../core/clock.mjs";
import { InputError } from "../../core/errors.mjs";

const MAX = 40;
const rows = async (name, shard) => { try { return (await readIndex(name, shard)).rows || []; } catch { return []; } };

async function visitList(ctx) {
  const today = localDate(now());
  const date = ctx.query.get("date") || today;
  if (!isLocalDate(date)) throw new InputError("Pick a day.", "date");
  const month = await rows("visits", date.slice(0, 7));
  const day = month.filter((v) => v.d === date && v.st !== "cancelled")
    .sort((a, b) => (a.do ? 1 : 0) - (b.do ? 1 : 0) || String(a.s || "").localeCompare(String(b.s || "")) || (a.o || 0) - (b.o || 0)).slice(0, MAX);
  const [recs, open, year, invoices] = await Promise.all([
    getRecords("visit", day.map((v) => v.id)).catch(() => []),
    rows("jobs", "open"), rows("jobs", date.slice(0, 4)), rows("invoices", "open"),
  ]);
  const minutes = new Map(recs.filter(Boolean).map((g) => [g.data.id, g.data.minutes_worked || 0]));
  const jobs = new Map([...year, ...open].map((j) => [j.id, j]));
  const owing = new Set(invoices.filter((i) => i.st === "open" && (i.bal || 0) > 0 && i.j).map((i) => i.j));
  const perJob = new Map();
  for (const v of month) if (v.st !== "cancelled") perJob.set(v.j, (perJob.get(v.j) || 0) + 1);
  return {
    data: {
      date, today,
      visits: day.map((v) => {
        const j = jobs.get(v.j);
        return {
          id: v.id, contact_name: v.cn || "", job_title: v.t || "", town: v.town || "", n: v.ord || 1, m: Math.max(v.ord || 1, perJob.get(v.j) || 1),
          start: v.s || null, end: v.e || null, date_only: !!v.do, minutes: minutes.get(v.id) || 0, status: v.st, plan: !!v.pl,
          amount_cents: j && j.bill !== false ? j.tot || 0 : null, unpaid: owing.has(v.j),
        };
      }),
    },
  };
}

export const visitListRoutes = [
  { method: "GET", path: "/visits", auth: "session", perm: "schedule:read", subject: "none", mode: "inline", handler: visitList, maxCalls: 60 },
];
