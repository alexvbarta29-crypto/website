// Barta CRM core: the API dispatcher (design §2.2). Every JSON route of the
// CRM runs through handleRequest(), in this order:
//
//   1. deploy context (§3.10); a non-canonical production host gets a 308
//   2. match method + path (404 / 405 with Allow)
//      setup: a production deploy without its CRM settings answers 503
//      setup_needed, except office-cookie routes (the legacy Customers list)
//   3. authenticate per route.auth (session cookie, API key, office cookie)
//   4. CSRF for every cookie-authenticated or public non-GET: X-CRM: 1,
//      Origin absent or same-origin, and Content-Type application/json when
//      the route takes a JSON body (not a body-less DELETE, not body: "raw")
//   5. client version (X-CRM-Client below MIN_CLIENT → 426; replaySafe
//      routes accept MIN_REPLAY_CLIENT)
//   6. body read under maxBody (413), then Idempotency-Key replay (POST)
//   7. JSON parse
//   8. permission (subject "none" needs the permission unscoped)
//   9. the handler, inside a store scope with its budget (8 s, maxCalls)
//  10. errors → the envelope ({ ok: false, error: { code, message } }); a
//      412 `current` is cut to the type's techFields for techs
//  11. no-store, noindex, same-origin referrer headers; ETag when given
//
// Handlers return a Response (passed through) or { data, meta?, etag?,
// status?, headers?, cookies? }. Logs carry the route pattern (never the
// real path: an MCP path key would leak) and safeErr output only.

import { randomBytes, createHash } from "node:crypto";
import { withStoreScope, withBudget, idemBegin, idemFinish, getRaw } from "../../crm-store.mjs";
import { errorResponse, ForbiddenError, InputError } from "./errors.mjs";
import { deployContext, canonicalRedirect } from "./context.mjs";
import { now } from "./clock.mjs";
import { can, holds, techView } from "./perms.mjs";
import { keyCan } from "./apikeys.mjs";
import { allRoutes } from "./registry.mjs";
import { authenticate, loadPermissions, storeBlocked, officeSignedIn } from "./auth.mjs";
import { JSON_HEADERS, MIN_CLIENT, MIN_REPLAY_CLIENT, compareVersions, json, fail, readBodyBytes, BodyTooLarge, contentType, withCookies } from "./http.mjs";
import { safeErr } from "../../referral-lib.mjs";

export const API_BASE = "/api/crm";
export const DEFAULT_JSON_MAX = 256 * 1024;
export const DEFAULT_RAW_MAX = 4.5 * 1024 * 1024;
export const DEFAULT_BUDGET_MS = 8000;
export const DEFAULT_MAX_CALLS = 25;
export const SYS_MODE_KEY = "sys/mode";
const DEFAULT_MODE = Object.freeze({ system_of_record: "rotor", paused: false, cutover_n: 0 });

// ------------------------------------------------------------ matching

