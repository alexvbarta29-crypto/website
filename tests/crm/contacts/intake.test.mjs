// M2a acceptance: intake (design §11.4 "intake.test.mjs", §6.8, B2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeServices, seedImportedContact } from "../../helpers/crm-fixtures.mjs";
import { fresh, lead, contactKeys, contact, store, intake, ids, IMPORT } from "./fixtures.mjs";

const { intakeLead, leadgenKey } = intake;

test("B2: two simultaneous intakes for one phone → one contact and one sales.enroll call", async () => {
  const { S, done } = fresh();
  const calls = [];
  const restore = fakeServices({ "sales.enroll": async (cid, key) => { calls.push([cid, key]); return "en_00000000000000000001"; } });
  try {
    const [a, b] = await Promise.all([intakeLead(lead(42), { origin: "lead-form" }), intakeLead(lead(42), { origin: "lead-form" })]);
    assert.ok(a.ok && b.ok, JSON.stringify([a, b]));
    assert.equal(a.contact_id, b.contact_id, "one address, one contact");
    assert.equal(contactKeys(S).length, 1);
    assert.equal([a, b].filter((r) => r.created).length, 1);
    assert.deepEqual(calls, [[a.contact_id, "new_lead"]], "one enrollment");
    const c = await contact(a.contact_id);
    assert.equal(c.shadow, true, "made in the CRM while Rotor is in charge");
    assert.equal(c.lifecycle, "lead");
    assert.equal(c.consent.sms_service.state, "granted", "the website's consent box");
    assert.equal((c.notes.match(/Please call after 5/g) || []).length, 1, "the note block once, not per submit");
    assert.ok(c.primary_property_id, "the address became the lead's property");
  } finally { restore(); done(); }
});

test("a retried request lands on the same id, also when the first one died holding the lease", async () => {
  const { S, done } = fresh();
  try {
    const first = await intakeLead(lead(43), { origin: "lead-form" });
    const again = await intakeLead(lead(43), { origin: "lead-form" });
    assert.equal(again.contact_id, first.contact_id);
    assert.equal(again.created, false);

    // a request that died after writing the record but before its phone pointer and its lease release
    const hkey = store.hk("phone", "+17635550144");
    const id = ids.deriveId("contact", `intake--${hkey}`, "contacts.intake", 1);
    await store.settledWrite(`lock/intake/${hkey}`, { holder: "intake.dead", lease_until: "2026-11-17T15:00:20.000Z", n: 1 }, { onlyIfNew: true });
    await store.settledWrite(`rec/contact/${id}`, { id, type: "contact", v: 1, wv: 1, first_name: "Pat", last_name: "Example", phones: [{ e164: "+17635550144", primary: true }], emails: [], lifecycle: "lead", tags: [], notes: "", flags: {}, consent: {}, shadow: true, created_at: "2026-11-17T15:00:00.000Z", updated_at: "2026-11-17T15:00:00.000Z" }, { onlyIfNew: true });
    const retry = await intakeLead(lead(44), { origin: "lead-form" });
    assert.ok(retry.ok);
    assert.equal(retry.contact_id, id, "the retry found the same derived id");
    assert.equal(contactKeys(S).length, 2);
  } finally { done(); }
});

test("a Meta lead id seen twice → one contact, and nothing else happens the second time", async () => {
  const { S, done } = fresh();
  try {
    const one = await intakeLead({ ...lead(45), provider_lead_id: "880000000000001", source: { source: "Meta Ads", form: "Sample Form", ad: "Sample Ad" } }, { origin: "webhook" });
    const two = await intakeLead({ ...lead(46), provider_lead_id: "880000000000001", source: "Meta Ads" }, { origin: "webhook" });
    assert.ok(one.created);
    assert.equal(two.contact_id, one.contact_id);
    assert.equal(two.duplicate, true);
    assert.equal(contactKeys(S).length, 1, "a second delivery made no second contact");
    assert.ok(S.data.keys("ptr/meta-lead/").length === 1);
    assert.ok(!S.data.keys("ptr/meta-lead/")[0].includes("880000000000001"), "the leadgen id is hashed in the key");
    const c = await contact(one.contact_id);
    assert.equal(c.source.source, "Meta Ads");
    assert.equal(c.source.form, "Sample Form");
    assert.ok(!c.phones.some((p) => p.e164 === "+17635550146"), "the duplicate's phone never landed");
  } finally { done(); }
});

test("Rotor's lead id from the dual-write reply claims ptr/rotor/lead; no id → intake_pending_rotor", async () => {
  const { done } = fresh();
  try {
    const withId = await intakeLead(lead(47), { origin: "lead-form", rotor: { lead_id: "rl-0000-0047" } });
    const p = await store.readPointer("rotor/lead", "rl-0000-0047");
    assert.equal(p.id, withId.contact_id);
    assert.deepEqual((await contact(withId.contact_id)).rotor.lead_ids, ["rl-0000-0047"]);
    assert.equal((await contact(withId.contact_id)).intake_pending_rotor, undefined);

    const without = await intakeLead(lead(48), { origin: "lead-form" });
    const c = await contact(without.contact_id);
    assert.equal(c.intake_pending_rotor.phone_hk, store.hk("phone", "+17635550148"));
    assert.ok(c.intake_pending_rotor.email_hk);
    // Rotor answers the next submit with an id: the pending mark goes, the id is linked
    const later = await intakeLead(lead(48), { origin: "lead-form", rotor: { lead_id: "rl-0000-0048" } });
    assert.equal(later.contact_id, without.contact_id);
    const c2 = await contact(without.contact_id);
    assert.equal(c2.intake_pending_rotor, undefined);
    assert.deepEqual(c2.rotor.lead_ids, ["rl-0000-0048"]);
  } finally { done(); }
});

