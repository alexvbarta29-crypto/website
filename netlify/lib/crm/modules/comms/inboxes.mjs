// Comms: team inboxes, the business numbers and the text price (the Rotor
// guide's Inbox and Engagement settings: guide-gaps §2.3 I1, I2, I6, §4 S5a,
// S6, §7.4 S46c, S50).
//
// - cfg/inboxes { list: [{ key, name, member_ids, match: { lifecycle?, channel? }, notify_ids }] }:
//   Rotor's "My inboxes / Other inboxes". A conversation belongs to the inbox
//   a person moved it to (conversation.inbox, row `ib`), else to the first
//   inbox whose match fits it (worked out when read, so a new rule also
//   sorts the conversations already there). An inbox with no match only
//   holds what was moved into it.
// - cfg/engagement { numbers: [{ e164, label, sms, voice, default_for }], email_from }:
//   the business numbers. With two or more texting numbers the composer
//   shows "From ...". Nothing is bought or changed at Twilio from here:
//   until texting is connected every send is a dry run (the Outbox).
// - cfg/sms_pricing { per_segment_cents, mms_cents }: what a text blast's
//   cost line multiplies (Twilio's price; the owner can change it).

import { InputError } from "../../core/errors.mjs";
import { isId } from "../../core/ids.mjs";

export const MAX_INBOXES = 10;
export const INBOX_LIFECYCLES = Object.freeze(["lead", "customer", "former_customer"]);
const KEY = /^[a-z0-9][a-z0-9_-]{0,23}$/;
const plain = (v) => !!v && typeof v === "object" && !Array.isArray(v);
export const keyOfName = (name) => String(name || "").toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "inbox";

const userIds = (v, f, max = 20) => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > max || v.some((x) => !isId(x, "user"))) throw new InputError("Pick people on the team.", f);
  return [...new Set(v)];
};

export const INBOXES_DEFAULTS = Object.freeze({ list: [] });
export function validateInboxes(v) {
  const list = plain(v) && Array.isArray(v.list) ? v.list : [];
  if (list.length > MAX_INBOXES) throw new InputError(`Up to ${MAX_INBOXES} team inboxes.`, "list");
  const seen = new Set();
  return { list: list.map((x, i) => {
    const f = `list.${i}`;
    if (!plain(x)) throw new InputError("Expected an inbox.", f);
    const name = String(x.name || "").replace(/\s+/g, " ").trim();
    if (!name || name.length > 40) throw new InputError("Give the inbox a short name.", `${f}.name`);
    const key = x.key === undefined || x.key === null || x.key === "" ? keyOfName(name) : String(x.key);
    if (!KEY.test(key)) throw new InputError("Use letters, numbers and dashes.", `${f}.key`);
    if (["all", "mine", "unread", "needs_reply"].includes(key) || seen.has(key)) throw new InputError("Pick another name: that one is taken.", `${f}.name`);
    seen.add(key);
    const m = plain(x.match) ? x.match : {};
    const match = {};
    if (m.lifecycle !== undefined && m.lifecycle !== null && m.lifecycle !== "") {
      const lc = Array.isArray(m.lifecycle) ? m.lifecycle : [m.lifecycle];
      if (lc.some((l) => !INBOX_LIFECYCLES.includes(l))) throw new InputError("Leads, customers or former customers.", `${f}.match.lifecycle`);
      if (lc.length) match.lifecycle = [...new Set(lc)];
    }
    if (m.channel !== undefined && m.channel !== null && m.channel !== "") {
      if (!["sms", "email"].includes(m.channel)) throw new InputError("Texts or email.", `${f}.match.channel`);
      match.channel = m.channel;
    }
    return { key, name, member_ids: userIds(x.member_ids, `${f}.member_ids`), match, notify_ids: userIds(x.notify_ids, `${f}.notify_ids`) };
  }) };
}

// The inbox an index row (or a conversation) is in, or null.
const fits = (match, r) => {
  const keys = Object.keys(match || {});
  if (!keys.length) return false;
  if (match.lifecycle && !match.lifecycle.includes(r.lc === "former_customer" ? "former_customer" : r.lc)) return false;
  if (match.channel && match.channel !== r.ch) return false;
  return true;
};
export function inboxOf(r, list = []) {
  if (r.ib) return list.some((x) => x.key === r.ib) ? r.ib : null;
  const hit = list.find((x) => fits(x.match, r));
  return hit ? hit.key : null;
}

