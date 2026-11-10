// The exactly-once marker state machine (design §7.3, §11.4 M1.1): every
// transition; an expired `claimed` is retried; an expired `sending` goes to
// the settle hook and is never re-run; done-dry/ never satisfies a live claim.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createCrmStores, useCrmStores, clearCrmStores } from "../../helpers/crm-memory-store.mjs";

const { claimMarker, advanceMarker, K, StaleError } = await import("../../../netlify/lib/crm-store.mjs");
const M = await import("../../../netlify/lib/crm/core/markers.mjs");
const { setNow } = await import("../../../netlify/lib/crm/core/clock.mjs");

const T0 = Date.parse("2026-11-17T15:00:00Z");
const ctx = { requestId: "m" };
let S;
beforeEach(() => { S = useCrmStores(createCrmStores()); setNow(T0); });
afterEach(() => { clearCrmStores(); setNow(null); M.unregisterSettler("twilio"); M.unregisterSettler("stripe"); });

const iso = (ms) => new Date(ms).toISOString();

test("decideClaim covers every state", () => {
  assert.equal(M.decideClaim(null, T0), "create");
  assert.equal(M.decideClaim({ state: "claimed", lease_until: iso(T0 + 1) }, T0), "busy");
  assert.equal(M.decideClaim({ state: "claimed", lease_until: iso(T0) }, T0), "takeover");
  assert.equal(M.decideClaim({ state: "sending", lease_until: iso(T0 + 1) }, T0), "busy");
  assert.equal(M.decideClaim({ state: "sending", lease_until: iso(T0 - 1) }, T0), "settle");
  assert.equal(M.decideClaim({ state: "failed", code: "x" }, T0), "final");
  assert.equal(M.decideClaim({ state: "failed", code: "x", retry_at: iso(T0 + 1) }, T0), "final");
  assert.equal(M.decideClaim({ state: "failed", code: "x", retry_at: iso(T0) }, T0), "takeover");
  assert.equal(M.decideClaim({ state: "done" }, T0), "final");
  assert.equal(M.decideClaim({ state: "unknown" }, T0), "final");
});

test("the transition table: allowed moves pass, every other move throws", () => {
  const allowed = { claimed: ["claimed", "sending", "done", "failed", "unknown"], sending: ["done", "failed", "unknown"], failed: [], done: [], unknown: [] };
  for (const from of M.STATES) {
    for (const to of M.STATES) assert.equal(M.canAdvance(from, to), allowed[from].includes(to), `${from} → ${to}`);
  }
  const claimed = M.claimValue(null, { holder: "w", leaseMs: 1000, nowMs: T0, ns: "done", scope: "s", key: "k" });
  assert.throws(() => M.advanceValue(claimed, { state: "sending" }, T0), /needs provider/);
  assert.throws(() => M.advanceValue(claimed, { state: "failed" }, T0), /needs code/);
  assert.throws(() => M.advanceValue(claimed, { state: "unknown" }, T0), /needs reason/);
  const deferred = M.advanceValue(claimed, { state: "claimed", deferred_until: iso(T0 + 3600000) }, T0);
  assert.equal(deferred.lease_until, iso(T0 + 3600000), "a quiet-hours deferral keeps the claim until then");
  const sending = M.advanceValue(claimed, { state: "sending", provider: "twilio", to_hk: "abc", body_sha256: "f00" }, T0);
  assert.equal(sending.at, iso(T0));
  assert.throws(() => M.advanceValue(sending, { state: "claimed", deferred_until: iso(T0) }, T0), TypeError);
  const done = M.advanceValue(sending, { state: "done", result: "sent", provider_ref: "SM1" }, T0);
  assert.deepEqual(done.trail.map((t) => t.state), ["claimed", "sending", "done"]);
  assert.throws(() => M.advanceValue(done, { state: "failed", code: "x" }, T0), TypeError);
});

test("a live claim: create, busy for another holder, then the full path to done", async () => {
  const a = await claimMarker("done", "visit.reminder_2d", "vs_1--2026-11-19", { holder: "pass-1", leaseMs: 120000 }, ctx);
  assert.equal(a.ok, true);
  assert.equal(a.marker.state, "claimed");
  const b = await claimMarker("done", "visit.reminder_2d", "vs_1--2026-11-19", { holder: "pass-2", leaseMs: 120000 }, ctx);
  assert.equal(b.ok, false);
  assert.equal(b.marker.holder, "pass-1");
  const sending = await advanceMarker(a.marker, { state: "sending", provider: "twilio", to_hk: "abc" }, ctx);
  const done = await advanceMarker(sending, { state: "done", result: "sent", provider_ref: "SM1" }, ctx);
  assert.equal(S.data.json(K.done("done", "visit.reminder_2d", "vs_1--2026-11-19")).state, "done");
  const again = await claimMarker("done", "visit.reminder_2d", "vs_1--2026-11-19", { holder: "pass-3", leaseMs: 120000 }, ctx);
  assert.equal(again.ok, false, "done is final");
  assert.equal(done.provider_ref, "SM1");
});

