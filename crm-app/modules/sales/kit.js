// Pieces the sales screens share (M2b): the module's stylesheet, words for
// statuses and outcomes, and the three sheets of working a lead: how did
// the call go, the text to send by hand ("Did you send it?") while texting
// is in dry-run, and the compose sheet of a review-before-send step. No
// data here, only how things read (design §2.3).

import { html, icon, sheet, toast, attrs } from "../../core/ui.js";
import { checkbox, busy } from "../../core/forms.js";
import { dateShort, time, timeWindow, ago, plural } from "../../core/format.js";

let styled = false;
export function ensureStyles() {
  if (styled || typeof document === "undefined") return;
  styled = true;
  const l = document.createElement("link");
  l.rel = "stylesheet";
  l.href = "/crm-app/modules/sales/sales.css";
  document.head.appendChild(l);
}

// ------------------------------------------------------------ words

export const OUTCOMES = [
  ["no_answer", "No answer"], ["voicemail", "Left a voicemail"], ["spoke", "Talked"], ["booked", "Booked"],
  ["not_interested", "Not interested"], ["wrong_number", "Wrong number"],
];
export const ENROLLMENT_STATUS = { active: "Active", paused: "Paused", completed: "Done", stopped: "Stopped", archived: "From Rotor" };
const ENR_CLASS = { active: "green", paused: "amber", completed: "", stopped: "", archived: "" };
export const enrollmentPill = (st) => html`<span class="${"pill " + (ENR_CLASS[st] || "")}">${ENROLLMENT_STATUS[st] || st}</span>`;
export const DEAL_STATUS = { open: "Open", quoted: "Quoted", won: "Won", lost: "Lost", abandoned: "Went quiet" };
const DEAL_CLASS = { open: "blue", quoted: "amber", won: "green", lost: "red", abandoned: "" };
export const dealPill = (st) => html`<span class="${"pill " + (DEAL_CLASS[st] || "")}">${DEAL_STATUS[st] || st}</span>`;
export const LOST_REASONS = [
  { value: "no_response", label: "Never heard back" }, { value: "price", label: "Price" }, { value: "timing", label: "Timing" },
  { value: "competitor", label: "Went with someone else" }, { value: "out_of_area", label: "Outside the area" }, { value: "spam", label: "Spam" }, { value: "other", label: "Something else" },
];
export const STOP_REASON = {
  replied: "they replied", inbound_call: "they called in", booked: "booked", opted_out: "opted out of texts", won: "won", lost: "not interested",
  manual: "stopped by hand", expired: "nobody worked it", duplicate: "a duplicate", imported: "from Rotor", quote_sent: "estimate sent", wrong_number: "wrong number",
};
export const PAUSE_REASON = { spoke: "after a call", inbound_call: "they called in", replied: "they replied", manual: "paused by hand" };
export const TASK_KINDS = [
  { value: "todo", label: "To-do" }, { value: "call", label: "Call back" }, { value: "follow_up", label: "Follow up" }, { value: "estimate_visit", label: "Estimate visit" },
  { value: "incident", label: "Incident" }, { value: "touch_up", label: "Touch-up" }, { value: "meeting", label: "Meeting" }, { value: "personal", label: "Personal" },
];
export const taskKindLabel = (k) => (TASK_KINDS.find((x) => x.value === k) || { label: k }).label;
export const PRIORITY = { high: "High", medium: "Medium", low: "Low" };
export const OUTCOME_LABEL = Object.fromEntries(OUTCOMES);

