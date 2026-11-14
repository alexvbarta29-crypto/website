// MCP module: OAuth 2.1 for the MCP endpoint, so claude.ai (which can't
// send a header) connects with the tools that ASK (MCP authorization spec:
// RFC 9728 protected resource metadata, RFC 8414 server metadata, RFC 7591
// dynamic client registration, PKCE S256, RFC 8707 resource, RFC 9207 iss).
// Every change Claude asks for is still only a pending action an owner
// approves (actions.mjs); OAuth only decides who Claude acts as.
//
//   GET  /.well-known/oauth-protected-resource[/api/crm/mcp]   (functions/crm-oauth-meta.mjs)
//   GET  /.well-known/oauth-authorization-server
//   POST /api/crm/auth/oauth/register      a client (claude.ai) registers its redirect URIs
//   GET  /api/crm/auth/oauth/authorize     → the consent screen in the CRM (signed in, or sign in first)
//   POST /api/crm/auth/oauth/token         code + PKCE verifier → tokens; refresh (rotated)
//   POST /api/crm/auth/oauth/revoke        RFC 7009
//   (crm-auth.mjs serves these four behind the platform rate limit, 30 a minute per address)
//   GET  /api/crm/mcp/oauth/requests/:rid           the consent screen's facts (session, api_keys:own)
//   POST /api/crm/mcp/oauth/requests/:rid/approve   { ask } → { redirect_url } (CSRF: the router's X-CRM + same origin)
//   POST /api/crm/mcp/oauth/requests/:rid/deny      → { redirect_url } (error=access_denied)
//   GET  /api/crm/mcp/oauth/grants                  Settings → Claude connector: the connected apps
//   DELETE /api/crm/mcp/oauth/grants/:id            disconnect (every token of it stops at once)
//
// Safety:
//   - Redirect URIs: https://claude.ai/… and https://claude.com/… (no port,
//     no user, no fragment) or a loopback http://localhost|127.0.0.1|[::1]
//     (any port, RFC 8252) for Claude Code and desktop apps. Anything else is
//     refused at registration, so a code can only ever go to Claude or to the
//     person's own computer. At /authorize the redirect URI must be one the
//     client registered (exactly; a loopback's port may differ). A bad client
//     or redirect URI gets an error page here, never a redirect.
//   - PKCE S256 only (plain is refused); state passed back as it came; the
//     answer also carries iss (RFC 9207).
//   - Codes: 5 minutes, single use (a second use revokes what the first made).
//     Access tokens: 1 hour. Refresh tokens: 30 days, rotated on every use; an
//     old one used again (a stolen copy) disconnects the grant.
//   - Every secret (code, tokens, client secret) is stored only as its sha256.
//     Tokens are bound to their grant (client + person + scopes) and to this
//     MCP endpoint (resource); a disconnected grant, a turned-off person or
//     "sign out everywhere"/a password change stops them at once.
//   - The consent screen is a CRM screen: the person's own sign-in, the
//     router's CSRF check on Allow, frame-ancestors 'self'. It names the app
//     as it calls itself and says where it goes back to.
//   - Rate limits: the platform's 30 a minute per address on these routes,
//     20 client registrations an hour in all, 120 MCP calls a minute per
//     grant and the asks' 20 an hour (actions.mjs).
//
// Storage (not in backups, like sessions: after a restore Claude connects
// again): oauth/client/{client_id}, oauth/req/{rid}, oauth/code/{sha256},
// oauth/at/{sha256}, oauth/rt/{sha256}, oauth/grant/{grant id ("ak_…": it
// stands where a key's id does, e.g. the asks' key_id)}; thr/oauth-reg/… for
// the registration count. The nightly mcp.oauth_cleanup sweep deletes what
// expired, tokens of disconnected grants and clients unused for 30 days.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getRaw, putRaw, settledWrite, deleteRaw, listKeys, getRecord, appendEvent } from "../../../crm-store.mjs";
import { newId, isId } from "../../core/ids.mjs";
import { nowIso, nowMs, tsKey, localDate } from "../../core/clock.mjs";
import { InputError, NotFoundError, ConflictError, ForbiddenError, RateLimited } from "../../core/errors.mjs";
import { CANONICAL_ORIGIN } from "../../core/context.mjs";
import { lookupSession } from "../../core/sessions.mjs";
import { DEFAULT_READ_SCOPES, NEVER_KEY_SCOPES, DEFAULT_RATE_PER_MIN, checkKeyRate } from "../../core/apikeys.mjs";
import { holds } from "../../core/perms.mjs";
import { loadPermissions } from "../../core/auth.mjs";
import { htmlPage, redirect } from "../../core/http.mjs";
import { messageHtml } from "../../core/shell-html.mjs";
import { safeErr } from "../../../referral-lib.mjs";

