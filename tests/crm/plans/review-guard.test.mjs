// Review fixes (M3b): what automation may do for a customer Rotor owns,
// jobs that are never made twice, and the customer's side.
//   B1  "Text me a link" costs the same for a number on file and one that
//       isn't, and never waits for the lane kick;
//   B4  the backfill asks about the customer, one refusal never starves the
//       plans after it, and an automated resume that would need jobs Rotor's
//       customer can't get waits for the office instead of losing visit 1;
//   B5  a batch that died after its jobs were made is finished, not made
//       again (a skipped visit's job is cancelled); ordinal_sync adopts or
//       cancels stray jobs carrying the plan's id;
//   M1  opening a quote from the hub keeps the hub open;
//   M2  the bin (and "stored") only once the lights are down;
//   m2  3 login texts a day per person, however many numbers they have.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, customer, importedCustomer, staffPlan, planOf, recOf, finishRun, drain, alog, outbox, pin, advance, scope, store, PL, M, WORK, AS, PJSON, fakeServices } from "./fixtures.mjs";

const lanes = await import("../../../netlify/lib/crm/core/lanes.mjs");
const PORTAL = await import("../../../netlify/lib/crm/portal/core.mjs");
const Q = await import("../quotes/fixtures.mjs");
const login = (t, phone, ip) => t.portal("/api/portal/login", { method: "POST", headers: { ...PJSON, "x-nf-client-connection-ip": ip }, body: { phone } });
const pretty = (e164) => `(${e164.slice(2, 5)}) ${e164.slice(5, 8)}-${e164.slice(8)}`;
const shape = (k) => k.replace(/[0-9a-z]{20,}/g, "*").replace(/\/\d{8}t\d{9}z-[0-9a-f]+$/, "/<stamp>").replace(/--qi_[0-9a-z]+$/, "--qi").replace(/\d{4}-\d{2}-\d{2}\/\d{4}/, "<day>/<min>");

async function measure(t, phone, ip) {
  const calls = t.stores.data.calls;
  const before = calls.length;
  const k0 = t.kicks().length;
  const r = await login(t, phone, ip);
  const mine = calls.slice(before);
  return { status: r.status, msg: r.body && r.body.data && r.body.data.message, ops: mine.map((c) => `${c.op} ${shape(String(c.key || c.prefix || ""))}`), kicks: t.kicks().slice(k0).map((k) => `${k.lane}:${k.reason}`) };
}

test("B1: a number on file and one that isn't cost the same Blobs calls and the same kick; the answer never waits for the kick", async () => {
  const { t, owner } = await setup();
  try {
    const on = [];
    const off = [];
    for (let i = 0; i < 3; i++) {
      const c = await customer(owner);
      on.push(await measure(t, pretty(c.phones[0].e164), `198.51.100.${10 + i}`));
      off.push(await measure(t, `(612) 555-01${20 + i}`, `198.51.100.${40 + i}`));
    }
    for (let i = 0; i < 3; i++) {
      assert.equal(on[i].msg, off[i].msg, "the same answer");
      assert.deepEqual(on[i].ops, off[i].ops, "the same storage calls, in the same order");
      assert.deepEqual(on[i].kicks, off[i].kicks, "the same kick");
    }
    assert.ok(on[0].ops.every((o) => !/rec\/contact|ptr\/phone|idx\/contacts/.test(o)), "the request never reads a contact");
    // a kick that hangs: the answer doesn't wait for it, on file or not
    lanes.setKicker(() => new Promise((ok) => setTimeout(ok, 3000)));
    const c = await customer(owner);
    for (const phone of [pretty(c.phones[0].e164), "(612) 555-0199"]) {
      const t0 = Date.now();
      const r = await login(t, phone, "198.51.100.77");
      assert.equal(r.status, 200);
      assert.ok(Date.now() - t0 < 1500, `answered without waiting for the kick (${Date.now() - t0} ms)`);
    }
    lanes.setKicker(() => {});
    // the lane does the lookup: one text, to the number on file only
    await drain(t, 3);
    const texts = outbox(t).filter((o) => o.template_key === "portal_login");
    assert.equal(texts.length, 4, "the 3 measured and the last one on file");
    assert.ok(texts.every((o) => o.mode === "dry_run"));
  } finally { t.done(); }
});

