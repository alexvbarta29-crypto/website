// Record types of the core "system" module (design §3.3). M1.1 defines the
// contact_stats sidecar (§5.1), which updateStats() writes; M1.2 adds the
// staff user (§4.1); M1.3 adds file, run, outbox, pending_action, template
// and notification.

import { defineType } from "../../core/registry.mjs";
import { isId } from "../../core/ids.mjs";
import { InputError } from "../../core/errors.mjs";
import { contactShard, statsIndexRow, STATS_INDEX, STATS_INDEX_PART } from "../../core/stats.mjs";
import { shape, str, enumValue, bool, email, phoneE164, int, arr } from "../../core/validate.mjs";

// rec/contact_stats/{contactId}: envelope + one part per owning module.
// Written only by crm-store updateStats(); never a user edit, never imported
// (rotorFields empty), never shown to a tech (techFields = id only).
export const contactStatsType = defineType({
  type: "contact_stats",
  prefix: null,
  idType: "contact",
  v: 1,
  validate(data) {
    if (!isId(data.id, "contact")) throw new InputError("contact_stats needs a contact id.", "id");
    return data;
  },
  rotorFields: [],
  techFields: ["id"],
  shadow: false,
  audit: false,
  indexes: [{
    name: STATS_INDEX,
    part: STATS_INDEX_PART,
    primary: false,
    shard: (r) => contactShard(r.id),
    row: (r) => statsIndexRow(r),
  }],
  example: () => ({ id: "ct_0000000000000000000a", type: "contact_stats", v: 1, wv: 1 }),
});

// ------------------------------------------------------------------ users (§4.1)

export const USER_ROLES = Object.freeze(["owner", "admin", "tech"]);
export const USER_STATUSES = Object.freeze(["invited", "active", "disabled"]);
export const LOGIN_RE = /^[a-z0-9][a-z0-9.-]{1,31}$/;
// Calendar colors handed out in order (the dashboard's palette).
export const USER_COLORS = Object.freeze(["#2a78d6", "#fb4d3d", "#13a165", "#b7791f", "#7c4dff", "#0e9aa7", "#d0331f", "#4a4a52"]);
const PAY_MODELS = ["hourly", "commission", "greater_of", "hourly_plus_commission"];
const NOTIFY_KEYS = ["new_lead", "reply", "payment", "agreement_signed", "review"];
const CHANNELS = ["sms", "email", "push"];

export const DEFAULT_PAY = Object.freeze({ model: "hourly", hourly_cents: { service: 0, sales: 0, office: 0 }, commission_pct: { technician: 0, salesman: 0, upsell: 0 }, overtime: true });
export const DEFAULT_NOTIFY = Object.freeze({ new_lead: ["push"], reply: ["push"], payment: [], agreement_signed: [], review: [] });

export function normLogin(v, field = "login") {
  const s = String(v ?? "").trim().toLowerCase();
  if (!LOGIN_RE.test(s)) throw new InputError("Use 2-32 lowercase letters, numbers, dots or dashes, like alex.", field);
  return s;
}

const splitName = (name) => {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  return { first: parts[0] || "", last: parts.slice(1).join(" ") };
};

const permKey = (v, f) => {
  if (typeof v !== "string" || !/^[a-z_]+:[a-z_]+$/.test(v)) throw new InputError("That isn't a permission.", f);
  return v;
};

function validatePay(p, field) {
  const v = p && typeof p === "object" && !Array.isArray(p) ? p : {};
  const cents = (o, keys, f) => Object.fromEntries(keys.map((k) => [k, int(o && o[k], { field: `${f}.${k}`, min: 0, max: 1000000 }) ?? 0]));
  return {
    ...v,
    model: enumValue(v.model, PAY_MODELS, { field: `${field}.model`, stored: true }) || "hourly",
    hourly_cents: cents(v.hourly_cents, ["service", "sales", "office"], `${field}.hourly_cents`),
    commission_pct: cents(v.commission_pct, ["technician", "salesman", "upsell"], `${field}.commission_pct`),
    overtime: v.overtime === undefined ? true : bool(v.overtime, { field: `${field}.overtime` }),
  };
}

