// Quotes module: estimate templates (the owner, Nov 16: "make sure you have
// templates for certain types of estimates"). A template is a ready-made
// start for New Quote: its name, a one-line summary, its kind (one-time,
// plan or Christmas lights), up to 3 options, each with line items from the
// price book (a fixed quantity, or "from the property's counts"), discounts,
// and the notes. Picking one fills the New Quote form (the customer stays);
// everything stays editable before Create. Prices are never stored in a
// template for engine-priced or price-book items: applying one prices them
// from today's price book and cfg/pricing (exterior by the property's pane
// count, lights by its roofline feet), so a price change reaches every
// template at once.
//
// Record: quote_template (prefix et), listed through the quote-templates
// index (name, summary, kind, sort, archived). Seeded once (seed v3) with
// Barta's usual estimates: windows, gutters and Christmas lights only.
//
//   GET  /quote-templates[?archived=1]       quotes:read
//   GET  /quote-templates/:id                quotes:read
//   POST /quote-templates                    settings:general  ({...} or { from_quote_id, name })
//   PATCH /quote-templates/:id (If-Match)    settings:general  (archived: true archives)
//   POST /quote-templates/reorder {ids}      settings:general
//   POST /quote-templates/:id/apply {property_id?}  quotes:write → the New Quote options

import { createRecord, getRecord, getRecords, patchRecord, updateRecord, readIndex } from "../../../crm-store.mjs";
import { defineType } from "../../core/registry.mjs";
import { deriveId, isId } from "../../core/ids.mjs";
import { localDate, now } from "../../core/clock.mjs";
import { InputError, NotFoundError, ExistsError } from "../../core/errors.mjs";
import { shape, str, enumValue, bool, arr, int, isPlainObject } from "../../core/validate.mjs";
import {
  PLAN_CATALOG, exteriorCents, interiorCents, tierFromSqft, addOnUnit, lineTotal, planDiscountFor, lightsDiscounts, earlyBirdDeadline, COLORS, ADDON_CATEGORIES,
} from "./pricing.mjs";
import { DEF_KEY_RE, MAX_OPTIONS, MAX_LINES, MAX_DISCOUNTS } from "./types.mjs";
import { loadPricing, priceBook, discountDefs, newLineId, strip } from "./quotes.mjs";

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const posInt = (v) => (Number.isSafeInteger(v) && v > 0 ? v : 0);

// ------------------------------------------------------------ vocabulary

export const TEMPLATE_KINDS = Object.freeze(["one_time", "plan", "lights"]);
export const TEMPLATE_PLANS = Object.freeze(["biannual", "quarterly", "monthly", "lights_annual", "custom"]);
// "from the property's counts" (contacts/assets.mjs)
export const QTY_FROM = Object.freeze(["panes_ext", "panes_int", "screens", "tracks", "tracks_premium", "roofline_ft", "gutter_ft"]);
export const LIGHT_COLORS = Object.freeze(Object.keys(COLORS));
export const MAX_TEMPLATES = 60;

// ------------------------------------------------------------ validation

function validateItem(v, f) {
  if (!isObj(v)) throw new InputError("Expected a line item.", f);
  const key = v.key === undefined || v.key === null || v.key === "" ? undefined : DEF_KEY_RE.test(String(v.key)) ? String(v.key) : (() => { throw new InputError("That isn't a price book key.", `${f}.key`); })();
  const price_item_id = v.price_item_id === undefined || v.price_item_id === null || v.price_item_id === "" ? undefined : isId(v.price_item_id, "price_item") ? v.price_item_id : (() => { throw new InputError("That isn't a price book item.", `${f}.price_item_id`); })();
  const title = str(v.title, { field: `${f}.title`, max: 160 });
  if (!key && !price_item_id && !title) throw new InputError("Pick a price book item or name the line.", f);
  // qty in thousandths (1.5 ft = 1500); null = blank (filled on the quote)
  const qty_milli = int(v.qty_milli, { field: `${f}.qty_milli`, min: 0, max: 1000000000 });
  const from = enumValue(v.from, QTY_FROM, { field: `${f}.from` });
  const unit_cents = int(v.unit_cents, { field: `${f}.unit_cents`, min: 0, max: 100000000 });
  const note = str(v.note, { field: `${f}.note`, max: 120 });
  const description = str(v.description, { field: `${f}.description`, max: 2000, trim: false });
  return {
    ...(key ? { key } : {}), ...(price_item_id ? { price_item_id } : {}), ...(title ? { title } : {}),
    ...(qty_milli !== undefined ? { qty_milli } : {}), ...(from ? { from } : {}), ...(unit_cents !== undefined ? { unit_cents } : {}),
    ...(note ? { note } : {}), ...(description ? { description } : {}), ...(v.optional === true ? { optional: true } : {}),
  };
}

