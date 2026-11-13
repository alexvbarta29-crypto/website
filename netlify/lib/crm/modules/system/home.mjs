// Core "system" module: Home, the first screen an owner or the office sees.
// The owner's Nov 12 choice: Rotor's phone Home with the best of Flyra's,
// as cards each person shows, hides and orders (Edit Home), saved on the
// server per person (ptr/home/{userId}). Pure parts in home-kpis.mjs.
//
//   GET /home                      the header, the person's cards in order and the data of the ones shown
//   GET /home/money?metric=&period=&from=&to=   the Money card: collected | scheduled | arr, a period
//   GET /home/agenda?view=&date=   the Agenda: day | week | month
//   GET /home/leaderboard?board=   sales | techs (the reports module's service, when it is there)
//   PUT /home/layout { cards }     Edit Home
//
// The cards (each only for who may see it; a card that is off costs no read):
//   clock        Timesheet: today's hours and Clock in / out (time:own)
//   money        Collected (Rotor's snapshot until cutover, the CRM's
//                payments after), Scheduled (the CRM's visits) or ARR (the
//                CRM's live plans): reports:read or the office sign-in
//   agenda       the day's (week's, month's) visits, and open tasks with no
//                due date (schedule:read; the tasks with tasks:read)
//   leaderboard  "reports.leaderboard" (another track's service): hidden while it is missing
//   inbox        the latest conversations, unread first (inbox:read)
//   tasks        open tasks (tasks:read): an owner's whole team's, anyone else's own
//   goals        the owners' monthly revenue and jobs goals (settings "goals")
// The first three are on by default; the others are added in Edit Home.
// What needs attention is the bell's and the tab's dot (GET /me/badges).
// A technician gets nothing here (their own Today is the tech app's).
// Every index is read once per request (crm-store's ixMemo): 12 storage
// calls cold for the default cards on Rotor's numbers.

import { withStoreScope, readIndex, readPointer, getRaw, settledWrite, K, getSetting } from "../../../crm-store.mjs";
import { officeSignedIn } from "../../core/auth.mjs";
import { now, localDate, isLocalDate } from "../../core/clock.mjs";
import { unreadCount } from "../../core/notify.mjs";
import { has, call } from "../../core/services.mjs";
import { InputError, StaleError, ForbiddenError, NotFoundError } from "../../core/errors.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { loadDashboard } from "../../../office-data.mjs";
import {
  periodOf, PERIODS, monthsOf, rotorCollected, crmCollected, scheduledDays, arrDays, moneyCard, clockToday, agendaRange, AGENDA_VIEWS,
  agendaOf, tasksOf, inboxOf, layoutOf, validateLayout, GOALS_DEFAULTS, validateGoals, jobsDoneIn, normalizeBoard,
} from "./home-kpis.mjs";

export const HOME_MAX_CALLS = 30;

// The owners' goals: a settings document (owners edit it from the Goals card).
export const homeSettings = {
  goals: { perm: "settings:owner", defaults: { ...GOALS_DEFAULTS }, validate: (v) => validateGoals(v) },
};

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

// ------------------------------------------------------------ who may have which card

const isTech = (ctx) => !ctx.user || ctx.user.role === "tech";
// the office sign-in opens the money too (it is the office dashboard's), never for a technician
const seesMoney = (ctx) => !isTech(ctx) && (ctx.can("reports:read") || officeSignedIn(ctx.req));
export function availableCards(ctx) {
  if (isTech(ctx)) return [];
  const money = seesMoney(ctx);
  const out = [];
  if (ctx.can("time:own")) out.push("clock");
  if (money) out.push("money");
  if (ctx.can("schedule:read")) out.push("agenda");
  if (money && has("reports.leaderboard")) out.push("leaderboard");
  if (ctx.can("inbox:read") && has("comms.unread")) out.push("inbox");
  if (ctx.can("tasks:read")) out.push("tasks");
  if (money) out.push("goals");
  return out;
}

// ------------------------------------------------------------ reads (each index once per request)

const ix = (name, shard) => readIndex(name, shard).then((r) => r.rows);
const visitsIn = async (from, to) => (await Promise.all(monthsOf(from, to).map((m) => ix("visits", m)))).flat();
// the jobs a range's visits may belong to: the open ones, and those closed in its years
async function jobsFor(from, to) {
  const years = [...new Set([from.slice(0, 4), to.slice(0, 4)])];
  const shards = await Promise.all([ix("jobs", "open"), ...years.map((y) => ix("jobs", y))]);
  return new Map(shards.flat().map((r) => [r.id, r]));
}

