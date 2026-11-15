// Money module: editing an invoice (Rotor's phone invoice: the number, the
// title, the due date, the notes, Bill To, the lines and discounts) and
// "Mark as Sent".
//
// What may change depends on where the invoice is (editRules):
//   draft            everything
//   open, unpaid     everything (a sent one is marked edited_after_sent_at:
//                    the customer saw the old one, so the office sends it again);
//                    the lines, the number and Bill To stop while a payment is
//                    on it (any entry that isn't failed or cancelled), a card
//                    charge runs, or a pay page (Checkout) is open
//   paid             the title, the notes and the salesperson only: its money,
//                    number, Bill To and due date stay as they were
//   void, written off nothing
// An invoice the import brought in is Rotor's until the switch (the route
// refuses before this file is asked). The totals are never taken from the
// request: the record's validator works them out from the lines on every
// write (types.mjs validateInvoice → balance.mjs totalsOf). Every write
// carries the If-Match the person read, so two people editing at once get a
// 412, not a lost edit; the store's audit row records what changed.
//
//   editRules(inv, now)            → { details, due, money, why, code }
//   editInvoice(id, body, ctx)     PATCH /invoices/:id
//   markSent(id, ctx)              POST /invoices/:id/mark-sent: recorded as sent, nothing is sent

import { getRecord, updateRecord, readIndex, listKeys } from "../../../crm-store.mjs";
import { isId } from "../../core/ids.mjs";
import { nowIso, nowMs, isLocalDate } from "../../core/clock.mjs";
import { InputError, ConflictError, ExistsError } from "../../core/errors.mjs";
import { chargingLive, totalsOf } from "./balance.mjs";
import { validateLine, validateBillTo, numberLabelKey } from "./types.mjs";
import { W, NUMBER_FORMATS, numberFormats, touchMoneyStats } from "./common.mjs";
import { issueInvoice } from "./invoices.mjs";

const LIVE_PAY = ["pending", "processing", "succeeded"];
export const MAX_EDIT_LINES = 40;

// An open Checkout Session that hasn't run out: the customer may be paying the old amount.
const openCheckout = (inv, at) => (inv.checkout_sessions || []).find((s) => s && s.status === "open" && Date.parse(s.expires_at) > at) || null;

// What this invoice lets a person change now, and why not.
export function editRules(inv, at = nowMs()) {
  const none = (why, code) => ({ details: false, due: false, money: false, why, code });
  if (!inv) return none("That invoice isn't here.", "missing");
  if (inv.status === "void") return none("This invoice is void: nothing on it changes.", "void");
  if (inv.status === "uncollectible") return none("This invoice was written off: nothing on it changes.", "written_off");
  if (inv.status === "paid") return { details: true, due: false, money: false, why: "This invoice is paid: its lines, total, number and due date stay as they were. Refund the payment first to change them.", code: "paid" };
  if (inv.status === "draft") return { details: true, due: true, money: true, why: null, code: null };
  const paying = Object.values(inv.applied || {}).some((e) => e && LIVE_PAY.includes(e.status));
  if (paying) return { details: true, due: true, money: false, why: "A payment is on this invoice: its lines, total and number stay as they are. Refund it first, or void this one and make a new invoice.", code: "has_payments" };
  if (chargingLive(inv, at)) return { details: true, due: true, money: false, why: "A card charge is running on this invoice. Try again in a minute.", code: "charging" };
  const co = openCheckout(inv, at);
  if (co) return { details: true, due: true, money: false, why: "The customer has the pay page open right now. Its lines change once it closes (within the hour).", code: "checkout_open" };
  return { details: true, due: true, money: true, why: null, code: null };
}

// ------------------------------------------------------------ the lines

const LINE_ID = /^[a-z0-9_-]{1,40}$/i;
const KEEP = ["credit", "deposit_credit"];

