// One invoice (design §9.2 "Invoice"): the lines and totals, what was paid
// and how, the balance, when it was sent, reminders and autopay tries; and
// what its state allows: Send (text, email), Record a payment (cash, check),
// Charge the card on file, Refund (owners), Void and Write off (owners),
// send a card link, keep an overpayment as credit. Before the switch from
// Rotor, online payment and card charges only run on test contacts and
// records made here (the screen says so).

import { html, attrs, icon, sheet, toast, confirmSheet, openExternal } from "../../core/ui.js";
import { busy, readForm, showError, clearErrors, readMoney } from "../../core/forms.js";
import { money, dateShort, dateTime } from "../../core/format.js";
import { uuid } from "../../core/api.js";
import { ensureStyles, statusPill, KIND, METHOD, PAY_STATUS, CARD, waitRun } from "./kit.js";
import { openPayQr, QR_ICON } from "./pay-qr.js";

async function load(params, ctx) {
  ensureStyles();
  const r = await ctx.api(`/invoices/${encodeURIComponent(params.id)}`, { cache: false });
  return { ...r.data, etag: r.etag || r.data.etag };
}

const qty = (l) => { const q = (l.qty_milli || 0) / 1000; return q === 1 ? "" : `${Number.isInteger(q) ? q : q.toFixed(2)} × ${money(l.unit_cents)}`; };

function lines(inv) {
  const net = (inv.paid_cents || 0) - (inv.refunded_cents || 0);
  return html`<ul class="mn-lines">${(inv.lines || []).map((l) => html`<li class="${l.total_cents < 0 ? "minus" : ""}"><span class="d">${l.description}${qty(l) && l.kind === "service" ? html`<small>${qty(l)}</small>` : ""}</span><span class="a">${l.total_cents < 0 ? "−" + money(-l.total_cents) : money(l.total_cents)}</span></li>`)}
    <li class="tot"><span class="d">Total</span><span class="a">${money(inv.total_cents)}</span></li>
    ${net ? html`<li><span class="d">Paid</span><span class="a">−${money(net)}</span></li>` : ""}
    ${inv.tips_cents ? html`<li><span class="d">Tips for the crew</span><span class="a">${money(inv.tips_cents)}</span></li>` : ""}
    <li class="tot big"><span class="d">${inv.excess_cents ? "Overpaid" : "Balance"}</span><span class="a">${money(inv.excess_cents ? inv.excess_cents : inv.balance_cents)}</span></li></ul>`;
}

function payments(s, ctx) {
  const list = s.payments || [];
  if (!list.length) return "";
  return html`<section class="card"><h2>Payments</h2><div>${list.map((p) => {
    const [cls, words] = PAY_STATUS[p.status] || ["", p.status];
    const refund = p.kind === "refund";
    const left = p.total_cents - (p.refunded_cents || 0);
    const what = `${refund ? "Refund" : METHOD[p.method] || p.method}${p.card && p.card.last4 ? ` ending ${p.card.last4}` : ""}${p.reference ? ` · ${p.reference}` : ""}`;
    return html`<div class="mn-pay"><span class="t"><b>${what}</b><small>${dateShort(p.received_on)}${p.tip_cents && !refund ? ` · tip ${money(p.tip_cents)}` : ""}${p.via === "qr" ? " · scanned the pay code" : ""}${p.refund_reason ? ` · ${p.refund_reason}` : ""}${p.failure_code ? ` · ${String(p.failure_code).replace(/_/g, " ")}` : ""}${p.simulated ? " · test" : ""}</small></span>
      <span class="p">${refund ? "−" : ""}${money(p.total_cents)}<br><span class="${"pill " + (refund ? "" : cls)}">${refund ? "Refund" : words}</span></span>
      ${!refund && p.status === "succeeded" && left > 0 && s.can.refund ? html`<button type="button" class="act" ${attrs({ "data-refund": p.id, "data-left": String(left) })}>Refund</button>` : ""}</div>`;
  })}</div></section>`;
}

