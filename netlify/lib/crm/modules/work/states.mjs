// The job and visit state machines (design §5.5), including every field
// transition the tech app (M4b) uses, so M4b never edits this file
// (frozen at the start of wave 3, §11.1 rule 9). Pure: no I/O.
//
// A table is { [state]: { [event]: nextState } }. transition() answers
// the next state or throws InputError("transition") for any pair the table
// does not hold (§12.2: every pair not in a table must throw).
//
// Visit events and who sends them:
//   office (M4a)  reschedule, assign, cancel, no_access (the office's "mark
//                 no access"), office_complete (the office closes a visit a
//                 tech forgot to finish; checklist not enforced), reopen
//   field (M4b)   on_my_way, running_late, start (timer start), pause,
//                 finish (required checklist items done: checklistMissing),
//                 no_access, cancel is office-only
//
// Job events are not sent by people directly (except cancel and reopen):
// the job's status follows its visits (jobStatusFromVisits), and jobPath()
// finds the events that lead there through JOB_STATES, so the table stays
// the single authority:
//   unscheduled → scheduled          the first visit is booked (schedule)
//   scheduled → in_progress          a visit is under way (start)
//   scheduled|in_progress → completed  the last live visit completed (complete)
//   in_progress → scheduled          no visit under way any more, some still to do (stop)
//   scheduled → unscheduled          every visit cancelled or no access (unschedule)
//   completed → scheduled            reopen (owner/admin; a visit reopened or added)
//   unscheduled|scheduled|in_progress → cancelled   cancel (reason)
// `stop` and `unschedule` are not in the design's table; they make the
// derivation total (a job whose only visit is cancelled goes back to the
// tray instead of staying "scheduled" with nothing booked).

import { InputError } from "../../core/errors.mjs";

export const JOB_STATUSES = Object.freeze(["unscheduled", "scheduled", "in_progress", "completed", "cancelled"]);
export const OPEN_JOB = Object.freeze(["unscheduled", "scheduled", "in_progress"]);
export const CLOSED_JOB = Object.freeze(["completed", "cancelled"]);

export const VISIT_STATUSES = Object.freeze(["scheduled", "en_route", "in_progress", "paused", "completed", "no_access", "cancelled"]);
// a visit that counts toward its job (cancelled and no-access visits didn't happen)
export const LIVE_VISIT = Object.freeze(["scheduled", "en_route", "in_progress", "paused", "completed"]);
// still to do or under way
export const OPEN_VISIT = Object.freeze(["scheduled", "en_route", "in_progress", "paused"]);
// under way: the job is in progress
export const ACTIVE_VISIT = Object.freeze(["en_route", "in_progress", "paused"]);

export const JOB_STATES = Object.freeze({
  unscheduled: Object.freeze({ schedule: "scheduled", cancel: "cancelled" }),
  scheduled: Object.freeze({ start: "in_progress", complete: "completed", cancel: "cancelled", unschedule: "unscheduled" }),
  in_progress: Object.freeze({ complete: "completed", cancel: "cancelled", stop: "scheduled" }),
  completed: Object.freeze({ reopen: "scheduled" }),
  cancelled: Object.freeze({}),
});

export const VISIT_STATES = Object.freeze({
  scheduled: Object.freeze({
    reschedule: "scheduled", assign: "scheduled", on_my_way: "en_route", running_late: "scheduled", start: "in_progress",
    no_access: "no_access", cancel: "cancelled", office_complete: "completed",
  }),
  en_route: Object.freeze({
    assign: "en_route", on_my_way: "en_route", running_late: "en_route", start: "in_progress",
    no_access: "no_access", cancel: "cancelled", office_complete: "completed",
  }),
  in_progress: Object.freeze({ assign: "in_progress", pause: "paused", finish: "completed", cancel: "cancelled", office_complete: "completed" }),
  paused: Object.freeze({ assign: "paused", start: "in_progress", finish: "completed", cancel: "cancelled", office_complete: "completed" }),
  completed: Object.freeze({ reopen: "in_progress" }),
  no_access: Object.freeze({ cancel: "cancelled" }),
  cancelled: Object.freeze({ cancel: "cancelled" }),
});

