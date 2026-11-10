// Sales module: when a cadence step is due, and what logging a step does
// to an enrollment (design §5.2 "How a step runs", §7.4). Pure functions:
// no store, no clock of their own (callers pass `now`), so the timing rules
// are tested table-first with a pinned clock.
//
// Timing:
//   - Day 1 is the day the contact entered, or the next open day when they
//     entered after the day's cut-off (cfg/sales.day_cutoff, 17:00, when the
//     last window ends) or on a day the business is closed. Open days come
//     from cfg/hours (Sunday closed) and cfg/calendar (Thanksgiving,
//     Christmas, the owner's dates); day N is N-1 open days after day 1.
//   - A step is due at the start of its window on its day. When that window
//     is already over, or the step was pushed to a later day, it takes the
//     next of the cadence's windows (9-10, 12-1, 4-5) that hasn't ended.
//   - Re-planning (after any logged step): the next step never lands in the
//     window the last one was logged in (no second call to a lead minutes
//     after the first), and it keeps its day gap from the day the last one
//     really happened (a late day-1 call pushes day 2's steps a day). So the
//     list does not fill with red rows after one late call.
//   - Overdue = past its window's end; "needs attention" = a whole window
//     more has gone by since.
//
// Steps have ids (s1, s2, ... assigned when a cadence is saved, never
// reused). An enrollment remembers its current step's id (step_id), so an
// owner inserting, removing or reordering steps never moves a lead onto
// another step's text: it carries on from its own step in the new order. A
// lead whose step was removed goes to the next step that survived (the
// cadence's `moved` map), or completes when none did. step_n is the step's
// position when it was planned (what the screens show and send back).

import { localDate, localTime, addLocalDays, zonedToUtc, dowOfDate, isHoliday, DEFAULT_HOURS, DEFAULT_CALENDAR } from "../../core/clock.mjs";
import { TEXT_ACTIONS, MAX_HISTORY, OPEN_ENROLLMENT } from "./types.mjs";

export const DEFAULT_CUTOFF = "17:00";
const toDate = (d) => (d instanceof Date ? d : new Date(d));
const toMs = (d) => toDate(d).getTime();

// ------------------------------------------------------------ the calendar

const spanOf = (hours, dow) => {
  const h = hours || DEFAULT_HOURS;
  const s = Object.hasOwn(h, String(dow)) ? h[String(dow)] : h[dow];
  return Array.isArray(s) && s.length === 2 ? s : null;
};

// The business is open that local date (cfg/hours, not a holiday).
export function isOpenDay(date, { hours = DEFAULT_HOURS, calendar = DEFAULT_CALENDAR } = {}) {
  return !!spanOf(hours, dowOfDate(date)) && !isHoliday(date, calendar);
}

// The date itself when it is open, else the next open one (≤ 21 days on).
export function openOnOrAfter(date, env = {}) {
  let d = date;
  for (let i = 0; i < 21; i++, d = addLocalDays(d, 1)) if (isOpenDay(d, env)) return d;
  return date;
}

// n open days after an open date (n = 0: the date, moved to an open day).
export function addOpenDays(date, n, env = {}) {
  let d = openOnOrAfter(date, env);
  for (let i = 0; i < Math.max(0, n); i++) d = openOnOrAfter(addLocalDays(d, 1), env);
  return d;
}

// Day 1 of an enrollment that started at `at`.
export function dayOne(at, env = {}) {
  const d = localDate(at);
  const cutoff = env.cutoff || DEFAULT_CUTOFF;
  if (isOpenDay(d, env) && localTime(at) < cutoff) return d;
  return openOnOrAfter(addLocalDays(d, 1), env);
}

// ------------------------------------------------------------ windows

// The cadence's windows, earliest first, one per start time.
export function windowsOf(cadence) {
  const seen = new Map();
  for (const s of (cadence && cadence.steps) || []) if (s.window && !seen.has(s.window.start)) seen.set(s.window.start, s.window);
  return [...seen.values()].sort((a, b) => (a.start < b.start ? -1 : 1));
}

export function slotOf(date, win) {
  return { date, window: { start: win.start, end: win.end }, start: zonedToUtc(date, win.start), end: zonedToUtc(date, win.end) };
}

