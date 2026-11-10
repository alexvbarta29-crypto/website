// The CRM's fast worker lane (design §7.1, §7.2): queue items, sends,
// reminders, every-pass and short sweeps, ops resume, pend/ and fix/
// settling, health. The body is core/worker.mjs runLane("fast"): its own
// lease, passes of at most 2 minutes renewing the lease after each, a
// no-progress pass ends the invocation (unless the next queue item is due
// soon: it sleeps until then), no new pass after 13 minutes, at most 3
// self-kicks in a row.
//
// BEFORE the owner's setup (production without CRM_PRODUCTION /
// CRM_KEY_SALT) it is exactly the M1.1 probe: it checks the probe's secret,
// records what a background function sees about its deploy into crm-probe
// and at most hourly times 20 conditional writes there. No CRM store is
// opened. After setup it still records the probe facts (until the M1 gate)
// and checks the header against sys/worker-secret.
//
// A "-background" file: Netlify answers the caller 202 at once and gives
// the function up to 15 minutes; its return value is discarded. Default URL
// /.netlify/functions/crm-worker-background (no config.path).

import { safeErr } from "../lib/referral-lib.mjs";
import { deployContext } from "../lib/crm/core/context.mjs";
import { storeBlocked } from "../lib/crm/core/auth.mjs";
import { withStoreScope } from "../lib/crm-store.mjs";
import { recordFacts, maybeMeasure, readWorkerSecret as readProbeSecret, sameSecret as sameProbeSecret } from "../lib/crm/core/probe.mjs";
import { readWorkerSecret, sameSecret, workerOrigin, WORKER_HEADER } from "../lib/crm/core/lanes.mjs";
import { runLane } from "../lib/crm/core/worker.mjs";
import "../lib/crm/modules/index.mjs";

export async function laneReason(req) {
  try { const b = await req.json(); return typeof b.reason === "string" ? b.reason.slice(0, 60) : "kick"; } catch { return "kick"; }
}

export default async (req, context) => {
  try {
    const deploy = deployContext(req, context);
    if (storeBlocked(deploy)) {
      const secret = await readProbeSecret(deploy);
      if (!sameProbeSecret(req.headers.get(WORKER_HEADER) || "", secret)) {
        console.log("crm-worker: ignored a call without the worker header");
        return new Response(null, { status: 401 });
      }
      await recordFacts("background", req, context);
      const m = await maybeMeasure("background", deploy);
      if (m) console.log(`crm-worker: ${m.n} writes, p95 ${m.p95} ms, ${m.errors} errors`);
      return new Response(null, { status: 202 });
    }
    const secret = await withStoreScope({ deploy, requestId: "worker" }, () => readWorkerSecret({}, { fresh: true }));
    if (!sameSecret(req.headers.get(WORKER_HEADER) || "", secret)) {
      console.log("crm-worker: ignored a call without the worker header");
      return new Response(null, { status: 401 });
    }
    try {
      await recordFacts("background", req, context);
      await maybeMeasure("background", deploy);
    } catch (e) {
      console.error("crm-worker: probe facts not recorded (" + safeErr(e) + ")");
    }
    const r = await runLane("fast", { deploy, reason: await laneReason(req), origin: workerOrigin(deploy, req) });
    console.log(`crm-worker: ${r.passes || 0} passes, ${r.progress || 0} steps, ended ${r.ended}`);
  } catch (e) {
    console.error("crm-worker: lane failed (" + safeErr(e) + ")");
  }
  return new Response(null, { status: 202 });
};
