// Work module, office part: writing jobs and visits (design §5.5, §11.3).
//
//   createJobs(jobs, opId, scope, ctx)  the work.createJobs service: ids
//        deriveId("job", opId, "work.createJobs@" + scope, n), numbers
//        journaled in a sub-op of kind "work.create_jobs" (resumable by the
//        worker), so a re-run or a resumed op creates nothing twice and no
//        number is ever lost or shown twice
//   cancelJobs(job_ids, reason, opId, ctx)   the work.cancelJobs service
//   createVisit(input, ctx)             book a visit on an open job
//   changeVisit(id, event, opts)        every visit change goes through the
//        visit state machine (states.mjs), then the job follows its visits
//        (syncJob), then one visit.* event. The tech app (M4b) calls this
//        too for its field events (on_my_way, start, pause, finish,
//        no_access), with opts.mutate for its own fields and opts.emit
//   syncJob(id, ctx)                    the job rule: status, schedule
//        summary and people from its visits (the job's list and the
//        job-visits relation, so a visit the job never heard of is found);
//        one job.* event per write
//
// A visit write and its job's sync are two writes. The visit carries the
// event its write makes (`last_event`: name, the wv of that write, the
// payload's extra fields), so a retry of the same request (same client id,
// a cancel sent again), and the work.sync sweep, finish what a crash left:
// the job is synced again and the event emitted again for that wv (event
// ids are record id + wv, so it is never queued twice).
//   cancelJob / reopenJob / completeJob the office's job actions
//   recomputeWorkStats(contactId)       the `work` part of ContactStats
//   onMergeWork(a, b, ctx)              b's jobs and visits move to a
//
// Every write takes the caller's write context: a person (API), the portal
// or an op acting for one are exempt from the parallel-run guard; automation
// may create or change jobs and visits only for sandboxed contacts before
// cutover (crm-store throws ParallelRunGuard, the caller writes a would- row).

import {
  getRecord, getRecords, createRecord, updateRecord, readIndex, readPointer, listRel, addActivity, updateStats, getSetting, getRaw,
} from "../../../crm-store.mjs";
import { deriveId, isId, newId } from "../../core/ids.mjs";
import { now, nowIso, localDate } from "../../core/clock.mjs";
import { InputError, NotFoundError, ConflictError, ExistsError, BlobsTransientError, StaleError } from "../../core/errors.mjs";
import { emit, eventId } from "../../core/events.mjs";
import { defineOp, runOp, opIdFor } from "../../core/ops.mjs";
import { notify } from "../../core/notify.mjs";
import { readSysMode } from "../../core/settings.mjs";
import { has as hasService, call as callService } from "../../core/services.mjs";
import { guardActive } from "../../core/guard.mjs";
import { sandboxed } from "../../core/context.mjs";
import { ParallelRunGuard } from "../../core/errors.mjs";
import { keySafe, truncate } from "../../core/text.mjs";
import { wouldAct } from "../../core/activity.mjs";
import { addressOneLine } from "../contacts/display.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import {
  OPEN_JOB, OPEN_VISIT, LIVE_VISIT, VISIT_STATES, visitNext, jobPath, jobStatusFromVisits, jobSchedule, jobAssignees, checklistMissing, canReopen,
} from "./states.mjs";
import { validateJob, validateLine, validateDiscount, jobNumberLabel, NOT_BILLABLE, MAX_VISITS_PER_JOB, DEFAULT_WINDOW } from "./types.mjs";
import { dateText, clock12 } from "./office-schedule.mjs";
import { confirmMoved } from "./automations.mjs";

export const JOB_START = 885;                    // Rotor's last job number was 0000884 (§3.9); cutover sets seq/job
export const MAX_JOBS_PER_CALL = 60;

// The work settings document (cfg/work, §3.3; settings:general).
export const WORK_DEFAULTS = Object.freeze({
  stale_in_progress_days: 2, timer_autoclose_after_min: 120, reopen_days: 7, clock_flag_at: "19:00", clock_autoclose_at: "21:00",
  default_window_minutes: 120, default_duration_min: 120, confirm_skip_within_days: 2, late_cancel_hours: 24,
});

// ------------------------------------------------------------ small helpers

