// Properties through full imports (design §10.2 row 10; regression tests
// from the review of the import): a property is made by the FIRST import
// that sees its address, also for a contact the export no longer lists; a
// quote or visit an earlier import made without its property takes it; a
// contact with more than a screenful of properties gets no duplicates, from
// the import, from ensureProperty, or lost in a merge. Synthetic data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, importExport, store, runner, generate, ids, IMPORT } from "../import/fixtures.mjs";
import { advance, days } from "../../helpers/crm-clock.mjs";

const { getModule } = await import("../../../netlify/lib/crm/core/registry.mjs");
const { addressKey } = await import("../../../netlify/lib/crm/modules/contacts/display.mjs");
const P = await import("../../../netlify/lib/crm/modules/contacts/properties.mjs");
const { deployContext } = await import("../../../netlify/lib/crm/core/context.mjs");
const clone = (v) => JSON.parse(JSON.stringify(v));
const pad = (n, w = 12) => String(n).padStart(w, "0");
const scope = (fn, extra = {}) => store.withStoreScope({ deploy: deployContext(new Request("https://www.bartawindowwashing.com/"), {}), requestId: "t", ...extra }, fn);
const all = (t, type) => t.stores.data.keys(`rec/${type}/`).map((k) => t.stores.data.json(k));
const created = (st) => Object.fromEntries(Object.entries(st.phases).map(([name, p]) => [name, Object.values(p.records || {}).reduce((s, x) => s + (x.created || 0), 0)]).filter(([, c]) => c > 0));

// A quote and a job with its visit of two customers the export no longer lists, each at its own address.
function withMissingCustomers(ex) {
  const out = clone(ex);
  const q = clone(out.quotes.find((x) => x.contact_type === "customer"));
  q.id = "bbbbbbbb-0000-4000-8000-000000000001"; q.quote_number = 950001; q.contact_id = "cccccccc-0000-4000-8000-000000000001"; q.contact_type = "customer"; q.status = "sent";
  q.jobs_config = { ...q.jobs_config, property_id: 995001, same_as_customer_address: false, property_street1: "41 Sample Way", property_street2: "", property_city: "Delano", property_state: "MN", property_zip: "55328", property_country: "US" };
  out.quotes.push(q);
  const j = clone(out.jobs[0]);
  j.id = "dddddddd-0000-4000-8000-000000000001"; j.job_number = "0950001"; j.customer = { id: "cccccccc-0000-4000-8000-000000000002", first_name: "Rowan", last_name: "Placeholder", company_name: null }; j.service_plan_id = null;
  j.line_items = (j.line_items || []).map((l, k) => ({ ...l, id: `eeeeeeee-0000-4000-8000-00000000000${k}`, job_id: j.id }));
  out.jobs.push(j);
  const v = clone(out.visits[0]);
  v.id = 895001; v.job_id = j.id; v.job = { ...v.job, id: j.id, job_number: j.job_number }; v.customer = j.customer;
  v.address = { street1: "43 Sample Way", city: "Delano", state: "MN", zip: "55328", country: "US" };
  out.visits.push(v);
  return { ex: out, q, v, j };
}
const quoteOf = (t, q) => all(t, "quote").find((x) => x.rotor && x.rotor.quote_id === q.id);
const visitOf = (t, v) => all(t, "visit").find((x) => x.rotor && String(x.rotor.visit_id) === String(v.id));

