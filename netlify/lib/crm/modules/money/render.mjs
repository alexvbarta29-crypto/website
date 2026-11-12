// Money module: the customer's pages, server-rendered (design §8.1, §8.4):
// the invoice (lines, payments so far, the balance, a tip, Pay), the card
// page, the receipt, the page Stripe returns to, and the dry-run Checkout.
// esc() on every value; the page scripts (crm-app/portal/money-*.js) read
// what they need from escaped data-* attributes (the portal CSP allows no
// inline script). Card data never touches these pages (hosted Checkout).
// Barta's voice, no em dashes.

import { esc } from "../../core/text.mjs";
import { formatCents, percentOfBps } from "../../core/money.mjs";

const money = (c) => formatCents(Number.isSafeInteger(c) ? c : 0);
const DAY = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric" });
export const dayWords = (date) => (/^\d{4}-\d{2}-\d{2}$/.test(String(date || "")) ? DAY.format(new Date(`${date}T18:00:00Z`)) : "");
const METHOD = { card: "Card", ach: "Bank account", cash: "Cash", check: "Check", other: "Other", credit: "Credit", imported: "Payment" };
const attrJson = (o) => esc(JSON.stringify(o));

export const MONEY_STYLE = `<style>
.eyebrow{margin:0 0 6px;font:800 12px/1 'Cabinet Grotesk',system-ui,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:var(--coral-ink)}
.lines{list-style:none;margin:10px 0 0;padding:0}.lines li{display:flex;justify-content:space-between;gap:14px;padding:10px 0;border-top:1px solid var(--line);font-size:15.5px}
.lines li:first-child{border-top:0}.lines .d{flex:1;min-width:0;color:var(--ink)}.lines .d small{display:block;color:var(--muted);font-size:13px}
.lines .a{flex:none;font-variant-numeric:tabular-nums;font-weight:600;color:var(--ink)}.lines .minus .a{color:#0b6b44}
.tot{display:flex;justify-content:space-between;gap:14px;padding:8px 0;font-size:15.5px;color:var(--muted)}.tot b{color:var(--ink);font-variant-numeric:tabular-nums}
.tot.big{border-top:2px solid var(--ink);margin-top:6px;padding-top:12px;font:800 20px/1.2 'Cabinet Grotesk',system-ui,sans-serif;color:var(--ink)}
.ok{padding:12px 14px;border-radius:14px;background:#eaf7f0;color:#0b6b44;font-weight:600;font-size:15px}
.warn{padding:12px 14px;border-radius:14px;background:#fff7e6;color:#8a5a00;font-size:15px}
.tips{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin:10px 0 4px}
.tip{position:relative}.tip input{position:absolute;opacity:0;inset:0;width:100%;height:100%;margin:0;cursor:pointer}
.tip span{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;min-height:56px;padding:8px 6px;border-radius:14px;box-shadow:inset 0 0 0 1.5px var(--line);background:#fff;font-weight:600;font-size:15px;text-align:center}
.tip span small{font-weight:500;color:var(--muted);font-size:13px;font-variant-numeric:tabular-nums}
.tip input:checked+span{box-shadow:inset 0 0 0 2px var(--coral);background:#fff5f3}
.tip input:focus-visible+span{outline:2px solid var(--ink);outline-offset:2px}
.field{display:flex;flex-direction:column;gap:6px;margin:12px 0}.field span{font-weight:600;font-size:14px}
.field input{width:100%;min-height:48px;padding:11px 14px;border:1.5px solid var(--line);border-radius:14px;font:500 16px/1.4 'General Sans',system-ui,sans-serif;background:#fff;color:var(--ink)}
.check{display:flex;align-items:flex-start;gap:12px;min-height:44px;margin:10px 0;font-size:15px;cursor:pointer}.check input{flex:none;width:22px;height:22px;margin:1px 0 0;accent-color:var(--coral)}
.paytotal{display:flex;justify-content:space-between;align-items:baseline;margin:14px 0 4px;font:800 22px/1.2 'Cabinet Grotesk',system-ui,sans-serif}
.linkish{display:inline-flex;align-items:center;min-height:44px;border:0;background:none;padding:0 4px;color:var(--coral-ink);font:600 15px/1 'General Sans',system-ui,sans-serif;text-decoration:underline;cursor:pointer}
.kv{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;margin:8px 0 0;font-size:15.5px}.kv dt{color:var(--muted)}.kv dd{margin:0;text-align:right;font-variant-numeric:tabular-nums;color:var(--ink);font-weight:600}
.test{padding:10px 14px;border-radius:14px;background:#16161b;color:#fff;font-weight:600;font-size:14px;margin:0 0 14px}
.stack{display:flex;flex-direction:column;gap:10px;margin-top:14px}
@media print{.noprint{display:none!important}.tot.big{border-top:1px solid #000}}
</style>`;