export const W = (ctx = {}) => (ctx && typeof ctx.write === "function" ? ctx.write() : { ...(ctx || {}) });
const clone = (v) => JSON.parse(JSON.stringify(v));
const nameOf = (c) => (c ? c.display_name || [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || c.company_name || "No name" : "");
const union = (a = [], b = []) => [...new Set([...(a || []), ...(b || [])])];

export async function workSettings(opts = {}) {
  const s = await getSetting("work", opts).catch(() => ({}));
  return { ...WORK_DEFAULTS, ...(s || {}) };
}

// A contact id followed through merges (contacts.resolve), and its record.
export async function liveContact(id, ctx) {
  if (!isId(id, "contact")) return null;
  let cid = id;
  if (hasService("contacts.resolve")) { try { cid = (await callService("contacts.resolve", id, W(ctx))) || id; } catch { cid = id; } }
  const got = await getRecord("contact", cid);
  if (!got || got.data.deleted_at) return null;
  return got.data;
}

// What a visit shows about where it is: { property_id, town, address_line, geo }.
export async function placeOf(propertyId, contact, { property } = {}) {
  const pid = isId(propertyId, "property") ? propertyId : contact && isId(contact.primary_property_id, "property") ? contact.primary_property_id : null;
  const p = property && property.id === pid ? { data: property } : pid ? await getRecord("property", pid) : null;
  const a = p && !p.data.deleted_at ? p.data.address : contact && contact.billing_address;
  const geo = p && p.data.geo && Number.isFinite(p.data.geo.lat) ? [p.data.geo.lat, p.data.geo.lng] : undefined;
  return {
    property_id: p && !p.data.deleted_at ? p.data.id : undefined,
    town: (a && a.city) || undefined,
    address_line: a ? truncate(addressOneLine(a), 240) || undefined : undefined,
    geo,
  };
}

// The service types of a set of lines: "Residential Window Cleaning", ...
export const typesOfLines = (lines = []) => [...new Set((lines || []).map((l) => String((l && l.service_type) || "").split("::")[0].trim()).filter(Boolean))].slice(0, 20);

// ------------------------------------------------------------ checklists

// The checklist template for a job: the first active one (by order) whose
// job kinds include the job's kind, else whose service types match one of
// the job's, else none. → the template record or null.
export async function checklistFor(job, opts = {}, cache = null) {
  const ix = cache && cache.checklists ? cache.checklists : await readIndex("checklists", "", opts);
  if (cache) cache.checklists = ix;
  const rows = ix.rows.filter((r) => r.act !== false).sort((a, b) => (a.o ?? 50) - (b.o ?? 50) || String(a.k).localeCompare(String(b.k)));
  const types = (job.service_types || []).map((t) => String(t).split("::")[0].trim().toLowerCase());
  const pick = rows.find((r) => (r.jk || []).includes(job.kind))
    || (["standard", "touch_up", "warranty"].includes(job.kind) ? rows.find((r) => !(r.jk || []).length && (r.svc || []).some((s) => types.includes(String(s).toLowerCase()))) : null);
  if (!pick) return null;
  const key = `checklist:${pick.id}`;
  const got = cache && cache[key] !== undefined ? cache[key] : await getRecord("checklist_template", pick.id, opts);
  if (cache) cache[key] = got;
  return got && got.data.active !== false ? got.data : null;
}
export const checklistCopy = (t) => (t ? { template_key: t.key, items: (t.items || []).map((i) => ({ key: i.key, label: i.label, required: i.required === true, kind: i.kind || "check" })) } : { items: [] });

// ------------------------------------------------------------ work.createJobs

// One job spec of the service contract (§11.3), checked before anything is
// written: { contact_id, property_id, kind, title, lines, discounts, plan_id?,
// plan_ordinal?, quote_id?, deal_id?, season_install_id?, target_month?,
// billable } plus optional crew_notes, office_notes, service_types.
const SPEC_FIELDS = ["contact_id", "property_id", "kind", "title", "lines", "discounts", "plan_id", "plan_ordinal", "quote_id", "deal_id", "season_install_id", "target_month", "billable", "crew_notes", "office_notes", "service_types"];
function cleanSpec(spec, i) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new InputError("Expected a job.", `jobs.${i}`);
  const out = {};
  for (const k of SPEC_FIELDS) if (spec[k] !== undefined && spec[k] !== null) out[k] = clone(spec[k]);
  out.lines = (out.lines || []).map((l, n) => validateLine({ id: `ln_${n + 1}`, ...l }, `jobs.${i}.lines.${n}`));
  out.discounts = (out.discounts || []).map((d, n) => validateDiscount(d, `jobs.${i}.discounts.${n}`));
  if (!out.service_types || !out.service_types.length) out.service_types = typesOfLines(out.lines);
  // the whole record shape, with a stand-in number: an InputError here stops the op before it starts
  validateJob({ ...out, number: 1, seq: "job-shadow", status: "unscheduled" }, { op: "create" });
  return out;
}

async function buildJob(spec, { id, number, seq, numbering, contact, origin }) {
  const place = await placeOf(spec.property_id, contact);
  return {
    ...spec, id, number, seq, number_label: jobNumberLabel(number, seq, numbering), contact_id: contact.id, contact_name: nameOf(contact),
    ...(place.property_id ? { property_id: place.property_id } : {}),
    status: "unscheduled", visit_ids: [], invoice_ids: [], assignee_ids: [], office_notes: spec.office_notes || "", crew_notes: spec.crew_notes || "", review: {},
    billable: spec.billable === undefined ? !NOT_BILLABLE.includes(spec.kind || "standard") : spec.billable === true, origin,
  };
}

const jobEventPayload = (j, extra = {}) => ({
  id: j.id, wv: j.wv, job_id: j.id, contact_id: j.contact_id, kind: j.kind, billable: j.billable !== false, total_cents: (j.totals && j.totals.total_cents) || 0,
  assignee_ids: j.assignee_ids || [], ...(j.plan_id ? { plan_id: j.plan_id } : {}), ...(j.plan_ordinal ? { plan_ordinal: j.plan_ordinal } : {}),
  ...(j.quote_id ? { quote_id: j.quote_id } : {}), ...(j.deal_id ? { deal_id: j.deal_id } : {}), ...extra,
});

// The sub-op that makes the jobs: one step per job, each number journaled
// before it is used (ops.mjs s.number). Defined by kind, so the worker's
// ops.resume finishes it if the function dies half way.
defineOp("work.create_jobs", {
  steps: (input) => (input.jobs || []).map((spec, i) => ({
    name: `job${i + 1}`,
    async run(s) {
      const id = deriveId("job", input.op_id, `work.createJobs@${input.scope}`, i + 1);
      const have = await getRecord("job", id);
      if (have) return { id };
      const contact = await liveContact(spec.contact_id, s.ctx);
      if (!contact) throw new NotFoundError("That contact isn't there anymore.");
      const number = await s.number(id, input.seq, { start: input.seq === "job" ? JOB_START : 1 });
      const data = await buildJob(spec, { id, number, seq: input.seq, numbering: input.numbering, contact, origin: input.scope });
      let rec;
      try {
        rec = (await createRecord("job", data, s.ctx)).data;
      } catch (e) {
        if (!(e instanceof ExistsError)) throw e;
        const got = await getRecord("job", id);
        if (!got) throw e;
        return { id };
      }
      await emit("job.created", jobEventPayload(rec), s.ctx).catch((e) => console.error(`crm:work: job.created not queued (${safeErr(e)})`));
      return { id };
    },
  })),
});

