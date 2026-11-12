// M2a acceptance: merge (design §11.4 "merge.test.mjs", §5.1 "Merge").
import { test } from "node:test";
import assert from "node:assert/strict";
import { crmTest } from "../../helpers/crm-http.mjs";
import { fixtureModule, fixtureType } from "../../helpers/crm-fixtures.mjs";
import { advance, minutes } from "../../helpers/crm-clock.mjs";
import { store, merge, intake, PERSON } from "./fixtures.mjs";

const { call } = await import("../../../netlify/lib/crm/core/services.mjs");
const { BlobsTransientError } = await import("../../../netlify/lib/crm/core/errors.mjs");
const { createPortalLink, readLink } = await import("../../../netlify/lib/crm/portal/core.mjs");

// Modules that take part in a merge (fixtures): one counts its calls; one
// plays an inbound text and a record arriving for b while the merge runs;
// one fails once on storage (the op resumes); a money stats part for Stripe ids.
const seen = { counted: 0, resolved: [], flaky: 0, flakyFail: true };
fixtureModule({ name: "counter", onMerge: async () => { seen.counted += 1; } });
fixtureModule({
  name: "inbound-sim",
  types: [fixtureType("widget", "zw", { rels: [{ rel: "contact-widgets", parent: (r) => r.contact_id || null, sort: () => "2026-11-17" }] })],
  onMerge: async (a, b) => {
    // a text that arrives mid-merge is routed by resolving its contact
    seen.resolved.push(await call("contacts.resolve", b));
    // a website lead for b's number arrives mid-merge: it lands on the survivor
    await intake.intakeLead({ phone: "+17635550171", notes: "Asked again during the merge." }, { origin: "lead-form" });
    // and things that still landed on b (a straggler record and a timeline row)
    await store.createRecord("widget", { contact_id: b, name: "Late arrival" }, { ...PERSON, origin: "api" }).catch(() => null);
    await store.addActivity(b, "message", "ms_00000000000000000001");
  },
});
fixtureModule({ name: "flaky", onMerge: async () => { seen.flaky += 1; if (seen.flakyFail) { seen.flakyFail = false; throw new BlobsTransientError("storage blinked"); } } });
// (a stand-in for the money stats part until Money, M5, registers the real one)
if (!(await import("../../../netlify/lib/crm/core/registry.mjs")).statsPart("money")) fixtureModule({ name: "moneyfix", statsParts: { money: { defaults: { lifetime_cents: 0, open_balance_cents: 0, stripe: { customer_ids: [] } }, row: () => ({}) } } });

async function runUntilDone(t, runId, max = 12) {
  for (let i = 0; i < max; i++) {
    const g = await store.getRecord("run", runId);
    if (g && ["done", "failed", "cancelled"].includes(g.data.status)) return g.data;
    await t.runWorker({ lane: "bulk" });
    advance(minutes(2));
  }
  return (await store.getRecord("run", runId)).data;
}

