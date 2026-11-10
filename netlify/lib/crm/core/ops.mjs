// Barta CRM core: multi-record operations (design §3.6).
//
// Quote approval (plan + jobs + deposit invoice), merging two contacts, a
// plan cancel, a rain-day move, cutover: each runs as an op with a journal
// at op/{opId}:
//
//   { status: "running" | "done" | "failed", kind, input, step, steps,
//     holder, lease_until, numbers: { [childId]: n }, out: { [step]: result },
//     result, started_at, attempts, error?, _w }
//
// - Versioned op ids (opIdFor): natural key + version, so a double tap is
//   the same op and a later legitimate repeat is a new one
//   (approve--{quoteId}--{n}).
// - The holder renews lease_until (now + 2 min) by CAS after each step.
//   Only the worker's ops.resume step resumes an op, and only after its
//   lease ran out, so one op never runs twice at once; a second caller
//   (the double tap) gets { status: "running" } and never runs a step.
// - Children get ids from s.deriveId(type, scope, n) = deriveId(type, opId,
//   scope, n) and are written with onlyIfNew, so a resumed op creates
//   nothing twice.
// - Numbers (job, invoice, quote): s.number(childId, seq) journals
//   numbers[childId] by CAS right after nextNumber; a resumed op reuses the
//   journaled number.
// - A step that fails on storage (busy, maybe saved, out of time) leaves the
//   op running for ops.resume; any other error fails it (after 5 attempts
//   the owners are alerted).
//
// Resumable ops are defined by kind (defineOp(kind, { lane, steps(input) }))
// so the worker can rebuild their steps from the journal; runOp(opId,
// steps[], { input }) also works for an op that is never resumed by the
// worker (its journal then only dedupes and records the result).

import { getRaw, settledWrite, nextNumber, listRel, addRel, removeRel, createRecord, getRecord } from "../../crm-store.mjs";
import { nowIso, nowMs, tsKey } from "./clock.mjs";
import { deriveId } from "./ids.mjs";
import { keySafe } from "./text.mjs";
import { RegistryError, StaleError, BlobsTransientError, UnknownOutcome, TimeoutError, BudgetError, InputError, ExistsError } from "./errors.mjs";
import { updateHealth, withAlert } from "./lanes.mjs";
import { safeErr } from "../../referral-lib.mjs";

export const OP_LEASE_MS = 2 * 60 * 1000;
export const OP_MAX_ATTEMPTS = 5;
export const opKey = (opId) => `op/${opId}`;
const OP_ID_RE = /^[a-z0-9][a-z0-9._@-]{2,180}$/;

// approve--{quoteId}--{n}: the natural key and its version.
export function opIdFor(natural, n) {
  const id = `${keySafe(natural, 160)}--${Number.isSafeInteger(n) && n > 0 ? n : 1}`;
  return id;
}

const kinds = new Map();
export function defineOp(kind, { lane = "fast", steps } = {}) {
  if (typeof kind !== "string" || !/^[a-z][a-z0-9_.-]{1,40}$/.test(kind)) throw new RegistryError(`op kind ${kind}: bad name`);
  if (typeof steps !== "function") throw new RegistryError(`op kind ${kind}: steps(input) is required`);
  if (kinds.has(kind) && kinds.get(kind).steps !== steps) throw new RegistryError(`op kind ${kind} is defined twice`);
  kinds.set(kind, { kind, lane, steps });
}
export const opKind = (kind) => kinds.get(kind) || null;

const TRANSIENT = [BlobsTransientError, UnknownOutcome, TimeoutError, BudgetError];
const transient = (e) => TRANSIENT.some((C) => e instanceof C) || (e && e.transient === true);
const leaseLive = (j) => Date.parse(j.lease_until) > nowMs();
const strip = (v) => { const { _w, ...rest } = v || {}; return rest; };

