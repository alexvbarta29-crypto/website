// Budget samples for the plans routes (read by tests/crm/core/budget.test.mjs):
// "METHOD /path" → (fx) → the request. Each sample makes what it needs
// through the store first (synthetic people only).

const store = await import("../../../netlify/lib/crm-store.mjs");
const PL = await import("../../../netlify/lib/crm/modules/plans/plans.mjs");
const AG = await import("../../../netlify/lib/crm/modules/plans/agreements.mjs");
const CAT = await import("../../../netlify/lib/crm/modules/plans/catalog.mjs");
const W = { by: "system", origin: "api", actor_kind: "user", requestId: "budget" };
const AUTO = { by: "system:budget", origin: "worker", actor_kind: "automation", requestId: "budget", mode: { system_of_record: "rotor", paused: false } };
const scope = (fn) => store.withStoreScope({ requestId: "budget" }, fn);

let seeded = false;
const seeds = (fx) => scope(async () => {
  if (seeded) return;
  seeded = true;
  await AG.seedAgreementTemplates(AUTO);
  for (const k of ["biannual", "quarterly", "monthly", "lights"]) await AG.approveTemplate(AG.seedTemplateId(k), { write: () => ({ ...W, by: fx.owner.id }) });
});
let n = 0;
const contact = () => scope(async () => {
  n += 1;
  const c = (await store.createRecord("contact", {
    first_name: "Budget", last_name: `Plan${n}`, phones: [{ e164: `+1763555${String(800 + n).padStart(4, "0")}`, sms: true, primary: true }], emails: [{ address: `budget.plan${n}@example.com` }],
    lifecycle: "customer", source: { source: "Website quote form" }, consent: { sms_service: { state: "granted" } },
  }, W)).data;
  const p = (await store.createRecord("property", { contact_id: c.id, label: "Home", address: { street1: `${300 + n} Example Ave`, city: "Delano", state: "MN", zip: "55328", country: "US" }, access: {}, assets: {}, photo_ids: [] }, W)).data;
  await store.updateRecord("contact", c.id, (x) => ({ ...x, primary_property_id: p.id }), W);
  return { ...c, primary_property_id: p.id };
});
const LINES = [{ id: "ln_e", title: "Exterior Window Cleaning", qty_milli: 1000, unit_cents: 29500, total_cents: 29500, scope: { type: "specific", visits: [1, 3, 4] } }, { id: "ln_i", title: "Interior Window Cleaning", qty_milli: 1000, unit_cents: 16000, total_cents: 16000, scope: { type: "specific", visits: [2] } }];
// A plan with a job per visit. status: pending | active.
const plan = async (fx, { status = "active", catalog_key = "quarterly", lines = LINES } = {}) => {
  await seeds(fx);
  const c = await contact();
  return scope(async () => {
    const p = PL.buildPlan({ contact_id: c.id, contact_name: "Budget Plan", property_id: c.primary_property_id, catalog_key, lines, discounts: [{ id: "dc", name: "Plan discount", type: "fixed", value: 10000, scope: { type: "all" } }], origin: "staff" }, CAT.catalogWith({}), { start_on: "2026-11-17" });
    delete p.id;
    const r = await store.createRecord("plan", { ...p, status, pending_reasons: status === "pending" ? ["signature"] : [], agreement_status: status === "active" ? "signed" : "none" }, { ...W, by: fx.owner.id });
    await PL.ensureJobs(r.data.id, { ...W, by: fx.owner.id });
    const g = await store.getRecord("plan", r.data.id);
    return { ...g.data, etag: g.etag };
  });
};
const agreement = async (fx, { send = false } = {}) => {
  const p = await plan(fx, { status: "pending" });
  return scope(async () => {
    const a = await AG.agreementForPlan(p.id, {}, { write: () => ({ ...W, by: fx.owner.id }) });
    if (send) await AG.sendAgreement(a.data.id, { channels: ["sms"] }, { write: () => ({ ...W, by: fx.owner.id }) });
    return (await store.getRecord("agreement", a.data.id)).data;
  });
};
const season = async (fx) => {
  const p = await plan(fx, { catalog_key: "lights_annual", lines: [{ id: "ln_l", title: "Christmas Lights", qty_milli: 1000, unit_cents: 90000, total_cents: 90000, scope: { type: "all" } }] });
  return scope(async () => (await store.getRecord("season_install", p.season_install_ids[0])).data);
};

