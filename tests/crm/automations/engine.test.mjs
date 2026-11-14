// The automation builder's engine (docs/CRM-AUTOMATIONS.md), end to end on
// the memory stores with a pinned clock: an event starts a run once, the
// wait lands where it should, the text goes through the sender to the
// Outbox (dry run) and the task is made once even when a step runs again
// after a crash; a reply stops it (when the step is due and again when the
// text is due); imported records get would- rows and nothing changes; the
// loop guard; the per-contact limit; the daily text cap across every
// automation; pause holds a run and delete stops it; the daily trigger and
// its bulk run (test send and confirm); the switch-over stops older runs.
// Synthetic data only.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { crmTest } from "../../helpers/crm-http.mjs";
import { seedContact, seedImportedContact } from "../../helpers/crm-fixtures.mjs";
import { pin, advance, days, hours, minutes } from "../../helpers/crm-clock.mjs";

const store = await import("../../../netlify/lib/crm-store.mjs");
const E = await import("../../../netlify/lib/crm/core/events.mjs");
const EN = await import("../../../netlify/lib/crm/modules/automations/engine.mjs");
const { listAutomationLog, automationCtx } = await import("../../../netlify/lib/crm/core/activity.mjs");
const { localDate, localTime, now } = await import("../../../netlify/lib/crm/core/clock.mjs");
const quotes = await import("../../../netlify/lib/crm/modules/quotes/types.mjs");

const W8 = (by = "system") => ({ by, origin: "api", actor_kind: "user", requestId: "test" });
const scope = (fn) => store.withStoreScope({ requestId: "test" }, fn);
let t;
afterEach(() => { if (t) t.done(); t = null; EN.clearDayCache(); });

const recs = (type) => t.stores.data.keys(`rec/${type}/`).map((k) => t.stores.data.json(k)).filter(Boolean);
const outbox = () => recs("outbox").filter((o) => o.kind === "sms");
const drain = async (n = 4) => { for (let i = 0; i < n; i++) await t.runWorker({ lane: "fast" }); };
const log = async (key) => scope(() => listAutomationLog(localDate(now()), { key }));
const runsOf = (flowId) => recs("flow_run").filter((r) => r.flow_id === flowId);
const local = (iso) => `${localDate(new Date(iso))} ${localTime(new Date(iso))}`;

async function setup() {
  t = await crmTest({ now: "2026-11-17T15:00:00Z" });          // Tuesday 09:00
  const owner = await t.user("owner");
  return owner;
}
async function makeFlow(owner, body, { on = true } = {}) {
  const r = await t.api("/automations/flows", { method: "POST", as: owner, body });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  let flow = r.body.data.flow;
  if (on) {
    const x = await t.api(`/automations/flows/${flow.id}/resume`, { method: "POST", as: owner, body: {} });
    assert.equal(x.status, 200, JSON.stringify(x.body));
    flow = x.body.data.flow;
  }
  return flow;
}
const quoteFor = (c) => scope(async () => (await store.createRecord("quote", { ...quotes.quoteType.example(), contact_id: c.id, status: "sent" }, W8())).data);
const emitQuoteSent = (q, wv = 1) => scope(() => E.emit("quote.sent", { id: q.id, wv, quote_id: q.id, version_id: null, contact_id: q.contact_id }, W8()));
const emitTagged = (c, tags, wv = 2, by = "system") => scope(() => E.emit("contact.tagged", { id: `tags:${c.id}`, wv, contact_id: c.id, tags }, W8(by)));