export const OAUTH_SCOPES = Object.freeze(["crm:read", "crm:ask"]);
export const CODE_TTL_MS = 5 * 60 * 1000;
export const REQ_TTL_MS = 10 * 60 * 1000;
export const ACCESS_TTL_S = 3600;
export const REFRESH_TTL_DAYS = 30;
export const CLIENT_UNUSED_DAYS = 30;
export const REG_PER_HOUR = 20;
export const MAX_REDIRECTS = 5;
export const TOKEN_PREFIX = Object.freeze({ access: "bcat_", refresh: "bcrt_", code: "bcac_", secret: "bcsk_" });
const ASK_HOSTS = new Set(["claude.ai", "claude.com"]);
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

const K = {
  client: (id) => `oauth/client/${id}`,
  req: (id) => `oauth/req/${id}`,
  code: (h) => `oauth/code/${h}`,
  at: (h) => `oauth/at/${h}`,
  rt: (h) => `oauth/rt/${h}`,
  grant: (id) => `oauth/grant/${id}`,
};
const sha = (s) => createHash("sha256").update(String(s)).digest("hex");
const b64urlSha = (s) => createHash("sha256").update(String(s)).digest("base64url");
const token = (prefix) => prefix + randomBytes(32).toString("base64url");
const TOKEN_RE = /^bc(at|rt|ac|sk)_[A-Za-z0-9_-]{43}$/;
const CLIENT_RE = /^bcli_[0-9a-f]{32}$/;
const REQ_RE = /^bcrq_[0-9a-f]{32}$/;
const sameText = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};
const data = (got) => (got && got.data ? (({ _w, ...d }) => d)(got.data) : null);
const expired = (iso) => !(Date.parse(iso) > nowMs());

// ------------------------------------------------------------ where things are

// The issuer and the protected resource: the canonical site in production,
// else the request's own origin (a deploy preview, a local server).
export const issuerOf = (ctx) => (ctx && ctx.deploy && ctx.deploy.prod ? CANONICAL_ORIGIN : ctx.url.origin);
export const resourceOf = (ctx) => `${issuerOf(ctx)}/api/crm/mcp`;
export const resourceMetadataUrl = (ctx) => `${issuerOf(ctx)}/.well-known/oauth-protected-resource/api/crm/mcp`;

