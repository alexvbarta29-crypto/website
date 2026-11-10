// M2c acceptance: field ownership (design §11.4 "ownership.test.mjs",
// §10.7). A stats or listener update between runs gives zero conflicts; a
// human edit to one field gives exactly one field conflict while the other
// fields take Rotor's new values; a linked intake contact keeps its values.
// Plus the pure rules of the three-way merge.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, importExport, store, ownership as O, ids, generate, AUTOMATION, rotorSnapshot } from "./fixtures.mjs";

const intake = await import("../../../netlify/lib/crm/modules/contacts/intake.mjs");
const clone = (x) => JSON.parse(JSON.stringify(x));

// A small export: the team, a few customers and leads, nothing else.
function mini({ customers = 4, leads = 3, seed = 11 } = {}) {
  const ex = generate({ scale: 0.05, seed });
  const keep = new Set(["members", "member_availability", "rate_settings"]);
  for (const k of Object.keys(ex)) if (!keep.has(k)) ex[k] = [];
  const full = generate({ scale: 0.05, seed });
  ex.customers = full.customers.slice(15, 15 + customers);
  ex.leads = full.leads.slice(13, 13 + leads);
  return ex;
}
const cid = (rid) => ids.idForRotor("contact", rid);
const contact = async (id) => (await store.getRecord("contact", id)).data;

test("the three-way rules, one field at a time", () => {
  const t3 = (b, c, n, f = "last_name") => O.threeWay(f, b, c, n);
  assert.deepEqual(t3("A", "A", "B"), { value: "B", outcome: "rotor" }, "CRM = base: Rotor's value");
  assert.deepEqual(t3("A", "C", "A"), { value: "C", outcome: "crm" }, "Rotor = base: the CRM's value");
  assert.deepEqual(t3("A", "C", "C"), { value: "C", outcome: "same" });
  assert.deepEqual(t3("A", "C", "B"), { value: "C", outcome: "conflict" }, "both changed: a conflict, the CRM's value stays");
  assert.equal(O.threeWay("last_name", "A", "C", "B", { quiet: true }).outcome, "crm", "relinked: kept quietly");
  assert.equal(t3(undefined, "", null).outcome, "same", "blank is blank");
  // lists of plain values merge as sets: Rotor's removals and additions, the CRM's additions
  assert.deepEqual(O.threeWay("tags", ["a", "b"], ["a", "b", "mine"], ["a", "c"]).value, ["a", "mine", "c"]);
  assert.equal(O.threeWay("tags", ["a"], ["a", "x"], ["a", "y"]).outcome, "merged");
  // lists of objects (phones) are one value: both changed → conflict
  assert.equal(O.threeWay("phones", [{ e164: "+17635550101" }], [{ e164: "+17635550102" }], [{ e164: "+17635550103" }]).outcome, "conflict");
  // the import's own bag: never a conflict; *_ids lists are unions, Rotor's changed scalars win
  const bag = O.threeWay("rotor", { customer_id: "x", lead_ids: [], tags_raw: ["a"], status_raw: "active" }, { customer_id: "x", lead_ids: ["L1"], tags_raw: ["a"], status_raw: "active", converted_from_lead_id: "L1" }, { customer_id: "x", lead_ids: [], tags_raw: ["b"], status_raw: "inactive" });
  assert.deepEqual(bag.value, { customer_id: "x", lead_ids: ["L1"], tags_raw: ["b"], status_raw: "inactive", converted_from_lead_id: "L1" });
  // whole records
  const m = O.mergeFields(["first_name", "last_name", "notes"], { mode: "edited", base: { first_name: "Pat", last_name: "Old", notes: "n1" }, crm: { first_name: "Pat", last_name: "Human", notes: "n1" }, rotor: { first_name: "Patricia", last_name: "Rotor", notes: "n2" } });
  assert.deepEqual(m.conflicts, ["last_name"]);
  assert.deepEqual([m.next.first_name, m.next.last_name, m.next.notes], ["Patricia", "Human", "n2"]);
  assert.equal(m.base.last_name, "Old", "a conflicting field keeps its old base, so it comes back until it is settled");
  assert.equal(m.base.notes, "n2");
  const l = O.mergeFields(["first_name", "billing_address"], { mode: "linked", crm: { first_name: "Riley" }, rotor: { first_name: "R", billing_address: { street1: "1 Example Ave" } } });
  assert.deepEqual(l.next, { first_name: "Riley", billing_address: { street1: "1 Example Ave" } });
  assert.deepEqual(l.kept, ["first_name"]);
  assert.equal(O.hashFields({ b: 1, a: [1, { y: 2, x: 1 }] }), O.hashFields({ a: [1, { x: 1, y: 2 }], b: 1 }), "the hash is over canonical JSON");
});