test("merge: inbound routed to the survivor, stragglers moved, each onMerge once across a resume, two Stripe customers kept + an approval", async () => {
  const t = await crmTest();
  try {
    const owner = await t.user("owner");
    const W = { ...PERSON, by: owner.id };
    const a = (await store.createRecord("contact", {
      first_name: "Pat", last_name: "Example", phones: [{ e164: "+17635550170" }], emails: [], lifecycle: "lead", tags: ["Website"],
      consent: { sms_marketing: { state: "granted", at: "2026-10-01T00:00:00.000Z", source: "portal" } }, source: { source: "Website quote form" },
    }, W)).data;
    advance(minutes(1));
    const b = (await store.createRecord("contact", {
      first_name: "Pat", last_name: "Example", phones: [{ e164: "+17635550171" }], emails: [{ address: "pat.dup@example.com" }], lifecycle: "customer",
      tags: ["Referral"], notes: "Gate code on file.", consent: { sms_marketing: { state: "revoked", at: "2026-09-01T00:00:00.000Z", source: "keyword" } },
      source: { source: "Referral" },
    }, W)).data;
    await store.createRecord("property", { contact_id: b.id, label: "Home", address: { street1: "171 Example Ave", city: "Delano", state: "MN", zip: "55328" } }, W);
    await store.updateStats(a.id, "money", (p) => ({ ...p, stripe: { customer_ids: ["cus_TESTA"] } }), W);
    await store.updateStats(b.id, "money", (p) => ({ ...p, stripe: { customer_ids: ["cus_TESTB"] } }), W);
    const link = await createPortalLink({ contact_id: b.id, scope: { kind: "hub" } });

    const res = await t.api(`/contacts/${a.id}/merge`, { method: "POST", as: owner, body: { other_id: b.id } });
    assert.equal(res.status, 202, JSON.stringify(res.body));
    const run = await runUntilDone(t, res.body.data.run_id);
    assert.equal(run.status, "done", JSON.stringify(run));

    // b is a tombstone pointing at a; a holds the union
    const gb = (await store.getRecord("contact", b.id)).data;
    assert.equal(gb.merged_into, a.id);
    assert.equal(gb.lifecycle, "archived");
    assert.equal(gb.archived_reason, "duplicate");
    assert.equal(gb.merging_into, undefined);
    const ga = (await store.getRecord("contact", a.id)).data;
    assert.deepEqual(ga.phones.map((p) => p.e164).sort(), ["+17635550170", "+17635550171"]);
    assert.deepEqual(ga.emails.map((e) => e.address), ["pat.dup@example.com"]);
    assert.deepEqual(ga.tags, ["Website", "Referral"]);
    assert.match(ga.notes, /Merged from Pat Example[\s\S]*Gate code on file\./);
    assert.match(ga.notes, /Asked again during the merge\./, "the mid-merge website lead landed on the survivor");
    assert.doesNotMatch(gb.notes, /Asked again/);
    assert.equal(ga.consent.sms_marketing.state, "revoked", "a revocation wins");
    assert.equal(ga.lifecycle, "customer", "the stronger lifecycle");
    assert.equal(ga.source.source, "Website quote form", "the earlier source");

    // routing during the merge landed on the survivor; stragglers moved
    assert.ok(seen.resolved.length >= 1 && seen.resolved.every((x) => x === a.id), "inbound routed to the survivor");
    assert.equal(t.stores.data.keys(`rel/contact-widgets/${b.id}/`).length, 0);
    assert.equal(t.stores.data.keys(`rel/contact-widgets/${a.id}/`).length, 1, "the late record moved to a");
    assert.equal(t.stores.data.keys(`rel/contact-activity/${b.id}/`).length, 0);
    assert.ok(t.stores.data.keys(`rel/contact-activity/${a.id}/`).some((k) => k.includes("--message--")), "the late timeline row moved too");
    assert.equal(t.stores.data.keys(`rel/contact-properties/${a.id}/`).length, 1, "b's property belongs to a");

    // each module's onMerge ran once, though the op stopped half way and resumed
    assert.equal(seen.counted, 1);
    assert.equal(seen.flaky, 2, "the flaky step ran again; nothing before it did");

    // lookups: b left the phone list; its number now finds a
    assert.equal(await call("contacts.resolve", b.id), a.id);
    const list = await store.readPointer("phone", store.hk("phone", "+17635550171"));
    assert.deepEqual(list.ids, [a.id]);

    // two Stripe customers: both kept, and an approval for the owners
    const sa = (await store.getRecord("contact_stats", a.id)).data;
    assert.deepEqual(sa.money.stripe.customer_ids.sort(), ["cus_TESTA", "cus_TESTB"]);
    const pending = await t.api("/pending-actions", { as: owner });
    assert.ok(pending.body.data.some((p) => /Two Stripe customers after merge/.test(p.title)));

    // b's portal links are revoked; contact.merged was emitted (b's event history)
    assert.ok((await readLink(link.code)).revoked_at);
    assert.ok(t.stores.data.keys(`evt/contact/${a.id}/`).some((k) => k.includes("--merge--")));
  } finally {
    t.done();
  }
});