test("quote follow-up: one run per event, the wait to Friday 10:00, the text to the Outbox, then one task, even when a step runs again", async () => {
  const owner = await setup();
  const c = await scope(() => seedContact(1));
  const q = await quoteFor(c);
  const flow = await makeFlow(owner, { recipe: "quote_followup" });
  assert.match(flow.summary, /^When a quote is sent, if no reply in 3 days, text the Day 3 follow-up at 10 AM/);
  await emitQuoteSent(q);
  await emitQuoteSent(q);                       // a retried request: the same event
  await drain(2);
  const runs = runsOf(flow.id);
  assert.equal(runs.length, 1, "one run for one event");
  assert.equal(runs[0].status, "running");
  assert.equal(local(runs[0].next_at), "2026-11-20 10:00", "3 days, then 10:00 (in business hours)");
  // the listener again (a crash after the run was made): still one run
  await scope(() => EN.considerEvent({ ...recs("flow").find((f) => f.id === flow.id) }, { name: "quote.sent", event_id: E.eventId(q.id, 1), payload: { id: q.id, wv: 1, quote_id: q.id, contact_id: c.id } }, { ctx: automationCtx({ key: "test" }), mode: { system_of_record: "rotor" } }, {}));
  assert.equal(runsOf(flow.id).length, 1);
  // not before Friday
  advance(days(2));
  await drain(2);
  assert.equal(outbox().length, 0);
  pin("2026-11-20T16:00:00Z");                  // Friday 10:00
  await drain(4);
  const sent = outbox();
  assert.equal(sent.length, 1, "the text went to the Outbox");
  assert.equal(sent[0].mode, "dry_run");
  assert.equal(sent[0].template_key, "flow_quote_day3");
  assert.match(sent[0].body, /checking in on the quote/);
  assert.match(sent[0].body, /Reply STOP to opt out\.$/, "the sender adds the footer on a first text");
  const tasks = recs("task");
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].title, "Call about their quote");
  assert.deepEqual(tasks[0].assignee_ids, [owner.id], "nobody owns the contact: the first owner");
  const run = runsOf(flow.id)[0];
  assert.equal(run.status, "done");
  assert.deepEqual(run.steps.map((s) => s.status), ["queued", "done"]);
  // a crash after the task but before the run moved on: the step runs again and makes nothing twice
  await scope(() => store.updateRecord("flow_run", run.id, (r) => ({ ...r, status: "waiting", step: 1 }), W8()));
  const h = { item: { data: { run_id: run.id, i: 1 } }, mode: { system_of_record: "rotor", paused: false }, ctx: automationCtx({ key: "flow.step" }) };
  await scope(() => EN.runStep(h));
  await scope(() => EN.runStep(h));
  assert.equal(recs("task").length, 1, "the task id comes from the run and step");
  await drain(2);
  assert.equal(outbox().length, 1, "and the text's marker keeps it to one");
  // the run history over the API, with the text's outcome
  const hist = await t.api(`/automations/flows/${flow.id}/runs`, { as: owner });
  assert.equal(hist.status, 200);
  assert.equal(hist.body.data.runs.length, 1);
  const one = await t.api(`/automations/flows/${flow.id}/runs/${run.id}`, { as: owner });
  assert.equal(one.status, 200);
  assert.deepEqual(one.body.data.run.sends.map((s) => [s.step, s.state, s.dry]), [[0, "done", true]]);
  const list = await t.api("/automations/flows", { as: owner });
  const row = list.body.data.flows.find((f) => f.id === flow.id);
  assert.equal(row.runs, 1);
  assert.ok(row.last_run_at);
});

test("a reply stops it: when the step is due, and again when its text is due", async () => {
  const owner = await setup();
  const flow = await makeFlow(owner, { recipe: "quote_followup" });
  // A replies during the wait: the step stops the run
  const a = await scope(() => seedContact(1));
  const qa = await quoteFor(a);
  await emitQuoteSent(qa);
  await drain(2);
  advance(hours(2));
  await scope(() => store.updateStats(a.id, "comms", (p) => ({ ...p, last_inbound_at: now().toISOString() }), W8()));
  pin("2026-11-20T16:00:00Z");
  await drain(3);
  let run = runsOf(flow.id).find((r) => r.contact_id === a.id);
  assert.equal(run.status, "stopped");
  assert.equal(run.stop_reason, "stop_replied");
  assert.equal(outbox().length, 0);
  assert.equal(recs("task").length, 0);
  // B: the step queued the text, then B replied before it went: the text is skipped (recheck)
  pin("2026-11-18T15:00:00Z");
  const b = await scope(() => seedContact(2));
  const qb = await quoteFor(b);
  await emitQuoteSent(qb);
  await drain(2);
  pin("2026-11-21T16:00:00Z");                  // Saturday 10:00
  await t.runWorker({ lane: "fast" });          // the step runs and queues the text
  run = runsOf(flow.id).find((r) => r.contact_id === b.id);
  assert.equal(run.steps[0].status, "queued");
  await scope(() => store.updateStats(b.id, "comms", (p) => ({ ...p, last_inbound_at: now().toISOString() }), W8()));
  await drain(3);
  assert.equal(outbox().length, 0, "nothing went out");
  // the text's recheck sees the reply (or the run the task step already stopped: the two are due the same minute)
  assert.ok((await log("flow.service")).some((r) => ["skipped:stop_replied", "skipped:run_ended"].includes(r.result)));
  run = runsOf(flow.id).find((r) => r.contact_id === b.id);
  assert.equal(run.status, "stopped", "the task step sees the reply too");
});

