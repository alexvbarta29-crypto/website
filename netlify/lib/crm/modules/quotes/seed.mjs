// Quotes module: the seeded price book and discount catalog (design §5.3,
// §11.1 rule 6; barta-rules §1; decisions D15, D26, D30, D40) and the quote
// templates. Written once by system.seed (op/seed--quotes--v1, onlyIfNew
// per record), so a re-deploy never duplicates and an owner's edits are
// never overwritten. Ids derive from the seed key: the import (§10.2 rows
// 4-5) finds the same records whatever order things run in.
//
// Contradictions settled here (recorded in docs/CRM-QUOTES.md):
//   - standard track detailing $5 per track, premium $15 (the owner, Nov 12;
//     the first seed had D26's $8: seed v2 below moves an untouched one),
//   - exterior 41-60 panes $395, not MiNT's $345 (barta-rules §1.1),
//   - Interior (Upper Level) $12 per pane as its own item (D26),
//   - soft washing, pressure washing, solar and commercial cleaning kept
//     inactive for history (D40), Card Fee kept inactive (D32: no surcharge),
//   - lights storage is "included in your price", never called a free perk.

import { createRecord, getRecord, updateRecord, getRaw, putSetting, claimMarker, advanceMarker } from "../../../crm-store.mjs";
import { deriveId } from "../../core/ids.mjs";
import { ExistsError, StaleError } from "../../core/errors.mjs";
import { notify, approvers } from "../../core/notify.mjs";

const SHOW_FLAT = { qty: false, unit: false, description: true };
const SHOW_UNIT = { qty: true, unit: true, description: true };

