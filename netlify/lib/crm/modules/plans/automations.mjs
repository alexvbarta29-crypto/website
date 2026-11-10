// Plans module: its automations and sweeps (design §5.7.4, §7.6).
//
//   agreement.sent        event agreement.sent (staff pressed Send): a portal
//                         link (scope agreement, 30 days) by text and/or email
//   agreement.unsigned    sweep, daily 10:00: a reminder text a day for a sent
//                         agreement still unsigned, up to 7 times; each one
//                         a fresh link good until 30 days after the first
//                         send (links are bearer secrets, never stored). Not
//                         a bulk send (per-subject, §5.7.4). An agreement
//                         requested in a bulk run waits until that run went out.
//   plan.renewal_notice   sweep, daily 10:00: 30 days before an auto-renewing
//                         term ends, a renewal notice (a price-change notice
//                         when the price changes); more than the bulk threshold
//                         on one day becomes a bulk run for the owner. Imported
//                         plans are not eligible (Rotor sends its own).
//   lights.rebook         sweep from cfg/lights.rebook_on (09-01): one ready-to-
//                         send bulk run for the owner (never sends by itself):
//                         everyone with a stored or taken-down season last year;
//                         an active 3-year contract gets its next season record
//                         and a "we'll be out again" bulk run instead.
// Sweeps: plans.due, plans.jobs_backfill, plans.ordinal_sync (plans.mjs),
// lights.takedown_due (lights.mjs). Every text goes through the core sender:
// the Outbox (dry-run) until cutover.

import { getRecord, getRecords, readIndex, updateRecord, getSetting } from "../../../crm-store.mjs";
import { isId } from "../../core/ids.mjs";
import { now, localDate, addLocalDays, zonedToUtc } from "../../core/clock.mjs";
import { runAutomation } from "../../core/automations.mjs";
import { createPortalLink } from "../../portal/core.mjs";
import { has, call } from "../../core/services.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { noticeDue, monthOf } from "./machine.mjs";
import { perVisitText } from "./agreements.mjs";
import { plansDue, jobsBackfill, ordinalSync, ensureJobs } from "./plans.mjs";
import { takedownDueSweep, claimRebook } from "./lights.mjs";
import { loadLights } from "./catalog.mjs";

const DATE = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
export const dateWords = (d) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? DATE.format(new Date(`${d}T18:00:00Z`)) : "");
const TEMPLATE = { sms: "agreement_sent", email: "agreement_sent_email" };
export const UNSIGNED_MAX = 7;
const today = () => localDate(now());

async function agreementLink(a) {
  const portal = await getSetting("portal").catch(() => ({}));
  const days = (portal && portal.lifetimes && portal.lifetimes.agreement_days) || 30;
  const base = a.sent_at ? localDate(new Date(a.sent_at)) : today();
  const until = zonedToUtc(addLocalDays(base, days), "23:59");
  const at = until > now() ? until : zonedToUtc(addLocalDays(today(), days), "23:59");
  return createPortalLink({ contact_id: a.contact_id, scope: { kind: "agreement", id: a.id }, expires_at: at.toISOString(), created_by: "automation:agreement" });
}
const planNameOf = async (a) => {
  if (!isId(a.plan_id, "plan")) return a.title || "service";
  const g = await getRecord("plan", a.plan_id).catch(() => null);
  return g ? g.data.name : a.title;
};

// ------------------------------------------------------------ agreement.sent

export async function agreementSentRun(input, actx) {
  const p = (input.event && input.event.payload) || {};
  const channels = (Array.isArray(p.channels) ? p.channels : []).filter((c) => TEMPLATE[c]);
  if (!channels.length) { await actx.log(p.agreement_id, "skipped:no_channels"); return { result: "skipped:no_channels" }; }
  const g = isId(p.agreement_id, "agreement") ? await getRecord("agreement", p.agreement_id).catch(() => null) : null;
  const a = g && g.data;
  if (!a || a.deleted_at || !["sent", "viewed"].includes(a.status)) { await actx.log(p.agreement_id, "skipped:changed"); return { result: "skipped:changed" }; }
  const link = await agreementLink(a);
  const plan_name = await planNameOf(a);
  let queued = 0;
  for (const ch of channels) {
    const r = await actx.send({
      contact_id: a.contact_id, subject: { type: "agreement", id: a.id }, key: `${a.id}--${String(input.event.event_id || p.wv || "x").slice(0, 30)}--${ch}`,
      channel: ch, template_key: TEMPLATE[ch], vars: { agreement_link: link.url, plan_name }, related: { agreement_id: a.id },
    });
    if (r.queued) queued += 1;
  }
  return { result: queued ? `queued:${queued}` : "skipped:not_queued" };
}

