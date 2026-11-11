// Comms: the inbox, threads and sends (design §5.7.1, §5.7.5, §4.6; §11.4 M6
// inbox.test): dry-run sends are Outbox items and nothing else (no
// ix/outbox* key exists); a real send becomes a message in its thread; a
// 25-recipient campaign batch writes ix/inbox at most once; a technician
// sees only their own visits' contacts; a campaign never sends before its
// test. Twilio is a mocked fetch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { crmTest } from "../../helpers/crm-http.mjs";
import { connected, staffContact, mockFetch, drain, writes, store, scope, seedContact, CV, STAFF, TEST_FROM, W } from "./fixtures.mjs";

const { call } = await import("../../../netlify/lib/crm/core/services.mjs");
const BULK = await import("../../../netlify/lib/crm/core/bulk.mjs");
const ids = await import("../../../netlify/lib/crm/core/ids.mjs");
const person = (n, o = {}) => ({ kind: "person", first_name: "Pat", last_name: `Sample${n}`, phones: [{ e164: `+1763555${String(1000 + n).slice(-4)}`, label: "mobile", primary: true, sms: true }], emails: [], lifecycle: "customer", source: { source: "Website quote form" }, tags: [], consent: { sms_service: { state: "granted" }, sms_marketing: { state: "granted" } }, billing_address: { street1: `${n} Example Ave`, city: "Delano", state: "MN", zip: "55328", country: "US" }, ...o });

test("today (dry run): a send through the sink is an Outbox item and nothing else; the thread shows it as Not sent; no ix/outbox key exists", async () => {
  const t = await crmTest({});
  try {
    const owner = await t.user("owner");
    const c = (await store.createRecord("contact", person(1), W(owner.id))).data;
    const res = await t.api("/messages", { method: "POST", as: owner, body: { contact_id: c.id, channel: "sms", body: "See you Wednesday at 8.", client_id: "client-0001" } });
    assert.equal(res.status, 200);
    assert.deepEqual([res.body.data.status, res.body.data.mode], ["dry_run", "dry_run"]);
    assert.ok(res.body.data.outbox_id);
    // the tech's On my way goes through the same service
    const omw = await scope(() => call("messages.sink", { contact_id: c.id, channel: "sms", body: "On my way, about 20 minutes." }, { ...W(owner.id), sysMode: { system_of_record: "rotor", paused: false } }));
    assert.equal(omw.status, "dry_run");
    const S = t.stores.data;
    assert.equal(S.keys("rec/outbox/").length, 2);
    assert.equal(S.keys("rec/message/").length, 0, "no message");
    assert.equal(S.keys("rec/conversation/").length, 0, "no conversation");
    assert.equal(S.keys(`rel/contact-activity/${c.id}/`).filter((k) => /--sms\./.test(k)).length, 0, "no timeline row");
    assert.deepEqual(S.keys("ix/outbox"), [], "the outbox has no index blob");
    assert.deepEqual(S.keys("ix/inbox"), [], "and a dry-run send never touches the inbox");
    assert.equal(t.fetchCalls().length, 0, "nothing left the site");
    // the thread of a contact with no conversation yet: the two sends wait as Not sent bubbles
    const th = await t.api(`/inbox/contact/${c.id}`, { as: owner });
    assert.equal(th.status, 200);
    assert.equal(th.body.data.conversation, null);
    assert.deepEqual(th.body.data.pending.map((p) => p.body_text).sort(), ["On my way, about 20 minutes. Reply STOP to opt out.", "See you Wednesday at 8. Reply STOP to opt out."], "what would have gone out, footer included (a dry run never counts as the first text)");
    assert.ok(th.body.data.pending.every((p) => p.mode === "dry_run" && !("id" in p)));
    assert.equal(th.body.data.info.mode, "dry_run");
    assert.equal((await t.api("/inbox", { as: owner })).body.data.length, 0);
    assert.equal((await t.api("/me/badges", { as: owner })).body.data.inbox_unread, 0);
  } finally { t.done(); }
});

