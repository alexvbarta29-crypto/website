// What an invoice's buttons do (shared by the Invoice screen, Rotor's phone
// invoice editor and the payment sheets): send, record cash or a check,
// charge the card on file, the QR to pay, a card link, refund, keep an
// overpayment as credit, write off, void. Each takes the screen's ctx (or the
// editor's stand-in: api, state, refresh) and refreshes it when done.
// Payments stay practice (dry run) until Stripe is live, as everywhere.

import { html, attrs, sheet, toast, confirmSheet } from "../../core/ui.js";
import { busy, readForm, showError, clearErrors, readMoney } from "../../core/forms.js";
import { money } from "../../core/format.js";
import { uuid } from "../../core/api.js";
import { waitRun, CARD } from "./kit.js";
import { openPayQr } from "./pay-qr.js";

export const cardWords = (s) => (s.card && s.card.last4 ? `${String(s.card.brand || (s.card.kind === "us_bank_account" ? "Bank" : "Card")).toUpperCase()} ending ${s.card.last4} · ${CARD[s.card.status] || s.card.status}` : CARD[(s.card && s.card.status) || "none"]);

export function showQr(ctx) {
  const id = encodeURIComponent(ctx.state.invoice.id);
  openPayQr({
    save: true,
    fetch: () => ctx.api(`/invoices/${id}/pay-qr`, { method: "POST", body: {} }),
    check: async () => (await ctx.api(`/invoices/${id}`, { cache: false })).data.invoice.status === "paid",
    // the history shows the code was shown (and, once they pay, the payment)
    onClose: () => ctx.refresh(),
  });
}
export async function charge(el, ctx) {
  const s = ctx.state;
  const card = s.card && s.card.last4 ? `the ${String(s.card.brand || "card").toUpperCase()} ending ${s.card.last4}` : "the card on file";
  if (!(await confirmSheet(`Charge ${money(s.invoice.balance_cents)} to ${card}?${s.system_of_record !== "crm" ? " (Payments are in practice mode: nothing real is charged.)" : ""}`, { title: "Charge the card", yes: "Charge" }))) return;
  busy(el, true, "Charging…");
  try {
    const r = await ctx.api(`/invoices/${encodeURIComponent(s.invoice.id)}/charge`, { method: "POST", body: {} });
    const run = await waitRun(ctx.api, r.data.run_id);
    const st = run && run.result && run.result.status;
    toast(st === "succeeded" ? "Charged" : st === "processing" ? "The bank payment is clearing" : st === "failed" ? "The card didn't go through" : st === "would_charge" ? "Not charged: Rotor still bills this customer" : st === "refused" ? "There's nothing to charge that card with" : "Still working. Check back in a minute.", { bad: !["succeeded", "processing"].includes(st) });
  } catch (err) { toast(err.message || "That didn't work.", { bad: true }); }
  ctx.refresh();
}
export async function cardLink(ctx) {
  if (!(await confirmSheet("Text them a link to put a card on file?", { title: "Card link", yes: "Text it" }))) return;
  try {
    const r = await ctx.api(`/contacts/${encodeURIComponent(ctx.state.invoice.contact_id)}/card-link`, { method: "POST", body: { client_id: uuid() } });
    toast(r.data.mode === "dry_run" ? "In the Outbox (texts are still practice)" : r.data.status === "sent" ? "Sent" : `Not sent${r.data.reason ? `: ${String(r.data.reason).replace(/_/g, " ")}` : ""}`, { bad: !["sent", "queued"].includes(r.data.status) && r.data.mode !== "dry_run" });
  } catch (err) { toast(err.message || "That didn't send.", { bad: true }); }
}
export async function keepCredit(ctx) {
  if (!(await confirmSheet("Keep the extra as account credit? It comes off their next invoice.", { title: "Keep as credit", yes: "Keep it" }))) return;
  try {
    const cr = await ctx.api(`/contacts/${encodeURIComponent(ctx.state.invoice.contact_id)}/credits`, { cache: false });
    const row = ((cr.data && cr.data.credits) || []).find((c) => c.source_invoice_id === ctx.state.invoice.id && c.status === "held");
    if (!row) { toast("That overpayment is already settled."); ctx.refresh(); return; }
    await ctx.api(`/credits/${encodeURIComponent(row.id)}/keep`, { method: "POST", body: {} });
    toast("Kept as credit");
  } catch (err) { toast(err.message || "That didn't save.", { bad: true }); }
  ctx.refresh();
}
export async function writeOff(ctx) {
  if (!(await confirmSheet("Write this invoice off as money you won't collect? It leaves the open list.", { title: "Write off", yes: "Write off", danger: true }))) return;
  act(ctx, "write-off", {}, "Written off");
}
export const voidIt = (ctx) => reasonSheet(ctx, { title: "Void this invoice", label: "Why?", yes: "Void it", run: (reason) => act(ctx, "void", { reason }, "Voided") });