function history(inv) {
  const rows = [];
  if (inv.issued_on) rows.push(["Issued", dateShort(inv.issued_on)]);
  if (inv.due_on && inv.status === "open") rows.push(["Due", dateShort(inv.due_on)]);
  if (inv.sent_at) rows.push(["Sent", `${dateTime(inv.sent_at)}${(inv.sent_via || []).length ? ` by ${(inv.sent_via || []).map((c) => (c === "sms" ? "text" : "email")).join(" and ")}` : ""}`]);
  if (inv.reminders && inv.reminders.count) rows.push(["Reminders", `${inv.reminders.count}, the last ${dateShort(inv.reminders.last_at)}`]);
  // scan to pay: when the code was shown, and when the customer's phone opened it
  const q = inv.qr || {};
  if (q.shown) rows.push(["Pay code shown", `${q.shown === 1 ? "once" : `${q.shown} times`}${q.last_shown_at ? `, the last ${dateTime(q.last_shown_at)}` : ""}`]);
  if (q.opened) rows.push(["Opened from the code", `${q.opened === 1 ? dateTime(q.last_opened_at) : `${q.opened} times, the last ${dateTime(q.last_opened_at)}`}`]);
  if (inv.paid_at && inv.status === "paid") rows.push(["Paid", dateShort(inv.paid_at)]);
  if (inv.voided_at) rows.push(["Void", `${dateShort(inv.voided_at)}${inv.void_reason ? `: ${inv.void_reason}` : ""}`]);
  for (const a of ((inv.autopay && inv.autopay.attempts) || []).slice(-4)) rows.push([`Card try ${a.n || ""}`.trim(), `${dateShort(a.at)}: ${a.result === "succeeded" ? "went through" : a.result === "processing" ? "clearing" : a.result === "failed" ? `failed${a.code ? ` (${String(a.code).replace(/_/g, " ")})` : ""}` : a.result}`]);
  if (inv.autopay && inv.autopay.next_attempt_at && inv.status === "open") rows.push(["Next card try", dateShort(inv.autopay.next_attempt_at)]);
  if (inv.rotor) rows.push(["From Rotor", `status there: ${inv.rotor.status_raw || "?"}`]);
  return rows.length ? html`<section class="card"><h2>History</h2><dl class="kv">${rows.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl></section>` : "";
}

function actions(s) {
  const c = s.can || {};
  const inv = s.invoice;
  const b = [
    c.issue ? html`<button type="button" class="btn primary" data-act="send">${icon("send")}Send to the customer</button>` : "",
    c.send ? html`<button type="button" class="btn primary" data-act="send">${icon("send")}${inv.sent_at ? "Send again" : "Send"}</button>` : "",
    c.qr ? html`<button type="button" class="btn" data-act="qr">${QR_ICON}Show QR to pay</button>` : "",
    c.record ? html`<button type="button" class="btn" data-act="record">${icon("money")}Record a payment</button>` : "",
    c.charge ? html`<button type="button" class="btn" data-act="charge">${icon("pay")}Charge the card</button>` : "",
    c.card_link && inv.status === "open" ? html`<button type="button" class="btn" data-act="card-link">${icon("link")}Text a card link</button>` : "",
    inv.excess_cents > 0 && !inv.excess_kept && c.refund ? html`<button type="button" class="btn" data-act="keep">Keep the extra as credit</button>` : "",
    c.write_off ? html`<button type="button" class="btn" data-act="write-off">Write off</button>` : "",
    c.void ? html`<button type="button" class="btn danger" data-act="void">Void</button>` : "",
  ].filter(Boolean);
  return b.length ? html`<div class="mn-acts">${b}</div>` : "";
}

