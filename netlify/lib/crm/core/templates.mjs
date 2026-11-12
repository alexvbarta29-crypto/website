// Barta CRM core: message templates and the closed variable set (design
// §5.7.3, §5.7.2, barta-rules §8).
//
// Syntax: {{name}} or {{name|fallback}} (spaces inside are fine). The
// variables come from a CLOSED set (VARIABLES below): a template that uses
// any other name is refused when it is saved. A render with a missing
// variable and no fallback fails with `missing_variable`, and the sender
// blocks the send (B9): a text never goes out reading "Hi ,".
//
// Rules the parser enforces on every template:
//   - no STOP text: the sender appends " Reply STOP to opt out." itself
//     (the footer rule, D5), so a template that says it would say it twice;
//   - no single-brace tokens ({first_name}): those are Rotor's and the
//     playbook's syntax, converted on import by convertImportSyntax();
//   - an HTML email template (body_html) is sanitized on save: allowlisted
//     tags and attributes, no script, style, iframe or form, links forced to
//     https (or mailto:/tel:), images only from the site's own /assets/.
//
// Rendering: SMS text is plain (nothing escaped); email text is plain and
// its HTML part escapes every value. renderEmailHtml() is core's plain
// branded layout (white card on mist, ink text); comms (M6) may replace it.
//
// Template records: rec/template/{id} (prefix tp), listed in ix/templates,
// one per key through ptr/template-key/{key}. Modules declare built-in
// templates in their manifests (templates: [...]); the templates.seed sweep
// creates each once (onlyIfNew on the key's pointer), so an owner's edits
// are never overwritten by a deploy.

import { createHash } from "node:crypto";
import { createRecord, getRecord, readPointer, readIndex, getRaw, getSetting, settledWrite } from "../../crm-store.mjs";
import { nowIso } from "./clock.mjs";
import { defineType, allTemplates } from "./registry.mjs";
import { InputError, NotFoundError, ExistsError } from "./errors.mjs";
import { deriveId, isId } from "./ids.mjs";
import { shape, str, enumValue, bool, arr } from "./validate.mjs";
import { esc, squish } from "./text.mjs";
import { CANONICAL_ORIGIN } from "./context.mjs";

export const CHANNELS = Object.freeze(["sms", "email"]);
export const CATEGORIES = Object.freeze(["service", "marketing", "personal", "staff"]);
export const SMS_MAX = 1600;
export const EMAIL_MAX = 20000;
export const HTML_MAX = 100000;
export const REVIEW_LINK = "https://g.page/r/CfnTsPliwEw4EBM/review";

