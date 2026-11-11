// Plans module: agreement templates and agreements (design §5.4
// "Agreements", §8.1 /p/agreement, decision D10).
//
//   templates      six drafts seeded once (texts.mjs); an owner edits and
//                  approves them (agreement_templates:edit). An edit after
//                  approval is a new version that needs approving again; a
//                  draft with an "Owner check" line left can't be approved.
//                  Nothing is sent, or shown on a quote, from a template that
//                  isn't approved. Seed v2 upgrades the untouched first drafts.
//   agreementForOption(quote, draft, option)  the plans.agreementForOption
//                  service: the approved text for a quote's plan option,
//                  frozen into the quote's version and signed with the quote
//                  (one signature, the same body_sha256). null when there is
//                  no approved template: the quote page then says the
//                  agreement comes separately.
//   agreements     the frozen text a customer signs (status draft → sent →
//                  viewed → signed, or void). Staff create and send one for a
//                  plan (agreement.sent automation: a 30-day link by text or
//                  email); quote approvals create them signed; the customer
//                  signs on /p/agreement/:id (or in person on the staff
//                  phone, a present link): name, an optional drawn signature,
//                  "I agree"; the record keeps the text's hash, time, IP hash
//                  and browser.

import { createHash } from "node:crypto";
import { createRecord, getRecord, updateRecord, readIndex, listRel, getRecords, getSetting, patchRecord } from "../../../crm-store.mjs";
import { deriveId, isId, newId } from "../../core/ids.mjs";
import { nowIso } from "../../core/clock.mjs";
import { InputError, NotFoundError, ConflictError, ExistsError } from "../../core/errors.mjs";
import { emit } from "../../core/events.mjs";
import { fill, parseTemplate, VARIABLES } from "../../core/templates.mjs";
import { storeImportedFile, sniffType } from "../../core/files.mjs";
import { notify, approvers } from "../../core/notify.mjs";
import { formatCents } from "../../core/money.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { AGREEMENT_DRAFTS, OWNER_CHECK, PREVIOUS_DRAFT_SHAS, PREVIOUS_TEMPLATE_BODIES, TEMPLATES as MESSAGE_TEMPLATES } from "./texts.mjs";
import { templateApproved, OPEN_AGREEMENT } from "./types.mjs";
import { loadCatalog, perksList, catalogWith } from "./catalog.mjs";
import { cyclePrices, regularPrices, visitsPerYearOf, clawbackCents } from "./machine.mjs";

export const sha = (s) => createHash("sha256").update(String(s)).digest("hex");
export const W = (ctx = {}) => (ctx && typeof ctx.write === "function" ? ctx.write() : { ...(ctx || {}) });
export const MAX_SIGNATURE_BYTES = 200 * 1024;
export const AGREEMENT_VARS = Object.freeze([
  "legal_name", "company_name", "full_name", "first_name", "last_name", "plan_name", "per_visit_price", "visits_per_year", "term_months", "perks_list", "clawback_amount",
  "notice_days", "late_cancel_fee", "company_phone", "company_email",
  // the agreement's own (not message variables): the plan's real terms
  "price_details", "addon_note", "visit_schedule", "renewal_terms", "billing_terms", "clawback_terms",
]);
// The agreement's own variables, with a sample each (the template screen's chips).
export const AGREEMENT_ONLY_VARS = Object.freeze(["price_details", "addon_note", "visit_schedule", "renewal_terms", "billing_terms", "clawback_terms"]);
const strip = (r) => { if (!r) return r; const { _w, ...rest } = r; return rest; };

// ------------------------------------------------------------ templates

export const seedTemplateId = (key) => deriveId("agreement_template", "seed:agreement", "plans", key);

// The system.seed run: the five drafts once (onlyIfNew; an owner's edits are never overwritten).
export async function seedAgreementTemplates(ctx = {}) {
  let made = 0;
  for (const d of AGREEMENT_DRAFTS) {
    try {
      await createRecord("agreement_template", { id: seedTemplateId(d.key), ...d, version: 1, active: true, seeded: true }, W(ctx));
      made += 1;
    } catch (e) { if (!(e instanceof ExistsError)) throw e; }
  }
  return { made };
}

// A template body's problems: unknown variables, broken braces (→ InputError).
export function checkBody(body) {
  const { variables, errors } = parseTemplate(body, { field: "body_md" });
  const bad = errors.find((e) => e.code !== "stop_text" && !(e.code === "unknown_variable" && AGREEMENT_ONLY_VARS.includes(e.variable)));
  if (bad) throw new InputError(bad.message, "body_md");
  const unknown = variables.find((v) => !AGREEMENT_VARS.includes(v));
  if (unknown) throw new InputError(`{{${unknown}}} isn't one of the agreement's variables.`, "body_md");
}

