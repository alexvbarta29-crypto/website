// Comms: inbound texts (design §6.3, §5.7.1; §11.4 M6 inbound.test,
// keywords.test, status.test). Twilio is a mocked fetch; phones are 555.
import { test } from "node:test";
import assert from "node:assert/strict";
import { connected, staffContact, inbound, statusCb, mockFetch, drain, writes, store, scope, seedContact, CV, TW, SID, TOKEN, STAFF, TEST_FROM, PROD_ENV, W, twilioForm } from "./fixtures.mjs";
import { crmTest } from "../../helpers/crm-http.mjs";
import { seedImportedContact } from "../../helpers/crm-fixtures.mjs";

const IN = await import("../../../netlify/lib/crm/modules/comms/inbound.mjs");
const hk = (p) => store.hk("phone", p);
const sup = (t, p) => t.stores.data.keys(`sup/sms/${hk(p)}`).length === 1 && t.stores.data.json(`sup/sms/${hk(p)}`).state === "opted_out";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, ...Array(64).fill(7)]);

test("a webhook does nothing until Twilio is connected: no secret, dry-run mode, a wrong signature or another account all answer 403", async () => {
  // no secrets at all (today's site)
  let t = await crmTest({ env: { CONTEXT: "production", CRM_PRODUCTION: "1", CRM_KEY_SALT: "test-salt-not-real" } });
  try {
    const f = twilioForm({ AccountSid: SID, MessageSid: "SM" + "1".repeat(32), From: STAFF, Body: "hi" });
    const before = t.stores.data.calls.length;
    const res = await t.api("/hooks/twilio/sms", { method: "POST", raw: f.raw, headers: f.headers, csrf: false, client: false });
    assert.equal(res.status, 403);
    assert.equal(writes(t.stores.data.calls.slice(before), /./).length, 0, "nothing is written");
    assert.equal((await t.api("/hooks/twilio/status", { method: "POST", raw: f.raw, headers: f.headers, csrf: false, client: false })).status, 403);
    assert.equal((await t.api("/hooks/email/postmark?token=x", { method: "POST", body: { RecordType: "Delivery" }, csrf: false, client: false })).status, 403);
  } finally { t.done(); }
  // secrets set, but texting still in dry-run (the default): still nothing
  t = await crmTest({ env: PROD_ENV });
  try {
    const f = twilioForm({ AccountSid: SID, MessageSid: "SM" + "2".repeat(32), From: STAFF, Body: "hi" });
    assert.equal((await t.api("/hooks/twilio/sms", { method: "POST", raw: f.raw, headers: f.headers, csrf: false, client: false })).status, 403);
    assert.equal(t.stores.data.keys("rec/message/").length, 0);
  } finally { t.done(); }
  const { t: c } = await connected();
  try {
    await staffContact();
    assert.equal((await inbound(c, {}, { token: "another-token" })).status, 403, "a wrong signature");
    assert.equal((await inbound(c, {}, { headers: { "x-twilio-signature": "" } })).status, 403, "no signature");
    assert.equal((await inbound(c, { AccountSid: "AC" + "f".repeat(32) })).status, 403, "another account");
    assert.equal(c.stores.data.keys("rec/message/").length, 0);
    const ok = await inbound(c, { Body: "Thanks!" });
    assert.equal(ok.status, 200);
    assert.equal(ok.text, "<Response/>");
    assert.equal(c.stores.data.keys("rec/message/").length, 1);
  } finally { c.done(); }
});

