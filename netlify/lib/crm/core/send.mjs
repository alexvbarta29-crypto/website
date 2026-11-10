// Barta CRM core: the sender, the one way anything texts or emails a
// customer (design §5.7.1 "Sending", §5.7.2, §7.3, §7.5, §0 rules 11-12).
//
// sendMessage({ contact_id, channel, template_key? | body, subject?, vars?,
//   related?, origin, category?, subject_ref?, marker_key?, to?, template? }, ctx)
//   → { status, blocked_reason?, outbox_id?, provider_id?, defer_until?,
//       send_at?, marker_key, mode, footer_appended?, segments? }
//
// In order:
//   1. paused (sys/mode): a person's send answers 409; automation skips. A
//      failed read of sys/mode (or of the suppression list) is never taken
//      as "not paused" ("not opted out"): it throws, so a person's send
//      answers 503 busy and a queued step retries with backoff;
//   2. the contact and its address (primary mobile with sms: true / primary
//      email) → blocked no_address;
//   3. the mode (adapters/index.mjs): dry-run unless the integration is
//      live; before cutover, automated sends to a contact that is not
//      sandboxed are always dry-run (the parallel-run guard, §5.7.4);
//   4. the suppression list (sup/{channel}/{hk}) → opted_out; consent for
//      the category (§5.7.2: marketing SMS needs "granted", service SMS and
//      marketing email only not "revoked") → no_consent; a contact's
//      automations_paused for automated and cadence origins →
//      paused_automations; test mode's allowlist → test_mode_recipient;
//   5. the template rendered at send time; a missing variable without a
//      fallback → missing_variable (B9);
//   6. quiet hours (§7.5, enforced here, not by callers): a queued step
//      (ctx.h, the queue handle) answers deferred and the queue moves the
//      SAME marker to the next allowed minute; a direct send is scheduled
//      as a "send.message" queue item;
//   7. the opt-out footer (D5): " Reply STOP to opt out." on the first SMS
//      to that phone from that sending number (stats.comms.first_sms) and
//      on every marketing SMS; templates never carry it;
//   8. the step's marker (§7.3): done-dry/ in dry-run, done/ when live; a
//      queued step's marker is the queue's. A direct send claims its own:
//      a retry with the same client id answers "already" only when that
//      marker is final; while it is held the retry answers 503 busy, and a
//      send that failed before reaching the provider hands its claim back
//      (failed, retry_at now) so the retry takes it over at once;
//   9. the duplicate guard: the same body to the same address within
//      cfg/messaging.duplicate_window_min (10) → duplicate;
//  10. dry-run: the dry-run adapter writes the outbox item, and that is
//      all: no message, no conversation, no stats, no activity.
//      live/test: sending → the provider → done/failed, then the stats part
//      comms (first_sms per number, last_contacted_at). The Message and
//      Conversation records and the inbox row are written by comms' sink
//      (M6), which wraps this function.
// A blocked send is recorded in the outbox (mode "blocked", with its
// reason), so the owner sees what didn't go out and why.
//
// Category "staff" is internal only: a text to a staff phone that an
// internal caller passes in msg.to, with no customer contact. Templates
// people make cannot be "staff" (core/templates.mjs), and a "staff" send
// that involves a customer contact is sent under the service rules
// (consent, quiet hours, the footer).

import { createHash, randomBytes } from "node:crypto";
import { getRecord, getSetting, getRaw, settledWrite, claimMarker, advanceMarker, updateStats, hk, currentScope } from "../../crm-store.mjs";
import { now, nowMs, nowIso, localDate, localTime, dowOfDate, isHoliday, nextAllowed, DEFAULT_CALENDAR } from "./clock.mjs";
import { isId } from "./ids.mjs";
import { InputError, ConflictError, NotFoundError, BlobsTransientError } from "./errors.mjs";
import { FINAL_STATES } from "./markers.mjs";
import { sandboxed } from "./context.mjs";
import { statsPart } from "./registry.mjs";
import { keySafe, smsSegments } from "./text.mjs";
import { getTemplateByKey, renderTemplate, varsFor, CATEGORIES } from "./templates.mjs";
import { recordOutbox } from "./outbox.mjs";
import { adapterSync } from "../adapters/index.mjs";
import { dryRun } from "../adapters/dry-run.mjs";
import { safeErr } from "../../referral-lib.mjs";

