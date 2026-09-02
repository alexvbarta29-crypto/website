// Pure helpers for the referral program (docs/REFERRAL-PROGRAM.md): input
// cleaning and validation, phone/code normalization, id and code generation,
// record builders, dashboard/admin totals, CSV export, and the constant-time
// admin-key compare. Nothing here touches the network or the store, so every
// function is unit-tested directly and the functions that do talk to Blobs,
// Rotor, and Twilio stay thin.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  REWARDS, STATUSES, PENDING_STATUSES, REWARD_TYPES, statusUrl,
} from "./referral-config.mjs";

// No 0/O/1/I — codes get read aloud and typed from a text message. 32
// symbols also divide 256 evenly, so a byte modulo the length is unbiased.
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 5;
export const TOKEN_LENGTH = 24;

// Field caps from the contract; over-long values are rejected, not trimmed,
// because the forms enforce the same maxlength and only hand-crafted
// requests ever exceed them.
export const CAPS = Object.freeze({
  name: 60, phone: 25, email: 120, address: 200, note: 500, page: 200, office_note: 1000,
});

export const nowISO = () => new Date().toISOString();

// Normalizes newlines, strips control characters (keeping tabs/newlines),
// and trims. Never truncates — the validators decide what is too long.
export const clean = (v) =>
  typeof v === "string"
    ? v.replace(/\r\n?/g, "\n")
       .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
       .trim()
    : "";

// US numbers only: keep the digits, drop a leading country code, and insist
// on ten digits with a plausible area code (NANP area codes never start
// with 0 or 1). Returns "" when the input is not a usable phone number.
export const normalizePhone = (raw) => {
  let d = String(raw || "").replace(/\D/g, "");
  if (d.length === 11 && d[0] === "1") d = d.slice(1);
  return /^[2-9]\d{9}$/.test(d) ? d : "";
};

export const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);

const CODE_RE = new RegExp(
  `^${REWARDS.code_prefix}-?([${CODE_ALPHABET}]{${CODE_LENGTH}})$`);
// Accepts "barta-7k3xq", "BARTA 7K3XQ", "barta7k3xq"… and returns the
// canonical BARTA-7K3XQ, or "" when the value is not one of our codes (so
// an unrelated promo code like FALL10 is never mistaken for a referral).
export const normalizeCode = (raw) => {
  const s = String(raw || "").toUpperCase().replace(/[\s_]+/g, "")
    .replace(/[\u2010-\u2015]/g, "-");
  const m = CODE_RE.exec(s);
  return m ? `${REWARDS.code_prefix}-${m[1]}` : "";
};

const TOKEN_RE = new RegExp(`^[${CODE_ALPHABET}]{${TOKEN_LENGTH}}$`);
export const normalizeToken = (raw) => {
  const s = String(raw || "").trim().toUpperCase();
  return TOKEN_RE.test(s) ? s : "";
};

export const randomString = (n, alphabet = CODE_ALPHABET) => {
  const bytes = randomBytes(n);
  let out = "";
  for (let i = 0; i < n; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
};
export const newCode = () => `${REWARDS.code_prefix}-${randomString(CODE_LENGTH)}`;
export const newToken = () => randomString(TOKEN_LENGTH);
// Time-prefixed so ids sort roughly by creation; the random tail only has to
// separate referrals created in the same millisecond, so the slight modulo
// bias of a base-36 alphabet is irrelevant here.
export const newReferralId = (now = Date.now()) =>
  "r_" + now.toString(36) + randomString(6, "0123456789abcdefghijklmnopqrstuvwxyz");

export const fullName = (first, last) => [first, last].filter(Boolean).join(" ");
export const lastInitial = (last) => (last ? last.trim().charAt(0).toUpperCase() : "");
// "Jane D." — what the referrer's dashboard shows for a friend.
export const maskedName = (first, last) =>
  lastInitial(last) ? `${first} ${lastInitial(last)}.` : first;

export const isPlainObject = (v) =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);

// ---------------------------------------------------------------------------
// Validation of POST /api/referral. Throws ValidationError with the dotted
// field path the page uses to highlight the offending input.
// ---------------------------------------------------------------------------
export class ValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = "ValidationError";
    this.field = field;
  }
}

