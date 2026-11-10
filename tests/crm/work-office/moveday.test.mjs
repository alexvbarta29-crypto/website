// M4a acceptance (design §11.4 "moveday.test.mjs", B14): the preview lists
// the moved visits; confirming creates a bulk run; visit.confirm never fires
// for a visit moved by the op. Also: one push per tech, a double tap is one
// run, a stale preview is refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, customer, job, visit, store, drain, notes, outbox } from "./fixtures.mjs";
import { advance, minutes } from "../../helpers/crm-clock.mjs";

const GUTTERS = [{ title: "Gutter cleaning", qty_milli: 1000, unit_cents: 19900, service_type: "Exterior Cleaning" }];

async function day(owner, tech, tech2) {
  const a = await customer(owner, {}, { town: "Mound" });
  const b = await customer(owner, {}, { town: "Wayzata" });
  const c = await customer(owner, {}, { town: "Delano" });
  const v1 = await visit(owner, await job(owner, a), { date: "2026-11-24", start: "08:00", end: "10:00", assignee_ids: [tech.id] });
  const v2 = await visit(owner, await job(owner, b), { date: "2026-11-24", start: "11:00", end: "13:00", assignee_ids: [tech.id, tech2.id] });
  const v3 = await visit(owner, await job(owner, c, { lines: GUTTERS }), { date: "2026-11-24", start: "13:00", end: "15:00", assignee_ids: [tech2.id] });
  const v4 = await visit(owner, await job(owner, c), { date: "2026-11-25", start: "08:00", end: "10:00", assignee_ids: [tech.id] });
  return { a, b, c, v1, v2, v3, v4 };
}

test("the preview lists the visits that would move and who'd be told; nothing changes", async () => {
  const { t, owner, tech, tech2 } = await setup();
  try {
    const d = await day(owner, tech, tech2);
    const body = { from_date: "2026-11-24", to_date: "2026-11-27", filter: { service_types: ["Residential Window Cleaning"] }, notify: true };
    const p = await t.api("/schedule/move-day", { method: "POST", as: owner, body });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.deepEqual(p.body.data.visits.map((v) => v.id), [d.v1.id, d.v2.id], "window cleaning only, in time order");
    assert.deepEqual(p.body.data.customers.map((c) => c.id).sort(), [d.a.id, d.b.id].sort());
    assert.deepEqual(p.body.data.techs.sort(), [tech.id, tech2.id].sort());
    assert.match(p.body.data.token, /^[0-9a-f]{20}$/);
    assert.equal((await store.getRecord("visit", d.v1.id)).data.date, "2026-11-24", "a preview moves nothing");
    // filter by tech
    const one = await t.api("/schedule/move-day", { method: "POST", as: owner, body: { ...body, filter: { assignee_ids: [tech2.id] } } });
    assert.deepEqual(one.body.data.visits.map((v) => v.id), [d.v2.id, d.v3.id]);
    // an office-only action
    assert.equal((await t.api("/schedule/move-day", { method: "POST", as: tech, body })).status, 403);
    assert.equal((await t.api("/schedule/move-day", { method: "POST", as: owner, body: { ...body, to_date: "2026-11-24" } })).status, 400);
    assert.equal((await t.api("/schedule/move-day", { method: "POST", as: owner, body: { ...body, to_date: "2026-11-10" } })).status, 400, "not into the past");
  } finally { t.done(); }
});

