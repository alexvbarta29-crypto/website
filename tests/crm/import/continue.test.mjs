// "Bring in the rest" (docs/CRM-IMPORT.md): when a module ships after an
// import, a continuation run brings its part of the SAME export in from the
// rows that are still staged: no upload, no key. Synthetic data only.
//
// Two kinds of parts "ship" here in the middle of a test:
//   - the tech app's real phases (work.timesheets, work.timers): hidden
//     from the plan at first (runner.__hidePhasesForTests), as on
//     production, where the first import finished before the deploy that
//     registered them, then shown;
//   - Money, Messages, Payroll and the rest, which aren't built: fixtures
//     registered under the names the design expects (money.invoices,
//     comms.messages, payroll.payroll, ...), so before that the run lists
//     them as waiting for Money, Messages, Payroll. The registry lives for
//     the whole file: a phase one test registers runs in the later tests'
//     first runs, so every test that needs a part to "go live" uses a name
//     no earlier test registered.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, stageRun, runToEnd, importExport, store, runner, generate, ids } from "./fixtures.mjs";
import { fixtureModule, fixtureType } from "../../helpers/crm-fixtures.mjs";
import { advance, minutes, hours, days } from "../../helpers/crm-clock.mjs";

const { getModule, allModules } = await import("../../../netlify/lib/crm/core/registry.mjs");
const C = await import("../../../netlify/lib/crm/modules/import/continue.mjs");
const { deployContext } = await import("../../../netlify/lib/crm/core/context.mjs");
const { rotorKey } = await import("../../../netlify/lib/crm/modules/contacts/display.mjs");
const lanes = await import("../../../netlify/lib/crm/core/lanes.mjs");

const sweepOf = (key) => getModule("import").sweeps.find((s) => s.key === key);
const DEPLOY = () => deployContext(new Request("https://www.bartawindowwashing.com/"), {});
const SWEEP_CTX = { mode: { paused: false }, budget: null, write: () => ({ by: "system:import.continue", origin: "worker", actor_kind: "automation", requestId: "sweep" }) };
const runSweep = (key = "import.continue", ctx = SWEEP_CTX) => store.withStoreScope({ deploy: DEPLOY(), requestId: "sweep" }, () => sweepOf(key).run(ctx));
const runsOf = (t) => t.stores.data.keys("rec/import_run/").map((k) => t.stores.data.json(k));
const continuations = (t) => runsOf(t).filter((r) => r.continues);
const notices = (t) => t.stores.data.keys("rec/notification/").map((k) => t.stores.data.json(k));
const rest = async (t, owner) => (await t.api("/import/rest", { as: owner })).body.data;
const go = (t, who) => t.api("/import/continue", { method: "POST", as: who, body: {} });

// ------------------------------------------------------------ the parts that go live later (fixtures)

// Stand-ins for Money's and Messages' types: the real names, any fields.
const TYPES = {
  invoice: fixtureType("invoice", "in", { mirrored: true, rotorFields: ["number", "status", "total_cents", "contact_id", "job_id", "rotor"], example: () => ({ number: 1, total_cents: 100 }) }),
  payment: fixtureType("payment", "pm", { mirrored: true, rotorFields: ["amount_cents", "invoice_id", "contact_id", "rotor"], example: () => ({ amount_cents: 100 }) }),
  message: fixtureType("message", "ms", { mirrored: true, rotorFields: ["contact_id", "direction", "channel", "rotor"], example: () => ({ direction: "outbound" }) }),
  generic: fixtureType("fixture_late", "zl", { rotorFields: ["label", "rotor"], example: () => ({ label: "Sample" }) }),
};
let typesRegistered = false;
const lateTypes = () => { if (typesRegistered) return []; typesRegistered = true; return Object.values(TYPES); };

// Money, as its import will work: an invoice finds its customer and its job
// through the pointers an EARLIER run made, and links itself on the job.
const mapInvoice = async (r, ctx) => {
  const contact = r.customer && r.customer.id ? await ctx.lookup("customer", r.customer.id) : null;
  const job = r.job && r.job.id ? await ctx.lookup("job", r.job.id) : null;
  const id = ids.idForRotor("invoice", r.id);
  return {
    records: [{ type: "invoice", data: { id, number: r.invoice_number, status: r.status, total_cents: r.total_cents, ...(contact ? { contact_id: contact } : {}), ...(job ? { job_id: job } : {}), rotor: { invoice_id: r.id } } }],
    pointers: [{ kind: "rotor/invoice", key: rotorKey(r.id), value: { id } }],
    patches: job ? [{ type: "job", id: job, add: { invoice_ids: [id] } }] : [],
    warnings: [...(contact ? [] : ["invoice_no_contact"]), ...(r.job && r.job.id && !job ? ["invoice_no_job"] : [])],
  };
};
const mapPayment = async (r, ctx) => {
  const invoice = r.invoice_id ? await ctx.lookup("invoice", r.invoice_id) : null;
  const contact = r.customer_id ? await ctx.lookup("customer", r.customer_id) : null;
  return { records: [{ type: "payment", data: { id: ids.idForRotor("payment", r.id), amount_cents: r.total_amount_cents, ...(invoice ? { invoice_id: invoice } : {}), ...(contact ? { contact_id: contact } : {}), rotor: { payment_id: r.id } } }], warnings: r.invoice_id && !invoice ? ["payment_no_invoice"] : [] };
};
const mapMessage = async (r, ctx) => {
  const contact = await ctx.lookup(r.contact_type, r.contact_id);
  if (!contact) return { warnings: ["message_no_contact"] };
  return { records: [{ type: "message", data: { id: ids.idForRotor("message", r.id), contact_id: contact, direction: r.direction, channel: r.channel, rotor: { message_id: r.id } } }] };
};
const mapGeneric = (kind) => async (r) => ({ records: [{ type: "fixture_late", data: { id: ids.idForRotor("fixture_late", `${kind}:${r.id}`), label: String(r.name || r.line_label || r.id), rotor: { [`${kind}_id`]: String(r.id) } } }] });
const pass = (r) => r;

