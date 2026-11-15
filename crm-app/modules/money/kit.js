// Pieces the money screens share (M5): the stylesheet, words for statuses
// and methods, rows, following a run. No data here, only how things read
// (design §2.3).

import { html, icon, raw } from "../../core/ui.js";
import { money, dateShort } from "../../core/format.js";

let styled = false;
export function ensureStyles() {
  if (styled || typeof document === "undefined") return;
  styled = true;
  const l = document.createElement("link");
  l.rel = "stylesheet";
  l.href = "/crm-app/modules/money/money.css";
  document.head.appendChild(l);
}

export const STATUS = { draft: "Draft", open: "Open", paid: "Paid", void: "Void", uncollectible: "Written off" };
// A row or an invoice → [pill class, words]: what the office needs to see first.
export function statusOf(r) {
  const st = r.st || r.status;
  if (st === "paid") return ["green", (r.ex || r.excess_cents) > 0 ? "Overpaid" : "Paid"];
  if (st === "draft") return ["", "Draft"];
  if (st === "void") return ["", "Void"];
  if (st === "uncollectible") return ["", "Written off"];
  if (r.pr) return ["blue", "Clearing"];
  if (r.af) return ["red", "Card failed"];
  if (r.od) return ["red", "Overdue"];
  if (r.pp) return ["amber", "Part paid"];
  return ["amber", "Open"];
}
export const statusPill = (r) => { const [cls, words] = statusOf(r); return html`<span class="${"pill " + cls}">${words}</span>`; };

export const KIND = { standard: "Invoice", deposit: "Deposit", plan_cycle: "Plan billing", fee: "Fee" };
export const METHOD = { card: "Card", ach: "Bank", cash: "Cash", check: "Check", other: "Other", credit: "Credit", imported: "From Rotor" };
export const PAY_STATUS = { pending: ["", "Pending"], processing: ["blue", "Clearing"], succeeded: ["green", "Paid"], failed: ["red", "Failed"], canceled: ["", "Cancelled"] };
export const CHIPS = [["open", "Open"], ["overdue", "Overdue"], ["draft", "Draft"], ["failed", "Card failed"], ["overpaid", "Overpaid"], ["paid", "Paid"], ["void", "Void"]];
export const CARD = { none: "No card on file", on_file: "On file", verified: "On file", missing_in_stripe: "Not found at Stripe", expired: "Expired", failed: "Failed last time" };

export function invoiceRow(r) {
  const sub = [r.n, r.k && r.k !== "standard" ? KIND[r.k] : null, r.st === "open" && r.due ? `due ${dateShort(r.due)}` : r.iss ? dateShort(r.iss) : null].filter(Boolean).join(" · ");
  return html`<li><a class="row" href="${"#/invoices/" + encodeURIComponent(r.id)}">
    <span class="ico">${icon("doc")}</span>
    <span class="who"><span class="nm">${r.cn || "No name"}</span><span class="sub">${sub}</span></span>
    <span class="end mn-end"><span class="num mn-amt">${money(r.st === "open" ? r.bal : r.tot)}</span>${statusPill(r)}</span></a></li>`;
}

export function paymentRow(p, { link = true } = {}) {
  const [cls, words] = PAY_STATUS[p.st] || ["", p.st];
  const refund = p.k === "refund";
  const body = html`<span class="ico">${icon("money")}</span>
    <span class="who"><span class="nm">${p.cn || (refund ? "Refund" : "Payment")}</span><span class="sub">${[refund ? "Refund" : METHOD[p.m] || p.m, p.inn, dateShort(p.on), p.sim ? "test" : null].filter(Boolean).join(" · ")}</span></span>
    <span class="end mn-end"><span class="num mn-amt">${refund ? "−" : ""}${money(p.a + (p.tip || 0))}</span>${p.st !== "succeeded" || refund ? html`<span class="${"pill " + (refund ? "" : cls)}">${refund ? "Refund" : words}</span>` : p.tip ? html`<span class="small muted num">tip ${money(p.tip)}</span>` : ""}</span>`;
  return link && p.inv ? html`<li><a class="row" href="${"#/invoices/" + encodeURIComponent(p.inv)}">${body}</a></li>` : html`<li><div class="row">${body}</div></li>`;
}

