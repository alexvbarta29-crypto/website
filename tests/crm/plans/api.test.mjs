// The plans module's staff API (design §5.4 "Endpoints"): the list with its
// counts, one plan with its visits and their jobs, visits due by town, the
// cancel calculator, a price change, the clawback, agreement templates
// (list, preview, create), agreements (create, send, void), and who may do
// what (techs nothing).
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, staffPlan, customer, planOf, recOf, finishRun, drain, outbox, pin, AG } from "./fixtures.mjs";

test("list, one plan, visits due, the calculator, a price change, the clawback", async () => {
  const { t, owner, admin, tech } = await setup();
  try {
    const a = await staffPlan(t, owner);
    const b = await staffPlan(t, owner, { contact: await customer(owner, {}, { town: "Mound" }) });
    await t.api(`/plans/${b.plan.id}/activate`, { method: "POST", as: owner, body: { override_reason: "Paper copy" } }).then((r) => finishRun(t, r.body.data.run_id));
    const list = await t.api("/plans", { as: admin });
    assert.equal(list.status, 200);
    assert.equal(list.body.data.length, 2);
    assert.equal(list.body.meta.counts.pending, 1);
    assert.equal(list.body.meta.counts.active, 1);
    assert.equal(list.body.meta.counts.due, 1, "the active plan's first visit is due this month");
    assert.equal((await t.api("/plans?status=pending", { as: admin })).body.data[0].id, a.plan.id);
    assert.equal((await t.api(`/plans?contact=${a.contact.id}`, { as: admin })).body.data.length, 1);
    const one = await t.api(`/plans/${a.plan.id}`, { as: admin });
    assert.equal(one.status, 200);
    assert.equal(one.body.data.plan.ordinals[1].total_cents, 6000);
    assert.equal(one.body.data.plan.ordinals[0].job.status, "unscheduled");
    assert.deepEqual(one.body.data.readiness, ["signature"]);
    assert.equal(one.body.data.catalog_entry.renews_every_months, 3);
    assert.equal(one.body.data.features.jobs, true);
    const due = await t.api("/plans/due", { as: admin });
    assert.equal(due.body.data.visits.length, 1, "the active plan's visit (a pending plan waits for its signature)");
    assert.equal(due.body.data.visits[0].town, "Mound");
    assert.equal((await t.api("/plans/due?month=2027-02", { as: admin })).body.data.visits.length, 2);
    const q = await t.api(`/plans/${b.plan.id}/cancel-quote?requested_on=2026-11-20`, { as: admin });
    assert.equal(q.body.data.effective_on, "2026-11-27");
    assert.equal(q.body.data.clawback_cents, 0);
    // a price change: 30 days' notice, not inside the locked first year
    const etag = one.headers.get("etag");
    assert.equal((await t.api(`/plans/${b.plan.id}/change-price`, { method: "POST", as: owner, body: { effective_on: "2027-03-01", new_lines: [{ title: "Exterior Window Cleaning", unit_cents: 31500 }] } })).status, 400, "locked");
    const pc = await t.api(`/plans/${b.plan.id}/change-price`, { method: "POST", as: owner, body: { effective_on: "2027-11-17", new_lines: [{ title: "Exterior Window Cleaning", unit_cents: 31500 }] } });
    assert.equal(pc.status, 200, JSON.stringify(pc.body));
    assert.equal((await planOf(b.plan.id)).renewal.price_change.effective_on, "2027-11-17");
    // a stale edit is refused
    assert.equal((await t.api(`/plans/${a.plan.id}`, { method: "PATCH", as: owner, ifMatch: '"stale"', body: { name: "Changed" } })).status, 412);
    assert.equal((await t.api(`/plans/${a.plan.id}`, { method: "PATCH", as: owner, ifMatch: etag, body: { name: "Quarterly care" } })).status, 200);
    // techs: nothing
    for (const [m, p] of [["GET", "/plans"], ["GET", `/plans/${a.plan.id}`], ["GET", "/plans/due"], ["POST", `/plans/${a.plan.id}/pause`], ["GET", "/agreements"], ["GET", "/lights/seasons/2026"]]) {
      assert.equal((await t.api(p, { method: m, as: tech, body: m === "POST" ? {} : undefined })).status, 403, `${m} ${p}`);
    }
  } finally { t.done(); }
});

