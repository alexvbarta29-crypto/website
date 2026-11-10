// Quotes module: the Rotor import phases (design §10.1 contract, §10.2 rows
// 4, 5 and 18). The framework (staging, the phase runner, field ownership,
// the report) is M2c's; these phases only map rows. Rotor exports are read
// from the run's staging: the CRM never calls Rotor (owner's rule).
//
//   row 4   quotes.price_book  every price-book template id seen on a quote
//           line is attached to the seeded item its title names
//           (rotor_template_ids; ptr/rotor/template/{rid} names the item); a
//           template already attached stays where it is
//   row 5   quotes.discounts   every discount name seen (five shapes,
//           spelling noise) lands on the seeded catalog's rotor_names (D15);
//           a name nothing matches becomes a non-sellable definition;
//           an unnamed fixed amount is "Discount"
//   row 18  quotes.quotes      one option per quote (Rotor never used
//           options): the frequency → one-time or a plan (Semi-Annual →
//           biannual, Quarterly, Monthly, Annual + Christmas Lights →
//           lights_annual, else custom); dollars → cents; a custom price →
//           an override "imported"; unit prices kept; the legacy total_price
//           × visits ignored (lines are recomputed from their own price);
//           Rotor line ids kept verbatim (the quote → plan join key);
//           jobSchedule → scope; client_optional → optional; discounts →
//           AppliedDiscount[]; status mapped (+ viewed when viewed_at); the
//           number kept; the contact's deal (a new one when it has none);
//           the engine's first-visit total compared with Rotor's `total`
//           (a difference is a report warning; stored prices never change)
//
// map() gives the same output for the same input (no clock, no random), so
// an unchanged export changes nothing on a re-run.

import { createHash } from "node:crypto";
import { getRecord, readPointer } from "../../../crm-store.mjs";
import { idForRotor, isId } from "../../core/ids.mjs";
import { RowError, placeholderContact, toCents } from "../contacts/import-rotor.mjs";
import { rotorKey } from "../contacts/display.mjs";
import { SEED_PRICE_BOOK, SEED_DISCOUNTS, seedItem, seedItemId, seedDiscount, seedDiscountId } from "./seed.mjs";
import { optionTotals, pricingWith, PLAN_CATALOG } from "./pricing.mjs";
import { numberLabel, LINE_ID_RE } from "./types.mjs";

const str = (v) => (v == null ? "" : String(v)).trim();
const plain = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const ROTOR_ID = /^(?!\.+$)[A-Za-z0-9_.-]{1,64}$/;
const clone = (v) => JSON.parse(JSON.stringify(v));
const iso = (v) => (v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : undefined);
const sha = (s) => createHash("sha256").update(String(s)).digest("hex");
const strip = (r) => { const { _w, _etag, ...rest } = r || {}; return rest; };

function needId(row, field = "id") {
  if (!plain(row)) throw new RowError("row");
  const id = str(row[field]);
  if (!ROTOR_ID.test(id)) throw new RowError(field);
  return id;
}

// "12.5" / 12.5 → 12500 (thousandths, half up), without floats touching the result.
export function toMilli(v) {
  const s = str(v);
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const neg = s.startsWith("-");
  const [d, f = ""] = s.replace("-", "").split(".");
  const milli = Number(d) * 1000 + Number((f + "000").slice(0, 3)) + (Number(f[3] || 0) >= 5 ? 1 : 0);
  return neg ? -milli : milli;
}

// ------------------------------------------------------------ titles and names

