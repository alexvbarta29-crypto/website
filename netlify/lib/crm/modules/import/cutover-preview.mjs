// The switch-over preview (design §10.9 "Cutover preview", §5.7.4): what
// the CRM would send and charge from the switch to 72 hours after it, per
// automation and day, with the eligibility floor (cfg/automations.
// effective_from = the switch time) and the done/ markers the switch would
// seed from Rotor's own texts applied. It writes nothing but its result:
// it is a projection over the records and indexes, never a run of the
// sweeps (a sweep run would leave markers and outbox items behind).
//
// Per automation the projection follows the module's own rules:
//   visit.reminder_14d / _2d  the 10:00 sweep of each day in the window
//       (catch-up 7-14 and 1-2 days out), imported future visits eligible,
//       skipped when already reminded (a seeded or real done/ marker, or an
//       earlier day of the projection), a visit booked late skips the 14-day
//   invoice.overdue           the 10:00 sweep: the CRM's own open invoices
//       due on or after the floor; imported invoices never (the floor)
//   agreement.unsigned        the 10:00 sweep: sent and unsigned agreements,
//       one a day, at most 7, seeded days skipped
//   plan.renewal_notice       the 10:00 sweep, 30 days before the term
//       ends; imported plans never; more than the bulk threshold on one day
//       is a bulk run for an owner to confirm (counted apart)
//   review.sequence           jobs on the schedule in the window, if
//       completed: the CRM's own billable ones get step 1 (and step 2 when
//       its day 3 falls in the window); imported jobs never (the floor)
//   money.autopay             a 1st of the month in the window: the
//       charges, invoices and receipts its preview lists
//   event automations         only on new activity after the switch
//       (a new lead, a booking, a payment): not counted, listed
//   anything else registered  listed as "not previewed"
// Counts come before quiet hours, opt-outs and consent: the sender can
// only send fewer.

import { getRaw, settledWrite, readIndex, getRecords, listKeys } from "../../../crm-store.mjs";
import { defineRun, createRun } from "../../core/lanes.mjs";
import { ConflictError } from "../../core/errors.mjs";
import { allAutomations } from "../../core/registry.mjs";
import { readAutomationsCfg, settingsFor, checkEligible } from "../../core/automations.mjs";
import { getTemplateByKey, renderTemplate, sampleVars } from "../../core/templates.mjs";
import { localDate, addLocalDays, zonedToUtc, nowIso } from "../../core/clock.mjs";
import { isId } from "../../core/ids.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { seedPlan, numberPlan, updateCutover, readCutover, inFlightLists, importState, previewCurrent } from "./cutover.mjs";

const HOUR = 3600000;
const DAY = 86400000;
export const WINDOW_HOURS = 72;
export const previewKey = (runId) => `cutover/preview/${runId}`;
const pad2 = (n) => String(n).padStart(2, "0");
const zero = () => ({ texts: 0, emails: 0, invoices: 0, charges: 0 });
const add = (a, b) => ({ texts: a.texts + (b.texts || 0), emails: a.emails + (b.emails || 0), invoices: a.invoices + (b.invoices || 0), charges: a.charges + (b.charges || 0) });

const EVENT_NOTES = {
  "lead.ack": "Only when a new lead comes in after the switch",
  "lead.alert": "Staff only: a push to the owners for each new lead",
  "lead.attention": "Staff only: the Today list",
  "visit.confirm": "Only when a visit is booked or moved after the switch",
  "visit.on_my_way": "Only when a tech taps On my way",
  "visit.running_late": "Only when a tech taps Running late",
  "quote.sent": "Only when someone sends a quote",
  "invoice.sent": "Only when an invoice is issued after the switch",
  "payment.receipt": "Only when a payment comes in after the switch",
  "payment.failed": "Only when a charge fails",
  "agreement.sent": "Only when someone sends an agreement",
  "job.completed_note": "Only when a job is completed after the switch",
  "lights.rebook": "Never sends by itself: a bulk run for you to test and confirm",
  "card.expiring": "10:05 daily: cards running out within 30 days",
  "staff.daily_digest": "Staff only",
};

