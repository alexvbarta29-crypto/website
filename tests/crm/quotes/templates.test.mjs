// Estimate templates (the owner, Nov 16): the seeded Barta templates (windows,
// gutters and Christmas lights only), applying one to a New Quote (prices
// from today's price book, quantities from the property's counts or blank),
// "Save this quote as a template", edit / reorder / archive, permissions and
// validation. Synthetic data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, makeContact, oneTime, quarterly, scope, store, AS, AUTOMATION, P, pin } from "./fixtures.mjs";

const TPL = await import("../../../netlify/lib/crm/modules/quotes/templates.mjs");
const Q = await import("../../../netlify/lib/crm/modules/quotes/quotes.mjs");

async function seeded(t) {
  await scope(() => TPL.seedEstimateTemplates({ write: () => AUTOMATION }));
  return t;
}
async function makeProperty(owner, contact, assets = {}) {
  return (await scope(() => store.createRecord("property", { contact_id: contact.id, label: "Home", address: { street1: "300 Example Ave", city: "Delano", state: "MN", zip: "55328" }, access: {}, assets, photo_ids: [] }, AS(owner)))).data;
}

test("the seeded templates: Barta's estimates, windows, gutters and lights only; once each, never over an owner's edit", async () => {
  const { t, owner, tech } = await setup();
  try {
    await seeded(t);
    const again = await scope(() => TPL.seedEstimateTemplates({ write: () => AUTOMATION }));
    assert.equal(again.made, 0, "a second run makes nothing");
    const list = await t.api("/quote-templates", { as: owner });
    assert.equal(list.status, 200);
    const names = list.body.data.map((r) => r.name);
    assert.deepEqual(names, [
      "Exterior windows", "Interior + exterior windows", "Exterior windows + screens + tracks", "Quarterly plan (3 exterior + 1 interior)", "Biannual plan",
      "Gutter cleaning", "Windows + gutters", "Christmas lights: roofline", "Christmas lights: roofline + bushes/trees", "Lights takedown + storage",
    ]);
    assert.ok(list.body.data.every((r) => r.summary && r.summary.length <= 140 && !/\u2014/.test(r.summary)), "a one-line summary, no em dashes");
    assert.ok(!names.some((n) => /pressure|soft ?wash|house wash/i.test(n)), "never pressure or soft washing");
    for (const s of TPL.SEED_TEMPLATES) for (const o of s.options) for (const it of o.items) {
      if (it.key) assert.ok(["exterior", "interior", "screens", "tracks_standard", "gutters", "lights_install", "lights_materials", "lights_takedown", "lights_warranty"].includes(it.key), `${s.name}: ${it.key}`);
    }
    assert.equal((await t.api("/quote-templates", { as: tech })).status, 403, "techs don't quote");
    // an owner's edit stays through a re-seed
    const id = TPL.seedTemplateId("exterior");
    const g = await t.api(`/quote-templates/${id}`, { as: owner });
    const ed = await t.api(`/quote-templates/${id}`, { method: "PATCH", as: owner, ifMatch: g.headers.get("etag"), body: { name: "Outside windows" } });
    assert.equal(ed.status, 200, JSON.stringify(ed.body));
    await scope(() => TPL.seedEstimateTemplates({ write: () => AUTOMATION }));
    assert.equal((await t.api(`/quote-templates/${id}`, { as: owner })).body.data.name, "Outside windows");
  } finally { t.done(); }
});

