// Referral program API (docs/REFERRAL-PROGRAM.md), same origin as the pages:
//
//   POST /api/referral            submit referrals (public, from the program page)
//   GET  /api/referral?t=TOKEN    the referrer's private dashboard
//   GET  /api/referral?code=CODE  public share-code lookup (referred.html)
//
// Every referral is stored in Netlify Blobs and created as a lead in Rotor
// CRM tagged "Referral"; depending on REFERRAL_SMS_MODE the friend, the
// referrer, and/or the office are texted via Twilio. Storage and Rotor are
// each best-effort: the submission only fails (502) when BOTH are down, so
// the page shows the call-us fallback instead of a confirmation we can't
// honour, and otherwise reports stored/delivered flags so nothing is lost
// quietly.
//
// Secrets (ROTOR_API_KEY, Twilio) live only in environment variables set in
// the Netlify dashboard and never appear in a log line — logs carry
// statuses and counts, never customer data.

import { REWARDS, shareUrl, statusUrl } from "../lib/referral-config.mjs";
import {
  ValidationError, validateSubmission, buildReferrer, buildReferral, newCode, newToken,
  newReferralId, nowISO, normalizeCode, normalizeToken, dashboardTotals, dashboardEntry,
  newestFirst, safeErr,
} from "../lib/referral-lib.mjs";
import {
  openGuardedStore, openStore, getReferrer, getReferral, referralIdForPhone,
  referrerIdForCode, referrerIdForToken, referralsForReferrer, saveReferrer, saveReferral,
  saveReferralRecord, allocateCode,
} from "../lib/referral-store.mjs";
import {
  rotorLeadPayload, createRotorLead, smsMode, sendSms, e164, officePhone, friendText,
  referrerText, officeText,
} from "../lib/referral-notify.mjs";

// Every response is JSON and uncacheable: dashboards must never show a
// stale status and codes/tokens must never sit in a shared cache.
const json = (body, status = 200, headers = {}) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
const fail = (status, error, field) =>
  json(field ? { ok: false, error, field } : { ok: false, error }, status);

export default async (req) => {
  if (req.method === "POST") return submit(req);
  if (req.method === "GET") return lookup(req);
  return json({ ok: false, error: "Method not allowed" }, 405, { Allow: "GET, POST" });
};

export const config = { path: "/api/referral" };

// ---------------------------------------------------------------------------
// POST — submit referrals
// ---------------------------------------------------------------------------
async function submit(req) {
  let body;
  try { body = await req.json(); } catch { body = null; }
  let sub;
  try {
    sub = validateSubmission(body);
  } catch (err) {
    if (err instanceof ValidationError) return fail(400, err.message, err.field);
    throw err;
  }

  const now = nowISO();
  const guard = await openGuardedStore();

  // A returning referrer (same phone) keeps their code and token; only the
  // reward choice — and an email/last name they left blank before — is
  // refreshed. If the store is down the lookup yields nothing and a fresh
  // code is minted anyway so the Rotor notes and texts still carry one;
  // stored:false tells the page the tracking link won't work.
  let referrer = await guard.run("load referrer", (s) => getReferrer(s, sub.referrer.digits));
  let isNew = false;
  // Knowing the private token proves this is the customer (they came from
  // their tracking link). A phone number alone does not: anyone who has it
  // could otherwise pull the customer's private dashboard link out of this
  // response or flip their reward choice. Untrusted resubmissions are still
  // accepted (the friends are real referrals for the office to handle), but
  // the token stays private and the stored preferences stay as they were.
  let trusted = true;
  if (referrer && referrer.code && referrer.token) {
    trusted = Boolean(sub.token) && sub.token === referrer.token;
    if (trusted) {
      referrer.reward_pref = sub.referrer.reward_pref;
      if (sub.referrer.email) referrer.email = sub.referrer.email;
    }
    if (!referrer.last_name && sub.referrer.last_name) referrer.last_name = sub.referrer.last_name;
    referrer.updated_at = now;
  } else {
    isNew = true;
    const code = (await guard.run("allocate code", (s) => allocateCode(s, newCode))) || newCode();
    referrer = buildReferrer({ referrer: sub.referrer, code, token: newToken(), page: sub.page, now });
  }

  // One referral per friend, in parallel: duplicate check, Rotor lead, record.
  const results = await Promise.all(sub.friends.map(async (friend) => {
    // A phone number that already has a referral (from anyone) is accepted
    // but flagged and not sent to Rotor again; a stale pointer to a deleted
    // record does not count.
    const firstId = await guard.run("check duplicate", (s) => referralIdForPhone(s, friend.digits));
    const first = firstId ? await guard.run("load duplicate", (s) => getReferral(s, firstId)) : null;
    const duplicateOf = first && first.id ? first.id : null;
    const rotor = duplicateOf
      ? { delivered: false, status: null, at: null }
      : { ...(await createRotorLead(rotorLeadPayload({ referrer, friend, code: referrer.code }))),
          at: nowISO() };
    return buildReferral({ id: newReferralId(), referrer, friend, duplicateOf, rotor, now });
  }));
  const duplicates = results.filter((r) => r.duplicate_of).length;
  const delivered = results.every((r) => r.duplicate_of || r.rotor.delivered);

  // The code/token maps are rewritten every time (idempotent), so a first
  // write that failed halfway can never leave a dead share code or link.
  await guard.run("save referrer", (s) => saveReferrer(s, referrer, { newMaps: true }));
  for (const r of results)
    await guard.run("save referral", (s) => saveReferral(s, r, { indexPhone: !r.duplicate_of }));
  const stored = guard.ok;

  if (!stored && !delivered) {
    console.error(`referral: lost — store down and Rotor failed (${results.length} friend(s))`);
    return fail(502, "We couldn't save your referral right now. Please call us and we'll take care of it.");
  }

  await sendTexts({ guard, stored, referrer, results });

  console.log(`referral: ${results.length} friend(s), ${duplicates} duplicate, `
    + `stored=${stored}, delivered=${delivered}, sms=${smsMode()}`);

  return json({
    ok: true,
    code: referrer.code,
    token: trusted ? referrer.token : null,
    share_url: shareUrl(referrer.code),
    status_url: trusted ? statusUrl(referrer.token) : null,
    returning: !trusted,
    referrer: { first_name: referrer.first_name, reward_pref: referrer.reward_pref },
    friends: results.map((r) => ({
      id: r.id, first_name: r.first_name, status: r.status, duplicate: Boolean(r.duplicate_of),
    })),
    stored,
    delivered,
  });
}

