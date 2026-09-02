// The referral program's hook inside /api/lead (docs/REFERRAL-PROGRAM.md →
// "Quote form integration"). A quote request that carries a referral share
// code as its promo code, or comes from a phone number a customer referred,
// is a referred friend booking through the regular website: the lead gets
// the Referral tag and a notes line naming the referrer, and the referral
// moves to "quoted" (or is created, for a friend who only got the link).
//
// Strictly best-effort: a slow or broken store, or missing Blobs, must
// never fail or hold up a quote request, so everything runs behind one
// short timeout and every failure resolves to "no referral".

import { withTimeout, normalizeCode, normalizePhone, clean, safeErr } from "./referral-lib.mjs";
import { openStore, saveReferralRecord } from "./referral-store.mjs";
import { recordClaim } from "./referral-claim.mjs";

export const HOOK_TIMEOUT_MS = 1500;

export async function referralForLead(lead = {}, { timeoutMs = HOOK_TIMEOUT_MS } = {}) {
  const code = normalizeCode(lead.promo_code);
  const digits = normalizePhone(lead.phone);
  if (!code && !digits) return null;
  // The quote form sends one "name" field or first/last; the record wants both.
  const full = clean(lead.name).split(/\s+/).filter(Boolean);
  const friend = {
    first_name: clean(lead.first_name) || full[0] || "",
    last_name: clean(lead.last_name) || full.slice(1).join(" "),
    phone: clean(lead.phone),
    email: clean(lead.email),
    address: clean(lead.address),
  };
  try {
    return await withTimeout(async () => {
      const store = await openStore();
      const claim = await recordClaim(store, { code, digits, lead: friend, via: "quote" });
      if (!claim || claim.self || !claim.code) return null;
      // A record created here is for a lead the quote form is about to
      // deliver to Rotor itself, so it is not "Not in CRM".
      if (claim.created && claim.record) {
        claim.record.rotor = { delivered: true, status: null, at: new Date().toISOString() };
        await saveReferralRecord(store, claim.record);
      }
      return {
        code: claim.code,
        referrer_name: claim.referrer_name,
        referral_id: claim.record ? claim.record.id : null,
        notes_line: `Referral code: ${claim.code} (referred by ${claim.referrer_name})`,
      };
    }, timeoutMs, "referral lookup");
  } catch (err) {
    console.error(`referral hook skipped (${safeErr(err)})`);
    return null;
  }
}
