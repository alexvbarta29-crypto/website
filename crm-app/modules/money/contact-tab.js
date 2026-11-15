// The contact's Money tab (design §9.2 Contact → Money): what they owe, the
// card on file, account credit, their invoices and payments, and for the
// office: a new invoice, add credit, text a card link. The Contact screen
// draws a tab but doesn't route its taps, so the two buttons here are
// listened for once on the document and act on the tab now on screen.
// cards() and actions() (Nov 2026, Rotor's lead and customer pages): an
// Invoices card (open balance and credit on one line, the invoices, + New
// invoice and + Add credit, the card on file for a lead) and, for a
// customer, a Payment card (the card on file, Add Payment Method: the card
// link text); New invoice, Add credit and Text a card link in the "...".
// Rotor's phone app (Nov 15): the Payment card is the method on file (a BANK
// tile or the card's brand, "... ending in 1234", BANK ACCOUNT (ACH) or CARD,
// ADDED <date>, a black round button that texts a new card link), else Add
// Payment Method; on a phone (ctx.phone) the invoices read #number, the
// pill, the amount and the due or paid date and how it was paid; the open
// balance line and the New invoice and Add credit pills stay on a desk (the
// customer's phone page has them in the Service tab's numbers and its red +).

import { html, icon, sheet, toast, confirmSheet, delegate, pillBtn, rnd, statusPill as kitPill } from "../../core/ui.js";
import { busy, readForm, showError, clearErrors, readMoney } from "../../core/forms.js";
import { money, dateYear } from "../../core/format.js";
import { uuid } from "../../core/api.js";
import { ensureStyles, invoiceRow, paymentRow, statusPill, CARD, METHOD } from "./kit.js";

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
  // the Service tab's Outstanding tile (Rotor's)
  tiles(s) { return s && !s.denied ? [{ key: "owed", label: "Outstanding", value: money(s.open_balance_cents || 0).replace(/\.00$/, ""), tone: s.open_balance_cents > 0 ? "red" : null }] : []; },
  cards(s, ctx) {
    if (!s || s.denied) return [];
    const id = encodeURIComponent(s.id);
    const customer = !!(ctx && ctx.contact && ["customer", "former_customer"].includes(ctx.contact.lifecycle));
    const credit = (s.credit && s.credit.balance_cents) || 0;
    const head = html`<p class="${"rs-sub mn-line" + (s.open_balance_cents ? " bad" : "")}"><b class="num">${money(s.open_balance_cents || 0)}</b> open balance · <b class="num">${money(credit)}</b> account credit${s.credit && s.credit.held_cents ? ` (+${money(s.credit.held_cents)} to decide)` : ""}</p>`;
    const pills = s.can.invoice || s.can.credit ? html`<div class="rs-li-add">${s.can.invoice ? pillBtn("New invoice", { icon: "plus", href: "#/invoices/new/" + id }) : ""}${s.can.credit ? pillBtn("Add credit", { icon: "plus", data: { "mn-credit": true } }) : ""}</div>` : "";
    const cardLine = html`<p class="mn-card">${icon("money")}<span>Card on file: ${cardText(s)}</span></p>`;
    const phone = !!(ctx && ctx.phone);
    const rows = html`${(s.invoices || []).length ? html`<ul class="list">${s.invoices.map(phone ? (r) => phoneInvoiceRow(r, s.payments || []) : invoiceRow)}</ul>` : html`<p class="rs-empty">No invoices yet</p>`}
      ${s.more && s.more.invoices ? html`<p class="foot-note">The newest 12 are shown.</p>` : ""}
      ${(s.payments || []).length ? html`<h4 class="ct-sub-h">Payments</h4><ul class="list">${s.payments.map((p) => paymentRow(p))}</ul>` : ""}
      ${s.credit && (s.credit.rows || []).length ? html`<h4 class="ct-sub-h">Credit</h4><ul class="list">${s.credit.rows.map(creditRow)}</ul>` : ""}`;
    // (a customer's phone page is Rotor's: the invoices alone; the balance is in the Service tab's numbers and New
    // invoice and Add credit are on the red +)
    const out = [{ key: "invoices", tab: "details", title: "Invoices", count: (s.invoices || []).length || null, body: phone && customer ? rows : html`${head}${rows}${pills}${customer ? "" : cardLine}` }];
    if (customer) {
      const pm = s.card && s.card.pm;
      out.push({ key: "payment", tab: "details", title: "Payment", body: html`${pm ? methodRow(s.card, s.can.card_link) : html`<p class="mn-card">${icon("money")}<span>${s.card && s.card.status && s.card.status !== "none" ? CARD[s.card.status] || s.card.status : "No card or bank account on file"}</span></p>`}${!pm && s.can.card_link ? html`<div class="rs-li-cta">${pillBtn("Add Payment Method", { tone: "solid", wide: true, icon: "plus", data: { "mn-card-link": true } })}</div>` : ""}` });
    }
    return out;
  },
  actions(s, ctx) {
    if (!s || s.denied) return [];
    const id = encodeURIComponent(s.id);
    return [
      s.can.invoice && { key: "invoice", label: "New invoice", icon: "receipt", href: "#/invoices/new/" + id },
      s.can.credit && { key: "credit", label: "Add credit", icon: "gift", run: () => creditSheet({ id: s.id, ctx }) },
      s.can.card_link && { key: "cardlink", label: "Text a card link", icon: "link", run: () => cardLink({ id: s.id, ctx }) },
    ].filter(Boolean);
  },
  render(s) {
    if (s.denied) return html`<div class="card empty"><h2>Not for this login</h2><p>Money is for the office.</p></div>`;
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
      <section class="card"><h2>Card on file</h2><p>${cardText(s)}</p></section>
      <div class="section-h">Invoices</div>
      ${(s.invoices || []).length ? html`<ul class="list">${s.invoices.map(invoiceRow)}</ul>` : html`<p class="muted small">No invoices yet.</p>`}
      ${s.more && s.more.invoices ? html`<p class="foot-note">The newest 12 are shown.</p>` : ""}
      ${(s.payments || []).length ? html`<div class="section-h">Payments</div><ul class="list">${s.payments.map((p) => paymentRow(p))}</ul>` : ""}
      ${s.credit && (s.credit.rows || []).length ? html`<div class="section-h">Credit</div><ul class="list">${s.credit.rows.map(creditRow)}</ul>` : ""}
    </div>`;
  },
};

const cardText = (s) => {
  const pm = s.card && s.card.pm;
  return pm ? `${String(pm.brand || (pm.kind === "us_bank_account" ? "Bank" : "Card")).toUpperCase()} ending ${pm.last4 || "••••"} · ${CARD[s.card.status] || s.card.status}` : CARD[(s.card && s.card.status) || "none"];
};
// Rotor's card on file: a BANK tile or the brand; "... ending in 1234"; BANK ACCOUNT (ACH) or CARD; ADDED <date>;
// the status when it isn't good; a black round button: text them a link to put a new one on file.
export function methodRow(card, canLink) {
  const pm = card.pm;
  const bank = pm.kind === "us_bank_account";
  const brand = String(pm.brand || (bank ? "Bank" : "Card")).toUpperCase();
  const bad = !["on_file", "verified"].includes(card.status);
  return html`<div class="ct-pm"><span class="${"ct-pm-tile" + (bank ? " bank" : "")}" aria-hidden="true">${bank ? "BANK" : brand.slice(0, 4)}</span>
    <span class="ct-pm-w"><span class="ct-pm-n">${brand} ending in ${pm.last4 || "••••"}</span>
      <span class="ct-pm-s">${bank ? "Bank account (ACH)" : `Card${pm.exp_month ? ` · exp ${String(pm.exp_month).padStart(2, "0")}/${String(pm.exp_year || "").slice(-2)}` : ""}`}</span>
      ${pm.added ? html`<span class="ct-pm-s">Added ${dateYear(String(pm.added).slice(0, 10))}</span>` : ""}
      ${bad ? html`<span>${kitPill(CARD[card.status] || card.status, "red")}</span>` : ""}</span>
    ${canLink ? rnd("link", "Text them a link for a new card or bank account", { tone: "solid", data: { "mn-card-link": true } }) : ""}</div>`;
}
// Rotor's phone invoice row: #number and its pill; the amount, then when it is due, or when and how it was paid.
export function phoneInvoiceRow(r, payments = []) {
  const p = payments.find((x) => x.inv === r.id && x.st === "succeeded" && x.k !== "refund");
  const when = r.st === "paid" ? [r.pd ? `Paid ${dateYear(String(r.pd).slice(0, 10))}` : "Paid", p ? `via ${METHOD[p.m] || p.m}` : ""].filter(Boolean).join(" ") : r.st === "open" && r.due ? `Due ${dateYear(r.due)}` : r.iss ? dateYear(r.iss) : "";
  return html`<li><a class="row ct-ir" href="${"#/invoices/" + encodeURIComponent(r.id)}">
    <span class="who"><span class="nm ct-when">#${r.n || "Draft"}${statusPill(r)}</span></span>
    <span class="end ct-ir-e"><span class="num ct-ir-a">${money(r.st === "open" ? r.bal : r.tot)}</span>${when ? html`<span class="ct-ir-w">${when}</span>` : ""}</span></a></li>`;
}
const creditRow = (c) => html`<li><div class="row"><span class="ico">${icon("gift")}</span><span class="who"><span class="nm">${c.note || c.kind}</span><span class="sub">${c.status === "held" ? "Overpayment to decide" : c.status === "settled" ? "History" : c.status === "applied" ? "Used" : "Available"}</span></span><span class="end num mn-amt">${money(c.amount_cents, { sign: c.amount_cents > 0 })}</span></div></li>`;

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
