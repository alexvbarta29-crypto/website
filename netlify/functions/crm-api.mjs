// /api/crm/* — every JSON API of the Barta CRM (design §2.1, §2.2): one
// dispatcher, so auth, CSRF, the client-version check, idempotency, the
// request budget, error mapping and logging live in one place
// (netlify/lib/crm/core/router.mjs). Modules register their routes through
// their manifests (netlify/lib/crm/modules/*/index.mjs). The sign-in routes
// (/api/crm/auth/*) are served by crm-auth.mjs, behind the platform rate
// limit. The first slice's /api/crm/import (the legacy Customers import)
// lives here too since M1.2 (modules/system/legacy.mjs).
import { handleApi } from "../lib/crm/core/router.mjs";
import "../lib/crm/modules/index.mjs";

export const config = { path: "/api/crm/*", excludedPath: ["/api/crm/auth/*"] };

export default (req, context) => handleApi(req, context);
