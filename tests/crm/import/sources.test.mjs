// Regression tests from the M2c review (design §10.7): one record written by
// several Rotor rows keeps a base PER SOURCE, so
//   - a lead Rotor converted while the export ran (leads.jsonl still holds
//     it, customers.jsonl has the customer) stays a customer;
//   - after the owner merges two Rotor customers, an unchanged weekly import
//     writes nothing and the kept contact keeps its own values;
//   - two phases writing one record (Sales' deal: the lead and its
//     opportunities) merge per field, by rank;
//   - a crash between the record write and the import-base write loses
//     nothing (write-ahead pending base);
//   - a record whose import base is gone (backups skip ib/) still takes
//     Rotor's changes when nobody edited it, and conflicts where someone did;
//   - an unchanged run rebuilds no index.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, store, stageRun, runToEnd, importExport, generate, ids, ownership as O } from "./fixtures.mjs";
import { fixtureModule, fixtureType } from "../../helpers/crm-fixtures.mjs";

const clone = (x) => JSON.parse(JSON.stringify(x));
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const address = { street1: "55 Example Ave", street2: null, city: "Mound", state: "MN", zip: "55364", country: "US" };
const contact = async (id) => (await store.getRecord("contact", id)).data;
const cid = (rid) => ids.idForRotor("contact", rid);

// The team and nothing else; tests add the rows they need.
function bare(seed = 21) {
  const ex = generate({ scale: 0.02, seed });
  const keep = new Set(["members", "member_availability", "rate_settings"]);
  for (const k of Object.keys(ex)) if (!keep.has(k)) ex[k] = [];
  return ex;
}
const customer = (id, n, extra = {}) => ({ id, first_name: "Pat" + n, last_name: "Example", company_name: null, email: `pat${n}@example.com`, phone: `+1763555${String(1000 + n).slice(-4)}`, status: "active", source: "Referral", assigned_to: [], address: { ...address, street1: `${n} Example Ave` }, tags: [], notes: "A", created_at: "2026-08-01T15:00:00+00:00", ...extra });
const lead = (id, extra = {}) => ({ id, name: "Jordan Convert", email: "jordan.convert@example.com", phone: "+17635550444", stage: "New", priority: "medium", source: "Website quote form", service_type: "Exterior Window Cleaning", projected_value: null, follow_up_date: null, assigned_to: null, address, tags: ["Website"], notes: "Customer notes:\nPlease call after 5", created_at: "2026-11-17T15:00:01.123456+00:00", ...extra });

// Sales' deal stands in as a fixture: written by the lead's phase (title,
// notes, stage, value) and by the opportunities' phase (stage, value).
const DEAL = "fixture_deal";
fixtureModule({
  types: [fixtureType(DEAL, "zd", { rotorFields: ["title", "notes", "stage", "value", "rotor"], example: () => ({ title: "Sample deal" }) })],
  importPhases: [
    {
      name: "fixture.deal_from_lead", entity: "leads", after: ["contacts.leads"], normalize: (r) => r,
      map: async (l) => ({ records: [{ type: DEAL, data: { id: ids.idForRotor(DEAL, l.id), title: l.name, notes: l.notes, stage: l.stage, value: l.projected_value, rotor: { lead_id: l.id, stage_raw: l.stage } } }] }),
    },
    {
      name: "fixture.deal_from_opportunity", entity: "opportunities", after: ["fixture.deal_from_lead"], normalize: (r) => r,
      map: async (o) => ({ records: [{ type: DEAL, data: { id: ids.idForRotor(DEAL, o.contact_id), stage: o.stage_name, value: o.value, rotor: { opportunity_ids: [o.id], pipeline_raw: o.pipeline } } }] }),
    },
  ],
});
const deal = async (lid) => { const g = await store.getRecord(DEAL, ids.idForRotor(DEAL, lid)); return g && g.data; };

