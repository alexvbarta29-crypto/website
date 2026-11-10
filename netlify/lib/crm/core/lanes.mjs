// Barta CRM core: the two worker lanes, their secret and kicks, the health
// document, and runs (design §7.1, §2.2 "Kicking a lane", §7.2 step 4).
//
// Lanes. Fast (crm-worker-background): queue items, sends, every-pass and
// short sweeps, ops resume, pend/ and fix/ settling, health. Bulk
// (crm-bulk-background): runs (reindex, verify, backups, exports, imports,
// bulk sends), long sweeps. Each lane has its own lease (lock/worker-fast,
// lock/worker-bulk), so a backup never delays a reminder.
//
// The secret. sys/worker-secret (32 random bytes, written once with
// onlyIfNew by the cron) authenticates kicks: header x-crm-worker, compared
// in constant time. No env var is needed.
//
// Kicks. kickWorker(lane, reason) POSTs to the lane's function on the
// canonical origin (production) or this deploy's own origin, with a 1.5 s
// timeout, through context.waitUntil when the request has it; failures are
// ignored (the 15-minute cron picks the work up). Tests install a recorder
// with setKicker(); with the memory stores in use and no recorder, nothing
// is sent anywhere.
//
// Health. sys/health = { cron_at, lanes: { fast: {...}, bulk: {...} },
// queue: { depth, due, next_due_at }, index_verify, backup, files_backup,
// offsite_at, alerts }, merged by CAS from the cron and both lanes.
//
// Runs. rec/run/{id} records ({ kind, status, lane, input, progress,
// checkpoint, result, error, attempts, retry_at }), indexed in
// ix/runs/recent. A route with mode "run" (or a sweep) calls createRun(),
// which kicks the lane; the lane advances one run by one checkpointed step
// per chunk (stepRun). Kinds are defined with defineRun(kind, { lane, step,
// maintenance }) by the module that owns them.

import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { getRaw, settledWrite, createRecord, updateRecord, getRecord, readIndex, currentScope, withBudget } from "../../crm-store.mjs";
import { CANONICAL_ORIGIN } from "./context.mjs";
import { nowIso, nowMs } from "./clock.mjs";
import { newId, isId } from "./ids.mjs";
import { InputError, RegistryError, NotFoundError } from "./errors.mjs";
import { keySafe } from "./text.mjs";
import { safeErr } from "../../referral-lib.mjs";

export const LANES = Object.freeze({
  fast: Object.freeze({ lease: "worker-fast", fn: "crm-worker-background" }),
  bulk: Object.freeze({ lease: "worker-bulk", fn: "crm-bulk-background" }),
});
export const LANE_NAMES = Object.freeze(Object.keys(LANES));
export const WORKER_SECRET_KEY = "sys/worker-secret";
export const HEALTH_KEY = "sys/health";
export const KICK_TIMEOUT_MS = 1500;
export const WORKER_HEADER = "x-crm-worker";

export const lanePath = (lane) => `/.netlify/functions/${LANES[lane].fn}`;
const needLane = (lane) => { if (!Object.hasOwn(LANES, lane)) throw new TypeError(`lanes: unknown lane ${lane}`); return lane; };

// Where the lane functions live: the canonical host in production (§3.10
// "worker kicks always use the canonical origin"), else this deploy's URL.
export function workerOrigin(deploy, req, env = process.env) {
  if (deploy && deploy.ctx === "production") return CANONICAL_ORIGIN;
  if (env.URL) return env.URL.replace(/\/+$/, "");
  try { return new URL(req.url).origin; } catch { return CANONICAL_ORIGIN; }
}

// ------------------------------------------------------------ the secret

let secretCache = null;   // { value, at }
const SECRET_CACHE_MS = 10 * 60 * 1000;

