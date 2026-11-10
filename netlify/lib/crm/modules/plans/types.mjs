// Record types of the plans module (M3b): plan, agreement_template,
// agreement, season_install (design §3.3, §5.4). Each is a defineType()
// object with rotorFields, techFields and example() (§3.14).
//
// A plan exists only for recurring care and annual lights (§5.4); a
// one-time sale is a job. Imported One-Time containers with more than one
// job become a hidden plan of kind "one_time_series" (no index row).
//
// Validators keep unknown fields and a stored enum value this code does
// not know (§3.14 schema rules). Index rows use short keys and never hold
// notes or agreement text. Derived fields (contact_name, town,
// agreement_status, sale_value_cents) are never rotorFields.

import { defineType } from "../../core/registry.mjs";
import { isId } from "../../core/ids.mjs";
import { tsKey, isLocalDate } from "../../core/clock.mjs";
import { InputError } from "../../core/errors.mjs";
import { shape, str, enumValue, bool, arr, isoTime, int } from "../../core/validate.mjs";
import { lineTotal } from "../../core/money.mjs";
import { rotorKey } from "../contacts/display.mjs";

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const sortOf = (at) => tsKey(new Date(Date.parse(at) || 0));
const clean = (o) => { for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k]; return o; };

// ------------------------------------------------------------ vocabulary

export const PLAN_KINDS = Object.freeze(["recurring", "lights_annual", "one_time_series"]);
export const CATALOG_KEYS = Object.freeze(["biannual", "quarterly", "monthly", "lights_annual", "custom"]);
export const PLAN_STATUSES = Object.freeze(["draft", "pending", "active", "paused", "cancelling", "cancelled", "expired"]);
export const LIVE_PLAN = Object.freeze(["pending", "active", "paused", "cancelling"]);
export const PENDING_REASONS = Object.freeze(["signature", "card"]);
export const BILLING_MODES = Object.freeze(["barta_standard", "after_visit", "first_of_month"]);
export const ORDINAL_STATUSES = Object.freeze(["unscheduled", "scheduled", "completed", "skipped", "cancelled"]);
export const OPEN_ORDINAL = Object.freeze(["unscheduled", "scheduled"]);
export const CANCEL_REASONS = Object.freeze(["price", "moving", "service", "not_needed", "other"]);
export const INTERVALS = Object.freeze(["month", "year", "week", "day"]);
export const SCOPE_TYPES = Object.freeze(["all", "initial", "after_initial", "specific"]);
export const AGREEMENT_STATUSES = Object.freeze(["draft", "sent", "viewed", "signed", "declined", "void"]);
export const OPEN_AGREEMENT = Object.freeze(["draft", "sent", "viewed"]);
export const AGREEMENT_SOURCES = Object.freeze(["staff", "quote_approval", "import"]);
export const SIGN_METHODS = Object.freeze(["portal", "in_person"]);
export const SEASON_STATUSES = Object.freeze(["sold", "install_scheduled", "installed", "takedown_scheduled", "taken_down", "stored", "cancelled"]);
export const LIGHT_COLORS = Object.freeze(["warm_white", "red", "green"]);
export const MAX_LINES = 50;
export const MAX_ORDINALS = 240;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const KEY_RE = /^[a-z][a-z0-9_]{1,39}$/;

// ------------------------------------------------------------ shared field checks

const idOf = (type) => (v, f) => {
  if (v === undefined || v === null || v === "") return undefined;
  if (!isId(v, type)) throw new InputError("That id doesn't look right.", f);
  return v;
};
const isoOpt = (v, f) => isoTime(v, { field: f });
const strOpt = (max) => (v, f) => str(v, { field: f, max }) || undefined;
export const dateOpt = (v, f) => {
  if (v === undefined || v === null || v === "") return undefined;
  if (!isLocalDate(v)) throw new InputError("Use a date like 2026-11-17.", f);
  return v;
};
const monthOpt = (v, f) => {
  if (v === undefined || v === null || v === "") return undefined;
  if (!MONTH_RE.test(String(v))) throw new InputError("Use a month like 2027-04.", f);
  return v;
};
const ids = (type, max = 50) => (v, f) => [...new Set(arr(v, (x, ff) => {
  if (!isId(x, type)) throw new InputError("That id doesn't look right.", ff);
  return x;
}, { field: f, max }))];
const strList = (max, each = 120) => (v, f) => [...new Set(arr(v, (x, ff) => str(x, { field: ff, max: each }), { field: f, max }).filter(Boolean))];
const cents = (v, f, { min = 0, max = 100000000 } = {}) => int(v ?? 0, { field: f, min, max });

