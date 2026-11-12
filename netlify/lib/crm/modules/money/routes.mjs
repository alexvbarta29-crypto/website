// Money module: the staff API (design §5.6 "Endpoints", §4.5).
//
//   GET  /invoices?status=&contact=&year=           invoices:read_all   rows, counts and totals
//   POST /invoices {contact_id, kind?, lines?, job_ids?, plan_id?, client_id, issue?}   invoices:write
//   POST /jobs/:id/invoice                           invoices:write      the job's invoice now
//   GET  /invoices/:id                               invoices:read       (a tech: number, status, balance of an invoice on their own visit's job)
//   PATCH /invoices/:id (If-Match)                   invoices:write      a draft's lines; due date and notes
//   POST /invoices/:id/issue · /send {channels}      invoices:send
//   POST /invoices/:id/void {reason} · /write-off    invoices:void       (owners)
//   POST /invoices/:id/charge {payment_method_id?}   payments:charge     a run (202 { run_id })
//   POST /invoices/:id/payments {method, amount_cents, tip_cents?, received_on?, reference?, client_id}   payments:record
//   GET  /payments?month=&method= · GET /payments/:id   invoices:read_all
//   POST /payments/:id/refund {amount_cents, reason, client_id}   payments:refund (owners)
//   GET  /contacts/:id/credits · POST /contacts/:id/credits {kind, amount_cents, note, client_id}   credits:issue (the office up to $100)
//   POST /credits/:id/keep                           credits:issue       an overpayment kept as credit
//   POST /contacts/:id/card-link {channels?}         invoices:send       a save-card portal link, texted
//   GET  /money/contacts/:id                         invoices:read_all   the contact's Money tab
//   GET  /money/summary?from=&to=                    invoices:read_all
//   GET  /money/status · POST /money/payments-mode   settings:owner      Settings → Payments
//   GET  /autopay/preview?month= · GET /autopay/runs · GET /autopay/runs/:id   invoices:read_all
//   GET  /visits/:id/payment · POST /visits/:id/payments · POST /visits/:id/pay-link   payments:record (a tech: own visit)
//   POST /invoices/:id/pay-qr                        invoices:send       scan to pay: a fresh pay link for the QR on the Invoice screen
// cfg/money is an owner-only settings page through the core settings routes.

import { getRecord, getRecords, listRel, readIndex, updateRecord, getSettingWithEtag, putSetting } from "../../../crm-store.mjs";
import { isId, newId } from "../../core/ids.mjs";
import { now, nowMs, localDate, addLocalDays, isLocalDate } from "../../core/clock.mjs";
import { InputError, NotFoundError, ConflictError, ForbiddenError, StaleError } from "../../core/errors.mjs";
import { techView, TECH_WINDOW, isTechRole } from "../../core/perms.mjs";
import { sendMessage } from "../../core/send.mjs";
import { integrationsStatus } from "../../adapters/index.mjs";
import { readHealth } from "../../core/lanes.mjs";
import { sandboxed } from "../../core/context.mjs";
import { flags as flagsOf, isOverdue, isProcessing, chargingLive } from "./balance.mjs";
import { validateLine } from "./types.mjs";
import { W, today, moneySettings, liveContact, nameOf, moneyStats, sysModeOf, touchMoneyStats } from "./common.mjs";
import {
  getInvoice, paymentsOf, makeInvoice, clientInvoiceId, issueInvoice, sendInvoice, voidInvoice, writeOff, linesFromJob, jobInvoiceSlot, ensureJobInvoice, billingFor,
} from "./invoices.mjs";
import { upsertPayment, payId, isClientId, getPayment, tipSplitFor } from "./upsert.mjs";
import { refundPayment } from "./refunds.mjs";
import { startChargeRun } from "./charge.mjs";
import { creditsOf, issueCredit, releaseCredit } from "./credits.mjs";
import { cardFor, cardStatus, plansWithoutCard } from "./cards.mjs";
import { previewAutopay, listRuns, nextMonth, thisMonth, MONTH_RE } from "./autopay.mjs";
import { resolvePayments, payments, mayMoveMoney } from "./gate.mjs";
import { cardLink } from "./automations.mjs";
import { payRefusal } from "./checkout.mjs";
import { qrPayLink, qrRefusal, noteQrShown, STAFF as STAFF_QR } from "./scan.mjs";

const R = (method, path, perm, subject, handler, extra = {}) => ({ method, path, auth: "session", perm, subject, mode: "inline", handler, ...extra });
const view = (r) => { const { _w, ...rest } = r || {}; return rest; };
const officeMoney = (ctx) => ctx.can("invoices:read_all");
const YEAR_RE = /^20\d{2}$/;

// ------------------------------------------------------------ tech scope (§4.6)