function validateTplDiscount(v, f) {
  if (!isObj(v)) throw new InputError("Expected a discount.", f);
  if (v.key !== undefined && v.key !== null && v.key !== "") {
    if (!DEF_KEY_RE.test(String(v.key))) throw new InputError("That isn't a discount key.", `${f}.key`);
    return { key: String(v.key) };
  }
  const type = enumValue(v.type, ["fixed", "percentage"], { field: `${f}.type`, required: true });
  return {
    name: str(v.name, { field: `${f}.name`, max: 80, required: true }), type,
    value: int(v.value, { field: `${f}.value`, min: 1, max: type === "percentage" ? 10000 : 100000000, required: true }),
  };
}

function validateTplOption(v, f) {
  if (!isObj(v)) throw new InputError("Expected an option.", f);
  const kind = enumValue(v.kind, ["one_time", "plan"], { field: `${f}.kind` }) || "one_time";
  const plan_key = kind === "plan" ? enumValue(v.plan_key, TEMPLATE_PLANS, { field: `${f}.plan_key`, required: true }) : undefined;
  const lights = isObj(v.lights) ? {
    early_bird: bool(v.lights.early_bird, { field: `${f}.lights.early_bird` }),
    three_year: bool(v.lights.three_year, { field: `${f}.lights.three_year` }),
    colors: [...new Set(arr(v.lights.colors, (c, cf) => enumValue(c, LIGHT_COLORS, { field: cf, required: true }), { field: `${f}.lights.colors`, max: 6 }))],
  } : undefined;
  if (lights && lights.three_year && plan_key !== "lights_annual") throw new InputError("The 3-year discount is for a lights plan (every season).", `${f}.lights.three_year`);
  const items = arr(v.items, (x, xf) => validateItem(x, xf), { field: `${f}.items`, max: MAX_LINES });
  return {
    name: str(v.name, { field: `${f}.name`, max: 80 }) || (kind === "plan" ? (PLAN_CATALOG[plan_key] || {}).name || "Plan" : "One-time"),
    kind, ...(plan_key ? { plan_key } : {}), recommended: v.recommended === true,
    items, discounts: arr(v.discounts, (x, xf) => validateTplDiscount(x, xf), { field: `${f}.discounts`, max: MAX_DISCOUNTS }),
    ...(lights ? { lights } : {}),
  };
}

export function validateTemplate(data, { op } = {}) {
  const stored = op === "update";
  const out = shape(data, {
    name: (v, f) => str(v, { field: f, max: 80, required: true }),
    summary: (v, f) => str(v, { field: f, max: 140 }) || "",
    kind: (v, f) => enumValue(v, TEMPLATE_KINDS, { field: f, stored }) || "one_time",
    sort: (v, f) => int(v, { field: f, min: 0, max: 100000 }) ?? 1000,
    archived: (v, f) => bool(v, { field: f }),
    client_notes: (v, f) => str(v, { field: f, max: 4000, trim: false }) || "",
    internal_notes: (v, f) => str(v, { field: f, max: 4000, trim: false }) || "",
    options: (v, f) => {
      const list = arr(v, (o, of) => validateTplOption(o, of), { field: f, max: MAX_OPTIONS });
      if (!list.length) throw new InputError("A template needs at least one option.", f);
      if (!list.some((o) => o.recommended)) list[0].recommended = true;
      return list;
    },
    seed_key: (v, f) => (v === undefined || v === null || v === "" ? undefined : DEF_KEY_RE.test(String(v)) ? String(v) : (() => { throw new InputError("That isn't a key.", f); })()),
    from_quote_id: (v, f) => (v === undefined || v === null || v === "" ? undefined : isId(v, "quote") ? v : (() => { throw new InputError("That isn't a quote.", f); })()),
  });
  return out;
}

