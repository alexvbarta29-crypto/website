// Plans module: "Request signatures for N plans" (design §5.4, §10.2 row 21,
// decision D10). Imported active plans have no signature on file (Rotor
// doesn't expose signed agreements); when the owner wants them, Settings →
// Plans (or the Plans list) asks for them in one go. It is always a bulk run
// (§5.7.4): a preview, a test send and an owner's confirm before anything
// goes out, and then, before cutover, only to the Outbox.
//
// A run on the fast lane ("plans.request_signatures"), checkpointed: each
// plan gets its agreement from the approved template (a plan whose template
// isn't approved yet, or that is already signed, is skipped and counted);
// then one link per person (scope agreement, 30 days) goes into the bulk
// run's per-person variables; then the agreements are marked sent with the
// bulk run's id (their reminders wait until that run went out).

import { createHash } from "node:crypto";
import { getRecord, updateRecord } from "../../../crm-store.mjs";
import { deriveId, isId } from "../../core/ids.mjs";
import { now, localDate, addLocalDays, zonedToUtc } from "../../core/clock.mjs";
import { InputError, ConflictError, NotFoundError } from "../../core/errors.mjs";
import { defineRun, createRun } from "../../core/lanes.mjs";
import { has, call } from "../../core/services.mjs";
import { createPortalLink } from "../../portal/core.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { agreementForPlan, notePlanAgreement } from "./agreements.mjs";

const W = (ctx = {}) => (ctx && typeof ctx.write === "function" ? ctx.write() : { ...(ctx || {}) });
export const MAX_REQUEST = 500;
const PER_STEP = 15;

export async function startRequestSignatures(planIds, ctx) {
  const ids = [...new Set(Array.isArray(planIds) ? planIds : [])];
  if (!ids.length) throw new InputError("Pick the plans.", "plan_ids");
  if (ids.length > MAX_REQUEST) throw new InputError(`At most ${MAX_REQUEST} plans at once.`, "plan_ids");
  if (ids.some((x) => !isId(x, "plan"))) throw new InputError("That isn't a plan.", "plan_ids");
  if (!has("bulk.create")) throw new ConflictError("Bulk sends aren't available.", { code: "not_available" });
  const key = createHash("sha256").update([...ids].sort().join(",")).digest("hex").slice(0, 16);
  const runId = deriveId("run", `sigreq--${key}--${localDate(now())}`, "plans.request_signatures", 0);
  const run = await createRun("plans.request_signatures", { plan_ids: ids }, W(ctx), { id: runId });
  return { run_id: run.id, plans: ids.length };
}

const personCtx = (run, rctx) => ({ by: run.requested_by || "system", origin: "api", actor_kind: isId(run.requested_by, "user") ? "user" : "automation", requestId: rctx.holder || "plans", ...(rctx.mode ? { mode: rctx.mode } : {}) });

async function step(run, rctx) {
  const ctx = personCtx(run, rctx);
  const ids = (run.input && run.input.plan_ids) || [];
  const cp = run.checkpoint || { phase: "agreements", i: 0, made: [], skipped: {} };
  const skip = (why) => { cp.skipped[why] = (cp.skipped[why] || 0) + 1; };
  if (cp.phase === "agreements") {
    const end = Math.min(ids.length, cp.i + PER_STEP);
    for (; cp.i < end; cp.i += 1) {
      const id = ids[cp.i];
      const g = await getRecord("plan", id).catch(() => null);
      const plan = g && g.data;
      if (!plan || plan.deleted_at || !["active", "pending", "paused", "cancelling"].includes(plan.status)) { skip("not_live"); continue; }
      if (plan.agreement_status === "signed") { skip("signed"); continue; }
      if (cp.made.some((m) => m.contact_id === plan.contact_id)) { skip("same_person"); continue; }
      try {
        const r = await agreementForPlan(plan.id, { client_id: `${run.id}-${plan.id}` }, ctx);
        if (!["draft", "sent", "viewed"].includes(r.data.status)) { skip("not_open"); continue; }
        cp.made.push({ contact_id: plan.contact_id, agreement_id: r.data.id, plan_name: plan.name });
      } catch (e) {
        if (e instanceof ConflictError) { skip(e.code === "template_not_approved" ? "template_not_approved" : e.code === "signed" ? "signed" : "no_template"); continue; }
        if (e instanceof NotFoundError) { skip("not_found"); continue; }
        throw e;
      }
    }
    if (cp.i < ids.length) return { checkpoint: cp, progress: { done: cp.i, total: ids.length } };
    cp.phase = "bulk";
  }
  if (cp.phase === "bulk") {
    if (!cp.made.length) return { done: true, result: { requested: 0, skipped: cp.skipped }, checkpoint: cp };
    const per = {};
    const until = zonedToUtc(addLocalDays(localDate(now()), 30), "23:59").toISOString();
    for (const m of cp.made) {
      const link = await createPortalLink({ contact_id: m.contact_id, scope: { kind: "agreement", id: m.agreement_id }, expires_at: until, created_by: "automation:request_signatures" });
      per[m.contact_id] = { agreement_link: link.url, plan_name: m.plan_name };
    }
    cp.bulk_run_id = await call("bulk.create", {
      kind: "plans.request_signatures", title: `Agreements to sign (${cp.made.length})`, recipients: cp.made.map((m) => m.contact_id), template_key: "agreement_sent", channel: "sms",
      per_recipient_vars: per, related: { kind: "agreements" }, requested_by: ctx.by,
    }, ctx);
    cp.phase = "mark";
    cp.j = 0;
    return { checkpoint: cp, progress: { done: ids.length, total: ids.length } };
  }
  // mark: the agreements are sent through that bulk run
  const end = Math.min(cp.made.length, (cp.j || 0) + PER_STEP);
  for (; cp.j < end; cp.j += 1) {
    const m = cp.made[cp.j];
    try {
      const r = await updateRecord("agreement", m.agreement_id, (a) => (a.bulk_run_id === cp.bulk_run_id || !["draft", "sent", "viewed"].includes(a.status) ? null : { ...a, status: a.status === "viewed" ? "viewed" : "sent", sent_at: now().toISOString(), sent_via: ["sms"], bulk_run_id: cp.bulk_run_id }), ctx);
      if (r.data.plan_id) await notePlanAgreement(r.data.plan_id, r.data, ctx);
    } catch (e) { console.error(`crm:plans: an agreement wasn't marked sent (${safeErr(e)})`); }
  }
  if (cp.j < cp.made.length) return { checkpoint: cp, progress: { done: ids.length, total: ids.length } };
  return { done: true, result: { requested: cp.made.length, skipped: cp.skipped, bulk_run_id: cp.bulk_run_id }, checkpoint: cp, progress: { done: ids.length, total: ids.length } };
}

defineRun("plans.request_signatures", { lane: "fast", step, label: "Request agreement signatures" });