test("R3: a lead Rotor converted during the export stays the customer (leads.jsonl still holds the lead; one contact; rotor.customer_id kept)", async () => {
  const { t, owner } = await setup();
  try {
    const L = uuid(101), K = uuid(102);
    const week1 = bare();
    week1.leads = [lead(L)];
    await importExport(t, owner, week1);
    const X = cid(L);
    assert.equal((await contact(X)).lifecycle, "lead");
    // week 2: leads were exported before the conversion, customers after (customers last, R3)
    const week2 = bare();
    week2.leads = [lead(L)];
    week2.customers = [{ id: K, first_name: "Jordan", last_name: "Convert", company_name: null, email: "jordan.convert@example.com", phone: "+17635550444", status: "active", source: "Website quote form", assigned_to: [], address, tags: ["Website"], notes: "Converted from lead on 11/20/2026\n\nOriginal Lead Notes:\nCustomer notes:\nPlease call after 5", created_at: "2026-11-20T15:00:00.5+00:00" }];
    week2.quote_contacts = [{ id: K, contact_type: "customer", first_name: "Jordan", last_name: "Convert", stripe_customer_id: null, converted_from_lead_id: L, messaging_config: { sms: { opted_in: false } }, muted_channels: [] }];
    const r2 = await importExport(t, owner, week2);
    assert.equal(r2.run.status, "done");
    assert.deepEqual(t.stores.data.keys("rec/contact/"), [`rec/contact/${X}`], "one contact");
    assert.equal((await store.readPointer("rotor/customer", K)).id, X);
    let c = await contact(X);
    assert.equal(c.lifecycle, "customer", "the customer stays a customer");
    assert.equal(c.rotor.customer_id, K, "rotor.customer_id kept");
    assert.ok(c.rotor.lead_ids.includes(L));
    assert.equal(r2.run.summary.conflicts_open, 0);
    // the same export again (the lead still listed): nothing changes, nothing is written
    const wv = c.wv;
    const r3 = await importExport(t, owner, week2);
    c = await contact(X);
    assert.equal(c.lifecycle, "customer");
    assert.equal(c.rotor.customer_id, K);
    assert.equal(c.wv, wv, "an unchanged export writes nothing");
    assert.equal(r3.run.summary.conflicts_open, 0);
    // and a later export where the lead is gone: still the customer
    const week4 = clone(week2);
    week4.leads = [];
    await importExport(t, owner, week4);
    assert.equal((await contact(X)).lifecycle, "customer");
  } finally { t.done(); }
});

test("R3, both in one export from the start: the lead row never turns its customer back into a lead", async () => {
  const { t, owner } = await setup();
  try {
    const L = uuid(111), K = uuid(112);
    const ex = bare();
    ex.leads = [lead(L, { name: "Morgan Sample", phone: "+17635550466", email: "morgan.sample@example.com" })];
    ex.customers = [customer(K, 66, { first_name: "Morgan", last_name: "Sample", phone: "+17635550466", email: "morgan.sample@example.com" })];
    ex.quote_contacts = [{ id: K, contact_type: "customer", first_name: "Morgan", last_name: "Sample", converted_from_lead_id: L, messaging_config: {}, muted_channels: [] }];
    for (let i = 0; i < 2; i++) {
      const r = await importExport(t, owner, ex);
      assert.equal(r.run.status, "done");
      assert.equal(r.run.summary.conflicts_open, 0);
    }
    const all = t.stores.data.keys("rec/contact/");
    assert.equal(all.length, 1, "one contact");
    const c = t.stores.data.json(all[0]);
    assert.equal(c.lifecycle, "customer");
    assert.equal(c.rotor.customer_id, K);
    assert.equal(c.first_name, "Morgan");
  } finally { t.done(); }
});