test("merge review: a candidate merges the survivor the office picks; dismiss; bulk with a typed confirm; a tech can't", async () => {
  const t = await crmTest();
  try {
    const owner = await t.user("owner");
    const tech = await t.user("tech");
    const W = { ...PERSON, by: owner.id };
    const mk = async (first, phone) => (await store.createRecord("contact", { first_name: first, last_name: "Sample", phones: [{ e164: phone }], lifecycle: "lead", source: { source: "Other" } }, W)).data;
    const x = await mk("Jordan", "+17635550180");
    const y = await mk("Jordan", "+17635550181");
    const z = await mk("Riley", "+17635550182");
    const { createCandidate } = await import("../../../netlify/lib/crm/modules/contacts/match.mjs");
    const m1 = await createCandidate(x.id, y.id, { reason: "name", confidence: "high" }, W);
    const m2 = await createCandidate(x.id, z.id, { reason: "name", confidence: "low" }, W);
    assert.equal((await createCandidate(y.id, x.id, { reason: "phone", confidence: "high" }, W)).created, false, "one candidate per pair, ever");

    const list = await t.api("/merge-candidates", { as: owner });
    assert.equal(list.status, 200);
    assert.equal(list.body.data[0].confidence, "high", "sorted by confidence");
    assert.equal(list.body.data[0].a.n !== undefined, true, "with both contacts' rows to compare");
    assert.equal((await t.api("/merge-candidates", { as: tech })).status, 403);

    assert.equal((await t.api(`/merge-candidates/${m2.id}/dismiss`, { method: "POST", as: owner, body: {} })).body.data.status, "dismissed");
    const bad = await t.api("/merge-candidates/bulk", { method: "POST", as: owner, body: { action: "merge_high_same_first_name", confirm: "yes" } });
    assert.equal(bad.status, 400, "the typed confirmation");
    const r = await t.api(`/merge-candidates/${m1.id}/merge`, { method: "POST", as: owner, body: { survivor: "b" } });
    assert.equal(r.status, 202);
    const run = await runUntilDone(t, r.body.data.run_id);
    assert.equal(run.status, "done");
    const cand = (await store.getRecord("merge_candidate", m1.id)).data;
    assert.equal((await store.getRecord("contact", cand.a)).data.merged_into, cand.b, "b survived as picked");
    assert.equal((await store.getRecord("merge_candidate", m1.id)).data.status, "merged");
    const again = await t.api(`/merge-candidates/${m1.id}/merge`, { method: "POST", as: owner, body: {} });
    assert.equal(again.status, 409, "decided already");
  } finally {
    t.done();
  }
});

