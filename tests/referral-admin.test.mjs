// Mocked tests for /api/referral/admin (auth, list/filters/CSV, actions).
// Referrals are seeded through the public /api/referral handler so the two
// functions are exercised against the same in-memory store.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  setEnv, FAKE_ENV, createMemoryStore, failingStore, useStore, mockFetch, jsonRequest, submission,
} from "./helpers/referral-harness.mjs";

setEnv({ REFERRAL_SMS_MODE: "off" });
const publicHandler = (await import("../netlify/functions/referral.mjs")).default;
const admin = (await import("../netlify/functions/referral-admin.mjs")).default;

const AUTH = { Authorization: `Bearer ${FAKE_ENV.REFERRAL_ADMIN_KEY}` };
const ADMIN_URL = "/api/referral/admin";

let store, net;
beforeEach(() => {
  store = useStore(createMemoryStore());
  net = mockFetch();
});

const adminGet = (query = "", headers = AUTH) =>
  admin(new Request("http://localhost" + ADMIN_URL + query, { headers }));
const adminPost = (body, headers = AUTH) => admin(jsonRequest(ADMIN_URL, "POST", body, headers));
const seed = async (overrides) => {
  const res = await publicHandler(jsonRequest("/api/referral", "POST", submission(overrides)));
  assert.equal(res.status, 200);
  return res.json();
};
const ok = async (res, status = 200) => {
  assert.equal(res.status, status, await res.clone().text());
  return res.json();
};

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------
test("503 when REFERRAL_ADMIN_KEY is not configured (even with a key sent)", async () => {
  const saved = process.env.REFERRAL_ADMIN_KEY;
  delete process.env.REFERRAL_ADMIN_KEY;
  try {
    const res = await adminGet();
    assert.equal(res.status, 503);
    assert.equal((await res.json()).ok, false);
  } finally {
    process.env.REFERRAL_ADMIN_KEY = saved;
  }
});

test("401 for a missing, malformed, or wrong key; correct key passes", async () => {
  for (const headers of [{}, { Authorization: "Basic abc" }, { Authorization: "Bearer" },
    { Authorization: "Bearer wrong-key" },
    { Authorization: `Bearer ${FAKE_ENV.REFERRAL_ADMIN_KEY}x` },
    { Authorization: `Bearer ${FAKE_ENV.REFERRAL_ADMIN_KEY.slice(0, -1)}` }]) {
    const res = await adminGet("", headers);
    assert.equal(res.status, 401, JSON.stringify(headers));
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal((await res.json()).ok, false);
  }
  assert.equal((await adminGet()).status, 200);
  assert.equal((await adminGet("", { authorization: `bearer ${FAKE_ENV.REFERRAL_ADMIN_KEY}` })).status,
    200, "scheme is case-insensitive");
});

test("405 for other methods once authorized", async () => {
  const res = await admin(new Request("http://localhost" + ADMIN_URL, { method: "PUT", headers: AUTH }));
  assert.equal(res.status, 405);
});

test("503 when the store is unavailable", async () => {
  useStore(failingStore());
  assert.equal((await adminGet()).status, 503);
  assert.equal((await adminPost({ action: "set_note", id: "r_x", note: "hi" })).status, 503);
});

// ---------------------------------------------------------------------------
// GET list
// ---------------------------------------------------------------------------
test("empty dashboard: zero-filled stats and empty lists", async () => {
  const out = await ok(await adminGet());
  assert.deepEqual(out, {
    ok: true,
    stats: { total: 0, by_status: { new: 0, contacted: 0, quoted: 0, booked: 0, completed: 0, rewarded: 0, declined: 0 },
             rewards_owed: 0, credit_issued: 0, gift_cards_issued: 0 },
    referrals: [],
    referrers: [],
  });
});