export async function act(ctx, path, body, ok) {
  try {
    await ctx.api(`/invoices/${encodeURIComponent(ctx.state.invoice.id)}/${path}`, { method: "POST", body });
    toast(ok);
  } catch (err) { toast(err.message || "That didn't save.", { bad: true }); }
  ctx.refresh();
}

export function sendSheet(ctx) {
  const s = ctx.state;
  const c = s.contact || {};
  const sh = sheet({
    title: s.invoice.status === "draft" ? "Send this invoice" : "Send it again",
    body: html`<form class="form" data-send><p class="muted small">They get a link to see it and pay by card. ${s.system_of_record !== "crm" ? "Texts and emails are still practice: this lands in the Outbox." : ""}</p>
      <label class="check"><input type="checkbox" name="sms" ${attrs({ checked: !!c.has_sms, disabled: !c.has_sms })}><span>Text${c.has_sms ? "" : " (no mobile number on file)"}</span></label>
      <label class="check"><input type="checkbox" name="email" ${attrs({ checked: !!c.has_email, disabled: !c.has_email })}><span>Email${c.has_email ? "" : " (no email on file)"}</span></label>
      <p class="err" data-form-err hidden></p><div class="btn-row"><button type="submit" class="btn primary">Send</button></div></form>`,
    events: {
      "submit [data-send]": async (e, form) => {
        e.preventDefault();
        clearErrors(form);
        const v = readForm(form);
        const channels = [v.sms ? "sms" : null, v.email ? "email" : null].filter(Boolean);
        if (!channels.length) { showError(form, { message: "Pick text, email or both." }); return; }
        const btn = form.querySelector("button[type=submit]");
        busy(btn, true, "Sending…");
        try {
          await ctx.api(`/invoices/${encodeURIComponent(s.invoice.id)}/${s.invoice.status === "draft" ? "issue" : "send"}`, { method: "POST", body: { channels } });
          sh.close(); toast(s.system_of_record !== "crm" ? "In the Outbox" : "Sent"); ctx.refresh();
        } catch (err) { busy(btn, false); showError(form, err); }
      },
    },
  });
}

