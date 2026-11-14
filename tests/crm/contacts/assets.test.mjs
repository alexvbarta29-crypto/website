// A property's counts for quoting (contacts assets.mjs): edited on the
// property (PATCH /properties/:id round-trips them), filled automatically
// from an approved quote's lines (quote.approved, under the parallel-run
// guard), and a new quote for the property starts from them (GET
// /properties/:id/requote): the engine prices the same lines again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, makeContact, importedContact, quoteOf, finishRun, fakes, scope, store, P, alog } from "../quotes/fixtures.mjs";

const AS_ = await import("../../../netlify/lib/crm/modules/contacts/assets.mjs");

const WINDOWS = { standard: 20, slider: 6, french: 5, garage_small: 4 };
// 20 + 12 + 2 (5 × 0.4) + 0 = 34 panes
const PANES = 34;

async function propertyFor(t, owner, c) {
  const r = await t.api(`/contacts/${c.id}/properties`, { method: "POST", as: owner, body: { label: "Home", address: { street1: "410 Example Ave", city: "Delano", state: "MN", zip: "55328" } } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.data.property;
}

const priced = async (t, owner, input) => {
  const r = await t.api("/pricing/suggest", { method: "POST", as: owner, body: { input } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.data;
};
const shape = (lines) => lines.map((l) => ({ title: l.title, category: l.category, qty_milli: l.qty_milli, unit_cents: l.unit_cents, total_cents: l.total_cents, scope: l.scope }));

test("the counts round-trip on the property: windows by type outside and inside, the other counts, notes; bad values are refused", async () => {
  const { t, owner, tech } = await setup();
  try {
    const c = await makeContact(owner);
    const p = await propertyFor(t, owner, c);
    const got = await t.api(`/properties/${p.id}`, { as: owner });
    const assets = { windows: { standard: 18, slider: 4, front_door: 1 }, windows_int: { standard: 16, slider: 4 }, panes_ext: 27, panes_int: 24, screens: 14, tracks: 6, tracks_premium: 2, stories: 2, gutter_ft: 160, downspouts: 4, roofline_ft: 120, ladder_ft: 28, notes: "Synthetic: 28 ft ladder on the back, gate on the left.", from: { kind: "manual", at: "2026-11-10T16:00:00.000Z" } };
    const r = await t.api(`/properties/${p.id}`, { method: "PATCH", as: owner, ifMatch: got.headers.get("etag"), body: { assets } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const back = (await t.api(`/properties/${p.id}`, { as: owner })).body.data.property.assets;
    assert.deepEqual(back, assets, "what was saved is what comes back");
    // the tech on a visit sees the counts (techFields) but the re-quote is office work
    assert.equal((await t.api(`/properties/${p.id}/requote`, { as: tech })).status, 403);
    // refused: a negative count, a window type count that isn't a number, an unknown service
    const etag = (await t.api(`/properties/${p.id}`, { as: owner })).headers.get("etag");
    for (const bad of [{ screens: -1 }, { windows: { standard: "lots" } }, { windows: { standard: 1000 } }, { services: "windows" }, { plan: "weekly" }]) {
      const x = await t.api(`/properties/${p.id}`, { method: "PATCH", as: owner, ifMatch: etag, body: { assets: { ...assets, ...bad } } });
      assert.equal(x.status, 400, JSON.stringify(bad));
    }
    // a zero count is dropped from the windows map (nothing to count)
    const z = await t.api(`/properties/${p.id}`, { method: "PATCH", as: owner, ifMatch: etag, body: { assets: { windows: { standard: 0, slider: 3 } } } });
    assert.deepEqual(z.body.data.property.assets.windows, { slider: 3 });
  } finally { t.done(); }
});

test("an approved quote fills the property's counts from its lines; a re-quote starts from them and the engine prices the same lines", async () => {
  const { t, owner } = await setup();
  const f = fakes();
  try {
    const c = await makeContact(owner);
    const p = await propertyFor(t, owner, c);
    const input = { services: ["windows_ext", "screens", "tracks_standard"], panes_ext: PANES, screens: 12, tracks: { standard: 8 } };
    const one = await priced(t, owner, input);
    const plan = await priced(t, owner, { ...input, plan: "quarterly" });
    const measure = { mode: "panes", windows: WINDOWS, panes_ext: PANES, services: { windows_ext: true, screens: true, tracks_standard: true }, counts: { screens: "12", tracks_standard: "8" }, plan: "quarterly" };
    const made = await t.api("/quotes", { method: "POST", as: owner, body: { contact_id: c.id, property_id: p.id, measure, options: [
      { name: "One-time", kind: "one_time", recommended: false, lines: one.lines, discounts: [] },
      { name: "Quarterly plan", kind: "plan", recommended: true, plan: { ...plan.plan, term_months: 12 }, lines: plan.lines, discounts: plan.discounts },
    ] } });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const q = made.body.data;
    const planOpt = q.options.find((o) => o.kind === "plan");
    assert.equal((await t.api(`/quotes/${q.id}/send`, { method: "POST", as: owner, body: { channels: ["sms"] } })).status, 200);
    const ap = await t.api(`/quotes/${q.id}/approve`, { method: "POST", as: owner, body: { by_phone: true, option_id: planOpt.id, name_typed: "Pat Sample" } });
    assert.equal(ap.status, 202, JSON.stringify(ap.body));
    assert.equal((await finishRun(t, ap.body.data.run_id)).status, "done");
    for (let i = 0; i < 4; i++) await t.runWorker({ lane: "fast" });
    assert.ok(["approved", "converted"].includes((await quoteOf(q.id)).status));

    const prop = (await scope(() => store.getRecord("property", p.id))).data;
    const a = prop.assets;
    assert.deepEqual(a.windows, WINDOWS, "the windows by type the quote counted");
    assert.equal(a.panes_ext, PANES);
    assert.equal(a.french_panes, 5);
    assert.equal(a.screens, 12, "from the screens line");
    assert.equal(a.tracks, 8, "from the tracks line");
    assert.deepEqual(a.services, ["windows_ext", "windows_int", "screens", "tracks_standard"], "the plan option's services (quarterly adds the interior visit)");
    assert.equal(a.plan, "quarterly");
    assert.equal(a.from.kind, "quote");
    assert.equal(a.from.quote_id, q.id);

    // re-quote: the builder's start, and the engine's lines for it match what was approved
    const rq = await t.api(`/properties/${p.id}/requote`, { as: owner });
    assert.equal(rq.status, 200, JSON.stringify(rq.body));
    const start = rq.body.data.start;
    assert.equal(rq.body.data.contact_id, c.id);
    assert.equal(start.ready, true);
    assert.equal(start.plan, "quarterly");
    assert.deepEqual(start.measure.windows, { standard: 20, slider: 6, large: 0, sliding_door: 0, french: 5, front_door: 0, garage_small: 4 });
    assert.equal(start.counts.screens, "12");
    assert.equal(start.counts.tracks_standard, "8");
    const weights = P.PRICING_DEFAULTS.pane_weights;
    const again = AS_.suggestInput(start, weights);
    assert.equal(again.panes_ext, PANES, "the same weighted panes");
    const replan = await priced(t, owner, { ...again, plan: start.plan });
    assert.deepEqual(shape(replan.lines), shape(planOpt.lines), "the re-quote prices the same plan lines");
    const reone = await priced(t, owner, again);
    assert.deepEqual(shape(reone.lines).filter((l) => l.category !== "windows_int"), shape(q.options.find((o) => o.kind === "one_time").lines), "and the same one-time lines");
    // approving again with nothing new changes nothing
    const wv = prop.wv;
    await scope(() => AS_.onQuoteApproved({ payload: { quote_id: q.id } }, { ctx: { mayAct: () => true, would: async () => {}, write: () => ({ by: "system:test", origin: "worker", actor_kind: "automation", requestId: "t", mode: { system_of_record: "rotor" } }) } }));
    assert.equal((await scope(() => store.getRecord("property", p.id))).data.wv, wv, "unchanged");
  } finally { f.restore(); t.done(); }
});

test("counts from a quote (pure): only ticked add-ons count, lights feet become the roofline, square feet keep the counted windows", () => {
  const lines = [
    { category: "windows_ext", title: "Exterior Window Cleaning", qty_milli: 1000 },
    { category: "screens", title: "Screen Cleaning", qty_milli: 9000, optional: true, selected: false },
    { category: "tracks", title: "Premium Track Detailing", qty_milli: 4000 },
    { category: "lights", unit: "ft", title: "Christmas Light Installation", qty_milli: 142500 },
    { category: "lights", unit: "ft", title: "Christmas Light Materials", qty_milli: 142500 },
  ];
  const c = AS_.countsFromQuote({ measure: { mode: "sqft", sqft: 3100, windows: { standard: 9 } }, lines, option: { kind: "one_time" } });
  assert.equal(c.windows, undefined, "a square-feet quote didn't count windows");
  assert.equal(c.sqft, 3100);
  assert.equal(c.screens, undefined, "an add-on the customer didn't tick");
  assert.equal(c.tracks_premium, 4);
  assert.equal(c.roofline_ft, 143);
  assert.equal(c.plan, "none");
  assert.deepEqual(c.services, ["windows_ext", "tracks_premium"]);
  const merged = AS_.mergeCounts({ windows: { standard: 30 }, stories: 2, gutter_ft: 150, notes: "Synthetic note" }, c, { kind: "quote", at: "2026-11-10T16:00:00.000Z" });
  assert.deepEqual(merged.windows, { standard: 30 }, "the counted windows stay");
  assert.equal(merged.stories, 2);
  assert.equal(merged.gutter_ft, 150);
  assert.equal(merged.notes, "Synthetic note");
  assert.equal(AS_.mergeCounts(merged, c, { kind: "quote" }), null, "the same counts again: no change");
  // a property with nothing counted: windows only, ready false
  const s = AS_.requoteFrom({});
  assert.equal(s.ready, false);
  assert.deepEqual(s.services, { windows_ext: true });
  const s2 = AS_.requoteFrom({ sqft: 2800, plan: "none" });
  assert.equal(s2.measure.mode, "sqft");
  assert.equal(s2.plan, "", "no plan last time: none offered");
  assert.equal(s2.ready, true);
});

test("an imported property: an approved quote writes a would- row, never a change (parallel-run guard)", async () => {
  const { t, owner } = await setup();
  try {
    const c = await importedContact();
    const prop = (await scope(() => store.createRecord("property", { contact_id: c.id, label: "Home", address: { street1: "500 Example Ave", city: "Mound", state: "MN", zip: "55364", country: "US" }, access: {}, assets: {}, photo_ids: [], import: { run_id: "ir_00000000000000000001", at: "2026-11-08T00:00:00.000Z", hash: "1".repeat(64) } }, { by: "import", origin: "import", actor_kind: "import", requestId: "t" }))).data;
    const quote = (await scope(() => store.createRecord("quote", {
      contact_id: c.id, property_id: prop.id, status: "approved", number: 1, seq: "quote-shadow", options: [{ id: "op_a", name: "One-time", kind: "one_time", recommended: true, lines: [{ id: "ln_s", title: "Screen Cleaning", category: "screens", qty_milli: 10000, unit_cents: 500, scope: { type: "all" } }], discounts: [] }],
      approval: { option_id: "op_a", selected_line_ids: [] }, measure: { mode: "panes", windows: { standard: 22 }, panes_ext: 22 },
    }, { by: owner.id, origin: "api", actor_kind: "user", requestId: "t" })));
    const r = await scope(() => import("../../../netlify/lib/crm/core/activity.mjs").then((A) => AS_.onQuoteApproved({ payload: { quote_id: quote.data.id } }, { ctx: A.automationCtx({ mode: { system_of_record: "rotor", paused: false }, key: "contacts.quote_approved" }) })));
    assert.equal(r.result, "would-update");
    assert.deepEqual((await scope(() => store.getRecord("property", prop.id))).data.assets, {}, "nothing changed");
    assert.ok(alog(t).some((k) => k.includes("would")), "a would- row");
  } finally { t.done(); }
});