export function authServerMetadata(issuer) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/api/crm/auth/oauth/authorize`,
    token_endpoint: `${issuer}/api/crm/auth/oauth/token`,
    registration_endpoint: `${issuer}/api/crm/auth/oauth/register`,
    revocation_endpoint: `${issuer}/api/crm/auth/oauth/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: [...OAUTH_SCOPES],
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${issuer}/office`,
  };
}
export function resourceMetadata(issuer) {
  return {
    resource: `${issuer}/api/crm/mcp`,
    authorization_servers: [issuer],
    scopes_supported: [...OAUTH_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "Barta CRM",
  };
}

// ------------------------------------------------------------ redirect URIs

// → the normalized URI, or null when it may not be used (see the top).
export function allowedRedirect(raw) {
  if (typeof raw !== "string" || !raw || raw.length > 400 || /[\s\\]/.test(raw)) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.username || u.password || u.hash || raw.includes("#")) return null;
  if (u.protocol === "https:" && ASK_HOSTS.has(u.hostname) && u.port === "") return u.href;
  if (u.protocol === "http:" && LOOPBACK.has(u.hostname)) return u.href;
  return null;
}
const isLoopback = (href) => { try { const u = new URL(href); return u.protocol === "http:" && LOOPBACK.has(u.hostname); } catch { return false; } };
// The registered URI this one stands for: the same string, or a loopback one
// that differs only in its port (a native app picks a free port each time).
export function matchRedirect(registered, asked) {
  const a = allowedRedirect(asked);
  if (!a) return null;
  for (const r of registered || []) {
    if (r === a) return a;
    if (isLoopback(r) && isLoopback(a)) {
      const x = new URL(r), y = new URL(a);
      if (x.hostname === y.hostname && x.pathname === y.pathname && x.search === y.search) return a;
    }
  }
  return null;
}
const hostWords = (href) => { try { const u = new URL(href); return isLoopback(href) ? "an app on this computer" : u.hostname; } catch { return "?"; } };

// ------------------------------------------------------------ answers

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, mcp-protocol-version", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Max-Age": "600" };
const NO_STORE = { "Cache-Control": "no-store", Pragma: "no-cache" };
const oauthJson = (body, status = 200, extra = {}) => Response.json(body, { status, headers: { ...CORS, ...NO_STORE, ...extra } });
const oauthError = (error, description, status = 400, extra = {}) => oauthJson({ error, ...(description ? { error_description: description } : {}) }, status, extra);
const errorPage = (text) => htmlPage(messageHtml({ title: "Claude can't connect this way", text, links: [{ label: "Open the CRM", href: "/crm", primary: true }] }), 400);

// The request's body as fields: a form (RFC 6749) or JSON.
function fieldsOf(ctx) {
  const text = Buffer.from(ctx.raw || []).toString("utf8");
  const ct = String(ctx.req.headers.get("content-type") || "").toLowerCase();
  if (ct.startsWith("application/json")) {
    try { const j = JSON.parse(text || "{}"); return j && typeof j === "object" && !Array.isArray(j) ? j : {}; } catch { return null; }
  }
  const out = {};
  for (const [k, v] of new URLSearchParams(text)) if (!Object.hasOwn(out, k)) out[k] = v;
  return out;
}

// ------------------------------------------------------------ clients (RFC 7591)

async function registrationsThisHour() {
  const ts = tsKey(new Date(nowMs()));
  const prefix = `thr/oauth-reg/${ts.slice(0, 11)}`;
  const used = await listKeys(prefix);
  return { used: used.length, mark: () => putRaw(`${prefix}${ts.slice(11)}-${randomBytes(3).toString("hex")}`, { at: nowIso() }) };
}

export async function registerClient(ctx) {
  const b = fieldsOf(ctx);
  if (!b) return oauthError("invalid_client_metadata", "Send JSON.");
  const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris : [];
  if (!uris.length || uris.length > MAX_REDIRECTS) return oauthError("invalid_redirect_uri", `Give 1 to ${MAX_REDIRECTS} redirect URIs.`);
  const ok = uris.map(allowedRedirect);
  if (ok.some((x) => !x)) return oauthError("invalid_redirect_uri", "This CRM sends sign-ins back only to claude.ai, claude.com or this computer (localhost).");
  const grants = Array.isArray(b.grant_types) ? b.grant_types : ["authorization_code", "refresh_token"];
  if (grants.some((g) => !["authorization_code", "refresh_token"].includes(g))) return oauthError("invalid_client_metadata", "Only authorization_code and refresh_token.");
  const responses = Array.isArray(b.response_types) ? b.response_types : ["code"];
  if (responses.some((r) => r !== "code")) return oauthError("invalid_client_metadata", "Only the code response type.");
  const method = b.token_endpoint_auth_method === undefined ? "none" : b.token_endpoint_auth_method;
  if (!["none", "client_secret_post", "client_secret_basic"].includes(method)) return oauthError("invalid_client_metadata", "Pick none, client_secret_post or client_secret_basic.");
  const name = String(b.client_name ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, 60) || "An MCP app";
  const count = await registrationsThisHour();
  if (count.used >= REG_PER_HOUR) return oauthError("temporarily_unavailable", "Too many apps registered this hour. Try again later.", 429, { "Retry-After": "600" });
  await count.mark();
  const id = "bcli_" + randomBytes(16).toString("hex");
  const secret = method === "none" ? null : token(TOKEN_PREFIX.secret);
  const at = nowIso();
  const rec = { client_id: id, client_name: name, redirect_uris: [...new Set(ok)], grant_types: grants, token_endpoint_auth_method: method, ...(secret ? { secret_sha256: sha(secret) } : {}), created_at: at };
  const w = await settledWrite(K.client(id), rec, { onlyIfNew: true });
  if (!w.ok) return oauthError("temporarily_unavailable", "Try again.", 503);
  return oauthJson({
    client_id: id, client_id_issued_at: Math.floor(Date.parse(at) / 1000), client_name: name, redirect_uris: rec.redirect_uris,
    grant_types: grants, response_types: ["code"], token_endpoint_auth_method: method, ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
  }, 201);
}

async function clientById(id) {
  if (!CLIENT_RE.test(String(id || ""))) return null;
  return data(await getRaw(K.client(id)));
}

// The client a token or revoke request speaks for: its id (form or Basic),
// and its secret when it has one. → client | null
async function clientOf(ctx, f) {
  let id = typeof f.client_id === "string" ? f.client_id : "";
  let secret = typeof f.client_secret === "string" ? f.client_secret : "";
  const basic = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(ctx.req.headers.get("authorization") || "");
  if (basic) {
    const [u, p] = Buffer.from(basic[1], "base64").toString("utf8").split(":");
    try { id = decodeURIComponent(u || ""); secret = decodeURIComponent(p || ""); } catch { return null; }
  }
  const c = await clientById(id);
  if (!c) return null;
  if (c.secret_sha256) {
    if (!TOKEN_RE.test(secret) || !sameText(sha(secret), c.secret_sha256)) return null;
  }
  return c;
}

// ------------------------------------------------------------ /authorize

const SCOPE_RE = /^[\x21\x23-\x5b\x5d-\x7e]{1,40}$/;
export const scopesAsked = (s) => {
  const asked = String(s || "").split(" ").filter((x) => SCOPE_RE.test(x));
  const known = asked.filter((x) => OAUTH_SCOPES.includes(x));
  return known.length ? [...new Set(known)] : [...OAUTH_SCOPES];
};
const backTo = (uri, params) => {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, v);
  return u.href;
};

export async function authorize(ctx) {
  const q = ctx.query;
  const client = await clientById(q.get("client_id"));
  if (!client) return errorPage("This app isn't registered with the CRM. Remove the connector in Claude and add it again.");
  const asked = q.get("redirect_uri") || (client.redirect_uris.length === 1 ? client.redirect_uris[0] : "");
  const uri = matchRedirect(client.redirect_uris, asked);
  if (!uri) return errorPage("That app asked to be sent somewhere it didn't register. Nothing was shared.");
  // from here on, problems go back to the app (its registered address)
  const state = q.get("state") || "";
  const iss = issuerOf(ctx);
  const back = (error, description) => redirect(backTo(uri, { error, error_description: description, state, iss }));
  if (state.length > 1024 || /[\u0000-\u001f]/.test(state)) return back("invalid_request", "state is too long");
  if (q.get("response_type") !== "code") return back("unsupported_response_type", "only code");
  const challenge = q.get("code_challenge") || "";
  if (q.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) return back("invalid_request", "PKCE with S256 is required");
  const resource = q.get("resource");
  if (resource && resource.replace(/\/+$/, "") !== resourceOf(ctx)) return back("invalid_target", "unknown resource");
  const rid = "bcrq_" + randomBytes(16).toString("hex");
  await settledWrite(K.req(rid), {
    client_id: client.client_id, client_name: client.client_name, redirect_uri: uri, code_challenge: challenge, state, scopes: scopesAsked(q.get("scope")),
    resource: resourceOf(ctx), created_at: nowIso(), expires_at: new Date(nowMs() + REQ_TTL_MS).toISOString(),
  }, { onlyIfNew: true });
  const screen = `/crm#/claude-connect/${rid}`;
  const signedIn = await lookupSession(ctx.req).catch(() => null);
  return redirect(signedIn ? screen : `/crm/login?to=${encodeURIComponent(screen)}`);
}

