// /api/crm/auth/* — Barta CRM sign-in, sign-out, password change,
// first-owner setup and invites (design §4.4, §4.8, §4.11). A function of
// its own so Netlify's platform rate limit (30 requests a minute per IP and
// domain) refuses a flood before any Blobs write; the per-login and per-IP
// throttle (core/throttle.mjs) comes after it. Same pipeline as every other
// CRM route (core/router.mjs).
import { handleRequest, API_BASE } from "../lib/crm/core/router.mjs";
import { AUTH_ROUTES } from "../lib/crm/core/auth.mjs";
import "../lib/crm/modules/index.mjs";

export const config = {
  path: "/api/crm/auth/*",
  rateLimit: { windowSize: 60, windowLimit: 30, aggregateBy: ["ip", "domain"], action: "rate_limit" },
};

export default (req, context) => handleRequest(req, context, { base: API_BASE, routes: AUTH_ROUTES });