// The folder counts over the open conversations (one read of the open
// shard): open threads, mine, unread, needing a reply, and per team inbox.
// A person's texts and email count once (one thread per person).
export function countsOf(rows, { userId, list = [], visible = null, channel = null } = {}) {
  const people = (pick) => new Set(rows.filter((r) => (!visible || visible.has(r.c)) && (!channel || r.ch === channel) && pick(r)).map((r) => r.c)).size;
  const out = { all: people(() => true), mine: people((r) => r.a === userId), unread: people((r) => r.u > 0), needs_reply: people((r) => r.nr), inboxes: {} };
  for (const x of list) out.inboxes[x.key] = people((r) => inboxOf(r, list) === x.key);
  return out;
}

// ------------------------------------------------------------ business numbers

const E164 = /^\+1[2-9]\d{2}[2-9]\d{6}$/;
export const NUMBER_USES = Object.freeze(["automations", "inbox", "dialer"]);
export const ENGAGEMENT_DEFAULTS = Object.freeze({ numbers: [], email_from: "" });
export function validateEngagement(v) {
  const o = plain(v) ? v : {};
  const list = Array.isArray(o.numbers) ? o.numbers : [];
  if (list.length > 10) throw new InputError("Up to 10 numbers.", "numbers");
  const seen = new Set();
  const taken = new Set();
  const numbers = list.map((n, i) => {
    const f = `numbers.${i}`;
    if (!plain(n)) throw new InputError("Expected a number.", f);
    const digits = String(n.e164 || "").replace(/[^\d+]/g, "");
    const e164 = digits.startsWith("+") ? digits : digits.length === 10 ? `+1${digits}` : digits.length === 11 && digits[0] === "1" ? `+${digits}` : digits;
    if (!E164.test(e164)) throw new InputError("A US number, like (763) 555-0100.", `${f}.e164`);
    if (seen.has(e164)) throw new InputError("That number is listed twice.", `${f}.e164`);
    seen.add(e164);
    const label = String(n.label || "").replace(/\s+/g, " ").trim().slice(0, 30);
    const uses = Array.isArray(n.default_for) ? [...new Set(n.default_for)] : [];
    if (uses.some((u) => !NUMBER_USES.includes(u))) throw new InputError("Automations, the inbox or the dialer.", `${f}.default_for`);
    // one default per use: the first number that claims it keeps it
    const default_for = uses.filter((u) => !taken.has(u));
    default_for.forEach((u) => taken.add(u));
    return { e164, label, sms: n.sms !== false, voice: n.voice !== false, default_for };
  });
  const email_from = String(o.email_from || "").trim();
  if (email_from && (email_from.length > 120 || !/^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/i.test(email_from))) throw new InputError("An email address, like office@example.com.", "email_from");
  return { numbers, email_from };
}
// The numbers a person may pick to text from (two or more: the composer's chip).
export const textingNumbers = (eng) => ((eng && eng.numbers) || []).filter((n) => n.sms);
export const defaultNumber = (eng, use = "inbox") => {
  const list = textingNumbers(eng);
  return (list.find((n) => n.default_for.includes(use)) || list[0] || null);
};

// ------------------------------------------------------------ the price of a text

export const SMS_PRICING_DEFAULTS = Object.freeze({ per_segment_cents: 0.83, mms_cents: 2.2 });
export function validateSmsPricing(v) {
  const o = plain(v) ? v : {};
  const num = (k, max) => {
    const n = o[k] === undefined || o[k] === null || o[k] === "" ? SMS_PRICING_DEFAULTS[k] : Number(o[k]);
    if (!Number.isFinite(n) || n < 0 || n > max) throw new InputError(`Between 0 and ${max} cents.`, k);
    return Math.round(n * 1000) / 1000;
  };
  return { per_segment_cents: num("per_segment_cents", 20), mms_cents: num("mms_cents", 50) };
}
