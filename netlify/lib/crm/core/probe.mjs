// Barta CRM core: the M1.1 platform probe (design §3.10, §3.13, §11.4 M1.1
// gate). Deleted after the M1 gate.
//
// It answers two questions the design cannot settle from documentation:
//   1. Does each function kind (request, scheduled, background) receive the
//      deploy-context signal (context.deploy.context / process.env.CONTEXT),
//      and is the Production-only CRM_PRODUCTION there? deployContext()
//      relies on both; a kind without the context signal falls back to
//      CRM_PRODUCTION alone, and this records which.
//   2. How long does one conditional Blobs write take in production? 20
//      sequential CAS writes; p95 > 150 ms lowers the request maxCalls
//      default to floor(6000 / p95) (§2.2 "Request budget").
//
// Everything goes to the scratch store crm-probe (open in every context,
// even before the owner's Netlify setup), under facts/{kind}--{ctx},
// latency/{kind}--{ctx} and secret/worker. No customer data, no env values:
// booleans, context names, the Node version and timings only.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { deployContext } from "./context.mjs";
import { nowIso, nowMs } from "./clock.mjs";
import { getRaw, putRaw, settledWrite, listKeys, withBudget } from "../../crm-store.mjs";

export const PROBE_KINDS = Object.freeze(["request", "scheduled", "background"]);
export const LATENCY_WRITES = 20;
export const P95_TARGET_MS = 150;
export const DEFAULT_MAX_CALLS = 25;
export const LATENCY_EVERY_MS = 60 * 60 * 1000;   // the background lane measures at most hourly

const P = { kind: "probe" };
const scopeFor = (deploy, budget) => ({ ...P, deploy, budget: budget || withBudget(8000, 200, { strict: false }) });

// What a function kind can see about its deploy (no values of secrets).
export function runtimeFacts(kind, req, context, env = process.env) {
  if (!PROBE_KINDS.includes(kind)) throw new TypeError(`probe: unknown kind ${kind}`);
  const deploy = deployContext(req, context, env);
  const cctx = context && context.deploy && context.deploy.context;
  return {
    kind,
    at: nowIso(),
    context_signal: typeof cctx === "string" && cctx !== "",
    context_value: typeof cctx === "string" && cctx ? cctx : null,
    env_context: typeof env.CONTEXT === "string" && env.CONTEXT ? env.CONTEXT : null,
    crm_production: env.CRM_PRODUCTION === "1",
    key_salt_set: typeof env.CRM_KEY_SALT === "string" && env.CRM_KEY_SALT !== "",
    deploy: { prod: deploy.prod, ctx: deploy.ctx, signal: deploy.signal, setup_needed: deploy.setup_needed, canonical: deploy.canonical },
    node: process.version,
    has_wait_until: !!context && typeof context.waitUntil === "function",
    has_deploy_id: !!(context && context.deploy && context.deploy.id),
  };
}

// Stores the facts of this invocation (the latest per kind and context, with a run count).
export async function recordFacts(kind, req, context, env = process.env) {
  const facts = runtimeFacts(kind, req, context, env);
  const deploy = deployContext(req, context, env);
  const sc = scopeFor(deploy);
  const key = `facts/${kind}--${facts.deploy.ctx}`;
  const cur = await getRaw(key, sc);
  const runs = ((cur && cur.data && cur.data.runs) || 0) + 1;
  await settledWrite(key, { ...facts, runs, first_at: (cur && cur.data && cur.data.first_at) || facts.at }, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true }, sc);
  return facts;
}

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : null);
// §2.2: past 150 ms the default "drops to floor(6000 / p95)"; clamped so a
// slower store never raises it above the default (6000 / 200 would be 30).
export const suggestedMaxCalls = (p95) => (p95 > P95_TARGET_MS ? Math.max(1, Math.min(DEFAULT_MAX_CALLS, Math.floor(6000 / p95))) : DEFAULT_MAX_CALLS);

// 20 sequential conditional writes on one scratch key; stores and returns
// { at, n, ok, errors, p50, p95, max, suggested_max_calls }.
export async function measureWrites(kind, deploy, { n = LATENCY_WRITES, budget } = {}) {
  const sc = scopeFor(deploy, budget || withBudget(20000, 500, { strict: false }));
  const key = `latency/scratch--${kind}`;
  const times = [];
  let errors = 0;
  let cur = await getRaw(key, sc);
  let etag = cur ? cur.etag : null;
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    try {
      const w = await settledWrite(key, { i, at: nowIso() }, etag ? { onlyIfMatch: etag } : { onlyIfNew: true }, sc);
      if (w.ok) etag = w.etag; else { errors += 1; cur = await getRaw(key, sc); etag = cur ? cur.etag : null; }
    } catch {
      errors += 1;
    }
    times.push(performance.now() - t0);
  }
  const sorted = times.map((t) => Math.round(t * 10) / 10).sort((a, b) => a - b);
  const result = {
    kind, at: nowIso(), n, ok: n - errors, errors,
    p50: pct(sorted, 50), p95: pct(sorted, 95), max: sorted[sorted.length - 1] ?? null,
  };
  result.suggested_max_calls = suggestedMaxCalls(result.p95 ?? 0);
  const rkey = `latency/${kind}--${deploy.ctx}`;
  const prev = await getRaw(rkey, sc);
  await settledWrite(rkey, result, prev ? { onlyIfMatch: prev.etag } : { onlyIfNew: true }, sc);
  return result;
}

// Runs measureWrites unless this kind measured within the last hour.
export async function maybeMeasure(kind, deploy) {
  const prev = await getRaw(`latency/${kind}--${deploy.ctx}`, scopeFor(deploy));
  if (prev && prev.data && Date.parse(prev.data.at) + LATENCY_EVERY_MS > nowMs()) return null;
  return measureWrites(kind, deploy);
}

// Everything the probe knows: { facts: { "request--production": {...} }, latency: {...} }.
export async function readReport(deploy) {
  const sc = scopeFor(deploy);
  const out = { facts: {}, latency: {} };
  for (const [prefix, into] of [["facts/", out.facts], ["latency/", out.latency]]) {
    for (const key of await listKeys(prefix, { kind: "probe" }, sc)) {
      const name = key.slice(prefix.length);
      if (name.startsWith("scratch--")) continue;
      const got = await getRaw(key, sc);
      if (got && got.data) into[name] = got.data;
    }
  }
  return out;
}

// The shared secret the cron sends to the background function. Kept in the
// probe store (not an env var); M1.3 moves the lanes to sys/worker-secret.
export async function ensureWorkerSecret(deploy) {
  const sc = scopeFor(deploy);
  const cur = await getRaw("secret/worker", sc);
  if (cur && cur.data && cur.data.secret) return cur.data.secret;
  await putRaw("secret/worker", { secret: randomBytes(32).toString("hex"), at: nowIso() }, { onlyIfNew: true }, sc);
  const got = await getRaw("secret/worker", sc);
  return got && got.data ? got.data.secret : null;
}

export async function readWorkerSecret(deploy) {
  const got = await getRaw("secret/worker", scopeFor(deploy));
  return got && got.data && got.data.secret ? got.data.secret : null;
}

const digest = (s) => createHash("sha256").update(String(s)).digest();
// Constant-time comparison of the header with the stored secret.
export const sameSecret = (given, secret) => !!given && !!secret && timingSafeEqual(digest(given), digest(secret));
