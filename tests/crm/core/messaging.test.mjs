// The core messaging routes (design §5.7.7 "Endpoints, core", §4.12, §9.2):
// the template library and its permissions, built-in templates seeded once
// (owner edits kept), search by document number and by the contacts index,
// suppressions, the outbox list, permissions and integrations for the
// owner, the intake-mode gate, and approvals that reach the owners' bell.
// Synthetic data only.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { crmTest } from "../../helpers/crm-http.mjs";
import { fixtureModule, seedContact } from "../../helpers/crm-fixtures.mjs";

const store = await import("../../../netlify/lib/crm-store.mjs");
const T = await import("../../../netlify/lib/crm/core/templates.mjs");
const B = await import("../../../netlify/lib/crm/core/bulk.mjs");

fixtureModule({
  templates: [{ key: "fixture_builtin", name: "Fixture built-in", channel: "sms", category: "service", body: "Hi {{first_name|there}}, your visit is {{visit_date|soon}}." }],
});

const W8 = { by: "system", origin: "api", actor_kind: "user", requestId: "test" };
const scope = (fn) => store.withStoreScope({ requestId: "test" }, fn);
let t;
afterEach(() => { if (t) t.done(); t = null; T.clearTemplateSeedCache(); });

test("templates: owners and admins edit, techs read active service ones; problems come back as preview warnings", async () => {
  t = await crmTest();
  const owner = await t.user("owner");
  const tech = await t.user("tech");
  const made = await t.api("/templates", { method: "POST", as: owner, body: { key: "visit_soon", name: "Visit soon", channel: "sms", category: "service", body: "Hi {{first_name|there}}, see you {{visit_date}}." } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual(made.body.data.variables, ["first_name", "visit_date"]);
  assert.equal(made.body.data.built_in, false);
  const promo = await t.api("/templates", { method: "POST", as: owner, body: { key: "fall_promo", name: "Fall promo", channel: "sms", category: "marketing", body: "Fall special for {{first_name|you}}." } });
  assert.equal(promo.status, 201);
  assert.equal((await t.api("/templates", { method: "POST", as: owner, body: { key: "visit_soon", name: "Again", channel: "sms", category: "service", body: "x" } })).status, 400, "a key is used once");
  assert.equal((await t.api("/templates", { method: "POST", as: owner, body: { key: "bad_var", name: "Bad", channel: "sms", category: "service", body: "Hi {{nickname}}" } })).status, 400);
  assert.equal((await t.api("/templates", { method: "POST", as: tech, body: { key: "tech_one", name: "x", channel: "sms", category: "service", body: "x" } })).status, 403);

  const list = await t.api("/templates", { as: owner });
  assert.ok(list.body.meta.variables.some((v) => v.name === "first_name"), "the variable chips come with the list");
  assert.ok(list.body.data.some((x) => x.key === "fall_promo"));
  const techList = await t.api("/templates", { as: tech });
  assert.equal(techList.status, 200);
  assert.ok(techList.body.data.every((x) => x.category !== "marketing"), "techs see service and personal templates only");

  const stale = await t.api(`/templates/${made.body.data.id}`, { method: "PATCH", as: owner, body: { name: "Visit soon!" } });
  assert.equal(stale.status, 400, "an edit needs If-Match");
  const edit = await t.api(`/templates/${made.body.data.id}`, { method: "PATCH", as: owner, ifMatch: made.headers.get("etag"), body: { name: "Visit soon!", key: "renamed" } });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  assert.equal(edit.body.data.key, "visit_soon", "the key never changes");

  const c = await scope(() => seedContact(7));
  const pv = await t.api("/templates/preview", { method: "POST", as: owner, body: { template_id: made.body.data.id, contact_id: c.id } });
  assert.equal(pv.status, 200);
  assert.match(pv.body.data.text, /^Hi Taylor, see you Wed, Nov 19\.$/, "the contact's name, a sample for the rest");

  assert.deepEqual(pv.body.data.missing_for_contact, ["visit_date"], "what this contact alone can't fill");
  const draft = await t.api("/templates/preview", { method: "POST", as: owner, body: { channel: "sms", body: "Hi {{first_name}} {{nickname}}. Reply STOP to opt out." } });
  assert.equal(draft.status, 200);
  assert.deepEqual(draft.body.data.problems.map((p) => p.code).sort(), ["stop_text", "unknown_variable"]);
});

test("built-in templates are seeded once by the worker; an owner's edit is never overwritten", async () => {
  t = await crmTest();
  const owner = await t.user("owner");
  const before = await t.api("/templates", { as: owner });
  assert.ok(before.body.data.find((x) => x.key === "fixture_builtin").pending_seed, "listed before the seed, marked pending");
  await t.runWorker({ lane: "fast" });
  const rows = (await t.api("/templates", { as: owner })).body.data.filter((x) => x.key === "fixture_builtin");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].built_in, true);
  const got = await t.api(`/templates/${rows[0].id}`, { as: owner });
  const edit = await t.api(`/templates/${rows[0].id}`, { method: "PATCH", as: owner, ifMatch: got.headers.get("etag"), body: { body: "Hello {{first_name|friend}}!" } });
  assert.equal(edit.status, 200);
  const noCat = await t.api(`/templates/${rows[0].id}`, { method: "PATCH", as: owner, ifMatch: edit.headers.get("etag"), body: { category: "marketing" } });
  assert.equal(noCat.status, 400, "a built-in keeps its category");
  T.clearTemplateSeedCache();
  await t.runWorker({ lane: "fast" });
  assert.equal(t.stores.data.keys("rec/template/").filter((k) => t.stores.data.json(k).key === "fixture_builtin").length, 1, "never a second copy");
  assert.equal((await t.api(`/templates/${rows[0].id}`, { as: owner })).body.data.body, "Hello {{first_name|friend}}!");
});

