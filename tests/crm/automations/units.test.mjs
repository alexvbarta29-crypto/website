// The automation builder's pure parts (docs/CRM-AUTOMATIONS.md): what a
// definition may say (cleanFlow), the plain-English sentence, when a step
// is due (waits in minutes, hours and days, "at" a time, business hours,
// across both DST changes of 2026 in America/Chicago) and whether a
// condition holds. No store, no network; the clock is pinned.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { pin, unpin } from "../../helpers/crm-clock.mjs";

const C = await import("../../../netlify/lib/crm/modules/automations/catalog.mjs");
const { stepDue, nextOpen } = await import("../../../netlify/lib/crm/modules/automations/when.mjs");
const F = await import("../../../netlify/lib/crm/modules/automations/facts.mjs");
const { localDate, localTime } = await import("../../../netlify/lib/crm/core/clock.mjs");

afterEach(() => unpin());
const local = (d) => `${localDate(d)} ${localTime(d)}`;
const bad = (fn, field) => assert.throws(fn, (e) => e.name === "InputError" && (!field || e.field === field), `expected an InputError on ${field}`);

test("cleanFlow keeps a good definition and gives steps stable ids", () => {
  const f = C.cleanFlow({ name: "  Quote   follow-up ", trigger: { type: "quote.sent" }, steps: [{ type: "text", template_key: "flow_quote_day3", wait: { n: 3, unit: "days" }, at: "10:00", business_hours: true }, { type: "task", title: "Call them" }], stop: [{ field: "replied", op: "yes" }] });
  assert.equal(f.name, "Quote follow-up");
  assert.equal(f.enabled, false, "new automations start off");
  assert.deepEqual(f.steps.map((s) => s.id), ["s1", "s2"]);
  assert.equal(f.steps[1].assign, "owner");
  assert.deepEqual(f.limits, { per_contact_days: 1 });
  // ids survive an edit that inserts a step in front
  const g = C.cleanFlow({ ...f, steps: [{ type: "tag_add", tag: "Hot" }, ...f.steps] });
  assert.deepEqual(g.steps.map((s) => s.id), ["s3", "s1", "s2"]);
  // a copied id is made unique
  assert.deepEqual(C.cleanFlow({ ...f, steps: [f.steps[0], f.steps[0]] }).steps.map((s) => s.id), ["s1", "s2"]);
});

test("cleanFlow refuses what can't run", () => {
  const base = { name: "X", trigger: { type: "quote.sent" }, steps: [{ type: "tag_add", tag: "A" }] };
  bad(() => C.cleanFlow({ ...base, name: " " }), "name");
  bad(() => C.cleanFlow({ ...base, trigger: { type: "rotor.webhook" } }), "trigger.type");
  bad(() => C.cleanFlow({ ...base, steps: [] }), "steps");
  bad(() => C.cleanFlow({ ...base, steps: [{ type: "text" }] }), "steps.0.template_key");
  bad(() => C.cleanFlow({ ...base, steps: [{ type: "tag_add", tag: "A", wait: { n: 400, unit: "days" } }] }), "steps.0.wait");
  bad(() => C.cleanFlow({ ...base, steps: [{ type: "tag_add", tag: "A", at: "25:00" }] }), "steps.0.at");
  bad(() => C.cleanFlow({ ...base, steps: [{ type: "stop_if", conditions: [{ field: "replied", op: "yes" }] }] }), "steps");
  bad(() => C.cleanFlow({ ...base, conditions: [{ field: "status", op: "is", value: "paid" }] }), "conditions.0.value");
  bad(() => C.cleanFlow({ ...base, conditions: [{ field: "amount", op: "gte", value: -5 }] }), "conditions.0.value");
  bad(() => C.cleanFlow({ ...base, steps: Array.from({ length: 13 }, () => ({ type: "tag_add", tag: "A" })) }), "steps");
  // "On a schedule" must say who: a time window alone would reach everyone
  bad(() => C.cleanFlow({ ...base, trigger: { type: "schedule" }, conditions: [{ field: "weekday", op: "weekday" }] }), "conditions");
  const s = C.cleanFlow({ ...base, trigger: { type: "schedule" }, conditions: [{ field: "tags", op: "has", value: "VIP" }] });
  assert.deepEqual(s.trigger, { type: "schedule", at: "10:00", dows: [1, 2, 3, 4, 5] });
  // hostile text is kept as text, trimmed and capped
  const h = C.cleanFlow({ ...base, name: "<img src=x onerror=alert(1)>".repeat(10), steps: [{ type: "notify", to: "owners", message: "<script>x</script>" }] });
  assert.equal(h.name.length, 80);
  assert.equal(h.steps[0].message, "<script>x</script>");
});

