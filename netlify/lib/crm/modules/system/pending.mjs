// Core "system" module: approvals (design §4.12, §6.9, §2.5).
//
//   GET  /pending-actions[?status=]          pending_actions:approve   the list (pending by default)
//   GET  /pending-actions/:id                pending_actions:approve   one, with its preview
//   POST /pending-actions/:id/approve        pending_actions:approve   runs it (as the approver) or marks it done
//   POST /pending-actions/:id/reject         pending_actions:approve
//   POST /outbox-review {items}              visits:work               a phone's offline work older than 6 days,
//                                                                      stored as one pending action for the office

import { listPendingActions, getPendingAction, decidePendingAction, pendingView, outboxReview } from "../../core/pending.mjs";
import { InputError } from "../../core/errors.mjs";

const STATUSES = new Set(["pending", "approved", "rejected", "expired", "done", "failed", "all"]);

async function list(ctx) {
  const status = ctx.query.get("status") || "pending";
  if (!STATUSES.has(status)) throw new InputError("Pick a status.", "status");
  return { data: await listPendingActions({ status }) };
}
async function one(ctx) {
  return { data: pendingView(await getPendingAction(ctx.params.id)) };
}
const decide = (decision) => async (ctx) => ({ data: pendingView(await decidePendingAction(ctx.params.id, decision, ctx)) });
async function review(ctx) {
  const a = await outboxReview(ctx, ctx.body && ctx.body.items);
  return { status: 201, data: { pending_action_id: a.id } };
}

const r = (method, path, perm, subject, handler, more = {}) => ({ method, path, auth: "session", perm, subject, mode: "inline", handler, ...more });
export const pendingRoutes = [
  r("GET", "/pending-actions", "pending_actions:approve", "none", list),
  r("GET", "/pending-actions/:id", "pending_actions:approve", "required", one),
  r("POST", "/pending-actions/:id/approve", "pending_actions:approve", "required", decide("approve")),
  r("POST", "/pending-actions/:id/reject", "pending_actions:approve", "required", decide("reject")),
  r("POST", "/outbox-review", "visits:work", "required", review, { replaySafe: true, maxBody: 512 * 1024 }),
];