// The "Owner check" lines left in a body (texts.mjs): wording to confirm before approving.
export const ownerChecksIn = (body) => String(body || "").split("\n").filter((l) => l.trim().startsWith(OWNER_CHECK)).map((l) => l.trim().slice(OWNER_CHECK.length).trim());
export const withoutOwnerChecks = (body) => String(body || "").split("\n").filter((l) => !l.trim().startsWith(OWNER_CHECK)).join("\n").replace(/\n{3,}/g, "\n\n").trim();

// Seed v2: the untouched first drafts become the current ones (a new
// version, so an approval lapses and the owner reads them again), the
// Custom text arrives, Biannual stops covering Custom, and the price-change
// text loses its doubled "a visit". An owner's edits are never overwritten.
export async function upgradeAgreementDrafts(ctx = {}) {
  let upgraded = 0;
  for (const d of AGREEMENT_DRAFTS) {
    const id = seedTemplateId(d.key);
    const g = await getRecord("agreement_template", id);
    if (!g) {
      try { await createRecord("agreement_template", { id, ...d, version: 1, active: true, seeded: true }, W(ctx)); upgraded += 1; } catch (e) { if (!(e instanceof ExistsError)) throw e; }
      continue;
    }
    const t = g.data;
    const stale = (PREVIOUS_DRAFT_SHAS[d.key] || []).includes(sha(t.body_md));
    const keys = (t.applies_to && t.applies_to.catalog_keys) || [];
    const fixKeys = keys.filter((k) => d.applies_to.catalog_keys.includes(k) || !AGREEMENT_DRAFTS.some((x) => x.key !== d.key && x.applies_to.catalog_keys.includes(k)));
    if (!stale && fixKeys.length === keys.length) continue;
    await updateRecord("agreement_template", id, (x) => {
      const next = { ...x, applies_to: { ...(x.applies_to || {}), catalog_keys: fixKeys } };
      if ((PREVIOUS_DRAFT_SHAS[d.key] || []).includes(sha(x.body_md))) { next.body_md = d.body_md; next.version = (x.version || 1) + 1; }
      return next;
    }, W(ctx));
    upgraded += 1;
  }
  for (const [key, olds] of Object.entries(PREVIOUS_TEMPLATE_BODIES)) {
    const def = MESSAGE_TEMPLATES.find((x) => x.key === key);
    const tid = deriveId("template", "seed:template", "core", key);
    const g = await getRecord("template", tid).catch(() => null);
    if (!def || !g || !olds.includes(g.data.body)) continue;
    await updateRecord("template", tid, (x) => (olds.includes(x.body) ? { ...x, body: def.body } : null), W(ctx));
    upgraded += 1;
  }
  return { upgraded };
}

export async function listTemplates() {
  const ix = await readIndex("agreement-templates", "");
  return ix.rows.map((r) => ({ id: r.id, key: r.k, name: r.nm, version: r.v, approved: r.ap, active: r.act, catalog_keys: r.ck || [], updated_at: r.u })).sort((a, b) => a.name.localeCompare(b.name));
}

export async function getTemplate(id) {
  if (!isId(id, "agreement_template")) throw new NotFoundError("That template isn't there.");
  const g = await getRecord("agreement_template", id);
  if (!g || g.data.deleted_at) throw new NotFoundError("That template isn't there.");
  return g;
}

// The approved template for a catalog key (the catalog names it; else any
// approved active template that applies to the key). → record | null
export async function templateFor(catalogKey, { catalog, approvedOnly = true } = {}) {
  const cat = catalog || await loadCatalog();
  const key = cat.plans[catalogKey] && cat.plans[catalogKey].template_key;
  const rows = (await readIndex("agreement-templates", "")).rows.filter((r) => r.act !== false && (!approvedOnly || r.ap));
  // the catalog names the text: only that one (never another plan's text)
  const pick = key ? rows.find((r) => r.k === key) : rows.find((r) => (r.ck || []).includes(catalogKey));
  if (!pick) return null;
  const g = await getRecord("agreement_template", pick.id);
  if (!g || g.data.deleted_at || (approvedOnly && !templateApproved(g.data))) return null;
  return g.data;
}