test("search: document numbers through the number pointers, contacts from the index; techs can't search", async () => {
  t = await crmTest();
  const owner = await t.user("owner");
  await scope(() => store.claimPointer("quote-no", "18641", { id: "qt_0000000000000000000a", seq: "quote" }));
  await scope(() => store.claimPointer("invoice-no", "610", { id: "in_0000000000000000000b", seq: "invoice" }));
  await scope(() => store.applyIndexRow("contacts", "", "ct_0000000000000000000c", "contact", { dn: "Pat Example", town: "Delano", ph: "+17635550142" }, 1));
  const q = await t.api("/search?q=Q-18641", { as: owner });
  assert.deepEqual(q.body.data.numbers, [{ type: "quote", id: "qt_0000000000000000000a", label: "Q-18641", seq: "quote" }]);
  const inv = await t.api("/search?q=INV-0610", { as: owner });
  assert.equal(inv.body.data.numbers[0].id, "in_0000000000000000000b");
  const name = await t.api("/search?q=pat%20delano", { as: owner });
  assert.deepEqual(name.body.data.contacts.map((c) => c.id), ["ct_0000000000000000000c"]);
  const phone = await t.api("/search?q=555-0142", { as: owner });
  assert.equal(phone.body.data.contacts.length, 1, "phone digits match");
  assert.equal((await t.api("/search?q=nobody%20here", { as: owner })).body.data.contacts.length, 0);
  const tech = await t.user("tech");
  assert.equal((await t.api("/search?q=pat", { as: tech })).status, 403);
  const deep = await t.api("/search/deep", { method: "POST", as: owner, body: { q: "gate code" } });
  assert.equal(deep.status, 202);
  assert.ok(deep.body.data.run_id);
});

