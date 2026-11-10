#!/usr/bin/env node
// Makes a fresh VAPID key pair for the CRM's web push (design §5.7.7) and
// prints it, once, for the owner to paste into Netlify (Site configuration
// → Environment variables, Production context only):
//
//   node build/crm_vapid_keys.mjs
//   CRM_VAPID_PUBLIC  = <the 65-byte public key, base64url>
//   CRM_VAPID_PRIVATE = <the 32-byte private key, base64url>
//   CRM_VAPID_SUBJECT = mailto:office@bartawindowwashing.com
//
// Nothing is written to disk: the keys exist only in this terminal's
// output. Keep the private key in the password manager too; a new pair means
// every phone turns notifications on again (old subscriptions stop working).
import { generateKeyPairSync } from "node:crypto";
import { pathToFileURL } from "node:url";

const b64u = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64u = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");

export function vapidKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pub = publicKey.export({ format: "jwk" });
  const priv = privateKey.export({ format: "jwk" });
  return {
    publicKey: b64u(Buffer.concat([Buffer.from([4]), fromB64u(pub.x), fromB64u(pub.y)])),
    privateKey: priv.d,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const k = vapidKeys();
  process.stdout.write(`CRM_VAPID_PUBLIC=${k.publicKey}\nCRM_VAPID_PRIVATE=${k.privateKey}\nCRM_VAPID_SUBJECT=mailto:office@bartawindowwashing.com\n`);
  process.stdout.write("Paste these into Netlify (Production only), redeploy, then My account → Turn on for this phone. Never commit them.\n");
}
