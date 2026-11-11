// Barta CRM: the client portal frame (design §8, M1.3 "portal frame"):
// layout, CSP and headers, magic links, the scoped cookie, open and the
// view beacon, unsubscribe, the Checkout return and present links. The
// pages themselves (quote, agreement, invoice, card, hub...) belong to the
// modules, which register them in their manifests (portalRoutes, §11.3);
// this file dispatches to them with the link's scope already checked.
//
// Rules (§8.1-§8.3):
// - GET pages never change anything: email scanners and link previews
//   fetch links before a person does. Opening a session, recording a view,
//   unsubscribing all happen on a POST the page makes after it loads
//   (crm-app/portal/core.js), and known bot user agents are ignored.
// - Links are bearer secrets: 10 base62 characters (≈59 bits), kept only as
//   plk/{sha256(code)}, expiring, revocable, counted (more than
//   cfg/portal.max_opens_per_day opens a day locks the link and tells the
//   owners), never logged (a log names a link by its last 3 characters).
// - A link grants only its own scope: opening it sets barta_portal =
//   {contactId}.{token} (pses/{sha256(token)}, 30 days at most, never past
//   the link) for that scope alone, so a quote forwarded to a neighbour
//   shows that quote, never the hub, other invoices, the card or the
//   address. Present links set no cookie; their token rides in the path.
// - Portal APIs (/api/portal/*) take only the portal cookie (or a present
//   token), need X-CRM-Portal: 1 on POSTs (the RFC 8058 one-click
//   unsubscribe and the no-script "Continue" form are the two exceptions,
//   both bearer-token actions), and never read a staff cookie.
// - Headers: no-store, noindex, Referrer-Policy: no-referrer (a token never
//   leaks to Stripe or Google), X-Frame-Options: DENY, the CSP below. The
//   portal's scripts are static files under /crm-app/portal/.

import { createHash, createHmac, randomBytes } from "node:crypto";
import { getRaw, settledWrite, withStoreScope, withBudget, getSetting, addRel, listRel, getRecord, hk } from "../../crm-store.mjs";
import { deployContext, canonicalRedirect, CANONICAL_ORIGIN, keySalt } from "../core/context.mjs";
import { storeBlocked } from "../core/auth.mjs";
import { now, nowMs, nowIso, localDate, tsKey } from "../core/clock.mjs";
import { isId } from "../core/ids.mjs";
import { esc } from "../core/text.mjs";
import { allModules } from "../core/registry.mjs";
import { readCookie, readBodyText, contentType, clientIp, uaFamily, json, fail } from "../core/http.mjs";
import { InputError, ConflictError, errorResponse } from "../core/errors.mjs";
import { ipHash } from "../core/sessions.mjs";
import { safeErr } from "../../referral-lib.mjs";
import { setSuppression } from "../core/suppressions.mjs";

export const PORTAL_COOKIE = "barta_portal";
export const SESSION_DAYS = 30;
export const CODE_LEN = 10;
export const SCOPE_KINDS = Object.freeze(["hub", "quote", "invoice", "agreement", "card", "receipt", "unsubscribe", "present"]);
export const PORTAL_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; form-action 'self' https://checkout.stripe.com; frame-ancestors 'none'; base-uri 'none'; object-src 'none'";
export const PORTAL_HEADERS = Object.freeze({
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
});
export const BOT_UA = /bot\b|crawler|spider|preview|facebookexternalhit|slackbot|twitterbot|whatsapp|telegram|discord|skypeuripreview|bingpreview|google-?(?:read|safety)|proofpoint|mimecast|barracuda|safelinks|linkcheck|curl\/|wget\/|python-requests|headlesschrome|go-http-client|okhttp/i;

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const CODE_RE = /^[0-9A-Za-z]{10}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const sha = (s) => createHash("sha256").update(String(s)).digest("hex");

// ------------------------------------------------------------ links (§8.2)

// 10 characters of base62 from rejection-sampled random bytes (no modulo bias).
export function newCode(rand = randomBytes) {
  let out = "";
  while (out.length < CODE_LEN) {
    for (const b of rand(16)) { if (b < 248 && out.length < CODE_LEN) out += BASE62[b % 62]; }
  }
  return out;
}
export const isCode = (s) => CODE_RE.test(String(s || ""));
export const linkKey = (code) => `plk/${sha(code)}`;
export const linkUrl = (code) => `${CANONICAL_ORIGIN}/p/${code}`;
export const logName = (code) => `plk:…${String(code).slice(-3)}`;

