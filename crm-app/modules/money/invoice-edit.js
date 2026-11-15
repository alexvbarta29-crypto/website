// The invoice editor (Rotor's phone invoice, the owner's screenshots of Nov
// 15): a full-screen sheet on a phone, a dialog on a desk. "Invoice #…" with
// the red bin and an X; the status and "Mark as Sent"; the cards Bill To,
// Invoice Details (the number with Edit, Title, Due Date with Clear, Notes),
// Line Items ("+ Saved" from the price book, "+ Add"; each line's words with a
// red bin, quantity, unit price, its total on the right, a discount in green)
// and Summary; then the payments and what happened; and the sticky bar: black
// Save, red Payment (the payment sheet, pay-sheet.js).
//
// What may change comes from the server (GET /invoices/:id `edit`): a draft
// all of it, a sent invoice nobody has paid on all of it, a paid one its
// title and notes, a void or written-off one nothing, Rotor's own nothing
// until the switch; the reason shows at the top. The totals here are only a
// preview: Save sends the lines and the server works the money out. Save
// carries the version that was read (If-Match): when someone else changed
// the invoice meanwhile, the latest is shown instead of overwriting it.

import { html, attrs, sheet, toast, confirmSheet, actionSheet } from "../../core/ui.js";
import { readMoney, showError, clearErrors, busy } from "../../core/forms.js";
import { money, dateYear, phone as fmtPhone, dateShort, dateTime } from "../../core/format.js";
import { pickFrom } from "../../core/pickers.js";
import { statusPill, MI, METHOD, PAY_STATUS } from "./kit.js";
import { openPayment } from "./pay-sheet.js";
import { openCheckout } from "./checkout.js";
import { refundSheet, voidIt, sendSheet, writeOff, showQr } from "./invoice-acts.js";

const LOCKED = ["credit", "deposit_credit"];
const qtyText = (m) => { const n = (m ?? 1000) / 1000; return Number.isInteger(n) ? String(n) : String(+n.toFixed(3)); };
const priceText = (c) => { if (c === null || c === undefined) return ""; const a = Math.abs(c); return (c < 0 ? "-" : "") + (a % 100 === 0 ? String(a / 100) : (a / 100).toFixed(2)); };
export const qtyMilli = (s) => { const t = String(s ?? "").trim(); if (!/^\d+(\.\d{1,3})?$/.test(t)) return null; const v = Math.round(Number(t) * 1000); return v > 0 ? v : null; };
// a line's price in cents: a discount line always takes money off, whatever sign was typed
const unitOf = (l) => { const u = readMoney(l.price); if (u === null) return null; return l.kind === "discount" ? -Math.abs(u) : u; };
const lineCents = (l) => { const q = qtyMilli(l.qty); const u = unitOf(l); return q === null || u === null ? null : Math.round((q * u) / 1000); };

let seq = 0;
function modelOf(s) {
  const inv = s.invoice;
  return {
    number: inv.number || "", title: inv.title || "", due_on: inv.due_on || "", customer_note: inv.customer_note || "",
    bill_to: inv.bill_to ? { ...inv.bill_to } : null,
    lines: (inv.lines || []).map((l) => ({ key: `k${++seq}`, id: l.id, kind: l.kind || "service", description: l.description || "", qty: qtyText(l.qty_milli), price: priceText(l.unit_cents), locked: LOCKED.includes(l.kind), total: l.total_cents })),
  };
}
const editable = (m) => m.lines.filter((l) => !l.locked);
const sig = (m) => JSON.stringify([m.number.trim(), m.title.trim(), m.due_on, m.customer_note, m.bill_to, editable(m).map((l) => [l.id || "", l.kind, l.description.trim(), l.qty.trim(), l.price.trim(), l.price_item_id || ""])]);

