// GET /office — Barta Office: the office's tools on one page with tabs
// (the dashboards, the CRM, Christmas Lights, Follow-ups, Purchases,
// Giveaway, plus a Rotor link). See docs/OFFICE.md.
//
// Signed in (design §2.4) = the office password's cookie (lights-auth.mjs,
// which opens every tool) OR a CRM session (each person's own login). With
// only a CRM session the page is SOLO mode: the CRM fills the screen and no
// other tool is offered. Signed out, the page offers Team sign-in next to
// the office password.
//
// GET /office/launch is the data-free launcher the office service worker
// keeps for a cold start with no signal (office-sw.js, §2.5): public, no
// data, Cache-Control: no-cache.
//
// Not linked from the site and never indexed.

import { officeHtml, officeLoginHtml, launcherHtml } from "../lib/office-page.mjs";
import { ONE_YEAR, derive, sha256, same, expected, readCookie, signedIn, cookieFor } from "../lib/lights-auth.mjs";
import { deployContext } from "../lib/crm/core/context.mjs";
import { withStoreScope, withBudget } from "../lib/crm-store.mjs";
import { lookupSession } from "../lib/crm/core/sessions.mjs";
import { storeBlocked, readBootstrap, bootstrapDone } from "../lib/crm/core/auth.mjs";
import { safeErr } from "../lib/referral-lib.mjs";

export const config = { path: ["/office", "/office/", "/office/launch"] };

const headers = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "DENY",
};
const page = (body, status = 200, extra = {}) =>
  new Response(body, { status, headers: { ...headers, "Content-Type": "text/html; charset=utf-8", ...extra } });

// What the CRM says about this request: { session, ready } (ready = the CRM
// is set up, so Team sign-in can work). Never throws: the office password
// keeps working whatever the CRM's storage does.
async function crmState(req, context) {
  try {
    const deploy = deployContext(req, context);
    if (storeBlocked(deploy)) return { session: null, ready: false };
    return await withStoreScope({ deploy, budget: withBudget(4000, 8), requestId: "office" }, async () => {
      const session = await lookupSession(req);
      if (session) return { session, ready: true };
      return { session: null, ready: bootstrapDone(await readBootstrap()) };
    });
  } catch (e) {
    console.error("office: couldn't check the CRM sign-in (" + safeErr(e) + ")");
    return { session: null, ready: false };
  }
}

export default async (req, context) => {
  const path = new URL(req.url).pathname;
  if (path === "/office/launch") {
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET" } });
    return new Response(launcherHtml(), { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "same-origin", "X-Frame-Options": "DENY" } });
  }
  if (req.method === "POST") {
    let pw = "";
    try { pw = String((await req.formData()).get("password") || ""); } catch { pw = ""; }
    const token = pw ? derive(pw) : "";
    if (token && same(sha256(token), expected())) {
      return new Response(null, { status: 303, headers: { ...headers, Location: "/office", "Set-Cookie": cookieFor(token, ONE_YEAR) } });
    }
    const { ready } = await crmState(req, context);
    return page(officeLoginHtml({ error: "That password isn't right. Try again.", team: ready }), 401);
  }
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST" } });
  if (signedIn(req)) return page(officeHtml(), 200, { "Set-Cookie": cookieFor(readCookie(req), ONE_YEAR) });
  const crm = await crmState(req, context);
  if (crm.session) return page(officeHtml({ solo: true }));
  return page(officeLoginHtml({ team: crm.ready }));
};
