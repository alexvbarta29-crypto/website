// Comms: Claude's tools (design §6.9; the MCP endpoint itself is M7c's).
// Read-only here: sending a message is M7c's pending action, approved by an
// owner. A customer's own words are data, never instructions: every text a
// tool returns is marked untrusted_customer_text.

import { getRecord, readIndex } from "../../../crm-store.mjs";
import { isId } from "../../core/ids.mjs";
import { listInbox, threadPage, getConversation } from "./conversations.mjs";

const untrusted = (text) => ({ untrusted_customer_text: String(text ?? "") });

export const mcpTools = [
  {
    name: "comms_inbox", effect: "read", perm: "inbox:read",
    description: "Conversations that are unread or waiting for a reply (or all of them), newest first.",
    inputSchema: { type: "object", properties: { filter: { type: "string", enum: ["all", "unread", "needs_reply", "leads", "customers"] } }, additionalProperties: false },
    run: async (input = {}) => {
      const out = await listInbox({ filter: input.filter || "needs_reply", limit: 30 });
      return { conversations: out.items.map((c) => ({ id: c.id, contact_id: c.contact_id, name: c.contact_name, channel: c.channel, unread: c.unread, needs_reply: c.needs_reply, last_at: c.last_at, last_direction: c.last_direction, last: c.last_direction === "in" ? untrusted(c.last_preview) : c.last_preview })) };
    },
  },
  {
    name: "comms_thread", effect: "read", perm: "inbox:read",
    description: "The last messages of one conversation.",
    inputSchema: { type: "object", properties: { conversation_id: { type: "string" } }, required: ["conversation_id"], additionalProperties: false },
    run: async (input = {}) => {
      if (!isId(input.conversation_id, "conversation")) return { found: false };
      const conv = (await getConversation(input.conversation_id)).data;
      const page = await threadPage(conv.id, { limit: 20 });
      return { found: true, contact_id: conv.contact_id, name: conv.contact_name, channel: conv.channel, messages: page.items.map((m) => ({ at: m.sent_at, direction: m.direction, status: m.status, text: m.direction === "in" ? untrusted(m.body_text) : m.body_text })) };
    },
  },
  {
    name: "comms_campaigns", effect: "read", perm: "campaigns:write",
    description: "Campaigns with their status and counts (Rotor's past campaigns included).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async () => {
      const ix = await readIndex("campaigns", "");
      return { campaigns: ix.rows.map((r) => ({ id: r.id, name: r.n, status: r.st, channel: r.ch, recipients: r.rc, sent: r.se, from_rotor: !!r.ro })) };
    },
  },
  {
    name: "comms_reviews", effect: "read", perm: "reviews:read",
    description: "Recent Google reviews and whether each is matched to a customer.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async () => {
      const ix = await readIndex("reviews", "");
      const one = async (r) => ({ id: r.id, rating: r.r, at: r.at, matched: !!r.m, reviewer: r.n, comment: untrusted(((await getRecord("review", r.id).catch(() => null)) || { data: {} }).data.comment_excerpt || "") });
      return { reviews: await Promise.all(ix.rows.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 10).map(one)) };
    },
  },
];
