// Record types of the money module: invoice, payment, credit, autopay_run
// (design §3.3, §5.6). Each is a defineType() object with rotorFields,
// techFields and example() (§3.14).
//
// Every amount is integer cents. An invoice's derived money (paid,
// refunded, tips, balance, excess, status open/paid) is recomputed by the
// pure mutator (balance.mjs derive) on EVERY write, from its `applied` map,
// so a CAS retry always starts from the current map and two payments racing
// on one invoice both land. Derived fields are never rotorFields.
//
// Validators keep unknown fields and a stored enum value this code does not
// know (§3.14 schema rules). Index rows use short keys and never hold notes,
// references or anything a person typed.

import { defineType } from "../../core/registry.mjs";
import { isId } from "../../core/ids.mjs";
import { tsKey, isLocalDate, nowIso } from "../../core/clock.mjs";
import { InputError } from "../../core/errors.mjs";
import { shape, str, enumValue, bool, arr, isoTime, int } from "../../core/validate.mjs";
import { lineTotal } from "../../core/money.mjs";
import { rotorKey } from "../contacts/display.mjs";
import {
  INVOICE_KINDS, INVOICE_STATUSES, LINE_KINDS, PAY_STATUSES, totalsOf, derive, isProcessing, isPartiallyPaid, autopayFailed,
} from "./balance.mjs";

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const sortOf = (at) => tsKey(new Date(Date.parse(at) || 0));
const clean = (o) => { for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k]; return o; };
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export const METHODS = Object.freeze(["card", "ach", "cash", "check", "other", "credit", "imported"]);
export const PAYMENT_KINDS = Object.freeze(["payment", "refund"]);
export const CREDIT_KINDS = Object.freeze(["referral", "gift_card", "goodwill", "overpayment", "imported", "applied"]);
export const CREDIT_STATUSES = Object.freeze(["available", "held", "applied", "settled"]);
export const SEQS = Object.freeze(["invoice", "invoice-shadow", "deposit", "deposit-shadow", "imported"]);
export const ITEM_RESULTS = Object.freeze(["pending", "processing", "succeeded", "failed", "unknown", "skipped_no_card", "skipped_paused", "would_charge", "invoice_only", "nothing_due"]);
export const MAX_LINES = 60;

const idOf = (type) => (v, f) => {
  if (v === undefined || v === null || v === "") return undefined;
  if (!isId(v, type)) throw new InputError("That id doesn't look right.", f);
  return v;
};
const requiredId = (type, msg) => (v, f) => { if (!isId(v, type)) throw new InputError(msg, f); return v; };
const ids = (type, max = 50) => (v, f) => [...new Set(arr(v, (x, ff) => { if (!isId(x, type)) throw new InputError("That id doesn't look right.", ff); return x; }, { field: f, max }))];
const isoOpt = (v, f) => isoTime(v, { field: f });
const strOpt = (max) => (v, f) => str(v, { field: f, max }) || undefined;
const dateOpt = (v, f) => {
  if (v === undefined || v === null || v === "") return undefined;
  if (!isLocalDate(v)) throw new InputError("Use a date like 2026-11-17.", f);
  return v;
};
const cents = (min = -100000000, max = 100000000) => (v, f) => int(v ?? 0, { field: f, min, max });

// A reference (a check number): digit runs of 8 or more are masked to their
// last 4 (bank routing and account numbers people type from a check, R24).
export const maskReference = (s) => String(s ?? "").replace(/\d{8,}/g, (d) => "••••" + d.slice(-4)).slice(0, 80);

// ------------------------------------------------------------ invoice

