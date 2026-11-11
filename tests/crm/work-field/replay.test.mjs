// Offline replays (design §2.5, §3.3 client ids, §11.4 M4b
// "replay.test.mjs"): a client id makes a double replay one record, for
// every field change the phone queues. The Idempotency-Key would answer a
// repeat for 7 days; the client id dedupes beyond that, and across a
// direct attempt whose answer was lost and the outbox's replay of it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { advance, minutes } from "../../helpers/crm-clock.mjs";
import { BYTES } from "../../helpers/crm-fixtures.mjs";
import { setup, customer, job, visit, clock, store, AS, cid, offline, live, post, patch, rec, sheets, timers } from "./fixtures.mjs";

const jpeg = () => Buffer.from(BYTES.jpeg()).toString("base64");
// The same request twice, each time with a fresh Idempotency-Key (as the
// direct attempt and the outbox's replay of it would be).
async function twice(t, as, method, path, body) {
  const a = await t.api(path, { method, as, body, idem: cid() });
  const b = await t.api(path, { method, as, body: { ...body, queued_offline: true, queued_at: body.client_at }, idem: cid() });
  return [a, b];
}

test("a client id makes a double replay one record: timer, clock, photo, note, line, incident, completion", async () => {
  const { t, owner, tech } = await setup();
  try {
    const c = await customer(owner);
    const j = await job(owner, c);
    const v = await visit(owner, j, { date: "2026-11-17", start: "09:00", end: "11:00", assignee_ids: [tech.id] });
    const item = (await store.createRecord("price_item", { key: "screens", name: "Screen Cleaning", category: "screens", service_type: "Residential Window Cleaning", unit: "screen", unit_cents: 500, active: true, sellable: true }, AS(owner))).data;

    // start: one segment, one shift
    let [a, b] = await twice(t, tech, "POST", `/visits/${v.id}/timer`, live({ action: "start" }));
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.equal(timers(t).length, 1);
    assert.equal(sheets(t).length, 1);
    assert.equal(b.body.data.replay, true);
    advance(minutes(30));
    // pause twice: one close
    [a, b] = await twice(t, tech, "POST", `/visits/${v.id}/timer`, live({ action: "pause" }));
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.equal(timers(t)[0].end_at, a.body.data.timer.end_at);
    assert.equal(timers(t).length, 1);
    // a photo: one file, one entry on the visit
    [a, b] = await twice(t, tech, "POST", `/visits/${v.id}/photos`, live({ data: jpeg(), tag: "before", item: "walkaround_photo" }));
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.equal(b.status, 201);
    assert.equal(a.body.data.photo.id, b.body.data.photo.id);
    assert.equal(t.stores.data.keys("rec/file/").length, 1);
    assert.equal((await rec("visit", v.id)).photos.length, 1);
    // a note: once
    [a, b] = await twice(t, tech, "POST", `/visits/${v.id}/notes`, live({ text: "Synthetic: back gate sticks." }));
    assert.equal((await rec("visit", v.id)).tech_notes, "Synthetic: back gate sticks.");
    // an upsell line: once, credited to the tech
    [a, b] = await twice(t, tech, "POST", `/visits/${v.id}/lines`, live({ price_item_id: item.id, qty: 12 }));
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.equal(b.status, 200);
    const lines = (await rec("job", j.id)).lines.filter((l) => l.upsell_user_id === tech.id);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].qty_milli, 12000);
    assert.equal(lines[0].total_cents, 6000);
    // an incident: one task
    [a, b] = await twice(t, tech, "POST", `/visits/${v.id}/incident`, live({ text: "Synthetic: cracked storm window on arrival." }));
    assert.equal(a.body.data.task_id, b.body.data.task_id);
    const tasks = t.stores.data.keys("rec/task/").map((k) => t.stores.data.json(k)).filter((x) => x.kind === "incident");
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].priority, "high");
    assert.equal(tasks[0].due_at, undefined, "no due date (barta-rules §8)");
    assert.equal(tasks[0].reported_on, "2026-11-17");
    assert.deepEqual(tasks[0].assignee_ids, [owner.id]);
    // the rest of the checklist, then complete twice: one completion
    await post(t, tech, `/visits/${v.id}/photos`, live({ data: jpeg(), tag: "after", item: "after_photo" }));
    await patch(t, tech, `/visits/${v.id}/checklist`, { key: "gate_closed", done: true, client_id: cid() });
    const body = live();
    a = await post(t, tech, `/visits/${v.id}/complete`, body);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    const at = (await rec("visit", v.id)).completion.at;
    advance(minutes(3));
    b = await post(t, tech, `/visits/${v.id}/complete`, { ...body, queued_offline: true, queued_at: body.client_at });
    assert.equal(b.status, 200);
    assert.equal((await rec("visit", v.id)).completion.at, at, "the first completion stands");
    // clock out twice: one close
    const out = live({ action: "out" });
    a = await post(t, tech, "/clock", out);
    b = await post(t, tech, "/clock", { ...out, queued_offline: true, queued_at: out.client_at });
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.equal(b.body.data.replay, true);
    assert.equal(sheets(t).filter((s) => s.status === "closed").length, 1);
  } finally { t.done(); }
});

