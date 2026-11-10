// M2a acceptance: stats (design §11.4 "stats.test.mjs", §5.1 "Stats ownership", §3.5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { crmTest } from "../../helpers/crm-http.mjs";
import { seedImportedContact } from "../../helpers/crm-fixtures.mjs";
import { store, PERSON } from "./fixtures.mjs";

const { emit } = await import("../../../netlify/lib/crm/core/events.mjs");
const S = await import("../../../netlify/lib/crm/modules/contacts/stats.mjs");

test("a stats write never changes the contact's etag; a PATCH with the old etag still succeeds; the index row merges both parts by wv", async () => {
  const t = await crmTest();
  try {
    const owner = await t.user("owner");
    const made = await t.api("/contacts", { method: "POST", as: owner, body: { first_name: "Taylor", last_name: "Example", phone: "7635550130", lifecycle: "customer" } });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const id = made.body.data.contact.id;
    const etag = made.headers.get("etag");
    await store.updateStats(id, "contacts", (p) => ({ ...p, customer_since: "2025-04-01" }), { by: "system", origin: "worker", actor_kind: "automation" });
    await store.updateStats(id, "comms", (p) => ({ ...p, last_contacted_at: "2026-11-16T10:00:00.000Z" }), { by: "system", origin: "worker", actor_kind: "automation" });
    const got = await t.api(`/contacts/${id}`, { as: owner });
    assert.equal(got.headers.get("etag"), etag, "stats live in the sidecar, not the contact");
    assert.equal(got.body.data.stats.contacts.customer_since, "2025-04-01");
    const patched = await t.api(`/contacts/${id}`, { method: "PATCH", as: owner, ifMatch: etag, body: { tags: ["VIP street"] } });
    assert.equal(patched.status, 200, "the office's edit never goes stale because of stats");
    const stale = await t.api(`/contacts/${id}`, { method: "PATCH", as: owner, ifMatch: etag, body: { tags: ["again"] } });
    assert.equal(stale.status, 412, "but two people editing still collide");

    const ix = await store.readIndex("contacts", "");
    const row = ix.rows.find((r) => r.id === id);
    assert.equal(row.n, "Taylor Example", "contact part");
    assert.equal(row.lc, "customer", "the lifecycle, not the last-contact time");
    assert.equal(row.cs, "2025-04-01", "stats part");
    assert.equal(row.lca, "2026-11-16T10:00:00.000Z");
    assert.deepEqual(row.tg, ["VIP street"]);
    // an older write of a part never wins over a newer one
    await store.applyIndexRow("contacts", "", id, "stats", { cs: "1999-01-01" }, 1);
    assert.equal((await store.readIndex("contacts", "")).rows.find((r) => r.id === id).cs, "2025-04-01");
    await store.applyIndexRow("contacts", "", id, "contact", { n: "Old name" }, 1);
    assert.equal((await store.readIndex("contacts", "")).rows.find((r) => r.id === id).n, "Taylor Example");
  } finally { t.done(); }
});

test("lifecycle: a completed job makes a lead a customer; an imported contact only gets a would- row before cutover", async () => {
  const t = await crmTest();
  try {
    const owner = await t.user("owner");
    const lead = (await store.createRecord("contact", { first_name: "Alex", last_name: "Sample", phones: [{ e164: "+17635550131" }], lifecycle: "lead", source: { source: "Other" } }, { ...PERSON, by: owner.id })).data;
    const imported = await seedImportedContact(32, { lifecycle: "lead" });
    for (const [cid, jid] of [[lead.id, "jb_00000000000000000001"], [imported.id, "jb_00000000000000000002"]]) {
      await emit("job.completed", { id: jid, wv: 2, job_id: jid, contact_id: cid, kind: "one_time", billable: true, total_cents: 24310, assignee_ids: [], completed_at: "2026-11-17T14:00:00.000Z" }, { by: "system" });
    }
    for (let i = 0; i < 3; i++) await t.runWorker({ lane: "fast" });
    assert.equal((await store.getRecord("contact", lead.id)).data.lifecycle, "customer");
    assert.equal((await store.getRecord("contact_stats", lead.id)).data.contacts.customer_since, "2026-11-17");
    assert.equal((await store.getRecord("contact", imported.id)).data.lifecycle, "lead", "Rotor owns it until cutover");
    assert.ok(t.stores.data.keys("alog/").some((k) => k.includes(imported.id) && k.includes("would-update")));
  } finally { t.done(); }
});

test("the former-customer rule and customer_since (pure)", () => {
  const today = "2026-11-17";
  const row = { lc: "customer", ls: "2024-10-01", nv: null, pl: [] };
  assert.equal(S.becomesFormer(row, today), true, "26 months without service");
  assert.equal(S.becomesFormer({ ...row, ls: "2025-06-01" }, today), false);
  assert.equal(S.becomesFormer({ ...row, nv: "2026-12-01" }, today), false, "a visit ahead");
  assert.equal(S.becomesFormer({ ...row, pl: ["pl_1"] }, today), false, "an active plan");
  assert.equal(S.becomesFormer({ ...row, ls: null }, today), false, "no service history known: left alone");
  assert.equal(S.becomesFormer({ ...row, lc: "lead" }, today), false);
  assert.equal(S.lifecycleOnCustomerEvent({ lifecycle: "lead" }), "customer");
  assert.equal(S.lifecycleOnCustomerEvent({ lifecycle: "former_customer" }), "customer");
  assert.equal(S.lifecycleOnCustomerEvent({ lifecycle: "archived" }), null, "archived stays archived");
  assert.equal(S.lifecycleOnCustomerEvent({ lifecycle: "lead", merged_into: "ct_x" }), null);
});

test("the contacts.stats sweep fills customer_since and turns long-quiet customers former (report-only on imported ones)", async () => {
  const t = await crmTest();
  try {
    const owner = await t.user("owner");
    const c = (await store.createRecord("contact", { first_name: "Casey", last_name: "Example", phones: [{ e164: "+17635550133" }], lifecycle: "customer", source: { source: "Other" } }, { ...PERSON, by: owner.id })).data;
    // a work stats part (M4a) as it will look: last service long ago
    await store.applyIndexRow("contacts", "", c.id, "stats", { ls: "2023-01-01", nv: null, pl: [] }, 99);
    const log = [];
    const ctx = { cursor: null, budget: null, mayAct: () => true, would: async (...a) => log.push(a), write: () => ({ by: "system", origin: "worker", actor_kind: "automation", mode: { system_of_record: "rotor" } }) };
    const out = await S.runContactStats(ctx);
    assert.equal(out.done, true);
    assert.equal((await store.getRecord("contact", c.id)).data.lifecycle, "former_customer");
    const out2 = await S.runContactStats({ ...ctx, mayAct: () => false });
    assert.equal(out2.done, true);
  } finally { t.done(); }
});
