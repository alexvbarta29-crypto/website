// Work module, office part: the rain-day move (design §5.5 "Rain day", B14).
//
//   POST /schedule/move-day { from_date, to_date, filter: { service_types?,
//   assignee_ids? }, notify }                → the preview: the visits that
//        would move (booked visits that day matching the filter), the
//        customers who would be told, and a token naming exactly that list
//   ... with { confirm: true, token }        → a bulk-lane run of the op
//        moveday--{from_date}--{n}: each visit moves to the new date keeping
//        its times (moved_by_op set, so visit.confirm stays quiet), each tech
//        gets one push, and the customers' notices (template
//        visit_weather_move) become a bulk run that waits for its test send
//        and an owner's or the office's confirm (§5.7.4).
//
// n counts the moves already made from that date, so a later move of the
// same day is a new op while a double tap (same preview token) is the same
// run. A preview that no longer matches the schedule (someone moved a visit
// meanwhile) is refused: look again.

import { createHash } from "node:crypto";
import { getRecord, getRecords, listRel, addRel, readIndex, readPointer, claimPointer } from "../../../crm-store.mjs";
import { deriveId, isId } from "../../core/ids.mjs";
import { now, nowIso, tsKey, localDate, isLocalDate } from "../../core/clock.mjs";
import { InputError, ConflictError } from "../../core/errors.mjs";
import { defineOp, runOp, opIdFor, readOp } from "../../core/ops.mjs";
import { defineRun, createRun, runView } from "../../core/lanes.mjs";
import { notify } from "../../core/notify.mjs";
import { claimMarker, advanceMarker } from "../../../crm-store.mjs";
import { createBulkRun } from "../../core/bulk.mjs";
import { keySafe } from "../../core/text.mjs";
import { visitRows, visitVars, dateText, hoursOn, calendarEnv } from "./office-schedule.mjs";
import { changeVisit } from "./office.mjs";

export const MOVE_MAX = 80;
const str = (v) => (v == null ? "" : String(v)).trim();

function cleanBody(b = {}) {
  const from = str(b.from_date), to = str(b.to_date);
  if (!isLocalDate(from)) throw new InputError("Pick the day to move.", "from_date");
  if (!isLocalDate(to)) throw new InputError("Pick the day to move to.", "to_date");
  if (from === to) throw new InputError("Pick another day to move to.", "to_date");
  if (to < localDate(now())) throw new InputError("Pick a day that hasn't gone by.", "to_date");
  const f = b.filter && typeof b.filter === "object" ? b.filter : {};
  const service_types = Array.isArray(f.service_types) ? [...new Set(f.service_types.map(str).filter(Boolean))].slice(0, 10) : [];
  const assignee_ids = Array.isArray(f.assignee_ids) ? [...new Set(f.assignee_ids.filter((x) => isId(x, "user")))].slice(0, 10) : [];
  return { from, to, filter: { service_types, assignee_ids }, notify: b.notify !== false };
}

const matches = (row, filter) => (!filter.service_types.length || (row.svc || []).some((s) => filter.service_types.some((t) => String(s).toLowerCase().startsWith(t.toLowerCase()))))
  && (!filter.assignee_ids.length || (row.a || []).some((u) => filter.assignee_ids.includes(u)));

// The preview (no writes). → { from_date, to_date, n, token, visits, customers, techs, notify, warnings }
export async function moveDayPreview(body) {
  const b = cleanBody(body);
  const [{ rows }, env] = await Promise.all([visitRows(b.from, b.from), calendarEnv()]);
  const visits = rows.filter((r) => r.st === "scheduled" && matches(r, b.filter)).sort((a, c) => String(a.s).localeCompare(String(c.s)) || (a.id < c.id ? -1 : 1));
  if (visits.length > MOVE_MAX) throw new InputError(`That's more than ${MOVE_MAX} visits. Narrow it down by tech or service.`, "filter");
  // the token names exactly this list as it is now: once the visits move, a new preview has another
  const token = createHash("sha256").update(JSON.stringify([b.from, b.to, b.filter, b.notify, visits.map((r) => [r.id, r.u])])).digest("hex").slice(0, 20);
  const contacts = [...new Map(visits.map((r) => [r.c, { id: r.c, name: r.cn }])).values()];
  const warnings = hoursOn(b.to, env.hours, env.calendar) ? [] : [{ code: "closed", message: `We're closed on ${dateText(b.to)}.` }];
  return {
    from_date: b.from, to_date: b.to, filter: b.filter, notify: b.notify, token, warnings,
    visits: visits.map((r) => ({ id: r.id, contact_id: r.c, contact_name: r.cn, town: r.town, start: r.s, end: r.e, window: r.w, assignee_ids: r.a || [], job_number: r.jn, service_types: r.svc || [] })),
    customers: b.notify ? contacts : [], techs: [...new Set(visits.flatMap((r) => r.a || []))],
  };
}

export const moveOpId = (from, n) => opIdFor(`moveday--${from}`, n);

