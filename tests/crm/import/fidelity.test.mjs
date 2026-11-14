// Fidelity of the Rotor import (docs/CRM-IMPORT.md "Field by field"): the
// real export's own layout (Rotor's file names, the contact each quote row
// carries) packs into everything the import reads; a partial record (the
// plan discounts a plan row puts on its jobs) speaks only about its fields;
// and a new import of the SAME export after the mapping changed brings the
// newly mapped values onto the records an earlier import made, while a
// field someone changed in the CRM stays theirs. Synthetic exports only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setup, importExport, generate, store, runner, ids } from "./fixtures.mjs";
import { rotorLayout } from "../fixtures/rotor-synthetic.mjs";

const pack = await import("../../../build/crm_import_pack.mjs");
const { writeMapped } = await import("../../../netlify/lib/crm/modules/import/ownership.mjs");
const { getType } = await import("../../../netlify/lib/crm/core/registry.mjs");
const { rotorKey, stripeKey } = await import("../../../netlify/lib/crm/modules/contacts/display.mjs");
const QI = await import("../../../netlify/lib/crm/modules/quotes/import-rotor.mjs");
const PI = await import("../../../netlify/lib/crm/modules/plans/import-rotor.mjs");
const { idForRotor } = ids;
const IMPORT = { by: "import", origin: "import", actor_kind: "import", requestId: "test", bulk: true, audit: false };
const clone = (v) => JSON.parse(JSON.stringify(v));
const json = (t, k) => t.stores.data.json(k);
const records = (t, type) => t.stores.data.keys(`rec/${type}/`).map((k) => t.stores.data.json(k));
const cents = (d) => Math.round(Number(d) * 100);

