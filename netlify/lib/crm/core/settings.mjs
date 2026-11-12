// Barta CRM core: settings documents and the system mode (design §3.3
// "Settings documents", §4.12, §3.10 "Paused").
//
// Settings live at cfg/{name}; each document has exactly one permission
// (the registry refuses a definition without one) and is merged over its
// registered defaults on read (crm-store getSetting). This file defines the
// core documents (the system module registers them) and the helpers the
// /settings routes use:
//
//   readSettingFor(ctx, name)          → { data, etag, defaults, perm }   (403 without the document's permission)
//   saveSettingFor(ctx, name, value)   → { data, etag }                    (If-Match required; "new" before the first save)
//
// Saving `permissions` or `auth` (owner-only) moves sys/auth-epoch, so every
// warm instance re-reads them within seconds (core/sessions.mjs, auth.mjs
// loadPermissions), and is audited with a diff (crm-store putSetting).
//
// The system mode, sys/mode = { system_of_record: "rotor" | "crm", paused,
// cutover_n, cutover_at?, paused_at?, paused_by? }, is read once per request
// or worker pass (readSysMode) and changed by CAS (updateSysMode): pause and
// resume (Settings → Data, a restore), cutover and rollback (M8).

import { getRaw, settledWrite, getSettingWithEtag, putSetting, appendEvent, getRecord } from "../../crm-store.mjs";
import { getSettingsDef, allSettings } from "./registry.mjs";
import { InputError, ForbiddenError, NotFoundError, StaleError } from "./errors.mjs";
import { nowIso } from "./clock.mjs";
import { isPlainObject } from "./validate.mjs";
import { DEFAULT_HOURS, DEFAULT_CALENDAR, isLocalDate, isLocalTime } from "./clock.mjs";
import { bumpAuthEpoch } from "./sessions.mjs";
import { clearPermissionsCache } from "./auth.mjs";
import { has as hasService } from "./services.mjs";
import { isId } from "./ids.mjs";

const clone = (v) => JSON.parse(JSON.stringify(v));

// Every validator builds its output from the fields it knows (anything else
// is dropped), and a saved document is at most MAX_DOC_BYTES of JSON (a
// definition may allow more with maxBytes): cfg/company is read on every
// send and portal page.
export const MAX_DOC_BYTES = 16 * 1024;
const pick = (o, fields) => Object.fromEntries(fields.filter((f) => o[f] !== undefined).map((f) => [f, o[f]]));
const yesNo = (v, field) => {
  if (v === undefined) return v;
  if (typeof v !== "boolean") throw new InputError("Yes or no.", field);
  return v;
};

// ------------------------------------------------------------ validators

