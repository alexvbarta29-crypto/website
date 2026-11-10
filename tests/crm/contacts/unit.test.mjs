// Unit tests of the contacts module's pure parts (design §12.2 "contacts"):
// E.164 with the 12-digit and junk cases, display names, addresses, matching
// never on a name alone (R18), the intake's fill-only upsert, the service
// area by haversine from Delano, the webhook's field mapping.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fresh, store, match, intake, PERSON } from "./fixtures.mjs";

const D = await import("../../../netlify/lib/crm/modules/contacts/display.mjs");
const T = await import("../../../netlify/lib/crm/modules/contacts/types.mjs");
const W = await import("../../../netlify/lib/crm/modules/contacts/webhook.mjs");
const R = await import("../../../netlify/lib/crm/modules/contacts/routes.mjs");
const { InputError } = await import("../../../netlify/lib/crm/core/errors.mjs");

test("phones: E.164, the import's 12-digit and junk cases", () => {
  assert.deepEqual(D.normalizePhone("(763) 555-0100"), { e164: "+17635550100" });
  assert.deepEqual(D.normalizePhone("+1 763.555.0100"), { e164: "+17635550100" });
  assert.deepEqual(D.normalizePhone("17635550100"), { e164: "+17635550100" });
  assert.equal(D.normalizePhone("763555010012").problem, "twelve_digits");
  assert.equal(D.normalizePhone("5550100").problem, "junk", "too short");
  assert.equal(D.normalizePhone("0635550100").problem, "junk", "an area code can't start with 0");
  assert.equal(D.normalizePhone("1".repeat(10)).problem, "junk", "one digit repeated");
  assert.equal(D.normalizePhone("").problem, "empty");
  assert.equal(D.phoneFormatted("+17635550100"), "(763) 555-0100");
  assert.equal(D.normalizeEmail(" Pat@Example.COM "), "pat@example.com");
  assert.equal(D.normalizeEmail("not an email"), null);
});

test("names: display name, sort letter, mojibake repair, tidy only for display", () => {
  assert.equal(D.displayName({ first_name: "robin", last_name: "quill" }), "Robin Quill");
  assert.equal(D.displayName({ company_name: "Sample Shop" }), "Sample Shop");
  assert.equal(D.displayName({}), "No name");
  assert.equal(D.initial({ last_name: "& Dan Baker" }), "D");
  assert.equal(D.initial({ first_name: "4th Street" }), "#");
  assert.equal(D.fixMojibake("Jos\u00c3\u00a9"), "Jos\u00e9", "UTF-8 read as Latin-1, repaired");
  assert.equal(D.fixMojibake("Plain"), "Plain");
  assert.equal(D.normName(" José-Luis "), "joseluis");
});

test("addresses: normalized, the state repaired from a Minnesota ZIP, compared by street + ZIP", () => {
  const rep = [];
  const a = D.normalizeAddress({ street: "100 Example Avenue", city: "Delano", state: "Minn.", zip: "55328" }, { repaired: rep });
  assert.equal(a.state, "MN");
  assert.deepEqual(rep, ["state"]);
  assert.equal(D.normalizeAddress({ address_street1: "1 Elm", address_city: "Wayzata", address_state: "minnesota", address_zip: "553911234" }).zip, "55391-1234");
  assert.equal(D.addressKey({ street1: "100 Example Avenue", zip: "55328" }), D.addressKey({ street1: "100 example ave.", zip: "55328-0001" }));
  assert.equal(D.normalizeAddress({}), null);
  assert.equal(D.addressOneLine({ street1: "1 Elm", city: "Delano", state: "MN", zip: "55328" }), "1 Elm, Delano, MN 55328");
});

