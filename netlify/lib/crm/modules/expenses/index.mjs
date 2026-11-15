// Barta CRM module "expenses" (Flyra's Expenses, the Rotor guide's FE1;
// guide-gaps S37): what the business spends (date, amount, category,
// vendor, a note, the receipt photo, the job it was for, who paid), by
// period and category, as a Financials tab. It takes over the office's
// Purchases page (/tools/purchases stays as it is until an import brings
// its rows over). Owners and the office only.
//
//   GET    /expenses?from=&to=&cat=   expenses:read   the rows (newest first) and the totals by category
//   POST   /expenses { client_id, date, amount_cents, category, vendor?, note?, job_id?, paid_by? }   once per client id
//   GET    /expenses/:id · PATCH /expenses/:id (If-Match) · DELETE /expenses/:id
//   service expenses.totals(from, to) → { total_cents, by_category } (Analytics' profit)
//
// The receipt is a file owned by the expense (core/files.mjs, POST /files?owner_type=expense).
// Its own records only: nothing here mirrors Rotor, no sweep, no send.

import { defineModule, defineType } from "../../core/registry.mjs";
import { getRecord, createRecord, updateRecord, readIndex, softDelete } from "../../../crm-store.mjs";
import { deriveId, isId } from "../../core/ids.mjs";
import { now, localDate, isLocalDate } from "../../core/clock.mjs";
import { InputError, NotFoundError, ExistsError } from "../../core/errors.mjs";
import { shape, str, enumValue, int, id as idOf, date as dateOf } from "../../core/validate.mjs";
import { defineFileOwner } from "../../core/files.mjs";

export const CATEGORIES = Object.freeze(["supplies", "fuel", "vehicle", "equipment", "marketing", "subcontractor", "other"]);
const CLIENT_ID = /^[A-Za-z0-9-]{8,64}$/;
const view = (r) => { if (!r) return r; const { _w, _etag, ...rest } = r; return rest; };
const W = (ctx = {}) => (ctx && typeof ctx.write === "function" ? ctx.write() : { ...(ctx || {}) });

export function validateExpense(data, { op } = {}) {
  const stored = op === "update";
  return shape(data, {
    date: (v, f) => dateOf(v, { field: f, required: true }),
    amount_cents: (v, f) => int(v, { field: f, min: 1, max: 100000000, required: true }),
    category: (v, f) => enumValue(v, CATEGORIES, { field: f, stored }) || "other",
    vendor: (v, f) => str(v, { field: f, max: 120 }) || undefined,
    note: (v, f) => str(v, { field: f, max: 1000, trim: false }) || undefined,
    receipt_id: (v, f) => idOf(v, "file", { field: f }),
    job_id: (v, f) => idOf(v, "job", { field: f }),
    paid_by: (v, f) => idOf(v, "user", { field: f }),
  });
}
export const expenseRow = (r) => ({ d: r.date, a: r.amount_cents, cat: r.category, v: r.vendor || "", j: r.job_id || null, rc: r.receipt_id ? 1 : 0, by: r.paid_by || null, u: r.updated_at });
export const expenseType = defineType({
  type: "expense", prefix: "ex", v: 1, validate: validateExpense, rotorFields: [], techFields: ["id"], readPerm: "expenses:read",
  indexes: [{ name: "expenses", shard: (r) => (r.deleted_at ? null : String(r.date || "").slice(0, 4) || "none"), row: expenseRow }],
  summary: (r) => ({ id: r.id, date: r.date, amount_cents: r.amount_cents, category: r.category }),
  example: () => ({ date: "2026-11-17", amount_cents: 4599, category: "supplies", vendor: "Example Hardware", note: "Squeegee rubbers" }),
});

defineFileOwner("expense", {
  canRead: (ctx) => !!(ctx.can && ctx.can("expenses:read")),
  canEdit: (ctx) => !!(ctx.can && ctx.can("expenses:write")),
});

// ------------------------------------------------------------ reads

// → { rows, total_cents, by_category: { cat: { n, cents } } } over [from, to] (pure over index rows)
export function totalsOf(rows, from, to, cat = null) {
  const list = (rows || []).filter((r) => r && r.d >= from && r.d <= to && (!cat || r.cat === cat));
  const by = {};
  for (const r of list) { const b = by[r.cat] || (by[r.cat] = { n: 0, cents: 0 }); b.n += 1; b.cents += r.a || 0; }
  return { rows: list.sort((a, b) => String(b.d).localeCompare(String(a.d)) || String(b.u).localeCompare(String(a.u))), total_cents: list.reduce((s, r) => s + (r.a || 0), 0), by_category: by };
}
async function rowsBetween(from, to) {
  const ys = [];
  for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)) && ys.length < 3; y++) ys.push(String(y));
  return (await Promise.all(ys.map((y) => readIndex("expenses", y).catch(() => ({ rows: [] }))))).flatMap((x) => x.rows);
}
function range(q) {
  const t = localDate(now());
  const from = q.get("from") || `${t.slice(0, 7)}-01`;
  const to = q.get("to") || t;
  if (!isLocalDate(from) || !isLocalDate(to) || to < from) throw new InputError("Pick the first and the last day.", "from");
  return { from, to };
}
export async function expensesTotals(from, to) { const t = totalsOf(await rowsBetween(from, to), from, to); return { total_cents: t.total_cents, by_category: t.by_category }; }

