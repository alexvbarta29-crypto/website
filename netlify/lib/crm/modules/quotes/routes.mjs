// Quotes module: the staff API (design §5.3 "Endpoints"). All quotes:*;
// a line's price override needs prices:override (with a reason); the price
// book and discounts are pricebook:edit (owners); cfg/pricing is owner-only
// through the core settings routes (/settings/pricing).
//
//   GET  /pricing/context              the builder's start: pricing, price book, discounts, features, sms mode
//   POST /pricing/suggest {input}      engine lines (+ a plan's scopes and discount)
//   POST /pricing/totals {option}      totals of one option
//   POST /pricing/lights {...}         lights lines and Early Bird / 3-year discounts
//   GET  /pricebook · POST /pricebook · PATCH /pricebook/:id
//   GET  /discounts · POST /discounts · PATCH /discounts/:id
//   GET  /quotes?status=&contact=&year=          · POST /quotes
//   GET  /quotes/:id · PATCH /quotes/:id (If-Match)
//   POST /quotes/:id/send {channels}             freezes a version; the quote.sent automation sends the link
//   POST /quotes/:id/approve {option_id, by_phone} a run (approved by phone)
//   POST /quotes/:id/convert                     a run
//   POST /quotes/:id/present                     → { url, expires_at } (single use, 15 minutes)
//   GET  /quotes/:id/versions · /quotes/:id/versions/:vid
//   POST /quotes/:id/archive · restore · decline · duplicate
//   GET  /quotes/:id/preview                     the customer's view (HTML) for staff

import { createRecord, getRecord, getRecords, patchRecord, listRel, updateRecord, readIndex } from "../../../crm-store.mjs";
import { isId } from "../../core/ids.mjs";
import { localDate, now } from "../../core/clock.mjs";
import { InputError, NotFoundError, ConflictError } from "../../core/errors.mjs";
import { has } from "../../core/services.mjs";
import { adapter } from "../../adapters/index.mjs";
import { PORTAL_CSP, PORTAL_HEADERS, layout } from "../../portal/core.mjs";
import { getSetting } from "../../../crm-store.mjs";
import { isPlainObject } from "../../core/validate.mjs";
import { suggestOption, optionTotals, lightsLines, lightsDiscounts, earlyBirdDeadline, tierFromSqft, paneCount, screenEstimate, PLAN_CATALOG } from "./pricing.mjs";
import { OPEN_STATUSES, QUOTE_STATUSES, quoteRow, validateOption } from "./types.mjs";
import {
  loadPricing, priceBook, discountDefs, newLineId, createQuote, patchQuote, getQuote, sendQuote, archiveQuote, restoreQuote, declineQuote,
  duplicateQuote, normalizeOptions, strip, W,
} from "./quotes.mjs";
import { versionsOf, versionSummary, getVersion } from "./versions.mjs";
import { startApproval, startConvert, canConvert } from "./approve.mjs";
import { presentLink } from "./portal.mjs";
import { renderQuotePage } from "./render.mjs";

const R = (method, path, perm, subject, handler, extra = {}) => ({ method, path, auth: "session", perm, subject, mode: "inline", handler, ...extra });

export const features = () => ({
  convert_plan: has("plans.fromQuoteOption"), convert_one_time: has("work.createJobs"), deposits: has("money.createDepositInvoice"), agreements: has("plans.agreementForOption"),
});
async function modeOf(kind) { try { return (await adapter(kind, {})).mode; } catch { return "dry_run"; } }

// ------------------------------------------------------------ pricing

async function contextRoute(ctx) {
  const [pricing, book, defs, sms, email] = await Promise.all([loadPricing(), priceBook(), discountDefs(), modeOf("sms"), modeOf("email")]);
  return {
    data: {
      pricing, book, discounts: defs, features: features(), sms_mode: sms, email_mode: email, plans: PLAN_CATALOG, today: localDate(now()),
      early_bird_deadline: earlyBirdDeadline(localDate(now()), pricing),
      can: { override: ctx.can("prices:override"), pricebook: ctx.can("pricebook:edit"), send: ctx.can("quotes:send"), settings: ctx.can("settings:owner") },
    },
  };
}

const posInt = (v) => (Number.isSafeInteger(v) && v > 0 ? v : 0);