const PARAM_RE = /^:([a-z_][a-z0-9_]*)$/i;
export function compileRoute(r) {
  const segs = r.path.split("/").filter(Boolean);
  const names = [];
  let literal = 0;
  const parts = segs.map((s) => {
    const m = PARAM_RE.exec(s);
    if (m) { names.push(m[1]); return "([^/]+)"; }
    literal += 1;
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  return { ...r, re: new RegExp("^/" + parts.join("/") + "/?$"), names, literal, nsegs: segs.length };
}
export function compileRoutes(list) {
  return list.map(compileRoute).sort((a, b) => b.literal - a.literal || a.names.length - b.names.length);
}

// → { route, params } | { allow: string[] } | null
export function matchRoute(compiled, method, path) {
  const hits = compiled.filter((r) => r.re.test(path));
  if (!hits.length) return null;
  const m = method === "HEAD" ? "GET" : method;
  const route = hits.find((r) => r.method === m);
  if (!route) return { allow: [...new Set(hits.map((r) => r.method))] };
  const vals = route.re.exec(path).slice(1);
  const params = {};
  route.names.forEach((n, i) => { try { params[n] = decodeURIComponent(vals[i]); } catch { params[n] = vals[i]; } });
  return { route, params };
}

const passedCache = new WeakMap();
const compiledOf = (routes) => {
  if (!passedCache.has(routes)) passedCache.set(routes, compileRoutes(routes));
  return passedCache.get(routes);
};

let registryCache = { src: null, compiled: [] };
function registryRoutes() {
  const src = allRoutes();
  if (registryCache.src && registryCache.src.length === src.length && registryCache.src.every((r, i) => r === src[i])) return registryCache.compiled;
  registryCache = { src, compiled: compileRoutes(src) };
  return registryCache.compiled;
}

// ------------------------------------------------------------ helpers

const COOKIE_AUTH = new Set(["session", "session_or_office", "office_cookie", "session_or_key", "public"]);
const OFFICE_AUTH = new Set(["office_cookie", "session_or_office"]);
const sha = (s) => createHash("sha256").update(s).digest("hex");
const rid = () => randomBytes(8).toString("hex");

// The body a route takes: its declared `body`, else none for GET and
// DELETE and JSON for every other method.
export const bodyKind = (route, method) => route.body || (method === "GET" || method === "DELETE" ? "none" : "json");

// kind = bodyKind(): a DELETE with no body needs no Content-Type (the app
// sends none), but X-CRM and the Origin check apply to every non-GET.
function csrfProblem(req, url, kind) {
  if (req.headers.get("x-crm") !== "1") return "Missing the X-CRM header.";
  const origin = req.headers.get("origin");
  if (origin && origin !== "null" && origin !== url.origin) return "That request came from another site.";
  if (origin === "null") return "That request came from another site.";
  if (kind === "json" && contentType(req) !== "application/json") return "Send JSON.";
  return null;
}

function finish(res, extraHeaders = {}) {
  for (const [k, v] of Object.entries({ ...JSON_HEADERS, ...extraHeaders })) if (!res.headers.has(k)) res.headers.set(k, v);
  return res;
}

function resultResponse(result) {
  if (result instanceof Response) return { res: result, stored: null };
  const r = result || {};
  const status = r.status || 200;
  const body = r.data === undefined && r.meta === undefined ? { ok: true } : r.meta ? { ok: true, data: r.data ?? null, meta: r.meta } : { ok: true, data: r.data ?? null };
  const headers = { ...(r.headers || {}) };
  if (r.etag) headers.ETag = r.etag;
  const res = json(body, status, headers);
  if (Array.isArray(r.cookies)) withCookies(res, r.cookies);
  return { res, stored: { status, body, headers } };
}

function errorOut(e, ctx, route) {
  const er = errorResponse(e);
  if (er.code === "failed") console.error(`crm:router: ${route ? route.method + " " + route.path : "request"} failed (${safeErr(e)})`);
  let details = er.details;
  if (er.code === "stale" && ctx && ctx.user && ctx.user.role === "tech" && details) {
    const cur = details.current;
    details = { ...details, current: cur && cur.type ? techView(cur.type, cur) : cur ? { id: cur.id } : null };
  }
  if (details && details.current && typeof details.current === "object") {
    const { _w, password, ...clean } = details.current;
    details = { ...details, current: clean };
  }
  return fail(er.code, er.message, er.status, { field: er.field, details });
}

// ------------------------------------------------------------ the pipeline

export async function handleRequest(req, context, { base = API_BASE, routes } = {}) {
  const requestId = (context && typeof context.requestId === "string" && context.requestId.slice(0, 60)) || rid();
  let route = null;
  let ctx = null;
  try {
    const deploy = deployContext(req, context);
    const moved = canonicalRedirect(req, deploy);
    if (moved) return moved;
    const url = new URL(req.url);
    if (!url.pathname.startsWith(base)) return fail("not_found", "Not found.", 404);
    const path = url.pathname.slice(base.length) || "/";
    const compiled = routes ? compiledOf(routes) : registryRoutes();
    const hit = matchRoute(compiled, req.method, path);
    if (!hit) return fail("not_found", "Not found.", 404);
    if (hit.allow) return fail("method_not_allowed", "Method not allowed.", 405, { headers: { Allow: hit.allow.join(", ") } });
    route = hit.route;
    const budget = withBudget(route.budgetMs || DEFAULT_BUDGET_MS, route.maxCalls || DEFAULT_MAX_CALLS);
    const blocked = storeBlocked(deploy);
    // origin and waitUntil let kickWorker() wake a lane without holding the answer (§2.2)
    const waitUntil = context && typeof context.waitUntil === "function" ? context.waitUntil.bind(context) : undefined;
    return await withStoreScope({ deploy, budget, requestId, origin: url.origin, waitUntil }, async () => {
      ctx = {
        req, context, url, params: hit.params, query: url.searchParams, body: undefined, raw: undefined,
        user: null, userEtag: null, session: null, sessionHash: null, apiKey: null, office: false,
        requestId, deploy, budget, setupNeeded: blocked, permissions: null,
        now: () => now(),
        ifMatch: req.headers.get("if-match") || undefined,
        idempotencyKey: req.headers.get("idempotency-key") || undefined,
        clientVersion: req.headers.get("x-crm-client") || undefined,
      };

      // setup / authentication
      if (blocked) {
        if (!(OFFICE_AUTH.has(route.auth) && officeSignedIn(req))) return finish(fail("setup_needed", "The CRM needs its setup in Netlify first.", 503));
        ctx.office = true;
      } else {
        const who = await authenticate(req, route.auth);
        if (!who) return finish(fail("signed_out", "Sign in again.", 401));
        Object.assign(ctx, {
          user: who.user || null, userEtag: who.userEtag || null, session: who.session || null,
          sessionHash: who.sessionHash || null, apiKey: who.apiKey || null, office: !!who.office,
        });
      }
      const method = req.method === "HEAD" ? "GET" : req.method;
      const kind = bodyKind(route, method);

      // CSRF: anything a browser could send with cookies
      const cookieAuthed = ctx.session || ctx.office || route.auth === "public";
      if (method !== "GET" && route.auth !== "hook" && !ctx.apiKey && cookieAuthed) {
        const why = csrfProblem(req, url, kind);
        if (why) return finish(fail("csrf", why, 403));
      }

      // client version
      if (ctx.clientVersion) {
        const floor = route.replaySafe ? MIN_REPLAY_CLIENT : MIN_CLIENT;
        if (compareVersions(ctx.clientVersion, floor) < 0) return finish(fail("client_outdated", "There's a new version of the app. Reload to get it.", 426, { details: { min_client: MIN_CLIENT } }));
      }

      // permissions helpers. The owner's cfg/permissions must be read: a
      // failed read answers 503 busy and never runs on the role defaults.
      if (ctx.user) {
        try { ctx.permissions = await loadPermissions(); } catch (e) {
          console.error(`crm:router: ${route.method} ${route.path}: permissions not read (${safeErr(e)})`);
          return finish(fail("busy", "Storage didn't answer. Try again in a minute.", 503, { headers: { "Retry-After": "5" } }));
        }
      }
      ctx.can = (perm, subject) => {
        if (ctx.office && !ctx.user) return OFFICE_AUTH.has(route.auth);
        if (!ctx.user) return false;
        return ctx.apiKey ? keyCan(ctx.user, ctx.apiKey, perm, subject, ctx.permissions) : can(ctx.user, perm, subject, ctx.permissions);
      };
      ctx.require = (perm, subject) => { if (!ctx.can(perm, subject)) throw new ForbiddenError("You don't have access to that."); };
      ctx.holds = (perm) => (ctx.user ? holds(ctx.user, perm, ctx.permissions) : false);
      ctx.write = (extra = {}) => ({
        by: ctx.user ? ctx.user.id : ctx.office ? "office" : "system",
        origin: ctx.apiKey ? "mcp" : "api", actor_kind: ctx.user || ctx.office ? "user" : "automation",
        requestId, ...extra,
      });
      let modeP = null;
      ctx.sysMode = () => (modeP ||= getRaw(SYS_MODE_KEY).then((g) => ({ ...DEFAULT_MODE, ...(g && g.data ? g.data : {}) })).catch(() => ({ ...DEFAULT_MODE })));

      // body
      let rawBytes = null;
      if (kind !== "none") {
        const max = route.maxBody || (kind === "raw" ? DEFAULT_RAW_MAX : DEFAULT_JSON_MAX);
        try { rawBytes = await readBodyBytes(req, max); } catch (e) {
          if (e instanceof BodyTooLarge) return finish(fail("too_large", "That is too big to send.", 413));
          throw e;
        }
      }

      // idempotency (POST + Idempotency-Key)
      let idem = null;
      // A secret route (a one-time link, a key shown once) is never stored.
      if (method === "POST" && ctx.idempotencyKey && route.idempotent !== false && !route.secret) {
        const uid = ctx.user ? ctx.user.id : ctx.office ? "office" : "anon";
        const reqHash = sha(method + " " + url.pathname + url.search + " " + (rawBytes ? Buffer.from(rawBytes).toString("base64") : ""));
        let begun;
        try { begun = await idemBegin(uid, ctx.idempotencyKey, reqHash); } catch (e) {
          if (e instanceof InputError) return finish(fail("invalid", e.message, 400, { field: e.field }));
          throw e;
        }
        if (begun.state === "pending") return finish(fail("in_progress", "This is still being saved. Try again in a moment.", 409, { headers: { "Retry-After": "2" } }));
        if (begun.state === "mismatch") return finish(fail("idempotency_mismatch", "That retry doesn't match the first request.", 422));
        if (begun.state === "done") {
          const s = begun.response || {};
          return finish(json(s.body ?? { ok: true }, s.status || 200, { ...(s.headers || {}), "Idempotent-Replay": "true" }));
        }
        idem = { uid, key: ctx.idempotencyKey };
      }

      const run = async () => {
        if (kind === "json") {
          const text = Buffer.from(rawBytes || []).toString("utf8");
          if (text.trim()) {
            try { ctx.body = JSON.parse(text); } catch { return fail("invalid", "That request isn't valid JSON.", 400); }
          } else ctx.body = {};
        } else if (kind === "raw") ctx.raw = rawBytes;

        // permission
        if (route.perm && !["public", "hook"].includes(route.auth)) {
          let allowed;
          if (ctx.office && !ctx.user) allowed = OFFICE_AUTH.has(route.auth);
          else if (route.subject === "none") allowed = ctx.can(route.perm);
          else allowed = ctx.apiKey ? !!(ctx.apiKey.scopes || []).includes(route.perm) && !!ctx.holds(route.perm) : !!ctx.holds(route.perm);
          if (!allowed) return fail("forbidden", "You don't have access to that.", 403);
        }
        try {
          const out = resultResponse(await route.handler(ctx));
          return out;
        } catch (e) {
          return errorOut(e, ctx, route);
        }
      };

      let out = await run();
      let res = out instanceof Response ? out : out.res;
      const stored = out instanceof Response ? null : out.stored;
      if (idem) {
        const status = res.status;
        let body = stored ? stored.body : null;
        if (!stored) { try { body = await res.clone().json(); } catch { body = null; } }
        const headers = stored ? stored.headers : {};
        await idemFinish(idem.uid, idem.key, { status, body, headers }).catch((e) => console.error("crm:router: idempotency record not saved (" + safeErr(e) + ")"));
      }
      return finish(res);
    });
  } catch (e) {
    return finish(errorOut(e, ctx, route));
  }
}

// crm-api.mjs: every route the modules registered.
export const handleApi = (req, context) => handleRequest(req, context, { base: API_BASE });
