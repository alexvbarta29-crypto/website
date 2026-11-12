// Money module: charging a saved card or bank account off-session (design
// §5.6 "Off-session charge"; autopay, staff "Charge card", retries).
//
// One attempt = one op, money.charge, journaled at op/charge--{attemptId}
// (resumable: the worker finishes an attempt whose function died):
//   1 lock     CAS the invoice: charging = { by, until: now + 10 min,
//              attempt_id }. Refused when a live lock exists, any applied
//              entry is processing, the balance is 0, or it isn't open.
//   2 expire   every open Checkout Session recorded on the invoice is
//              expired first (a session that completed meanwhile is applied
//              first), so a customer can't pay a stale link while we charge
//   3 charge   re-read the invoice and charge its CURRENT balance: a
//              PaymentIntent off_session, confirm, the RECORDED method,
//              metadata { crm_invoice_id, crm_contact_id, crm_attempt_id },
//              Idempotency-Key charge:{attempt_id}: an ambiguous call
//              re-issued by a resumed op returns Stripe's first answer, so a
//              crash between the call and its record never charges twice
//   4 record   upsertPayment(pi:{id}) → the invoice's applied map; the
//              attempt on invoice.autopay.attempts; the lock cleared; on a
//              failure the retry day (cfg/money.retry_days) or, after the
//              last one, an approval task "Card failed N times"
// attempt_id = deriveId("payment", "att:" + invoiceId + ":" + n), n the
// invoice's charge counter, so a double tap is the same attempt.
//
// Before cutover a charge runs only for sandboxed invoices (dry-run or test
// money; everything else gets a would-charge row, §3.10).

import { getRecord, updateRecord, createRecord } from "../../../crm-store.mjs";
import { deriveId, isId } from "../../core/ids.mjs";
import { nowIso, nowMs, now, localDate, addLocalDays, zonedToUtc } from "../../core/clock.mjs";
import { ConflictError, NotFoundError, ExistsError, BlobsTransientError, ParallelRunGuard } from "../../core/errors.mjs";
import { defineOp, runOp, readOp } from "../../core/ops.mjs";
import { defineRun, createRun } from "../../core/lanes.mjs";
import { getType } from "../../core/registry.mjs";
import { approvers } from "../../core/notify.mjs";
import { wouldAct } from "../../core/activity.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { chargeRefusal, isProcessing } from "./balance.mjs";
import { W, moneySettings, sysModeOf, liveContact, nameOf } from "./common.mjs";
import { upsertPayment, payId, attemptId, tipSplitFor } from "./upsert.mjs";
import { payments, mayMoveMoney } from "./gate.mjs";
import { cardFor, markMethodFailed } from "./cards.mjs";
import { expireSessionsOf } from "./checkout.mjs";

export const LOCK_MS = 10 * 60 * 1000;
export const chargeOpId = (attempt) => `charge--${attempt}`;
export const chargeRunId = (attempt) => deriveId("run", `charge:${attempt}`, "money.charge", 1);
export const cardFailedTaskId = (invoiceId) => deriveId("task", `cardfail:${invoiceId}`, "money.charge", 1);

const REFUSE_TEXT = {
  paid: "This invoice is paid.", not_open: "Only an open invoice can be charged.", charging: "A charge is already running on this invoice.",
  processing: "A bank payment is still clearing on this invoice.", missing: "That invoice isn't here.", no_card: "There's no card on file to charge.",
};