test("upsert: fills only empty fields, merges tags, appends the note once, never clobbers", async () => {
  const { done } = fresh();
  try {
    const a = await intakeLead({ ...lead(49), tags: ["Website"], first_name: "", last_name: "" }, { origin: "lead-form" });
    const b = await intakeLead({ ...lead(49), first_name: "Robin", last_name: "Sample", tags: ["Website", "Yard Sign"], notes: "Customer notes:\nSecond request", email: "robin.sample@example.com" }, { origin: "lead-form" });
    assert.equal(b.contact_id, a.contact_id);
    const c = await contact(a.contact_id);
    assert.equal(c.first_name, "Robin", "an empty name is filled");
    assert.deepEqual(c.tags, ["Website", "Yard Sign"]);
    assert.ok(c.notes.includes("Please call after 5") && c.notes.includes("Second request"));
    assert.deepEqual(c.emails.map((e) => e.address).sort(), ["pat.example49@example.com", "robin.sample@example.com"]);
    const c3 = await intakeLead({ ...lead(49), first_name: "Someone", last_name: "Else" }, { origin: "lead-form" });
    assert.equal((await contact(c3.contact_id)).first_name, "Robin", "a name already there is never replaced");
  } finally { done(); }
});

test("giveaway entries get tags only: no enrollment, no lead.created", async () => {
  const { S, done } = fresh();
  const calls = [];
  const restore = fakeServices({ "sales.enroll": async (cid) => { calls.push(cid); return null; } });
  try {
    const r = await intakeLead({ name: "Casey Placeholder", phone: "7635550151", tags: ["Giveaway 2026", "Giveaway - Coupon Opt-In"], notes: "Entered the giveaway.", source: "Holiday Lights Giveaway", consent: { sms_marketing: true } }, { origin: "giveaway" });
    assert.ok(r.ok && r.created);
    assert.deepEqual(calls, []);
    assert.equal(S.data.keys("q/").length, 0, "no event queued");
    const c = await contact(r.contact_id);
    assert.equal(c.consent.sms_marketing.state, "granted");
    assert.equal(c.consent.sms_marketing.source, "giveaway_optin");
  } finally { restore(); done(); }
});

test("before cutover, intake changes no Rotor-owned field of an imported contact: a would- row, the request on its timeline", async () => {
  const { S, done } = fresh();
  try {
    const imported = await seedImportedContact(52, { tags: ["Imported"], notes: "From Rotor." });
    // the import keeps the phone lookup like any write (seedImportedContact writes the record alone)
    await store.updatePointerList("phone", store.hk("phone", imported.phones[0].e164), (list) => [...list, imported.id]);
    const r = await intakeLead({ ...lead(52), phone: imported.phones[0].e164, tags: ["Website"] }, { origin: "lead-form", rotor: { lead_id: "rl-0000-0052" } });
    assert.ok(r.ok);
    assert.equal(r.contact_id, imported.id);
    const c = await contact(imported.id);
    assert.deepEqual(c.tags, ["Imported"], "tags untouched");
    assert.equal(c.notes, "From Rotor.", "notes untouched");
    assert.ok(S.data.keys("alog/").some((k) => k.includes("would-update")), "a would- row");
    assert.ok(S.data.keys(`evt/contact/${imported.id}/`).some((k) => k.includes("--intake--")), "the request is kept as an event");
    assert.equal((await store.readPointer("rotor/lead", "rl-0000-0052")).id, imported.id, "the Rotor lead id still links");
  } finally { done(); }
});

test("an unusable phone and no email → refused; a phone that only matches an archived contact makes a new lead and a candidate", async () => {
  const { S, done } = fresh();
  try {
    assert.equal((await intakeLead({ name: "No Way", phone: "12" }, { origin: "lead-form" })).error, "no_contact");
    const old = await intakeLead(lead(53), { origin: "lead-form" });
    await store.updateRecord("contact", old.contact_id, (c) => ({ ...c, lifecycle: "archived", archived_reason: "spam" }), IMPORT);
    const again = await intakeLead(lead(53), { origin: "lead-form" });
    assert.notEqual(again.contact_id, old.contact_id);
    assert.equal(S.data.keys("rec/merge_candidate/").length, 1);
  } finally { done(); }
});

test("normalizeInput: names, phones, sources and consent", () => {
  const n = intake.normalizeInput({ name: "Jordan  Q  Testcase", phone: "+1 (763) 555-0160", email: " Jordan@Example.COM ", referral_source: "Yard Sign", page: "/get-quote.html", consent: { sms_service: true } }, "lead-form");
  assert.equal(n.first_name, "Jordan");
  assert.equal(n.last_name, "Q Testcase");
  assert.equal(n.phone, "+17635550160");
  assert.equal(n.email, "jordan@example.com");
  assert.equal(n.source.source, "Website quote form");
  assert.equal(n.source.channel, "Yard Sign");
  assert.equal(n.consent.sms_service, true);
  assert.equal(intake.appendNote("a\n\n— X —\nhello", "— X —\nhello"), "a\n\n— X —\nhello", "the same block twice is kept once");
  assert.match(leadgenKey("1"), /^[0-9a-f]{40}$/);
});