// The closed variable set (§5.7.3): label and a made-up sample for previews.
const SAMPLE_LINK = `${CANONICAL_ORIGIN}/p/AbC123xYz9`;
export const VARIABLES = Object.freeze({
  first_name: { label: "First name", sample: "Pat", group: "contact" },
  last_name: { label: "Last name", sample: "Example", group: "contact" },
  full_name: { label: "Full name", sample: "Pat Example", group: "contact" },
  company_name: { label: "Company name", sample: "Barta Window Washing", group: "company" },
  legal_name: { label: "Legal name", sample: "Barta Window Washing LLC", group: "company" },
  company_phone: { label: "Company phone", sample: "(763) 314-3400", group: "company" },
  company_email: { label: "Company email", sample: "office@bartawindowwashing.com", group: "company" },
  sender_first_name: { label: "Sender's first name", sample: "Alex", group: "company" },
  tech_first_name: { label: "Tech's first name", sample: "Sam", group: "visit" },
  eta_minutes: { label: "ETA (minutes)", sample: "20", group: "visit" },
  town: { label: "Town", sample: "Delano", group: "contact" },
  service_list: { label: "Services", sample: "window cleaning and screens", group: "visit" },
  visit_date: { label: "Visit date", sample: "Wed, Nov 19", group: "visit" },
  visit_time: { label: "Visit time", sample: "8:00 AM", group: "visit" },
  arrival_window: { label: "Arrival window", sample: "between 8:00 and 10:00 AM", group: "visit" },
  quote_link: { label: "Quote link", sample: SAMPLE_LINK, group: "links" },
  invoice_link: { label: "Invoice link", sample: SAMPLE_LINK, group: "links" },
  agreement_link: { label: "Agreement link", sample: SAMPLE_LINK, group: "links" },
  receipt_link: { label: "Receipt link", sample: SAMPLE_LINK, group: "links" },
  portal_link: { label: "Portal link", sample: SAMPLE_LINK, group: "links" },
  card_link: { label: "Card link", sample: SAMPLE_LINK, group: "links" },
  invoice_number: { label: "Invoice number", sample: "INV-0610", group: "money" },
  invoice_total: { label: "Invoice total", sample: "$243.10", group: "money" },
  balance_due: { label: "Balance due", sample: "$243.10", group: "money" },
  due_date: { label: "Due date", sample: "Wed, Nov 19", group: "money" },
  plan_name: { label: "Plan name", sample: "Quarterly plan", group: "plan" },
  per_visit_price: { label: "Price per visit", sample: "$189.00", group: "plan" },
  visits_per_year: { label: "Visits per year", sample: "4", group: "plan" },
  term_months: { label: "Term (months)", sample: "12", group: "plan" },
  perks_list: { label: "Perks", sample: "unlimited touch-ups", group: "plan" },
  clawback_amount: { label: "Clawback amount", sample: "$100.00", group: "plan" },
  notice_days: { label: "Notice days", sample: "7", group: "plan" },
  late_cancel_fee: { label: "Late-cancel fee", sample: "$50.00", group: "plan" },
  offer_amount: { label: "Offer amount", sample: "$25", group: "offers" },
  expires_on: { label: "Expires on", sample: "Nov 30", group: "offers" },
  season_year: { label: "Season year", sample: "2026", group: "offers" },
  review_link: { label: "Review link", sample: REVIEW_LINK, group: "reviews" },
  review_count: { label: "Review count", sample: "250", group: "reviews" },
});
export const isVariable = (name) => Object.hasOwn(VARIABLES, name);

// Rotor's {first_name} and the playbook's {first}, {rep}, {co}, {reviews},
// {link} (§5.7.3), converted on import.
export const IMPORT_ALIASES = Object.freeze({
  first_name: "first_name", first: "first_name", last_name: "last_name", rep: "sender_first_name",
  co: "company_name", company: "company_name", reviews: "review_count", link: "portal_link",
});
export function convertImportSyntax(body) {
  return String(body ?? "").replace(/(?<!\{)\{\s*([a-z_]+)\s*\}(?!\})/gi, (m, name) => {
    const to = IMPORT_ALIASES[name.toLowerCase()] || (isVariable(name.toLowerCase()) ? name.toLowerCase() : null);
    return to ? `{{${to}}}` : m;
  });
}

// "Reply STOP to opt out", "Text STOP to end", "STOP to unsubscribe"...:
// the sender adds the footer; a template never carries it (barta-rules §8).
const STOP_TEXT = /\b(reply|text|txt|send)\s+["'“”]?stop\b|\bstop\s+to\s+(opt|unsub|end|quit|cancel|stop)/i;
export const hasStopText = (s) => STOP_TEXT.test(String(s ?? ""));

const TOKEN = /\{\{\s*([^{}|]*?)\s*(?:\|([^{}]*))?\}\}/g;

// → { variables: [names], errors: [{ code, message, variable? }] }
export function parseTemplate(body, { field = "body" } = {}) {
  const s = String(body ?? "");
  const variables = new Set();
  const errors = [];
  let m;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(s))) {
    const name = m[1].trim();
    if (!isVariable(name)) errors.push({ code: "unknown_variable", variable: name.slice(0, 40), field, message: `{{${name.slice(0, 40)}}} isn't one of the variables.` });
    else variables.add(name);
    if (m[2] !== undefined && m[2].length > 60) errors.push({ code: "fallback_too_long", variable: name, field, message: "Keep a fallback under 60 characters." });
  }
  const rest = s.replace(TOKEN, "");
  if (/\{\{|\}\}/.test(rest)) errors.push({ code: "braces", field, message: "A {{ or }} isn't closed." });
  const single = /(?<!\{)\{\s*([a-z_]+)\s*\}(?!\})/i.exec(rest);
  if (single) errors.push({ code: "old_syntax", field, message: `Use {{${single[1]}}} with two braces.` });
  if (hasStopText(s)) errors.push({ code: "stop_text", field, message: "Leave out \"Reply STOP to opt out\": the app adds it when it's needed." });
  return { variables: [...variables].sort(), errors };
}

