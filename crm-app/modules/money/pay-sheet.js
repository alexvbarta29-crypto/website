// The Payment sheet (Rotor's phone app, the owner's screenshot of Nov 15):
// "Payment" and a round X, Amount Due big, the red "Tap to Pay on iPhone",
// then Charge · Manual · Send, what the chosen way does, and one sticky main
// button whose words follow the way ("Charge card - $625.00").
//
//   Tap to Pay  shown as Rotor shows it; it needs Stripe Terminal, which isn't
//               connected, so the sheet says so and offers the QR (the customer
//               pays on their own phone) instead
//   Charge      the card on file (a run; practice money until Stripe is live)
//   Manual      cash, a check or another way: amount, date, reference, a tip
//   Send        a pay link by text or email (the Outbox while texts are practice),
//               and the QR to pay
// Full screen on a phone, a dialog on a desk. Nothing here moves real money:
// the server decides (dry run until the owner connects Stripe).

import { html, attrs, sheet, toast } from "../../core/ui.js";
import { busy, showError, clearErrors, readMoney } from "../../core/forms.js";
import { money, localDate } from "../../core/format.js";
import { uuid } from "../../core/api.js";
import { MI, waitRun } from "./kit.js";
import { cardWords, showQr, cardLink } from "./invoice-acts.js";

const WAYS = { tap: "Tap to Pay on iPhone", charge: "Charge", manual: "Manual", send: "Send" };

// The way the sheet opens on: the card on file when it can be charged, else cash or a check, else the link.
export function firstWay(s) {
  const c = s.can || {};
  if (c.charge && s.card && s.card.usable) return "charge";
  if (c.record) return "manual";
  if (c.send || c.issue) return "send";
  return "tap";
}

const practice = (s) => (s.payments_mode === "live" ? "" : "Payments are practice right now: nothing real is charged.");

function panel(s, way, form) {
  const c = s.can || {};
  const due = s.invoice.balance_cents;
  if (way === "tap") {
    return html`<h3 class="mn-ps-h">Tap to Pay on iPhone</h3>
      <p class="mn-ps-p">The customer taps their card or phone on your phone.</p>
      <p class="mn-ps-note" data-ps-why>Not connected yet: Tap to Pay needs Stripe Terminal, which isn't set up. Until then, show the QR code and they pay on their own phone, or charge the card on file.</p>
      ${c.qr ? html`<button type="button" class="mn-ps-ob" data-ps-qr>Show QR to pay</button>` : ""}`;
  }
  if (way === "charge") {
    const why = !c.charge ? (s.online === "not_yet" ? "Rotor still bills this customer: card charges open after the switch. Record cash or a check instead." : !(s.card && s.card.usable) ? "No card on file to charge." : s.online === "processing" ? "A bank payment is clearing: no new charge until it does." : "This invoice can't be charged now.") : "";
    return html`<h3 class="mn-ps-h">Charge the card on file</h3>
      <p class="mn-ps-p">${cardWords(s)}</p>
      ${why ? html`<p class="mn-ps-note" data-ps-why>${why}</p>` : practice(s) ? html`<p class="mn-ps-note">${practice(s)}</p>` : ""}
      ${!c.charge && c.card_link && s.invoice.status === "open" ? html`<button type="button" class="mn-ps-ob" data-ps-cardlink>Text them a card link</button>` : ""}`;
  }
  if (way === "manual") {
    if (!c.record) return html`<h3 class="mn-ps-h">Record a manual payment</h3><p class="mn-ps-note" data-ps-why>Nothing is left to record on this invoice right now.</p>`;
    const v = form || {};
    return html`<h3 class="mn-ps-h">Record a manual payment</h3>
      <p class="mn-ps-p">Cash, a check or another way they paid. Nothing is charged: this writes it down.</p>
      <form class="form mn-ps-form" data-ps-manual novalidate>
        <div class="mn-seg" role="radiogroup" aria-label="How they paid">${[["cash", "Cash"], ["check", "Check"], ["other", "Other"]].map(([k, l]) => html`<label><input type="radio" name="method" ${attrs({ value: k, checked: (v.method || "cash") === k })}><span>${l}</span></label>`)}</div>
        <div class="mn-grid">
          <label class="field" data-field="amount_cents"><span>Amount</span><input name="amount" inputmode="decimal" autocomplete="off" ${attrs({ value: v.amount ?? (due / 100).toFixed(2) })}><small class="why" hidden></small></label>
          <label class="field" data-field="received_on"><span>Date</span><input type="date" name="received_on" ${attrs({ value: v.received_on || localDate(), max: localDate() })}><small class="why" hidden></small></label>
        </div>
        <div class="mn-grid">
          <label class="field" data-field="reference"><span>Reference</span><input name="reference" autocomplete="off" maxlength="60" placeholder="Check number" ${attrs({ value: v.reference || "" })}><small class="why" hidden></small></label>
          <label class="field" data-field="tip_cents"><span>Tip (if any)</span><input name="tip" inputmode="decimal" autocomplete="off" placeholder="0.00" ${attrs({ value: v.tip || "" })}><small class="why" hidden></small></label>
        </div>
        <p class="err" data-form-err hidden></p>
      </form>`;
  }
  const ct = s.contact || {};
  return html`<h3 class="mn-ps-h">Send a pay link</h3>
    <p class="mn-ps-p">They get a text or email with a link to see the invoice and pay by card on their own phone.</p>
    <form class="form mn-ps-form" data-ps-send novalidate>
      <label class="check"><input type="checkbox" name="sms" ${attrs({ checked: !!ct.has_sms, disabled: !ct.has_sms })}><span>Text${ct.has_sms ? "" : " (no mobile number on file)"}</span></label>
      <label class="check"><input type="checkbox" name="email" ${attrs({ checked: !!ct.has_email, disabled: !ct.has_email })}><span>Email${ct.has_email ? "" : " (no email on file)"}</span></label>
      <p class="err" data-form-err hidden></p>
    </form>
    ${s.system_of_record !== "crm" ? html`<p class="mn-ps-note">Texts and emails are still practice: this lands in the Outbox.</p>` : ""}
    ${c.qr ? html`<button type="button" class="mn-ps-ob" data-ps-qr>Or show the QR to pay here</button>` : ""}`;
}

