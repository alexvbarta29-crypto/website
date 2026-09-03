// Outbound side of the referral program: the Rotor CRM lead created for each
// referred friend, and the Twilio text messages (docs/REFERRAL-PROGRAM.md).
// Both are best-effort — callers record the outcome on the referral and
// never let a CRM or SMS hiccup fail the customer's submission.
//
// Secrets (ROTOR_API_KEY, TWILIO_*) are read from the environment at call
// time and must never be logged; only HTTP statuses are.

import { SMS, shareUrl, statusUrl, siteUrl } from "./referral-config.mjs";
import { fullName, lastInitial, safeErr } from "./referral-lib.mjs";

// Same endpoint/version as netlify/functions/lead.mjs.
const ROTOR_URL = "https://api.getrotor.com/open-api/leads";
const ROTOR_API_VERSION = "1.1.0";
// Well under Netlify's 10 s function limit: up to ten Rotor calls run in
// parallel, but the store writes that follow are sequential, so an
// unreachable Rotor must not eat most of the budget by itself.
const ROTOR_TIMEOUT_MS = 5000;
const MAX_NOTES = 2000;             // Rotor's notes limit
const TWILIO_TIMEOUT_MS = 6000;

// The lead Rotor receives for a referred friend. Only Rotor-supported fields,
// no empty optional properties, and no service_type (the friend hasn't asked
// for anything yet).
//
// The notes are the text to send them and nothing else: the office opens the
// lead, copies the whole notes box — or hits Rotor's share button on it —
// and sends it as-is. The message names the referrer and carries the code in
// its link, and everything else about the referral (the referrer's phone and
// reward, the note they wrote about this friend, the status) lives on the
// referral dashboard, which is where that context is worked.
export function rotorLeadPayload({ referrer, friend, code }) {
  // Word for word what the automatic text would say, so a hand-sent message
  // and an automatic one read identically to the friend.
  let notes = friendText({ friend, referrer, code });
  if (notes.length > MAX_NOTES) notes = notes.slice(0, MAX_NOTES);

  const payload = {
    source: "Referral Program",
    tags: ["Referral"],
    name: fullName(friend.first_name, friend.last_name),
    phone: friend.phone,
  };
  if (friend.email) payload.email = friend.email;
  // The form has a single free-text address line, so it travels as street1
  // with the same MN/US fallbacks lead.mjs applies to single-field forms.
  if (friend.address) {
    payload.address_street1 = friend.address;
    payload.address_state = "MN";
    payload.address_country = "US";
  }
  payload.notes = notes;
  return payload;
}

// 201 = new lead, 200 = existing lead updated (Rotor upserts by phone, so a
// friend who is already a contact just gains the Referral tag and notes).
export async function createRotorLead(payload) {
  const key = process.env.ROTOR_API_KEY;
  if (!key) {
    console.error("referral: ROTOR_API_KEY is not set — lead not delivered");
    return { delivered: false, status: null };
  }
  try {
    const res = await fetch(ROTOR_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "rotor-api-version": ROTOR_API_VERSION,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(ROTOR_TIMEOUT_MS),
    });
    const delivered = res.status === 200 || res.status === 201;
    if (!delivered) console.error("referral: Rotor rejected lead: HTTP " + res.status);
    return { delivered, status: res.status };
  } catch (err) {
    console.error(`referral: Rotor unreachable (${safeErr(err)})`);
    return { delivered: false, status: null };
  }
}

// --- SMS -------------------------------------------------------------------

// off (default) → no automatic texts; office → alert the office per referral;
// all → also text the friend and the referrer. Anything else reads as off.
export const smsMode = () => {
  const m = String(process.env.REFERRAL_SMS_MODE || "off").trim().toLowerCase();
  return m === "all" || m === "office" ? m : "off";
};

// Ten digits → +1XXXXXXXXXX; already-E.164 values pass through.
export const e164 = (v) => {
  const d = String(v || "").replace(/\D/g, "");
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d[0] === "1") return "+" + d;
  return d ? "+" + d : "";
};
export const officePhone = () => e164(process.env.REFERRAL_OFFICE_PHONE);

export const friendText = ({ friend, referrer, code }) => SMS.friend({
  friend_first: friend.first_name,
  referrer_first: referrer.first_name,
  referrer_last_initial: lastInitial(referrer.last_name),
  share_url: shareUrl(code),
});
export const referrerText = ({ n, token }) => SMS.referrer({ n, status_url: statusUrl(token) });
export const rewardReadyText = ({ friend, token }) =>
  SMS.rewardReady({ friend_first: friend.first_name, status_url: statusUrl(token) });
export const officeText = ({ referrer, friend, code }) => SMS.office({
  referrer_name: fullName(referrer.first_name, referrer.last_name),
  referrer_phone: referrer.phone,
  friend_name: fullName(friend.first_name, friend.last_name),
  friend_phone: friend.phone,
  code,
  site: siteUrl(),
});

// One Twilio message. TWILIO_FROM is either a sending number (E.164) or a
// Messaging Service SID (MG…), which Twilio takes in a different field.
// Returns true only on a 2xx so the referral's sms flags stay honest.
export async function sendSms(to, body) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM;
  if (!to || !sid || !token || !from) {
    console.warn("referral sms: skipped (Twilio not configured or no recipient)");
    return false;
  }
  const params = new URLSearchParams({ To: to, Body: body });
  params.set(/^MG/i.test(from) ? "MessagingServiceSid" : "From", from);
  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
        method: "POST",
        headers: {
          Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
        signal: AbortSignal.timeout(TWILIO_TIMEOUT_MS),
      });
    if (res.status < 200 || res.status >= 300) {
      console.error("referral sms: Twilio HTTP " + res.status);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`referral sms: Twilio unreachable (${safeErr(err)})`);
    return false;
  }
}
