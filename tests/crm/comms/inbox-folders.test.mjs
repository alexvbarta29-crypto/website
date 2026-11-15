// Comms: the Rotor guide's Inbox (guide-gaps §2.3, §4 S5a/b/c, S6, §7.4
// S46a): team inboxes with counts, one row per person, the channel filter,
// texts + email + notes as one timeline, internal notes (never sent, never a
// reply, never a tech's), the business number a text goes from and files
// on a dry-run send. Synthetic people only; nothing leaves the site.
import { test } from "node:test";
import assert from "node:assert/strict";
import { crmTest } from "../../helpers/crm-http.mjs";
import { store, scope, seedContact, CV, W, connected, staffContact, mockFetch } from "./fixtures.mjs";

const I = await import("../../../netlify/lib/crm/modules/comms/inboxes.mjs");
const ids = await import("../../../netlify/lib/crm/core/ids.mjs");

const inbound = (c, channel, body, owner, at) => scope(() => CV.recordMessage({
  contact: c, channel, direction: "in", from: channel === "sms" ? c.phones[0].e164 : "pat@example.com", to: "+17635550111", body_text: body, status: "received",
  provider: channel === "sms" ? "twilio" : "postmark", provider_id: (channel === "sms" ? "SM" : "PM") + c.id.slice(-10) + body.length + "0".repeat(18), origin: { kind: "inbound" }, ...(at ? { sent_at: at } : {}),
}, W(owner.id)));

test("settings: team inboxes, business numbers and the text price are validated", () => {
  const v = I.validateInboxes({ list: [{ name: "Sales  team", member_ids: [], match: { lifecycle: "lead" } }, { name: "Service", match: { channel: "email" } }] });
  assert.deepEqual(v.list.map((x) => [x.key, x.name, x.match]), [["sales-team", "Sales team", { lifecycle: ["lead"] }], ["service", "Service", { channel: "email" }]]);
  assert.throws(() => I.validateInboxes({ list: [{ name: "Mine" }, { name: "mine" }] }), /taken/);
  assert.throws(() => I.validateInboxes({ list: [{ name: "x", key: "all" }] }), /taken/);
  assert.throws(() => I.validateInboxes({ list: [{ name: "x", match: { lifecycle: "vendor" } }] }));
  assert.throws(() => I.validateInboxes({ list: Array.from({ length: 11 }, (_, i) => ({ name: "n" + i })) }), /Up to 10/);
  assert.throws(() => I.validateInboxes({ list: [{ name: "<b>".repeat(20) }] }), /short name/);
  const e = I.validateEngagement({ numbers: [{ e164: "(763) 555-0101", label: "Main", default_for: ["inbox", "automations"] }, { e164: "7635550102", label: "Sales", default_for: ["inbox", "dialer"] }], email_from: "office@example.com" });
  assert.deepEqual(e.numbers.map((n) => [n.e164, n.default_for]), [["+17635550101", ["inbox", "automations"]], ["+17635550102", ["dialer"]]], "one default per use");
  assert.equal(I.defaultNumber(e, "dialer").e164, "+17635550102");
  assert.throws(() => I.validateEngagement({ numbers: [{ e164: "555" }] }), /US number/);
  assert.throws(() => I.validateEngagement({ numbers: [{ e164: "7635550101" }, { e164: "+17635550101" }] }), /twice/);
  assert.throws(() => I.validateEngagement({ email_from: "nope" }), /email/);
  assert.deepEqual(I.validateSmsPricing({}), { per_segment_cents: 0.83, mms_cents: 2.2 });
  assert.throws(() => I.validateSmsPricing({ per_segment_cents: -1 }));
});

