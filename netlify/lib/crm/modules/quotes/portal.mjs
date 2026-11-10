// Quotes module: the customer's pages (design §8.1, §8.5) and Present to
// customer (§5.3), registered through portalRoutes; crm-portal.mjs and
// portal/core.mjs (core) check the link's scope before any of these run,
// send the portal headers and CSP, and require X-CRM-Portal: 1 on POSTs.
//
//   GET  /p/quote/:id                          the current version (scope quote)
//   POST /api/portal/quotes/:id/approve        → 202 { run_id } (a version no longer current → 409 "updated")
//   GET  /api/portal/quotes/:id/runs/:run      the approval's progress
//   POST /api/portal/quotes/:id/changes        { message }
//   POST /api/portal/quotes/:id/decline        { reason? }
//   GET  /api/portal/quotes/:id/files/:file    a photo or mockup of the shown version
//   GET  /p/present/:token                     Present to customer: single use, 15 minutes, no cookie
//   POST /api/portal/present/:token/approve    the same approval, method in_person, by the staff member who opened it
//   GET  /api/portal/present/:token/runs/:run  · GET /api/portal/present/:token/files/:file
//   beacon "quote" (core's POST /api/portal/beacon after load): sent → viewed
//
// GET pages never change anything (§8.1). A present link is used up once
// its approval went through (approve.mjs), so it can't approve twice.

import { createHash } from "node:crypto";
import { getRecord, getFileStream } from "../../../crm-store.mjs";
import { isId } from "../../core/ids.mjs";
import { ConflictError, InputError, NotFoundError } from "../../core/errors.mjs";
import { clientIp, uaFamily } from "../../core/http.mjs";
import { ipHash } from "../../core/sessions.mjs";
import { deliveryHeaders } from "../../core/files.mjs";
import { definePortalBeacon, PORTAL_HEADERS, createPresentLink, linkKey } from "../../portal/core.mjs";
import { renderQuotePage } from "./render.mjs";
import { getVersion } from "./versions.mjs";
import { markViewed, requestChanges, declineQuote, getQuote, sendQuote, loadPricing, versionClosed } from "./quotes.mjs";
import { now, localDate } from "../../core/clock.mjs";
import { startApproval, runForPortal } from "./approve.mjs";

const SCRIPT = "quotes-quote.js";

// One quote for this page: it must belong to the link's contact.
async function quoteFor(p, id) {
  if (!isId(id, "quote")) return null;
  const g = await getRecord("quote", id).catch(() => null);
  if (!g || g.data.deleted_at || g.data.contact_id !== p.contact_id) return null;
  return g.data;
}

// The version a page shows: the approved one once approved, else the current one.
async function shownVersion(q) {
  const id = (["approved", "converted"].includes(q.status) && q.approval && q.approval.version_id) || q.current_version_id;
  return id ? getVersion(id) : null;
}

async function page(p, q, mode, token) {
  const [version, contact, pricing] = await Promise.all([shownVersion(q), getRecord("contact", q.contact_id).catch(() => null), loadPricing()]);
  const files = version ? [...(version.photo_ids || []), ...(version.mockup_file_ids || [])] : [];
  // an expired version, an ended offer, an Early Bird past its deadline: said plainly, no Approve
  const done = ["approved", "converted"].includes(q.status);
  const closed = version && !done ? versionClosed(q, version, { today: localDate(now()), pricing }) : null;
  const { title, body } = renderQuotePage({ quote: q, version, contact: contact && contact.data, mode, token, files, floor: pricing.discount_floor_cents || 0, closed });
  const live = version && ["sent", "viewed"].includes(q.status);
  return p.portalPage(p.layout({ title, body, script: SCRIPT, company: p.company, page: mode === "present" ? "present" : "quote", beacon: mode === "portal" && live ? { kind: "quote", id: q.id } : null }));
}

