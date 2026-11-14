// Barta CRM portal: the customer's account pages, as HTML (design §8.1
// /p/hub, /p/visits, /p/request; docs/CRM.md "The customer's account").
// Every value goes through esc(); no inline script (the page's behaviour is
// crm-app/portal/account.js, reading data-* attributes). Barta's voice
// (barta-rules §8): friendly, plain, no em dashes, "insured" never
// "licensed", the guarantee is a free re-clean. No address on any page (a
// link can be forwarded): properties go by their label ("Home", "Cabin").

import { esc } from "../core/text.mjs";
import { PLANS_STYLE, dayWords, monthWords } from "../modules/plans/render.mjs";

export const PHONE = "(763) 314-3400";
export const TEL = "tel:+17633143400";
export const SMS = "sms:+17633143400";

const money = (c) => `$${(Math.round(Number(c) || 0) / 100).toFixed(2)}`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export const ACCOUNT_STYLE = `${PLANS_STYLE}<style>
.back{display:inline-flex;align-items:center;gap:6px;min-height:44px;margin:0 0 6px;color:var(--ink);font-weight:600;text-decoration:none}
.back::before{content:"";width:9px;height:9px;border-left:2px solid currentColor;border-bottom:2px solid currentColor;transform:rotate(45deg);margin-right:2px}
.tiles{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.tile{display:flex;flex-direction:column;justify-content:space-between;gap:6px;min-height:84px;padding:14px;border-radius:16px;background:var(--mist);color:var(--ink);text-decoration:none;font-weight:600;font-size:15px;line-height:1.25}
.tile small{display:block;font-weight:500;color:var(--muted);font-size:13px}
.tile.hot{background:#fff1ef;color:var(--coral-ink)}
.visit{padding:12px 0;border-top:1px solid var(--line)}.visit:first-child,h1+.visit,h2+.visit{border-top:0;padding-top:2px}
.visit .when{font:800 18px/1.2 'Cabinet Grotesk',system-ui,sans-serif;margin:0 0 2px;color:var(--ink)}
.visit p{margin:0 0 2px;font-size:15px}
.visit .row{margin-top:8px}
.chip{display:inline-block;padding:3px 10px;border-radius:999px;background:var(--mist);color:var(--ink);font-size:13px;font-weight:600;margin-left:6px;vertical-align:middle}
.chip.go{background:#eafaf0;color:#14713d}
.photos{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin:10px 0 2px}
.photos a{display:block;position:relative;border-radius:10px;overflow:hidden;background:var(--mist);aspect-ratio:1/1}
.photos img{display:block;width:100%;height:100%;object-fit:cover}
.photos b{position:absolute;left:6px;bottom:6px;padding:2px 7px;border-radius:999px;background:rgba(22,22,27,.72);color:#fff;font-size:11px;font-weight:600}
.field textarea,.field select{width:100%;min-height:48px;padding:11px 14px;border:1.5px solid var(--line);border-radius:14px;font:500 16px/1.4 'General Sans',system-ui,sans-serif;background:#fff;color:var(--ink)}
.field textarea{min-height:110px;resize:vertical}
.field small{color:var(--muted);font-size:13px}
.picks{display:grid;grid-template-columns:1fr;gap:0;margin:4px 0 6px}.picks .check{margin:0;align-items:center}
.file{position:absolute;width:1px;height:1px;opacity:0;overflow:hidden;clip:rect(0 0 0 0)}
.prefs .check{justify-content:space-between;align-items:center;padding:6px 0;border-top:1px solid var(--line);margin:0}.prefs .check:first-child{border-top:0}
.prefs .check span{flex:1}.prefs .check span small{display:block;color:var(--muted);font-size:13px}
.addphotos{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0}
.addphotos img{width:72px;height:72px;object-fit:cover;border-radius:10px}
.policy{padding:14px;border-radius:14px;background:#fff8e6;color:#7a4b00;font-size:15px;margin:10px 0}
.kv{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;margin:6px 0 0;font-size:15px}.kv dt{color:var(--muted)}.kv dd{margin:0;text-align:right}
.perk{margin:10px 0 0}.perk b{display:block}.perk p{margin:2px 0 0;font-size:15px}
.money{font-variant-numeric:tabular-nums}
</style>`;

