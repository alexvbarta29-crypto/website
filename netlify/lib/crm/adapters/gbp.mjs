// Barta CRM: Google Business Profile reviews, read-only (design §6.6).
//
// The refresh-token flow and env of netlify/functions/reviews.mjs, copied
// here (not refactored: the public reviews function stays untouched). It
// lists the location's reviews newest first and stops at `since`. It never
// replies to a review and never posts: public words on the profile need a
// person's OK and stay with the existing connector.
//
//   listReviews({ since }) → [{ id, reviewer, rating, comment, create_time, update_time }]

export const GBP_TIMEOUT_MS = 5000;
export const GBP_MAX_PAGES = 4;
const STARS = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

export function cleanComment(comment) {
  let text = String(comment || "");
  const orig = text.indexOf("(Original)");
  if (orig !== -1) text = text.slice(orig + "(Original)".length);
  else text = text.replace(/^\(Translated by Google\)\s*/, "");
  return text.trim();
}

export function gbpDriver({ env = process.env } = {}) {
  const configured = () => ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "ACCOUNT_ID", "LOCATION_ID"].every((k) => typeof env[k] === "string" && env[k] !== "");
  async function accessToken() {
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(GBP_TIMEOUT_MS),
      body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: env.GOOGLE_REFRESH_TOKEN, grant_type: "refresh_token" }),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || !j.access_token) throw new Error("gbp token refresh failed");
    return j.access_token;
  }
  return {
    configured,
    async listReviews({ since } = {}) {
      if (!configured()) return [];
      const token = await accessToken();
      const base = `https://mybusiness.googleapis.com/v4/accounts/${encodeURIComponent(env.ACCOUNT_ID)}/locations/${encodeURIComponent(env.LOCATION_ID)}/reviews`;
      const out = [];
      let pageToken = "";
      const floor = since ? Date.parse(since) : 0;
      for (let page = 0; page < GBP_MAX_PAGES; page++) {
        const q = new URLSearchParams({ pageSize: "50", orderBy: "updateTime desc" });
        if (pageToken) q.set("pageToken", pageToken);
        const r = await fetch(`${base}?${q}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(GBP_TIMEOUT_MS) });
        if (!r.ok) throw new Error(`gbp reviews ${r.status}`);
        const j = await r.json();
        let older = false;
        for (const x of j.reviews || []) {
          const updated = x.updateTime || x.createTime || null;
          if (floor && updated && Date.parse(updated) <= floor) { older = true; continue; }
          out.push({ id: String(x.reviewId || x.name || ""), reviewer: (x.reviewer && x.reviewer.displayName) || "A Google user", rating: STARS[x.starRating] || 0, comment: cleanComment(x.comment), create_time: x.createTime || null, update_time: updated });
        }
        pageToken = j.nextPageToken || "";
        if (!pageToken || older) break;
      }
      return out.filter((x) => x.id && x.rating);
    },
  };
}