function inTechWindow(v) {
  const t = today();
  return v.date >= addLocalDays(t, -TECH_WINDOW.before) && v.date <= addLocalDays(t, TECH_WINDOW.after);
}
// The visit of a /visits/:id route: the office's, or a tech's own in the window (404 otherwise).
async function visitFor(ctx, id) {
  if (!isId(id, "visit")) throw new NotFoundError("That visit isn't there.");
  const g = await getRecord("visit", id);
  if (!g || g.data.deleted_at) throw new NotFoundError("That visit isn't there.");
  const v = g.data;
  if (!officeMoney(ctx)) {
    const mine = !!ctx.user && (v.assignee_ids || []).includes(ctx.user.id) && inTechWindow(v);
    if (!mine) throw new NotFoundError("That visit isn't there.");
  }
  return v;
}
// Is this invoice on one of the tech's own visits' jobs (in the window)?
async function techMayRead(ctx, inv) {
  if (!ctx.user || !(inv.job_ids || []).length) return false;
  const t = today();
  const rows = await listRel("tech-visits", ctx.user.id, { from: addLocalDays(t, -TECH_WINDOW.before), to: addLocalDays(t, TECH_WINDOW.after), limit: 300, newestFirst: false });
  const visits = (await getRecords("visit", rows.map((r) => r.id))).filter(Boolean).map((g) => g.data);
  return visits.some((v) => !v.deleted_at && (v.assignee_ids || []).includes(ctx.user.id) && inv.job_ids.includes(v.job_id));
}

// ------------------------------------------------------------ lists

const rowOut = (r, day) => ({ ...r, od: r.st === "open" && r.due && r.due < day && r.bal > 0 ? 1 : 0 });

async function listInvoices(ctx) {
  const q = ctx.query;
  const day = today();
  const contact = q.get("contact");
  if (contact) {
    if (!isId(contact, "contact")) throw new InputError("That isn't a contact.", "contact");
    const rels = await listRel("contact-invoices", contact, { limit: 100 });
    const recs = (await getRecords("invoice", rels.map((r) => r.id))).filter(Boolean).map((g) => g.data).filter((r) => !r.deleted_at);
    const { invoiceRow } = await import("./types.mjs");
    return { data: recs.map((r) => rowOut({ id: r.id, ...invoiceRow(r) }, day)) };
  }
  const status = q.get("status") || "open";
  const open = (await readIndex("invoices", "open")).rows;
  const counts = {
    open: open.filter((r) => r.st === "open").length, draft: open.filter((r) => r.st === "draft").length, overdue: open.filter((r) => rowOut(r, day).od).length,
    failed: open.filter((r) => r.st === "open" && r.af).length, processing: open.filter((r) => r.pr).length, overpaid: open.filter((r) => r.ex > 0 && !r.xk).length,
  };
  const totals = { open_cents: open.filter((r) => r.st === "open").reduce((s, r) => s + r.bal, 0), overdue_cents: open.filter((r) => rowOut(r, day).od).reduce((s, r) => s + r.bal, 0) };
  let rows;
  if (["paid", "void", "uncollectible", "closed"].includes(status)) {
    const year = YEAR_RE.test(q.get("year") || "") ? q.get("year") : day.slice(0, 4);
    const closed = (await readIndex("invoices", year)).rows;
    rows = closed.filter((r) => (status === "closed" ? true : r.st === status));
    counts[status] = rows.length;
  } else if (status === "overdue") rows = open.filter((r) => rowOut(r, day).od);
  else if (status === "draft") rows = open.filter((r) => r.st === "draft");
  else if (status === "failed") rows = open.filter((r) => r.st === "open" && r.af);
  else if (status === "overpaid") rows = open.filter((r) => r.ex > 0 && !r.xk);
  else if (status === "all") rows = open;
  else rows = open.filter((r) => r.st === "open");
  rows = rows.map((r) => rowOut(r, day)).sort((a, b) => String(b.iss || b.at || "").localeCompare(String(a.iss || a.at || "")) || String(b.id).localeCompare(String(a.id)));
  return { data: rows.slice(0, 500), meta: { counts, totals, more: rows.length > 500 } };
}

async function listPayments(ctx) {
  const q = ctx.query;
  const month = MONTH_RE.test(q.get("month") || "") ? q.get("month") : thisMonth();
  const method = q.get("method") || "";
  const rows = (await readIndex("payments", month)).rows.filter((r) => !method || r.m === method);
  const real = rows.filter((r) => r.st === "succeeded" && !r.sim);
  const sum = (list, f) => list.reduce((s, r) => s + f(r), 0);
  const pays = real.filter((r) => r.k === "payment"), refs = real.filter((r) => r.k === "refund");
  const byMethod = {};
  for (const r of pays) byMethod[r.m] = (byMethod[r.m] || 0) + r.a + r.tip;
  return {
    data: rows.sort((a, b) => String(b.on).localeCompare(String(a.on)) || String(b.id).localeCompare(String(a.id))).slice(0, 500),
    meta: {
      month,
      totals: {
        collected_cents: sum(pays, (r) => r.a + r.tip) - sum(refs, (r) => r.a + r.tip), payments_cents: sum(pays, (r) => r.a), tips_cents: sum(pays, (r) => r.tip) - sum(refs, (r) => r.tip),
        fees_cents: sum(pays, (r) => r.fee), refunds_cents: sum(refs, (r) => r.a + r.tip), count: pays.length, simulated: rows.filter((r) => r.sim).length,
        processing: rows.filter((r) => r.st === "processing").length, failed: rows.filter((r) => r.st === "failed").length,
      },
      by_method: byMethod,
    },
  };
}

// ------------------------------------------------------------ one invoice