// (jobs, opId, scope, ctx) → job_ids (§11.3).
export async function createJobs(jobs, opId, scope, ctx = {}) {
  if (!Array.isArray(jobs)) throw new InputError("Expected a list of jobs.", "jobs");
  if (!jobs.length) return [];
  if (jobs.length > MAX_JOBS_PER_CALL) throw new InputError(`At most ${MAX_JOBS_PER_CALL} jobs at once.`, "jobs");
  if (typeof opId !== "string" || !opId.trim()) throw new InputError("createJobs needs the op it runs in.", "op");
  const sc = keySafe(String(scope || "default"), 40);
  const w = W(ctx);
  const mode = w.mode || await readSysMode();
  const wctx = { ...w, mode };
  const specs = jobs.map(cleanSpec);
  // the parallel-run guard, before the journal exists: automation makes jobs
  // only for sandboxed contacts while Rotor is in charge (§3.10)
  if (guardActive(wctx)) {
    for (const s of specs) {
      const c = await liveContact(s.contact_id, wctx);
      if (!c || !sandboxed(c, c)) throw new ParallelRunGuard("Rotor is still in charge of this customer.", { type: "job", action: "create", subject: s.contact_id });
    }
  }
  const seq = mode.system_of_record === "crm" ? "job" : "job-shadow";
  const numbering = await getSetting("numbering").catch(() => null);
  const formats = numbering ? { job: numbering.job, "job-shadow": numbering["job-shadow"] } : undefined;
  const subId = opIdFor(`jobs--${keySafe(opId, 120)}--${sc}`, 1);
  const out = await runOp(subId, "work.create_jobs", {
    input: { op_id: opId, scope: sc, seq, numbering: formats, jobs: specs }, ctx: wctx, holder: String(w.requestId || w.op || "work").slice(0, 80), resume: true,
  });
  if (out.status === "running") throw new BlobsTransientError("Those jobs are still being made. Try again in a minute.");
  if (out.status === "failed") throw new ConflictError("Those jobs couldn't be made.", { op: subId });
  return specs.map((_, i) => deriveId("job", opId, `work.createJobs@${sc}`, i + 1));
}

// ------------------------------------------------------------ the job rule

// Reads a job and its visits, brings its status, schedule summary and
// people in line with them, and emits one job.* event for the write.
// extra: visit ids to add (a visit just booked). → { job, changed }
export async function syncJob(jobId, ctx = {}, { add = [], by } = {}) {
  const w = W(ctx);
  const got = await getRecord("job", jobId);
  if (!got) throw new NotFoundError("That job isn't there.");
  const rel = await listRel("job-visits", jobId, { limit: MAX_VISITS_PER_JOB }).catch(() => []);
  const ids = union(union(got.data.visit_ids, add), rel.map((r) => r.id)).slice(0, MAX_VISITS_PER_JOB * 2);
  const visits = (await getRecords("visit", ids)).filter(Boolean).map((g) => g.data).filter((v) => v.job_id === jobId && !v.deleted_at);
  const mine = visits.map((v) => v.id);
  let path = [];
  const at = nowIso();
  const r = await updateRecord("job", jobId, (j) => {
    const target = jobStatusFromVisits(j, visits);
    path = jobPath(j.status, target);
    const next = {
      ...j, status: target, schedule: jobSchedule(visits), assignee_ids: jobAssignees(visits),
      visit_ids: union((j.visit_ids || []).filter((id) => mine.includes(id) || !ids.includes(id)), mine).slice(0, MAX_VISITS_PER_JOB),
    };
    if (path.includes("start") && !j.started_at) next.started_at = at;
    if (target === "completed" && j.status !== "completed") {
      const last = visits.filter((v) => v.status === "completed").map((v) => (v.completion && v.completion.at) || v.updated_at).sort().pop();
      next.completed_at = last || at;
      next.completed_by = by || w.by || "system";
    }
    if (path.includes("reopen")) { next.reopened_at = at; delete next.completed_at; delete next.completed_by; delete next.started_at; if (path.includes("start")) next.started_at = at; }
    if (target === "unscheduled" || target === "scheduled") { if (!path.includes("start")) delete next.started_at; }
    return JSON.stringify(next) === JSON.stringify(j) ? null : next;
  }, w);
  if (r.changed) await emitJobChange(r.data, path, w);
  return { job: r.data, changed: r.changed, path };
}

// One event per job write (an event id is the record id + its write
// counter, so two events from one write would collide, §11.3).
async function emitJobChange(job, path, w) {
  const name = path.includes("complete") ? "job.completed" : path.includes("reopen") ? "job.reopened" : path.includes("cancel") ? "job.cancelled" : path.includes("schedule") ? "job.scheduled" : null;
  if (!name) return;
  await emit(name, jobEventPayload(job, name === "job.completed" ? { completed_at: job.completed_at } : name === "job.cancelled" ? { reason: job.cancel_reason || "" } : {}), w)
    .catch((e) => console.error(`crm:work: ${name} not queued (${safeErr(e)})`));
}

// ------------------------------------------------------------ visits

const visitEventPayload = (v, extra = {}) => ({
  id: v.id, wv: v.wv, visit_id: v.id, job_id: v.job_id, contact_id: v.contact_id, date: v.date, start: v.start, assignee_ids: v.assignee_ids || [],
  ...(v.moved_by_op ? { moved_by_op: v.moved_by_op } : {}), ...extra,
});

const BOOKABLE = ["unscheduled", "scheduled", "in_progress"];

// What a visit write records about the event it makes (see the top).
const lastEvent = (name, v, by, extra = {}) => (name ? { name, wv: (v.wv || 0) + 1, by: by || "system", ...(Object.keys(extra).length ? { extra } : {}) } : undefined);