test("a stats or listener update between runs gives zero conflicts, and the re-run writes nothing", async () => {
  const { t, owner } = await setup();
  try {
    const ex = mini();
    const first = await importExport(t, owner, ex);
    assert.equal(first.run.status, "done");
    const id = cid(ex.customers[0].id);
    // what the system does between runs: a stats part, an automation changing a CRM-owned field, a pointer list
    await store.updateStats(id, "comms", (p) => ({ ...p, last_contacted_at: "2026-11-18T15:00:00.000Z" }), AUTOMATION);
    await store.updateRecord("contact", id, (c) => ({ ...c, automations_paused: { sms: { reason: "A listener paused it", by: "system", at: "2026-11-18T15:00:00.000Z" } } }), AUTOMATION);
    const before = await rotorSnapshot(t.stores);
    const etag = (await store.getRecord("contact", id)).etag;
    const second = await importExport(t, owner, ex);
    assert.equal(second.run.summary.conflicted, 0);
    assert.equal(second.run.summary.conflicts_open, 0);
    assert.equal(second.run.summary.created, 0);
    assert.equal(second.run.summary.updated, 0);
    assert.deepEqual(await rotorSnapshot(t.stores), before, "every rotorField byte-identical");
    assert.equal((await store.getRecord("contact", id)).etag, etag, "nothing was written to the record");
    assert.equal((await contact(id)).automations_paused.sms.reason, "A listener paused it");
  } finally { t.done(); }
});

test("a human edit to one field gives exactly one conflict; the other fields take Rotor's new values; settling it sticks", async () => {
  const { t, owner } = await setup();
  try {
    const ex = mini();
    await importExport(t, owner, ex);
    const [r0, r1] = ex.customers;
    const id0 = cid(r0.id), id1 = cid(r1.id);
    // a person edits one field of each of two contacts
    for (const [id, last] of [[id0, "Humanedit"], [id1, "Keptbyhand"]]) {
      const g = await store.getRecord("contact", id);
      const p = await t.api(`/contacts/${id}`, { method: "PATCH", as: owner, ifMatch: g.etag, body: { last_name: last } });
      assert.equal(p.status, 200, JSON.stringify(p.body));
    }
    // Rotor changes the same field and two others
    const ex2 = clone(ex);
    Object.assign(ex2.customers[0], { last_name: "Rotoredit", notes: "New notes from Rotor", tags: [...ex2.customers[0].tags, "VIP"] });
    Object.assign(ex2.customers[1], { last_name: "Rotorside" });
    const second = await importExport(t, owner, ex2);
    assert.equal(second.run.summary.conflicted, 2, "one record per edited contact");
    assert.equal(second.run.summary.conflicts_open, 2);
    const c0 = await contact(id0);
    assert.equal(c0.last_name, "Humanedit", "the person's value stays while the conflict is open");
    assert.equal(c0.notes, "New notes from Rotor", "the other fields take Rotor's new values");
    assert.ok(c0.tags.includes("VIP"));
    const list = await t.api(`/import/runs/${second.ir.id}/conflicts`, { as: owner });
    assert.equal(list.status, 200);
    assert.equal(list.body.data.length, 2);
    const k0 = list.body.data.find((c) => c.id === id0);
    assert.deepEqual([k0.field, k0.base, k0.crm, k0.rotor], ["last_name", r0.last_name, "Humanedit", "Rotoredit"]);
    assert.ok(k0.label, "the screen can say whose record it is");
    // one field each: exactly one conflict row per edited record
    assert.deepEqual(list.body.data.map((c) => c.field), ["last_name", "last_name"]);
    // settle: take Rotor's on one, keep the CRM's on the other
    const k1 = list.body.data.find((c) => c.id === id1);
    assert.equal((await t.api(`/import/conflicts/${encodeURIComponent(k0.key)}/resolve`, { method: "POST", as: owner, body: { take: "rotor" } })).status, 200);
    assert.equal((await t.api(`/import/conflicts/${encodeURIComponent(k1.key)}/resolve`, { method: "POST", as: owner, body: { take: "crm" } })).status, 200);
    assert.equal((await contact(id0)).last_name, "Rotoredit");
    assert.equal((await contact(id1)).last_name, "Keptbyhand");
    const runRec = (await store.getRecord("import_run", second.ir.id)).data;
    assert.deepEqual(runRec.conflicts, { open: 0, resolved: 2 });
    // the same export again: nothing left to settle
    const third = await importExport(t, owner, ex2);
    assert.equal(third.run.summary.conflicts_open, 0);
    assert.equal((await contact(id1)).last_name, "Keptbyhand", "a kept value stays until Rotor changes it again");
    // a tech can't see or settle conflicts
    const tech = await t.user("tech");
    assert.equal((await t.api(`/import/runs/${second.ir.id}/conflicts`, { as: tech })).status, 403);
  } finally { t.done(); }
});