const back = () => `<a class="back" href="/p/hub">Your account</a>`;
const callRow = (extra = "") => `<div class="row"><a class="btn ghost" href="${TEL}">Call us</a><a class="btn ghost" href="${SMS}">Text us</a>${extra}</div>`;

// One upcoming visit (hub and /p/visits).
function visitBlock(v, { reschedule = true } = {}) {
  const chip = v.status === "en_route" ? `<span class="chip go">On the way</span>` : v.status === "in_progress" || v.status === "paused" ? `<span class="chip go">Under way</span>` : "";
  const who = v.techs.length ? `<p class="muted small">With ${esc(v.techs.join(" and "))}</p>` : "";
  const move = reschedule && v.status === "scheduled" ? `<div class="row"><a class="btn ghost" href="/p/visits/${esc(encodeURIComponent(v.id))}/reschedule">Need to move it?</a></div>` : "";
  return `<div class="visit" data-visit="${esc(v.id)}"><p class="when">${esc(dayWords(v.date))}${chip}</p><p>${esc(v.window_text)}</p>${v.service ? `<p class="muted">${esc(v.service)}</p>` : ""}${who}${move}</div>`;
}

// ------------------------------------------------------------ /p/hub

export function hubPage({ contact, visits, invoices, agreements, quotes, plans }) {
  const first = String((contact && (contact.first_name || contact.display_name)) || "").trim().split(/\s+/)[0] || "";
  const next = visits[0];
  const nextCard = next
    ? `<section class="card" data-next><h2>Next visit</h2>${visitBlock(next)}${visits.length > 1 ? `<div class="row"><a class="btn ghost" href="/p/visits">${esc(plural(visits.length - 1, "more visit", "more visits"))} coming up</a></div>` : ""}</section>`
    : `<section class="card" data-next><h2>Next visit</h2><p>Nothing on the schedule right now.</p><div class="row"><a class="btn" href="/p/request">Request work</a></div></section>`;
  const pay = invoices.length ? `<section class="card" data-pay><h2>To pay</h2><ul class="items">${invoices.map((i) => `<li><button class="item" type="button" data-open-kind="invoice" data-open-id="${esc(i.id)}"><span class="t"><b>Invoice ${esc(i.number)}</b><small class="money">${esc(money(i.balance_cents))} due${i.due ? ` by ${esc(dayWords(i.due))}` : ""}</small></span><span class="go">Pay</span></button></li>`).join("")}</ul></section>` : "";
  const sign = agreements.length ? `<section class="card"><h2>To sign</h2><ul class="items">${agreements.map((a) => `<li><a class="item" href="/p/hub/agreements/${esc(encodeURIComponent(a.id))}"><span class="t"><b>${esc(a.title)}</b><small>Read and sign</small></span><span class="go">Open</span></a></li>`).join("")}</ul></section>` : "";
  const open = quotes.length ? `<section class="card"><h2>Your quotes</h2><ul class="items">${quotes.map((q) => `<li><button class="item" type="button" data-open-kind="quote" data-open-id="${esc(q.id)}"><span class="t"><b>Quote ${esc(q.number)}</b><small>${q.expires_on ? `Good through ${esc(dayWords(q.expires_on))}` : "Take a look"}</small></span><span class="go">Open</span></button></li>`).join("")}</ul></section>` : "";
  const plan = plans.length ? `<section class="card"><h2>Your plan</h2><ul class="items">${plans.map((p) => `<li><a class="item" href="/p/plan"><span class="t"><b>${esc(p.name)}</b><small>${esc(p.status_text)}${p.next ? ` · next visit around ${esc(monthWords(p.next))}` : ""}</small></span><span class="go">Details</span></a></li>`).join("")}</ul></section>` : "";
  const tiles = `<section class="card"><h2>What do you need?</h2><div class="tiles">
<a class="tile hot" href="/p/request">Request work<small>Windows, gutters, lights and more</small></a>
<a class="tile" href="/p/visits">Upcoming visits<small>${visits.length ? esc(plural(visits.length, "visit", "visits")) : "Nothing booked"}</small></a>
<a class="tile" href="/p/history">History<small>Past visits, photos, receipts</small></a>
${plans.length ? `<a class="tile" href="/p/plan">Your plan<small>What's included</small></a>` : ""}
<a class="tile" href="/p/account">Your info<small>Contact details and texts</small></a>
</div></section>`;
  return {
    title: "Your account",
    body: `${ACCOUNT_STYLE}<section class="card"><p class="eyebrow">Your account</p><h1>${first ? `Hi ${esc(first)}!` : "Hi there!"}</h1><p>Here's what's coming up with us.</p></section>
${nextCard}${pay}${sign}${open}${plan}${tiles}
<p class="err" data-open-error hidden></p>
<section class="card"><h2>Questions?</h2><p>Call or text us anytime. We're happy to help.</p>${callRow()}</section>`,
  };
}