export async function createTemplate(body = {}, ctx) {
  checkBody(body.body_md);
  const id = newId("agreement_template");
  const r = await createRecord("agreement_template", { id, key: body.key, name: body.name, applies_to: body.applies_to || { catalog_keys: [], service_types: [] }, body_md: body.body_md, version: 1, active: body.active !== false }, W(ctx));
  return r;
}

const TEMPLATE_FIELDS = ["name", "applies_to", "body_md", "active"];
// PATCH: an edited body is a new version (the approval lapses until an owner approves it again).
export async function patchTemplate(id, body = {}, ctx) {
  await getTemplate(id);
  if (body.body_md !== undefined) checkBody(body.body_md);
  const patch = Object.fromEntries(TEMPLATE_FIELDS.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));
  return updateRecord("agreement_template", id, (t) => {
    const next = { ...t, ...patch };
    if (patch.body_md !== undefined && patch.body_md !== t.body_md) next.version = (t.version || 1) + 1;
    return next;
  }, { ...W(ctx), ifMatch: ctx.ifMatch });
}

export async function approveTemplate(id, ctx) {
  const g = await getTemplate(id);
  const checks = ownerChecksIn(g.data.body_md);
  if (checks.length) throw new ConflictError(`${checks.length === 1 ? "One line needs" : `${checks.length} lines need`} your OK first: each "Owner check" says what to confirm. Change the text if needed, delete the check, then approve.`, { code: "owner_checks" });
  const w = W(ctx);
  return updateRecord("agreement_template", id, (t) => (templateApproved(t) ? null : { ...t, approved_version: t.version, approved_at: nowIso(), approved_by: w.by }), w).then((r) => r.data || g.data);
}

// ------------------------------------------------------------ rendering

