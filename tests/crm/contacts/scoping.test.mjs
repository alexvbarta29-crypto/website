// M2a acceptance: tech scoping (design §11.4 "scoping.test.mjs", §4.5, §4.6).
import { test } from "node:test";
import assert from "node:assert/strict";
import { crmTest } from "../../helpers/crm-http.mjs";
import { store, ids, PERSON } from "./fixtures.mjs";

// A visit of the tech's for a contact, the way scheduling (M4a) will keep it:
// rec/visit/{id} plus rel/tech-visits/{uid}/{local date}--{visitId}.
async function visitFor(techId, contactId, date = "2026-11-18") {
  const id = ids.newId("visit");
  await store.settledWrite(`rec/visit/${id}`, { id, type: "visit", v: 1, wv: 1, contact_id: contactId, assignee_ids: [techId], date, created_at: "2026-11-17T15:00:00.000Z" }, { onlyIfNew: true });
  await store.addRel("tech-visits", techId, date, id);
  return id;
}

test("GET /contacts and /contacts/index → 403 for a tech; the office gets them", async () => {
  const t = await crmTest();
  try {
    const owner = await t.user("owner");
    const admin = await t.user("admin");
    const tech = await t.user("tech");
    await store.createRecord("contact", { first_name: "Pat", last_name: "Example", phones: [{ e164: "+17635550100" }], lifecycle: "customer", source: { source: "Other" } }, { ...PERSON, by: owner.id });
    for (const path of ["/contacts", "/contacts/index", "/merge-candidates", "/search?q=pat"]) {
      assert.equal((await t.api(path, { as: tech })).status, 403, `${path} is not for a tech`);
    }
    const ix = await t.api("/contacts/index", { as: admin });
    assert.equal(ix.status, 200);
    assert.equal(ix.body.data.rows.length, 1);
    assert.ok(ix.headers.get("etag"));
    const again = await t.api("/contacts/index", { as: admin, headers: { "if-none-match": ix.headers.get("etag") } });
    assert.equal(again.status, 304, "unchanged: 304");
    const list = await t.api("/contacts?q=555-0100", { as: owner });
    assert.equal(list.body.data.length, 1, "phone digits find the row");
    assert.equal(list.body.meta.total, 1);
  } finally { t.done(); }
});

test("a tech's quick lead answers only { contact_id } and leaves a merge candidate on a match", async () => {
  const t = await crmTest();
  try {
    const owner = await t.user("owner");
    const tech = await t.user("tech");
    const known = (await store.createRecord("contact", { first_name: "Morgan", last_name: "Sample", phones: [{ e164: "+17635550110" }], emails: [{ address: "morgan.sample@example.com" }], lifecycle: "customer", source: { source: "Other" }, notes: "Gate code on file." }, { ...PERSON, by: owner.id })).data;
    const res = await t.api("/contacts", { method: "POST", as: tech, body: { name: "Morgan Sample", phone: "763-555-0110", services: ["Gutter Cleaning"], notes: "Neighbor of today's stop", client_id: "11111111-2222-4333-8444-555555555555" } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(Object.keys(res.body.data), ["contact_id"], "nothing about who else has that number");
    assert.ok(!JSON.stringify(res.body).includes(known.id));
    assert.ok(!JSON.stringify(res.body).includes("Gate code"));
    const c = (await store.getRecord("contact", res.body.data.contact_id)).data;
    assert.equal(c.lifecycle, "lead");
    assert.ok(c.notes.includes("Neighbor of today's stop"));
    const cands = t.stores.data.keys("rec/merge_candidate/");
    assert.equal(cands.length, 1, "the office gets a merge candidate");
    const cand = (await store.getRecord("merge_candidate", cands[0].split("/").pop())).data;
    assert.deepEqual([cand.a, cand.b].sort(), [known.id, c.id].sort());
    // a double tap (same client id) is one lead
    const twice = await t.api("/contacts", { method: "POST", as: tech, body: { name: "Morgan Sample", phone: "763-555-0110", client_id: "11111111-2222-4333-8444-555555555555" } });
    assert.equal(twice.body.data.contact_id, c.id);
    // the office creating the same person is warned instead
    const office = await t.api("/contacts", { method: "POST", as: owner, body: { first_name: "Morgan", last_name: "Sample", phone: "(763) 555-0110" } });
    assert.equal(office.status, 409);
    assert.equal(office.body.error.code, "possible_duplicate");
    assert.ok(office.body.error.details.matches.some((m) => m.id === known.id));
    const forced = await t.api("/contacts", { method: "POST", as: owner, body: { first_name: "Morgan", last_name: "Sample", phone: "(763) 555-0110", force: true } });
    assert.equal(forced.status, 201);
  } finally { t.done(); }
});

test("one contact for a tech: 404 outside their visit window, tech fields only inside it", async () => {
  const t = await crmTest();
  try {
    const owner = await t.user("owner");
    const tech = await t.user("tech");
    const other = await t.user("tech");
    const c = (await store.createRecord("contact", { first_name: "Riley", last_name: "Placeholder", phones: [{ e164: "+17635550120" }], emails: [{ address: "riley@example.com" }], lifecycle: "customer", source: { source: "Other" }, notes: "Private office notes." }, { ...PERSON, by: owner.id })).data;
    await store.createRecord("property", { contact_id: c.id, label: "Home", address: { street1: "120 Example Ave", city: "Delano", state: "MN", zip: "55328" }, access: { gate_code: "1234" } }, { ...PERSON, by: owner.id });
    assert.equal((await t.api(`/contacts/${c.id}`, { as: tech })).status, 404);
    await visitFor(tech.id, c.id);
    const r = await t.api(`/contacts/${c.id}`, { as: tech });
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body.data.contact).sort(), ["display_name", "first_name", "id", "phones"]);
    assert.ok(!JSON.stringify(r.body).includes("Private office notes"));
    assert.ok(!("stats" in r.body.data));
    assert.equal(r.body.data.properties[0].access.gate_code, "1234", "the property's access notes are for the tech at the door");
    assert.equal((await t.api(`/contacts/${c.id}`, { as: other })).status, 404, "another tech without the visit");
    assert.equal((await t.api(`/contacts/${c.id}`, { method: "PATCH", as: tech, ifMatch: '"1"', body: { first_name: "X" } })).status, 403);
    const act = await t.api(`/contacts/${c.id}/activity`, { as: tech });
    assert.equal(act.status, 200);
    assert.ok(!JSON.stringify(act.body).includes("contact.create"), "no office history for a tech");
    // a visit out of the window (40 days ahead) opens nothing
    const far = (await store.createRecord("contact", { first_name: "Far", last_name: "Away", phones: [{ e164: "+17635550121" }], lifecycle: "customer", source: { source: "Other" } }, { ...PERSON, by: owner.id })).data;
    await visitFor(tech.id, far.id, "2026-12-30");
    assert.equal((await t.api(`/contacts/${far.id}`, { as: tech })).status, 404);
  } finally { t.done(); }
});