// Re-checked when the send is due: a signed or voided agreement isn't texted.
export async function agreementRecheck(item) {
  const id = item && item.data && item.data.related && item.data.related.agreement_id;
  const g = id ? await getRecord("agreement", id).catch(() => null) : null;
  if (!g || g.data.deleted_at || !["sent", "viewed"].includes(g.data.status)) return { skip: "changed" };
  return {};
}

// ------------------------------------------------------------ agreement.unsigned

// The agreements due a reminder today (pure apart from the bulk run check).
export async function unsignedDue(day = today()) {
  const rows = (await readIndex("agreements", "pending")).rows.filter((r) => ["sent", "viewed"].includes(r.st) && r.sent && localDate(new Date(r.sent)) < day && (r.rc || 0) < UNSIGNED_MAX);
  const recs = (await getRecords("agreement", rows.map((r) => r.id))).filter(Boolean).map((g) => g.data);
  const bulk = new Map();
  const out = [];
  for (const a of recs) {
    if (!["sent", "viewed"].includes(a.status)) continue;
    if (a.reminders && a.reminders.last_at && localDate(new Date(a.reminders.last_at)) >= day) continue;
    if (isId(a.bulk_run_id, "bulk_run")) {
      if (!bulk.has(a.bulk_run_id)) bulk.set(a.bulk_run_id, ((await getRecord("bulk_run", a.bulk_run_id).catch(() => null)) || {}).data || null);
      const b = bulk.get(a.bulk_run_id);
      if (!b || b.status !== "sent") continue;
    }
    out.push(a);
  }
  return out;
}

export async function agreementUnsignedRun(input, actx) {
  const day = input.date || today();
  let queued = 0;
  for (const a of input.agreements || []) {
    const link = await agreementLink(a);
    const r = await actx.send({
      contact_id: a.contact_id, subject: { type: "agreement", id: a.id }, key: `${a.id}--${day}`, channel: "sms", template_key: "agreement_unsigned",
      vars: { agreement_link: link.url, plan_name: await planNameOf(a) }, related: { agreement_id: a.id },
    });
    if (!r.queued) continue;
    queued += 1;
    await updateRecord("agreement", a.id, (x) => (x.reminders && x.reminders.last_at && localDate(new Date(x.reminders.last_at)) >= day ? null : { ...x, reminders: { count: ((x.reminders && x.reminders.count) || 0) + 1, last_at: now().toISOString() } }), actx.write())
      .catch((e) => console.error(`crm:plans: reminder count not saved (${safeErr(e)})`));
  }
  return { result: `queued:${queued}` };
}

async function unsignedSweep(ctx) {
  const list = await unsignedDue();
  if (!list.length) return { done: true, result: "none" };
  const r = await runAutomation("agreement.unsigned", { agreements: list, date: today() }, { mode: ctx.mode, requestId: ctx.requestId, deploy: ctx.deploy });
  return { done: true, result: r.result, progress: list.length };
}

// ------------------------------------------------------------ plan.renewal_notice

export async function renewalsDue(day = today()) {
  const rows = (await readIndex("plans", "")).rows.filter((r) => r.st === "active" && r.te && day >= addLocalDays(r.te, -30) && day <= r.te);
  const plans = (await getRecords("plan", rows.map((r) => r.id))).filter(Boolean).map((g) => g.data);
  return plans.filter((p) => noticeDue(p, day) && (p.renewal || {}).notice_term !== p.term.current_term_n);
}

