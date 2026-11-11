// Barta CRM module "comms" (M6): conversations, messages, campaigns and
// reviews (design §5.7, §6.3, §6.4, §6.6, §11.4 "M6 Comms").
//
//   types.mjs          conversation, message, campaign, review
//   conversations.mjs  recording a message, the sharded inbox index, threads
//   routes.mjs         the inbox and thread API (tech scoping)
//   sink.mjs           messages.sink, the sent-message recorder, settlers
//   inbound.mjs        the Twilio and Postmark webhooks, keywords, MMS files
//   audience.mjs       campaign audiences over the contacts index (pure)
//   campaigns.mjs      campaigns: preview, test send, schedule, results
//   reviews.mjs        Google reviews (read-only poll), matching, the review sequence
//   email-layout.mjs   the branded email layout; html-sanitize.mjs imported HTML
//   import-rotor.mjs   Rotor's messages, campaigns, templates and pin types
//
// Nothing leaves the site from here until an owner connects Twilio and
// Postmark (Settings → Integrations): the drivers below are only handed out
// in test or live mode with the secrets set, test mode reaches only the
// staff allowlist, and live is refused while Rotor is the system of record.
// Rotor keeps the real texting number: nothing here registers a webhook, a
// number or anything else with a provider.

import { defineModule } from "../../core/registry.mjs";
import { getRecord } from "../../../crm-store.mjs";
import { InputError } from "../../core/errors.mjs";
import { defineFileOwner } from "../../core/files.mjs";
import { techVisibleContacts } from "../../core/perms.mjs";
import { setSentRecorder } from "../../core/send.mjs";
import { setEmailLayout } from "../../core/templates.mjs";
import { setBatchScope } from "../../core/bulk.mjs";
import { registerSettler } from "../../core/markers.mjs";
import { registerAdapter } from "../../adapters/index.mjs";
import { twilioDriver } from "../../adapters/sms-twilio.mjs";
import { postmarkDriver } from "../../adapters/email-postmark.mjs";
import { gbpDriver } from "../../adapters/gbp.mjs";
import { types } from "./types.mjs";
import { phases } from "./import-rotor.mjs";
import { inboxRoutes, unreadFor } from "./routes.mjs";
import { hookRoutes, fetchMedia } from "./inbound.mjs";
import { commsSink, recordSent, settleTwilio, settlePostmark } from "./sink.mjs";
import { withInboxBatch, reassign } from "./conversations.mjs";
import { emailLayout } from "./email-layout.mjs";
import { campaignRoutes, startCampaign } from "./campaigns.mjs";
import { reviewRoutes, reviewSequence, reviewListeners, pollReviews, isReviewed, validateReviews, REVIEWS_DEFAULTS } from "./reviews.mjs";
import { setupRoutes } from "./setup.mjs";
import { mcpTools } from "./mcp.mjs";

// The drivers (registered, not switched on: adapters/index.mjs decides the mode).
for (const mode of ["test", "live"]) {
  registerAdapter("sms", mode, twilioDriver(mode));
  registerAdapter("email", mode, postmarkDriver(mode));
}
registerAdapter("reviews", "live", gbpDriver());
registerSettler("twilio", settleTwilio);
registerSettler("postmark", settlePostmark);
setSentRecorder(recordSent);
setEmailLayout(emailLayout);
setBatchScope(withInboxBatch);

// A message's files (imported attachments, MMS): whoever may read the
// thread; a tech only for a contact on their own visits. Never edited.
defineFileOwner("message", {
  canRead: async (ctx, msg) => {
    if (ctx.can("inbox:read")) return true;
    if (!ctx.user || !ctx.holds || ctx.holds("inbox:read") !== "own") return false;
    return ctx.can("inbox:read", { type: "message", record: msg, visible: (await techVisibleContacts(ctx.user.id)).has(msg.contact_id) });
  },
  canEdit: () => false,
});

function validatePinTypes(v) {
  const list = v && Array.isArray(v.types) ? v.types : [];
  if (list.length > 50) throw new InputError("Up to 50 pin types.", "types");
  return { types: list.map((t) => ({ rotor_id: String((t && t.rotor_id) || "").slice(0, 64), label: String((t && t.label) || "").slice(0, 40), color: String((t && t.color) || "").slice(0, 9), active: !(t && t.active === false) })).filter((t) => t.label) };
}

