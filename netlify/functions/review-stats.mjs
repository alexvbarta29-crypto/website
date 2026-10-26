// GET /api/review-stats → { count, rating, updated }
//
// Public, read-only summary of the Google Business Profile reviews (total
// count and average rating). The "Sync Google review count" GitHub Action
// (.github/workflows/review-sync.yml) reads this and rebuilds the site when
// the numbers change, so every "N reviews" line on the site stays exact.
//
// Uses the same Netlify environment variables as the Barta GBP connector
// (gbp-mcp.mjs): GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN,
// ACCOUNT_ID, LOCATION_ID. Nothing secret is ever returned.

let cache = { at: 0, body: null };
const TTL_MS = 10 * 60 * 1000;

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
    const r = await fetch(
      `https://mybusiness.googleapis.com/v4/accounts/${ACCOUNT_ID}/locations/${LOCATION_ID}/reviews?pageSize=1`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (!r.ok) throw new Error(`Google API ${r.status}`);
    const j = await r.json();
    const count = Number(j.totalReviewCount);
    const rating = Number(j.averageRating);
    if (!Number.isFinite(count) || count <= 0) throw new Error("no review count");
    cache = { at: Date.now(), body: { count, rating: Math.round(rating * 10) / 10, updated: new Date().toISOString() } };
    return reply(cache.body);
  } catch (e) {
    return reply({ error: String(e?.message || e) }, 502);
  }
};

export const config = { path: "/api/review-stats" };