export const templateRow = (r) => ({ nm: r.name, sm: r.summary || "", k: r.kind, so: Number.isSafeInteger(r.sort) ? r.sort : 1000, ar: !!r.archived, n: (r.options || []).length });

export const templateType = defineType({
  type: "quote_template",
  prefix: "et",
  v: 1,
  validate: validateTemplate,
  rotorFields: [],
  techFields: ["id", "name"],
  readPerm: "quotes:read",
  shadow: false,
  indexes: [{ name: "quote-templates", shard: (r) => (r.deleted_at ? null : ""), row: templateRow }],
  summary: (r) => ({ id: r.id, name: r.name }),
  example: () => ({ name: "Exterior windows", summary: "Outside glass, sills and frames.", kind: "one_time", sort: 10, archived: false, client_notes: "", internal_notes: "", options: [{ name: "One-time", kind: "one_time", recommended: true, items: [{ key: "exterior" }], discounts: [] }] }),
});

// ------------------------------------------------------------ the seeded templates (seed v3)

const LIGHTS_ON = { early_bird: true, three_year: false, colors: ["warm_white"] };
const ROOF = [{ key: "lights_install", from: "roofline_ft", note: "Roofline" }, { key: "lights_materials", from: "roofline_ft", note: "Roofline" }];
const LIGHTS_TAIL = [{ key: "lights_takedown" }, { key: "lights_warranty" }];
const ext = { key: "exterior" };
const int_ = { key: "interior" };

export const SEED_TEMPLATES = Object.freeze([
  { seed_key: "exterior", sort: 10, kind: "one_time", name: "Exterior windows", summary: "Outside glass, sills and frames, priced by the pane count.", options: [{ name: "Exterior windows", kind: "one_time", recommended: true, items: [ext] }] },
  { seed_key: "int_ext", sort: 20, kind: "one_time", name: "Interior + exterior windows", summary: "Inside and outside glass, priced by the pane counts.", options: [{ name: "Inside and out", kind: "one_time", recommended: true, items: [ext, int_] }] },
  { seed_key: "ext_screens_tracks", sort: 30, kind: "one_time", name: "Exterior windows + screens + tracks", summary: "Outside glass, every screen washed and the tracks detailed.", options: [{ name: "Exterior, screens and tracks", kind: "one_time", recommended: true, items: [ext, { key: "screens", from: "screens" }, { key: "tracks_standard", from: "tracks" }] }] },
  { seed_key: "quarterly", sort: 40, kind: "plan", name: "Quarterly plan (3 exterior + 1 interior)", summary: "Four visits a year: outside three times, inside once. Next to a one-time clean.", options: [
    { name: "Quarterly plan", kind: "plan", plan_key: "quarterly", recommended: true, items: [ext, int_] },
    { name: "One-time, inside and out", kind: "one_time", items: [ext, int_] },
  ] },
  { seed_key: "biannual", sort: 50, kind: "plan", name: "Biannual plan", summary: "Spring and fall exterior visits, next to a one-time clean.", options: [
    { name: "Biannual plan", kind: "plan", plan_key: "biannual", recommended: true, items: [ext] },
    { name: "One-time exterior", kind: "one_time", items: [ext] },
  ] },
  { seed_key: "gutters", sort: 60, kind: "one_time", name: "Gutter cleaning", summary: "Gutters cleared by hand and downspouts flushed. Priced on the quote.", client_notes: "We send photos of anything on the roof or gutters that needs attention.", options: [{ name: "Gutter cleaning", kind: "one_time", recommended: true, items: [{ key: "gutters" }] }] },
  { seed_key: "windows_gutters", sort: 70, kind: "one_time", name: "Windows + gutters", summary: "Exterior windows and gutters in one visit, with the package discount.", options: [{ name: "Windows and gutters", kind: "one_time", recommended: true, items: [ext, { key: "gutters" }], discounts: [{ key: "package" }] }] },
  { seed_key: "lights_roofline", sort: 80, kind: "lights", name: "Christmas lights: roofline", summary: "C9 lights on the roofline by the foot, every season or this season only.", options: [
    { name: "Christmas lights, every season", kind: "plan", plan_key: "lights_annual", recommended: true, items: [...ROOF, ...LIGHTS_TAIL], lights: LIGHTS_ON },
    { name: "Christmas lights, this season", kind: "one_time", items: [...ROOF, ...LIGHTS_TAIL], lights: LIGHTS_ON },
  ] },
  { seed_key: "lights_roof_bushes", sort: 90, kind: "lights", name: "Christmas lights: roofline + bushes/trees", summary: "The roofline plus the bushes and trees out front, by the foot.", options: [
    { name: "Christmas lights, every season", kind: "plan", plan_key: "lights_annual", recommended: true, items: [...ROOF, { key: "lights_install", note: "Bushes and trees" }, { key: "lights_materials", note: "Bushes and trees" }, ...LIGHTS_TAIL], lights: LIGHTS_ON },
  ] },
  { seed_key: "lights_takedown", sort: 100, kind: "lights", name: "Lights takedown + storage", summary: "Lights someone else put up: taken down and kept in our shop. Priced on the quote.", options: [
    { name: "Takedown and storage", kind: "one_time", recommended: true, items: [{ title: "Takedown and Storage", description: "We take your lights down after the season and store them in our shop, in your own bin, ready for next year.", note: "" }] },
  ] },
]);

