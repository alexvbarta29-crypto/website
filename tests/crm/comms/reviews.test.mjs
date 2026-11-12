// Comms: the review sequence and Google reviews (design §5.7.4
// review.sequence, §5.7.6, D24, B3). GBP is a mocked fetch, read-only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { crmTest } from "../../helpers/crm-http.mjs";
import { advance, minutes, hours, days } from "../../helpers/crm-clock.mjs";
import { mockFetch, store, scope, seedContact, W, PROD_ENV } from "./fixtures.mjs";

const { emit } = await import("../../../netlify/lib/crm/core/events.mjs");
const { getType } = await import("../../../netlify/lib/crm/core/registry.mjs");
const { call } = await import("../../../netlify/lib/crm/core/services.mjs");
const RV = await import("../../../netlify/lib/crm/modules/comms/reviews.mjs");
const IMPORT = { by: "import", origin: "import", actor_kind: "import", requestId: "test" };

let jobN = 0;
async function completedJob(contact, o = {}, ctx = W()) {
  const base = { ...getType("job").example(), number: 9100 + ++jobN };
  delete base.number_label;
  const rec = await store.createRecord("job", { ...base, contact_id: contact.id, contact_name: `${contact.first_name} ${contact.last_name}`, status: "completed", completed_at: "2026-11-17T15:00:00.000Z", kind: "standard", billable: true, service_types: ["Residential Window Cleaning"], assignee_ids: [], ...o }, ctx);
  return rec.data;
}
const completed = (job) => scope(() => emit("job.completed", { id: job.id, wv: job.wv, job_id: job.id, contact_id: job.contact_id, kind: job.kind, billable: job.billable !== false, total_cents: 24310, assignee_ids: job.assignee_ids || [], at: job.completed_at }));
const queued = (t) => t.stores.data.keys("q/").map((k) => ({ k, v: t.stores.data.json(k) })).filter((x) => x.v.kind === "automation.send" && x.v.data.automation === "review.sequence").sort((a, b) => a.v.due_at.localeCompare(b.v.due_at));
const outbox = (t) => t.stores.data.keys("rec/outbox/").map((k) => t.stores.data.json(k)).filter((o) => /^review_/.test(o.template_key || ""));
const run = async (t, n = 3) => { for (let i = 0; i < n; i++) await t.runWorker({ lane: "fast" }); };

test("step times: 90 minutes after the job, moved into 09:00-19:00; day 3 and day 8 at 11:00 local", () => {
  const iso = (list) => list.map((d) => d.toISOString());
  assert.deepEqual(iso(RV.stepTimes("2026-11-17T15:00:00.000Z")), ["2026-11-17T16:30:00.000Z", "2026-11-20T17:00:00.000Z", "2026-11-25T17:00:00.000Z"], "done 9:00 → 10:30, then Fri and Wed at 11:00");
  assert.equal(iso(RV.stepTimes("2026-11-18T00:10:00.000Z"))[0], "2026-11-18T15:00:00.000Z", "done 6:10 PM → 7:40 PM is too late: 9:00 the next morning");
  assert.equal(iso(RV.stepTimes("2026-11-17T12:30:00.000Z"))[0], "2026-11-17T15:00:00.000Z", "done 6:30 AM → 9:00");
  assert.deepEqual(iso(RV.stepTimes("2026-10-30T20:00:00.000Z")).slice(1), ["2026-11-02T17:00:00.000Z", "2026-11-07T17:00:00.000Z"], "11:00 local on both sides of the clock change");
  assert.equal(RV.nameScore("Pat E.", "Pat Example"), 1);
  assert.equal(RV.nameScore("Pat", "Pat Example"), 0.6);
  assert.equal(RV.nameScore("Pat Sample", "Pat Example"), 0);
  assert.equal(RV.nameScore("Sam Example", "Pat Example"), 0);
});

