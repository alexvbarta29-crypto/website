// Pieces the plans screens share (M3b): the stylesheet, words for statuses,
// plans and billing, months, the visits list, following a run. No data
// here, only how things read (design §2.3).

import { html, icon } from "../../core/ui.js";
import { money } from "../../core/format.js";

let styled = false;
export function ensureStyles() {
  if (styled || typeof document === "undefined") return;
  styled = true;
  const l = document.createElement("link");
  l.rel = "stylesheet";
  l.href = "/crm-app/modules/plans/plans.css";
  document.head.appendChild(l);
}

export const STATUS = { draft: "Draft", pending: "Waiting", active: "Active", paused: "Paused", cancelling: "Ending", cancelled: "Cancelled", expired: "Ended" };
const STATUS_CLASS = { pending: "amber", active: "green", paused: "blue", cancelling: "amber", cancelled: "red", expired: "" };
export const statusPill = (st) => html`<span class="${"pill " + (STATUS_CLASS[st] || "")}">${STATUS[st] || st}</span>`;
export const CHIPS = [["active", "Active"], ["pending", "Waiting"], ["paused", "Paused"], ["cancelling", "Ending"], ["due", "Due this month"], ["clawback", "Clawbacks"], ["cancelled", "Cancelled"], ["expired", "Ended"]];
export const REASONS = { signature: "agreement to sign", card: "card on file" };
export const pendingText = (rs) => (rs || []).map((r) => REASONS[r] || r).join(" and ");
export const PLAN_NAMES = { biannual: "Biannual", quarterly: "Quarterly", monthly: "Monthly", lights_annual: "Christmas lights", custom: "Custom" };
export const BILLING = { barta_standard: "First visit when it's done, then the 1st of each visit's month", after_visit: "After each visit", first_of_month: "The 1st of each visit's month" };
export const ORD = { unscheduled: ["", "To book"], scheduled: ["blue", "Booked"], completed: ["green", "Done"], skipped: ["", "Skipped"], cancelled: ["red", "Cancelled"] };
export const AGREEMENT = { none: "Not sent", draft: "Not sent yet", sent: "Sent, not signed", viewed: "Opened, not signed", signed: "Signed", imported_unknown: "From Rotor (no signature on file)" };
export const SEASON = { sold: "Sold", install_scheduled: "Install booked", installed: "Installed", takedown_scheduled: "Takedown booked", taken_down: "Taken down", stored: "Stored", cancelled: "Cancelled" };
export const SEASON_ORDER = ["sold", "install_scheduled", "installed", "takedown_scheduled", "taken_down", "stored", "cancelled"];
export const CANCEL_REASONS = [["price", "Price"], ["moving", "Moving"], ["service", "Service"], ["not_needed", "Don't need it"], ["other", "Other"]];

const MONTH = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", year: "numeric" });
export const monthLabel = (m) => (/^\d{4}-\d{2}$/.test(String(m || "")) ? MONTH.format(new Date(`${m}-15T12:00:00Z`)) : "");
export const thisMonth = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);

export function planRow(r) {
  const extra = r.st === "pending" ? `waiting for ${pendingText(r.pr) || "the agreement"}` : r.nx ? `next ${monthLabel(r.nx)}` : "";
  return html`<li><a class="row" href="${"#/plans/" + encodeURIComponent(r.id)}">
    <span class="ico">${icon(r.k === "lights_annual" ? "gift" : "schedule")}</span>
    <span class="who"><span class="nm">${r.cn || "No name"}</span><span class="sub">${r.nm}${extra ? ` · ${extra}` : ""}${r.ap ? " · autopay" : ""}</span></span>
    <span class="end">${statusPill(r.st)}<span class="chev" aria-hidden="true"></span></span></a></li>`;
}

export const emptyCard = (title, text) => html`<div class="card empty"><div class="art">${icon("schedule")}</div><h2>${title}</h2><p>${text}</p></div>`;

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

export const cents = (c) => money(c || 0);