export const seedTemplateId = (key) => deriveId("quote_template", "seed:quotes", "templates", key);

// system.seed v3: the templates above, once each (an owner's edits and archives are never touched).
export async function seedEstimateTemplates(sctx = {}) {
  const ctx = typeof sctx.write === "function" ? sctx.write() : sctx;
  let made = 0;
  for (const t of SEED_TEMPLATES) {
    const id = seedTemplateId(t.seed_key);
    if (await getRecord("quote_template", id)) continue;
    try { await createRecord("quote_template", { ...JSON.parse(JSON.stringify(t)), id, archived: false, client_notes: t.client_notes || "", internal_notes: "" }, ctx); made += 1; } catch (e) {
      if (!(e instanceof ExistsError)) throw e;
    }
  }
  return { made };
}

// ------------------------------------------------------------ applying a template

const feet = (m) => (m % 1000 === 0 ? String(m / 1000) : (m / 1000).toFixed(1));
const colorText = (colors) => (colors || []).filter((c) => Object.hasOwn(COLORS, c)).map((c) => COLORS[c]).join(", ");

// The counts a property gives a template: { panes_ext, panes_int, screens, tracks, tracks_premium, roofline_ft, gutter_ft, sqft }.
export function countsOf(property) {
  const a = (property && isObj(property.assets) && property.assets) || {};
  const out = {};
  for (const k of [...QTY_FROM, "sqft"]) if (posInt(a[k])) out[k] = a[k];
  if (!out.roofline_ft && property && isObj(property.lights) && posInt(Math.round(Number(property.lights.total_ft) || 0))) out.roofline_ft = Math.round(property.lights.total_ft);
  return out;
}