// After a visit write (or a retry of one, or the sweep): the job follows its
// visits, then the event of the visit's last write, if the event is still
// the visit's latest. → { job }
export async function settleVisit(visit, w, { activity = false, again = false } = {}) {
  const synced = await syncJob(visit.job_id, w, { add: [visit.id] });
  const e = visit.last_event;
  // again (a retry, the sweep): skip an event the module's own listener already handled
  const handled = again && e && e.wv === visit.wv ? await getRaw(`done/evt/${eventId(visit.id, visit.wv)}--work`).catch(() => null) : null;
  if (e && e.name && e.wv === visit.wv && !(handled && handled.data)) {
    await emit(e.name, visitEventPayload(visit, { ...(e.extra || {}), by: e.by || w.by || "system" }), w).catch((x) => console.error(`crm:work: ${e.name} not queued (${safeErr(x)})`));
    if (activity && ["visit.scheduled", "visit.completed", "visit.cancelled", "visit.no_access"].includes(e.name)) await addActivity(visit.contact_id, e.name, visit.id, now()).catch(() => {});
    if (e.name === "visit.no_access" || (e.name === "visit.cancelled" && visit.late_cancel)) await lateCancelTask(visit, e.name === "visit.no_access" ? "no_access" : "cancel", w).catch((x) => console.error(`crm:work: late-cancel task not made (${safeErr(x)})`));
  }
  return { job: synced.job };
}

// input: { job_id, date, start, end, window?, assignee_ids?, property_id?,
// client_id?, route_order?, date_only? }. → { visit, job }
export async function createVisit(input = {}, ctx = {}) {
  const w = W(ctx);
  if (!isId(input.job_id, "job")) throw new InputError("Pick the job.", "job_id");
  const jg = await getRecord("job", input.job_id);
  if (!jg || jg.data.deleted_at) throw new NotFoundError("That job isn't there.");
  const job = jg.data;
  if (!BOOKABLE.includes(job.status)) throw new ConflictError(job.status === "cancelled" ? "This job was cancelled." : "This job is done. Reopen it first.");
  if ((job.visit_ids || []).length >= MAX_VISITS_PER_JOB) throw new ConflictError("This job has as many visits as it can hold.");
  const contact = await liveContact(job.contact_id, w);
  if (!contact) throw new NotFoundError("That job's contact isn't there anymore.");
  const id = typeof input.client_id === "string" && /^[A-Za-z0-9-]{8,64}$/.test(input.client_id) ? deriveId("visit", `c:${input.client_id.toLowerCase()}`) : newId("visit");
  const dup = await getRecord("visit", id);
  if (dup) {
    // the same booking again (a retry): finish what the first try may not have
    const settled = await settleVisit(dup.data, w, { again: true });
    return { visit: dup.data, job: settled.job || job, replay: true };
  }
  const [summary, template] = await Promise.all([visitSummary(job, contact, input.property_id || job.property_id), checklistFor(job)]);
  const s = await workSettings();
  const data = {
    id, job_id: job.id, contact_id: contact.id, ordering: (job.visit_ids || []).length + 1,
    date: input.date, start: input.start, end: input.end, window: input.window || { ...DEFAULT_WINDOW, minutes: s.default_window_minutes || 120 },
    assignee_ids: input.assignee_ids || [], status: "scheduled", checklist: checklistCopy(template), photos: [], tech_notes: "",
    ...(input.route_order ? { route_order: input.route_order } : {}), ...(input.date_only ? { date_only: true } : {}),
    ...summary, last_event: lastEvent("visit.scheduled", { wv: 0 }, w.by),
  };
  let rec;
  try {
    rec = (await createRecord("visit", data, w)).data;
  } catch (e) {
    if (!(e instanceof ExistsError)) throw e;
    const got = await getRecord("visit", id);
    if (!got) throw e;
    const settled = await settleVisit(got.data, w, { again: true });
    return { visit: got.data, job: settled.job || job, replay: true };
  }
  const synced = await settleVisit(rec, w, { activity: true });
  return { visit: rec, job: synced.job };
}

// The visit.* event a change makes (one per write), or null.
export function visitEventFor(event, before, after) {
  if (event === "cancel") return before.status === "cancelled" ? null : "visit.cancelled";
  if (event === "no_access") return "visit.no_access";
  if (event === "finish" || event === "office_complete") return "visit.completed";
  if (before.date !== after.date || before.start !== after.start || before.end !== after.end) return "visit.rescheduled";
  if (JSON.stringify([...(before.assignee_ids || [])].sort()) !== JSON.stringify([...(after.assignee_ids || [])].sort())) return "visit.assigned";
  return null;
}