export function validateLine(v, f, { stored = false } = {}) {
  if (!isObj(v)) throw new InputError("Expected a line.", f);
  const out = shape(v, {
    id: (x, ff) => { const s = str(x, { field: ff, max: 80 }); if (!s) throw new InputError("A line needs an id.", ff); return s; },
    kind: (x, ff) => enumValue(x, LINE_KINDS, { field: ff, stored }) || "service",
    description: (x, ff) => str(x, { field: ff, max: 300, required: true }),
    qty_milli: (x, ff) => int(x ?? 1000, { field: ff, min: 0, max: 1000000000 }),
    unit_cents: (x, ff) => int(x ?? 0, { field: ff, min: -100000000, max: 100000000 }),
    total_cents: (x, ff) => int(x, { field: ff, min: -1000000000, max: 1000000000 }),
    job_id: idOf("job"),
    ref_id: (x, ff) => (x === undefined || x === null || x === "" ? undefined : str(x, { field: ff, max: 80 })),
  }, { field: f });
  if (out.total_cents === undefined) out.total_cents = lineTotal({ unit_cents: out.unit_cents, qty_milli: out.qty_milli });
  // discounts and credits always take money off
  if (["discount", "credit", "deposit_credit"].includes(out.kind) && out.total_cents > 0) out.total_cents = -out.total_cents;
  return clean(out);
}

function validateApplied(v, f) {
  if (v === undefined || v === null) return {};
  if (!isObj(v)) throw new InputError("Expected the payments on the invoice.", f);
  const out = {};
  for (const [pid, e] of Object.entries(v)) {
    if (!isId(pid, "payment") || !isObj(e)) throw new InputError("That payment entry doesn't look right.", `${f}.${pid}`);
    out[pid] = clean({
      kind: enumValue(e.kind, PAYMENT_KINDS, { field: `${f}.${pid}.kind`, required: true, stored: true }),
      amount_cents: int(e.amount_cents ?? 0, { field: `${f}.${pid}.amount_cents`, min: 0, max: 100000000 }),
      tip_cents: int(e.tip_cents ?? 0, { field: `${f}.${pid}.tip_cents`, min: 0, max: 100000000 }),
      status: enumValue(e.status, PAY_STATUSES, { field: `${f}.${pid}.status`, required: true, stored: true }),
      simulated: e.simulated === true ? true : undefined,
      at: isoTime(e.at, { field: `${f}.${pid}.at` }) || undefined,
    });
  }
  return out;
}

function validateAutopay(v) {
  const a = isObj(v) ? v : {};
  return clean({
    ...a, eligible: a.eligible === true,
    attempts: Array.isArray(a.attempts) ? a.attempts.slice(-20).map((x) => (isObj(x) ? { ...x } : {})) : [],
    next_attempt_at: typeof a.next_attempt_at === "string" && !Number.isNaN(Date.parse(a.next_attempt_at)) ? new Date(a.next_attempt_at).toISOString() : undefined,
  });
}

// Where a payment started: "qr" = the customer scanned the pay code (scan.mjs).
export const VIAS = Object.freeze(["qr"]);
function validateQr(v) {
  if (!isObj(v)) return undefined;
  const n = (x) => (Number.isSafeInteger(x) && x >= 0 ? Math.min(x, 100000) : 0);
  const at = (x) => (typeof x === "string" && !Number.isNaN(Date.parse(x)) ? new Date(x).toISOString() : undefined);
  return clean({
    shown: n(v.shown), last_shown_at: at(v.last_shown_at), last_shown_by: typeof v.last_shown_by === "string" && v.last_shown_by ? v.last_shown_by.slice(0, 80) : undefined,
    opened: n(v.opened), first_opened_at: at(v.first_opened_at), last_opened_at: at(v.last_opened_at),
  });
}