test("an expired `claimed` never reached the provider: it is taken over (attempt + 1)", async () => {
  await claimMarker("done", "invoice.overdue", "in_1--2", { holder: "pass-1", leaseMs: 60000 }, ctx);
  setNow(T0 + 60001);
  const r = await claimMarker("done", "invoice.overdue", "in_1--2", { holder: "pass-2", leaseMs: 60000 }, ctx);
  assert.equal(r.ok, true);
  assert.equal(r.marker.attempt, 2);
  assert.equal(r.marker.holder, "pass-2");
});

test("a failed marker is retried only after its retry_at", async () => {
  const a = await claimMarker("done", "charge", "pa_1", { holder: "w1", leaseMs: 60000 }, ctx);
  await advanceMarker(a.marker, { state: "failed", code: "card_declined", retry_at: iso(T0 + 3 * 86400000) }, ctx);
  assert.equal((await claimMarker("done", "charge", "pa_1", { holder: "w2", leaseMs: 60000 }, ctx)).ok, false);
  setNow(T0 + 3 * 86400000);
  const r = await claimMarker("done", "charge", "pa_1", { holder: "w3", leaseMs: 60000 }, ctx);
  assert.equal(r.ok, true);
  assert.equal(r.marker.attempt, 2);
});

test("an expired `sending` calls the settle hook and is never re-run (found → done)", async () => {
  const seen = [];
  M.registerSettler("twilio", async (m) => { seen.push(m.key); return { found: true, provider_ref: "SM9" }; });
  const a = await claimMarker("done", "review.sequence", "jb_1--2", { holder: "w1", leaseMs: 60000 }, ctx);
  await advanceMarker(a.marker, { state: "sending", provider: "twilio", to_hk: "abc" }, ctx);
  setNow(T0 + 60001);
  const r = await claimMarker("done", "review.sequence", "jb_1--2", { holder: "w2", leaseMs: 60000 }, ctx);
  assert.equal(r.ok, false, "never re-run");
  assert.deepEqual(seen, ["jb_1--2"]);
  assert.equal(r.marker.state, "done");
  assert.equal(r.marker.provider_ref, "SM9");
  assert.equal(r.marker.settled_by, "fix.settle");
});

test("an expired `sending` the provider has no trace of becomes unknown (the owner decides, nothing is re-sent)", async () => {
  M.registerSettler("stripe", async () => ({ found: false }));
  const a = await claimMarker("done", "charge", "pa_2", { holder: "w1", leaseMs: 60000 }, ctx);
  await advanceMarker(a.marker, { state: "sending", provider: "stripe", idempotency_key: "charge:pa_2" }, ctx);
  setNow(T0 + 60001);
  const r = await claimMarker("done", "charge", "pa_2", { holder: "w2", leaseMs: 60000 }, ctx);
  assert.equal(r.ok, false);
  assert.equal(r.marker.state, "unknown");
  assert.equal(r.marker.reason, "not_found");
});

test("an expired `sending` with no settler for its provider stays as it is (the fix.settle sweep keeps trying)", async () => {
  const a = await claimMarker("done", "email", "x1", { holder: "w1", leaseMs: 60000 }, ctx);
  await advanceMarker(a.marker, { state: "sending", provider: "postmark" }, ctx);
  setNow(T0 + 60001);
  const r = await claimMarker("done", "email", "x1", { holder: "w2", leaseMs: 60000 }, ctx);
  assert.equal(r.ok, false);
  assert.equal(r.settling, true);
  assert.equal(r.marker.state, "sending");
});

test("done-dry/ never satisfies a live claim", async () => {
  const dry = await claimMarker("done-dry", "visit.reminder_2d", "vs_9--2026-12-01", { holder: "w1", leaseMs: 60000 }, ctx);
  await advanceMarker(dry.marker, { state: "done", result: "dry_run" }, ctx);
  const live = await claimMarker("done", "visit.reminder_2d", "vs_9--2026-12-01", { holder: "w2", leaseMs: 60000 }, ctx);
  assert.equal(live.ok, true, "a step sent in dry-run still goes out for real after cutover");
  assert.ok(S.data.json(K.done("done-dry", "visit.reminder_2d", "vs_9--2026-12-01")));
  await assert.rejects(claimMarker("done-live", "x", "y", { holder: "w", leaseMs: 1 }, ctx), TypeError);
});

test("a stale holder loses its advance", async () => {
  const a = await claimMarker("done", "sweep", "quotes.expire--2026-11-17", { holder: "w1", leaseMs: 1000 }, ctx);
  setNow(T0 + 1001);
  const b = await claimMarker("done", "sweep", "quotes.expire--2026-11-17", { holder: "w2", leaseMs: 1000 }, ctx);
  assert.equal(b.ok, true);
  await assert.rejects(advanceMarker(a.marker, { state: "done", result: "completed" }, ctx), StaleError);
  const done = await advanceMarker(b.marker, { state: "done", result: "completed" }, ctx);
  assert.equal(done.holder, "w2");
});
