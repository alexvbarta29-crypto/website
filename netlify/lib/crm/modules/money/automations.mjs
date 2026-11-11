// Money module: its automations and their texts (design §5.7.4, §5.6
// "Invoice sent", "Overdue reminders"). Every send goes through the core
// sender: the Outbox (dry-run) until cutover; quiet hours, consent, opt-outs
// and the STOP footer are the sender's (a template never says "Reply STOP").
//
//   invoice.sent     event invoice.sent (an invoice was issued, or a person
//                    tapped Send): the portal link by text and/or email. An
//                    autopay invoice says nothing here: it waits for its
//                    charge result (a receipt, or payment.failed with the
//                    card link); one whose card turned out unusable gets the
//                    invoice text after all.
//   invoice.overdue  sweep, daily 10:00: the day after due_on, then every
//                    cfg/money.overdue_every_days (3), at most overdue_max
//                    (5); stops on payment, a clearing bank payment or void;
//                    never for an invoice the import brought in.
//   payment.receipt  event payment.succeeded: a receipt link (one per payment)
//   payment.failed   event payment.failed: the card-update link
//   card.expiring    sweep (off by default): a card on an active autopay
//                    plan that runs out within 30 days, once per card month
//
// Links are bearer secrets made when the automation runs, never stored on a
// record: invoice (until paid + cfg/portal invoice_after_paid_days), receipt
// (90 days), card (7 days).

import { getRecord, getSetting, readIndex, updateRecord } from "../../../crm-store.mjs";
import { isId } from "../../core/ids.mjs";
import { now, nowIso, localDate, addLocalDays, zonedToUtc } from "../../core/clock.mjs";
import { runAutomation } from "../../core/automations.mjs";
import { createPortalLink } from "../../portal/core.mjs";
import { formatCents } from "../../core/money.mjs";
import { emit } from "../../core/events.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { isProcessing } from "./balance.mjs";
import { W, today, moneySettings } from "./common.mjs";
import { expiringCards } from "./cards.mjs";

const DATE = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
export const dateWords = (d) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? DATE.format(new Date(`${d}T18:00:00Z`)) : "");

export const TEMPLATES = Object.freeze([
  { key: "invoice_sent", name: "Invoice ready (text)", channel: "sms", category: "service", body: "Hi {{first_name|there}}, thanks for having {{company_name}} out! Your invoice {{invoice_number}} for {{balance_due}} is ready. You can see it and pay here: {{invoice_link}}" },
  {
    key: "invoice_sent_email", name: "Invoice ready (email)", channel: "email", category: "service", subject: "Your invoice {{invoice_number}} from {{company_name}}",
    body: "Hi {{first_name|there}},\n\nThanks for having us out! Your invoice {{invoice_number}} for {{balance_due}} is ready. Tap below to see it and pay by card.\n\n{{invoice_link}}\n\nQuestions? Just reply or call us at {{company_phone}}.\n\n{{sender_first_name|The Barta team}} with {{company_name}}",
  },
  { key: "invoice_overdue", name: "Invoice reminder (text)", channel: "sms", category: "service", body: "Hi {{first_name|there}}, a friendly reminder from {{company_name}}: invoice {{invoice_number}} still has {{balance_due}} open. You can pay here: {{invoice_link}} Questions? Call us at {{company_phone}}." },
  { key: "payment_receipt", name: "Payment receipt (text)", channel: "sms", category: "service", body: "Thanks {{first_name|so much}}! We got your payment for invoice {{invoice_number}}. Here's your receipt: {{receipt_link}}" },
  {
    key: "payment_receipt_email", name: "Payment receipt (email)", channel: "email", category: "service", subject: "Your receipt from {{company_name}}",
    body: "Hi {{first_name|there}},\n\nThank you! We got your payment for invoice {{invoice_number}}. Your receipt is here:\n\n{{receipt_link}}\n\nSee you next time,\n{{sender_first_name|The Barta team}} with {{company_name}}",
  },
  { key: "payment_failed", name: "Card didn't go through (text)", channel: "sms", category: "service", body: "Hi {{first_name|there}}, it's {{company_name}}. Your card didn't go through for invoice {{invoice_number}} ({{balance_due}}). You can update your card here: {{card_link}} or call us at {{company_phone}} and we'll sort it out." },
  { key: "card_update", name: "Card expiring (text)", channel: "sms", category: "service", body: "Hi {{first_name|there}}, the card we have on file for your {{company_name}} plan expires soon. You can update it here in a minute: {{card_link}}" },
  { key: "card_link", name: "Add a card (text)", channel: "sms", category: "service", body: "Hi {{first_name|there}}, here's the link to put a card on file with {{company_name}}: {{card_link}} It takes about a minute. Questions? Call us at {{company_phone}}." },
]);

