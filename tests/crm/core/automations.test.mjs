// The automation engine (design §5.7.4, §7.3, §3.10; §11.4 M1.3
// automations.test.mjs): the eligibility floor; imported: "eligible" only
// for subjects still in the future; would- rows under the parallel-run
// guard (from actx.mutate and from the store's backstop); two worker passes
// never fire one step twice; a send to more than 5 recipients becomes a
// bulk run that refuses to confirm before its test send. Synthetic data only.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { crmTest } from "../../helpers/crm-http.mjs";
import { fixtureModule, fixtureType, seedContact, seedImportedContact } from "../../helpers/crm-fixtures.mjs";
import { pin } from "../../helpers/crm-clock.mjs";

const store = await import("../../../netlify/lib/crm-store.mjs");
const E = await import("../../../netlify/lib/crm/core/events.mjs");
const AU = await import("../../../netlify/lib/crm/core/automations.mjs");
const B = await import("../../../netlify/lib/crm/core/bulk.mjs");
const { listAutomationLog } = await import("../../../netlify/lib/crm/core/activity.mjs");

const W8 = { by: "system", origin: "api", actor_kind: "user", requestId: "test" };
const scope = (fn) => store.withStoreScope({ requestId: "test" }, fn);

// A fixture module: an event, a record type Rotor "owns" fields of, and automations.
const widget = fixtureType("auto_widget", "zx", { rotorFields: ["status", "rotor"], mirrored: false });
const seen = [];
fixtureModule({
  types: [widget],
  emits: ["fixture.done", "fixture.many", "fixture.mutate"],
  automations: [
    {
      key: "fixture.note", label: "Fixture note", trigger: "event:fixture.done", category: "service", imported: "no", mutates: false,
      defaults: { channels: ["sms"], template_keys: ["fixture_note"] },
      async run({ event }, actx) {
        const p = event.payload;
        const got = await store.getRecord("contact", p.contact_id);
        seen.push(p.id);
        return actx.send({ contact_id: p.contact_id, contact: got && got.data, record: got && got.data, fact_at: p.fact_at, key: `${p.id}--1` });
      },
    },
    {
      key: "fixture.reminder", label: "Fixture reminder", trigger: "sweep", category: "service", imported: "eligible", mutates: false,
      defaults: { channels: ["sms"], template_keys: ["fixture_note"] },
      async run({ contact, future }, actx) { return actx.send({ contact_id: contact.id, contact, record: contact, future, fact_at: "2026-11-17T10:00:00.000Z", key: `${contact.id}--${future ? "f" : "p"}` }); },
    },
    {
      key: "fixture.many", label: "Fixture rain-day notice", trigger: "event:fixture.many", category: "service", imported: "no", mutates: false,
      defaults: { channels: ["sms"], template_keys: ["fixture_note"] },
      async run({ event }, actx) { return actx.sendMany(event.payload.contact_ids.map((id) => ({ contact_id: id })), { title: "Rain-day notice" }); },
    },
    {
      key: "fixture.mutate", label: "Fixture tidy-up", trigger: "event:fixture.mutate", category: "service", imported: "no", mutates: true,
      defaults: {},
      async run({ event }, actx) {
        const w = (await store.getRecord("auto_widget", event.payload.widget_id)).data;
        if (event.payload.via === "mutate") {
          await actx.mutate(w, "archive", () => store.updateRecord("auto_widget", w.id, (x) => ({ ...x, status: "archived" }), actx.write()), { status: [w.status, "archived"] });
          return { result: "done" };
        }
        // straight to the store: the backstop throws ParallelRunGuard, the queue writes the would- row
        await store.updateRecord("auto_widget", w.id, (x) => ({ ...x, status: "archived" }), actx.write());
        return { result: "done" };
      },
    },
  ],
});

let t;
afterEach(() => { if (t) t.done(); t = null; seen.length = 0; });

async function setup() {
  t = await crmTest({ now: "2026-11-17T17:00:00Z" });
  const owner = await t.user("owner");
  await scope(() => store.createRecord("template", { key: "fixture_note", name: "Fixture note", channel: "sms", category: "service", body: "Hi {{first_name|there}}, a note from {{company_name}}.", tags: [], active: true }, W8));
  return owner;
}
const emit = (name, payload) => scope(() => E.emit(name, { id: payload.id || "zx_00000000000000000001", wv: payload.wv || 1, ...payload }, W8));
const drain = async (n = 3) => { for (let i = 0; i < n; i++) await t.runWorker({ lane: "fast" }); };
const log = (key) => scope(() => listAutomationLog("2026-11-17", { key }));

