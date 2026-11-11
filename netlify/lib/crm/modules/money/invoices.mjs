// Money module: invoices (design §5.6 "Invoice state machine", "When
// invoices are created").
//
// Every invoice is made by the op money.make_invoice (resumable by the
// worker): its number is journaled before it is used (ops s.number: no gap,
// no double), then the record (draft), then credits (the quote's deposit,
// the contact's account credit), then the links (the jobs' invoice_ids, the
// plan visits it bills), then, when it is to be issued, issueInvoice().
// Ids are derived from what the invoice is for (a job, a plan's month, a
// quote's deposit, a client uuid), so a retried listener, a double tap and
// the backfill sweep all land on the same invoice.
//
//   issueInvoice   draft → open (issued_on, due_on: due on receipt, §5.6),
//                  emits invoice.issued (core event: the autopay charge
//                  starts from it) and invoice.sent (the text and email,
//                  or, for an autopay invoice, nothing: the charge result's
//                  receipt or failure text says it)
//   voidInvoice    draft/open → void (owner; reason)
//   writeOff       open → uncollectible (owner)
//
// Before cutover the listener and the backfill sweep act only for
// sandboxed customers (a test contact, a customer the CRM made); a job
// Rotor still owns gets a would-invoice row (§0 rule 12).

import { getRecord, getRecords, updateRecord, createRecord, listRel, readIndex, addActivity } from "../../../crm-store.mjs";
import { deriveId, isId } from "../../core/ids.mjs";
import { now, nowIso, localDate, addLocalDays } from "../../core/clock.mjs";
import { InputError, ConflictError, NotFoundError, ExistsError, BlobsTransientError } from "../../core/errors.mjs";
import { defineOp, runOp } from "../../core/ops.mjs";
import { emit } from "../../core/events.mjs";
import { sandboxed } from "../../core/context.mjs";
import { roundHalfUp } from "../../core/money.mjs";
import { keySafe } from "../../core/text.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { scopeCovers, NOT_BILLABLE } from "../work/types.mjs";
import { ordinalLines, ordinalDiscounts } from "../plans/machine.mjs";
import { W, today, moneySettings, sysModeOf, numberFormats, numberLabel, seqFor, nameOf, liveContact, touchMoneyStats } from "./common.mjs";
import { totalsOf } from "./balance.mjs";
import { availableCredit } from "./credits.mjs";
import { cardFor } from "./cards.mjs";

export const INVOICE_START = 610;            // D31: INV-0610 onward (the cutover sets seq/invoice from the final import)
export const MAX_JOB_INVOICES = 5;

const shortId = (id) => String(id).slice(-6);

// ------------------------------------------------------------ lines

// An invoice's lines from a job: the lines that cover its plan visit (an
// optional line only when picked), then one line per discount; the
// discounts add up to exactly what the job's totals say (percentages
// first, fixed amounts after, never below $0).
export function linesFromJob(job) {
  const n = (job.plan_ordinal && job.plan_ordinal.n) || 1;
  const tag = shortId(job.id);
  const on = (job.lines || []).filter((l) => l && scopeCovers(l.scope, n) && !(l.optional && l.selected !== true));
  const lines = on.map((l, i) => ({
    id: `j${tag}-${i + 1}`, kind: "service", description: String(l.title || "Service").slice(0, 300), qty_milli: Number.isSafeInteger(l.qty_milli) ? l.qty_milli : 1000,
    unit_cents: Number.isSafeInteger(l.unit_cents) ? l.unit_cents : 0, total_cents: Number.isSafeInteger(l.total_cents) ? l.total_cents : 0, job_id: job.id,
  }));
  const subtotal = lines.reduce((s, l) => s + l.total_cents, 0);
  const totalDiscount = Math.max(0, Math.min(subtotal, (job.totals && job.totals.discount_cents) || 0));
  const ds = (job.discounts || []).filter((d) => d && scopeCovers(d.scope, n));
  let left = totalDiscount;
  ds.forEach((d, i) => {
    const want = d.type === "percentage" ? roundHalfUp(subtotal * (d.value || 0), 10000) : d.value || 0;
    const amt = i === ds.length - 1 ? left : Math.min(left, want);
    left -= amt;
    if (amt > 0) lines.push({ id: `j${tag}-d${i + 1}`, kind: "discount", description: String(d.name || "Discount").slice(0, 300), qty_milli: 1000, unit_cents: -amt, total_cents: -amt, job_id: job.id });
  });
  return lines;
}