// Until the switch, an invoice or payment the import brought in is Rotor's:
// it is read here and changed there (a payment recorded on it in both
// places would count twice after the next import). People aren't stopped by
// the parallel-run guard, so the money routes say it themselves.
const ROTOR_OWNS = "This one is still Rotor's until the switch. Change it in Rotor and the next import brings it over.";
const rotorOwns = (rec, mode) => !!(rec && rec.import) && (mode && mode.system_of_record) !== "crm";
async function assertOurs(ctx, rec) {
  if (rotorOwns(rec, await ctx.sysMode())) throw new ConflictError(ROTOR_OWNS, { code: "rotor_owns" });
}

async function invoiceData(ctx, inv, etag) {
  const mode = await ctx.sysMode();
  const [pays, contact, card] = await Promise.all([paymentsOf(inv.id), liveContact(inv.contact_id), cardFor(inv.contact_id)]);
  const f = flagsOf(inv, today(), nowMs());
  const owner = ctx.can("invoices:void");
  const online = await payRefusal(inv, { sor: mode.system_of_record });
  const ours = !rotorOwns(inv, mode);
  const billable = !online || online.code !== "not_yet";          // before the switch a card is charged only for a sandboxed customer
  return {
    invoice: view(inv), etag, flags: f, payments: pays.map(view), rotor_owned: !ours,
    contact: contact ? { id: contact.id, display_name: nameOf(contact), has_sms: (contact.phones || []).some((p) => p.sms !== false), has_email: (contact.emails || []).length > 0, test: !!(contact.flags && contact.flags.test) } : null,
    card: { status: card.status, usable: card.usable, brand: card.brand || null, last4: card.last4 || null, kind: card.kind },
    sandboxed: sandboxed(inv, contact), system_of_record: mode.system_of_record, online: online ? online.code : "ok",
    can: {
      edit: ours && ctx.can("invoices:write") && inv.status === "draft", issue: ours && ctx.can("invoices:send") && inv.status === "draft", send: ours && ctx.can("invoices:send") && inv.status === "open" && inv.balance_cents > 0,
      record: ours && ctx.can("payments:record") && inv.status === "open" && inv.balance_cents > 0 && !f.charging,
      charge: ours && billable && ctx.can("payments:charge") && inv.status === "open" && inv.balance_cents > 0 && !f.charging && !f.processing,
      refund: ours && ctx.can("payments:refund"), void: ours && owner && ["draft", "open"].includes(inv.status), write_off: ours && owner && inv.status === "open",
      card_link: ours && billable && ctx.can("invoices:send"),
      // scan to pay: the QR the customer pays from (the screen says why when there is none)
      qr: ours && ctx.can("invoices:send") && inv.status === "open" && inv.balance_cents > 0,
    },
  };
}

async function getOne(ctx) {
  const g = await getInvoice(ctx.params.id);
  if (!officeMoney(ctx)) {
    if (!(await techMayRead(ctx, g.data))) throw new NotFoundError("That invoice isn't here.");
    return { data: { invoice: techView("invoice", g.data) } };
  }
  return { data: await invoiceData(ctx, g.data, g.etag), etag: g.etag };
}

const LINE_KINDS_STAFF = ["service", "discount", "fee"];
function cleanLines(list, base = "lines") {
  if (!Array.isArray(list) || !list.length) throw new InputError("Add at least one line.", base);
  if (list.length > 40) throw new InputError("Keep it under 40 lines.", base);
  return list.map((l, i) => {
    if (!l || typeof l !== "object") throw new InputError("Expected a line.", `${base}.${i}`);
    const kind = LINE_KINDS_STAFF.includes(l.kind) ? l.kind : "service";
    const unit = Number.isSafeInteger(l.unit_cents) ? Math.abs(l.unit_cents) : null;
    if (unit === null) throw new InputError("Enter a price.", `${base}.${i}.unit_cents`);
    const out = validateLine({ id: typeof l.id === "string" && /^[a-z0-9_-]{1,40}$/i.test(l.id) ? l.id : `m${i + 1}`, kind, description: l.description, qty_milli: l.qty_milli ?? 1000, unit_cents: kind === "discount" ? -unit : unit }, `${base}.${i}`);
    return out;
  });
}

async function createInvoice(ctx) {
  const b = ctx.body || {};
  const c = await liveContact(b.contact_id);
  if (!c) throw new InputError("Pick the customer.", "contact_id");
  const kind = b.kind === "fee" ? "fee" : "standard";
  const jobIds = [...new Set((Array.isArray(b.job_ids) ? b.job_ids : []).filter((x) => isId(x, "job")))].slice(0, 10);
  let lines;
  if (Array.isArray(b.lines) && b.lines.length) lines = cleanLines(b.lines);
  else if (jobIds.length) {
    lines = [];
    for (const g of (await getRecords("job", jobIds)).filter(Boolean)) { if (g.data.contact_id !== c.id) throw new InputError("That job belongs to someone else.", "job_ids"); lines.push(...linesFromJob(g.data)); }
    if (!lines.length) throw new InputError("Those jobs have nothing to bill.", "job_ids");
  } else throw new InputError("Add at least one line.", "lines");
  const id = isClientId(b.client_id) ? clientInvoiceId(b.client_id.toLowerCase()) : newId("invoice");
  const due = b.due_on && isLocalDate(b.due_on) ? b.due_on : undefined;
  const inv = await makeInvoice({
    invoice: {
      id, kind, contact_id: c.id, job_ids: jobIds, ...(isId(b.plan_id, "plan") ? { plan_id: b.plan_id } : {}), lines, ...(due ? { due_on: due } : {}),
      ...(b.customer_note ? { customer_note: String(b.customer_note).slice(0, 1000) } : {}), origin: "staff",
    },
    issue: b.issue === true, channels: Array.isArray(b.channels) ? b.channels : undefined, links: { job_ids: jobIds }, credit: kind === "standard" && b.use_credit !== false,
  }, ctx.write());
  const g = await getInvoice(inv.id);
  return { status: 201, data: { invoice: view(g.data) }, etag: g.etag };
}