export const MAIN_NUMBER = "+17633143400";
export const DEFAULT_FOOTER = " Reply STOP to opt out.";
export const AUTOMATED = Object.freeze(new Set(["automation", "cadence", "campaign", "system"]));
export const ORIGINS = Object.freeze(["user", "automation", "cadence", "campaign", "system", "inbound", "import"]);
const DEFAULT_MODE = Object.freeze({ system_of_record: "rotor", paused: false });

const sha = (s) => createHash("sha256").update(String(s)).digest("hex");
const state = (c) => (c && typeof c === "object" ? c.state : undefined);

// ------------------------------------------------------------ pure rules

// The address a channel sends to: the primary mobile that takes texts, else
// any phone that does; the primary email, else the first.
export function addressOf(contact, channel) {
  if (!contact) return null;
  if (channel === "sms") {
    const phones = Array.isArray(contact.phones) ? contact.phones.filter((p) => p && p.e164 && p.sms !== false) : [];
    const p = phones.find((x) => x.primary && x.sms === true) || phones.find((x) => x.sms === true) || null;
    return p ? p.e164 : null;
  }
  const emails = Array.isArray(contact.emails) ? contact.emails.filter((e) => e && e.address) : [];
  const e = emails.find((x) => x.primary) || emails[0] || null;
  return e ? String(e.address).toLowerCase() : null;
}

