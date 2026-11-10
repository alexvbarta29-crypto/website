// M2b acceptance: while texting is dry-run (the whole parallel run), a
// step's text lands in the Outbox and the call list offers Copy text and
// Open in Messages, then asks "Did you send it?"; the answer records
// sent_by_hand (design §11.4 "dry-run-hand.test.mjs", §5.2 step 10).
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, makeLead, enrollment, outbox, local, E, store } from "./fixtures.mjs";

test("no answer on a new-lead step: the text goes to the Outbox, the step waits for \"Did you send it?\"", async () => {
  const { t, owner } = await setup();
  try {
    const c = await makeLead(owner);
    const id = await E.enroll(c.id, "new_lead", {}, { by: owner.id, origin: "api", actor_kind: "user", requestId: "x" });
    const call = await t.api("/calls", { method: "POST", as: owner, body: { contact_id: c.id, enrollment_id: id, outcome: "no_answer", double_dial: true, client_id: "call-0000-0001" } });
    assert.equal(call.status, 200, JSON.stringify(call.body));
    const next = call.body.data.next;
    assert.equal(next.kind, "hand", "dry-run: send it by hand");
    assert.match(next.text, /^Hey Pat! This is Alex with BARTA Window Washing\. I saw you requested a quote/);
    assert.doesNotMatch(next.text, /STOP/i, "a text sent by hand carries no footer (Rotor's number adds its own)");
    assert.ok(next.sms_href.startsWith(`sms:${c.phones[0].e164}?&body=`), "Open in Messages");
    assert.equal(decodeURIComponent(next.sms_href.split("&body=")[1]), next.text);
    const items = outbox(t);
    assert.equal(items.length, 1, "the text is in the Outbox");
    assert.equal(items[0].mode, "dry_run");
    assert.equal(items[0].related.enrollment_id, id);
    assert.equal(items[0].origin.kind, "cadence");
    let e = await enrollment(id);
    assert.equal(e.step_n, 1, "the step waits for the answer");
    assert.equal(e.pending.kind, "hand");
    assert.deepEqual(e.history.map((h) => [h.action, h.outcome, h.double_dial]), [["call", "no_answer", true]], "a double dial is one touch (D8)");
    assert.equal(t.stores.data.keys("rec/message/").length, 0, "dry-run writes no message");

    // the same request again (a retry): nothing twice
    const again = await t.api("/calls", { method: "POST", as: owner, body: { contact_id: c.id, enrollment_id: id, outcome: "no_answer", double_dial: true, client_id: "call-0000-0001" } });
    assert.equal(again.status, 200);
    assert.equal(outbox(t).length, 1, "one text, ever");
    assert.equal((await enrollment(id)).history.length, 1);

    // "Did you send it?" Yes, through Messages
    const yes = await t.api(`/cadence-steps/${id}/1/sent-by-hand`, { method: "POST", as: owner, body: { how: "sms_link" } });
    assert.equal(yes.status, 200, JSON.stringify(yes.body));
    e = await enrollment(id);
    assert.equal(e.step_n, 2, "the step moved on");
    assert.equal(e.pending, undefined);
    const sent = e.history.find((h) => h.action === "text");
    assert.equal(sent.sent_by_hand, "sms_link");
    assert.equal(sent.outbox_id, items[0].id);
    assert.equal(local(e.next_due_at), "Tue 11-17 12:00");
    const twice = await t.api(`/cadence-steps/${id}/1/sent-by-hand`, { method: "POST", as: owner, body: { how: "copy" } });
    assert.equal(twice.status, 200);
    assert.equal(twice.body.data.already, true, "answering twice changes nothing");
    const act = t.stores.data.keys(`rel/contact-activity/${c.id}/`).map((k) => k.split("/").pop().split("--")[1]);
    assert.ok(act.includes("call.no_answer") && act.includes("cadence.text_by_hand"), "the call and the hand-sent text are on the timeline");
    const stats = (await store.getRecord("contact_stats", c.id)).data.sales;
    assert.ok(stats.last_called_at && stats.last_touch_at);

    // step 2: Copy text this time
    const call2 = await t.api("/calls", { method: "POST", as: owner, body: { contact_id: c.id, enrollment_id: id, outcome: "voicemail" } });
    assert.match(call2.body.data.next.text, /phone tag/);
    assert.match(call2.body.data.next.text, /over 150 5 star ratings you can read through: https:\/\/g\.page\/r\/CfnTsPliwEw4EBM\/review/);
    const copy = await t.api(`/cadence-steps/${id}/2/sent-by-hand`, { method: "POST", as: owner, body: { how: "copy" } });
    assert.equal(copy.status, 200);
    assert.equal((await enrollment(id)).history.filter((h) => h.sent_by_hand === "copy").length, 1);
    assert.equal((await t.api(`/cadence-steps/${id}/2/sent-by-hand`, { method: "POST", as: owner, body: { how: "copy" } })).body.data.already, true);
    assert.equal((await t.api(`/cadence-steps/${id}/5/sent-by-hand`, { method: "POST", as: owner, body: { how: "copy" } })).status, 409, "a step that isn't current");
  } finally { t.done(); }
});