// Every visit change. event: a VISIT_STATES event; opts: { patch (fields to
// set), mutate(draft, before) (the field part's own fields), ifMatch, ctx,
// note, reason, emit (default true), late (a customer's late cancel) }.
// → { visit, job, event }
export async function changeVisit(visitId, event, opts = {}) {
  const w = W(opts.ctx);
  if (!isId(visitId, "visit")) throw new NotFoundError("That visit isn't there.");
  const cur = await getRecord("visit", visitId);
  if (!cur || cur.data.deleted_at) throw new NotFoundError("That visit isn't there.");
  if (event === "reopen") {
    const s = await workSettings();
    if (!canReopen(cur.data, now(), s.reopen_days)) throw new ConflictError(`A visit can be reopened for ${s.reopen_days} days after it's done.`);
    // reopening the visit reopens a finished job: the same check as reopenJob
    const jg = await getRecord("job", cur.data.job_id);
    if (jg && jg.data.status === "completed") await assertNoPaidInvoice(jg.data);
  }
  let before = null;
  const at = nowIso();
  const r = await updateRecord("visit", visitId, (v) => {
    before = clone(v);
    if (event === "cancel" && v.status === "cancelled") return null;          // a retried cancel
    const status = visitNext(v.status, event);
    let next = { ...v, ...(opts.patch || {}), status };
    if (event === "cancel") { next.cancelled_at = at; next.cancel_reason = String(opts.reason || "").slice(0, 300) || undefined; if (opts.late) next.late_cancel = true; }
    if (event === "no_access") next.no_access = { at, by: w.by || "system", ...(opts.note ? { note: String(opts.note).slice(0, 500) } : {}) };
    if (event === "office_complete") next.completion = { at, by: w.by || "system", office: true };
    if (event === "reopen") next.completion = { ...(v.completion || {}), reopened_at: at, reopened_by: w.by || "system" };
    if (event === "reschedule" && !opts.keepMove) delete next.moved_by_op;
    if (typeof opts.mutate === "function") next = { ...(opts.mutate(next, before) || next), status };
    if (event === "finish") {
      // required checklist items gate completion (B13), after the change's own ticks
      const missing = checklistMissing(next);
      if (missing.length) throw new InputError(`Finish the checklist first: ${missing.join(", ")}.`, "checklist");
      if (!(next.completion && next.completion.at && !(before.completion && before.completion.at === next.completion.at))) next.completion = { ...(next.completion || {}), at, by: w.by || "system" };
    }
    // the event this write makes, kept with it (a retry or the sweep can emit it again)
    const name = opts.emit === false ? null : visitEventFor(event, before, next);
    const extra = {};
    if (name) {
      if (JSON.stringify(before.assignee_ids || []) !== JSON.stringify(next.assignee_ids || [])) extra.previous_assignee_ids = before.assignee_ids || [];
      if (name === "visit.rescheduled") { extra.previous_date = before.date; extra.previous_start = before.start; }
      if (name === "visit.cancelled" && opts.reason) extra.reason = String(opts.reason).slice(0, 120);
    }
    next.last_event = lastEvent(name, v, w.by, extra);
    if (!next.last_event) delete next.last_event;
    return next;
  }, { ...w, ...(opts.ifMatch ? { ifMatch: opts.ifMatch } : {}) });
  const visit = r.data;
  if (!r.changed) {
    // nothing to change (a request sent again): finish what an earlier try may have left
    const settled = await settleVisit(visit, w, { again: true });
    return { visit, job: settled.job, event: null };
  }
  const touchesJob = before.status !== visit.status || before.date !== visit.date || JSON.stringify(before.assignee_ids) !== JSON.stringify(visit.assignee_ids);
  let job = null;
  if (touchesJob || visit.last_event) job = (await settleVisit(visit, w, { activity: true })).job;
  return { visit, job, event: visit.last_event ? visit.last_event.name : null };
}

// A no-access visit or a customer's cancel under 24 hours makes an approval
// task for the owners: charge the late-cancel fee or not (D28; never when
// Barta moves the visit). Its id derives from the visit and its write
// counter, so a retry makes one.
async function lateCancelTask(visit, event, w) {
  const { approvers } = await import("../../core/notify.mjs");
  const owners = await approvers().catch(() => []);
  const id = deriveId("task", visit.id, "work.late_cancel", visit.wv);
  if (await getRecord("task", id)) return;
  try {
    await createRecord("task", {
      id, title: `Late-cancel fee? ${event === "no_access" ? "No access" : "Cancelled late"}: ${dateText(visit.date)}`.slice(0, 160), kind: "approval", priority: "medium", status: "open",
      contact_id: visit.contact_id, contact_name: visit.contact_name || undefined, job_id: visit.job_id, visit_id: visit.id, assignee_ids: owners.slice(0, 3),
      approval: { kind: "late_cancel_fee", ref_id: visit.id }, notes: "Charge the late-cancel fee only if an owner says so (D28).",
    }, w);
  } catch (e) {
    if (!(e instanceof ExistsError)) throw e;
  }
}

// ------------------------------------------------------------ the office's job actions

// A job with a paid invoice stays finished (the money module's invoices,
// read only when they exist).
export async function assertNoPaidInvoice(job) {
  for (const iid of (job.invoice_ids || []).slice(0, 10)) {
    const inv = isId(iid, "invoice") ? await getRecord("invoice", iid) : null;
    if (inv && ["paid", "partially_paid"].includes(inv.data.status)) throw new ConflictError("This job has a paid invoice, so it can't be reopened.");
    // Money (M5) keeps a part-paid invoice "open": money already taken on it holds the job the same way
    if (inv && inv.data.status === "open" && (inv.data.paid_cents || 0) - (inv.data.refunded_cents || 0) > 0) throw new ConflictError("This job's invoice has a payment on it, so it can't be reopened. Refund the payment first.");
  }
}

// Every visit of a job: its list and the job-visits relation (a visit the
// job never heard of, after a crash, is found too).
export async function visitsOfJob(job) {
  const rel = await listRel("job-visits", job.id, { limit: MAX_VISITS_PER_JOB }).catch(() => []);
  const ids = union(job.visit_ids, rel.map((r) => r.id)).slice(0, MAX_VISITS_PER_JOB * 2);
  return (await getRecords("visit", ids)).filter(Boolean).map((g) => g.data).filter((v) => v.job_id === job.id && !v.deleted_at);
}

// The parallel-run guard for an automated job change, before anything is
// written: an imported job or visit Rotor still owns is never touched by
// automation (one would- row instead). → null | the refusal
async function guardRefusal(job, visits, action, w) {
  if (!guardActive(w)) return null;
  const contact = await liveContact(job.contact_id, w).catch(() => null);
  const owned = (r) => !!(r && r.import) && !sandboxed(r, contact);
  const hit = owned(job) ? job : visits.find(owned);
  return hit ? { id: hit.id, type: hit === job ? "job" : "visit" } : null;
}

async function openJob(jobId) {
  if (!isId(jobId, "job")) throw new NotFoundError("That job isn't there.");
  const got = await getRecord("job", jobId);
  if (!got || got.data.deleted_at) throw new NotFoundError("That job isn't there.");
  return got;
}