async function invoiceJob(ctx) {
  if (!isId(ctx.params.id, "job")) throw new NotFoundError("That job isn't there.");
  const jg = await getRecord("job", ctx.params.id);
  if (!jg || jg.data.deleted_at) throw new NotFoundError("That job isn't there.");
  const slot = await jobInvoiceSlot(jg.data.id);
  if (slot.invoice) return { data: { invoice: view(slot.invoice), existed: true } };
  const d = await billingFor(jg.data);
  if (!d.bill && !(d.reason === "billed_by_cycle" && ctx.body && ctx.body.force === true)) {
    throw new ConflictError({ not_billable: "This kind of job isn't billed.", zero: "There's nothing to bill on this job.", billed_by_cycle: "This plan visit is billed with the plan on the 1st.", missing: "That job isn't there." }[d.reason] || "This job can't be invoiced.", { code: d.reason });
  }
  const b = ctx.body || {};
  const inv = await ensureJobInvoice(jg.data, { origin: "staff", decision: { ...d, bill: true }, ...(typeof b.issue === "boolean" ? { issue: b.issue } : {}) }, ctx.write());
  return { status: 201, data: { invoice: view(inv) } };
}

async function patchInvoice(ctx) {
  if (!ctx.ifMatch) throw new InputError("This change needs the version you edited (If-Match).", "if-match");
  const b = ctx.body || {};
  const g = await getInvoice(ctx.params.id);
  await assertOurs(ctx, g.data);
  const patch = {};
  if (b.lines !== undefined) {
    if (g.data.status !== "draft") throw new ConflictError("Only a draft's lines can change. Void this one and make a new invoice.");
    // credits the CRM applied stay as they are; the office edits the rest
    const kept = (g.data.lines || []).filter((l) => ["credit", "deposit_credit"].includes(l.kind));
    patch.lines = [...cleanLines(b.lines), ...kept];
  }
  if (b.due_on !== undefined) { if (!isLocalDate(b.due_on)) throw new InputError("Use a date like 2026-11-17.", "due_on"); patch.due_on = b.due_on; }
  for (const k of ["customer_note", "office_note"]) if (b[k] !== undefined) patch[k] = b[k] === null ? "" : String(b[k]);
  if (!Object.keys(patch).length) throw new InputError("Nothing to change.");
  if (["void", "uncollectible"].includes(g.data.status)) throw new ConflictError("This invoice is closed.");
  const r = await updateRecord("invoice", g.data.id, (inv) => ({ ...inv, ...patch }), { ...ctx.write(), ifMatch: ctx.ifMatch });
  await touchMoneyStats(r.data.contact_id, ctx.write());
  return { data: { invoice: view(r.data) }, etag: r.etag };
}

const act = (fn) => async (ctx) => {
  await assertOurs(ctx, (await getInvoice(ctx.params.id)).data);
  const inv = await fn(ctx);
  const g = await getInvoice(inv.id);
  return { data: await invoiceData(ctx, g.data, g.etag), etag: g.etag };
};

async function chargeRoute(ctx) {
  await assertOurs(ctx, (await getInvoice(ctx.params.id)).data);
  const run = await startChargeRun(ctx.params.id, ctx.body || {}, ctx);
  return { status: 202, data: { run_id: run.id } };
}

// ------------------------------------------------------------ recording cash and checks

const MANUAL = ["cash", "check", "other"];
async function recordManual(ctx, inv, b, { visit } = {}) {
  if (!MANUAL.includes(b.method)) throw new InputError("Cash, check or other?", "method");
  if (!Number.isSafeInteger(b.amount_cents) || b.amount_cents <= 0 || b.amount_cents > 10000000) throw new InputError("How much did they pay?", "amount_cents");
  const tip = b.tip_cents === undefined || b.tip_cents === null ? 0 : b.tip_cents;
  if (!Number.isSafeInteger(tip) || tip < 0 || tip > 500000) throw new InputError("That tip doesn't look right.", "tip_cents");
  if (!isClientId(b.client_id)) throw new InputError("This payment needs its request id.", "client_id");
  const on = b.received_on === undefined || b.received_on === null || b.received_on === "" ? today() : b.received_on;
  if (!isLocalDate(on) || on > today()) throw new InputError("Use a date up to today.", "received_on");
  if (inv.status === "draft") throw new ConflictError("Issue this invoice first.");
  if (["void", "uncollectible"].includes(inv.status)) throw new ConflictError("This invoice is closed.");
  if (chargingLive(inv, nowMs())) throw new ConflictError("A card charge is running on this invoice. Try again in a minute.");
  const id = payId.client(b.client_id.toLowerCase());
  const had = await getRecord("payment", id);
  if (!had && inv.status === "paid") throw new ConflictError("This invoice is already paid.");
  const out = await upsertPayment({
    id, contact_id: inv.contact_id, contact_name: inv.contact_name, invoice_id: inv.id, invoice_number: inv.number, job_id: (visit && visit.job_id) || (inv.job_ids || [])[0], plan_id: inv.plan_id,
    kind: "payment", method: b.method, status: "succeeded", amount_cents: b.amount_cents, tip_cents: tip, fee_cents: 0, received_on: on,
    ...(b.reference ? { reference: String(b.reference).slice(0, 200) } : {}), tip_split: await tipSplitFor(visit ? { job_ids: [visit.job_id] } : inv, tip),
    recorded_by: ctx.user ? ctx.user.id : "system", ...(b.note ? { note: String(b.note).slice(0, 500) } : {}),
  }, ctx.write());
  return out;
}