defineOp("money.charge", {
  steps(input) {
    const id = input.invoice_id;
    const att = input.attempt_id;
    return [
      {
        name: "lock",
        async run(s) {
          let refused = null;
          await updateRecord("invoice", id, (inv) => {
            if (inv.charging && inv.charging.attempt_id === att) return null;              // a resume: ours already
            refused = chargeRefusal(inv, nowMs());
            if (refused) return null;
            return { ...inv, charging: { by: input.by || "system", until: new Date(nowMs() + LOCK_MS).toISOString(), attempt_id: att, n: input.n }, charge_n: Math.max(inv.charge_n || 0, input.n) };
          }, s.ctx);
          return { refused };
        },
      },
      {
        name: "expire",
        async run(s) {
          if (s.out.lock && s.out.lock.refused) return { skipped: true };
          return { expired: await expireSessionsOf(id, s.ctx) };
        },
      },
      {
        name: "charge",
        async run(s) {
          if (s.out.lock && s.out.lock.refused) return { refused: s.out.lock.refused };
          const g = await getRecord("invoice", id);
          if (!g) return { refused: "missing" };
          const inv = g.data;
          if (inv.status !== "open" || !(inv.balance_cents > 0)) return { refused: "paid" };
          if (isProcessing(inv)) return { refused: "processing" };
          const amount = inv.balance_cents;
          const mode = await sysModeOf(s.ctx);
          const p = await payments({ mode });
          if (!p.impl) return { refused: "paused" };
          const contact = await liveContact(inv.contact_id);
          if (!(await mayMoveMoney(inv, { sor: mode.system_of_record, contact }))) {
            await wouldAct({ key: "money.charge", subject: inv.id, action: "charge", changes: { amount_cents: [null, amount] } }).catch(() => {});
            return { would: true, amount_cents: amount };
          }
          const plan = isId(inv.plan_id, "plan") ? ((await getRecord("plan", inv.plan_id).catch(() => null)) || {}).data : null;
          const card = await cardFor(inv.contact_id, plan);
          const pmId = input.payment_method_id || (inv.autopay && inv.autopay.payment_method_id) || card.payment_method_id;
          if (!pmId) return { refused: "no_card" };
          // a practice card can't be charged for real, and a card saved in Stripe's test data isn't in the live account
          const pmMode = pmId === card.payment_method_id ? card.mode : /^dry_/.test(String(pmId)) ? "dry_run" : null;
          if (pmMode && pmMode !== p.mode) return { refused: "no_card" };
          const r = await p.impl.chargeSaved({
            customer_id: card.customer_id, payment_method_id: pmId, mandate_id: card.mandate_id || undefined, amount_cents: amount,
            description: `Invoice ${inv.number}`, metadata: { crm_invoice_id: inv.id, crm_contact_id: inv.contact_id, crm_attempt_id: att },
            idempotencyKey: `charge:${att}`, sandboxed: true, outbox: { contact_id: inv.contact_id, to: "•••", related: { invoice_id: inv.id }, subject_ref: { type: "invoice", id: inv.id }, ctx: s.ctx },
          });
          return { ...r, amount_cents: amount, payment_method_id: pmId, card: card.brand || card.last4 ? { brand: card.brand, last4: card.last4, kind: card.kind } : undefined, simulated: p.mode === "dry_run", mode: p.mode };
        },
      },
      {
        name: "record",
        async run(s) {
          const c = s.out.charge || {};
          const settings = await moneySettings();
          let paymentId = null;
          let result = c.refused ? "refused" : c.would ? "would_charge" : c.status;
          if (c.payment_intent_id) {
            const g = await getRecord("invoice", id);
            const inv = g && g.data;
            const status = c.status === "requires_action" ? "failed" : c.status;
            const out = await upsertPayment({
              id: payId.pi(c.payment_intent_id), contact_id: inv.contact_id, contact_name: inv.contact_name, invoice_id: id, invoice_number: inv.number,
              job_id: (inv.job_ids || [])[0], plan_id: inv.plan_id, kind: "payment", method: c.card && c.card.kind === "us_bank_account" ? "ach" : /ach/.test(String(c.payment_method_id)) ? "ach" : "card",
              status, amount_cents: c.amount_cents, tip_cents: 0, fee_cents: c.fee_cents || 0, tip_split: [],
              stripe: { payment_intent_id: c.payment_intent_id, ...(c.charge_id ? { charge_id: c.charge_id } : {}), attempt_id: att, payment_method_id: c.payment_method_id },
              ...(c.card ? { card: c.card } : {}), ...(c.failure_code ? { failure_code: c.failure_code } : status === "failed" && c.status === "requires_action" ? { failure_code: "authentication_required" } : {}),
              ...(c.simulated ? { simulated: true } : {}), recorded_by: input.by || "system",
            }, s.ctx);
            paymentId = out.payment.id;
            result = out.payment.status === "requires_action" ? "failed" : out.payment.status;
            if (result === "failed") await markMethodFailed(inv.contact_id, s.ctx);
          }
          // refused or report-only: no attempt to record, only our lock to drop
          if (!paymentId) {
            await updateRecord("invoice", id, (inv) => (inv.charging && inv.charging.attempt_id === att ? (() => { const x = { ...inv }; delete x.charging; return x; })() : null), s.ctx);
            return { result, code: c.refused || null, amount_cents: c.amount_cents || 0 };
          }
          // the attempt on the invoice, the lock off, the next try
          let fails = 0;
          const r = await updateRecord("invoice", id, (inv) => {
            const list = (inv.autopay && inv.autopay.attempts) || [];
            const entry = { attempt_id: att, n: input.n, at: nowIso(), origin: input.origin || "staff", result: ["succeeded", "processing", "failed"].includes(result) ? result : "unknown", payment_id: paymentId, ...(c.failure_code ? { code: String(c.failure_code).slice(0, 60) } : {}) };
            const attempts = [...list.filter((a) => a.attempt_id !== att), entry].slice(-20);
            fails = attempts.filter((a) => a.result === "failed").length;
            const next = { ...inv, autopay: { ...(inv.autopay || {}), attempts } };
            if (next.charging && next.charging.attempt_id === att) delete next.charging;
            delete next.autopay.next_attempt_at;
            const retryDays = settings.retry_days || [3, 7];
            if (result === "failed" && ["autopay", "retry", "invoice.issued"].includes(input.origin) && fails <= retryDays.length) {
              const first = attempts.find((a) => a.result === "failed");
              const base = first ? localDate(new Date(first.at)) : localDate(now());
              next.autopay.next_attempt_at = zonedToUtc(addLocalDays(base, retryDays[fails - 1]), "09:00").toISOString();
            }
            return next;
          }, s.ctx);
          if (result === "failed" && ["autopay", "retry", "invoice.issued"].includes(input.origin) && fails > (settings.retry_days || [3, 7]).length) await cardFailedTask(r.data, fails, s.ctx);
          return { result, payment_id: paymentId, code: c.failure_code || c.refused || null, amount_cents: c.amount_cents || 0 };
        },
      },
    ];
  },
});

