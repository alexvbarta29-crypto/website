// The work module's import phases (design §10.2 rows 3, 22, 23) through the
// M2c runner on a synthetic export: Rotor's job numbers continue, statuses
// map, lines in cents, placeholders become date-only visits, windows and
// assignees map, the job learns its visits; a second run changes nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, importExport, generate, store, rotorSnapshot } from "../import/fixtures.mjs";

const { idForRotor } = await import("../../../netlify/lib/crm/core/ids.mjs");
const { rotorKey } = await import("../../../netlify/lib/crm/modules/contacts/display.mjs");

test("jobs, visits and time off from a Rotor export, twice", async () => {
  const { t, owner, tech1 } = await setup();
  try {
    const ex = generate({ scale: 0.03, seed: 23 });
    const drew = ex.members.find((m) => m.name === "Drew Example");
    ex.availability_exceptions = [{ id: 501, user_id: drew.user_id, start: "2026-12-24T06:00:00+00:00", end: "2026-12-27T06:00:00+00:00", available: false, reason: "Holidays" }];
    // one visit placeholder of each kind, one anytime, one exact
    ex.visits[1] = { ...ex.visits[1], start: "2026-05-04T12:00:00+00:00", end: "2026-05-04T13:00:00+00:00" };
    ex.visits[2] = { ...ex.visits[2], is_anytime: true, start: "2026-12-02T15:00:00+00:00", end: "2026-12-02T17:00:00+00:00", status: "not_started" };
    ex.visits[3] = { ...ex.visits[3], arrival_window: 0, start: "2026-12-03T14:00:00+00:00", end: "2026-12-03T16:00:00+00:00", status: "not_started", job: { ...ex.visits[3].job, assigned_to: [drew.user_id] } };
    const first = await importExport(t, owner, ex);
    assert.equal(first.run.status, "done", JSON.stringify(first.run.summary));

    const jobs = t.stores.data.keys("rec/job/").map((k) => t.stores.data.json(k));
    assert.equal(jobs.length, ex.jobs.length, "every job");
    const rj = ex.jobs[0];
    const j0 = jobs.find((j) => j.rotor.job_id === rj.id);
    assert.equal(j0.id, idForRotor("job", rj.id));
    assert.equal(j0.number_label, rj.job_number, "Rotor's number kept");
    assert.equal(j0.seq, "job");
    assert.equal(j0.shadow, undefined, "not a shadow");
    assert.equal(j0.created_by, "import");
    assert.equal(t.stores.data.json(`ptr/job-no/${Number(rj.job_number)}`).id, j0.id, "the number is taken, so the CRM's own numbers continue after it");
    assert.equal(t.stores.data.json(`ptr/rotor/job/${rotorKey(rj.id)}`).id, j0.id);
    const MAP = { Pending: "unscheduled", Scheduled: "scheduled", "In Progress": "in_progress", Completed: "completed", Cancelled: "cancelled" };
    for (const r of ex.jobs) assert.equal(jobs.find((j) => j.rotor.job_id === r.id).status, MAP[r.status]);
    const line = j0.lines[0];
    const rl = rj.line_items[0];
    assert.equal(line.id, rl.id, "the line id kept");
    assert.equal(line.total_cents, Math.round(Number(rl.total_price) * 100));
    assert.equal(j0.totals.total_cents, j0.lines.reduce((s, l) => s + l.total_cents, 0));
    assert.ok(jobs.some((j) => j.crew_notes.includes("Gate code")), "notes → crew notes");
    assert.ok(jobs.every((j) => !j.office_notes));
    assert.ok(jobs.filter((j) => j.status === "unscheduled").every((j) => /^\d{4}-\d{2}$/.test(j.target_month)), "pending jobs are due in their month");

    const visits = t.stores.data.keys("rec/visit/").map((k) => t.stores.data.json(k));
    assert.equal(visits.length, ex.visits.length);
    const byRotor = (r) => visits.find((v) => v.rotor.visit_id === String(r.id));
    const ph = byRotor(ex.visits[1]);
    assert.equal(ph.date_only, true);
    assert.equal(ph.date, "2026-05-04");
    assert.equal(ph.window.type, "anytime");
    assert.equal(byRotor(ex.visits[2]).window.type, "anytime");
    assert.equal(byRotor(ex.visits[2]).date, "2026-12-02");
    assert.equal(byRotor(ex.visits[2]).start, "09:00", "15:00Z is 9:00 in Delano in December");
    const exact = byRotor(ex.visits[3]);
    assert.equal(exact.window.type, "exact");
    assert.deepEqual(exact.assignee_ids, [tech1.id], "assignees from the visit's job.assigned_to, mapped to the team");
    assert.ok(byRotor(ex.visits[0]).crew_rotor_id === 1786 || byRotor(ex.visits[0]).crew_rotor_id === undefined);
    // the job knows its visits
    const vj = jobs.find((j) => j.id === exact.job_id);
    const vjNow = (await store.getRecord("job", vj.id)).data;
    assert.ok(vjNow.visit_ids.includes(exact.id));
    assert.ok(vjNow.schedule && vjNow.schedule.last_on >= "2026-12-03");
    // the indexes were rebuilt
    const dec = await store.readIndex("visits", "2026-12");
    assert.ok(dec.rows.some((r) => r.id === exact.id));
    // time off
    const off = t.stores.data.keys("rec/time_off/").map((k) => t.stores.data.json(k));
    assert.equal(off.length, 1);
    assert.equal(off[0].user_id, tech1.id);
    assert.equal(off[0].reason, "Holidays");

    // the same export again: nothing created, nothing conflicted, Rotor's fields byte-identical
    const snap = await rotorSnapshot(t.stores, ["job", "visit", "time_off"]);
    const again = await importExport(t, owner, ex);
    assert.equal(again.run.status, "done");
    assert.equal(again.run.summary.created, 0);
    assert.equal(again.run.summary.conflicted, 0);
    assert.deepEqual(await rotorSnapshot(t.stores, ["job", "visit", "time_off"]), snap);
  } finally { t.done(); }
});
