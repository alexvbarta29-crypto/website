// Barta CRM core: who is calling, and the sign-in endpoints (design §4,
// §4.11). Served by netlify/functions/crm-auth.mjs (/api/crm/auth/*, behind
// the platform rate limit) through the same pipeline as every other route
// (core/router.mjs).
//
// - authenticate(): the session cookie barta_crm, an API key
//   (Authorization: Bearer bcrm_...), or the office cookie barta_office
//   (lights-auth.mjs, untouched), per the route's `auth`.
// - First-owner bootstrap (§4.4): needs the office cookie AND the one-time
//   CRM_SETUP_CODE (a Production-only env var), and works once: sys/bootstrap
//   is claimed with onlyIfNew, so two phones racing create one owner. No
//   office token is ever stored.
// - Sign-in (§4.8): throttle first, then PBKDF2 (a dummy hash for an unknown
//   login, so timing and wording never say whether a login exists).
// - D14 (§2.4): an optional office password on the Team sign-in sets
//   barta_office exactly as POST /office does, for the roles in
//   cfg/auth.office_cookie_roles (default ["owner"]).
// - Invites and resets: a one-time link {userId}.{token}; only the token's
//   sha256 is kept on the user, for 7 days.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { signedIn as officeSignedIn, derive, sha256 as officeSha, same, expected, cookieFor as officeCookieFor, ONE_YEAR } from "../../lights-auth.mjs";
import { getRecord, readPointer, createRecord, updateRecord, getRaw, settledWrite, appendEvent, getSetting } from "../../crm-store.mjs";
import { InputError, ForbiddenError, ConflictError } from "./errors.mjs";
import { nowIso, nowMs } from "./clock.mjs";
import { newId, isId } from "./ids.mjs";
import { CANONICAL_ORIGIN } from "./context.mjs";
import { checkPolicy, hashPassword, verifyPassword, dummyCheck } from "./passwords.mjs";
import { lookupSession, createSession, revokeSession, bumpAuthEpoch, readAuthEpoch, deviceId, newDeviceCookie, clearSessionCookie, forgetUser, ipHash } from "./sessions.mjs";
import { checkThrottle, recordFailure, recordSuccess } from "./throttle.mjs";
import { permsFor } from "./perms.mjs";
import { lookupApiKey, touchApiKey } from "./apikeys.mjs";
import { safeTo, clientIp, uaFamily, fail, withCookies } from "./http.mjs";
import { publicUser, normLogin, USER_COLORS, LOGIN_RE } from "../modules/system/types.mjs";

export { officeSignedIn };

export const BOOTSTRAP_KEY = "sys/bootstrap";
export const INVITE_DAYS = 7;
export const BOOTSTRAP_STALE_MS = 2 * 60 * 1000;
export const BAD_LOGIN = "That login or password isn't right.";

const sha = (s) => createHash("sha256").update(String(s)).digest("hex");
const sameSecret = (a, b) => {
  const x = Buffer.from(sha(a), "hex"), y = Buffer.from(sha(b), "hex");
  return timingSafeEqual(x, y);
};

// ------------------------------------------------------------ setup state

// The Production-only settings the CRM still needs here, by name (never a
// value). Outside production the store uses its own fixed dev salt.
export function missingSetup(deploy, env = process.env, { bootstrapped = true } = {}) {
  const out = [];
  if (deploy && deploy.ctx === "production") {
    if (env.CRM_PRODUCTION !== "1") out.push("CRM_PRODUCTION");
    if (!env.CRM_KEY_SALT) out.push("CRM_KEY_SALT");
  }
  if (!bootstrapped && !env.CRM_SETUP_CODE) out.push("CRM_SETUP_CODE");
  return out;
}
// The CRM's stores cannot be used at all (production without its settings).
export const storeBlocked = (deploy, env = process.env) => missingSetup(deploy, env).length > 0;

export async function readBootstrap(opts = {}) {
  const got = await getRaw(BOOTSTRAP_KEY, opts);
  return got && got.data ? { ...got.data, etag: got.etag } : null;
}
export const bootstrapDone = (b) => !!b && b.state === "done";

// ------------------------------------------------------------ permissions doc

let permsCache = null;   // { epoch, data }
// cfg/permissions (owner-only), cached per warm instance until sys/auth-epoch moves.
export async function loadPermissions(opts = {}) {
  const epoch = await readAuthEpoch(opts);
  if (permsCache && permsCache.epoch === epoch) return permsCache.data;
  let data = null;
  try { data = await getSetting("permissions", opts); } catch { data = null; }
  permsCache = { epoch, data };
  return data;
}
export function clearPermissionsCache() { permsCache = null; }

// ------------------------------------------------------------ authenticate

const BEARER_RE = /^Bearer\s+(\S+)$/i;

