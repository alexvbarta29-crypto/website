// The Leads board and moving a pipeline card to any stage (guide-gaps S13,
// S14): GET /leads (the stage stored or derived, counts per stage), POST
// /enrollments/:id/move (a step cadence plans the step, nothing is sent for
// the skipped ones; a board changes stage; Rotor's own follow-ups stay
// read-only until the switch), a person adds someone to a board-only
// pipeline, ?cadence=all lists every pipeline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, makeLead, importedContact, enrollment, store, AS, IMPORT, outbox } from "./fixtures.mjs";

const B = await import("../../../netlify/lib/crm/modules/sales/board.mjs");

test("leadRows (pure): leads only, the stage derived or stored, the deal and the nearest follow-up", () => {
  const ix = [
    { id: "ct_1", n: "Avery", lc: "lead", slc: "2026-11-10T10:00:00Z", lca: "2026-11-12T10:00:00Z" },
    { id: "ct_2", n: "Blair", lc: "lead", lst: "not_ready", lsa: "2026-11-01T00:00:00Z" },
    { id: "ct_3", n: "Casey", lc: "customer" },
    { id: "ct_4", n: "Dana", lc: "lead", oq: true },
  ];
  const rows = B.leadRows(ix, [{ id: "dl_1", c: "ct_1", v: 42000, st: "open" }], [{ id: "en_1", c: "ct_1", due: "2026-11-20", lbl: "Day 2", st: "active" }, { id: "en_2", c: "ct_1", due: "2026-11-18", lbl: "Day 1", st: "active" }]);
  assert.deepEqual(rows.map((r) => [r.id, r.stage, r.hand]), [["ct_1", "contacted", false], ["ct_2", "not_ready", true], ["ct_4", "quoted", false]]);
  assert.equal(rows[0].lt, "2026-11-12T10:00:00Z", "the last touch is the later of a call and a message");
  assert.equal(rows[0].pv, 42000);
  assert.equal(rows[0].enr, "en_2", "the nearest follow-up");
});

test("moveTo (pure): a board changes stage; a step cadence plans the step; out of range refused; same stage no change", () => {
  const board = { board_only: true, board_stages: ["Entrants", "Claimed", "Winners"] };
  const e = { status: "active", step_n: 1, cur: { label: "Entrants" }, history: [] };
  const m = B.moveTo(e, board, 3, { by: "us_x", env: { now: new Date("2026-11-17T15:00:00Z") } });
  assert.equal(m.step_n, 3);
  assert.equal(m.cur.label, "Winners");
  assert.equal(m.history[0].action, "moved_by_hand");
  assert.equal(B.moveTo(e, board, 1, { by: "us_x", env: {} }), null);
  assert.throws(() => B.moveTo(e, board, 4, { by: "us_x", env: {} }), /stages/);
  assert.throws(() => B.moveTo({ ...e, status: "stopped" }, board, 2, { by: "us_x", env: {} }), /ended/);
});