// ------------------------------------------------------------ the consent screen (session routes)

async function liveRequest(rid) {
  if (!REQ_RE.test(String(rid || ""))) return null;
  const got = await getRaw(K.req(rid));
  const r = data(got);
  if (!r || r.used_at || expired(r.expires_at)) return null;
  return { r, etag: got.etag };
}

// The permissions a grant carries: the read ones the person holds, plus
// (when asking is allowed) the ones the asking tools need that they hold.
export function grantPerms(user, permissions, { ask, askPerms }) {
  const held = (p) => holds(user, p, permissions) === true;
  const read = DEFAULT_READ_SCOPES.filter(held);
  const write = ask ? (askPerms || []).filter((p) => !NEVER_KEY_SCOPES.includes(p) && held(p)) : [];
  return [...new Set([...read, ...write])].sort();
}

export async function requestInfo(ctx, askPerms) {
  const got = await liveRequest(ctx.params.rid);
  if (!got) throw new NotFoundError("This sign-in link has expired. Start again from Claude.");
  const { r } = got;
  const canAsk = grantPerms(ctx.user, ctx.permissions, { ask: true, askPerms }).some((p) => !DEFAULT_READ_SCOPES.includes(p));
  return {
    data: {
      client_name: r.client_name, goes_back_to: hostWords(r.redirect_uri), claude: (() => { try { return ASK_HOSTS.has(new URL(r.redirect_uri).hostname); } catch { return false; } })(),
      scopes: r.scopes, wants_ask: r.scopes.includes("crm:ask"), can_ask: canAsk, expires_at: r.expires_at,
      you: ctx.user.first_name || String(ctx.user.name || ctx.user.login || "").split(" ")[0],
    },
  };
}