test("the inbox: folders with counts, one row per person, a team inbox by its rule or a move, the channel filter", async () => {
  const t = await crmTest({ now: "2026-11-17T15:00:00Z" });
  try {
    const owner = await t.user("owner");
    const admin = await t.user("admin");
    const lead = await scope(() => seedContact(31, { lifecycle: "lead", emails: [{ address: "pat31@example.com", primary: true }] }));
    const cust = await scope(() => seedContact(32, { lifecycle: "customer" }));
    await inbound(lead, "sms", "Is Tuesday open?", owner, "2026-11-17T14:00:00.000Z");
    const le = await inbound(lead, "email", "Photos of the house attached", owner, "2026-11-17T14:30:00.000Z");
    const cs = await inbound(cust, "sms", "Thanks, all done", owner, "2026-11-17T13:00:00.000Z");
    assert.equal((await t.api("/settings/inboxes", { method: "PUT", as: owner, ifMatch: "new", body: { list: [{ name: "Sales", member_ids: [admin.id], match: { lifecycle: "lead" } }, { name: "Service" }] } })).status, 200);
    // one row per person: the lead's text and email are one row, unread summed, both channels named
    const all = (await t.api("/inbox?group=contact", { as: owner })).body;
    assert.deepEqual(all.data.map((x) => [x.contact_id, x.unread, (x.channels || []).sort().join("+"), x.inbox]), [[lead.id, 2, "email+sms", "sales"], [cust.id, 1, "sms", null]]);
    assert.deepEqual(all.meta.inboxes, [{ key: "sales", name: "Sales" }, { key: "service", name: "Service" }]);
    assert.equal((await t.api("/inbox", { as: owner })).body.data.length, 3, "ungrouped: one row per thread, as before");
    // the channel filter, and a team inbox by its rule
    assert.deepEqual((await t.api("/inbox?group=contact&channel=email", { as: owner })).body.data.map((x) => x.contact_id), [lead.id]);
    assert.deepEqual((await t.api("/inbox?group=contact&inbox=sales", { as: owner })).body.data.map((x) => x.contact_id), [lead.id]);
    assert.equal((await t.api("/inbox?inbox=nope", { as: owner })).status, 400);
    assert.equal((await t.api("/inbox?channel=fax", { as: owner })).status, 400);
    // the folder counts (open threads, a person once)
    let c = (await t.api("/inbox/counts", { as: owner })).body.data;
    assert.deepEqual([c.all, c.mine, c.unread, c.needs_reply, c.inboxes], [2, 0, 2, 2, { sales: 1, service: 0 }]);
    assert.deepEqual(c.list.map((x) => [x.key, x.count, x.member]), [["sales", 1, false], ["service", 0, false]]);
    assert.equal((await t.api("/inbox/counts", { as: admin })).body.data.list[0].member, true, "the admin is on Sales");
    // a move overrides the rule; null puts it back
    const mv = await t.api(`/conversations/${cs.conversation.id}/move`, { method: "POST", as: owner, body: { inbox: "service" } });
    assert.equal(mv.status, 200);
    assert.equal(mv.body.data.inbox, "service");
    assert.equal((await t.api(`/conversations/${cs.conversation.id}/move`, { method: "POST", as: owner, body: { inbox: "nope" } })).status, 400);
    c = (await t.api("/inbox/counts", { as: owner })).body.data;
    assert.deepEqual(c.inboxes, { sales: 1, service: 1 });
    await t.api(`/conversations/${le.conversation.id}/assign`, { method: "POST", as: owner, body: { user_id: owner.id } });
    assert.equal((await t.api("/inbox/counts", { as: owner })).body.data.mine, 1);
    await t.api(`/conversations/${cs.conversation.id}/move`, { method: "POST", as: owner, body: { inbox: null } });
    assert.deepEqual((await t.api("/inbox/counts", { as: owner })).body.data.inboxes, { sales: 1, service: 0 });
    // a technician: no team inboxes, no moves
    const tech = await t.user("tech");
    assert.equal((await t.api(`/conversations/${cs.conversation.id}/move`, { method: "POST", as: tech, body: { inbox: "service" } })).status, 403);
    const tc = await t.api("/inbox/counts", { as: tech });
    assert.equal(tc.status, 200);
    assert.deepEqual([tc.body.data.all, tc.body.data.list], [0, []], "a tech's window is empty here");
  } finally { t.done(); }
});

