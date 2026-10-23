// Public side of the Holiday Lights Giveaway (docs/GIVEAWAY.md):
//
//   POST /api/giveaway                          enter (name, mobile, address, consent, ref?)
//   POST /api/giveaway {action:"claim", t}      a non-winner claims the coupon
//   POST /api/giveaway {action:"outside_quote"} someone outside the area asks for a quote
//   GET  /api/giveaway                          phase + entrant count (for the page)
//   GET  /api/giveaway?code=LIGHTS-XXXXX        who invited this visitor (first name only)
//   GET  /api/giveaway?t=TOKEN                  an entrant's private status (entries, friends, coupon)
//
// Every entry becomes a Rotor lead tagged "Giveaway 2026"; a claimed coupon
// adds "Giveaway - Coupon Claimed" so the office can send the quote fast.
// Every tag name lives in TAGS (netlify/lib/giveaway-config.mjs).

import { GIVEAWAY, SMS, siteUrl, shareUrl, statusUrl, DATES, TAGS } from "../lib/giveaway-config.mjs";
import {
  validateEntry, ValidationError, areaCheck, householdKey, buildEntrant, newGiveawayCode,
  normalizeGiveawayCode, statusView, isOpen, claimOpen, addressLine, renderText,
} from "../lib/giveaway-lib.mjs";
import {
  openStore, getEntrant, idForCode, idForToken, idForHousehold, friendsOf, saveNewEntrant,
  saveEntrantRecord, allocateCode, getDraw, listKeys, putJSON, KEYS, guarded,
} from "../lib/giveaway-store.mjs";
import { sendSms, e164, officePhone } from "../lib/referral-notify.mjs";
import { upsertGiveawayLead, rotorEntryPayload, rotorClaimPayload } from "../lib/giveaway-rotor.mjs";
import { newToken, nowISO, safeErr, withTimeout, fullName, lastInitial, normalizePhone } from "../lib/referral-lib.mjs";