test("test mode: a send to the team's phone becomes a message in its thread; anyone else is held back and nothing is fetched", async () => {
  const { t, owner } = await connected();
  const net = mockFetch([{ match: "api.twilio.com", respond: () => Response.json({ sid: "SM" + "a".repeat(32), status: "queued" }, { status: 201 }) }]);
  try {
    const staff = await staffContact();
    const other = await scope(() => seedContact(8, { flags: { test: true } }));
    const ok = await t.api("/messages", { method: "POST", as: owner, body: { contact_id: staff.id, channel: "sms", body: "Test from the CRM", client_id: "client-0002" } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.data.mode, "test");
    assert.ok(ok.body.data.message_id && ok.body.data.conversation_id);
    assert.equal(net.calls.length, 1);
    const form = new URLSearchParams(net.calls[0].body);
    assert.deepEqual([form.get("To"), form.get("From")], [STAFF, TEST_FROM], "from the separate test number");
    assert.match(form.get("Body"), /^Test from the CRM Reply STOP to opt out\.$/, "the footer on the first text from this number");
    assert.match(form.get("StatusCallback"), /^https:\/\/www\.bartawindowwashing\.com\/api\/crm\/hooks\/twilio\/status\?m=[0-9a-f]{32}$/);
    const S = t.stores.data;
    const m = S.json(`rec/message/${ok.body.data.message_id}`);
    assert.deepEqual([m.direction, m.status, m.provider, m.origin.kind, m.origin.user_id, m.footer_appended, m.sending_number], ["out", "queued", "twilio", "user", owner.id, true, TEST_FROM]);
    const conv = S.json(`rec/conversation/${ok.body.data.conversation_id}`);
    assert.deepEqual([conv.contact_id, conv.last_direction, conv.unread, conv.needs_reply], [staff.id, "out", 0, false]);
    // a retry with the same client id sends nothing twice
    const again = await t.api("/messages", { method: "POST", as: owner, body: { contact_id: staff.id, channel: "sms", body: "Test from the CRM", client_id: "client-0002" } });
    assert.equal(again.body.data.status, "already");
    assert.equal(net.calls.length, 1);
    // someone not on the list: held back, recorded in the Outbox with its reason
    const no = await t.api("/messages", { method: "POST", as: owner, body: { contact_id: other.id, channel: "sms", body: "Hello" } });
    assert.deepEqual([no.body.data.status, no.body.data.blocked_reason], ["blocked", "test_mode_recipient"]);
    assert.equal(net.calls.length, 1, "no request for anyone off the list");
    // the thread: the message with its status, newest first; ETag for the 10 s poll
    const th = await t.api(`/conversations/${conv.id}`, { as: owner });
    assert.equal(th.body.data.messages[0].body_text, "Test from the CRM Reply STOP to opt out.");
    assert.equal(th.body.data.info.mode, "test");
    const etag = th.headers.get("etag");
    assert.equal((await t.api(`/conversations/${conv.id}`, { as: owner, headers: { "if-none-match": etag } })).status, 304);
    const whole = await t.api(`/messages/${m.id}`, { as: owner });
    assert.deepEqual([whole.body.data.to, whole.body.data.footer_appended], [STAFF, true]);
  } finally { net.restore(); t.done(); }
});

test("a technician's inbox: only the people on their own visits, techFields only; anything else is refused", async () => {
  const { t, owner } = await connected();
  try {
    const tech = await t.user("tech");
    const mine = await scope(() => seedContact(21, { flags: { test: true } }));
    const theirs = await scope(() => seedContact(22, { flags: { test: true } }));
    const vid = ids.newId("visit");
    await store.settledWrite(`rec/visit/${vid}`, { id: vid, type: "visit", v: 1, wv: 1, contact_id: mine.id, assignee_ids: [tech.id], date: "2026-11-18", status: "scheduled", created_at: "2026-11-17T15:00:00.000Z" }, { onlyIfNew: true });
    await scope(() => store.addRel("tech-visits", tech.id, "2026-11-18", vid));
    const rec = (c, body) => scope(() => CV.recordMessage({ contact: c, channel: "sms", direction: "in", from: c.phones[0].e164, to: "+17635550111", body_text: body, status: "received", provider: "twilio", provider_id: "SM" + c.id.slice(-10) + "0".repeat(22), origin: { kind: "inbound" } }, W(owner.id)));
    const a = await rec(mine, "Gate code is on the list");
    const b = await rec(theirs, "Private office matter");
    const office = await t.api("/inbox", { as: owner });
    assert.equal(office.body.data.length, 2);
    const list = await t.api("/inbox", { as: tech });
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.data.map((x) => x.contact_id), [mine.id], "only their visit's contact");
    assert.ok(!("assignee_id" in list.body.data[0]) && !list.text.includes(theirs.id));
    assert.equal((await t.api("/me/badges", { as: tech })).body.data.inbox_unread, 1);
    assert.equal((await t.api("/me/badges", { as: owner })).body.data.inbox_unread, 2);
    const th = await t.api(`/conversations/${a.conversation.id}`, { as: tech });
    assert.equal(th.status, 200);
    assert.equal(th.body.data.messages[0].body_text, "Gate code is on the list");
    assert.deepEqual(Object.keys(th.body.data.contact).sort(), ["display_name", "first_name", "id", "phones"]);
    for (const [method, path] of [["GET", `/conversations/${b.conversation.id}`], ["POST", `/conversations/${b.conversation.id}/read`], ["POST", `/conversations/${b.conversation.id}/done`], ["GET", `/messages/${b.message.id}`], ["GET", `/inbox/contact/${theirs.id}`]]) {
      const res = await t.api(path, { method, as: tech, body: method === "POST" ? {} : undefined });
      assert.equal(res.status, 403, `${method} ${path}`);
      assert.ok(!res.text.includes("Private office matter"));
    }
    assert.equal((await t.api(`/conversations/${a.conversation.id}/assign`, { method: "POST", as: tech, body: { user_id: tech.id } })).status, 403, "only the office assigns");
    assert.equal((await t.api(`/conversations/${a.conversation.id}/assign`, { method: "POST", as: owner, body: { user_id: owner.id } })).body.data.assignee_id, owner.id);
    assert.deepEqual((await t.api("/inbox?filter=mine", { as: owner })).body.data.map((x) => x.id), [a.conversation.id]);
    assert.equal((await t.api("/inbox?filter=nonsense", { as: owner })).status, 400);
  } finally { t.done(); }
});