// A plan visit's lines when it has no job yet (the plan's own lines).
export function linesFromOrdinal(plan, o) {
  return linesFromJob({ id: `${plan.id}-${o.term || 1}-${o.n}`, lines: ordinalLines(plan, o), discounts: ordinalDiscounts(plan, o), totals: totalsFor(ordinalLines(plan, o), ordinalDiscounts(plan, o)) })
    .map((l) => { const { job_id, ...rest } = l; return rest; });
}
function totalsFor(lines, discounts) {
  const subtotal = lines.reduce((s, l) => s + (l.total_cents || 0), 0);
  const bp = Math.min(10000, discounts.filter((d) => d.type === "percentage").reduce((s, d) => s + (d.value || 0), 0));
  const pct = subtotal > 0 ? roundHalfUp(subtotal * bp, 10000) : 0;
  const fixed = discounts.filter((d) => d.type === "fixed").reduce((s, d) => s + (d.value || 0), 0);
  return { discount_cents: Math.max(0, Math.min(subtotal, pct + fixed)) };
}

// ------------------------------------------------------------ ids

export const jobInvoiceId = (jobId, gen = 1) => deriveId("invoice", `job:${jobId}`, "money.job", gen);
export const cycleInvoiceId = (planId, month) => deriveId("invoice", `cycle:${planId}:${month}`, "money.cycle", 1);
export const depositInvoiceId = (quoteId, n = 1) => deriveId("invoice", `deposit:${quoteId}`, "money.deposit", n);
export const clientInvoiceId = (uuid) => deriveId("invoice", `c:${uuid}`, "money.manual", 1);
export const makeOpId = (invoiceId) => `invoice--${invoiceId}`;

// The job's live (not void) invoice, or the id its next one takes. → { invoice?, id }
export async function jobInvoiceSlot(jobId) {
  for (let gen = 1; gen <= MAX_JOB_INVOICES; gen++) {
    const id = jobInvoiceId(jobId, gen);
    const g = await getRecord("invoice", id);
    if (!g) return { id };
    if (g.data.status !== "void" && !g.data.deleted_at) return { id, invoice: g.data };
  }
  throw new ConflictError("This job has been invoiced and voided too many times. Make an invoice by hand.");
}

// ------------------------------------------------------------ the make op