export function recordSheet(ctx) {
  const s = ctx.state;
  const clientId = uuid();
  const sh = sheet({
    title: "Record a payment",
    body: html`<form class="form" data-record>
      <div class="mn-seg" role="radiogroup" aria-label="How they paid">${[["check", "Check"], ["cash", "Cash"], ["other", "Other"]].map(([v, l], i) => html`<label><input type="radio" name="method" ${attrs({ value: v, checked: i === 0 })}><span>${l}</span></label>`)}</div>
      <div class="mn-grid">
        <label class="field" data-field="amount_cents"><span>Amount</span><input name="amount" inputmode="decimal" autocomplete="off" ${attrs({ value: (s.invoice.balance_cents / 100).toFixed(2) })}><small class="why" hidden></small></label>
        <label class="field" data-field="tip_cents"><span>Tip (if any)</span><input name="tip" inputmode="decimal" autocomplete="off" placeholder="0.00"><small class="why" hidden></small></label>
      </div>
      <label class="field" data-field="reference"><span>Check number or note</span><input name="reference" autocomplete="off" maxlength="60"><small>Long account numbers are hidden automatically.</small><small class="why" hidden></small></label>
      <p class="err" data-form-err hidden></p><div class="btn-row"><button type="submit" class="btn primary">Save payment</button></div></form>`,
    events: {
      "submit [data-record]": async (e, form) => {
        e.preventDefault();
        clearErrors(form);
        const v = readForm(form);
        const amount = readMoney(v.amount), tip = v.tip ? readMoney(v.tip) : 0;
        if (!amount || amount <= 0) { showError(form, { field: "amount_cents", message: "How much did they pay?" }); return; }
        if (tip === null || tip < 0) { showError(form, { field: "tip_cents", message: "That tip doesn't look right." }); return; }
        const btn = form.querySelector("button[type=submit]");
        busy(btn, true);
        try {
          await ctx.api(`/invoices/${encodeURIComponent(s.invoice.id)}/payments`, { method: "POST", body: { method: v.method || "check", amount_cents: amount, tip_cents: tip, reference: v.reference || undefined, client_id: clientId }, idempotencyKey: clientId });
          sh.close(); toast("Payment saved"); ctx.refresh();
        } catch (err) { busy(btn, false); showError(form, err); }
      },
    },
  });
}

export function refundSheet(ctx, paymentId, left) {
  const clientId = uuid();
  const p = (ctx.state.payments || []).find((x) => x.id === paymentId) || {};
  const how = ["card", "ach"].includes(p.method) ? "It goes back to their card or bank." : "This only records it: hand the money back yourself.";
  const sh = sheet({
    title: "Refund",
    body: html`<form class="form" data-refund-form><p class="muted small">Up to ${money(left)}. ${how}</p>
      <label class="field" data-field="amount_cents"><span>Amount</span><input name="amount" inputmode="decimal" autocomplete="off" ${attrs({ value: (left / 100).toFixed(2) })}><small class="why" hidden></small></label>
      <label class="field" data-field="reason"><span>Why</span><input name="reason" autocomplete="off" maxlength="200"><small class="why" hidden></small></label>
      <p class="err" data-form-err hidden></p><div class="btn-row"><button type="submit" class="btn danger">Refund</button></div></form>`,
    events: {
      "submit [data-refund-form]": async (e, form) => {
        e.preventDefault();
        clearErrors(form);
        const v = readForm(form);
        const amount = readMoney(v.amount);
        if (!amount || amount <= 0) { showError(form, { field: "amount_cents", message: "How much goes back?" }); return; }
        const btn = form.querySelector("button[type=submit]");
        busy(btn, true, "Refunding…");
        try {
          await ctx.api(`/payments/${encodeURIComponent(paymentId)}/refund`, { method: "POST", body: { amount_cents: amount, reason: v.reason, client_id: clientId }, idempotencyKey: clientId });
          sh.close(); toast("Refunded"); ctx.refresh();
        } catch (err) { busy(btn, false); showError(form, err); }
      },
    },
  });
}

export function reasonSheet(ctx, { title, label, yes, run }) {
  const sh = sheet({
    title,
    body: html`<form class="form" data-reason><label class="field" data-field="reason"><span>${label}</span><input name="reason" autocomplete="off" maxlength="200"><small class="why" hidden></small></label>
      <p class="err" data-form-err hidden></p><div class="btn-row"><button type="submit" class="btn danger">${yes}</button></div></form>`,
    events: {
      "submit [data-reason]": async (e, form) => {
        e.preventDefault();
        const v = readForm(form);
        if (!v.reason || v.reason.length < 2) { showError(form, { field: "reason", message: "Say why." }); return; }
        sh.close();
        await run(v.reason);
      },
    },
  });
}