export function validateScope(v, f, { stored = false } = {}) {
  if (v === undefined || v === null) return { type: "all" };
  if (!isObj(v)) throw new InputError("Expected which visits it covers.", f);
  const type = enumValue(v.type, SCOPE_TYPES, { field: `${f}.type`, stored }) || "all";
  if (type !== "specific") return { ...v, type };
  const visits = arr(v.visits ?? v.selectedJobs, (x, ff) => int(x, { field: ff, min: 1, max: 120, required: true }), { field: `${f}.visits`, max: 120 });
  const out = { ...v, type, visits: [...new Set(visits)].sort((a, b) => a - b) };
  delete out.selectedJobs;
  return out;
}

// One plan line (the quotes module's Line shape, §5.3): integer cents and
// thousandths; total_cents is the override's cents, else qty × unit. The
// line id is kept verbatim (Rotor's join key, §10.2 row 19).
export function validatePlanLine(v, f, { stored = false } = {}) {
  if (!isObj(v)) throw new InputError("Expected a line.", f);
  const out = shape(v, {
    id: (x, ff) => {
      const s = str(x, { field: ff, max: 80 });
      if (!s) throw new InputError("A line needs an id.", ff);
      return s;
    },
    title: (x, ff) => str(x, { field: ff, max: 160, required: true }),
    description: (x, ff) => str(x, { field: ff, max: 1000 }) || undefined,
    qty_milli: (x, ff) => int(x ?? 1000, { field: ff, min: 0, max: 1000000000 }),
    unit_cents: (x, ff) => int(x ?? 0, { field: ff, min: -100000000, max: 100000000 }),
    scope: (x, ff) => validateScope(x, ff, { stored }),
    optional: (x, ff) => (x === undefined ? undefined : bool(x, { field: ff })),
    selected: (x, ff) => (x === undefined ? undefined : bool(x, { field: ff })),
    service_type: strOpt(120),
    category: strOpt(40),
    unit: strOpt(20),
    override: (x, ff) => {
      if (x === undefined || x === null) return undefined;
      if (!isObj(x)) throw new InputError("Expected a price override.", ff);
      return { ...x, cents: int(x.cents, { field: `${ff}.cents`, min: -100000000, max: 1000000000, required: true }), reason: str(x.reason, { field: `${ff}.reason`, max: 200 }) || "override" };
    },
  }, { field: f });
  out.total_cents = out.override ? out.override.cents : lineTotal({ unit_cents: out.unit_cents, qty_milli: out.qty_milli });
  return clean(out);
}

export function validatePlanDiscount(v, f, { stored = false } = {}) {
  if (!isObj(v)) throw new InputError("Expected a discount.", f);
  const type = enumValue(v.type, ["fixed", "percentage"], { field: `${f}.type`, required: true, stored });
  return clean({
    ...v,
    id: str(v.id, { field: `${f}.id`, max: 80 }) || undefined,
    name: str(v.name, { field: `${f}.name`, max: 120 }) || "Discount",
    type,
    value: int(v.value, { field: `${f}.value`, min: 0, max: type === "percentage" ? 10000 : 100000000, required: true }),
    scope: validateScope(v.scope, `${f}.scope`, { stored }),
  });
}

function validateFrequency(v, f, { stored = false } = {}) {
  if (!isObj(v)) throw new InputError("How often?", f);
  return { interval: enumValue(v.interval, INTERVALS, { field: `${f}.interval`, required: true, stored }), count: int(v.count, { field: `${f}.count`, min: 1, max: 52, required: true }) };
}

function validateTerm(v, f) {
  if (!isObj(v)) throw new InputError("Expected the plan's term.", f);
  return shape(v, {
    start_on: (x, ff) => { if (!isLocalDate(x)) throw new InputError("When does the plan start?", ff); return x; },
    initial_months: (x, ff) => int(x ?? 12, { field: ff, min: 1, max: 60 }),
    initial_end_on: dateOpt,
    current_term_n: (x, ff) => int(x ?? 1, { field: ff, min: 1, max: 1000 }),
    current_term_start: dateOpt,
    current_term_end: dateOpt,
    renews_every_months: (x, ff) => int(x ?? 12, { field: ff, min: 1, max: 60 }),
    auto_renew: (x, ff) => (x === undefined ? true : bool(x, { field: ff })),
    price_locked_until: dateOpt,
  }, { field: f });
}

