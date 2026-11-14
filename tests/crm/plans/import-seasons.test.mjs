// Lights seasons from Rotor exports that hold two lights plans for one
// place and year, and a plan whose customer's own row was refused (a
// 2-character ZIP: the customer pointer is claimed, the contact never
// written). Shapes seen on the Nov 13 export (counts only): 7 places with
// 2-3 lights plans for 2026 (empty One-Time containers left beside the
// real plan, and two active plans each with a scheduled install), and one
// empty lights container whose customer row was refused. Before: 10 rows
// "That is already taken" (the season pointer) and 1 "That contact isn't
// there anymore" (its takedown). After: one season per place and year, led
// by the plan whose install got furthest, the others named on it; one
// takedown per place; the plan, season and takedown on the customer's own
// contact id (its placeholder); a second run changes nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, importExport, generate, runner } from "../import/fixtures.mjs";

const { idForRotor } = await import("../../../netlify/lib/crm/core/ids.mjs");
const IMP = await import("../../../netlify/lib/crm/modules/plans/import-rotor.mjs");

let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const clone = (x) => JSON.parse(JSON.stringify(x));

// The export: the generator's, plus the three shapes on fresh synthetic customers.
function exportWithShapes() {
  const ex = generate({ scale: 0.06, seed: 31 });
  const lightsPlan = ex.service_plans.find((p) => (p.service_types || []).includes("Christmas Lights") && p.jobs.length === 1);
  const jobRow = ex.jobs.find((j) => j.id === lightsPlan.jobs[0].id);
  const baseCustomer = ex.customers.find((c) => c.id === lightsPlan.customer.id);
  const customer = (first, zip = "55357") => {
    const c = { ...clone(baseCustomer), id: uuid(), first_name: first, last_name: "Example", email: `${first.toLowerCase()}.example@example.com`, phone: `+1763555${String(1000 + n).slice(-4)}`, address: { ...baseCustomer.address, street1: `${100 + n} Sample St`, zip } };
    ex.customers.push(c);
    return c;
  };
  let number = Math.max(...ex.jobs.map((j) => Number(j.job_number))) + 1;
  const plan = (c, { jobs = [], active = false, created }) => {
    const p = { ...clone(lightsPlan), id: uuid(), active, cancelled: false, start_date: "2026-08-03T19:12:48.000+00:00", created_at: created, customer: { id: c.id, first_name: c.first_name, last_name: c.last_name, company_name: "" }, jobs: jobs.map((j) => ({ id: j.id, status: j.status })) };
    ex.service_plans.push(p);
    return p;
  };
  const job = (c, status, start) => {
    const j = { ...clone(jobRow), id: uuid(), job_number: String(number++).padStart(7, "0"), status, start_date: start, end_date: start, customer: { id: c.id, first_name: c.first_name, last_name: c.last_name, company_name: "" }, line_items: jobRow.line_items.map((l) => ({ ...clone(l), id: uuid() })) };
    ex.jobs.push(j);
    return j;
  };
  // A: an empty container (no jobs, not active) made before the real plan, whose install is done
  const a = customer("Avery");
  const aEmpty = plan(a, { created: "2026-07-01T15:00:00Z" });
  const aJob = job(a, "Completed", "2026-11-02T15:00:00.000+00:00");
  const aReal = plan(a, { jobs: [aJob], created: "2026-07-02T15:00:00Z" });
  aJob.service_plan_id = aReal.id;
  // B: two active plans, each with an install (one scheduled, one not yet), and a third empty one
  const b = customer("Blake");
  const bJob1 = job(b, "Pending", "2026-11-20T15:00:00.000+00:00");
  const bJob2 = job(b, "Pending", "2026-11-21T15:00:00.000+00:00");
  const b1 = plan(b, { jobs: [bJob1], active: true, created: "2026-08-10T15:00:00Z" });
  const b2 = plan(b, { jobs: [bJob2], active: true, created: "2026-08-01T15:00:00Z" });
  const b3 = plan(b, { created: "2026-07-20T15:00:00Z" });
  bJob1.service_plan_id = b1.id; bJob2.service_plan_id = b2.id;
  // C: a customer whose own row is refused (a 2-character ZIP) with an empty lights container
  const c = customer("Casey", "55");
  const cPlan = plan(c, { created: "2026-08-05T15:00:00Z" });
  return { ex, a, aEmpty, aReal, aJob, b, b1, b2, b3, bJob1, bJob2, c, cPlan };
}

