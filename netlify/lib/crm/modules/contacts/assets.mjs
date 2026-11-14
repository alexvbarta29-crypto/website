// Contacts module: a property's counts for quoting (design §5.1 "Property",
// §5.3 "a re-quote reuses them"; docs/CRM-CONTACTS.md "Counts for quoting").
//
// property.assets holds what the office counted once so the next quote
// doesn't start from nothing:
//   windows      { standard, slider, large, sliding_door, french, front_door,
//                  garage_small }  outside, by window type (as the builder counts)
//   windows_int  the same, inside (when it differs from outside)
//   panes_ext, panes_int  the weighted totals the engine prices
//   screens, tracks (standard), tracks_premium, stories, sqft, gutter_ft,
//   downspouts, roofline_ft (Christmas lights), french_panes, ladder_ft
//   notes        ladder, access, anything the next person should know
//   services     the services last quoted here (the builder's keys)
//   plan         the plan last quoted here (a catalog key), or "none"
//   from         { kind: "quote" | "manual", quote_id?, at, by? }
//
// The counts are edited on the property (PATCH /properties/:id) and filled
// automatically when a quote for the property is approved (quote.approved:
// onQuoteApproved below, as automation under the parallel-run guard). GET
// /properties/:id/requote answers what a new quote for the property starts
// from (the builder's measure, services and counts), so a re-quote is one tap.

import { getRecord, updateRecord } from "../../../crm-store.mjs";
import { isId } from "../../core/ids.mjs";
import { nowIso } from "../../core/clock.mjs";
import { NotFoundError } from "../../core/errors.mjs";
import { has, call } from "../../core/services.mjs";
import { safeErr } from "../../../referral-lib.mjs";

// The builder's window types (crm-app/modules/quotes/kit.js), outside and inside.
export const WINDOW_KEYS = Object.freeze(["standard", "slider", "large", "sliding_door", "french", "front_door", "garage_small"]);
// The counts a property keeps (whole numbers 0 to 100,000).
export const ASSET_COUNTS = Object.freeze(["sqft", "panes_ext", "panes_int", "screens", "tracks", "tracks_premium", "stories", "french_panes", "gutter_ft", "downspouts", "roofline_ft", "ladder_ft"]);
// The builder's service keys a re-quote may tick.
export const SERVICE_KEYS = Object.freeze(["windows_ext", "windows_int", "screens", "tracks_standard", "tracks_premium", "gutters"]);
export const PLAN_KEYS = Object.freeze(["biannual", "quarterly", "monthly"]);

const posInt = (v) => (Number.isSafeInteger(v) && v > 0 ? v : 0);
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

// A windows-by-type map with only whole, positive counts (pure). → map | undefined
export function windowsOf(v) {
  if (!isObj(v)) return undefined;
  const out = {};
  for (const k of WINDOW_KEYS) {
    const n = Number(v[k]);
    if (Number.isSafeInteger(n) && n > 0 && n <= 999) out[k] = n;
  }
  return Object.keys(out).length ? out : undefined;
}

