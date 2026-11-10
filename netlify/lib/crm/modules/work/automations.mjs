// Work module, office part: its automations, sweeps and built-in templates
// (design §5.7.4 visit.*, §7.6).
//
//   visit.confirm       a visit is booked or moved (events visit.scheduled and
//                       visit.rescheduled): text visit_confirm (+ email when
//                       there's an address), after a short settle delay (10
//                       minutes, a setting) so a booking corrected right away
//                       sends one confirmation with the final time. Never for
//                       an imported visit, a visit moved by a rain-day move
//                       (its notice is the bulk run), or one within 2 days
//                       (the 2-day reminder covers it). The marker is per
//                       visit, date and start, so a later move confirms again.
//   visit.reminder_14d  10:00, visits 14 days out (catch-up: 7-14 days, never
//                       sent for that date, own or seeded marker; skipped when
//                       the visit was booked less than 14 days out): text +
//                       email
//   visit.reminder_2d   10:00, visits 2 days out (catch-up: 1-2 days): text;
//                       one per visit, day and start time (a time change
//                       inside the 2 days is reminded again)
//   Imported future visits are eligible for both reminders (§5.7.4); before
//   cutover every send to a contact Rotor owns is dry-run (outbox only).
//   At send time each step re-reads the visit: moved, cancelled or changed
//   since it was queued → skipped (the move queued its own).
//
//   work.stale  hourly: the stale flags of open jobs ("scheduled_past": every
//               visit is behind today and it's still scheduled;
//               "in_progress_stuck": in progress for more than
//               cfg/work.stale_in_progress_days), as a derived part of the
//               jobs/open index rows, never the record (§3.5, B12)
//   work.stats  bulk lane, daily 02:15: contacts whose next visit date went
//               by get their work stats worked out again (before contacts.stats)
//   work.sync, work.summaries   office-sync.mjs (jobs in step with their
//               visits after a crash; visits' copies after edits)

import { getRecord, readIndex, getRaw, applyIndexRow, getSetting } from "../../../crm-store.mjs";
import { now, nowIso, nowMs, localDate, addLocalDays, DEFAULT_HOURS } from "../../core/clock.mjs";
import { isId } from "../../core/ids.mjs";
import { runAutomation } from "../../core/automations.mjs";
import { contactShard } from "../../core/stats.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { visitVars, visitRows } from "./office-schedule.mjs";
import { recomputeWorkStats, workSettings } from "./office.mjs";

const DAY = 86400000;
export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DAY);
const imported = (v) => !!v && (v.created_by === "import" || !!v.import);
const windowKey = (v) => `${(v.window && v.window.type) || "window"}:${(v.window && v.window.minutes) || 0}`;
const hhmmKey = (t) => String(t || "").replace(":", "");

async function hoursSetting() {
  return getSetting("hours").catch(() => ({ ...DEFAULT_HOURS }));
}

// ------------------------------------------------------------ templates (Barta's voice; the sender adds the opt-out footer)

export const TEMPLATES = [
  { key: "visit_confirm", name: "Visit booked", channel: "sms", category: "service",
    body: "Hi {{first_name|there}}, you're booked with {{company_name}} for {{service_list}} on {{visit_date}}, {{arrival_window}}. Reply here if anything needs to change." },
  { key: "visit_confirm_email", name: "Visit booked (email)", channel: "email", category: "service", subject: "You're booked: {{visit_date}}",
    body: "Hi {{first_name|there}},\n\nYou're booked with {{company_name}} for {{service_list}} on {{visit_date}}, {{arrival_window}}.\n\nIf anything needs to change, reply to this email or call us at {{company_phone}}.\n\nThanks!\nThe Barta team" },
  { key: "visit_reminder_14d", name: "Reminder 14 days before", channel: "sms", category: "service",
    body: "REMINDER: Hi {{first_name|there}}, {{company_name}} is scheduled to visit on {{visit_date}}, {{arrival_window}}. Reply if you have any questions!" },
  { key: "visit_reminder_14d_email", name: "Reminder 14 days before (email)", channel: "email", category: "service", subject: "Reminder: your visit from {{company_name}} on {{visit_date}}",
    body: "Hi {{first_name|there}},\n\nThis is a reminder that {{company_name}} is scheduled to visit on {{visit_date}}, {{arrival_window}}.\n\nReply if you have any questions, or call us at {{company_phone}}.\n\nThe Barta team" },
  { key: "visit_reminder_2d", name: "Reminder 2 days before", channel: "sms", category: "service",
    body: "REMINDER: Hi {{first_name|there}}, {{company_name}} is scheduled to visit on {{visit_date}}, {{arrival_window}}. Reply if you have any questions!" },
  { key: "visit_weather_move", name: "Visit moved for weather", channel: "sms", category: "service",
    body: "Hi {{first_name|there}}, the weather isn't cooperating, so we moved your {{service_list}} with {{company_name}} to {{visit_date}}, {{arrival_window}}. Reply here if that day doesn't work and we'll find another one." },
];

// ------------------------------------------------------------ the sends

