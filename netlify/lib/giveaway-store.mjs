// Storage for the Holiday Lights Giveaway: Netlify Blobs store "giveaway"
// (strong consistency), separate from the referral program's store so the
// two can be cleared independently. Key layout (docs/GIVEAWAY.md):
//
//   entrant/{phone_digits}               the entrant record
//   code/{LIGHTS-XXXXX}  -> {id}          public share code
//   token/{TOKEN}        -> {id}          private status-page token
//   household/{key}      -> {id}          one entry per household
//   idx/ref/{referrer_id}/{entrant_id}   who entered through whose link
//   outside/{phone_digits}               out-of-area people who asked for a quote
//   draw/result                          the drawing, once held
//
// Tests set globalThis.__giveawayStoreOverride to an in-memory store.

import { STORE_NAME } from "./giveaway-config.mjs";
import { mapLimit, safeErr, withTimeout } from "./referral-lib.mjs";

export const KEYS = Object.freeze({
  entrant: (id) => `entrant/${id}`,
  code: (c) => `code/${c}`,
  token: (t) => `token/${t}`,
  household: (k) => `household/${k}`,
  ref: (rid, id) => `idx/ref/${rid}/${id}`,
  refPrefix: (rid) => `idx/ref/${rid}/`,
  outside: (id) => `outside/${id}`,
  draw: "draw/result",
});

export async function openStore() {
  if (globalThis.__giveawayStoreOverride) return globalThis.__giveawayStoreOverride;
  const { getStore } = await import("@netlify/blobs");
  return getStore({ name: STORE_NAME, consistency: "strong" });
}

export const getJSON = (store, key) => store.get(key, { type: "json" });
export const putJSON = (store, key, value) => store.setJSON(key, value);
export async function listKeys(store, prefix) {
  const res = await store.list({ prefix });
  return (res && Array.isArray(res.blobs) ? res.blobs : []).map((b) => b.key);
}
async function loadMany(store, keys, limit = 16) {
  const rows = await mapLimit(keys, limit, (k) => getJSON(store, k));
  return rows.filter((r) => r && typeof r === "object");
}
const pointer = async (store, key) => {
  const rec = await getJSON(store, key);
  return rec && rec.id ? String(rec.id) : null;
};

export const getEntrant = (store, id) => getJSON(store, KEYS.entrant(id));
export const idForCode = (store, code) => pointer(store, KEYS.code(code));
export const idForToken = (store, token) => pointer(store, KEYS.token(token));
export const idForHousehold = (store, key) => pointer(store, KEYS.household(key));
export const allEntrants = async (store) => loadMany(store, await listKeys(store, "entrant/"));
export const allOutside = async (store) => loadMany(store, await listKeys(store, "outside/"));
export async function friendsOf(store, id) {
  const prefix = KEYS.refPrefix(id);
  const ids = (await listKeys(store, prefix)).map((k) => k.slice(prefix.length)).filter(Boolean);
  return loadMany(store, ids.map((x) => KEYS.entrant(x)));
}

export const saveEntrantRecord = (store, e) => putJSON(store, KEYS.entrant(e.id), e);
// First save: the record plus every pointer to it.
export async function saveNewEntrant(store, e) {
  await saveEntrantRecord(store, e);
  await putJSON(store, KEYS.code(e.code), { id: e.id });
  await putJSON(store, KEYS.token(e.token), { id: e.id });
  if (e.household) await putJSON(store, KEYS.household(e.household), { id: e.id });
  if (e.referred_by) await putJSON(store, KEYS.ref(e.referred_by.id, e.id), { id: e.id });
}
export async function deleteEntrant(store, e) {
  await store.delete(KEYS.entrant(e.id));
  if (e.code) await store.delete(KEYS.code(e.code));
  if (e.token) await store.delete(KEYS.token(e.token));
  if (e.household && (await idForHousehold(store, e.household)) === e.id)
    await store.delete(KEYS.household(e.household));
  if (e.referred_by) await store.delete(KEYS.ref(e.referred_by.id, e.id));
  for (const k of await listKeys(store, KEYS.refPrefix(e.id))) await store.delete(k);
}
export async function deleteEverything(store) {
  const keys = await listKeys(store, "");
  await mapLimit(keys, 16, (k) => store.delete(k));
  return keys.length;
}

export const getDraw = (store) => getJSON(store, KEYS.draw);
export const saveDraw = (store, d) => putJSON(store, KEYS.draw, d);
export const clearDraw = (store) => store.delete(KEYS.draw);

export async function allocateCode(store, generate, tries = 6) {
  for (let i = 0; i < tries; i++) {
    const code = generate();
    if (!(await getJSON(store, KEYS.code(code)))) return code;
  }
  throw new Error("could not allocate a unique giveaway code");
}

// Bounded, logged wrapper so one slow Blobs call becomes a clean 503.
export async function guarded(label, fn, ms = 6000) {
  try {
    return await withTimeout(fn, ms, label);
  } catch (err) {
    console.error(`giveaway store: ${label} failed (${safeErr(err)})`);
    throw err;
  }
}