// key → the price item (unit_cents 0 for engine-priced and hand-priced items).
export const SEED_PRICE_BOOK = Object.freeze([
  { key: "exterior", name: "Exterior Window Cleaning", category: "windows_ext", service_type: "Residential Window Cleaning", unit: "flat", unit_cents: 0, engine: "exterior_tiers", description: "Exterior glass hand-cleaned and squeegeed, sills and frames wiped down, water-fed pole for second-story glass.", show: SHOW_FLAT, active: true, sellable: true },
  { key: "interior", name: "Interior Window Cleaning", category: "windows_int", service_type: "Residential Window Cleaning", unit: "flat", unit_cents: 0, engine: "interior_segments", description: "Interior glass hand-cleaned and squeegeed, sills and frames wiped down, drop cloths to protect your floors.", show: SHOW_FLAT, active: true, sellable: true },
  { key: "interior_upper", name: "Interior (Upper Level)", category: "windows_int", service_type: "Residential Window Cleaning", unit: "pane", unit_cents: 1200, engine: "manual", description: "Upper-level interior panes.", show: SHOW_UNIT, active: true, sellable: true },
  { key: "screens", name: "Screen Cleaning", category: "screens", service_type: "Residential Window Cleaning", unit: "screen", unit_cents: 500, description: "Screens removed, hand-washed, dried and put back in the right window. Torn screens aren't cleaned.", show: SHOW_UNIT, active: true, sellable: true },
  { key: "tracks_standard", name: "Track Detailing", category: "tracks", service_type: "Residential Window Cleaning", unit: "track", unit_cents: 500, description: "A quick clean: tracks brushed, vacuumed and wiped if they need it.", show: SHOW_UNIT, active: true, sellable: true },
  { key: "tracks_premium", name: "Premium Track Detailing", category: "tracks", service_type: "Residential Window Cleaning", unit: "track", unit_cents: 1500, description: "A deep clean: tracks scrubbed with a soap solution and a deep scrub brush, wet/dry vacuumed and wiped.", show: SHOW_UNIT, active: true, sellable: true },
  { key: "hard_water", name: "Hard Water Spot Treatment", category: "other", service_type: "Residential Window Cleaning", unit: "flat", unit_cents: 0, engine: "manual", description: "Hard-water spots treated on the glass.", show: SHOW_FLAT, active: true, sellable: true },
  { key: "gutters", name: "Gutter Cleaning", category: "gutters", service_type: "Exterior Cleaning", unit: "flat", unit_cents: 0, engine: "manual", description: "Gutters cleared by hand, downspouts flushed and tested, a free look at the roof and gutters with photos of anything that needs attention.", show: SHOW_FLAT, active: true, sellable: true },
  { key: "lights_install", name: "Christmas Light Installation", category: "lights", service_type: "Christmas Lights", unit: "ft", unit_cents: 800, engine: "lights_install_ft", description: "", show: SHOW_UNIT, active: true, sellable: true },
  { key: "lights_materials", name: "Christmas Light Materials", category: "lights", service_type: "Christmas Lights", unit: "ft", unit_cents: 200, engine: "lights_materials_ft", description: "Commercial-grade C9 LED bulbs on a dark green strand.", show: SHOW_UNIT, active: true, sellable: true },
  { key: "lights_package", name: "Christmas Lights", category: "lights", service_type: "Christmas Lights", unit: "flat", unit_cents: 0, engine: "manual", description: "Lights, installation, takedown and storage.", show: SHOW_FLAT, active: true, sellable: true },
  { key: "lights_takedown", name: "Takedown and Storage", category: "lights", service_type: "Christmas Lights", unit: "flat", unit_cents: 0, description: "We take them down after the season and store them in our shop, in your own bin. Included in your price.", show: SHOW_FLAT, active: true, sellable: true },
  { key: "lights_warranty", name: "In-Season Material Warranty", category: "warranty", service_type: "Christmas Lights", unit: "flat", unit_cents: 0, description: "Burnt-out bulbs and loose clips fixed free all season.", show: SHOW_FLAT, active: true, sellable: true },
  { key: "service_call", name: "Service", category: "other", service_type: "Residential Window Cleaning", unit: "flat", unit_cents: 0, engine: "manual", description: "", show: SHOW_FLAT, active: true, sellable: true },
  // kept for history (dropped services, D40; the card fee, D32)
  { key: "soft_wash", name: "Soft Washing", category: "other", service_type: "Exterior Cleaning", unit: "flat", unit_cents: 0, engine: "manual", description: "", show: SHOW_FLAT, active: false, sellable: false },
  { key: "pressure_wash", name: "Pressure Washing", category: "other", service_type: "Exterior Cleaning", unit: "flat", unit_cents: 0, engine: "manual", description: "", show: SHOW_FLAT, active: false, sellable: false },
  { key: "house_wash", name: "House Wash", category: "other", service_type: "Exterior Cleaning", unit: "flat", unit_cents: 0, engine: "manual", description: "", show: SHOW_FLAT, active: false, sellable: false },
  { key: "solar", name: "Solar Panel Cleaning", category: "other", service_type: "Exterior Cleaning", unit: "flat", unit_cents: 0, engine: "manual", description: "", show: SHOW_FLAT, active: false, sellable: false },
  { key: "commercial", name: "Commercial Cleaning", category: "other", service_type: "Exterior Cleaning", unit: "flat", unit_cents: 0, engine: "manual", description: "", show: SHOW_FLAT, active: false, sellable: false },
  { key: "junk_removal", name: "Junk Removal", category: "other", service_type: "Exterior Cleaning", unit: "flat", unit_cents: 0, engine: "manual", description: "", show: SHOW_FLAT, active: false, sellable: false },
  { key: "card_fee", name: "Card Fee", category: "fee", service_type: "Residential Window Cleaning", unit: "flat", unit_cents: 0, engine: "manual", description: "", show: SHOW_FLAT, active: false, sellable: false },
]);