test("m2: 3 login texts a day per person, however many numbers they have on file", async () => {
  const { t, owner } = await setup();
  try {
    await customer(owner, { phones: [{ e164: "+17635550181", sms: true, primary: true }, { e164: "+17635550182", sms: true }] });
    let ip = 0;
    for (let i = 0; i < 3; i++) {
      for (const p of ["(763) 555-0181", "(763) 555-0182"]) { assert.equal((await login(t, p, `203.0.113.${++ip}`)).status, 200); advance(1000); }
      advance(11 * 60 * 1000);
    }
    await drain(t, 3);
    assert.equal(outbox(t).filter((o) => o.template_key === "portal_login").length, 3);
  } finally { t.done(); }
});

test("B4: one CRM plan of a customer Rotor owns never starves the backfill of the plans after it", async () => {
  const { t, owner } = await setup();
  try {
    const off = fakeServices({ "work.createJobs": null });   // made before Scheduling: no jobs yet
    let a; const others = [];
    try {
      a = (await staffPlan(t, owner, { contact: await importedCustomer() })).plan;
      // ids are random: keep adding plans until some sort before it and some after (at least 6)
      const both = () => others.some((p) => p.id > a.id) && others.some((p) => p.id < a.id);
      for (let i = 0; i < 40 && (others.length < 6 || !both()); i++) others.push((await staffPlan(t, owner, { contact: await customer(owner) })).plan);
    } finally { off(); }
    for (const at of ["2026-11-17T16:05:00Z", "2026-11-17T17:05:00Z"]) { pin(at); await drain(t, 3); }
    assert.ok(others.some((p) => p.id > a.id) && others.some((p) => p.id < a.id), "plans on both sides of it");
    for (const p of others) assert.equal((await planOf(p.id)).ordinals.filter((o) => o.job_id).length, 4, "every other plan gets its jobs");
    assert.equal((await planOf(a.id)).ordinals.filter((o) => o.job_id).length, 0, "none for Rotor's customer");
    assert.ok(alog(t).some((k) => k.includes("plans.jobs_backfill") && k.includes(a.id) && k.endsWith("would-create")), "a would-create row for it");
    assert.equal(t.stores.data.keys("rec/job/").filter((k) => t.stores.data.json(k).contact_id === a.contact_id).length, 0);
  } finally { t.done(); }
});

test("B4: an automated resume that would need jobs for Rotor's customer waits for the office (who's told once); the office resumes it by hand", async () => {
  const { t, owner } = await setup();
  try {
    const { plan } = await staffPlan(t, owner, { contact: await importedCustomer() });
    assert.equal(plan.ordinals.filter((o) => o.job_id).length, 4, "a person made its jobs");
    let r = await t.api(`/plans/${plan.id}/activate`, { method: "POST", as: owner, body: { override_reason: "signed on paper" } });
    await finishRun(t, r.body.data.run_id);
    r = await t.api(`/plans/${plan.id}/pause`, { method: "POST", as: owner, body: { from: "2026-11-17", until: "2026-11-24", reason: "travel" } });
    await finishRun(t, r.body.data.run_id);
    assert.equal((await planOf(plan.id)).ordinals[0].job_id, undefined, "the pause took visit 1's job off");
    pin("2026-11-24T12:05:00Z"); await drain(t, 4);
    pin("2026-11-25T12:05:00Z"); await drain(t, 4);
    const held = await planOf(plan.id);
    assert.equal(held.status, "paused", "not resumed into visits without jobs");
    assert.equal(held.held.action, "resume");
    assert.ok(alog(t).some((k) => k.includes(plan.id) && k.endsWith("would-resume")));
    const notes = t.stores.data.keys("rec/notification/").map((k) => t.stores.data.json(k)).filter((n) => n.title === "A plan waits for you");
    assert.ok(notes.length >= 1);
    assert.equal(new Set(notes.map((n) => n.created_at.slice(0, 10))).size, 1, "told once, not every day");
    const o2 = await t.user("owner");
    r = await t.api(`/plans/${plan.id}/resume`, { method: "POST", as: o2, body: {} });
    await finishRun(t, r.body.data.run_id);
    const after = await planOf(plan.id);
    assert.equal(after.status, "active");
    assert.ok(after.ordinals.filter((o) => o.status === "unscheduled").every((o) => o.job_id), "a person's resume makes the jobs");
    assert.equal(after.held, undefined);
  } finally { t.done(); }
});

