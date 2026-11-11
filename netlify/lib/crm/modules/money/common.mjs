// Money module: small shared pieces (settings, the write context, names,
// numbers, the contact's money stats part).

import { getSetting, getRecord, listRel, updateStats, getRaw } from "../../../crm-store.mjs";
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

// Works the contact's open balance and lifetime paid out again from the
// relation rows (their values carry status, balance and amounts: one
// listing each, no record reads).
export async function touchMoneyStats(contactId, ctx = {}) {
  if (!isId(contactId, "contact")) return null;
  const [inv, pay] = await Promise.all([
    listRel("contact-invoices", contactId, { limit: 500 }).catch(() => []),
    listRel("contact-payments", contactId, { limit: 1000 }).catch(() => []),
  ]);
  const open = inv.filter((r) => r.value && r.value.s === "open").reduce((s, r) => s + (r.value.b || 0), 0);
  const life = pay.filter((r) => r.value && r.value.s === "succeeded" && !r.value.sim).reduce((s, r) => s + (r.value.k === "refund" ? -(r.value.a + (r.value.t || 0)) : r.value.a + (r.value.t || 0)), 0);
  return updateStats(contactId, "money", (p) => {
    const next = { ...STATS_DEFAULTS, ...p, stripe: { ...STATS_DEFAULTS.stripe, ...((p && p.stripe) || {}) }, open_balance_cents: open, lifetime_cents: life };
    return JSON.stringify(next) === JSON.stringify(p) ? null : next;
  }, W(ctx)).catch(() => null);
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
