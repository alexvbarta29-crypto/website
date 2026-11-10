// Barta CRM core: staff notifications and web push (design §5.7.7).
//
// notify(userIds, { kind, title, body, link }, ctx) is cheap enough for a
// request: it writes ONE queue item ("notify.deliver", marker
// done/notify/{id}) and wakes the fast lane, which then
//   1. writes one notification per person (rec/notification/{id}, ids
//      derived from the item, so a retried delivery never makes two), listed
//      under rel/user-notifications/{uid} and, while unread,
//      rel/user-unread/{uid} (the bell's count is one listing);
//   2. pushes it to each of that person's phones (push/{uid}/{sha256(endpoint)})
//      when their channels for that kind include push (user.notify; kinds
//      without a setting default to push). A 404/410 from the push service
//      deletes the subscription.
// Push payloads carry a title, a short body and a /office#crm link; callers
// keep customer data out of them beyond a first name and a town.
//
// Push subscriptions: savePushSubscription / listPushSubscriptions /
// deletePushSubscription (the routes in modules/system/comms.mjs).

import { createHash } from "node:crypto";
import { createRecord, updateRecord, getRecord, getRecords, listRel, listKeys, getRaw, settledWrite, deleteRaw, currentScope, readIndex, hardDelete } from "../../crm-store.mjs";
import { defineType } from "./registry.mjs";
import { nowIso, nowMs, tsKey } from "./clock.mjs";
import { deriveId, isId, newId } from "./ids.mjs";
import { InputError, NotFoundError } from "./errors.mjs";
import { shape, str, enumValue } from "./validate.mjs";
import { truncate } from "./text.mjs";
import { enqueue } from "./queue.mjs";
import { isPushEndpoint } from "./webpush.mjs";
import { adapter } from "../adapters/index.mjs";
import { safeErr } from "../../referral-lib.mjs";

export const KINDS = Object.freeze(["new_lead", "reply", "payment", "payment_failed", "agreement_signed", "quote_approved", "changes_requested", "review", "task", "approval", "visit_assigned", "visit_changed", "visit_cancelled", "clock_reminder", "system"]);
// The user.notify setting a kind follows (§4.1); a kind not listed (or a
// person with no setting for it) gets push.
export const NOTIFY_SETTING = Object.freeze({
  new_lead: "new_lead", reply: "reply", payment: "payment", payment_failed: "payment", agreement_signed: "agreement_signed",
  review: "review", approval: "approval", task: "work", visit_assigned: "work", visit_changed: "work", visit_cancelled: "work",
  clock_reminder: "work", quote_approved: "sales", changes_requested: "sales", system: "system",
});
export const MAX_RECIPIENTS = 20;
export const PUSH_TTL_S = 24 * 3600;

const sortOf = (r) => tsKey(new Date(Date.parse(r.created_at) || 0));
const LINK_RE = /^\/[a-z0-9/_.?=&%-]*$/i;

function validateNotification(data, { op } = {}) {
  const stored = op === "update";
  return shape(data, {
    user_id: (v, f) => { if (!isId(v, "user")) throw new InputError("A notification needs a person.", f); return v; },
    kind: (v, f) => enumValue(v, KINDS, { field: f, required: true, stored }),
    title: (v, f) => str(v, { field: f, max: 80, required: true }),
    body: (v, f) => str(v, { field: f, max: 300 }),
    link: (v, f) => { const s = str(v, { field: f, max: 200 }); if (s && !LINK_RE.test(s)) throw new InputError("A link inside the CRM, like /today.", f); return s; },
  });
}

export const notificationType = defineType({
  type: "notification",
  prefix: "nt",
  v: 1,
  validate: validateNotification,
  rotorFields: [],
  techFields: ["id", "user_id", "kind", "title", "body", "link", "read_at", "created_at"],
  shadow: false,
  audit: false,
  rels: [
    { rel: "user-notifications", parent: (r) => r.user_id, sort: sortOf },
    { rel: "user-unread", parent: (r) => (r.read_at ? null : r.user_id), sort: sortOf },
  ],
  summary: (r) => ({ id: r.id, kind: r.kind, title: r.title }),
  example: () => ({ user_id: "us_0000000000000000000a", kind: "system", title: "Test notification", body: "Push works on this phone.", link: "/today" }),
});

