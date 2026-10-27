// GET /office — Barta Office: the office's tools on one page with tabs
// (Christmas Lights, Follow-ups, Referrals, Giveaway, plus a Rotor link).
// The page itself holds no customer data; every tool inside keeps its own
// sign-in. Not linked from the site and never indexed. See docs/OFFICE.md.

import { OFFICE_HTML } from "../lib/office-page.mjs";

export const config = { path: ["/office", "/office/"] };

export default async (req) => {
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET" } });
  return new Response(OFFICE_HTML, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, no-cache",
      "X-Robots-Tag": "noindex, nofollow",
      "Referrer-Policy": "same-origin",
      "X-Frame-Options": "DENY",
    },
  });
};
