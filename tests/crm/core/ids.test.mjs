// Record ids (design §3.3, §12.2): fixed width, time-sortable newId,
// idForRotor a pure function and collision-free over 50k synthetic Rotor
// ids, deriveId scopes never colliding.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

const ids = await import("../../../netlify/lib/crm/core/ids.mjs");
const { newId, idForRotor, deriveId, typeOf, isId, ID_RE, setRandom, timeOfId, registerPrefix, prefixOf } = ids;

afterEach(() => setRandom(null));

// A seeded generator of Rotor-shaped UUIDs (made up, deterministic).
function* rotorUuids(n, seed = 42) {
  let s = seed;
  const next = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0).toString(16).padStart(8, "0"); };
  for (let i = 0; i < n; i++) {
    const h = next() + next() + next() + next();
    yield `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  }
}

test("newId: 23 characters, Crockford base32, the type's prefix, sortable by creation time", () => {
  const a = newId("contact", new Date("2026-11-17T15:00:00.000Z"));
  const b = newId("contact", new Date("2026-11-17T15:00:00.001Z"));
  const c = newId("contact", new Date("2027-01-04T06:00:00.000Z"));
  for (const id of [a, b, c]) {
    assert.equal(id.length, 23);
    assert.match(id, ID_RE);
    assert.equal(typeOf(id), "contact");
  }
  assert.deepEqual([c, a, b].sort(), [a, b, c]);
  assert.equal(timeOfId(a), Date.parse("2026-11-17T15:00:00.000Z"));
  assert.ok(!/[ilou]/.test(a.slice(3)), "no ambiguous letters");
});

test("newId takes an injectable random source so tests can pin ids", () => {
  setRandom((n) => new Uint8Array(n).fill(0xab));
  const at = new Date("2026-11-17T15:00:00Z");
  assert.equal(newId("job", at), newId("job", at));
  setRandom(null);
  assert.notEqual(newId("job", at), newId("job", at));
});

test("idForRotor is a pure function of type and Rotor id, fixed width, no timestamp", () => {
  const rid = "0b1c2d3e-0000-4000-8000-000000000001";
  const a = idForRotor("contact", rid);
  assert.equal(a, idForRotor("contact", rid));
  assert.equal(a.length, 23);
  assert.match(a, ID_RE);
  assert.notEqual(a, idForRotor("job", rid).replace(/^jb/, "ct"), "the type is part of the hash");
  assert.throws(() => idForRotor("contact", ""), TypeError);
  assert.throws(() => idForRotor("nope", rid), TypeError);
});

test("idForRotor: 50,000 synthetic Rotor ids, no collision", () => {
  const seen = new Set();
  for (const rid of rotorUuids(50000)) seen.add(idForRotor("contact", rid));
  assert.equal(seen.size, 50000);
});

test("deriveId: the same op, scope and n give the same id; scopes never collide", () => {
  const op = "approve--qt_0000000000000000000a--1";
  const scopes = ["work.createJobs@plans", "work.createJobs@quotes", "work.createJobs@lights"];
  const all = new Set();
  for (const scope of scopes) {
    for (let n = 0; n < 50; n++) {
      const id = deriveId("job", op, scope, n);
      assert.equal(id, deriveId("job", op, scope, n));
      all.add(id);
    }
  }
  assert.equal(all.size, 150);
  assert.notEqual(deriveId("job", op, "a", 1), deriveId("job", op, "a", 2));
  assert.notEqual(deriveId("job", "op1", "s", 1), deriveId("job", "op2", "s", 1));
  const client = deriveId("timer", "c:5b1f7d64-1c55-4d4e-9b0e-0123456789ab");
  assert.equal(client, deriveId("timer", "c:5b1f7d64-1c55-4d4e-9b0e-0123456789ab"), "an offline replay lands on the same id");
  assert.equal(typeOf(client), "timer");
  assert.throws(() => deriveId("job", ""), TypeError);
  // the parts are encoded unambiguously: a separator inside a part cannot make two calls collide
  assert.notEqual(deriveId("job", "a|b", "c", 1), deriveId("job", "a", "b|c", 1));
  assert.notEqual(deriveId("job", "op", "scope"), deriveId("job", "op|scope"));
  assert.notEqual(deriveId("job", "op", "1"), deriveId("job", "op", undefined, "1"));
  assert.notEqual(deriveId("job", "op", "s", 1), deriveId("job", "op", "s", "1"));
});

test("prefixes are unique per type", () => {
  assert.equal(prefixOf("invoice"), "in");
  assert.throws(() => registerPrefix("widget", "in"), /already belongs/);
  assert.throws(() => registerPrefix("invoice", "iv"), /already uses/);
  registerPrefix("widget", "wg");
  assert.ok(isId(newId("widget"), "widget"));
  assert.equal(isId("ct_short"), false);
  assert.equal(typeOf("zz_0000000000000000000a"), null);
});