const shipMoney = () => fixtureModule({ types: lateTypes(), importPhases: [
  { name: "money.invoices", entity: "invoices", after: ["contacts.leads", "work.jobs"], normalize: pass, map: mapInvoice },
  { name: "money.payments", entity: "payments", after: ["money.invoices"], normalize: pass, map: mapPayment },
] });
const shipMessages = () => fixtureModule({ types: lateTypes(), importPhases: [{ name: "comms.messages", entity: "messages", after: ["contacts.suppressions"], normalize: pass, map: mapMessage }] });
const ship = (name, entity, kind) => fixtureModule({ types: lateTypes(), importPhases: [{ name, entity, after: ["system.users"], normalize: pass, map: mapGeneric(kind) }] });

// Counts map() calls per phase on every registered phase (call it after the fixtures of the test are registered).
function spyPhases() {
  const calls = {};
  const undo = [];
  for (const m of allModules()) for (const p of m.importPhases || []) {
    const orig = p.map;
    p.map = async (row, ctx) => { calls[p.name] = (calls[p.name] || 0) + 1; return orig(row, ctx); };
    undo.push(() => { p.map = orig; });
  }
  return { calls, restore: () => undo.forEach((f) => f()) };
}
// The staged chunks read since `from` (an index into the store's call log), by entity.
const rawReads = (t, from = 0) => t.stores.data.calls.slice(from).filter((c) => /^get/.test(c.op) && /^imp\/[a-z]{2}_[0-9a-z]{20}\/raw\//.test(c.key || "")).map((c) => c.key.split("/")[3]);
const drain = async (t) => { for (let i = 0; i < 4; i++) { await t.runWorker({ lane: "fast" }); } };

// ------------------------------------------------------------ the story

test("the rest of an export comes in by itself as each part goes live: the tech app's timesheets and timers, then Money, then Messages; then a fresh import changes nothing", async () => {
  const { t, owner } = await setup({ now: "2026-11-17T15:00:00Z" });
  let spy = null;
  try {
    const ex = generate({ scale: 0.03, seed: 51 });
    // the first import, as on production: it finished before the tech app (timesheets, visit timers) was
    // deployed; Money and Messages aren't built
    runner.__hidePhasesForTests(["work.timesheets", "work.timers"]);
    const r1 = await importExport(t, owner, ex);
    assert.equal(r1.run.status, "done");
    const root = r1.ir.id;
    const rec1 = (await store.getRecord("import_run", root)).data;
    assert.ok(["work.timesheets", "work.timers", "money.invoices", "comms.messages"].every((n) => rec1.waiting.includes(n)), "the finished run lists what still waits");
    assert.equal(t.stores.data.keys("rec/timesheet/").length + t.stores.data.keys("rec/timer/").length, 0);
    let v = await rest(t, owner);
    assert.equal(v.run.id, root);
    assert.deepEqual(v.ready, []);
    assert.equal(v.staging, "ok");
    assert.equal(v.auto, true, "on unless an owner turns it off");
    assert.deepEqual(v.waiting.filter((w) => w.module_label === "Scheduling").map((w) => [w.phase, w.rows]).sort(), [["work.timers", ex.visit_timers.length], ["work.timesheets", ex.timesheets.length]]);
    assert.equal((await go(t, owner)).body.error.message, C.NOTHING_MESSAGE);
    assert.equal((await runSweep()).result, "nothing_new");

    // ---- the tech app is deployed: its phases are registered. The next hourly pass of the bulk lane starts
    // ONE continuation that runs exactly those two; Money, Messages and Payroll keep waiting
    runner.__hidePhasesForTests([]);
    spy = spyPhases();
    v = await rest(t, owner);
    assert.deepEqual(v.ready.map((x) => [x.phase, x.module_label, x.rows]), [["work.timesheets", "Scheduling", ex.timesheets.length], ["work.timers", "Scheduling", ex.visit_timers.length]]);
    const mark0 = t.stores.data.calls.length;
    advance(hours(1));
    await t.runWorker({ lane: "bulk" });
    assert.equal(continuations(t).length, 1, "the hourly check started one");
    const c0 = continuations(t)[0];
    assert.deepEqual([c0.continues, c0.staging_run, c0.as_of, c0.auto], [root, root, rec1.as_of, true]);
    assert.equal((await runToEnd(t, owner, c0.id, { start: false })).run.status, "done");
    for (let h = 0; h < 2; h++) { advance(hours(1)); await t.runWorker({ lane: "bulk" }); }
    assert.equal(continuations(t).length, 1, "and no second one");
    const st0 = await runner.loadState(c0.id);
    assert.deepEqual(Object.entries(st0.phases).filter(([, p]) => p.read > 0).map(([n]) => n).sort(), ["work.timers", "work.timesheets"]);
    assert.deepEqual(Object.keys(spy.calls).sort(), ["work.timers", "work.timesheets"], "no other phase mapped a row");
    assert.deepEqual([spy.calls["work.timesheets"], spy.calls["work.timers"]], [ex.timesheets.length, ex.visit_timers.length]);
    assert.deepEqual([...new Set(rawReads(t, mark0))].sort(), ["timesheets", "visit_timers"], "only their staged rows were read");
    assert.ok(["money.invoices", "money.payments", "comms.messages", "payroll.payroll"].every((n) => st0.phases[n].status === "waiting"), "the rest keeps waiting");
    // the real mappers found what the FIRST run made: the team map (a timesheet's person), the visits (a timer's visit)
    const sheets = t.stores.data.keys("rec/timesheet/").map((k) => t.stores.data.json(k));
    assert.equal(sheets.length, ex.timesheets.length);
    assert.ok(sheets.every((x) => t.stores.data.has(`rec/user/${x.user_id}`)), "each timesheet on a person the first run mapped");
    assert.ok(!st0.phases["work.timesheets"].warnings.timesheet_user_unknown, "the first run's team map was used");
    const timers = t.stores.data.keys("rec/timer/").map((k) => t.stores.data.json(k));
    assert.equal(timers.length, ex.visit_timers.length);
    assert.ok(timers.filter((x) => x.visit_id).length > 0 && timers.filter((x) => x.visit_id).every((x) => t.stores.data.has(`rec/visit/${x.visit_id}`)), "each timer on a visit the first run imported");
    const rep00 = (await t.api(`/import/runs/${c0.id}/report`, { as: owner })).body.data;
    assert.equal(rep00.summary.read, ex.timesheets.length + ex.visit_timers.length);
    assert.equal(rep00.summary.created, sheets.length + timers.length);
    assert.equal(rep00.integrity.timers_running, (await t.api(`/import/runs/${root}/report`, { as: owner })).body.data.integrity.timers_running, "the integrity counts are the first run's");
    await drain(t);
    assert.equal(notices(t).filter((n) => n.user_id === owner.id && n.link === `/import/${c0.id}` && /is in$/.test(n.title))[0].body,
      `Timesheets and visit timers from your Rotor export of Nov 10 are in: ${ex.timesheets.length} timesheets, ${ex.visit_timers.length} visit timers.`);
    for (const k of t.stores.data.keys("rec/notification/")) await store.deleteRaw(k);
    spy.restore(); spy = null;
    v = await rest(t, owner);
    assert.equal(v.run.id, c0.id);
    assert.deepEqual(v.ready, []);
    assert.ok(!v.waiting.some((w) => w.module_label === "Scheduling"));
    const money = v.waiting.filter((w) => w.module_label === "Money");
    assert.deepEqual(money.map((w) => [w.phase, w.rows]), [["money.invoices", ex.invoices.length], ["money.payments", ex.payments.length]], "what waits, for which part, how many rows");
    assert.ok(v.waiting.some((w) => w.phase === "comms.messages" && w.module_label === "Messages" && w.rows === ex.messages.length));
    // nothing more to bring in yet: the button says so, the hourly check does nothing
    const none = await go(t, owner);
    assert.equal(none.status, 409);
    assert.equal(none.body.error.message, C.NOTHING_MESSAGE);
    assert.equal((await runSweep()).result, "nothing_new");
    assert.equal(continuations(t).length, 1);

    // ---- later, Money goes live (another deploy): the next hourly pass starts a second continuation, for Money only
    shipMoney();
    spy = spyPhases();
    v = await rest(t, owner);
    assert.deepEqual(v.ready.map((x) => x.phase), ["money.invoices", "money.payments"]);
    assert.ok(v.ready.every((x) => x.module_label === "Money"), "the part's name comes from the phase, whoever registered it");
    assert.ok(!v.waiting.some((w) => w.module_label === "Money"));
    const before = new Map(t.stores.data.keys("").map((k) => [k, t.stores.data.etagOf(k)]));
    const mark = t.stores.data.calls.length;
    advance(hours(1));
    await t.runWorker({ lane: "bulk" });
    assert.equal(continuations(t).length, 2, "the hourly check started one more");
    const c1 = continuations(t).find((r) => r.id !== c0.id);
    assert.equal(c1.continues, c0.id, "it goes on from the latest finished run");
    assert.equal(c1.staging_run, root);
    assert.equal(c1.as_of, rec1.as_of, "the same export");
    assert.equal(c1.auto, true);
    assert.equal(c1.upload, undefined, "no upload, no key");
    const done1 = await runToEnd(t, owner, c1.id, { start: false });
    assert.equal(done1.run.status, "done");
    // only the phases that waited and are registered now ran; nothing done before was read again
    const st1 = await runner.loadState(c1.id);
    const ran = Object.entries(st1.phases).filter(([, p]) => p.read > 0).map(([n]) => n).sort();
    assert.deepEqual(ran, ["money.invoices", "money.payments"]);
    assert.deepEqual(Object.keys(spy.calls).sort(), ["money.invoices", "money.payments"], "no other phase mapped a row");
    assert.equal(spy.calls["money.invoices"], ex.invoices.length);
    assert.equal(spy.calls["money.payments"], ex.payments.length);
    assert.deepEqual([...new Set(rawReads(t, mark))].sort(), ["invoices", "payments"], "only the staged rows of those phases were read (the report re-read nothing)");
    assert.equal(st1.phases["contacts.customers"].status, "done");
    assert.equal(st1.phases["contacts.customers"].earlier, root, "done in the first run");
    assert.equal(st1.phases["contacts.customers"].read, 0);
    assert.equal(st1.phases["work.timers"].earlier, c0.id, "done in the first continuation");
    assert.equal(st1.phases["work.timers"].read, 0);
    assert.equal(st1.phases["comms.messages"].status, "waiting");
    assert.equal(st1.staging_run, root);
    assert.deepEqual(st1.users, (await runner.loadState(root)).users, "the team map of the first run");
    // the invoices landed on the contacts and jobs the FIRST run made (its pointers), and linked themselves on the jobs
    const invoices = t.stores.data.keys("rec/invoice/").map((k) => t.stores.data.json(k));
    assert.equal(invoices.length, ex.invoices.length);
    assert.ok(invoices.every((i) => i.contact_id && t.stores.data.has(`rec/contact/${i.contact_id}`)), "each invoice on a contact from the first run");
    const withJob = invoices.filter((i) => i.job_id);
    assert.ok(withJob.length > 0);
    for (const i of withJob.slice(0, 20)) assert.ok(t.stores.data.json(`rec/job/${i.job_id}`).invoice_ids.includes(i.id), "the job from the first run now names its invoice");
    assert.equal(st1.phases["money.invoices"].extras.patched, withJob.length, "one patch per invoice with a job");
    const payments = t.stores.data.keys("rec/payment/").map((k) => t.stores.data.json(k));
    assert.equal(payments.length, ex.payments.length);
    assert.ok(payments.filter((p) => p.invoice_id).length > 0 && payments.filter((p) => p.invoice_id).every((p) => t.stores.data.has(`rec/invoice/${p.invoice_id}`)));
    // nothing an earlier phase owns was rewritten: contacts, properties, their bases and pointers are untouched
    const touched = t.stores.data.keys("").filter((k) => before.get(k) !== t.stores.data.etagOf(k) && /^(rec\/(contact|property|user|quote|plan|visit|deal|enrollment)\/|ib\/(contact|property|user|quote|plan|visit|job)\/|ptr\/rotor\/(customer|lead|job|quote)\/)/.test(k));
    assert.deepEqual(touched, []);
    // the jobs the invoices patched are listed again (bulk writes, then the run's own index rebuild)
    assert.ok(st1.types.includes("job") && st1.types.includes("invoice"));
    // the report: this run's counts, the run it continues, the chain's totals; Rotor's money as before
    const rep = (await t.api(`/import/runs/${c1.id}/report`, { as: owner })).body.data;
    const rep0 = (await t.api(`/import/runs/${root}/report`, { as: owner })).body.data;
    assert.equal(rep.continues, c0.id);
    assert.deepEqual(rep.chain.runs, [root, c0.id, c1.id]);
    assert.equal(rep.summary.created, ex.invoices.length + ex.payments.length);
    assert.equal(rep.summary.read, ex.invoices.length + ex.payments.length);
    assert.equal(rep.summary.phases_run, 2);
    assert.equal(rep.chain.totals.created, rep0.summary.created + rep00.summary.created + rep.summary.created, "added to the totals of the runs before it");
    assert.equal(rep.chain.totals.read, rep0.summary.read + rep00.summary.read + rep.summary.read);
    assert.deepEqual(rep.money.rotor, rep0.money.rotor);
    assert.equal(rep.phases.find((p) => p.name === "contacts.customers").earlier, root);
    assert.ok(!rep.waiting.some((w) => w.phase.startsWith("money.")) && rep.waiting.some((w) => w.phase === "comms.messages"));
    assert.equal(rep.summary.phases_waiting, rep0.summary.phases_waiting - 4);
    const csv = (await t.api(`/import/runs/${c1.id}/report.csv`, { as: owner })).text;
    assert.match(csv, new RegExp(`chain,,runs,${root} ${c0.id} ${c1.id}`));
    // the owners were told when it started and when it was done (in the app; push by their choice)
    await drain(t);
    const told = notices(t).filter((n) => n.user_id === owner.id).sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
    assert.equal(told.length, 2);
    assert.match(told.find((n) => /Bringing in/.test(n.title)).body, /^Invoices and payments from your Rotor export of Nov 10 are being brought in now\./);
    const fin = told.find((n) => /is in$/.test(n.title));
    assert.equal(fin.body, `Invoices and payments from your Rotor export of Nov 10 are in: ${ex.invoices.length} invoices, ${ex.payments.length} payments.`);
    assert.equal(fin.link, `/import/${c1.id}`);
    assert.ok(notices(t).every((n) => !/@|\+1763|Example Ave/.test(n.body)), "counts only");
    assert.ok((await store.getRecord("import_run", c1.id)).data.noted_at, "the after-run steps are stamped done");
    // the run's screen data: what it continues, what still waits and for which part
    const d1 = (await t.api(`/import/runs/${c1.id}`, { as: owner })).body.data;
    assert.equal(d1.run.continues, c0.id);
    assert.equal(d1.upload, null);
    assert.equal(d1.team, null);
    assert.equal(d1.rest.run.id, c1.id, "the latest finished run");
    assert.ok(d1.rest.waiting.some((w) => w.phase === "comms.messages"));
    assert.equal((await t.api(`/import/runs/${root}`, { as: owner })).body.data.rest, null, "an older run's screen has its own report");
    const list = (await t.api("/import/runs", { as: owner })).body.data;
    assert.equal(list.find((r) => r.id === c1.id).continues, c0.id);
    // nothing more to bring in: the next hours start nothing
    for (let h = 0; h < 3; h++) { advance(hours(1)); await t.runWorker({ lane: "bulk" }); }
    assert.equal(continuations(t).length, 2);
    assert.equal((await runSweep()).result, "nothing_new");

    // ---- Messages goes live; the owner doesn't wait for the hour: "Bring in the rest now"
    spy.restore();
    shipMessages();
    spy = spyPhases();
    const mark2 = t.stores.data.calls.length;
    const made = await go(t, owner);
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.deepEqual(made.body.data.phases.map((p) => [p.phase, p.rows]), [["comms.messages", ex.messages.length]]);
    const c2id = made.body.data.run.id;
    assert.equal(made.body.data.run.continues, c1.id, "it goes on from the latest finished run");
    assert.equal((await go(t, owner)).status, 409, "one import at a time");
    assert.equal((await t.api("/import/runs", { method: "POST", as: owner, body: {} })).status, 409, "no new upload while it runs");
    const done2 = await runToEnd(t, owner, c2id, { start: false });
    assert.equal(done2.run.status, "done");
    const c2 = (await store.getRecord("import_run", c2id)).data;
    assert.equal(c2.staging_run, root, "still the rows of the one upload");
    assert.equal(c2.auto, undefined);
    assert.deepEqual(Object.keys(spy.calls), ["comms.messages"]);
    assert.deepEqual([...new Set(rawReads(t, mark2))], ["messages"]);
    const st2 = await runner.loadState(c2id);
    assert.equal(st2.phases["money.invoices"].earlier, c1.id, "done in the continuation before");
    assert.equal(st2.phases["work.timesheets"].earlier, c0.id);
    assert.equal(st2.phases["contacts.customers"].earlier, root);
    assert.deepEqual(st2.chain, [root, c0.id, c1.id]);
    const msgs = t.stores.data.keys("rec/message/").map((k) => t.stores.data.json(k));
    assert.ok(msgs.length > 0 && msgs.every((m) => t.stores.data.has(`rec/contact/${m.contact_id}`)), "messages on the contacts of the first run");
    assert.ok(Object.keys(t.stores.data.json(`ib/message/${msgs[0].id}`).sources)[0].endsWith("~comms.messages"), "the same source a full run gives (the opt-out phase reads messages first)");
    const rep2 = (await t.api(`/import/runs/${c2id}/report`, { as: owner })).body.data;
    assert.deepEqual(rep2.chain.runs, [root, c0.id, c1.id, c2id]);
    assert.equal(rep2.chain.totals.created, rep.chain.totals.created + rep2.summary.created);
    await drain(t);
    const fin2 = notices(t).filter((n) => n.user_id === owner.id && n.link === `/import/${c2id}`);
    assert.equal(notices(t).filter((n) => n.link === `/import/${c2id}`).length, 2, "both owners");
    assert.equal(fin2.length, 1, "asked for on the screen: one note, when it's done");
    assert.match(fin2[0].body, /^Messages from your Rotor export of Nov 10 are in: \d+ messages\.$/);

    // ---- a fresh full import of the same export afterwards (days later): everything is found as it is
    spy.restore(); spy = null;
    advance(days(3));
    const snap = new Map(t.stores.data.keys("").map((k) => [k, t.stores.data.etagOf(k)]));
    const r4 = await importExport(t, owner, ex);
    assert.equal(r4.run.status, "done");
    assert.deepEqual([r4.run.summary.created, r4.run.summary.updated, r4.run.summary.linked, r4.run.summary.conflicts_open], [0, 0, 0, 0], "all unchanged");
    const st4 = await runner.loadState(r4.ir.id);
    assert.ok(st4.phases["money.invoices"].read === ex.invoices.length && !st4.phases["money.invoices"].earlier, "a full run reads everything itself");
    const rewritten = t.stores.data.keys("").filter((k) => snap.get(k) !== t.stores.data.etagOf(k) && /^(rec\/(?!import_run|run|event|notification)|ib\/|ptr\/rotor\/|rel\/|ix\/(?!import-runs|runs))/.test(k));
    assert.deepEqual(rewritten, [], "no record, base, pointer, relation or list was written");
    assert.equal(r4.run.continues, undefined);
  } finally { runner.__hidePhasesForTests([]); if (spy) spy.restore(); t.done(); }
});

// ------------------------------------------------------------ staging

test("it refuses when the export's rows are gone, with a plain message; the rows are kept 30 days from their last use and never under a continuation", async () => {
  const { t, owner } = await setup({ now: "2026-11-17T15:00:00Z" });
  try {
    const ex = generate({ scale: 0.02, seed: 52 });
    const r1 = await importExport(t, owner, ex);
    const root = r1.ir.id;
    const gc = () => runSweep("import.staging_gc", { budget: null });
    const rawCount = () => t.stores.data.keys(`imp/${root}/raw/`).length;
    const had = rawCount();
    assert.ok(had > 10);
    // day 20: Payroll goes live and a continuation is made; it sits in the queue (the lane is stuck) until day 60
    advance(days(20));
    ship("payroll.payroll", "payroll", "payroll");
    const c1 = (await go(t, owner)).body.data.run;
    assert.equal(Date.parse((await store.getRecord("import_run", root)).data.staging_used_at), Date.parse(r1.run.finished_at) + days(20), "making it stamps the rows as used");
    advance(days(40));
    await gc();
    assert.equal(rawCount(), had, "never under a continuation that reads them, whatever their age");
    assert.equal((await runToEnd(t, owner, c1.id, { start: false })).run.status, "done");
    const used = (await store.getRecord("import_run", root)).data.staging_used_at;
    assert.equal(Date.parse(used), Date.parse(r1.run.finished_at) + days(60), "finishing it stamps the last use");
    // day 75: long after the upload finished, 15 days after its last use: kept
    advance(days(15));
    await gc();
    assert.equal(rawCount(), had, "30 days from the last use, not from the upload");
    assert.equal((await rest(t, owner)).keep_until.slice(0, 10), new Date(Date.parse(used) + 30 * 86400000).toISOString().slice(0, 10));
    // day 91: gone
    advance(days(16));
    await gc();
    assert.equal(rawCount(), 0, "cleared 30 days after the last use");
    assert.ok(t.stores.data.has(`imp/${root}/state`) && t.stores.data.has(`imp/${c1.id}/report`), "the runs, their state and reports stay");
    // another part goes live too late for this export
    ship("comms.templates", "message_templates", "template");
    const v = await rest(t, owner);
    assert.equal(v.staging, "cleared");
    assert.ok(v.ready.some((x) => x.phase === "comms.templates"));
    const res = await go(t, owner);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.message, "That export's rows were cleared. Start a new import.");
    assert.equal((await runSweep()).result, "cleared");
    assert.equal(continuations(t).length, 1, "nothing was started");
    // one chunk missing is the same as all of them (a half-cleared export is never imported)
    const r2 = await importExport(t, owner, ex);
    ship("comms.campaigns", "campaigns", "campaign");
    await store.deleteRaw(t.stores.data.keys(`imp/${r2.ir.id}/raw/campaigns/`)[0]);
    assert.equal((await go(t, owner)).body.error.message, C.CLEARED_MESSAGE);
  } finally { t.done(); }
});

