// Barta CRM core: pending actions, the owner's approvals (design §6.9,
// §2.5 "Outbox", §4.12, §9.2 "Approvals").
//
// rec/pending_action/{id} = { kind, title, tool?, args?, args_sha256?,
// key_id?, requested_by, preview: { recipients?, rendered_text?,
// amount_cents? }, items?, status: "pending" | "approved" | "rejected" |
// "expired" | "done" | "failed", expires_at, decided_by?, decided_at?,
// result?, error? }, listed in ix/pending-actions and under
// rel/user-pending/{requested_by}.
//
// - Anything Claude asks to text, email, schedule with a customer notice,
//   charge, refund or cancel through an API key (M7c) becomes a pending
//   action; so does a phone's offline work older than 6 days
//   (POST /outbox-review, kind "outbox_review").
// - An owner (pending_actions:approve) approves or rejects with one tap.
//   On approval of a kind that has an executor (definePendingKind(kind,
//   { run })), the fast lane runs it with the APPROVER as the actor and
//   the requester recorded (queue kind "pending.run", marker
//   done/pending/{id}); a kind without one (outbox_review) is simply done:
//   the office acts on each item by hand.
// - Past expires_at (24 h by default) an action can no longer be approved.
// - An approval is never lost between its two writes (status, then the
//   queue item): approving an action that is already "approved" but whose
//   marker is not final queues it again, and the hourly pending.requeue
//   sweep does the same for any it finds. The marker keeps it to one run.

import { createHash } from "node:crypto";
import { createRecord, updateRecord, getRecord, readIndex, getRaw } from "../../crm-store.mjs";
import { nowIso, nowMs } from "./clock.mjs";
import { isId } from "./ids.mjs";
import { InputError, NotFoundError, ConflictError, RegistryError } from "./errors.mjs";
import { enqueue } from "./queue.mjs";
import { allModules } from "./registry.mjs";
import { safeErr } from "../../referral-lib.mjs";
import { notify, approvers } from "./notify.mjs";

export const PENDING_STATUSES = Object.freeze(["pending", "approved", "rejected", "expired", "done", "failed"]);
export const DEFAULT_EXPIRES_HOURS = 24;
export const OUTBOX_REVIEW = "outbox_review";
export const MAX_REVIEW_ITEMS = 200;

const kinds = new Map([[OUTBOX_REVIEW, { kind: OUTBOX_REVIEW, label: "Offline work to review", run: null }]]);
// A kind of pending action and, optionally, what approving it runs:
// run(action, ctx) → result (ctx.by is the approver, ctx.requested_by the requester).
export function definePendingKind(kind, { label, run } = {}) {
  if (typeof kind !== "string" || !/^[a-z][a-z0-9_.-]{1,40}$/.test(kind)) throw new RegistryError(`pending kind ${kind}: bad name`);
  if (run !== undefined && run !== null && typeof run !== "function") throw new RegistryError(`pending kind ${kind}: run must be a function`);
  kinds.set(kind, { kind, label: label || kind, run: run || null });
}
export const pendingKind = (kind) => kinds.get(kind) || null;

const sha = (v) => createHash("sha256").update(JSON.stringify(v ?? null)).digest("hex");
const expired = (a, t = nowMs()) => a.status === "pending" && !(Date.parse(a.expires_at) > t);

// What the API shows (args stay server-side; the preview is what the owner judges).
export const pendingView = (a) => ({
  id: a.id, kind: a.kind, title: a.title, status: expired(a) ? "expired" : a.status, requested_by: a.requested_by,
  preview: a.preview || null, items: Array.isArray(a.items) ? a.items.length : undefined, tool: a.tool || null,
  created_at: a.created_at, expires_at: a.expires_at, decided_by: a.decided_by || null, decided_at: a.decided_at || null,
  result: a.result ?? null, error: a.error || null,
});

