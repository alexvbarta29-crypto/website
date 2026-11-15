// The automation builder's API (docs/CRM-AUTOMATIONS.md): owners and the
// office build automations, a technician opens none of it; create from a
// starter or from scratch, edit with If-Match, the live sentence, a test
// run that writes nothing and sends nothing, pause and resume, duplicate,
// delete; turning one on with a missing template is refused; the limits
// live in Settings (flows). Synthetic data only.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { crmTest } from "../../helpers/crm-http.mjs";
import { seedContact, seedImportedContact } from "../../helpers/crm-fixtures.mjs";

const store = await import("../../../netlify/lib/crm-store.mjs");
const R = await import("../../../netlify/lib/crm/core/registry.mjs");
const scope = (fn) => store.withStoreScope({ requestId: "test" }, fn);
let t;
afterEach(() => { if (t) t.done(); t = null; });

const DEF = { name: "Tag VIPs", trigger: { type: "lead.created" }, conditions: [{ field: "source", op: "is", value: "Meta Ads" }], steps: [{ type: "tag_add", tag: "VIP" }, { type: "text", template_key: "flow_quote_day3", wait: { n: 2, unit: "days" }, at: "10:00" }, { type: "notify", to: "owners", message: "A Meta lead got the follow-up" }], stop: [{ field: "replied", op: "yes" }] };

test("who may: owners and the office build automations; a technician gets none of it", async () => {
  t = await crmTest();
  const owner = await t.user("owner");
  const admin = await t.user("admin");
  const tech = await t.user("tech");
  const made = await t.api("/automations/flows", { method: "POST", as: admin, body: DEF });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const id = made.body.data.flow.id;
  const routes = R.allRoutes().filter((r) => r.module === "automations");
  assert.ok(routes.length >= 12);
  for (const r of routes) {
    assert.equal(r.perm, "automations:configure", `${r.method} ${r.path}`);
    const path = r.path.replace(":id", id).replace(":run", "ar_00000000000000000000");
    const res = await t.api(path, { method: r.method, as: tech, body: r.method === "GET" || r.method === "DELETE" ? undefined : {} });
    assert.equal(res.status, 403, `${r.method} ${r.path} for a technician`);
  }
  assert.equal((await t.api("/automations/flows", { as: owner })).status, 200);
  assert.equal((await t.api("/automations/flows")).status, 401, "nobody signed in");
});

