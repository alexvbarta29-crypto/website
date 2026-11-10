// The CRM never talks to Rotor (owner's rule, Nov 10 2026: Rotor stays
// exactly as it is and must not see the CRM). No CRM code may call Rotor's
// API or hold its key; the only Rotor mentions allowed in CRM code are
// plain links a person taps (app.getrotor.com) and Rotor ids carried in
// imported records. The website's own Rotor calls (the quote form, the
// referral program and the giveaway) are older than the CRM and stay
// exactly as they are; this test pins that list so a new caller can't
// slip in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const API = /api\.getrotor\.com|ROTOR_API_KEY|rotor-api-version|open-api\/(leads|customers|jobs|quotes)/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(mjs|js)$/.test(name)) out.push(p);
  }
  return out;
}
const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");

test("no CRM code calls Rotor's API or reads its key", () => {
  const files = [
    ...walk(path.join(ROOT, "netlify/lib/crm")),
    ...walk(path.join(ROOT, "crm-app")),
    ...readdirSync(path.join(ROOT, "netlify/functions")).filter((f) => /^crm/.test(f)).map((f) => path.join(ROOT, "netlify/functions", f)),
    path.join(ROOT, "netlify/lib/crm-store.mjs"),
  ];
  const hits = files.filter((f) => API.test(readFileSync(f, "utf8"))).map(rel);
  assert.deepEqual(hits, [], "CRM code must never call Rotor");
});

const WEBSITE_CALLERS = new Set([
  "netlify/functions/lead.mjs", "netlify/functions/referral.mjs",
  "netlify/lib/giveaway-config.mjs", "netlify/lib/giveaway-rotor.mjs",
  "netlify/lib/referral-config.mjs", "netlify/lib/referral-notify.mjs",
]);

test("the website's own Rotor callers are only the ones that predate the CRM", () => {
  const files = [...walk(path.join(ROOT, "netlify/functions")), ...walk(path.join(ROOT, "netlify/lib"))];
  const callers = files.filter((f) => /api\.getrotor\.com/.test(readFileSync(f, "utf8"))).map(rel);
  for (const f of callers) assert.ok(WEBSITE_CALLERS.has(f), `${f} calls Rotor: only the website's original lead, referral and giveaway code may`);
});
