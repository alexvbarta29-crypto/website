// MCP module (M7c): calling the CRM's own routes from a tool (design §6.9:
// "tools call the same service functions as the HTTP routes, with the
// key's user and scopes").
//
// callRoute(ctx, method, path, { query, body, ifMatch }) runs a registered
// route's handler in-process with the MCP request's context: the same
// permission check the dispatcher makes (core/router.mjs step 8, with the
// key's scopes), then the handler, which applies its own scoping. A tool
// therefore never sees more than the same person would on the screen.
//
// approverCtx(action, h) builds that context for an approved pending
// action in the worker: the APPROVER is the actor (their permissions, by:
// approver), the key's user is recorded as requested_by, origin "mcp".

import { compileRoutes, matchRoute, SYS_MODE_KEY } from "../../core/router.mjs";
import { allRoutes } from "../../core/registry.mjs";
import { ForbiddenError, NotFoundError, InputError } from "../../core/errors.mjs";
import { can, holds } from "../../core/perms.mjs";
import { keyCan, NEVER_KEY_SCOPES, isReadScope } from "../../core/apikeys.mjs";
import { now } from "../../core/clock.mjs";
import { getRecord, getRaw, currentScope, withBudget } from "../../../crm-store.mjs";
import { loadPermissions } from "../../core/auth.mjs";
import { CANONICAL_ORIGIN } from "../../core/context.mjs";

let cache = { src: null, compiled: [] };
function compiled() {
  const src = allRoutes();
  if (cache.src !== src.length) cache = { src: src.length, compiled: compileRoutes(src) };
  return cache.compiled;
}

// The dispatcher's permission rule for one route (router.mjs step 8).
export function routeAllowed(ctx, route) {
  if (!route.perm) return false;                                   // public and hook routes are never proxied
  if (!ctx.user) return false;
  if (route.subject === "none") return ctx.can(route.perm);
  return ctx.apiKey ? (ctx.apiKey.scopes || []).includes(route.perm) && !!ctx.holds(route.perm) : !!ctx.holds(route.perm);
}

export function findRoute(method, path) {
  const hit = matchRoute(compiled(), method, path);
  if (!hit || hit.allow) return null;
  return hit;
}

// → the handler's { data, meta } (a Response is read as JSON). Errors throw
// as the handler threw them (InputError, ForbiddenError, ...).
export async function callRoute(ctx, method, path, { query = {}, body, ifMatch } = {}) {
  const hit = findRoute(method, path);
  if (!hit) throw new NotFoundError("That isn't there.");
  const route = hit.route;
  if (route.mode !== "inline" || ["public", "hook"].includes(route.auth)) throw new ForbiddenError("That can't be done from Claude.");
  if (!routeAllowed(ctx, route)) throw new ForbiddenError("This key doesn't have access to that.");
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  const sub = { ...ctx, params: hit.params, query: q, body: body === undefined ? (method === "GET" ? undefined : {}) : body, ifMatch: ifMatch || undefined, idempotencyKey: undefined };
  const out = await route.handler(sub);
  if (out instanceof Response) {
    let j = null;
    try { j = await out.json(); } catch { j = null; }
    if (!out.ok) throw new InputError((j && j.error && j.error.message) || "That didn't work.");
    return { data: j && j.data !== undefined ? j.data : j, meta: j && j.meta };
  }
  return { data: out ? out.data : null, meta: out ? out.meta : undefined, etag: out ? out.etag : undefined };
}

// The context an approved action runs with (the worker has no request).
export async function approverCtx(action, h = {}) {
  const uid = action.decided_by;
  const got = uid ? await getRecord("user", uid) : null;
  const user = got && got.data;
  if (!user || user.status !== "active") throw new ForbiddenError("The person who approved this can't act any more.");
  const permissions = await loadPermissions();
  const sc = currentScope() || {};
  const base = typeof h.write === "function" ? h.write() : { by: uid, actor_kind: "user", requestId: "mcp" };
  const write = (extra = {}) => ({ ...base, by: uid, origin: "mcp", actor_kind: "user", requested_by: action.requested_by, approved_action: action.id, ...extra });
  const ctx = {
    req: new Request(CANONICAL_ORIGIN + "/api/crm/mcp", { headers: { "user-agent": "Claude (approved)" } }), context: {},
    url: new URL(CANONICAL_ORIGIN + "/api/crm/mcp"), params: {}, query: new URLSearchParams(), body: {},
    user, userEtag: got.etag, session: null, sessionHash: null, apiKey: null, office: false,
    requestId: base.requestId || "mcp", deploy: sc.deploy, budget: withBudget(8000, 400), setupNeeded: false, permissions,
    now: () => now(), ifMatch: undefined, idempotencyKey: undefined, clientVersion: undefined,
  };
  ctx.can = (perm, subject) => can(user, perm, subject, permissions);
  ctx.require = (perm, subject) => { if (!ctx.can(perm, subject)) throw new ForbiddenError("You don't have access to that."); };
  ctx.holds = (perm) => holds(user, perm, permissions);
  ctx.write = write;
  // sys/mode, read once (a failed read rejects: never "not paused" by accident)
  let modeP = null;
  ctx.sysMode = () => (modeP ||= getRaw(SYS_MODE_KEY).then((g) => { const { _w, ...m } = { system_of_record: "rotor", paused: false, cutover_n: 0, ...(g && g.data ? g.data : {}) }; return m; }));
  return ctx;
}

// A tool's permission for the key: its scopes and its user (role ∩ scopes).
// An "own" permission (a tech's) counts only for tools that scope by record.
export function keyMay(ctx, perm, { scoped = false } = {}) {
  const k = ctx.apiKey;
  if (!ctx.user || !k || !Array.isArray(k.scopes) || k.kind === "backup") return false;
  if (!scoped) return keyCan(ctx.user, k, perm, undefined, ctx.permissions);
  if (NEVER_KEY_SCOPES.includes(perm) || !k.scopes.includes(perm)) return false;
  if (k.kind === "path" && !isReadScope(perm)) return false;
  return !!holds(ctx.user, perm, ctx.permissions);
}