// The editor's lines → stored lines. A negative price (or kind discount) is a
// discount; the CRM's credit lines stay as they were (they aren't the office's
// to type); a job's line keeps its job when its id comes back.
export function editLines(list, before = []) {
  if (!Array.isArray(list)) throw new InputError("Expected the lines.", "lines");
  if (list.length > MAX_EDIT_LINES) throw new InputError(`Keep it under ${MAX_EDIT_LINES} lines.`, "lines");
  const old = new Map((before || []).map((l) => [l.id, l]));
  const used = new Set((before || []).filter((l) => KEEP.includes(l.kind)).map((l) => l.id));
  const out = list.map((l, i) => {
    const f = `lines.${i}`;
    if (!l || typeof l !== "object" || Array.isArray(l)) throw new InputError("Expected a line.", f);
    if (!Number.isSafeInteger(l.unit_cents)) throw new InputError("Enter a price.", `${f}.unit_cents`);
    if (Math.abs(l.unit_cents) > 10000000) throw new InputError("That price is too big.", `${f}.unit_cents`);
    const qty = l.qty_milli === undefined || l.qty_milli === null ? 1000 : l.qty_milli;
    if (!Number.isSafeInteger(qty) || qty <= 0 || qty > 100000000) throw new InputError("Enter a quantity.", `${f}.qty_milli`);
    if (typeof l.description !== "string" || !l.description.trim()) throw new InputError("What is it for?", `${f}.description`);
    const discount = l.kind === "discount" || l.unit_cents < 0;
    const kind = discount ? "discount" : l.kind === "fee" ? "fee" : "service";
    let id = typeof l.id === "string" && LINE_ID.test(l.id) && !used.has(l.id) ? l.id : null;
    if (!id) { let n = i + 1; while (used.has(`e${n}`) || old.has(`e${n}`)) n += 1; id = `e${n}`; }
    used.add(id);
    const was = old.get(id);
    return validateLine({
      id, kind, description: l.description, qty_milli: qty, unit_cents: discount ? -Math.abs(l.unit_cents) : l.unit_cents,
      ...(was && was.job_id ? { job_id: was.job_id } : {}), ...(isId(l.price_item_id, "price_item") ? { ref_id: l.price_item_id } : was && was.ref_id && !KEEP.includes(was.kind) ? { ref_id: was.ref_id } : {}),
    }, f);
  });
  const kept = (before || []).filter((l) => KEEP.includes(l.kind));
  const lines = [...out, ...kept];
  const t = totalsOf(lines);
  if (t.discount_cents > t.subtotal_cents) throw new InputError("The discount is more than the lines add up to.", "lines");
  if (t.credit_cents > t.subtotal_cents - t.discount_cents) throw new ConflictError(`The credit already on it ($${(t.credit_cents / 100).toFixed(2)}) is more than the new total. Keep the total at least that.`, { code: "credit_over" });
  return lines;
}

// ------------------------------------------------------------ the number