// input: { invoice: { id, kind, contact_id, ... lines }, seq, issue, channels?, credit?: bool,
//          deposit_from?: quote id, links: { job_ids, plan_id, plan_ordinals } }
defineOp("money.make_invoice", {
  steps(input) {
    const spec = input.invoice;
    const id = spec.id;
    return [
      {
        name: "make",
        async run(s) {
          if (await getRecord("invoice", id)) return { created: false };
          const contact = await liveContact(spec.contact_id);
          if (!contact) throw new NotFoundError("That contact isn't there anymore.");
          const n = await s.number(id, input.seq, { start: input.seq === "invoice" ? INVOICE_START : 1 });
          const formats = await numberFormats();
          const data = {
            ...spec, contact_id: contact.id, contact_name: nameOf(contact) || undefined, number: numberLabel(n, input.seq, formats), seq: input.seq, n,
            status: "draft", applied: {}, sent_via: [], checkout_sessions: [], reminders: { count: 0 }, autopay: { eligible: false, attempts: [] },
          };
          try { await createRecord("invoice", data, s.ctx); } catch (e) { if (!(e instanceof ExistsError)) throw e; return { created: false }; }
          await addActivity(contact.id, "invoice.created", id, now()).catch(() => {});
          return { created: true, number: data.number };
        },
      },
      {
        name: "credits",
        async run(s) {
          const g = await getRecord("invoice", id);
          if (!g || g.data.status !== "draft") return { skipped: true };
          const inv = g.data;
          const extra = [];
          // the quote's deposit (§5.6 "Deposits"): claimed once, by the first invoice that takes it
          if (input.deposit_from && !inv.lines.some((l) => l.kind === "deposit_credit")) {
            const dep = await claimDeposit(input.deposit_from, id, s.ctx);
            const room = Math.max(0, totalsOf([...inv.lines, ...extra]).total_cents);
            const amt = dep ? Math.min(dep.paid, room) : 0;
            if (amt > 0) extra.push({ id: "dep", kind: "deposit_credit", description: `Deposit ${dep.number}`, qty_milli: 1000, unit_cents: -amt, total_cents: -amt, ref_id: dep.id });
          }
          // the contact's account credit (§5.6, D33)
          if (input.credit !== false && ["standard", "plan_cycle"].includes(inv.kind) && !inv.lines.some((l) => l.kind === "credit")) {
            const room = Math.max(0, totalsOf([...inv.lines, ...extra]).total_cents);
            const avail = room > 0 ? await availableCredit(inv.contact_id) : 0;
            const amt = Math.min(avail, room);
            if (amt > 0) {
              const cid = deriveId("credit", `apply:${id}`);
              try {
                await createRecord("credit", { id: cid, contact_id: inv.contact_id, kind: "applied", status: "applied", amount_cents: -amt, applied_invoice_id: id, note: `Used on ${inv.number}` }, s.ctx);
              } catch (e) { if (!(e instanceof ExistsError)) throw e; }
              const c = (await getRecord("credit", cid)).data;
              extra.push({ id: "cred", kind: "credit", description: "Account credit", qty_milli: 1000, unit_cents: c.amount_cents, total_cents: c.amount_cents, ref_id: cid });
            }
          }
          if (!extra.length) return { credits: 0 };
          await updateRecord("invoice", id, (x) => (x.status !== "draft" || x.lines.some((l) => extra.some((e) => e.id === l.id)) ? null : { ...x, lines: [...x.lines, ...extra] }), s.ctx);
          return { credits: extra.length };
        },
      },
      {
        name: "links",
        async run(s) {
          const links = input.links || {};
          for (const jid of (links.job_ids || []).slice(0, 20)) {
            await updateRecord("job", jid, (j) => ((j.invoice_ids || []).includes(id) ? null : { ...j, invoice_ids: [...(j.invoice_ids || []), id].slice(-50) }), s.ctx)
              .catch((e) => console.error(`crm:money: a job didn't get its invoice link (${safeErr(e)})`));
          }
          if (isId(links.plan_id, "plan") && (links.plan_ordinals || []).length) {
            await updateRecord("plan", links.plan_id, (p) => {
              let changed = false;
              const ordinals = (p.ordinals || []).map((o) => {
                if (!links.plan_ordinals.some((x) => (x.term || 1) === (o.term || 1) && x.n === o.n) || o.billed_invoice_id) return o;
                changed = true;
                return { ...o, billed_invoice_id: id };
              });
              return changed ? { ...p, ordinals } : null;
            }, s.ctx).catch((e) => console.error(`crm:money: a plan visit didn't get its invoice (${safeErr(e)})`));
          }
          return { done: true };
        },
      },
      {
        name: "issue",
        async run(s) {
          const g = await getRecord("invoice", id);
          await touchMoneyStats(spec.contact_id, s.ctx);
          if (!input.issue || !g || g.data.status !== "draft") return { issued: false };
          const out = await issueInvoice(id, { channels: input.channels, autopay: input.autopay, silent: input.silent === true }, s.ctx);
          return { issued: true, status: out.status };
        },
      },
    ];
  },
});

// A quote's paid deposit, claimed for one invoice (CAS on the deposit
// invoice: credited_invoice_id). → { id, number, paid } | null
async function claimDeposit(quoteId, invoiceId, ctx) {
  const q = isId(quoteId, "quote") ? await getRecord("quote", quoteId).catch(() => null) : null;
  const depId = q && q.data.converted_to && q.data.converted_to.deposit_invoice_id;
  if (!isId(depId, "invoice")) return null;
  let got = null;
  await updateRecord("invoice", depId, (d) => {
    const paid = (d.paid_cents || 0) - (d.refunded_cents || 0);
    if (paid <= 0) { got = null; return null; }
    if (d.credited_invoice_id && d.credited_invoice_id !== invoiceId) { got = null; return null; }
    got = { id: d.id, number: d.number, paid };
    return d.credited_invoice_id === invoiceId ? null : { ...d, credited_invoice_id: invoiceId };
  }, W(ctx)).catch(() => null);
  return got;
}

