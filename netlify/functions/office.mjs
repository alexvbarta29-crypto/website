// GET /office — Barta Office: the office's tools on one page with tabs
// (Christmas Lights, Follow-ups, Referrals, Giveaway, plus a Rotor link).
// One office password opens /office and every tool inside it (the shared
// cookie from netlify/lib/lights-auth.mjs). Not linked from the site and
// never indexed. See docs/OFFICE.md.

import { OFFICE_HTML } from "../lib/office-page.mjs";
import { ONE_YEAR, derive, sha256, same, expected, readCookie, signedIn, cookieFor } from "../lib/lights-auth.mjs";
import { loginPage } from "./lights.mjs";

export const config = { path: ["/office", "/office/"] };

const headers = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "DENY",
};
const page = (body, status = 200, extra = {}) =>
  new Response(body, { status, headers: { ...headers, "Content-Type": "text/html; charset=utf-8", ...extra } });
const login = (error = "") => loginPage(error, { title: "Barta Office", text: "Enter the office password. This browser will remember you, and it opens every office tool.", action: "/office" });

export default async (req) => {
  if (req.method === "POST") {
    let pw = "";
    try { pw = String((await req.formData()).get("password") || ""); } catch { pw = ""; }
    const token = pw ? derive(pw) : "";
    if (token && same(sha256(token), expected())) {
      return new Response(null, { status: 303, headers: { ...headers, Location: "/office", "Set-Cookie": cookieFor(token, ONE_YEAR) } });
    }
    return page(login("That password isn't right. Try again."), 401);
  }
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST" } });
  if (!signedIn(req)) return page(login());
  return page(OFFICE_HTML, 200, { "Set-Cookie": cookieFor(readCookie(req), ONE_YEAR) });
};