// Used once: the request is marked used before anything is made from it.
async function takeRequest(rid) {
  const got = await liveRequest(rid);
  if (!got) throw new NotFoundError("This sign-in link has expired. Start again from Claude.");
  const w = await settledWrite(K.req(rid), { ...got.r, used_at: nowIso() }, { onlyIfMatch: got.etag });
  if (!w.ok) throw new ConflictError("This was already answered.");
  return got.r;
}

export async function approve(ctx, askPerms) {
  const b = ctx.body || {};
  const r = await takeRequest(ctx.params.rid);
  const ask = b.ask === true && r.scopes.includes("crm:ask");
  const perms = grantPerms(ctx.user, ctx.permissions, { ask, askPerms });
  if (!perms.length) throw new ForbiddenError("Your account can't share anything with Claude.");
  const scope = ask && perms.some((p) => !DEFAULT_READ_SCOPES.includes(p)) ? "crm:read crm:ask" : "crm:read";
  const gid = newId("api_key");
  const at = nowIso();
  const code = token(TOKEN_PREFIX.code);
  const grant = {
    id: gid, user_id: ctx.user.id, client_id: r.client_id, client_name: r.client_name, redirect_uri: r.redirect_uri, scope, perms, resource: r.resource,
    epoch: ctx.user.session_epoch || 0, gen: 0, code_sha256: sha(code), created_at: at, last_used_at: null,
  };
  const g = await settledWrite(K.grant(gid), grant, { onlyIfNew: true });
  if (!g.ok) throw new ConflictError("Try again.");
  await settledWrite(K.code(sha(code)), {
    grant_id: gid, client_id: r.client_id, redirect_uri: r.redirect_uri, code_challenge: r.code_challenge, resource: r.resource, created_at: at, expires_at: new Date(nowMs() + CODE_TTL_MS).toISOString(),
  }, { onlyIfNew: true });
  await appendEvent("user", ctx.user.id, { action: "claude_connected", by: ctx.user.id, origin: "api", grant_id: gid, scope, app: r.client_name }).catch(() => {});
  return { data: { redirect_url: backTo(r.redirect_uri, { code, state: r.state, iss: issuerOf(ctx) }), scope } };
}

export async function deny(ctx) {
  const r = await takeRequest(ctx.params.rid);
  return { data: { redirect_url: backTo(r.redirect_uri, { error: "access_denied", error_description: "The owner said no", state: r.state, iss: issuerOf(ctx) }) } };
}

// ------------------------------------------------------------ /token

