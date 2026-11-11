// Plans module: the customer's pages, server-rendered (design §8.4): the
// agreement (read, sign, print), the hub (the customer's home) and the
// "text me a link" page. esc() on every value; the page scripts
// (crm-app/portal/plans-*.js) read what they need from escaped data-*
// attributes (the portal CSP allows no inline script). Barta's voice, no em
// dashes.

import { esc } from "../../core/text.mjs";

const DATE = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", weekday: "short", month: "short", day: "numeric", year: "numeric" });
const DAY = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
const MONTH = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", year: "numeric" });
export const when = (iso) => { const d = new Date(iso || ""); return Number.isNaN(d.getTime()) ? "" : DATE.format(d); };
export const dayWords = (date) => (/^\d{4}-\d{2}-\d{2}$/.test(String(date || "")) ? DAY.format(new Date(`${date}T18:00:00Z`)) : "");
export const monthWords = (ym) => (/^\d{4}-\d{2}$/.test(String(ym || "")) ? MONTH.format(new Date(`${ym}-15T18:00:00Z`)) : "");

export const PLANS_STYLE = `<style>
.eyebrow{margin:0 0 6px;font:800 12px/1 'Cabinet Grotesk',system-ui,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:var(--coral-ink)}
.doc h2{font-size:18px;margin:18px 0 6px}.doc h2:first-child{margin-top:0}.doc p{color:var(--ink);font-size:15.5px}
.doc ul{margin:0 0 12px;padding-left:20px}.doc li{margin:0 0 6px;font-size:15.5px}
.field{display:flex;flex-direction:column;gap:6px;margin:12px 0}.field span{font-weight:600;font-size:14px}
.field input{width:100%;min-height:48px;padding:11px 14px;border:1.5px solid var(--line);border-radius:14px;font:500 16px/1.4 'General Sans',system-ui,sans-serif;background:#fff;color:var(--ink)}
.sig{position:relative;margin:6px 0 4px}.sig canvas{display:block;width:100%;height:170px;border:1.5px dashed #c9c9cf;border-radius:14px;background:#fff;touch-action:none}
.sig-row{display:flex;justify-content:space-between;align-items:center;font-size:13px;color:var(--muted)}
.linkish{min-height:44px;border:0;background:none;padding:0 4px;color:var(--coral-ink);font:600 15px/1 'General Sans',system-ui,sans-serif;text-decoration:underline;cursor:pointer}
.check{display:flex;align-items:flex-start;gap:12px;min-height:44px;margin:8px 0;font-size:15px;cursor:pointer}.check input{flex:none;width:22px;height:22px;margin:1px 0 0;accent-color:var(--coral)}
.ok{padding:12px 14px;border-radius:14px;background:#eaf7f0;color:#0b6b44;font-weight:600;font-size:15px}
.staff{padding:12px 14px;border-radius:14px;background:var(--mist);border:1px dashed #c9c9cf;font-size:14px}
.items{list-style:none;margin:0;padding:0}.items li{border-top:1px solid var(--line)}.items li:first-child{border-top:0}
.item{display:flex;align-items:center;gap:12px;min-height:56px;padding:10px 0;width:100%;border:0;background:none;text-align:left;color:var(--ink);font:500 16px/1.35 'General Sans',system-ui,sans-serif;text-decoration:none;cursor:pointer}
.item .t{flex:1;min-width:0}.item .t b{display:block;font-weight:600}.item .t small{display:block;color:var(--muted);font-size:13.5px}
.item .go{flex:none;color:var(--coral-ink);font-weight:600;font-size:14px}
.big{font:800 22px/1.2 'Cabinet Grotesk',system-ui,sans-serif;margin:2px 0 4px}
@media print{.noprint,.signbox{display:none!important}}
</style>`;

