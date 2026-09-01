// The quote form's one referral-program step (docs/REFERRAL-PROGRAM.md →
// "Quote form integration"). lead.mjs asks: does this quote request belong
// to a referred friend? Yes when the promo code is one of our share codes
// that exists, or when the lead's phone number is in idx/phone. If so, the
// caller tags the Rotor lead "Referral" and adds the notes line returned
// here, and the matched referral moves new/contacted → quoted.
//
// Strictly best-effort: the whole lookup races a short timeout and every
// failure (Blobs unavailable, malformed record, slow network) resolves to
// null, because a lost quote request costs far more than a missed tag.

import {
  buildReferral, clean, fullName, historyEntry, newReferralId, normalizeCode, normalizePhone,
  nowISO, safeErr, withTimeout,
} from "./referral-lib.mjs";
import {
  getReferral, getReferrer, openStore, referralIdForPhone, referrerIdForCode,
  saveReferral, saveReferralRecord,
} from "./referral-store.mjs";

export const HOOK_TIMEOUT_MS = 1500;

// `lead` is the quote form's submission (promo_code, phone, and the name /
// email / address the friend typed). Only promo_code and phone drive the
// lookup; the rest is used when a share-link arrival needs a record.
export async function referralForLead(lead = {}, { timeoutMs = HOOK_TIMEOUT_MS } = {}) {
  const code = normalizeCode(lead.promo_code);
  const digits = normalizePhone(lead.phone);
  if (!code && !digits) return null;
  try {
    return await withTimeout(() => lookup(code, digits, lead), timeoutMs, "referral lookup");
  } catch (err) {
    console.warn(`referral hook skipped (${safeErr(err)})`);
    return null;
  }
}

async function lookup(code, digits, lead) {
  const store = await openStore();
  const [match, referrer] = await Promise.all([
    digits ? referralIdForPhone(store, digits).then((id) => (id ? getReferral(store, id) : null)) : null,
    code ? referrerIdForCode(store, code).then((id) => (id ? getReferrer(store, id) : null)) : null,
  ]);

  // A customer typing their own code into their own quote request is not a
  // referral (nobody referred them), so neither the tag nor a record.
  if (!match && referrer && digits && digits === referrer.phone_digits) return null;

  // The code the friend typed wins for the notes line (they chose it); the
  // phone match is what gets moved, since it is the record that exists.
  let matchedCode = "", referrerName = "";
  if (referrer) {
    matchedCode = referrer.code;
    referrerName = fullName(referrer.first_name, referrer.last_name);
  } else if (match) {
    matchedCode = match.code;
    referrerName = match.referrer_name;
  }
  if (!matchedCode) return null;

  const now = nowISO();
  let record = match;
  if (match && (match.status === "new" || match.status === "contacted")) {
    match.status = "quoted";
    match.quote_requested_at = match.quote_requested_at || now;
    match.updated_at = now;
    match.history = [...(Array.isArray(match.history) ? match.history : []),
      historyEntry("quoted", "lead-form", "Quote requested on the website", now)];
    await saveReferralRecord(store, match);
  } else if (!match && referrer && digits) {
    // Share-link arrival: the referrer passed their link/code straight to
    // this friend instead of listing them on refer.html, so no record
    // exists yet. Create one, already at "quoted", under the referrer; the
    // office sees it in the dashboard and the referrer on their tracking
    // page, and the reward flows exactly as for a listed friend.
    record = shareLinkReferral(referrer, digits, lead, now);
    await saveReferral(store, record);
  }

  return {
    code: matchedCode,
    referrer_name: referrerName,
    referral_id: record ? record.id : null,
    created: Boolean(record && !match),
    notes_line: `Referral code: ${matchedCode} (referred by ${referrerName})`,
  };
}

// The friend's details as the quote form captured them. The quote form
// itself is what delivered this person to Rotor, so the record's rotor block
// says delivered (the form only reaches this hook on its way to Rotor).
function shareLinkReferral(referrer, digits, lead, now) {
  const nameParts = clean(lead.name).split(/\s+/).filter(Boolean);
  const first = clean(lead.first_name) || nameParts[0] || "";
  const last = clean(lead.last_name) || (clean(lead.first_name) ? "" : nameParts.slice(1).join(" "));
  const friend = {
    first_name: first || "Friend",
    last_name: last,
    phone: clean(lead.phone),
    digits,
    email: clean(lead.email),
    address: clean(lead.address),
    note: "",
  };
  const record = buildReferral({
    id: newReferralId(), referrer, friend, duplicateOf: null,
    rotor: { delivered: true, status: null, at: now }, now,
  });
  record.history[0].note = "Arrived through the share link";
  record.status = "quoted";
  record.quote_requested_at = now;
  record.history.push(historyEntry("quoted", "lead-form", "Quote requested on the website", now));
  return record;
}
