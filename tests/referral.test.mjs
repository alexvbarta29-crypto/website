// Mocked tests for /api/referral (POST submit, GET ?t= dashboard, GET ?code=
// lookup). Run with: npm test  (node --test "tests/**/*.test.mjs")
// The store is an in-memory Map injected via globalThis.__referralStoreOverride
// and globalThis.fetch is a capture stub — nothing leaves the machine.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  setEnv, createMemoryStore, failingStore, useStore, mockFetch, jsonRequest, submission,
  CODE_RE, TOKEN_RE,
} from "./helpers/referral-harness.mjs";

setEnv({ REFERRAL_SMS_MODE: "off" });
const handler = (await import("../netlify/functions/referral.mjs")).default;

let store, net;
beforeEach(() => {
  store = useStore(createMemoryStore());
  net = mockFetch();
});

const post = (body) => handler(jsonRequest("/api/referral", "POST", body));
const get = (query) => handler(new Request("http://localhost/api/referral" + query));
const postOk = async (body) => {
  const res = await post(body);
  const text = await res.text();
  assert.equal(res.status, 200, text);
  return JSON.parse(text);
};

// ---------------------------------------------------------------------------
// method + validation
// ---------------------------------------------------------------------------
test("non GET/POST methods get 405 JSON", async () => {
  const res = await handler(new Request("http://localhost/api/referral", { method: "DELETE" }));
  assert.equal(res.status, 405);
  assert.equal((await res.json()).ok, false);
});

test("malformed JSON body is a 400 with no Rotor call", async () => {
  const res = await handler(new Request("http://localhost/api/referral", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json",
  }));
  assert.equal(res.status, 400);
  assert.equal(net.rotor().length, 0);
});

const invalid = [
  ["missing referrer first name", submission({ referrer: { first_name: "" } }), "referrer.first_name"],
  ["bad referrer phone", submission({ referrer: { phone: "555-01" } }), "referrer.phone"],
  ["missing referrer phone", submission({ referrer: { phone: "" } }), "referrer.phone"],
  ["invalid referrer email", submission({ referrer: { email: "not-an-email" } }), "referrer.email"],
  ["unknown reward_pref", submission({ referrer: { reward_pref: "cash" } }), "referrer.reward_pref"],
  ["referrer name over 60 chars", submission({ referrer: { first_name: "A".repeat(61) } }), "referrer.first_name"],
  ["no friends", submission({ friends: [] }), "friends"],
  ["friends not an array", submission({ friends: "Jane" }), "friends"],
  ["more than 10 friends", submission({ friends: Array.from({ length: 11 }, (_, i) => ({
    first_name: "F" + i, phone: "763555" + String(1000 + i) })) }), "friends"],
  ["friend without first name", submission({ friends: [{ first_name: "", phone: "7635550101" }] }), "friends.0.first_name"],
  ["friend with bad phone", submission({ friends: [{ first_name: "Jane", phone: "12345" }] }), "friends.0.phone"],
  ["second friend with bad phone names its index", submission({ friends: [
    { first_name: "Jane", phone: "7635550101" }, { first_name: "Bob", phone: "abc" }] }), "friends.1.phone"],
  ["self-referral", submission({ friends: [{ first_name: "Me", phone: "1 (763) 555-0100" }] }), "friends.0.phone"],
  ["friend note over 500 chars", submission({ friends: [{ first_name: "Jane", phone: "7635550101", note: "x".repeat(501) }] }), "friends.0.note"],
  ["friend address over 200 chars", submission({ friends: [{ first_name: "Jane", phone: "7635550101", address: "x".repeat(201) }] }), "friends.0.address"],
  ["consent false", submission({ consent: false }), "consent"],
  ["consent missing", (() => { const s = submission(); delete s.consent; return s; })(), "consent"],
  ["consent as string", submission({ consent: "true" }), "consent"],
];
for (const [name, body, field] of invalid) {
  test(`400: ${name} -> field ${field}`, async () => {
    const res = await post(body);
    assert.equal(res.status, 400);
    const out = await res.json();
    assert.equal(out.ok, false);
    assert.equal(out.field, field);
    assert.ok(typeof out.error === "string" && out.error.length > 0, "human readable error");
    assert.equal(net.rotor().length, 0, "no Rotor request for invalid submissions");
    assert.equal(store.map.size, 0, "nothing stored for invalid submissions");
  });
}