function validateNotify(n, field) {
  const v = n && typeof n === "object" && !Array.isArray(n) ? n : {};
  const out = { ...v };
  for (const k of NOTIFY_KEYS) out[k] = v[k] === undefined ? [...DEFAULT_NOTIFY[k]] : arr(v[k], (x, f) => enumValue(x, CHANNELS, { field: f, required: true, stored: true }), { field: `${field}.${k}`, max: 3 });
  return out;
}

function validateUser(data, { op } = {}) {
  const stored = op === "update";
  const out = shape(data, {
    login: (v, f) => normLogin(v, f),
    name: (v, f) => str(v, { field: f, max: 60, required: true }),
    first_name: (v, f) => str(v, { field: f, max: 40 }),
    last_name: (v, f) => str(v, { field: f, max: 40 }),
    role: (v, f) => enumValue(v, USER_ROLES, { field: f, required: true, stored }),
    status: (v, f) => enumValue(v, USER_STATUSES, { field: f, stored }) || "invited",
    is_technician: (v, f) => bool(v, { field: f }),
    email: (v, f) => email(v, { field: f }) || undefined,
    phone: (v, f) => phoneE164(v, { field: f }) || undefined,
    color: (v, f) => {
      if (v === undefined || v === null || v === "") return USER_COLORS[0];
      if (typeof v !== "string" || !/^#[0-9a-f]{6}$/i.test(v)) throw new InputError("Pick a color.", f);
      return v.toLowerCase();
    },
    session_epoch: (v, f) => int(v, { field: f, min: 0 }) ?? 0,
    grants: (v, f) => arr(v, permKey, { field: f, max: 100 }),
    denies: (v, f) => arr(v, permKey, { field: f, max: 100 }),
    pay: (v, f) => validatePay(v, f),
    notify: (v, f) => validateNotify(v, f),
    availability: (v, f) => arr(v, (x, ff) => {
      if (!x || typeof x !== "object") throw new InputError("Expected a time range.", ff);
      return { ...x, dow: int(x.dow, { field: `${ff}.dow`, min: 0, max: 6, required: true }), start: str(x.start, { field: `${ff}.start`, max: 5, required: true }), end: str(x.end, { field: `${ff}.end`, max: 5, required: true }) };
    }, { field: f, max: 21 }),
  });
  if (!out.first_name && !out.last_name) {
    const parts = splitName(out.name);
    out.first_name = parts.first;
    out.last_name = parts.last;
  }
  if (out.password === undefined) out.password = null;
  return out;
}

// A user's row in ix/users: no email, phone, pay or password.
export const userRow = (r) => ({ login: r.login, name: r.name, first_name: r.first_name, role: r.role, status: r.status, is_technician: !!r.is_technician, color: r.color });

export const userType = defineType({
  type: "user",
  prefix: "us",
  v: 1,
  validate: validateUser,
  rotorFields: ["rotor"],
  techFields: ["id", "name", "first_name", "color", "is_technician"],
  shadow: false,
  indexes: [{ name: "users", shard: (r) => "", row: userRow }],
  pointers: [{ kind: "login", key: (r) => r.login }],
  summary: (r) => ({ id: r.id, name: r.name, color: r.color }),
  example: () => ({
    login: "sample.tech", name: "Sample Tech", first_name: "Sample", last_name: "Tech", role: "tech", status: "active",
    is_technician: true, color: USER_COLORS[2], session_epoch: 0, grants: [], denies: [], password: null,
  }),
});

// What the API shows of a user. Never the password hash or an invite token;
// email, phone and pay only to the person themself or someone who manages users.
export function publicUser(u, { full = false } = {}) {
  if (!u) return null;
  const out = {
    id: u.id, login: u.login, name: u.name, first_name: u.first_name, last_name: u.last_name, role: u.role, status: u.status,
    is_technician: !!u.is_technician, color: u.color, has_password: !!(u.password && u.password.hash),
    last_sign_in_at: u.last_sign_in_at || null, created_at: u.created_at || null, updated_at: u.updated_at || null,
  };
  if (full) {
    if (u.email) out.email = u.email;
    if (u.phone) out.phone = u.phone;
    out.notify = u.notify || DEFAULT_NOTIFY;
    out.grants = u.grants || [];
    out.denies = u.denies || [];
    out.pay = u.pay || DEFAULT_PAY;
    out.invite = u.invite && u.invite.expires_at ? { kind: u.invite.kind || "invite", expires_at: u.invite.expires_at } : null;
  }
  return out;
}

export const types = [contactStatsType, userType];
