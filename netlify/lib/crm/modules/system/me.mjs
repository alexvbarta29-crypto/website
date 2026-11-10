// Core "system" module: who am I (design §4.11). GET /me feeds the app on
// every start (the shell's boot JSON can be a cached copy); GET /me/badges
// is the cheap poll behind the dots on the tab bar and the office's CRM tab
// (§5.7.7): approvals (pending actions, the modules' approval rows and bulk
// sends waiting for a test or a confirm), attention, unread notifications
// (the bell), and the inbox (0 until comms, M6).

import { createHash } from "node:crypto";
import { getRecord } from "../../../crm-store.mjs";
import { NotFoundError } from "../../core/errors.mjs";
import { permsFor } from "../../core/perms.mjs";
import { TZ } from "../../core/clock.mjs";
import { MIN_CLIENT } from "../../core/http.mjs";
import { allModules } from "../../core/registry.mjs";
import { approvalsCount } from "../../core/pending.mjs";
import { unreadCount } from "../../core/notify.mjs";
import { waitingCount } from "../../core/bulk.mjs";
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

// Needs-attention counts the modules declare ({ perm, count(ctx) }, §11.3).
async function attentionCount(ctx) {
  let n = 0;
  for (const m of allModules()) {
    for (const a of m.attention || []) {
      if (!a || typeof a.count !== "function" || (a.perm && !ctx.can(a.perm))) continue;
      try { n += Math.max(0, Number(await a.count(ctx)) || 0); } catch { /* a module's count never breaks the badge */ }
    }
  }
  return n;
}

// The counts behind the dots (§4.11): approvals from pending actions and
// the modules' approvals rows and bulk sends waiting for a test or a
// confirm; attention from the modules' attention rows; notifications =
// this person's unread ones; inbox_unread arrives with comms (M6).
async function badges(ctx) {
  const [approvals, attention, notifications, bulk] = await Promise.all([
    approvalsCount(ctx), attentionCount(ctx), unreadCount(ctx.user.id),
    ctx.can("campaigns:send") ? waitingCount() : 0,
  ]);
  const data = { inbox_unread: 0, attention, notifications, approvals: approvals + bulk };
  const etag = `"b-${createHash("sha256").update(JSON.stringify(data)).digest("hex").slice(0, 16)}"`;
  if (ctx.req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
  return { data, etag };
}

export const meRoutes = [
  { method: "GET", path: "/me", auth: "session", perm: "account:own", subject: "none", mode: "inline", handler: me },
  { method: "GET", path: "/me/badges", auth: "session", perm: "account:own", subject: "none", mode: "inline", handler: badges },
];
