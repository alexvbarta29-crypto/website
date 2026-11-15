// One invoice (design §9.2 "Invoice"), laid out like Rotor's invoice window
// (Rotor's screenshot 37), in its order: the head (the status, "View Job",
// the balance), Job Details (the job's number and status), the invoice's
// title and due date, the invoice link (Send, and the QR that opens it),
// Bill To, Line Items (the lines and totals, tips, what's paid and the
// balance), Notes, and the foot: Void (the red bin), "Collect Payment"
// (charge the card on file, record cash or a check, the QR, a card link)
// and when it was sent. Then what Rotor's window doesn't show: the
// payments (refund one), the card on file or Add Payment Method, the
// history folded after 3 rows; the round "..." holds everything too
// (Write off, Open customer, Open the plan). Before the switch from Rotor,
// online payment and card charges only run on test contacts and records
// made here (the screen says so).
//
// On a phone the invoice opens as Rotor's phone invoice instead: the editor
// (invoice-edit.js) full screen over this page, its X going back. On a desk
// this page stays (beside the list) and the pencil opens the same editor;
// "Collect Payment" opens Rotor's payment sheet (pay-sheet.js).

import { html, attrs, icon, rnd, openExternal, actionSheet, cardHead, sectionLabel, personCard, pillBtn, statusPill as kitPill } from "../../core/ui.js";
import { money, dateShort, dateYear, dateTime, ago, phone } from "../../core/format.js";
import { SPLIT_MEDIA } from "../../core/router.js";
import { openEditor } from "./invoice-edit.js";
import { openPayment } from "./pay-sheet.js";
import { ensureStyles, statusPill, KIND, METHOD, PAY_STATUS } from "./kit.js";
import { cardWords, showQr, charge, cardLink, keepCredit, writeOff, voidIt, sendSheet, recordSheet, refundSheet } from "./invoice-acts.js";

async function load(params, ctx) {
  ensureStyles();
  const r = await ctx.api(`/invoices/${encodeURIComponent(params.id)}`, { cache: false });
  const d = r.data;
  // Job Details (Rotor's): the first job's number and status, when this login may read jobs
  const jid = d.invoice && (d.invoice.job_ids || [])[0];
  const job = jid && d.contact && ctx.can("schedule:read") ? await ctx.api(`/jobs/${encodeURIComponent(jid)}`).then((x) => (x.data && x.data.job) || null).catch(() => null) : null;
  return { ...d, job, etag: r.etag || d.etag };
}

const qty = (l) => { const q = (l.qty_milli || 0) / 1000; return q === 1 ? "" : `${Number.isInteger(q) ? q : q.toFixed(2)} × ${money(l.unit_cents)}`; };

const kv = (k, v, cls = "rs-li-sum") => html`<div class="${cls}"><span>${k}</span><span class="num">${v}</span></div>`;

// Items: the lines, the total, tips, what's paid and the balance (the kit's line items).
function items(inv) {
  const net = (inv.paid_cents || 0) - (inv.refunded_cents || 0);
  const paid = inv.status === "paid" && !inv.excess_cents;
  const lines = inv.lines || [];
  const amt = (c) => (c < 0 ? "−" + money(-c) : money(c));
  const q = (l) => { const n = (l.qty_milli ?? 1000) / 1000; return Number.isInteger(n) ? String(n) : n.toFixed(2); };
  // Rotor's columns: Description · Qty · Unit Price · Total (a discount or a fee is one amount)
  return html`<div class="rs-card mn-items">${cardHead("Line Items")}
    ${lines.length ? html`<div class="mn-ltable"><div class="mn-lrow mn-lhead" aria-hidden="true"><span>Description</span><span class="n">Qty</span><span class="n">Unit Price</span><span class="n">Total</span></div>
      <ul class="mn-llist" aria-label="Line items">${lines.map((l) => html`<li class="mn-lrow"><span class="d">${l.description}</span><span class="n">${l.kind === "service" ? q(l) : ""}</span><span class="n">${l.kind === "service" && l.unit_cents != null ? money(l.unit_cents) : ""}</span><span class="n t">${amt(l.total_cents)}</span></li>`)}</ul></div>` : html`<p class="rs-empty">No lines.</p>`}
    <div class="mn-sums">
      ${kv("Total", money(inv.total_cents), "rs-li-tot")}
      ${inv.tips_cents ? kv("Tips for the crew", money(inv.tips_cents)) : ""}
      ${net ? kv("Paid", "−" + money(net)) : ""}
      ${kv(inv.excess_cents ? "Overpaid" : "Balance", money(inv.excess_cents ? inv.excess_cents : inv.balance_cents), "rs-li-tot")}
      ${paid ? html`<p class="rs-paid">Paid in full</p>` : ""}
    </div>
  </div>`;
}