// The preview of the money (the server's word is final).
function totals(m, inv) {
  let sub = 0, disc = 0, cred = 0, bad = false;
  for (const l of m.lines) {
    const c = l.locked ? l.total : lineCents(l);
    if (c === null) { bad = true; continue; }
    if (l.locked) cred += -c; else if (c < 0) disc += -c; else sub += c;
  }
  const total = Math.max(0, sub - disc - cred);
  const paid = (inv.paid_cents || 0) - (inv.refunded_cents || 0);
  return { subtotal: sub - disc, credit: cred, total, paid, balance: Math.max(0, total - paid), bad };
}

// ------------------------------------------------------------ the cards

const row = (inv, f) => ({ st: inv.status, od: f.overdue, pp: f.partially_paid, af: f.autopay_failed, pr: f.processing, ex: inv.excess_cents });

function billTo(c) {
  const s = c.s, m = c.m;
  const ct = s.contact || {};
  const bt = m.bill_to || {};
  const name = bt.name || ct.display_name || "The customer";
  const lines = [bt.email || ct.email, bt.phone || (ct.phone ? fmtPhone(ct.phone) : ""), bt.address || ct.address].filter(Boolean);
  return html`<section class="rs-card mn-ed-card" data-field="bill_to">
    <div class="mn-ed-ch"><h3>Bill To</h3>${s.edit && s.edit.money ? html`<button type="button" class="mn-ed-sm" data-ed-bill>Edit</button>` : ""}</div>
    <p class="mn-ed-bn">${name}</p>
    ${lines.map((x) => html`<p class="mn-ed-bs">${x}</p>`)}
    ${m.bill_to ? html`<p class="mn-ed-hint">Shown on the invoice. Texts and emails still go to the customer's own phone and email.</p>` : ""}
    <small class="why" hidden></small>
  </section>`;
}

function details(c) {
  const s = c.s, m = c.m, e = s.edit || {};
  const ro = !e.details;
  return html`<section class="rs-card mn-ed-card">
    <h3>Invoice Details</h3>
    <div class="mn-ed-f" data-field="number"><span class="mn-ed-l" id="mn-ed-numl">Invoice number</span>
      ${c.editNumber ? html`<input class="mn-ed-in" name="number" maxlength="24" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-labelledby="mn-ed-numl" ${attrs({ value: m.number })}>`
        : html`<div class="mn-ed-num"><span class="num">${m.number}</span>${e.money ? html`<button type="button" class="mn-ed-sm" data-ed-num aria-label="Edit the invoice number">Edit</button>` : ""}</div>`}
      <small class="why" hidden></small></div>
    <label class="mn-ed-f" data-field="title"><span class="mn-ed-l">Title</span><input class="mn-ed-in" name="title" maxlength="120" autocomplete="off" ${attrs({ value: m.title, placeholder: `Invoice #${m.number}`, disabled: ro })}><small class="why" hidden></small></label>
    <div class="mn-ed-f" data-field="due_on"><label class="mn-ed-l" for="mn-ed-due">Due Date</label>
      <div class="mn-ed-date"><input class="mn-ed-in" type="date" id="mn-ed-due" name="due_on" ${attrs({ value: m.due_on, disabled: !e.due })}>${e.due && m.due_on && s.invoice.status === "draft" ? html`<button type="button" class="mn-ed-clear" data-ed-clear>Clear</button>` : ""}<span class="mn-ed-cal" aria-hidden="true">${MI.cal}</span></div>
      <small class="why" hidden></small></div>
    <label class="mn-ed-f" data-field="customer_note"><span class="mn-ed-l">Notes</span><textarea class="mn-ed-in" name="customer_note" rows="3" maxlength="1000" ${attrs({ placeholder: s.job_number ? `For Job #${s.job_number}` : "A note for the customer", disabled: ro })}>${m.customer_note}</textarea><small class="why" hidden></small></label>
  </section>`;
}

function lineRow(l, j, money_ok) {
  const t = lineCents(l);
  const neg = (t !== null && t < 0) || l.kind === "discount";
  if (l.locked || !money_ok) {
    return html`<li class="mn-ed-line ro"><div class="mn-ed-ro"><span class="d">${l.description}</span>${!l.locked && l.qty !== "1" ? html`<small>${l.qty} × ${money(unitOf(l))}</small>` : l.locked ? html`<small>${l.kind === "deposit_credit" ? "Deposit paid" : "Account credit"}</small>` : ""}</div><span ${attrs({ class: "mn-ed-lt num" + (neg || l.locked ? " green" : "") })}>${money(l.locked ? l.total : t)}</span></li>`;
  }
  return html`<li class="mn-ed-line" ${attrs({ "data-key": l.key })}>
    <div class="mn-ed-lr1" ${attrs({ "data-field": `lines.${j}.description` })}><input class="mn-ed-in" data-l="description" maxlength="300" autocomplete="off" ${attrs({ value: l.description, placeholder: l.kind === "discount" ? "Discount" : "Description", "aria-label": `Line ${j + 1}: description` })}><button type="button" class="mn-ed-bin" ${attrs({ "data-ed-rm": l.key, "aria-label": `Remove line ${j + 1}` })}>${MI.bin}</button><small class="why" hidden></small></div>
    <div class="mn-ed-lr2">
      <label class="mn-ed-q" ${attrs({ "data-field": `lines.${j}.qty_milli` })}><input class="mn-ed-in" data-l="qty" inputmode="decimal" autocomplete="off" ${attrs({ value: l.qty, "aria-label": `Line ${j + 1}: quantity` })}><small class="why" hidden></small></label>
      <label class="mn-ed-p" ${attrs({ "data-field": `lines.${j}.unit_cents` })}><input class="mn-ed-in" data-l="price" inputmode="decimal" autocomplete="off" placeholder="0" ${attrs({ value: l.price, "aria-label": `Line ${j + 1}: ${l.kind === "discount" ? "discount" : "unit price"}` })}><small class="why" hidden></small></label>
      <span ${attrs({ class: "mn-ed-lt num" + (neg ? " green" : ""), "data-lt": l.key })}>${t === null ? "-" : money(t)}</span>
    </div>
  </li>`;
}

function linesCard(c) {
  const s = c.s, m = c.m, e = s.edit || {};
  let j = -1;
  return html`<section class="rs-card mn-ed-card">
    <div class="mn-ed-ch"><h3>Line Items</h3>${e.money ? html`<div class="mn-ed-add"><button type="button" class="mn-ed-ob" data-ed-saved aria-label="Add from saved items">+ Saved</button><button type="button" class="mn-ed-bb" data-ed-add aria-label="Add a line">+ Add</button></div>` : ""}</div>
    <div data-field="lines"><small class="why" hidden></small></div>
    ${m.lines.length ? html`<ul class="mn-ed-lines" aria-label="Line items">${m.lines.map((l) => { if (!l.locked) j += 1; return lineRow(l, j, !!e.money); })}</ul>` : html`<p class="rs-empty">No lines yet. Add one.</p>`}
  </section>`;
}

function summary(c) {
  const t = totals(c.m, c.s.invoice);
  const inv = c.s.invoice;
  const kv = (k, v, cls = "", key = null) => html`<div ${attrs({ class: "mn-ed-sr" + (cls ? " " + cls : "") })}><span>${k}</span><span ${attrs({ class: "num", "data-sum": key })}>${v}</span></div>`;
  return html`<section class="rs-card mn-ed-card" data-ed-sum>
    <h3>Summary</h3>
    ${kv("Subtotal", money(t.subtotal), "", "sub")}
    ${t.credit ? kv("Credit", "−" + money(t.credit), "green") : ""}
    ${kv("Total", money(t.total), "tot", "tot")}
    ${inv.tips_cents ? kv("Tips for the crew", money(inv.tips_cents)) : ""}
    ${t.paid ? kv("Paid", "−" + money(t.paid)) : ""}
    ${t.paid || inv.status === "open" ? kv(inv.excess_cents ? "Overpaid" : "Balance due", money(inv.excess_cents || t.balance), "tot", "bal") : ""}
  </section>`;
}

function paymentsCard(c) {
  const s = c.s;
  const list = s.payments || [];
  if (!list.length) return "";
  const can = s.can || {};
  return html`<section class="rs-card mn-ed-card"><h3>Payments</h3>${list.map((p) => {
    const [cls, words] = PAY_STATUS[p.status] || ["", p.status];
    const refund = p.kind === "refund";
    const left = p.total_cents - (p.refunded_cents || 0);
    return html`<div class="mn-pay"><span class="t"><b>${refund ? "Refund" : METHOD[p.method] || p.method}${p.reference ? ` · ${p.reference}` : ""}</b><small>${dateShort(p.received_on)}${p.tip_cents && !refund ? ` · tip ${money(p.tip_cents)}` : ""}${p.via === "qr" ? " · scanned the pay code" : ""}${p.simulated ? " · test" : ""}</small></span>
      <span class="p">${refund ? "−" : ""}${money(p.total_cents)}<br><span class="${"pill " + (refund ? "" : cls)}">${refund ? "Refund" : words}</span></span>
      ${!refund && p.status === "succeeded" && left > 0 && can.refund ? html`<button type="button" class="act" ${attrs({ "data-refund": p.id, "data-left": String(left) })}>Refund</button>` : ""}</div>`;
  })}</section>`;
}

function historyCard(c) {
  const inv = c.s.invoice;
  const rows = [
    inv.issued_on && ["Issued", dateShort(inv.issued_on)],
    inv.sent_at && [inv.marked_sent ? "Marked as sent" : "Sent", dateTime(inv.sent_at)],
    inv.edited_after_sent_at && ["Changed after it was sent", dateTime(inv.edited_after_sent_at)],
    // scan to pay: when the code was shown, and when the customer's phone opened it
    inv.qr && inv.qr.shown && ["Pay code shown", `${inv.qr.shown === 1 ? "once" : `${inv.qr.shown} times`}${inv.qr.last_shown_at ? `, the last ${dateTime(inv.qr.last_shown_at)}` : ""}`],
    inv.qr && inv.qr.opened && ["Opened from the code", inv.qr.opened === 1 ? dateTime(inv.qr.last_opened_at) : `${inv.qr.opened} times, the last ${dateTime(inv.qr.last_opened_at)}`],
    inv.paid_at && inv.status === "paid" && ["Paid", dateShort(inv.paid_at)],
    inv.voided_at && ["Void", `${dateShort(inv.voided_at)}${inv.void_reason ? `: ${inv.void_reason}` : ""}`],
  ].filter(Boolean);
  if (!rows.length) return "";
  return html`<section class="rs-card mn-ed-card"><h3>History</h3><dl class="kv">${rows.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl></section>`;
}

// The red Payment opens the payment sheet: an open invoice with something left, or a draft (marked sent first).
const canPay = (s) => { const c = s.can || {}; const inv = s.invoice; return (inv.status === "open" && inv.balance_cents > 0 && (c.record || c.charge || c.qr || c.send)) || (inv.status === "draft" && c.mark_sent && (inv.total_cents || 0) > 0); };

function body(c) {
  const s = c.s, e = s.edit || {}, can = s.can || {};
  const inv = s.invoice;
  return html`<div class="mn-ed">
    <div class="mn-ed-top">
      <div class="mn-ed-pills">${statusPill(row(inv, s.flags || {}))}${s.sandboxed && s.system_of_record !== "crm" ? html`<span class="pill">Test</span>` : ""}</div>
      <div class="mn-ed-acts">${can.mark_sent ? html`<button type="button" class="mn-ed-ob mn-ed-sent" data-ed-sent>${MI.send}<span>Mark as Sent</span></button>` : ""}<button type="button" class="mn-ed-ob mn-ed-more" data-ed-more aria-label="More">•••</button></div>
    </div>
    ${e.why ? html`<p class="mn-ed-why" role="note">${e.why}</p>` : s.rotor_owned ? html`<p class="mn-ed-why" role="note">This invoice came from Rotor and is still Rotor's until the switch.</p>` : ""}
    ${inv.edited_after_sent_at && inv.status === "open" ? html`<p class="mn-ed-why" role="note">Changed after it was sent: send it again so they see this one.</p>` : ""}
    <form class="mn-ed-form" data-ed novalidate>
      ${billTo(c)}${details(c)}${linesCard(c)}${summary(c)}
      <p class="err" data-form-err hidden></p>
    </form>
    ${paymentsCard(c)}${historyCard(c)}
    ${e.details || canPay(s) ? html`<div class="mn-ed-bar">
      ${e.details ? html`<button type="button" class="mn-ed-save" data-ed-save>${MI.save}<span>Save</span></button>` : ""}
      ${canPay(s) ? html`<button type="button" class="mn-ed-pay" data-ed-pay>${MI.card}<span>Payment</span></button>` : ""}
    </div>` : ""}
  </div>`;
}

// ------------------------------------------------------------ the controller

// Reads the inputs into the model (before a redraw or a save).
function sync(c) {
  const root = c.sh.el;
  const f = (n) => root.querySelector(`[data-ed] [name=${n}]`);
  if (f("number")) c.m.number = f("number").value;
  if (f("title")) c.m.title = f("title").value;
  if (f("due_on")) c.m.due_on = f("due_on").value;
  if (f("customer_note")) c.m.customer_note = f("customer_note").value;
  for (const li of root.querySelectorAll(".mn-ed-line[data-key]")) {
    const l = c.m.lines.find((x) => x.key === li.dataset.key);
    if (!l) continue;
    for (const inp of li.querySelectorAll("[data-l]")) l[inp.dataset.l] = inp.value;
  }
}
const dirty = (c) => { sync(c); return sig(c.m) !== c.base; };

// The PATCH body: only what changed. → body | null (nothing) | { error }
function patchBody(c) {
  const m = c.m, o = c.orig;
  const b = {};
  if (m.number.trim() !== o.number.trim()) b.number = m.number.trim();
  if (m.title.trim() !== o.title.trim()) b.title = m.title.trim() || null;
  if (m.due_on !== o.due_on) b.due_on = m.due_on || null;
  if (m.customer_note !== o.customer_note) b.customer_note = m.customer_note || null;
  if (JSON.stringify(m.bill_to) !== JSON.stringify(o.bill_to)) b.bill_to = m.bill_to || null;
  const lines = editable(m);
  const linesSig = (mm) => JSON.stringify(editable(mm).map((l) => [l.id || "", l.kind, l.description.trim(), l.qty.trim(), l.price.trim(), l.price_item_id || ""]));
  if (linesSig(m) !== linesSig(o)) {
    const out = [];
    for (const [j, l] of lines.entries()) {
      if (!l.description.trim()) return { error: { field: `lines.${j}.description`, message: "What is it for?" } };
      const q = qtyMilli(l.qty);
      if (q === null) return { error: { field: `lines.${j}.qty_milli`, message: "A quantity, like 1 or 2.5." } };
      const u = unitOf(l);
      if (u === null) return { error: { field: `lines.${j}.unit_cents`, message: "A price, like 445 or 12.50." } };
      out.push({ ...(l.id ? { id: l.id } : {}), description: l.description.trim(), qty_milli: q, unit_cents: u, ...(l.kind === "fee" ? { kind: "fee" } : u < 0 ? { kind: "discount" } : {}), ...(l.price_item_id ? { price_item_id: l.price_item_id } : {}) });
    }
    b.lines = out;
  }
  return Object.keys(b).length ? b : null;
}

// openEditor(ctx, { state, onClose }) → the editor. ctx: the screen's (api, back, refresh).
// state: GET /invoices/:id's data with its etag. onClose(changed) after it closes.
export function openEditor(ctx, { state, onClose } = {}) {
  const c = { ctx, s: state, m: modelOf(state), editNumber: false, changed: false, closed: false };
  c.orig = modelOf(state);
  c.base = sig(c.m);
  const id = encodeURIComponent(state.invoice.id);
  const head = () => html`${c.s.can && c.s.can.void ? html`<button type="button" class="mn-ed-hbin" data-ed-bin ${attrs({ "aria-label": c.s.invoice.status === "draft" ? "Delete this draft" : "Void this invoice" })}>${MI.bin}</button>` : ""}<button type="button" class="mn-ed-x" data-ed-x aria-label="Close">${MI.x}</button>`;
  const titleOf = () => `Invoice #${c.s.invoice.number}`;
  const draw = () => {
    c.sh.set(body(c));
    const h = c.sh.el.querySelector(".sheet-head h2");
    if (h) h.textContent = titleOf();
  };
  // the totals follow what is typed, without drawing the form again
  const retotal = () => {
    const t = totals(c.m, c.s.invoice);
    const set = (k, v) => { const el = c.sh.el.querySelector(`[data-sum=${k}]`); if (el) el.textContent = v; };
    set("sub", money(t.subtotal)); set("tot", money(t.total)); set("bal", money(c.s.invoice.excess_cents || t.balance));
    for (const l of c.m.lines) {
      const el = c.sh.el.querySelector(`[data-lt="${l.key}"]`);
      if (!el) continue;
      const v = lineCents(l);
      el.textContent = v === null ? "-" : money(v);
      el.classList.toggle("green", (v !== null && v < 0) || l.kind === "discount");
    }
  };
  c.reload = async () => {
    const r = await ctx.api(`/invoices/${id}`, { cache: false });
    c.s = { ...r.data, etag: r.etag || r.data.etag };
    c.m = modelOf(c.s);
    c.orig = modelOf(c.s);
    c.base = sig(c.m);
    c.editNumber = false;
    if (!c.closed) draw();
  };
  const save = async (btn) => {
    sync(c);
    const form = c.sh.el.querySelector("[data-ed]");
    clearErrors(form);
    const b = patchBody(c);
    if (!b) return true;
    if (b.error) { showError(form, b.error); return false; }
    if (btn) busy(btn, true, "Saving…");
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await ctx.api(`/invoices/${id}`, { method: "PATCH", body: b, ifMatch: c.s.etag });
        c.changed = true;
        toast("Saved");
        await c.reload();
        return true;
      } catch (err) {
        if (err.status === 412 && attempt === 0) {
          // the invoice changed since it was read (it was sent, a reminder went out, someone else saved):
          // when nothing this person changed was touched there, their changes go on top of the latest
          const r = await ctx.api(`/invoices/${id}`, { cache: false });
          const latest = { ...r.data, etag: r.etag || r.data.etag };
          const now = modelOf(latest);
          const same = (k) => (k === "lines" ? sig({ ...c.orig, number: "", title: "", due_on: "", customer_note: "", bill_to: null }) === sig({ ...now, number: "", title: "", due_on: "", customer_note: "", bill_to: null }) : JSON.stringify(k === "bill_to" ? c.orig.bill_to : c.orig[k]) === JSON.stringify(k === "bill_to" ? now.bill_to : now[k]));
          if (Object.keys(b).every(same) && latest.edit && latest.edit.details) { c.s = latest; c.orig = now; continue; }
          if (btn) busy(btn, false);
          toast("Someone else just changed this invoice. Here is the latest.", { bad: true });
          await c.reload();
          return false;
        }
        if (btn) busy(btn, false);
        showError(form, err);
        return false;
      }
    }
    return false;
  };
  const close = async () => {
    if (dirty(c) && !(await confirmSheet("Your changes on this invoice aren't saved.", { title: "Discard changes?", yes: "Discard", no: "Keep editing", danger: true }))) return;
    c.sh.close();
  };
  const stand = () => ({ ...ctx, state: c.s, refresh: () => { c.changed = true; return c.reload(); } });
  const markSent = async (btn) => {
    if (!(await save())) return false;
    busy(btn, true, "Marking…");
    try {
      await ctx.api(`/invoices/${id}/mark-sent`, { method: "POST", body: {} });
      c.changed = true;
      toast("Marked as sent. Nothing was sent to the customer.");
      await c.reload();
      return true;
    } catch (err) { busy(btn, false); toast(err.message || "That didn't save.", { bad: true }); return false; }
  };
  const payment = async (btn) => {
    if (!(await save())) return;
    if (c.s.invoice.status === "draft") {
      if (!(await confirmSheet("It's still a draft. Mark it as sent (nothing goes to the customer) and take a payment?", { title: "Take a payment", yes: "Mark as sent" }))) return;
      try { await ctx.api(`/invoices/${id}/mark-sent`, { method: "POST", body: {} }); c.changed = true; await c.reload(); } catch (err) { toast(err.message || "That didn't save.", { bad: true }); return; }
    }
    openPayment(ctx, { state: c.s, onDone: () => { c.changed = true; c.reload().catch(() => {}); } });
  };
  const more = () => {
    const can = c.s.can || {};
    const inv = c.s.invoice;
    actionSheet(titleOf(), [
      [
        (can.issue || can.send) && { label: can.issue ? "Send to the customer" : "Send again", icon: "send", run: () => sendSheet(stand()) },
        can.qr && { label: "Show QR to pay", icon: "qr", run: () => showQr(stand()), data: { "ed-qr": true } },
        inv.status === "open" && inv.balance_cents > 0 && (can.record || can.charge) && { label: "Checkout with a tip", icon: "money", run: () => openCheckout({ api: ctx.api, invoiceId: inv.id, onDone: () => { c.changed = true; c.reload().catch(() => {}); } }) },
      ],
      [
        c.s.contact && { label: "Open customer", icon: "user", href: "#/contacts/" + encodeURIComponent(c.s.contact.id) },
        ...(inv.job_ids || []).slice(0, 1).map((j) => ({ label: "Open the job", icon: "doc", href: "#/jobs/" + encodeURIComponent(j) })),
      ],
      [can.write_off && { label: "Write off", icon: "close", danger: true, run: () => writeOff(stand()) }],
    ]);
  };
  const billSheet = () => {
    sync(c);
    const bt = c.m.bill_to || {};
    const ct = c.s.contact || {};
    const f = (name, label, value, extra = {}) => html`<label class="field" ${attrs({ "data-field": `bill_to.${name}` })}><span>${label}</span><input ${attrs({ name, value: value || "", autocomplete: "off", ...extra })}><small class="why" hidden></small></label>`;
    const sh = sheet({
      title: "Bill To",
      body: html`<form class="form" data-bill novalidate>
        <p class="muted small">Who the invoice shows it's billed to (a company, say). Texts and emails still go to the customer's own phone and email.</p>
        ${f("name", "Name", bt.name, { placeholder: ct.display_name || "", maxlength: "120" })}
        ${f("email", "Email", bt.email, { type: "email", inputmode: "email", placeholder: ct.email || "", maxlength: "200" })}
        ${f("phone", "Phone", bt.phone, { type: "tel", inputmode: "tel", placeholder: ct.phone ? fmtPhone(ct.phone) : "", maxlength: "30" })}
        ${f("address", "Address", bt.address, { placeholder: ct.address || "", maxlength: "300" })}
        <p class="err" data-form-err hidden></p>
        <div class="btn-row">${c.m.bill_to ? html`<button type="button" class="btn" data-bill-reset>Use the customer's</button>` : ""}<button type="submit" class="btn primary">Done</button></div>
      </form>`,
      events: {
        "click [data-bill-reset]": () => { c.m.bill_to = null; sh.close(); draw(); },
        "submit [data-bill]": (e, form) => {
          e.preventDefault();
          clearErrors(form);
          const v = Object.fromEntries(["name", "email", "phone", "address"].map((k) => [k, form.querySelector(`[name=${k}]`).value.trim()]));
          if (v.email && !/^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/i.test(v.email)) { showError(form, { field: "bill_to.email", message: "That email doesn't look right." }); return; }
          if (v.phone && !/^[+()\d .-]{7,30}$/.test(v.phone)) { showError(form, { field: "bill_to.phone", message: "That phone number doesn't look right." }); return; }
          const out = Object.fromEntries(Object.entries(v).filter(([, x]) => x));
          c.m.bill_to = Object.keys(out).length ? out : null;
          sh.close();
          draw();
        },
      },
    });
  };
  const savedItems = async () => {
    sync(c);
    let book = [];
    try { book = ((await ctx.api("/pricebook")).data || []).filter((x) => x.active !== false && x.sellable !== false); } catch (e) { book = []; }
    const pick = await pickFrom({
      title: "Saved items",
      items: [{ value: { discount: true }, label: "Discount", sub: "Take money off" }, ...book.slice(0, 200).map((x) => ({ value: x, label: x.name, sub: x.unit_cents ? `${money(x.unit_cents)}${x.unit && x.unit !== "flat" ? ` a ${x.unit}` : ""}` : "Price it here" }))],
    });
    if (!pick) return;
    if (pick.discount) c.m.lines.push({ key: `k${++seq}`, kind: "discount", description: "Discount", qty: "1", price: "", locked: false });
    else c.m.lines.push({ key: `k${++seq}`, kind: "service", description: pick.name, qty: "1", price: priceText(pick.unit_cents || 0), price_item_id: pick.id, locked: false });
    draw();
    const last = c.sh.el.querySelector(".mn-ed-line[data-key]:last-of-type [data-l=price]");
    if (last && pick.discount) last.focus();
  };

  c.sh = sheet({
    title: titleOf(),
    className: "mn-fs mn-edsheet",
    headEnd: head(),
    body: body(c),
    onClose: () => { c.closed = true; if (onClose) onClose(c.changed); },
    events: {
      "click [data-ed-x]": () => close(),
      "click [data-ed-bin]": () => {
        if (c.s.invoice.status === "draft") {
          confirmSheet("Delete this draft? It stays in the list as void, so its number isn't used again.", { title: "Delete draft", yes: "Delete", danger: true }).then(async (yes) => {
            if (!yes) return;
            try { await ctx.api(`/invoices/${id}/void`, { method: "POST", body: { reason: "Draft deleted" } }); c.changed = true; toast("Deleted"); c.base = sig(c.m); c.sh.close(); } catch (err) { toast(err.message || "That didn't save.", { bad: true }); }
          });
          return;
        }
        voidIt(stand());
      },
      "click [data-ed-more]": () => more(),
      "click [data-ed-sent]": (e, el) => markSent(el),
      "click [data-ed-save]": (e, el) => { save(el).then((ok) => { if (ok) busy(el, false); }).catch(() => {}); },
      "click [data-ed-pay]": (e, el) => payment(el),
      "click [data-ed-num]": () => { sync(c); c.editNumber = true; draw(); const i = c.sh.el.querySelector("[name=number]"); if (i) i.focus(); },
      "click [data-ed-clear]": () => { sync(c); c.m.due_on = ""; draw(); },
      "click [data-ed-bill]": () => billSheet(),
      "click [data-ed-saved]": () => savedItems(),
      "click [data-ed-add]": () => {
        sync(c);
        if (editable(c.m).length >= 40) { toast("Keep it under 40 lines.", { bad: true }); return; }
        c.m.lines.push({ key: `k${++seq}`, kind: "service", description: "", qty: "1", price: "", locked: false });
        draw();
        const all = c.sh.el.querySelectorAll(".mn-ed-line[data-key] [data-l=description]");
        if (all.length) all[all.length - 1].focus();
      },
      "click [data-ed-rm]": (e, el) => { sync(c); c.m.lines = c.m.lines.filter((l) => l.key !== el.dataset.edRm); draw(); },
      "input [data-l]": () => { sync(c); retotal(); },
      "click [data-refund]": (e, el) => refundSheet(stand(), el.dataset.refund, Number(el.dataset.left)),
    },
  });
  return c;
}