// D15: every discount name seen in Rotor is imported; the sellable ones are
// these. Different discounts stack, never below $0, percentages before fixed
// amounts; the plan discounts share one stack group.
export const SEED_DISCOUNTS = Object.freeze([
  { key: "first_time", name: "First Time Customer", type: "fixed", value: 5000, default_scope: { type: "initial" }, sellable: true, rotor_names: ["First Time Customer", "First Time Customer Discount", "First time customer discount", "1st Time Customer"] },
  { key: "package", name: "Package Discount", type: "fixed", value: 5000, default_scope: { type: "all" }, sellable: true, rotor_names: ["Package Discount", "Package Deal"] },
  { key: "followup_50", name: "Estimate follow-up", type: "fixed", value: 5000, default_scope: { type: "initial" }, sellable: true, offer: true, rotor_names: ["Estimate follow-up", "Follow-up Discount", "Follow Up Discount"] },
  { key: "ten_free_screens", name: "10 free screens", type: "fixed", value: 5000, default_scope: { type: "initial" }, sellable: true, offer: true, rotor_names: ["10 Free Screens", "Free Screens"] },
  { key: "plan_biannual", name: "Biannual plan discount", type: "fixed", value: 5000, default_scope: { type: "all" }, sellable: true, plan_only: "biannual", stack_group: "plan", rotor_names: ["Bi-Annual Discount", "Bi-Annuall Discount", "Bi-Annuall", "Biannual Discount", "Semi-Annual Discount"] },
  { key: "plan_quarterly", name: "Quarterly plan discount", type: "fixed", value: 10000, default_scope: { type: "all" }, sellable: true, plan_only: "quarterly", stack_group: "plan", rotor_names: ["Quarterly Discount"] },
  { key: "plan_monthly", name: "Monthly plan discount", type: "fixed", value: 15000, default_scope: { type: "all" }, sellable: true, plan_only: "monthly", stack_group: "plan", rotor_names: ["Monthly Discount"] },
  // lights: both count every season (the owner, Nov 12), the 3-year contract is $200 off
  { key: "early_bird", name: "Early Bird", type: "percentage", value: 5000, default_scope: { type: "all" }, sellable: true, rotor_names: ["EARLY Bird Discount", "Early Bird Discount", "Early Bird", "Early Brid", "Early Brid Discount"] },
  { key: "three_year", name: "3-year contract", type: "fixed", value: 20000, default_scope: { type: "all" }, sellable: true, rotor_names: ["3-Year Contract", "3 Year Contract", "3 Year Contract Discount"] },
  { key: "google_review", name: "Google Review & Local Post", type: "fixed", value: 5000, default_scope: { type: "initial" }, sellable: true, rotor_names: ["Google Review & Local Post", "Google Review"] },
  { key: "service_offer", name: "Service Offer", type: "fixed", value: 5000, default_scope: { type: "initial" }, sellable: true, rotor_names: ["Service Offer"] },
  { key: "price_match", name: "Price match", type: "fixed", value: 0, default_scope: { type: "initial" }, sellable: true, typed_amount: true, rotor_names: ["Price match discount", "Price Match"] },
  // not sellable (history and import matching)
  { key: "five_year", name: "5-Year Contract", type: "fixed", value: 20000, default_scope: { type: "all" }, sellable: false, rotor_names: ["5-Year Contract", "5 Year Contract"] },
  { key: "referral_credit", name: "Referral Credit", type: "fixed", value: 5000, default_scope: { type: "initial" }, sellable: false, rotor_names: ["Referral Credit"] },
  { key: "gift_card", name: "Gift Card", type: "fixed", value: 0, default_scope: { type: "initial" }, sellable: false, rotor_names: ["Gift Card"] },
  { key: "discount", name: "Discount", type: "fixed", value: 5000, default_scope: { type: "all" }, sellable: false, rotor_names: ["Discount"] },
]);

export const seedItemId = (key) => deriveId("price_item", "seed:quotes", "pricebook", key);
export const seedDiscountId = (key) => deriveId("discount_def", "seed:quotes", "discounts", key);

export const seedItem = (key) => { const s = SEED_PRICE_BOOK.find((i) => i.key === key); return s ? { ...JSON.parse(JSON.stringify(s)), id: seedItemId(key), rotor_template_ids: [] } : null; };
export const seedDiscount = (key) => {
  const s = SEED_DISCOUNTS.find((d) => d.key === key);
  if (!s) return null;
  const { type, ...rest } = JSON.parse(JSON.stringify(s));
  return { ...rest, kind: type, id: seedDiscountId(key) };
};

