// Core "system" module: Home, the first screen an owner or the office sees
// (design §9.2 "Today" for owners and admins; industry spec 13.1 "Owner
// dashboard"). One read, GET /api/crm/home, for the whole screen:
//
//   kpis    the month's numbers and the Money, Sales, Plans and Jobs cards
//           (home-kpis.mjs): for reports:read (owners and the office; a
//           technician holds it only as "own", which opens no summary) or a
//           phone with the office sign-in, never a technician.
//   today   today's visits (the work module's visits/{yyyy-mm} index, as the
//           Schedule reads it), how many are done, the to-book tray and the
//           plan visits due: schedule:read unscoped (the office).
//   needs   "Needs you": every module's attention and approvals rows the
//           person may see (§11.3; a row with badge: false is listed here
//           but never lights the tab's dot), the owners' pending actions,
//           bulk sends waiting for a test, and the workers' alerts. Money
//           and Inbox rows arrive with their modules' own declarations.
//   mode    paused or not (the banner).
//
// A technician gets the same answer with nothing in it (their own Today is
// the tech app's). Counts come from index blobs, never from listing
// records, and each index is read once for the whole request (crm-store's
// ixMemo). Every module adds one count, so Home has its own call budget
// (HOME_MAX_CALLS, above the 25 of §2.2; still 8 s).
// The snapshot is opened once per warm instance.

import { withStoreScope, readIndex } from "../../../crm-store.mjs";
import { allModules } from "../../core/registry.mjs";
import { officeSignedIn } from "../../core/auth.mjs";
import { now, localDate, addLocalDays } from "../../core/clock.mjs";
import { BudgetError } from "../../core/errors.mjs";
import { has, call } from "../../core/services.mjs";
import { listPendingActions } from "../../core/pending.mjs";
import { waitingCount } from "../../core/bulk.mjs";
import { readHealth, laneStatus } from "../../core/lanes.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { loadDashboard } from "../../../office-data.mjs";
import { visitRows, toBookRows } from "../work/office-schedule.mjs";
import { rotorNumbers, crmNumbers, homeKpis, weekStart } from "./home-kpis.mjs";

// Home reads one index per module that shows a count, plus the session, the
// mode and the month's visits: 23 with Money and Messages on Rotor's numbers,
// a few more once the CRM's own numbers take over.
export const HOME_MAX_CALLS = 40;

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

// ------------------------------------------------------------ Needs you

// The order rows read in, most urgent first; a module's new row lands at 50.
const ORDER = {
  "health.alerts": 1, "sales.attention": 10, "sales.calls_due": 12, "sales.tasks_mine": 14, "quotes.changes_requested": 20, "quotes.waiting": 22,
  "agreements.unsigned": 30, "plans.due": 32, "approvals.pending": 40, "approvals.bulk": 42, agreement_templates: 44, "plans.clawback": 46,
  "contacts.merge_candidates": 60, "work.stale": 62, "import.conflicts": 70,
};

// A count that fails is left out (never a "0" that isn't real); going over
// the call budget in the tests' strict mode still fails the request.
async function counted(ctx, def) {
  try {
    const n = Number(await def.count(ctx));
    return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : null;
  } catch (e) {
    if (e instanceof BudgetError && ctx.budget && ctx.budget.calls() > ctx.budget.maxCalls) throw e;
    console.error(`crm:home: a count was left out (${safeErr(e)})`);
    return null;
  }
}

async function needsYou(ctx) {
  const defs = [];
  for (const m of allModules()) {
    for (const a of m.attention || []) if (a && typeof a.count === "function" && (!a.perm || ctx.can(a.perm))) defs.push({ key: a.key, label: a.label, link: a.link, kind: "attention", module: m.name, count: a.count });
    for (const a of m.approvals || []) if (a && typeof a.count === "function" && (!a.perm || ctx.can(a.perm))) defs.push({ key: a.kind, label: a.label, link: a.link, kind: "approval", module: m.name, count: a.count });
  }
  if (ctx.can("pending_actions:approve")) defs.push({ key: "approvals.pending", label: "Requests waiting for your OK", link: "#/approvals", kind: "approval", module: "system", count: async () => (await listPendingActions({ status: "pending" })).length });
  if (ctx.can("campaigns:send")) defs.push({ key: "approvals.bulk", label: "Bulk sends waiting for a test", link: "#/approvals", kind: "approval", module: "system", count: () => waitingCount() });
  if (ctx.can("audit:read")) {
    defs.push({ key: "health.alerts", label: "System alerts", link: "#/settings/data", kind: "alert", module: "system", count: async () => {
      const h = await readHealth();
      const stuck = ["fast", "bulk"].filter((l) => laneStatus(h, l) === "stuck").length;
      return (Array.isArray(h.alerts) ? h.alerts.length : 0) + stuck;
    } });
  }
  const counts = await Promise.all(defs.map((d) => counted(ctx, d)));
  return defs.map((d, i) => ({ key: d.key, label: d.label, link: typeof d.link === "string" && d.link.startsWith("#/") ? d.link : null, kind: d.kind, module: d.module, count: counts[i] }))
    .filter((r) => r.count !== null && r.count > 0)
    .sort((a, b) => (ORDER[a.key] ?? 50) - (ORDER[b.key] ?? 50) || a.label.localeCompare(b.label));
}