// Twilio texts per REFERRAL_SMS_MODE (off | office | all). Each record's sms
// flags say what actually went out, so the dashboard can offer a manual
// "Text friend" link for anything that didn't.
async function sendTexts({ guard, stored, referrer, results }) {
  const mode = smsMode();
  if (mode === "off") return;
  const office = officePhone();
  const code = referrer.code;

  await Promise.all(results.map(async (r) => {
    // Duplicates were not sent to Rotor and the friend is not texted again;
    // the office still hears about them and decides what to do.
    if (mode === "all" && !r.duplicate_of)
      r.sms.friend = await sendSms(e164(r.phone_digits), friendText({ friend: r, referrer, code }));
    if (office)
      r.sms.office = await sendSms(office, officeText({ referrer, friend: r, code }));
  }));

  // The confirmation carries the tracking link, which only works when the
  // referral was actually stored.
  let referrerSent = false;
  if (mode === "all" && stored)
    referrerSent = await sendSms(e164(referrer.phone_digits),
      referrerText({ n: results.length, token: referrer.token }));
  for (const r of results) r.sms.referrer = referrerSent;

  if (!stored) return;
  for (const r of results)
    if (r.sms.friend || r.sms.office || r.sms.referrer)
      await guard.run("save sms flags", (s) => saveReferralRecord(s, r));
}

// ---------------------------------------------------------------------------
// GET — private dashboard (?t=) and public code lookup (?code=)
// ---------------------------------------------------------------------------
async function lookup(req) {
  const params = new URL(req.url).searchParams;
  const t = params.get("t");
  const code = params.get("code");
  if (t === null && code === null) return fail(400, "Missing t or code parameter");
  try {
    const store = await openStore();
    return t !== null ? await dashboard(store, t) : await codeLookup(store, code);
  } catch (err) {
    console.error(`referral lookup failed (${safeErr(err)})`);
    return fail(503, "The referral service is temporarily unavailable. Please try again in a minute.");
  }
}

async function dashboard(store, rawToken) {
  const token = normalizeToken(rawToken);
  const referrerId = token ? await referrerIdForToken(store, token) : null;
  const referrer = referrerId ? await getReferrer(store, referrerId) : null;
  if (!referrer) return fail(404, "We couldn't find that tracking link.");
  const referrals = (await referralsForReferrer(store, referrer.id)).sort(newestFirst);
  return json({
    ok: true,
    referrer: {
      first_name: referrer.first_name,
      last_name: referrer.last_name,
      phone: referrer.phone,
      email: referrer.email,
      reward_pref: referrer.reward_pref,
      code: referrer.code,
    },
    share_url: shareUrl(referrer.code),
    totals: dashboardTotals(referrals),
    referrals: referrals.map(dashboardEntry),
  });
}

// Deliberately exposes only the referrer's first name: the share code is
// public (it is in texts and links), so nothing else may hang off it.
async function codeLookup(store, raw) {
  const code = normalizeCode(raw);
  const referrerId = code ? await referrerIdForCode(store, code) : null;
  const referrer = referrerId ? await getReferrer(store, referrerId) : null;
  if (!referrer) return fail(404, "That referral code isn't valid.");
  return json({
    ok: true,
    code: referrer.code,
    referrer_first_name: referrer.first_name,
    friend_discount: REWARDS.friend_discount,
    referrer_credit: REWARDS.referrer_credit,
    referrer_gift_card: REWARDS.referrer_gift_card,
  });
}
