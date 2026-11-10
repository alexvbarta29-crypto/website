// Barta CRM core: sweeps, the timed work every module registers (design
// §7.2 step 2, §7.6), and the core sweep catalog.
//
// A sweep is { key, lane, every: "pass" | "hourly" | "daily" | "weekly" |
// "monthly", at_local?: "HH:MM", dow?: 0-6, day?: 1-28, mutates,
// maintenance?, run(ctx) }. run returns undefined (finished) or
// { done?: boolean = true, progress?: n, cursor?, result? }.
//
// - "pass" sweeps run on every pass of their lane, without a marker.
// - Periodic sweeps claim done/sweep/{key}--{instance} when they START
//   (instance = the local date; date + "t" + hour; the week's day; the
//   month). The claim means only "started": a sweep that stops half way
//   ({ done: false, cursor }) hands its claim back with its cursor
//   (failed + retry_at now) and is taken over on the next pass with that
//   cursor, until it records done. Sweeps are state-based, so a missed
//   hour or a moved visit never causes a wrong or double send.
// - Daily and hourly sweeps run in their own window only; a weekly or
//   monthly sweep that missed its day runs on the next pass, late, and the
//   owners get an alert.
// - While sys/mode.paused only maintenance sweeps run (§3.10).
// - Every sweep gets the automation context (activity.mjs automationCtx):
//   a mutating sweep asks ctx.mayAct(subject) and writes ctx.would(...)
//   rows instead of acting on records Rotor still owns (§0 rule 12).
//
// Core catalog (the system module registers CORE_SWEEPS):
//   system.seed     fast  every pass until done   each module's seeds once (op/seed--{module}--v{n})
//   auth.sessions   fast  daily 03:15  maintenance expired ses/, thr/ older than a day, expired idem/,
//                                                 old sweep claims, stale leases, finished runs > 60 days
//   index.verify    bulk  daily 03:45  maintenance the run that rebuilds and diffs every index and relation family
//   backup.nightly  bulk  daily 03:00  maintenance the snapshot run (core/backup.mjs)
//   files.backup    bulk  daily 04:15  maintenance copies new file bytes into crm-backups
//   files.purge     bulk  daily 04:30              deletes bytes of files deleted > 30 days that have a copy
//   backup.offsite  bulk  weekly Sun 04:00 maintenance alerts when no off-site copy is newer than 8 days

import { createHash } from "node:crypto";
import {
  claimMarker, advanceMarker, listKeys, getRaw, deleteRaw, readIndex, hardDelete, removeRel, verifyIndex, verifyRels, rebuildIndex,
} from "../../crm-store.mjs";
import { now, nowMs, nowIso, localDate, localTime, localParts, addLocalDays, dowOfDate, fromTsKey, tsKey } from "./clock.mjs";
import { deriveId } from "./ids.mjs";
import { keySafe } from "./text.mjs";
import { allSweeps, allModules, allIndexes, allTypes } from "./registry.mjs";
import { ParallelRunGuard } from "./errors.mjs";
import { automationCtx, wouldAct } from "./activity.mjs";
import { runOp, readOp } from "./ops.mjs";
import { createRun, defineRun, updateHealth, withAlert, withoutAlert, readHealth } from "./lanes.mjs";
import { IDEM_TTL_MS } from "../../crm-store.mjs";
import "./backup.mjs";     // defines the backup.snapshot run
import "./files.mjs";      // defines the files.backup and files.purge runs
import { safeErr } from "../../referral-lib.mjs";

export const SWEEP_SCOPE = "sweep";
const MARKER_SLACK_MS = 60 * 1000;
const RETRY_AFTER_ERROR_MS = 5 * 60 * 1000;

const pad = (n) => String(n).padStart(2, "0");

