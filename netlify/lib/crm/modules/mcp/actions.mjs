// MCP module (M7c): what a write through Claude becomes (design §6.9, §4.9).
//
// No model-only confirmation: every tool that changes something (effect
// "write", "contact" or "money") creates a PENDING ACTION and nothing else.
// An owner approves or rejects it with one tap (Approvals); on approval the
// fast lane runs it once with the APPROVER as the actor and the key's user
// as requested_by (core/pending.mjs, queue kind "pending.run").
//
//   requestAction(tool, args, ctx)   → { status: "waiting_for_approval", pending_action_id, ... }
//   pending kind "mcp.tool"          → runs the tool's executor as the approver
//
// Confirm tokens (staff-side destructive tools without customer contact:
// cancel_job, archive_contact): the first call previews and returns a
// token bound to { tool, sha256(args), key_id } (10 minutes, single use,
// done/mcp-confirm/{sha256(token)}); only a call that brings the token back
// with the same arguments, from the same key, goes on to the approval. A
// token replayed with other arguments or from another key is refused.
//
// Asks are rate limited per key: ASK_PER_HOUR approvals an hour
// (thr/mcp-ask/{keyId}/{tsKey}-{rand}; the nightly auth sweep deletes them).

import { createHash, randomBytes } from "node:crypto";
import { getRaw, putRaw, settledWrite, listKeys } from "../../../crm-store.mjs";
import { createPendingAction, definePendingKind, getPendingAction, pendingView } from "../../core/pending.mjs";
import { nowMs, nowIso, tsKey } from "../../core/clock.mjs";
import { RateLimited, ForbiddenError, InputError } from "../../core/errors.mjs";
import { approverCtx } from "./invoke.mjs";

export const PENDING_KIND = "mcp.tool";
export const ASK_PER_HOUR = 20;
export const CONFIRM_TTL_MS = 10 * 60 * 1000;

const sha = (v) => createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(v ?? null)).digest("hex");
// The arguments as the tool will run them: keys sorted, so { a, b } and { b, a } are one request.
export function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]));
  return v;
}
export const argsHash = (args) => sha(canonical(args || {}));
const keyIdOf = (ctx) => String((ctx.apiKey && (ctx.apiKey.id || ctx.apiKey.hash)) || "key").replace(/[^a-z0-9_]/gi, "").slice(0, 40);

// ------------------------------------------------------------ the executor registry

// Tools that change something, by name: { name, perm, exec(args, ctx) }.
// server.mjs registers them (its own and every module's) at cold start.
const executors = new Map();
export function registerExecutor(tool) { executors.set(tool.name, tool); }
export const executorFor = (name) => executors.get(name) || null;

definePendingKind(PENDING_KIND, {
  label: "Claude's request",
  // runs once, as the approver (core/pending.mjs runApprovedAction)
  run: async (action, h) => {
    const tool = executorFor(action.tool);
    if (!tool) throw new InputError("That tool isn't there any more.");
    const ctx = await approverCtx(action, h);
    if (tool.perm && !ctx.can(tool.perm)) throw new ForbiddenError("The approver doesn't have access to that.");
    const out = await tool.exec(action.args || {}, ctx, action);
    return summarize(out);
  },
});

// What an approved run keeps: ids and statuses only (no names, texts or amounts tied to a person).
const ID_RE = /^[a-z]{2}_[0-9a-z]{20}$/;
export function summarize(out) {
  const keep = {};
  const walk = (o, prefix, depth) => {
    if (!o || typeof o !== "object" || Array.isArray(o) || depth > 2) return;
    for (const [k, v] of Object.entries(o)) {
      if (Object.keys(keep).length >= 8) return;
      const name = prefix ? `${prefix}_${k}` : k;
      if ((k === "id" || k.endsWith("_id")) && typeof v === "string" && ID_RE.test(v)) keep[name] = v;
      else if (k === "status" && typeof v === "string") keep[name] = v.slice(0, 30);
      else if (v && typeof v === "object") walk(v, name, depth + 1);
    }
  };
  walk(out, "", 0);
  return Object.keys(keep).length ? keep : { ok: true };
}

// ------------------------------------------------------------ asking

