// Barta CRM core: the worker, one invocation of a lane (design §7.1, §7.2).
//
// runLane(lane) is the body of crm-worker-background (fast) and
// crm-bulk-background (bulk):
//
//   1. take the lane's lease (lock/worker-{lane}, 5 min, CAS with a nonce);
//      a second invocation exits at once;
//   2. run passes (fast) or chunks (bulk) of at most 2 minutes each,
//      renewing the lease by CAS after EVERY pass; a lost lease ends the
//      invocation;
//   3. a pass that made no progress (no queue item finished, no sweep or run
//      step done, nothing repaired) ends the invocation, except on the fast
//      lane when the next queue item is due within the budget minus a
//      minute: then it sleeps until that item is due, re-checking the queue
//      head every 30 s for earlier items (lead.ack goes out 5 minutes after
//      the lead, not up to 20);
//   4. no new pass starts after 13 minutes (the 15-minute limit minus 2);
//      the lease is released (CAS to an expired value), and if work is left
//      the lane kicks itself, at most 3 times in a row
//      (sys/health.lanes.{lane}.self_kicks; a cron or request kick resets it).
//
// A fast pass: the queue (§7.2 step 1) unless paused, the fast sweeps
// (step 2), runs on the fast lane, then maintenance (step 3): ops whose
// lease ran out are resumed, pend/ markers older than 60 s are repaired,
// fix/ markers are settled. A bulk chunk: one step of each runnable run in
// turn while the chunk lasts, then the bulk sweeps. Every pass ends with
// the lane's line in sys/health (step 4).
//
// Tests drive a pass with runPass() (t.runWorker() in the API harness) and
// a whole invocation with runLane(..., { sleep }), where sleep advances the
// pinned clock instead of waiting.

import { randomBytes } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import { withStoreScope, withBudget, acquireLease, renewLease, releaseLease, listKeys, repairPending, settleFix } from "../../crm-store.mjs";
import { nowMs, nowIso } from "./clock.mjs";
import { readSysMode } from "./settings.mjs";
import { drainQueue, scanQueue } from "./queue.mjs";
import { runSweeps } from "./sweeps.mjs";
import { resumeOps } from "./ops.mjs";
import { LANES, runnableRuns, stepRun, getRun, updateHealth, kickWorker, ensureWorkerSecret, laneStatus, readHealth } from "./lanes.mjs";
import { checkBackupAge } from "./backup.mjs";
import { safeErr } from "../../referral-lib.mjs";

export const INVOCATION_MS = 13 * 60 * 1000;      // no new pass after this
export const HARD_MS = 14.5 * 60 * 1000;          // a pass never runs past this
export const PASS_MS = 2 * 60 * 1000;             // one pass (fast) or chunk (bulk)
export const LEASE_MS = 5 * 60 * 1000;
export const RECHECK_MS = 30 * 1000;              // queue head re-check while sleeping until due
export const SLEEP_MARGIN_MS = 60 * 1000;         // only sleep when the item is due before budget − 1 min
export const MAX_SELF_KICKS = 3;
export const HEALTH_EVERY_MS = 60 * 1000;
const PASS_CALLS = 1000000;                        // passes are bounded by time, not by calls

// Real sleep: the time is already in performance.now(). → virtual ms consumed (0).
export const realSleep = async (ms) => { await wait(Math.max(0, ms)); return 0; };

const holderFor = (lane) => `${lane}-${randomBytes(6).toString("hex")}`;

// ------------------------------------------------------------ maintenance (§7.2 step 3)

async function repairPendings({ budget, minLeftMs = 3000 } = {}) {
  let repaired = 0;
  const keys = await listKeys("pend/");
  for (const k of keys) {
    if (budget && budget.left() < minLeftMs) break;
    const m = /^pend\/([a-z_]+)\/([a-z]{2}_[0-9a-z]{20})$/.exec(k);
    if (!m) continue;
    try {
      const r = await repairPending(m[1], m[2]);
      if ((r.state === "repaired" || r.state === "absent") && r.clean) repaired += 1;
    } catch (e) {
      console.error(`crm:worker: a pending write could not be repaired (${safeErr(e)})`);
    }
  }
  return repaired;
}

async function settleFixes({ budget, minLeftMs = 3000 } = {}) {
  let settled = 0;
  for (const k of await listKeys("fix/")) {
    if (budget && budget.left() < minLeftMs) break;
    try {
      await settleFix(k);
      settled += 1;
    } catch (e) {
      console.error(`crm:worker: an unclear write could not be settled (${safeErr(e)})`);
    }
  }
  return settled;
}

