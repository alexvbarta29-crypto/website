// Pieces the Import screens share (M2c): the module's stylesheet, how a
// run's and a phase's state read, labels for the report's warning codes and
// for the fields a conflict can be about, and how a value from either side
// reads. No data here, only words (design §2.3).

import { html, toast, attrs } from "../../core/ui.js";
import { dateYear, dateShort, ago } from "../../core/format.js";

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

// Steps that wait or are ready, per part of the CRM: each entity's rows
// counted once (two steps may read the same file).
// list: [{ label, module, module_label, entity, rows }] → [{ label, rows, steps: [words] }]
export function byPart(list) {
  const groups = new Map();
  for (const w of list || []) {
    if (!w.rows) continue;
    const k = w.module_label || w.module;
    const g = groups.get(k) || { label: k, entities: new Map(), steps: [] };
    g.entities.set(w.entity, w.rows);
    g.steps.push(String(w.label || "").toLowerCase());
    groups.set(k, g);
  }
  return [...groups.values()].map((g) => ({ label: g.label, rows: [...g.entities.values()].reduce((a, b) => a + b, 0), steps: g.steps }));
}
const partRows = (parts) => html`<dl class="kv">${parts.map((w) => html`<dt>${w.label}</dt><dd>${n(w.rows)} ${w.rows === 1 ? "row" : "rows"}<span class="im-steps">${w.steps.join(", ")}</span></dd>`)}</dl>`;

// "The rest of this export" (the latest finished import): what can be
// brought in now (a part of the CRM went live since), what still waits and
// for which part, and whether the CRM brings it in by itself. rest: GET
// /import/rest. Nothing when the whole export is in.
export function restCard(rest) {
  if (!rest || !rest.run) return "";
  const ready = byPart(rest.ready), waiting = byPart(rest.waiting);
  if (!ready.length && !waiting.length) return "";
  // the rows are gone: nothing can come in from this export any more, whatever is live
  if (rest.staging === "cleared") {
    return html`<section class="card" data-rest>
      <h2>The rest of this export</h2>
      <p class="warn-box">This export's rows were cleared (they are kept 30 days after their last use). Start a new import to bring in the rest.</p>
      <div class="section-h">Not brought in</div>${partRows(byPart([...(rest.ready || []), ...(rest.waiting || [])]))}
    </section>`;
  }
  return html`<section class="card" data-rest>
    <h2>The rest of this export</h2>
    ${ready.length ? html`<div class="section-h">Ready to bring in</div>${partRows(ready)}
      ${rest.active
        ? html`<p class="small muted im-gap">An import is running. <a ${attrs({ href: "#/import/" + rest.active })}>See it</a></p>`
        : html`<p class="small muted im-gap">${rest.auto ? "The CRM brings this in by itself within the hour. No upload, no key." : "No upload, no key: it uses the rows already here."}</p>
          <div class="btn-row"><button type="button" class="btn primary" data-continue>Bring in the rest now</button></div>`}` : ""}
    ${waiting.length ? html`<div class="section-h">Waiting for a part that isn't live yet</div>${partRows(waiting)}
      <p class="small muted im-gap">${rest.auto ? "Each comes in by itself when its part goes live" : "Bringing it in by itself is off (Settings, Data): use the button here when a part goes live"}${rest.keep_until ? `, as long as this export's rows are kept: until ${dateShort(rest.keep_until)}` : ""}. After that, a new import brings it in.</p>` : ""}
  </section>`;
}

// "Bring in the rest now": a continuation of the latest finished import, then its screen.
export async function bringInRest(el, ctx) {
  el.disabled = true;
  try {
    const r = await ctx.api("/import/continue", { method: "POST", body: {} });
    toast("Started. It runs in the background.");
    ctx.go(`/import/${r.data.run.id}`);
  } catch (err) { el.disabled = false; toast(err.message, { bad: true }); }
}
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
