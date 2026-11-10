// M2c acceptance: identity resolution (design §11.4 "identity.test.mjs",
// §10.3). A dual-write lead → a weekly import → the lead converts in Rotor
// → another import yields exactly one contact with all its activity (the
// website note, the logged calls, the shadow enrollment, the Rotor lead id
// and the Rotor customer id); a placeholder is overwritten in place (an
// edited one becomes a field conflict); ids need no created_at.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, importExport, store, ids, generate } from "./fixtures.mjs";
import { fixtureModule } from "../../helpers/crm-fixtures.mjs";

const intake = await import("../../../netlify/lib/crm/modules/contacts/intake.mjs");
const contactsImport = await import("../../../netlify/lib/crm/modules/contacts/import-rotor.mjs");
const { tsKey } = await import("../../../netlify/lib/crm/core/clock.mjs");
const clone = (x) => JSON.parse(JSON.stringify(x));
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const contact = async (id) => (await store.getRecord("contact", id)).data;

// The team and nothing else; tests add the rows they need.
function bare(seed = 21) {
  const ex = generate({ scale: 0.02, seed });
  const keep = new Set(["members", "member_availability", "rate_settings"]);
  for (const k of Object.keys(ex)) if (!keep.has(k)) ex[k] = [];
  return ex;
}
const address = { street1: "55 Example Ave", street2: null, city: "Mound", state: "MN", zip: "55364", country: "US" };

// Opportunities name contacts the export may not hold (archived leads, a
// missing customer): a stand-in for Sales' phase (§10.2 row 9) that makes a
// placeholder under exactly idForRotor so the history joins.
fixtureModule({
  importPhases: [{
    name: "fixture.opportunity_contacts", entity: "opportunities", after: ["contacts.leads"],
    normalize: (r) => r,
    async map(o, ctx) {
      if (await ctx.lookup(o.contact_type, o.contact_id)) return {};
      return { records: [contactsImport.placeholderContact(o.contact_id, { name: o.name, kind: o.contact_type })], warnings: ["placeholder"] };
    },
  }],
});

test("§10.3: a dual-write lead, a weekly import, the conversion in Rotor, another import → exactly one contact with all its history", async () => {
  const { t, owner } = await setup();
  try {
    const L = uuid(101), K = uuid(102);
    // the website's dual-write: Rotor answered with its lead id
    const lead = await intake.intakeLead({ name: "Jordan Convert", phone: "7635550444", email: "jordan.convert@example.com", notes: "Website note: please call after 5", address: { street1: "55 Example Ave", city: "Mound", state: "MN", zip: "55364" } }, { origin: "lead-form", rotor: { lead_id: L } });
    assert.ok(lead.ok);
    const C = lead.contact_id;
    // what the team did in the CRM meanwhile: two logged calls and the shadow enrollment (Sales' records stand in as keys on the contact)
    await store.addActivity(C, "call.logged", "tk_00000000000000000001", new Date("2026-11-17T16:00:00Z"));
    await store.addActivity(C, "call.logged", "tk_00000000000000000002", new Date("2026-11-18T16:00:00Z"));
    await store.addRel("contact-enrollments", C, tsKey(new Date("2026-11-17T15:00:00Z")), "en_00000000000000000001");

    // week 1: Rotor still has the lead
    const week1 = bare();
    week1.leads = [{ id: L, name: "Jordan Convert", email: "jordan.convert@example.com", phone: "+17635550444", stage: "New", priority: "medium", source: "Website quote form", service_type: "Exterior Window Cleaning", projected_value: null, follow_up_date: null, assigned_to: null, address, tags: ["Website"], notes: "Customer notes:\nPlease call after 5", created_at: "2026-11-17T15:00:01.123456+00:00" }];
    const r1 = await importExport(t, owner, week1);
    assert.equal(r1.run.status, "done");
    assert.equal(t.stores.data.keys("rec/contact/").length, 1);

    // Rotor converts the lead: the lead is archived (not listable), a new customer id appears
    const week2 = bare();
    week2.customers = [{ id: K, first_name: "Jordan", last_name: "Convert", company_name: null, email: "jordan.convert@example.com", phone: "+17635550444", status: "active", source: "Website quote form", assigned_to: [], address, tags: ["Website"], notes: "Converted from lead on 11/20/2026\n\nOriginal Lead Notes:\nCustomer notes:\nPlease call after 5", created_at: "2026-11-20T15:00:00.5+00:00" }];
    week2.quote_contacts = [{ id: K, contact_type: "customer", first_name: "Jordan", last_name: "Convert", stripe_customer_id: "cus_SAMPLE444", converted_from_lead_id: L, messaging_config: { sms: { opted_in: true } }, muted_channels: [] }];
    const r2 = await importExport(t, owner, week2);
    assert.equal(r2.run.status, "done");
    assert.equal(r2.run.summary.conflicts_open, 0, "a conversion is not a conflict");

    const keys = t.stores.data.keys("rec/contact/");
    assert.deepEqual(keys, [`rec/contact/${C}`], "exactly one contact");
    const c = await contact(C);
    assert.equal(c.lifecycle, "customer");
    assert.equal(c.rotor.customer_id, K, "the Rotor customer id");
    assert.ok(c.rotor.lead_ids.includes(L), "the Rotor lead id");
    assert.match(c.notes, /Website note: please call after 5/, "the website note");
    assert.equal((await store.readPointer("rotor/customer", K)).id, C);
    assert.equal((await store.readPointer("rotor/lead", L)).id, C);
    const acts = await store.listActivity(C, { limit: 10 });
    assert.equal(acts.filter((a) => a.kind === "call.logged").length, 2, "the logged calls");
    assert.deepEqual((await store.listRel("contact-enrollments", C)).map((r) => r.id), ["en_00000000000000000001"], "the shadow enrollment");
    assert.equal(c.consent.sms_service.state, "granted");

    // and the next weekly import of the same export changes nothing
    const r3 = await importExport(t, owner, week2);
    assert.equal(r3.run.summary.conflicts_open, 0);
    assert.equal(r3.run.summary.created, 0);
    assert.deepEqual(t.stores.data.keys("rec/contact/"), [`rec/contact/${C}`]);
  } finally { t.done(); }
});

