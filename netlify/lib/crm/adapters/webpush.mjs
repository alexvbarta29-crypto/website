// Barta CRM: the live web push driver (design §5.7.7, §6.1 "push").
//
// push({ subscription, payload, ttl }) → { status: "sent" | "gone" | "failed", code? }
//
// One POST to the subscription's push service (Apple, Google, Mozilla...)
// with the RFC 8291 aes128gcm body and the RFC 8292 VAPID header built by
// core/webpush.mjs, a 5-second timeout (§3.13), and nothing else: no
// retry here (the notification is already in the app; the queue retries a
// failed delivery). 404 or 410 means the phone unsubscribed: "gone", and
// the caller deletes push/{userId}/{hash}. Only endpoints on the known push
// services are ever called (isPushEndpoint), and the payload carries a
// title, a short body and a /office#crm link, never customer data beyond a
// first name and a town.

import { pushRequest, vapidFromEnv, isPushEndpoint } from "../core/webpush.mjs";

export const PUSH_TIMEOUT_MS = 5000;

export const webpushLive = Object.freeze({
  async push({ subscription, payload, ttl = 3600, env = process.env } = {}) {
    const vapid = vapidFromEnv(env);
    if (!vapid) return { status: "failed", code: "no_vapid" };
    if (!subscription || !isPushEndpoint(subscription.endpoint)) return { status: "gone", code: "bad_endpoint" };
    let req;
    try { req = pushRequest(subscription, payload, { vapid, ttl }); } catch { return { status: "gone", code: "bad_keys" }; }
    let res;
    try {
      res = await fetch(req.url, { method: "POST", headers: req.headers, body: req.body, signal: AbortSignal.timeout(PUSH_TIMEOUT_MS), redirect: "error" });
    } catch (e) {
      return { status: "failed", code: e && (e.name === "TimeoutError" || e.name === "AbortError") ? "timeout" : "network" };
    }
    try { await res.body?.cancel(); } catch { /* nothing to free */ }
    if (res.status === 404 || res.status === 410) return { status: "gone", code: String(res.status) };
    if (res.status >= 200 && res.status < 300) return { status: "sent" };
    return { status: "failed", code: String(res.status) };
  },
});
