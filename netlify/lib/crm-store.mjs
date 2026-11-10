// Barta CRM: the only door to Netlify Blobs (docs/CRM.md, design §3, §3.14).
//
// Two layers live here:
//
// 1. LEGACY (the first slice, kept working until M2 replaces it): the
//    Customers list reads and writes one blob, idx/customers, in the store
//    named "crm" (readCustomerIndex / writeCustomerIndex / buildCustomerIndex
//    / indexSummary / memberSummary / KEYS.customers / STORE_NAME /
//    TIMEOUT_MS). Those keep their exact behaviour; they open the store the
//    way they always did unless the caller passes a branded { deploy }.
//
// 2. THE CRM STORE API (§3.14): records, pointers, relations, indexes,
//    events, counters, settings, markers, leases, idempotency records, the
//    contact_stats sidecar and file bytes. The rules it enforces:
//    - openStore(kind, deploy) needs the branded deploy object from
//      core/context.mjs deployContext() and refuses the production store
//      names unless deploy.prod (ProdStoreRefused / SetupNeeded /
//      DeployContextRequired). Tests set globalThis.__crmStoreOverride to
//      { data, files, backups } memory stores (or one store for all).
//    - Transport: every real store is opened with guardedFetch, which gives
//      each attempt its own timeout and turns 429/5xx/network errors into a
//      synthetic 424, so the Blobs client never sleeps 5 s and retries inside
//      a request; this module retries itself (<= 3 attempts, 100/300 ms
//      jitter, never past the request budget). A streamed file read is timed
//      to its headers only; its body gets a separate, longer limit.
//      Listings walk page by page, each page its own attempt.
//      NOTE: @netlify/blobs 11.0.2 reports any non-412 answer to a
//      *conditional* write as { modified: true, etag: "" } (it does not throw
//      on the 424), so a conditional write whose attempt saw a transient, or
//      whose result has no etag, is treated as ambiguous and settled; a
//      400/401/403 (recorded by guardedFetch) is a definite refusal.
//    - Conditional writes everywhere (§0 rule 4), each carrying a writer
//      nonce _w (process id + request id + counter). A conditional write
//      without onlyIfNew or a real etag is refused (TypeError), never sent
//      unconditionally. A clean 412 is a definite "not written"; an
//      ambiguous outcome (a timeout, a transient error, a blank answer) is
//      settled by re-reading the key: our nonce = it committed; another
//      value = a real conflict; missing/unchanged = nothing committed, retry.
//      Once an attempt was ambiguous, any later failure (of a retry or of
//      the settle read) is UnknownOutcome: a fix/ marker names the key for
//      the worker (503 busy, maybe_saved).
//    - Intent before effect: a record write puts pend/{type}/{id} first and
//      deletes it after its index rows, relations, pointers and event landed.
//    - The parallel-run guard backstop (core/guard.mjs) runs on every
//      record write.
//
// Nothing here logs a value: errors carry keys made of ids and hashes only
// (§3.2: no personal data in keys).

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { withTimeout as legacyWithTimeout } from "./referral-lib.mjs";
import {
  InputError, NotFoundError, ExistsError, StaleError, BlobsTransientError, UnknownOutcome, ParallelRunGuard,
  SchemaTooNew, ProdStoreRefused, DeployContextRequired, SetupNeeded, BudgetError, TimeoutError, RegistryError,
} from "./crm/core/errors.mjs";
import { STORES, PROD_STORE_NAMES, storeNameFor, isDeploy } from "./crm/core/context.mjs";
import { now, nowIso, nowMs, tsKey, localDate, fromTsKey } from "./crm/core/clock.mjs";
import { typeOf, newId, ALPHABET } from "./crm/core/ids.mjs";
import { isKeySafe, keySafe } from "./crm/core/text.mjs";
import { getType, requireType, indexFeeds, indexPrimary, getSettingsDef, statsPart, allIndexes } from "./crm/core/registry.mjs";
import { checkCreate, checkUpdate, checkDelete, guardActive, actorKindOf } from "./crm/core/guard.mjs";
import { decideClaim, claimValue, advanceValue, settleSending, NAMESPACES } from "./crm/core/markers.mjs";
import { partDefaults, statsIndexRow, contactShard, STATS_TYPE, STATS_INDEX, STATS_INDEX_PART } from "./crm/core/stats.mjs";

export {
  InputError, NotFoundError, ExistsError, StaleError, BlobsTransientError, UnknownOutcome, ParallelRunGuard,
  SchemaTooNew, ProdStoreRefused, DeployContextRequired, SetupNeeded, BudgetError, TimeoutError,
};
export { STORES };

// =========================================================== 1. legacy (first slice)

export const STORE_NAME = "crm";
export const TIMEOUT_MS = 8000;

export const KEYS = Object.freeze({
  customers: "idx/customers",
});

// The first slice's store: exactly as before (the override, else "crm").
export async function openLegacyStore() {
  const o = globalThis.__crmStoreOverride;
  if (o) return isStoreLike(o) ? o : o.data;
  const { getStore } = await loadBlobs();
  return getStore({ name: STORE_NAME, consistency: "strong" });
}

const legacyStore = (deploy) => (deploy ? openStore("data", deploy) : openLegacyStore());

const str = (v) => (v == null ? "" : String(v)).trim();
// What the page needs to say who a customer is assigned to: the id and a
// display name. Emails and roles stay out of the index.
export const memberSummary = (m) => ({
  user_id: str(m && m.user_id),
  name: str(m && m.name) || [str(m && m.first_name), str(m && m.last_name)].filter(Boolean).join(" "),
});

// The object at idx/customers, or null before the first import. Rejects
// with a SyntaxError when the blob isn't JSON, and with a TimeoutError or
// the Blobs error when storage doesn't answer.
export async function readCustomerIndex({ timeoutMs = TIMEOUT_MS, deploy } = {}) {
  const store = await legacyStore(deploy);
  return legacyWithTimeout(() => store.get(KEYS.customers, { type: "json" }), timeoutMs, "crm: read customer index");
}

// The index for an opened, checked export.
// `now` may be a Date or a function returning one (tests pin it).
export function buildCustomerIndex({ customers, members, exported_at }, { now = () => new Date() } = {}) {
  const rows = Array.isArray(customers) ? customers.filter((c) => c && typeof c === "object" && !Array.isArray(c) && str(c.id)) : [];
  const people = (Array.isArray(members) ? members : []).map(memberSummary).filter((m) => m.user_id);
  const at = typeof now === "function" ? now() : now;
  return { v: 1, imported_at: new Date(at).toISOString(), exported_at: str(exported_at), count: rows.length, members: people, customers: rows };
}

// { imported_at, exported_at, counts: { customers, members } } for an index,
// or null when there is none (what GET /api/crm/import answers).
export function indexSummary(idx) {
  if (!idx || typeof idx !== "object" || !Array.isArray(idx.customers)) return null;
  const count = Number.isInteger(idx.count) ? idx.count : idx.customers.length;
  return {
    imported_at: str(idx.imported_at) || null,
    exported_at: str(idx.exported_at) || null,
    counts: { customers: count, members: Array.isArray(idx.members) ? idx.members.length : 0 },
  };
}

// Replaces the list: the one write an import makes.
export async function writeCustomerIndex(index, { timeoutMs = TIMEOUT_MS, deploy } = {}) {
  const store = await legacyStore(deploy);
  await legacyWithTimeout(() => store.setJSON(KEYS.customers, index), timeoutMs, "crm: write customer index");
  return indexSummary(index);
}

// =========================================================== 2. the CRM store API

export const STORE_ATTEMPT_MS = 2500;   // one Blobs attempt (§3.13)
export const MAX_ATTEMPTS = 3;          // per call, this module's own retries
export const BUDGET_MS = 8000;          // an inline request (§2.2)
export const DEFAULT_MAX_CALLS = 25;    // Blobs calls an inline request may make
const MIN_ATTEMPT_MS = 50;
const BUDGET_MARGIN_MS = 200;
const CAS_TRIES = 5;

// ----------------------------------------------------------- keys

export const K = Object.freeze({
  rec: (type, id) => `rec/${type}/${id}`,
  ptr: (kind, key) => `ptr/${kind}/${key}`,
  rel: (rel, parent, sort, child) => `rel/${rel}/${parent}/${sort}--${child}`,
  relPrefix: (rel, parent) => `rel/${rel}/${parent}/`,
  ix: (name, shard) => (shard ? `ix/${name}/${shard}` : `ix/${name}`),
  dirty: (name, shard) => `ix-dirty/${name}${shard ? "/" + shard : ""}`,
  pend: (type, id) => `pend/${type}/${id}`,
  fix: (ts, kind, id) => `fix/${ts}--${kind}--${id}`,
  evt: (type, id, ts, action, actor, r) => `evt/${type}/${id}/${ts}--${action}--${actor}--${r}`,
  aud: (date, ts, type, id, action, actor) => `aud/${date}/${ts}--${type}--${id}--${action}--${actor}`,
  seq: (name) => `seq/${name}`,
  cfg: (name) => `cfg/${name}`,
  ses: (hash) => `ses/${hash}`,
  done: (ns, scope, key) => `${ns}/${scope}/${key}`,
  q: (utcDate, utcHHMM, qid) => `q/${utcDate}/${utcHHMM}--${qid}`,
  op: (id) => `op/${id}`,
  idem: (uid, key) => `idem/${uid}/${key}`,
  lock: (name) => `lock/${name}`,
  sup: (channel, addrHk) => `sup/${channel}/${addrHk}`,
  ib: (type, id) => `ib/${type}/${id}`,
  legacyCustomers: "idx/customers",
});

const MAX_KEY_BYTES = 600;
function assertKey(key) {
  if (!isKeySafe(key) || Buffer.byteLength(key, "utf8") > MAX_KEY_BYTES) throw new InputError("crm-store: key outside the key alphabet (§3.2)", "key");
  return key;
}

// ----------------------------------------------------------- request scope

const als = new AsyncLocalStorage();
const SCOPE_KEYS = ["deploy", "budget", "requestId", "attemptMs"];

// Runs fn with a store scope ({ deploy, budget, requestId }) that every store
// call inside it uses unless the call passes its own. The dispatcher and the
// workers wrap each request / pass in one.
export function withStoreScope(scope, fn) {
  return als.run({ ...(als.getStore() || {}), ...scope }, fn);
}
export const currentScope = () => als.getStore() || null;

function scopeOf(...sources) {
  const out = { ...(als.getStore() || {}) };
  for (const s of sources) {
    if (!s || typeof s !== "object") continue;
    for (const k of SCOPE_KEYS) if (s[k] !== undefined) out[k] = s[k];
  }
  return out;
}

// ----------------------------------------------------------- budget

// { left(), calls(), tick(), check() }: time and Blobs calls for one request
// or worker pass. Over maxCalls: BudgetError when strict (tests: the memory
// store is in use, or CRM_BUDGET_STRICT=1), a single warning otherwise.
export function withBudget(ms = BUDGET_MS, maxCalls = DEFAULT_MAX_CALLS, { strict } = {}) {
  const start = performance.now();
  const isStrict = strict ?? (process.env.CRM_BUDGET_STRICT === "1" || !!globalThis.__crmStoreOverride);
  let calls = 0;
  let warned = false;
  const b = {
    ms, maxCalls,
    left: () => Math.max(0, ms - (performance.now() - start)),
    calls: () => calls,
    tick() {
      calls += 1;
      if (calls > maxCalls) {
        if (isStrict) throw new BudgetError(`more than ${maxCalls} storage calls in one request`);
        if (!warned) { warned = true; console.warn(`crm-store: a request went over ${maxCalls} storage calls`); }
      }
    },
    check() {
      if (b.left() <= 0) throw new BudgetError("the request ran out of time");
      if (isStrict && calls > maxCalls) throw new BudgetError(`more than ${maxCalls} storage calls in one request`);
    },
  };
  return b;
}

