// Work module, office part: the sweeps that keep jobs and visits in step
// (design §5.5, §3.5). A visit write and its job's sync are two writes, and
// a visit copies what it shows of its job, contact and place when it is
// booked; these finish what a crash left and follow later edits.
//
//   work.sync       fast lane, hourly: the visits index (a month back, six
//                   ahead) against the open jobs: a job whose status or next
//                   visit doesn't match its visits, or a live visit whose job
//                   is closed or never heard of it, is synced again
//                   (syncJob finds a visit through the job-visits relation)
//                   and the visit's last event emitted again (settleVisit;
//                   event ids dedupe). A cancelled job's leftover visits are
//                   cancelled. An imported job Rotor still owns is left alone
//                   (the parallel-run guard; counted).
//   work.summaries  bulk lane, daily 02:30: open visits from yesterday on
//                   whose copied customer name, town, address or map point
//                   no longer match the contact and property get them again
//                   (refreshVisits), with the job's own copy of the name.

import { readIndex, getRecord, getRecords, updateRecord } from "../../../crm-store.mjs";
import { now, localDate, addLocalDays } from "../../core/clock.mjs";
import { isId } from "../../core/ids.mjs";
import { ParallelRunGuard } from "../../core/errors.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { OPEN_VISIT, jobStatusFromVisits } from "./states.mjs";
import { syncJob, settleVisit, changeVisit, refreshVisits, visitsOfJob, liveContact, visitSummary, W } from "./office.mjs";
import { visitRows } from "./office-schedule.mjs";

const OPEN_ROW = ["scheduled", "en_route", "in_progress", "paused"];
const wctx = (ctx) => (typeof ctx.write === "function" ? ctx.write() : W(ctx));

// The jobs whose rows don't match their visit rows (pure). jobRows: the
// jobs/open index rows; visits: the visit index rows of [from, to]. Only
// what the rows can tell for sure (a visit outside the window may explain
// the rest). → job ids
export function outOfStep(jobRows, visits, from, to) {
  const byJob = new Map();
  for (const v of visits) { if (!byJob.has(v.j)) byJob.set(v.j, []); byJob.get(v.j).push(v); }
  const open = new Map(jobRows.map((r) => [r.id, r]));
  const out = new Set();
  for (const [jid, list] of byJob) {
    const live = list.filter((v) => OPEN_ROW.includes(v.st));
    if (!live.length) continue;
    const row = open.get(jid);
    if (!row || row.st === "unscheduled") { out.add(jid); continue; }      // closed, unknown or "to book" with a live visit
    const next = live.map((v) => v.d).sort()[0];
    if (row.nv !== next && !(row.nv && row.nv < from)) out.add(jid);       // another next visit
    if (row.st !== "in_progress" && jobStatusFromVisits({ status: row.st }, live.map((v) => ({ status: v.st }))) === "in_progress") out.add(jid);
  }
  for (const r of jobRows) {
    // booked for a day in the window with nothing live left there
    if (["scheduled", "in_progress"].includes(r.st) && r.nv && r.nv >= from && r.nv <= to && !(byJob.get(r.id) || []).some((v) => OPEN_ROW.includes(v.st))) out.add(r.id);
  }
  return [...out];
}

// One job brought back in step with its visits. → "synced" | "cancelled" | "guarded" | "same"
export async function repairJob(jobId, w) {
  const got = await getRecord("job", jobId);
  if (!got || got.data.deleted_at) return "same";
  const visits = await visitsOfJob(got.data);
  try {
    if (got.data.status === "cancelled") {
      let n = 0;
      for (const v of visits) if (OPEN_VISIT.includes(v.status)) { await changeVisit(v.id, "cancel", { ctx: w, reason: "job cancelled" }); n += 1; }
      return n ? "cancelled" : "same";
    }
    const before = JSON.stringify([got.data.status, got.data.visit_ids, got.data.schedule]);
    // the visits' own last events, emitted again where a crash lost them (deduped otherwise)
    for (const v of visits) if (v.last_event && v.last_event.wv === v.wv) await settleVisit(v, w, { again: true });
    const after = (await syncJob(jobId, w)).job;
    return JSON.stringify([after.status, after.visit_ids, after.schedule]) === before ? "same" : "synced";
  } catch (e) {
    if (e instanceof ParallelRunGuard) return "guarded";
    throw e;
  }
}