const clean = (n) => ({
  kind: KINDS.includes(n && n.kind) ? n.kind : "system",
  title: truncate(String((n && n.title) || "Barta CRM").trim(), 80),
  body: truncate(String((n && n.body) || "").trim(), 300),
  link: n && typeof n.link === "string" && LINK_RE.test(n.link) ? n.link.slice(0, 200) : "/today",
});

// Queues a notification for people (in-app always, push by their choice).
export async function notify(userIds, n, ctx = {}) {
  const ids = [...new Set((Array.isArray(userIds) ? userIds : [userIds]).filter((x) => isId(x, "user")))].slice(0, MAX_RECIPIENTS);
  if (!ids.length) return { queued: false, users: 0 };
  const note = clean(n);
  const id = newId("event");
  await enqueue("notify.deliver", null, {}, undefined, { ns: "done", scope: "notify", key: id }, { data: { users: ids, note, by: (ctx && ctx.by) || "system" } });
  return { queued: true, users: ids.length, id };
}

// The "notify.users" service (§11.3): (user_ids, { kind, title, body, link }, ctx).
export const notifyUsers = (userIds, n, ctx) => notify(userIds, n, ctx);

// The people who may approve pending actions (owners), for approval notices.
export async function approvers() {
  const ix = await readIndex("users", "");
  return ix.rows.filter((r) => r.role === "owner" && r.status === "active").map((r) => r.id);
}

const wantsPush = (user, kind) => {
  const setting = NOTIFY_SETTING[kind] || "system";
  const ch = user && user.notify && Array.isArray(user.notify[setting]) ? user.notify[setting] : null;
  return ch ? ch.includes("push") : true;
};

// Queue kind "notify.deliver": one notification per person, then push.
export async function deliverNotification(h) {
  const d = h.item.data || {};
  const users = Array.isArray(d.users) ? d.users : [];
  const note = clean(d.note);
  const got = await getRecords("user", users);
  let pushed = 0;
  for (const g of got) {
    if (!g || !g.data || g.data.status !== "active") continue;
    const u = g.data;
    const nid = deriveId("notification", h.marker._key, "notify", u.id);
    let rec = await getRecord("notification", nid);
    if (!rec) {
      try {
        rec = await createRecord("notification", { id: nid, user_id: u.id, ...note }, { by: d.by || "system", origin: "worker", actor_kind: "automation", requestId: h.ctx.requestId });
      } catch (e) {
        if (e && e.name !== "ExistsError") throw e;
        rec = await getRecord("notification", nid);
      }
    }
    if (wantsPush(u, note.kind)) pushed += await pushToUser(u.id, { title: note.title, body: note.body, link: note.link, id: nid, kind: note.kind });
  }
  return { result: `delivered:${got.filter(Boolean).length}:${pushed}` };
}

// ------------------------------------------------------------ push

export const pushKey = (userId, endpoint) => `push/${userId}/${createHash("sha256").update(String(endpoint)).digest("hex")}`;

// Sends one payload to every phone of a person. → number of phones reached.
export async function pushToUser(userId, payload, { deploy } = {}) {
  const a = await adapter("push", { deploy: deploy || (currentScope() || {}).deploy });
  if (a.mode === "off" || !a.impl) return 0;
  const keys = await listKeys(`push/${userId}/`);
  let n = 0;
  for (const k of keys.slice(0, 10)) {
    const got = await getRaw(k).catch(() => null);
    const sub = got && got.data;
    if (!sub || !sub.endpoint) continue;
    let r;
    try {
      r = await a.impl.push({ subscription: { endpoint: sub.endpoint, keys: sub.keys }, payload: JSON.stringify(payload), ttl: PUSH_TTL_S, outbox: { origin: { kind: "system" }, related: {} } });
    } catch (e) {
      console.error(`crm:notify: a push failed (${safeErr(e)})`);
      continue;
    }
    if (r.status === "gone") { await deleteRaw(k).catch(() => {}); continue; }
    if (r.status === "sent") {
      n += 1;
      await settledWrite(k, { ...sub, last_ok_at: nowIso() }, { onlyIfMatch: got.etag }).catch(() => {});
    }
  }
  return n;
}