function attemptMs(sc) {
  const cap = sc.attemptMs || STORE_ATTEMPT_MS;
  if (!sc.budget) return cap;
  const left = sc.budget.left() - BUDGET_MARGIN_MS;
  if (left < MIN_ATTEMPT_MS) throw new BudgetError("not enough time left for a storage call");
  return Math.min(cap, left);
}

// ----------------------------------------------------------- transport

// How long a streamed body (a photo, a PDF) may take once its headers came:
// a slow phone reads it at its own pace, the function's own limit still applies.
export const STREAM_BODY_MS = 25000;

const timeoutReason = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");

// A fetch for the Blobs client: each attempt gets its own timeout, and a
// 429, any 5xx, an abort or a network error becomes a synthetic 424 that the
// client does not retry. `tracker.transient` records that it happened (the
// client hides it on conditional writes, see the note at the top) and
// `tracker.status` the status of the last real answer.
// opts.attemptMs caps the attempt (the scope's attemptMs); opts.stream times
// only the headers and gives the body STREAM_BODY_MS (a JSON body is read
// inside the attempt, so it stays under the attempt's timeout).
export function guardedFetch(budget, tracker = null, { attemptMs: cap, stream = false } = {}) {
  const transient = (kind) => {
    if (tracker) tracker.transient = kind;
    return new Response(null, { status: 424, headers: { "x-crm-transient": kind } });
  };
  return async (url, init = {}) => {
    let ms;
    try { ms = attemptMs({ budget, attemptMs: cap }); } catch { return transient("budget"); }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(timeoutReason()), ms);
    timer.unref?.();
    const signal = init.signal ? AbortSignal.any([ac.signal, init.signal]) : ac.signal;
    let res;
    try {
      res = await globalThis.fetch(url, { ...init, signal });
    } catch (e) {
      clearTimeout(timer);
      return transient(e && (e.name === "TimeoutError" || e.name === "AbortError") ? "timeout" : "network");
    }
    if (res.status === 429 || res.status >= 500) {
      clearTimeout(timer);
      try { await res.body?.cancel(); } catch { /* nothing to free */ }
      return transient(res.status === 429 ? "rate_limited" : "server");
    }
    if (tracker) tracker.status = res.status;
    if (stream) {
      clearTimeout(timer);
      const bodyTimer = setTimeout(() => ac.abort(timeoutReason()), STREAM_BODY_MS);
      bodyTimer.unref?.();
    }
    return res;
  };
}

let blobsModule = null;
const loadBlobs = async () => (blobsModule ||= await import("@netlify/blobs"));

const isStoreLike = (o) => !!o && typeof o.get === "function" && typeof o.setJSON === "function";
function overrideFor(kind) {
  const o = globalThis.__crmStoreOverride;
  if (!o) return null;
  if (isStoreLike(o)) return o;                // one memory store stands in for every kind
  if (isStoreLike(o[kind])) return o[kind];
  throw new TypeError(`crm-store: the test stores have no "${kind}" store`);
}

// A Blobs store for a kind in a deploy (§3.1, §3.10). The branded deploy is
// required; production names only when deploy.prod.
export async function openStore(kind, deploy, opts = {}) {
  const o = overrideFor(kind);
  if (o) return o;
  return (await handle(kind, scopeOf({ deploy }, opts))).store;
}

async function handle(kind, sc, { stream = false } = {}) {
  const o = overrideFor(kind);
  if (o) return { store: o, tracker: null };
  if (!isDeploy(sc.deploy)) throw new DeployContextRequired("crm-store: a branded deploy object is required");
  const name = storeNameFor(kind, sc.deploy);
  if (PROD_STORE_NAMES.has(name) && !sc.deploy.prod) throw new ProdStoreRefused("crm-store: production store outside production");
  const tracker = { transient: null, status: null };
  const { getStore } = await loadBlobs();
  return { store: getStore({ name, consistency: "strong", fetch: guardedFetch(sc.budget, tracker, { attemptMs: sc.attemptMs, stream }) }), tracker };
}

// HMAC key of a phone or an email (§3.2): no address ever appears in a key.
// Production needs CRM_KEY_SALT; other contexts use the fixed "dev-only".
export function hk(kind, value, env = process.env) {
  let norm;
  if (kind === "phone") {
    norm = String(value ?? "").replace(/\D/g, "");
    if (norm.length === 11 && norm[0] === "1") norm = norm.slice(1);
    if (norm.length !== 10) throw new InputError("Not a US phone number.", "phone");
  } else if (kind === "email") {
    norm = String(value ?? "").trim().toLowerCase();
    if (!norm.includes("@")) throw new InputError("Not an email address.", "email");
  } else throw new TypeError(`hk: unknown kind ${kind}`);
  let salt = env.CRM_KEY_SALT;
  if (!salt) {
    if (env.CRM_PRODUCTION === "1") throw new SetupNeeded("CRM_KEY_SALT is not set in Netlify.");
    salt = "dev-only";
  }
  const mac = createHmac("sha256", salt).update(norm).digest();
  let bits = 0n;
  for (const b of mac.subarray(0, 17)) bits = (bits << 8n) | BigInt(b);   // 136 bits
  bits >>= 6n;                                                           // first 130 bits
  let s = "";
  for (let i = 0; i < 26; i++) { s = ALPHABET[Number(bits & 31n)] + s; bits >>= 5n; }
  return s;
}

// ----------------------------------------------------------- calls, retries, timeouts

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms * (globalThis.__crmSleepScale ?? 1))));

function timeoutRace(work, ms, label) {
  let timer;
  const t = new Promise((_, reject) => { timer = setTimeout(() => reject(new TimeoutError(`${label} timed out`)), ms); });
  return Promise.race([Promise.resolve().then(work), t]).finally(() => clearTimeout(timer));
}

export function isTransient(e) {
  if (!e) return false;
  if (e instanceof TimeoutError || e instanceof BlobsTransientError) return true;
  if (e.name === "TimeoutError" || e.name === "AbortError") return true;
  if (e.name === "BlobsInternalError") {
    const msg = String(e.message || "");
    if (/\((?:424|429|5\d\d)\b/.test(msg)) return true;
    return !/\(4\d\d\b/.test(msg);
  }
  return e.transient === true;
}

// One attempt of one store operation: budget tick, per-attempt timeout.
async function attempt(sc, kind, label, fn, { stream = false } = {}) {
  const { store, tracker } = await handle(kind, sc, { stream });
  if (sc.budget) sc.budget.tick();
  const ms = attemptMs(sc);
  const result = await timeoutRace(() => fn(store), ms, label);
  return { result, transient: tracker ? tracker.transient : null, status: tracker ? tracker.status : null };
}

async function backoff(i, sc) {
  const base = i === 0 ? 100 : 300;
  const wait = base + Math.floor(Math.random() * base * 0.5);
  if (sc.budget && sc.budget.left() - wait < BUDGET_MARGIN_MS + MIN_ATTEMPT_MS) throw new BudgetError("no time left to retry storage");
  await sleep(wait);
}

// Retries an idempotent operation on transient errors (reads, deletes,
// same-value writes).
async function retrying(sc, label, fn) {
  let last;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    try { return await fn(); } catch (e) {
      if (!isTransient(e)) throw e;
      last = e;
      if (i < MAX_ATTEMPTS - 1) await backoff(i, sc);
    }
  }
  throw new BlobsTransientError(`${label}: storage kept failing`, { cause: last });
}

// Strong read with metadata: { data, etag, metadata } | null.
async function read(sc, kind, key, { type = "json", etag } = {}) {
  return retrying(sc, "read", async () => {
    const { result } = await attempt(sc, kind, "read", (s) => s.getWithMetadata(key, { type, ...(etag ? { etag } : {}) }), { stream: type === "stream" });
    return result ? { data: result.data, etag: result.etag, metadata: result.metadata } : null;
  });
}

async function del(sc, kind, key) {
  return retrying(sc, "delete", async () => { await attempt(sc, kind, "delete", (s) => s.delete(key)); });
}

// An unconditional write of a value that is the same on every retry
// (relations, pend/ markers, dirty markers).
async function putSame(sc, kind, key, value) {
  assertKey(key);
  return retrying(sc, "write", async () => {
    const { result } = await attempt(sc, kind, "write", (s) => s.setJSON(key, value));
    return result;
  });
}

// A write-once key (evt/, aud/): onlyIfNew; "already there" is success.
async function writeOnce(sc, kind, key, value) {
  assertKey(key);
  return retrying(sc, "write", async () => {
    const r = await attempt(sc, kind, "write", (s) => s.setJSON(key, value, { onlyIfNew: true }));
    // a hidden transient (see the note at the top): try again; onlyIfNew makes it safe
    if (r.transient || (r.result && r.result.modified && !r.result.etag)) throw new BlobsTransientError("write-once: unclear outcome");
    return r.result;
  });
}

// ----------------------------------------------------------- nonces and settling

// process id + request id + counter: two function instances never write the
// same nonce, even when they share a request id (a constant like "worker",
// a client-supplied header, a request id cut to 60 characters).
const PROCESS_ID = "p" + randomBytes(4).toString("hex");
let nonceSeq = 0;
const nonce = (sc) => `${PROCESS_ID}.${keySafe(sc.requestId || "-", 60)}.${++nonceSeq}`;

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const strip = (v) => {
  if (!v || typeof v !== "object") return v;
  const { _w, ...rest } = v;
  return rest;
};
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
// JSON with object keys sorted, so equal values compare equal whatever their key order.
const stable = (v) => JSON.stringify(v, (k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((kk) => [kk, x[kk]])) : x));
const sameJSON = (a, b) => stable(a) === stable(b);

// A best-effort fix/ marker for the worker's fix.settle step: one attempt,
// outside the request budget. → the key when it was written, else null.
async function writeFix(sc, fixKey, marker) {
  try {
    const { store, tracker } = await handle("data", { ...sc, budget: undefined });
    const r = await timeoutRace(() => store.setJSON(fixKey, marker, { onlyIfNew: true }), Math.min(sc.attemptMs || STORE_ATTEMPT_MS, 1000), "fix");
    return r && r.modified && r.etag && !(tracker && tracker.transient) ? fixKey : null;
  } catch {
    return null;
  }
}

// Writes fix/{tsKey}--{kind}--{id} naming the key and returns the
// UnknownOutcome to throw (fixKey null when the marker did not land). A
// scratch store (the probe) gets no marker: nothing settles it, and the
// data store stays untouched.
async function unknownOutcome(sc, kind, key, value, cause) {
  if (!Object.hasOwn(STORES, kind)) return new UnknownOutcome(null);
  const fixKey = K.fix(tsKey(now()), keySafe(key.split("/")[0], 12), sha256(key).slice(0, 16));
  const marker = { store: kind, key, nonce: value && value._w, hash: sha256(JSON.stringify(value ?? null)), at: nowIso(), cause: cause && cause.name };
  return new UnknownOutcome(await writeFix(sc, fixKey, marker));
}

// The options of a conditional write: onlyIfNew, or onlyIfMatch with a real
// etag. Anything else would go out as an unconditional write (the client
// ignores a falsy onlyIfMatch), so it is refused (§0 rule 4).
function condOptions(cond) {
  if (cond && cond.onlyIfNew === true) return { onlyIfNew: true };
  if (cond && typeof cond.onlyIfMatch === "string" && cond.onlyIfMatch !== "") return { onlyIfMatch: cond.onlyIfMatch };
  throw new TypeError("crm-store: a conditional write needs onlyIfNew or the etag its read returned; that read gave no etag (§0 rule 4)");
}

// A status the service gives for a write it refused outright (nothing written).
const refusedStatus = (status) => Number.isInteger(status) && status >= 400 && status < 500 && status !== 412 && status !== 424 && status !== 429;
function refusedError(status) {
  const e = new Error(`Netlify Blobs refused the write (${status} status code)`);
  e.name = "BlobsInternalError";
  e.status = status;
  return e;
}