test("applying a template: exterior by the property's panes, screens and tracks from its counts, plan scopes and the plan discount", async () => {
  const { t, owner, admin } = await setup();
  try {
    await seeded(t);
    const c = await makeContact(owner);
    const prop = await makeProperty(owner, c, { panes_ext: 38, screens: 14, tracks: 6 });
    const a = await t.api(`/quote-templates/${TPL.seedTemplateId("ext_screens_tracks")}/apply`, { method: "POST", as: admin, body: { property_id: prop.id } });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    const [o] = a.body.data.options;
    assert.deepEqual(o.lines.map((l) => [l.title, l.qty_milli, l.unit_cents, l.total_cents]), [
      ["Exterior Window Cleaning", 1000, 29500, 29500], ["Screen Cleaning", 14000, 500, 7000], ["Track Detailing", 6000, 500, 3000],
    ]);
    assert.equal(o.lines[0].engine_cents, 29500, "the engine's tier price, locked like the builder's");
    assert.deepEqual(a.body.data.warnings, []);
    assert.deepEqual(a.body.data.counts, { panes_ext: 38, screens: 14, tracks: 6 });

    // the quarterly template: exterior on visits 1, 3, 4, interior on 2, the plan's own discount; a one-time beside it
    const qz = await t.api(`/quote-templates/${TPL.seedTemplateId("quarterly")}/apply`, { method: "POST", as: owner, body: { property_id: prop.id } });
    const [plan, once] = qz.body.data.options;
    assert.equal(plan.kind, "plan");
    assert.equal(plan.plan.catalog_key, "quarterly");
    assert.deepEqual(plan.lines.map((l) => l.scope), [{ type: "specific", visits: [1, 3, 4] }, { type: "specific", visits: [2] }]);
    assert.deepEqual(plan.discounts.map((d) => [d.key, d.value, d.stack_group]), [["plan_quarterly", 10000, "plan"]]);
    assert.equal(once.kind, "one_time");
    assert.equal(plan.recommended, true);
    // the options save as a quote as they are (the server re-checks every line)
    const made = await t.api("/quotes", { method: "POST", as: owner, body: { contact_id: c.id, property_id: prop.id, options: qz.body.data.options } });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.deepEqual(made.body.data.options[0].totals.per_visit_cents, [19500, 6000, 19500, 19500]);

    // no counts on file: blank quantities and a price to set, with the reasons
    const bare = await t.api(`/quote-templates/${TPL.seedTemplateId("ext_screens_tracks")}/apply`, { method: "POST", as: owner, body: {} });
    const lines = bare.body.data.options[0].lines;
    assert.deepEqual(lines.map((l) => [l.qty_milli, l.unit_cents]), [[1000, 0], [0, 500], [0, 500]]);
    assert.equal(lines[0].engine_cents, undefined);
    assert.deepEqual(bare.body.data.warnings.sort(), ["count_panes", "count_screens_on_site", "count_tracks"]);
    // square feet only: the pane estimate, to confirm on site
    const sq = await makeProperty(owner, c, { sqft: 3200 });
    const bySq = await t.api(`/quote-templates/${TPL.seedTemplateId("exterior")}/apply`, { method: "POST", as: owner, body: { property_id: sq.id } });
    assert.equal(bySq.body.data.options[0].lines[0].unit_cents, 29500);
    assert.deepEqual(bySq.body.data.warnings, ["confirm_panes_on_site"]);
  } finally { t.done(); }
});

