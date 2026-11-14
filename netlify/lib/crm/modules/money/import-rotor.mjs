// Money module: the Rotor import phases (design §10.1 contract, §10.2 rows
// 27-30, §10.5, §10.8). The framework (staging, the runner on the bulk
// lane, field ownership, the report) is M2c's; these phases only map rows.
// Rotor stays exactly as it is: they read an export someone made, never
// Rotor itself.
//
//   row 27  invoices + lines → invoice. The number is kept as it is
//           (INV-dddd, INV-dddddd; D-dddddd → kind deposit); Rotor's
//           total_cents is authoritative: native lines (cents, kind) are
//           kept, imported lines (dollars) become cents, and where the lines
//           don't add up to Rotor's subtotal (the plan discount Rotor took
//           without a line) a "Plan discount (imported)" line makes them;
//           "Already Paid" / "Deposit D-…" → deposit_credit, "Referral
//           Credit" / "Gift Card" → credit, "Card Fee" → fee. Status: draft
//           stays draft, void / cancelled → void, everything else is worked
//           out from the imported payments (Rotor's own status is kept in
//           rotor.status_raw for the reconciliation).
//   row 28  payments → payment: stripe / tap_to_pay → card, check, cash,
//           other, Imported-Data → imported; a refund row → kind refund;
//           amount = total − tip; the fee; the reference masked (digit runs
//           of 8 or more, R24); payment_date → received_on; the tip split
//           equally across the job's techs (a "tip" row is a tip paid on its
//           own: amount 0, the whole sum its tip); a payment with no customer goes
//           on one placeholder contact so the sums still add up. Each
//           payment lands in its invoice's applied map (a patch), from which
//           paid, balance and status are derived.
//   row 29  Stripe customer ids: the contacts phase already maps them into
//           the money stats part (stats.money.stripe.customer_ids and
//           ptr/stripe-cus) now that this module registers that part.
//   row 30  credits and gift cards: only what invoice lines show, kept as
//           history rows (status settled: they change nobody's balance, D33).
//
// reconcile(): the CRM's side of the money comparison in the import report
// (§10.8): invoice totals by Rotor status, payments by method, type and
// year, refunds, tips, and every invoice whose derived status disagrees
// with Rotor's.
//
// map() gives the same output for the same input, so an unchanged export
// changes nothing on a re-run.

import { getRecord, readIndex, listKeys } from "../../../crm-store.mjs";
import { idForRotor, deriveId, isId } from "../../core/ids.mjs";
import { localDate } from "../../core/clock.mjs";
import { roundHalfUp } from "../../core/money.mjs";
import { RowError, placeholderContact, toCents } from "../contacts/import-rotor.mjs";
import { rotorKey, fixMojibake } from "../contacts/display.mjs";
import { splitTip, totalsOf } from "./balance.mjs";

