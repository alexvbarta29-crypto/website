// Work module, field part: visit timers (design §5.5 "Timers", §7.6
// work.timers, §10.2 row 24).
//
// A timer is one segment of one person's work on a visit: start opens it,
// pause or finish closes it, resume opens the next. One running segment per
// (visit, person): ptr/timer/{visitId}--{uid}, a "one open" pointer (§3.7).
// The visit's minutes_worked is the sum of its closed segments (a segment
// under a minute counts for nothing, §5.5). A segment made from a device
// time the server didn't take on its own (§2.5) is marked unverified.
//
//   timersSweep   work.timers, every fast-lane pass: a segment still running
//                 past its visit's end + timer_autoclose_after_min (2 h;
//                 never before it has run the visit's planned length + 2 h,
//                 so a late start isn't cut short), or 20:00 for one with no
//                 visit, or on a visit that is done or cancelled, is closed
//                 at that deadline with auto_closed; the person and the
//                 office hear about it and the shift is flagged for review.
//                 A segment Rotor still owns only gets a would- row (§3.10).
//   import phase  Rotor's visit timers: user_ids from assigned_to, geo,
//                 minutes; segments with no visit kept; a segment still
//                 running closed at its deadline with auto_closed (reported).

import {
  getRecord, getRecords, createRecord, updateRecord, readIndex, readPointer, claimOpenPointer, listRel,
} from "../../../crm-store.mjs";
import { now, nowMs, nowIso, localDate, localTime, zonedToUtc } from "../../core/clock.mjs";
import { deriveId, newId, isId, idForRotor } from "../../core/ids.mjs";
import { ConflictError, ExistsError, ParallelRunGuard } from "../../core/errors.mjs";
import { notify } from "../../core/notify.mjs";
import { wouldAct } from "../../core/activity.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { RowError } from "../contacts/import-rotor.mjs";
import { rotorKey } from "../contacts/display.mjs";
import { minutesBetween } from "./types-field.mjs";
import { changeVisit, W, workSettings } from "./office.mjs";
import { deviceFields, officeUsers } from "./timesheets.mjs";

const CLOSED_VISIT = ["completed", "cancelled", "no_access"];
const isOpenTimer = (t) => !!t && !t.deleted_at && !t.end_at;
const pkey = (visitId, userId) => `${visitId}--${userId}`;

async function isOpenTimerId(id) {
  if (!isId(id, "timer")) return false;
  const g = await getRecord("timer", id);
  return !!g && isOpenTimer(g.data);
}

// The person's running segment on a visit, or null.
export async function runningTimer(visitId, userId) {
  const p = await readPointer("timer", pkey(visitId, userId));
  if (!p || !isId(p.id, "timer")) return null;
  const g = await getRecord("timer", p.id);
  return g && isOpenTimer(g.data) ? g.data : null;
}

// Every segment of a visit, oldest first.
export async function visitTimers(visitId) {
  const rows = await listRel("visit-timers", visitId, { limit: 200, newestFirst: false });
  return (await getRecords("timer", rows.map((r) => r.id))).filter(Boolean).map((g) => g.data).filter((t) => !t.deleted_at && t.visit_id === visitId);
}

// Minutes worked on a visit: the closed segments of a minute or more.
export const minutesWorked = (timers) => (timers || []).filter((t) => t.end_at && (t.minutes || 0) >= 1).reduce((s, t) => s + t.minutes, 0);

// Opens a segment for one person (time: judgeTime()). A replay of the same
// client id, or a segment already running, answers that segment.
// → { timer, created? }
export async function startSegment({ visit, userId, time, clientId = null, geo }, w) {
  const id = clientId ? deriveId("timer", `c:${clientId}`) : newId("timer");
  if (clientId) {
    const had = await getRecord("timer", id);
    if (had) return { timer: had.data };
  }
  const claim = await claimOpenPointer("timer", pkey(visit.id, userId), { id }, isOpenTimerId);
  if (!claim.ok) {
    const cur = claim.current && isId(claim.current.id, "timer") ? await getRecord("timer", claim.current.id) : null;
    if (cur && isOpenTimer(cur.data)) return { timer: cur.data };
    throw new ConflictError("The timer didn't start. Try again.");
  }
  try {
    const r = await createRecord("timer", {
      id, visit_id: visit.id, job_id: visit.job_id, user_ids: [userId], start_at: time.at, ...deviceFields(time),
      ...(time.trusted ? {} : { unverified: true }), ...(clientId ? { client_id: clientId } : {}), ...(geo ? { start_geo: geo } : {}),
    }, w);
    return { timer: r.data, created: true };
  } catch (e) {
    if (!(e instanceof ExistsError)) throw e;
    return { timer: (await getRecord("timer", id)).data };
  }
}