async function cardFailedTask(inv, fails, ctx) {
  if (!getType("task")) return;
  const id = cardFailedTaskId(inv.id);
  if (await getRecord("task", id)) return;
  const c = await liveContact(inv.contact_id);
  try {
    await createRecord("task", {
      id, title: `Card failed ${fails} times on ${inv.number}`.slice(0, 160), kind: "approval", priority: "high", status: "open", contact_id: inv.contact_id,
      contact_name: nameOf(c) || undefined, assignee_ids: (await approvers().catch(() => [])).slice(0, 3), approval: { kind: "card_failed", ref_id: inv.id },
      notes: "Autopay stopped trying. Call them, send a card link, or charge another card from the invoice.",
    }, W(ctx));
  } catch (e) { if (!(e instanceof ExistsError)) console.error(`crm:money: card-failed task not made (${safeErr(e)})`); }
}

// Charges an invoice now (a listener, the autopay run, a retry, a run a
// person started). opts: { by, origin, payment_method_id, n? }.
// → { status, result, payment_id?, code?, attempt_id }
export async function chargeInvoice(invoiceId, opts = {}, ctx = {}) {
  const g = await getRecord("invoice", invoiceId);
  if (!g) throw new NotFoundError("That invoice isn't here.");
  const inv = g.data;
  const n = opts.n || (inv.charge_n || 0) + 1;
  const att = attemptId(invoiceId, n);
  const w = W(ctx);
  const mode = await sysModeOf(w);
  const out = await runOp(chargeOpId(att), "money.charge", {
    input: { invoice_id: invoiceId, attempt_id: att, n, by: opts.by || w.by || "system", origin: opts.origin || "staff", payment_method_id: opts.payment_method_id || null },
    ctx: { ...w, mode }, holder: String(w.requestId || "money").slice(0, 80), resume: true,
  });
  if (out.status === "running") return { status: "running", attempt_id: att };
  if (out.status === "failed") return { status: "failed", result: "error", code: (out.error && out.error.code) || "error", attempt_id: att };
  return { status: "done", ...(out.result || {}), attempt_id: att };
}