// ------------------------------------------------------------ Today

const DEAD = new Set(["cancelled", "no_access"]);
const MAX_VISITS = 40;

async function todayVisits(today) {
  const [{ rows }, users, jobsOpen] = await Promise.all([visitRows(today, today), readIndex("users", ""), readIndex("jobs", "open")]);
  const people = new Map(users.rows.map((u) => [u.id, u]));
  const live = rows.filter((r) => !DEAD.has(r.st))
    .sort((a, b) => (a.do ? 1 : 0) - (b.do ? 1 : 0) || String(a.s || "").localeCompare(String(b.s || "")) || String(a.id).localeCompare(String(b.id)));
  const person = (id) => {
    const u = people.get(id);
    return u ? { id, name: u.name || "", first_name: u.first_name || "", color: u.color || null } : { id, name: "", first_name: "", color: null };
  };
  return {
    date: today,
    visits: live.slice(0, MAX_VISITS).map((v) => ({
      id: v.id, start: v.s || null, end: v.e || null, window: v.w || null, date_only: !!v.do, name: v.cn || "", town: v.town || "",
      title: v.t || "", status: v.st, people: (v.a || []).slice(0, 4).map(person),
    })),
    counts: {
      visits: live.length,
      done: live.filter((v) => v.st === "completed").length,
      to_book: toBookRows(jobsOpen.rows, today.slice(0, 7)).length,
    },
  };
}

// ------------------------------------------------------------ the numbers

async function numbers(ctx, today, modeP) {
  const snap = officeSnapshot();
  const [mode, runs] = await Promise.all([modeP, readIndex("import-runs", "")]);
  // the CRM's records cover the business once a Rotor import finished, or after cutover
  const covered = (mode && mode.system_of_record === "crm") || runs.rows.some((r) => r.st === "done");
  let crm = null;
  if (covered) {
    const year = today.slice(0, 4);
    const mon = weekStart(today);
    const [jobsYear, jobsOpen, quotesOpen, quotesYear, plans, visits] = await Promise.all([
      readIndex("jobs", year), readIndex("jobs", "open"), readIndex("quotes", "open"), readIndex("quotes", year), readIndex("plans", ""), visitRows(mon, addLocalDays(mon, 27)),
    ]);
    crm = crmNumbers({ today, jobsYear: jobsYear.rows, jobsOpen: jobsOpen.rows, quotesOpen: quotesOpen.rows, quotesYear: quotesYear.rows, plans: plans.rows, visits: visits.rows });
  }
  const rotor = snap.ok ? rotorNumbers(snap.data, today) : null;
  const out = homeKpis({ rotor, crm, today, extra: await series(ctx, rotor) });
  // why the Rotor numbers are missing (the office's one setup step), never the key itself
  out.source.rotor_missing = snap.ok ? null : snap.reason;
  return out;
}

// The CRM's own money and lead series (the reports module's rollups, once
// it provides "reports.series"): each takes over from the day its data
// starts, the snapshot keeping the weeks and months before (mergeSeries).
async function series(ctx, rotor) {
  if (!rotor || !has("reports.series")) return {};
  const ask = (metric, group, rows) => call("reports.series", { metric, group, keys: rows.map((r) => r.key) }, ctx).catch((e) => {
    console.error(`crm:home: a series was left out (${safeErr(e)})`);
    return null;
  });
  const [weekly, monthly, leads] = await Promise.all([ask("collected", "week", rotor.weekly), ask("collected", "month", rotor.monthly), ask("leads", "week", rotor.leads)]);
  return { weekly, monthly, leads };
}

// ------------------------------------------------------------ GET /home

async function home(ctx) {
  return withStoreScope({ ixMemo: new Map() }, async () => {
    const t = now();
    const today = localDate(t);
    const tech = !ctx.user || ctx.user.role === "tech";
    // the office sign-in opens the Rotor numbers too (they are the office dashboard's), never for a technician
    const wantNumbers = !tech && (ctx.can("reports:read") || officeSignedIn(ctx.req));
    const wantDay = !tech && ctx.can("schedule:read");
    const modeP = ctx.sysMode().catch(() => null);
    const [mode, needs, day, kpis] = await Promise.all([
      modeP,
      tech ? [] : needsYou(ctx),
      wantDay ? todayVisits(today) : null,
      wantNumbers ? numbers(ctx, today, modeP) : null,
    ]);
    if (day) {
      const due = needs.find((r) => r.key === "plans.due");
      day.counts.plan_due = due ? due.count : ctx.can("plans:read") ? 0 : null;
    }
    return {
      data: {
        date: today, now: t.toISOString(),
        mode: mode && !tech ? { paused: !!mode.paused, paused_at: mode.paused_at || null, paused_reason: mode.paused_reason || null } : null,
        kpis, today: day, needs,
      },
    };
  });
}

export const homeRoutes = [
  { method: "GET", path: "/home", auth: "session", perm: "account:own", subject: "none", mode: "inline", maxCalls: HOME_MAX_CALLS, handler: home },
];
