// Comms: unsubscribe (design §5.7.1, §8.1, RFC 8058; §11.4 M6
// unsubscribe.test): a GET changes nothing (mail scanners and link previews
// open links); only the POST suppresses, and marketing then stops.
import { test } from "node:test";
import assert from "node:assert/strict";
import { crmTest } from "../../helpers/crm-http.mjs";
import { store, scope, seedContact, W } from "./fixtures.mjs";

const P = await import("../../../netlify/lib/crm/portal/core.mjs");

test("unsubscribe: GET changes nothing; POST suppresses; marketing email to that address is then held back", async () => {
  const t = await crmTest({});
  try {
    const owner = await t.user("owner");
    const c = await scope(() => seedContact(31));
    const address = c.emails[0].address;
    const key = `sup/email/${store.hk("email", address)}`;
    const u = await scope(() => P.unsubscribeLink({ contact_id: c.id, channel: "email", address }));
    await store.createRecord("template", { key: "fall_email", name: "Fall email", channel: "email", category: "marketing", subject: "Fall", body: "Hi {{first_name|there}}, fall cleanings are open.", tags: [], active: true }, W(owner.id));
    const send = () => t.api("/messages", { method: "POST", as: owner, body: { contact_id: c.id, channel: "email", template_key: "fall_email" } });
    assert.equal((await send()).body.data.status, "dry_run", "before: it would go out (dry run)");

    const mark = t.stores.data.calls.length;
    for (let i = 0; i < 3; i++) {
      const page = await t.portal(`/p/unsubscribe/${u.code}`);
      assert.equal(page.status, 200);
      assert.equal((await t.portal(`/api/portal/unsubscribe/${u.code}`)).status >= 400, true, "the one-click address takes no GET");
    }
    assert.equal(t.stores.data.keys(key).length, 0, "three GETs (a scanner, a preview, a person) suppressed nothing");
    assert.deepEqual(t.stores.data.calls.slice(mark).filter((x) => ["set", "setJSON", "delete"].includes(x.op) && /^(sup|rec\/contact)\//.test(x.key || "")), []);

    const one = await t.portal(`/api/portal/unsubscribe/${u.code}`, { method: "POST", raw: "List-Unsubscribe=One-Click", headers: { "content-type": "application/x-www-form-urlencoded" } });
    assert.equal(one.status, 200);
    assert.equal(t.stores.data.json(key).state, "opted_out");
    const after = await send();
    assert.deepEqual([after.body.data.status, after.body.data.blocked_reason], ["blocked", "opted_out"]);
    assert.equal(t.fetchCalls().length, 0);
  } finally { t.done(); }
});
