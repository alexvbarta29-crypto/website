// M8 acceptance: the full synthetic rehearsal (design §11.4 "rehearsal.
// test.mjs", §10.1, §10.9): export → pack → upload (with the automatic
// daily import key) → import → a simulated parallel week (every sweep, both
// lanes, Rotor in charge: nothing Rotor owns changes, nothing mirrored is
// made) → a daily import of the newer export (updates and adds, 0
// conflicts) → the checklist, the preview, the switch → the first live day
// in test mode (customers are never reached: test mode sends only to the
// staff allowlist; nothing reaches the network). Synthetic export only, a
// throwaway key pair, a pinned clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { crmTest } from "../../helpers/crm-http.mjs";
import { advance, hours, pin } from "../../helpers/crm-clock.mjs";
import { team, store, officeData, runToEnd, rotorSnapshot, runner } from "../import/fixtures.mjs";
import { writeExport } from "../fixtures/rotor-synthetic.mjs";

const pack = await import("../../../build/crm_import_pack.mjs");
const uploadCli = await import("../../../build/crm_import_upload.mjs");
const L = await import("../../../netlify/lib/crm/core/lanes.mjs");
const C = await import("../../../netlify/lib/crm/modules/import/cutover.mjs");
const clock = await import("../../../netlify/lib/crm/core/clock.mjs");
const crmApi = (await import("../../../netlify/functions/crm-api.mjs")).default;
const HOST = "https://www.bartawindowwashing.com";
const SID = "AC" + "0123456789abcdef".repeat(2);
const ENV = {
  CONTEXT: "production", CRM_PRODUCTION: "1", CRM_KEY_SALT: "test-salt-not-real", CRM_SETUP_CODE: "test-setup-code",
  TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: "test-auth-token-not-real", POSTMARK_SERVER_TOKEN: "pm-test-token",
  STRIPE_SECRET_KEY: "test-live-key-not-real", STRIPE_TEST_SECRET_KEY: "test-test-key-not-real",
};
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "barta-rehearsal-test-"));
const quiet = () => { const lines = []; return { log: (s) => lines.push(String(s)), error: (s) => lines.push("ERR " + String(s)), lines }; };
const apiFetch = () => async (url, init = {}) => crmApi(new Request(url, init), {});
const W = (u) => ({ by: u.id, origin: "api", actor_kind: "user", requestId: "test" });
const MIRRORED = ["invoice", "job", "message", "conversation", "visit", "payment", "quote", "plan"];

