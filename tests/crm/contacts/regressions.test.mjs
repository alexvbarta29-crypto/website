// Regressions from the independent review of M2a: each test is a bug the
// reviewer reproduced, kept so it stays fixed. Synthetic people only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fresh, store, intake, hook, lead, contactKeys, contact, IMPORT, PERSON, ids, applyImport } from "./fixtures.mjs";
import { crmTest } from "../../helpers/crm-http.mjs";
import { fakeServices } from "../../helpers/crm-fixtures.mjs";
import { advance, minutes } from "../../helpers/crm-clock.mjs";

const I = await import("../../../netlify/lib/crm/modules/contacts/import-rotor.mjs");
const { sandboxed } = await import("../../../netlify/lib/crm/core/context.mjs");
const { rotorKey } = await import("../../../netlify/lib/crm/modules/contacts/display.mjs");

process.env.ROTOR_API_KEY = "test-dummy-key-not-real";
const leadHandler = (await import("../../../netlify/functions/lead.mjs")).default;
const postLead = (b, context) => leadHandler(new Request("http://localhost/api/lead", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }), context);

const SYS = { by: "system", origin: "worker", actor_kind: "automation", requestId: "t" };
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const phase = (name) => I.phases.find((p) => p.name === name);
const runPhase = async (name, row, ctx = { lookup: null, users: new Map() }) => { const p = phase(name); const out = await p.map(p.normalize(row), ctx); await applyImport(out, { extras: I.applyExtras }); return out; };
const setMode = (mode) => store.putSetting("intake", { mode }, SYS);
const rotorDown = () => { globalThis.fetch = async (url) => (String(url).includes("getrotor.com") ? new Response("", { status: 503 }) : Promise.reject(new TypeError("unexpected request"))); };
const health = async () => ((await store.getRaw("sys/health")) || { data: {} }).data;
const ph = (n) => ({ e164: `+1763555${String(n).padStart(4, "0")}` });

// ---------------------------------------------------------------- the alert names the lead (review 1)

test("dual, Rotor down, an imported customer: the crm_only alert lists each lead's contact and intake event; the notification opens the contact", async () => {
  const t = await crmTest();
  rotorDown();
  try {
    const owner = await t.user("owner");
    await setMode("dual");
    await runPhase("contacts.customers", { id: uuid(1), first_name: "Casey", last_name: "Sample", phone: "7635550161", status: "active", source: "Website" });
    await runPhase("contacts.customers", { id: uuid(2), first_name: "Riley", last_name: "Sample", phone: "7635550162", status: "active", source: "Website" });
    const c1 = ids.idForRotor("contact", uuid(1));
    const c2 = ids.idForRotor("contact", uuid(2));
    assert.equal((await postLead({ first_name: "Casey", last_name: "Sample", phone: "(763) 555-0161", notes: "Gutters too.", reminders: "on" })).status, 200);
    assert.equal((await postLead({ first_name: "Riley", last_name: "Sample", phone: "(763) 555-0162", notes: "After 5.", reminders: "on" })).status, 200);
    const alert = (await health()).alerts.find((a) => a.key === "intake:crm_only");
    assert.ok(alert, "one alert for the side");
    assert.equal(alert.count, 2, "the second lead adds to it, it doesn't replace the first");
    assert.match(alert.text, /^2 website leads/);
    assert.deepEqual(alert.leads.map((l) => l.contact_id), [c1, c2]);
    for (const l of alert.leads) {
      assert.ok(l.event && l.event.startsWith(`evt/contact/${l.contact_id}/`) && l.event.includes("--intake--"), `the intake event key: ${l.event}`);
      assert.ok(await store.getRaw(l.event), "the event it names is there");
    }
    const queued = t.stores.data.keys("q/").map((k) => JSON.stringify(t.stores.data.json(k)));
    for (const id of [c1, c2]) assert.ok(queued.some((q) => q.includes(`"link":"/contacts/${id}"`)), `a notification to ${owner.id} opens /contacts/${id}`);
  } finally { t.done(); }
});

// ---------------------------------------------------------------- ok only after a durable write (review 2)

