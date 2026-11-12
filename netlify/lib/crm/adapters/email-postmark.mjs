// Barta CRM: the Postmark email driver (design §6.4, §6.1, D4).
//
// One call: POST https://api.postmarkapp.com/email with the server token,
// the message stream ("outbound" for quotes, invoices, receipts and
// reminders, "broadcast" for campaigns), a tag and metadata naming the
// step's marker so an ambiguous send can be found again (§7.3). Like the
// Twilio driver it checks for itself on top of the adapter layer's gate:
// no token → no request; test → only an address on
// cfg/integrations.email.test_allowlist; live → refused while Rotor is the
// system of record. It never changes anything in the Postmark account
// (no domains, streams, webhooks or templates).
//
//   send({ to, from, replyTo, subject, text, html, stream, headers, tag, metadata }) → { status: "sent" | "failed" | "blocked", provider_id?, error_code? }
//   findSent({ to, metadata }) → { provider_id, status } | null

import { getSetting, getRaw } from "../../crm-store.mjs";

export const POSTMARK_API = "https://api.postmarkapp.com";
export const POSTMARK_TIMEOUT_MS = 8000;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/i;

export function postmarkDriver(mode, { env = process.env } = {}) {
  if (!["test", "live"].includes(mode)) throw new TypeError("postmark: test or live");
  const token = () => String(env.POSTMARK_SERVER_TOKEN || "").trim();
  const head = () => ({ "x-postmark-server-token": token(), accept: "application/json", "content-type": "application/json" });

  async function gate(to) {
    if (!token()) return { status: "failed", error_code: "not_configured" };
    if (!EMAIL.test(String(to || ""))) return { status: "failed", error_code: "bad_address" };
    if (mode === "test") {
      const allow = (((await getSetting("integrations")).email || {}).test_allowlist || []).map((x) => String(x).toLowerCase());
      if (!allow.includes(String(to).toLowerCase())) return { status: "blocked", error_code: "test_mode_recipient" };
    } else {
      const sys = await getRaw("sys/mode");
      if (!sys || !sys.data || sys.data.system_of_record !== "crm") return { status: "blocked", error_code: "rotor_in_charge" };
    }
    return null;
  }

  return {
    async send({ to, from, replyTo, subject, text, html, stream = "outbound", headers = {}, tag, metadata = {} } = {}) {
      const no = await gate(to);
      if (no) return no;
      const body = {
        From: from, To: to, ...(replyTo ? { ReplyTo: replyTo } : {}), Subject: String(subject || "").slice(0, 300), TextBody: String(text || ""), ...(html ? { HtmlBody: html } : {}),
        MessageStream: stream === "broadcast" ? "broadcast" : "outbound", ...(tag ? { Tag: String(tag).slice(0, 100) } : {}),
        Metadata: Object.fromEntries(Object.entries(metadata).map(([k, v]) => [String(k).slice(0, 20), String(v).slice(0, 80)])),
        Headers: Object.entries(headers).map(([Name, Value]) => ({ Name, Value: String(Value) })), TrackOpens: false, TrackLinks: "None",
      };
      const res = await fetch(`${POSTMARK_API}/email`, { method: "POST", headers: head(), body: JSON.stringify(body), signal: AbortSignal.timeout(POSTMARK_TIMEOUT_MS) });
      let j = null;
      try { j = await res.json(); } catch { j = null; }
      if (!res.ok || (j && j.ErrorCode)) return { status: "failed", error_code: String((j && j.ErrorCode) || res.status) };
      return { status: "sent", provider_id: (j && j.MessageID) || null };
    },
    async findSent({ to, metadata = {} } = {}) {
      if (!token() || !metadata.crm_marker) return null;
      const q = new URLSearchParams({ count: "5", offset: "0", recipient: String(to || ""), metadata_crm_marker: String(metadata.crm_marker) });
      const res = await fetch(`${POSTMARK_API}/messages/outbound?${q}`, { headers: head(), signal: AbortSignal.timeout(POSTMARK_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`postmark lookup ${res.status}`);
      const j = await res.json();
      const hit = (j.Messages || [])[0];
      return hit ? { provider_id: hit.MessageID, status: "sent" } : null;
    },
  };
}
