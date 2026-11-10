// Pieces the Import screens share (M2c): the module's stylesheet, how a
// run's and a phase's state read, labels for the report's warning codes and
// for the fields a conflict can be about, and how a value from either side
// reads. No data here, only words (design §2.3).

import { html } from "../../core/ui.js";
import { dateYear, ago } from "../../core/format.js";

let styled = false;
// The module's own stylesheet, once (CSP: style-src 'self').
export function ensureStyles() {
  if (styled || typeof document === "undefined") return;
  styled = true;
  const l = document.createElement("link");
  l.rel = "stylesheet";
  l.href = "/crm-app/modules/import/import.css";
  document.head.appendChild(l);
}

const RUN = {
  uploading: ["amber", "Waiting for the upload"], queued: ["blue", "Starting"], running: ["blue", "Importing"],
  done: ["green", "Done"], cancelled: ["red", "Cancelled"], failed: ["red", "Stopped"],
};
// A run's pill. lane: the lane run ({ status }); a lane that gave up shows "Stopped".
export function runPill(run, lane) {
  if (run.status === "running" && lane && (lane.status === "failed" || lane.status === "cancelled")) return html`<span class="pill red">Stopped</span>`;
  if (run.status === "done" && run.conflicts && run.conflicts.open) return html`<span class="pill amber">Done · ${run.conflicts.open} to settle</span>`;
  const [cls, label] = RUN[run.status] || ["", run.status];
  return html`<span class="${"pill " + cls}">${label}</span>`;
}

export function phasePill(p) {
  if (p.status === "done") return html`<span class="pill green">Done</span>`;
  if (p.status === "empty") return html`<span class="pill">Nothing to import</span>`;
  if (p.status === "running") return html`<span class="pill blue">Importing</span>`;
  if (p.status === "waiting") return html`<span class="pill amber">${p.waiting_label ? "Waits for " + p.waiting_label : "Waiting"}</span>`;
  return html`<span class="pill">Next</span>`;
}

export const exportLabel = (asOf) => (asOf ? `Export of ${dateYear(asOf)}` : "Rotor export");
export const whenLabel = (iso) => (iso ? ago(iso) : "");
export const n = (x) => Number(x || 0).toLocaleString("en-US");

// The data-quality and integrity codes of the report, in words.
const WARN = {
  phone_twelve_digits: "Phones with 12 digits (not kept)", phone_invalid: "Phones that don't look right", email_invalid: "Emails that don't look right",
  address_state: "States repaired from the ZIP", address_country: "Countries tidied", deal_waits_for_sales: "Lead deals waiting for Sales",
  follow_up_waits_for_sales: "Follow-up dates waiting for Sales", property_no_address: "Rows using the contact's own address", property_no_contact: "Addresses whose contact isn't here",
  quote_contact_unknown: "Quote contacts not found yet", user_matched_name: "Team members matched by name", user_matched_first_name: "Team members matched by first name",
  user_matched_override: "Team members you matched", user_matched_pointer: "Team members matched before", user_created: "New team members (invited)",
  pointer_taken: "Rotor ids already linked to another record", placeholder: "Placeholders for missing contacts", entrant_no_contact: "Giveaway entrants with no contact",
  entrant_no_phone: "Giveaway entrants with no phone", referral_no_contact: "Referrals with no contact", referral_no_phone: "Referrals with no phone",
  stop_without_number: "STOP replies with no number", availability_no_user: "Availability for a member not on the team", rate_no_user: "Pay rates for a member not on the team",
};
export const warnLabel = (code) => WARN[code] || String(code || "").replace(/^invalid_/, "Rows refused: ").replace(/_/g, " ");

const FIELDS = {
  first_name: "First name", last_name: "Last name", company_name: "Company", phones: "Phones", emails: "Emails", billing_address: "Address", source: "Source",
  tags: "Tags", notes: "Notes", owner_id: "Owner", watcher_ids: "Also following", lifecycle: "Lifecycle", archived_reason: "Archived because", "flags.vendor": "Vendor",
  kind: "Person or business", label: "Label", address: "Address", rotor: "Rotor ids",
};
export const fieldLabel = (f) => FIELDS[f] || String(f || "").replace(/[._]/g, " ");
export const TYPE_LABEL = { contact: "Contact", property: "Property", user: "Team member" };

// A stored value as a short line of text (both sides of a conflict).
export function valueText(v) {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "string") return v.length > 240 ? v.slice(0, 240) + "…" : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.length ? v.map((x) => (x && typeof x === "object" ? x.e164 || x.address || x.street1 || JSON.stringify(x) : String(x))).join(", ") : "—";
  if (v.street1 !== undefined || v.city !== undefined) return [v.street1, v.street2, v.city, [v.state, v.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ") || "—";
  if (v.source !== undefined) return [v.source, v.form, v.ad, v.channel].filter(Boolean).join(" · ");
  return Object.entries(v).filter(([, x]) => x !== null && x !== undefined && x !== "").map(([k, x]) => `${k}: ${typeof x === "object" ? JSON.stringify(x) : x}`).join(" · ").slice(0, 240) || "—";
}
