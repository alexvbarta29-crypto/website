// Twilio behaviour of /api/referral per REFERRAL_SMS_MODE (off | office |
// all). fetch is stubbed, so the "Twilio" requests are only captured and
// inspected — the credentials below are placeholders.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  setEnv, FAKE_ENV, createMemoryStore, failingStore, useStore, mockFetch, jsonRequest, submission,
} from "./helpers/referral-harness.mjs";

setEnv({ REFERRAL_SMS_MODE: "off" });
const handler = (await import("../netlify/functions/referral.mjs")).default;

let store, net;
beforeEach(() => {
  setEnv({ REFERRAL_SMS_MODE: "off" });
  store = useStore(createMemoryStore());
  net = mockFetch();
});

const post = async (body) => {
  const res = await handler(jsonRequest("/api/referral", "POST", body));
  assert.equal(res.status, 200, await res.clone().text());
  return res.json();
};
const record = (out, i = 0) => store.json(`referral/${out.friends[i].id}`);
const expectedAuth = "Basic " + Buffer.from(
  `${FAKE_ENV.TWILIO_ACCOUNT_SID}:${FAKE_ENV.TWILIO_AUTH_TOKEN}`).toString("base64");

test("mode off (default): no texts, all sms flags false", async () => {
  delete process.env.REFERRAL_SMS_MODE;
  const out = await post(submission());
  assert.equal(net.twilio().length, 0);
  assert.deepEqual(record(out).sms, { friend: false, referrer: false, office: false });
});

test("unknown mode value behaves as off", async () => {
  process.env.REFERRAL_SMS_MODE = "everyone";
  await post(submission());
  assert.equal(net.twilio().length, 0);
});

test("mode office: one alert per referral to the office number, verbatim template", async () => {
  process.env.REFERRAL_SMS_MODE = "office";
  const out = await post(submission({ friends: [
    { first_name: "Jane", last_name: "Doe", phone: "763-555-0101" },
    { first_name: "Bob", phone: "7635550102" },
  ] }));
  const texts = net.twilio();
  assert.equal(texts.length, 2);
  for (const t of texts) {
    assert.equal(t.url, `https://api.twilio.com/2010-04-01/Accounts/${FAKE_ENV.TWILIO_ACCOUNT_SID}/Messages.json`);
    assert.equal(t.options.method, "POST");
    assert.equal(t.headers.Authorization, expectedAuth);
    assert.equal(t.headers["Content-Type"], "application/x-www-form-urlencoded");
    assert.ok(t.options.signal, "Twilio call carries an abort signal (timeout)");
    assert.equal(t.params.get("To"), "+17633143400");
    assert.equal(t.params.get("From"), "+17635550000");
    assert.equal(t.params.get("MessagingServiceSid"), null);
  }
  const bodies = texts.map((t) => t.params.get("Body")).sort();
  assert.deepEqual(bodies, [
    `New referral: Alex Barta ((763) 555-0100) referred Bob (7635550102). Code ${out.code}. https://www.bartawindowwashing.com/admin/`,
    `New referral: Alex Barta ((763) 555-0100) referred Jane Doe (763-555-0101). Code ${out.code}. https://www.bartawindowwashing.com/admin/`,
  ]);
  assert.deepEqual(record(out, 0).sms, { friend: false, referrer: false, office: true });
  assert.deepEqual(record(out, 1).sms, { friend: false, referrer: false, office: true });
});

test("mode office without REFERRAL_OFFICE_PHONE sends nothing", async () => {
  setEnv({ REFERRAL_SMS_MODE: "office", REFERRAL_OFFICE_PHONE: undefined });
  const out = await post(submission());
  assert.equal(net.twilio().length, 0);
  assert.equal(record(out).sms.office, false);
});

test("mode all: friend, office, and referrer texts with the verbatim templates", async () => {
  process.env.REFERRAL_SMS_MODE = "all";
  const out = await post(submission());
  const texts = net.twilio();
  assert.equal(texts.length, 3);
  const to = (n) => texts.find((t) => t.params.get("To") === n);

  const friend = to("+17635550101");
  assert.ok(friend, "friend texted");
  assert.equal(friend.params.get("Body"),
    `Hi Jane! Alex B. referred you to Barta Window Washing, so your first service is $25 off. Claim it here: https://www.bartawindowwashing.com/r/${out.code} or call (763) 314-3400. Reply STOP to opt out.`);

  const referrer = to("+17635550100");
  assert.ok(referrer, "referrer texted");
  assert.equal(referrer.params.get("Body"),
    `Thanks for referring 1 friend(s) to Barta Window Washing! You earn a $50 credit (or a $25 gift card) for each one who books. Track your referrals: https://www.bartawindowwashing.com/?t=${out.token}`);

  const office = to("+17633143400");
  assert.ok(office, "office alerted");
  assert.ok(office.params.get("Body").startsWith("New referral: Alex Barta ((763) 555-0100) referred Jane Doe (763-555-0101)."));

  assert.deepEqual(record(out).sms, { friend: true, referrer: true, office: true });
});