// Cancel a job: its open visits are cancelled first, then the job. → job
export async function cancelJob(jobId, reason, ctx = {}, { ifMatch } = {}) {
  const w = W(ctx);
  const got = await openJob(jobId);
  if (got.data.status === "cancelled") return got.data;
  if (got.data.status === "completed") throw new ConflictError("A finished job can't be cancelled. Reopen it first.");
  if (ifMatch && ifMatch !== got.etag) throw new StaleError(got.data, got.etag);
  const visits = await visitsOfJob(got.data);
  const toCancel = visits.filter((v) => OPEN_VISIT.includes(v.status) || v.status === "no_access");
  const refused = await guardRefusal(got.data, toCancel, "cancel", w);
  if (refused) {
    await wouldAct({ key: "work.cancelJobs", subject: got.data, action: "cancel", changes: { status: [got.data.status, "cancelled"], visits: [toCancel.length, 0] } }).catch(() => {});
    throw new ParallelRunGuard("Rotor is still in charge of this job.", { type: refused.type, action: "cancel", subject: refused.id });
  }
  for (const v of toCancel) await changeVisit(v.id, "cancel", { ctx: w, reason: "job cancelled" });
  const at = nowIso();
  let path = [];
  const r = await updateRecord("job", jobId, (j) => {
    if (j.status === "cancelled") return null;
    path = jobPath(j.status, "cancelled");
    return { ...j, status: "cancelled", cancelled_at: at, cancel_reason: String(reason || "").slice(0, 300) || "cancelled" };
  }, w);
  if (r.changed) await emitJobChange(r.data, path, w);
  return r.data;
}

// (job_ids, reason, opId, ctx) → { cancelled, skipped } (§11.3). A job
// already cancelled or finished is skipped, so a re-run changes nothing.
export async function cancelJobs(jobIds, reason, opId, ctx = {}) {
  if (!Array.isArray(jobIds)) throw new InputError("Expected job ids.", "job_ids");
  const out = { cancelled: [], skipped: [] };
  for (const id of jobIds.slice(0, MAX_JOBS_PER_CALL)) {
    const got = isId(id, "job") ? await getRecord("job", id) : null;
    if (!got || !OPEN_JOB.includes(got.data.status)) { out.skipped.push(id); continue; }
    try {
      await cancelJob(id, reason || `cancelled (${keySafe(String(opId || "op"), 60)})`, ctx);
    } catch (e) {
      // refused before anything was written (a would- row says what it would have done)
      if (e instanceof ParallelRunGuard) { out.skipped.push(id); continue; }
      throw e;
    }
    out.cancelled.push(id);
  }
  return out;
}

// Reopen a finished job (owner/admin; not once it has a paid invoice: the
// money module's invoice ids are checked when it's there). → job
export async function reopenJob(jobId, ctx = {}) {
  const w = W(ctx);
  const got = await openJob(jobId);
  if (got.data.status !== "completed") throw new ConflictError("Only a finished job can be reopened.");
  await assertNoPaidInvoice(got.data);
  let path = [];
  const r = await updateRecord("job", jobId, (j) => {
    if (j.status !== "completed") return null;
    path = jobPath(j.status, "scheduled");
    const next = { ...j, status: "scheduled", reopened_at: nowIso() };
    delete next.completed_at; delete next.completed_by;
    return next;
  }, w);
  if (r.changed) await emitJobChange(r.data, path, w);
  // a reopened job whose visits are all done stays "scheduled" until a visit is added or reopened
  return r.data;
}

// The office closes a job: every visit still open is closed by the office
// (office_complete; a tech's checklist isn't enforced), then the job follows.
export async function completeJob(jobId, ctx = {}) {
  const w = W(ctx);
  const got = await openJob(jobId);
  const job = got.data;
  if (!["scheduled", "in_progress"].includes(job.status)) throw new ConflictError(job.status === "unscheduled" ? "Book a visit first, then mark it done." : "This job can't be marked done.");
  const visits = await visitsOfJob(job);
  for (const v of visits) if (OPEN_VISIT.includes(v.status)) await changeVisit(v.id, "office_complete", { ctx: w });
  return (await syncJob(jobId, w)).job;
}

// ------------------------------------------------------------ what a visit copies

// What a visit shows of its job, contact and place (copied at booking so
// the schedule reads one index): → the fields.
export async function visitSummary(job, contact, propertyId, { property } = {}) {
  const place = await placeOf(propertyId || job.property_id, contact, { property });
  return {
    job_number: job.number_label, job_kind: job.kind, job_title: job.title, service_types: job.service_types || [], ...(job.plan_id ? { plan_id: job.plan_id } : {}),
    contact_name: nameOf(contact), ...place,
  };
}
const SUMMARY_KEYS = ["job_number", "job_kind", "job_title", "service_types", "plan_id", "contact_name", "property_id", "town", "address_line", "geo"];

// Brings the copies on a job's open visits up to date (after the job, its
// contact or its place changed). A booked visit whose checklist nobody has
// touched gets the job's list again (the work may have changed). No event:
// nothing about the visit itself changed. → visits changed
export async function refreshVisits(jobId, ctx = {}, { visits: given, contact: knownContact, properties, propertyFrom } = {}) {
  const w = W(ctx);
  const jg = await getRecord("job", jobId);
  if (!jg || jg.data.deleted_at) return 0;
  const job = jg.data;
  const visits = (given || await visitsOfJob(job)).filter((v) => OPEN_VISIT.includes(v.status));
  if (!visits.length) return 0;
  const contact = knownContact || await liveContact(job.contact_id, w);
  if (!contact) return 0;
  const template = visits.some((v) => v.status === "scheduled") ? await checklistFor(job) : null;
  let changed = 0;
  for (const v of visits) {
    // a visit at the job's old place follows the job to its new one
    const pid = (propertyFrom && v.property_id === propertyFrom ? job.property_id : v.property_id) || job.property_id;
    const want = await visitSummary(job, contact, pid, { property: properties && properties.get(pid) });
    const r = await updateRecord("visit", v.id, (cur) => {
      if (!OPEN_VISIT.includes(cur.status) || cur.job_id !== job.id) return null;
      const next = { ...cur };
      for (const k of SUMMARY_KEYS) { if (want[k] === undefined) delete next[k]; else next[k] = want[k]; }
      const untouched = cur.status === "scheduled" && !((cur.checklist && cur.checklist.items) || []).some((i) => i.done_at || i.done || (i.value !== undefined && i.value !== null && i.value !== ""));
      if (untouched) {
        const copy = checklistCopy(template);
        if (((cur.checklist && cur.checklist.template_key) || null) !== (copy.template_key || null)) next.checklist = copy;
      }
      return JSON.stringify(next) === JSON.stringify(cur) ? null : next;
    }, w).catch((e) => { if (e instanceof NotFoundError) return { changed: false }; throw e; });
    if (r.changed) changed += 1;
  }
  return changed;
}