test("Rotor's customers: would- rows, nothing changed, texts only in the Outbox", async () => {
  const owner = await setup();
  const imp = await scope(() => seedImportedContact(1));
  const mine = await scope(() => seedContact(2));
  const flow = await makeFlow(owner, { name: "VIP care", trigger: { type: "contact.tagged", tag: "VIP" }, steps: [
    { type: "tag_add", tag: "Hot" }, { type: "assign_owner", user_id: owner.id }, { type: "task", title: "Call the VIP", assign: "owners" }, { type: "text", template_key: "flow_quote_day3" },
  ] });
  await emitTagged(imp, ["VIP"]);
  await emitTagged(mine, ["VIP"]);
  await drain(8);
  const after = t.stores.data.json(`rec/contact/${imp.id}`);
  assert.deepEqual(after.tags, [], "Rotor's contact is untouched");
  assert.equal(after.owner_id, undefined);
  const rows = await log(EN.flowKey(flow.id));
  for (const a of ["would-add_tag", "would-assign_owner", "would-create_task"]) assert.ok(rows.some((r) => r.result === a && r.subject === imp.id), `${a} for the imported contact`);
  const run = runsOf(flow.id).find((r) => r.contact_id === imp.id);
  assert.deepEqual(run.steps.map((s) => s.status), ["would", "would", "would", "queued"]);
  assert.equal(recs("task").filter((x) => x.contact_id === imp.id).length, 0);
  // the CRM's own contact gets the real changes
  const m = t.stores.data.json(`rec/contact/${mine.id}`);
  assert.deepEqual(m.tags, ["Hot"]);
  assert.equal(m.owner_id, owner.id);
  assert.equal(recs("task").filter((x) => x.contact_id === mine.id).length, 1);
  // both texts are dry run in the Outbox
  assert.deepEqual(outbox().map((o) => o.mode), ["dry_run", "dry_run"]);
});