export async function syncSweep(ctx = {}) {
  const today = localDate(now());
  const w = wctx(ctx);
  const from = addLocalDays(today, -31), to = addLocalDays(today, 183);
  const [jobsIx, { rows }] = await Promise.all([readIndex("jobs", "open"), visitRows(from, to)]);
  const ids = outOfStep(jobsIx.rows, rows, from, to).sort().filter((id) => !ctx.cursor || id > ctx.cursor);
  const tally = { synced: 0, cancelled: 0, guarded: 0, same: 0 };
  for (const id of ids) {
    if (ctx.budget && ctx.budget.left() < 6000) return { done: false, cursor: id, progress: tally.synced + tally.cancelled };
    try { tally[await repairJob(id, w)] += 1; } catch (e) { console.error(`crm:work: a job could not be synced (${safeErr(e)})`); }
  }
  return { done: true, progress: tally.synced + tally.cancelled, result: `${tally.synced} synced, ${tally.cancelled} cancelled, ${tally.guarded} left to Rotor` };
}

// The visit rows whose copies differ from the contact and property (one
// read of each). → job ids to refresh
export async function staleCopies(rows) {
  const cids = [...new Set(rows.map((r) => r.c).filter((x) => isId(x, "contact")))];
  const pids = [...new Set(rows.map((r) => r.pr).filter((x) => isId(x, "property")))];
  const [cs, ps] = await Promise.all([getRecords("contact", cids), getRecords("property", pids)]);
  const contacts = new Map(cs.filter(Boolean).map((g) => [g.data.id, g.data]));
  const props = new Map(ps.filter(Boolean).map((g) => [g.data.id, g.data]));
  const out = new Set();
  for (const r of rows) {
    const c = contacts.get(r.c);
    if (!c || c.deleted_at || c.merged_into) continue;
    const want = await visitSummary({ property_id: r.pr }, c, r.pr, { property: props.get(r.pr) });
    const geo = want.geo || null;
    if ((want.contact_name || "") !== (r.cn || "") || (want.town || null) !== (r.town || null) || (want.address_line || null) !== (r.ad || null) || JSON.stringify(geo) !== JSON.stringify(r.geo || null)) out.add(r.j);
  }
  return { jobs: [...out], contacts, props };
}

export async function summariesSweep(ctx = {}) {
  const today = localDate(now());
  const w = wctx(ctx);
  const { rows } = await visitRows(addLocalDays(today, -1), addLocalDays(today, 120));
  const open = rows.filter((r) => OPEN_ROW.includes(r.st) && isId(r.j, "job"));
  const { jobs, contacts, props } = await staleCopies(open);
  let n = 0;
  for (const jid of jobs.sort().filter((id) => !ctx.cursor || id > ctx.cursor)) {
    if (ctx.budget && ctx.budget.left() < 6000) return { done: false, cursor: jid, progress: n };
    try {
      const jg = await getRecord("job", jid);
      if (!jg) continue;
      const contact = contacts.get(jg.data.contact_id) || await liveContact(jg.data.contact_id, w);
      n += await refreshVisits(jid, w, { contact, properties: props });
      // the job's own copy of the name (the jobs list reads it)
      if (contact && contact.display_name && jg.data.contact_name !== contact.display_name) {
        await updateRecord("job", jid, (j) => (j.contact_name === contact.display_name ? null : { ...j, contact_name: contact.display_name }), w);
      }
    } catch (e) {
      if (!(e instanceof ParallelRunGuard)) console.error(`crm:work: visit copies not refreshed (${safeErr(e)})`);
    }
  }
  return { done: true, progress: n, result: `${n} visits refreshed` };
}
