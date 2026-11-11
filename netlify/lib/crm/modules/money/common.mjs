// Money module: small shared pieces (settings, the write context, names,
// numbers, the contact's money stats part).

import { getSetting, getRecord, updateStats, getRaw, readIndex, listKeys } from "../../../crm-store.mjs";
import { contactShard } from "../../core/stats.mjs";
import { now, nowIso, localDate } from "../../core/clock.mjs";
import { isId } from "../../core/ids.mjs";
import { InputError } from "../../core/errors.mjs";
import { DEFAULT_TIP_OPTIONS_BP, DEFAULT_TIP_CUSTOM_MAX } from "./balance.mjs";

export const today = () => localDate(now());

// The write context a money function writes with: a route's ctx.write(), an
// automation's h.ctx.write(), or a plain context object.
export const W = (ctx = {}) => (ctx && typeof ctx.write === "function" ? ctx.write() : ctx || {});

// cfg/money (§3.3 settings documents; owner-only, Settings → Payments).
export const MONEY_DEFAULTS = Object.freeze({
  auto_issue: true,
  retry_days: [3, 7],
  overdue_every_days: 3,
  overdue_max: 5,
  credit_cap_admin_cents: 10000,
  tip_options_bp: [...DEFAULT_TIP_OPTIONS_BP],
  tip_custom_max_cents: DEFAULT_TIP_CUSTOM_MAX,
  ach: true,
  statement_descriptor: "BARTA WINDOWS",
  late_cancel_fee_cents: 5000,
  receipt_email: true,
});

