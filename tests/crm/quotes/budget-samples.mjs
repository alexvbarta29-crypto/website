// Budget samples for the quotes routes (read by tests/crm/core/budget.test.mjs):
// "METHOD /path" → (fx) → the request. Each sample makes what it needs
// through the store first (synthetic people only).

const store = await import("../../../netlify/lib/crm-store.mjs");
const SEED = await import("../../../netlify/lib/crm/modules/quotes/seed.mjs");
const Q = await import("../../../netlify/lib/crm/modules/quotes/quotes.mjs");
const W = { by: "system", origin: "api", actor_kind: "user", requestId: "budget" };
const AUTO = { by: "system:budget", origin: "worker", actor_kind: "automation", requestId: "budget", mode: { system_of_record: "rotor", paused: false } };
const scope = (fn) => store.withStoreScope({ requestId: "budget" }, fn);

let seeded = false;
const seeds = () => scope(async () => { if (!seeded) { seeded = true; await SEED.seedPriceBook({ write: () => AUTO }); } });
let n = 0;
const person = (fx) => ({ user: { id: fx.owner.id }, can: () => true, write: () => ({ ...W, by: fx.owner.id }) });
const contact = () => scope(async () => {
  n += 1;
  return (await store.createRecord("contact", {
    first_name: "Budget", last_name: `Quote${n}`, phones: [{ e164: `+1763555${String(700 + n).padStart(4, "0")}`, sms: true, primary: true }], emails: [{ address: `budget.quote${n}@example.com` }],
    lifecycle: "lead", source: { source: "Website quote form" }, consent: { sms_service: { state: "granted" } },
  }, W)).data;
});
const OPTIONS = [
  { name: "One-time", kind: "one_time", recommended: true, lines: [{ title: "Exterior Window Cleaning", qty_milli: 1000, unit_cents: 29500, category: "windows_ext" }] },
  { name: "Quarterly plan", kind: "plan", plan: { catalog_key: "quarterly", frequency: { interval: "month", count: 3 }, visits_per_year: 4, term_months: 12 }, lines: [{ title: "Exterior Window Cleaning", qty_milli: 1000, unit_cents: 29500, category: "windows_ext", scope: { type: "specific", visits: [1, 3, 4] } }, { title: "Interior Window Cleaning", qty_milli: 1000, unit_cents: 16000, category: "windows_int", scope: { type: "specific", visits: [2] } }], discounts: [{ key: "plan_quarterly", name: "Quarterly plan discount", type: "fixed", value: 10000 }] },
];
const quote = async (fx, { send = false } = {}) => {
  await seeds();
  const c = await contact();
  return scope(async () => {
    const r = await Q.createQuote({ contact_id: c.id, options: OPTIONS }, person(fx));
    if (!send) return { ...r.data, etag: r.etag };
    const s = await Q.sendQuote(r.data.id, { channels: ["sms"] }, person(fx));
    return { ...s.quote, etag: s.etag, version: s.version };
  });
};
const item = async (key) => { await seeds(); return scope(async () => store.getRecord("price_item", SEED.seedItemId(key))); };
const def = async (key) => { await seeds(); return scope(async () => store.getRecord("discount_def", SEED.seedDiscountId(key))); };