test("dual, Rotor down: when the request's only CRM trace (the intake event) fails, intake is not ok and the visitor gets the 502 fallback", async () => {
  const env = fresh();
  rotorDown();
  try {
    await setMode("dual");
    await runPhase("contacts.customers", { id: uuid(3), first_name: "Riley", last_name: "Sample", phone: "7635550163", status: "active", source: "Website" });
    env.S.data.fail({ op: "write", key: /^(evt\/contact\/|rel\/contact-activity\/|alog\/)/, times: 100, kind: "internal" });
    const res = await postLead({ first_name: "Riley", last_name: "Sample", phone: "(763) 555-0163", notes: "Call after 5.", reminders: "on" });
    assert.equal(res.status, 502, "neither Rotor nor the CRM holds the request");
    // and directly: an imported contact, the event failing → not ok
    const out = await intake.intakeLead({ name: "Riley Sample", phone: "7635550163", notes: "Again" }, { origin: "lead-form" });
    assert.equal(out.ok, false);
  } finally { env.done(); }
});

test("intake ok carries the intake event; a record write counts as durable even when the timeline rows fail", async () => {
  const env = fresh();
  try {
    const a = await intake.intakeLead(lead(80), { origin: "lead-form" });
    assert.equal(a.ok, true);
    assert.ok(a.event.startsWith(`evt/contact/${a.contact_id}/`));
    env.S.data.fail({ op: "write", key: /^(evt\/contact\/|rel\/contact-activity\/)/, times: 100, kind: "internal" });
    const b = await intake.intakeLead({ ...lead(80), notes: "New words this time." }, { origin: "lead-form" });
    assert.equal(b.ok, true, "the contact itself changed");
    assert.equal(b.event, undefined);
    const same = await intake.intakeLead({ ...lead(80), notes: "New words this time." }, { origin: "lead-form" });
    assert.equal(same.ok, false, "nothing changed and nothing was recorded");
  } finally { env.done(); }
});

// ---------------------------------------------------------------- merges that can't finish (review 3)

test("a merge whose union the contact type would refuse is refused up front (409), and nothing moves", async () => {
  const t = await crmTest();
  globalThis.__crmSleepScale = 0.01;
  try {
    const owner = await t.user("owner");
    const W = { ...PERSON, by: owner.id };
    const a = (await store.createRecord("contact", { first_name: "Sam", last_name: "Example", phones: [301, 302, 303, 304, 305, 306].map(ph), lifecycle: "customer", source: { source: "Other" } }, W)).data;
    const b = (await store.createRecord("contact", { first_name: "Sam", last_name: "Example", phones: [311, 312, 313, 314, 315].map(ph), lifecycle: "lead", source: { source: "Other" } }, W)).data;
    const m = await t.api(`/contacts/${a.id}/merge`, { method: "POST", as: owner, body: { other_id: b.id } });
    assert.equal(m.status, 409, JSON.stringify(m.body));
    assert.match(m.body.error.message, /too many phone numbers/);
    assert.equal((await contact(b.id)).merging_into, undefined);
    assert.equal(t.stores.data.keys("rec/run/").length, 0, "no run was started");
  } finally { delete globalThis.__crmSleepScale; t.done(); }
});

