// Unit tests for the pure helpers in netlify/lib (no store, no network).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  REWARDS, SMS, STATUSES, siteUrl, shareUrl, statusUrl, adminUrl, rewardAmount, rewardLabel,
} from "../netlify/lib/referral-config.mjs";
import {
  CODE_ALPHABET, clean, normalizePhone, normalizeCode, normalizeToken, newCode, newToken,
  newReferralId, maskedName, lastInitial, validateSubmission, ValidationError, buildReferral,
  buildReferrer, dashboardTotals, adminStats, csvCell, toCSV, safeEqual, withTimeout,
  TimeoutError, matchesQuery, safeErr, mapLimit,
} from "../netlify/lib/referral-lib.mjs";
import { rotorLeadPayload, e164, smsMode } from "../netlify/lib/referral-notify.mjs";
import { submission } from "./helpers/referral-harness.mjs";

test("REWARDS mirrors build/sitedata.py REFERRAL", async () => {
  assert.deepEqual({ ...REWARDS }, {
    friend_discount: 25, referrer_credit: 50, referrer_gift_card: 25,
    code_prefix: "BARTA", max_friends: 10,
  });
  assert.equal(rewardAmount("credit"), 50);
  assert.equal(rewardAmount("giftcard"), 25);
  assert.equal(rewardLabel("credit"), "$50 credit");
  assert.equal(rewardLabel("giftcard"), "$25 gift card");
  assert.deepEqual([...STATUSES], ["new", "contacted", "quoted", "booked", "completed", "rewarded", "declined"]);
});

test("site URLs default and strip trailing slashes", () => {
  delete process.env.SITE_URL;
  assert.equal(siteUrl(), "https://www.bartawindowwashing.com", "the website is the default");
  // On Netlify the URL variable is the site's primary URL, so links come out
  // right on any *.netlify.app or custom domain without configuration.
  process.env.URL = "https://barta-referrals.netlify.app/";
  assert.equal(siteUrl(), "https://barta-referrals.netlify.app");
  delete process.env.URL;
  process.env.SITE_URL = "https://preview.example.com/";
  assert.equal(shareUrl("BARTA-7K3XQ"), "https://preview.example.com/r/BARTA-7K3XQ");
  assert.equal(statusUrl("TOKEN"), "https://preview.example.com/referral?t=TOKEN");
  assert.equal(adminUrl(), "https://preview.example.com/admin/referrals.html");
  delete process.env.SITE_URL;
});

test("SMS templates match docs/REFERRAL-PROGRAM.md verbatim", () => {
  assert.equal(SMS.friend({ friend_first: "Jane", referrer_first: "Alex", referrer_last_initial: "B",
    share_url: "https://www.bartawindowwashing.com/r/BARTA-7K3XQ" }),
    "Hi Jane! Alex B. referred you to Barta Window Washing, so your first service is $25 off. "
    + "Claim it here: https://www.bartawindowwashing.com/r/BARTA-7K3XQ or call (763) 314-3400. Reply STOP to opt out.");
  assert.equal(SMS.referrer({ n: 2, status_url: "https://www.bartawindowwashing.com/referral?t=T" }),
    "Thanks for referring 2 friend(s) to Barta Window Washing! You earn a $50 credit (or a $25 gift card) "
    + "for each one who books. Track your referrals: https://www.bartawindowwashing.com/referral?t=T");
  assert.equal(SMS.rewardReady({ friend_first: "Jane", status_url: "https://www.bartawindowwashing.com/referral?t=T" }),
    "Great news from Barta Window Washing: Jane's first service is complete, so your reward is ready! "
    + "Pick a $50 account credit or a $25 gift card here: https://www.bartawindowwashing.com/referral?t=T");
  assert.equal(SMS.reward({ friend_first: "Jane", reward: "$50 credit" }),
    "Great news from Barta Window Washing: your $50 credit for referring Jane has been issued. Thanks for spreading the word!");
  assert.equal(SMS.office({ referrer_name: "Alex Barta", referrer_phone: "(763) 555-0100",
    friend_name: "Jane Doe", friend_phone: "763-555-0101", code: "BARTA-7K3XQ",
    site: "https://www.bartawindowwashing.com" }),
    "New referral: Alex Barta ((763) 555-0100) referred Jane Doe (763-555-0101). Code BARTA-7K3XQ. "
    + "https://www.bartawindowwashing.com/admin/referrals.html");
});

