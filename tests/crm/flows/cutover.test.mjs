// M8 acceptance: the switch from Rotor (design §11.4 "cutover.test.mjs",
// §10.9, §5.7.4, §12.3 suite 13). The preview shows per-automation counts
// for the switch + 0..72 h; imported Rotor REMINDER, overdue, receipt and
// agreement texts become seeded markers and suppress the matching live
// sends; sequences started in dry-run are cancelled; the floor keeps
// imported completed jobs out of review requests and imported invoices out
// of overdue reminders; cutover--2 after a rollback re-seats the numbers
// above those issued meanwhile. Synthetic records only (555 numbers,
// example.com), a pinned clock (Mon Jan 4, 2027, 09:00 in Delano), a
// production-like deploy with made-up keys: nothing reaches the network
// (test mode after the switch reaches only the staff allowlist).
import { test } from "node:test";
import assert from "node:assert/strict";
import { crmTest } from "../../helpers/crm-http.mjs";
import { make } from "../../helpers/crm-fixtures.mjs";
import { pin, advance, hours } from "../../helpers/crm-clock.mjs";

const store = await import("../../../netlify/lib/crm-store.mjs");
await import("../../../netlify/lib/crm/modules/index.mjs");
const OFF = await import("../../../netlify/lib/crm/modules/work/office.mjs");
const T = await import("../../../netlify/lib/crm/core/templates.mjs");
const L = await import("../../../netlify/lib/crm/core/lanes.mjs");
const C = await import("../../../netlify/lib/crm/modules/import/cutover.mjs");
const PV = await import("../../../netlify/lib/crm/modules/import/cutover-preview.mjs");
const Q = await import("../../../netlify/lib/crm/core/queue.mjs");
const SW = await import("../../../netlify/lib/crm/core/sweeps.mjs");
const services = await import("../../../netlify/lib/crm/core/services.mjs");

const SID = "AC" + "0123456789abcdef".repeat(2);
const ENV = {
  CONTEXT: "production", CRM_PRODUCTION: "1", CRM_KEY_SALT: "test-salt-not-real", CRM_SETUP_CODE: "test-setup-code",
  TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: "test-auth-token-not-real", POSTMARK_SERVER_TOKEN: "pm-test-token",
  STRIPE_SECRET_KEY: "test-live-key-not-real", STRIPE_TEST_SECRET_KEY: "test-test-key-not-real",
};
const MON_0900 = "2027-01-04T15:00:00Z";
const IMPORT = { by: "import", origin: "import", actor_kind: "import", requestId: "test" };
const AUTOMATION = { by: "system:test", origin: "worker", actor_kind: "automation", requestId: "test" };
const IB = { run_id: "ir_00000000000000000001", at: "2026-12-20T00:00:00.000Z", hash: "0".repeat(64) };
const W = (u) => ({ by: u.id, origin: "api", actor_kind: "user", requestId: "test" });

let n = 0;
const imp = async (type, data) => (await store.createRecord(type, { ...make(type), ...data, import: IB }, IMPORT)).data;
async function contact(fields = {}) {
  n += 1;
  return (await store.createRecord("contact", {
    first_name: "Robin", last_name: `Imported${n}`, phones: [{ e164: `+1763555${String(1300 + n).padStart(4, "0")}`, sms: true }], emails: [{ address: `robin.imported${n}@example.com` }],
    lifecycle: "customer", consent: { sms_service: { state: "granted", source: "import" } }, source: { source: "Returning Customer" },
    billing_address: { street1: `${200 + n} Example Ave`, city: "Mound", state: "MN", zip: "55364" }, import: IB, ...fields,
  }, IMPORT)).data;
}
async function visitFor(c, date) {
  const [jobId] = await OFF.createJobs([{ contact_id: c.id, kind: "standard", lines: [{ title: "Window cleaning", unit_cents: 25000 }] }], `import-job-${c.id}-${date}`, "import", IMPORT);
  return (await OFF.createVisit({ job_id: jobId, date, start: "09:00", end: "11:00", window: { type: "exact", minutes: 0 } }, IMPORT)).visit;
}
// A Rotor text the import brought in (comms import's shape: provider rotor_import, rotor.msg_class).
async function rotorText(c, cls, body, sentAt) {
  const cv = (await store.createRecord("conversation", { ...make("conversation"), contact_id: c.id, address: c.phones[0].e164, contact_name: c.first_name, last_at: sentAt, last_preview: body.slice(0, 60) }, IMPORT)).data;
  return imp("message", { conversation_id: cv.id, contact_id: c.id, to: c.phones[0].e164, body_text: body, provider: "rotor_import", status: "delivered", sent_at: sentAt, created_at: sentAt, rotor: { message_id: `m-${cls}-${c.id}`, msg_class: cls } });
}
const outbox = (t) => t.stores.data.keys("rec/outbox/").map((k) => t.stores.data.json(k));
const alog = (t) => t.stores.data.keys("alog/").join("\n");

