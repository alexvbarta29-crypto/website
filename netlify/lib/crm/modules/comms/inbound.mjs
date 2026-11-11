// Comms: what comes in (design §5.7.1 "Inbound", §6.3, §6.4).
//
//   POST /hooks/twilio/sms      an inbound text (form-encoded, X-Twilio-Signature)
//   POST /hooks/twilio/status   a delivery status (same signature; ?m= names the step's marker)
//   POST /hooks/email/postmark  Delivery, Bounce, SpamComplaint, SubscriptionChange (?token=)
//
// Nothing here works until an owner connects the account: each webhook
// answers 403 and reads nothing unless its secret is set (TWILIO_AUTH_TOKEN
// with TWILIO_ACCOUNT_SID, POSTMARK_WEBHOOK_TOKEN) and texting or email is
// in test or live mode. The CRM never registers these addresses anywhere:
// an owner pastes them into Twilio and Postmark when the number moves (D1).
//
// An inbound text:
//   1. the signature over the canonical URL and the sorted parameters;
//   2. once per MessageSid (ptr/provider-msg);
//   3. its contact: the sender's number → ptr/phone → the live contacts;
//      several → the most recently active one that isn't archived; none → a
//      new lead named after the number, source "Inbound text", with no
//      follow-up cadence started (it may be a customer's new phone);
//   4. the message, the conversation (reopened, needs reply, unread + 1) and
//      the timeline row; the answer goes back before any media is fetched
//      (a media.fetch queue item downloads the files afterwards);
//   5. keywords, the whole text and nothing else: STOP, STOPALL,
//      UNSUBSCRIBE, CANCEL, END, QUIT, OPTOUT, REVOKE → opted out (the
//      sender honours it at once, sales stops the follow-ups); START, UNSTOP
//      → opted back in; HELP, INFO → one responder: Twilio's Advanced
//      Opt-Out when it is on (the CRM only records the word), the CRM's
//      help_reply when it is off. YES is never an opt-in;
//   6. reply keywords (cfg/comms.reply_keywords, off until the owner names
//      them): a tag on the contact and a note in the notification;
//   7. the people to tell (the contact's owner, else the owners) and the
//      message.inbound event (sales pauses the follow-ups; the review
//      sequence stops).
// Before cutover the parallel-run guard applies: a text from a customer
// Rotor still owns is not recorded (a would- row instead); test phones are
// test contacts.
//
// A status callback only moves that message's status forward
// (conversations.mjs applyStatus): it never writes the conversation or
// ix/inbox. Twilio's 21610 (the carrier says unsubscribed) also opts the
// number out.

import { timingSafeEqual, createHash } from "node:crypto";
import { getRecord, updateRecord, createRecord, readPointer, getSetting, hk, currentScope } from "../../../crm-store.mjs";
import { isId, newId } from "../../core/ids.mjs";
import { nowIso } from "../../core/clock.mjs";
import { ParallelRunGuard } from "../../core/errors.mjs";
import { maskPhone, maskEmail, keySafe } from "../../core/text.mjs";
import { setSuppression } from "../../core/suppressions.mjs";
import { emit } from "../../core/events.mjs";
import { enqueue } from "../../core/queue.mjs";
import { notify, approvers } from "../../core/notify.mjs";
import { sendMessage } from "../../core/send.mjs";
import { wouldAct } from "../../core/activity.mjs";
import { storeImportedFile } from "../../core/files.mjs";
import { adapter } from "../../adapters/index.mjs";
import { verifySignature, SMS_HOOK, STATUS_HOOK } from "../../adapters/sms-twilio.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { providerKey } from "./types.mjs";
import { recordMessage, applyStatus } from "./conversations.mjs";

export const STOP_WORDS = Object.freeze(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "OPTOUT", "REVOKE"]);
export const START_WORDS = Object.freeze(["START", "UNSTOP"]);
export const HELP_WORDS = Object.freeze(["HELP", "INFO"]);
// The whole text, trimmed, any case: "Stop by tomorrow?" is not a STOP.
export function keywordOf(body) {
  const w = String(body ?? "").trim().toUpperCase();
  return STOP_WORDS.includes(w) ? { kind: "stop", word: w } : START_WORDS.includes(w) ? { kind: "start", word: w } : HELP_WORDS.includes(w) ? { kind: "help", word: w } : null;
}