export default {
  "GET /pricing/context": async (fx) => { await seeds(); return { as: fx.owner, path: "/pricing/context" }; },
  "POST /pricing/suggest": async (fx) => { await seeds(); return { as: fx.owner, path: "/pricing/suggest", body: { input: { services: ["windows_ext", "windows_int", "screens", "tracks_standard", "gutters"], sqft: 3200, tracks: { standard: 8 }, plan: "quarterly" } } }; },
  "POST /pricing/totals": (fx) => ({ as: fx.owner, path: "/pricing/totals", body: { option: OPTIONS[1] } }),
  "POST /pricing/lights": async (fx) => { await seeds(); return { as: fx.owner, path: "/pricing/lights", body: { runs: [{ label: "Roofline", feet: 140 }, { label: "Peaks", feet: 30 }], early_bird: true, three_year: true, colors: ["warm_white"] } }; },
  "GET /pricebook": async (fx) => { await seeds(); return { as: fx.owner, path: "/pricebook" }; },
  "GET /pricebook/:id": async (fx) => ({ as: fx.owner, path: `/pricebook/${(await item("screens")).data.id}` }),
  "POST /pricebook": (fx) => ({ as: fx.owner, path: "/pricebook", body: { name: "Skylight Cleaning", category: "other", unit: "each", unit_cents: 2500 } }),
  "PATCH /pricebook/:id": async (fx) => { const g = await item("tracks_premium"); return { as: fx.owner, path: `/pricebook/${g.data.id}`, ifMatch: g.etag, body: { unit_cents: 1600 } }; },
  "GET /discounts": async (fx) => { await seeds(); return { as: fx.owner, path: "/discounts" }; },
  "GET /discounts/:id": async (fx) => ({ as: fx.owner, path: `/discounts/${(await def("first_time")).data.id}` }),
  "POST /discounts": (fx) => ({ as: fx.owner, path: "/discounts", body: { name: "Budget Neighbor", type: "fixed", value: 2500 } }),
  "PATCH /discounts/:id": async (fx) => { const g = await def("service_offer"); return { as: fx.owner, path: `/discounts/${g.data.id}`, ifMatch: g.etag, body: { value: 4000 } }; },
  "GET /quotes": async (fx) => { await quote(fx); return { as: fx.owner, path: "/quotes" }; },
  "POST /quotes": async (fx) => { await seeds(); return { as: fx.owner, path: "/quotes", body: { contact_id: (await contact()).id, options: OPTIONS } }; },
  "GET /quotes/:id": async (fx) => ({ as: fx.owner, path: `/quotes/${(await quote(fx, { send: true })).id}` }),
  "PATCH /quotes/:id": async (fx) => { const q = await quote(fx, { send: true }); return { as: fx.owner, path: `/quotes/${q.id}`, ifMatch: q.etag, body: { client_notes: "Thanks for having us out!", options: q.options, measure: { sqft: 3000 } } }; },
  "POST /quotes/:id/send": async (fx) => ({ as: fx.owner, path: `/quotes/${(await quote(fx)).id}/send`, body: { channels: ["sms", "email"] } }),
  "POST /quotes/:id/approve": async (fx) => { const q = await quote(fx); return { as: fx.owner, path: `/quotes/${q.id}/approve`, body: { option_id: q.options[1].id, by_phone: true } }; },
  "POST /quotes/:id/convert": async (fx) => ({ as: fx.owner, path: `/quotes/${(await quote(fx, { send: true })).id}/convert`, body: {} }),
  "POST /quotes/:id/present": async (fx) => ({ as: fx.owner, path: `/quotes/${(await quote(fx)).id}/present`, body: {} }),
  "GET /quotes/:id/versions": async (fx) => ({ as: fx.owner, path: `/quotes/${(await quote(fx, { send: true })).id}/versions` }),
  "GET /quotes/:id/versions/:vid": async (fx) => { const q = await quote(fx, { send: true }); return { as: fx.owner, path: `/quotes/${q.id}/versions/${q.version.id}` }; },
  "POST /quotes/:id/archive": async (fx) => ({ as: fx.owner, path: `/quotes/${(await quote(fx, { send: true })).id}/archive`, body: {} }),
  "POST /quotes/:id/restore": async (fx) => { const q = await quote(fx); await scope(() => Q.archiveQuote(q.id, {}, person(fx))); return { as: fx.owner, path: `/quotes/${q.id}/restore`, body: {} }; },
  "POST /quotes/:id/decline": async (fx) => ({ as: fx.owner, path: `/quotes/${(await quote(fx, { send: true })).id}/decline`, body: { reason: "Going with someone else" } }),
  "POST /quotes/:id/duplicate": async (fx) => ({ as: fx.owner, path: `/quotes/${(await quote(fx, { send: true })).id}/duplicate`, body: {} }),
  "GET /quotes/:id/preview": async (fx) => ({ as: fx.owner, path: `/quotes/${(await quote(fx, { send: true })).id}/preview` }),
};
