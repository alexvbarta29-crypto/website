// The contacts import phases (design §10.2 rows 6-12 and 36, §10.3), tested
// directly against the §10.1 contract with synthetic Rotor-shaped rows (the
// framework that runs them is M2c's).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fresh, store, intake, IMPORT, PERSON, ids, applyImport } from "./fixtures.mjs";

const I = await import("../../../netlify/lib/crm/modules/contacts/import-rotor.mjs");
const phase = (name) => I.phases.find((p) => p.name === name);
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ctx = { lookup: null, users: new Map([["rotor-user-1", "us_0000000000000000000a"]]) };

// What the M2c runner does with an output (fixtures.applyImport: field
// ownership, simplified), then the extras.
const apply = (out) => applyImport(out, { extras: I.applyExtras });
const run = async (name, row) => { const p = phase(name); const out = await p.map(p.normalize(row), ctx); await apply(out); return out; };
const contact = async (id) => (await store.getRecord("contact", id)).data;

test("row 6, customers: names repaired, phones checked, status, sources, flags, Markate, the primary property", async () => {
  const { done } = fresh();
  try {
    const out = await run("contacts.customers", {
      id: uuid(1), first_name: "JosÃ©", last_name: "Example", phone: "763555010012", email: "jose.example@example.com", status: "inactive",
      source: "Referral program", assigned_to: ["rotor-user-1"], tags: ["Christmas Lights"], notes: "Gate code on file.",
      address: { street1: "1 Example Ave", city: "Delano", state: "XX", zip: "55328", country: "United States" }, created_at: "2026-07-29T21:49:46.123456+00:00",
    });
    assert.ok(out.warnings.includes("phone_twelve_digits"), "the 12-digit phone is flagged, not stored");
    assert.ok(out.warnings.includes("address_state"));
    const c = await contact(ids.idForRotor("contact", uuid(1)));
    assert.equal(c.first_name, "José");
    assert.equal(c.lifecycle, "former_customer");
    assert.ok(c.tags.includes("Rotor inactive") && c.tags.includes("Referral Program"));
    assert.equal(c.source.source, "Referral");
    assert.equal(c.billing_address.state, "MN", "state fixed from the ZIP");
    assert.equal(c.rotor.markate_batch, 2);
    assert.equal(c.rotor.customer_id, uuid(1));
    assert.equal(c.owner_id, "us_0000000000000000000a");
    assert.equal(c.phones.length, 0);
    assert.equal(c.created_at, "2026-07-29T21:49:46.123Z", "the import keeps Rotor's creation time");
    assert.ok(c.primary_property_id && (await store.getRecord("property", c.primary_property_id)));
    assert.equal((await store.readPointer("rotor/customer", uuid(1))).id, c.id);
    await run("contacts.customers", { id: uuid(2), first_name: "", last_name: "", company_name: "Sample Shop LLC", phone: "7635550201", status: "active", source: "Test" });
    const b = await contact(ids.idForRotor("contact", uuid(2)));
    assert.equal(b.kind, "business");
    assert.equal(b.lifecycle, "archived");
    assert.equal(b.archived_reason, "test");
    assert.equal(b.flags.test, true, "Test is a flag, not a source");
  } finally { done(); }
});

test("§10.3: a customer converted from a dual-write lead updates that contact in place", async () => {
  const { done } = fresh();
  try {
    const lead = await intake.intakeLead({ name: "Riley Sample", phone: "7635550210", email: "riley.s@example.com" }, { origin: "lead-form", rotor: { lead_id: uuid(10) } });
    const out = await phase("contacts.customers").map(phase("contacts.customers").normalize({ id: uuid(11), first_name: "Riley", last_name: "Sample", phone: "+17635550210", status: "active", source: "Website quote form", notes: "Converted from lead on 11/20/2026\n\nOriginal Lead Notes:\nServices: Gutter Cleaning" }), ctx);
    assert.equal(out.records[0].data.id, lead.contact_id, "the same contact, not a new one");
    assert.equal(out.pointers[0].value.id, lead.contact_id);
  } finally { done(); }
});

test("row 7, quote contact rows: consent, Stripe ids, first texts, muted channels, converted leads", async () => {
  const { done } = fresh();
  try {
    await run("contacts.customers", { id: uuid(20), first_name: "Sam", last_name: "Sample", phone: "7635550220", status: "active", source: "Website" });
    const out = await run("contacts.quote_contacts", { id: uuid(20), type: "customer", stripe_customer_id: "cus_SAMPLE20", messaging_config: { sms: { opted_in: true } }, first_sms_sent_date: "2026-03-01T15:00:00Z", converted_from_lead_id: uuid(21), muted_channels: ["email"] });
    const id = ids.idForRotor("contact", uuid(20));
    const c = await contact(id);
    assert.equal(c.consent.sms_service.state, "granted");
    assert.equal(c.consent.sms_service.source, "import");
    assert.equal(c.automations_paused.email.reason, "Muted in Rotor");
    assert.deepEqual(c.rotor.lead_ids, [uuid(21)]);
    assert.equal((await store.readPointer("rotor/lead", uuid(21))).id, id, "the converted lead resolves here");
    assert.ok(out.stats.some((s) => s.part === "money" && s.merge.stripe.customer_ids[0] === "cus_SAMPLE20"));
    const st = (await store.getRecord("contact_stats", id)).data;
    assert.equal(st.comms.first_sms["+17633143400"], "2026-03-01T15:00:00.000Z");
    assert.deepEqual((await store.readPointer("stripe-cus", (await import("../../../netlify/lib/crm/modules/contacts/display.mjs")).stripeKey("cus_SAMPLE20"))).ids, [id]);
  } finally { done(); }
});

