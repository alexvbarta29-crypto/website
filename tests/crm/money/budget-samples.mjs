// Budget samples for the money routes (read by tests/crm/core/budget.test.mjs):
// "METHOD /path" → (fx) → the request. Each sample makes what it needs
// through the store first (synthetic people only). Realistic cases: a
// customer with several invoices and payments, a job with two techs, an
// account credit to take off.

const store = await import("../../../netlify/lib/crm-store.mjs");
const OFF = await import("../../../netlify/lib/crm/modules/work/office.mjs");
const INV = await import("../../../netlify/lib/crm/modules/money/invoices.mjs");
const U = await import("../../../netlify/lib/crm/modules/money/upsert.mjs");
const CARDS = await import("../../../netlify/lib/crm/modules/money/cards.mjs");
const AP = await import("../../../netlify/lib/crm/modules/money/autopay.mjs");
const W = (by = "system") => ({ by, origin: "api", actor_kind: "user", requestId: "budget" });
const scope = (fn) => store.withStoreScope({ requestId: "budget" }, fn);
const uuid = (n) => `00000000-0000-4000-8000-${String(700000 + n).padStart(12, "0")}`;

let n = 0;
const customer = (fields = {}) => scope(async () => {
  n += 1;
  return (await store.createRecord("contact", {
    first_name: "Budget", last_name: `Money${n}`, phones: [{ e164: `+1763555${String(900 + n).padStart(4, "0")}`, sms: true, primary: true }], emails: [{ address: `budget.money${n}@example.com` }],
    lifecycle: "customer", source: { source: "Website quote form" }, consent: { sms_service: { state: "granted" } }, billing_address: { street1: `${n} Example Ave`, city: "Delano", state: "MN", zip: "55328" }, ...fields,
  }, W())).data;
});
// An invoice (draft or issued) straight through the module, as the office's own.
const invoice = (fx, { contact, issue = true, cents = 29500, job_ids = [] } = {}) => scope(async () => {
  n += 1;
  const c = contact || await customer();
  const id = INV.clientInvoiceId(uuid(n));
  const inv = await INV.makeInvoice({ invoice: { id, kind: "standard", contact_id: c.id, job_ids, lines: [{ id: "m1", kind: "service", description: "Exterior window cleaning", qty_milli: 1000, unit_cents: cents, total_cents: cents }], origin: "staff" }, issue, silent: true, credit: false, links: { job_ids } }, W(fx.owner.id));
  const g = await store.getRecord("invoice", inv.id);
  return { ...g.data, etag: g.etag };
});
const payment = (fx, inv, { cents = 10000, tip = 0 } = {}) => scope(async () => {
  n += 1;
  return (await U.upsertPayment({ id: U.payId.client(uuid(n)), contact_id: inv.contact_id, invoice_id: inv.id, invoice_number: inv.number, kind: "payment", method: "cash", status: "succeeded", amount_cents: cents, tip_cents: tip }, W(fx.owner.id))).payment;
});
const card = (c) => scope(() => CARDS.recordSavedMethod(c.id, { id: "dry_pm_card_ok", kind: "card", brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 }, {}, W()));
// A booked visit of a job for these techs. → { job, visit }
const visit = (fx, c, techs) => scope(async () => {
  n += 1;
  const [id] = await OFF.createJobs([{ contact_id: c.id, kind: "standard", lines: [{ title: "Exterior window cleaning", qty_milli: 1000, unit_cents: 29500, service_type: "Residential Window Cleaning" }] }], `budget-money-${n}`, "manual", W(fx.owner.id));
  const r = await OFF.createVisit({ job_id: id, date: "2026-11-17", start: "08:00", end: "10:00", window: { type: "window", minutes: 120 }, assignee_ids: techs.map((u) => u.id) }, W(fx.owner.id));
  return { job: (await store.getRecord("job", id)).data, visit: r.visit };
});
// A customer with history: 6 invoices, 4 of them paid, a credit.
const busy = async (fx) => {
  const c = await customer();
  for (let i = 0; i < 6; i++) { const inv = await invoice(fx, { contact: c }); if (i < 4) await payment(fx, inv, { cents: 29500, tip: 1000 }); }
  return c;
};