// Which instance of a periodic sweep is due at `t`, if any (pure).
// → { due: boolean, instance: string | null, late: boolean }
export function sweepWindow(sweep, t = now()) {
  const date = localDate(t);
  const time = localTime(t);
  const at = sweep.at_local || "00:00";
  switch (sweep.every) {
    case "pass": return { due: true, instance: null, late: false };
    case "hourly": return { due: true, instance: `${date}t${pad(localParts(t).hh)}`, late: false };
    case "daily": return { due: time >= at, instance: date, late: false };
    case "weekly": {
      const dow = Number.isInteger(sweep.dow) ? sweep.dow : 0;
      let d = date;
      while (dowOfDate(d) !== dow) d = addLocalDays(d, -1);
      if (d === date && time < at) d = addLocalDays(d, -7);
      return { due: true, instance: d, late: d !== date };
    }
    case "monthly": {
      const day = Number.isInteger(sweep.day) ? sweep.day : 1;
      const p = localParts(t);
      const thisOne = `${p.y}-${pad(p.m)}-${pad(day)}`;
      const reached = date > thisOne || (date === thisOne && time >= at);
      const ym = reached ? `${p.y}-${pad(p.m)}` : (p.m === 1 ? `${p.y - 1}-12` : `${p.y}-${pad(p.m - 1)}`);
      return { due: true, instance: ym, late: !reached || date !== thisOne };
    }
    default: return { due: false, instance: null, late: false };
  }
}

// Claims known final in this warm instance: one read fewer per pass.
const finalCache = new Set();
export function clearSweepCache() { finalCache.clear(); }
const isFinal = (m) => !!m && (m.state === "done" || m.state === "unknown" || (m.state === "failed" && !m.retry_at));

function sweepCtx(sweep, { mode, holder, budget, deploy, lane, marker, instance }) {
  const a = automationCtx({ mode, key: sweep.key, requestId: holder });
  return { ...a, sweep: sweep.key, lane, budget, deploy, holder, now: () => now(), instance, marker: marker || null, cursor: marker && marker.cursor !== undefined ? marker.cursor : null };
}

async function callSweep(sweep, sctx) {
  try {
    const r = await sweep.run(sctx);
    return r && typeof r === "object" ? r : {};
  } catch (e) {
    if (e instanceof ParallelRunGuard) {
      await wouldAct({ key: sweep.key, subject: e.subject || null, action: e.action || "change", changes: e.fields ? { fields: e.fields } : undefined }).catch(() => {});
      return { done: true, result: `would-${keySafe(e.action || "change", 20)}` };
    }
    throw e;
  }
}

// Runs the lane's due sweeps. → { progress, ran: [keys], more }
export async function runSweeps(lane, { mode, holder, budget, deploy, minLeftMs = 5000 } = {}) {
  let progress = 0;
  const ran = [];
  let more = false;
  const t = now();
  for (const sweep of allSweeps().filter((s) => s.lane === lane)) {
    if (mode && mode.paused && !sweep.maintenance) continue;
    const w = sweepWindow(sweep, t);
    if (!w.due) continue;
    if (budget && budget.left() < minLeftMs) { more = true; break; }
    if (sweep.every === "pass") {
      try {
        const r = await callSweep(sweep, sweepCtx(sweep, { mode, holder, budget, deploy, lane }));
        if (r.progress > 0) { progress += r.progress; ran.push(sweep.key); }
        if (r.done === false) more = true;
      } catch (e) {
        console.error(`crm:sweeps: ${sweep.key} failed (${safeErr(e)})`);
      }
      continue;
    }
    const mkey = `${keySafe(sweep.key, 60)}--${w.instance}`;
    if (finalCache.has(mkey)) continue;
    let claim;
    try {
      claim = await claimMarker("done", SWEEP_SCOPE, mkey, { holder, leaseMs: (budget ? budget.left() : 120000) + MARKER_SLACK_MS });
    } catch (e) {
      console.error(`crm:sweeps: ${sweep.key} could not be claimed (${safeErr(e)})`);
      continue;
    }
    if (!claim.ok) {
      if (isFinal(claim.marker)) { finalCache.add(mkey); if (finalCache.size > 2000) finalCache.clear(); }
      continue;
    }
    let marker = claim.marker;
    try {
      const r = await callSweep(sweep, sweepCtx(sweep, { mode, holder, budget, deploy, lane, marker, instance: w.instance }));
      if (r.done === false) {
        await advanceMarker(marker, { state: "failed", code: "incomplete", retry_at: nowIso(), cursor: r.cursor === undefined ? null : r.cursor });
        progress += r.progress > 0 ? r.progress : 0;
        more = true;
      } else {
        await advanceMarker(marker, { state: "done", result: String(r.result === undefined ? "done" : typeof r.result === "string" ? r.result : JSON.stringify(r.result)).slice(0, 200) });
        finalCache.add(mkey);
        progress += 1 + (r.progress > 0 ? r.progress : 0);
        if (w.late && sweep.every === "monthly") await updateHealth((h) => withAlert(h, `late:${sweep.key}`, `${sweep.label || sweep.key} ran late (it missed its day).`, "info"));
      }
      ran.push(sweep.key);
    } catch (e) {
      console.error(`crm:sweeps: ${sweep.key} failed (${safeErr(e)})`);
      await advanceMarker(marker, { state: "failed", code: keySafe((e && (e.code || e.name)) || "error", 40), retry_at: new Date(nowMs() + RETRY_AFTER_ERROR_MS).toISOString(), cursor: marker.cursor === undefined ? null : marker.cursor }).catch(() => {});
    }
  }
  return { progress, ran, more };
}

