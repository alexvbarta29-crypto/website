// The switch from Rotor (design §10.9, §11.4 M8; docs/CRM-CUTOVER.md).
//
// Rotor is never called, changed or cancelled from here. What would change
// Rotor (switching its automations off, cancelling it, moving the texting
// number) is an owner-run checklist item: the owner does it in Rotor or at
// Twilio and ticks it here.
//
//   - The checklist: each item green or red. Items the CRM can check are
//     worked out on every read (setup, the worker, the off-site backup,
//     Stripe, Twilio and email connected, the final import, the approved
//     preview); the rest are tick boxes only the owner can confirm. On a
//     deploy that is not the production site (a rehearsal on a test copy)
//     the production-only items read "rehearsal" and pass, and Stripe,
//     Twilio and email pass in test mode too.
//   - The preview (cutover-preview.mjs): what would go out from the switch
//     to 72 hours after it, per automation and day. The owner approves it.
//   - The switch (POST /cutover/run, typed SWITCH TO CRM): a journaled op
//     op/cutover--{n} (core/ops.mjs), stepped by a bulk-lane run:
//       1. numbers: seq/job, seq/invoice, seq/quote above every number
//          already taken (Rotor's imported ones and any the CRM issued),
//          never lower than they are;
//       2. seed: done/ markers from the imported Rotor texts (REMINDER,
//          overdue, receipt, agreement), so nothing Rotor already sent is
//          sent again;
//       3. dry_sends: every queued send started in dry-run is cancelled
//          (its queue item deleted), never resumed;
//       4. follow_ups: open follow-up sequences on customers' contacts (they
//          ran in dry-run) are stopped through sales.stopAll;
//       5. settings: cfg/automations.effective_from = the switch time (the
//          floor: nothing the import brought in, completed or due before it
//          is reminded or asked for a review), intake "crm", the dashboard's
//          source "crm";
//       6. mode: sys/mode.system_of_record = "crm", cutover_n, cutover_at.
//     The integrations are NOT switched here: sends stay dry-run until the
//     owner connected each provider (Settings → Integrations), which the
//     checklist requires on the production site.
//   - Rollback (POST /cutover/rollback, typed SWITCH BACK TO ROTOR, within
//     48 hours): op/rollback--{n}: system_of_record "rotor", intake "dual",
//     the dashboard back on Rotor; the records the CRM made since the switch
//     are listed for re-entry in Rotor; the "Rotor's automations are off"
//     tick and the preview's approval are cleared (the owner turns Rotor's
//     automations back on).
//   - A re-cutover is a new op, cutover--{n+1}: a newer import first (the
//     checklist asks for it), then the same steps; the numbers step re-seats
//     each sequence above every number issued meanwhile.
//   - In-flight documents (D37): quotes sent in the last 30 days, open
//     invoices Rotor issued and unsigned agreements, each list a bulk run
//     (test send + an owner's confirm) pointing the customer to the portal.

import { getRaw, settledWrite, readIndex, listKeys, getRecords, listRel, setSequence, getSettingWithEtag, putSetting, deleteRaw, appendEvent } from "../../../crm-store.mjs";
import { defineOp, runOp, readOp } from "../../core/ops.mjs";
import { defineRun, createRun, getRun, readHealth, laneStatus } from "../../core/lanes.mjs";
import { deriveId, isId } from "../../core/ids.mjs";
import { now, nowIso, nowMs, localDate, addLocalDays, tsKey } from "../../core/clock.mjs";
import { InputError, ConflictError, NotFoundError, StaleError, BlobsTransientError, UnknownOutcome, TimeoutError, BudgetError } from "../../core/errors.mjs";
import { readSysMode, updateSysMode } from "../../core/settings.mjs";
import { setupStatus, INTEGRATION_SECRETS, sandboxed } from "../../core/context.mjs";
import { getSettingsDef } from "../../core/registry.mjs";
import { has, call } from "../../core/services.mjs";
import { notify, approvers } from "../../core/notify.mjs";
import { createBulkRun } from "../../core/bulk.mjs";
import { keySafe } from "../../core/text.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { latestDone } from "./continue.mjs";

export const CUTOVER_KEY = "sys/cutover";
export const CONFIRM_SWITCH = "SWITCH TO CRM";
export const CONFIRM_ROLLBACK = "SWITCH BACK TO ROTOR";
export const ROLLBACK_HOURS = 48;
export const FINAL_IMPORT_HOURS = 24;
export const PREVIEW_VALID_HOURS = 24;
export const BACKUP_MAX_DAYS = 8;
export const SEED_WINDOW_DAYS = 30;
// Rotor's 6-digit random INV- numbers are kept on imported invoices; the CRM's sequence goes on from its 4-5 digit ones (§3.9, D31)
export const INVOICE_SEQ_MAX = 100000;
const DAY = 86400000;
const HOUR = 3600000;
const SYSTEM = { by: "system", origin: "worker", actor_kind: "automation", requestId: "cutover" };

// ------------------------------------------------------------ the state

// sys/cutover = { ticks: { [item]: { at, by } }, preview: { run_id, status, at, import_run_id, created_at, computed_at?,
//   totals?, approved_at?, approved_by? }, history: [{ kind, n, op_id, run_id, at, by, status, result? }],
//   in_flight: { [kind]: { bulk_run_id, at, by, count } }, rollback_list?: [...] }
export async function readCutover() {
  const got = await getRaw(CUTOVER_KEY);
  const d = got && got.data ? { ...got.data } : {};
  delete d._w;
  return { ticks: {}, preview: null, history: [], in_flight: {}, ...d, etag: got ? got.etag : null };
}