export async function maintenance({ budget, holder } = {}) {
  let progress = 0;
  try { const o = await resumeOps({ holder: `${holder}.ops`, budget }); progress += o.resumed + o.failed; } catch (e) { console.error(`crm:worker: ops.resume failed (${safeErr(e)})`); }
  try { progress += await repairPendings({ budget }); } catch (e) { console.error(`crm:worker: index.pending failed (${safeErr(e)})`); }
  try { progress += await settleFixes({ budget }); } catch (e) { console.error(`crm:worker: fix.settle failed (${safeErr(e)})`); }
  return progress;
}

// ------------------------------------------------------------ runs

async function stepRuns(lane, { budget, deploy, mode, holder, minLeftMs = 20000 } = {}) {
  let progress = 0;
  let more = false;
  const rows = await runnableRuns(lane, { paused: !!(mode && mode.paused) });
  for (const row of rows) {
    if (budget && budget.left() < minLeftMs) { more = true; break; }
    try {
      const run = await getRun(row.id);
      const r = await stepRun(run, { budget, deploy, mode, holder });
      if (r.progressed) progress += 1;
      if (r.status === "running") more = true;
    } catch (e) {
      console.error(`crm:worker: a ${lane} run could not step (${safeErr(e)})`);
    }
  }
  return { progress, more };
}

// ------------------------------------------------------------ one pass

// One pass (fast) or chunk (bulk). Call inside a store scope (runLane and
// runOnce do). → { progress, more, next_due_at, stop, queue }
export async function runPass(lane, { deploy, holder = holderFor(lane), budget, mode } = {}) {
  if (!Object.hasOwn(LANES, lane)) throw new TypeError(`worker: unknown lane ${lane}`);
  const m = mode || await readSysMode();
  const out = { progress: 0, more: false, next_due_at: null, stop: false, queue: null };
  if (lane === "fast") {
    if (!m.paused) {
      const q = await drainQueue({ holder, mode: m, budget });
      out.progress += q.finished;
      out.more = out.more || q.more;
      out.next_due_at = q.next_due_at;
      out.stop = !!q.stop;
      out.queue = { depth: q.depth, due: q.due, next_due_at: q.next_due_at };
    }
    if (!out.stop) {
      const s = await runSweeps("fast", { mode: m, holder, budget, deploy });
      out.progress += s.progress;
      out.more = out.more || s.more;
      const r = await stepRuns("fast", { budget, deploy, mode: m, holder });
      out.progress += r.progress;
      out.more = out.more || r.more;
      out.progress += await maintenance({ budget, holder });
    }
  } else {
    const r = await stepRuns("bulk", { budget, deploy, mode: m, holder });
    out.progress += r.progress;
    out.more = out.more || r.more;
    const s = await runSweeps("bulk", { mode: m, holder, budget, deploy });
    out.progress += s.progress;
    out.more = out.more || s.more;
  }
  return out;
}

// A single pass in its own store scope (tests, the D39 fallback).
export function runOnce(lane, { deploy, holder = holderFor(lane), budgetMs = PASS_MS, origin } = {}) {
  const budget = withBudget(budgetMs, PASS_CALLS, { strict: false });
  return withStoreScope({ deploy, requestId: holder, budget, origin }, () => runPass(lane, { deploy, holder, budget }));
}

// ------------------------------------------------------------ one invocation

function laneLine(lane, patch) {
  return (h) => {
    const lanes = { ...(h.lanes || {}) };
    lanes[lane] = { ...(lanes[lane] || {}), ...patch };
    return { ...h, lanes };
  };
}