// The journal of an op, or null.
export async function readOp(opId, opts = {}) {
  const got = await getRaw(opKey(opId), opts);
  return got && got.data ? { ...strip(got.data), etag: got.etag } : null;
}

function stepsOf(spec, input) {
  if (Array.isArray(spec)) return spec;
  const k = opKind(spec);
  if (!k) throw new RegistryError(`op kind ${spec} is not defined`);
  return k.steps(input || {});
}

// Runs (or joins) an op. spec: a kind defined with defineOp, or a list of
// steps [{ name, run(s) }]. opts: { input, holder, resume (worker only),
// ctx (the write context; its op field is set) }.
// → { status: "done" | "running" | "failed", result?, error?, opId }
export async function runOp(opId, spec, opts = {}) {
  if (typeof opId !== "string" || !OP_ID_RE.test(opId)) throw new InputError("That operation id isn't valid.", "op");
  const key = opKey(opId);
  const holder = String(opts.holder || (opts.ctx && opts.ctx.requestId) || "op").slice(0, 80);
  const kind = typeof spec === "string" ? spec : opts.kind || null;
  let cur = await getRaw(key, opts.store || {});
  let journal;
  let etag;
  if (!cur) {
    const steps = stepsOf(spec, opts.input);
    const fresh = {
      status: "running", kind, input: opts.input || {}, step: 0, steps: steps.length, holder, lease_until: new Date(nowMs() + OP_LEASE_MS).toISOString(),
      numbers: {}, out: {}, started_at: nowIso(), attempts: 1,
    };
    const w = await settledWrite(key, fresh, { onlyIfNew: true }, opts.store || {});
    if (w.ok) {
      journal = fresh; etag = w.etag;
      await addRel("op-running", "all", tsKey(new Date(Date.parse(fresh.started_at))), opId, {}, opts.store || {}).catch(() => {});
    } else cur = w.current;
  }
  if (!journal) {
    const j = strip(cur.data);
    if (j.status === "done") return { status: "done", result: j.result ?? null, opId };
    if (j.status === "failed") return { status: "failed", error: j.error || null, opId };
    if (j.holder !== holder && leaseLive(j)) return { status: "running", opId };
    if (!opts.resume && j.holder !== holder) return { status: "running", opId };   // only ops.resume takes over an expired op
    const take = { ...j, holder, lease_until: new Date(nowMs() + OP_LEASE_MS).toISOString(), attempts: (j.attempts || 0) + (j.holder === holder ? 0 : 1) };
    const w = await settledWrite(key, take, { onlyIfMatch: cur.etag }, opts.store || {});
    if (!w.ok) return { status: "running", opId };
    journal = take; etag = w.etag;
  }
  return execute(opId, spec, journal, etag, holder, opts);
}