// ---------------------------------------------------------------------------
// happy path
// ---------------------------------------------------------------------------
test("successful submission: response shape, headers, and stored records", async () => {
  const res = await post(submission());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const out = await res.json();

  assert.equal(out.ok, true);
  assert.match(out.code, CODE_RE);
  assert.match(out.token, TOKEN_RE);
  assert.equal(out.share_url, `https://www.bartawindowwashing.com/r/${out.code}`);
  assert.equal(out.status_url, `https://www.bartawindowwashing.com/referral?t=${out.token}`);
  assert.deepEqual(out.referrer, { first_name: "Alex", reward_pref: "credit" });
  assert.equal(out.friends.length, 1);
  assert.match(out.friends[0].id, /^r_[0-9a-z]+$/);
  assert.deepEqual({ ...out.friends[0], id: "x" },
    { id: "x", first_name: "Jane", status: "new", duplicate: false });
  assert.equal(out.stored, true);
  assert.equal(out.delivered, true);

  // Storage layout from the contract.
  const referrer = store.json("referrer/7635550100");
  assert.equal(referrer.id, "7635550100");
  assert.equal(referrer.code, out.code);
  assert.equal(referrer.token, out.token);
  assert.equal(referrer.phone, "(763) 555-0100");
  assert.equal(referrer.phone_digits, "7635550100");
  assert.equal(referrer.reward_pref, "credit");
  assert.equal(referrer.source_page, "/refer.html");
  assert.ok(referrer.consent_at && referrer.created_at && referrer.updated_at);
  assert.deepEqual(store.json(`code/${out.code}`), { referrer_id: "7635550100" });
  assert.deepEqual(store.json(`token/${out.token}`), { referrer_id: "7635550100" });

  const id = out.friends[0].id;
  const referral = store.json(`referral/${id}`);
  assert.equal(referral.referrer_id, "7635550100");
  assert.equal(referral.code, out.code);
  assert.equal(referral.referrer_name, "Alex Barta");
  assert.equal(referral.referrer_phone, "(763) 555-0100");
  assert.equal(referral.first_name, "Jane");
  assert.equal(referral.last_name, "Doe");
  assert.equal(referral.phone, "763-555-0101");
  assert.equal(referral.phone_digits, "7635550101");
  assert.equal(referral.address, "123 Main St, Delano, MN 55328");
  assert.equal(referral.note, "Neighbor, big house");
  assert.equal(referral.office_note, "");
  assert.equal(referral.status, "new");
  assert.equal(referral.history.length, 1);
  assert.equal(referral.history[0].status, "new");
  assert.equal(referral.history[0].by, "system");
  assert.equal(referral.reward, null);
  assert.equal(referral.duplicate_of, null);
  assert.deepEqual({ ...referral.rotor, at: "x" }, { delivered: true, status: 201, at: "x" });
  assert.deepEqual(referral.sms, { friend: false, referrer: false, office: false });
  assert.equal(referral.quote_requested_at, null);
  assert.deepEqual(store.json(`idx/referrer/7635550100/${id}`), { id });
  assert.deepEqual(store.json("idx/phone/7635550101"), { id });
});

