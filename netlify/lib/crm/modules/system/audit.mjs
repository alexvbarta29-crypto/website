// Core "system" module: the audit trail on screen (design §3.8, §4.10, §4.12).
//
//   GET /audit?date=&user=&type=          audit:read   the day's activity (who did what), from aud/ keys only
//   GET /audit/event?key=                 audit:read   one event with its diff
//   GET /records/:type/:id/history        the type's read permission (scoped: a tech sees only own
//                                         records, and only their techFields in the diffs)

import { getRecord } from "../../../crm-store.mjs";
import { InputError, ForbiddenError, NotFoundError } from "../../core/errors.mjs";
import { localDate, now } from "../../core/clock.mjs";
import { isId, typeOf } from "../../core/ids.mjs";
import { getType } from "../../core/registry.mjs";
import { techVisibleContacts } from "../../core/perms.mjs";
import { auditFeed, eventFor, history } from "../../core/audit.mjs";

async function feed(ctx) {
  const date = ctx.query.get("date") || localDate(now());
  const user = ctx.query.get("user") || undefined;
  const type = ctx.query.get("type") || undefined;
  if (user && !/^[a-z0-9._@-]{2,80}$/.test(user)) throw new InputError("Pick a person.", "user");
  if (type && !/^[a-z_]{2,40}$/.test(type)) throw new InputError("Pick a kind of record.", "type");
  return { data: await auditFeed(date, { user, type }), meta: { date } };
}

async function oneEvent(ctx) {
  const ev = await eventFor(ctx.query.get("key"), ctx.user);
  if (!ev) throw new NotFoundError("That event isn't there.");
  return { data: ev };
}

const CONTACT_SCOPED = new Set(["contact", "property", "conversation", "message", "invoice", "payment"]);

// May this person read this one record's history? The type's readPerm,
// unscoped, or scoped to this record (§4.6).
async function mayRead(ctx, def, id) {
  const perm = def.readPerm || "audit:read";
  if (ctx.can(perm)) return true;
  if (!ctx.holds(perm)) return false;
  const got = await getRecord(def.type, id);
  if (!got) return false;
  const subject = { type: def.type, record: got.data };
  if (CONTACT_SCOPED.has(def.type)) {
    const cid = def.type === "contact" ? id : got.data.contact_id;
    subject.visible = !!cid && (await techVisibleContacts(ctx.user.id)).has(cid);
  }
  return ctx.can(perm, subject);
}

async function recordHistory(ctx) {
  const { type, id } = ctx.params;
  const def = getType(type);
  if (!def || !isId(id) || (def.prefix && typeOf(id) !== type)) throw new NotFoundError("That record isn't there.");
  if (!(await mayRead(ctx, def, id))) throw new ForbiddenError("You don't have access to that.");
  return { data: await history(type, id, { limit: ctx.query.get("limit") || 50 }) };
}

const r = (method, path, perm, handler, more = {}) => ({ method, path, auth: "session_or_key", perm, subject: "none", mode: "inline", handler, ...more });
export const auditRoutes = [
  r("GET", "/audit", "audit:read", feed),
  r("GET", "/audit/event", "audit:read", oneEvent),
  r("GET", "/records/:type/:id/history", "account:own", recordHistory, { auth: "session", subject: "required" }),
];
