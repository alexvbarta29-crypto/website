// The referral hook inside /api/lead (docs/REFERRAL-PROGRAM.md → "Quote form
// integration"): a quote request with a referral promo code, or from a
// referred phone number, gets the Referral tag + notes line and moves the
// referral to "quoted". Everything else about the lead must be untouched,
// and a broken or hanging store must never fail or hold up the quote.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  setEnv, createMemoryStore, failingStore, hangingStore, useStore, mockFetch, jsonRequest, submission,
} from "./helpers/referral-harness.mjs";
import { HOOK_TIMEOUT_MS } from "../netlify/lib/referral-hook.mjs";

setEnv({ REFERRAL_SMS_MODE: "off" });
const lead = (await import("../netlify/functions/lead.mjs")).default;
const referral = (await import("../netlify/functions/referral.mjs")).default;

let store, net, seeded;
beforeEach(async () => {
  store = useStore(createMemoryStore());
  net = mockFetch();
  const res = await referral(jsonRequest("/api/referral", "POST", submission({ friends: [
    { first_name: "Jane", last_name: "Doe", phone: "763-555-0101" },
    { first_name: "Bob", phone: "7635550102" },
  ] })));
  assert.equal(res.status, 200);
  seeded = await res.json();
  net.requests.length = 0;
});

const quote = async (body) => {
  const res = await lead(jsonRequest("/api/lead", "POST", {
    first_name: "Test", last_name: "Person", services: ["Exterior Window Cleaning"],
    plan: "quarterly", notes: "Please call after 5pm.", referral_source: "Family/Friend", ...body,
  }));
  assert.equal(res.status, 200, await res.clone().text());
  const rotor = net.rotor();
  assert.equal(rotor.length, 1, "exactly one Rotor request per quote");
  return rotor[0].payload;
};
const janeRecord = () => store.json(`referral/${seeded.friends[0].id}`);

test("promo code match (any case/spacing): Referral tag + notes line ahead of details", async () => {
  const p = await quote({ phone: "7635559999", promo_code: ` ${seeded.code.toLowerCase().replace("-", " ")} ` });
  assert.deepEqual(p.tags, ["Website", "Family/Friend", "Referral"]);
  assert.equal(p.notes,
    "Customer notes:\nPlease call after 5pm.\n\n"
    + `Referral code: ${seeded.code} (referred by Alex Barta)\n`
    + "Services: Exterior Window Cleaning\nPlan: Quarterly");
  assert.equal(p.source, "Website quote form", "source unchanged");
  assert.equal(p.phone, "7635559999");
  // Nobody listed this phone number, so this friend arrived through the
  // share link: a record is created under the referrer, already "quoted",
  // and the listed friends are untouched.
  assert.equal(janeRecord().status, "new");
  const created = store.keys("referral/").map((k) => store.json(k)).find((r) => r.phone_digits === "7635559999");
  assert.ok(created, "share-link friend gets a referral record");
  assert.equal(created.referrer_id, "7635550100");
  assert.equal(created.code, seeded.code);
  assert.equal(created.status, "quoted");
  assert.equal(created.first_name, "Test");
  assert.equal(created.last_name, "Person");
  assert.equal(created.phone, "7635559999");
  assert.ok(created.quote_requested_at, "quote_requested_at stamped");
  assert.equal(created.rotor.delivered, true, "the quote form itself delivers them to Rotor");
  assert.deepEqual(created.history.map((h) => [h.status, h.by]), [["new", "system"], ["quoted", "lead-form"]]);
  assert.deepEqual(store.json("idx/phone/7635559999"), { id: created.id }, "indexed so a later listing is a duplicate");
  assert.deepEqual(store.json(`idx/referrer/7635550100/${created.id}`), { id: created.id });
});

test("share-link arrival with a single name field, email and address: details carried over", async () => {
  await quote({ first_name: "", last_name: "", name: "Mary Ann Lee", phone: "7635558888", email: "mary@example.com",
    promo_code: seeded.code, address_street: "9 Lake Rd", address_city: "Delano", address_state: "MN", address_zip: "55328" });
  const created = store.keys("referral/").map((k) => store.json(k)).find((r) => r.phone_digits === "7635558888");
  assert.equal(created.first_name, "Mary");
  assert.equal(created.last_name, "Ann Lee");
  assert.equal(created.email, "mary@example.com");
  assert.equal(created.address, "9 Lake Rd, Delano, MN 55328");
  assert.equal(created.duplicate_of, null);
});

test("a share-link friend quoting twice is one record, not two", async () => {
  await quote({ phone: "7635557777", promo_code: seeded.code });
  net.requests.length = 0;   // quote() checks one Rotor request per call
  await quote({ phone: "(763) 555-7777", promo_code: "" });
  const mine = store.keys("referral/").map((k) => store.json(k)).filter((r) => r.phone_digits === "7635557777");
  assert.equal(mine.length, 1);
  assert.equal(mine[0].status, "quoted");
});

test("a referrer using their own code on their own quote: no tag, no record", async () => {
  const res = await lead(jsonRequest("/api/lead", "POST", {
    first_name: "Alex", last_name: "Barta", phone: "(763) 555-0100", promo_code: seeded.code,
    services: ["Exterior Window Cleaning"], plan: "quarterly",
  }));
  assert.equal(res.status, 200);
  const p = net.rotor()[0].payload;
  assert.deepEqual(p.tags, ["Website"]);
  assert.ok(!p.notes.includes("Referral code"));
  assert.equal(store.keys("referral/").length, seeded.friends.length, "no record for the referrer themselves");
});

