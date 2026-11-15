// Money module: the Financials tab's reports (guide-gaps FI4, FP3, FO1;
// S17, S18, S19).
//
//   GET /payments/tips.csv?month=   Tip report: each payment with a tip, and each person's share (tip_split)
//   GET /invoices/tax.csv?from=&to= Tax report: per month, sales and the tax on them. The CRM charges
//                                   no sales tax (off by default; the owner and his accountant decide);
//                                   the tax Rotor charged comes in on imported invoices as a
//                                   "Sales tax (imported)" line, and that is what the report shows.
//   GET /payouts?year=              Stripe's deposits to the bank, read only: from the ix/payouts cache a
//                                   read-only sweep would fill. Nothing reaches Stripe here: with no
//                                   STRIPE_PAYOUTS_KEY (or payments not live) it says "not connected".
//
// Practice (test) payments never count.

import { readIndex, getRecords } from "../../../crm-store.mjs";
import { now, localDate } from "../../core/clock.mjs";
import { InputError } from "../../core/errors.mjs";
import { csv, csvResponse } from "../payroll/sheet.mjs";

const MONTH_RE = /^\d{4}-\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dollars = (c) => ((c || 0) / 100).toFixed(2);
const today = () => localDate(now());

// ------------------------------------------------------------ tips

// → { rows: [{ on, customer, invoice, method, tip_cents, split }], people: { uid: cents }, total_cents } (pure over the payment records)
export function tipsOf(payments, names = new Map()) {
  const rows = [];
  const people = {};
  let total = 0;
  for (const p of payments) {
    if (!p || p.deleted_at || p.status !== "succeeded" || p.simulated || p.kind !== "payment" || !(p.tip_cents > 0)) continue;
    total += p.tip_cents;
    const split = Array.isArray(p.tip_split) && p.tip_split.length ? p.tip_split : [{ user_id: null, cents: p.tip_cents }];
    for (const x of split) { const k = x.user_id || "unsplit"; people[k] = (people[k] || 0) + (x.cents || 0); }
    rows.push({ on: p.received_on, customer: p.contact_name || "", invoice: p.invoice_number || "", method: p.method, tip_cents: p.tip_cents, split: split.map((x) => `${x.user_id ? names.get(x.user_id) || "Someone" : "Not split"} ${dollars(x.cents)}`).join("; ") });
  }
  rows.sort((a, b) => String(a.on).localeCompare(String(b.on)));
  return { rows, people, total_cents: total };
}

export async function tipsCsv(ctx) {
  const month = ctx.query.get("month") || today().slice(0, 7);
  if (!MONTH_RE.test(month)) throw new InputError("Use a month like 2026-11.", "month");
  const ix = await readIndex("payments", month);
  const ids = ix.rows.filter((r) => r.tip > 0 && r.k === "payment" && r.st === "succeeded" && !r.sim).map((r) => r.id).slice(0, 800);
  const [recs, users] = await Promise.all([getRecords("payment", ids), readIndex("users", "").catch(() => ({ rows: [] }))]);
  const names = new Map(users.rows.map((u) => [u.id, u.name]));
  const t = tipsOf(recs.filter(Boolean).map((g) => g.data), names);
  const body = [
    ...t.rows.map((r) => [r.on, r.customer, r.invoice, r.method, dollars(r.tip_cents), r.split]),
    ...Object.entries(t.people).map(([uid, c]) => [month, uid === "unsplit" ? "Not split" : names.get(uid) || "Someone", "", "per person", dollars(c), ""]),
    [month, "Total", "", "", dollars(t.total_cents), ""],
  ];
  return csvResponse(csv(["date", "customer_or_person", "invoice", "method", "tip", "split"], body), `tips-${month}.csv`);
}

// ------------------------------------------------------------ tax

const isTaxLine = (l) => /sales tax/i.test(String((l && (l.description || l.title)) || "")) || (l && l.kind === "tax");
// → per month { month, sales_cents, taxable_cents, exempt_cents, tax_cents } over paid invoices (pure)
export function taxOf(invoices, from, to) {
  const by = new Map();
  for (const inv of invoices) {
    if (!inv || inv.deleted_at || inv.status !== "paid") continue;
    const day = String(inv.paid_at || inv.issued_on || "").slice(0, 10);
    if (!day || day < from || day > to) continue;
    const m = day.slice(0, 7);
    const row = by.get(m) || { month: m, sales_cents: 0, taxable_cents: 0, exempt_cents: 0, tax_cents: 0 };
    const tax = (inv.lines || []).filter(isTaxLine).reduce((a, l) => a + (l.total_cents ?? Math.round(((l.qty_milli || 1000) * (l.unit_cents || 0)) / 1000)), 0) + (inv.tax_cents || 0);
    const sales = Math.max(0, (inv.total_cents || 0) - tax);
    row.sales_cents += sales;
    row.tax_cents += tax;
    if (tax > 0) row.taxable_cents += sales; else row.exempt_cents += sales;
    by.set(m, row);
  }
  return [...by.values()].sort((a, b) => a.month.localeCompare(b.month));
}

export async function taxCsv(ctx) {
  const t = today();
  const from = ctx.query.get("from") || `${t.slice(0, 4)}-01-01`;
  const to = ctx.query.get("to") || t;
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || to < from) throw new InputError("Pick the first and the last day.", "from");
  const years = [];
  for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)) && years.length < 3; y++) years.push(String(y));
  const shards = await Promise.all(years.map((y) => readIndex("invoices", y).catch(() => ({ rows: [] }))));
  const ids = shards.flatMap((s) => s.rows).filter((r) => r.st === "paid" && !r.sim).map((r) => r.id).slice(0, 1500);
  const recs = (await getRecords("invoice", ids)).filter(Boolean).map((g) => g.data);
  const rows = taxOf(recs, from, to);
  const tot = rows.reduce((a, r) => ({ s: a.s + r.sales_cents, x: a.x + r.taxable_cents, e: a.e + r.exempt_cents, t: a.t + r.tax_cents }), { s: 0, x: 0, e: 0, t: 0 });
  const body = [...rows.map((r) => [r.month, dollars(r.sales_cents), dollars(r.taxable_cents), dollars(r.exempt_cents), dollars(r.tax_cents)]), ["Total", dollars(tot.s), dollars(tot.x), dollars(tot.e), dollars(tot.t)],
    ["Note", "The CRM charges no sales tax (off). Tax shown is what Rotor charged on imported invoices.", "", "", ""]];
  return csvResponse(csv(["month", "sales", "taxable_sales", "exempt_sales", "tax_collected"], body), `tax-${from}-to-${to}.csv`);
}

// ------------------------------------------------------------ payouts (read only)

export async function payouts(ctx) {
  const year = ctx.query.get("year") || today().slice(0, 4);
  if (!/^\d{4}$/.test(year)) throw new InputError("Use a year like 2026.", "year");
  const connected = !!process.env.STRIPE_PAYOUTS_KEY;
  const ix = connected ? await readIndex("payouts", year).catch(() => ({ rows: [] })) : { rows: [] };
  const rows = ix.rows.slice().sort((a, b) => String(b.arr || "").localeCompare(String(a.arr || "")));
  return { data: rows, meta: { connected, year, note: connected ? "Includes Rotor's charges until the switch (one Stripe account)." : null } };
}