// Makes (or finds) an invoice through the op. → the invoice record.
export async function makeInvoice({ invoice, issue = false, channels, links, deposit_from, credit, autopay, silent }, ctx = {}) {
  const w = W(ctx);
  const mode = await sysModeOf(w);
  const seq = seqFor(invoice.kind, mode.system_of_record);
  const opId = makeOpId(invoice.id);
  const out = await runOp(opId, "money.make_invoice", {
    input: { invoice, seq, issue, channels, links: links || { job_ids: invoice.job_ids || [] }, deposit_from, credit, autopay, silent },
    ctx: { ...w, mode }, holder: String(w.requestId || "money").slice(0, 80), resume: true,
  });
  if (out.status === "running") throw new BlobsTransientError("That invoice is still being made. Try again in a minute.");
  if (out.status === "failed") {
    const g = await getRecord("invoice", invoice.id);
    if (g) return g.data;
    throw new ConflictError((out.error && out.error.message) || "That invoice couldn't be made.");
  }
  const g = await getRecord("invoice", invoice.id);
  if (!g) throw new BlobsTransientError("That invoice is still being made.");
  return g.data;
}

// ------------------------------------------------------------ from a job

// What a completed job's billing is (§5.6 "When invoices are created").
// → { bill: true, plan? } | { bill: false, reason }
export async function billingFor(job) {
  if (!job || job.deleted_at) return { bill: false, reason: "missing" };
  if (job.billable === false || NOT_BILLABLE.includes(job.kind)) return { bill: false, reason: "not_billable" };
  if (!(job.lines || []).length || !((job.totals && job.totals.total_cents) > 0)) return { bill: false, reason: "zero" };
  if (!isId(job.plan_id, "plan")) return { bill: true };
  const pg = await getRecord("plan", job.plan_id).catch(() => null);
  if (!pg) return { bill: true };
  const plan = pg.data;
  const mode = (plan.billing && plan.billing.mode) || "barta_standard";
  const o = job.plan_ordinal || {};
  const ord = (plan.ordinals || []).find((x) => (x.term || 1) === (o.term || 1) && x.n === o.n) || null;
  if (mode === "after_visit") return { bill: true, plan, ordinal: ord };
  if (mode === "barta_standard" && (o.term || 1) === 1 && o.n === 1) return { bill: true, plan, ordinal: ord };
  // billed on the 1st of its month; a visit done before that billing is billed now instead
  if (ord && isId(ord.billed_invoice_id, "invoice")) return { bill: false, reason: "billed_by_cycle", plan };
  return { bill: true, plan, ordinal: ord };
}

// The autopay question for a new invoice: does it get charged at once?
async function autopayFor(job, plan, contactId) {
  let wants = false;
  if (plan) wants = !!(plan.billing && plan.billing.autopay);
  else if (isId(job.quote_id, "quote")) {
    const q = await getRecord("quote", job.quote_id).catch(() => null);
    wants = !!(q && q.data.agreement && q.data.agreement.require_card);
  }
  if (!wants) return { eligible: false };
  const card = await cardFor(contactId, plan);
  return card.usable ? { eligible: true, payment_method_id: card.payment_method_id } : { eligible: false, reason: "no_card" };
}

// The invoice of one completed job: made, credited, linked and (auto-issue)
// issued. → the invoice record.
export async function ensureJobInvoice(job, { origin = "job.completed", decision, issue } = {}, ctx = {}) {
  const slot = await jobInvoiceSlot(job.id);
  if (slot.invoice) return slot.invoice;
  const d = decision || await billingFor(job);
  const plan = d.plan || null;
  const settings = await moneySettings();
  const ap = await autopayFor(job, plan, job.contact_id);
  const ord = job.plan_ordinal && plan ? [{ term: job.plan_ordinal.term || 1, n: job.plan_ordinal.n }] : [];
  const invoice = {
    id: slot.id, kind: "standard", contact_id: job.contact_id, ...(job.property_id ? { property_id: job.property_id } : {}), job_ids: [job.id],
    ...(plan ? { plan_id: plan.id, plan_ordinals: ord } : {}), ...(job.quote_id ? { quote_id: job.quote_id } : {}), lines: linesFromJob(job), origin,
  };
  return makeInvoice({
    invoice, issue: issue !== undefined ? issue : settings.auto_issue !== false, links: { job_ids: [job.id], ...(plan ? { plan_id: plan.id, plan_ordinals: ord } : {}) },
    deposit_from: job.quote_id || (plan && plan.quote_id) || null, autopay: ap,
  }, ctx);
}

