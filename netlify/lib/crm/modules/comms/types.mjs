// Record types of the comms module (M6): conversation, message, campaign,
// review (design §3.3, §5.7.1, §5.7.5, §5.7.6).
//
// - conversation (cv): one per (contact, channel), never a provider thread
//   id (Rotor had three thread formats for one conversation). Listed in
//   ix/inbox, sharded so the busy part stays small: "open" holds what still
//   needs someone, "y2026"... hold the handled ones by the year of their
//   last message. rel/contact-convs/{contactId}/{channel}--{id} lists a
//   contact's threads.
// - message (ms): write-once body; only the status (monotonic) and the read
//   and delivery times change afterwards. rel/conv-messages/{convId}/
//   {tsKey}--{id} lists a thread; ptr/provider-msg/{provider}--{id} makes a
//   provider's message land once. No index: a thread is read through its
//   relation, never by listing rec/message/.
// - campaign (cm): an audience, a template, a required test send, an
//   owner's or the office's confirm; per-recipient results stay on the
//   record (at most MAX_CAMPAIGN_RECIPIENTS).
// - review (rv): a Google review the poll read, with suggested matches a
//   person confirms (names are fuzzy: never automatic).
//
// rotorFields: a conversation and a message have none (the import writes a
// message once and the conversation's Rotor bag by hand, see
// import-rotor.mjs); a campaign's are what Rotor says about it.

import { defineType } from "../../core/registry.mjs";
import { InputError } from "../../core/errors.mjs";
import { isId } from "../../core/ids.mjs";
import { tsKey } from "../../core/clock.mjs";
import { keySafe, truncate } from "../../core/text.mjs";
import { shape, str, enumValue, int, bool } from "../../core/validate.mjs";

export const CHANNELS = Object.freeze(["sms", "email"]);
export const DIRECTIONS = Object.freeze(["in", "out"]);
export const CONV_STATES = Object.freeze(["open", "done"]);
export const MESSAGE_STATUSES = Object.freeze(["queued", "sending", "sent", "delivered", "failed", "undelivered", "blocked", "received"]);
export const PROVIDERS = Object.freeze(["twilio", "postmark", "rotor_import", "dry_run"]);
export const CAMPAIGN_STATUSES = Object.freeze(["draft", "tested", "scheduled", "sending", "sent", "cancelled"]);
export const MAX_CAMPAIGN_RECIPIENTS = 2000;
export const PREVIEW_MAX = 80;
export const TEXT_MAX = 20000;
export const HTML_MAX = 200000;

// Status ranks (§5.7.1): a callback applies only a higher rank, and the
// first terminal status wins (callbacks arrive out of order).
const RANK = Object.freeze({ queued: 0, sending: 1, sent: 2, delivered: 3, undelivered: 3, failed: 3, blocked: 3, received: 3 });
export const statusRank = (s) => (Object.hasOwn(RANK, s) ? RANK[s] : -1);
export const statusMayMove = (from, to) => statusRank(to) > statusRank(from);

const idOf = (type, required) => (v, f) => {
  if (v === undefined || v === null || v === "") { if (required) throw new InputError("Missing.", f); return undefined; }
  if (!isId(v, type)) throw new InputError("That isn't the right kind of record.", f);
  return v;
};
const isoOf = (v, f) => {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || Number.isNaN(Date.parse(v))) throw new InputError("Not a time.", f);
  return new Date(v).toISOString();
};
const plain = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const obj = (v, f) => { if (v === undefined || v === null) return undefined; if (!plain(v)) throw new InputError("Expected an object.", f); return v; };
export const previewOf = (text) => truncate(String(text ?? "").replace(/\s+/g, " ").trim(), PREVIEW_MAX);
const yearOf = (iso) => (typeof iso === "string" && /^\d{4}/.test(iso) ? iso.slice(0, 4) : "0000");

// ------------------------------------------------------------ conversation

function validateConversation(data, { op } = {}) {
  const stored = op === "update";
  return shape(data, {
    contact_id: idOf("contact", true),
    channel: (v, f) => enumValue(v, CHANNELS, { field: f, required: true, stored }),
    address: (v, f) => str(v, { field: f, max: 200 }),
    contact_name: (v, f) => str(v, { field: f, max: 120 }),
    lifecycle: (v, f) => str(v, { field: f, max: 30 }),
    unread: (v, f) => int(v ?? 0, { field: f, min: 0, max: 100000 }),
    count: (v, f) => (v === undefined || v === null ? undefined : int(v, { field: f, min: 0, max: 10000000 })),
    last_at: (v, f) => isoOf(v, f),
    last_preview: (v) => previewOf(v),
    last_direction: (v, f) => (v === undefined || v === null || v === "" ? undefined : enumValue(v, DIRECTIONS, { field: f, stored })),
    assignee_id: idOf("user", false),
    state: (v, f) => enumValue(v || "done", CONV_STATES, { field: f, stored }),
    needs_reply: (v, f) => bool(v ?? false, { field: f }),
    rotor: obj,
  });
}