test("the daily cap counts the built-in automations' real texts once texting is live (the Messages the sender records), not a person's, a failed one or a flow's twice", async () => {
  const owner = await setup();
  const c = await scope(() => seedContact(1));
  const { recordMessage } = await import("../../../netlify/lib/crm/modules/comms/conversations.mjs");
  const contact = (await scope(() => store.getRecord("contact", c.id))).data;
  const sent = (origin, status = "sent", at) => scope(() => recordMessage({ contact, channel: "sms", direction: "out", from: "+17633143400", to: contact.phones[0].e164, body_text: "Hi from Barta", status, provider: "twilio", provider_id: `SM${Math.random().toString(16).slice(2, 12)}`, origin, ...(at ? { sent_at: at } : {}) }, { by: "system", origin: "worker", actor_kind: "automation", requestId: "t" }));
  await sent({ kind: "automation", id: "visit.reminder_2d" });                   // a real reminder this morning: counts
  await sent({ kind: "user", user_id: owner.id });                               // a person's text: not automated
  await sent({ kind: "automation", id: "lead.ack" }, "failed");                  // never reached them
  await sent({ kind: "automation", id: "flow.service" });                        // a flow's: counted through its claim, not twice
  await sent({ kind: "automation", id: "lead.ack" }, "sent", "2026-11-16T20:00:00.000Z"); // yesterday
  assert.equal(await scope(() => EN.textsToday(c.id)), 1, "only today's real built-in text");
  // two flows want to text them today: the cap (2) leaves room for one
  await makeFlow(owner, { name: "First", trigger: { type: "contact.tagged", tag: "A" }, steps: [{ type: "text", template_key: "flow_quote_day3" }], limits: { per_contact_days: 0 } });
  await makeFlow(owner, { name: "Second", trigger: { type: "contact.tagged", tag: "A" }, steps: [{ type: "text", template_key: "flow_review_ask" }], limits: { per_contact_days: 0 } });
  await emitTagged(c, ["A"], 2);
  await drain(6);
  assert.equal(outbox().filter((o) => o.origin && String(o.origin.id).startsWith("flow.")).length, 1, "the live reminder and one of these");
  assert.ok((await log("flow.service")).some((r) => r.result === "skipped:daily_cap"));
  // dry run and live together: a built-in dry-run text in the Outbox counts as well
  await scope(() => store.createRecord("outbox", { kind: "sms", mode: "dry_run", to_masked: "x", contact_id: c.id, body: "Thanks!", related: {}, origin: { kind: "automation", id: "lead.ack" }, simulated: { status: "sent" }, day: "2026-11-17" }, { by: "system", origin: "worker", actor_kind: "automation", requestId: "t" }));
  assert.equal(await scope(() => EN.textsToday(c.id)), 3, "1 live, 1 dry run, 1 flow claim");
  // the next day starts at zero
  pin("2026-11-18T16:00:00Z");
  assert.equal(await scope(() => EN.textsToday(c.id)), 0);
});

test("loop guard: a flow's own change never starts it again; two flows feeding each other stop after 3 a day", async () => {
  const owner = await setup();
  const c = await scope(() => store.createRecord("contact", { first_name: "Loop", last_name: "Example", phones: [{ e164: "+17635550170", sms: true, primary: true }], lifecycle: "lead", tags: [] }, W8(owner.id)));
  const self = await makeFlow(owner, { name: "Self", trigger: { type: "contact.tagged", tag: "Self" }, steps: [{ type: "tag_remove", tag: "Self" }, { type: "tag_add", tag: "Self" }], limits: { per_contact_days: 0 } });
  const ping = await makeFlow(owner, { name: "Ping", trigger: { type: "contact.tagged", tag: "Ping" }, steps: [{ type: "tag_remove", tag: "Ping" }, { type: "tag_add", tag: "Pong" }], limits: { per_contact_days: 0 } });
  const pong = await makeFlow(owner, { name: "Pong", trigger: { type: "contact.tagged", tag: "Pong" }, steps: [{ type: "tag_remove", tag: "Pong" }, { type: "tag_add", tag: "Ping" }], limits: { per_contact_days: 0 } });
  // a person tags the contact (PATCH: the contacts module emits contact.tagged)
  const g = await t.api(`/contacts/${c.data.id}`, { as: owner });
  const p = await t.api(`/contacts/${c.data.id}`, { method: "PATCH", as: owner, ifMatch: g.headers.get("etag"), body: { tags: ["Self", "Ping"] } });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  await drain(40);
  assert.equal(runsOf(self.id).length, 1, "its own tag_add doesn't start it again");
  assert.ok((await log(EN.flowKey(self.id))).some((r) => r.result === "skipped:loop"));
  assert.equal(runsOf(ping.id).length, EN.LOOP_MAX_PER_DAY);
  assert.equal(runsOf(pong.id).length, EN.LOOP_MAX_PER_DAY);
  const rows = [...(await log(EN.flowKey(ping.id))), ...(await log(EN.flowKey(pong.id)))];
  assert.ok(rows.some((r) => r.result === "skipped:loop_guard"));
  assert.equal(t.stores.data.keys("q/").length, 0, "nothing left spinning in the queue");
});