test("row 8, leads: a pending dual-write lead, a customer with the same first name, an overlap, spam, Meta notes", async () => {
  const { S, done } = fresh();
  try {
    // a dual-write lead whose Rotor id never came back
    const pending = await intake.intakeLead({ name: "Pending Person", phone: "7635550230" }, { origin: "lead-form" });
    await run("contacts.leads", { id: uuid(30), first_name: "Pending", last_name: "Person", phone: "763-555-0230", source: "Website quote form", notes: "Customer notes:\nHi\n\nServices: Gutter Cleaning\nPlan: Quarterly", tags: ["Website"] });
    let c = await contact(pending.contact_id);
    assert.equal(c.intake_pending_rotor, undefined, "the pending mark is cleared");
    assert.deepEqual(c.rotor.lead_ids, [uuid(30)]);
    assert.equal((await store.readPointer("rotor/lead", uuid(30))).id, pending.contact_id);
    assert.equal(S.data.keys("rec/contact/").length, 1, "no new contact");

    // a customer with the same phone and first name: the lead joins them
    await run("contacts.customers", { id: uuid(31), first_name: "Morgan", last_name: "Sample", phone: "7635550231", status: "active", source: "Website" });
    await run("contacts.leads", { id: uuid(32), first_name: "morgan", last_name: "S", phone: "7635550231", source: "Meta Ads", tags: ["Sample Form"] });
    c = await contact(ids.idForRotor("contact", uuid(31)));
    assert.deepEqual(c.rotor.lead_ids, [uuid(32)]);
    assert.ok(c.tags.includes("Sample Form"));

    // the same phone, another first name: a new lead and a high-confidence candidate
    const out = await run("contacts.leads", { id: uuid(33), first_name: "Taylor", last_name: "Sample", phone: "7635550231", source: "Meta Ads", notes: "Form: Sample Form\nAd: Sample Ad\nWhere are you located?: Wright County", service_type: "Exterior Window Cleaning", projected_value: "243.1" });
    const t = await contact(ids.idForRotor("contact", uuid(33)));
    assert.equal(t.lifecycle, "lead");
    assert.deepEqual([t.source.form, t.source.ad, t.source.county], ["Sample Form", "Sample Ad", "wright"]);
    assert.equal(S.data.keys("rec/merge_candidate/").length, 1);
    // the lead's deal: written once Sales ships the deal type (a warning before)
    assert.ok(out.records.some((r) => r.type === "deal" && r.data.contact_id === t.id && r.data.services.includes("Exterior Window Cleaning")) || out.warnings.includes("deal_waits_for_sales"), "the lead's deal");

    await run("contacts.leads", { id: uuid(34), first_name: "asdf", last_name: "asdf", phone: "7635550234", source: "Website" });
    const spam = await contact(ids.idForRotor("contact", uuid(34)));
    assert.equal(spam.lifecycle, "archived");
    assert.equal(spam.archived_reason, "spam");
  } finally { done(); }
});