export const winLabel = (row) => (row.due && row.due_end ? timeWindow(hhmm(row.due), hhmm(row.due_end)) : row.due ? time(row.due) : "Any time");
const hhmm = (iso) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${String(p.hour).padStart(2, "0")}:${p.minute}`;
};
export const dueLabel = (iso, now = new Date()) => {
  if (!iso) return "";
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(now);
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date(iso));
  return day === today ? time(iso) : `${dateShort(iso)} ${time(iso)}`;
};
export const age = (iso) => {
  if (!iso) return "";
  const h = Math.round((Date.now() - Date.parse(iso)) / 3600000);
  if (h < 1) return "new";
  if (h < 48) return `${h} h`;
  return plural(Math.round(h / 24), "day");
};
export { ago };

export const telHref = (e164) => "tel:" + String(e164 || "").replace(/[^\d+]/g, "");
export const smsHref = (e164, body) => `sms:${String(e164 || "").replace(/[^\d+]/g, "")}?&body=${encodeURIComponent(String(body || ""))}`;
export const emptyCard = (title, text, ico = "phone") => html`<div class="card empty"><div class="art">${icon(ico)}</div><h2>${title}</h2><p>${text}</p></div>`;

// Copies text: the clipboard API, or the selected text area and the old copy command.
export async function copyText(text, area) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch (e) { /* fall back */ }
  try {
    if (area) { area.focus(); area.select(); area.setSelectionRange(0, 99999); return document.execCommand("copy"); }
  } catch (e) { /* nothing more to try */ }
  return false;
}

const uuid = () => (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : `c-${Date.now()}-${Math.random().toString(16).slice(2)}`);

// ------------------------------------------------------------ the sheets

// "How did the call go?" → POST /calls, then whatever comes next.
// who: { contact_id, enrollment_id?, name, phone }; done(result) when finished.
export function outcomeSheet(ctx, who, { done, smsMode } = {}) {
  ensureStyles();
  const clientId = uuid();
  const s = sheet({
    title: `How did it go?`,
    body: html`<div class="stack">
      <p class="muted small">${who.name}${who.label ? html` · ${who.label}` : ""}</p>
      <div class="sl-outcomes">${OUTCOMES.map(([k, label]) => html`<button type="button" class="${"btn" + (k === "no_answer" || k === "voicemail" ? " primary" : "")}" ${attrs({ "data-outcome": k })}>${label}</button>`)}</div>
      ${checkbox({ label: "I called twice (one touch)", name: "double_dial" })}
      <label class="field"><span>Note (optional)</span><textarea name="note" rows="2" maxlength="1000" placeholder="What did you talk about?"></textarea></label>
    </div>`,
    events: {
      "click [data-outcome]": async (e, b) => {
        const root = s.el;
        root.querySelectorAll("[data-outcome]").forEach((x) => { x.disabled = true; });
        busy(b, true, "Saving…");
        try {
          const r = await ctx.api("/calls", { method: "POST", body: {
            contact_id: who.contact_id, ...(who.enrollment_id ? { enrollment_id: who.enrollment_id } : {}), outcome: b.dataset.outcome,
            double_dial: !!(root.querySelector("[name=double_dial]") || {}).checked, note: (root.querySelector("[name=note]") || {}).value || "", client_id: clientId,
          } });
          s.close();
          afterCall(ctx, who, r.data, { done, smsMode });
        } catch (err) {
          root.querySelectorAll("[data-outcome]").forEach((x) => { x.disabled = false; });
          busy(b, false);
          toast(err.message || "That didn't save.", { bad: true });
        }
      },
    },
  });
  return s;
}

// What comes after a call is logged.
export function afterCall(ctx, who, data = {}, { done, smsMode } = {}) {
  const next = data.next || { kind: "none" };
  const finish = () => { if (done) done(data); };
  if (next.kind === "hand") return handSheet(ctx, who, { ...next, enrollment_id: who.enrollment_id }, { done: finish });
  if (next.kind === "compose") return composeSheet(ctx, who, { ...next, enrollment_id: who.enrollment_id }, { done: finish, smsMode: next.mode || smsMode });
  if (next.kind === "blocked") toast(`Saved. No text: ${blockedLabel(next.reason)}.`, { ms: 4000 });
  else if (next.kind === "sent") toast(next.status === "scheduled" ? "Saved. The text goes out when quiet hours end." : "Saved. Text sent.");
  else toast("Saved");
  finish();
  return null;
}

const BLOCKED = { opted_out: "they opted out", no_consent: "no OK to text them", paused_automations: "automated texts are paused for them", no_address: "no mobile number", missing_variable: "a blank in the text", duplicate: "sent a moment ago" };
export const blockedLabel = (r) => BLOCKED[r] || String(r || "held back").replace(/_/g, " ");

// The text to send by hand while texting is in dry-run: Copy text / Open in
// Messages, then "Did you send it?" (sent_by_hand).
export function handSheet(ctx, who, next, { done } = {}) {
  ensureStyles();
  let how = "copy";
  const s = sheet({
    title: "Send this text yourself",
    body: html`<div class="stack">
      <p class="small muted">Texting from the CRM isn't switched on yet. Paste it into Rotor's inbox, or send it from Messages, then tell the app.</p>
      <div class="bubble sl-text">${next.text}</div>
      <textarea class="sr" readonly data-copy-area>${next.text}</textarea>
      <div class="btn-row sl-two">
        <button type="button" class="btn" data-copy>${icon("copy")}Copy text</button>
        ${who.phone ? html`<a class="btn" ${attrs({ href: next.sms_href || smsHref(who.phone, next.text) })} data-sms>${icon("text")}Open in Messages</a>` : ""}
      </div>
      <div class="sl-ask"><b>Did you send it?</b></div>
      <div class="btn-row sl-two">
        <button type="button" class="btn primary" data-sent>Yes, I sent it</button>
        <button type="button" class="btn" data-later>Not yet</button>
      </div>
      <button type="button" class="linkish" data-skip>Skip this text</button>
    </div>`,
    events: {
      "click [data-copy]": async (e, b) => { how = "copy"; const ok = await copyText(next.text, s.el.querySelector("[data-copy-area]")); toast(ok ? "Copied" : "Select the text and copy it", { bad: !ok }); void b; },
      "click [data-sms]": () => { how = "sms_link"; },
      "click [data-sent]": async (e, b) => {
        busy(b, true);
        try {
          await ctx.api(`/cadence-steps/${encodeURIComponent(next.enrollment_id)}/${next.n}/sent-by-hand`, { method: "POST", body: { how } });
          s.close(); toast("Saved. On to the next step."); if (done) done();
        } catch (err) { busy(b, false); toast(err.message, { bad: true }); }
      },
      "click [data-later]": () => { s.close(); toast("It waits on the list until you send it."); if (done) done(); },
      "click [data-skip]": async (e, b) => {
        busy(b, true, "Skipping…");
        try { await ctx.api(`/enrollments/${encodeURIComponent(next.enrollment_id)}/skip`, { method: "POST", body: {} }); s.close(); toast("Skipped"); if (done) done(); }
        catch (err) { busy(b, false); toast(err.message, { bad: true }); }
      },
    },
  });
  return s;
}

// A review-before-send step (the estimate follow-up): the text, prefilled,
// to read and adjust; then Send (or, while texting is dry-run, send it by
// hand and say so).
export function composeSheet(ctx, who, next, { done, smsMode } = {}) {
  ensureStyles();
  const dry = smsMode !== "live" && smsMode !== "test";
  let how = "copy";
  const s = sheet({
    title: "Read before you send",
    body: html`<div class="stack">
      <p class="small muted">They already talked with you: reference what you discussed, skip or reword anything that doesn't fit.</p>
      <label class="field"><span>Text to ${who.name}</span><textarea name="body" rows="7" maxlength="1600" data-body>${next.text}</textarea></label>
      ${dry ? html`
        <div class="btn-row sl-two">
          <button type="button" class="btn" data-copy>${icon("copy")}Copy text</button>
          ${who.phone ? html`<a class="btn" ${attrs({ href: next.sms_href || smsHref(who.phone, next.text) })} data-sms>${icon("text")}Open in Messages</a>` : ""}
        </div>
        <div class="sl-ask"><b>Did you send it?</b></div>
        <div class="btn-row sl-two"><button type="button" class="btn primary" data-send>Yes, I sent it</button><button type="button" class="btn" data-later>Not yet</button></div>`
        : html`<button type="button" class="btn primary block" data-send>Send</button>`}
      <button type="button" class="linkish" data-skip>Skip this text</button>
    </div>`,
    events: {
      "input [data-body]": (e, el) => { const a = s.el.querySelector("[data-sms]"); if (a && who.phone) a.setAttribute("href", smsHref(who.phone, el.value)); },
      "click [data-copy]": async () => { how = "copy"; const area = s.el.querySelector("[data-body]"); const ok = await copyText(area.value, area); toast(ok ? "Copied" : "Select the text and copy it", { bad: !ok }); },
      "click [data-sms]": () => { how = "sms_link"; },
      "click [data-send]": async (e, b) => {
        const body = s.el.querySelector("[data-body]").value;
        busy(b, true, dry ? "Saving…" : "Sending…");
        try {
          const r = await ctx.api(`/cadence-steps/${encodeURIComponent(next.enrollment_id)}/${next.n}/send`, { method: "POST", body: { body, ...(dry ? { hand: how } : {}) } });
          s.close();
          const k = r.data && r.data.next;
          toast(k && k.kind === "blocked" ? `Not sent: ${blockedLabel(k.reason)}` : dry ? "Saved. On to the next step." : "Sent", { bad: !!(k && k.kind === "blocked") });
          if (done) done();
        } catch (err) { busy(b, false); toast(err.message, { bad: true }); }
      },
      "click [data-later]": () => { s.close(); toast("It waits on the list until you send it."); if (done) done(); },
      "click [data-skip]": async (e, b) => {
        busy(b, true, "Skipping…");
        try { await ctx.api(`/enrollments/${encodeURIComponent(next.enrollment_id)}/skip`, { method: "POST", body: {} }); s.close(); toast("Skipped"); if (done) done(); }
        catch (err) { busy(b, false); toast(err.message, { bad: true }); }
      },
    },
  });
  return s;
}

// A pending text from the list or an enrollment (the call was logged
// earlier; the text still waits).
export function pendingSheet(ctx, who, pending, { done, smsMode } = {}) {
  if (pending.kind === "compose") return composeSheet(ctx, who, pending, { done, smsMode });
  return handSheet(ctx, who, pending, { done });
}

// ------------------------------------------------------------ "call, then come back"

// Remembers a call started from a Call button, so the outcome sheet opens
// when the phone comes back to the app (visibilitychange).
const KEY = "barta-crm-calling";
export function rememberCall(who) {
  try { sessionStorage.setItem(KEY, JSON.stringify({ ...who, at: Date.now() })); } catch (e) { /* private mode */ }
}
export function takeCall({ minMs = 2500, maxMs = 3 * 3600 * 1000 } = {}) {
  try {
    const v = JSON.parse(sessionStorage.getItem(KEY) || "null");
    if (!v) return null;
    const dt = Date.now() - v.at;
    if (dt < minMs) return null;
    sessionStorage.removeItem(KEY);
    return dt > maxMs ? null : v;
  } catch (e) { return null; }
}
export function forgetCall() { try { sessionStorage.removeItem(KEY); } catch (e) { /* nothing */ } }

// Starts a call: the provisional "calling" (holds the thank-you text off),
// then the phone dials (the tel: link does that itself).
export function startCall(ctx, who) {
  rememberCall(who);
  ctx.api("/calls", { method: "POST", body: { contact_id: who.contact_id, ...(who.enrollment_id ? { enrollment_id: who.enrollment_id } : {}), outcome: "calling" } }).catch(() => {});
}

let onVisible = null;
// While a screen with Call buttons is up: when the phone comes back, ask how it went.
export function watchCalls(ctx, { done, smsMode } = {}) {
  if (onVisible) document.removeEventListener("visibilitychange", onVisible);
  onVisible = () => {
    if (document.visibilityState !== "visible") return;
    const who = takeCall();
    if (who) outcomeSheet(ctx, who, { done, smsMode: typeof smsMode === "function" ? smsMode() : smsMode });
  };
  document.addEventListener("visibilitychange", onVisible);
}
export function unwatchCalls() {
  if (onVisible) document.removeEventListener("visibilitychange", onVisible);
  onVisible = null;
}
