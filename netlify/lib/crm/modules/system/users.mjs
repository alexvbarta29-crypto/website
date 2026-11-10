// Core "system" module: the team (design §4.1, §4.4, §4.11). Owners add a
// person (name, login, role), hand them a one-time invite link, reset a
// forgotten password with the same kind of link, disable and enable
// accounts, change roles, and see or end anyone's sessions. Everyone may
// edit their own name, phone and notification choices.
//
// Rules that keep the business from locking itself out: nobody disables or
// demotes themself, and the last active owner cannot be disabled or demoted.
// A role, grant or deny change, a disable and a reset bump the person's
// session_epoch and sys/auth-epoch, so it takes effect on every phone
// within seconds (§4.3).

import { createRecord, updateRecord, getRecord, readIndex, appendEvent } from "../../../crm-store.mjs";
import { InputError, ForbiddenError, NotFoundError, ConflictError, ExistsError, StaleError } from "../../core/errors.mjs";
import { isId } from "../../core/ids.mjs";
import { bumpAuthEpoch, forgetUser, listSessions, revokeSession } from "../../core/sessions.mjs";
import { newInvite, linkOrigin } from "../../core/auth.mjs";
import { publicUser, normLogin, USER_ROLES, USER_COLORS, DEFAULT_PAY, DEFAULT_NOTIFY } from "./types.mjs";
import { str, bool, email, phoneE164, enumValue } from "../../core/validate.mjs";
import { OWNER_ONLY } from "../../core/perms.mjs";

const self = (ctx, id) => !!ctx.user && ctx.user.id === id;
const manages = (ctx) => ctx.can("users:manage");

async function loadUser(id) {
  if (!isId(id, "user")) throw new NotFoundError("That person isn't on the team.");
  const rec = await getRecord("user", id);
  if (!rec || !rec.data) throw new NotFoundError("That person isn't on the team.");
  return rec;
}

function mustSelfOrManage(ctx, id) {
  if (!self(ctx, id) && !manages(ctx)) throw new ForbiddenError("You don't have access to that.");
}

async function activeOwners() {
  const ix = await readIndex("users", "");
  return ix.rows.filter((r) => r.role === "owner" && r.status === "active").map((r) => r.id);
}

async function audit(ctx, id, action, extra = {}) {
  await appendEvent("user", id, { action, by: ctx.user ? ctx.user.id : "office", origin: "api", ...extra }).catch(() => {});
}

// GET /users — owners: everyone (no emails/phones; the index row); others
// with schedule:read: active people's id, name, color and is_technician.
async function listUsers(ctx) {
  const ix = await readIndex("users", "");
  const rows = ix.rows.slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
  if (manages(ctx)) return { data: rows.map((r) => ({ id: r.id, login: r.login, name: r.name, first_name: r.first_name, role: r.role, status: r.status, is_technician: !!r.is_technician, color: r.color })) };
  return { data: rows.filter((r) => r.status === "active").map((r) => ({ id: r.id, name: r.name, color: r.color, is_technician: !!r.is_technician })) };
}

async function getUser(ctx) {
  mustSelfOrManage(ctx, ctx.params.id);
  const rec = await loadUser(ctx.params.id);
  return { data: publicUser(rec.data, { full: true }), etag: rec.etag };
}

async function nextColor() {
  const ix = await readIndex("users", "");
  const used = new Set(ix.rows.map((r) => r.color));
  return USER_COLORS.find((c) => !used.has(c)) || USER_COLORS[ix.rows.length % USER_COLORS.length];
}

// POST /users { name, login, role, is_technician, email?, phone?, pay? }
async function addUser(ctx) {
  const b = ctx.body || {};
  const name = str(b.name, { field: "name", max: 60, required: true });
  const login = normLogin(b.login);
  const role = enumValue(b.role, USER_ROLES, { field: "role", required: true });
  const data = {
    login, name, role, status: "invited", is_technician: bool(b.is_technician, { field: "is_technician" }),
    color: await nextColor(), password: null, session_epoch: 0, grants: [], denies: [],
    pay: b.pay && typeof b.pay === "object" ? b.pay : { ...DEFAULT_PAY }, notify: { ...DEFAULT_NOTIFY }, availability: [],
  };
  const e = email(b.email, { field: "email" });
  if (e) data.email = e;
  const p = phoneE164(b.phone, { field: "phone" });
  if (p) data.phone = p;
  let created;
  try {
    created = await createRecord("user", data, ctx.write());
  } catch (err) {
    if (err instanceof ExistsError) throw new ConflictError("That login is taken. Try another.");
    throw err;
  }
  return { status: 201, data: publicUser(created.data, { full: true }), etag: created.etag };
}

