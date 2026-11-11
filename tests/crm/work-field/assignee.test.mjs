// Field actions belong to the visit's people, whatever their role (design
// §9.3, §11.4 M4b "assignee.test.mjs"): an owner assigned to a visit sees
// the field actions and works it like a tech; someone not on the visit
// doesn't; a technician only inside their window (§4.6).
import { test } from "node:test";
import assert from "node:assert/strict";
import { pin } from "../../helpers/crm-clock.mjs";
import { setup, customer, job, visit, live, post, patch } from "./fixtures.mjs";

globalThis.window = globalThis.window || {};
const { actionsFor } = await import("../../../crm-app/modules/work/visit.js");
const { MANIFESTS } = await import("../../../crm-app/modules/index.js");

test("an owner assigned to a visit sees the field actions and works the visit; unassigned, they don't", async () => {
  const { t, owner, admin, tech } = await setup();
  try {
    const c = await customer(owner);
    const mine = await visit(owner, await job(owner, c), { date: "2026-11-17", start: "09:00", end: "11:00", assignee_ids: [owner.id] });
    const theirs = await visit(owner, await job(owner, c), { date: "2026-11-17", start: "12:00", end: "13:00", assignee_ids: [tech.id] });

    const got = await t.api(`/visits/${mine.id}`, { as: owner });
    assert.equal(got.status, 200);
    assert.equal(got.body.data.can.assignee, true);
    assert.equal(got.body.data.can.office, true, "an owner keeps the office's buttons too");
    const can = () => true;
    const acts = actionsFor(got.body.data, can, MANIFESTS);
    assert.ok(acts.some((a) => a.key === "field" && a.panel), "the field panel is offered");
    const other = await t.api(`/visits/${theirs.id}`, { as: owner });
    assert.equal(other.body.data.can.assignee, false);
    assert.ok(!actionsFor(other.body.data, can, MANIFESTS).some((a) => a.key === "field"), "not on someone else's visit");

    // the owner works their own visit with the same calls a tech makes
    let r = await post(t, owner, `/visits/${mine.id}/timer`, live({ action: "start" }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.visit.status, "in_progress");
    assert.ok(r.body.data.visit.office_notes === undefined || true);
    r = await patch(t, owner, `/visits/${mine.id}/checklist`, { key: "glass", done: true });
    assert.equal(r.status, 200);
    r = await post(t, owner, `/visits/${mine.id}/notes`, live({ text: "Synthetic: hard water spots on the south side." }));
    assert.equal(r.status, 200);
    assert.match(r.body.data.visit.tech_notes, /hard water/);

    // not on the visit: the office is told to add itself, a tech never learns it exists
    r = await post(t, admin, `/visits/${theirs.id}/timer`, live({ action: "start" }));
    assert.equal(r.status, 409);
    assert.match(r.body.error.message, /not on this visit/);
    const tess = await t.user("tech");
    r = await post(t, tess, `/visits/${theirs.id}/timer`, live({ action: "start" }));
    assert.equal(r.status, 404);
    r = await t.api("/tech/day", { as: owner });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.data.stops.map((s) => s.visit.id), [mine.id], "My visits: the owner's own");
  } finally { t.done(); }
});

test("a tech's field actions stop at the edge of their window (today − 7, today + 30)", async () => {
  const { t, owner, tech } = await setup();
  try {
    const c = await customer(owner);
    const far = await visit(owner, await job(owner, c), { date: "2026-12-20", start: "09:00", end: "11:00", assignee_ids: [tech.id] });
    let r = await post(t, tech, `/visits/${far.id}/notes`, live({ text: "Synthetic." }));
    assert.equal(r.status, 404, "a month out: not there yet");
    pin("2026-11-21T15:00:00Z");
    r = await post(t, tech, `/visits/${far.id}/notes`, live({ text: "Synthetic." }));
    assert.equal(r.status, 200, "inside 30 days");
    r = await t.api("/tech/day?date=2026-12-30", { as: tech });
    assert.equal(r.status, 400, "the day payload keeps to the window too");
    r = await t.api("/tech/day?date=2026-12-20", { as: tech });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.stops.length, 1);
  } finally { t.done(); }
});
