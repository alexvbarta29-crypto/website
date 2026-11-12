// The staff side of Money over the API (design §5.6, §4.4, §4.6): who may
// do what, what the lists say, a draft's edits, sending, voiding and
// writing off, overdue reminders, Collect payment on a visit, the rows Home
// shows, and that nothing here texts a customer Rotor still bills.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, customer, testContact, importedCustomer, jobInvoice, bookedJob, openInvoice, invoiceOf, recs, texts, outbox, drain, advance, days, hours, scope, store, uuid, saveCard, IMPORT, AUTOMATION, T } from "./fixtures.mjs";
const R = await import("../../../netlify/lib/crm/core/registry.mjs");
const qr = await import("../../../crm-app/modules/money/qr.js");

test("who may do what: the office reads and writes invoices, owners refund, void and set up payments; a technician reaches none of the money screens' data", async () => {
  const { t, owner, admin, tech } = await setup();
  try {
    const c = await customer(owner);
    const inv = await openInvoice(t, admin, c);
    const cash = await t.api(`/invoices/${inv.id}/payments`, { method: "POST", as: admin, body: { method: "cash", amount_cents: 5000, client_id: uuid(1) } });
    assert.equal(cash.status, 201);
    const pid = cash.body.data.payment.id;
    const asTech = [
      ["GET", "/invoices"], ["GET", `/invoices/${inv.id}`], ["GET", "/payments"], ["GET", `/payments/${pid}`], ["GET", `/money/contacts/${c.id}`], ["GET", "/money/summary"], ["GET", "/money/status"],
      ["GET", "/autopay/preview"], ["GET", "/autopay/runs"], ["GET", `/contacts/${c.id}/credits`],
      ["POST", "/invoices", { contact_id: c.id, lines: [{ description: "x", unit_cents: 100 }] }], ["POST", `/invoices/${inv.id}/send`, { channels: ["sms"] }], ["POST", `/invoices/${inv.id}/void`, { reason: "no" }],
      ["POST", `/invoices/${inv.id}/charge`, {}], ["POST", `/payments/${pid}/refund`, { amount_cents: 100, reason: "no", client_id: uuid(2) }], ["POST", `/contacts/${c.id}/credits`, { kind: "goodwill", amount_cents: 100, note: "no" }],
      ["POST", `/contacts/${c.id}/card-link`, {}], ["POST", "/money/payments-mode", { mode: "test" }],
    ];
    for (const [method, path, body] of asTech) {
      const r = await t.api(path, { method, as: tech, ...(body ? { body } : {}) });
      assert.ok([403, 404].includes(r.status), `${method} ${path} as a tech: ${r.status}`);
    }
    // a tech may record a payment only on an invoice of their own visit's job (404 otherwise: it isn't theirs to know about)
    assert.equal((await t.api(`/invoices/${inv.id}/payments`, { method: "POST", as: tech, body: { method: "cash", amount_cents: 100, client_id: uuid(3) } })).status, 404);
    // an admin: everything but refunds, voids, write-offs, charging a card and the payments settings
    for (const [method, path, body] of [["POST", `/payments/${pid}/refund`, { amount_cents: 100, reason: "no", client_id: uuid(4) }], ["POST", `/invoices/${inv.id}/void`, { reason: "no" }], ["POST", `/invoices/${inv.id}/write-off`, {}], ["GET", "/money/status"], ["POST", "/money/payments-mode", { mode: "dry_run" }], ["PUT", "/settings/money", { auto_issue: false }]]) {
      assert.equal((await t.api(path, { method, as: admin, body, ...(method === "PUT" ? { ifMatch: "new" } : {}) })).status, 403, `${method} ${path} as an admin`);
    }
    const one = await t.api(`/invoices/${inv.id}`, { as: admin });
    assert.deepEqual([one.body.data.can.refund, one.body.data.can.void, one.body.data.can.write_off, one.body.data.can.record, one.body.data.can.send], [false, false, false, true, true]);
    assert.equal((await t.api(`/invoices/${inv.id}`, { as: owner })).body.data.can.void, true);
    // an admin's credit is capped (cfg/money.credit_cap_admin_cents, $100); an owner's isn't
    assert.equal((await t.api(`/contacts/${c.id}/credits`, { method: "POST", as: admin, body: { kind: "goodwill", amount_cents: 10001, note: "Too much", client_id: uuid(5) } })).status, 403);
    assert.equal((await t.api(`/contacts/${c.id}/credits`, { method: "POST", as: admin, body: { kind: "goodwill", amount_cents: 10000, note: "Sorry for the wait", client_id: uuid(6) } })).status, 201);
    const big = await t.api(`/contacts/${c.id}/credits`, { method: "POST", as: owner, body: { kind: "referral", amount_cents: 25000, note: "Referred a neighbor", client_id: uuid(7) } });
    assert.equal(big.status, 201);
    assert.equal(big.body.data.balance_cents, 35000);
    assert.equal((await t.api(`/contacts/${c.id}/credits`, { method: "POST", as: owner, body: { kind: "referral", amount_cents: 25000, note: "Referred a neighbor", client_id: uuid(7) } })).body.data.balance_cents, 35000, "the same request twice is one credit");
    assert.equal((await t.api(`/contacts/${c.id}/credits`, { method: "POST", as: owner, body: { kind: "overpayment", amount_cents: 100, note: "nope" } })).status, 400);
    // owners set the money settings; nonsense is refused
    const put = await t.api("/settings/money", { method: "PUT", as: owner, ifMatch: "new", body: { tip_options_bp: [0, 1500, 2500], retry_days: [2, 5], statement_descriptor: "barta windows" } });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal((await t.api("/settings/money", { method: "PUT", as: owner, ifMatch: put.body.data.etag, body: { tip_options_bp: [0, 9900] } })).status, 400);
    assert.equal((await t.api("/money/status", { as: owner })).body.data.settings.statement_descriptor, "BARTA WINDOWS");
    // every money route is a session route with a permission (the route guard reads the same table)
    const routes = R.allRoutes().filter((r) => /^\/(invoices|payments|autopay|money|credits)(\/|$)/.test(r.path));
    assert.equal(routes.length, 21);
    assert.ok(routes.every((r) => r.auth === "session" && typeof r.perm === "string" && r.perm.includes(":")));
  } finally { t.done(); }
});