// The export as the integrator's folder holds it (Rotor's names), read back the way the pack reads it.
function viaPack(ex) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "barta-fidelity-"));
  try {
    for (const [name, text] of Object.entries(rotorLayout(ex))) writeFileSync(path.join(dir, name), text);
    const read = pack.readExport(dir);
    return { read, staged: Object.fromEntries(Object.entries(read.entities).map(([e, v]) => [e, v.rows])) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("the real export's layout: Rotor's file names, its contact list left out, quote contacts made from the quote rows (only the fields the import reads)", () => {
  const ex = generate({ scale: 0.05, seed: 5 });
  const { read } = viaPack(ex);
  const e = read.entities;
  assert.equal(e.member_availability.rows.length, ex.member_availability.length, "availability.jsonl is the team's weekly hours");
  assert.equal(e.member_availability.from, "availability.jsonl");
  assert.equal(e.rate_settings.rows.length, 1, "the pay rates are one JSON object");
  assert.ok(Array.isArray(e.rate_settings.rows[0].hourly_rates) && Array.isArray(e.rate_settings.rows[0].commission_rates));
  assert.equal(e.contacts, undefined, "contacts.jsonl repeats customers and leads: not packed");
  assert.equal(read.skipped.contacts, ex.customers.length + ex.leads.length);
  const qc = e.quote_contacts.rows;
  assert.equal(e.quote_contacts.from, "quotes.jsonl");
  assert.equal(qc.length, new Set(ex.quotes.map((q) => q.contact.id)).size, "one row per quoted contact");
  const allowed = new Set(["id", "contact_type", "created_at", "updated_at", "messaging_config", "muted_channels", "stripe_customer_id", "converted_from_lead_id", "notes", "priority", "stage", "last_called_at", "sync"]);
  for (const row of qc) {
    for (const k of Object.keys(row)) assert.ok(allowed.has(k), `${k} isn't copied`);
    if (row.sync) assert.deepEqual(Object.keys(row.sync.meta).filter((k) => k === "raw_field_data"), [], "the Meta form's answers (name, email, phone) aren't copied");
  }
  assert.ok(qc.some((r) => r.contact_type === "lead") && qc.some((r) => r.converted_from_lead_id), "leads and converted customers");
  // an export that has its own quote_contacts.jsonl keeps it
  const dir = mkdtempSync(path.join(os.tmpdir(), "barta-fidelity-"));
  try {
    writeFileSync(path.join(dir, "quotes.jsonl"), ex.quotes.map((q) => JSON.stringify(q)).join("\n") + "\n");
    writeFileSync(path.join(dir, "quote_contacts.jsonl"), ex.quote_contacts.map((q) => JSON.stringify(q)).join("\n") + "\n");
    assert.equal(pack.readExport(dir).entities.quote_contacts.rows.length, ex.quote_contacts.length);
    assert.equal(pack.readExport(dir).entities.quote_contacts.from, "quote_contacts.jsonl");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an export in Rotor's layout imports in full: team hours and pay rates, consent, Stripe ids and converted leads from the quote rows (leads too), notes, lead priority, tips paid on their own, line details, opportunity notes", async () => {
  const { t, owner } = await setup();
  try {
    const ex = generate({ scale: 0.06, seed: 11 });
    const { staged } = viaPack(ex);
    const r = await importExport(t, owner, staged, { as_of: "2026-11-13" });
    assert.equal(r.run.status, "done", JSON.stringify(r.run.summary));
    const st = await runner.loadState(r.ir.id);
    const ph = (n) => st.phases[n];
    assert.equal(ph("system.availability").read, ex.member_availability.length, "the weekly hours are read");
    assert.ok(ph("system.availability").extras.patched > 0);
    assert.equal(ph("system.rates").read, 1, "the pay rates are read");
    assert.ok(ph("system.rates").extras.patched > 0);
    assert.equal(ph("contacts.quote_contacts").read, staged.quote_contacts.length);
    assert.equal(ph("contacts.quote_contacts").warnings.quote_contact_unknown || 0, 0, "every customer row finds its contact");
    assert.equal(ph("contacts.quote_contacts_leads").warnings.quote_contact_unknown || 0, 0, "every lead row finds its contact (after contacts.leads)");
    // consent and Stripe ids from the quote rows, customers and leads alike
    for (const q of staged.quote_contacts) {
      const id = json(t, `ptr/rotor/${q.contact_type}/${rotorKey(q.id)}`).id;
      const c = json(t, `rec/contact/${id}`);
      if (q.messaging_config && q.messaging_config.sms && q.messaging_config.sms.opted_in) assert.equal(c.consent.sms_service.state, "granted", `${q.contact_type} consent`);
      if (q.stripe_customer_id) assert.ok((json(t, `ptr/stripe-cus/${stripeKey(q.stripe_customer_id)}`).ids || []).includes(id), "the Stripe id names the contact");
      if (q.converted_from_lead_id) assert.equal(json(t, `ptr/rotor/lead/${rotorKey(q.converted_from_lead_id)}`).id, id, "a converted lead names its customer");
      if (q.sync && q.sync.meta && q.sync.meta.form_name) assert.equal(c.source.form, q.sync.meta.form_name, "the Meta lead form");
    }
    // a lead Rotor marks high priority shows it; every lead keeps Rotor's priority and stage
    const high = ex.leads.find((l) => l.priority === "high");
    if (high) {
      const c = json(t, `rec/contact/${json(t, `ptr/rotor/lead/${rotorKey(high.id)}`).id}`);
      assert.ok(c.tags.includes("High priority"));
      assert.equal(c.rotor.priority, "high");
    }
    // a tip paid on its own: a payment of $0 with its tip, nothing skipped
    assert.equal(ph("money.payments").skipped.invalid || 0, 0);
    const tipRow = ex.payments.find((p) => p.payment_type === "tip");
    assert.ok(tipRow, "the synthetic export has a tip row");
    const tip = json(t, `rec/payment/${idForRotor("payment", tipRow.id)}`);
    assert.deepEqual([tip.amount_cents, tip.tip_cents, tip.rotor.type_raw], [0, tipRow.tip_cents, "tip"]);
    // the money comparison still agrees with Rotor's own sums
    const rep = (await t.api(`/import/runs/${r.ir.id}/report`, { as: owner })).body.data;
    assert.equal(rep.summary.money_checked, true);
    assert.equal(rep.summary.money_diffs, 0, "the tip row counts as a tip on both sides");
    // an invoice line's details, an opportunity's note
    const detailed = ex.invoices.find((i) => (i.line_items || []).some((l) => l.details));
    if (detailed) assert.ok(json(t, `rec/invoice/${idForRotor("invoice", detailed.id)}`).lines.some((l) => l.description.endsWith(": Front and back")));
    const noted = ex.opportunities.find((o) => o.notes);
    if (noted) assert.ok(records(t, "deal").some((d) => (d.history || []).some((h) => h.opportunity_id === noted.id && h.note === noted.notes)), "the opportunity's note is in the deal's history");
  } finally { t.done(); }
});

test("a partial record speaks only about its fields: never makes a record, fills an empty field, takes Rotor's changes, conflicts with a person's edit", async () => {
  const { t } = await setup();
  try {
    const def = getType("job");
    const id = idForRotor("job", "partial-test");
    const base = { ...def.example(), id, number: 991, seq: "job", title: "Exterior window cleaning" };
    const disc = (v) => [{ id: "dc_r1", name: "Bi-Annual Discount", type: "fixed", value: v, scope: { type: "all" } }];
    const runId = idForRotor("import_run", "partial-test");
    const w = (rec, source) => store.withStoreScope({ requestId: "t" }, () => writeMapped(rec, { runId, source, ctx: IMPORT }));
    const PLAN = "service_plans:p1~plans.plans";
    assert.equal((await w({ type: "job", data: { ...base, discounts: disc(5000) }, fields: ["discounts"] }, PLAN)).outcome, "missing", "a partial record never makes one");
    assert.equal(await store.getRecord("job", id), null);
    assert.equal((await w({ type: "job", data: { ...base, discounts: [] } }, "jobs:j1")).outcome, "created");
    // the plan's discounts land; the other fields of the partial record (a different title) are ignored
    const first = await w({ type: "job", data: { ...base, title: "Something else", discounts: disc(5000) }, fields: ["discounts"] }, PLAN);
    assert.equal(first.outcome, "linked");
    let job = (await store.getRecord("job", id)).data;
    assert.deepEqual([job.title, job.discounts[0].value, job.totals.total_cents], ["Exterior window cleaning", 5000, 29500 - 5000]);
    assert.equal((await w({ type: "job", data: { ...base, discounts: disc(5000) }, fields: ["discounts"] }, PLAN)).outcome, "unchanged");
    assert.equal((await w({ type: "job", data: { ...base, discounts: [] } }, "jobs:j1")).outcome, "unchanged", "the jobs row (no discounts) keeps quiet about them");
    // Rotor changes the plan discount: taken (nobody touched it)
    assert.equal((await w({ type: "job", data: { ...base, discounts: disc(7500) }, fields: ["discounts"] }, PLAN)).outcome, "updated");
    job = (await store.getRecord("job", id)).data;
    assert.equal(job.discounts[0].value, 7500);
    assert.equal(job.import.hash.length, 64, "the record's hash covers every rotorField");
    // a person changes the job's discount, then Rotor changes the plan's: a conflict, the person's value stays
    await store.updateRecord("job", id, (r) => ({ ...r, discounts: disc(1000) }), { by: "us_0000000000000000000a", origin: "app", actor_kind: "user", requestId: "t" });
    const c = await w({ type: "job", data: { ...base, discounts: disc(9000) }, fields: ["discounts"] }, PLAN);
    assert.deepEqual([c.outcome, c.conflicts], ["conflicted", ["discounts"]]);
    assert.equal((await store.getRecord("job", id)).data.discounts[0].value, 1000);
  } finally { t.done(); }
});

// The mapping as it was before this change (the live CRM's Nov 13 import ran it):
// a multi discount with `enabled: false` dropped, optional lines unticked, no job notes, no plan discounts on jobs.
function oldMapping() {
  const quote = QI.phases.find((p) => p.name === "quotes.quotes");
  const plan = PI.phases.find((p) => p.name === "plans.plans");
  const saved = { qn: quote.normalize, qm: quote.map, pm: plan.map };
  quote.normalize = (row) => {
    const r = saved.qn(row);
    const d = row.jobs_config && row.jobs_config.discounts;
    if (d && d.enabled === false) r.discounts = [];
    r.job_notes = "";
    return r;
  };
  quote.map = async (r, ctx) => {
    const out = await saved.qm(r, ctx);
    for (const rec of out.records || []) if (rec.type === "quote") for (const o of rec.data.options) { for (const l of o.lines) delete l.selected; }
    return out;
  };
  plan.map = async (r, ctx) => { const out = await saved.pm(r, ctx); return { ...out, records: (out.records || []).filter((x) => !x.fields) }; };
  return () => { quote.normalize = saved.qn; quote.map = saved.qm; plan.map = saved.pm; };
}

test("a new import of the same export after the mapping changed: the newly mapped values come in on the records the earlier import made; a field someone changed stays theirs; then nothing more", async () => {
  const { t, owner } = await setup();
  try {
    const ex = generate({ scale: 0.06, seed: 41 });
    // run 1 (the live Nov 13 import): the old mapping
    const restore = oldMapping();
    let first;
    try { first = await importExport(t, owner, ex, { as_of: "2026-11-13" }); } finally { restore(); }
    assert.equal(first.run.status, "done");
    const gone = ex.quotes.filter((q) => q.jobs_config.discounts && q.jobs_config.discounts.enabled === false && QI.discountEntries(q.jobs_config.discounts).length);
    assert.ok(gone.length >= 2, `quotes whose discounts the old mapping dropped: ${gone.length}`);
    const qOf = (row) => json(t, `rec/quote/${idForRotor("quote", row.id)}`);
    for (const row of gone) assert.notEqual(qOf(row).options[0].totals.first_cents, cents(row.total), "before: the quote misses its discount");
    const openJobs = ex.jobs.filter((j) => j.status !== "Completed" && records(t, "job").some((x) => x.rotor && x.rotor.job_id === j.id));
    const jobOf = (row) => json(t, `rec/job/${idForRotor("job", row.id)}`);
    const discountedJobs = openJobs.filter((j) => jobOf(j).totals.total_cents !== cents(j.due_amount));
    assert.ok(discountedJobs.length >= 2, "before: jobs miss their plan's discount");

    // between the runs, people work in the CRM
    const PERSON = { by: owner.id, origin: "app", actor_kind: "user", requestId: "t" };
    const [qa, qb] = gone;
    await store.updateRecord("quote", qOf(qa).id, (q) => ({ ...q, client_notes: "Edited in the CRM" }), PERSON);          // a field the new mapping doesn't touch
    await store.updateRecord("quote", qOf(qb).id, (q) => ({ ...q, options: q.options.map((o) => ({ ...o, name: "Edited option" })) }), PERSON);   // the field the new mapping changes
    const [ja, jb] = discountedJobs;
    await store.updateRecord("job", jobOf(ja).id, (j) => ({ ...j, crew_notes: "Edited in the CRM" }), PERSON);
    await store.updateRecord("job", jobOf(jb).id, (j) => ({ ...j, discounts: [{ id: "dc_own", name: "Owner's own", type: "fixed", value: 100, scope: { type: "all" } }] }), PERSON);

    // run 2: the same export (a new upload of the same pack), the new mapping
    const second = await importExport(t, owner, ex, { as_of: "2026-11-13" });
    assert.equal(second.run.status, "done", JSON.stringify(second.run.summary));
    for (const row of gone.filter((x) => x !== qb)) {
      const o = qOf(row).options[0];
      assert.equal(o.totals.first_cents, cents(row.total), `Q-${row.quote_number} now totals Rotor's`);
      assert.equal(o.discounts.length, QI.discountEntries(row.jobs_config.discounts).length);
    }
    assert.equal(qOf(qa).client_notes, "Edited in the CRM", "the person's notes stay");
    assert.equal(qOf(qb).options[0].name, "Edited option", "an edited field the new mapping changes is a conflict, never overwritten");
    for (const row of discountedJobs.filter((x) => x !== jb)) assert.equal(jobOf(row).totals.total_cents, cents(row.due_amount), `job ${row.job_number} now totals Rotor's due amount`);
    assert.equal(jobOf(ja).crew_notes, "Edited in the CRM");
    assert.deepEqual(jobOf(jb).discounts.map((d) => d.name), ["Owner's own"], "a discount someone set on a job stays");
    const list = (await t.api(`/import/runs/${second.ir.id}/conflicts`, { as: owner })).body.data;
    assert.deepEqual(list.map((c) => [c.type, c.id, c.field]), [["quote", qOf(qb).id, "options"]], "exactly one conflict: the edited quote's options");

    // run 3: the same again: nothing new is written (the open conflict is still listed)
    const third = await importExport(t, owner, ex, { as_of: "2026-11-13" });
    assert.equal(third.run.summary.created, 0);
    assert.equal(third.run.summary.updated, 0);
    assert.equal(third.run.summary.conflicted, 1);
  } finally { t.done(); }
});

test("a customer's quote row names the lead it was converted from: one contact on a fresh import; after an import that made the lead its own contact, the owner is offered the merge", async () => {
  const { t, owner } = await setup();
  try {
    const ex = generate({ scale: 0.03, seed: 17 });
    const C = ex.customers[20];
    const L = ex.leads.find((l) => l.phone && l.phone !== C.phone && l.email !== C.email && !ex.customers.some((c) => c.phone === l.phone));
    const row = { id: C.id, contact_type: "customer", converted_from_lead_id: L.id, messaging_config: {}, muted_channels: [] };
    // the live CRM's first import: no quote contact rows, so the lead became a contact of its own
    const first = await importExport(t, owner, { ...ex, quote_contacts: [] }, { as_of: "2026-11-13" });
    assert.equal(first.run.status, "done");
    const cid = json(t, `ptr/rotor/customer/${rotorKey(C.id)}`).id;
    const lid = json(t, `ptr/rotor/lead/${rotorKey(L.id)}`).id;
    assert.notEqual(cid, lid);
    // the same export with the quote rows' contacts: the merge is offered, nothing is moved by itself
    const second = await importExport(t, owner, { ...ex, quote_contacts: [row] }, { as_of: "2026-11-13" });
    assert.equal(second.run.status, "done");
    const cands = records(t, "merge_candidate").filter((m) => [m.a, m.b].includes(cid) && [m.a, m.b].includes(lid));
    assert.equal(cands.length, 1, "one merge candidate for the converted lead");
    assert.equal(cands[0].confidence, "high");
    assert.ok(json(t, `rec/contact/${cid}`).rotor.lead_ids.includes(L.id), "the customer knows its lead id");
    assert.equal(json(t, `ptr/rotor/lead/${rotorKey(L.id)}`).id, lid, "the lead's pointer isn't taken over");
    // on a fresh import the two are one contact
    const { t: t2, owner: o2 } = await setup();
    try {
      const fresh = await importExport(t2, o2, { ...ex, quote_contacts: [row] }, { as_of: "2026-11-13" });
      assert.equal(fresh.run.status, "done");
      assert.equal(json(t2, `ptr/rotor/lead/${rotorKey(L.id)}`).id, json(t2, `ptr/rotor/customer/${rotorKey(C.id)}`).id);
    } finally { t2.done(); }
  } finally { t.done(); }
});
