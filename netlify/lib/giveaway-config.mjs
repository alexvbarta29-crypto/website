// Single source of truth for the Holiday Lights Giveaway on the serverless
// side (docs/GIVEAWAY.md). GIVEAWAY in build/sitedata.py is the mirror that
// drives every date and dollar amount printed on the pages — change both
// together, or the pages will promise one thing and the texts another.
//
// Everything here is public (it is printed on the site and in the official
// rules). Secrets (ROTOR_API_KEY, REFERRAL_ADMIN_KEY / GIVEAWAY_ADMIN_KEY,
// Twilio) are read from the environment at call time.

import { DEFAULT_SITE_URL, OFFICE_PHONE_DISPLAY } from "./referral-config.mjs";

export const GIVEAWAY = Object.freeze({
  name: "Holiday Lights Giveaway",
  year: 2026,
  winners: 2,                       // drawn winners (a drawn winner's referrer also wins)
  prize_value: 1500,                // approximate retail value of one prize, $
  coupon: 250,                      // $ off for every entrant who doesn't win
  // All instants are absolute (UTC) so the server and every browser agree.
  // Entries close Thu Nov 5, 11:59:59 PM Central (CST, UTC-6; DST ended Nov 1).
  closes_at: "2026-11-06T05:59:59Z",
  // Drawing: Fri Nov 6, 6:00 PM Central.
  draw_at: "2026-11-07T00:00:00Z",
  // The non-winner coupon is good for 72 hours after the drawing.
  claim_deadline: "2026-11-10T00:00:00Z",
  code_prefix: "LIGHTS",            // share codes look like LIGHTS-7K3XQ
  // Who can enter: within this many straight-line miles of the shop. Never
  // printed on the page or in texts (owner's call); the map shows the circle.
  radius_mi: 17,
  origin: Object.freeze({ lat: 45.0419, lng: -93.7891 }),   // Delano shop
});

// Display strings, matching the official rules page.
export const DATES = Object.freeze({
  closes: "Thursday, November 5 at 11:59 PM",
  draw: "Friday, November 6",
  draw_short: "Fri, Nov 6",
  claim_by: "Monday, November 9 at 6 PM",
  claim_by_short: "Mon 11/9 at 6 PM",
});

// Every city on the site's service-area list (sitedata.AREAS), lowercased.
// An address in one of these is in the area even when it can't be geocoded.
// Towns whose centre sits within ~15 straight-line miles of Delano. An
// address in one of these is treated as in the area when it couldn't be
// geocoded; any other town is accepted but flagged "check address".
export const AREA_CITIES = Object.freeze(new Set([
  "delano", "independence", "rockford", "watertown", "montrose", "greenfield", "maple plain",
  "loretto", "minnetrista", "waverly", "mound", "st. bonifacius", "st bonifacius", "saint bonifacius",
  "hanover", "buffalo", "medina", "orono", "spring park", "long lake", "mayer", "corcoran",
  "minnetonka beach", "hamel", "st. michael", "st michael", "saint michael", "waconia", "tonka bay",
  "howard lake", "new germany", "victoria", "excelsior", "wayzata", "greenwood", "albertville",
]));

export const STORE_NAME = "giveaway";

export const siteUrl = () =>
  (process.env.SITE_URL || process.env.URL || DEFAULT_SITE_URL).trim().replace(/\/+$/, "");
export const shareUrl = (code) => `${siteUrl()}/g/${code}`;
export const statusUrl = (token) => `${siteUrl()}/giveaway?t=${token}`;
export const claimUrl = (token) => `${siteUrl()}/giveaway?t=${token}&claim=1`;
export const adminUrl = () => `${siteUrl()}/admin/giveaway.html`;
export { OFFICE_PHONE_DISPLAY };

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// Text templates. The admin dashboard's one-tap sms: links and the CSV
// export use the same functions, so a hand-sent text and an automatic one
// read identically. Each keeps to one segment-ish message with an opt-out.
export const SMS = Object.freeze({
  welcome: ({ first, share_url, status_url }) =>
    `You're in, ${first}! Barta's Holiday Lights Giveaway drawing is ${DATES.draw_short}. `
    + `Share your link: ${share_url} Every friend who enters with it = +1 chance for you, `
    + `and if they win, you BOTH win. Your entries: ${status_url} Reply STOP to opt out.`,
  nudge: ({ first, entries, share_url }) =>
    `Drawing's in 3 days, ${first}! You have ${plural(entries, "entry", "entries")} in Barta's `
    + `Holiday Lights Giveaway. Every friend who enters through your link adds one, and if they win, `
    + `you BOTH win: ${share_url} Reply STOP to opt out.`,
  winner: ({ first, bonus }) =>
    `Congrats ${first}! ${bonus ? "A friend you invited won, so you win too: " : "You won "}`
    + `a free Christmas light installation (up to $${GIVEAWAY.prize_value}) in Barta's Holiday Lights `
    + `Giveaway! We'll call you shortly to set it up. Questions? ${OFFICE_PHONE_DISPLAY}`,
  coupon: ({ first, claim_url }) =>
    `${first}, the Barta Holiday Lights Giveaway winners are drawn. You didn't win the big one, `
    + `but for entering you get $${GIVEAWAY.coupon} off a Christmas light install this season. `
    + `It's good for 72 hours, claim it here: ${claim_url} Reply STOP to opt out.`,
  followup24: ({ first, claim_url }) =>
    `Hi ${first}, your $${GIVEAWAY.coupon} off Christmas lights from Barta is still waiting. `
    + `It expires ${DATES.claim_by_short}. Claim it: ${claim_url} Reply STOP to opt out.`,
  followup48: ({ first, claim_url }) =>
    `Don't want to lose your $${GIVEAWAY.coupon} coupon, ${first}? It expires tomorrow `
    + `(${DATES.claim_by_short}). Claim it: ${claim_url} or reply with any questions. Reply STOP to opt out.`,
  office_claim: ({ name, phone, address }) =>
    `Giveaway coupon claimed: ${name} (${phone}), ${address}. $${GIVEAWAY.coupon} off lights. `
    + "Send the quote! Lead is in Rotor tagged Giveaway Coupon.",
});

// The batch-sendable templates, in the order the dashboard offers them.
export const BROADCASTS = Object.freeze(["nudge", "coupon", "followup24", "followup48"]);