test("list: full records newest first, referrers with counts and no token", async () => {
  const a = await seed({ friends: [
    { first_name: "Jane", last_name: "Doe", phone: "7635550101" },
    { first_name: "Bob", last_name: "Lee", phone: "7635550102" },
  ] });
  // Make the second referrer's referral clearly newer.
  await new Promise((r) => setTimeout(r, 5));
  const b = await seed({ referrer: { first_name: "Maria", last_name: "Lopez", phone: "7635550200", reward_pref: "giftcard" },
    friends: [{ first_name: "Cy", phone: "7635550103" }] });

  const out = await ok(await adminGet());
  assert.equal(out.stats.total, 3);
  assert.equal(out.stats.by_status.new, 3);
  assert.equal(out.referrals.length, 3);
  assert.equal(out.referrals[0].first_name, "Cy", "newest first");
  for (let i = 1; i < out.referrals.length; i++)
    assert.ok(out.referrals[i - 1].created_at >= out.referrals[i].created_at);
  // Full record: the office sees everything about the referral.
  const jane = out.referrals.find((r) => r.first_name === "Jane");
  assert.equal(jane.phone, "7635550101");
  assert.equal(jane.referrer_name, "Alex Barta");
  assert.equal(jane.code, a.code);
  assert.ok(Array.isArray(jane.history));

  assert.equal(out.referrers.length, 2);
  const alex = out.referrers.find((p) => p.id === "7635550100");
  assert.deepEqual({ ...alex, created_at: "x", updated_at: "x" }, {
    id: "7635550100", code: a.code, status_url: a.status_url, first_name: "Alex", last_name: "Barta",
    phone: "(763) 555-0100", email: "alex@example.com", reward_pref: "credit",
    created_at: "x", updated_at: "x", referred: 2, booked: 0, rewarded: 0,
  });
  const maria = out.referrers.find((p) => p.id === "7635550200");
  assert.equal(maria.code, b.code);
  assert.equal(maria.referred, 1);
  // The office gets each customer's tracking link ready to resend, but never
  // the bare token as a field of its own.
  assert.equal(maria.status_url, b.status_url);
  assert.ok(maria.status_url.endsWith("?t=" + store.json("referrer/7635550200").token));
  for (const p of out.referrers) assert.ok(!("token" in p), "private token must not be exposed");
});

test("list filters: ?status= and ?q= (name, phone digits, code); stats stay global", async () => {
  const a = await seed({ friends: [
    { first_name: "Jane", last_name: "Doe", phone: "(763) 555-0101" },
    { first_name: "Bob", last_name: "Lee", phone: "7635550102" },
  ] });
  const all = await ok(await adminGet());
  const jane = all.referrals.find((r) => r.first_name === "Jane");
  await ok(await adminPost({ action: "set_status", id: jane.id, status: "contacted" }));

  let out = await ok(await adminGet("?status=contacted"));
  assert.deepEqual(out.referrals.map((r) => r.first_name), ["Jane"]);
  assert.equal(out.stats.total, 2, "stats are not filtered");
  assert.equal(out.stats.by_status.contacted, 1);
  assert.equal(out.stats.by_status.new, 1);

  out = await ok(await adminGet("?status=new"));
  assert.deepEqual(out.referrals.map((r) => r.first_name), ["Bob"]);
  out = await ok(await adminGet("?status=bogus"));
  assert.equal(out.referrals.length, 2, "unknown status means no filter");

  out = await ok(await adminGet("?q=JANE"));
  assert.deepEqual(out.referrals.map((r) => r.first_name), ["Jane"]);
  out = await ok(await adminGet("?q=" + encodeURIComponent("555-0102")));
  assert.deepEqual(out.referrals.map((r) => r.first_name), ["Bob"], "digits match phone");
  out = await ok(await adminGet("?q=" + encodeURIComponent(a.code.toLowerCase())));
  assert.equal(out.referrals.length, 2, "code matches both of the referrer's friends");
  out = await ok(await adminGet("?q=barta"));
  assert.equal(out.referrals.length, 2, "referrer name matches");
  out = await ok(await adminGet("?q=nobody"));
  assert.equal(out.referrals.length, 0);
  out = await ok(await adminGet("?status=new&q=bob"));
  assert.deepEqual(out.referrals.map((r) => r.first_name), ["Bob"]);
});

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------
test("CSV export: content type, header row, one row per referral, escaping", async () => {
  await seed({ friends: [
    { first_name: "Jane", last_name: "Doe", phone: "7635550101", address: "123 Main St, Delano, MN",
      note: 'He said "hi", then left' },
    { first_name: "Bob", phone: "7635550102", note: "=SUM(A1:A9)" },
  ] });
  const res = await adminGet("?format=csv");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^text\/csv/);
  assert.match(res.headers.get("content-disposition"), /attachment; filename="referrals-\d{4}-\d{2}-\d{2}\.csv"/);
  assert.equal(res.headers.get("cache-control"), "no-store");
  // text() strips a leading BOM while decoding, so check the bytes.
  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xEF, 0xBB, 0xBF], "UTF-8 BOM for Excel");
  const text = new TextDecoder().decode(bytes);
  const lines = text.trimEnd().split("\r\n");
  assert.equal(lines.length, 3, "header + 2 rows");
  assert.ok(lines[0].startsWith("id,created_at,updated_at,status,duplicate_of,friend_first_name,"));
  assert.ok(text.includes('"123 Main St, Delano, MN"'), "comma field quoted");
  assert.ok(text.includes('"He said ""hi"", then left"'), "quotes doubled and quoted");
  assert.ok(text.includes("'=SUM(A1:A9)"), "formula-looking field neutralized");
  // Every row has the same number of columns as the header.
  const count = (line) => (line.match(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/g) || []).length;
  for (const l of lines) assert.equal(count(l), count(lines[0]));
});