test("a campaign: refused before its test send; a 25-recipient batch makes at most one ix/inbox write; results per person", async () => {
  const { t, owner } = await connected({ sms: { mode: "live", from: "+17635550112" } });
  let n = 0;
  const net = mockFetch([{ match: "api.twilio.com", respond: () => Response.json({ sid: "SM" + String(++n).padStart(32, "0"), status: "queued" }, { status: 201 }) }]);
  BULK.setPace(async () => {});
  try {
    // after cutover (the only time a live send exists)
    await store.settledWrite("sys/mode", { system_of_record: "crm", paused: false, cutover_at: "2026-11-16T12:00:00.000Z" }, { onlyIfNew: true });
    const people = [];
    for (let i = 1; i <= 25; i++) people.push((await store.createRecord("contact", person(i), W(owner.id))).data);
    await store.createRecord("contact", person(26, { lifecycle: "lead" }), W(owner.id));
    // (the test contact is the team's own phone: it has agreed to marketing texts, or a marketing test is held back like any other)
    const tester = await staffContact(50, { consent: { sms_marketing: { state: "granted" } } });
    assert.equal((await t.api("/settings/messaging_test", { method: "PUT", as: owner, ifMatch: "new", body: { contact_id: tester.id } })).status, 200);
    await store.createRecord("template", { key: "fall_note", name: "Fall note", channel: "sms", category: "marketing", body: "Hi {{first_name|there}}, fall cleanings are open.", tags: [], active: true }, W(owner.id));
    const made = await t.api("/campaigns", { method: "POST", as: owner, body: { name: "Fall cleaning", channel: "sms", template_key: "fall_note", audience: { lifecycle: ["customer"], towns: ["Delano"] } } });
    assert.equal(made.status, 201);
    const id = made.body.data.id;
    const prev = await t.api(`/campaigns/${id}/preview`, { method: "POST", as: owner, body: {} });
    assert.equal(prev.body.data.count, 25, "the 25 customers; the lead is not in the audience");
    assert.equal(prev.body.data.samples.length, 10);
    assert.match(prev.body.data.samples[0].text, /^Hi Pat, fall cleanings are open\.$/);

    // refused before the test send, whoever asks
    const early = await t.api(`/campaigns/${id}/schedule`, { method: "POST", as: owner, body: { send_at: null } });
    assert.equal(early.status, 409);
    assert.match(early.body.error.message, /Send the test first/);
    assert.equal(net.calls.length, 0);

    // the test: the audience is prepared in the bulk lane, then one text to the test contact
    assert.equal((await t.api(`/campaigns/${id}/test`, { method: "POST", as: owner, body: {} })).status, 202);
    await t.runWorker({ lane: "bulk" });
    const tested = await t.api(`/campaigns/${id}/test`, { method: "POST", as: owner, body: {} });
    assert.equal(tested.status, 200);
    assert.equal(tested.body.data.campaign.status, "tested");
    assert.equal(net.calls.length, 1);
    assert.equal(new URLSearchParams(net.calls[0].body).get("To"), STAFF, "the test goes to the test contact");

    // an admin may send; a tech may not
    const tech = await t.user("tech");
    assert.equal((await t.api(`/campaigns/${id}/schedule`, { method: "POST", as: tech, body: { send_at: null } })).status, 403);
    const S = t.stores.data;
    const mark = S.calls.length;
    const go = await t.api(`/campaigns/${id}/schedule`, { method: "POST", as: owner, body: { send_at: null } });
    assert.equal(go.status, 200);
    assert.equal(go.body.data.status, "sending");
    await t.runWorker({ lane: "bulk" });
    assert.equal(net.calls.length, 26, "25 recipients, one request each");
    assert.ok(net.calls.slice(1).every((c) => / Reply STOP to opt out\.$/.test(new URLSearchParams(c.body).get("Body"))), "every marketing text carries the footer");
    assert.equal(S.keys("rec/conversation/").length, 26);
    const inboxWrites = writes(S.calls.slice(mark), /^ix\/inbox/);
    assert.ok(inboxWrites.length <= 1, `one inbox write for the batch (${inboxWrites.length})`);
    const rows = Object.keys(S.json("ix/inbox/y2026").rows).length;
    assert.equal(rows, 26, "every conversation is in the list after that one write");

    const done = await t.api(`/campaigns/${id}`, { as: owner });
    assert.equal(done.body.data.status, "sent");
    assert.equal(done.body.data.stats.sent, 25);
    const rec = await t.api(`/campaigns/${id}/recipients`, { as: owner });
    assert.equal(rec.body.data.length, 25);
    assert.ok(rec.body.data.every((x) => ["sent", "queued"].includes(x.status) && /^Pat Sample/.test(x.name)));
    // a second campaign right after: everyone was just reached
    const second = await t.api("/campaigns", { method: "POST", as: owner, body: { name: "Again", channel: "sms", template_key: "fall_note", audience: { lifecycle: ["customer"] } } });
    const p2 = await t.api(`/campaigns/${second.body.data.id}/preview`, { method: "POST", as: owner, body: {} });
    assert.deepEqual([p2.body.data.count, p2.body.data.excluded.recent_campaign], [0, 25], "nobody gets two campaigns within 3 days");
  } finally { BULK.setPace(null); net.restore(); t.done(); }
});

