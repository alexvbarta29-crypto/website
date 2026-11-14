// Service module's API (guide-gaps S4, S15a, S45b). Office only: a
// technician holds none of these (requests:* are office permissions, and
// the list routes need the unscoped schedule:read).
//
//   GET  /jobs/stats?tile=                    schedule:read   the Jobs tab's tiles (count, $) and one tile's rows
//   POST /jobs/:id/review-ask | /tip-ask      schedule:write  a done job's review or tip text (dry run until texting is on)
//   POST /jobs/:id/callback { note? }         schedule:write  a touch-up job to book
//   GET  /requests?tile=&q=                   requests:read   tiles Open · Assessments this week · Unassigned · Became work · Closed, and the rows
//   POST /requests { client_id, contact_id, property_id?, services[], timing?, notes?, source?, assignee_id? }   requests:write
//   GET  /requests/:id · PATCH /requests/:id (If-Match)
//   POST /requests/:id/assessment { date, start, end, user_id } · /assessed · /convert { to } · /close { reason, note? } · /reopen
//   GET  /requests/contacts/:id               requests:read   the contact's requests (their Service card)

import { InputError } from "../../core/errors.mjs";
import { isId } from "../../core/ids.mjs";
import { jobStats, TILE_KEYS } from "./jobs.mjs";
import { reviewAsk, tipAsk, callback } from "./actions.mjs";
import { listRequests, requestDetail, createRequest, patchRequest, bookAssessment, markAssessed, convertRequest, closeRequest, reopenRequest, contactRequests } from "./requests.mjs";

const R = (method, path, perm, subject, handler, extra = {}) => ({ method, path, auth: "session", perm, subject, mode: "inline", handler, ...extra });
const q = (ctx, k) => String(ctx.query.get(k) || "").trim();

const stats = async (ctx) => {
  const tile = q(ctx, "tile");
  if (tile && !TILE_KEYS.includes(tile)) throw new InputError("Pick one of the tiles.", "tile");
  const r = await jobStats({ tile: tile || null });
  return { data: r.data, meta: { stale: r.stale } };
};
const list = async (ctx) => {
  const r = await listRequests({ tile: q(ctx, "tile") || "open", q: q(ctx, "q") });
  return { data: r.rows, meta: { tiles: r.tiles, stale: r.stale } };
};
const one = async (ctx) => requestDetail(ctx.params.id);
const create = async (ctx) => { const r = await createRequest(ctx.body || {}, ctx); return { status: r.existed ? 200 : 201, data: { request: r.request, existed: r.existed }, etag: r.etag }; };
const patch = async (ctx) => { const r = await patchRequest(ctx.params.id, ctx.body || {}, ctx); return { data: { request: r.request }, etag: r.etag }; };
const assess = async (ctx) => { const r = await bookAssessment(ctx.params.id, ctx.body || {}, ctx); return { data: { request: r.request }, etag: r.etag }; };
const assessed = async (ctx) => { const r = await markAssessed(ctx.params.id, ctx); return { data: { request: r.request }, etag: r.etag }; };
const convert = async (ctx) => ({ data: await convertRequest(ctx.params.id, ctx.body || {}, ctx) });
const close = async (ctx) => { const r = await closeRequest(ctx.params.id, ctx.body || {}, ctx); return { data: { request: r.request }, etag: r.etag }; };
const reopen = async (ctx) => { const r = await reopenRequest(ctx.params.id, ctx); return { data: { request: r.request }, etag: r.etag }; };
const ofContact = async (ctx) => {
  if (!isId(ctx.params.id, "contact")) throw new InputError("That isn't a contact.", "id");
  return { data: await contactRequests(ctx.params.id) };
};

export const serviceRoutes = [
  R("GET", "/jobs/stats", "schedule:read", "none", stats),
  R("POST", "/jobs/:id/review-ask", "schedule:write", "required", reviewAsk, { maxCalls: 60 }),
  R("POST", "/jobs/:id/tip-ask", "schedule:write", "required", tipAsk, { maxCalls: 60 }),
  R("POST", "/jobs/:id/callback", "schedule:write", "required", callback, { maxCalls: 120 }),
  R("GET", "/requests", "requests:read", "none", list),
  R("POST", "/requests", "requests:write", "none", create),
  R("GET", "/requests/contacts/:id", "requests:read", "required", ofContact, { maxCalls: 40 }),
  R("GET", "/requests/:id", "requests:read", "required", one),
  R("PATCH", "/requests/:id", "requests:write", "required", patch),
  R("POST", "/requests/:id/assessment", "requests:write", "required", assess),
  R("POST", "/requests/:id/assessed", "requests:write", "required", assessed),
  R("POST", "/requests/:id/convert", "requests:write", "required", convert, { maxCalls: 120 }),
  R("POST", "/requests/:id/close", "requests:write", "required", close),
  R("POST", "/requests/:id/reopen", "requests:write", "required", reopen),
];