test("on my way and running late need signal: a replay is refused and nothing is sent; a double tap sends one text", async () => {
  const { t, owner, tech } = await setup();
  try {
    const v = await visit(owner, await job(owner, await customer(owner)), { date: "2026-11-17", start: "10:00", end: "12:00", assignee_ids: [tech.id] });
    let r = await post(t, tech, `/visits/${v.id}/on-my-way`, offline({ eta_min: 15 }));
    assert.equal(r.status, 409);
    assert.match(r.body.error.message, /needs signal/);
    assert.equal(t.stores.data.keys("rec/outbox/").length, 0, "nothing sent late");
    const body = live({ eta_min: 15 });
    r = await post(t, tech, `/visits/${v.id}/on-my-way`, body);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const again = await post(t, tech, `/visits/${v.id}/on-my-way`, body);
    assert.equal(again.status, 200);
    assert.equal(t.stores.data.keys("rec/outbox/").length, 1, "one text");
    r = await post(t, tech, `/visits/${v.id}/running-late`, offline({ eta_min: 20 }));
    assert.equal(r.status, 409);
    // a crash between the visit's write and the text: the repeat sends it, once
    const v2 = await visit(owner, await job(owner, await customer(owner)), { date: "2026-11-17", start: "12:00", end: "13:00", assignee_ids: [tech.id] });
    const id2 = cid();
    await store.updateRecord("visit", v2.id, (x) => ({ ...x, status: "en_route", on_my_way: { at: clock.nowIso(), by: tech.id, eta_min: 12, client_id: id2 } }), AS(tech));
    r = await post(t, tech, `/visits/${v2.id}/on-my-way`, { eta_min: 12, client_id: id2 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.text.status, "dry_run");
    assert.match(r.body.data.text.hand.body, /about 12 minutes/);
    r = await post(t, tech, `/visits/${v2.id}/on-my-way`, { eta_min: 12, client_id: id2 });
    assert.equal(t.stores.data.keys("rec/outbox/").length, 2, "one text each visit");
    // a crash between completing and stopping the timers: the repeat stops them
    const v3 = await visit(owner, await job(owner, await customer(owner), { kind: "touch_up", lines: [{ title: "Touch-up", unit_cents: 0 }] }), { date: "2026-11-17", start: "14:00", end: "15:00", assignee_ids: [tech.id] });
    await post(t, tech, `/visits/${v3.id}/timer`, live({ action: "start" }));
    await store.updateRecord("visit", v3.id, (x) => ({ ...x, status: "completed", completion: { at: clock.nowIso(), by: tech.id } }), AS(tech));
    r = await post(t, tech, `/visits/${v3.id}/complete`, live());
    assert.equal(r.body.data.already, true);
    assert.ok(timers(t).filter((x) => x.visit_id === v3.id).every((x) => x.end_at), "no timer left running");
  } finally { t.done(); }
});