// The default lifetime of a scope, from cfg/portal (§8.2): hub 30 days,
// agreement 30 days, card 7 days, present 15 minutes; quotes, invoices
// and receipts get theirs from the caller (90 days when it says nothing);
// unsubscribe never expires.
export function defaultExpiry(kind, portal = {}, t = nowMs()) {
  const l = (portal && portal.lifetimes) || {};
  const day = 86400000;
  switch (kind) {
    case "unsubscribe": return null;
    case "present": return new Date(t + (l.present_minutes || 15) * 60000).toISOString();
    case "hub": return new Date(t + (l.hub_days || 30) * day).toISOString();
    case "agreement": return new Date(t + (l.agreement_days || 30) * day).toISOString();
    case "card": return new Date(t + (l.card_days || 7) * day).toISOString();
    default: return new Date(t + 90 * day).toISOString();
  }
}

function checkScope(scope) {
  if (!scope || !SCOPE_KINDS.includes(scope.kind)) throw new InputError("Unknown link scope.", "scope");
  const needsId = !["hub", "card"].includes(scope.kind);
  if (needsId && !(typeof scope.id === "string" && /^[a-z0-9._-]{3,120}$/i.test(scope.id))) throw new InputError("This link needs the record it opens.", "scope.id");
  return { kind: scope.kind, ...(scope.id ? { id: scope.id } : {}) };
}

// Creates a link for a contact and scope. → { code, url, expires_at }.
// opts.code: a fixed code (the unsubscribe link of an address is derived,
// so one address has one link, re-used by every email).
export async function createPortalLink({ contact_id, scope, expires_at, single_use, created_by } = {}, { code: fixed } = {}) {
  if (!isId(contact_id, "contact")) throw new InputError("A link needs a contact.", "contact_id");
  const s = checkScope(scope);
  const portal = await getSetting("portal").catch(() => ({}));
  const exp = expires_at === undefined ? defaultExpiry(s.kind, portal) : expires_at;
  for (let i = 0; i < 4; i++) {
    const code = fixed || newCode();
    const value = {
      contact_id, scope: s, created_at: nowIso(), created_by: created_by || "system", expires_at: exp,
      uses: 0, last_used_at: null, single_use: !!(single_use || s.kind === "present"), revoked_at: null, day: { date: null, n: 0 },
    };
    const w = await settledWrite(linkKey(code), value, { onlyIfNew: true });
    if (w.ok) {
      await addRel("contact-links", contact_id, tsKey(now()), sha(code)).catch(() => {});
      return { code, url: linkUrl(code), expires_at: exp };
    }
    if (fixed) return { code, url: linkUrl(code), expires_at: (w.current && w.current.data && w.current.data.expires_at) || exp };
  }
  throw new ConflictError("Couldn't make a link. Try again.");
}

// The unsubscribe link of one address (RFC 8058 target and the footer link).
export async function unsubscribeLink({ contact_id, channel, address }) {
  if (!["sms", "email"].includes(channel)) throw new InputError("Pick text or email.", "channel");
  const key = hk(channel === "sms" ? "phone" : "email", address);
  const salt = keySalt() || "dev-only";
  const mac = createHmac("sha256", salt).update(`unsub:${channel}:${key}`).digest();
  let code = "";
  for (const b of mac) { if (b < 248) code += BASE62[b % 62]; if (code.length === CODE_LEN) break; }
  const link = await createPortalLink({ contact_id, scope: { kind: "unsubscribe", id: `${channel}--${key}` }, expires_at: null }, { code });
  // opting out always works (§8.2): a derived link revoked before this rule
  // (revokeLinks skips unsubscribe links now) is brought back
  const cur = await readLink(code);
  if (cur && cur.revoked_at && cur.scope && cur.scope.kind === "unsubscribe") {
    const { _etag, _key, ...value } = cur;
    await settledWrite(_key, { ...value, revoked_at: null, revoked_by: null }, { onlyIfMatch: _etag }).catch(() => {});
  }
  return { ...link, url: `${CANONICAL_ORIGIN}/p/unsubscribe/${code}`, one_click: `${CANONICAL_ORIGIN}/api/portal/unsubscribe/${code}` };
}