// A nightly run's id: one run per kind and local date, whoever creates it.
export const nightlyRunId = (kind, date) => deriveId("run", `nightly:${kind}`, "core", date);

// ------------------------------------------------------------ system.seed

let seedsDone = null;   // the seed-set key known done in this warm instance
const seedList = () => allModules().flatMap((m) => (m.seeds || []).map((s) => ({ module: m.name, v: s.v, run: s.run })));

async function seedSweep(ctx) {
  const seeds = seedList();
  if (!seeds.length) return { progress: 0 };
  const setKey = createHash("sha256").update(seeds.map((s) => `${s.module}--v${s.v}`).sort().join(",")).digest("hex").slice(0, 20);
  if (seedsDone === setKey) return { progress: 0 };
  const m = await getRaw(`done/seed/${setKey}`);
  if (m && m.data && m.data.state === "done") { seedsDone = setKey; return { progress: 0 }; }
  let progress = 0;
  for (const s of seeds) {
    const opId = `seed--${keySafe(s.module, 30)}--v${s.v}`;
    const j = await readOp(opId);
    if (j && j.status === "done") continue;
    const out = await runOp(opId, [{ name: "seed", run: async (st) => (await s.run({ ...ctx, op: opId, write: (extra = {}) => ctx.write({ op: opId, ...extra }), deriveId: st.deriveId })) ?? null }], { holder: ctx.holder, ctx: ctx.write({ op: opId }) });
    if (out.status !== "done") return { done: false, progress };
    progress += 1;
  }
  const claim = await claimMarker("done", "seed", setKey, { holder: ctx.holder, leaseMs: 60000 });
  if (claim.ok) await advanceMarker(claim.marker, { state: "done", result: `${seeds.length} seeds` });
  seedsDone = setKey;
  return { progress };
}
export function clearSeedCache() { seedsDone = null; }

// ------------------------------------------------------------ auth.sessions (nightly maintenance)

export const THROTTLE_KEEP_MS = 24 * 3600 * 1000;
export const SWEEP_CLAIM_KEEP_DAYS = 90;
export const LOCK_STALE_MS = 24 * 3600 * 1000;
export const RUN_KEEP_DAYS = 60;
const LANE_LOCKS = new Set(["lock/worker-fast", "lock/worker-bulk"]);

