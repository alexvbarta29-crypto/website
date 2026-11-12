// "Collect payment" on the Visit screen (design §9.2 Visit, §5.6): for the
// office and the visit's own techs. Shows what is left on the visit's
// invoice, records cash or a check, or shows a QR code the customer scans
// to pay by card on their own phone (a tip and all). A payment is never
// kept for later: it needs signal, and the sheet says so.

import { html, raw, attrs, sheet, toast } from "../../core/ui.js";
import { busy, readForm, showError, clearErrors, readMoney } from "../../core/forms.js";
import { money } from "../../core/format.js";
import { uuid } from "../../core/api.js";
import { ensureStyles } from "./kit.js";

const offline = (e) => !!e && (e.code === "offline" || e.status === 0 || e.name === "OfflineError");
const NEEDS_SIGNAL = "Taking a payment needs signal. Nothing was recorded: try again when you're back online.";

function body(p, mode, link) {
  const inv = p.invoice;
  const bal = inv && Number.isSafeInteger(inv.balance_cents) ? inv.balance_cents : null;
  if (inv && inv.status === "paid") return html`<p class="ok">This visit is paid${inv.number ? ` (${inv.number})` : ""}. Nothing to collect.</p>`;
  if (!inv && !p.can.make) return html`<p class="muted">${p.billable === false ? "This kind of visit isn't billed." : "There's nothing to collect on this visit."}</p>`;
  if (mode === "qr" && link) {
    return html`<div class="mn-qr">${raw(link.svg)}<p><b>${money(link.balance_cents)}</b> · ${link.number}</p>
      <p class="small muted">The customer points their phone's camera at this and pays on their own phone. They can add a tip there.</p>
      <div class="btn-row"><button type="button" class="btn" data-back>Back</button><button type="button" class="btn primary" data-check>Did it go through?</button></div></div>`;
  }
  return html`<form class="form" data-collect novalidate>
    <p>${bal !== null ? html`Left to pay: <b class="num">${money(bal)}</b>${inv.number ? ` (${inv.number})` : ""}` : p.job_total_cents ? html`The visit comes to <b class="num">${money(p.job_total_cents)}</b>.` : "The invoice is made when you take the payment."}</p>
    <div class="mn-seg" role="group" aria-label="How they paid">
      <label><input type="radio" name="method" value="cash" checked><span>Cash</span></label>
      <label><input type="radio" name="method" value="check"><span>Check</span></label>
    </div>
    <label class="field" data-field="amount_cents"><span>Amount for the work</span><input name="amount" inputmode="decimal" autocomplete="off" ${attrs({ value: bal !== null ? (bal / 100).toFixed(2) : p.job_total_cents ? (p.job_total_cents / 100).toFixed(2) : "" })}><small class="why" hidden></small></label>
    <label class="field" data-field="tip_cents"><span>Tip, if they gave one</span><input name="tip" inputmode="decimal" autocomplete="off" placeholder="0.00"><small class="why" hidden></small></label>
    <label class="field" data-field="reference"><span>Check number</span><input name="reference" inputmode="numeric" autocomplete="off" maxlength="20"><small class="why" hidden></small></label>
    <p class="err" data-form-err hidden></p>
    <div class="btn-row"><button type="submit" class="btn primary">Record it</button><button type="button" class="btn" data-qr>Pay by card (QR)</button></div>
    <p class="small muted">Needs signal: a payment is never saved for later.</p>
  </form>`;
}

export default {
  async run(data, ctx) {
    ensureStyles();
    const visitId = data.visit.id;
    const path = `/visits/${encodeURIComponent(visitId)}`;
    let p;
    try { p = (await ctx.api(`${path}/payment`, { cache: false })).data; } catch (e) { toast(offline(e) ? NEEDS_SIGNAL : e.message || "That didn't load.", { bad: true }); return; }
    if (p.offline) { toast(NEEDS_SIGNAL, { bad: true }); return; }
    const clientId = uuid();
    let link = null;
    const sh = sheet({
      title: "Collect payment",
      body: body(p, "form"),
      events: {
        "submit [data-collect]": async (e, form) => {
          e.preventDefault();
          clearErrors(form);
          const v = readForm(form);
          const amount = readMoney(v.amount);
          const tip = v.tip ? readMoney(v.tip) : 0;
          if (!amount || amount <= 0) { showError(form, { field: "amount_cents", message: "How much did they pay?" }); return; }
          if (tip === null || tip < 0) { showError(form, { field: "tip_cents", message: "That tip doesn't look right." }); return; }
          const btn = form.querySelector("button[type=submit]");
          busy(btn, true);
          try {
            const r = await ctx.api(`${path}/payments`, { method: "POST", body: { method: v.method === "check" ? "check" : "cash", amount_cents: amount, tip_cents: tip, ...(v.reference ? { reference: v.reference } : {}), client_id: clientId }, idempotencyKey: clientId });
            const inv = r.data.invoice;
            sh.close();
            toast(inv && inv.status === "paid" ? "Recorded. The visit is paid." : inv && inv.balance_cents > 0 ? `Recorded. ${money(inv.balance_cents)} is left.` : "Recorded.");
            ctx.refresh();
          } catch (err) { busy(btn, false); showError(form, offline(err) ? { message: NEEDS_SIGNAL } : err); }
        },
        "click [data-qr]": async (e, el) => {
          busy(el, true);
          try {
            const r = await ctx.api(`${path}/pay-link`, { method: "POST", body: {} });
            const { qrSvg } = await import("./qr.js");
            link = { ...r.data, svg: qrSvg(r.data.url, { label: "Scan to pay" }) };
            sh.set(body(p, "qr", link));
          } catch (err) { busy(el, false); showError(el.closest("form"), offline(err) ? { message: NEEDS_SIGNAL } : err); }
        },
        "click [data-back]": () => sh.set(body(p, "form")),
        "click [data-check]": async (e, el) => {
          busy(el, true);
          try {
            p = (await ctx.api(`${path}/payment`, { cache: false })).data;
            if (p.invoice && p.invoice.status === "paid") { sh.close(); toast("Paid. Thank you!"); ctx.refresh(); return; }
            busy(el, false);
            toast("Not yet. Give it a few seconds after they finish.");
          } catch (err) { busy(el, false); toast(offline(err) ? NEEDS_SIGNAL : err.message || "That didn't load.", { bad: true }); }
        },
      },
    });
  },
};