async function issueTokens(grant) {
  const access = token(TOKEN_PREFIX.access);
  const refresh = token(TOKEN_PREFIX.refresh);
  const t = nowMs();
  await settledWrite(K.at(sha(access)), { grant_id: grant.id, client_id: grant.client_id, user_id: grant.user_id, resource: grant.resource, expires_at: new Date(t + ACCESS_TTL_S * 1000).toISOString() }, { onlyIfNew: true });
  await settledWrite(K.rt(sha(refresh)), { grant_id: grant.id, client_id: grant.client_id, gen: grant.gen, expires_at: new Date(t + REFRESH_TTL_DAYS * 86400000).toISOString() }, { onlyIfNew: true });
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: grant.scope };
}

async function readGrant(id) {
  if (!isId(id, "api_key")) return null;
  const got = await getRaw(K.grant(id));
  const g = data(got);
  return g ? { g, etag: got.etag } : null;
}

// Disconnects a grant: its record goes, so every token of it stops at once
// (the sweep deletes the token records later).
export async function revokeGrant(id, why = "revoked", by = null) {
  const got = await readGrant(id);
  if (!got) return false;
  await deleteRaw(K.grant(id));
  await appendEvent("user", got.g.user_id, { action: "claude_disconnected", by: by || got.g.user_id, origin: "api", grant_id: id, why }).catch(() => {});
  return true;
}

export async function tokenEndpoint(ctx) {
  const f = fieldsOf(ctx);
  if (!f) return oauthError("invalid_request", "Send a form.");
  const client = await clientOf(ctx, f);
  if (!client) return oauthError("invalid_client", "Unknown app, or its secret is wrong.", 401, { "WWW-Authenticate": 'Basic realm="barta-crm"' });
  if (f.resource && String(f.resource).replace(/\/+$/, "") !== resourceOf(ctx)) return oauthError("invalid_target", "Unknown resource.");
  if (f.grant_type === "authorization_code") {
    const code = String(f.code || "");
    if (!TOKEN_RE.test(code) || !code.startsWith(TOKEN_PREFIX.code)) return oauthError("invalid_grant", "That code isn't valid.");
    const got = await getRaw(K.code(sha(code)));
    const c = data(got);
    if (!c || c.client_id !== client.client_id) return oauthError("invalid_grant", "That code isn't valid.");
    if (c.used_at) {
      // a code used twice: whatever the first use made is cut off (RFC 6749 §4.1.2)
      await revokeGrant(c.grant_id, "code_reused");
      return oauthError("invalid_grant", "That code was already used.");
    }
    if (expired(c.expires_at)) return oauthError("invalid_grant", "That code expired. Connect again.");
    if (typeof f.redirect_uri === "string" && f.redirect_uri !== c.redirect_uri) return oauthError("invalid_grant", "The redirect URI doesn't match.");
    const verifier = String(f.code_verifier || "");
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !sameText(b64urlSha(verifier), c.code_challenge)) return oauthError("invalid_grant", "The PKCE verifier doesn't match.");
    const w = await settledWrite(K.code(sha(code)), { ...c, used_at: nowIso() }, { onlyIfMatch: got.etag });
    if (!w.ok) return oauthError("invalid_grant", "That code was already used.");
    const gg = await readGrant(c.grant_id);
    if (!gg || gg.g.client_id !== client.client_id) return oauthError("invalid_grant", "That connection was removed.");
    return oauthJson(await issueTokens(gg.g));
  }
  if (f.grant_type === "refresh_token") {
    const rtok = String(f.refresh_token || "");
    if (!TOKEN_RE.test(rtok) || !rtok.startsWith(TOKEN_PREFIX.refresh)) return oauthError("invalid_grant", "That refresh token isn't valid.");
    const got = await getRaw(K.rt(sha(rtok)));
    const rt = data(got);
    if (!rt || rt.client_id !== client.client_id || expired(rt.expires_at)) return oauthError("invalid_grant", "That refresh token isn't valid. Connect again.");
    const gg = await readGrant(rt.grant_id);
    if (!gg || gg.g.client_id !== client.client_id) return oauthError("invalid_grant", "That connection was removed. Connect again.");
    if (rt.gen !== gg.g.gen || rt.used_at) {
      // an old refresh token came back: someone kept a copy. Cut the connection.
      await revokeGrant(gg.g.id, "refresh_reused");
      return oauthError("invalid_grant", "That refresh token was already used. Connect again.");
    }
    const user = await activeUser(gg.g);
    if (!user) return oauthError("invalid_grant", "That account can't connect any more.");
    // the old one is kept, marked used, until it expires: if it ever comes back, that's a copy
    const used = await settledWrite(K.rt(sha(rtok)), { ...rt, used_at: nowIso() }, { onlyIfMatch: got.etag });
    if (!used.ok) return oauthError("invalid_grant", "That refresh token was just used. Connect again.");
    const next = { ...gg.g, gen: gg.g.gen + 1 };
    const w = await settledWrite(K.grant(gg.g.id), next, { onlyIfMatch: gg.etag });
    if (!w.ok) return oauthError("invalid_grant", "That refresh token was just used. Connect again.");
    return oauthJson(await issueTokens(next));
  }
  return oauthError("unsupported_grant_type", "authorization_code or refresh_token.");
}