// Saves (or refreshes) this phone's subscription for a person.
export async function savePushSubscription(userId, sub, { ua } = {}) {
  if (!sub || typeof sub !== "object" || !isPushEndpoint(sub.endpoint)) throw new InputError("That isn't a push subscription from this phone.", "endpoint");
  const keys = sub.keys || {};
  if (typeof keys.p256dh !== "string" || !/^[A-Za-z0-9_-]{80,100}$/.test(keys.p256dh) || typeof keys.auth !== "string" || !/^[A-Za-z0-9_-]{16,30}$/.test(keys.auth)) {
    throw new InputError("That push subscription is missing its keys.", "keys");
  }
  const k = pushKey(userId, sub.endpoint);
  const cur = await getRaw(k);
  const value = { endpoint: sub.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, ua: truncate(String(ua || "Phone"), 60), created_at: cur && cur.data ? cur.data.created_at : nowIso(), updated_at: nowIso() };
  const w = await settledWrite(k, value, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
  if (!w.ok) {
    const again = await getRaw(k);
    if (!again || !again.data || again.data.endpoint !== sub.endpoint) throw new InputError("That didn't save. Try again.");
  }
  return { hash: k.split("/").pop(), ua: value.ua, created_at: value.created_at };
}

export async function listPushSubscriptions(userId) {
  const keys = await listKeys(`push/${userId}/`);
  const got = await Promise.all(keys.slice(0, 20).map((k) => getRaw(k).catch(() => null)));
  return keys.slice(0, 20).map((k, i) => {
    const d = got[i] && got[i].data;
    if (!d) return null;
    let service = "push";
    try { service = new URL(d.endpoint).hostname.split(".").slice(-2, -1)[0] || "push"; } catch { /* keep */ }
    return { hash: k.split("/").pop(), ua: d.ua || "Phone", service, created_at: d.created_at || null, last_ok_at: d.last_ok_at || null };
  }).filter(Boolean);
}

export async function deletePushSubscription(userId, hash) {
  if (!/^[0-9a-f]{64}$/.test(String(hash))) throw new NotFoundError("That phone isn't there.");
  const k = `push/${userId}/${hash}`;
  const got = await getRaw(k);
  if (!got) throw new NotFoundError("That phone isn't there.");
  await deleteRaw(k);
}

// ------------------------------------------------------------ the bell

export async function unreadCount(userId) {
  const rows = await listRel("user-unread", userId, { limit: 100 });
  return rows.length;
}

export async function listNotifications(userId, { limit = 30, before } = {}) {
  const rows = (await listRel("user-notifications", userId, { to: before, limit: limit + 1 })).filter((r) => !before || r.sortKey < before);
  const page = rows.slice(0, limit);
  const got = await getRecords("notification", page.map((r) => r.id));
  const items = got.filter((g) => g && g.data && g.data.user_id === userId).map((g) => {
    const n = g.data;
    return { id: n.id, kind: n.kind, title: n.title, body: n.body || "", link: n.link || "/today", read_at: n.read_at || null, created_at: n.created_at };
  });
  return { items, next: rows.length > limit ? page[page.length - 1].sortKey : null };
}

// Marks some (ids) or all (up to 50 unread) of a person's notifications read.
export async function markRead(userId, { ids, all = false } = {}, ctx = {}) {
  let list = Array.isArray(ids) ? ids.filter((x) => isId(x, "notification")).slice(0, 50) : [];
  if (all) list = (await listRel("user-unread", userId, { limit: 50 })).map((r) => r.id);
  let n = 0;
  for (const id of list) {
    try {
      const r = await updateRecord("notification", id, (x) => (x.user_id !== userId || x.read_at ? null : { ...x, read_at: nowIso() }), ctx);
      if (r.changed) n += 1;
    } catch (e) {
      if (!(e instanceof NotFoundError)) throw e;
    }
  }
  return { read: n };
}


// Sweep notifications.prune (daily, maintenance): notifications older than
// KEEP_DAYS leave the store (the bell shows the recent ones only).
export const KEEP_DAYS = 60;
export async function pruneNotifications(ctx = {}) {
  const ix = await readIndex("users", "");
  const cutoff = tsKey(new Date(nowMs() - KEEP_DAYS * 86400000));
  let removed = 0;
  for (const u of ix.rows) {
    if (ctx.budget && ctx.budget.left() < 3000) return { done: false, progress: removed };
    const old = await listRel("user-notifications", u.id, { to: cutoff, limit: 200, newestFirst: false });
    for (const r of old) {
      if (r.sortKey >= cutoff) continue;
      await hardDelete("notification", r.id, ctx.write ? ctx.write() : {}).catch(() => {});
      removed += 1;
    }
  }
  return { done: true, result: { removed } };
}