// A line title → the seeded price item it is (rotor-money §2).
export function itemKeyFor(title) {
  const t = str(title).toLowerCase();
  if (!t) return null;
  if (/premium/.test(t) && /track/.test(t)) return "tracks_premium";
  if (/track/.test(t)) return "tracks_standard";
  if (/screen/.test(t)) return "screens";
  if (/light|christmas/.test(t)) {
    if (/material/.test(t)) return "lights_materials";
    if (/install/.test(t)) return "lights_install";
    if (/takedown|storage/.test(t)) return "lights_takedown";
    if (/warranty/.test(t)) return "lights_warranty";
    return "lights_package";
  }
  if (/warranty/.test(t)) return "lights_warranty";
  if (/takedown|storage/.test(t)) return "lights_takedown";
  if (/gutter/.test(t)) return "gutters";
  if (/pressure/.test(t)) return "pressure_wash";
  if (/soft ?wash/.test(t)) return "soft_wash";
  if (/house ?wash/.test(t)) return "house_wash";
  if (/junk/.test(t)) return "junk_removal";
  if (/solar/.test(t)) return "solar";
  if (/commercial/.test(t)) return "commercial";
  if (/hard ?water/.test(t)) return "hard_water";
  if (/card fee|fee/.test(t)) return "card_fee";
  if (/upper/.test(t) && /interior/.test(t)) return "interior_upper";
  if (/^interior|interior window/.test(t) && !/exterior/.test(t)) return "interior";
  if (/window|exterior|panes|glass/.test(t)) return "exterior";
  return null;
}
const ITEM_CATEGORY = Object.fromEntries(SEED_PRICE_BOOK.map((i) => [i.key, i.category]));

const norm = (s) => str(s).toLowerCase().replace(/[^a-z0-9]+/g, "");
const NAME_INDEX = new Map(SEED_DISCOUNTS.flatMap((d) => [d.name, ...d.rotor_names].map((n) => [norm(n), d.key])));
// A discount name as Rotor spelled it → the catalog key (D15), or null.
export function discountKeyFor(name) {
  const n = norm(name);
  if (!n) return null;
  if (NAME_INDEX.has(n)) return NAME_INDEX.get(n);
  if (/early|brid/.test(n)) return "early_bird";
  if (/biannu|semiannu/.test(n)) return "plan_biannual";
  if (/quarter/.test(n)) return "plan_quarterly";
  if (/monthly/.test(n)) return "plan_monthly";
  if (/^3year|3yr|threeyear/.test(n)) return "three_year";
  if (/^5year|5yr|fiveyear/.test(n)) return "five_year";
  if (/firsttime|1sttime/.test(n)) return "first_time";
  if (/package/.test(n)) return "package";
  if (/pricematch/.test(n)) return "price_match";
  if (/google/.test(n)) return "google_review";
  if (/serviceoffer/.test(n)) return "service_offer";
  if (/referral/.test(n)) return "referral_credit";
  if (/giftcard/.test(n)) return "gift_card";
  if (/followup/.test(n)) return "followup_50";
  if (/screen/.test(n)) return "ten_free_screens";
  if (n === "discount") return "discount";
  return null;
}
const slug = (name) => norm(name).slice(0, 36) || "discount";

// ------------------------------------------------------------ normalize

const SCHEDULE = { all: "all", initial: "initial", after_initial: "after_initial", specific: "specific" };
function scopeOf(js) {
  if (!plain(js)) return { type: "all" };
  const t = SCHEDULE[str(js.type)] || "all";
  if (t !== "specific") return { type: t };
  const visits = [...new Set((Array.isArray(js.selectedJobs) ? js.selectedJobs : []).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 120))].sort((a, b) => a - b);
  return visits.length ? { type: "specific", visits } : { type: "all" };
}

