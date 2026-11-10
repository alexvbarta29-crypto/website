// Quotes module: the customer's view of a quote version (design §8.1, §8.4),
// rendered on the server with esc() on every value, phone first, with a
// print stylesheet. One renderer for the portal page (/p/quote/:id), the
// staff phone's Present to customer page (/p/present/:token) and the
// staff preview (GET /quotes/:id/preview).
//
// What the page shows is the frozen VERSION (never the live draft): the
// options side by side (stacked on a phone, the recommended one first and
// preselected), each with its lines, optional add-ons to tick, discounts,
// per-visit price and plan schedule; the client note, photos and mockups,
// the general terms and, for a plan option, the plan's agreement text (one
// signature covers both); then approve (name, signature, "I agree"),
// request changes and decline. The behaviour (option choice, add-ons and
// live totals, the signature pad, the POSTs, the run poll) is
// crm-app/portal/quotes-quote.js; the page carries what it needs in data-*
// attributes, never in an inline script (the portal CSP is script-src 'self').
//
// Scope (§8.2, §8.3): a quote page shows that quote only: the customer's
// first name, never the address, internal notes or another contact.

import { esc } from "../../core/text.mjs";
import { formatCents } from "../../core/money.mjs";
import { covers, visitsOf, PLAN_CATALOG } from "./pricing.mjs";

const money = (c) => formatCents(Number.isSafeInteger(c) ? c : 0);
const DATE = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", weekday: "short", month: "short", day: "numeric" });
export const dateWords = (d) => { if (!d) return ""; const x = /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(d + "T18:00:00Z") : new Date(d); return Number.isNaN(x.getTime()) ? "" : DATE.format(x); };
const firstName = (c) => String((c && (c.first_name || c.display_name || "")) || "").trim().split(/\s+/)[0] || "";

const FREQ = { biannual: "2 visits a year", quarterly: "4 visits a year (3 exterior, 1 interior)", monthly: "12 visits a year", lights_annual: "Installed every season" };
const RENEW = { biannual: "every 6 months", quarterly: "every 3 months", monthly: "every month", lights_annual: "every year" };
const BILLING = {
  barta_standard: "Your first visit is billed when it's done; later visits are billed on the 1st of the month they're scheduled.",
  after_visit: "Each visit is billed when it's done.",
  first_of_month: "Each visit is billed on the 1st of the month it's scheduled.",
};

export function scopeWords(scope) {
  if (!scope || scope.type === "all") return "";
  if (scope.type === "initial") return "First visit only";
  if (scope.type === "after_initial") return "After the first visit";
  const v = scope.visits || [];
  return v.length === 1 ? `Visit ${v[0]} only` : `Visits ${v.slice(0, -1).join(", ")} and ${v[v.length - 1]}`;
}

const unitWords = { pane: "pane", screen: "screen", track: "track", ft: "ft", each: "each", hour: "hour" };
function qtyText(l) {
  const q = (l.qty_milli || 0) / 1000;
  const qty = Number.isInteger(q) ? String(q) : q.toFixed(1);
  const u = unitWords[l.unit] || "";
  return `${qty}${u ? " " + (u === "ft" ? "ft" : u + (q === 1 ? "" : "s")) : ""}${l.show && l.show.unit ? ` × ${money(l.unit_cents)}` : ""}`;
}

export function planWords(o) {
  if (!o || o.kind !== "plan" || !o.plan) return null;
  const p = o.plan;
  const key = p.catalog_key;
  const freq = FREQ[key] || `${p.visits_per_year} visit${p.visits_per_year === 1 ? "" : "s"} a year`;
  const renew = p.auto_renew === false ? "" : `, then it renews ${RENEW[key] || "with the same schedule"}`;
  return { freq, term: `${p.term_months}-month plan${renew}.`, billing: BILLING[p.billing] || "" };
}

