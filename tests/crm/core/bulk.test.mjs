// Bulk runs (design §5.7.4 "Bulk sends", §5.7.5; M1.3 review): the send
// reaches exactly the people the preview counted (archived, test, vendor
// and spam contacts, and a second contact on one address, stay out); the
// test send covers what is sent (a template changed after the test sends
// the run back to "ready", and the send renders the tested version); a
// write that failed half way never leaves a run stuck (test, confirm,
// preview). Synthetic contacts only (555 numbers, example.com).
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { crmTest } from "../../helpers/crm-http.mjs";
import { seedContact } from "../../helpers/crm-fixtures.mjs";

const store = await import("../../../netlify/lib/crm-store.mjs");
const B = await import("../../../netlify/lib/crm/core/bulk.mjs");

const W8 = { by: "system", origin: "api", actor_kind: "user", requestId: "test" };
const scope = (fn) => store.withStoreScope({ requestId: "test" }, fn);
let t;
afterEach(() => { if (t) t.done(); t = null; });

async function setup(body = "Hi {{first_name|there}}, rain moved your visit.") {
  t = await crmTest({ now: "2026-11-17T17:00:00Z" });
  const owner = await t.user("owner");
  const tpl = await scope(() => store.createRecord("template", { key: "rain_note", name: "Rain note", channel: "sms", category: "service", body, tags: [], active: true, built_in: false }, W8));
  const tester = await scope(() => seedContact(99, { flags: { test: true } }));
  const mt = await t.api("/settings/messaging_test", { method: "PUT", as: owner, ifMatch: "new", body: { contact_id: tester.id } });
  assert.equal(mt.status, 200, JSON.stringify(mt.body));
  return { owner, tester, tpl };
}
const bulkOutbox = (id, tester) => t.stores.data.keys("rec/outbox/").map((k) => t.stores.data.json(k)).filter((o) => o.related && o.related.bulk_run_id === id && o.contact_id !== tester.id);
const runBulk = async (n = 3) => { for (let i = 0; i < n; i++) await t.runWorker({ lane: "bulk" }); };

test("the send reaches exactly the people the preview counted: archived, flagged and a second contact on one phone stay out", async () => {
  const { owner, tester } = await setup();
  const ok = [];
  for (let i = 0; i < 3; i++) ok.push(await scope(() => seedContact(10 + i)));
  const archived = await scope(() => seedContact(20, { lifecycle: "archived" }));
  const vendor = await scope(() => seedContact(21, { flags: { vendor: true } }));
  const pat = await scope(() => seedContact(22));
  const sam = await scope(() => seedContact(23, { phones: [{ e164: pat.phones[0].e164, label: "mobile", primary: true, sms: true }] }));
  const recipients = [...ok, archived, vendor, tester, pat, sam].map((c) => c.id);
  const id = (await t.api("/bulk-runs", { method: "POST", as: owner, body: { template_key: "rain_note", recipients, title: "Rain day" } })).body.data.id;
  await runBulk();
  const ready = (await t.api(`/bulk-runs/${id}`, { as: owner })).body.data;
  assert.equal(ready.preview.count, 4);
  assert.deepEqual(ready.preview.excluded, { archived: 1, excluded_flag: 2, duplicate: 1 });
  assert.equal((await t.api(`/bulk-runs/${id}/test`, { method: "POST", as: owner, body: {} })).status, 200);
  assert.equal((await t.api(`/bulk-runs/${id}/confirm`, { method: "POST", as: owner, body: {} })).status, 200);
  await runBulk();
  const sent = (await t.api(`/bulk-runs/${id}`, { as: owner })).body.data;
  assert.equal(sent.status, "sent");
  const items = bulkOutbox(id, tester).filter((o) => o.mode === "dry_run");
  assert.equal(items.length, ready.preview.count, "the confirmed count is who got it");
  const to = new Set(items.map((o) => o.contact_id));
  assert.ok(!to.has(archived.id) && !to.has(vendor.id), "archived and vendor contacts stay out");
  assert.equal([pat.id, sam.id].filter((x) => to.has(x)).length, 1, "one message per phone");
  assert.equal(sent.stats.dry_run, 4);
  assert.deepEqual(sent.stats.skipped, { archived: 1, excluded_flag: 2, duplicate: 1 });
  const rec = t.stores.data.json(`rec/bulk_run/${id}`);
  assert.deepEqual(rec.results[archived.id], { s: "skipped", r: "archived" });
});