test("suppressions: an address opted out blocks every send to it; lifting it lets them through", async () => {
  t = await crmTest();
  const owner = await t.user("owner");
  const c = await scope(() => seedContact(8));
  const off = await t.api("/suppressions", { method: "POST", as: owner, body: { channel: "sms", address: c.phones[0].e164, state: "opted_out" } });
  assert.equal(off.status, 200);
  assert.equal(off.body.data.masked, "(763) •••-0108");
  const list = await t.api("/suppressions?channel=sms", { as: owner });
  assert.equal(list.body.data.length, 1);
  assert.equal(list.body.data[0].source, "manual");
  assert.ok(!JSON.stringify(list.body).includes("5550108"), "only the masked number");
  const blocked = await t.api("/messages", { method: "POST", as: owner, body: { contact_id: c.id, channel: "sms", body: "Hi!" } });
  assert.equal(blocked.body.data.status, "blocked");
  assert.equal(blocked.body.data.blocked_reason, "opted_out");
  await t.api("/suppressions", { method: "POST", as: owner, body: { channel: "sms", address: c.phones[0].e164, state: "active" } });
  assert.equal((await t.api("/messages", { method: "POST", as: owner, body: { contact_id: c.id, channel: "sms", body: "Hi again!" } })).body.data.status, "dry_run");
  const out = await t.api("/outbox?date=2026-11-17", { as: owner });
  assert.deepEqual(out.body.data.map((x) => x.mode).sort(), ["blocked", "dry_run"]);
  const mine = await t.api(`/outbox?contact=${c.id}`, { as: owner });
  assert.equal(mine.body.data.length, 2);
  const tech = await t.user("tech");
  assert.equal((await t.api("/outbox", { as: tech })).status, 403);
  assert.equal((await t.api("/suppressions", { as: tech })).status, 403);
  assert.equal((await t.api("/messages", { method: "POST", as: tech, body: { contact_id: c.id, channel: "sms", body: "Hi" } })).status, 403, "a tech texts only contacts on their visits");
});

test("permissions and integrations for the owner: labels, defaults, secrets by name only; the intake gate", async () => {
  t = await crmTest({ env: { CRM_VAPID_PRIVATE: "secret-not-real-value" } });
  const owner = await t.user("owner");
  const admin = await t.user("admin");
  const p = await t.api("/permissions", { as: owner });
  assert.equal(p.status, 200);
  const settingsOwner = p.body.data.catalog.find((x) => x.key === "settings:owner");
  assert.equal(settingsOwner.owner_only, true);
  assert.deepEqual(settingsOwner.defaults, { owner: true, admin: false, tech: false });
  assert.equal(p.body.data.catalog.find((x) => x.key === "contacts:read").defaults.tech, "own");
  assert.equal((await t.api("/permissions", { as: admin })).status, 403);
  const i = await t.api("/admin/integrations", { as: owner });
  assert.equal(i.status, 200);
  assert.equal(i.body.data.integrations.push.secrets.CRM_VAPID_PRIVATE, true);
  assert.equal(i.body.data.integrations.sms.effective, "dry_run");
  assert.ok(!JSON.stringify(i.body).includes("secret-not-real-value"), "never a value");
  // the gate opened with Contacts (M2a): website leads may go to the CRM too
  const dual = await t.api("/settings/intake", { method: "PUT", as: owner, ifMatch: "new", body: { mode: "dual" } });
  assert.equal(dual.status, 200, "website leads into the CRM since Contacts");
  assert.equal((await t.api("/settings/intake", { method: "PUT", as: owner, ifMatch: dual.headers.get("etag"), body: { mode: "rotor" } })).status, 200);
  const portal = await t.api("/settings/portal", { as: owner });
  assert.equal(portal.body.data.data.lifetimes.present_minutes, 15);
  assert.equal((await t.api("/settings/portal", { as: admin })).status, 403, "portal settings are owner-only");
  const comms = await t.api("/settings/comms", { as: admin });
  assert.equal(comms.body.data.data.reply_keywords.enabled, false, "reply keywords stay off until the owner names the routing (D23)");
  const stop = await t.api("/settings/comms", { method: "PUT", as: admin, ifMatch: "new", body: { reply_keywords: { enabled: true, words: [{ word: "STOP", tag: "x" }] } } });
  assert.equal(stop.status, 400, "STOP always does what it says");
});

