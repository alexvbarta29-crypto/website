// Barta CRM core: staff passwords (design §4.2).
//
// PBKDF2-SHA256, 600,000 iterations (OWASP 2023), a 16-byte random salt and
// a 32-byte key, computed with the async crypto.pbkdf2 (about 250 ms, at
// sign-in only). Stored on the user as
//   { alg: "pbkdf2-sha256", iter, salt /* base64 16 B */, hash /* base64 32 B */, set_at }
// and compared with timingSafeEqual. A hash made with fewer iterations than
// today's is upgraded at the next sign-in. Tests lower the cost with
// globalThis.__crmPbkdf2Iterations = 1000.
//
// An unknown login is checked against a fixed dummy hash, so a wrong login
// and a wrong password take the same time (§4.8 "No login oracle").

import { pbkdf2, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { InputError } from "./errors.mjs";
import { nowIso } from "./clock.mjs";

const pbkdf2Async = promisify(pbkdf2);

export const ALG = "pbkdf2-sha256";
export const ITERATIONS = 600000;
export const MIN_LENGTH = 10;
export const MAX_LENGTH = 128;

export const iterations = () => {
  const t = globalThis.__crmPbkdf2Iterations;
  return Number.isSafeInteger(t) && t > 0 ? t : ITERATIONS;
};

// Passwords nobody should use (a short built-in list; the length rule does most of the work).
const COMMON = new Set([
  "password", "password1", "password12", "password123", "password1234", "passw0rd123", "1234567890", "12345678910",
  "0123456789", "1111111111", "0000000000", "qwertyuiop", "qwerty1234", "qwerty12345", "iloveyou12", "letmein123",
  "welcome123", "welcome1234", "abc1234567", "abcdefghij", "baseball12", "football12", "monkey1234", "dragon1234",
  "sunshine12", "princess12", "trustno1234", "superman12", "starwars12", "changeme12", "barta12345", "bartabarta",
  "bartawindow", "windowwashing", "windows1234", "minnesota1", "minnesota12", "vikings1234", "1q2w3e4r5t", "zaq12wsxcde",
]);

// Throws InputError("…", "password") when a new password breaks a rule.
export function checkPolicy(password, { login = "", name = "" } = {}) {
  const pw = typeof password === "string" ? password : "";
  if (pw.length < MIN_LENGTH) throw new InputError(`Use at least ${MIN_LENGTH} characters.`, "password");
  if (pw.length > MAX_LENGTH) throw new InputError(`Use at most ${MAX_LENGTH} characters.`, "password");
  const low = pw.toLowerCase();
  const squashed = low.replace(/\s+/g, "");
  if (login && (low === String(login).toLowerCase() || squashed === String(login).toLowerCase())) throw new InputError("Your password can't be your login.", "password");
  if (name && squashed === String(name).toLowerCase().replace(/\s+/g, "")) throw new InputError("Your password can't be your name.", "password");
  if (COMMON.has(squashed) || /^(.)\1+$/.test(pw)) throw new InputError("That password is too easy to guess. Try a short sentence.", "password");
  return pw;
}

// How many PBKDF2 derivations this process ran (tests check that an
// unknown login costs one, like a real one).
export const stats = { derivations: 0 };

async function derive(password, salt, iter) {
  stats.derivations += 1;
  return pbkdf2Async(String(password).normalize("NFC"), salt, iter, 32, "sha256");
}

export async function hashPassword(password, at = nowIso()) {
  const salt = randomBytes(16);
  const iter = iterations();
  const hash = await derive(password, salt, iter);
  return { alg: ALG, iter, salt: salt.toString("base64"), hash: hash.toString("base64"), set_at: at };
}

// A fixed record to check unknown logins against (same cost, never matches
// anything a user can type: its hash is random per process).
let dummy = null;
function dummyRecord() {
  const iter = iterations();
  if (!dummy || dummy.iter !== iter) dummy = { alg: ALG, iter, salt: randomBytes(16).toString("base64"), hash: randomBytes(32).toString("base64") };
  return dummy;
}

// → { ok, upgrade } (upgrade: the stored hash uses fewer iterations than today's).
export async function verifyPassword(password, record) {
  const rec = record && record.alg === ALG ? record : dummyRecord();
  const isDummy = rec === dummy;
  let salt, want;
  try {
    salt = Buffer.from(String(rec.salt), "base64");
    want = Buffer.from(String(rec.hash), "base64");
  } catch {
    return { ok: false, upgrade: false };
  }
  const iter = Number.isSafeInteger(rec.iter) && rec.iter > 0 ? rec.iter : ITERATIONS;
  const got = await derive(typeof password === "string" ? password : "", salt.length ? salt : Buffer.alloc(16), iter);
  const match = want.length === got.length && timingSafeEqual(want, got);
  const ok = match && !isDummy && typeof password === "string" && password.length > 0;
  return { ok, upgrade: ok && iter < iterations() };
}

// Runs the dummy check (an unknown login), so timing matches a real one.
export async function dummyCheck(password) {
  await verifyPassword(password, null);
  return { ok: false, upgrade: false };
}