// RFC 7009: a refresh or access token of this client disconnects its grant. Always 200.
export async function revokeEndpoint(ctx) {
  const f = fieldsOf(ctx) || {};
  const client = await clientOf(ctx, f);
  if (!client) return oauthError("invalid_client", "Unknown app.", 401);
  const t = String(f.token || "");
  if (TOKEN_RE.test(t)) {
    const rec = t.startsWith(TOKEN_PREFIX.refresh) ? data(await getRaw(K.rt(sha(t)))) : t.startsWith(TOKEN_PREFIX.access) ? data(await getRaw(K.at(sha(t)))) : null;
    if (rec && rec.client_id === client.client_id) await revokeGrant(rec.grant_id, "app_revoked");
  }
  return new Response(null, { status: 200, headers: { ...CORS, ...NO_STORE } });
}

export const preflight = () => new Response(null, { status: 204, headers: CORS });

// ------------------------------------------------------------ the MCP endpoint's side

async function activeUser(grant) {
  const rec = await getRecord("user", grant.user_id);
  const u = rec && rec.data;
  if (!u || u.status !== "active") return null;
  if ((u.session_epoch || 0) !== (grant.epoch || 0)) return null;     // signed out everywhere, or a new password
  return u;
}

// An access token → { user, apiKey } as a key would give, or null. The
// "key" is the grant: kind "oauth" (asks allowed, like a header key),
// scopes = the grant's permissions. Over its calls a minute → RateLimited.
export async function lookupAccessToken(ctx, raw) {
  if (!TOKEN_RE.test(String(raw || "")) || !raw.startsWith(TOKEN_PREFIX.access)) return null;
  const at = data(await getRaw(K.at(sha(raw))));
  if (!at || expired(at.expires_at)) return null;
  if (at.resource && at.resource !== resourceOf(ctx)) return null;
  const gg = await readGrant(at.grant_id);
  if (!gg || gg.g.client_id !== at.client_id || gg.g.user_id !== at.user_id) return null;
  const user = await activeUser(gg.g);
  if (!user) return null;
  const key = { id: gg.g.id, user_id: user.id, kind: "oauth", name: `${gg.g.client_name} (connected)`.slice(0, 60), scopes: gg.g.perms, rate_per_min: DEFAULT_RATE_PER_MIN, last4: "", created_at: gg.g.created_at };
  await checkKeyRate(key);
  // the last use, once a day at most
  if (!gg.g.last_used_at || localDate(new Date(gg.g.last_used_at)) !== localDate(new Date(nowMs()))) {
    settledWrite(K.grant(gg.g.id), { ...gg.g, last_used_at: nowIso() }, { onlyIfMatch: gg.etag }).catch(() => {});
  }
  return { user, apiKey: key };
}

// ------------------------------------------------------------ Settings → Claude connector

