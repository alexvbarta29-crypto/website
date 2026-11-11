// Comms module: the inbox and thread API (design §5.7.7 "Endpoints, comms
// module", §9.2 Inbox / Thread / contact tab Messages, §4.6 tech scoping).
//
//   GET  /inbox?filter=all|unread|needs_reply|leads|customers|mine&cursor=   the conversations (ETag/304 for the 30 s poll)
//   GET  /inbox/contact/:id?channel=       a contact's threads, the thread on one channel, and what is waiting in the Outbox
//   GET  /conversations/:id?before=&since= one thread, newest first, and the contact's threads (ETag/304 for the 10 s poll)
//   POST /conversations/:id/read           unread → 0
//   POST /conversations/:id/done           { done: true | false }   handled (a new inbound reopens it)
//   POST /conversations/:id/assign         { user_id | null }       the office only
//   GET  /messages/:id                     one message, whole (a long email is cut in the thread)
//
// Who: inbox:read. The office reads everything. A technician holds it as
// "own": only the threads of contacts on their own visits (7 days back, 30
// ahead, core/perms.mjs techVisibleContacts), and only each type's
// techFields; anything else answers 403. Sending goes through POST
// /messages (core), whose sink this module provides (sink.mjs).
//
// While texting is in dry-run a send becomes an Outbox item, never a
// message: the thread shows those as "Not sent" bubbles (`pending`).

import { getRecord, getRaw, hk } from "../../../crm-store.mjs";
import { ForbiddenError, NotFoundError, InputError } from "../../core/errors.mjs";
import { isId } from "../../core/ids.mjs";
import { techVisibleContacts, techView, isTechRole } from "../../core/perms.mjs";
import { listOutbox } from "../../core/outbox.mjs";
import { addressOf } from "../../core/send.mjs";
import { adapter } from "../../adapters/index.mjs";
import { CHANNELS } from "./types.mjs";
import { listInbox, getConversation, threadPage, messageView, conversationsOf, markRead, setDone, assign, unreadCount, FILTERS, nameOf } from "./conversations.mjs";

const r = (method, path, perm, handler, more = {}) => ({ method, path, auth: "session", perm, subject: "required", mode: "inline", handler, ...more });

// ------------------------------------------------------------ scoping

// { all: true } for the office; { all: false, visible: Set } for a technician.
export async function inboxScope(ctx) {
  if (ctx.can("inbox:read")) return { all: true, visible: null };
  if (ctx.holds("inbox:read") !== "own") throw new ForbiddenError("You don't have access to that.");
  return { all: false, visible: await techVisibleContacts(ctx.user.id) };
}
const mayRead = (ctx, sc, type, record) => sc.all || ctx.can("inbox:read", { type, record, visible: sc.visible.has(record.contact_id) });
const need = (ctx, sc, type, record) => { if (!mayRead(ctx, sc, type, record)) throw new ForbiddenError("You don't have access to that."); };

const convView = (c, tech) => {
  const v = { id: c.id, contact_id: c.contact_id, channel: c.channel, contact_name: c.contact_name || "", lifecycle: c.lifecycle || "", unread: c.unread || 0, count: c.count || 0, last_at: c.last_at || null, last_preview: c.last_preview || "", last_direction: c.last_direction || null, state: c.state, needs_reply: !!c.needs_reply };
  return tech ? v : { ...v, assignee_id: c.assignee_id || null, imported: !!c.rotor };
};

// What a thread says about its contact. The contact's own fields a tech may
// read sit under `contact`; the rest (no ids) under `info`.
async function contactInfo(ctx, contact, channel) {
  if (!contact) return { contact: null, info: { missing: true } };
  const to = addressOf(contact, channel);
  let optedOut = false;
  if (to) {
    try { const sup = await getRaw(`sup/${channel}/${hk(channel === "sms" ? "phone" : "email", to)}`); optedOut = !!(sup && sup.data && sup.data.state === "opted_out"); } catch { optedOut = false; }
  }
  const a = await adapter(channel, { deploy: ctx.deploy }).catch(() => ({ mode: "dry_run" }));
  const consent = contact.consent || {};
  return {
    contact: techView("contact", { ...contact, display_name: contact.display_name || nameOf(contact) }),
    info: {
      name: contact.display_name || nameOf(contact), lifecycle: contact.lifecycle || "", town: (contact.billing_address && contact.billing_address.city) || "",
      has_address: !!to, opted_out: optedOut, service_revoked: channel === "sms" && !!consent.sms_service && consent.sms_service.state === "revoked",
      archived: contact.lifecycle === "archived", placeholder: !!(contact.flags && contact.flags.placeholder), mode: a.mode === "off" ? "dry_run" : a.mode,
    },
  };
}

