// Core "system" module: the first slice's Customers list, kept working
// until M2a's Contacts replace it (design §3.15). Moved here unchanged from
// netlify/functions/crm-import.mjs (deleted in M1.2):
//
//   GET  /api/crm/import            → { ok: true, imported_at, exported_at, counts } or { ok: true, imported_at: null }
//   POST /api/crm/import[?confirm=1] the sealed box { v: 2, epk, iv, tag, data } as JSON, up to 6 MB
//   GET  /api/crm/legacy/customers  → { ok: true, data: { imported_at, exported_at, count, members, customers } }
//
// The import keeps its own answers ({ ok: false, error: <code>, message })
// because the legacy Import screen reads them. An owner uploads the sealed
// export file build/crm_seal_import.mjs wrote on Claude's machine; the
// function opens it with OFFICE_DATA_KEY, checks and trims every row
// (normalizeBundle in lib/crm-data.mjs) and replaces idx/customers with one
// write. A file that would cut the list by more than 1% or is older than
// the loaded one gets 409 "confirm" until it is sent again with ?confirm=1.
//
// Who: the office cookie, or a CRM session with contacts:read_all (list) or
// import:run (import); techs get 403 (the list holds every phone, email and
// note, gate codes included). Stores: through the deploy (crm in
// production, crm--<ctx> elsewhere, which replaces the first slice's
// preview guard); while the production deploy still waits for its CRM
// settings, the office cookie reads "crm" exactly as the first slice did.
// Logs carry counts and statuses only.

import { open, privateKey } from "../../../office-data.mjs";
import { normalizeBundle } from "../../../crm-data.mjs";
import { buildCustomerIndex, indexSummary, readCustomerIndex, writeCustomerIndex, TIMEOUT_MS } from "../../../crm-store.mjs";
import { customersHtml, exportedLabel, IMPORT_MESSAGES } from "../../../crm-page.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { now, nowMs } from "../../core/clock.mjs";

export const MAX_BODY = 6 * 1024 * 1024;
// The decrypted export may be at most this big (the real one is under 0.5 MB) ...
export const MAX_PLAINTEXT = 3 * 1024 * 1024;
// ... and the list page it makes must stay under Netlify's 6 MB response cap.
export const MAX_PAGE_BYTES = 5 * 1024 * 1024;
// All the storage work of one import (one read, one write) fits in this.
export const IMPORT_BUDGET_MS = 9000;
// Asked before replacing a list with one under this share of its size.
export const SHRINK_RATIO = 0.99;

export const MESSAGES = Object.freeze({
  ...IMPORT_MESSAGES,
  "bad-env-key": "OFFICE_DATA_KEY in Netlify isn't a usable key (it should be the 44-character key)",
  "unsupported-type": "Send the file as application/json",
  failed: "The import failed. Try again.",
});

const HEADERS = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "same-origin" };
const json = (body, status = 200, extra = {}) => Response.json(body, { status, headers: { ...HEADERS, ...extra } });
const fail = (code, status, more = {}) => json({ ok: false, error: code, message: MESSAGES[code], ...more }, status);

// The sealed box exactly as build/crm_seal_import.mjs writes it.
export const isSealedBox = (b) => !!b && typeof b === "object" && b.v === 2 && ["epk", "iv", "tag", "data"].every((k) => typeof b[k] === "string" && b[k]);

// Whether replacing `current` with `incoming` (both { count, exported_at })
// needs a yes first: a much shorter list or an older export.
export function needsConfirm(current, incoming) {
  if (!current) return false;
  const shrinks = current.count > 0 && incoming.count < current.count * SHRINK_RATIO;
  const older = !!current.exported_at && incoming.exported_at < current.exported_at;
  return shrinks || older;
}

// The deploy the legacy list is read through: the request's, except while
// the production deploy waits for its CRM settings (then the first slice's
// own way into "crm").
export const legacyDeploy = (ctx) => (ctx.setupNeeded ? undefined : ctx.deploy);

const listLabel = (n, exported) => `${n.toLocaleString("en-US")} customer${n === 1 ? "" : "s"}${exported ? ` (export of ${exportedLabel(exported)})` : ""}`;

async function importStatus(ctx) {
  let idx;
  try {
    idx = await readCustomerIndex({ deploy: legacyDeploy(ctx) });
  } catch (e) {
    if (!(e instanceof SyntaxError)) {
      console.error("crm-import: couldn't read the customer index (" + safeErr(e) + ")");
      return fail("store", 503);
    }
  }
  const sum = indexSummary(idx);
  return sum && sum.imported_at ? json({ ok: true, ...sum }) : json({ ok: true, imported_at: null });
}