async function liveVisit(id) {
  if (!isId(id, "visit")) return null;
  const got = await getRecord("visit", id);
  return got && !got.data.deleted_at ? got.data : null;
}

function step(v, hours, extra = {}) {
  return {
    contact_id: v.contact_id, subject: { type: "visit", id: v.id }, vars: visitVars(v, hours), related: { visit_id: v.id },
    expect: { visit_date: v.date, visit_start: v.start, visit_window: windowKey(v) }, record: v, future: Date.parse(v.start_utc) > nowMs(), ...extra,
  };
}

// visit.confirm: from visit.scheduled (queued by the event) and
// visit.rescheduled (the module's own listener runs it).
async function confirmRun(input, actx) {
  const p = (input.event && input.event.payload) || {};
  const v = await liveVisit(p.visit_id);
  if (!v) return { result: "skipped:no_visit" };
  if (v.status !== "scheduled") { await actx.log(v.id, "skipped:not_scheduled"); return { result: "skipped:not_scheduled" }; }
  if (v.moved_by_op || p.moved_by_op) { await actx.log(v.id, "skipped:moved_by_op"); return { result: "skipped:moved_by_op" }; }
  if (v.date !== p.date || v.start !== p.start) return { result: "skipped:changed" };    // a newer move queued its own
  const s = await workSettings();
  const out = daysBetween(localDate(now()), v.date);
  if (out < 0) return { result: "skipped:past" };
  if (out <= (s.confirm_skip_within_days ?? 2)) { await actx.log(v.id, "skipped:soon"); return { result: "skipped:soon" }; }
  const hours = await hoursSetting();
  const r = await actx.send(step(v, hours, { key: `${v.id}--${v.date}-${hhmmKey(v.start)}`, fact_at: p.at || nowIso() }));
  return { result: r.queued ? "queued" : `skipped:${r.reason || "done"}` };
}

// The reminders, run by their sweeps per visit: input { id, today }.
const reminderRun = (key, lo, hi) => async (input, actx) => {
  const v = await liveVisit(input.id);
  if (!v || v.status !== "scheduled") return { result: "skipped:not_scheduled" };
  const today = input.today || localDate(now());
  const out = daysBetween(today, v.date);
  if (out < lo || out > hi) return { result: "skipped:not_due" };
  // a visit booked less than 14 days out got its confirmation instead (imported ones count from their date only)
  if (key === "visit.reminder_14d" && !imported(v) && v.created_at && localDate(new Date(v.created_at)) > addLocalDays(v.date, -14)) {
    await actx.log(v.id, "skipped:booked_late");
    return { result: "skipped:booked_late" };
  }
  // a marker the cutover seeded from Rotor's own reminder (live namespace) means it went out already
  const seeded = await getRaw(`done/${key}/${v.id}--${v.date}`).catch(() => null);
  if (seeded && seeded.data && ["done", "unknown"].includes(seeded.data.state)) { await actx.log(v.id, "skipped:seeded"); return { result: "skipped:seeded" }; }
  const hours = await hoursSetting();
  // the 2-day reminder is per visit, day and time: moved to another time after
  // its reminder was queued (and skipped as changed), it is reminded again at
  // the new time (its confirmation is skipped that close to the day)
  const mk = key === "visit.reminder_2d" ? `${v.id}--${v.date}-${hhmmKey(v.start)}` : `${v.id}--${v.date}`;
  const r = await actx.send(step(v, hours, { key: mk, fact_at: nowIso(), due_at: nowIso() }));
  return { result: r.queued ? "queued" : `skipped:${r.reason || "done"}` };
};

// Re-checked when a queued step is due: the visit must still be booked for
// the same day, time and window.
const recheck = ({ confirm = false } = {}) => async (item) => {
  const v = await liveVisit(item.subject && item.subject.id);
  if (!v || v.status !== "scheduled") return { skip: "changed" };
  const e = item.expect || {};
  if ((e.visit_date && e.visit_date !== v.date) || (e.visit_start && e.visit_start !== v.start) || (e.visit_window && e.visit_window !== windowKey(v))) return { skip: "changed" };
  if (confirm && v.moved_by_op) return { skip: "moved_by_op" };
  return {};
};

export const automations = [
  { key: "visit.confirm", label: "Confirm a booked visit", trigger: "event:visit.scheduled", category: "service", imported: "no", mutates: false,
    defaults: { enabled: true, channels: ["sms", "email"], template_keys: ["visit_confirm", "visit_confirm_email"], delay: 10 }, run: confirmRun, recheck: recheck({ confirm: true }) },
  { key: "visit.reminder_14d", label: "Reminder 14 days before", trigger: "sweep", category: "service", imported: "eligible", mutates: false,
    defaults: { enabled: true, channels: ["sms", "email"], template_keys: ["visit_reminder_14d", "visit_reminder_14d_email"], at_local: "10:00" }, run: reminderRun("visit.reminder_14d", 7, 14), recheck: recheck() },
  { key: "visit.reminder_2d", label: "Reminder 2 days before", trigger: "sweep", category: "service", imported: "eligible", mutates: false,
    defaults: { enabled: true, channels: ["sms"], template_keys: ["visit_reminder_2d"], at_local: "10:00" }, run: reminderRun("visit.reminder_2d", 1, 2), recheck: recheck() },
];