test("a merge op that fails for good releases the merged contact: merging_into cleared, its Rotor pointer back, editable, and it merges again", async () => {
  const t = await crmTest();
  globalThis.__crmSleepScale = 0.01;
  try {
    const owner = await t.user("owner");
    const W = { ...PERSON, by: owner.id };
    const a = (await store.createRecord("contact", { first_name: "Sam", last_name: "Example", phones: [301, 302, 303, 304, 305].map(ph), lifecycle: "customer", source: { source: "Other" } }, W)).data;
    const b = (await store.createRecord("contact", { first_name: "Sam", last_name: "Example", phones: [311, 312, 313, 314].map(ph), lifecycle: "lead", source: { source: "Other" } }, W)).data;
    await store.updateRecord("contact", b.id, (c) => ({ ...c, rotor: { lead_ids: ["rl-review-b1"] } }), IMPORT);
    await store.claimPointer("rotor/lead", rotorKey("rl-review-b1"), { id: b.id });
    // while the op starts, someone adds two numbers to a: the union no longer fits (7 + 4 > 10)
    t.stores.data.beforeConditionalWrite(async () => {
      await store.updateRecord("contact", a.id, (c) => ({ ...c, phones: [...c.phones, ph(306), ph(307)] }), W);
    }, { key: new RegExp(`^rec/contact/${b.id}$`), times: 1 });
    const m = await t.api(`/contacts/${a.id}/merge`, { method: "POST", as: owner, body: { other_id: b.id } });
    assert.equal(m.status, 202, JSON.stringify(m.body));
    for (let i = 0; i < 6; i++) { await t.runWorker({ lane: "bulk" }); advance(minutes(2)); }
    const run = (await store.getRecord("run", m.body.data.run_id)).data;
    assert.equal(run.status, "failed");
    const bNow = await contact(b.id);
    assert.equal(bNow.merging_into, undefined, "b is itself again");
    assert.equal(bNow.merged_into, undefined);
    assert.equal((await store.readPointer("rotor/lead", rotorKey("rl-review-b1"))).id, b.id, "its Rotor lead points at it again");
    assert.ok((await store.listEvents("contact", b.id)).some((e) => e.action === "merge_undone"));
    const g = await t.api(`/contacts/${b.id}`, { as: owner });
    const patch = await t.api(`/contacts/${b.id}`, { method: "PATCH", as: owner, ifMatch: g.headers.get("etag"), body: { notes: "Edited after the failed merge." } });
    assert.equal(patch.status, 200, JSON.stringify(patch.body));
    // the office trims a's extra numbers and merges again
    await store.updateRecord("contact", a.id, (c) => ({ ...c, phones: c.phones.slice(0, 5) }), W);
    const again = await t.api(`/contacts/${a.id}/merge`, { method: "POST", as: owner, body: { other_id: b.id } });
    assert.equal(again.status, 202, JSON.stringify(again.body));
    for (let i = 0; i < 6; i++) { await t.runWorker({ lane: "bulk" }); advance(minutes(2)); }
    assert.equal((await contact(b.id)).merged_into, a.id);
    assert.equal((await store.readPointer("rotor/lead", rotorKey("rl-review-b1"))).id, a.id);
  } finally { delete globalThis.__crmSleepScale; t.done(); }
});

// ---------------------------------------------------------------- import rows 7 and 8 (review 4, 5)

test("row 7: Rotor's muted channels pause automations even when sms_service consent is already set; the grant still waits for unknown", async () => {
  const env = fresh();
  try {
    await runPhase("contacts.customers", { id: uuid(40), first_name: "Taylor", last_name: "Sample", phone: "7635550240", status: "active", source: "Website" });
    const id = ids.idForRotor("contact", uuid(40));
    const granted = { state: "revoked", at: "2026-11-01T00:00:00.000Z", source: "website_form" };
    await store.updateRecord("contact", id, (c) => ({ ...c, consent: { ...c.consent, sms_service: granted } }), IMPORT);
    await runPhase("contacts.quote_contacts", { id: uuid(40), type: "customer", messaging_config: { sms: { opted_in: true } }, muted_channels: ["sms", "email"] });
    const c = await contact(id);
    assert.equal(c.automations_paused.sms.reason, "Muted in Rotor");
    assert.equal(c.automations_paused.email.reason, "Muted in Rotor");
    assert.deepEqual(c.consent.sms_service, granted, "a known consent state is never overwritten by the import's grant");
    // a re-run keeps the first pause as it was (no weekly rewrite)
    const wv = c.wv;
    await runPhase("contacts.quote_contacts", { id: uuid(40), type: "customer", messaging_config: { sms: { opted_in: true } }, muted_channels: ["sms", "email"] });
    assert.equal((await contact(id)).wv, wv);
  } finally { env.done(); }
});