// A present link (§5.3 "Present to customer"): staff-opened, single use, 15 minutes, no cookie.
export const createPresentLink = ({ contact_id, quote_id, created_by }) => createPortalLink({ contact_id, scope: { kind: "present", id: quote_id }, single_use: true, created_by });

export async function readLink(code) {
  if (!isCode(code)) return null;
  const got = await getRaw(linkKey(code));
  return got && got.data ? { ...got.data, _etag: got.etag, _key: linkKey(code) } : null;
}

// "ok" | "expired" | "revoked" | "used" | "locked" (pure).
export function linkState(link, t = nowMs(), maxPerDay = 200) {
  if (!link) return "missing";
  if (link.revoked_at) return "revoked";
  if (link.expires_at && !(Date.parse(link.expires_at) > t)) return "expired";
  if (link.single_use && link.used_up_at) return "used";
  if (link.locked_at) return "locked";
  if (link.day && link.day.date === localDate(new Date(t)) && link.day.n >= maxPerDay) return "locked";
  return "ok";
}

// Revokes every link of a contact (Contact → Portal → Revoke links; merges
// and archive), except unsubscribe links: opting out is always allowed
// (§8.2, CAN-SPAM), and an address keeps one link for every email.
export async function revokeLinks(contactId, { by = "system" } = {}) {
  const rows = await listRel("contact-links", contactId, { limit: 500 });
  let n = 0;
  for (const r of rows) {
    const k = `plk/${r.id}`;
    const got = await getRaw(k).catch(() => null);
    if (!got || !got.data || got.data.revoked_at) continue;
    if (got.data.scope && got.data.scope.kind === "unsubscribe") continue;
    const w = await settledWrite(k, { ...got.data, revoked_at: nowIso(), revoked_by: by }, { onlyIfMatch: got.etag });
    if (w.ok) n += 1;
  }
  return n;
}

// Marks a single-use link used (a present link's final POST). → true once.
export async function consumeLink(code) {
  const link = await readLink(code);
  if (!link || linkState(link) !== "ok") return false;
  const { _etag, _key, ...value } = link;
  const w = await settledWrite(_key, { ...value, used_up_at: nowIso() }, { onlyIfMatch: _etag });
  return w.ok;
}

// ------------------------------------------------------------ sessions (the scoped cookie)