test("the service area: haversine from Delano, primary / extended / outside, never a refusal", () => {
  const area = { center: { lat: 45.0419, lng: -93.7891 }, radius_mi: 20, towns: ["Delano", "Wayzata"] };
  assert.equal(D.areaTier({ geo: { lat: 45.0419, lng: -93.7891 } }, area).town_tier, "primary");
  const wayzata = D.areaTier({ geo: { lat: 44.9741, lng: -93.5066 } }, area);
  assert.equal(wayzata.town_tier, "primary");
  assert.ok(wayzata.distance_mi > 13 && wayzata.distance_mi < 16, `${wayzata.distance_mi}`);
  assert.equal(D.areaTier({ geo: { lat: 45.0, lng: -93.36 } }, area).town_tier, "extended", "about 21 mi out");
  assert.equal(D.areaTier({ geo: { lat: 44.9778, lng: -93.265 } }, area).town_tier, "outside", "Minneapolis, about 26 mi: flagged, not refused");
  assert.equal(D.areaTier({ geo: { lat: 46.7867, lng: -92.1005 } }, area).town_tier, "outside", "Duluth");
  assert.equal(D.areaTier({ city: "Wayzata" }, area).town_tier, "primary", "no geocode: a listed town");
  assert.equal(D.areaTier({ city: "Nowhere" }, area).town_tier, "unknown");
  assert.ok(Math.abs(D.haversineMi({ lat: 0, lng: 0 }, { lat: 0, lng: 1 }) - 69.09) < 0.1);
});

test("the contact validator: one primary, tags capped and de-duplicated, kind from the names, stored oddities kept", () => {
  const v = T.validateContact({ first_name: "Pat", phones: [{ e164: "7635550100" }, { e164: "(763) 555-0101", primary: true }, { e164: "763-555-0100" }], emails: [{ address: "PAT@example.com" }], tags: ["A", "a", " B "] }, { op: "create" });
  assert.deepEqual(v.phones.map((p) => [p.e164, p.primary]), [["+17635550100", false], ["+17635550101", true]]);
  assert.deepEqual(v.tags, ["A", "B"]);
  assert.equal(v.kind, "person");
  assert.equal(v.display_name, "Pat");
  assert.equal(v.consent.sms_marketing.state, "unknown");
  assert.equal(T.validateContact({ company_name: "Sample Shop", phones: [] }, { op: "create" }).kind, "business");
  assert.throws(() => T.validateContact({ phones: [{ e164: "12" }] }, { op: "create" }), InputError);
  assert.throws(() => T.validateContact({}, { op: "create" }), /name, a phone or an email/);
  // an imported number today's rules refuse is kept on an unrelated edit
  const before = { phones: [{ e164: "+15550100", primary: true }] };
  assert.equal(T.validateContact({ ...before, first_name: "Pat" }, { op: "update", before }).phones[0].e164, "+15550100");
  assert.throws(() => T.validateContact({ tags: Array.from({ length: 31 }, (_, i) => `t${i}`) }, { op: "create", }), /30 tags/);
  const row = T.contactRow({ ...v, id: "ct_x", billing_address: { street1: "1 Elm", city: "Delano", zip: "55328" }, lifecycle: "lead", flags: { vip: true, test: false } });
  assert.deepEqual(row.p, ["7635550100", "7635550101"]);
  assert.deepEqual(row.fl, { vip: true });
  assert.equal(row.c, "Delano");
  assert.ok(!("notes" in row));
});

test("matching never merges on a name alone (R18): phone and email are high, the same name is medium or low", async () => {
  const { done } = fresh();
  try {
    const a = (await store.createRecord("contact", { first_name: "Jordan", last_name: "Sample", phones: [{ e164: "+17635550101" }], emails: [{ address: "jordan@example.com" }], lifecycle: "customer", billing_address: { street1: "1 Elm", city: "Delano", state: "MN", zip: "55328" }, source: { source: "Other" } }, PERSON)).data;
    const b = (await store.createRecord("contact", { first_name: "Jordan", last_name: "Sample", phones: [{ e164: "+17635550102" }], lifecycle: "lead", billing_address: { street1: "9 Oak", city: "Mound", state: "MN", zip: "55364" }, source: { source: "Other" } }, PERSON)).data;
    const byPhone = await match.findMatches({ phones: ["763-555-0101"] });
    assert.deepEqual(byPhone.map((m) => [m.id, m.reason, m.confidence]), [[a.id, "phone", "high"]]);
    const byName = await match.findMatches({ first_name: "jordan", last_name: "SAMPLE", zip: "55328" });
    assert.deepEqual(byName.map((m) => [m.id, m.reason, m.confidence]).sort(), [[a.id, "name_zip", "medium"], [b.id, "name", "low"]].sort());
    // intake never upserts onto a same-name contact without a phone or email match
    const r = await intake.intakeLead({ first_name: "Jordan", last_name: "Sample", phone: "7635550103" }, { origin: "lead-form" });
    assert.ok(r.created, "a new contact, never a merge on the name");
    assert.equal(await match.resolveId(a.id), a.id);
  } finally { done(); }
});

