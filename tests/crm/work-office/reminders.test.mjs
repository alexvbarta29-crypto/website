// M4a acceptance (design §11.4 "reminders.test.mjs", §5.7.4, §7.6): the
// floor and seeded markers are respected; imported future visits are
// eligible; the catch-up rules (2-day if 1-2 days out; 14-day if 7-14 days
// out and never sent; never for a visit booked less than 14 days out).
// Everything stays in the outbox (dry run).
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, customer, importedCustomer, job, visit, store, drain, outbox, OFF, IMPORT, AS } from "./fixtures.mjs";
import { pin } from "../../helpers/crm-clock.mjs";

const sentFor = (t, template) => outbox(t).filter((o) => o.template_key === template).map((o) => o.related && o.related.visit_id);

test("the 10:00 batch: 14-day and 2-day reminders with their catch-up windows, seeded markers, imported future visits", async () => {
  const { t, owner } = await setup("2026-10-20T15:00:00Z");
  try {
    const mk = async (date) => visit(owner, await job(owner, await customer(owner)), { date, start: "09:00", end: "11:00" });
    const A = await mk("2026-12-01");   // 14 days out
    const B = await mk("2026-11-27");   // 10 days out: the 14-day catch-up
    const C = await mk("2026-11-28");   // 11 days out, but the cutover seeded Rotor's reminder
    const D = await mk("2026-11-19");   // 2 days out
    const E = await mk("2026-11-18");   // 1 day out: the 2-day catch-up
    const F = await mk("2026-11-20");   // 3 days out: nothing yet
    const X = await mk("2026-12-05");   // 18 days out: nothing yet
    // an imported customer's future visit (Rotor's): eligible for reminders
    const ic = await importedCustomer();
    const [ij] = await OFF.createJobs([{ contact_id: ic.id, kind: "standard", lines: [{ title: "Window cleaning", unit_cents: 25000 }] }], "import-job-1", "import", IMPORT);
    const G = (await OFF.createVisit({ job_id: ij, date: "2026-11-19", start: "10:00", end: "12:00", window: { type: "exact", minutes: 0 } }, IMPORT)).visit;
    assert.equal(G.created_by, "import");
    await store.putRaw(`done/visit.reminder_14d/${C.id}--${C.date}`, { state: "done", result: "seeded", at: "2026-11-14T16:00:00.000Z" }, { onlyIfNew: true });

    // Tuesday Nov 17, 10:00 in Delano: the batch
    pin("2026-11-17T16:00:00Z");
    const H = await mk("2026-11-30");   // booked today, 13 days out: its confirmation covers it
    await drain(t, 6);
    const d14 = sentFor(t, "visit_reminder_14d");
    assert.deepEqual(d14.sort(), [A.id, B.id].sort(), "14 days out and the catch-up; not the seeded one, not one booked late");
    assert.deepEqual(sentFor(t, "visit_reminder_14d_email").sort(), [A.id, B.id].sort(), "the 14-day reminder is a text and an email");
    assert.deepEqual(sentFor(t, "visit_reminder_2d").sort(), [D.id, E.id, G.id].sort(), "2 days out, the catch-up, and the imported future visit");
    for (const v of [F, X, H, C]) assert.ok(!sentFor(t, "visit_reminder_2d").includes(v.id) && !d14.includes(v.id));
    // the words: the date and the arrival window
    const g = outbox(t).find((o) => o.template_key === "visit_reminder_2d" && o.related.visit_id === G.id);
    assert.ok(g.body.startsWith(`REMINDER: Hi ${ic.first_name}, Barta Window Washing is scheduled to visit on Thu, Nov 19, at 10:00 AM. Reply if you have any questions!`), g.body);
    const a = outbox(t).find((o) => o.template_key === "visit_reminder_14d" && o.related.visit_id === A.id);
    assert.match(a.body, /on Tue, Dec 1, arriving between 9:00 and 11:00 AM\./);
    assert.ok(outbox(t).every((o) => o.mode === "dry_run"), "nothing leaves the site");
    const log = t.stores.data.keys("alog/").join("\n");
    assert.match(log, /visit\.reminder_14d--.*--skipped-seeded/);
    assert.match(log, /visit\.reminder_14d--.*--skipped-booked_late/);

    // the next day's batch sends nothing twice (the marker is per visit and date); F is 2 days out now
    const before = outbox(t).length;
    pin("2026-11-18T16:00:00Z");
    await drain(t, 4);
    const day2 = outbox(t).slice(before).filter((o) => /^visit_reminder/.test(o.template_key));
    assert.deepEqual(day2.map((o) => [o.template_key, o.related.visit_id]), [["visit_reminder_2d", F.id]]);
    // a visit moved is reminded again for its new date; one already reminded for its date is not
    pin("2026-11-19T16:00:00Z");
    await OFF.changeVisit(D.id, "reschedule", { patch: { date: "2026-11-21" }, ctx: AS(owner) });
    const before3 = outbox(t).length;
    await drain(t, 4);
    const day3 = outbox(t).slice(before3).filter((o) => o.template_key === "visit_reminder_2d").map((o) => o.related.visit_id);
    assert.deepEqual(day3, [D.id], "D for Nov 21; F (Nov 20) was reminded yesterday");
  } finally { t.done(); }
});