test("eligibility floor: a triggering fact before cutover's effective_from is skipped, one after it is sent (dry-run)", async () => {
  await setup();
  const c = await scope(() => seedContact(1));
  await scope(() => store.putSetting("automations", { effective_from: "2026-11-15T00:00:00.000Z" }, { ...W8, origin: "worker" }));
  await emit("fixture.done", { id: "zx_0000000000000000000a", contact_id: c.id, fact_at: "2026-11-14T12:00:00.000Z" });
  await emit("fixture.done", { id: "zx_0000000000000000000b", contact_id: c.id, fact_at: "2026-11-16T12:00:00.000Z" });
  await drain();
  const rows = await log("fixture.note");
  assert.deepEqual(rows.map((r) => r.result).sort(), ["dry_run", "skipped:before_floor"]);
  assert.equal(t.stores.data.keys("rec/outbox/").length, 1);
  assert.equal(t.stores.data.keys("done-dry/fixture.note/").length, 1, "the step's marker is in done-dry/");

  // the pure rule, per automation override first
  const def = AU.automationDef("fixture.note");
  assert.equal(AU.checkEligible(def, { effective_from: "2026-11-17T00:00:00Z" }, { effective_from: "2026-11-01T00:00:00Z" }, { fact_at: "2026-11-16T00:00:00Z" }).reason, "before_floor");
  assert.equal(AU.checkEligible(def, {}, { effective_from: null }, { fact_at: "2020-01-01T00:00:00Z" }).ok, true, "no floor before cutover");
});

test("imported subjects: never for imported: no; imported: eligible only for subjects still in the future", async () => {
  await setup();
  const imported = await scope(() => seedImportedContact(2));
  const def = AU.automationDef("fixture.note");
  assert.equal(AU.checkEligible(def, {}, {}, { record: imported, future: true }).reason, "imported");
  const rem = AU.automationDef("fixture.reminder");
  assert.equal(AU.checkEligible(rem, {}, {}, { record: imported, future: true }).ok, true);
  assert.equal(AU.checkEligible(rem, {}, {}, { record: imported, future: false }).reason, "imported_past");
  await scope(() => AU.runAutomation("fixture.reminder", { contact: imported, future: true }, {}));
  await scope(() => AU.runAutomation("fixture.reminder", { contact: imported, future: false }, {}));
  await drain();
  const rows = await log("fixture.reminder");
  assert.deepEqual(rows.map((r) => r.result).sort(), ["dry_run", "skipped:imported_past"]);
  const ob = t.stores.data.keys("rec/outbox/").map((k) => t.stores.data.json(k));
  assert.equal(ob.length, 1);
  assert.equal(ob[0].mode, "dry_run", "an imported contact before cutover: the outbox only, never a real send");
});

test("would- rows under the guard: actx.mutate and the store's backstop both report instead of changing what Rotor owns", async () => {
  await setup();
  const imported = (await scope(() => store.createRecord("auto_widget", { status: "open", import: { run_id: "ir_00000000000000000001", at: "2026-11-08T00:00:00.000Z", hash: "0".repeat(64) } }, { by: "import", origin: "import", requestId: "t" }))).data;
  const shadow = (await scope(() => store.createRecord("auto_widget", { status: "open", shadow: true }, W8))).data;
  await emit("fixture.mutate", { id: imported.id, widget_id: imported.id, via: "mutate" });
  await emit("fixture.mutate", { id: imported.id, wv: 2, widget_id: imported.id, via: "store" });
  await emit("fixture.mutate", { id: shadow.id, widget_id: shadow.id, via: "store" });
  await drain();
  const rows = await log("fixture.mutate");
  const wouldRows = await log("evt:x");
  assert.ok(rows.some((r) => r.result === "would-archive" && r.subject === imported.id), "actx.mutate wrote would-archive");
  const all = [...rows, ...wouldRows, ...(await scope(() => listAutomationLog("2026-11-17")))];
  assert.ok(all.some((r) => r.result === "would-update" && r.subject === imported.id), "the backstop's ParallelRunGuard became would-update");
  assert.equal(t.stores.data.json(`rec/auto_widget/${imported.id}`).status, "open", "Rotor's field is untouched");
  const shadowNow = t.stores.data.keys("rec/auto_widget/").map((k) => t.stores.data.json(k)).find((x) => x.id === shadow.id);
  assert.equal(shadowNow.status, "archived", "a sandboxed record is changed");
  const detail = t.stores.data.json(rows.find((r) => r.result === "would-archive").ref);
  assert.deepEqual(detail.details.changes, { status: ["open", "archived"] });
});

test("two worker passes never fire one step twice; a retried event is the same step", async () => {
  await setup();
  const c = await scope(() => seedContact(3));
  await emit("fixture.done", { id: "zx_0000000000000000000c", contact_id: c.id, fact_at: "2026-11-17T12:00:00.000Z" });
  await emit("fixture.done", { id: "zx_0000000000000000000c", contact_id: c.id, fact_at: "2026-11-17T12:00:00.000Z" });
  await drain(4);
  assert.equal(t.stores.data.keys("rec/outbox/").length, 1);
  // the automation runs again for the same subject: the step's marker is final, nothing new is queued
  await scope(() => AU.runAutomation("fixture.note", { event: { payload: { id: "zx_0000000000000000000c", contact_id: c.id, fact_at: "2026-11-17T12:00:00.000Z" } } }, {}));
  await drain(2);
  assert.equal(t.stores.data.keys("rec/outbox/").length, 1);
  assert.ok((await log("fixture.note")).some((r) => r.result === "skipped:done"));
});