// One template → the New Quote form's options, priced from today's price
// book. Pure: book and defs as priceBook() / discountDefs() give them.
// → { options: [{ id?, name, kind, recommended, plan?, lines, discounts }], client_notes, internal_notes, warnings }
export function applyTemplate(tpl, { pricing = {}, book = [], defs = [], counts = {}, today = "2026-01-01", lineId = newLineId } = {}) {
  const warnings = new Set();
  const panesFromSqft = () => { if (!posInt(counts.sqft)) return 0; const t = tierFromSqft(counts.sqft, pricing); return t.manual ? 0 : t.pane_estimate; };
  const panesExt = posInt(counts.panes_ext) || panesFromSqft();
  if (!posInt(counts.panes_ext) && panesExt) warnings.add("confirm_panes_on_site");
  const panesInt = posInt(counts.panes_int) || panesExt;
  const byKey = (k) => book.find((i) => i && i.active !== false && i.key === k) || null;
  const byId = (id) => book.find((i) => i && i.id === id) || null;
  const options = [];
  for (const o of tpl.options || []) {
    const planKey = o.kind === "plan" ? o.plan_key : null;
    const lightsCfg = o.lights || null;
    const lines = [];
    for (const it of o.items || []) {
      const item = (it.price_item_id && byId(it.price_item_id)) || (it.key && byKey(it.key)) || null;
      if (!item && !it.title) { warnings.add("missing_item"); continue; }
      if (item && item.active === false) { warnings.add("missing_item"); continue; }
      const base = {
        id: lineId(), ...(item ? { price_item_id: item.id } : {}), title: it.title || (item && item.name) || "Line item",
        description: it.description ?? ((item && item.show && item.show.description !== false && item.description) || ""),
        category: (item && item.category) || "other", unit: (item && item.unit) || "flat", service_type: (item && item.service_type) || undefined,
        scope: { type: "all" }, show: (item && item.show) || { qty: false, unit: false, description: true },
      };
      if (!base.service_type) delete base.service_type;
      if (it.optional) { base.optional = true; base.selected = false; }
      const engine = item && item.engine;
      if (engine === "exterior_tiers") {
        const ex = panesExt ? exteriorCents(panesExt, pricing) : null;
        if (ex && !ex.manual) Object.assign(base, { qty_milli: 1000, unit_cents: ex.cents, engine_cents: ex.cents, tier: ex.tier });
        else { Object.assign(base, { qty_milli: 1000, unit_cents: 0 }); warnings.add(ex ? "over_100_panes" : "count_panes"); }
      } else if (engine === "interior_segments") {
        const inn = panesInt ? interiorCents(panesInt, pricing) : null;
        if (inn && !inn.manual) Object.assign(base, { qty_milli: 1000, unit_cents: inn.cents, engine_cents: inn.cents, tier: inn.tier });
        else { Object.assign(base, { qty_milli: 1000, unit_cents: 0 }); warnings.add(inn ? "over_100_panes_interior" : "count_panes"); }
      } else {
        const unit = Number.isSafeInteger(it.unit_cents) ? it.unit_cents
          : item && Number.isSafeInteger(item.unit_cents) && item.unit_cents > 0 ? item.unit_cents
            : item && item.key ? addOnUnit(book, item.key, pricing) : 0;
        const fromCount = it.from ? posInt(counts[it.from]) : 0;
        const perUnit = base.unit !== "flat";
        const qty = fromCount ? fromCount * 1000 : Number.isSafeInteger(it.qty_milli) ? it.qty_milli : perUnit ? 0 : 1000;
        if (it.from && !fromCount) warnings.add(it.from === "roofline_ft" ? "measure_lights" : it.from === "screens" ? "count_screens_on_site" : it.from === "tracks" || it.from === "tracks_premium" ? "count_tracks" : "count_on_site");
        if (perUnit && !qty && !it.from) warnings.add(base.category === "lights" ? "measure_lights" : "count_on_site");
        Object.assign(base, { qty_milli: qty, unit_cents: unit });
        if (item && ["lights_install_ft", "lights_materials_ft"].includes(engine) && qty > 0) base.engine_cents = Math.round((qty * unit) / 1000);
        if (!unit && !(item && item.category === "lights" && item.unit === "flat" && item.key !== "lights_package") && base.category !== "warranty") {
          warnings.add(base.category === "gutters" ? "price_gutters" : "set_price");
        }
        if (base.category === "lights" && base.unit === "ft") {
          const bits = [it.note ? `${it.note}${qty ? ` ${feet(qty)} ft` : ""}` : "", lightsCfg && colorText(lightsCfg.colors) ? `Colors: ${colorText(lightsCfg.colors)}` : ""].filter(Boolean);
          if (engine === "lights_install_ft" || it.note) base.description = bits.join(". ") || base.description;
        }
      }
      base.total_cents = lineTotal(base);
      lines.push(base);
    }
    // the plan scopes (as suggestOption): Quarterly exterior on 1, 3, 4 and interior on 2; add-ons the first visit
    if (planKey === "quarterly") {
      for (const l of lines) {
        if (l.category === "windows_ext") l.scope = { type: "specific", visits: [1, 3, 4] };
        if (l.category === "windows_int") l.scope = { type: "specific", visits: [2] };
      }
    }
    if (planKey && planKey !== "lights_annual") for (const l of lines) if (ADDON_CATEGORIES.includes(l.category)) l.scope = { type: "initial" };
    const discounts = [];
    let n = 0;
    const did = (k) => `dc_${String(k).replace(/[^a-z0-9_]/g, "").slice(0, 20) || "d"}_${++n}${lineId().slice(3, 8)}`;
    if (planKey && planKey !== "lights_annual" && planKey !== "custom") {
      const d = planDiscountFor(planKey, pricing, defs);
      if (d) discounts.push({ ...d, id: did(d.key) });
    }
    if (lightsCfg) {
      if (lightsCfg.early_bird && !earlyBirdDeadline(today, pricing)) warnings.add("early_bird_over");
      for (const d of lightsDiscounts({ early_bird: lightsCfg.early_bird, three_year: lightsCfg.three_year && planKey === "lights_annual", on: today }, pricing, defs)) discounts.push({ ...d, id: did(d.key) });
    }
    for (const d of o.discounts || []) {
      if (d.key) {
        const def = defs.find((x) => x && x.key === d.key && x.active !== false);
        if (!def) { warnings.add("missing_discount"); continue; }
        if (def.plan_only && def.plan_only !== planKey) continue;
        if (def.stack_group && discounts.some((x) => x.stack_group === def.stack_group)) continue;
        if (discounts.some((x) => x.key === def.key)) continue;
        discounts.push({ id: did(def.key), def_id: def.id, key: def.key, name: def.name, type: def.type, value: def.value || 0, scope: def.default_scope || { type: "all" }, ...(def.stack_group ? { stack_group: def.stack_group } : {}) });
      } else discounts.push({ id: did("custom"), name: d.name, type: d.type, value: d.value, scope: { type: "all" } });
    }
    const out = { name: o.name, kind: o.kind, recommended: !!o.recommended, lines, discounts };
    if (planKey) {
      const cat = PLAN_CATALOG[planKey];
      const lights = planKey === "lights_annual";
      out.plan = { catalog_key: planKey, frequency: { ...cat.frequency }, visits_per_year: cat.visits_per_year, term_months: lights && lightsCfg && lightsCfg.three_year ? 36 : cat.term_months, billing: lights ? "after_visit" : "barta_standard", autopay: !lights, auto_renew: true };
    }
    options.push(out);
  }
  if (!options.some((o) => o.recommended) && options.length) options[0].recommended = true;
  return { options, client_notes: tpl.client_notes || "", internal_notes: tpl.internal_notes || "", warnings: [...warnings] };
}