// Built-in templates (§5.7.3). Barta's Review 1/2/3 and the personal ask
// as Rotor has them; never a STOP line (the sender adds the footer, D5).
const TEMPLATES = [
  { key: "review_1", name: "Review 1 (same day)", channel: "sms", category: "service", tags: ["review"],
    body: "Hey {{first_name|there}}, {{sender_first_name}} with Barta Window Washing here. Thanks for having us out today! If you have a minute, a quick Google review would mean a lot to our small family business. Mentioning what we did and your town (like \"{{service_list|window cleaning}} in {{town|Delano}}\") really helps neighbors find us.\n\n{{review_link}}" },
  { key: "review_2", name: "Review 2 (day 3)", channel: "sms", category: "service", tags: ["review"],
    body: "Hi {{first_name|there}}, it's {{sender_first_name}} from Barta! Hope everything still looks great. If you haven't had a chance yet, we'd really appreciate a quick review. Even one sentence about the job and where you live helps a ton.\n\n{{review_link}}" },
  { key: "review_3", name: "Review 3 (day 8, last nudge)", channel: "sms", category: "service", tags: ["review"],
    body: "{{first_name|Hi}}, last nudge from me, promise! If you were happy with us, a short Google review is the best thanks we could ask for. Thanks again for supporting a local family business!\n\n{{review_link}}" },
  { key: "review_personal", name: "Review ask (personal, a batch)", channel: "sms", category: "marketing", tags: ["review"],
    body: "Hey {{first_name|there}}, this is {{sender_first_name}} with Barta Window Washing! I'm just personally reaching out to see if you'd mind leaving us a review. It really helps a small business like ours grow. Thank you very much!\n\n{{review_link}}" },
  { key: "help_reply", name: "Answer to HELP", channel: "sms", category: "service", tags: [],
    body: "{{company_name}}: call {{company_phone}} or email {{company_email}}. Msg & data rates may apply." },
];

export default defineModule({
  name: "comms",
  types,
  statsParts: {
    // the reviews part of ContactStats (§5.1): a matched Google review, and the last review sequence
    reviews: { defaults: { review_left_at: null, last_sequence_at: null, sequence: null }, row: (p) => ({ rv: (p && p.review_left_at) || null, rsq: (p && p.last_sequence_at) || null }) },
  },
  settings: {
    // Rotor's eight map pin types (§10.2 row 35), kept for a later knock map
    pin_types: { defaults: { types: [] }, validate: validatePinTypes, perm: "settings:general" },
    reviews: { defaults: { ...REVIEWS_DEFAULTS }, validate: validateReviews, perm: "settings:messaging" },
  },
  routes: [...inboxRoutes, ...campaignRoutes, ...reviewRoutes, ...setupRoutes, ...hookRoutes],
  events: reviewListeners,
  emits: ["message.inbound", "review.matched"],
  queue: {
    // the files of an MMS, fetched after the webhook answered (§6.3)
    "media.fetch": { handler: fetchMedia, mutates: true },
    // a scheduled campaign's start: the confirm of its bulk run, as the person who scheduled it
    "campaign.start": { handler: startCampaign, mutates: true },
  },
  services: {
    // (message, ctx) → { status, outbox_id?, message_id?, conversation_id? }: replaces core's default (§11.3)
    "messages.sink": commsSink,
    // (contact_id, ctx) → boolean: a matched Google review (§5.7.6)
    "reviews.isReviewed": isReviewed,
    // (ctx) → conversations with something unread, for this person (the Inbox badge)
    "comms.unread": unreadFor,
  },
  needs: ["bulk.create", "notify.users", "stats.update"],
  sweeps: [
    { key: "reviews.poll", label: "New Google reviews", lane: "fast", every: "hourly", mutates: true, run: pollReviews },
  ],
  automations: [reviewSequence],
  templates: TEMPLATES,
  // a merged contact's threads move to the one that survives (a: survivor id, b: merged id)
  onMerge: async (a, b, ctx) => { const s = await getRecord("contact", a); if (s) await reassign(b, s.data, ctx); },
  attention: [
    // Home's "Needs you": one read of the small open shard (Home's budget has room for exactly one;
    // reviews to match and campaigns waiting are on their own screens). The Inbox tab has its own badge.
    { key: "comms.unread", label: "Unread conversations", perm: "inbox:read", count: (ctx) => unreadFor(ctx), link: "#/inbox", badge: false },
  ],
  pushKinds: ["reply", "review"],
  activityKinds: {
    "sms.in": { label: "Text received", icon: "text" },
    "sms.out": { label: "Text sent", icon: "text" },
    "email.in": { label: "Email received", icon: "mail" },
    "email.out": { label: "Email sent", icon: "mail" },
    "sms.history": { label: "Texts in Rotor (imported)", icon: "text" },
    "email.history": { label: "Emails in Rotor (imported)", icon: "mail" },
    "review.matched": { label: "Left a Google review", icon: "check" },
  },
  exportTypes: ["conversation", "message", "campaign", "review"],
  mcpTools,
  importPhases: phases,
});