const SELF_FIELDS = ["name", "first_name", "last_name", "phone", "notify"];
const MANAGE_FIELDS = [...SELF_FIELDS, "email", "login", "role", "is_technician", "color", "grants", "denies", "pay", "availability"];
const AUTH_FIELDS = ["role", "grants", "denies"];

// PATCH /users/:id (If-Match): yourself (name, phone, notifications) or,
// for owners, anyone (role, technician, color, permissions, pay too).
async function patchUser(ctx) {
  const id = ctx.params.id;
  mustSelfOrManage(ctx, id);
  if (!ctx.ifMatch) throw new InputError("This change needs the version you edited (If-Match).", "if-match");
  const b = ctx.body || {};
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new InputError("Expected an object.");
  const allowed = manages(ctx) ? MANAGE_FIELDS : SELF_FIELDS;
  for (const k of Object.keys(b)) if (!allowed.includes(k)) throw new ForbiddenError(`You can't change ${k.replace(/_/g, " ")} here.`);
  const patch = { ...b };
  if ("login" in patch) patch.login = normLogin(patch.login);
  // A role someone sends is one of the three, never a stored oddity (the
  // type's update validator keeps unknown stored enums, so check it here).
  if ("role" in patch) patch.role = enumValue(patch.role, USER_ROLES, { field: "role", required: true });
  if ("name" in patch && !("first_name" in patch) && !("last_name" in patch)) {
    const parts = String(patch.name || "").trim().split(/\s+/).filter(Boolean);
    patch.first_name = parts[0] || "";
    patch.last_name = parts.slice(1).join(" ");
  }
  for (const k of ["grants", "denies"]) {
    if (k in patch && Array.isArray(patch[k]) && patch[k].some((p) => OWNER_ONLY.has(p))) throw new InputError("Owner-only permissions can't be granted.", k);
  }
  const authChange = AUTH_FIELDS.some((k) => k in patch);
  if (authChange && self(ctx, id) && "role" in patch && patch.role !== ctx.user.role) throw new ForbiddenError("You can't change your own role.");
  const cur = await loadUser(id);
  if ("role" in patch && cur.data.role === "owner" && patch.role !== "owner" && cur.data.status === "active") {
    const owners = await activeOwners();
    if (owners.length <= 1) throw new ConflictError("There has to be at least one active owner.");
  }
  let r;
  try {
    r = await updateRecord("user", id, (u) => {
      const next = { ...u, ...patch };
      if (authChange && AUTH_FIELDS.some((k) => JSON.stringify(u[k]) !== JSON.stringify(next[k]))) next.session_epoch = (u.session_epoch || 0) + 1;
      return next;
    }, ctx.write({ ifMatch: ctx.ifMatch }));
  } catch (err) {
    if (err instanceof ExistsError) throw new ConflictError("That login is taken. Try another.");
    if (err instanceof StaleError) throw new StaleError(err.current ? publicUser(err.current, { full: true }) : null, err.etag, err.message);
    throw err;
  }
  forgetUser(id);
  if (r.changed && (r.data.session_epoch || 0) !== (cur.data.session_epoch || 0)) await bumpAuthEpoch("user_change");
  if (r.changed && authChange) await audit(ctx, id, "permissions_changed", { role: r.data.role });
  return { data: publicUser(r.data, { full: true }), etag: r.etag };
}

