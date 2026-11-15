// Contacts module: the Customers list's Select (guide-gaps S11b), a contact's
// Files card (S11c) and "Open their portal" (S12).
//
//   POST /contacts/bulk { ids (≤ BULK_MAX), action, value }
//       action: tag | untag (value: a tag), owner (a user id or ""),
//       priority (low | medium | high | ""), lead_stage (a stage or ""),
//       archive (value: a reason). A person's own change (like the page's
//       edit), so no parallel-run guard. → { done, skipped, failed: [{ id, error }] };
//       a contact already so is skipped; one that can't change never stops the rest.
//   GET  /contacts/:id/files    the files on the contact (uploads are the
//       shared POST /files?owner_type=contact&owner_id=..&kind=document; delete
//       is DELETE /files/:id), office only
//   POST /contacts/:id/portal-view   a 15-minute, single-use portal link
//       marked office_view: the customer's hub as they see it, with nothing
//       paid, changed or counted as their view (portal/core.mjs), audited.

import { getRecord, updateRecord } from "../../../crm-store.mjs";
import { isId } from "../../core/ids.mjs";
import { nowMs } from "../../core/clock.mjs";
import { InputError, NotFoundError, ConflictError, BlobsTransientError, BudgetError, TimeoutError, UnknownOutcome } from "../../core/errors.mjs";
import { defineFileOwner, filesOf } from "../../core/files.mjs";
import { auditRead } from "../../core/audit.mjs";
import { createPortalLink, revokeLinks } from "../../portal/core.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { cleanTags, PRIORITIES, ARCHIVED_REASONS } from "./types.mjs";
import { LEAD_STAGES } from "./leadstage.mjs";
import { emitTagged } from "./tags.mjs";

export const BULK_MAX = 200;
export const BULK_ACTIONS = Object.freeze(["tag", "untag", "owner", "priority", "lead_stage", "archive"]);
export const PORTAL_VIEW_MINUTES = 15;

const str = (v) => (v == null ? "" : String(v)).trim();
const view = (c) => { const { _w, ...rest } = c; return rest; };

// What one action does to one contact (pure). → the next record, or null for no change.
export function applyBulk(c, action, value, { at } = {}) {
  if (!c || c.merged_into || c.merging_into || c.deleted_at) throw new ConflictError("This contact was merged or removed.");
  const tags = c.tags || [];
  const low = (t) => String(t).toLowerCase();
  switch (action) {
    case "tag": return tags.some((t) => low(t) === low(value)) ? null : { ...c, tags: cleanTags([...tags, value]) };
    case "untag": return tags.some((t) => low(t) === low(value)) ? { ...c, tags: tags.filter((t) => low(t) !== low(value)) } : null;
    case "owner": return (c.owner_id || "") === (value || "") ? null : { ...c, owner_id: value || undefined };
    case "priority": return (c.priority || "") === (value || "") ? null : { ...c, priority: value || undefined };
    case "lead_stage":
      if ((c.lead_stage || "") === (value || "")) return null;
      return value ? { ...c, lead_stage: value, lead_stage_by_hand: true, lead_stage_at: at } : { ...c, lead_stage: undefined, lead_stage_by_hand: undefined, lead_stage_at: at };
    case "archive": return c.lifecycle === "archived" ? null : { ...c, lifecycle: "archived", archived_reason: value || "other" };
    default: throw new InputError("Pick what to do.", "action");
  }
}

// The value an action needs, checked. → the clean value.
async function checkValue(action, raw) {
  const v = str(raw);
  if (action === "tag" || action === "untag") { if (!v) throw new InputError("Pick a tag.", "value"); return cleanTags([v])[0]; }
  if (action === "owner") {
    if (!v) return "";
    if (!isId(v, "user")) throw new InputError("That isn't someone on the team.", "value");
    const u = await getRecord("user", v);
    if (!u || u.data.status === "disabled") throw new InputError("That isn't someone on the team.", "value");
    return v;
  }
  if (action === "priority") { if (v && !PRIORITIES.includes(v)) throw new InputError("Pick low, medium or high.", "value"); return v; }
  if (action === "lead_stage") { if (v && !LEAD_STAGES.includes(v)) throw new InputError("Pick one of the stages.", "value"); return v; }
  if (action === "archive") { if (v && !ARCHIVED_REASONS.includes(v)) throw new InputError("Pick a reason.", "value"); return v || "other"; }
  throw new InputError("Pick what to do.", "action");
}