test("row 8: a re-run maps the lead's full record, so Rotor's edits reach the contact", async () => {
  const env = fresh();
  try {
    await runPhase("contacts.leads", { id: uuid(50), first_name: "Jordan", last_name: "Exampel", phone: "7635550250", source: "Website quote form", notes: "Customer notes:\nFirst words", tags: ["Website"], status: "new" });
    const id = ids.idForRotor("contact", uuid(50));
    const out = await runPhase("contacts.leads", { id: uuid(50), first_name: "Jordan", last_name: "Example", phone: "7635550251", source: "Website quote form", notes: "Customer notes:\nFirst words\n\nCalled, wants a quote in spring", tags: ["Website"], status: "contacted" });
    assert.ok(out.records.some((r) => r.type === "contact" && r.data.id === id), "the full record");
    const c = await contact(id);
    assert.equal(c.last_name, "Example");
    assert.deepEqual(c.phones.map((p) => p.e164), ["+17635550251"]);
    assert.equal(c.rotor.status_raw, "contacted");
  } finally { env.done(); }
});

test("row 8: a dual-write lead the leads import links gains `import` and stops being sandboxed; a lead joining a customer stays patch-only", async () => {
  const env = fresh();
  try {
    // with Rotor's id (the pointer)
    const w = await intake.intakeLead({ name: "Morgan Sample", phone: "7635550260", notes: "Website words" }, { origin: "lead-form", rotor: { lead_id: uuid(60) } });
    assert.equal(sandboxed(await contact(w.contact_id)), true, "a shadow intake contact before the import");
    const out = await runPhase("contacts.leads", { id: uuid(60), first_name: "Morgan", last_name: "Sample", phone: "7635550260", email: "morgan.sample@example.com", source: "Website quote form", notes: "Website words", tags: ["Website"] });
    assert.ok(out.records.some((r) => r.data.id === w.contact_id));
    let c = await contact(w.contact_id);
    assert.ok(c.import, "linked: the import block is set");
    assert.equal(sandboxed(c), false);
    assert.deepEqual(c.emails.map((e) => e.address), ["morgan.sample@example.com"], "an empty field filled in");
    // without it (intake_pending_rotor)
    const p = await intake.intakeLead({ name: "Pending Sample", phone: "7635550261" }, { origin: "lead-form" });
    await runPhase("contacts.leads", { id: uuid(61), first_name: "Pending", last_name: "Sample", phone: "7635550261", source: "Website quote form", tags: ["Website"] });
    c = await contact(p.contact_id);
    assert.ok(c.import);
    assert.equal(c.intake_pending_rotor, undefined);
    assert.deepEqual(c.rotor.lead_ids, [uuid(61)]);
    // a lead joining a customer with the same first name: patches only, the customer's fields stay
    await runPhase("contacts.customers", { id: uuid(62), first_name: "Avery", last_name: "Sample", phone: "7635550262", status: "active", source: "Website" });
    const joined = await runPhase("contacts.leads", { id: uuid(63), first_name: "Avery", last_name: "Changed", phone: "7635550262", source: "Meta Ads", tags: ["Sample Form"] });
    assert.equal(joined.records.filter((r) => r.type === "contact").length, 0);
    const cust = await contact(ids.idForRotor("contact", uuid(62)));
    assert.equal(cust.last_name, "Sample");
    assert.deepEqual(cust.rotor.lead_ids, [uuid(63)]);
    assert.equal(cust.lifecycle, "customer");
  } finally { env.done(); }
});

// ---------------------------------------------------------------- enrollments (review 7)

test("a returning customer's identical retried submission enrolls once; a new request later enrolls again", async () => {
  const env = fresh();
  const calls = [];
  const restore = fakeServices({ "sales.enroll": async (cid) => { calls.push(cid); return "en_00000000000000000001"; } });
  try {
    const c = (await store.createRecord("contact", { first_name: "Pat", last_name: "Example", phones: [ph(270)], lifecycle: "customer", source: { source: "Other" } }, PERSON)).data;
    const input = { first_name: "Pat", last_name: "Example", phone: "7635550270", notes: "Again please", source: "Website quote form" };
    const one = await intake.intakeLead(input, { origin: "lead-form" });
    const two = await intake.intakeLead(input, { origin: "lead-form" });
    assert.deepEqual([one.contact_id, two.contact_id], [c.id, c.id]);
    assert.equal(calls.length, 1, "one enrollment for one person's retried request");
    await intake.intakeLead({ ...input, notes: "Gutters this spring, please." }, { origin: "lead-form" });
    assert.equal(calls.length, 2, "a new request is a new lead");
  } finally { restore(); env.done(); }
});

