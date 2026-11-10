// Barta CRM core: the exactly-once marker state machine (design §7.3).
//
// Every side effect and every sweep item runs under a marker at
// done/{scope}/{key} (live) or done-dry/{scope}/{key} (dry-run; a live claim
// never reads it, so a step "sent" in dry-run still goes out for real after
// cutover). The storage half (claimMarker, advanceMarker) lives in
// crm-store.mjs; this file holds the pure rules:
//
//   claimed { holder, lease_until, attempt, deferred_until? }
//      │  written right before the provider call:
//      ▼
//   sending { at, provider, idempotency_key?, to_hk?, body_sha256?, metadata? }
//      │
//      ▼
//   done { result, provider_ref } | failed { code, retry_at? } | unknown { reason }
//
// - A missing marker is created as `claimed`. A `claimed` whose lease ran
//   out never reached the provider, so it is taken over (attempt + 1).
//   A `failed` whose retry_at has passed is taken over the same way.
// - A holder whose `claimed` lease ran out may not move to `sending` (it
//   must claim again): another worker may already be taking it over.
// - `sending` gets its own fresh lease (SENDING_LEASE_MS: the 8 s provider
//   timeout plus a wide margin), so it is never settled while the call it
//   announces is still in flight.
// - An expired `sending` is ambiguous: it is never re-run. The provider's
//   settler (registerSettler) looks for the call; found → done, not found →
//   unknown (the owners are alerted, nothing is re-sent automatically).

import { StaleError } from "./errors.mjs";

export const SENDING_LEASE_MS = 60 * 1000;

export const NAMESPACES = Object.freeze(["done", "done-dry"]);
export const STATES = Object.freeze(["claimed", "sending", "done", "failed", "unknown"]);
export const FINAL_STATES = Object.freeze(["done", "unknown"]);

// Allowed moves for the holder. claimed → claimed is a deferral (quiet
// hours): same holder, new deferred_until, lease stretched to cover it.
const NEXT = Object.freeze({
  claimed: ["claimed", "sending", "done", "failed", "unknown"],
  sending: ["done", "failed", "unknown"],
  failed: [],
  done: [],
  unknown: [],
});
export const canAdvance = (from, to) => !!NEXT[from] && NEXT[from].includes(to);

const ms = (iso) => (iso ? Date.parse(iso) : NaN);
export const leaseExpired = (m, nowMs) => !(ms(m && m.lease_until) > nowMs);

// What a claim does with the stored marker (or null):
// "create" | "takeover" | "busy" | "settle" | "final".
export function decideClaim(existing, nowMs) {
  if (!existing) return "create";
  switch (existing.state) {
    case "claimed": return leaseExpired(existing, nowMs) ? "takeover" : "busy";
    case "sending": return leaseExpired(existing, nowMs) ? "settle" : "busy";
    case "failed": return existing.retry_at && ms(existing.retry_at) <= nowMs ? "takeover" : "final";
    default: return "final";
  }
}

const TRAIL_MAX = 12;
const trail = (prev, state, at) => [...((prev && prev.trail) || []), { state, at }].slice(-TRAIL_MAX);

// The value a claim writes.
export function claimValue(prev, { holder, leaseMs, nowMs, ns, scope, key }) {
  const at = new Date(nowMs).toISOString();
  return {
    ns, scope, key,
    state: "claimed",
    holder: String(holder),
    attempt: ((prev && prev.attempt) || 0) + 1,
    claimed_at: at,
    lease_until: new Date(nowMs + leaseMs).toISOString(),
    created_at: (prev && prev.created_at) || at,
    trail: trail(prev, "claimed", at),
    // a sweep that stopped half way keeps where it was (core/sweeps.mjs)
    ...(prev && prev.cursor !== undefined ? { cursor: prev.cursor } : {}),
  };
}

const REQUIRED = Object.freeze({ sending: ["provider"], done: [], failed: ["code"], unknown: ["reason"], claimed: ["deferred_until"] });

// The value an advance writes; throws TypeError on a move the machine forbids.
// A `claimed` whose lease ran out cannot move to `sending`: StaleError (claim again).
export function advanceValue(current, next, nowMs) {
  const to = next && next.state;
  if (!canAdvance(current.state, to)) throw new TypeError(`markers: ${current.state} → ${to} is not allowed`);
  for (const f of REQUIRED[to]) if (next[f] === undefined || next[f] === null || next[f] === "") throw new TypeError(`markers: ${to} needs ${f}`);
  if (current.state === "claimed" && to === "sending" && leaseExpired(current, nowMs)) {
    throw new StaleError(null, null, "This step's claim ran out before the send. Claim it again.");
  }
  const at = new Date(nowMs).toISOString();
  const keep = { ns: current.ns, scope: current.scope, key: current.key, holder: current.holder, attempt: current.attempt, created_at: current.created_at, claimed_at: current.claimed_at };
  const out = { ...keep, ...next, state: to, updated_at: at, trail: trail(current, to, at) };
  if (to === "claimed") {
    // a deferral keeps the claim until (at least) the deferred time
    out.lease_until = new Date(Math.max(ms(current.lease_until) || 0, ms(next.deferred_until) || 0, nowMs)).toISOString();
  } else if (to === "sending") {
    out.at = next.at || at;
    out.lease_until = next.lease_until || new Date(nowMs + SENDING_LEASE_MS).toISOString();
  } else {
    out.lease_until = current.lease_until;
  }
  return out;
}

// Settlers for an expired `sending`, one per provider ("stripe", "twilio",
// "postmark", ...). fn(marker) → { found: true, provider_ref } | { found: false } | null (can't tell yet).
const settlers = new Map();
export function registerSettler(provider, fn) {
  if (typeof fn !== "function") throw new TypeError("markers: settler must be a function");
  settlers.set(provider, fn);
}
export const unregisterSettler = (provider) => settlers.delete(provider);

// The outcome for an expired `sending` marker, or null when nobody can tell
// yet (no settler for its provider, or the settler could not reach it).
export async function settleSending(marker) {
  const fn = settlers.get(marker && marker.provider);
  if (!fn) return null;
  const r = await fn(marker);
  if (!r) return null;
  if (r.found) return { state: "done", result: "settled", provider_ref: r.provider_ref || null };
  return { state: "unknown", reason: "not_found" };
}