test("two merged Rotor customers: unchanged weekly imports write nothing and the kept contact keeps its values", async () => {
  const { t, owner } = await setup();
  try {
    const Ka = uuid(501), Kb = uuid(502);
    const ex = bare();
    ex.customers = [
      customer(Ka, 11, { first_name: "Robert", last_name: "Example", status: "active", source: "Referral", notes: "Kept note" }),
      customer(Kb, 12, { first_name: "Bob", last_name: "Exampel", status: "inactive", source: "Google", notes: "Dup note" }),
    ];
    await importExport(t, owner, ex);
    const A = cid(Ka), B = cid(Kb);
    const m = await t.api(`/contacts/${A}/merge`, { method: "POST", as: owner, body: { other_id: B } });
    assert.equal(m.status, 202, JSON.stringify(m.body));
    for (let i = 0; i < 40; i++) {
      const run = (await store.getRecord("run", m.body.data.run_id)).data;
      if (["done", "failed"].includes(run.status)) break;
      await t.runWorker({ lane: "bulk" }); await t.runWorker({ lane: "fast" });
    }
    assert.equal((await contact(B)).merged_into, A);
    const kept = () => contact(A).then((c) => [c.first_name, c.last_name, c.lifecycle, c.rotor.customer_id, c.notes]);
    const want = await kept();
    assert.deepEqual(want.slice(0, 4), ["Robert", "Example", "customer", Ka]);
    // the first import after the merge records Kb's rows as a second source (no value of A's changes)
    const r1 = await importExport(t, owner, ex);
    assert.equal(r1.run.summary.conflicts_open, 0);
    assert.deepEqual(await kept(), want);
    const wv = (await contact(A)).wv;
    const ib = t.stores.data.json(`ib/contact/${A}`);
    assert.deepEqual(Object.keys(ib.sources).sort(), [`customers:${Ka}`, `customers:${Kb}`].sort());
    assert.equal(ib.primary, `customers:${Ka}`);
    // then unchanged weekly imports: no write at all, values stable
    for (let i = 0; i < 2; i++) {
      const r = await importExport(t, owner, ex);
      assert.equal(r.run.summary.conflicts_open, 0);
      assert.equal((await contact(A)).wv, wv, "the kept contact isn't rewritten");
      assert.deepEqual(await kept(), want);
    }
    // Rotor changes the kept row's first name: applied; the merged-away row's last name: kept quietly
    const ex2 = clone(ex);
    ex2.customers[0].first_name = "Rob";
    ex2.customers[1].last_name = "Exampell";
    const r2 = await importExport(t, owner, ex2);
    assert.equal(r2.run.summary.conflicts_open, 0);
    assert.deepEqual(await kept(), ["Rob", "Example", "customer", Ka, want[4]]);
  } finally { t.done(); }
});

test("two phases write one record (a deal from the lead and from its opportunity): merged per field, by rank; quiet when unchanged", async () => {
  const { t, owner } = await setup();
  try {
    const L = uuid(701), O1 = uuid(702);
    const ex = bare();
    ex.leads = [lead(L, { name: "Taylor Deal", phone: "+17635550777", email: "taylor.deal@example.com", projected_value: "300", notes: "From the lead" })];
    ex.opportunities = [{ id: O1, contact_id: L, contact_type: "lead", stage_name: "Quoted", value: 450, pipeline: "Sales" }];
    const r1 = await importExport(t, owner, ex);
    assert.equal(r1.run.status, "done");
    let d = await deal(L);
    assert.deepEqual([d.title, d.notes, d.stage, d.value], ["Taylor Deal", "From the lead", "Quoted", 450], "the opportunity (rank 3) holds stage and value; the lead the rest");
    assert.equal(d.rotor.lead_id, L);
    assert.deepEqual(d.rotor.opportunity_ids, [O1]);
    assert.equal(d.rotor.stage_raw, "New", "the bag keeps both sources' keys");
    const ib = t.stores.data.json(`ib/${DEAL}/${d.id}`);
    assert.deepEqual(Object.keys(ib.sources).sort(), [`leads:${L}`, `opportunities:${O1}`]);
    // unchanged: no write, both phases quiet
    const wv = d.wv;
    const r2 = await importExport(t, owner, ex);
    assert.equal(r2.run.summary.conflicts_open, 0);
    assert.equal((await deal(L)).wv, wv, "an unchanged export doesn't rewrite the deal");
    // the lead's stage moves (rank 2 under the opportunity's 3): the deal keeps the opportunity's;
    // the lead's notes change: applied; the opportunity's value changes: applied
    const ex2 = clone(ex);
    ex2.leads[0].stage = "Contacted";
    ex2.leads[0].notes = "From the lead, updated";
    ex2.opportunities[0].value = 500;
    const r3 = await importExport(t, owner, ex2);
    assert.equal(r3.run.summary.conflicts_open, 0);
    d = await deal(L);
    assert.deepEqual([d.title, d.notes, d.stage, d.value], ["Taylor Deal", "From the lead, updated", "Quoted", 500]);
    assert.equal(d.rotor.stage_raw, "Contacted");
    // a person renames the deal; the lead's name changes in Rotor too: one conflict, from the lead's source
    const g = await store.getRecord(DEAL, d.id);
    await store.updateRecord(DEAL, d.id, (r) => ({ ...r, title: "Taylor's windows" }), { by: "us_00000000000000000001", origin: "api", actor_kind: "user", requestId: "t" });
    assert.ok(g);
    const ex3 = clone(ex2);
    ex3.leads[0].name = "Taylor Dealer";
    const r4 = await importExport(t, owner, ex3);
    const conf = (await t.api(`/import/runs/${r4.ir.id}/conflicts`, { as: owner })).body.data;
    assert.deepEqual(conf.map((c) => [c.type, c.field, c.crm, c.rotor]), [[DEAL, "title", "Taylor's windows", "Taylor Dealer"]]);
    assert.equal((await deal(L)).title, "Taylor's windows");
    // settled for Rotor: the lead's base takes it, the next run is quiet
    assert.equal((await t.api(`/import/conflicts/${conf[0].key}/resolve`, { method: "POST", as: owner, body: { take: "rotor" } })).status, 200);
    assert.equal((await deal(L)).title, "Taylor Dealer");
    const r5 = await importExport(t, owner, ex3);
    assert.equal(r5.run.summary.conflicts_open, 0);
  } finally { t.done(); }
});