// One settled conditional JSON write (§3.4).
// → { ok: true, etag } | { ok: false, current: { data, etag } | null }
// A clean 412 is definite (guardedFetch stops the client's own retries, so
// it never hides an earlier commit). An ambiguous attempt (timeout,
// transient, blank answer) is settled by a read; after one, every later
// failure is UnknownOutcome, because the earlier attempt may still land.
async function condWrite(sc, kind, key, value, cond) {
  assertKey(key);
  const opts = condOptions(cond);
  let ambiguous = false;
  const unclear = async (e) => { throw await unknownOutcome(sc, kind, key, value, e); };
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    let res = null;
    let threw = null;
    try {
      const r = await attempt(sc, kind, "write", (s) => s.setJSON(key, value, opts));
      res = { ...r.result, transient: r.transient, status: r.status };
    } catch (e) {
      if (!isTransient(e)) {
        if (ambiguous) await unclear(e);
        throw e;
      }
      threw = e;
    }
    if (res && res.modified && res.etag && !res.transient) return { ok: true, etag: res.etag };
    if (res && res.modified && !res.etag && !res.transient && refusedStatus(res.status)) {
      const e = refusedError(res.status);
      if (ambiguous) await unclear(e);
      throw e;
    }
    if (threw || (res && (res.transient || (res.modified && !res.etag)))) ambiguous = true;
    let cur;
    try { cur = await read(sc, kind, key); } catch (e) {
      if (ambiguous) await unclear(e);
      throw e;                                   // a clean 412 we could not read back: nothing was written
    }
    if (cur && cur.data && typeof cur.data === "object" && cur.data._w === value._w) return { ok: true, etag: cur.etag, settled: true };
    if (!cur) {
      if (opts.onlyIfMatch) return { ok: false, current: null };
    } else if (opts.onlyIfNew || cur.etag !== opts.onlyIfMatch) {
      return { ok: false, current: cur };
    }
    // nothing committed (yet): try again
    if (i < MAX_ATTEMPTS - 1) {
      try { await backoff(i, sc); } catch (e) { if (ambiguous) await unclear(e); throw e; }
    }
  }
  if (ambiguous) await unclear(null);
  throw new BlobsTransientError("write: storage kept failing");
}

const casJitter = (i) => sleep(20 + Math.floor(Math.random() * Math.min(230, 20 * 2 ** i)));

// ----------------------------------------------------------- small utilities

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const SENSITIVE_FIELD = /notes|body|card|bank|password|hash|token|secret|signature|account/i;
const ENVELOPE_NOISE = new Set(["wv", "updated_at", "updated_by", "_w", "v"]);

function diffOf(before, after) {
  const changed = [];
  const diff = {};
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const k of keys) {
    if (ENVELOPE_NOISE.has(k)) continue;
    const a = before ? before[k] : undefined;
    const b = after ? after[k] : undefined;
    if (sameJSON(a ?? null, b ?? null)) continue;
    changed.push(k);
    const scalar = (v) => v === null || v === undefined || ["string", "number", "boolean"].includes(typeof v);
    if (!SENSITIVE_FIELD.test(k) && scalar(a) && scalar(b) && String(a ?? "").length <= 200 && String(b ?? "").length <= 200) diff[k] = [a ?? null, b ?? null];
  }
  return { changed: changed.sort(), diff };
}

function migrateRecord(def, rec) {
  if (!def || !rec || typeof rec !== "object") return rec;
  let out = rec;
  const from = Number.isSafeInteger(rec.v) ? rec.v : 1;
  for (let v = from + 1; v <= def.v; v++) {
    if (def.migrate[v]) out = { ...def.migrate[v](clone(out)), v };
    else out = { ...out, v };
  }
  return out;
}

// The write context with its defaults. actor_kind is never assumed to be a
// person: a ctx that does not say is derived from its origin (core/guard.mjs
// actorKindOf), so the parallel-run backstop fails closed.
function ctxDefaults(ctx) {
  const c = { by: "system", origin: "api", ...ctx };
  return { ...c, actor_kind: actorKindOf(c), mode: (ctx && ctx.mode) || { system_of_record: "rotor", paused: false } };
}

// Envelope fields only the import may set or change (§3.3, §3.10): a create
// from anywhere else drops them from the caller's data, and an update keeps
// the stored import/shadow whatever the mutator returns.
const IMPORT_ONLY_ON_CREATE = ["import", "shadow", "deleted_at", "deleted_by", "merged_into"];
const IMPORT_ONLY_ON_UPDATE = ["import", "shadow"];

// The pointers, relations and index rows a record version implies.
function sidePlan(def, rec) {
  const out = { unique: [], lists: [], rels: [], ix: [] };
  for (const p of def.pointers) {
    const keys = rec && !rec.deleted_at ? (p.keys(rec) || []).filter((k) => typeof k === "string" && k) : [];
    for (const key of keys) (p.list ? out.lists : out.unique).push({ kind: p.kind, key });
  }
  for (const r of def.rels) {
    const parent = rec ? r.parent(rec) : null;
    if (!parent) continue;
    out.rels.push({ rel: r.rel, parent: String(parent), sort: String(r.sort(rec)), value: r.value ? r.value(rec) : {} });
  }
  for (const ix of def.indexes) {
    let shard = rec ? ix.shard(rec) : null;
    if (rec && (rec.deleted_at || rec.merged_into)) shard = null;   // soft-deleted and merged records leave every index
    out.ix.push({ name: ix.name, part: ix.part, shard: shard === undefined ? null : shard, row: shard === null || shard === undefined ? null : ix.row(rec) });
  }
  return out;
}
// What a pend/ marker keeps of a side plan (§3.5): enough for the worker to
// finish the writes, and to undo the old version's rows, relations and
// pointers when an update moved them, without the record's values.
const compactPlan = (plan) => ({
  unique: plan.unique.map((p) => ({ kind: p.kind, key: p.key })),
  lists: plan.lists.map((p) => ({ kind: p.kind, key: p.key })),
  rels: plan.rels.map((r) => ({ rel: r.rel, parent: r.parent, sort: r.sort })),
  ix: plan.ix.map((x) => ({ name: x.name, part: x.part, shard: x.shard })),
});
const pkey = (p) => `${p.kind}\u0000${p.key}`;
const rkey = (r) => K.rel(r.rel, r.parent, r.sort, "x");

async function readContactFor(sc, def, rec) {
  if (!rec) return null;
  if (def.type === "contact") return rec;
  const cid = rec.contact_id;
  if (!cid || typeOf(cid) !== "contact") return null;
  const got = await read(sc, "data", K.rec("contact", cid));
  return got ? strip(got.data) : null;
}

// Runs the side writes in parallel; a failure leaves the pend/ marker so the
// worker re-applies them (§3.5). Never throws.
async function sideWrites(sc, list) {
  const results = await Promise.allSettled(list.map((fn) => fn()));
  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length) console.error(`crm-store: ${failed.length} of ${results.length} side writes failed; left for the worker`);
  return failed.length === 0;
}

function auditWrites(sc, def, rec, action, ctx, extra) {
  if (ctx.audit === false || def.audit === false) return [];
  const at = nowIso();
  const actor = keySafe(ctx.by || "system", 60);
  const ts = tsKey(new Date(at));
  return [
    () => appendEvent(def.type, rec.id, { at, by: ctx.by, origin: ctx.origin, action, wv: rec.wv, req: sc.requestId || null, ...extra }, sc),
    () => writeOnce(sc, "data", K.aud(localDate(new Date(at)), ts, def.type, rec.id, keySafe(action, 30), actor), {}),
  ];
}

// ----------------------------------------------------------- records

export async function getRecord(type, id, opts = {}) {
  const sc = scopeOf(opts);
  const got = await read(sc, "data", K.rec(type, id));
  if (!got || !got.data) return null;
  return { data: strip(migrateRecord(getType(type), got.data)), etag: got.etag };
}

export async function getRecords(type, ids, opts = {}) {
  return mapLimit(ids, 16, (id) => getRecord(type, id, opts));
}

export async function createRecord(type, data, ctx = {}) {
  const def = requireType(type);
  const c = ctxDefaults(ctx);
  const sc = scopeOf(ctx);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new InputError("Expected a record.");
  const input = clone(data);
  if (c.origin !== "import") for (const k of IMPORT_ONLY_ON_CREATE) delete input[k];
  const id = input.id || newId(def.prefix ? type : def.idType);
  if (def.prefix && typeOf(id) !== type) throw new InputError("That id is for another kind of record.", "id");
  const at = nowIso();
  let rec = def.validate({ ...input, id }, { op: "create", ctx: c });
  rec = {
    ...rec,
    id, type, v: def.v, wv: 1,
    created_at: c.origin === "import" && typeof data.created_at === "string" ? data.created_at : at,
    created_by: c.by, updated_at: at, updated_by: c.by,
  };
  if (def.shadow && c.origin !== "import" && !rec.import && c.mode.system_of_record !== "crm") rec.shadow = true;
  // the contact is read only when the backstop can use it (one Blobs call less per write otherwise)
  checkCreate({ def, record: rec, contact: def.mirrored && guardActive(c) ? await readContactFor(sc, def, rec) : null, ctx: c });
  rec._w = nonce(sc);
  const plan = sidePlan(def, rec);
  const key = K.rec(type, id);

  // unique pointers first: a taken one stops the create before the record
  // exists. Anything failing before the record write releases what was
  // claimed (an ambiguous claim leaves its own fix/ marker).
  const claimed = [];
  try {
    for (const p of plan.unique) {
      const r = await claimPointer(p.kind, p.key, { id }, sc);
      if (!r.ok && !(r.current && r.current.id === id)) throw new ExistsError("That is already taken.", { pointer: p.kind });
      claimed.push(p);
    }
    if (!c.bulk) await putSame(sc, "data", K.pend(type, id), { wv: rec.wv, at, names: plan.ix.map((x) => x.name), plan: compactPlan(plan) });
  } catch (e) {
    await compensate(sc, def, claimed, id);
    throw e;
  }
  let w;
  try {
    w = await condWrite(sc, "data", key, rec, { onlyIfNew: true });
  } catch (e) {
    // an unknown outcome leaves the pointers (the fix/ marker settles it);
    // any other failure releases them once a read proves the record absent
    if (!(e instanceof UnknownOutcome)) await compensate(sc, def, claimed, id);
    throw e;
  }
  if (!w.ok) {
    await compensate(sc, def, claimed, id);
    throw new ExistsError("That record already exists.", { id });
  }
  const side = [
    ...plan.lists.map((p) => () => updatePointerList(p.kind, p.key, (ids) => [...ids, id], sc)),
    ...plan.rels.map((r) => () => addRel(r.rel, r.parent, r.sort, id, r.value, sc)),
    ...(c.bulk ? [] : plan.ix.filter((x) => x.shard !== null).map((x) => () => applyIndexRow(x.name, x.shard, id, x.part, x.row, rec.wv, sc))),
    ...auditWrites(sc, def, rec, "create", c, { changed: [], etag_after: w.etag }),
  ];
  const clean = await sideWrites(sc, side);
  if (clean && !c.bulk) await del(sc, "data", K.pend(type, id)).catch(() => {});
  return { data: strip(rec), etag: w.etag };
}

export const COMPENSATE_MS = 2000;

// Releases unique pointers claimed for a write that did not happen, but only
// after a settle read proves the record they guard is absent (a create) or
// no longer holds the key (an update, `update: true`). A record that holds
// the key (a double tap, a retry) keeps its pointer. It runs on its own short
// budget, because the request's may be what ran out; a release that fails
// leaves a fix/ marker for the worker (and the weekly pointers.gc).
async function compensate(sc, def, claimed, id, { update = false } = {}) {
  if (!claimed.length) return;
  const grace = { ...sc, budget: withBudget(COMPENSATE_MS, 4 * claimed.length + 2, { strict: false }) };
  for (const p of claimed) {
    const k = pkey(p);
    const holds = (rec) => keysOf(def, rec).has(k);
    try {
      await releasePointer(p.kind, p.key, id, { ...grace, holds, ...(update ? { released: (rec) => !holds(rec) } : {}) });
    } catch {
      const ptrKey = K.ptr(p.kind, p.key);
      await writeFix(sc, K.fix(tsKey(now()), "ptr", sha256(ptrKey).slice(0, 16)), { store: "data", key: ptrKey, kind: "release", expect: id, at: nowIso() });
    }
  }
}

