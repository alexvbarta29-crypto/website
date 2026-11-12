// Core "system" module: Home, the first screen an owner or the office sees.
// The owner's Nov 12 choice: Home shows two things, today's schedule and
// the money this month, nothing more. One read, GET /api/crm/home:
//
//   today          today's visits in time order (the work module's
//                  visits/{yyyy-mm} index, as the Schedule reads it) with
//                  who goes, and how many are done; on a day with nothing
//                  booked, the next day that has visits (`next`):
//                  schedule:read unscoped (the office).
//   money          collected this month, the line against the same point
//                  last year and the month's weeks (home-kpis.mjs): Rotor's
//                  sealed snapshot until cutover, the CRM's own payments
//                  index after. For reports:read (owners and the office; a
//                  technician holds it only as "own", which opens no
//                  summary) or a phone with the office sign-in, never a
//                  technician. money_missing says why there are none.
//   notifications  the bell's count (this person's unread ones).
//   mode           paused or not (the banner).
//
// What needs attention is no longer on Home: the bell and the tab's dot
// (GET /me/badges, each module's attention and approvals rows) keep it.
// A technician gets the same answer with nothing in it (their own Today is
// the tech app's). Every index is read once for the request (crm-store's
// ixMemo): about 8 storage calls cold, 10 once the CRM keeps the money.
// The snapshot is opened once per warm instance.

import { withStoreScope, readIndex } from "../../../crm-store.mjs";
import { officeSignedIn } from "../../core/auth.mjs";
import { now, localDate } from "../../core/clock.mjs";
import { unreadCount } from "../../core/notify.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { loadDashboard } from "../../../office-data.mjs";
import { rotorMoney, crmMoney } from "./home-kpis.mjs";

export const HOME_MAX_CALLS = 25;

// ------------------------------------------------------------ the Rotor snapshot

// Opened once per warm instance (the box and the key decide; tests and the
// phone checks hand a synthetic box sealed for their throwaway key through
// globalThis.__crmOfficeSnapshot, never a real one).
let snapCache = null;
export function officeSnapshot(env = process.env) {
  const box = globalThis.__crmOfficeSnapshot || undefined;
  const key = String(env.OFFICE_DATA_KEY || "");
  if (snapCache && snapCache.box === box && snapCache.key === key) return snapCache.got;
  const got = loadDashboard(env, box);
  snapCache = { box, key, got };
  return got;
}
export function clearSnapshotCache() { snapCache = null; }

// ------------------------------------------------------------ Today

const DEAD = new Set(["cancelled", "no_access"]);
const MAX_VISITS = 40;
const nextMonth = (m) => (m.slice(5) === "12" ? `${Number(m.slice(0, 4)) + 1}-01` : `${m.slice(0, 4)}-${String(Number(m.slice(5)) + 1).padStart(2, "0")}`);
const byTime = (a, b) => (a.do ? 1 : 0) - (b.do ? 1 : 0) || String(a.s || "").localeCompare(String(b.s || "")) || String(a.id).localeCompare(String(b.id));

// Today's visits, or (nothing booked today) the next day with visits in
// this month's shard or the next month's: one shard read, two at most.
async function todayVisits(today) {
  const month = today.slice(0, 7);
  const [shard, users] = await Promise.all([readIndex("visits", month), readIndex("users", "")]);
  const live = (r) => r && !DEAD.has(r.st);
  const mine = shard.rows.filter((r) => live(r) && r.d === today).sort(byTime);
  let next = null;
  if (!mine.length) {
    let later = shard.rows.filter((r) => live(r) && r.d > today);
    if (!later.length) later = (await readIndex("visits", nextMonth(month))).rows.filter((r) => live(r) && r.d > today);
    const date = later.reduce((d, r) => (!d || r.d < d ? r.d : d), null);
    if (date) {
      const rows = later.filter((r) => r.d === date).sort(byTime);
      next = { date, days: Math.round((Date.parse(date) - Date.parse(today)) / 86400000), count: rows.length, visits: rows.slice(0, MAX_VISITS) };
    }
  }
  const people = new Map(users.rows.map((u) => [u.id, u]));
  const person = (id) => {
    const u = people.get(id);
    return u ? { id, name: u.name || "", first_name: u.first_name || "", color: u.color || null } : { id, name: "", first_name: "", color: null };
  };
  const row = (v) => ({
    id: v.id, start: v.s || null, end: v.e || null, window: v.w || null, date_only: !!v.do, name: v.cn || "", town: v.town || "",
    title: v.t || "", status: v.st, people: (v.a || []).slice(0, 4).map(person),
  });
  return {
    date: today,
    visits: mine.slice(0, MAX_VISITS).map(row),
    counts: { visits: mine.length, done: mine.filter((v) => v.st === "completed").length },
    next: next ? { date: next.date, days: next.days, count: next.count, visits: next.visits.map(row) } : null,
  };
}

// ------------------------------------------------------------ the money

// Rotor's numbers while Rotor takes the payments; the CRM's own once it
// is the system of record (this month's payments shard and the same
// month's a year earlier).
async function money(today, modeP) {
  const mode = await modeP;
  if (mode && mode.system_of_record === "crm") {
    const key = today.slice(0, 7);
    const [month, lastYear] = await Promise.all([readIndex("payments", key), readIndex("payments", `${Number(key.slice(0, 4)) - 1}${key.slice(4)}`)]);
    return { money: crmMoney({ today, month: month.rows, lastYear: lastYear.rows }), missing: null };
  }
  const snap = officeSnapshot();
  // why the Rotor numbers are missing (the office's one setup step), never the key itself
  if (!snap.ok) return { money: null, missing: snap.reason || "missing" };
  const m = rotorMoney(snap.data, today);
  return { money: m, missing: m ? null : "missing" };
}

// ------------------------------------------------------------ GET /home

async function home(ctx) {
  return withStoreScope({ ixMemo: new Map() }, async () => {
    const t = now();
    const today = localDate(t);
    const tech = !ctx.user || ctx.user.role === "tech";
    // the office sign-in opens the Rotor numbers too (they are the office dashboard's), never for a technician
    const wantMoney = !tech && (ctx.can("reports:read") || officeSignedIn(ctx.req));
    const wantDay = !tech && ctx.can("schedule:read");
    const modeP = ctx.sysMode().catch(() => null);
    const [mode, day, cash, notifications] = await Promise.all([
      modeP,
      wantDay ? todayVisits(today) : null,
      wantMoney ? money(today, modeP) : null,
      tech ? null : unreadCount(ctx.user.id).catch((e) => { console.error(`crm:home: the bell's count was left out (${safeErr(e)})`); return null; }),
    ]);
    return {
      data: {
        date: today, now: t.toISOString(),
        mode: mode && !tech ? { paused: !!mode.paused, paused_at: mode.paused_at || null, paused_reason: mode.paused_reason || null } : null,
        today: day,
        money: cash ? cash.money : null,
        money_missing: cash ? cash.missing : null,
        notifications,
      },
    };
  });
}

export const homeRoutes = [
  { method: "GET", path: "/home", auth: "session", perm: "account:own", subject: "none", mode: "inline", maxCalls: HOME_MAX_CALLS, handler: home },
];
