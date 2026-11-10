// What sales does when something happens elsewhere (design §11.3 "Events",
// §5.2): a new lead joins the new-lead follow-up once (two forms from one
// phone make one follow-up), a giveaway entry doesn't; a sent quote hands
// over to the estimate follow-up (the Quotes module is a fake here: its
// events are emitted by hand); approved / declined / changes / archived;
// a STOP, a reply.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, makeLead, enrollment, deal, drain, E, intake, AS } from "./fixtures.mjs";

const { emit } = await import("../../../netlify/lib/crm/core/events.mjs");

const webLead = (n, extra = {}) => ({
  first_name: "Jordan", last_name: `Listener${n}`, phone: "(763) 555-0477", email: `jordan.listener${n}@example.com`,
  address: { street1: `${400 + n} Main St`, city: "Delano", state: "MN", zip: "55328" }, services: ["Exterior Window Cleaning"],
  source: "Website quote form", consent: { sms_service: true }, ...extra,
});
const openOf = async (cid) => (await E.openEnrollmentsOf(cid));
const Q1 = "qt_00000000000000000011";
const quoteEvent = (name, contactId, extra = {}) => emit(name, { id: Q1, wv: extra.wv || 1, quote_id: Q1, version_id: "qv_00000000000000000011", contact_id: contactId, ...extra });

test("two web forms from one phone: one contact, one follow-up; a giveaway entry joins none", async () => {
  const { t } = await setup();
  try {
    const a = await intake.intakeLead(webLead(1), { origin: "lead-form" });
    const b = await intake.intakeLead(webLead(2, { notes: "Customer notes:\nAlso gutters." }), { origin: "lead-form" });
    assert.ok(a.ok && b.ok);
    assert.equal(a.contact_id, b.contact_id, "the second form found the first contact");
    await drain(t, 3);
    const open = await openOf(a.contact_id);
    assert.equal(open.length, 1, "one open follow-up");
    assert.equal(open[0].cadence_key, "new_lead");
    const all = await E.enrollmentsOf(a.contact_id, { limit: 10 });
    assert.ok(all.every((e) => e.status !== "active" || e.id === open[0].id));
    const g = await intake.intakeLead({ ...webLead(3), phone: "(763) 555-0478", email: "giveaway.entry@example.com", source: "Holiday Lights Giveaway" }, { origin: "lead-form" });
    await drain(t, 3);
    assert.equal((await openOf(g.contact_id)).length, 0, "a giveaway entry is not a new-lead follow-up");
  } finally { t.done(); }
});

test("quote.sent: the deal is quoted, the new-lead follow-up ends and the estimate follow-up starts once; approved wins it", async () => {
  const { t, owner } = await setup();
  try {
    const c = await makeLead(owner);
    const first = await E.enroll(c.id, "new_lead", {}, AS(owner));
    const dealId = (await enrollment(first)).deal_id;
    await quoteEvent("quote.sent", c.id);
    await drain(t, 2);
    const ended = await enrollment(first);
    assert.equal(ended.status, "stopped");
    assert.equal(ended.stop_reason, "quote_sent");
    assert.equal((await deal(dealId)).status, "quoted");
    const open = await openOf(c.id);
    assert.equal(open.length, 1);
    assert.equal(open[0].cadence_key, "estimate_followup");
    assert.equal(open[0].quote_id, Q1);
    assert.equal(open[0].deal_id, dealId, "the same deal");
    // the quote resent (a new version): the follow-up doesn't start over
    await quoteEvent("quote.sent", c.id, { wv: 2 });
    await drain(t, 2);
    assert.equal((await E.enrollmentsOf(c.id, { limit: 10 })).filter((e) => e.cadence_key === "estimate_followup").length, 1);
    await quoteEvent("quote.approved", c.id, { wv: 3, job_ids: ["jb_00000000000000000011"] });
    await drain(t, 2);
    const won = await deal(dealId);
    assert.equal(won.status, "won");
    assert.ok(won.won_at);
    const est = await enrollment(open[0].id);
    assert.equal(est.status, "stopped");
    assert.equal(est.stop_reason, "won");
  } finally { t.done(); }
});

