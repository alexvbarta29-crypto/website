// Mocked tests for POST /api/claim: a referred friend claiming their discount
// on friend.html (/r/CODE). The claim goes to Rotor as a quote request with
// the referrer and code attached, and the referral record moves to "quoted"
// (or is created for a friend who only got the link). Nothing leaves the
// machine: fetch is stubbed, the store is a Map.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  setEnv, createMemoryStore, failingStore, useStore, mockFetch, jsonRequest, submission,
} from "./helpers/referral-harness.mjs";

setEnv({ REFERRAL_SMS_MODE: "off" });
const claim = (await import("../netlify/functions/claim.mjs")).default;
const referral = (await import("../netlify/functions/referral.mjs")).default;

let store, net, seeded;
beforeEach(async () => {
  store = useStore(createMemoryStore());
  net = mockFetch();
  const res = await referral(jsonRequest("/api/referral", "POST", submission({ friends: [
    { first_name: "Jane", last_name: "Doe", phone: "763-555-0101" },
    { first_name: "Bob", last_name: "Smith", phone: "7635550102" },
  ] })));
  assert.equal(res.status, 200);
  seeded = await res.json();
  net.requests.length = 0;
});

const post = (body) => claim(jsonRequest("/api/claim", "POST", {
  first_name: "Carla", last_name: "Mendez", phone: "7635550199", email: "carla@example.com",
  address: "9 Lake Rd, Delano", services: ["Gutter Cleaning", "House Washing"], note: "Two-story",
  consent: true, page: "/r/" + seeded.code, ...body,
}));
const records = () => store.keys("referral/").map((k) => store.json(k));
const byPhone = (d) => records().find((r) => r.phone_digits === d);

test("share-link friend with a valid code: CRM lead + a quoted record under the referrer", async () => {
  const res = await post({ code: seeded.code.toLowerCase() });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(res.headers.get("cache-control"), "no-store");
  const out = await res.json();
  assert.deepEqual(out, { ok: true, code: seeded.code, referrer_first_name: "Alex", delivered: true, stored: true });

  const [lead] = net.rotor();
  assert.equal(lead.payload.source, "Referral Program");
  assert.deepEqual(lead.payload.tags, ["Referral"]);
  assert.equal(lead.payload.name, "Carla Mendez");
  assert.equal(lead.payload.phone, "7635550199");
  assert.equal(lead.payload.email, "carla@example.com");
  assert.equal(lead.payload.address_street1, "9 Lake Rd, Delano");
  assert.equal(lead.payload.address_state, "MN");
  assert.equal(lead.payload.address_country, "US");
  assert.equal(lead.payload.service_type, "Gutter Cleaning, House Washing");
  assert.equal(lead.payload.notes,
    `Referral code: ${seeded.code} (referred by Alex Barta)\n`
    + "Claimed $25 off their first service through the referral link.\n"
    + "Interested in: Gutter Cleaning, House Washing\n"
    + "Customer notes:\nTwo-story");

  const rec = byPhone("7635550199");
  assert.ok(rec, "record created");
  assert.equal(rec.referrer_id, "7635550100");
  assert.equal(rec.code, seeded.code);
  assert.equal(rec.status, "quoted");
  assert.equal(rec.first_name, "Carla");
  assert.equal(rec.last_name, "Mendez");
  assert.equal(rec.email, "carla@example.com");
  assert.equal(rec.address, "9 Lake Rd, Delano");
  assert.ok(rec.quote_requested_at);
  assert.deepEqual(rec.rotor, { delivered: true, status: 201, at: rec.rotor.at });
  assert.deepEqual(rec.history.map((h) => [h.status, h.by]), [["new", "system"], ["quoted", "lead-form"]]);
  assert.deepEqual(store.json("idx/phone/7635550199"), { id: rec.id });
  assert.deepEqual(store.json(`idx/referrer/7635550100/${rec.id}`), { id: rec.id });
  assert.equal(records().length, 3);
});

test("a listed friend claiming without a code: matched by phone, referral moves to quoted", async () => {
  const res = await post({ first_name: "Jane", last_name: "Doe", phone: "(763) 555-0101", code: "" });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.code, seeded.code);
  assert.equal(out.referrer_first_name, "Alex");
  const jane = store.json(`referral/${seeded.friends[0].id}`);
  assert.equal(jane.status, "quoted");
  assert.ok(jane.quote_requested_at);
  assert.equal(jane.history.at(-1).by, "lead-form");
  assert.equal(jane.rotor.delivered, true);
  assert.deepEqual(net.rotor()[0].payload.tags, ["Referral"]);
  assert.ok(net.rotor()[0].payload.notes.startsWith(`Referral code: ${seeded.code} (referred by Alex Barta)`));
  assert.equal(records().length, 2, "no extra record for a listed friend");
});