// What is waiting in the Outbox for this contact on this channel (dry-run
// or held back): the thread shows them as "Not sent" bubbles. No record id
// under `id` (they are outbox items, not messages).
async function pendingFor(contactId, channel) {
  const out = await listOutbox({ contact_id: contactId, limit: 12 }).catch(() => ({ items: [] }));
  return out.items.filter((o) => o.kind === channel).map((o) => ({
    key: o.id, mode: o.mode, body_text: o.body || "", subject: o.subject || null, at: o.created_at, blocked_reason: o.blocked_reason || null,
    simulated: o.simulated ? o.simulated.status : null, origin: o.origin ? o.origin.kind : null, template_key: o.template_key || null,
  }));
}

// ------------------------------------------------------------ the inbox

async function inbox(ctx) {
  const sc = await inboxScope(ctx);
  const filter = ctx.query.get("filter") || "all";
  if (!FILTERS.includes(filter)) throw new InputError("That filter isn't one of the choices.", "filter");
  const cursor = ctx.query.get("cursor") || undefined;
  if (cursor && Number.isNaN(Date.parse(cursor))) throw new InputError("That page isn't there.", "cursor");
  const tech = !sc.all;
  const out = await listInbox({ filter, cursor, userId: ctx.user.id, visible: sc.visible });
  const etag = tech ? null : out.etag;
  if (etag && ctx.req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
  const items = out.items.map((x) => (tech ? { id: x.id, contact_id: x.contact_id, channel: x.channel, contact_name: x.contact_name, lifecycle: x.lifecycle, unread: x.unread, last_at: x.last_at, last_preview: x.last_preview, last_direction: x.last_direction, state: x.state, needs_reply: x.needs_reply } : x));
  return { data: items, meta: { next_cursor: out.next, filter }, ...(etag ? { etag } : {}) };
}

// ------------------------------------------------------------ a thread

async function threadOf(ctx, conv, contact, { before, since, withPending }) {
  const tech = isTechRole(ctx.user);
  const page = await threadPage(conv.id, { before });
  let items = page.items;
  if (since) items = items.filter((m) => m.sent_at > since);
  if (tech) items = items.map((m) => techView("message", m));
  const [ci, pending] = await Promise.all([contactInfo(ctx, contact, conv.channel), withPending ? pendingFor(conv.contact_id, conv.channel) : []]);
  return { conversation: convView(conv, tech), ...ci, messages: items, pending, next: since ? null : page.next };
}

async function conversation(ctx) {
  const sc = await inboxScope(ctx);
  const got = await getConversation(ctx.params.id);
  const conv = got.data;
  need(ctx, sc, "conversation", conv);
  const etag = `"cv-${conv.wv}-${String(conv.updated_at || "").slice(11, 23)}"`;
  const before = ctx.query.get("before") || undefined;
  const since = ctx.query.get("since") || undefined;
  if (!before && ctx.req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
  const c = await getRecord("contact", conv.contact_id);
  const data = await threadOf(ctx, conv, c ? c.data : null, { before, since, withPending: !before });
  // the same person's other thread (texts ↔ email) is one tap away
  if (!before && !since) data.threads = (await conversationsOf(conv.contact_id)).map((x) => convView(x, !sc.all));
  return { data, ...(before ? {} : { etag }) };
}

// A contact's threads (the Messages tab), and the thread on one channel
// even before its first real message (dry-run sends wait in `pending`).
async function contactThreads(ctx) {
  const sc = await inboxScope(ctx);
  const id = ctx.params.id;
  if (!isId(id, "contact")) throw new NotFoundError("That contact isn't there.");
  const got = await getRecord("contact", id);
  if (!got || got.data.deleted_at) throw new NotFoundError("That contact isn't there.");
  const contact = got.data;
  if (!sc.all && !ctx.can("inbox:read", { type: "contact", record: contact, visible: sc.visible.has(contact.id) })) throw new ForbiddenError("You don't have access to that.");
  const tech = !sc.all;
  const convs = await conversationsOf(contact.id);
  const want = ctx.query.get("channel");
  if (want && !CHANNELS.includes(want)) throw new InputError("Pick text or email.", "channel");
  const channel = want || (convs[0] ? convs[0].channel : "sms");
  const conv = convs.find((c) => c.channel === channel) || null;
  const threads = convs.map((c) => convView(c, tech));
  if (conv) return { data: { threads, channel, ...(await threadOf(ctx, conv, contact, { before: ctx.query.get("before") || undefined, withPending: true })) } };
  const [ci, pending] = await Promise.all([contactInfo(ctx, contact, channel), pendingFor(contact.id, channel)]);
  return { data: { threads, channel, conversation: null, ...ci, messages: [], pending, next: null } };
}

async function oneConversation(ctx) {
  const sc = await inboxScope(ctx);
  const got = await getConversation(ctx.params.id);
  need(ctx, sc, "conversation", got.data);
  return { sc, conv: got.data };
}

async function read(ctx) {
  const { conv, sc } = await oneConversation(ctx);
  return { data: convView(await markRead(conv.id, ctx.write()), !sc.all) };
}

async function done(ctx) {
  const { conv, sc } = await oneConversation(ctx);
  const b = ctx.body || {};
  if (b.done !== undefined && typeof b.done !== "boolean") throw new InputError("Done or not.", "done");
  return { data: convView(await setDone(conv.id, b.done !== false, ctx.write()), !sc.all) };
}

async function assignRoute(ctx) {
  const { conv, sc } = await oneConversation(ctx);
  if (!sc.all) throw new ForbiddenError("Only the office assigns a conversation.");
  const uid = (ctx.body || {}).user_id || null;
  if (uid) {
    if (!isId(uid, "user")) throw new InputError("Pick someone on the team.", "user_id");
    const u = await getRecord("user", uid);
    if (!u || u.data.status !== "active") throw new InputError("Pick someone on the team.", "user_id");
  }
  return { data: convView(await assign(conv.id, uid, ctx.write()), false) };
}

async function message(ctx) {
  const sc = await inboxScope(ctx);
  if (!isId(ctx.params.id, "message")) throw new NotFoundError("That message isn't there.");
  const got = await getRecord("message", ctx.params.id);
  if (!got || got.data.deleted_at) throw new NotFoundError("That message isn't there.");
  const m = got.data;
  need(ctx, sc, "message", m);
  const v = { ...messageView({ ...m, body_text: "" }), body_text: m.body_text || "", more: false };
  if (!sc.all) return { data: techView("message", v) };
  return { data: { ...v, from: m.from || "", to: m.to || "", footer_appended: !!m.footer_appended, related: m.related || {}, rotor: m.rotor ? { status_raw: m.rotor.status_raw || null, msg_class: m.rotor.msg_class || null } : null } };
}

// The Inbox tab's badge (GET /me/badges) and Home's row: conversations with
// something unread. One read of the small "open" shard; a technician's
// window is only worked out when something is unread at all.
export async function unreadFor(ctx) {
  if (!ctx || !ctx.user) return 0;
  if (ctx.can("inbox:read")) return unreadCount();
  if (ctx.holds("inbox:read") !== "own") return 0;
  if (!(await unreadCount())) return 0;
  return unreadCount({ visible: await techVisibleContacts(ctx.user.id) });
}

export const inboxRoutes = [
  r("GET", "/inbox", "inbox:read", inbox, { maxCalls: 60 }),
  r("GET", "/inbox/contact/:id", "inbox:read", contactThreads, { maxCalls: 90 }),
  r("GET", "/conversations/:id", "inbox:read", conversation, { maxCalls: 90 }),
  r("POST", "/conversations/:id/read", "inbox:read", read, { maxCalls: 40 }),
  r("POST", "/conversations/:id/done", "inbox:read", done, { maxCalls: 40 }),
  r("POST", "/conversations/:id/assign", "inbox:read", assignRoute, { maxCalls: 40 }),
  r("GET", "/messages/:id", "inbox:read", message, { maxCalls: 40 }),
];
