// Comms: conversations and their messages (design §5.7.1).
//
// A conversation is (contact, channel). Its id is derived from the two
// (convIdFor), so two messages arriving at the same moment make one
// conversation, never two, and the import lands on the same record every
// run. A contact merged into another keeps its threads: they are listed on
// the surviving contact through rel/contact-convs.
//
// recordMessage() is the one place a message that really went out or came
// in becomes records: the message (write-once), the conversation (last
// message, unread, needs reply; a new inbound reopens a handled one), the
// contact's timeline row, and for an inbound the comms stats part. Dry-run
// sends never come here: they are outbox items only (§5.7.1).
//
// The inbox index (ix/inbox) is sharded: "open" (what still needs someone)
// and one shard per year of handled threads, so a new text rewrites a small
// blob, not the whole history. A batch of sends (a campaign's 25) collects
// its index rows and writes each touched shard once (withInboxBatch).
//
// A status callback only moves a message's status forward (applyStatus); it
// never writes the conversation or the inbox.

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { getRecord, getRecords, createRecord, updateRecord, updateStats, readIndex, listRel, addActivity, applyIndexRows, withStoreScope, currentScope, ExistsError } from "../../../crm-store.mjs";
import { deriveId, newId, isId } from "../../core/ids.mjs";
import { now, nowIso, localDate } from "../../core/clock.mjs";
import { NotFoundError, InputError } from "../../core/errors.mjs";
import { statsPart } from "../../core/registry.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { inboxShard, inboxRow, previewOf, statusMayMove, statusRank } from "./types.mjs";

export const convIdFor = (contactId, channel) => deriveId("conversation", contactId, `conv.${channel}`, 1);
export const PAGE = 30;
export const INBOX_PAGE = 50;
export const FIRST_YEAR = 2024;           // nothing older than Rotor is imported (D35)
export const FILTERS = Object.freeze(["all", "unread", "needs_reply", "leads", "customers", "mine", "open"]);