export function validateInvoice(data, { op } = {}) {
  const stored = op === "update";
  const out = shape(data, {
    number: (v, f) => str(v, { field: f, max: 24, required: true }),
    seq: (v, f) => enumValue(v, SEQS, { field: f, stored }) || "invoice-shadow",
    n: (v, f) => int(v, { field: f, min: 0, max: 999999999 }),
    kind: (v, f) => enumValue(v, INVOICE_KINDS, { field: f, stored }) || "standard",
    contact_id: requiredId("contact", "An invoice belongs to a contact."),
    contact_name: strOpt(120),
    property_id: idOf("property"),
    job_ids: ids("job", 20),
    plan_id: idOf("plan"),
    plan_month: (v, f) => { if (v === undefined || v === null || v === "") return undefined; if (!MONTH_RE.test(String(v))) throw new InputError("Use a month like 2027-01.", f); return v; },
    plan_ordinals: (v) => (Array.isArray(v) ? v.slice(0, 24).map((o) => ({ term: int(o && o.term, { min: 1, max: 1000 }) || 1, n: int(o && o.n, { min: 1, max: 120 }) || 1 })) : undefined),
    quote_id: idOf("quote"),
    deposit_of: idOf("quote"),
    lines: (v, f) => arr(v, (l, lf) => validateLine(l, lf, { stored }), { field: f, max: MAX_LINES }),
    applied: (v, f) => validateApplied(v, f),
    status: (v, f) => enumValue(v, INVOICE_STATUSES, { field: f, stored }) || "draft",
    issued_on: dateOpt,
    due_on: dateOpt,
    sent_at: isoOpt,
    sent_via: (v, f) => [...new Set(arr(v, (x, ff) => enumValue(x, ["sms", "email"], { field: ff, required: true, stored: true }), { field: f, max: 4 }))],
    viewed_at: isoOpt,
    paid_at: isoOpt,
    voided_at: isoOpt,
    void_reason: strOpt(300),
    written_off_at: isoOpt,
    charging: (v, f) => {
      if (v === undefined || v === null) return undefined;
      if (!isObj(v) || typeof v.attempt_id !== "string") throw new InputError("Expected the charge in flight.", f);
      return { by: String(v.by || "").slice(0, 80), until: isoTime(v.until, { field: `${f}.until`, required: true }), attempt_id: v.attempt_id.slice(0, 40), n: int(v.n, { min: 1, max: 1000 }) || 1 };
    },
    charge_n: (v, f) => int(v ?? 0, { field: f, min: 0, max: 1000 }),
    checkout_sessions: (v) => (Array.isArray(v) ? v.slice(-20).filter(isObj).map((s) => clean({
      id: String(s.id || "").slice(0, 200), expires_at: s.expires_at, status: ["open", "complete", "expired"].includes(s.status) ? s.status : "open",
      amount_cents: Number.isSafeInteger(s.amount_cents) ? s.amount_cents : undefined, tip_cents: Number.isSafeInteger(s.tip_cents) ? s.tip_cents : undefined,
      save_card: s.save_card === true ? true : undefined, created_at: s.created_at, dry: s.dry === true ? true : undefined,
      via: VIAS.includes(s.via) ? s.via : undefined,
    })) : []),
    // scan to pay (scan.mjs): how often the office showed the pay code, and when the customer's phone opened it
    qr: (v) => validateQr(v),
    autopay: (v) => validateAutopay(v),
    reminders: (v) => { const r = isObj(v) ? v : {}; return clean({ count: int(r.count ?? 0, { min: 0, max: 100 }) || 0, last_at: typeof r.last_at === "string" ? r.last_at : undefined }); },
    customer_note: (v, f) => str(v, { field: f, max: 1000, trim: false }) || undefined,
    office_note: (v, f) => str(v, { field: f, max: 2000, trim: false }) || undefined,
    origin: strOpt(30),
  });
  const t = totalsOf(out.lines);
  Object.assign(out, t);
  // Rotor's total is authoritative for an imported invoice whose lines don't add up (§10.2 row 27)
  if (out.rotor && Number.isSafeInteger(out.rotor.total_cents_raw) && out.rotor.total_cents_raw !== t.total_cents) out.total_cents = out.rotor.total_cents_raw;
  // an imported invoice was paid when Rotor says it was
  return clean(derive(out, { at: (out.rotor && typeof out.rotor.paid_at === "string" && out.rotor.paid_at) || nowIso() }));
}