test("lights templates price like the lights quote: $8 + $2 a foot from the roofline, Early Bird before the deadline, takedown and warranty included", async () => {
  const { t, owner } = await setup("2026-11-10T16:00:00Z");
  try {
    await seeded(t);
    const c = await makeContact(owner);
    const prop = await makeProperty(owner, c, { roofline_ft: 120 });
    const a = await t.api(`/quote-templates/${TPL.seedTemplateId("lights_roofline")}/apply`, { method: "POST", as: owner, body: { property_id: prop.id } });
    const [every, once] = a.body.data.options;
    assert.equal(every.plan.catalog_key, "lights_annual");
    assert.equal(every.plan.billing, "after_visit");
    assert.deepEqual(every.lines.map((l) => [l.title, l.qty_milli, l.unit_cents, l.total_cents]), [
      ["Christmas Light Installation", 120000, 800, 96000], ["Christmas Light Materials", 120000, 200, 24000], ["Takedown and Storage", 1000, 0, 0], ["In-Season Material Warranty", 1000, 0, 0],
    ]);
    assert.match(every.lines[0].description, /^Roofline 120 ft\. Colors: warm white$/);
    assert.deepEqual(every.discounts.map((d) => [d.key, d.type, d.value, d.offer_until]), [["early_bird", "percentage", 5000, "2026-12-01"]]);
    assert.equal(once.kind, "one_time");
    // the same numbers as POST /pricing/lights for 120 ft
    const lt = await t.api("/pricing/lights", { method: "POST", as: owner, body: { runs: [{ label: "Roofline", feet: 120 }], colors: ["warm_white"], early_bird: true } });
    assert.equal(P.optionTotals({ kind: "one_time", lines: every.lines, discounts: every.discounts }).first_cents, P.optionTotals({ kind: "one_time", lines: lt.body.data.lines, discounts: lt.body.data.discounts }).first_cents);
    // after the season's deadlines the Early Bird is left off, with the reason
    pin("2026-12-15T16:00:00Z");
    const late = await t.api(`/quote-templates/${TPL.seedTemplateId("lights_roofline")}/apply`, { method: "POST", as: owner, body: {} });
    assert.deepEqual(late.body.data.options[0].discounts, []);
    assert.ok(late.body.data.warnings.includes("early_bird_over") && late.body.data.warnings.includes("measure_lights"));
    assert.equal(late.body.data.options[0].lines[0].qty_milli, 0, "no roofline on file: the feet stay blank");
    // bushes and trees: their own lines, feet blank
    const bt = await t.api(`/quote-templates/${TPL.seedTemplateId("lights_roof_bushes")}/apply`, { method: "POST", as: owner, body: { property_id: prop.id } });
    assert.deepEqual(bt.body.data.options[0].lines.map((l) => [l.qty_milli, l.description.split(".")[0]]).slice(0, 4), [[120000, "Roofline 120 ft"], [120000, "Roofline 120 ft"], [0, "Bushes and trees"], [0, "Bushes and trees"]]);
    // takedown on its own: a price to set
    const td = await t.api(`/quote-templates/${TPL.seedTemplateId("lights_takedown")}/apply`, { method: "POST", as: owner, body: {} });
    assert.deepEqual(td.body.data.warnings, ["set_price"]);
  } finally { t.done(); }
});