async function recordRoute(ctx) {
  const g = await getInvoice(ctx.params.id);
  if (!officeMoney(ctx) && !(await techMayRead(ctx, g.data))) throw new NotFoundError("That invoice isn't here.");
  await assertOurs(ctx, g.data);
  const out = await recordManual(ctx, g.data, ctx.body || {});
  if (!officeMoney(ctx)) return { status: out.created ? 201 : 200, data: { payment: techView("payment", out.payment), invoice: out.invoice ? techView("invoice", out.invoice.data) : null } };
  return { status: out.created ? 201 : 200, data: { payment: view(out.payment), invoice: out.invoice ? view(out.invoice.data) : null } };
}

async function refundRoute(ctx) {
  await assertOurs(ctx, (await getPayment(ctx.params.id)).data);
  const out = await refundPayment(ctx.params.id, ctx.body || {}, ctx.write());
  return { status: 201, data: { refund: view(out.refund), payment: view(out.payment), invoice: out.invoice ? view(out.invoice) : null } };
}

async function getPaymentRoute(ctx) {
  const g = await getPayment(ctx.params.id);
  const refunds = g.data.kind === "payment" ? (await paymentsOf(g.data.invoice_id || "in_00000000000000000000").catch(() => [])).filter((p) => p.refund_of === g.data.id) : [];
  return { data: { payment: view(g.data), refunds: refunds.map(view), can: { refund: ctx.can("payments:refund") && g.data.kind === "payment" && g.data.status === "succeeded" && (g.data.refunded_cents || 0) < g.data.total_cents } } };
}

// ------------------------------------------------------------ the tech's Visit screen: Collect payment

// The invoice of a visit's job (what's left to pay), for the "Collect payment" sheet.
async function visitPayment(ctx) {
  const v = await visitFor(ctx, ctx.params.id);
  const tech = !officeMoney(ctx);
  const jg = isId(v.job_id, "job") ? await getRecord("job", v.job_id).catch(() => null) : null;
  const job = jg && !jg.data.deleted_at ? jg.data : null;
  let inv = null;
  for (const iid of ((job && job.invoice_ids) || []).slice(-5).reverse()) {
    const g = isId(iid, "invoice") ? await getRecord("invoice", iid).catch(() => null) : null;
    if (g && !g.data.deleted_at && g.data.status !== "void") { inv = g.data; break; }
  }
  const prices = !tech || ctx.can("visits:prices", { type: "visit", record: v });
  return {
    data: {
      invoice: inv ? (tech ? techView("invoice", inv) : { id: inv.id, number: inv.number, status: inv.status, balance_cents: inv.balance_cents, total_cents: inv.total_cents }) : null,
      job_done: !!job && job.status === "completed", billable: !!job && job.billable !== false,
      ...(prices && job ? { job_total_cents: (job.totals && job.totals.total_cents) || 0 } : {}),
      can: { record: !!inv && inv.status === "open" && inv.balance_cents > 0, link: !!inv && inv.status === "open" && inv.balance_cents > 0, make: !inv && !!job && job.billable !== false && ((job.totals && job.totals.total_cents) || 0) > 0 },
    },
  };
}

// The job's invoice for an on-site payment: found, or made now (the same
// invoice the job.completed listener would make: its id derives from the job).
async function visitInvoice(ctx, v) {
  const jg = isId(v.job_id, "job") ? await getRecord("job", v.job_id).catch(() => null) : null;
  if (!jg || jg.data.deleted_at) throw new ConflictError("This visit has no job to bill.");
  const slot = await jobInvoiceSlot(jg.data.id);
  if (slot.invoice) {
    await assertOurs(ctx, slot.invoice);
    if (slot.invoice.status === "draft") return issueInvoice(slot.invoice.id, { silent: true }, ctx.write());
    return slot.invoice;
  }
  const d = await billingFor(jg.data);
  if (!d.bill) throw new ConflictError({ not_billable: "This kind of visit isn't billed.", zero: "There's nothing to bill on this visit.", billed_by_cycle: "This plan visit is billed with the plan on the 1st." }[d.reason] || "This visit can't be billed.", { code: d.reason });
  return ensureJobInvoice(jg.data, { origin: "on_site", decision: d, issue: false }, ctx.write()).then((inv) => (inv.status === "draft" ? issueInvoice(inv.id, { silent: true }, ctx.write()) : inv));
}

