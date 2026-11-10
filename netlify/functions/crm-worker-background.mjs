// The CRM's fast worker lane (design §7.1), PROBE-ONLY in M1.1: it checks
// the x-crm-worker header against the probe's stored secret, records what a
// background function sees about its deploy, and at most once an hour times
// 20 conditional writes, all into the scratch store crm-probe. It touches
// no CRM data and contacts nobody. M1.3 replaces the body with the lane
// (lease, passes, queue, sweeps).
//
// A "-background" file: Netlify answers the caller 202 at once and gives the
// function up to 15 minutes; its return value is discarded. Default URL
// /.netlify/functions/crm-worker-background (no config.path).

import { safeErr } from "../lib/referral-lib.mjs";
import { deployContext } from "../lib/crm/core/context.mjs";
import { recordFacts, maybeMeasure, readWorkerSecret, sameSecret } from "../lib/crm/core/probe.mjs";

export default async (req, context) => {
  try {
    const deploy = deployContext(req, context);
    const secret = await readWorkerSecret(deploy);
    if (!sameSecret(req.headers.get("x-crm-worker") || "", secret)) {
      console.log("crm-worker: ignored a call without the worker header");
      return new Response(null, { status: 401 });
    }
    await recordFacts("background", req, context);
    const m = await maybeMeasure("background", deploy);
    if (m) console.log(`crm-worker: ${m.n} writes, p95 ${m.p95} ms, ${m.errors} errors`);
  } catch (e) {
    console.error("crm-worker: probe run failed (" + safeErr(e) + ")");
  }
  return new Response(null, { status: 202 });
};