test("B5: a batch whose jobs were made but not noted is finished on retry, never made again; a visit skipped meanwhile gets its job cancelled", async () => {
  const { t, owner } = await setup();
  try {
    const off = fakeServices({ "work.createJobs": null });
    let plan;
    try { ({ plan } = await staffPlan(t, owner)); } finally { off(); }
    const W = { write: () => AS(owner) };
    await scope(() => store.updateRecord("plan", plan.id, (p) => M.applyAction(p, "activate", {}, { today: "2026-11-17", at: new Date().toISOString(), by: owner.id }).next, AS(owner)));
    // the plan's writes fail after the batch was noted: the jobs exist, the plan doesn't know their ids
    let writes = 0;
    let armed = true;
    const target = new RegExp(`^rec/plan/${plan.id}$`);
    const re = /armed/;
    re.test = (k) => { if (!armed || !target.exec(String(k))) return false; writes += 1; return writes > 1; };
    t.stores.data.fail({ op: ["set", "setJSON"], key: re, kind: "timeout", times: 1000 });
    let crashed = null;
    try { await scope(() => PL.ensureJobs(plan.id, W)); } catch (e) { crashed = e.name; }
    armed = false;
    assert.ok(crashed, "the first attempt died");
    assert.ok((await planOf(plan.id)).jobs_pending, "the batch is on the plan");
    const made = t.stores.data.keys("rec/job/").map((k) => t.stores.data.json(k)).filter((j) => j.plan_id === plan.id);
    assert.equal(made.length, 4, "the jobs were made");
    // the office skips visit 3 before the retry
    await scope(() => store.updateRecord("plan", plan.id, (p) => M.applyAction(p, "skip", { term: 1, n: 3 }, { today: "2026-11-17", at: new Date().toISOString(), by: owner.id }).next, AS(owner)));
    await scope(() => PL.ensureJobs(plan.id, W));
    const jobs = t.stores.data.keys("rec/job/").map((k) => t.stores.data.json(k)).filter((j) => j.plan_id === plan.id);
    assert.equal(jobs.length, 4, "nothing made twice");
    const p = await planOf(plan.id);
    assert.equal(p.jobs_pending, undefined);
    assert.deepEqual(p.ordinals.map((o) => !!o.job_id), [true, true, false, true]);
    const live = jobs.filter((j) => j.status !== "cancelled");
    assert.equal(live.length, 3, "the skipped visit's job is cancelled");
    for (const o of p.ordinals.filter((x) => x.job_id)) assert.ok(live.some((j) => j.id === o.job_id));
  } finally { t.done(); }
});

test("B5: ordinal_sync adopts a stray job for a visit still waiting for one, and cancels one for a visit that has its job", async () => {
  const { t, owner } = await setup();
  try {
    const { plan } = await staffPlan(t, owner);
    // a visit loses its job id (as a batch that died before jobs_pending existed would leave it)
    const lost = plan.ordinals[1].job_id;
    await scope(() => store.updateRecord("plan", plan.id, (p) => ({ ...p, ordinals: p.ordinals.map((o, i) => (i === 1 ? (({ job_id, ...rest }) => rest)(o) : o)) }), AS(owner)));
    // and a second job for visit 3 that nothing points at
    const spec = PL.jobSpec(await planOf(plan.id), plan.ordinals[2]);
    const [extra] = await scope(() => WORK.createJobs([spec], "test-extra", "plans", AS(owner)));
    pin("2026-11-17T16:05:00Z"); await drain(t, 3);
    const p = await planOf(plan.id);
    assert.equal(p.ordinals[1].job_id, lost, "adopted");
    assert.equal((await recOf("job", extra)).status, "cancelled", "the stray one cancelled");
    assert.equal(p.ordinals[2].job_id, plan.ordinals[2].job_id);
  } finally { t.done(); }
});