export async function renewalNoticeRun(input, actx) {
  const plans = input.plans || [];
  const plain = [];
  const priced = [];
  for (const p of plans) {
    if (p.import) { await actx.log(p.id, "skipped:imported"); continue; }
    const start = addLocalDays(p.term.current_term_end, 1);
    const pc = p.renewal && p.renewal.price_change;
    const changes = pc && pc.effective_on && pc.effective_on <= addLocalDays(p.term.current_term_end, 1) && Array.isArray(pc.new_lines);
    const step = {
      contact_id: p.contact_id, subject: { type: "plan", id: p.id }, key: `${p.id}--t${p.term.current_term_n}`, related: { plan_id: p.id },
      vars: { plan_name: p.name, due_date: dateWords(start), expires_on: changes ? dateWords(pc.effective_on) : null, per_visit_price: changes ? perVisitText({ ...p, lines: pc.new_lines }) : perVisitText(p) },
    };
    (changes ? priced : plain).push(step);
  }
  const out = [];
  if (plain.length) out.push(await actx.sendMany(plain.map((s) => ({ ...s, template_key: undefined })), { title: `Plan renewal notices ${today()}`, related: { kind: "plan.renewal_notice" } }));
  if (priced.length) out.push(await actx.sendMany(priced.map((s) => ({ ...s, channel: "sms", template_key: "plan_price_change" })), { channel: "sms", template_key: "plan_price_change", title: `Plan price change notices ${today()}` }));
  // each plan's notice is recorded once per term (renewal is the CRM's, never Rotor's field)
  for (const s of [...plain, ...priced]) {
    await updateRecord("plan", s.subject.id, (p) => ((p.renewal || {}).notice_term === p.term.current_term_n ? null : { ...p, renewal: { ...(p.renewal || {}), notice_term: p.term.current_term_n, notice_sent_at: now().toISOString() } }), actx.write())
      .catch((e) => console.error(`crm:plans: renewal notice not recorded (${safeErr(e)})`));
  }
  return { result: out.some((x) => x && x.bulk) ? "bulk_run" : `queued:${plain.length + priced.length}` };
}

async function renewalSweep(ctx) {
  const plans = await renewalsDue();
  if (!plans.length) return { done: true, result: "none" };
  const r = await runAutomation("plan.renewal_notice", { plans }, { mode: ctx.mode, requestId: ctx.requestId, deploy: ctx.deploy });
  return { done: true, result: r.result, progress: plans.length };
}

// ------------------------------------------------------------ lights.rebook

// Who gets last season's rebook: { rebook: [contact ids], contracts: [plans] }.
export async function rebookAudience(season) {
  const rows = (await readIndex("lights", String(season - 1))).rows.filter((r) => ["stored", "taken_down"].includes(r.st));
  const contracts = [];
  const rebook = new Set();
  const planIds = [...new Set(rows.map((r) => r.pl).filter((x) => isId(x, "plan")))];
  const plans = new Map((await getRecords("plan", planIds)).filter(Boolean).map((g) => [g.data.id, g.data]));
  for (const r of rows) {
    const p = r.pl ? plans.get(r.pl) : null;
    const active3 = p && ["active", "pending"].includes(p.status) && (p.ordinals || []).some((o) => Number(o.target_month.slice(0, 4)) === season && ["unscheduled", "scheduled"].includes(o.status)) && ((p.term && p.term.initial_months >= 36) || (p.discounts || []).some((d) => d.key === "three_year"));
    if (active3) { if (!contracts.some((x) => x.id === p.id)) contracts.push(p); continue; }
    rebook.add(r.c);
  }
  for (const p of contracts) rebook.delete(p.contact_id);
  return { rebook: [...rebook], contracts };
}