const obj = (v, field) => {
  if (v === undefined || v === null) return {};
  if (!isPlainObject(v)) throw new InputError("Expected a group of settings.", field);
  return { ...v };
};
const text = (v, field, max = 200) => {
  if (v === undefined || v === null) return v;
  if (typeof v !== "string" || v.length > max) throw new InputError(`Use text up to ${max} characters.`, field);
  return v.trim();
};
const num = (v, field, min, max) => {
  if (v === undefined) return v;
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) throw new InputError(`Use a number from ${min} to ${max}.`, field);
  return v;
};
const hhmm = (v, field) => {
  if (v === undefined) return v;
  if (!isLocalTime(v)) throw new InputError("Use a time like 08:00.", field);
  return v;
};
const days = (v, field) => {
  if (v === undefined) return v;
  if (!Array.isArray(v) || v.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new InputError("Pick days of the week.", field);
  // a window with no day would never open (nextAllowed finds no minute)
  if (!v.length) throw new InputError("Pick at least one day.", field);
  return [...new Set(v)].sort();
};

function validateCompany(v) {
  const o = pick(obj(v, "company"), ["name", "legal_name", "phone", "email", "website", "base"]);
  for (const f of ["name", "legal_name", "phone", "email", "website"]) o[f] = text(o[f], f, 120);
  if (o.base !== undefined) {
    const b = pick(obj(o.base, "base"), ["lat", "lng", "label"]);
    b.lat = num(b.lat, "base.lat", -90, 90);
    b.lng = num(b.lng, "base.lng", -180, 180);
    b.label = text(b.label, "base.label", 60);
    o.base = b;
  }
  return o;
}

function validateHours(v) {
  const o = pick(obj(v, "hours"), ["0", "1", "2", "3", "4", "5", "6"]);
  for (let d = 0; d <= 6; d++) {
    const k = String(d);
    if (o[k] === undefined || o[k] === null) continue;
    const span = o[k];
    if (!Array.isArray(span) || span.length !== 2 || !isLocalTime(span[0]) || !isLocalTime(span[1]) || span[0] >= span[1]) throw new InputError("Use an opening and a closing time, or closed.", k);
  }
  return o;
}

function validateCalendar(v) {
  const o = pick(obj(v, "calendar"), ["rules", "dates"]);
  if (o.rules !== undefined && (!Array.isArray(o.rules) || o.rules.some((r) => !["thanksgiving", "christmas"].includes(r)))) throw new InputError("Pick holidays from the list.", "rules");
  if (o.dates !== undefined) {
    if (!Array.isArray(o.dates) || o.dates.length > 100 || o.dates.some((d) => !isLocalDate(d))) throw new InputError("Use dates like 2026-12-24.", "dates");
    o.dates = [...new Set(o.dates)].sort();
  }
  return o;
}

function validateServiceArea(v) {
  const o = pick(obj(v, "service_area"), ["center", "radius_mi", "towns", "zips"]);
  if (o.center !== undefined) {
    const c = pick(obj(o.center, "center"), ["lat", "lng"]);
    c.lat = num(c.lat, "center.lat", -90, 90);
    c.lng = num(c.lng, "center.lng", -180, 180);
    o.center = c;
  }
  o.radius_mi = num(o.radius_mi, "radius_mi", 1, 200);
  if (o.towns !== undefined && (!Array.isArray(o.towns) || o.towns.length > 200 || o.towns.some((t) => typeof t !== "string" || t.length > 60))) throw new InputError("Expected a list of towns.", "towns");
  if (o.zips !== undefined && (!Array.isArray(o.zips) || o.zips.length > 200 || o.zips.some((z) => !/^\d{5}$/.test(String(z))))) throw new InputError("Use 5-digit ZIP codes.", "zips");
  return o;
}

function validateWindow(w, field, { withDays = false } = {}) {
  const o = pick(obj(w, field), ["from", "to", "days", "skip_holidays"]);
  o.from = hhmm(o.from, `${field}.from`);
  o.to = hhmm(o.to, `${field}.to`);
  if (o.from && o.to && o.from >= o.to) throw new InputError("The window must end after it starts.", field);
  if (withDays) o.days = days(o.days, `${field}.days`);
  else delete o.days;
  o.skip_holidays = yesNo(o.skip_holidays, `${field}.skip_holidays`);
  return o;
}

function validateMessaging(v) {
  const o = pick(obj(v, "messaging"), ["quiet", "footer", "bulk_threshold", "duplicate_window_min", "campaign_gap_days", "inbound_first_only"]);
  if (o.quiet !== undefined) {
    const q = pick(obj(o.quiet, "quiet"), ["service", "cadence", "marketing", "personal_warn_after"]);
    for (const k of ["service", "cadence", "marketing"]) if (q[k] !== undefined) q[k] = validateWindow(q[k], `quiet.${k}`, { withDays: true });
    q.personal_warn_after = hhmm(q.personal_warn_after, "quiet.personal_warn_after");
    o.quiet = q;
  }
  if (o.footer !== undefined) {
    const f = pick(obj(o.footer, "footer"), ["text", "first_per_number", "marketing"]);
    f.text = text(f.text, "footer.text", 80);
    if (f.text !== undefined && !/stop/i.test(f.text)) throw new InputError("The footer has to tell people how to stop texts.", "footer.text");
    for (const k of ["first_per_number", "marketing"]) f[k] = yesNo(f[k], `footer.${k}`);
    o.footer = f;
  }
  o.bulk_threshold = num(o.bulk_threshold, "bulk_threshold", 1, 100);
  o.duplicate_window_min = num(o.duplicate_window_min, "duplicate_window_min", 0, 1440);
  o.campaign_gap_days = num(o.campaign_gap_days, "campaign_gap_days", 0, 60);
  o.inbound_first_only = yesNo(o.inbound_first_only, "inbound_first_only");
  return o;
}

// The test contact must also be flagged test (checked with the record on
// save, saveSettingFor), §5.7.5.
function validateMessagingTest(v) {
  const o = pick(obj(v, "messaging_test"), ["contact_id"]);
  if (o.contact_id !== undefined && o.contact_id !== null && !isId(o.contact_id, "contact")) throw new InputError("Pick the test contact.", "contact_id");
  return o;
}

// The fields of one automation's settings (cfg/automations.{key}), the
// same checks for PUT /settings/automations and PATCH /automations/:key.
export function cleanAutomationSettings(body = {}) {
  if (!isPlainObject(body)) throw new InputError("Expected the automation's settings.");
  const out = {};
  if (body.enabled !== undefined) { if (typeof body.enabled !== "boolean") throw new InputError("On or off.", "enabled"); out.enabled = body.enabled; }
  if (body.channels !== undefined) {
    if (!Array.isArray(body.channels) || !body.channels.length || body.channels.some((c) => !["sms", "email"].includes(c))) throw new InputError("Pick text, email or both.", "channels");
    out.channels = [...new Set(body.channels)];
  }
  if (body.template_keys !== undefined) {
    if (!Array.isArray(body.template_keys) || body.template_keys.length > 6 || body.template_keys.some((k) => !/^[a-z][a-z0-9_]{1,39}$/.test(String(k)))) throw new InputError("Pick templates from the library.", "template_keys");
    out.template_keys = body.template_keys;
  }
  if (body.delay !== undefined) {
    if (!Number.isInteger(body.delay) || body.delay < 0 || body.delay > 60 * 24 * 30) throw new InputError("Use minutes, up to 30 days.", "delay");
    out.delay = body.delay;
  }
  if (body.at_local !== undefined) { if (body.at_local !== null && !isLocalTime(body.at_local)) throw new InputError("Use a time like 10:00.", "at_local"); out.at_local = body.at_local; }
  if (body.max_per_contact_days !== undefined) {
    if (body.max_per_contact_days !== null && !(Number.isInteger(body.max_per_contact_days) && body.max_per_contact_days >= 0 && body.max_per_contact_days <= 3650)) throw new InputError("Use a number of days.", "max_per_contact_days");
    out.max_per_contact_days = body.max_per_contact_days;
  }
  if (body.sender_user_id !== undefined) { if (body.sender_user_id !== null && !isId(body.sender_user_id, "user")) throw new InputError("Pick someone on the team.", "sender_user_id"); out.sender_user_id = body.sender_user_id; }
  if (body.effective_from !== undefined) {
    if (body.effective_from !== null && !Number.isFinite(Date.parse(body.effective_from))) throw new InputError("Use a date and time.", "effective_from");
    out.effective_from = body.effective_from === null ? null : new Date(Date.parse(body.effective_from)).toISOString();
  }
  return out;
}

const AUTOMATION_KEY_RE = /^[a-z][a-z0-9_]*\.[a-z0-9_.]{1,60}$/;
function validateAutomations(v) {
  const src = obj(v, "automations");
  const o = {};
  if (src.effective_from !== undefined && src.effective_from !== null && !(typeof src.effective_from === "string" && Number.isFinite(Date.parse(src.effective_from)))) throw new InputError("Use a date and time.", "effective_from");
  if (src.effective_from !== undefined) o.effective_from = src.effective_from;
  o.paused = yesNo(src.paused, "paused");
  if (o.paused === undefined) delete o.paused;
  // one object per automation key, with the same field checks as PATCH /automations/:key
  for (const [k, a] of Object.entries(src)) {
    if (!k.includes(".") || a === undefined) continue;
    if (!AUTOMATION_KEY_RE.test(k)) throw new InputError("That isn't an automation.", k);
    if (!isPlainObject(a)) throw new InputError("Expected the automation's settings.", k);
    try { o[k] = cleanAutomationSettings(a); } catch (e) { if (e instanceof InputError) e.field = `${k}.${e.field || ""}`.replace(/\.$/, ""); throw e; }
  }
  return o;
}

export const INTEGRATION_MODES = Object.freeze(["off", "dry_run", "test", "live"]);
const INTEGRATIONS = ["sms", "email", "payments", "maps", "reviews", "meta", "push"];
const E164 = /^\+1[2-9]\d{2}[2-9]\d{6}$/;
const INTEGRATION_FIELDS = {
  sms: ["mode", "number", "from", "test_from", "advanced_opt_out", "test_allowlist"],
  email: ["mode", "provider", "from", "reply_to", "test_allowlist"],
};
function validateIntegrations(v) {
  const o = pick(obj(v, "integrations"), INTEGRATIONS);
  for (const k of INTEGRATIONS) {
    if (o[k] === undefined) continue;
    const i = pick(obj(o[k], k), INTEGRATION_FIELDS[k] || ["mode"]);
    if (i.mode !== undefined && !INTEGRATION_MODES.includes(i.mode)) throw new InputError("Pick off, dry run, test or live.", `${k}.mode`);
    if (i.test_allowlist !== undefined) {
      if (!Array.isArray(i.test_allowlist) || i.test_allowlist.length > 20) throw new InputError("Up to 20 test addresses.", `${k}.test_allowlist`);
      i.test_allowlist = i.test_allowlist.map((x, n) => {
        const t = String(x || "").trim().toLowerCase();
        if (k === "sms" ? !E164.test(t) : !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(t)) throw new InputError(k === "sms" ? "Use +1 and 10 digits." : "Use an email address.", `${k}.test_allowlist.${n}`);
        return t;
      });
    }
    // the number a text goes out from is the one the footer rule counts by (D5): each must be a real number
    for (const f of ["number", "from", "test_from"]) {
      if (k === "sms" && i[f] !== undefined && i[f] !== null && i[f] !== "" && !E164.test(String(i[f]))) throw new InputError("Use +1 and 10 digits.", `sms.${f}`);
      if (k === "sms" && i[f] === "") i[f] = null;
    }
    if (k === "sms") i.advanced_opt_out = yesNo(i.advanced_opt_out, "sms.advanced_opt_out");
    if (k === "email") {
      i.provider = text(i.provider, "email.provider", 30);
      i.from = text(i.from, "email.from", 160);
      i.reply_to = text(i.reply_to, "email.reply_to", 120);
    }
    o[k] = i;
  }
  return o;
}

function validatePortal(v) {
  const o = pick(obj(v, "portal"), ["lifetimes", "terms", "max_opens_per_day"]);
  if (o.lifetimes !== undefined) {
    const l = pick(obj(o.lifetimes, "lifetimes"), ["quote_after_expiry_days", "quote_after_conversion_days", "invoice_after_paid_days", "agreement_days", "card_days", "hub_days", "present_minutes"]);
    for (const [k, max] of [["quote_after_expiry_days", 365], ["quote_after_conversion_days", 365], ["invoice_after_paid_days", 730], ["agreement_days", 365], ["card_days", 60], ["hub_days", 365], ["present_minutes", 240]]) {
      if (l[k] !== undefined && !(Number.isInteger(l[k]) && l[k] >= 1 && l[k] <= max)) throw new InputError(`Use a whole number from 1 to ${max}.`, `lifetimes.${k}`);
    }
    o.lifetimes = l;
  }
  o.terms = text(o.terms, "terms", 20000);
  o.max_opens_per_day = num(o.max_opens_per_day, "max_opens_per_day", 10, 10000);
  return o;
}

function validateComms(v) {
  const o = pick(obj(v, "comms"), ["reply_keywords"]);
  if (o.reply_keywords !== undefined) {
    const r = pick(obj(o.reply_keywords, "reply_keywords"), ["enabled", "words"]);
    if (r.enabled !== undefined && typeof r.enabled !== "boolean") throw new InputError("On or off.", "reply_keywords.enabled");
    if (r.words !== undefined) {
      if (!Array.isArray(r.words) || r.words.length > 20) throw new InputError("Up to 20 keywords.", "reply_keywords.words");
      const reserved = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "OPTOUT", "REVOKE", "START", "UNSTOP", "HELP", "INFO"]);
      r.words = r.words.map((w, n) => {
        const x = pick(obj(w, `reply_keywords.words.${n}`), ["word", "tag", "task"]);
        x.word = String(x.word || "").trim().toUpperCase();
        if (!/^[A-Z0-9]{1,20}$/.test(x.word)) throw new InputError("One word, letters and digits.", `reply_keywords.words.${n}.word`);
        if (reserved.has(x.word)) throw new InputError("STOP, START and HELP words always do what they say.", `reply_keywords.words.${n}.word`);
        x.tag = text(x.tag, `reply_keywords.words.${n}.tag`, 40);
        if (x.task !== undefined && typeof x.task !== "boolean") throw new InputError("Yes or no.", `reply_keywords.words.${n}.task`);
        return x;
      });
    }
    o.reply_keywords = r;
  }
  return o;
}