// Everything the checklist can check, made green (a production-like deploy, keys present).
async function green(t, owner) {
  const cur = await store.getSettingWithEtag("integrations");
  await store.putSetting("integrations", {
    ...cur.data, sms: { ...cur.data.sms, mode: "live", from: "+17633143400", test_from: "+17635550111", test_allowlist: ["+17635550150"] },
    email: { ...cur.data.email, mode: "live", test_allowlist: ["staff@example.com"] }, payments: { ...cur.data.payments, mode: "live" },
  }, { ...W(owner), ifMatch: cur.etag || "new" });
  // (the invocation loop writes each lane's last pass; the test's single passes don't)
  const passed = (await import("../../../netlify/lib/crm/core/clock.mjs")).nowIso();
  await L.updateHealth((h) => ({ ...h, offsite_at: new Date(Date.parse(MON_0900) - 3 * 86400000).toISOString(), lanes: { fast: { last_pass_at: passed }, bulk: { last_pass_at: passed } } }));
  await t.runWorker({ lane: "fast" });
  await t.runWorker({ lane: "bulk" });
  // the final import (synthetic: the records above stand for what it brought in)
  await store.createRecord("import_run", { status: "done", as_of: "2027-01-04", requested_by: owner.id, attempt: 0, started_at: new Date(Date.parse(MON_0900) - 2 * 3600000).toISOString(), finished_at: new Date(Date.parse(MON_0900) - 3600000).toISOString(), summary: { created: 1, updated: 0, conflicts_open: 0 }, conflicts: { open: 0, resolved: 0 } }, IMPORT);
  for (const it of C.OWNER_ITEMS) assert.equal((await t.api("/cutover/ticks", { method: "POST", as: owner, body: { key: it.key, done: true } })).status, 200);
}
async function previewNow(t, owner) {
  const p = await t.api("/cutover/preview", { method: "POST", as: owner, body: {} });
  assert.equal(p.status, 202, JSON.stringify(p.body));
  for (let i = 0; i < 3; i++) await t.runWorker({ lane: "bulk" });
  const got = await t.api("/cutover/preview", { as: owner });
  assert.equal(got.status, 200);
  assert.equal(got.body.data.state.status, "done");
  return got.body.data.result;
}
async function stepUntilDone(t, kind = "cutover.switch") {
  for (let i = 0; i < 10; i++) {
    await t.runWorker({ lane: "bulk" });
    const runs = t.stores.data.keys("rec/run/").map((k) => t.stores.data.json(k)).filter((r) => r.kind === kind);
    // every run of the kind finished, one of them done (an earlier try may have failed)
    if (runs.length && runs.every((r) => ["done", "failed"].includes(r.status)) && runs.some((r) => r.status === "done")) return runs;
  }
  throw new Error(`${kind} did not finish`);
}

