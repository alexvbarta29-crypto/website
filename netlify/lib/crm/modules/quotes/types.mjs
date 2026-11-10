// Record types of the quotes module: price_item, discount_def, quote,
// quote_version (design §3.3, §5.3). Each is a defineType() object with
// rotorFields, techFields and example() (§3.14).
//
// Validators keep unknown fields and keep a stored enum value this code
// doesn't know (§3.14 schema rules). A line's total_cents is always
// recomputed here from its override or qty × unit (integers only), so a
// stored line can never disagree with its own numbers. Option totals
// depend on cfg/pricing (the floor) and are computed by quotes.mjs before
// every write. Index rows use short keys and never hold notes.

import { defineType } from "../../core/registry.mjs";
import { isId } from "../../core/ids.mjs";
import { tsKey, isLocalDate } from "../../core/clock.mjs";
import { InputError } from "../../core/errors.mjs";
import { shape, str, enumValue, bool, arr, isoTime, int } from "../../core/validate.mjs";
import { rotorKey } from "../contacts/display.mjs";
import { lineTotal, PLAN_KEYS } from "./pricing.mjs";

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const sortOf = (at) => tsKey(new Date(Date.parse(at) || 0));

// ------------------------------------------------------------ vocabulary

export const QUOTE_STATUSES = Object.freeze(["draft", "sent", "viewed", "approved", "changes_requested", "declined", "converted", "archived"]);
export const OPEN_STATUSES = Object.freeze(["draft", "sent", "viewed", "changes_requested", "approved"]);
export const APPROVABLE = Object.freeze(["sent", "viewed"]);
export const ARCHIVE_REASONS = Object.freeze(["cadence_expired", "manual", "superseded", "expired"]);
export const CATEGORIES = Object.freeze(["windows_ext", "windows_int", "screens", "tracks", "gutters", "lights", "warranty", "fee", "other"]);
export const UNITS = Object.freeze(["flat", "pane", "screen", "track", "ft", "each", "hour"]);
export const ENGINES = Object.freeze(["exterior_tiers", "interior_segments", "lights_install_ft", "lights_materials_ft", "manual"]);
export const SCOPES = Object.freeze(["all", "initial", "after_initial", "specific"]);
export const OPTION_KINDS = Object.freeze(["one_time", "plan"]);
export const BILLING = Object.freeze(["barta_standard", "after_visit", "first_of_month"]);
export const INTERVALS = Object.freeze(["month", "year", "week", "day"]);
export const DEPOSIT_TYPES = Object.freeze(["none", "fixed", "percent"]);
export const SENT_VIA = Object.freeze(["sms", "email"]);
export const APPROVAL_METHODS = Object.freeze(["portal", "in_person", "phone"]);
export const MAX_OPTIONS = 3;
export const MAX_LINES = 50;
export const MAX_DISCOUNTS = 10;

export const LINE_ID_RE = /^(ln_[0-9a-z_]{2,40}|[A-Za-z0-9][A-Za-z0-9_.-]{0,63})$/;
export const OPTION_ID_RE = /^op_[0-9a-z_]{1,30}$/;
export const DISCOUNT_ID_RE = /^dc_[0-9a-z_]{1,40}$/;
export const DEF_KEY_RE = /^[a-z][a-z0-9_]{1,39}$/;

const idOf = (type) => (v, f) => {
  if (v === undefined || v === null || v === "") return undefined;
  if (!isId(v, type)) throw new InputError("That id doesn't look right.", f);
  return v;
};
const fileIds = (v, f) => [...new Set(arr(v, (x, ff) => { if (!isId(x, "file")) throw new InputError("That isn't a file.", ff); return x; }, { field: f, max: 20 }))];
const isoOpt = (v, f) => isoTime(v, { field: f });
const dateOpt = (v, f) => {
  if (v === undefined || v === null || v === "") return undefined;
  if (!isLocalDate(v)) throw new InputError("Use a date like 2026-12-01.", f);
  return v;
};

// ------------------------------------------------------------ scopes, lines, discounts, options