// ------------------------------------------------------------ helpers

// The local days of the window and the times a daily sweep at `hhmm` runs in it.
export function windowDays(at, hours = WINDOW_HOURS) {
  const start = Date.parse(at);
  const end = start + hours * HOUR;
  const days = [];
  for (let d = localDate(new Date(start)), i = 0; i < 5; i++, d = addLocalDays(d, 1)) {
    if (zonedToUtc(d, "00:00").getTime() > end) break;
    days.push(d);
  }
  return { start, end, days };
}
export function sweepRuns(at, hhmm, hours = WINDOW_HOURS) {
  const w = windowDays(at, hours);
  return w.days.map((d, i) => ({ day: d, i, t: zonedToUtc(d, hhmm).getTime() })).filter((r) => r.t >= w.start && r.t <= w.end);
}
const monthsOf = (from, to) => {
  const out = [];
  for (let [y, m] = from.split("-").map(Number); `${y}-${pad2(m)}` <= to.slice(0, 7); m === 12 ? (y += 1, m = 1) : (m += 1)) out.push(`${y}-${pad2(m)}`);
  return out;
};
async function visitRowsBetween(from, to) {
  const shards = await Promise.all(monthsOf(from, to).map((m) => readIndex("visits", m).catch(() => ({ rows: [] }))));
  return shards.flatMap((s) => s.rows).filter((r) => r.d >= from && r.d <= to);
}
const finalLive = async (key) => {
  const g = await getRaw(key).catch(() => null);
  const st = g && g.data && g.data.state;
  return st === "done" || st === "unknown";
};
const hasEmail = (c) => !!c && Array.isArray(c.emails) && c.emails.some((e) => e && (e.address || typeof e === "string"));
const firstName = (c) => (c && c.first_name) || null;

async function sample(templateKey, contact, extra = {}) {
  const t = templateKey ? await getTemplateByKey(templateKey).catch(() => null) : null;
  if (!t) return null;
  try {
    const r = renderTemplate(t, { ...sampleVars(), ...(firstName(contact) ? { first_name: firstName(contact) } : {}), ...extra });
    return String(r.text || r.body || "").slice(0, 320);
  } catch { return null; }
}

// ------------------------------------------------------------ the projections

async function reminders(def, settings, ctx, { lo, hi }) {
  const by = ctx.days.map(() => zero());
  const runs = sweepRuns(ctx.at, settings.at_local || "10:00");
  if (!runs.length) return { by, samples: [] };
  const rows = (await visitRowsBetween(addLocalDays(runs[0].day, lo), addLocalDays(runs[runs.length - 1].day, hi))).filter((r) => r.st === "scheduled");
  const recs = new Map((await getRecords("visit", rows.map((r) => r.id))).filter(Boolean).map((g) => [g.data.id, g.data]));
  const contacts = new Map((await getRecords("contact", [...new Set([...recs.values()].map((v) => v.contact_id))])).filter(Boolean).map((g) => [g.data.id, g.data]));
  const done = new Set();
  const samples = [];
  const channels = Array.isArray(settings.channels) && settings.channels.length ? settings.channels : ["sms"];
  for (const run of runs) {
    for (const r of rows) {
      const v = recs.get(r.id);
      if (!v || v.deleted_at) continue;
      const out = Math.round((Date.parse(`${v.date}T12:00:00Z`) - Date.parse(`${run.day}T12:00:00Z`)) / DAY);
      if (out < lo || out > hi) continue;
      const imported = v.created_by === "import" || !!v.import;
      if (def.key === "visit.reminder_14d" && !imported && v.created_at && localDate(new Date(v.created_at)) > addLocalDays(v.date, -14)) continue;
      const mk = `${v.id}--${v.date}`;
      if (done.has(mk)) continue;
      const e = checkEligible(def, settings, ctx.cfg, { fact_at: new Date(run.t).toISOString(), record: v, future: Date.parse(v.start_utc || `${v.date}T18:00:00Z`) > run.t });
      if (!e.ok) continue;
      const seeded = `done/${def.key}/${mk}`;
      if (ctx.seeds.has(seeded) || await finalLive(seeded)) { done.add(mk); ctx.skipped.seeded += 1; continue; }
      done.add(mk);
      const c = contacts.get(v.contact_id);
      if (channels.includes("sms")) by[run.i].texts += 1;
      if (channels.includes("email") && hasEmail(c)) by[run.i].emails += 1;
      if (samples.length < 3) { const s = await sample((settings.template_keys || [])[0], c, { visit_date: v.date }); if (s) samples.push(s); }
    }
  }
  return { by, samples };
}

