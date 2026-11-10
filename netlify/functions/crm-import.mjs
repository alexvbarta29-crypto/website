// GET/POST /api/crm/import — Barta Office → Customers: load the customer
// list into the site (docs/CRM.md). An owner uploads the sealed export file
// that build/crm_seal_import.mjs wrote on Claude's machine; this function
// opens it with OFFICE_DATA_KEY, checks and trims every row
// (normalizeBundle in lib/crm-data.mjs) and replaces the customer index in
// the "crm" Blobs store with one write. The file is encrypted to the site's
// key, so it can travel through a phone's Files app without being readable
// by anyone else, and the plain rows exist only inside this function and
// the store. The seal proves nothing about who made the file (the public
// key is in the repo): the office sign-in is what guards this endpoint.
//
// GET  → { ok: true, imported_at, exported_at, counts } or { ok: true, imported_at: null }
// POST → the sealed box { v: 2, epk, iv, tag, data } as JSON, up to 6 MB
//        (Netlify's own request limit); replies { ok: true, counts, imported_at, exported_at }.
//        A file that would cut the list by more than 1% (a single pass of
//        Rotor's list_customers has come back a few percent short) or is
//        older than the loaded one gets 409 "confirm" with { current,
//        incoming } until it is sent again with ?confirm=1.
// Errors are { ok: false, error: <code>, message: <plain English>, field? }:
//   401 signed_out · 403 preview · 405 · 409 confirm · 413 too-large /
//   too-many / too-big · 415 unsupported-type · 400 bad-json / bad-bundle /
//   bad-key / empty · 503 no-key / bad-env-key / store · 500 failed.
// Logs carry counts and statuses only, never a name or a phone number.

import { signedIn } from "../lib/lights-auth.mjs";
import { open, privateKey } from "../lib/office-data.mjs";
import { normalizeBundle } from "../lib/crm-data.mjs";
import { buildCustomerIndex, indexSummary, readCustomerIndex, writeCustomerIndex, TIMEOUT_MS } from "../lib/crm-store.mjs";
import { customersHtml, exportedLabel, IMPORT_MESSAGES } from "../lib/crm-page.mjs";
import { safeErr } from "../lib/referral-lib.mjs";

export const config = { path: "/api/crm/import" };

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

class TooLarge extends Error {}

// Reads the body as text, giving up as soon as it passes the cap instead of
// buffering a huge upload first.
export async function readBodyText(req, max = MAX_BODY) {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) throw new TooLarge();
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => {}); throw new TooLarge(); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// The sealed box exactly as build/crm_seal_import.mjs writes it.
export const isSealedBox = (b) => !!b && typeof b === "object" && b.v === 2 && ["epk", "iv", "tag", "data"].every((k) => typeof b[k] === "string" && b[k]);

// Deploy previews and branch deploys share the site's Blobs stores with
// production, so an import there would replace the live list. Netlify sets
// CONTEXT at build time; at run time it is read from the environment or the
// function's context, whichever is there. Local runs have neither.
export function previewContext(env = process.env, context = null) {
  const ctx = String(env.CONTEXT || (context && context.deploy && context.deploy.context) || "");
  return (ctx === "deploy-preview" || ctx === "branch-deploy") && env.CRM_ALLOW_PREVIEW_WRITES !== "1";
}

// Whether replacing `current` with `incoming` (both { count, exported_at })
// needs a yes first: a much shorter list (a Rotor export that stopped half
// way) or an older export.
export function needsConfirm(current, incoming) {
  if (!current) return false;
  const shrinks = current.count > 0 && incoming.count < current.count * SHRINK_RATIO;
  const older = !!current.exported_at && incoming.exported_at < current.exported_at;
  return shrinks || older;
}

const listLabel = (n, exported) => `${n.toLocaleString("en-US")} customer${n === 1 ? "" : "s"}${exported ? ` (export of ${exportedLabel(exported)})` : ""}`;

export default async (req, context) => {
  if (!signedIn(req)) return json({ ok: false, error: "signed_out" }, 401);

  if (req.method === "GET" || req.method === "HEAD") {
    let idx;
    try {
      idx = await readCustomerIndex();
    } catch (e) {
      if (!(e instanceof SyntaxError)) {
        console.error("crm-import: couldn't read the customer index (" + safeErr(e) + ")");
        return fail("store", 503);
      }
    }
    const sum = indexSummary(idx);
    return sum && sum.imported_at ? json({ ok: true, ...sum }) : json({ ok: true, imported_at: null });
  }
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405, { Allow: "GET, HEAD, POST" });
  if (previewContext(process.env, context)) return fail("preview", 403);

  const type = String(req.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return fail("unsupported-type", 415);

  let text;
  try {
    text = await readBodyText(req);
  } catch (e) {
    if (e instanceof TooLarge) return fail("too-large", 413);
    console.error("crm-import: couldn't read the upload (" + safeErr(e) + ")");
    return fail("bad-json", 400);
  }
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
    const checked = normalizeBundle(opened);
    if (!checked.ok) {
      console.error(`crm-import: refused the export (${checked.error}${checked.field ? " at " + checked.field : ""})`);
      return fail(checked.error, checked.error === "too-many" ? 413 : 400, checked.field ? { field: checked.field } : {});
    }
    const index = buildCustomerIndex(checked.bundle);
    // The list this import makes has to be one /crm can serve.
    if (Buffer.byteLength(customersHtml(index)) > MAX_PAGE_BYTES) return fail("too-big", 413);

    // All storage work shares one deadline, so the import ends well inside
    // a function's run time even when each call is slow.
    const deadline = Date.now() + IMPORT_BUDGET_MS;
    const left = () => Math.min(TIMEOUT_MS, deadline - Date.now());
    let current = null;
    try {
      current = indexSummary(await readCustomerIndex({ timeoutMs: left() }));
    } catch (e) {
      // An index that isn't JSON is replaced; storage not answering stops here.
      if (!(e instanceof SyntaxError)) {
        console.error("crm-import: couldn't read the current list (" + safeErr(e) + ")");
        return fail("store", 503);
      }
    }
    const incoming = { count: index.count, exported_at: index.exported_at };
    const was = current && { count: current.counts.customers, exported_at: current.exported_at };
    if (new URL(req.url).searchParams.get("confirm") !== "1" && needsConfirm(was, incoming)) {
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
      sum = await writeCustomerIndex(index, { timeoutMs: left() });
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
};