async function execute(opId, spec, journal, etag, holder, opts) {
  const key = opKey(opId);
  const store = opts.store || {};
  const steps = stepsOf(spec, journal.input);
  // CAS on our own journal; a lost CAS means another holder took it over.
  const save = async (patch) => {
    const next = { ...journal, ...patch, lease_until: new Date(nowMs() + OP_LEASE_MS).toISOString() };
    const w = await settledWrite(key, next, { onlyIfMatch: etag }, store);
    if (!w.ok) throw new StaleError(null, null, "Another worker took this operation over.");
    journal = next; etag = w.etag;
    return journal;
  };
  const s = {
    opId, input: journal.input || {}, out: journal.out || {}, ctx: { ...(opts.ctx || {}), op: opId },
    deriveId: (type, scope, n) => deriveId(type, opId, scope, n),
    // A child record made once: its id derives from the op, so a resumed op
    // finds the record it already made instead of making another.
    async createOnce(type, scope, n, data, ctx = {}) {
      const id = deriveId(type, opId, scope, n);
      try {
        return await createRecord(type, { ...data, id }, { ...s.ctx, ...ctx });
      } catch (e) {
        if (e instanceof ExistsError) { const got = await getRecord(type, id, store); if (got) return got; }
        throw e;
      }
    },
    async number(childId, seqName, numberOpts = {}) {
      if (journal.numbers && Number.isSafeInteger(journal.numbers[childId])) return journal.numbers[childId];
      const n = await nextNumber(seqName, { ...store, start: numberOpts.start, id: childId });
      await save({ numbers: { ...(journal.numbers || {}), [childId]: n } });
      return n;
    },
  };
  try {
    for (let i = journal.step || 0; i < steps.length; i++) {
      const step = steps[i];
      const r = await step.run(s);
      const out = r === undefined ? journal.out : { ...(journal.out || {}), [step.name || `step${i + 1}`]: r };
      s.out = out;
      await save({ step: i + 1, out });
    }
    const result = journal.out && steps.length ? journal.out[steps[steps.length - 1].name || `step${steps.length}`] ?? null : null;
    await save({ status: "done", result, finished_at: nowIso() });
    await removeRel("op-running", "all", tsKey(new Date(Date.parse(journal.started_at))), opId, store).catch(() => {});
    return { status: "done", result, opId };
  } catch (e) {
    if (e instanceof StaleError && /took this operation over/.test(e.message)) return { status: "running", opId };
    const code = keySafe((e && (e.code || e.name)) || "error", 40);
    if (transient(e) && (journal.attempts || 1) < OP_MAX_ATTEMPTS) {
      // leave it running: ops.resume picks it up once the lease ran out
      await settledWrite(key, { ...journal, last_error: code }, { onlyIfMatch: etag }, store).catch(() => {});
      throw e;
    }
    console.error(`crm:ops: an operation failed (${safeErr(e)})`);
    await settledWrite(key, { ...journal, status: "failed", error: { code, message: transient(e) ? "Storage kept failing." : String((e && e.message) || "failed").slice(0, 200) }, finished_at: nowIso() }, { onlyIfMatch: etag }, store).catch(() => {});
    await removeRel("op-running", "all", tsKey(new Date(Date.parse(journal.started_at))), opId, store).catch(() => {});
    if (transient(e)) await updateHealth((h) => withAlert(h, `op:${keySafe(opId, 60)}`, "An operation kept failing on storage and was stopped."), store);
    throw e;
  }
}

// The worker's ops.resume step: every running op whose lease ran out is
// taken over and finished (kind-defined ops only; an op without a kind is
// marked failed, nothing can rebuild its steps). → { resumed, failed }
export async function resumeOps({ holder = "ops.resume", budget, minLeftMs = 5000 } = {}, opts = {}) {
  const rows = await listRel("op-running", "all", { limit: 100, newestFirst: false }, opts);
  let resumed = 0;
  let failed = 0;
  for (const r of rows) {
    if (budget && budget.left() < minLeftMs) break;
    const j = await readOp(r.id, opts);
    if (!j || j.status !== "running") {
      await removeRel("op-running", "all", r.sortKey, r.id, opts).catch(() => {});
      continue;
    }
    if (leaseLive(j)) continue;
    if (!j.kind || !opKind(j.kind)) {
      await settledWrite(opKey(r.id), { ...j, etag: undefined, status: "failed", error: { code: "not_resumable" }, finished_at: nowIso() }, { onlyIfMatch: j.etag }, opts).catch(() => {});
      await removeRel("op-running", "all", r.sortKey, r.id, opts).catch(() => {});
      failed += 1;
      continue;
    }
    try {
      const out = await runOp(r.id, j.kind, { holder, resume: true, input: j.input, ctx: { by: "system", origin: "worker", actor_kind: "automation", requestId: holder }, store: opts });
      if (out.status === "done") resumed += 1;
      if (out.status === "failed") failed += 1;
    } catch (e) {
      console.error(`crm:ops: resuming an operation failed (${safeErr(e)})`);
    }
  }
  return { resumed, failed };
}