// ix/invoices/open (drafts and open ones) and ix/invoices/{yyyy} (paid, void,
// written off: by the year they closed).
export function invoiceShard(r) {
  if (["draft", "open"].includes(r.status)) return "open";
  // an overpayment nobody has decided on yet keeps its invoice in sight (refund it, or keep it as credit)
  if ((r.excess_cents || 0) > 0 && !r.excess_kept) return "open";
  const at = r.paid_at || r.voided_at || r.written_off_at || r.issued_on || r.updated_at || r.created_at || "";
  const y = String(at).slice(0, 4);
  return /^\d{4}$/.test(y) ? y : "open";
}
export const invoiceRow = (r) => ({
  n: r.number, c: r.contact_id, cn: r.contact_name || "", k: r.kind, st: r.status, tot: r.total_cents || 0, paid: (r.paid_cents || 0) - (r.refunded_cents || 0), bal: r.balance_cents || 0,
  ex: r.excess_cents || 0, xk: r.excess_kept ? 1 : 0, tip: r.tips_cents || 0, due: r.due_on || null, iss: r.issued_on || null, pp: isPartiallyPaid(r) ? 1 : 0, pr: isProcessing(r) ? 1 : 0, af: autopayFailed(r) ? 1 : 0,
  ch: r.charging ? r.charging.until : null, pl: r.plan_id || null, pm: r.plan_month || null, j: (r.job_ids || [])[0] || null, sent: r.sent_at || null, rm: (r.reminders && r.reminders.count) || 0,
  sim: Object.values(r.applied || {}).some((e) => e && e.simulated) ? 1 : 0, im: r.import ? 1 : 0, sh: r.shadow ? 1 : 0, rs: (r.rotor && r.rotor.status_raw) || null,
  ap: r.autopay && r.autopay.eligible ? 1 : 0, at: r.created_at, u: r.updated_at,
});

// The number pointer every invoice shares with the sequence (nextNumber
// claims ptr/{seq}-no/{n} for the invoice it numbers): search finds INV-0610
// and D-0001 through them (§9.1).
const numberKey = (r) => (["invoice", "invoice-shadow", "deposit", "deposit-shadow"].includes(r.seq) && Number.isSafeInteger(r.n) && r.n > 0 ? String(r.n) : null);

export const invoiceType = defineType({
  type: "invoice",
  prefix: "in",
  v: 1,
  validate: validateInvoice,
  // §3.3's list: the fields the import owns
  rotorFields: ["number", "kind", "lines", "subtotal_cents", "discount_cents", "credit_cents", "total_cents", "issued_on", "due_on", "sent_at", "voided_at", "rotor"],
  // a tech sees only the number, the status and what's left to pay (§4.6)
  techFields: ["id", "number", "status", "balance_cents"],
  mirrored: true,
  readPerm: "invoices:read_all",
  indexes: [{ name: "invoices", shard: (r) => (r.deleted_at ? null : invoiceShard(r)), row: invoiceRow }],
  rels: [
    { rel: "contact-invoices", parent: (r) => r.contact_id, sort: (r) => sortOf(r.created_at), value: (r) => ({ s: r.status, b: r.balance_cents || 0, t: r.total_cents || 0 }) },
    { rel: "job-invoices", parent: (r) => (r.job_ids || [])[0] || null, sort: (r) => sortOf(r.created_at) },
    { rel: "plan-invoices", parent: (r) => r.plan_id || null, sort: (r) => sortOf(r.created_at) },
  ],
  pointers: [
    { kind: "invoice-no", key: (r) => (r.seq === "invoice" ? numberKey(r) : null) },
    { kind: "invoice-shadow-no", key: (r) => (r.seq === "invoice-shadow" ? numberKey(r) : null) },
    { kind: "deposit-no", key: (r) => (r.seq === "deposit" ? numberKey(r) : null) },
    { kind: "deposit-shadow-no", key: (r) => (r.seq === "deposit-shadow" ? numberKey(r) : null) },
    { kind: "rotor/invoice", key: (r) => (r.rotor && r.rotor.invoice_id ? rotorKey(r.rotor.invoice_id) : null) },
  ],
  summary: (r) => ({ id: r.id, number: r.number, status: r.status, balance_cents: r.balance_cents }),
  example: () => ({
    number: "SINV-0001", seq: "invoice-shadow", n: 1, kind: "standard", contact_id: "ct_0000000000000000000a", contact_name: "Pat Example", job_ids: [],
    lines: [{ id: "l1", kind: "service", description: "Exterior window cleaning", qty_milli: 1000, unit_cents: 29500 }], applied: {}, status: "open", issued_on: "2026-11-17", due_on: "2026-11-17",
    sent_via: [], checkout_sessions: [], autopay: { eligible: false, attempts: [] }, reminders: { count: 0 },
  }),
});