const PHASES = [
  // ses/: a session past its idle or absolute end can never be used again
  ["ses", "ses/", async (k, t) => {
    const got = await getRaw(k);
    const s = got && got.data;
    const dead = !s || !(Date.parse(s.idle_expires_at) > t) || !(Date.parse(s.absolute_expires_at) > t);
    if (!dead) return 0;
    await deleteRaw(k);
    const created = s && Date.parse(s.created_at);
    if (s && s.user_id && Number.isFinite(created)) await removeRel("user-sessions", s.user_id, tsKey(new Date(created)), k.slice(4)).catch(() => {});
    return 1;
  }],
  // thr/: every failure is its own key named by its time; a day later it can't count
  ["thr", "thr/", async (k, t) => {
    const m = /(\d{8}t\d{9}z)(?:-[a-z0-9]+)?$/.exec(k);
    const d = m ? fromTsKey(m[1]) : null;
    if (d && d.getTime() + THROTTLE_KEEP_MS > t) return 0;
    await deleteRaw(k);
    return 1;
  }],
  // idem/: Idempotency-Key records last 7 days
  ["idem", "idem/", async (k, t) => {
    const got = await getRaw(k);
    const d = got && got.data;
    if (d && Date.parse(d.at) + IDEM_TTL_MS > t) return 0;
    await deleteRaw(k);
    return 1;
  }],
  // done/sweep/: a sweep's claim for a day more than 90 days ago is never read again
  ["sweeps", "done/sweep/", async (k, t) => {
    const m = /--(\d{4}-\d{2}(?:-\d{2})?)(?:t\d{2})?$/.exec(k);
    if (!m) return 0;
    const day = m[1].length === 7 ? `${m[1]}-28` : m[1];
    if (Date.parse(day + "T00:00:00Z") + SWEEP_CLAIM_KEEP_DAYS * 86400000 > t) return 0;
    await deleteRaw(k);
    return 1;
  }],
  // lock/: leases other than the lanes', expired more than a day ago
  ["locks", "lock/", async (k, t) => {
    if (LANE_LOCKS.has(k)) return 0;
    const got = await getRaw(k);
    const d = got && got.data;
    if (d && !(Date.parse(d.until) + LOCK_STALE_MS < t)) return 0;
    await deleteRaw(k);
    return 1;
  }],
];

async function authSweep(ctx) {
  const t = nowMs();
  const c = ctx.cursor && typeof ctx.cursor === "object" ? { ...ctx.cursor } : { phase: 0, after: null, deleted: {} };
  c.deleted = c.deleted || {};
  while (c.phase < PHASES.length) {
    const [name, prefix, fn] = PHASES[c.phase];
    const keys = (await listKeys(prefix)).filter((k) => c.after === null || k > c.after);
    for (const k of keys) {
      if (ctx.budget && ctx.budget.left() < 3000) return { done: false, cursor: c, progress: 0 };
      try { c.deleted[name] = (c.deleted[name] || 0) + (await fn(k, t)); } catch (e) { console.error(`crm:sweeps: auth.sessions ${name} (${safeErr(e)})`); }
      c.after = k;
    }
    c.phase += 1;
    c.after = null;
  }
  // finished background runs older than RUN_KEEP_DAYS leave the store
  const ix = await readIndex("runs", "recent");
  const old = ix.rows.filter((r) => ["done", "failed", "cancelled"].includes(r.st) && r.fin && Date.parse(r.fin) + RUN_KEEP_DAYS * 86400000 < t);
  for (const r of old.slice(0, 50)) {
    if (ctx.budget && ctx.budget.left() < 3000) return { done: false, cursor: c, progress: 0 };
    await hardDelete("run", r.id, ctx.write()).catch(() => {});
    c.deleted.runs = (c.deleted.runs || 0) + 1;
  }
  return { done: true, result: c.deleted };
}

// ------------------------------------------------------------ index.verify (bulk run)