async function suggestRoute(ctx) {
  const input = isPlainObject(ctx.body && ctx.body.input) ? { ...ctx.body.input } : {};
  const pricing = await loadPricing();
  const [book, defs] = await Promise.all([priceBook(), discountDefs()]);
  const warnings = [];
  let tier = null;
  if (Array.isArray(input.windows) && input.windows.length) {
    const pc = paneCount(input.windows, pricing);
    input.panes_ext = pc.panes;
    if (!posInt(input.panes_int)) input.panes_int = pc.panes;
  }
  if (input.sqft !== undefined && input.sqft !== null && input.sqft !== "" && !posInt(input.panes_ext)) {
    tier = tierFromSqft(input.sqft, pricing);
    if (tier.manual) warnings.push("over_sqft_price_by_hand");
    else { input.panes_ext = tier.pane_estimate; if (!posInt(input.panes_int)) input.panes_int = tier.pane_estimate; warnings.push("confirm_panes_on_site"); }
  }
  const out = suggestOption(input, pricing, book, defs, { lineId: newLineId });
  return { data: { ...out, warnings: [...warnings, ...out.warnings], panes_ext: posInt(input.panes_ext), panes_int: posInt(input.panes_int), screens_estimate: screenEstimate(input.panes_ext, pricing), sqft_tier: tier } };
}

async function totalsRoute(ctx) {
  const o = ctx.body && ctx.body.option;
  if (!isPlainObject(o)) throw new InputError("Send an option.", "option");
  const pricing = await loadPricing();
  const [norm] = normalizeOptions([o], { pricing, canOverride: true, trusted: true });
  validateOption(norm, "option");
  return { data: { totals: optionTotals(norm, pricing) } };
}

async function lightsRoute(ctx) {
  const b = ctx.body || {};
  const pricing = await loadPricing();
  const [book, defs] = await Promise.all([priceBook(), discountDefs()]);
  const runs = Array.isArray(b.runs) ? b.runs.slice(0, 30) : [];
  for (const [i, r] of runs.entries()) {
    const ft = Number(r && r.feet);
    if (!Number.isFinite(ft) || ft < 0 || ft > 5000) throw new InputError("Feet from 0 to 5,000.", `runs.${i}.feet`);
  }
  const pkg = b.package_cents === undefined || b.package_cents === null || b.package_cents === "" ? null : Number(b.package_cents);
  if (pkg !== null && (!Number.isSafeInteger(pkg) || pkg < 0 || pkg > 10000000)) throw new InputError("A package price in cents.", "package_cents");
  const colors = (Array.isArray(b.colors) ? b.colors : []).filter((c) => (pricing.lights.colors || []).includes(c));
  const on = typeof b.on === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.on) ? b.on : localDate(now());
  // every season (a lights plan, the default) or this season only; the 3-year contract is a plan of three seasons
  const every = b.every_season !== false;
  if (!every && b.three_year === true) throw new InputError("The 3-year discount is for every season, not this season only.", "three_year");
  const lines = lightsLines({ runs, package_cents: pkg || undefined, colors }, pricing, book, { lineId: newLineId });
  const deadline = earlyBirdDeadline(on, pricing);
  const discounts = lightsDiscounts({ early_bird: b.early_bird === true, three_year: b.three_year === true, on }, pricing, defs).map((d) => ({ ...d, id: `dc_${d.key}_${newLineId().slice(3, 9)}` }));
  const warnings = [];
  if (!lines.length) warnings.push("add_runs_or_package");
  if (b.early_bird === true && !deadline) warnings.push("early_bird_over");
  return { data: { lines, discounts, early_bird_deadline: deadline, warnings, plan: every ? { catalog_key: "lights_annual", frequency: { ...PLAN_CATALOG.lights_annual.frequency }, visits_per_year: 1, term_months: b.three_year === true ? 36 : 12, billing: "after_visit", autopay: false, auto_renew: true } : null } };
}

// ------------------------------------------------------------ price book and discounts

async function pricebookList() {
  const ix = await readIndex("pricebook", "");
  return { data: ix.rows.map((r) => ({ id: r.id, key: r.k, name: r.nm, category: r.cat, unit: r.u, unit_cents: r.uc, engine: r.e, active: r.act, sellable: r.sell, service_type: r.st })).sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name)) };
}
async function pricebookGet(ctx) {
  const g = isId(ctx.params.id, "price_item") ? await getRecord("price_item", ctx.params.id) : null;
  if (!g || g.data.deleted_at) throw new NotFoundError("That item isn't there.");
  return { data: strip(g.data), etag: g.etag };
}
const ITEM_FIELDS = ["name", "category", "service_type", "unit", "unit_cents", "description", "show", "active", "sellable"];
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o && o[k] !== undefined).map((k) => [k, o[k]]));
async function pricebookCreate(ctx) {
  const r = await createRecord("price_item", { ...pick(ctx.body, ITEM_FIELDS), engine: "manual", rotor_template_ids: [] }, ctx.write());
  return { data: strip(r.data), etag: r.etag, status: 201 };
}
async function pricebookPatch(ctx) {
  if (!isId(ctx.params.id, "price_item")) throw new NotFoundError("That item isn't there.");
  const r = await patchRecord("price_item", ctx.params.id, pick(ctx.body, ITEM_FIELDS), { ...ctx.write(), ifMatch: ctx.ifMatch });
  return { data: strip(r.data), etag: r.etag };
}