async function visitRecord(ctx) {
  const v = await visitFor(ctx, ctx.params.id);
  const b = ctx.body || {};
  // checked before anything is made: a bad form never leaves an invoice behind
  if (!MANUAL.includes(b.method)) throw new InputError("Cash, check or other?", "method");
  if (!Number.isSafeInteger(b.amount_cents) || b.amount_cents <= 0) throw new InputError("How much did they pay?", "amount_cents");
  if (!isClientId(b.client_id)) throw new InputError("This payment needs its request id.", "client_id");
  const inv = await visitInvoice(ctx, v);
  const out = await recordManual(ctx, inv, b, { visit: v });
  const tech = !officeMoney(ctx);
  return { status: out.created ? 201 : 200, data: { payment: tech ? techView("payment", out.payment) : view(out.payment), invoice: out.invoice ? (tech ? techView("invoice", out.invoice.data) : view(out.invoice.data)) : null } };
}

// Scan to pay (scan.mjs): a fresh pay link for the QR the customer scans
// with their own phone. The answer is what the full-screen code shows: the
// link, how long it works, the number, what's left, the customer's first
// name. Shown again, it is a new link (links are kept only as a hash).
async function payQrAnswer(ctx, inv) {
  const why = await qrRefusal(inv, (await ctx.sysMode()).system_of_record);
  if (why) throw new ConflictError(why.message, { code: why.code });
  const by = ctx.user ? ctx.user.id : "system";
  const [link, contact] = await Promise.all([qrPayLink(inv, by), liveContact(inv.contact_id)]);
  // on the invoice's history (best effort: the code works whether or not this lands)
  await noteQrShown(inv.id, by, ctx.write()).catch((e) => console.error(`crm:money: a pay code show wasn't noted (${e && (e.code || e.name)})`));
  return { status: 201, data: { url: link.url, expires_at: link.expires_at, number: inv.number, balance_cents: inv.balance_cents, first_name: (contact && contact.first_name) || null } };
}

// POST /invoices/:id/pay-qr (the Invoice screen's "Show QR to pay")
async function invoicePayQr(ctx) {
  const g = await getInvoice(ctx.params.id);
  return payQrAnswer(ctx, g.data);
}

// The QR on Collect payment: the visit's invoice (made and issued here
// first when the worker hasn't yet; the customer is standing right there,
// so nothing is texted), then the same code.
async function visitPayLink(ctx) {
  const v = await visitFor(ctx, ctx.params.id);
  // a customer Rotor still bills: the reason, before any invoice is made for a code nobody could pay
  const sor = (await ctx.sysMode()).system_of_record;
  if (!(await mayMoveMoney(v, { sor }))) throw new ConflictError(STAFF_QR.not_yet, { code: "not_yet" });
  const inv = await visitInvoice(ctx, v);
  if (inv.status === "paid" || (inv.status === "open" && !(inv.balance_cents > 0))) throw new ConflictError(inv.status === "paid" ? "This visit is already paid." : "There's nothing to pay on this visit.", { code: inv.status === "paid" ? "paid" : "nothing" });
  return payQrAnswer(ctx, inv);
}

// ------------------------------------------------------------ credits, the card link, the contact's tab

async function creditsRoute(ctx) {
  if (!(await liveContact(ctx.params.id))) throw new NotFoundError("That contact isn't here.");
  return { data: await creditsOf(ctx.params.id) };
}
async function issueCreditRoute(ctx) {
  const cr = await issueCredit(ctx.params.id, ctx.body || {}, ctx);
  return { status: 201, data: { credit: view(cr), ...(await creditsOf(ctx.params.id)) } };
}
async function keepCreditRoute(ctx) {
  const cr = await releaseCredit(ctx.params.id, ctx);
  return { data: { credit: view(cr) } };
}

async function cardLinkRoute(ctx) {
  const c = await liveContact(ctx.params.id);
  if (!c) throw new NotFoundError("That contact isn't here.");
  const b = ctx.body || {};
  const link = await cardLink(c.id, ctx.user ? ctx.user.id : "system");
  const r = await sendMessage({
    contact_id: c.id, channel: "sms", template_key: "card_link", vars: { card_link: link.url }, related: {}, origin: { kind: "user" }, category: "service",
    ...(isClientId(b.client_id) ? { client_id: b.client_id } : {}),
  }, { ...ctx.write(), sysMode: await ctx.sysMode(), deploy: ctx.deploy });
  return { status: 201, data: { status: r.status, mode: r.mode || null, reason: r.reason || null, outbox_id: r.outbox_id || null } };
}

async function contactMoney(ctx) {
  const c = await liveContact(ctx.params.id);
  if (!c) throw new NotFoundError("That contact isn't here.");
  const day = today();
  const { invoiceRow, paymentRow } = await import("./types.mjs");
  const [irel, prel, credits, card] = await Promise.all([
    listRel("contact-invoices", c.id, { limit: 30 }), listRel("contact-payments", c.id, { limit: 30 }), creditsOf(c.id), cardStatus(c.id),
  ]);
  const [inv, pay] = await Promise.all([getRecords("invoice", irel.slice(0, 12).map((r) => r.id)), getRecords("payment", prel.slice(0, 12).map((r) => r.id))]);
  const st = await moneyStats(c.id);
  return {
    data: {
      invoices: inv.filter(Boolean).map((g) => rowOut({ id: g.data.id, ...invoiceRow(g.data) }, day)), payments: pay.filter(Boolean).map((g) => ({ id: g.data.id, ...paymentRow(g.data) })),
      more: { invoices: irel.length > 12, payments: prel.length > 12 }, credit: { balance_cents: credits.balance_cents, held_cents: credits.held_cents, rows: credits.credits.slice(0, 20).map(view) },
      card, open_balance_cents: st.open_balance_cents || 0, lifetime_cents: st.lifetime_cents || 0,
      can: { credit: ctx.can("credits:issue"), invoice: ctx.can("invoices:write"), card_link: ctx.can("invoices:send") },
    },
  };
}

