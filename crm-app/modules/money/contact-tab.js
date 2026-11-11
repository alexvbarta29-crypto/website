// The contact's Money tab (design §9.2 Contact → Money): what they owe, the
// card on file, account credit, their invoices and payments, and for the
// office: a new invoice, add credit, text a card link. The Contact screen
// draws a tab but doesn't route its taps, so the two buttons here are
// listened for once on the document and act on the tab now on screen.

import { html, icon, sheet, toast, confirmSheet, delegate } from "../../core/ui.js";
import { busy, readForm, showError, clearErrors, readMoney } from "../../core/forms.js";
import { money } from "../../core/format.js";
import { uuid } from "../../core/api.js";
import { ensureStyles, invoiceRow, paymentRow, CARD } from "./kit.js";

let cur = null;        // the tab on screen: { id, ctx }
let bound = false;
function bind() {
  if (bound || typeof document === "undefined") return;
  bound = true;
  delegate(document, { "click [data-mn-credit]": () => { if (cur) creditSheet(cur); }, "click [data-mn-card-link]": () => { if (cur) cardLink(cur); } });
}
// Loads the tab again in place (the Contact screen asks for a tab it has no module for).
const reload = ({ ctx }) => { ctx.state.tabMod = null; ctx.rerender(); };

export default {
  async load(params, ctx) {
    ensureStyles();
    if (!ctx.can("invoices:read_all")) return { denied: true };
    const r = await ctx.api(`/money/contacts/${encodeURIComponent(params.id)}`, { cache: false });
    cur = { id: params.id, ctx };
    bind();
    return { id: params.id, ...r.data };
  },
  render(s) {
    if (s.denied) return html`<div class="card empty"><h2>Not for this login</h2><p>Money is for the office.</p></div>`;
    const pm = s.card && s.card.pm;
    const cardText = pm ? `${String(pm.brand || (pm.kind === "us_bank_account" ? "Bank" : "Card")).toUpperCase()} ending ${pm.last4 || "••••"} · ${CARD[s.card.status] || s.card.status}` : CARD[(s.card && s.card.status) || "none"];
    return html`<div class="stack">
      <div class="mn-tot">
        <div class="${"stat" + (s.open_balance_cents ? " bad" : "")}"><b>${money(s.open_balance_cents || 0)}</b><small>open balance</small></div>
        <div class="stat"><b>${money((s.credit && s.credit.balance_cents) || 0)}</b><small>account credit${s.credit && s.credit.held_cents ? ` (+${money(s.credit.held_cents)} to decide)` : ""}</small></div>
      </div>
      <div class="mn-acts">
        ${s.can.invoice ? html`<a class="btn primary" href="${"#/invoices/new/" + encodeURIComponent(s.id)}">${icon("plus")}New invoice</a>` : ""}
        ${s.can.credit ? html`<button type="button" class="btn" data-mn-credit>${icon("gift")}Add credit</button>` : ""}
        ${s.can.card_link ? html`<button type="button" class="btn" data-mn-card-link>${icon("link")}Text a card link</button>` : ""}
      </div>
      <section class="card"><h2>Card on file</h2><p>${cardText}</p></section>
      <div class="section-h">Invoices</div>
      ${(s.invoices || []).length ? html`<ul class="list">${s.invoices.map(invoiceRow)}</ul>` : html`<p class="muted small">No invoices yet.</p>`}
      ${s.more && s.more.invoices ? html`<p class="foot-note">The newest 12 are shown.</p>` : ""}
      ${(s.payments || []).length ? html`<div class="section-h">Payments</div><ul class="list">${s.payments.map((p) => paymentRow(p))}</ul>` : ""}
      ${s.credit && (s.credit.rows || []).length ? html`<div class="section-h">Credit</div><ul class="list">${s.credit.rows.map((c) => html`<li><div class="row"><span class="ico">${icon("gift")}</span><span class="who"><span class="nm">${c.note || c.kind}</span><span class="sub">${c.status === "held" ? "Overpayment to decide" : c.status === "settled" ? "History" : c.status === "applied" ? "Used" : "Available"}</span></span><span class="end num mn-amt">${money(c.amount_cents, { sign: c.amount_cents > 0 })}</span></div></li>`)}</ul>` : ""}
    </div>`;
  },
};

function creditSheet(tab) {
  const clientId = uuid();
  const sh = sheet({
    title: "Add account credit",
    body: html`<form class="form" data-credit-form><p class="muted small">It comes off their next invoice by itself.</p>
      <label class="field" data-field="kind"><span>What kind</span><select name="kind"><option value="goodwill">Goodwill</option><option value="referral">Referral</option><option value="gift_card">Gift card</option></select><small class="why" hidden></small></label>
      <label class="field" data-field="amount_cents"><span>Amount</span><input name="amount" inputmode="decimal" autocomplete="off" placeholder="25.00"><small class="why" hidden></small></label>
      <label class="field" data-field="note"><span>What it's for</span><input name="note" autocomplete="off" maxlength="200"><small class="why" hidden></small></label>
      <p class="err" data-form-err hidden></p><div class="btn-row"><button type="submit" class="btn primary">Add credit</button></div></form>`,
    events: {
      "submit [data-credit-form]": async (ev, form) => {
        ev.preventDefault();
        clearErrors(form);
        const v = readForm(form);
        const amount = readMoney(v.amount);
        if (!amount || amount <= 0) { showError(form, { field: "amount_cents", message: "Enter an amount." }); return; }
        const btn = form.querySelector("button[type=submit]");
        busy(btn, true);
        try {
          await tab.ctx.api(`/contacts/${encodeURIComponent(tab.id)}/credits`, { method: "POST", body: { kind: v.kind, amount_cents: amount, note: v.note, client_id: clientId }, idempotencyKey: clientId });
          sh.close(); toast("Credit added"); reload(tab);
        } catch (err) { busy(btn, false); showError(form, err); }
      },
    },
  });
}

async function cardLink(tab) {
  if (!(await confirmSheet("Text them a link to put a card on file?", { title: "Card link", yes: "Text it" }))) return;
  try {
    const r = await tab.ctx.api(`/contacts/${encodeURIComponent(tab.id)}/card-link`, { method: "POST", body: { client_id: uuid() } });
    toast(r.data.mode === "dry_run" ? "In the Outbox (texts are still practice)" : r.data.status === "sent" ? "Sent" : `Not sent${r.data.reason ? `: ${String(r.data.reason).replace(/_/g, " ")}` : ""}`, { bad: !["sent", "queued"].includes(r.data.status) && r.data.mode !== "dry_run" });
  } catch (err) { toast(err.message || "That didn't send.", { bad: true }); }
}