async function discountsList() {
  return { data: await discountDefs() };
}
async function discountGet(ctx) {
  const g = isId(ctx.params.id, "discount_def") ? await getRecord("discount_def", ctx.params.id) : null;
  if (!g || g.data.deleted_at) throw new NotFoundError("That discount isn't there.");
  return { data: strip(g.data), etag: g.etag };
}
const DEF_FIELDS = ["name", "kind", "value", "default_scope", "sellable", "active", "stack_group", "typed_amount"];
const defBody = (b) => ({ ...pick(b, DEF_FIELDS), ...(b && b.type && !b.kind ? { kind: b.type } : {}) });
async function discountCreate(ctx) {
  const b = ctx.body || {};
  const key = String(b.key || b.name || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(\d)/, "d$1").slice(0, 40);
  const r = await createRecord("discount_def", { ...defBody(b), key, rotor_names: [] }, ctx.write());
  return { data: strip(r.data), etag: r.etag, status: 201 };
}
async function discountPatch(ctx) {
  if (!isId(ctx.params.id, "discount_def")) throw new NotFoundError("That discount isn't there.");
  const r = await patchRecord("discount_def", ctx.params.id, defBody(ctx.body), { ...ctx.write(), ifMatch: ctx.ifMatch });
  return { data: strip(r.data), etag: r.etag };
}

// ------------------------------------------------------------ quotes

const CLOSED = ["converted", "declined", "archived"];

async function listRoute(ctx) {
  const status = String(ctx.query.get("status") || "");
  if (status && status !== "all" && status !== "open" && !QUOTE_STATUSES.includes(status)) throw new InputError("Unknown status.", "status");
  const contact = ctx.query.get("contact");
  if (contact) {
    if (!isId(contact, "contact")) throw new InputError("That isn't a contact.", "contact");
    const rels = await listRel("contact-quotes", contact, { limit: 40 });
    const got = await getRecords("quote", rels.map((r) => r.id));
    const rows = got.filter((g) => g && !g.data.deleted_at && g.data.contact_id === contact).map((g) => ({ id: g.data.id, ...quoteRow(g.data) }));
    return { data: rows.sort((a, b) => String(b.at).localeCompare(String(a.at))), meta: { total: rows.length } };
  }
  const year = /^\d{4}$/.test(ctx.query.get("year") || "") ? ctx.query.get("year") : localDate(now()).slice(0, 4);
  const open = await readIndex("quotes", "open");
  let rows = open.rows;
  const wantsClosed = !status || status === "all" || CLOSED.includes(status);
  if (wantsClosed) rows = [...rows, ...(await readIndex("quotes", year)).rows];
  const counts = {};
  for (const r of rows) counts[r.st] = (counts[r.st] || 0) + 1;
  if (status === "open") rows = rows.filter((r) => OPEN_STATUSES.includes(r.st));
  else if (status && status !== "all") rows = rows.filter((r) => r.st === status);
  rows = [...rows].sort((a, b) => String(b.u || "").localeCompare(String(a.u || "")));
  return { data: rows.slice(0, 300), meta: { total: rows.length, counts, year, stale: !!open.stale } };
}

async function createRoute(ctx) {
  const r = await createQuote(ctx.body || {}, ctx);
  return { data: strip(r.data), etag: r.etag, status: r.existed ? 200 : 201 };
}

const summaryOf = (c) => {
  if (!c) return null;
  const phones = Array.isArray(c.phones) ? c.phones : [];
  const emails = Array.isArray(c.emails) ? c.emails : [];
  const p = phones.find((x) => x && x.primary) || phones[0];
  const e = emails.find((x) => x && x.primary) || emails[0];
  return { id: c.id, name: c.display_name || [c.first_name, c.last_name].filter(Boolean).join(" ") || c.company_name || "No name", first_name: c.first_name || "", phone: p ? p.e164 : null, email: e ? e.address : null, town: (c.billing_address && c.billing_address.city) || "", lifecycle: c.lifecycle, test: !!(c.flags && c.flags.test) };
};
const propertyOf = (p) => (p ? { id: p.id, label: p.label, address: [p.address && p.address.street1, p.address && p.address.city].filter(Boolean).join(", "), assets: p.assets || {} } : null);

