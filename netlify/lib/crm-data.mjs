// Barta Office → Customers (docs/CRM.md): the customer list exported from
// Rotor, as the office imported it. The rows live in the Netlify Blobs store
// "crm" (netlify/lib/crm-store.mjs); nothing about a customer is ever in the
// repo, which is public. Read-only until the CRM's own records land.
//
// Everything below loadCustomers() is a pure helper over the exported rows,
// so the page and the tests can share it. Rows keep Rotor's own field names:
// { id, first_name, last_name, company_name, email, phone, status, source,
//   assigned_to: [user_id], address: { street1, street2, city, state, zip,
//   country }, tags: [], notes, created_at }.

import { readCustomerIndex } from "./crm-store.mjs";
import { safeErr } from "./referral-lib.mjs";

export const ROTOR_CUSTOMER_URL = "https://app.getrotor.com/customers/";

// The list the page renders: { ok: true, data: { v, imported_at, exported_at,
// count, members: [{ user_id, name }], customers } } straight from the
// index blob, or { ok: false, reason: "no-data" } before the first import,
// { ok: false, reason: "bad-index" } when the blob isn't readable JSON (the
// page then offers the Import screen, so a new import can replace it), or
// { ok: false, reason: "store" } when Blobs didn't answer (logged with the
// error's status only; the page shows a message instead of crashing).
export async function loadCustomers() {
  let idx;
  try {
    idx = await readCustomerIndex();
  } catch (e) {
    if (e instanceof SyntaxError) {
      console.error("crm: the customer index isn't readable JSON");
      return { ok: false, reason: "bad-index" };
    }
    console.error("crm: couldn't read the customer index (" + safeErr(e) + ")");
    return { ok: false, reason: "store" };
  }
  if (!plain(idx) || !Array.isArray(idx.customers)) return { ok: false, reason: "no-data" };
  return { ok: true, data: { ...idx, customers: idx.customers.filter(plain) } };
}

const plain = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v) => (v == null ? "" : String(v)).trim();

// What an import keeps of an export, and how big each part may be. The real
// export sits far inside these (its longest note is under 2,000 characters);
// they exist so a crafted or broken file can't put a row of any size or
// shape into the store, or a list bigger than the page can serve.
export const LIMITS = Object.freeze({
  customers: 5000, members: 200,
  name: 60, member_name: 120, company: 120, email: 120, phone: 25, status: 20, source: 60, created_at: 40,
  street: 200, city: 60, state: 60, zip: 20, country: 60,
  tags: 20, tag: 40, assigned: 20, member_id: 64, notes: 10000,
});
// Rotor's ids are UUIDs (all of them, customers and members).
export const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A member id only has to match an assigned_to entry: a plain token.
const MEMBER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
// The oldest export date the site takes; the newest is two days from now.
const FIRST_EXPORT = "2000-01-01";

// A row that doesn't fit; `field` names the place ("customers[12].notes"),
// never a value.
export class RowError extends Error {
  constructor(field) { super(`${field} is missing, the wrong type or too long`); this.field = field; }
}

const text = (v, max, field) => {
  if (v == null) return null;
  if (typeof v !== "string" || v.length > max) throw new RowError(field);
  return v;
};
const textList = (v, maxItems, maxLen, field) => {
  if (v == null) return [];
  if (!Array.isArray(v) || v.length > maxItems || !v.every((x) => typeof x === "string" && x.length <= maxLen)) throw new RowError(field);
  return [...v];
};

// An export date: a real calendar day, YYYY-MM-DD, not before 2000 and not
// more than two days ahead (a typo there would make every later export look
// older than it).
export function isExportDate(s, now = new Date()) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return false;
  const latest = new Date(now.getTime() + 2 * 86400000).toISOString().slice(0, 10);
  return s >= FIRST_EXPORT && s <= latest;
}