test("Rotor payload for a referred friend is exact", async () => {
  const out = await postOk(submission());
  const [req] = net.rotor();
  assert.equal(req.url, "https://api.getrotor.com/open-api/leads");
  assert.equal(req.options.method, "POST");
  assert.equal(req.headers["rotor-api-version"], "1.1.0");
  assert.equal(req.headers["x-api-key"], "test-dummy-rotor-key-not-real");
  assert.ok(req.options.signal, "Rotor call carries an abort signal (timeout)");
  assert.deepEqual(req.payload, {
    source: "Referral program",
    tags: ["Referral"],
    name: "Jane Doe",
    phone: "763-555-0101",
    address_street1: "123 Main St, Delano, MN 55328",
    address_state: "MN",
    address_country: "US",
    notes: `Referral code: ${out.code} (referred by Alex Barta, (763) 555-0100)\n`
      + "Offer: $25 off their first service. Alex earns a $50 credit (or a $25 gift card) when they book.\n"
      + "Note from Alex: Neighbor, big house",
  });
  assert.ok(!("service_type" in req.payload), "service_type must be omitted");
});

test("Rotor payload omits empty optional fields", async () => {
  await postOk(submission({ friends: [{ first_name: "Sam", phone: "7635550102" }] }));
  const p = net.rotor()[0].payload;
  assert.equal(p.name, "Sam");
  assert.equal(p.phone, "7635550102");
  for (const k of ["email", "address_street1", "address_state", "address_country", "service_type"])
    assert.ok(!(k in p), `${k} must be omitted when blank`);
  for (const [k, v] of Object.entries(p)) assert.notEqual(v, "", `empty property sent: ${k}`);
  assert.ok(!p.notes.includes("Note from"), "no note line without a note");
});

test("a returning referrer keeps their code; without their token the private link stays private", async () => {
  const first = await postOk(submission());
  // Same phone, no token: anyone who knows the number could send this. The
  // referrals are accepted, but neither the token nor the reward choice
  // is theirs to take.
  const second = await postOk(submission({
    referrer: { phone: "7635550100", reward_pref: "giftcard", last_name: "", email: "someone@else.com" },
    friends: [{ first_name: "Bob", last_name: "Lee", phone: "(763) 555-0102" }],
  }));
  assert.equal(second.code, first.code);
  assert.equal(second.token, null);
  assert.equal(second.status_url, null);
  assert.equal(second.returning, true);
  assert.equal(second.referrer.reward_pref, "credit", "stored preference untouched");
  let referrer = store.json("referrer/7635550100");
  assert.equal(referrer.reward_pref, "credit");
  assert.equal(referrer.email, "alex@example.com", "stored email untouched");
  assert.equal(referrer.token, first.token, "token unchanged");
  assert.equal(referrer.last_name, "Barta", "existing last name is kept");
  // With the token (they came from their tracking link): full access.
  const third = await postOk(submission({
    referrer: { phone: "7635550100", reward_pref: "giftcard" },
    friends: [{ first_name: "Cy", phone: "(763) 555-0103" }],
    extra: { token: first.token.toLowerCase() },
  }));
  assert.equal(third.token, first.token);
  assert.equal(third.status_url, first.status_url);
  assert.equal(third.returning, false);
  assert.equal(third.referrer.reward_pref, "giftcard");
  referrer = store.json("referrer/7635550100");
  assert.equal(referrer.reward_pref, "giftcard");
  assert.equal(store.keys("referrer/").length, 1, "still one referrer record");
  assert.equal(store.keys("code/").length, 1);
  assert.equal(store.keys("token/").length, 1);
  assert.equal(store.keys("idx/referrer/7635550100/").length, 3, "all referrals indexed");
  assert.equal(net.rotor().length, 3);
});

test("a first referrer gets their token and status_url; returning is false", async () => {
  const out = await postOk(submission());
  assert.match(out.token, TOKEN_RE);
  assert.equal(out.returning, false);
  assert.ok(out.status_url.endsWith("?t=" + out.token));
});