async function getRoute(ctx) {
  const { data: q, etag } = await getQuote(ctx.params.id);
  const [c, props, versions] = await Promise.all([
    getRecord("contact", q.contact_id).catch(() => null),
    listRel("contact-properties", q.contact_id, { limit: 10 }).then((rows) => getRecords("property", rows.map((r) => r.id))).catch(() => []),
    versionsOf(q.id, { limit: 12 }).catch(() => []),
  ]);
  const properties = props.filter((g) => g && !g.data.deleted_at).map((g) => propertyOf(g.data));
  // the approved version while approved; after an archive and restore the old approval is only history
  const done = ["approved", "converted"].includes(q.status);
  const shown = (done && q.approval && versions.find((v) => v.id === q.approval.version_id)) || versions.find((v) => v.id === q.current_version_id) || null;
  const appr = q.approval && shown ? (shown.options || []).find((o) => o.id === q.approval.option_id) : null;
  return {
    data: {
      quote: strip(q), contact: summaryOf(c && c.data), properties, versions: versions.map(versionSummary), current_version: shown, features: features(),
      convertible: q.status === "approved" && !!appr && canConvert(appr), sms_mode: await modeOf("sms"),
    },
    etag,
  };
}

// PATCH /quotes/:id: the editable fields; `measure` ({ sqft, panes_ext,
// panes_int }) is kept on the quote and its property's counts so a re-quote reuses them (§5.3).
async function patchRoute(ctx) {
  const b = ctx.body || {};
  const r = await patchQuote(ctx.params.id, b, ctx);
  if (isPlainObject(b.measure)) {
    const m = {};
    for (const k of ["sqft", "panes_ext", "panes_int", "screens", "tracks"]) if (Number.isSafeInteger(b.measure[k]) && b.measure[k] >= 0 && b.measure[k] <= 100000) m[k] = b.measure[k];
    if (Object.keys(m).length && r.data.property_id) {
      await updateRecord("property", r.data.property_id, (p) => (Object.entries(m).every(([k, v]) => (p.assets || {})[k] === v) ? null : { ...p, assets: { ...(p.assets || {}), ...m } }), ctx.write()).catch(() => null);
    }
  }
  return { data: strip(r.data), etag: r.etag };
}

async function sendRoute(ctx) {
  const channels = Array.isArray(ctx.body && ctx.body.channels) ? ctx.body.channels : [];
  if (!channels.length || channels.some((c) => !["sms", "email"].includes(c))) throw new InputError("Pick text, email or both.", "channels");
  const out = await sendQuote(ctx.params.id, { channels }, ctx);
  return { data: { quote: strip(out.quote), version: versionSummary(out.version), new_version: out.created, sms_mode: await modeOf("sms") }, etag: out.etag };
}

// Approved by phone: the version the customer heard (a quote that changed
// since its last version freezes one first, without sending anything).
async function approveRoute(ctx) {
  const b = ctx.body || {};
  if (b.by_phone !== true) throw new InputError("Approving for a customer is by phone here; the customer approves on their link.", "by_phone");
  let { data: q } = await getQuote(ctx.params.id);
  if (["approved", "converted"].includes(q.status)) throw new ConflictError("This quote is already approved.");
  if (!["sent", "viewed"].includes(q.status)) q = (await sendQuote(q.id, { channels: [] }, ctx)).quote;
  const version_id = b.version_id && b.version_id === q.current_version_id ? b.version_id : q.current_version_id;
  const out = await startApproval(q.id, { version_id, option_id: b.option_id, selected_line_ids: b.selected_line_ids, name_typed: b.name_typed || "" }, { method: "phone", by: ctx.user.id }, ctx);
  return { data: { run_id: out.run_id }, status: 202 };
}

async function convertRoute(ctx) {
  const run = await startConvert(ctx.params.id, ctx);
  return { data: { run_id: run.id }, status: 202 };
}

async function presentRoute(ctx) {
  return { data: await presentLink(ctx.params.id, ctx) };
}

async function versionsRoute(ctx) {
  const { data: q } = await getQuote(ctx.params.id);
  return { data: (await versionsOf(q.id)).map(versionSummary) };
}
async function versionRoute(ctx) {
  const { data: q } = await getQuote(ctx.params.id);
  const v = await getVersion(ctx.params.vid);
  if (!v || v.quote_id !== q.id) throw new NotFoundError("That version isn't there.");
  return { data: strip(v) };
}