// ------------------------------------------------------------ a quote as a template

// The quote's options → template options: price-book lines by reference
// (engine lines re-priced when used; counted lines from the property's
// counts), hand-made lines with their name and price, the catalog's
// discounts by key (the plan discount and the lights offers come back by
// themselves), typed ones as they are.
export function templateFromQuote(quote, book = []) {
  const byId = (id) => book.find((i) => i && i.id === id) || null;
  const FROM = { screens: "screens", tracks: null, windows_ext: null, windows_int: null };
  const options = (quote.options || []).slice(0, MAX_OPTIONS).map((o) => {
    const planKey = o.kind === "plan" && o.plan && TEMPLATE_PLANS.includes(o.plan.catalog_key) ? o.plan.catalog_key : null;
    const lightsLines = (o.lines || []).some((l) => l.category === "lights");
    const items = (o.lines || []).slice(0, MAX_LINES).map((l) => {
      const item = l.price_item_id ? byId(l.price_item_id) : null;
      const it = {};
      if (item) { it.price_item_id = item.id; if (item.key) it.key = item.key; } else it.title = String(l.title || "Line item").slice(0, 160);
      if (item && l.title && l.title !== item.name) it.title = String(l.title).slice(0, 160);
      const engine = item && item.engine;
      if (engine === "exterior_tiers" || engine === "interior_segments") return it;
      if (l.category === "lights" && l.unit === "ft") { it.from = "roofline_ft"; return it; }
      if (l.category === "screens") it.from = "screens";
      else if (l.category === "tracks") it.from = item && /premium/i.test(item.name || "") ? "tracks_premium" : "tracks";
      else if (FROM[l.category] === undefined && Number.isSafeInteger(l.qty_milli) && l.qty_milli !== 1000) it.qty_milli = l.qty_milli;
      const priced = item && Number.isSafeInteger(item.unit_cents) && item.unit_cents > 0;
      if (!priced && Number.isSafeInteger(l.unit_cents) && l.unit_cents > 0) it.unit_cents = l.unit_cents;
      if (!item && l.description) it.description = String(l.description).slice(0, 2000);
      if (l.optional) it.optional = true;
      return it;
    });
    const discounts = [];
    const lights = lightsLines ? { early_bird: false, three_year: false, colors: ["warm_white"] } : null;
    for (const d of (o.discounts || []).slice(0, MAX_DISCOUNTS)) {
      if (d.stack_group === "plan" || /^plan_/.test(d.key || "")) continue;
      if (lights && d.key === "early_bird") { lights.early_bird = true; continue; }
      if (lights && d.key === "three_year") { if (planKey === "lights_annual") lights.three_year = true; continue; }
      if (d.key && DEF_KEY_RE.test(d.key)) discounts.push({ key: d.key });
      else if (d.type && Number.isSafeInteger(d.value) && d.value > 0) discounts.push({ name: String(d.name || "Discount").slice(0, 80), type: d.type, value: d.value });
    }
    return { name: String(o.name || "Option").slice(0, 80), kind: planKey ? "plan" : "one_time", ...(planKey ? { plan_key: planKey } : {}), recommended: !!o.recommended, items, discounts, ...(lights ? { lights } : {}) };
  }).filter((o) => o.items.length);
  const kind = options.some((o) => o.lights) ? "lights" : options.some((o) => o.kind === "plan") ? "plan" : "one_time";
  return { kind, options, client_notes: String(quote.client_notes || "").slice(0, 4000) };
}