test("confirming moves the visits, pushes each tech once, makes one bulk run, and visit.confirm stays quiet", async () => {
  const { t, owner, tech, tech2 } = await setup();
  try {
    const d = await day(owner, tech, tech2);
    // the bookings' own confirmations come due and go to the outbox first (10-minute settle delay)
    await drain(t);
    advance(minutes(11));
    await drain(t);
    const before = outbox(t).filter((o) => o.template_key === "visit_confirm").length;
    assert.ok(before >= 3, "each booking was confirmed (dry run)");
    await drain(t);
    const notesBefore = notes(t).length;

    const body = { from_date: "2026-11-24", to_date: "2026-11-27", filter: {}, notify: true };
    const p = (await t.api("/schedule/move-day", { method: "POST", as: owner, body })).body.data;
    assert.equal(p.visits.length, 3);
    const stale = await t.api("/schedule/move-day", { method: "POST", as: owner, body: { ...body, confirm: true, token: "0".repeat(20) } });
    assert.equal(stale.status, 409, "a token that doesn't match the schedule is refused");
    const go = await t.api("/schedule/move-day", { method: "POST", as: owner, body: { ...body, confirm: true, token: p.token } });
    assert.equal(go.status, 202, JSON.stringify(go.body));
    const again = await t.api("/schedule/move-day", { method: "POST", as: owner, body: { ...body, confirm: true, token: p.token } });
    assert.equal(again.body.data.run_id, go.body.data.run_id, "a double tap is the same run");

    for (let i = 0; i < 4; i++) await t.runWorker({ lane: "bulk" });
    const run = (await t.api(`/runs/${go.body.data.run_id}`, { as: owner })).body.data;
    assert.equal(run.status, "done", JSON.stringify(run));
    assert.equal(run.result.moved, 3);
    for (const v of [d.v1, d.v2, d.v3]) {
      const now_ = (await store.getRecord("visit", v.id)).data;
      assert.equal(now_.date, "2026-11-27");
      assert.equal(now_.start, v.start, "times kept");
      assert.equal(now_.moved_by_op, "moveday--2026-11-24--1");
    }
    assert.equal((await store.getRecord("visit", d.v4.id)).data.date, "2026-11-25", "another day untouched");

    // the customers' notices: one bulk run waiting for its test send and a confirm
    const bulk = t.stores.data.keys("rec/bulk_run/").map((k) => t.stores.data.json(k));
    assert.equal(bulk.length, 1);
    assert.equal(bulk[0].kind, "moveday--2026-11-24--1");
    assert.equal(bulk[0].template_key, "visit_weather_move");
    assert.deepEqual(bulk[0].recipients.sort(), [d.a.id, d.b.id, d.c.id].sort());
    assert.equal(run.result.bulk_run_id, bulk[0].id);
    assert.match(bulk[0].per_recipient_vars[d.a.id].visit_date, /Fri, Nov 27/);
    assert.ok(["draft", "ready"].includes(bulk[0].status), "nothing goes out before the test send and the confirm");

    // pushes: one per tech for the move, none per visit
    await drain(t);
    advance(minutes(20));
    await drain(t);
    const pushes = notes(t).filter((n) => n.kind === "visit_changed");
    assert.deepEqual(pushes.map((n) => n.user_id).sort(), [tech.id, tech2.id].sort(), JSON.stringify(pushes.map((n) => n.body)));
    assert.ok(pushes.every((n) => /^2 of your visits moved from Tue, Nov 24 to Fri, Nov 27/.test(n.body)), "one push per tech, none per visit");
    assert.equal(notes(t).length, notesBefore + 2);
    // visit.confirm never fired for the moved visits
    const after = outbox(t).filter((o) => o.template_key === "visit_confirm");
    assert.equal(after.length, before, "no new confirmation");
    assert.equal(outbox(t).filter((o) => o.template_key === "visit_weather_move").length, 0, "the notices wait for the bulk run's confirm");

    // a second move of the same day is a new op (n = 2)
    const p2 = (await t.api("/schedule/move-day", { method: "POST", as: owner, body: { from_date: "2026-11-25", to_date: "2026-11-30", filter: {}, notify: false } })).body.data;
    const go2 = await t.api("/schedule/move-day", { method: "POST", as: owner, body: { from_date: "2026-11-25", to_date: "2026-11-30", filter: {}, notify: false, confirm: true, token: p2.token } });
    assert.equal(go2.status, 202);
    for (let i = 0; i < 3; i++) await t.runWorker({ lane: "bulk" });
    assert.equal((await store.getRecord("visit", d.v4.id)).data.moved_by_op, "moveday--2026-11-25--1");
    assert.equal(t.stores.data.keys("rec/bulk_run/").length, 1, "notify: false makes no notice");
  } finally { t.done(); }
});