test("GET /leads, POST /enrollments/:id/move, a board-only add, ?cadence=all", async () => {
  const { t, owner, tech } = await setup();
  try {
    const lead = await makeLead(owner);
    // the stage: new, then by hand
    let r = await t.api("/leads", { as: owner });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.find((x) => x.id === lead.id).stage, "new");
    assert.equal(typeof r.body.meta.counts.new, "number");
    assert.equal((await t.api("/leads", { as: tech })).status, 403);
    const got = await t.api(`/contacts/${lead.id}`, { as: owner });
    await t.api(`/contacts/${lead.id}`, { method: "PATCH", as: owner, ifMatch: got.headers.get("etag"), body: { lead_stage: "follow_up" } });
    r = await t.api("/leads", { as: owner });
    assert.equal(r.body.data.find((x) => x.id === lead.id).stage, "follow_up");
    // a step cadence: from step 1 straight to step 4; the skipped steps send nothing
    const en = await t.api("/enrollments", { method: "POST", as: owner, body: { contact_id: lead.id, cadence_key: "estimate_followup" } });
    assert.equal(en.status, 201, JSON.stringify(en.body));
    const eid = en.body.data.enrollment.id;
    const sent = outbox(t).length;
    let mv = await t.api(`/enrollments/${eid}/move`, { method: "POST", as: owner, body: { step: 4 } });
    assert.equal(mv.status, 200, JSON.stringify(mv.body));
    assert.equal(mv.body.data.step_n, 4);
    const e = await enrollment(eid);
    assert.equal(e.step_n, 4);
    assert.match(e.cur.label, /\(4\)/);
    assert.ok(e.next_due_at, "the step is planned");
    assert.equal(e.history.at(-1).action, "moved_by_hand");
    assert.equal(outbox(t).length, sent, "nothing sent");
    assert.equal((await t.api(`/enrollments/${eid}/move`, { method: "POST", as: owner, body: { step: 99 } })).status, 400);
    mv = await t.api(`/enrollments/${eid}/move`, { method: "POST", as: owner, body: { step: 2 } });
    assert.equal(mv.body.data.step_n, 2, "back a stage too");
    // a person adds someone to Rotor's board-only Giveaway pipeline, then moves the card
    const lead2 = await makeLead(owner);
    const gv = await t.api("/enrollments", { method: "POST", as: owner, body: { contact_id: lead2.id, cadence_key: "giveaway" } });
    assert.equal(gv.status, 201, JSON.stringify(gv.body));
    const gid = gv.body.data.enrollment.id;
    assert.equal(gv.body.data.enrollment.step_n, 1);
    assert.ok(gv.body.data.enrollment.cur.label);
    mv = await t.api(`/enrollments/${gid}/move`, { method: "POST", as: owner, body: { step: 2 } });
    assert.equal(mv.status, 200, JSON.stringify(mv.body));
    const ge = await enrollment(gid);
    assert.equal(ge.step_n, 2);
    assert.equal(ge.next_due_at, undefined, "a board has no due times");
    // ?cadence=all: both pipelines
    const all = await t.api("/enrollments?cadence=all", { as: owner });
    assert.ok(all.body.data.some((x) => x.id === eid) && all.body.data.some((x) => x.id === gid));
    // an imported follow-up stays Rotor's until the switch
    const imp = await importedContact();
    const cad = (await store.readIndex("cadences", "")).rows.find((x) => x.k === "giveaway");
    const ir = await store.createRecord("enrollment", { contact_id: imp.id, cadence_id: cad.id, cadence_key: "giveaway", status: "active", step_n: 1, cur: { label: "Entrants" }, history: [], rotor: { opportunity_ids: ["op_1"] } }, IMPORT);
    const no = await t.api(`/enrollments/${ir.data.id}/move`, { method: "POST", as: owner, body: { step: 2 } });
    assert.equal(no.status, 409, JSON.stringify(no.body));
    assert.equal((await enrollment(ir.data.id)).step_n, 1);
    void AS;
  } finally { t.done(); }
});

test("the Tasks board: a task moves Open → In Progress → Waiting → Done; GET /tasks/done has the recent ones; a tech sees their own", async () => {
  const { t, owner, tech } = await setup();
  try {
    const mk = await t.api("/tasks", { method: "POST", as: owner, body: { title: "Call about the gutters", assignee_ids: [tech.id] } });
    assert.equal(mk.status, 201, JSON.stringify(mk.body));
    const id = mk.body.data.task.id;
    const other = (await t.api("/tasks", { method: "POST", as: owner, body: { title: "Office only", assignee_ids: [owner.id] } })).body.data.task.id;
    for (const status of ["in_progress", "waiting", "done"]) {
      const g = await t.api(`/tasks/${id}`, { as: owner });
      const p = await t.api(`/tasks/${id}`, { method: "PATCH", as: owner, ifMatch: g.headers.get("etag"), body: { status } });
      assert.equal(p.status, 200, JSON.stringify(p.body));
      assert.equal(p.body.data.task.status, status);
    }
    await t.api(`/tasks/${other}/done`, { method: "POST", as: owner, body: {} });
    const d = await t.api("/tasks/done", { as: owner });
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.deepEqual(d.body.data.map((x) => x.id).sort(), [id, other].sort());
    const mine = await t.api("/tasks/done", { as: tech });
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    assert.deepEqual(mine.body.data.map((x) => x.id), [id], "a tech: their own");
    assert.equal((await t.api("/tasks/open", { as: owner })).status !== 500, true);
  } finally { t.done(); }
});
