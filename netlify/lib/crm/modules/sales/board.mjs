// Sales module: the Leads board and moving a pipeline card to any stage
// (guide-gaps S13, S14).
//
//   GET  /leads                       every lead with its stage (stored by
//        hand or by the import, else derived: contacts/leadstage.mjs), the
//        open deal's value, the follow-up's next due day, the last touch.
//        One read of three indexes. → { data: rows, meta: { counts } }
//   POST /enrollments/:id/move { step } a card to any stage: a step
//        cadence plans that step (the steps skipped send nothing), a board
//        (Rotor's board-only pipelines) just changes stage. Logged in the
//        history as moved_by_hand. An imported follow-up stays Rotor's
//        until the switch (409 parallel_run): only CRM-made ones move now.

import { readIndex } from "../../../crm-store.mjs";
import { nowIso } from "../../core/clock.mjs";
import { InputError, ConflictError } from "../../core/errors.mjs";
import { guardFor } from "../../core/context.mjs";
import { readSysMode } from "../../core/settings.mjs";
import { contactShard } from "../../core/stats.mjs";
import { fail } from "../../core/http.mjs";
import { deriveLeadStage, LEAD_STAGES } from "../contacts/leadstage.mjs";
import { withStep, isOpen, stepIdAt } from "./cadence.mjs";
import { changeEnrollment } from "./enroll.mjs";
import { W } from "./common.mjs";
import { MAX_HISTORY } from "./types.mjs";

const later = (a, b) => (!a ? b || null : !b ? a : a > b ? a : b);

// The Leads list and board rows (pure). ix: contacts index rows; deals: the open deals index; enr: the open follow-ups.
export function leadRows(ix = [], deals = [], enr = []) {
  const deal = new Map();
  for (const d of deals) if (d.c && !deal.has(d.c)) deal.set(d.c, d);
  const fol = new Map();
  for (const e of enr) if (e.c && (!fol.has(e.c) || String(e.due || "9") < String(fol.get(e.c).due || "9"))) fol.set(e.c, e);
  const rows = [];
  for (const r of ix) {
    if (r.lc !== "lead") continue;
    const d = deal.get(r.id) || null;
    const e = fol.get(r.id) || null;
    rows.push({
      id: r.id, n: r.n || "", p: (r.p || [])[0] || null, src: r.src || "", pr: r.pr || null, o: r.o || null, ca: r.ca || null, tg: r.tg || [],
      c: r.c || "", lt: later(r.slc, r.lca), stage: deriveLeadStage(r, { deal: d, enrollment: e }), hand: !!r.lst, sa: r.lsa || null,
      pv: d && Number.isSafeInteger(d.v) ? d.v : null, deal: d ? d.id : null, deal_st: d ? d.st : null,
      enr: e ? e.id : null, follow: e && e.due ? e.due : null, paused: !!e && e.st === "paused", step: e ? e.lbl || "" : "",
    });
  }
  return rows;
}

async function leadsRoute() {
  const [ix, deals, enr] = await Promise.all([
    readIndex("contacts", contactShard("ct_00000000000000000000")), readIndex("deals/open", ""), readIndex("enrollments/active", ""),
  ]);
  const rows = leadRows(ix.rows, deals.rows, enr.rows);
  const counts = Object.fromEntries(LEAD_STAGES.map((k) => [k, 0]));
  for (const r of rows) counts[r.stage] += 1;
  return { data: rows, meta: { counts, total: rows.length, stale: !!ix.stale } };
}

// One card to stage n (pure). → the enrollment, or null when it is already there.
export function moveTo(e, cadence, n, { by, env }) {
  if (!isOpen(e)) throw new ConflictError("This follow-up has ended.");
  const board = !!(cadence && cadence.board_only);
  const names = board ? cadence.board_stages || [] : (cadence && cadence.steps) || [];
  if (!Number.isSafeInteger(n) || n < 1 || n > names.length) throw new InputError("Pick one of the stages.", "step");
  if (e.step_n === n) return null;
  const at = nowIso();
  const sid = board ? null : e.step_id || stepIdAt(cadence, (e.step_n || 1) - 1);
  const history = [...(e.history || []), { n: e.step_n || 0, ...(sid ? { sid } : {}), at, action: "moved_by_hand", to: n, by }].slice(-MAX_HISTORY);
  if (board) {
    const next = { ...e, history, step_n: n, cur: { label: names[n - 1] } };
    delete next.next_due_at; delete next.due_end; delete next.pending;
    return next;
  }
  return withStep({ ...e, history }, cadence, n, env);
}

async function moveRoute(ctx) {
  const n = Number((ctx.body || {}).step);
  if (!Number.isSafeInteger(n)) throw new InputError("Pick one of the stages.", "step");
  let imported = false;
  const mode = await readSysMode();
  const r = await changeEnrollment(ctx.params.id, (e, c, env) => {
    if (e.rotor && !guardFor(mode).mayAct({ record: e })) { imported = true; return null; }
    return moveTo(e, c, n, { by: W(ctx).by, env });
  }, ctx, { action: "move" });
  if (imported) return fail("parallel_run", "Rotor is still in charge of this one until the switch. Move it in Rotor.", 409);
  return { data: { moved: !!r.changed, step_n: r.data.step_n } };
}

const R = (method, path, perm, subject, handler, extra = {}) => ({ method, path, auth: "session", perm, subject, mode: "inline", handler, ...extra });

export const boardRoutes = [
  R("GET", "/leads", "sales:work", "none", leadsRoute, { maxCalls: 20 }),
  R("POST", "/enrollments/:id/move", "sales:work", "required", moveRoute, { maxCalls: 40 }),
];