// ------------------------------------------------------------ the hourly check

test("the hourly check starts exactly one continuation, and none while one runs, while an upload is under way or after an owner cancelled", async () => {
  const { t, owner } = await setup({ now: "2026-11-17T15:00:00Z" });
  try {
    const ex = generate({ scale: 0.02, seed: 53 });
    await importExport(t, owner, ex);
    advance(minutes(10));
    ship("fixture.templates", "message_templates", "template2");
    // three passes at once (two bulk invocations and a cron fallback): one run
    const res = await Promise.all([runSweep(), runSweep(), runSweep()]);
    assert.equal(continuations(t).length, 1, JSON.stringify(res));
    const c1 = continuations(t)[0];
    assert.equal(t.stores.data.keys("rec/run/").map((k) => t.stores.data.json(k)).filter((r) => r.kind === "import" && r.input.import_run_id === c1.id).length, 1, "one lane run");
    // while it is queued or running: nothing more
    assert.equal((await runSweep()).result, "busy");
    await t.runWorker({ lane: "bulk" });
    assert.equal((await runSweep()).result, (await store.getRecord("import_run", c1.id)).data.status === "done" ? "nothing_new" : "busy");
    assert.equal((await runToEnd(t, owner, c1.id, { start: false })).run.status, "done");
    for (let i = 0; i < 3; i++) await runSweep();
    assert.equal(continuations(t).length, 1);
    await drain(t);
    assert.equal(notices(t).filter((n) => n.user_id === owner.id && /Bringing in/.test(n.title)).length, 1, "one start note");
    assert.equal(notices(t).filter((n) => n.user_id === owner.id && /^Templates from your Rotor export of Nov 10 are in: \d+ templates\.$/.test(n.body)).length, 1);

    // a new export is being uploaded (a key made within the day): the old one is left alone
    ship("fixture.campaigns", "campaigns", "campaign2");
    const up = await t.api("/import/runs", { method: "POST", as: owner, body: {} });
    assert.equal(up.status, 201);
    assert.equal((await runSweep()).result, "upload_under_way");
    assert.equal((await t.api(`/import/runs/${up.body.data.run.id}/cancel`, { method: "POST", as: owner, body: {} })).status, 200);
    // an owner cancels the continuation the check started: it is not started again by itself
    assert.match((await runSweep()).result, /^started:/);
    const c2 = continuations(t).find((r) => r.id !== c1.id);
    assert.equal((await t.api(`/import/runs/${c2.id}/cancel`, { method: "POST", as: owner, body: {} })).status, 200);
    for (let i = 0; i < 3; i++) await t.runWorker({ lane: "bulk" });
    assert.equal((await runSweep()).result, "cancelled_before");
    assert.equal(continuations(t).length, 2);
    // the button still does (a new run: the cancelled one stays cancelled)
    const again = await go(t, owner);
    assert.equal(again.status, 201);
    assert.ok(![c1.id, c2.id].includes(again.body.data.run.id));
    assert.equal((await runToEnd(t, owner, again.body.data.run.id, { start: false })).run.status, "done");
    assert.equal(t.stores.data.keys("rec/fixture_late/").map((k) => t.stores.data.json(k)).filter((r) => r.rotor.campaign2_id).length, ex.campaigns.length);
  } finally { t.done(); }
});