test("create, read, edit, the live sentence, pause, resume, duplicate, delete", async () => {
  t = await crmTest();
  const owner = await t.user("owner");
  const list0 = await t.api("/automations/flows", { as: owner });
  assert.equal(list0.status, 200);
  assert.deepEqual(list0.body.data.flows, []);
  assert.deepEqual(list0.body.data.recipes.map((r) => r.key), ["quote_followup", "review_after_visit", "overdue_invoice", "winback_plans", "lights_rebook"]);
  assert.ok(list0.body.data.catalog.triggers.some((x) => x.key === "visit.started"));
  assert.ok(list0.body.data.choices.templates.some((x) => x.key === "flow_quote_day3"), "the starters' texts are offered before the worker seeds them");
  // from a starter: off until someone turns it on
  const fromRecipe = await t.api("/automations/flows", { method: "POST", as: owner, body: { recipe: "review_after_visit" } });
  assert.equal(fromRecipe.status, 201);
  assert.equal(fromRecipe.body.data.flow.enabled, false);
  assert.equal(fromRecipe.body.data.flow.recipe, "review_after_visit");
  assert.equal((await t.api("/automations/flows", { method: "POST", as: owner, body: { recipe: "nope" } })).status, 400);
  // from scratch
  const made = await t.api("/automations/flows", { method: "POST", as: owner, body: { ...DEF, enabled: true } });
  assert.equal(made.status, 201);
  const flow = made.body.data.flow;
  assert.equal(flow.enabled, false, "created off, whatever the body says");
  assert.equal(flow.summary, "When a new lead comes in and the lead source is Meta Ads, tag them VIP, wait 2 days, then text the Day 3 follow-up at 10 AM, then tell the owners. Stops when they reply.");
  // a bad definition says which field
  const bad = await t.api("/automations/flows", { method: "POST", as: owner, body: { ...DEF, steps: [{ type: "text" }] } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.field, "steps.0.template_key");
  // the live sentence never answers 400 half way through
  const chk = await t.api("/automations/flows/check", { method: "POST", as: owner, body: { flow: { ...DEF, steps: [{ type: "text", template_key: "no_such_text" }] } } });
  assert.equal(chk.status, 200);
  assert.match(chk.body.data.summary, /text the no_such_text/);
  assert.deepEqual(chk.body.data.problems.map((p) => p.field), ["steps.0.template_key"]);
  const chk2 = await t.api("/automations/flows/check", { method: "POST", as: owner, body: { flow: { name: "" } } });
  assert.equal(chk2.status, 200);
  assert.equal(chk2.body.data.summary, null);
  assert.equal(chk2.body.data.problems[0].field, "name");
  // edit: If-Match, and turning it on with a missing template is refused
  const got = await t.api(`/automations/flows/${flow.id}`, { as: owner });
  assert.equal(got.status, 200);
  const etag = got.headers.get("etag");
  assert.equal((await t.api(`/automations/flows/${flow.id}`, { method: "PATCH", as: owner, body: { name: "x" } })).status, 400, "If-Match required");
  const off = await t.api(`/automations/flows/${flow.id}`, { method: "PATCH", as: owner, ifMatch: etag, body: { enabled: true, steps: [{ type: "text", template_key: "no_such_text" }] } });
  assert.equal(off.status, 400);
  const ok = await t.api(`/automations/flows/${flow.id}`, { method: "PATCH", as: owner, ifMatch: etag, body: { name: "Meta VIPs", enabled: true } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.flow.enabled, true);
  assert.equal((await t.api(`/automations/flows/${flow.id}`, { method: "PATCH", as: owner, ifMatch: etag, body: { name: "Stale" } })).status, 412, "an old version is refused");
  // pause and resume
  const p = await t.api(`/automations/flows/${flow.id}/pause`, { method: "POST", as: owner, body: {} });
  assert.equal(p.body.data.flow.enabled, false);
  const rsm = await t.api(`/automations/flows/${flow.id}/resume`, { method: "POST", as: owner, body: {} });
  assert.equal(rsm.body.data.flow.enabled, true);
  // duplicate: a copy, off
  const dup = await t.api(`/automations/flows/${flow.id}/duplicate`, { method: "POST", as: owner, body: {} });
  assert.equal(dup.status, 201);
  assert.equal(dup.body.data.flow.name, "Meta VIPs (copy)");
  assert.equal(dup.body.data.flow.enabled, false);
  assert.deepEqual(dup.body.data.flow.steps.map((s) => s.id), ok.body.data.flow.steps.map((s) => s.id));
  // delete
  assert.equal((await t.api(`/automations/flows/${flow.id}`, { method: "DELETE", as: owner })).status, 200);
  assert.equal((await t.api(`/automations/flows/${flow.id}`, { as: owner })).status, 404);
  const list = await t.api("/automations/flows", { as: owner });
  assert.deepEqual(list.body.data.flows.map((f) => f.name).sort(), ["Meta VIPs (copy)", "Review request after a visit"]);
  // the flow's history stays readable in the store (soft delete)
  assert.ok(t.stores.data.json(`rec/flow/${flow.id}`).deleted_at);
});

test("a test run: what would happen, step by step, with nothing written and nothing sent", async () => {
  t = await crmTest({ now: "2026-11-17T21:30:00Z" });           // Tuesday 15:30
  const owner = await t.user("owner");
  const c = await scope(() => seedContact(1, { source: { source: "Meta Ads" } }));
  const imp = await scope(() => seedImportedContact(2, { source: { source: "Meta Ads" } }));
  const keys = () => t.stores.data.keys("").filter((k) => !/^(thr|ses|idem|lock)\//.test(k));
  const before = keys();
  const r = await t.api("/automations/flows/test", { method: "POST", as: owner, body: { flow: DEF, contact_id: c.id } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = r.body.data;
  assert.equal(d.starts, true);
  assert.deepEqual(d.conditions.map((x) => x.ok), [true]);
  assert.deepEqual(d.steps.map((s) => s.outcome), ["change", "outbox", "notify"]);
  assert.match(d.steps[1].body, new RegExp(`^Hi ${c.first_name}, it's Alex with Barta Window Washing\\.`));
  assert.equal(d.steps[1].at, "2026-11-19T16:00:00.000Z", "2 days, then 10:00");
  assert.match(d.steps[2].detail, /Olive Owner/);
  assert.deepEqual(keys(), before, "nothing written");
  assert.equal(t.stores.data.keys("rec/outbox/").length, 0);
  // Rotor's customer: changes only reported
  const r2 = await t.api("/automations/flows/test", { method: "POST", as: owner, body: { flow: DEF, contact_id: imp.id } });
  assert.equal(r2.body.data.guarded, true);
  assert.equal(r2.body.data.steps[0].outcome, "would");
  // a marketing text without consent is blocked; a condition that fails says so
  const r3 = await t.api("/automations/flows/test", { method: "POST", as: owner, body: { flow: { ...DEF, conditions: [{ field: "source", op: "is", value: "Referral" }], steps: [{ type: "text", template_key: "flow_winback" }] }, contact_id: c.id } });
  assert.equal(r3.body.data.starts, false);
  assert.equal(r3.body.data.steps[0].outcome, "blocked");
  assert.match(r3.body.data.steps[0].detail, /marketing consent/);
  assert.equal((await t.api("/automations/flows/test", { method: "POST", as: owner, body: { flow: DEF } })).status, 400, "a customer to test with");
});

test("the limits are a settings document: automations:configure, checked", async () => {
  t = await crmTest();
  const owner = await t.user("owner");
  const tech = await t.user("tech");
  assert.equal((await t.api("/settings/flows", { method: "PUT", as: owner, ifMatch: "new", body: { max_texts_per_day: 50 } })).status, 400);
  const ok = await t.api("/settings/flows", { method: "PUT", as: owner, ifMatch: "new", body: { max_texts_per_day: 3, max_runs_per_day: 100, junk: 1 } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const list = await t.api("/automations/flows", { as: owner });
  assert.equal(list.body.data.settings.max_texts_per_day, 3);
  assert.equal((await t.api("/settings/flows", { as: tech })).status, 403);
});

test("Workflows in folders (Flyra's objects): a custom one in its trigger's folder until moved; names of your own; built-ins filed by key", async () => {
  t = await crmTest();
  const owner = await t.user("owner");
  const C = await import("../../../netlify/lib/crm/modules/automations/catalog.mjs");
  assert.deepEqual(["lead.ack", "visit.reminder_2d", "quote.sent", "invoice.overdue", "payment.receipt", "agreement.sent", "review.sequence", "something.else"].map(C.folderOfKey),
    ["customers", "jobs", "estimates", "payments", "payments", "subscriptions", "reviews", "misc"]);
  const made = await t.api("/automations/flows", { method: "POST", as: owner, body: { ...DEF, trigger: { type: "quote.sent" } } });
  const id = made.body.data.flow.id;
  assert.equal(made.body.data.flow.folder, "estimates", "a quote trigger files under Estimates");
  let list = (await t.api("/automations/flows", { as: owner })).body.data;
  assert.deepEqual(list.folders.map((f) => f.key), ["jobs", "estimates", "payments", "subscriptions", "reviews", "customers", "misc"]);
  assert.ok(list.folder_rules.length > 5);
  const mv = await t.api(`/automations/flows/${id}/folder`, { method: "POST", as: owner, body: { folder: "  Spring   push " } });
  assert.equal(mv.status, 200);
  assert.equal(mv.body.data.flow.folder, "Spring push");
  list = (await t.api("/automations/flows", { as: owner })).body.data;
  assert.deepEqual(list.folders.slice(-1), [{ key: "Spring push", label: "Spring push", own: true }], "a folder of your own is listed after Flyra's");
  assert.equal((await t.api(`/automations/flows/${id}/folder`, { method: "POST", as: owner, body: { folder: "x".repeat(41) } })).status, 400);
  const back = await t.api(`/automations/flows/${id}/folder`, { method: "POST", as: owner, body: { folder: null } });
  assert.equal(back.body.data.flow.folder, "estimates", "back to its trigger's");
});
