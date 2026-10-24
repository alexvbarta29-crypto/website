// Pure helpers for the Holiday Lights Giveaway (docs/GIVEAWAY.md): entry
// validation, the service-area check, share codes, entry counting, the
// weighted drawing, text rendering and the CSV export. Nothing here touches
// the network or the store, so it is unit-tested directly.

import { randomInt } from "node:crypto";
import {
  GIVEAWAY, AREA_CITIES, SMS, shareUrl, statusUrl, claimUrl,
} from "./giveaway-config.mjs";
import {
  CODE_ALPHABET, CODE_LENGTH, clean, normalizePhone, randomString, nowISO, isPlainObject,
  ValidationError, csvCell, lastInitial,
} from "./referral-lib.mjs";

export { ValidationError };

export const CAPS = Object.freeze({ name: 60, phone: 25, street: 200, city: 80, state: 20, zip: 10 });

// ---------------------------------------------------------------------------
// Codes and ids
// ---------------------------------------------------------------------------
const PREFIX = GIVEAWAY.code_prefix;
const CODE_RE = new RegExp(`^${PREFIX}-?([${CODE_ALPHABET}]{${CODE_LENGTH}})$`);
export const newGiveawayCode = () => `${PREFIX}-${randomString(CODE_LENGTH)}`;
// "lights-7k3xq", "LIGHTS 7K3XQ" → "LIGHTS-7K3XQ"; anything else → "".
export const normalizeGiveawayCode = (raw) => {
  const s = String(raw || "").toUpperCase().replace(/[\s_]+/g, "").replace(/[‐-―]/g, "-");
  const m = CODE_RE.exec(s);
  return m ? `${PREFIX}-${m[1]}` : "";
};

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------
export const isOpen = (now = Date.now()) => now <= Date.parse(GIVEAWAY.closes_at);
export const claimOpen = (now = Date.now()) => now <= Date.parse(GIVEAWAY.claim_deadline);