// Creates sys/worker-secret once (onlyIfNew; a racing cron's value wins) and returns it.
export async function ensureWorkerSecret(opts = {}) {
  const cur = await getRaw(WORKER_SECRET_KEY, opts);
  if (cur && cur.data && cur.data.secret) return cur.data.secret;
  const w = await settledWrite(WORKER_SECRET_KEY, { secret: randomBytes(32).toString("hex"), at: nowIso() }, { onlyIfNew: true }, opts);
  const got = w.ok ? await getRaw(WORKER_SECRET_KEY, opts) : w.current;
  return got && got.data ? got.data.secret : null;
}

export async function readWorkerSecret(opts = {}, { fresh = false } = {}) {
  const t = nowMs();
  if (!fresh && secretCache && t - secretCache.at < SECRET_CACHE_MS && t >= secretCache.at) return secretCache.value;
  const got = await getRaw(WORKER_SECRET_KEY, opts);
  const value = got && got.data && got.data.secret ? got.data.secret : null;
  if (value) secretCache = { value, at: t };
  return value;
}
export function clearSecretCache() { secretCache = null; }

const digest = (s) => createHash("sha256").update(String(s)).digest();
export const sameSecret = (given, secret) => !!given && !!secret && timingSafeEqual(digest(given), digest(secret));

// ------------------------------------------------------------ kicks

let kicker = null;
// Tests: fn(lane, reason, info) records the kick instead of sending it; null restores fetch.
export function setKicker(fn) { kicker = typeof fn === "function" ? fn : null; }

async function sendKick(lane, reason, { origin, secret }) {
  const res = await fetch(origin + lanePath(lane), {
    method: "POST",
    headers: { [WORKER_HEADER]: secret, "content-type": "application/json" },
    body: JSON.stringify({ reason: String(reason || "kick").slice(0, 60) }),
    signal: AbortSignal.timeout(KICK_TIMEOUT_MS),
  });
  try { await res.body?.cancel(); } catch { /* nothing to free */ }
  return res.status;
}

// Wakes a lane (§2.2): never throws, never holds the answer longer than the
// kick's 1.5 s timeout (with context.waitUntil it does not hold it at all).
// opts: { origin, secret, waitUntil, deploy } (defaults from the store scope).
export async function kickWorker(lane, reason = "kick", opts = {}) {
  needLane(lane);
  const scope = currentScope() || {};
  const info = { origin: opts.origin || scope.origin || null, deploy: opts.deploy || scope.deploy || null };
  if (kicker) { try { await kicker(lane, reason, info); } catch { /* ignored */ } return true; }
  if (globalThis.__crmStoreOverride) return false;     // tests without a recorder: nothing leaves the process
  const work = (async () => {
    try {
      const secret = opts.secret || await readWorkerSecret({ deploy: info.deploy, budget: withBudget(2000, 4, { strict: false }) });
      if (!secret) return false;
      const origin = info.deploy && info.deploy.ctx === "production" ? CANONICAL_ORIGIN : (info.origin || CANONICAL_ORIGIN);
      const status = await sendKick(lane, reason, { origin, secret });
      if (status !== 202) console.error(`crm:lanes: the ${lane} lane kick answered ${status}`);
      return status === 202;
    } catch (e) {
      console.error(`crm:lanes: the ${lane} lane kick failed (${safeErr(e)})`);
      return false;
    }
  })();
  const wait = opts.waitUntil || scope.waitUntil;
  if (typeof wait === "function") { try { wait(work); return true; } catch { /* fall through */ } }
  return work;
}

// ------------------------------------------------------------ health

// CAS merge on sys/health: mutate(health) → new health | null. Best effort
// (health must never stop a pass): returns null when it could not write.
export async function updateHealth(mutate, opts = {}) {
  try {
    for (let i = 0; i < 4; i++) {
      const cur = await getRaw(HEALTH_KEY, opts);
      const base = cur && cur.data ? { ...cur.data } : { lanes: {} };
      delete base._w;
      const next = mutate(JSON.parse(JSON.stringify(base)));
      if (!next) return base;
      const w = await settledWrite(HEALTH_KEY, { ...next, updated_at: nowIso() }, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true }, opts);
      if (w.ok) return next;
    }
  } catch (e) {
    console.error("crm:lanes: health not written (" + safeErr(e) + ")");
  }
  return null;
}