const str = (v) => (v == null ? "" : String(v)).trim();
const plain = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const ROTOR_ID = /^(?!\.+$)[A-Za-z0-9_.-]{1,64}$/;
const iso = (v) => (v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
const intOf = (v, f, { min = 0, max = 1000000000 } = {}) => {
  const n = typeof v === "string" && /^-?\d+$/.test(v.trim()) ? Number(v.trim()) : v;
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new RowError(f);
  return n;
};
// Rotor's "whole hour at noon UTC" dates are local dates (§10.6); anything else is an instant.
export const dateOf = (v) => {
  const s = iso(v);
  if (!s) return null;
  return /T12:00:00\.000Z$/.test(s) ? s.slice(0, 10) : localDate(new Date(s));
};
const nameOf = (c) => (c ? c.display_name || [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || c.company_name || "" : "");
const UNLINKED = "rotor-unlinked-payments";

async function contactFor(ctx, rid) {
  if (!rid) return null;
  for (const kind of ["customer", "lead"]) {
    const id = ctx && typeof ctx.lookup === "function" ? await ctx.lookup(kind, rid) : null;
    if (id) return id;
  }
  return null;
}

// ------------------------------------------------------------ row 27: invoices

export function parseNumber(number) {
  const s = str(number).toUpperCase();
  let m;
  if ((m = /^D-(\d{1,9})$/.exec(s))) return { seq: "deposit", n: Number(m[1]), kind: "deposit" };
  if ((m = /^INV-(\d{1,9})$/.exec(s))) return { seq: "invoice", n: Number(m[1]), kind: "standard" };
  return { seq: "imported", n: 0, kind: "standard" };
}

export function lineKind(label, given, cents) {
  const t = str(label).toLowerCase();
  if (/^already paid|^deposit d-|deposit\s+d-\d+/.test(t)) return "deposit_credit";
  if (/referral|gift card/.test(t)) return "credit";
  if (/card fee/.test(t)) return "fee";
  if (given === "discount") return "discount";
  if (given === "credit") return "credit";
  if (cents < 0) return "discount";
  return "service";
}

// One Rotor line (either shape) → an invoice line.
export function mapLine(l, i) {
  if (!plain(l)) throw new RowError(`line_items.${i}`);
  const details = fixMojibake(str(l.details));
  const label = ((fixMojibake(str(l.description || l.title)) || "Service") + (details ? `: ${details}` : "")).slice(0, 300);
  const q = Number(l.quantity ?? 1);
  const qty = Number.isFinite(q) && q >= 0 ? Math.round(q * 1000) : 1000;
  let unit, total;
  const native = l.unit_amount !== undefined || l.unit_price_cents !== undefined || l.total_cents !== undefined;
  if (native) {
    unit = intOf(l.unit_amount ?? l.unit_price_cents ?? 0, `line_items.${i}.unit_amount`, { min: -100000000, max: 100000000 });
    total = l.total_cents !== undefined && l.total_cents !== null ? intOf(l.total_cents, `line_items.${i}.total_cents`, { min: -1000000000 }) : roundHalfUp(unit * qty, 1000);
  } else {
    const u = toCents(l.unit_price ?? 0), t = toCents(l.total_price ?? null);
    if (u === null) throw new RowError(`line_items.${i}.unit_price`);
    unit = u;
    total = t === null ? roundHalfUp(unit * qty, 1000) : t;
  }
  const kind = lineKind(label, str(l.kind), total);
  const neg = ["discount", "credit", "deposit_credit"].includes(kind);
  return { id: `r${i + 1}`, kind, description: label, qty_milli: qty, unit_cents: neg ? -Math.abs(unit) : unit, total_cents: neg ? -Math.abs(total) : total, shape: native ? "native" : "imported" };
}

export function normalizeInvoice(row) {
  if (!plain(row)) throw new RowError("row");
  const id = str(row.id);
  if (!ROTOR_ID.test(id)) throw new RowError("id");
  const number = str(row.invoice_number);
  if (!number || number.length > 24) throw new RowError("invoice_number");
  const statusRaw = str(row.status).slice(0, 30);
  const status = statusRaw.toLowerCase();
  if (!status) throw new RowError("status");
  const lines = (Array.isArray(row.line_items) ? row.line_items : []).slice(0, 55).map(mapLine);
  return {
    id, number, status, status_raw: statusRaw, subtotal_cents: intOf(row.subtotal_cents ?? 0, "subtotal_cents"), tax_cents: intOf(row.tax_amount_cents ?? 0, "tax_amount_cents"), total_cents: intOf(row.total_cents ?? 0, "total_cents"),
    due: dateOf(row.due_date), sent_at: iso(row.sent_at), paid_at: iso(row.paid_at), created_at: iso(row.created_at),
    customer: plain(row.customer) && ROTOR_ID.test(str(row.customer.id)) ? str(row.customer.id) : null,
    customer_name: plain(row.customer) ? [str(row.customer.first_name), str(row.customer.last_name)].filter(Boolean).join(" ") || str(row.customer.company_name) : "",
    job: plain(row.job) && ROTOR_ID.test(str(row.job.id)) ? str(row.job.id) : null, plan: ROTOR_ID.test(str(row.service_plan_id)) ? str(row.service_plan_id) : null,
    lines, notes: str(row.notes).slice(0, 1000),
  };
}

export const STATUS_MAP = Object.freeze({ draft: "draft", void: "void", cancelled: "void", canceled: "void" });

// The lines made to add up to Rotor's total (§10.2 row 27).
export function reconcileLines(lines, { subtotal_cents, tax_cents, total_cents }) {
  const out = lines.map(({ shape, ...l }) => l);
  const sum = () => out.reduce((s, l) => s + l.total_cents, 0);
  const wantSub = subtotal_cents;
  let diff = sum() - wantSub;
  if (diff > 0) out.push({ id: "rpd", kind: "discount", description: "Plan discount (imported)", qty_milli: 1000, unit_cents: -diff, total_cents: -diff });
  else if (diff < 0) out.push({ id: "radj", kind: "service", description: "Adjustment (imported)", qty_milli: 1000, unit_cents: -diff, total_cents: -diff });
  if (tax_cents > 0) out.push({ id: "rtax", kind: "fee", description: "Sales tax (imported)", qty_milli: 1000, unit_cents: tax_cents, total_cents: tax_cents });
  diff = sum() - total_cents;
  if (diff !== 0 && total_cents >= 0) out.push(diff > 0 ? { id: "rfix", kind: "discount", description: "Adjustment (imported)", qty_milli: 1000, unit_cents: -diff, total_cents: -diff } : { id: "rfix", kind: "service", description: "Adjustment (imported)", qty_milli: 1000, unit_cents: -diff, total_cents: -diff });
  return out;
}

async function mapInvoice(r, ctx) {
  const warnings = [];
  const out = { records: [], pointers: [], patches: [], warnings };
  let contactId = await contactFor(ctx, r.customer);
  let contact = null;
  if (!contactId) {
    const ph = placeholderContact(r.customer || `invoice-${r.id}`, { name: r.customer_name, kind: "customer" });
    out.records.push(ph);
    if (r.customer) out.pointers.push({ kind: "rotor/customer", key: rotorKey(r.customer), value: { id: ph.data.id } });
    contactId = ph.data.id;
    contact = ph.data;
    warnings.push("invoice_placeholder_contact");
  } else {
    const g = await getRecord("contact", contactId);
    contact = g ? g.data : null;
  }
  const lookup = async (type, rid) => (rid && ctx && typeof ctx.lookup === "function" ? ctx.lookup(type, rid) : null);
  const jobId = await lookup("job", r.job);
  const planId = await lookup("plan", r.plan);
  if (r.job && !jobId) warnings.push("invoice_job_unknown");
  const num = parseNumber(r.number);
  const shape = r.lines.some((l) => l.shape === "imported") ? "imported" : "native";
  const rawLines = r.lines.reduce((s, l) => s + l.total_cents, 0);
  if (rawLines !== r.subtotal_cents) warnings.push(rawLines - r.subtotal_cents === 5000 ? "invoice_plan_discount_added" : "invoice_lines_adjusted");
  const lines = reconcileLines(r.lines, r);
  if (totalsOf(lines).total_cents !== r.total_cents) warnings.push("invoice_total_from_rotor");
  const status = STATUS_MAP[r.status] || "open";
  const id = idForRotor("invoice", r.id);
  const issued = status === "draft" ? null : (r.sent_at ? dateOf(r.sent_at) : null) || r.due || (r.created_at ? localDate(new Date(r.created_at)) : null);
  const data = {
    id, number: r.number, seq: num.seq, n: num.n, kind: num.kind, contact_id: contactId, contact_name: nameOf(contact) || r.customer_name || undefined,
    job_ids: isId(jobId, "job") ? [jobId] : [], ...(isId(planId, "plan") ? { plan_id: planId } : {}), lines, applied: {}, status,
    ...(issued ? { issued_on: issued } : {}), ...(r.due ? { due_on: r.due } : {}), ...(r.sent_at ? { sent_at: r.sent_at } : {}),
    sent_via: [], checkout_sessions: [], autopay: { eligible: false, attempts: [] }, reminders: { count: 0 }, ...(r.notes ? { office_note: r.notes } : {}),
    rotor: { invoice_id: r.id, invoice_number: r.number, status_raw: r.status_raw || r.status, total_cents_raw: r.total_cents, line_shape: shape, ...(r.job ? { job_id: r.job } : {}), ...(r.plan ? { service_plan_id: r.plan } : {}), ...(r.paid_at ? { paid_at: r.paid_at } : {}) },
    ...(r.created_at ? { created_at: r.created_at } : {}), origin: "import",
  };
  out.records.push({ type: "invoice", data });
  out.pointers.push({ kind: "rotor/invoice", key: rotorKey(r.id), value: { id } });
  // Rotor's status is the truth for draft and void; everything else follows the payments
  out.patches.push({ type: "invoice", id, set: { status } });
  if (isId(jobId, "job")) out.patches.push({ type: "job", id: jobId, add: { invoice_ids: [id] } });
  return out;
}

// ------------------------------------------------------------ row 30: credits on invoice lines (history)

async function mapCredits(r, ctx) {
  const lines = r.lines.map((l, i) => ({ l, i })).filter(({ l }) => l.kind === "credit");
  if (!lines.length) return { records: [] };
  const contactId = (await contactFor(ctx, r.customer)) || (r.customer ? idForRotor("contact", r.customer) : null);
  if (!isId(contactId, "contact") || !(await getRecord("contact", contactId))) return { warnings: ["credit_no_contact"] };
  const invId = idForRotor("invoice", r.id);
  return {
    records: lines.map(({ l, i }) => ({
      type: "credit",
      data: {
        id: deriveId("credit", `rotor:${r.id}:${i}`), contact_id: contactId, kind: "imported", status: "settled", amount_cents: Math.abs(l.total_cents), applied_invoice_id: invId,
        note: `${l.description} on ${r.number} (from Rotor)`.slice(0, 500), rotor: { invoice_id: r.id, line: i + 1 }, ...(r.created_at ? { created_at: r.created_at } : {}),
      },
    })),
  };
}

// ------------------------------------------------------------ row 28: payments

export const METHOD_MAP = Object.freeze({ stripe: "card", tap_to_pay: "card", check: "check", cash: "cash", other: "other", "imported-data": "imported" });

export function normalizePayment(row) {
  if (!plain(row)) throw new RowError("row");
  const id = str(row.id);
  if (!ROTOR_ID.test(id)) throw new RowError("id");
  const status = str(row.status).toLowerCase();
  if (!["succeeded", "failed"].includes(status)) throw new RowError("status");
  const type = str(row.payment_type || "invoice").toLowerCase();
  // "tip": a tip paid on its own after the invoice (the whole amount is the tip)
  if (!["invoice", "refund", "tip"].includes(type)) throw new RowError("payment_type");
  const methodRaw = str(row.payment_method);
  const method = METHOD_MAP[methodRaw.toLowerCase()];
  if (!method) throw new RowError("payment_method");
  const total = intOf(row.total_amount_cents ?? 0, "total_amount_cents");
  const tipRaw = intOf(row.tip_cents ?? 0, "tip_cents");
  const tip = type === "tip" && !tipRaw ? total : tipRaw;
  if (tip > total) throw new RowError("tip_cents");
  const on = dateOf(row.payment_date) || dateOf(row.created_at);
  if (!on) throw new RowError("payment_date");
  const ref = row.reference_number === null || row.reference_number === undefined ? "" : str(row.reference_number);
  if (ref.length > 200) throw new RowError("reference_number");
  return {
    id, status, type, method, method_raw: methodRaw, total_cents: total, tip_cents: tip, fee_cents: intOf(row.processing_fee_cents ?? 0, "processing_fee_cents"), on, at: iso(row.payment_date) || iso(row.created_at),
    reference: ref, customer: ROTOR_ID.test(str(row.customer_id)) ? str(row.customer_id) : plain(row.customer) && ROTOR_ID.test(str(row.customer.id)) ? str(row.customer.id) : null,
    customer_name: plain(row.customer) ? [str(row.customer.first_name), str(row.customer.last_name)].filter(Boolean).join(" ") : "",
    invoice: ROTOR_ID.test(str(row.invoice_id)) ? str(row.invoice_id) : null, invoice_number: plain(row.invoice) ? str(row.invoice.invoice_number).slice(0, 24) : "",
    job: ROTOR_ID.test(str(row.job_id)) ? str(row.job_id) : null, plan: ROTOR_ID.test(str(row.service_plan_id)) ? str(row.service_plan_id) : null, created_at: iso(row.created_at),
  };
}

async function mapPayment(r, ctx) {
  const warnings = [];
  const out = { records: [], pointers: [], patches: [], warnings };
  const lookup = async (type, rid) => (rid && ctx && typeof ctx.lookup === "function" ? ctx.lookup(type, rid) : null);
  const invoiceId = await lookup("invoice", r.invoice);
  let inv = null;
  if (isId(invoiceId, "invoice")) { const g = await getRecord("invoice", invoiceId); inv = g ? g.data : null; }
  if (r.invoice && !inv) warnings.push("payment_invoice_unknown");
  if (!r.invoice) warnings.push("payment_unlinked");
  let contactId = (await contactFor(ctx, r.customer)) || (inv && inv.contact_id) || null;
  if (!contactId) {
    // no customer and no invoice (Rotor has four): one placeholder holds them so the sums still add up
    const ph = placeholderContact(r.customer || UNLINKED, { name: r.customer_name || "Unlinked payments (Rotor)", kind: "customer" });
    out.records.push(ph);
    out.pointers.push({ kind: "rotor/customer", key: rotorKey(r.customer || UNLINKED), value: { id: ph.data.id } });
    contactId = ph.data.id;
    warnings.push("payment_placeholder_contact");
  }
  const jobId = (await lookup("job", r.job)) || (inv && (inv.job_ids || [])[0]) || null;
  const planId = await lookup("plan", r.plan);
  let tipSplit = [];
  if (r.tip_cents > 0 && r.type !== "refund" && isId(jobId, "job")) {
    const jg = await getRecord("job", jobId);
    tipSplit = splitTip(r.tip_cents, (jg && jg.data.assignee_ids) || []);
    if (!tipSplit.length) warnings.push("payment_tip_unassigned");
  }
  const id = idForRotor("payment", r.id);
  const refund = r.type === "refund";
  const amount = r.total_cents - r.tip_cents;
  const data = {
    id, contact_id: contactId, ...(inv ? { invoice_id: inv.id, invoice_number: inv.number } : {}), ...(isId(jobId, "job") ? { job_id: jobId } : {}), ...(isId(planId, "plan") ? { plan_id: planId } : {}),
    kind: refund ? "refund" : "payment", method: r.method, status: r.status, amount_cents: amount, tip_cents: r.tip_cents, fee_cents: r.fee_cents, received_on: r.on,
    ...(r.reference ? { reference: r.reference } : {}), tip_split: tipSplit, recorded_by: "import", ...(r.method_raw === "tap_to_pay" ? { note: "Tap to Pay (Rotor)" } : {}),
    rotor: { payment_id: r.id, method_raw: r.method_raw, type_raw: r.type, status_raw: r.status, ...(r.invoice ? { invoice_id: r.invoice } : {}), ...(r.at ? { payment_date: r.at } : {}) },
    ...(r.created_at ? { created_at: r.created_at } : {}),
  };
  out.records.push({ type: "payment", data });
  out.pointers.push({ kind: "rotor/payment", key: rotorKey(r.id), value: { id } });
  // into the invoice's applied map: paid, balance and status follow (derived, never rotorFields)
  if (inv) out.patches.push({ type: "invoice", id: inv.id, set: { [`applied.${id}`]: { kind: refund ? "refund" : "payment", amount_cents: amount, tip_cents: r.tip_cents, status: r.status, at: r.at || `${r.on}T18:00:00.000Z` } } });
  return out;
}

// ------------------------------------------------------------ the phases

export const phases = [
  { name: "money.invoices", entity: "invoices", after: ["contacts.leads", "work.jobs", "plans.plans"], normalize: normalizeInvoice, map: mapInvoice },
  { name: "money.credits", entity: "invoices", after: ["money.invoices"], normalize: normalizeInvoice, map: mapCredits },
  { name: "money.payments", entity: "payments", after: ["money.invoices", "work.visits"], normalize: normalizePayment, map: mapPayment },
];

// ------------------------------------------------------------ reconciliation (§10.8)

const inc = (o, k, n) => { o[k] = (o[k] || 0) + n; };
async function shardsOf(index) {
  const keys = await listKeys(`ix/${index}/`).catch(() => []);
  return [...new Set(keys.map((k) => k.slice(`ix/${index}/`.length)).filter((s) => s && !s.includes("/")))];
}

// What the derived state of an imported invoice should be for Rotor's status.
export function statusAgrees(row) {
  const raw = String(row.rs || "").toLowerCase();
  if (raw === "draft") return row.st === "draft";
  if (["void", "cancelled", "canceled"].includes(raw)) return row.st === "void";
  if (raw === "paid") return row.st === "paid";
  if (raw === "partially_paid") return row.st === "open" && row.paid > 0 && row.bal > 0;
  if (["open", "sent", "overdue", "failed"].includes(raw)) return row.st === "open" && row.paid === 0;
  return true;
}

// The CRM's side of the money comparison, from the indexes the run just
// rebuilt. rotor: what report.mjs summed from the staged rows.
// → { invoices, payments, diffs: [{ metric, rotor, crm }], mismatches, ok }
export async function reconcile({ rotor } = {}) {
  const inv = { count: 0, total_cents: 0, by_status: {} };
  const mismatches = [];
  for (const sh of await shardsOf("invoices")) {
    for (const r of (await readIndex("invoices", sh)).rows) {
      if (!r.im || !r.rs) continue;
      inv.count += 1;
      inv.total_cents += r.tot || 0;
      const b = (inv.by_status[r.rs] ||= { count: 0, cents: 0 });
      b.count += 1; b.cents += r.tot || 0;
      if (!statusAgrees(r) && mismatches.length < 50) mismatches.push({ number: r.n, rotor_status: r.rs, crm_status: r.st, total_cents: r.tot || 0, paid_cents: r.paid || 0, balance_cents: r.bal || 0 });
    }
  }
  const pay = { count: 0, net_cents: 0, tips_cents: 0, refunds_cents: 0, failed: 0, unlinked: 0, by_method: {}, by_type: {}, by_year: {} };
  for (const sh of await shardsOf("payments")) {
    for (const r of (await readIndex("payments", sh)).rows) {
      if (!r.im || !r.rm) continue;
      pay.count += 1;
      if (r.st === "failed") { pay.failed += 1; continue; }
      const refund = r.k === "refund";
      if (refund) pay.refunds_cents += r.a + r.tip; else pay.net_cents += r.a;
      pay.tips_cents += r.tip;
      if (!r.inv) pay.unlinked += 1;
      inc(pay.by_method, String(r.rm).slice(0, 30), r.a);
      inc(pay.by_type, refund ? "refund" : r.rt === "tip" ? "tip" : "invoice", r.a + r.tip);
      const y = String(r.ry || r.on || "").slice(0, 4);          // Rotor's own (UTC) year, as its report buckets it
      if (/^\d{4}$/.test(y)) inc(pay.by_year, y, r.a);
    }
  }
  const diffs = [];
  const cmp = (metric, a, b) => { if ((a || 0) !== (b || 0)) diffs.push({ metric, rotor: a || 0, crm: b || 0 }); };
  if (rotor) {
    const ri = rotor.invoices || {}, rp = rotor.payments || {};
    cmp("invoices.count", ri.count, inv.count);
    cmp("invoices.total_cents", ri.total_cents, inv.total_cents);
    for (const st of new Set([...Object.keys(ri.by_status || {}), ...Object.keys(inv.by_status)])) cmp(`invoices.${st}.cents`, ((ri.by_status || {})[st] || {}).cents, (inv.by_status[st] || {}).cents);
    for (const k of ["count", "net_cents", "tips_cents", "refunds_cents", "failed"]) cmp(`payments.${k}`, rp[k], pay[k]);
    for (const g of ["by_method", "by_type", "by_year"]) for (const k of new Set([...Object.keys(rp[g] || {}), ...Object.keys(pay[g])])) cmp(`payments.${g}.${k}`, (rp[g] || {})[k], pay[g][k]);
  }
  return { invoices: inv, payments: pay, diffs: diffs.slice(0, 100), mismatches, status_mismatches: mismatches.length, ok: diffs.length === 0 };
}
