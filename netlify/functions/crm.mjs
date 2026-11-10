// GET /crm and /crm/* — Barta CRM pages (design §2.1, §2.3, §4.4, §9.2).
// HTML only, never customer data:
//   /crm                    the app shell (a CRM session), which loads /crm-app/main.js
//   /crm/login              Team sign-in
//   /crm/setup              first-owner setup (office cookie + CRM_SETUP_CODE, once)
//   /crm/invite/{id}.{tok}  set a password from an invite or reset link
//   /crm/legacy             the first slice's Customers list and Import screen,
//                           for the office cookie or a session with
//                           contacts:read_all (techs get 403), until M2a
// Before the owner has finished the Netlify setup (CRM_PRODUCTION,
// CRM_KEY_SALT; CRM_SETUP_CODE until the first owner exists) the CRM pages
// show "Setup needed" with a link to the Customers list, which keeps
// working on the office cookie alone. Every page sends the CSP of §2.3
// (script-src 'self'); the legacy page keeps its inline scripts, allowed by
// hash. See docs/CRM.md.

import { deployContext, canonicalRedirect } from "../lib/crm/core/context.mjs";
import { withStoreScope, withBudget } from "../lib/crm-store.mjs";
import { lookupSession, deviceId, newDeviceCookie } from "../lib/crm/core/sessions.mjs";
import { officeSignedIn, missingSetup, storeBlocked, readBootstrap, bootstrapDone, inviteTarget, loadPermissions } from "../lib/crm/core/auth.mjs";
import { can, permsFor } from "../lib/crm/core/perms.mjs";
import { htmlPage, legacyPage, redirect, safeTo, withCookies, MIN_CLIENT } from "../lib/crm/core/http.mjs";
import { shellHtml, loginHtml, setupHtml, setupNeededHtml, inviteHtml, messageHtml } from "../lib/crm/core/shell-html.mjs";
import { navFor } from "../lib/crm/modules/system/me.mjs";
import { loadCustomers } from "../lib/crm-data.mjs";
import { customersHtml, importHtml, setupHtml as legacySetupHtml } from "../lib/crm-page.mjs";
import { safeErr } from "../lib/referral-lib.mjs";
import "../lib/crm/modules/index.mjs";

export const config = { path: ["/crm", "/crm/", "/crm/*"] };

const LINK_OFFICE = { label: "Go to Barta Office", href: "/office", top: true };

async function legacy(req, url, deploy) {
  const office = officeSignedIn(req);
  const blocked = storeBlocked(deploy);
  if (!office) {
    if (blocked) return htmlPage(setupNeededHtml({ missing: missingSetup(deploy), office: false }), 503);
    const s = await lookupSession(req);
    if (!s) return redirect("/crm/login?to=" + encodeURIComponent("/crm/legacy"));
    const permissions = await loadPermissions().catch(() => null);
    if (!can(s.user, "contacts:read_all", undefined, permissions)) {
      return htmlPage(messageHtml({ title: "Not for this login", text: "The customer list is for the office. Your visits show up on Today." }), 403);
    }
  }
  const got = await loadCustomers({ deploy: blocked ? undefined : deploy });
  // The Import screen never depends on the list being readable, so a list
  // that is broken (or a store that is down) can always be imported over.
  if (url.searchParams.has("import")) {
    const current = got.ok ? { imported_at: got.data.imported_at, count: got.data.count ?? got.data.customers.length } : null;
    return legacyPage(importHtml({ current, damaged: got.reason === "bad-index" }));
  }
  if (got.ok) return legacyPage(customersHtml(got.data));
  if (got.reason === "no-data" || got.reason === "bad-index") return legacyPage(importHtml({ damaged: got.reason === "bad-index" }));
  return legacyPage(legacySetupHtml(got.reason), 503);
}

