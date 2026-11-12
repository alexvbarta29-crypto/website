// Comms: HTML that came from somewhere else (design §5.7.3, §10.2 row 32).
//
// Two jobs, both built on core's allowlist sanitizer (core/templates.mjs
// sanitizeEmailHtml: allowlisted tags and attributes; no script, style,
// iframe or form; links forced to https; images only from the site's
// /assets/, the root email assets or customer-visible files):
//   - an imported Rotor email (a whole HTML document, 3-16 KB of inline
//     styles) is kept as sanitized markup, and its readable text is what
//     the thread shows;
//   - an imported Rotor HTML template gets its hot-linked images re-pointed
//     to the site's own copies before the template validator sees it.

import { sanitizeEmailHtml, htmlToText } from "../../core/templates.mjs";

export const looksLikeHtml = (s) => /<\s*(html|body|table|div|p|br|a|span|td|h[1-6])\b/i.test(String(s ?? ""));

// Sanitized markup of an email body, or null when nothing is left.
export function sanitizeHtml(html, { max = 200000 } = {}) {
  const out = sanitizeEmailHtml(String(html ?? "")).replace(/\s{2,}/g, " ").trim();
  if (!out) return null;
  return out.length > max ? null : out;
}

// The text a person reads: tags out, links kept, quoted blank runs folded.
export function htmlText(html, { max = 20000 } = {}) {
  const safe = sanitizeEmailHtml(String(html ?? ""));
  const text = htmlToText(safe).replace(/&#\d+;|&[a-z]+;/gi, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return Array.from(text).slice(0, max).join("");
}

// Images Rotor's templates hot-linked that the site serves itself (§5.7.3).
const REPOINT = [[/https:\/\/raw\.githubusercontent\.com\/[^"'\s)]+\/IMG_4788\.jpeg/gi, "https://www.bartawindowwashing.com/IMG_4788.jpeg"]];
export function repointImages(html) {
  let out = String(html ?? "");
  for (const [re, to] of REPOINT) out = out.replace(re, to);
  return out;
}
