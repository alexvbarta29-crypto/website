// Barta CRM client version (design §2.3, §11.1 rule 8). Bumped by the
// integrator on every client change merged to the live branch, together
// with crm-sw.js (node build/crm_precache.mjs sets its VERSION and
// PRECACHE); tests/crm/core/precache.test.mjs checks that all three agree.
// The server sends it in the shell and refuses clients older than
// MIN_CLIENT (netlify/lib/crm/core/http.mjs) with 426.
export const APP_VERSION = "2026.11.11-4";