export async function createPendingAction({ kind, title, tool, args, key_id, preview, items, expires_hours = DEFAULT_EXPIRES_HOURS, requested_by } = {}, ctx = {}) {
  if (!pendingKind(kind)) throw new InputError("That kind of approval doesn't exist.", "kind");
  const hours = Math.min(24 * 14, Math.max(1, Number(expires_hours) || DEFAULT_EXPIRES_HOURS));
  const rec = await createRecord("pending_action", {
    kind, title: String(title || pendingKind(kind).label).slice(0, 120), status: "pending",
    ...(tool ? { tool: String(tool).slice(0, 60) } : {}), ...(args !== undefined ? { args, args_sha256: sha(args) } : {}),
    ...(key_id ? { key_id } : {}), preview: preview || null, ...(items ? { items } : {}),
    requested_by: requested_by || ctx.by || "system", expires_at: new Date(nowMs() + hours * 3600000).toISOString(),
  }, ctx);
  // the owners hear about it (push + the bell), one queue item for all of them
  try {
    const who = await approvers();
    if (who.length) await notify(who, { kind: "approval", title: "Waiting for your OK", body: rec.data.title, link: "/approvals" }, ctx);
  } catch (e) {
    console.error(`crm:pending: the owners were not notified (${safeErr(e)})`);
  }
  return rec.data;
}

// ix/pending-actions rows, newest first; status "pending" hides expired ones.
export async function listPendingActions({ status = "pending" } = {}) {
  const ix = await readIndex("pending-actions", "");
  const t = nowMs();
  return ix.rows
    .map((r) => ({ ...r, st: r.st === "pending" && !(Date.parse(r.exp) > t) ? "expired" : r.st }))
    .filter((r) => !status || status === "all" || r.st === status)
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .map((r) => ({ id: r.id, kind: r.k, title: r.t, status: r.st, requested_by: r.by, created_at: r.at, expires_at: r.exp }));
}

export async function getPendingAction(id) {
  if (!isId(id, "pending_action")) throw new NotFoundError("That approval isn't there.");
  const got = await getRecord("pending_action", id);
  if (!got) throw new NotFoundError("That approval isn't there.");
  return got.data;
}

// Approve or reject (owner). Approving an action with an executor queues
// it for the fast lane; one without is done at once.
const RUN_MARKER = (id) => ({ ns: "done", scope: "pending", key: id });
const queueRun = (id) => enqueue("pending.run", { type: "pending_action", id }, { status: "approved" }, new Date(nowMs()), RUN_MARKER(id));
async function runIsQueuedOrDone(id) {
  const m = await getRaw(`done/pending/${id}`);
  return !!(m && m.data);
}

export async function decidePendingAction(id, decision, ctx) {
  if (!["approve", "reject"].includes(decision)) throw new InputError("Approve or reject.", "decision");
  const a = await getPendingAction(id);
  // approved but its run never got queued (the request died after the
  // status write): approving again queues it now
  if (a.status === "approved" && decision === "approve" && !(await runIsQueuedOrDone(id))) {
    await queueRun(id);
    return a;
  }
  if (expired(a)) throw new ConflictError("This approval expired. Ask for it again.");
  if (a.status !== "pending") throw new ConflictError("This was already decided.");
  const k = pendingKind(a.kind);
  const by = ctx.user ? ctx.user.id : "system";
  const next = decision === "reject" ? "rejected" : k && k.run ? "approved" : "done";
  const r = await updateRecord("pending_action", id, (x) => (x.status !== "pending" ? null : { ...x, status: next, decided_by: by, decided_at: nowIso() }), ctx.write());
  if (r.data.decided_by !== by || r.data.status !== next) throw new ConflictError("This was already decided.");
  if (next === "approved") await queueRun(id);
  return r.data;
}