test("a quote and a visit of customers the export no longer lists: the placeholder contact and the property are made by the first import; the next one changes nothing", async () => {
  const { t, owner } = await setup();
  try {
    const { ex, q, v } = withMissingCustomers(generate({ scale: 0.02, seed: 72 }));
    const r1 = await importExport(t, owner, ex);
    assert.equal(r1.run.status, "done");
    const st1 = await runner.loadState(r1.ir.id);
    for (const ph of ["contacts.properties_quotes", "contacts.properties_visits"]) assert.equal(st1.phases[ph].warnings.property_no_contact || 0, 0, `${ph}: no address left for the next import`);
    assert.ok(st1.phases["contacts.properties_quotes"].warnings.placeholder >= 1 && st1.phases["contacts.properties_visits"].warnings.placeholder >= 1);
    // the placeholder contacts (named where the row names the person) and their pointers
    const c1 = t.stores.data.json(`rec/contact/${ids.idForRotor("contact", q.contact_id)}`);
    const c2 = t.stores.data.json(`rec/contact/${ids.idForRotor("contact", v.customer.id)}`);
    assert.equal(c1.flags.placeholder, true);
    assert.equal(c2.flags.placeholder, true);
    assert.deepEqual([c2.first_name, c2.last_name], ["Rowan", "Placeholder"]);
    assert.equal((await store.readPointer("rotor/customer", q.contact_id)).id, c1.id);
    // each has its property, and the quote and the visit are at it, from the first import on
    const quote = quoteOf(t, q), visit = visitOf(t, v);
    const p1 = t.stores.data.json(`rec/property/${quote.property_id}`);
    const p2 = t.stores.data.json(`rec/property/${visit.property_id}`);
    assert.deepEqual([p1.contact_id, p1.address.street1, p1.rotor.property_id], [c1.id, "41 Sample Way", 995001]);
    assert.deepEqual([p2.contact_id, p2.address.street1], [c2.id, "43 Sample Way"]);
    assert.equal(quote.contact_id, c1.id);
    // the same export again, days later: nothing created, nothing rewritten
    for (let n = 2; n <= 3; n++) {
      advance(days(3));
      const before = new Map(t.stores.data.keys("").map((k) => [k, t.stores.data.etagOf(k)]));
      const r = await importExport(t, owner, ex);
      assert.deepEqual(created(await runner.loadState(r.ir.id)), {}, `import ${n} creates nothing`);
      assert.equal(r.run.summary.updated, 0);
      const rewritten = t.stores.data.keys("").filter((k) => before.get(k) !== t.stores.data.etagOf(k) && /^rec\/(property|quote|visit|job|contact)\//.test(k));
      assert.deepEqual(rewritten, []);
    }
    // when Rotor lists the customer again, the real row takes the placeholder over; the property stays theirs
    const ex2 = clone(ex);
    ex2.customers.push({ ...clone(ex.customers[0]), id: v.customer.id, first_name: "Rowan", last_name: "Returned", email: "rowan.returned@example.com", phone: "+17635550988" });
    advance(days(3));
    await importExport(t, owner, ex2);
    const back = t.stores.data.json(`rec/contact/${c2.id}`);
    assert.deepEqual([back.last_name, !!(back.flags && back.flags.placeholder)], ["Returned", false]);
    assert.equal(t.stores.data.json(`rec/property/${p2.id}`).contact_id, c2.id);
  } finally { t.done(); }
});

test("a quote and a visit an earlier import made without their property take it on the next import (also when nothing else on them changed)", async () => {
  const { t, owner } = await setup();
  const undo = [];
  try {
    const { ex, q, v } = withMissingCustomers(generate({ scale: 0.02, seed: 73 }));
    // the first import as the code before this fix did it: an address whose contact isn't known yet makes nothing
    for (const name of ["contacts.properties_quotes", "contacts.properties_visits"]) {
      const ph = getModule("contacts").importPhases.find((p) => p.name === name);
      const orig = ph.map;
      ph.map = async (row, ctx) => ([q.id, String(v.id)].includes(String(row.id)) ? { warnings: ["property_no_contact"] } : orig(row, ctx));
      undo.push(() => { ph.map = orig; });
    }
    await importExport(t, owner, ex);
    undo.splice(0).forEach((f) => f());
    assert.equal(quoteOf(t, q).property_id, undefined, "the quote was made without a property");
    assert.equal(visitOf(t, v).property_id, undefined);
    assert.equal(all(t, "property").filter((p) => /4[13] Sample Way/.test(p.address.street1)).length, 0);
    // the next import: the properties are made (their contacts are the placeholders now) and the quote and the visit take them
    advance(days(7));
    const r2 = await importExport(t, owner, ex);
    const st2 = await runner.loadState(r2.ir.id);
    assert.deepEqual(created(st2), { "contacts.properties_quotes": 1, "contacts.properties_visits": 1 });
    const quote = quoteOf(t, q), visit = visitOf(t, v);
    assert.equal(t.stores.data.json(`rec/property/${quote.property_id}`).address.street1, "41 Sample Way");
    assert.equal(t.stores.data.json(`rec/property/${visit.property_id}`).address.street1, "43 Sample Way");
    assert.equal(st2.phases["quotes.quotes"].records.quote.unchanged, ex.quotes.length, "the quote itself was unchanged: the property came as a fill");
    // and then nothing more
    advance(days(7));
    const before = new Map(t.stores.data.keys("").map((k) => [k, t.stores.data.etagOf(k)]));
    const r3 = await importExport(t, owner, ex);
    assert.deepEqual(created(await runner.loadState(r3.ir.id)), {});
    assert.deepEqual(t.stores.data.keys("").filter((k) => before.get(k) !== t.stores.data.etagOf(k) && /^rec\/(property|quote|visit|job|contact)\//.test(k)), []);
  } finally { undo.forEach((f) => f()); t.done(); }
});

// One customer with `n` service addresses: `per` quotes at each (Rotor numbers a property per quote) and a visit at each.
function withManyProperties(ex, n, per = 1) {
  const out = clone(ex);
  const cust = out.customers[0];
  const street = (i) => `${100 + i} Sample Way`;
  const q0 = out.quotes.find((q) => q.contact_type === "customer");
  const v0 = out.visits[0];
  for (let k = 0; k < per; k++) for (let i = 0; i < n; i++) {
    const q = clone(q0);
    q.id = `aaaaaaaa-0000-4000-8${pad(k, 3)}-${pad(i)}`; q.quote_number = 900000 + k * 1000 + i; q.contact_id = cust.id; q.contact_type = "customer"; q.status = "sent";
    q.jobs_config = { ...q.jobs_config, property_id: 990000 + k * 1000 + i, same_as_customer_address: false, property_street1: street(i), property_street2: "", property_city: "Delano", property_state: "MN", property_zip: "55328", property_country: "US" };
    out.quotes.push(q);
  }
  for (let i = 0; i < n; i++) {
    const v = clone(v0);
    v.id = 880000 + i; v.customer = { id: cust.id, first_name: cust.first_name, last_name: cust.last_name, company_name: cust.company_name };
    v.address = { street1: street(i), city: "Delano", state: "MN", zip: "55328", country: "US" };
    out.visits.push(v);
  }
  return { ex: out, cust };
}
// time passes between rows, as in a real run (created_at orders a contact's properties)
function tick() {
  const undo = [];
  for (const name of ["contacts", "quotes", "work", "plans"]) for (const p of getModule(name).importPhases || []) {
    const orig = p.map;
    p.map = async (row, ctx) => { advance(7); return orig(row, ctx); };
    undo.push(() => { p.map = orig; });
  }
  return () => undo.forEach((f) => f());
}

test("a contact with more than a screenful of properties: one property per address, however often it is imported", async () => {
  const { t, owner } = await setup();
  const undo = tick();
  try {
    const { ex, cust } = withManyProperties(generate({ scale: 0.02, seed: 71 }), 21, 3);
    const cid = ids.idForRotor("contact", cust.id);
    const mine = () => all(t, "property").filter((p) => p.contact_id === cid && !p.deleted_at);
    for (let n = 1; n <= 4; n++) {
      advance(days(3));
      const r = await importExport(t, owner, ex);
      assert.equal(r.run.status, "done");
      const byAddr = new Map();
      for (const p of mine()) byAddr.set(addressKey(p.address), (byAddr.get(addressKey(p.address)) || 0) + 1);
      assert.deepEqual([...byAddr.values()].filter((c) => c > 1), [], `import ${n}: no address twice`);
      assert.ok(byAddr.size >= 21, `${byAddr.size} addresses`);
      if (n > 1) assert.deepEqual(created(await runner.loadState(r.ir.id)), {}, `import ${n} creates nothing`);
    }
    // every quote's Rotor property id leads to the one property at its address
    const props = mine();
    for (let k = 0; k < 3; k++) for (const i of [0, 9, 20]) {
      const p = await store.readPointer("rotor/property", String(990000 + k * 1000 + i));
      assert.equal(props.find((x) => x.id === p.id).address.street1, `${100 + i} Sample Way`);
    }
  } finally { undo(); t.done(); }
});

test("propertiesOf reads them all; ensureProperty matches an address past the first screenful; a merge moves every property", async () => {
  const { t, owner } = await setup();
  try {
    const W = { by: owner.id, origin: "api", actor_kind: "user", requestId: "t" };
    const mk = async (n) => (await store.createRecord("contact", { first_name: "Many", last_name: `Places${n}`, phones: [{ e164: `+1763555${String(7000 + n)}`, sms: true }], emails: [], lifecycle: "customer", source: { source: "Other" } }, W)).data;
    const a = await mk(1), b = await mk(2);
    const addr = (i) => ({ street1: `${200 + i} Example Ave`, city: "Delano", state: "MN", zip: "55328" });
    // 30 properties on b, made as an import makes them (ids of their own), oldest first
    for (let i = 0; i < 30; i++) {
      await store.createRecord("property", { id: ids.idForRotor("property", `many:${i}`), contact_id: b.id, label: "Property", address: addr(i), access: {}, assets: {}, photo_ids: [] }, { ...IMPORT, bulk: false });
      advance(1000);
    }
    assert.equal((await scope(() => P.propertiesOf(b.id))).length, 30, "all of them");
    assert.equal((await scope(() => P.propertiesOf(b.id, {}, { limit: P.PROPERTIES_ON_SCREEN }))).length, 16, "a screen shows the newest 16");
    // the oldest address (beyond the first 16, newest first): found, nothing new
    const oldest = await scope(() => P.ensureProperty(b.id, { street1: "200 example avenue", city: "Delano", state: "MN", zip: "55328" }, W));
    assert.equal(oldest, ids.idForRotor("property", "many:0"));
    assert.equal(all(t, "property").filter((p) => p.contact_id === b.id).length, 30);
    // a new address: made once, and found again by its own id without looking through the others
    const fresh = await scope(() => P.ensureProperty(b.id, { street1: "9 New Rd", city: "Delano", state: "MN", zip: "55328" }, W));
    const m = t.stores.data.calls.length;
    assert.equal(await scope(() => P.ensureProperty(b.id, { street1: "9 New Rd", city: "Delano", state: "MN", zip: "55328" }, W)), fresh);
    assert.ok(t.stores.data.calls.slice(m).filter((c) => /^get/.test(c.op)).length <= 3, "its own id, then the contact");
    assert.equal(all(t, "property").filter((p) => p.contact_id === b.id).length, 31);
    // inside a request (25 storage calls): it reads the newest 16 and what the budget still allows, and never fails
    const budget = store.withBudget(8000, 25, { strict: true });
    const seen = await scope(() => P.propertiesOf(b.id), { budget });
    assert.ok(seen.length >= 16 && seen.length < 31, `${seen.length} read inside a request`);
    assert.ok(budget.calls() <= 25);
    // the contact's screen and its properties route still answer
    assert.equal((await t.api(`/contacts/${b.id}`, { as: owner })).status, 200);
    assert.equal((await t.api(`/contacts/${b.id}/properties`, { as: owner })).body.data.length, 16);
    // a merge moves all 31 to the contact that stays
    const merged = await t.api(`/contacts/${a.id}/merge`, { method: "POST", as: owner, body: { other_id: b.id } });
    assert.equal(merged.status, 202, JSON.stringify(merged.body));
    for (let i = 0; i < 60; i++) {
      const run = (await store.getRecord("run", merged.body.data.run_id)).data;
      if (["done", "failed"].includes(run.status)) break;
      await t.runWorker({ lane: "bulk" }); await t.runWorker({ lane: "fast" });
    }
    assert.equal((await store.getRecord("contact", b.id)).data.merged_into, a.id);
    assert.equal(all(t, "property").filter((p) => p.contact_id === a.id).length, 31, "every property moved");
    assert.equal(all(t, "property").filter((p) => p.contact_id === b.id).length, 0);
  } finally { t.done(); }
});