async function once(type, data, ctx) {
  try { await createRecord(type, data, ctx); return 1; } catch (e) {
    if (e instanceof ExistsError) return 0;
    throw e;
  }
}

// system.seed v1: the price book and the discount catalog, once each.
export async function seedPriceBook(sctx = {}) {
  const ctx = typeof sctx.write === "function" ? sctx.write() : sctx;
  let made = 0;
  for (const s of SEED_PRICE_BOOK) {
    if (await getRecord("price_item", seedItemId(s.key))) continue;
    made += await once("price_item", seedItem(s.key), ctx);
  }
  for (const s of SEED_DISCOUNTS) {
    if (await getRecord("discount_def", seedDiscountId(s.key))) continue;
    made += await once("discount_def", seedDiscount(s.key), ctx);
  }
  return { made };
}

// ------------------------------------------------------------ seed v2: the owner's answers (Nov 12)

// What the first seed wrote, field by field, for the values the owner's
// answers changed: standard tracks $8 → $5 (and both track descriptions),
// Early Bird and the 3-year contract every season, the 3-year $100 → $200.
// The new values are the seed's own (SEED_PRICE_BOOK, SEED_DISCOUNTS).
export const V1_ITEMS = Object.freeze({
  tracks_standard: { unit_cents: 800, description: "Tracks brushed and vacuumed." },
  tracks_premium: { description: "Tracks brushed, vacuumed, wet-scrubbed, vacuumed again and wiped." },
});
export const V1_DISCOUNTS = Object.freeze({
  early_bird: { default_scope: { type: "initial" } },
  three_year: { value: 10000, default_scope: { type: "initial" } },
});
// cfg/pricing: the stored copies of the defaults (a saved pricing page holds them all).
export const V1_PRICING = Object.freeze([
  { path: ["tracks", "standard_cents"], from: 800, to: 500, label: "Standard track detailing (the fallback price)", money: true },
  { path: ["lights", "three_year_off_cents"], from: 10000, to: 20000, label: "3-year lights contract, off each season", money: true },
]);

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const dollars = (c) => `$${(c / 100).toFixed(2)}`;
const at = (o, path) => path.reduce((x, k) => (x && typeof x === "object" ? x[k] : undefined), o);
const setAt = (o, path, v) => { const out = JSON.parse(JSON.stringify(o)); let x = out; for (const k of path.slice(0, -1)) { if (!x[k] || typeof x[k] !== "object") x[k] = {}; x = x[k]; } x[path[path.length - 1]] = v; return out; };

// One seeded record: each listed field moves to the seed's new value only
// while it still holds the old seeded one (CAS: re-checked on the write).
// A field someone changed stays theirs and is reported as kept.
async function upgradeFields(type, id, olds, now, ctx, out, label) {
  const g = await getRecord(type, id);
  if (!g || g.data.deleted_at) return;
  const changed = [];
  for (const [f, old] of Object.entries(olds)) {
    if (same(g.data[f], now[f])) continue;                 // already the new value (an owner set it, or a second run)
    if (same(g.data[f], old)) changed.push(f);
    else out.kept.push({ what: label, field: f, suggested: f === "unit_cents" || f === "value" ? dollars(now[f]) : f === "default_scope" ? "every season" : "new wording" });
  }
  if (!changed.length) return;
  const r = await updateRecord(type, id, (x) => {
    const fields = changed.filter((f) => same(x[f], olds[f]));
    return fields.length ? { ...x, ...Object.fromEntries(fields.map((f) => [f, JSON.parse(JSON.stringify(now[f]))])) } : null;
  }, ctx);
  if (r.changed) out.upgraded.push(`${label}: ${changed.join(", ")}`);
}

