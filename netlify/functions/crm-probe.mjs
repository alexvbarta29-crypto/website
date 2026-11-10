// GET/POST /api/crm-probe — the M1.1 platform probe, request kind (design
// §3.10, §3.13; netlify/lib/crm/core/probe.mjs). Deleted after the M1 gate.
//
// GET  (office sign-in) records what a request function sees about its
//      deploy (context signal, CRM_PRODUCTION present, Node version) and
//      answers the whole probe report: facts per function kind (request,
//      scheduled, background), write latency, and which Production-only
//      settings are still missing. Booleans, names and timings only.
// POST (office sign-in + header X-CRM: 1) times 20 sequential conditional
//      writes into the scratch store crm-probe and answers p50/p95.
//
// Safe in production before any setup: it only touches crm-probe.

import { signedIn } from "../lib/lights-auth.mjs";
import { safeErr } from "../lib/referral-lib.mjs";
import { deployContext, canonicalRedirect, setupStatus } from "../lib/crm/core/context.mjs";
import { recordFacts, measureWrites, readReport } from "../lib/crm/core/probe.mjs";

export const config = { path: "/api/crm-probe" };

const HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "same-origin" };
const json = (body, status = 200, extra = {}) => Response.json(body, { status, headers: { ...HEADERS, ...extra } });
const error = (code, message, status, extra) => json({ ok: false, error: { code, message } }, status, extra);

export default async (req, context) => {
  try {
    const deploy = deployContext(req, context);
    const moved = canonicalRedirect(req, deploy);
    if (moved) return moved;
    if (!signedIn(req)) return error("signed_out", "Sign in to Barta Office first.", 401);
    if (req.method === "GET" || req.method === "HEAD") {
      try {
        await recordFacts("request", req, context);
      } catch (e) {
        console.error("crm-probe: couldn't record the request facts (" + safeErr(e) + ")");
      }
      const report = await readReport(deploy);
      return json({ ok: true, data: { setup: setupStatus(deploy), ...report } });
    }
    if (req.method === "POST") {
      if (req.headers.get("x-crm") !== "1") return error("csrf", "Missing the X-CRM header.", 403);
      const latency = await measureWrites("request", deploy);
      console.log(`crm-probe: ${latency.n} writes, p95 ${latency.p95} ms, ${latency.errors} errors`);
      return json({ ok: true, data: { latency } });
    }
    return error("method_not_allowed", "Method not allowed.", 405, { Allow: "GET, HEAD, POST" });
  } catch (e) {
    console.error("crm-probe: failed (" + safeErr(e) + ")");
    return error("failed", "The probe failed. Try again in a minute.", 500);
  }
};
