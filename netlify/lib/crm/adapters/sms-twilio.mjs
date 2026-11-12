// Barta CRM: the Twilio SMS driver (design §6.3, §6.1, §7.3, D1).
//
// The same transport as the website's older referral texts (a form POST to
// the Messages resource with Basic auth), extended to return the SID and to
// find an ambiguous send again. Nothing here runs until an owner connects
// Twilio: the adapter layer hands this driver out only in "test" or "live"
// mode, on the production deploy, with TWILIO_ACCOUNT_SID and
// TWILIO_AUTH_TOKEN set (core/context.mjs sideEffectMode). On top of that
// gate the driver checks for itself, so a mistake elsewhere cannot text a
// customer:
//   - no secrets → failed "not_configured", and no request;
//   - test: only a number on cfg/integrations.sms.test_allowlist (staff
//     phones), and only from the separate test number (sms.test_from);
//   - live: refused while Rotor is the system of record (sys/mode).
//
// It only ever sends a message (POST …/Messages.json) or looks one up (GET
// …/Messages.json). It never buys, hosts or configures a number, never
// touches a Messaging Service and never registers a webhook: Rotor's
// provider owns the real texting number until the owner moves it (D1).
//
//   send({ to, body, from, markerKey }) → { status: "queued" | "sent" | "failed" | "blocked", provider_id?, error_code?, segments }
//   findSent({ to, since, bodySha256 }) → { provider_id, status } | null
//   verifySignature(url, params, signature, token) → boolean   (X-Twilio-Signature, HMAC-SHA1)

import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { getSetting, getRaw } from "../../crm-store.mjs";
import { CANONICAL_ORIGIN } from "../core/context.mjs";
import { smsSegments } from "../core/text.mjs";

export const TWILIO_API = "https://api.twilio.com/2010-04-01";
export const TWILIO_TIMEOUT_MS = 8000;
export const STATUS_HOOK = `${CANONICAL_ORIGIN}/api/crm/hooks/twilio/status`;
export const SMS_HOOK = `${CANONICAL_ORIGIN}/api/crm/hooks/twilio/sms`;
const E164 = /^\+1\d{10}$/;
const SID = /^AC[0-9a-f]{32}$/i;

const sha = (s) => createHash("sha256").update(String(s)).digest("hex");
// The marker a status callback names (?m=): a hash, so no key leaves the site.
export const markerHash = (markerKey) => sha(markerKey || "").slice(0, 32);

const creds = (env) => {
  const sid = String(env.TWILIO_ACCOUNT_SID || "").trim();
  const token = String(env.TWILIO_AUTH_TOKEN || "").trim();
  return SID.test(sid) && token ? { sid, token, auth: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64") } : null;
};

// X-Twilio-Signature (§6.3): base64(HMAC-SHA1(auth token, url + every POST
// parameter name and value, sorted by name)), compared in constant time.
export function signatureFor(url, params, token) {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return createHmac("sha1", token).update(Buffer.from(data, "utf8")).digest("base64");
}
export function verifySignature(url, params, signature, token) {
  if (!token || typeof signature !== "string" || !signature) return false;
  const a = Buffer.from(signatureFor(url, params, token));
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

const twilioStatus = (s) => (["queued", "accepted", "scheduled", "sending"].includes(s) ? "queued" : ["sent", "delivered", "received", "read"].includes(s) ? "sent" : "failed");

// mode: "test" | "live". env and fetch can be replaced in tests.
export function twilioDriver(mode, { env = process.env } = {}) {
  if (!["test", "live"].includes(mode)) throw new TypeError("twilio: test or live");
  const refuse = (code) => ({ status: "blocked", error_code: code, segments: 0 });

  async function gate(to, from) {
    const c = creds(env);
    if (!c) return { no: { status: "failed", error_code: "not_configured", segments: 0 } };
    if (!E164.test(String(to || ""))) return { no: { status: "failed", error_code: "bad_number", segments: 0 } };
    const cfg = (await getSetting("integrations")).sms || {};
    if (mode === "test") {
      const allow = (cfg.test_allowlist || []).map(String);
      if (!allow.includes(to)) return { no: refuse("test_mode_recipient") };
      if (!cfg.test_from || from !== cfg.test_from) return { no: refuse("test_number_missing") };
    } else {
      const sys = await getRaw("sys/mode");          // a failed read throws: never "live" by default
      if (!sys || !sys.data || sys.data.system_of_record !== "crm") return { no: refuse("rotor_in_charge") };
    }
    return { c };
  }

  return {
    async send({ to, body, from, markerKey } = {}) {
      const g = await gate(to, from);
      if (g.no) return g.no;
      const form = new URLSearchParams({ To: to, Body: String(body ?? "") });
      if (/^MG[0-9a-f]{32}$/i.test(String(from || ""))) form.set("MessagingServiceSid", from);
      else if (E164.test(String(from || ""))) form.set("From", from);
      else return { status: "failed", error_code: "no_sender", segments: 0 };
      form.set("StatusCallback", `${STATUS_HOOK}?m=${markerHash(markerKey)}`);
      const res = await fetch(`${TWILIO_API}/Accounts/${g.c.sid}/Messages.json`, {
        method: "POST", headers: { authorization: g.c.auth, "content-type": "application/x-www-form-urlencoded" }, body: form.toString(), signal: AbortSignal.timeout(TWILIO_TIMEOUT_MS),
      });
      let j = null;
      try { j = await res.json(); } catch { j = null; }
      const segments = smsSegments(body);
      if (!res.ok) return { status: "failed", error_code: String((j && j.code) || res.status), segments };
      return { status: twilioStatus(j && j.status), provider_id: (j && j.sid) || null, ...(j && j.error_code ? { error_code: String(j.error_code) } : {}), segments };
    },
    // An ambiguous send (§7.3): the message to that number since `since` whose body has this hash.
    async findSent({ to, since, bodySha256 } = {}) {
      const c = creds(env);
      if (!c || !E164.test(String(to || ""))) return null;
      const q = new URLSearchParams({ To: to, PageSize: "20" });
      if (since) q.set("DateSent>", String(since).slice(0, 10));
      const res = await fetch(`${TWILIO_API}/Accounts/${c.sid}/Messages.json?${q}`, { headers: { authorization: c.auth }, signal: AbortSignal.timeout(TWILIO_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`twilio lookup ${res.status}`);
      const j = await res.json();
      const hit = (j.messages || []).find((m) => m && m.direction !== "inbound" && sha(m.body || "") === bodySha256 && (!since || Date.parse(m.date_created || m.date_sent || 0) >= Date.parse(since) - 60000));
      return hit ? { provider_id: hit.sid, status: twilioStatus(hit.status) } : null;
    },
    // One MMS file (inbound media, §6.3): Basic auth, Twilio's media hosts only, ≤ max bytes.
    async fetchMedia(url, { max = 4000000 } = {}) {
      const c = creds(env);
      let u;
      try { u = new URL(url); } catch { return null; }
      if (!c || u.protocol !== "https:" || !/^(api|mms)\.twilio\.com$/.test(u.hostname)) return null;
      const res = await fetch(u.href, { headers: { authorization: c.auth }, signal: AbortSignal.timeout(TWILIO_TIMEOUT_MS) });
      if (!res.ok || Number(res.headers.get("content-length") || 0) > max) return null;
      const bytes = new Uint8Array(await res.arrayBuffer());
      return bytes.length && bytes.length <= max ? bytes : null;
    },
  };
}