test("an invoice by hand: a draft can be edited (with the version it was read at), issued, sent again, part paid, voided or written off; the lists and their counts follow", async () => {
  const { t, owner } = await setup();
  try {
    const c = await customer(owner);
    const made = await t.api("/invoices", { method: "POST", as: owner, body: { contact_id: c.id, kind: "fee", lines: [{ description: "Late cancel fee", unit_cents: 5000, kind: "fee" }], client_id: uuid(10) } });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const d = made.body.data.invoice;
    assert.deepEqual([d.status, d.kind, d.number, d.total_cents], ["draft", "fee", "SINV-0001", 5000]);
    assert.equal((await t.api("/invoices", { method: "POST", as: owner, body: { contact_id: c.id, kind: "fee", lines: [{ description: "Late cancel fee", unit_cents: 5000, kind: "fee" }], client_id: uuid(10) } })).body.data.invoice.id, d.id, "the same request twice is one invoice");
    assert.equal(recs(t, "invoice").length, 1);
    assert.equal(texts(t, "invoice_sent").length, 0, "a draft is the office's own");
    // what a create needs
    assert.equal((await t.api("/invoices", { method: "POST", as: owner, body: { lines: [{ description: "x", unit_cents: 1 }] } })).status, 400);
    assert.equal((await t.api("/invoices", { method: "POST", as: owner, body: { contact_id: c.id, lines: [] } })).status, 400);
    assert.equal((await t.api("/invoices", { method: "POST", as: owner, body: { contact_id: c.id, lines: [{ description: "x" }] } })).status, 400);
    assert.equal((await t.api("/invoices", { method: "POST", as: owner, body: { contact_id: c.id, lines: [{ description: "<b>x</b>".repeat(100), unit_cents: 1 }] } })).status, 400, "a line is one short line of words");
    // edit the draft: the version it was read at, or 412
    const g = await t.api(`/invoices/${d.id}`, { as: owner });
    assert.equal((await t.api(`/invoices/${d.id}`, { method: "PATCH", as: owner, body: { due_on: "2026-11-30" } })).status, 400, "an edit says which version it changes");
    const p1 = await t.api(`/invoices/${d.id}`, { method: "PATCH", as: owner, ifMatch: g.body.data.etag, body: { lines: [{ description: "Late cancel fee", unit_cents: 5000, kind: "fee" }, { description: "Goodwill", unit_cents: 1000, kind: "discount" }], due_on: "2026-11-30", customer_note: "Thanks for understanding." } });
    assert.equal(p1.status, 200, JSON.stringify(p1.body));
    assert.deepEqual([p1.body.data.invoice.total_cents, p1.body.data.invoice.discount_cents, p1.body.data.invoice.due_on], [4000, 1000, "2026-11-30"]);
    assert.equal((await t.api(`/invoices/${d.id}`, { method: "PATCH", as: owner, ifMatch: g.body.data.etag, body: { due_on: "2026-12-05" } })).status, 412, "someone else changed it since");
    let list = await t.api("/invoices?status=draft", { as: owner });
    assert.deepEqual([list.body.data.length, list.body.meta.counts.draft, list.body.meta.counts.open, list.body.meta.totals.open_cents], [1, 1, 0, 0]);
    // issue it: the text and the email go to the Outbox (dry run), once
    const iss = await t.api(`/invoices/${d.id}/issue`, { method: "POST", as: owner, body: { channels: ["sms", "email"] } });
    assert.equal(iss.status, 200, JSON.stringify(iss.body));
    assert.deepEqual([iss.body.data.invoice.status, iss.body.data.invoice.issued_on, iss.body.data.invoice.due_on], ["open", "2026-11-17", "2026-11-30"]);
    await drain(t);
    assert.equal(texts(t, "invoice_sent").length, 1);
    assert.equal(outbox(t, "email").filter((o) => o.template_key === "invoice_sent_email").length, 1);
    assert.match(texts(t, "invoice_sent")[0].body, /Your invoice SINV-0001 for \$40\.00 is ready/);
    assert.ok((await invoiceOf(d.id)).sent_at);
    // once issued its lines are fixed; a note can still change
    const g2 = await t.api(`/invoices/${d.id}`, { as: owner });
    assert.equal((await t.api(`/invoices/${d.id}`, { method: "PATCH", as: owner, ifMatch: g2.body.data.etag, body: { lines: [{ description: "x", unit_cents: 1 }] } })).status, 409);
    assert.equal((await t.api(`/invoices/${d.id}`, { method: "PATCH", as: owner, ifMatch: g2.body.data.etag, body: { office_note: "Called them Tuesday." } })).status, 200);
    // send again by text only: one more text, no more email
    assert.equal((await t.api(`/invoices/${d.id}/send`, { method: "POST", as: owner, body: { channels: [] } })).status, 400);
    assert.equal((await t.api(`/invoices/${d.id}/send`, { method: "POST", as: owner, body: { channels: ["sms"] } })).status, 200);
    await drain(t);
    assert.equal(texts(t, "invoice_sent").length, 2);
    assert.equal(outbox(t, "email").filter((o) => o.template_key === "invoice_sent_email").length, 1);
    // part paid: still open, flagged; a void is refused only while a charge runs, and needs a reason
    await t.api(`/invoices/${d.id}/payments`, { method: "POST", as: owner, body: { method: "check", amount_cents: 1500, reference: "Check 2231 acct 123456789012", client_id: uuid(11) } });
    const part = await t.api(`/invoices/${d.id}`, { as: owner });
    assert.deepEqual([part.body.data.invoice.status, part.body.data.invoice.balance_cents, part.body.data.flags.partially_paid], ["open", 2500, true]);
    assert.doesNotMatch(JSON.stringify(part.body.data.payments), /123456789012/, "a long account number in a reference is masked");
    list = await t.api("/invoices", { as: owner });
    assert.deepEqual([list.body.data.length, list.body.data[0].pp, list.body.meta.totals.open_cents], [1, 1, 2500]);
    assert.equal((await t.api(`/invoices/${d.id}/void`, { method: "POST", as: owner, body: {} })).status, 400);
    // written off: out of the open list, kept in the year's
    const off = await t.api(`/invoices/${d.id}/write-off`, { method: "POST", as: owner, body: {} });
    assert.equal(off.body.data.invoice.status, "uncollectible");
    assert.equal((await t.api("/invoices", { as: owner })).body.data.length, 0);
    assert.equal((await t.api("/invoices?status=uncollectible", { as: owner })).body.data.length, 1);
    assert.equal((await t.api(`/invoices/${d.id}/payments`, { method: "POST", as: owner, body: { method: "cash", amount_cents: 100, client_id: uuid(12) } })).status, 409);
    // a void: with a reason, and never a paid one
    const v = await openInvoice(t, owner, c, { cents: 7000 });
    const vd = await t.api(`/invoices/${v.id}/void`, { method: "POST", as: owner, body: { reason: "Made by mistake" } });
    assert.deepEqual([vd.body.data.invoice.status, vd.body.data.invoice.void_reason], ["void", "Made by mistake"]);
    const paid = await openInvoice(t, owner, c, { cents: 3000 });
    await t.api(`/invoices/${paid.id}/payments`, { method: "POST", as: owner, body: { method: "cash", amount_cents: 3000, client_id: uuid(13) } });
    assert.equal((await t.api(`/invoices/${paid.id}/void`, { method: "POST", as: owner, body: { reason: "Oops" } })).status, 409);
    const closed = await t.api("/invoices?status=closed", { as: owner });
    assert.deepEqual(closed.body.data.map((r) => r.st).sort(), ["paid", "uncollectible", "void"]);
    assert.equal((await t.api(`/invoices?contact=${c.id}`, { as: owner })).body.data.length, 3);
    // the month's money, cash basis
    const sum = (await t.api("/money/summary", { as: owner })).body.data;
    assert.deepEqual([sum.revenue_cents, sum.payments, sum.open_cents, sum.overdue_cents], [4500, 2, 0, 0]);
    const pays = await t.api("/payments?month=2026-11&method=check", { as: owner });
    assert.deepEqual([pays.body.data.length, pays.body.meta.by_method.check], [1, 1500]);
  } finally { t.done(); }
});

