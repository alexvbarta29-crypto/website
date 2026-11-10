// Barta CRM core: permissions and tech data scoping (design §4.5, §4.6).
//
// A permission is "resource:action". A role's defaults are the D18 table
// below (true, "own" or false per role); the owner-only settings document
// cfg/permissions may change the admin and tech defaults; user.grants and
// user.denies override per person:
//
//   can(user, perm, subject?) = (role default ∪ grants) − denies, then the
//   scope rule for "own": a permission held only as "own" is FALSE without a
//   subject, so a list, search or export route (subject: "none") needs the
//   unscoped permission (contacts:read_all, invoices:read_all, ...), and a
//   scoped one is only ever checked against one record.
//
// settings:owner, users:manage and cutover:run belong to the owner role and
// can never be granted to anyone else (not by grants, not by
// cfg/permissions).
//
// scopeFor(user, subject) is the single place "is this record the tech's?"
// is decided. Callers pass { type, record } plus, for contacts and
// invoices, the facts they looked up (techVisibleContacts below).

import { getType, allPerms } from "./registry.mjs";
import { localDate, addLocalDays, now } from "./clock.mjs";
import { listRel, getRecords } from "../../crm-store.mjs";

export const ROLES = Object.freeze(["owner", "admin", "tech"]);

const T = true, OWN = "own", NO = false;
// [owner, admin, tech] per permission key (§4.5).
const TABLE = {
  "account:own": [T, T, T],                 // my own account: profile, password, devices, badges (M1.2)
  "contacts:read": [T, T, OWN],
  "contacts:read_all": [T, T, NO],
  "contacts:write": [T, T, NO],
  "leads:create": [T, T, T],
  "contacts:merge": [T, T, NO],
  "contacts:delete": [T, NO, NO],
  "consent:edit": [T, T, NO],
  "sales:work": [T, T, NO],
  "cadences:configure": [T, T, NO],
  "tasks:read": [T, T, OWN],
  "tasks:write": [T, T, OWN],
  "incidents:create": [T, T, T],
  "quotes:read": [T, T, NO],
  "quotes:write": [T, T, NO],
  "quotes:send": [T, T, NO],
  "prices:override": [T, T, NO],
  "pricebook:edit": [T, NO, NO],
  "settings:owner": [T, NO, NO],
  "plans:read": [T, T, NO],
  "plans:write": [T, T, NO],
  "plans:cancel": [T, T, NO],
  "fees:waive": [T, T, NO],
  "agreements:send": [T, T, NO],
  "agreement_templates:edit": [T, NO, NO],
  "schedule:read": [T, T, OWN],
  "schedule:write": [T, T, NO],
  "visits:work": [T, T, OWN],
  "visits:add_line": [T, T, OWN],
  "visits:prices": [T, T, OWN],
  "time:own": [T, T, T],
  "time:edit_others": [T, T, NO],
  "invoices:read": [T, T, OWN],
  "invoices:read_all": [T, T, NO],
  "invoices:write": [T, T, NO],
  "invoices:send": [T, T, NO],
  "invoices:void": [T, NO, NO],
  "payments:record": [T, T, OWN],
  "payments:charge": [T, T, NO],
  "payments:refund": [T, NO, NO],
  "credits:issue": [T, T, NO],
  "inbox:read": [T, T, OWN],
  "messages:send": [T, T, OWN],
  "templates:edit": [T, T, NO],
  "automations:configure": [T, T, NO],
  "campaigns:write": [T, T, NO],
  "campaigns:send": [T, T, NO],
  "reviews:read": [T, T, OWN],
  "reviews:match": [T, T, NO],
  "payroll:read_own": [T, T, T],
  "payroll:read_all": [T, T, NO],
  "payroll:run": [T, NO, NO],
  "reports:read": [T, T, OWN],
  "settings:general": [T, T, NO],
  "settings:messaging": [T, T, NO],
  "users:manage": [T, NO, NO],
  "integrations:manage": [T, NO, NO],
  "import:run": [T, NO, NO],
  "cutover:run": [T, NO, NO],
  "export:all": [T, NO, NO],
  "audit:read": [T, T, NO],
  "outbox:read": [T, T, NO],
  "pending_actions:approve": [T, NO, NO],
  "api_keys:own": [T, T, NO],
};

export const ROLE_DEFAULTS = Object.freeze(Object.fromEntries(ROLES.map((role, i) => [role, Object.freeze(Object.fromEntries(Object.entries(TABLE).map(([k, v]) => [k, v[i]])))])));
export const PERMISSION_KEYS = Object.freeze(Object.keys(TABLE));
export const OWNER_ONLY = Object.freeze(new Set(["settings:owner", "users:manage", "cutover:run"]));

