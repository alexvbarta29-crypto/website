// /api/reviews — every Google review for the site's own review sections.
// Google is stubbed; nothing leaves the machine.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

const { default: handler, cleanComment, shapeReview } = await import("../netlify/functions/reviews.mjs");

const realFetch = globalThis.fetch;
let calls;
function google(pages) {
  calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("oauth2.googleapis.com")) return Response.json({ access_token: "tok" });
    if (u.includes("/reviews?")) {
      const token = new URL(u).searchParams.get("pageToken") || "";
      const page = pages[token];
      if (!page) return new Response("nope", { status: 404 });
      return Response.json(page);
    }
    throw new Error("unexpected " + u);
  };
}
const review = (id, stars, comment, created, reply) => ({
  reviewId: id, reviewer: { displayName: "Pat Doe", profilePhotoUrl: "https://x/p.jpg" },
  starRating: stars, comment, createTime: created,
  ...(reply ? { reviewReply: { comment: reply } } : {}),
});

beforeEach(() => {
  Object.assign(process.env, { GOOGLE_CLIENT_ID: "c", GOOGLE_CLIENT_SECRET: "s", GOOGLE_REFRESH_TOKEN: "r", ACCOUNT_ID: "1", LOCATION_ID: "2" });
});
afterEach(() => { globalThis.fetch = realFetch; });

test("cleanComment keeps the reviewer's own words over Google's translation", () => {
  assert.equal(cleanComment("(Translated by Google) Great work\n\n(Original)\nGran trabajo"), "Gran trabajo");
  assert.equal(cleanComment("(Translated by Google) Great work"), "Great work");
  assert.equal(cleanComment("  Spotless windows!  "), "Spotless windows!");
  assert.equal(cleanComment(undefined), "");
});

test("shapeReview returns only public fields and maps the star enum", () => {
  const r = shapeReview(review("abc", "FOUR", "Nice", "2026-10-01T00:00:00Z", "Thanks!"));
  assert.deepEqual(Object.keys(r).sort(), ["created", "id", "name", "reply", "stars", "text"]);
  assert.equal(r.stars, 4);
  assert.equal(r.name, "Pat Doe");
  assert.equal(r.reply, "Thanks!");
  assert.match(r.id, /^[0-9a-f]{10}$/);
  assert.equal(shapeReview(review("abc", "FIVE", "x", "t")).id, r.id, "id is stable per review");
  assert.equal(shapeReview(review("abc", "FIVE", "", "t")).reply, null);
});

test("pages through every review and sorts newest first", async () => {
  google({
    "": { totalReviewCount: 3, averageRating: 4.96, nextPageToken: "p2",
          reviews: [review("a", "FIVE", "Old one", "2024-01-01T00:00:00Z"), review("b", "FIVE", "Newest", "2026-10-26T00:00:00Z")] },
    p2: { totalReviewCount: 3, averageRating: 4.96, reviews: [review("c", "FIVE", "Middle", "2025-05-05T00:00:00Z")] },
  });
  const res = await handler(new Request("https://x.test/api/reviews"));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.count, 3);
  assert.equal(body.rating, 5);
  assert.deepEqual(body.reviews.map((r) => r.text), ["Newest", "Middle", "Old one"]);
  assert.equal(calls.filter((u) => u.includes("/reviews?")).length, 2);
  assert.ok(!JSON.stringify(body).includes("profilePhotoUrl"));
});
