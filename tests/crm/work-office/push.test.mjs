// M4a acceptance (design §11.4 "push.test.mjs", §5.7.7): assign, move and
// cancel notify exactly the affected techs (never the person who made the
// change), with the date, time and town only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, customer, job, visit, store, drain, notes } from "./fixtures.mjs";

test("assign, move and cancel notify exactly the affected techs", async () => {
  const { t, owner, tech, tech2 } = await setup();
  try {
    const c = await customer(owner, {}, { town: "Mound" });
    const j = await job(owner, c);
    const got = () => notes(t).map((n) => `${n.user_id === tech.id ? "theo" : n.user_id === tech2.id ? "tess" : n.user_id === owner.id ? "owner" : "?"}:${n.kind}`).sort();
    const reset = () => { for (const k of t.stores.data.keys("rec/notification/")) t.stores.data.delete(k); for (const k of t.stores.data.keys("rel/user-")) t.stores.data.delete(k); };
    const patch = async (vid, body) => {
      const cur = await store.getRecord("visit", vid);
      const r = await t.api(`/visits/${vid}`, { method: "PATCH", as: owner, ifMatch: cur.etag, body });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      await drain(t);
    };

    // booked for Theo (and the owner, who made the booking: no push to yourself)
    const v = await visit(owner, j, { date: "2026-11-24", start: "08:00", end: "10:00", assignee_ids: [tech.id, owner.id] });
    await drain(t);
    assert.deepEqual(got(), ["theo:visit_assigned"]);
    const first = notes(t)[0];
    assert.equal(first.body, "You're on a visit Tue, Nov 24, 8:00 AM in Mound.");
    assert.equal(first.link, `/visits/${v.id}`);
    assert.ok(!/Sample|Example Ave|555/.test(JSON.stringify(notes(t))), "no customer name, street or phone in a push");

    // Tess added: only Tess hears
    reset();
    await patch(v.id, { assignee_ids: [tech.id, tech2.id] });
    assert.deepEqual(got(), ["tess:visit_assigned"]);

    // Theo taken off: only Theo hears
    reset();
    await patch(v.id, { assignee_ids: [tech2.id] });
    assert.deepEqual(got(), ["theo:visit_cancelled"]);
    assert.equal(notes(t)[0].body, "You're off the visit Tue, Nov 24, 8:00 AM in Mound.");

    // moved: Tess hears it moved; moved and Theo put back on at once: Theo hears he's on it
    reset();
    await patch(v.id, { date: "2026-11-25", start: "13:00", end: "15:00" });
    assert.deepEqual(got(), ["tess:visit_changed"]);
    assert.equal(notes(t)[0].body, "A visit moved to Wed, Nov 25, 1:00 PM in Mound.");
    reset();
    await patch(v.id, { date: "2026-11-26", assignee_ids: [tech.id, tech2.id] });
    assert.deepEqual(got(), ["tess:visit_changed", "theo:visit_assigned"]);

    // the route order changing tells nobody
    reset();
    await patch(v.id, { route_order: 2 });
    assert.deepEqual(got(), []);

    // cancelled: both hear, the owner who cancelled doesn't
    reset();
    const r = await t.api(`/visits/${v.id}/cancel`, { method: "POST", as: owner, body: { reason: "customer called" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await drain(t);
    assert.deepEqual(got(), ["tess:visit_cancelled", "theo:visit_cancelled"]);
  } finally { t.done(); }
});
