// Synthetic messages for the phone checks (M6, design §12.5): made-up
// people, 555 numbers. Called by seed.mjs:
//   - a customer's thread as the Rotor import leaves it (texts both ways,
//     a long email, a failed text), handled;
//   - a lead whose last text is unanswered (open, unread);
//   - a thread with the contact on Theo's first visit (a tech's inbox);
//   - a campaign from Rotor (history), a draft campaign, a Google review
//     with a suggested match; the test contact every bulk send goes to first.
const store = await import("../../netlify/lib/crm-store.mjs");
const CV = await import("../../netlify/lib/crm/modules/comms/conversations.mjs");
const clock = await import("../../netlify/lib/crm/core/clock.mjs");
const ids = await import("../../netlify/lib/crm/core/ids.mjs");

const IMPORT = { by: "import", origin: "import", actor_kind: "import", requestId: "e2e-seed" };
const ago = (min) => new Date(clock.nowMs() - min * 60000).toISOString();

export async function seedComms(out, O) {
  const contact = async (id) => (await store.getRecord("contact", id)).data;
  let n = 0;
  const say = (c, direction, body, min, o = {}) => CV.recordMessage({
    contact: c, channel: "sms", direction, from: direction === "in" ? c.phones[0].e164 : "+17633143400", to: direction === "in" ? "+17633143400" : c.phones[0].e164,
    body_text: body, status: direction === "in" ? "received" : "delivered", provider: "rotor_import", origin: { kind: "import" }, sent_at: ago(min), id: ids.idForRotor("message", `e2e-${++n}`), ...o,
  }, IMPORT);
  const customer = await contact(out.contacts.customer);
  await say(customer, "out", "Hi! Thanks for reaching out to Barta Window Washing. When would be a good time for a quick call?", 60 * 24 * 40, { origin: { kind: "automation", id: "lead.ack" } });
  await say(customer, "in", "Tomorrow afternoon works", 60 * 24 * 40 - 8);
  await say(customer, "out", "REMINDER: Hi, Barta Window Washing is scheduled to visit on Nov 3 arriving between 8:00 AM and 10:00 AM. Reply if you have any questions!", 60 * 24 * 16, { origin: { kind: "system" } });
  await say(customer, "out", "Running about 15 minutes behind, see you soon!", 60 * 24 * 14, { status: "failed", error_code: "30007" });
  await say(customer, "in", "No problem. The gate code is on file and the dog will be inside.", 60 * 24 * 14 - 3);
  const done = await say(customer, "out", "Thanks again for choosing Barta! All done for today.", 60 * 24 * 14 - 200);
  await CV.setDone(done.conversation.id, true, O);
  await CV.recordMessage({ contact: customer, channel: "email", direction: "out", from: "office@bartawindowwashing.com", to: customer.emails[0].address, subject: "Your quote from BARTA Window Washing",
    body_text: "Hi there,\n\nPlease find your quote from BARTA Window Washing at the link below.\n\n" + "Our crew uses pure water and soft brushes, so there are no streaks and nothing harsh near your plants. ".repeat(18), status: "delivered", provider: "rotor_import", origin: { kind: "import" }, sent_at: ago(60 * 24 * 20), id: ids.idForRotor("message", "e2e-email") }, IMPORT);
  const emailConv = await CV.findConversation(customer.id, "email");
  await CV.setDone(emailConv.id, true, O);

  const lead = await contact(out.contacts.lead);
  await say(lead, "out", "Hi! Thanks for reaching out to Barta Window Washing. When would be a good time for a quick call?", 60 * 30);
  const open = await say(lead, "in", "Can you come out Thursday? We have about 30 windows.", 45);

  const visit = (await store.getRecord("visit", out.visits.tech)).data;
  const onVisit = await contact(visit.contact_id);
  const techThread = await say(onVisit, "in", "The side gate is unlocked for you.", 20);

  const rotor = await store.createRecord("campaign", { name: "Review Request - Last 30 Days (Oct 24)", description: "Personal review ask to customers with jobs Sep 24 - Oct 23 and no Google review yet.", channel: "sms", audience: {}, status: "sent", test: {}, stats: {}, rotor: { campaign_id: 596, number: "+17633143400" }, created_at: ago(60 * 24 * 24), finished_at: ago(60 * 24 * 24) }, IMPORT);
  const draft = await store.createRecord("campaign", { name: "Fall window cleaning", description: "Customers near Delano.", channel: "sms", template_key: "review_personal", audience: { lifecycle: ["customer"] }, status: "draft", test: {}, stats: {} }, O);
  const review = await store.createRecord("review", { gbp_review_id: "e2e-review-1", reviewer_name: `${customer.first_name} ${String(customer.last_name || "").slice(0, 1)}.`, rating: 5, comment_excerpt: "Spotless windows, friendly crew.", created_at_gbp: ago(60 * 5), suggestions: [{ contact_id: customer.id, score: 1, name: `${customer.first_name} ${customer.last_name}`, on: ago(60 * 24 * 14).slice(0, 10) }] }, O);

  // the test contact (owner-only setting): every bulk send's test goes here first
  const tester = (await store.createRecord("contact", { first_name: "Test", last_name: "Phone", phones: [{ e164: "+17635550190", sms: true, primary: true }], emails: [], lifecycle: "customer", source: { source: "Other" }, tags: [], flags: { test: true }, consent: { sms_service: { state: "granted" }, sms_marketing: { state: "granted" } } }, O)).data;
  const cur = await store.getSettingWithEtag("messaging_test");
  await store.putSetting("messaging_test", { contact_id: tester.id }, { ...O, ifMatch: cur.etag || "new" });

  out.comms = { conversation: done.conversation.id, email: emailConv.id, open: open.conversation.id, tech: techThread.conversation.id, customer: customer.id, lead: lead.id, onVisit: onVisit.id, campaign: draft.data.id, rotorCampaign: rotor.data.id, review: review.data.id, tester: tester.id,
    names: { customer: `${customer.first_name} ${customer.last_name}`, lead: `${lead.first_name} ${lead.last_name}`, onVisit: `${onVisit.first_name} ${onVisit.last_name}` } };
  return out.comms;
}