const nameField = (v, path, required, label) => {
  const s = clean(v);
  if (!s && required) throw new ValidationError(`${label} is required.`, path);
  if (s.length > CAPS.name)
    throw new ValidationError(`${label} is too long (${CAPS.name} characters max).`, path);
  return s;
};
const phoneField = (v, path, label) => {
  const phone = clean(v);
  const digits = normalizePhone(phone);
  if (!phone) throw new ValidationError(`${label} is required.`, path);
  // The typed string is stored and printed (texts, CRM notes), so it is
  // capped as well as checked: "+1 (763) 555-0100 ext. 12" is 25 characters.
  if (phone.length > CAPS.phone)
    throw new ValidationError(`${label} needs to be a 10-digit US phone number.`, path);
  if (!digits)
    throw new ValidationError(`${label} needs to be a 10-digit US phone number.`, path);
  return { phone, digits };
};
const emailField = (v, path) => {
  const s = clean(v);
  if (!s) return "";
  if (s.length > CAPS.email)
    throw new ValidationError(`Email is too long (${CAPS.email} characters max).`, path);
  if (!isEmail(s)) throw new ValidationError("That email address doesn't look right.", path);
  return s;
};
const textField = (v, path, cap, label) => {
  const s = clean(v);
  if (s.length > cap)
    throw new ValidationError(`${label} is too long (${cap} characters max).`, path);
  return s;
};

export function validateSubmission(body) {
  if (!isPlainObject(body)) throw new ValidationError("Invalid request body.");
  if (!isPlainObject(body.referrer))
    throw new ValidationError("Your name and phone number are required.", "referrer");

  const r = body.referrer;
  const rewardPref = clean(r.reward_pref).toLowerCase();
  if (!REWARD_TYPES.includes(rewardPref))
    throw new ValidationError("Choose the reward you'd like (credit or gift card).",
      "referrer.reward_pref");
  const referrerPhone = phoneField(r.phone, "referrer.phone", "Your phone number");
  const referrer = {
    first_name: nameField(r.first_name, "referrer.first_name", true, "Your first name"),
    last_name: nameField(r.last_name, "referrer.last_name", false, "Your last name"),
    phone: referrerPhone.phone,
    digits: referrerPhone.digits,
    email: emailField(r.email, "referrer.email"),
    reward_pref: rewardPref,
  };

  if (!Array.isArray(body.friends) || body.friends.length === 0)
    throw new ValidationError("Add at least one friend to refer.", "friends");
  if (body.friends.length > REWARDS.max_friends)
    throw new ValidationError(
      `You can refer up to ${REWARDS.max_friends} friends at a time.`, "friends");

  const friends = [];
  const seen = new Set();
  body.friends.forEach((f, i) => {
    const p = `friends.${i}`;
    if (!isPlainObject(f))
      throw new ValidationError("Each friend needs a name and phone number.", p);
    const phone = phoneField(f.phone, `${p}.phone`, "Your friend's phone number");
    if (phone.digits === referrer.digits)
      throw new ValidationError("You can't refer your own phone number.", `${p}.phone`);
    const friend = {
      first_name: nameField(f.first_name, `${p}.first_name`, true, "Your friend's first name"),
      last_name: nameField(f.last_name, `${p}.last_name`, false, "Your friend's last name"),
      phone: phone.phone,
      digits: phone.digits,
      email: emailField(f.email, `${p}.email`),
      address: textField(f.address, `${p}.address`, CAPS.address, "Address"),
      note: textField(f.note, `${p}.note`, CAPS.note, "Note"),
    };
    // The same friend listed twice in one submission collapses to the
    // first entry; the cross-referrer duplicate check happens against the
    // store later.
    if (seen.has(friend.digits)) return;
    seen.add(friend.digits);
    friends.push(friend);
  });

  if (body.consent !== true)
    throw new ValidationError(
      "Please confirm you have your friends' permission to share their contact details.",
      "consent");

  return {
    referrer,
    friends,
    page: clean(body.page).slice(0, CAPS.page),
    token: normalizeToken(body.token),
  };
}

// ---------------------------------------------------------------------------
// Record builders (shapes from the data model in docs/REFERRAL-PROGRAM.md)
// ---------------------------------------------------------------------------
export const historyEntry = (status, by, note = "", at = nowISO()) =>
  ({ status, at, by, note });