// ------------------------------------------------------------ /p/visits

export function visitsPage({ visits, lateHours }) {
  const list = visits.length ? visits.map((v) => visitBlock(v)).join("") : `<p>Nothing on the schedule right now.</p><div class="row"><a class="btn" href="/p/request">Request work</a></div>`;
  return {
    title: "Upcoming visits",
    body: `${ACCOUNT_STYLE}${back()}<section class="card"><h1>Upcoming visits</h1>${list}</section>
<section class="card"><h2>Moving a visit</h2><p>Moving it is free with at least ${esc(lateHours)} hours' notice. Ask from the visit above and we'll text you to confirm the new day.</p></section>`,
  };
}

// ------------------------------------------------------------ /p/history

export function historyPage({ past, invoices, olderBefore }) {
  const photoLink = (ph) => `<a href="/api/portal/hub/files/${esc(encodeURIComponent(ph.id))}" target="_blank" rel="noopener"><img src="/api/portal/hub/files/${esc(encodeURIComponent(ph.id))}${ph.thumb ? "?thumb=1" : ""}" alt="${esc(ph.tag === "before" ? "Before" : "After")} photo" loading="lazy" width="120" height="120"><b>${esc(ph.tag === "before" ? "Before" : "After")}</b></a>`;
  const visitsHtml = past.length ? past.map((v) => `<div class="visit"><p class="when">${esc(dayWords(v.date))}</p>${v.service ? `<p>${esc(v.service)}</p>` : ""}${v.techs.length ? `<p class="muted small">With ${esc(v.techs.join(" and "))}</p>` : ""}${v.photos && v.photos.length ? `<div class="photos">${v.photos.map(photoLink).join("")}</div>` : ""}</div>`).join("")
    : `<p>No visits here yet.</p>`;
  const more = olderBefore ? `<div class="row"><a class="btn ghost" href="/p/history?before=${esc(olderBefore)}">Show earlier visits</a></div>` : "";
  const inv = invoices.length ? `<ul class="items">${invoices.map((i) => `<li><button class="item" type="button" data-open-kind="invoice" data-open-id="${esc(i.id)}"><span class="t"><b>Invoice ${esc(i.number)}</b><small class="money">${esc(i.status_text)} · ${esc(money(i.total_cents))}${i.date ? ` · ${esc(dayWords(i.date))}` : ""}</small></span><span class="go">${i.balance_cents > 0 && i.status === "open" ? "Pay" : "Receipt"}</span></button></li>`).join("")}</ul>` : `<p>No invoices yet.</p>`;
  return {
    title: "Your history",
    body: `${ACCOUNT_STYLE}${back()}<section class="card"><h1>Past visits</h1>${visitsHtml}${more}</section>
<section class="card"><h2>Invoices and receipts</h2>${inv}<p class="err" data-open-error hidden></p></section>
<section class="card"><h2>Something not right?</h2><p>If anything from a visit isn't right, tell us and we'll come back and re-clean it for free.</p>${callRow()}</section>`,
  };
}

// ------------------------------------------------------------ /p/plan