test("settings: a disabled automation skips its due steps; the screen lists the catalog with what arrives later", async () => {
  const owner = await setup();
  const c = await scope(() => seedContact(4));
  await emit("fixture.done", { id: "zx_0000000000000000000d", contact_id: c.id, fact_at: "2026-11-17T12:00:00.000Z" });
  const off = await t.api("/automations/fixture.note", { method: "PATCH", as: owner, body: { enabled: false } });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.equal(off.body.data.enabled, false);
  await drain();
  assert.equal(t.stores.data.keys("rec/outbox/").length, 0);
  const list = await t.api("/automations", { as: owner });
  assert.equal(list.status, 200);
  const mine = list.body.data.automations.find((a) => a.key === "fixture.note");
  assert.equal(mine.available, true);
  assert.equal(mine.settings.enabled, false);
  const later = list.body.data.automations.find((a) => a.key === "lead.ack");
  assert.equal(later.available, false);
  assert.equal(later.arrives_with, "Sales");
  const bad = await t.api("/automations/fixture.note", { method: "PATCH", as: owner, body: { at_local: "25:00" } });
  assert.equal(bad.status, 400);
  const tech = await t.user("tech");
  assert.equal((await t.api("/automations", { as: tech })).status, 403);
});

test("more than 5 recipients becomes a bulk run: preview, then confirm is refused until the test send", async () => {
  const owner = await setup();
  const contacts = [];
  for (let i = 0; i < 6; i++) contacts.push(await scope(() => seedContact(20 + i)));
  await emit("fixture.many", { id: "zx_0000000000000000000e", contact_ids: contacts.map((c) => c.id) });
  await drain(2);
  assert.equal(t.stores.data.keys("rec/outbox/").length, 0, "nothing was sent directly");
  const runs = await t.api("/bulk-runs", { as: owner });
  assert.equal(runs.body.data.length, 1);
  const id = runs.body.data[0].id;
  assert.equal(runs.body.data[0].recipients, 6);
  for (let i = 0; i < 3; i++) await t.runWorker({ lane: "bulk" });
  let one = await t.api(`/bulk-runs/${id}`, { as: owner });
  assert.equal(one.body.data.status, "ready");
  assert.equal(one.body.data.preview.count, 6);
  assert.equal(one.body.data.preview.samples.length, 6);
  assert.match(one.body.data.preview.samples[0].text, /^Hi \w+, a note from Barta Window Washing\.$/);

  const early = await t.api(`/bulk-runs/${id}/confirm`, { method: "POST", as: owner, body: {} });
  assert.equal(early.status, 409, "confirm refused before the test send");
  assert.match(early.body.error.message, /test/i);
  const noTest = await t.api(`/bulk-runs/${id}/test`, { method: "POST", as: owner, body: {} });
  assert.equal(noTest.status, 409, "no test contact chosen yet");
  const tester = await scope(() => seedContact(99, { flags: { test: true } }));
  const mt = await t.api("/settings/messaging_test", { method: "PUT", as: owner, ifMatch: "new", body: { contact_id: tester.id } });
  assert.equal(mt.status, 200, JSON.stringify(mt.body));
  const tested = await t.api(`/bulk-runs/${id}/test`, { method: "POST", as: owner, body: {} });
  assert.equal(tested.status, 200, JSON.stringify(tested.body));
  assert.equal(tested.body.data.status, "tested");
  assert.equal(tested.body.data.send.status, "dry_run");
  const admin = await t.user("admin");
  const ok = await t.api(`/bulk-runs/${id}/confirm`, { method: "POST", as: admin, body: {} });
  assert.equal(ok.status, 200, "an owner or admin confirms");
  assert.equal(ok.body.data.status, "sending");
  for (let i = 0; i < 3; i++) await t.runWorker({ lane: "bulk" });
  one = await t.api(`/bulk-runs/${id}`, { as: owner });
  assert.equal(one.body.data.status, "sent");
  assert.equal(one.body.data.stats.dry_run, 6);
  assert.equal(t.stores.data.keys("rec/outbox/").length, 7, "six recipients and the test");
  assert.equal((await t.api(`/bulk-runs/${id}/confirm`, { method: "POST", as: owner, body: {} })).status, 409, "never twice");
  const tech = await t.user("tech");
  assert.equal((await t.api(`/bulk-runs/${id}/confirm`, { method: "POST", as: tech, body: {} })).status, 403);
});

test("five recipients or fewer are sent as ordinary steps", async () => {
  await setup();
  const contacts = [];
  for (let i = 0; i < 5; i++) contacts.push(await scope(() => seedContact(40 + i)));
  await emit("fixture.many", { id: "zx_0000000000000000000f", contact_ids: contacts.map((c) => c.id) });
  await drain(3);
  assert.equal(t.stores.data.keys("rec/bulk_run/").length, 0);
  assert.equal(t.stores.data.keys("rec/outbox/").length, 5);
  assert.equal(B.DEFAULT_THRESHOLD, 5);
});