test("quote declined loses the deal; changes requested stops the follow-up with a task; archived (no response) loses an open deal", async () => {
  const { t, owner } = await setup();
  try {
    const run = async (name, extra = {}) => {
      const c = await makeLead(owner);
      const id = await E.enroll(c.id, "estimate_followup", { quote_id: Q1 }, AS(owner));
      await quoteEvent(name, c.id, extra);
      await drain(t, 2);
      return { c, e: await enrollment(id) };
    };
    const d = await run("quote.declined");
    assert.equal(d.e.stop_reason, "lost");
    assert.equal((await deal(d.e.deal_id)).status, "lost");
    const ch = await run("quote.changes_requested", { wv: 2 });
    assert.equal(ch.e.status, "stopped");
    assert.equal(ch.e.stop_reason, "replied");
    const tasks = (await t.api(`/tasks?contact=${ch.c.id}`, { as: owner })).body.data;
    assert.equal(tasks.length, 1);
    assert.match(tasks[0].title, /^Quote changes requested: Pat Sample/);
    assert.equal((await deal(ch.e.deal_id)).status, "open", "still open: they want a different quote");
    const ar = await run("quote.archived", { wv: 3 });
    assert.equal(ar.e.stop_reason, "expired");
    const ad = await deal(ar.e.deal_id);
    assert.equal(ad.status, "lost");
    assert.equal(ad.lost_reason, "no_response");
  } finally { t.done(); }
});

test("a STOP stops every follow-up (consent.changed and the keyword); a reply pauses with a task for the people on the lead", async () => {
  const { t, owner } = await setup();
  try {
    const a = await makeLead(owner);
    const a1 = await E.enroll(a.id, "new_lead", {}, AS(owner));
    const a2 = await E.enroll(a.id, "estimate_followup", { quote_id: Q1 }, AS(owner));
    await emit("consent.changed", { id: a.id, wv: 7, contact_id: a.id, channel: "sms", address_hk: "x".repeat(16), state: "opted_out" });
    await drain(t, 2);
    for (const id of [a1, a2]) {
      const e = await enrollment(id);
      assert.equal(e.status, "stopped");
      assert.equal(e.stop_reason, "opted_out");
    }
    const b = await makeLead(owner);
    const b1 = await E.enroll(b.id, "new_lead", {}, AS(owner));
    await emit("message.inbound", { id: "ms_00000000000000000021", wv: 1, contact_id: b.id, conversation_id: "cv_00000000000000000021", channel: "sms", keyword: "stop" });
    await drain(t, 2);
    assert.equal((await enrollment(b1)).stop_reason, "opted_out", "STOP in any case");
    const c = await makeLead(owner);
    const c1 = await E.enroll(c.id, "new_lead", {}, AS(owner));
    await emit("message.inbound", { id: "ms_00000000000000000022", wv: 1, contact_id: c.id, conversation_id: "cv_00000000000000000022", channel: "sms" });
    await drain(t, 2);
    const ce = await enrollment(c1);
    assert.equal(ce.status, "paused");
    assert.equal(ce.paused_reason, "replied");
    const tasks = (await t.api(`/tasks?contact=${c.id}`, { as: owner })).body.data;
    assert.equal(tasks.length, 1);
    assert.match(tasks[0].title, /^Reply from Pat Sample/);
    assert.deepEqual(tasks[0].assignee_ids, [owner.id], "the owners (no one owns this lead)");
    // a second reply the same day: still one task
    await emit("message.inbound", { id: "ms_00000000000000000023", wv: 1, contact_id: c.id, conversation_id: "cv_00000000000000000022", channel: "sms" });
    await drain(t, 2);
    assert.equal((await t.api(`/tasks?contact=${c.id}`, { as: owner })).body.data.length, 1);
    // START / HELP are not replies
    const d = await makeLead(owner);
    const d1 = await E.enroll(d.id, "new_lead", {}, AS(owner));
    await emit("message.inbound", { id: "ms_00000000000000000024", wv: 1, contact_id: d.id, conversation_id: "cv_00000000000000000024", channel: "sms", keyword: "HELP" });
    await drain(t, 2);
    assert.equal((await enrollment(d1)).status, "active");
  } finally { t.done(); }
});

test("a job booked without a quote wins the open deal and ends the new-lead follow-up (booked)", async () => {
  const { t, owner } = await setup();
  try {
    const c = await makeLead(owner);
    const id = await E.enroll(c.id, "new_lead", {}, AS(owner));
    await emit("job.completed", { id: "jb_00000000000000000031", wv: 1, job_id: "jb_00000000000000000031", contact_id: c.id, kind: "standard", billable: true, total_cents: 30000, assignee_ids: [] });
    await drain(t, 2);
    const e = await enrollment(id);
    assert.equal(e.status, "stopped");
    assert.equal(e.stop_reason, "booked");
    const d = await deal(e.deal_id);
    assert.equal(d.status, "won");
    assert.deepEqual(d.job_ids, ["jb_00000000000000000031"]);
    assert.ok(d.won_at);
  } finally { t.done(); }
});