// ------------------------------------------------------------ payment

export function validatePayment(data, { op } = {}) {
  const stored = op === "update";
  const out = shape(data, {
    contact_id: requiredId("contact", "A payment belongs to a contact."),
    contact_name: strOpt(120),
    invoice_id: idOf("invoice"),
    invoice_number: strOpt(24),
    job_id: idOf("job"),
    plan_id: idOf("plan"),
    kind: (v, f) => enumValue(v, PAYMENT_KINDS, { field: f, stored }) || "payment",
    method: (v, f) => enumValue(v, METHODS, { field: f, required: true, stored }),
    status: (v, f) => enumValue(v, PAY_STATUSES, { field: f, stored }) || "succeeded",
    amount_cents: cents(0, 100000000),
    tip_cents: cents(0, 100000000),
    fee_cents: cents(0, 10000000),
    refunded_cents: cents(0, 200000000),
    refunded_tip_cents: cents(0, 100000000),
    received_on: (v, f) => { if (!isLocalDate(v)) throw new InputError("When was it paid?", f); return v; },
    reference: (v, f) => (v === undefined || v === null || v === "" ? undefined : maskReference(str(v, { field: f, max: 200 }))),
    refund_of: idOf("payment"),
    refund_reason: strOpt(300),
    refunds: (v) => (Array.isArray(v) ? v.slice(-30).filter(isObj).map((x) => clean({ request_id: String(x.request_id || "").slice(0, 80), amount_cents: int(x.amount_cents, { min: 0, max: 200000000 }) || 0, tip_cents: int(x.tip_cents ?? 0, { min: 0, max: 100000000 }) || 0, status: ["reserved", "done", "failed"].includes(x.status) ? x.status : "reserved", refund_id: x.refund_id ? String(x.refund_id).slice(0, 40) : undefined, at: x.at })) : []),
    tip_split: (v, f) => arr(v, (x, ff) => {
      if (!isObj(x) || !isId(x.user_id, "user")) throw new InputError("Tips go to people on the team.", ff);
      return { user_id: x.user_id, cents: int(x.cents, { field: `${ff}.cents`, min: 0, max: 100000000, required: true }) };
    }, { field: f, max: 10 }),
    stripe: (v) => (isObj(v) ? clean({ ...v }) : undefined),
    card: (v) => (isObj(v) ? clean({ brand: v.brand ? String(v.brand).slice(0, 20) : undefined, last4: /^\d{4}$/.test(String(v.last4 || "")) ? String(v.last4) : undefined, kind: v.kind === "us_bank_account" ? "us_bank_account" : v.kind ? "card" : undefined }) : undefined),
    failure_code: strOpt(60),
    simulated: (v) => (v === true ? true : undefined),
    via: (v) => (VIAS.includes(v) ? v : undefined),
    recorded_by: (v, f) => str(v, { field: f, max: 80 }) || "system",
    note: (v, f) => str(v, { field: f, max: 500, trim: false }) || undefined,
  });
  out.total_cents = (out.amount_cents || 0) + (out.tip_cents || 0);
  if (out.kind === "refund") { out.refunded_cents = 0; out.refunds = []; }
  if (out.refunded_cents > out.total_cents) throw new InputError("A refund can't pass what was paid.", "refunded_cents");
  if (Array.isArray(out.tip_split) && out.tip_split.length && out.tip_split.reduce((s, x) => s + x.cents, 0) !== (out.tip_cents || 0) && out.kind === "payment") {
    throw new InputError("The tip split must add up to the tip.", "tip_split");
  }
  return clean(out);
}