test("the plain-English summary reads like the owner would say it", () => {
  const f = C.cleanFlow({ name: "Q", trigger: { type: "quote.sent" }, steps: [{ type: "text", template_key: "flow_quote_day3", wait: { n: 3, unit: "days" } }, { type: "task", title: "Call", assign: "owner" }], stop: [{ field: "replied", op: "yes" }, { field: "status", op: "is", value: "approved" }] });
  const s = C.summarize(f, { templates: { flow_quote_day3: "Day 3 follow-up" } });
  assert.equal(s, "When a quote is sent, if no reply in 3 days, text the Day 3 follow-up, then make a task for the owner (\"Call\"). Stops when they reply or the quote is approved.");
  assert.doesNotMatch(s, /—/);
  for (const r of C.RECIPES) {
    const text = C.summarize(C.cleanFlow(r.flow), {});
    assert.ok(text.length > 30 && !/undefined|\[object/.test(text), `${r.key}: ${text}`);
  }
  const daily = C.summarize(C.cleanFlow(C.RECIPES.find((r) => r.key === "lights_rebook").flow), { templates: { flow_lights_rebook: "Lights season rebook" } });
  assert.match(daily, /^On weekdays at 10 AM, for everyone where the service includes christmas lights and it's between Sep 15 and Oct 15, text the Lights season rebook\./);
});

test("the starters' texts: Barta's voice, no opt-out line, no em dashes, only variables the sender knows", async () => {
  const T = await import("../../../netlify/lib/crm/core/templates.mjs");
  for (const t of C.TEMPLATES) {
    assert.ok(!T.hasStopText(t.body), `${t.key} never says Reply STOP`);
    assert.doesNotMatch(t.body, /—|licensed|refund/i, t.key);
    for (const v of T.parseTemplate(t.body).variables) assert.ok(T.isVariable(v), `${t.key}: {{${v}}}`);
  }
  for (const r of C.RECIPES) for (const s of r.flow.steps) if (s.template_key) assert.ok(C.TEMPLATES.some((t) => t.key === s.template_key), `${r.key} uses a starter text`);
});

test("waits: minutes and hours are elapsed time, days keep the wall clock across the fall-back night", () => {
  // Saturday Oct 31 2026 10:00 CDT; the clocks go back at 02:00 on Sunday Nov 1
  const sat = new Date("2026-10-31T15:00:00Z");
  assert.equal(local(stepDue(sat, { wait: { n: 1, unit: "days" } })), "2026-11-01 10:00");
  assert.equal(stepDue(sat, { wait: { n: 1, unit: "days" } }) - sat, 25 * 3600000, "a calendar day is 25 hours that night");
  assert.equal(stepDue(sat, { wait: { n: 24, unit: "hours" } }) - sat, 24 * 3600000);
  assert.equal(local(stepDue(sat, { wait: { n: 24, unit: "hours" } })), "2026-11-01 09:00");
  assert.equal(stepDue(sat, { wait: { n: 90, unit: "minutes" } }) - sat, 90 * 60000);
  // spring forward: Saturday Mar 7 2026 10:00 CST → Sunday 10:00 CDT is 23 hours
  const mar = new Date("2026-03-07T16:00:00Z");
  assert.equal(stepDue(mar, { wait: { n: 1, unit: "days" } }) - mar, 23 * 3600000);
  // 02:30 doesn't exist on Mar 8: "at 02:30" lands just after the gap, never before it
  assert.equal(local(stepDue(new Date("2026-03-08T06:00:00Z"), { at: "02:30" })), "2026-03-08 03:30");
  // the 01:30 that happens twice on Nov 1 is the first one
  assert.equal(stepDue(new Date("2026-11-01T05:00:00Z"), { at: "01:30" }).toISOString(), "2026-11-01T06:30:00.000Z");
});

test("'at' a time of day, and business hours", () => {
  const tue = new Date("2026-11-17T21:00:00Z");                // Tue 15:00
  assert.equal(local(stepDue(tue, { at: "10:00" })), "2026-11-18 10:00", "the next 10:00");
  assert.equal(local(stepDue(tue, { at: "16:00" })), "2026-11-17 16:00", "later today");
  assert.equal(local(stepDue(tue, { wait: { n: 3, unit: "days" }, at: "10:00" })), "2026-11-20 10:00", "3 days, then that morning");
  assert.equal(local(stepDue(tue, { wait: { n: 4, unit: "hours" }, business_hours: true })), "2026-11-18 08:00", "19:00 is after hours: the next morning");
  // Saturday closes at 17:00, Sunday is closed, Thanksgiving (Nov 26) is a holiday
  assert.equal(local(nextOpen(new Date("2026-11-21T23:30:00Z"))), "2026-11-23 08:00");
  assert.equal(local(stepDue(new Date("2026-11-26T00:30:00Z"), { business_hours: true })), "2026-11-27 08:00");
  // a wait in business hours that's already open stays put
  assert.equal(local(stepDue(new Date("2026-11-17T16:00:00Z"), { wait: { n: 30, unit: "minutes" }, business_hours: true })), "2026-11-17 10:30");
});

test("conditions over a record and its contact", () => {
  pin("2026-11-17T16:00:00Z");
  const contact = { id: "ct_x", tags: ["VIP", "Gutters"], source: { source: "Meta Ads" }, billing_address: { city: "Delano" }, owner_id: "us_00000000000000000001", lifecycle: "customer" };
  const stats = { quotes: { svc_q: ["Residential Window Cleaning"], open_quote: true }, plans: { active_plan_ids: [] }, comms: { last_inbound_at: "2026-11-17T15:00:00.000Z" }, reviews: {} };
  const quote = { status: "sent", services: ["Gutter cleaning"], options: [{ id: "a", recommended: true, totals: { first_cents: 45000 } }] };
  const f = F.factsFromRecords({ contact, stats, type: "quote", record: quote, since: "2026-11-17T14:00:00.000Z" });
  const yes = (c) => assert.ok(F.holds(c, f), JSON.stringify(c));
  const no = (c) => assert.ok(!F.holds(c, f), JSON.stringify(c));
  yes({ field: "tags", op: "has", value: "vip" });
  no({ field: "tags", op: "has", value: "Lights" });
  yes({ field: "source", op: "is", value: "meta ads" });
  yes({ field: "town", op: "is_not", value: "Mound" });
  yes({ field: "owner", op: "is", value: "us_00000000000000000001" });
  no({ field: "owner", op: "none" });
  yes({ field: "service", op: "includes", value: "gutters" });
  no({ field: "service", op: "includes", value: "windows" }, "the record's services come first");
  yes({ field: "amount", op: "gte", value: 400 });
  no({ field: "amount", op: "lte", value: 400 });
  yes({ field: "status", op: "is", value: "sent" });
  yes({ field: "replied", op: "yes" }, "an inbound text after the run started");
  yes({ field: "quoted", op: "yes" });
  yes({ field: "has_plan", op: "no" });
  yes({ field: "weekday", op: "weekday" });
  yes({ field: "time", op: "between", value: ["09:00", "12:00"] });
  yes({ field: "date", op: "between", value: ["11-01", "11-30"] });
  yes({ field: "date", op: "between", value: ["11-15", "01-15"] }, "a window across New Year");
  no({ field: "date", op: "between", value: ["09-15", "10-15"] });
  const before = F.factsFromRecords({ contact, stats, type: "quote", record: quote, since: "2026-11-17T15:30:00.000Z" });
  assert.ok(!F.holds({ field: "replied", op: "yes" }, before), "a reply before the run started doesn't count");
  // the contacts list row gives the same answers
  const row = { id: "ct_x", tg: ["VIP"], src: "Meta Ads", c: "Delano", o: null, lc: "customer", pl: ["pl_1"], oq: false, svc_q: ["Christmas lights install"], li: null, rv: "2026-01-01" };
  const r = F.factsFromRow(row);
  assert.ok(F.holds({ field: "service", op: "includes", value: "lights" }, r));
  assert.ok(F.holds({ field: "has_plan", op: "yes" }, r));
  assert.ok(F.holds({ field: "reviewed", op: "yes" }, r));
  assert.ok(F.holds({ field: "owner", op: "none" }, r));
});

test("the events the builder adds: a visit starts (Scheduling), a tag is added (Contacts)", async () => {
  const { visitEventFor } = await import("../../../netlify/lib/crm/modules/work/office.mjs");
  assert.equal(visitEventFor("start", { status: "scheduled", date: "2026-11-17" }, { status: "in_progress", date: "2026-11-17" }), "visit.started");
  assert.equal(visitEventFor("start", { status: "en_route", date: "2026-11-17" }, { status: "in_progress", date: "2026-11-17" }), "visit.started");
  assert.equal(visitEventFor("start", { status: "paused", date: "2026-11-17" }, { status: "in_progress", date: "2026-11-17" }), null, "a resume after a pause isn't a new start");
  const { addedTags } = await import("../../../netlify/lib/crm/modules/contacts/tags.mjs");
  assert.deepEqual(addedTags(["VIP", "Gutters"], ["vip", "Gutters", "Lights"]), ["Lights"], "case aside, only what's new");
  const { EVENT_TRIGGERS } = C;
  const R = await import("../../../netlify/lib/crm/core/registry.mjs");
  await import("../../../netlify/lib/crm/modules/index.mjs");
  const { EVENTS } = await import("../../../netlify/lib/crm/core/events.mjs");
  for (const e of EVENT_TRIGGERS) assert.ok(Object.hasOwn(EVENTS, e) || R.isEmitted(e), `${e} is an event some module emits`);
});
