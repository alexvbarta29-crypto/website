// Quotes module: the quote lifecycle (design §5.3 "Quote state machine").
//
//   draft ──send──▶ sent ──portal beacon──▶ viewed
//   sent/viewed ──edit──▶ draft (the portal keeps the sent version until a re-send)
//   sent/viewed ──approve (approve.mjs, a run)──▶ approved ──convert──▶ converted
//   sent/viewed ──changes──▶ changes_requested      sent/viewed ──decline──▶ declined
//   any but converted ──archive──▶ archived         archived/declined ──restore──▶ draft
//
// Every change goes through updateRecord (CAS; a person's PATCH carries
// If-Match and gets 412 when someone else changed it), emits its quote.*
// event after the write (Sales listens: deal status and cadences), keeps the
// contact's `quotes` stats part (services quoted, open quote) and adds the
// customer-visible steps to the contact's timeline. Automation (the cadence
// offer and archive steps, quotes.expire) only reports on a quote the import
// brought in before cutover (§0 rule 12): a would- row, never a change.

import { randomBytes } from "node:crypto";
import { createRecord, getRecord, updateRecord, updateStats, readIndex, getSetting, addActivity, nextNumber } from "../../../crm-store.mjs";
import { deriveId, isId } from "../../core/ids.mjs";
import { now, nowIso, localDate } from "../../core/clock.mjs";
import { InputError, NotFoundError, ConflictError, ForbiddenError, ExistsError } from "../../core/errors.mjs";
import { emit } from "../../core/events.mjs";
import { has, call } from "../../core/services.mjs";
import { actorKindOf } from "../../core/guard.mjs";
import { guardFor } from "../../core/context.mjs";
import { readSysMode } from "../../core/settings.mjs";
import { wouldAct } from "../../core/activity.mjs";
import { notify, approvers } from "../../core/notify.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { pricingWith, optionTotals, PLAN_CATALOG, lineTotal } from "./pricing.mjs";
import { OPEN_STATUSES, MAX_OPTIONS, numberLabel, LINE_ID_RE, OPTION_ID_RE, DISCOUNT_ID_RE } from "./types.mjs";
import { freezeVersion } from "./versions.mjs";

export const W = (ctx = {}) => (typeof ctx.write === "function" ? ctx.write() : ctx);
const B32 = "0123456789abcdefghjkmnpqrstvwxyz";
const rand = (n) => [...randomBytes(n)].map((b) => B32[b & 31]).join("");
export const newLineId = () => `ln_${rand(14)}`;
export const newOptionId = () => `op_${rand(8)}`;
export const newDiscountId = () => `dc_${rand(10)}`;
const clone = (v) => JSON.parse(JSON.stringify(v));
export const strip = (r) => { if (!r) return r; const { _w, _etag, ...rest } = r; return rest; };

export async function loadPricing() {
  return pricingWith(await getSetting("pricing").catch(() => ({})));
}