// A conflict the page understands ("updated" reloads it).
const answer = (p, fn) => fn().catch((e) => {
  if (e instanceof ConflictError) return p.fail(e.code || "conflict", e.message, 409);
  if (e instanceof InputError) return p.json({ ok: false, error: { code: "invalid", message: e.message, field: e.field } }, 400);
  if (e instanceof NotFoundError) return p.fail("not_found", "That quote isn't here.", 404);
  throw e;
});

const who = (p, extra) => ({ ip_hash: ipHash(clientIp(p.req, p.context)), ua: uaFamily(p.req.headers.get("user-agent")), ...extra });

async function runAnswer(p, runId, quoteId) {
  if (!isId(runId, "run")) return p.fail("not_found", "Not found.", 404);
  const g = await getRecord("run", runId).catch(() => null);
  if (!g || !["quotes.approve", "quotes.convert"].includes(g.data.kind) || !g.data.input || g.data.input.quote_id !== quoteId) return p.fail("not_found", "Not found.", 404);
  return p.json({ ok: true, data: runForPortal(g.data) });
}

// Only a photo or mockup of the shown version that belongs to THIS quote
// (owner quote/q.id): never another record's file, never a signature.
const SHOWABLE = Object.freeze(["photo", "mockup", "attachment", "import_media"]);
async function fileAnswer(p, q, fileId) {
  const version = await shownVersion(q);
  const allowed = version ? [...(version.photo_ids || []), ...(version.mockup_file_ids || [])] : [];
  if (!isId(fileId, "file") || !allowed.includes(fileId)) return p.fail("not_found", "Not found.", 404);
  const f = await getRecord("file", fileId).catch(() => null);
  if (!f || f.data.deleted_at || f.data.download_only) return p.fail("not_found", "Not found.", 404);
  if (!f.data.owner || f.data.owner.type !== "quote" || f.data.owner.id !== q.id || !SHOWABLE.includes(f.data.kind)) return p.fail("not_found", "Not found.", 404);
  const ifNoneMatch = p.req.headers.get("if-none-match") || undefined;
  const got = await getFileStream(fileId, { ifNoneMatch });
  if (!got) return p.fail("not_found", "Not found.", 404);
  const headers = { ...deliveryHeaders(f.data, { etag: got.etag || ifNoneMatch }), "Referrer-Policy": "no-referrer", "Cache-Control": "private, no-store" };
  if (got.notModified) return new Response(null, { status: 304, headers });
  return new Response(got.stream, { status: 200, headers });
}

// The present link of a request (core already checked it is live and of kind present).
const presentQuoteId = (p) => p.link && p.link.scope && p.link.scope.id;
const presentKey = (p) => linkKey(p.params.token);