export const sessionKey = (token) => `pses/${sha(token)}`;
const sessionCookie = (contactId, token, maxAge) => `${PORTAL_COOKIE}=${contactId}.${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
export const clearPortalCookie = () => `${PORTAL_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

async function openSession(link, code, req, context) {
  const token = randomBytes(32).toString("base64url");
  const t = nowMs();
  const cap = t + SESSION_DAYS * 86400000;
  const until = link.expires_at ? Math.min(cap, Date.parse(link.expires_at)) : cap;
  await settledWrite(sessionKey(token), {
    contact_id: link.contact_id, scope: link.scope, link: sha(code), created_at: new Date(t).toISOString(), expires_at: new Date(until).toISOString(),
    ua: uaFamily(req.headers.get("user-agent")), ip: ipHash(clientIp(req, context)),
  }, { onlyIfNew: true });
  return sessionCookie(link.contact_id, token, Math.max(60, Math.floor((until - t) / 1000)));
}

// The portal session of a request, or null (expired, revoked, another contact's).
export async function portalSession(req) {
  const raw = readCookie(req, PORTAL_COOKIE);
  const dot = raw.indexOf(".");
  if (dot < 0) return null;
  const contactId = raw.slice(0, dot);
  const token = raw.slice(dot + 1);
  if (!isId(contactId, "contact") || !TOKEN_RE.test(token)) return null;
  const got = await getRaw(sessionKey(token));
  const s = got && got.data;
  if (!s || s.contact_id !== contactId || !(Date.parse(s.expires_at) > nowMs())) return null;
  const link = await getRaw(`plk/${s.link}`).catch(() => null);
  if (!link || !link.data || link.data.revoked_at) return null;
  return { ...s, token_hash: sha(token) };
}

// Whether a session's scope opens this page: the same kind and, for a
// document, the same record. A document link never opens the hub. A hub
// session also opens the documents it was handed (grants: a quote opened
// from the hub keeps the hub open, below).
export const scopeAllows = (session, kind, id) => !!session && !!session.scope && (
  (session.scope.kind === kind && (!session.scope.id || session.scope.id === id))
  || (session.scope.kind === "hub" && Array.isArray(session.grants) && session.grants.some((g) => g && g.kind === kind && g.id === id && Date.parse(g.until) > nowMs())));

// The live hub session a request carries (raw, for adding a grant), or null.
async function hubSessionOf(req) {
  const raw = readCookie(req, PORTAL_COOKIE);
  const dot = raw.indexOf(".");
  if (dot < 0) return null;
  const contactId = raw.slice(0, dot);
  const token = raw.slice(dot + 1);
  if (!isId(contactId, "contact") || !TOKEN_RE.test(token)) return null;
  const got = await getRaw(sessionKey(token)).catch(() => null);
  const s = got && got.data;
  if (!s || s.contact_id !== contactId || !s.scope || s.scope.kind !== "hub" || !(Date.parse(s.expires_at) > nowMs())) return null;
  const link = await getRaw(`plk/${s.link}`).catch(() => null);
  if (!link || !link.data || link.data.revoked_at) return null;
  return { key: sessionKey(token), data: s, etag: got.etag };
}

// A document link opened from the hub (same contact): the hub session gets
// a grant for it instead of being replaced by a document-only session, so
// "back to my account" still works. → true when granted.
async function grantToHub(req, link, code) {
  const hub = await hubSessionOf(req);
  if (!hub || hub.data.contact_id !== link.contact_id || !link.scope.id) return false;
  const until = Math.min(Date.parse(hub.data.expires_at), link.expires_at ? Date.parse(link.expires_at) : Infinity);
  const keep = (hub.data.grants || []).filter((g) => g && Date.parse(g.until) > nowMs() && !(g.kind === link.scope.kind && g.id === link.scope.id)).slice(-9);
  const w = await settledWrite(hub.key, { ...hub.data, grants: [...keep, { kind: link.scope.kind, id: link.scope.id, link: sha(code), until: new Date(until).toISOString() }] }, { onlyIfMatch: hub.etag }).catch(() => ({ ok: false }));
  return !!w.ok;
}

// ------------------------------------------------------------ the layout (§8.4)

const STYLE = `
@font-face{font-family:'Cabinet Grotesk';src:url('/assets/fonts/CabinetGrotesk-Extrabold.v1.woff2') format('woff2');font-weight:800;font-display:swap}
@font-face{font-family:'General Sans';src:url('/assets/fonts/GeneralSans-Medium.v1.woff2') format('woff2');font-weight:500;font-display:swap}
@font-face{font-family:'General Sans';src:url('/assets/fonts/GeneralSans-Semibold.v1.woff2') format('woff2');font-weight:600;font-display:swap}
:root{color-scheme:light;--ink:#16161b;--muted:#67676f;--line:#ececee;--mist:#f4f4f6;--coral:#fb4d3d;--coral-ink:#d0331f}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;background:var(--mist);color:var(--ink);font:500 16px/1.5 'General Sans',system-ui,-apple-system,'Segoe UI',sans-serif;padding:max(20px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(28px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left))}
.wrap{max-width:640px;margin:0 auto}
header.top{display:flex;align-items:center;justify-content:space-between;margin:0 2px 16px}
header.top img{width:132px;height:auto}
.card{background:#fff;border:1px solid var(--line);border-radius:20px;padding:22px 20px;margin:0 0 14px}
h1,h2{font-family:'Cabinet Grotesk',system-ui,sans-serif;font-weight:800;letter-spacing:-.015em;margin:0 0 8px;line-height:1.15}
h1{font-size:26px}h2{font-size:19px}
p{margin:0 0 12px;color:var(--muted)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:48px;padding:0 22px;border:0;border-radius:999px;background:var(--coral);color:#fff;font:800 15px/1 'Cabinet Grotesk',system-ui,sans-serif;letter-spacing:.04em;text-transform:uppercase;text-decoration:none;cursor:pointer}
.btn.ghost{background:#fff;color:var(--ink);box-shadow:inset 0 0 0 1.5px var(--line)}
.btn.block{display:flex;width:100%}
.btn:disabled{opacity:.6}
.row{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}
.note{padding:12px 14px;border-radius:14px;background:#e8efff;color:#1e40af;font-size:15px}
.err{padding:12px 14px;border-radius:14px;background:#fff5f3;color:var(--coral-ink);font-weight:600;font-size:15px}
footer.foot{margin:22px 2px 0;color:var(--muted);font-size:13px;text-align:center}
footer.foot a{color:var(--muted)}
.muted{color:var(--muted)}.small{font-size:13px}
[hidden]{display:none!important}
@media print{body{background:#fff;padding:0}.card{border:0;padding:0}.btn,.noprint{display:none!important}header.top img{width:110px}}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}`;

// One portal page. body: trusted HTML the caller built with esc() on every value.
export function layout({ title, body, script, beacon, company = {}, page = "page" } = {}) {
  const name = esc(company.name || "Barta Window Washing");
  const legal = esc(company.legal_name || "BARTA WINDOW WASHING LLC");
  const phone = esc(company.phone || "(763) 314-3400");
  const tel = esc(String(company.phone || "(763) 314-3400").replace(/\D/g, ""));
  const beaconAttrs = beacon && SCOPE_KINDS.includes(beacon.kind) ? ` data-beacon-kind="${esc(beacon.kind)}" data-beacon-id="${esc(beacon.id || "")}"` : "";
  const extra = script && /^[a-z0-9-]+\.js$/.test(script) ? `<script type="module" src="/crm-app/portal/${script}"></script>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer"><meta name="theme-color" content="#f4f4f6"><title>${esc(title || name)}</title><link rel="icon" href="/assets/img/favicon.svg" type="image/svg+xml"><style>${STYLE}</style></head><body data-portal="${esc(page)}"${beaconAttrs}><div class="wrap"><header class="top"><img src="/assets/img/logo-bww.png" alt="${name}" width="132" height="36"></header><main>${body}</main><footer class="foot">${legal} · <a href="tel:+1${tel}">${phone}</a></footer></div><script type="module" src="/crm-app/portal/core.js"></script>${extra}</body></html>`;
}

export function portalPage(html, status = 200, extra = {}) {
  return new Response(html, { status, headers: { ...PORTAL_HEADERS, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": PORTAL_CSP, ...extra } });
}
const pjson = (body, status = 200, extra = {}) => json(body, status, { ...PORTAL_HEADERS, ...extra });
const pfail = (code, message, status) => fail(code, message, status, { headers: { "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" } });

const message = (title, text, { status = 200, company } = {}) => portalPage(layout({ title, company, page: "message", body: `<section class="card"><h1>${esc(title)}</h1><p>${esc(text)}</p><div class="row"><a class="btn ghost" href="tel:+17633143400">Call us</a></div></section>` }), status);
const STATE_TEXT = {
  missing: ["That link isn't right", "Check the link in your text or email, or call us and we'll send a fresh one."],
  expired: ["That link has expired", "Call or text us and we'll send you a fresh one."],
  revoked: ["That link no longer works", "Call or text us and we'll send you a fresh one."],
  used: ["That link was already used", "Ask us for a new one if you need it."],
  locked: ["That link is resting", "It was opened a lot today, so we paused it. Call us and we'll help."],
};
const stateMessage = (state, opts) => message(...(STATE_TEXT[state] || STATE_TEXT.missing), { status: state === "missing" ? 404 : 410, ...opts });

// ------------------------------------------------------------ module portal routes

// Return pages (M5's Checkout resolver) and beacons (M3a's quote viewed), registered by modules at import time.
let returnHandler = null;
export function definePortalReturn(fn) { if (typeof fn !== "function") throw new TypeError("definePortalReturn: a function"); returnHandler = fn; }
const beacons = new Map();
export function definePortalBeacon(kind, fn) { if (!SCOPE_KINDS.includes(kind) || typeof fn !== "function") throw new TypeError("definePortalBeacon: a scope kind and a function"); beacons.set(kind, fn); }

const PARAM = /^:([a-z_][a-z0-9_]*)$/i;
function compile(r, module) {
  const names = [];
  const re = new RegExp("^/" + r.path.split("/").filter(Boolean).map((s) => { const m = PARAM.exec(s); if (m) { names.push(m[1]); return "([^/]+)"; } return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }).join("/") + "/?$");
  return { ...r, module, re, names };
}
let compiled = null;
// The latest-registered module's route wins a path two modules declare
// (only a test fixture standing in for a module does that).
function moduleRoutes() {
  const list = allModules().slice().reverse().flatMap((m) => (m.portalRoutes || []).map((r) => ({ r, m: m.name })));
  if (compiled && compiled.n === list.length) return compiled.routes;
  compiled = { n: list.length, routes: list.map(({ r, m }) => compile(r, m)) };
  return compiled.routes;
}
function matchModule(method, path) {
  for (const r of moduleRoutes()) {
    if ((r.method || "GET") !== method) continue;
    const m = r.re.exec(path);
    if (m) {
      const params = {};
      r.names.forEach((n, i) => { try { params[n] = decodeURIComponent(m[i + 1]); } catch { params[n] = m[i + 1]; } });
      return { route: r, params };
    }
  }
  return null;
}

// ------------------------------------------------------------ core handlers

async function readForm(req, max = 16 * 1024) {
  const text = await readBodyText(req, max);
  const ct = contentType(req);
  if (ct === "application/json") { try { return JSON.parse(text || "{}"); } catch { throw new InputError("That isn't valid JSON."); } }
  return Object.fromEntries(new URLSearchParams(text));
}

const sameOrigin = (req, url) => { const o = req.headers.get("origin"); return !o || o === url.origin; };
const portalCsrf = (req, url) => req.headers.get("x-crm-portal") === "1" && sameOrigin(req, url);

// Where a link's scope lives.
export function scopePath(scope, code) {
  switch (scope.kind) {
    case "hub": return "/p/hub";
    case "card": return "/p/card";
    case "unsubscribe": return `/p/unsubscribe/${code}`;
    case "present": return `/p/present/${code}`;
    default: return `/p/${scope.kind}/${encodeURIComponent(scope.id)}`;
  }
}

// GET /p/{code}: a tiny data-free page whose script POSTs /api/portal/open.
function entryPage(code, company) {
  return portalPage(layout({
    title: "Opening…", company, page: "open",
    body: `<section class="card" data-code="${esc(code)}"><h1>Opening your page…</h1><p data-status>One moment.</p><noscript><p>Tap Continue to open it.</p></noscript><form method="post" action="/api/portal/open"><input type="hidden" name="code" value="${esc(code)}"><button class="btn block" type="submit">Continue</button></form></section>`,
  }));
}

// POST /api/portal/open {code}: validates the link, counts the open, sets
// the scoped cookie, answers where to go (JSON) or 303 there (the form).
async function open(req, url, context) {
  const form = await readForm(req);
  const isForm = contentType(req) !== "application/json";
  if (isForm ? !sameOrigin(req, url) : !portalCsrf(req, url)) return pfail("csrf", "Open the link from your text or email.", 403);
  if (BOT_UA.test(req.headers.get("user-agent") || "")) return pfail("bot", "Open the link on your phone.", 403);
  const code = String(form.code || "");
  const link = await readLink(code);
  const portal = await getSetting("portal").catch(() => ({}));
  const max = Number.isInteger(portal.max_opens_per_day) ? portal.max_opens_per_day : 200;
  const state = linkState(link, nowMs(), max);
  if (state !== "ok") {
    if (state === "locked" && link && !link.locked_at) await lockLink(code, link);
    if (isForm) return stateMessage(state);
    return pfail(state, (STATE_TEXT[state] || STATE_TEXT.missing).join(". "), state === "missing" ? 404 : 410);
  }
  if (link.scope.kind === "present" || link.scope.kind === "unsubscribe") {
    const to = scopePath(link.scope, code);
    return isForm ? new Response(null, { status: 303, headers: { ...PORTAL_HEADERS, Location: to } }) : pjson({ ok: true, data: { location: to } });
  }
  // count the open (CAS; the day's count locks a link that is being hammered)
  const today = localDate(now());
  const { _etag, _key, ...value } = link;
  const day = value.day && value.day.date === today ? { date: today, n: value.day.n + 1 } : { date: today, n: 1 };
  await settledWrite(_key, { ...value, uses: (value.uses || 0) + 1, last_used_at: nowIso(), day }, { onlyIfMatch: _etag }).catch(() => {});
  const to = scopePath(link.scope, code);
  // opened from the customer's hub: the hub session keeps its cookie and gains this document
  if (link.scope.kind !== "hub" && await grantToHub(req, link, code)) {
    if (isForm) return new Response(null, { status: 303, headers: { ...PORTAL_HEADERS, Location: to } });
    return pjson({ ok: true, data: { location: to } });
  }
  const cookie = await openSession(link, code, req, context);
  const headers = { ...PORTAL_HEADERS, "Set-Cookie": cookie };
  if (isForm) return new Response(null, { status: 303, headers: { ...headers, Location: to } });
  return pjson({ ok: true, data: { location: to } }, 200, { "Set-Cookie": cookie });
}

async function lockLink(code, link) {
  const { _etag, _key, ...value } = link;
  const w = await settledWrite(_key, { ...value, locked_at: nowIso() }, { onlyIfMatch: _etag }).catch(() => ({ ok: false }));
  if (!w.ok) return;
  console.error(`crm:portal: a link was locked after too many opens (${logName(code)})`);
  try {
    const { notify, approvers } = await import("../core/notify.mjs");
    await notify(await approvers(), { kind: "system", title: "A customer link was paused", body: "It was opened over and over today. Send the customer a fresh one if they ask.", link: "/today" }, { by: "portal" });
  } catch { /* the lock is what matters */ }
}

// GET /p/unsubscribe/{code}: the confirm page; POST /api/portal/unsubscribe/{code} does it.
async function unsubscribePage(code, company) {
  const link = await readLink(code);
  // an unsubscribe link always works, even one revoked with its contact's other links
  if (!link || link.scope.kind !== "unsubscribe") return stateMessage("missing", { company });
  const channel = String(link.scope.id).split("--")[0] === "sms" ? "texts" : "emails";
  return portalPage(layout({
    title: "Unsubscribe", company, page: "unsubscribe",
    body: `<section class="card" data-unsubscribe-code="${esc(code)}"><h1>Stop marketing ${channel}?</h1><p>You'll still hear from us about your own visits, quotes and invoices.</p><p class="note" data-done hidden>Done. We won't send you marketing ${channel} anymore.</p><p class="err" data-error hidden></p><div class="row"><button class="btn block" type="button" data-unsubscribe>Stop marketing ${channel}</button></div><noscript><form method="post" action="/api/portal/unsubscribe/${esc(code)}"><button class="btn block" type="submit">Stop marketing ${channel}</button></form></noscript></section>`,
  }));
}

async function unsubscribe(req, url, code) {
  // RFC 8058 one-click (a mail provider, form-encoded, no Origin) or the page's own POST
  const form = await readForm(req).catch(() => ({}));
  const oneClick = form["List-Unsubscribe"] === "One-Click";
  if (!oneClick && !sameOrigin(req, url)) return pfail("csrf", "Use the button on the page.", 403);
  const link = await readLink(code);
  if (!link || link.scope.kind !== "unsubscribe") return pfail("missing", "That link isn't right.", 404);
  const [channel, key] = String(link.scope.id).split("--");
  if (!["sms", "email"].includes(channel) || !/^[0-9a-z]{26}$/.test(key || "")) return pfail("missing", "That link isn't right.", 404);
  // sup/ and its dated row, then consent.changed for sales and comms (§11.3)
  await setSuppression({ channel, address_hk: key, state: "opted_out", source: "portal", by: "portal", contact_id: link.contact_id });
  if (contentType(req) === "application/json") return pjson({ ok: true, data: { unsubscribed: true, channel } });
  return message("You're unsubscribed", channel === "sms" ? "We won't send you marketing texts anymore." : "We won't send you marketing emails anymore.");
}

// GET /p/return?cs=: Stripe's success_url; resolved on the server with the cookie (M5).
async function returnPage(req, url, session, company) {
  if (returnHandler && session) {
    try { return await returnHandler({ req, url, session, company, layout, portalPage, esc }); } catch (e) { console.error(`crm:portal: the return page failed (${safeErr(e)})`); }
  }
  return message("Thank you", "We're confirming your payment. You'll get a receipt by text or email in a moment.", { company });
}

// POST /api/portal/beacon {kind, id}: "this page was viewed" (after load, never on GET).
async function beacon(req, url, session) {
  if (!portalCsrf(req, url)) return pfail("csrf", "Missing the portal header.", 403);
  if (BOT_UA.test(req.headers.get("user-agent") || "")) return new Response(null, { status: 204, headers: PORTAL_HEADERS });
  const b = await readForm(req);
  if (!session || !scopeAllows(session, b.kind, b.id)) return pfail("signed_out", "Open your link again.", 401);
  const fn = beacons.get(b.kind);
  if (fn) await fn({ session, kind: b.kind, id: b.id, body: b, write: (extra = {}) => ({ by: "portal", origin: "portal", actor_kind: "portal", requestId: "portal", ...extra }) });
  return new Response(null, { status: 204, headers: PORTAL_HEADERS });
}

// GET /api/portal/me: the hub's summary (hub scope only).
async function me(session) {
  if (!session || session.scope.kind !== "hub") return pfail("signed_out", "Open your link again.", 401);
  const c = await getRecord("contact", session.contact_id).catch(() => null);
  return pjson({ ok: true, data: { first_name: (c && c.data && c.data.first_name) || null, scope: session.scope.kind } });
}

// A module's page or API route, with its scope checked (§8.2). scope
// "public" (a module's sign-in page, /p/login) opens without a session.
async function moduleRoute(hit, req, url, context, company) {
  const { route, params } = hit;
  let session = null;
  let link = null;
  if (route.scope === "present") {
    link = await readLink(params.token);
    const st = linkState(link);
    if (!link || link.scope.kind !== "present" || st !== "ok") return url.pathname.startsWith("/api/") ? pfail(st === "ok" ? "missing" : st, "This page has ended.", 410) : stateMessage(st === "ok" ? "missing" : st, { company });
  } else if (route.scope === "public") {
    // a page anyone may open (/p/login): no session, no contact; POSTs still need the portal header
  } else {
    session = await portalSession(req);
    const id = params.id || null;
    if (!session || !scopeAllows(session, route.scope, id)) {
      return url.pathname.startsWith("/api/") ? pfail("signed_out", "Open your link again.", 401) : message("Open your link again", "For your privacy this page opens only from the link we sent you.", { status: 401, company });
    }
  }
  if (req.method !== "GET" && !portalCsrf(req, url)) return pfail("csrf", "Missing the portal header.", 403);
  const pctx = {
    req, url, params, context, session, link, company, contact_id: (session && session.contact_id) || (link && link.contact_id),
    layout, portalPage, esc, json: pjson, fail: pfail, message,
    body: req.method === "GET" ? null : await readForm(req, route.maxBody || 256 * 1024),
    write: (extra = {}) => ({ by: "portal", origin: "portal", actor_kind: "portal", requestId: "portal", ...extra }),
  };
  return route.handler(pctx);
}

// ------------------------------------------------------------ the function

export async function handlePortal(req, context) {
  const requestId = randomBytes(6).toString("hex");
  try {
    const deploy = deployContext(req, context);
    const moved = canonicalRedirect(req, deploy);
    if (moved) return moved;
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method === "HEAD" ? "GET" : req.method;
    if (storeBlocked(deploy)) return message("This page isn't available right now", "Call or text us and we'll help.", { status: 503 });
    const budget = withBudget(8000, 30);
    return await withStoreScope({ deploy, budget, requestId, origin: url.origin }, async () => {
      const company = await getSetting("company").catch(() => ({}));
      if (path === "/api/portal/open" && method === "POST") return open(req, url, context);
      if (path === "/api/portal/beacon" && method === "POST") return beacon(req, url, await portalSession(req));
      if (path === "/api/portal/me" && method === "GET") return me(await portalSession(req));
      let m;
      if ((m = /^\/api\/portal\/unsubscribe\/([0-9A-Za-z]{10})$/.exec(path)) && method === "POST") return unsubscribe(req, url, m[1]);
      if ((m = /^\/p\/unsubscribe\/([0-9A-Za-z]{10})\/?$/.exec(path)) && method === "GET") return unsubscribePage(m[1], company);
      if (path === "/p/return" && method === "GET") return returnPage(req, url, await portalSession(req), company);
      const hit = matchModule(method, path);
      if (hit) return moduleRoute(hit, req, url, context, company);
      if ((m = /^\/p\/([0-9A-Za-z]{10})\/?$/.exec(path)) && method === "GET") return entryPage(m[1], company);
      if (path.startsWith("/api/portal/")) return pfail("not_found", "Not found.", 404);
      if (method !== "GET") return new Response("Method not allowed", { status: 405, headers: { ...PORTAL_HEADERS, Allow: "GET" } });
      return message("This page isn't here", "It may not be ready yet. Call or text us and we'll help.", { status: 404, company });
    });
  } catch (e) {
    const er = errorResponse(e);
    if (er.status >= 500) console.error(`crm:portal: a request failed (${safeErr(e)})`);
    const url = (() => { try { return new URL(req.url); } catch { return null; } })();
    if (url && url.pathname.startsWith("/api/")) return pfail(er.code, er.message, er.status);
    return message(er.status === 503 ? "We couldn't load that" : "Something went wrong", "Try again in a minute, or call us.", { status: er.status >= 500 ? er.status : 400 });
  }
}