test("intake's fill-only upsert (pure)", () => {
  const n = intake.normalizeInput({ first_name: "New", last_name: "Name", phone: "7635550104", email: "new@example.com", tags: ["Website", "Yard Sign"], notes: "Hi", consent: { sms_service: true, sms_marketing: true } }, "lead-form");
  const c = { first_name: "Old", last_name: "", phones: [{ e164: "+17635550104", primary: true }], emails: [], tags: ["website"], notes: "", consent: { sms_service: { state: "revoked" }, sms_marketing: { state: "unknown" } } };
  const next = intake.upsertFields(c, n, "lead-form");
  assert.equal(next.first_name, "Old", "not clobbered");
  assert.deepEqual(next.tags, ["website", "Yard Sign"], "merged case-insensitively");
  assert.equal(next.consent.sms_service.state, "revoked", "a revocation is never overturned by a form");
  assert.equal(next.consent.sms_marketing.state, "granted");
  assert.equal(next.emails[0].address, "new@example.com");
  assert.equal(intake.upsertFields(next, n, "lead-form"), null, "the same submission again changes nothing");
});

test("the Meta webhook's fields → intake input; tokens match in constant time", () => {
  const i = W.metaInput({ full_name: "Meta Person", phone_number: "+17635550105", email: "meta@example.com", form_name: "Sample Form", ad_name: "Sample Ad", campaign_name: "Fall", where_are_you_located: "Wright County", id: "880000000000011", city: "Delano", zip_code: "55328" });
  assert.equal(i.source.source, "Meta Ads");
  assert.equal(i.source.form, "Sample Form");
  assert.equal(i.source.county, "wright");
  assert.equal(i.provider_lead_id, "880000000000011");
  assert.equal(i.address.zip, "55328");
  assert.match(i.notes, /Meta lead \(form: Sample Form, ad: Sample Ad\)/);
  const tok = W.newHookToken();
  assert.match(tok, W.TOKEN_RE);
  const entry = { id: "abc123", hash: createHash("sha256").update(tok).digest("hex") };
  assert.equal(W.matchToken([entry], tok), entry);
  assert.equal(W.matchToken([entry], tok.slice(0, -1) + (tok.endsWith("A") ? "B" : "A")), null);
  assert.equal(W.matchToken([entry], "not-a-token"), null);
});

test("the list filter and sort (pure)", () => {
  const rows = [
    { id: "ct_1", n: "Pat Zed", f: "Pat", l: "Zed", lc: "customer", p: ["7635550100"], e: [], tg: ["Website"], src: "Website", c: "Delano" },
    { id: "ct_2", n: "Ann Able", f: "Ann", l: "Able", lc: "lead", p: [], e: ["ann@example.com"], tg: [], src: "Meta Ads", c: "Mound" },
    { id: "ct_3", n: "Old One", f: "Old", l: "One", lc: "archived", p: [], e: [], tg: [], src: "", c: "" },
  ];
  assert.deepEqual(R.filterRows(rows, {}).map((r) => r.id), ["ct_1", "ct_2"], "archived hidden by default");
  assert.deepEqual(R.filterRows(rows, { lifecycle: "archived" }).map((r) => r.id), ["ct_3"]);
  assert.deepEqual(R.filterRows(rows, { q: "555 0100" }).map((r) => r.id), ["ct_1"]);
  assert.deepEqual(R.filterRows(rows, { q: "ann@" }).map((r) => r.id), ["ct_2"]);
  assert.deepEqual(R.filterRows(rows, { source: "Meta Ads" }).map((r) => r.id), ["ct_2"]);
  assert.deepEqual(R.filterRows(rows, { tag: "website" }).map((r) => r.id), ["ct_1"]);
  assert.deepEqual(R.sortRows(rows).map((r) => r.id), ["ct_2", "ct_3", "ct_1"]);
});