export async function lightsRebookRun(input, actx) {
  const season = input.season;
  const { rebook, contracts } = await rebookAudience(season);
  if (!rebook.length && !contracts.length) { await actx.log(null, "skipped:nobody"); return { result: "skipped:nobody" }; }
  if (!has("bulk.create")) return { result: "skipped:no_bulk" };
  const out = [];
  if (rebook.length) {
    out.push(await call("bulk.create", { kind: "lights.rebook", title: `Christmas lights rebook ${season}`, recipients: rebook.slice(0, 2000), template_key: "lights_rebook", channel: "sms", vars: { season_year: String(season) }, related: { season }, requested_by: "automation:lights.rebook" }, actx.write()));
  }
  // an active 3-year contract: the next season's record (install and takedown), and a confirmation for the owner to send
  const confirmed = [];
  for (const p of contracts) {
    const r = await actx.mutate({ record: p }, "create", async () => ensureJobs(p.id, actx.write(), { day: `${season}-09-01` }), { season_install: 1 });
    if (r.done) confirmed.push(p.contact_id);
  }
  if (confirmed.length) {
    out.push(await call("bulk.create", { kind: "lights.confirm", title: `Christmas lights ${season}: 3-year customers`, recipients: [...new Set(confirmed)], template_key: "lights_confirm", channel: "sms", vars: { season_year: String(season) }, related: { season }, requested_by: "automation:lights.rebook" }, actx.write()));
  }
  for (const id of out) await actx.log(id, "bulk_run", { season });
  return { result: `bulk_runs:${out.length}`, bulk_run_ids: out };
}

async function rebookSweep(ctx) {
  const lights = await loadLights();
  const day = today();
  const season = Number(day.slice(0, 4));
  const from = `${season}-${lights.rebook_on || "09-01"}`;
  if (day < from || day > `${season}-12-31`) return { done: true, result: "not_yet" };
  if (!(await claimRebook(season))) return { done: true, result: "already" };
  const r = await runAutomation("lights.rebook", { season }, { mode: ctx.mode, requestId: ctx.requestId, deploy: ctx.deploy });
  return { done: true, result: r.result };
}

// ------------------------------------------------------------ the manifest's lists

export const automations = [
  {
    key: "agreement.sent", label: "Send the agreement", trigger: "event:agreement.sent", category: "service", imported: "no", mutates: false,
    defaults: { enabled: true, channels: ["sms", "email"], template_keys: ["agreement_sent", "agreement_sent_email"] }, run: agreementSentRun, recheck: agreementRecheck,
  },
  {
    key: "agreement.unsigned", label: "Unsigned agreement reminders", trigger: "sweep", category: "service", imported: "no", mutates: true,
    defaults: { enabled: true, channels: ["sms"], template_keys: ["agreement_unsigned"] }, run: agreementUnsignedRun, recheck: agreementRecheck,
  },
  {
    key: "plan.renewal_notice", label: "Plan renewal notice", trigger: "sweep", category: "service", imported: "no", mutates: true,
    defaults: { enabled: true, channels: ["sms", "email"], template_keys: ["plan_renewal_notice", "plan_renewal_notice_email", "plan_price_change"] }, run: renewalNoticeRun,
  },
  {
    key: "lights.rebook", label: "Christmas lights rebook", trigger: "sweep", category: "service", imported: "eligible", mutates: true,
    defaults: { enabled: true, channels: ["sms"], template_keys: ["lights_rebook", "lights_confirm"] }, run: lightsRebookRun,
  },
];

export const sweeps = [
  { key: "plans.due", label: "Plan dates (pauses, cancels, renewals)", lane: "fast", every: "daily", at_local: "06:00", mutates: true, run: (ctx) => plansDue(ctx) },
  { key: "plans.jobs_backfill", label: "Jobs for plan visits", lane: "fast", every: "hourly", mutates: true, run: (ctx) => jobsBackfill(ctx) },
  { key: "plans.ordinal_sync", label: "Plan visits vs their jobs", lane: "fast", every: "hourly", mutates: true, run: (ctx) => ordinalSync(ctx) },
  { key: "lights.takedown_due", label: "Christmas lights takedowns", lane: "fast", every: "monthly", day: 2, at_local: "06:00", mutates: true, run: (ctx) => takedownDueSweep(ctx) },
  { key: "agreement.unsigned", label: "Unsigned agreement reminders", lane: "fast", every: "daily", at_local: "10:00", mutates: true, run: (ctx) => unsignedSweep(ctx) },
  { key: "plan.renewal_notice", label: "Plan renewal notices", lane: "fast", every: "daily", at_local: "10:00", mutates: true, run: (ctx) => renewalSweep(ctx) },
  { key: "lights.rebook", label: "Christmas lights rebook", lane: "fast", every: "daily", at_local: "08:40", mutates: false, run: (ctx) => rebookSweep(ctx) },
];

export { monthOf };