test("a continuation whose lane run never got queued is queued by the next check, not doubled", async () => {
  const { t, owner } = await setup({ now: "2026-11-17T15:00:00Z" });
  try {
    await importExport(t, owner, generate({ scale: 0.02, seed: 57 }));
    ship("fixture.heal", "campaigns", "heal");
    const made = await store.withStoreScope({ deploy: DEPLOY(), requestId: "t" }, () => C.createContinuation({ auto: true }, SWEEP_CTX.write()));
    // the function died after the record was made: no lane run
    await store.updateRecord("import_run", made.run.id, (r) => { const n = { ...r }; delete n.lane_run_id; return n; }, { by: "import", origin: "import", actor_kind: "import", requestId: "t" });
    for (const k of t.stores.data.keys("rec/run/")) if (t.stores.data.json(k).kind === "import" && t.stores.data.json(k).input.import_run_id === made.run.id) await store.deleteRaw(k);
    assert.equal((await runSweep()).result, "requeued");
    assert.equal((await runSweep()).result, "busy");
    assert.equal(continuations(t).length, 1);
    assert.equal((await runToEnd(t, owner, made.run.id, { start: false })).run.status, "done");
  } finally { t.done(); }
});

test("the setting (owners only) stops the hourly check; the button still works; a paused CRM starts nothing", async () => {
  const { t, owner, admin, tech1 } = await setup({ now: "2026-11-17T15:00:00Z" });
  try {
    const ex = generate({ scale: 0.02, seed: 54 });
    await importExport(t, owner, ex);
    ship("comms.pin_types", "map_pin_types", "pin");
    // only an owner reads or changes it
    for (const who of [admin, tech1]) {
      assert.equal((await t.api("/settings/import", { as: who })).status, 403);
      assert.equal((await t.api("/settings/import", { method: "PUT", as: who, ifMatch: "new", body: { auto_continue: false } })).status, 403);
      assert.equal((await go(t, who)).status, 403);
      assert.equal((await t.api("/import/rest", { as: who })).status, 403);
    }
    const cur = await t.api("/settings/import", { as: owner });
    assert.equal(cur.status, 200);
    assert.equal(cur.body.data.data.auto_continue, true, "on by default");
    assert.equal((await t.api("/settings/import", { method: "PUT", as: owner, ifMatch: "new", body: { auto_continue: "no" } })).status, 400);
    assert.equal((await t.api("/settings/import", { method: "PUT", as: owner, ifMatch: "new", body: { auto_continue: false } })).status, 200);
    // off: a week of hourly passes starts nothing
    assert.equal((await runSweep()).result, "off");
    for (let h = 0; h < 30; h++) { advance(hours(1)); await t.runWorker({ lane: "bulk" }); }
    assert.equal(continuations(t).length, 0);
    const v = await rest(t, owner);
    assert.equal(v.auto, false);
    assert.ok(v.ready.length > 0, "the screen still offers it");
    // a paused CRM (after a restore): neither the check nor the button
    const sys = await import("../../../netlify/lib/crm/core/settings.mjs");
    await sys.updateSysMode((m) => ({ ...m, paused: true, paused_reason: "restore" }));
    const etag = (await t.api("/settings/import", { as: owner })).body.data.etag;
    assert.equal((await t.api("/settings/import", { method: "PUT", as: owner, ifMatch: etag, body: { auto_continue: true } })).status, 200);
    for (let h = 0; h < 3; h++) { advance(hours(1)); await t.runWorker({ lane: "bulk" }); }
    assert.equal(continuations(t).length, 0, "the check is not a maintenance sweep: it doesn't run while paused");
    assert.equal((await runSweep("import.continue", { ...SWEEP_CTX, mode: { paused: true } })).result, "paused");
    const p = await go(t, owner);
    assert.equal(p.status, 409);
    assert.match(p.body.error.message, /paused/);
    await sys.updateSysMode((m) => ({ ...m, paused: false }));
    // resumed and on again: the next hour brings it in
    advance(hours(1));
    await t.runWorker({ lane: "bulk" });
    assert.equal(continuations(t).length, 1);
    assert.equal((await runToEnd(t, owner, continuations(t)[0].id, { start: false })).run.status, "done");
  } finally { t.done(); }
});