test("the eligibility floor: nothing whose reminder came due before cfg/automations.effective_from", async () => {
  const { t, owner } = await setup("2026-10-20T15:00:00Z");
  try {
    const v = await visit(owner, await job(owner, await customer(owner)), { date: "2026-11-19", start: "09:00", end: "11:00" });
    pin("2026-11-17T16:00:00Z");
    const cfg = await t.api("/settings/automations", { as: owner });
    const put = await t.api("/settings/automations", { method: "PUT", as: owner, ifMatch: cfg.body.data.etag || "new", body: { ...cfg.body.data.data, effective_from: "2026-11-18T00:00:00.000Z" } });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    await drain(t, 4);
    assert.deepEqual(sentFor(t, "visit_reminder_2d"), []);
    assert.match(t.stores.data.keys("alog/").join("\n"), new RegExp(`visit\\.reminder_2d--${v.id}--skipped-before_floor`));
  } finally { t.done(); }
});

test("a reminder queued for a visit that moved or was cancelled since is skipped when it comes due", async () => {
  const { t, owner } = await setup("2026-10-20T15:00:00Z");
  try {
    const v = await visit(owner, await job(owner, await customer(owner)), { date: "2026-11-19", start: "09:00", end: "11:00" });
    const w = await visit(owner, await job(owner, await customer(owner)), { date: "2026-11-19", start: "13:00", end: "15:00" });
    pin("2026-11-17T08:00:00Z");      // 02:00: confirmations long done, the batch not yet
    await drain(t, 3);
    pin("2026-11-17T16:00:00Z");
    // the sweep queues the reminders (their send is due now) but the fast lane hasn't sent them yet
    const { runAutomation } = await import("../../../netlify/lib/crm/core/automations.mjs");
    await runAutomation("visit.reminder_2d", { id: v.id, today: "2026-11-17" }, {});
    await runAutomation("visit.reminder_2d", { id: w.id, today: "2026-11-17" }, {});
    await OFF.changeVisit(v.id, "reschedule", { patch: { start: "10:00", end: "12:00" }, ctx: AS(owner) });
    await OFF.changeVisit(w.id, "cancel", { reason: "customer called", ctx: AS(owner) });
    await drain(t, 4);
    const sent = outbox(t).filter((o) => o.template_key === "visit_reminder_2d");
    assert.equal(sent.filter((o) => o.related.visit_id === w.id).length, 0, "cancelled: skipped");
    // the moved one went out once, with its new time (the sweep queues it again for the new slot only after the old one is skipped)
    assert.ok(sent.filter((o) => o.related.visit_id === v.id).every((o) => /10:00 AM and 12:00 PM/.test(o.body)), JSON.stringify(sent.map((o) => o.body)));
    assert.match(t.stores.data.keys("alog/").join("\n"), /visit\.reminder_2d--.*--skipped-changed/);
  } finally { t.done(); }
});
