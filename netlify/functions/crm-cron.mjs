// The CRM's 15-minute cron (design §7.1). Scheduled functions run only on
// the published production deploy, in UTC, with a 30 s limit, so this does
// almost nothing itself:
//
//   - records what a scheduled function sees about its deploy into the
//     probe's scratch store crm-probe (the M1.1 probe, until the M1 gate);
//   - BEFORE the owner's setup (production without CRM_PRODUCTION /
//     CRM_KEY_SALT): exactly the M1.1 probe and nothing else: the probe's
//     own worker secret, one kick of the fast lane so it records the
//     background facts. No CRM store is opened.
//   - AFTER setup: makes sure sys/worker-secret exists (onlyIfNew),
//     writes sys/health.cron_at and wakes both lanes (crm-worker-background
//     and crm-bulk-background) with header x-crm-worker and a 5 s timeout.
//
// Every failure is logged once (safeErr) and the function still answers:
// the next run is 15 minutes away, nothing retries in a loop.
// If the platform ever refuses a sub-hourly schedule, use "@hourly" in both
// places below and rely on the kicks.

import { safeErr } from "../lib/referral-lib.mjs";
import { deployContext } from "../lib/crm/core/context.mjs";
import { storeBlocked } from "../lib/crm/core/auth.mjs";
import { withStoreScope } from "../lib/crm-store.mjs";
import { recordFacts, ensureWorkerSecret as ensureProbeSecret } from "../lib/crm/core/probe.mjs";
import { workerOrigin, lanePath, WORKER_HEADER } from "../lib/crm/core/lanes.mjs";
import { cronTick } from "../lib/crm/core/worker.mjs";

// Netlify reads `config` without running the file, so the schedule is a
// literal here (keep CRON equal to it; a test checks).
export const CRON = "*/15 * * * *";
export const config = { schedule: "*/15 * * * *" };

export const WORKER_PATH = lanePath("fast");
export const KICK_TIMEOUT_MS = 5000;
export { workerOrigin };

async function post(origin, lane, secret) {
  const res = await fetch(origin + lanePath(lane), {
    method: "POST",
    headers: { [WORKER_HEADER]: secret, "content-type": "application/json" },
    body: JSON.stringify({ reason: "cron" }),
    signal: AbortSignal.timeout(KICK_TIMEOUT_MS),
  });
  try { await res.body?.cancel(); } catch { /* nothing to free */ }
  if (res.status !== 202) console.error(`crm-cron: the ${lane} lane kick answered ${res.status}`);
  return res.status === 202;
}

export default async (req, context) => {
  try {
    const deploy = deployContext(req, context);
    const origin = workerOrigin(deploy, req);
    try { await recordFacts("scheduled", req, context); } catch (e) { console.error("crm-cron: probe facts not recorded (" + safeErr(e) + ")"); }
    if (storeBlocked(deploy)) {
      const secret = await ensureProbeSecret(deploy);
      if (!secret) console.error("crm-cron: no worker secret yet; the background probe waits for the next run");
      else await post(origin, "fast", secret);
      return new Response(null, { status: 204 });
    }
    await withStoreScope({ deploy, requestId: "cron" }, () => cronTick({ kick: (lane, secret) => post(origin, lane, secret) }));
  } catch (e) {
    console.error("crm-cron: run failed (" + safeErr(e) + ")");
  }
  return new Response(null, { status: 204 });
};