// Closes a segment at `at` (never before it started). → the segment
export async function stopSegment(timer, { at, geo, clientId, auto, untrusted } = {}, w) {
  const end = new Date(Math.max(Date.parse(at || nowIso()), Date.parse(timer.start_at))).toISOString();
  const r = await updateRecord("timer", timer.id, (t) => {
    if (!isOpenTimer(t)) return null;
    return {
      ...t, end_at: end, ...(geo ? { end_geo: geo } : {}), ...(clientId ? { end_client_id: clientId } : {}),
      ...(auto ? { auto_closed: auto } : {}), ...(untrusted ? { unverified: true } : {}),
    };
  }, w);
  return r.data;
}

// Closes the running segments on a visit (everyone's, or one person's).
// → the segments closed
export async function stopRunning(visitId, { at, userId, clientId, geo, untrusted } = {}, w) {
  const open = (await visitTimers(visitId)).filter((t) => isOpenTimer(t) && (!userId || (t.user_ids || []).includes(userId)));
  const out = [];
  for (const t of open) out.push(await stopSegment(t, { at, geo, clientId: userId ? clientId : undefined, untrusted }, w));
  return out;
}

// Brings visit.minutes_worked in line with its segments. → minutes
export async function recomputeMinutes(visitId, w) {
  const m = minutesWorked(await visitTimers(visitId));
  await updateRecord("visit", visitId, (v) => (v.minutes_worked === m ? null : { ...v, minutes_worked: m }), w).catch((e) => console.error(`crm:work: minutes not updated (${safeErr(e)})`));
  return m;
}

// ------------------------------------------------------------ work.timers (§7.6)

// When a running segment is closed for being forgotten (ms).
export function timerDeadline(timer, visit, s = {}) {
  const after = (s.timer_autoclose_after_min || 120) * 60000;
  const start = Date.parse(timer.start_at);
  if (!visit) {
    const day = localDate(new Date(start));
    const eight = zonedToUtc(day, "20:00").getTime();
    return eight > start ? eight : start + after;
  }
  if (CLOSED_VISIT.includes(visit.status)) {
    const done = Date.parse((visit.completion && visit.completion.at) || visit.cancelled_at || (visit.no_access && visit.no_access.at) || visit.updated_at);
    return Math.max(start, Number.isFinite(done) ? done : start);
  }
  const vs = Date.parse(visit.start_utc), ve = Date.parse(visit.end_utc);
  const planned = Number.isFinite(vs) && Number.isFinite(ve) ? Math.max(0, ve - vs) : 2 * 3600000;
  return Math.max(Number.isFinite(ve) ? ve : start, start + planned) + after;
}