test("an inbound text lands once on its contact: the conversation reopens, unread + 1, the owners are told, sales hears message.inbound", async () => {
  const { t, owner } = await connected();
  try {
    const contact = await staffContact();
    const first = await inbound(t, { Body: "Can you come Thursday?" });
    assert.equal(first.status, 200);
    const again = await t.api("/hooks/twilio/sms", { method: "POST", ...(() => { const f = twilioForm(first.params); return { raw: f.raw, headers: f.headers }; })(), csrf: false, client: false });
    assert.equal(again.status, 200, "Twilio's retry is answered");
    const S = t.stores.data;
    assert.equal(S.keys("rec/message/").length, 1, "one message for one MessageSid");
    const m = S.json(S.keys("rec/message/")[0]);
    assert.deepEqual([m.direction, m.status, m.provider, m.body_text, m.from, m.contact_id], ["in", "received", "twilio", "Can you come Thursday?", STAFF, contact.id]);
    const conv = S.json(`rec/conversation/${CV.convIdFor(contact.id, "sms")}`);
    assert.deepEqual([conv.state, conv.unread, conv.needs_reply, conv.last_direction, conv.last_preview], ["open", 1, true, "in", "Can you come Thursday?"]);
    assert.ok(S.json("ix/inbox/open").rows[conv.id], "in the open shard");
    assert.equal(S.keys(`rel/contact-activity/${contact.id}/`).filter((k) => k.includes("--sms.in--")).length, 1);
    assert.equal(S.json(`rec/contact_stats/${contact.id}`).comms.last_inbound_at, "2026-11-17T15:00:00.000Z");
    await drain(t);
    const notes = S.keys(`rec/notification/`).map((k) => S.json(k));
    assert.ok(notes.some((n) => n.user_id === owner.id && n.kind === "reply" && /New text from/.test(n.title) && n.link === `/inbox/${conv.id}`), "the owner is told, with a link to the thread");
    assert.ok(!notes.some((n) => /Thursday/.test(n.title + n.body)), "a notification never carries the customer's words");
    assert.ok(S.keys("done/evt/").some((k) => k.endsWith("--sales")), "sales got message.inbound");
    // the badge and the inbox
    assert.equal((await t.api("/me/badges", { as: owner })).body.data.inbox_unread, 1);
    const inbox = await t.api("/inbox?filter=unread", { as: owner });
    assert.deepEqual(inbox.body.data.map((x) => x.id), [conv.id]);
    // a second text: unread 2; reading it clears the count; done closes it; the next text reopens
    await inbound(t, { Body: "Or Friday" });
    assert.equal(S.json(`rec/conversation/${conv.id}`).unread, 2);
    assert.equal((await t.api(`/conversations/${conv.id}/read`, { method: "POST", as: owner, body: {} })).body.data.unread, 0);
    assert.equal((await t.api(`/conversations/${conv.id}/done`, { method: "POST", as: owner, body: { done: true } })).body.data.state, "done");
    assert.ok(!S.keys("ix/inbox/open").length || !(S.json("ix/inbox/open").rows[conv.id] || {}).conversation?.d);
    await inbound(t, { Body: "Hello?" });
    assert.deepEqual([S.json(`rec/conversation/${conv.id}`).state, S.json(`rec/conversation/${conv.id}`).unread], ["open", 1], "a new inbound reopens a handled thread");
  } finally { t.done(); }
});

test("routing: a number nobody has becomes a new lead named after it (no cadence); a shared number goes to the most recently active contact", async () => {
  const { t } = await connected();
  try {
    const res = await inbound(t, { From: "+17635550177", Body: "Do you do gutters?" });
    assert.equal(res.status, 200);
    const S = t.stores.data;
    const lead = S.keys("rec/contact/").map((k) => S.json(k)).find((c) => (c.phones || []).some((p) => p.e164 === "+17635550177"));
    assert.ok(lead, "a contact was made");
    assert.deepEqual([lead.first_name, lead.lifecycle, lead.source.source], ["(763) 555-0177", "lead", "Inbound text"]);
    assert.equal(lead.consent.sms_marketing.state, "unknown");
    await drain(t);
    assert.equal(S.keys("rec/enrollment/").length, 0, "no follow-up cadence starts by itself (it may be a customer's new phone)");
    // two live contacts on one number: the one changed most recently
    const older = await scope(() => seedContact(61, { phones: [{ e164: "+17635550188", primary: true, sms: true }], updated_at: "2026-10-01T00:00:00.000Z", flags: { test: true } }));
    const newer = await scope(() => seedContact(62, { phones: [{ e164: "+17635550188", primary: true, sms: true }], updated_at: "2026-11-10T00:00:00.000Z", flags: { test: true } }));
    await scope(() => store.updatePointerList("phone", store.hk("phone", "+17635550188"), () => [older.id, newer.id]));
    const who = await scope(() => IN.contactForNumber("+17635550188", W()));
    assert.deepEqual([who.contact.id, who.shared, who.created], [newer.id, true, false]);
  } finally { t.done(); }
});

