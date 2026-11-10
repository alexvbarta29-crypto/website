// Barta CRM core: API keys for the MCP endpoint and command-line tools
// (design §4.9). M1.2 shipped the key format, storage and the check the
// dispatcher runs for `Authorization: Bearer bcrm_...`; M1.3 adds the
// /api-keys routes (modules/system/apikeys.mjs) and the owner-only
// "backup" kind; the My account screen arrives with M1.3's screens.
//
// A key is "bcrm_" + 32 base62 characters, shown once. Stored as
// apikey/{sha256(key)} = { id, user_id, name, kind: "header" | "path",
// scopes, last4, created_at, last_used_at, expires_at?, rate_per_min }, with
// rel/user-apikeys/{uid}/{tsKey}--{sha256} for the list. A key acts as its
// user with role ∩ scopes; a disabled user's keys stop working.
//
// Scopes default to read-only (the user's *:read, *:read_all, reports:read,
// audit:read). Some permissions can never be put on a key, and path keys
// (for connectors that cannot send headers) are read-only.

import { randomInt, createHash, randomBytes } from "node:crypto";
import { getRaw, settledWrite, deleteRaw, addRel, removeRel, listKeys, putRaw } from "../../crm-store.mjs";
import { newId } from "./ids.mjs";
import { nowIso, nowMs, tsKey, localDate } from "./clock.mjs";
import { InputError, RateLimited } from "./errors.mjs";
import { holds, can, permsFor } from "./perms.mjs";

export const KEY_PREFIX = "bcrm_";
const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export const KEY_RE = /^bcrm_[0-9A-Za-z]{32}$/;
export const NEVER_KEY_SCOPES = Object.freeze(["payments:charge", "payments:refund", "campaigns:send", "cutover:run", "users:manage", "integrations:manage", "settings:owner", "export:all"]);
export const KINDS = Object.freeze(["header", "path", "backup"]);
// A "backup" key (owners only) carries exactly export:all and nothing else:
// it lets build/crm_backup_pull.mjs read the snapshot parts for the
// off-site copy (§3.12). It is the one way export:all reaches a key.
export const BACKUP_SCOPES = Object.freeze(["export:all"]);
export const BACKUP_MAX_DAYS = 365;
export const PATH_RATE_PER_MIN = 30;

export const keyHash = (key) => createHash("sha256").update(String(key)).digest("hex");
export const APIKEY_KEY = (hash) => `apikey/${hash}`;
export const isReadScope = (p) => /:(read|read_all|read_own)$/.test(p) || p === "reports:read" || p === "audit:read";

export function newKeyValue() {
  let s = KEY_PREFIX;
  for (let i = 0; i < 32; i++) s += B62[randomInt(62)];
  return s;
}

// The scopes a new key gets: the user's read permissions, or the ticked
// ones (each one the user holds, none of the never-on-a-key ones; path keys
// read-only).
export function scopesFor(user, requested, kind = "header", permissions = null) {
  const held = (p) => !!holds(user, p, permissions);
  if (kind === "backup") {
    if (!user || user.role !== "owner" || held("export:all") !== true) throw new InputError("Only an owner can make a backup key.", "kind");
    return [...BACKUP_SCOPES];
  }
  if (!requested || !requested.length) {
    return DEFAULT_READ_SCOPES.filter(held);
  }
  const out = [];
  for (const p of requested) {
    if (typeof p !== "string" || !/^[a-z_]+:[a-z_]+$/.test(p)) throw new InputError("That isn't a permission.", "scopes");
    if (NEVER_KEY_SCOPES.includes(p)) throw new InputError("That permission can't be given to an API key.", "scopes");
    if (kind === "path" && !isReadScope(p)) throw new InputError("Connector (path) keys are read-only.", "scopes");
    if (!held(p)) throw new InputError("You can only give a key permissions you have.", "scopes");
    out.push(p);
  }
  return [...new Set(out)].sort();
}

// What the new-key sheet offers (§4.9): the person's read permissions
// (ticked by default) and write permissions (ticked one by one), never the
// ones a key can't carry. → { read: [perm], write: [perm] }
export const DEFAULT_READ_SCOPES = Object.freeze(["contacts:read", "contacts:read_all", "tasks:read", "quotes:read", "plans:read", "schedule:read", "invoices:read", "invoices:read_all",
  "inbox:read", "reviews:read", "payroll:read_own", "payroll:read_all", "reports:read", "audit:read", "outbox:read"]);
export function grantableScopes(user, permissions = null) {
  const held = Object.keys(permsFor(user, permissions)).filter((p) => !NEVER_KEY_SCOPES.includes(p) && p !== "api_keys:own");
  return { read: held.filter(isReadScope).sort(), write: held.filter((p) => !isReadScope(p)).sort(), defaults: DEFAULT_READ_SCOPES.filter((p) => held.includes(p)) };
}

