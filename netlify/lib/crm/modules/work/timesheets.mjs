// Work module, field part: shifts (timesheets), device times, pending
// entries, weekly approval and the pay estimate (design §2.5 "Times from
// the device", §5.5 timers and timesheets, §5.8, §9.2 Timesheets, §9.3
// Time and Pay, D3).
//
//   clockIn / clockOut      one open shift per person (ptr/clock/{uid}, a
//        "one open" pointer: a pointer to a closed or missing shift is free,
//        and a shift forgotten on an earlier day is closed at its deadline
//        first, so a stale pointer never blocks a clock-in, §3.7)
//   judgeTime(body)         an offline replay is recorded at its device time
//        (client_at) only when it was queued offline, |client_at − queued_at|
//        < 2 min and client_at lies within the last 7 days (and not ahead of
//        the server); otherwise the time becomes an entry pending approval
//   pending entries         timesheets with status pending_approval: a shift
//        whose start or end came from a device time the server didn't take,
//        and a replayed field change that no longer fit the visit (§2.5
//        "Conflicts": never a silent overwrite); the office approves (as
//        claimed, or edited) or rejects each one
//   locked periods          a shift that closes into a week payroll already
//        locked never changes that week: it becomes a payroll adjustment line
//        in the next open period (the payroll.addAdjustment service, M7a)
//        and the owners are told; until payroll ships it waits as a pending
//        entry (reason locked_period)
//   approveWeek             an owner or the office approves a person's week
//   payEstimate (pure)      hours, overtime over 40 h at 1.5x on Sunday to
//        Saturday weeks, at the person's rates (D3: $20 an hour for service
//        when no rate is set); an estimate, never a pay sheet (M7a)
//   clockSweep              work.clock: "Still clocked in?" at
//        cfg/work.clock_flag_at (19:00), and a forgotten shift closed at the
//        later of the day's last visit end + 2 h and clock_autoclose_at
//        (21:00), marked auto_closed for review
//   import phase 26         Rotor timesheets (closed; approved before the
//        last payroll run)

import {
  getRecord, getRecords, createRecord, updateRecord, readIndex, readPointer, claimOpenPointer, listRel, getSetting,
} from "../../../crm-store.mjs";
import { now, nowMs, nowIso, localDate, localTime, addLocalDays, zonedToUtc, dowOfDate, tsKey, isLocalDate } from "../../core/clock.mjs";
import { deriveId, newId, isId, idForRotor } from "../../core/ids.mjs";
import { InputError, NotFoundError, ConflictError, ExistsError, StaleError } from "../../core/errors.mjs";
import { notify, approvers } from "../../core/notify.mjs";
import { has as hasService, call as callService } from "../../core/services.mjs";
import { techView } from "../../core/perms.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { RowError } from "../contacts/import-rotor.mjs";
import { rotorKey } from "../contacts/display.mjs";
import { CATEGORIES, PAID_STATUSES, minutesBetween } from "./types-field.mjs";
import { W, workSettings } from "./office.mjs";

export const DAY_MS = 86400000;
export const TRUST_SKEW_MS = 2 * 60000;          // |client_at − queued_at| < 2 min
export const TRUST_AGE_MS = 7 * DAY_MS;          // client_at within the last 7 days
export const D3 = Object.freeze({ service_cents: 2000, ot_threshold_min: 40 * 60, ot_multiplier: 1.5 });
export const CLIENT_RE = /^[A-Za-z0-9-]{8,64}$/;
export const clientIdOf = (b) => (b && typeof b.client_id === "string" && CLIENT_RE.test(b.client_id) ? b.client_id.toLowerCase() : null);
const view = (r) => { if (!r) return r; const { _w, _etag, ...rest } = r; return rest; };

// ------------------------------------------------------------ weeks (Sunday to Saturday, Delano time)

export const weekOf = (date) => addLocalDays(date, -dowOfDate(date));
export function weekBounds(weekStart) {
  return { from: zonedToUtc(weekStart, "00:00"), to: zonedToUtc(addLocalDays(weekStart, 7), "00:00") };
}
// A week asked for (?week=YYYY-MM-DD, any day of it), or this week.
export function weekParam(v) {
  const s = String(v || "").trim();
  if (!s) return weekOf(localDate(now()));
  if (!isLocalDate(s)) throw new InputError("Use a date like 2026-11-15.", "week");
  return weekOf(s);
}

// ------------------------------------------------------------ device times (§2.5)

