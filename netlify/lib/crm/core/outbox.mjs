// Barta CRM core: the outbox, what would have gone out (design §6.1
// "Dry-run", §5.7.1, §9.2 "Outbox", §0 rule 11).
//
// Until an integration is live (and, for customers, until cutover), every
// text, email, push, charge or refund the CRM decides to make is written
// here instead of being sent: rec/outbox/{id} (prefix ob), listed by day
// (rel/outbox-day/{yyyy-mm-dd}) and by contact (rel/contact-outbox/{cid}).
// A send that was blocked (opted out, no consent, quiet hours, a missing
// variable, a duplicate...) is recorded here too, with its reason, so the
// owner sees exactly what the CRM would and wouldn't have done.
//
// OutboxItem = Envelope & { kind: "sms"|"email"|"push"|"charge"|"refund"|
//   "checkout"|"setup"|"customer"|"meta_event", mode: "dry_run"|"blocked",
//   to_masked, to_hk?, contact_id?, subject?, body?, amount_cents?, related,
//   subject_ref?, origin, category?, template_key?, marker_key?,
//   footer_appended?, segments?, simulated: { status, code? },
//   blocked_reason?, day }
//
// Outbox items are derived bookkeeping: no audit event, no aud/ row, no
// contact activity (a dry-run send leaves the contact's timeline alone).
// Bodies are kept in the store (the Outbox screen shows them); they never
// go to a log.

import { createRecord, listRel, getRecords } from "../../crm-store.mjs";
import { defineType } from "./registry.mjs";
import { localDate, tsKey, now, isLocalDate } from "./clock.mjs";
import { isId } from "./ids.mjs";
import { InputError } from "./errors.mjs";
import { shape, str, enumValue, int } from "./validate.mjs";
import { maskPhone, maskEmail, truncate } from "./text.mjs";

export const OUTBOX_KINDS = Object.freeze(["sms", "email", "push", "charge", "refund", "checkout", "setup", "customer", "meta_event"]);
export const OUTBOX_MODES = Object.freeze(["dry_run", "blocked"]);
export const BLOCK_REASONS = Object.freeze(["opted_out", "no_consent", "paused_automations", "quiet_hours", "no_address", "missing_variable", "duplicate", "test_mode_recipient", "paused", "template_inactive", "no_template"]);

const sortOf = (r) => tsKey(new Date(Date.parse(r.created_at) || 0));

function validateOutbox(data, { op } = {}) {
  const stored = op === "update";
  return shape(data, {
    kind: (v, f) => enumValue(v, OUTBOX_KINDS, { field: f, required: true, stored }),
    mode: (v, f) => enumValue(v, OUTBOX_MODES, { field: f, required: true, stored }),
    to_masked: (v, f) => str(v, { field: f, max: 80 }),
    contact_id: (v, f) => (v === undefined || v === null || v === "" ? undefined : isId(v) ? v : (() => { throw new InputError("That isn't a record id.", f); })()),
    contact_label: (v, f) => (v === undefined || v === null || v === "" ? undefined : str(v, { field: f, max: 80 })),
    subject: (v, f) => (v === undefined || v === null ? undefined : str(v, { field: f, max: 300 })),
    body: (v, f) => (v === undefined || v === null ? undefined : str(v, { field: f, max: 20000, trim: false })),
    amount_cents: (v, f) => int(v, { field: f, min: -100000000, max: 100000000 }),
    day: (v, f) => { if (!isLocalDate(v)) throw new InputError("Missing the day.", f); return v; },
  });
}

export const outboxType = defineType({
  type: "outbox",
  prefix: "ob",
  v: 1,
  validate: validateOutbox,
  rotorFields: [],
  techFields: ["id", "kind", "mode", "created_at"],
  readPerm: "outbox:read",
  shadow: false,
  audit: false,
  rels: [
    { rel: "outbox-day", parent: (r) => r.day, sort: sortOf, value: (r) => ({ k: r.kind, m: r.mode }) },
    { rel: "contact-outbox", parent: (r) => (isId(r.contact_id, "contact") ? r.contact_id : null), sort: sortOf, value: (r) => ({ k: r.kind, m: r.mode }) },
  ],
  summary: (r) => ({ id: r.id, kind: r.kind, mode: r.mode }),
  example: () => ({ kind: "sms", mode: "dry_run", to_masked: "(763) •••-0100", body: "Hi Pat, see you Wednesday.", related: {}, origin: { kind: "system" }, simulated: { status: "sent" }, day: "2026-11-17" }),
});

