// Sets the office password without putting anything guessable in this public
// repo: seals sha256(PBKDF2(password)) to the office public key
// (build/office-dashboard-public.pem) into netlify/data/office-password.sealed.mjs.
// Only the site's server (OFFICE_DATA_KEY) can open it. OFFICE_PASSWORD in
// Netlify, when set, still wins.
//
//   OFFICE_NEW_PASSWORD='...' node build/office_password.mjs
//
// The password is read from the environment so it never lands in shell history
// as an argument; it is never printed.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { seal } from "../netlify/lib/office-data.mjs";
import { derive, sha256 } from "../netlify/lib/lights-auth.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export function sealedPasswordFile(pw, publicKeyPem) {
  if (String(pw).length < 6) throw new Error("the office password needs at least 6 characters");
  const box = seal({ check: sha256(derive(pw)), v: 1 }, publicKeyPem);
  return `// The office password's check, ENCRYPTED to the office key (netlify/lib/lights-auth.mjs).\n// Written by build/office_password.mjs; only the site's server can open it.\nexport default ${JSON.stringify(box)};\n`;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const pw = process.env.OFFICE_NEW_PASSWORD || "";
  if (!pw) { console.error("Set OFFICE_NEW_PASSWORD."); process.exit(2); }
  const pub = readFileSync(path.join(ROOT, "build/office-dashboard-public.pem"), "utf8");
  writeFileSync(path.join(ROOT, "netlify/data/office-password.sealed.mjs"), sealedPasswordFile(pw, pub));
  console.log("netlify/data/office-password.sealed.mjs written (sealed).");
}