// The body of a lane function. opts: { deploy, reason, origin, holder,
// sleep (→ virtual ms), perfNow, invocationMs, passMs }. → { ran, passes, progress, ended, self_kicked }
export async function runLane(lane, opts = {}) {
  if (!Object.hasOwn(LANES, lane)) throw new TypeError(`worker: unknown lane ${lane}`);
  const { deploy, reason = "kick", origin } = opts;
  const holder = opts.holder || holderFor(lane);
  const sleep = opts.sleep || realSleep;
  const invocationMs = opts.invocationMs ?? INVOCATION_MS;
  const passMs = opts.passMs ?? PASS_MS;
  const hardMs = Math.max(invocationMs + 1000, opts.hardMs ?? HARD_MS);
  // perfNow: a monotonic clock in ms (tests pass one they move by hand)
  const perf = typeof opts.perfNow === "function" ? opts.perfNow : () => performance.now();
  const start = perf();
  let slept = 0;
  const elapsed = () => perf() - start + slept;
  const lease = LANES[lane].lease;
  return withStoreScope({ deploy, requestId: holder, origin, budget: undefined }, async () => {
    const small = () => ({ budget: withBudget(20000, PASS_CALLS, { strict: false }) });
    if (!(await acquireLease(lease, LEASE_MS, holder, small()))) return { ran: false, ended: "busy", passes: 0, progress: 0 };
    const startedAt = nowIso();
    await updateHealth((h) => laneLine(lane, {
      invocation_started_at: startedAt,
      first_run_at: (h.lanes && h.lanes[lane] && h.lanes[lane].first_run_at) || startedAt,
      ...(reason === "self" ? {} : { self_kicks: 0 }),
    })(h), small());
    let passes = 0;
    let progress = 0;
    let ended = "idle";
    let last = null;
    let lastHealth = 0;
    try {
      for (;;) {
        if (elapsed() >= invocationMs) { ended = "time"; break; }
        const budget = withBudget(Math.max(1000, Math.min(passMs, hardMs - elapsed())), PASS_CALLS, { strict: false });
        const t0 = performance.now();
        let r;
        try {
          r = await withStoreScope({ budget }, () => runPass(lane, { deploy, holder, budget }));
        } catch (e) {
          console.error(`crm:worker: a ${lane} pass failed (${safeErr(e)})`);
          await updateHealth(laneLine(lane, { last_error: { at: nowIso(), code: String((e && (e.code || e.name)) || "error").slice(0, 40) } }), small());
          ended = "error";
          break;
        }
        passes += 1;
        progress += r.progress;
        last = r;
        if (!(await renewLease(lease, LEASE_MS, holder, small()))) { ended = "lease_lost"; break; }
        const tnow = nowMs();
        if (r.progress > 0 || tnow - lastHealth >= HEALTH_EVERY_MS) {
          lastHealth = tnow;
          await updateHealth((h) => {
            const next = laneLine(lane, {
              last_pass_at: nowIso(), last_pass_ms: Math.round(performance.now() - t0), ...(r.progress > 0 ? { last_progress_at: nowIso() } : {}),
            })(h);
            return r.queue ? { ...next, queue: { ...r.queue, at: nowIso() } } : next;
          }, small());
        }
        if (r.stop) { ended = "stopped"; break; }
        if (r.progress > 0) continue;
        // idle: sleep until the next queue item when it is due inside the budget
        if (lane === "fast" && r.next_due_at) {
          let due = Date.parse(r.next_due_at);
          if (due - nowMs() <= invocationMs - elapsed() - SLEEP_MARGIN_MS) {
            while (nowMs() < due && elapsed() < invocationMs) {
              slept += await sleep(Math.min(RECHECK_MS, due - nowMs()));
              if (!(await renewLease(lease, LEASE_MS, holder, small()))) { ended = "lease_lost"; break; }
              const head = await scanQueue(small()).catch(() => null);
              if (head && head.due.length) break;
              if (head && head.next_due_at && Date.parse(head.next_due_at) < due) due = Date.parse(head.next_due_at);
            }
            if (ended === "lease_lost") break;
            continue;
          }
        }
        ended = "idle";
        break;
      }
    } finally {
      await releaseLease(lease, holder, small()).catch(() => {});
    }
    // work left: the lane kicks itself, at most MAX_SELF_KICKS times in a row
    let selfKicked = false;
    const workLeft = (ended === "time" || ended === "stopped") && last && (last.more || last.progress > 0);
    const h = await updateHealth((x) => {
      const cur = (x.lanes && x.lanes[lane]) || {};
      const kicks = cur.self_kicks || 0;
      selfKicked = !!workLeft && kicks < MAX_SELF_KICKS && ended !== "stopped";
      return laneLine(lane, {
        self_kicks: selfKicked ? kicks + 1 : kicks,
        last_invocation: { started_at: startedAt, ended_at: nowIso(), passes, progress, ended, reason: String(reason).slice(0, 40) },
      })(lane === "bulk" ? checkBackupAge(x) : x);
    }, small());
    if (h === null) selfKicked = false;
    if (selfKicked) await kickWorker(lane, "self", { origin, deploy });
    return { ran: true, passes, progress, ended, self_kicked: selfKicked };
  });
}

// ------------------------------------------------------------ the cron tick (crm-cron, POST /hooks/cron)

// What the 15-minute cron does once the CRM is set up (§7.1): make sure the
// worker secret exists, note the time in sys/health, wake both lanes.
// kick(lane, secret) does the POST (the cron uses its own 5 s timeout).
export async function cronTick({ kick } = {}) {
  const secret = await ensureWorkerSecret();
  await updateHealth((h) => ({ ...h, cron_at: nowIso() }));
  if (!secret) return { kicked: [] };
  const lanes = Object.keys(LANES);
  const results = await Promise.all(lanes.map((lane) => Promise.resolve().then(() => (kick ? kick(lane, secret) : kickWorker(lane, "cron", { secret }))).catch(() => false)));
  return { kicked: lanes.filter((_, i) => results[i] !== false) };
}

// The health line the API shows (GET /admin/health) and Today's banner reads.
export async function healthReport() {
  const h = await readHealth();
  const t = nowMs();
  return {
    ...h,
    status: { fast: laneStatus(h, "fast", t), bulk: laneStatus(h, "bulk", t) },
    alerts: Array.isArray(h.alerts) ? h.alerts : [],
  };
}
