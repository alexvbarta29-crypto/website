// Money's data for the phone checks (tests/e2e/money.spec.mjs): synthetic
// people only (made-up names, 555 numbers, example.com emails). Made through
// the module itself, in the same process as the e2e server, on top of the
// shared seed: an open invoice, one past due, a draft, one paid by card with
// a tip (practice money) and part refunded, a test contact with a card on
// file and a visit today for Theo, and one of Rotor's own invoices.

const store = await import("../../netlify/lib/crm-store.mjs");
const clock = await import("../../netlify/lib/crm/core/clock.mjs");
const WORK = await import("../../netlify/lib/crm/modules/work/office.mjs");
const INV = await import("../../netlify/lib/crm/modules/money/invoices.mjs");
const U = await import("../../netlify/lib/crm/modules/money/upsert.mjs");
const CARDS = await import("../../netlify/lib/crm/modules/money/cards.mjs");
const RF = await import("../../netlify/lib/crm/modules/money/refunds.mjs");
const AUTO = await import("../../netlify/lib/crm/modules/money/automations.mjs");
const PORTAL = await import("../../netlify/lib/crm/portal/core.mjs");
const AP = await import("../../netlify/lib/crm/modules/money/autopay.mjs");

const uuid = (n) => `00000000-0000-4000-8000-${String(880000 + n).padStart(12, "0")}`;
let made = null;