export function planPage({ plans, lateFee, lateHours, noticeDays }) {
  if (!plans.length) {
    return {
      title: "Your plan",
      body: `${ACCOUNT_STYLE}${back()}<section class="card"><h1>Your plan</h1><p>You're not on a care plan right now. Plans bring us back on a schedule, with a discount every visit.</p>${callRow(`<a class="btn" href="/p/request">Ask about a plan</a>`)}</section>`,
    };
  }
  const one = (p) => `<section class="card" data-plan="${esc(p.id)}"><p class="eyebrow">${esc(p.status_text)}</p><h1>${esc(p.name)}</h1>
<dl class="kv">${p.next ? `<dt>Next visit</dt><dd>${esc(p.next_text)}</dd>` : ""}<dt>Visits a year</dt><dd>${esc(p.visits_per_year)}</dd>${p.per_visit_cents ? `<dt>${p.flat ? "Each visit" : "First visit"}</dt><dd class="money">${esc(money(p.per_visit_cents))}</dd>` : ""}${p.term_end ? `<dt>Term through</dt><dd>${esc(dayWords(p.term_end))}</dd>` : ""}</dl>
<h2 style="margin-top:16px">What's included</h2><ul class="items">${p.lines.map((l) => `<li><div class="item"><span class="t"><b>${esc(l.title)}</b><small>${esc(l.when)}</small></span></div></li>`).join("")}</ul>
${p.perks.length ? `<h2 style="margin-top:16px">Your perks</h2>${p.perks.map((k) => `<div class="perk"><b>${esc(k.name)}</b><p>${esc(k.text)}</p></div>`).join("")}` : `<p class="small muted" style="margin-top:12px">This plan has no extra perks. Quarterly and Monthly plans add free touch-ups and a 7-day rain guarantee.</p>`}
</section>`;
  return {
    title: "Your plan",
    body: `${ACCOUNT_STYLE}${back()}${plans.map(one).join("")}
<section class="card"><h2>Good to know</h2><p>Need to move a visit? It's free with at least ${esc(lateHours)} hours' notice. Inside ${esc(lateHours)} hours there's a ${esc(money(lateFee))} late fee. To change or end your plan, give us ${esc(noticeDays)} days' notice.</p><p>If anything isn't right after a visit, we'll come back and re-clean it for free.</p>${callRow()}</section>`,
  };
}

// ------------------------------------------------------------ /p/request

export const REQUEST_SERVICES = Object.freeze([
  ["windows_ext", "Window cleaning (outside)"], ["windows_int", "Window cleaning (inside)"], ["screens", "Screen cleaning"], ["tracks", "Track detailing"],
  ["gutters", "Gutter cleaning"], ["lights", "Christmas lights"], ["touch_up", "A touch-up from my last visit"], ["other", "Something else"],
]);
export const TIMING = Object.freeze([["soon", "As soon as you can"], ["two_weeks", "In the next two weeks"], ["month", "This month"], ["flexible", "I'm flexible"]]);

export function requestPage({ properties, done }) {
  if (done) {
    return { title: "Request sent", body: `${ACCOUNT_STYLE}${back()}<section class="card"><h1>Got it, thanks!</h1><p>We'll call or text you within a business day to set it up.</p>${callRow()}</section>` };
  }
  const props = properties.length > 1 ? `<label class="field"><span>Where</span><select name="property_id">${properties.map((p) => `<option value="${esc(p.id)}">${esc(p.label)}${p.town ? ` (${esc(p.town)})` : ""}</option>`).join("")}</select></label>` : "";
  return {
    title: "Request work",
    body: `${ACCOUNT_STYLE}${back()}<section class="card" data-request><h1>Request work</h1><p>Tell us what you need and we'll get back to you within a business day with a time and a price.</p>
<form data-request-form novalidate>
<fieldset style="border:0;padding:0;margin:12px 0 0"><legend class="small" style="font-weight:600;padding:0">What can we help with?</legend><div class="picks">${REQUEST_SERVICES.map(([k, l]) => `<label class="check"><input type="checkbox" name="services" value="${esc(k)}"><span>${esc(l)}</span></label>`).join("")}</div></fieldset>
${props}
<label class="field"><span>When</span><select name="timing">${TIMING.map(([k, l]) => `<option value="${esc(k)}">${esc(l)}</option>`).join("")}</select></label>
<label class="field"><span>Anything we should know?</span><textarea name="notes" maxlength="2000" placeholder="Number of windows, a ladder spot, a dog in the yard..."></textarea></label>
<div class="field"><span>Photos (up to 3)</span><small>A photo of the house or the problem spot helps us price it.</small><div class="addphotos" data-photo-previews></div><label class="btn ghost block"><input class="file" type="file" accept="image/*" multiple data-photos>Add a photo</label></div>
<p class="err" data-error hidden></p>
<button class="btn block" type="submit" data-send>Send request</button>
</form></section>`,
  };
}

// ------------------------------------------------------------ /p/visits/:id/reschedule

