// "Bring in the rest" (docs/CRM-IMPORT.md): when a module ships after an
// import, a continuation run brings its part of the SAME export in from the
// rows that are still staged: no upload, no key. Synthetic data only.
//
// The parts that "ship" here in the middle of a test are the REAL phases, as
// on production, where the first import finished before the deploys that
// registered the tech app (work.timesheets, work.timers), Money
// (money.invoices, money.credits, money.payments) and Messages
// (comms.templates, comms.campaigns, comms.messages, comms.pin_types): they
// are hidden from the plan at first (runner.__hidePhasesForTests, through
// notShipped() below; every test that hides some shows them all again at its
// end), then shown. A hidden phase the catalog names waits for its module;
// money.credits, which the catalog doesn't name, isn't in the first run's
// plan at all and still runs when Money ships.
//
// Payroll shipped (M7a) after this file was written: its real phase is
// hidden until a test "ships" it (shipPayroll), like a part not deployed
// yet; the stand-ins of the later tests are fixtures (fixture.* names). The registry lives for the
// whole file: a fixture one test registers runs in the later tests' first
// runs, so every test that needs a fixture part to "go live" uses a name no
// earlier test registered.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, runToEnd, importExport, store, runner, generate, ids } from "./fixtures.mjs";
import { fixtureModule, fixtureType } from "../../helpers/crm-fixtures.mjs";
import { advance, minutes, hours, days } from "../../helpers/crm-clock.mjs";

const { getModule, allModules } = await import("../../../netlify/lib/crm/core/registry.mjs");
const C = await import("../../../netlify/lib/crm/modules/import/continue.mjs");
const { deployContext } = await import("../../../netlify/lib/crm/core/context.mjs");
const lanes = await import("../../../netlify/lib/crm/core/lanes.mjs");

const sweepOf = (key) => getModule("import").sweeps.find((s) => s.key === key);
const DEPLOY = () => deployContext(new Request("https://www.bartawindowwashing.com/"), {});
const SWEEP_CTX = { mode: { paused: false }, budget: null, write: () => ({ by: "system:import.continue", origin: "worker", actor_kind: "automation", requestId: "sweep" }) };
const runSweep = (key = "import.continue", ctx = SWEEP_CTX) => store.withStoreScope({ deploy: DEPLOY(), requestId: "sweep" }, () => sweepOf(key).run(ctx));
const runsOf = (t) => t.stores.data.keys("rec/import_run/").map((k) => t.stores.data.json(k));
const continuations = (t) => runsOf(t).filter((r) => r.continues);
const notices = (t) => t.stores.data.keys("rec/notification/").map((k) => t.stores.data.json(k));
const recs = (t, type) => t.stores.data.keys(`rec/${type}/`).map((k) => t.stores.data.json(k));
const rest = async (t, owner) => (await t.api("/import/rest", { as: owner })).body.data;
const go = (t, who) => t.api("/import/continue", { method: "POST", as: who, body: {} });

// ------------------------------------------------------------ the parts that go live later

// The real phases of the parts that shipped after the first import.
const TECH = ["work.timesheets", "work.timers"];
const MONEY = ["money.invoices", "money.credits", "money.payments"];
const COMMS = ["comms.templates", "comms.campaigns", "comms.messages", "comms.pin_types"];
// The parts (lists of phase names) not deployed yet: their phases are left out of the plan. notShipped() = all live.
let payrollLive = false;
let hidden = [];
const notShipped = (...parts) => { hidden = parts.flat(); runner.__hidePhasesForTests([...hidden, ...(payrollLive ? [] : ["payroll.payroll"])]); };
notShipped();