export const INTAKE_MODES = Object.freeze(["rotor", "dual", "crm"]);
// Lead webhook tokens (§6.7, M2a): kept only as a sha256 hash, shown once when made.
export const MAX_WEBHOOK_TOKENS = 10;
function validateWebhookTokens(list) {
  if (list === undefined) return undefined;
  if (!Array.isArray(list) || list.length > MAX_WEBHOOK_TOKENS) throw new InputError(`Keep it to ${MAX_WEBHOOK_TOKENS} webhook links.`, "webhook_tokens");
  return list.map((t, i) => {
    const f = `webhook_tokens.${i}`;
    if (!isPlainObject(t) || typeof t.hash !== "string" || !/^[0-9a-f]{64}$/.test(t.hash) || typeof t.id !== "string" || !/^[a-z0-9]{6,20}$/.test(t.id)) throw new InputError("That webhook link isn't valid.", f);
    return { id: t.id, hash: t.hash, label: text(t.label, `${f}.label`, 60) || "Webhook", source: text(t.source, `${f}.source`, 60) || "Meta Ads", created_at: text(t.created_at, `${f}.created_at`, 40) || null, created_by: text(t.created_by, `${f}.created_by`, 80) || null };
  });
}
function validateIntake(v) {
  const o = pick(obj(v, "intake"), ["mode", "webhook_tokens"]);
  if (o.mode !== undefined && !INTAKE_MODES.includes(o.mode)) throw new InputError("Pick Rotor, both, or the CRM.", "mode");
  // "dual" and "crm" need the contacts module's intake (M2a): a feature gate, not a broken switch (§11.3)
  if (o.mode && o.mode !== "rotor" && !hasService("contacts.intake")) throw new InputError("Sending website leads to the CRM arrives with Contacts.", "mode");
  o.webhook_tokens = validateWebhookTokens(o.webhook_tokens);
  if (o.webhook_tokens === undefined) delete o.webhook_tokens;
  return o;
}