const lifecycle = (fn) => async (ctx) => {
  const out = await fn(ctx);
  return { data: { quote: strip(out.quote), ...(out.would ? { would: true } : {}) }, ...(out.etag ? { etag: out.etag } : {}) };
};

async function previewRoute(ctx) {
  const { data: q } = await getQuote(ctx.params.id);
  const vid = (["approved", "converted"].includes(q.status) && q.approval && q.approval.version_id) || q.current_version_id;
  const [version, c, company] = await Promise.all([vid ? getVersion(vid) : null, getRecord("contact", q.contact_id).catch(() => null), getSetting("company").catch(() => ({}))]);
  const files = version ? [...(version.photo_ids || []), ...(version.mockup_file_ids || [])] : [];
  const out = renderQuotePage({ quote: q, version, contact: c && c.data, mode: "preview", files });
  const html = layout({ title: out.title, body: out.body.replace(/\/api\/portal\/quotes\/[^/"]+\/files\//g, "/api/crm/files/"), company, page: "preview" });
  return new Response(html, { status: 200, headers: { ...PORTAL_HEADERS, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": PORTAL_CSP, "Referrer-Policy": "same-origin" } });
}

export const quoteRoutes = [
  R("GET", "/pricing/context", "quotes:read", "none", contextRoute),
  R("POST", "/pricing/suggest", "quotes:write", "none", suggestRoute),
  R("POST", "/pricing/totals", "quotes:read", "none", totalsRoute),
  R("POST", "/pricing/lights", "quotes:write", "none", lightsRoute),
  R("GET", "/pricebook", "quotes:read", "none", pricebookList),
  R("GET", "/pricebook/:id", "quotes:read", "required", pricebookGet),
  R("POST", "/pricebook", "pricebook:edit", "none", pricebookCreate),
  R("PATCH", "/pricebook/:id", "pricebook:edit", "required", pricebookPatch),
  R("GET", "/discounts", "quotes:read", "none", discountsList),
  R("GET", "/discounts/:id", "quotes:read", "required", discountGet),
  R("POST", "/discounts", "pricebook:edit", "none", discountCreate),
  R("PATCH", "/discounts/:id", "pricebook:edit", "required", discountPatch),
  R("GET", "/quotes", "quotes:read", "none", listRoute),
  R("POST", "/quotes", "quotes:write", "none", createRoute, { maxCalls: 40 }),
  R("GET", "/quotes/:id", "quotes:read", "required", getRoute, { maxCalls: 40 }),
  R("PATCH", "/quotes/:id", "quotes:write", "required", patchRoute, { maxCalls: 40 }),
  R("POST", "/quotes/:id/send", "quotes:send", "required", sendRoute, { maxCalls: 60 }),
  R("POST", "/quotes/:id/approve", "quotes:write", "required", approveRoute, { mode: "run", maxCalls: 80 }),
  R("POST", "/quotes/:id/convert", "quotes:write", "required", convertRoute, { mode: "run", maxCalls: 40 }),
  R("POST", "/quotes/:id/present", "quotes:send", "required", presentRoute, { maxCalls: 60, secret: true, idempotent: false }),
  R("GET", "/quotes/:id/versions", "quotes:read", "required", versionsRoute),
  R("GET", "/quotes/:id/versions/:vid", "quotes:read", "required", versionRoute),
  R("POST", "/quotes/:id/archive", "quotes:write", "required", lifecycle((ctx) => archiveQuote(ctx.params.id, { reason: "manual" }, ctx)), { maxCalls: 40 }),
  R("POST", "/quotes/:id/restore", "quotes:write", "required", lifecycle((ctx) => restoreQuote(ctx.params.id, ctx)), { maxCalls: 40 }),
  R("POST", "/quotes/:id/decline", "quotes:write", "required", lifecycle((ctx) => declineQuote(ctx.params.id, { reason: ctx.body && ctx.body.reason }, ctx)), { maxCalls: 40 }),
  R("POST", "/quotes/:id/duplicate", "quotes:write", "required", async (ctx) => { const r = await duplicateQuote(ctx.params.id, ctx.body || {}, ctx); return { data: strip(r.data), etag: r.etag, status: 201 }; }, { maxCalls: 40 }),
  R("GET", "/quotes/:id/preview", "quotes:read", "required", previewRoute),
];

export { W };