// ------------------------------------------------------------ stats (the `work` part of ContactStats, §5.1)

export const WORK_STATS = Object.freeze({ first_service_on: null, last_service_on: null, next_visit_on: null, jobs_completed: 0, svc_d: [] });
export const statsParts = {
  work: { defaults: { ...WORK_STATS, svc_d: [] }, row: (p) => ({ nv: (p && p.next_visit_on) || null, ls: (p && p.last_service_on) || null, svc_d: (p && p.svc_d) || [] }) },
};

// Works the part out again from the contact's jobs (and, only when a job's
// first open visit is behind today, its visits). Derived data: no guard.
export async function recomputeWorkStats(contactId, ctx = {}) {
  if (!isId(contactId, "contact")) return null;
  const today = localDate(now());
  const rows = await listRel("contact-jobs", contactId, { limit: 200 });
  const jobs = (await getRecords("job", rows.map((r) => r.id))).filter(Boolean).map((g) => g.data).filter((j) => !j.deleted_at && j.contact_id === contactId);
  const done = jobs.filter((j) => j.status === "completed");
  const doneDates = done.map((j) => (j.completed_at ? localDate(new Date(j.completed_at)) : null)).filter(Boolean).sort();
  let next = null;
  for (const j of jobs.filter((x) => OPEN_JOB.includes(x.status))) {
    const s = j.schedule || {};
    if (s.open_on && s.open_on >= today) { if (!next || s.open_on < next) next = s.open_on; continue; }
    if (s.last_on && s.last_on >= today) {
      const vs = (await getRecords("visit", (j.visit_ids || []).slice(0, 20))).filter(Boolean).map((g) => g.data);
      for (const v of vs) if (OPEN_VISIT.includes(v.status) && v.date >= today && (!next || v.date < next)) next = v.date;
    }
  }
  const part = {
    first_service_on: doneDates[0] || null, last_service_on: doneDates[doneDates.length - 1] || null, next_visit_on: next,
    jobs_completed: done.length, svc_d: [...new Set(done.flatMap((j) => j.service_types || []).map((t) => String(t).split("::")[0].trim()).filter(Boolean))].slice(0, 20),
  };
  const r = await updateStats(contactId, "work", (p) => (JSON.stringify({ ...WORK_STATS, ...p }) === JSON.stringify(part) ? null : part), W(ctx));
  return r.data && r.data.work;
}

// ------------------------------------------------------------ pushes to the team (§5.7.7)

// Who hears about a visit change: { added, removed, kept } of its people,
// never the person who made the change.
export function affected(payload, current) {
  const before = new Set(payload.previous_assignee_ids || payload.assignee_ids || []);
  const now_ = new Set(current || payload.assignee_ids || []);
  const by = payload.by;
  const drop = (list) => list.filter((u) => u !== by);
  return {
    added: drop([...now_].filter((u) => !before.has(u))),
    removed: drop([...before].filter((u) => !now_.has(u))),
    kept: drop([...now_].filter((u) => before.has(u))),
  };
}

const when = (v) => `${dateText(v.date)}${v.date_only ? "" : `, ${clock12(v.start)}`}${v.town ? ` in ${v.town}` : ""}`;

// The listener of the module's own visit events: pushes for the affected
// techs (a rain-day move pushes once per tech from its op instead), then
// the contact's work stats.
export async function onVisitEvent(event, h) {
  const p = event.payload || {};
  const got = isId(p.visit_id, "visit") ? await getRecord("visit", p.visit_id) : null;
  const v = got ? got.data : null;
  let pushed = 0;
  const send = async (users, kind, title, body) => {
    if (!users.length) return;
    await notify(users, { kind, title, body, link: `/visits/${p.visit_id}` }, h.ctx.write());
    pushed += users.length;
  };
  if (v && !p.moved_by_op) {
    if (event.name === "visit.scheduled" && v.status === "scheduled") {
      await send((p.assignee_ids || []).filter((u) => u !== p.by), "visit_assigned", "New visit", `You're on a visit ${when(v)}.`);
    } else if (event.name === "visit.assigned" || event.name === "visit.rescheduled") {
      const a = affected(p, p.assignee_ids);
      const at = { ...p, town: v.town, date_only: v.date_only };
      if (v.status !== "cancelled") {
        await send(a.added, "visit_assigned", "New visit", `You're on a visit ${when(at)}.`);
        if (event.name === "visit.rescheduled") await send(a.kept, "visit_changed", "Visit moved", `A visit moved to ${when(at)}.`);
      }
      await send(a.removed, "visit_cancelled", "Off a visit", `You're off the visit ${when({ ...at, date: p.previous_date || p.date, start: p.previous_start || p.start })}.`);
    } else if (event.name === "visit.cancelled") {
      await send((p.assignee_ids || []).filter((u) => u !== p.by), "visit_cancelled", "Visit cancelled", `The visit ${when({ ...p, town: v.town, date_only: v.date_only })} is cancelled.`);
    }
  }
  // a moved visit is confirmed again (visit.confirm skips rain-day moves and visits within 2 days)
  if (event.name === "visit.rescheduled" && v && v.status === "scheduled" && !p.moved_by_op) {
    await confirmMoved(event, h).catch((e) => console.error(`crm:work: visit.confirm not queued (${safeErr(e)})`));
  }
  if (isId(p.contact_id, "contact")) await recomputeWorkStats(p.contact_id, h.ctx.write()).catch((e) => console.error(`crm:work: stats not updated (${safeErr(e)})`));
  return { result: pushed ? `pushed:${pushed}` : "done" };
}