// ------------------------------------------------------------ summary, status, autopay

async function summary(ctx) {
  const q = ctx.query;
  const day = today();
  const from = isLocalDate(q.get("from")) ? q.get("from") : `${day.slice(0, 7)}-01`;
  const to = isLocalDate(q.get("to")) ? q.get("to") : day;
  if (to < from) throw new InputError("The end comes after the start.", "to");
  const months = [];
  for (let m = from.slice(0, 7); m <= to.slice(0, 7) && months.length < 13; m = nextMonth(m)) months.push(m);
  const rows = [];
  for (const m of months) rows.push(...(await readIndex("payments", m)).rows.filter((r) => r.on >= from && r.on <= to && r.st === "succeeded" && !r.sim));
  const pays = rows.filter((r) => r.k === "payment"), refs = rows.filter((r) => r.k === "refund");
  const sum = (l, f) => l.reduce((s, r) => s + f(r), 0);
  const open = (await readIndex("invoices", "open")).rows.filter((r) => r.st === "open");
  return {
    data: {
      from, to,
      // revenue = Σ succeeded payments − Σ succeeded refunds, cash basis (§5.6); simulated payments never count
      revenue_cents: sum(pays, (r) => r.a + r.tip) - sum(refs, (r) => r.a + r.tip), tips_cents: sum(pays, (r) => r.tip) - sum(refs, (r) => r.tip), fees_cents: sum(pays, (r) => r.fee),
      refunds_cents: sum(refs, (r) => r.a + r.tip), payments: pays.length, open_cents: sum(open, (r) => r.bal), overdue_cents: sum(open.filter((r) => r.due && r.due < day && r.bal > 0), (r) => r.bal),
      open_count: open.length, partial: months.length >= 13,
    },
  };
}

async function statusRoute(ctx) {
  const mode = await ctx.sysMode();
  const { data: integrations } = await getSettingWithEtag("integrations");
  const r = resolvePayments({ deploy: ctx.deploy, settings: integrations, mode });
  const core = integrationsStatus({ deploy: ctx.deploy, settings: integrations, mode }).integrations.payments;
  const [health, settings, cards] = await Promise.all([readHealth().catch(() => ({})), moneySettings(), plansWithoutCard().catch(() => null)]);
  return {
    data: {
      mode: r.mode, wanted: r.wanted, refused: r.refused, system_of_record: r.sor, production: !!(ctx.deploy && ctx.deploy.prod),
      // names and kinds only, never a value
      keys: { STRIPE_SECRET_KEY: r.keys.live, STRIPE_TEST_SECRET_KEY: r.keys.test, STRIPE_WEBHOOK_SECRET: r.webhook.live ? "set" : "missing", STRIPE_TEST_WEBHOOK_SECRET: r.webhook.test ? "set" : "missing" },
      core_effective: core.effective, foreign_events: health.stripe_foreign_events || 0, foreign_at: health.stripe_foreign_at || null, settings, autopay_cards: cards,
      webhooks: { live: "/api/crm/hooks/stripe", test: "/api/crm/hooks/stripe-test" },
    },
  };
}

// POST /money/payments-mode { mode }: dry_run | test | live. A live setting is
// refused while Rotor is the system of record (the owner's rule).
async function setPaymentsMode(ctx) {
  const want = String((ctx.body || {}).mode || "");
  if (!["dry_run", "test", "live", "off"].includes(want)) throw new InputError("Pick dry run, test or live.", "mode");
  const mode = await ctx.sysMode();
  const env = process.env;
  const { keyKind } = await import("../../adapters/payments-stripe.mjs");
  if (want === "live") {
    if (mode.system_of_record !== "crm") throw new ConflictError("Live payments wait for the switch from Rotor. Until then use dry run, or test with a test key.", { code: "live_waits_for_cutover" });
    if (keyKind(env.STRIPE_SECRET_KEY) !== "live") throw new ConflictError("Netlify has no live Stripe key yet (STRIPE_SECRET_KEY).", { code: "live_key_missing" });
  }
  if (want === "test") {
    const k = keyKind(env.STRIPE_TEST_SECRET_KEY);
    if (k === "live") throw new ConflictError("STRIPE_TEST_SECRET_KEY holds a live key. Put a test key there (it starts with sk_test_ or rk_test_).", { code: "live_key_in_test_slot" });
    if (k !== "test") throw new ConflictError("Netlify has no test Stripe key yet (STRIPE_TEST_SECRET_KEY).", { code: "test_key_missing" });
  }
  for (let i = 0; i < 3; i++) {
    const cur = await getSettingWithEtag("integrations");
    try {
      await putSetting("integrations", { ...cur.data, payments: { ...(cur.data.payments || {}), mode: want } }, { ...ctx.write(), ifMatch: cur.etag || "new" });
      return statusRoute(ctx);
    } catch (e) { if (!(e instanceof StaleError) || i === 2) throw e; }
  }
  throw new ConflictError("Settings kept changing. Try again.");
}