export async function timersSweep(ctx = {}) {
  const ix = await readIndex("timers", "active");
  if (!ix.rows.length) return { done: true, progress: 0 };
  const t = nowMs();
  const s = await workSettings();
  let progress = 0;
  for (const row of ix.rows) {
    if (ctx.budget && ctx.budget.left() < 4000) return { done: false, progress };
    // cheap first: a row whose start is less than 2 hours ago can wait
    if (Date.parse(row.s) + 2 * 3600000 > t && !row.v) continue;
    const g = await getRecord("timer", row.id);
    if (!g || !isOpenTimer(g.data)) continue;
    const timer = g.data;
    const vg = timer.visit_id ? await getRecord("visit", timer.visit_id) : null;
    const visit = vg ? vg.data : null;
    const deadline = timerDeadline(timer, visit, s);
    if (t < deadline) continue;
    if (typeof ctx.mayAct === "function" && !ctx.mayAct(timer)) {
      await ctx.would(timer, "close", { end_at: [null, new Date(deadline).toISOString()] });
      continue;
    }
    const w = typeof ctx.write === "function" ? ctx.write() : W(ctx);
    // the segment is the CRM's own; a visit Rotor still owns only gets would- rows (§3.10)
    const hands = visit && typeof ctx.mayAct === "function" && !ctx.mayAct(visit) ? { would: (action, changes) => ctx.would(visit, action, changes) } : null;
    try {
      await closeForgotten(timer, visit, deadline, w, { hands });
      progress += 1;
    } catch (e) {
      if (e instanceof ParallelRunGuard) { await ctx.would?.(timer, "close", { end_at: [null, new Date(deadline).toISOString()] }); continue; }
      console.error(`crm:work: a timer not closed (${safeErr(e)})`);
    }
  }
  return { done: true, progress, result: `${progress} timers closed` };
}

async function closeForgotten(timer, visit, deadline, w, { hands = null } = {}) {
  const closed = await stopSegment(timer, { at: new Date(deadline).toISOString(), auto: { at: nowIso(), reason: "stale" } }, w);
  const users = closed.user_ids || [];
  if (visit && hands) {
    const m = minutesWorked(await visitTimers(visit.id));
    if (m !== (visit.minutes_worked || 0)) await hands.would("change", { minutes_worked: [visit.minutes_worked ?? null, m] }).catch(() => {});
    if (visit.status === "in_progress" && !(await visitTimers(visit.id)).some(isOpenTimer)) await hands.would("pause", { status: ["in_progress", "paused"] }).catch(() => {});
  } else if (visit) {
    await recomputeMinutes(visit.id, w);
    // nobody's timer runs on it any more: the visit is paused, not "working"
    if (visit.status === "in_progress") {
      const still = (await visitTimers(visit.id)).filter(isOpenTimer);
      if (!still.length) {
        await changeVisit(visit.id, "pause", { ctx: w }).catch(async (e) => {
          if (e instanceof ParallelRunGuard) await wouldAct({ key: "work.timers", subject: visit, action: "pause", changes: { status: ["in_progress", "paused"] } }).catch(() => {});
          else console.error(`crm:work: visit not paused (${safeErr(e)})`);
        });
      }
    }
  }
  // the shift around it is flagged for review
  for (const uid of users) {
    const rows = await listRel("user-timesheets", uid, { limit: 4 }).catch(() => []);
    const sheets = (await getRecords("timesheet", rows.map((r) => r.id))).filter(Boolean).map((g) => g.data);
    const around = sheets.find((x) => Date.parse(x.start_at) <= Date.parse(timer.start_at) && (!x.end_at || Date.parse(x.end_at) >= Date.parse(timer.start_at)));
    if (around && !(around.flags || []).includes("timer_auto_closed")) {
      await updateRecord("timesheet", around.id, (x) => ((x.flags || []).includes("timer_auto_closed") ? null : { ...x, flags: [...(x.flags || []), "timer_auto_closed"] }), w).catch(() => {});
    }
  }
  const at = localTime(new Date(deadline));
  const where = visit ? `${visit.job_title || "a visit"}${visit.town ? ` in ${visit.town}` : ""}` : "a timer with no visit";
  await notify(users, { kind: "system", title: "Timer stopped for you", body: `Your timer on ${where} was stopped at ${at}. Tell the office if that's wrong.`, link: visit ? `/visits/${visit.id}` : "/time" }, w).catch(() => {});
  const office = (await officeUsers().catch(() => [])).filter((u) => !users.includes(u));
  await notify(office.slice(0, 5), { kind: "system", title: "A forgotten timer was stopped", body: `A timer on ${where} ran past ${at} and was stopped. Check it on Timesheets.`, link: "/timesheets" }, w).catch(() => {});
  return closed;
}

