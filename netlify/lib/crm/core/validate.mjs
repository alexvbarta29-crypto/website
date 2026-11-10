// Barta CRM core: small validators every module's defineType().validate uses
// (design §3.14 schema rules, §5 caps).
//
// Rules that matter across deploys (old and new code run side by side for
// up to 15 minutes after a push):
//   - validators keep unknown fields (shape() copies the input and only
//     replaces the fields it knows);
//   - an enum value this code doesn't know is kept as-is when it was already
//     stored (enumValue(..., { stored })), never rejected or reset.
// Every failure is an InputError with the dotted field path, which the API
// answers as 400 { code: "invalid", field }.

import { InputError } from "./errors.mjs";
import { isId } from "./ids.mjs";
import { isLocalDate, isLocalTime } from "./clock.mjs";

export const CAPS = Object.freeze({ str: 200, notes: 10000, array: 50, tags: 30, tag: 40 });

const blank = (v) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

export function str(v, { field, max = CAPS.str, required = false, trim = true } = {}) {
  if (blank(v)) { if (required) throw new InputError("This is required.", field); return ""; }
  if (typeof v !== "string" && typeof v !== "number") throw new InputError("This should be text.", field);
  const s = trim ? String(v).trim() : String(v);
  if (Array.from(s).length > max) throw new InputError(`Keep this under ${max} characters.`, field);
  return s;
}

export const notes = (v, opts = {}) => str(v, { max: CAPS.notes, trim: false, ...opts });

export function int(v, { field, min = -Number.MAX_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER, required = false } = {}) {
  if (blank(v)) { if (required) throw new InputError("This is required.", field); return undefined; }
  const n = typeof v === "string" && /^-?\d+$/.test(v.trim()) ? Number(v.trim()) : v;
  if (!Number.isSafeInteger(n)) throw new InputError("This should be a whole number.", field);
  if (n < min || n > max) throw new InputError(`This should be between ${min} and ${max}.`, field);
  return n;
}

export const cents = (v, opts = {}) => int(v, opts);

export function bool(v, { field } = {}) {
  if (v === undefined || v === null) return false;
  if (typeof v !== "boolean") throw new InputError("This should be yes or no.", field);
  return v;
}

// An enum: a known value, or (when `stored` says the value came from storage)
// an unknown one kept as it is.
export function enumValue(v, values, { field, required = false, stored = false } = {}) {
  if (blank(v)) { if (required) throw new InputError("This is required.", field); return undefined; }
  if (values.includes(v)) return v;
  if (stored && typeof v === "string") return v;
  throw new InputError("That isn't one of the choices.", field);
}

export function arr(v, each, { field, max = CAPS.array } = {}) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new InputError("This should be a list.", field);
  if (v.length > max) throw new InputError(`Keep this list under ${max} items.`, field);
  return v.map((x, i) => each(x, `${field}.${i}`));
}

const EMAIL_RE = /^[^\s@<>()[\],;:"]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/;
export function email(v, { field, required = false } = {}) {
  if (blank(v)) { if (required) throw new InputError("This is required.", field); return ""; }
  const s = String(v).trim().toLowerCase();
  if (s.length > 120 || !EMAIL_RE.test(s)) throw new InputError("That email doesn't look right.", field);
  return s;
}

// A US phone in E.164 ("+1XXXXXXXXXX") from the usual spellings.
export function phoneE164(v, { field, required = false } = {}) {
  if (blank(v)) { if (required) throw new InputError("This is required.", field); return ""; }
  let d = String(v).replace(/\D/g, "");
  if (d.length === 11 && d[0] === "1") d = d.slice(1);
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(d)) throw new InputError("That phone number doesn't look right.", field);
  return "+1" + d;
}

export function date(v, { field, required = false } = {}) {
  if (blank(v)) { if (required) throw new InputError("This is required.", field); return undefined; }
  if (!isLocalDate(v)) throw new InputError("Use a date like 2026-11-17.", field);
  return v;
}
export function time(v, { field, required = false } = {}) {
  if (blank(v)) { if (required) throw new InputError("This is required.", field); return undefined; }
  if (!isLocalTime(v)) throw new InputError("Use a time like 09:30.", field);
  return v;
}
export function isoTime(v, { field, required = false } = {}) {
  if (blank(v)) { if (required) throw new InputError("This is required.", field); return undefined; }
  if (typeof v !== "string" || Number.isNaN(Date.parse(v)) || !/^\d{4}-\d{2}-\d{2}T/.test(v)) throw new InputError("That isn't a time.", field);
  return new Date(v).toISOString();
}

export function id(v, type, { field, required = false } = {}) {
  if (blank(v)) { if (required) throw new InputError("This is required.", field); return undefined; }
  if (!isId(v, type)) throw new InputError("That id doesn't look right.", field);
  return v;
}

// Validates the fields a shape knows and keeps every other field as it was.
// shape = { field: (value, path) => cleaned }; an `undefined` result drops the field.
export function shape(input, fields, { field: base } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new InputError("Expected an object.", base);
  const out = { ...input };
  for (const [k, fn] of Object.entries(fields)) {
    const v = fn(input[k], base ? `${base}.${k}` : k);
    if (v === undefined) delete out[k]; else out[k] = v;
  }
  return out;
}

// Plain-object check used by settings validators.
export const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