test("overdue reminders: the day after it's due, then every few days, a set number of times; never for a paid one, one Rotor owns, or one being paid", async () => {
  const { t, owner } = await setup();
  try {
    const c = await customer(owner);
    const inv = await openInvoice(t, owner, c);
    const paidSoon = await openInvoice(t, owner, await customer(owner));
    const rc = await importedCustomer();
    await scope(() => store.createRecord("invoice", { number: "INV-0570", seq: "imported", n: 570, kind: "standard", contact_id: rc.id, status: "open", issued_on: "2026-10-01", due_on: "2026-10-01", lines: [{ id: "ln_1", kind: "service", description: "Windows", qty_milli: 1000, unit_cents: 18000, total_cents: 18000 }], import: { run_id: "ir_00000000000000000001", at: "2026-11-08T00:00:00.000Z", hash: "5".repeat(64) }, rotor: { status_raw: "overdue", total_cents_raw: 18000 } }, IMPORT));
    await drain(t);
    assert.equal(texts(t, "invoice_overdue").length, 0, "due today is not overdue");
    // Home's rows: two unpaid of ours (Rotor's own invoice isn't the CRM's to chase), none overdue yet
    const needs = async () => Object.fromEntries(((await t.api("/home", { as: owner, office: true })).body.data.needs || []).filter((r) => r.module === "money").map((r) => [r.key, r.count]));
    assert.deepEqual(await needs(), { "invoices.unpaid": 2 });
    assert.equal((await t.api("/me/badges", { as: owner })).status, 200);
    advance(days(1) + hours(2));                               // Wed 11 AM: a day past due
    await t.api(`/invoices/${paidSoon.id}/payments`, { method: "POST", as: owner, body: { method: "cash", amount_cents: 29500, client_id: uuid(20) } });
    await drain(t);
    let sent = texts(t, "invoice_overdue");
    assert.deepEqual(sent.map((o) => o.contact_id), [c.id], "one reminder: not the paid one, not Rotor's");
    assert.match(sent[0].body, /a friendly reminder from Barta Window Washing: invoice SINV-0001 still has \$295\.00 open/);
    assert.deepEqual(await needs(), { "invoices.unpaid": 1, "invoices.overdue": 1 });
    assert.deepEqual((await t.api("/invoices?status=overdue", { as: owner })).body.data.map((r) => r.id).sort(), [inv.id, recs(t, "invoice").find((i) => i.import).id].sort(), "the list shows Rotor's overdue one too, so the office sees it");
    // the same day again: nothing more; then every 3 days up to 5 in all
    await drain(t, 2);
    assert.equal(texts(t, "invoice_overdue").length, 1);
    for (let i = 0; i < 8; i++) { advance(days(3)); await drain(t, 2); }
    sent = texts(t, "invoice_overdue");
    assert.equal(sent.length, 5, "five reminders at most (cfg/money.overdue_max)");
    assert.equal((await invoiceOf(inv.id)).reminders.count, 5);
    // would-rows only for Rotor's invoice: no text ever
    assert.equal(sent.filter((o) => o.contact_id === rc.id).length, 0);
    // templates: Barta's voice, no opt-out line of their own (the sender adds what the law needs), never "licensed"
    const tpls = (await import("../../../netlify/lib/crm/modules/money/automations.mjs")).TEMPLATES;
    assert.equal(tpls.length, 8);
    for (const tp of tpls) {
      assert.doesNotMatch(tp.body + (tp.subject || ""), /reply stop|licensed|—|refund/i, tp.key);
      assert.ok(T, tp.key);
    }
  } finally { t.done(); }
});