test("per-contact limit, and the daily cap on automated texts across every automation", async () => {
  const owner = await setup();
  const c = await scope(() => seedContact(1));
  const once = await makeFlow(owner, { name: "Once a month", trigger: { type: "contact.tagged", tag: "A" }, steps: [{ type: "text", template_key: "flow_quote_day3" }], limits: { per_contact_days: 30 } });
  const two = await makeFlow(owner, { name: "Second", trigger: { type: "contact.tagged", tag: "A" }, steps: [{ type: "text", template_key: "flow_review_ask" }] });
  // a built-in automation already texted them today (dry run)
  await scope(() => store.createRecord("outbox", { kind: "sms", mode: "dry_run", to_masked: "x", contact_id: c.id, body: "Thanks for reaching out!", related: {}, origin: { kind: "automation", id: "lead.ack" }, simulated: { status: "sent" }, day: "2026-11-17" }, { by: "system", origin: "worker", actor_kind: "automation", requestId: "t" }));
  await emitTagged(c, ["A"], 2);
  await drain(6);
  const flowTexts = outbox().filter((o) => o.origin && String(o.origin.id).startsWith("flow."));
  assert.equal(flowTexts.length, 1, "2 a day: the built-in one and one of these");
  assert.ok((await log("flow.service")).some((r) => r.result === "skipped:daily_cap"));
  // the next day, the per-contact limit keeps "Once a month" from starting again
  pin("2026-11-18T16:00:00Z");
  await emitTagged(c, ["A"], 3);
  await drain(6);
  assert.equal(runsOf(once.id).length, 1);
  assert.ok((await log(EN.flowKey(once.id))).some((r) => r.result === "skipped:recently"));
  assert.equal(runsOf(two.id).length, 2, "the other has a 1-day limit");
});

test("pause holds a waiting run until resume; delete stops it; the switch-over stops older runs", async () => {
  const owner = await setup();
  const flow = await makeFlow(owner, { name: "Later", trigger: { type: "contact.tagged", tag: "L" }, steps: [{ type: "tag_add", tag: "Done", wait: { n: 1, unit: "hours" } }, { type: "tag_add", tag: "Two", wait: { n: 1, unit: "hours" } }], limits: { per_contact_days: 0 } });
  const a = await scope(() => seedContact(1));
  await emitTagged(a, ["L"]);
  await drain(2);
  assert.equal((await t.api(`/automations/flows/${flow.id}/pause`, { method: "POST", as: owner, body: {} })).status, 200);
  advance(hours(1) + minutes(1));
  await drain(2);
  let run = runsOf(flow.id)[0];
  assert.equal(run.steps[0].status, "held");
  assert.deepEqual(t.stores.data.json(`rec/contact/${a.id}`).tags, [], "nothing while paused");
  assert.equal((await t.api(`/automations/flows/${flow.id}/resume`, { method: "POST", as: owner, body: {} })).status, 200);
  advance(hours(1));
  await drain(2);
  run = runsOf(flow.id)[0];
  assert.equal(run.steps[0].status, "done");
  assert.deepEqual(t.stores.data.json(`rec/contact/${a.id}`).tags, ["Done"]);
  // deleted while the second step waits: it stops
  const del = await t.api(`/automations/flows/${flow.id}`, { method: "DELETE", as: owner });
  assert.equal(del.status, 200);
  advance(hours(2));
  await drain(2);
  run = runsOf(flow.id)[0];
  assert.equal(run.status, "stopped");
  assert.equal(run.stop_reason, "deleted");
  // a run started while Rotor was in charge stops at its next step after the switch-over
  const f2 = await makeFlow(owner, { name: "Across", trigger: { type: "contact.tagged", tag: "X" }, steps: [{ type: "tag_add", tag: "Y", wait: { n: 1, unit: "days" } }] });
  const b = await scope(() => seedContact(2));
  await emitTagged(b, ["X"]);
  await drain(2);
  await scope(() => store.putRaw("sys/mode", { system_of_record: "crm", paused: false, cutover_n: 1 }));
  advance(days(1) + minutes(1));
  await drain(2);
  const r2 = runsOf(f2.id)[0];
  assert.equal(r2.status, "stopped");
  assert.equal(r2.stop_reason, "switch_over");
});