export function validateScope(v, f, { stored = false } = {}) {
  if (v === undefined || v === null) return { type: "all" };
  if (!isObj(v)) throw new InputError("Pick which visits this applies to.", f);
  const type = enumValue(v.type, SCOPES, { field: `${f}.type`, stored }) || "all";
  if (type !== "specific") return { type };
  const visits = [...new Set(arr(v.visits, (x, ff) => int(x, { field: ff, min: 1, max: 120, required: true }), { field: `${f}.visits`, max: 120 }))].sort((a, b) => a - b);
  if (!visits.length) throw new InputError("Pick at least one visit.", `${f}.visits`);
  return { type, visits };
}

function validateShow(v) {
  const s = isObj(v) ? v : {};
  return { qty: s.qty === true, unit: s.unit === true, description: s.description !== false };
}

export function validateLine(v, f, { stored = false } = {}) {
  if (!isObj(v)) throw new InputError("Expected a line.", f);
  const id = String(v.id ?? "");
  if (!LINE_ID_RE.test(id)) throw new InputError("That line needs an id.", `${f}.id`);
  const out = shape(v, {
    price_item_id: idOf("price_item"),
    title: (x, ff) => str(x, { field: ff, max: 160, required: true }),
    description: (x, ff) => str(x, { field: ff, max: 2000, trim: false }) || "",
    qty_milli: (x, ff) => int(x, { field: ff, min: 0, max: 1000000000 }) ?? 1000,
    unit_cents: (x, ff) => int(x, { field: ff, min: -100000000, max: 100000000 }) ?? 0,
    engine_cents: (x, ff) => int(x, { field: ff, min: 0, max: 100000000 }),
    override: (x, ff) => {
      if (x === undefined || x === null) return undefined;
      if (!isObj(x)) throw new InputError("Expected a price override.", ff);
      return {
        cents: int(x.cents, { field: `${ff}.cents`, min: -100000000, max: 100000000, required: true }),
        reason: str(x.reason, { field: `${ff}.reason`, max: 200, required: true }),
        ...(x.by ? { by: str(x.by, { field: `${ff}.by`, max: 80 }) } : {}),
        ...(x.at ? { at: isoTime(x.at, { field: `${ff}.at` }) } : {}),
      };
    },
    scope: (x, ff) => validateScope(x, ff, { stored }),
    optional: (x, ff) => (x === undefined ? undefined : bool(x, { field: ff }) || undefined),
    selected: (x, ff) => (x === undefined ? undefined : bool(x, { field: ff })),
    service_type: (x, ff) => str(x, { field: ff, max: 80 }) || undefined,
    tier: (x, ff) => str(x, { field: ff, max: 80 }) || undefined,
    category: (x, ff) => enumValue(x, CATEGORIES, { field: ff, stored }) || "other",
    unit: (x, ff) => enumValue(x, UNITS, { field: ff, stored }) || "flat",
    upsell_user_id: idOf("user"),
    show: (x) => validateShow(x),
    offer: (x, ff) => (x === undefined || x === null || x === "" ? undefined : str(x, { field: ff, max: 40 })),
  });
  out.id = id;
  out.total_cents = lineTotal(out);
  return out;
}

export function validateDiscount(v, f, { stored = false } = {}) {
  if (!isObj(v)) throw new InputError("Expected a discount.", f);
  const id = String(v.id ?? "");
  if (!DISCOUNT_ID_RE.test(id)) throw new InputError("That discount needs an id.", `${f}.id`);
  const type = enumValue(v.type, ["fixed", "percentage"], { field: `${f}.type`, required: true, stored });
  const out = shape(v, {
    def_id: idOf("discount_def"),
    key: (x, ff) => (x === undefined || x === null || x === "" ? undefined : (DEF_KEY_RE.test(String(x)) ? String(x) : (() => { throw new InputError("That isn't a discount key.", ff); })())),
    name: (x, ff) => str(x, { field: ff, max: 80, required: true }),
    value: (x, ff) => int(x, { field: ff, min: 0, max: type === "percentage" ? 10000 : 100000000, required: true }),
    scope: (x, ff) => validateScope(x, ff, { stored }),
    reason: (x, ff) => str(x, { field: ff, max: 200 }) || undefined,
    stack_group: (x, ff) => str(x, { field: ff, max: 30 }) || undefined,
    offer: (x, ff) => (x === undefined || x === null || x === "" ? undefined : str(x, { field: ff, max: 40 })),
    offer_until: dateOpt,
  });
  out.id = id;
  out.type = type;
  return out;
}