function payments(s, ctx) {
  const list = s.payments || [];
  const c = s.can || {};
  return html`<div class="rs-card">${cardHead("Payments", { add: c.record ? { label: "Record a payment", data: { act: "record" } } : null, count: list.length ? String(list.length) : null })}
    ${list.length ? html`<div>${list.map((p) => {
      const [cls, words] = PAY_STATUS[p.status] || ["", p.status];
      const refund = p.kind === "refund";
      const left = p.total_cents - (p.refunded_cents || 0);
      const what = `${refund ? "Refund" : METHOD[p.method] || p.method}${p.card && p.card.last4 ? ` ending ${p.card.last4}` : ""}${p.reference ? ` · ${p.reference}` : ""}`;
      return html`<div class="mn-pay"><span class="t"><b>${what}</b><small>${dateShort(p.received_on)}${p.tip_cents && !refund ? ` · tip ${money(p.tip_cents)}` : ""}${p.via === "qr" ? " · scanned the pay code" : ""}${p.refund_reason ? ` · ${p.refund_reason}` : ""}${p.failure_code ? ` · ${String(p.failure_code).replace(/_/g, " ")}` : ""}${p.simulated ? " · test" : ""}</small></span>
        <span class="p">${refund ? "−" : ""}${money(p.total_cents)}<br><span class="${"pill " + (refund ? "" : cls)}">${refund ? "Refund" : words}</span></span>
        ${!refund && p.status === "succeeded" && left > 0 && c.refund ? html`<button type="button" class="act" ${attrs({ "data-refund": p.id, "data-left": String(left) })}>Refund</button>` : ""}</div>`;
    })}</div>` : html`<p class="rs-empty">No payments yet</p>`}
  </div>`;
}

function historyRows(inv) {
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
  return rows;
}
// The history: the first 3 rows, the rest folded.
function history(inv) {
  const rows = historyRows(inv);
  if (!rows.length) return "";
  const dl = (rs) => html`<dl class="kv">${rs.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>`;
  return html`<div class="rs-card">${cardHead("History")}${dl(rows.slice(0, 3))}${rows.length > 3 ? html`<details class="mn-more"><summary>${rows.length - 3} more</summary>${dl(rows.slice(3))}</details>` : ""}</div>`;
}


function paymentCard(s) {
  const c = s.can || {};
  const has = s.card && s.card.last4 && ["on_file", "verified"].includes(s.card.status);
  return html`${sectionLabel("Payment")}<div class="rs-card mn-paycard">
    <div class="rs-row"><span class="mn-cardline">${icon("pay")}<span>${cardWords(s)}</span></span></div>
    ${!has && c.card_link && s.invoice.status === "open" ? pillBtn("Add Payment Method", { tone: "solid", wide: true, data: { act: "card-link" }, aria: "Add Payment Method: text them a card link" }) : ""}
  </div>`;
}

const JOB_WORD = { unscheduled: "To book", scheduled: "Scheduled", in_progress: "Under way", completed: "Done", cancelled: "Cancelled" };
const JOB_TONE = { unscheduled: "amber", scheduled: "blue", in_progress: "amber", completed: "green", cancelled: "red" };