async function bulkRoute(ctx) {
  const b = ctx.body || {};
  const action = str(b.action);
  if (!BULK_ACTIONS.includes(action)) throw new InputError("Pick what to do.", "action");
  const ids = Array.isArray(b.ids) ? [...new Set(b.ids)] : [];
  if (!ids.length) throw new InputError("Pick the people first.", "ids");
  if (ids.length > BULK_MAX) throw new InputError(`Pick at most ${BULK_MAX} at a time.`, "ids");
  if (ids.some((x) => !isId(x, "contact"))) throw new InputError("That isn't a contact.", "ids");
  const value = await checkValue(action, b.value);
  const at = new Date(nowMs()).toISOString();
  let done = 0;
  const skipped = [];
  const failed = [];
  for (const id of ids) {
    try {
      const got = await getRecord("contact", id);
      if (!got || got.data.deleted_at) { skipped.push(id); continue; }
      if (action !== "archive" && got.data.lifecycle === "archived") { skipped.push(id); continue; }
      const r = await updateRecord("contact", id, (c) => applyBulk(c, action, value, { at }), ctx.write());
      if (!r.changed) { skipped.push(id); continue; }
      done += 1;
      if (action === "tag") await emitTagged(got.data, r.data, ctx);
      if (action === "archive") await revokeLinks(id, { by: ctx.user.id }).catch((e) => console.error(`crm:contacts: links not revoked (${safeErr(e)})`));
    } catch (e) {
      if (e instanceof BlobsTransientError || e instanceof BudgetError || e instanceof TimeoutError || e instanceof UnknownOutcome) throw e;
      failed.push({ id, error: e instanceof InputError || e instanceof ConflictError || e instanceof NotFoundError ? e.message : "It didn't change." });
    }
  }
  return { data: { done, skipped, failed } };
}

// ------------------------------------------------------------ files

// A contact's own files (the Files card): the office reads and adds them; a tech never does.
defineFileOwner("contact", {
  canRead: (ctx) => ctx.can("contacts:read_all"),
  canEdit: (ctx) => ctx.can("contacts:write"),
});

async function contactOrMissing(id) {
  if (!isId(id, "contact")) throw new NotFoundError("That contact isn't there.");
  const got = await getRecord("contact", id);
  if (!got || got.data.deleted_at) throw new NotFoundError("That contact isn't there.");
  return got.data;
}

async function filesRoute(ctx) {
  const c = await contactOrMissing(ctx.params.id);
  const list = await filesOf(c.id, { limit: 100 });
  return { data: list.filter((f) => f.owner && f.owner.type === "contact") };
}

// ------------------------------------------------------------ the portal, as they see it

async function portalViewRoute(ctx) {
  const c = await contactOrMissing(ctx.params.id);
  if (c.merged_into) throw new ConflictError("This contact was merged into another one. Open that one instead.");
  if (c.lifecycle === "archived") throw new ConflictError("Restore this contact first: an archived contact's portal is closed.");
  const exp = new Date(nowMs() + PORTAL_VIEW_MINUTES * 60000).toISOString();
  const link = await createPortalLink({ contact_id: c.id, scope: { kind: "hub" }, expires_at: exp, single_use: true, created_by: ctx.user.id, office_view: true });
  await auditRead(ctx, "contact", c.id, "portal_view");
  return { status: 201, data: { url: link.url, expires_at: link.expires_at } };
}

const R = (method, path, perm, subject, handler, extra = {}) => ({ method, path, auth: "session", perm, subject, mode: "inline", handler, ...extra });

export const bulkRoutes = [
  R("POST", "/contacts/bulk", "contacts:write", "none", bulkRoute, { maxCalls: 1000, budgetMs: 9000 }),
  R("GET", "/contacts/:id/files", "contacts:read_all", "required", filesRoute),
  R("POST", "/contacts/:id/portal-view", "contacts:write", "required", portalViewRoute, { maxCalls: 20, idempotent: false, secret: true }),
];

export { view };