export async function updateRecord(type, id, mutate, ctx = {}) {
  const def = requireType(type);
  const c = ctxDefaults(ctx);
  const sc = scopeOf(ctx);
  const key = K.rec(type, id);
  const tries = c.ifMatch ? 1 : CAS_TRIES;
  for (let i = 0; i < tries; i++) {
    const cur = await read(sc, "data", key);
    if (!cur || !cur.data) throw new NotFoundError("That record isn't there anymore.");
    if (Number.isSafeInteger(cur.data.v) && cur.data.v > def.v) throw new SchemaTooNew(`${type} was written by newer code`);
    const before = strip(migrateRecord(def, cur.data));
    if (c.ifMatch && c.ifMatch !== cur.etag) throw new StaleError(before, cur.etag);
    condOptions({ onlyIfMatch: cur.etag });         // a read with no etag cannot be the base of a CAS (§0 rule 4)
    const draft = await mutate(clone(before), c);
    if (draft === null || draft === undefined) return { data: before, etag: cur.etag, changed: false };
    let next = def.validate({ ...draft }, { op: "update", before, ctx: c });
    next = {
      ...next,
      id: before.id, type: before.type, created_at: before.created_at, created_by: before.created_by,
      v: def.v, wv: (before.wv || 0) + 1, updated_at: nowIso(), updated_by: c.by,
    };
    if (c.origin !== "import") {
      for (const k of IMPORT_ONLY_ON_UPDATE) { if (before[k] === undefined) delete next[k]; else next[k] = clone(before[k]); }
    }
    if (sameJSON({ ...next, wv: before.wv, updated_at: before.updated_at, updated_by: before.updated_by, v: before.v }, before)) {
      return { data: before, etag: cur.etag, changed: false };
    }
    // the contact is read only when the backstop can use it (an imported record, automation)
    const contact = guardActive(c) && before.import ? await readContactFor(sc, def, before) : null;
    if (next.deleted_at && !before.deleted_at) checkDelete({ def, before, contact, ctx: c });
    checkUpdate({ def, before, after: next, contact, ctx: c });
    next._w = nonce(sc);

    const oldPlan = sidePlan(def, before);
    const newPlan = sidePlan(def, next);
    const oldUnique = new Map(oldPlan.unique.map((p) => [pkey(p), p]));
    const newUnique = new Map(newPlan.unique.map((p) => [pkey(p), p]));
    const claimed = [];
    try {
      for (const [k, p] of newUnique) {
        if (oldUnique.has(k)) continue;
        const r = await claimPointer(p.kind, p.key, { id }, sc);
        if (!r.ok && !(r.current && r.current.id === id)) throw new ExistsError("That is already taken.", { pointer: p.kind });
        claimed.push(p);
      }
      if (!c.bulk) await putSame(sc, "data", K.pend(type, id), { wv: next.wv, at: next.updated_at, names: newPlan.ix.map((x) => x.name), plan: compactPlan(newPlan), prev: compactPlan(oldPlan) });
    } catch (e) {
      await compensate(sc, def, claimed, id, { update: true });
      throw e;
    }
    let w;
    try {
      w = await condWrite(sc, "data", key, next, { onlyIfMatch: cur.etag });
    } catch (e) {
      if (!(e instanceof UnknownOutcome)) await compensate(sc, def, claimed, id, { update: true });
      throw e;
    }
    if (!w.ok) {
      await compensate(sc, def, claimed, id, { update: true });
      if (c.ifMatch) throw new StaleError(w.current ? strip(w.current.data) : null, w.current ? w.current.etag : null);
      await casJitter(i);
      continue;
    }
    const side = [];
    const oldLists = new Map(oldPlan.lists.map((p) => [pkey(p), p]));
    const newLists = new Map(newPlan.lists.map((p) => [pkey(p), p]));
    for (const [k, p] of newLists) if (!oldLists.has(k)) side.push(() => updatePointerList(p.kind, p.key, (ids) => [...ids, id], sc));
    for (const [k, p] of oldLists) if (!newLists.has(k)) side.push(() => updatePointerList(p.kind, p.key, (ids) => ids.filter((x) => x !== id), sc));
    for (const [k, p] of oldUnique) {
      if (!newUnique.has(k)) side.push(() => releasePointer(p.kind, p.key, id, { ...sc, released: (rec) => !keysOf(def, rec).has(k), holds: (rec) => keysOf(def, rec).has(k) }));
    }
    const oldRels = new Map(oldPlan.rels.map((r) => [rkey(r), r]));
    const newRels = new Map(newPlan.rels.map((r) => [rkey(r), r]));
    for (const [k, r] of oldRels) if (!newRels.has(k)) side.push(() => removeRel(r.rel, r.parent, r.sort, id, sc));
    for (const [k, r] of newRels) if (!oldRels.has(k) || !sameJSON(oldRels.get(k).value, r.value)) side.push(() => addRel(r.rel, r.parent, r.sort, id, r.value, sc));
    if (!c.bulk) {
      newPlan.ix.forEach((x, n) => {
        const was = oldPlan.ix[n];
        if (was && was.shard !== null && was.shard !== x.shard) side.push(() => applyIndexRow(x.name, was.shard, id, x.part, null, next.wv, sc));
        if (x.shard !== null) side.push(() => applyIndexRow(x.name, x.shard, id, x.part, x.row, next.wv, sc));
      });
    }
    const action = next.deleted_at && !before.deleted_at ? "delete" : !next.deleted_at && before.deleted_at ? "restore" : "update";
    side.push(...auditWrites(sc, def, next, action, c, { ...diffOf(before, strip(next)), etag_before: cur.etag, etag_after: w.etag }));
    const clean = await sideWrites(sc, side);
    if (clean && !c.bulk) await del(sc, "data", K.pend(type, id)).catch(() => {});
    return { data: strip(next), etag: w.etag, changed: true };
  }
  throw new StaleError(null, null, "This record kept changing. Try again.");
}

function keysOf(def, rec) {
  return new Set(sidePlan(def, rec).unique.map(pkey));
}

const ENVELOPE_KEYS = ["id", "type", "v", "wv", "created_at", "created_by", "updated_at", "updated_by", "_w", "import", "shadow"];

// A user's edit from the API: shallow merge, If-Match required, no retry.
export async function patchRecord(type, id, patch, ctx = {}) {
  if (!ctx.ifMatch) throw new InputError("This change needs the version you edited (If-Match).", "if-match");
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new InputError("Expected an object.");
  const clean = { ...patch };
  for (const k of ENVELOPE_KEYS) delete clean[k];
  const r = await updateRecord(type, id, (rec) => ({ ...rec, ...clean }), ctx);
  return { data: r.data, etag: r.etag, changed: r.changed };
}

export async function softDelete(type, id, ctx = {}) {
  const c = ctxDefaults(ctx);
  const r = await updateRecord(type, id, (rec) => (rec.deleted_at ? null : { ...rec, deleted_at: nowIso(), deleted_by: c.by }), ctx);
  return { data: r.data, etag: r.etag };
}

// Worker, purge and import rollback only: removes the record and everything
// it implies (pointers, relations, index rows).
export async function hardDelete(type, id, ctx = {}) {
  const def = requireType(type);
  const c = ctxDefaults(ctx);
  const sc = scopeOf(ctx);
  const key = K.rec(type, id);
  const cur = await read(sc, "data", key);
  if (!cur || !cur.data) return;
  const before = strip(migrateRecord(def, cur.data));
  checkDelete({ def, before, contact: guardActive(c) && before.import ? await readContactFor(sc, def, before) : null, ctx: c });
  await del(sc, "data", key);
  const plan = sidePlan(def, { ...before, deleted_at: undefined });
  const wv = (before.wv || 0) + 1;
  await sideWrites(sc, [
    ...plan.unique.map((p) => () => releasePointer(p.kind, p.key, id, sc)),
    ...plan.lists.map((p) => () => updatePointerList(p.kind, p.key, (ids) => ids.filter((x) => x !== id), sc)),
    ...plan.rels.map((r) => () => removeRel(r.rel, r.parent, r.sort, id, sc)),
    ...plan.ix.filter((x) => x.shard !== null).map((x) => () => applyIndexRow(x.name, x.shard, id, x.part, null, wv, sc)),
    ...auditWrites(sc, def, { ...before, wv }, "purge", c, { changed: [] }),
    () => del(sc, "data", K.pend(type, id)),
  ]);
}

// ----------------------------------------------------------- contact_stats