async function overdue(def, settings, ctx) {
  const by = ctx.days.map(() => zero());
  const runs = sweepRuns(ctx.at, "10:00");
  const money = await getRaw("cfg/money").then((g) => (g && g.data) || {}).catch(() => ({}));
  const every = Number.isInteger(money.overdue_every_days) ? money.overdue_every_days : 3;
  const max = Number.isInteger(money.overdue_max) ? money.overdue_max : 5;
  const rows = (await readIndex("invoices", "open").catch(() => ({ rows: [] }))).rows.filter((r) => r.st === "open" && r.bal > 0 && !r.pr && r.due);
  ctx.floor.imported_invoices = rows.filter((r) => r.im).length;
  const rm = new Map(rows.map((r) => [r.id, r.rm || 0]));
  const samples = [];
  for (const run of runs) {
    for (const r of rows) {
      if (r.im) continue;                                    // never an imported invoice (§5.7.4)
      const n = rm.get(r.id);
      if (!(r.due < run.day) || n >= max || run.day < addLocalDays(r.due, 1 + n * every)) continue;
      const e = checkEligible(def, settings, ctx.cfg, { fact_at: zonedToUtc(r.due, "12:00").toISOString(), record: { created_by: "crm" } });
      if (!e.ok) { ctx.floor.invoices_before_floor += 1; continue; }
      const key = `done/invoice.overdue/${r.id}--${n + 1}`;
      rm.set(r.id, n + 1);
      if (ctx.seeds.has(key) || await finalLive(key)) { ctx.skipped.seeded += 1; continue; }
      by[run.i].texts += 1;
      if (samples.length < 3) { const s = await sample("invoice_overdue", null, { invoice_number: r.n }); if (s) samples.push(s); }
    }
  }
  return { by, samples };
}

async function unsigned(def, settings, ctx) {
  const by = ctx.days.map(() => zero());
  const runs = sweepRuns(ctx.at, "10:00");
  const rows = (await readIndex("agreements", "pending").catch(() => ({ rows: [] }))).rows.filter((r) => ["sent", "viewed"].includes(r.st) && r.sent);
  const recs = new Map((await getRecords("agreement", rows.map((r) => r.id))).filter(Boolean).map((g) => [g.data.id, g.data]));
  const count = new Map(rows.map((r) => [r.id, r.rc || 0]));
  const samples = [];
  let imported = 0;
  for (const run of runs) {
    for (const r of rows) {
      if (!(localDate(new Date(Date.parse(r.sent))) < run.day) || count.get(r.id) >= 7) continue;
      const a = recs.get(r.id);
      if (a && a.bulk_run_id && r.st === "draft") continue;
      const key = `done/agreement.unsigned/${r.id}--${run.day}`;
      if (ctx.seeds.has(key) || await finalLive(key)) { ctx.skipped.seeded += 1; continue; }
      count.set(r.id, count.get(r.id) + 1);
      by[run.i].texts += 1;
      if (a && (a.import || a.created_by === "import")) imported += 1;
      if (samples.length < 3) { const s = await sample("agreement_unsigned", null); if (s) samples.push(s); }
    }
  }
  return { by, samples, note: imported ? `${imported} of these are for agreements Rotor sent (the CRM goes on reminding them)` : null };
}