export const portalRoutes = [
  {
    method: "GET", path: "/p/quote/:id", scope: "quote",
    handler: async (p) => {
      const q = await quoteFor(p, p.params.id);
      if (!q) return p.message("That quote isn't here", "Check the link in your text or email, or call us.", { status: 404, company: p.company });
      return page(p, q, "portal");
    },
  },
  {
    method: "POST", path: "/api/portal/quotes/:id/approve", scope: "quote", maxBody: 400 * 1024,
    handler: (p) => answer(p, async () => {
      const q = await quoteFor(p, p.params.id);
      if (!q) return p.fail("not_found", "That quote isn't here.", 404);
      const out = await startApproval(q.id, p.body || {}, who(p, { method: "portal", contact_id: p.contact_id }), p);
      return p.json({ ok: true, data: out }, 202);
    }),
  },
  {
    method: "GET", path: "/api/portal/quotes/:id/runs/:run", scope: "quote",
    handler: async (p) => (await quoteFor(p, p.params.id) ? runAnswer(p, p.params.run, p.params.id) : p.fail("not_found", "Not found.", 404)),
  },
  {
    method: "POST", path: "/api/portal/quotes/:id/changes", scope: "quote",
    handler: (p) => answer(p, async () => {
      const q = await quoteFor(p, p.params.id);
      if (!q) return p.fail("not_found", "That quote isn't here.", 404);
      await requestChanges(q.id, { message: p.body && p.body.message }, p);
      return p.json({ ok: true, data: { status: "changes_requested" } });
    }),
  },
  {
    method: "POST", path: "/api/portal/quotes/:id/decline", scope: "quote",
    handler: (p) => answer(p, async () => {
      const q = await quoteFor(p, p.params.id);
      if (!q) return p.fail("not_found", "That quote isn't here.", 404);
      await declineQuote(q.id, { reason: p.body && p.body.reason }, p);
      return p.json({ ok: true, data: { status: "declined" } });
    }),
  },
  {
    method: "GET", path: "/api/portal/quotes/:id/files/:file", scope: "quote",
    handler: async (p) => { const q = await quoteFor(p, p.params.id); return q ? fileAnswer(p, q, p.params.file) : p.fail("not_found", "Not found.", 404); },
  },
  {
    method: "GET", path: "/p/present/:token", scope: "present",
    handler: async (p) => {
      const q = await quoteFor(p, presentQuoteId(p));
      if (!q) return p.message("That quote isn't here", "Open it again from the quote in the CRM.", { status: 404, company: p.company });
      return page(p, q, "present", p.params.token);
    },
  },
  {
    method: "POST", path: "/api/portal/present/:token/approve", scope: "present", maxBody: 400 * 1024,
    handler: (p) => answer(p, async () => {
      const q = await quoteFor(p, presentQuoteId(p));
      if (!q) return p.fail("not_found", "That quote isn't here.", 404);
      const staff = isId(p.link.created_by, "user") ? p.link.created_by : null;
      const out = await startApproval(q.id, p.body || {}, who(p, { method: "in_person", by: staff, actor_by: staff || "portal", contact_id: p.contact_id, link_key: presentKey(p) }), p);
      return p.json({ ok: true, data: out }, 202);
    }),
  },
  {
    method: "GET", path: "/api/portal/present/:token/runs/:run", scope: "present",
    handler: async (p) => runAnswer(p, p.params.run, presentQuoteId(p)),
  },
  {
    method: "GET", path: "/api/portal/present/:token/files/:file", scope: "present",
    handler: async (p) => { const q = await quoteFor(p, presentQuoteId(p)); return q ? fileAnswer(p, q, p.params.file) : p.fail("not_found", "Not found.", 404); },
  },
];

// The view beacon: core's POST /api/portal/beacon { kind: "quote", id } after load.
definePortalBeacon("quote", async ({ id, body, write }) => {
  await markViewed(id, { version_id: body && body.version_id }, { write });
});

// POST /quotes/:id/present (staff): a single-use 15-minute link to this
// quote's current version, opened top-level on the staff phone. A quote
// that changed since its last version (or was never sent) freezes one
// first, without sending anything. → { url, expires_at }
export async function presentLink(id, ctx) {
  let { data: q } = await getQuote(id);
  if (!["draft", "sent", "viewed", "changes_requested"].includes(q.status)) throw new ConflictError(["approved", "converted"].includes(q.status) ? "This quote is already approved." : "Restore this quote first.");
  if (q.status !== "sent" && q.status !== "viewed") q = (await sendQuote(id, { channels: [] }, ctx)).quote;
  else {
    const closed = versionClosed(q, await getVersion(q.current_version_id), { today: localDate(now()), pricing: await loadPricing() });
    if (closed) throw new ConflictError(closed.staff, { code: closed.code });
  }
  const link = await createPresentLink({ contact_id: q.contact_id, quote_id: q.id, created_by: (ctx.user && ctx.user.id) || "system" });
  return { url: `/p/present/${link.code}`, expires_at: link.expires_at };
}

export const portalSha = (s) => createHash("sha256").update(String(s)).digest("hex");
export { PORTAL_HEADERS };
