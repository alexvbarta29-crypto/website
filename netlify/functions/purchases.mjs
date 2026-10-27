// GET /purchases — Barta Office → Purchases page. Signed-out visitors go to
// the one office sign-in. Data: /api/purchases (functions/purchases-api.mjs).
import { PURCHASES_HTML } from "../lib/purchases-page.mjs";
import { signedIn, toOffice } from "../lib/lights-auth.mjs";

export const config = { path: ["/purchases", "/purchases/"] };

export default async (req) => {
  if (!signedIn(req)) return toOffice("purchases");
  return new Response(PURCHASES_HTML, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "same-origin" },
  });
};
