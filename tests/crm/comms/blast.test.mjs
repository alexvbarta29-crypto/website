// Campaign stats and the text blast (the Rotor guide's K4, K13 to K15, K18;
// S26, S50): sent, response within 72 hours, bounce, job revenue and ARR in
// the 30 days after (paid and live only), open and click "-" until email
// tracking; a blast's words as its own marketing template (never a STOP
// line: the sender adds it), the cost line, a CSV audience that needs a
// consent column, past winners, and the follow-up to who didn't reply as
// its own bulk run waiting for a test and a confirm. Synthetic data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { crmTest } from "../../helpers/crm-http.mjs";
import { store, scope, seedContact, W } from "./fixtures.mjs";

const B = await import("../../../netlify/lib/crm/modules/comms/blast.mjs");
const BULK = await import("../../../netlify/lib/crm/core/bulk.mjs");

test("stats (pure): sent, responses within 72 hours, bounce, revenue and ARR in the 30 days after; open and click wait for email tracking", () => {
  const start = "2026-11-10T15:00:00.000Z";
  const results = { ct_a: { s: "sent" }, ct_b: { s: "sent" }, ct_c: { s: "failed" }, ct_d: { s: "blocked", r: "opted_out" }, ct_e: { s: "sent" } };
  const inboxRows = [
    { c: "ct_a", ch: "sms", la: "2026-11-11T10:00:00.000Z", ld: "in" },            // replied in the window
    { c: "ct_b", ch: "sms", la: "2026-11-20T10:00:00.000Z", ld: "in" },            // too late
    { c: "ct_e", ch: "email", la: "2026-11-11T10:00:00.000Z", ld: "in" },          // another channel
    { c: "ct_z", ch: "sms", la: "2026-11-11T10:00:00.000Z", ld: "in" },            // not a recipient
  ];
  const payRows = [
    { c: "ct_a", k: "payment", st: "succeeded", a: 30000, tip: 2000, on: "2026-11-25" },
    { c: "ct_a", k: "payment", st: "succeeded", a: 99900, on: "2026-12-30" },       // after 30 days
    { c: "ct_b", k: "payment", st: "succeeded", a: 50000, on: "2026-11-12", sim: 1 }, // a practice charge
    { c: "ct_b", k: "refund", st: "succeeded", a: 1000, on: "2026-11-12" },
  ];
  const planRows = [{ c: "ct_b", st: "active", ay: 48000, at: "2026-11-15T12:00:00.000Z" }, { c: "ct_a", st: "cancelled", ay: 99900, at: "2026-11-15T12:00:00.000Z" }];
  const s = B.statsFor({ channel: "sms", started_at: start, results, recipients: Object.keys(results) }, { inboxRows, payRows, planRows });
  assert.deepEqual([s.sent, s.failed, s.responses, s.response_pct, s.bounce_pct, s.job_revenue_cents, s.arr_cents, s.open_pct, s.click_pct, s.delivered],
    [3, 1, 1, 33.3, 25, 28000, 48000, null, null, null]);
  const dry = B.statsFor({ channel: "sms", started_at: start, results: { ct_a: { s: "dry_run" } } }, { inboxRows });
  assert.deepEqual([dry.sent, dry.dry_run, dry.bounce_pct], [1, 1, null], "a dry run: sent = Outbox items");
  const t = B.totalsOf([s, { ...dry, channel: "email", job_revenue_cents: 500 }]);
  assert.deepEqual([t.campaigns, t.sent, t.responses, t.revenue_by_channel], [2, 4, 2, { sms: 28000, email: 500 }]);
  assert.equal(B.statsFor({ channel: "sms" }).response_pct, null);
});