export const inboxShard = (r) => (r.state === "open" ? "open" : `y${yearOf(r.last_at || r.created_at)}`);
export const inboxRow = (r) => ({
  c: r.contact_id, ch: r.channel, n: r.contact_name || "", p: r.last_preview || "", la: r.last_at || r.created_at || null, ld: r.last_direction || null,
  u: r.unread || 0, nr: !!r.needs_reply, st: r.state || "done", lc: r.lifecycle || "", ...(r.assignee_id ? { a: r.assignee_id } : {}),
});

export const conversationType = defineType({
  type: "conversation",
  prefix: "cv",
  v: 1,
  validate: validateConversation,
  rotorFields: [],
  mirrored: true,
  techFields: ["id", "contact_id", "channel", "contact_name", "lifecycle", "unread", "count", "last_at", "last_preview", "last_direction", "state", "needs_reply"],
  readPerm: "inbox:read",
  indexes: [{ name: "inbox", shard: inboxShard, row: inboxRow }],
  rels: [{ rel: "contact-convs", parent: (r) => r.contact_id, sort: (r) => r.channel }],
  summary: (r) => ({ id: r.id, contact_id: r.contact_id, channel: r.channel }),
  example: () => ({ contact_id: "ct_0000000000000000000a", channel: "sms", address: "+17635550100", contact_name: "Pat Example", lifecycle: "customer", unread: 0, last_at: "2026-11-17T15:00:00.000Z", last_preview: "See you Wednesday.", last_direction: "out", state: "done", needs_reply: false }),
});

// ------------------------------------------------------------ message

function validateMessage(data, { op, before } = {}) {
  const stored = op === "update";
  const out = shape(data, {
    conversation_id: idOf("conversation", true),
    contact_id: idOf("contact", true),
    channel: (v, f) => enumValue(v, CHANNELS, { field: f, required: true, stored }),
    direction: (v, f) => enumValue(v, DIRECTIONS, { field: f, required: true, stored }),
    from: (v, f) => str(v, { field: f, max: 200 }),
    to: (v, f) => str(v, { field: f, max: 200 }),
    subject: (v, f) => (v === undefined || v === null || v === "" ? undefined : str(v, { field: f, max: 300 })),
    body_text: (v, f) => str(v ?? "", { field: f, max: TEXT_MAX, trim: false }),
    body_html: (v, f) => (v === undefined || v === null || v === "" ? undefined : str(v, { field: f, max: HTML_MAX, trim: false })),
    status: (v, f) => enumValue(v, MESSAGE_STATUSES, { field: f, required: true, stored }),
    blocked_reason: (v, f) => (v === undefined || v === null || v === "" ? undefined : str(v, { field: f, max: 40 })),
    error_code: (v, f) => (v === undefined || v === null || v === "" ? undefined : str(String(v), { field: f, max: 40 })),
    provider: (v, f) => enumValue(v, PROVIDERS, { field: f, required: true, stored }),
    provider_id: (v, f) => (v === undefined || v === null || v === "" ? undefined : str(String(v), { field: f, max: 120 })),
    segments: (v, f) => (v === undefined || v === null ? undefined : int(v, { field: f, min: 0, max: 100 })),
    footer_appended: (v, f) => (v === undefined || v === null ? undefined : bool(v, { field: f })),
    sending_number: (v, f) => (v === undefined || v === null || v === "" ? undefined : str(v, { field: f, max: 40 })),
    origin: (v, f) => obj(v, f) || { kind: "system" },
    related: (v, f) => obj(v, f) || {},
    attachment_file_ids: (v, f) => {
      if (v === undefined || v === null) return [];
      if (!Array.isArray(v) || v.length > 20 || v.some((x) => !isId(x, "file"))) throw new InputError("Up to 20 files.", f);
      return v;
    },
    media_pending: (v, f) => (v === undefined || v === null ? undefined : int(v, { field: f, min: 0, max: 20 })),
    sent_at: isoOf, delivered_at: isoOf, read_at: isoOf,
    rotor: obj,
  });
  // the body is written once (§5.7.1); a status only moves up
  if (before) {
    for (const k of ["body_text", "body_html", "subject", "direction", "channel", "conversation_id", "from", "to"]) {
      if (before[k] !== undefined && JSON.stringify(out[k] ?? null) !== JSON.stringify(before[k] ?? null)) throw new InputError("A message's text never changes.", k);
    }
    if (before.status && out.status !== before.status && !statusMayMove(before.status, out.status)) throw new InputError("A message's status only moves forward.", "status");
  }
  return out;
}