// → { user, userEtag, session, sessionHash } | { user, apiKey } | { office: true } | null
export async function authenticate(req, auth, opts = {}) {
  const tryOffice = () => (officeSignedIn(req) ? { office: true } : null);
  const trySession = async () => {
    const s = await lookupSession(req, opts);
    return s ? { user: s.user, userEtag: s.userEtag, session: s.session, sessionHash: s.hash } : null;
  };
  const tryKey = async () => {
    const m = BEARER_RE.exec(req.headers.get("authorization") || "");
    if (!m) return null;
    const key = await lookupApiKey(m[1], opts);
    if (!key) return null;
    const rec = await getRecord("user", key.user_id, opts);
    const user = rec && rec.data;
    if (!user || user.status !== "active") return null;
    touchApiKey(key, opts).catch(() => {});
    return { user, apiKey: key };
  };
  switch (auth) {
    case "public": case "hook": return {};
    case "session": return trySession();
    case "key": return tryKey();
    case "session_or_key": return (await trySession()) || (await tryKey());
    case "office_cookie": return tryOffice();
    case "session_or_office": return (await trySession()) || tryOffice();
    default: return null;
  }
}

// What the app learns about the signed-in person.
export function whoAmI(user, permissions = null) {
  return { user: publicUser(user, { full: true }), perms: permsFor(user, permissions) };
}

// ------------------------------------------------------------ helpers

const writeCtx = (ctx, by) => ({ by: by || (ctx.user && ctx.user.id) || "system", origin: "api", actor_kind: "user", requestId: ctx.requestId });

function auditAuth(userId, action, ctx, extra = {}) {
  if (!isId(userId, "user")) return Promise.resolve();
  return appendEvent("user", userId, { action, by: userId, origin: "api", ua: uaFamily(ctx.req.headers.get("user-agent")), ip_hash: ipHash(clientIp(ctx.req, ctx.context)), ...extra }).catch(() => {});
}

async function userByLogin(login, opts) {
  if (!LOGIN_RE.test(login)) return null;
  const ptr = await readPointer("login", login, opts);
  if (!ptr || !isId(ptr.id, "user")) return null;
  const rec = await getRecord("user", ptr.id, opts);
  return rec && rec.data && rec.data.login === login ? rec.data : null;
}

// The origin links point at: the canonical site in production, else the request's own.
export function linkOrigin(ctx) {
  return ctx.deploy && ctx.deploy.prod ? CANONICAL_ORIGIN : ctx.url.origin;
}

export function newInvite(kind = "invite") {
  const token = randomBytes(32).toString("base64url");
  return { token, invite: { token_hash: sha(token), expires_at: new Date(nowMs() + INVITE_DAYS * 86400000).toISOString(), kind, created_at: nowIso() } };
}

// "{userId}.{token}" → { uid, token } or null.
export function parseInviteToken(s) {
  const v = String(s || "");
  const dot = v.indexOf(".");
  if (dot <= 0) return null;
  const uid = v.slice(0, dot), token = v.slice(dot + 1);
  return isId(uid, "user") && /^[A-Za-z0-9_-]{43}$/.test(token) ? { uid, token } : null;
}

// The user an invite link opens, or null (unknown, used, expired, disabled).
export async function inviteTarget(raw, opts = {}) {
  const p = parseInviteToken(raw);
  if (!p) return null;
  const rec = await getRecord("user", p.uid, opts);
  const u = rec && rec.data;
  if (!u || u.status === "disabled" || !u.invite || !u.invite.token_hash) return null;
  if (!(Date.parse(u.invite.expires_at) > nowMs())) return null;
  if (!sameSecret(u.invite.token_hash, sha(p.token))) return null;
  return { user: u, etag: rec.etag, token: p.token };
}

const gone = (message) => fail("gone", message, 410);

// ------------------------------------------------------------ handlers