test("M1: a quote opened from the hub keeps the hub open (the hub session gets the quote, the cookie stays)", async () => {
  const { t, owner } = await Q.setup();
  try {
    const { quote } = await Q.sentQuote(t, owner);
    const l = await Q.scope(() => PORTAL.createPortalLink({ contact_id: quote.contact_id, scope: { kind: "hub" } }));
    const o1 = await t.portal("/api/portal/open", { method: "POST", headers: Q.PJSON, body: { code: l.code } });
    const hubCookie = t.cookieFrom(o1, "barta_portal");
    assert.equal((await t.portal("/p/hub", { cookie: hubCookie })).status, 200);
    const go = await t.portal("/api/portal/hub/open", { method: "POST", cookie: hubCookie, headers: Q.PJSON, body: { kind: "quote", id: quote.id } });
    assert.equal(go.status, 200, JSON.stringify(go.body));
    const o2 = await t.portal("/api/portal/open", { method: "POST", cookie: hubCookie, headers: Q.PJSON, body: { code: go.body.data.location.slice(3) } });
    assert.equal(o2.status, 200);
    assert.equal(o2.body.data.location, `/p/quote/${quote.id}`);
    assert.equal(t.setCookies(o2).length, 0, "the hub cookie stays");
    assert.equal((await t.portal(`/p/quote/${quote.id}`, { cookie: hubCookie })).status, 200, "the quote opens with it");
    assert.equal((await t.portal("/p/hub", { cookie: hubCookie })).status, 200, "and the hub still does");
    // a quote link opened on its own (no hub cookie) is still quote-only
    const solo = await Q.scope(() => PORTAL.createPortalLink({ contact_id: quote.contact_id, scope: { kind: "quote", id: quote.id } }));
    const o3 = await t.portal("/api/portal/open", { method: "POST", headers: Q.PJSON, body: { code: solo.code } });
    const qCookie = t.cookieFrom(o3, "barta_portal");
    assert.equal((await t.portal("/p/hub", { cookie: qCookie })).status, 401, "a document link never opens the hub");
  } finally { t.done(); }
});

test("M2: no bin while the lights are up; the January count still has it; the bin after takedown stores it", async () => {
  const { t, owner, tech } = await setup();
  try {
    const LIGHTS = [{ title: "Christmas Light Installation", qty_milli: 150000, unit_cents: 800, unit: "ft", service_type: "Christmas Lights" }];
    const { plan } = await staffPlan(t, owner, { catalog_key: "lights_annual", lines: LIGHTS, discounts: [] });
    const s = await recOf("season_install", plan.season_install_ids[0]);
    const W = { write: () => AS(owner) };
    await scope(() => WORK.createVisit({ job_id: s.install_job_id, date: "2026-11-20", start: "09:00", end: "12:00", assignee_ids: [tech.id] }, W));
    await drain(t, 2);
    await scope(() => WORK.completeJob(s.install_job_id, W));
    await drain(t, 2);
    assert.equal((await recOf("season_install", s.id)).status, "installed");
    const r = await t.api(`/lights/installs/${s.id}`, { method: "PATCH", as: owner, body: { bin_id: "B-12" } });
    assert.equal(r.status, 409);
    assert.match(r.body.error.message, /once the lights are taken down/);
    const s2 = await recOf("season_install", s.id);
    assert.equal(s2.status, "installed");
    assert.equal(s2.bin_id, undefined);
    pin("2027-01-02T12:05:00Z"); await drain(t, 3);
    const notes = t.stores.data.keys("rec/notification/").map((k) => t.stores.data.json(k)).filter((n) => /Takedowns to book/.test(n.title || ""));
    assert.ok(notes.some((n) => /1 Christmas lights takedown/.test(n.body)), "counted in January");
    const o2 = await t.user("owner");
    const W2 = { write: () => AS(o2) };
    await scope(() => WORK.createVisit({ job_id: s.takedown_job_id, date: "2027-01-08", start: "09:00", end: "11:00", assignee_ids: [tech.id] }, W2));
    await drain(t, 2);
    await scope(() => WORK.completeJob(s.takedown_job_id, W2));
    await drain(t, 2);
    const ok = await t.api(`/lights/installs/${s.id}`, { method: "PATCH", as: o2, body: { bin_id: "B-12" } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.data.status, "stored");
  } finally { t.done(); }
});