const money = (c) => formatCents(Number.isSafeInteger(c) ? c : 0);
const nameOf = (c) => (c ? c.display_name || [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || c.company_name || "" : "");

const isLights = (p) => p.kind === "lights_annual" || p.catalog_key === "lights_annual";
const unitOf = (p) => (isLights(p) ? "season" : "visit");
const listWords = (ns) => (ns.length <= 1 ? ns.join("") : `${ns.slice(0, -1).join(", ")} and ${ns[ns.length - 1]}`);
const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

// The price of a plan-like { kind, lines, discounts, frequency,
// visits_per_year } in words, exactly as its jobs will charge it: "$195.00 a
// visit (visit 2 of each year: $60.00)", or with something for the first
// visit only "first visit $145.00, then $245.00 a visit". Optional add-ons
// not picked are left out (price_details lists them with their price).
// { later: true }: a later year's price only (a renewal's price change).
export function perVisitText(planLike, { later: laterOnly = false } = {}) {
  const unit = unitOf(planLike);
  const first = cyclePrices(planLike);
  const later = regularPrices(planLike);
  if (!later.length) return money(0);
  const cycle = (prices) => {
    const base = prices[0];
    const odd = prices.map((p, i) => [i + 1, p]).filter(([, p]) => p !== base);
    return `${money(base)} a ${unit}${odd.length ? ` (${odd.map(([i, p]) => `${unit} ${i} of each year: ${money(p)}`).join("; ")})` : ""}`;
  };
  const diffs = laterOnly ? [] : first.map((p, i) => [i + 1, p]).filter(([i, p]) => p !== later[i - 1]);
  if (!diffs.length) return cycle(later);
  return `${diffs.map(([i, p]) => (i === 1 ? `first ${unit} ${money(p)}` : `${unit} ${i} of your first year ${money(p)}`)).join(", ")}, then ${cycle(later)}`;
}

// Which visits a line or discount covers, in words.
export function scopeWords(scope, planLike) {
  const unit = unitOf(planLike);
  const s = scope || { type: "all" };
  if (s.type === "initial") return `your first ${unit}`;
  if (s.type === "after_initial") return `every ${unit} after the first`;
  if (s.type === "specific" && Array.isArray(s.visits) && s.visits.length) return `${unit}${s.visits.length > 1 ? "s" : ""} ${listWords([...s.visits].sort((a, b) => a - b))} of each year`;
  return `every ${unit}`;
}
const lineCents = (l) => (Number.isSafeInteger(l.total_cents) ? l.total_cents : Math.round(((l.qty_milli ?? 1000) * (l.unit_cents || 0)) / 1000));

// Each line with its price and the visits it's on, then each discount: the
// breakdown the plan's jobs are priced from (§5.4), as "- " list lines.
export function priceDetails(planLike) {
  const out = [];
  for (const l of planLike.lines || []) {
    const extra = l.optional && l.selected !== true;
    out.push(`- ${oneLine(l.title) || "Service"}${extra ? ", only if you add it on your quote" : ""}: ${money(lineCents(l))}, ${scopeWords(l.scope, planLike)}`);
  }
  for (const d of planLike.discounts || []) {
    const amount = d.type === "percentage" ? `${(d.value / 100).toFixed(d.value % 100 ? 2 : 0)}% off` : `${money(d.value)} off`;
    out.push(`- ${oneLine(d.name) || "Discount"}: ${amount} ${scopeWords(d.scope, planLike)}`);
  }
  return out.join("\n") || `- ${money(0)}`;
}

const renewMonths = (m) => (m === 1 ? "month" : m === 12 ? "year" : `${m} months`);
// "twice a year, about every 6 months", "4 times a year, about every 3 months"
export function visitSchedule(planLike) {
  const vpy = planLike.visits_per_year || visitsPerYearOf(planLike.frequency);
  const f = planLike.frequency || {};
  const every = f.interval === "month" ? (f.count === 1 ? "month" : `${f.count} months`) : f.interval === "week" ? (f.count === 1 ? "week" : `${f.count} weeks`) : null;
  if (vpy === 1) return "once a year";
  if (vpy === 12 && every === "month") return "once a month, 12 times a year";
  const times = vpy === 2 ? "twice a year" : `${vpy} times a year`;
  return every ? `${times}, about every ${every}` : times;
}

// Renewal, as the plan does it (lights: the next season goes on the
// schedule only once the customer confirms it, plans.mjs).
export function renewalTerms(planLike) {
  const t = planLike.term || {};
  const auto = (t.auto_renew ?? planLike.auto_renew) !== false;
  const every = t.renews_every_months || planLike.renews_every_months || 12;
  if (isLights(planLike)) {
    const months = t.initial_months || planLike.term_months || 12;
    const contract = months >= 36 ? `Your plan is a ${Math.round(months / 12)}-season contract. ` : "";
    if (!auto && !contract) return "Your plan covers this season. Want us back next year? Just tell us when we text you in September.";
    return `${contract}Your plan carries on every year so your lights go back up each season without the hassle. Each September we text you about the coming season, and we put your install on the schedule once you confirm. Want to skip a season or stop? Just tell us then.`;
  }
  return auto ? `After that it renews every ${renewMonths(every)} until you cancel.` : "After that it ends, unless you choose to renew it.";
}

// Billing and autopay, as the plan has them (Money charges them, M5).
export function billingTerms(planLike) {
  const b = planLike.billing || {};
  const mode = b.mode || planLike.billing_mode || "barta_standard";
  const auto = !!(b.autopay ?? planLike.autopay);
  const lights = isLights(planLike);
  const pay = auto ? "charged" : "billed";
  const card = auto ? "Keep a card or bank account on file for your plan. " : "";
  const tail = auto ? "" : " We send you an invoice each time.";
  if (lights) return `${card}Your install is ${pay} after it's done.${tail}`;
  if (mode === "after_visit") return `${card}Each visit is ${pay} after it's done.${tail}`;
  if (mode === "first_of_month") return `${card}Each visit is ${pay} on the 1st of the month it's scheduled in.${tail}`;
  return `${card}Your first visit is ${pay} after it's done. After that, each visit is ${pay} on the 1st of the month it's scheduled in.${tail}`;
}

export function clawbackTerms(planLike) {
  const c = clawbackCents(planLike);
  return c > 0 ? `If your first visit is done, you pay back the plan discount that visit got (${money(c)}). That's it.` : "There's nothing to pay back.";
}

export async function companyInfo() {
  const c = await getSetting("company").catch(() => ({}));
  return { name: (c && c.name) || "Barta Window Washing", legal_name: (c && c.legal_name) || "BARTA WINDOW WASHING LLC", phone: (c && c.phone) || "(763) 314-3400", email: (c && c.email) || "office@bartawindowwashing.com" };
}

// The variables of an agreement for a plan-like object (a plan, or a quote's plan option made into one).
export function agreementVars(planLike, { contact, company, catalog }) {
  const cat = catalog || catalogWith({});
  const vpy = planLike.visits_per_year || visitsPerYearOf(planLike.frequency);
  const perks = perksList(planLike.perks || {}, cat.perk_names);
  const extras = (planLike.lines || []).some((l) => l.optional && l.selected !== true);
  return {
    legal_name: company.legal_name, company_name: company.name, company_phone: company.phone, company_email: company.email,
    full_name: nameOf(contact) || "the customer", first_name: (contact && contact.first_name) || "", last_name: (contact && contact.last_name) || "",
    plan_name: planLike.name || "plan", per_visit_price: perVisitText(planLike), visits_per_year: String(vpy), term_months: String((planLike.term && planLike.term.initial_months) || planLike.term_months || 12),
    perks_list: perks || "none", clawback_amount: money(clawbackCents(planLike)), clawback_terms: clawbackTerms(planLike),
    notice_days: String((planLike.policy && planLike.policy.notice_days) ?? cat.notice_days), late_cancel_fee: money((planLike.policy && planLike.policy.late_cancel_fee_cents) ?? cat.late_cancel_fee_cents),
    price_details: priceDetails(planLike), addon_note: extras ? " An add-on you pick is added to the visits it's on." : "",
    visit_schedule: visitSchedule(planLike), renewal_terms: renewalTerms(planLike), billing_terms: billingTerms(planLike),
  };
}

export function renderBody(template, vars) {
  return fill(template.body_md, vars).text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// A quote's plan option as a plan-like object. The customer picks add-ons on
// the same page, after the text is frozen: the price leaves them out and
// price_details lists each one with its price ("only if you add it").
export function optionAsPlan(option, cat) {
  const p = option.plan || {};
  const key = cat.plans[p.catalog_key] ? p.catalog_key : "custom";
  const entry = cat.plans[key];
  const frequency = p.frequency || entry.frequency;
  return {
    name: option.name || entry.name, kind: key === "lights_annual" ? "lights_annual" : "recurring", catalog_key: key,
    lines: (option.lines || []).map((l) => (l.optional ? { ...l, selected: false } : l)), discounts: option.discounts || [],
    frequency, visits_per_year: p.visits_per_year || entry.visits_per_year, term_months: p.term_months || entry.initial_months,
    renews_every_months: renewEveryFor(key, frequency, entry), auto_renew: p.auto_renew !== false,
    billing: { mode: p.billing || entry.billing, autopay: p.autopay === undefined ? !!entry.autopay : p.autopay === true },
    perks: entry.perks, policy: { notice_days: cat.notice_days, late_cancel_fee_cents: cat.late_cancel_fee_cents },
  };
}
// How often a plan renews: the catalog's, but a Custom plan as often as it comes.
export function renewEveryFor(key, frequency, entry) {
  if (key !== "custom") return entry.renews_every_months;
  const f = frequency || {};
  if (f.interval === "month" && Number.isSafeInteger(f.count) && f.count >= 1 && f.count <= 12) return f.count;
  return 12;
}

// The plans.agreementForOption service: (quote, version-or-draft, option, ctx)
// → { template_id, template_version, body_rendered, body_sha256 } | null.
export async function agreementForOption(quote, draft, option) {
  if (!option || option.kind !== "plan" || !option.plan) return null;
  const cat = await loadCatalog();
  const t = await templateFor(option.plan.catalog_key, { catalog: cat });
  if (!t) return null;
  const contact = quote && isId(quote.contact_id, "contact") ? ((await getRecord("contact", quote.contact_id)) || {}).data : null;
  const vars = agreementVars(optionAsPlan(option, cat), { contact: contact || { display_name: quote && quote.contact_name }, company: await companyInfo(), catalog: cat });
  const body = renderBody(t, vars);
  return { template_id: t.id, template_version: t.version, body_rendered: body, body_sha256: sha(body) };
}

// ------------------------------------------------------------ agreements

export async function getAgreement(id) {
  if (!isId(id, "agreement")) throw new NotFoundError("That agreement isn't there.");
  const g = await getRecord("agreement", id);
  if (!g || g.data.deleted_at) throw new NotFoundError("That agreement isn't there.");
  return g;
}

export async function listAgreements({ status, contact, plan } = {}) {
  let recs;
  if (isId(contact, "contact") || isId(plan, "plan")) {
    const rows = isId(plan, "plan") ? await listRel("plan-agreements", plan, { limit: 50 }) : await listRel("contact-agreements", contact, { limit: 50 });
    recs = (await getRecords("agreement", rows.map((r) => r.id))).filter(Boolean).map((g) => g.data).filter((a) => !a.deleted_at);
    return recs.filter((a) => !status || a.status === status).map(agreementView);
  }
  const ix = await readIndex("agreements", "pending");
  return ix.rows.filter((r) => !status || r.st === status).sort((a, b) => String(b.u).localeCompare(String(a.u)))
    .map((r) => ({ id: r.id, contact_id: r.c, contact_name: r.cn, plan_id: r.pl, status: r.st, sent_at: r.sent, viewed_at: r.vw, reminders: r.rc, template_key: r.tk, title: r.t, created_at: r.at }));
}

// What staff screens see of an agreement (the text only on GET /agreements/:id).
export const agreementView = (a, { body = false } = {}) => ({
  id: a.id, contact_id: a.contact_id, contact_name: a.contact_name || "", plan_id: a.plan_id || null, quote_id: a.quote_id || null, status: a.status, title: a.title,
  template_key: a.template_key || null, template_version: a.template_version || null, source: a.source, sent_at: a.sent_at || null, sent_via: a.sent_via || [],
  viewed_at: a.viewed_at || null, signed_at: a.signed_at || null, reminders: a.reminders || { count: 0 }, body_sha256: a.body_sha256 || null,
  signature: a.signature ? { name_typed: a.signature.name_typed, method: a.signature.method, at: a.signature.at, drawn_file_id: a.signature.drawn_file_id || null, staff_user_id: a.signature.staff_user_id || null } : null,
  imported: a.imported || null, voided_at: a.voided_at || null, created_at: a.created_at, queued: a.status === "draft" && !!a.bulk_run_id, ...(body ? { body_rendered: a.body_rendered } : {}),
});

// Keeps the plan's agreement summary (agreement_id, agreement_status) in step.
export async function notePlanAgreement(planId, agreement, ctx) {
  if (!isId(planId, "plan")) return null;
  return updateRecord("plan", planId, (p) => {
    if (p.agreement_id && p.agreement_id !== agreement.id && agreement.status === "void") return null;
    const status = agreement.status === "void" ? "none" : agreement.status;
    if (p.agreement_id === agreement.id && p.agreement_status === status) return null;
    if (agreement.status === "void" && p.agreement_id !== agreement.id) return null;
    return { ...p, agreement_id: agreement.status === "void" ? undefined : agreement.id, agreement_status: status };
  }, W(ctx)).catch((e) => { if (e instanceof NotFoundError) return null; throw e; });
}

// A staff agreement for a plan, rendered now from the approved template.
// An open one (draft, sent, viewed) is returned instead of making a second.
export async function agreementForPlan(planId, { template_id, client_id } = {}, ctx) {
  const pg = await getRecord("plan", planId);
  if (!pg || pg.data.deleted_at) throw new NotFoundError("That plan isn't there.");
  const plan = pg.data;
  if (plan.agreement_id && !template_id) {
    const cur = await getRecord("agreement", plan.agreement_id);
    if (cur && OPEN_AGREEMENT.includes(cur.data.status)) return cur;
    if (cur && cur.data.status === "signed") throw new ConflictError("This plan's agreement is already signed.", { code: "signed" });
  }
  const cat = await loadCatalog();
  const t = template_id ? (await getTemplate(template_id)).data : await templateFor(plan.catalog_key, { catalog: cat, approvedOnly: false });
  if (!t) throw new ConflictError("There's no agreement template for this plan yet.", { code: "no_template" });
  if (!templateApproved(t)) throw new ConflictError(`An owner approves the "${t.name}" text first (Settings → Agreement templates).`, { code: "template_not_approved" });
  const contact = (await getRecord("contact", plan.contact_id) || {}).data;
  const body = renderBody(t, agreementVars(plan, { contact, company: await companyInfo(), catalog: cat }));
  const id = client_id ? deriveId("agreement", `c:${client_id}`) : newId("agreement");
  let r;
  try {
    r = await createRecord("agreement", {
      id, contact_id: plan.contact_id, contact_name: plan.contact_name || nameOf(contact), plan_id: plan.id, template_id: t.id, template_key: t.key, template_version: t.version,
      title: `${plan.name} agreement`, body_rendered: body, body_sha256: sha(body), status: "draft", source: "staff", reminders: { count: 0 }, template_approved: true,
    }, W(ctx));
  } catch (e) {
    if (!(e instanceof ExistsError)) throw e;
    r = await getRecord("agreement", id);
  }
  await notePlanAgreement(plan.id, r.data, ctx);
  return r;
}

// Send (staff): status sent, then the agreement.sent automation texts or emails the link.
export async function sendAgreement(id, { channels = ["sms"] } = {}, ctx) {
  const g = await getAgreement(id);
  const a = g.data;
  const ch = [...new Set((Array.isArray(channels) ? channels : []).filter((c) => ["sms", "email"].includes(c)))];
  if (!ch.length) throw new InputError("Pick text, email or both.", "channels");
  if (!["draft", "sent", "viewed"].includes(a.status)) throw new ConflictError(a.status === "signed" ? "This agreement is already signed." : "This agreement can't be sent.", { code: "not_open" });
  if (a.template_approved === false) throw new ConflictError("An owner approves the template's text first.", { code: "template_not_approved" });
  const at = nowIso();
  const r = await updateRecord("agreement", id, (x) => ({ ...x, status: x.status === "viewed" ? "viewed" : "sent", sent_at: at, sent_via: [...new Set([...(x.sent_via || []), ...ch])] }), W(ctx));
  if (r.data.plan_id) await notePlanAgreement(r.data.plan_id, r.data, ctx);
  await emit("agreement.sent", { id: r.data.id, wv: r.data.wv, agreement_id: r.data.id, contact_id: r.data.contact_id, plan_id: r.data.plan_id || null, channels: ch }, W(ctx));
  return r;
}

export async function voidAgreement(id, { reason } = {}, ctx) {
  await getAgreement(id);
  const r = await updateRecord("agreement", id, (a) => {
    if (a.status === "void") return null;
    if (a.status === "signed") throw new ConflictError("A signed agreement stays on file.", { code: "signed" });
    return { ...a, status: "void", voided_at: nowIso(), void_reason: String(reason || "").slice(0, 300) || undefined };
  }, W(ctx));
  if (r.data.plan_id) await notePlanAgreement(r.data.plan_id, r.data, ctx);
  return r;
}

// The view beacon (portal): sent → viewed, once.
export async function markViewed(id, ctx) {
  if (!isId(id, "agreement")) return null;
  return updateRecord("agreement", id, (a) => (a.status === "sent" ? { ...a, status: "viewed", viewed_at: nowIso() } : null), W(ctx))
    .then(async (r) => { if (r.changed && r.data.plan_id) await notePlanAgreement(r.data.plan_id, r.data, ctx); return r; })
    .catch(() => null);
}

// A drawn signature: a PNG ≤ 200 KB (optional on the agreement page).
export function signatureBytes(b64) {
  const s = String(b64 || "").replace(/^data:image\/png;base64,/, "");
  if (!s) return null;
  if (!/^[A-Za-z0-9+/=\s]+$/.test(s)) throw new InputError("That signature didn't come through. Clear it and sign again.", "signature_png_b64");
  const bytes = new Uint8Array(Buffer.from(s, "base64"));
  if (bytes.length > MAX_SIGNATURE_BYTES) throw new InputError("That signature is too big. Clear it and sign again.", "signature_png_b64");
  if (bytes.length < 60 || sniffType(bytes) !== "image/png") throw new InputError("That signature didn't come through. Clear it and sign again.", "signature_png_b64");
  return bytes;
}

// Signing (portal, hub or present): the text the customer saw (its hash),
// full name, "I agree", an optional drawn signature. who: { method,
// contact_id, ip_hash, ua, staff_user_id? }. → { agreement, already? }
export async function signAgreement(id, body = {}, who = {}, ctx = {}, { onSigned } = {}) {
  const g = await getAgreement(id);
  const a = g.data;
  if (who.contact_id && a.contact_id !== who.contact_id) throw new NotFoundError("That agreement isn't here.");
  if (a.status === "signed") return { agreement: a, already: true };
  if (!["sent", "viewed", "draft"].includes(a.status) || (a.status === "draft" && who.method !== "in_person")) throw new ConflictError(a.status === "void" ? "This agreement was replaced. Ask us for the new one." : "This agreement can't be signed right now.", { code: "not_open" });
  if (a.template_approved === false) throw new ConflictError("This agreement can't be signed yet.", { code: "not_open" });
  if (!body || body.body_sha256 !== a.body_sha256) throw new ConflictError("This agreement was updated. Take a look at the new text.", { code: "updated" });
  const name = String(body.name_typed ?? "").trim();
  if (name.length < 2) throw new InputError("Type your full name.", "name_typed");
  if (name.length > 120) throw new InputError("That name is too long.", "name_typed");
  if (body.agree !== true) throw new InputError("Check the box to agree.", "agree");
  const bytes = signatureBytes(body.signature_png_b64);
  let fileId;
  if (bytes) {
    fileId = deriveId("file", `sign--${a.id}`, "signature", 1);
    if (!(await getRecord("file", fileId).catch(() => null))) {
      try {
        await storeImportedFile({ bytes, owner: { type: "agreement", id: a.id }, kind: "signature", contactId: a.contact_id, source: who.method === "in_person" ? "present" : "portal", id: fileId }, W(ctx));
      } catch (e) {
        if (!(e instanceof ExistsError) && !(await getRecord("file", fileId).catch(() => null))) throw e;
      }
    }
  }
  const at = nowIso();
  const r = await updateRecord("agreement", id, (x) => {
    if (x.status === "signed") return null;
    return {
      ...x, status: "signed", signed_at: at, signed_wv: (x.wv || 0) + 1,
      signature: { name_typed: name, ...(fileId ? { drawn_file_id: fileId } : {}), agreed_checkbox: true, at, ip_hash: who.ip_hash || undefined, user_agent: who.ua || undefined, method: who.method === "in_person" ? "in_person" : "portal", ...(isId(who.staff_user_id, "user") ? { staff_user_id: who.staff_user_id } : {}) },
    };
  }, W(ctx));
  if (!r.changed) return { agreement: r.data, already: true };
  await signedEffects(r.data, ctx, onSigned);
  return { agreement: r.data };
}

// After a signature, in the request: only the event (a portal request has
// a small storage budget). The listener (plans.mjs onAgreementSigned) then
// notes it on the plan, tells the staff and activates a ready plan. A
// retried step replays the event under the same id.
export async function signedEffects(a, ctx, onSigned) {
  await emit("agreement.signed", { id: a.id, wv: a.signed_wv || a.wv, agreement_id: a.id, plan_id: a.plan_id || null, contact_id: a.contact_id }, W(ctx))
    .catch((e) => console.error(`crm:plans: agreement.signed not queued (${safeErr(e)})`));
  if (typeof onSigned === "function") await onSigned(a, ctx);
}

// What follows a signature, on the fast lane: the plan's summary, the staff.
export async function afterSigned(a, ctx) {
  if (a.plan_id) await notePlanAgreement(a.plan_id, a, ctx);
  try {
    const first = String(a.contact_name || "").split(/\s+/)[0] || "A customer";
    await notify((await approvers()).slice(0, 10), { kind: "agreement_signed", title: `${first} signed`, body: `${a.title}.`, link: a.plan_id ? `/plans/${a.plan_id}` : "/plans" }, W(ctx));
  } catch (e) { console.error(`crm:plans: signed notification not sent (${safeErr(e)})`); }
}

// The signed agreement a quote approval made (one signature for the quote
// and the plan, §5.4): the frozen text from the version, its hash checked
// against the signature's. → the record | null (no matching text).
export async function quoteAgreement({ id, plan, quote, version, frozen, signature }, ctx) {
  if (!frozen || !signature || !signature.body_sha256) return null;
  if (sha(frozen.body_rendered) !== frozen.body_sha256 || frozen.body_sha256 !== signature.body_sha256) return null;
  const got = await getRecord("agreement", id);
  if (got) return got.data;
  try {
    const r = await createRecord("agreement", {
      id, contact_id: plan.contact_id, contact_name: plan.contact_name, plan_id: plan.id, quote_id: quote.id, quote_version_id: version.id,
      ...(isId(frozen.template_id, "agreement_template") ? { template_id: frozen.template_id } : {}), template_version: Number.isSafeInteger(frozen.template_version) ? frozen.template_version : 1,
      title: `${plan.name} agreement`, body_rendered: frozen.body_rendered, body_sha256: frozen.body_sha256, status: "signed", source: "quote_approval", template_approved: true,
      sent_at: signature.at || nowIso(), signed_at: signature.at || nowIso(), reminders: { count: 0 },
      signature: {
        name_typed: signature.name_typed || "", ...(isId(signature.file_id, "file") ? { drawn_file_id: signature.file_id } : {}), agreed_checkbox: true, at: signature.at || nowIso(),
        ip_hash: signature.ip_hash || undefined, user_agent: signature.ua || undefined, method: signature.method === "in_person" ? "in_person" : "portal",
        ...(signature.method === "in_person" && isId(signature.by, "user") ? { staff_user_id: signature.by } : {}),
      },
    }, W(ctx));
    return r.data;
  } catch (e) {
    if (!(e instanceof ExistsError)) throw e;
    return (await getRecord("agreement", id)).data;
  }
}

export { strip, patchRecord };
