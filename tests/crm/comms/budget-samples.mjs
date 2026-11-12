// Budget samples for the comms routes (read by tests/crm/core/budget.test.mjs):
// "METHOD /path" → (fx) → the request. Each sample makes what it needs
// through the store first (synthetic people, 555 numbers). The provider
// webhooks answer 403 here (no secrets in this fixture): their real paths
// run under the same strict budget in inbound/status/email tests.

const store = await import("../../../netlify/lib/crm-store.mjs");
const CV = await import("../../../netlify/lib/crm/modules/comms/conversations.mjs");
const W = { by: "system", origin: "api", actor_kind: "user", requestId: "budget" };
const IMPORT = { by: "import", origin: "import", actor_kind: "import", requestId: "budget" };
const scope = (fn) => store.withStoreScope({ requestId: "budget" }, fn);
const OFFICE = "+17635550100";

let n = 0;
const person = (extra = {}) => scope(async () => {
  n += 1;
  return (await store.createRecord("contact", {
    first_name: "Budget", last_name: `Thread${n}`, phones: [{ e164: `+1763555${String(700 + n).padStart(4, "0")}`, sms: true, primary: true }], emails: [{ address: `budget.thread${n}@example.com` }],
    lifecycle: "customer", source: { source: "Other" }, consent: { sms_service: { state: "granted" }, sms_marketing: { state: "granted" } }, ...extra,
  }, W)).data;
});
// A thread of `count` texts, the way the import leaves one (the last one inbound and unread).
const thread = async (count = 30) => {
  const c = await person();
  let last;
  for (let i = 0; i < count; i++) {
    const inbound = i % 2 === 1 || i === count - 1;
    last = await scope(() => CV.recordMessage({
      contact: c, channel: "sms", direction: inbound ? "in" : "out", from: inbound ? c.phones[0].e164 : OFFICE, to: inbound ? OFFICE : c.phones[0].e164,
      body_text: `Budget message ${i}: the side gate is open and the dog is inside.`, status: inbound ? "received" : "delivered", provider: "rotor_import", origin: { kind: "import" },
      sent_at: new Date(Date.parse("2026-11-10T15:00:00Z") + i * 60000).toISOString(),
    }, IMPORT));
  }
  return { c, conv: last.conversation, message: last.message };
};
const campaign = (extra = {}) => scope(async () => store.createRecord("campaign", { name: "Budget campaign", description: "", channel: "sms", template_key: "budget_note", audience: { lifecycle: ["customer"] }, status: "draft", test: {}, stats: {}, ...extra }, W));
let rv = 0;
const review = async () => {
  const c = await person();
  rv += 1;
  const r = await scope(() => store.createRecord("review", { gbp_review_id: `budget-review-${rv}`, reviewer_name: "Budget T.", rating: 5, comment_excerpt: "Spotless.", created_at_gbp: "2026-11-16T15:00:00Z", suggestions: [{ contact_id: c.id, score: 1, name: "Budget Thread", on: "2026-11-10" }] }, W));
  return { c, r: r.data };
};
const form = (o) => new TextEncoder().encode(new URLSearchParams(o).toString());

export default {
  "GET /inbox": async (fx) => { for (let i = 0; i < 6; i++) await thread(4); return { as: fx.owner, path: "/inbox?filter=needs_reply" }; },
  "GET /inbox/contact/:id": async (fx) => { const t = await thread(); return { as: fx.owner, path: `/inbox/contact/${t.c.id}` }; },
  "GET /conversations/:id": async (fx) => { const t = await thread(60); return { as: fx.owner, path: `/conversations/${t.conv.id}` }; },
  "POST /conversations/:id/read": async (fx) => { const t = await thread(6); return { as: fx.owner, path: `/conversations/${t.conv.id}/read`, body: {} }; },
  "POST /conversations/:id/done": async (fx) => { const t = await thread(6); return { as: fx.owner, path: `/conversations/${t.conv.id}/done`, body: { done: true } }; },
  "POST /conversations/:id/assign": async (fx) => { const t = await thread(6); return { as: fx.owner, path: `/conversations/${t.conv.id}/assign`, body: { user_id: fx.admin.id } }; },
  "GET /messages/:id": async (fx) => { const t = await thread(3); return { as: fx.owner, path: `/messages/${t.message.id}` }; },

  "GET /campaigns": async (fx) => { await campaign(); return { as: fx.owner, path: "/campaigns" }; },
  "POST /campaigns": (fx) => ({ as: fx.owner, path: "/campaigns", body: { name: "Budget fall campaign", channel: "sms" } }),
  "GET /campaigns/:id": async (fx) => ({ as: fx.owner, path: `/campaigns/${(await campaign()).data.id}` }),
  "PATCH /campaigns/:id": async (fx) => { const c = await campaign(); return { as: fx.owner, path: `/campaigns/${c.data.id}`, ifMatch: c.etag, body: { audience: { lifecycle: ["customer", "lead"], tags_any: ["VIP"] } } }; },
  "POST /campaigns/:id/preview": async (fx) => { for (let i = 0; i < 12; i++) await person(); return { as: fx.owner, path: `/campaigns/${(await campaign()).data.id}/preview`, body: {} }; },
  "POST /campaigns/:id/test": async (fx) => ({ as: fx.owner, path: `/campaigns/${(await campaign()).data.id}/test`, body: {} }),
  "POST /campaigns/:id/schedule": async (fx) => ({ as: fx.owner, path: `/campaigns/${(await campaign()).data.id}/schedule`, body: { send_at: null } }),
  "POST /campaigns/:id/cancel": async (fx) => ({ as: fx.owner, path: `/campaigns/${(await campaign()).data.id}/cancel`, body: {} }),
  "GET /campaigns/:id/recipients": async (fx) => ({ as: fx.owner, path: `/campaigns/${(await campaign({ bulk_run_id: fx.bulkTested.id, status: "tested" })).data.id}/recipients` }),

  "GET /reviews": async (fx) => { await review(); return { as: fx.owner, path: "/reviews" }; },
  "GET /reviews/:id": async (fx) => ({ as: fx.owner, path: `/reviews/${(await review()).r.id}` }),
  "POST /reviews/:id/match": async (fx) => { const x = await review(); return { as: fx.owner, path: `/reviews/${x.r.id}/match`, body: { contact_id: x.c.id } }; },
  "GET /comms/setup": (fx) => ({ as: fx.owner, path: "/comms/setup" }),

  "POST /hooks/twilio/sms": () => ({ path: "/hooks/twilio/sms", csrf: false, raw: form({ MessageSid: "SM" + "0".repeat(32), From: "+17635550701", To: OFFICE, Body: "Hello" }), headers: { "content-type": "application/x-www-form-urlencoded" } }),
  "POST /hooks/twilio/status": () => ({ path: "/hooks/twilio/status", csrf: false, raw: form({ MessageSid: "SM" + "1".repeat(32), MessageStatus: "delivered" }), headers: { "content-type": "application/x-www-form-urlencoded" } }),
  "POST /hooks/email/postmark": () => ({ path: "/hooks/email/postmark", csrf: false, body: { RecordType: "Delivery", MessageID: "budget-1" } }),
};
