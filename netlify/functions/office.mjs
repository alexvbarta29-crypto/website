// GET /office — Barta Office: one app, the CRM, full screen. See docs/OFFICE.md.
//
// The CRM sign-in is the only way in (the owner, Nov 2026). With a CRM
// session the page is the CRM alone (solo mode: no header, no tab row);
// owners and the office (admin) also hold the office cookie, issued with
// their sign-in and renewed here on every visit, so the dashboards and
// office tools open inside the CRM; a tech's is cleared. Signed out, or
// with only the office cookie, the page is Team sign-in, with Forgot
// password (the office password stands in for a reset link). Before the
// CRM has its first owner, the office password opens the CRM's setup
// screen (the only sign-in that can work then). Only when the CRM's storage
// can't be used at all does the office password still open the old tab row,
// so the tools are never locked away by an outage.
//
// GET /office/launch is the data-free launcher the office service worker
// keeps for a cold start with no signal (office-sw.js, §2.5): public, no
// data, Cache-Control: no-cache.
//
// Not linked from the site and never indexed.

import { officeHtml, officeLoginHtml, launcherHtml } from "../lib/office-page.mjs";
import { ONE_YEAR, derive, sha256, same, expected, readCookie, passwordSignedIn, crmOfficeUser, crmOfficeCookie, clearOfficeCookie, cookieFor } from "../lib/lights-auth.mjs";
import { deployContext } from "../lib/crm/core/context.mjs";
import { withStoreScope, withBudget } from "../lib/crm-store.mjs";
import { lookupSession, deviceId } from "../lib/crm/core/sessions.mjs";
import { checkThrottle, recordFailure } from "../lib/crm/core/throttle.mjs";
import { storeBlocked, setupDone, officeRole } from "../lib/crm/core/auth.mjs";
import { pageMethodNotAllowed, clientIp } from "../lib/crm/core/http.mjs";
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

// What the CRM says about this request: { session, ready, usable } (ready =
// the first owner exists, so Team sign-in can work; usable = the CRM's
// stores are open here). Never throws: the office password keeps working
// whatever the CRM's storage does.
async function crmState(req, context) {
  const got = await withCrm(req, context, async () => {
    const session = await lookupSession(req);
    if (session) return { session, ready: true, usable: true };
    return { session: null, ready: await setupDone(), usable: true };
  });
  return got || { session: null, ready: false, usable: false };
}
// Runs fn in the CRM's store scope; null when the CRM's storage can't be used.
async function withCrm(req, context, fn) {
  try {
    const deploy = deployContext(req, context);
    if (storeBlocked(deploy)) return null;
    return await withStoreScope({ deploy, budget: withBudget(4000, 8), requestId: "office" }, fn);
  } catch (e) {
    console.error("office: couldn't reach the CRM (" + safeErr(e) + ")");
    return null;
  }
}
// The office password is also the key to Forgot password, so its own form
// is throttled like sign-in (core/throttle.mjs): its own bucket per phone
// (a login nobody can have, so it lands in a hashed key) and the address's
// bucket shared with sign-in. Without the CRM's storage it isn't counted.
const officeTry = (req, context) => ({ login: "office password", device: deviceId(req), ip: clientIp(req, context) });

export default async (req, context) => {
  const path = new URL(req.url).pathname;
  if (path === "/office/launch") {
    if (req.method !== "GET" && req.method !== "HEAD") return pageMethodNotAllowed("GET, HEAD");
    return new Response(launcherHtml(), { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "same-origin", "X-Frame-Options": "DENY" } });
  }
  if (req.method === "POST") {
    // The office password: before the first owner exists it opens setup
    // (and, with the CRM's storage down, the old tab row). Afterwards the
    // cookie it sets opens no part of /office by itself (Team sign-in).
    let pw = "";
    try { pw = String((await req.formData()).get("password") || ""); } catch { pw = ""; }
    const who = officeTry(req, context);
    const gate = await withCrm(req, context, () => checkThrottle(who));
    if (gate && !gate.ok) {
      const { ready } = await crmState(req, context);
      const wait = gate.retry_after_s >= 120 ? `${Math.ceil(gate.retry_after_s / 60)} minutes` : `${gate.retry_after_s} seconds`;
      return page(officeLoginHtml({ error: `Too many tries. Wait ${wait}, then try again.`, team: ready }), 429, { "Retry-After": String(gate.retry_after_s) });
    }
    const token = pw && pw.length <= 256 ? derive(pw) : "";
    if (token && same(sha256(token), expected())) {
      return new Response(null, { status: 303, headers: { ...headers, Location: "/office", "Set-Cookie": cookieFor(token, ONE_YEAR) } });
    }
    await withCrm(req, context, () => recordFailure(who));
    const { ready } = await crmState(req, context);
    return page(officeLoginHtml({ error: "That password isn't right. Try again.", team: ready }), 401);
  }
  if (req.method !== "GET" && req.method !== "HEAD") return pageMethodNotAllowed("GET, HEAD, POST");
  const crm = await crmState(req, context);
  const byPassword = passwordSignedIn(req);
  const issuedTo = byPassword ? null : crmOfficeUser(req);
  if (crm.session) {
    // One app: the CRM fills the screen. Owners and the office get a fresh
    // office cookie (the tools inside the CRM); anyone else loses theirs.
    const user = crm.session.user;
    const office = officeRole(user);
    const set = office ? crmOfficeCookie(user.id) : byPassword || issuedTo ? clearOfficeCookie() : null;
    return page(officeHtml({ solo: true, office }), 200, set ? { "Set-Cookie": set } : {});
  }
  if (byPassword && (!crm.usable || !crm.ready)) {
    // Before the first owner: the CRM's setup screen, full screen. With the
    // CRM's storage down: the old tab row, so the tools stay reachable.
    return page(officeHtml({ solo: crm.usable, office: true }), 200, { "Set-Cookie": cookieFor(readCookie(req), ONE_YEAR) });
  }
  // Signed out, or the office cookie alone once the CRM has owners: Team
  // sign-in. A CRM-issued office cookie without its CRM session (signed
  // out elsewhere, turned off) is cleared, unless the CRM couldn't be asked.
  return page(officeLoginHtml({ team: crm.ready }), 200, issuedTo && crm.usable ? { "Set-Cookie": clearOfficeCookie() } : {});
};