export async function readHealth(opts = {}) {
  const got = await getRaw(HEALTH_KEY, opts);
  const h = got && got.data ? { ...got.data } : { lanes: {} };
  delete h._w;
  return h;
}

// A lane is "stuck" when it has not finished a pass for 3 hours (§7.2 step 4).
export const STUCK_MS = 3 * 3600 * 1000;
export function laneStatus(health, lane, t = nowMs()) {
  const l = health && health.lanes && health.lanes[lane];
  if (!l || !l.last_pass_at) return "never";
  return Date.parse(l.last_pass_at) + STUCK_MS > t ? "ok" : "stuck";
}

// Adds (or refreshes) an alert the owners see on Today: { key, level, text, at }.
export function withAlert(health, key, text, level = "warn") {
  const alerts = Array.isArray(health.alerts) ? health.alerts.filter((a) => a.key !== key) : [];
  alerts.push({ key, level, text, at: nowIso() });
  return { ...health, alerts: alerts.slice(-20) };
}
export function withoutAlert(health, key) {
  return { ...health, alerts: Array.isArray(health.alerts) ? health.alerts.filter((a) => a.key !== key) : [] };
}

// ------------------------------------------------------------ runs

export const RUN_STATUSES = Object.freeze(["queued", "running", "done", "failed", "cancelled"]);
export const RUN_MAX_ATTEMPTS = 8;
const runKinds = new Map();

// A run kind: step(run, rctx) → { checkpoint?, progress?: { done, total }, done?, result? }.
// The step is resumable from its checkpoint (a killed function re-runs it).
// lane: which lane runs it; maintenance: true keeps it running while paused.
export function defineRun(kind, { lane = "bulk", step, maintenance = false, label } = {}) {
  if (typeof kind !== "string" || !/^[a-z][a-z0-9_.-]{1,40}$/.test(kind)) throw new RegistryError(`run kind ${kind}: bad name`);
  if (typeof step !== "function") throw new RegistryError(`run kind ${kind}: step() is required`);
  needLane(lane);
  if (runKinds.has(kind) && runKinds.get(kind).step !== step) throw new RegistryError(`run kind ${kind} is defined twice`);
  runKinds.set(kind, { kind, lane, step, maintenance: maintenance === true, label: label || kind });
}
export const runKind = (kind) => runKinds.get(kind) || null;
export const allRunKinds = () => [...runKinds.values()];

const runCtx = (ctx) => ({ by: (ctx && ctx.by) || "system", origin: (ctx && ctx.origin) || "worker", actor_kind: (ctx && ctx.actor_kind) || "automation", requestId: (ctx && ctx.requestId) || "run" });

// Creates a run and kicks its lane. opts.id: a deterministic id (a nightly
// run named by its date); an existing run with that id is returned as is.
export async function createRun(kind, input = {}, ctx = {}, { id, kick = true } = {}) {
  const k = runKind(kind);
  if (!k) throw new InputError("That kind of job doesn't exist.", "kind");
  const runId = id || newId("run");
  let rec;
  try {
    rec = await createRecord("run", {
      id: runId, kind, lane: k.lane, status: "queued", input: input || {}, progress: { done: 0, total: null },
      checkpoint: null, result: null, attempts: 0, requested_by: (ctx && ctx.by) || "system",
    }, runCtx(ctx));
  } catch (e) {
    if (e && e.name === "ExistsError") {
      const got = await getRecord("run", runId);
      if (got) return got.data;
    }
    throw e;
  }
  if (kick) await kickWorker(k.lane, `run:${kind}`);
  return rec.data;
}

