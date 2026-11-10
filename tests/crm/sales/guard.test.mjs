// M2b acceptance: the parallel-run guard (design §11.4 "guard.test.mjs",
// §0 rule 12, §3.10). While Rotor is in charge, sales.deal_abandon writes a
// would- row for a deal the import brought in and changes a deal the CRM
// made; listeners act the same way on imported deals.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, makeLead, importedContact, deal, AUTO, store, IMPORT, AS, pin, drain } from "./fixtures.mjs";

const { automationCtx } = await import("../../../netlify/lib/crm/core/activity.mjs");
const sweepCtx = (key, mode = { system_of_record: "rotor", paused: false }) => {
  const a = automationCtx({ mode, key, requestId: "test" });
  return { ...a, budget: null, deploy: null, cursor: null };
};

test("sales.deal_abandon: a would- row for an imported deal, the change on a shadow deal", async () => {
  const { t, owner } = await setup("2026-10-01T15:00:00Z");
  try {
    const shadowLead = await makeLead(owner);
    const shadow = (await store.createRecord("deal", { contact_id: shadowLead.id, services: ["Exterior Window Cleaning"], status: "open", opened_at: "2026-10-01T15:00:00.000Z", last_activity_at: "2026-10-01T15:00:00.000Z", history: [] }, AS(owner))).data;
    assert.equal(shadow.shadow, true, "made in the CRM while Rotor is in charge");
    const imp = await importedContact();
    const imported = (await store.createRecord("deal", {
      id: "dl_00000000000000000001", contact_id: imp.id, services: ["Gutter Cleaning"], status: "quoted", opened_at: "2026-09-15T15:00:00.000Z",
      last_activity_at: "2026-09-20T15:00:00.000Z", history: [], import: { run_id: "ir_00000000000000000001", at: "2026-10-01T00:00:00.000Z", hash: "0".repeat(64) },
    }, IMPORT)).data;
    pin("2026-11-17T08:30:00Z");                                // 02:30, 47+ days later
    const r = await AUTO.abandonSweep(sweepCtx("sales.deal_abandon"));
    assert.equal(r.progress, 2);
    assert.equal((await deal(shadow.id)).status, "abandoned", "the CRM's own deal changes");
    assert.ok((await deal(shadow.id)).abandoned_at);
    const imp2 = await deal(imported.id);
    assert.equal(imp2.status, "quoted", "Rotor's deal is left exactly as the import wrote it");
    assert.equal(imp2.updated_at, imported.updated_at);
    const rows = t.stores.data.keys("alog/").filter((k) => k.includes("would-mark_abandoned"));
    assert.equal(rows.length, 1, "one would- row");
    assert.ok(rows[0].includes(imported.id));
    // after cutover the same sweep changes it
    const after = await AUTO.abandonSweep(sweepCtx("sales.deal_abandon", { system_of_record: "crm", paused: false }));
    assert.equal(after.progress, 1);
    assert.equal((await deal(imported.id)).status, "abandoned");
  } finally { t.done(); }
});

test("listeners: a won job on an imported customer's deal is a would- row; on a CRM lead's deal it wins", async () => {
  const { t, owner } = await setup();
  try {
    const { emit } = await import("../../../netlify/lib/crm/core/events.mjs");
    const imp = await importedContact({ lifecycle: "customer" });
    const imported = (await store.createRecord("deal", { contact_id: imp.id, status: "open", history: [], import: { run_id: "ir_00000000000000000001", at: "2026-10-01T00:00:00.000Z", hash: "1".repeat(64) } }, IMPORT)).data;
    const lead = await makeLead(owner);
    const mine = (await store.createRecord("deal", { contact_id: lead.id, status: "quoted", history: [] }, AS(owner))).data;
    await emit("job.completed", { id: "jb_00000000000000000001", wv: 1, job_id: "jb_00000000000000000001", contact_id: imp.id, kind: "standard", billable: true, total_cents: 24310, assignee_ids: [] });
    await emit("job.completed", { id: "jb_00000000000000000002", wv: 1, job_id: "jb_00000000000000000002", contact_id: lead.id, kind: "standard", billable: true, total_cents: 24310, assignee_ids: [] });
    await drain(t, 2);
    assert.equal((await deal(imported.id)).status, "open");
    assert.ok(t.stores.data.keys("alog/").some((k) => k.includes("would-mark_won") && k.includes(imported.id)));
    const won = await deal(mine.id);
    assert.equal(won.status, "won");
    assert.deepEqual(won.job_ids, ["jb_00000000000000000002"]);
  } finally { t.done(); }
});