// The confirm: the run (bulk lane) of the op. → the run record.
export async function moveDayConfirm(body, ctx) {
  const token = str(body.token);
  // a double tap (the same preview) answers the run the first tap started
  const had = /^[0-9a-f]{20}$/.test(token) ? await readPointer("moveday-token", token) : null;
  if (had && isId(had.run_id, "run")) {
    const got = await getRecord("run", had.run_id);
    if (got) return got.data;
  }
  const p = await moveDayPreview(body);
  if (token !== p.token) throw new ConflictError("The schedule changed since you looked. Check the list again, then move.");
  if (!p.visits.length) throw new InputError("There's nothing to move that day.", "from_date");
  const done = await listRel("work-moveday", p.from_date, { limit: 100 });
  const op = moveOpId(p.from_date, done.length + 1);
  const runId = deriveId("run", op, "work.moveday", token);
  const claim = await claimPointer("moveday-token", token, { id: runId, run_id: runId, op });
  if (!claim.ok && claim.current && claim.current.run_id) {
    const got = await getRecord("run", claim.current.run_id);
    if (got) return got.data;
  }
  const w = ctx.write();
  const run = await createRun("work.moveday", {
    op, from: p.from_date, to: p.to_date, visit_ids: p.visits.map((v) => v.id), notify: p.notify, requested_by: w.by,
  }, w, { id: runId });
  await addRel("work-moveday", p.from_date, tsKey(now()), op).catch(() => {});
  return run;
}

// ------------------------------------------------------------ the op

async function existingNotice(op) {
  const ix = await readIndex("bulk-runs", "");
  const row = ix.rows.find((r) => r.k === op);
  return row ? row.id : null;
}

defineOp("work.moveday", {
  lane: "bulk",
  steps: (input) => [
    {
      name: "move",
      async run(s) {
        const moved = [];
        const skipped = [];
        for (const id of input.visit_ids || []) {
          const got = isId(id, "visit") ? await getRecord("visit", id) : null;
          const v = got && got.data;
          if (v && v.date === input.to && v.moved_by_op === s.opId) { moved.push({ id, contact_id: v.contact_id, assignee_ids: v.assignee_ids || [] }); continue; }
          if (!v || v.status !== "scheduled" || v.date !== input.from) { skipped.push(id); continue; }
          const r = await changeVisit(id, "reschedule", { patch: { date: input.to, moved_by_op: s.opId }, keepMove: true, ctx: s.ctx });
          moved.push({ id, contact_id: r.visit.contact_id, assignee_ids: r.visit.assignee_ids || [] });
        }
        return { moved, skipped };
      },
    },
    {
      name: "push",
      async run(s) {
        const moved = (s.out.move && s.out.move.moved) || [];
        const per = new Map();
        for (const m of moved) for (const u of m.assignee_ids) per.set(u, (per.get(u) || 0) + 1);
        let pushed = 0;
        for (const [uid, count] of per) {
          const claim = await claimMarker("done", "moveday-push", `${keySafe(s.opId, 100)}--${uid}`, { holder: s.opId, leaseMs: 60000 });
          if (!claim.ok) continue;
          await notify([uid], { kind: "visit_changed", title: "Visits moved", body: `${count === 1 ? "1 of your visits" : `${count} of your visits`} moved from ${dateText(input.from)} to ${dateText(input.to)}.`, link: `/schedule?date=${input.to}` }, s.ctx);
          await advanceMarker(claim.marker, { state: "done", result: "pushed" });
          pushed += 1;
        }
        return { pushed };
      },
    },
    {
      name: "notice",
      async run(s) {
        const moved = (s.out.move && s.out.move.moved) || [];
        if (!input.notify || !moved.length) return { bulk_run_id: null, moved: moved.length, skipped: ((s.out.move && s.out.move.skipped) || []).length };
        let id = await existingNotice(s.opId);
        if (!id) {
          const env = await calendarEnv();
          const visits = (await getRecords("visit", moved.map((m) => m.id))).filter(Boolean).map((g) => g.data);
          const per = {};
          for (const v of visits) if (!per[v.contact_id]) per[v.contact_id] = visitVars(v, env.hours);
          const b = await createBulkRun({
            kind: s.opId, title: `Weather move: ${dateText(input.from)} to ${dateText(input.to)}`, recipients: Object.keys(per), template_key: "visit_weather_move", channel: "sms",
            per_recipient_vars: per, related: {}, requested_by: input.requested_by || s.ctx.by || "system",
          }, s.ctx);
          id = b.id;
        }
        return { bulk_run_id: id, moved: moved.length, skipped: ((s.out.move && s.out.move.skipped) || []).length };
      },
    },
  ],
});

// The person who confirmed: a rain-day move is a human action (exempt from the parallel-run guard).
const personCtx = (run, rctx) => ({ by: run.input.requested_by || run.requested_by || "system", origin: "api", actor_kind: isId(run.input.requested_by || run.requested_by, "user") ? "user" : "automation", requestId: rctx.holder || "moveday", ...(rctx.mode ? { mode: rctx.mode } : {}) });

async function moveStep(run, rctx) {
  const input = run.input || {};
  let out;
  try {
    out = await runOp(input.op, "work.moveday", { input, ctx: personCtx(run, rctx), holder: `moveday.${run.id}`, resume: true });
  } catch (e) {
    const j = await readOp(input.op).catch(() => null);
    if (!j || j.status !== "failed") throw e;
    out = { status: "failed", error: j.error || null };
  }
  if (out.status === "done") return { done: true, result: out.result, progress: { done: 1, total: 1 } };
  if (out.status === "failed") return { failed: (out.error && out.error.code) || "failed" };
  return { progress: { done: 0, total: 1 } };
}
defineRun("work.moveday", { lane: "bulk", step: moveStep, label: "Move a rain day" });

export { runView, nowIso };