function validatePlan(v, f, { stored = false } = {}) {
  if (!isObj(v)) throw new InputError("A plan option needs its plan settings.", f);
  return shape(v, {
    catalog_key: (x, ff) => enumValue(x, PLAN_KEYS, { field: ff, required: true, stored }),
    frequency: (x, ff) => {
      if (!isObj(x)) throw new InputError("How often?", ff);
      return { interval: enumValue(x.interval, INTERVALS, { field: `${ff}.interval`, required: true, stored }), count: int(x.count, { field: `${ff}.count`, min: 1, max: 52, required: true }) };
    },
    visits_per_year: (x, ff) => int(x, { field: ff, min: 1, max: 52, required: true }),
    term_months: (x, ff) => int(x, { field: ff, min: stored ? 1 : 12, max: 60 }) ?? 12,
    billing: (x, ff) => enumValue(x, BILLING, { field: ff, stored }) || "barta_standard",
    autopay: (x, ff) => bool(x, { field: ff }),
    auto_renew: (x, ff) => (x === undefined ? true : bool(x, { field: ff })),
  }, { field: f });
}

const totalsOf = (v, f) => {
  if (v === undefined || v === null) return undefined;
  if (!isObj(v)) throw new InputError("Expected totals.", f);
  const c = (x, ff) => int(x, { field: ff, min: -1000000000, max: 1000000000 }) ?? 0;
  return { first_cents: c(v.first_cents, `${f}.first_cents`), per_visit_cents: arr(v.per_visit_cents, (x, ff) => c(x, ff), { field: `${f}.per_visit_cents`, max: 120 }), term_cents: c(v.term_cents, `${f}.term_cents`), annual_cents: c(v.annual_cents, `${f}.annual_cents`) };
};

export function validateOption(v, f, { stored = false } = {}) {
  if (!isObj(v)) throw new InputError("Expected an option.", f);
  const id = String(v.id ?? "");
  if (!OPTION_ID_RE.test(id)) throw new InputError("That option needs an id.", `${f}.id`);
  const kind = enumValue(v.kind, OPTION_KINDS, { field: `${f}.kind`, stored }) || "one_time";
  const out = shape(v, {
    name: (x, ff) => str(x, { field: ff, max: 60 }) || (kind === "plan" ? "Plan" : "One-time"),
    recommended: (x, ff) => bool(x, { field: ff }),
    plan: (x, ff) => (kind === "plan" ? validatePlan(x, ff, { stored }) : undefined),
    lines: (x, ff) => arr(x, (l, lf) => validateLine(l, lf, { stored }), { field: ff, max: MAX_LINES }),
    discounts: (x, ff) => arr(x, (d, df) => validateDiscount(d, df, { stored }), { field: ff, max: MAX_DISCOUNTS }),
    totals: totalsOf,
  });
  out.id = id;
  out.kind = kind;
  const seen = new Set();
  out.lines.forEach((l, i) => { if (seen.has(l.id)) throw new InputError("Two lines share an id.", `${f}.lines.${i}.id`); seen.add(l.id); });
  const dseen = new Set();
  const groups = new Map();
  out.discounts.forEach((d, i) => {
    if (dseen.has(d.id)) throw new InputError("Two discounts share an id.", `${f}.discounts.${i}.id`);
    dseen.add(d.id);
    if (d.stack_group) {
      if (groups.has(d.stack_group) && !stored) throw new InputError(`${groups.get(d.stack_group)} and ${d.name} can't be combined.`, `${f}.discounts.${i}`);
      groups.set(d.stack_group, d.name);
    }
  });
  return out;
}

function validateAgreement(v, f) {
  const a = isObj(v) ? v : {};
  const dep = isObj(a.deposit) ? a.deposit : {};
  const type = enumValue(dep.type, DEPOSIT_TYPES, { field: `${f}.deposit.type`, stored: true }) || "none";
  const value = type === "none" ? 0 : int(dep.value, { field: `${f}.deposit.value`, min: 0, max: type === "percent" ? 10000 : 100000000 }) ?? 0;
  return {
    ...a,
    ...(a.template_id ? { template_id: str(a.template_id, { field: `${f}.template_id`, max: 64 }) } : {}),
    require_card: a.require_card === true,
    deposit: { type, value },
  };
}

