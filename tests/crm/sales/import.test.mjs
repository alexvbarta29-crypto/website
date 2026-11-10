// M2b acceptance: the sales import phases (design §11.4 "import.test.mjs",
// §10.2 rows 13-15), tested directly against the §10.1 contract with
// synthetic Rotor-shaped rows (the runner that drives them is M2c's; the
// contacts track's applyImport() stands in for it: field ownership,
// simplified). Opportunities collapse into one archived enrollment per
// contact and pipeline, plus the deal's history.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setup, store, ids } from "./fixtures.mjs";
import { applyImport } from "../contacts/fixtures.mjs";

const S = await import("../../../netlify/lib/crm/modules/sales/import-rotor.mjs");
const CI = await import("../../../netlify/lib/crm/modules/contacts/import-rotor.mjs");
const { getType } = await import("../../../netlify/lib/crm/core/registry.mjs");
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ALEX_ROTOR = "rotor-user-alex";
let ctx;
const phase = (name) => [...S.phases, ...CI.phases].find((p) => p.name === name);
const run = async (name, row) => { const p = phase(name); const out = await p.map(p.normalize(row), ctx); await applyImport(out); return out; };

const P = { newLead: uuid(900), estimate: uuid(901), giveaway: uuid(902), referrals: uuid(903) };
const STAGE = (p, pos) => uuid(1000 + Object.values(P).indexOf(p) * 20 + pos);
const hash = (r, type) => {
  const f = getType(type).rotorFields;
  const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
  return createHash("sha256").update(JSON.stringify(canon(Object.fromEntries(f.map((k) => [k, r[k]]))))).digest("hex");
};

async function boards() {
  await run("sales.pipelines", { id: P.referrals, name: "Referrals", position: 0 });
  await run("sales.pipelines", { id: P.estimate, name: "Received Estimate - Not Scheduled", position: 1 });
  await run("sales.pipelines", { id: P.newLead, name: "New Lead - No Estimate Yet", position: 2 });
  await run("sales.pipelines", { id: P.giveaway, name: "Giveaway", position: 3 });
  const nl = ["Day 1 - Call + VM/Text (1)", "Day 1 - Call/Text (2)", "Day 1 - Call/Text (3)", "Day 2 - Call + VM/Text (4)", "Day 2 - Call/Text (5)", "Day 2 - Call/Text (6)", "Day 3 - Call + VM/Text (7)", "Day 3 - Call/Text (8)", "Day 3 - Call/Text (9)", "Send Estimate"];
  for (const [pos, name] of nl.entries()) await run("sales.pipeline_stages", { id: STAGE(P.newLead, pos), pipeline_id: P.newLead, name, position: pos });
  const est = ["Day 1 [Morning]- Call + VM/Text (1)", "Day 1 [Evening]- Call/Text (2)", "Day 2 [Morning] - Call + VM/Text (3)", "Day 3 [Afternoon] - Call + VM/Text (4)", "Day 4 [Evening] - Call + VM/Text (5)", "Day 5 - Wait 3 Days", "Day 7 - Archive Estimate", "Approved Estimate - Waiting to Schedule"];
  for (const [pos, name] of est.entries()) await run("sales.pipeline_stages", { id: STAGE(P.estimate, pos), pipeline_id: P.estimate, name, position: pos });
  for (const [pos, name] of ["Entrants", "$250 Claimed", "Winners"].entries()) await run("sales.pipeline_stages", { id: STAGE(P.giveaway, pos), pipeline_id: P.giveaway, name, position: pos });
}

test("row 13: the four boards land on the seeded cadences with their stage → step maps", async () => {
  const { t, owner } = await setup();
  ctx = { users: new Map([[ALEX_ROTOR, owner.id]]) };
  try {
    await boards();
    const cads = Object.fromEntries((await Promise.all(t.stores.data.keys("rec/cadence/").map((k) => t.stores.data.json(k)))).map((c) => [c.key, c]));
    assert.equal(Object.keys(cads).length, 4, "no new cadences: the seeded ones are linked");
    assert.equal(cads.new_lead.rotor.pipeline_id, P.newLead);
    assert.equal(cads.new_lead.rotor.stage_ids[STAGE(P.newLead, 0)], 1);
    assert.equal(cads.new_lead.rotor.stage_ids[STAGE(P.newLead, 9)], 10, "Send Estimate is the task step");
    assert.equal(cads.estimate_followup.rotor.stage_ids[STAGE(P.estimate, 6)], 5, "Archive Estimate");
    assert.equal(cads.estimate_followup.rotor.stage_ids[STAGE(P.estimate, 7)], 0, "approved: done");
    assert.equal(cads.giveaway.rotor.stage_names[STAGE(P.giveaway, 1)], "$250 Claimed");
    assert.equal((await store.readPointer("rotor/pipeline", P.newLead)).id, cads.new_lead.id);
    assert.equal(cads.new_lead.steps.length, 10, "the CRM's own steps are untouched");
    assert.equal(S.cadenceKeyForPipeline("Something else"), null);
  } finally { t.done(); }
});