function validateOrdinal(v, f, { stored = false } = {}) {
  if (!isObj(v)) throw new InputError("Expected a plan visit.", f);
  return clean(shape(v, {
    term: (x, ff) => int(x ?? 1, { field: ff, min: 1, max: 1000 }),
    n: (x, ff) => int(x, { field: ff, min: 1, max: 120, required: true }),
    k: (x, ff) => int(x, { field: ff, min: 1, max: 100000 }),
    target_month: (x, ff) => { if (!MONTH_RE.test(String(x || ""))) throw new InputError("Use a month like 2027-04.", ff); return x; },
    job_id: idOf("job"),
    status: (x, ff) => enumValue(x, ORDINAL_STATUSES, { field: ff, stored }) || "unscheduled",
    visit_date: dateOpt,
    completed_on: dateOpt,
    billed_invoice_id: idOf("invoice"),
    gen: (x, ff) => int(x ?? 0, { field: ff, min: 0, max: 1000 }),
  }, { field: f }));
}

// ------------------------------------------------------------ plan

export function validatePlan(data, { op } = {}) {
  const stored = op === "update";
  const out = shape(data, {
    contact_id: (v, f) => { if (!isId(v, "contact")) throw new InputError("A plan belongs to a contact.", f); return v; },
    contact_name: strOpt(120),
    property_id: idOf("property"),
    town: strOpt(80),
    quote_id: idOf("quote"),
    quote_version_id: idOf("quote_version"),
    option_id: strOpt(40),
    deal_id: idOf("deal"),
    kind: (v, f) => enumValue(v, PLAN_KINDS, { field: f, stored }) || "recurring",
    catalog_key: (v, f) => enumValue(v, CATALOG_KEYS, { field: f, stored }) || "custom",
    name: (v, f) => str(v, { field: f, max: 120 }) || "Care plan",
    frequency: (v, f) => validateFrequency(v || { interval: "month", count: 6 }, f, { stored }),
    visits_per_year: (v, f) => int(v ?? 1, { field: f, min: 1, max: 365 }),
    service_types: strList(20),
    lines: (v, f) => arr(v, (l, lf) => validatePlanLine(l, lf, { stored }), { field: f, max: MAX_LINES }),
    discounts: (v, f) => arr(v, (d, df) => validatePlanDiscount(d, df, { stored }), { field: f, max: 20 }),
    status: (v, f) => enumValue(v, PLAN_STATUSES, { field: f, stored }) || "pending",
    pending_reasons: (v, f) => [...new Set(arr(v, (x, ff) => enumValue(x, PENDING_REASONS, { field: ff, required: true, stored }), { field: f, max: 4 }))],
    term: (v, f) => validateTerm(v, f),
    billing: (v, f) => {
      const b = isObj(v) ? v : {};
      return { ...b, mode: enumValue(b.mode, BILLING_MODES, { field: `${f}.mode`, stored }) || "barta_standard", autopay: bool(b.autopay, { field: `${f}.autopay` }), card_required: bool(b.card_required, { field: `${f}.card_required` }) };
    },
    perks: (v, f) => {
      const p = isObj(v) ? v : {};
      return { ...p, touch_ups: bool(p.touch_ups, { field: `${f}.touch_ups` }), rain_guarantee_days: int(p.rain_guarantee_days ?? 0, { field: `${f}.rain_guarantee_days`, min: 0, max: 60 }), hard_water: bool(p.hard_water, { field: `${f}.hard_water` }) };
    },
    policy: (v, f) => {
      const p = isObj(v) ? v : {};
      return { ...p, early_cancel_clawback_cents: cents(p.early_cancel_clawback_cents, `${f}.early_cancel_clawback_cents`), notice_days: int(p.notice_days ?? 7, { field: `${f}.notice_days`, min: 0, max: 90 }), late_cancel_fee_cents: cents(p.late_cancel_fee_cents ?? 5000, `${f}.late_cancel_fee_cents`) };
    },
    ordinals: (v, f) => arr(v, (o, of) => validateOrdinal(o, of, { stored }), { field: f, max: MAX_ORDINALS }),
    cancelled_job_ids: ids("job", 200),
    agreement_id: idOf("agreement"),
    agreement_status: (v, f) => str(v, { field: f, max: 20 }) || "none",
    pause: (v, f) => {
      if (v === undefined || v === null) return undefined;
      if (!isObj(v)) throw new InputError("Expected the pause.", f);
      return { ...v, from: dateOpt(v.from, `${f}.from`), until: dateOpt(v.until, `${f}.until`), reason: str(v.reason, { field: `${f}.reason`, max: 300 }) || "", by: str(v.by, { field: `${f}.by`, max: 80 }) || "" };
    },
    pauses: (v) => (Array.isArray(v) ? v.slice(-20) : undefined),
    cancel: (v, f) => {
      if (v === undefined || v === null) return undefined;
      if (!isObj(v)) throw new InputError("Expected the cancellation.", f);
      return {
        ...v, requested_on: dateOpt(v.requested_on, `${f}.requested_on`), effective_on: dateOpt(v.effective_on, `${f}.effective_on`),
        reason: enumValue(v.reason, CANCEL_REASONS, { field: `${f}.reason`, stored: true }) || "other", note: str(v.note, { field: `${f}.note`, max: 500 }) || undefined,
        clawback_cents: cents(v.clawback_cents, `${f}.clawback_cents`), by: str(v.by, { field: `${f}.by`, max: 80 }) || "",
      };
    },
    renewal: (v) => (isObj(v) ? { ...v } : {}),
    sale_value_cents: (v, f) => cents(v, f, { min: -1000000000, max: 1000000000 }),
    sold_by: strOpt(80),
    origin: strOpt(20),
    activated_at: isoOpt,
    cancelled_at: isoOpt,
    expired_at: isoOpt,
    last_change: (v) => (isObj(v) ? { ...v } : undefined),
    season_install_ids: ids("season_install", 20),
  });
  if (out.status === "pending" && !out.pending_reasons.length) out.pending_reasons = ["signature"];
  if (out.status !== "pending") out.pending_reasons = [];
  return clean(out);
}

