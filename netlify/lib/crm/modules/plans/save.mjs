// Plans module: the Save center (scratchpad simplify/guide-gaps.md S38,
// SP9; the owner's pick Q4: owners cancel right away, anyone else sends a
// request the team tries to save first).
//
//   POST  /plans/:id/cancel-request { reason, note? }   a cancel request (once while one is open)
//   PATCH /plans/:id/cancel-request { status?, offer?, steps_done?, note? }   the team works it
//   GET   /plans/save                                    the open requests, high priority first
//
// Priority is high when the plan has a visit this month or next, or an
// autopay charge on the 1st within 7 days. "saved" closes it and the plan
// goes on; "cancelled" closes it and an owner cancels the plan (the usual
// cancel, with its policy calculator). Only people write here: no sweep.

import { updateRecord, readIndex } from "../../../crm-store.mjs";
import { now, nowIso, localDate, addLocalDays } from "../../core/clock.mjs";
import { InputError, ConflictError } from "../../core/errors.mjs";
import { getPlan } from "./plans.mjs";
import { CANCEL_REASONS, SAVE_STATUSES, SAVE_OFFERS, SAVE_STEPS } from "./types.mjs";

const W = (ctx = {}) => (ctx && typeof ctx.write === "function" ? ctx.write() : { ...(ctx || {}) });
const OPEN = ["open", "contacted", "offered"];
const view = (r) => { if (!r) return r; const { _w, _etag, ...rest } = r; return rest; };
const s = (v) => (v == null ? "" : String(v)).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();

// High priority (pure): a visit due this month or next, or an autopay charge on the 1st within 7 days.
export function savePriority(plan, today) {
  const m = today.slice(0, 7);
  const [y, mo] = m.split("-").map(Number);
  const next = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`;
  const soon = (plan.ordinals || []).some((o) => ["unscheduled", "scheduled"].includes(o.status) && [m, next].includes(o.target_month));
  const charge = !!(plan.billing && plan.billing.autopay) && addLocalDays(today, 7).slice(0, 7) !== m;
  return soon || charge ? "high" : "normal";
}

export async function requestCancel(id, body = {}, ctx = {}) {
  const b = body || {};
  if (!CANCEL_REASONS.includes(b.reason)) throw new InputError("Pick a reason.", "reason");
  const g = await getPlan(id);
  if (!["pending", "active", "paused"].includes(g.data.status)) throw new ConflictError("This plan isn't one that can be cancelled.");
  const had = g.data.cancel_request;
  if (had && OPEN.includes(had.status)) return { plan: view(g.data), existed: true };
  const w = W(ctx);
  const r = await updateRecord("plan", g.data.id, (p) => (p.cancel_request && OPEN.includes(p.cancel_request.status) ? null : {
    ...p, cancel_request: { at: nowIso(), by: w.by || "", reason: b.reason, note: s(b.note).slice(0, 500) || undefined, priority: savePriority(p, localDate(now())), status: "open", steps_done: [] },
  }), w);
  return { plan: view(r.data), existed: false };
}

export async function workSave(id, body = {}, ctx = {}) {
  const b = body || {};
  const g = await getPlan(id);
  const cr = g.data.cancel_request;
  if (!cr || !OPEN.includes(cr.status)) throw new ConflictError("There's no open cancel request on this plan.");
  if (b.status !== undefined && !SAVE_STATUSES.includes(b.status)) throw new InputError("Pick where it stands.", "status");
  if (b.status === "open") throw new InputError("Pick where it stands.", "status");
  if (b.offer !== undefined && b.offer !== null && !SAVE_OFFERS.includes(b.offer)) throw new InputError("Pick an offer.", "offer");
  if (b.steps_done !== undefined && (!Array.isArray(b.steps_done) || b.steps_done.some((k) => !SAVE_STEPS.some(([x]) => x === k)))) throw new InputError("Pick the steps that are done.", "steps_done");
  const w = W(ctx);
  const r = await updateRecord("plan", g.data.id, (p) => {
    const c = { ...(p.cancel_request || {}) };
    if (!OPEN.includes(c.status)) return null;
    if (b.offer !== undefined) { if (b.offer) c.offer = b.offer; else delete c.offer; }
    if (b.steps_done !== undefined) c.steps_done = [...new Set(b.steps_done)];
    if (b.note !== undefined) c.note = s(b.note).slice(0, 500) || undefined;
    if (b.status) {
      c.status = b.status;
      if (["saved", "cancelled"].includes(b.status)) { c.outcome_at = nowIso(); c.outcome_by = w.by || ""; }
    } else if (c.offer && ["open", "contacted"].includes(c.status)) c.status = "offered";
    else if ((c.steps_done || []).length && c.status === "open") c.status = "contacted";
    return { ...p, cancel_request: c };
  }, w);
  return { plan: view(r.data) };
}

// The open requests (the plans index's sr: 2 high, 1 normal), high first.
export async function saveList() {
  const ix = await readIndex("plans", "");
  const rows = ix.rows.filter((r) => r.sr).sort((a, b) => (b.sr || 0) - (a.sr || 0) || String(a.cn).localeCompare(String(b.cn)));
  return { rows, tiles: { open: rows.length, high: rows.filter((r) => r.sr === 2).length } };
}

// plans.reminders (Home's Reminders, guide-gaps S2): Unsigned · Ending · Save requests.
export async function planReminders() {
  const ix = await readIndex("plans", "");
  const today = localDate(now());
  const unsigned = ix.rows.filter((r) => ["pending", "active"].includes(r.st) && ["none", "draft", "sent", "viewed"].includes(r.ag) && !r.im).length;
  const ending = ix.rows.filter((r) => r.st === "active" && r.te && r.te >= today && r.te <= addLocalDays(today, 30) && r.ar === 0).length;
  const save = ix.rows.filter((r) => r.sr).length;
  return { boxes: [{ key: "plans", count: unsigned + ending + save, lists: [{ key: "unsigned", label: "Unsigned", count: unsigned }, { key: "ending", label: "Ending", count: ending }, { key: "save", label: "Save requests", count: save }] }] };
}