const qty = (l) => { const q = (l.qty_milli || 0) / 1000; return q === 1 ? "" : `${Number.isInteger(q) ? q : q.toFixed(2)} × ${money(l.unit_cents)}`; };
const lineHtml = (l) => `<li class="${l.total_cents < 0 ? "minus" : ""}"><span class="d">${esc(l.description)}${qty(l) && l.kind === "service" ? `<small>${esc(qty(l))}</small>` : ""}</span><span class="a">${l.total_cents < 0 ? "−" + esc(money(-l.total_cents)) : esc(money(l.total_cents))}</span></li>`;

function paymentsHtml(pays, invoiceId) {
  const done = pays.filter((p) => p.status === "succeeded" || p.status === "processing");
  if (!done.length) return "";
  return `<h2 style="margin-top:18px">Payments</h2><ul class="lines">${done.map((p) => {
    const what = p.kind === "refund" ? "Refund" : `${METHOD[p.method] || "Payment"}${p.card && p.card.last4 ? ` ending ${esc(p.card.last4)}` : ""}`;
    const amt = p.amount_cents + (p.tip_cents || 0);
    const link = p.kind === "payment" && p.status === "succeeded" ? ` <a class="noprint" href="/p/invoice/${esc(invoiceId)}/receipt/${esc(p.id)}">Receipt</a>` : "";
    return `<li><span class="d">${esc(what)}${p.status === "processing" ? " (clearing)" : ""}<small>${esc(dayWords(p.received_on))}${p.tip_cents && p.kind === "payment" ? ` · includes a ${esc(money(p.tip_cents))} tip` : ""}${link}</small></span><span class="a">${p.kind === "refund" ? "+" : "−"}${esc(money(amt))}</span></li>`;
  }).join("")}</ul>`;
}

