// Barta CRM core: record ids (design §3.3).
//
// An id is `{prefix}_{t}{r}`: a 2-letter type prefix, then 20 characters of
// lowercase Crockford base32 (23 characters, URL-safe, fixed width).
//   newId(type, at?)               t = creation time in ms (10 chars), r = 50 random bits: time-sortable
//   idForRotor(type, rotorId)      t+r = first 100 bits of sha256("rotor:" + type + ":" + rotorId): a pure
//                                  function, so placeholders, pointer lookups and re-imports agree
//   deriveId(type, opId, scope, n) t+r = first 100 bits of sha256("derive:" + JSON.stringify([opId, scope, n]));
//                                  scope names the calling service, so two services in one op never
//                                  collide; the JSON encoding keeps ("a|b","c") and ("a","b|c") apart.
//                                  Client-created records use deriveId(type, "c:" + uuid).
// Randomness is injectable (setRandom) so tests can pin ids.

import { createHash, randomBytes } from "node:crypto";
import { now } from "./clock.mjs";

export const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";   // Crockford, lowercase
export const ID_RE = /^[a-z]{2}_[0-9a-hjkmnp-tv-z]{20}$/;

// Type → prefix (§3.3). Modules register any new type through the registry,
// which calls registerPrefix(); a prefix is never reused for two types.
const PREFIXES = new Map(Object.entries({
  user: "us", file: "fl", run: "rn", outbox: "ob", pending_action: "pa",
  contact: "ct", property: "pr", merge_candidate: "mc",
  deal: "dl", cadence: "cd", enrollment: "en", task: "tk",
  price_item: "pi", discount_def: "dd", quote: "qt", quote_version: "qv",
  plan: "pl", agreement_template: "at", agreement: "ag", season_install: "si",
  job: "jb", visit: "vs", timer: "tm", timesheet: "ts", checklist_template: "ck", time_off: "to",
  invoice: "in", payment: "pm", credit: "cr", autopay_run: "ap",
  conversation: "cv", message: "ms", template: "tp", campaign: "cm", review: "rv", notification: "nt",
  pay_period: "pp", pay_line: "py", import_run: "ir",
  event: "ev", api_key: "ak", queue_item: "qi",
}));
const TYPES = new Map([...PREFIXES].map(([t, p]) => [p, t]));

export function registerPrefix(type, prefix) {
  if (!/^[a-z]{2}$/.test(prefix)) throw new TypeError(`ids: bad prefix for ${type}`);
  const had = PREFIXES.get(type);
  if (had && had !== prefix) throw new TypeError(`ids: ${type} already uses ${had}`);
  const owner = TYPES.get(prefix);
  if (owner && owner !== type) throw new TypeError(`ids: prefix ${prefix} already belongs to ${owner}`);
  PREFIXES.set(type, prefix);
  TYPES.set(prefix, type);
}
export const prefixOf = (type) => PREFIXES.get(type) || null;
export const typeOf = (id) => (typeof id === "string" && ID_RE.test(id) ? TYPES.get(id.slice(0, 2)) || null : null);
export const isId = (id, type) => typeof id === "string" && ID_RE.test(id) && (type === undefined || typeOf(id) === type);

let random = (n) => randomBytes(n);
// Replaces the random source (n → Uint8Array of n bytes); null restores crypto.
export function setRandom(fn) { random = fn || ((n) => randomBytes(n)); }

// Base32 of a non-negative BigInt, left-padded to `len` chars.
function b32(big, len) {
  let s = "";
  for (let i = 0; i < len; i++) { s = ALPHABET[Number(big & 31n)] + s; big >>= 5n; }
  return s;
}
const bytesToBig = (bytes) => bytes.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);

function need(type) {
  const p = PREFIXES.get(type);
  if (!p) throw new TypeError(`ids: unknown type ${type}`);
  return p;
}

// Time-sortable id.
export function newId(type, at = now()) {
  const p = need(type);
  const ms = BigInt(at instanceof Date ? at.getTime() : at);
  const r = bytesToBig(random(7)) & ((1n << 50n) - 1n);
  return `${p}_${b32(ms, 10)}${b32(r, 10)}`;
}

// The 100-bit body of an id from a hash of `input`.
function hashed(input) {
  const digest = createHash("sha256").update(String(input), "utf8").digest();
  const big = bytesToBig(digest.subarray(0, 13)) >> 4n;   // 104 bits → first 100
  return b32(big, 20);
}

export function idForRotor(type, rotorId) {
  const p = need(type);
  if (rotorId === undefined || rotorId === null || String(rotorId) === "") throw new TypeError("idForRotor: empty Rotor id");
  return `${p}_${hashed("rotor:" + type + ":" + rotorId)}`;
}

export function deriveId(type, opId, scope, n) {
  const p = need(type);
  if (!opId) throw new TypeError("deriveId: empty op id");
  return `${p}_${hashed("derive:" + JSON.stringify([String(opId), scope ?? null, n ?? null]))}`;
}

// Creation time of a newId() (null for hashed ids, whose t is not a time).
export function timeOfId(id) {
  if (!ID_RE.test(String(id))) return null;
  let big = 0n;
  for (const c of id.slice(3, 13)) big = (big << 5n) | BigInt(ALPHABET.indexOf(c));
  return Number(big);
}