// Stand-ins for parts that aren't built: a type of their own, nothing a real module declares.
const LATE = fixtureType("fixture_late", "zl", { rotorFields: ["label", "rotor"], example: () => ({ label: "Sample" }) });
let typesRegistered = false;
const lateTypes = () => { if (typesRegistered) return []; typesRegistered = true; return [LATE]; };
const mapGeneric = (kind) => async (r) => ({ records: [{ type: "fixture_late", data: { id: ids.idForRotor("fixture_late", `${kind}:${r.id}`), label: String(r.name || r.line_label || r.id), rotor: { [`${kind}_id`]: String(r.id) } } }] });
const pass = (r) => r;
const ship = (name, entity, kind) => fixtureModule({ types: lateTypes(), importPhases: [{ name, entity, after: ["system.users"], normalize: pass, map: mapGeneric(kind) }] });
// Payroll goes live (once in the file: by the first test that needs it)
const shipPayroll = () => { if (!payrollLive) { payrollLive = true; runner.__hidePhasesForTests(hidden); } };

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
// What was read under imp/{run}/raw/ since `from` (an index into the store's call log): [run id, entity] per read.
const rawReads = (t, from = 0) => t.stores.data.calls.slice(from).filter((c) => /^get/.test(c.op) && /^imp\/[a-z]{2}_[0-9a-z]{20}\/raw\//.test(c.key || "")).map((c) => [c.key.split("/")[1], c.key.split("/")[3]]);
// The staged entities a run read (those of the upload `root`), and anything else read under a raw/.
const stagedRead = (reads, root) => [...new Set(reads.filter(([run]) => run === root).map(([, e]) => e))].sort();
const otherRead = (reads, root) => [...new Set(reads.filter(([run]) => run !== root).map(([run, e]) => `${run}/${e}`))].sort();
const drain = async (t) => { for (let i = 0; i < 4; i++) { await t.runWorker({ lane: "fast" }); } };

// ------------------------------------------------------------ the story

test("the rest of an export comes in by itself as each part goes live: the tech app's timesheets and timers, then Money, then Messages; then a fresh import changes nothing", async () => {
  const { t, owner } = await setup({ now: "2026-11-17T15:00:00Z" });
  let spy = null;
  try {
    const ex = generate({ scale: 0.03, seed: 51 });
    // one invoice with a gift card on it (Rotor's credits are only what invoice lines show: money.credits, row 30)
    const gift = ex.invoices.find((i) => i.customer && i.line_items.every((l) => l.total_cents !== undefined));
    gift.line_items.push({ kind: "credit", title: "Gift Card", quantity: 1, unit_price_cents: -500, total_cents: -500 });
    gift.subtotal_cents -= 500;
    gift.total_cents -= 500;
    // the first import, as on production: it finished before the tech app (timesheets, visit timers), Money and
    // Messages were deployed; Payroll isn't built
    notShipped(TECH, MONEY, COMMS);
    const r1 = await importExport(t, owner, ex);
    assert.equal(r1.run.status, "done");
    const root = r1.ir.id;
    const rec1 = (await store.getRecord("import_run", root)).data;
    assert.deepEqual([...rec1.waiting].sort(), [...TECH, "money.invoices", "money.payments", ...COMMS, "payroll.payroll"].sort(),
      "the finished run lists what still waits: the catalog's phases of the parts not shipped (money.credits isn't one of them)");
    for (const type of ["timesheet", "timer", "invoice", "credit", "payment", "message", "conversation", "campaign"]) assert.equal(recs(t, type).length, 0, type);
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
    notShipped(MONEY, COMMS);
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
    const reads0 = rawReads(t, mark0);
    assert.deepEqual(stagedRead(reads0, root), ["timesheets", "visit_timers"], "only their staged rows were read");
    assert.deepEqual(otherRead(reads0, root), []);
    assert.ok(["money.invoices", "money.payments", "comms.messages", "payroll.payroll"].every((n) => st0.phases[n].status === "waiting"), "the rest keeps waiting");
    assert.equal(st0.phases["money.credits"], undefined, "a phase of a part not shipped that the catalog doesn't name isn't in the plan");
    // the real mappers found what the FIRST run made: the team map (a timesheet's person), the visits (a timer's visit)
    const sheets = recs(t, "timesheet");
    assert.equal(sheets.length, ex.timesheets.length);
    assert.ok(sheets.every((x) => t.stores.data.has(`rec/user/${x.user_id}`)), "each timesheet on a person the first run mapped");
    assert.ok(!st0.phases["work.timesheets"].warnings.timesheet_user_unknown, "the first run's team map was used");
    const timers = recs(t, "timer");
    assert.equal(timers.length, ex.visit_timers.length);
    assert.ok(timers.filter((x) => x.visit_id).length > 0 && timers.filter((x) => x.visit_id).every((x) => t.stores.data.has(`rec/visit/${x.visit_id}`)), "each timer on a visit the first run imported");
    const rep00 = (await t.api(`/import/runs/${c0.id}/report`, { as: owner })).body.data;
    assert.equal(rep00.summary.read, ex.timesheets.length + ex.visit_timers.length);
    assert.equal(rep00.summary.created, sheets.length + timers.length);
    assert.equal(rep00.integrity.timers_running, (await t.api(`/import/runs/${root}/report`, { as: owner })).body.data.integrity.timers_running, "the integrity counts are the first run's");
    await drain(t);
    assert.equal(notices(t).filter((n) => n.user_id === owner.id && n.link === `/import/${c0.id}` && /is in$/.test(n.title))[0].body,
      `Timesheets and visit timers from your Rotor export of Nov 10 are in: ${ex.timesheets.length} timesheets, ${ex.visit_timers.length} timers.`, "in records made");
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

    // ---- later, Money goes live (another deploy): the next hourly pass starts a second continuation, for Money
    // only: its three phases, the credits one included, which the first run's plan didn't know
    notShipped(COMMS);
    spy = spyPhases();
    v = await rest(t, owner);
    assert.deepEqual(v.ready.map((x) => [x.phase, x.rows]), [["money.invoices", ex.invoices.length], ["money.credits", ex.invoices.length], ["money.payments", ex.payments.length]]);
    assert.ok(v.ready.every((x) => x.module_label === "Money"), "the part's name comes from the phase, named in the catalog or not");
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
    // only the phases that waited (or weren't planned) and are registered now ran; nothing done before was read again
    const st1 = await runner.loadState(c1.id);
    const ran = Object.entries(st1.phases).filter(([, p]) => p.read > 0).map(([n]) => n).sort();
    assert.deepEqual(ran, [...MONEY].sort());
    assert.deepEqual(Object.keys(spy.calls).sort(), [...MONEY].sort(), "no other phase mapped a row");
    assert.deepEqual([spy.calls["money.invoices"], spy.calls["money.credits"], spy.calls["money.payments"]], [ex.invoices.length, ex.invoices.length, ex.payments.length], "the credits step reads every invoice row again");
    const reads1 = rawReads(t, mark);
    assert.deepEqual(stagedRead(reads1, root), ["invoices", "payments"], "only the staged rows of those phases were read (the report re-read nothing)");
    assert.deepEqual(otherRead(reads1, root), []);
    assert.equal(st1.phases["contacts.customers"].status, "done");
    assert.equal(st1.phases["contacts.customers"].earlier, root, "done in the first run");
    assert.equal(st1.phases["contacts.customers"].read, 0);
    assert.equal(st1.phases["work.timers"].earlier, c0.id, "done in the first continuation");
    assert.equal(st1.phases["work.timers"].read, 0);
    assert.equal(st1.phases["money.credits"].earlier, undefined);
    assert.equal(st1.phases["comms.messages"].status, "waiting");
    assert.equal(st1.staging_run, root);
    assert.deepEqual(st1.users, (await runner.loadState(root)).users, "the team map of the first run");
    // the invoices landed on the contacts and jobs the FIRST run made (its pointers), and linked themselves on the jobs
    const invoices = recs(t, "invoice");
    assert.equal(invoices.length, ex.invoices.length);
    assert.ok(invoices.every((i) => before.has(`rec/contact/${i.contact_id}`)), "each invoice on a contact from the first run");
    assert.ok(!st1.phases["money.invoices"].warnings.invoice_placeholder_contact);
    const withJob = invoices.filter((i) => i.job_ids.length);
    assert.ok(withJob.length > 0);
    for (const i of withJob) assert.ok(before.has(`rec/job/${i.job_ids[0]}`) && t.stores.data.json(`rec/job/${i.job_ids[0]}`).invoice_ids.includes(i.id), "the job from the first run now names its invoice");
    assert.equal(st1.phases["money.invoices"].extras.patched, withJob.length, "one patch per invoice with a job (a new invoice's status patch changes nothing)");
    // the gift card: a settled credit on the first run's contact, for the invoice this run made
    const credits = recs(t, "credit");
    assert.deepEqual(credits.map((c) => [c.applied_invoice_id, c.amount_cents, c.status, c.kind]), [[ids.idForRotor("invoice", gift.id), 500, "settled", "imported"]]);
    assert.ok(before.has(`rec/contact/${credits[0].contact_id}`));
    // the payments found the invoices this run made, and went into their applied maps
    const payments = recs(t, "payment");
    assert.equal(payments.length, ex.payments.length);
    assert.ok(payments.every((p) => before.has(`rec/contact/${p.contact_id}`)), "each payment on a contact from the first run");
    const linked = payments.filter((p) => p.invoice_id);
    assert.ok(linked.length > 0 && linked.every((p) => t.stores.data.json(`rec/invoice/${p.invoice_id}`).applied[p.id]));
    assert.equal(st1.phases["money.payments"].extras.patched, linked.length);
    // nothing an earlier phase owns was rewritten: contacts, properties, their bases and pointers are untouched
    const touched = t.stores.data.keys("").filter((k) => before.get(k) !== t.stores.data.etagOf(k) && /^(rec\/(contact|property|user|quote|plan|visit|deal|enrollment)\/|ib\/(contact|property|user|quote|plan|visit|job)\/|ptr\/rotor\/(customer|lead|job|quote)\/)/.test(k));
    assert.deepEqual(touched, []);
    // the jobs the invoices patched are listed again (bulk writes, then the run's own index rebuild)
    assert.ok(["job", "invoice", "credit", "payment"].every((x) => st1.types.includes(x)), JSON.stringify(st1.types));
    // the report: this run's counts, the run it continues, the chain's totals; Rotor's money as before, and now
    // the CRM's side of it (both money steps have run)
    const rep = (await t.api(`/import/runs/${c1.id}/report`, { as: owner })).body.data;
    const rep0 = (await t.api(`/import/runs/${root}/report`, { as: owner })).body.data;
    assert.equal(rep.continues, c0.id);
    assert.deepEqual(rep.chain.runs, [root, c0.id, c1.id]);
    assert.equal(rep.summary.created, ex.invoices.length + credits.length + ex.payments.length);
    assert.equal(rep.summary.read, 2 * ex.invoices.length + ex.payments.length);
    assert.equal(rep.summary.phases_run, 3);
    assert.equal(rep.chain.totals.created, rep0.summary.created + rep00.summary.created + rep.summary.created, "added to the totals of the runs before it");
    assert.equal(rep.chain.totals.read, rep0.summary.read + rep00.summary.read + rep.summary.read);
    assert.deepEqual(rep.money.rotor, rep0.money.rotor);
    assert.deepEqual([rep0.summary.money_checked, rep00.summary.money_checked, rep.summary.money_checked], [false, false, true], "the comparison is made once the invoices and payments steps have run");
    assert.deepEqual([rep.money.crm.ok, rep.money.crm.diffs, rep.summary.pass], [true, [], true], "the CRM's money adds up to Rotor's");
    assert.deepEqual([rep.money.crm.invoices.count, rep.money.crm.invoices.total_cents, rep.money.crm.payments.count], [ex.invoices.length, rep.money.rotor.invoices.total_cents, ex.payments.length]);
    assert.equal(rep.phases.find((p) => p.name === "contacts.customers").earlier, root);
    assert.ok(!rep.waiting.some((w) => w.phase.startsWith("money.")) && rep.waiting.some((w) => w.phase === "comms.messages"));
    assert.deepEqual([rep00.summary.phases_waiting, rep.summary.phases_waiting], [rep0.summary.phases_waiting - 2, rep0.summary.phases_waiting - 4]);
    const csv = (await t.api(`/import/runs/${c1.id}/report.csv`, { as: owner })).text;
    assert.match(csv, new RegExp(`chain,,runs,${root} ${c0.id} ${c1.id}`));
    assert.match(csv, /money,crm,reconciled,yes/);
    // the owners were told when it started and when it was done (in the app; push by their choice)
    await drain(t);
    const told = notices(t).filter((n) => n.user_id === owner.id).sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
    assert.equal(told.length, 2);
    assert.match(told.find((n) => /Bringing in/.test(n.title)).body, /^Invoices, credits and payments from your Rotor export of Nov 10 are being brought in now\./);
    const fin = told.find((n) => /is in$/.test(n.title));
    // an invoice with no credit line is nothing for the credits step to make, not a row that made nothing
    assert.equal(st1.phases["money.credits"].none, 0);
    assert.equal(fin.body, `Invoices, credits and payments from your Rotor export of Nov 10 are in: ${ex.invoices.length} invoices, 1 credit, ${ex.payments.length} payments.`);
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
    notShipped();
    spy = spyPhases();
    const before2 = new Set(t.stores.data.keys(""));
    const mark2 = t.stores.data.calls.length;
    const made = await go(t, owner);
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.deepEqual(made.body.data.phases.map((p) => [p.phase, p.rows]), [["comms.templates", ex.message_templates.length], ["comms.campaigns", ex.campaigns.length], ["comms.messages", ex.messages.length], ["comms.pin_types", ex.map_pin_types.length]]);
    const c2id = made.body.data.run.id;
    assert.equal(made.body.data.run.continues, c1.id, "it goes on from the latest finished run");
    assert.equal((await go(t, owner)).status, 409, "one import at a time");
    assert.equal((await t.api("/import/runs", { method: "POST", as: owner, body: {} })).status, 409, "no new upload while it runs");
    const done2 = await runToEnd(t, owner, c2id, { start: false });
    assert.equal(done2.run.status, "done");
    const c2 = (await store.getRecord("import_run", c2id)).data;
    assert.equal(c2.staging_run, root, "still the rows of the one upload");
    assert.equal(c2.auto, undefined);
    assert.deepEqual(Object.keys(spy.calls).sort(), [...COMMS].sort());
    const reads2 = rawReads(t, mark2);
    assert.deepEqual(stagedRead(reads2, root), ["campaigns", "map_pin_types", "message_templates", "messages"]);
    assert.deepEqual(otherRead(reads2, root), [`${c2id}/comms-conv`], "and the messages step's own summaries, kept under this run");
    const st2 = await runner.loadState(c2id);
    assert.equal(st2.phases["money.invoices"].earlier, c1.id, "done in the continuation before");
    assert.equal(st2.phases["money.credits"].earlier, c1.id);
    assert.equal(st2.phases["work.timesheets"].earlier, c0.id);
    assert.equal(st2.phases["contacts.customers"].earlier, root);
    assert.deepEqual(st2.chain, [root, c0.id, c1.id]);
    // every message written once, in a conversation per contact and channel, on the contacts of the first run
    // (or on a placeholder for a contact the export doesn't have, made now)
    const msgs = recs(t, "message");
    assert.equal(msgs.length, ex.messages.length);
    const convs = recs(t, "conversation");
    assert.ok(convs.length > 0 && msgs.every((m) => t.stores.data.has(`rec/conversation/${m.conversation_id}`) && t.stores.data.has(`rec/contact/${m.contact_id}`)));
    const placeholders = t.stores.data.keys("rec/contact/").filter((k) => !before2.has(k)).map((k) => t.stores.data.json(k));
    assert.ok(placeholders.every((c) => c.flags.placeholder));
    assert.ok(msgs.every((m) => before2.has(`rec/contact/${m.contact_id}`) || placeholders.some((c) => c.id === m.contact_id)), "messages on the contacts of the first run");
    assert.equal(t.stores.data.keys("ib/message/").length, 0, "a message is written once: no import base");
    assert.ok(Object.keys(t.stores.data.json(`ib/conversation/${convs[0].id}`).sources)[0].endsWith("~comms.messages"), "the same source a full run gives (the opt-out phase reads messages first)");
    // the templates and the campaign; the pin types the step's finish keeps in the settings
    const tpls = recs(t, "template").filter((x) => x.rotor);
    assert.equal(tpls.length, ex.message_templates.filter((x) => !x.is_example).length);
    assert.equal(recs(t, "campaign").length, ex.campaigns.length);
    assert.equal(t.stores.data.json("cfg/pin_types").types.length, ex.map_pin_types.length);
    const rep2 = (await t.api(`/import/runs/${c2id}/report`, { as: owner })).body.data;
    assert.deepEqual(rep2.chain.runs, [root, c0.id, c1.id, c2id]);
    assert.equal(rep2.chain.totals.created, rep.chain.totals.created + rep2.summary.created);
    assert.equal(rep2.quality.warnings.messages_written, ex.messages.length, "the report counts the messages the step wrote itself");
    await drain(t);
    const fin2 = notices(t).filter((n) => n.user_id === owner.id && n.link === `/import/${c2id}`);
    assert.equal(notices(t).filter((n) => n.link === `/import/${c2id}`).length, 2, "both owners");
    assert.equal(fin2.length, 1, "asked for on the screen: one note, when it's done");
    // in records made (the messages are counted in their conversations); the rows that made nothing are Rotor's
    // example templates, which the report names, not the messages or the pin types
    const examples = ex.message_templates.filter((x) => x.is_example).length;
    assert.deepEqual([tpls.length, ex.campaigns.length, placeholders.length, convs.length, examples], [26, 1, 1, 67, 19], "(this export)");
    assert.equal(fin2[0].body, "Message templates, campaigns, messages and map pin types from your Rotor export of Nov 10 are in: 26 templates, 1 campaign, 1 contact, 67 conversations. 19 rows made nothing (the report says why).");
    assert.deepEqual(COMMS.map((n) => st2.phases[n].none), [examples, 0, 0, 0]);
    assert.equal(rep2.quality.warnings.template_rotor_example_skipped, examples);

    // ---- a fresh full import of the same export afterwards (days later): everything is found as it is
    spy.restore(); spy = null;
    advance(days(3));
    // the sweeps those days brought due run first (Money's daily customer lifetime totals fill in the money stats
    // of the contacts the continuation gave payments): what is looked at below is what the import writes
    for (let i = 0; i < 2; i++) await t.runWorker({ lane: "bulk" });
    assert.ok(t.stores.data.keys("rec/contact_stats/").some((k) => (t.stores.data.json(k).money || {}).lifetime_cents > 0));
    const snap = new Map(t.stores.data.keys("").map((k) => [k, t.stores.data.etagOf(k)]));
    const r4 = await importExport(t, owner, ex);
    assert.equal(r4.run.status, "done");
    assert.deepEqual([r4.run.summary.created, r4.run.summary.updated, r4.run.summary.linked, r4.run.summary.conflicts_open], [0, 0, 0, 0], "all unchanged");
    const st4 = await runner.loadState(r4.ir.id);
    assert.ok(st4.phases["money.invoices"].read === ex.invoices.length && !st4.phases["money.invoices"].earlier, "a full run reads everything itself");
    assert.ok(st4.phases["money.credits"].read === ex.invoices.length && st4.phases["comms.messages"].read === ex.messages.length);
    const rewritten = t.stores.data.keys("").filter((k) => snap.get(k) !== t.stores.data.etagOf(k) && /^(rec\/(?!import_run|run|event|notification)|ib\/|ptr\/rotor\/|rel\/|ix\/(?!import-runs|runs)|cfg\/pin_types)/.test(k));
    assert.deepEqual(rewritten, [], "no record, base, pointer, relation, list or setting was written");
    const rep4 = (await t.api(`/import/runs/${r4.ir.id}/report`, { as: owner })).body.data;
    assert.deepEqual([rep4.money.crm.ok, rep4.money.crm.invoices, rep4.money.crm.payments], [rep.money.crm.ok, rep.money.crm.invoices, rep.money.crm.payments], "the same money comparison as the continuation's");
    assert.equal(r4.run.continues, undefined);
  } finally { notShipped(); if (spy) spy.restore(); t.done(); }
});

// ------------------------------------------------------------ staging

test("it refuses when the export's rows are gone, with a plain message; the rows are kept 30 days from their last use and never under a continuation", async () => {
  const { t, owner } = await setup({ now: "2026-11-17T15:00:00Z" });
  try {
    const ex = generate({ scale: 0.02, seed: 52 });
    notShipped(COMMS);
    const r1 = await importExport(t, owner, ex);
    const root = r1.ir.id;
    const gc = () => runSweep("import.staging_gc", { budget: null });
    const rawCount = () => t.stores.data.keys(`imp/${root}/raw/`).length;
    const had = rawCount();
    assert.ok(had > 10);
    // day 20: Messages goes live and a continuation is made; it sits in the queue (the lane is busy) until day 45
    advance(days(20));
    notShipped();
    const c1 = (await go(t, owner)).body.data.run;
    assert.equal(Date.parse((await store.getRecord("import_run", root)).data.staging_used_at), Date.parse(r1.run.finished_at) + days(20), "making it stamps the rows as used");
    advance(days(25));
    await gc();
    assert.equal(rawCount(), had, "kept under a continuation that reads them, 45 days after the upload");
    assert.equal((await runToEnd(t, owner, c1.id, { start: false })).run.status, "done");
    const used = (await store.getRecord("import_run", root)).data.staging_used_at;
    assert.equal(Date.parse(used), Date.parse(r1.run.finished_at) + days(45), "finishing it stamps the last use");
    // the messages step kept its summaries (addresses, previews) under the continuation's own raw/, beside nothing else
    const ownRaw = () => t.stores.data.keys(`imp/${c1.id}/raw/`);
    assert.ok(ownRaw().length > 0 && ownRaw().every((k) => k.startsWith(`imp/${c1.id}/raw/comms-conv/`)), JSON.stringify(ownRaw()));
    // day 60: long after the upload finished, 15 days after its last use: kept
    advance(days(15));
    await gc();
    assert.equal(rawCount(), had, "30 days from the last use, not from the upload");
    assert.ok(ownRaw().length > 0);
    assert.equal((await rest(t, owner)).keep_until.slice(0, 10), new Date(Date.parse(used) + 30 * 86400000).toISOString().slice(0, 10));
    // day 76: gone, and the continuation's summaries with them
    advance(days(16));
    await gc();
    assert.equal(rawCount(), 0, "cleared 30 days after the last use");
    assert.deepEqual(ownRaw(), [], "what the continuation's phases kept beside the rows goes with them");
    assert.ok((await store.getRecord("import_run", root)).data.staging_cleared_at, "the run says its rows were cleared");
    assert.ok(t.stores.data.has(`imp/${root}/state`) && t.stores.data.has(`imp/${c1.id}/state`) && t.stores.data.has(`imp/${c1.id}/report`), "the runs, their state and reports stay");
    // another part goes live too late for this export
    shipPayroll();
    const v = await rest(t, owner);
    assert.equal(v.staging, "cleared");
    assert.ok(v.ready.some((x) => x.phase === "payroll.payroll"));
    const res = await go(t, owner);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.message, "That export's rows were cleared. Start a new import.");
    assert.equal((await runSweep()).result, "cleared");
    assert.equal(continuations(t).length, 1, "nothing was started");
    // one chunk missing is the same as all of them (a half-cleared export is never imported)
    notShipped(["comms.campaigns"]);
    const r2 = await importExport(t, owner, ex);
    notShipped();
    assert.ok((await rest(t, owner)).ready.some((x) => x.phase === "comms.campaigns"));
    await store.deleteRaw(t.stores.data.keys(`imp/${r2.ir.id}/raw/campaigns/`)[0]);
    assert.equal((await go(t, owner)).body.error.message, C.CLEARED_MESSAGE);
  } finally { notShipped(); t.done(); }
});