function validateNumbering(v) {
  const src = obj(v, "numbering");
  const o = {};
  for (const [k, f0] of Object.entries(src)) {
    if (!/^[a-z][a-z0-9_-]{1,30}$/.test(k)) throw new InputError("That isn't a numbered document.", k);
    if (!isPlainObject(f0)) throw new InputError("Expected a number format.", k);
    const f = pick(f0, ["prefix", "pad"]);
    o[k] = f;
    if (f.prefix !== undefined && !(typeof f.prefix === "string" && /^[A-Z]{0,6}-?$/.test(f.prefix))) throw new InputError("Use a short capital-letter prefix like INV-.", `${k}.prefix`);
    if (f.pad !== undefined && !(Number.isInteger(f.pad) && f.pad >= 0 && f.pad <= 9)) throw new InputError("Use 0 to 9 digits.", `${k}.pad`);
  }
  return o;
}

function validateStorage(v) {
  const o = pick(obj(v, "storage"), ["backend"]);
  if (o.backend !== undefined && !["blobs", "postgres"].includes(o.backend)) throw new InputError("Pick blobs or postgres.", "backend");
  return o;
}

// The core documents (§3.3, §4.12). Values are the business's public facts
// (the website shows them) and safe defaults; nothing private.
export const CORE_SETTINGS = Object.freeze({
  company: {
    perm: "settings:general",
    defaults: {
      name: "Barta Window Washing", legal_name: "Barta Window Washing LLC", phone: "(763) 314-3400",
      email: "office@bartawindowwashing.com", website: "https://www.bartawindowwashing.com",
      base: { label: "Delano shop", lat: 45.0419, lng: -93.7891 },
    },
    validate: validateCompany,
  },
  hours: { perm: "settings:general", defaults: { ...DEFAULT_HOURS }, validate: validateHours },
  calendar: { perm: "settings:general", defaults: clone(DEFAULT_CALENDAR), validate: validateCalendar },
  service_area: { perm: "settings:general", defaults: { center: { lat: 45.0419, lng: -93.7891 }, radius_mi: 20, towns: [], zips: [] }, validate: validateServiceArea },
  messaging: {
    perm: "settings:messaging",
    defaults: {
      quiet: {
        service: { from: "08:00", to: "21:00" },
        cadence: { from: "08:00", to: "20:00" },
        marketing: { from: "09:00", to: "20:00", days: [1, 2, 3, 4, 5, 6], skip_holidays: true },
        personal_warn_after: "21:00",
      },
      footer: { text: " Reply STOP to opt out.", first_per_number: true, marketing: true },
      bulk_threshold: 5, duplicate_window_min: 10, campaign_gap_days: 3, inbound_first_only: false,
    },
    validate: validateMessaging,
  },
  messaging_test: { perm: "settings:owner", defaults: { contact_id: null }, validate: validateMessagingTest },
  automations: { perm: "automations:configure", defaults: { effective_from: null, paused: false }, validate: validateAutomations },
  integrations: {
    perm: "settings:owner",
    // push reaches staff phones only, so it may be live once the VAPID keys exist (§5.7.7); the rest stay dry-run until the owner connects them (§11.1 rule 7)
    defaults: {
      sms: { mode: "dry_run", number: "+17633143400", from: null, test_from: null, advanced_opt_out: true, test_allowlist: [] },
      email: { mode: "dry_run", provider: "postmark", from: "Barta Window Washing <office@bartawindowwashing.com>", reply_to: "office@bartawindowwashing.com", test_allowlist: [] },
      payments: { mode: "dry_run" }, maps: { mode: "dry_run" }, reviews: { mode: "dry_run" }, meta: { mode: "dry_run" }, push: { mode: "live" },
    },
    validate: validateIntegrations,
  },
  portal: {
    perm: "settings:owner",
    defaults: {
      lifetimes: { quote_after_expiry_days: 30, quote_after_conversion_days: 90, invoice_after_paid_days: 90, agreement_days: 30, card_days: 7, hub_days: 30, present_minutes: 15 },
      terms: "", max_opens_per_day: 200,
    },
    validate: validatePortal,
    maxBytes: 64 * 1024,     // the terms (up to 20,000 characters)
  },
  comms: {
    perm: "settings:messaging",
    // D23: off until the owner names the routing; STOP/START/HELP always work
    defaults: { reply_keywords: { enabled: false, words: [{ word: "YES", tag: "Replied YES", task: true }, { word: "WINDOWS", tag: "Wants windows", task: true }, { word: "LIGHTS", tag: "Wants lights", task: true }] } },
    validate: validateComms,
  },
  intake: { perm: "settings:owner", defaults: { mode: "rotor", webhook_tokens: [] }, validate: validateIntake },
  numbering: {
    perm: "settings:owner",
    defaults: {
      job: { prefix: "", pad: 7 }, invoice: { prefix: "INV-", pad: 4 }, deposit: { prefix: "D-", pad: 4 }, quote: { prefix: "Q-", pad: 0 },
      "job-shadow": { prefix: "S-", pad: 6 }, "invoice-shadow": { prefix: "SINV-", pad: 4 }, "quote-shadow": { prefix: "SQ-", pad: 4 },
    },
    validate: validateNumbering,
  },
  storage: { perm: "settings:owner", defaults: { backend: "blobs" }, validate: validateStorage },
});

