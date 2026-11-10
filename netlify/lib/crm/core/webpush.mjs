// Barta CRM core: web push without a dependency (design §5.7.7, §0 rule 15).
//
// - Payload encryption: RFC 8291 (Message Encryption for Web Push) with the
//   RFC 8188 "aes128gcm" content coding: ECDH on P-256 between a fresh
//   application-server key and the subscription's p256dh key, HKDF-SHA256
//   keyed by the subscription's auth secret, AES-128-GCM, one record.
// - VAPID: RFC 8292. An ES256 JWT { aud: the push service's origin, exp
//   (at most 24 h ahead; 12 h here), sub: "mailto:..." } signed with the
//   CRM's VAPID private key (node:crypto, dsaEncoding "ieee-p1363"), sent
//   as `Authorization: vapid t=<jwt>, k=<public key>`.
//
// Keys live in Netlify (Production only): CRM_VAPID_PUBLIC (the 65-byte
// uncompressed P-256 point, base64url) and CRM_VAPID_PRIVATE (the 32-byte
// private scalar, base64url), CRM_VAPID_SUBJECT (mailto:...). Nothing here
// ever logs a key, an endpoint or a payload.

import { createECDH, createHmac, createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, sign, verify, randomBytes } from "node:crypto";
import { nowMs } from "./clock.mjs";

export const DEFAULT_SUBJECT = "mailto:office@bartawindowwashing.com";
export const RECORD_SIZE = 4096;
export const JWT_HOURS = 12;

export const b64u = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const fromB64u = (s) => Buffer.from(String(s || "").replace(/-/g, "+").replace(/_/g, "/"), "base64");

const hmac = (key, data) => createHmac("sha256", key).update(data).digest();
// HKDF-Expand for one block (L ≤ 32).
const expand = (prk, info, len) => hmac(prk, Buffer.concat([info, Buffer.from([1])])).subarray(0, len);