export async function updateCutover(mutate) {
  for (let i = 0; i < 6; i++) {
    const cur = await getRaw(CUTOVER_KEY);
    const base = { ticks: {}, preview: null, history: [], in_flight: {}, ...(cur && cur.data ? cur.data : {}) };
    delete base._w;
    const next = mutate(JSON.parse(JSON.stringify(base)));
    if (!next) return base;
    const w = await settledWrite(CUTOVER_KEY, { ...next, updated_at: nowIso() }, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
    if (w.ok) return next;
  }
  throw new StaleError(null, null, "The switch-over page kept changing. Try again.");
}

// ------------------------------------------------------------ the checklist

// Owner-run items: only the owner can confirm them (each is something done
// outside the CRM: in Rotor, at Twilio, in Netlify, on the website).
export const OWNER_ITEMS = Object.freeze([
  { key: "deploy_settings", group: "Platform", label: "Netlify: Deploy Previews and branch deploys off; the CRM's secrets set for Production only" },
  { key: "sms_number", group: "Accounts", label: "Texting for (763) 314-3400 moved to Twilio (the hosting order is active), 10DLC approved, HELP text set, YES removed from the opt-in keywords" },
  { key: "cards", group: "Accounts", label: "Autopay cards checked in Stripe: 95% or more verified, card links sent to the rest" },
  { key: "meta", group: "Accounts", label: "A Meta lead path is live and tested (Zapier into the CRM's lead webhook)" },
  { key: "agreements", group: "Content and money", label: "Agreement templates approved" },
  { key: "jan1", group: "Content and money", label: "The Jan 1 billing comparison matched: the CRM's preview against Rotor's Jan 1 charges, line by line" },
  { key: "claude", group: "Claude and Meta", label: "Claude's Barta skill and scheduled tasks use the CRM connector, and a test prompt worked" },
  { key: "portal_links", group: "Public site", label: "The website's Client Portal links point to /p/login" },
  { key: "in_flight", group: "Data", label: "In-flight documents sent: quotes re-sent, open invoices re-issued, unsigned agreements re-requested (each a bulk run you tested and confirmed)" },
  { key: "rotor_off", group: "Data", label: "Rotor's automations switched off by you (new-lead text, reminders, overdue texts). Do this last, right before the switch" },
]);
const OWNER_KEYS = new Set(OWNER_ITEMS.map((i) => i.key));
// cleared by a rollback: Rotor's automations are back on, and the preview must be looked at again
const CLEARED_BY_ROLLBACK = ["rotor_off"];

const hasAll = (names, env) => names.every((n) => typeof env[n] === "string" && env[n] !== "");

// One integration: "ok" (live with its keys on the production site), "rehearsal" (test or live
// with test keys off the production site), "todo".
function integrationState(kind, integrations, deploy, env) {
  const mode = (integrations && integrations[kind] && integrations[kind].mode) || "dry_run";
  const secrets = INTEGRATION_SECRETS[kind];
  if (deploy && deploy.prod) return mode === "live" && hasAll(secrets.live, env) ? "ok" : "todo";
  if ((mode === "live" || mode === "test") && hasAll(secrets.test, env)) return "rehearsal";
  return "todo";
}

// The latest finished import, the conflicts it (and the imports it continues) left, and whether one runs now.
export async function importState() {
  const ix = await readIndex("import-runs", "");
  const row = latestDone(ix.rows);
  let conflicts = 0;
  for (let r = row, i = 0; r && i < 50; i++) {
    conflicts += (r.sum && r.sum.conflicts) || 0;
    r = r.cont ? ix.rows.find((x) => x.id === r.cont) : null;
  }
  return { latest: row ? { id: row.id, as_of: row.asof || null, finished_at: row.fin || null } : null, conflicts, active: ix.rows.some((r) => r.st === "queued" || r.st === "running") };
}

// Whether the approved preview still stands: made on the latest finished import, in the last day.
export function previewCurrent(preview, imp, t = nowMs()) {
  if (!preview || preview.status !== "done" || !imp.latest) return false;
  if (preview.import_run_id !== imp.latest.id) return false;
  return Date.parse(preview.computed_at || preview.created_at) + PREVIEW_VALID_HOURS * HOUR > t;
}

// → { items: [{ key, group, label, kind: "auto"|"owner", state: "ok"|"todo"|"rehearsal", detail?, ticked? }], ready, rehearsal }
export async function checklist({ deploy, env = process.env, state, mode } = {}) {
  const [st, sys, health, integrations, imp] = await Promise.all([
    state || readCutover(), mode || readSysMode(), readHealth(), getSettingWithEtag("integrations").then((g) => g.data), importState(),
  ]);
  const prod = !!(deploy && deploy.prod);
  const t = nowMs();
  const items = [];
  const auto = (key, group, label, ok, detail) => items.push({ key, group, label, kind: "auto", state: ok === true ? "ok" : ok === "rehearsal" ? "rehearsal" : "todo", ...(detail ? { detail } : {}) });

  const setup = setupStatus(deploy, env);
  auto("setup", "Platform", "The CRM's Netlify settings are in (Production only)", prod ? setup.missing.length === 0 : "rehearsal",
    prod ? (setup.missing.length ? `Missing: ${setup.missing.join(", ")}` : null) : "Not the production site: checked on the real switch-over");
  const lanes = ["fast", "bulk"].map((l) => laneStatus(health, l, t));
  auto("worker", "Platform", "The CRM's background worker is running (both lanes passed in the last 3 hours)", lanes.every((s) => s === "ok"), lanes.every((s) => s === "ok") ? null : "Open Settings, Data to see the worker's health.");
  const off = Date.parse(health.offsite_at || "");
  const backupOk = Number.isFinite(off) && off + BACKUP_MAX_DAYS * DAY > t;
  auto("backup", "Platform", "An off-site backup in the last 8 days", prod ? backupOk : backupOk || "rehearsal", backupOk ? null : prod ? "Pull a backup (Settings, Data)." : "Not the production site: checked on the real switch-over");
  for (const [kind, label] of [["payments", "Stripe connected (live, Barta's account)"], ["sms", "Twilio connected (live, the Messaging Service)"], ["email", "Email connected (live, the domain verified)"]]) {
    const s = integrationState(kind, integrations, deploy, env);
    auto(kind === "payments" ? "stripe" : kind === "sms" ? "twilio" : "email", "Accounts", label, s === "ok" ? true : s === "rehearsal" ? "rehearsal" : false,
      s === "todo" ? "Settings, Integrations: connect it and set it to live." : s === "rehearsal" ? "Test mode (a rehearsal)" : null);
  }
  const fin = imp.latest ? Date.parse(imp.latest.finished_at || "") : NaN;
  const fresh = Number.isFinite(fin) && fin + FINAL_IMPORT_HOURS * HOUR > t;
  auto("final_import", "Data", "Final import done in the last 24 hours, nothing to settle", fresh && imp.conflicts === 0 && !imp.active,
    !imp.latest ? "No import has finished yet." : imp.active ? "An import is running." : !fresh ? "The last import finished more than a day ago: run the final one." : imp.conflicts ? `${imp.conflicts} ${imp.conflicts === 1 ? "field" : "fields"} to settle on the Import screen.` : null);
  for (const it of OWNER_ITEMS) {
    const tick = st.ticks && st.ticks[it.key];
    items.push({ key: it.key, group: it.group, label: it.label, kind: "owner", state: tick ? "ok" : "todo", ...(tick ? { ticked: { at: tick.at, by: tick.by } } : {}) });
  }
  const p = st.preview;
  const current = previewCurrent(p, imp, t);
  auto("preview", "Preview approved", "The switch-over preview is approved (made on the final import)", current && !!p.approved_at,
    !p ? "Make the preview." : p.status !== "done" ? "The preview is being made." : !current ? "Make the preview again: a newer import finished, or it's more than a day old." : !p.approved_at ? "Look at the counts and approve them." : null);
  const ready = items.every((i) => i.state !== "todo");
  return { items, ready, rehearsal: !prod, mode: { system_of_record: sys.system_of_record || "rotor", cutover_n: sys.cutover_n || 0, cutover_at: sys.cutover_at || null, paused: !!sys.paused }, import: imp };
}

export async function setTick(key, done, ctx) {
  if (!OWNER_KEYS.has(key)) throw new InputError("That isn't one of the items you tick.", "key");
  if (typeof done !== "boolean") throw new InputError("Yes or no.", "done");
  const next = await updateCutover((s) => {
    const ticks = { ...(s.ticks || {}) };
    if (done) { if (ticks[key]) return null; ticks[key] = { at: nowIso(), by: ctx.by || "system" }; } else { if (!ticks[key]) return null; delete ticks[key]; }
    return { ...s, ticks };
  });
  await appendEvent("sys", "cutover", { action: done ? "tick" : "untick", by: ctx.by || "system", origin: "api", item: key }).catch(() => {});
  return next;
}

// ------------------------------------------------------------ numbers (step 1)

// The highest number taken in a sequence (its ptr/{seq}-no/{n} pointers: imported Rotor numbers and the CRM's own).
async function maxTaken(seq, below = Infinity) {
  const keys = await listKeys(`ptr/${seq}-no/`);
  let max = 0;
  for (const k of keys) {
    const n = Number(k.slice(k.lastIndexOf("/") + 1));
    if (Number.isSafeInteger(n) && n > max && n < below) max = n;
  }
  return max;
}
// → { job, invoice, quote }: the next number of each sequence, never lower than it is now.
export async function numberPlan() {
  const out = {};
  for (const [seq, below] of [["job", Infinity], ["invoice", INVOICE_SEQ_MAX], ["quote", Infinity]]) {
    const [max, cur] = await Promise.all([maxTaken(seq, below), getRaw(`seq/${seq}`)]);
    const next = cur && cur.data && Number.isSafeInteger(cur.data.next) ? cur.data.next : 1;
    out[seq] = Math.max(max + 1, next);
  }
  return out;
}

// ------------------------------------------------------------ seeded markers (step 2)

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad2 = (n) => String(n).padStart(2, "0");

// The visit date a Rotor REMINDER text names, from the day it was sent:
// "... scheduled to visit on Mon, Jan 5 ...", "on January 5", "tomorrow", "today". → "YYYY-MM-DD" | null
export function reminderDate(text, sentDay) {
  const s = String(text || "");
  if (/\btomorrow\b/i.test(s)) return addLocalDays(sentDay, 1);
  if (/\btoday\b/i.test(s)) return sentDay;
  const m = /\bon\s+(?:(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*\.?,?\s+)?([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/i.exec(s);
  if (!m) return null;
  const mon = MONTHS[m[1].toLowerCase()] || MONTHS[m[1].toLowerCase().slice(0, 3)];
  const d = Number(m[2]);
  if (!mon || d < 1 || d > 31) return null;
  const y = Number(sentDay.slice(0, 4));
  for (const year of [y, y + 1]) {
    const date = `${year}-${pad2(mon)}-${pad2(d)}`;
    if (date >= addLocalDays(sentDay, -1)) return date;
  }
  return null;
}
const INVOICE_NO_RE = /\b(INV-\d{1,9}|D-\d{1,9})\b/i;

// The imported Rotor texts and emails of the window before `at` the seeds come from, with their class.
// → [{ id, contact_id, cls, text, sent_at, day }]
async function rotorMessages(at, days = SEED_WINDOW_DAYS) {
  const from = new Date(Date.parse(at) - days * DAY);
  const year = Number(localDate(new Date(Date.parse(at))).slice(0, 4));
  const shards = ["open", `y${year}`, `y${year - 1}`];
  const ixs = await Promise.all(shards.map((s) => readIndex("inbox", s).catch(() => ({ rows: [] }))));
  const convs = [...new Set(ixs.flatMap((x) => x.rows).filter((r) => r.la && Date.parse(r.la) >= from.getTime()).map((r) => r.id))];
  const out = [];
  for (const cv of convs) {
    const rows = await listRel("conv-messages", cv, { from: tsKey(from), to: tsKey(new Date(Date.parse(at))), limit: 500 });
    const recs = await getRecords("message", rows.map((r) => r.id));
    for (const g of recs) {
      const m = g && g.data;
      const cls = m && m.rotor && m.rotor.msg_class;
      if (!m || m.direction !== "out" || m.provider !== "rotor_import" || !["reminder", "overdue", "receipt", "agreement"].includes(cls)) continue;
      const t = Date.parse(m.sent_at || m.created_at);
      if (!(t >= from.getTime() && t <= Date.parse(at))) continue;
      out.push({ id: m.id, contact_id: m.contact_id, cls, text: `${m.subject || ""} ${m.body_text || ""}`, sent_at: m.sent_at || m.created_at, day: localDate(new Date(t)) });
    }
  }
  return out.sort((a, b) => (a.sent_at < b.sent_at ? -1 : a.sent_at > b.sent_at ? 1 : a.id < b.id ? -1 : 1));
}

const monthsBetween = (a, b) => {
  const out = [];
  for (let [y, m] = a.split("-").map(Number); `${y}-${pad2(m)}` <= b.slice(0, 7); m === 12 ? (y += 1, m = 1) : (m += 1)) out.push(`${y}-${pad2(m)}`);
  return out;
};

// What the switch seeds: { markers: [{ key: "done/{automation}/{step}", automation, step, message_id }], counts, unmatched }
// Matching (§5.7.4): a REMINDER text → the contact's visit on the date it names (14 days or 2 days by how far
// ahead it was sent); an overdue text → the invoice it names, else the contact's only open invoice, counted in
// order; a receipt → the contact's payment that day; an agreement reminder → the contact's unsigned agreements,
// that day.
export async function seedPlan(at) {
  const msgs = await rotorMessages(at);
  const markers = new Map();
  const counts = { reminder: 0, overdue: 0, receipt: 0, agreement: 0 };
  const unmatched = { reminder: 0, overdue: 0, receipt: 0, agreement: 0 };
  const add = (automation, step, m) => {
    const key = `done/${automation}/${keySafe(step, 120)}`;
    if (!markers.has(key)) { markers.set(key, { key, automation, step, message_id: m.id, sent_at: m.sent_at }); counts[m.cls] += 1; }
  };
  if (!msgs.length) return { markers: [], counts, unmatched, read: 0 };
  // the lists the texts are matched against (indexes only)
  const atDay = localDate(new Date(Date.parse(at)));
  const visitMonths = monthsBetween(addLocalDays(atDay, -SEED_WINDOW_DAYS), addLocalDays(atDay, 60));
  const [visitIx, invIx, agIx] = await Promise.all([
    Promise.all(visitMonths.map((m) => readIndex("visits", m).catch(() => ({ rows: [] })))).then((xs) => xs.flatMap((x) => x.rows)),
    readIndex("invoices", "open").then((x) => x.rows).catch(() => []),
    readIndex("agreements", "pending").then((x) => x.rows).catch(() => []),
  ]);
  const overdueN = new Map();
  const paymentsOf = new Map();
  for (const m of msgs) {
    if (!isId(m.contact_id, "contact")) { unmatched[m.cls] += 1; continue; }
    if (m.cls === "reminder") {
      const date = reminderDate(m.text, m.day);
      const visits = date ? visitIx.filter((v) => v.c === m.contact_id && v.d === date) : [];
      if (!visits.length) { unmatched.reminder += 1; continue; }
      const key = (Date.parse(`${date}T12:00:00Z`) - Date.parse(`${m.day}T12:00:00Z`)) / DAY >= 5 ? "visit.reminder_14d" : "visit.reminder_2d";
      for (const v of visits) add(key, `${v.id}--${v.d}`, m);
    } else if (m.cls === "overdue") {
      const no = INVOICE_NO_RE.exec(m.text);
      const mine = invIx.filter((r) => r.c === m.contact_id && r.st === "open");
      const inv = no ? mine.find((r) => String(r.n).toUpperCase() === no[1].toUpperCase()) : mine.length === 1 ? mine[0] : null;
      if (!inv) { unmatched.overdue += 1; continue; }
      const n = (overdueN.get(inv.id) || 0) + 1;
      overdueN.set(inv.id, n);
      add("invoice.overdue", `${inv.id}--${n}`, m);
    } else if (m.cls === "receipt") {
      if (!paymentsOf.has(m.contact_id)) {
        const rows = await listRel("contact-payments", m.contact_id, { limit: 100 }).catch(() => []);
        const recs = await getRecords("payment", rows.map((r) => r.id));
        paymentsOf.set(m.contact_id, recs.filter(Boolean).map((g) => g.data).filter((p) => p.kind === "payment").map((p) => ({ id: p.id, at: Date.parse(p.created_at || (p.received_on ? `${p.received_on}T18:00:00Z` : "")) })));
      }
      const t = Date.parse(m.sent_at);
      const pay = paymentsOf.get(m.contact_id).filter((p) => Number.isFinite(p.at) && Math.abs(p.at - t) <= 2 * DAY).sort((a, b) => Math.abs(a.at - t) - Math.abs(b.at - t))[0];
      if (!pay) { unmatched.receipt += 1; continue; }
      add("payment.receipt", pay.id, m);
    } else if (m.cls === "agreement") {
      const ags = agIx.filter((r) => r.c === m.contact_id && ["sent", "viewed"].includes(r.st));
      if (!ags.length) { unmatched.agreement += 1; continue; }
      for (const a of ags) add("agreement.unsigned", `${a.id}--${m.day}`, m);
    }
  }
  return { markers: [...markers.values()], counts, unmatched, read: msgs.length };
}

// Writes the seeds (onlyIfNew: a marker already there, seeded or a real send, is left as it is).
async function writeSeeds(plan, n) {
  let written = 0;
  for (const s of plan.markers) {
    const [, ns, scope, ...rest] = s.key.split("/");
    const w = await settledWrite(s.key, { state: "done", ns: ns || "done", scope, key: rest.join("/"), result: "seeded_from_rotor", provider: "rotor", provider_ref: s.message_id, seeded_by: `cutover--${n}`, at: nowIso() }, { onlyIfNew: true });
    if (w.ok) written += 1;
  }
  return written;
}

// ------------------------------------------------------------ dry-run sends and follow-ups (steps 3, 4)

// Deletes every queued step whose marker is in done-dry/ (a dry-run send): after the switch it would only be
// skipped ("mode_changed"); cancelling it at once keeps the queue honest. → { cancelled, by_kind }
async function cancelDrySends(budget) {
  const { directories } = await listKeys("q/", { directories: true });
  let cancelled = 0;
  const byKind = {};
  for (const d of directories.sort()) {
    const keys = await listKeys(`${d.replace(/\/+$/, "")}/`);
    for (const k of keys) {
      if (budget && budget.left() < 15000) throw new BudgetError("The switch goes on in the next pass.");
      const got = await getRaw(k).catch(() => null);
      const item = got && got.data;
      if (!item || !item.marker || item.marker.ns !== "done-dry") continue;
      await deleteRaw(k);
      cancelled += 1;
      const kind = keySafe(item.data && item.data.automation ? item.data.automation : item.kind, 60);
      byKind[kind] = (byKind[kind] || 0) + 1;
    }
  }
  return { cancelled, by_kind: byKind };
}

// The open follow-up sequences on contacts that aren't test contacts: they ran in dry-run (§5.7.4).
async function openDryEnrollments() {
  const ix = await readIndex("enrollments/active", "").catch(() => ({ rows: [] }));
  const contacts = [...new Set(ix.rows.map((r) => r.c).filter((c) => isId(c, "contact")))];
  const recs = await getRecords("contact", contacts);
  return recs.filter(Boolean).map((g) => g.data).filter((c) => !(c.flags && c.flags.test === true)).map((c) => c.id);
}

// ------------------------------------------------------------ settings (step 5)

async function mergeSetting(name, mutate, ctx) {
  if (!getSettingsDef(name)) return null;
  for (let i = 0; i < 4; i++) {
    const cur = await getSettingWithEtag(name);
    const next = mutate({ ...cur.data });
    if (!next) return cur.data;
    delete next.updated_at; delete next.updated_by;
    try { return (await putSetting(name, next, { ...ctx, ifMatch: cur.etag || "new" })).data; } catch (e) { if (!(e instanceof StaleError) || i >= 3) throw e; }
  }
  return null;
}

// ------------------------------------------------------------ the ops

const step = (name, run) => ({ name, run });

defineOp("cutover", {
  lane: "bulk",
  steps: (input) => [
    step("numbers", async (s) => {
      const plan = await numberPlan();
      for (const [seq, next] of Object.entries(plan)) await setSequence(seq, next, { ...s.ctx, by: s.ctx.by || "system" });
      return plan;
    }),
    step("seed", async () => {
      const plan = await seedPlan(input.at);
      const written = await writeSeeds(plan, input.n);
      return { ...plan.counts, written, unmatched: plan.unmatched, read: plan.read };
    }),
    step("dry_sends", async () => cancelDrySends(stepBudget)),
    step("follow_ups", async (s) => {
      if (!has("sales.stopAll")) return { stopped: 0, contacts: 0, skipped: "no_sales" };
      const contacts = await openDryEnrollments();
      let stopped = 0;
      for (const c of contacts) stopped += Number(await call("sales.stopAll", c, "cutover", s.ctx)) || 0;
      return { stopped, contacts: contacts.length };
    }),
    step("settings", async (s) => {
      await mergeSetting("automations", (a) => ({ ...a, effective_from: input.at }), s.ctx);
      const intake = has("contacts.intake") ? await mergeSetting("intake", (x) => (x.mode === "crm" ? null : { ...x, mode: "crm" }), s.ctx) : null;
      const dash = await mergeSetting("dashboard", (x) => (x.source === "crm" ? null : { ...x, source: "crm" }), s.ctx);
      return { effective_from: input.at, intake: intake ? intake.mode : null, dashboard: dash ? dash.source : null };
    }),
    step("mode", async (s) => {
      const m = await updateSysMode((cur) => (cur.system_of_record === "crm" && cur.cutover_n === input.n ? null : { ...cur, system_of_record: "crm", cutover_n: input.n, cutover_at: input.at }));
      await appendEvent("sys", "mode", { by: s.ctx.by || "system", origin: "api", action: "cutover", n: input.n }).catch(() => {});
      return { system_of_record: m.system_of_record, cutover_n: m.cutover_n, cutover_at: m.cutover_at, out: s.out };
    }),
  ],
});

defineOp("cutover.rollback", {
  lane: "bulk",
  steps: (input) => [
    step("mode", async (s) => {
      const m = await updateSysMode((cur) => (cur.system_of_record === "rotor" ? null : { ...cur, system_of_record: "rotor", rolled_back_at: input.at, rolled_back_n: input.n }));
      await appendEvent("sys", "mode", { by: s.ctx.by || "system", origin: "api", action: "rollback", n: input.n }).catch(() => {});
      return { system_of_record: m.system_of_record };
    }),
    step("settings", async (s) => {
      const intake = has("contacts.intake") ? await mergeSetting("intake", (x) => (x.mode === "dual" ? null : { ...x, mode: "dual" }), s.ctx) : null;
      const dash = await mergeSetting("dashboard", (x) => (x.source === "rotor" ? null : { ...x, source: "rotor" }), s.ctx);
      return { intake: intake ? intake.mode : null, dashboard: dash ? dash.source : null };
    }),
    step("list", async () => {
      const list = await madeSince(input.since);
      await updateCutover((st) => {
        const ticks = { ...(st.ticks || {}) };
        for (const k of CLEARED_BY_ROLLBACK) delete ticks[k];
        const preview = st.preview ? { ...st.preview, approved_at: null, approved_by: null } : null;
        return { ...st, ticks, preview, rollback_list: list.slice(0, 300) };
      });
      return { listed: list.length };
    }),
  ],
});

// The records the CRM made since the switch, to enter in Rotor during a rollback (indexes only).
async function madeSince(since) {
  const t = Date.parse(since);
  if (!Number.isFinite(t)) return [];
  const y = localDate(now()).slice(0, 4);
  const [inv, invY, q, qY] = await Promise.all([
    readIndex("invoices", "open").catch(() => ({ rows: [] })), readIndex("invoices", y).catch(() => ({ rows: [] })),
    readIndex("quotes", "open").catch(() => ({ rows: [] })), readIndex("quotes", y).catch(() => ({ rows: [] })),
  ]);
  const fresh = (r) => !r.im && !r.sh && Date.parse(r.at || "") >= t;
  const out = [];
  for (const r of [...inv.rows, ...invY.rows].filter(fresh)) out.push({ type: "invoice", id: r.id, label: r.n || null, contact_id: r.c || null, at: r.at });
  for (const r of [...q.rows, ...qY.rows].filter(fresh)) out.push({ type: "quote", id: r.id, label: r.n || null, contact_id: r.c || null, at: r.at });
  const months = monthsBetween(localDate(new Date(t)), addLocalDays(localDate(now()), 120));
  for (const m of months) {
    const vs = await readIndex("visits", m).catch(() => ({ rows: [] }));
    for (const r of vs.rows) {
      if (Date.parse(r.u || "") < t) continue;
      out.push({ type: "visit", id: r.id, label: r.jn ? `Job ${r.jn}` : null, contact_id: r.c || null, at: r.u, date: r.d });
    }
  }
  const seen = new Set();
  return out.filter((x) => (seen.has(x.id) ? false : seen.add(x.id))).sort((a, b) => (a.at < b.at ? -1 : 1));
}

// ------------------------------------------------------------ the lane runs that step the ops

const TRANSIENT = [BlobsTransientError, UnknownOutcome, TimeoutError, BudgetError];
const transient = (e) => TRANSIENT.some((C) => e instanceof C) || (e && e.transient === true);

// The lane pass's budget, for the op's long step (runOp's step context carries none).
let stepBudget = null;
const opStep = (kind) => async (run, rctx) => {
  const { op_id: opId, input, actor } = run.input || {};
  let out;
  stepBudget = rctx.budget || null;
  try {
    out = await runOp(opId, kind, { holder: run.id, input, ctx: { ...(actor || SYSTEM), requestId: run.id, ...(rctx.mode ? { mode: rctx.mode } : {}) } });
  } catch (e) {
    if (transient(e)) return { progress: { done: 0, total: null } };     // the op stays running: the next pass goes on
    throw e;
  } finally { stepBudget = null; }
  if (out.status === "running") return { progress: { done: 0, total: null } };
  await finishHistory(opId, out);
  if (out.status === "failed") return { failed: (out.error && out.error.code) || "failed" };
  await tellOwners(kind, input, out.result).catch((e) => console.error(`crm:import: the owners were not told (${safeErr(e)})`));
  return { done: true, result: { op_id: opId, status: "done" } };
};
defineRun("cutover.switch", { lane: "bulk", step: opStep("cutover"), label: "Switch from Rotor" });
defineRun("cutover.rollback", { lane: "bulk", step: opStep("cutover.rollback"), label: "Switch back to Rotor" });

async function finishHistory(opId, out) {
  await updateCutover((st) => {
    const history = (st.history || []).map((h) => (h.op_id === opId && h.status === "running" ? { ...h, status: out.status, finished_at: nowIso() } : h));
    return { ...st, history };
  }).catch(() => null);
}

async function tellOwners(kind, input) {
  const people = await approvers();
  if (!people.length) return;
  const n = kind === "cutover"
    ? { kind: "system", title: "The CRM is in charge now", body: "The switch from Rotor is done. Texts, emails and charges go out from the CRM for every integration you connected. Watch the Outbox and the automation log today.", link: "/cutover" }
    : { kind: "system", title: "Back on Rotor", body: "The CRM went back to report-only. Turn Rotor's automations back on, and enter what the CRM made since the switch in Rotor (the list is on the switch-over page).", link: "/cutover" };
  await notify(people, n, SYSTEM);
}

// ------------------------------------------------------------ starting them (the routes)

async function activeOpRun(st) {
  const h = (st.history || []).find((x) => x.status === "running");
  if (!h) return null;
  const run = h.run_id ? await getRun(h.run_id).catch(() => null) : null;
  if (run && (run.status === "queued" || run.status === "running")) return h;
  const op = await readOp(h.op_id).catch(() => null);
  return op && op.status === "running" ? h : null;
}

// POST /cutover/run: the gate (every item green, SWITCH TO CRM), then the op on the bulk lane.
export async function startCutover({ confirm } = {}, ctx) {
  if (confirm !== CONFIRM_SWITCH) throw new InputError(`Type ${CONFIRM_SWITCH} to confirm.`, "confirm");
  const mode = await readSysMode();
  if (mode.paused) throw new ConflictError("The CRM is paused. Resume it first (Settings, Data).");
  if (mode.system_of_record === "crm") throw new ConflictError("The CRM is already in charge.");
  const st = await readCutover();
  if (await activeOpRun(st)) throw new ConflictError("A switch is already under way.");
  const list = await checklist({ deploy: ctx.deploy, state: st, mode });
  const red = list.items.filter((i) => i.state === "todo");
  if (red.length) throw new ConflictError(`${red.length} ${red.length === 1 ? "item on the checklist isn't" : "items on the checklist aren't"} done yet.`, { details: { todo: red.map((i) => i.key) } });
  const n = (mode.cutover_n || 0) + 1;
  const opId = `cutover--${n}`;
  const input = { n, at: nowIso(), by: ctx.by };
  const actor = { by: ctx.by, origin: "api", actor_kind: "user" };
  const run = await createRun("cutover.switch", { op_id: opId, input, actor }, ctx, { id: deriveId("run", opId, "cutover.lane", 0) });
  await updateCutover((s) => ({ ...s, history: [...(s.history || []).filter((h) => h.op_id !== opId), { kind: "cutover", n, op_id: opId, run_id: run.id, at: input.at, by: ctx.by, status: "running" }].slice(-20) }));
  await appendEvent("sys", "cutover", { action: "switch", by: ctx.by, origin: "api", n }).catch(() => {});
  return { run_id: run.id, op_id: opId, n };
}

// POST /cutover/rollback: within 48 hours of the switch, SWITCH BACK TO ROTOR.
export async function startRollback({ confirm } = {}, ctx) {
  if (confirm !== CONFIRM_ROLLBACK) throw new InputError(`Type ${CONFIRM_ROLLBACK} to confirm.`, "confirm");
  const mode = await readSysMode();
  if (mode.system_of_record !== "crm") throw new ConflictError("Rotor is in charge already.");
  const at = Date.parse(mode.cutover_at || "");
  if (!(at + ROLLBACK_HOURS * HOUR > nowMs())) throw new ConflictError("Going back to Rotor is only for the first 48 hours after the switch.");
  const st = await readCutover();
  if (await activeOpRun(st)) throw new ConflictError("A switch is already under way.");
  const n = mode.cutover_n || 1;
  const opId = `rollback--${n}`;
  const input = { n, at: nowIso(), since: mode.cutover_at, by: ctx.by };
  const actor = { by: ctx.by, origin: "api", actor_kind: "user" };
  const run = await createRun("cutover.rollback", { op_id: opId, input, actor }, ctx, { id: deriveId("run", opId, "cutover.lane", 0) });
  await updateCutover((s) => ({ ...s, history: [...(s.history || []).filter((h) => h.op_id !== opId), { kind: "rollback", n, op_id: opId, run_id: run.id, at: input.at, by: ctx.by, status: "running" }].slice(-20) }));
  await appendEvent("sys", "cutover", { action: "rollback", by: ctx.by, origin: "api", n }).catch(() => {});
  return { run_id: run.id, op_id: opId, n };
}

// ------------------------------------------------------------ in-flight documents (D37)

export const IN_FLIGHT = Object.freeze({
  quotes: { label: "Quotes sent in the last 30 days", template_key: "cutover_quote", title: "Your quote in our new portal" },
  invoices: { label: "Open invoices from Rotor", template_key: "cutover_invoice", title: "Open invoices in our new portal" },
  agreements: { label: "Agreements not signed yet", template_key: "cutover_agreement", title: "Agreements to sign in our new portal" },
});

// Who each list reaches (contact ids, once each), from the indexes.
export async function inFlightLists() {
  const since = nowMs() - 30 * DAY;
  const [q, inv, ag] = await Promise.all([
    readIndex("quotes", "open").catch(() => ({ rows: [] })), readIndex("invoices", "open").catch(() => ({ rows: [] })), readIndex("agreements", "pending").catch(() => ({ rows: [] })),
  ]);
  const uniq = (rows) => [...new Set(rows.map((r) => r.c).filter((c) => isId(c, "contact")))];
  return {
    quotes: uniq(q.rows.filter((r) => ["sent", "viewed"].includes(r.st) && Date.parse(r.sent || "") >= since)),
    invoices: uniq(inv.rows.filter((r) => r.st === "open" && r.bal > 0 && r.im)),
    agreements: uniq(ag.rows.filter((r) => ["sent", "viewed"].includes(r.st))),
  };
}

export async function inFlightView() {
  const [lists, st] = await Promise.all([inFlightLists(), readCutover()]);
  return Object.fromEntries(Object.entries(IN_FLIGHT).map(([k, d]) => [k, { label: d.label, count: lists[k].length, bulk_run_id: (st.in_flight[k] && st.in_flight[k].bulk_run_id) || null, made_at: (st.in_flight[k] && st.in_flight[k].at) || null }]));
}

// One list as a bulk run (preview, test send, an owner's confirm: core/bulk.mjs).
export async function makeInFlightRun(kind, ctx) {
  const d = IN_FLIGHT[kind];
  if (!d) throw new NotFoundError("That list isn't there.");
  const st = await readCutover();
  if (st.in_flight[kind] && st.in_flight[kind].bulk_run_id) return { bulk_run_id: st.in_flight[kind].bulk_run_id, existed: true };
  const recipients = (await inFlightLists())[kind];
  if (!recipients.length) throw new ConflictError("Nobody is on that list.");
  const run = await createBulkRun({ kind: `cutover.${kind}`, title: d.title, recipients: recipients.slice(0, 2000), template_key: d.template_key, channel: "sms", related: { kind: `cutover.${kind}` }, requested_by: ctx.by }, ctx);
  await updateCutover((s) => ({ ...s, in_flight: { ...(s.in_flight || {}), [kind]: { bulk_run_id: run.id, at: nowIso(), by: ctx.by, count: recipients.length } } }));
  return { bulk_run_id: run.id, existed: false };
}

// Barta's words for the in-flight texts (the sender adds the opt-out footer; no links stored on a record:
// the portal's "text me a link" sends each customer their own).
export const TEMPLATES = Object.freeze([
  { key: "cutover_quote", name: "Your quote in our new portal (switch-over)", channel: "sms", category: "service",
    body: "Hi {{first_name|there}}, it's {{company_name}}. Your quote from us is now in our new customer portal. To see it or approve it, go to bartawindowwashing.com/p/login and we'll text you a link. Questions? Call us at {{company_phone}}." },
  { key: "cutover_invoice", name: "Open invoice in our new portal (switch-over)", channel: "sms", category: "service",
    body: "Hi {{first_name|there}}, it's {{company_name}}. We moved to a new billing system. To see your open invoice and pay by card, go to bartawindowwashing.com/p/login and we'll text you a link. Questions? Call us at {{company_phone}}." },
  { key: "cutover_agreement", name: "Agreement to sign in our new portal (switch-over)", channel: "sms", category: "service",
    body: "Hi {{first_name|there}}, it's {{company_name}}. Your plan agreement is waiting for you in our new customer portal. Go to bartawindowwashing.com/p/login and we'll text you a link to read and sign it." },
  { key: "cutover_new_number", name: "Our new texting number (switch-over)", channel: "sms", category: "service",
    body: "Hi {{first_name|there}}, it's {{company_name}}. This is our new texting number. Save it, and text us here any time." },
]);

// ------------------------------------------------------------ what the page shows

export async function cutoverView(ctx) {
  const [st, mode] = await Promise.all([readCutover(), readSysMode()]);
  const list = await checklist({ deploy: ctx.deploy, state: st, mode });
  const at = Date.parse(mode.cutover_at || "");
  const active = await activeOpRun(st);
  return {
    ...list,
    preview: st.preview ? { run_id: st.preview.run_id, status: st.preview.status, at: st.preview.at, created_at: st.preview.created_at, computed_at: st.preview.computed_at || null, import_run_id: st.preview.import_run_id || null, totals: st.preview.totals || null, approved_at: st.preview.approved_at || null, approved_by: st.preview.approved_by || null, current: previewCurrent(st.preview, list.import) } : null,
    history: (st.history || []).slice().reverse(),
    active: active ? { kind: active.kind, op_id: active.op_id, run_id: active.run_id } : null,
    rollback: mode.system_of_record === "crm" ? { until: Number.isFinite(at) ? new Date(at + ROLLBACK_HOURS * HOUR).toISOString() : null, allowed: Number.isFinite(at) && at + ROLLBACK_HOURS * HOUR > nowMs() } : null,
    rollback_list: mode.system_of_record === "rotor" && Array.isArray(st.rollback_list) ? st.rollback_list.slice(0, 100) : [],
    confirm: { switch: CONFIRM_SWITCH, rollback: CONFIRM_ROLLBACK },
  };
}

export { sandboxed };