// The phone's own clock when it sent a replay (the outbox puts it in a
// header, X-CRM-Sent-At, so the body and its Idempotency-Key stay the same
// on every try). → ms, or null
export const SENT_AT_HEADER = "x-crm-sent-at";
export function sentAtOf(ctx) {
  const v = ctx && ctx.req && ctx.req.headers && typeof ctx.req.headers.get === "function" ? ctx.req.headers.get(SENT_AT_HEADER) : null;
  const ms = v ? Date.parse(v) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

// → { at, trusted, source: "server" | "device", reason?, client_at?, queued_at?, skew_ms? }
// A live request (not queued offline) is recorded at the server's time.
// sentAt (the phone's clock as it sent the replay) shows how far the
// phone's clock is off: off by more than 2 minutes, its times are moved by
// that much and the entry waits for the office (reason clock_skew).
export function judgeTime(body = {}, t = nowMs(), { sentAt = null } = {}) {
  const server = { at: new Date(t).toISOString(), trusted: true, source: "server" };
  if (!body || body.queued_offline !== true) return server;
  let ca = Date.parse(body.client_at);
  let qa = Date.parse(body.queued_at);
  const device = { source: "device", ...(Number.isFinite(ca) ? { client_at: new Date(ca).toISOString() } : {}), ...(Number.isFinite(qa) ? { queued_at: new Date(qa).toISOString() } : {}) };
  const skew = Number.isFinite(sentAt) ? t - sentAt : 0;          // > 0: the phone's clock is behind
  const skewed = Math.abs(skew) > TRUST_SKEW_MS;
  if (skewed) {
    device.skew_ms = skew;
    if (Number.isFinite(ca)) ca += skew;
    if (Number.isFinite(qa)) qa += skew;
  }
  let reason = null;
  if (!Number.isFinite(ca) || !Number.isFinite(qa)) reason = "no_device_time";
  else if (Math.abs(ca - qa) >= TRUST_SKEW_MS) reason = "queued_mismatch";
  else if (ca > t + TRUST_SKEW_MS) reason = "future";
  else if (ca < t - TRUST_AGE_MS) reason = "too_old";
  else if (skewed) reason = "clock_skew";
  if (!reason) return { ...device, at: new Date(Math.min(ca, t)).toISOString(), trusted: true };
  // what the phone claims (its clock set right), kept for the office, but never outside the last 7 days
  const claimed = Number.isFinite(ca) ? Math.max(t - TRUST_AGE_MS, Math.min(ca, t)) : t;
  return { ...device, at: new Date(claimed).toISOString(), trusted: false, reason };
}
export const timeOf = (ctx) => judgeTime((ctx && ctx.body) || {}, nowMs(), { sentAt: sentAtOf(ctx) });
export const deviceFields = (time) => (time && time.source === "device" ? { ...(time.client_at ? { client_at: time.client_at } : {}), ...(time.queued_at ? { queued_at: time.queued_at } : {}), ...(time.skew_ms ? { skew_ms: time.skew_ms } : {}) } : {});

// ------------------------------------------------------------ people

export async function userRecord(id) {
  if (!isId(id, "user")) return null;
  const g = await getRecord("user", id);
  return g ? g.data : null;
}
// Owners and the office (who approve time, and hear about auto-closed shifts).
export async function officeUsers() {
  const ix = await readIndex("users", "");
  return ix.rows.filter((r) => ["owner", "admin"].includes(r.role) && r.status === "active").map((r) => r.id);
}
const firstName = (u) => (u && (u.first_name || String(u.name || "").split(/\s+/)[0])) || "Someone";

// ------------------------------------------------------------ open shifts

const isOpenSheet = (s) => !!s && !s.deleted_at && s.status === "open" && !s.end_at;
async function isOpenSheetId(id) {
  if (!isId(id, "timesheet")) return false;
  const g = await getRecord("timesheet", id);
  return !!g && isOpenSheet(g.data);
}
// The person's open shift, or null (a pointer to a closed or missing one is free).
export async function openSheetOf(userId) {
  const p = await readPointer("clock", userId);
  if (!p || !isId(p.id, "timesheet")) return null;
  const g = await getRecord("timesheet", p.id);
  return g && isOpenSheet(g.data) ? g.data : null;
}

// The latest end of a person's visits on a day (UTC ms), or null.
export async function lastVisitEnd(userId, date) {
  const rows = await listRel("tech-visits", userId, { from: date, to: date, limit: 40 }).catch(() => []);
  if (!rows.length) return null;
  const visits = (await getRecords("visit", rows.map((r) => r.id))).filter(Boolean).map((g) => g.data)
    .filter((v) => !v.deleted_at && (v.assignee_ids || []).includes(userId) && v.status !== "cancelled" && v.date === date);
  const ends = visits.map((v) => Date.parse(v.end_utc)).filter(Number.isFinite);
  return ends.length ? Math.max(...ends) : null;
}

// When a forgotten shift closes: the later of the day's last visit end +
// timer_autoclose_after_min (2 h) and clock_autoclose_at (21:00). A shift
// begun at or after that hour (an evening's lights work) runs to its start
// + LATE_SHIFT_MS (6 h, into the next day) instead. → ms
export const LATE_SHIFT_MS = 6 * 3600000;
export async function shiftDeadline(sheet, s) {
  const day = localDate(new Date(sheet.start_at));
  const start = Date.parse(sheet.start_at);
  const autoclose = zonedToUtc(day, s.clock_autoclose_at || "21:00").getTime();
  const last = await lastVisitEnd(sheet.user_id, day);
  const afterVisits = last ? last + (s.timer_autoclose_after_min || 120) * 60000 : 0;
  return Math.max(start >= autoclose ? start + LATE_SHIFT_MS : autoclose, afterVisits, start + 60000);
}

// ------------------------------------------------------------ locked weeks (§5.8)

// Whether payroll locked the period holding this instant for the person:
// the payroll module's word when it is there (payroll.periodStatus), else a
// locked shift of theirs in the same week (payroll locks a period's shifts).
export async function periodLocked(userId, atIso, { exceptId, ctx } = {}) {
  if (hasService("payroll.periodStatus")) {
    try {
      const st = await callService("payroll.periodStatus", { user_id: userId, at: atIso }, ctx || {});
      return st === "locked" || st === "paid";
    } catch (e) {
      console.error(`crm:work: payroll period not read (${safeErr(e)})`);
    }
  }
  const ws = weekOf(localDate(new Date(atIso)));
  const { from, to } = weekBounds(ws);
  const rows = await listRel("user-timesheets", userId, { from: tsKey(from), to: tsKey(new Date(to.getTime() - 1)), limit: 80 }).catch(() => []);
  const ids = rows.map((r) => r.id).filter((id) => id !== exceptId);
  if (!ids.length) return false;
  return (await getRecords("timesheet", ids)).filter(Boolean).some((g) => g.data.status === "locked");
}

// A shift that closed into a locked week: a payroll adjustment line in the
// next open period (or, before payroll ships, a pending entry), and the
// owners are told. → the status the shift gets
async function lockedOutcome(sheet, w) {
  if (hasService("payroll.addAdjustment")) return "adjusted";
  return "pending_approval";
}
async function afterLocked(sheet, w) {
  const minutes = sheet.minutes || 0;
  let line = null;
  if (sheet.status === "adjusted" && hasService("payroll.addAdjustment")) {
    try {
      line = await callService("payroll.addAdjustment", {
        user_id: sheet.user_id, minutes, category: sheet.category, start_at: sheet.start_at, end_at: sheet.end_at, timesheet_id: sheet.id,
        note: `Late time entry: ${minutes} min on ${localDate(new Date(sheet.start_at))} (the week was locked)`,
      }, w);
    } catch (e) {
      console.error(`crm:work: adjustment line not made (${safeErr(e)})`);
    }
    if (line) await updateRecord("timesheet", sheet.id, (x) => (x.adjustment && x.adjustment.line ? null : { ...x, adjustment: { ...(x.adjustment || {}), line: typeof line === "string" ? line : line.id || true, at: nowIso() } }), w).catch(() => {});
  }
  const owners = await approvers().catch(() => []);
  const u = await userRecord(sheet.user_id).catch(() => null);
  await notify(owners.slice(0, 5), {
    kind: "approval", title: "Time for a locked week",
    body: `${firstName(u)} has ${minutes} min on ${localDate(new Date(sheet.start_at))}, a week payroll already locked. ${sheet.status === "adjusted" ? "It went in as an adjustment in the next pay period." : "It waits on Timesheets."}`,
    link: "/timesheets",
  }, w).catch((e) => console.error(`crm:work: owners not told (${safeErr(e)})`));
}

// ------------------------------------------------------------ closing a shift

// Closes a shift at `endIso` (clamped to its start): closed, or pending when
// a time in it came from a device the server didn't take, or the locked
// week's outcome. extra: fields to merge (auto_closed, flags, end_geo...).
// → the shift as written
export async function closeSheet(sheet, endIso, w, { extra = {}, untrusted = null, endClientId } = {}) {
  const end = new Date(Math.max(Date.parse(endIso), Date.parse(sheet.start_at))).toISOString();
  const pending = !!sheet.pending || !!untrusted;
  const locked = await periodLocked(sheet.user_id, sheet.start_at, { exceptId: sheet.id, ctx: w });
  const status = locked ? await lockedOutcome(sheet, w) : pending ? "pending_approval" : "closed";
  const r = await updateRecord("timesheet", sheet.id, (x) => {
    if (!isOpenSheet(x)) return null;
    const next = { ...x, ...extra, end_at: end, status };
    if (endClientId) next.end_client_id = endClientId;
    if (untrusted) next.pending = { ...(x.pending || {}), reason: (x.pending && x.pending.reason) || untrusted.reason, end: { claimed: untrusted.at, received: nowIso(), reason: untrusted.reason } };
    if (status === "adjusted") next.adjustment = { at: nowIso(), minutes: minutesBetween(x.start_at, end) };
    if (status === "pending_approval" && locked) next.pending = { ...(next.pending || {}), reason: "locked_period", locked: true };
    return next;
  }, w);
  if (r.changed && locked) await afterLocked(r.data, w);
  return r.data;
}

// A forgotten shift, closed at its deadline for review.
export async function autoCloseSheet(sheet, deadlineMs, w, reason = "forgotten") {
  const done = await closeSheet(sheet, new Date(deadlineMs).toISOString(), w, {
    extra: { auto_closed: { at: nowIso(), reason }, flags: [...new Set([...(sheet.flags || []), "auto_closed"])] },
  });
  const office = await officeUsers().catch(() => []);
  const u = await userRecord(sheet.user_id).catch(() => null);
  await notify([sheet.user_id], { kind: "clock_reminder", title: "Clocked out for you", body: `Your shift was closed at ${localTime(new Date(deadlineMs))}. Ask the office if that's wrong.`, link: "/time" }, w).catch(() => {});
  await notify(office.filter((x) => x !== sheet.user_id).slice(0, 5), { kind: "system", title: "A shift was closed for review", body: `${firstName(u)} never clocked out on ${localDate(new Date(sheet.start_at))}. Check it on Timesheets.`, link: "/timesheets" }, w).catch(() => {});
  return done;
}

// ------------------------------------------------------------ clock in / out

// A replay is a change the phone made with no signal and sends now: its
// time is the phone's (judgeTime), and it may disagree with what the
// person did meanwhile on another phone.
const isDevice = (time) => !!time && time.source === "device";

// The person's shifts that overlap [fromMs, toMs) (an open one runs to
// now), but not entries that only report a change (a conflict entry spans
// no time) nor ones the office didn't count. → shifts
export async function overlapping(userId, fromMs, toMs, { exceptId } = {}) {
  const rows = await listRel("user-timesheets", userId, { from: tsKey(new Date(fromMs - DAY_MS)), to: tsKey(new Date(Math.max(fromMs, toMs))), limit: 60 }).catch(() => []);
  const ids = rows.map((r) => r.id).filter((id) => id !== exceptId);
  if (!ids.length) return [];
  const t = nowMs();
  return (await getRecords("timesheet", ids)).filter(Boolean).map((g) => g.data).filter((s) => {
    if (s.deleted_at || s.user_id !== userId || s.status === "rejected") return false;
    if (s.pending && s.pending.reason === "conflict") return false;
    const a = Date.parse(s.start_at);
    const b = s.end_at ? Date.parse(s.end_at) : s.status === "open" ? t : a;
    return b > a && a < toMs && b > fromMs;
  });
}

// A shift a phone sent that overlaps another of the person's (two phones,
// or a replay after the person clocked in elsewhere): kept, with what the
// phone said, as an entry pending the office's decision (reason overlap);
// it never counts until approved. Its id is the one the shift would have
// had, so the phone's clock-out finds it. → the entry
async function overlapEntry(user, { category, time, clientId, withIds, geo, visitId }, w) {
  const id = clientId ? deriveId("timesheet", `c:${clientId}`) : newId("timesheet");
  try {
    const r = await createRecord("timesheet", {
      id, user_id: user.id, category, start_at: time.at, status: "pending_approval", notes: [], edits: [], received_at: nowIso(), ...deviceFields(time),
      ...(clientId ? { client_id: clientId } : {}), ...(geo ? { start_geo: geo } : {}), ...(visitId ? { visit_id: visitId } : {}),
      pending: { reason: "overlap", with: (withIds || []).slice(0, 6), start: { claimed: time.at, received: nowIso(), reason: time.trusted ? "overlap" : time.reason }, told: true },
    }, w);
    await tellOffice(user, { title: "Two shifts at once", body: `${firstName(user)}'s phone sent a shift that overlaps another of theirs. It waits on Timesheets.`, visitId: null, exceptId: id }, w);
    return r.data;
  } catch (e) {
    if (!(e instanceof ExistsError)) throw e;
    return (await getRecord("timesheet", id)).data;
  }
}

// time: judgeTime(); → { sheet, created?, already?, replay?, pending?, closed_forgotten? }
export async function clockIn(user, { category = "service", time, clientId = null, geo, visitId } = {}, w) {
  if (!CATEGORIES.includes(category)) throw new InputError("Pick service, sales or office.", "category");
  const id = clientId ? deriveId("timesheet", `c:${clientId}`) : newId("timesheet");
  if (clientId) {
    const had = await getRecord("timesheet", id);
    if (had) return { sheet: had.data, replay: true };
  }
  const t = time || judgeTime({});
  let closedForgotten = null;
  let open = await openSheetOf(user.id);
  if (open) {
    const s = await workSettings();
    const deadline = await shiftDeadline(open, s);
    if (nowMs() >= deadline) {
      // a shift forgotten on an earlier day never blocks clocking in (§3.7)
      closedForgotten = await autoCloseSheet(open, deadline, w);
      open = null;
    }
  }
  if (open) {
    // live: one shift at a time; a replay is another shift than the open one (another phone): the office decides
    if (!isDevice(t)) return { sheet: open, already: true };
    return { sheet: await overlapEntry(user, { category, time: t, clientId, withIds: [open.id], geo, visitId }, w), pending: true };
  }
  if (isDevice(t)) {
    const over = await overlapping(user.id, Date.parse(t.at), nowMs());
    if (over.length) return { sheet: await overlapEntry(user, { category, time: t, clientId, withIds: over.map((x) => x.id), geo, visitId }, w), pending: true };
  }
  const claim = await claimOpenPointer("clock", user.id, { id }, isOpenSheetId);
  if (!claim.ok) {
    const cur = claim.current && isId(claim.current.id, "timesheet") ? await getRecord("timesheet", claim.current.id) : null;
    if (cur) return { sheet: cur.data, already: true };
    throw new ConflictError("Clocking in didn't go through. Try again.");
  }
  const data = {
    id, user_id: user.id, category, start_at: t.at, status: "open", notes: [], edits: [], received_at: nowIso(), ...deviceFields(t),
    ...(clientId ? { client_id: clientId } : {}), ...(geo ? { start_geo: geo } : {}), ...(visitId ? { visit_id: visitId } : {}),
    ...(t.trusted ? {} : { pending: { reason: t.reason, start: { claimed: t.at, received: nowIso(), reason: t.reason } } }),
  };
  try {
    const r = await createRecord("timesheet", data, w);
    return { sheet: r.data, created: true, ...(closedForgotten ? { closed_forgotten: closedForgotten } : {}) };
  } catch (e) {
    if (!(e instanceof ExistsError)) throw e;
    const g = await getRecord("timesheet", id);
    if (!g) throw e;
    return { sheet: g.data, replay: true };
  }
}

// shiftClientId: the client id of the shift the phone believes it closes
// (its own clock-in, or the timer start that clocked it in). A replay that
// names another shift than the open one ends the phone's own (an overlap
// entry waiting for the office), or disagrees and goes to the office.
// → { sheet, closed?, replay?, none?, pending?, disagree?, other? (the phone's own shift, not the open one) }
export async function clockOut(user, { time, clientId = null, geo, shiftClientId = null } = {}, w) {
  if (clientId) {
    const recent = await listRel("user-timesheets", user.id, { limit: 10 }).catch(() => []);
    const mine = (await getRecords("timesheet", recent.map((r) => r.id))).filter(Boolean).map((g) => g.data).find((x) => x.end_client_id === clientId);
    if (mine) return { sheet: mine, replay: true };
  }
  const t = time || judgeTime({});
  const open = await openSheetOf(user.id);
  if (isDevice(t) && shiftClientId) {
    const sid = deriveId("timesheet", `c:${shiftClientId}`);
    if (!open || open.id !== sid) {
      const g = await getRecord("timesheet", sid);
      const own = g && !g.data.deleted_at && g.data.user_id === user.id ? g.data : null;
      if (own && own.status === "pending_approval" && !own.end_at) {
        const end = new Date(Math.max(Date.parse(t.at), Date.parse(own.start_at))).toISOString();
        // with its end known, a shift that turns out not to overlap anything (an earlier offline
        // shift, replayed after another phone's began) is an ordinary one again when its times were
        // taken; when they weren't, it waits for that reason instead
        const free = own.pending && own.pending.reason === "overlap" && !(await overlapping(user.id, Date.parse(own.start_at), Date.parse(end), { exceptId: own.id })).length;
        const startWhy = own.pending && own.pending.start && own.pending.start.reason !== "overlap" ? own.pending.start.reason : null;
        const locked = free ? await periodLocked(user.id, own.start_at, { exceptId: own.id, ctx: w }) : false;
        const clear = free && !startWhy && t.trusted && !locked;
        const r = await updateRecord("timesheet", own.id, (x) => {
          if (x.end_at || x.status !== "pending_approval") return null;
          const base = { ...x, end_at: end, ...(clientId ? { end_client_id: clientId } : {}), ...(geo ? { end_geo: geo } : {}) };
          if (clear) { const { pending: _p, ...rest } = base; return { ...rest, status: "closed", flags: [...new Set([...(x.flags || []), "overlap_cleared"])] }; }
          const { with: _w, ...kept } = x.pending || {};
          const why = free ? (locked ? "locked_period" : startWhy || t.reason || "overlap") : (x.pending && x.pending.reason) || "overlap";
          return { ...base, pending: { ...(free ? kept : x.pending || {}), reason: why, ...(free && locked ? { locked: true } : {}), end: { claimed: end, received: nowIso(), reason: t.trusted ? why : t.reason } } };
        }, w);
        return { sheet: r.data, closed: true, pending: r.data.status === "pending_approval", other: true };
      }
      if (own || open) return { disagree: true, sheet: own || open, why: own ? "closed" : "other" };
    }
  }
  if (!open) return { none: true };
  // a replayed end before the open shift began isn't this shift's end
  if (isDevice(t) && Date.parse(t.at) < Date.parse(open.start_at)) return { disagree: true, sheet: open, why: "other" };
  const sheet = await closeSheet(open, t.at, w, { extra: { ...(geo ? { end_geo: geo } : {}) }, untrusted: t.trusted ? null : t, endClientId: clientId || undefined });
  return { sheet, closed: true };
}

// The shift a visit timer needs: starting work while clocked out clocks
// the person in (service). → { sheet, created? }
export async function ensureClockedIn(user, time, clientId, w, { visitId } = {}) {
  const open = await openSheetOf(user.id);
  if (open) return { sheet: open, already: true };
  // the timer's client id names the shift too (another record type, so another id)
  return clockIn(user, { category: "service", time, clientId, visitId }, w);
}

// The office hears about offline work to check, once an hour per person
// and visit (a queue of changes to one visit is one message).
async function tellOffice(user, { title, body, visitId, exceptId }, w) {
  const recent = await listRel("user-timesheets", user.id, { limit: 12 }).catch(() => []);
  const since = nowMs() - 3600000;
  const others = (await getRecords("timesheet", recent.map((r) => r.id))).filter(Boolean).map((g) => g.data)
    .filter((x) => x.id !== exceptId && x.status === "pending_approval" && x.pending && x.pending.told && Date.parse(x.received_at || x.created_at) > since && (x.visit_id || null) === (visitId || null));
  if (others.length) return false;
  const office = await officeUsers().catch(() => []);
  await notify(office.slice(0, 5), { kind: "approval", title, body, link: "/timesheets" }, w).catch(() => {});
  return true;
}

// What an offline change said, kept on its entry so nothing the tech did is
// lost (text, a checklist value, a line); never a customer's details.
export function payloadOf(action, b = {}) {
  const s = (v, n) => (v === undefined || v === null ? undefined : String(v).trim().slice(0, n) || undefined);
  const out = {
    notes: { text: s(b.text, 1000) }, incident: { text: s(b.text, 2000) }, no_access: { note: s(b.note, 500) },
    checklist: { key: s(b.key, 80), done: b.done === true, value: typeof b.value === "number" ? b.value : s(b.value, 500) },
    lines: { price_item_id: s(b.price_item_id, 40), qty: Number.isFinite(Number(b.qty)) ? Number(b.qty) : undefined },
    photo: { tag: s(b.tag, 20), item: s(b.item, 80) },
  }[action];
  if (!out) return undefined;
  const clean = Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
  return Object.keys(clean).length ? clean : undefined;
}

// A pending entry for a replayed change that no longer fits (§2.5
// "Conflicts"): kept for the office with what the phone said, never
// applied over what happened since (or, applied: true, applied but worth
// a look: a tick on a visit the office cancelled). reason: conflict, overlap,
// moved, cancelled, lost (the person wasn't on the visit any more: the
// entry then holds no visit details) or stale. → the entry
export async function conflictEntry({ user, visit, visitId, action, message, time, clientId, item, reason = "conflict", payload, applied = false, lost = false, extra }, w) {
  const id = clientId ? deriveId("timesheet", `c:${clientId}`, "conflict") : newId("timesheet");
  const had = await getRecord("timesheet", id);
  if (had) return had.data;
  const at = (time && time.at) || nowIso();
  const vid = (visit && visit.id) || visitId || null;
  try {
    const r = await createRecord("timesheet", {
      id, user_id: user.id, category: "service", start_at: at, end_at: at, status: "pending_approval", notes: [], edits: [], received_at: nowIso(), ...deviceFields(time),
      ...(vid ? { visit_id: vid } : {}),
      pending: {
        reason, action: String(action || "change").slice(0, 30), detail: String(message || "").slice(0, 200), claimed: at, trusted: !!(time && time.trusted),
        ...(visit && !lost ? { visit_status: visit.status, visit_date: visit.date, job_title: visit.job_title || undefined } : {}),
        ...(item ? { item: String(item).slice(0, 120) } : {}), ...(payload ? { payload } : {}), ...(applied ? { applied: true } : {}), ...(extra || {}),
        told: true,
      },
    }, w);
    await tellOffice(user, { title: "Offline work to check", body: `${firstName(user)}'s offline ${String(action || "change").replace(/_/g, " ")} ${applied ? "went in, but needs a look" : "couldn't be applied"}. It waits on Timesheets.`, visitId: vid, exceptId: id }, w);
    return r.data;
  } catch (e) {
    if (!(e instanceof ExistsError)) throw e;
    return (await getRecord("timesheet", id)).data;
  }
}

// ------------------------------------------------------------ reading a week

// A person's shifts that started in the week (local), oldest first.
export async function sheetsInWeek(userId, weekStart) {
  const { from, to } = weekBounds(weekStart);
  const rows = await listRel("user-timesheets", userId, { from: tsKey(from), to: tsKey(new Date(to.getTime() - 1)), limit: 120, newestFirst: false });
  return (await getRecords("timesheet", rows.map((r) => r.id))).filter(Boolean).map((g) => g.data).filter((s) => !s.deleted_at && s.user_id === userId)
    .sort((a, b) => String(a.start_at).localeCompare(String(b.start_at)));
}
export async function timersInWeek(userId, weekStart) {
  const { from, to } = weekBounds(weekStart);
  const rows = await listRel("user-timers", userId, { from: tsKey(from), to: tsKey(new Date(to.getTime() - 1)), limit: 120, newestFirst: false });
  return (await getRecords("timer", rows.map((r) => r.id))).filter(Boolean).map((g) => g.data).filter((t) => !t.deleted_at && (t.user_ids || []).includes(userId))
    .sort((a, b) => String(a.start_at).localeCompare(String(b.start_at)));
}

// ------------------------------------------------------------ the pay estimate (D3, §5.8; pure)

// A person's hourly rate for a category in cents: their own, else the
// service rate, else D3's $20.
export function rateFor(user, category) {
  const h = (user && user.pay && user.pay.hourly_cents) || {};
  const own = Number.isSafeInteger(h[category]) && h[category] > 0 ? h[category] : null;
  if (own) return { cents: own, set: true };
  const service = Number.isSafeInteger(h.service) && h.service > 0 ? h.service : null;
  return { cents: service || D3.service_cents, set: !!service };
}

// sheets: the week's shifts. → minutes by status and category, overtime,
// and the estimate in cents (regular hours at their categories' rates,
// overtime at 1.5x the week's weighted rate).
export function payEstimate(sheets, user, { otThresholdMin = D3.ot_threshold_min, otMultiplier = D3.ot_multiplier, at = nowMs() } = {}) {
  const byCat = {};
  let minutes = 0, pending = 0, open = 0, excluded = 0, auto = 0;
  for (const s of sheets || []) {
    if (s.status === "open") { open += Math.max(0, Math.round((at - Date.parse(s.start_at)) / 60000)); continue; }
    const m = Number.isFinite(s.minutes) ? s.minutes : s.end_at ? minutesBetween(s.start_at, s.end_at) : 0;
    if (s.status === "pending_approval") { pending += m; continue; }
    if (!PAID_STATUSES.includes(s.status)) { excluded += m; continue; }
    if (s.auto_closed) auto += 1;
    byCat[s.category || "service"] = (byCat[s.category || "service"] || 0) + m;
    minutes += m;
  }
  const rates = Object.fromEntries(CATEGORIES.map((c) => [c, rateFor(user, c)]));
  const straight = Object.entries(byCat).reduce((sum, [c, m]) => sum + m * (rates[c] || rates.service).cents, 0);   // minute-cents
  const weighted = minutes ? straight / minutes : rates.service.cents;
  const otMin = Math.max(0, minutes - otThresholdMin);
  const regMin = minutes - otMin;
  const regularCents = Math.round((weighted * regMin) / 60);
  const otCents = Math.round((weighted * otMin * otMultiplier) / 60);
  return {
    minutes, regular_min: regMin, ot_min: otMin, by_category: byCat, pending_min: pending, open_min: open, excluded_min: excluded, auto_closed: auto,
    rate_cents: Math.round(weighted), rates: Object.fromEntries(Object.entries(rates).map(([c, r]) => [c, r.cents])), rate_is_default: !rates.service.set,
    regular_cents: regularCents, ot_cents: otCents, total_cents: regularCents + otCents, estimate: true,
    near_ot: minutes + open >= otThresholdMin - 4 * 60, over_ot: minutes + open > otThresholdMin,
  };
}

export async function payrollSettings() {
  const p = await getSetting("payroll").catch(() => null);
  return {
    otThresholdMin: p && Number.isFinite(p.ot_threshold_hours) ? p.ot_threshold_hours * 60 : D3.ot_threshold_min,
    otMultiplier: p && Number.isFinite(p.ot_multiplier) ? p.ot_multiplier : D3.ot_multiplier,
  };
}

// ------------------------------------------------------------ the office: edit, approve, decide

const EDITABLE = ["start_at", "end_at", "category"];
function editInput(b) {
  const out = {};
  for (const k of ["start_at", "end_at"]) {
    if (b[k] === undefined) continue;
    if (typeof b[k] !== "string" || Number.isNaN(Date.parse(b[k]))) throw new InputError("That isn't a time.", k);
    out[k] = new Date(b[k]).toISOString();
  }
  if (b.category !== undefined) {
    if (!CATEGORIES.includes(b.category)) throw new InputError("Pick service, sales or office.", "category");
    out.category = b.category;
  }
  return out;
}

// PATCH /timesheets/:id: an edit with a reason (If-Match). → the shift
export async function editSheet(id, body, ctx) {
  if (!ctx.ifMatch) throw new InputError("This change needs the version you edited (If-Match).", "if-match");
  const reason = String((body && body.reason) || "").trim().slice(0, 300);
  if (!reason) throw new InputError("Say why it changed.", "reason");
  const got = isId(id, "timesheet") ? await getRecord("timesheet", id) : null;
  if (!got || got.data.deleted_at) throw new NotFoundError("That time entry isn't there.");
  const cur = got.data;
  if (cur.status === "locked") throw new ConflictError("That week is locked by payroll. Add an adjustment there instead.");
  if (["rejected", "adjusted"].includes(cur.status)) throw new ConflictError("That entry is settled.");
  const patch = editInput(body || {});
  if (!Object.keys(patch).length) throw new InputError("Change the start, the end or the category.", "start_at");
  const start = patch.start_at || cur.start_at;
  const end = patch.end_at !== undefined ? patch.end_at : cur.end_at;
  if (end && Date.parse(end) < Date.parse(start)) throw new InputError("It ends after it starts.", "end_at");
  if (end && Date.parse(end) - Date.parse(start) > 24 * 3600000) throw new InputError("A shift is at most 24 hours.", "end_at");
  if (patch.start_at && localDate(new Date(patch.start_at)) !== localDate(new Date(cur.start_at)) && await periodLocked(cur.user_id, patch.start_at, { exceptId: cur.id })) {
    throw new ConflictError("That would move it into a week payroll locked.");
  }
  const by = ctx.user ? ctx.user.id : "office";
  const at = nowIso();
  const w = { ...W(ctx), ifMatch: ctx.ifMatch };
  const r = await updateRecord("timesheet", cur.id, (x) => {
    const next = { ...x };
    const edits = [...(x.edits || [])];
    for (const k of EDITABLE) {
      if (patch[k] === undefined || patch[k] === x[k]) continue;
      edits.push({ by, at, field: k, before: x[k] ?? null, after: patch[k], reason });
      next[k] = patch[k];
    }
    if (edits.length === (x.edits || []).length) return null;
    next.edits = edits.slice(-100);
    next.flags = [...new Set([...(x.flags || []), "edited"])];
    // an edited approved entry needs approving again; an open shift the office ends is closed
    if (x.status === "approved") next.status = "closed";
    if (x.status === "open" && next.end_at) next.status = x.pending ? "pending_approval" : "closed";
    delete next.approved_at; delete next.approved_by;
    return next;
  }, w);
  return { sheet: r.data, etag: r.etag };
}

// POST /timesheets/approve { user_id, week_start }: every closed shift of
// that week → approved, up to APPROVE_BATCH a request (more: true asks
// again; the app does). Open and pending ones wait (counted).
export const APPROVE_BATCH = 20;
export async function approveWeek(userId, weekStart, ctx) {
  if (!isId(userId, "user")) throw new InputError("Whose week?", "user_id");
  const ws = weekParam(weekStart);
  const sheets = await sheetsInWeek(userId, ws);
  const by = ctx.user ? ctx.user.id : "office";
  const at = nowIso();
  let approved = 0;
  const closed = sheets.filter((x) => x.status === "closed");
  for (const s of closed.slice(0, APPROVE_BATCH)) {
    const r = await updateRecord("timesheet", s.id, (x) => (x.status !== "closed" ? null : { ...x, status: "approved", approved_at: at, approved_by: by }), W(ctx));
    if (r.changed) approved += 1;
  }
  return {
    week_start: ws, user_id: userId, approved, more: closed.length > APPROVE_BATCH,
    open: sheets.filter((x) => x.status === "open").length, pending: sheets.filter((x) => x.status === "pending_approval").length,
    already: sheets.filter((x) => x.status === "approved" || x.status === "locked").length,
  };
}

// POST /timesheets/:id/decide { decision: "approve" | "reject", start_at?, end_at?, reason? }
// for an entry pending approval. → the entry
export async function decidePending(id, body, ctx) {
  const got = isId(id, "timesheet") ? await getRecord("timesheet", id) : null;
  if (!got || got.data.deleted_at) throw new NotFoundError("That time entry isn't there.");
  const cur = got.data;
  if (cur.status !== "pending_approval") throw new ConflictError("That entry isn't waiting for a decision.");
  const decision = body && body.decision;
  if (!["approve", "reject"].includes(decision)) throw new InputError("Approve or reject?", "decision");
  const by = ctx.user ? ctx.user.id : "office";
  const at = nowIso();
  const reason = String((body && body.reason) || "").trim().slice(0, 300);
  const patch = decision === "approve" ? editInput(body || {}) : {};
  if (Object.keys(patch).length && !reason) throw new InputError("Say why the time changed.", "reason");
  const start = patch.start_at || cur.start_at;
  const end = patch.end_at || cur.end_at;
  if (decision === "approve" && !end) throw new InputError("Set when it ended.", "end_at");
  if (end && Date.parse(end) < Date.parse(start)) throw new InputError("It ends after it starts.", "end_at");
  const locked = decision === "approve" && await periodLocked(cur.user_id, start, { exceptId: cur.id, ctx: W(ctx) });
  const status = decision === "reject" ? "rejected" : locked ? await lockedOutcome(cur, W(ctx)) : "approved";
  if (status === "pending_approval") throw new ConflictError("That week is locked by payroll. It can be paid as an adjustment once payroll is set up.");
  const r = await updateRecord("timesheet", cur.id, (x) => {
    if (x.status !== "pending_approval") return null;
    const next = { ...x, status, pending: { ...(x.pending || {}), decided: decision, decided_by: by, decided_at: at } };
    const edits = [...(x.edits || [])];
    for (const k of EDITABLE) {
      if (patch[k] === undefined || patch[k] === x[k]) continue;
      edits.push({ by, at, field: k, before: x[k] ?? null, after: patch[k], reason });
      next[k] = patch[k];
    }
    next.edits = edits.slice(-100);
    if (status === "approved") { next.approved_at = at; next.approved_by = by; }
    return next;
  }, { ...W(ctx), ...(ctx.ifMatch ? { ifMatch: ctx.ifMatch } : {}) });
  if (r.changed && status === "adjusted") await afterLocked(r.data, W(ctx));
  return { sheet: r.data, etag: r.etag };
}

// ------------------------------------------------------------ the office's week (GET /timesheets)

export async function officeWeek(weekStart, { userId } = {}) {
  const ws = weekParam(weekStart);
  const { from, to } = weekBounds(ws);
  const months = [...new Set([localDate(from).slice(0, 7), localDate(new Date(to.getTime() - 1)).slice(0, 7)])];
  const [ixs, users] = await Promise.all([Promise.all(months.map((m) => readIndex("timesheets", m))), readIndex("users", "")]);
  const rows = ixs.flatMap((ix) => ix.rows).filter((r) => (!userId || r.uid === userId));
  const inWeek = rows.filter((r) => Date.parse(r.s) >= from.getTime() && Date.parse(r.s) < to.getTime()).sort((a, b) => String(a.s).localeCompare(String(b.s)));
  // entries pending a decision from any week (the office clears them wherever they are)
  const todo = await readIndex("timesheets-todo", "");
  const pending = todo.rows.filter((r) => r.st === "pending_approval" && (!userId || r.uid === userId)).sort((a, b) => String(a.s).localeCompare(String(b.s)));
  const people = users.rows.filter((u) => u.status === "active" && (u.is_technician || inWeek.some((r) => r.uid === u.id)) && (!userId || u.id === userId))
    .map((u) => ({ id: u.id, name: u.name, first_name: u.first_name, color: u.color, role: u.role, is_technician: !!u.is_technician }));
  const per = people.map((p) => {
    const mine = inWeek.filter((r) => r.uid === p.id);
    const minutes = mine.filter((r) => PAID_STATUSES.includes(r.st)).reduce((s, r) => s + (r.min || 0), 0);
    return {
      user_id: p.id, entries: mine, minutes, ot_min: Math.max(0, minutes - D3.ot_threshold_min),
      to_approve: mine.filter((r) => r.st === "closed").length, approved: mine.filter((r) => r.st === "approved" || r.st === "locked").length,
      open: mine.filter((r) => r.st === "open").length, pending: mine.filter((r) => r.st === "pending_approval").length,
      flagged: mine.filter((r) => r.ac || r.ed).length,
    };
  });
  return { week_start: ws, week_end: addLocalDays(ws, 6), people, weeks: per, pending, stale: ixs.some((ix) => ix.stale) };
}

// Counts for Home's "Needs you" and the badge: one read of the small index
// of what waits for the office (types-field.mjs "timesheets-todo").
export async function pendingCount() {
  const ix = await readIndex("timesheets-todo", "");
  return ix.rows.filter((r) => r.st === "pending_approval").length;
}
export async function weeksToApprove() {
  const ix = await readIndex("timesheets-todo", "");
  const thisWeek = weekOf(localDate(now()));
  const keys = new Set(ix.rows.filter((r) => r.st === "closed" && weekOf(r.d) < thisWeek).map((r) => `${r.uid}|${weekOf(r.d)}`));
  return keys.size;
}

// ------------------------------------------------------------ what a person sees (GET /me/timesheets, /me/pay)

export async function myWeek(user, weekStart) {
  const ws = weekParam(weekStart);
  const [sheets, timers, open, p] = await Promise.all([sheetsInWeek(user.id, ws), timersInWeek(user.id, ws), openSheetOf(user.id), payrollSettings()]);
  const visitIds = [...new Set(timers.map((t) => t.visit_id).filter(Boolean))].slice(0, 60);
  const visits = new Map((await getRecords("visit", visitIds)).filter(Boolean).map((g) => [g.data.id, g.data]));
  const days = {};
  for (let i = 0; i < 7; i++) days[addLocalDays(ws, i)] = 0;
  for (const s of sheets) {
    const d = localDate(new Date(s.start_at));
    if (PAID_STATUSES.includes(s.status) && days[d] !== undefined) days[d] += s.minutes || 0;
  }
  const est = payEstimate(sheets, user, p);
  return {
    week_start: ws, week_end: addLocalDays(ws, 6),
    shifts: sheets.map((s) => techView("timesheet", s)),
    timers: timers.map((t) => {
      const v = visits.get(t.visit_id);
      // what the visit was (its title and town), never who
      return { timer: techView("timer", t), visit: v ? { date: v.date, job_title: v.job_title || "", town: v.town || "", status: v.status } : null };
    }),
    open: open ? techView("timesheet", open) : null,
    days, totals: { minutes: est.minutes, regular_min: est.regular_min, ot_min: est.ot_min, pending_min: est.pending_min, open_min: est.open_min, near_ot: est.near_ot, over_ot: est.over_ot },
    pending: sheets.filter((s) => s.status === "pending_approval").map((s) => techView("timesheet", s)),
  };
}

export async function myPay(user, weekStart, ctx) {
  if (hasService("payroll.myPay")) return callService("payroll.myPay", { user_id: user.id, period: weekStart }, ctx);
  const ws = weekParam(weekStart);
  const p = await payrollSettings();
  const weeks = [];
  for (let i = 0; i < 5; i++) {
    const w = addLocalDays(ws, -7 * i);
    const est = payEstimate(await sheetsInWeek(user.id, w), user, p);
    weeks.push({ week_start: w, week_end: addLocalDays(w, 6), ...est });
  }
  return {
    period: { start_on: ws, end_on: addLocalDays(ws, 6), weeks: 1 }, estimate: weeks[0], past: weeks.slice(1),
    model: (user.pay && user.pay.model) || "hourly", ot_threshold_hours: p.otThresholdMin / 60, ot_multiplier: p.otMultiplier,
    note: "An estimate from your clocked hours. Your pay sheet comes from payroll.",
  };
}

// ------------------------------------------------------------ the work.clock sweep (§7.6)

export async function clockSweep(ctx = {}) {
  const t = now();
  const today = localDate(t);
  const months = [today.slice(0, 7)];
  if (Number(today.slice(8, 10)) <= 2) months.push(addLocalDays(`${today.slice(0, 7)}-01`, -1).slice(0, 7));
  const rows = (await Promise.all(months.map((m) => readIndex("timesheets", m)))).flatMap((ix) => ix.rows).filter((r) => r.st === "open");
  if (!rows.length) return { done: true, progress: 0 };
  const s = await workSettings();
  const hhmm = localTime(t);
  let progress = 0;
  for (const row of rows) {
    if (ctx.budget && ctx.budget.left() < 4000) return { done: false, progress };
    const started = row.d || localDate(new Date(row.s));
    if (started === today && hhmm < (s.clock_flag_at || "19:00")) continue;
    const g = await getRecord("timesheet", row.id);
    if (!g || !isOpenSheet(g.data)) continue;
    const sheet = g.data;
    if (typeof ctx.mayAct === "function" && !ctx.mayAct(sheet)) {
      await ctx.would(sheet, "close", { status: ["open", "closed"] });
      continue;
    }
    const w = typeof ctx.write === "function" ? ctx.write() : W(ctx);
    const deadline = await shiftDeadline(sheet, s);
    if (t.getTime() >= deadline) {
      await autoCloseSheet(sheet, deadline, w).catch((e) => console.error(`crm:work: a shift not closed (${safeErr(e)})`));
      progress += 1;
      continue;
    }
    // a shift begun after the reminder hour is asked about an hour before its own bound
    const flag = s.clock_flag_at || "19:00";
    const lateStart = localTime(new Date(sheet.start_at)) >= flag;
    const due = lateStart ? t.getTime() >= Date.parse(sheet.start_at) + LATE_SHIFT_MS - 3600000 : started !== today || hhmm >= flag;
    if (!sheet.reminded_at && due) {
      const r = await updateRecord("timesheet", sheet.id, (x) => (x.reminded_at || !isOpenSheet(x) ? null : { ...x, reminded_at: nowIso() }), w).catch(() => ({ changed: false }));
      if (r.changed) {
        await notify([sheet.user_id], { kind: "clock_reminder", title: "Still clocked in?", body: "Clock out when you're done for the day.", link: "/time" }, w).catch(() => {});
        progress += 1;
      }
    }
  }
  return { done: true, progress, result: `${progress} shifts` };
}

// ------------------------------------------------------------ routes (the person's own time and the office's)

export const LAST_ROTOR_PAYROLL = "2026-10-01T01:59:35.907Z";   // the last payroll run in Rotor (rotor-ops §9.1)

const meTimesheets = async (ctx) => ({ data: await myWeek(ctx.user, ctx.query.get("week")) });
const mePay = async (ctx) => {
  const u = await userRecord(ctx.user.id);
  return { data: await myPay(u || ctx.user, ctx.query.get("period") || ctx.query.get("week"), ctx) };
};
// POST /me/timesheets/:id/notes { text, client_id }: a note on one's own shift.
const meNote = async (ctx) => {
  const got = isId(ctx.params.id, "timesheet") ? await getRecord("timesheet", ctx.params.id) : null;
  if (!got || got.data.deleted_at || got.data.user_id !== ctx.user.id) throw new NotFoundError("That shift isn't there.");
  const b = ctx.body || {};
  const text = String(b.text || "").trim();
  if (!text) throw new InputError("Write the note.", "text");
  if (text.length > 500) throw new InputError("Keep a note under 500 characters.", "text");
  const cid = clientIdOf(b);
  const r = await updateRecord("timesheet", got.data.id, (x) => {
    if (cid && (x.notes || []).some((n) => n.id === cid)) return null;
    if ((x.notes || []).length >= 50) throw new ConflictError("That shift has as many notes as it can hold.");
    return { ...x, notes: [...(x.notes || []), { at: nowIso(), by: ctx.user.id, text, ...(cid ? { id: cid } : {}) }] };
  }, W(ctx));
  return { data: { shift: techView("timesheet", r.data) } };
};

const officeList = async (ctx) => {
  const user = ctx.query.get("user");
  if (user && !isId(user, "user")) throw new InputError("That isn't a person.", "user");
  return { data: await officeWeek(ctx.query.get("week"), { userId: user || undefined }) };
};
const officeOne = async (ctx) => {
  const got = isId(ctx.params.id, "timesheet") ? await getRecord("timesheet", ctx.params.id) : null;
  if (!got || got.data.deleted_at) throw new NotFoundError("That time entry isn't there.");
  return { data: { sheet: view(got.data) }, etag: got.etag };
};
const officeEdit = async (ctx) => {
  const r = await editSheet(ctx.params.id, ctx.body || {}, ctx);
  return { data: { sheet: view(r.sheet) }, etag: r.etag };
};
const officeApprove = async (ctx) => ({ data: await approveWeek((ctx.body || {}).user_id, (ctx.body || {}).week_start, ctx) });
const officeDecide = async (ctx) => {
  const r = await decidePending(ctx.params.id, ctx.body || {}, ctx);
  return { data: { sheet: view(r.sheet) }, etag: r.etag };
};

const R = (method, path, perm, subject, handler, extra = {}) => ({ method, path, auth: "session", perm, subject, mode: "inline", handler, ...extra });
export const timesheetRoutes = [
  R("GET", "/me/timesheets", "time:own", "none", meTimesheets, { maxCalls: 120 }),
  R("POST", "/me/timesheets/:id/notes", "time:own", "required", meNote, { replaySafe: true }),
  R("GET", "/me/pay", "payroll:read_own", "none", mePay, { maxCalls: 200 }),
  R("GET", "/timesheets", "time:edit_others", "none", officeList, { maxCalls: 30 }),
  R("GET", "/timesheets/:id", "time:edit_others", "required", officeOne),
  R("PATCH", "/timesheets/:id", "time:edit_others", "required", officeEdit, { maxCalls: 40 }),
  R("POST", "/timesheets/approve", "time:edit_others", "none", officeApprove, { maxCalls: 200 }),
  R("POST", "/timesheets/:id/decide", "time:edit_others", "required", officeDecide, { maxCalls: 60 }),
];

// ------------------------------------------------------------ import phase 26 (§10.2): Rotor timesheets

const ROTOR_ID = /^(?!\.+$)[A-Za-z0-9_.-]{1,64}$/;
const iso = (v) => (v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
const geoIn = (v) => (Array.isArray(v) && v.length === 2 && v.every(Number.isFinite) && Math.abs(v[0]) <= 90 && Math.abs(v[1]) <= 180 ? [v[0], v[1]] : null);

export function normalizeTimesheet(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) throw new RowError("row");
  const id = String(row.id ?? "").trim();
  if (!ROTOR_ID.test(id)) throw new RowError("id");
  const user = String(row.user_id ?? "").trim();
  if (!ROTOR_ID.test(user)) throw new RowError("user_id");
  const start = iso(row.start);
  if (!start) throw new RowError("start");
  const end = row.end === null || row.end === undefined || row.end === "" ? null : iso(row.end);
  if (row.end && !end) throw new RowError("end");
  const category = CATEGORIES.includes(row.category) ? row.category : "service";
  const notes = Array.isArray(row.notes) ? row.notes.map((n) => (typeof n === "string" ? n : n && typeof n.text === "string" ? n.text : "")).map((n) => n.trim().slice(0, 500)).filter(Boolean).slice(0, 20) : [];
  return { id, user_id: user, category, start, end, notes, start_geo: geoIn(row.start_location), end_geo: geoIn(row.end_location) };
}

async function mapTimesheet(r, ctx) {
  const uid = ((ctx && ctx.users) || new Map()).get(r.user_id);
  if (!isId(uid, "user")) return { warnings: ["timesheet_user_unknown"] };
  const id = idForRotor("timesheet", r.id);
  const warnings = [];
  let end = r.end && Date.parse(r.end) >= Date.parse(r.start) ? r.end : null;
  let auto = null;
  if (!end) {
    // a shift Rotor still has open: closed at that day's 21:00 for review
    const day = localDate(new Date(r.start));
    end = new Date(Math.max(zonedToUtc(day, "21:00").getTime(), Date.parse(r.start))).toISOString();
    auto = { at: r.start, reason: "forgotten", imported: true };
    warnings.push("timesheet_auto_closed");
  }
  return {
    records: [{ type: "timesheet", data: {
      id, user_id: uid, category: r.category, start_at: r.start, end_at: end, status: Date.parse(r.start) < Date.parse(LAST_ROTOR_PAYROLL) ? "approved" : "closed",
      notes: r.notes.map((text) => ({ text, by: "import" })), edits: [], ...(auto ? { auto_closed: auto, flags: ["auto_closed"] } : {}),
      ...(r.start_geo ? { start_geo: r.start_geo } : {}), ...(r.end_geo ? { end_geo: r.end_geo } : {}), rotor: { timesheet_id: r.id },
    } }],
    pointers: [{ kind: "rotor/timesheet", key: rotorKey(r.id), value: { id } }],
    warnings,
  };
}

export const timesheetPhase = { name: "work.timesheets", entity: "timesheets", after: ["system.users"], normalize: normalizeTimesheet, map: mapTimesheet };

export { StaleError };