// ---------------------------------------------------------------- many at once (review 8)

test("8 simultaneous intakes for one person with slow contact writes → all ok, one contact, one enrollment", async () => {
  const env = fresh();
  globalThis.__crmSleepScale = 0;
  const calls = [];
  const restore = fakeServices({ "sales.enroll": async (cid) => { calls.push(cid); return "en_00000000000000000001"; } });
  env.S.data.beforeConditionalWrite(() => new Promise((r) => setTimeout(r, 15)), { key: /^rec\/contact\//, times: 50 });
  try {
    const outs = await Promise.all(Array.from({ length: 8 }, (_, i) => intake.intakeLead({ ...lead(77), email: `pat.example77+${i}@example.com`, notes: `Try ${i}` }, { origin: i % 2 ? "lead-form" : "webhook" })));
    assert.ok(outs.every((o) => o.ok), JSON.stringify(outs.map((o) => o.error || "ok")));
    assert.equal(new Set(outs.map((o) => o.contact_id)).size, 1);
    assert.equal(contactKeys(env.S).length, 1);
    assert.equal(calls.length, 1);
    assert.equal((await contact(outs[0].contact_id)).emails.length, 8, "every submission's email landed");
  } finally { restore(); env.done(); }
});

// ---------------------------------------------------------------- a Rotor that hangs (review 6)

test("dual, Rotor hangs: the CRM gets the lead after 5 s and the visitor is answered from the CRM before the platform's 10 s", async () => {
  const env = fresh();
  globalThis.__crmSleepScale = 0.01;      // 5 s → 50 ms, 9 s → 90 ms
  let signal = null;
  globalThis.fetch = (url, o) => { signal = !!(o && o.signal); return new Promise(() => {}); };
  try {
    await setMode("dual");
    const res = await postLead({ first_name: "Pat", last_name: "Example", phone: "(763) 555-0190", notes: "Hello", reminders: "on" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(signal, false, "Rotor's request itself is untouched");
    assert.equal(contactKeys(env.S).length, 1);
    const alert = (await health()).alerts.find((a) => a.key === "intake:crm_only");
    assert.equal(alert.leads[0].rotor, "no_answer");
    assert.match(alert.text, /didn't answer in time/);
  } finally { env.done(); }
});

test("dual, Rotor slow but answers: one CRM write (started while waiting), Rotor's answer, no alert", async () => {
  const env = fresh();
  globalThis.__crmSleepScale = 0.05;      // 5 s → 250 ms, 9 s → 450 ms
  globalThis.fetch = (url) => new Promise((resolve) => {
    // Rotor answers once the CRM already has the lead
    const t = setInterval(() => { if (contactKeys(env.S).length) { clearInterval(t); resolve(new Response(JSON.stringify({ id: "rl-slow-1" }), { status: 201 })); } }, 5);
  });
  try {
    await setMode("dual");
    const list = [];
    const res = await postLead({ first_name: "Pat", last_name: "Example", phone: "(763) 555-0191", notes: "Hello", reminders: "on" }, { waitUntil: (p) => list.push(p) });
    assert.equal(res.status, 200);
    await Promise.all(list);
    assert.equal(contactKeys(env.S).length, 1);
    const id = contactKeys(env.S)[0].split("/").pop();
    assert.equal((await store.listEvents("contact", id)).filter((e) => e.action === "intake").length, 1, "written once, not again after Rotor answered");
    assert.ok(!((await health()).alerts || []).some((a) => a.key.startsWith("intake:")));
  } finally { env.done(); }
});

test("rotor mode (and before setup): watchRotor hands back Rotor's own call, untouched", async () => {
  const env = fresh();
  try {
    await setMode("rotor");
    const deploy = hook.crmDeploy(null, null);
    assert.equal(await hook.intakeMode(deploy), "rotor");
    const call = Promise.resolve("rotor's answer");
    assert.equal(hook.watchRotor(call, { input: {}, origin: "lead-form" }), call);
    const saved = { CONTEXT: process.env.CONTEXT, CRM_PRODUCTION: process.env.CRM_PRODUCTION };
    process.env.CONTEXT = "production";
    delete process.env.CRM_PRODUCTION;
    hook.clearModeCache();
    try {
      const before = env.S.data.calls.length;
      assert.equal(hook.watchRotor(call, { input: {}, origin: "lead-form" }), call);
      assert.equal(env.S.data.calls.length, before, "not even a read");
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  } finally { env.done(); }
});

// ---------------------------------------------------------------- a failed mode read (review 9)

test("a failed intake-mode read counts as rotor for 15 s: the next leads don't pay the read again", async () => {
  const env = fresh();
  rotorDown();
  try {
    await setMode("dual");
    env.S.data.fail({ op: "read", key: /^cfg\/intake/, times: 10, kind: "internal" });
    const reads = () => env.S.data.calls.filter((c) => /^cfg\/intake/.test(c.key || "")).length;
    assert.equal((await postLead({ name: "Pat Example", phone: "7635550192" })).status, 502, "read failed: rotor");
    const before = reads();
    assert.equal((await postLead({ name: "Pat Example", phone: "7635550193" })).status, 502);
    assert.equal(reads(), before, "no second read inside 15 s");
    env.S.data.clearHooks();
    advance(16 * 1000);
    assert.equal((await postLead({ name: "Pat Example", phone: "7635550194" })).status, 200, "read again: dual, the CRM kept it");
  } finally { env.done(); }
});

// ---------------------------------------------------------------- the webhook says nothing (review 10)

test("lead webhook: the answer is { ok: true } for a new number and a known one alike", async () => {
  const t = await crmTest();
  globalThis.__crmSleepScale = 0.01;
  try {
    const owner = await t.user("owner");
    const tok = await t.api("/intake/webhook-tokens", { method: "POST", as: owner, body: { label: "Zapier" } });
    await store.createRecord("contact", { first_name: "Known", last_name: "Person", phones: [ph(186)], lifecycle: "customer", source: { source: "Other" } }, PERSON);
    const known = await t.api(`/hooks/lead/${tok.body.data.token}`, { method: "POST", csrf: false, body: { full_name: "Anyone", phone_number: "7635550186" } });
    const fresh1 = await t.api(`/hooks/lead/${tok.body.data.token}`, { method: "POST", csrf: false, body: { full_name: "Anyone", phone_number: "7635550187" } });
    assert.deepEqual([known.status, fresh1.status], [200, 200]);
    assert.deepEqual(known.body, { ok: true });
    assert.deepEqual(fresh1.body, { ok: true });
  } finally { delete globalThis.__crmSleepScale; t.done(); }
});

test("Data → Needs a look: each listed lead opens its contact; anything that isn't a contact id is not linked", async () => {
  const data = (await import("../../../crm-app/modules/system/settings-data.js")).default;
  const ctx = { can: () => true, user: { id: "us_00000000000000000001", role: "owner" }, keep: {} };
  const alerts = [{ key: "intake:crm_only", text: "2 website leads saved to the CRM but not Rotor. Add them in Rotor by hand.", count: 2,
    leads: [{ contact_id: "ct_00000000000000000001", event: "evt/contact/ct_00000000000000000001/x", at: "2026-11-17T14:00:00.000Z" }, { contact_id: "javascript:alert(1)", at: "2026-11-17T14:00:00.000Z" }] }];
  const h = String(data.render({ health: { status: {}, lanes: {}, alerts }, backups: [], mode: { paused: false } }, ctx));
  assert.match(h, /href="#\/contacts\/ct_00000000000000000001"/);
  assert.doesNotMatch(h, /javascript:/);
});