function normalizeLine(l, i) {
  if (!plain(l)) throw new RowError(`line_items.${i}`);
  const id = str(l.id);
  if (!id || id.length > 64 || !LINE_ID_RE.test(id)) throw new RowError(`line_items.${i}.id`);
  const custom = l.use_custom_price === true || (l.use_unit_pricing !== true && l.custom_price != null);
  return {
    id, title: str(l.title).slice(0, 160) || "Line", description: l.description == null ? "" : String(l.description).slice(0, 2000),
    qty_milli: toMilli(l.quantity ?? 1) ?? 1000, unit_cents: toCents(l.unit_price ?? 0) ?? 0, custom_cents: custom ? toCents(l.custom_price ?? 0) ?? 0 : null,
    template_id: l.template_id && ROTOR_ID.test(str(l.template_id)) ? str(l.template_id) : null,
    service_type: Array.isArray(l.service_type) ? l.service_type.map(str).filter(Boolean).slice(0, 4) : [],
    scope: scopeOf(l.jobSchedule), optional: l.client_optional === true, upsell_user_id: l.upsell_user_id ? str(l.upsell_user_id) : null,
    show: { qty: l.show_quantity !== false, unit: l.show_unit_price === true, description: l.show_description !== false }, deleted: l._deleted === true,
  };
}

// The five discount shapes (rotor-money §1.3) → [{ name, type, value_raw, scope }].
export function discountEntries(d) {
  if (!d || Array.isArray(d) || !plain(d)) return [];
  if (d.enabled === false) return [];
  const multi = Array.isArray(d.multi) ? d.multi : [];
  const fromMulti = multi.filter(plain).map((m) => ({ name: str(m.name), type: m.type === "percentage" ? "percentage" : "fixed", value_raw: m.value, scope: scopeOf(m.jobSchedule) }));
  if (fromMulti.length) return fromMulti.filter((x) => (toCents(x.value_raw) || 0) > 0);
  if (d.type && (toCents(d.value) || 0) > 0) return [{ name: "", type: d.type === "percentage" ? "percentage" : "fixed", value_raw: d.value, scope: { type: "all" } }];
  return [];
}

