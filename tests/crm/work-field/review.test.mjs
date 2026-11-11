// Regression tests from the M4b review (design §2.5 "Conflicts", "Times
// from the device"; §0 rule 12): nothing a tech does offline is silently
// lost or doubled, and nobody else sees it.
//   R1/R2  a replay for a visit the person lost (reassigned, moved past the
//          window, deleted) becomes an entry for the office that keeps what
//          the phone said (a photo held on it); the answer carries nothing
//          of the visit; an incident still reaches the owners
//   R3     an upsell queued offline after the job closed: an entry, not a 409
//   R4     a phone clock that's off: the times are corrected and wait
//   R5     two phones: an overlapping shift or timer is an entry, never
//          dropped and never counted twice
//   R7     ticks, notes, photos on a cancelled visit: in, and the office hears
//   R8     a shift begun after 21:00 isn't closed a minute later
//   R12    a PDF isn't a visit photo; an office PDF is an attachment
//   R13    the timers sweep never writes to a visit Rotor owns
//   R14    work done on the day before the office moved the visit waits
import { test } from "node:test";
import assert from "node:assert/strict";
import { advance, hours, minutes, days, pin } from "../../helpers/crm-clock.mjs";
import { BYTES } from "../../helpers/crm-fixtures.mjs";
import { setup, customer, job, visit, clock, store, AS, TS, TM, offline, live, post, patch, rec, sheets, timers, cid } from "./fixtures.mjs";
import * as WO from "../work-office/fixtures.mjs";

const jpeg = () => Buffer.from(BYTES.jpeg()).toString("base64");
const ago = (ms) => new Date(clock.nowMs() - ms).toISOString();
const pending = (t) => sheets(t).filter((s) => s.status === "pending_approval");
const noVisitIn = (body, v) => {
  const s = JSON.stringify(body);
  for (const k of [v.id, v.job_title, v.contact_name, v.address_line, v.town].filter(Boolean)) assert.ok(!s.includes(k), `the answer carries nothing of the visit (${k})`);
};
async function reassign(t, owner, vid, body) {
  const cur = await store.getRecord("visit", vid);
  const r = await t.api(`/visits/${vid}`, { method: "PATCH", as: owner, ifMatch: cur.etag, body });
  assert.equal(r.status, 200, JSON.stringify(r.body));
}