test("approvals reach the owners' bell; a bulk send waiting for its test counts on the badge", async () => {
  t = await crmTest();
  const owner = await t.user("owner");
  const tech = await t.user("tech");
  const r = await t.api("/outbox-review", { method: "POST", as: tech, body: { items: [{ method: "POST", path: "/visits/x/complete", queued_at: "2026-11-09T15:00:00Z" }] } });
  assert.equal(r.status, 201);
  await t.runWorker({ lane: "fast" });
  const bell = await t.api("/notifications", { as: owner });
  assert.equal(bell.body.data.length, 1);
  assert.equal(bell.body.data[0].kind, "approval");
  assert.equal(bell.body.data[0].link, "/approvals");
  assert.equal((await t.api("/notifications", { as: tech })).body.data.length, 0, "techs don't approve");
  const c = await scope(() => seedContact(9));
  await scope(() => store.createRecord("template", { key: "rain_day", name: "Rain day", channel: "sms", category: "service", body: "Rain today: we'll text a new day.", tags: [], active: true }, W8));
  await scope(() => B.createBulkRun({ recipients: [c.id], template_key: "rain_day", requested_by: owner.id }, W8));
  const badges = await t.api("/me/badges", { as: owner });
  assert.equal(badges.body.data.approvals, 2, "the offline review and the bulk send");
  assert.equal(badges.body.data.notifications, 1);
  assert.equal((await t.api("/me/badges", { as: tech })).body.data.approvals, 0);
});

test("a tech can't preview a template with a contact who isn't on their visits", async () => {
  t = await crmTest();
  const owner = await t.user("owner");
  const tech = await t.user("tech");
  const c = await scope(() => seedContact(12));
  const made = await t.api("/templates", { method: "POST", as: owner, body: { key: "hello_tech", name: "Hello", channel: "sms", category: "service", body: "Hi {{first_name|there}} in {{town|town}}" } });
  const r = await t.api("/templates/preview", { method: "POST", as: tech, body: { template_id: made.body.data.id, contact_id: c.id } });
  assert.equal(r.status, 403);
  const plain = await t.api("/templates/preview", { method: "POST", as: tech, body: { template_id: made.body.data.id } });
  assert.equal(plain.status, 200);
  assert.equal(plain.body.data.text, "Hi Pat in Delano", "made-up values only");
});

test("suppressions list the newest first, page by page, however many there are", async () => {
  const { advance, minutes } = await import("../../helpers/crm-clock.mjs");
  t = await crmTest({ now: "2026-11-17T15:00:00Z" });
  const owner = await t.user("owner");
  for (let i = 0; i < 60; i++) {
    const r = await t.api("/suppressions", { method: "POST", as: owner, body: { channel: "sms", address: `+1763555${String(1000 + i)}`, state: "opted_out" } });
    assert.equal(r.status, 200);
    advance(minutes(1));
  }
  const first = await t.api("/suppressions?channel=sms", { as: owner });
  assert.equal(first.body.data.length, 40);
  assert.match(first.body.data[0].masked, /1059$/, "the newest is first");
  const at = first.body.data.map((r) => r.at);
  assert.deepEqual([...at].sort().reverse(), at, "newest first");
  const next = await t.api(`/suppressions?channel=sms&before=${encodeURIComponent(first.body.meta.next_cursor)}`, { as: owner });
  assert.equal(next.body.data.length, 20);
  assert.match(next.body.data[19].masked, /1000$/);
  // lifting one takes it off the list
  await t.api("/suppressions", { method: "POST", as: owner, body: { channel: "sms", address: "+17635551059", state: "active" } });
  const after = await t.api("/suppressions?channel=sms", { as: owner });
  assert.match(after.body.data[0].masked, /1058$/);
});