const INVOICE_TPL = { sms: "invoice_sent", email: "invoice_sent_email" };
const RECEIPT_TPL = { sms: "payment_receipt", email: "payment_receipt_email" };

export async function invoiceLink(inv, by = "automation:invoice") {
  const portal = await getSetting("portal").catch(() => ({}));
  const days = (portal && portal.lifetimes && portal.lifetimes.invoice_after_paid_days) || 90;
  return createPortalLink({ contact_id: inv.contact_id, scope: { kind: "invoice", id: inv.id }, expires_at: zonedToUtc(addLocalDays(today(), days + 60), "23:59").toISOString(), created_by: by });
}
export const cardLink = (contactId, by = "automation:card") => createPortalLink({ contact_id: contactId, scope: { kind: "card" }, created_by: by });
export const receiptLink = (p, by = "automation:receipt") => createPortalLink({ contact_id: p.contact_id, scope: { kind: "receipt", id: p.id }, created_by: by });

const invoiceVars = (inv, link) => ({ invoice_link: link.url, invoice_number: inv.number, invoice_total: formatCents(inv.total_cents || 0), balance_due: formatCents(inv.balance_cents || 0), due_date: inv.due_on ? dateWords(inv.due_on) : null });

// ------------------------------------------------------------ invoice.sent

export async function invoiceSentRun(input, actx) {
  const p = (input.event && input.event.payload) || {};
  const g = isId(p.invoice_id, "invoice") ? await getRecord("invoice", p.invoice_id).catch(() => null) : null;
  const inv = g && g.data;
  if (!inv || inv.deleted_at || inv.status !== "open" || !(inv.balance_cents > 0)) { await actx.log(p.invoice_id, "skipped:changed"); return { result: "skipped:changed" }; }
  // an autopay invoice waits for its charge result instead of guessing (§5.6)
  if (p.wait_for_charge && !p.manual) { await actx.log(inv.id, "skipped:awaiting_charge"); return { result: "skipped:awaiting_charge" }; }
  const channels = (Array.isArray(p.channels) && p.channels.length ? p.channels : actx.settings.channels || ["sms"]).filter((c) => INVOICE_TPL[c]);
  if (!channels.length) { await actx.log(inv.id, "skipped:no_channels"); return { result: "skipped:no_channels" }; }
  const link = await invoiceLink(inv, "automation:invoice.sent");
  let queued = 0;
  for (const ch of channels) {
    const r = await actx.send({
      contact_id: inv.contact_id, subject: { type: "invoice", id: inv.id }, key: `${inv.id}--${String((input.event && input.event.event_id) || p.wv || "x").slice(0, 30)}--${ch}`,
      channel: ch, template_key: INVOICE_TPL[ch], vars: invoiceVars(inv, link), related: { invoice_id: inv.id }, record: inv, fact_at: inv.issued_at || inv.created_at,
    });
    if (r.queued) queued += 1;
  }
  if (queued) await updateRecord("invoice", inv.id, (x) => (x.sent_at ? null : { ...x, sent_at: nowIso(), sent_via: [...new Set([...(x.sent_via || []), ...channels])] }), actx.write()).catch(() => null);
  return { result: queued ? `queued:${queued}` : "skipped:not_queued" };
}

// Re-checked when the send is due: a paid or void invoice isn't texted.
export async function invoiceRecheck(item) {
  const id = item && item.data && item.data.related && item.data.related.invoice_id;
  const g = id ? await getRecord("invoice", id).catch(() => null) : null;
  if (!g || g.data.deleted_at || g.data.status !== "open" || !(g.data.balance_cents > 0) || isProcessing(g.data)) return { skip: "changed" };
  return {};
}