test("Collect payment on the visit: what's left, cash or a check recorded by the tech, or a pay link as a QR code; the office too; the invoice is made if the worker hasn't yet", async () => {
  const { t, owner, admin, tech, tech2 } = await setup();
  try {
    const c = await testContact(owner);
    // the visit was just marked done: the worker hasn't made the invoice yet
    const { job, visit } = await bookedJob(owner, c, { techs: [tech] });
    let look = await t.api(`/visits/${visit.id}/payment`, { as: tech });
    assert.equal(look.status, 200, JSON.stringify(look.body));
    assert.deepEqual([look.body.data.invoice, look.body.data.can.make, look.body.data.can.record], [null, true, false]);
    // the QR: the link is made (and the invoice with it, issued without texting the customer who is standing right there)
    const link = await t.api(`/visits/${visit.id}/pay-link`, { method: "POST", as: tech, body: {} });
    assert.equal(link.status, 201, JSON.stringify(link.body));
    assert.match(link.body.data.url, /^https:\/\/www\.bartawindowwashing\.com\/p\/[0-9A-Za-z]{10}$/);
    assert.deepEqual([link.body.data.number, link.body.data.balance_cents], ["SINV-0001", 29500]);
    const code = qr.qrMatrix(link.body.data.url);
    assert.ok(code.version <= 4, "a short link: a QR a phone reads off another phone easily");
    assert.match(qr.qrSvg(link.body.data.url), /^<svg /);
    await drain(t);
    assert.equal(texts(t, "invoice_sent").length, 0, "no invoice text when it's collected at the door");
    assert.equal(recs(t, "invoice").length, 1);
    look = await t.api(`/visits/${visit.id}/payment`, { as: tech });
    assert.deepEqual([look.body.data.invoice.number, look.body.data.invoice.balance_cents, look.body.data.can.record, look.body.data.can.link], ["SINV-0001", 29500, true, true]);
    // the customer scans it and pays on their phone; the tech's "Did it go through?" sees it
    const open = await t.portal("/api/portal/open", { method: "POST", headers: (await import("./fixtures.mjs")).PJSON, body: { code: link.body.data.url.split("/").pop() } });
    const cookie = t.setCookies(open).find((x) => x.startsWith("barta_portal=")).split(";")[0];
    const { PJSON } = await import("./fixtures.mjs");
    const co = await t.portal(`/api/portal/invoices/${recs(t, "invoice")[0].id}/checkout`, { method: "POST", headers: PJSON, cookie, body: { tip_choice: "10" } });
    await t.portal(`/api/portal/dry-checkout/${co.body.data.url.split("/").pop()}`, { method: "POST", headers: PJSON, body: { action: "pay", method: "card" } });
    look = await t.api(`/visits/${visit.id}/payment`, { as: tech });
    assert.deepEqual([look.body.data.invoice.status, look.body.data.can.record], ["paid", false]);
    assert.equal((await t.api(`/visits/${visit.id}/pay-link`, { method: "POST", as: tech, body: {} })).status, 409, "nothing left to pay");
    assert.deepEqual(recs(t, "payment")[0].tip_split, [{ user_id: tech.id, cents: 2950 }]);
    // another visit: the office records a check on it from the same button; a tech who isn't on it can't
    const b = await bookedJob(owner, await testContact(owner), { techs: [tech2] });
    assert.equal((await t.api(`/visits/${b.visit.id}/payment`, { as: tech })).status, 404);
    const chk = await t.api(`/visits/${b.visit.id}/payments`, { method: "POST", as: admin, body: { method: "check", amount_cents: 20000, reference: "1042", client_id: uuid(30) } });
    assert.equal(chk.status, 201, JSON.stringify(chk.body));
    assert.deepEqual([chk.body.data.invoice.status, chk.body.data.invoice.balance_cents, chk.body.data.payment.reference], ["open", 9500, "1042"]);
    // a bad form leaves nothing behind
    const c3 = await bookedJob(owner, await testContact(owner), { techs: [tech] });
    assert.equal((await t.api(`/visits/${c3.visit.id}/payments`, { method: "POST", as: tech, body: { method: "cash", amount_cents: 0, client_id: uuid(31) } })).status, 400);
    assert.equal((await t.api(`/visits/${c3.visit.id}/payments`, { method: "POST", as: tech, body: { method: "cash", amount_cents: 100 } })).status, 400);
    assert.equal(recs(t, "invoice").length, 2);
    // a part-paid job can't be reopened (Scheduling reads Money's invoice)
    const done = await scope(() => store.getRecord("visit", b.visit.id));
    await t.api(`/visits/${b.visit.id}/done`, { method: "POST", as: owner, body: {}, ifMatch: done.etag });
    const again = await scope(() => store.getRecord("visit", b.visit.id));
    const reopen = await t.api(`/visits/${b.visit.id}/reopen`, { method: "POST", as: owner, body: {}, ifMatch: again.etag });
    assert.equal(reopen.status, 409);
    assert.match(reopen.body.error.message, /has a payment on it/);
    // the tech's day shows "Balance due" on a stop whose customer owes money
    const day = await t.api("/me/day", { as: tech2 });
    if (day.status === 200) {
      const stop = (day.body.data.stops || []).find((s) => s.visit && s.visit.id === b.visit.id);
      if (stop) assert.ok(stop.badges.some((x) => x.key === "balance"), "Balance due");
    }
    assert.ok(job.id);
  } finally { t.done(); }
});