test("a follow-up the CRM started on a returning imported contact ends by automation: Rotor's deal stays as imported (a would- row)", async () => {
  const { t, owner } = await setup();
  try {
    const L = await import("../../../netlify/lib/crm/modules/sales/listeners.mjs");
    const E = await import("../../../netlify/lib/crm/modules/sales/enroll.mjs");
    const { AUTOMATION } = await import("./fixtures.mjs");
    const c = await importedContact();
    const imported = (await store.createRecord("deal", {
      contact_id: c.id, services: ["Exterior Window Cleaning"], status: "open", opened_at: "2026-11-01T15:00:00.000Z",
      last_activity_at: "2026-11-01T15:00:00.000Z", history: [], import: { run_id: "ir_00000000000000000001", at: "2026-11-08T00:00:00.000Z", hash: "2".repeat(64) },
    }, IMPORT)).data;
    // the website's dual-write intake (automation) enrolls the returning lead: a CRM-only follow-up on Rotor's open deal
    const id = await E.enroll(c.id, "new_lead", {}, AUTOMATION);
    const e0 = (await store.getRecord("enrollment", id)).data;
    assert.equal(e0.shadow, true);
    assert.equal(e0.deal_id, imported.id);
    const before = await store.getRecord("deal", imported.id);
    await L.onConsentChanged({ payload: { contact_id: c.id, channel: "sms", state: "opted_out" } }, { ctx: sweepCtx("evt") });
    assert.equal((await store.getRecord("enrollment", id)).data.status, "stopped", "the CRM's own follow-up stops");
    const after = await store.getRecord("deal", imported.id);
    assert.equal(after.etag, before.etag, "the imported deal is not written");
    assert.ok(t.stores.data.keys("alog/").some((k) => k.includes("would-touch") && k.includes(imported.id)));
    // a person stopping one is their own action: the deal's quiet days start
    const id2 = await E.enroll(c.id, "estimate_followup", { quote_id: "qt_00000000000000000051" }, AS(owner));
    const r = await t.api(`/enrollments/${id2}/stop`, { method: "POST", as: owner, body: {} });
    assert.equal(r.status, 200);
    assert.notEqual((await store.getRecord("deal", imported.id)).etag, before.etag);
  } finally { t.done(); }
});

test("a task step on a follow-up the import owns: a would- row, no task", async () => {
  const { t } = await setup();
  try {
    const E = await import("../../../netlify/lib/crm/modules/sales/enroll.mjs");
    const SEED = await import("../../../netlify/lib/crm/modules/sales/seed.mjs");
    const c = await importedContact();
    const en = (await store.createRecord("enrollment", {
      contact_id: c.id, cadence_id: SEED.seedCadenceId("new_lead"), cadence_key: "new_lead", status: "active", step_n: 10, step_id: "s10", day1: "2026-11-10",
      history: [], started_at: "2026-11-10T15:00:00.000Z", import: { run_id: "ir_00000000000000000001", at: "2026-11-08T00:00:00.000Z", hash: "3".repeat(64) },
    }, IMPORT)).data;
    const r = await E.runTaskStep(en, sweepCtx("sales.cadence"));
    assert.equal(r.would, true);
    assert.equal(t.stores.data.keys("rec/task/").length, 0);
    assert.equal((await store.getRecord("enrollment", en.id)).data.step_n, 10);
  } finally { t.done(); }
});