// What an approved quote tells us about the property (pure).
//   measure  the quote's builder measure ({ mode, windows, panes_ext, panes_int, sqft, services, counts, plan })
//   lines    the approved option's lines (only the ticked ones count)
//   option   the approved option (its plan's catalog key)
// → a partial assets object (only what the quote knew)
export function countsFromQuote({ measure, lines = [], option } = {}) {
  const m = isObj(measure) ? measure : {};
  const out = {};
  const win = windowsOf(m.windows);
  if (win && m.mode !== "sqft") out.windows = win;
  if (win && win.french) out.french_panes = win.french;
  if (posInt(m.panes_ext)) out.panes_ext = m.panes_ext;
  if (posInt(m.panes_int)) out.panes_int = m.panes_int;
  if (posInt(m.sqft)) out.sqft = m.sqft;
  const services = new Set();
  for (const l of Array.isArray(lines) ? lines : []) {
    if (!l || (l.optional && l.selected !== true)) continue;
    const qty = Number.isSafeInteger(l.qty_milli) ? Math.round(l.qty_milli / 1000) : 0;
    const cat = String(l.category || "");
    const title = String(l.title || "");
    if (cat === "windows_ext") services.add("windows_ext");
    else if (cat === "windows_int") services.add("windows_int");
    else if (cat === "screens") { services.add("screens"); if (qty > 0) out.screens = qty; }
    else if (cat === "tracks") {
      const premium = /premium/i.test(title);
      services.add(premium ? "tracks_premium" : "tracks_standard");
      if (qty > 0) out[premium ? "tracks_premium" : "tracks"] = qty;
    } else if (cat === "gutters") services.add("gutters");
    else if (cat === "lights" && l.unit === "ft" && /install/i.test(title) && qty > 0) out.roofline_ft = qty;
  }
  if (services.size) out.services = SERVICE_KEYS.filter((k) => services.has(k));
  const plan = option && option.kind === "plan" && option.plan && PLAN_KEYS.includes(option.plan.catalog_key) ? option.plan.catalog_key : null;
  if (option) out.plan = plan || "none";
  return out;
}

// The next assets of a property after a quote's counts (pure): the quote's
// counts replace the ones it knew; stories, gutters, the ladder and the
// notes (which a quote never counts) stay. → assets | null (no change)
export function mergeCounts(assets, counts, from) {
  const cur = isObj(assets) ? assets : {};
  const next = { ...cur, ...counts };
  // a quote measured by square feet leaves the counted windows alone; one counted by type replaces them
  if (counts.windows) next.windows = counts.windows;
  for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const changed = Object.keys(counts).some((k) => !same(cur[k], counts[k]));
  if (!changed) return null;
  return { ...next, from };
}

// What a new quote for the property starts from (pure): the builder's
// measure, services, counts and plan. → { measure, services, counts, plan, ready }
// ready: there is enough to price it (outside panes or square feet).
export function requoteFrom(assets) {
  const a = isObj(assets) ? assets : {};
  const win = windowsOf(a.windows);
  const measure = { mode: "panes", windows: Object.fromEntries(WINDOW_KEYS.map((k) => [k, (win && win[k]) || 0])), sqft: "", panes_int: "" };
  if (win) measure.mode = "panes";
  else if (posInt(a.panes_ext)) measure.windows.standard = a.panes_ext;
  else if (posInt(a.sqft)) { measure.mode = "sqft"; measure.sqft = String(a.sqft); }
  if (posInt(a.panes_int) && a.panes_int !== a.panes_ext) measure.panes_int = String(a.panes_int);
  const services = {};
  const last = Array.isArray(a.services) ? a.services.filter((k) => SERVICE_KEYS.includes(k)) : [];
  for (const k of last.length ? last : ["windows_ext"]) services[k] = true;
  if (!last.length && posInt(a.screens)) services.screens = true;
  const counts = {};
  if (posInt(a.screens)) counts.screens = String(a.screens);
  if (posInt(a.tracks)) counts.tracks_standard = String(a.tracks);
  if (posInt(a.tracks_premium)) counts.tracks_premium = String(a.tracks_premium);
  const plan = PLAN_KEYS.includes(a.plan) ? a.plan : (a.plan === "none" ? "" : "quarterly");
  const ready = !!(win || posInt(a.panes_ext) || posInt(a.sqft));
  return { measure, services, counts, plan, ready };
}