// ------------------------------------------------------------ routes' helpers

// Documents whose change moves sys/auth-epoch (§4.12).
export const AUTH_DOCS = Object.freeze(new Set(["permissions", "auth"]));

function docDef(name) {
  const def = typeof name === "string" && /^[a-z_]{2,40}$/.test(name) ? getSettingsDef(name) : null;
  if (!def) throw new NotFoundError("There is no such settings page.");
  return def;
}

// The documents a person may open, for the Settings menu: [{ name, perm, module }].
export function settingsFor(ctx) {
  return allSettings().filter((s) => ctx.can(s.perm)).map((s) => ({ name: s.name, perm: s.perm, module: s.module })).sort((a, b) => a.name.localeCompare(b.name));
}

// A contact's name as the settings screens show it (never the id).
const contactLabel = (c) => (c ? [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || c.company_name || c.display_name || "A contact" : null);

export async function readSettingFor(ctx, name) {
  const def = docDef(name);
  if (!ctx.can(def.perm)) throw new ForbiddenError("You don't have access to that.");
  const got = await getSettingWithEtag(name);
  const out = { data: got.data, etag: got.etag, defaults: clone(def.defaults), perm: def.perm };
  // the test contact by name (Settings → Messaging)
  if (name === "messaging_test" && isId(got.data && got.data.contact_id, "contact")) {
    const c = await getRecord("contact", got.data.contact_id).catch(() => null);
    out.labels = { contact_id: c && c.data && !c.data.deleted_at ? contactLabel(c.data) : null };
  }
  return out;
}

// PUT /settings/:name: the whole value with If-Match (the etag GET gave, or
// "new" for a document never saved). 412 stale carries the current value.
export async function saveSettingFor(ctx, name, value) {
  const def = docDef(name);
  if (!ctx.can(def.perm)) throw new ForbiddenError("You don't have access to that.");
  if (!isPlainObject(value)) throw new InputError("Send the whole settings page.");
  if (!ctx.ifMatch) throw new InputError("This change needs the version you edited (If-Match).", "if-match");
  if (JSON.stringify(def.validate(clone(value), { ctx: ctx.write() })).length > (def.maxBytes || MAX_DOC_BYTES)) throw new InputError("That is too much for one settings page.");
  // the bulk-send test contact must be a contact flagged test (§5.7.5)
  if (name === "messaging_test" && value.contact_id) {
    if (!isId(value.contact_id, "contact")) throw new InputError("Pick the test contact.", "contact_id");
    const c = await getRecord("contact", value.contact_id);
    if (!c || c.data.deleted_at || c.data.merged_into) throw new InputError("That contact isn't there anymore.", "contact_id");
    if (!(c.data.flags && c.data.flags.test === true)) throw new InputError("Mark this contact as a test contact first (someone on the team).", "contact_id");
  }
  const saved = await putSetting(name, value, { ...ctx.write(), ifMatch: ctx.ifMatch === "new" ? "new" : ctx.ifMatch });
  if (AUTH_DOCS.has(name)) {
    clearPermissionsCache();
    await bumpAuthEpoch(`settings:${name}`).catch(() => null);
  }
  return saved;
}

// ------------------------------------------------------------ the system mode

export const SYS_MODE_KEY = "sys/mode";
export const DEFAULT_MODE = Object.freeze({ system_of_record: "rotor", paused: false, cutover_n: 0 });

export async function readSysMode(opts = {}) {
  const got = await getRaw(SYS_MODE_KEY, opts);
  return { ...DEFAULT_MODE, ...(got && got.data ? got.data : {}), etag: got ? got.etag : null };
}

// CAS on sys/mode: mutate(mode) → new mode | null (no change).
export async function updateSysMode(mutate, opts = {}) {
  for (let i = 0; i < 5; i++) {
    const cur = await getRaw(SYS_MODE_KEY, opts);
    const base = { ...DEFAULT_MODE, ...(cur && cur.data ? cur.data : {}) };
    delete base._w;
    const next = mutate({ ...base });
    if (!next) return base;
    const w = await settledWrite(SYS_MODE_KEY, { ...next, updated_at: nowIso() }, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true }, opts);
    if (w.ok) return next;
  }
  throw new StaleError(null, null, "The system mode kept changing. Try again.");
}

// Pause or resume every side effect, automation and non-maintenance sweep
// (§3.10). Typed confirmation: "PAUSE" / "RESUME". Audited.
export async function setPaused(paused, { by, confirm, reason } = {}, opts = {}) {
  const want = paused ? "PAUSE" : "RESUME";
  if (confirm !== want) throw new InputError(`Type ${want} to confirm.`, "confirm");
  const mode = await updateSysMode((m) => (m.paused === paused ? null : { ...m, paused, ...(paused ? { paused_at: nowIso(), paused_by: by || "system", paused_reason: reason || "owner" } : { resumed_at: nowIso(), resumed_by: by || "system" }) }), opts);
  await appendEvent("sys", "mode", { by: by || "system", origin: "api", action: paused ? "pause" : "resume" }, opts).catch(() => {});
  return mode;
}