test("clean(): trims, normalizes newlines, strips control characters, never truncates", () => {
  assert.equal(clean("  a\r\nb\rc\u0001d "), "a\nb\ncd");
  assert.equal(clean("tab\tkept"), "tab\tkept");
  assert.equal(clean(123), "");
  assert.equal(clean(null), "");
  assert.equal(clean("x".repeat(5000)).length, 5000);
});

test("normalizePhone(): 10 US digits, leading 1 stripped, junk rejected", () => {
  assert.equal(normalizePhone("(763) 555-0100"), "7635550100");
  assert.equal(normalizePhone("+1 763 555 0100"), "7635550100");
  assert.equal(normalizePhone("17635550100"), "7635550100");
  assert.equal(normalizePhone("763.555.0100"), "7635550100");
  assert.equal(normalizePhone("555-0100"), "");
  assert.equal(normalizePhone("0635550100"), "", "area code cannot start with 0");
  assert.equal(normalizePhone("1635550100"), "", "area code cannot start with 1");
  assert.equal(normalizePhone("+44 20 7946 0958"), "");
  assert.equal(normalizePhone(""), "");
  assert.equal(normalizePhone(undefined), "");
});

test("normalizeCode(): case/spacing/dash tolerant, rejects non-referral promo codes", () => {
  for (const v of ["BARTA-7K3XQ", "barta-7k3xq", "barta7k3xq", "BARTA 7K3XQ", " Barta - 7k3xq ", "BARTA–7K3XQ"])
    assert.equal(normalizeCode(v), "BARTA-7K3XQ", JSON.stringify(v));
  for (const v of ["FALL10", "BARTA-7K3X", "BARTA-7K3XQ2", "BARTA-0O1IA", "7K3XQ", "", null, "BARTB-7K3XQ"])
    assert.equal(normalizeCode(v), "", JSON.stringify(v));
});

test("normalizeToken(): 24 chars of the code alphabet, case-insensitive", () => {
  assert.equal(normalizeToken("k7q2m9x4p8w3n6r5t2y7v4b9"), "K7Q2M9X4P8W3N6R5T2Y7V4B9");
  assert.equal(normalizeToken("K7Q2M9X4P8W3N6R5T2Y7V4B"), "");
  assert.equal(normalizeToken("K7Q2M9X4P8W3N6R5T2Y7V4B0"), "", "0 is not in the alphabet");
  assert.equal(normalizeToken(""), "");
});

test("code/token/id generation uses the spec alphabet and shapes", () => {
  assert.equal(CODE_ALPHABET, "ABCDEFGHJKLMNPQRSTUVWXYZ23456789");
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const code = newCode();
    assert.match(code, /^BARTA-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/);
    seen.add(code);
    assert.match(newToken(), /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{24}$/);
  }
  assert.ok(seen.size > 190, "codes are random");
  const id = newReferralId(1725235200000);
  assert.match(id, /^r_[0-9a-z]+$/);
  assert.ok(id.startsWith("r_" + (1725235200000).toString(36)));
  assert.equal(id.length, "r_".length + (1725235200000).toString(36).length + 6);
});

test("name helpers", () => {
  assert.equal(maskedName("Jane", "Doe"), "Jane D.");
  assert.equal(maskedName("Jane", ""), "Jane");
  assert.equal(maskedName("Jane", " de la Cruz"), "Jane D.");
  assert.equal(lastInitial("barta"), "B");
  assert.equal(lastInitial(""), "");
});

test("validateSubmission(): normalizes and collapses in-submission duplicates", () => {
  const out = validateSubmission(submission({
    referrer: { reward_pref: " Credit ", email: " alex@example.com " },
    friends: [
      { first_name: " Jane ", last_name: "Doe", phone: "763-555-0101", note: "a\r\nb" },
      { first_name: "Janie", phone: "(763) 555-0101" },
      { first_name: "Bob", phone: "7635550102", email: "" },
    ],
    extra: { token: "k7q2m9x4p8w3n6r5t2y7v4b9", page: "/refer.html" },
  }));
  assert.equal(out.referrer.digits, "7635550100");
  assert.equal(out.referrer.reward_pref, "credit");
  assert.equal(out.referrer.email, "alex@example.com");
  assert.equal(out.friends.length, 2);
  assert.equal(out.friends[0].first_name, "Jane");
  assert.equal(out.friends[0].note, "a\nb");
  assert.equal(out.friends[0].digits, "7635550101");
  assert.equal(out.friends[1].first_name, "Bob");
  assert.equal(out.token, "K7Q2M9X4P8W3N6R5T2Y7V4B9");
  assert.equal(out.page, "/refer.html");
});