// ------------------------------------------------------------ price_item

export function validatePriceItem(data, { op } = {}) {
  const stored = op === "update";
  return shape(data, {
    key: (v, f) => (v === undefined || v === null || v === "" ? undefined : DEF_KEY_RE.test(String(v)) ? String(v) : (() => { throw new InputError("That isn't a key.", f); })()),
    name: (v, f) => str(v, { field: f, max: 120, required: true }),
    category: (v, f) => enumValue(v, CATEGORIES, { field: f, stored }) || "other",
    service_type: (v, f) => str(v, { field: f, max: 80 }) || "Residential Window Cleaning",
    unit: (v, f) => enumValue(v, UNITS, { field: f, stored }) || "flat",
    unit_cents: (v, f) => int(v, { field: f, min: 0, max: 100000000 }) ?? 0,
    engine: (v, f) => enumValue(v, ENGINES, { field: f, stored }),
    description: (v, f) => str(v, { field: f, max: 2000, trim: false }) || "",
    show: (v) => validateShow(v),
    active: (v, f) => (v === undefined ? true : bool(v, { field: f })),
    sellable: (v, f) => (v === undefined ? true : bool(v, { field: f })),
    rotor_template_ids: (v, f) => [...new Set(arr(v, (x, ff) => str(x, { field: ff, max: 64, required: true }), { field: f, max: 200 }))].sort(),
  });
}

export const priceItemRow = (r) => ({ k: r.key || null, nm: r.name, cat: r.category, u: r.unit, uc: r.unit_cents, e: r.engine || null, act: r.active !== false, sell: r.sellable !== false, st: r.service_type, ds: (r.description || "").slice(0, 120), sh: r.show || null });

export const priceItemType = defineType({
  type: "price_item",
  prefix: "pi",
  v: 1,
  validate: validatePriceItem,
  rotorFields: ["rotor_template_ids"],
  techFields: ["id", "name", "category", "unit", "unit_cents", "service_type", "description", "active", "sellable"],
  readPerm: "quotes:read",
  shadow: false,
  indexes: [{ name: "pricebook", shard: (r) => (r.deleted_at ? null : ""), row: priceItemRow }],
  pointers: [{ kind: "rotor/template", keys: (r) => (Array.isArray(r.rotor_template_ids) ? r.rotor_template_ids.map(rotorKey).filter(Boolean) : []) }],
  summary: (r) => ({ id: r.id, name: r.name }),
  example: () => ({ key: "screens", name: "Screen Cleaning", category: "screens", service_type: "Residential Window Cleaning", unit: "screen", unit_cents: 500, description: "Screens hand-washed.", show: { qty: true, unit: true, description: true }, active: true, sellable: true, rotor_template_ids: [] }),
});

// ------------------------------------------------------------ discount_def

export function validateDiscountDef(data, { op } = {}) {
  const stored = op === "update";
  const type = enumValue(data && data.type, ["fixed", "percentage"], { field: "type", required: true, stored });
  return shape(data, {
    key: (v, f) => { if (!DEF_KEY_RE.test(String(v ?? ""))) throw new InputError("A short key like first_time.", f); return String(v); },
    name: (v, f) => str(v, { field: f, max: 80, required: true }),
    type: () => type,
    value: (v, f) => int(v, { field: f, min: 0, max: type === "percentage" ? 10000 : 100000000 }) ?? 0,
    default_scope: (v, f) => validateScope(v, f, { stored }),
    sellable: (v, f) => (v === undefined ? true : bool(v, { field: f })),
    active: (v, f) => (v === undefined ? true : bool(v, { field: f })),
    plan_only: (v, f) => enumValue(v, ["biannual", "quarterly", "monthly"], { field: f, stored }),
    stack_group: (v, f) => str(v, { field: f, max: 30 }) || undefined,
    offer: (v, f) => (v === undefined ? undefined : bool(v, { field: f }) || undefined),
    typed_amount: (v, f) => (v === undefined ? undefined : bool(v, { field: f }) || undefined),
    rotor_names: (v, f) => [...new Set(arr(v, (x, ff) => str(x, { field: ff, max: 80, required: true }), { field: f, max: 100 }))],
  });
}