// One Rotor customer row → exactly the fields the page uses (see the top of
// this file), strings or null only, each within LIMITS. Anything else in the
// row is dropped; a known field of the wrong type or size throws RowError.
export function normalizeCustomer(c, at = "customer") {
  if (!plain(c)) throw new RowError(at);
  if (typeof c.id !== "string" || !ID_RE.test(c.id)) throw new RowError(at + ".id");
  const a = c.address;
  if (a != null && !plain(a)) throw new RowError(at + ".address");
  const f = (k, max) => text(c[k], max, `${at}.${k}`);
  const af = (k, max) => text(a[k], max, `${at}.address.${k}`);
  return {
    id: c.id,
    first_name: f("first_name", LIMITS.name),
    last_name: f("last_name", LIMITS.name),
    company_name: f("company_name", LIMITS.company),
    email: f("email", LIMITS.email),
    phone: f("phone", LIMITS.phone),
    status: f("status", LIMITS.status),
    source: f("source", LIMITS.source),
    assigned_to: textList(c.assigned_to, LIMITS.assigned, LIMITS.member_id, `${at}.assigned_to`),
    address: a == null ? null : {
      street1: af("street1", LIMITS.street), street2: af("street2", LIMITS.street),
      city: af("city", LIMITS.city), state: af("state", LIMITS.state),
      zip: af("zip", LIMITS.zip), country: af("country", LIMITS.country),
    },
    tags: textList(c.tags, LIMITS.tags, LIMITS.tag, `${at}.tags`),
    notes: f("notes", LIMITS.notes),
    created_at: f("created_at", LIMITS.created_at),
  };
}

// One company member → { user_id, name }: who a customer is assigned to.
// Emails and roles are dropped here, before anything is stored or sealed.
export function normalizeMember(m, at = "member") {
  if (!plain(m) || typeof m.user_id !== "string" || m.user_id.length > LIMITS.member_id || !MEMBER_ID_RE.test(m.user_id)) throw new RowError(at + ".user_id");
  const name = text(m.name, LIMITS.member_name, at + ".name");
  const first = text(m.first_name, LIMITS.name, at + ".first_name");
  const last = text(m.last_name, LIMITS.name, at + ".last_name");
  return { user_id: m.user_id, name: str(name) || [str(first), str(last)].filter(Boolean).join(" ") };
}

// An opened export { v: 1, exported_at, customers, members } → { ok: true,
// bundle } with every row normalized, or { ok: false, error, field? }:
// "bad-bundle" (not an export, or a row that doesn't fit; `field` says
// where), "empty" (no customers: an export that failed half way), or
// "too-many" (more than LIMITS allow). The import endpoint and the seal
// script both run this, so a file that seals is a file the site takes.
export function normalizeBundle(b, { now = new Date() } = {}) {
  const bad = (field) => ({ ok: false, error: "bad-bundle", ...(field ? { field } : {}) });
  if (!plain(b) || b.v !== 1) return bad();
  if (!isExportDate(b.exported_at, now)) return bad("exported_at");
  if (!Array.isArray(b.customers)) return bad("customers");
  if (!Array.isArray(b.members)) return bad("members");
  if (!b.customers.length) return { ok: false, error: "empty" };
  if (b.customers.length > LIMITS.customers || b.members.length > LIMITS.members) return { ok: false, error: "too-many" };
  try {
    const ids = new Set();
    const customers = b.customers.map((c, i) => {
      const row = normalizeCustomer(c, `customers[${i}]`);
      if (ids.has(row.id.toLowerCase())) throw new RowError(`customers[${i}].id`);
      ids.add(row.id.toLowerCase());
      return row;
    });
    const members = b.members.map((m, i) => normalizeMember(m, `members[${i}]`));
    return { ok: true, bundle: { v: 1, exported_at: b.exported_at, customers, members } };
  } catch (e) {
    if (e instanceof RowError) return bad(e.field);
    throw e;
  }
}
const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

// Display only: a name typed all in lower case ("pat zimmer") gets its
// capitals back. Anything with a capital in it is left exactly as entered.
export const tidy = (s) => (s && !/\p{Lu}/u.test(s) ? s.replace(/\p{L}+/gu, (w) => w[0].toUpperCase() + w.slice(1)) : s);

// "First Last", else the company, else a placeholder: never an empty row.
export function displayName(c) {
  return [tidy(str(c.first_name)), tidy(str(c.last_name))].filter(Boolean).join(" ") || str(c.company_name) || "No name";
}

// The name the list is alphabetised by: the last name, falling back to the
// first name and then the company. Leading punctuation ("& Dan Baker" for a
// couple) is skipped so the row still lands under a letter.
export function sortName(c) {
  const last = str(c.last_name).replace(/^[^\p{L}\p{N}]+/u, "");
  return last || str(c.first_name).replace(/^[^\p{L}\p{N}]+/u, "") || str(c.company_name);
}

// The letter heading a customer sits under: A–Z, or # for anything else.
export function initial(c) {
  const ch = sortName(c).charAt(0).normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
  return /^[A-Z]$/.test(ch) ? ch : "#";
}