const xml = (status = 200) => new Response("<Response/>", { status, headers: { "content-type": "text/xml; charset=utf-8", "cache-control": "no-store" } });
const refuse = (status = 403) => new Response(JSON.stringify({ ok: false, error: { code: status === 403 ? "forbidden" : "invalid", message: "Not accepted." } }), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const E164 = /^\+1\d{10}$/;
const HOOK = (ctx) => ({ by: "hook:twilio", origin: "hook", actor_kind: "automation", requestId: ctx.requestId, mode: ctx.modeVal });

// Texting (or email) is connected: the secrets are there and the mode is test or live.
async function connected(ctx, kind) {
  const a = await adapter(kind, { deploy: ctx.deploy, mode: await ctx.sysMode() });
  return a.mode === "test" || a.mode === "live";
}

function formOf(raw) {
  const out = {};
  for (const [k, v] of new URLSearchParams(Buffer.from(raw || []).toString("utf8"))) out[k] = v;
  return out;
}

// The Twilio request is ours to trust: the account, then the signature.
async function twilioRequest(ctx, url) {
  const token = String(process.env.TWILIO_AUTH_TOKEN || "").trim();
  const sid = String(process.env.TWILIO_ACCOUNT_SID || "").trim();
  if (!token || !sid) return null;
  if (!(await connected(ctx, "sms"))) return null;
  const params = formOf(ctx.raw);
  if (!verifySignature(url, params, ctx.req.headers.get("x-twilio-signature"), token)) return null;
  if (params.AccountSid && params.AccountSid !== sid) return null;
  return params;
}

// ------------------------------------------------------------ routing

const liveOnes = async (ids) => {
  const out = new Map();
  for (const id of ids.slice(0, 20)) {
    let cur = id;
    for (let i = 0; i < 6 && isId(cur, "contact"); i++) {
      const got = await getRecord("contact", cur);
      if (!got) break;
      const next = got.data.merged_into || got.data.merging_into;
      if (!next || next === cur) { if (!got.data.deleted_at) out.set(cur, got.data); break; }
      cur = next;
    }
  }
  return [...out.values()];
};

// The contact a number belongs to. → { contact, shared, created }
export async function contactForNumber(e164, ctx) {
  const p = await readPointer("phone", hk("phone", e164));
  const ids = p && Array.isArray(p.ids) ? p.ids.filter((x) => isId(x, "contact")) : [];
  const list = await liveOnes(ids);
  if (list.length) {
    const ok = list.filter((c) => c.lifecycle !== "archived");
    const pick = (ok.length ? ok : list).sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")))[0];
    return { contact: pick, shared: list.length > 1, created: false };
  }
  const d = e164.slice(2);
  const name = `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  const rec = await createRecord("contact", {
    kind: "person", first_name: name, last_name: "", company_name: "", phones: [{ e164, label: "mobile", primary: true, sms: true }], emails: [], lifecycle: "lead",
    source: { source: "Inbound text", captured_at: nowIso() }, tags: [], notes: "Texted in from a number that wasn't on file. Link or merge it if it's someone you know.",
    consent: { sms_service: { state: "granted", source: "inbound_text", at: nowIso() }, sms_marketing: { state: "unknown" }, email_marketing: { state: "unknown" } }, flags: {}, watcher_ids: [],
  }, ctx);
  return { contact: rec.data, shared: false, created: true };
}

// ------------------------------------------------------------ an inbound text

async function replyKeyword(body, contact, ctx) {
  const cfg = (await getSetting("comms").catch(() => ({}))).reply_keywords || {};
  if (!cfg.enabled) return null;
  const w = String(body ?? "").trim().toUpperCase();
  const hit = (cfg.words || []).find((x) => x && x.word === w);
  if (!hit) return null;
  if (hit.tag) {
    await updateRecord("contact", contact.id, (c) => ((c.tags || []).some((t) => String(t).toLowerCase() === hit.tag.toLowerCase()) ? null : { ...c, tags: [...(c.tags || []), hit.tag].slice(0, 30) }), ctx)
      .catch((e) => { if (!(e instanceof ParallelRunGuard)) throw e; });
  }
  const consent = contact.consent && contact.consent.sms_marketing ? contact.consent.sms_marketing.state : "unknown";
  return { word: w, tag: hit.tag || null, task: hit.task !== false, ask_consent: w === "YES" && consent !== "granted" };
}

export async function handleInboundSms(params, ctx) {
  const from = String(params.From || "").trim();
  const sid = String(params.MessageSid || params.SmsSid || "").trim();
  if (!E164.test(from) || !/^[A-Za-z0-9]{10,64}$/.test(sid)) return { status: "invalid" };
  if (await readPointer("provider-msg", providerKey("twilio", sid))) return { status: "duplicate" };
  const wctx = HOOK(ctx);
  const body = String(params.Body ?? "").slice(0, 1600);
  const n = Math.min(10, Math.max(0, Number(params.NumMedia) || 0));
  const media = [];
  for (let i = 0; i < n; i++) if (/^https:\/\//.test(String(params[`MediaUrl${i}`] || ""))) media.push(String(params[`MediaUrl${i}`]).slice(0, 500));
  const kw = keywordOf(body);
  let who;
  let rec;
  try {
    who = await contactForNumber(from, wctx);
    rec = await recordMessage({
      contact: who.contact, channel: "sms", direction: "in", from, to: String(params.To || "").slice(0, 40), body_text: body, status: "received", provider: "twilio", provider_id: sid,
      origin: { kind: "inbound" }, related: {}, ...(media.length ? { media_pending: media.length, media_urls: media } : {}), ...(kw ? { keyword: kw.word } : {}),
    }, wctx);
  } catch (e) {
    if (!(e instanceof ParallelRunGuard)) throw e;
    // Rotor still owns this customer: the CRM only notes that a text came (§0 rule 12)
    await wouldAct({ key: "comms.inbound", subject: e.subject || (who && who.contact && who.contact.id) || null, action: "record-message" }).catch(() => {});
    return { status: "guarded" };
  }
  if (rec.duplicate) return { status: "duplicate" };
  const { message, conversation } = rec;
  const contact = who.contact;

  // keywords first: an opt-out must hold before anything else is sent
  const addrHk = hk("phone", from);
  if (kw && kw.kind === "stop") await setSuppression({ channel: "sms", address_hk: addrHk, state: "opted_out", source: "keyword", keyword: kw.word, masked: maskPhone(from), contact_id: contact.id, by: "system" });
  else if (kw && kw.kind === "start") await setSuppression({ channel: "sms", address_hk: addrHk, state: "active", source: "keyword", keyword: kw.word, masked: maskPhone(from), contact_id: contact.id, by: "system" });
  else if (kw && kw.kind === "help") {
    const sms = (await getSetting("integrations").catch(() => ({}))).sms || {};
    // one responder (§6.3): Twilio's Advanced Opt-Out answers HELP when it is on
    if (sms.advanced_opt_out === false) {
      await sendMessage({ contact_id: contact.id, channel: "sms", template_key: "help_reply", origin: { kind: "system", id: "help" }, category: "service", marker_key: `help-${keySafe(sid, 64)}` }, { ...wctx, deploy: ctx.deploy, sysMode: await ctx.sysMode() })
        .catch((e) => console.error(`crm:comms: the HELP answer was not sent (${safeErr(e)})`));
    }
  }
  const reply = kw ? null : await replyKeyword(body, contact, wctx).catch((e) => { console.error(`crm:comms: a reply keyword was not applied (${safeErr(e)})`); return null; });

  // the people to tell, then the event
  if (!kw || kw.kind !== "help") {
    const people = isId(conversation.assignee_id, "user") ? [conversation.assignee_id] : isId(contact.owner_id, "user") ? [contact.owner_id] : await approvers().catch(() => []);
    const first = String(contact.first_name || "").split(/\s+/)[0] || "Someone";
    const town = (contact.billing_address && contact.billing_address.city) || "";
    const title = kw && kw.kind === "stop" ? `${first} opted out of texts` : reply ? `${first} replied ${reply.word}` : `New text from ${first}${town ? ` (${town})` : ""}`;
    const note = reply && reply.ask_consent ? "They replied YES. Ask before you record marketing consent." : who.created ? "From a number that isn't on file." : who.shared ? "This number is on more than one contact." : "Open the inbox to read it.";
    await notify(people, { kind: "reply", title, body: note, link: `/inbox/${conversation.id}` }, wctx).catch((e) => console.error(`crm:comms: nobody was told about a text (${safeErr(e)})`));
  }
  await emit("message.inbound", { id: message.id, wv: 1, contact_id: contact.id, conversation_id: conversation.id, channel: "sms", ...(kw ? { keyword: kw.word } : reply ? { reply_keyword: reply.word } : {}) }, wctx)
    .catch((e) => console.error(`crm:comms: message.inbound was not emitted (${safeErr(e)})`));
  if (media.length) await enqueue("media.fetch", { type: "message", id: message.id }, {}, undefined, { ns: "done", scope: "media", key: message.id }, { data: { message_id: message.id } });
  return { status: "recorded", message_id: message.id, conversation_id: conversation.id, keyword: kw ? kw.word : null };
}

async function smsHook(ctx) {
  const params = await twilioRequest(ctx, SMS_HOOK);
  if (!params) return refuse(403);
  ctx.modeVal = await ctx.sysMode();
  const r = await handleInboundSms(params, ctx);
  return r.status === "invalid" ? refuse(400) : xml();
}

// Queue kind "media.fetch": the files of an MMS, after the webhook answered.
export async function fetchMedia(h) {
  const id = h.item.data && h.item.data.message_id;
  const got = isId(id, "message") ? await getRecord("message", id) : null;
  if (!got) return { result: "skipped:no_message" };
  const m = got.data;
  const urls = Array.isArray(m.media_urls) ? m.media_urls : [];
  if (!urls.length || !m.media_pending) return { result: "skipped:nothing" };
  const a = await adapter("sms", { deploy: (currentScope() || {}).deploy, mode: h.mode });
  if (!a.impl || typeof a.impl.fetchMedia !== "function") return { result: "skipped:not_connected" };
  const have = new Set(m.attachment_file_ids || []);
  let stored = 0;
  for (const [i, url] of urls.entries()) {
    const bytes = await a.impl.fetchMedia(url);
    if (!bytes) continue;
    const fid = newId("file");
    // anything outside JPEG/PNG/WebP/PDF (HTML, SVG...) is kept download-only (core/files.mjs)
    const f = await storeImportedFile({ bytes, owner: { type: "message", id: m.id }, kind: "attachment", contactId: m.contact_id, source: "mms", id: fid }, h.ctx.write());
    have.add(f.id);
    stored += 1;
    if (i >= 9) break;
  }
  await updateRecord("message", m.id, (x) => ({ ...x, attachment_file_ids: [...have].slice(0, 20), media_pending: 0 }), { ...h.ctx.write(), audit: false });
  return { result: `stored:${stored}` };
}

// ------------------------------------------------------------ status callbacks

const TWILIO_STATUS = { queued: "queued", accepted: "queued", scheduled: "queued", sending: "sending", sent: "sent", delivered: "delivered", read: "delivered", undelivered: "undelivered", failed: "failed" };

export async function handleStatus(params, ctx) {
  const sid = String(params.MessageSid || params.SmsSid || "").trim();
  const status = TWILIO_STATUS[String(params.MessageStatus || params.SmsStatus || "").toLowerCase()];
  if (!/^[A-Za-z0-9]{10,64}$/.test(sid) || !status) return { status: "ignored" };
  const code = String(params.ErrorCode || "").replace(/\D/g, "").slice(0, 8);
  const ptr = await readPointer("provider-msg", providerKey("twilio", sid));
  let changed = false;
  if (ptr && isId(ptr.id, "message")) {
    const r = await applyStatus(ptr.id, status, { error_code: code || undefined }, { ...HOOK(ctx), bulk: true })
      .catch((e) => { if (e instanceof ParallelRunGuard) return { changed: false }; throw e; });
    changed = r.changed;
  }
  // the carrier says this number unsubscribed (21610): the CRM stops texting it too
  const to = String(params.To || "").trim();
  if (code === "21610" && E164.test(to)) await setSuppression({ channel: "sms", address_hk: hk("phone", to), state: "opted_out", source: "carrier", masked: maskPhone(to), by: "system" });
  return { status: ptr ? "applied" : "unknown_message", changed };
}

async function statusHook(ctx) {
  // Twilio signs the address it was given, with its ?m= marker
  const m = ctx.query.get("m");
  const url = m !== null ? `${STATUS_HOOK}?m=${m}` : STATUS_HOOK;
  const params = await twilioRequest(ctx, url);
  if (!params) return refuse(403);
  ctx.modeVal = await ctx.sysMode();
  await handleStatus(params, ctx);
  return xml();
}

// ------------------------------------------------------------ Postmark

const sameToken = (a, b) => {
  const x = createHash("sha256").update(String(a)).digest();
  const y = createHash("sha256").update(String(b)).digest();
  return timingSafeEqual(x, y);
};

export async function handlePostmark(b, ctx) {
  const type = String((b && b.RecordType) || "");
  const id = String((b && b.MessageID) || "").trim();
  const wctx = { ...HOOK(ctx), by: "hook:postmark" };
  const ptr = id ? await readPointer("provider-msg", providerKey("postmark", id)) : null;
  const mid = ptr && isId(ptr.id, "message") ? ptr.id : null;
  const address = String((b && (b.Email || b.Recipient)) || "").trim().toLowerCase();
  const suppress = async (source) => {
    if (!/^[^\s@]+@[^\s@]+$/.test(address)) return;
    const msg = mid ? await getRecord("message", mid) : null;
    await setSuppression({ channel: "email", address_hk: hk("email", address), state: "opted_out", source, masked: maskEmail(address), by: "system", ...(msg ? { contact_id: msg.data.contact_id } : {}) });
  };
  const guarded = (e) => { if (e instanceof ParallelRunGuard) return { changed: false }; throw e; };
  if (type === "Delivery") { if (mid) await applyStatus(mid, "delivered", { at: b.DeliveredAt && !Number.isNaN(Date.parse(b.DeliveredAt)) ? new Date(b.DeliveredAt).toISOString() : undefined }, { ...wctx, bulk: true }).catch(guarded); return { status: "delivered" }; }
  if (type === "Bounce") {
    if (mid) await applyStatus(mid, "failed", { error_code: `bounce_${keySafe(String(b.Type || "bounce"), 24)}` }, { ...wctx, bulk: true }).catch(guarded);
    // a hard bounce: the address is no good; marketing stops, and the contact's email is marked
    if (String(b.Type || "") === "HardBounce") {
      await suppress("bounce");
      const msg = mid ? await getRecord("message", mid) : null;
      if (msg) await updateRecord("contact", msg.data.contact_id, (c) => {
        const emails = (c.emails || []).map((e) => (String(e.address).toLowerCase() === address && !e.invalid ? { ...e, invalid: true } : e));
        return JSON.stringify(emails) === JSON.stringify(c.emails || []) ? null : { ...c, emails };
      }, wctx).catch((e) => { if (!(e instanceof ParallelRunGuard)) console.error(`crm:comms: a bounced address was not marked (${safeErr(e)})`); });
    }
    return { status: "bounced" };
  }
  if (type === "SpamComplaint") { await suppress("complaint"); return { status: "complaint" }; }
  if (type === "SubscriptionChange") {
    if (b.SuppressSending === true) await suppress("unsubscribe");
    return { status: "subscription" };
  }
  return { status: "ignored" };
}

async function postmarkHook(ctx) {
  const want = String(process.env.POSTMARK_WEBHOOK_TOKEN || "").trim();
  const given = ctx.query.get("token") || "";
  if (!want || !given || !sameToken(given, want)) return refuse(403);
  if (!(await connected(ctx, "email"))) return refuse(403);
  ctx.modeVal = await ctx.sysMode();
  await handlePostmark(ctx.body || {}, ctx);
  return { data: { ok: true } };
}

const hook = (path, handler, more = {}) => ({ method: "POST", path, auth: "hook", perm: null, subject: "none", mode: "inline", idempotent: false, maxCalls: 90, handler, ...more });
export const hookRoutes = [
  hook("/hooks/twilio/sms", smsHook, { body: "raw", maxBody: 64 * 1024 }),
  hook("/hooks/twilio/status", statusHook, { body: "raw", maxBody: 16 * 1024 }),
  hook("/hooks/email/postmark", postmarkHook, { maxBody: 64 * 1024 }),
];
