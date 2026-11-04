// Barta Office → Purchases: the family's shared buy list. Anyone adds what we
// need (link, why, price); everyone votes; Dad's vote decides. Then it's
// ordered (order number + tracking link) and delivered. See docs/PURCHASES.md.
//
// Storage: Netlify Blobs store "purchases" (strong consistency), one record
// per item at item/{id}. Tests set globalThis.__purchasesStoreOverride.

import { randomUUID } from "node:crypto";

export const PEOPLE = ["Alex", "Jacob", "Dad"];
export const DECIDER = "Dad";
export const STATUSES = ["requested", "approved", "denied", "ordered", "delivered"];

export async function openStore() {
  if (globalThis.__purchasesStoreOverride) return globalThis.__purchasesStoreOverride;
  const { getStore } = await import("@netlify/blobs");
  return getStore({ name: "purchases", consistency: "strong" });
}
const key = (id) => `item/${id}`;
export const getItem = (store, id) => store.get(key(id), { type: "json" });
export const saveItem = (store, it) => store.setJSON(key(it.id), it);
export async function allItems(store) {
  const res = await store.list({ prefix: "item/" });
  const keys = (res && Array.isArray(res.blobs) ? res.blobs : []).map((b) => b.key);
  const rows = await Promise.all(keys.map((k) => store.get(k, { type: "json" })));
  return rows.filter((r) => r && typeof r === "object").sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

export class InputError extends Error {}
const str = (v, max, field, required = false) => {
  const s = String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);
  if (required && !s) throw new InputError(`${field} is required.`);
  return s;
};
const longText = (v, max) => String(v == null ? "" : v).replace(/\r/g, "").trim().slice(0, max);
export function cleanUrl(v, field) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return "";
  const u = /^https?:\/\//i.test(s) ? s : "https://" + s;
  let parsed;
  try { parsed = new URL(u); } catch { throw new InputError(`${field} doesn't look like a link.`); }
  if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname.includes(".")) throw new InputError(`${field} doesn't look like a link.`);
  return parsed.href.slice(0, 2000);
}
export function cleanPrice(v) {
  if (v === "" || v == null) return null;
  const n = Number(String(v).replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n) || n < 0 || n > 1e7) throw new InputError("Price should be a dollar amount.");
  return Math.round(n * 100) / 100;
}
const cleanQty = (v) => {
  const n = Math.round(Number(v || 1));
  if (!Number.isFinite(n) || n < 1 || n > 100000) throw new InputError("Quantity should be a whole number.");
  return n;
};
export const person = (v) => {
  const p = PEOPLE.find((x) => x.toLowerCase() === String(v || "").trim().toLowerCase());
  if (!p) throw new InputError("Pick who you are first.");
  return p;
};

// Dad's vote decides; ordered/delivered come after approval.
export function statusOf(it) {
  if (it.delivered_at) return "delivered";
  if (it.ordered_at) return "ordered";
  const d = it.votes && it.votes[DECIDER];
  if (d === "yes") return "approved";
  if (d === "no") return "denied";
  return "requested";
}
const stamp = (it, by, what) => {
  it.updated_at = new Date().toISOString();
  it.history = [...(Array.isArray(it.history) ? it.history : []), { at: it.updated_at, by, what }].slice(-60);
  it.status = statusOf(it);
  return it;
};

export function newItem(body) {
  const by = person(body.by);
  const it = {
    id: randomUUID().slice(0, 12),
    title: str(body.title, 160, "What to buy", true),
    link: cleanUrl(body.link, "Link"),
    why: longText(body.why, 2000),
    price: cleanPrice(body.price),
    qty: cleanQty(body.qty),
    vendor: str(body.vendor, 80, "Store"),
    requested_by: by,
    created_at: new Date().toISOString(),
    votes: { [by]: "yes" },
    comments: [],
  };
  return stamp(it, by, "asked for it");
}

export function applyAction(it, body) {
  const by = person(body.by);
  switch (body.action) {
    case "vote": {
      const v = body.vote === "yes" || body.vote === "no" ? body.vote : null;
      it.votes = { ...(it.votes || {}) };
      if (v) it.votes[by] = v; else delete it.votes[by];
      return stamp(it, by, v === "yes" ? "approved" : v === "no" ? "said no" : "took back their vote");
    }
    case "order": {
      if (statusOf(it) !== "approved" && statusOf(it) !== "ordered") throw new InputError(`${DECIDER} has to approve it before it's ordered.`);
      it.order_no = str(body.order_no, 80, "Order number");
      it.tracking = cleanUrl(body.tracking, "Tracking link");
      if (body.paid !== undefined && body.paid !== "") it.paid = cleanPrice(body.paid);
      if (!it.ordered_at) { it.ordered_at = new Date().toISOString(); it.ordered_by = by; }
      return stamp(it, by, "marked it ordered");
    }
    case "deliver": {
      if (!it.ordered_at) throw new InputError("Mark it ordered first.");
      it.delivered_at = body.undo ? null : new Date().toISOString();
      if (body.undo) delete it.delivered_at;
      return stamp(it, by, body.undo ? "marked it not delivered" : "marked it delivered");
    }
    case "unorder": {
      delete it.ordered_at; delete it.ordered_by; delete it.delivered_at;
      return stamp(it, by, "marked it not ordered");
    }
    case "comment": {
      const text = longText(body.text, 1000);
      if (!text) throw new InputError("Write a note first.");
      it.comments = [...(Array.isArray(it.comments) ? it.comments : []), { by, text, at: new Date().toISOString() }].slice(-100);
      return stamp(it, by, "added a note");
    }
    case "edit": {
      const f = body.fields || {};
      if ("title" in f) it.title = str(f.title, 160, "What to buy", true);
      if ("link" in f) it.link = cleanUrl(f.link, "Link");
      if ("why" in f) it.why = longText(f.why, 2000);
      if ("price" in f) it.price = cleanPrice(f.price);
      if ("qty" in f) it.qty = cleanQty(f.qty);
      if ("vendor" in f) it.vendor = str(f.vendor, 80, "Store");
      return stamp(it, by, "edited it");
    }
    default:
      throw new InputError("Unknown action.");
  }
}