// Makes the import-base write that follows X's record write fail once, as a
// crash right after the record write would: the step stops there; the owner
// cancels the run, so it is never retried with the same values.
async function crashAfterRecordWrite(t, owner, ex, X) {
  t.stores.data.beforeConditionalWrite((key, opts, s) => { s.fail({ op: "setJSON", key: `ib/contact/${X}`, times: 1000 }); }, { key: `rec/contact/${X}` });
  const { ir } = await stageRun(t, owner, ex);
  assert.equal((await t.api(`/import/runs/${ir.id}/start`, { method: "POST", as: owner, body: {} })).status, 200);
  await t.runWorker({ lane: "bulk" });
  t.stores.data.clearHooks();
  const s = Object.values(t.stores.data.json(`ib/contact/${X}`).sources)[0];
  assert.ok(s.pending && Object.values((await contact(X)).import.src).includes(s.pending.hash), "the record names the pending base");
  const st = (await store.getRecord("import_run", ir.id)).data.status;
  if (!["failed", "cancelled", "done"].includes(st)) assert.equal((await t.api(`/import/runs/${ir.id}/cancel`, { method: "POST", as: owner, body: {} })).status, 200);
  for (let i = 0; i < 3; i++) await t.runWorker({ lane: "bulk" });
  return ir;
}

test("a crash between the record write and the base write: Rotor's later revert is applied, no change is lost", async () => {
  const { t, owner } = await setup();
  try {
    const K = uuid(202);
    const ex1 = bare();
    ex1.customers = [customer(K, 2)];
    await importExport(t, owner, ex1);
    const X = cid(K);
    const ex2 = clone(ex1);
    ex2.customers[0].notes = "B";
    await crashAfterRecordWrite(t, owner, ex2, X);
    assert.equal((await contact(X)).notes, "B", "the record was written");
    const ib = t.stores.data.json(`ib/contact/${X}`);
    assert.equal(ib.sources[`customers:${K}`].fields.notes, "A", "its base write was lost (the pending copy holds B)");
    assert.equal(ib.sources[`customers:${K}`].pending.fields.notes, "B");
    // a person edits the first name; Rotor reverts the notes to A
    const g = await store.getRecord("contact", X);
    assert.equal((await t.api(`/contacts/${X}`, { method: "PATCH", as: owner, ifMatch: g.etag, body: { first_name: "Patedited" } })).status, 200);
    const ex3 = clone(ex1);
    const r3 = await importExport(t, owner, ex3);
    assert.equal(r3.run.status, "done");
    const c = await contact(X);
    assert.equal(c.notes, "A", "Rotor's revert is applied");
    assert.equal(c.first_name, "Patedited", "the person's edit stays");
    assert.equal(r3.run.summary.conflicts_open, 0);
    const after = t.stores.data.json(`ib/contact/${X}`).sources[`customers:${K}`];
    assert.equal(after.fields.notes, "A");
    assert.equal(after.pending, undefined);
  } finally { t.done(); }
});

test("a crash between the record write and the base write: a person's later edit of an unchanged field is no conflict", async () => {
  const { t, owner } = await setup();
  try {
    const K = uuid(203);
    const ex1 = bare();
    ex1.customers = [customer(K, 3)];
    await importExport(t, owner, ex1);
    const X = cid(K);
    const ex2 = clone(ex1);
    ex2.customers[0].notes = "B";
    await crashAfterRecordWrite(t, owner, ex2, X);
    const g = await store.getRecord("contact", X);
    assert.equal((await t.api(`/contacts/${X}`, { method: "PATCH", as: owner, ifMatch: g.etag, body: { notes: "C (office note)" } })).status, 200);
    const r3 = await importExport(t, owner, ex2);      // Rotor unchanged since B
    assert.equal(r3.run.summary.conflicts_open, 0, "Rotor didn't change the notes since the CRM took B");
    assert.equal((await contact(X)).notes, "C (office note)");
  } finally { t.done(); }
});

