// The CRM's 15-minute cron (design §7.1), PROBE-ONLY in M1.1: it records
// what a scheduled function sees about its deploy into the scratch store
// crm-probe and kicks the background function so that one records its own
// facts too. It touches no CRM data and contacts nobody, so it is safe on
// the production deploy before any setup. M1.3 replaces the body with the
// real kick of both worker lanes.
//
// Scheduled functions run only on the published production deploy, have a
// 30 s limit, and use UTC cron. If the platform ever refuses a sub-hourly
// schedule, use "@hourly" in both places below.

import { safeErr } from "../lib/referral-lib.mjs";
import { deployContext, CANONICAL_ORIGIN } from "../lib/crm/core/context.mjs";
import { recordFacts, ensureWorkerSecret } from "../lib/crm/core/probe.mjs";

// Netlify reads `config` without running the file, so the schedule is a
// literal here (keep CRON equal to it; a test checks).
export const CRON = "*/15 * * * *";
export const config = { schedule: "*/15 * * * *" };

export const WORKER_PATH = "/.netlify/functions/crm-worker-background";
export const KICK_TIMEOUT_MS = 5000;

// Where the background function lives: the canonical host in production
// (§3.10 "worker kicks always use the canonical origin"), else this deploy's URL.
export function workerOrigin(deploy, req, env = process.env) {
  if (deploy.ctx === "production") return CANONICAL_ORIGIN;
  if (env.URL) return env.URL.replace(/\/+$/, "");
  try { return new URL(req.url).origin; } catch { return CANONICAL_ORIGIN; }
}

export default async (req, context) => {
  try {
    const deploy = deployContext(req, context);
    await recordFacts("scheduled", req, context);
    const secret = await ensureWorkerSecret(deploy);
    if (!secret) {
      console.error("crm-cron: no worker secret yet; the background probe waits for the next run");
    } else {
      const res = await fetch(workerOrigin(deploy, req) + WORKER_PATH, {
        method: "POST",
        headers: { "x-crm-worker": secret, "content-type": "application/json" },
        body: JSON.stringify({ reason: "cron" }),
        signal: AbortSignal.timeout(KICK_TIMEOUT_MS),
      });
      if (res.status !== 202) console.error(`crm-cron: the background kick answered ${res.status}`);
    }
  } catch (e) {
    console.error("crm-cron: probe run failed (" + safeErr(e) + ")");
  }
  return new Response(null, { status: 204 });
};