// cfg/pricing: only a saved page holds these (an unsaved one reads the new
// defaults by itself). A value still equal to the old default moves; one an
// owner typed stays. Written with putSetting (validated, audited with a diff).
async function upgradePricing(ctx, out) {
  for (let i = 0; i < 3; i++) {
    const cur = await getRaw("cfg/pricing");
    if (!cur || !cur.data) return;
    const { _w, updated_at, updated_by, ...stored } = cur.data;
    let next = stored;
    const moved = [];
    const kept = [];
    for (const c of V1_PRICING) {
      const v = at(stored, c.path);
      if (v === undefined || v === c.to) continue;
      if (v === c.from) { next = setAt(next, c.path, c.to); moved.push(c.label); } else kept.push({ what: c.label, field: c.path.join("."), suggested: c.money ? dollars(c.to) : String(c.to) });
    }
    if (!moved.length) { out.kept.push(...kept); return; }
    try {
      await putSetting("pricing", next, { ...ctx, ifMatch: cur.etag });
      out.upgraded.push(...moved);
      out.kept.push(...kept);
      return;
    } catch (e) {
      if (!(e instanceof StaleError)) throw e;      // an owner saved meanwhile: read theirs again
    }
  }
  out.kept.push({ what: "Pricing settings", field: "busy", suggested: "check by hand" });
}

// system.seed v2. Idempotent: a second run finds the new values and changes
// nothing. Only seeded records (never a quote, a plan or anything imported)
// and the pricing page change; no rotorField is touched, so the parallel-run
// guard has nothing to stop. What an owner had changed is left and the
// owners get one notice with the suggested value (and it is in the result).
export async function upgradeOwnerDecisions(sctx = {}) {
  const ctx = typeof sctx.write === "function" ? sctx.write() : sctx;
  const out = { upgraded: [], kept: [] };
  for (const [key, olds] of Object.entries(V1_ITEMS)) {
    const now = SEED_PRICE_BOOK.find((x) => x.key === key);
    await upgradeFields("price_item", seedItemId(key), olds, now, ctx, out, now.name);
  }
  for (const [key, olds] of Object.entries(V1_DISCOUNTS)) {
    const now = SEED_DISCOUNTS.find((x) => x.key === key);
    await upgradeFields("discount_def", seedDiscountId(key), olds, now, ctx, out, now.name);
  }
  await upgradePricing(ctx, out);
  // one notice, ever (a marker): a run again tells nobody twice
  const claim = out.kept.length ? await claimMarker("done", "notice", "quotes--owner-decisions", { holder: sctx.holder || ctx.requestId || "seed", leaseMs: 60000 }) : null;
  if (claim && claim.ok) {
    const list = [...new Set(out.kept.map((k) => `${k.what} (${k.suggested})`))].join("; ");
    await notify((await approvers().catch(() => [])).slice(0, 10), {
      kind: "system", title: "New suggested prices",
      body: `From the Nov 12 decisions. You had changed these, so yours stay: ${list}. Settings, Pricing & price book.`.slice(0, 300), link: "/settings/pricing",
    }, ctx).catch((e) => console.error(`crm:quotes: the owners were not told about the suggested prices (${e && e.name})`));
    await advanceMarker(claim.marker, { state: "done", result: `${out.kept.length} kept` });
  }
  return { upgraded: out.upgraded.length, kept: out.kept.length, items: out.upgraded.slice(0, 10), left: out.kept.map((k) => `${k.what}: ${k.field}`).slice(0, 10) };
}

// ------------------------------------------------------------ templates (core sender, D5: no STOP text)

export const TEMPLATES = Object.freeze([
  { key: "quote_sent", name: "Quote sent (text)", channel: "sms", category: "service", body: "Hi {{first_name|there}}, here's your quote from {{company_name}}: {{quote_link}} Take a look and let us know if you have any questions!" },
  {
    key: "quote_sent_email", name: "Quote sent (email)", channel: "email", category: "service", subject: "Your quote from {{company_name}}",
    body: "Hi {{first_name|there}},\n\nThanks for thinking of us! Your quote is ready. Tap below to see your options, pick the one that fits and approve it right on your phone.\n\n{{quote_link}}\n\nThe price is good through {{expires_on|the next 30 days}}. Questions? Just reply or call us at {{company_phone}}.\n\n{{sender_first_name}} with {{company_name}}",
  },
]);
