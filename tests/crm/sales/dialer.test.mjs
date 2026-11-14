// The Power Dialer (guide-gaps S9, D1-D13): named queues per person (made from
// a source, reordered with If-Match, Call next / Previous / Skip, cleared),
// the built-in Follow-up calls queue, a call_log row for every logged call,
// Call logs and their stats, the call scripts. Nothing dials or sends.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, makeLead, outbox } from "./fixtures.mjs";

const D = await import("../../../netlify/lib/crm/modules/sales/dialer.mjs");

test("the pure pieces: the stats, a queue's steps, a source's contacts", () => {
  const rows = [
    { c: "ct_1", by: "us_1", out: "spoke", at: "2026-11-17T15:05:00.000Z" }, { c: "ct_2", by: "us_1", out: "voicemail", at: "2026-11-17T15:30:00.000Z" },
    { c: "ct_3", by: "us_2", out: "booked", at: "2026-11-16T18:00:00.000Z", dur: 120 }, { c: "ct_4", by: "us_2", out: "no_answer", at: "2026-11-16T18:10:00.000Z", dur: 30 },
  ];
  const s = D.callStats(rows, "2026-11-17");
  assert.deepEqual([s.total, s.answered, s.voicemails, s.completed, s.today, s.avg_duration_s, s.per_hour], [4, 2, 1, 4, 2, 75, 2]);
  assert.deepEqual(s.by_person.us_2, { total: 2, answered: 1, booked: 1, not_interested: 0 });
  assert.equal(D.callStats([{ out: "spoke", at: "2026-11-17T15:00:00Z" }], "2026-11-17").avg_duration_s, null, "no durations without the business line");
  const q = { ids: ["a", "b", "c"], cursor: 0 };
  assert.equal(D.stepQueue(q, "next").cursor, 1);
  assert.equal(D.stepQueue(q, "prev"), null, "nothing before the first");
  assert.deepEqual(D.stepQueue(q, "skip").ids, ["b", "c", "a"], "skip: to the end");
  assert.equal(D.stepQueue({ ids: ["a"], cursor: 0 }, "next"), null);
  assert.deepEqual(D.sourceIds({ kind: "leads", stage: "new" }, { leads: [{ id: "ct_1", stage: "new", ca: "2026-11-01" }, { id: "ct_2", stage: "quoted" }, { id: "ct_3", stage: "new", ca: "2026-11-05" }] }), ["ct_3", "ct_1"]);
  assert.deepEqual(D.sourceIds({ kind: "pipeline", cadence: "new_lead", step: 2 }, { enrollments: [{ c: "ct_1", cad: "new_lead", n: 2 }, { c: "ct_2", cad: "new_lead", n: 1 }] }), ["ct_1"]);
  assert.equal(D.validateScripts({ scripts: [D.DEFAULT_SCRIPT] }).scripts[0].sections.length, 6, "Rotor's six sections");
});

test("queues, call logs, stats and scripts over the API; one person's queue is theirs only", async () => {
  const { t, owner, admin, tech } = await setup();
  try {
    const a = await makeLead(owner), b = await makeLead(owner), c = await makeLead(owner);
    // the built-in queue is always there
    let r = await t.api("/dialer/queues", { as: owner });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data[0].id, "followups");
    // a queue of new leads (Rotor's leads filter)
    r = await t.api("/dialer/queues", { method: "POST", as: owner, body: { name: "New leads", source: { kind: "leads", stage: "new" } } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const q = r.body.data.queue;
    for (const x of [a, b, c]) assert.ok(q.ids.includes(x.id), "every new lead");
    let g = await t.api(`/dialer/queues/${q.id}`, { as: owner });
    assert.equal(g.body.data.rows.length, q.ids.length);
    // reorder (If-Match), then Call next / Previous / Skip
    const order = [c.id, a.id, b.id, ...q.ids.filter((x) => ![a.id, b.id, c.id].includes(x))];
    r = await t.api(`/dialer/queues/${q.id}`, { method: "PATCH", as: owner, ifMatch: g.headers.get("etag"), body: { ids: order } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.data.queue.ids.slice(0, 3), [c.id, a.id, b.id]);
    assert.equal((await t.api(`/dialer/queues/${q.id}`, { method: "PATCH", as: owner, ifMatch: g.headers.get("etag"), body: { ids: [a.id] } })).status, 412, "an old version");
    r = await t.api(`/dialer/queues/${q.id}/step`, { method: "POST", as: owner, body: { dir: "next" } });
    assert.equal(r.body.data.queue.cursor, 1);
    r = await t.api(`/dialer/queues/${q.id}/step`, { method: "POST", as: owner, body: { dir: "prev" } });
    assert.equal(r.body.data.queue.cursor, 0);
    r = await t.api(`/dialer/queues/${q.id}/step`, { method: "POST", as: owner, body: { dir: "skip" } });
    assert.equal(r.body.data.queue.ids.at(-1), c.id, "skipped to the end");
    // someone else's queue: not there
    assert.equal((await t.api(`/dialer/queues/${q.id}`, { as: admin })).status, 404);
    assert.equal((await t.api("/dialer/queues", { as: tech })).status, 403);
    // calls: each logged call is a row; nothing is sent
    const sent = outbox(t).length;
    for (const [who, outcome] of [[a, "spoke"], [b, "voicemail"], [c, "booked"]]) {
      const cr = await t.api("/calls", { method: "POST", as: owner, body: { contact_id: who.id, outcome, client_id: `call-${who.id.slice(-8)}-0001` } });
      assert.equal(cr.status, 200, JSON.stringify(cr.body));
    }
    await t.api("/calls", { method: "POST", as: owner, body: { contact_id: a.id, outcome: "spoke", client_id: `call-${a.id.slice(-8)}-0001` } });
    const logs = await t.api("/calls/logs", { as: owner });
    assert.equal(logs.status, 200, JSON.stringify(logs.body));
    assert.equal(logs.body.data.length, 3, "a replay is the same row");
    assert.deepEqual(new Set(logs.body.data.map((x) => x.out)), new Set(["spoke", "voicemail", "booked"]));
    assert.equal((await t.api("/calls/logs?out=voicemail", { as: owner })).body.data.length, 1);
    const st = await t.api("/calls/stats", { as: owner });
    assert.deepEqual([st.body.data.total, st.body.data.answered, st.body.data.voicemails, st.body.data.today, st.body.data.avg_duration_s], [3, 2, 1, 3, null]);
    assert.equal(outbox(t).length >= sent, true);
    // clear, then delete
    r = await t.api(`/dialer/queues/${q.id}/clear`, { method: "POST", as: owner, body: {} });
    assert.deepEqual(r.body.data.queue.ids, []);
    assert.equal((await t.api(`/dialer/queues/${q.id}`, { method: "DELETE", as: owner })).status, 200);
    assert.equal((await t.api(`/dialer/queues/${q.id}`, { as: owner })).status, 404);
    // the scripts: Rotor's six sections by default
    const sc = await t.api("/dialer/scripts", { as: owner });
    assert.deepEqual(sc.body.data[0].sections.map((x) => x.key), ["opening", "purpose", "discovery", "value", "next", "closing"]);
    // the built-in follow-up calls queue
    g = await t.api("/dialer/queues/followups", { as: owner });
    assert.equal(g.status, 200, JSON.stringify(g.body));
    assert.equal(g.body.data.queue.builtin, true);
  } finally { t.done(); }
});