async function login(ctx) {
  const b = ctx.body || {};
  const typed = String(b.login ?? "").trim().toLowerCase().slice(0, 64);
  const password = typeof b.password === "string" ? b.password : "";
  if (!typed) throw new InputError("Type your login.", "login");
  if (!password) throw new InputError("Type your password.", "password");
  if (password.length > 256) throw new InputError(BAD_LOGIN, "password");
  const to = safeTo(b.to);
  const cookies = [];
  const device = deviceId(ctx.req);
  if (!device) cookies.push(newDeviceCookie().cookie);
  const ip = clientIp(ctx.req, ctx.context);
  const who = { login: typed, device, ip };
  const th = await checkThrottle(who);
  if (!th.ok) {
    const wait = th.retry_after_s;
    const words = wait >= 120 ? `${Math.ceil(wait / 60)} minutes` : `${wait} seconds`;
    return withCookies(fail("throttled", `Too many tries. Wait ${words}, then try again.`, 429, { headers: { "Retry-After": String(wait) }, details: { retry_after_s: wait } }), cookies);
  }
  const user = await userByLogin(typed);
  const check = user && user.password ? await verifyPassword(password, user.password) : await dummyCheck(password);
  if (!check.ok || !user || user.status !== "active") {
    await recordFailure(who).catch(() => {});
    if (user) await auditAuth(user.id, "sign_in_failed", ctx);
    return withCookies(fail("bad_login", BAD_LOGIN, 401), cookies);
  }
  await recordSuccess(who).catch(() => {});
  const upgraded = check.upgrade ? await hashPassword(password) : null;
  let fresh = user;
  try {
    const r = await updateRecord("user", user.id, (u) => ({ ...u, last_sign_in_at: nowIso(), ...(upgraded ? { password: upgraded } : {}) }), writeCtx(ctx, user.id));
    fresh = r.data;
  } catch { /* the sign-in still counts */ }
  const ses = await createSession(fresh, ctx.req, ctx.context);
  cookies.push(ses.cookie);
  // D14: the office password also opens the office tools on this phone.
  let office = null;
  if (typeof b.office_password === "string" && b.office_password) {
    let roles = ["owner"];
    try { const a = await getSetting("auth"); if (Array.isArray(a.office_cookie_roles)) roles = a.office_cookie_roles; } catch { /* defaults */ }
    office = false;
    if (roles.includes(fresh.role) && b.office_password.length <= 256) {
      const token = derive(b.office_password);
      if (same(officeSha(token), expected())) { office = true; cookies.push(officeCookieFor(token, ONE_YEAR)); }
    }
  }
  await auditAuth(fresh.id, "sign_in", ctx, { office: office === true });
  const permissions = await loadPermissions().catch(() => null);
  return { data: { ...whoAmI(fresh, permissions), to, office_cookie: office }, cookies };
}

async function logout(ctx) {
  await revokeSession(ctx.sessionHash).catch(() => {});
  await auditAuth(ctx.user.id, "sign_out", ctx);
  return { data: { to: "/crm/login" }, cookies: [clearSessionCookie()] };
}

async function logoutAll(ctx) {
  await updateRecord("user", ctx.user.id, (u) => ({ ...u, session_epoch: (u.session_epoch || 0) + 1 }), writeCtx(ctx));
  forgetUser(ctx.user.id);
  await bumpAuthEpoch("sign_out_all");
  await auditAuth(ctx.user.id, "sign_out_all", ctx);
  return { data: { to: "/crm/login" }, cookies: [clearSessionCookie()] };
}

async function changePassword(ctx) {
  const b = ctx.body || {};
  const user = ctx.user;
  const current = typeof b.current === "string" ? b.current : "";
  const check = await verifyPassword(current, user.password);
  if (!check.ok) throw new InputError("Your current password isn't right.", "current");
  checkPolicy(b.next, { login: user.login, name: user.name });
  if (b.next === current) throw new InputError("Pick a new password.", "next");
  const pw = await hashPassword(b.next);
  const r = await updateRecord("user", user.id, (u) => ({ ...u, password: pw, session_epoch: (u.session_epoch || 0) + 1 }), writeCtx(ctx));
  forgetUser(user.id);
  await bumpAuthEpoch("password");
  await revokeSession(ctx.sessionHash).catch(() => {});
  const ses = await createSession(r.data, ctx.req, ctx.context);
  await auditAuth(user.id, "password_changed", ctx);
  return { data: { ok: true }, cookies: [ses.cookie] };
}