// By last name, then first name, then company. # sorts last.
export function customersSorted(customers) {
  const keys = (c) => [initial(c) === "#" ? "￿" : "", sortName(c), str(c.first_name), str(c.company_name)];
  return [...customers].sort((a, b) => {
    const ka = keys(a), kb = keys(b);
    for (let i = 0; i < ka.length; i++) { const r = collator.compare(ka[i], kb[i]); if (r) return r; }
    return 0;
  });
}

// "+17633143400" → "7633143400"; anything that isn't a US number keeps its digits.
export function phoneDigits(raw) {
  let d = str(raw).replace(/\D/g, "");
  if (d.length === 11 && d[0] === "1") d = d.slice(1);
  return d;
}

// "(763) 314-3400" for a 10-digit number, else whatever Rotor had.
export function phoneFormatted(raw) {
  const d = phoneDigits(raw);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : str(raw);
}

// ["100 Example Ave", "Delano, MN 55328"], dropping whatever is missing.
export function addressLines(c) {
  const a = c && c.address;
  if (!a) return [];
  if (typeof a === "string") return a.split(/\s*[\n,]\s*/).map((s) => s.trim()).filter(Boolean);
  const street = [str(a.street1), str(a.street2)].filter(Boolean).join(", ");
  const cityState = [str(a.city), str(a.state)].filter(Boolean).join(", ");
  const town = [cityState, str(a.zip)].filter(Boolean).join(" ");
  return [street, town].filter(Boolean);
}

export const addressText = (c) => addressLines(c).join(", ");

// The town shown on the right of a row.
export function city(c) {
  const a = c && c.address;
  return a && typeof a === "object" ? str(a.city) : "";
}

// Apple Maps opens this on an iPhone; everywhere else it redirects to a web
// map. Empty when there's no address to send.
export function mapsUrl(c) {
  const q = addressText(c);
  return q ? "https://maps.apple.com/?q=" + encodeURIComponent(q) : "";
}

export const rotorUrl = (c) => ROTOR_CUSTOMER_URL + encodeURIComponent(str(c.id));

// user_id → display name. Built once per page (customersHtml passes the
// Map down), so a long list doesn't search the members for every row.
export function memberNames(members = []) {
  if (members instanceof Map) return members;
  const out = new Map();
  for (const m of members || []) {
    if (!plain(m) || !m.user_id || out.has(m.user_id)) continue;
    out.set(m.user_id, str(m.name) || [str(m.first_name), str(m.last_name)].filter(Boolean).join(" "));
  }
  return out;
}

export const memberName = (id, members = []) => memberNames(members).get(id) || "";

export function assignedNames(c, members) {
  const names = memberNames(members);
  return (Array.isArray(c.assigned_to) ? c.assigned_to : []).map((id) => names.get(id) || "").filter(Boolean);
}

// "Mar 2025" (company time zone) from an ISO timestamp; "" if unreadable.
export function sinceLabel(iso) {
  const d = new Date(iso || "");
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "America/Chicago" });
}

export const statusLabel = (s) => { const t = str(s).toLowerCase(); return t ? t[0].toUpperCase() + t.slice(1) : "Unknown"; };

// [{ label, count }] by how common each source is; empty sources are skipped.
export function sourceCounts(customers) {
  const out = new Map();
  for (const c of customers) { const s = str(c.source); if (s) out.set(s, (out.get(s) || 0) + 1); }
  return [...out].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || collator.compare(a.label, b.label));
}

// What the page needs for one customer: display strings only, no member
// emails or ids, so the browser never gets more than it shows.
export function customerView(c, members = []) {
  const name = displayName(c);
  const company = str(c.company_name);
  return {
    id: str(c.id),
    name,
    company: company && company !== name ? company : "",
    status: str(c.status).toLowerCase() || "unknown",
    statusLabel: statusLabel(c.status),
    phone: phoneDigits(c.phone),
    phoneFmt: phoneFormatted(c.phone),
    email: str(c.email),
    address: addressLines(c),
    city: city(c),
    maps: mapsUrl(c),
    source: str(c.source),
    tags: (Array.isArray(c.tags) ? c.tags : []).map(str).filter(Boolean),
    assigned: assignedNames(c, members),
    since: sinceLabel(c.created_at),
    notes: str(c.notes),
    letter: initial(c),
  };
}
