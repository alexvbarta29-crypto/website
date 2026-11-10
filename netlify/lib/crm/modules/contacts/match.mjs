// Contacts module: who is this? (design §5.1 "Dedupe and merge", §10.3).
//
//   resolveContact(id)   follows merging_into / merged_into to the contact
//                        that survives (every writer that lands something on
//                        a contact asks this first: inbound texts, intake,
//                        payments, imports), at most MAX_HOPS hops
//   contactsAt(kind, v)  the live contacts behind ptr/phone/{hk} or
//                        ptr/email/{hk} (lookup lists, never constraints:
//                        households share numbers, R18)
//   findMatches(...)     exact phone and email matches (high), then the same
//                        first and last name with the same ZIP (medium) or
//                        anywhere (low) from the contacts index. Never an
//                        automatic merge on a name.
//   createCandidate(...) one merge_candidate per pair, ever (ptr/merge-pair)

import { getRecord, getRecords, readPointer, readIndex, createRecord, hk } from "../../../crm-store.mjs";
import { isId, deriveId } from "../../core/ids.mjs";
import { ExistsError } from "../../core/errors.mjs";
import { contactShard } from "../../core/stats.mjs";
import { normName, toE164, normalizeEmail } from "./display.mjs";
import { pairKey } from "./types.mjs";

export const MAX_HOPS = 5;
export const MAX_MATCHES = 10;

const live = (c) => !!c && !c.deleted_at && !c.merged_into;

// → { id, data, etag } of the surviving contact, or null when there is none.
export async function resolveContact(id, opts = {}) {
  let cur = id;
  for (let i = 0; i <= MAX_HOPS; i++) {
    if (!isId(cur, "contact")) return null;
    const got = await getRecord("contact", cur, opts);
    if (!got) return null;
    const next = got.data.merged_into || got.data.merging_into;
    if (!next || next === cur) return { id: cur, data: got.data, etag: got.etag };
    cur = next;
  }
  return null;
}

// The contacts.resolve service: (contact_id) → contact_id (the id itself when nothing follows).
export async function resolveId(id, opts = {}) {
  const r = await resolveContact(id, opts);
  return r ? r.id : id;
}

const addrHk = (kind, v) => {
  try { return hk(kind, v); } catch { return null; }
};

// The live contacts behind one address, survivors only, no repeats.
export async function contactsAt(kind, value, opts = {}) {
  const key = addrHk(kind, value);
  if (!key) return [];
  const p = await readPointer(kind, key, opts);
  const ids = p && Array.isArray(p.ids) ? p.ids.filter((x) => isId(x, "contact")).slice(0, 20) : [];
  const out = new Map();
  for (const id of ids) {
    const r = await resolveContact(id, opts);
    if (r && live(r.data) && !out.has(r.id)) out.set(r.id, r);
  }
  return [...out.values()];
}

// The best record to upsert a lead onto: most recently updated, not archived.
export function pickUpsertTarget(list) {
  const ok = list.filter((r) => live(r.data) && r.data.lifecycle !== "archived");
  ok.sort((a, b) => String(b.data.updated_at || "").localeCompare(String(a.data.updated_at || "")));
  return ok[0] || null;
}

// The contacts.findMatches service: ({ phones, emails, first_name, last_name,
// zip, exclude? }) → [{ id, reason, confidence, name? }].
export async function findMatches({ phones = [], emails = [], first_name, last_name, zip, exclude = [] } = {}, opts = {}) {
  const out = new Map();
  const skip = new Set(exclude);
  const add = (id, reason, confidence, name) => {
    if (skip.has(id) || out.has(id)) return;
    out.set(id, { id, reason, confidence, ...(name ? { name } : {}) });
  };
  for (const raw of phones.slice(0, 5)) {
    const e164 = toE164(raw);
    if (!e164) continue;
    for (const r of await contactsAt("phone", e164, opts)) add(r.id, "phone", "high", r.data.display_name);
  }
  for (const raw of emails.slice(0, 5)) {
    const e = normalizeEmail(raw);
    if (!e) continue;
    for (const r of await contactsAt("email", e, opts)) add(r.id, "email", "high", r.data.display_name);
  }
  const f = normName(first_name), l = normName(last_name);
  if (f && l && out.size < MAX_MATCHES) {
    const ix = await readIndex("contacts", contactShard("ct_00000000000000000000"), opts);
    const z = String(zip || "").slice(0, 5);
    for (const row of ix.rows) {
      if (out.size >= MAX_MATCHES) break;
      if (normName(row.f) !== f || normName(row.l) !== l) continue;
      const sameZip = z && String(row.z || "").slice(0, 5) === z;
      add(row.id, sameZip ? "name_zip" : "name", sameZip ? "medium" : "low", row.n);
    }
  }
  return [...out.values()].slice(0, MAX_MATCHES);
}

// One merge candidate for a pair (a/b in id order), at most once ever: the
// pair's pointer remembers a dismissal across import re-runs (§10.4).
// → { id, created }
export async function createCandidate(a, b, { reason, confidence }, ctx = {}) {
  if (!isId(a, "contact") || !isId(b, "contact") || a === b) return null;
  const [x, y] = [a, b].sort();
  const id = deriveId("merge_candidate", `pair:${pairKey(x, y)}`);
  try {
    await createRecord("merge_candidate", { id, a: x, b: y, reason, confidence, status: "pending" }, ctx);
    return { id, created: true };
  } catch (e) {
    if (e instanceof ExistsError) {
      const p = await readPointer("merge-pair", pairKey(x, y), ctx);
      return { id: (p && p.id) || id, created: false };
    }
    throw e;
  }
}

// The live contact records for ids (missing and merged ones dropped).
export async function liveContacts(ids, opts = {}) {
  const got = await getRecords("contact", ids.filter((id) => isId(id, "contact")), opts);
  return got.filter((g) => g && live(g.data));
}