// The pending.requeue sweep: approved actions decided more than
// REQUEUE_AFTER_MS ago whose run has no marker yet. → how many were queued.
export const REQUEUE_AFTER_MS = 10 * 60 * 1000;
export async function requeueApproved() {
  const ix = await readIndex("pending-actions", "");
  let n = 0;
  for (const r of ix.rows.filter((x) => x.st === "approved")) {
    if (await runIsQueuedOrDone(r.id)) continue;
    const got = await getRecord("pending_action", r.id);
    const a = got && got.data;
    if (!a || a.status !== "approved" || !(Date.parse(a.decided_at) + REQUEUE_AFTER_MS < nowMs())) continue;
    await queueRun(r.id);
    n += 1;
  }
  return n;
}

// Queue kind "pending.run": runs an approved action once, as the approver.
export async function runApprovedAction(h) {
  const id = h.item.subject && h.item.subject.id;
  const got = isId(id, "pending_action") ? await getRecord("pending_action", id) : null;
  const a = got && got.data;
  if (!a || a.status !== "approved") return { result: "skipped:changed" };
  const k = pendingKind(a.kind);
  const wctx = { by: a.decided_by, origin: "api", actor_kind: "user", requestId: h.ctx.requestId, requested_by: a.requested_by, approved_action: a.id };
  let status = "done";
  let result = null;
  let error = null;
  try {
    result = k && k.run ? await k.run(a, { ...h, write: (extra = {}) => ({ ...wctx, ...extra }), approver: a.decided_by }) : null;
  } catch (e) {
    console.error(`crm:pending: an approved action failed (${safeErr(e)})`);
    status = "failed";
    error = { code: String((e && (e.code || e.name)) || "error").slice(0, 40) };
  }
  await updateRecord("pending_action", id, (x) => (x.status !== "approved" ? null : { ...x, status, result: result ?? null, ...(error ? { error } : {}), ran_at: nowIso() }), wctx);
  return { result: status };
}

// The Approvals count for a person (GET /me/badges): pending actions they
// may approve plus every module's approvals rows ({ perm, count(ctx) }).
export async function approvalsCount(ctx) {
  let n = 0;
  if (ctx.can("pending_actions:approve")) n += (await listPendingActions({ status: "pending" })).length;
  for (const m of allModules()) {
    for (const a of m.approvals || []) {
      if (!a || typeof a.count !== "function" || (a.perm && !ctx.can(a.perm))) continue;
      try { n += Math.max(0, Number(await a.count(ctx)) || 0); } catch { /* a module's count never breaks the badge */ }
    }
  }
  return n;
}

// POST /outbox-review: a phone's offline items older than 6 days, stored
// as one pending action for the office (§2.5).
export async function outboxReview(ctx, items) {
  if (!Array.isArray(items) || !items.length) throw new InputError("Nothing to review.", "items");
  if (items.length > MAX_REVIEW_ITEMS) throw new InputError("Too many items at once.", "items");
  const clean = items.map((it, i) => {
    if (!it || typeof it !== "object" || Array.isArray(it)) throw new InputError("Each item must be an object.", `items.${i}`);
    const out = {
      method: String(it.method || "POST").toUpperCase().slice(0, 6), path: String(it.path || "").slice(0, 200),
      queued_at: typeof it.queued_at === "string" ? it.queued_at.slice(0, 40) : null, client_at: typeof it.client_at === "string" ? it.client_at.slice(0, 40) : null,
      idempotency_key: typeof it.idempotency_key === "string" ? it.idempotency_key.slice(0, 100) : null,
    };
    if (!/^\/[a-z0-9/_.-]*$/i.test(out.path)) throw new InputError("That item's path isn't valid.", `items.${i}.path`);
    if (it.body !== undefined) {
      const body = JSON.stringify(it.body);
      if (body.length > 8000) throw new InputError("That item is too big.", `items.${i}.body`);
      out.body = it.body;
    }
    return out;
  });
  return createPendingAction({ kind: OUTBOX_REVIEW, title: `${clean.length} offline ${clean.length === 1 ? "change" : "changes"} to review`, items: clean, requested_by: ctx.user.id, expires_hours: 24 * 14 }, ctx.write());
}