async function shell(req) {
  const s = await lookupSession(req);
  if (s) {
    const permissions = await loadPermissions().catch(() => null);
    return htmlPage(shellHtml({ user: s.user, perms: permsFor(s.user, permissions), nav: navFor(s.user), office: officeSignedIn(req), minClient: MIN_CLIENT }), 200, { "X-CRM-Shell": "1" });
  }
  const boot = await readBootstrap();
  if (!bootstrapDone(boot)) {
    if (officeSignedIn(req)) return redirect("/crm/setup");
    return htmlPage(messageHtml({ title: "Not set up yet", text: "An owner sets up the CRM from Barta Office first.", links: [LINK_OFFICE] }));
  }
  return redirect("/crm/login");
}

async function login(req, url) {
  const to = safeTo(url.searchParams.get("to"), "/crm");
  const s = await lookupSession(req);
  if (s) return redirect(to);
  const boot = await readBootstrap();
  if (!bootstrapDone(boot)) {
    if (officeSignedIn(req)) return redirect("/crm/setup");
    return htmlPage(messageHtml({ title: "Not set up yet", text: "An owner sets up the CRM from Barta Office first.", links: [LINK_OFFICE] }));
  }
  const res = htmlPage(loginHtml({ to }));
  // The device id the sign-in throttle counts per phone (§4.8).
  return deviceId(req) ? res : withCookies(res, [newDeviceCookie().cookie]);
}

async function setup(req) {
  if (!officeSignedIn(req)) {
    return htmlPage(messageHtml({ title: "Office sign-in first", text: "Setting up the CRM needs the office password. Sign in to Barta Office, then open the CRM tab.", links: [LINK_OFFICE] }), 403);
  }
  const boot = await readBootstrap();
  if (bootstrapDone(boot)) {
    return htmlPage(messageHtml({ title: "Setup is done", text: "Ask an owner to invite you.", links: [{ label: "Sign in", href: "/crm/login", primary: true }] }), 410);
  }
  if (!process.env.CRM_SETUP_CODE) return htmlPage(setupNeededHtml({ missing: ["CRM_SETUP_CODE"], office: true }), 503);
  return htmlPage(setupHtml());
}

async function invite(req, token) {
  const t = await inviteTarget(token);
  if (!t) {
    return htmlPage(messageHtml({ title: "This link has expired", text: "It was already used or is more than 7 days old. Ask Alex or Jacob for a new one.", links: [{ label: "Sign in", href: "/crm/login", primary: true }] }), 410);
  }
  return htmlPage(inviteHtml({ token, first_name: t.user.first_name, login: t.user.login, kind: (t.user.invite && t.user.invite.kind) || "invite" }));
}

export default async (req, context) => {
  try {
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    const deploy = deployContext(req, context);
    const moved = canonicalRedirect(req, deploy);
    if (moved) return moved;
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/crm";
    const scope = { deploy, budget: withBudget(8000, 25), requestId: (context && context.requestId) || "crm-page" };
    if (path === "/crm/legacy") return await withStoreScope(scope, () => legacy(req, url, deploy));
    const missing = missingSetup(deploy);
    if (missing.length) return htmlPage(setupNeededHtml({ missing, office: officeSignedIn(req) }), 503);
    return await withStoreScope(scope, async () => {
      if (path === "/crm") return shell(req);
      if (path === "/crm/login") return login(req, url);
      if (path === "/crm/setup") return setup(req);
      const m = /^\/crm\/invite\/([^/]+)$/.exec(path);
      if (m) {
        let token = "";
        try { token = decodeURIComponent(m[1]); } catch { token = ""; }
        return invite(req, token);
      }
      return htmlPage(messageHtml({ title: "Not found", text: "That page isn't here.", links: [{ label: "Open the CRM", href: "/crm", primary: true }] }), 404);
    });
  } catch (e) {
    console.error("crm: page failed (" + safeErr(e) + ")");
    return htmlPage(messageHtml({ title: "Something went wrong", text: "The CRM couldn't load. Try again in a minute.", links: [{ label: "Try again", href: "/crm", primary: true }] }), 500);
  }
};