// ------------------------------------------------------------ routes

const R = (method, path, perm, subject, handler, extra = {}) => ({ method, path, auth: "session", perm, subject, mode: "inline", handler, ...extra });
const FIELDS = ["name", "summary", "kind", "client_notes", "internal_notes", "options", "archived", "sort"];
const pick = (o) => Object.fromEntries(FIELDS.filter((k) => o && o[k] !== undefined).map((k) => [k, o[k]]));

async function listRoute(ctx) {
  const all = ctx.query.get("archived") === "1";
  const ix = await readIndex("quote-templates", "");
  const rows = ix.rows.filter((r) => all || !r.ar).map((r) => ({ id: r.id, name: r.nm, summary: r.sm, kind: r.k, sort: r.so, archived: r.ar, options: r.n }))
    .sort((a, b) => Number(a.archived) - Number(b.archived) || a.sort - b.sort || a.name.localeCompare(b.name));
  return { data: rows, meta: { total: rows.length } };
}

async function load(id) {
  const g = isId(id, "quote_template") ? await getRecord("quote_template", id) : null;
  if (!g || g.data.deleted_at) throw new NotFoundError("That template isn't there.");
  return g;
}

async function getRoute(ctx) {
  const g = await load(ctx.params.id);
  return { data: strip(g.data), etag: g.etag };
}