// ------------------------------------------------------------ crashes

test("a crash in the middle of a continuation resumes at the row that failed; no row is brought in twice", async () => {
  const { t, owner } = await setup({ now: "2026-11-17T15:00:00Z" });
  let spy = null;
  try {
    const ex = generate({ scale: 0.05, seed: 55 });
    await importExport(t, owner, ex);
    const rows = new Map();
    fixtureModule({ types: lateTypes(), importPhases: [{ name: "fixture.crash", entity: "invoices", after: ["contacts.leads"], normalize: pass, map: async (r) => { rows.set(r.id, (rows.get(r.id) || 0) + 1); return mapGeneric("crash")(r); } }] });
    spy = spyPhases();
    runner.IMPORT_LIMITS.stepRows = 7;
    runner.IMPORT_LIMITS.checkpointRows = 3;
    const c = (await go(t, owner)).body.data.run;
    for (let i = 0; i < 2; i++) await t.runWorker({ lane: "bulk" });
    const mid = await runner.loadState(c.id);
    assert.ok(mid.phases["fixture.crash"].read > 0 && mid.phases["fixture.crash"].read < ex.invoices.length, "in the middle");
    // storage fails on the staged rows until the lane gives up
    t.stores.data.fail({ op: ["get", "getWithMetadata"], key: new RegExp(`^imp/[a-z_0-9]+/raw/invoices/`), times: 100000 });
    for (let i = 0; i < 4 * lanes.RUN_MAX_ATTEMPTS; i++) {
      const lane = (await store.getRecord("run", (await store.getRecord("import_run", c.id)).data.lane_run_id)).data;
      if (lane.status === "failed") break;
      advance(61 * 60000);
      await t.runWorker({ lane: "bulk" });
    }
    t.stores.data.clearHooks();
    const stuck = (await t.api(`/import/runs/${c.id}`, { as: owner })).body.data;
    assert.equal(stuck.lane.status, "failed");
    assert.equal(stuck.run.status, "running");
    assert.equal((await runSweep()).result, "busy", "a stopped continuation is resumed by a person, not doubled by the check");
    assert.equal((await go(t, owner)).status, 409);
    // Resume: a fresh lane run at the saved cursor
    assert.equal((await t.api(`/import/runs/${c.id}/resume`, { method: "POST", as: owner, body: {} })).status, 200);
    runner.IMPORT_LIMITS.stepRows = Infinity;
    const done = await runToEnd(t, owner, c.id, { start: false });
    assert.equal(done.run.status, "done");
    assert.equal(rows.size, ex.invoices.length);
    assert.ok([...rows.values()].filter((n) => n > 1).length <= runner.IMPORT_LIMITS.checkpointRows, "at most the rows since the last checkpoint were mapped again");
    assert.equal(t.stores.data.keys("rec/fixture_late/").map((k) => t.stores.data.json(k)).filter((r) => r.rotor.crash_id).length, ex.invoices.length, "each row became one record");
    assert.deepEqual(Object.keys(spy.calls), ["fixture.crash"], "and no other phase ran");
    assert.equal(done.run.summary.created, ex.invoices.length);
  } finally { if (spy) spy.restore(); t.stores.data.clearHooks(); runner.IMPORT_LIMITS.stepRows = Infinity; runner.IMPORT_LIMITS.checkpointRows = 50; t.done(); }
});