const intIn = (v, f, min, max) => {
  if (v === undefined) return v;
  if (!Number.isSafeInteger(v) || v < min || v > max) throw new InputError(`Use a whole number from ${min} to ${max}.`, f);
  return v;
};
export function validateMoneySettings(v) {
  const src = v && typeof v === "object" && !Array.isArray(v) ? v : {};
  const o = {};
  for (const k of ["auto_issue", "ach", "receipt_email"]) if (src[k] !== undefined) { if (typeof src[k] !== "boolean") throw new InputError("Yes or no.", k); o[k] = src[k]; }
  if (src.retry_days !== undefined) {
    if (!Array.isArray(src.retry_days) || src.retry_days.length > 4 || src.retry_days.some((d) => !Number.isSafeInteger(d) || d < 1 || d > 30)) throw new InputError("Up to 4 days, each 1 to 30.", "retry_days");
    o.retry_days = [...new Set(src.retry_days)].sort((a, b) => a - b);
  }
  o.overdue_every_days = intIn(src.overdue_every_days, "overdue_every_days", 1, 30);
  o.overdue_max = intIn(src.overdue_max, "overdue_max", 0, 10);
  o.credit_cap_admin_cents = intIn(src.credit_cap_admin_cents, "credit_cap_admin_cents", 0, 1000000);
  o.tip_custom_max_cents = intIn(src.tip_custom_max_cents, "tip_custom_max_cents", 0, 500000);
  o.late_cancel_fee_cents = intIn(src.late_cancel_fee_cents, "late_cancel_fee_cents", 0, 100000);
  if (src.tip_options_bp !== undefined) {
    if (!Array.isArray(src.tip_options_bp) || src.tip_options_bp.length > 6 || src.tip_options_bp.some((b) => !Number.isSafeInteger(b) || b < 0 || b > 5000 || b % 100 !== 0)) throw new InputError("Up to 6 whole percents from 0 to 50.", "tip_options_bp");
    o.tip_options_bp = [...new Set(src.tip_options_bp)].sort((a, b) => a - b);
  }
  if (src.statement_descriptor !== undefined) {
    const s = String(src.statement_descriptor || "").trim().toUpperCase();
    if (!/^[A-Z0-9 .-]{5,22}$/.test(s)) throw new InputError("5 to 22 letters and numbers.", "statement_descriptor");
    o.statement_descriptor = s;
  }
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

export async function moneySettings() {
  const s = await getSetting("money").catch(() => null);
  return { ...MONEY_DEFAULTS, ...(s || {}) };
}

// The system mode (rotor | crm) for a write context: the context's, else read.
export async function sysModeOf(ctx = {}) {
  const w = W(ctx);
  if (w.mode && w.mode.system_of_record) return w.mode;
  const g = await getRaw("sys/mode");
  return { system_of_record: "rotor", paused: false, ...(g && g.data ? g.data : {}) };
}

export const nameOf = (c) => (c ? c.display_name || [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || c.company_name || "" : "");
export const firstName = (c) => (c && c.first_name) || "";

export async function liveContact(id) {
  if (!isId(id, "contact")) return null;
  const g = await getRecord("contact", id).catch(() => null);
  if (!g || g.data.deleted_at) return null;
  if (g.data.merged_into && isId(g.data.merged_into, "contact")) return liveContact(g.data.merged_into);
  return g.data;
}

// ------------------------------------------------------------ numbers

// INV-0610, D-0001 once the CRM is in charge; SINV-0001 / SD-0001 (shadow)
// before (§3.9, D31). The formats are cfg/numbering's (deposit-shadow has
// a default here: core's numbering page doesn't list it).
export const NUMBER_FORMATS = Object.freeze({
  invoice: { prefix: "INV-", pad: 4 }, "invoice-shadow": { prefix: "SINV-", pad: 4 }, deposit: { prefix: "D-", pad: 4 }, "deposit-shadow": { prefix: "SD-", pad: 4 },
});
export async function numberFormats() {
  const n = await getSetting("numbering").catch(() => null);
  const out = {};
  for (const k of Object.keys(NUMBER_FORMATS)) out[k] = { ...NUMBER_FORMATS[k], ...((n && n[k]) || {}) };
  return out;
}
export function numberLabel(n, seq, formats = NUMBER_FORMATS) {
  const f = (formats && formats[seq]) || NUMBER_FORMATS[seq] || NUMBER_FORMATS.invoice;
  return `${f.prefix || ""}${String(n).padStart(Number.isInteger(f.pad) ? f.pad : 0, "0")}`;
}
export const seqFor = (kind, sor) => (kind === "deposit" ? (sor === "crm" ? "deposit" : "deposit-shadow") : (sor === "crm" ? "invoice" : "invoice-shadow"));

// ------------------------------------------------------------ the money stats part (§5.1)

export const STATS_DEFAULTS = Object.freeze({ lifetime_cents: 0, open_balance_cents: 0, stripe: { customer_ids: [], card_status: "none" } });

// What a contact owes: the balances of their open invoices (one read of the
// open-invoices index; imported invoices count, the customer owes them too).
const owedBy = (rows) => {
  const m = new Map();
  for (const r of rows) if (r.st === "open" && r.bal > 0 && r.c) m.set(r.c, (m.get(r.c) || 0) + r.bal);
  return m;
};

// Brings the contact's money stats up to date after an invoice or payment
// changed: the open balance is worked out again from the index; lifetime
// paid moves by `lifetime_delta` (the payment that just went through, or
// the refund). money.stats re-checks both from the indexes (below), so a
// function that died in between is put right.
export async function touchMoneyStats(contactId, ctx = {}, { lifetime_delta = 0 } = {}) {
  if (!isId(contactId, "contact")) return null;
  let open = null;
  try { open = owedBy((await readIndex("invoices", "open")).rows).get(contactId) || 0; } catch { open = null; }
  return updateStats(contactId, "money", (p) => {
    const next = {
      ...STATS_DEFAULTS, ...p, stripe: { ...STATS_DEFAULTS.stripe, ...((p && p.stripe) || {}) },
      ...(open === null ? {} : { open_balance_cents: open }), lifetime_cents: Math.max(0, ((p && p.lifetime_cents) || 0) + (Number.isSafeInteger(lifetime_delta) ? lifetime_delta : 0)),
    };
    return JSON.stringify(next) === JSON.stringify(p) ? null : next;
  }, W(ctx)).catch(() => null);
}

// money.stats (bulk lane; hourly for balances, and with lifetime paid from
// money.reconcile each night): every contact's open balance (and lifetime
// paid) worked out from the indexes and compared with what the contacts
// index says; only the ones that differ are written. This is what gives
// imported customers their balance after an import, and what repairs a
// stats write that never landed. Derived data only (contact_stats).
export async function refreshMoneyStats(ctx = {}, { lifetime = false } = {}) {
  const [cx, open] = await Promise.all([readIndex("contacts", contactShard("ct_00000000000000000000")), readIndex("invoices", "open")]);
  const owe = owedBy(open.rows);
  let life = null;
  if (lifetime) {
    life = new Map();
    const shards = [...new Set((await listKeys("ix/payments/").catch(() => [])).map((k) => k.slice("ix/payments/".length)).filter((s) => s && !s.includes("/")))];
    for (const sh of shards) {
      if (ctx.budget && ctx.budget.left() < 15000) { life = null; break; }
      for (const r of (await readIndex("payments", sh)).rows) {
        if (r.st !== "succeeded" || r.sim || !r.c) continue;
        const v = (r.a || 0) + (r.tip || 0);
        life.set(r.c, (life.get(r.c) || 0) + (r.k === "refund" ? -v : v));
      }
    }
  }
  const w = W(ctx);
  let fixed = 0;
  for (const row of cx.rows) {
    const wantB = owe.get(row.id) || 0;
    const wantL = life ? Math.max(0, life.get(row.id) || 0) : null;
    if ((row.mb || 0) === wantB && (wantL === null || (row.ml || 0) === wantL)) continue;
    if (ctx.budget && ctx.budget.left() < 8000) return { done: false, progress: fixed };
    await updateStats(row.id, "money", (p) => {
      const next = { ...STATS_DEFAULTS, ...p, stripe: { ...STATS_DEFAULTS.stripe, ...((p && p.stripe) || {}) }, open_balance_cents: wantB, ...(wantL === null ? {} : { lifetime_cents: wantL }) };
      return JSON.stringify(next) === JSON.stringify(p) ? null : next;
    }, w).catch(() => null);
    fixed += 1;
  }
  return { progress: fixed, result: `${fixed} contact${fixed === 1 ? "" : "s"} brought up to date` };
}

export async function moneyStats(contactId) {
  const g = isId(contactId, "contact") ? await getRecord("contact_stats", contactId).catch(() => null) : null;
  const p = (g && g.data && g.data.money) || {};
  return { ...STATS_DEFAULTS, ...p, stripe: { ...STATS_DEFAULTS.stripe, ...(p.stripe || {}) } };
}

export const isoNow = () => nowIso();

// Runs fn over a list, a few at a time (storage reads in parallel, bounded).
export async function mapLimit(list, n, fn) {
  const out = new Array(list.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => {
    while (i < list.length) { const k = i++; out[k] = await fn(list[k], k); }
  }));
  return out;
}
