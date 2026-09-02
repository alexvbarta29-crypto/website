// A referred friend claiming their discount (docs: README.md → "Claim").
// Two questions: who referred this person, and what should the CRM notes
// say? The answer comes from the code they arrived with (/r/CODE) and/or
// their phone number (the referrer may have listed them on the program
// page). Recording the claim moves an existing referral to "quoted", or, for
// a friend nobody listed (they were simply sent the link), creates one under
// the referrer so the reward flows exactly as for a listed friend.

import {
  CAPS, ValidationError, buildReferral, clean, fullName, historyEntry, isEmail, isPlainObject,
  newReferralId, normalizeCode, normalizePhone, nowISO,
} from "./referral-lib.mjs";
import {
  getReferral, getReferrer, referralIdForPhone, referrerIdForCode, saveReferral, saveReferralRecord,
} from "./referral-store.mjs";

const MAX_SERVICES = 10;
const MAX_SERVICE_LEN = 100;

// The claim form's fields, validated the same way the referral form's are:
// a first name and a real 10-digit US mobile number are required, the rest
// is optional but capped; the code is normalized when present and never
// required (a friend who mistypes it can still claim — the office sorts it
// out from the notes).
export function validateClaim(body) {
  if (!isPlainObject(body)) throw new ValidationError("Invalid request body.");
  const first_name = clean(body.first_name);
  const last_name = clean(body.last_name);
  const phone = clean(body.phone);
  const email = clean(body.email);
  const address = clean(body.address);
  const note = clean(body.note);
  if (!first_name) throw new ValidationError("Please enter your first name.", "first_name");
  if (first_name.length > CAPS.name) throw new ValidationError("That first name is too long.", "first_name");
  if (last_name.length > CAPS.name) throw new ValidationError("That last name is too long.", "last_name");
  const digits = normalizePhone(phone);
  if (!digits) throw new ValidationError("Please enter a valid 10-digit mobile number.", "phone");
  if (email && (email.length > CAPS.email || !isEmail(email)))
    throw new ValidationError("That email doesn’t look right.", "email");
  if (address.length > CAPS.address) throw new ValidationError("That address is too long.", "address");
  if (note.length > CAPS.note) throw new ValidationError("That note is too long.", "note");
  if (body.consent !== true) throw new ValidationError("Please agree so we can contact you about your request.", "consent");
  const services = Array.isArray(body.services)
    ? body.services.map(clean).filter(Boolean).slice(0, MAX_SERVICES).map((s) => s.slice(0, MAX_SERVICE_LEN)) : [];
  return {
    first_name, last_name, phone, digits, email, address, note, services,
    code: normalizeCode(body.code),
    typed_code: clean(body.code).slice(0, 40),
    page: clean(body.page).slice(0, 200),
  };
}

// Returns null when nobody referred this person, { self: true } when a
// customer is using their own code, else the referral context:
// { code, referrer_name, referrer_first, record, created }.
export async function recordClaim(store, { code, digits, lead, now = nowISO() }) {
  const [match, referrer] = await Promise.all([
    digits ? referralIdForPhone(store, digits).then((id) => (id ? getReferral(store, id) : null)) : null,
    code ? referrerIdForCode(store, code).then((id) => (id ? getReferrer(store, id) : null)) : null,
  ]);

  // A customer typing their own code into their own request is not a
  // referral (nobody referred them), so neither the tag nor a record.
  if (!match && referrer && digits && digits === referrer.phone_digits) return { self: true };

  // The code the friend arrived with wins for the notes line (it is what
  // they were given); the phone match is what gets moved, since it is the
  // record that exists.
  let matchedCode = "", referrerName = "", referrerFirst = "";
  if (referrer) {
    matchedCode = referrer.code;
    referrerName = fullName(referrer.first_name, referrer.last_name);
    referrerFirst = referrer.first_name;
  } else if (match) {
    matchedCode = match.code;
    referrerName = match.referrer_name;
    referrerFirst = String(match.referrer_name || "").split(" ")[0];
  }
  if (!matchedCode) return null;

  let record = match;
  if (match && (match.status === "new" || match.status === "contacted")) {
    match.status = "quoted";
    match.quote_requested_at = match.quote_requested_at || now;
    match.updated_at = now;
    match.history = [...(Array.isArray(match.history) ? match.history : []),
      historyEntry("quoted", "lead-form", "Claimed their discount on the referral page", now)];
    await saveReferralRecord(store, match);
  } else if (!match && referrer && digits) {
    // Share-link arrival: the referrer passed their link/code straight to
    // this friend instead of listing them, so no record exists yet. Create
    // one, already at "quoted", under the referrer.
    record = shareLinkReferral(referrer, digits, lead, now);
    await saveReferral(store, record);
  }

  return {
    code: matchedCode,
    referrer_name: referrerName,
    referrer_first: referrerFirst,
    record,
    created: Boolean(record && !match),
  };
}

// The friend's details as the claim form captured them. rotor.delivered is
// filled in by the caller once the CRM has answered.
function shareLinkReferral(referrer, digits, lead, now) {
  const friend = {
    first_name: clean(lead.first_name) || "Friend",
    last_name: clean(lead.last_name),
    phone: clean(lead.phone),
    digits,
    email: clean(lead.email),
    address: clean(lead.address),
    note: "",
  };
  const record = buildReferral({
    id: newReferralId(), referrer, friend, duplicateOf: null,
    rotor: { delivered: false, status: null, at: null }, now,
  });
  record.history[0].note = "Arrived through the share link";
  record.status = "quoted";
  record.quote_requested_at = now;
  record.history.push(historyEntry("quoted", "lead-form", "Claimed their discount on the referral page", now));
  return record;
}