test("no import base (a restore skips ib/): Rotor's changes apply to an untouched record; an edited one conflicts where it differs", async () => {
  const { t, owner } = await setup();
  try {
    const K1 = uuid(601), K2 = uuid(602);
    const ex1 = bare();
    ex1.customers = [customer(K1, 21, { notes: "Old note" }), customer(K2, 22, { notes: "Old note 2" })];
    await importExport(t, owner, ex1);
    const X1 = cid(K1), X2 = cid(K2);
    // a person edits X2's notes; then a restore brings rec/ back but not ib/
    const g = await store.getRecord("contact", X2);
    assert.equal((await t.api(`/contacts/${X2}`, { method: "PATCH", as: owner, ifMatch: g.etag, body: { notes: "Office note" } })).status, 200);
    await store.deleteRaw(`ib/contact/${X1}`);
    await store.deleteRaw(`ib/contact/${X2}`);
    const ex2 = clone(ex1);
    ex2.customers[0].notes = "New note from Rotor";
    ex2.customers[0].last_name = "Renamed";
    ex2.customers[1].notes = "Rotor's new note 2";
    const r2 = await importExport(t, owner, ex2);
    assert.equal(r2.run.status, "done");
    const c1 = await contact(X1);
    assert.deepEqual([c1.notes, c1.last_name], ["New note from Rotor", "Renamed"], "untouched since the import: Rotor's changes apply");
    const conf = (await t.api(`/import/runs/${r2.ir.id}/conflicts`, { as: owner })).body.data;
    assert.deepEqual(conf.map((c) => [c.id, c.field, c.crm, c.rotor]), [[X2, "notes", "Office note", "Rotor's new note 2"]], "edited: the differing field conflicts, never a quiet keep");
    assert.equal((await contact(X2)).notes, "Office note");
    // the next unchanged run: X1 quiet, X2's conflict comes back until settled
    const r3 = await importExport(t, owner, ex2);
    assert.equal(r3.run.summary.conflicts_open, 1);
    const c3 = (await t.api(`/import/runs/${r3.ir.id}/conflicts`, { as: owner })).body.data[0];
    assert.equal((await t.api(`/import/conflicts/${c3.key}/resolve`, { method: "POST", as: owner, body: { take: "crm" } })).status, 200);
    const r4 = await importExport(t, owner, ex2);
    assert.equal(r4.run.summary.conflicts_open, 0);
    assert.equal((await contact(X2)).notes, "Office note");
  } finally { t.done(); }
});

test("an unchanged run rebuilds no index and writes no record, base or pointer", async () => {
  const { t, owner } = await setup();
  try {
    const ex = generate({ scale: 0.03, seed: 13 });
    await importExport(t, owner, ex);
    const before = new Map(t.stores.data.keys("").map((k) => [k, t.stores.data.etagOf(k)]));
    const r = await importExport(t, owner, ex);
    assert.equal(r.run.status, "done");
    const changed = t.stores.data.keys("").filter((k) => before.get(k) !== t.stores.data.etagOf(k));
    const bad = changed.filter((k) => /^(ix\/(?!import-runs|runs\/)|rec\/(contact|property|user)\/|ib\/|ptr\/(rotor|phone|email)\/|rel\/)/.test(k));
    assert.deepEqual(bad, [], "no index, record, base, pointer or relation write");
    assert.equal(r.run.summary.created, 0);
    assert.equal(r.run.summary.updated, 0);
  } finally { t.done(); }
});

test("the pure merge: a source never deletes another source's bag keys; a lead row never overrides a customer's base", () => {
  const others = [{ src: "customers:K", rank: 3, base: { lifecycle: "customer", rotor: { customer_id: "K", status_raw: "active" } } }];
  const m = O.mergeFields(["lifecycle", "rotor"], { mode: "own", rank: 2, base: { lifecycle: "lead", rotor: { lead_id: "L" } }, crm: { lifecycle: "customer", rotor: { lead_id: "L", customer_id: "K", status_raw: "active" } }, rotor: { lifecycle: "lead", rotor: { lead_id: "L" } }, others });
  assert.equal(m.next.lifecycle, "customer");
  assert.deepEqual(m.next.rotor, { lead_id: "L", customer_id: "K", status_raw: "active" });
  assert.deepEqual(m.conflicts, []);
  assert.deepEqual(m.changed, []);
});