test("the same friend twice in one submission collapses to one referral", async () => {
  const out = await postOk(submission({ friends: [
    { first_name: "Jane", last_name: "Doe", phone: "763-555-0101" },
    { first_name: "Janie", phone: "+1 (763) 555-0101" },
    { first_name: "Bob", phone: "7635550102" },
  ] }));
  assert.equal(out.friends.length, 2);
  assert.deepEqual(out.friends.map((f) => f.first_name), ["Jane", "Bob"]);
  assert.equal(net.rotor().length, 2);
  assert.equal(store.keys("referral/").length, 2);
});

test("a friend already referred by someone else is flagged, not sent to Rotor", async () => {
  const first = await postOk(submission());
  const firstId = first.friends[0].id;
  net.requests.length = 0;

  const out = await postOk(submission({
    referrer: { first_name: "Maria", last_name: "Lopez", phone: "7635550200", email: "" },
    friends: [{ first_name: "Jane", last_name: "Doe", phone: "(763) 555-0101" }],
  }));
  assert.equal(out.friends[0].duplicate, true);
  assert.equal(out.friends[0].status, "new", "the referrer sees a normal Sent entry");
  assert.equal(out.delivered, true, "nothing needed delivering");
  assert.equal(net.rotor().length, 0, "duplicate not sent to Rotor");

  const dup = store.json(`referral/${out.friends[0].id}`);
  assert.equal(dup.duplicate_of, firstId);
  assert.equal(dup.referrer_id, "7635550200");
  assert.deepEqual(dup.rotor, { delivered: false, status: null, at: null });
  assert.deepEqual(store.json("idx/phone/7635550101"), { id: firstId }, "phone index keeps the first");
  assert.ok(store.json(`idx/referrer/7635550200/${out.friends[0].id}`), "still listed for its referrer");
});

test("a stale phone index (deleted original) does not flag a duplicate", async () => {
  const first = await postOk(submission());
  store.map.delete(`referral/${first.friends[0].id}`);   // original gone, idx still points at it
  net.requests.length = 0;
  const out = await postOk(submission({
    referrer: { first_name: "Maria", phone: "7635550200" },
    friends: [{ first_name: "Jane", phone: "7635550101" }],
  }));
  assert.equal(out.friends[0].duplicate, false);
  assert.equal(net.rotor().length, 1);
  assert.deepEqual(store.json("idx/phone/7635550101"), { id: out.friends[0].id }, "index re-pointed");
});

test("the token in the body unlocks the private link for a returning referrer", async () => {
  const first = await postOk(submission());
  const out = await postOk(submission({
    friends: [{ first_name: "Bob", phone: "7635550102" }],
    extra: { token: first.token },
  }));
  assert.equal(out.token, first.token);
  assert.equal(out.returning, false);
  assert.equal(out.friends[0].first_name, "Bob");
  // A wrong token is just an untrusted resubmission, never an error.
  const wrong = await postOk(submission({
    friends: [{ first_name: "Cy", phone: "7635550103" }],
    extra: { token: "Z".repeat(24) },
  }));
  assert.equal(wrong.token, null);
  assert.equal(wrong.returning, true);
  assert.equal(wrong.code, first.code);
});

// ---------------------------------------------------------------------------
// degraded modes
// ---------------------------------------------------------------------------
test("store down: still 200 with stored:false, Rotor still gets the lead", async () => {
  useStore(failingStore());
  const res = await post(submission());
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.ok, true);
  assert.equal(out.stored, false);
  assert.equal(out.delivered, true);
  assert.match(out.code, CODE_RE);
  assert.equal(net.rotor().length, 1);
  assert.ok(net.rotor()[0].payload.notes.includes(out.code));
});

test("Rotor 500: still 200 with delivered:false, referral stored with the status", async () => {
  net = mockFetch({ rotor: 500 });
  const res = await post(submission());
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.stored, true);
  assert.equal(out.delivered, false);
  const referral = store.json(`referral/${out.friends[0].id}`);
  assert.equal(referral.rotor.delivered, false);
  assert.equal(referral.rotor.status, 500);
});

