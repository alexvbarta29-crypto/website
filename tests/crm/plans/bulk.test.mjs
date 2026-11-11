// M3b acceptance: sends to many people are bulk runs (design §5.7.4 "Bulk
// sends", §11.4 "bulk.test.mjs"): request-signatures for 12 plans and 7
// renewal notices on one day each become a bulk run (preview, test send and
// an owner's confirm before anything goes out; an agreement counts as sent
// only once the run sent it); lights.rebook creates a ready-to-send run and
// sends nothing by itself, and a next season is made only once confirmed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, customer, importedCustomer, importedPlan, planOf, recOf, finishRun, drain, outbox, pin, scope, store, PL, CAT, AS } from "./fixtures.mjs";

const bulkRuns = (t, kind) => t.stores.data.keys("rec/bulk_run/").map((k) => t.stores.data.json(k)).filter((b) => !kind || b.kind === kind);

// An active plan straight in the store (a person's write), its term from start_on.
async function activePlan(owner, contact, start_on, extra = {}) {
  const cat = CAT.catalogWith({});
  const p = PL.buildPlan({ id: undefined, contact_id: contact.id, contact_name: `${contact.first_name} ${contact.last_name}`, property_id: contact.primary_property_id, catalog_key: "biannual", lines: [{ id: "ln_1", title: "Exterior Window Cleaning", qty_milli: 1000, unit_cents: 29500, total_cents: 29500, scope: { type: "all" } }], discounts: [], origin: "staff" }, cat, { start_on });
  delete p.id;
  return scope(async () => (await store.createRecord("plan", { ...p, status: "active", pending_reasons: [], agreement_status: "signed", ...extra }, AS(owner))).data);
}

test("request signatures for 12 imported plans: one bulk run with a link for each person, nothing sent before the owner's test and confirm", async () => {
  const { t, owner } = await setup();
  try {
    const plans = [];
    for (let i = 0; i < 12; i++) plans.push(await importedPlan(await importedCustomer()));
    const r = await t.api("/plans/request-signatures", { method: "POST", as: owner, body: { plan_ids: plans.map((p) => p.id) } });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    const run = await finishRun(t, r.body.data.run_id, 12);
    assert.equal(run.status, "done", JSON.stringify(run));
    assert.equal(run.result.requested, 12);
    const runs = bulkRuns(t, "plans.request_signatures");
    assert.equal(runs.length, 1, "one bulk run");
    const b = runs[0];
    assert.equal(b.recipients.length, 12);
    assert.equal(b.template_key, "agreement_sent");
    assert.equal(Object.keys(b.per_recipient_vars).length, 12, "a link for each person");
    assert.ok(Object.values(b.per_recipient_vars).every((v) => /^https:\/\/www\.bartawindowwashing\.com\/p\/[0-9A-Za-z]{10}$/.test(v.agreement_link)));
    await t.runWorker({ lane: "bulk" });
    assert.equal((await recOf("bulk_run", b.id)).status, "ready", "previewed, waiting for the test send");
    assert.equal(outbox(t).filter((o) => o.template_key === "agreement_sent").length, 0, "nothing sent");
    // each plan has its agreement, queued on that run: still a draft (not
    // "sent" while the run waits: Today, the hub and the reminders skip it)
    for (const p of plans) {
      const pl = await planOf(p.id);
      const ag = await recOf("agreement", pl.agreement_id);
      assert.equal(ag.status, "draft", "queued, not sent");
      assert.equal(ag.bulk_run_id, b.id);
      assert.notEqual(pl.agreement_status, "sent");
    }
    const today = await t.api("/agreements?status=sent", { as: owner });
    assert.equal(today.body.data.length, 0, "nothing counts as sent yet");
    // a second request for the same plans the same day is the same run
    const again = await t.api("/plans/request-signatures", { method: "POST", as: owner, body: { plan_ids: plans.map((p) => p.id) } });
    assert.equal(again.body.data.run_id, r.body.data.run_id);
    pin("2026-11-19T16:30:00Z");
    await drain(t, 2);
    assert.equal(outbox(t).filter((o) => o.template_key === "agreement_unsigned").length, 0, "no reminder for an agreement whose bulk run hasn't gone out");
    // the owner tests and confirms: the run sends (dry-run), and the hourly
    // plans.agreement_sends marks each agreement sent from then
    const tester = await customer(owner, { flags: { test: true } });
    const oT = await t.user("owner");
    assert.equal((await t.api("/settings/messaging_test", { method: "PUT", as: oT, ifMatch: "new", body: { contact_id: tester.id } })).status, 200);
    assert.equal((await t.api(`/bulk-runs/${b.id}/test`, { method: "POST", as: oT, body: {} })).status, 200);
    assert.equal((await t.api(`/bulk-runs/${b.id}/confirm`, { method: "POST", as: oT, body: {} })).status, 200);
    for (let i = 0; i < 3; i++) await t.runWorker({ lane: "bulk" });
    assert.equal((await recOf("bulk_run", b.id)).status, "sent");
    pin("2026-11-19T17:35:00Z");
    await drain(t, 2);
    for (const p of plans) {
      const pl = await planOf(p.id);
      const ag = await recOf("agreement", pl.agreement_id);
      assert.equal(ag.status, "sent", "sent once the run sent it");
      assert.equal(pl.agreement_status, "sent");
    }
    // techs can't; an empty list is refused
    const o2 = await t.user("owner");
    assert.equal((await t.api("/plans/request-signatures", { method: "POST", as: await t.user("tech"), body: { plan_ids: [plans[0].id] } })).status, 403);
    assert.equal((await t.api("/plans/request-signatures", { method: "POST", as: o2, body: { plan_ids: [] } })).status, 400);
  } finally { t.done(); }
});