test("completing a job queues the three review texts (B3); a reply cancels steps 2 and 3", async () => {
  const t = await crmTest({});
  try {
    const c = await scope(() => seedContact(1));
    const job = await completedJob(c);
    await completed(job);
    await run(t);
    const q = queued(t);
    assert.deepEqual(q.map((x) => [x.v.data.template_key, x.v.due_at]), [["review_1", "2026-11-17T16:30:00.000Z"], ["review_2", "2026-11-20T17:00:00.000Z"], ["review_3", "2026-11-25T17:00:00.000Z"]]);
    assert.ok(q.every((x) => x.v.marker.ns === "done-dry"), "dry run: the Outbox, never a phone");
    assert.equal(t.stores.data.json(`rec/contact_stats/${c.id}`).reviews.sequence.job_id, job.id);
    // step 1 comes due
    advance(minutes(95));
    await run(t);
    const first = outbox(t);
    assert.equal(first.length, 1);
    assert.match(first[0].body, /^Hey [A-Z][a-z]+, Alex with Barta Window Washing here\. Thanks for having us out today![\s\S]*"window cleaning in Delano"[\s\S]*https:\/\/g\.page\/r\/CfnTsPliwEw4EBM\/review Reply STOP to opt out\.$/);
    assert.deepEqual([first[0].mode, first[0].category, first[0].origin.id], ["dry_run", "service", "review.sequence"]);
    // the customer replies
    await scope(() => store.updateStats(c.id, "comms", (p) => ({ ...p, last_inbound_at: new Date(Date.parse("2026-11-17T15:00:00Z") + 100 * 60000).toISOString() }), W()));
    await scope(() => emit("message.inbound", { id: "ms_0000000000000000000a", wv: 1, contact_id: c.id, conversation_id: "cv_0000000000000000000a", channel: "sms" }));
    await run(t);
    assert.equal(t.stores.data.json(`rec/contact_stats/${c.id}`).reviews.sequence.stopped, "replied");
    advance(days(9));
    await run(t, 4);
    assert.equal(outbox(t).length, 1, "steps 2 and 3 never go out");
    assert.equal(queued(t).length, 0, "and their queue items are finished");
    assert.ok(t.stores.data.keys("alog/").some((k) => k.includes("review.sequence") && k.includes("skipped-replied")), "the automation log says why");
    assert.equal(t.fetchCalls().length, 0);
  } finally { t.done(); }
});

test("who is not asked: touch-ups and unbilled work, an imported job, someone asked in the last 180 days, someone who already left a review; an opt-out stops the rest", async () => {
  const t = await crmTest({});
  try {
    const a = await scope(() => seedContact(2));
    await completed(await completedJob(a, { kind: "touch_up", billable: false }));
    await completed(await completedJob(a, { billable: false }));
    await completed(await completedJob(a, {}, IMPORT));
    await run(t);
    assert.equal(queued(t).length, 0, "no touch-up, no unbilled job, nothing the import brought");
    const log = t.stores.data.keys("alog/").join("\n");
    assert.match(log, /review\.sequence--jb_[0-9a-z]+--skipped-not_billable/);
    assert.match(log, /review\.sequence--jb_[0-9a-z]+--skipped-imported/);
    // lights work is asked even when the job itself bills nothing
    const lights = await scope(() => seedContact(3));
    await completed(await completedJob(lights, { kind: "lights_install", billable: false }));
    await run(t);
    assert.equal(queued(t).length, 3);
    // a second job a month later: asked within 180 days → not again
    advance(days(30));
    await run(t, 5);
    const n = outbox(t).length;
    await completed(await completedJob(lights, { completed_at: new Date(Date.parse("2026-11-17T15:00:00Z") + 30 * 86400000).toISOString() }));
    await run(t);
    assert.equal(queued(t).length, 0);
    assert.equal(outbox(t).length, n);
    // a matched review: never asked again
    const fan = await scope(() => seedContact(4));
    await scope(() => store.updateStats(fan.id, "reviews", (p) => ({ ...p, review_left_at: "2026-10-01T00:00:00.000Z" }), W()));
    assert.equal(await scope(() => call("reviews.isReviewed", fan.id)), true);
    assert.equal(await scope(() => call("reviews.isReviewed", a.id)), false);
    await completed(await completedJob(fan, { completed_at: new Date(Date.parse("2026-11-17T15:00:00Z") + 30 * 86400000).toISOString() }));
    await run(t);
    assert.equal(queued(t).length, 0);
    // an opt-out after step 1: the sequence is stopped
    const d = await scope(() => seedContact(5));
    await completed(await completedJob(d, { completed_at: new Date(Date.parse("2026-11-17T15:00:00Z") + 30 * 86400000).toISOString() }));
    await run(t);
    assert.equal(queued(t).length, 3);
    await scope(() => emit("consent.changed", { id: "sup.sms.x", wv: 1, contact_id: d.id, channel: "sms", address_hk: "x".repeat(26), state: "opted_out" }));
    await run(t);
    assert.equal(t.stores.data.json(`rec/contact_stats/${d.id}`).reviews.sequence.stopped, "opted_out");
  } finally { t.done(); }
});

