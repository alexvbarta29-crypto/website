// The parallel-run guard (design §0 rule 12, §3.10, §11.4 M1.1): while
// Rotor is the system of record, automation may create or change only
// sandboxed records, and the store throws ParallelRunGuard as a backstop.
// Imports and people are never stopped. Fixtures are made up.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createCrmStores, useCrmStores, clearCrmStores } from "../../helpers/crm-memory-store.mjs";

const { createRecord, updateRecord, softDelete, getRecord, K, ParallelRunGuard } = await import("../../../netlify/lib/crm-store.mjs");
const { defineType, registerType } = await import("../../../netlify/lib/crm/core/registry.mjs");
const { sandboxed, guardFor } = await import("../../../netlify/lib/crm/core/context.mjs");
const { rotorFieldsChanged, MIRRORED_TYPES } = await import("../../../netlify/lib/crm/core/guard.mjs");
const { setNow } = await import("../../../netlify/lib/crm/core/clock.mjs");
const { RegistryError } = await import("../../../netlify/lib/crm/core/errors.mjs");

// A mirrored test type (a stand-in for job/visit/invoice...).
registerType(defineType({
  type: "gizmo", prefix: "gz", v: 1, mirrored: true,
  validate: (d) => d,
  rotorFields: ["title", "status", "flags.vendor", "rotor"],
  techFields: ["id", "title"],
  example: () => ({ title: "Example", contact_id: "ct_00000000000000000001" }),
}), "test");

const IMPORTED = "ct_0000000000000000000a";   // an imported customer (Rotor owns it)
const TESTER = "ct_0000000000000000000b";     // a test contact
const SHADOW = "ct_0000000000000000000c";     // created in the CRM, never imported
const ROTOR = { system_of_record: "rotor", paused: false };
const auto = (extra = {}) => ({ by: "system", origin: "worker", actor_kind: "automation", requestId: "g", mode: ROTOR, ...extra });
const human = (extra = {}) => ({ by: "us_owner", origin: "api", actor_kind: "user", requestId: "g", mode: ROTOR, ...extra });
const importer = { by: "import", origin: "import", actor_kind: "import", requestId: "g", mode: ROTOR };

let S;
beforeEach(async () => {
  S = useCrmStores(createCrmStores());
  setNow("2026-11-17T15:00:00Z");
  await S.data.setJSON(K.rec("contact", IMPORTED), { id: IMPORTED, type: "contact", wv: 1, import: { run_id: "ir_1", at: "2026-11-10T00:00:00Z", hash: "h" } });
  await S.data.setJSON(K.rec("contact", TESTER), { id: TESTER, type: "contact", wv: 1, import: { run_id: "ir_1", at: "2026-11-10T00:00:00Z", hash: "h" }, flags: { test: true } });
  await S.data.setJSON(K.rec("contact", SHADOW), { id: SHADOW, type: "contact", wv: 1, shadow: true });
});
afterEach(() => { clearCrmStores(); setNow(null); });

test("sandboxed: CRM-made records the import never linked, and anything of a test contact", () => {
  assert.equal(sandboxed({ shadow: true }), true);
  assert.equal(sandboxed({ shadow: true, import: { run_id: "ir_1" } }), false, "a shadow record the import linked is Rotor's again");
  assert.equal(sandboxed({ import: { run_id: "ir_1" } }, { flags: { test: true } }), true);
  assert.equal(sandboxed({ type: "contact", flags: { test: true } }), true);
  assert.equal(sandboxed({}), false);
  assert.equal(sandboxed(null, null), false);
  assert.equal(guardFor({ system_of_record: "crm" }).mayAct({ import: {} }), true);
  assert.equal(guardFor(ROTOR).mayAct({ import: {} }), false);
  assert.equal(guardFor(ROTOR).mayAct({ record: { import: {} }, contact: { flags: { test: true } } }), true);
  assert.equal(guardFor(undefined).mayAct({ shadow: true }), true, "no mode read yet counts as Rotor");
  assert.deepEqual(rotorFieldsChanged(["a", "flags.vendor"], { a: 1, flags: { vendor: false } }, { a: 1, flags: { vendor: true } }), ["flags.vendor"]);
  assert.deepEqual([...MIRRORED_TYPES].sort(), ["agreement", "conversation", "invoice", "job", "message", "payment", "plan", "quote", "visit"]);
});

test("automation creating a mirrored record for an imported customer → ParallelRunGuard, nothing written", async () => {
  await assert.rejects(createRecord("gizmo", { title: "Spring wash", contact_id: IMPORTED }, auto()), ParallelRunGuard);
  assert.deepEqual(S.data.keys("rec/gizmo/"), []);
  assert.deepEqual(S.data.keys("pend/"), []);
});

test("automation may create mirrored records for test and shadow contacts", async () => {
  await createRecord("gizmo", { title: "Test wash", contact_id: TESTER }, auto());
  await createRecord("gizmo", { title: "Shadow wash", contact_id: SHADOW }, auto());
  assert.equal(S.data.keys("rec/gizmo/").length, 2);
});

test("automation with no contact at all fails closed", async () => {
  await assert.rejects(createRecord("gizmo", { title: "Orphan" }, auto()), ParallelRunGuard);
});

test("imports and people pass; after cutover automation passes too", async () => {
  await createRecord("gizmo", { title: "Imported job", contact_id: IMPORTED, import: { run_id: "ir_1", at: "x", hash: "h" } }, importer);
  await createRecord("gizmo", { title: "Booked by Alex", contact_id: IMPORTED }, human());
  await createRecord("gizmo", { title: "After cutover", contact_id: IMPORTED }, auto({ mode: { system_of_record: "crm", paused: false } }));
  assert.equal(S.data.keys("rec/gizmo/").length, 3);
});

test("automation changing a rotorField of an imported record → ParallelRunGuard; CRM-owned fields are fine", async () => {
  const { data } = await createRecord("gizmo", { title: "Imported job", status: "open", contact_id: IMPORTED, import: { run_id: "ir_1", at: "x", hash: "h" } }, importer);
  await assert.rejects(updateRecord("gizmo", data.id, (g) => ({ ...g, status: "archived" }), auto()), ParallelRunGuard);
  await assert.rejects(updateRecord("gizmo", data.id, (g) => ({ ...g, flags: { vendor: true } }), auto()), ParallelRunGuard);
  const ok = await updateRecord("gizmo", data.id, (g) => ({ ...g, stale: true }), auto());
  assert.equal(ok.data.stale, true);
  assert.equal((await getRecord("gizmo", data.id)).data.status, "open");
  await assert.rejects(softDelete("gizmo", data.id, auto()), ParallelRunGuard);
  // people and the import itself may change Rotor's fields
  await updateRecord("gizmo", data.id, (g) => ({ ...g, status: "archived" }), human());
  await updateRecord("gizmo", data.id, (g) => ({ ...g, title: "Re-imported" }), importer);
});

test("automation may change rotorFields of an imported record whose contact is a test contact", async () => {
  const { data } = await createRecord("gizmo", { title: "Test job", status: "open", contact_id: TESTER, import: { run_id: "ir_1", at: "x", hash: "h" } }, importer);
  const r = await updateRecord("gizmo", data.id, (g) => ({ ...g, status: "done" }), auto());
  assert.equal(r.data.status, "done");
});

test("the registry insists that Rotor-mirrored types say mirrored: true", () => {
  assert.throws(() => defineType({ type: "invoice", prefix: "in", v: 1, validate: (d) => d, rotorFields: [], techFields: [], example: () => ({}) }), RegistryError);
});
