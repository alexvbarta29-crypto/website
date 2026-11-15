// The invoice editor over the API (Rotor's phone invoice): the number (unique,
// never one the CRM's sequences will make), the title, the due date, the
// notes, Bill To, the salesperson, the lines and discounts (totals worked
// out on the server, never taken from the request), If-Match, who may, a
// paid, void or written-off invoice's money left alone, Rotor's own invoices
// read-only until the switch, "Mark as Sent" (nothing sent), Flyra's New
// Invoice fields, and a card charge with a tip for the crew.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, customer, importedCustomer, openInvoice, invoiceOf, recs, texts, outbox, drain, scope, store, uuid, saveCard, bookedJob, jobInvoice, IMPORT, AS } from "./fixtures.mjs";

const draft = (t, as, c, lines) => openInvoice(t, as, c, { issue: false, lines });
const read = async (t, as, id) => (await t.api(`/invoices/${id}`, { as })).body.data;
const patch = async (t, as, id, body, etag) => t.api(`/invoices/${id}`, { method: "PATCH", as, ifMatch: etag ?? (await read(t, as, id)).etag, body });

test("a draft's editor: number, title, due date, notes, Bill To and the lines with a discount; totals are the server's; the audit row says who", async () => {
  const { t, owner, admin } = await setup();
  try {
    const c = await customer(owner);
    const d = await draft(t, admin, c);
    const s0 = await read(t, admin, d.id);
    assert.deepEqual([s0.edit.details, s0.edit.money, s0.edit.due, s0.can.mark_sent], [true, true, true, true]);
    const r = await patch(t, admin, d.id, {
      number: "BW-2026-17", title: "Fall windows", due_on: "2026-11-30", customer_note: "For Job #S-000001", office_note: "Gate code on file",
      bill_to: { name: "Sample Property Co", email: "billing@example.com", phone: "(763) 555-0199", address: "100 Example Ave, Delano MN 55328" },
      lines: [
        { description: "Exterior window cleaning", qty_milli: 1000, unit_cents: 44500 },
        { description: "Interior window cleaning", qty_milli: 2000, unit_cents: 14000 },
        { description: "Discount", unit_cents: -10000 },
      ],
      // a total in the request is ignored: the lines say what it is
      total_cents: 1,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const inv = r.body.data.invoice;
    assert.deepEqual([inv.number, inv.number_edited, inv.title, inv.due_on, inv.customer_note, inv.bill_to.name], ["BW-2026-17", true, "Fall windows", "2026-11-30", "For Job #S-000001", "Sample Property Co"]);
    assert.deepEqual([inv.subtotal_cents, inv.discount_cents, inv.total_cents, inv.balance_cents], [72500, 10000, 62500, 62500]);
    assert.deepEqual(inv.lines.map((l) => [l.kind, l.total_cents]), [["service", 44500], ["service", 28000], ["discount", -10000]]);
    assert.equal(new Set(inv.lines.map((l) => l.id)).size, 3, "each line has its own id");
    // the store's audit row for the edit
    const evts = t.stores.data.keys(`evt/invoice/${d.id}/`).map((k) => t.stores.data.json(k));
    assert.ok(evts.some((e) => e && e.action === "update" && e.by === admin.id), "the edit is in the invoice's history, by who");
    // Clear the due date (a draft's), take Bill To back to the contact as filed
    const r2 = await patch(t, admin, d.id, { due_on: null, bill_to: null, title: "" });
    assert.equal(r2.status, 200, JSON.stringify(r2.body));
    assert.deepEqual([r2.body.data.invoice.due_on, r2.body.data.invoice.bill_to, r2.body.data.invoice.title], [undefined, undefined, undefined]);
    // what isn't allowed
    for (const [body, field] of [
      [{ lines: [{ description: "", unit_cents: 100 }] }, "lines.0.description"], [{ lines: [{ description: "x" }] }, "lines.0.unit_cents"],
      [{ lines: [{ description: "x", unit_cents: 100, qty_milli: 0 }] }, "lines.0.qty_milli"], [{ lines: [{ description: "x", unit_cents: 100 }, { description: "Too much off", unit_cents: -500 }] }, "lines"],
      [{ number: "has space" }, "number"], [{ number: "<b>" }, "number"], [{ due_on: "11/30/2026" }, "due_on"], [{ bill_to: { email: "not an email" } }, "bill_to.email"],
      [{ salesperson_id: "us_00000000000000000000" }, "salesperson_id"], [{}, undefined],
      [{ lines: Array.from({ length: 41 }, (_, i) => ({ description: `Line ${i}`, unit_cents: 100 })) }, "lines"],
    ]) {
      const x = await patch(t, admin, d.id, body);
      assert.equal(x.status, 400, `${JSON.stringify(body).slice(0, 80)} → ${x.status}`);
      if (field) assert.equal(x.body.error.field, field, JSON.stringify(x.body));
    }
    // the salesperson: someone on the team
    assert.equal((await patch(t, admin, d.id, { salesperson_id: owner.id })).status, 200);
    assert.equal((await invoiceOf(d.id)).salesperson_id, owner.id);
  } finally { t.done(); }
});

test("the number: unique across every invoice, case and all; never one the CRM's own sequence will hand out; two edits at once get one 412", async () => {
  const { t, owner } = await setup();
  try {
    const c = await customer(owner);
    const a = await draft(t, owner, c);
    const b = await draft(t, owner, c);
    assert.equal((await patch(t, owner, a.id, { number: "BW-100" })).status, 200);
    const taken = await patch(t, owner, b.id, { number: "bw-100" });
    assert.equal(taken.status, 409);
    assert.equal(taken.body.error.details.reason, "number_taken");
    // the other invoice's sequence number (SINV-0001 is a's old number, still the sequence's)
    const seq = await patch(t, owner, b.id, { number: "SINV-0099" });
    assert.equal(seq.status, 409);
    assert.equal(seq.body.error.details.reason, "number_in_sequence");
    assert.equal((await patch(t, owner, b.id, { number: "SINV-0099A" })).status, 200);
    // its own number again is no change
    assert.equal((await patch(t, owner, b.id, { number: "SINV-0099A" })).status, 200);
    // a closed (paid) invoice's number counts too
    const paid = await openInvoice(t, owner, c, { cents: 1000 });
    await t.api(`/invoices/${paid.id}/payments`, { method: "POST", as: owner, body: { method: "cash", amount_cents: 1000, client_id: uuid(400) } });
    assert.equal((await patch(t, owner, a.id, { number: paid.number.toLowerCase() })).status, 409);
    // two people from one read: the second gets a 412, nothing lost
    const s = await read(t, owner, a.id);
    const one = await patch(t, owner, a.id, { title: "First" }, s.etag);
    const two = await patch(t, owner, a.id, { title: "Second" }, s.etag);
    assert.deepEqual([one.status, two.status], [200, 412]);
    assert.equal((await invoiceOf(a.id)).title, "First");
    // no If-Match: 400
    assert.equal((await t.api(`/invoices/${a.id}`, { method: "PATCH", as: owner, body: { title: "x" } })).status, 400);
  } finally { t.done(); }
});

test("sent but unpaid: editable and marked edited after it was sent; a payment, a running charge or an open pay page fixes its money; paid keeps its money; void and written off keep everything", async () => {
  const { t, owner, admin } = await setup();
  try {
    const c = await customer(owner);
    const inv = await openInvoice(t, owner, c, { cents: 20000 });
    await drain(t);
    const e = await patch(t, admin, inv.id, { lines: [{ description: "Exterior window cleaning", unit_cents: 20000 }, { description: "Gutters", unit_cents: 9000 }] });
    assert.equal(e.status, 200, JSON.stringify(e.body));
    assert.deepEqual([e.body.data.invoice.total_cents, e.body.data.invoice.balance_cents, !!e.body.data.invoice.edited_after_sent_at], [29000, 29000, true]);
    // a sent invoice keeps a due date, and something to pay
    assert.equal((await patch(t, admin, inv.id, { due_on: null })).status, 400);
    assert.equal((await patch(t, admin, inv.id, { lines: [{ description: "Free", unit_cents: 0 }] })).body.error.details.reason, "zero_total");
    // an open pay page (a Checkout Session that hasn't run out): its money waits
    await scope(() => store.updateRecord("invoice", inv.id, (x) => ({ ...x, checkout_sessions: [{ id: "cs_test_open", status: "open", expires_at: "2026-11-17T16:00:00.000Z", amount_cents: 29000 }] }), AS(owner)));
    const co = await patch(t, admin, inv.id, { lines: [{ description: "x", unit_cents: 100 }] });
    assert.deepEqual([co.status, co.body.error.details.reason], [409, "checkout_open"]);
    assert.equal((await patch(t, admin, inv.id, { customer_note: "Thanks!" })).status, 200, "a note can still change");
    await scope(() => store.updateRecord("invoice", inv.id, (x) => ({ ...x, checkout_sessions: [], charging: { by: "x", until: "2026-11-17T15:10:00.000Z", attempt_id: "att_x", n: 1 } }), AS(owner)));
    assert.equal((await patch(t, admin, inv.id, { number: "BW-1" })).body.error.details.reason, "charging");
    await scope(() => store.updateRecord("invoice", inv.id, (x) => { const y = { ...x }; delete y.charging; return y; }, AS(owner)));
    // part paid: money fixed
    await t.api(`/invoices/${inv.id}/payments`, { method: "POST", as: admin, body: { method: "check", amount_cents: 5000, client_id: uuid(500) } });
    const pp = await patch(t, admin, inv.id, { bill_to: { name: "Someone else" } });
    assert.deepEqual([pp.status, pp.body.error.details.reason], [409, "has_payments"]);
    // paid: the title and notes only
    await t.api(`/invoices/${inv.id}/payments`, { method: "POST", as: admin, body: { method: "cash", amount_cents: 24000, client_id: uuid(501) } });
    const sp = await read(t, admin, inv.id);
    assert.deepEqual([sp.invoice.status, sp.edit.money, sp.edit.due, sp.edit.details, sp.edit.code], ["paid", false, false, true, "paid"]);
    assert.match(sp.edit.why, /paid/);
    assert.equal((await patch(t, admin, inv.id, { lines: [{ description: "x", unit_cents: 1 }] })).body.error.details.reason, "paid");
    assert.equal((await patch(t, admin, inv.id, { due_on: "2026-12-01" })).status, 409);
    assert.equal((await patch(t, admin, inv.id, { title: "Paid at the door" })).status, 200);
    assert.equal((await invoiceOf(inv.id)).total_cents, 29000);
    // void: nothing
    const v = await openInvoice(t, owner, c, { cents: 3000 });
    await t.api(`/invoices/${v.id}/void`, { method: "POST", as: owner, body: { reason: "Made twice" } });
    const vv = await patch(t, owner, v.id, { title: "x" });
    assert.deepEqual([vv.status, vv.body.error.details.reason], [409, "void"]);
    assert.equal((await read(t, owner, v.id)).edit.details, false);
    // written off: nothing
    const w = await openInvoice(t, owner, c, { cents: 3000 });
    await t.api(`/invoices/${w.id}/write-off`, { method: "POST", as: owner, body: {} });
    assert.equal((await patch(t, owner, w.id, { customer_note: "x" })).body.error.details.reason, "written_off");
  } finally { t.done(); }
});

test("who may edit: the office and owners; a technician never; Rotor's own invoices stay read-only until the switch (no change, no text)", async () => {
  const { t, owner, admin, tech } = await setup();
  try {
    const c = await customer(owner);
    const d = await draft(t, owner, c);
    const etag = (await read(t, owner, d.id)).etag;
    assert.ok([403, 404].includes((await t.api(`/invoices/${d.id}`, { method: "PATCH", as: tech, ifMatch: etag, body: { title: "x" } })).status));
    assert.ok([403, 404].includes((await t.api(`/invoices/${d.id}/mark-sent`, { method: "POST", as: tech, body: {} })).status));
    assert.equal((await patch(t, admin, d.id, { title: "By the office" })).status, 200);
    // Rotor's invoice (the import's), Rotor still in charge
    const rc = await importedCustomer();
    const ri = await scope(async () => (await store.createRecord("invoice", { number: "INV-0571", seq: "imported", n: 571, kind: "standard", contact_id: rc.id, status: "open", issued_on: "2026-10-01", due_on: "2026-10-01", lines: [{ id: "ln_1", kind: "service", description: "Windows", qty_milli: 1000, unit_cents: 18000, total_cents: 18000 }], import: { run_id: "ir_00000000000000000001", at: "2026-11-08T00:00:00.000Z", hash: "6".repeat(64) }, rotor: { status_raw: "sent", total_cents_raw: 18000 } }, IMPORT)).data);
    const s = await read(t, owner, ri.id);
    assert.deepEqual([s.rotor_owned, s.edit.details, s.edit.money, s.edit.code, s.can.mark_sent, s.can.edit], [true, false, false, "rotor_owns", false, false]);
    const before = await invoiceOf(ri.id);
    for (const body of [{ title: "x" }, { lines: [{ description: "x", unit_cents: 1 }] }, { number: "BW-9" }]) {
      const r = await patch(t, owner, ri.id, body, s.etag);
      assert.deepEqual([r.status, r.body.error.details.reason], [409, "rotor_owns"]);
    }
    assert.equal((await t.api(`/invoices/${ri.id}/mark-sent`, { method: "POST", as: owner, body: {} })).status, 409);
    assert.deepEqual(await invoiceOf(ri.id), before, "Rotor's invoice is exactly as the import left it");
    await drain(t);
    assert.equal(outbox(t).length, 0, "nothing was sent");
  } finally { t.done(); }
});

test("Mark as Sent: a draft is issued and recorded as sent with nothing texted or emailed; again is no change; a paid or void one is refused", async () => {
  const { t, owner } = await setup();
  try {
    const c = await customer(owner);
    const d = await draft(t, owner, c);
    const r = await t.api(`/invoices/${d.id}/mark-sent`, { method: "POST", as: owner, body: {} });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const inv = r.body.data.invoice;
    assert.deepEqual([inv.status, !!inv.sent_at, inv.marked_sent.by, inv.issued_on, r.body.data.can.mark_sent], ["open", true, owner.id, "2026-11-17", false]);
    await drain(t);
    assert.equal(texts(t).length, 0);
    assert.equal(outbox(t, "email").length, 0);
    const again = await t.api(`/invoices/${d.id}/mark-sent`, { method: "POST", as: owner, body: {} });
    assert.equal(again.status, 200);
    assert.equal(again.body.data.invoice.sent_at, inv.sent_at);
    await t.api(`/invoices/${d.id}/payments`, { method: "POST", as: owner, body: { method: "cash", amount_cents: inv.total_cents, client_id: uuid(600) } });
    assert.equal((await t.api(`/invoices/${d.id}/mark-sent`, { method: "POST", as: owner, body: {} })).status, 409);
  } finally { t.done(); }
});

test("Flyra's New Invoice: the property (the customer's own), the salesperson, a discount line and the note; a job's invoice starts with Rotor's 'For Job #' note", async () => {
  const { t, owner, admin, tech } = await setup();
  try {
    const c = await customer(owner);
    const other = await customer(owner);
    const prop = await scope(async () => (await store.createRecord("property", { contact_id: c.id, address: { street1: "100 Example Ave", city: "Delano", state: "MN", zip: "55328" } }, AS(owner))).data);
    const theirs = await scope(async () => (await store.createRecord("property", { contact_id: other.id, address: { street1: "200 Example Ave", city: "Delano", state: "MN", zip: "55328" } }, AS(owner))).data);
    const body = (extra) => ({ contact_id: c.id, lines: [{ description: "Exterior window cleaning", unit_cents: 29500 }, { description: "Plan discount", unit_cents: 5000, kind: "discount" }], customer_note: "See you in spring", client_id: uuid(700 + Math.floor(Math.random() * 1000)), ...extra });
    assert.equal((await t.api("/invoices", { method: "POST", as: admin, body: body({ property_id: theirs.id }) })).status, 400);
    assert.equal((await t.api("/invoices", { method: "POST", as: admin, body: body({ salesperson_id: "us_00000000000000000000" }) })).status, 400);
    const r = await t.api("/invoices", { method: "POST", as: admin, body: body({ property_id: prop.id, salesperson_id: owner.id }) });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const inv = r.body.data.invoice;
    assert.deepEqual([inv.property_id, inv.salesperson_id, inv.total_cents, inv.discount_cents, inv.customer_note, inv.status], [prop.id, owner.id, 24500, 5000, "See you in spring", "draft"]);
    const s = await read(t, admin, inv.id);
    assert.match(s.contact.address, /100 Example Ave/);
    // a finished job's invoice: "For Job #…", its technician for the tip
    const ji = await jobInvoice(t, owner, c, { techs: [tech] });
    assert.match(ji.invoice.customer_note || "", /^For Job #/);
    const js = await read(t, owner, ji.invoice.id);
    assert.equal(js.crew.length, 1);
    assert.equal(js.crew[0].id, tech.id);
    assert.ok(js.job_number);
  } finally { t.done(); }
});

test("a card charge with a tip for the crew: charged with the balance, recorded as the tip and split to the job's technician; capped at the balance; dry run", async () => {
  const { t, owner, tech } = await setup();
  try {
    const c = await customer(owner, { flags: { test: true } });
    await saveCard(c);
    const { job } = await bookedJob(owner, c, { techs: [tech] });
    const inv = await openInvoice(t, owner, c, { cents: 19500, job_ids: [job.id] });
    assert.equal((await t.api(`/invoices/${inv.id}/charge`, { method: "POST", as: owner, body: { tip_cents: -1 } })).status, 400);
    const r = await t.api(`/invoices/${inv.id}/charge`, { method: "POST", as: owner, body: { tip_cents: 2925 } });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    for (let i = 0; i < 4; i++) await t.runWorker({ lane: "fast" });
    const pay = recs(t, "payment").find((p) => p.invoice_id === inv.id);
    assert.ok(pay, "the payment landed");
    assert.deepEqual([pay.method, pay.amount_cents, pay.tip_cents, pay.total_cents, pay.simulated], ["card", 19500, 2925, 22425, true]);
    assert.deepEqual(pay.tip_split, [{ user_id: tech.id, cents: 2925 }]);
    const after = await invoiceOf(inv.id);
    assert.deepEqual([after.status, after.tips_cents, after.balance_cents], ["paid", 2925, 0]);
    // a tip bigger than the balance is capped at it
    const inv2 = await openInvoice(t, owner, c, { cents: 1000, job_ids: [job.id] });
    await t.api(`/invoices/${inv2.id}/charge`, { method: "POST", as: owner, body: { tip_cents: 50000 } });
    for (let i = 0; i < 4; i++) await t.runWorker({ lane: "fast" });
    assert.equal(recs(t, "payment").find((p) => p.invoice_id === inv2.id).tip_cents, 1000);
  } finally { t.done(); }
});
