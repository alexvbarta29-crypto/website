// The Visits list (the Nov 2026 layout, after Rotor's Visits screen):
// GET /visits?date= gives one day's visits in time order as cards: the
// customer, which visit of the job (n/m), the time, the minutes worked, the
// job's amount and whether its invoice is still owed, and the status; the
// office only; and the client's card shows them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, customer, job, visit } from "./fixtures.mjs";

globalThis.window = globalThis.window || { __crm: { session: { perms: {} } } };
const V = (await import("../../../crm-app/modules/work/visits.js"));

test("a day's visits as cards, in time order, for the office only", async () => {
  const { t, owner, tech } = await setup();
  try {
    const c1 = await customer(owner);
    const c2 = await customer(owner);
    const j1 = await job(owner, c1);
    const j2 = await job(owner, c2);
    await visit(owner, j2, { date: "2026-11-17", start: "13:00", end: "14:00", assignee_ids: [tech.id] });
    await visit(owner, j1, { date: "2026-11-17", start: "08:00", end: "10:00", assignee_ids: [tech.id] });
    await visit(owner, j1, { date: "2026-11-18", start: "08:00", end: "10:00", assignee_ids: [tech.id] });
    const r = await t.api("/visits?date=2026-11-17", { as: owner });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const d = r.body.data;
    assert.equal(d.date, "2026-11-17");
    assert.deepEqual(d.visits.map((v) => v.start), ["08:00", "13:00"], "in time order");
    const first = d.visits[0];
    assert.equal(first.contact_name, c1.display_name || `${c1.first_name} ${c1.last_name}`);
    assert.deepEqual([first.n, first.m, first.status, first.unpaid], [1, 2, "scheduled", false]);
    assert.ok(first.amount_cents > 0, "the job's amount");
    assert.equal((await t.api("/visits", { as: owner })).body.data.date, "2026-11-17", "the server's today by default");
    assert.equal((await t.api("/visits?date=nope", { as: owner })).status, 400);
    assert.equal((await t.api("/visits?date=2026-11-17", { as: tech })).status, 403, "a technician has Today");
    const h = String(V.visitCard({ ...first, unpaid: true, minutes: 75, status: "completed" }));
    assert.match(h, /Finished/);
    assert.match(h, /1h 15m/);
    assert.match(h, /aria-label="Not paid yet"/);
    assert.match(h, /1\/2/);
  } finally { t.done(); }
});