test("Google reviews are read, suggested and matched by a person: the match stops the sequence, credits the techs and feeds reviews.isReviewed", async () => {
  const t = await crmTest({ env: { ...PROD_ENV, GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret", GOOGLE_REFRESH_TOKEN: "refresh", ACCOUNT_ID: "111", LOCATION_ID: "222" } });
  const net = mockFetch([
    { match: "oauth2.googleapis.com/token", respond: () => Response.json({ access_token: "ya29.test" }) },
    { match: "mybusiness.googleapis.com", respond: () => Response.json({ reviews: [
      { reviewId: "rev-1", reviewer: { displayName: "Pat S." }, starRating: "FIVE", comment: "Spotless windows in Delano!", createTime: "2026-11-17T14:00:00Z", updateTime: "2026-11-17T14:00:00Z" },
      { reviewId: "rev-2", reviewer: { displayName: "Nobody Known" }, starRating: "FOUR", createTime: "2026-11-16T14:00:00Z", updateTime: "2026-11-16T14:00:00Z" },
    ] }) },
  ]);
  try {
    const owner = await t.user("owner");
    await t.bootstrap(owner);
    const tech = await t.user("tech");
    const c = await scope(() => seedContact(6, { first_name: "Pat", last_name: "Sample", display_name: "Pat Sample", flags: { test: true } }));
    const job = await completedJob(c, { completed_at: "2026-11-12T18:00:00.000Z", assignee_ids: [tech.id] }, W(owner.id));
    // off until an owner switches reading on
    advance(hours(1));
    await run(t, 2);
    assert.equal(net.calls.length, 0, "reviews are not read until the integration is live");
    const cur = await store.getSettingWithEtag("integrations");
    await store.putSetting("integrations", { ...cur.data, reviews: { mode: "live" } }, { ...W(owner.id), ifMatch: cur.etag || "new" });
    advance(hours(1));
    await run(t, 3);
    assert.ok(net.calls.length >= 2, "the poll ran");
    assert.ok(net.calls.filter((x) => x.url.includes("mybusiness")).every((x) => x.method === "GET"), "read-only");
    const S = t.stores.data;
    assert.equal(S.keys("rec/review/").length, 2);
    advance(hours(1));
    await run(t, 3);
    assert.equal(S.keys("rec/review/").length, 2, "the next poll adds nothing twice");
    const list = await t.api("/reviews", { as: owner });
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.data.map((r) => [r.reviewer_name, r.rating, r.matched, r.suggestions]), [["Pat S.", 5, false, 1], ["Nobody Known", 4, false, 0]]);
    assert.equal(list.body.meta.mode, "live");
    const rid = list.body.data[0].id;
    const one = await t.api(`/reviews/${rid}`, { as: owner });
    assert.deepEqual(one.body.data.suggestions.map((s) => [s.contact_id, s.job_id, s.score]), [[c.id, job.id, 1]]);
    assert.equal(await scope(() => call("reviews.isReviewed", c.id)), false, "a suggestion is not a match");
    // a tech can't match; the office does, with one tap
    assert.equal((await t.api(`/reviews/${rid}/match`, { method: "POST", as: tech, body: { contact_id: c.id } })).status, 403);
    assert.equal((await t.api(`/reviews/${rid}/match`, { method: "POST", as: owner, body: {} })).status, 400);
    const m = await t.api(`/reviews/${rid}/match`, { method: "POST", as: owner, body: { contact_id: c.id, job_id: job.id } });
    assert.equal(m.status, 200);
    assert.deepEqual([m.body.data.match.contact_id, m.body.data.match.tech_ids, m.body.data.match.by], [c.id, [tech.id], "confirmed"]);
    assert.equal(await scope(() => call("reviews.isReviewed", c.id)), true);
    assert.equal(S.json(`rec/contact_stats/${c.id}`).reviews.review_left_at, "2026-11-17T14:00:00.000Z");
    assert.ok(S.keys(`rel/contact-activity/${c.id}/`).some((k) => k.includes("--review.matched--")));
    advance(minutes(1));
    const week = await t.api("/reviews", { as: owner });
    assert.equal(week.body.meta.per_tech_week[tech.id], 1, "the tech's count this week");
    assert.equal(week.body.data[0].matched, true);
    assert.ok(!net.calls.some((x) => x.method !== "GET" && x.url.includes("mybusiness")), "nothing was ever written to Google");
  } finally { net.restore(); t.done(); }
});
