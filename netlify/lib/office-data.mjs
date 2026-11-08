// The office dashboard's numbers (docs/DASHBOARD.md). The repo is public, so
// the Rotor snapshot is committed ENCRYPTED: anyone can seal a new snapshot
// with the public key (build/office-dashboard-public.pem), and only the site's
// server can open it, with the private key in the OFFICE_DATA_KEY environment
// variable (base64 of the PKCS#8 PEM). Hybrid: a fresh AES-256-GCM key per
// snapshot, wrapped with RSA-OAEP-SHA256.

import crypto from "node:crypto";
import SEALED from "../data/office-dashboard.sealed.mjs";

export function seal(obj, publicKeyPem) {
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  const wrapped = crypto.publicEncrypt({ key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);
  return { v: 1, key: wrapped.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") };
}

export function open(box, privateKeyPem) {
  const key = crypto.privateDecrypt({ key: privateKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(box.key, "base64"));
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(box.iv, "base64"));
  d.setAuthTag(Buffer.from(box.tag, "base64"));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(box.data, "base64")), d.final()]).toString("utf8"));
}

// The private key from the environment. Accepts the base64 of the PEM (one
// line, easiest to paste into Netlify) or the PEM itself.
export function privateKey(env = process.env) {
  const raw = String(env.OFFICE_DATA_KEY || "").trim();
  if (!raw) return "";
  return raw.includes("BEGIN") ? raw : Buffer.from(raw, "base64").toString("utf8");
}

// { ok: true, data } or { ok: false, reason: "no-key" | "no-data" | "bad-key" }.
export function loadDashboard(env = process.env, box = SEALED) {
  if (!box || !box.data) return { ok: false, reason: "no-data" };
  const pem = privateKey(env);
  if (!pem) return { ok: false, reason: "no-key" };
  try { return { ok: true, data: open(box, pem) }; } catch { return { ok: false, reason: "bad-key" }; }
}