// Rebuilds every index and every relation family a type declares, diffs
// them with the live ones and repairs the differences (§3.5); counts go to
// sys/health.index_verify, and Today shows a banner after two nights in a
// row that needed a repair.
async function verifyStep(run, { budget }) {
  const tasks = [...allIndexes().sort().map((n) => `ix:${n}`), ...allTypes().filter((t) => t.rels.length).map((t) => `rel:${t.type}`).sort()];
  const cp = run.checkpoint && Number.isInteger(run.checkpoint.i) ? { ...run.checkpoint } : { i: 0, missing: 0, extra: 0, stale: 0, repaired: [] };
  while (cp.i < tasks.length) {
    if (budget && budget.left() < 20000) return { checkpoint: cp, progress: { done: cp.i, total: tasks.length } };
    const task = tasks[cp.i];
    try {
      if (task.startsWith("ix:")) {
        const r = await verifyIndex(task.slice(3));
        cp.missing += r.missing; cp.extra += r.extra; cp.stale += r.stale;
        if (r.repaired.length) cp.repaired = [...cp.repaired, task.slice(3)];
      } else {
        const r = await verifyRels(task.slice(4));
        cp.missing += r.missing; cp.extra += r.extra;
        if (r.missing || r.extra) cp.repaired = [...cp.repaired, task];
      }
    } catch (e) {
      console.error(`crm:sweeps: index.verify ${task} failed (${safeErr(e)})`);
    }
    cp.i += 1;
  }
  const needed = cp.missing + cp.extra + cp.stale > 0;
  await updateHealth((h) => {
    const prev = h.index_verify || {};
    const inARow = needed ? (prev.repairs_in_a_row || 0) + 1 : 0;
    const out = { ...h, index_verify: { at: nowIso(), missing: cp.missing, extra: cp.extra, stale: cp.stale, repaired: cp.repaired, repairs_in_a_row: inARow } };
    return inARow >= 2 ? withAlert(out, "index_verify", "The nightly check had to repair lists two nights in a row.") : withoutAlert(out, "index_verify");
  });
  return { done: true, checkpoint: cp, progress: { done: tasks.length, total: tasks.length }, result: { missing: cp.missing, extra: cp.extra, stale: cp.stale, repaired: cp.repaired } };
}
defineRun("index.verify", { lane: "bulk", step: verifyStep, maintenance: true, label: "Nightly list check" });

// POST /admin/reindex: rebuilds the named indexes (all when none).
async function reindexStep(run, { budget }) {
  const names = Array.isArray(run.input && run.input.names) && run.input.names.length ? run.input.names.filter((n) => allIndexes().includes(n)) : allIndexes().sort();
  const cp = run.checkpoint && Number.isInteger(run.checkpoint.i) ? { ...run.checkpoint } : { i: 0, rows: 0 };
  while (cp.i < names.length) {
    if (budget && budget.left() < 20000) return { checkpoint: cp, progress: { done: cp.i, total: names.length } };
    const r = await rebuildIndex(names[cp.i]);
    cp.rows += r.rows;
    cp.i += 1;
  }
  return { done: true, checkpoint: cp, progress: { done: names.length, total: names.length }, result: { indexes: names.length, rows: cp.rows } };
}
defineRun("reindex", { lane: "bulk", step: reindexStep, maintenance: true, label: "Rebuild lists" });

// ------------------------------------------------------------ the catalog

const nightly = (kind) => async (ctx) => {
  const date = localDate(now());
  await createRun(kind, { date }, ctx.write(), { id: nightlyRunId(kind, date) });
  return { result: kind };
};

export const OFFSITE_MAX_DAYS = 8;
async function offsiteCheck() {
  const h = await readHealth();
  const last = h.offsite_at ? Date.parse(h.offsite_at) : NaN;
  const stale = !(last + OFFSITE_MAX_DAYS * 86400000 > nowMs());
  await updateHealth((x) => (stale
    ? withAlert(x, "offsite", "No off-site copy of the backups in the last 8 days. Run build/crm_backup_pull.mjs.")
    : withoutAlert(x, "offsite")));
  return { result: stale ? "stale" : "ok" };
}

export const CORE_SWEEPS = Object.freeze([
  { key: "system.seed", label: "First-run data", lane: "fast", every: "pass", mutates: true, run: seedSweep },
  { key: "auth.sessions", label: "Sign-in clean-up", lane: "fast", every: "daily", at_local: "03:15", mutates: false, maintenance: true, run: authSweep },
  { key: "backup.nightly", label: "Nightly backup", lane: "bulk", every: "daily", at_local: "03:00", mutates: false, maintenance: true, run: nightly("backup.snapshot") },
  { key: "index.verify", label: "Nightly list check", lane: "bulk", every: "daily", at_local: "03:45", mutates: false, maintenance: true, run: nightly("index.verify") },
  { key: "files.backup", label: "File backup", lane: "bulk", every: "daily", at_local: "04:15", mutates: false, maintenance: true, run: nightly("files.backup") },
  { key: "files.purge", label: "Deleted files clean-up", lane: "bulk", every: "daily", at_local: "04:30", mutates: false, run: nightly("files.purge") },
  { key: "backup.offsite", label: "Off-site backup check", lane: "bulk", every: "weekly", dow: 0, at_local: "04:00", mutates: false, maintenance: true, run: offsiteCheck },
]);
