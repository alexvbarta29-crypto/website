// Pieces the comms screens share (M6): the stylesheet, words for statuses
// and reasons, a conversation row, a message bubble. No data here, only how
// things read (design §2.3).

import { html, icon, attrs, openExternal } from "../../core/ui.js";
import { time, dateShort, ago, initials } from "../../core/format.js";

let styled = false;
export function ensureStyles() {
  if (styled || typeof document === "undefined") return;
  styled = true;
  const l = document.createElement("link");
  l.rel = "stylesheet";
  l.href = "/crm-app/modules/comms/comms.css";
  document.head.appendChild(l);
}

export const FILTERS = [["all", "All"], ["unread", "Unread"], ["needs_reply", "Needs reply"], ["leads", "Leads"], ["customers", "Customers"], ["mine", "Mine"]];
export const REASON = {
  opted_out: "they opted out of texts", no_consent: "no consent for this kind of message", paused_automations: "automations are paused for them", quiet_hours: "quiet hours",
  no_address: "no number or email on file", missing_variable: "a blank in the template", duplicate: "the same message a moment ago", test_mode_recipient: "test mode only reaches the team's phones",
  paused: "the CRM is paused", template_inactive: "that template is switched off", no_template: "that template is gone",
};
export const reasonText = (r) => REASON[r] || String(r || "").replace(/_/g, " ");
const STATUS = { queued: "Sending", sending: "Sending", sent: "Sent", delivered: "Delivered", received: "", failed: "Not delivered", undelivered: "Not delivered", blocked: "Held back" };
export const statusText = (m) => (m.status === "blocked" && m.blocked_reason ? `Held back: ${reasonText(m.blocked_reason)}` : (m.status === "failed" || m.status === "undelivered") && m.error_code ? `Not delivered (${m.error_code})` : STATUS[m.status] || "");
export const isBad = (m) => ["failed", "undelivered", "blocked"].includes(m.status);
export const ORIGIN = { automation: "automatic", cadence: "follow-up", campaign: "campaign", system: "automatic" };

// A pastel circle per person (the colour follows the name; Rotor's inbox).
const PASTEL = [["#e3ecfb", "#1d4ed8"], ["#e3f5ea", "#0b6b44"], ["#efe8fb", "#5b3fd6"], ["#fdf0dc", "#7a4f12"], ["#fde6e3", "#b42318"], ["#e2f3f4", "#0e6b73"]];
const pastel = (name) => { let h = 0; for (const ch of String(name || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return PASTEL[h % PASTEL.length]; };
export const convRow = (c) => {
  const [bg, fg] = pastel(c.contact_name);
  return html`<li><a class="${"row cm-row" + (c.unread ? " unread" : "")}" href="${"#/inbox/" + encodeURIComponent(c.id)}">
  <span class="avatar cm-av" aria-hidden="true" ${attrs({ style: `background:${bg};color:${fg}` })}>${initials(c.contact_name)}</span>
  <span class="who"><span class="nm"><b>${c.contact_name || "Someone"}</b>${c.channel === "email" ? html`<span class="cm-ch" title="Email">${icon("mail")}</span>` : ""}</span>
    <span class="sub">${c.last_direction === "out" ? "You: " : ""}${c.last_preview || "No messages yet"}</span></span>
  <span class="end"><span class="small muted">${c.last_at ? ago(c.last_at) : ""}</span>${c.unread ? html`<span class="cm-n" role="img" ${attrs({ "aria-label": `${c.unread} unread` })}>${c.unread > 99 ? "99+" : String(c.unread)}</span>` : c.needs_reply ? html`<span class="pill amber">Needs reply</span>` : ""}</span>
</a></li>`;
};

// One message as a bubble. o: { expanded: Set of ids whose whole text is loaded }
export function bubble(m) {
  const out = m.direction === "out";
  const st = statusText(m);
  const from = m.origin && ORIGIN[m.origin.kind] ? ORIGIN[m.origin.kind] : "";
  const files = (m.attachment_file_ids || []);
  return html`<div class="${"cm-msg" + (out ? " out" : "")}" data-msg="${m.id}">
    <div class="${"bubble" + (isBad(m) ? " failed" : "")}">${m.subject ? html`<b>${m.subject}</b>` : ""}${m.body_text || (files.length || m.media_pending ? "" : "(no text)")}${m.more ? "…" : ""}</div>
    ${m.more ? html`<button type="button" class="linkish cm-more" data-whole="${m.id}">Show the whole message</button>` : ""}
    ${files.length ? html`<div class="cm-files">${files.map((f, i) => html`<a ${openExternal(location.origin + "/api/crm/files/" + encodeURIComponent(f))}>${icon("doc")}File ${i + 1}</a>`)}</div>` : ""}
    ${m.media_pending ? html`<span class="cm-meta">Fetching ${m.media_pending} file${m.media_pending === 1 ? "" : "s"}…</span>` : ""}
    ${m.attachments_missing ? html`<span class="cm-meta">${m.attachments_missing} attachment${m.attachments_missing === 1 ? "" : "s"} stayed in Rotor</span>` : ""}
    <span class="${"cm-meta" + (isBad(m) ? " bad" : "")}">${time(m.sent_at)}${st ? " · " + st : ""}${from ? " · " + from : ""}${m.imported ? " · from Rotor" : ""}</span>
  </div>`;
}

// Something waiting in the Outbox (dry run, or held back): never sent.
export const pendingBubble = (p) => html`<div class="cm-msg out">
  <div class="bubble grey">${p.subject ? html`<b>${p.subject}</b>` : ""}${p.body_text}</div>
  <span class="${"cm-meta" + (p.mode === "blocked" ? " bad" : "")}">${time(p.at)} · ${p.mode === "blocked" ? `Held back: ${reasonText(p.blocked_reason)}` : "Not sent (dry run)"}</span>
</div>`;

export const dayLabel = (iso) => dateShort(iso);
export const stars = (n) => "★★★★★".slice(0, n) + "☆☆☆☆☆".slice(0, 5 - n);
export const emptyCard = (ic, title, text) => html`<div class="card empty"><div class="art">${icon(ic)}</div><h2>${title}</h2><p>${text}</p></div>`;