export function buildReferrer({ referrer, code, token, page, now }) {
  return {
    id: referrer.digits,
    code,
    token,
    first_name: referrer.first_name,
    last_name: referrer.last_name,
    phone: referrer.phone,
    phone_digits: referrer.digits,
    email: referrer.email,
    reward_pref: referrer.reward_pref,
    consent_at: now,
    source_page: page || "",
    created_at: now,
    updated_at: now,
  };
}

export function buildReferral({ id, referrer, friend, duplicateOf, rotor, now }) {
  return {
    id,
    referrer_id: referrer.id,
    code: referrer.code,
    referrer_name: fullName(referrer.first_name, referrer.last_name),
    referrer_phone: referrer.phone,
    first_name: friend.first_name,
    last_name: friend.last_name,
    phone: friend.phone,
    phone_digits: friend.digits,
    email: friend.email,
    address: friend.address,
    note: friend.note,
    office_note: "",
    status: "new",
    history: [historyEntry("new", "system",
      duplicateOf ? `Duplicate of ${duplicateOf}` : "Referral received", now)],
    reward: null,
    duplicate_of: duplicateOf || null,
    rotor: { delivered: Boolean(rotor && rotor.delivered),
             status: rotor && typeof rotor.status === "number" ? rotor.status : null,
             at: (rotor && rotor.at) || null },
    sms: { friend: false, referrer: false, office: false },
    quote_requested_at: null,
    created_at: now,
    updated_at: now,
  };
}

// ISO timestamps sort lexicographically, so string compare is enough.
export const newestFirst = (a, b) =>
  String(b.created_at || "").localeCompare(String(a.created_at || ""));

// A reward only counts while the referral is actually in "rewarded"; the
// office can move a referral back (a mistaken issue), which clears it.
export const hasReward = (r) =>
  r.status === "rewarded" && isPlainObject(r.reward) && typeof r.reward.amount === "number";

export function dashboardTotals(referrals) {
  const t = { referred: referrals.length, booked: 0, rewarded: 0, pending: 0,
              credit_earned: 0, gift_cards_earned: 0 };
  for (const r of referrals) {
    if (r.status === "booked" || r.status === "rewarded") t.booked++;
    if (r.status === "rewarded") t.rewarded++;
    if (PENDING_STATUSES.includes(r.status)) t.pending++;
    if (hasReward(r)) {
      if (r.reward.type === "giftcard") t.gift_cards_earned++;
      else t.credit_earned += r.reward.amount;
    }
  }
  return t;
}

// What the referrer's private dashboard may see about a friend: masked
// name, status, dates, and the reward — never the friend's phone/email.
export const dashboardEntry = (r) => ({
  id: r.id,
  friend_name: maskedName(r.first_name, r.last_name),
  status: r.status,
  created_at: r.created_at,
  updated_at: r.updated_at,
  reward: isPlainObject(r.reward)
    ? { type: r.reward.type, amount: r.reward.amount, issued_at: r.reward.issued_at }
    : null,
});

export function adminStats(referrals) {
  const by_status = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  let rewards_owed = 0, credit_issued = 0, gift_cards_issued = 0;
  for (const r of referrals) {
    if (by_status[r.status] !== undefined) by_status[r.status]++;
    if (r.status === "booked") rewards_owed++;   // booked but not yet rewarded
    if (hasReward(r)) {
      if (r.reward.type === "giftcard") gift_cards_issued++;
      else credit_issued += r.reward.amount;
    }
  }
  return { total: referrals.length, by_status, rewards_owed, credit_issued, gift_cards_issued };
}

// Per-referrer counts for the admin "Referrers" view. The raw token is left
// out; the office gets it only as the ready-made tracking link (status_url),
// so a "resend your link" text is one tap and nothing has to be assembled.
export function referrerSummary(referrer, referrals) {
  const mine = referrals.filter((r) => r.referrer_id === referrer.id);
  return {
    id: referrer.id,
    code: referrer.code,
    status_url: referrer.token ? statusUrl(referrer.token) : "",
    first_name: referrer.first_name,
    last_name: referrer.last_name,
    phone: referrer.phone,
    email: referrer.email,
    reward_pref: referrer.reward_pref,
    created_at: referrer.created_at,
    updated_at: referrer.updated_at,
    referred: mine.length,
    booked: mine.filter((r) => r.status === "booked" || r.status === "rewarded").length,
    rewarded: mine.filter((r) => r.status === "rewarded").length,
  };
}