test("row 9 placeholders, row 10 properties, row 12 STOP replies, row 36 giveaway and referrals", async () => {
  const { S, done } = fresh();
  try {
    const ph = I.placeholderContact(uuid(40), { name: "Opportunity Person" });
    assert.equal(ph.data.id, ids.idForRotor("contact", uuid(40)));
    assert.equal(ph.data.flags.placeholder, true);
    assert.equal(ph.data.lifecycle, "archived");
    await apply({ records: [ph] });

    await run("contacts.customers", { id: uuid(41), first_name: "Casey", last_name: "Example", phone: "7635550241", status: "active", source: "Website", address: { street1: "41 Example Avenue", city: "Delano", state: "MN", zip: "55328" } });
    const cid = ids.idForRotor("contact", uuid(41));
    const same = await run("contacts.properties_quotes", { id: uuid(42), customer_id: uuid(41), property_id: 9001, property_street1: "41 example ave", property_city: "Delano", property_zip: "55328" });
    assert.equal(same.records, undefined, "the same street + ZIP: no new property");
    const other = await run("contacts.properties_plans", { id: uuid(43), customer_id: uuid(41), jobs_config: { property_street1: "7 Lake Rd", property_city: "Mound", property_state: "MN", property_zip: "55364" } });
    assert.equal(other.records[0].data.contact_id, cid);
    assert.equal(S.data.keys(`rel/contact-properties/${cid}/`).length, 2);

    await run("contacts.suppressions", { id: uuid(44), direction: "inbound", channel: "sms", body: " stop ", from_number: "+17635550241" });
    await run("contacts.suppressions", { id: uuid(45), direction: "inbound", channel: "sms", body: "Stop by tomorrow?", from_number: "+17635550242" });
    assert.equal(S.data.keys("sup/sms/").length, 1, "an exact STOP only");
    assert.equal((await store.getRaw(`sup/sms/${store.hk("phone", "+17635550241")}`)).data.state, "opted_out");

    await run("contacts.giveaway", { id: "e1", phone: "7635550241", offers_opt_in: true, code: "SAMPLE7" });
    const c = await contact(cid);
    assert.equal(c.consent.sms_marketing.state, "granted");
    assert.equal(c.source.promo_code, "SAMPLE7");
    await run("contacts.giveaway", { id: "e2", phone: "7635550299", sms_opt_out: true });
    assert.equal(S.data.keys("sup/sms/").length, 2, "an opted-out entrant is suppressed even without a contact");
    await run("contacts.referrals", { id: "r1", friend: { phone: "7635550241" }, code: "BARTA-SAMPLE" });
    assert.equal((await contact(cid)).source.referral_code, "BARTA-SAMPLE");
  } finally { done(); }
});

test("pure helpers: notes parsing, sources, cents, patches, the tag catalog", () => {
  const f = I.parseLeadNotes("Converted from lead on 3/4/2026\nOriginal Lead Notes:\nCustomer notes:\nHello there\n\nServices: Gutter Cleaning, House Washing\nPlan: Quarterly\nLights location: Front\nReferral code: BARTA-AB12C (referred by Pat Example)\n$250 coupon texts: YES, opted in\nInvited by: Pat (SAMPLE1)");
  assert.deepEqual(f.services, ["Gutter Cleaning", "House Washing"]);
  assert.equal(f.plan, "Quarterly");
  assert.equal(f.referral_code, "BARTA-AB12C");
  assert.equal(f.coupon_optin, true);
  assert.equal(f.converted_on, "3/4/2026");
  assert.equal(f.message, "Hello there");
  assert.deepEqual(I.canonicalSource("Referral Program"), { source: "Referral", tag: "Referral Program", raw: "Referral Program" });
  assert.equal(I.canonicalSource("Markate Import").source, "Returning Customer");
  assert.equal(I.canonicalSource("Something New").source, "Other");
  assert.equal(I.toCents("243.1"), 24310);
  assert.equal(I.toCents("216.75"), 21675);
  assert.equal(I.toCents("0.1"), 10);
  assert.equal(I.toCents("-5"), -500);
  assert.equal(I.toCents("abc"), null);
  const p = I.applyPatch({ first_name: "", tags: ["A"], consent: { sms_service: { state: "revoked" } } }, { fill: { first_name: "Pat" }, add: { tags: ["a", "B"] }, set: { "consent.sms_service": { state: "granted" } }, only_if: { "consent.sms_service.state": ["unknown", undefined] } });
  assert.equal(p.first_name, "Pat");
  assert.deepEqual(p.tags, ["A", "B"]);
  assert.equal(p.consent.sms_service.state, "revoked", "only_if keeps a revocation");
  assert.equal(I.applyPatch({ a: 1 }, { fill: { a: 2 } }), null);
  const cat = I.tagCatalog([{ tg: ["Giveaway 2026", "Sample Form"] }, { tg: ["Giveaway 2026"] }]);
  assert.deepEqual(cat.map((x) => [x.name, x.count, x.kind]), [["Giveaway 2026", 2, "program"], ["Sample Form", 1, "attribution"]]);
  assert.throws(() => I.normalizePerson({ id: "bad id with spaces" }), I.RowError);
  assert.throws(() => I.normalizePerson({ id: uuid(1), tags: "x" }), I.RowError);
  assert.ok(I.isSpamName("www.spam.example", ""));
  assert.ok(!I.isSpamName("Pat", "Example"));
});

test("re-running an unchanged customer is a no-op for the extras (idempotent)", async () => {
  const { done } = fresh();
  try {
    const row = { id: uuid(50), first_name: "Jordan", last_name: "Example", phone: "7635550250", status: "active", source: "Website", tags: ["Giveaway - Coupon Opt-In"] };
    const first = await run("contacts.customers", row);
    const again = await phase("contacts.customers").map(phase("contacts.customers").normalize(row), ctx);
    assert.deepEqual(again.records.map((r) => r.data.id), first.records.map((r) => r.data.id), "the same ids on a re-run");
    const res = await I.applyExtras(again, IMPORT);
    assert.equal(res.patched, 0, "consent already granted: nothing to patch");
    void PERSON;
  } finally { done(); }
});
