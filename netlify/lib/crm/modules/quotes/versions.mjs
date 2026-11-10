// Quotes module: quote versions (design §5.3 "QuoteVersion"). Every send
// (and a Present to customer, and an approval by phone, of a quote that
// changed since its last version) freezes a version: the options with
// their totals, the agreement settings, the client notes, the general
// terms and, for each plan option, the plan's agreement text with its
// hash. The portal renders a version, never the live draft; an approval
// names the version it saw and its sha256, and conversion always uses the
// approved version (quotes.approvedVersion).
//
//   canonicalJson(v)              sorted keys, no whitespace: the hashed form
//   versionContent(quote, ...)    what a version freezes (pure)
//   freezeVersion(quote, opts)    → { version, created }: a new version, or the current one when nothing changed
//   approvedVersion(quote_id)     the version the customer approved (the quotes.approvedVersion service)

import { createHash } from "node:crypto";
import { createRecord, getRecord, getSetting, listRel, getRecords } from "../../../crm-store.mjs";
import { deriveId, isId } from "../../core/ids.mjs";
import { nowIso, now, localDate, addLocalDays } from "../../core/clock.mjs";
import { ExistsError, NotFoundError, ConflictError } from "../../core/errors.mjs";
import { has, call } from "../../core/services.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { earlyBirdDeadline } from "./pricing.mjs";

const sha = (s) => createHash("sha256").update(String(s), "utf8").digest("hex");

// The general terms on every quote when cfg/portal.terms is empty (Barta's
// own words: barta-rules §2.3, §10; D28 for the late-cancel fee).
export const DEFAULT_TERMS = [
  "Payment is due when the work is done unless we've agreed on something else. We take all major cards. Plans are billed automatically: the first visit after it's done, later visits on the 1st of the month they're scheduled.",
  "100% satisfaction guarantee: if anything isn't right, call us and we'll come back and re-clean it free of charge.",
  "We're fully insured. We aren't responsible for damage that was already there, or for old or worn-out windows, frames, screens and seals.",
  "Torn or damaged screens aren't cleaned. You don't need to be home for exterior work as long as gates are unlocked; interior work is scheduled with you.",
  "Need to cancel or move a visit? Give us at least 24 hours' notice. Cancelling or rescheduling with less notice may have a $50 fee. There's never a fee when we move a visit.",
  "Prices on this quote are good until the date shown.",
].join("\n\n");