async function money(ctx, { metric = "collected", p, today, mode, goals = null }) {
  if (metric === "scheduled") {
    const [visits, jobs] = await Promise.all([visitsIn(p.from, p.to), jobsFor(p.from, p.to)]);
    return { ...moneyCard({ metric, p, series: scheduledDays(visits, jobs, p), source: "crm" }), updated_at: now().toISOString() };
  }
  if (metric === "arr") {
    const plans = await ix("plans", "");
    return { ...moneyCard({ metric, p, series: arrDays(plans, p, today), source: "crm" }), updated_at: now().toISOString() };
  }
  if (mode && mode.system_of_record === "crm") {
    const end = today < p.to ? today : p.to;
    const rows = end < p.from ? [] : (await Promise.all(monthsOf(p.from, end).map((m) => ix("payments", m)))).flat();
    return { ...moneyCard({ metric, p, series: crmCollected(rows, p, today), source: "crm", goals }), updated_at: now().toISOString() };
  }
  const snap = officeSnapshot();
  // why Rotor's numbers are missing (the office's one setup step), never the key itself
  if (!snap.ok) return { ...moneyCard({ metric, p, series: null, source: "rotor" }), missing: snap.reason || "missing" };
  const series = rotorCollected(snap.data, p, today);
  return moneyCard({ metric, p, series, source: "rotor", asOf: snap.data.as_of, goals });
}

async function agenda(ctx, view, date) {
  const range = agendaRange(view, date);
  const [visits, users] = await Promise.all([visitsIn(range.from, range.to), ix("users", "")]);
  return { view, date, ...range, ...agendaOf(visits, users, range) };
}

const allTasks = (ctx) => ctx.user.role === "owner";
const tasks = async (ctx) => tasksOf(await ix("tasks/open", ""), ctx.user, { all: allTasks(ctx) });

async function leaderboard(ctx, board, today) {
  if (!has("reports.leaderboard")) return null;
  const month = today.slice(0, 7);
  try {
    return normalizeBoard(await call("reports.leaderboard", { board, period: "month", month, from: `${month}-01`, to: today }, ctx), board, month);
  } catch (e) {
    console.error(`crm:home: the leaderboard was left out (${safeErr(e)})`);
    return null;
  }
}

async function goalsCard(ctx, { today, mode, goals, collected }) {
  const month = today.slice(0, 7);
  let jobs = null;
  if (goals.jobs_month) {
    if (mode && mode.system_of_record === "crm") jobs = jobsDoneIn(await ix("jobs", today.slice(0, 4)), month);
    else {
      const snap = officeSnapshot();
      const row = snap.ok ? ((snap.data.revenue || {}).monthly || []).find((m) => m && m.key === month) : null;
      jobs = row && Number.isFinite(Number(row.jobs)) ? Number(row.jobs) : null;
    }
  }
  return {
    month,
    revenue: goals.revenue_month_cents ? { target: goals.revenue_month_cents, value: collected } : null,
    jobs: goals.jobs_month ? { target: goals.jobs_month, value: jobs } : null,
    can_edit: ctx.can("settings:owner"),
  };
}

// ------------------------------------------------------------ GET /home