async function renewals(def, settings, ctx) {
  const by = ctx.days.map(() => zero());
  const runs = sweepRuns(ctx.at, "10:00");
  const rows = (await readIndex("plans", "").catch(() => ({ rows: [] }))).rows.filter((r) => r.st === "active" && r.te && !r.im);
  const recs = new Map((await getRecords("plan", rows.map((r) => r.id))).filter(Boolean).map((g) => [g.data.id, g.data]));
  const threshold = await getRaw("cfg/messaging").then((g) => (g && g.data && Number.isInteger(g.data.bulk_threshold) ? g.data.bulk_threshold : 5)).catch(() => 5);
  const sent = new Set();
  let bulk = 0;
  const channels = Array.isArray(settings.channels) && settings.channels.length ? settings.channels : ["sms"];
  for (const run of runs) {
    const due = rows.filter((r) => run.day >= addLocalDays(r.te, -30) && run.day <= r.te && !sent.has(r.id)).filter((r) => {
      const p = recs.get(r.id);
      return p && p.auto_renew !== false && !((p.renewal || {}).notice_term === (p.term || {}).current_term_n);
    });
    for (const r of due) sent.add(r.id);
    if (due.length > threshold) { bulk += due.length; continue; }
    by[run.i].texts += channels.includes("sms") ? due.length : 0;
    by[run.i].emails += channels.includes("email") ? due.length : 0;
  }
  return { by, samples: [], note: bulk ? `${bulk} more as a bulk run you confirm (more than ${threshold} on one day)` : null };
}

async function reviewsOf(def, settings, ctx) {
  const by = ctx.days.map(() => zero());
  // jobs completed in the 8 days before the switch: the floor keeps the imported ones out
  const year = localDate(new Date(ctx.start)).slice(0, 4);
  const shards = [year, String(Number(year) - 1)];
  const jobsDone = (await Promise.all(shards.map((s) => readIndex("jobs", s).catch(() => ({ rows: [] }))))).flatMap((x) => x.rows)
    .filter((r) => r.st === "completed" && r.done && Date.parse(r.done) >= ctx.start - 8 * DAY && Date.parse(r.done) < ctx.start);
  const doneRecs = (await getRecords("job", jobsDone.map((r) => r.id))).filter(Boolean).map((g) => g.data);
  ctx.floor.imported_completed_jobs = doneRecs.filter((j) => j.import || j.created_by === "import").length;
  // the schedule in the window: what would be asked once completed
  const last = ctx.days[ctx.days.length - 1];
  const rows = (await visitRowsBetween(ctx.days[0], last)).filter((r) => r.st === "scheduled" && !["touch_up", "warranty", "lights_warranty", "lights_takedown"].includes(r.k));
  const jobIds = [...new Set(rows.map((r) => r.j).filter((j) => isId(j, "job")))];
  const jobs = new Map((await getRecords("job", jobIds)).filter(Boolean).map((g) => [g.data.id, g.data]));
  const asked = new Set();
  let importedKept = 0;
  for (const r of rows) {
    const j = jobs.get(r.j);
    if (!j || asked.has(j.id) || (j.billable === false && j.kind !== "lights_install")) continue;
    asked.add(j.id);
    const i = ctx.days.indexOf(r.d);
    const doneAt = zonedToUtc(r.d, (r.e && /^\d{2}:\d{2}$/.test(r.e)) ? r.e : "15:00").toISOString();
    const e = checkEligible(def, settings, ctx.cfg, { fact_at: doneAt, record: j });
    if (!e.ok) { if (e.reason === "imported") importedKept += 1; continue; }
    if (i >= 0) by[i].texts += 1;
    const d3 = ctx.days.indexOf(addLocalDays(r.d, 3));
    if (d3 >= 0) by[d3].texts += 1;
  }
  return { by, samples: [], note: `If the scheduled jobs are completed. ${importedKept ? `${importedKept} imported ${importedKept === 1 ? "job is" : "jobs are"} never asked. ` : ""}Jobs completed before the switch are never asked.` };
}