test("the clawback: a cancel inside the first year after visit 1 was done waits for the owner; billed or waived (waiving needs a reason)", async () => {
  const { t, owner, admin } = await setup();
  try {
    const { plan } = await staffPlan(t, owner);
    await t.api(`/plans/${plan.id}/activate`, { method: "POST", as: owner, body: { override_reason: "Paper copy" } }).then((r) => finishRun(t, r.body.data.run_id));
    const WORK = (await import("./fixtures.mjs")).WORK;
    const { scope, AS } = await import("./fixtures.mjs");
    await scope(() => WORK.createVisit({ job_id: plan.ordinals[0].job_id, date: "2026-11-18", start: "09:00", end: "11:00", assignee_ids: [] }, { write: () => AS(owner) }));
    await scope(() => WORK.completeJob(plan.ordinals[0].job_id, { write: () => AS(owner) }));
    await drain(t, 3);
    assert.equal((await t.api(`/plans/${plan.id}/cancel`, { method: "POST", as: admin, body: { reason: "moving" } })).status, 400, "an admin adds a note");
    const c = await t.api(`/plans/${plan.id}/cancel`, { method: "POST", as: admin, body: { reason: "moving", note: "Selling the house" } });
    await finishRun(t, c.body.data.run_id);
    let p = await planOf(plan.id);
    assert.equal(p.cancel.clawback_cents, 10000);
    assert.equal(p.cancel.clawback_state, "to_bill");
    assert.equal((await t.api("/plans?status=clawback", { as: owner })).body.data.length, 1);
    const badge = await t.api("/me/badges", { as: owner });
    assert.ok(badge.body.data.approvals >= 1, "the owner's approvals count includes it");
    const etag = (await t.api(`/plans/${plan.id}`, { as: owner })).headers.get("etag");
    assert.equal((await t.api(`/plans/${plan.id}`, { method: "PATCH", as: owner, ifMatch: etag, body: { clawback: "waived" } })).status, 400, "a reason");
    const w = await t.api(`/plans/${plan.id}`, { method: "PATCH", as: owner, ifMatch: etag, body: { clawback: "waived", reason: "Moving out of state" } });
    assert.equal(w.status, 200, JSON.stringify(w.body));
    p = await planOf(plan.id);
    assert.equal(p.cancel.clawback_state, "waived");
    assert.equal((await t.api("/plans?status=clawback", { as: owner })).body.data.length, 0);
  } finally { t.done(); }
});

test("agreement templates and agreements: list, preview, create, send by text and email (the Outbox), void", async () => {
  const { t, owner, admin } = await setup();
  try {
    const list = await t.api("/agreement-templates", { as: admin });
    assert.equal(list.body.data.length, 6, "six texts: Custom has its own");
    assert.ok(list.body.data.every((x) => x.approved));
    const prev = await t.api("/agreement-templates/preview", { method: "POST", as: admin, body: { catalog_key: "biannual", body_md: "## Hi {{first_name}}\n\nYour {{plan_name}} at {{per_visit_price}}." } });
    assert.equal(prev.status, 200);
    assert.equal(prev.body.data.text, "## Hi Pat\n\nYour Biannual plan at $245.00 a visit.");
    assert.equal((await t.api("/agreement-templates", { method: "POST", as: admin, body: { key: "spring_special", name: "Spring", body_md: "x" } })).status, 403, "owners edit the texts");
    const made = await t.api("/agreement-templates", { method: "POST", as: owner, body: { key: "spring_special", name: "Spring special", body_md: "## {{plan_name}}\n\nThanks {{full_name}}!" } });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(made.body.data.version, 1);
    const { plan } = await staffPlan(t, owner);
    const ag = await t.api("/agreements", { method: "POST", as: admin, body: { plan_id: plan.id } });
    assert.equal(ag.status, 201, JSON.stringify(ag.body));
    assert.match(ag.body.data.body_rendered, /Quarterly plan service agreement/);
    assert.equal((await t.api("/agreements", { method: "POST", as: admin, body: { plan_id: plan.id } })).body.data.id, ag.body.data.id, "an open one is reused");
    const sent = await t.api(`/agreements/${ag.body.data.id}/send`, { method: "POST", as: admin, body: { channels: ["sms", "email"] } });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.data.agreement.status, "sent");
    await drain(t, 3);
    const msgs = outbox(t).filter((o) => /^agreement_sent/.test(o.template_key || ""));
    assert.equal(msgs.length, 2, "a text and an email (dry-run)");
    assert.ok(msgs.every((o) => o.mode === "dry_run"));
    assert.doesNotMatch(msgs.find((o) => o.kind === "sms" || o.template_key === "agreement_sent").body, /—/);
    assert.equal((await t.api(`/agreements?plan=${plan.id}`, { as: admin })).body.data.length, 1);
    assert.equal((await t.api("/agreements?status=sent", { as: admin })).body.data.length, 1);
    const v = await t.api(`/agreements/${ag.body.data.id}/void`, { method: "POST", as: admin, body: { reason: "Wrong plan" } });
    assert.equal(v.body.data.status, "void");
    assert.equal((await planOf(plan.id)).agreement_status, "none");
    // the next day: no reminder for a voided agreement
    pin("2026-11-18T16:30:00Z");
    await drain(t, 2);
    assert.equal(outbox(t).filter((o) => o.template_key === "agreement_unsigned").length, 0);
  } finally { t.done(); }
});

test("agreement.unsigned: a reminder a day for a sent, unsigned agreement, at most 7", async () => {
  const { t, owner } = await setup();
  try {
    const { plan } = await staffPlan(t, owner);
    await t.api(`/plans/${plan.id}/send-agreement`, { method: "POST", as: owner, body: { channels: ["sms"] } });
    await drain(t, 2);
    for (let d = 18; d <= 27; d++) {
      pin(`2026-11-${d}T16:30:00Z`);
      await drain(t, 2);
    }
    const reminders = outbox(t).filter((o) => o.template_key === "agreement_unsigned");
    assert.equal(reminders.length, 7, "up to 7 times");
    const ag = await recOf("agreement", (await planOf(plan.id)).agreement_id);
    assert.equal(ag.reminders.count, 7);
  } finally { t.done(); }
});