// The next plan visit worth showing in a row: the first open ordinal.
export const nextOrdinal = (r) => (r.ordinals || []).filter((o) => OPEN_ORDINAL.includes(o.status)).sort((a, b) => (a.target_month < b.target_month ? -1 : a.target_month > b.target_month ? 1 : a.k - b.k))[0] || null;
const missingJobs = (r) => (r.ordinals || []).filter((o) => o.term === ((r.term && r.term.current_term_n) || 1) && o.status === "unscheduled" && !o.job_id).length;
const firstDue = (r) => {
  const due = (r.ordinals || []).filter((o) => o.status === "unscheduled").map((o) => o.target_month).sort();
  return due[0] || null;
};

// ix/plans (recurring and lights plans; the hidden one_time_series is not listed).
export const planShard = (r) => (r.deleted_at || r.kind === "one_time_series" ? null : "");
export const planRow = (r) => {
  const nx = nextOrdinal(r);
  return {
    c: r.contact_id, cn: r.contact_name || "", nm: r.name, ck: r.catalog_key, k: r.kind, st: r.status, pr: r.pending_reasons || [],
    nx: nx ? nx.target_month : null, nxs: nx ? nx.status : null, due: firstDue(r), mj: missingJobs(r), ap: !!(r.billing && r.billing.autopay), cr: !!(r.billing && r.billing.card_required),
    ag: r.agreement_status || "none", te: (r.term && r.term.current_term_end) || null, eff: (r.cancel && r.cancel.effective_on) || null, pu: (r.pause && r.pause.until) || null,
    tw: r.town || null, sv: r.sale_value_cents || 0, cb: r.cancel && r.cancel.clawback_state === "to_bill" ? 1 : 0, im: r.import ? 1 : 0, at: r.created_at, u: r.updated_at,
  };
};