test("phone match without a promo code: tagged, and the referral moves to quoted", async () => {
  const p = await quote({ phone: "(763) 555-0101", promo_code: "" });
  assert.deepEqual(p.tags, ["Website", "Family/Friend", "Referral"]);
  assert.ok(p.notes.includes(`Referral code: ${seeded.code} (referred by Alex Barta)`));

  const r = janeRecord();
  assert.equal(r.status, "quoted");
  assert.ok(r.quote_requested_at, "quote_requested_at set");
  assert.equal(r.updated_at, r.quote_requested_at);
  const last = r.history.at(-1);
  assert.equal(last.status, "quoted");
  assert.equal(last.by, "lead-form");
  assert.equal(r.history.length, 2);
  // Bob is untouched.
  assert.equal(store.json(`referral/${seeded.friends[1].id}`).status, "new");
});

test("promo + phone both match: moves the referral, one Referral tag", async () => {
  const p = await quote({ phone: "+1 763 555 0102", promo_code: seeded.code });
  assert.deepEqual(p.tags, ["Website", "Family/Friend", "Referral"]);
  assert.equal(store.json(`referral/${seeded.friends[1].id}`).status, "quoted");
});

test("contacted → quoted, but booked/declined/quoted are left alone (still tagged)", async () => {
  const key = `referral/${seeded.friends[0].id}`;
  const set = (patch) => store.map.set(key, JSON.stringify({ ...store.json(key), ...patch }));

  set({ status: "contacted" });
  await quote({ phone: "7635550101" });
  assert.equal(janeRecord().status, "quoted");

  for (const status of ["booked", "declined", "rewarded"]) {
    set({ status, history: [] });
    net.requests.length = 0;
    const p = await quote({ phone: "7635550101" });
    assert.ok(p.tags.includes("Referral"), `${status}: still tagged`);
    assert.equal(janeRecord().status, status, `${status}: not moved`);
    assert.equal(janeRecord().history.length, 0, `${status}: no history entry`);
  }
});

test("no match: payload identical to a plain quote, nothing touched", async () => {
  const p = await quote({ phone: "7635559999", promo_code: "FALL10" });
  assert.deepEqual(p, {
    source: "Website quote form",
    tags: ["Website", "Family/Friend"],
    name: "Test Person",
    phone: "7635559999",
    service_type: "Exterior Window Cleaning",
    notes: "Customer notes:\nPlease call after 5pm.\n\nServices: Exterior Window Cleaning\nPlan: Quarterly",
  });
  assert.equal(janeRecord().status, "new");
});

test("a referral-looking code that does not exist is ignored", async () => {
  const p = await quote({ phone: "7635559999", promo_code: "BARTA-AAAAA" });
  assert.deepEqual(p.tags, ["Website", "Family/Friend"]);
  assert.ok(!p.notes.includes("Referral code"));
});

test("email-only lead (no phone) with a valid code still gets tagged", async () => {
  const p = await quote({ phone: "", email: "friend@example.com", promo_code: seeded.code });
  assert.ok(p.tags.includes("Referral"));
  assert.ok(!("phone" in p));
});

test("referral line survives truncation ahead of Services/Plan", async () => {
  // lead.mjs caps every field at 500 chars, so the only way past Rotor's
  // 2,000-char notes limit is a long service list.
  const services = Array.from({ length: 4 }, (_, i) => String.fromCharCode(65 + i).repeat(480));
  const p = await quote({ phone: "7635550101", services });
  assert.ok(p.notes.length <= 2000);
  assert.ok(p.notes.startsWith("Customer notes:\nPlease call after 5pm.\n\n"), "customer message first");
  assert.ok(p.notes.includes(`Referral code: ${seeded.code} (referred by Alex Barta)`), "referral line kept");
  assert.ok(!p.notes.includes("Services:"), "Services line dropped first");
  assert.ok(!p.notes.includes("Plan:"), "Plan line dropped first");
});

test("store throwing: quote still delivered, no tag, no delay", async () => {
  useStore(failingStore());
  const t0 = Date.now();
  const p = await quote({ phone: "7635550101", promo_code: seeded.code });
  assert.ok(Date.now() - t0 < 500);
  assert.deepEqual(p.tags, ["Website", "Family/Friend"]);
  assert.ok(!p.notes.includes("Referral code"));
});

test("store hanging: quote delivered without the tag once the hook times out", async () => {
  useStore(hangingStore());
  const t0 = Date.now();
  const p = await quote({ phone: "7635550101", promo_code: seeded.code });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= HOOK_TIMEOUT_MS - 50, `waited for the timeout (${elapsed}ms)`);
  assert.ok(elapsed < HOOK_TIMEOUT_MS + 1000, `did not hang past the timeout (${elapsed}ms)`);
  assert.deepEqual(p.tags, ["Website", "Family/Friend"]);
});

test("Blobs not configured at all (no override): quote delivered untouched", async () => {
  delete globalThis.__referralStoreOverride;
  const p = await quote({ phone: "7635550101", promo_code: seeded.code });
  assert.deepEqual(p.tags, ["Website", "Family/Friend"]);
});

test("lead validation and Rotor error handling are unchanged", async () => {
  const bad = await lead(jsonRequest("/api/lead", "POST", { name: "No Contact" }));
  assert.equal(bad.status, 400);
  net = mockFetch({ rotor: 500 });
  const res = await lead(jsonRequest("/api/lead", "POST", { phone: "7635550101", promo_code: seeded.code }));
  assert.equal(res.status, 502);
});