test("seven renewal notices due on one day: one bulk run for the owner, nothing queued straight out; a single one is just sent", async () => {
  const { t, owner } = await setup("2026-11-17T15:00:00Z");
  try {
    for (let i = 0; i < 7; i++) await activePlan(owner, await customer(owner), "2025-12-01");
    pin("2026-11-17T16:30:00Z");                      // 10:30 in Delano: the 10:00 sweep is due
    await drain(t, 2);
    const runs = bulkRuns(t, "plan.renewal_notice");
    assert.equal(runs.length, 1, "one bulk run");
    assert.equal(runs[0].recipients.length, 7);
    assert.equal(runs[0].template_key, "plan_renewal_notice");
    assert.ok(Object.values(runs[0].per_recipient_vars).every((v) => v.due_date === "Dec 1, 2026" && v.plan_name === "Biannual plan"));
    assert.equal(outbox(t).filter((o) => /renewal/.test(o.template_key || "")).length, 0, "nothing sent before the owner's confirm");
    // the next day: noted once per term, no second run
    pin("2026-11-18T16:30:00Z");
    await drain(t, 2);
    assert.equal(bulkRuns(t, "plan.renewal_notice").length, 1);
  } finally { t.done(); }
  const s = await setup("2026-11-17T15:00:00Z");
  try {
    await activePlan(s.owner, await customer(s.owner), "2025-12-01");
    pin("2026-11-17T16:30:00Z");
    await drain(s.t, 3);
    assert.equal(bulkRuns(s.t, "plan.renewal_notice").length, 0, "under the threshold: no bulk run");
    assert.ok(outbox(s.t).some((o) => o.template_key === "plan_renewal_notice"), "the notice itself (dry-run)");
  } finally { s.t.done(); }
});