test("one timeline: texts, email and notes together; a note is never sent, never a reply, never a technician's", async () => {
  const t = await crmTest({ now: "2026-11-17T15:00:00Z" });
  try {
    const owner = await t.user("owner");
    const c = await scope(() => seedContact(41, { lifecycle: "customer" }));
    await inbound(c, "sms", "Can you do gutters too?", owner, "2026-11-17T14:00:00.000Z");
    await inbound(c, "email", "Here is the gate code", owner, "2026-11-17T14:10:00.000Z");
    const before = t.stores.data.json(`rec/conversation/${CV.convIdFor(c.id, "email")}`);
    const n = await t.api(`/inbox/contact/${c.id}/notes`, { method: "POST", as: owner, body: { body: "Wants a gutter quote with the spring visit." } });
    assert.equal(n.status, 201);
    assert.deepEqual([n.body.data.message.kind, n.body.data.message.status, n.body.data.message.provider], ["note", "note", "internal"]);
    assert.equal((await t.api(`/inbox/contact/${c.id}/notes`, { method: "POST", as: owner, body: { body: "  " } })).status, 400);
    assert.equal(n.body.data.conversation_id, before.id, "on the newest thread");
    const after = t.stores.data.json(`rec/conversation/${n.body.data.conversation_id}`);
    assert.deepEqual([after.unread, after.needs_reply, after.last_preview], [before.unread, before.needs_reply, before.last_preview], "a note changes nothing about the thread");
    assert.equal(t.stores.data.keys("rec/outbox/").length, 0, "nothing sent, not even a dry run");
    assert.equal(t.fetchCalls().length, 0);
    const th = (await t.api(`/inbox/contact/${c.id}?channel=all`, { as: owner })).body.data;
    assert.equal(th.channel, "all");
    assert.deepEqual(th.messages.map((m) => [m.channel, m.kind || m.direction]), [["email", "note"], ["email", "in"], ["sms", "in"]], "newest first, both channels and the note");
    assert.ok(th.channels.sms && th.channels.email, "what each channel can do");
    // paging: one cursor across the channels
    const p1 = (await t.api(`/inbox/contact/${c.id}?channel=all`, { as: owner })).body.data;
    assert.equal(p1.next, null);
    // a technician on their visit: the thread, never the note; and no notes of their own
    const tech = await t.user("tech");
    const vid = ids.newId("visit");
    await store.settledWrite(`rec/visit/${vid}`, { id: vid, type: "visit", v: 1, wv: 1, contact_id: c.id, assignee_ids: [tech.id], date: "2026-11-18", status: "scheduled", created_at: "2026-11-17T15:00:00.000Z" }, { onlyIfNew: true });
    await scope(() => store.addRel("tech-visits", tech.id, "2026-11-18", vid));
    const tt = await t.api(`/inbox/contact/${c.id}?channel=all`, { as: tech });
    assert.equal(tt.status, 200);
    assert.ok(!tt.text.includes("gutter quote"), "the note stays the office's");
    assert.equal(tt.body.data.messages.length, 2);
    const ts = await t.api(`/conversations/${n.body.data.conversation_id}`, { as: tech });
    assert.ok(!ts.text.includes("gutter quote"));
    assert.equal((await t.api(`/inbox/contact/${c.id}/notes`, { method: "POST", as: tech, body: { body: "hi" } })).status, 403);
  } finally { t.done(); }
});

