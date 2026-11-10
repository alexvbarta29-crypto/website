// Barta CRM core: the audit trail (design §3.8, §4.10, §4.12).
//
// crm-store writes an event for every record write (evt/{type}/{id}/...,
// write-once) and a row of the day's activity feed (aud/{date}/...). This
// file reads them for the screens and records the sensitive READS the
// design audits too (exports, file downloads by staff, payroll views of
// other people):
//
//   auditRead(ctx, type, id, action, extra)   write-once event, never blocks the answer
//   history(type, id, { limit })              a record's events, newest first (keys only)
//   eventFor(key, user)                       one event with its diff; cut to techFields for techs
//   auditFeed(date, { user, type })           who did what that day (aud/ keys only)
//
// Keys carry action and actor, so lists render from one listing without
// reading any value; only expanding a row reads its diff.

import { appendEvent, listEvents, getEvent, listKeys } from "../../crm-store.mjs";
import { fromTsKey, isLocalDate } from "./clock.mjs";
import { getType } from "./registry.mjs";
import { InputError } from "./errors.mjs";
import { uaFamily } from "./http.mjs";
import { keySafe } from "./text.mjs";

// A sensitive read (§3.8): a write-once event on the thing read, after the
// answer when the platform allows (context.waitUntil), never failing it.
export function auditRead(ctx, type, id, action, extra = {}) {
  const event = {
    action, by: (ctx.user && ctx.user.id) || (ctx.office ? "office" : "system"), origin: ctx.apiKey ? "mcp" : "api",
    ua: ctx.req ? uaFamily(ctx.req.headers.get("user-agent")) : undefined, req: ctx.requestId || null, ...extra,
  };
  const p = appendEvent(keySafe(type, 30), keySafe(id, 80), event).catch(() => {});
  const wait = ctx.context && typeof ctx.context.waitUntil === "function" ? ctx.context.waitUntil.bind(ctx.context) : null;
  if (wait) { try { wait(p); } catch { /* it still runs */ } return Promise.resolve(); }
  return p;
}

const EVT_KEY_RE = /^evt\/([a-z_]+)\/([a-z0-9._@-]+)\/\d{8}t\d{9}z--/;

// A record's history: [{ at, action, actor, key }], newest first.
export async function history(type, id, { limit = 50 } = {}, opts = {}) {
  return listEvents(type, id, { limit: Math.min(200, Math.max(1, Number(limit) || 50)) }, opts);
}

const TECH_EVENT_FIELDS = ["at", "action", "by", "origin", "changed", "wv"];

// One event by its key, with its diff. A tech sees only the fields of its
// type's techFields in `changed` and `diff` (§4.6).
export async function eventFor(key, user, opts = {}) {
  const m = EVT_KEY_RE.exec(String(key || ""));
  if (!m) throw new InputError("That isn't an event.", "key");
  const ev = await getEvent(key, opts);
  if (!ev) return null;
  if (!user || user.role !== "tech") return { ...ev, key, type: m[1], id: m[2] };
  const def = getType(m[1]);
  const allowed = new Set(def ? def.techFields : ["id"]);
  const out = Object.fromEntries(TECH_EVENT_FIELDS.filter((f) => ev[f] !== undefined).map((f) => [f, ev[f]]));
  if (Array.isArray(out.changed)) out.changed = out.changed.filter((f) => allowed.has(f));
  if (ev.diff && typeof ev.diff === "object") out.diff = Object.fromEntries(Object.entries(ev.diff).filter(([f]) => allowed.has(f)));
  return { ...out, key, type: m[1], id: m[2] };
}

const AUD_RE = /^aud\/(\d{4}-\d{2}-\d{2})\/(\d{8}t\d{9}z)--([a-z_]+)--([a-z0-9._@-]+?)--([a-z0-9._@-]+?)--([a-z0-9._@-]+)$/;

// The day's activity: [{ at, type, id, action, actor }], newest first.
// Filters: user (an actor id), type.
export async function auditFeed(date, { user, type, limit = 500 } = {}, opts = {}) {
  if (!isLocalDate(date)) throw new InputError("Pick a day.", "date");
  const keys = await listKeys(`aud/${date}/`, {}, opts);
  const rows = [];
  for (const k of keys) {
    const m = AUD_RE.exec(k);
    if (!m) continue;
    if (type && m[3] !== type) continue;
    if (user && m[6] !== user) continue;
    const d = fromTsKey(m[2]);
    rows.push({ at: d ? d.toISOString() : null, type: m[3], id: m[4], action: m[5], actor: m[6], ts: m[2] });
  }
  rows.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return rows.slice(0, Math.min(2000, Math.max(1, Number(limit) || 500))).map(({ ts, ...r }) => r);
}