// ------------------------------------------------------------ the hourly check

test("the hourly check starts exactly one continuation, and none while one runs, while an upload is under way or after an owner cancelled", async () => {
  const { t, owner } = await setup({ now: "2026-11-17T15:00:00Z" });
  try {
    const ex = generate({ scale: 0.02, seed: 53 });
    // every part the catalog names is live (Payroll too): the import leaves nothing waiting
    shipPayroll();
    const r1 = await importExport(t, owner, ex);
    assert.deepEqual((await store.getRecord("import_run", r1.ir.id)).data.waiting, []);
    advance(minutes(10));
    // a phase added since, for rows it staged: the hourly check still looks (once: the registered phases changed)
    ship("fixture.templates", "message_templates", "template2");
    // three passes at once (two bulk invocations and a cron fallback): one run
    const res = await Promise.all([runSweep(), runSweep(), runSweep()]);
    assert.equal(continuations(t).length, 1, JSON.stringify(res));
    const c1 = continuations(t)[0];
    assert.equal(t.stores.data.keys("rec/run/").map((k) => t.stores.data.json(k)).filter((r) => r.kind === "import.continue" && r.input.import_run_id === c1.id).length, 1, "one lane run of the continuation kind");
    // while it is queued or running: nothing more
    assert.equal((await runSweep()).result, "busy");
    await t.runWorker({ lane: "bulk" });
    assert.equal((await runSweep()).result, (await store.getRecord("import_run", c1.id)).data.status === "done" ? "nothing_new" : "busy");
    assert.equal((await runToEnd(t, owner, c1.id, { start: false })).run.status, "done");
    for (let i = 0; i < 3; i++) await runSweep();
    assert.equal(continuations(t).length, 1);
    await drain(t);
    assert.equal(notices(t).filter((n) => n.user_id === owner.id && /Bringing in/.test(n.title)).length, 1, "one start note");
    assert.equal(notices(t).filter((n) => n.user_id === owner.id && /^Templates from your Rotor export of Nov 10 are in: \d+ fixture lates\.$/.test(n.body)).length, 1);

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
    for (const k of t.stores.data.keys("rec/run/")) if (t.stores.data.json(k).kind === "import.continue" && t.stores.data.json(k).input.import_run_id === made.run.id) await store.deleteRaw(k);
    assert.equal((await runSweep()).result, "busy", "a start in progress has both within seconds: left alone at first");
    advance(minutes(15));
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
    notShipped(["comms.pin_types"]);
    await importExport(t, owner, ex);
    // the map pin types step goes live
    notShipped();
    assert.equal(t.stores.data.has("cfg/pin_types"), false);
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
    assert.deepEqual(v.ready.map((x) => [x.phase, x.rows]), [["comms.pin_types", ex.map_pin_types.length]], "the screen still offers it");
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
    assert.equal(t.stores.data.json("cfg/pin_types").types.length, ex.map_pin_types.length, "the step's finish kept them, in the continuation");
  } finally { notShipped(); t.done(); }
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
    assert.equal(stuck.run.status, "failed", "the run says it stopped");
    assert.equal(stuck.run.stopped.code, "blobstransienterror");
    assert.equal((await runSweep()).result, "cancelled_before", "a stopped continuation is resumed by a person, not doubled by the check");
    assert.equal(continuations(t).length, 1);
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

test("the notes to the owners: plain words, records made, counts only", () => {
  const run = { id: "ir_00000000000000000001", as_of: "2026-11-10", conflicts: { open: 0 } };
  const ph = (read, records = {}, none = 0) => ({ status: "done", read, records, none });
  const state = (phases) => ({ plan: Object.keys(phases).map((name) => ({ name })), phases });
  assert.equal(C.finishNotice(run, state({ "money.invoices": ph(712, { invoice: { created: 712 } }), "money.payments": ph(690, { payment: { created: 688 } }, 2), "contacts.customers": { status: "done", earlier: "ir_x", read: 0 } })).body,
    "Invoices and payments from your Rotor export of Nov 10 are in: 712 invoices, 688 payments. 2 rows made nothing (the report says why).");
  assert.equal(C.finishNotice(run, state({ "work.timesheets": ph(85, { timesheet: { created: 85 } }), "work.timers": ph(197, { timer: { created: 197 } }) })).body,
    "Timesheets and visit timers from your Rotor export of Nov 10 are in: 85 timesheets, 197 timers.", "what was made, by kind of record");
  assert.equal(C.finishNotice({ ...run, conflicts: { open: 3 } }, state({ "comms.messages": ph(10927, { message: { created: 10927 } }) })).body,
    "Messages from your Rotor export of Nov 10 are in: 10,927 messages. 3 fields to settle on the Import screen.");
  // one phase may make several kinds of record; several phases the same kind
  assert.equal(C.finishNotice(run, state({ "plans.lights": ph(4, { plan: { created: 2 }, job: { created: 4, updated: 1 } }), "comms.templates": ph(45, { template: { created: 45 } }), "comms.campaigns": ph(31, { campaign: { created: 31 } }), "comms.pin_types": ph(9, { map_pin_type: { created: 9 } }), "payroll.payroll": ph(6, { payroll_entry: { created: 6 } }) })).body,
    "Christmas lights seasons, message templates, campaigns and 2 more parts from your Rotor export of Nov 10 are in: 2 plans, 4 jobs, 45 templates, 31 campaigns, and more.");
  // nothing made: said so, with what changed
  assert.equal(C.finishNotice(run, state({ "money.invoices": ph(712, { invoice: { unchanged: 700, updated: 12 } }) })).body, "Invoices from your Rotor export of Nov 10 are checked: nothing new, 12 updated.");
  assert.equal(C.finishNotice(run, state({ "payroll.payroll": ph(6, {}, 6) })).body, "Payroll from your Rotor export of Nov 10 is checked: nothing new. 6 rows made nothing (the report says why).");
  assert.match(C.finishNotice(run, state({ "money.invoices": ph(0) })).body, /^Nothing new was in your Rotor export of Nov 10/);
  assert.equal(C.finishNotice({ id: run.id }, state({ "money.invoices": ph(1, { invoice: { created: 1 } }) })).body, "Invoices from your Rotor export are in: 1 invoice.");
  assert.equal(C.finishNotice(run, state({ "x.y": ph(3, { property: { created: 2 }, map_pin_type: { created: 1 }, address: { created: 3 } }) })).body, "Y from your Rotor export of Nov 10 is in: 2 properties, 1 map pin type, 3 addresses.");
  const s = C.startNotice(run, [{ label: "Invoices" }, { label: "Payments" }]);
  assert.equal(s.title, "Bringing in more of your Rotor export");
  assert.match(s.body, /^Invoices and payments from your Rotor export of Nov 10 are being brought in now\./);
  assert.match(C.startNotice(run, [{ label: "Payroll" }]).body, /^Payroll from your Rotor export of Nov 10 is being brought in now\./);
  const stop = C.stoppedNotice({ ...run, continues: "ir_00000000000000000000", stopped: { code: "blobstransienterror" } });
  assert.equal(stop.body, "Bringing in more of your Rotor export of Nov 10 stopped before it finished (storage kept failing). Open it and tap Resume: nothing done is done again.");
  assert.equal(C.stoppedNotice({ ...run, stopped: { code: "staging_gone" } }).body, "The import of your Rotor export of Nov 10 stopped: that export's rows were cleared. Start a new import to bring in the rest.");
  for (const n of [s, stop, C.finishNotice(run, state({ "money.invoices": ph(712, { invoice: { created: 712 } }) }))]) {
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