test("before cutover a text from a customer Rotor still owns is not recorded: a would- row, and Twilio still gets its answer", async () => {
  const { t } = await connected();
  try {
    const c = await scope(() => seedImportedContact(70, { phones: [{ e164: "+17635550170", primary: true, sms: true }] }));
    await scope(() => store.updatePointerList("phone", store.hk("phone", "+17635550170"), () => [c.id]));
    const res = await inbound(t, { From: "+17635550170", Body: "Running late?" });
    assert.equal(res.status, 200);
    assert.equal(res.text, "<Response/>");
    assert.equal(t.stores.data.keys("rec/message/").length, 0);
    assert.equal(t.stores.data.keys("rec/conversation/").length, 0);
    assert.ok(t.stores.data.keys("alog/").some((k) => k.includes("would-record-message")), "the automation log says what it would have done");
  } finally { t.done(); }
});

test("media: the webhook answers before any media fetch; a media.fetch item stores the files; HTML or SVG media is stored download-only", async () => {
  const { t, owner } = await connected();
  const net = mockFetch([
    { match: "api.twilio.com/2010-04-01/Accounts/" + SID + "/Messages/MM1/Media/ME1", respond: () => new Response(JPEG, { status: 200, headers: { "content-type": "image/jpeg" } }) },
    { match: "/Media/ME2", respond: () => new Response("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>", { status: 200, headers: { "content-type": "image/svg+xml" } }) },
    { match: "/Media/ME3", respond: () => new Response("<!doctype html><html><body>hi</body></html>", { status: 200, headers: { "content-type": "text/html" } }) },
  ]);
  try {
    const contact = await staffContact();
    const base = `https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages/MM1/Media`;
    const res = await inbound(t, { Body: "Photos of the gutter", NumMedia: "4", MediaUrl0: `${base}/ME1`, MediaContentType0: "image/jpeg", MediaUrl1: `${base}/ME2`, MediaContentType1: "image/svg+xml", MediaUrl2: `${base}/ME3`, MediaContentType2: "text/html", MediaUrl3: "https://evil.example/x.jpg" });
    assert.equal(res.status, 200);
    assert.equal(net.calls.length, 0, "the answer went back before any media was fetched");
    const S = t.stores.data;
    const id = S.keys("rec/message/")[0].split("/").pop();
    assert.equal(S.json(`rec/message/${id}`).media_pending, 4);
    assert.equal(S.keys("rec/file/").length, 0);
    await drain(t);
    const m = S.json(`rec/message/${id}`);
    assert.equal(m.media_pending, 0);
    assert.equal(m.attachment_file_ids.length, 3, "the three Twilio files; another host is never fetched");
    assert.ok(net.calls.every((c) => new URL(c.url).hostname === "api.twilio.com"), "only Twilio's media host");
    assert.ok(net.calls.every((c) => /^Basic /.test(c.headers.authorization)), "with the account's Basic auth");
    const files = m.attachment_file_ids.map((f) => S.json(`rec/file/${f}`));
    assert.deepEqual(files.map((f) => !!f.download_only), [false, true, true], "the JPEG shows; SVG and HTML are download-only");
    assert.ok(files.every((f) => f.owner.type === "message" && f.owner.id === id && f.contact_id === contact.id));
    // served as a download, never as a page
    const svg = await t.api(`/files/${files[1].id}`, { as: owner });
    assert.equal(svg.status, 200);
    assert.match(svg.headers.get("content-disposition") || "", /attachment/);
    assert.equal(svg.headers.get("content-type"), "application/octet-stream");
    assert.equal(svg.headers.get("x-content-type-options"), "nosniff");
    const thread = await t.api(`/conversations/${m.conversation_id}`, { as: owner });
    assert.equal(thread.body.data.messages[0].attachment_file_ids.length, 3);
  } finally { net.restore(); t.done(); }
});
