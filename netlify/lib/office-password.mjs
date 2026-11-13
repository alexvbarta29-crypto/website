// The one place the office password is checked (lights-auth.mjs keeps the
// digest). The office password opens the office tools (/office before the
// CRM's first owner, /lights, /playbook), makes the CRM's first owner
// (auto setup) and resets a CRM login (Forgot password), and the owner may
// pick a short one, so every check is throttled like sign-in
// (crm/core/throttle.mjs), BEFORE the PBKDF2 work:
//
// - the caller's own buckets: a form page uses the office password's bucket
//   per phone (a login nobody can have, so it lands in a hashed key);
//   Forgot password and setup keep theirs (the login typed, "setup");
// - the address's bucket, shared with sign-in;
// - the office password's global bucket (thr/office/), so guesses spread
//   over many addresses still add up.
//
// The compare stays constant-time (sha256 of the PBKDF2 key against the
// digest). A wrong password counts against every bucket; a right one writes
// the caller's ok marker. Throttled answers are the same everywhere: "Too
// many tries. Wait N seconds, then try again." with Retry-After.
//
// A page outside the CRM's API (officePasswordForm) opens the CRM's store
// scope for the check. When it can't (production without its settings, the
// storage down), the check fails closed: the password is not checked at all,
// never checked unthrottled. A browser that already holds the office cookie
// keeps it; only a new sign-in waits for the storage.

import { derive, sha256, same, expected } from "./lights-auth.mjs";
import { checkThrottle, recordFailure, recordSuccess } from "./crm/core/throttle.mjs";
import { deployContext } from "./crm/core/context.mjs";
import { deviceId } from "./crm/core/sessions.mjs";
import { clientIp } from "./crm/core/http.mjs";
import { withStoreScope, withBudget } from "./crm-store.mjs";
import { safeErr } from "./referral-lib.mjs";

export const MAX_LEN = 256;
export const OFFICE_LOGIN = "office password";
export const DOWN_TEXT = "Sign-in can't be checked right now. Try again in a few minutes.";

// "Too many tries. Wait 30 seconds, then try again."
export function tooManyText(retryAfterS) {
  const s = Math.max(1, Math.ceil(Number(retryAfterS) || 0));
  const wait = s >= 120 ? `${Math.ceil(s / 60)} minutes` : `${s} seconds`;
  return `Too many tries. Wait ${wait}, then try again.`;
}

// Constant-time: is this the office password? (Unthrottled: only for
// checkOfficePassword below.)
const isOfficePassword = (pw) => {
  const token = typeof pw === "string" && pw !== "" && pw.length <= MAX_LEN ? derive(pw) : "";
  return token ? { right: same(sha256(token), expected()), token } : { right: false, token: "" };
};

// The throttled check, inside the CRM's store scope. `who` is the caller's
// { login, device, ip }. With settle: false the caller records the outcome
// itself (Forgot password also fails a right password for a wrong login),
// with recordFailure({ ...who, office: true }).
// → { ok: true, token } | { ok: false, retry_after_s } (throttled) | { ok: false } (wrong)
// Throws when the store can't be read: callers fail closed.
export async function checkOfficePassword(pw, who, { settle = true } = {}) {
  const w = { ...who, office: true };
  const th = await checkThrottle(w);
  if (!th.ok) return { ok: false, retry_after_s: th.retry_after_s };
  const { right, token } = isOfficePassword(pw);
  if (right) {
    if (settle) await recordSuccess(w).catch(() => {});
    return { ok: true, token };
  }
  if (settle) {
    await recordFailure(w).catch((e) => console.error("office password: a failure wasn't counted (" + safeErr(e) + ")"));
  }
  return { ok: false };
}

// The buckets a form page's office password counts in.
export const officeWho = (req, context) => ({ login: OFFICE_LOGIN, device: deviceId(req), ip: clientIp(req, context) });

// For a form page (POST /office, /lights, /playbook): the throttled check in
// the CRM's store scope.
// → { ok: true, token } | { ok: false, status: 401 } | { ok: false, status: 429, retry_after_s }
//   | { ok: false, status: 503 } (the store can't be used: fail closed)
export async function officePasswordForm(req, context, pw, { requestId = "office-password" } = {}) {
  let r;
  try {
    const deploy = deployContext(req, context);
    if (deploy.setup_needed) throw new Error("the CRM needs its Production settings");
    r = await withStoreScope({ deploy, budget: withBudget(4000, 10), requestId }, () => checkOfficePassword(pw, officeWho(req, context)));
  } catch (e) {
    console.error("office password: the store can't be used, so the password isn't checked (" + safeErr(e) + ")");
    return { ok: false, status: 503 };
  }
  if (r.ok) return r;
  return r.retry_after_s ? { ok: false, status: 429, retry_after_s: r.retry_after_s } : { ok: false, status: 401 };
}