test("CSV export ignores status/q filters (it is the full backup)", async () => {
  await seed({ friends: [{ first_name: "Jane", phone: "7635550101" }, { first_name: "Bob", phone: "7635550102" }] });
  const text = await (await adminGet("?format=csv&q=jane&status=declined")).text();
  assert.equal(text.trimEnd().split("\r\n").length, 3);
});

// ---------------------------------------------------------------------------
// POST actions
// ---------------------------------------------------------------------------
test("set_status: status + history by office, note kept, quoted stamps quote_requested_at", async () => {
  const s = await seed();
  const id = s.friends[0].id;
  let out = await ok(await adminPost({ action: "set_status", id, status: "contacted", note: "Left voicemail" }));
  assert.equal(out.ok, true);
  assert.equal(out.referral.id, id);
  assert.equal(out.referral.status, "contacted");
  assert.equal(out.referral.history.length, 2);
  assert.deepEqual({ ...out.referral.history[1], at: "x" },
    { status: "contacted", at: "x", by: "office", note: "Left voicemail" });
  // Both are ISO strings at millisecond resolution, so a seed and a status
  // change in the same millisecond legitimately produce equal stamps.
  assert.ok(out.referral.updated_at >= out.referral.created_at);
  assert.equal(store.json(`referral/${id}`).status, "contacted", "persisted");

  out = await ok(await adminPost({ action: "set_status", id, status: "QUOTED" }));
  assert.equal(out.referral.status, "quoted");
  assert.ok(out.referral.quote_requested_at, "quoted stamps quote_requested_at");
  assert.equal(out.referral.history[2].note, "");
});

test("set_status: rewarded is refused, unknown status/id are errors", async () => {
  const s = await seed();
  const id = s.friends[0].id;
  let res = await adminPost({ action: "set_status", id, status: "rewarded" });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).field, "status");
  res = await adminPost({ action: "set_status", id, status: "paid" });
  assert.equal(res.status, 400);
  res = await adminPost({ action: "set_status", id: "r_nope", status: "booked" });
  assert.equal(res.status, 404);
  res = await adminPost({ action: "set_status", status: "booked" });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).field, "id");
});

test("issue_reward: amount from REWARDS, status rewarded, history; refuses to pay twice", async () => {
  const s = await seed({ friends: [
    { first_name: "Jane", phone: "7635550101" }, { first_name: "Bob", phone: "7635550102" },
  ] });
  const [jane, bob] = s.friends.map((f) => f.id);
  await ok(await adminPost({ action: "set_status", id: jane, status: "booked" }));

  let out = await ok(await adminPost({ action: "issue_reward", id: jane, reward_type: "credit", note: "Applied in Rotor 9/3" }));
  assert.equal(out.referral.status, "rewarded");
  assert.deepEqual({ ...out.referral.reward, issued_at: "x" },
    { type: "credit", amount: 50, chosen_at: null, issued_at: "x", note: "Applied in Rotor 9/3" });
  assert.ok(out.referral.reward.issued_at);
  const last = out.referral.history.at(-1);
  assert.equal(last.status, "rewarded");
  assert.equal(last.by, "office");
  assert.ok(last.note.includes("$50 credit") && last.note.includes("Applied in Rotor 9/3"));

  out = await ok(await adminPost({ action: "issue_reward", id: bob, reward_type: "giftcard" }));
  assert.equal(out.referral.reward.type, "giftcard");
  assert.equal(out.referral.reward.amount, 25);
  assert.equal(out.referral.reward.note, "");

  const again = await adminPost({ action: "issue_reward", id: jane, reward_type: "giftcard" });
  assert.equal(again.status, 409, "already rewarded");
  assert.equal(store.json(`referral/${jane}`).reward.type, "credit", "unchanged");

  const bad = await adminPost({ action: "issue_reward", id: jane, reward_type: "cash" });
  assert.equal(bad.status, 400);

  const stats = (await ok(await adminGet())).stats;
  assert.equal(stats.by_status.rewarded, 2);
  assert.equal(stats.rewards_owed, 0);
  assert.equal(stats.credit_issued, 50);
  assert.equal(stats.gift_cards_issued, 1);
  const alex = (await ok(await adminGet())).referrers[0];
  assert.equal(alex.booked, 2);
  assert.equal(alex.rewarded, 2);
});