const blank = (v) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");

// Fills the variables. → { text, missing: [names] }. escape: a function
// applied to each value (HTML), identity for SMS and plain text.
// A fill-in that comes out empty (an empty fallback: "Good morning
// {{first_name|}}!") takes the space before it along when punctuation
// follows, so it reads "Good morning!" and "Hey, it's...", never "Hey ,".
const TOKEN_SP = /([ \t]*)\{\{\s*([^{}|]*?)\s*(?:\|([^{}]*))?\}\}/g;
export function fill(body, vars = {}, { escape = (x) => x } = {}) {
  const missing = new Set();
  const text = String(body ?? "").replace(TOKEN_SP, (m, sp, name, fallback, offset, all) => {
    const key = name.trim();
    const v = vars[key];
    let out;
    if (!blank(v)) out = escape(String(v));
    else if (fallback !== undefined) out = escape(fallback.trim());
    else { missing.add(key); out = ""; }
    if (out === "" && fallback !== undefined && sp && /^[,.!?;:]/.test(all.slice(offset + m.length))) return "";
    return sp + out;
  });
  return { text, missing: [...missing].sort() };
}

// → { text, html?, subject?, missing }. A template is { channel, subject?, body, body_html? }.
export function renderTemplate(template, vars = {}, { company } = {}) {
  const t = template || {};
  const body = fill(t.body, vars);
  const out = { text: t.channel === "sms" ? body.text.replace(/[ \t]+\n/g, "\n").trim() : body.text.trim(), missing: [...body.missing] };
  if (t.channel === "email") {
    const subject = fill(t.subject || "", vars);
    out.subject = squish(subject.text);
    out.missing.push(...subject.missing);
    if (t.body_html) {
      const h = fill(t.body_html, vars, { escape: esc });
      out.html = h.text;
      out.missing.push(...h.missing);
    } else {
      out.html = renderEmailHtml(out.text, { company });
    }
  }
  out.missing = [...new Set(out.missing)].sort();
  return out;
}

// ------------------------------------------------------------ email layout

