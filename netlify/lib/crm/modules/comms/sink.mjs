// Comms: the messages.sink service and the sent-message recorder (design
// §5.7.1 "Sending", §11.3 messages.sink).
//
// - commsSink(message, ctx): what POST /messages calls for a person's text
//   or email (the inbox composer, the tech's On my way and Running late).
//   It goes through core's sender exactly like the core default did: in
//   dry-run the send is an Outbox item and nothing else; in test or live it
//   reaches the provider and comes back with its message and conversation.
// - recordSent(sent, ctx): registered with core's sender (setSentRecorder).
//   Every send that really reached a provider, whoever started it (a
//   person, an automation, a cadence step, a campaign batch), becomes a
//   Message in its Conversation, with its timeline row. A failed provider
//   answer is recorded too, with its code, so the thread shows it.
// - settlers for a send whose answer never came (§7.3): Twilio by number,
//   time and body hash, Postmark by the marker in its metadata. Found →
//   done; not found → unknown (the owners are told; nothing is re-sent).

import { getRecord, currentScope } from "../../../crm-store.mjs";
import { sendMessage, addressOf } from "../../core/send.mjs";
import { isId } from "../../core/ids.mjs";
import { adapter } from "../../adapters/index.mjs";
import { recordMessage } from "./conversations.mjs";

export async function commsSink(message, ctx = {}) {
  const r = await sendMessage({ ...message, origin: message.origin || { kind: "user", user_id: ctx.by }, category: message.category || (message.template_key ? undefined : "personal") }, ctx);
  return {
    outbox_id: r.outbox_id || null, status: r.status, mode: r.mode,
    ...(r.blocked_reason ? { blocked_reason: r.blocked_reason } : {}), ...(r.send_at ? { send_at: r.send_at } : {}), ...(r.error_code ? { error_code: r.error_code } : {}),
    ...(r.message_id ? { message_id: r.message_id, conversation_id: r.conversation_id } : {}),
  };
}

export async function recordSent(sent, ctx = {}) {
  const out = await recordMessage({
    contact: sent.contact, channel: sent.channel, direction: "out", from: sent.from || "", to: sent.to || "",
    ...(sent.channel === "email" && sent.subject ? { subject: sent.subject } : {}), body_text: sent.text || "", ...(sent.channel === "email" && sent.html ? { body_html: sent.html } : {}),
    status: sent.status, provider: sent.channel === "sms" ? "twilio" : "postmark", provider_id: sent.provider_id || null, error_code: sent.error_code || null,
    segments: sent.segments, footer_appended: sent.footer_appended, sending_number: sent.number || null,
    origin: sent.origin || { kind: "system" }, related: sent.related || {}, marker_key: sent.marker_key || null,
  }, ctx);
  return out.message ? { message_id: out.message.id, conversation_id: out.conversation.id } : {};
}

// An expired `sending` marker: did the provider get it? → { found, provider_ref } | null (can't tell now)
const contactOfMarker = async (marker) => {
  const cid = marker && marker.metadata && marker.metadata.contact_id;
  if (!isId(cid, "contact")) return null;
  const got = await getRecord("contact", cid).catch(() => null);
  return got ? got.data : null;
};
export async function settleTwilio(marker) {
  const contact = await contactOfMarker(marker);
  const to = contact ? addressOf(contact, "sms") : null;
  if (!to) return null;
  const a = await adapter("sms", { deploy: (currentScope() || {}).deploy }).catch(() => null);
  if (!a || !a.impl || typeof a.impl.findSent !== "function" || a.mode === "dry_run") return null;
  try {
    const hit = await a.impl.findSent({ to, since: marker.at, bodySha256: marker.body_sha256 });
    return hit ? { found: true, provider_ref: hit.provider_id } : { found: false };
  } catch { return null; }
}
export async function settlePostmark(marker) {
  const contact = await contactOfMarker(marker);
  const to = contact ? addressOf(contact, "email") : null;
  if (!to) return null;
  const a = await adapter("email", { deploy: (currentScope() || {}).deploy }).catch(() => null);
  if (!a || !a.impl || typeof a.impl.findSent !== "function" || a.mode === "dry_run") return null;
  try {
    const hit = await a.impl.findSent({ to, metadata: { crm_marker: marker.metadata && marker.metadata.crm_marker } });
    return hit ? { found: true, provider_ref: hit.provider_id } : { found: false };
  } catch { return null; }
}
