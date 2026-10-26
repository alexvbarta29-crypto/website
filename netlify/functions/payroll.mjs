// GET/POST /payroll — crew pay sheets, behind a password. Not linked from the
// site and never indexed. GET /payroll/data?start=YYYY-MM-DD&end=YYYY-MM-DD
// returns the period's hours and tips from Rotor, only to a signed-in browser.
// See docs/PAYROLL.md.
//
// Password and cookie: netlify/lib/payroll-auth.mjs.
// Rotor reads and pay math: netlify/lib/payroll-rotor.mjs.

import { PAYROLL_HTML } from "../lib/payroll-page.mjs";
import { ONE_YEAR, derive, sha256, same, expected, readCookie, signedIn, cookieFor } from "../lib/payroll-auth.mjs";
import { fetchPeriod, buildPayroll, readRates, readOwners, isYmd, daysBetween, RotorError } from "../lib/payroll-rotor.mjs";

export const config = { path: ["/payroll", "/payroll/", "/payroll/data"] };

const MAX_DAYS = 62;

const baseHeaders = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "same-origin",
};

function html(body, status = 200, extra = {}) {
  return new Response(body, { status, headers: { ...baseHeaders, "Content-Type": "text/html; charset=utf-8", ...extra } });
}
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...baseHeaders, "Content-Type": "application/json; charset=utf-8" } });
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export function loginPage(error = "") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Barta Payroll Sheets</title>
<style>
@font-face{font-family:'Cabinet Grotesk';src:url('/assets/fonts/CabinetGrotesk-Extrabold.v1.woff2') format('woff2');font-weight:800}
@font-face{font-family:'General Sans';src:url('/assets/fonts/GeneralSans-Medium.v1.woff2') format('woff2');font-weight:500}
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:#f7f7f8;color:#121215;font:500 16px/1.5 'General Sans',system-ui,-apple-system,'Segoe UI',sans-serif}
.card{width:100%;max-width:380px;background:#fff;border:1px solid #ececee;border-radius:28px;padding:34px 28px 30px;box-shadow:0 20px 50px rgba(13,27,42,.10),0 8px 20px rgba(13,27,42,.06)}
h1{margin:0;font:800 1.7rem/1.1 'Cabinet Grotesk',system-ui,sans-serif;letter-spacing:-.015em}
p{margin:8px 0 22px;color:#67676f}
label{display:block;font:800 .78rem/1 'Cabinet Grotesk',system-ui,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:#67676f;margin-bottom:8px}
input[type=password]{width:100%;font:inherit;font-size:1.05rem;padding:14px 16px;border:1.5px solid #ececee;border-radius:14px;background:#f7f7f8;outline:0}
input[type=password]:focus{border-color:#fb4d3d;background:#fff;box-shadow:0 0 0 4px rgba(251,77,61,.12)}
.user{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
button{margin-top:16px;width:100%;border:0;border-radius:999px;padding:16px;font:800 1rem/1 'Cabinet Grotesk',system-ui,sans-serif;letter-spacing:.045em;text-transform:uppercase;color:#fff;background:linear-gradient(135deg,#fb4d3d,#ff6a3d);box-shadow:0 14px 38px rgba(251,77,61,.34);cursor:pointer}
.err{margin:0 0 14px;padding:10px 14px;border-radius:12px;background:#fff5f3;border:1px solid rgba(208,51,31,.25);color:#d0331f;font-size:.92rem}
</style></head><body>
<form class="card" method="post" action="/payroll">
<h1>Payroll Sheets</h1>
<p>Enter the password to open the crew pay sheets. This browser will remember you.</p>
${error ? `<div class="err" role="alert">${esc(error)}</div>` : ""}
<input class="user" type="text" name="username" value="Barta Payroll" autocomplete="username" tabindex="-1" aria-hidden="true" readonly>
<label for="pw">Password</label>
<input id="pw" type="password" name="password" autocomplete="current-password" required autofocus>
<button type="submit">Open</button>
</form></body></html>`;
}

async function data(req) {
  if (!signedIn(req)) return json({ error: "signed_out", message: "Sign in again." }, 401);
  const url = new URL(req.url);
  const start = url.searchParams.get("start"), end = url.searchParams.get("end");
  if (!isYmd(start) || !isYmd(end) || end < start)
    return json({ error: "bad_dates", message: "Pick a From date on or before the To date." }, 400);
  if (daysBetween(start, end) >= MAX_DAYS)
    return json({ error: "too_long", message: `Pick a pay period of ${MAX_DAYS} days or less.` }, 400);
  const key = process.env.ROTOR_PAYROLL_API_KEY || process.env.ROTOR_API_KEY;
  if (!key) return json({ error: "not_configured", message: "Payroll isn't connected to Rotor yet: add ROTOR_PAYROLL_API_KEY in Netlify." }, 503);
  try {
    const raw = await fetchPeriod(start, end, { key });
    const people = buildPayroll({ ...raw, rates: readRates(), owners: readOwners(), start, end });
    return json({ start, end, people });
  } catch (err) {
    const status = err instanceof RotorError ? err.status : 0;
    console.error("payroll: " + ((err && err.message) || "error"));
    if (status === 401 || status === 403)
      return json({ error: "rotor_key", message: "Rotor turned the key down. The API key needs the timesheets:read and jobs:read permissions (set it as ROTOR_PAYROLL_API_KEY in Netlify)." }, 502);
    return json({ error: "rotor_unavailable", message: "Rotor didn't answer just now. Give it a moment and pull payroll again." }, 502);
  }
}

export default async (req) => {
  const path = new URL(req.url).pathname.replace(/\/+$/, "");
  if (path === "/payroll/data") {
    if (req.method !== "GET") return json({ error: "method" }, 405);
    return data(req);
  }
  if (req.method === "POST") {
    let pw = "";
    try { pw = String((await req.formData()).get("password") || ""); } catch { pw = ""; }
    const check = expected();
    if (!check) return html(loginPage("Payroll isn't set up yet: add PAYROLL_PASSWORD in Netlify."), 503);
    const token = pw ? derive(pw) : "";
    if (token && same(sha256(token), check)) {
      return new Response(null, { status: 303, headers: { ...baseHeaders, Location: "/payroll", "Set-Cookie": cookieFor(token, ONE_YEAR) } });
    }
    return html(loginPage("That password isn't right. Try again."), 401);
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { ...baseHeaders, Allow: "GET, POST" } });
  }
  if (!expected()) return html(loginPage("Payroll isn't set up yet: add PAYROLL_PASSWORD in Netlify."), 503);
  if (new URL(req.url).searchParams.has("signout")) return html(loginPage(), 200, { "Set-Cookie": cookieFor("", 0) });
  if (signedIn(req)) return html(PAYROLL_HTML, 200, { "Set-Cookie": cookieFor(readCookie(req), ONE_YEAR) });
  return html(loginPage());
};