const PERM_RE = /^[a-z_]+:[a-z_]+$/;
const isValue = (v) => v === true || v === false || v === OWN;

// The default of a permission for a role: the D18 table, a module's own
// permission (registered through its manifest), then cfg/permissions for
// admin and tech. Unknown permissions are false.
export function roleDefault(role, perm, permissions = null) {
  if (!ROLES.includes(role)) return false;
  let v;
  if (Object.hasOwn(TABLE, perm)) v = ROLE_DEFAULTS[role][perm];
  else {
    const reg = allPerms().find((p) => p.key === perm);
    v = reg && reg.roles && isValue(reg.roles[role]) ? reg.roles[role] : false;
  }
  if (role !== "owner" && !OWNER_ONLY.has(perm)) {
    const o = permissions && permissions.roles && permissions.roles[role];
    if (o && Object.hasOwn(o, perm) && isValue(o[perm])) v = o[perm];
  }
  if (role !== "owner" && OWNER_ONLY.has(perm)) v = false;
  return v;
}

// true | "own" | false: what a user holds before the scope rule.
export function holds(user, perm, permissions = null) {
  if (!user || user.status !== "active" || !PERM_RE.test(String(perm))) return false;
  let v = roleDefault(user.role, perm, permissions);
  const grants = Array.isArray(user.grants) ? user.grants : [];
  const denies = Array.isArray(user.denies) ? user.denies : [];
  if (grants.includes(perm) && !(OWNER_ONLY.has(perm) && user.role !== "owner")) v = true;
  if (denies.includes(perm)) v = false;
  return v;
}

export function can(user, perm, subject = undefined, permissions = null) {
  const v = holds(user, perm, permissions);
  if (v === true) return true;
  if (v === OWN) return subject ? scopeFor(user, subject) : false;
  return false;
}

// Every permission a user holds: { "contacts:read": "own", "leads:create": true, ... }.
export function permsFor(user, permissions = null) {
  const keys = new Set([...PERMISSION_KEYS, ...allPerms().map((p) => p.key)]);
  const out = {};
  for (const k of [...keys].sort()) {
    const v = holds(user, k, permissions);
    if (v) out[k] = v;
  }
  return out;
}

const has = (list, id) => Array.isArray(list) && list.includes(id);

// Is this one record the user's own (§4.6)? subject = { type, record, ... }.
//   visit: assignee; job: any visit of it (subject.visits) or job.assignee_ids;
//   contact / property / conversation / message / invoice: subject.visible
//   (from techVisibleContacts); timesheet / pay_line / timer: user_id;
//   task: assignee; user: the user themself.
export function scopeFor(user, subject) {
  if (!user || !subject || typeof subject !== "object") return false;
  const type = subject.type || (subject.record && subject.record.type);
  const r = subject.record || {};
  switch (type) {
    case "visit": return has(r.assignee_ids, user.id);
    case "job": return has(r.assignee_ids, user.id) || (Array.isArray(subject.visits) && subject.visits.some((v) => v && has(v.assignee_ids, user.id)));
    case "contact": case "property": case "conversation": case "message": case "invoice": case "payment":
      return subject.visible === true;
    case "timesheet": case "pay_line": case "timer":
      return r.user_id === user.id || has(r.user_ids, user.id);
    case "task": return has(r.assignee_ids, user.id);
    case "user": return r.id === user.id;
    default: return false;
  }
}

// The contact ids a tech may see: those with a visit assigned to the tech
// dated within [today − 7 days, today + 30 days] (rel/tech-visits/{uid},
// sort key = local date). One listing plus one read per visit, cached by
// the caller for the request.
export const TECH_WINDOW = Object.freeze({ before: 7, after: 30 });
export async function techVisibleContacts(userId, opts = {}) {
  const today = localDate(now());
  const from = addLocalDays(today, -TECH_WINDOW.before);
  const to = addLocalDays(today, TECH_WINDOW.after);
  const rows = await listRel("tech-visits", userId, { from, to, limit: 500, newestFirst: false }, opts);
  const visits = await getRecords("visit", rows.map((r) => r.id), opts);
  return new Set(visits.filter((v) => v && v.data && !v.data.deleted_at && has(v.data.assignee_ids, userId)).map((v) => v.data.contact_id).filter(Boolean));
}

// The fields of a record a tech may read (§3.14 techFields, §4.6): also
// used for the `current` body of a 412 and history diffs.
export function techView(type, record) {
  if (!record || typeof record !== "object") return record;
  const def = getType(type);
  const fields = def ? def.techFields : ["id"];
  const out = {};
  for (const f of fields) if (Object.hasOwn(record, f)) out[f] = record[f];
  return out;
}

// Whether the user is a technician-only view (techs; owners and admins see the office side).
export const isTechRole = (user) => !!user && user.role === "tech";