test("conflicts of the import it continues still count as waiting; a note lost to a crash right after the run finished is sent by the next step", async () => {
  const { t, owner } = await setup({ now: "2026-11-17T15:00:00Z" });
  try {
    const ex = generate({ scale: 0.02, seed: 58 });
    await importExport(t, owner, ex);
    // someone edits a customer's last name; Rotor changes it too: the next import has one conflict
    const cid = ids.idForRotor("contact", ex.customers[2].id);
    const g = await store.getRecord("contact", cid);
    assert.equal((await t.api(`/contacts/${cid}`, { method: "PATCH", as: owner, ifMatch: g.etag, body: { last_name: "Changedhere" } })).status, 200);
    const ex2 = JSON.parse(JSON.stringify(ex));
    ex2.customers[2].last_name = "Changedinrotor";
    advance(days(7));
    const r2 = await importExport(t, owner, ex2);
    assert.equal(r2.run.conflicts.open, 1);
    advance(days(1));
    const waiting = () => store.withStoreScope({ deploy: DEPLOY(), requestId: "t" }, () => getModule("import").attention.find((a) => a.key === "import.conflicts").count());
    assert.equal(await waiting(), 1);
    // a part goes live; its continuation has no conflict of its own
    ship("fixture.attention", "campaigns", "attention");
    const c = (await go(t, owner)).body.data.run;
    const done = await runToEnd(t, owner, c.id, { start: false });
    assert.equal(done.run.status, "done");
    assert.equal(done.run.conflicts.open, 0);
    assert.equal(await waiting(), 1, "the conflict of the import it continues is still to settle");
    const open = (await t.api(`/import/runs/${r2.ir.id}/conflicts?status=open`, { as: owner })).body.data;
    assert.equal((await t.api(`/import/conflicts/${open[0].key}/resolve`, { method: "POST", as: owner, body: { take: "crm" } })).status, 200);
    assert.equal(await waiting(), 0);

    // the function died right after marking the run done (before the owners' note): the lane's next try sends it
    await drain(t);
    const noteOf = () => notices(t).filter((n) => n.user_id === owner.id && n.link === `/import/${c.id}`).length;
    assert.equal(noteOf(), 1);
    for (const k of t.stores.data.keys("rec/notification/")) await store.deleteRaw(k);
    const sys = { by: "import", origin: "import", actor_kind: "import", requestId: "t" };
    await store.updateRecord("import_run", c.id, (r) => { const n = { ...r }; delete n.noted_at; return n; }, sys);
    await store.updateRecord("run", done.run.lane_run_id, (r) => ({ ...r, status: "running", finished_at: null }), sys);
    await t.runWorker({ lane: "bulk" });
    await drain(t);
    assert.equal(noteOf(), 1, "sent by the retried step");
    assert.ok((await store.getRecord("import_run", c.id)).data.noted_at);
    assert.equal((await store.getRecord("run", done.run.lane_run_id)).data.status, "done");
    await t.runWorker({ lane: "bulk" });
    await drain(t);
    assert.equal(noteOf(), 1, "and only once");
  } finally { t.done(); }
});

