// /p/* and /api/portal/* — the Barta CRM client portal (design §8, §2.1):
// customer-facing pages opened from magic links, with their own cookie
// (barta_portal, one link's scope only), their own CSP and headers
// (Referrer-Policy: no-referrer, X-Frame-Options: DENY) and the platform
// rate limit. It never reads a staff cookie. M1.3 ships the frame (the
// entry page and open, the scoped cookie, the view beacon, unsubscribe,
// the Checkout return, present links); the modules add their pages
// (quote, agreement, invoice, card, hub...) through portalRoutes in their
// manifests. Before the owner's setup every page says "isn't available
// right now" and no store is opened.
import { handlePortal } from "../lib/crm/portal/core.mjs";
import "../lib/crm/modules/index.mjs";

export const config = {
  path: ["/p/*", "/api/portal/*"],
  rateLimit: { windowSize: 60, windowLimit: 120, aggregateBy: ["ip", "domain"], action: "rate_limit" },
};

export default (req, context) => handlePortal(req, context);
