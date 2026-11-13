// Sales module: /q/{code}, where a yard sign's, door hanger's or flyer's QR
// code goes (signs.mjs; netlify/functions/crm-q.mjs; docs/CRM-SALES.md
// "Signs & flyers").
//
// A scan is counted and sent on in one step: a 302 to the code's page with
// the source in the address, and the barta_q cookie (30 days, first party,
// HttpOnly) that the quote form's request carries to the CRM's intake.
// What is kept of a scan: the time (a daily count) and the rough kind of
// phone (iPhone, Android, other). Never an IP address: the rate limit (30
// counted scans a minute from one connection) keys a day-salted hash of it
// under thr/, which the nightly sweep deletes after a day.
//
// A printed sign never breaks: storage that doesn't answer, a CRM that
// still waits for its setup, a link preview or a flood all still land on the
// website (uncounted). An unknown code is a 404 page with a link to the
// quote page. Nothing here changes a customer's records.

import { createHash, randomBytes } from "node:crypto";
import { withStoreScope, withBudget, listKeys, putRaw } from "../../../crm-store.mjs";
import { deployContext, canonicalRedirect, keySalt } from "../../core/context.mjs";
import { storeBlocked } from "../../core/auth.mjs";
import { nowMs, localDate, tsKey } from "../../core/clock.mjs";
import { clientIp } from "../../core/http.mjs";
import { esc } from "../../core/text.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { BOT_UA } from "../../portal/core.mjs";
import { SLUG_RE, QUOTE_PAGE, codeBySlug, redirectOf, cookieFor, countScan, deviceOf } from "./signs.mjs";

export const SCAN_RATE_PER_MIN = 30;
const HEADERS = Object.freeze({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "strict-origin-when-cross-origin", "X-Content-Type-Options": "nosniff" });
const FALLBACK = `${QUOTE_PAGE}?utm_source=qr`;

const go = (location, extra = {}) => new Response(null, { status: 302, headers: { ...HEADERS, Location: location, ...extra } });
function page(status, title, text, extra = {}) {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>${esc(title)}</title>`
    + `<style>body{margin:0;font:500 17px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;background:#f4f4f6;color:#16161b;padding:32px 18px}main{max-width:520px;margin:0 auto;background:#fff;border:1px solid #ececee;border-radius:20px;padding:26px 22px}h1{font-size:24px;line-height:1.2;margin:0 0 10px}p{color:#5f5f68;margin:0 0 18px}a.btn{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:0 22px;border-radius:999px;background:#d0331f;color:#fff;font-weight:700;text-decoration:none}</style>`
    + `</head><body><main><h1>${esc(title)}</h1><p>${esc(text)}</p><a class="btn" href="${FALLBACK}">Get a free quote</a></main></body></html>`;
  return new Response(body, { status, headers: { ...HEADERS, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", ...extra } });
}
export const notFoundPage = () => page(404, "This code isn't ours anymore", "It may be from an old sign. You can still get a free quote from Barta Window Washing.");

// The rate-limit bucket of a connection: a hash of its address with the day and the site's salt (never the address).
export const ipBucket = (ip, t = nowMs(), salt = keySalt() || "dev-only") => createHash("sha256").update(`qr|${ip}|${localDate(new Date(t))}|${salt}`).digest("hex").slice(0, 32);
const minutePrefix = (bucket, t) => `thr/qr/${bucket}/${tsKey(new Date(t)).slice(0, 13)}`;

// Lets the count finish after the answer when the platform allows it.
function later(p, context) {
  const c = context && typeof context.waitUntil === "function" ? context : globalThis.Netlify && globalThis.Netlify.context;
  if (c && typeof c.waitUntil === "function") { try { c.waitUntil(p); return true; } catch { /* fall through */ } }
  return false;
}

export async function handleScan(req, context) {
  let deploy;
  try {
    deploy = deployContext(req, context);
    const moved = canonicalRedirect(req, deploy);
    if (moved) return moved;
  } catch { return go(FALLBACK); }
  const url = new URL(req.url);
  const method = req.method === "HEAD" ? "HEAD" : req.method;
  if (method !== "GET" && method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { ...HEADERS, Allow: "GET, HEAD" } });
  const m = /^\/q\/([^/]{1,40})\/?$/.exec(url.pathname);
  const slug = m ? m[1].toLowerCase() : "";
  if (!SLUG_RE.test(slug)) return notFoundPage();
  // before the CRM's setup there is nothing to look a code up in: the quote page, uncounted
  if (storeBlocked(deploy)) return go(FALLBACK);
  const ua = req.headers.get("user-agent") || "";
  const t = nowMs();
  try {
    return await withStoreScope({ deploy, budget: withBudget(6000, 12, { strict: false }), requestId: `qr-${randomBytes(4).toString("hex")}` }, async () => {
      const code = await codeBySlug(slug);
      if (!code) return notFoundPage();
      const to = redirectOf(code);
      // a link preview, a crawler or a HEAD: on to the page, nothing counted, no cookie
      if (method === "HEAD" || BOT_UA.test(ua)) return go(to);
      const prefix = minutePrefix(ipBucket(clientIp(req, context), t), t);
      const used = await listKeys(prefix).catch(() => []);
      if (used.length >= SCAN_RATE_PER_MIN) {
        const r = page(429, "One moment", "That code was scanned a lot from here just now. Try again in a minute, or go straight to the website.", { "Retry-After": String(Math.max(1, 60 - new Date(t).getUTCSeconds())) });
        return r;
      }
      const count = (async () => {
        await putRaw(`${prefix}${tsKey(new Date(t)).slice(13)}-${randomBytes(3).toString("hex")}`, { at: new Date(t).toISOString() });
        await countScan(code.id, deviceOf(ua), new Date(t).toISOString());
      })().catch((e) => console.error(`crm:signs: a scan wasn't counted (${safeErr(e)})`));
      if (!later(count, context)) await count;
      return go(to, { "Set-Cookie": cookieFor(slug, t) });
    });
  } catch (e) {
    // storage that doesn't answer: the visitor still gets to the website
    console.error(`crm:signs: a scan couldn't be looked up (${safeErr(e)})`);
    return go(FALLBACK);
  }
}