// A contact's name as the Outbox shows it.
export const contactLabel = (c) => (c ? [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || c.company_name || c.display_name || null : null);

// Consent for a category (§5.7.2): "no_consent" or null.
export function consentBlock(channel, category, contact) {
  if (category === "staff") return null;
  const c = (contact && contact.consent) || {};
  if (contact && contact.flags && contact.flags.spam) return "no_consent";
  if (contact && contact.archived_reason === "do_not_contact") return "no_consent";
  if (channel === "sms") {
    if (category === "marketing") return state(c.sms_marketing) === "granted" ? null : "no_consent";
    return state(c.sms_service) === "revoked" ? "no_consent" : null;
  }
  if (category === "marketing") return state(c.email_marketing) === "revoked" ? "no_consent" : null;
  return null;
}

// The quiet-hours rule of a send (§7.5), or null when it may go any time.
export function quietRule(category, originKind, quiet = {}, calendar = DEFAULT_CALENDAR) {
  if (category === "personal" || category === "staff") return null;
  if (originKind === "cadence" && category !== "marketing") {
    const w = quiet.cadence || { from: "08:00", to: "20:00" };
    return { from: w.from, to: w.to, days: w.days, skipHolidays: !!w.skip_holidays, calendar };
  }
  if (category === "marketing") {
    const w = quiet.marketing || { from: "09:00", to: "20:00", days: [1, 2, 3, 4, 5, 6], skip_holidays: true };
    return { from: w.from, to: w.to, days: w.days || [1, 2, 3, 4, 5, 6], skipHolidays: w.skip_holidays !== false, calendar };
  }
  const w = quiet.service || { from: "08:00", to: "21:00" };
  return { from: w.from, to: w.to, days: w.days, skipHolidays: !!w.skip_holidays, calendar };
}

export function allowedNow(rule, t = now()) {
  if (!rule) return true;
  const date = localDate(t);
  const days = Array.isArray(rule.days) ? rule.days : [0, 1, 2, 3, 4, 5, 6];
  if (!days.includes(dowOfDate(date))) return false;
  if (rule.skipHolidays && isHoliday(date, rule.calendar || DEFAULT_CALENDAR)) return false;
  const hhmm = localTime(t);
  return hhmm >= rule.from && hhmm < rule.to;
}

// The number a text goes out from, and the one stats.comms.first_sms is
// keyed by (D5): the test number in test mode, else sms.from (the D1
// fallback number) when set, else the public number. The provider call
// gets exactly this value.
export function sendingNumber(integrations, mode) {
  const sms = (integrations && integrations.sms) || {};
  if (mode === "test" && sms.test_from) return sms.test_from;
  return sms.from || sms.number || MAIN_NUMBER;
}

// Whether the opt-out footer goes on this text (D5, §5.7.2).
export function needsFooter({ category, firstSms = {}, number, footer = {} }) {
  if (category === "staff") return false;
  if (category === "marketing" && footer.marketing !== false) return true;
  if (footer.first_per_number === false) return false;
  return !(firstSms && firstSms[number]);
}

// ------------------------------------------------------------ helpers

// sys/mode for this send. A failed read throws (BlobsTransientError → 503
// busy): a paused CRM must never look unpaused because storage blinked.
async function readModeOnce() {
  const g = await getRaw("sys/mode");
  return { ...DEFAULT_MODE, ...(g && g.data ? g.data : {}) };
}

const isFinalMarker = (m) => !!m && (FINAL_STATES.includes(m.state) || (m.state === "failed" && !m.retry_at));

const normOrigin = (o, ctx) => {
  const origin = o && typeof o === "object" ? { ...o } : { kind: typeof o === "string" ? o : "system" };
  if (!ORIGINS.includes(origin.kind)) throw new InputError("Unknown send origin.", "origin");
  if (origin.kind === "user" && !origin.user_id && ctx && isId(ctx.by, "user")) origin.user_id = ctx.by;
  return origin;
};

// The duplicate guard's marker: {ns}/dup/{to_hk}--{sha16 of the body}.
async function duplicateOf(ns, toHk, body, windowMin) {
  if (!windowMin) return { dup: false, key: null };
  const key = `${ns}/dup/${toHk}--${sha(body).slice(0, 16)}`;
  const got = await getRaw(key);
  const at = got && got.data ? Date.parse(got.data.at) : NaN;
  return { dup: Number.isFinite(at) && at + windowMin * 60000 > nowMs(), key, cur: got };
}
async function noteSent(dup) {
  if (!dup || !dup.key) return;
  const value = { at: nowIso() };
  await settledWrite(dup.key, value, dup.cur ? { onlyIfMatch: dup.cur.etag } : { onlyIfNew: true }).catch(() => {});
}

function writeCtxOf(ctx) {
  const scope = currentScope() || {};
  return { by: ctx.by || "system", origin: ctx.origin || "worker", actor_kind: ctx.actor_kind || "automation", requestId: ctx.requestId || scope.requestId, mode: ctx.mode };
}

// ------------------------------------------------------------ the sender

export async function sendMessage(msg, ctx = {}) {
  if (!msg || typeof msg !== "object") throw new InputError("Nothing to send.");
  const channel = msg.channel;
  if (!["sms", "email"].includes(channel)) throw new InputError("Pick text or email.", "channel");
  const origin = normOrigin(msg.origin, ctx);
  const automated = AUTOMATED.has(origin.kind);
  const h = ctx.h || null;
  const deploy = ctx.deploy || (currentScope() || {}).deploy || null;
  const sys = ctx.sysMode || (h && h.mode) || await readModeOnce();
  const wctx = writeCtxOf(ctx);

  if (sys.paused) {
    if (!automated && origin.kind === "user") throw new ConflictError("The CRM is paused after a restore. Nothing is sent until an owner resumes it.");
    return { status: "skipped", reason: "paused", mode: "off" };
  }

  const [messaging, integrations, company, calendar] = await Promise.all([
    getSetting("messaging").catch(() => ({})),
    getSetting("integrations").catch(() => ({})),
    getSetting("company").catch(() => ({})),
    getSetting("calendar").catch(() => DEFAULT_CALENDAR),
  ]);

  // the contact and the template
  let contact = null;
  if (msg.contact_id) {
    if (!isId(msg.contact_id, "contact")) throw new InputError("That isn't a contact.", "contact_id");
    const got = await getRecord("contact", msg.contact_id);
    contact = got ? got.data : null;
    if (contact && contact.merged_into && isId(contact.merged_into, "contact")) {
      const s = await getRecord("contact", contact.merged_into);
      if (s) contact = s.data;
    }
    if (!contact || contact.deleted_at) {
      if (origin.kind === "user") throw new NotFoundError("That contact isn't there anymore.");
      return { status: "skipped", reason: "no_contact", mode: "off" };
    }
  }
  let template = null;
  if (msg.template_key) {
    // internal callers may pass the version they tested (a bulk run's
    // test.template); POST /messages never forwards this field
    const snap = msg.template && typeof msg.template === "object" && msg.template.key === msg.template_key ? msg.template : null;
    template = snap || await getTemplateByKey(msg.template_key);
    if (template && template.channel !== channel) throw new InputError("That template is for the other channel.", "template_key");
  }
  let category = msg.category || (template && template.category) || "personal";
  if (!CATEGORIES.includes(category)) throw new InputError("Unknown category.", "category");
  // "staff" only for an internal text to a staff phone (msg.to, no customer
  // contact); anything that reaches a customer follows the service rules
  const staffSend = category === "staff" && typeof msg.to === "string" && !!msg.to && !contact;
  if (category === "staff" && !staffSend) category = "service";

  // mode (§3.10): the integration's; automated sends to a contact Rotor
  // still owns are dry-run until cutover, whatever the integration says
  let a = adapterSync(channel, { deploy, settings: integrations, mode: sys });
  if (a.mode === "off") return { status: "skipped", reason: "paused", mode: "off" };
  if (automated && sys.system_of_record !== "crm" && a.mode !== "dry_run" && !(contact && sandboxed(contact, contact))) {
    a = { kind: channel, mode: "dry_run", impl: dryRun[channel], guarded: true };
  }
  const ns = a.mode === "dry_run" ? "done-dry" : "done";
  if (h && h.marker && h.marker.ns !== ns) return { status: "skipped", reason: "mode_changed", mode: a.mode };

  const to = staffSend ? String(msg.to) : addressOf(contact, channel);
  const toHk = to ? (() => { try { return hk(channel === "sms" ? "phone" : "email", to); } catch { return null; } })() : null;

  // what would go out (rendered now, at send time)
  const sender = msg.sender || (origin.user_id ? await getRecord("user", origin.user_id).then((g) => g && g.data).catch(() => null) : null);
  const vars = varsFor({ contact, company, sender, extra: msg.vars });
  let rendered;
  if (template) rendered = renderTemplate(template, vars, { company });
  else if (typeof msg.body === "string" && msg.body.trim()) rendered = { text: msg.body.trim(), subject: msg.subject || "", missing: [] };
  else throw new InputError("Write a message or pick a template.", "body");
  const markerKey = h ? h.marker._key : null;

  const base = {
    kind: channel, to, to_hk: toHk || undefined, contact_id: contact ? contact.id : undefined, contact_label: contactLabel(contact) || undefined, related: msg.related || {},
    subject_ref: msg.subject_ref, origin, category, template_key: template ? template.key : undefined,
  };
  const blocked = async (reason) => {
    let outbox = null;
    try {
      outbox = await recordOutbox({ ...base, mode: "blocked", blocked_reason: reason, subject: channel === "email" ? rendered.subject : undefined, body: rendered.text, marker_key: markerKey || undefined, simulated: { status: "blocked", code: reason } }, wctx);
    } catch (e) {
      console.error(`crm:send: a blocked send was not recorded (${safeErr(e)})`);
    }
    return { status: "blocked", blocked_reason: reason, outbox_id: outbox ? outbox.id : null, mode: a.mode };
  };

  if (template === null && msg.template_key) return blocked("no_template");
  if (template && template.active === false) return blocked("template_inactive");
  if (!to || !toHk) return blocked("no_address");
  // suppression beats consent (§5.7.2); a failed read throws, never "not opted out"
  const sup = await getRaw(`sup/${channel}/${toHk}`);
  if (sup && sup.data && sup.data.state === "opted_out") return blocked("opted_out");
  const noConsent = consentBlock(channel, category, contact);
  if (noConsent) return blocked(noConsent);
  if ((origin.kind === "automation" || origin.kind === "cadence") && contact && contact.automations_paused && contact.automations_paused[channel]) return blocked("paused_automations");
  if (a.mode === "test") {
    const allow = ((integrations[channel] || {}).test_allowlist || []).map((x) => String(x).toLowerCase());
    if (!allow.includes(String(to).toLowerCase())) return blocked("test_mode_recipient");
  }
  if (rendered.missing.length) return blocked("missing_variable");

  // quiet hours: a queued step keeps its marker and waits; a direct send is scheduled
  // (a bulk run's test send goes to the staff test contact, now: no quiet hours)
  const rule = msg.test_send === true ? null : quietRule(category, origin.kind, messaging.quiet || {}, calendar || DEFAULT_CALENDAR);
  if (rule && !allowedNow(rule)) {
    let at;
    try { at = nextAllowed(now(), rule); } catch (e) {
      if (!(e instanceof RangeError)) throw e;
      return blocked("quiet_hours");     // a window with no allowed minute in three weeks (no days picked)
    }
    if (h) return { status: "deferred", defer_until: at.toISOString(), reason: "quiet_hours", mode: a.mode };
    const { enqueue } = await import("./queue.mjs");
    const key = msg.marker_key || `q-${randomBytes(8).toString("hex")}`;
    await enqueue("send.message", contact ? { type: "contact", id: contact.id } : null, {}, at, { ns, scope: "send", key: keySafe(key, 100) }, { data: { msg: { ...msg, origin } } });
    return { status: "scheduled", send_at: at.toISOString(), reason: "quiet_hours", mode: a.mode };
  }

  // the footer (D5): first text per sending number, every marketing text
  let text = rendered.text;
  let footerAppended = false;
  const number = channel === "sms" ? sendingNumber(integrations, a.mode) : null;
  if (channel === "sms") {
    let firstSms = {};
    if (contact) {
      const st = await getRecord("contact_stats", contact.id).catch(() => null);
      firstSms = (st && st.data && st.data.comms && st.data.comms.first_sms) || {};
    }
    const f = messaging.footer || {};
    if (needsFooter({ category, firstSms, number, footer: f })) {
      text = text.replace(/\s+$/, "") + (f.text || DEFAULT_FOOTER);
      footerAppended = true;
    }
  }

  // the step's marker (a retried request with the same client id finds it final)
  let marker = h ? h.marker : null;
  const advance = async (next) => { if (h) { marker = await h.advance(next); return marker; } marker = await advanceMarker(marker, next); return marker; };
  if (!h) {
    const key = keySafe(msg.marker_key || `m-${randomBytes(8).toString("hex")}`, 100);
    const claim = await claimMarker(ns, "send", key, { holder: wctx.requestId || "send", leaseMs: 60000 });
    if (!claim.ok) {
      const m = claim.marker;
      // "already" only for a step that finished; one still held (or being
      // settled) answers busy, so the client keeps the message and retries
      if (isFinalMarker(m)) return { status: "already", result: m.result || m.state, outbox_id: m.outbox_id || null, marker_key: m._key, mode: a.mode };
      throw new BlobsTransientError("This message is still being sent. Try again in a moment.");
    }
    marker = claim.marker;
  }
  try {
    return await deliver();
  } catch (e) {
    // a direct send that failed before the provider call hands its claim
    // back at once (failed, retry_at now): the client's retry takes it over
    if (!h && marker && marker.state === "claimed") {
      await advanceMarker(marker, { state: "failed", code: keySafe((e && (e.code || e.name)) || "error", 40), retry_at: nowIso() }).catch(() => {});
    }
    throw e;
  }

  async function deliver() {
    // the duplicate guard
    const window = Number.isFinite(messaging.duplicate_window_min) ? messaging.duplicate_window_min : 10;
    // (a bulk run's test send repeats on purpose: msg.test_send skips it)
    const dup = await duplicateOf(ns, toHk, `${channel}|${rendered.subject || ""}|${text}`, msg.test_send === true ? 0 : window);
    if (dup.dup) {
      const out = await blocked("duplicate");
      if (!h) await advance({ state: "done", result: "blocked:duplicate" }).catch(() => {});
      return out;
    }
    const segments = channel === "sms" ? smsSegments(text) : undefined;
    const outboxCtx = { ...base, marker_key: marker._key, footer_appended: channel === "sms" ? footerAppended : undefined, ctx: wctx };

    // marketing email: an unsubscribe link in the footer and List-Unsubscribe
    // with one-click POST (RFC 8058, §5.7.1). Dry-run shows where it goes
    // without making the link (a dry-run send writes nothing but the outbox).
    let html = rendered.html;
    const headers = { ...(msg.headers || {}) };
    if (channel === "email" && category === "marketing") {
      if (a.mode === "dry_run") {
        text += "\n\nUnsubscribe: https://www.bartawindowwashing.com/p/unsubscribe/…";
      } else {
        const { unsubscribeLink } = await import("../portal/core.mjs");
        const u = await unsubscribeLink({ contact_id: contact.id, channel: "email", address: to });
        text += `\n\nUnsubscribe: ${u.url}`;
        if (html) html = html.replace(/<\/body>/, `<p style="text-align:center;font-size:12px;color:#85858d;margin:16px 0 0"><a href="${u.url}" style="color:#85858d">Unsubscribe</a></p></body>`);
        headers["List-Unsubscribe"] = `<${u.one_click}>`;
        headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
      }
    }

    if (a.mode === "dry_run") {
      const res = channel === "sms"
        ? await a.impl.send({ to, body: text, from: number, outbox: outboxCtx })
        : await a.impl.send({ to, subject: rendered.subject, text, html, outbox: outboxCtx });
      if (!h) await advance({ state: "done", result: "dry_run", outbox_id: res.outbox_id });
      await noteSent(dup);
      return { status: "dry_run", simulated: res.status, outbox_id: res.outbox_id, marker_key: marker._key, mode: "dry_run", footer_appended: footerAppended, segments };
    }

    // test / live: the provider call, under `sending` (§7.3)
    const email = integrations.email || {};
    await advance({ state: "sending", provider: channel === "sms" ? "twilio" : (email.provider || "postmark"), to_hk: toHk, body_sha256: sha(text), at: nowIso(), metadata: { crm_marker: marker._key } });
    let res;
    try {
      res = channel === "sms"
        ? await a.impl.send({ to, body: text, from: number, markerKey: marker._key })
        : await a.impl.send({
          to, from: email.from || `${company.name || "Barta Window Washing"} <${company.email || "office@bartawindowwashing.com"}>`, replyTo: email.reply_to || company.email,
          subject: rendered.subject, text, html, stream: category === "marketing" ? "broadcast" : "outbound",
          headers, tag: template ? template.key : "message", metadata: { crm_marker: marker._key },
        });
    } catch (e) {
      // the call may or may not have happened: the marker stays `sending` and
      // its provider's settler decides (never re-sent blindly, §7.3)
      console.error(`crm:send: a ${channel} send is unclear (${safeErr(e)})`);
      return { status: "sending", marker_key: marker._key, mode: a.mode };
    }
    if (res.status === "failed" || res.status === "blocked") {
      await advance({ state: "failed", code: keySafe(res.error_code || res.status, 40) });
      return { status: "failed", error_code: res.error_code || null, marker_key: marker._key, mode: a.mode };
    }
    await advance({ state: "done", result: res.status || "sent", provider_ref: res.provider_id || null });
    await noteSent(dup);
    if (contact && statsPart("comms")) {
      await updateStats(contact.id, "comms", (p) => ({
        ...p, last_contacted_at: nowIso(),
        ...(channel === "sms" ? { first_sms: { ...(p.first_sms || {}), ...(p.first_sms && p.first_sms[number] ? {} : { [number]: nowIso() }) } } : {}),
      }), wctx).catch((e) => console.error(`crm:send: stats not updated (${safeErr(e)})`));
    }
    return { status: res.status || "sent", provider_id: res.provider_id || null, marker_key: marker._key, mode: a.mode, footer_appended: footerAppended, segments };
  }
}

// Queue kind "send.message": a person's send that waited for quiet hours to
// end (or for its send_at). It runs as the person who sent it.
export async function runQueuedSend(h) {
  const msg = h.item.data && h.item.data.msg;
  if (!msg) return { result: "skipped:empty" };
  const userId = msg.origin && msg.origin.user_id;
  const r = await sendMessage(msg, { h, by: userId || "system", origin: userId ? "api" : "worker", actor_kind: userId ? "user" : "automation", requestId: h.ctx.requestId });
  return resultForQueue(r);
}

// What a queue handler returns for a send result.
export function resultForQueue(r) {
  if (r.status === "deferred") return { defer: r.defer_until, reason: r.reason || "quiet_hours" };
  if (r.status === "dry_run") return { result: "dry_run" };
  if (r.status === "blocked") return { result: `skipped:${r.blocked_reason}` };
  if (r.status === "skipped") return { result: `skipped:${r.reason}` };
  if (r.status === "failed") return { result: `failed:${r.error_code || "provider"}` };
  if (r.status === "sending") return { result: "sending" };
  return { result: r.status || "sent", ...(r.provider_id ? { provider_ref: r.provider_id } : {}) };
}

// The core default of the messages.sink service (§11.3): a message a person
// composed (POST /messages) goes through the sender; in M1.3 that means
// the outbox. Comms (M6) replaces it with the sink that also writes the
// conversation.
export async function coreMessagesSink(message, ctx = {}) {
  const r = await sendMessage({ ...message, origin: message.origin || { kind: "user", user_id: ctx.by }, category: message.category || (message.template_key ? undefined : "personal") }, ctx);
  return { outbox_id: r.outbox_id || null, status: r.status, ...(r.blocked_reason ? { blocked_reason: r.blocked_reason } : {}), ...(r.send_at ? { send_at: r.send_at } : {}), mode: r.mode };
}
