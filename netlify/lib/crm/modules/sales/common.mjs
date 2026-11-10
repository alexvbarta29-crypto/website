// Sales module: small pieces every sales file shares: the write context of
// whoever is acting, the parallel-run guard question, the calendar
// settings, contact lookups, and who gets a task or a notification.

import { getRecord, getRecords, getSetting, listRel } from "../../../crm-store.mjs";
import { now as clockNow } from "../../core/clock.mjs";
import { isId } from "../../core/ids.mjs";
import { guardFor } from "../../core/context.mjs";
import { actorKindOf } from "../../core/guard.mjs";
import { readSysMode } from "../../core/settings.mjs";
import { has, call } from "../../core/services.mjs";
import { wouldAct } from "../../core/activity.mjs";
import { approvers } from "../../core/notify.mjs";
import { DEFAULT_HOURS, DEFAULT_CALENDAR } from "../../core/clock.mjs";
import { DEFAULT_CUTOFF } from "./cadence.mjs";

// The sales settings document (cfg/sales, §3.3; cadences:configure).
export const SALES_DEFAULTS = Object.freeze({
  attention_hours: 24,          // an open lead with no call, text or email this long needs attention
  paused_attention_days: 2,     // a paused enrollment this old needs attention
  abandon_days: 30,             // an open or quoted deal idle this long after its last step is abandoned
  expire_days: 14,              // an active step overdue this long stops the enrollment (expired)
  day_cutoff: DEFAULT_CUTOFF,   // a lead after this starts on the next open day
  ack_delay_min: 5,             // lead.ack waits this long for a call during business hours (D20)
  calling_minutes: 30,          // a provisional "calling" holds lead.ack off this long
});

// The plain write context a store call takes.
export const W = (ctx = {}) => (typeof ctx.write === "function" ? ctx.write() : ctx);

// Is automation allowed to change this record (§0 rule 12)? People, the
// portal and the import always are; automation only on sandboxed records
// while Rotor is the system of record.
export async function mayActOn(ctx, record, contact = null) {
  if (actorKindOf(W(ctx)) !== "automation") return true;
  const mode = (ctx && ctx.mode) || await readSysMode();
  return guardFor(mode).mayAct({ record, contact });
}

// The report-only row for what automation would have done.
export function would(ctx, key, subject, action, changes) {
  if (ctx && typeof ctx.would === "function") return ctx.would(subject, action, changes).catch(() => {});
  return wouldAct({ key, subject, action, changes }).catch(() => {});
}

// Hours, holidays and the sales settings, with `now`.
export async function loadEnv(at) {
  const [hours, calendar, sales] = await Promise.all([
    getSetting("hours").catch(() => ({ ...DEFAULT_HOURS })),
    getSetting("calendar").catch(() => ({ ...DEFAULT_CALENDAR })),
    getSetting("sales").catch(() => ({ ...SALES_DEFAULTS })),
  ]);
  return { hours, calendar, sales: { ...SALES_DEFAULTS, ...sales }, cutoff: (sales && sales.day_cutoff) || DEFAULT_CUTOFF, now: at || clockNow() };
}

// A contact id followed through merges (contacts.resolve when Contacts is there).
export async function resolveContactId(id, ctx) {
  if (!isId(id, "contact")) return null;
  if (has("contacts.resolve")) {
    try { return (await call("contacts.resolve", id, ctx)) || id; } catch { return id; }
  }
  return id;
}

// The live contact record (merges followed), or null.
export async function contactOf(id, ctx) {
  const cid = await resolveContactId(id, ctx);
  if (!cid) return null;
  const got = await getRecord("contact", cid);
  if (!got || got.data.deleted_at) return null;
  return got.data;
}

export const nameOf = (c) => (c ? c.display_name || [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || c.company_name || "No name" : "No name");
export const firstNameOf = (c) => (c && (c.first_name || String(c.display_name || "").split(/\s+/)[0])) || "Someone";
export const townOf = (c) => (c && c.billing_address && c.billing_address.city) || "";
export const primaryPhone = (c) => {
  const phones = (c && Array.isArray(c.phones) ? c.phones : []).filter((p) => p && p.e164);
  const p = phones.find((x) => x.primary) || phones[0];
  return p ? p.e164 : null;
};

// Records of a relation family for a contact, newest first (bounded).
export async function relRecords(rel, type, parent, { limit = 30 } = {}) {
  const rows = await listRel(rel, parent, { limit });
  const got = await getRecords(type, rows.map((r) => r.id));
  return got.filter((g) => g && g.data && !g.data.deleted_at).map((g) => ({ ...g.data, _etag: g.etag }));
}

// Who a lead's task or alert goes to: its owner, else the owners.
export async function leadPeople(contact) {
  if (contact && isId(contact.owner_id, "user")) return [contact.owner_id];
  return approvers().catch(() => []);
}

export const strip = (r) => { if (!r) return r; const { _w, _etag, ...rest } = r; return rest; };
