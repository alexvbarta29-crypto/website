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

test("the three-way rules, one field at a time, per source", () => {
  // one field from one source S: B = S's base, C = the record, N = Rotor's value now
  const one = (b, c, n, opts = {}, f = "last_name") => {
    const m = O.mergeFields([f], { base: b === undefined ? {} : { [f]: b }, crm: { [f]: c }, rotor: { [f]: n }, ...opts });
    return { value: m.next[f], conflict: m.conflicts.includes(f), kept: m.kept.includes(f), base: m.base[f] };
  };
  assert.deepEqual(one("A", "A", "B"), { value: "B", conflict: false, kept: false, base: "B" }, "C = B: Rotor's value");
  assert.deepEqual(one("A", "C", "A"), { value: "C", conflict: false, kept: false, base: "A" }, "N = B: the CRM's value");
  assert.equal(one("A", "C", "C").value, "C");
  assert.deepEqual(one("A", "C", "B"), { value: "C", conflict: true, kept: false, base: "A" }, "both changed: a conflict, the CRM's value stays, the old base stays");
  assert.deepEqual(one(undefined, "C", "B", { mode: "new" }), { value: "C", conflict: false, kept: true, base: "B" }, "a source that never wrote the record keeps it quietly");
  assert.deepEqual(one(undefined, "C", "B", { mode: "unknown" }), { value: "C", conflict: true, kept: false, base: undefined }, "no base and an edited record (after a restore): a conflict, never a quiet keep");
  assert.equal(one(undefined, "", null).conflict, false, "blank is blank");
  assert.equal(one(undefined, "", "B", { mode: "unknown" }).value, "B", "an empty field is filled");
  // lists of plain values merge as sets: S's removals and additions, the CRM's additions
  assert.deepEqual(one(["a", "b"], ["a", "b", "mine"], ["a", "c"], {}, "tags").value, ["a", "mine", "c"]);
  assert.deepEqual(one(undefined, ["a", "x"], ["a", "y"], { mode: "new" }, "tags").value, ["a", "x", "y"], "a new source only adds");
  // lists of objects (phones) are one value: both changed → conflict
  assert.equal(one([{ e164: "+17635550101" }], [{ e164: "+17635550102" }], [{ e164: "+17635550103" }], {}, "phones").conflict, true);
  // another source holds the value: the higher rank takes it over, else it stays quietly
  const lead = { src: "leads:L1", rank: 2, base: { last_name: "Lead" } };
  assert.equal(one(undefined, "Lead", "Cust", { mode: "new", rank: 3, others: [lead] }).value, "Cust", "the customer row takes over its lead's value");
  const cust = { src: "customers:C1", rank: 3, base: { last_name: "Cust" } };
  assert.deepEqual(one("L", "Cust", "L2", { rank: 2, others: [cust] }), { value: "Cust", conflict: false, kept: true, base: "L2" }, "a lead row never overrides its customer");
  const ka = { src: "customers:Ka", rank: 3, base: { last_name: "Ka" } };
  assert.equal(one("Kb", "Ka", "Kb2", { rank: 3, others: [ka] }).value, "Ka", "a merged-away duplicate never overwrites the kept contact (equal rank)");
  // the import's own bag: never a conflict; *_ids lists are unions, S's changed scalars win
  const bag = O.mergeBag({ customer_id: "x", lead_ids: [], tags_raw: ["a"], status_raw: "active" }, { customer_id: "x", lead_ids: ["L1"], tags_raw: ["a"], status_raw: "active", converted_from_lead_id: "L1" }, { customer_id: "x", lead_ids: [], tags_raw: ["b"], status_raw: "inactive" });
  assert.deepEqual(bag, { customer_id: "x", lead_ids: ["L1"], tags_raw: ["b"], status_raw: "inactive", converted_from_lead_id: "L1" });
  // a key S stops sending goes only if it still holds S's value; another source's keys stay
  assert.deepEqual(O.mergeBag({ lead_id: "L1", source_raw: "Meta" }, { lead_id: "L1", source_raw: "Meta", customer_id: "C1", status_raw: "active" }, { lead_id: "L1" }), { lead_id: "L1", customer_id: "C1", status_raw: "active" });
  // whole records
  const m = O.mergeFields(["first_name", "last_name", "notes"], { base: { first_name: "Pat", last_name: "Old", notes: "n1" }, crm: { first_name: "Pat", last_name: "Human", notes: "n1" }, rotor: { first_name: "Patricia", last_name: "Rotor", notes: "n2" } });
  assert.deepEqual(m.conflicts, ["last_name"]);
  assert.deepEqual([m.next.first_name, m.next.last_name, m.next.notes], ["Patricia", "Human", "n2"]);
  assert.equal(m.base.last_name, "Old", "a conflicting field keeps its old base, so it comes back until it is settled");
  assert.equal(m.base.notes, "n2");
  assert.deepEqual(m.changed.sort(), ["first_name", "notes"], "only changed fields are written");
  const l = O.mergeFields(["first_name", "billing_address"], { mode: "new", crm: { first_name: "Riley" }, rotor: { first_name: "R", billing_address: { street1: "1 Example Ave" } } });
  assert.deepEqual(l.next, { first_name: "Riley", billing_address: { street1: "1 Example Ave" } });
  assert.deepEqual(l.kept, ["first_name"]);
  assert.equal(O.rankOf("customers:x"), 3);
  assert.equal(O.rankOf("leads:x"), 2);
  assert.equal(O.rankOf("jobs:x"), 1);
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