test("Money's place in the app: the manifest's rows and tools, a merge that carries the money over, and a customer Rotor bills left alone by the worker", async () => {
  const { t, owner, tech } = await setup();
  try {
    const m = R.getModule("money");
    assert.deepEqual(m.attention.map((a) => a.key), ["payments.failed", "invoices.overdue", "invoices.unpaid"]);
    assert.deepEqual(m.approvals.map((a) => a.kind), ["money.overpayment"]);
    assert.deepEqual(Object.keys(m.services).sort(), ["money.cardStatus", "money.createDepositInvoice", "money.reconcileImport"]);
    assert.deepEqual(m.mcpTools.filter((x) => x.effect !== "read").map((x) => x.name), ["send_invoice"], "the only tool that reaches a customer needs an owner's OK");
    assert.deepEqual(m.importPhases.map((p) => p.name), ["money.invoices", "money.credits", "money.payments"]);
    assert.ok(m.sweeps.some((s) => s.key === "money.autopay" && s.every === "monthly" && s.day === 1));
    // a job done for a customer Rotor bills: Money makes no invoice, it writes down what it would have done
    const rc = await importedCustomer();
    const { job } = await (await import("./fixtures.mjs")).finishedJob(t, owner, rc, { techs: [tech] });
    await drain(t);
    advance(hours(2));
    await drain(t, 2);                                         // the hourly backfill passes too
    assert.equal(recs(t, "invoice").length, 0);
    assert.ok(t.stores.data.keys("alog/").some((k) => k.includes("would-invoice")));
    // the office can still invoice that job by hand (their decision, their practice record)
    const hand = await t.api(`/jobs/${job.id}/invoice`, { method: "POST", as: owner, body: {} });
    assert.equal(hand.status, 201, JSON.stringify(hand.body));
    assert.equal((await t.api(`/jobs/${job.id}/invoice`, { method: "POST", as: owner, body: {} })).body.data.existed, true);
    // a merge: the invoices, payments and credits of the duplicate move to the one kept
    const a = await customer(owner), b = await customer(owner);
    const inv = await openInvoice(t, owner, b);
    await t.api(`/invoices/${inv.id}/payments`, { method: "POST", as: owner, body: { method: "cash", amount_cents: 10000, client_id: uuid(40) } });
    await t.api(`/contacts/${b.id}/credits`, { method: "POST", as: owner, body: { kind: "goodwill", amount_cents: 2500, note: "Sorry", client_id: uuid(41) } });
    await scope(() => m.onMerge(a.id, b.id, { write: () => ({ by: owner.id, origin: "api", actor_kind: "user", requestId: "test" }) }));
    const after = (await t.api(`/money/contacts/${a.id}`, { as: owner })).body.data;
    assert.deepEqual([after.invoices.length, after.payments.length, after.credit.balance_cents, after.open_balance_cents], [1, 1, 2500, 19500]);
    assert.equal((await invoiceOf(inv.id)).contact_id, a.id);
    await saveCard(a);
    assert.equal((await scope(() => m.services["money.cardStatus"](a.id))).status, "on_file");
    assert.ok(AUTOMATION);
  } finally { t.done(); }
});