async function previewRoute(ctx) {
  const q = ctx.query;
  const month = MONTH_RE.test(q.get("month") || "") ? q.get("month") : nextMonth(thisMonth());
  const p = await previewAutopay(month, { mode: await ctx.sysMode() });
  return { data: p };
}
async function runsRoute() { return { data: await listRuns() }; }
async function runRoute(ctx) {
  if (!isId(ctx.params.id, "autopay_run")) throw new NotFoundError("That run isn't here.");
  const g = await getRecord("autopay_run", ctx.params.id);
  if (!g) throw new NotFoundError("That run isn't here.");
  const plans = (await getRecords("plan", [...new Set(g.data.items.map((i) => i.plan_id))].slice(0, 200))).filter(Boolean);
  const names = Object.fromEntries(plans.map((p) => [p.data.id, { contact_name: p.data.contact_name || "", plan_name: p.data.name }]));
  return { data: { run: view(g.data), names } };
}

export const moneyRoutes = [
  R("GET", "/invoices", "invoices:read_all", "none", listInvoices),
  // making an invoice is an op (number, record, credits, links, issue): its calls add up
  R("POST", "/invoices", "invoices:write", "none", createInvoice, { maxCalls: 120 }),
  R("POST", "/jobs/:id/invoice", "invoices:write", "required", invoiceJob, { maxCalls: 120 }),
  R("GET", "/invoices/:id", "invoices:read", "required", getOne, { maxCalls: 40 }),
  R("PATCH", "/invoices/:id", "invoices:write", "required", patchInvoice),
  R("POST", "/invoices/:id/issue", "invoices:send", "required", act((ctx) => issueInvoice(ctx.params.id, { channels: (ctx.body || {}).channels }, ctx.write())), { maxCalls: 50 }),
  R("POST", "/invoices/:id/send", "invoices:send", "required", act((ctx) => sendInvoice(ctx.params.id, { channels: (ctx.body || {}).channels }, ctx.write())), { maxCalls: 50 }),
  R("POST", "/invoices/:id/void", "invoices:void", "required", act((ctx) => voidInvoice(ctx.params.id, { reason: (ctx.body || {}).reason }, ctx.write())), { maxCalls: 50 }),
  R("POST", "/invoices/:id/write-off", "invoices:void", "required", act((ctx) => writeOff(ctx.params.id, ctx.write())), { maxCalls: 50 }),
  R("POST", "/invoices/:id/charge", "payments:charge", "required", chargeRoute, { mode: "run" }),
  R("POST", "/invoices/:id/payments", "payments:record", "required", recordRoute, { maxCalls: 60, replaySafe: true }),
  R("GET", "/payments", "invoices:read_all", "none", listPayments),
  R("GET", "/payments/:id", "invoices:read_all", "required", getPaymentRoute),
  R("POST", "/payments/:id/refund", "payments:refund", "required", refundRoute, { maxCalls: 60 }),
  R("GET", "/contacts/:id/credits", "invoices:read_all", "required", creditsRoute, { maxCalls: 120 }),
  R("POST", "/contacts/:id/credits", "credits:issue", "required", issueCreditRoute, { maxCalls: 130 }),
  // the same people who could refund the extra decide to keep it (owners)
  R("POST", "/credits/:id/keep", "payments:refund", "required", keepCreditRoute),
  R("POST", "/contacts/:id/card-link", "invoices:send", "required", cardLinkRoute, { maxCalls: 50 }),
  R("GET", "/money/contacts/:id", "invoices:read_all", "required", contactMoney, { maxCalls: 160 }),
  R("GET", "/money/summary", "invoices:read_all", "none", summary, { maxCalls: 40 }),
  R("GET", "/money/status", "settings:owner", "none", statusRoute, { maxCalls: 900 }),
  R("POST", "/money/payments-mode", "settings:owner", "none", setPaymentsMode, { maxCalls: 900 }),
  R("GET", "/autopay/preview", "invoices:read_all", "none", previewRoute, { maxCalls: 1200 }),
  R("GET", "/autopay/runs", "invoices:read_all", "none", runsRoute),
  R("GET", "/autopay/runs/:id", "invoices:read_all", "required", runRoute, { maxCalls: 250 }),
  R("GET", "/visits/:id/payment", "payments:record", "required", visitPayment),
  // the visit's invoice may be made and issued here first, then the payment recorded
  R("POST", "/visits/:id/payments", "payments:record", "required", visitRecord, { maxCalls: 200, replaySafe: true }),
  R("POST", "/visits/:id/pay-link", "payments:record", "required", visitPayLink, { maxCalls: 160, secret: true, idempotent: false }),
  // the answer carries a fresh bearer link: never kept for replay
  R("POST", "/invoices/:id/pay-qr", "invoices:send", "required", invoicePayQr, { maxCalls: 60, secret: true, idempotent: false }),
];

export { ForbiddenError, mayMoveMoney, payments, isOverdue, isProcessing, sysModeOf, W };