export const emptyCard = (title, text) => html`<div class="card empty"><div class="art">${icon("money")}</div><h2>${title}</h2><p>${text}</p></div>`;

// Follows a run until it finishes (GET /runs/:id). → the run, or null after ~30 s.
export async function waitRun(api, id, { tries = 30, every = 1000 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await api(`/runs/${encodeURIComponent(id)}`, { cache: false });
      if (r.data && ["done", "failed", "cancelled"].includes(r.data.status)) return r.data;
    } catch (e) { if (e.status && e.status !== 503) throw e; }
    await new Promise((ok) => setTimeout(ok, every));
  }
  return null;
}

const MONTH = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", year: "numeric" });
export const monthLabel = (m) => (/^\d{4}-\d{2}$/.test(String(m || "")) ? MONTH.format(new Date(`${m}-15T12:00:00Z`)) : "");
export const addMonth = (m, n) => { const [y, mo] = m.split("-").map(Number); const d = new Date(Date.UTC(y, mo - 1 + n, 15)); return d.toISOString().slice(0, 7); };
export const thisMonth = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);

// What the payments mode means, in the office's words.
export const MODE = {
  dry_run: ["Dry run", "Nothing is charged. Payments are practice only, and only for test contacts and customers Rotor doesn't bill."],
  test: ["Test", "Stripe's test mode with the test key: no real money moves."],
  live: ["Live", "Real cards are charged."],
  off: ["Paused", "No payment can be made right now."],
};

// The icons Rotor's phone invoice and payment sheet use that the shared set doesn't have (static, trusted).
const svg = (d) => raw(`<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${d}</svg>`);
export const MI = {
  save: svg('<path d="M5 4h11l3 3v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>'),
  card: svg('<rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="M3 10h18"/>'),
  tap: svg('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.2a4 4 0 0 1 0 5.6M12 7.4a6.5 6.5 0 0 1 0 9.2M14.5 5.8a9 9 0 0 1 0 12.4"/>'),
  dollar: svg('<path d="M12 3v18M16.5 7.5c-.6-1.4-2.2-2.3-4.5-2.3-2.6 0-4.3 1.3-4.3 3.2 0 4.6 9 2.4 9 7 0 2-1.9 3.4-4.7 3.4-2.4 0-4.2-1-4.8-2.6"/>'),
  mail: svg('<rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="M3.5 6.5l8.5 6.5 8.5-6.5"/>'),
  tag: svg('<path d="M3.5 12.2V4.5a1 1 0 0 1 1-1h7.7l8.3 8.3a1 1 0 0 1 0 1.4l-7.3 7.3a1 1 0 0 1-1.4 0z"/><circle cx="8" cy="8" r="1.5"/>'),
  plusc: svg('<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>'),
  home: svg('<path d="M4 11.5 12 5l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5h-5v5H5a1 1 0 0 1-1-1z"/>'),
  user: svg('<circle cx="12" cy="8.5" r="3.5"/><path d="M5 19.5c1.2-3.3 3.9-5 7-5s5.8 1.7 7 5"/>'),
  updown: svg('<path d="M8 9.5 12 5.5l4 4M8 14.5l4 4 4-4"/>'),
  bin: svg('<path d="M4.5 6.5h15M9.5 6.5V4.5h5v2M6.5 6.5l1 13h9l1-13M10.5 10v6.5M13.5 10v6.5"/>'),
  x: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  xc: svg('<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>'),
  cal: svg('<rect x="4" y="5.5" width="16" height="14.5" rx="2"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>'),
  chev: svg('<path d="M7 10l5 5 5-5"/>'),
  send: svg('<path d="M20.5 3.5 10 14M20.5 3.5 14 20.5l-4-6.5-6.5-4z"/>'),
};