// The cadence window an instant falls in (on an open day), or null.
export function slotContaining(at, windows, env = {}) {
  const t = toDate(at);
  const d = localDate(t);
  if (!isOpenDay(d, env)) return null;
  for (const w of windows) {
    const s = slotOf(d, w);
    if (t >= s.start && t < s.end) return s;
  }
  return null;
}

// The first window (from `fromDate` on, open days only) that hasn't ended at `after`.
export function nextSlot(fromDate, after, windows, env = {}) {
  if (!windows.length) return null;
  let d = openOnOrAfter(fromDate, env);
  for (let i = 0; i < 30; i++) {
    for (const w of windows) {
      const s = slotOf(d, w);
      if (s.end > after) return s;
    }
    d = openOnOrAfter(addLocalDays(d, 1), env);
  }
  return null;
}

export const stepOf = (cadence, n) => ((cadence && cadence.steps) || [])[n - 1] || null;

// ------------------------------------------------------------ step ids

const stepsOf = (cadence) => (cadence && Array.isArray(cadence.steps) ? cadence.steps : []);
// A step's id (a cadence saved before ids: s1, s2, ... by position).
export const stepIdAt = (cadence, i) => { const st = stepsOf(cadence)[i]; return st ? (st.id || `s${i + 1}`) : null; };
export const indexOfStepId = (cadence, sid) => stepsOf(cadence).findIndex((st, i) => (st.id || `s${i + 1}`) === sid);

// Where an enrollment stands in its cadence as it is now: { index, step,
// moved } (index -1: no step left). Its own step by id; a removed step's
// next survivor; an enrollment from before ids by its position.
export function resolveStep(cadence, e) {
  const steps = stepsOf(cadence);
  if (e && e.step_id) {
    const moves = (cadence && cadence.moved) || {};
    let sid = e.step_id;
    for (let hop = 0; hop < 40; hop++) {
      const i = indexOfStepId(cadence, sid);
      if (i >= 0) return { index: i, step: steps[i], moved: sid !== e.step_id };
      if (!Object.hasOwn(moves, sid) || !moves[sid]) break;
      sid = moves[sid];
    }
    return { index: -1, step: null, moved: true };
  }
  const i = Math.max(1, Number(e && e.step_n) || 1) - 1;
  return i < steps.length ? { index: i, step: steps[i], moved: false } : { index: -1, step: null, moved: false };
}
export const stepFor = (cadence, e) => resolveStep(cadence, e).step;
// The position (1-based) of the step after the enrollment's current one.
const afterCurrent = (cadence, e) => { const r = resolveStep(cadence, e); return r.index < 0 ? stepsOf(cadence).length + 1 : r.index + 2; };

// When step n is due. prev = { at, day } of the step logged before it (none
// for the first step or after a resume). → { due_at, due_end, date, window } (ISO).
export function planStep(cadence, n, { day1, prev, now, ...env } = {}) {
  const step = stepOf(cadence, n);
  if (!step) return null;
  const t = toDate(now);
  const idealDate = addOpenDays(day1, step.day - 1, env);
  let minDate = idealDate;
  let after = t;
  if (prev && prev.at) {
    const pd = openOnOrAfter(localDate(prev.at), env);
    const gapDate = addOpenDays(pd, Math.max(0, step.day - (prev.day || step.day)), env);
    if (gapDate > minDate) minDate = gapDate;
    const inSlot = slotContaining(prev.at, windowsOf(cadence), env);
    const notBefore = inSlot ? inSlot.end : toDate(prev.at);
    if (notBefore > after) after = notBefore;
  }
  if (!step.window) {
    // a task or an archive step: due once its day comes (start of the day's first window, or now)
    const first = windowsOf(cadence)[0];
    const at = first ? slotOf(minDate, first).start : zonedToUtc(minDate, "09:00");
    const due = at > after ? at : after;
    return { due_at: due.toISOString(), due_end: null, date: localDate(due), window: null };
  }
  // on its day, a step keeps its own window while that hasn't ended; a step
  // pushed to a later day (a late one before it) takes the next open window
  const ideal = minDate === idealDate ? slotOf(minDate, step.window) : null;
  // the search starts at the later of the step's day and today (a lead
  // resumed weeks after its day gets the next window from now)
  const today = localDate(after);
  const s = ideal && ideal.end > after ? ideal : nextSlot(minDate > today ? minDate : today, after, windowsOf(cadence), env);
  if (!s) return null;
  return { due_at: s.start.toISOString(), due_end: s.end.toISOString(), date: s.date, window: s.window };
}