// The price book and the discount catalog as the engine and the builder use them (one index read each).
export async function priceBook() {
  const ix = await readIndex("pricebook", "");
  return ix.rows.map((r) => ({ id: r.id, key: r.k, name: r.nm, category: r.cat, unit: r.u, unit_cents: r.uc, engine: r.e, active: r.act, sellable: r.sell, service_type: r.st, description: r.ds || "", show: r.sh || { qty: r.u !== "flat", unit: r.u !== "flat", description: true } }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
export async function discountDefs() {
  const ix = await readIndex("discounts", "");
  return ix.rows.map((r) => ({ id: r.id, key: r.k, name: r.nm, type: r.t, value: r.v, default_scope: r.sc, sellable: r.sell, active: r.act, plan_only: r.po, stack_group: r.sg, offer: r.of, typed_amount: r.ta }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ------------------------------------------------------------ the guard

// Is this write allowed (§0 rule 12)? People, the portal and the import
// always; automation only on a quote the CRM made (or a test contact's).
export async function mayActOnQuote(ctx, quote) {
  const w = W(ctx);
  if (actorKindOf(w) !== "automation") return true;
  const mode = (ctx && ctx.mode) || w.mode || await readSysMode();
  return guardFor(mode).mayAct({ record: quote });
}
const would = (ctx, quote, action, changes) => (ctx && typeof ctx.would === "function" ? ctx.would(quote.id, action, changes) : wouldAct({ key: "quotes", subject: quote.id, action, changes })).catch(() => {});

// ------------------------------------------------------------ options

export const servicesOf = (options) => [...new Set((options || []).flatMap((o) => (o.lines || []).map((l) => l.service_type)).filter(Boolean))].slice(0, 20);

export function emptyOption(kind = "one_time", name) {
  const o = { id: newOptionId(), name: name || (kind === "plan" ? "Quarterly plan" : "One-time"), kind, recommended: false, lines: [], discounts: [] };
  if (kind === "plan") { const c = PLAN_CATALOG.quarterly; o.plan = { catalog_key: "quarterly", frequency: { ...c.frequency }, visits_per_year: c.visits_per_year, term_months: 12, billing: "barta_standard", autopay: true, auto_renew: true }; }
  return o;
}

const sameOverride = (a, b) => !!a && !!b && a.cents === b.cents && String(a.reason || "") === String(b.reason || "");

// Ids for whatever is new, the price-override permission (a line whose
// override is new or changed needs prices:override and a reason), plan
// defaults from the catalog, and every option's totals.
// defs (the discount catalog): a catalog discount takes its stack group, and
// two discounts of one group can't be on one option (D15).
export function normalizeOptions(options, { pricing, before = [], user = null, canOverride = false, defs = null } = {}) {
  if (!Array.isArray(options)) throw new InputError("Expected the options.", "options");
  if (options.length > MAX_OPTIONS) throw new InputError(`Up to ${MAX_OPTIONS} options.`, "options");
  const prevLines = new Map();
  for (const o of before || []) for (const l of o.lines || []) prevLines.set(`${o.id}|${l.id}`, l);
  const optIds = new Set();
  return options.map((src, oi) => {
    const o = src && typeof src === "object" ? clone(src) : {};
    if (!OPTION_ID_RE.test(String(o.id || "")) || optIds.has(o.id)) o.id = newOptionId();
    optIds.add(o.id);
    o.kind = o.kind === "plan" ? "plan" : "one_time";
    if (o.kind === "plan") {
      const key = o.plan && Object.hasOwn(PLAN_CATALOG, o.plan.catalog_key) ? o.plan.catalog_key : "quarterly";
      const c = PLAN_CATALOG[key];
      o.plan = { frequency: { ...c.frequency }, visits_per_year: c.visits_per_year, term_months: 12, billing: key === "lights_annual" ? "after_visit" : "barta_standard", autopay: key !== "lights_annual", auto_renew: true, ...(o.plan || {}), catalog_key: key };
    } else delete o.plan;
    const ids = new Set();
    o.lines = (Array.isArray(o.lines) ? o.lines : []).map((l0, li) => {
      const l = l0 && typeof l0 === "object" ? { ...l0 } : {};
      if (!LINE_ID_RE.test(String(l.id || "")) || ids.has(l.id)) l.id = newLineId();
      ids.add(l.id);
      const prev = prevLines.get(`${o.id}|${l.id}`);
      if (l.override === null || l.override === undefined) delete l.override;
      else if (!(prev && sameOverride(prev.override, l.override))) {
        if (!canOverride) throw new ForbiddenError("Changing a price needs the price override permission.");
        if (!String(l.override.reason || "").trim()) throw new InputError("Say why the price changed.", `options.${oi}.lines.${li}.override.reason`);
        l.override = { cents: l.override.cents, reason: String(l.override.reason).trim().slice(0, 200), by: user || "system", at: nowIso() };
      } else l.override = { ...prev.override };
      l.total_cents = lineTotal(l);
      return l;
    });
    const dids = new Set();
    const groups = new Map();
    o.discounts = (Array.isArray(o.discounts) ? o.discounts : []).map((d0, di) => {
      const d = d0 && typeof d0 === "object" ? { ...d0 } : {};
      if (!DISCOUNT_ID_RE.test(String(d.id || "")) || dids.has(d.id)) d.id = newDiscountId();
      dids.add(d.id);
      const def = Array.isArray(defs) ? defs.find((x) => (d.def_id && x.id === d.def_id) || (d.key && x.key === d.key)) : null;
      if (def) { if (def.stack_group) d.stack_group = def.stack_group; else delete d.stack_group; if (!d.def_id) d.def_id = def.id; if (!d.key) d.key = def.key; }
      if (d.stack_group) {
        if (groups.has(d.stack_group)) throw new InputError(`${groups.get(d.stack_group)} and ${d.name || "that discount"} can't be combined.`, `options.${oi}.discounts.${di}`);
        groups.set(d.stack_group, d.name || "A discount");
      }
      return d;
    });
    o.totals = optionTotals(o, pricing);
    return o;
  });
}

// What a person may send in (POST/PATCH): the editable fields only.
export const EDITABLE = Object.freeze(["options", "client_notes", "internal_notes", "property_id", "deal_id", "agreement", "photo_ids", "mockup_file_ids", "selected_option_id"]);

// ------------------------------------------------------------ events, stats, timeline

export async function emitQuote(name, quote, extra = {}, ctx = {}) {
  try {
    await emit(name, { id: quote.id, wv: quote.wv, quote_id: quote.id, version_id: quote.current_version_id || null, contact_id: quote.contact_id, deal_id: quote.deal_id || null, ...extra }, W(ctx));
  } catch (e) {
    console.error(`crm:quotes: ${name} not queued (${safeErr(e)})`);
  }
}

export async function touchStats(quote, ctx = {}) {
  try {
    await updateStats(quote.contact_id, "quotes", (p) => {
      const ids = new Set(Array.isArray(p.open_ids) ? p.open_ids : []);
      if (OPEN_STATUSES.includes(quote.status) && !quote.deleted_at) ids.add(quote.id); else ids.delete(quote.id);
      const svc = [...new Set([...(p.svc_q || []), ...(quote.services || [])])].slice(0, 20);
      const open_ids = [...ids].slice(-50);
      return { ...p, open_ids, open_quote: open_ids.length > 0, svc_q: svc, last_quote_at: quote.sent_at || p.last_quote_at || null };
    }, W(ctx));
  } catch (e) {
    console.error(`crm:quotes: stats not updated (${safeErr(e)})`);
  }
}

export const timeline = (quote, kind) => addActivity(quote.contact_id, kind, quote.id, now()).catch(() => {});

// ------------------------------------------------------------ reads

export async function getQuote(id) {
  if (!isId(id, "quote")) throw new NotFoundError("That quote isn't there.");
  const g = await getRecord("quote", id);
  if (!g || g.data.deleted_at) throw new NotFoundError("That quote isn't there.");
  return { data: g.data, etag: g.etag };
}

async function contactFor(id) {
  if (!isId(id, "contact")) throw new InputError("Pick who the quote is for.", "contact_id");
  let g = await getRecord("contact", id);
  if (g && g.data.merged_into && isId(g.data.merged_into, "contact")) g = await getRecord("contact", g.data.merged_into);
  if (!g || g.data.deleted_at) throw new NotFoundError("That contact isn't there anymore.");
  return g.data;
}
export const contactName = (c) => (c ? c.display_name || [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || c.company_name || "No name" : "");

async function checkProperty(propertyId, contactId) {
  if (propertyId === undefined || propertyId === null || propertyId === "") return undefined;
  if (!isId(propertyId, "property")) throw new InputError("That isn't a property.", "property_id");
  const g = await getRecord("property", propertyId);
  if (!g || g.data.deleted_at || g.data.contact_id !== contactId) throw new InputError("That property isn't theirs.", "property_id");
  return propertyId;
}

// The contact's newest open deal (Sales' deals/open index), when there is one.
async function openDealOf(contactId) {
  try {
    const ix = await readIndex("deals/open", "");
    const rows = ix.rows.filter((r) => r.c === contactId && ["open", "quoted"].includes(r.st)).sort((a, b) => String(b.op || "").localeCompare(String(a.op || "")));
    return rows[0] ? rows[0].id : undefined;
  } catch { return undefined; }
}

// ------------------------------------------------------------ create, edit, duplicate

// POST /quotes. A client id makes a double tap (or an offline replay) one quote.
export async function createQuote(body = {}, ctx) {
  const contact = await contactFor(body.contact_id);
  const id = body.client_id ? deriveId("quote", `c:${String(body.client_id).slice(0, 80)}`) : undefined;
  if (id) {
    const had = await getRecord("quote", id);
    if (had) return { data: had.data, etag: had.etag, existed: true };
  }
  const quoteId = id || deriveId("quote", `n:${randomBytes(12).toString("hex")}`);
  const property_id = await checkProperty(body.property_id, contact.id);
  let deal_id = body.deal_id;
  if (deal_id !== undefined && deal_id !== null && deal_id !== "") {
    if (!isId(deal_id, "deal")) throw new InputError("That isn't a deal.", "deal_id");
    const d = await getRecord("deal", deal_id);
    if (!d || d.data.contact_id !== contact.id) throw new InputError("That deal isn't theirs.", "deal_id");
  } else deal_id = await openDealOf(contact.id);
  const [pricing, defs] = await Promise.all([loadPricing(), discountDefs().catch(() => [])]);
  const mode = typeof ctx.sysMode === "function" ? await ctx.sysMode() : await readSysMode();
  const seq = mode.system_of_record === "crm" ? "quote" : "quote-shadow";
  const options = normalizeOptions(Array.isArray(body.options) && body.options.length ? body.options : [{ ...emptyOption("one_time", "One-time"), recommended: true }], { pricing, defs, user: ctx.user && ctx.user.id, canOverride: ctx.can ? ctx.can("prices:override") : false });
  const number = await nextNumber(seq, { id: quoteId });
  const data = {
    id: quoteId, number, number_seq: seq, contact_id: contact.id, contact_name: contactName(contact), status: "draft",
    ...(property_id ? { property_id } : contact.primary_property_id ? { property_id: contact.primary_property_id } : {}),
    ...(deal_id ? { deal_id } : {}), options, agreement: { require_card: false, deposit: { type: "none", value: 0 }, ...(body.agreement || {}) },
    client_notes: body.client_notes || "", internal_notes: body.internal_notes || "", photo_ids: [], mockup_file_ids: [], sent_via: [], approvals_count: 0, versions_n: 0,
    sold_by: (ctx.user && ctx.user.id) || "system", services: servicesOf(options), offers: [],
  };
  data.number_label = numberLabel(data);
  try {
    const r = await createRecord("quote", data, W(ctx));
    await touchStats(r.data, ctx);
    return r;
  } catch (e) {
    if (e instanceof ExistsError) { const g = await getRecord("quote", quoteId); if (g) return { data: g.data, etag: g.etag, existed: true }; }
    throw e;
  }
}

// PATCH /quotes/:id (If-Match). A sent or viewed quote goes back to draft;
// the portal keeps showing the version that was sent until the next send.
export async function patchQuote(id, body = {}, ctx) {
  const cur = await getQuote(id);
  const q0 = cur.data;
  if (["approved", "converted"].includes(q0.status)) throw new ConflictError("An approved quote can't change. Duplicate it to make a new one.");
  if (["archived", "declined"].includes(q0.status)) throw new ConflictError("Restore this quote first.");
  const [pricing, defs] = await Promise.all([loadPricing(), discountDefs().catch(() => [])]);
  const patch = {};
  for (const k of EDITABLE) if (body[k] !== undefined) patch[k] = body[k];
  if (patch.property_id !== undefined) patch.property_id = await checkProperty(patch.property_id, q0.contact_id) || null;
  if (patch.deal_id !== undefined && patch.deal_id !== null) {
    if (!isId(patch.deal_id, "deal")) throw new InputError("That isn't a deal.", "deal_id");
  }
  if (patch.agreement !== undefined && !has("money.createDepositInvoice")) {
    // before Money (M5) deposits and "require card" are hidden (§11.3): keep what's stored
    patch.agreement = { ...(q0.agreement || {}), ...(patch.agreement || {}), require_card: !!(q0.agreement && q0.agreement.require_card), deposit: (q0.agreement && q0.agreement.deposit) || { type: "none", value: 0 } };
  }
  const options = patch.options !== undefined ? normalizeOptions(patch.options, { pricing, defs, before: q0.options, user: ctx.user && ctx.user.id, canOverride: ctx.can ? ctx.can("prices:override") : false }) : null;
  const r = await updateRecord("quote", id, (q) => {
    if (["approved", "converted", "archived", "declined"].includes(q.status)) throw new ConflictError("This quote changed. Reload it.");
    const next = { ...q, ...patch };
    if (patch.property_id === null) delete next.property_id;
    if (options) { next.options = options; next.services = servicesOf(options); }
    if (["sent", "viewed", "changes_requested"].includes(q.status)) next.status = "draft";
    return next;
  }, { ...W(ctx), ifMatch: ctx.ifMatch });
  await touchStats(r.data, ctx);
  return r;
}

// POST /quotes/:id/duplicate: a new draft with the same options (new ids), for the same contact.
export async function duplicateQuote(id, body = {}, ctx) {
  const { data: q } = await getQuote(id);
  const options = (q.options || []).map((o) => ({ ...clone(o), id: newOptionId(), lines: (o.lines || []).map((l) => ({ ...clone(l), id: newLineId() })), discounts: (o.discounts || []).filter((d) => !d.offer).map((d) => ({ ...clone(d), id: newDiscountId() })) }));
  return createQuote({
    client_id: body.client_id || `dup:${id}:${randomBytes(6).toString("hex")}`, contact_id: q.contact_id, property_id: q.property_id, deal_id: q.deal_id,
    options, client_notes: q.client_notes, internal_notes: q.internal_notes,
  }, { ...ctx, can: () => true });
}

// ------------------------------------------------------------ send

// A line the engine couldn't price and nobody priced (over 100 panes, gutters).
const unpriced = (l) => !l.override && (l.unit_cents || 0) === 0 && (l.qty_milli || 0) > 0 && ["windows_ext", "windows_int", "gutters"].includes(l.category);

export function checkSendable(q) {
  if (!(q.options || []).length) throw new InputError("Add an option first.", "options");
  for (const [i, o] of q.options.entries()) {
    if (!(o.lines || []).length) throw new InputError(`${o.name || "An option"} has no lines yet.`, `options.${i}.lines`);
    const l = o.lines.find(unpriced);
    if (l) throw new InputError(`Price ${l.title} before sending.`, `options.${i}.lines`);
  }
}

// Freezes a version (or keeps the current one) and marks the quote sent.
// channels [] = shown in person or approved by phone (no message goes out).
// → { quote, version, created }
export async function sendQuote(id, { channels = [], first_send_note } = {}, ctx) {
  const chans = [...new Set((Array.isArray(channels) ? channels : []).filter((c) => ["sms", "email"].includes(c)))];
  const { data: q0 } = await getQuote(id);
  if (!["draft", "sent", "viewed", "changes_requested"].includes(q0.status)) throw new ConflictError(q0.status === "approved" || q0.status === "converted" ? "This quote is already approved." : "Restore this quote first.");
  checkSendable(q0);
  const pricing = await loadPricing();
  // totals as they are now (a pricing change since the last save)
  const options = normalizeOptions(q0.options, { pricing, before: q0.options, user: null, canOverride: true });
  const { version, created } = await freezeVersion({ ...q0, options }, { channels: chans, pricing, ctx: W(ctx) });
  const at = nowIso();
  const r = await updateRecord("quote", id, (q) => {
    if (!["draft", "sent", "viewed", "changes_requested"].includes(q.status)) throw new ConflictError("This quote changed. Reload it.");
    const next = { ...q, options, current_version_id: version.id, versions_n: Math.max(q.versions_n || 0, version.n), expires_on: version.expires_on || q.expires_on, terms_version: version.terms_version };
    if (chans.length) { next.sent_at = at; next.sent_via = chans; }
    else if (!q.sent_at) next.sent_at = at;
    next.status = created || q.status === "draft" || q.status === "changes_requested" ? "sent" : q.status;
    return next;
  }, W(ctx));
  const q = r.data;
  await Promise.all([
    emitQuote("quote.sent", q, { channels: chans, version_n: version.n, created_version: created }, ctx),
    touchStats(q, ctx),
    chans.length ? timeline(q, "quote.sent") : null,
  ]);
  return { quote: q, etag: r.etag, version, created };
}

// ------------------------------------------------------------ the customer's answers

// The portal beacon (§8.1: a POST after load, never the GET; bot user agents
// never reach here): sent → viewed, viewed_at the first time.
export async function markViewed(id, { version_id } = {}, ctx) {
  const g = await getRecord("quote", id).catch(() => null);
  if (!g || g.data.deleted_at) return { changed: false };
  const q0 = g.data;
  const t = nowIso();
  const stale = !q0.last_viewed_at || Date.parse(t) - Date.parse(q0.last_viewed_at) > 3600000;
  if (q0.status !== "sent" && !stale) return { changed: false };
  if (version_id && q0.current_version_id && version_id !== q0.current_version_id) return { changed: false };
  const r = await updateRecord("quote", id, (q) => {
    if (q.status === "sent") return { ...q, status: "viewed", viewed_at: q.viewed_at || t, last_viewed_at: t };
    if (!q.last_viewed_at || Date.parse(t) - Date.parse(q.last_viewed_at) > 3600000) return { ...q, last_viewed_at: t };
    return null;
  }, W(ctx));
  if (r.changed && q0.status === "sent" && r.data.status === "viewed") await emitQuote("quote.viewed", r.data, {}, ctx);
  return { changed: r.changed, status: r.data.status };
}

const ANSWERABLE = ["sent", "viewed"];

async function staffToTell(q) {
  const people = new Set(await approvers().catch(() => []));
  if (isId(q.sold_by, "user")) people.add(q.sold_by);
  return [...people].slice(0, 10);
}
const firstOf = (q) => String(q.contact_name || "").split(/\s+/)[0] || "A customer";

// POST /api/portal/quotes/:id/changes {message}: the customer asks for changes.
export async function requestChanges(id, { message } = {}, ctx) {
  const text = String(message ?? "").trim();
  if (!text) throw new InputError("Tell us what you'd like changed.", "message");
  if (text.length > 2000) throw new InputError("Keep it under 2,000 characters.", "message");
  const { data: q0 } = await getQuote(id);
  if (q0.status === "changes_requested") return { quote: q0, already: true };
  if (!ANSWERABLE.includes(q0.status)) throw new ConflictError("This quote can't take changes right now. Call or text us.");
  const r = await updateRecord("quote", id, (q) => {
    if (!ANSWERABLE.includes(q.status)) throw new ConflictError("This quote changed.");
    return { ...q, status: "changes_requested", changes_requested_at: nowIso(), change_message: text };
  }, W(ctx));
  const q = r.data;
  await Promise.all([
    emitQuote("quote.changes_requested", q, {}, ctx),
    touchStats(q, ctx),
    timeline(q, "quote.changes_requested"),
    staffToTell(q).then((ids) => notify(ids, { kind: "changes_requested", title: `${firstOf(q)} asked for changes`, body: `On quote ${q.number_label}.`, link: `/quotes/${q.id}` }, W(ctx))).catch(() => {}),
  ]);
  return { quote: q };
}

// Decline (the customer in the portal, or staff for them).
export async function declineQuote(id, { reason } = {}, ctx) {
  const why = String(reason ?? "").trim().slice(0, 500);
  const { data: q0 } = await getQuote(id);
  if (q0.status === "declined") return { quote: q0, already: true };
  const allowed = actorKindOf(W(ctx)) === "portal" ? ANSWERABLE : ["draft", "sent", "viewed", "changes_requested"];
  if (!allowed.includes(q0.status)) throw new ConflictError("This quote can't be declined now.");
  const r = await updateRecord("quote", id, (q) => {
    if (!allowed.includes(q.status)) throw new ConflictError("This quote changed.");
    return { ...q, status: "declined", declined_at: nowIso(), ...(why ? { decline_reason: why } : {}) };
  }, W(ctx));
  const q = r.data;
  await Promise.all([emitQuote("quote.declined", q, why ? { reason: why } : {}, ctx), touchStats(q, ctx), timeline(q, "quote.declined")]);
  return { quote: q, etag: r.etag };
}

// ------------------------------------------------------------ archive, restore

// Removes the estimate follow-up's offers from the live options (§5.3:
// "offers end on archive"; the playbook's day-4 text says they expire).
export function withoutOffers(options) {
  return (options || []).map((o) => ({ ...o, lines: (o.lines || []).filter((l) => !l.offer), discounts: (o.discounts || []).filter((d) => !d.offer) }));
}

// Archive: any status but converted. reason: manual | cadence_expired | superseded | expired.
// Automation on an imported quote only reports (would-archive).
export async function archiveQuote(id, { reason = "manual" } = {}, ctx) {
  const { data: q0 } = await getQuote(id);
  if (q0.status === "archived") return { quote: q0, already: true };
  if (q0.status === "converted") throw new ConflictError("A converted quote stays as it is.");
  if (!(await mayActOnQuote(ctx, q0))) {
    await would(ctx, q0, "archive", { status: [q0.status, "archived"] });
    return { quote: q0, would: true };
  }
  const pricing = await loadPricing();
  const r = await updateRecord("quote", id, (q) => {
    if (q.status === "archived" || q.status === "converted") return null;
    const options = (q.offers || []).length ? normalizeOptions(withoutOffers(q.options), { pricing, before: q.options, canOverride: true }) : q.options;
    return { ...q, options, offers: [], status: "archived", archived_at: nowIso(), archive_reason: reason, archived_from: q.status };
  }, W(ctx));
  const q = r.data;
  if (r.changed) await Promise.all([emitQuote("quote.archived", q, { reason }, ctx), touchStats(q, ctx)]);
  return { quote: q, etag: r.etag };
}

// Restore: archived or declined → draft.
export async function restoreQuote(id, ctx) {
  const { data: q0 } = await getQuote(id);
  if (!["archived", "declined"].includes(q0.status)) throw new ConflictError("Only an archived or declined quote can be restored.");
  const r = await updateRecord("quote", id, (q) => {
    if (!["archived", "declined"].includes(q.status)) return null;
    const next = { ...q, status: "draft", restored_at: nowIso() };
    delete next.archived_at; delete next.archive_reason; delete next.declined_at; delete next.decline_reason; delete next.archived_from;
    return next;
  }, W(ctx));
  await touchStats(r.data, ctx);
  return { quote: r.data, etag: r.etag };
}

// ------------------------------------------------------------ the estimate follow-up's offers (Sales calls these)

// quotes.applyOffer(quote_id, offer, { enrollment_id }, ctx): "followup_50"
// ($50 off the first visit of every option) or "ten_free_screens" (10
// screens free: a $50 discount on the screen line, or the screens added at
// no charge). The portal shows it at once: an applied offer freezes a new
// version of a sent quote (no message goes out; the cadence's own text
// tells the customer).
export async function applyOffer(quoteId, offer, opts = {}, ctx = {}) {
  if (!["followup_50", "ten_free_screens"].includes(offer)) throw new InputError("Unknown offer.", "offer");
  const { data: q0 } = await getQuote(quoteId);
  if ((q0.offers || []).includes(offer)) return { applied: false, already: true };
  if (!["draft", "sent", "viewed", "changes_requested"].includes(q0.status)) return { applied: false, closed: true };
  if (!(await mayActOnQuote(ctx, q0))) {
    await would(ctx, q0, `offer_${offer}`, { offers: [(q0.offers || []).join(",") || null, offer] });
    return { applied: false, would: true };
  }
  const pricing = await loadPricing();
  const defs = await discountDefs().catch(() => []);
  const def = defs.find((d) => d.key === offer);
  const each = pricing.screens.each_cents;
  const options = (q0.options || []).map((o) => {
    const x = clone(o);
    if (offer === "followup_50") {
      x.discounts.push({ id: newDiscountId(), ...(def ? { def_id: def.id } : {}), key: "followup_50", name: (def && def.name) || "Estimate follow-up", type: "fixed", value: (def && def.value) || 5000, scope: { type: "initial" }, offer });
    } else {
      const scr = x.lines.find((l) => l.category === "screens");
      const free = 10 * each;
      if (scr) {
        const value = Math.min(free, Math.max(0, scr.total_cents || lineTotal(scr)));
        if (value > 0) x.discounts.push({ id: newDiscountId(), ...(def ? { def_id: def.id } : {}), key: "ten_free_screens", name: (def && def.name) || "10 free screens", type: "fixed", value, scope: { type: "initial" }, offer });
      } else {
        x.lines.push({ id: newLineId(), title: "Screen Cleaning (10 screens)", description: "10 screens cleaned free.", qty_milli: 10000, unit_cents: each, scope: { type: "initial" }, category: "screens", unit: "screen", show: { qty: true, unit: true, description: true }, offer });
        x.discounts.push({ id: newDiscountId(), ...(def ? { def_id: def.id } : {}), key: "ten_free_screens", name: (def && def.name) || "10 free screens", type: "fixed", value: free, scope: { type: "initial" }, offer });
      }
    }
    return x;
  });
  const norm = normalizeOptions(options, { pricing, before: q0.options, canOverride: true });
  const r = await updateRecord("quote", quoteId, (q) => {
    if ((q.offers || []).includes(offer)) return null;
    return { ...q, options: norm, offers: [...(q.offers || []), offer] };
  }, W(ctx));
  let version = null;
  if (r.changed && r.data.current_version_id && ["sent", "viewed"].includes(r.data.status)) {
    try { version = (await sendQuote(quoteId, { channels: [] }, ctx)).version; } catch (e) { console.error(`crm:quotes: offer not frozen into a version (${safeErr(e)})`); }
  }
  return { applied: r.changed, version_id: version ? version.id : null, enrollment_id: opts.enrollment_id || null };
}

// quotes.archive(quote_id, { reason, enrollment_id }, ctx): the cadence's day-4 archive step.
export async function archiveForSales(quoteId, opts = {}, ctx = {}) {
  const reason = opts.reason === "no_response" || opts.reason === "cadence_expired" ? "cadence_expired" : ["manual", "superseded", "expired"].includes(opts.reason) ? opts.reason : "cadence_expired";
  const out = await archiveQuote(quoteId, { reason }, ctx);
  return { archived: !out.would && !!out.quote && out.quote.status === "archived", would: !!out.would };
}

// ------------------------------------------------------------ quotes.expire (daily 02:10)

// Open quotes past expires_on are archived ("expired"); before cutover a
// quote the import brought in only gets a would- row (§0 rule 12).
export async function expireSweep(sctx = {}) {
  const today = localDate(now());
  const ix = await readIndex("quotes", "open");
  const due = ix.rows.filter((r) => ["sent", "viewed", "changes_requested"].includes(r.st) && r.exp && r.exp < today).sort((a, b) => (a.id < b.id ? -1 : 1));
  let progress = 0;
  for (const row of due) {
    if (sctx.cursor && row.id <= sctx.cursor) continue;
    if (sctx.budget && sctx.budget.left() < 5000) return { done: false, cursor: row.id, progress };
    try {
      const r = await archiveQuote(row.id, { reason: "expired" }, sctx);
      if (r.would || (r.quote && r.quote.status === "archived")) progress += 1;
    } catch (e) {
      console.error(`crm:quotes: a quote didn't expire (${safeErr(e)})`);
    }
  }
  return { progress, result: `${progress} expired` };
}

// ------------------------------------------------------------ merge (§5.1: every module's onMerge)

export async function onMergeQuotes(survivorId, mergedId, ctx = {}) {
  const { listRel } = await import("../../../crm-store.mjs");
  const rows = await listRel("contact-quotes", mergedId, { limit: 500 });
  const survivor = await getRecord("contact", survivorId).catch(() => null);
  for (const row of rows) {
    await updateRecord("quote", row.id, (q) => (q.contact_id === mergedId ? { ...q, contact_id: survivorId, ...(survivor ? { contact_name: contactName(survivor.data) } : {}) } : null), W(ctx)).catch((e) => {
      if (!(e instanceof NotFoundError)) throw e;
    });
  }
  return { moved: rows.length };
}

export { has, call };