test("daily trigger: once a day at its time; more than 5 people becomes a bulk run that waits for a test send and a confirm", async () => {
  const owner = await setup();
  const people = [];
  for (let i = 0; i < 7; i++) {
    people.push((await scope(() => store.createRecord("contact", { first_name: `Lights${i}`, last_name: "Example", phones: [{ e164: `+176355502${10 + i}`, sms: true, primary: true }], lifecycle: "customer", tags: ["Lights 2025"], consent: { sms_service: { state: "granted" } } }, W8(owner.id)))).data);
  }
  await scope(() => store.createRecord("contact", { first_name: "Other", last_name: "Example", phones: [{ e164: "+17635550299", sms: true, primary: true }], lifecycle: "customer", tags: [] }, W8(owner.id)));
  const flow = await makeFlow(owner, { name: "Lights rebook", trigger: { type: "schedule", at: "10:00", dows: [1, 2, 3, 4, 5] }, conditions: [{ field: "tags", op: "has", value: "Lights 2025" }], steps: [{ type: "text", template_key: "flow_lights_rebook" }, { type: "tag_add", tag: "Asked 2026" }], limits: { per_contact_days: 300 } });
  await drain(2);
  assert.equal(runsOf(flow.id).length, 0, "not before 10:00");
  pin("2026-11-17T16:05:00Z");
  await drain(4);
  await drain(2);
  const runs = runsOf(flow.id);
  assert.equal(runs.length, 1, "one run for the day's list");
  assert.equal(runs[0].members.length, 7);
  const bulk = recs("bulk_run");
  assert.equal(bulk.length, 1, "more than 5 at once: a bulk run");
  assert.equal(bulk[0].recipients.length, 7);
  assert.ok(["draft", "ready"].includes(bulk[0].status), bulk[0].status);
  assert.equal(outbox().filter((o) => o.template_key === "flow_lights_rebook").length, 0, "nothing goes before the test send and the confirm");
  assert.equal(runs[0].steps[0].status, "bulk");
  // the CRM's own contacts get the tag
  assert.ok(people.every((p) => (t.stores.data.json(`rec/contact/${p.id}`).tags || []).includes("Asked 2026")));
  // the same day again: nothing new
  advance(hours(2));
  await drain(3);
  assert.equal(runsOf(flow.id).length, 1);
  // tomorrow: everyone ran it within 300 days
  pin("2026-11-18T16:05:00Z");
  await drain(3);
  assert.equal(runsOf(flow.id).length, 1);
  assert.ok((await log(EN.flowKey(flow.id))).some((r) => r.result === "skipped:nobody"));
});

test("a record that says no is skipped, not retried; old daily text counts are pruned", async () => {
  const owner = await setup();
  const gone = await scope(() => seedContact(1, { merged_into: "ct_00000000000000000009" }));
  const flow = await makeFlow(owner, { name: "Tag", trigger: { type: "contact.tagged", tag: "T" }, steps: [{ type: "tag_add", tag: "Seen" }] });
  await emitTagged(gone, ["T"]);
  await drain(4);
  const run = runsOf(flow.id)[0];
  assert.equal(run.status, "done");
  assert.equal(run.steps[0].result, "skipped:conflict");
  assert.equal(t.stores.data.keys("q/").length, 0, "no retries left in the queue");
  await scope(() => store.putRaw("flowt/2026-11-10/ct_00000000000000000001/x", { at: "2026-11-10T15:00:00.000Z" }, { onlyIfNew: true }));
  await scope(() => store.putRaw("flowt/2026-11-17/ct_00000000000000000001/y", { at: "2026-11-17T15:00:00.000Z" }, { onlyIfNew: true }));
  await scope(() => EN.pruneSweep());
  assert.deepEqual(t.stores.data.keys("flowt/"), ["flowt/2026-11-17/ct_00000000000000000001/y"]);
});