export function reschedulePage({ visit, late, lateHours, lateFee, minDate, done }) {
  const head = `<div class="visit"><p class="when">${esc(dayWords(visit.date))}</p><p>${esc(visit.window_text)}</p>${visit.service ? `<p class="muted">${esc(visit.service)}</p>` : ""}</div>`;
  if (done) return { title: "Request sent", body: `${ACCOUNT_STYLE}${back()}<section class="card"><h1>Got it!</h1>${head}<p>We'll text you to confirm a new day. Until we do, your visit stays where it is.</p>${callRow()}</section>` };
  if (late) {
    return {
      title: "Move this visit",
      body: `${ACCOUNT_STYLE}${back()}<section class="card" data-late><h1>Move this visit</h1>${head}
<p class="policy">It's less than ${esc(lateHours)} hours until this visit, so moving or cancelling it now comes with a ${esc(money(lateFee))} late fee. Give us a call and we'll see what we can do.</p>${callRow()}</section>`,
    };
  }
  const dateInput = (n) => `<label class="field"><span>${n === 1 ? "A day that works" : "Another day (optional)"}</span><input type="date" name="date${n}" min="${esc(minDate)}"></label>`;
  return {
    title: "Move this visit",
    body: `${ACCOUNT_STYLE}${back()}<section class="card" data-reschedule="${esc(visit.id)}"><h1>Move this visit</h1>${head}
<p>Moving it is free with at least ${esc(lateHours)} hours' notice. Pick a day or two and we'll text you to confirm. Your visit stays put until we do.</p>
<form data-reschedule-form novalidate>${dateInput(1)}${dateInput(2)}
<label class="field"><span>Anything else?</span><textarea name="note" maxlength="1000" placeholder="Mornings are best, we'll be out of town that week..."></textarea></label>
<p class="err" data-error hidden></p>
<button class="btn block" type="submit">Ask to move it</button></form></section>`,
  };
}

// ------------------------------------------------------------ /p/account

export const PREFS = Object.freeze([
  ["sms_service", "Visit texts", "Reminders before a visit, on my way, receipts"],
  ["sms_marketing", "Deals and news by text", "A few times a year at most"],
  ["email_marketing", "Deals and news by email", "Seasonal reminders and offers"],
]);

export function accountPage({ contact, masked }) {
  const c = contact || {};
  const consent = c.consent || {};
  const on = (k) => (consent[k] && consent[k].state) === "granted" || (k === "sms_service" && (consent[k] || {}).state !== "revoked");
  return {
    title: "Your info",
    body: `${ACCOUNT_STYLE}${back()}<section class="card"><h1>Your info</h1>
<dl class="kv"><dt>Name</dt><dd>${esc([c.first_name, c.last_name].filter(Boolean).join(" ") || c.display_name || "")}</dd>${masked.phone ? `<dt>Mobile</dt><dd>${esc(masked.phone)}</dd>` : ""}${masked.email ? `<dt>Email</dt><dd>${esc(masked.email)}</dd>` : ""}</dl></section>
<section class="card" data-prefs><h2>Texts and emails</h2><div class="prefs">${PREFS.map(([k, l, s]) => `<label class="check"><span>${esc(l)}<small>${esc(s)}</small></span><input type="checkbox" data-pref="${esc(k)}"${on(k) ? " checked" : ""}></label>`).join("")}</div>
<p class="small muted" style="margin-top:8px">Texted STOP to us before? Text START to turn texts back on.</p><p class="ok" data-pref-done hidden>Saved.</p><p class="err" data-pref-error hidden></p></section>
<section class="card" data-info><h2>Update your info</h2><p>New number, new email, or a different name on the account? Send it here and we'll update it.</p>
<form data-info-form novalidate>
<label class="field"><span>Name</span><input name="name" maxlength="120" autocomplete="name"></label>
<label class="field"><span>Mobile number</span><input name="phone" type="tel" inputmode="tel" autocomplete="tel" maxlength="20"></label>
<label class="field"><span>Email</span><input name="email" type="email" inputmode="email" autocomplete="email" autocapitalize="none" maxlength="120"></label>
<label class="field"><span>Anything else</span><textarea name="note" maxlength="1000" placeholder="A new mailing address, a second contact..."></textarea></label>
<p class="err" data-error hidden></p><p class="ok" data-done hidden>Thanks! We'll update it and text you if we have a question.</p>
<button class="btn block" type="submit">Send the update</button></form></section>`,
  };
}