test("pure merge rules: consent revoked wins else the latest grant; survivor of a bulk merge", () => {
  const g = (at) => ({ state: "granted", at });
  assert.equal(merge.mergeConsentState(g("2026-01-01T00:00:00Z"), { state: "revoked", at: "2025-01-01T00:00:00Z" }).state, "revoked");
  assert.equal(merge.mergeConsentState(g("2026-01-01T00:00:00Z"), g("2026-05-01T00:00:00Z")).at, "2026-05-01T00:00:00Z");
  assert.equal(merge.mergeConsentState({ state: "unknown" }, undefined).state, "unknown");
  const lead = { id: "ct_1", lifecycle: "lead", created_at: "2025-01-01T00:00:00Z" };
  const cust = { id: "ct_2", lifecycle: "customer", created_at: "2026-01-01T00:00:00Z" };
  assert.equal(merge.survivorOf(lead, cust)[0].id, "ct_2", "the customer survives");
  assert.equal(merge.survivorOf({ ...lead, id: "ct_3" }, lead)[0].created_at, "2025-01-01T00:00:00Z");
  const m = merge.mergedFields({ phones: [{ e164: "+17635550190", primary: true }], tags: [], flags: { placeholder: true }, rotor: { lead_ids: ["l1"] } }, { phones: [{ e164: "+17635550190", primary: true }], tags: ["X"], flags: { vip: true }, rotor: { customer_id: "c1", lead_ids: ["l2"] }, intake_pending_rotor: { at: "x" } });
  assert.equal(m.phones.length, 1, "no repeated number");
  assert.deepEqual(m.flags, { vip: true }, "a real contact is no longer a placeholder");
  assert.deepEqual(m.rotor.lead_ids, ["l1", "l2"]);
  assert.equal(m.rotor.customer_id, "c1");
  assert.equal(m.intake_pending_rotor, undefined, "linked to Rotor now");
});

test("a person's edit never lands on a contact being merged (409), and intake follows a merge that starts under it", async () => {
  const t = await crmTest();
  try {
    const owner = await t.user("owner");
    const W = { ...PERSON, by: owner.id };
    const a = (await store.createRecord("contact", { first_name: "Keep", last_name: "Me", phones: [{ e164: "+17635550175" }], lifecycle: "lead", source: { source: "Other" } }, W)).data;
    const b = (await store.createRecord("contact", { first_name: "Merge", last_name: "Me", phones: [{ e164: "+17635550176" }], lifecycle: "lead", source: { source: "Other" } }, W));
    await store.updateRecord("contact", b.data.id, (c) => ({ ...c, merging_into: a.id }), W);
    const etag = (await store.getRecord("contact", b.data.id)).etag;
    assert.equal((await t.api(`/contacts/${b.data.id}`, { method: "PATCH", as: owner, ifMatch: etag, body: { last_name: "Edited" } })).status, 409);
    assert.equal((await t.api(`/contacts/${b.data.id}/notes`, { method: "POST", as: owner, body: { text: "Lost?" } })).status, 409);
    // intake: b found by its number resolves to a
    const r = await intake.intakeLead({ phone: "+17635550176", notes: "Hello" }, { origin: "lead-form" });
    assert.equal(r.contact_id, a.id);
    assert.ok((await store.getRecord("contact", a.id)).data.phones.some((p) => p.e164 === "+17635550176"));
  } finally { t.done(); }
});

test("a merge that starts between intake's read and its write: the upsert follows it to the survivor", async () => {
  const t = await crmTest();
  try {
    const owner = await t.user("owner");
    const W = { ...PERSON, by: owner.id };
    const a = (await store.createRecord("contact", { first_name: "Keep", last_name: "Me", phones: [{ e164: "+17635550177" }], lifecycle: "lead", source: { source: "Other" } }, W)).data;
    const b = (await store.createRecord("contact", { first_name: "Racing", last_name: "Me", phones: [{ e164: "+17635550178" }], lifecycle: "lead", source: { source: "Other" } }, W)).data;
    // the racing writer: the merge's first step lands right before intake's conditional write on b
    t.stores.data.beforeConditionalWrite(async (key, opts, s) => {
      const cur = s.json(key);
      await s.setJSON(key, { ...cur, merging_into: a.id, wv: cur.wv + 1 });
    }, { key: `rec/contact/${b.id}`, times: 1 });
    const r = await intake.intakeLead({ phone: "+17635550178", notes: "Raced the merge." }, { origin: "lead-form" });
    assert.ok(r.ok, JSON.stringify(r));
    assert.match((await store.getRecord("contact", a.id)).data.notes, /Raced the merge\./, "landed on the survivor");
    assert.doesNotMatch((await store.getRecord("contact", b.id)).data.notes || "", /Raced/);
  } finally { t.done(); }
});
