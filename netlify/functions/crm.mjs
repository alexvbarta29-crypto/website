// GET /crm — Barta Office → Customers (docs/CRM.md): every customer the
// office imported from Rotor, read-only for now. Signed in with the one
// office password; the list is read from the "crm" Blobs store on every
// request and never cached. Before the first import, at /crm?import=1 (the
// "Re-import" link) and when the saved list can't be read, the page is the
// Import screen; the upload itself goes to /api/crm/import
// (functions/crm-import.mjs).

import { signedIn, toOffice } from "../lib/lights-auth.mjs";
import { loadCustomers } from "../lib/crm-data.mjs";
import { customersHtml, importHtml, setupHtml } from "../lib/crm-page.mjs";

export const config = { path: ["/crm", "/crm/"] };

const headers = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "SAMEORIGIN",
};
const page = (html, status = 200) => new Response(html, { status, headers });

export default async (req) => {
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  if (!signedIn(req)) return toOffice("customers");
  const got = await loadCustomers();
  // The Import screen never depends on the list being readable, so a list
  // that is broken (or a store that is down) can always be imported over.
  if (new URL(req.url).searchParams.has("import")) {
    const current = got.ok ? { imported_at: got.data.imported_at, count: got.data.count ?? got.data.customers.length } : null;
    return page(importHtml({ current, damaged: got.reason === "bad-index" }));
  }
  if (got.ok) return page(customersHtml(got.data));
  if (got.reason === "no-data" || got.reason === "bad-index") return page(importHtml({ damaged: got.reason === "bad-index" }));
  return page(setupHtml(got.reason), 503);
};