// The confirmation for a moved visit (the listener of visit.rescheduled calls this).
export function confirmMoved(event, h) {
  return runAutomation("visit.confirm", { event }, { mode: h.mode, requestId: h.ctx && h.ctx.requestId });
}

// ------------------------------------------------------------ the sweeps

const reminderSweep = (key, lo, hi) => async (ctx) => {
  const today = localDate(now());
  const { rows } = await visitRows(addLocalDays(today, lo), addLocalDays(today, hi));
  const list = rows.filter((r) => r.st === "scheduled").sort((a, b) => (a.id < b.id ? -1 : 1));
  let progress = 0;
  for (const r of list) {
    if (ctx.cursor && r.id <= ctx.cursor) continue;
    if (ctx.budget && ctx.budget.left() < 6000) return { done: false, cursor: r.id, progress };
    try {
      const out = await runAutomation(key, { id: r.id, today }, { mode: ctx.mode, requestId: ctx.requestId, deploy: ctx.deploy });
      if (out && out.result === "queued") progress += 1;
    } catch (e) {
      console.error(`crm:work: a reminder could not be queued (${safeErr(e)})`);
    }
  }
  return { done: true, progress, result: `${progress} queued` };
};

// The stale flag of a jobs/open row (pure).
export function staleOf(row, today, t = nowMs(), days = 2) {
  if (!row) return null;
  if (row.st === "scheduled" && row.lv && row.lv < today) return "scheduled_past";
  if (row.st === "in_progress" && row.sa && t - Date.parse(row.sa) > days * DAY) return "in_progress_stuck";
  return null;
}

export async function staleSweep(ctx = {}) {
  const [ix, raw, s] = await Promise.all([readIndex("jobs", "open"), getRaw("ix/jobs/open"), workSettings()]);
  const today = localDate(now());
  const t = nowMs();
  const rows = (raw && raw.data && raw.data.rows) || {};
  // the part's write counter: the time, and always above what's there (a pinned or skewed clock)
  const wvFor = (id) => Math.max(t, ((rows[id] && rows[id].stale && rows[id].stale.wv) || 0) + 1);
  let changed = 0;
  const live = new Set();
  for (const row of ix.rows) {
    live.add(row.id);
    const want = staleOf(row, today, t, s.stale_in_progress_days);
    if ((row.stale || null) === want) continue;
    if (ctx.budget && ctx.budget.left() < 4000) return { done: false, progress: changed };
    await applyIndexRow("jobs", "open", row.id, "stale", want ? { stale: want } : null, wvFor(row.id));
    changed += 1;
  }
  // a job that left "open" keeps no stale part behind
  for (const [id, parts] of Object.entries(rows)) {
    if (live.has(id) || !(parts && parts.stale && parts.stale.d)) continue;
    await applyIndexRow("jobs", "open", id, "stale", null, wvFor(id));
    changed += 1;
  }
  return { done: true, progress: changed, result: `${changed} flags changed` };
}

export async function statsSweep(ctx = {}) {
  const ix = await readIndex("contacts", contactShard("ct_00000000000000000000"));
  const today = localDate(now());
  const rows = ix.rows.filter((r) => r.nv && r.nv < today && r.id > (ctx.cursor || "")).sort((a, b) => (a.id < b.id ? -1 : 1));
  let n = 0;
  for (const r of rows) {
    if (ctx.budget && ctx.budget.left() < 10000) return { done: false, cursor: r.id, progress: n };
    await recomputeWorkStats(r.id, typeof ctx.write === "function" ? ctx.write() : ctx).catch((e) => console.error(`crm:work: stats not recomputed (${safeErr(e)})`));
    n += 1;
  }
  return { done: true, progress: n };
}

export const sweeps = [
  { key: "visit.reminder_14d", label: "Visit reminders, 14 days", lane: "fast", every: "daily", at_local: "10:00", mutates: false, run: reminderSweep("visit.reminder_14d", 7, 14) },
  { key: "visit.reminder_2d", label: "Visit reminders, 2 days", lane: "fast", every: "daily", at_local: "10:00", mutates: false, run: reminderSweep("visit.reminder_2d", 1, 2) },
  { key: "work.stale", label: "Stale jobs", lane: "fast", every: "hourly", mutates: false, run: staleSweep },
  { key: "work.stats", label: "Next visit dates", lane: "bulk", every: "daily", at_local: "02:15", mutates: false, run: statsSweep },
  { key: "work.sync", label: "Jobs in step with their visits", lane: "fast", every: "hourly", mutates: true, run: (ctx) => import("./office-sync.mjs").then((m) => m.syncSweep(ctx)) },
  { key: "work.summaries", label: "Visit copies of names and places", lane: "bulk", every: "daily", at_local: "02:30", mutates: true, run: (ctx) => import("./office-sync.mjs").then((m) => m.summariesSweep(ctx)) },
];

export async function staleCount() {
  const ix = await readIndex("jobs", "open");
  return ix.rows.filter((r) => r.stale).length;
}