test("validateSubmission(): exactly max_friends is fine, one more is not", () => {
  const friends = (n) => Array.from({ length: n }, (_, i) => ({ first_name: "F" + i, phone: "763555" + (1000 + i) }));
  assert.equal(validateSubmission(submission({ friends: friends(10) })).friends.length, 10);
  assert.throws(() => validateSubmission(submission({ friends: friends(11) })),
    (e) => e instanceof ValidationError && e.field === "friends");
  assert.throws(() => validateSubmission(null), ValidationError);
  assert.throws(() => validateSubmission([]), ValidationError);
  assert.throws(() => validateSubmission({ friends: [] }), (e) => e.field === "referrer");
});

test("record builders produce the contract shapes", () => {
  const now = "2026-09-01T12:00:00.000Z";
  const sub = validateSubmission(submission());
  const referrer = buildReferrer({ referrer: sub.referrer, code: "BARTA-7K3XQ", token: "T".repeat(24), page: "/refer.html", now });
  assert.deepEqual(Object.keys(referrer).sort(), ["code", "consent_at", "created_at", "email", "first_name", "id",
    "last_name", "phone", "phone_digits", "reward_pref", "source_page", "token", "updated_at"]);
  assert.equal(referrer.id, "7635550100");
  const referral = buildReferral({ id: "r_1", referrer, friend: sub.friends[0], duplicateOf: null,
    rotor: { delivered: true, status: 201, at: now }, now });
  assert.deepEqual(Object.keys(referral).sort(), ["address", "code", "created_at", "duplicate_of", "email",
    "first_name", "history", "id", "last_name", "note", "office_note", "phone", "phone_digits",
    "quote_requested_at", "referrer_id", "referrer_name", "referrer_phone", "reward", "reward_ready_at",
    "rotor", "sms", "status", "updated_at"]);
  assert.equal(referral.status, "new");
  assert.deepEqual(referral.history, [{ status: "new", at: now, by: "system", note: "Referral received" }]);
  const dup = buildReferral({ id: "r_2", referrer, friend: sub.friends[0], duplicateOf: "r_1",
    rotor: { delivered: false, status: null, at: null }, now });
  assert.equal(dup.duplicate_of, "r_1");
  assert.equal(dup.history[0].note, "Duplicate of r_1");
  assert.deepEqual(dup.rotor, { delivered: false, status: null, at: null });
});

test("dashboardTotals() and adminStats()", () => {
  const rs = [
    { status: "new" }, { status: "contacted" }, { status: "quoted" }, { status: "booked" },
    { status: "rewarded", reward: { type: "credit", amount: 50 } },
    { status: "rewarded", reward: { type: "giftcard", amount: 25 } },
    { status: "declined" },
    { status: "booked", reward: { type: "credit", amount: 50 } },   // stale reward, not rewarded → not counted
    { status: "completed", reward: { type: null, amount: null } },  // job done, pick still open
    { status: "completed", reward: { type: "giftcard", amount: 25, chosen_at: "x" } },  // picked, not issued
  ];
  assert.deepEqual(dashboardTotals(rs), { referred: 10, booked: 6, rewarded: 2, pending: 3, to_choose: 1, credit_earned: 50, gift_cards_earned: 1 });
  assert.deepEqual(adminStats(rs), {
    total: 10,
    by_status: { new: 1, contacted: 1, quoted: 1, booked: 2, completed: 2, rewarded: 2, declined: 1 },
    rewards_owed: 2, credit_issued: 50, gift_cards_issued: 1,
  });
  assert.deepEqual(dashboardTotals([]), { referred: 0, booked: 0, rewarded: 0, pending: 0, to_choose: 0, credit_earned: 0, gift_cards_earned: 0 });
});

test("matchesQuery()", () => {
  const r = { first_name: "Jane", last_name: "Doe", phone: "(763) 555-0101", phone_digits: "7635550101",
    email: "jane@example.com", referrer_name: "Alex Barta", referrer_phone: "(763) 555-0100", code: "BARTA-7K3XQ" };
  assert.ok(matchesQuery(r, ""));
  assert.ok(matchesQuery(r, "jane"));
  assert.ok(matchesQuery(r, "DOE"));
  assert.ok(matchesQuery(r, "555-0101"));
  assert.ok(matchesQuery(r, "(763) 555-0100"), "referrer phone digits");
  assert.ok(matchesQuery(r, "barta-7k3xq"));
  assert.ok(matchesQuery(r, "example.com"));
  assert.ok(!matchesQuery(r, "bob"));
  assert.ok(!matchesQuery(r, "9999"));
});