export const JOB_EVENTS = Object.freeze([...new Set(Object.values(JOB_STATES).flatMap((t) => Object.keys(t)))].sort());
export const VISIT_EVENTS = Object.freeze([...new Set(Object.values(VISIT_STATES).flatMap((t) => Object.keys(t)))].sort());
// Events the tech app sends for an assignee (M4b); the rest are the office's.
export const FIELD_EVENTS = Object.freeze(["on_my_way", "running_late", "start", "pause", "finish", "no_access"]);
export const OFFICE_EVENTS = Object.freeze(["reschedule", "assign", "cancel", "no_access", "office_complete", "reopen"]);

// table: { [state]: { [event]: nextState } } → the next state, or InputError("transition").
export function transition(table, state, event) {
  const next = table && Object.hasOwn(table, state) && Object.hasOwn(table[state], event) ? table[state][event] : null;
  if (!next) throw new InputError("That step isn't possible from here.", "transition");
  return next;
}
export const canTransition = (table, state, event) => !!(table && Object.hasOwn(table, state) && Object.hasOwn(table[state], event));
export const jobNext = (state, event) => transition(JOB_STATES, state, event);
export const visitNext = (state, event) => transition(VISIT_STATES, state, event);

// The events that take a job from one status to another (shortest path
// through JOB_STATES; [] when already there). Throws InputError("transition")
// when the table has no way.
export function jobPath(from, to) {
  if (from === to) return [];
  const seen = new Set([from]);
  let frontier = [{ s: from, path: [] }];
  for (let depth = 0; depth < 4 && frontier.length; depth++) {
    const next = [];
    for (const { s, path } of frontier) {
      for (const [ev, t] of Object.entries(JOB_STATES[s] || {})) {
        if (t === to) return [...path, ev];
        if (!seen.has(t)) { seen.add(t); next.push({ s: t, path: [...path, ev] }); }
      }
    }
    frontier = next;
  }
  throw new InputError("That step isn't possible from here.", "transition");
}

const live = (visits) => (visits || []).filter((v) => v && !v.deleted_at && LIVE_VISIT.includes(v.status));

// The status a job's visits imply (the job rule, §5.5). A cancelled job
// stays cancelled (cancel is explicit).
export function jobStatusFromVisits(job, visits) {
  if (job && job.status === "cancelled") return "cancelled";
  const l = live(visits);
  if (l.some((v) => ACTIVE_VISIT.includes(v.status))) return "in_progress";
  if (l.length && l.every((v) => v.status === "completed")) return "completed";
  if (l.length) return "scheduled";
  return "unscheduled";
}

// What the job keeps about its visits (derived, never a rotorField):
// first and last visit dates, the earliest one still to do, counts.
export function jobSchedule(visits) {
  const l = live(visits);
  const dates = l.map((v) => v.date).filter(Boolean).sort();
  const open = l.filter((v) => OPEN_VISIT.includes(v.status)).map((v) => v.date).filter(Boolean).sort();
  return { first_on: dates[0] || null, last_on: dates[dates.length - 1] || null, open_on: open[0] || null, visits: l.length, done: l.filter((v) => v.status === "completed").length };
}

// The people on a job: everyone on its live visits (scope: a tech's job is
// one with a visit of theirs, perms.scopeFor).
export function jobAssignees(visits) {
  return [...new Set(live(visits).flatMap((v) => (Array.isArray(v.assignee_ids) ? v.assignee_ids : [])))];
}

// Required checklist items not done yet: they gate "finish" (B13).
export function checklistMissing(visit) {
  const items = (visit && visit.checklist && Array.isArray(visit.checklist.items)) ? visit.checklist.items : [];
  return items.filter((i) => i && i.required && !i.done_at).map((i) => i.label || i.key);
}

// A visit is past its reopen window (cfg/work.reopen_days, default 7).
export function canReopen(visit, now, days = 7) {
  if (!visit || visit.status !== "completed") return false;
  const at = Date.parse((visit.completion && visit.completion.at) || visit.updated_at || 0);
  return Number.isFinite(at) && now.getTime() - at <= days * 86400000;
}