export default {
  "GET /plans": async (fx) => { await plan(fx); await plan(fx, { status: "pending" }); return { as: fx.owner, path: "/plans" }; },
  "POST /plans": async (fx) => ({ as: fx.owner, path: "/plans", body: { contact_id: (await contact()).id, catalog_key: "quarterly", lines: LINES.map(({ total_cents, ...l }) => l), discounts: [{ name: "Plan discount", type: "fixed", value: 10000 }] } }),
  "GET /plans/due": async (fx) => { for (let i = 0; i < 3; i++) await plan(fx); return { as: fx.owner, path: "/plans/due" }; },
  "POST /plans/request-signatures": async (fx) => ({ as: fx.owner, path: "/plans/request-signatures", body: { plan_ids: [(await plan(fx)).id, (await plan(fx)).id] } }),
  "GET /plans/:id": async (fx) => ({ as: fx.owner, path: `/plans/${(await plan(fx)).id}` }),
  "PATCH /plans/:id": async (fx) => { const p = await plan(fx); return { as: fx.owner, path: `/plans/${p.id}`, ifMatch: p.etag, body: { name: "Quarterly care", auto_renew: false } }; },
  "POST /plans/:id/activate": async (fx) => ({ as: fx.owner, path: `/plans/${(await plan(fx, { status: "pending" })).id}/activate`, body: { override_reason: "Paper copy" } }),
  "POST /plans/:id/pause": async (fx) => ({ as: fx.owner, path: `/plans/${(await plan(fx)).id}/pause`, body: { from: "2026-11-17", until: "2027-02-01", reason: "Away" } }),
  "POST /plans/:id/resume": async (fx) => { const p = await plan(fx); await scope(() => store.updateRecord("plan", p.id, (x) => ({ ...x, status: "paused", pause: { from: "2026-11-17", reason: "", by: fx.owner.id } }), W)); return { as: fx.owner, path: `/plans/${p.id}/resume`, body: {} }; },
  "POST /plans/:id/skip": async (fx) => ({ as: fx.owner, path: `/plans/${(await plan(fx)).id}/skip`, body: { term: 1, n: 2 } }),
  "POST /plans/:id/renew": async (fx) => { const p = await plan(fx); await scope(() => store.updateRecord("plan", p.id, (x) => ({ ...x, status: "expired" }), W)); return { as: fx.owner, path: `/plans/${p.id}/renew`, body: {} }; },
  "POST /plans/:id/cancel": async (fx) => ({ as: fx.owner, path: `/plans/${(await plan(fx)).id}/cancel`, body: { reason: "price" } }),
  "POST /plans/:id/withdraw": async (fx) => { const p = await plan(fx); await scope(() => store.updateRecord("plan", p.id, (x) => ({ ...x, status: "cancelling", cancel: { requested_on: "2026-11-17", effective_on: "2026-11-24", reason: "price", clawback_cents: 0, by: fx.owner.id } }), W)); return { as: fx.owner, path: `/plans/${p.id}/withdraw`, body: {} }; },
  "POST /plans/:id/change-price": async (fx) => ({ as: fx.owner, path: `/plans/${(await plan(fx)).id}/change-price`, body: { effective_on: "2027-11-17", new_lines: [{ title: "Exterior Window Cleaning", unit_cents: 31500 }] } }),
  "GET /plans/:id/cancel-quote": async (fx) => ({ as: fx.owner, path: `/plans/${(await plan(fx)).id}/cancel-quote` }),
  "POST /plans/:id/send-agreement": async (fx) => ({ as: fx.owner, path: `/plans/${(await plan(fx, { status: "pending" })).id}/send-agreement`, body: { channels: ["sms", "email"] } }),
  "GET /agreement-templates": async (fx) => { await seeds(fx); return { as: fx.owner, path: "/agreement-templates" }; },
  "POST /agreement-templates": (fx) => ({ as: fx.owner, path: "/agreement-templates", body: { key: "budget_terms", name: "Budget terms", body_md: "## {{plan_name}}\n\nThanks {{full_name}}!" } }),
  "POST /agreement-templates/preview": async (fx) => { await seeds(fx); return { as: fx.owner, path: "/agreement-templates/preview", body: { catalog_key: "quarterly", body_md: "## {{plan_name}}\n\n{{per_visit_price}}" } }; },
  "GET /agreement-templates/:id": async (fx) => { await seeds(fx); return { as: fx.owner, path: `/agreement-templates/${AG.seedTemplateId("quarterly")}` }; },
  "PATCH /agreement-templates/:id": async (fx) => { await seeds(fx); const g = await scope(() => store.getRecord("agreement_template", AG.seedTemplateId("monthly"))); return { as: fx.owner, path: `/agreement-templates/${g.data.id}`, ifMatch: g.etag, body: { name: "Monthly plan agreement (2027)" } }; },
  "POST /agreement-templates/:id/approve": async (fx) => { await seeds(fx); return { as: fx.owner, path: `/agreement-templates/${AG.seedTemplateId("one_time")}/approve`, body: {} }; },
  "GET /agreements": async (fx) => { await agreement(fx, { send: true }); return { as: fx.owner, path: "/agreements" }; },
  "POST /agreements": async (fx) => ({ as: fx.owner, path: "/agreements", body: { plan_id: (await plan(fx, { status: "pending" })).id } }),
  "GET /agreements/:id": async (fx) => ({ as: fx.owner, path: `/agreements/${(await agreement(fx)).id}` }),
  "POST /agreements/:id/send": async (fx) => ({ as: fx.owner, path: `/agreements/${(await agreement(fx)).id}/send`, body: { channels: ["sms", "email"] } }),
  "POST /agreements/:id/void": async (fx) => ({ as: fx.owner, path: `/agreements/${(await agreement(fx, { send: true })).id}/void`, body: { reason: "Wrong plan" } }),
  "POST /agreements/:id/present": async (fx) => ({ as: fx.owner, path: `/agreements/${(await agreement(fx)).id}/present`, body: {} }),
  "GET /lights/seasons/:season": async (fx) => { await season(fx); return { as: fx.owner, path: "/lights/seasons/2026" }; },
  "PATCH /lights/installs/:id": async (fx) => ({ as: fx.owner, path: `/lights/installs/${(await season(fx)).id}`, body: { footage_ft: 160, colors: ["warm_white", "red"] } }),
  "POST /lights/installs/:id/warranty": async (fx) => ({ as: fx.owner, path: `/lights/installs/${(await season(fx)).id}/warranty`, body: { notes: "Bulbs out" } }),
};
