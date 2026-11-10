// The CRM's bulk worker lane (design §7.1): runs (reindex, index.verify,
// backups, CSV exports, imports, bulk sends), long sweeps, file copies.
// The body is core/worker.mjs runLane("bulk"), with its own lease
// (lock/worker-bulk), so a backup or an import never delays a reminder on
// the fast lane. Chunks of at most 2 minutes, each advancing runs by one
// checkpointed step; the lease is renewed after every chunk; at most 3
// self-kicks in a row.
//
// BEFORE the owner's setup it does nothing at all (the cron only wakes the
// fast lane then, for the M1.1 probe). Header x-crm-worker must equal
// sys/worker-secret. A "-background" file: 202 at once, 15 minutes.

import { safeErr } from "../lib/referral-lib.mjs";
import { deployContext } from "../lib/crm/core/context.mjs";
import { storeBlocked } from "../lib/crm/core/auth.mjs";
import { withStoreScope } from "../lib/crm-store.mjs";
import { readWorkerSecret, sameSecret, workerOrigin, laneReason, WORKER_HEADER } from "../lib/crm/core/lanes.mjs";
import { runLane } from "../lib/crm/core/worker.mjs";
import "../lib/crm/modules/index.mjs";

export default async (req, context) => {
  try {
    const deploy = deployContext(req, context);
    if (storeBlocked(deploy)) return new Response(null, { status: 202 });
    const secret = await withStoreScope({ deploy, requestId: "bulk" }, () => readWorkerSecret({}, { fresh: true }));
    if (!sameSecret(req.headers.get(WORKER_HEADER) || "", secret)) {
      console.log("crm-bulk: ignored a call without the worker header");
      return new Response(null, { status: 401 });
    }
    const r = await runLane("bulk", { deploy, reason: await laneReason(req), origin: workerOrigin(deploy, req) });
    console.log(`crm-bulk: ${r.passes || 0} chunks, ${r.progress || 0} steps, ended ${r.ended}`);
  } catch (e) {
    console.error("crm-bulk: lane failed (" + safeErr(e) + ")");
  }
  return new Response(null, { status: 202 });
};