const NUMBER_RE = /^[A-Za-z0-9][A-Za-z0-9#._/-]{0,23}$/;

// Every invoice number now in use (the open list and each year's), as compare keys → id.
async function numbersInUse() {
  const shards = new Set(["open"]);
  for (const k of await listKeys("ix/invoices/").catch(() => [])) {
    const sh = k.slice("ix/invoices/".length);
    if (sh && !sh.includes("/")) shards.add(sh);
  }
  const m = new Map();
  for (const sh of [...shards].slice(0, 40)) for (const r of (await readIndex("invoices", sh).catch(() => ({ rows: [] }))).rows) if (r.n) m.set(numberLabelKey(r.n), r.id);
  return m;
}

// The CRM's own sequences (INV-0610, SINV-0001, D-0001, SD-0001): a typed
// number in one of them would collide with an invoice the sequence makes later.
async function inASequence(label) {
  const formats = { ...NUMBER_FORMATS, ...(await numberFormats()) };
  return Object.values(formats).some((f) => f && f.prefix && new RegExp(`^${f.prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\d+$`, "i").test(label));
}

export async function checkNumber(raw, inv) {
  const label = String(raw ?? "").trim();
  if (!NUMBER_RE.test(label)) throw new InputError("Use up to 24 letters, digits and - . / # (no spaces).", "number");
  const key = numberLabelKey(label);
  if (key === numberLabelKey(inv.number)) return null;
  if (await inASequence(label)) throw new ConflictError(`Numbers like ${label} are the CRM's own and come up in order. Pick another (add a letter, say ${label}A).`, { code: "number_in_sequence", field: "number" });
  const owner = (await numbersInUse()).get(key);
  if (owner && owner !== inv.id) throw new ConflictError(`${label} is already another invoice's number.`, { code: "number_taken", field: "number" });
  return label;
}

// ------------------------------------------------------------ the edit

const DETAIL_KEYS = ["title", "customer_note", "office_note", "salesperson_id"];
const MONEY_KEYS = ["lines", "number", "bill_to"];

// PATCH body: { number?, title?, due_on? (null clears a draft's), customer_note?, office_note?,
// bill_to? (null: the contact as filed), salesperson_id?, lines? }. ctx: the route's (ifMatch, write()).
export async function editInvoice(inv, b, { ifMatch, write }) {
  const rules = editRules(inv);
  const asked = Object.keys(b || {}).filter((k) => [...DETAIL_KEYS, ...MONEY_KEYS, "due_on"].includes(k));
  if (!asked.length) throw new InputError("Nothing to change.");
  const refuse = (code, why) => { throw new ConflictError(why, { code }); };
  if (!rules.details) refuse(rules.code, rules.why);
  if (asked.some((k) => MONEY_KEYS.includes(k)) && !rules.money) refuse(rules.code, rules.why);
  if (asked.includes("due_on") && !rules.due) refuse(rules.code, rules.why);

  const patch = {};
  const unset = [];
  if (b.title !== undefined) { if (b.title === null || String(b.title).trim() === "") unset.push("title"); else patch.title = String(b.title).trim().slice(0, 121); }
  for (const k of ["customer_note", "office_note"]) if (b[k] !== undefined) { if (b[k] === null || b[k] === "") unset.push(k); else patch[k] = String(b[k]); }
  if (b.salesperson_id !== undefined) {
    if (b.salesperson_id === null || b.salesperson_id === "") unset.push("salesperson_id");
    else { const u = isId(b.salesperson_id, "user") ? await getRecord("user", b.salesperson_id).catch(() => null) : null; if (!u) throw new InputError("Pick someone on the team.", "salesperson_id"); patch.salesperson_id = b.salesperson_id; }
  }
  if (b.due_on !== undefined) {
    if (b.due_on === null || b.due_on === "") { if (inv.status !== "draft") throw new InputError("A sent invoice needs a due date.", "due_on"); unset.push("due_on"); }
    else if (!isLocalDate(b.due_on)) throw new InputError("Use a date like 2026-11-17.", "due_on");
    else if (inv.issued_on && b.due_on < inv.issued_on) throw new InputError("The due date can't be before it was sent.", "due_on");
    else patch.due_on = b.due_on;
  }
  if (b.bill_to !== undefined) { const bt = validateBillTo(b.bill_to); if (bt) patch.bill_to = bt; else unset.push("bill_to"); }
  if (b.lines !== undefined) patch.lines = editLines(b.lines, inv.lines);
  if (b.number !== undefined) { const n = await checkNumber(b.number, inv); if (n) { patch.number = n; patch.number_edited = true; } }
  const money = ["lines", "number", "bill_to"].some((k) => patch[k] !== undefined || unset.includes(k));
  if (inv.status === "open" && patch.lines && totalsOf(patch.lines).total_cents <= 0) throw new ConflictError("A sent invoice needs something left to pay. Void it instead.", { code: "zero_total" });

  let r;
  try {
    r = await updateRecord("invoice", inv.id, (cur) => {
      // the version the person read (If-Match), checked again on what is stored now
      const now = editRules(cur);
      if (!now.details || (money && !now.money)) throw new ConflictError(now.why || "This invoice can't change now.", { code: now.code });
      const next = { ...cur, ...patch };
      for (const k of unset) delete next[k];
      if (money && cur.status === "open" && cur.sent_at) next.edited_after_sent_at = nowIso();
      return next;
    }, { ...write, ifMatch });
  } catch (e) {
    if (e instanceof ExistsError) throw new ConflictError(`${patch.number} is already another invoice's number.`, { code: "number_taken", field: "number" });
    throw e;
  }
  if (r.changed) await touchMoneyStats(r.data.contact_id, write);
  return r;
}

// "Mark as Sent" (Rotor's): the invoice counts as sent (handed over, emailed
// from somewhere else) and nothing is texted or emailed. A draft is issued
// first (silently: no invoice.sent).
export async function markSent(id, ctx = {}) {
  const w = W(ctx);
  const g = await getRecord("invoice", id);
  if (!g) throw new ConflictError("That invoice isn't here.");
  if (["void", "uncollectible"].includes(g.data.status)) throw new ConflictError("This invoice is closed.", { code: g.data.status });
  if (g.data.status === "paid") throw new ConflictError("This invoice is paid.", { code: "paid" });
  if (g.data.status === "draft") await issueInvoice(id, { silent: true }, w);
  const r = await updateRecord("invoice", id, (inv) => {
    if (inv.sent_at) return null;
    return { ...inv, sent_at: nowIso(), marked_sent: { at: nowIso(), by: String(w.by || "system").slice(0, 80) } };
  }, w);
  return r.data;
}