// The headline price of an option: per visit for a flat plan, else the first visit / the total.
export function headline(o) {
  const t = o.totals || { per_visit_cents: [0], first_cents: 0, term_cents: 0, annual_cents: 0 };
  if (o.kind !== "plan") return { main: money(t.first_cents), unit: "total" };
  const per = t.per_visit_cents || [];
  const flat = per.length > 0 && per.every((x) => x === per[0]);
  return flat ? { main: money(per[0]), unit: "per visit", sub: `${money(t.annual_cents)} a year` } : { main: money(t.first_cents), unit: "first visit", sub: `${money(t.annual_cents)} a year` };
}

function lineRow(o, l, editable) {
  const scope = scopeWords(l.scope);
  const meta = [l.show && l.show.qty ? qtyText(l) : "", scope].filter(Boolean).join(" · ");
  const desc = l.show && l.show.description !== false && l.description ? `<p class="ql-desc">${esc(l.description)}</p>` : "";
  const price = (l.total_cents || 0) === 0 ? "Included" : money(l.total_cents);
  if (l.optional) {
    const checked = l.selected === true ? " checked" : "";
    const box = editable ? `<input type="checkbox" data-optline="${esc(o.id)}|${esc(l.id)}"${checked}>` : "";
    return `<li class="ql opt"><label class="ql-row">${box}<span class="ql-t">${esc(l.title)} <small>(add-on)</small></span><span class="ql-p">${esc(price)}</span></label>${meta ? `<p class="ql-m">${esc(meta)}</p>` : ""}${desc}</li>`;
  }
  return `<li class="ql"><div class="ql-row"><span class="ql-t">${esc(l.title)}</span><span class="ql-p">${esc(price)}</span></div>${meta ? `<p class="ql-m">${esc(meta)}</p>` : ""}${desc}</li>`;
}

function discountRow(d, o) {
  const amount = d.type === "percentage" ? `${(d.value / 100).toFixed(d.value % 100 ? 1 : 0)}% off` : `−${money(d.value)}`;
  const per = o.kind === "plan" && (!d.scope || d.scope.type === "all") && d.type !== "percentage" ? " per visit" : "";
  const scope = scopeWords(d.scope);
  return `<li class="ql qd"><div class="ql-row"><span class="ql-t">${esc(d.name)}</span><span class="ql-p">${esc(amount + per)}</span></div>${scope ? `<p class="ql-m">${esc(scope)}</p>` : ""}</li>`;
}

function visitList(o) {
  const per = (o.totals && o.totals.per_visit_cents) || [];
  if (o.kind !== "plan" || per.length < 2 || per.every((x) => x === per[0])) return "";
  const v = visitsOf(o);
  const shown = per.slice(0, v.year);
  return `<p class="qv">${shown.map((c, i) => `Visit ${i + 1}: ${esc(money(c))}`).join(" · ")}</p>`;
}

function optionCard(o, { editable, chosen }) {
  const h = headline(o);
  const pw = planWords(o);
  const lines = (o.lines || []).map((l) => lineRow(o, l, editable)).join("") + (o.discounts || []).map((d) => discountRow(d, o)).join("");
  const radio = editable ? `<input type="radio" name="option" value="${esc(o.id)}"${chosen ? " checked" : ""}>` : "";
  return `<section class="card qo${chosen ? " on" : ""}" data-option="${esc(o.id)}">
<label class="qo-head">${radio}<span class="qo-hd"><span class="qo-name">${o.recommended ? `<span class="qo-rec">Recommended</span>` : ""}${esc(o.name)}</span>${pw ? `<span class="qo-sub">${esc(pw.freq)}</span>` : ""}</span><span class="qo-price"><b data-price="${esc(o.id)}">${esc(h.main)}</b><small>${esc(h.unit)}</small></span></label>
<ul class="qlines">${lines}</ul>
${visitList(o)}
${pw ? `<p class="qo-note">${esc(pw.term)} ${esc(pw.billing)}${h.sub ? ` <b data-annual="${esc(o.id)}">${esc(h.sub)}</b>.` : ""}</p>` : ""}
</section>`;
}

const paras = (text) => String(text || "").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("");