// What the sticky button says, and whether it can go.
function goOf(s, way, amountCents) {
  const c = s.can || {};
  const due = money(s.invoice.balance_cents);
  if (way === "tap") return { label: `Start Tap to Pay on iPhone - ${due}`, ok: false };
  if (way === "charge") return { label: `Charge card - ${due}`, ok: !!c.charge };
  if (way === "manual") return { label: `Record payment - ${money(amountCents ?? s.invoice.balance_cents)}`, ok: !!c.record };
  return { label: `Send pay link - ${due}`, ok: !!(c.send || c.issue) };
}

function view(s, way, form) {
  const go = goOf(s, way, form && form.amount !== undefined ? readMoney(form.amount) : undefined);
  const b = (k, ic) => html`<button type="button" ${attrs({ class: "mn-ps-m" + (way === k ? " on" : ""), "data-pm": k, "aria-pressed": way === k ? "true" : "false" })}>${ic}<span>${WAYS[k]}</span></button>`;
  return html`<div class="mn-ps">
    <p class="mn-ps-l">Amount Due</p>
    <p class="mn-ps-amt num">${money(s.invoice.balance_cents)}</p>
    <button type="button" ${attrs({ class: "mn-ps-tap" + (way === "tap" ? " on" : ""), "data-pm": "tap", "aria-pressed": way === "tap" ? "true" : "false" })}>${MI.tap}<span>Tap to Pay on iPhone</span></button>
    <div class="mn-ps-3">${b("charge", MI.card)}${b("manual", MI.dollar)}${b("send", MI.mail)}</div>
    <div class="mn-ps-panel" data-ps-panel>${panel(s, way, form)}</div>
    <div class="mn-ps-cta"><button type="button" class="mn-ps-go" data-ps-go ${attrs({ disabled: !go.ok })}>${go.label}</button></div>
  </div>`;
}