export const discountRow = (r) => ({ k: r.key, nm: r.name, t: r.type, v: r.value, sc: r.default_scope || { type: "all" }, sell: r.sellable !== false, act: r.active !== false, po: r.plan_only || null, sg: r.stack_group || null, of: !!r.offer, ta: !!r.typed_amount });

export const discountDefType = defineType({
  type: "discount_def",
  prefix: "dd",
  v: 1,
  validate: validateDiscountDef,
  rotorFields: ["rotor_names"],
  techFields: ["id", "key", "name"],
  readPerm: "quotes:read",
  shadow: false,
  indexes: [{ name: "discounts", shard: (r) => (r.deleted_at ? null : ""), row: discountRow }],
  pointers: [{ kind: "discount-key", key: (r) => r.key }],
  summary: (r) => ({ id: r.id, key: r.key, name: r.name }),
  example: () => ({ key: "first_time", name: "First Time Customer", type: "fixed", value: 5000, default_scope: { type: "initial" }, sellable: true, rotor_names: ["First Time Customer"] }),
});

// ------------------------------------------------------------ quote

// "Q-18641" (Rotor's numbers and real ones after cutover) or "SQ-0001" (a
// shadow quote made while Rotor is in charge, §3.9).
export function numberLabel(r) {
  if (!r || !Number.isSafeInteger(r.number)) return "Q-?";
  return r.number_seq === "quote-shadow" ? `SQ-${String(r.number).padStart(4, "0")}` : `Q-${r.number}`;
}

function validateApproval(v, f) {
  if (v === undefined || v === null) return undefined;
  if (!isObj(v)) throw new InputError("Expected an approval.", f);
  return shape(v, {
    version_id: idOf("quote_version"),
    version_sha256: (x, ff) => (x === undefined || x === null || x === "" ? undefined : /^[0-9a-f]{64}$/.test(String(x)) ? String(x) : (() => { throw new InputError("That isn't a version hash.", ff); })()),
    option_id: (x, ff) => str(x, { field: ff, max: 40 }) || undefined,
    signature_id: idOf("file"),
    name_typed: (x, ff) => str(x, { field: ff, max: 120 }) || "",
    ip_hash: (x, ff) => str(x, { field: ff, max: 80 }) || undefined,
    ua: (x, ff) => str(x, { field: ff, max: 40 }) || undefined,
    at: isoOpt,
    method: (x, ff) => enumValue(x, APPROVAL_METHODS, { field: ff, stored: true }),
    by: (x, ff) => str(x, { field: ff, max: 80 }) || undefined,
    selected_line_ids: (x, ff) => arr(x, (y, yf) => str(y, { field: yf, max: 64 }), { field: ff, max: MAX_LINES }),
  }, { field: f });
}