test("the rehearsal: export → pack → upload → import → a parallel week → a daily import → switch → the first live day in test mode", async () => {
  const keys = officeData.newKeyPair();
  const keyDir = tmp(), ex = tmp(), out = tmp(), out2 = tmp();
  writeFileSync(path.join(keyDir, "public.pem"), keys.publicKeyPem);
  const prevKey = process.env.OFFICE_DATA_KEY;
  process.env.OFFICE_DATA_KEY = keys.privateKey;
  // Monday Dec 28, 2026, 08:00 in Delano: the rehearsal sign-off date
  const t = await crmTest({ now: "2026-12-28T14:00:00Z", env: ENV });
  runner.IMPORT_LIMITS.stepRows = Infinity;
  try {
    const { owner } = await team(t);
    // (the free batch geocoder would call out from a production deploy: off for a test that must not reach the network)
    const mapCfg = await store.getSettingWithEtag("map");
    await store.putSetting("map", { ...mapCfg.data, geocoding: { batch: "off", reverse: "off" } }, { ...W(owner), ifMatch: mapCfg.etag || "new" });

    // ---- export (synthetic, Rotor's layout) → pack → upload with the automatic import key → import
    writeExport(ex, { scale: 0.02, seed: 11 });
    // two visits on Rotor's schedule right after the switch (Tue Jan 5 and Wed Jan 6), and Rotor's own
    // 2-day REMINDER for the first, sent Sunday: the CRM must remind the second and never the first
    const rows = (f) => readFileSync(path.join(ex, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const visits = rows("visits.jsonl");
    const [va, vb] = visits.filter((v) => v.status === "scheduled" && v.customer && v.customer.id).slice(0, 2);
    const extra = [{ ...va, id: 990001, start: "2027-01-05T15:00:00+00:00", end: "2027-01-05T17:00:00+00:00" }, { ...vb, id: 990002, start: "2027-01-06T15:00:00+00:00", end: "2027-01-06T17:00:00+00:00" }];
    writeFileSync(path.join(ex, "visits.jsonl"), [...visits, ...extra].map((x) => JSON.stringify(x)).join("\n") + "\n");
    const msgs = rows("messages.jsonl");
    const out1 = msgs.find((m) => m.direction === "outbound" && m.channel === "sms" && m.contact_id === va.customer.id) || msgs.find((m) => m.direction === "outbound" && m.channel === "sms");
    msgs.push({ ...out1, id: "rehearsal-reminder-1", contact_id: va.customer.id, contact_type: "customer", content: "REMINDER: Hi there, Barta Window Washing is scheduled to visit on Tue, Jan 5, between 9:00 and 11:00 AM. Reply if you have any questions!", attachments: [], status: "delivered", created_at: "2027-01-03T16:00:00.000000+00:00" });
    writeFileSync(path.join(ex, "messages.jsonl"), msgs.map((x) => JSON.stringify(x)).join("\n") + "\n");
    assert.equal(pack.main([ex, out, "--as-of", "2026-12-28", "--public-key", path.join(keyDir, "public.pem")], quiet()), 0);
    const made = await t.api("/import/auto-key", { method: "POST", as: owner, body: {} });
    assert.equal(made.status, 201);
    const keyFile = path.join(keyDir, "auto-key.txt");
    writeFileSync(keyFile, made.body.data.key + "\n");
    const io = quiet();
    assert.equal(await uploadCli.main([out, "--site", HOST, "--key-file", keyFile, "--no-media"], { env: {}, fetch: apiFetch(), sleep: async () => {}, ...io }), 0, io.lines.join("\n"));
    const runId = io.lines.join("\n").match(/run (ir_[0-9a-z]{20}) started/)[1];
    const first = await runToEnd(t, owner, runId, { start: false });
    assert.equal(first.run.status, "done");
    assert.equal(first.run.summary.conflicts_open, 0);
    assert.ok(first.run.summary.created > 100);
    const snap = await rotorSnapshot(t.stores);

    // ---- the parallel week: every sweep on both lanes, hour by hour, Rotor in charge
    for (let h = 0; h < 24 * 6; h++) {
      await t.runWorker({ lane: "fast" });
      await t.runWorker({ lane: "bulk" });
      advance(hours(1));
    }
    assert.deepEqual(await rotorSnapshot(t.stores), snap, "a week of automation changed no Rotor-owned field");
    for (const type of MIRRORED) {
      const byAutomation = t.stores.data.keys(`rec/${type}/`).filter((k) => t.stores.data.json(k).created_by !== "import");
      assert.deepEqual(byAutomation, [], `no ${type} made by automation while Rotor is in charge`);
    }
    const outBefore = t.stores.data.keys("rec/outbox/").map((k) => t.stores.data.json(k));
    assert.ok(outBefore.every((o) => o.mode === "dry_run" || o.mode === "blocked"), "every send before the switch stayed on the site");
    assert.deepEqual(t.fetchCalls(), [], "nothing reached the network");

    // ---- Sunday night's export (Jan 3): the daily import with the same key; nothing changed in Rotor since → 0 conflicts
    pin("2027-01-04T12:00:00Z");                                   // Mon Jan 4, 06:00
    assert.equal(pack.main([ex, out2, "--as-of", "2027-01-04", "--public-key", path.join(keyDir, "public.pem")], quiet()), 0);
    const io2 = quiet();
    assert.equal(await uploadCli.main([out2, "--site", HOST, "--key-file", keyFile, "--no-media"], { env: {}, fetch: apiFetch(), sleep: async () => {}, ...io2 }), 0, io2.lines.join("\n"));
    const run2 = io2.lines.join("\n").match(/run (ir_[0-9a-z]{20}) started/)[1];
    const second = await runToEnd(t, owner, run2, { start: false });
    assert.equal(second.run.status, "done");
    assert.equal(second.run.summary.conflicts_open, 0);
    assert.equal(second.run.summary.created, 0, "nothing new");
    assert.deepEqual(await rotorSnapshot(t.stores), snap);

    // ---- the checklist: the owner connects the providers, ticks what only the owner can confirm
    const cur = await store.getSettingWithEtag("integrations");
    await store.putSetting("integrations", {
      ...cur.data, sms: { ...cur.data.sms, mode: "live", from: "+17633143400", test_from: "+17635550111", test_allowlist: ["+17635550150"] },
      email: { ...cur.data.email, mode: "live", test_allowlist: ["staff@example.com"] }, payments: { ...cur.data.payments, mode: "live" },
    }, { ...W(owner), ifMatch: cur.etag || "new" });
    const now = clock.nowIso();
    await L.updateHealth((h) => ({ ...h, offsite_at: now, lanes: { fast: { last_pass_at: now }, bulk: { last_pass_at: now } } }));
    for (const it of C.OWNER_ITEMS) await t.api("/cutover/ticks", { method: "POST", as: owner, body: { key: it.key, done: true } });
    pin("2027-01-04T12:30:00Z");                                   // 06:30: the preview
    assert.equal((await t.api("/cutover/preview", { method: "POST", as: owner, body: {} })).status, 202);
    for (let i = 0; i < 3; i++) await t.runWorker({ lane: "bulk" });
    const pv = (await t.api("/cutover/preview", { as: owner })).body.data.result;
    assert.equal(pv.days.length, 4);
    const two = pv.automations.find((a) => a.key === "visit.reminder_2d");
    assert.ok(two.by_day[0].texts >= 1, "Monday 10:00: the Jan 6 visit is reminded");
    assert.ok(pv.seeds.reminder >= 1, "Rotor's Sunday reminder counts as sent");
    assert.ok(pv.automations.length >= 10, "every registered automation is listed");
    assert.equal(pv.import_run_id || second.run.id, second.run.id);
    assert.equal((await t.api("/cutover/approve-preview", { method: "POST", as: owner, body: {} })).status, 200);
    const list = (await t.api("/cutover", { as: owner })).body.data;
    assert.deepEqual(list.items.filter((i) => i.state !== "ok").map((i) => i.key), []);

    // ---- 09:30: the switch
    pin("2027-01-04T15:30:00Z");
    const passed = clock.nowIso();                                 // (the worker kept passing all morning)
    await L.updateHealth((h) => ({ ...h, lanes: { fast: { last_pass_at: passed }, bulk: { last_pass_at: passed } } }));
    const go = await t.api("/cutover/run", { method: "POST", as: owner, body: { confirm: "SWITCH TO CRM" } });
    assert.equal(go.status, 202, JSON.stringify(go.body));
    for (let i = 0; i < 6 && (((await store.getRaw("sys/mode")) || {}).data || {}).system_of_record !== "crm"; i++) await t.runWorker({ lane: "bulk" });
    const mode = (await store.getRaw("sys/mode")).data;
    assert.equal(mode.system_of_record, "crm");
    const op = (await store.getRaw("op/cutover--1")).data;
    assert.equal(op.status, "done");
    const maxJob = Math.max(...t.stores.data.keys("ptr/job-no/").map((k) => Number(k.split("/").pop())));
    assert.equal((await store.getRaw("seq/job")).data.next, maxJob + 1, "the CRM's job numbers go on from Rotor's");

    // ---- the first live day in test mode: the owner keeps texts and emails in test mode for the day
    const c2 = await store.getSettingWithEtag("integrations");
    await store.putSetting("integrations", { ...c2.data, sms: { ...c2.data.sms, mode: "test" }, email: { ...c2.data.email, mode: "test" }, payments: { ...c2.data.payments, mode: "test" } }, { ...W(owner), ifMatch: c2.etag });
    const outCount = t.stores.data.keys("rec/outbox/").length;
    for (let h = 0; h < 12; h++) {
      await t.runWorker({ lane: "fast" });
      await t.runWorker({ lane: "bulk" });
      advance(hours(1));
    }
    const after = t.stores.data.keys("rec/outbox/").map((k) => t.stores.data.json(k)).filter((o) => Date.parse(o.created_at) >= Date.parse(op.input.at));
    assert.ok(t.stores.data.keys("rec/outbox/").length >= outCount);
    assert.ok(after.every((o) => o.mode !== "dry_run"), "after the switch nothing is dry-run any more");
    assert.ok(after.length >= 1, "the first morning's batch ran");
    assert.ok(after.every((o) => o.mode === "blocked" || (o.mode === "test" && ["+17635550150", "staff@example.com"].includes(o.to))), "test mode: customers are never reached");
    assert.deepEqual(t.fetchCalls(), [], "nothing reached the network");
    // what Rotor already sent is never sent again: no send went to a step whose marker the switch seeded
    const seeded = t.stores.data.keys("done/").filter((k) => (t.stores.data.json(k) || {}).result === "seeded_from_rotor");
    assert.ok(seeded.length >= 1);
    for (const k of seeded) assert.equal(t.stores.data.json(k).state, "done", k);
    const vA = (await store.readPointer("rotor/visit", "990001")) || {};
    const vB = (await store.readPointer("rotor/visit", "990002")) || {};
    const reminded = after.filter((o) => o.template_key === "visit_reminder_2d").map((o) => o.related && o.related.visit_id);
    assert.ok(vA.id && vB.id, "both visits came in");
    assert.ok(reminded.includes(vB.id), "the Jan 6 visit is reminded (test mode: blocked for the customer)");
    assert.ok(!reminded.includes(vA.id), "Rotor already reminded the Jan 5 visit: not again");
    assert.ok(!t.stores.data.keys("q/").some((k) => (t.stores.data.json(k).marker || {}).ns === "done-dry"), "nothing waits in dry-run");
  } finally {
    if (prevKey === undefined) delete process.env.OFFICE_DATA_KEY; else process.env.OFFICE_DATA_KEY = prevKey;
    for (const d of [keyDir, ex, out, out2]) rmSync(d, { recursive: true, force: true });
    t.done();
  }
});