test("a listed friend's claim fills in the details the referrer left blank, and only those", async () => {
  // The form now requires a friend's last name, so blank it on the stored
  // record directly: that is exactly the state of every referral created
  // before the rule, and of a share-link friend (validateClaim() keeps the
  // surname optional). Pre-fill the email so "never overwritten" is tested
  // by a field the loop actually visits.
  const key = `referral/${seeded.friends[1].id}`;
  store.map.set(key, JSON.stringify({ ...store.json(key), last_name: "", email: "old@example.com" }));

  const res = await post({ first_name: "Bob", last_name: "Smith", phone: "7635550102", email: "bob@example.com",
    address: "77 Elm St, Delano", code: "" });
  assert.equal(res.status, 200);
  const bob = store.json(key);
  assert.equal(bob.last_name, "Smith", "a blank surname is filled in from the claim");
  assert.equal(bob.address, "77 Elm St, Delano", "a blank address is filled in from the claim");
  assert.equal(bob.email, "old@example.com", "a detail already on file is never overwritten");
  assert.equal(bob.first_name, "Bob");
  assert.equal(bob.status, "quoted");
});

test("unknown code: delivered and tagged, the typed code flagged in the notes, nothing recorded", async () => {
  const res = await post({ code: "BARTA-ZZZZZ" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, code: null, referrer_first_name: "", delivered: true, stored: false });
  const p = net.rotor()[0].payload;
  assert.deepEqual(p.tags, ["Referral"]);
  assert.ok(p.notes.startsWith("Referral code typed: BARTA-ZZZZZ (not recognized)\n"));
  assert.equal(records().length, 2);
});

test("no code and an unknown phone: delivered as a referral-program lead, nothing recorded", async () => {
  const res = await post({ code: "" });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.code, null);
  assert.equal(out.delivered, true);
  const p = net.rotor()[0].payload;
  assert.ok(p.notes.startsWith("Claimed $25 off their first service through the referral link."));
  assert.equal(records().length, 2);
});

test("a customer using their own code: not a referral, no record, no Referral tag", async () => {
  const res = await post({ first_name: "Alex", last_name: "Barta", phone: "(763) 555-0100", code: seeded.code });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.code, null);
  const p = net.rotor()[0].payload;
  assert.deepEqual(p.tags, ["Referral Program"]);
  assert.ok(p.notes.startsWith(`Used their own referral code ${seeded.code} (not a referral)`));
  assert.equal(records().length, 2);
});

test("claiming twice is one record", async () => {
  await post({ code: seeded.code });
  net.requests.length = 0;
  const res = await post({ code: "", phone: "(763) 555-0199" });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).code, seeded.code, "matched by phone the second time");
  assert.equal(records().filter((r) => r.phone_digits === "7635550199").length, 1);
});

test("validation: 400 with the field named, and no CRM request", async () => {
  const cases = [
    [{ first_name: "" }, "first_name"],
    [{ phone: "555-01" }, "phone"],
    [{ phone: "+1 (763) 555-0199", email: "not-an-email" }, "email"],
    [{ consent: false }, "consent"],
    [{ address: "x".repeat(201) }, "address"],
    [{ note: "x".repeat(501) }, "note"],
  ];
  for (const [body, field] of cases) {
    const res = await post(body);
    assert.equal(res.status, 400, field);
    const out = await res.json();
    assert.equal(out.ok, false);
    assert.equal(out.field, field);
    assert.ok(out.error);
  }
  assert.equal(net.rotor().length, 0);
  assert.equal(records().length, 2);
  const bad = await claim(new Request("http://localhost/api/claim", { method: "POST", body: "not json" }));
  assert.equal(bad.status, 400);
});

test("405 for anything but POST", async () => {
  const res = await claim(new Request("http://localhost/api/claim"));
  assert.equal(res.status, 405);
});

test("store down: the claim still reaches the CRM (stored:false, no referrer named)", async () => {
  useStore(failingStore());
  const res = await post({ code: seeded.code });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.delivered, true);
  assert.equal(out.stored, false);
  assert.equal(out.code, null);
  const p = net.rotor()[0].payload;
  assert.deepEqual(p.tags, ["Referral"]);
  assert.ok(p.notes.startsWith(`Referral code typed: ${seeded.code} (not recognized)`), "the code is kept for the office");
});

test("CRM down but recorded: 200 with delivered:false and the record marked undelivered", async () => {
  net = mockFetch({ rotor: 500 });
  const res = await post({ code: seeded.code });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.delivered, false);
  assert.equal(out.stored, true);
  assert.equal(out.code, seeded.code);
  const rec = byPhone("7635550199");
  assert.equal(rec.status, "quoted");
  assert.deepEqual({ delivered: rec.rotor.delivered, status: rec.rotor.status }, { delivered: false, status: 500 });
});

test("CRM unreachable and store down: 502 so the friend sees the call-us fallback", async () => {
  useStore(failingStore());
  net = mockFetch({ rotor: "throw" });
  const res = await post({ code: seeded.code });
  assert.equal(res.status, 502);
  assert.equal((await res.json()).ok, false);
});