// ------------------------------------------------------------ issue, send, void, write off

// draft → open. opts: { channels?, autopay?: { eligible, payment_method_id } }.
// Emits invoice.issued and invoice.sent (§5.7.4: an autopay invoice waits
// for its charge result instead of a "here's your invoice" text).
export async function issueInvoice(id, { channels, autopay, by, silent } = {}, ctx = {}) {
  const w = W(ctx);
  const ch = Array.isArray(channels) && channels.length ? channels.filter((c) => ["sms", "email"].includes(c)) : ["sms", "email"];
  let issuedNow = false;
  const r = await updateRecord("invoice", id, (inv) => {
    if (inv.status !== "draft") return null;
    if (!(inv.lines || []).length) throw new ConflictError("Add a line first.");
    issuedNow = true;
    const day = today();
    return {
      ...inv, status: "open", issued_on: day, due_on: inv.due_on && inv.due_on >= day ? inv.due_on : day, issued_at: nowIso(),
      ...(autopay ? { autopay: { ...(inv.autopay || {}), eligible: !!autopay.eligible, ...(autopay.payment_method_id ? { payment_method_id: autopay.payment_method_id } : {}) } } : {}),
    };
  }, w);
  const inv = r.data;
  if (issuedNow && r.changed) {
    const waits = !!(inv.autopay && inv.autopay.eligible) && inv.balance_cents > 0;
    await emit("invoice.issued", { id: inv.id, wv: inv.wv, invoice_id: inv.id, contact_id: inv.contact_id, amount_cents: inv.total_cents || 0, kind: inv.kind, autopay: waits && !(autopay && autopay.by_run) }, w)
      .catch((e) => console.error(`crm:money: invoice.issued not queued (${safeErr(e)})`));
    if (inv.balance_cents > 0 && !silent) {
      await emit("invoice.sent", { id: `${inv.id}.sent`, wv: inv.wv, invoice_id: inv.id, contact_id: inv.contact_id, channels: ch, wait_for_charge: waits, by: by || w.by || "system" }, w)
        .catch((e) => console.error(`crm:money: invoice.sent not queued (${safeErr(e)})`));
    }
    await touchMoneyStats(inv.contact_id, ctx);
  }
  return inv;
}

// A person sends (or sends again) an open invoice's link. → the invoice.
export async function sendInvoice(id, { channels } = {}, ctx = {}) {
  const ch = (Array.isArray(channels) ? channels : []).filter((c) => ["sms", "email"].includes(c));
  if (!ch.length) throw new InputError("Pick text, email or both.", "channels");
  const g = await getRecord("invoice", id);
  if (!g) throw new NotFoundError("That invoice isn't here.");
  if (g.data.status === "draft") return issueInvoice(id, { channels: ch }, ctx);
  if (g.data.status !== "open") throw new ConflictError(g.data.status === "paid" ? "This invoice is paid." : "This invoice can't be sent.");
  const w = W(ctx);
  const r = await updateRecord("invoice", id, (inv) => ({ ...inv, sent_at: nowIso(), sent_via: [...new Set([...(inv.sent_via || []), ...ch])] }), w);
  await emit("invoice.sent", { id: `${r.data.id}.sent`, wv: r.data.wv, invoice_id: r.data.id, contact_id: r.data.contact_id, channels: ch, wait_for_charge: false, manual: true, by: w.by || "system" }, w);
  return r.data;
}

export async function voidInvoice(id, { reason } = {}, ctx = {}) {
  const why = String(reason || "").trim();
  if (why.length < 2) throw new InputError("Say why it's void.", "reason");
  const r = await updateRecord("invoice", id, (inv) => {
    if (inv.status === "void") return null;
    if (!["draft", "open"].includes(inv.status)) throw new ConflictError(inv.status === "paid" ? "A paid invoice can't be voided. Refund it first." : "This invoice can't be voided.");
    if (inv.charging && Date.parse(inv.charging.until) > Date.now()) throw new ConflictError("A card charge is running on this invoice. Try again in a minute.");
    return { ...inv, status: "void", voided_at: nowIso(), void_reason: why.slice(0, 300) };
  }, W(ctx));
  await touchMoneyStats(r.data.contact_id, ctx);
  return r.data;
}