test("cost line and CSV (pure): segments with the opt-out line; a consent column is required; unknown and no-consent rows left out", () => {
  const c = B.costOf("Hi there, spring cleanings are open.", 100, { per_segment_cents: 0.83, mms_cents: 2.2 });
  assert.deepEqual([c.segments, c.per_person_cents, c.total_cents], [1, 0.83, 83]);
  assert.equal(B.costOf("x".repeat(200), 10, { per_segment_cents: 1, mms_cents: 3 }).segments, 2);
  assert.equal(B.costOf("x", 10, { per_segment_cents: 1, mms_cents: 3 }, { picture: true }).total_cents, 30);
  const rows = [{ id: "ct_1", p: ["7635550101"], e: [] }, { id: "ct_2", p: [], e: ["pat@example.com"] }];
  const out = B.parseCsvAudience('Name,Phone,Email,Consent\n"Pat, Sr.",(763) 555-0101,,yes\nSam,,PAT@example.com,Y\nKim,+1 763 555 0199,,yes\nLee,7635550101,,no\n', rows);
  assert.deepEqual([out.ids.sort(), out.rows, out.used, out.left], [["ct_1", "ct_2"], 4, 2, { no_consent: 1, unknown: 1 }]);
  assert.throws(() => B.parseCsvAudience("Name,Phone\nPat,7635550101\n", rows), /consent column/);
  assert.throws(() => B.parseCsvAudience("Name,Consent\nPat,yes\n", rows), /phone or email/);
  assert.throws(() => B.parseCsvAudience("", rows));
});

test("a text blast: its words are its own marketing template; the cost in the preview; a CSV audience; a changed text needs a new test", async () => {
  const t = await crmTest({ now: "2026-11-17T15:00:00Z" });
  try {
    const owner = await t.user("owner");
    const mk = (n) => ({ kind: "person", first_name: "Pat", last_name: `Sample${n}`, phones: [{ e164: `+176355501${n}`, label: "mobile", primary: true, sms: true }], emails: [], lifecycle: "customer", source: { source: "Website quote form" }, tags: [], consent: { sms_service: { state: "granted" }, sms_marketing: { state: "granted" } } });
    const a = (await store.createRecord("contact", mk(71), W(owner.id))).data;
    await store.createRecord("contact", mk(72), W(owner.id));
    const made = await t.api("/campaigns", { method: "POST", as: owner, body: { name: "Spring opening", kind: "blast", channel: "email", template_key: "review_1" } });
    assert.equal(made.status, 201, made.text);
    assert.deepEqual([made.body.data.kind, made.body.data.channel, made.body.data.template_key], ["blast", "sms", null], "a blast is texts, with its own words");
    const id = made.body.data.id;
    const one = await t.api(`/campaigns/${id}`, { as: owner });
    assert.equal((await t.api(`/campaigns/${id}`, { method: "PATCH", as: owner, ifMatch: one.etag, body: { body: "Hi {{first_name|there}}! Reply STOP to opt out." } })).status, 400, "the opt-out line is added for you");
    const p1 = await t.api(`/campaigns/${id}`, { method: "PATCH", as: owner, ifMatch: one.etag, body: { body: "Hi {{first_name|there}}, spring window cleanings are open. Reply YES for a time.", followup: { on: true, after_hours: 48, body: "Still want a spring time? Reply YES." } } });
    assert.equal(p1.status, 200, p1.text);
    assert.equal(p1.body.data.template_key, B.blastKey(id));
    const tpl = await scope(() => store.getRecord("template", t.stores.data.keys("rec/template/").map((k) => t.stores.data.json(k)).find((x) => x.key === B.blastKey(id)).id));
    assert.deepEqual([tpl.data.category, tpl.data.channel], ["marketing", "sms"]);
    assert.deepEqual(p1.body.data.followup, { on: true, after_hours: 48, body: "Still want a spring time? Reply YES." });
    assert.equal((await t.api(`/campaigns/${id}`, { method: "PATCH", as: owner, ifMatch: p1.etag, body: { followup: { on: true, after_hours: 2, body: "x" } } })).status, 400, "12 hours at least");
    // the CSV: only who agreed and is in the CRM
    const csv = await t.api(`/campaigns/${id}/audience/csv`, { method: "POST", as: owner, body: { csv: "name,mobile,opted in\nA,763-555-0171,yes\nB,763-555-0172,no\nC,763-555-0999,yes\n" } });
    assert.equal(csv.status, 200, csv.text);
    assert.deepEqual(csv.body.data.audience, { include_ids: [a.id] });
    assert.deepEqual([csv.body.data.csv.used, csv.body.data.csv.no_consent, csv.body.data.csv.unknown], [1, 1, 1]);
    assert.equal((await t.api(`/campaigns/${id}/audience/csv`, { method: "POST", as: owner, body: { csv: "name,phone\nA,7635550171\n" } })).status, 400);
    const pv = await t.api(`/campaigns/${id}/preview`, { method: "POST", as: owner, body: {} });
    assert.equal(pv.body.data.count, 1);
    assert.equal(pv.body.data.cost.segments, 1);
    assert.ok(pv.body.data.cost.per_person_cents > 0);
    assert.equal(t.fetchCalls().length, 0);
  } finally { t.done(); }
});