test("a send from a business number and with a file: both on the Outbox item while texting is a dry run; checked first", async () => {
  const t = await crmTest({ now: "2026-11-17T15:00:00Z" });
  try {
    const owner = await t.user("owner");
    const c = await scope(() => seedContact(51, { lifecycle: "customer", consent: { sms_service: { state: "granted" } } }));
    const other = await scope(() => seedContact(52, { lifecycle: "customer" }));
    assert.equal((await t.api("/settings/engagement", { method: "PUT", as: owner, ifMatch: "new", body: { numbers: [{ e164: "+17635550101", label: "Main" }, { e164: "+17635550102", label: "Sales" }] } })).status, 200);
    const bad = await t.api("/messages", { method: "POST", as: owner, body: { contact_id: c.id, channel: "sms", body: "Hi", from_number: "+17635550199" } });
    assert.equal(bad.status, 400);
    const ok = await t.api("/messages", { method: "POST", as: owner, body: { contact_id: c.id, channel: "sms", body: "Hi from sales", from_number: "+17635550102", client_id: "client-0101" } });
    assert.equal(ok.body.data.status, "dry_run");
    const ob = t.stores.data.json(`rec/outbox/${ok.body.data.outbox_id}`);
    assert.equal(ob.related.from_number, "+17635550102");
    // a file on the person's conversation (the paperclip): it rides on the dry-run item
    await inbound(c, "sms", "Send me the quote picture", owner);
    const conv = CV.convIdFor(c.id, "sms");
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a00000000049454e44ae426082", "hex");
    const up = await t.api(`/files?owner_type=conversation&owner_id=${conv}&kind=attachment`, { method: "POST", as: owner, raw: png, headers: { "content-type": "image/png" } });
    assert.equal(up.status, 201, up.text);
    const fid = up.body.data.file.id;
    const sent = await t.api("/messages", { method: "POST", as: owner, body: { contact_id: c.id, channel: "sms", body: "Here it is", files: [fid], client_id: "client-0102" } });
    assert.equal(sent.body.data.status, "dry_run");
    assert.deepEqual(t.stores.data.json(`rec/outbox/${sent.body.data.outbox_id}`).related.files.map((f) => [f.id, f.ct]), [[fid, "image/png"]]);
    assert.equal((await t.api("/messages", { method: "POST", as: owner, body: { contact_id: other.id, channel: "sms", body: "x", files: [fid] } })).status, 400, "someone else's file");
    assert.equal((await t.api("/messages", { method: "POST", as: owner, body: { contact_id: c.id, channel: "sms", body: "x", files: [fid, fid, fid, fid] } })).status, 400, "three at most");
    assert.equal(t.fetchCalls().length, 0, "nothing left the site");
  } finally { t.done(); }
});

test("live (after the switch): the text goes from the business number the person picked; test mode keeps its test number", async () => {
  const { t, owner } = await connected({ sms: { mode: "live", from: "+17635550112" } });
  const net = mockFetch([{ match: "api.twilio.com", respond: () => Response.json({ sid: "SM" + "b".repeat(32), status: "queued" }, { status: 201 }) }]);
  try {
    await store.settledWrite("sys/mode", { system_of_record: "crm", paused: false, cutover_at: "2026-11-16T12:00:00.000Z" }, { onlyIfNew: true });
    const staff = await staffContact();
    assert.equal((await t.api("/settings/engagement", { method: "PUT", as: owner, ifMatch: "new", body: { numbers: [{ e164: "+17635550112", label: "Main" }, { e164: "+17635550113", label: "Sales" }] } })).status, 200);
    const r = await t.api("/messages", { method: "POST", as: owner, body: { contact_id: staff.id, channel: "sms", body: "From the sales line", from_number: "+17635550113", client_id: "client-0201" } });
    assert.equal(r.status, 200, r.text);
    assert.equal(net.calls.length, 1);
    assert.equal(new URLSearchParams(net.calls[0].body).get("From"), "+17635550113");
  } finally { net.restore(); t.done(); }
});

test("muted contacts: from the contacts list's `mu` once it carries it; archived people left out", async () => {
  const { mutedOf } = await import("../../../netlify/lib/crm/modules/comms/setup.mjs");
  assert.deepEqual(mutedOf([{ id: "ct_a", n: "Pat", lc: "customer" }]), { indexed: false, list: [] }, "before the Customers update: not indexed");
  const out = mutedOf([{ id: "ct_b", n: "Sam", c: "Delano", lc: "customer", mu: ["sms"] }, { id: "ct_a", n: "Ann", lc: "lead", mu: { sms: true, email: true } }, { id: "ct_c", n: "Zed", lc: "archived", mu: ["sms"] }, { id: "ct_d", n: "Kim", lc: "customer", mu: null }]);
  assert.equal(out.indexed, true);
  assert.deepEqual(out.list.map((x) => [x.name, x.channels]), [["Ann", ["sms", "email"]], ["Sam", ["sms"]]]);
  const t = await crmTest({});
  try {
    const owner = await t.user("owner");
    const r = await t.api("/comms/muted", { as: owner });
    assert.equal(r.status, 200);
    assert.equal((await t.api("/comms/muted", { as: await t.user("tech") })).status, 403);
  } finally { t.done(); }
});