// The only way a module writes its part of a contact's stats sidecar (§5.1).
// mutate(part, ctx) → new part | null (no change). Creates the sidecar on
// first use. Derived data: no guard, no event.
export async function updateStats(contactId, part, mutate, ctx = {}) {
  if (!statsPart(part)) throw new InputError(`Unknown stats part ${part}.`, "part");
  if (typeOf(contactId) !== "contact") throw new InputError("That isn't a contact id.", "contact_id");
  const c = ctxDefaults(ctx);
  const sc = scopeOf(ctx);
  const key = K.rec(STATS_TYPE, contactId);
  for (let i = 0; i < CAS_TRIES; i++) {
    const cur = await read(sc, "data", key);
    const base = cur && cur.data ? strip(cur.data) : { id: contactId, type: STATS_TYPE, v: 1, wv: 0, created_at: nowIso() };
    const before = base[part] ? clone(base[part]) : partDefaults(part);
    const after = await mutate(clone(before), c);
    if (after === null || after === undefined || (cur && sameJSON(after, before))) return { data: base, etag: cur ? cur.etag : null, changed: false };
    const next = { ...base, [part]: after, wv: (base.wv || 0) + 1, updated_at: nowIso(), _w: nonce(sc) };
    const w = await condWrite(sc, "data", key, next, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
    if (w.ok) {
      if (!c.bulk) await applyIndexRow(STATS_INDEX, contactShard(contactId), contactId, STATS_INDEX_PART, statsIndexRow(next), next.wv, sc);
      return { data: strip(next), etag: w.etag, changed: true };
    }
    await casJitter(i);
  }
  throw new StaleError(null, null, "Stats kept changing. Try again.");
}

// ----------------------------------------------------------- pointers

export async function readPointer(kind, key, opts = {}) {
  const got = await read(scopeOf(opts), "data", K.ptr(kind, key));
  return got && got.data ? strip(got.data) : null;
}

// A unique pointer (onlyIfNew, settled). → { ok, current? }
export async function claimPointer(kind, key, value, opts = {}) {
  const sc = scopeOf(opts);
  const v = { ...value, at: nowIso(), _w: nonce(sc) };
  const w = await condWrite(sc, "data", K.ptr(kind, key), v, { onlyIfNew: true });
  return w.ok ? { ok: true } : { ok: false, current: w.current && w.current.data ? strip(w.current.data) : null };
}

// A "one open" pointer (§3.7): a pointer whose target is closed, ended or
// missing is free and replaced by CAS. isOpen(targetId) → Promise<boolean>.
export async function claimOpenPointer(kind, key, value, isOpen, opts = {}) {
  const sc = scopeOf(opts);
  const k = K.ptr(kind, key);
  let current = null;
  for (let i = 0; i < CAS_TRIES; i++) {
    const w = await condWrite(sc, "data", k, { ...value, at: nowIso(), _w: nonce(sc) }, { onlyIfNew: true });
    if (w.ok) return { ok: true };
    if (!w.current || !w.current.data) continue;
    current = strip(w.current.data);
    if (value.id && current.id === value.id) return { ok: true };
    if (await isOpen(current.id)) return { ok: false, current };
    const r = await condWrite(sc, "data", k, { ...value, at: nowIso(), replaced: current.id || null, _w: nonce(sc) }, { onlyIfMatch: w.current.etag });
    if (r.ok) return { ok: true, replaced: current.id || null };
    await casJitter(i);
  }
  return { ok: false, current };
}

// Deletes a unique pointer that names expectId, but only when a settle read
// proves the record it guards is absent (or opts.released(record) says the
// record no longer holds this key). A record that still holds the key
// (opts.holds(record)) keeps its pointer quietly; anything else is left for
// the worker with a fix/ marker. → true when the pointer is gone.
export async function releasePointer(kind, key, expectId, opts = {}) {
  const sc = scopeOf(opts);
  const k = K.ptr(kind, key);
  const cur = await read(sc, "data", k);
  if (!cur || !cur.data) return true;
  if (cur.data.id !== expectId) return false;
  const type = typeOf(expectId);
  if (!type) return false;
  const rec = await read(sc, "data", K.rec(type, expectId));
  const live = rec && rec.data ? strip(rec.data) : null;
  if (live && typeof opts.holds === "function" && opts.holds(live) && !(typeof opts.released === "function" && opts.released(live))) return false;
  if (live && !(typeof opts.released === "function" && opts.released(live))) {
    const fixKey = K.fix(tsKey(now()), "ptr", sha256(k).slice(0, 16));
    await writeOnce(sc, "data", fixKey, { store: "data", key: k, kind: "release", expect: expectId, at: nowIso() }).catch(() => {});
    return false;
  }
  await del(sc, "data", k);
  return true;
}

// A lookup list ({ ids: [...] }, CAS). mutate(ids) → ids. → the new list.
export async function updatePointerList(kind, key, mutate, opts = {}) {
  const sc = scopeOf(opts);
  const k = K.ptr(kind, key);
  for (let i = 0; i < CAS_TRIES; i++) {
    const cur = await read(sc, "data", k);
    const ids = cur && cur.data && Array.isArray(cur.data.ids) ? cur.data.ids : [];
    const next = [...new Set(mutate([...ids]).filter((x) => typeof x === "string" && x))];
    if ((cur && sameJSON(ids, next)) || (!cur && !next.length)) return ids;
    const w = await condWrite(sc, "data", k, { ids: next, at: nowIso(), _w: nonce(sc) }, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
    if (w.ok) return next;
    await casJitter(i);
  }
  throw new StaleError(null, null, "A lookup list kept changing. Try again.");
}

// ----------------------------------------------------------- relations

export async function addRel(rel, parent, sortKey, childId, value = {}, opts = {}) {
  await putSame(scopeOf(opts), "data", K.rel(rel, parent, sortKey, childId), value || {});
}

export async function removeRel(rel, parent, sortKey, childId, opts = {}) {
  await del(scopeOf(opts), "data", K.rel(rel, parent, sortKey, childId));
}

// → [{ sortKey, id }] newest first by default.
export async function listRel(rel, parent, { from, to, limit = 200, newestFirst = true } = {}, opts = {}) {
  const prefix = K.relPrefix(rel, parent);
  const keys = await listKeys(prefix, {}, opts);
  const rows = [];
  for (const k of keys) {
    const rest = k.slice(prefix.length);
    const at = rest.indexOf("--");
    if (at <= 0) continue;
    const sortKey = rest.slice(0, at);
    if (from !== undefined && sortKey < from) continue;
    if (to !== undefined && sortKey > to) continue;
    rows.push({ sortKey, id: rest.slice(at + 2) });
  }
  rows.sort((a, b) => (a.sortKey === b.sortKey ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.sortKey < b.sortKey ? -1 : 1));
  if (newestFirst) rows.reverse();
  return rows.slice(0, limit);
}

// ----------------------------------------------------------- indexes

const emptyIndex = (name, shard) => ({ v: 1, name, shard: shard || "", rows: {} });

// A removed row part stays as a tombstone { wv, d: null, at } so a late
// writer with a lower wv cannot bring it back; after TOMBSTONE_TTL_MS (far
// longer than any request or worker pass) it is pruned, so status-sharded
// blobs (jobs/open, quotes/open...) do not grow with every closed record.
export const TOMBSTONE_TTL_MS = 24 * 3600 * 1000;
const liveTombstone = (p, t) => !!p && !p.d && !!p.at && Date.parse(p.at) + TOMBSTONE_TTL_MS > t;

function pruneTombstones(rows, t = nowMs()) {
  const out = {};
  for (const [id, parts] of Object.entries(rows || {})) {
    const kept = {};
    for (const [part, p] of Object.entries(parts || {})) if (p && (p.d || liveTombstone(p, t))) kept[part] = p;
    if (Object.keys(kept).length) out[id] = kept;
  }
  return out;
}

function flatten(name, rows) {
  const primary = indexPrimary(name);
  const out = [];
  for (const [id, parts] of Object.entries(rows || {})) {
    const live = Object.entries(parts).filter(([, p]) => p && p.d);
    if (!live.length) continue;
    if (primary && !(parts[primary] && parts[primary].d)) continue;
    out.push(Object.assign({ id }, ...live.map(([, p]) => p.d)));
  }
  return out;
}

async function dirtyStale(sc, name, shard) {
  const d = await read(sc, "data", K.dirty(name, shard)).catch(() => null);
  return !!(d && d.data && d.data.dirty_at && !d.data.clean_at);
}

export async function readIndex(name, shard = "", opts = {}) {
  const sc = scopeOf(opts);
  const [got, stale] = await Promise.all([read(sc, "data", K.ix(name, shard)), dirtyStale(sc, name, shard)]);
  const blob = got && got.data ? got.data : emptyIndex(name, shard);
  return { rows: flatten(name, blob.rows), etag: got ? got.etag : null, built_at: blob.built_at || null, stale };
}

// null when the blob's etag still equals `etag` (an HTTP 304).
export async function readIndexIfChanged(name, shard = "", etag, opts = {}) {
  const sc = scopeOf(opts);
  const got = await read(sc, "data", K.ix(name, shard), { etag });
  if (got && got.data === null && etag && got.etag === etag) return null;
  const blob = got && got.data ? got.data : emptyIndex(name, shard);
  return { rows: flatten(name, blob.rows), etag: got ? got.etag : null, built_at: blob.built_at || null, stale: await dirtyStale(sc, name, shard) };
}

async function markDirty(sc, name, shard) {
  try { await putSame(sc, "data", K.dirty(name, shard), { dirty_at: nowIso() }); } catch { /* the nightly verify finds it */ }
}

// Puts one part of one row (row null removes it), only when `wv` is newer
// than what is there. CAS up to 5 tries; on failure the shard is marked
// dirty for a rebuild and the call still succeeds (the record is safe).
export async function applyIndexRow(name, shard, id, part, row, wv, opts = {}) {
  const sc = scopeOf(opts);
  const key = K.ix(name, shard);
  try {
    for (let i = 0; i < CAS_TRIES; i++) {
      const cur = await read(sc, "data", key);
      const blob = cur && cur.data ? cur.data : emptyIndex(name, shard);
      const entry = { ...(blob.rows[id] || {}) };
      if (entry[part] && entry[part].wv >= wv) return;
      entry[part] = row ? { wv, d: row } : { wv, d: null, at: nowIso() };
      const next = { ...blob, rows: pruneTombstones({ ...blob.rows, [id]: entry }), updated_at: nowIso(), _w: nonce(sc) };
      const w = await condWrite(sc, "data", key, next, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
      if (w.ok) return;
      await casJitter(i);
    }
  } catch (e) {
    if (!(isTransient(e) || e instanceof UnknownOutcome || e instanceof BudgetError)) throw e;
  }
  await markDirty(sc, name, shard);
}

// Worker only: rebuilds an index from the records (§3.5), merging by wv with
// whatever writers put there meanwhile, CAS on the blob, then clears the
// dirty marker by CAS from the value read BEFORE the records were listed:
// a dirty mark written while the rebuild runs changes the marker's etag and
// keeps its shard dirty, and a shard with no marker at the start is never
// marked clean. → { rows (all shards), shards }.
export async function rebuildIndex(name, { shards } = {}, opts = {}) {
  const sc = scopeOf(opts);
  const feeds = indexFeeds(name);
  if (!feeds.length) throw new RegistryError(`no index named ${name}`);
  const want = (s) => !shards || shards.includes(s);
  const dirtyBefore = new Map();
  const dirtyRoot = K.dirty(name, "");
  for (const k of await listKeys(dirtyRoot, {}, sc)) {
    if (k !== dirtyRoot && !k.startsWith(dirtyRoot + "/")) continue;
    const s = k === dirtyRoot ? "" : k.slice(dirtyRoot.length + 1);
    if (want(s)) dirtyBefore.set(s, await read(sc, "data", k).catch(() => null));
  }
  const built = new Map();
  for (const feed of feeds) {
    const def = getType(feed.type);
    const keys = await listKeys(`rec/${feed.type}/`, {}, sc);
    const recs = await mapLimit(keys, 16, (k) => read(sc, "data", k));
    for (const got of recs) {
      if (!got || !got.data) continue;
      const rec = strip(migrateRecord(def, got.data));
      let s = rec.deleted_at || rec.merged_into ? null : feed.shard(rec);
      if (s === null || s === undefined || !want(s)) continue;
      const rows = built.get(s) || {};
      rows[rec.id] = { ...(rows[rec.id] || {}), [feed.part]: { wv: rec.wv || 0, d: feed.row(rec) } };
      built.set(s, rows);
    }
  }
  const existing = (await listKeys(`ix/${name}`, {}, sc))
    .filter((k) => k === `ix/${name}` || k.startsWith(`ix/${name}/`))
    .map((k) => (k === `ix/${name}` ? "" : k.slice(`ix/${name}/`.length)));
  const targets = [...new Set([...(shards || []), ...built.keys(), ...existing.filter(want)])];
  let count = 0;
  for (const s of targets) {
    const fresh = built.get(s) || {};
    let done = false;
    let rows = 0;
    for (let i = 0; i < CAS_TRIES && !done; i++) {
      const cur = await read(sc, "data", K.ix(name, s));
      const current = (cur && cur.data && cur.data.rows) || {};
      const merged = {};
      for (const id of new Set([...Object.keys(current), ...Object.keys(fresh)])) {
        const a = current[id] || {};
        const b = fresh[id] || {};
        const entry = {};
        for (const part of new Set([...Object.keys(a), ...Object.keys(b)])) {
          if (a[part] && b[part]) entry[part] = a[part].wv > b[part].wv ? a[part] : b[part];
          else if (b[part]) entry[part] = b[part];
          else if (a[part] && !a[part].d) { if (liveTombstone(a[part], nowMs())) entry[part] = a[part]; }   // a recent tombstone stays (orders late writers)
          else if (a[part] && await stillFeeds(sc, name, s, id, part, a[part].wv)) entry[part] = a[part];
        }
        if (Object.keys(entry).length) merged[id] = entry;
      }
      rows = flatten(name, merged).length;
      const blob = { ...(cur && cur.data ? cur.data : emptyIndex(name, s)), rows: merged, built_at: nowIso(), updated_at: nowIso(), _w: nonce(sc) };
      const w = await condWrite(sc, "data", K.ix(name, s), blob, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
      done = w.ok;
      if (!done) await casJitter(i);
    }
    if (!done) { await markDirty(sc, name, s); continue; }
    count += rows;
    const d = dirtyBefore.get(s);
    if (d && d.data && d.data.dirty_at && !d.data.clean_at) {
      await condWrite(sc, "data", K.dirty(name, s), { clean_at: nowIso(), _w: nonce(sc) }, { onlyIfMatch: d.etag }).catch(() => null);
    }
  }
  return { rows: count, shards: targets.length };
}

// A row part the listing did not see: kept only if its record still exists
// and still belongs in this shard (it was written after the listing).
async function stillFeeds(sc, name, shard, id, part, wv) {
  const feed = indexFeeds(name).find((f) => f.part === part);
  if (!feed) return false;
  const type = feed.type === STATS_TYPE ? STATS_TYPE : typeOf(id) === feed.type ? feed.type : null;
  if (!type) return false;
  const got = await read(sc, "data", K.rec(type, id));
  if (!got || !got.data || got.data.deleted_at || got.data.merged_into) return false;
  return feed.shard(strip(got.data)) === shard && (got.data.wv || 0) >= wv;
}

// ----------------------------------------------------------- events and activity

const r4 = () => randomBytes(3).toString("hex").slice(0, 4);

// Write-once audit event (§3.8). → the event key.
export async function appendEvent(type, id, event, opts = {}) {
  const sc = scopeOf(opts);
  const at = event.at || nowIso();
  const key = K.evt(type, id, tsKey(new Date(at)), keySafe(event.action || "change", 40), keySafe(event.by || "system", 60), r4());
  await writeOnce(sc, "data", key, { ...event, at });
  return key;
}

// → [{ at, action, actor, key }] newest first.
export async function listEvents(type, id, { limit = 50 } = {}, opts = {}) {
  const prefix = `evt/${type}/${id}/`;
  const keys = await listKeys(prefix, {}, opts);
  return keys.map((key) => {
    const [ts, action, actor] = key.slice(prefix.length).split("--");
    const d = fromTsKey(ts);
    return { at: d ? d.toISOString() : null, action, actor, key };
  }).sort((a, b) => (a.key < b.key ? 1 : -1)).slice(0, limit);
}

export async function getEvent(key, opts = {}) {
  const got = await read(scopeOf(opts), "data", key);
  return got ? got.data : null;
}

export async function addActivity(contactId, kind, refId, at = now(), opts = {}) {
  await addRel("contact-activity", contactId, tsKey(at instanceof Date ? at : new Date(at)), `${keySafe(kind, 40)}--${refId}`, {}, opts);
}

// → [{ at, kind, refId }] newest first.
export async function listActivity(contactId, { limit = 50, before } = {}, opts = {}) {
  const rows = await listRel("contact-activity", contactId, { to: before, limit: limit + (before ? 1 : 0) }, opts);
  return rows
    .filter((r) => !before || r.sortKey < before)
    .slice(0, limit)
    .map((r) => {
      const at = r.id.lastIndexOf("--");
      const d = fromTsKey(r.sortKey);
      return { at: d ? d.toISOString() : null, kind: r.id.slice(0, at), refId: r.id.slice(at + 2) };
    });
}

// ----------------------------------------------------------- counters

// The next number of a sequence (§3.9): CAS + nonce on seq/{name}, then the
// number is claimed in ptr/{name}-no/{n}; a taken number is skipped.
// opts: { start (first number when the sequence is new), id (pointer value) }.
export async function nextNumber(seqName, opts = {}) {
  const sc = scopeOf(opts);
  const key = K.seq(seqName);
  for (let i = 0; i < 10; i++) {
    const cur = await read(sc, "data", key);
    const n = cur && cur.data && Number.isSafeInteger(cur.data.next) ? cur.data.next : (Number.isSafeInteger(opts.start) ? opts.start : 1);
    const w = await condWrite(sc, "data", key, { next: n + 1, updated_at: nowIso(), _w: nonce(sc) }, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
    if (!w.ok) { await casJitter(Math.min(i, 3)); continue; }
    const claim = await claimPointer(`${seqName}-no`, String(n), { id: opts.id || null, seq: seqName }, sc);
    if (claim.ok) return n;
    // taken (an imported or restored number): skip it
  }
  throw new StaleError(null, null, "Couldn't get the next number. Try again.");
}

// Cutover and restore only: sets the next number.
export async function setSequence(seqName, next, ctx = {}) {
  if (!Number.isSafeInteger(next) || next < 1) throw new InputError("The next number must be a positive whole number.", "next");
  const sc = scopeOf(ctx);
  const key = K.seq(seqName);
  for (let i = 0; i < CAS_TRIES; i++) {
    const cur = await read(sc, "data", key);
    const w = await condWrite(sc, "data", key, { next, updated_at: nowIso(), set_by: ctx.by || "system", _w: nonce(sc) }, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
    if (w.ok) return;
    await casJitter(i);
  }
  throw new StaleError(null, null, "The sequence kept changing. Try again.");
}

// ----------------------------------------------------------- settings

const isPlain = (v) => !!v && typeof v === "object" && !Array.isArray(v);
function mergeOver(defaults, stored) {
  if (!isPlain(stored)) return clone(defaults);
  const out = clone(defaults);
  for (const [k, v] of Object.entries(stored)) {
    if (k === "_w") continue;
    out[k] = isPlain(v) && isPlain(out[k]) ? mergeOver(out[k], v) : clone(v);
  }
  return out;
}

function settingsDef(name) {
  const def = getSettingsDef(name);
  if (!def) throw new InputError(`Unknown settings document ${name}.`, "name");
  return def;
}

// A settings document merged over its registered defaults, with its etag
// (null before the first save).
export async function getSettingWithEtag(name, opts = {}) {
  const def = settingsDef(name);
  const got = await read(scopeOf(opts), "data", K.cfg(name));
  return { data: mergeOver(def.defaults, got && got.data), etag: got ? got.etag : null };
}
export async function getSetting(name, opts = {}) {
  return (await getSettingWithEtag(name, opts)).data;
}

// Replaces a settings document (validated; unknown fields kept). From the
// API ctx.ifMatch is required ("new" for a document never saved).
export async function putSetting(name, value, ctx = {}) {
  const def = settingsDef(name);
  const c = ctxDefaults(ctx);
  const sc = scopeOf(ctx);
  if (c.origin === "api" && !c.ifMatch) throw new InputError("This change needs the version you edited (If-Match).", "if-match");
  const cleaned = def.validate(clone(value), { ctx: c });
  const key = K.cfg(name);
  for (let i = 0; i < (c.ifMatch ? 1 : CAS_TRIES); i++) {
    const cur = await read(sc, "data", key);
    if (c.ifMatch && c.ifMatch !== "new" && (!cur || cur.etag !== c.ifMatch)) throw new StaleError(cur ? mergeOver(def.defaults, cur.data) : null, cur ? cur.etag : null);
    if (c.ifMatch === "new" && cur) throw new StaleError(mergeOver(def.defaults, cur.data), cur.etag);
    const next = { ...cleaned, updated_at: nowIso(), updated_by: c.by, _w: nonce(sc) };
    const w = await condWrite(sc, "data", key, next, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
    if (w.ok) {
      await sideWrites(sc, [() => appendEvent("cfg", name, { by: c.by, origin: c.origin, action: "update", ...diffOf(cur && strip(cur.data), strip(next)), req: sc.requestId || null }, sc)]);
      return { data: mergeOver(def.defaults, next), etag: w.etag };
    }
    if (c.ifMatch) throw new StaleError(w.current ? mergeOver(def.defaults, w.current.data) : null, w.current ? w.current.etag : null);
    await casJitter(i);
  }
  throw new StaleError(null, null, "Settings kept changing. Try again.");
}

// ----------------------------------------------------------- markers (§7.3)

const markerOut = (data, key, etag) => ({ ...strip(data), _key: key, _etag: etag });

// → { ok: true, marker } when this holder now owns the marker;
//   { ok: false, marker } when it is busy, final, or an expired `sending`
//   (which goes to its provider's settler and is never re-run).
export async function claimMarker(ns, scope, key, { leaseMs = 120000, holder } = {}, opts = {}) {
  if (!NAMESPACES.includes(ns)) throw new TypeError(`claimMarker: namespace must be ${NAMESPACES.join(" or ")}`);
  if (!holder) throw new TypeError("claimMarker: holder is required");
  const sc = scopeOf(opts);
  const k = K.done(ns, scope, key);
  for (let i = 0; i < CAS_TRIES; i++) {
    const cur = await read(sc, "data", k);
    const t = nowMs();
    const decision = decideClaim(cur && cur.data, t);
    if (decision === "busy" || decision === "final") return { ok: false, marker: markerOut(cur.data, k, cur.etag) };
    if (decision === "settle") {
      const outcome = await settleSending(strip(cur.data));
      if (!outcome) return { ok: false, settling: true, marker: markerOut(cur.data, k, cur.etag) };
      const next = { ...advanceValue(strip(cur.data), outcome, t), settled_by: "fix.settle", _w: nonce(sc) };
      const w = await condWrite(sc, "data", k, next, { onlyIfMatch: cur.etag });
      if (!w.ok) { await casJitter(i); continue; }
      return { ok: false, marker: markerOut(next, k, w.etag) };
    }
    const value = { ...claimValue(cur && strip(cur.data), { holder, leaseMs, nowMs: t, ns, scope, key }), _w: nonce(sc) };
    const w = await condWrite(sc, "data", k, value, decision === "create" ? { onlyIfNew: true } : { onlyIfMatch: cur.etag });
    if (w.ok) return { ok: true, marker: markerOut(value, k, w.etag) };
    await casJitter(i);
  }
  const cur = await read(sc, "data", k);
  return { ok: false, marker: cur ? markerOut(cur.data, k, cur.etag) : null };
}

// Moves a marker this holder owns (CAS). A stale holder loses: StaleError.
export async function advanceMarker(marker, next, opts = {}) {
  if (!marker || !marker._key) throw new TypeError("advanceMarker: pass the marker claimMarker returned");
  const sc = scopeOf(opts);
  let etag = marker._etag;
  let current = strip({ ...marker, _key: undefined, _etag: undefined });
  delete current._key; delete current._etag;
  for (let i = 0; i < CAS_TRIES; i++) {
    const value = { ...advanceValue(current, next, nowMs()), _w: nonce(sc) };
    const w = await condWrite(sc, "data", marker._key, value, { onlyIfMatch: etag });
    if (w.ok) return markerOut(value, marker._key, w.etag);
    const fresh = w.current && w.current.data;
    if (!fresh || fresh.holder !== marker.holder || fresh.state !== marker.state || fresh.attempt !== marker.attempt) {
      throw new StaleError(fresh ? markerOut(fresh, marker._key, w.current.etag) : null, w.current ? w.current.etag : null, "Another worker owns this step now.");
    }
    etag = w.current.etag;
    current = strip(fresh);
  }
  throw new StaleError(null, null, "The step kept changing.");
}

// ----------------------------------------------------------- leases

export async function acquireLease(name, ms, holder, opts = {}) {
  const sc = scopeOf(opts);
  const k = K.lock(name);
  for (let i = 0; i < 3; i++) {
    const cur = await read(sc, "data", k);
    const t = nowMs();
    const d = cur && cur.data;
    if (d && d.holder && d.holder !== holder && Date.parse(d.until) > t) return false;
    const value = { holder, until: new Date(t + ms).toISOString(), acquired_at: d && d.holder === holder ? d.acquired_at : new Date(t).toISOString(), _w: nonce(sc) };
    const w = await condWrite(sc, "data", k, value, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
    if (w.ok) return true;
    await casJitter(i);
  }
  return false;
}

export async function renewLease(name, ms, holder, opts = {}) {
  const sc = scopeOf(opts);
  const k = K.lock(name);
  const cur = await read(sc, "data", k);
  if (!cur || !cur.data || cur.data.holder !== holder) return false;
  const w = await condWrite(sc, "data", k, { ...strip(cur.data), until: new Date(nowMs() + ms).toISOString(), renewed_at: nowIso(), _w: nonce(sc) }, { onlyIfMatch: cur.etag });
  return w.ok;
}

// CAS to an expired value (Blobs has no conditional delete).
export async function releaseLease(name, holder, opts = {}) {
  const sc = scopeOf(opts);
  const k = K.lock(name);
  const cur = await read(sc, "data", k);
  if (!cur || !cur.data || cur.data.holder !== holder) return;
  await condWrite(sc, "data", k, { holder: null, until: new Date(0).toISOString(), released_at: nowIso(), released_by: holder, _w: nonce(sc) }, { onlyIfMatch: cur.etag });
}

// ----------------------------------------------------------- idempotency records (§2.2 step 6)

export const IDEM_TTL_MS = 7 * 24 * 3600 * 1000;
// A `pending` record older than this belongs to a request that died (a
// request's budget is 8 s), so a retry may take it over.
export const IDEM_PENDING_STALE_MS = 60 * 1000;
const DEFINITIVE_4XX = new Set([400, 403, 404, 409, 412, 422]);
const idemKey = (uid, key) => {
  const k = String(key || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{7,99}$/.test(k)) throw new InputError("Idempotency-Key should be a uuid.", "idempotency-key");
  return K.idem(keySafe(uid || "anon", 60), k);
};

export async function idemBegin(uid, key, reqHash, opts = {}) {
  const sc = scopeOf(opts);
  const k = idemKey(uid, key);
  for (let i = 0; i < 3; i++) {
    const cur = await read(sc, "data", k);
    const t = nowMs();
    const d = cur && cur.data;
    const expired = d && Date.parse(d.at) + IDEM_TTL_MS <= t;
    const staleP = d && d.state === "pending" && Date.parse(d.at) + IDEM_PENDING_STALE_MS <= t;
    if (d && !expired && !staleP) {
      if (d.state === "pending") return { state: "pending" };
      if (d.req_hash !== reqHash) return { state: "mismatch" };
      return { state: "done", response: d.response };
    }
    const value = { state: "pending", req_hash: reqHash, at: new Date(t).toISOString(), _w: nonce(sc) };
    const w = await condWrite(sc, "data", k, value, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
    if (w.ok) return { state: "new" };
    await casJitter(i);
  }
  return { state: "pending" };
}

// Stores 2xx and definitive 4xx answers for replay; anything else deletes
// the record so the retry runs again.
export async function idemFinish(uid, key, response, opts = {}) {
  const sc = scopeOf(opts);
  const k = idemKey(uid, key);
  const status = response && response.status;
  const definitive = (status >= 200 && status < 300) || DEFINITIVE_4XX.has(status);
  if (!definitive) { await del(sc, "data", k); return; }
  for (let i = 0; i < 3; i++) {
    const cur = await read(sc, "data", k);
    const d = cur && cur.data;
    const value = {
      state: "done", req_hash: d ? d.req_hash : null, at: d ? d.at : nowIso(), done_at: nowIso(),
      response: { status, body: response.body ?? null, headers: response.headers || {} }, _w: nonce(sc),
    };
    const w = await condWrite(sc, "data", k, value, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
    if (w.ok) return;
    await casJitter(i);
  }
}

// ----------------------------------------------------------- files (crm-files)

const fileKey = (fileId, thumb) => `${thumb ? "t" : "f"}/${fileId}`;

// Bytes of a file (onlyIfNew; small metadata, nothing personal). Settled by
// the sha256 in the metadata.
export async function putFileBytes(fileId, bytes, meta = {}, { thumb = false } = {}, opts = {}) {
  const sc = scopeOf(opts);
  const key = assertKey(fileKey(fileId, thumb));
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    let res = null;
    try { res = (await attempt(sc, "files", "write", (s) => s.set(key, bytes, { onlyIfNew: true, metadata: meta }))).result; } catch (e) { if (!isTransient(e)) throw e; }
    if (res && res.modified && res.etag) return { etag: res.etag };
    const cur = await retrying(sc, "read", async () => (await attempt(sc, "files", "read", (s) => s.getMetadata(key))).result).catch(() => undefined);
    if (cur === undefined) throw await unknownOutcome(sc, "files", key, meta, null);
    if (cur) {
      if (cur.metadata && meta.sha256 && cur.metadata.sha256 === meta.sha256) return { etag: cur.etag };
      throw new ExistsError("That file already exists.");
    }
    if (i < MAX_ATTEMPTS - 1) await backoff(i, sc);
  }
  throw await unknownOutcome(sc, "files", key, meta, null);
}

export async function getFileStream(fileId, { thumb = false, ifNoneMatch } = {}, opts = {}) {
  const sc = scopeOf(opts);
  const got = await read(sc, "files", fileKey(fileId, thumb), { type: "stream", etag: ifNoneMatch });
  if (!got) return null;
  if (got.data === null && ifNoneMatch && got.etag === ifNoneMatch) return { notModified: true };
  return { stream: got.data, meta: got.metadata || {}, etag: got.etag };
}

export async function deleteFileBytes(fileId, opts = {}) {
  const sc = scopeOf(opts);
  await del(sc, "files", fileKey(fileId, false));
  await del(sc, "files", fileKey(fileId, true));
}

// ----------------------------------------------------------- raw access (worker, backup, import, tests)

// How long a page call that timed out may still finish before the walk asks
// for the page again (guardedFetch aborts it at about the same time).
const LATE_PAGE_MS = 250;
const settledWithin = (p, ms) => new Promise((resolve) => {
  const t = setTimeout(() => resolve({ ok: false }), ms);
  p.then((value) => { clearTimeout(t); resolve({ ok: true, value }); }, () => { clearTimeout(t); resolve({ ok: false }); });
});

// One listing walk (paginate: true): every page is its own attempt, with its
// own timeout and retries, and counts as one storage call; the walk as a
// whole is bounded by the budget, not by one attempt. A retried page reuses
// the cursor (the client advances it only on success); a page call that
// timed out but then answers is used rather than asked again.
async function listWalk(sc, kind, prefix, directories) {
  const { store } = await handle(kind, sc);
  const listOpts = { prefix, ...(directories ? { directories: true } : {}) };
  const blobs = [];
  const dirs = new Set();
  const iterable = store.list({ ...listOpts, paginate: true });
  if (!iterable || typeof iterable[Symbol.asyncIterator] !== "function") {
    // a store without paginate support (a test fake): one call for the whole listing
    if (iterable && typeof iterable.then === "function") iterable.then(null, () => {});
    const res = await retrying(sc, "list", async () => (await attempt(sc, kind, "list", (s) => s.list(listOpts))).result);
    for (const b of (res && res.blobs) || []) blobs.push(b.key);
    for (const d of (res && res.directories) || []) dirs.add(d);
    return { keys: [...new Set(blobs)].sort(), directories: [...dirs].sort() };
  }
  const it = iterable[Symbol.asyncIterator]();
  for (;;) {
    const page = await retrying(sc, "list", async () => {
      if (sc.budget) sc.budget.tick();
      const ms = attemptMs(sc);
      const p = it.next();
      try {
        return await timeoutRace(() => p, ms, "list");
      } catch (e) {
        if (!(e instanceof TimeoutError)) throw e;
        const late = await settledWithin(p, LATE_PAGE_MS);
        if (late.ok) return late.value;
        throw e;
      }
    });
    if (!page || page.done) break;
    const v = page.value || {};
    for (const b of v.blobs || []) blobs.push(b.key);
    for (const d of v.directories || []) dirs.add(d);
  }
  return { keys: [...new Set(blobs)].sort(), directories: [...dirs].sort() };
}

// Sorted keys under a prefix (every page). With directories: { keys, directories }.
export async function listKeys(prefix, { directories = false, kind = "data" } = {}, opts = {}) {
  const res = await listWalk(scopeOf(opts), kind, prefix, directories);
  return directories ? res : res.keys;
}

// Calls fn(key) for every key after `afterKey`, in key order, while the
// budget lasts. → { done, lastKey } (resume with afterKey: lastKey). The
// prefix is listed completely first (page by page, under `budget` when
// given) because the list order is undocumented; each invocation re-lists
// and skips keys <= afterKey (§3.12: Blobs list cursors cannot be resumed).
export async function forEachKey(prefix, fn, { concurrency = 16, budget, afterKey, kind = "data" } = {}, opts = {}) {
  const keys = (await listKeys(prefix, { kind }, budget ? { ...opts, budget } : opts)).filter((k) => afterKey === undefined || k > afterKey);
  let lastKey = afterKey;
  for (let i = 0; i < keys.length; i += concurrency) {
    if (budget && budget.left() < 1000) return { done: false, lastKey };
    const chunk = keys.slice(i, i + concurrency);
    await mapLimit(chunk, concurrency, fn);
    lastKey = chunk[chunk.length - 1];
  }
  return { done: true, lastKey };
}

// { data, etag, metadata } | null; opts.type defaults to "json".
export async function getRaw(key, opts = {}) {
  return read(scopeOf(opts), opts.kind || "data", key, { type: opts.type || "json" });
}

// Families that must always be written conditionally (§0 rule 4).
const CONDITIONAL_ONLY = /^(rec|ptr|ix|seq|cfg)\//;

// A raw write. Unconditional writes are retried; a conditional one is a
// single attempt and reports { modified, etag, ambiguous }.
export async function putRaw(key, value, setOpts = {}, opts = {}) {
  const sc = scopeOf(opts);
  const kind = opts.kind || "data";
  assertKey(key);
  const conditional = !!(setOpts.onlyIfNew || setOpts.onlyIfMatch);
  if (!conditional && kind === "data" && CONDITIONAL_ONLY.test(key)) throw new TypeError("putRaw: this key family is written conditionally only (§0 rule 4)");
  const write = (s) => (typeof value === "string" || value instanceof ArrayBuffer || ArrayBuffer.isView(value) ? s.set(key, value, setOpts) : s.setJSON(key, value, setOpts));
  if (!conditional) return retrying(sc, "write", async () => (await attempt(sc, kind, "write", write)).result);
  const r = await attempt(sc, kind, "write", write);
  return { ...r.result, ambiguous: !!(r.transient || (r.result && r.result.modified && !r.result.etag)) };
}

export async function deleteRaw(key, opts = {}) {
  await del(scopeOf(opts), opts.kind || "data", key);
}

// Exported for core/probe.mjs and tests: one settled conditional write.
export async function settledWrite(key, value, cond, opts = {}) {
  const sc = scopeOf(opts);
  return condWrite(sc, opts.kind || "data", key, { ...value, _w: value._w || nonce(sc) }, cond);
}

// ----------------------------------------------------------- repair and verify (the worker, §3.4, §3.5)

// A pend/ marker younger than this belongs to a write that may still be
// running (a request's budget is 8 s); the worker leaves it alone (§3.5).
export const PEND_GRACE_MS = 60 * 1000;

const ptrKeysOf = (def, rec) => new Set(sidePlan(def, rec).unique.map((p) => K.ptr(p.kind, p.key)));

// The side writes of a record as it now stands (pointers, lookup lists,
// relations, index rows), plus the undo of the previous version's when an
// update moved them (`prev` from the pend/ marker). All idempotent.
function repairSides(sc, def, rec, prev) {
  const id = rec.id;
  const plan = sidePlan(def, rec);
  const out = [];
  for (const p of plan.unique) {
    out.push(async () => {
      const r = await claimPointer(p.kind, p.key, { id }, sc);
      if (!r.ok && !(r.current && r.current.id === id)) console.error("crm-store: a repaired record's unique pointer is held by another record; left for pointers.gc");
    });
  }
  for (const p of plan.lists) out.push(() => updatePointerList(p.kind, p.key, (ids) => [...ids, id], sc));
  for (const r of plan.rels) out.push(() => addRel(r.rel, r.parent, r.sort, id, r.value, sc));
  const live = new Set();
  for (const x of plan.ix) {
    if (x.shard === null) continue;
    live.add(`${x.name}\u0000${x.part}\u0000${x.shard}`);
    out.push(() => applyIndexRow(x.name, x.shard, id, x.part, x.row, rec.wv || 0, sc));
  }
  if (prev) {
    for (const x of prev.ix || []) {
      if (x.shard === null || x.shard === undefined || live.has(`${x.name}\u0000${x.part}\u0000${x.shard}`)) continue;
      out.push(() => applyIndexRow(x.name, x.shard, id, x.part, null, rec.wv || 0, sc));
    }
    const relsNow = new Set(plan.rels.map(rkey));
    for (const r of prev.rels || []) if (!relsNow.has(rkey(r))) out.push(() => removeRel(r.rel, r.parent, r.sort, id, sc));
    const listsNow = new Set(plan.lists.map(pkey));
    for (const p of prev.lists || []) if (!listsNow.has(pkey(p))) out.push(() => updatePointerList(p.kind, p.key, (ids) => ids.filter((x) => x !== id), sc));
    const uniqueNow = new Set(plan.unique.map(pkey));
    for (const p of prev.unique || []) {
      if (uniqueNow.has(pkey(p))) continue;
      const k = pkey(p);
      out.push(() => releasePointer(p.kind, p.key, id, { ...sc, released: (r) => !keysOf(def, r).has(k), holds: (r) => keysOf(def, r).has(k) }));
    }
  }
  return out;
}

// A write whose record never landed: its claimed unique pointers are
// released (releasePointer proves the record absent first); anything else
// in the plan is removed again (no-ops when it was never applied).
function releaseSides(sc, def, id, plan, wv) {
  if (!plan) return [];
  const out = [];
  for (const p of plan.unique || []) out.push(() => releasePointer(p.kind, p.key, id, sc));
  for (const p of plan.lists || []) out.push(() => updatePointerList(p.kind, p.key, (ids) => ids.filter((x) => x !== id), sc));
  for (const r of plan.rels || []) out.push(() => removeRel(r.rel, r.parent, r.sort, id, sc));
  for (const x of plan.ix || []) {
    if (x.shard === null || x.shard === undefined) continue;
    out.push(() => applyIndexRow(x.name, x.shard, id, x.part, null, (wv || 0) + 1, sc));
  }
  return out;
}

// The worker's index.pending step for one pend/{type}/{id} marker: finishes
// what the write left undone and deletes the marker (only the version it
// repaired: a newer write's intent stays for that writer).
// → { state: "repaired" | "absent" | "fresh" | "gone" | "newer", clean? }
export async function repairPending(type, id, { minAgeMs = PEND_GRACE_MS } = {}, opts = {}) {
  const sc = scopeOf(opts);
  const pk = K.pend(type, id);
  const p = await read(sc, "data", pk);
  if (!p || !p.data) return { state: "gone" };
  const at = Date.parse(p.data.at);
  if (Number.isFinite(at) && at + minAgeMs > nowMs()) return { state: "fresh" };
  const def = getType(type);
  if (!def) {                                   // no module declares this type any more
    await del(sc, "data", pk);
    return { state: "absent", clean: true };
  }
  const cur = await read(sc, "data", K.rec(type, id));
  if (cur && cur.data && Number.isSafeInteger(cur.data.v) && cur.data.v > def.v) return { state: "newer" };   // newer code finishes it
  const rec = cur && cur.data ? strip(migrateRecord(def, cur.data)) : null;
  const side = rec ? repairSides(sc, def, rec, p.data.prev || null) : releaseSides(sc, def, id, p.data.plan, p.data.wv);
  const clean = await sideWrites(sc, side);
  if (clean) {
    const again = await read(sc, "data", pk);
    if (again && again.etag === p.etag) await del(sc, "data", pk);
  }
  return { state: rec ? "repaired" : "absent", clean };
}

// The index name and shard an ix/ key belongs to (index names may hold "/").
function indexOfKey(key, names) {
  const rest = key.slice(3);
  const name = [...names].sort((a, b) => b.length - a.length).find((n) => rest === n || rest.startsWith(n + "/"));
  return name ? { name, shard: rest === name ? "" : rest.slice(name.length + 1) } : null;
}

// The worker's fix.settle step for one fix/ marker (§3.4): an outcome the
// store could not settle while the request ran. A record that is there gets
// its side writes finished; an index blob is marked dirty for a rebuild; a
// pointer that could not be released is released once its record is proven
// absent (or no longer holds it). Then the marker is deleted.
// → { state }
export async function settleFix(fixKey, { indexNames = [] } = {}, opts = {}) {
  const sc = scopeOf(opts);
  const f = await read(sc, "data", fixKey);
  if (!f || !f.data) return { state: "gone" };
  const m = f.data;
  const key = String(m.key || "");
  const kind = Object.hasOwn(STORES, m.store) ? m.store : "data";
  let state = "settled";
  if (m.kind === "release" && key.startsWith("ptr/")) {
    const cur = await read(sc, "data", key);
    if (!cur || !cur.data || cur.data.id !== m.expect) state = "gone";
    else {
      const type = typeOf(m.expect);
      const def = type ? getType(type) : null;
      const rec = def ? await read(sc, "data", K.rec(type, m.expect)) : null;
      const live = rec && rec.data ? strip(rec.data) : null;
      if (!def) state = "kept";
      else if (live && ptrKeysOf(def, live).has(key)) state = "kept";
      else { await del(sc, "data", key); state = "released"; }
    }
  } else if (kind === "data" && key.startsWith("rec/")) {
    const [, type, id] = key.split("/");
    const def = getType(type);
    const cur = await read(sc, "data", key);
    if (def && cur && cur.data && !(Number.isSafeInteger(cur.data.v) && cur.data.v > def.v)) {
      await sideWrites(sc, repairSides(sc, def, strip(migrateRecord(def, cur.data)), null));
    }
    state = cur && cur.data ? (m.nonce && cur.data._w === m.nonce ? "committed" : "superseded") : "absent";
    if (!cur && type && id) {
      const pend = await read(sc, "data", K.pend(type, id));
      if (pend) state = "absent-pending";            // index.pending releases what it claimed
    }
  } else if (kind === "data" && key.startsWith("ix/")) {
    const at = indexOfKey(key, indexNames.length ? indexNames : allIndexes());
    if (at) await markDirty(sc, at.name, at.shard);
    state = "dirty";
  }
  await del(sc, "data", fixKey);
  return { state };
}


// The authoritative part of one index row for (name, shard, id, part):
// { wv, d } from a fresh read of the record that feeds it (d null = no row).
async function authoritativePart(sc, name, shard, id, part) {
  const feed = indexFeeds(name).find((f) => f.part === part);
  if (!feed) return { wv: 0, d: null };
  const type = feed.type === STATS_TYPE ? STATS_TYPE : typeOf(id) === feed.type ? feed.type : null;
  if (!type) return { wv: 0, d: null };
  const got = await read(sc, "data", K.rec(type, id));
  if (!got || !got.data) return { wv: 0, d: null };
  const rec = strip(migrateRecord(getType(type), got.data));
  if (rec.deleted_at || rec.merged_into || feed.shard(rec) !== shard) return { wv: rec.wv || 0, d: null };
  return { wv: rec.wv || 0, d: feed.row(rec) };
}

// The nightly index.verify for one index (§3.5): builds every shard's rows
// from the records, diffs them with the live blobs, re-checks each
// difference against a fresh read of its record (a write may have landed
// meanwhile), and repairs the confirmed ones by CAS on the shard (a forced
// replace: a planted or corrupted row loses even with a higher wv).
// → { rows, missing, extra, stale, repaired: [shards] }
export async function verifyIndex(name, { repair = true } = {}, opts = {}) {
  const sc = scopeOf(opts);
  const feeds = indexFeeds(name);
  if (!feeds.length) throw new RegistryError(`no index named ${name}`);
  const expected = new Map();
  let rows = 0;
  for (const feed of feeds) {
    const def = getType(feed.type);
    const keys = await listKeys(`rec/${feed.type}/`, {}, sc);
    const recs = await mapLimit(keys, 16, (k) => read(sc, "data", k));
    for (const got of recs) {
      if (!got || !got.data) continue;
      const rec = strip(migrateRecord(def, got.data));
      const s = rec.deleted_at || rec.merged_into ? null : feed.shard(rec);
      if (s === null || s === undefined) continue;
      const m = expected.get(s) || {};
      m[rec.id] = { ...(m[rec.id] || {}), [feed.part]: { wv: rec.wv || 0, d: feed.row(rec) } };
      expected.set(s, m);
    }
  }
  const liveShards = (await listKeys(`ix/${name}`, {}, sc))
    .filter((k) => k === `ix/${name}` || k.startsWith(`ix/${name}/`))
    .map((k) => (k === `ix/${name}` ? "" : k.slice(`ix/${name}/`.length)));
  const counts = { missing: 0, extra: 0, stale: 0 };
  const repaired = [];
  for (const s of new Set([...expected.keys(), ...liveShards])) {
    const cur = await read(sc, "data", K.ix(name, s));
    const live = (cur && cur.data && cur.data.rows) || {};
    const exp = expected.get(s) || {};
    const diffs = [];
    for (const id of new Set([...Object.keys(live), ...Object.keys(exp)])) {
      const l = live[id] || {};
      const e = exp[id] || {};
      for (const part of new Set([...Object.keys(l), ...Object.keys(e)])) {
        const lp = l[part] && l[part].d ? l[part] : null;
        const ep = e[part] || null;
        if (ep && !lp) diffs.push({ id, part, kind: "missing" });
        else if (!ep && lp) diffs.push({ id, part, kind: "extra" });
        else if (ep && lp && !sameJSON(ep.d, lp.d)) diffs.push({ id, part, kind: "stale" });
      }
    }
    rows += Object.values(exp).length;
    if (!diffs.length) continue;
    const fixes = [];
    for (const d of diffs) {
      const truth = await authoritativePart(sc, name, s, d.id, d.part);
      const lp = live[d.id] && live[d.id][d.part] && live[d.id][d.part].d ? live[d.id][d.part] : null;
      if (truth.d ? lp && sameJSON(truth.d, lp.d) : !lp) continue;   // a write landed meanwhile: nothing to fix
      counts[d.kind] += 1;
      fixes.push({ ...d, truth });
    }
    if (!repair || !fixes.length) continue;
    let done = false;
    for (let i = 0; i < CAS_TRIES && !done; i++) {
      const now0 = await read(sc, "data", K.ix(name, s));
      const blob = now0 && now0.data ? now0.data : emptyIndex(name, s);
      const next = { ...blob.rows };
      for (const f of fixes) {
        const entry = { ...(next[f.id] || {}) };
        const have = entry[f.part];
        // a writer that got there after the truth was read wins (higher wv, same data source)
        if (have && have.wv > f.truth.wv && (await authoritativePart(sc, name, s, f.id, f.part)).wv >= have.wv) continue;
        entry[f.part] = f.truth.d ? { wv: f.truth.wv, d: f.truth.d } : { wv: f.truth.wv, d: null, at: nowIso() };
        next[f.id] = entry;
      }
      const value = { ...blob, rows: pruneTombstones(next), updated_at: nowIso(), verified_at: nowIso(), _w: nonce(sc) };
      const w = await condWrite(sc, "data", K.ix(name, s), value, now0 ? { onlyIfMatch: now0.etag } : { onlyIfNew: true });
      done = w.ok;
      if (!done) await casJitter(i);
    }
    if (done) repaired.push(s);
    else await markDirty(sc, name, s);
  }
  return { rows, ...counts, repaired };
}

// The relation half of index.verify (§3.5): every relation family a type
// declares, rebuilt from its records and compared with the live keys. Only
// keys whose child is of this type are judged (other writers may share a
// family). → { missing, extra }
export async function verifyRels(type, { repair = true } = {}, opts = {}) {
  const sc = scopeOf(opts);
  const def = requireType(type);
  if (!def.rels.length) return { missing: 0, extra: 0 };
  const keys = await listKeys(`rec/${type}/`, {}, sc);
  const recs = (await mapLimit(keys, 16, (k) => read(sc, "data", k))).filter((g) => g && g.data).map((g) => strip(migrateRecord(def, g.data)));
  const expected = new Map();
  for (const rec of recs) for (const r of sidePlan(def, rec).rels) expected.set(K.rel(r.rel, r.parent, r.sort, rec.id), { ...r, id: rec.id });
  const counts = { missing: 0, extra: 0 };
  const fresh = async (id) => {
    const got = await read(sc, "data", K.rec(type, id));
    return got && got.data ? new Set(sidePlan(def, strip(migrateRecord(def, got.data))).rels.map((r) => K.rel(r.rel, r.parent, r.sort, id))) : new Set();
  };
  for (const family of new Set(def.rels.map((r) => r.rel))) {
    const live = new Set(await listKeys(`rel/${family}/`, {}, sc));
    for (const [k, r] of expected) {
      if (r.rel !== family || live.has(k)) continue;
      if (!(await fresh(r.id)).has(k)) continue;
      counts.missing += 1;
      if (repair) await addRel(r.rel, r.parent, r.sort, r.id, r.value, sc);
    }
    for (const k of live) {
      const child = k.slice(k.lastIndexOf("--") + 2);
      if (typeOf(child) !== type || expected.has(k)) continue;
      if ((await fresh(child)).has(k)) continue;
      counts.extra += 1;
      if (repair) await del(sc, "data", k);
    }
  }
  return counts;
}