// ------------------------------------------------------------ rules

test("what can run after a state: done phases count for `after`; a phase waits with what it comes after", () => {
  const plan = [
    { name: "a.one", module: "a", entity: "x", after: [], registered: true },
    { name: "b.two", module: "b", entity: "y", after: ["a.one"], registered: true },
    { name: "c.three", module: "c", entity: "z", after: ["b.two", "d.four"], registered: true },
    { name: "d.four", module: "d", entity: "w", after: [], registered: false },
    { name: "e.five", module: "e", entity: "v", after: ["c.three"], registered: true },
    { name: "f.six", module: "f", entity: "u", after: ["nobody.knows"], registered: true },
  ];
  const state = { phases: { "a.one": { status: "done" }, "b.two": { status: "waiting" }, "c.three": { status: "waiting" } } };
  assert.deepEqual(runner.restOf(plan, state).map((x) => [x.name, x.ready, x.waiting_for]), [
    ["b.two", true, null], ["c.three", false, "d.four"], ["d.four", false, "d"], ["e.five", false, "d.four"], ["f.six", false, "nobody.knows"],
  ]);
  assert.deepEqual(runner.restOf(plan, { phases: {} }).filter((x) => x.ready).map((x) => x.name), ["a.one", "b.two"], "with nothing done, a phase is ready when what it comes after is ready too");
  assert.deepEqual(runner.restOf(plan, { phases: { "a.one": { status: "empty" }, "b.two": { status: "done", earlier: "ir_x" } } }).map((x) => x.name), ["c.three", "d.four", "e.five", "f.six"]);
  assert.equal(C.latestDone([{ id: "ir_a", st: "done", fin: "2026-11-10T10:00:00.000Z" }, { id: "ir_b", st: "done", fin: "2026-11-12T10:00:00.000Z" }, { id: "ir_c", st: "cancelled", fin: "2026-11-13T10:00:00.000Z" }, { id: "ir_d", st: "running" }]).id, "ir_b");
  assert.equal(C.latestDone([{ id: "ir_d", st: "uploading" }]), null);
  // a run a finished continuation goes on from is never the latest, whatever the clocks say
  const same = "2026-11-12T10:00:00.000Z";
  assert.equal(C.latestDone([{ id: "ir_z", st: "done", fin: same, at: same }, { id: "ir_a", st: "done", fin: same, at: same, cont: "ir_z" }]).id, "ir_a");
  assert.equal(C.latestDone([{ id: "ir_z", st: "done", fin: same }, { id: "ir_a", st: "cancelled", fin: same, cont: "ir_z" }]).id, "ir_z", "a cancelled continuation changes nothing");
  assert.notEqual(runner.phasesSignature(["a", "b"]), runner.phasesSignature(["a", "b", "c"]));
  assert.equal(runner.phasesSignature(["b", "a", "a"]), runner.phasesSignature(["a", "b"]));
});