test("the lead of a place's lights plans: furthest install, then active, then oldest", () => {
  const x = (rid, status, job, planStatus, created) => ({ rid, status, job: job ? {} : null, plan: { status: planStatus, created_at: created } });
  assert.equal(IMP.leadOf([x("p1", "sold", false, "expired", "2026-07-01"), x("p2", "installed", true, "expired", "2026-07-02")]).rid, "p2");
  assert.equal(IMP.leadOf([x("p1", "sold", true, "active", "2026-08-10"), x("p2", "sold", true, "active", "2026-08-01"), x("p3", "sold", false, "expired", "2026-07-20")]).rid, "p2");
  assert.equal(IMP.leadOf([x("p1", "install_scheduled", true, "expired", "2026-08-10"), x("p2", "sold", true, "active", "2026-08-01")]).rid, "p1");
  assert.equal(IMP.leadOf([x("p1", "cancelled", true, "cancelled", "2026-01-01"), x("p2", "sold", false, "expired", "2026-08-01")]).rid, "p2", "a cancelled install never leads");
  // the same answer whatever order the rows come in
  const g = [x("p1", "sold", true, "active", "2026-08-10"), x("p2", "sold", true, "active", "2026-08-01"), x("p3", "sold", false, "expired", "2026-07-20")];
  assert.equal(IMP.leadOf([...g].reverse()).rid, IMP.leadOf(g).rid);
});

