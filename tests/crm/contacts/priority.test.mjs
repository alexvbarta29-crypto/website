// A lead's priority (the owner, Nov 2026: "copy Rotor"): Low, Medium or High
// on the contact, set from the editor and the lead page's "...", cleared
// with null, refused when it is anything else; it rides on the contacts
// index (pr) for the Leads list's pill and filter; a Rotor lead's own
// priority comes with the import (set once, never undone by a later run).
import { test } from "node:test";
import assert from "node:assert/strict";
import { crmTest } from "../../helpers/crm-http.mjs";

const T = await import("../../../netlify/lib/crm/modules/contacts/types.mjs");
const IR = await import("../../../netlify/lib/crm/modules/contacts/import-rotor.mjs");

test("the record: low, medium or high; none is none; an unknown stored value is kept", () => {
  assert.deepEqual(T.PRIORITIES, ["low", "medium", "high"]);
  const base = T.contactType.example();
  assert.equal(T.validateContact({ ...base, priority: "high" }, { op: "create" }).priority, "high");
  assert.equal("priority" in T.validateContact({ ...base, priority: null }, { op: "create" }), false);
  assert.throws(() => T.validateContact({ ...base, priority: "urgent" }, { op: "create" }), /choices/);
  assert.equal(T.validateContact({ ...base, priority: "urgent" }, { op: "update", before: base }).priority, "urgent", "kept as stored");
  assert.equal(T.contactRow({ ...base, priority: "medium" }).pr, "medium");
  assert.equal("pr" in T.contactRow(base), false, "no priority, no key: the index stays small");
});

test("Rotor's priority on import: its own value, high keeps its tag too", () => {
  assert.equal(IR.priorityOf({ priority: "high" }), "high");
  assert.equal(IR.priorityOf({ priority: "medium" }), "medium");
  assert.equal(IR.priorityOf({ priority: "urgent" }), null);
  assert.equal(IR.priorityOf({}), null);
});

test("PATCH /contacts/:id { priority }: set, cleared with null, refused when unknown; on the index", async () => {
  const t = await crmTest();
  try {
    const owner = await t.user("owner");
    const r = await t.api("/contacts", { method: "POST", as: owner, body: { first_name: "Pat", last_name: "Priority", phone: "7635550177", priority: "medium" } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const c = r.body.data.contact;
    assert.equal(c.priority, "medium", "a new lead may start with one");
    let etag = r.headers.get("etag");
    let p = await t.api(`/contacts/${c.id}`, { method: "PATCH", as: owner, ifMatch: etag, body: { priority: "high" } });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(p.body.data.contact.priority, "high");
    const ix = await t.api("/contacts/index", { as: owner });
    assert.equal(ix.body.data.rows.find((x) => x.id === c.id).pr, "high");
    etag = p.headers.get("etag");
    assert.equal((await t.api(`/contacts/${c.id}`, { method: "PATCH", as: owner, ifMatch: etag, body: { priority: "urgent" } })).status, 400);
    p = await t.api(`/contacts/${c.id}`, { method: "PATCH", as: owner, ifMatch: etag, body: { priority: null } });
    assert.equal(p.status, 200);
    assert.equal(p.body.data.contact.priority, undefined, "cleared");
  } finally { t.done(); }
});