async function rec(id) {
  if (!isId(id, "expense")) throw new NotFoundError("That expense isn't there.");
  const g = await getRecord("expense", id);
  if (!g || g.data.deleted_at) throw new NotFoundError("That expense isn't there.");
  return g;
}
const input = (b, partial = false) => {
  const out = {};
  if (!partial || b.date !== undefined) out.date = b.date;
  if (!partial || b.amount_cents !== undefined) out.amount_cents = b.amount_cents;
  if (!partial || b.category !== undefined) out.category = b.category;
  for (const k of ["vendor", "note", "receipt_id", "job_id", "paid_by"]) if (b[k] !== undefined) out[k] = b[k] === "" ? null : b[k];
  if (out.date !== undefined && !isLocalDate(out.date)) throw new InputError("Pick the day.", "date");
  if (out.amount_cents !== undefined && !(Number.isSafeInteger(out.amount_cents) && out.amount_cents > 0 && out.amount_cents <= 100000000)) throw new InputError("Enter the amount.", "amount_cents");
  if (out.category !== undefined && !CATEGORIES.includes(out.category)) throw new InputError("Pick a category.", "category");
  return out;
};

const R = (method, path, perm, subject, handler, extra = {}) => ({ method, path, auth: "session", perm, subject, mode: "inline", handler, ...extra });
const list = async (ctx) => {
  const { from, to } = range(ctx.query);
  const cat = ctx.query.get("cat") || null;
  if (cat && !CATEGORIES.includes(cat)) throw new InputError("Pick a category.", "cat");
  const all = await rowsBetween(from, to);
  const t = totalsOf(all, from, to, cat);
  const whole = cat ? totalsOf(all, from, to) : t;
  return { data: t.rows.slice(0, 500), meta: { from, to, today: localDate(now()), total_cents: whole.total_cents, by_category: whole.by_category, shown_cents: t.total_cents } };
};
const create = async (ctx) => {
  const b = ctx.body || {};
  if (typeof b.client_id !== "string" || !CLIENT_ID.test(b.client_id)) throw new InputError("Refresh and try again.", "client_id");
  const id = deriveId("expense", `c:${b.client_id.toLowerCase()}`, "expenses", 1);
  const had = await getRecord("expense", id);
  if (had) return { data: { expense: view(had.data), existed: true }, etag: had.etag };
  const data = input(b);
  for (const k of Object.keys(data)) if (data[k] === null) delete data[k];
  try {
    const r = await createRecord("expense", { id, paid_by: ctx.user ? ctx.user.id : undefined, ...data }, W(ctx));
    return { status: 201, data: { expense: view(r.data), existed: false }, etag: r.etag };
  } catch (e) {
    if (!(e instanceof ExistsError)) throw e;
    const g = await getRecord("expense", id);
    return { data: { expense: view(g.data), existed: true }, etag: g.etag };
  }
};
const one = async (ctx) => { const g = await rec(ctx.params.id); return { data: { expense: view(g.data) }, etag: g.etag }; };
const patch = async (ctx) => {
  if (!ctx.ifMatch) throw new InputError("This change needs the version you edited (If-Match).", "if-match");
  const g = await rec(ctx.params.id);
  const p = input(ctx.body || {}, true);
  const r = await updateRecord("expense", g.data.id, (x) => { const n = { ...x }; for (const [k, v] of Object.entries(p)) { if (v === null) delete n[k]; else n[k] = v; } return JSON.stringify(n) === JSON.stringify(x) ? null : n; }, { ...W(ctx), ifMatch: ctx.ifMatch });
  return { data: { expense: view(r.data) }, etag: r.etag };
};
const remove = async (ctx) => { const g = await rec(ctx.params.id); await softDelete("expense", g.data.id, W(ctx)); return { data: { deleted: true } }; };

export default defineModule({
  name: "expenses",
  types: [expenseType],
  perms: [
    { key: "expenses:read", label: "See expenses", roles: { owner: true, admin: true, tech: false } },
    { key: "expenses:write", label: "Add and change expenses", roles: { owner: true, admin: true, tech: false } },
  ],
  routes: [
    R("GET", "/expenses", "expenses:read", "none", list),
    R("POST", "/expenses", "expenses:write", "none", create),
    R("GET", "/expenses/:id", "expenses:read", "required", one),
    R("PATCH", "/expenses/:id", "expenses:write", "required", patch),
    R("DELETE", "/expenses/:id", "expenses:write", "required", remove),
  ],
  services: {
    // (from, to) → { total_cents, by_category } (Analytics' profit, guide-gaps FE2)
    "expenses.totals": (from, to) => expensesTotals(from, to),
  },
  exportTypes: ["expense"],
});