export const providerKey = (provider, id) => keySafe(`${provider}--${String(id).toLowerCase()}`, 140);

export const messageType = defineType({
  type: "message",
  prefix: "ms",
  v: 1,
  validate: validateMessage,
  rotorFields: [],
  mirrored: true,
  audit: false,
  techFields: ["id", "conversation_id", "contact_id", "channel", "direction", "subject", "body_text", "status", "blocked_reason", "error_code", "segments", "attachment_file_ids", "media_pending", "sent_at", "delivered_at", "origin", "provider"],
  readPerm: "inbox:read",
  rels: [{ rel: "conv-messages", parent: (r) => r.conversation_id, sort: (r) => tsKey(new Date(Date.parse(r.sent_at || r.created_at) || 0)) }],
  pointers: [{ kind: "provider-msg", key: (r) => (r.provider_id && r.provider !== "rotor_import" ? providerKey(r.provider, r.provider_id) : null) }],
  summary: (r) => ({ id: r.id, conversation_id: r.conversation_id, direction: r.direction }),
  example: () => ({ conversation_id: "cv_0000000000000000000a", contact_id: "ct_0000000000000000000a", channel: "sms", direction: "out", from: "+17633143400", to: "+17635550100", body_text: "See you Wednesday.", status: "sent", provider: "twilio", origin: { kind: "system" }, related: {}, attachment_file_ids: [], sent_at: "2026-11-17T15:00:00.000Z" }),
});

// ------------------------------------------------------------ campaign

const AUDIENCE_LISTS = ["lifecycle", "tags_any", "tags_none", "sources", "towns", "zips", "tiers", "services_quoted", "services_done", "plan_status", "include_ids", "exclude_ids"];
export function cleanAudience(a, f = "audience") {
  if (a === undefined || a === null) return {};
  if (!plain(a)) throw new InputError("Expected an audience.", f);
  const out = {};
  for (const k of AUDIENCE_LISTS) {
    if (a[k] === undefined || a[k] === null) continue;
    if (!Array.isArray(a[k]) || a[k].length > (k.endsWith("_ids") ? MAX_CAMPAIGN_RECIPIENTS : 60)) throw new InputError("Too many values.", `${f}.${k}`);
    const list = [...new Set(a[k].map((x) => String(x).trim()).filter(Boolean))];
    if (k.endsWith("_ids") && list.some((x) => !isId(x, "contact"))) throw new InputError("Every one must be a contact.", `${f}.${k}`);
    if (list.some((x) => x.length > 80)) throw new InputError("Too long.", `${f}.${k}`);
    if (list.length) out[k] = list;
  }
  for (const k of ["last_service_between", "created_between"]) {
    if (a[k] === undefined || a[k] === null) continue;
    if (!Array.isArray(a[k]) || a[k].length !== 2 || a[k].some((d) => typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d)) || a[k][0] > a[k][1]) throw new InputError("Use two dates, the earlier first.", `${f}.${k}`);
    out[k] = [a[k][0], a[k][1]];
  }
  for (const k of ["no_review", "has_open_quote"]) if (a[k] !== undefined && a[k] !== null) { if (typeof a[k] !== "boolean") throw new InputError("Yes or no.", `${f}.${k}`); out[k] = a[k]; }
  if (a.has_lights_season !== undefined && a.has_lights_season !== null) out.has_lights_season = int(a.has_lights_season, { field: `${f}.has_lights_season`, min: 2020, max: 2100 });
  return out;
}

function validateCampaign(data, { op } = {}) {
  const stored = op === "update";
  return shape(data, {
    name: (v, f) => str(v, { field: f, max: 120, required: true }),
    description: (v, f) => str(v ?? "", { field: f, max: 2000, trim: false }),
    channel: (v, f) => enumValue(v, CHANNELS, { field: f, required: true, stored }),
    template_key: (v, f) => (v === undefined || v === null || v === "" ? undefined : str(v, { field: f, max: 40 })),
    template_id: idOf("template", false),
    audience: (v, f) => cleanAudience(v, f),
    status: (v, f) => enumValue(v, CAMPAIGN_STATUSES, { field: f, required: true, stored }),
    send_at: isoOf, started_at: isoOf, finished_at: isoOf,
    recipients: (v, f) => {
      if (v === undefined || v === null) return undefined;
      if (!Array.isArray(v) || v.length > MAX_CAMPAIGN_RECIPIENTS || v.some((x) => !isId(x, "contact"))) throw new InputError(`At most ${MAX_CAMPAIGN_RECIPIENTS} people in one campaign.`, f);
      return [...new Set(v)];
    },
    rotor: obj,
  });
}