async function home(ctx) {
  return withStoreScope({ ixMemo: new Map() }, async () => {
    const t = now();
    const today = localDate(t);
    const empty = { date: today, now: t.toISOString(), user: null, mode: null, notifications: null, layout: [], cards: {} };
    if (isTech(ctx)) return { data: empty };
    const available = availableCards(ctx);
    const modeP = ctx.sysMode().catch(() => null);
    const [mode, saved, notifications] = await Promise.all([
      modeP,
      readPointer("home", ctx.user.id).catch(() => null),
      unreadCount(ctx.user.id).catch((e) => { console.error(`crm:home: the bell's count was left out (${safeErr(e)})`); return null; }),
    ]);
    const layout = layoutOf(saved, available);
    const on = new Set(layout.filter((c) => c.on).map((c) => c.key));
    const needGoals = on.has("money") || on.has("goals");
    const goals = needGoals ? await getSetting("goals").catch(() => ({ ...GOALS_DEFAULTS })) : null;
    const month = periodOf("month", today);
    const cards = {};
    const jobs = [];
    if (on.has("clock")) jobs.push(ix("timesheets", today.slice(0, 7)).then((rows) => { cards.clock = clockToday(rows, ctx.user.id, today, t.getTime()); }));
    const moneyP = on.has("money") || on.has("goals") ? money(ctx, { metric: "collected", p: month, today, mode, goals }) : null;
    if (on.has("money")) jobs.push(moneyP.then((m) => { cards.money = m; }));
    const taskList = (on.has("agenda") || on.has("tasks")) && ctx.can("tasks:read") ? tasks(ctx) : null;
    if (on.has("agenda")) jobs.push(Promise.all([agenda(ctx, "day", today), taskList]).then(([a, tl]) => { cards.agenda = { ...a, tasks: tl ? tl.filter((x) => !x.due) : null }; }));
    if (on.has("tasks")) jobs.push(taskList.then((tl) => { cards.tasks = { items: tl, can_add: ctx.can("sales:work") }; }));
    if (on.has("inbox")) jobs.push(ix("inbox", "open").then((rows) => { cards.inbox = { items: inboxOf(rows) }; }));
    if (on.has("leaderboard")) jobs.push(leaderboard(ctx, "sales", today).then((b) => { cards.leaderboard = b; }));
    if (on.has("goals")) jobs.push(moneyP.then((m) => goalsCard(ctx, { today, mode, goals, collected: m.total })).then((g) => { cards.goals = g; }));
    await Promise.all(jobs);
    return {
      data: {
        ...empty,
        user: { first_name: ctx.user.first_name || String(ctx.user.name || "").split(" ")[0] || "", name: ctx.user.name || "", color: ctx.user.color || null },
        mode: mode ? { paused: !!mode.paused, paused_at: mode.paused_at || null, paused_reason: mode.paused_reason || null } : null,
        notifications, layout, cards,
      },
    };
  });
}

// ------------------------------------------------------------ the cards' own reads

async function moneyRoute(ctx) {
  if (!seesMoney(ctx)) throw new ForbiddenError("Money isn't open to this login.");
  const q = ctx.query;
  const metric = q.get("metric") || "collected";
  if (!["collected", "scheduled", "arr"].includes(metric)) throw new InputError("Collected, scheduled or ARR?", "metric");
  const period = q.get("period") || "month";
  if (!PERIODS.includes(period)) throw new InputError("Pick a period.", "period");
  return withStoreScope({ ixMemo: new Map() }, async () => {
    const today = localDate(now());
    const p = periodOf(period, today, { from: q.get("from"), to: q.get("to") });
    const [mode, goals] = await Promise.all([ctx.sysMode().catch(() => null), metric === "collected" && period === "month" ? getSetting("goals").catch(() => null) : null]);
    return { data: await money(ctx, { metric, p, today, mode, goals }) };
  });
}

async function agendaRoute(ctx) {
  const view = ctx.query.get("view") || "day";
  if (!AGENDA_VIEWS.includes(view)) throw new InputError("Daily, weekly or monthly?", "view");
  const date = ctx.query.get("date") || localDate(now());
  if (!isLocalDate(date)) throw new InputError("Which day?", "date");
  return withStoreScope({ ixMemo: new Map() }, async () => ({ data: await agenda(ctx, view, date) }));
}

async function leaderboardRoute(ctx) {
  if (!seesMoney(ctx) || !has("reports.leaderboard")) throw new NotFoundError("There is no leaderboard yet.");
  const board = ctx.query.get("board") === "techs" ? "techs" : "sales";
  return { data: await leaderboard(ctx, board, localDate(now())) };
}

// Edit Home: the person's cards in their order, on or off (CAS on their pointer).
async function saveLayout(ctx) {
  if (isTech(ctx)) throw new InputError("Home is the office's.", "cards");
  const { cards } = validateLayout(ctx.body);
  const available = new Set(availableCards(ctx));
  const keep = cards.filter((c) => available.has(c.key));
  const key = K.ptr("home", ctx.user.id);
  for (let i = 0; i < 4; i++) {
    const cur = await getRaw(key);
    const w = await settledWrite(key, { cards: keep, at: now().toISOString() }, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
    if (w.ok) return { data: { layout: layoutOf({ cards: keep }, [...available]) } };
  }
  throw new StaleError(null, null, "Home kept changing. Try again.");
}

const route = (method, path, handler, more = {}) => ({ method, path, auth: "session", perm: "account:own", subject: "none", mode: "inline", maxCalls: HOME_MAX_CALLS, handler, ...more });
export const homeRoutes = [
  route("GET", "/home", home),
  route("GET", "/home/money", moneyRoute, { maxCalls: 40 }),
  route("GET", "/home/agenda", agendaRoute, { perm: "schedule:read" }),
  route("GET", "/home/leaderboard", leaderboardRoute),
  route("PUT", "/home/layout", saveLayout),
];