export function validateQuote(data, { op } = {}) {
  const stored = op === "update";
  const out = shape(data, {
    number: (v, f) => int(v, { field: f, min: 1, max: 999999999, required: true }),
    number_seq: (v, f) => (v === undefined || v === null || v === "" ? undefined : enumValue(v, ["quote", "quote-shadow"], { field: f, stored })),
    number_label: (v, f) => str(v, { field: f, max: 20 }) || undefined,
    contact_id: (v, f) => { if (!isId(v, "contact")) throw new InputError("A quote is for a contact.", f); return v; },
    contact_name: (v, f) => str(v, { field: f, max: 120 }) || undefined,
    property_id: idOf("property"),
    deal_id: idOf("deal"),
    status: (v, f) => enumValue(v, QUOTE_STATUSES, { field: f, stored }) || "draft",
    options: (v, f) => arr(v, (o, of) => validateOption(o, of, { stored }), { field: f, max: MAX_OPTIONS }),
    selected_option_id: (v, f) => str(v, { field: f, max: 40 }) || undefined,
    agreement: (v, f) => validateAgreement(v, f),
    client_notes: (v, f) => str(v, { field: f, max: 4000, trim: false }) || "",
    internal_notes: (v, f) => str(v, { field: f, max: 4000, trim: false }) || "",
    photo_ids: fileIds,
    mockup_file_ids: fileIds,
    terms_version: (v, f) => str(v, { field: f, max: 40 }) || undefined,
    sent_at: isoOpt,
    sent_via: (v, f) => [...new Set(arr(v, (x, ff) => enumValue(x, SENT_VIA, { field: ff, required: true, stored }), { field: f, max: 4 }))],
    viewed_at: isoOpt,
    last_viewed_at: isoOpt,
    current_version_id: idOf("quote_version"),
    versions_n: (v, f) => int(v, { field: f, min: 0, max: 100000 }) ?? 0,
    approvals_count: (v, f) => int(v, { field: f, min: 0, max: 100000 }) ?? 0,
    approved_at: isoOpt,
    approval: validateApproval,
    changes_requested_at: isoOpt,
    change_message: (v, f) => str(v, { field: f, max: 2000, trim: false }) || undefined,
    declined_at: isoOpt,
    decline_reason: (v, f) => str(v, { field: f, max: 500 }) || undefined,
    converted_at: isoOpt,
    converted_to: (v, f) => {
      if (v === undefined || v === null) return undefined;
      if (!isObj(v)) throw new InputError("Expected what it became.", f);
      return { ...v, job_ids: arr(v.job_ids, (x, ff) => str(x, { field: ff, max: 40 }), { field: `${f}.job_ids`, max: 200 }) };
    },
    archived_at: isoOpt,
    archive_reason: (v, f) => enumValue(v, ARCHIVE_REASONS, { field: f, stored }),
    expires_on: dateOpt,
    sold_by: (v, f) => str(v, { field: f, max: 80 }) || undefined,
    services: (v, f) => [...new Set(arr(v, (x, ff) => str(x, { field: ff, max: 80 }), { field: f, max: 20 }).filter(Boolean))],
    offers: (v, f) => [...new Set(arr(v, (x, ff) => str(x, { field: ff, max: 40 }), { field: f, max: 10 }))],
  });
  if (!stored) {
    const recs = out.options.filter((o) => o.recommended);
    if (recs.length > 1) out.options = out.options.map((o) => ({ ...o, recommended: o.id === recs[0].id }));
    const ids = new Set();
    out.options.forEach((o, i) => { if (ids.has(o.id)) throw new InputError("Two options share an id.", `options.${i}.id`); ids.add(o.id); });
  }
  if (!out.number_label) out.number_label = numberLabel(out);
  return out;
}

const closedAt = (r) => r.converted_at || r.declined_at || r.archived_at || r.updated_at || r.created_at;
export const quoteShard = (r) => (r.deleted_at ? null : OPEN_STATUSES.includes(r.status) ? "open" : String(closedAt(r) || "2026").slice(0, 4));
const recOpt = (r) => (r.options || []).find((o) => o.id === r.selected_option_id) || (r.options || []).find((o) => o.recommended) || (r.options || [])[0] || null;

export const quoteRow = (r) => {
  const o = recOpt(r);
  return {
    n: r.number_label || numberLabel(r), c: r.contact_id, cn: r.contact_name || "", st: r.status,
    first: o && o.totals ? o.totals.first_cents : null, annual: o && o.totals && o.kind === "plan" ? o.totals.annual_cents : null,
    k: (r.options || []).map((x) => x.kind), sent: r.sent_at || null, viewed: r.viewed_at || null, exp: r.expires_on || null,
    by: r.sold_by || null, at: r.created_at, u: r.updated_at, im: r.import ? 1 : 0,
  };
};