export async function onJobEvent(event, h) {
  const p = event.payload || {};
  if (isId(p.contact_id, "contact")) await recomputeWorkStats(p.contact_id, h.ctx.write());
  return { result: "done" };
}

export const listeners = {
  "visit.scheduled": { handler: onVisitEvent, mutates: false },
  "visit.rescheduled": { handler: onVisitEvent, mutates: false },
  "visit.assigned": { handler: onVisitEvent, mutates: false },
  "visit.cancelled": { handler: onVisitEvent, mutates: false },
  "visit.completed": { handler: onVisitEvent, mutates: false },
  "visit.no_access": { handler: onVisitEvent, mutates: false },
  "job.completed": { handler: onJobEvent, mutates: false },
  "job.reopened": { handler: onJobEvent, mutates: false },
  "job.cancelled": { handler: onJobEvent, mutates: false },
};

// ------------------------------------------------------------ merge (§5.1, §11.3 onMerge)

// b's jobs and their visits move to the survivor a (contact_id and the name
// the schedule shows); then a's work stats are worked out again.
export async function onMergeWork(a, b, ctx = {}) {
  const w = W(ctx);
  const survivor = await getRecord("contact", a);
  const name = survivor ? nameOf(survivor.data) : undefined;
  const rows = await listRel("contact-jobs", b, { limit: 500 });
  for (const row of rows) {
    const g = await getRecord("job", row.id);
    if (!g || g.data.contact_id !== b) continue;
    for (const vid of g.data.visit_ids || []) {
      await updateRecord("visit", vid, (v) => (v.contact_id === b ? { ...v, contact_id: a, ...(name ? { contact_name: name } : {}) } : null), w).catch((e) => { if (!(e instanceof NotFoundError)) throw e; });
    }
    await updateRecord("job", row.id, (j) => (j.contact_id === b ? { ...j, contact_id: a, ...(name ? { contact_name: name } : {}) } : null), w);
  }
  await recomputeWorkStats(a, w).catch(() => null);
}

// ------------------------------------------------------------ seeds (§11.1 rule 6)

// The five checklists of §5.5 ("*" = required, they gate completion, B13).
export const SEED_CHECKLISTS = Object.freeze([
  { key: "windows_exterior", name: "Exterior windows", service_types: ["Residential Window Cleaning"], job_kinds: [], order: 10, items: [
    { key: "walkaround_photo", label: "Walk-around before photo", required: true, kind: "photo" },
    { key: "screens_removed", label: "Screens removed", required: false, kind: "check" },
    { key: "glass", label: "Glass", required: false, kind: "check" },
    { key: "frames_sills", label: "Frames and sills", required: false, kind: "check" },
    { key: "screens_back", label: "Screens back in", required: false, kind: "check" },
    { key: "tracks", label: "Tracks (if sold)", required: false, kind: "check" },
    { key: "after_photo", label: "After photo", required: true, kind: "photo" },
    { key: "gate_closed", label: "Gate closed", required: true, kind: "check" },
  ] },
  { key: "windows_interior", name: "Interior windows", service_types: [], job_kinds: [], order: 20, items: [
    { key: "drop_cloths", label: "Drop cloths down", required: false, kind: "check" },
    { key: "glass", label: "Glass", required: false, kind: "check" },
    { key: "sills", label: "Sills", required: false, kind: "check" },
    { key: "after_photo", label: "After photo", required: true, kind: "photo" },
  ] },
  { key: "gutters", name: "Gutters", service_types: ["Exterior Cleaning"], job_kinds: [], order: 30, items: [
    { key: "before_photo", label: "Before photo", required: true, kind: "photo" },
    { key: "gutters_cleared", label: "Gutters cleared", required: false, kind: "check" },
    { key: "downspouts", label: "Downspouts flushed", required: true, kind: "check" },
    { key: "debris_bagged", label: "Debris bagged", required: false, kind: "check" },
    { key: "roof_check", label: "Roof and gutter check notes", required: false, kind: "text" },
    { key: "after_photo", label: "After photo", required: true, kind: "photo" },
  ] },
  { key: "lights_install", name: "Christmas lights install", service_types: ["Christmas Lights"], job_kinds: ["lights_install"], order: 40, items: [
    { key: "design_followed", label: "Design followed", required: false, kind: "check" },
    { key: "clips", label: "Clips used", required: false, kind: "count" },
    { key: "timer_set", label: "Timer set", required: true, kind: "check" },
    { key: "night_photo", label: "Night photo", required: false, kind: "photo" },
    { key: "power_notes", label: "Power notes", required: false, kind: "text" },
  ] },
  { key: "lights_takedown", name: "Christmas lights takedown", service_types: [], job_kinds: ["lights_takedown"], order: 50, items: [
    { key: "strands_down", label: "All strands down", required: true, kind: "check" },
    { key: "bin_id", label: "Bin number", required: true, kind: "text" },
    { key: "damage_notes", label: "Damage notes", required: false, kind: "text" },
  ] },
]);
export const seedChecklistId = (key) => deriveId("checklist_template", "seed:checklist", "work", key);

export async function seedChecklists(ctx) {
  let created = 0;
  for (const c of SEED_CHECKLISTS) {
    if (await readPointer("checklist-key", c.key)) continue;
    try {
      await createRecord("checklist_template", { ...clone(c), id: seedChecklistId(c.key), active: true }, W(ctx));
      created += 1;
    } catch (e) {
      if (!(e instanceof ExistsError)) throw e;
    }
  }
  return { created };
}

export { VISIT_STATES, LIVE_VISIT };
