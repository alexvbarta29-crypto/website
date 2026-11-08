// The office dashboard's numbers (docs/DASHBOARD.md). The repo is public, so
// the Rotor snapshot is committed ENCRYPTED: anyone can seal a new snapshot
// with the public key (build/office-dashboard-public.pem), and only the site's
// server can open it, with the private key in the OFFICE_DATA_KEY environment
// variable.
//
// X25519 + HKDF-SHA256 + AES-256-GCM: each snapshot gets a fresh throwaway key
// pair, agrees a secret with the office key, and encrypts with it. The private
// key is just 32 bytes (44 characters of base64), because Netlify gives all of
// a site's function environment variables 4KB in total (an AWS Lambda limit);
// a bigger key pushes the site over it and Netlify stops deploying.

import crypto from "node:crypto";
import SEALED from "../data/office-dashboard.sealed.mjs";

const INFO = Buffer.from("barta-office-dashboard v2");
// DER wrappers that turn a raw 32-byte X25519 key into a key Node can load.
const PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

const b64 = (buf) => Buffer.from(buf).toString("base64");
const rawPublic = (key) => key.export({ format: "der", type: "spki" }).subarray(-32);

function aesKey(shared, epk) {
  return Buffer.from(crypto.hkdfSync("sha256", shared, epk, INFO, 32));
}

export function seal(obj, publicKeyPem) {
  const recipient = crypto.createPublicKey(publicKeyPem);
  const eph = crypto.generateKeyPairSync("x25519");
  const epk = rawPublic(eph.publicKey);
  const key = aesKey(crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: recipient }), epk);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return { v: 2, epk: b64(epk), iv: b64(iv), tag: b64(c.getAuthTag()), data: b64(data) };
}

// privateKey: a Node KeyObject (see privateKey() below).
export function open(box, privateKey) {
  if (box.v !== 2) throw new Error("unsupported snapshot");
  const epk = Buffer.from(box.epk, "base64");
  const sender = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), epk]), format: "der", type: "spki" });
  const key = aesKey(crypto.diffieHellman({ privateKey, publicKey: sender }), epk);
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(box.iv, "base64"));
  d.setAuthTag(Buffer.from(box.tag, "base64"));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(box.data, "base64")), d.final()]).toString("utf8"));
}

// The private key from OFFICE_DATA_KEY: base64 of the raw 32 bytes.
// Returns null when unset, "bad" when it isn't a usable key (for example the
// old, much longer key).
export function privateKey(env = process.env) {
  const raw = String(env.OFFICE_DATA_KEY || "").trim();
  if (!raw) return null;
  const bytes = Buffer.from(raw, "base64");
  if (bytes.length !== 32) return "bad";
  try { return crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, bytes]), format: "der", type: "pkcs8" }); } catch { return "bad"; }
}

// A new key pair: { privateKey: 44-character base64 for OFFICE_DATA_KEY, publicKeyPem }.
export function newKeyPair() {
  const { publicKey, privateKey: priv } = crypto.generateKeyPairSync("x25519");
  return {
    privateKey: b64(priv.export({ format: "der", type: "pkcs8" }).subarray(-32)),
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }),
  };
}

// { ok: true, data } or { ok: false, reason: "no-key" | "no-data" | "bad-key" }.
export function loadDashboard(env = process.env, box = SEALED) {
  if (!box || !box.data) return { ok: false, reason: "no-data" };
  const key = privateKey(env);
  if (!key) return { ok: false, reason: "no-key" };
  if (key === "bad") return { ok: false, reason: "bad-key" };
  try { return { ok: true, data: open(box, key) }; } catch { return { ok: false, reason: "bad-key" }; }
}