// Core's plain branded layout: paragraphs in a white card on mist, ink
// text, links as coral buttons when a line is only a link. Comms (M6)
// replaces it with its own (setEmailLayout: comms/email-layout.mjs).
let emailLayout = null;
export function setEmailLayout(fn) { emailLayout = typeof fn === "function" ? fn : null; }
export function renderEmailHtml(text, { company } = {}) {
  if (emailLayout) return emailLayout(text, { company });
  const name = esc((company && company.name) || "Barta Window Washing");
  const paras = String(text ?? "").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).map((p) => {
    if (/^https:\/\/\S+$/.test(p)) return `<p style="margin:22px 0"><a href="${esc(p)}" style="display:inline-block;padding:13px 24px;border-radius:999px;background:#fb4d3d;color:#ffffff;font-weight:700;text-decoration:none">Open</a></p>`;
    const linked = esc(p).replace(/https:\/\/[^\s<>"']+/g, (u) => `<a href="${u}" style="color:#d0331f">${u}</a>`);
    return `<p style="margin:0 0 14px">${linked.replace(/\n/g, "<br>")}</p>`;
  }).join("");
  return `<!doctype html><html><body style="margin:0;padding:24px 12px;background:#f4f4f6;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#16161b;font-size:16px;line-height:1.5"><div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #ececee;border-radius:20px;padding:24px"><img src="${CANONICAL_ORIGIN}/assets/img/email-logo-bww.png" alt="${name}" width="148" style="display:block;margin:0 0 18px;height:auto">${paras}</div></body></html>`;
}

// ------------------------------------------------------------ HTML sanitizing

const ALLOWED_TAGS = new Set(["a", "b", "strong", "i", "em", "u", "p", "br", "div", "span", "h1", "h2", "h3", "h4", "ul", "ol", "li", "img", "table", "thead", "tbody", "tr", "td", "th", "hr", "blockquote", "center", "small", "sup", "sub"]);
const DROP_WITH_CONTENT = new Set(["script", "style", "iframe", "object", "embed", "form", "template", "noscript", "svg", "math", "textarea", "select", "button", "title", "head", "frameset", "frame", "applet", "audio", "video", "canvas"]);
const VOID = new Set(["br", "hr", "img"]);
const ATTRS = new Set(["href", "src", "alt", "title", "width", "height", "align", "valign", "bgcolor", "border", "cellpadding", "cellspacing", "colspan", "rowspan", "style", "target"]);
const SITE_HOSTS = new Set(["www.bartawindowwashing.com", "bartawindowwashing.com"]);

function safeHref(v) {
  const s = String(v).trim();
  if (/^\{\{\s*[a-z_]+_link\s*(\|[^{}]*)?\}\}/.test(s)) return s;            // a portal/review link variable
  if (/^(mailto|tel):[^\s"'<>]+$/i.test(s)) return s;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol === "http:") u.protocol = "https:";                           // links forced to https
  return u.protocol === "https:" ? u.href : null;
}
function safeSrc(v) {
  const s = String(v).trim();
  if (/^\/assets\/[A-Za-z0-9_./-]+$/.test(s) && !s.includes("..")) return CANONICAL_ORIGIN + s;
  if (/^\/[A-Za-z0-9_.-]+\.(png|jpe?g|webp|gif)$/i.test(s)) return CANONICAL_ORIGIN + s;          // root email assets (IMG_4788.jpeg)
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== "https:" || !SITE_HOSTS.has(u.hostname)) return null;
  if (!(u.pathname.startsWith("/assets/") || /^\/[A-Za-z0-9_.-]+\.(png|jpe?g|webp|gif)$/i.test(u.pathname) || /^\/api\/portal\/files\/fl_[0-9a-z]{20}$/.test(u.pathname))) return null;
  return CANONICAL_ORIGIN + u.pathname;
}
function safeStyle(v) {
  const s = String(v);
  if (/url\s*\(|expression|javascript:|@import|behavior|[<>\\]/i.test(s)) return null;
  return s.replace(/[^\w\s#%.,:;()'"-]/g, "").slice(0, 500);
}

// Allowlisted tags and attributes; no script, style, iframe or form;
// https links; images only from the site (§5.7.3). Comments are dropped.
export function sanitizeEmailHtml(input) {
  const s = String(input ?? "").replace(/<!--[\s\S]*?(-->|$)/g, "").replace(/<!\[CDATA\[[\s\S]*?(\]\]>|$)/g, "").replace(/<!doctype[^>]*>/gi, "");
  const out = [];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
  let last = 0;
  let dropUntil = null;
  let m;
  const text = (t) => t.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  while ((m = re.exec(s))) {
    const [whole, close, rawTag, rawAttrs] = m;
    const tag = rawTag.toLowerCase();
    if (dropUntil) {
      if (close && tag === dropUntil) dropUntil = null;
      last = m.index + whole.length;
      continue;
    }
    out.push(text(s.slice(last, m.index)));
    last = m.index + whole.length;
    if (DROP_WITH_CONTENT.has(tag)) { if (!close && !/\/\s*$/.test(rawAttrs)) dropUntil = tag; continue; }
    if (!ALLOWED_TAGS.has(tag)) continue;
    if (close) { if (!VOID.has(tag)) out.push(`</${tag}>`); continue; }
    const kept = [];
    const ar = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    let a;
    while ((a = ar.exec(rawAttrs))) {
      const name = a[1].toLowerCase();
      const value = a[2] ?? a[3] ?? a[4] ?? "";
      if (!ATTRS.has(name)) continue;
      let v = value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
      if (name === "href") { if (tag !== "a") continue; v = safeHref(v); }
      else if (name === "src") { if (tag !== "img") continue; v = safeSrc(v); }
      else if (name === "style") v = safeStyle(v);
      else if (name === "target") v = v === "_blank" ? "_blank" : null;
      else v = v.slice(0, 200);
      if (v === null) continue;
      kept.push(`${name}="${esc(v)}"`);
    }
    if (tag === "a" && kept.some((k) => k.startsWith("target="))) kept.push('rel="noopener"');
    if (tag === "img" && !kept.some((k) => k.startsWith("src="))) continue;
    out.push(`<${tag}${kept.length ? " " + kept.join(" ") : ""}>`);
  }
  if (!dropUntil) out.push(text(s.slice(last)));
  return out.join("");
}

// The plain-text part of an HTML template: tags out, links kept.
export function htmlToText(h) {
  return String(h ?? "")
    .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, inner) => `${inner.replace(/<[^>]+>/g, "").trim()} (${href.replace(/&amp;/g, "&")})`)
    .replace(/<(br|\/p|\/div|\/h[1-4]|\/li|\/tr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim();
}

// ------------------------------------------------------------ the record type

export const TEMPLATE_KEY_RE = /^[a-z][a-z0-9_]{1,39}$/;

function validateTemplate(data, { op, before } = {}) {
  const stored = op === "update";
  const out = shape(data, {
    key: (v, f) => {
      const k = String(v ?? "").trim();
      if (!TEMPLATE_KEY_RE.test(k)) throw new InputError("Use a short key of lowercase letters, digits and _, like visit_reminder_2d.", f);
      if (before && before.key && before.key !== k) throw new InputError("A template's key never changes.", f);
      return k;
    },
    name: (v, f) => str(v, { field: f, max: 80, required: true }),
    channel: (v, f) => enumValue(v, CHANNELS, { field: f, required: true, stored }),
    category: (v, f) => enumValue(v, CATEGORIES, { field: f, required: true, stored }),
    subject: (v, f) => (data.channel === "email" ? str(v, { field: f, max: 150 }) : undefined),
    body: (v, f) => str(v, { field: f, max: data.channel === "sms" ? SMS_MAX : EMAIL_MAX, required: !data.body_html, trim: false }),
    body_html: (v, f) => {
      if (blank(v)) return undefined;
      if (data.channel !== "email") throw new InputError("Only an email template has HTML.", f);
      if (String(v).length > HTML_MAX) throw new InputError("That HTML is too big.", f);
      return sanitizeEmailHtml(v);
    },
    tags: (v, f) => arr(v, (x, ff) => str(x, { field: ff, max: 40, required: true }), { field: f, max: 10 }),
    active: (v, f) => (v === undefined ? true : bool(v, { field: f })),
    built_in: (v, f) => bool(v, { field: f }),
  });
  if (before && before.built_in && before.category && out.category !== before.category) throw new InputError("A built-in template keeps its category.", "category");
  // "staff" templates are built in (texts to staff phones); one people make
  // could reach a customer without the consent, quiet-hours and footer rules
  if (out.category === "staff" && !(out.built_in || (before && before.built_in))) throw new InputError("Pick service, marketing or personal.", "category");
  if (out.channel === "email" && !out.body && out.body_html) out.body = htmlToText(out.body_html);
  const parts = [["body", out.body], ["subject", out.subject], ["body_html", out.body_html]];
  const vars = new Set();
  for (const [field, text] of parts) {
    if (blank(text)) continue;
    const p = parseTemplate(text, { field });
    if (p.errors.length) throw new InputError(p.errors[0].message, p.errors[0].field, { code: p.errors[0].code });
    p.variables.forEach((x) => vars.add(x));
  }
  out.variables = [...vars].sort();
  return out;
}

export const templateRow = (r) => ({ k: r.key, n: r.name, ch: r.channel, cat: r.category, act: r.active !== false, bi: !!r.built_in, tags: r.tags || [], u: r.updated_at });

export const templateType = defineType({
  type: "template",
  prefix: "tp",
  v: 1,
  validate: validateTemplate,
  rotorFields: ["rotor", "name", "body", "subject", "body_html"],
  techFields: ["id", "key", "name", "channel", "category", "subject", "body", "variables", "active"],
  readPerm: "messages:send",
  shadow: false,
  indexes: [{ name: "templates", shard: () => "", row: templateRow }],
  pointers: [{ kind: "template-key", key: (r) => r.key }],
  summary: (r) => ({ id: r.id, key: r.key, name: r.name, channel: r.channel }),
  example: () => ({ key: "sample_note", name: "Sample note", channel: "sms", category: "service", body: "Hi {{first_name|there}}, this is {{company_name}}.", tags: [], active: true, built_in: false }),
});

// ------------------------------------------------------------ reading

export async function getTemplate(id) {
  if (!isId(id, "template")) throw new NotFoundError("That template isn't there.");
  const got = await getRecord("template", id);
  if (!got || got.data.deleted_at) throw new NotFoundError("That template isn't there.");
  return got;
}

// The template a key names (the record, or a module's built-in default
// before the seed sweep has written it), or null.
export async function getTemplateByKey(key, opts = {}) {
  if (!TEMPLATE_KEY_RE.test(String(key || ""))) return null;
  const ptr = await readPointer("template-key", key, opts);
  if (ptr && isId(ptr.id, "template")) {
    const got = await getRecord("template", ptr.id, opts);
    if (got && !got.data.deleted_at) return got.data;
  }
  const def = allTemplates().find((t) => t.key === key);
  return def ? { ...def, active: def.active !== false, built_in: true, variables: parseTemplate(def.body).variables } : null;
}

// The library: ix/templates rows, plus built-ins not seeded yet.
export async function listTemplates({ channel, category, active } = {}) {
  const ix = await readIndex("templates", "");
  const rows = ix.rows.map((r) => ({ id: r.id, key: r.k, name: r.n, channel: r.ch, category: r.cat, active: r.act, built_in: r.bi, tags: r.tags || [], updated_at: r.u }));
  const have = new Set(rows.map((r) => r.key));
  for (const t of allTemplates()) {
    if (!have.has(t.key)) rows.push({ id: null, key: t.key, name: t.name || t.key, channel: t.channel, category: t.category, active: t.active !== false, built_in: true, tags: t.tags || [], updated_at: null, pending_seed: true });
  }
  return rows
    .filter((r) => (!channel || r.channel === channel) && (!category || r.category === category) && (active === undefined || r.active === active))
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

// ------------------------------------------------------------ variables for a send

const titleCase = (s) => String(s).toLowerCase().replace(/(^|[\s'-])([a-z])/g, (m, p, c) => p + c.toUpperCase());
// "pat" → "Pat", "MARY-ANN" → "Mary-Ann"; mixed case ("McKay") stays as typed.
export function tidyName(s) {
  const t = squish(s);
  if (!t) return "";
  return t === t.toLowerCase() || t === t.toUpperCase() ? titleCase(t) : t;
}

const primaryAddress = (contact) => {
  if (!contact) return null;
  const p = contact.billing_address;
  return p && p.city ? p : null;
};

// The variables every send has: the contact's, the company's, the sender's;
// `extra` (the caller's visit, quote, invoice... values) wins.
export function varsFor({ contact, company, sender, extra } = {}) {
  const c = contact || {};
  const co = company || {};
  const first = tidyName(c.first_name || "");
  const last = tidyName(c.last_name || "");
  const addr = primaryAddress(c);
  const v = {
    first_name: first || null,
    last_name: last || null,
    full_name: [first, last].filter(Boolean).join(" ") || squish(c.company_name) || null,
    company_name: co.name || "Barta Window Washing",
    legal_name: co.legal_name || "Barta Window Washing LLC",
    company_phone: co.phone || "(763) 314-3400",
    company_email: co.email || "office@bartawindowwashing.com",
    sender_first_name: (sender && (sender.first_name || String(sender.name || "").split(/\s+/)[0])) || "Alex",
    town: addr ? addr.city : null,
    review_link: REVIEW_LINK,
  };
  for (const [k, val] of Object.entries(extra || {})) if (isVariable(k) && val !== undefined) v[k] = val === null ? null : String(val);
  return v;
}

// Sample values for every variable (previews with no contact).
export const sampleVars = () => Object.fromEntries(Object.entries(VARIABLES).map(([k, d]) => [k, d.sample]));

// A preview: the template rendered for a contact (when given and found),
// with made-up samples for anything the contact can't supply.
export async function previewFor(template, contactId, { extra, sender } = {}) {
  const company = await getSetting("company").catch(() => null);
  let contact = null;
  if (isId(contactId, "contact")) {
    const got = await getRecord("contact", contactId).catch(() => null);
    contact = got ? got.data : null;
  }
  const real = varsFor({ contact, company, sender, extra });
  const vars = { ...sampleVars(), ...Object.fromEntries(Object.entries(real).filter(([, v]) => !blank(v))) };
  const missingForContact = contact ? renderTemplate(template, real, { company }).missing : [];
  const r = renderTemplate(template, vars, { company });
  return { ...r, contact_found: !!contact, missing_for_contact: missingForContact };
}

// ------------------------------------------------------------ seeding built-ins

let seededSet = null;
const seedSetKey = (defs) => createHash("sha256").update(defs.map((t) => t.key).sort().join(",")).digest("hex").slice(0, 20);

// Creates every module's built-in templates once (onlyIfNew on
// ptr/template-key/{key}); a key someone already used is left alone.
// → { created, done }
export async function seedTemplates(ctx = {}, { budget } = {}) {
  const defs = allTemplates();
  if (!defs.length) return { created: 0, done: true };
  const setKey = seedSetKey(defs);
  if (seededSet === setKey) return { created: 0, done: true };
  const marker = await getRaw(`done/seed/templates--${setKey}`);
  if (marker && marker.data && marker.data.state === "done") { seededSet = setKey; return { created: 0, done: true }; }
  let created = 0;
  for (const t of defs) {
    if (budget && budget.left() < 3000) return { created, done: false };
    if (await readPointer("template-key", t.key)) continue;
    try {
      await createRecord("template", {
        id: deriveId("template", "seed:template", "core", t.key),
        key: t.key, name: t.name || t.key, channel: t.channel, category: t.category, subject: t.subject, body: t.body, body_html: t.body_html,
        tags: t.tags || [], active: t.active !== false, built_in: true,
      }, { ...ctx, by: "system", origin: "worker", actor_kind: "automation" });
      created += 1;
    } catch (e) {
      if (!(e instanceof ExistsError)) throw e;
    }
  }
  await settledWrite(`done/seed/templates--${setKey}`, { state: "done", at: nowIso(), count: defs.length }, { onlyIfNew: true }).catch(() => {});
  seededSet = setKey;
  return { created, done: true };
}
export function clearTemplateSeedCache() { seededSet = null; }