test("the notes to the owners: plain words, counts only", () => {
  const run = { id: "ir_00000000000000000001", as_of: "2026-11-10", conflicts: { open: 0 } };
  const ph = (read, skipped = {}) => ({ status: "done", read, skipped });
  const state = (phases) => ({ plan: Object.keys(phases).map((name) => ({ name })), phases });
  assert.equal(C.finishNotice(run, state({ "money.invoices": ph(712), "money.payments": ph(690, { invalid: 2 }), "contacts.customers": { status: "done", earlier: "ir_x", read: 0 } })).body,
    "Invoices and payments from your Rotor export of Nov 10 are in: 712 invoices, 688 payments.");
  assert.equal(C.finishNotice({ ...run, conflicts: { open: 3 } }, state({ "comms.messages": ph(10927) })).body,
    "Messages from your Rotor export of Nov 10 are in: 10,927 messages. 3 fields to settle on the Import screen.");
  assert.equal(C.finishNotice(run, state({ "plans.lights": ph(4), "comms.templates": ph(45), "comms.campaigns": ph(31), "comms.pin_types": ph(9), "payroll.payroll": ph(6) })).body,
    "Christmas lights seasons, message templates, campaigns and 2 more parts from your Rotor export of Nov 10 are in: 4 Christmas lights seasons, 45 message templates, 31 campaigns, 9 map pin types, and more.");
  assert.match(C.finishNotice(run, state({ "money.invoices": ph(0) })).body, /^Nothing new was in your Rotor export of Nov 10/);
  assert.equal(C.finishNotice({ id: run.id }, state({ "money.invoices": ph(1) })).body, "Invoices from your Rotor export are in: 1 invoice.");
  assert.equal(C.finishNotice(run, state({ "payroll.payroll": ph(6) })).body, "Payroll from your Rotor export of Nov 10 is in: 6 payroll.");
  assert.match(C.startNotice(run, [{ label: "Payroll" }]).body, /^Payroll from your Rotor export of Nov 10 is being brought in now\./);
  const s = C.startNotice(run, [{ label: "Invoices" }, { label: "Payments" }]);
  assert.equal(s.title, "Bringing in more of your Rotor export");
  assert.match(s.body, /^Invoices and payments from your Rotor export of Nov 10 are being brought in now\./);
  for (const n of [s, C.finishNotice(run, state({ "money.invoices": ph(712) }))]) {
    assert.ok(n.title.length <= 80 && n.body.length <= 300 && /^\/import\/ir_/.test(n.link) && n.kind === "system");
    assert.ok(!n.body.includes("—"), "no em dash");
  }
  assert.equal(C.exportDay("2026-01-05"), "Jan 5");
  assert.equal(C.exportDay("nope"), null);
  assert.deepEqual(C.validateImportSetting({ auto_continue: false, other: 1 }), { auto_continue: false });
  assert.deepEqual(C.validateImportSetting({}), { auto_continue: true });
  assert.throws(() => C.validateImportSetting({ auto_continue: "yes" }));
});

test("the phase that owns an entity's plain row source stays the same as modules ship (the import bases of records already brought in depend on it)", () => {
  // Pinned for the phases that have run in production. A phase added later for one of these
  // entities must come after the owner (name it in `after`), or every record the owner wrote
  // would be found under another source by the next run.
  const OWNERS = {
    members: "system.users", member_availability: "system.availability", rate_settings: "system.rates", agreement_templates: "plans.agreement_templates",
    availability_exceptions: "work.time_off", customers: "contacts.customers", quote_contacts: "contacts.quote_contacts", leads: "contacts.leads",
    quotes: "contacts.properties_quotes", service_plans: "contacts.properties_plans", visits: "contacts.properties_visits", messages: "contacts.suppressions",
    giveaway_entrants: "contacts.giveaway", referrals: "contacts.referrals", pipelines: "sales.pipelines", pipeline_stages: "sales.pipeline_stages",
    opportunities: "sales.opportunities", tasks: "sales.tasks", jobs: "work.jobs",
  };
  const plan = runner.phasePlan();
  for (const [entity, owner] of Object.entries(OWNERS)) {
    assert.equal(plan.find((p) => p.entity === entity).name, owner, `${entity}: the first phase in the plan`);
    assert.equal(runner.rowSource(plan, plan.find((p) => p.name === owner), "R1"), `${entity}:R1`);
  }
});