// The head: the status pills, "View Job", the balance (or the total), and what holds it back.
function topCard(s) {
  const inv = s.invoice;
  const f = s.flags || {};
  const row = { st: inv.status, od: f.overdue, pp: f.partially_paid, af: f.autopay_failed, pr: f.processing, ex: inv.excess_cents };
  const paid = inv.status === "paid";
  const jid = (inv.job_ids || [])[0];
  const note = s.rotor_owned ? "This invoice came from Rotor and is still Rotor's until the switch. It can be read here; change it in Rotor and the next import brings it over."
    : inv.status !== "open" ? "" : s.online === "not_yet" ? "Rotor still bills this customer: paying online and card charges open after the switch. You can still record cash or a check."
    : s.online === "charging" ? "A card charge is running right now." : s.online === "processing" ? "A bank payment is clearing (a few days). No new charge or pay link until it does." : "";
  return html`<section class="rs-card mn-top">
    <div class="rs-row"><span class="rs-pills">${statusPill(row)}${inv.kind && inv.kind !== "standard" ? kitPill(KIND[inv.kind] || inv.kind, "white") : ""}${s.sandboxed && s.system_of_record !== "crm" ? html`<span class="pill">Test</span>` : ""}</span>${jid ? pillBtn("View Job", { icon: "share", href: "#/jobs/" + encodeURIComponent(jid) }) : ""}</div>
    <div class="rs-kv"><span>${inv.status === "open" ? "Balance due" : "Total"}</span><span class="${"rs-amt" + (paid ? " green" : "")}">${money(inv.status === "open" ? inv.balance_cents : inv.total_cents)}</span></div>
    ${paid ? html`<p class="rs-paid">Paid in full${inv.paid_at ? ` · ${dateShort(inv.paid_at)}` : ""}</p>` : ""}
    ${note ? html`<p class="warn-box">${note}</p>` : ""}
    ${inv.excess_cents > 0 && !inv.excess_kept ? html`<p class="warn-box">They paid ${money(inv.excess_cents)} too much. Refund it from the payment below, or keep it as credit for their next visit.</p>` : ""}
  </section>`;
}

// Job Details (Rotor's): the job's number and its status; a second job or the plan under it.
function jobCard(s) {
  const inv = s.invoice;
  const ids = inv.job_ids || [];
  if (!ids.length && !inv.plan_id) return "";
  const j = s.job;
  return html`<div class="rs-card mn-job">
    <div class="rs-row"><h3 class="mn-h">Job Details</h3>${j ? kitPill(JOB_WORD[j.status] || j.status, JOB_TONE[j.status] || "grey") : ""}</div>
    ${ids.slice(0, 3).map((id, i) => html`<a class="rs-inset" href="${"#/jobs/" + encodeURIComponent(id)}"><span><b>Job Number:</b> ${i === 0 && j ? j.number_label || j.number : ids.length > 1 ? `${i + 1} of ${ids.length}` : "Open the job"}${i === 0 && j && j.title ? html` <span class="rs-sub">· ${j.title}</span>` : ""}</span><span class="chev" aria-hidden="true"></span></a>`)}
    ${inv.plan_id ? html`<a class="rs-inset" href="${"#/plans/" + encodeURIComponent(inv.plan_id)}"><span><b>Plan:</b> Open the plan</span><span class="chev" aria-hidden="true"></span></a>` : ""}
  </div>`;
}

// The invoice's title and due date (Rotor's two fields), and when it was issued.
function detailsCard(s) {
  const inv = s.invoice;
  const kv = [["Invoice Title", inv.title || `${KIND[inv.kind] || "Invoice"} #${inv.number}`], ["Due Date", inv.due_on ? dateYear(inv.due_on) : "-"], inv.issued_on && ["Issued", dateYear(inv.issued_on)], inv.plan_month && ["Cycle", inv.plan_month]].filter(Boolean);
  return html`<div class="rs-card mn-fields">${kv.map(([k, v]) => html`<div class="mn-field"><span class="rs-stat-l">${k}</span><span class="mn-fv">${v}</span></div>`)}</div>`;
}