// An autopay invoice whose card turned out unusable gets the invoice text
// after all (a fresh invoice.sent on a new write of the invoice).
export async function sendInvoiceLinkAfterAutopay(inv, ctx) {
  const w = W(ctx);
  const r = await updateRecord("invoice", inv.id, (x) => ({ ...x, autopay: { ...(x.autopay || {}), eligible: false, no_card_at: nowIso() } }), w);
  if (!r.changed) return;
  await emit("invoice.sent", { id: `${inv.id}.sent`, wv: r.data.wv, invoice_id: inv.id, contact_id: inv.contact_id, channels: ["sms", "email"], wait_for_charge: false, by: "system:autopay" }, w)
    .catch((e) => console.error(`crm:money: invoice.sent not queued (${safeErr(e)})`));
}

// ------------------------------------------------------------ payment.receipt / payment.failed

export async function receiptRun(input, actx) {
  const p = (input.event && input.event.payload) || {};
  const g = isId(p.payment_id, "payment") ? await getRecord("payment", p.payment_id).catch(() => null) : null;
  const pay = g && g.data;
  if (!pay || pay.kind !== "payment" || pay.status !== "succeeded") { await actx.log(p.payment_id, "skipped:changed"); return { result: "skipped:changed" }; }
  if (pay.import) { await actx.log(pay.id, "skipped:imported"); return { result: "skipped:imported" }; }
  const settings = await moneySettings();
  const link = await receiptLink(pay);
  const channels = (actx.settings.channels || ["sms", "email"]).filter((c) => RECEIPT_TPL[c] && (c !== "email" || settings.receipt_email !== false));
  let queued = 0;
  for (const ch of channels) {
    const r = await actx.send({
      contact_id: pay.contact_id, subject: { type: "payment", id: pay.id }, key: ch === channels[0] ? pay.id : `${pay.id}--${ch}`, channel: ch, template_key: RECEIPT_TPL[ch],
      vars: { receipt_link: link.url, invoice_number: pay.invoice_number || "your visit" }, related: { payment_id: pay.id, ...(pay.invoice_id ? { invoice_id: pay.invoice_id } : {}) }, record: pay, fact_at: pay.created_at,
    });
    if (r.queued) queued += 1;
  }
  return { result: queued ? `queued:${queued}` : "skipped:not_queued" };
}

export async function failedRun(input, actx) {
  const p = (input.event && input.event.payload) || {};
  const g = isId(p.payment_id, "payment") ? await getRecord("payment", p.payment_id).catch(() => null) : null;
  const pay = g && g.data;
  if (!pay || pay.status !== "failed" || pay.import) { await actx.log(p.payment_id, "skipped:changed"); return { result: "skipped:changed" }; }
  const ig = isId(pay.invoice_id, "invoice") ? await getRecord("invoice", pay.invoice_id).catch(() => null) : null;
  const inv = ig && ig.data;
  if (!inv || inv.status !== "open") { await actx.log(pay.id, "skipped:paid"); return { result: "skipped:paid" }; }
  const link = await cardLink(pay.contact_id, "automation:payment.failed");
  const r = await actx.send({
    contact_id: pay.contact_id, subject: { type: "payment", id: pay.id }, key: pay.id, channel: "sms", template_key: "payment_failed",
    vars: { card_link: link.url, invoice_number: inv.number, balance_due: formatCents(inv.balance_cents || 0) }, related: { payment_id: pay.id, invoice_id: inv.id }, record: pay, fact_at: pay.created_at,
  });
  return { result: r.queued ? "queued:1" : "skipped:not_queued" };
}

// ------------------------------------------------------------ invoice.overdue

// The open invoices due a reminder on `day` (pure over index rows and settings).
export function overdueDue(rows, day, { overdue_every_days = 3, overdue_max = 5 } = {}) {
  return rows.filter((r) => r.st === "open" && r.bal > 0 && !r.pr && !r.im && r.due && r.due < day && (r.rm || 0) < overdue_max && !(r.ch && Date.parse(r.ch) > Date.now()))
    .filter((r) => { const n = r.rm || 0; return day >= addLocalDays(r.due, 1 + n * overdue_every_days); });
}