test("save a quote as a template, edit it, reorder, archive; settings:general to change, quotes:write to apply", async () => {
  const { t, owner, admin, tech } = await setup();
  try {
    await seeded(t);
    const c = await makeContact(owner);
    const made = await t.api("/quotes", { method: "POST", as: owner, body: { contact_id: c.id, client_notes: "Thanks for having us out!", options: [oneTime(), quarterly()] } });
    const q = made.body.data;
    assert.equal((await t.api("/quote-templates", { method: "POST", as: tech, body: { from_quote_id: q.id, name: "X" } })).status, 403);
    const noSettings = await t.user("admin", { denies: ["settings:general"] });
    assert.equal((await t.api("/quote-templates", { method: "POST", as: noSettings, body: { from_quote_id: q.id, name: "X" } })).status, 403);
    assert.equal((await t.api(`/quote-templates/${TPL.seedTemplateId("exterior")}/apply`, { method: "POST", as: noSettings, body: {} })).status, 200, "applying needs quotes:write only");
    const saved = await t.api("/quote-templates", { method: "POST", as: admin, body: { from_quote_id: q.id, name: "Neighbor special", summary: "Exterior or quarterly." } });
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    const tpl = saved.body.data;
    assert.equal(tpl.kind, "plan");
    assert.equal(tpl.from_quote_id, q.id);
    assert.equal(tpl.client_notes, "Thanks for having us out!");
    assert.deepEqual(tpl.options.map((o) => [o.kind, o.plan_key || null, o.discounts.length]), [["one_time", null, 0], ["plan", "quarterly", 0]], "the plan's own discount comes back by itself");
    assert.deepEqual(tpl.options[0].items, [{ title: "Exterior Window Cleaning", unit_cents: 29500 }], "a hand line keeps its name and price");
    const ap = await t.api(`/quote-templates/${tpl.id}/apply`, { method: "POST", as: owner, body: {} });
    assert.deepEqual(ap.body.data.options[1].discounts.map((d) => d.key), ["plan_quarterly"]);
    assert.equal(ap.body.data.options[0].lines[0].total_cents, 29500);

    // validation: no options, a bad kind, a 3-year on a one-time option, hostile text kept as text
    const bad = await t.api("/quote-templates", { method: "POST", as: owner, body: { name: "Empty", options: [] } });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.field, "options");
    assert.equal((await t.api("/quote-templates", { method: "POST", as: owner, body: { name: "x", kind: "pressure", options: [{ items: [{ key: "exterior" }] }] } })).status, 400);
    assert.equal((await t.api("/quote-templates", { method: "POST", as: owner, body: { name: "x", options: [{ kind: "one_time", items: [{ key: "lights_install" }], lights: { three_year: true } }] } })).body.error.field, "options.0.lights.three_year");
    assert.equal((await t.api("/quote-templates", { method: "POST", as: owner, body: { name: "x", options: [{ items: [{ from: "panes_ext" }] }] } })).status, 400, "a line needs an item or a name");
    const xss = await t.api("/quote-templates", { method: "POST", as: owner, body: { name: "<img src=x onerror=alert(1)>", options: [{ items: [{ title: "<b>Hi</b>", unit_cents: 1000 }] }] } });
    assert.equal(xss.status, 201);
    assert.equal(xss.body.data.name, "<img src=x onerror=alert(1)>", "stored as text; the screens escape it");

    // reorder and archive
    const ids = (await t.api("/quote-templates", { as: owner })).body.data.map((r) => r.id);
    const want = [tpl.id, ...ids.filter((x) => x !== tpl.id)];
    const ro = await t.api("/quote-templates/reorder", { method: "POST", as: owner, body: { ids: want } });
    assert.equal(ro.status, 200, JSON.stringify(ro.body));
    assert.equal((await t.api("/quote-templates", { as: owner })).body.data[0].id, tpl.id);
    assert.equal((await t.api("/quote-templates/reorder", { method: "POST", as: owner, body: { ids: [tpl.id, tpl.id] } })).status, 400);
    const e = (await t.api(`/quote-templates/${tpl.id}`, { as: owner })).headers.get("etag");
    assert.equal((await t.api(`/quote-templates/${tpl.id}`, { method: "PATCH", as: owner, ifMatch: e, body: { archived: true } })).status, 200);
    assert.ok(!(await t.api("/quote-templates", { as: owner })).body.data.some((r) => r.id === tpl.id), "archived ones leave the picker");
    assert.ok((await t.api("/quote-templates?archived=1", { as: owner })).body.data.some((r) => r.id === tpl.id && r.archived), "and stay in Settings to restore");
    assert.equal((await t.api(`/quote-templates/${tpl.id}`, { method: "PATCH", as: owner, ifMatch: e, body: { archived: false } })).status, 412, "If-Match");
  } finally { t.done(); }
});

test("applyTemplate is pure: a missing price-book item is reported, never invented; the 3-year contract makes a 36-month lights plan", () => {
  const book = [{ id: "pi_x", key: "lights_install", name: "Christmas Light Installation", category: "lights", unit: "ft", unit_cents: 800, engine: "lights_install_ft", show: { qty: true, unit: true, description: true } }];
  let n = 0;
  const out = TPL.applyTemplate({ client_notes: "Hi", options: [{ name: "Every season", kind: "plan", plan_key: "lights_annual", items: [{ key: "lights_install", qty_milli: 50000 }, { key: "nope" }], discounts: [], lights: { early_bird: false, three_year: true, colors: ["red", "green"] } }] }, { pricing: {}, book, defs: [], counts: {}, today: "2026-11-10", lineId: () => `ln_t${++n}` });
  assert.equal(out.options[0].lines.length, 1);
  assert.equal(out.options[0].lines[0].total_cents, 40000);
  assert.ok(out.warnings.includes("missing_item"));
  assert.equal(out.options[0].plan.term_months, 36);
  assert.deepEqual(out.options[0].discounts.map((d) => [d.key, d.value]), [["three_year", 20000]]);
  assert.match(out.options[0].lines[0].description, /Colors: red, green/);
  assert.equal(out.client_notes, "Hi");
  assert.deepEqual(TPL.countsOf({ assets: { panes_ext: 12, notes: "x", roofline_ft: 0 }, lights: { total_ft: 88.4 } }), { panes_ext: 12, roofline_ft: 88 });
});

void Q;