test("mode all: referrer confirmation counts every friend in the submission", async () => {
  process.env.REFERRAL_SMS_MODE = "all";
  await post(submission({ friends: [
    { first_name: "Jane", phone: "7635550101" }, { first_name: "Bob", phone: "7635550102" },
    { first_name: "Cy", phone: "7635550103" },
  ] }));
  const referrer = net.twilio().filter((t) => t.params.get("To") === "+17635550100");
  assert.equal(referrer.length, 1, "one confirmation per submission");
  assert.ok(referrer[0].params.get("Body").startsWith("Thanks for referring 3 friend(s)"));
  assert.equal(net.twilio().length, 3 + 3 + 1);
});

test("mode all: a referrer without a last name reads naturally in the friend text", async () => {
  process.env.REFERRAL_SMS_MODE = "all";
  await post(submission({ referrer: { last_name: "" } }));
  const friend = net.twilio().find((t) => t.params.get("To") === "+17635550101");
  assert.ok(friend.params.get("Body").startsWith("Hi Jane! Alex referred you to Barta Window Washing"));
});

test("mode all: a duplicate friend is not texted; office still alerted", async () => {
  await post(submission());                       // first referral of Jane (mode off)
  process.env.REFERRAL_SMS_MODE = "all";
  net.requests.length = 0;
  const out = await post(submission({
    referrer: { first_name: "Maria", last_name: "Lopez", phone: "7635550200" },
    friends: [{ first_name: "Jane", phone: "7635550101" }],
  }));
  assert.equal(out.friends[0].duplicate, true);
  const tos = net.twilio().map((t) => t.params.get("To")).sort();
  assert.deepEqual(tos, ["+17633143400", "+17635550200"], "office + referrer only");
  assert.deepEqual(record(out).sms, { friend: false, referrer: true, office: true });
});

test("TWILIO_FROM as a Messaging Service SID uses MessagingServiceSid", async () => {
  setEnv({ REFERRAL_SMS_MODE: "office", TWILIO_FROM: "MG0123456789abcdef0123456789abcdef" });
  await post(submission());
  const [t] = net.twilio();
  assert.equal(t.params.get("MessagingServiceSid"), "MG0123456789abcdef0123456789abcdef");
  assert.equal(t.params.get("From"), null);
});

test("Twilio rejecting (400) leaves the flag false but the submission succeeds", async () => {
  process.env.REFERRAL_SMS_MODE = "all";
  net = mockFetch({ twilio: 400 });
  const out = await post(submission());
  assert.equal(out.ok, true);
  assert.equal(out.stored, true);
  assert.deepEqual(record(out).sms, { friend: false, referrer: false, office: false });
});

test("Twilio unreachable (fetch throws) is swallowed", async () => {
  process.env.REFERRAL_SMS_MODE = "all";
  net = mockFetch({ twilio: "throw" });
  const out = await post(submission());
  assert.equal(out.ok, true);
  assert.deepEqual(record(out).sms, { friend: false, referrer: false, office: false });
});

test("SMS mode on but Twilio not configured: no requests, submission succeeds", async () => {
  setEnv({ REFERRAL_SMS_MODE: "all", TWILIO_ACCOUNT_SID: undefined, TWILIO_AUTH_TOKEN: undefined });
  const out = await post(submission());
  assert.equal(out.ok, true);
  assert.equal(net.twilio().length, 0);
  assert.deepEqual(record(out).sms, { friend: false, referrer: false, office: false });
});

test("store down: friend/office texts still go out, referrer confirmation (dead link) does not", async () => {
  process.env.REFERRAL_SMS_MODE = "all";
  useStore(failingStore());
  const out = await post(submission());
  assert.equal(out.stored, false);
  const tos = net.twilio().map((t) => t.params.get("To")).sort();
  assert.deepEqual(tos, ["+17633143400", "+17635550101"]);
});