async function world(t, owner) {
  await T.seedTemplates(AUTOMATION);
  T.clearTemplateSeedCache();
  SW.clearSweepCache();
  const A = await contact(), B = await contact(), Cc = await contact(), D = await contact();
  // visits: V1 Tue Jan 5 (Rotor's 2-day REMINDER went out Sun Jan 3), V2 Wed Jan 6 (not yet reminded),
  // V3 Mon Jan 18 (14 days out, not yet reminded), V4 Fri Jan 15 (Rotor's 14-day REMINDER went out Fri Jan 1)
  const V1 = await visitFor(A, "2027-01-05"), V2 = await visitFor(B, "2027-01-06"), V3 = await visitFor(Cc, "2027-01-18"), V4 = await visitFor(A, "2027-01-15");
  await rotorText(A, "reminder", "REMINDER: Hi Robin, Barta Window Washing is scheduled to visit on Tue, Jan 5, between 9:00 and 11:00 AM. Reply if you have any questions!", "2027-01-03T16:00:00.000Z");
  await rotorText(A, "reminder", "REMINDER: Hi Robin, Barta Window Washing is scheduled to visit on Fri, Jan 15. Reply if you have any questions!", "2027-01-01T16:00:00.000Z");
  // an open invoice Rotor issued (overdue) with Rotor's overdue text; a payment and its receipt; an unsigned agreement and its reminder
  const inv = await imp("invoice", { number: "INV-0601", seq: "invoice", n: 601, contact_id: B.id, contact_name: B.first_name, status: "open", issued_on: "2026-12-01", due_on: "2026-12-20", total_cents: 29500, balance_cents: 29500 });
  await rotorText(B, "overdue", "Hi Robin, your invoice from Barta Window Washing is still outstanding: INV-0601 for $295.00. Pay here: https://example.com/pay", "2026-12-28T16:00:00.000Z");
  const pay = await imp("payment", { contact_id: Cc.id, received_on: "2026-12-30", created_at: "2026-12-30T18:00:00.000Z" });
  await rotorText(Cc, "receipt", "Thanks for your payment! Your receipt from Barta Window Washing: https://example.com/r", "2026-12-30T18:05:00.000Z");
  const ag = await imp("agreement", { contact_id: A.id, contact_name: A.first_name, status: "sent", sent_at: "2026-12-29T16:00:00.000Z" });
  await rotorText(A, "agreement", "Hi Robin, your agreement from Barta Window Washing is awaiting your signature.", "2027-01-04T14:00:00.000Z");
  // a job Rotor completed on Saturday (imported): never asked for a review
  const done = await imp("job", { number: 880, seq: "job", number_label: "0000880", contact_id: D.id, status: "completed", completed_at: "2027-01-02T20:00:00.000Z" });
  // numbers Rotor issued: jobs up to 0000884, sequential invoices up to INV-0609 (and a random 6-digit one), quotes up to 18640
  for (const num of [881, 882, 883, 884]) await imp("job", { number: num, seq: "job", number_label: String(num).padStart(7, "0"), contact_id: D.id });
  await imp("invoice", { number: "INV-0609", seq: "invoice", n: 609, contact_id: D.id, status: "void", voided_at: "2026-12-01T00:00:00.000Z", total_cents: 1000, balance_cents: 0 });
  await imp("invoice", { number: "INV-482913", seq: "invoice", n: 482913, contact_id: D.id, status: "void", voided_at: "2026-12-01T00:00:00.000Z", total_cents: 1000, balance_cents: 0 });
  await imp("quote", { number: 18640, number_seq: "quote", contact_id: D.id, contact_name: D.first_name });
  // a review step queued in dry-run before the switch (a shadow job's step 2): cancelled at the switch
  await Q.enqueue("automation.send", { type: "job", id: done.id }, {}, "2027-01-05T17:00:00.000Z", { ns: "done-dry", scope: "review.sequence", key: `${done.id}--2` }, { data: { automation: "review.sequence", contact_id: D.id, channel: "sms", template_key: "review_2" }, kick: false });
  return { A, B, Cc, D, V1, V2, V3, V4, inv, pay, ag, done };
}