export const paymentShard = (r) => (r.deleted_at ? null : String(r.received_on || r.created_at || "").slice(0, 7) || "none");
export const paymentRow = (r) => ({
  c: r.contact_id, cn: r.contact_name || "", inv: r.invoice_id || null, inn: r.invoice_number || null, k: r.kind, m: r.method, st: r.status, a: r.amount_cents || 0, tip: r.tip_cents || 0,
  fee: r.fee_cents || 0, rf: r.refunded_cents || 0, on: r.received_on, sim: r.simulated ? 1 : 0, im: r.import ? 1 : 0, sh: r.shadow ? 1 : 0, rm: (r.rotor && r.rotor.method_raw) || null, ry: r.rotor && r.rotor.payment_date ? String(r.rotor.payment_date).slice(0, 4) : null,
  pmk: r.stripe && r.stripe.payment_method_id && /^dry_pm_/.test(r.stripe.payment_method_id) ? r.stripe.payment_method_id : null, ...(r.via === "qr" ? { vq: 1 } : {}), u: r.updated_at,
});

export const paymentType = defineType({
  type: "payment",
  prefix: "pm",
  v: 1,
  validate: validatePayment,
  rotorFields: ["kind", "method", "amount_cents", "tip_cents", "fee_cents", "received_on", "reference", "rotor"],
  techFields: ["id", "kind", "method", "status", "amount_cents", "tip_cents", "total_cents", "received_on"],
  mirrored: true,
  readPerm: "invoices:read_all",
  indexes: [{ name: "payments", shard: paymentShard, row: paymentRow }],
  rels: [
    { rel: "invoice-payments", parent: (r) => r.invoice_id || null, sort: (r) => sortOf(r.created_at) },
    { rel: "contact-payments", parent: (r) => r.contact_id, sort: (r) => sortOf(r.created_at), value: (r) => ({ k: r.kind, s: r.status, a: r.amount_cents || 0, t: r.tip_cents || 0, sim: r.simulated ? 1 : 0 }) },
  ],
  pointers: [{ kind: "rotor/payment", key: (r) => (r.rotor && r.rotor.payment_id ? rotorKey(r.rotor.payment_id) : null) }],
  summary: (r) => ({ id: r.id, kind: r.kind, status: r.status, amount_cents: r.amount_cents }),
  example: () => ({ contact_id: "ct_0000000000000000000a", kind: "payment", method: "check", status: "succeeded", amount_cents: 29500, tip_cents: 0, received_on: "2026-11-17", reference: "1042", recorded_by: "system", tip_split: [] }),
});

// ------------------------------------------------------------ credit

export function validateCredit(data, { op } = {}) {
  const stored = op === "update";
  return clean(shape(data, {
    contact_id: requiredId("contact", "A credit belongs to a contact."),
    kind: (v, f) => enumValue(v, CREDIT_KINDS, { field: f, required: true, stored }),
    status: (v, f) => enumValue(v, CREDIT_STATUSES, { field: f, stored }) || "available",
    amount_cents: (v, f) => int(v, { field: f, min: -100000000, max: 100000000, required: true }),
    applied_invoice_id: idOf("invoice"),
    source_invoice_id: idOf("invoice"),
    note: (v, f) => str(v, { field: f, max: 500, trim: false }),
    expires_on: dateOpt,
    issued_by: strOpt(80),
  }));
}