test("R1 reassigned while the tech was offline: every replay is kept for the office (202), the photo held, the incident still reported", async () => {
  const { t, owner, tech, tech2 } = await setup();
  try {
    const v = await visit(owner, await job(owner, await customer(owner)), { date: "2026-11-17", start: "09:00", end: "11:00", assignee_ids: [tech.id] });
    await reassign(t, owner, v.id, { assignee_ids: [tech2.id] });
    advance(hours(2));
    const out = {
      start: await post(t, tech, `/visits/${v.id}/timer`, offline({ action: "start" }, ago(hours(2)))),
      photo: await post(t, tech, `/visits/${v.id}/photos`, offline({ data: jpeg(), tag: "before", item: "walkaround_photo" }, ago(hours(2) - minutes(5)))),
      tick: await patch(t, tech, `/visits/${v.id}/checklist`, offline({ key: "gate_closed", done: true }, ago(minutes(40)))),
      note: await post(t, tech, `/visits/${v.id}/notes`, offline({ text: "Synthetic: cracked pane, back left." }, ago(minutes(35)))),
      complete: await post(t, tech, `/visits/${v.id}/complete`, offline({}, ago(minutes(30)))),
    };
    for (const [k, r] of Object.entries(out)) {
      assert.equal(r.status, 202, `${k}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.data.reason, "lost");
      assert.equal(r.body.data.visit, undefined);
      noVisitIn(r.body, { ...v, id: "never-matches" });
    }
    const entries = pending(t);
    assert.equal(entries.length, 5, "one entry each, none lost");
    assert.ok(entries.every((e) => e.pending.reason === "lost" && e.visit_id === v.id && !e.pending.job_title), "the entry has the visit for the office, no details for the tech");
    const note = entries.find((e) => e.pending.action === "notes");
    assert.equal(note.pending.payload.text, "Synthetic: cracked pane, back left.", "the note's words are kept");
    const photo = entries.find((e) => e.pending.action === "photo");
    assert.equal(photo.pending.file_ids.length, 1, "the photo is held on the entry");
    const file = await rec("file", photo.pending.file_ids[0]);
    assert.deepEqual(file.owner, { type: "timesheet", id: photo.id });
    assert.equal(file.customer_visible, false);
    assert.equal((await rec("visit", v.id)).photos.length, 0, "never on the visit");
    // the office reads the photo; the tech who took it too; another tech doesn't
    assert.equal((await t.api(`/files/${file.id}`, { as: owner })).status, 200);
    assert.equal((await t.api(`/files/${file.id}`, { as: tech })).status, 200);
    assert.notEqual((await t.api(`/files/${file.id}`, { as: tech2 })).status, 200);
    // nothing changed on the visit tech2 now owns; a replay of the same is the same entry
    const after = await rec("visit", v.id);
    assert.equal(after.status, "scheduled");
    assert.equal(timers(t).length, 0);
    // an incident reaches the owners whoever has the visit now
    const inc = await post(t, tech, `/visits/${v.id}/incident`, offline({ text: "Synthetic: ladder scuffed the siding." }, ago(minutes(32))));
    assert.equal(inc.status, 201, JSON.stringify(inc.body));
    assert.deepEqual(Object.keys(inc.body.data), ["task_id"]);
    const task = await rec("task", inc.body.data.task_id);
    assert.equal(task.kind, "incident");
    assert.equal(task.visit_id, v.id);
    // live (not a replay): still 404, ids can't be probed
    assert.equal((await post(t, tech, `/visits/${v.id}/notes`, live({ text: "x" }))).status, 404);
    // a visit id that was never there: 404 even for a replay
    assert.equal((await post(t, tech, "/visits/vs_zzzzzzzzzzzzzzzzzzzz/notes", offline({ text: "x" }))).status, 404);
  } finally { t.done(); }
});

test("R2 moved past the tech window, or deleted, while offline: kept for the office too", async () => {
  const { t, owner, tech } = await setup();
  try {
    const v = await visit(owner, await job(owner, await customer(owner)), { date: "2026-11-17", start: "13:00", end: "15:00", assignee_ids: [tech.id] });
    await reassign(t, owner, v.id, { date: "2026-12-28" });
    const r = await post(t, tech, `/visits/${v.id}/timer`, offline({ action: "start" }, ago(minutes(10))));
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.equal(r.body.data.reason, "lost");
    assert.equal(pending(t).length, 1);
  } finally { t.done(); }
});

test("R3 an upsell queued offline after a co-worker completed the job: a pending entry with the line, not a 409", async () => {
  const { t, owner, tech, tech2 } = await setup();
  try {
    const j = await job(owner, await customer(owner), { kind: "touch_up", lines: [{ title: "Touch-up", unit_cents: 0 }] });
    const v = await visit(owner, j, { date: "2026-11-17", start: "09:00", end: "11:00", assignee_ids: [tech.id, tech2.id] });
    const item = (await store.createRecord("price_item", { key: "screens", name: "Screen Cleaning", category: "screens", service_type: "Residential Window Cleaning", unit: "screen", unit_cents: 500, active: true, sellable: true }, AS(owner))).data;
    advance(hours(1));
    assert.equal((await post(t, tech2, `/visits/${v.id}/complete`, live())).status, 200);
    const body = offline({ price_item_id: item.id, qty: 12 }, ago(minutes(30)));
    const r = await post(t, tech, `/visits/${v.id}/lines`, body);
    assert.equal(r.status, 202, JSON.stringify(r.body));
    const e = pending(t);
    assert.equal(e.length, 1);
    assert.equal(e[0].pending.action, "lines");
    assert.deepEqual(e[0].pending.payload, { price_item_id: item.id, qty: 12 });
    assert.equal((await rec("job", j.id)).lines.filter((l) => l.upsell_user_id).length, 0, "not forced onto the closed job");
    // the same replay again: the same entry
    assert.equal((await post(t, tech, `/visits/${v.id}/lines`, body)).body.data.pending_entry_id, e[0].id);
    assert.equal(pending(t).length, 1);
  } finally { t.done(); }
});

test("R4 a phone clock 3 h behind or 2 h ahead: corrected by the offset it shows when it sends, and the time waits for the office", async () => {
  const { t, owner, tech, tech2 } = await setup("2026-11-17T15:00:00Z"); // 09:00 Delano
  try {
    const v = await visit(owner, await job(owner, await customer(owner)), { date: "2026-11-17", start: "09:00", end: "11:00", assignee_ids: [tech.id] });
    // real 09:00: tech starts with no signal; the phone says 06:00 (3 h behind)
    const deviceAt = new Date(clock.nowMs() - hours(3)).toISOString();
    advance(hours(1));   // signal back at real 10:00, the phone says 07:00 as it sends
    const sentAt = new Date(clock.nowMs() - hours(3)).toISOString();
    const r = await t.api(`/visits/${v.id}/timer`, { method: "POST", as: tech, body: offline({ action: "start" }, deviceAt), headers: { "x-crm-sent-at": sentAt } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const tm = timers(t)[0];
    assert.equal(tm.start_at, "2026-11-17T15:00:00.000Z", "09:00, when the work began");
    assert.equal(tm.unverified, true);
    assert.equal(tm.skew_ms, hours(3));
    const sh = sheets(t)[0];
    assert.equal(sh.start_at, "2026-11-17T15:00:00.000Z");
    assert.equal(sh.pending.reason, "clock_skew", "the shift waits for the office");
    // a phone 2 h ahead: clock in at real 07:00 (phone 09:00), sent at real 12:00 (phone 14:00)
    pin("2026-11-17T13:00:00Z");
    const ahead = new Date(clock.nowMs() + hours(2)).toISOString();
    pin("2026-11-17T18:00:00Z");
    const r2 = await t.api("/clock", { method: "POST", as: tech2, body: offline({ action: "in" }, ahead), headers: { "x-crm-sent-at": new Date(clock.nowMs() + hours(2)).toISOString() } });
    assert.equal(r2.status, 201, JSON.stringify(r2.body));
    assert.equal(r2.body.data.open.start_at, "2026-11-17T13:00:00.000Z", "07:00, not 09:00");
    assert.equal(r2.body.data.open.pending.reason, "clock_skew");
    // a phone within 2 minutes is simply right
    assert.deepEqual(TS.judgeTime({ queued_offline: true, client_at: ago(minutes(10)), queued_at: ago(minutes(10)) }, clock.nowMs(), { sentAt: clock.nowMs() - 60000 }).trusted, true);
  } finally { t.done(); }
});

test("R5 two phones of one tech: an offline clock-in over the open shift, or a whole offline shift over a closed one, waits for the office; nothing counts twice", async () => {
  const { t, tech, tech2 } = await setup("2026-11-17T13:00:00Z"); // 07:00 Delano
  try {
    // phone A (no signal) clocks in at 07:00; phone B (signal) at 07:30
    const aIn = offline({ action: "in" }, clock.nowIso());
    advance(minutes(30));
    const b = await post(t, tech, "/clock", live({ action: "in" }));
    assert.equal(b.status, 201);
    advance(hours(4));
    const a = await post(t, tech, "/clock", aIn);
    assert.equal(a.status, 202, JSON.stringify(a.body));
    assert.equal(a.body.data.reason, "overlap");
    const mine = sheets(t).filter((s) => s.user_id === tech.id);
    assert.equal(mine.length, 2, "phone A's 07:00 is kept");
    const entry = mine.find((s) => s.status === "pending_approval");
    assert.equal(entry.start_at, "2026-11-17T13:00:00.000Z");
    assert.deepEqual(entry.pending.with, [b.body.data.open.id]);
    assert.equal(mine.find((s) => s.status === "open").id, b.body.data.open.id, "B's shift is still the open one");
    // phone A's clock-out names A's shift: it ends A's entry, never B's shift
    const aOut = await post(t, tech, "/clock", offline({ action: "out", shift_client_id: aIn.client_id }, ago(minutes(5))));
    assert.equal(aOut.status, 202, JSON.stringify(aOut.body));
    assert.ok((await rec("timesheet", entry.id)).end_at);
    assert.equal((await rec("timesheet", b.body.data.open.id)).status, "open", "B's shift untouched");

    // tech2: phone A offline the whole day (07:00 to 15:00), phone B online (07:30 to 15:30)
    pin("2026-11-17T13:00:00Z");
    const aIn2 = offline({ action: "in" }, clock.nowIso());
    advance(minutes(30));
    assert.equal((await post(t, tech2, "/clock", live({ action: "in" }))).status, 201);
    advance(hours(7) + minutes(30));
    const aOut2 = offline({ action: "out", shift_client_id: aIn2.client_id }, clock.nowIso());
    advance(minutes(30));
    assert.equal((await post(t, tech2, "/clock", live({ action: "out" }))).status, 200);
    advance(minutes(30));
    assert.equal((await post(t, tech2, "/clock", aIn2)).status, 202);
    assert.equal((await post(t, tech2, "/clock", aOut2)).status, 202);
    const two = sheets(t).filter((s) => s.user_id === tech2.id);
    const counted = two.filter((s) => ["closed", "approved", "locked"].includes(s.status)).reduce((n, s) => n + s.minutes, 0);
    assert.equal(counted, 480, "one 8 h day, not 16");
    const est = TS.payEstimate(two, null, {});
    assert.equal(est.minutes, 480);
    assert.equal(est.pending_min, 480, "phone A's shift waits for the office");
    // a clock-out with no shift named, before the open one began: not that shift's end
    pin("2026-11-18T14:00:00Z");
    const c = await post(t, tech2, "/clock", live({ action: "in" }));
    assert.equal(c.status, 201);
    const early = await post(t, tech2, "/clock", offline({ action: "out" }, "2026-11-18T13:30:00.000Z"));
    assert.equal(early.status, 202);
    assert.equal((await rec("timesheet", c.body.data.open.id)).status, "open");
  } finally { t.done(); }
});

test("R5 an earlier offline shift replayed after another phone's shift began: once its end is known and nothing overlaps, it is an ordinary shift (and never stops the work going on)", async () => {
  const { t, owner, tech } = await setup("2026-11-17T12:00:00Z"); // 06:00 Delano
  try {
    const v = await visit(owner, await job(owner, await customer(owner)), { date: "2026-11-17", start: "09:00", end: "11:00", assignee_ids: [tech.id] });
    // phone A, no signal: an early hour of office work, 06:00 to 07:00
    const aIn = offline({ action: "in", category: "office" }, clock.nowIso());
    advance(hours(1));
    const aOut = offline({ action: "out", shift_client_id: aIn.client_id }, clock.nowIso());
    advance(hours(2));
    // phone B, 09:00: starts the visit (which clocks in)
    assert.equal((await post(t, tech, `/visits/${v.id}/timer`, live({ action: "start" }))).status, 200);
    advance(minutes(30));
    // phone A gets signal: its clock-in looks like an overlap until its end comes
    const r1 = await post(t, tech, "/clock", aIn);
    assert.equal(r1.status, 202, JSON.stringify(r1.body));
    const r2 = await post(t, tech, "/clock", aOut);
    assert.equal(r2.status, 200, JSON.stringify(r2.body));
    assert.equal(r2.body.data.closed.status, "closed");
    assert.equal(r2.body.data.closed.minutes, 60);
    assert.equal(r2.body.data.paused, 0);
    assert.equal(pending(t).length, 0, "nothing for the office: it never overlapped");
    assert.equal(timers(t)[0].end_at, undefined, "the timer on phone B still runs");
    assert.equal(sheets(t).filter((s) => s.status === "open").length, 1, "and its shift is still open");
    assert.equal(TS.payEstimate(sheets(t).filter((s) => s.status === "closed"), null, {}).minutes, 60);
  } finally { t.done(); }
});

test("R5 timers: a replayed start over a timer of the same person on the visit is an entry; its pause ends that entry, never the running timer", async () => {
  const { t, owner, tech } = await setup("2026-11-17T15:00:00Z");
  try {
    const v = await visit(owner, await job(owner, await customer(owner)), { date: "2026-11-17", start: "09:00", end: "11:00", assignee_ids: [tech.id] });
    const aStart = offline({ action: "start" }, clock.nowIso());                // phone A, no signal, 09:00
    advance(minutes(10));
    const b = await post(t, tech, `/visits/${v.id}/timer`, live({ action: "start" })); // phone B, 09:10
    assert.equal(b.status, 200);
    advance(minutes(50));
    const aPause = offline({ action: "pause", timer_client_id: aStart.client_id }, clock.nowIso());
    advance(minutes(20));
    const r1 = await post(t, tech, `/visits/${v.id}/timer`, aStart);
    assert.equal(r1.status, 202, JSON.stringify(r1.body));
    assert.equal(r1.body.data.reason, "overlap");
    const r2 = await post(t, tech, `/visits/${v.id}/timer`, aPause);
    assert.equal(r2.status, 202, JSON.stringify(r2.body));
    const e = pending(t).find((x) => x.pending.action === "timer_start");
    assert.ok(e.pending.timer.start && e.pending.timer.end, "phone A's segment, start and stop, kept for the office");
    assert.equal(timers(t).length, 1);
    assert.equal(timers(t)[0].end_at, undefined, "phone B's timer still runs");
    assert.equal(e.minutes, 0, "an entry about a timer never counts as time");
  } finally { t.done(); }
});

test("R7 ticks, notes and photos replayed onto a visit the office cancelled: they go in, and an entry tells the office", async () => {
  const { t, owner, tech } = await setup();
  try {
    const v = await visit(owner, await job(owner, await customer(owner)), { date: "2026-11-17", start: "09:00", end: "11:00", assignee_ids: [tech.id] });
    const c = await t.api(`/visits/${v.id}/cancel`, { method: "POST", as: owner, body: { reason: "Synthetic: customer called" }, idem: cid() });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    const r = await patch(t, tech, `/visits/${v.id}/checklist`, offline({ key: "gate_closed", done: true }, ago(minutes(5))));
    const n = await post(t, tech, `/visits/${v.id}/notes`, offline({ text: "Synthetic: did the front." }, ago(minutes(4))));
    const p = await post(t, tech, `/visits/${v.id}/photos`, offline({ data: jpeg(), tag: "after" }, ago(minutes(3))));
    for (const x of [r, n, p]) {
      assert.ok([200, 201].includes(x.status), JSON.stringify(x.body));
      assert.equal(x.body.data.noted, "cancelled");
    }
    const after = await rec("visit", v.id);
    assert.equal(after.status, "cancelled");
    assert.ok(after.checklist.items.find((i) => i.key === "gate_closed").done_at);
    assert.match(after.tech_notes, /did the front/);
    assert.equal(after.photos.length, 1);
    const e = pending(t);
    assert.equal(e.length, 3);
    assert.ok(e.every((x) => x.pending.reason === "cancelled" && x.pending.applied === true));
  } finally { t.done(); }
});

test("R8 a shift begun after 21:00 runs to a sensible bound (6 h), and isn't asked about a minute in", async () => {
  const { t, tech } = await setup("2026-11-18T03:30:00Z"); // 21:30 Delano, Tue 2026-11-17
  try {
    assert.equal((await post(t, tech, "/clock", live({ action: "in" }))).status, 201);
    advance(minutes(2));
    await TS.clockSweep({});
    let s = sheets(t)[0];
    assert.equal(s.status, "open");
    assert.equal(s.reminded_at, undefined, "no 'still clocked in?' a minute in");
    pin("2026-11-18T08:30:00Z");                     // 02:30: an hour before the bound
    await TS.clockSweep({});
    s = sheets(t)[0];
    assert.equal(s.status, "open");
    assert.ok(s.reminded_at, "asked an hour before");
    pin("2026-11-18T09:31:00Z");                     // 03:31: past it
    await TS.clockSweep({});
    s = sheets(t)[0];
    assert.equal(s.status, "closed");
    assert.equal(s.end_at, "2026-11-18T09:30:00.000Z");
    assert.equal(s.minutes, 360);
    assert.equal(TS.LATE_SHIFT_MS, 6 * 3600000);
  } finally { t.done(); }
});

test("R12 a PDF is never a visit photo; one the office attaches is an attachment, not shown to the customer", async () => {
  const { t, owner, tech } = await setup();
  try {
    const v = await visit(owner, await job(owner, await customer(owner)), { date: "2026-11-17", start: "09:00", end: "11:00", assignee_ids: [tech.id] });
    const pdf = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");
    const r = await post(t, tech, `/visits/${v.id}/photos`, live({ data: pdf.toString("base64"), tag: "before" }));
    assert.equal(r.status, 400);
    assert.equal(r.body.error.field, "data");
    assert.equal(t.stores.data.keys("rec/file/").length, 0);
    // the office's PDF on the visit (POST /files): an attachment
    const up = await t.api(`/files?owner_type=visit&owner_id=${v.id}&kind=attachment`, { method: "POST", as: owner, raw: pdf, headers: { "content-type": "application/pdf" } });
    assert.equal(up.status, 201, JSON.stringify(up.body));
    const after = await rec("visit", v.id);
    assert.equal(after.photos.length, 0, "not a photo");
    assert.equal(after.attachments.length, 1);
    assert.equal(after.attachments[0].content_type, "application/pdf");
    assert.equal(after.attachments[0].customer_visible, undefined, "never shown to the customer");
  } finally { t.done(); }
});

test("R13 the timers sweep closes a forgotten timer but never writes to a visit Rotor still owns: would- rows instead", async () => {
  const { t, tech } = await setup("2026-11-17T15:00:00Z");
  try {
    const ic = await WO.importedCustomer();
    const [ij] = await WO.OFF.createJobs([{ contact_id: ic.id, kind: "touch_up", lines: [{ title: "Touch-up", unit_cents: 0 }] }], "import-job-r13", "import", WO.IMPORT);
    const iv = (await WO.OFF.createVisit({ job_id: ij, date: "2026-11-17", start: "09:00", end: "10:00", window: { type: "exact", minutes: 0 }, assignee_ids: [tech.id] }, WO.IMPORT)).visit;
    await store.updateRecord("visit", iv.id, (v) => ({ ...v, import: { run_id: "ir_00000000000000000001", at: "2026-11-08T00:00:00.000Z", hash: "0".repeat(64) }, rotor: { visit_id: 9001, status_raw: "not_started" } }), WO.IMPORT);
    assert.equal((await post(t, tech, `/visits/${iv.id}/timer`, live({ action: "start" }))).status, 200);
    const before = await rec("visit", iv.id);
    pin("2026-11-18T04:00:00Z");
    await t.runWorker({ lane: "fast" });
    await t.runWorker({ lane: "fast" });
    const after = await rec("visit", iv.id);
    assert.equal(after.wv, before.wv, "the imported visit is untouched");
    assert.equal(after.minutes_worked, before.minutes_worked);
    assert.ok(timers(t)[0].end_at, "the CRM's own segment is closed");
    const would = t.stores.data.keys("alog/").filter((k) => /would-/.test(k));
    assert.ok(would.length >= 1, "would- rows say what it would have done");
    void TM;
  } finally { t.done(); }
});

test("R14 work done on the day before the office moved the visit: time and completion wait for the office; a note goes in and the office hears", async () => {
  const { t, owner, tech } = await setup("2026-11-17T15:00:00Z");
  try {
    const j = await job(owner, await customer(owner), { kind: "touch_up", lines: [{ title: "Touch-up", unit_cents: 0 }] });
    const v = await visit(owner, j, { date: "2026-11-17", start: "09:00", end: "10:00", assignee_ids: [tech.id] });
    const startAt = clock.nowIso();
    advance(minutes(20));
    await reassign(t, owner, v.id, { date: "2026-11-20" });
    advance(minutes(40));
    const doneAt = clock.nowIso();
    advance(minutes(30));
    const a = await post(t, tech, `/visits/${v.id}/timer`, offline({ action: "start" }, startAt));
    const n = await post(t, tech, `/visits/${v.id}/notes`, offline({ text: "Synthetic: did it on the 17th." }, doneAt));
    const b = await post(t, tech, `/visits/${v.id}/complete`, offline({}, doneAt));
    assert.equal(a.status, 202, JSON.stringify(a.body));
    assert.equal(a.body.data.reason, "moved");
    assert.equal(b.status, 202);
    assert.equal(n.status, 200);
    assert.equal(n.body.data.noted, "moved");
    const after = await rec("visit", v.id);
    assert.equal(after.status, "scheduled", "not completed on the 20th by work from the 17th");
    assert.equal(after.date, "2026-11-20");
    assert.match(after.tech_notes, /17th/);
    const e = pending(t);
    assert.deepEqual(e.map((x) => x.pending.reason).sort(), ["moved", "moved", "moved"]);
    assert.ok(e.some((x) => /now on 2026-11-20/.test(x.pending.detail)));
  } finally { t.done(); }
});

test("M2 a week-old photo is held on an entry for the office (hold: true); nothing goes on the visit; a live request can't hold", async () => {
  const { t, owner, tech } = await setup();
  try {
    const v = await visit(owner, await job(owner, await customer(owner)), { date: "2026-11-17", start: "09:00", end: "11:00", assignee_ids: [tech.id] });
    const old = ago(days(8));
    const body = { ...offline({ data: jpeg(), tag: "before", item: "walkaround_photo" }, old), hold: true };
    const r = await post(t, tech, `/visits/${v.id}/photos`, body);
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.equal(r.body.data.reason, "stale");
    assert.ok(r.body.data.file_id);
    const e = pending(t);
    assert.equal(e.length, 1);
    assert.deepEqual(e[0].pending.file_ids, [r.body.data.file_id]);
    assert.equal((await rec("visit", v.id)).photos.length, 0);
    // the same again: the same entry, the same file
    const again = await post(t, tech, `/visits/${v.id}/photos`, body);
    assert.equal(again.body.data.file_id, r.body.data.file_id);
    assert.equal(t.stores.data.keys("rec/file/").length, 1);
    // hold only means something for a replay
    const live1 = await post(t, tech, `/visits/${v.id}/photos`, { ...live({ data: jpeg(), tag: "before" }), hold: true });
    assert.equal(live1.status, 201);
  } finally { t.done(); }
});
