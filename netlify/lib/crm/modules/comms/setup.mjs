// Comms: what Settings → "Texting, email & reviews" shows (design §6.1
// "Settings shows connected / missing per secret, never values", §6.3, D1,
// D41). Read-only: where texting, email and the Google reviews stand, what
// an owner still has to do, and the webhook addresses to paste into Twilio
// and Postmark when the number moves. The CRM registers nothing with a
// provider by itself.

import { getSetting, readIndex } from "../../../crm-store.mjs";
import { adapter } from "../../adapters/index.mjs";
import { CANONICAL_ORIGIN } from "../../core/context.mjs";
import { SMS_HOOK, STATUS_HOOK } from "../../adapters/sms-twilio.mjs";
import { contactShard } from "../../core/stats.mjs";

const has = (k) => typeof process.env[k] === "string" && process.env[k] !== "";

async function setup(ctx) {
  const mode = await ctx.sysMode();
  const cfg = await getSetting("integrations").catch(() => ({}));
  const [sms, email, reviews] = await Promise.all(["sms", "email", "reviews"].map((k) => adapter(k, { deploy: ctx.deploy, settings: cfg, mode }).catch(() => ({ mode: "dry_run" }))));
  const s = cfg.sms || {};
  const e = cfg.email || {};
  const inbox = await readIndex("inbox", "open").catch(() => ({ rows: [] }));
  return { data: {
    system_of_record: mode.system_of_record || "rotor",
    sms: {
      setting: s.mode || "dry_run", effective: sms.mode, account: has("TWILIO_ACCOUNT_SID"), token: has("TWILIO_AUTH_TOKEN"), test_number: !!s.test_from, allowlist: (s.test_allowlist || []).length,
      advanced_opt_out: s.advanced_opt_out !== false, inbound_url: SMS_HOOK, status_url: STATUS_HOOK,
    },
    email: { setting: e.mode || "dry_run", effective: email.mode, token: has("POSTMARK_SERVER_TOKEN"), webhook_token: has("POSTMARK_WEBHOOK_TOKEN"), allowlist: (e.test_allowlist || []).length, from: e.from || null, webhook_url: `${CANONICAL_ORIGIN}/api/crm/hooks/email/postmark?token=…` },
    reviews: { setting: (cfg.reviews && cfg.reviews.mode) || "dry_run", effective: reviews.mode, keys: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "ACCOUNT_ID", "LOCATION_ID"].every(has) },
    open_conversations: inbox.rows.length,
  } };
}

// Settings → Messages → Muted contacts (Rotor's muted list: guide-gaps
// §2.15 ST7): everyone whose automated texts or email are paused, from the
// contacts list's `mu` (the contacts index carries it with the Customers
// update, S11). Until it does, `indexed` is false and the screen says so.
export function mutedOf(rows) {
  const indexed = rows.some((r) => Object.hasOwn(r, "mu"));
  const list = rows.filter((r) => r.mu && (!Array.isArray(r.mu) || r.mu.length) && r.lc !== "archived")
    .map((r) => ({ id: r.id, name: r.n || "", town: r.c || "", lifecycle: r.lc || "", channels: Array.isArray(r.mu) ? r.mu : typeof r.mu === "object" ? Object.keys(r.mu) : ["sms"] }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { indexed, list };
}
async function muted() {
  const ix = await readIndex("contacts", contactShard("ct_00000000000000000000")).catch(() => ({ rows: [] }));
  return { data: mutedOf(ix.rows || []) };
}

export const setupRoutes = [
  { method: "GET", path: "/comms/muted", auth: "session", perm: "consent:edit", subject: "none", mode: "inline", handler: muted, maxCalls: 30 },
  { method: "GET", path: "/comms/setup", auth: "session", perm: "settings:messaging", subject: "none", mode: "inline", handler: setup },
];