export const quoteType = defineType({
  type: "quote",
  prefix: "qt",
  v: 1,
  validate: validateQuote,
  // §3.3's list (with the deal and property links the import maps)
  rotorFields: ["number", "status", "options", "client_notes", "internal_notes", "photo_ids", "sent_at", "viewed_at", "approved_at", "declined_at",
    "changes_requested_at", "change_message", "expires_on", "sold_by", "rotor"],
  techFields: ["id"],
  mirrored: true,
  readPerm: "quotes:read",
  indexes: [{ name: "quotes", shard: quoteShard, row: quoteRow }],
  rels: [
    { rel: "contact-quotes", parent: (r) => r.contact_id, sort: (r) => sortOf(r.created_at) },
    { rel: "deal-quotes", parent: (r) => r.deal_id || null, sort: (r) => sortOf(r.created_at) },
  ],
  pointers: [
    // a shadow quote's number is claimed under quote-shadow-no by nextNumber; Rotor's and real ones here
    { kind: "quote-no", key: (r) => (r.number_seq === "quote-shadow" || !Number.isSafeInteger(r.number) ? null : String(r.number)) },
    { kind: "rotor/quote", key: (r) => (r.rotor && r.rotor.quote_id ? rotorKey(r.rotor.quote_id) : null) },
  ],
  summary: (r) => ({ id: r.id, number: r.number_label || numberLabel(r), status: r.status }),
  example: () => ({
    number: 1, number_seq: "quote-shadow", contact_id: "ct_0000000000000000000a", contact_name: "Pat Example", status: "draft",
    options: [{ id: "op_a", name: "Exterior only", kind: "one_time", recommended: true, lines: [{ id: "ln_ext1", title: "Exterior Window Cleaning", qty_milli: 1000, unit_cents: 29500, engine_cents: 29500, scope: { type: "all" }, category: "windows_ext", unit: "flat", show: { qty: false, unit: false, description: true } }], discounts: [], totals: { first_cents: 29500, per_visit_cents: [29500], term_cents: 29500, annual_cents: 29500 } }],
    agreement: { require_card: false, deposit: { type: "none", value: 0 } }, client_notes: "", internal_notes: "", photo_ids: [], mockup_file_ids: [], sent_via: [], approvals_count: 0, versions_n: 0, services: ["Residential Window Cleaning"], offers: [],
  }),
});

// ------------------------------------------------------------ quote_version (frozen at every send)

export function validateVersion(data, { op } = {}) {
  const stored = op === "update";
  return shape(data, {
    quote_id: (v, f) => { if (!isId(v, "quote")) throw new InputError("A version belongs to a quote.", f); return v; },
    n: (v, f) => int(v, { field: f, min: 1, max: 100000, required: true }),
    options: (v, f) => arr(v, (o, of) => validateOption(o, of, { stored: true }), { field: f, max: MAX_OPTIONS }),
    agreement: (v, f) => validateAgreement(v, f),
    client_notes: (v, f) => str(v, { field: f, max: 4000, trim: false }) || "",
    terms_version: (v, f) => str(v, { field: f, max: 40 }) || "",
    terms_text: (v, f) => str(v, { field: f, max: 20000, trim: false }) || "",
    plan_agreements: (v, f) => { if (v !== undefined && v !== null && !isObj(v)) throw new InputError("Expected the plan agreements.", f); return v || {}; },
    expires_on: dateOpt,
    sha256: (v, f) => { if (!/^[0-9a-f]{64}$/.test(String(v ?? ""))) throw new InputError("A version needs its hash.", f); return v; },
    sent_at: (v, f) => isoTime(v, { field: f, required: true }),
    sent_via: (v, f) => [...new Set(arr(v, (x, ff) => enumValue(x, SENT_VIA, { field: ff, required: true, stored }), { field: f, max: 4 }))],
    photo_ids: fileIds,
    mockup_file_ids: fileIds,
    number_label: (v, f) => str(v, { field: f, max: 20 }) || undefined,
  });
}

export const quoteVersionType = defineType({
  type: "quote_version",
  prefix: "qv",
  v: 1,
  validate: validateVersion,
  rotorFields: [],
  techFields: ["id"],
  readPerm: "quotes:read",
  rels: [{ rel: "quote-versions", parent: (r) => r.quote_id, sort: (r) => String(r.n).padStart(6, "0") }],
  summary: (r) => ({ id: r.id, quote_id: r.quote_id, n: r.n }),
  example: () => ({ quote_id: "qt_0000000000000000000a", n: 1, options: [], agreement: { require_card: false, deposit: { type: "none", value: 0 } }, client_notes: "", terms_version: "t0", terms_text: "", plan_agreements: {}, sha256: "0".repeat(64), sent_at: "2026-11-17T15:00:00.000Z", sent_via: ["sms"], photo_ids: [], mockup_file_ids: [] }),
});

export const types = [priceItemType, discountDefType, quoteType, quoteVersionType];