// /p/invoice/:id. opts: { invoice, payments, contact, company, settings, refusal (why Pay is off, or null), plan (has a plan that takes a card), dry }
export function renderInvoicePage({ invoice: inv, payments = [], contact, company = {}, settings = {}, refusal, plan, dry }) {
  const first = String((contact && contact.first_name) || "").trim();
  const paid = inv.status === "paid";
  const closed = ["void", "uncollectible"].includes(inv.status);
  const draft = inv.status === "draft";
  const options = (settings.tip_options_bp || [0, 1000, 1500, 2000]).filter((b) => Number.isSafeInteger(b));
  const tipsOn = !refusal && !paid && !closed && !draft && inv.kind !== "deposit" && inv.kind !== "fee";
  const head = `<p class="eyebrow">${inv.kind === "deposit" ? "Deposit" : "Invoice"} ${esc(inv.number)}</p><h1>${paid ? "Paid. Thank you!" : closed ? "This invoice is closed" : `${first ? esc(first) + ", here's" : "Here's"} your ${inv.kind === "deposit" ? "deposit" : "invoice"}`}</h1>
    <p>${esc(company.legal_name || "Barta Window Washing LLC")}${inv.issued_on ? ` · ${esc(dayWords(inv.issued_on))}` : ""}${!paid && !closed && inv.due_on ? ` · due ${esc(dayWords(inv.due_on))}` : ""}</p>`;
  const totals = `<div class="tot"><span>Total</span><b>${esc(money(inv.total_cents))}</b></div>
    ${(inv.paid_cents || 0) - (inv.refunded_cents || 0) > 0 ? `<div class="tot"><span>Paid</span><b>−${esc(money((inv.paid_cents || 0) - (inv.refunded_cents || 0)))}</b></div>` : ""}
    <div class="tot big"><span>${paid ? "Balance" : "Balance due"}</span><b data-balance="${esc(String(inv.balance_cents || 0))}">${esc(money(inv.balance_cents))}</b></div>`;
  let pay = "";
  if (paid) pay = `<p class="ok">Paid in full${inv.paid_at ? ` on ${esc(dayWords(String(inv.paid_at).slice(0, 10)))}` : ""}. Thanks for choosing ${esc(company.name || "Barta Window Washing")}!</p>`;
  else if (closed) pay = `<p class="warn">Nothing is due on this invoice. Questions? Call or text us.</p>`;
  else if (draft) pay = `<p class="warn">We're still putting this invoice together. Check back soon.</p>`;
  else if (refusal) pay = `<p class="${refusal.code === "processing" || refusal.code === "charging" ? "note" : "warn"}">${esc(refusal.message)}</p>`;
  else {
    const data = { id: inv.id, balance: inv.balance_cents, options, max: Math.min(inv.balance_cents, settings.tip_custom_max_cents || 50000) };
    const tipChoices = tipsOn ? `<h2 style="margin-top:18px">Add a tip for the crew?</h2><p class="small muted">Every bit of it goes to the techs who did your windows.</p>
      <div class="tips" role="radiogroup" aria-label="Tip">${options.map((bp, i) => `<label class="tip"><input type="radio" name="tip_choice" value="${bp / 100}"${i === 0 ? " checked" : ""}><span>${bp === 0 ? "No tip" : `${bp / 100}%`}${bp ? `<small>${esc(money(percentOfBps(inv.balance_cents, bp)))}</small>` : ""}</span></label>`).join("")}
      <label class="tip"><input type="radio" name="tip_choice" value="custom"><span>Other</span></label></div>
      <label class="field" data-custom hidden><span>Tip amount</span><input name="custom_tip" inputmode="decimal" autocomplete="off" placeholder="$0.00" maxlength="9"></label>` : "";
    pay = `<div class="noprint" data-pay="${attrJson(data)}">${dry ? `<p class="test">Test mode: nothing is really charged.</p>` : ""}${tipChoices}
      ${plan ? `<label class="check"><input type="checkbox" name="save_card"><span>Save this card for my plan, so future visits are paid automatically.</span></label>` : ""}
      <div class="paytotal"><span>You pay</span><span data-paytotal>${esc(money(inv.balance_cents))}</span></div>
      <p class="err" data-error hidden></p>
      <button class="btn block" type="button" data-pay-btn>Pay ${esc(money(inv.balance_cents))}</button>
      <p class="small muted" style="margin-top:10px">You'll pay on a secure page run by Stripe. We never see your card number.</p></div>`;
  }
  const body = `${MONEY_STYLE}<section class="card">${head}
    <ul class="lines">${(inv.lines || []).map(lineHtml).join("")}</ul>${totals}${paymentsHtml(payments, inv.id)}
    ${inv.customer_note ? `<p style="margin-top:14px;color:var(--ink)">${esc(inv.customer_note)}</p>` : ""}</section>
    <section class="card">${pay}<div class="row noprint"><button class="btn ghost" type="button" data-print>View or print</button><a class="btn ghost" href="tel:+1${esc(String(company.phone || "7633143400").replace(/\D/g, "").slice(-10))}">Call us</a></div></section>`;
  return { title: `${inv.kind === "deposit" ? "Deposit" : "Invoice"} ${inv.number}`, body };
}