// Can this invoice be charged now? (the route answers 409 before starting a run)
export async function checkChargeable(invoiceId, { payment_method_id } = {}) {
  const g = await getRecord("invoice", invoiceId);
  if (!g) throw new NotFoundError("That invoice isn't here.");
  const why = chargeRefusal(g.data, nowMs());
  if (why) throw new ConflictError(REFUSE_TEXT[why] || "This invoice can't be charged now.", { code: why });
  if (!payment_method_id) {
    const plan = isId(g.data.plan_id, "plan") ? ((await getRecord("plan", g.data.plan_id).catch(() => null)) || {}).data : null;
    const card = await cardFor(g.data.contact_id, plan);
    if (!card.payment_method_id) throw new ConflictError(REFUSE_TEXT.no_card, { code: "no_card" });
  }
  return g.data;
}

// POST /invoices/:id/charge: a run (§5.6; payments:charge). → the run.
export async function startChargeRun(invoiceId, body, ctx) {
  const inv = await checkChargeable(invoiceId, body || {});
  const n = (inv.charge_n || 0) + 1;
  const att = attemptId(invoiceId, n);
  return createRun("money.charge", { invoice_id: invoiceId, n, payment_method_id: (body && body.payment_method_id) || null }, ctx.write(), { id: chargeRunId(att) });
}

defineRun("money.charge", {
  lane: "fast", label: "Charge a card",
  async step(run, rctx) {
    const i = run.input || {};
    const ctx = { by: run.requested_by || "system", origin: "api", actor_kind: isId(run.requested_by, "user") ? "user" : "automation", requestId: rctx.holder || "money", ...(rctx.mode ? { mode: rctx.mode } : {}) };
    const out = await chargeInvoice(i.invoice_id, { n: i.n, by: run.requested_by, origin: "staff", payment_method_id: i.payment_method_id }, ctx);
    if (out.status === "running") return { progress: { done: 0, total: 1 } };
    return { done: true, result: { status: out.result || out.status, payment_id: out.payment_id || null, code: out.code || null }, progress: { done: 1, total: 1 } };
  },
});

// invoice.issued listener: an autopay invoice is charged at once (§5.6);
// one whose card turns out unusable gets the invoice text instead.
export async function onInvoiceIssued(event, h) {
  const p = event.payload || {};
  if (!p.autopay || !isId(p.invoice_id, "invoice")) return { result: "skipped:not_autopay" };
  const g = await getRecord("invoice", p.invoice_id);
  if (!g || g.data.status !== "open" || !(g.data.balance_cents > 0)) return { result: "skipped:changed" };
  if (!h.ctx.mayAct({ record: g.data })) { await h.ctx.would(g.data, "charge", { amount_cents: [null, g.data.balance_cents] }); return { result: "would-charge" }; }
  const out = await chargeInvoice(g.data.id, { origin: "invoice.issued", by: "system:autopay" }, h.ctx.write());
  if (out.status === "running") throw new BlobsTransientError("The charge is still running.");
  if (out.result === "refused" && out.code === "no_card") {
    const { sendInvoiceLinkAfterAutopay } = await import("./automations.mjs");
    await sendInvoiceLinkAfterAutopay(g.data, h.ctx.write());
  }
  return { result: `charge:${out.result || out.status}` };
}

// money.retry (daily 09:00): failed autopay attempts whose retry day came.
export async function retrySweep(ctx) {
  const { readIndex } = await import("../../../crm-store.mjs");
  const rows = (await readIndex("invoices", "open")).rows.filter((r) => r.st === "open" && r.af && r.bal > 0);
  let n = 0;
  for (const r of rows.slice(0, 100)) {
    if (ctx.budget && ctx.budget.left() < 10000) return { done: false, progress: n };
    const g = await getRecord("invoice", r.id);
    const inv = g && g.data;
    if (!inv || !inv.autopay || !inv.autopay.next_attempt_at || Date.parse(inv.autopay.next_attempt_at) > nowMs()) continue;
    if (!ctx.mayAct({ record: inv })) { await ctx.would(inv, "charge", { amount_cents: [null, inv.balance_cents] }); continue; }
    const out = await chargeInvoice(inv.id, { origin: "retry", by: "system:retry" }, ctx.write());
    if (out.result) n += 1;
  }
  return { progress: n };
}

export { readOp, ParallelRunGuard };