export default {
  title: (s) => (s && s.invoice ? s.invoice.number : "Invoice"),
  load,
  render(s, ctx) {
    const inv = s.invoice;
    const f = s.flags || {};
    const row = { st: inv.status, od: f.overdue, pp: f.partially_paid, af: f.autopay_failed, pr: f.processing, ex: inv.excess_cents };
    const note = s.rotor_owned ? "This invoice came from Rotor and is still Rotor's until the switch. It can be read here; change it in Rotor and the next import brings it over."
      : inv.status !== "open" ? "" : s.online === "not_yet" ? "Rotor still bills this customer: paying online and card charges open after the switch. You can still record cash or a check."
      : s.online === "charging" ? "A card charge is running right now." : s.online === "processing" ? "A bank payment is clearing (a few days). No new charge or pay link until it does." : "";
    return html`<div class="stack">
      <section class="card mn-head">
        <div class="top-line"><h2>${KIND[inv.kind] || "Invoice"} ${inv.number}</h2>${statusPill(row)}${s.sandboxed && s.system_of_record !== "crm" ? html`<span class="pill">Test</span>` : ""}</div>
        <div class="big">${money(inv.status === "open" ? inv.balance_cents : inv.total_cents)}</div>
        ${s.contact ? html`<a class="who-link" href="${"#/contacts/" + encodeURIComponent(s.contact.id)}">${s.contact.display_name || "The customer"}</a>` : ""}
        ${note ? html`<p class="warn-box">${note}</p>` : ""}
        ${inv.excess_cents > 0 && !inv.excess_kept ? html`<p class="warn-box">They paid ${money(inv.excess_cents)} too much. Refund it from the payment below, or keep it as credit for their next visit.</p>` : ""}
      </section>
      ${actions(s)}
      <section class="card"><h2>What it's for</h2>${lines(inv)}
        ${inv.customer_note ? html`<p class="small muted" style="margin-top:10px">Note to the customer: ${inv.customer_note}</p>` : ""}
        ${(inv.job_ids || []).length ? html`<div class="btn-row">${inv.job_ids.slice(0, 3).map((j) => html`<a class="btn" href="${"#/jobs/" + encodeURIComponent(j)}">${icon("doc")}The job</a>`)}${inv.plan_id ? html`<a class="btn" href="${"#/plans/" + encodeURIComponent(inv.plan_id)}">${icon("check")}The plan</a>` : ""}</div>` : inv.plan_id ? html`<div class="btn-row"><a class="btn" href="${"#/plans/" + encodeURIComponent(inv.plan_id)}">${icon("check")}The plan</a></div>` : ""}
      </section>
      ${payments(s, ctx)}
      <section class="card"><h2>Card on file</h2><p>${s.card && s.card.last4 ? `${String(s.card.brand || (s.card.kind === "us_bank_account" ? "Bank" : "Card")).toUpperCase()} ending ${s.card.last4} · ${CARD[s.card.status] || s.card.status}` : CARD[(s.card && s.card.status) || "none"]}</p></section>
      ${history(inv)}
    </div>`;
  },
  events: {
    "click [data-act=send]": (e, el, ctx) => sendSheet(ctx),
    "click [data-act=record]": (e, el, ctx) => recordSheet(ctx),
    "click [data-act=qr]": (e, el, ctx) => {
      const id = encodeURIComponent(ctx.state.invoice.id);
      openPayQr({
        save: true,
        fetch: () => ctx.api(`/invoices/${id}/pay-qr`, { method: "POST", body: {} }),
        check: async () => (await ctx.api(`/invoices/${id}`, { cache: false })).data.invoice.status === "paid",
        // the history shows the code was shown (and, once they pay, the payment)
        onClose: () => ctx.refresh(),
      });
    },
    "click [data-act=charge]": async (e, el, ctx) => {
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
    },
    "click [data-act=card-link]": async (e, el, ctx) => {
      if (!(await confirmSheet("Text them a link to put a card on file?", { title: "Card link", yes: "Text it" }))) return;
      try {
        const r = await ctx.api(`/contacts/${encodeURIComponent(ctx.state.invoice.contact_id)}/card-link`, { method: "POST", body: { client_id: uuid() } });
        toast(r.data.mode === "dry_run" ? "In the Outbox (texts are still practice)" : r.data.status === "sent" ? "Sent" : `Not sent${r.data.reason ? `: ${String(r.data.reason).replace(/_/g, " ")}` : ""}`, { bad: !["sent", "queued"].includes(r.data.status) && r.data.mode !== "dry_run" });
      } catch (err) { toast(err.message || "That didn't send.", { bad: true }); }
    },
    "click [data-act=keep]": async (e, el, ctx) => {
      if (!(await confirmSheet("Keep the extra as account credit? It comes off their next invoice.", { title: "Keep as credit", yes: "Keep it" }))) return;
      try {
        const cr = await ctx.api(`/contacts/${encodeURIComponent(ctx.state.invoice.contact_id)}/credits`, { cache: false });
        const row = ((cr.data && cr.data.credits) || []).find((c) => c.source_invoice_id === ctx.state.invoice.id && c.status === "held");
        if (!row) { toast("That overpayment is already settled."); ctx.refresh(); return; }
        await ctx.api(`/credits/${encodeURIComponent(row.id)}/keep`, { method: "POST", body: {} });
        toast("Kept as credit");
      } catch (err) { toast(err.message || "That didn't save.", { bad: true }); }
      ctx.refresh();
    },
    "click [data-act=write-off]": async (e, el, ctx) => {
      if (!(await confirmSheet("Write this invoice off as money you won't collect? It leaves the open list.", { title: "Write off", yes: "Write off", danger: true }))) return;
      act(ctx, "write-off", {}, "Written off");
    },
    "click [data-act=void]": (e, el, ctx) => reasonSheet(ctx, { title: "Void this invoice", label: "Why?", yes: "Void it", run: (reason) => act(ctx, "void", { reason }, "Voided") }),
    "click [data-refund]": (e, el, ctx) => refundSheet(ctx, el.dataset.refund, Number(el.dataset.left)),
  },
};

async function act(ctx, path, body, ok) {
  try {
    await ctx.api(`/invoices/${encodeURIComponent(ctx.state.invoice.id)}/${path}`, { method: "POST", body });
    toast(ok);
  } catch (err) { toast(err.message || "That didn't save.", { bad: true }); }
  ctx.refresh();
}

function sendSheet(ctx) {
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

function recordSheet(ctx) {
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

function refundSheet(ctx, paymentId, left) {
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

function reasonSheet(ctx, { title, label, yes, run }) {
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

export { openExternal };
