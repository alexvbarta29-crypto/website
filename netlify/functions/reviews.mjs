// GET /api/reviews → { count, rating, updated, reviews: [...] }
//
// Every Google review on the Business Profile, newest first, for the site's
// own review sections (owner's request, October 2026: replace the Trustindex
// widget with reviews that match the site and update on their own). The
// "Sync Google review count" GitHub Action (build/review_sync.py) saves this
// into build/google_reviews.json and rebuilds the site when anything changed,
// so pages ship the reviews as plain HTML with no third-party script.
//
// Each review: { id, name, stars, text, created, reply }. Only what Google
// already shows publicly on the profile; no reviewer ids or photos.
//
// Uses the same Netlify environment variables as review-stats.mjs and the
// GBP connector: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN,
// ACCOUNT_ID, LOCATION_ID. Nothing secret is ever returned.

import { createHash } from "node:crypto";

let cache = { at: 0, body: null };
const TTL_MS = 10 * 60 * 1000;
const MAX_PAGES = 20; // 50 per page, far above the current review count

const STARS = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

async function accessToken() {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error("token refresh failed");
  return j.access_token;
}

// Google prefixes machine-translated reviews with "(Translated by Google)"
// and appends the reviewer's own words after "(Original)". Show the original.
export function cleanComment(comment) {
  let text = String(comment || "");
  const orig = text.indexOf("(Original)");
  if (orig !== -1) text = text.slice(orig + "(Original)".length);
  else text = text.replace(/^\(Translated by Google\)\s*/, "");
  return text.trim();
}

export function shapeReview(x) {
  return {
    // A short, stable handle the site's config can use to pin or hide one.
    id: createHash("sha1").update(String(x.reviewId || x.name || "")).digest("hex").slice(0, 10),
    name: (x.reviewer && x.reviewer.displayName) || "A Google user",
    stars: STARS[x.starRating] || 0,
    text: cleanComment(x.comment),
    created: x.createTime || null,
    reply: x.reviewReply ? cleanComment(x.reviewReply.comment) : null,
  };
}

const reply = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": status === 200 ? "public, max-age=600" : "no-store",
      "access-control-allow-origin": "*",
    },
  });

export default async () => {
  if (cache.body && Date.now() - cache.at < TTL_MS) return reply(cache.body);
  try {
    const { ACCOUNT_ID, LOCATION_ID } = process.env;
    const token = await accessToken();
    const base = `https://mybusiness.googleapis.com/v4/accounts/${ACCOUNT_ID}/locations/${LOCATION_ID}/reviews`;
    const reviews = [];
    let count = 0, rating = 0, pageToken = "";
    for (let page = 0; page < MAX_PAGES; page++) {
      const q = new URLSearchParams({ pageSize: "50" });
      if (pageToken) q.set("pageToken", pageToken);
      const r = await fetch(`${base}?${q}`, { headers: { authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error(`Google API ${r.status}`);
      const j = await r.json();
      count = Number(j.totalReviewCount) || count;
      rating = Number(j.averageRating) || rating;
      for (const x of j.reviews || []) reviews.push(shapeReview(x));
      pageToken = j.nextPageToken || "";
      if (!pageToken) break;
    }
    if (!count || !reviews.length) throw new Error("no reviews returned");
    reviews.sort((a, b) => String(b.created).localeCompare(String(a.created)));
    cache = {
      at: Date.now(),
      body: { count, rating: Math.round(rating * 10) / 10, updated: new Date().toISOString(), reviews },
    };
    return reply(cache.body);
  } catch (e) {
    return reply({ error: String(e?.message || e) }, 502);
  }
};

export const config = { path: "/api/reviews" };