test("the checklist: red until each item is done; the owner's items are ticks only an owner can make", async () => {
  const t = await crmTest({ now: MON_0900, env: ENV });
  try {
    const owner = await t.user("owner");
    const admin = await t.user("admin");
    assert.equal((await t.api("/cutover", { as: admin })).status, 403, "owners only");
    const first = (await t.api("/cutover", { as: owner })).body.data;
    assert.equal(first.ready, false);
    assert.equal(first.rehearsal, false, "the production deploy");
    const byKey = Object.fromEntries(first.items.map((i) => [i.key, i]));
    for (const k of ["stripe", "twilio", "email", "final_import", "preview", "rotor_off", "backup"]) assert.equal(byKey[k].state, "todo", k);
    assert.equal(byKey.setup.state, "ok", "the Netlify settings are in");
    assert.equal(byKey.rotor_off.kind, "owner");
    assert.match(byKey.rotor_off.label, /Rotor's automations switched off by you/);
    assert.equal((await t.api("/cutover/ticks", { method: "POST", as: owner, body: { key: "stripe", done: true } })).status, 400, "an item the CRM checks can't be ticked");
    assert.equal((await t.api("/cutover/ticks", { method: "POST", as: admin, body: { key: "rotor_off", done: true } })).status, 403);
    // the switch refuses while anything is red, whatever is typed
    const no = await t.api("/cutover/run", { method: "POST", as: owner, body: { confirm: "SWITCH TO CRM" } });
    assert.equal(no.status, 409);
    assert.match(no.body.error.message, /items on the checklist aren't done/);
    assert.equal((await t.api("/cutover/run", { method: "POST", as: owner, body: { confirm: "switch to crm" } })).status, 400, "typed exactly");
    assert.equal((await store.getRaw("sys/mode")), null, "nothing changed");
  } finally { t.done(); }
});

test("preview, switch, the first live morning: seeded markers suppress, the floor holds, dry-run sequences are cancelled, numbers continue Rotor's", async () => {
  const t = await crmTest({ now: MON_0900, env: ENV });
  try {
    const owner = await t.user("owner");
    const w = await world(t, owner);
    await green(t, owner);

    // ---- the preview (Mon 09:00, the switch at 09:00): counts per automation and day, nothing written but itself
    const keysBefore = t.stores.data.keys("").filter((k) => !/^(rec\/run|ix\/runs|evt\/run|aud\/|pend\/|cutover\/|sys\/)/.test(k)).sort();
    const pv = await previewNow(t, owner);
    const after = t.stores.data.keys("").filter((k) => !/^(rec\/run|ix\/runs|evt\/run|aud\/|pend\/|cutover\/|sys\/)/.test(k)).sort();
    assert.deepEqual(after.filter((k) => !keysBefore.includes(k) && !/^(done\/sweep|thr\/|lease\/|ix-dirty\/)/.test(k)), [], "the preview leaves no markers, outbox items or records");
    assert.deepEqual(pv.days, ["2027-01-04", "2027-01-05", "2027-01-06", "2027-01-07"]);
    const auto = Object.fromEntries(pv.automations.map((a) => [a.key, a]));
    // Mon 10:00: V2 is 2 days out (V1 was reminded by Rotor: seeded); V3 is 14 days out (V4 was reminded by Rotor)
    assert.deepEqual(auto["visit.reminder_2d"].by_day.map((d) => d.texts), [1, 0, 0, 0]);
    assert.deepEqual(auto["visit.reminder_14d"].by_day.map((d) => [d.texts, d.emails]), [[1, 1], [0, 0], [0, 0], [0, 0]]);
    assert.equal(auto["invoice.overdue"].total.texts, 0, "an imported invoice is never reminded");
    assert.ok(auto["agreement.unsigned"].total.texts >= 1, "Rotor's agreement goes on being reminded from Tuesday");
    assert.equal(auto["agreement.unsigned"].by_day[0].texts, 0, "Monday's reminder already went out from Rotor (seeded)");
    assert.equal(auto["review.sequence"].total.texts, 0);
    assert.equal(auto["lead.ack"].kind, "on_activity");
    assert.equal(pv.floor.imported_completed_jobs, 1, "the floor keeps the job Rotor completed out of review requests");
    assert.equal(pv.floor.imported_invoices, 1, "and Rotor's open invoice out of overdue reminders");
    assert.deepEqual({ reminder: pv.seeds.reminder, overdue: pv.seeds.overdue, receipt: pv.seeds.receipt, agreement: pv.seeds.agreement }, { reminder: 2, overdue: 1, receipt: 1, agreement: 1 });
    assert.equal(pv.sequences.dry_sends, 1);
    assert.deepEqual(pv.numbers, { job: 885, invoice: 610, quote: 18641 });
    assert.deepEqual(pv.totals, pv.by_day.reduce((s, d) => ({ texts: s.texts + d.texts, emails: s.emails + d.emails, invoices: s.invoices + d.invoices, charges: s.charges + d.charges }), { texts: 0, emails: 0, invoices: 0, charges: 0 }));
    assert.ok(auto["visit.reminder_2d"].samples[0].startsWith("REMINDER: Hi Robin"), "a sample render");

    // ---- approve, then the gate is green
    assert.equal((await t.api("/cutover/approve-preview", { method: "POST", as: owner, body: {} })).status, 200);
    const view = (await t.api("/cutover", { as: owner })).body.data;
    assert.deepEqual(view.items.filter((i) => i.state !== "ok").map((i) => i.key), []);
    assert.equal(view.ready, true);

    // ---- the switch: SWITCH TO CRM, a journaled op on the bulk lane
    const go = await t.api("/cutover/run", { method: "POST", as: owner, body: { confirm: "SWITCH TO CRM" } });
    assert.equal(go.status, 202, JSON.stringify(go.body));
    assert.equal(go.body.data.op_id, "cutover--1");
    assert.equal((await t.api("/cutover/run", { method: "POST", as: owner, body: { confirm: "SWITCH TO CRM" } })).status, 409, "a double tap starts nothing");
    await stepUntilDone(t);
    const mode = (await store.getRaw("sys/mode")).data;
    assert.equal(mode.system_of_record, "crm");
    assert.equal(mode.cutover_n, 1);
    const op = (await store.getRaw("op/cutover--1")).data;
    assert.equal(op.status, "done");
    assert.deepEqual(op.out.numbers, { job: 885, invoice: 610, quote: 18641 });
    assert.equal((await store.getRaw("seq/job")).data.next, 885);
    assert.equal((await store.getRaw("seq/invoice")).data.next, 610, "Rotor's random 6-digit numbers are kept apart");
    assert.equal((await store.getRaw("seq/quote")).data.next, 18641);
    // seeded markers, live namespace
    for (const k of [`done/visit.reminder_2d/${w.V1.id}--2027-01-05`, `done/visit.reminder_14d/${w.V4.id}--2027-01-15`, `done/invoice.overdue/${w.inv.id}--1`, `done/payment.receipt/${w.pay.id}`, `done/agreement.unsigned/${w.ag.id}--2027-01-04`]) {
      const m = await store.getRaw(k);
      assert.ok(m && m.data.state === "done" && m.data.result === "seeded_from_rotor", `seeded ${k}`);
    }
    // the dry-run step is gone (cancelled, never resumed)
    assert.ok(!t.stores.data.keys("q/").some((k) => (t.stores.data.json(k).marker || {}).ns === "done-dry"));
    assert.equal(op.out.dry_sends.cancelled, 1);
    // the floor and the switches
    assert.equal((await store.getSetting("automations")).effective_from, op.input.at);
    assert.equal((await store.getSetting("intake")).mode, "crm");
    assert.equal((await store.getSetting("dashboard")).source, "crm");
    for (let i = 0; i < 2; i++) await t.runWorker({ lane: "fast" });
    assert.ok(t.stores.data.keys("rec/notification/").map((k) => t.stores.data.json(k)).some((x) => x.title === "The CRM is in charge now"));

    // ---- the first morning (the owner keeps texts in test mode: staff phones only)
    const cur = await store.getSettingWithEtag("integrations");
    await store.putSetting("integrations", { ...cur.data, sms: { ...cur.data.sms, mode: "test" }, email: { ...cur.data.email, mode: "test" } }, { ...W(owner), ifMatch: cur.etag });
    pin("2027-01-04T16:00:00Z");                                 // 10:00: the daily batch
    for (let i = 0; i < 6; i++) await t.runWorker({ lane: "fast" });
    const sent = outbox(t);
    const forVisit = (tpl) => sent.filter((o) => o.template_key === tpl).map((o) => o.related && o.related.visit_id);
    assert.deepEqual(forVisit("visit_reminder_2d"), [w.V2.id], "V1 was reminded by Rotor: not again");
    assert.deepEqual(forVisit("visit_reminder_14d"), [w.V3.id], "V4 was reminded by Rotor: not again");
    assert.ok(sent.every((o) => o.mode !== "dry_run"), "after the switch the sends are real (test mode: blocked for customers)");
    assert.ok(sent.filter((o) => /^visit_reminder/.test(o.template_key)).every((o) => o.mode === "blocked" && o.blocked_reason === "test_mode_recipient"));
    assert.ok(!sent.some((o) => o.related && o.related.invoice_id === w.inv.id), "no overdue text for Rotor's invoice");
    assert.ok(!sent.some((o) => o.related && o.related.agreement_id === w.ag.id), "Monday's agreement reminder went out from Rotor: suppressed");
    assert.match(alog(t), new RegExp(`visit\\.reminder_2d--${w.V1.id}--skipped-seeded`));
    assert.match(alog(t), new RegExp(`agreement\\.unsigned--${w.ag.id}--skipped-done`));
    assert.deepEqual(t.fetchCalls(), [], "nothing reached the network");
    // a receipt for the payment Rotor already thanked is never sent again (the marker is final)
    const r = await store.getRaw(`done/payment.receipt/${w.pay.id}`);
    assert.equal(r.data.state, "done");
    // review requests: the job Rotor completed is never asked
    const { runAutomation } = await import("../../../netlify/lib/crm/core/automations.mjs");
    const rv = await runAutomation("review.sequence", { event: { name: "job.completed", event_id: "e1", payload: { job_id: w.done.id, contact_id: w.D.id } } }, { mode: mode });
    assert.match(rv.result, /^skipped:(imported|before_floor)$/);
  } finally { t.done(); }
});

test("rollback within 48 hours, then cutover--2 re-seats the numbers above the ones issued meanwhile", async () => {
  const t = await crmTest({ now: MON_0900, env: ENV });
  try {
    const owner = await t.user("owner");
    const w = await world(t, owner);
    await green(t, owner);
    await previewNow(t, owner);
    await t.api("/cutover/approve-preview", { method: "POST", as: owner, body: {} });
    assert.equal((await t.api("/cutover/run", { method: "POST", as: owner, body: { confirm: "SWITCH TO CRM" } })).status, 202);
    await stepUntilDone(t);
    // the CRM issues numbers after the switch
    assert.equal(await store.nextNumber("job"), 885);
    assert.equal(await store.nextNumber("job"), 886);
    assert.equal(await store.nextNumber("invoice"), 610);
    // a quote the CRM made after the switch (listed for re-entry in Rotor on a rollback)
    advance(hours(1));
    const q = await store.createRecord("quote", { ...make("quote"), number: 18641, number_seq: "quote", contact_id: w.D.id, contact_name: w.D.first_name }, W(owner));

    // ---- rollback: typed, within 48 hours
    assert.equal((await t.api("/cutover/rollback", { method: "POST", as: owner, body: { confirm: "SWITCH TO CRM" } })).status, 400, "its own words");
    const back = await t.api("/cutover/rollback", { method: "POST", as: owner, body: { confirm: "SWITCH BACK TO ROTOR" } });
    assert.equal(back.status, 202, JSON.stringify(back.body));
    assert.equal(back.body.data.op_id, "rollback--1");
    await stepUntilDone(t, "cutover.rollback");
    const m = (await store.getRaw("sys/mode")).data;
    assert.equal(m.system_of_record, "rotor");
    assert.equal((await store.getSetting("intake")).mode, "dual");
    assert.equal((await store.getSetting("dashboard")).source, "rotor");
    const v = (await t.api("/cutover", { as: owner })).body.data;
    assert.ok(v.rollback_list.some((x) => x.type === "quote" && x.id === q.data.id), "what the CRM made is listed for Rotor");
    const items = Object.fromEntries(v.items.map((i) => [i.key, i.state]));
    assert.equal(items.rotor_off, "todo", "Rotor's automations are back on: the tick is cleared");
    assert.equal(items.preview, "todo", "the preview must be approved again");
    for (let i = 0; i < 2; i++) await t.runWorker({ lane: "fast" });
    assert.ok(t.stores.data.keys("rec/notification/").map((k) => t.stores.data.json(k)).some((x) => x.title === "Back on Rotor"));

    // ---- Rotor issued numbers meanwhile: a newer import brings jobs 885-890 (885, 886 were the CRM's) and INV-0610..0612
    for (const num of [887, 888, 889, 890]) await imp("job", { number: num, seq: "job", number_label: String(num).padStart(7, "0"), contact_id: w.D.id });
    for (const num of [611, 612]) await imp("invoice", { number: `INV-0${num}`, seq: "invoice", n: num, contact_id: w.D.id, status: "void", voided_at: "2026-12-01T00:00:00.000Z", total_cents: 1000, balance_cents: 0 });
    await imp("quote", { number: 18642, number_seq: "quote", contact_id: w.D.id, contact_name: w.D.first_name });
    advance(hours(20));
    await store.createRecord("import_run", { status: "done", as_of: "2027-01-05", requested_by: owner.id, attempt: 0, started_at: new Date(Date.now()).toISOString(), finished_at: new Date(Date.parse((await import("../../../netlify/lib/crm/core/clock.mjs")).nowIso()) - 60000).toISOString(), summary: { created: 6, updated: 0, conflicts_open: 0 }, conflicts: { open: 0, resolved: 0 } }, IMPORT);
    const passed = (await import("../../../netlify/lib/crm/core/clock.mjs")).nowIso();
    await L.updateHealth((h) => ({ ...h, lanes: { fast: { last_pass_at: passed }, bulk: { last_pass_at: passed } } }));
    await t.api("/cutover/ticks", { method: "POST", as: owner, body: { key: "rotor_off", done: true } });
    await previewNow(t, owner);
    assert.equal((await t.api("/cutover/approve-preview", { method: "POST", as: owner, body: {} })).status, 200);
    const again = await t.api("/cutover/run", { method: "POST", as: owner, body: { confirm: "SWITCH TO CRM" } });
    assert.equal(again.status, 202, JSON.stringify(again.body));
    assert.equal(again.body.data.op_id, "cutover--2", "a new op, never the first one again");
    await stepUntilDone(t);
    const m2 = (await store.getRaw("sys/mode")).data;
    assert.equal(m2.system_of_record, "crm");
    assert.equal(m2.cutover_n, 2);
    assert.equal((await store.getRaw("seq/job")).data.next, 891, "above Rotor's 890");
    assert.equal((await store.getRaw("seq/invoice")).data.next, 613, "above Rotor's INV-0612");
    assert.equal((await store.getRaw("seq/quote")).data.next, 18643);
    assert.equal(await store.nextNumber("job"), 891);
    const hist = (await t.api("/cutover", { as: owner })).body.data.history.map((h) => [h.kind, h.n, h.status]);
    assert.deepEqual(hist, [["cutover", 2, "done"], ["rollback", 1, "done"], ["cutover", 1, "done"]]);
    // after 48 hours there is no going back from here
    advance(hours(49));
    assert.equal((await t.api("/cutover/rollback", { method: "POST", as: owner, body: { confirm: "SWITCH BACK TO ROTOR" } })).status, 409);
  } finally { t.done(); }
});

test("a crash in the middle of the switch: the op resumes where it stopped and makes nothing twice", async () => {
  const t = await crmTest({ now: MON_0900, env: ENV });
  try {
    const owner = await t.user("owner");
    const w = await world(t, owner);
    await green(t, owner);
    await previewNow(t, owner);
    await t.api("/cutover/approve-preview", { method: "POST", as: owner, body: {} });
    // sales.stopAll fails once (storage): the op stays running and the next pass goes on
    let calls = 0;
    const restore = services.__swapServiceForTests("sales.stopAll", async () => { calls += 1; if (calls === 1) { const { BlobsTransientError } = await import("../../../netlify/lib/crm/core/errors.mjs"); throw new BlobsTransientError("busy"); } return 0; });
    try {
      // an open follow-up on a customer (it ran in dry-run): stopped by the switch
      await store.createRecord("enrollment", { ...make("enrollment"), contact_id: w.B.id, status: "active" }, W(owner)).catch(() => null);
      assert.equal((await t.api("/cutover/run", { method: "POST", as: owner, body: { confirm: "SWITCH TO CRM" } })).status, 202);
      await t.runWorker({ lane: "bulk" });
      const mid = (await store.getRaw("op/cutover--1")).data;
      assert.equal(mid.status, "running");
      assert.equal(mid.out.numbers.job, 885, "the steps before the failure are journaled");
      const seeded = t.stores.data.keys("done/visit.reminder_2d/").length;
      await stepUntilDone(t);
      assert.equal((await store.getRaw("op/cutover--1")).data.status, "done");
      assert.ok(calls >= 2, "the failed step ran again");
      assert.equal(t.stores.data.keys("done/visit.reminder_2d/").length, seeded, "nothing seeded twice");
      assert.equal((await store.getRaw("seq/job")).data.next, 885);
      assert.equal((await store.getRaw("sys/mode")).data.system_of_record, "crm");
    } finally { restore(); }
  } finally { t.done(); }
});

test("a switch that stops for good can be tried again: a new op, never the failed journal; Rotor stays in charge meanwhile", async () => {
  const t = await crmTest({ now: MON_0900, env: ENV });
  try {
    const owner = await t.user("owner");
    const w = await world(t, owner);
    await green(t, owner);
    await previewNow(t, owner);
    await t.api("/cutover/approve-preview", { method: "POST", as: owner, body: {} });
    await store.createRecord("enrollment", { ...make("enrollment"), contact_id: w.B.id, status: "active" }, W(owner)).catch(() => null);
    let broken = true;
    const restore = services.__swapServiceForTests("sales.stopAll", async () => { if (broken) throw new Error("a bug in a follow-up"); return 0; });
    try {
      assert.equal((await t.api("/cutover/run", { method: "POST", as: owner, body: { confirm: "SWITCH TO CRM" } })).status, 202);
      for (let i = 0; i < 4; i++) await t.runWorker({ lane: "bulk" });
      assert.equal((await store.getRaw("op/cutover--1")).data.status, "failed");
      assert.equal(((await store.getRaw("sys/mode")) || { data: {} }).data.system_of_record || "rotor", "rotor", "a failed switch leaves Rotor in charge");
      const v = (await t.api("/cutover", { as: owner })).body.data;
      assert.equal(v.active, null);
      assert.equal(v.history[0].status, "failed");
      broken = false;
      const again = await t.api("/cutover/run", { method: "POST", as: owner, body: { confirm: "SWITCH TO CRM" } });
      assert.equal(again.status, 202, JSON.stringify(again.body));
      assert.equal(again.body.data.op_id, "cutover--1.r2");
      await stepUntilDone(t);
      assert.equal((await store.getRaw("sys/mode")).data.system_of_record, "crm");
      assert.equal((await store.getRaw("sys/mode")).data.cutover_n, 1);
    } finally { restore(); }
  } finally { t.done(); }
});

test("in-flight documents: each list a bulk run that waits for a test send and an owner's confirm", async () => {
  const t = await crmTest({ now: MON_0900, env: ENV });
  try {
    const owner = await t.user("owner");
    const w = await world(t, owner);
    const lists = (await t.api("/cutover/in-flight", { as: owner })).body.data;
    assert.equal(lists.invoices.count, 1, "Rotor's open invoice");
    assert.equal(lists.agreements.count, 1);
    const made = await t.api("/cutover/in-flight/invoices", { method: "POST", as: owner, body: {} });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const b = (await store.getRecord("bulk_run", made.body.data.bulk_run_id)).data;
    assert.equal(b.template_key, "cutover_invoice");
    assert.deepEqual(b.recipients, [w.B.id]);
    assert.equal(b.status, "draft", "nothing goes out before its test send and an owner's confirm");
    assert.equal((await t.api("/cutover/in-flight/invoices", { method: "POST", as: owner, body: {} })).status, 200, "the same run, not a second");
    assert.equal((await t.api("/cutover/in-flight/nope", { method: "POST", as: owner, body: {} })).status, 404);
    // the words: Barta's voice, no em dash, no STOP text (the sender adds it)
    for (const tpl of C.TEMPLATES) { assert.ok(!/—|Reply STOP|licensed/i.test(tpl.body), tpl.key); }
  } finally { t.done(); }
});

test("the reminder text's date: Rotor's words → the visit date", () => {
  assert.equal(C.reminderDate("REMINDER: ... scheduled to visit on Tue, Jan 5, between", "2027-01-03"), "2027-01-05");
  assert.equal(C.reminderDate("REMINDER: ... scheduled to visit on January 15th.", "2027-01-01"), "2027-01-15");
  assert.equal(C.reminderDate("REMINDER: ... scheduled to visit on Mon, Jan 4", "2026-12-21"), "2027-01-04", "across the new year");
  assert.equal(C.reminderDate("REMINDER: Barta Window Washing is scheduled for tomorrow between 8:00 and 10:00 AM.", "2027-01-03"), "2027-01-04");
  assert.equal(C.reminderDate("Thanks!", "2027-01-03"), null);
  assert.deepEqual(PV.sweepRuns("2027-01-04T15:45:00Z", "10:00").map((r) => r.day), ["2027-01-04", "2027-01-05", "2027-01-06"], "the 10:00 batches of 72 hours from 09:45");
});