test("Rotor unreachable (fetch throws): delivered:false, still stored", async () => {
  net = mockFetch({ rotor: "throw" });
  const out = await postOk(submission());
  assert.equal(out.delivered, false);
  assert.equal(out.stored, true);
  assert.equal(store.json(`referral/${out.friends[0].id}`).rotor.status, null);
});

test("ROTOR_API_KEY unset: delivered:false but the referral is still stored", async () => {
  const saved = process.env.ROTOR_API_KEY;
  delete process.env.ROTOR_API_KEY;
  try {
    const out = await postOk(submission());
    assert.equal(out.delivered, false);
    assert.equal(out.stored, true);
    assert.equal(net.rotor().length, 0);
  } finally {
    process.env.ROTOR_API_KEY = saved;
  }
});

test("store down AND Rotor down: 502 so the page shows the call-us fallback", async () => {
  useStore(failingStore());
  net = mockFetch({ rotor: 500 });
  const res = await post(submission());
  assert.equal(res.status, 502);
  const out = await res.json();
  assert.equal(out.ok, false);
  assert.ok(out.error.length > 0);
});

test("delivered:false when any one of several friends fails at Rotor", async () => {
  net = mockFetch({ rotor: (entry) => (entry.payload.name === "Bob" ? 502 : 201) });
  const out = await postOk(submission({ friends: [
    { first_name: "Jane", phone: "7635550101" }, { first_name: "Bob", phone: "7635550102" },
  ] }));
  assert.equal(out.delivered, false);
  assert.equal(out.stored, true);
  assert.equal(out.friends.length, 2);
});

// ---------------------------------------------------------------------------
// GET ?t=TOKEN — private dashboard
// ---------------------------------------------------------------------------
async function seedDashboard() {
  const out = await postOk(submission({ friends: [
    { first_name: "Jane", last_name: "Doe", phone: "7635550101" },
    { first_name: "Bob", last_name: "Lee", phone: "7635550102" },
    { first_name: "Cy", phone: "7635550103" },
    { first_name: "Dee", last_name: "Kay", phone: "7635550104" },
  ] }));
  const set = (i, patch) => {
    const key = `referral/${out.friends[i].id}`;
    store.map.set(key, JSON.stringify({ ...store.json(key), ...patch }));
  };
  set(0, { status: "rewarded", reward: { type: "credit", amount: 50, issued_at: "2026-09-02T00:00:00.000Z", note: "office only" } });
  set(1, { status: "booked" });
  set(2, { status: "contacted" });
  set(3, { status: "declined" });
  return out;
}

