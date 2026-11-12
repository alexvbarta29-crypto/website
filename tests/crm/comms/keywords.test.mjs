// Comms: inbound keywords (design §6.3 "Keywords", §5.7.1; §11.4 M6 keywords.test): the STOP
// family, START, HELP with one responder, YES never an opt-in, the owner's reply keywords.
import { test } from "node:test";
import assert from "node:assert/strict";
import { connected, staffContact, inbound, statusCb, mockFetch, drain, writes, store, scope, seedContact, CV, TW, SID, TOKEN, STAFF, TEST_FROM, PROD_ENV, W, twilioForm } from "./fixtures.mjs";
import { crmTest } from "../../helpers/crm-http.mjs";
import { seedImportedContact } from "../../helpers/crm-fixtures.mjs";

const IN = await import("../../../netlify/lib/crm/modules/comms/inbound.mjs");
const hk = (p) => store.hk("phone", p);
const sup = (t, p) => t.stores.data.keys(`sup/sms/${hk(p)}`).length === 1 && t.stores.data.json(`sup/sms/${hk(p)}`).state === "opted_out";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, ...Array(64).fill(7)]);

test("keywords: the STOP family opts out, START opts back in, HELP sends nothing with Advanced Opt-Out on and help_reply with it off; YES is not an opt-in", async () => {
  const { t, owner } = await connected();
  const net = mockFetch([{ match: "api.twilio.com", respond: () => Response.json({ sid: "SM" + "9".repeat(32), status: "queued" }, { status: 201 }) }]);
  try {
    const contact = await staffContact();
    assert.equal(IN.keywordOf(" stop ").kind, "stop");
    for (const w of ["STOP", "StopAll", "unsubscribe", "CANCEL", "End", "QUIT", "optout", "Revoke"]) assert.equal(IN.keywordOf(w).kind, "stop", w);
    for (const w of ["Stop by tomorrow?", "please stop", "YES", "yes please", "START NOW", ""]) assert.equal(IN.keywordOf(w), null, `"${w}" is not a keyword`);
    assert.equal(IN.keywordOf("unstop").kind, "start");
    assert.equal(IN.keywordOf("Info").kind, "help");

    // not a STOP: nothing is suppressed
    await inbound(t, { Body: "Stop by tomorrow?" });
    assert.equal(sup(t, STAFF), false);
    // YES: recorded as a reply, never as marketing consent
    await inbound(t, { Body: "YES" });
    assert.equal(t.stores.data.json(`rec/contact/${contact.id}`).consent.sms_marketing.state, "unknown", "YES is not an opt-in");
    // STOP: suppressed at once; sales and the review sequence hear consent.changed
    await inbound(t, { Body: "Stop" });
    assert.equal(sup(t, STAFF), true);
    assert.equal(t.stores.data.json(`sup/sms/${store.hk("phone", STAFF)}`).keyword, "stop");
    const blocked = await t.api("/messages", { method: "POST", as: owner, body: { contact_id: contact.id, channel: "sms", body: "Are you there?" } });
    assert.deepEqual([blocked.body.data.status, blocked.body.data.blocked_reason], ["blocked", "opted_out"], "the sender honours it");
    assert.equal(net.calls.length, 0);
    await drain(t);
    assert.ok(t.stores.data.keys("done/evt/").filter((k) => k.endsWith("--sales")).length >= 2, "sales heard the opt-out");
    // START: back in
    await inbound(t, { Body: "START" });
    assert.equal(sup(t, STAFF), false);
    // HELP with Advanced Opt-Out on (the default): Twilio answers, the CRM only records the word
    await inbound(t, { Body: "HELP" });
    assert.equal(net.calls.length, 0, "the CRM sends nothing");
    const msgs = () => t.stores.data.keys("rec/message/").map((k) => t.stores.data.json(k));
    assert.ok(msgs().some((m) => m.keyword === "HELP" && m.direction === "in"));
    // ... and off: the CRM answers with help_reply (to the staff test phone, from the test number)
    const cur = await store.getSettingWithEtag("integrations");
    await store.putSetting("integrations", { ...cur.data, sms: { ...cur.data.sms, advanced_opt_out: false } }, { ...W(owner.id), ifMatch: cur.etag });
    await inbound(t, { Body: "help" });
    assert.equal(net.calls.length, 1, "one answer");
    const sent = new URLSearchParams(net.calls[0].body);
    assert.equal(sent.get("To"), STAFF);
    assert.equal(sent.get("From"), TEST_FROM);
    assert.match(sent.get("Body"), /Barta Window Washing: call \(763\) 314-3400 or email office@bartawindowwashing\.com/);
    assert.ok(msgs().some((m) => m.direction === "out" && /Msg & data rates/.test(m.body_text)), "the answer is in the thread");
  } finally { net.restore(); t.done(); }
});

test("reply keywords (off until the owner names them): a tag and a note to ask before recording consent", async () => {
  const { t, owner } = await connected();
  try {
    const contact = await staffContact();
    await inbound(t, { Body: "LIGHTS" });
    assert.deepEqual(t.stores.data.json(`rec/contact/${contact.id}`).tags, [], "off by default");
    const cur = await store.getSettingWithEtag("comms");
    await store.putSetting("comms", { reply_keywords: { enabled: true, words: [{ word: "YES", tag: "Replied YES", task: true }, { word: "LIGHTS", tag: "Wants lights", task: true }] } }, { ...W(owner.id), ifMatch: cur.etag || "new" });
    await inbound(t, { Body: "lights" });
    assert.deepEqual(t.stores.data.json(`rec/contact/${contact.id}`).tags, ["Wants lights"]);
    await inbound(t, { Body: " Yes " });
    const c = t.stores.data.json(`rec/contact/${contact.id}`);
    assert.deepEqual(c.tags, ["Wants lights", "Replied YES"]);
    assert.equal(c.consent.sms_marketing.state, "unknown", "consent is a person's decision");
    await drain(t);
    const notes = t.stores.data.keys("rec/notification/").map((k) => t.stores.data.json(k));
    assert.ok(notes.some((n) => /replied YES/.test(n.title) && /Ask before you record marketing consent/.test(n.body)));
  } finally { t.done(); }
});