async function autopay(ctx) {
  const by = ctx.days.map(() => zero());
  const runs = sweepRuns(ctx.at, "09:00").filter((r) => r.day.endsWith("-01"));
  if (!runs.length) return null;
  let previewAutopay;
  try { ({ previewAutopay } = await import("../money/autopay.mjs")); } catch { return { by, samples: [], note: "Not previewed: Money isn't here." }; }
  for (const run of runs) {
    const p = await previewAutopay(run.day.slice(0, 7), { mode: { system_of_record: "crm" } });
    for (const it of p.items) {
      if (it.would === "charge") { by[run.i].charges += 1; by[run.i].invoices += 1; by[run.i].texts += 1; }
      else if (it.would === "invoice_only" || it.would === "skipped_no_card") { by[run.i].invoices += 1; by[run.i].texts += 1; }
    }
  }
  return { by, samples: [], note: "The 1st-of-month run: one invoice per plan, the card charged on autopay, a receipt or the invoice by text" };
}

// ------------------------------------------------------------ the whole preview

const PROJECTORS = {
  "visit.reminder_14d": (d, s, c) => reminders(d, s, c, { lo: 7, hi: 14 }),
  "visit.reminder_2d": (d, s, c) => reminders(d, s, c, { lo: 1, hi: 2 }),
  "invoice.overdue": overdue,
  "agreement.unsigned": unsigned,
  "plan.renewal_notice": renewals,
  "review.sequence": reviewsOf,
};

// → { at, window_hours, days, automations: [{ key, label, module, kind, enabled, by_day, total, note?, samples }], totals, by_day, seeds, sequences, numbers, floor, in_flight }
export async function computePreview(at) {
  const cfg0 = await readAutomationsCfg();
  const cfg = { ...cfg0, effective_from: at };               // the floor the switch writes
  const w = windowDays(at);
  const seeds = await seedPlan(at);
  const ctx = { at, start: w.start, days: w.days, cfg, seeds: new Set(seeds.markers.map((m) => m.key)), floor: { imported_completed_jobs: 0, imported_invoices: 0, invoices_before_floor: 0 }, skipped: { seeded: 0 } };
  const automations = [];
  for (const def of allAutomations().slice().sort((a, b) => a.key.localeCompare(b.key))) {
    const settings = settingsFor(def, cfg0);
    const enabled = !!settings.enabled && !cfg0.paused;
    const base = { key: def.key, label: def.label || def.key, module: def.module || null, category: def.category, enabled };
    const proj = PROJECTORS[def.key];
    if (!proj) {
      const note = EVENT_NOTES[def.key] || (String(def.trigger || "").startsWith("event:") ? "Only on new activity after the switch" : "Not previewed: it runs on its own trigger");
      automations.push({ ...base, kind: String(def.trigger || "").startsWith("event:") ? "on_activity" : "other", by_day: w.days.map(() => zero()), total: zero(), note, samples: [] });
      continue;
    }
    let out;
    try { out = enabled ? await proj(def, { ...settings, effective_from: settings.effective_from && settings.effective_from > at ? settings.effective_from : null }, ctx) : { by: w.days.map(() => zero()), samples: [], note: "Off" }; }
    catch (e) {
      console.error(`crm:import: a preview projection failed (${safeErr(e)})`);
      out = { by: w.days.map(() => zero()), samples: [], note: "Couldn't be worked out this time" };
    }
    automations.push({ ...base, kind: "daily", by_day: out.by, total: out.by.reduce(add, zero()), note: out.note || null, samples: out.samples || [] });
  }
  const ap = await autopay(ctx).catch(() => null);
  if (ap) automations.push({ key: "money.autopay", label: "The 1st-of-month autopay run", module: "money", category: "service", enabled: true, kind: "daily", by_day: ap.by, total: ap.by.reduce(add, zero()), note: ap.note, samples: [] });
  const byDay = w.days.map((d, i) => ({ date: d, ...automations.reduce((s, a) => add(s, a.by_day[i] || zero()), zero()) }));
  const [dry, followUps, numbers, flight] = await Promise.all([countDrySends(), countFollowUps(), numberPlan(), inFlightLists()]);
  return {
    at, window_hours: WINDOW_HOURS, days: w.days, automations, by_day: byDay, totals: byDay.reduce(add, zero()),
    seeds: { ...seeds.counts, unmatched: seeds.unmatched, read: seeds.read, applied: ctx.skipped.seeded },
    sequences: { dry_sends: dry, follow_ups: followUps }, numbers, floor: ctx.floor,
    in_flight: Object.fromEntries(Object.entries(flight).map(([k, v]) => [k, v.length])),
  };
}