export async function getRun(id) {
  if (!isId(id, "run")) throw new NotFoundError("That job isn't there.");
  const got = await getRecord("run", id);
  if (!got) throw new NotFoundError("That job isn't there.");
  return got.data;
}

// What GET /runs/:id answers.
export const runView = (r) => ({
  id: r.id, kind: r.kind, status: r.status, progress: r.progress || { done: 0, total: null }, result: r.result ?? null,
  error: r.error || null, created_at: r.created_at, started_at: r.started_at || null, finished_at: r.finished_at || null,
});

// The runs a lane may advance now, oldest first (from ix/runs/recent).
export async function runnableRuns(lane, { paused = false } = {}, opts = {}) {
  const ix = await readIndex("runs", "recent", opts);
  const t = nowMs();
  return ix.rows
    .filter((r) => r.ln === lane && (r.st === "queued" || r.st === "running") && !(r.ra && Date.parse(r.ra) > t))
    .filter((r) => { const k = runKind(r.k); return !!k && (!paused || k.maintenance); })
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1));
}

const retryAfterMs = (attempts) => Math.min(60, attempts * attempts) * 60 * 1000;

// Advances one run by one step under the chunk budget. → { progressed, status }.
export async function stepRun(run, { budget, deploy, mode, holder } = {}) {
  const k = runKind(run.kind);
  const wctx = { by: "system", origin: "worker", actor_kind: "automation", requestId: holder || "worker" };
  if (!k) {
    await updateRecord("run", run.id, (r) => (r.status === "failed" ? null : { ...r, status: "failed", error: { code: "unknown_kind" }, finished_at: nowIso() }), wctx);
    return { progressed: true, status: "failed" };
  }
  if (run.status === "queued") {
    const r = await updateRecord("run", run.id, (x) => (x.status !== "queued" ? null : { ...x, status: "running", started_at: x.started_at || nowIso() }), wctx);
    run = r.data;
  }
  if (run.status !== "running") return { progressed: false, status: run.status };
  let out;
  try {
    out = (await k.step(run, { budget, deploy, mode, holder, write: (extra = {}) => ({ ...wctx, ...extra }) })) || {};
  } catch (e) {
    const code = keySafe((e && (e.code || e.name)) || "error", 40);
    console.error(`crm:lanes: run ${run.kind} step failed (${safeErr(e)})`);
    const r = await updateRecord("run", run.id, (x) => {
      const attempts = (x.attempts || 0) + 1;
      if (attempts >= RUN_MAX_ATTEMPTS) return { ...x, attempts, status: "failed", error: { code }, finished_at: nowIso(), retry_at: null };
      return { ...x, attempts, error: { code }, retry_at: new Date(nowMs() + retryAfterMs(attempts)).toISOString() };
    }, wctx);
    return { progressed: false, status: r.data.status, error: code };
  }
  const r = await updateRecord("run", run.id, (x) => ({
    ...x,
    ...(out.checkpoint !== undefined ? { checkpoint: out.checkpoint } : {}),
    ...(out.progress ? { progress: { done: out.progress.done ?? 0, total: out.progress.total ?? null } } : {}),
    ...(out.done ? { status: "done", result: out.result ?? null, finished_at: nowIso(), retry_at: null, error: null } : {}),
    ...(out.failed ? { status: "failed", error: { code: keySafe(String(out.failed), 40) }, finished_at: nowIso() } : {}),
  }), wctx);
  const moved = r.changed || !!out.done;
  return { progressed: moved, status: r.data.status };
}

// Cancels a run that has not finished (the step sees it at its next chunk).
export async function cancelRun(id, ctx = {}) {
  const r = await updateRecord("run", id, (x) => (["done", "failed", "cancelled"].includes(x.status) ? null : { ...x, status: "cancelled", finished_at: nowIso() }), runCtx(ctx));
  return r.data;
}