export function normalizeQuote(row) {
  const id = needId(row);
  const number = Number(row.quote_number);
  if (!Number.isSafeInteger(number) || number < 1) throw new RowError("quote_number");
  const contact_id = needId(row, "contact_id");
  const ct = str(row.contact_type).toLowerCase() === "lead" ? "lead" : "customer";
  const cfg = plain(row.jobs_config) ? row.jobs_config : {};
  if (cfg.line_items !== undefined && !Array.isArray(cfg.line_items)) throw new RowError("jobs_config.line_items");
  const lines = (cfg.line_items || []).slice(0, 50).map(normalizeLine).filter((l) => !l.deleted);
  const freq = plain(cfg.frequency) ? { name: str(cfg.frequency.name), interval: cfg.frequency.interval ? str(cfg.frequency.interval) : null, count: Number.isInteger(cfg.frequency.interval_count) ? cfg.frequency.interval_count : null } : null;
  const svc = Array.isArray(row.service_types) ? row.service_types.map(str).filter(Boolean).slice(0, 6) : [];
  const ag = plain(cfg.agreement) ? cfg.agreement : null;
  return {
    id, number, status: str(row.status) || "draft", archived: row.archived === true, contact_id, contact_type: ct,
    service_types: svc, service_length_months: Number.isInteger(row.service_length_months) ? row.service_length_months : null, billing_mode: str(row.billing_mode) || null,
    total_raw: row.total ?? null, lines, discounts: discountEntries(cfg.discounts), frequency: freq,
    agreement: ag ? { template_id: ag.template_id ? str(ag.template_id) : null, require_card: ag.require_card === true } : null,
    photos: (Array.isArray(cfg.photos) ? cfg.photos : []).filter((p) => plain(p) && typeof p.url === "string" && /^https?:\/\//.test(p.url)).map((p) => p.url).slice(0, 10),
    plan_template_id: cfg.plan_template_id ? str(cfg.plan_template_id) : null, property_id: cfg.property_id ?? null,
    client_notes: row.client_notes == null ? (cfg.notes == null ? "" : String(cfg.notes)) : String(row.client_notes), internal_notes: row.internal_notes == null ? "" : String(row.internal_notes),
    sent_at: iso(row.sent_at), viewed_at: iso(row.viewed_at), approved_at: iso(row.approved_at), rejected_at: iso(row.rejected_at),
    modification_requested_at: iso(row.modification_requested_at), modification_message: row.modification_message == null ? null : String(row.modification_message).slice(0, 2000),
    sold_by: row.sold_by ? str(row.sold_by) : null, created_at: iso(row.created_at),
  };
}

// The price-book phase reads only line titles and template ids.
export function normalizeLinesOnly(row) {
  const id = needId(row);
  const cfg = plain(row.jobs_config) ? row.jobs_config : {};
  const lines = (Array.isArray(cfg.line_items) ? cfg.line_items : []).filter(plain).map((l) => ({ title: str(l.title).slice(0, 160), template_id: l.template_id && ROTOR_ID.test(str(l.template_id)) ? str(l.template_id) : null })).filter((l) => l.template_id);
  return { id, lines };
}
export function normalizeDiscountsOnly(row) {
  const id = needId(row);
  const cfg = plain(row.jobs_config) ? row.jobs_config : {};
  return { id, entries: discountEntries(cfg.discounts) };
}

// ------------------------------------------------------------ row 4: price book

async function itemRecord(key) {
  const g = await getRecord("price_item", seedItemId(key));
  return g ? strip(g.data) : seedItem(key);
}

async function mapPriceBook(r) {
  const out = { records: [], pointers: [], warnings: [] };
  const byKey = new Map();
  for (const l of r.lines) {
    const key = itemKeyFor(l.title);
    if (!key) { out.warnings.push("template_unmatched"); continue; }
    const p = await readPointer("rotor/template", rotorKey(l.template_id)).catch(() => null);
    if (p && isId(p.id, "price_item")) {
      if (p.id !== seedItemId(key)) out.warnings.push("template_reused");
      continue;
    }
    const cur = byKey.get(key) || await itemRecord(key);
    const ids = [...new Set([...(cur.rotor_template_ids || []), l.template_id])].sort();
    byKey.set(key, { ...cur, rotor_template_ids: ids });
  }
  for (const item of byKey.values()) out.records.push({ type: "price_item", data: item, source: "pricebook:fold" });
  return out;
}

// ------------------------------------------------------------ row 5: discounts

const NEW_DEF_ID = (name) => idForRotor("discount_def", `name:${slug(name)}`);
// The catalog's definition (the seed's own when system.seed hasn't run yet: written with it).
async function defRecord(key) {
  const g = await getRecord("discount_def", seedDiscountId(key));
  return g ? { rec: strip(g.data), stored: true } : { rec: seedDiscount(key), stored: false };
}

async function mapDiscounts(r) {
  const out = { records: [], warnings: [] };
  const touched = new Map();
  for (const e of r.entries) {
    const name = e.name || "Discount";
    const key = discountKeyFor(name);
    if (key) {
      const had = touched.get(key);
      const { rec: cur, stored } = had ? { rec: had, stored: true } : await defRecord(key);
      if (!(cur.rotor_names || []).some((n) => n === name)) touched.set(key, { ...cur, rotor_names: [...(cur.rotor_names || []), name].slice(0, 100) });
      else if (!stored) touched.set(key, cur);
      continue;
    }
    const id = NEW_DEF_ID(name);
    const g = await getRecord("discount_def", id);
    if (g) continue;
    const pct = e.type === "percentage";
    const raw = toCents(e.value_raw) || 0;
    touched.set(`new:${id}`, {
      id, key: `rotor_${slug(name)}`.slice(0, 40), name: name.slice(0, 80), kind: pct ? "percentage" : "fixed", value: Math.min(pct ? 10000 : 100000000, raw),
      default_scope: e.scope || { type: "all" }, sellable: false, active: true, rotor_names: [name],
    });
    out.warnings.push("discount_new_name");
  }
  for (const d of touched.values()) out.records.push({ type: "discount_def", data: d, source: "discounts:fold" });
  return out;
}

// ------------------------------------------------------------ row 18: quotes

const STATUS = { draft: "draft", sent: "sent", approved: "approved", rejected: "declined", modification_requested: "changes_requested", converted: "converted" };

// Rotor's frequency → a one-time or plan option (§10.2 row 18).
export function optionShape(r) {
  const f = r.frequency;
  const lights = (r.service_types || []).some((s) => /christmas|light/i.test(s));
  const term = Math.max(12, Math.min(60, r.service_length_months || 12));
  const billing = r.billing_mode === "start_of_month" ? "first_of_month" : "after_visit";
  const autopay = !!(r.agreement && r.agreement.require_card);
  if (!f || !f.name || /one.?time/i.test(f.name) || (!f.interval && !/annual|quarter|month/i.test(f.name))) return { kind: "one_time", name: "One-time" };
  let key = "custom";
  if (/semi.?annual|bi.?annual/i.test(f.name)) key = "biannual";
  else if (/quarter/i.test(f.name)) key = "quarterly";
  else if (/month/i.test(f.name) && (f.count || 1) === 1) key = "monthly";
  else if (/annual/i.test(f.name) && lights) key = "lights_annual";
  const cat = PLAN_CATALOG[key];
  let frequency = { ...cat.frequency };
  let visits = cat.visits_per_year;
  if (key === "custom") {
    const interval = ["month", "year", "week", "day"].includes(f.interval) ? f.interval : "year";
    const count = Math.max(1, Math.min(52, f.count || 1));
    frequency = { interval, count };
    visits = Math.max(1, Math.min(52, interval === "month" ? Math.round(12 / count) : interval === "week" ? Math.round(52 / count) : interval === "day" ? 52 : 1));
  }
  return { kind: "plan", name: cat.name, plan: { catalog_key: key, frequency, visits_per_year: visits, term_months: term, billing, autopay, auto_renew: true } };
}

async function lookupContact(ctx, type, rid) {
  if (ctx && typeof ctx.lookup === "function") {
    const id = await ctx.lookup(type, rid);
    if (id) return id;
  }
  const p = await readPointer(`rotor/${type}`, rotorKey(rid)).catch(() => null);
  return p && isId(p.id, "contact") ? p.id : null;
}

const unitOf = (key) => ({ screens: "screen", tracks_standard: "track", tracks_premium: "track", lights_install: "ft", lights_materials: "ft", interior_upper: "pane" })[key] || "flat";

async function mapQuote(r, ctx = {}) {
  const out = { records: [], pointers: [], stats: [], warnings: [] };
  const warn = (w) => { out.warnings.push(w); };
  const pricing = pricingWith(ctx.settings && typeof ctx.settings.get === "function" ? await ctx.settings.get("pricing").catch(() => ({})) : {});

  // the contact (resolved through the pointers; one Rotor no longer lists gets a placeholder, row 9)
  let contactId = await lookupContact(ctx, r.contact_type, r.contact_id);
  if (!contactId && r.contact_type === "customer") contactId = await lookupContact(ctx, "lead", r.contact_id);
  let contact = contactId ? await getRecord("contact", contactId).then((g) => g && g.data).catch(() => null) : null;
  if (!contactId) {
    const ph = placeholderContact(r.contact_id, { kind: r.contact_type });
    out.records.push(ph);
    out.pointers.push({ kind: `rotor/${r.contact_type}`, key: rotorKey(r.contact_id), value: { id: ph.data.id } });
    contactId = ph.data.id;
    contact = ph.data;
    warn("quote_placeholder_contact");
  }

  // the lines and discounts
  const lines = [];
  for (const l of r.lines) {
    const key = itemKeyFor(l.title);
    const ptr = l.template_id ? await readPointer("rotor/template", rotorKey(l.template_id)).catch(() => null) : null;
    const svc = l.service_type.find((s) => !s.includes("::")) || (r.service_types[0] || undefined);
    const tierRaw = l.service_type.find((s) => s.includes("::"));
    const line = {
      id: l.id, title: l.title, description: l.description, qty_milli: Math.max(0, l.qty_milli), unit_cents: l.custom_cents !== null ? (l.unit_cents || 0) : l.unit_cents,
      scope: l.scope, category: (key && ITEM_CATEGORY[key]) || "other", unit: l.custom_cents !== null ? "flat" : unitOf(key), show: l.show,
      ...(ptr && isId(ptr.id, "price_item") ? { price_item_id: ptr.id } : {}),
      ...(svc ? { service_type: svc.slice(0, 80) } : {}), ...(tierRaw ? { tier: tierRaw.split("::")[1].slice(0, 80) } : {}),
      ...(l.optional ? { optional: true } : {}),
      ...(l.upsell_user_id && ctx.users && ctx.users.get(l.upsell_user_id) ? { upsell_user_id: ctx.users.get(l.upsell_user_id) } : {}),
    };
    if (l.custom_cents !== null) line.override = { cents: l.custom_cents, reason: "imported", by: "import", ...(r.created_at ? { at: r.created_at } : {}) };
    lines.push(line);
  }
  const discounts = [];
  r.discounts.forEach((e, i) => {
    const name = (e.name || "Discount").slice(0, 80);
    const key = discountKeyFor(name);
    const raw = toCents(e.value_raw) || 0;
    discounts.push({
      id: `dc_r${i + 1}`, ...(key ? { key, def_id: seedDiscountId(key) } : {}), name, type: e.type,
      value: e.type === "percentage" ? Math.min(10000, raw) : Math.min(100000000, raw), scope: e.scope,
    });
  });
  const shape = optionShape(r);
  const option = { id: "op_rotor", name: shape.name, kind: shape.kind, recommended: true, ...(shape.plan ? { plan: shape.plan } : {}), lines, discounts };
  option.totals = optionTotals(option, pricing);
  const rotorTotal = r.total_raw === null || r.total_raw === undefined ? null : toCents(r.total_raw);
  if (rotorTotal !== null && rotorTotal !== option.totals.first_cents) warn("quote_total_differs");
  if (!lines.length) warn("quote_no_lines");
  if (!r.frequency) warn("quote_no_frequency");

  // where and which deal
  let propertyId;
  if (r.property_id !== null && r.property_id !== undefined && String(r.property_id) !== "") {
    const p = await readPointer("rotor/property", rotorKey(r.property_id)).catch(() => null);
    if (p && isId(p.id, "property")) propertyId = p.id;
  }
  if (!propertyId && contact && isId(contact.primary_property_id, "property")) propertyId = contact.primary_property_id;
  const status = r.archived ? "archived" : (STATUS[r.status] || "draft");
  const finalStatus = status === "sent" && r.viewed_at ? "viewed" : status;
  let dealId = idForRotor("deal", `${r.contact_type}:${r.contact_id}`);
  if (!(await getRecord("deal", dealId).catch(() => null))) {
    dealId = idForRotor("deal", `quote:${r.id}`);
    const dealStatus = ["approved", "converted"].includes(finalStatus) ? "won" : finalStatus === "declined" ? "lost" : finalStatus === "draft" ? "open" : "quoted";
    out.records.push({
      type: "deal", data: {
        id: dealId, contact_id: contactId, services: r.service_types, status: dealStatus, quote_ids: [idForRotor("quote", r.id)], job_ids: [], plan_ids: [], history: [],
        opened_at: r.created_at || "2026-08-01T00:00:00.000Z", ...(dealStatus === "won" && r.approved_at ? { won_at: r.approved_at } : {}),
        ...(dealStatus === "lost" ? { lost_reason: "other", ...(r.rejected_at ? { lost_at: r.rejected_at } : {}) } : {}), rotor: { quote_id: r.id },
      },
    });
  }

  const id = (ctx.lookup && await ctx.lookup("quote", r.id)) || idForRotor("quote", r.id);
  const users = (ctx && ctx.users) || new Map();
  const sold = r.sold_by && users.get(r.sold_by);
  const data = {
    id, number: r.number, contact_id: contactId, contact_name: contact ? (contact.display_name || [contact.first_name, contact.last_name].filter(Boolean).join(" ") || contact.company_name || "") : "",
    ...(propertyId ? { property_id: propertyId } : {}), deal_id: dealId, status: finalStatus, options: [option],
    ...(["approved", "converted"].includes(finalStatus) ? { selected_option_id: "op_rotor" } : {}),
    agreement: { require_card: !!(r.agreement && r.agreement.require_card), deposit: { type: "none", value: 0 } },
    client_notes: r.client_notes.slice(0, 4000), internal_notes: r.internal_notes.slice(0, 4000),
    photo_ids: r.photos.map((u) => idForRotor("file", sha(u))), mockup_file_ids: [], sent_via: [],
    ...(r.sent_at ? { sent_at: r.sent_at } : {}), ...(r.viewed_at ? { viewed_at: r.viewed_at } : {}),
    ...(r.approved_at ? { approved_at: r.approved_at, approval: { option_id: "op_rotor", at: r.approved_at, method: "portal", name_typed: "" } } : {}),
    ...(r.rejected_at ? { declined_at: r.rejected_at } : {}),
    ...(r.modification_requested_at ? { changes_requested_at: r.modification_requested_at } : {}), ...(r.modification_message ? { change_message: r.modification_message } : {}),
    ...(finalStatus === "converted" ? { converted_to: { job_ids: [] } } : {}),
    ...(isId(sold, "user") ? { sold_by: sold } : {}),
    approvals_count: r.approved_at ? 1 : 0, versions_n: 0, services: r.service_types, offers: [],
    created_at: r.created_at,
    rotor: {
      quote_id: r.id, quote_number: r.number, status_raw: r.status, contact_type: r.contact_type, contact_id: r.contact_id,
      ...(r.plan_template_id ? { plan_template_id: r.plan_template_id } : {}), ...(r.agreement && r.agreement.template_id ? { agreement_template_id: r.agreement.template_id } : {}),
      total_dollars_raw: r.total_raw === null ? null : Number(r.total_raw), ...(r.billing_mode ? { billing_mode_raw: r.billing_mode } : {}),
      ...(r.service_length_months ? { service_length_months: r.service_length_months } : {}), ...(r.frequency && r.frequency.name ? { frequency_name: r.frequency.name } : {}),
      ...(r.sold_by && !isId(sold, "user") ? { sold_by: r.sold_by } : {}),
    },
  };
  data.number_label = numberLabel(data);
  out.records.push({ type: "quote", data });
  out.pointers.push({ kind: "rotor/quote", key: rotorKey(r.id), value: { id } });
  // services quoted (the contacts index's svc_q), only what the stats part doesn't hold yet: an unchanged re-run writes nothing
  if (r.service_types.length) {
    const st = await getRecord("contact_stats", contactId).catch(() => null);
    const had = new Set((st && st.data && st.data.quotes && st.data.quotes.svc_q) || []);
    const add = r.service_types.filter((x) => !had.has(x));
    if (add.length) out.stats.push({ contact_id: contactId, part: "quotes", merge: { svc_q: add } });
  }
  return out;
}

export const phases = [
  { name: "quotes.price_book", entity: "quotes", after: ["contacts.leads"], normalize: normalizeLinesOnly, map: mapPriceBook },
  { name: "quotes.discounts", entity: "quotes", after: ["quotes.price_book"], normalize: normalizeDiscountsOnly, map: mapDiscounts },
  { name: "quotes.quotes", entity: "quotes", after: ["contacts.properties_quotes", "sales.opportunities", "quotes.discounts"], normalize: normalizeQuote, map: mapQuote },
];

export { mapQuote, mapPriceBook, mapDiscounts };