async function importUpload(ctx) {
  const type = String(ctx.req.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return fail("unsupported-type", 415);
  const text = Buffer.from(ctx.raw || []).toString("utf8");
  let box;
  try { box = JSON.parse(text); } catch { return fail("bad-json", 400); }
  if (!isSealedBox(box)) return fail("bad-bundle", 400);

  const key = privateKey(process.env);
  if (!key) return fail("no-key", 503);
  if (key === "bad") return fail("bad-env-key", 503);
  // AES-GCM ciphertext is as long as the text it hides: refuse an
  // oversized export before decrypting it.
  if (Buffer.byteLength(box.data, "base64") > MAX_PLAINTEXT) return fail("too-big", 413);
  let opened;
  try { opened = open(box, key); } catch { return fail("bad-key", 400); }

  try {
    const checked = normalizeBundle(opened, { now: now() });
    if (!checked.ok) {
      console.error(`crm-import: refused the export (${checked.error}${checked.field ? " at " + checked.field : ""})`);
      return fail(checked.error, checked.error === "too-many" ? 413 : 400, checked.field ? { field: checked.field } : {});
    }
    const index = buildCustomerIndex(checked.bundle, { now: () => now() });
    // The list this import makes has to be one /crm/legacy can serve.
    if (Buffer.byteLength(customersHtml(index)) > MAX_PAGE_BYTES) return fail("too-big", 413);

    // All storage work shares one deadline, so the import ends well inside
    // a function's run time even when each call is slow.
    const deadline = nowMs() + IMPORT_BUDGET_MS;
    const left = () => Math.min(TIMEOUT_MS, deadline - nowMs());
    const deploy = legacyDeploy(ctx);
    let current = null;
    try {
      current = indexSummary(await readCustomerIndex({ timeoutMs: left(), deploy }));
    } catch (e) {
      if (!(e instanceof SyntaxError)) {
        console.error("crm-import: couldn't read the current list (" + safeErr(e) + ")");
        return fail("store", 503);
      }
    }
    const incoming = { count: index.count, exported_at: index.exported_at };
    const was = current && { count: current.counts.customers, exported_at: current.exported_at };
    if (ctx.query.get("confirm") !== "1" && needsConfirm(was, incoming)) {
      return json({
        ok: false,
        error: "confirm",
        message: `This file has ${listLabel(incoming.count, incoming.exported_at)}. The list has ${listLabel(was.count, was.exported_at)}. Replace it anyway?`,
        current: was,
        incoming,
      }, 409);
    }
    if (left() < 500) return fail("store", 503);
    let sum;
    try {
      sum = await writeCustomerIndex(index, { timeoutMs: left(), deploy });
    } catch (e) {
      console.error("crm-import: couldn't write the customer index (" + safeErr(e) + ")");
      return fail("store", 503);
    }
    console.log(`crm-import: imported ${sum.counts.customers} customers and ${sum.counts.members} members (export of ${sum.exported_at})`);
    return json({ ok: true, counts: sum.counts, imported_at: sum.imported_at, exported_at: sum.exported_at });
  } catch (e) {
    console.error("crm-import: import failed (" + safeErr(e) + ")");
    return fail("failed", 500);
  }
}

// GET /legacy/customers: the same rows the legacy page shows, as JSON.
async function legacyCustomers(ctx) {
  let idx;
  try {
    idx = await readCustomerIndex({ deploy: legacyDeploy(ctx) });
  } catch (e) {
    if (e instanceof SyntaxError) return { data: null, meta: { reason: "bad-index" } };
    throw e;
  }
  if (!idx || typeof idx !== "object" || !Array.isArray(idx.customers)) return { data: null, meta: { reason: "no-data" } };
  return { data: { imported_at: idx.imported_at || null, exported_at: idx.exported_at || null, count: idx.customers.length, members: Array.isArray(idx.members) ? idx.members : [], customers: idx.customers.filter((c) => c && typeof c === "object" && !Array.isArray(c)) } };
}

export const legacyRoutes = [
  { method: "GET", path: "/legacy/customers", auth: "session_or_office", perm: "contacts:read_all", subject: "none", mode: "inline", handler: legacyCustomers },
  { method: "GET", path: "/import", auth: "session_or_office", perm: "import:run", subject: "none", mode: "inline", handler: importStatus },
  { method: "POST", path: "/import", auth: "session_or_office", perm: "import:run", subject: "none", mode: "inline", body: "raw", maxBody: MAX_BODY, idempotent: false, budgetMs: 12000, handler: importUpload },
];