test("row 14: opportunities collapse into one archived enrollment per contact and pipeline, plus the deal's history", async () => {
  const { t, owner } = await setup();
  ctx = { users: new Map([[ALEX_ROTOR, owner.id]]) };
  try {
    await boards();
    // a live lead (its contact and its deal come from the contacts phase)
    await run("contacts.leads", { id: uuid(1), first_name: "Jordan", last_name: "Sample", phone: "7635550401", source: "Website quote form", service_type: "Exterior Window Cleaning", projected_value: "243.1" });
    const cid = ids.idForRotor("contact", uuid(1));
    const dealId = ids.idForRotor("deal", `lead:${uuid(1)}`);
    assert.equal((await store.getRecord("deal", dealId)).data.value_cents, 24310, "the contacts phase made the lead's deal");
    const opp = (n, extra) => ({ id: uuid(100 + n), name: "Jordan Sample", pipeline_id: P.newLead, stage_id: STAGE(P.newLead, 0), status: "Open", value: null, assigned_to: [], contact_id: uuid(1), contact_type: "lead", archived: false, created_at: `2026-09-0${n}T15:00:00.123456+00:00`, ...extra });
    const rows = [
      opp(1, { archived: true }),                                                   // a twin someone archived
      opp(2, { stage_id: STAGE(P.newLead, 2), assigned_to: [ALEX_ROTOR] }),         // the live row, moved to (3)
      opp(3),                                                                       // a double-fired twin left live in (1)
      { ...opp(4, { pipeline_id: P.estimate, stage_id: STAGE(P.estimate, 0), status: "Won", archived: true }) },
    ];
    for (const r of rows) await run("sales.opportunities", r);
    const enrollments = t.stores.data.keys("rec/enrollment/").map((k) => t.stores.data.json(k));
    assert.equal(enrollments.length, 2, "one per (contact, pipeline)");
    const nl = enrollments.find((e) => e.cadence_key === "new_lead");
    assert.equal(nl.contact_id, cid);
    assert.equal(nl.status, "archived");
    assert.equal(nl.stop_reason, "imported", "never an active CRM cadence before cutover");
    assert.equal(nl.history.length, 3);
    assert.deepEqual(nl.rotor.opportunity_ids, [uuid(101), uuid(102), uuid(103)]);
    assert.equal(nl.step_n, 3, "the live row in the most advanced stage decides");
    assert.equal(nl.cur.label, "Day 1 - Call/Text (3)");
    assert.equal(nl.rotor.stage_id, STAGE(P.newLead, 2));
    assert.equal(nl.owner_id, owner.id);
    assert.equal(nl.deal_id, dealId);
    assert.equal((await store.readPointer("rotor/opportunity", uuid(103))).id, nl.id);
    assert.equal(t.stores.data.keys(`ptr/enroll/`).length, 0, "an archived import claims no open slot");
    const d = (await store.getRecord("deal", dealId)).data;
    assert.equal(d.status, "won", "a Won row wins the deal");
    assert.equal(d.history.length, 4);
    assert.deepEqual(d.history.map((h) => h.kind), Array(4).fill("rotor_opportunity"));
    assert.equal(d.history.find((h) => h.status_raw === "Won").pipeline, "Received Estimate - Not Scheduled");
    assert.equal(d.value_cents, 24310, "the lead's projected value is kept");
    assert.equal((await store.readIndex("enrollments/active", "")).rows.length, 0, "nothing on the call list");

    // a re-run of the same rows changes nothing
    const before = Object.fromEntries(t.stores.data.keys("rec/enrollment/").concat(t.stores.data.keys("rec/deal/")).map((k) => [k, t.stores.data.json(k)]));
    for (const r of [...rows].reverse()) {
      const p = phase("sales.opportunities");
      const out = await p.map(p.normalize(r), ctx);
      for (const rec of out.records.filter((x) => x.type !== "contact")) {
        const cur = before[`rec/${rec.type}/${rec.data.id}`];
        assert.equal(hash(rec.data, rec.type), hash(cur, rec.type), `${rec.type} maps to what it holds`);
      }
    }

    // an opportunity of a lead Rotor no longer lists: a placeholder contact (row 9)
    await run("sales.opportunities", opp(5, { contact_id: uuid(2), name: "Morgan Gone", status: "Lost", archived: true }));
    const ph = (await store.getRecord("contact", ids.idForRotor("contact", uuid(2)))).data;
    assert.equal(ph.flags.placeholder, true);
    assert.equal(ph.first_name, "Morgan");
    const lostDeal = (await store.getRecord("deal", ids.idForRotor("deal", `lead:${uuid(2)}`))).data;
    assert.equal(lostDeal.status, "lost");
    assert.equal(lostDeal.lost_reason, "no_response");
    // pure rules
    assert.equal(S.dealStatusFrom([{ status_raw: "Abandoned" }]), "abandoned");
    assert.equal(S.dealStatusFrom([{ status_raw: "Open" }, { status_raw: "Lost" }]), "open");
    assert.throws(() => S.normalizeOpportunity({ id: uuid(9), pipeline_id: P.newLead, stage_id: "x", status: "Maybe", contact_id: uuid(1), contact_type: "lead" }), CI.RowError);
  } finally { t.done(); }
});

