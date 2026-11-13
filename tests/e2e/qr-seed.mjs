// Scan to pay and Signs & flyers data for the phone checks
// (tests/e2e/qr.spec.mjs): synthetic people only (made-up names, 555
// numbers, example.com emails). Made through the modules themselves, in the
// same process as the e2e server, on top of the shared seed (and its money
// seed): two sign codes with scans, a lead from one of them who booked and
// paid, and a visit for Theo at a customer Rotor still bills (no pay code
// there: the screen says why).

const store = await import("../../netlify/lib/crm-store.mjs");
const clock = await import("../../netlify/lib/crm/core/clock.mjs");
const { deployContext } = await import("../../netlify/lib/crm/core/context.mjs");
const SIGNS = await import("../../netlify/lib/crm/modules/sales/signs.mjs");
const WORK = await import("../../netlify/lib/crm/modules/work/office.mjs");
const U = await import("../../netlify/lib/crm/modules/money/upsert.mjs");

let made = null;
export function seedQr(srvUrl, seeded) {
  if (made) return made;
  const dev = deployContext(new Request(srvUrl + "/"), {});
  made = store.withStoreScope({ deploy: dev, requestId: "e2e-qr" }, async () => {
    const O = { by: seeded.users.owner.id, origin: "api", actor_kind: "user", requestId: "e2e-qr" };
    const IMPORT = { by: "import", origin: "import", actor_kind: "import", requestId: "e2e-qr" };
    const day = clock.localDate(clock.now());
    const out = { codes: {}, contacts: {}, visits: {} };
    const code = async (fields) => (await store.createRecord("qr_code", { slug: SIGNS.newSlug(), dest: { kind: "quote" }, ...fields }, O)).data;
    const maple = await code({ name: "Yard sign, Maple Grove", kind: "yard_sign", area: "Maple Grove", placed_on: clock.addLocalDays(day, -20) });
    const hanger = await code({ name: "Door hanger, Oct", kind: "door_hanger", placed_on: clock.addLocalDays(day, -35), dest: { kind: "page", path: "/services/gutter-cleaning.html" } });
    out.codes.maple = maple.id;
    out.codes.hanger = hanger.id;
    for (let i = 0; i < 9; i++) await SIGNS.countScan(maple.id, i % 3 ? "ios" : "android", new Date(Date.parse(clock.nowIso()) - (i * 2 + 1) * 86400000).toISOString());
    for (let i = 0; i < 4; i++) await SIGNS.countScan(hanger.id, "ios", new Date(Date.parse(clock.nowIso()) - (i * 3 + 2) * 86400000).toISOString());
    // a lead from the Maple Grove sign: booked a visit, paid for one (cash)
    const quinn = (await store.createRecord("contact", {
      first_name: "Quinn", last_name: "Signfolk", phones: [{ e164: "+17635551910", sms: true, primary: true }], emails: [{ address: "quinn.signfolk@example.com", primary: true }],
      lifecycle: "lead", source: { source: "Website quote form", campaign: SIGNS.leadLabel(maple), qr_code: maple.id, channel: "Yard Sign" },
      consent: { sms_service: { state: "granted", source: "website_form" } }, billing_address: { street1: "1910 Example Ave", city: "Maple Grove", state: "MN", zip: "55311" },
    }, O)).data;
    out.contacts.quinn = quinn.id;
    await SIGNS.qrLead({ code_id: maple.id, contact_id: quinn.id });
    const [jobId] = await WORK.createJobs([{ contact_id: quinn.id, kind: "standard", lines: [{ title: "Exterior window cleaning", unit_cents: 29500, service_type: "Residential Window Cleaning" }] }], "e2e-qr-quinn", "manual", O);
    await WORK.createVisit({ job_id: jobId, date: clock.addLocalDays(day, 12), start: "09:00", end: "11:00", window: { type: "window", minutes: 120 }, assignee_ids: [] }, O);
    await U.upsertPayment({ id: U.payId.client("00000000-0000-4000-8000-000000910001"), contact_id: quinn.id, kind: "payment", method: "cash", status: "succeeded", amount_cents: 18500, tip_cents: 0 }, O);
    // a customer Rotor still bills, with a visit for Theo (Collect payment says there's no pay code yet)
    const robin = (await store.createRecord("contact", {
      first_name: "Robin", last_name: "Rotorfolk", phones: [{ e164: "+17635551920", sms: true }], lifecycle: "customer", source: { source: "Returning Customer" },
      consent: { sms_service: { state: "granted", source: "import" } }, billing_address: { street1: "1920 Example Ave", city: "Delano", state: "MN", zip: "55328" },
      import: { run_id: "ir_00000000000000000001", at: "2026-11-08T00:00:00.000Z", hash: "1".repeat(64) },
    }, IMPORT)).data;
    const [rj] = await WORK.createJobs([{ contact_id: robin.id, kind: "standard", lines: [{ title: "Exterior window cleaning", unit_cents: 21500, service_type: "Residential Window Cleaning" }] }], "e2e-qr-robin", "manual", O);
    for (const [k, device] of ["iphone13", "iphonese", "desk1440"].entries()) {
      const v = await WORK.createVisit({ job_id: rj, date: clock.addLocalDays(day, 14 + k), start: "13:00", end: "14:00", window: { type: "window", minutes: 60 }, assignee_ids: [seeded.users.tech.id] }, O);
      out.visits[device] = v.visit.id;
    }
    return out;
  });
  return made;
}