test("issue_reward without reward_type uses the referrer's preference", async () => {
  const s = await seed({ referrer: { reward_pref: "giftcard" } });
  const out = await ok(await adminPost({ action: "issue_reward", id: s.friends[0].id }));
  assert.equal(out.referral.reward.type, "giftcard");
  assert.equal(out.referral.reward.amount, 25);
});

test("moving a rewarded referral back clears the reward so totals stay honest", async () => {
  const s = await seed();
  const id = s.friends[0].id;
  await ok(await adminPost({ action: "issue_reward", id, reward_type: "credit" }));
  const out = await ok(await adminPost({ action: "set_status", id, status: "completed", note: "Issued by mistake" }));
  assert.equal(out.referral.status, "completed");
  assert.deepEqual(out.referral.reward, { type: null, amount: null, chosen_at: null, issued_at: null, note: "" },
    "back to completed: the reward is owed again and the pick is open");
  const stats = (await ok(await adminGet())).stats;
  assert.equal(stats.credit_issued, 0);
  assert.equal(stats.rewards_owed, 1);
  // ...and it can be issued again afterwards.
  const again = await ok(await adminPost({ action: "issue_reward", id, reward_type: "giftcard" }));
  assert.equal(again.referral.reward.amount, 25);
});

test("set_note: office-only note, no history entry", async () => {
  const s = await seed();
  const id = s.friends[0].id;
  const out = await ok(await adminPost({ action: "set_note", id, note: "Office-only note" }));
  assert.equal(out.referral.office_note, "Office-only note");
  assert.equal(out.referral.history.length, 1);
  assert.equal(store.json(`referral/${id}`).office_note, "Office-only note");
  const long = await adminPost({ action: "set_note", id, note: "x".repeat(1001) });
  assert.equal(long.status, 400);
});

test("set_reward_pref: updates the referrer, response omits the token", async () => {
  await seed();
  const out = await ok(await adminPost({ action: "set_reward_pref", referrer_id: "7635550100", reward_pref: "giftcard" }));
  assert.equal(out.ok, true);
  assert.equal(out.referrer.id, "7635550100");
  assert.equal(out.referrer.reward_pref, "giftcard");
  assert.ok(!("token" in out.referrer));
  assert.equal(store.json("referrer/7635550100").reward_pref, "giftcard");
  assert.ok(store.json("referrer/7635550100").token, "token still stored");

  assert.equal((await adminPost({ action: "set_reward_pref", referrer_id: "7635550100", reward_pref: "cash" })).status, 400);
  assert.equal((await adminPost({ action: "set_reward_pref", referrer_id: "7635559999", reward_pref: "credit" })).status, 404);
  // Formatted phone as referrer_id is normalized to digits.
  assert.equal((await adminPost({ action: "set_reward_pref", referrer_id: "(763) 555-0100", reward_pref: "credit" })).status, 200);
});

test("delete: removes the record and its indexes; duplicates keep pointing", async () => {
  const s = await seed();
  const id = s.friends[0].id;
  const dup = await seed({ referrer: { first_name: "Maria", phone: "7635550200" },
    friends: [{ first_name: "Jane", phone: "7635550101" }] });
  const dupId = dup.friends[0].id;

  // Deleting the duplicate must not release the original's phone index.
  let out = await ok(await adminPost({ action: "delete", id: dupId }));
  assert.deepEqual(out, { ok: true, deleted: dupId });
  assert.equal(store.json(`referral/${dupId}`), null);
  assert.equal(store.json(`idx/referrer/7635550200/${dupId}`), null);
  assert.deepEqual(store.json("idx/phone/7635550101"), { id }, "original still indexed");

  out = await ok(await adminPost({ action: "delete", id }));
  assert.equal(out.deleted, id);
  assert.equal(store.json(`referral/${id}`), null);
  assert.equal(store.json(`idx/referrer/7635550100/${id}`), null);
  assert.equal(store.json("idx/phone/7635550101"), null, "phone index released");
  assert.equal((await ok(await adminGet())).referrals.length, 0);
  assert.equal((await adminPost({ action: "delete", id })).status, 404);
});

test("unknown action / invalid body are 400", async () => {
  let res = await adminPost({ action: "explode", id: "r_x" });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).field, "action");
  res = await admin(new Request("http://localhost" + ADMIN_URL, { method: "POST", headers: AUTH, body: "nope" }));
  assert.equal(res.status, 400);
});