export default {
  "GET /invoices": async (fx) => { await busy(fx); return { as: fx.owner, path: "/invoices" }; },
  "POST /invoices": async (fx) => {
    const c = await customer();
    await scope(() => store.createRecord("credit", { contact_id: c.id, kind: "goodwill", status: "available", amount_cents: 2500, note: "Sorry for the wait" }, W(fx.owner.id)));
    return { as: fx.owner, path: "/invoices", body: { contact_id: c.id, lines: [{ description: "Exterior window cleaning", unit_cents: 29500 }, { description: "Screens", unit_cents: 6000 }], issue: true, client_id: uuid(1) } };
  },
  "POST /jobs/:id/invoice": async (fx) => { const { job } = await visit(fx, await customer(), [fx.tech]); return { as: fx.owner, path: `/jobs/${job.id}/invoice`, body: {} }; },
  "GET /invoices/:id": async (fx) => { const inv = await invoice(fx); await payment(fx, inv); await payment(fx, inv, { cents: 5000 }); return { as: fx.owner, path: `/invoices/${inv.id}` }; },
  "PATCH /invoices/:id": async (fx) => { const inv = await invoice(fx, { issue: false }); return { as: fx.owner, path: `/invoices/${inv.id}`, ifMatch: inv.etag, body: { lines: [{ description: "Exterior window cleaning", unit_cents: 31000 }], due_on: "2026-11-30" } }; },
  "POST /invoices/:id/issue": async (fx) => ({ as: fx.owner, path: `/invoices/${(await invoice(fx, { issue: false })).id}/issue`, body: { channels: ["sms", "email"] } }),
  "POST /invoices/:id/send": async (fx) => ({ as: fx.owner, path: `/invoices/${(await invoice(fx)).id}/send`, body: { channels: ["sms", "email"] } }),
  "POST /invoices/:id/void": async (fx) => ({ as: fx.owner, path: `/invoices/${(await invoice(fx)).id}/void`, body: { reason: "Made by mistake" } }),
  "POST /invoices/:id/write-off": async (fx) => ({ as: fx.owner, path: `/invoices/${(await invoice(fx)).id}/write-off`, body: {} }),
  "POST /invoices/:id/charge": async (fx) => { const c = await customer({ flags: { test: true } }); await card(c); return { as: fx.owner, path: `/invoices/${(await invoice(fx, { contact: c })).id}/charge`, body: {} }; },
  "POST /invoices/:id/payments": async (fx) => { const c = await customer(); const { job } = await visit(fx, c, [fx.tech, fx.spare]); const inv = await invoice(fx, { contact: c, job_ids: [job.id] }); return { as: fx.owner, path: `/invoices/${inv.id}/payments`, body: { method: "check", amount_cents: 29500, tip_cents: 2000, reference: "1042", client_id: uuid(2) } }; },
  "GET /payments": async (fx) => { await busy(fx); return { as: fx.owner, path: "/payments?month=2026-11" }; },
  "GET /payments/:id": async (fx) => { const inv = await invoice(fx); const p = await payment(fx, inv); return { as: fx.owner, path: `/payments/${p.id}` }; },
  "POST /payments/:id/refund": async (fx) => { const c = await customer(); const { job } = await visit(fx, c, [fx.tech, fx.spare]); const inv = await invoice(fx, { contact: c, job_ids: [job.id] }); const p = await payment(fx, inv, { cents: 29500, tip: 2000 }); return { as: fx.owner, path: `/payments/${p.id}/refund`, body: { amount_cents: 30000, reason: "Streaks on two panes", client_id: uuid(3) } }; },
  "GET /contacts/:id/credits": async (fx) => { const c = await customer(); for (let i = 0; i < 5; i++) await scope(() => store.createRecord("credit", { contact_id: c.id, kind: "goodwill", status: "available", amount_cents: 500, note: "Thanks" }, W(fx.owner.id))); return { as: fx.owner, path: `/contacts/${c.id}/credits` }; },
  "POST /contacts/:id/credits": async (fx) => ({ as: fx.owner, path: `/contacts/${(await customer()).id}/credits`, body: { kind: "referral", amount_cents: 2500, note: "Referred a neighbor", client_id: uuid(4) } }),
  "POST /credits/:id/keep": async (fx) => {
    const inv = await invoice(fx);
    const cr = await scope(() => store.createRecord("credit", { contact_id: inv.contact_id, kind: "overpayment", status: "held", amount_cents: 2500, source_invoice_id: inv.id, note: "Overpaid" }, W(fx.owner.id)));
    return { as: fx.owner, path: `/credits/${cr.data.id}/keep`, body: {} };
  },
  "POST /contacts/:id/card-link": async (fx) => ({ as: fx.owner, path: `/contacts/${(await customer()).id}/card-link`, body: { client_id: uuid(5) } }),
  "GET /money/contacts/:id": async (fx) => ({ as: fx.owner, path: `/money/contacts/${(await busy(fx)).id}` }),
  "GET /money/summary": async (fx) => { await busy(fx); return { as: fx.owner, path: "/money/summary" }; },
  "GET /money/status": (fx) => ({ as: fx.owner, path: "/money/status" }),
  "POST /money/payments-mode": (fx) => ({ as: fx.owner, path: "/money/payments-mode", body: { mode: "dry_run" } }),
  "GET /autopay/preview": (fx) => ({ as: fx.owner, path: "/autopay/preview?month=2026-12" }),
  "GET /autopay/runs": (fx) => ({ as: fx.owner, path: "/autopay/runs" }),
  "GET /autopay/runs/:id": async (fx) => {
    const id = AP.runIdFor("2026-10");
    await scope(() => store.createRecord("autopay_run", { id, month: "2026-10", status: "planned", items: [] }, W())).catch(() => null);
    return { as: fx.owner, path: `/autopay/runs/${id}` };
  },
  "GET /visits/:id/payment": async (fx) => { const c = await customer(); const { visit: v, job } = await visit(fx, c, [fx.tech]); await invoice(fx, { contact: c, job_ids: [job.id] }); return { as: fx.tech, path: `/visits/${v.id}/payment` }; },
  // the worst case: the visit's invoice doesn't exist yet, so it is made and issued, then the payment recorded
  "POST /visits/:id/payments": async (fx) => { const { visit: v } = await visit(fx, await customer(), [fx.tech, fx.spare]); return { as: fx.tech, path: `/visits/${v.id}/payments`, body: { method: "cash", amount_cents: 29500, tip_cents: 2000, client_id: uuid(6) } }; },
  "POST /visits/:id/pay-link": async (fx) => { const { visit: v } = await visit(fx, await customer(), [fx.tech]); return { as: fx.tech, path: `/visits/${v.id}/pay-link`, body: {} }; },
  // scan to pay from the Invoice screen: a customer with history, an open invoice part paid
  "POST /invoices/:id/pay-qr": async (fx) => { const c = await busy(fx); const inv = await invoice(fx, { contact: c }); await payment(fx, inv, { cents: 5000 }); return { as: fx.owner, path: `/invoices/${inv.id}/pay-qr`, body: {} }; },
  // closed unless payments run in that mode (dry run here): the answer is 404 before anything is read
  "POST /hooks/stripe": () => ({ path: "/hooks/stripe", csrf: false, raw: "{}", headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=" + "0".repeat(64) } }),
  "POST /hooks/stripe-test": () => ({ path: "/hooks/stripe-test", csrf: false, raw: "{}", headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=" + "0".repeat(64) } }),
};