test("a placeholder is overwritten in place by the real row; an edited placeholder becomes a field conflict", async () => {
  const { t, owner } = await setup();
  try {
    const K1 = uuid(201), K2 = uuid(202);
    const opp = (n, contact_id, name) => ({ id: uuid(300 + n), name, pipeline_id: uuid(1), stage_id: uuid(2), status: "Open", value: null, assigned_to: [], contact_id, contact_type: "customer", notes: null, archived: false, created_at: "2026-11-01T15:00:00+00:00" });
    const ex1 = bare();
    ex1.opportunities = [opp(1, K1, "Morgan Missing"), opp(2, K2, "Quinn Missing")];
    const r1 = await importExport(t, owner, ex1);
    assert.equal(r1.run.status, "done");
    const P1 = ids.idForRotor("contact", K1), P2 = ids.idForRotor("contact", K2);
    const p1 = await contact(P1);
    assert.equal(p1.flags.placeholder, true);
    assert.equal(p1.lifecycle, "archived");
    // someone edits the second placeholder
    const g = await store.getRecord("contact", P2);
    assert.equal((await t.api(`/contacts/${P2}`, { method: "PATCH", as: owner, ifMatch: g.etag, body: { first_name: "Quinnedited" } })).status, 200);
    // the next export holds both customers
    const ex2 = clone(ex1);
    ex2.customers = [
      { id: K1, first_name: "Morgan", last_name: "Found", company_name: null, email: "morgan.found@example.com", phone: "+17635550201", status: "active", source: "Referral", assigned_to: [], address, tags: [], notes: null, created_at: "2026-08-01T15:00:00+00:00" },
      { id: K2, first_name: "Quincy", last_name: "Found", company_name: null, email: "quinn.found@example.com", phone: "+17635550202", status: "active", source: "Referral", assigned_to: [], address, tags: [], notes: null, created_at: "2026-08-01T15:00:00+00:00" },
    ];
    const r2 = await importExport(t, owner, ex2);
    assert.equal(r2.run.status, "done");
    const c1 = await contact(P1);
    assert.equal(c1.id, P1, "the same id: overwritten in place");
    assert.equal(c1.flags.placeholder, undefined, "no longer a placeholder");
    assert.deepEqual([c1.first_name, c1.last_name, c1.lifecycle], ["Morgan", "Found", "customer"]);
    assert.equal((await store.readPointer("rotor/customer", K1)).id, P1);
    assert.equal(t.stores.data.keys("rec/contact/").length, 2, "no second contact");
    const conflicts = await t.api(`/import/runs/${r2.ir.id}/conflicts`, { as: owner });
    assert.deepEqual(conflicts.body.data.map((c) => [c.id, c.field, c.crm, c.rotor]), [[P2, "first_name", "Quinnedited", "Quincy"]], "the edited placeholder: one field conflict");
    assert.equal((await contact(P2)).last_name, "Found", "its other fields took the real row");
  } finally { t.done(); }
});

test("ids need no created_at: the same rows with other timestamps land on the same records", async () => {
  const { t, owner } = await setup();
  try {
    const ex = generate({ scale: 0.02, seed: 31 });
    for (const k of ["opportunities", "messages", "jobs", "visits", "invoices", "payments", "quotes", "service_plans"]) ex[k] = [];
    await importExport(t, owner, ex);
    const before = t.stores.data.keys("rec/contact/");
    // Rotor trims trailing zeros of its 4-6 fractional digits: the same instant written differently, or a different instant
    const ex2 = clone(ex);
    for (const c of [...ex2.customers, ...ex2.leads]) c.created_at = c.created_at.replace(/\.(\d{3})\d*\+/, ".$1+");
    const r2 = await importExport(t, owner, ex2);
    assert.equal(r2.run.summary.created, 0);
    assert.deepEqual(t.stores.data.keys("rec/contact/"), before);
    const ex3 = clone(ex);
    for (const c of ex3.customers) c.created_at = "2026-01-01T00:00:00+00:00";
    const r3 = await importExport(t, owner, ex3);
    assert.equal(r3.run.summary.created, 0, "a changed creation time never mints a new id");
    assert.deepEqual(t.stores.data.keys("rec/contact/"), before);
    assert.equal(ids.idForRotor("contact", ex.customers[0].id), ids.idForRotor("contact", ex.customers[0].id));
  } finally { t.done(); }
});