export const planType = defineType({
  type: "plan",
  prefix: "pl",
  v: 1,
  validate: validatePlan,
  // §3.3's list: the fields the import owns
  rotorFields: ["catalog_key", "frequency", "lines", "discounts", "status", "term", "billing", "ordinals", "cancel", "sold_by", "rotor"],
  techFields: ["id"],
  mirrored: true,
  readPerm: "plans:read",
  indexes: [{ name: "plans", shard: planShard, row: planRow }],
  rels: [{ rel: "contact-plans", parent: (r) => r.contact_id, sort: (r) => sortOf(r.created_at) }],
  pointers: [{ kind: "rotor/plan", key: (r) => (r.rotor && r.rotor.service_plan_id ? rotorKey(r.rotor.service_plan_id) : null) }],
  summary: (r) => ({ id: r.id, name: r.name, status: r.status }),
  example: () => ({
    contact_id: "ct_0000000000000000000a", contact_name: "Pat Example", kind: "recurring", catalog_key: "quarterly", name: "Quarterly plan",
    frequency: { interval: "month", count: 3 }, visits_per_year: 4, service_types: ["Residential Window Cleaning"],
    lines: [{ id: "ln_ext1", title: "Exterior Window Cleaning", qty_milli: 1000, unit_cents: 29500, scope: { type: "specific", visits: [1, 3, 4] } }],
    discounts: [{ id: "dc_plan", name: "Quarterly plan discount", type: "fixed", value: 10000, scope: { type: "all" } }],
    status: "pending", pending_reasons: ["signature"],
    term: { start_on: "2026-11-17", initial_months: 12, initial_end_on: "2027-11-16", current_term_n: 1, current_term_start: "2026-11-17", current_term_end: "2027-11-16", renews_every_months: 3, auto_renew: true, price_locked_until: "2027-11-16" },
    billing: { mode: "barta_standard", autopay: true, card_required: true }, perks: { touch_ups: true, rain_guarantee_days: 7, hard_water: true },
    policy: { early_cancel_clawback_cents: 10000, notice_days: 7, late_cancel_fee_cents: 5000 },
    ordinals: [{ term: 1, n: 1, k: 1, target_month: "2026-11", status: "unscheduled" }], renewal: {}, sale_value_cents: 19500, origin: "staff",
  }),
});

// ------------------------------------------------------------ agreement_template

export function validateAgreementTemplate(data, { op } = {}) {
  const stored = op === "update";
  return clean(shape(data, {
    key: (v, f) => { const s = str(v, { field: f, max: 40 }); if (!KEY_RE.test(s)) throw new InputError("A short key like quarterly.", f); return s; },
    name: (v, f) => str(v, { field: f, max: 120, required: true }),
    applies_to: (v, f) => {
      const a = isObj(v) ? v : {};
      return { ...a, catalog_keys: [...new Set(arr(a.catalog_keys, (x, ff) => enumValue(x, CATALOG_KEYS, { field: ff, required: true, stored }), { field: `${f}.catalog_keys`, max: 10 }))], service_types: strList(10)(a.service_types, `${f}.service_types`) };
    },
    body_md: (v, f) => str(v, { field: f, max: 40000, trim: false, required: true }),
    version: (v, f) => int(v ?? 1, { field: f, min: 1, max: 100000 }),
    approved_version: (v, f) => int(v, { field: f, min: 1, max: 100000 }),
    approved_at: isoOpt,
    approved_by: strOpt(80),
    active: (v, f) => (v === undefined ? true : bool(v, { field: f })),
    seeded: (v, f) => (v === undefined ? undefined : bool(v, { field: f })),
  }));
}
export const templateApproved = (t) => !!t && t.active !== false && Number.isSafeInteger(t.approved_version) && t.approved_version === t.version;
export const agreementTemplateRow = (r) => ({ k: r.key, nm: r.name, v: r.version || 1, ap: templateApproved(r), act: r.active !== false, ck: (r.applies_to && r.applies_to.catalog_keys) || [], u: r.updated_at });

export const agreementTemplateType = defineType({
  type: "agreement_template",
  prefix: "at",
  v: 1,
  validate: validateAgreementTemplate,
  rotorFields: ["rotor"],
  techFields: ["id"],
  readPerm: "plans:read",
  shadow: false,
  indexes: [{ name: "agreement-templates", shard: (r) => (r.deleted_at ? null : ""), row: agreementTemplateRow }],
  pointers: [{ kind: "rotor/agreement-template", key: (r) => (r.rotor && r.rotor.template_id ? rotorKey(r.rotor.template_id) : null) }],
  summary: (r) => ({ id: r.id, key: r.key, name: r.name }),
  example: () => ({ key: "sample_terms", name: "Sample agreement", applies_to: { catalog_keys: ["custom"], service_types: [] }, body_md: "## Scheduling\n\nWe come out {{visits_per_year}} times a year.", version: 1, active: true }),
});