export async function createApiKey(user, { name, kind = "header", scopes, expires_days } = {}, opts = {}) {
  const label = String(name || "").trim().slice(0, 60);
  if (!label) throw new InputError("Give the key a name.", "name");
  if (!KINDS.includes(kind)) throw new InputError("Pick a key kind.", "kind");
  const sc = scopesFor(user, scopes, kind, opts.permissions || null);
  const key = newKeyValue();
  const hash = keyHash(key);
  const at = nowIso();
  let days = Number(expires_days);
  if (kind === "backup") days = Number.isFinite(days) && days > 0 ? Math.min(days, BACKUP_MAX_DAYS) : 90;
  const record = {
    id: newId("api_key"), user_id: user.id, name: label, kind, scopes: sc, last4: key.slice(-4), created_at: at, last_used_at: null,
    ...(Number.isFinite(days) && days > 0 ? { expires_at: new Date(nowMs() + Math.min(days, 3650) * 86400000).toISOString() } : {}),
    rate_per_min: kind === "path" ? PATH_RATE_PER_MIN : DEFAULT_RATE_PER_MIN,
  };
  const w = await settledWrite(APIKEY_KEY(hash), record, { onlyIfNew: true }, opts);
  if (!w.ok) throw new Error("api key collision");
  await addRel("user-apikeys", user.id, tsKey(new Date(at)), hash, {}, opts).catch(() => {});
  return { key, hash, record };
}

// The stored record of a presented key (or null): format, existence, expiry.
export async function lookupApiKey(key, opts = {}) {
  if (!KEY_RE.test(String(key || ""))) return null;
  const hash = keyHash(key);
  const got = await getRaw(APIKEY_KEY(hash), opts);
  const rec = got && got.data;
  if (!rec || (rec.expires_at && !(Date.parse(rec.expires_at) > nowMs()))) return null;
  const { _w, ...clean } = rec;
  return { ...clean, hash, etag: got.etag };
}

// The key's calls a minute (§4.9): each call is its own small blob,
// thr/key/{keyId}/{tsKey}-{rand} (the nightly auth sweep deletes them after
// a day), and the minute's count is one listing of that minute's prefix.
// Over rate_per_min → RateLimited (429, Retry-After: the rest of the minute).
export const DEFAULT_RATE_PER_MIN = 120;
export async function checkKeyRate(rec, opts = {}) {
  const limit = Number.isInteger(rec.rate_per_min) && rec.rate_per_min > 0 ? rec.rate_per_min : DEFAULT_RATE_PER_MIN;
  const t = nowMs();
  const ts = tsKey(new Date(t));
  const prefix = `thr/key/${String(rec.id || rec.hash || "key").replace(/[^a-z0-9_]/gi, "").slice(0, 40)}/${ts.slice(0, 13)}`;
  const used = await listKeys(prefix, {}, opts);
  if (used.length >= limit) throw new RateLimited("This key made too many calls this minute. Wait a moment and try again.", Math.max(1, 60 - new Date(t).getUTCSeconds()));
  await putRaw(`${prefix}${ts.slice(13)}-${randomBytes(3).toString("hex")}`, { at: new Date(t).toISOString() }, {}, opts);
}

// Records the first use per day (one write a day at most).
export async function touchApiKey(rec, opts = {}) {
  const today = localDate(new Date(nowMs()));
  if (rec.last_used_at && localDate(new Date(rec.last_used_at)) === today) return false;
  const { hash, etag, ...value } = rec;
  const w = await settledWrite(APIKEY_KEY(hash), { ...value, last_used_at: nowIso() }, { onlyIfMatch: etag }, opts).catch(() => ({ ok: false }));
  return !!w.ok;
}

export async function revokeApiKey(hash, opts = {}) {
  const got = await getRaw(APIKEY_KEY(hash), opts);
  if (!got || !got.data) return false;
  await deleteRaw(APIKEY_KEY(hash), opts);
  const created = Date.parse(got.data.created_at);
  if (Number.isFinite(created)) await removeRel("user-apikeys", got.data.user_id, tsKey(new Date(created)), hash, opts).catch(() => {});
  return true;
}

// A key may do what its user may do AND what its scopes say.
export function keyCan(user, key, perm, subject = undefined, permissions = null) {
  if (!key || !Array.isArray(key.scopes)) return false;
  if (key.kind === "backup") return BACKUP_SCOPES.includes(perm) && key.scopes.includes(perm) && user.role === "owner" && can(user, perm, subject, permissions);
  if (NEVER_KEY_SCOPES.includes(perm)) return false;
  if (!key.scopes.includes(perm)) return false;
  if (key.kind === "path" && !isReadScope(perm)) return false;
  return can(user, perm, subject, permissions);
}
