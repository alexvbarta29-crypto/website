// M2a acceptance: no personal data in keys (design §11.4 "keys.test.mjs", §3.2).
// A fixture run through everything the contacts module writes (intake, the
// lead webhook, the API, a merge, the import phases), then every key of
// every store is checked for the fixtures' phone digits and emails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { crmTest } from "../../helpers/crm-http.mjs";
import { advance, minutes } from "../../helpers/crm-clock.mjs";
import { store, intake, lead } from "./fixtures.mjs";

const imp = await import("../../../netlify/lib/crm/modules/contacts/import-rotor.mjs");

test("after a fixture run, no key in the store contains phone digits or an email", async () => {
  const t = await crmTest();
  globalThis.__crmSleepScale = 0.01;
  const phones = [];
  const emails = [];
  const p = (n) => { const d = `763555${String(n).padStart(4, "0")}`; phones.push(d); return d; };
  const e = (s) => { emails.push(s); return s; };
  try {
    const owner = await t.user("owner");
    const tech = await t.user("tech");
    for (let n = 60; n < 66; n++) {
      p(100 + n); e(`pat.example${n}@example.com`);
      await intake.intakeLead({ ...lead(n), phone: phones[phones.length - 1], email: emails[emails.length - 1] }, { origin: "lead-form", rotor: n % 2 ? { lead_id: `rl-${n}` } : null });
    }
    await intake.intakeLead({ name: "Jordan Testcase", phone: p(201), email: e("jordan.testcase@example.com"), provider_lead_id: "880000000000009", source: { source: "Meta Ads" } }, { origin: "webhook" });
    const made = await t.api("/contacts", { method: "POST", as: owner, body: { first_name: "Office", last_name: "Made", phone: p(202), email: e("office.made@example.com"), address: { street1: "202 Example Ave", city: "Delano", state: "MN", zip: "55328" } } });
    assert.equal(made.status, 201);
    await t.api("/contacts", { method: "POST", as: tech, body: { name: "Quick Lead", phone: phones[0] } });
    const tok = await t.api("/intake/webhook-tokens", { method: "POST", as: owner, body: { label: "Zapier" } });
    const hookRes = await t.api(`/hooks/lead/${tok.body.data.token}`, { method: "POST", csrf: false, body: { full_name: "Hook Person", phone_number: p(203), email: e("hook.person@example.com"), id: "880000000000010", form_name: "Sample Form" } });
    assert.equal(hookRes.status, 200, JSON.stringify(hookRes.body));
    // a merge of two of them
    const ids = t.stores.data.keys("rec/contact/").map((k) => k.split("/").pop());
    const m = await t.api(`/contacts/${ids[0]}/merge`, { method: "POST", as: owner, body: { other_id: ids[1] } });
    for (let i = 0; i < 4; i++) { await t.runWorker({ lane: "bulk" }); advance(minutes(2)); }
    assert.equal(m.status, 202);
    // the import phases and their extras
    const ctx = { lookup: async () => null };
    const cust = imp.normalizePerson({ id: "00000000-0000-4000-8000-000000000001", first_name: "Imported", last_name: "Person", phone: p(204), email: e("imported.person@example.com"), status: "active", source: "Website", tags: [], notes: "", address: { street1: "1 Example Ave", city: "Delano", state: "MN", zip: "55328" }, created_at: "2025-01-02T00:00:00Z" });
    const out = await imp.phases.find((x) => x.name === "contacts.customers").map(cust, ctx);
    for (const r of out.records) await store.createRecord(r.type, r.data, { by: "import", origin: "import", actor_kind: "import", requestId: "t" });
    const stop = await imp.phases.find((x) => x.name === "contacts.suppressions").map(imp.normalizeMessage({ id: "m1", direction: "inbound", channel: "sms", body: "STOP", from_number: phones[2] }), ctx);
    await imp.applyExtras(stop, { by: "import", origin: "import", actor_kind: "import" });

    const keys = [...t.stores.data.keys(""), ...t.stores.files.keys(""), ...t.stores.backups.keys("")];
    assert.ok(keys.length > 50, `a real run (${keys.length} keys)`);
    for (const k of keys) {
      for (const d of phones) {
        assert.ok(!k.includes(d) && !k.includes(d.slice(3)), `a key holds phone digits: ${k.replace(/\d{7,}/g, "#")}`);
      }
      assert.ok(!k.includes("example.com"), "a key holds an email domain");
      for (const em of emails) assert.ok(!k.includes(em.split("@")[0]), "a key holds an email's name part");
    }
  } finally {
    delete globalThis.__crmSleepScale;
    t.done();
  }
});