test("a linked intake contact keeps its values, fills its empty ones, and is quiet on the next run", async () => {
  const { t, owner } = await setup();
  try {
    const ex = mini({ customers: 1, leads: 1 });
    const L = ex.leads[0];
    Object.assign(L, { name: "Rotorname Different", phone: "+17635550777", email: "linked.lead@example.com", source: "Website quote form", address: { street1: "77 Example Ave", street2: null, city: "Delano", state: "MN", zip: "55328", country: "US" } });
    const made = await intake.intakeLead({ name: "Riley Linked", phone: "7635550777", email: "linked.lead@example.com", notes: "From the website form" }, { origin: "lead-form", rotor: { lead_id: L.id } });
    assert.ok(made.ok);
    const before = await contact(made.contact_id);
    assert.equal(before.import, undefined);
    const run = await importExport(t, owner, ex);
    assert.equal(run.run.summary.linked >= 1, true);
    const after = await contact(made.contact_id);
    assert.equal(after.id, made.contact_id, "the same contact, not a new one");
    assert.equal(after.first_name, "Riley");
    assert.equal(after.last_name, "Linked", "the CRM's value is kept");
    assert.match(after.notes, /From the website form/);
    assert.equal(after.billing_address.street1, "77 Example Ave", "an empty field is filled from Rotor");
    assert.ok(after.import && after.import.run_id === run.ir.id, "now linked to the import");
    assert.deepEqual(after.rotor.lead_ids, [L.id]);
    assert.equal(t.stores.data.keys("rec/contact/").length, 2, "one customer + the linked lead, no duplicate");
    const again = await importExport(t, owner, ex);
    assert.equal(again.run.summary.conflicts_open, 0);
    assert.equal((await contact(made.contact_id)).last_name, "Linked");
  } finally { t.done(); }
});

test("a re-run of an unchanged export: 0 conflicts, rotorFields byte-identical, nothing created", async () => {
  const { t, owner } = await setup();
  try {
    const ex = generate({ scale: 0.03, seed: 9 });
    await importExport(t, owner, ex);
    const snap = await rotorSnapshot(t.stores);
    const keys = t.stores.data.keys("rec/");
    const again = await importExport(t, owner, ex);
    assert.equal(again.run.summary.created, 0);
    assert.equal(again.run.summary.updated, 0);
    assert.equal(again.run.summary.conflicts_open, 0);
    assert.deepEqual(await rotorSnapshot(t.stores), snap);
    assert.deepEqual(t.stores.data.keys("rec/").filter((k) => !k.startsWith("rec/import_run/") && !k.startsWith("rec/run/")), keys.filter((k) => !k.startsWith("rec/import_run/") && !k.startsWith("rec/run/")), "no record created");
  } finally { t.done(); }
});