export function canonicalJson(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(",")}}`;
}

export const termsVersion = (text) => `t-${sha(text).slice(0, 12)}`;

// An option has an Early Bird discount (D30): the quote then expires no later than the deadline in effect.
const hasEarlyBird = (options) => (options || []).some((o) => (o.discounts || []).some((d) => d.key === "early_bird" || d.offer_until));

// expires_on = min(sent + expiry days, the Early Bird deadline in effect when an Early Bird discount is on the quote).
export function expiryFor(options, pricing, at = now()) {
  const day = localDate(at);
  let exp = addLocalDays(day, Number.isSafeInteger(pricing && pricing.quote_expiry_days) ? pricing.quote_expiry_days : 30);
  if (hasEarlyBird(options)) {
    const d = earlyBirdDeadline(day, pricing);
    if (d && d < exp) exp = d;
  }
  return exp;
}

// What a version freezes (pure; the hash covers exactly this).
export function versionContent(quote, { terms_text, plan_agreements = {}, expires_on }) {
  return {
    options: quote.options || [],
    agreement: quote.agreement || { require_card: false, deposit: { type: "none", value: 0 } },
    client_notes: quote.client_notes || "",
    terms_version: termsVersion(terms_text),
    terms_text,
    plan_agreements,
    expires_on: expires_on || null,
    photo_ids: quote.photo_ids || [],
    mockup_file_ids: quote.mockup_file_ids || [],
  };
}

export const versionHash = (content) => sha(canonicalJson(content));
export const versionId = (quoteId, n) => deriveId("quote_version", `send--${quoteId}`, "quotes", n);

// Each plan option's agreement text, from Plans (M3b) when it is there.
async function agreementsFor(quote, draft, ctx) {
  const out = {};
  if (!has("plans.agreementForOption")) return out;
  for (const o of quote.options || []) {
    if (o.kind !== "plan") continue;
    try {
      const a = await call("plans.agreementForOption", quote, draft, o, ctx);
      if (a && a.body_rendered) out[o.id] = { template_id: a.template_id || null, template_version: a.template_version ?? null, body_rendered: String(a.body_rendered).slice(0, 60000), body_sha256: a.body_sha256 || sha(a.body_rendered) };
    } catch (e) {
      console.error(`crm:quotes: no agreement text for a plan option (${safeErr(e)})`);
    }
  }
  return out;
}

// → { version, created }. Reuses the current version when its hash is the
// same (a re-send of an unchanged quote on the same day); otherwise writes
// version n+1 under a derived id (a retried request finds its own version).
export async function freezeVersion(quote, { channels = [], pricing, ctx } = {}) {
  const portal = await getSetting("portal").catch(() => ({}));
  const terms_text = (portal && typeof portal.terms === "string" && portal.terms.trim()) || DEFAULT_TERMS;
  const expires_on = expiryFor(quote.options, pricing);
  const draft = { quote_id: quote.id, options: quote.options, agreement: quote.agreement, client_notes: quote.client_notes };
  const plan_agreements = await agreementsFor(quote, draft, ctx);
  const content = versionContent(quote, { terms_text, plan_agreements, expires_on });
  const hash = versionHash(content);
  if (quote.current_version_id) {
    const cur = await getRecord("quote_version", quote.current_version_id);
    if (cur && cur.data.sha256 === hash) return { version: cur.data, created: false };
  }
  for (let n = (quote.versions_n || 0) + 1, i = 0; i < 5; n++, i++) {
    const id = versionId(quote.id, n);
    try {
      const rec = await createRecord("quote_version", { id, quote_id: quote.id, n, ...content, sha256: hash, sent_at: nowIso(), sent_via: channels, number_label: quote.number_label }, ctx);
      return { version: rec.data, created: true };
    } catch (e) {
      if (!(e instanceof ExistsError)) throw e;
      const got = await getRecord("quote_version", id);
      if (got && got.data.sha256 === hash) return { version: got.data, created: true };
    }
  }
  throw new ConflictError("This quote kept changing. Try again.");
}

export async function getVersion(id) {
  if (!isId(id, "quote_version")) return null;
  const g = await getRecord("quote_version", id);
  return g ? g.data : null;
}

// The quotes.approvedVersion service: (quote_id) → QuoteVersion.
export async function approvedVersion(quoteId) {
  if (!isId(quoteId, "quote")) throw new NotFoundError("That quote isn't there.");
  const q = await getRecord("quote", quoteId);
  if (!q) throw new NotFoundError("That quote isn't there.");
  const vid = q.data.approval && q.data.approval.version_id;
  if (!vid) throw new ConflictError("That quote isn't approved.");
  const v = await getVersion(vid);
  if (!v) throw new NotFoundError("The approved version isn't there.");
  return v;
}

// Every version of a quote, newest first (summaries).
export async function versionsOf(quoteId, { limit = 30 } = {}) {
  const rows = await listRel("quote-versions", quoteId, { limit });
  const got = await getRecords("quote_version", rows.map((r) => r.id));
  return got.filter(Boolean).map((g) => g.data).sort((a, b) => b.n - a.n);
}

export const versionSummary = (v) => ({ id: v.id, n: v.n, sha256: v.sha256, sent_at: v.sent_at, sent_via: v.sent_via || [], expires_on: v.expires_on || null, terms_version: v.terms_version, options: (v.options || []).map((o) => ({ id: o.id, name: o.name, kind: o.kind, recommended: !!o.recommended, totals: o.totals || null })) });