export const QUOTE_STYLE = `<style>
.eyebrow{margin:0 0 6px;font:800 12px/1 'Cabinet Grotesk',system-ui,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:var(--coral-ink)}
.qo{padding:0;overflow:hidden}.qo.on{border-color:var(--coral);box-shadow:0 0 0 2px rgba(251,77,61,.18)}
.qo-head{display:flex;align-items:flex-start;gap:12px;padding:18px 18px 12px;cursor:pointer}
.qo-head input{flex:none;width:22px;height:22px;margin:3px 0 0;accent-color:var(--coral)}
.qo-hd{flex:1;min-width:0}.qo-name{display:block;font:800 19px/1.2 'Cabinet Grotesk',system-ui,sans-serif}
.qo-rec{display:table;margin:0 0 6px;padding:3px 9px;border-radius:999px;background:var(--coral);color:#fff;font:800 11px/1.3 'Cabinet Grotesk',system-ui,sans-serif;letter-spacing:.06em;text-transform:uppercase;vertical-align:middle}
.qo-sub{display:block;margin-top:2px;font-size:14px;color:var(--muted)}
.qo-price{flex:none;text-align:right}.qo-price b{display:block;font:800 22px/1.1 'Cabinet Grotesk',system-ui,sans-serif;font-variant-numeric:tabular-nums}.qo-price small{color:var(--muted);font-size:12.5px}
.qlines{list-style:none;margin:0;padding:0 18px;border-top:1px solid var(--line)}
.ql{padding:11px 0;border-bottom:1px solid var(--line)}.ql:last-child{border-bottom:0}
.ql-row{display:flex;align-items:flex-start;gap:10px}.ql-row input{flex:none;width:22px;height:22px;margin:0;accent-color:var(--coral)}
.ql-t{flex:1;min-width:0;font-weight:600}.ql-t small{font-weight:500;color:var(--muted)}.ql-p{flex:none;font-weight:600;font-variant-numeric:tabular-nums}
.ql-m,.ql-desc{margin:3px 0 0;font-size:13.5px;color:var(--muted)}.qd .ql-p{color:#0b6b44}
.qv{margin:0;padding:10px 18px;font-size:13.5px;color:var(--muted);border-top:1px solid var(--line)}
.qo-note{margin:0;padding:12px 18px 16px;font-size:14px;border-top:1px solid var(--line)}.qo-note b{color:var(--ink)}
.qphotos{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;margin-top:10px}.qphotos img{width:100%;height:auto;border-radius:14px;border:1px solid var(--line)}
details.card summary{min-height:44px;display:flex;align-items:center;font:800 17px/1.2 'Cabinet Grotesk',system-ui,sans-serif;cursor:pointer}
.terms p{font-size:14px}
.field{display:flex;flex-direction:column;gap:6px;margin:12px 0}.field span{font-weight:600;font-size:14px}
.field input,.field textarea{width:100%;min-height:48px;padding:11px 14px;border:1.5px solid var(--line);border-radius:14px;font:500 16px/1.4 'General Sans',system-ui,sans-serif;background:#fff;color:var(--ink)}
.field textarea{min-height:96px;resize:vertical}
.sig{position:relative;margin:6px 0 4px}.sig canvas{display:block;width:100%;height:170px;border:1.5px dashed #c9c9cf;border-radius:14px;background:#fff;touch-action:none}
.sig-row{display:flex;justify-content:space-between;align-items:center;font-size:13px;color:var(--muted)}
.linkish{min-height:44px;border:0;background:none;padding:0 4px;color:var(--coral-ink);font:600 15px/1 'General Sans',system-ui,sans-serif;text-decoration:underline;cursor:pointer}
.check{display:flex;align-items:flex-start;gap:12px;min-height:44px;margin:8px 0;font-size:15px;cursor:pointer}.check input{flex:none;width:22px;height:22px;margin:1px 0 0;accent-color:var(--coral)}
.qsum{font-size:15px;color:var(--ink)}
.staff{padding:12px 14px;border-radius:14px;background:var(--mist);border:1px dashed #c9c9cf;font-size:14px}
@media print{.qa,.qx,.noprint{display:none!important}.qo{break-inside:avoid}details.card[open] summary{display:none}}
</style>`;