test("the follow-up to who didn't reply: its own bulk run, waiting for a test and a confirm; stats per campaign and in total; past winners", async () => {
  const t = await crmTest({ now: "2026-11-17T15:00:00Z" });
  try {
    const owner = await t.user("owner");
    const a = await scope(() => seedContact(81, { lifecycle: "customer" }));
    const b = await scope(() => seedContact(82, { lifecycle: "customer" }));
    await store.createRecord("template", { key: "fall_note", name: "Fall note", channel: "sms", category: "marketing", body: "Hi, fall cleanings are open.", tags: [], active: true }, W(owner.id));
    const run = await scope(() => BULK.createBulkRun({ kind: "campaign", title: "Fall", recipients: [a.id, b.id], template_key: "fall_note", channel: "sms", requested_by: owner.id }, W(owner.id)));
    await scope(() => store.updateRecord("bulk_run", run.id, (x) => ({ ...x, status: "sent", results: { [a.id]: { s: "dry_run" }, [b.id]: { s: "dry_run" } } }), W(owner.id)));
    const c = (await store.createRecord("campaign", { name: "Fall", channel: "sms", template_key: "fall_note", audience: { include_ids: [a.id, b.id] }, status: "sent", test: {}, stats: {}, bulk_run_id: run.id, started_at: "2026-11-15T15:00:00.000Z", confirmed_by: owner.id, followup: { on: true, after_hours: 24, body: "Still want a fall time?" } }, W(owner.id))).data;
    // b replied on the 16th
    const CV = await import("../../../netlify/lib/crm/modules/comms/conversations.mjs");
    await scope(() => CV.recordMessage({ contact: b, channel: "sms", direction: "in", from: b.phones[0].e164, to: "+17635550111", body_text: "Yes please", status: "received", provider: "twilio", provider_id: "SM" + "9".repeat(32), origin: { kind: "inbound" }, sent_at: "2026-11-16T10:00:00.000Z" }, W(owner.id)));
    const out = await scope(() => B.startFollowup({ item: { data: { campaign_id: c.id } }, ctx: { requestId: "test" }, mode: { system_of_record: "rotor", paused: false } }));
    assert.equal(out.result, "ready:1");
    const saved = t.stores.data.json(`rec/campaign/${c.id}`);
    const fu = t.stores.data.json(`rec/bulk_run/${saved.followup_run_id}`);
    assert.deepEqual([fu.recipients, fu.status, fu.kind], [[a.id], "draft", "campaign_followup"], "only who didn't reply; it waits for a test and a confirm");
    assert.equal(t.stores.data.keys("rec/outbox/").length, 0, "nothing sent");
    assert.equal((await scope(() => B.startFollowup({ item: { data: { campaign_id: c.id } }, ctx: { requestId: "test" }, mode: {} }))).result, "skipped:off", "once");
    // stats
    const one = await t.api(`/campaigns/${c.id}/stats`, { as: owner });
    assert.deepEqual([one.body.data.sent, one.body.data.responses, one.body.data.response_pct], [2, 1, 50]);
    const all = await t.api("/campaigns/stats", { as: owner });
    assert.equal(all.status, 200);
    assert.equal(all.body.data.totals.campaigns, 1);
    assert.equal(all.body.data.per[c.id].responses, 1);
    const w = await t.api("/campaigns/winners", { as: owner });
    assert.deepEqual(w.body.data.map((x) => [x.name, x.response_pct, x.body]), [["Fall", 50, "Hi, fall cleanings are open."]]);
    assert.equal((await t.api("/campaigns/stats", { as: await t.user("tech") })).status, 403);
  } finally { t.done(); }
});