const json = (body, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const fail = (status, error, extra = {}) => json({ ok: false, error, ...extra }, status);

// Texts from this endpoint (the welcome text, the office's claim alert) only
// go out when GIVEAWAY_SMS_MODE=on and Twilio is configured.
const smsOn = () => String(process.env.GIVEAWAY_SMS_MODE || "off").trim().toLowerCase() === "on";

export default async (req) => {
  try {
    if (req.method === "GET") return await get(req);
    if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
    let body;
    try { body = await req.json(); } catch { body = null; }
    if (!body || typeof body !== "object" || Array.isArray(body)) return fail(400, "Invalid request.");
    if (body.action === "claim") return await claim(body);
    if (body.action === "outside_quote") return await outsideQuote(body);
    if (body.action === "lookup") return await lookup(body);
    return await enter(body);
  } catch (err) {
    console.error(`giveaway: ${req.method} failed (${safeErr(err)})`);
    return fail(503, "Something went wrong on our end. Please call or text us at (763) 314-3400.");
  }
};

export const config = { path: "/api/giveaway" };

// ---------------------------------------------------------------------------
async function get(req) {
  const url = new URL(req.url);
  const store = await openStore();
  const token = String(url.searchParams.get("t") || "").trim().toUpperCase();
  if (token) {
    const id = /^[A-Z0-9]{24}$/.test(token) ? await idForToken(store, token) : null;
    const e = id ? await getEntrant(store, id) : null;
    if (!e) return fail(404, "We couldn't find that entry link.");
    const [friends, drawResult] = await Promise.all([friendsOf(store, e.id), getDraw(store)]);
    return json({ ok: true, entrant: statusView(e, friends, drawResult) });
  }
  const code = normalizeGiveawayCode(url.searchParams.get("code"));
  if (url.searchParams.has("code")) {
    const id = code ? await idForCode(store, code) : null;
    const e = id ? await getEntrant(store, id) : null;
    if (!e) return fail(404, "Unknown code.");
    return json({ ok: true, code, first_name: e.first_name, last_initial: lastInitial(e.last_name) });
  }
  const [keys, drawResult] = await Promise.all([listKeys(store, "entrant/"), getDraw(store)]);
  return json({
    ok: true, open: isOpen(), drawn: Boolean(drawResult), entrants: keys.length,
    closes_at: GIVEAWAY.closes_at, draw_at: GIVEAWAY.draw_at,
  });
}

// ---------------------------------------------------------------------------
// Server-side geocode for an address typed without picking a suggestion.
// Nominatim's policy asks for an identifying User-Agent and <=1 req/s; this
// runs at most once per entry, behind a short timeout.
async function geocode(addr) {
  const q = addressLine(addr) || addr.street;
  try {
    const res = await fetch(
      "https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&addressdetails=1"
      + "&viewbox=-94.3,45.4,-93.2,44.7&bounded=0&q=" + encodeURIComponent(q + (addr.state ? "" : ", MN")),
      { headers: { "User-Agent": "BartaWindowWashing-Giveaway/1.0 (office@bartawindowwashing.com)",
                   Accept: "application/json" },
        signal: AbortSignal.timeout(2500) });
    if (!res.ok) return null;
    const [hit] = await res.json();
    if (!hit) return null;
    const lat = parseFloat(hit.lat), lng = parseFloat(hit.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const a = hit.address || {};
    return { lat, lng, city: a.city || a.town || a.village || a.hamlet || "", zip: a.postcode || "" };
  } catch {
    return null;
  }
}

async function checkArea(addr) {
  let area = areaCheck(addr);
  if (area.method === "distance") return area;
  const geo = await geocode(addr);
  if (geo) {
    if (!addr.city && geo.city) addr.city = geo.city;
    if (!addr.zip && geo.zip) addr.zip = geo.zip;
    const byGeo = areaCheck({ ...addr, lat: geo.lat, lng: geo.lng });
    // A typed address that geocodes far away but names a listed city is
    // more likely a geocoder miss than an outsider: trust the city.
    if (byGeo.ok === false && area.ok === true) return { ...area, geocoded_miles: byGeo.miles };
    return { ...byGeo, method: "geocoded" };
  }
  return area;
}

const OUTSIDE_MSG =
  "Sorry, that address is outside our service area, so it can't be entered in the giveaway.";

async function enter(body) {
  if (!isOpen()) return fail(410, `Entries closed ${DATES.closes}. The drawing is ${DATES.draw}.`);
  let entry;
  try { entry = validateEntry(body); } catch (err) {
    if (err instanceof ValidationError) return fail(400, err.message, err.field ? { field: err.field } : {});
    throw err;
  }
  const area = await checkArea(entry.address);
  if (area.ok === false) return fail(422, OUTSIDE_MSG, { out_of_area: true, field: "address" });

  const store = await openStore();
  return guarded("enter", async () => {
    const existing = await getEntrant(store, entry.phone_digits);
    if (existing) {
      // A phone number alone never unlocks someone's private link, but the
      // share link is public anyway, so a returning visitor can keep sharing.
      return json({ ok: true, returning: true, code: existing.code, share_url: shareUrl(existing.code),
                    first_name: existing.first_name });
    }
    const household = householdKey(entry.address);
    if (household && (await idForHousehold(store, household)))
      return fail(409, "Someone at this address has already entered. It's one entry per household, "
        + "but every friend who enters with their link adds an entry for them.", { field: "address" });

    let referrer = null;
    if (entry.ref_code) {
      const rid = await idForCode(store, entry.ref_code);
      const r = rid && rid !== entry.phone_digits ? await getEntrant(store, rid) : null;
      if (r && r.household !== household) referrer = r;
    }

    const code = await allocateCode(store, newGiveawayCode);
    const token = newToken();
    const e = buildEntrant({ entry, code, token, area, household, referrer });
    await saveNewEntrant(store, e);

    // Rotor + welcome text: best-effort, never blocks the confirmation.
    e.rotor = await withTimeout(() => upsertGiveawayLead(rotorEntryPayload(e)), 8000, "rotor")
      .catch((err) => ({ delivered: false, status: null, error: safeErr(err) }));
    if (smsOn()) {
      const sent = await sendSms(e164(e.phone), renderText("welcome", e, null)).catch(() => false);
      if (sent) e.sms.welcome = nowISO();
    }
    e.updated_at = nowISO();
    await saveEntrantRecord(store, e).catch(() => {});

    return json({
      ok: true, returning: false, code, token,
      share_url: shareUrl(code), status_url: statusUrl(token),
      first_name: e.first_name, entries: 1,
      referred_by: referrer ? referrer.first_name : null,
      area: area.ok === true ? "in" : "unverified",
    });
  });
}

export { rotorEntryPayload };

// ---------------------------------------------------------------------------
// "Check my entries" by mobile number, for people arriving from a Rotor
// text (which can't carry each person's own link). Reveals only what is
// already public or harmless: first name, entry count, and the share link.
async function lookup(body) {
  const digits = normalizePhone(body.phone);
  if (!digits) return fail(400, "Enter the 10-digit mobile number you entered with.", { field: "phone" });
  const store = await openStore();
  const e = await getEntrant(store, digits);
  if (!e) return fail(404, "We couldn't find an entry for that number. Enter above!");
  const view = statusView(e, await friendsOf(store, e.id), await getDraw(store));
  return json({ ok: true, first_name: view.first_name, entries: view.entries,
                friends: view.friends.length, share_url: view.share_url });
}

// ---------------------------------------------------------------------------
async function claim(body) {
  const token = String(body.t || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{24}$/.test(token)) return fail(404, "We couldn't find that entry link.");
  const store = await openStore();
  const id = await idForToken(store, token);
  const e = id ? await getEntrant(store, id) : null;
  if (!e) return fail(404, "We couldn't find that entry link.");
  const drawResult = await getDraw(store);
  if (!drawResult) return fail(409, `The coupon unlocks after the drawing on ${DATES.draw}.`);
  if (drawResult.winners.some((w) => w.id === e.id)) return fail(409, "You won! No coupon needed, we'll be in touch.");
  if (e.coupon && e.coupon.claimed_at) return json({ ok: true, claimed_at: e.coupon.claimed_at, already: true });
  if (!claimOpen()) return fail(410, `Sorry, the $${GIVEAWAY.coupon} coupon expired ${DATES.claim_by}.`);

  const at = nowISO();
  const rotor = await withTimeout(() => upsertGiveawayLead(rotorClaimPayload(e, at)), 8000, "rotor")
    .catch((err) => ({ delivered: false, error: safeErr(err) }));

  e.coupon = { claimed_at: at, rotor };
  e.updated_at = at;
  await saveEntrantRecord(store, e);

  if (smsOn() && officePhone())
    await sendSms(officePhone(), SMS.office_claim({
      name: fullName(e.first_name, e.last_name), phone: e.phone, address: addressLine(e.address),
    })).catch(() => false);

  return json({ ok: true, claimed_at: at, already: false });
}

// ---------------------------------------------------------------------------
async function outsideQuote(body) {
  let entry;
  try { entry = validateEntry({ ...body, consent: true }); } catch (err) {
    if (err instanceof ValidationError) return fail(400, err.message, err.field ? { field: err.field } : {});
    throw err;
  }
  const area = areaCheck(entry.address);
  // A real quote request, so it arrives like any website quote (and joins
  // the sales pipeline the same way); the tag says where it came from.
  const rotor = await withTimeout(() => upsertGiveawayLead({
    phone: entry.phone,
    tags: [TAGS.OUTSIDE],
    name: fullName(entry.first_name, entry.last_name),
    fields: {
      source: "Website quote form",
      address_street1: entry.address.street,
      ...(entry.address.city ? { address_city: entry.address.city } : {}),
      address_state: entry.address.state || "MN",
      ...(entry.address.zip ? { address_zip: entry.address.zip } : {}),
      address_country: "US",
    },
    notes: "Tried to enter the giveaway from outside the service area"
      + (area.miles ? ` (${area.miles} mi from Delano)` : "")
      + " and asked for a free quote anyway.",
  }), 8000, "rotor").catch(() => ({ delivered: false }));
  try {
    const store = await openStore();
    await putJSON(store, KEYS.outside(entry.phone_digits), {
      id: entry.phone_digits, first_name: entry.first_name, last_name: entry.last_name,
      phone: entry.phone, address: entry.address, area, rotor, created_at: nowISO(),
    });
  } catch (err) {
    console.error(`giveaway: outside store failed (${safeErr(err)})`);
  }
  if (!rotor.delivered) return fail(502, "We couldn't send that just now. Please call or text (763) 314-3400.");
  return json({ ok: true });
}