const grantView = (g, names) => ({
  id: g.id, app: g.client_name, goes_back_to: hostWords(g.redirect_uri), scope: g.scope, can_ask: g.scope.includes("crm:ask"),
  created_at: g.created_at, last_used_at: g.last_used_at || null, user_id: g.user_id, ...(names ? { person: names.get(g.user_id) || "" } : {}),
});
async function allGrants() {
  const keys = (await listKeys("oauth/grant/")).slice(0, 200);
  const out = [];
  for (const k of keys) { const g = data(await getRaw(k).catch(() => null)); if (g) out.push(g); }
  return out.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}
// The person's connections; an owner (users:manage) sees everyone's.
export async function listGrants(ctx) {
  const everyone = ctx.can("users:manage");
  const list = (await allGrants()).filter((g) => everyone || g.user_id === ctx.user.id);
  let names = null;
  if (everyone) {
    names = new Map();
    for (const uid of new Set(list.map((g) => g.user_id))) { const u = await getRecord("user", uid).catch(() => null); if (u) names.set(uid, u.data.first_name || u.data.name || u.data.login); }
  }
  return { data: list.map((g) => grantView(g, names)) };
}
export async function deleteGrant(ctx) {
  const got = await readGrant(ctx.params.id);
  if (!got || (got.g.user_id !== ctx.user.id && !ctx.can("users:manage"))) throw new NotFoundError("That connection isn't there.");
  await revokeGrant(got.g.id, "settings", ctx.user.id);
  return { data: { ok: true } };
}

// ------------------------------------------------------------ mcp.oauth_cleanup (nightly)

export async function cleanup(ctx = {}) {
  const t = nowMs();
  const left = () => !ctx.budget || ctx.budget.left() > 3000;
  const grants = new Set((await listKeys("oauth/grant/")).map((k) => k.slice("oauth/grant/".length)));
  const usedClients = new Set();
  for (const id of grants) { const g = data(await getRaw(K.grant(id)).catch(() => null)); if (g) usedClients.add(g.client_id); }
  let removed = 0;
  for (const [prefix, dead] of [
    ["oauth/req/", (r) => Date.parse(r.expires_at) + 86400000 < t],
    ["oauth/code/", (r) => Date.parse(r.expires_at) + 86400000 < t || !grants.has(r.grant_id)],
    ["oauth/at/", (r) => Date.parse(r.expires_at) < t || !grants.has(r.grant_id)],
    ["oauth/rt/", (r) => Date.parse(r.expires_at) < t || !grants.has(r.grant_id)],
    ["oauth/client/", (r) => !usedClients.has(r.client_id) && Date.parse(r.created_at) + CLIENT_UNUSED_DAYS * 86400000 < t],
  ]) {
    for (const k of await listKeys(prefix)) {
      if (!left()) return { done: false, removed };
      const r = data(await getRaw(k).catch(() => null));
      if (!r || dead(r)) { await deleteRaw(k).catch((e) => console.error(`crm:mcp: oauth clean-up (${safeErr(e)})`)); removed += 1; }
    }
  }
  return { done: true, result: { removed } };
}

export { RateLimited };

// ------------------------------------------------------------ routes

// Served by crm-auth.mjs (/api/crm/auth/*, behind the platform rate limit).
// They check their own credentials (auth "hook": no cookie is ever read
// except /authorize looking whether the person is signed in to pick the
// next page), never keep an Idempotency-Key answer (secret), and answer CORS.
const oroute = (method, path, handler, more = {}) => ({ method, path, auth: "hook", perm: null, subject: "none", mode: "inline", handler, idempotent: false, secret: true, ...more });
export const OAUTH_AUTH_ROUTES = Object.freeze([
  oroute("POST", "/auth/oauth/register", registerClient, { body: "raw", maxBody: 16384, maxCalls: 12 }),
  oroute("GET", "/auth/oauth/authorize", authorize, { maxCalls: 15 }),
  oroute("POST", "/auth/oauth/token", tokenEndpoint, { body: "raw", maxBody: 16384, maxCalls: 25 }),
  oroute("POST", "/auth/oauth/revoke", revokeEndpoint, { body: "raw", maxBody: 16384, maxCalls: 15 }),
  ...["register", "token", "revoke"].map((p) => oroute("OPTIONS", `/auth/oauth/${p}`, preflight, { body: "none" })),
]);