test("the test covers what is sent: a template changed after the test is refused at confirm, and the send renders the tested text", async () => {
  const { owner, tester, tpl } = await setup("Rain is coming, we'll move your visit.");
  const rs = [];
  for (let i = 0; i < 6; i++) rs.push((await scope(() => seedContact(30 + i))).id);
  const id = (await t.api("/bulk-runs", { method: "POST", as: owner, body: { template_key: "rain_note", recipients: rs } })).body.data.id;
  await runBulk();
  assert.equal((await t.api(`/bulk-runs/${id}/test`, { method: "POST", as: owner, body: {} })).status, 200);
  const admin = await t.user("admin");
  const cur = await t.api(`/templates/${tpl.data.id}`, { as: admin });
  const edit = await t.api(`/templates/${tpl.data.id}`, { method: "PATCH", as: admin, ifMatch: cur.headers.get("etag"), body: { body: "Something else entirely, never tested." } });
  assert.equal(edit.status, 200);
  const refused = await t.api(`/bulk-runs/${id}/confirm`, { method: "POST", as: owner, body: {} });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error.message, /changed after the test/);
  assert.equal((await t.api(`/bulk-runs/${id}`, { as: owner })).body.data.status, "ready", "back to ready: test again");
  // test the new text, confirm, and only then edit again: the tested text goes out
  assert.equal((await t.api(`/bulk-runs/${id}/test`, { method: "POST", as: owner, body: {} })).status, 200);
  assert.equal((await t.api(`/bulk-runs/${id}/confirm`, { method: "POST", as: owner, body: {} })).status, 200);
  const cur2 = await t.api(`/templates/${tpl.data.id}`, { as: admin });
  await t.api(`/templates/${tpl.data.id}`, { method: "PATCH", as: admin, ifMatch: cur2.headers.get("etag"), body: { body: "A third text nobody tested." } });
  await runBulk();
  const bodies = new Set(bulkOutbox(id, tester).map((o) => o.body.replace(/ Reply STOP to opt out\.$/, "")));
  assert.deepEqual([...bodies], ["Something else entirely, never tested."]);
});

test("a confirm whose send run was not created is finished by confirming again", async () => {
  const { owner, tester } = await setup();
  const rs = [];
  for (let i = 0; i < 6; i++) rs.push((await scope(() => seedContact(40 + i))).id);
  const id = (await t.api("/bulk-runs", { method: "POST", as: owner, body: { template_key: "rain_note", recipients: rs } })).body.data.id;
  await runBulk();
  await t.api(`/bulk-runs/${id}/test`, { method: "POST", as: owner, body: {} });
  t.stores.data.fail({ op: ["set", "setJSON"], key: /^rec\/run\//, kind: "timeout", times: 20 });
  const first = await t.api(`/bulk-runs/${id}/confirm`, { method: "POST", as: owner, body: {} });
  t.stores.data.clearHooks();
  assert.equal(first.status, 503);
  const again = await t.api(`/bulk-runs/${id}/confirm`, { method: "POST", as: owner, body: {} });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.data.send_run_id, B.sendRunId(id));
  assert.equal((await t.api(`/bulk-runs/${id}/confirm`, { method: "POST", as: owner, body: {} })).status, 409, "a third tap: already started");
  await runBulk(4);
  const b = (await t.api(`/bulk-runs/${id}`, { as: owner })).body.data;
  assert.equal(b.status, "sent");
  assert.equal(bulkOutbox(id, tester).length, 6);
});

test("a test whose save failed counts once it went out: the retry neither sends again nor stays stuck", async () => {
  const { owner, tester } = await setup();
  const rs = [];
  for (let i = 0; i < 6; i++) rs.push((await scope(() => seedContact(50 + i))).id);
  const id = (await t.api("/bulk-runs", { method: "POST", as: owner, body: { template_key: "rain_note", recipients: rs } })).body.data.id;
  await runBulk();
  t.stores.data.fail({ op: ["set", "setJSON"], key: `rec/bulk_run/${id}`, kind: "timeout", times: 20 });
  const first = await t.api(`/bulk-runs/${id}/test`, { method: "POST", as: owner, body: {} });
  t.stores.data.clearHooks();
  assert.equal(first.status, 503);
  const tests = () => t.stores.data.keys("rec/outbox/").map((k) => t.stores.data.json(k)).filter((o) => o.contact_id === tester.id).length;
  assert.equal(tests(), 1);
  const retry = await t.api(`/bulk-runs/${id}/test`, { method: "POST", as: owner, body: {} });
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.data.status, "tested");
  assert.equal(tests(), 1, "the test that went out counts; no second one");
  assert.equal((await t.api(`/bulk-runs/${id}/confirm`, { method: "POST", as: owner, body: {} })).status, 200);
});

test("a draft whose preview run was never created gets it when someone opens it", async () => {
  const { owner } = await setup();
  const rs = [];
  for (let i = 0; i < 6; i++) rs.push((await scope(() => seedContact(60 + i))).id);
  t.stores.data.fail({ op: ["set", "setJSON"], key: /^rec\/run\//, kind: "timeout", times: 20 });
  const first = await t.api("/bulk-runs", { method: "POST", as: owner, body: { template_key: "rain_note", recipients: rs } });
  t.stores.data.clearHooks();
  assert.equal(first.status, 503);
  const id = t.stores.data.keys("rec/bulk_run/").map((k) => k.split("/").pop())[0];
  assert.ok(id, "the draft was saved");
  assert.equal((await t.api(`/bulk-runs/${id}`, { as: owner })).body.data.status, "draft");
  await runBulk();
  const b = (await t.api(`/bulk-runs/${id}`, { as: owner })).body.data;
  assert.equal(b.status, "ready");
  assert.equal(b.preview.count, 6);
});