async function nextSort() {
  const ix = await readIndex("quote-templates", "");
  if (ix.rows.length >= MAX_TEMPLATES) throw new InputError(`Keep it to ${MAX_TEMPLATES} templates. Archive one you don't use.`, "name");
  return ix.rows.reduce((m, r) => Math.max(m, Number.isSafeInteger(r.so) ? r.so : 0), 0) + 10;
}

async function createRoute(ctx) {
  const b = ctx.body || {};
  let body = pick(b);
  if (b.from_quote_id) {
    if (!isId(b.from_quote_id, "quote")) throw new InputError("That isn't a quote.", "from_quote_id");
    const q = await getRecord("quote", b.from_quote_id);
    if (!q || q.data.deleted_at) throw new NotFoundError("That quote isn't there.");
    const made = templateFromQuote(q.data, await priceBook());
    if (!made.options.length) throw new InputError("This quote has no line items to keep.", "options");
    body = { ...made, ...body, options: made.options, from_quote_id: q.data.id };
  }
  const r = await createRecord("quote_template", { archived: false, ...body, sort: await nextSort() }, ctx.write());
  return { data: strip(r.data), etag: r.etag, status: 201 };
}

async function patchRoute(ctx) {
  await load(ctx.params.id);
  const r = await patchRecord("quote_template", ctx.params.id, pick(ctx.body), { ...ctx.write(), ifMatch: ctx.ifMatch });
  return { data: strip(r.data), etag: r.etag };
}

async function reorderRoute(ctx) {
  const ids = Array.isArray(ctx.body && ctx.body.ids) ? ctx.body.ids : null;
  if (!ids || !ids.length || ids.length > MAX_TEMPLATES || ids.some((id) => !isId(id, "quote_template")) || new Set(ids).size !== ids.length) throw new InputError("Send the templates in their new order.", "ids");
  const got = await getRecords("quote_template", ids);
  if (got.some((g) => !g || g.data.deleted_at)) throw new NotFoundError("A template in that list isn't there.");
  let moved = 0;
  for (const [i, id] of ids.entries()) {
    const sort = (i + 1) * 10;
    const r = await updateRecord("quote_template", id, (t) => (t.sort === sort ? null : { ...t, sort }), ctx.write());
    if (r.changed !== false) moved += 1;
  }
  return { data: { moved } };
}

async function applyRoute(ctx) {
  const g = await load(ctx.params.id);
  const b = ctx.body || {};
  let property = null;
  if (b.property_id !== undefined && b.property_id !== null && b.property_id !== "") {
    if (!isId(b.property_id, "property")) throw new InputError("That isn't a property.", "property_id");
    const p = await getRecord("property", b.property_id);
    if (p && !p.data.deleted_at) property = p.data;
  }
  const [pricing, book, defs] = await Promise.all([loadPricing(), priceBook(), discountDefs()]);
  const counts = countsOf(property);
  const out = applyTemplate(g.data, { pricing, book, defs, counts, today: localDate(now()) });
  return { data: { template: { id: g.data.id, name: g.data.name, kind: g.data.kind }, ...out, counts } };
}

export const templateRoutes = [
  R("GET", "/quote-templates", "quotes:read", "none", listRoute),
  R("GET", "/quote-templates/:id", "quotes:read", "required", getRoute),
  R("POST", "/quote-templates", "settings:general", "none", createRoute, { maxCalls: 40 }),
  R("PATCH", "/quote-templates/:id", "settings:general", "required", patchRoute, { maxCalls: 40 }),
  R("POST", "/quote-templates/reorder", "settings:general", "none", reorderRoute, { maxCalls: 260, budgetMs: 9000 }),
  R("POST", "/quote-templates/:id/apply", "quotes:write", "required", applyRoute),
];

export { isPlainObject };
