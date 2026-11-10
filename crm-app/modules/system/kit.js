// Small pieces the system screens share (M1.3): reading and saving a
// settings document with its etag, the day switcher, mode and status pills,
// and a few labels. No data in here, only how things read.

import { html, icon, attrs, toast } from "../../core/ui.js";
import { dateShort, localDate } from "../../core/format.js";

// GET /settings/:name → { data, etag, defaults, perm }
export async function loadDoc(ctx, name) {
  const r = await ctx.api(`/settings/${name}`, { cache: false });
  return { name, data: r.data.data, etag: r.data.etag || "new", defaults: r.data.defaults, perm: r.data.perm };
}

// PUT the whole document with If-Match. → the saved doc; a 412 shows a toast and reloads.
export async function saveDoc(ctx, doc, value) {
  try {
    const r = await ctx.api(`/settings/${doc.name}`, { method: "PUT", body: value, ifMatch: doc.etag || "new" });
    doc.data = r.data.data;
    doc.etag = r.data.etag;
    return doc;
  } catch (err) {
    if (err.status === 412) { toast("Someone else just changed these settings. Showing the latest.", { bad: true }); ctx.refresh(); }
    throw err;
  }
}

export const addDays = (date, n) => new Date(Date.parse(date + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);
export const today = () => localDate(new Date());

// ‹ Wed, Nov 19 › with Today in between when it isn't today.
export function dayBar(date) {
  const isToday = date === today();
  return html`<div class="daybar">
    <button type="button" class="icon-btn" data-day="-1" aria-label="Day before">${icon("back")}</button>
    <span class="d">${isToday ? "Today" : dateShort(date)}</span>
    ${isToday ? "" : html`<button type="button" class="chip" data-day="today">Today</button>`}
    <button type="button" class="icon-btn flip" data-day="1" aria-label="Day after" ${attrs({ disabled: isToday })}>${icon("back")}</button>
  </div>`;
}
export function nextDay(current, step) {
  if (step === "today") return today();
  const d = addDays(current, Number(step));
  return d > today() ? today() : d;
}

export const MODE_LABEL = { off: "Off", dry_run: "Dry run", test: "Test", live: "Live" };
export function modePill(mode) {
  const cls = mode === "live" ? "green" : mode === "test" ? "blue" : mode === "off" ? "red" : "amber";
  return html`<span class="pill ${cls}">${MODE_LABEL[mode] || mode}</span>`;
}

export const REASONS = {
  opted_out: "opted out", no_consent: "no consent", paused_automations: "automations paused for them", quiet_hours: "quiet hours",
  no_address: "no number or email", missing_variable: "a blank in the template", duplicate: "sent the same a moment ago",
  test_mode_recipient: "not on the test list", paused: "the CRM is paused", template_inactive: "template turned off", no_template: "no template",
  archived: "archived", excluded_flag: "test, vendor or spam", no_contact: "contact gone", changed: "it changed since",
  disabled: "turned off", before_floor: "before the switch-over", imported: "came from Rotor", imported_past: "came from Rotor (past)", done: "already done",
};
export const reasonLabel = (r) => REASONS[String(r || "").replace(/^skipped:/, "")] || String(r || "").replace(/^skipped:/, "").replace(/_/g, " ");

export const KIND_ICON = { sms: "text", email: "mail", push: "bell", charge: "money", refund: "money", checkout: "money", setup: "money", customer: "money", meta_event: "send" };
export const KIND_LABEL = { sms: "Text", email: "Email", push: "Push", charge: "Charge", refund: "Refund", checkout: "Checkout", setup: "Card setup", customer: "Stripe customer", meta_event: "Meta event" };
