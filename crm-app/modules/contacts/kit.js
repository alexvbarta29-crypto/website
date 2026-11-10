// Pieces the contacts screens share (M2a): the module's stylesheet, the
// contacts index kept in memory and revalidated with its ETag (search is
// instant and works offline from the last copy), lifecycle and consent
// words, the source list, and following a background run. No data here,
// only how things read (design §2.3).

import { html, icon } from "../../core/ui.js";
import { phone as fmtPhone } from "../../core/format.js";

let styled = false;
// The module's own stylesheet, once (CSP: style-src 'self').
export function ensureStyles() {
  if (styled || typeof document === "undefined") return;
  styled = true;
  const l = document.createElement("link");
  l.rel = "stylesheet";
  l.href = "/crm-app/modules/contacts/contacts.css";
  document.head.appendChild(l);
}

// ------------------------------------------------------------ the index

let ixCache = null;   // { rows, etag, at, built_at }
// GET /contacts/index with If-None-Match: a 304 keeps the copy in memory.
export async function contactsIndex(ctx, { fresh = false } = {}) {
  if (ixCache && !fresh) {
    try {
      const r = await ctx.api("/contacts/index", { ifNoneMatch: ixCache.etag, cache: false });
      if (r.notModified) return ixCache;
      ixCache = { rows: (r.data && r.data.rows) || [], etag: r.etag, at: Date.now(), built_at: r.data && r.data.built_at };
      return ixCache;
    } catch (e) {
      if (e && e.code === "offline") return { ...ixCache, offline: true };
      throw e;
    }
  }
  const r = await ctx.api("/contacts/index");
  ixCache = { rows: (r.data && r.data.rows) || [], etag: r.etag, at: Date.now(), built_at: r.data && r.data.built_at, offline: !!r.offline, as_of: r.as_of };
  return ixCache;
}
// After a write the next list visit reads the index again.
export function forgetIndex() { if (ixCache) ixCache = { ...ixCache, etag: null }; }
export const cachedRows = () => (ixCache ? ixCache.rows : null);

// ------------------------------------------------------------ words

export const LIFECYCLE = { lead: "Lead", customer: "Customer", former_customer: "Former customer", archived: "Archived" };
const LIFE_CLASS = { lead: "blue", customer: "green", former_customer: "amber", archived: "" };
export const lifecyclePill = (lc) => html`<span class="${"pill " + (LIFE_CLASS[lc] || "")}">${LIFECYCLE[lc] || lc || "Lead"}</span>`;

export const CONSENT = { sms_service: "Texts about their work", sms_marketing: "Marketing texts", email_marketing: "Marketing email" };
export const CONSENT_STATE = { granted: "Yes", unknown: "Not asked", revoked: "No" };
export const consentPill = (s) => html`<span class="${"pill " + (s === "granted" ? "green" : s === "revoked" ? "red" : "")}">${CONSENT_STATE[s] || "Not asked"}</span>`;

export const ARCHIVE_REASONS = [
  { value: "do_not_contact", label: "Asked not to be contacted" }, { value: "duplicate", label: "A duplicate" }, { value: "spam", label: "Spam" },
  { value: "out_of_area", label: "Outside the service area" }, { value: "vendor", label: "A vendor, not a customer" }, { value: "test", label: "A test entry" },
  { value: "other", label: "Something else" },
];

// The seed source list (design §5.1); the server keeps the same list.
export const SOURCES = ["Website quote form", "Website", "Meta Ads", "Holiday Lights Giveaway", "Referral", "Returning Customer", "Facebook",
  "Facebook Messenger", "Google", "Family / Friends", "Door to Door", "Door Hanger", "Signage", "Yard Sign", "Cold Call",
  "Phone Call", "Email", "Parade", "Inbound text", "Map Pin", "Other"];
export const CHANNELS = ["Facebook", "Instagram", "Google", "TikTok", "Family/Friend", "Yard Sign", "BARTA Van", "Postcard/Door Hanger", "Other"];
export const SERVICES = ["Exterior Window Cleaning", "Interior Window Cleaning", "Screen Cleaning", "Gutter Cleaning", "House Washing", "Christmas Light Installation"];

export const TIER = { primary: "In the service area", extended: "Edge of the area", outside: "Outside the area", unknown: "Not on the map yet" };
const TIER_CLASS = { primary: "green", extended: "amber", outside: "red", unknown: "" };
export const tierPill = (t) => html`<span class="${"pill " + (TIER_CLASS[t] || "")}">${TIER[t] || TIER.unknown}</span>`;

// "(763) 555-0100" from an index row's 10 digits or a stored E.164.
export const phoneText = (v) => fmtPhone(v);
export const telHref = (e164) => "tel:" + String(e164 || "").replace(/[^\d+]/g, "");
export const smsHref = (e164) => "sms:" + String(e164 || "").replace(/[^\d+]/g, "");

export const addressLine = (a) => (a ? [a.street1, a.street2, [a.city, [a.state, a.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ")].filter(Boolean).join(", ") : "");
export const mapsQuery = (a) => addressLine(a);

// A coloured circle with initials (the colour follows the name, not the person).
const HUES = ["#2a78d6", "#13a165", "#b7791f", "#7c4dff", "#0e9aa7", "#d0331f", "#4a4a52"];
export function avatar(name) {
  const s = String(name || "?");
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const init = s.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";
  return html`<span class="avatar" style="${"background:" + HUES[h % HUES.length]}" aria-hidden="true">${init}</span>`;
}

export const emptyCard = (title, text, ico = "contacts") => html`<div class="card empty"><div class="art">${icon(ico)}</div><h2>${title}</h2><p>${text}</p></div>`;

// Follows a background run (merges) until it ends or the wait runs out. → the run | null
export async function followRun(ctx, runId, { tries = 20, everyMs = 1500 } = {}) {
  for (let i = 0; i < tries; i++) {
    const r = await ctx.api(`/runs/${encodeURIComponent(runId)}`, { cache: false }).catch(() => null);
    const run = r && r.data;
    if (run && ["done", "failed", "cancelled"].includes(run.status)) return run;
    await new Promise((res) => setTimeout(res, everyMs));
  }
  return null;
}

// "pat@example.com" → a mailto link (stays in the frame; the phone opens Mail).
export const mailHref = (address) => "mailto:" + encodeURIComponent(String(address || "")).replace(/%40/g, "@");