test("the call list shows the step waiting for its hand-sent text, and Skip moves on without a text", async () => {
  const { t, owner } = await setup();
  try {
    const c = await makeLead(owner);
    const id = await E.enroll(c.id, "new_lead", {}, { by: owner.id, origin: "api", actor_kind: "user", requestId: "x" });
    await t.api("/calls", { method: "POST", as: owner, body: { contact_id: c.id, enrollment_id: id, outcome: "no_answer" } });
    const list = await t.api("/calls/list", { as: owner });
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.equal(list.body.data.sms_mode, "dry_run");
    const row = list.body.data.due.find((r) => r.id === id);
    assert.equal(row.pending, "hand");
    assert.equal(row.phone, c.phones[0].e164);
    assert.equal(row.cadence, "New lead - no estimate yet");
    const skip = await t.api(`/enrollments/${id}/skip`, { method: "POST", as: owner, body: {} });
    assert.equal(skip.status, 200);
    const e = await enrollment(id);
    assert.equal(e.step_n, 2);
    assert.equal(e.history.at(-1).action, "skipped");
  } finally { t.done(); }
});

test("\"Did you send it?\" only for a text the app prepared: a step with no call logged is refused (409), nothing moves", async () => {
  const { t, owner } = await setup();
  try {
    const c = await makeLead(owner);
    const id = await E.enroll(c.id, "estimate_followup", { quote_id: "qt_00000000000000000061" }, { by: owner.id, origin: "api", actor_kind: "user", requestId: "x" });
    const r = await t.api(`/cadence-steps/${id}/1/sent-by-hand`, { method: "POST", as: owner, body: { how: "copy" } });
    assert.equal(r.status, 409);
    assert.match(r.body.error.message, /no text waiting/i);
    const e = await enrollment(id);
    assert.equal(e.step_n, 1);
    assert.equal(e.history.length, 0, "no step logged, no offer applied");
  } finally { t.done(); }
});

test("outside 8 AM-8 PM: the text waits (no Copy or Messages), the list says until when, and \"I sent it\" is refused until then", async () => {
  const { pin } = await import("./fixtures.mjs");
  const { t, owner } = await setup("2026-11-18T02:30:00Z");      // Tuesday 20:30
  try {
    const c = await makeLead(owner);
    const id = await E.enroll(c.id, "new_lead", {}, { by: owner.id, origin: "api", actor_kind: "user", requestId: "x" });
    const call = await t.api("/calls", { method: "POST", as: owner, body: { contact_id: c.id, enrollment_id: id, outcome: "no_answer", client_id: "late-0000-0001" } });
    assert.equal(call.status, 200);
    assert.equal(call.body.data.next.kind, "hand");
    assert.equal(call.body.data.next.hold_until, "2026-11-18T14:00:00.000Z", "8:00 AM Wednesday");
    assert.equal((await enrollment(id)).pending.hold_until, "2026-11-18T14:00:00.000Z");
    const list = await t.api("/calls/list", { as: owner });
    const row = list.body.data.due.find((r) => r.id === id);
    assert.equal(row.hold_until, "2026-11-18T14:00:00.000Z");
    const early = await t.api(`/cadence-steps/${id}/1/sent-by-hand`, { method: "POST", as: owner, body: { how: "copy" } });
    assert.equal(early.status, 409);
    assert.match(early.body.error.message, /too late to text now/);
    pin("2026-11-18T14:05:00Z");                                 // 8:05 AM
    assert.equal((await t.api(`/cadence-steps/${id}/1/sent-by-hand`, { method: "POST", as: owner, body: { how: "copy" } })).status, 200);
    assert.equal((await enrollment(id)).step_n, 2);
    // a text left waiting from the afternoon shows as waiting for the morning once it's past 8 PM
    const d = await makeLead(owner);
    const idd = await E.enroll(d.id, "new_lead", {}, { by: owner.id, origin: "api", actor_kind: "user", requestId: "x" });
    pin("2026-11-18T15:05:00Z");                                 // 9:05 AM
    await t.api("/calls", { method: "POST", as: owner, body: { contact_id: d.id, enrollment_id: idd, outcome: "no_answer", client_id: "late-0000-0002" } });
    assert.equal((await enrollment(idd)).pending.hold_until, undefined, "in hours: send it now");
    pin("2026-11-19T02:45:00Z");                                 // 8:45 PM
    const l2 = await t.api("/calls/list", { as: owner });
    assert.equal(l2.body.data.due.find((r) => r.id === idd).hold_until, "2026-11-19T14:00:00.000Z");
    const det = await t.api(`/enrollments/${idd}`, { as: owner });
    assert.equal(det.body.data.enrollment.pending.hold_until, "2026-11-19T14:00:00.000Z");
  } finally { t.done(); }
});