export function renderReceiptPage({ payment: p, invoice, company = {}, back }) {
  const total = (p.amount_cents || 0) + (p.tip_cents || 0);
  const how = `${METHOD[p.method] || "Payment"}${p.card && p.card.last4 ? ` ending ${p.card.last4}` : ""}`;
  const body = `${MONEY_STYLE}<section class="card"><p class="eyebrow">Receipt</p><h1>Thank you!</h1><p>${esc(company.legal_name || "Barta Window Washing LLC")}</p>
    <dl class="kv"><dt>Paid on</dt><dd>${esc(dayWords(p.received_on))}</dd>${invoice ? `<dt>Invoice</dt><dd>${esc(invoice.number)}</dd>` : ""}<dt>Paid with</dt><dd>${esc(how)}</dd>
    <dt>For your service</dt><dd>${esc(money(p.amount_cents))}</dd>${p.tip_cents ? `<dt>Tip for the crew</dt><dd>${esc(money(p.tip_cents))}</dd>` : ""}
    ${p.refunded_cents ? `<dt>Refunded</dt><dd>−${esc(money(p.refunded_cents))}</dd>` : ""}</dl>
    <div class="tot big"><span>Total paid</span><b>${esc(money(total - (p.refunded_cents || 0)))}</b></div>
    ${p.status !== "succeeded" ? `<p class="warn" style="margin-top:12px">This payment hasn't cleared yet.</p>` : ""}
    <div class="row noprint"><button class="btn ghost" type="button" data-print>Print or save</button>${back ? `<a class="btn ghost" href="${esc(back)}">Back to the invoice</a>` : ""}</div></section>`;
  return { title: "Receipt", body };
}

export function renderCardPage({ contact, card, company = {}, refusal, dry, ach }) {
  const first = String((contact && contact.first_name) || "").trim();
  const have = card && card.pm ? `${card.pm.kind === "us_bank_account" ? "Bank account" : String(card.pm.brand || "Card").toUpperCase()} ending ${card.pm.last4 || "••••"}${card.pm.exp_month ? `, good through ${String(card.pm.exp_month).padStart(2, "0")}/${String(card.pm.exp_year).slice(-2)}` : ""}` : null;
  const bad = card && ["failed", "expired", "missing_in_stripe"].includes(card.status);
  const body = `${MONEY_STYLE}<section class="card"><p class="eyebrow">Card on file</p><h1>${have ? "Update your card" : `${first ? esc(first) + ", add" : "Add"} a card`}</h1>
    <p>We use it for your ${esc(company.name || "Barta Window Washing")} plan visits, so you never have to think about an invoice.</p>
    ${have ? `<p class="${bad ? "warn" : "ok"}">On file now: ${esc(have)}${bad ? ". It didn't work last time, so please add a new one." : "."}</p>` : ""}
    ${dry ? `<p class="test">Test mode: no real card is saved.</p>` : ""}
    ${refusal ? `<p class="warn">${esc(refusal)}</p>` : `<p class="err" data-error hidden></p><div class="stack noprint" data-card><button class="btn block" type="button" data-card-btn>${have ? "Use a different card" : "Add a card"}</button></div>
    <p class="small muted" style="margin-top:10px">You'll enter it on a secure page run by Stripe${ach ? " (a card or a bank account)" : ""}. We never see the number.</p>`}</section>`;
  return { title: "Card on file", body };
}

export function renderReturnPage({ result }) {
  const cls = result.kind === "paid" || result.kind === "card" ? "ok" : "note";
  const back = result.back && /^\/p\/[a-z]+(\/[a-z0-9_]+)?$/.test(String(result.back.href)) ? result.back : null;
  const body = `${MONEY_STYLE}<section class="card"><h1>${esc(result.title)}</h1><p class="${cls}">${esc(result.text)}</p>
    ${back ? `<div class="row"><a class="btn ghost" href="${esc(back.href)}">${esc(back.label)}</a></div>` : ""}</section>`;
  return { title: result.title, body, refresh: result.kind === "pending" };
}

// /p/dry-checkout/:session: the stand-in for Stripe's page (sandboxed subjects only).
export function renderDryCheckout({ sid, ptr, invoice }) {
  const total = (ptr.amount_cents || 0) + (ptr.tip_cents || 0);
  const what = ptr.kind === "payment" ? `<dl class="kv"><dt>${esc(invoice ? `Invoice ${invoice.number}` : "Invoice")}</dt><dd>${esc(money(ptr.amount_cents || 0))}</dd>${ptr.tip_cents ? `<dt>Tip for the crew</dt><dd>${esc(money(ptr.tip_cents))}</dd>` : ""}</dl><div class="tot big"><span>Total</span><b>${esc(money(total))}</b></div>` : `<p>Save a card or a bank account for plan visits.</p>`;
  const done = ptr.status !== "open";
  const body = `${MONEY_STYLE}<section class="card"><p class="test">Test checkout. This stands in for Stripe while payments are in dry run: nothing is charged and no card is asked for.</p>
    <h1>${ptr.kind === "payment" ? "Pay" : "Save a card"}</h1>${what}
    ${done ? `<p class="warn" style="margin-top:14px">This checkout is ${ptr.status === "complete" ? "already finished" : "expired"}.</p>` : `<p class="err" data-error hidden></p>
    <div class="stack" data-dry="${esc(sid)}">
      <button class="btn block" type="button" data-dry-act="pay" data-method="card">${ptr.kind === "payment" ? `Pay ${esc(money(total))} with a test card` : "Save a test card"}</button>
      ${ptr.ach ? `<button class="btn ghost block" type="button" data-dry-act="pay" data-method="ach">${ptr.kind === "payment" ? "Pay by bank (clears on the next pass)" : "Save a test bank account"}</button>` : ""}
      ${ptr.ach && ptr.kind === "payment" ? `<button class="btn ghost block" type="button" data-dry-act="pay" data-method="ach_fail">Pay by bank, and have it fail</button>` : ""}
      <button class="btn ghost block" type="button" data-dry-act="decline">The card is declined</button>
      <button class="btn ghost block" type="button" data-dry-act="cancel">Cancel and go back</button>
    </div>`}</section>`;
  return { title: "Test checkout", body };
}