// "(763) •••-0100" / "j•••@example.com" for an address of a channel.
export const maskFor = (kind, to) => (kind === "email" ? maskEmail(to) : kind === "sms" ? maskPhone(to) : to ? "•••" : "");

// Writes one outbox item (derived data: the guard never stops it).
// item: { kind, mode?, to?, to_hk?, contact_id?, subject?, body?, amount_cents?, related?, subject_ref?, origin?,
//         category?, template_key?, marker_key?, footer_appended?, segments?, simulated?, blocked_reason?, staff? }
export async function recordOutbox(item, ctx = {}) {
  const at = now();
  const rec = await createRecord("outbox", {
    kind: item.kind,
    mode: item.mode || "dry_run",
    to_masked: item.to_masked || maskFor(item.kind, item.to),
    ...(item.to_hk ? { to_hk: item.to_hk } : {}),
    ...(item.contact_id ? { contact_id: item.contact_id } : {}),
    // the contact's name as the Outbox shows it (never the id)
    ...(item.contact_label ? { contact_label: truncate(String(item.contact_label), 80) } : {}),
    ...(item.subject !== undefined ? { subject: item.subject ? truncate(item.subject, 300) : item.subject } : {}),
    ...(item.body !== undefined ? { body: item.body } : {}),
    ...(item.amount_cents !== undefined ? { amount_cents: item.amount_cents } : {}),
    related: item.related || {},
    ...(item.subject_ref ? { subject_ref: item.subject_ref } : {}),
    origin: item.origin || { kind: "system" },
    ...(item.category ? { category: item.category } : {}),
    ...(item.template_key ? { template_key: item.template_key } : {}),
    ...(item.marker_key ? { marker_key: item.marker_key } : {}),
    ...(item.footer_appended !== undefined ? { footer_appended: !!item.footer_appended } : {}),
    ...(item.segments ? { segments: item.segments } : {}),
    ...(item.staff ? { staff: true } : {}),
    simulated: item.simulated || { status: item.mode === "blocked" ? "blocked" : "sent" },
    ...(item.blocked_reason ? { blocked_reason: item.blocked_reason } : {}),
    day: localDate(at),
  }, { by: ctx.by || "system", origin: ctx.origin || "worker", actor_kind: ctx.actor_kind || "automation", requestId: ctx.requestId, mode: ctx.mode });
  return rec.data;
}

// What the Outbox screen lists: one day's items (or one contact's), newest
// first, optionally one kind. `before` continues a page (the last row's sort key).
export async function listOutbox({ date, contact_id, kind, limit = 30, before } = {}) {
  let rows;
  if (contact_id) {
    if (!isId(contact_id, "contact")) throw new InputError("That isn't a contact.", "contact");
    rows = await listRel("contact-outbox", contact_id, { to: before, limit: limit + 1 });
  } else {
    const day = date || localDate(now());
    if (!isLocalDate(day)) throw new InputError("Use a date like 2026-11-17.", "date");
    rows = await listRel("outbox-day", day, { to: before, limit: limit + 1 });
  }
  if (before) rows = rows.filter((r) => r.sortKey < before);
  const page = rows.slice(0, limit);
  const got = await getRecords("outbox", page.map((r) => r.id));
  const items = got.filter((g) => g && g.data).map((g) => g.data).filter((x) => !kind || x.kind === kind);
  return { items: items.map(outboxView), next: rows.length > limit ? page[page.length - 1].sortKey : null };
}

export const outboxView = (o) => ({
  id: o.id, kind: o.kind, mode: o.mode, to_masked: o.to_masked, contact_id: o.contact_id || null, contact_label: o.contact_label || null, subject: o.subject || null,
  body: o.body ?? null, amount_cents: o.amount_cents ?? null, related: o.related || {}, origin: o.origin || null, category: o.category || null,
  template_key: o.template_key || null, footer_appended: !!o.footer_appended, segments: o.segments || null, simulated: o.simulated || null,
  blocked_reason: o.blocked_reason || null, staff: !!o.staff, created_at: o.created_at, day: o.day,
});