// The frozen agreement text → HTML ("## " headings, "- " lists, paragraphs).
export function bodyHtml(text) {
  const out = [];
  for (const block of String(text || "").split(/\n{2,}/)) {
    const lines = block.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim());
    if (!lines.length) continue;
    if (lines.length === 1 && /^#{1,3}\s+/.test(lines[0])) { out.push(`<h2>${esc(lines[0].replace(/^#{1,3}\s+/, ""))}</h2>`); continue; }
    let i = 0;
    if (/^#{1,3}\s+/.test(lines[0])) { out.push(`<h2>${esc(lines[0].replace(/^#{1,3}\s+/, ""))}</h2>`); i = 1; }
    const rest = lines.slice(i);
    if (rest.length && rest.every((l) => /^\s*-\s+/.test(l))) out.push(`<ul>${rest.map((l) => `<li>${esc(l.replace(/^\s*-\s+/, ""))}</li>`).join("")}</ul>`);
    else if (rest.length) out.push(`<p>${rest.map(esc).join("<br>")}</p>`);
  }
  return out.join("");
}

// The agreement page. mode: "portal" | "hub" | "present"; base: the API path the sign POST goes to.
export function agreementPage({ agreement: a, contact, mode, base, backTo }) {
  const first = String((contact && (contact.first_name || contact.display_name)) || "").trim().split(/\s+/)[0] || "";
  const doc = `<section class="card doc">${bodyHtml(a.body_rendered)}</section>`;
  const staff = mode === "present" ? `<p class="staff noprint">Hand the phone to ${esc(first || "the customer")} to read and sign.</p>` : "";
  const back = backTo ? `<div class="row noprint"><a class="btn ghost" href="${esc(backTo)}">${mode === "present" ? "Back to the plan (staff)" : "Back"}</a></div>` : "";
  if (a.status === "signed") {
    const s = a.signature || {};
    return {
      title: a.title,
      body: `${PLANS_STYLE}<section class="card"><p class="eyebrow">Agreement</p><h1>${esc(a.title)}</h1><p class="ok">Signed by ${esc(s.name_typed || "you")}${s.at ? ` on ${esc(when(s.at))}` : ""}${s.method === "in_person" ? " (in person)" : ""}.</p><div class="row noprint"><button class="btn ghost" type="button" data-print>Print or save as PDF</button></div>${back}</section>${doc}`,
    };
  }
  if (!["sent", "viewed", "draft"].includes(a.status)) {
    return { title: a.title, body: `${PLANS_STYLE}<section class="card"><p class="eyebrow">Agreement</p><h1>This agreement was replaced</h1><p>Call or text us and we'll send you the new one.</p><div class="row"><a class="btn ghost" href="tel:+17633143400">Call us</a></div>${back}</section>` };
  }
  const data = { id: a.id, sha: a.body_sha256, base, mode };
  return {
    title: a.title,
    body: `${PLANS_STYLE}${staff}<div hidden data-agreement="${esc(JSON.stringify(data))}"></div>
<section class="card"><p class="eyebrow">Agreement</p><h1>${first ? `Hi ${esc(first)}, here's your agreement` : "Here's your agreement"}</h1><p>Read it through, then sign at the bottom. Questions? Call or text us anytime.</p><div class="row noprint"><button class="btn ghost" type="button" data-print>Print or save as PDF</button></div></section>
${doc}
<section class="card signbox" id="sign" data-sign-card>
<h2>Sign your agreement</h2>
<label class="field"><span>Your full name</span><input name="name_typed" autocomplete="name" autocapitalize="words" maxlength="120" enterkeyhint="done"></label>
<div class="sig"><canvas data-sig aria-label="Sign here with your finger"></canvas></div>
<div class="sig-row"><span>Sign above with your finger (optional on a computer)</span><button type="button" class="linkish" data-sig-clear>Clear</button></div>
<label class="check"><input type="checkbox" name="agree"><span>I've read this agreement and I agree to it.</span></label>
<p class="err" data-error hidden></p>
<button class="btn block" type="button" data-sign>Sign</button>
</section>
<section class="card" data-signed hidden><h2>Thanks${first ? `, ${esc(first)}` : ""}! You're all signed.</h2><p>We'll keep a copy on file. You can print this page for your records.</p><div class="row noprint"><button class="btn ghost" type="button" data-print>Print or save as PDF</button></div>${back}</section>`,
  };
}

// The hub (the customer's home, minimal P0): the next visit, things to
// sign, open quotes, the plan.
export function hubPage({ contact, nextVisit, agreements, quotes, plans }) {
  const first = String((contact && (contact.first_name || contact.display_name)) || "").trim().split(/\s+/)[0] || "";
  const visit = nextVisit
    ? `<p class="big">${esc(dayWords(nextVisit.date))}</p><p>${esc(nextVisit.window_text)}${nextVisit.techs.length ? ` · ${esc(nextVisit.techs.join(" and "))}` : ""}</p><p class="small muted">Need to move it? Call or text us at least 24 hours ahead.</p>`
    : `<p>Nothing on the schedule right now. Call or text us to book your next visit.</p>`;
  const sign = agreements.length ? `<section class="card"><h2>To sign</h2><ul class="items">${agreements.map((a) => `<li><a class="item" href="/p/hub/agreements/${esc(encodeURIComponent(a.id))}"><span class="t"><b>${esc(a.title)}</b><small>Read and sign</small></span><span class="go">Open</span></a></li>`).join("")}</ul></section>` : "";
  const open = quotes.length ? `<section class="card"><h2>Your quotes</h2><ul class="items">${quotes.map((q) => `<li><button class="item" type="button" data-open-kind="quote" data-open-id="${esc(q.id)}"><span class="t"><b>Quote ${esc(q.number)}</b><small>${q.expires_on ? `Good through ${esc(dayWords(q.expires_on))}` : "Take a look"}</small></span><span class="go">Open</span></button></li>`).join("")}</ul><p class="err" data-open-error hidden></p></section>` : "";
  const plan = plans.length ? `<section class="card"><h2>Your plan</h2><ul class="items">${plans.map((p) => `<li><div class="item"><span class="t"><b>${esc(p.name)}</b><small>${esc(p.status_text)}${p.next ? ` · next visit around ${esc(monthWords(p.next))}` : ""}</small></span></div></li>`).join("")}</ul></section>` : "";
  return {
    title: "Your account",
    body: `${PLANS_STYLE}<section class="card"><p class="eyebrow">Your account</p><h1>${first ? `Hi ${esc(first)}!` : "Hi there!"}</h1><p>Here's what's coming up with us.</p></section>
<section class="card"><h2>Next visit</h2>${visit}</section>${sign}${open}${plan}
<section class="card"><h2>Questions?</h2><p>Call or text us anytime. We're happy to help.</p><div class="row"><a class="btn ghost" href="tel:+17633143400">Call us</a></div></section>`,
  };
}

export function loginPage() {
  return {
    title: "Text me a link",
    body: `${PLANS_STYLE}<section class="card" data-login><p class="eyebrow">Your account</p><h1>Text me a link</h1><p>Enter the mobile number we have on file and we'll text you a link to your account: your visits, your plan and anything to sign.</p>
<label class="field"><span>Mobile number</span><input name="phone" type="tel" inputmode="tel" autocomplete="tel" maxlength="20" enterkeyhint="send" placeholder="(763) 555-0100"></label>
<p class="err" data-error hidden></p><p class="ok" data-done hidden></p>
<button class="btn block" type="button" data-login-send>Text me a link</button></section>`,
  };
}