// What the call list and the index know about the current step.
export function stepInfo(step) {
  if (!step) return null;
  return {
    label: step.label || "", action: step.action, rbs: !!step.review_before_send, window: step.window || null,
    template_key: step.template_key || null, ...(step.offer ? { offer: step.offer } : {}), ...(step.archive_quote ? { archive_quote: true } : {}),
    ...(step.task_title ? { task_title: step.task_title } : {}),
  };
}

// ------------------------------------------------------------ due, overdue, attention

export const isDue = (row, now) => !!row.due && toMs(row.due) <= toMs(now);
export const isOverdue = (row, now) => !!row.de && toMs(row.de) <= toMs(now);

// How many whole cadence windows have ended between a step's window end and now.
export function windowsMissed(dueEnd, now, windows, env = {}) {
  if (!dueEnd) return 0;
  const end = toDate(dueEnd);
  const t = toDate(now);
  if (t <= end || !windows.length) return 0;
  let n = 0;
  let after = end;
  for (let i = 0; i < 20; i++) {
    const s = nextSlot(localDate(after), after, windows, env);
    if (!s || s.end > t) break;
    n += 1;
    after = s.end;
  }
  return n;
}

// ------------------------------------------------------------ entry rules

// Whether an automatic entry (a new lead) may enroll this contact: its
// source is on the cadence's list (when it has one) and it carries none of
// the excluded tags. A person enrolling someone by hand skips these.
export function entryMatches(cadence, contact) {
  const e = (cadence && cadence.entry) || {};
  const src = contact && contact.source && contact.source.source;
  if (Array.isArray(e.sources) && e.sources.length && !e.sources.includes(src || "Other")) return { ok: false, reason: "source" };
  const tags = ((contact && contact.tags) || []).map((t) => String(t).toLowerCase());
  if ((e.exclude_tags || []).some((t) => tags.includes(String(t).toLowerCase()))) return { ok: false, reason: "tag" };
  return { ok: true };
}

export const exitsOn = (cadence, what) => ((cadence && cadence.exit_on) || []).includes(what);

// ------------------------------------------------------------ the enrollment, pure

export const isOpen = (e) => !!e && OPEN_ENROLLMENT.includes(e.status);

const pushHistory = (e, entry) => [...(e.history || []), entry].slice(-MAX_HISTORY);

// The enrollment with step n planned as its current step (or completed
// when there is no step n). prev: the step logged just before.
export function withStep(e, cadence, n, env) {
  const next = { ...e, step_n: n };
  delete next.pending;
  // an enrollment without a day 1 (imported from Rotor): day 1 is now
  if (!next.day1) next.day1 = dayOne(env.now, env);
  if (cadence && cadence.steps_v) next.steps_v = cadence.steps_v;
  const step = stepOf(cadence, n);
  if (!step) {
    next.status = "completed";
    next.ended_at = new Date(toDate(env.now)).toISOString();
    delete next.next_due_at; delete next.due_end; delete next.cur; delete next.step_id;
    return next;
  }
  next.step_id = stepIdAt(cadence, n - 1);
  const plan = planStep(cadence, n, { ...env, day1: next.day1 });
  next.cur = stepInfo(step);
  if (plan) { next.next_due_at = plan.due_at; if (plan.due_end) next.due_end = plan.due_end; else delete next.due_end; }
  else { delete next.next_due_at; delete next.due_end; }
  return next;
}

// A fresh enrollment's step 1. → the fields to store.
export function firstStep(cadence, { started_at, ...env }) {
  const day1 = dayOne(started_at, env);
  return withStep({ day1, step_n: 1, history: [], status: "active", started_at }, cadence, 1, { ...env, now: env.now || started_at });
}