// openPayment(ctx, { state, onDone }): ctx has api (and toast); state is GET /invoices/:id's data.
// onDone(kind) runs after a payment, a charge or a send went through (the caller reloads).
export function openPayment(ctx, { state, onDone } = {}) {
  const s = state;
  let way = firstWay(s);
  let form = null;
  const id = encodeURIComponent(s.invoice.id);
  const clientId = uuid();
  const readManual = (root) => {
    const f = root.querySelector("[data-ps-manual]");
    if (!f) return form;
    const v = (n) => (f.querySelector(`[name=${n}]`) || {}).value;
    const m = f.querySelector("[name=method]:checked");
    form = { method: m ? m.value : "cash", amount: v("amount"), received_on: v("received_on"), reference: v("reference"), tip: v("tip") };
    return form;
  };
  const done = (kind) => { sh.close(); if (onDone) onDone(kind); };
  const draw = () => { sh.set(view(s, way, form)); };
  const sh = sheet({
    title: "Payment",
    className: "mn-fs mn-paysheet",
    body: view(s, way, form),
    events: {
      "click [data-pm]": (e, el) => { readManual(sh.el); way = el.dataset.pm; draw(); },
      "input [data-ps-manual] [name=amount]": (e, el) => {
        const go = sh.el.querySelector("[data-ps-go]");
        const c = readMoney(el.value);
        if (go && way === "manual") go.textContent = `Record payment - ${money(c && c > 0 ? c : 0)}`;
      },
      "click [data-ps-qr]": () => { sh.close(); showQr({ ...ctx, state: s, refresh: () => onDone && onDone("qr") }); },
      "click [data-ps-cardlink]": () => cardLink({ ...ctx, state: s }),
      "click [data-ps-go]": async (e, btn) => {
        if (btn.disabled) return;
        if (way === "charge") {
          busy(btn, true, "Charging…");
          try {
            const r = await ctx.api(`/invoices/${id}/charge`, { method: "POST", body: {} });
            const run = await waitRun(ctx.api, r.data.run_id);
            const st = run && run.result && run.result.status;
            toast(st === "succeeded" ? "Charged" : st === "processing" ? "The bank payment is clearing" : st === "failed" ? "The card didn't go through" : st === "would_charge" ? "Not charged: Rotor still bills this customer" : st === "refused" ? "There's nothing to charge that card with" : "Still working. Check back in a minute.", { bad: !["succeeded", "processing"].includes(st) });
            done("charge");
          } catch (err) { busy(btn, false); toast(err.message || "That didn't work.", { bad: true }); }
          return;
        }
        if (way === "manual") {
          const f = sh.el.querySelector("[data-ps-manual]");
          clearErrors(f);
          const v = readManual(sh.el);
          const amount = readMoney(v.amount);
          const tip = v.tip ? readMoney(v.tip) : 0;
          if (!amount || amount <= 0) { showError(f, { field: "amount_cents", message: "How much did they pay?" }); return; }
          if (tip === null || tip < 0) { showError(f, { field: "tip_cents", message: "That tip doesn't look right." }); return; }
          busy(btn, true);
          try {
            await ctx.api(`/invoices/${id}/payments`, { method: "POST", body: { method: v.method, amount_cents: amount, tip_cents: tip, received_on: v.received_on || undefined, reference: v.reference || undefined, client_id: clientId }, idempotencyKey: clientId });
            toast("Payment saved");
            done("manual");
          } catch (err) { busy(btn, false); showError(f, err); }
          return;
        }
        if (way === "send") {
          const f = sh.el.querySelector("[data-ps-send]");
          clearErrors(f);
          const channels = ["sms", "email"].filter((k) => { const x = f.querySelector(`[name=${k}]`); return x && x.checked; });
          if (!channels.length) { showError(f, { message: "Pick text, email or both." }); return; }
          busy(btn, true, "Sending…");
          try {
            await ctx.api(`/invoices/${id}/${s.invoice.status === "draft" ? "issue" : "send"}`, { method: "POST", body: { channels } });
            toast(s.system_of_record !== "crm" ? "In the Outbox" : "Sent");
            done("send");
          } catch (err) { busy(btn, false); showError(f, err); }
        }
      },
    },
  });
  return sh;
}