test("csvCell()/toCSV(): RFC 4180 quoting and formula neutralization", () => {
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(undefined), "");
  assert.equal(csvCell(42), "42");
  assert.equal(csvCell(true), "true");
  assert.equal(csvCell("a,b"), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell("line1\nline2"), '"line1\nline2"');
  assert.equal(csvCell("=SUM(A1)"), "'=SUM(A1)");
  assert.equal(csvCell("@cmd"), "'@cmd");
  assert.equal(csvCell("-1+1"), "'-1+1");
  assert.equal(csvCell("+1 (763) 555-0100"), "+1 (763) 555-0100", "phone numbers are not mangled");
  assert.equal(csvCell("-5"), "-5", "plain negatives are numbers");
  const csv = toCSV([{ id: "r_1", status: "new", note: "a,b", reward: null, rotor: { delivered: true, status: 201 } }]);
  const [header, row] = csv.split("\r\n");
  assert.equal(header.split(",").length, 25);
  assert.ok(row.includes('"a,b"'));
  assert.ok(csv.endsWith("\r\n"));
});

test("safeEqual(): constant-time compare works for any lengths", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
  assert.equal(safeEqual("", ""), true);
  assert.equal(safeEqual(undefined, ""), true);
  assert.equal(safeEqual("x", undefined), false);
});

test("withTimeout(): resolves fast work, rejects slow work with TimeoutError", async () => {
  assert.equal(await withTimeout(async () => 7, 100), 7);
  assert.equal(await withTimeout(Promise.resolve("p"), 100), "p");
  await assert.rejects(withTimeout(() => new Promise(() => {}), 20, "slow"),
    (e) => e instanceof TimeoutError && e.message === "slow timed out");
  await assert.rejects(withTimeout(() => { throw new Error("sync boom"); }, 100), /sync boom/);
});

test("mapLimit(): preserves order and bounds concurrency", async () => {
  let active = 0, peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    active++; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 2));
    active--;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14]);
  assert.ok(peak <= 3 && peak >= 2, `peak ${peak}`);
  assert.deepEqual(await mapLimit([], 4, async (x) => x), []);
});

test("safeErr(): masks digit runs that could be phone numbers", () => {
  assert.equal(safeErr(new Error("key idx/phone/7635550101 missing")), "Error: key idx/phone/#### missing");
  assert.equal(safeErr({ name: "TypeError" }), "TypeError");
  assert.equal(safeErr(null), "Error");
});

// The notes ARE the message the office sends the friend — nothing else — so
// the friend's discount is the only amount they carry. The referrer's two
// amounts are quoted to the referrer instead; guard them where they live.
test("every dollar amount the office sends out comes from REWARDS", () => {
  const sub = validateSubmission(submission());
  const referrer = buildReferrer({ referrer: sub.referrer, code: "BARTA-7K3XQ", token: "T".repeat(24), page: "", now: "x" });
  const p = rotorLeadPayload({ referrer, friend: sub.friends[0], code: "BARTA-7K3XQ" });
  assert.ok(p.notes.includes(`$${REWARDS.friend_discount} off`));
  assert.ok(p.notes.length <= 2000);
  // A referrer note is the office's, not the friend's: it never rides along.
  const long = rotorLeadPayload({ referrer, friend: { ...sub.friends[0], note: "n".repeat(500) }, code: "BARTA-7K3XQ" });
  assert.equal(long.notes, p.notes);
  assert.ok(long.notes.length <= 2000);

  const toReferrer = SMS.referrer({ n: 1, status_url: "https://x/referral?t=T" });
  assert.ok(toReferrer.includes(`$${REWARDS.referrer_credit} credit`));
  assert.ok(toReferrer.includes(`$${REWARDS.referrer_gift_card} gift card`));
  const ready = SMS.rewardReady({ friend_first: "Jane", status_url: "https://x/referral?t=T" });
  assert.ok(ready.includes(`$${REWARDS.referrer_credit} account credit`));
  assert.ok(ready.includes(`$${REWARDS.referrer_gift_card} gift card`));
});

test("e164() and smsMode()", () => {
  assert.equal(e164("7635550101"), "+17635550101");
  assert.equal(e164("+1 (763) 555-0101"), "+17635550101");
  assert.equal(e164("17635550101"), "+17635550101");
  assert.equal(e164(""), "");
  for (const [v, m] of [["off", "off"], ["OFFICE", "office"], [" all ", "all"], ["weird", "off"], ["", "off"]]) {
    process.env.REFERRAL_SMS_MODE = v;
    assert.equal(smsMode(), m, JSON.stringify(v));
  }
  delete process.env.REFERRAL_SMS_MODE;
  assert.equal(smsMode(), "off");
});