// Logs step n done (entry: { action, outcome?, ... }) and plans step n+1.
// Idempotent: a repeat of the same client id, or a step that already moved
// on, changes nothing (null).
export function logStep(e, cadence, n, entry, env) {
  if (!isOpen(e) || e.step_n !== n) return null;
  if (entry.cid && (e.history || []).some((h) => h.cid === entry.cid && h.action === entry.action)) return null;
  const at = new Date(toDate(env.now)).toISOString();
  const r = resolveStep(cadence, e);
  const sid = r.index >= 0 ? stepIdAt(cadence, r.index) : e.step_id;
  const withEntry = { ...e, history: pushHistory(e, { n, ...(sid ? { sid } : {}), at, ...entry }), last_touch_at: entry.touch === false ? e.last_touch_at : at };
  if (!withEntry.last_touch_at) delete withEntry.last_touch_at;
  delete withEntry.history[withEntry.history.length - 1].touch;
  if (e.status === "paused") return { ...withEntry, step_n: n };
  return withStep(withEntry, cadence, afterCurrent(cadence, e), { ...env, prev: { at, day: r.step ? r.step.day : null } });
}

// Records something on the current step without moving on (a call whose text
// still waits for a person, a paused enrollment's call).
export function noteStep(e, n, entry, env, extra = {}) {
  if (!e || (entry.cid && (e.history || []).some((h) => h.cid === entry.cid && h.action === entry.action))) return null;
  const at = new Date(toDate(env.now)).toISOString();
  const touch = entry.touch !== false;
  const h = { n, ...(e.step_id ? { sid: e.step_id } : {}), at, ...entry };
  delete h.touch;
  return { ...e, history: pushHistory(e, h), ...(touch ? { last_touch_at: at } : {}), ...extra };
}

// Status changes. reason: a stop reason, or a pause reason.
export function setStatus(e, status, { reason, now } = {}) {
  if (!e) return null;
  const at = new Date(toDate(now)).toISOString();
  if (status === "paused") {
    if (e.status !== "active") return null;
    return { ...e, status: "paused", paused_at: at, paused_reason: reason || "manual" };
  }
  if (status === "active") {
    if (e.status !== "paused") return null;
    const next = { ...e, status: "active" };
    delete next.paused_at; delete next.paused_reason;
    return next;
  }
  if (!isOpen(e)) return null;
  const next = { ...e, status, ended_at: at, ...(reason ? { stop_reason: reason } : {}) };
  delete next.pending; delete next.next_due_at; delete next.due_end;
  return next;
}

// Resume: active again, the current step re-planned from now.
export function resume(e, cadence, env) {
  const r = setStatus(e, "active", env);
  if (!r) return null;
  const at = resolveStep(cadence, r);
  return withStep(r, cadence, at.index < 0 ? stepsOf(cadence).length + 1 : at.index + 1, { ...env, prev: null });
}

// After the cadence's steps changed (Settings → Cadences): the enrollment
// keeps its own step (its position, label and text brought up to date, its
// time as planned); a removed step moves it to the next surviving one,
// planned from now, or completes it. An enrollment from before step ids
// gets its step's id. → the enrollment, or null when nothing changes.
export function refreshStep(e, cadence, env) {
  if (!isOpen(e) || !cadence) return null;
  const r = resolveStep(cadence, e);
  if (r.index < 0) return withStep(e, cadence, stepsOf(cadence).length + 1, env);
  if (r.moved) return withStep(e, cadence, r.index + 1, { ...env, prev: null });
  const n = r.index + 1;
  const next = { ...e, step_n: n, step_id: stepIdAt(cadence, r.index), cur: stepInfo(r.step), ...(cadence.steps_v ? { steps_v: cadence.steps_v } : {}) };
  if (next.pending && next.pending.n === e.step_n) next.pending = { ...next.pending, n };
  if (!next.day1) next.day1 = dayOne(env.now, env);
  return JSON.stringify(next) === JSON.stringify(e) ? null : next;
}

// The text a step sends is a step's job when its action texts.
export const textsOn = (step) => !!step && (TEXT_ACTIONS.includes(step.action) || step.action === "email");

// "sms:+17635550100?&body=..." (the pattern the giveaway admin already uses;
// iOS and Android both read it).
export const smsHref = (e164, body) => `sms:${String(e164 || "").replace(/[^\d+]/g, "")}?&body=${encodeURIComponent(String(body || ""))}`;