// ---------------------------------------------------------------------------
// Service area
// ---------------------------------------------------------------------------
const toRad = (d) => (d * Math.PI) / 180;
export function milesBetween(a, b) {
  const R = 3958.8;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
export const normCity = (c) => clean(c).toLowerCase().replace(/\s+/g, " ").replace(/^saint /, "st. ");

// ok: true (in), false (out), null (couldn't tell: typed address, no
// coordinates, city not on the list). Coordinates win when present, because
// a city name alone can't tell a Plymouth, MN from a Plymouth elsewhere.
export function areaCheck(addr) {
  const hasCoords = Number.isFinite(addr.lat) && Number.isFinite(addr.lng);
  if (hasCoords) {
    const miles = milesBetween(GIVEAWAY.origin, { lat: addr.lat, lng: addr.lng });
    return { ok: miles <= GIVEAWAY.radius_mi, method: "distance", miles: Math.round(miles * 10) / 10 };
  }
  const state = clean(addr.state).toUpperCase();
  if (state && state !== "MN" && state !== "MINNESOTA") return { ok: false, method: "state", miles: null };
  const city = normCity(addr.city);
  if (city && (AREA_CITIES.has(city) || AREA_CITIES.has(city.replace(/^st\. /, "st "))))
    return { ok: true, method: "city", miles: null };
  return { ok: null, method: "none", miles: null };
}

// One entry per household: street + ZIP, letters and digits only, with the
// common suffix spellings folded together so "123 Main St" and "123 Main
// Street" collide. Empty when there isn't enough to tell.
const SUFFIXES = { street: "st", avenue: "ave", road: "rd", drive: "dr", lane: "ln", court: "ct",
  circle: "cir", boulevard: "blvd", parkway: "pkwy", trail: "trl", highway: "hwy", place: "pl",
  north: "n", south: "s", east: "e", west: "w" };
export function householdKey(addr) {
  const street = clean(addr.street).toLowerCase()
    .replace(/[.,#]/g, " ")
    .split(/\s+/).filter(Boolean).map((w) => SUFFIXES[w] || w).join("");
  const zip = clean(addr.zip).slice(0, 5);
  const city = normCity(addr.city).replace(/[^a-z]/g, "");
  if (!/^\d/.test(street)) return "";
  const where = zip || city;
  return where ? `${street.replace(/[^a-z0-9]/g, "")}-${where}` : "";
}

// ---------------------------------------------------------------------------
// Validation of POST /api/giveaway
// ---------------------------------------------------------------------------
const text = (v, path, cap, label, required = false) => {
  const s = clean(v);
  if (!s && required) throw new ValidationError(`${label} is required.`, path);
  if (s.length > cap) throw new ValidationError(`${label} is too long.`, path);
  return s;
};
const coord = (v, min, max) => {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};

// A whole address typed into the one box ("123 Main St, Delano, MN 55328",
// "123 Main St, Delano 55328") → its street, city, state and ZIP, so the
// household check and Rotor get the parts. Anything it can't read stays in
// the street, untouched.
const STATE_ZIP = /^(?:(MN|Minn\.?|Minnesota|[A-Z]{2})\b\.?)?\s*(\d{5}(?:-\d{4})?)?$/i;
// "1701 McLeod Ave N Glencoe MN 55336", typed with no commas: the town is
// the words between the street's suffix (Ave, St, Dr..., plus a trailing
// N/S/E/W) and the state or ZIP.
const STREET_SUFFIX = new Set(("st street ave avenue rd road dr drive ln lane ct court cir circle blvd boulevard "
  + "way trl trail pkwy parkway hwy highway pl place ter terrace pt point cv cove xing crossing loop run bnd bend "
  + "rdg ridge pass path sq square aly alley").split(" "));
const DIRECTIONAL = new Set("n s e w ne nw se sw north south east west northeast northwest southeast southwest".split(" "));
function splitNoCommas(line, known) {
  const t = String(line || "").trim().split(/\s+/);
  if (t.length < 4 || !/^\d/.test(t[0])) return {};
  const out = {};
  if (/^\d{5}(-\d{4})?$/.test(t[t.length - 1])) { if (!known.zip) out.zip = t.pop().slice(0, CAPS.zip); else t.pop(); }
  if (/^(mn|minn\.?|minnesota)$/i.test(t[t.length - 1] || "")) { t.pop(); if (!known.state) out.state = "MN"; }
  let end = -1;
  for (let i = 1; i < t.length - 1; i++) if (STREET_SUFFIX.has(t[i].toLowerCase().replace(/\.$/, ""))) end = i;
  if (end < 0) return {};
  if (DIRECTIONAL.has((t[end + 1] || "").toLowerCase().replace(/\.$/, "")) && end + 2 < t.length) end++;
  const city = t.slice(end + 1).join(" ");
  if (!city || /\d/.test(city) || city.length > CAPS.city || (!out.zip && !out.state)) return {};
  return { street: t.slice(0, end + 1).join(" "), city, ...out };
}

export function splitTypedAddress(line, known = {}) {
  const parts = String(line || "").split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 1) return splitNoCommas(parts[0], known);
  if (parts.length < 2 || !/\d/.test(parts[0])) return {};
  const out = { street: parts[0] };
  let rest = parts.slice(1);
  if (/^(usa?|united states)$/i.test(rest[rest.length - 1] || "")) rest = rest.slice(0, -1);
  // The last part may be "MN 55328", "55328", or "Delano MN 55328".
  const last = rest[rest.length - 1] || "";
  const tail = last.match(/^(.*?)[\s]*\b((?:MN|Minn\.?|Minnesota|[A-Z]{2})\.?\s*(?:\d{5}(?:-\d{4})?)?|\d{5}(?:-\d{4})?)$/i);
  if (STATE_ZIP.test(last)) {
    const m = last.match(STATE_ZIP);
    if (m[1] && !known.state) out.state = /^min/i.test(m[1]) ? "MN" : m[1].toUpperCase();
    if (m[2] && !known.zip) out.zip = m[2].slice(0, CAPS.zip);
    rest = rest.slice(0, -1);
  } else if (tail && tail[1] && /\d|^(MN|Minn|Minnesota)/i.test(tail[2])) {
    const m = tail[2].match(STATE_ZIP);
    if (m) {
      if (m[1] && !known.state) out.state = /^min/i.test(m[1]) ? "MN" : m[1].toUpperCase();
      if (m[2] && !known.zip) out.zip = m[2].slice(0, CAPS.zip);
      rest = [...rest.slice(0, -1), tail[1]];
    }
  }
  const city = rest[0] || "";
  if (!city || /\d/.test(city) || city.length > CAPS.city) return {};
  out.city = city;
  return out;
}

export function validateEntry(body) {
  if (!isPlainObject(body)) throw new ValidationError("Invalid request.");
  if (clean(body.website)) throw new ValidationError("Invalid request.");   // honeypot
  const first_name = text(body.first_name, "first_name", CAPS.name, "First name", true);
  const last_name = text(body.last_name, "last_name", CAPS.name, "Last name");
  const phone = text(body.phone, "phone", CAPS.phone, "Mobile number", true);
  const phone_digits = normalizePhone(phone);
  if (!phone_digits) throw new ValidationError("Mobile number needs to be a 10-digit US number.", "phone");
  const street = text(body.address_street || body.address, "address", CAPS.street, "Address", true);
  if (!/\d/.test(street)) throw new ValidationError("Please include your house number.", "address");
  const address = {
    street,
    city: text(body.address_city, "address", CAPS.city, "City"),
    state: text(body.address_state, "address", CAPS.state, "State"),
    zip: text(body.address_zip, "address", CAPS.zip, "ZIP"),
    lat: coord(body.address_lat, -90, 90),
    lng: coord(body.address_lng, -180, 180),
    verified: ["yes", "typed"].includes(clean(body.address_verified)) ? clean(body.address_verified) : "no",
  };
  if (!address.city) Object.assign(address, splitTypedAddress(address.street, address));
  if (body.consent !== true && body.consent !== "on" && body.consent !== "true")
    throw new ValidationError("Please check the box to agree to giveaway texts.", "consent");
  const yes = (v) => v === true || v === "on" || v === "true";
  return {
    first_name, last_name, phone, phone_digits, address, offers: yes(body.offers),
    ref_code: normalizeGiveawayCode(body.ref || body.ref_code),
    page: text(body.page, "page", 200, "Page"),
  };
}

export const addressLine = (a) =>
  [a.street, a.city, [a.state, a.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------
export function buildEntrant({ entry, code, token, area, household, referrer, now = nowISO() }) {
  return {
    id: entry.phone_digits,
    code, token,
    first_name: entry.first_name, last_name: entry.last_name,
    phone: entry.phone, phone_digits: entry.phone_digits,
    address: entry.address,
    household,
    area,
    referred_by: referrer ? { id: referrer.id, code: referrer.code,
      name: `${referrer.first_name} ${lastInitial(referrer.last_name)}.`.trim() } : null,
    consent_at: now,
    offers_opt_in: Boolean(entry.offers),
    source_page: entry.page || "/giveaway",
    rotor: null,
    sms: {},
    coupon: null,
    office_note: "",
    created_at: now,
    updated_at: now,
  };
}

// An entrant counts toward the drawing unless the office has marked them
// ineligible or the area check said no. (Out-of-area people are refused at
// the door, so area.ok === false only appears after an office override.)
export const eligible = (e) => !e.disqualified && !(e.area && e.area.ok === false);

// entries = 1 + every eligible entrant who signed up through their link.
export function entryCounts(entrants) {
  const counts = new Map();
  for (const e of entrants) if (eligible(e)) counts.set(e.id, 1);
  for (const e of entrants) {
    if (!eligible(e) || !e.referred_by) continue;
    const rid = e.referred_by.id;
    if (counts.has(rid)) counts.set(rid, counts.get(rid) + 1);
  }
  return counts;
}

// Weighted draw without replacement. `rand(n)` returns an integer in
// [0, n) — crypto by default, injectable for tests. Returns the drawn
// winners plus, for each one who entered through a friend's link, that
// friend as a bonus winner ("if your friend wins, you both win") unless
// they already won themselves.
export function draw(entrants, { n = GIVEAWAY.winners, exclude = new Set(), rand = randomInt } = {}) {
  const counts = entryCounts(entrants);
  const byId = new Map(entrants.map((e) => [e.id, e]));
  const pool = [...counts.entries()].filter(([id]) => !exclude.has(id));
  const drawn = [];
  while (drawn.length < n && pool.length) {
    const total = pool.reduce((s, [, c]) => s + c, 0);
    let ticket = rand(total);
    let i = 0;
    while (ticket >= pool[i][1]) { ticket -= pool[i][1]; i++; }
    drawn.push({ id: pool[i][0], entries: pool[i][1], ticket_pool: total });
    pool.splice(i, 1);
  }
  const winnerIds = new Set([...exclude, ...drawn.map((d) => d.id)]);
  const bonus = [];
  for (const d of drawn) {
    const e = byId.get(d.id);
    const rid = e && e.referred_by && e.referred_by.id;
    if (rid && byId.has(rid) && eligible(byId.get(rid)) && !winnerIds.has(rid)) {
      bonus.push({ id: rid, because_of: d.id });
      winnerIds.add(rid);
    }
  }
  return { drawn, bonus };
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------
export const publicReferral = (e) => ({ first_name: e.first_name, last_initial: lastInitial(e.last_name) });

// `friends` = the entrant records that signed up through this entrant's
// link (from the idx/ref index), so the public page never loads everyone.
export function statusView(entrant, friends, drawResult, now = Date.now()) {
  const counted = friends.filter(eligible);
  const winnerIds = new Set(drawResult ? drawResult.winners.map((w) => w.id) : []);
  return {
    first_name: entrant.first_name,
    code: entrant.code,
    share_url: shareUrl(entrant.code),
    entries: eligible(entrant) ? 1 + counted.length : 0,
    friends: counted.map((f) => `${f.first_name} ${lastInitial(f.last_name)}.`),
    drawn: Boolean(drawResult),
    won: winnerIds.has(entrant.id),
    coupon: {
      amount: GIVEAWAY.coupon,
      available: Boolean(drawResult) && !winnerIds.has(entrant.id) && now <= Date.parse(GIVEAWAY.claim_deadline),
      claimed_at: entrant.coupon ? entrant.coupon.claimed_at : null,
      expires_at: GIVEAWAY.claim_deadline,
    },
    open: isOpen(now),
  };
}

export const textVars = (e, counts) => ({
  first: e.first_name,
  entries: (counts && counts.get(e.id)) || 1,
  share_url: shareUrl(e.code),
  status_url: statusUrl(e.token),
  claim_url: claimUrl(e.token),
});
export const renderText = (template, e, counts, extra = {}) =>
  SMS[template]({ ...textVars(e, counts), ...extra });

// Who a broadcast goes to. Everyone consented at entry; a winner never gets
// the "you didn't win" texts; follow-ups only reach people who got the coupon
// text and haven't claimed. Already-sent recipients are skipped, so a batch
// that stops halfway can simply be run again.
export function broadcastAudience(template, entrants, drawResult) {
  const winners = new Set(drawResult ? drawResult.winners.map((w) => w.id) : []);
  return entrants.filter((e) => {
    if (e.disqualified || e.sms_opt_out) return false;
    if (e.sms && (e.sms[template] || e.sms[`${template}_failed`])) return false;
    if (template === "nudge") return true;
    if (winners.has(e.id)) return false;
    // The coupon and its follow-ups are promotional: only for people who
    // ticked the optional offers box (giveaway consent alone covers the rest).
    if (!e.offers_opt_in) return false;
    if (template === "coupon") return true;
    // follow-ups
    return Boolean(e.sms && e.sms.coupon) && !(e.coupon && e.coupon.claimed_at);
  });
}

// ---------------------------------------------------------------------------
// CSV export: everything the office might load into another texting tool,
// including each person's personalised nudge and coupon text.
// ---------------------------------------------------------------------------
export function toCSV(entrants, counts, drawResult) {
  const winners = new Map((drawResult ? drawResult.winners : []).map((w) => [w.id, w.kind]));
  const cols = [
    ["first_name", (e) => e.first_name],
    ["last_name", (e) => e.last_name],
    ["phone", (e) => e.phone],
    ["street", (e) => e.address.street],
    ["city", (e) => e.address.city],
    ["state", (e) => e.address.state],
    ["zip", (e) => e.address.zip],
    ["area_check", (e) => (e.area.ok === true ? "in" : e.area.ok === false ? "out" : "unverified")],
    ["miles", (e) => e.area.miles ?? ""],
    ["entries", (e) => counts.get(e.id) || 0],
    ["referred_by", (e) => (e.referred_by ? e.referred_by.name : "")],
    ["share_code", (e) => e.code],
    ["share_url", (e) => shareUrl(e.code)],
    ["status_url", (e) => statusUrl(e.token)],
    ["winner", (e) => winners.get(e.id) || ""],
    ["coupon_claimed_at", (e) => (e.coupon ? e.coupon.claimed_at : "")],
    ["offers_opt_in", (e) => (e.offers_opt_in ? "yes" : "")],
    ["disqualified", (e) => (e.disqualified ? "yes" : "")],
    ["entered_at", (e) => e.created_at],
    ["nudge_text", (e) => renderText("nudge", e, counts)],
    ["coupon_text", (e) => renderText("coupon", e, counts)],
  ];
  const lines = [cols.map(([h]) => h).join(",")];
  for (const e of entrants) lines.push(cols.map(([, get]) => csvCell(get(e))).join(","));
  return "﻿" + lines.join("\r\n") + "\r\n";
}