// Admin search: name / phone / code / email of the friend or the referrer.
// Digits in the query match phone digits so "(763) 555" finds 7635550101.
export function matchesQuery(r, q) {
  const needle = String(q || "").trim().toLowerCase();
  if (!needle) return true;
  const hay = [r.first_name, r.last_name, r.phone, r.phone_digits, r.email,
    r.referrer_name, r.referrer_phone, r.code, r.address, r.id]
    .filter(Boolean).join(" ").toLowerCase();
  if (hay.includes(needle)) return true;
  const digits = needle.replace(/\D/g, "");
  if (digits.length >= 3) {
    const refDigits = String(r.referrer_phone || "").replace(/\D/g, "");
    return String(r.phone_digits || "").includes(digits) || refDigits.includes(digits);
  }
  return false;
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------
export const CSV_COLUMNS = [
  ["id", (r) => r.id],
  ["created_at", (r) => r.created_at],
  ["updated_at", (r) => r.updated_at],
  ["status", (r) => r.status],
  ["duplicate_of", (r) => r.duplicate_of],
  ["friend_first_name", (r) => r.first_name],
  ["friend_last_name", (r) => r.last_name],
  ["friend_phone", (r) => r.phone],
  ["friend_email", (r) => r.email],
  ["friend_address", (r) => r.address],
  ["friend_note", (r) => r.note],
  ["office_note", (r) => r.office_note],
  ["referrer_id", (r) => r.referrer_id],
  ["referrer_name", (r) => r.referrer_name],
  ["referrer_phone", (r) => r.referrer_phone],
  ["code", (r) => r.code],
  ["reward_type", (r) => (r.reward ? r.reward.type : "")],
  ["reward_amount", (r) => (r.reward ? r.reward.amount : "")],
  ["reward_issued_at", (r) => (r.reward ? r.reward.issued_at : "")],
  ["reward_note", (r) => (r.reward ? r.reward.note : "")],
  ["quote_requested_at", (r) => r.quote_requested_at],
  ["rotor_delivered", (r) => (r.rotor ? r.rotor.delivered : "")],
  ["rotor_status", (r) => (r.rotor ? r.rotor.status : "")],
];

// RFC 4180 quoting, plus a leading apostrophe on anything a spreadsheet
// would otherwise evaluate as a formula (=, +, -, @) — customer-typed notes
// end up in Excel via this export. Phone numbers ("+1 763…") are exempt.
export const csvCell = (v) => {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^[+-]?[\d\s().-]+$/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCSV = (referrals) => {
  const lines = [CSV_COLUMNS.map(([h]) => h).join(",")];
  for (const r of referrals)
    lines.push(CSV_COLUMNS.map(([, get]) => csvCell(get(r))).join(","));
  return lines.join("\r\n") + "\r\n";
};

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

// Constant-time compare of the admin key. Hashing first makes both sides the
// same length, which timingSafeEqual requires, without leaking the length
// of the real key through an early exit.
export const safeEqual = (a, b) => {
  const da = createHash("sha256").update(String(a ?? "")).digest();
  const db = createHash("sha256").update(String(b ?? "")).digest();
  return timingSafeEqual(da, db);
};

export class TimeoutError extends Error {
  constructor(label) {
    super(`${label} timed out`);
    this.name = "TimeoutError";
  }
}
// Races a promise (or a function returning one) against a timer, clearing
// the timer either way so a fast call never keeps the event loop alive.
export function withTimeout(work, ms, label = "operation") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label)), ms);
  });
  const run = typeof work === "function" ? Promise.resolve().then(work) : Promise.resolve(work);
  return Promise.race([run, timeout]).finally(() => clearTimeout(timer));
}

// Runs an async mapper with bounded concurrency (keeps the admin list from
// firing hundreds of Blobs reads at once). Preserves input order.
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Error text safe for the function log: name plus a message with any long
// digit run masked, because Blobs errors can echo keys that contain phone
// numbers and Rotor errors can echo submitted fields.
export const safeErr = (err) => {
  const name = err && err.name ? String(err.name) : "Error";
  const msg = err && err.message
    ? String(err.message).replace(/\d{4,}/g, "####").slice(0, 160) : "";
  return msg ? `${name}: ${msg}` : name;
};