export function seedMoney(seeded) {
  if (made) return made;
  made = store.withStoreScope({ requestId: "e2e-money" }, async () => {
    const O = { by: seeded.users.owner.id, origin: "api", actor_kind: "user", requestId: "e2e-money" };
    const IMPORT = { by: "import", origin: "import", actor_kind: "import", requestId: "e2e-money" };
    const day = clock.localDate(clock.now());
    let n = 0;
    const person = async (first, fields = {}, ctx = O) => {
      n += 1;
      return (await store.createRecord("contact", {
        first_name: first, last_name: "Moneyfolk", phones: [{ e164: "+1763555" + String(1700 + n).padStart(4, "0"), sms: true, primary: true }], emails: [{ address: `${first.toLowerCase()}.moneyfolk@example.com`, primary: true }],
        lifecycle: "customer", source: { source: "Referral" }, consent: { sms_service: { state: "granted", source: "website_form" } },
        billing_address: { street1: `${700 + n} Example Ave`, city: "Delano", state: "MN", zip: "55328" }, ...fields,
      }, ctx)).data;
    };
    const invoice = async (c, { cents = 29500, issue = true, job_ids = [], what = "Exterior window cleaning" } = {}) => {
      n += 1;
      const inv = await INV.makeInvoice({ invoice: { id: INV.clientInvoiceId(uuid(n)), kind: "standard", contact_id: c.id, job_ids, lines: [{ id: "m1", kind: "service", description: what, qty_milli: 1000, unit_cents: cents, total_cents: cents }], origin: "staff" }, issue, silent: true, credit: false, links: { job_ids } }, O);
      return (await store.getRecord("invoice", inv.id)).data;
    };
    const out = { contacts: {}, invoices: {}, payments: {}, visits: {}, portal: {} };

    // the plans that wait for a signature in the shared seed are on autopay: with Money here a plan also waits
    // for a card, so their customers have one on file (the plans checks are about the signature)
    for (const pid of [seeded.plans && seeded.plans.pending, seeded.plans && seeded.plans.present].filter(Boolean)) {
      const pg = await store.getRecord("plan", pid);
      if (pg) await CARDS.recordSavedMethod(pg.data.contact_id, { id: "dry_pm_card_ok", kind: "card", brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 }, {}, O);
    }
    // this month's autopay run (the worker makes it on its first pass; here so its screen has an id)
    const month = day.slice(0, 7);
    out.autopay = AP.runIdFor(month);
    if (!(await store.getRecord("autopay_run", out.autopay))) await store.createRecord("autopay_run", { id: out.autopay, month, status: "planned", items: [] }, { by: "system:e2e", origin: "worker", actor_kind: "automation", requestId: "e2e-money", mode: { system_of_record: "rotor", paused: false } }).catch(() => null);

    const marlow = await person("Marlow");
    out.contacts.open = marlow.id;
    out.invoices.open = (await invoice(marlow)).id;

    const indigo = await person("Indigo");
    const late = await invoice(indigo, { cents: 18500, what: "Gutter cleaning" });
    await store.updateRecord("invoice", late.id, (x) => ({ ...x, issued_on: clock.addLocalDays(day, -12), due_on: clock.addLocalDays(day, -12) }), O);
    out.invoices.overdue = late.id;

    const onyx = await person("Onyx");
    out.invoices.draft = (await invoice(onyx, { issue: false, cents: 9000, what: "Screen repair" })).id;

    // paid by card on the practice Checkout with a tip, then $25 handed back
    const sage = await person("Sage", { flags: { test: true } });
    const paid = await invoice(sage, { cents: 34500 });
    const card = await U.upsertPayment({
      id: U.payId.pi("dry_pi_e2e0000000000001"), contact_id: sage.id, contact_name: "Sage Moneyfolk", invoice_id: paid.id, invoice_number: paid.number, kind: "payment", method: "card", status: "succeeded",
      amount_cents: 34500, tip_cents: 5175, fee_cents: 0, tip_split: [{ user_id: seeded.users.tech.id, cents: 5175 }], stripe: { payment_intent_id: "dry_pi_e2e0000000000001", payment_method_id: "dry_pm_card_e2e" }, card: { brand: "visa", last4: "4242", kind: "card" }, simulated: true, recorded_by: "stripe",
    }, O);
    out.invoices.paid = paid.id;
    out.payments.card = card.payment.id;
    await RF.refundPayment(card.payment.id, { amount_cents: 2500, reason: "A screen was missed", client_id: uuid(900) }, O);

    // the test contact: a card on file, an invoice to charge, a link to pay it, and a visit today for Theo
    const terry = await person("Terry", { flags: { test: true } });
    out.contacts.test = terry.id;
    await CARDS.recordSavedMethod(terry.id, { id: "dry_pm_card_ok", kind: "card", brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 }, {}, O);
    out.invoices.test = (await invoice(terry, { cents: 24500 })).id;
    // one invoice to pay from its link per phone size (each run pays its own)
    out.portal.invoices = {};
    for (const device of ["iphone13", "iphonese"]) {
      const pay = await invoice(terry, { cents: 31000, what: "Interior and exterior windows" });
      out.portal.invoices[device] = `/p/${(await AUTO.invoiceLink(pay, seeded.users.owner.id)).code}`;
    }
    out.portal.card = `/p/${(await PORTAL.createPortalLink({ contact_id: terry.id, scope: { kind: "card" }, created_by: seeded.users.owner.id })).code}`;
    const pr = (await store.createRecord("property", { contact_id: terry.id, label: "Home", address: { street1: "707 Example Ave", city: "Delano", state: "MN", zip: "55328", country: "US" }, access: {} }, O)).data;
    await store.updateRecord("contact", terry.id, (x) => ({ ...x, primary_property_id: pr.id }), O);
    // a visit for Theo to collect on, per phone size (and one for the screens' walk)
    out.visits.collects = {};
    for (const [k, device] of ["iphone13", "iphonese", "walk"].entries()) {
      const [jobId] = await WORK.createJobs([{ contact_id: terry.id, kind: "standard", lines: [{ title: "Exterior window cleaning", unit_cents: 27500, service_type: "Residential Window Cleaning" }] }], `e2e-money-job-${k}`, "manual", O);
      // the week after next: clear of the days the schedule, route and rain-day checks count visits on
      const v = await WORK.createVisit({ job_id: jobId, date: clock.addLocalDays(day, 9 + k), start: "15:00", end: "17:00", window: { type: "window", minutes: 120 }, assignee_ids: [seeded.users.tech.id] }, O);
      out.visits.collects[device] = v.visit.id;
    }
    out.visits.collect = out.visits.collects.walk;

    // one of Rotor's own invoices (the import's write): shown, never chased or charged by the CRM
    const robin = await person("Robin", { import: { run_id: "ir_00000000000000000001", at: "2026-11-08T00:00:00.000Z", hash: "0".repeat(64) } }, IMPORT);
    out.contacts.rotor = robin.id;
    out.invoices.rotor = (await store.createRecord("invoice", {
      number: "INV-0598", seq: "imported", n: 598, kind: "standard", contact_id: robin.id, contact_name: "Robin Moneyfolk", status: "open", issued_on: clock.addLocalDays(day, -3), due_on: clock.addLocalDays(day, -3),
      lines: [{ id: "ln_1", kind: "service", description: "Exterior window cleaning", qty_milli: 1000, unit_cents: 21500, total_cents: 21500 }],
      import: { run_id: "ir_00000000000000000001", at: "2026-11-08T00:00:00.000Z", hash: "7".repeat(64) }, rotor: { status_raw: "sent", total_cents_raw: 21500 },
    }, IMPORT)).data.id;
    return out;
  });
  return made;
}