// Count for Today: running segments past their deadline the office should look at.
export async function forgottenCount() {
  const ix = await readIndex("timers", "active");
  const t = nowMs();
  return ix.rows.filter((r) => Date.parse(r.s) + 10 * 3600000 < t).length;
}

// ------------------------------------------------------------ import phase 24 (§10.2): Rotor visit timers

const ROTOR_ID = /^(?!\.+$)[A-Za-z0-9_.-]{1,64}$/;
const iso = (v) => (v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
const geoIn = (v) => (Array.isArray(v) && v.length === 2 && v.every(Number.isFinite) && Math.abs(v[0]) <= 90 && Math.abs(v[1]) <= 180 ? [v[0], v[1]] : null);
const opt = (v) => (v === null || v === undefined || v === "" ? null : String(v).trim());

export function normalizeTimer(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) throw new RowError("row");
  const id = String(row.id ?? "").trim();
  if (!ROTOR_ID.test(id)) throw new RowError("id");
  const visit = opt(row.visit_id);
  if (visit !== null && !ROTOR_ID.test(visit)) throw new RowError("visit_id");
  const job = opt(row.job_id);
  if (job !== null && !ROTOR_ID.test(job)) throw new RowError("job_id");
  const start = iso(row.start);
  if (!start) throw new RowError("start");
  const end = row.end === null || row.end === undefined || row.end === "" ? null : iso(row.end);
  if (row.end && !end) throw new RowError("end");
  if (row.assigned_to !== undefined && row.assigned_to !== null && !Array.isArray(row.assigned_to)) throw new RowError("assigned_to");
  return {
    id, visit_id: visit, job_id: job, start, end, running: row.is_active === true || !end,
    assigned_to: (row.assigned_to || []).map((x) => String(x).trim()).filter((x) => ROTOR_ID.test(x)),
    start_geo: geoIn(row.start_location), end_geo: geoIn(row.end_location),
  };
}

async function mapTimer(r, ctx) {
  const users = (ctx && ctx.users) || new Map();
  const userIds = [...new Set(r.assigned_to.map((u) => users.get(u)).filter((u) => isId(u, "user")))].slice(0, 8);
  const warnings = userIds.length < r.assigned_to.length ? ["timer_user_unknown"] : [];
  const lookup = (kind, rid) => (rid && ctx && typeof ctx.lookup === "function" ? ctx.lookup(kind, rid) : null);
  const visitId = r.visit_id ? (await lookup("visit", r.visit_id)) || idForRotor("visit", r.visit_id) : null;
  const vg = visitId ? await getRecord("visit", visitId) : null;
  const visit = vg ? vg.data : null;
  if (r.visit_id && !visit) warnings.push("timer_visit_missing");
  const jobId = visit ? visit.job_id : r.job_id ? (await lookup("job", r.job_id)) || idForRotor("job", r.job_id) : null;
  let end = r.end && Date.parse(r.end) >= Date.parse(r.start) ? r.end : null;
  let auto = null;
  if (!end) {
    // still running in Rotor: closed at its deadline, reported (§10.2 row 24)
    end = new Date(timerDeadline({ start_at: r.start }, visit && !CLOSED_VISIT.includes(visit.status) ? visit : null, {})).toISOString();
    auto = { at: r.start, reason: "stale", imported: true };
    warnings.push("timer_auto_closed");
  }
  const id = idForRotor("timer", r.id);
  return {
    records: [{ type: "timer", data: {
      id, ...(visit ? { visit_id: visit.id } : {}), ...(isId(jobId, "job") ? { job_id: jobId } : {}), user_ids: userIds, start_at: r.start, end_at: end,
      ...(auto ? { auto_closed: auto } : {}), ...(r.start_geo ? { start_geo: r.start_geo } : {}), ...(r.end_geo ? { end_geo: r.end_geo } : {}),
      rotor: { timer_id: r.id, minutes: minutesBetween(r.start, end) },
    } }],
    pointers: [{ kind: "rotor/timer", key: rotorKey(r.id), value: { id } }],
    warnings,
  };
}

export const timerPhase = { name: "work.timers", entity: "visit_timers", after: ["work.visits", "system.users"], normalize: normalizeTimer, map: mapTimer };

export { now };