test("GET ?t=: totals math, masked friend names, no friend contact details", async () => {
  const seeded = await seedDashboard();
  const res = await get(`?t=${seeded.token}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const out = await res.json();
  assert.equal(out.ok, true);
  assert.deepEqual(out.referrer, {
    first_name: "Alex", last_name: "Barta", phone: "(763) 555-0100",
    email: "alex@example.com", reward_pref: "credit", code: seeded.code,
  });
  assert.equal(out.share_url, `https://www.bartawindowwashing.com/r/${seeded.code}`);
  assert.deepEqual(out.totals, {
    referred: 4, booked: 2, rewarded: 1, pending: 1, to_choose: 0, credit_earned: 50, gift_cards_earned: 0,
  });
  assert.equal(out.referrals.length, 4);
  const byName = Object.fromEntries(out.referrals.map((r) => [r.friend_name, r]));
  assert.deepEqual(Object.keys(byName).sort(), ["Bob L.", "Cy", "Dee K.", "Jane D."]);
  assert.equal(byName["Jane D."].status, "rewarded");
  assert.deepEqual(byName["Jane D."].reward,
    { type: "credit", amount: 50, chosen_at: null, issued_at: "2026-09-02T00:00:00.000Z" });
  assert.equal(byName["Bob L."].reward, null);
  for (const r of out.referrals) {
    assert.deepEqual(Object.keys(r).sort(),
      ["created_at", "friend_name", "id", "reward", "status", "updated_at"]);
    assert.ok(!JSON.stringify(r).includes("7635550"), "no friend phone number leaks");
  }
});

test("GET ?t=: gift-card rewards count as gift cards, not credit", async () => {
  const seeded = await seedDashboard();
  const key = `referral/${seeded.friends[1].id}`;
  store.map.set(key, JSON.stringify({ ...store.json(key), status: "rewarded",
    reward: { type: "giftcard", amount: 25, issued_at: "2026-09-03T00:00:00.000Z", note: "" } }));
  const out = await (await get(`?t=${seeded.token}`)).json();
  assert.deepEqual(out.totals, {
    referred: 4, booked: 2, rewarded: 2, pending: 1, to_choose: 0, credit_earned: 50, gift_cards_earned: 1,
  });
});

test("GET ?t=: unknown, malformed, and case-variant tokens", async () => {
  const seeded = await seedDashboard();
  assert.equal((await get("?t=K7Q2M9X4P8W3N6R5T2Y7V4B9")).status, 404);
  assert.equal((await get("?t=short")).status, 404);
  assert.equal((await get("?t=")).status, 404);
  const lower = await get(`?t=${seeded.token.toLowerCase()}`);
  assert.equal(lower.status, 200, "tokens are matched case-insensitively");
});

// ---------------------------------------------------------------------------
// GET ?code=CODE — public lookup
// ---------------------------------------------------------------------------
test("GET ?code=: exposes only the referrer's first name and the offer amounts", async () => {
  const seeded = await postOk(submission());
  const res = await get(`?code=${seeded.code}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(await res.json(), {
    ok: true, code: seeded.code, referrer_first_name: "Alex",
    friend_discount: 25, referrer_credit: 50, referrer_gift_card: 25,
  });
});

test("GET ?code=: lookups are case-insensitive and forgive spacing/dash", async () => {
  const seeded = await postOk(submission());
  const tail = seeded.code.slice(6);
  for (const v of [seeded.code.toLowerCase(), `barta${tail.toLowerCase()}`, `BARTA ${tail}`, ` barta - ${tail} `]) {
    const res = await get(`?code=${encodeURIComponent(v)}`);
    assert.equal(res.status, 200, `variant ${JSON.stringify(v)}`);
    assert.equal((await res.json()).code, seeded.code);
  }
});

test("GET ?code=: unknown or malformed codes are 404", async () => {
  await postOk(submission());
  for (const v of ["BARTA-AAAAA", "FALL10", "BARTA-0O1IA", "", "BARTA-7K3XQ2"]) {
    const res = await get(`?code=${encodeURIComponent(v)}`);
    assert.equal(res.status, 404, `code ${JSON.stringify(v)}`);
    assert.equal((await res.json()).ok, false);
  }
});

test("GET without t or code is 400; GET with the store down is 503", async () => {
  assert.equal((await get("")).status, 400);
  useStore(failingStore());
  assert.equal((await get("?code=BARTA-7K3XQ")).status, 503);
  assert.equal((await get("?t=K7Q2M9X4P8W3N6R5T2Y7V4B9")).status, 503);
});

// ---------------------------------------------------------------------------
// POST { action: "choose_reward" } — the referrer picks once a job is complete
// ---------------------------------------------------------------------------
import { FAKE_ENV as ENV, jsonRequest as request } from "./helpers/referral-harness.mjs";
const adminHandler = (await import("../netlify/functions/referral-admin.mjs")).default;
const office = (body) => adminHandler(request("/api/referral/admin", "POST", body,
  { Authorization: `Bearer ${ENV.REFERRAL_ADMIN_KEY}` }));
const choose = (t, id, reward_type) => post({ action: "choose_reward", t, id, reward_type });

test("reward_pref is optional on the form: nothing on file until they pick", async () => {
  const out = await postOk(submission({ referrer: { reward_pref: "" } }));
  assert.deepEqual(out.referrer, { first_name: "Alex", reward_pref: null });
  assert.equal(store.json("referrer/7635550100").reward_pref, null);
});

test("choose_reward: opens when the office marks the job complete, closes when the reward is issued", async () => {
  const seeded = await postOk(submission({ referrer: { reward_pref: "" } }));
  const id = seeded.friends[0].id;
  // Not ready yet: neither new nor booked.
  assert.equal((await choose(seeded.token, id, "giftcard")).status, 409);
  await office({ action: "set_status", id, status: "booked" });
  assert.equal((await choose(seeded.token, id, "giftcard")).status, 409);

  // Job complete: the pick is open and the dashboard says so.
  const done = await (await office({ action: "set_status", id, status: "completed" })).json();
  assert.equal(done.referral.status, "completed");
  assert.ok(done.referral.reward_ready_at);
  assert.deepEqual(done.referral.reward, { type: null, amount: null, chosen_at: null, issued_at: null, note: "" });
  let dash = await (await get(`?t=${seeded.token}`)).json();
  assert.equal(dash.totals.to_choose, 1);
  assert.equal(dash.totals.booked, 1);
  assert.equal(dash.referrals[0].status, "completed");
  assert.deepEqual(dash.referrals[0].reward, { type: null, amount: null, chosen_at: null, issued_at: null });

  // Bad inputs never change anything.
  assert.equal((await choose(seeded.token, id, "cash")).status, 400);
  assert.equal((await choose("Z".repeat(24), id, "giftcard")).status, 404, "unknown token");
  assert.equal((await choose(seeded.token, "r_nope", "giftcard")).status, 404);
  assert.equal((await post({ action: "choose_reward", id, reward_type: "giftcard" })).status, 400, "no token");

  // The pick, from the tracking link (token matched case-insensitively).
  const res = await choose(seeded.token.toLowerCase(), id, "giftcard");
  assert.equal(res.status, 200, await res.clone().text());
  const out = await res.json();
  assert.equal(out.ok, true);
  assert.deepEqual({ ...out.referral.reward, chosen_at: "x" }, { type: "giftcard", amount: 25, chosen_at: "x", issued_at: null });
  const rec = store.json(`referral/${id}`);
  assert.equal(rec.status, "completed", "still the office's turn to issue it");
  assert.equal(rec.history.at(-1).by, "customer");
  assert.equal(rec.history.at(-1).note, "Chose $25 gift card");
  assert.equal(store.json("referrer/7635550100").reward_pref, "giftcard", "becomes the preference on file");
  dash = await (await get(`?t=${seeded.token}`)).json();
  assert.equal(dash.totals.to_choose, 0);
  assert.equal(dash.referrer.reward_pref, "giftcard");

  // Changing their mind before it is issued is fine, and the office's
  // issue_reward then defaults to what they picked.
  assert.equal((await choose(seeded.token, id, "credit")).status, 200);
  assert.equal(store.json(`referral/${id}`).history.at(-1).note, "Changed their pick to $50 credit");
  const issued = await (await office({ action: "issue_reward", id })).json();
  assert.equal(issued.referral.status, "rewarded");
  assert.equal(issued.referral.reward.type, "credit");
  assert.equal(issued.referral.reward.amount, 50);
  assert.ok(issued.referral.reward.chosen_at, "the pick date survives issuing");
  assert.equal((await choose(seeded.token, id, "giftcard")).status, 409, "issued: no more picking");
  dash = await (await get(`?t=${seeded.token}`)).json();
  assert.equal(dash.totals.credit_earned, 50);

  // Another customer's tracking link can't touch it.
  const other = await postOk(submission({ referrer: { phone: "7635550200", first_name: "Maria" },
    friends: [{ first_name: "Cy", phone: "7635550103" }] }));
  assert.equal((await choose(other.token, id, "credit")).status, 404);
});

test("choose_reward: store down answers 503", async () => {
  useStore(failingStore());
  assert.equal((await choose("A".repeat(24), "r_1", "credit")).status, 503);
});