// Encrypts a payload for one subscription (RFC 8291 §3).
// keys: { p256dh, auth } (base64url, as the browser gives them).
// opts.salt (16 bytes) and opts.asPrivate (32 bytes) pin the random parts
// (the RFC 8291 Appendix A test vector); never set them in production.
// → { body: Buffer (header || ciphertext), asPublic: Buffer }
export function encryptPayload(keys, plaintext, { salt, asPrivate, recordSize = RECORD_SIZE } = {}) {
  const uaPublic = fromB64u(keys && keys.p256dh);
  const authSecret = fromB64u(keys && keys.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new TypeError("webpush: bad p256dh key");
  if (authSecret.length !== 16) throw new TypeError("webpush: bad auth secret");
  const data = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext ?? ""), "utf8");
  if (data.length > recordSize - 17 - 86) throw new TypeError("webpush: payload too large for one record");
  const ecdh = createECDH("prime256v1");
  if (asPrivate) ecdh.setPrivateKey(Buffer.from(asPrivate)); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const s = salt ? Buffer.from(salt) : randomBytes(16);
  if (s.length !== 16) throw new TypeError("webpush: salt must be 16 bytes");

  // IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" || 0x00 || ua_public || as_public, 32)
  const prkKey = hmac(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0", "utf8"), uaPublic, asPublic]);
  const ikm = expand(prkKey, keyInfo, 32);
  // PRK = HKDF-Extract(salt, IKM); CEK and NONCE from it (RFC 8188 §2.2, §2.3)
  const prk = hmac(s, ikm);
  const cek = expand(prk, Buffer.from("Content-Encoding: aes128gcm\0", "utf8"), 16);
  const nonce = expand(prk, Buffer.from("Content-Encoding: nonce\0", "utf8"), 12);

  // one record: plaintext || 0x02 (the last record's delimiter), no padding
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const ct = Buffer.concat([cipher.update(Buffer.concat([data, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(16 + 4 + 1);
  s.copy(header, 0);
  header.writeUInt32BE(recordSize, 16);
  header.writeUInt8(asPublic.length, 20);
  return { body: Buffer.concat([header, asPublic, ct]), asPublic };
}

// The user agent's side (tests and the round-trip check): decrypts a body
// with the subscription's private key and auth secret.
export function decryptPayload(body, { uaPrivate, auth }) {
  const buf = Buffer.from(body);
  const salt = buf.subarray(0, 16);
  const idlen = buf.readUInt8(20);
  const asPublic = buf.subarray(21, 21 + idlen);
  const ct = buf.subarray(21 + idlen);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(uaPrivate));
  const uaPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(asPublic);
  const authSecret = Buffer.from(auth);
  const prkKey = hmac(authSecret, ecdhSecret);
  const ikm = expand(prkKey, Buffer.concat([Buffer.from("WebPush: info\0", "utf8"), uaPublic, asPublic]), 32);
  const prk = hmac(salt, ikm);
  const cek = expand(prk, Buffer.from("Content-Encoding: aes128gcm\0", "utf8"), 16);
  const nonce = expand(prk, Buffer.from("Content-Encoding: nonce\0", "utf8"), 12);
  const d = createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end -= 1;
  if (plain[end] !== 2) throw new Error("webpush: bad record delimiter");
  return plain.subarray(0, end);
}

// ------------------------------------------------------------ VAPID (RFC 8292)

// A KeyObject for the VAPID private key from its base64url parts.
export function vapidKeyObjects({ publicKey, privateKey }) {
  const pub = fromB64u(publicKey);
  const d = fromB64u(privateKey);
  if (pub.length !== 65 || pub[0] !== 4) throw new TypeError("webpush: CRM_VAPID_PUBLIC is not a P-256 public key");
  if (d.length !== 32) throw new TypeError("webpush: CRM_VAPID_PRIVATE is not a P-256 private key");
  const jwk = { kty: "EC", crv: "P-256", x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) };
  return { privateKey: createPrivateKey({ key: { ...jwk, d: b64u(d) }, format: "jwk" }), publicKey: createPublicKey({ key: jwk, format: "jwk" }) };
}

// The push service's origin (the JWT audience) of an endpoint URL.
export const audienceOf = (endpoint) => new URL(endpoint).origin;

// An ES256 JWT for one push service. → "header.claims.signature"
export function vapidJwt({ audience, subject = DEFAULT_SUBJECT, publicKey, privateKey, expiresAt }) {
  const { privateKey: key } = vapidKeyObjects({ publicKey, privateKey });
  const exp = Math.floor((expiresAt ?? nowMs() + JWT_HOURS * 3600 * 1000) / 1000);
  const head = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const claims = b64u(JSON.stringify({ aud: audience, exp, sub: subject }));
  const sig = sign("sha256", Buffer.from(`${head}.${claims}`), { key, dsaEncoding: "ieee-p1363" });
  return `${head}.${claims}.${b64u(sig)}`;
}

// Checks an ES256 JWT against a public key (tests, and a self-check).
export function verifyVapidJwt(jwt, publicKey) {
  const [h, c, s] = String(jwt).split(".");
  if (!h || !c || !s) return false;
  const pub = fromB64u(publicKey);
  const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) }, format: "jwk" });
  return verify("sha256", Buffer.from(`${h}.${c}`), { key, dsaEncoding: "ieee-p1363" }, fromB64u(s));
}

// The VAPID keys from the environment, or null when they are not set.
export function vapidFromEnv(env = process.env) {
  if (!env.CRM_VAPID_PUBLIC || !env.CRM_VAPID_PRIVATE) return null;
  return { publicKey: env.CRM_VAPID_PUBLIC, privateKey: env.CRM_VAPID_PRIVATE, subject: env.CRM_VAPID_SUBJECT || DEFAULT_SUBJECT };
}

// Everything one push request needs: { url, headers, body }.
export function pushRequest(subscription, payload, { vapid, ttl = 3600, urgency = "normal", salt, asPrivate } = {}) {
  if (!vapid) throw new TypeError("webpush: no VAPID keys");
  const { body } = encryptPayload(subscription.keys, typeof payload === "string" ? payload : JSON.stringify(payload), { salt, asPrivate });
  const jwt = vapidJwt({ audience: audienceOf(subscription.endpoint), subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey });
  return {
    url: subscription.endpoint,
    headers: {
      Authorization: `vapid t=${jwt}, k=${vapid.publicKey}`,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(Math.max(0, Math.min(2419200, Math.floor(ttl)))),
      Urgency: urgency,
    },
    body,
  };
}

// Push services a subscription may point at (anything else is refused, so
// the worker never POSTs to an address someone typed in).
const PUSH_HOSTS = ["fcm.googleapis.com", "updates.push.services.mozilla.com", "push.services.mozilla.com", "web.push.apple.com"];
const PUSH_SUFFIXES = [".push.apple.com", ".notify.windows.com", ".googleapis.com"];
export function isPushEndpoint(endpoint) {
  let u;
  try { u = new URL(endpoint); } catch { return false; }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return false;
  const h = u.hostname.toLowerCase();
  return PUSH_HOSTS.includes(h) || PUSH_SUFFIXES.some((s) => h.endsWith(s));
}