test("two lights plans on one place and year share one season; a refused customer row still gets its plan, season and takedown", async () => {
  const { t, owner } = await setup();
  try {
    const s = exportWithShapes();
    const first = await importExport(t, owner, s.ex);
    assert.equal(first.run.status, "done", JSON.stringify(first.run.summary));
    const st = await runner.loadState(first.ir.id);
    const lights = st.phases["plans.lights"];
    assert.deepEqual(lights.skipped, {}, `no row refused: ${JSON.stringify(lights.errors)}`);
    assert.equal(lights.warnings.lights_season_shared, 3, "A's empty container, B's other active plan and B's empty one");
    assert.equal(lights.warnings.lights_season_merged, 2);
    assert.equal(st.phases["plans.plans"].warnings.plan_contact_missing_placeholder, 1);

    const S = t.stores.data;
    const seasons = S.keys("rec/season_install/").map((k) => S.json(k));
    const of = (c) => seasons.filter((x) => x.contact_id === idForRotor("contact", c.id));

    // A: the real plan leads (its install is done); the empty container is named on it
    const [sa] = of(s.a);
    assert.equal(of(s.a).length, 1);
    assert.equal(sa.plan_id, idForRotor("plan", s.aReal.id));
    assert.equal(sa.status, "installed");
    assert.equal(sa.install_job_id, idForRotor("job", s.aJob.id));
    assert.deepEqual(sa.rotor.also_service_plan_ids, [s.aEmpty.id]);
    assert.ok(sa.takedown_job_id, "one takedown for the house");

    // B: the older active plan leads; the other install stays a job of its own plan; one takedown
    const [sb] = of(s.b);
    assert.equal(of(s.b).length, 1);
    assert.equal(sb.plan_id, idForRotor("plan", s.b2.id));
    assert.equal(sb.install_job_id, idForRotor("job", s.bJob2.id));
    assert.deepEqual(sb.rotor.also_service_plan_ids, [s.b1.id, s.b3.id].sort());
    assert.deepEqual(sb.rotor.also_install_job_ids, [s.bJob1.id]);
    assert.equal(S.json(`rec/job/${idForRotor("job", s.bJob1.id)}`).plan_id, idForRotor("plan", s.b1.id), "the second install keeps its plan");
    const takedowns = (c) => S.keys("rec/job/").map((k) => S.json(k)).filter((j) => j.kind === "lights_takedown" && j.contact_id === idForRotor("contact", c.id));
    assert.equal(takedowns(s.a).length, 1);
    assert.equal(takedowns(s.b).length, 1);
    assert.equal(takedowns(s.b)[0].season_install_id, sb.id);

    // C: the customer's row was refused, but its id holds the customer's placeholder;
    // the plan, the season and the takedown are on it
    const cid = idForRotor("contact", s.c.id);
    const contact = S.json(`rec/contact/${cid}`);
    assert.ok(contact, "the customer's contact exists");
    assert.equal(contact.flags.placeholder, true);
    assert.equal(contact.first_name, "Casey");
    assert.equal(S.json(`ptr/rotor/customer/${s.c.id}`).id, cid, "the customer's pointer and the contact agree");
    assert.equal(S.json(`rec/plan/${idForRotor("plan", s.cPlan.id)}`).contact_id, cid);
    const [sc] = of(s.c);
    assert.ok(sc, "its season");
    assert.equal(takedowns(s.c).length, 1, "and its takedown");
    assert.equal(S.json(`rec/job/${sc.takedown_job_id}`).contact_id, cid);

    // a second run: nothing new, nothing changed
    const snap = Object.fromEntries(["season_install", "plan", "contact"].flatMap((type) => S.keys(`rec/${type}/`).map((k) => [k, JSON.stringify(S.json(k))])));
    const jobs = S.keys("rec/job/").length;
    const again = await importExport(t, owner, s.ex);
    assert.equal(again.run.status, "done");
    assert.equal(again.run.summary.created, 0);
    assert.equal(again.run.summary.skipped, 0);
    assert.equal(S.keys("rec/job/").length, jobs, "no takedown twice");
    for (const [k, v] of Object.entries(snap)) assert.equal(JSON.stringify(S.json(k)), v, `${k} unchanged`);
  } finally { t.done(); }
});

test("a season an earlier import made for the other plan is taken over, not tripped over", async () => {
  const { t, owner } = await setup();
  try {
    const s = exportWithShapes();
    // the earlier import (before this fix): the empty container's row came first and took the place's season
    const earlier = clone(s.ex);
    earlier.service_plans = earlier.service_plans.filter((p) => p.id !== s.aReal.id);
    const r0 = await importExport(t, owner, earlier);
    assert.equal(r0.run.status, "done");
    const S = t.stores.data;
    const old = S.keys("rec/season_install/").map((k) => S.json(k)).find((x) => x.rotor.service_plan_id === s.aEmpty.id);
    assert.ok(old && old.takedown_job_id, "the empty container's season, with its takedown");
    // now the whole export
    const r1 = await importExport(t, owner, s.ex);
    assert.equal(r1.run.status, "done");
    assert.equal(r1.run.summary.skipped, 0, JSON.stringify(r1.run.summary));
    const now = S.keys("rec/season_install/").map((k) => S.json(k)).filter((x) => x.contact_id === idForRotor("contact", s.a.id));
    assert.equal(now.length, 1, "still one season for the place");
    assert.equal(now[0].id, old.id, "the same record");
    assert.equal(now[0].plan_id, idForRotor("plan", s.aReal.id), "now led by the real plan");
    assert.equal(now[0].install_job_id, idForRotor("job", s.aJob.id));
    assert.equal(now[0].takedown_job_id, old.takedown_job_id, "its takedown kept, none made twice");
    assert.equal(S.keys("rec/job/").map((k) => S.json(k)).filter((j) => j.kind === "lights_takedown" && j.contact_id === idForRotor("contact", s.a.id)).length, 1);
  } finally { t.done(); }
});