export async function writeOff(id, ctx = {}) {
  const r = await updateRecord("invoice", id, (inv) => {
    if (inv.status === "uncollectible") return null;
    if (inv.status !== "open") throw new ConflictError("Only an open invoice can be written off.");
    return { ...inv, status: "uncollectible", written_off_at: nowIso() };
  }, W(ctx));
  await touchMoneyStats(r.data.contact_id, ctx);
  return r.data;
}

// ------------------------------------------------------------ the listener and the sweep

// job.completed (§5.6): the job's invoice, or for a plan visit billed on the
// 1st nothing (its month's run bills it). Mutating automation: a customer
// Rotor still owns gets a would-invoice row.
export async function onJobCompleted(event, h) {
  const p = event.payload || {};
  const g = isId(p.job_id, "job") ? await getRecord("job", p.job_id) : null;
  if (!g || g.data.status !== "completed") return { result: "skipped:changed" };
  return invoiceCompletedJob(g.data, h.ctx, "job.completed");
}

async function invoiceCompletedJob(job, actx, origin) {
  const d = await billingFor(job);
  if (!d.bill) return { result: `skipped:${d.reason}` };
  const slot = await jobInvoiceSlot(job.id).catch(() => null);
  if (slot && slot.invoice) return { result: "skipped:exists" };
  const c = await liveContact(job.contact_id);
  if (!actx.mayAct({ record: job, contact: c })) {
    await actx.would(job, "invoice", { job_total_cents: [null, (job.totals && job.totals.total_cents) || 0] });
    return { result: "would-invoice" };
  }
  const inv = await ensureJobInvoice(job, { origin, decision: d }, actx.write());
  return { result: `invoiced:${inv.number}` };
}

// money.invoice_backfill (hourly): completed billable jobs of the last 30
// days with no invoice (a listener that never ran, a job completed while
// Money was off). The same rules as the listener.
export async function invoiceBackfill(ctx) {
  const day = today();
  const from = addLocalDays(day, -30);
  const years = [...new Set([day.slice(0, 4), from.slice(0, 4)])];
  const rows = [];
  for (const y of years) rows.push(...(await readIndex("jobs", y)).rows.filter((r) => r.st === "completed" && r.bill !== false && r.done && localDate(new Date(r.done)) >= from && (r.tot || 0) > 0));
  const invoiced = new Set();
  for (const sh of ["open", ...years]) for (const r of (await readIndex("invoices", sh)).rows) if (r.j) invoiced.add(r.j);
  let n = 0;
  let would = 0;
  for (const r of rows.slice(0, 200)) {
    if (invoiced.has(r.id)) continue;
    if (ctx.budget && ctx.budget.left() < 8000) return { done: false, progress: n };
    const g = await getRecord("job", r.id);
    if (!g || g.data.import) continue;
    try {
      const out = await invoiceCompletedJob(g.data, ctx, "backfill");
      if (out.result.startsWith("invoiced")) n += 1;
      if (out.result === "would-invoice") would += 1;
    } catch (e) { console.error(`crm:money: backfill skipped a job (${safeErr(e)})`); }
  }
  return { progress: n, result: `invoiced ${n}, would ${would}` };
}

// ------------------------------------------------------------ reading

export async function getInvoice(id) {
  if (!isId(id, "invoice")) throw new NotFoundError("That invoice isn't here.");
  const g = await getRecord("invoice", id);
  if (!g || g.data.deleted_at) throw new NotFoundError("That invoice isn't here.");
  return g;
}

export async function paymentsOf(invoiceId) {
  const rows = await listRel("invoice-payments", invoiceId, { limit: 100, newestFirst: false });
  return (await getRecords("payment", rows.map((r) => r.id))).filter(Boolean).map((g) => g.data);
}

export const isSandboxed = (inv, contact) => sandboxed(inv, contact);
export { keySafe };