// The invoice link: the pay link goes with each text and email, and the QR opens it.
function linkCard(s) {
  const c = s.can || {};
  const inv = s.invoice;
  const send = c.issue || c.send;
  if (!send && !c.qr) return "";
  return html`<div class="rs-card mn-link"><h3 class="mn-h">Invoice Link</h3>
    <p class="rs-sub">${inv.status === "draft" ? "Sending it makes the link: they see the invoice and pay by card." : "The link goes with each text and email; the QR opens it on their phone."}</p>
    <div class="mn-actrow">${send ? pillBtn(c.issue ? "Send to the customer" : inv.sent_at ? "Send again" : "Send", { tone: "solid", icon: "send", data: { act: "send" } }) : ""}${c.qr ? pillBtn("QR", { icon: "qr", data: { act: "qr" }, aria: "Show QR to pay" }) : ""}</div>
  </div>`;
}

// Bill To (Rotor's): the customer, with call and text.
function billTo(s) {
  const c = s.contact;
  if (!c) return "";
  const bt = s.invoice.bill_to || {};
  return html`${sectionLabel("Bill To")}${personCard({ name: bt.name || c.display_name || "The customer", sub: [bt.phone || (c.phone ? phone(c.phone) : ""), bt.address].filter(Boolean).join(" · "), href: "#/contacts/" + encodeURIComponent(c.id), call: c.phone ? "tel:" + c.phone : null, text: c.phone && c.has_sms ? "sms:" + c.phone : null })}`;
}

// The foot (Rotor's): the red bin (Void), Collect Payment, and when it was sent.
function foot(s) {
  const c = s.can || {};
  const inv = s.invoice;
  const collect = c.record || c.charge || c.qr || (c.card_link && inv.status === "open");
  if (!collect && !c.void && !inv.sent_at) return "";
  return html`<div class="mn-foot">
    <div class="mn-foot-r">${c.void ? rnd("trash", "Void this invoice", { tone: "red", sm: true, data: { act: "void" } }) : ""}
      ${collect ? pillBtn("Collect Payment", { tone: "red", icon: "money", popup: true, data: { act: "collect" }, aria: "Collect Payment: charge the card, record cash or a check, the QR" }) : ""}</div>
    ${inv.sent_at ? html`<p class="rs-sub mn-sent">Invoice sent ${ago(inv.sent_at)}</p>` : ""}
  </div>`;
}

// Collect Payment: the ways in (the sheet's rows, each with its old data-act).
export function collectRows(s, ctx) {
  const c = s.can || {};
  return [[
    c.charge && s.card && s.card.last4 && { label: "Charge the card", icon: "pay", hint: cardWords(s), run: () => charge(null, ctx), data: { act: "charge" } },
    c.record && { label: "Record a payment", icon: "money", hint: "cash, check", run: () => recordSheet(ctx), data: { act: "record" } },
    c.qr && { label: "Show QR to pay", icon: "qr", run: () => showQr(ctx), data: { act: "qr" } },
    c.card_link && s.invoice.status === "open" && { label: "Text a card link", icon: "link", run: () => cardLink(ctx), data: { act: "card-link" } },
  ]];
}
// Collect Payment: Rotor's payment sheet (the card, cash or a check, a pay link, the QR).
const collect = (ctx) => openPayment(ctx, { state: ctx.state, onDone: () => ctx.refresh() });

// The editor: full screen on a phone (the route's own view), a dialog on a desk.
const wide = () => typeof matchMedia === "function" && matchMedia(SPLIT_MEDIA).matches;
let editor = null;
let leaving = false;
function edit(ctx, { phone: onPhone = false } = {}) {
  if (editor && !editor.closed) return;
  editor = openEditor(ctx, {
    state: ctx.state,
    onClose: (changed) => {
      editor = null;
      if (leaving) return;
      if (onPhone) ctx.back();
      else if (changed) ctx.refresh();
    },
  });
}