// mode: "portal" | "present" | "preview". → { title, body } (trusted HTML, every value escaped).
export function renderQuotePage({ quote, version, contact, mode = "portal", token = null, files = [], floor = 0 } = {}) {
  const first = firstName(contact);
  const label = (version && version.number_label) || quote.number_label;
  const editable = mode !== "preview";
  const base = mode === "present" ? `/api/portal/present/${encodeURIComponent(token || "")}` : `/api/portal/quotes/${encodeURIComponent(quote.id)}`;
  const staffNote = mode === "preview" ? `<p class="staff noprint">Customer view of version ${esc(String(version ? version.n : ""))}. This is what the link shows.</p>` : mode === "present" ? `<p class="staff noprint">Hand the phone to ${esc(first || "the customer")}. When they're done, it comes back to you.</p>` : "";
  const msg = (title, text) => ({ title, body: `${QUOTE_STYLE}<section class="card"><p class="eyebrow">Quote ${esc(label)}</p><h1>${esc(title)}</h1><p>${esc(text)}</p>${mode === "present" ? backToOffice(quote) : `<div class="row"><a class="btn ghost" href="tel:+17633143400">Call us</a></div>`}</section>` });

  if (!version) return msg("This quote isn't ready yet", "We're still putting it together. We'll send it over shortly.");
  if (quote.status === "archived") return msg("This quote has expired", "Call or text us and we'll put together a fresh one for you.");
  if (quote.status === "declined") return msg("You declined this quote", "Changed your mind? Call or text us anytime.");
  if (quote.status === "changes_requested") return msg("We got your note", "Thanks! We'll update your quote and send it back over.");

  const done = ["approved", "converted"].includes(quote.status) && quote.approval;
  const options = [...(version.options || [])].sort((a, b) => (b.recommended ? 1 : 0) - (a.recommended ? 1 : 0));
  const chosenId = (done && quote.approval.option_id) || (options.find((o) => o.recommended) || options[0] || {}).id;
  if (done) {
    const o = options.find((x) => x.id === chosenId) || options[0];
    return {
      title: `Quote ${label}`,
      body: `${QUOTE_STYLE}${staffNote}<section class="card"><p class="eyebrow">Quote ${esc(label)}</p><h1>You're all set${first ? `, ${esc(first)}` : ""}!</h1><p>You approved this quote on ${esc(dateWords(quote.approved_at))}. We'll be in touch to get you on the schedule.</p><div class="row noprint"><button class="btn ghost" type="button" data-print>Print or save as PDF</button></div>${mode === "present" ? backToOffice(quote) : ""}</section>${o ? optionCard({ ...o, lines: (o.lines || []).map((l) => (l.optional ? { ...l, selected: (quote.approval.selected_line_ids || []).includes(l.id) } : l)), totals: quote.approval.totals || o.totals }, { editable: false, chosen: true }) : ""}`,
    };
  }

  const data = {
    quote_id: quote.id, version_id: version.id, sha: version.sha256, mode, base,
    floor: Number.isSafeInteger(floor) ? floor : 0,
    options: options.map((o) => ({
      id: o.id, name: o.name, kind: o.kind, visits: visitsOf(o),
      lines: (o.lines || []).map((l) => ({ id: l.id, c: l.total_cents || 0, s: l.scope || { type: "all" }, o: !!l.optional, sel: l.selected === true })),
      discounts: (o.discounts || []).map((d) => ({ t: d.type, v: d.value, s: d.scope || { type: "all" } })),
    })),
    agreements: Object.keys(version.plan_agreements || {}),
  };
  const plans = options.filter((o) => o.kind === "plan");
  const agreements = plans.map((o) => {
    const a = (version.plan_agreements || {})[o.id];
    const text = a ? paras(a.body_rendered) : `<p>We'll send your ${esc((PLAN_CATALOG[o.plan && o.plan.catalog_key] || { name: "plan" }).name.toLowerCase())} agreement separately.</p>`;
    return `<details class="card" data-agreement-for="${esc(o.id)}"${o.id === chosenId ? "" : " hidden"}><summary>${esc(o.name)}: plan agreement</summary><div class="terms">${text}</div></details>`;
  }).join("");
  const imgs = [...(version.mockup_file_ids || []), ...(version.photo_ids || [])].filter((id) => files.includes(id)).map((id) => `<img src="${esc(`${base}/files/${id}`)}" alt="Photo for your quote" loading="lazy">`).join("");
  const expires = version.expires_on ? ` This price is good through ${esc(dateWords(version.expires_on))}.` : "";
  const approve = editable ? `<section class="card qa" id="approve" data-approve-card>
<h2>Approve your quote</h2>
<p class="qsum">You're choosing <b data-chosen-name></b> at <b data-chosen-price></b>.</p>
<label class="field"><span>Your full name</span><input name="name_typed" autocomplete="name" autocapitalize="words" maxlength="120" enterkeyhint="done"></label>
<div class="sig"><canvas data-sig aria-label="Sign here with your finger"></canvas></div>
<div class="sig-row"><span>Sign above with your finger</span><button type="button" class="linkish" data-sig-clear>Clear</button></div>
<label class="check"><input type="checkbox" name="agree"><span>I agree to the terms${plans.length ? " (and the plan agreement for a plan)" : ""} on this page.</span></label>
<p class="err" data-error hidden></p>
<button class="btn block" type="button" data-approve>Approve</button>
<p class="note" data-working hidden>Processing your approval…</p>
</section>
<section class="card" data-done hidden><h2 data-done-title>You're all set!</h2><p data-done-text>Thanks! We'll be in touch to get you on the schedule.</p><div class="row" data-card hidden><a class="btn block" data-card-link href="/p/card">Add your card</a></div>${mode === "present" ? backToOffice(quote) : ""}</section>` : "";
  const other = mode === "portal" ? `<details class="card qx"><summary>Want something changed?</summary><p>Tell us what you'd like and we'll update your quote.</p><label class="field"><span>What should we change?</span><textarea name="message" maxlength="2000"></textarea></label><p class="err" data-changes-error hidden></p><button class="btn ghost block" type="button" data-changes>Send</button></details>
<details class="card qx"><summary>Not interested?</summary><p>No problem. If you'd like, tell us why so we can do better.</p><label class="field"><span>Reason (optional)</span><input name="reason" maxlength="500"></label><p class="err" data-decline-error hidden></p><button class="btn ghost block" type="button" data-decline>Decline this quote</button></details>` : "";
  return {
    title: `Quote ${label}`,
    body: `${QUOTE_STYLE}${staffNote}<div hidden data-quote="${esc(JSON.stringify(data))}"></div>
<section class="card"><p class="eyebrow">Quote ${esc(label)}</p><h1>${first ? `Hi ${esc(first)}, here's your quote` : "Here's your quote"}</h1><p>${options.length > 1 ? "Pick the option that fits, then approve it below." : "Take a look, then approve it below."}${expires}</p><div class="row noprint"><button class="btn ghost" type="button" data-print>Print or save as PDF</button></div></section>
${options.map((o) => optionCard(o, { editable, chosen: o.id === chosenId })).join("")}
${version.client_notes ? `<section class="card"><h2>A note from us</h2>${paras(version.client_notes)}</section>` : ""}
${imgs ? `<section class="card"><h2>Photos</h2><div class="qphotos">${imgs}</div></section>` : ""}
${agreements}
<details class="card"><summary>Terms</summary><div class="terms">${paras(version.terms_text)}</div></details>
${approve}${other}`,
  };
}

function backToOffice(quote) {
  return `<div class="row"><a class="btn ghost block" href="/office#crm/quotes/${esc(encodeURIComponent(quote.id))}">Back to the quote (staff)</a></div>`;
}

// Which option lines and discounts apply on visit k (the client mirror of the engine uses the same rule).
export { covers };