export const campaignRow = (r) => ({ n: r.name, st: r.status, ch: r.channel, at: r.created_at, sa: r.send_at || null, fa: r.finished_at || r.started_at || null, rc: (r.stats && r.stats.recipients) || (r.audience_preview && r.audience_preview.count) || 0, se: (r.stats && (r.stats.sent || 0) + (r.stats.dry_run || 0)) || 0, ro: !!r.rotor });

export const campaignType = defineType({
  type: "campaign",
  prefix: "cm",
  v: 1,
  validate: validateCampaign,
  rotorFields: ["rotor", "name", "description"],
  techFields: ["id"],
  readPerm: "campaigns:write",
  shadow: false,
  indexes: [{ name: "campaigns", shard: () => "", row: campaignRow }],
  summary: (r) => ({ id: r.id, name: r.name, status: r.status }),
  example: () => ({ name: "Fall window cleaning", description: "", channel: "sms", template_key: "sample_note", audience: { lifecycle: ["customer"] }, status: "draft", test: {}, stats: {}, results: {} }),
});

// ------------------------------------------------------------ review

function validateReview(data) {
  return shape(data, {
    gbp_review_id: (v, f) => str(v, { field: f, max: 300, required: true }),
    reviewer_name: (v, f) => str(v ?? "", { field: f, max: 120 }),
    rating: (v, f) => int(v, { field: f, min: 1, max: 5, required: true }),
    comment_excerpt: (v) => (v === undefined || v === null || v === "" ? undefined : truncate(String(v), 280)),
    created_at_gbp: isoOf,
    match: (v, f) => {
      const m = obj(v, f);
      if (!m) return undefined;
      if (!isId(m.contact_id, "contact")) throw new InputError("Pick the customer.", `${f}.contact_id`);
      return { contact_id: m.contact_id, ...(isId(m.job_id) ? { job_id: m.job_id } : {}), tech_ids: Array.isArray(m.tech_ids) ? m.tech_ids.filter((x) => isId(x, "user")).slice(0, 10) : [], by: m.by === "suggested" ? "suggested" : "confirmed", ...(isId(m.confirmed_by, "user") ? { confirmed_by: m.confirmed_by } : {}), ...(m.at ? { at: String(m.at).slice(0, 30) } : {}) };
    },
    suggestions: (v, f) => {
      if (v === undefined || v === null) return [];
      if (!Array.isArray(v)) throw new InputError("Expected a list.", f);
      return v.slice(0, 5).filter((s) => plain(s) && isId(s.contact_id, "contact")).map((s) => ({ contact_id: s.contact_id, ...(isId(s.job_id) ? { job_id: s.job_id } : {}), score: Number.isFinite(s.score) ? Math.round(s.score * 100) / 100 : 0, ...(s.name ? { name: String(s.name).slice(0, 80) } : {}), ...(s.on ? { on: String(s.on).slice(0, 10) } : {}) }));
    },
  });
}

export const reviewKey = (gbpId) => keySafe(String(gbpId).toLowerCase().replace(/[^a-z0-9]+/g, "-"), 120);
export const reviewRow = (r) => ({ n: r.reviewer_name || "", r: r.rating, at: r.created_at_gbp || r.created_at, m: (r.match && r.match.contact_id) || null, t: (r.match && r.match.tech_ids) || [], s: (r.suggestions || []).length });

export const reviewType = defineType({
  type: "review",
  prefix: "rv",
  v: 1,
  validate: validateReview,
  rotorFields: [],
  techFields: ["id", "rating", "created_at_gbp"],
  readPerm: "reviews:read",
  shadow: false,
  indexes: [{ name: "reviews", shard: () => "", row: reviewRow }],
  pointers: [{ kind: "gbp-review", key: (r) => reviewKey(r.gbp_review_id) }],
  summary: (r) => ({ id: r.id, rating: r.rating }),
  example: () => ({ gbp_review_id: "sample-review-1", reviewer_name: "Pat E.", rating: 5, comment_excerpt: "Spotless windows.", created_at_gbp: "2026-11-16T15:00:00.000Z", suggestions: [] }),
});

export const types = [conversationType, messageType, campaignType, reviewType];
