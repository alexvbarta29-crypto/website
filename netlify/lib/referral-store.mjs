// Storage for the referral program: a thin adapter over Netlify Blobs (store
// "referrals", strong consistency) plus the key layout from
// docs/REFERRAL-PROGRAM.md and the handful of typed reads/writes the
// functions need.
//
// Tests never touch Blobs: they set globalThis.__referralStoreOverride to an
// in-memory object with the same get/setJSON/list/delete surface, and
// openStore() hands that back instead. The real client is loaded with a
// dynamic import so the test process never needs the Netlify environment.

import { STORE_NAME } from "./referral-config.mjs";
import { mapLimit, safeErr, withTimeout } from "./referral-lib.mjs";

export const KEYS = Object.freeze({
  referrer: (id) => `referrer/${id}`,
  code: (code) => `code/${code}`,
  token: (token) => `token/${token}`,
  referral: (id) => `referral/${id}`,
  byReferrer: (referrerId, referralId) => `idx/referrer/${referrerId}/${referralId}`,
  byReferrerPrefix: (referrerId) => `idx/referrer/${referrerId}/`,
  byPhone: (digits) => `idx/phone/${digits}`,
});

export async function openStore() {
  if (globalThis.__referralStoreOverride) return globalThis.__referralStoreOverride;
  const { getStore } = await import("@netlify/blobs");
  // Strong consistency: the success screen and the dashboard read back what
  // was just written, and eventual consistency would show a blank page.
  return getStore({ name: STORE_NAME, consistency: "strong" });
}

// Primitive JSON reads/writes. Blobs returns null for a missing key.
export const getJSON = (store, key) => store.get(key, { type: "json" });
export const putJSON = (store, key, value) => store.setJSON(key, value);
export async function listKeys(store, prefix) {
  const res = await store.list({ prefix });
  return (res && Array.isArray(res.blobs) ? res.blobs : []).map((b) => b.key);
}
// Bounded parallel load; drops keys that vanished between list and get.
export async function loadMany(store, keys, limit = 16) {
  const rows = await mapLimit(keys, limit, (k) => getJSON(store, k));
  return rows.filter((r) => r && typeof r === "object");
}

// --- referrers -------------------------------------------------------------
export const getReferrer = (store, id) => getJSON(store, KEYS.referrer(id));
export async function referrerIdForCode(store, code) {
  const rec = await getJSON(store, KEYS.code(code));
  return rec && rec.referrer_id ? String(rec.referrer_id) : null;
}
export async function referrerIdForToken(store, token) {
  const rec = await getJSON(store, KEYS.token(token));
  return rec && rec.referrer_id ? String(rec.referrer_id) : null;
}
export const allReferrers = async (store) =>
  loadMany(store, await listKeys(store, "referrer/"));
// newMaps: write the code/{CODE} and token/{TOKEN} pointers too (first save).
export async function saveReferrer(store, referrer, { newMaps = false } = {}) {
  await putJSON(store, KEYS.referrer(referrer.id), referrer);
  if (newMaps) {
    await putJSON(store, KEYS.code(referrer.code), { referrer_id: referrer.id });
    await putJSON(store, KEYS.token(referrer.token), { referrer_id: referrer.id });
  }
}

// --- referrals -------------------------------------------------------------
export const getReferral = (store, id) => getJSON(store, KEYS.referral(id));
export async function referralIdForPhone(store, digits) {
  const rec = await getJSON(store, KEYS.byPhone(digits));
  return rec && rec.id ? String(rec.id) : null;
}
export async function referralIdsForReferrer(store, referrerId) {
  const prefix = KEYS.byReferrerPrefix(referrerId);
  const keys = await listKeys(store, prefix);
  return keys.map((k) => k.slice(prefix.length)).filter(Boolean);
}
export async function referralsForReferrer(store, referrerId) {
  const ids = await referralIdsForReferrer(store, referrerId);
  return loadMany(store, ids.map((id) => KEYS.referral(id)));
}
export const allReferrals = async (store) =>
  loadMany(store, await listKeys(store, "referral/"));
export const saveReferralRecord = (store, referral) =>
  putJSON(store, KEYS.referral(referral.id), referral);
// indexPhone: claim idx/phone for this friend — only the first (non-duplicate)
// referral of a phone number owns that pointer.
export async function saveReferral(store, referral, { indexPhone = true } = {}) {
  await saveReferralRecord(store, referral);
  await putJSON(store, KEYS.byReferrer(referral.referrer_id, referral.id), { id: referral.id });
  if (indexPhone) await putJSON(store, KEYS.byPhone(referral.phone_digits), { id: referral.id });
}
export async function deleteReferral(store, referral) {
  await store.delete(KEYS.referral(referral.id));
  await store.delete(KEYS.byReferrer(referral.referrer_id, referral.id));
  // Release the phone pointer only if this record owns it, so deleting a
  // flagged duplicate never un-indexes the original.
  const idx = await getJSON(store, KEYS.byPhone(referral.phone_digits));
  if (idx && idx.id === referral.id) await store.delete(KEYS.byPhone(referral.phone_digits));
}

// Picks a share code nobody holds yet. 32^5 codes make a collision rare, but
// a customer's code is forever, so check rather than hope.
export async function allocateCode(store, generate, tries = 6) {
  for (let i = 0; i < tries; i++) {
    const code = generate();
    if (!(await getJSON(store, KEYS.code(code)))) return code;
  }
  throw new Error("could not allocate a unique referral code");
}

// Best-effort wrapper for the public submit path: the first store failure
// (throw or timeout) flips `ok` to false and every later call becomes a
// no-op, so a Blobs outage costs one timeout, not one per friend, and the
// request can still go on to Rotor and report stored:false.
export class StoreGuard {
  constructor(store, { timeoutMs = 4000 } = {}) {
    this.store = store;
    this.ok = Boolean(store);
    this.timeoutMs = timeoutMs;
  }
  async run(label, fn) {
    if (!this.ok) return undefined;
    try {
      return await withTimeout(() => fn(this.store), this.timeoutMs, label);
    } catch (err) {
      this.ok = false;
      console.error(`referral store: ${label} failed (${safeErr(err)})`);
      return undefined;
    }
  }
}
export async function openGuardedStore(opts) {
  try {
    return new StoreGuard(await openStore(), opts);
  } catch (err) {
    console.error(`referral store: unavailable (${safeErr(err)})`);
    return new StoreGuard(null, opts);
  }
}