const nameOf = (c) => (c ? c.display_name || [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || c.company_name || "" : "");

// Bookkeeping writes (counters, last message): no audit event per message.
const quiet = (ctx) => ({ ...ctx, audit: false });

// ------------------------------------------------------------ the inbox batch

const batchAls = new AsyncLocalStorage();

// Runs fn with the conversations it touches collected, then writes each
// touched inbox shard once. Nested calls join the outer batch.
export async function withInboxBatch(fn) {
  if (batchAls.getStore()) return fn();
  const batch = { rows: new Map() };
  try {
    return await batchAls.run(batch, fn);
  } finally {
    await flushBatch(batch).catch((e) => console.error(`crm:comms: inbox rows not written; the nightly check repairs them (${safeErr(e)})`));
  }
}

async function flushBatch(batch) {
  const byShard = new Map();
  for (const e of batch.rows.values()) {
    const list = byShard.get(e.shard) || [];
    list.push({ id: e.id, part: "conversation", row: e.row, wv: e.wv });
    byShard.set(e.shard, list);
  }
  batch.rows.clear();
  for (const [shard, entries] of byShard) await applyIndexRows("inbox", shard, entries);
}

// A conversation write: in a batch, the record now and its index row at
// the end; otherwise the store writes the row with the record.
async function saveConversation(id, mutate, ctx) {
  const batch = batchAls.getStore();
  if (!batch) return updateRecord("conversation", id, mutate, quiet(ctx));
  let before = null;
  const r = await updateRecord("conversation", id, (c) => { before = c; return mutate(c); }, { ...quiet(ctx), bulk: true });
  if (r.changed) {
    const was = inboxShard(before);
    const is = inboxShard(r.data);
    if (was !== is) batch.rows.set(`${was}|${id}`, { shard: was, id, row: null, wv: r.data.wv });
    batch.rows.set(`${is}|${id}`, { shard: is, id, row: inboxRow(r.data), wv: r.data.wv });
  }
  return r;
}

// ------------------------------------------------------------ finding and making

// The contact's conversation on a channel: the derived one, else one that
// came with a merged contact (the most recent), else null.
export async function findConversation(contactId, channel) {
  const own = await getRecord("conversation", convIdFor(contactId, channel));
  if (own && !own.data.deleted_at) return own.data;
  const rows = (await listRel("contact-convs", contactId, { limit: 20 })).filter((r) => r.sortKey === channel);
  if (!rows.length) return null;
  const got = (await getRecords("conversation", rows.map((r) => r.id))).filter((g) => g && g.data && !g.data.deleted_at).map((g) => g.data);
  return got.sort((a, b) => String(b.last_at || "").localeCompare(String(a.last_at || "")))[0] || null;
}

export async function conversationsOf(contactId) {
  const rows = await listRel("contact-convs", contactId, { limit: 20 });
  const got = (await getRecords("conversation", rows.map((r) => r.id))).filter((g) => g && g.data && !g.data.deleted_at).map((g) => g.data);
  return got.sort((a, b) => String(b.last_at || "").localeCompare(String(a.last_at || "")));
}

export async function ensureConversation(contact, channel, address, ctx) {
  const found = await findConversation(contact.id, channel);
  if (found) return found;
  const id = convIdFor(contact.id, channel);
  const batch = batchAls.getStore();
  try {
    const r = await createRecord("conversation", {
      id, contact_id: contact.id, channel, address: address || "", contact_name: nameOf(contact), lifecycle: contact.lifecycle || "",
      unread: 0, count: 0, state: "done", needs_reply: false, last_at: nowIso(),
    }, batch ? { ...quiet(ctx), bulk: true } : quiet(ctx));
    if (batch) batch.rows.set(`${inboxShard(r.data)}|${id}`, { shard: inboxShard(r.data), id, row: inboxRow(r.data), wv: r.data.wv });
    return r.data;
  } catch (e) {
    if (!(e instanceof ExistsError)) throw e;
    const got = await getRecord("conversation", id);
    if (!got) throw e;
    return got.data;
  }
}

// ------------------------------------------------------------ recording a message

// input: { contact, channel, direction: "in" | "out", from, to, subject?, body_text, body_html?, status, provider,
//          provider_id?, error_code?, blocked_reason?, segments?, footer_appended?, sending_number?, origin, related?,
//          attachment_file_ids?, media_pending?, sent_at?, id? }
// → { message, conversation, duplicate? }
export async function recordMessage(input, ctx = {}) {
  const contact = input.contact;
  if (!contact || !isId(contact.id, "contact")) throw new InputError("A message needs its contact.", "contact_id");
  const at = input.sent_at || nowIso();
  const inbound = input.direction === "in";
  const conv = await ensureConversation(contact, input.channel, inbound ? input.from : input.to, ctx);
  const id = input.id || newId("message");
  let message;
  try {
    message = (await createRecord("message", {
      id, conversation_id: conv.id, contact_id: conv.contact_id, channel: input.channel, direction: input.direction, from: input.from || "", to: input.to || "",
      ...(input.subject ? { subject: input.subject } : {}), body_text: input.body_text || "", ...(input.body_html ? { body_html: input.body_html } : {}),
      status: input.status, provider: input.provider, ...(input.provider_id ? { provider_id: input.provider_id } : {}),
      ...(input.error_code ? { error_code: input.error_code } : {}), ...(input.blocked_reason ? { blocked_reason: input.blocked_reason } : {}),
      ...(input.segments ? { segments: input.segments } : {}), ...(input.footer_appended !== undefined ? { footer_appended: !!input.footer_appended } : {}),
      ...(input.sending_number ? { sending_number: input.sending_number } : {}), origin: input.origin || { kind: "system" }, related: input.related || {},
      attachment_file_ids: input.attachment_file_ids || [], ...(input.media_pending ? { media_pending: input.media_pending } : {}),
      ...(input.media_urls ? { media_urls: input.media_urls } : {}), ...(input.marker_key ? { marker_key: input.marker_key } : {}), ...(input.keyword ? { keyword: input.keyword } : {}),
      sent_at: at, ...(input.status === "delivered" ? { delivered_at: at } : {}),
    }, ctx)).data;
  } catch (e) {
    // the provider's id is already a message (a webhook delivered twice, a retried send)
    if (e instanceof ExistsError) return { duplicate: true, conversation: conv, message: null };
    throw e;
  }
  const preview = previewOf(input.channel === "email" && input.subject ? input.subject : input.body_text);
  const saved = await saveConversation(conv.id, (c) => {
    const newer = !c.last_at || at >= c.last_at || (c.count || 0) === 0;
    return {
      ...c, count: (c.count || 0) + 1,
      ...(newer ? { last_at: at, last_preview: preview, last_direction: input.direction } : {}),
      ...(inbound ? { unread: (c.unread || 0) + 1, needs_reply: true, state: "open", address: input.from || c.address } : { needs_reply: newer ? false : c.needs_reply }),
      contact_name: nameOf(contact) || c.contact_name, lifecycle: contact.lifecycle || c.lifecycle,
    };
  }, ctx);
  const side = [addActivity(conv.contact_id, `${input.channel}.${input.direction}`, id, new Date(at)).catch(() => {})];
  if (inbound && statsPart("comms")) side.push(updateStats(conv.contact_id, "comms", (p) => ({ ...p, last_inbound_at: at }), quiet(ctx)).catch((e) => console.error(`crm:comms: stats not updated (${safeErr(e)})`)));
  await Promise.all(side);
  return { message, conversation: saved.data };
}

// A provider's status for a message (§5.7.1): only a higher rank applies,
// the first terminal status wins. Never touches the conversation or ix/inbox.
export async function applyStatus(messageId, status, { error_code, at } = {}, ctx = {}) {
  if (statusRank(status) < 0) return { changed: false };
  const r = await updateRecord("message", messageId, (m) => {
    if (m.status === status || !statusMayMove(m.status, status)) return null;
    return { ...m, status, ...(status === "delivered" ? { delivered_at: at || nowIso() } : {}), ...(error_code ? { error_code: String(error_code).slice(0, 40) } : {}) };
  }, quiet(ctx));
  return { changed: r.changed, message: r.data };
}

// ------------------------------------------------------------ reading

export async function getConversation(id) {
  if (!isId(id, "conversation")) throw new NotFoundError("That conversation isn't there.");
  const got = await getRecord("conversation", id);
  if (!got || got.data.deleted_at) throw new NotFoundError("That conversation isn't there.");
  return got;
}

const short = (m) => ({
  id: m.id, conversation_id: m.conversation_id, contact_id: m.contact_id, channel: m.channel, direction: m.direction, ...(m.subject ? { subject: m.subject } : {}),
  body_text: m.body_text || "", status: m.status, ...(m.blocked_reason ? { blocked_reason: m.blocked_reason } : {}), ...(m.error_code ? { error_code: m.error_code } : {}),
  ...(m.segments ? { segments: m.segments } : {}), attachment_file_ids: m.attachment_file_ids || [], ...(m.media_pending ? { media_pending: m.media_pending } : {}),
  sent_at: m.sent_at || m.created_at, ...(m.delivered_at ? { delivered_at: m.delivered_at } : {}), origin: m.origin ? { kind: m.origin.kind, ...(m.origin.id ? { id: m.origin.id } : {}), ...(m.origin.user_id ? { user_id: m.origin.user_id } : {}) } : null, provider: m.provider,
});
// What a thread shows of a message: a long email's text is cut (the whole one is GET /messages/:id).
export const BUBBLE_MAX = 1200;
export function messageView(m) {
  const v = short(m);
  const chars = Array.from(v.body_text);
  if (chars.length > BUBBLE_MAX) { v.body_text = chars.slice(0, BUBBLE_MAX).join(""); v.more = true; }
  if (m.rotor && m.rotor.attachments_missing) v.attachments_missing = m.rotor.attachments_missing;
  if (m.provider === "rotor_import") v.imported = true;
  if (m.body_html) v.has_html = true;
  return v;
}

// One page of a thread, newest first. before: the sort key of the oldest row already shown.
export async function threadPage(convId, { before, limit = PAGE } = {}) {
  const rows = (await listRel("conv-messages", convId, { to: before, limit: limit + 1 + (before ? 1 : 0) })).filter((r) => !before || r.sortKey < before);
  const page = rows.slice(0, limit);
  const got = await getRecords("message", page.map((r) => r.id));
  const items = got.filter((g) => g && g.data && !g.data.deleted_at).map((g) => messageView(g.data));
  return { items, next: rows.length > limit ? page[page.length - 1].sortKey : null };
}

// ------------------------------------------------------------ the inbox

const yearNow = () => Number(localDate(now()).slice(0, 4));
const rowView = (r) => ({ id: r.id, contact_id: r.c, channel: r.ch, contact_name: r.n, last_preview: r.p, last_at: r.la, last_direction: r.ld, unread: r.u || 0, needs_reply: !!r.nr, state: r.st, lifecycle: r.lc || "", ...(r.a ? { assignee_id: r.a } : {}) });
const cmp = (a, b) => (a.la === b.la ? (a.id < b.id ? 1 : -1) : String(a.la || "") < String(b.la || "") ? 1 : -1);

// Index reads for a list or a count share one memo and skip the dirty markers (one call per shard).
const memo = (fn) => (currentScope() && currentScope().ixMemo instanceof Map ? fn() : withStoreScope({ ixMemo: new Map() }, fn));

// → { items, next, etag }. visible: a Set of contact ids (a tech's window), or null for everyone.
export async function listInbox({ filter = "all", cursor, limit = INBOX_PAGE, userId, visible = null } = {}) {
  if (!FILTERS.includes(filter)) throw new InputError("That filter isn't one of the choices.", "filter");
  return memo(async () => {
    const openOnly = ["unread", "needs_reply", "open"].includes(filter);
    const keep = (r) => (!visible || visible.has(r.c))
      && (filter === "unread" ? r.u > 0 : filter === "needs_reply" ? r.nr : filter === "leads" ? r.lc === "lead" : filter === "customers" ? r.lc === "customer" || r.lc === "former_customer" : filter === "mine" ? r.a === userId : true)
      && (!cursor || String(r.la || "") < cursor);
    const etags = [];
    const open = await readIndex("inbox", "open");
    etags.push(open.etag || "-");
    let rows = open.rows.filter(keep);
    if (!openOnly) {
      // handled threads, newest year first, until the page is full
      const from = cursor ? Math.min(yearNow(), Number(cursor.slice(0, 4)) || yearNow()) : yearNow();
      for (let y = from; y >= FIRST_YEAR && rows.length <= limit; y--) {
        const ix = await readIndex("inbox", `y${y}`);
        etags.push(ix.etag || "-");
        rows = rows.concat(ix.rows.filter(keep));
      }
    }
    rows.sort(cmp);
    const page = rows.slice(0, limit);
    return { items: page.map(rowView), next: rows.length > limit && page.length ? page[page.length - 1].la : null, etag: `"in-${createHash("sha256").update(etags.join("|") + filter + (cursor || "")).digest("hex").slice(0, 20)}"` };
  });
}

// Conversations with something unread (one index read): the Inbox badge and Home's row.
export async function unreadCount({ visible = null } = {}) {
  return memo(async () => (await readIndex("inbox", "open")).rows.filter((r) => r.u > 0 && (!visible || visible.has(r.c))).length);
}

// ------------------------------------------------------------ a person's actions

export async function markRead(id, ctx) {
  return (await updateRecord("conversation", id, (c) => (c.unread ? { ...c, unread: 0 } : null), quiet(ctx))).data;
}
export async function setDone(id, done, ctx) {
  return (await updateRecord("conversation", id, (c) => {
    const state = done ? "done" : "open";
    if (c.state === state && (!done || (!c.needs_reply && !c.unread))) return null;
    return { ...c, state, ...(done ? { needs_reply: false, unread: 0 } : {}) };
  }, ctx)).data;
}
export async function assign(id, userId, ctx) {
  if (userId && !isId(userId, "user")) throw new InputError("Pick someone on the team.", "user_id");
  return (await updateRecord("conversation", id, (c) => {
    const next = { ...c };
    if (userId) next.assignee_id = userId; else delete next.assignee_id;
    return next;
  }, ctx)).data;
}

// A contact's name or lifecycle changed, or a contact was merged: its
// threads carry the surviving contact's id and name.
export async function reassign(fromContactId, toContact, ctx) {
  const rows = await listRel("contact-convs", fromContactId, { limit: 20 });
  let n = 0;
  for (const r of rows) {
    const u = await updateRecord("conversation", r.id, (c) => (c.contact_id === toContact.id ? null : { ...c, contact_id: toContact.id, contact_name: nameOf(toContact) || c.contact_name, lifecycle: toContact.lifecycle || c.lifecycle }), quiet(ctx));
    if (u.changed) n += 1;
  }
  return n;
}

export { nameOf };