test("row 15: tasks by kind; row 8: a lead's follow-up date becomes a task", async () => {
  const { t, owner } = await setup();
  ctx = { users: new Map([[ALEX_ROTOR, owner.id]]) };
  try {
    await run("contacts.customers", { id: uuid(20), first_name: "Casey", last_name: "Example", phone: "7635550420", status: "active", source: "Website" });
    const cust = ids.idForRotor("contact", uuid(20));
    const task = async (n, row) => { await run("sales.tasks", { id: uuid(200 + n), priority: "medium", status: "open", assigned_to: [ALEX_ROTOR], created_at: "2026-10-20T15:00:00+00:00", ...row }); return (await store.getRecord("task", ids.idForRotor("task", uuid(200 + n)))).data; };
    const inc = await task(1, { name: "Incident: cracked pane – Casey Example", notes: "Reported: 2026-10-19\nScreen bent too.", priority: "medium", contact_id: uuid(20), contact_type: "customer" });
    assert.equal(inc.kind, "incident");
    assert.equal(inc.priority, "high");
    assert.equal(inc.reported_on, "2026-10-19");
    assert.equal(inc.contact_id, cust);
    assert.deepEqual(inc.assignee_ids, [owner.id]);
    assert.equal((await task(2, { name: "Touch-up: streaks on the bay window", notes: "Job done: 2026-10-01 | Days since: 3" })).kind, "touch_up");
    const est = await task(3, { name: "Casey Example On-site quote", due_date: "2026-11-20T15:00:00+00:00", end_date: "2026-11-20T16:00:00+00:00", contact_id: uuid(20), contact_type: "customer" });
    assert.equal(est.kind, "estimate_visit");
    assert.equal(est.end_at, "2026-11-20T16:00:00.000Z", "a start and an end: the Schedule draws it");
    assert.equal((await task(4, { name: "ALEX GONE THANKSGIVING WKND", assigned_to: [] })).kind, "personal");
    assert.equal((await task(5, { name: "Team meeting: spring plan" })).kind, "meeting");
    const done = await task(6, { name: "Call Casey back after 3:30", status: "done", end_date: "2026-11-06T16:13:02.353+00:00", contact_id: uuid(20), contact_type: "customer" });
    assert.equal(done.kind, "call");
    assert.equal(done.status, "done");
    assert.equal(done.done_at, "2026-11-06T16:13:02.353Z", "a done task's end date is when it was done");
    assert.equal(done.end_at, undefined);
    assert.equal((await store.readPointer("rotor/task", uuid(206))).id, done.id);
    const open = (await store.readIndex("tasks/open", "")).rows;
    assert.equal(open.length, 5, "done tasks leave the open list");
    // a task about a contact Rotor no longer lists
    const lost = await task(7, { name: "Call back", contact_id: uuid(21), contact_type: "lead" });
    assert.equal((await store.getRecord("contact", lost.contact_id)).data.flags.placeholder, true);
    // row 8's follow-up date
    await run("contacts.leads", { id: uuid(22), first_name: "Riley", last_name: "Sample", phone: "7635550422", source: "Meta Ads", assigned_to: ALEX_ROTOR, follow_up_date: "2026-12-01T15:00:00+00:00" });
    await run("sales.lead_follow_ups", { id: uuid(22), first_name: "Riley", last_name: "Sample", phone: "7635550422", source: "Meta Ads", assigned_to: ALEX_ROTOR, follow_up_date: "2026-12-01T15:00:00+00:00" });
    const fu = (await store.getRecord("task", ids.idForRotor("task", `followup:${uuid(22)}`))).data;
    assert.equal(fu.kind, "follow_up");
    assert.equal(fu.due_at, "2026-12-01T15:00:00.000Z");
    assert.equal(fu.contact_id, ids.idForRotor("contact", uuid(22)));
    assert.deepEqual(fu.assignee_ids, [owner.id]);
    assert.equal(S.taskKind("Pick up ladders"), "todo");
    assert.equal(S.reportedOn("no date"), null);
  } finally { t.done(); }
});