async function checkAskRate(ctx) {
  const ts = tsKey();
  const prefix = `thr/mcp-ask/${keyIdOf(ctx)}/${ts.slice(0, 11)}`;
  const used = await listKeys(prefix);
  if (used.length >= ASK_PER_HOUR) throw new RateLimited("Claude asked for too many approvals this hour. Wait a while and try again.", 60 * (60 - Number(ts.slice(11, 13))));
  await putRaw(`${prefix}${ts.slice(11)}-${randomBytes(3).toString("hex")}`, { at: nowIso() });
}

// → the answer Claude gets. preview: { title, rendered_text, recipients?, amount_cents? }.
export async function requestAction(tool, args, preview, ctx) {
  await checkAskRate(ctx);
  const keyName = ctx.apiKey && ctx.apiKey.name ? String(ctx.apiKey.name).slice(0, 40) : "a key";
  const p = preview || {};
  const a = await createPendingAction({
    kind: PENDING_KIND, tool: tool.name, args: canonical(args || {}), key_id: ctx.apiKey && ctx.apiKey.id,
    title: `Claude asks: ${String(p.title || tool.name).slice(0, 100)}`,
    preview: {
      rendered_text: `${String(p.rendered_text || "").slice(0, 3000)}${p.rendered_text ? "\n\n" : ""}Asked through Claude with the key "${keyName}".`,
      ...(Array.isArray(p.recipients) ? { recipients: p.recipients.slice(0, 20) } : {}),
      ...(Number.isSafeInteger(p.amount_cents) ? { amount_cents: p.amount_cents } : {}),
    },
    requested_by: ctx.user.id,
  }, ctx.write());
  return {
    status: "waiting_for_approval", pending_action_id: a.id, expires_at: a.expires_at,
    message: `Waiting for an owner's approval (pending action ${a.id}). Nothing has happened yet: an owner approves or rejects it in the CRM (Approvals). Check it later with get_pending_action.`,
  };
}

// get_pending_action: only the requests this key's person made.
export async function pendingStatus(id, ctx) {
  const a = await getPendingAction(id);
  if (a.requested_by !== ctx.user.id || a.kind !== PENDING_KIND) throw new ForbiddenError("That isn't one of your requests.");
  const v = pendingView(a);
  return { id: v.id, tool: v.tool, status: v.status, created_at: v.created_at, expires_at: v.expires_at, decided_at: v.decided_at, result: v.result, error: v.error };
}

// ------------------------------------------------------------ confirm tokens

const CONFIRM_KEY = (token) => `done/mcp-confirm/${sha(String(token))}`;

export async function issueConfirmToken(tool, args, ctx) {
  const token = "bcf_" + randomBytes(24).toString("base64url");
  const rec = { tool: tool.name, args_sha256: argsHash(args), key_id: keyIdOf(ctx), expires_at: new Date(nowMs() + CONFIRM_TTL_MS).toISOString(), used: false };
  const w = await settledWrite(CONFIRM_KEY(token), rec, { onlyIfNew: true });
  if (!w.ok) throw new Error("confirm token collision");
  return { token, expires_at: rec.expires_at };
}

// Uses a token once. Throws ForbiddenError when it doesn't fit.
export async function useConfirmToken(token, tool, args, ctx) {
  if (typeof token !== "string" || !/^bcf_[A-Za-z0-9_-]{32}$/.test(token)) throw new ForbiddenError("That confirm token isn't valid. Call the tool without one to get a new token.");
  const got = await getRaw(CONFIRM_KEY(token));
  const t = got && got.data;
  if (!t) throw new ForbiddenError("That confirm token isn't valid. Call the tool without one to get a new token.");
  if (t.used) throw new ForbiddenError("That confirm token was already used.");
  if (!(Date.parse(t.expires_at) > nowMs())) throw new ForbiddenError("That confirm token ran out. Call the tool without one to get a new token.");
  if (t.tool !== tool.name || t.key_id !== keyIdOf(ctx)) throw new ForbiddenError("That confirm token belongs to another request.");
  if (t.args_sha256 !== argsHash(args)) throw new ForbiddenError("That confirm token was for other arguments. Call the tool without one to preview these.");
  const { _w, ...value } = t;
  const w = await settledWrite(CONFIRM_KEY(token), { ...value, used: true, used_at: nowIso() }, { onlyIfMatch: got.etag });
  if (!w.ok) throw new ForbiddenError("That confirm token was already used.");
  return true;
}