export async function overdueRun(input, actx) {
  const day = input.date || today();
  let queued = 0;
  for (const inv of input.invoices || []) {
    const n = ((inv.reminders && inv.reminders.count) || 0) + 1;
    const link = await invoiceLink(inv, "automation:invoice.overdue");
    const r = await actx.send({
      contact_id: inv.contact_id, subject: { type: "invoice", id: inv.id }, key: `${inv.id}--${n}`, channel: "sms", template_key: "invoice_overdue",
      vars: invoiceVars(inv, link), related: { invoice_id: inv.id }, record: inv, fact_at: inv.due_on ? zonedToUtc(inv.due_on, "12:00").toISOString() : inv.created_at,
    });
    if (!r.queued) continue;
    queued += 1;
    await updateRecord("invoice", inv.id, (x) => ({ ...x, reminders: { count: Math.max((x.reminders && x.reminders.count) || 0, n), last_at: nowIso(), last_on: day } }), actx.write()).catch(() => null);
  }
  return { result: `queued:${queued}` };
}

export async function overdueSweep(ctx) {
  const settings = await moneySettings();
  const day = today();
  const rows = overdueDue((await readIndex("invoices", "open")).rows, day, settings);
  if (!rows.length) return { result: "none" };
  const invoices = [];
  for (const r of rows.slice(0, 100)) {
    const g = await getRecord("invoice", r.id);
    if (!g || g.data.status !== "open" || g.data.import || isProcessing(g.data)) continue;
    if (g.data.reminders && g.data.reminders.last_on === day) continue;
    invoices.push(g.data);
  }
  if (!invoices.length) return { result: "none" };
  const out = await runAutomation("invoice.overdue", { date: day, invoices }, { mode: ctx.mode, requestId: ctx.holder, deploy: ctx.deploy });
  return { progress: invoices.length, result: out.result || "done" };
}

// ------------------------------------------------------------ card.expiring (P1, off by default)

export async function cardExpiringRun(input, actx) {
  let queued = 0;
  for (const c of input.cards || []) {
    const link = await cardLink(c.contact_id, "automation:card.expiring");
    const r = await actx.send({ contact_id: c.contact_id, subject: { type: "contact", id: c.contact_id }, key: `${c.contact_id}--${c.ym}`, channel: "sms", template_key: "card_update", vars: { card_link: link.url }, related: { plan_id: c.plan_id } });
    if (r.queued) queued += 1;
  }
  return { result: `queued:${queued}` };
}
export async function cardExpiringSweep(ctx) {
  const cards = await expiringCards(localDate(now()));
  if (!cards.length) return { result: "none" };
  const out = await runAutomation("card.expiring", { cards }, { mode: ctx.mode, requestId: ctx.holder, deploy: ctx.deploy });
  return { progress: cards.length, result: out.result || "done" };
}

export const automations = [
  { key: "invoice.sent", label: "Send the invoice", trigger: "event:invoice.sent", category: "service", imported: "no", mutates: false, defaults: { enabled: true, channels: ["sms", "email"], template_keys: ["invoice_sent", "invoice_sent_email"] }, run: invoiceSentRun, recheck: invoiceRecheck },
  { key: "invoice.overdue", label: "Overdue reminders", trigger: "sweep", category: "service", imported: "no", mutates: false, defaults: { enabled: true, channels: ["sms"], template_keys: ["invoice_overdue"] }, run: overdueRun, recheck: invoiceRecheck },
  { key: "payment.receipt", label: "Payment receipt", trigger: "event:payment.succeeded", category: "service", imported: "no", mutates: false, defaults: { enabled: true, channels: ["sms", "email"], template_keys: ["payment_receipt", "payment_receipt_email"] }, run: receiptRun },
  { key: "payment.failed", label: "Payment failed", trigger: "event:payment.failed", category: "service", imported: "no", mutates: false, defaults: { enabled: true, channels: ["sms"], template_keys: ["payment_failed"] }, run: failedRun },
  { key: "card.expiring", label: "Card expiring", trigger: "sweep", category: "service", imported: "no", mutates: false, defaults: { enabled: false, channels: ["sms"], template_keys: ["card_update"] }, run: cardExpiringRun },
];
