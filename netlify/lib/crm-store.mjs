// Barta Office → Customers (docs/CRM.md): the CRM's data layer, first
// version. Everything the CRM knows lives in the Netlify Blobs store "crm"
// (strong consistency, site-wide, survives deploys). Nothing about a
// customer is ever committed to the repo, which is public: the data gets
// here through the in-app Import screen (netlify/functions/crm-import.mjs).
//
// One key so far:
//   idx/customers   what the list page renders: every row (only the fields
//                   the site uses, checked by normalizeBundle() in
//                   crm-data.mjs), the members' names (never their emails),
//                   when it was exported and when it was imported
//
// An import is a single write of that one blob, so the list is always one
// whole export: a failed or interrupted import leaves the previous list as
// it was, and a customer dropped from a later export is gone from the store
// with that write (no per-customer copies are kept until a feature reads
// them). The summary GET /api/crm/import reports comes from the same blob.
//
// The index is one blob for now: the list page needs every row anyway, and
// the real export (under a thousand rows) is about 400-500 KB; an import is
// capped well below what a function may return (6 MB). It will shard
// (idx/customers/{a..z} with summaries only) when the real CRM lands and
// records change one at a time; those writes will use onlyIfMatch /
// onlyIfNew, which an import that replaces the whole list doesn't need.
//
// Every Blobs call has a timeout: the client can otherwise sleep 25 s on
// retries, longer than a function is allowed to run.
//
// Tests set globalThis.__crmStoreOverride to an in-memory store.

import { withTimeout } from "./referral-lib.mjs";

export const STORE_NAME = "crm";
export const TIMEOUT_MS = 8000;

export const KEYS = Object.freeze({
  customers: "idx/customers",
});

export async function openStore() {
  if (globalThis.__crmStoreOverride) return globalThis.__crmStoreOverride;
  const { getStore } = await import("@netlify/blobs");
  return getStore({ name: STORE_NAME, consistency: "strong" });
}

const str = (v) => (v == null ? "" : String(v)).trim();
// What the page needs to say who a customer is assigned to: the id and a
// display name. Emails and roles stay out of the index.
export const memberSummary = (m) => ({
  user_id: str(m && m.user_id),
  name: str(m && m.name) || [str(m && m.first_name), str(m && m.last_name)].filter(Boolean).join(" "),
});

// The object at idx/customers, or null before the first import. Rejects
// with a SyntaxError when the blob isn't JSON, and with a TimeoutError or
// the Blobs error when storage doesn't answer.
export async function readCustomerIndex({ timeoutMs = TIMEOUT_MS } = {}) {
  const store = await openStore();
  return withTimeout(() => store.get(KEYS.customers, { type: "json" }), timeoutMs, "crm: read customer index");
}

// The index for an opened, checked export.
// `now` may be a Date or a function returning one (tests pin it).
export function buildCustomerIndex({ customers, members, exported_at }, { now = () => new Date() } = {}) {
  const rows = Array.isArray(customers) ? customers.filter((c) => c && typeof c === "object" && !Array.isArray(c) && str(c.id)) : [];
  const people = (Array.isArray(members) ? members : []).map(memberSummary).filter((m) => m.user_id);
  const at = typeof now === "function" ? now() : now;
  return { v: 1, imported_at: new Date(at).toISOString(), exported_at: str(exported_at), count: rows.length, members: people, customers: rows };
}

// { imported_at, exported_at, counts: { customers, members } } for an index,
// or null when there is none (what GET /api/crm/import answers).
export function indexSummary(idx) {
  if (!idx || typeof idx !== "object" || !Array.isArray(idx.customers)) return null;
  const count = Number.isInteger(idx.count) ? idx.count : idx.customers.length;
  return {
    imported_at: str(idx.imported_at) || null,
    exported_at: str(idx.exported_at) || null,
    counts: { customers: count, members: Array.isArray(idx.members) ? idx.members.length : 0 },
  };
}

// Replaces the list: the one write an import makes.
export async function writeCustomerIndex(index, { timeoutMs = TIMEOUT_MS } = {}) {
  const store = await openStore();
  await withTimeout(() => store.setJSON(KEYS.customers, index), timeoutMs, "crm: write customer index");
  return indexSummary(index);
}