export const creditType = defineType({
  type: "credit",
  prefix: "cr",
  v: 1,
  validate: validateCredit,
  rotorFields: ["rotor"],
  techFields: ["id"],
  readPerm: "invoices:read_all",
  rels: [{ rel: "contact-credits", parent: (r) => r.contact_id, sort: (r) => sortOf(r.created_at), value: (r) => ({ a: r.amount_cents, s: r.status || "available" }) }],
  summary: (r) => ({ id: r.id, kind: r.kind, amount_cents: r.amount_cents, status: r.status }),
  example: () => ({ contact_id: "ct_0000000000000000000a", kind: "goodwill", status: "available", amount_cents: 2500, note: "Sorry for the wait." }),
});

// ------------------------------------------------------------ autopay_run

export function validateAutopayRun(data, { op } = {}) {
  const stored = op === "update";
  const out = shape(data, {
    month: (v, f) => { if (!MONTH_RE.test(String(v || ""))) throw new InputError("Use a month like 2027-01.", f); return v; },
    run_at: isoOpt,
    status: (v, f) => enumValue(v, ["planned", "running", "done"], { field: f, stored }) || "planned",
    items: (v, f) => arr(v, (x, ff) => {
      if (!isObj(x) || !isId(x.plan_id, "plan")) throw new InputError("Each item is a plan.", ff);
      return clean({
        ...x, plan_id: x.plan_id, contact_id: isId(x.contact_id, "contact") ? x.contact_id : undefined, invoice_id: isId(x.invoice_id, "invoice") ? x.invoice_id : undefined,
        attempt_id: x.attempt_id ? String(x.attempt_id).slice(0, 40) : undefined, amount_cents: int(x.amount_cents ?? 0, { field: `${ff}.amount_cents`, min: 0, max: 100000000 }),
        result: enumValue(x.result, ITEM_RESULTS, { field: `${ff}.result`, stored: true }) || "pending", code: x.code ? String(x.code).slice(0, 60) : undefined,
      });
    }, { field: f, max: 2000 }),
    preview: (v) => (isObj(v) ? { ...v } : undefined),
    late: (v) => (v === true ? true : undefined),
  });
  const items = out.items || [];
  out.totals = {
    attempted: items.filter((i) => !["pending", "would_charge", "skipped_no_card", "skipped_paused", "invoice_only", "nothing_due"].includes(i.result)).length,
    succeeded_cents: items.filter((i) => i.result === "succeeded").reduce((s, i) => s + (i.amount_cents || 0), 0),
    failed: items.filter((i) => i.result === "failed").length,
    processing: items.filter((i) => i.result === "processing").length,
    would_charge_cents: items.filter((i) => i.result === "would_charge").reduce((s, i) => s + (i.amount_cents || 0), 0),
  };
  return clean(out);
}

export const autopayRunType = defineType({
  type: "autopay_run",
  prefix: "ap",
  v: 1,
  validate: validateAutopayRun,
  rotorFields: ["rotor"],
  techFields: ["id"],
  readPerm: "invoices:read_all",
  shadow: false,
  indexes: [{ name: "autopay-runs", shard: (r) => (r.deleted_at ? null : ""), row: (r) => ({ m: r.month, st: r.status, n: (r.items || []).length, ok: (r.totals && r.totals.succeeded_cents) || 0, f: (r.totals && r.totals.failed) || 0, w: (r.totals && r.totals.would_charge_cents) || 0, at: r.run_at || r.created_at, u: r.updated_at }) }],
  pointers: [{ kind: "autopay", key: (r) => r.month }],
  summary: (r) => ({ id: r.id, month: r.month, status: r.status }),
  example: () => ({ month: "2026-12", status: "planned", items: [] }),
});

export const types = [invoiceType, paymentType, creditType, autopayRunType];