// POST /users/:id/invite and /users/:id/reset → { link, expires_at }. The
// link is a bearer secret: these routes are never idempotent-stored (the
// router would keep the whole answer, link and all, in idem/ for 7 days);
// a retry just issues a fresh link and voids the old one. A reset also
// clears the password and bumps session_epoch: signed out everywhere, and
// the old password stops working, until the link sets a new one.
async function issueLink(ctx, kind) {
  const id = ctx.params.id;
  const cur = await loadUser(id);
  if (cur.data.status === "disabled") throw new ConflictError("Enable this person first.");
  if (kind === "invite" && cur.data.status === "active") throw new ConflictError("They already signed in. Use a reset link instead.");
  if (kind === "reset" && cur.data.status !== "active") throw new ConflictError("They haven't set a password yet. Send an invite link instead.");
  const { token, invite } = newInvite(kind);
  const r = await updateRecord("user", id, (u) => ({ ...u, invite, ...(kind === "reset" ? { password: null, session_epoch: (u.session_epoch || 0) + 1 } : {}) }), ctx.write());
  forgetUser(id);
  if (kind === "reset") await bumpAuthEpoch("reset");
  await audit(ctx, id, kind === "reset" ? "reset_link" : "invite_link");
  return { data: { link: `${linkOrigin(ctx)}/crm/invite/${id}.${token}`, expires_at: invite.expires_at, user: publicUser(r.data, { full: true }) }, etag: r.etag };
}

async function setStatus(ctx, enable) {
  const id = ctx.params.id;
  if (self(ctx, id)) throw new ForbiddenError(enable ? "You're already on." : "You can't disable yourself.");
  const cur = await loadUser(id);
  if (!enable && cur.data.role === "owner" && cur.data.status === "active") {
    const owners = await activeOwners();
    if (owners.length <= 1) throw new ConflictError("There has to be at least one active owner.");
  }
  const r = await updateRecord("user", id, (u) => {
    if (enable) {
      if (u.status !== "disabled") return null;
      return { ...u, status: u.password && u.password.hash ? "active" : "invited" };
    }
    if (u.status === "disabled") return null;
    const { invite, ...rest } = u;
    return { ...rest, status: "disabled", session_epoch: (u.session_epoch || 0) + 1 };
  }, ctx.write());
  forgetUser(id);
  if (r.changed && !enable) await bumpAuthEpoch("disable");
  if (r.changed) await audit(ctx, id, enable ? "enabled" : "disabled");
  return { data: publicUser(r.data, { full: true }), etag: r.etag };
}

async function userSessions(ctx) {
  mustSelfOrManage(ctx, ctx.params.id);
  const rec = await loadUser(ctx.params.id);
  return { data: await listSessions(rec.data, self(ctx, ctx.params.id) ? ctx.sessionHash : null) };
}

async function endSession(ctx) {
  mustSelfOrManage(ctx, ctx.params.id);
  const rec = await loadUser(ctx.params.id);
  const list = await listSessions(rec.data, null);
  if (!list.some((s) => s.hash === ctx.params.hash)) throw new NotFoundError("That device is already signed out.");
  await revokeSession(ctx.params.hash);
  await audit(ctx, ctx.params.id, "device_signed_out");
  return { data: { ok: true } };
}

const r = (method, path, perm, subject, handler, more = {}) => ({ method, path, auth: "session", perm, subject, mode: "inline", handler, ...more });
export const userRoutes = [
  r("GET", "/users", "schedule:read", "none", listUsers),
  r("POST", "/users", "users:manage", "none", addUser),
  r("GET", "/users/:id", "account:own", "required", getUser),
  r("PATCH", "/users/:id", "account:own", "required", patchUser, { maxCalls: 30 }),
  r("POST", "/users/:id/invite", "users:manage", "none", (ctx) => issueLink(ctx, "invite"), { idempotent: false, secret: true }),
  r("POST", "/users/:id/reset", "users:manage", "none", (ctx) => issueLink(ctx, "reset"), { idempotent: false, secret: true }),
  r("POST", "/users/:id/disable", "users:manage", "none", (ctx) => setStatus(ctx, false)),
  r("POST", "/users/:id/enable", "users:manage", "none", (ctx) => setStatus(ctx, true)),
  r("GET", "/users/:id/sessions", "account:own", "required", userSessions, { maxCalls: 30 }),
  r("DELETE", "/users/:id/sessions/:hash", "account:own", "required", endSession, { maxCalls: 30 }),
];