async function countDrySends() {
  const { directories } = await listKeys("q/", { directories: true });
  let n = 0;
  for (const d of directories) {
    for (const k of await listKeys(`${d.replace(/\/+$/, "")}/`)) {
      const g = await getRaw(k).catch(() => null);
      if (g && g.data && g.data.marker && g.data.marker.ns === "done-dry") n += 1;
    }
  }
  return n;
}
async function countFollowUps() {
  const ix = await readIndex("enrollments/active", "").catch(() => ({ rows: [] }));
  const ids = [...new Set(ix.rows.map((r) => r.c).filter((c) => isId(c, "contact")))];
  const recs = (await getRecords("contact", ids)).filter(Boolean).map((g) => g.data);
  const real = new Set(recs.filter((c) => !(c.flags && c.flags.test === true)).map((c) => c.id));
  return ix.rows.filter((r) => real.has(r.c)).length;
}

// ------------------------------------------------------------ the run

// Lane run "cutover.preview" (bulk): computes, keeps the result at
// cutover/preview/{runId}, and puts its totals on sys/cutover.preview.
async function previewStep(run) {
  const at = run.input && run.input.at;
  const result = await computePreview(at);
  await settledWrite(previewKey(run.id), { ...result, run_id: run.id, import_run_id: run.input.import_run_id || null, computed_at: nowIso() }, { onlyIfNew: true }).catch((e) => {
    if (!/exists|modified/i.test(String(e && e.message))) throw e;
  });
  await updateCutover((st) => (st.preview && st.preview.run_id === run.id ? { ...st, preview: { ...st.preview, status: "done", computed_at: nowIso(), totals: result.totals } } : null));
  return { done: true, result: { totals: result.totals } };
}
defineRun("cutover.preview", { lane: "bulk", step: previewStep, label: "Switch-over preview" });

// POST /cutover/preview: a new preview of the switch at `at` (default now).
export async function startPreview({ at } = {}, ctx) {
  const when = at && Number.isFinite(Date.parse(at)) ? new Date(Date.parse(at)).toISOString() : nowIso();
  const imp = await importState();
  const run = await createRun("cutover.preview", { at: when, import_run_id: imp.latest ? imp.latest.id : null }, ctx);
  await updateCutover((st) => ({ ...st, preview: { run_id: run.id, status: "running", at: when, import_run_id: imp.latest ? imp.latest.id : null, created_at: nowIso(), approved_at: null, approved_by: null } }));
  return { run_id: run.id, at: when };
}

export async function readPreview() {
  const st = await readCutover();
  if (!st.preview || !st.preview.run_id) return null;
  const got = await getRaw(previewKey(st.preview.run_id));
  return { state: st.preview, result: got && got.data ? (({ _w, ...r }) => r)(got.data) : null };
}

export async function approvePreview(ctx) {
  const st = await readCutover();
  const imp = await importState();
  if (!st.preview || st.preview.status !== "done") throw new ConflictError("Make the preview first, and wait for it to finish.");
  if (!previewCurrent(st.preview, imp)) throw new ConflictError("This preview is out of date: make it again on the final import.");
  return updateCutover((s) => (s.preview && s.preview.run_id === st.preview.run_id ? { ...s, preview: { ...s.preview, approved_at: nowIso(), approved_by: ctx.by } } : null));
}