test("lights.rebook on Sept 1: a ready-to-send bulk run for last season's customers; a 3-year contract gets its season and a confirmation run; nothing is sent", async () => {
  const { t, owner } = await setup("2026-08-30T15:00:00Z");
  try {
    const people = [];
    for (let i = 0; i < 6; i++) {
      const c = await customer(owner);
      people.push(c);
      await scope(() => store.createRecord("season_install", { contact_id: c.id, contact_name: `${c.first_name} ${c.last_name}`, property_id: c.primary_property_id, season: 2025, status: i % 2 ? "stored" : "taken_down", warranty_job_ids: [], footage_ft: 120, colors: ["warm_white"], design_file_ids: [] }, AS(owner)));
    }
    // someone whose 2025 season was cancelled isn't asked
    const gone = await customer(owner);
    await scope(() => store.createRecord("season_install", { contact_id: gone.id, property_id: gone.primary_property_id, season: 2025, status: "cancelled", warranty_job_ids: [], design_file_ids: [] }, AS(owner)));
    // a 3-year contract (2025-2027)
    const three = await customer(owner);
    const cat = CAT.catalogWith({});
    const lp = PL.buildPlan({ contact_id: three.id, contact_name: "Pat Three", property_id: three.primary_property_id, catalog_key: "lights_annual", term_months: 36, lines: [{ id: "ln_lt", title: "Christmas Lights", qty_milli: 1000, unit_cents: 90000, total_cents: 90000, scope: { type: "all" } }], discounts: [{ id: "dc_3", key: "three_year", name: "3-year contract", type: "fixed", value: 10000, scope: { type: "initial" } }], origin: "staff" }, cat, { start_on: "2025-10-01" });
    delete lp.id;
    lp.ordinals[0] = { ...lp.ordinals[0], status: "completed" };
    const plan = await scope(async () => (await store.createRecord("plan", { ...lp, status: "active", pending_reasons: [], agreement_status: "signed" }, AS(owner))).data);
    await scope(() => store.createRecord("season_install", { contact_id: three.id, property_id: three.primary_property_id, season: 2025, plan_id: plan.id, status: "stored", warranty_job_ids: [], design_file_ids: [], three_year: true, contract_season_n: 1 }, AS(owner)));
    await drain(t, 1);
    assert.equal(bulkRuns(t).length, 0, "not before Sept 1");
    pin("2026-09-01T14:00:00Z");                      // 09:00 in Delano
    await drain(t, 2);
    const rebook = bulkRuns(t, "lights.rebook");
    assert.equal(rebook.length, 1, "one rebook run");
    assert.deepEqual(rebook[0].recipients.sort(), people.map((c) => c.id).sort(), "last season's stored and taken-down customers, not the 3-year one");
    assert.equal(rebook[0].template_key, "lights_rebook");
    assert.equal(rebook[0].vars.season_year, "2026");
    const confirm = bulkRuns(t, "lights.confirm");
    assert.equal(confirm.length, 1);
    assert.deepEqual(confirm[0].recipients, [three.id]);
    // the 3-year customer's 2026 season waits for their yes: no install made by itself
    const s26of = () => t.stores.data.keys("rec/season_install/").map((k) => t.stores.data.json(k)).find((s) => s.season === 2026 && s.contact_id === three.id);
    assert.equal(s26of(), undefined, "no season before the customer confirms");
    await drain(t, 3);
    assert.equal(s26of(), undefined, "the hourly backfill waits too");
    const board = await t.api("/lights/seasons/2026", { as: await t.user("owner") });
    assert.ok(board.body.data.to_confirm.some((x) => x.plan_id === plan.id), "the board lists it to confirm");
    // the office marks it confirmed: the season, its install and takedown
    const o3 = await t.user("owner");
    const c = await t.api(`/plans/${plan.id}/confirm-season`, { method: "POST", as: o3, body: { season: 2026 } });
    assert.equal(c.status, 202, JSON.stringify(c.body));
    await finishRun(t, c.body.data.run_id);
    const s26 = s26of();
    assert.ok(s26, "the next season's record");
    assert.ok(s26.install_job_id && s26.takedown_job_id);
    assert.equal((await recOf("job", s26.install_job_id)).totals.total_cents, 90000, "the 3-year discount was the first season's only");
    assert.equal((await recOf("job", s26.takedown_job_id)).target_month, "2027-01");
    assert.equal(s26.contract_season_n, 2);
    await t.runWorker({ lane: "bulk" });
    assert.equal((await recOf("bulk_run", rebook[0].id)).status, "ready", "ready to send, waiting for the owner");
    assert.equal(outbox(t).filter((o) => /lights_/.test(o.template_key || "")).length, 0, "nothing sent by itself");
    // once a season: the next days make no second run
    pin("2026-09-02T14:00:00Z");
    await drain(t, 2);
    assert.equal(bulkRuns(t, "lights.rebook").length, 1);
  } finally { t.done(); }
});