// ------------------------------------------------------------ agreement

function validateSignature(v, f) {
  if (v === undefined || v === null) return undefined;
  if (!isObj(v)) throw new InputError("Expected the signature.", f);
  return clean({
    ...v,
    name_typed: str(v.name_typed, { field: `${f}.name_typed`, max: 120 }) || "",
    drawn_file_id: idOf("file")(v.drawn_file_id, `${f}.drawn_file_id`),
    agreed_checkbox: v.agreed_checkbox === true,
    at: isoOpt(v.at, `${f}.at`),
    ip_hash: str(v.ip_hash, { field: `${f}.ip_hash`, max: 80 }) || undefined,
    user_agent: str(v.user_agent, { field: `${f}.user_agent`, max: 60 }) || undefined,
    method: enumValue(v.method, SIGN_METHODS, { field: `${f}.method`, stored: true }) || "portal",
    staff_user_id: idOf("user")(v.staff_user_id, `${f}.staff_user_id`),
  });
}

export function validateAgreement(data, { op } = {}) {
  const stored = op === "update";
  return clean(shape(data, {
    contact_id: (v, f) => { if (!isId(v, "contact")) throw new InputError("An agreement is with a contact.", f); return v; },
    contact_name: strOpt(120),
    plan_id: idOf("plan"),
    quote_id: idOf("quote"),
    quote_version_id: idOf("quote_version"),
    template_id: idOf("agreement_template"),
    template_key: strOpt(40),
    template_version: (v, f) => int(v ?? 1, { field: f, min: 1, max: 100000 }),
    title: (v, f) => str(v, { field: f, max: 160 }) || "Service agreement",
    body_rendered: (v, f) => str(v, { field: f, max: 60000, trim: false }) || "",
    body_sha256: (v, f) => { const s = str(v, { field: f, max: 64 }); if (s && !/^[0-9a-f]{64}$/.test(s)) throw new InputError("A SHA-256 in hex.", f); return s || undefined; },
    status: (v, f) => enumValue(v, AGREEMENT_STATUSES, { field: f, stored }) || "draft",
    sent_at: isoOpt,
    sent_via: (v, f) => [...new Set(arr(v, (x, ff) => str(x, { field: ff, max: 10 }), { field: f, max: 4 }))],
    viewed_at: isoOpt,
    signed_at: isoOpt,
    signed_wv: (v, f) => int(v, { field: f, min: 1, max: Number.MAX_SAFE_INTEGER }),
    voided_at: isoOpt,
    void_reason: strOpt(300),
    signature: validateSignature,
    source: (v, f) => enumValue(v, AGREEMENT_SOURCES, { field: f, stored }) || "staff",
    reminders: (v) => (isObj(v) ? { count: Number.isSafeInteger(v.count) ? v.count : 0, ...(v.last_at ? { last_at: v.last_at } : {}) } : { count: 0 }),
    imported: (v) => (isObj(v) ? { ...v } : undefined),
    template_approved: (v, f) => (v === undefined ? undefined : bool(v, { field: f })),
  }));
}

export const agreementShard = (r) => (r.deleted_at || !OPEN_AGREEMENT.includes(r.status) ? null : "pending");
export const agreementRow = (r) => ({ c: r.contact_id, cn: r.contact_name || "", pl: r.plan_id || null, st: r.status, sent: r.sent_at || null, vw: r.viewed_at || null, rc: (r.reminders && r.reminders.count) || 0, tk: r.template_key || null, t: r.title, at: r.created_at, u: r.updated_at });