function moreRows(s, ctx) {
  const c = s.can || {};
  const inv = s.invoice;
  return [
    [
      (c.issue || c.send) && { label: c.issue ? "Send to the customer" : inv.sent_at ? "Send again" : "Send", icon: "send", run: () => sendSheet(ctx), data: { act: "send" } },
      c.card_link && inv.status === "open" && { label: "Text a card link", icon: "link", run: () => cardLink(ctx), data: { act: "card-link" } },
      c.charge && { label: "Charge the card", icon: "pay", run: () => charge(null, ctx), data: { act: "charge" } },
      c.qr && { label: "Show QR to pay", icon: "qr", run: () => showQr(ctx), data: { act: "qr" } },
      c.record && { label: "Record a payment", icon: "money", hint: "cash, check", run: () => recordSheet(ctx), data: { act: "record" } },
      inv.excess_cents > 0 && !inv.excess_kept && c.refund && { label: "Keep the extra as credit", icon: "money", run: () => keepCredit(ctx), data: { act: "keep" } },
    ],
    [
      s.contact && { label: "Open customer", icon: "user", href: "#/contacts/" + encodeURIComponent(s.contact.id) },
      ...(inv.job_ids || []).slice(0, 3).map((j) => ({ label: "Open the job", icon: "doc", href: "#/jobs/" + encodeURIComponent(j) })),
      inv.plan_id && { label: "Open the plan", icon: "check", href: "#/plans/" + encodeURIComponent(inv.plan_id) },
    ],
    [
      c.write_off && { label: "Write off", icon: "close", danger: true, run: () => writeOff(ctx), data: { act: "write-off" } },
      c.void && { label: "Void", icon: "trash", danger: true, run: () => voidIt(ctx), data: { act: "void" } },
    ],
  ];
}

const titleOf = (s) => (s && s.invoice ? `${KIND[s.invoice.kind] || "Invoice"} ${s.invoice.number}` : "Invoice");

export default {
  title: titleOf,
  load,
  tools: (s, ctx) => [s.can && s.can.edit && { icon: "edit", label: "Edit invoice", run: () => edit(ctx), data: { act: "edit" } }],
  more: (s, ctx) => moreRows(s, ctx),
  // a phone: Rotor's phone invoice, full screen over this page
  mount(el, s, ctx) {
    leaving = false;
    if (!wide() && !editor && el.id !== "pane") edit(ctx, { phone: true });
  },
  unmount() {
    if (!editor) return;
    leaving = true;
    try { editor.sh.close(); } catch (e) { /* gone */ }
    editor = null;
  },
  moreTitle: titleOf,
  render(s, ctx) {
    const inv = s.invoice;
    return html`<div class="rs-page mn-page">
      ${topCard(s)}
      ${jobCard(s)}
      ${detailsCard(s)}
      ${linkCard(s)}
      ${billTo(s)}
      ${items(inv)}
      ${inv.customer_note ? html`<div class="rs-card mn-notes"><h3 class="mn-h">Notes</h3><p class="mn-note">${inv.customer_note}</p></div>` : ""}
      ${foot(s)}
      ${payments(s, ctx)}
      ${paymentCard(s)}
      ${history(inv)}
    </div>`;
  },
  events: {
    "click [data-act=send]": (e, el, ctx) => sendSheet(ctx),
    "click [data-act=record]": (e, el, ctx) => recordSheet(ctx),
    "click [data-act=qr]": (e, el, ctx) => showQr(ctx),
    "click [data-act=charge]": (e, el, ctx) => charge(el, ctx),
    "click [data-act=card-link]": (e, el, ctx) => cardLink(ctx),
    "click [data-act=collect]": (e, el, ctx) => collect(ctx),
    "click [data-act=void]": (e, el, ctx) => voidIt(ctx),
    "click [data-refund]": (e, el, ctx) => refundSheet(ctx, el.dataset.refund, Number(el.dataset.left)),
  },
};

export { openExternal };