// The engine's input for that start (pure): what POST /pricing/suggest takes.
export function suggestInput(start, pricingWeights = {}) {
  const s = start || {};
  const services = SERVICE_KEYS.filter((k) => s.services && s.services[k]);
  const input = { services, tracks: {} };
  if (s.measure && s.measure.mode === "sqft") input.sqft = Number(s.measure.sqft) || undefined;
  else {
    let milli = 0;
    for (const [k, n] of Object.entries((s.measure && s.measure.windows) || {})) milli += Math.round((pricingWeights[k] ?? 1) * 1000) * (Number(n) || 0);
    input.panes_ext = Math.ceil(milli / 1000);
  }
  if (s.measure && s.measure.panes_int) input.panes_int = parseInt(s.measure.panes_int, 10) || undefined;
  const c = s.counts || {};
  if (c.screens) input.screens = parseInt(c.screens, 10) || undefined;
  if (c.tracks_standard) input.tracks.standard = parseInt(c.tracks_standard, 10) || 0;
  if (c.tracks_premium) input.tracks.premium = parseInt(c.tracks_premium, 10) || 0;
  return input;
}

// ------------------------------------------------------------ quote.approved

// Fills the property's counts from the approved option (the quote module
// emits quote.approved { quote_id, contact_id, option_id, ... }). Runs as
// automation: on a property the Rotor import brought in it only writes a
// would- row before cutover (§0 rule 12).
export async function onQuoteApproved(event, h) {
  const p = event.payload || {};
  if (!isId(p.quote_id, "quote")) return { result: "skipped:no_quote" };
  const q = await getRecord("quote", p.quote_id);
  if (!q || q.data.deleted_at) return { result: "skipped:no_quote" };
  const quote = q.data;
  if (!isId(quote.property_id, "property")) return { result: "skipped:no_property" };
  const prop = await getRecord("property", quote.property_id);
  if (!prop || prop.data.deleted_at || prop.data.contact_id !== quote.contact_id) return { result: "skipped:no_property" };
  let version = null;
  if (has("quotes.approvedVersion")) {
    try { version = await call("quotes.approvedVersion", quote.id); } catch (e) { console.error(`crm:contacts: approved version unread (${safeErr(e)})`); }
  }
  const optionId = (quote.approval && quote.approval.option_id) || p.option_id;
  const options = (version && version.options) || quote.options || [];
  const option = options.find((o) => o && o.id === optionId) || null;
  const picked = new Set((quote.approval && Array.isArray(quote.approval.selected_line_ids)) ? quote.approval.selected_line_ids : []);
  const lines = ((option && option.lines) || []).map((l) => (l.optional ? { ...l, selected: picked.size ? picked.has(l.id) : l.selected === true } : l));
  const counts = countsFromQuote({ measure: (version && version.measure) || quote.measure, lines, option });
  if (!Object.keys(counts).length) return { result: "skipped:nothing_counted" };
  const contact = await getRecord("contact", quote.contact_id).catch(() => null);
  if (h.ctx && typeof h.ctx.mayAct === "function" && !h.ctx.mayAct({ record: prop.data, contact: contact && contact.data })) {
    await h.ctx.would(prop.data.id, "update", { assets: Object.keys(counts) });
    return { result: "would-update" };
  }
  const from = { kind: "quote", quote_id: quote.id, at: nowIso() };
  const r = await updateRecord("property", prop.data.id, (x) => {
    const next = mergeCounts(x.assets, counts, from);
    return next ? { ...x, assets: next } : null;
  }, h.ctx.write());
  return { result: r.changed === false ? "unchanged" : "counted" };
}

// ------------------------------------------------------------ GET /properties/:id/requote

// What a new quote for this property starts from, and the contact it
// belongs to. The builder ticks the services, fills the counts and prices
// it at once (one tap). → { data: { property_id, contact_id, start, assets } }
export async function requoteRoute(ctx) {
  const id = ctx.params.id;
  if (!isId(id, "property")) throw new NotFoundError("That property isn't there.");
  const got = await getRecord("property", id);
  if (!got || got.data.deleted_at) throw new NotFoundError("That property isn't there.");
  const a = got.data.assets || {};
  return { data: { property_id: id, contact_id: got.data.contact_id, start: requoteFrom(a), assets: a, counted_from: a.from || null } };
}