test("a campaign's schedule: editable until it starts, sent by the queue as the person who scheduled it; a changed audience needs a new test; Rotor's campaigns are history", async () => {
  const t = await crmTest({});
  BULK.setPace(async () => {});
  try {
    const owner = await t.user("owner");
    for (let i = 1; i <= 3; i++) await store.createRecord("contact", person(i), W(owner.id));
    const tester = await scope(() => seedContact(40, { flags: { test: true }, consent: { sms_marketing: { state: "granted" } } }));
    await t.api("/settings/messaging_test", { method: "PUT", as: owner, ifMatch: "new", body: { contact_id: tester.id } });
    await store.createRecord("template", { key: "fall_note", name: "Fall note", channel: "sms", category: "marketing", body: "Hi {{first_name|there}}, fall cleanings are open.", tags: [], active: true }, W(owner.id));
    const id = (await t.api("/campaigns", { method: "POST", as: owner, body: { name: "Fall", channel: "sms", template_key: "fall_note", audience: { lifecycle: ["customer"] } } })).body.data.id;
    await t.api(`/campaigns/${id}/test`, { method: "POST", as: owner, body: {} });
    await t.runWorker({ lane: "bulk" });
    assert.equal((await t.api(`/campaigns/${id}/test`, { method: "POST", as: owner, body: {} })).body.data.status, "tested");
    // a past time is refused; a future one is kept
    assert.equal((await t.api(`/campaigns/${id}/schedule`, { method: "POST", as: owner, body: { send_at: "2026-11-17T14:00:00Z" } })).status, 400);
    const s1 = await t.api(`/campaigns/${id}/schedule`, { method: "POST", as: owner, body: { send_at: "2026-11-18T16:00:00Z" } });
    assert.deepEqual([s1.body.data.status, s1.body.data.send_at], ["scheduled", "2026-11-18T16:00:00.000Z"]);
    // moved earlier: the old queue item does nothing, the new one starts it
    const s2 = await t.api(`/campaigns/${id}/schedule`, { method: "POST", as: owner, body: { send_at: "2026-11-17T16:00:00Z" } });
    assert.equal(s2.body.data.send_at, "2026-11-17T16:00:00.000Z");
    const { advance, minutes } = await import("../../helpers/crm-clock.mjs");
    advance(minutes(61));
    await t.runWorker({ lane: "fast" });
    assert.equal(t.stores.data.json(`rec/campaign/${id}`).status, "sending");
    assert.equal(t.stores.data.json(`rec/campaign/${id}`).confirmed_by, owner.id);
    await t.runWorker({ lane: "bulk" });
    const done = await t.api(`/campaigns/${id}`, { as: owner });
    assert.equal(done.body.data.status, "sent");
    assert.equal(done.body.data.stats.dry_run, 3, "dry run: three Outbox items, nothing sent");
    assert.equal(t.fetchCalls().length, 0);
    advance(minutes(24 * 60));
    await t.runWorker({ lane: "fast" });
    assert.equal(t.stores.data.json(`rec/campaign/${id}`).status, "sent", "the first schedule's item changed nothing");

    // a tested campaign whose audience changes goes back to a draft
    const c2 = (await t.api("/campaigns", { method: "POST", as: owner, body: { name: "Two", channel: "sms", template_key: "fall_note", audience: { lifecycle: ["customer"] } } })).body;
    const got = await t.api(`/campaigns/${c2.data.id}`, { as: owner });
    const edited = await t.api(`/campaigns/${c2.data.id}`, { method: "PATCH", as: owner, ifMatch: got.headers.get("etag"), body: { audience: { lifecycle: ["lead"] } } });
    assert.equal(edited.status, 200);
    assert.deepEqual([edited.body.data.status, edited.body.data.audience.lifecycle], ["draft", ["lead"]]);
    assert.equal((await t.api(`/campaigns/${c2.data.id}/test`, { method: "POST", as: owner, body: {} })).status, 409, "nobody matches: no test, no send");
    assert.equal((await t.api(`/campaigns/${c2.data.id}/cancel`, { method: "POST", as: owner, body: {} })).body.data.status, "cancelled");

    // one that came from Rotor can't be edited, tested or sent
    const rotor = await store.createRecord("campaign", { name: "Review Request", description: "59 customers", channel: "sms", audience: {}, status: "sent", rotor: { campaign_id: 596 } }, { by: "import", origin: "import", actor_kind: "import", requestId: "test" });
    for (const [path, body] of [["test", {}], ["schedule", { send_at: null }], ["cancel", {}]]) assert.equal((await t.api(`/campaigns/${rotor.data.id}/${path}`, { method: "POST", as: owner, body })).status, 409, path);
    const list = await t.api("/campaigns", { as: owner });
    assert.ok(list.body.data.some((x) => x.imported && x.name === "Review Request"));
  } finally { BULK.setPace(null); t.done(); }
});
