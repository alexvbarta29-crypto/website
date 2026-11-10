// Core "system" module: who am I (design §4.11). GET /me feeds the app on
// every start (the shell's boot JSON can be a cached copy); GET /me/badges
// is the cheap poll behind the dots on the tab bar and the office's CRM tab
// (§5.7.7). Until the inbox, approvals and notifications exist (M1.3, M6)
// every count is 0.

import { createHash } from "node:crypto";
import { getRecord } from "../../../crm-store.mjs";
import { NotFoundError } from "../../core/errors.mjs";
import { permsFor } from "../../core/perms.mjs";
import { TZ } from "../../core/clock.mjs";
import { MIN_CLIENT } from "../../core/http.mjs";
import { publicUser } from "./types.mjs";

export const SETTINGS_PUBLIC = Object.freeze({ company_name: "Barta Window Washing", time_zone: TZ });

// The tab bar for a role (§9.1); the app shows a tab only once its screen exists.
export function navFor(user) {
  return user && user.role === "tech" ? ["today", "inbox", "time", "pay", "me"] : ["today", "inbox", "contacts", "schedule", "more"];
}

async function me(ctx) {
  const rec = await getRecord("user", ctx.user.id);
  if (!rec || !rec.data) throw new NotFoundError("Your account isn't there anymore.");
  return {
    data: {
      user: publicUser(rec.data, { full: true }),
      etag: rec.etag,
      perms: permsFor(rec.data, ctx.permissions),
      nav: navFor(rec.data),
      settings_public: SETTINGS_PUBLIC,
      min_client: MIN_CLIENT,
    },
  };
}

async function badges(ctx) {
  const data = { inbox_unread: 0, attention: 0, notifications: 0, approvals: 0 };
  const etag = `"b-${createHash("sha256").update(JSON.stringify(data)).digest("hex").slice(0, 16)}"`;
  if (ctx.req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
  return { data, etag };
}

export const meRoutes = [
  { method: "GET", path: "/me", auth: "session", perm: "account:own", subject: "none", mode: "inline", handler: me },
  { method: "GET", path: "/me/badges", auth: "session", perm: "account:own", subject: "none", mode: "inline", handler: badges },
];