export const agreementType = defineType({
  type: "agreement",
  prefix: "ag",
  v: 1,
  validate: validateAgreement,
  rotorFields: ["rotor"],
  techFields: ["id"],
  mirrored: true,
  readPerm: "plans:read",
  indexes: [{ name: "agreements", shard: agreementShard, row: agreementRow }],
  rels: [
    { rel: "contact-agreements", parent: (r) => r.contact_id, sort: (r) => sortOf(r.created_at) },
    { rel: "plan-agreements", parent: (r) => r.plan_id || null, sort: (r) => sortOf(r.created_at) },
  ],
  summary: (r) => ({ id: r.id, title: r.title, status: r.status }),
  example: () => ({ contact_id: "ct_0000000000000000000a", contact_name: "Pat Example", template_key: "quarterly", template_version: 1, title: "Quarterly plan agreement", body_rendered: "## Scheduling\n\nWe come out 4 times a year.", body_sha256: "0".repeat(64), status: "draft", source: "staff", reminders: { count: 0 } }),
});

// ------------------------------------------------------------ season_install

export function validateSeason(data, { op } = {}) {
  const stored = op === "update";
  return clean(shape(data, {
    contact_id: (v, f) => { if (!isId(v, "contact")) throw new InputError("A lights season is for a contact.", f); return v; },
    contact_name: strOpt(120),
    property_id: idOf("property"),
    town: strOpt(80),
    season: (v, f) => int(v, { field: f, min: 2020, max: 2100, required: true }),
    plan_id: idOf("plan"),
    quote_id: idOf("quote"),
    status: (v, f) => enumValue(v, SEASON_STATUSES, { field: f, stored }) || "sold",
    install_job_id: idOf("job"),
    takedown_job_id: idOf("job"),
    warranty_job_ids: ids("job", 20),
    footage_ft: (v, f) => int(v ?? 0, { field: f, min: 0, max: 100000 }),
    colors: (v, f) => [...new Set(arr(v, (x, ff) => enumValue(x, LIGHT_COLORS, { field: ff, required: true, stored }), { field: f, max: 6 }))],
    bin_id: (v, f) => str(v, { field: f, max: 40 }) || undefined,
    design_file_ids: ids("file", 20),
    early_bird: (v, f) => bool(v, { field: f }),
    deadline_used: dateOpt,
    three_year: (v, f) => bool(v, { field: f }),
    contract_season_n: (v, f) => (v === undefined || v === null ? undefined : int(v, { field: f, min: 1, max: 3 })),
    notes: (v, f) => str(v, { field: f, max: 2000, trim: false }) || undefined,
    installed_on: dateOpt,
    taken_down_on: dateOpt,
    stored_on: dateOpt,
  }));
}

export const seasonKey = (r) => `${keyPart(r.property_id || `c-${r.contact_id}`)}--${r.season}`;
const keyPart = (s) => String(s).toLowerCase().replace(/[^a-z0-9_-]/g, "-");
export const seasonRow = (r) => ({ c: r.contact_id, cn: r.contact_name || "", pr: r.property_id || null, tw: r.town || null, st: r.status, ft: r.footage_ft || 0, bin: r.bin_id || null, col: r.colors || [], ij: r.install_job_id || null, tj: r.takedown_job_id || null, pl: r.plan_id || null, ty: !!r.three_year, cn3: r.contract_season_n || null, im: r.import ? 1 : 0, u: r.updated_at });

export const seasonInstallType = defineType({
  type: "season_install",
  prefix: "si",
  v: 1,
  validate: validateSeason,
  rotorFields: ["season", "status", "footage_ft", "rotor"],
  techFields: ["id"],
  readPerm: "plans:read",
  indexes: [{ name: "lights", shard: (r) => (r.deleted_at ? null : String(r.season)), row: seasonRow }],
  rels: [
    { rel: "property-seasons", parent: (r) => r.property_id || null, sort: (r) => String(r.season) },
    { rel: "contact-seasons", parent: (r) => r.contact_id, sort: (r) => String(r.season) },
  ],
  pointers: [
    { kind: "season", key: (r) => seasonKey(r) },
    { kind: "season-job", keys: (r) => [r.install_job_id, r.takedown_job_id].filter((x) => isId(x, "job")) },
  ],
  summary: (r) => ({ id: r.id, season: r.season, status: r.status }),
  example: () => ({ contact_id: "ct_0000000000000000000a", contact_name: "Pat Example", property_id: "pr_0000000000000000000a", season: 2026, status: "sold", warranty_job_ids: [], footage_ft: 120, colors: ["warm_white"], design_file_ids: [], early_bird: true, three_year: false }),
});

export const types = [planType, agreementTemplateType, agreementType, seasonInstallType];
