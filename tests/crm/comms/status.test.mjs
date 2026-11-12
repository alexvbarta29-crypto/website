// Comms: Twilio status callbacks (design §6.3, §5.7.1 "Status is monotonic"; §11.4 M6
// status.test): out-of-order callbacks, no inbox write, the carrier's 21610.
import { test } from "node:test";
import assert from "node:assert/strict";
import { connected, staffContact, inbound, statusCb, mockFetch, drain, writes, store, scope, seedContact, CV, TW, SID, TOKEN, STAFF, TEST_FROM, PROD_ENV, W, twilioForm } from "./fixtures.mjs";
import { crmTest } from "../../helpers/crm-http.mjs";
import { seedImportedContact } from "../../helpers/crm-fixtures.mjs";

const IN = await import("../../../netlify/lib/crm/modules/comms/inbound.mjs");
const hk = (p) => store.hk("phone", p);
const sup = (t, p) => t.stores.data.keys(`sup/sms/${hk(p)}`).length === 1 && t.stores.data.json(`sup/sms/${hk(p)}`).state === "opted_out";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, ...Array(64).fill(7)]);

test("status callbacks: delivered before sent keeps delivered; a callback never writes ix/inbox; 21610 opts the number out", async () => {
  const { t, owner } = await connected();
  const sid = "SM" + "7".repeat(32);
  const net = mockFetch([{ match: "api.twilio.com", respond: () => Response.json({ sid, status: "queued" }, { status: 201 }) }]);
  try {
    const contact = await staffContact();
    const sent = await t.api("/messages", { method: "POST", as: owner, body: { contact_id: contact.id, channel: "sms", body: "On our way!" } });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.data.mode, "test");
    const id = sent.body.data.message_id;
    assert.ok(id, "a real send comes back with its message");
    const S = t.stores.data;
    assert.equal(S.json(`rec/message/${id}`).status, "queued");
    const mark = S.calls.length;
    assert.equal((await statusCb(t, { MessageSid: sid, MessageStatus: "delivered", To: STAFF })).status, 200);
    assert.equal(S.json(`rec/message/${id}`).status, "delivered");
    assert.ok(S.json(`rec/message/${id}`).delivered_at);
    assert.equal((await statusCb(t, { MessageSid: sid, MessageStatus: "sent", To: STAFF })).status, 200);
    assert.equal(S.json(`rec/message/${id}`).status, "delivered", "a late 'sent' never moves it back");
    await statusCb(t, { MessageSid: sid, MessageStatus: "failed", ErrorCode: "30007", To: STAFF });
    assert.equal(S.json(`rec/message/${id}`).status, "delivered", "the first terminal status wins");
    assert.deepEqual(writes(S.calls.slice(mark), /^ix\/inbox|^rec\/conversation\//), [], "no inbox or conversation write from a status callback");
    assert.equal((await statusCb(t, { MessageSid: sid, MessageStatus: "delivered" }, { token: "wrong" })).status, 403, "a bad signature");
    assert.equal((await statusCb(t, { MessageSid: "SM" + "4".repeat(32), MessageStatus: "delivered" })).status, 200, "an unknown message is answered and ignored");
    // the carrier says unsubscribed
    await statusCb(t, { MessageSid: sid, MessageStatus: "undelivered", ErrorCode: "21610", To: STAFF });
    assert.equal(sup(t, STAFF), true);
  } finally { net.restore(); t.done(); }
});