async function setup(ctx) {
  const b = ctx.body || {};
  if (!officeSignedIn(ctx.req)) throw new ForbiddenError("Sign in to Barta Office with the office password first.");
  const code = String(process.env.CRM_SETUP_CODE || "").trim();
  if (!code) return fail("setup_needed", "Add CRM_SETUP_CODE in Netlify first (Production only).", 503);
  const boot = await readBootstrap();
  if (bootstrapDone(boot)) return gone("Setup is done. Ask an owner to invite you.");
  const ip = clientIp(ctx.req, ctx.context);
  const who = { login: "setup", device: deviceId(ctx.req), ip };
  const th = await checkThrottle(who);
  if (!th.ok) return fail("throttled", "Too many tries. Wait a few minutes, then try again.", 429, { headers: { "Retry-After": String(th.retry_after_s) } });
  if (typeof b.setup_code !== "string" || !sameSecret(b.setup_code.trim(), code)) {
    await recordFailure(who).catch(() => {});
    throw new InputError("That setup code isn't right.", "setup_code");
  }
  const name = String(b.name ?? "").trim();
  if (!name) throw new InputError("Type your name.", "name");
  const login = normLogin(b.login);
  checkPolicy(b.password, { login, name });
  const uid = newId("user");
  // Claim the bootstrap first: two phones racing create one owner. A claim
  // left pending by a request that died (no owner record after 2 minutes)
  // may be taken over.
  const claim = { state: "pending", user_id: uid, at: nowIso() };
  let w = await settledWrite(BOOTSTRAP_KEY, claim, { onlyIfNew: true });
  if (!w.ok) {
    const cur = w.current && w.current.data;
    const staleClaim = cur && cur.state === "pending" && Date.parse(cur.at) + BOOTSTRAP_STALE_MS < nowMs() && !(await getRecord("user", cur.user_id));
    if (!staleClaim) {
      if (cur && cur.state === "pending") throw new ConflictError("Setup is already running on another phone. Wait a minute, then reload.");
      return gone("Setup is done. Ask an owner to invite you.");
    }
    w = await settledWrite(BOOTSTRAP_KEY, claim, { onlyIfMatch: w.current.etag });
    if (!w.ok) throw new ConflictError("Setup is already running on another phone. Wait a minute, then reload.");
  }
  const pw = await hashPassword(b.password);
  const created = await createRecord("user", {
    id: uid, login, name, role: "owner", status: "active", is_technician: b.is_technician === true,
    color: USER_COLORS[0], password: pw, session_epoch: 0, grants: [], denies: [], last_sign_in_at: nowIso(),
  }, writeCtx(ctx, uid));
  const cur = await getRaw(BOOTSTRAP_KEY);
  if (cur && cur.data && cur.data.user_id === uid) {
    await settledWrite(BOOTSTRAP_KEY, { state: "done", user_id: uid, at: cur.data.at, done_at: nowIso() }, { onlyIfMatch: cur.etag }).catch(() => {});
  }
  await recordSuccess(who).catch(() => {});
  const ses = await createSession(created.data, ctx.req, ctx.context);
  await auditAuth(uid, "setup", ctx);
  return { status: 201, data: { ...whoAmI(created.data), to: "/office#crm" }, cookies: [ses.cookie] };
}

async function inviteInfo(ctx) {
  const t = await inviteTarget(ctx.params.token);
  if (!t) return gone("This link has expired or was already used. Ask Alex or Jacob for a new one.");
  return { data: { name: t.user.name, first_name: t.user.first_name, login: t.user.login, kind: t.user.invite.kind || "invite" } };
}

async function acceptInvite(ctx) {
  const b = ctx.body || {};
  const t = await inviteTarget(b.token);
  if (!t) return gone("This link has expired or was already used. Ask Alex or Jacob for a new one.");
  checkPolicy(b.password, { login: t.user.login, name: t.user.name });
  const pw = await hashPassword(b.password);
  const hash = t.user.invite.token_hash;
  const r = await updateRecord("user", t.user.id, (u) => {
    if (!u.invite || u.invite.token_hash !== hash || u.status === "disabled") return null;   // used meanwhile: single use
    const { invite, ...rest } = u;
    return { ...rest, password: pw, status: "active", last_sign_in_at: nowIso(), session_epoch: (u.session_epoch || 0) + (invite.kind === "reset" ? 1 : 0) };
  }, writeCtx(ctx, t.user.id));
  if (!r.changed) return gone("This link has expired or was already used. Ask Alex or Jacob for a new one.");
  forgetUser(t.user.id);
  if ((t.user.invite.kind || "invite") === "reset") await bumpAuthEpoch("reset");
  const ses = await createSession(r.data, ctx.req, ctx.context);
  await auditAuth(t.user.id, t.user.invite.kind === "reset" ? "password_reset" : "invite_accepted", ctx);
  return { data: { ...whoAmI(r.data), to: "/crm" }, cookies: [ses.cookie] };
}

// Routes served by crm-auth.mjs (paths under /api/crm). `account:own` is the
// permission every role holds for its own account (§4.11 "session").
const route = (method, path, auth, perm, handler, more = {}) => ({ method, path, auth, perm, subject: "none", mode: "inline", handler, ...more });
export const AUTH_ROUTES = Object.freeze([
  route("POST", "/auth/login", "public", null, login, { maxCalls: 40, idempotent: false }),
  route("POST", "/auth/logout", "session", "account:own", logout, { idempotent: false }),
  route("POST", "/auth/logout-all", "session", "account:own", logoutAll, { idempotent: false, maxCalls: 40 }),
  route("POST", "/auth/password", "session", "account:own", changePassword, { idempotent: false, maxCalls: 40 }),
  route("POST", "/auth/setup", "public", null, setup, { maxCalls: 50, idempotent: false }),
  route("GET", "/auth/invite/:token", "public", null, inviteInfo),
  route("POST", "/auth/invite", "public", null, acceptInvite, { maxCalls: 40, idempotent: false }),
]);
