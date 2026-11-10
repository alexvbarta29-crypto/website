// Plans module: the plan lifecycle (design §5.4, §11.3).
//
//   fromQuoteOption(quote, version, option, opId, { signature? }, ctx)
//        the plans.fromQuoteOption service, called inside the quote's
//        convert op: the plan (id derived from that op, so a re-run or a
//        double tap makes it once), the SIGNED agreement when the customer
//        signed the plan's text with the quote (the same body_sha256), the
//        first term's jobs (one per visit, through work.createJobs with
//        scope "plans"; a lights plan gets its season instead), then active
//        or pending (signature, card). One resumable sub-op, "plans.make".
//   createStaffPlan(body, ctx)    POST /plans: the same op for a plan the
//        office sets up (pending until its agreement is signed)
//   startAction(id, action, args) POST /plans/:id/pause|resume|skip|cancel|
//        renew|activate|withdraw: a run on the fast lane around the op
//        "plans.act" (op id plan-{action}--{id}--{wv}: a double tap is one
//        op). Each applies one event of the state machine (machine.mjs
//        applyAction), then cancels or makes the jobs it implies, then
//        emits the event. A step that died is finished by ops.resume.
//   listeners  job.* and visit.* keep the ordinals in step (a booked visit
//        re-spaces the later unscheduled ones), agreement.signed and
//        card.saved activate a pending plan; the lights part follows its
//        jobs. Listeners act as automation: on a plan Rotor still owns they
//        write would- rows (§0 rule 12).
//   sweeps     plans.due (06:00: pauses that end, cancels that take effect,
//        terms that end: renew or expire), plans.jobs_backfill (hourly:
//        jobs for visits that have none, once work.createJobs exists),
//        plans.ordinal_sync (hourly: ordinals vs their jobs' status).

import { createHash } from "node:crypto";
import { createRecord, getRecord, getRecords, updateRecord, readIndex, listRel, updateStats, addActivity } from "../../../crm-store.mjs";
import { deriveId, isId } from "../../core/ids.mjs";
import { now, nowIso, localDate, addLocalDays } from "../../core/clock.mjs";
import { InputError, NotFoundError, ConflictError, ExistsError, BlobsTransientError } from "../../core/errors.mjs";
import { emit } from "../../core/events.mjs";
import { defineOp, runOp, opIdFor, readOp } from "../../core/ops.mjs";
import { defineRun, createRun } from "../../core/lanes.mjs";
import { has, call } from "../../core/services.mjs";
import { notify, approvers } from "../../core/notify.mjs";
import { sendMessage } from "../../core/send.mjs";
import { keySafe } from "../../core/text.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { LIVE_PLAN, OPEN_ORDINAL, validatePlanLine, validatePlanDiscount, CATALOG_KEYS, BILLING_MODES } from "./types.mjs";
import { loadCatalog } from "./catalog.mjs";
import {
  firstTerm, termOrdinals, saleValue, ordinalLines, ordinalDiscounts, applyAction, respace, ordinalStatusForJob, termOver, monthOf, addMonthsYm, visitsPerYearOf,
} from "./machine.mjs";
import { quoteAgreement, signedEffects } from "./agreements.mjs";
import { formatCents } from "../../core/money.mjs";
import { planRow as planRowOf } from "./types.mjs";
import { createSeason, seasonOfJob, syncSeason, seasonForInstallJob } from "./lights.mjs";

export const W = (ctx = {}) => (ctx && typeof ctx.write === "function" ? ctx.write() : { ...(ctx || {}) });
const sha = (s) => createHash("sha256").update(String(s)).digest("hex");
const nameOf = (c) => (c ? c.display_name || [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || c.company_name || "" : "");
const today = () => localDate(now());
const typesOfLines = (lines = []) => [...new Set((lines || []).map((l) => String((l && l.service_type) || "").split("::")[0].trim()).filter(Boolean))].slice(0, 20);
export const PLAN_ACTIONS = Object.freeze(["activate", "pause", "resume", "skip", "cancel", "withdraw", "renew", "expire", "cancel_effective"]);
export const LIGHTS_HORIZON_MONTHS = 3;

export async function getPlan(id) {
  if (!isId(id, "plan")) throw new NotFoundError("That plan isn't there.");
  const g = await getRecord("plan", id);
  if (!g || g.data.deleted_at) throw new NotFoundError("That plan isn't there.");
  return g;
}

// The contact, its display name and the plan's property (and town).
async function placeFor(contactId, propertyId) {
  const c = await getRecord("contact", contactId);
  if (!c || c.data.deleted_at) throw new NotFoundError("That contact isn't there anymore.");
  const contact = c.data;
  const pid = isId(propertyId, "property") ? propertyId : isId(contact.primary_property_id, "property") ? contact.primary_property_id : null;
  const p = pid ? await getRecord("property", pid) : null;
  const town = p && !p.data.deleted_at ? (p.data.address && p.data.address.city) : contact.billing_address && contact.billing_address.city;
  return { contact, name: nameOf(contact), property_id: p && !p.data.deleted_at ? p.data.id : undefined, town: town || undefined };
}

// ------------------------------------------------------------ building a plan

// A new plan's record (pure apart from the catalog passed in). spec: the
// contact and place, catalog_key, name?, frequency?, visits_per_year?,
// lines, discounts, start_on, term_months?, auto_renew?, billing_mode?,
// autopay?, card_required?, links (quote, version, option, deal), sold_by, origin.
export function buildPlan(spec, cat, { start_on }) {
  const key = CATALOG_KEYS.includes(spec.catalog_key) ? spec.catalog_key : "custom";
  const entry = cat.plans[key] || cat.plans.custom;
  const frequency = spec.frequency || entry.frequency;
  const vpy = spec.visits_per_year || entry.visits_per_year || visitsPerYearOf(frequency);
  const months = spec.term_months || entry.initial_months;
  const term = firstTerm({ start_on, initial_months: months, renews_every_months: entry.renews_every_months, auto_renew: spec.auto_renew !== false });
  const lines = (spec.lines || []).filter((l) => !(l.optional && l.selected !== true));
  const plan = {
    id: spec.id, contact_id: spec.contact_id, contact_name: spec.contact_name, ...(spec.property_id ? { property_id: spec.property_id } : {}), ...(spec.town ? { town: spec.town } : {}),
    ...(spec.quote_id ? { quote_id: spec.quote_id } : {}), ...(spec.quote_version_id ? { quote_version_id: spec.quote_version_id } : {}), ...(spec.option_id ? { option_id: spec.option_id } : {}),
    ...(spec.deal_id ? { deal_id: spec.deal_id } : {}),
    kind: key === "lights_annual" ? "lights_annual" : "recurring", catalog_key: key, name: spec.name || entry.name, frequency, visits_per_year: vpy,
    service_types: spec.service_types && spec.service_types.length ? spec.service_types : typesOfLines(lines), lines, discounts: spec.discounts || [],
    status: "pending", pending_reasons: ["signature"], term,
    billing: { mode: BILLING_MODES.includes(spec.billing_mode) ? spec.billing_mode : entry.billing, autopay: spec.autopay === undefined ? !!entry.autopay : !!spec.autopay, card_required: !!spec.card_required },
    perks: { ...entry.perks }, policy: { early_cancel_clawback_cents: entry.clawback_cents, notice_days: cat.notice_days, late_cancel_fee_cents: cat.late_cancel_fee_cents },
    ordinals: termOrdinals({ frequency, visits_per_year: vpy }, { term: 1, start: start_on, months }), cancelled_job_ids: [], agreement_status: "none",
    renewal: { next_on: term.current_term_end }, ...(spec.sold_by ? { sold_by: spec.sold_by } : {}), origin: spec.origin || "staff",
  };
  if (plan.billing.autopay) plan.billing.card_required = true;
  plan.sale_value_cents = saleValue(plan);
  return plan;
}

// One ordinal's job (the work.createJobs contract, §11.3).
export function jobSpec(plan, o) {
  const count = (plan.ordinals || []).filter((x) => (x.term || 1) === (o.term || 1)).length;
  return {
    contact_id: plan.contact_id, ...(plan.property_id ? { property_id: plan.property_id } : {}), kind: "standard",
    title: `${plan.name}: visit ${o.n}${count > 1 ? ` of ${count}` : ""}`.slice(0, 120), lines: ordinalLines(plan, o), discounts: ordinalDiscounts(plan, o),
    plan_id: plan.id, plan_ordinal: { term: o.term || 1, n: o.n }, target_month: o.target_month, billable: true,
    ...(plan.quote_id ? { quote_id: plan.quote_id } : {}), ...(plan.deal_id ? { deal_id: plan.deal_id } : {}), service_types: plan.service_types || [],
  };
}

// The ordinals that should have a job now: open, without one, in the
// current term (a lights plan: only the season about to come).
export function ordinalsNeedingJobs(plan, day = today()) {
  if (!["pending", "active", "cancelling"].includes(plan.status)) return [];
  const n = (plan.term && plan.term.current_term_n) || 1;
  const horizon = addMonthsYm(monthOf(day), LIGHTS_HORIZON_MONTHS);
  return (plan.ordinals || []).filter((o) => (o.term || 1) === n && o.status === "unscheduled" && !o.job_id && (plan.kind !== "lights_annual" || o.target_month <= horizon));
}
const ordKey = (o) => `${o.term || 1}-${o.n}-g${o.gen || 0}`;

// Makes the missing jobs of a plan (work.createJobs, scope "plans"; a
// lights season through the lights op) and writes their ids on the
// ordinals. The work op's id comes from the plan and the ordinals' keys, so
// a retry makes nothing twice. → job ids made or found.
export async function ensureJobs(planId, ctx, { day = today() } = {}) {
  if (!has("work.createJobs")) return [];
  const g = await getRecord("plan", planId);
  if (!g) return [];
  const plan = g.data;
  const need = ordinalsNeedingJobs(plan, day);
  if (!need.length) return [];
  const made = {};
  if (plan.kind === "lights_annual") {
    for (const o of need) {
      const season = Number(o.target_month.slice(0, 4));
      const three = (plan.term && plan.term.initial_months >= 36) || (plan.discounts || []).some((d) => d.key === "three_year");
      const out = await createSeason({
        contact_id: plan.contact_id, property_id: plan.property_id, season, plan_id: plan.id, plan_ordinal: { term: o.term || 1, n: o.n }, quote_id: plan.quote_id, deal_id: plan.deal_id,
        lines: ordinalLines(plan, o), discounts: ordinalDiscounts(plan, o), early_bird: (plan.discounts || []).some((d) => d.key === "early_bird") && o.k === 1, three_year: three,
        ...(three ? { contract_season_n: Math.min(3, o.k || 1) } : {}),
      }, `plan-season--${plan.id}--${season}`, ctx);
      if (out.install_job_id) made[ordKey(o)] = { job: out.install_job_id, season: out.season_id };
    }
  } else {
    const keys = need.map(ordKey).join(",");
    const opId = `plan-jobs--${plan.id}--${sha(keys).slice(0, 12)}`;
    const ids = (await call("work.createJobs", need.map((o) => jobSpec(plan, o)), opId, "plans", ctx)) || [];
    need.forEach((o, i) => { if (isId(ids[i], "job")) made[ordKey(o)] = { job: ids[i] }; });
  }
  if (!Object.keys(made).length) return [];
  await updateRecord("plan", planId, (p) => {
    let changed = false;
    const ordinals = (p.ordinals || []).map((o) => {
      const m = made[ordKey(o)];
      if (!m || o.job_id || o.status !== "unscheduled") return o;
      changed = true;
      return { ...o, job_id: m.job };
    });
    const seasons = Object.values(made).map((m) => m.season).filter(Boolean);
    const sids = [...new Set([...(p.season_install_ids || []), ...seasons])];
    if (sids.length !== (p.season_install_ids || []).length) changed = true;
    return changed ? { ...p, ordinals, ...(sids.length ? { season_install_ids: sids.slice(-20) } : {}) } : null;
  }, W(ctx));
  return Object.values(made).map((m) => m.job);
}

// ------------------------------------------------------------ stats, timeline, events

export async function touchPlanStats(contactId, ctx) {
  if (!isId(contactId, "contact")) return;
  try {
    const rows = await listRel("contact-plans", contactId, { limit: 100 });
    const plans = (await getRecords("plan", rows.map((r) => r.id))).filter(Boolean).map((g) => g.data);
    const ids = plans.filter((p) => !p.deleted_at && p.contact_id === contactId && p.kind !== "one_time_series" && ["active", "paused", "cancelling"].includes(p.status)).map((p) => p.id).sort();
    await updateStats(contactId, "plans", (part) => (JSON.stringify((part && part.active_plan_ids) || []) === JSON.stringify(ids) ? null : { ...part, active_plan_ids: ids }), W(ctx));
  } catch (e) { console.error(`crm:plans: stats not updated (${safeErr(e)})`); }
}

async function planEvent(name, plan, ctx, extra = {}) {
  if (!name) return;
  const wv = plan.last_change && Number.isSafeInteger(plan.last_change.wv) ? plan.last_change.wv : plan.wv;
  await emit(name, { id: plan.id, wv, plan_id: plan.id, contact_id: plan.contact_id, at: nowIso(), ...extra }, W(ctx))
    .catch((e) => console.error(`crm:plans: ${name} not queued (${safeErr(e)})`));
  await addActivity(plan.contact_id, name, plan.id).catch(() => {});
}

async function tellStaff(plan, title, body, ctx) {
  try {
    const people = new Set(await approvers().catch(() => []));
    if (isId(plan.sold_by, "user")) people.add(plan.sold_by);
    await notify([...people].slice(0, 10), { kind: "system", title, body, link: `/plans/${plan.id}` }, W(ctx));
  } catch (e) { console.error(`crm:plans: staff notification not sent (${safeErr(e)})`); }
}

// Is the card a plan needs on file? Only Money knows (money.cardStatus);
// before Money "card required" is recorded, not enforced (§11.3 feature gates).
async function cardOnFile(plan, ctx) {
  if (!plan.billing || !plan.billing.card_required || !has("money.cardStatus")) return { money: has("money.cardStatus"), ok: true };
  try {
    const s = await call("money.cardStatus", plan.contact_id, W(ctx));
    return { money: true, ok: !!s && ["on_file", "verified"].includes(s.status) };
  } catch { return { money: true, ok: false }; }
}

export async function readiness(plan, ctx) {
  const card = await cardOnFile(plan, ctx);
  const reasons = [];
  if (plan.agreement_status !== "signed") reasons.push("signature");
  if (plan.billing && plan.billing.card_required && card.money && !card.ok) reasons.push("card");
  return reasons;
}

// ------------------------------------------------------------ the creation op

// input: { plan (the whole record to make), agreement?: { id, frozen,
// signature, quote_id, version_id } }
defineOp("plans.make", {
  steps(input) {
    const id = input.plan.id;
    return [
      {
        name: "plan",
        async run(s) {
          if (await getRecord("plan", id)) return { created: false };
          try { await createRecord("plan", input.plan, s.ctx); } catch (e) { if (!(e instanceof ExistsError)) throw e; return { created: false }; }
          await touchPlanStats(input.plan.contact_id, s.ctx);
          await addActivity(input.plan.contact_id, "plan.created", id).catch(() => {});
          return { created: true };
        },
      },
      {
        name: "agreement",
        async run(s) {
          const a = input.agreement;
          if (!a) return { agreement_id: null };
          const plan = (await getRecord("plan", id)).data;
          const ag = await quoteAgreement({ id: a.id, plan, quote: { id: a.quote_id }, version: { id: a.version_id }, frozen: a.frozen, signature: a.signature }, s.ctx);
          if (!ag) return { agreement_id: null, unsigned: true };
          await signedEffects(ag, s.ctx);
          return { agreement_id: ag.id };
        },
      },
      {
        name: "jobs",
        async run(s) { return { job_ids: await ensureJobs(id, s.ctx) }; },
      },
      {
        name: "status",
        async run(s) {
          const g = await getRecord("plan", id);
          const plan = g.data;
          if (plan.status !== "pending") return { status: plan.status };
          const reasons = await readiness(plan, s.ctx);
          if (!reasons.length) {
            const r = await activateRecord(id, {}, s.ctx);
            return { status: r.data.status };
          }
          if (JSON.stringify(reasons) !== JSON.stringify(plan.pending_reasons || [])) await updateRecord("plan", id, (p) => (p.status === "pending" ? { ...p, pending_reasons: reasons } : null), s.ctx);
          return { status: "pending", pending_reasons: reasons };
        },
      },
    ];
  },
});

// pending → active (the record, then its effects; a replay emits under the same id).
async function activateRecord(id, args, ctx) {
  const w = W(ctx);
  const at = nowIso();
  const r = await updateRecord("plan", id, (p) => {
    if (p.status !== "pending") return null;
    const out = applyAction(p, "activate", args, { today: today(), at, by: w.by });
    return { ...out.next, last_change: { op: `activate@${at}`, action: "activate", wv: (p.wv || 0) + 1, at, event: "plan.activated" } };
  }, w);
  if (r.changed) await activatedEffects(r.data, ctx);
  return r;
}
// A signature (portal, hub, in person) activates a pending plan that's
// ready, inline, as the customer's own action (the listener is the backstop).
export async function activateIfReady(a, ctx) {
  if (!a || !isId(a.plan_id, "plan")) return null;
  const g = await getRecord("plan", a.plan_id);
  if (!g || g.data.status !== "pending") return null;
  const reasons = await readiness(g.data, ctx);
  if (reasons.length) return notePending(a.plan_id, reasons, ctx);
  return activateRecord(a.plan_id, {}, ctx);
}

// A pending plan's reasons, kept current (what the Plans list shows).
async function notePending(planId, reasons, ctx) {
  return updateRecord("plan", planId, (p) => (p.status !== "pending" || JSON.stringify(p.pending_reasons || []) === JSON.stringify(reasons) ? null : { ...p, pending_reasons: reasons }), W(ctx));
}

async function activatedEffects(plan, ctx) {
  await planEvent("plan.activated", plan, ctx);
  await touchPlanStats(plan.contact_id, ctx);
  await tellStaff(plan, "Plan active", `${(plan.contact_name || "A customer").split(/\s+/)[0]}'s ${plan.name} is active.`, ctx);
}

async function runMake(opId, input, ctx) {
  const out = await runOp(opIdFor(`plans--${keySafe(opId, 150)}`, 1), "plans.make", { input, ctx: W(ctx), holder: String(W(ctx).requestId || "plans").slice(0, 80), resume: true });
  if (out.status === "running") throw new BlobsTransientError("That plan is still being set up. Try again in a minute.");
  if (out.status === "failed") throw new ConflictError("That plan couldn't be set up.", { code: (out.error && out.error.code) || "failed" });
  const j = await readOp(opIdFor(`plans--${keySafe(opId, 150)}`, 1));
  return j ? j.out || {} : {};
}

// ------------------------------------------------------------ plans.fromQuoteOption

// (quote, version, option, opId, { signature? }, ctx) → { plan_id, agreement_id?, job_ids }
export async function fromQuoteOption(quote, version, option, opId, opts = {}, ctx = {}) {
  if (!quote || !isId(quote.id, "quote")) throw new InputError("Which quote?", "quote");
  if (!option || option.kind !== "plan" || !option.plan) throw new InputError("That option isn't a plan.", "option");
  if (typeof opId !== "string" || !opId) throw new InputError("fromQuoteOption needs the op it runs in.", "op");
  const id = deriveId("plan", opId, "plans.fromQuoteOption", 1);
  const have = await getRecord("plan", id);
  let plan;
  if (have) plan = have.data;
  else {
    const cat = await loadCatalog();
    const place = await placeFor(quote.contact_id, quote.property_id);
    const p = option.plan;
    plan = buildPlan({
      id, contact_id: place.contact.id, contact_name: place.name, property_id: place.property_id, town: place.town,
      quote_id: quote.id, quote_version_id: version && version.id, option_id: option.id, deal_id: quote.deal_id || undefined,
      catalog_key: p.catalog_key, name: option.name, frequency: p.frequency, visits_per_year: p.visits_per_year, lines: option.lines || [], discounts: option.discounts || [],
      term_months: p.term_months, auto_renew: p.auto_renew !== false, billing_mode: p.billing, autopay: p.autopay === true,
      card_required: !!(quote.agreement && quote.agreement.require_card), sold_by: quote.sold_by, origin: "quote",
    }, cat, { start_on: today() });
  }
  const signature = opts && opts.signature;
  const frozen = version && version.plan_agreements && version.plan_agreements[option.id];
  const agreement = signature && frozen ? { id: deriveId("agreement", opId, "plans.fromQuoteOption", 1), frozen, signature, quote_id: quote.id, version_id: version.id } : null;
  const out = await runMake(opId, { plan, ...(agreement ? { agreement } : {}) }, ctx);
  return { plan_id: id, agreement_id: (out.agreement && out.agreement.agreement_id) || null, job_ids: (out.jobs && out.jobs.job_ids) || [] };
}

// ------------------------------------------------------------ the office's new plan (POST /plans)

export async function createStaffPlan(body = {}, ctx) {
  if (!isId(body.contact_id, "contact")) throw new InputError("Pick the customer.", "contact_id");
  const key = CATALOG_KEYS.includes(body.catalog_key) ? body.catalog_key : null;
  if (!key) throw new InputError("Pick a plan.", "catalog_key");
  const lines = (Array.isArray(body.lines) ? body.lines : []).map((l, i) => validatePlanLine({ id: `ln_${i + 1}`, ...l }, `lines.${i}`));
  if (!lines.length) throw new InputError("Add what each visit includes.", "lines");
  const discounts = (Array.isArray(body.discounts) ? body.discounts : []).map((d, i) => validatePlanDiscount({ id: `dc_${i + 1}`, ...d }, `discounts.${i}`));
  const start = body.start_on || today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || start < addLocalDays(today(), -31)) throw new InputError("When does the plan start?", "start_on");
  const months = body.term_months === undefined ? undefined : Number(body.term_months);
  if (months !== undefined && (!Number.isSafeInteger(months) || months < 12 || months > 60)) throw new InputError("A term from 12 to 60 months.", "term_months");
  if (body.billing_mode !== undefined && !BILLING_MODES.includes(body.billing_mode)) throw new InputError("Pick a billing mode.", "billing_mode");
  const clientId = typeof body.client_id === "string" && /^[A-Za-z0-9-]{8,64}$/.test(body.client_id) ? body.client_id : null;
  const id = clientId ? deriveId("plan", `c:${clientId}`) : deriveId("plan", `new:${ctx.requestId || nowIso()}`, "plans", 1);
  const have = await getRecord("plan", id);
  if (have) return { plan_id: id, existing: true };
  const cat = await loadCatalog();
  const place = await placeFor(body.contact_id, body.property_id);
  const plan = buildPlan({
    id, contact_id: place.contact.id, contact_name: place.name, property_id: place.property_id, town: place.town, catalog_key: key, name: typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 120) : undefined,
    lines, discounts, term_months: months, auto_renew: body.auto_renew !== false, billing_mode: body.billing_mode, autopay: body.autopay === undefined ? undefined : body.autopay === true,
    card_required: body.card_required === true, sold_by: W(ctx).by, origin: "staff",
  }, cat, { start_on: start });
  const opId = `plan-new--${id}`;
  const runId = deriveId("run", opId, "plans.make", 0);
  await createRun("plans.make", { op_id: opId, plan }, W(ctx), { id: runId });
  return { plan_id: id, run_id: runId };
}

defineRun("plans.make", {
  lane: "fast", label: "Set up a plan",
  async step(run, rctx) {
    const i = run.input || {};
    const ctx = personCtx(run, rctx);
    try { await runMake(i.op_id, { plan: i.plan }, ctx); } catch (e) {
      if (e instanceof BlobsTransientError) return { progress: { done: 0, total: 1 } };
      return { failed: e.code || "failed", result: { status: "failed", message: String(e.message || "").slice(0, 200) } };
    }
    const p = await getRecord("plan", i.plan.id);
    return { done: true, result: { status: p ? p.data.status : "pending", plan_id: i.plan.id }, progress: { done: 1, total: 1 } };
  },
});

// ------------------------------------------------------------ actions (the "plans.act" op)

defineOp("plans.act", {
  steps(input) {
    return [
      {
        name: "record",
        async run(s) {
          const g = await getRecord("plan", input.plan_id);
          if (!g) throw new NotFoundError("That plan isn't there.");
          if (g.data.last_change && g.data.last_change.op === s.opId) return g.data.last_change;
          const w = W(s.ctx);
          const at = nowIso();
          let lc = null;
          const r = await updateRecord("plan", input.plan_id, (p) => {
            if (p.last_change && p.last_change.op === s.opId) { lc = p.last_change; return null; }
            const out = applyAction(p, input.action, input.args || {}, { today: today(), at, by: w.by });
            lc = { op: s.opId, action: input.action, wv: (p.wv || 0) + 1, at, event: out.event, to_cancel: out.to_cancel, notice: out.notice };
            return { ...out.next, last_change: lc };
          }, s.ctx);
          return (r.data && r.data.last_change && r.data.last_change.op === s.opId) ? r.data.last_change : lc;
        },
      },
      {
        name: "cancel_jobs",
        async run(s) {
          const lc = s.out.record || {};
          const ids = (lc.to_cancel || []).filter((x) => isId(x, "job"));
          if (!ids.length || !has("work.cancelJobs")) return { cancelled: 0 };
          const reason = { pause: "plan paused", skip: "plan visit skipped", cancel: "plan cancelled", cancel_effective: "plan cancelled" }[input.action] || "plan changed";
          const out = (await call("work.cancelJobs", ids, reason, s.opId, s.ctx)) || {};
          return { cancelled: (out.cancelled || []).length };
        },
      },
      {
        name: "make_jobs",
        async run(s) {
          if (!["activate", "resume", "renew", "withdraw"].includes(input.action)) return { made: 0 };
          return { made: (await ensureJobs(input.plan_id, s.ctx)).length };
        },
      },
      {
        name: "effects",
        async run(s) {
          const lc = s.out.record || {};
          const plan = (await getRecord("plan", input.plan_id)).data;
          const p = { ...plan, last_change: lc };
          await planEvent(lc.event, p, s.ctx, input.action === "resume" ? { resumed: true } : {});
          await touchPlanStats(plan.contact_id, s.ctx);
          if (input.action === "activate") await tellStaff(plan, "Plan active", `${(plan.contact_name || "A customer").split(/\s+/)[0]}'s ${plan.name} is active.`, s.ctx);
          if (input.action === "pause" && lc.notice) await pausedNotice(plan, lc, s.ctx);
          if (input.action === "cancel" && plan.status === "cancelling" && plan.cancel && plan.cancel.clawback_cents > 0) {
            await tellStaff(plan, "Clawback to bill", `${plan.name} was cancelled early: the first visit's plan discount (${formatCents(plan.cancel.clawback_cents)}) waits for your OK to bill.`, s.ctx);
          }
          return { status: plan.status };
        },
      },
    ];
  },
});

// The customer hears that a booked visit came off for the pause (through the core sender: dry-run until cutover).
async function pausedNotice(plan, lc, ctx) {
  const w = W(ctx);
  try {
    await sendMessage({
      contact_id: plan.contact_id, channel: "sms", template_key: "plan_paused", vars: { plan_name: plan.name }, related: { plan_id: plan.id },
      origin: isId(w.by, "user") ? { kind: "user", user_id: w.by } : { kind: "automation", id: "plan.paused" }, marker_key: `plan-paused--${plan.id}--${lc.wv}`,
    }, w);
  } catch (e) { console.error(`crm:plans: pause notice not sent (${safeErr(e)})`); }
}

export const actOpId = (planId, action, wv) => opIdFor(`plan-${action}--${planId}`, Number.isSafeInteger(wv) && wv > 0 ? wv : 1);
export const actRunId = (opId) => deriveId("run", opId, "plans.act", 0);

// The write context the op runs under for a person's run.
function personCtx(run, rctx) {
  const by = run.requested_by || "system";
  return { by, origin: "api", actor_kind: isId(by, "user") ? "user" : "automation", requestId: rctx.holder || "plans", ...(rctx.mode ? { mode: rctx.mode } : {}) };
}

// POST /plans/:id/{action}: checks the event applies now, then a run. → { run_id }
export async function startAction(planId, action, args = {}, ctx) {
  if (!PLAN_ACTIONS.includes(action) || action === "cancel_effective" || action === "expire") throw new InputError("Unknown plan action.", "action");
  const g = await getPlan(planId);
  const plan = g.data;
  // a dry run of the transition: a bad request answers 400/409 now, never a failed run later
  try { applyAction(plan, action, args, { today: today(), at: nowIso(), by: W(ctx).by }); } catch (e) {
    if (e.code === "transition") throw new ConflictError(e.message, { code: "transition" });
    throw e;
  }
  if (action === "activate" && plan.status === "pending" && !args.override_reason) {
    const reasons = await readiness(plan, ctx);
    if (reasons.length) throw new ConflictError(reasons.includes("signature") ? "The agreement isn't signed yet. Activate anyway with a reason." : "There's no card on file yet. Activate anyway with a reason.", { code: "not_ready" });
  }
  const opId = actOpId(plan.id, action, plan.wv);
  const runId = actRunId(opId);
  await createRun("plans.act", { op_id: opId, plan_id: plan.id, action, args }, W(ctx), { id: runId });
  return { run_id: runId };
}

defineRun("plans.act", {
  lane: "fast", label: "Change a plan",
  async step(run, rctx) {
    const i = run.input || {};
    let out;
    try {
      out = await runOp(i.op_id, "plans.act", { input: { plan_id: i.plan_id, action: i.action, args: i.args || {} }, ctx: personCtx(run, rctx), holder: `plans.${run.id}` });
    } catch (e) {
      const j = await readOp(i.op_id).catch(() => null);
      if (!j || j.status !== "failed") throw e;
      out = { status: "failed", error: j.error };
    }
    if (out.status === "failed") return { failed: (out.error && out.error.code) || "failed", result: { status: "failed", message: (out.error && out.error.message) || null } };
    if (out.status !== "done") return { progress: { done: 0, total: 1 } };
    const p = await getRecord("plan", i.plan_id);
    return { done: true, result: { status: p ? p.data.status : null, plan_id: i.plan_id, action: i.action }, progress: { done: 1, total: 1 } };
  },
});

// An action by automation (a sweep or a listener): the guard first.
// sctx: the sweep's or listener's context (mayAct, would, write).
export async function automatedAction(plan, action, args, sctx, contact = null) {
  if (!sctx.mayAct({ record: plan, contact })) {
    await sctx.would({ record: plan, contact }, action === "cancel_effective" ? "cancel" : action, { status: [plan.status, null] });
    return { would: true };
  }
  const out = await runOp(actOpId(plan.id, action, plan.wv), "plans.act", { input: { plan_id: plan.id, action, args: args || {} }, ctx: sctx.write(), holder: String(sctx.sweep || "plans.auto").slice(0, 80) });
  return { status: out.status };
}

// PATCH /plans/:id/change-price: a new price from a date at least 30 days
// out and after the locked period (applied at the next renewal on or after it).
export async function changePrice(planId, body = {}, ctx) {
  await getPlan(planId);
  const lines = (Array.isArray(body.new_lines) ? body.new_lines : []).map((l, i) => validatePlanLine({ id: `ln_pc${i + 1}`, ...l }, `new_lines.${i}`));
  const w = W(ctx);
  const at = nowIso();
  return updateRecord("plan", planId, (p) => applyAction(p, "change_price", { new_lines: lines, effective_on: body.effective_on }, { today: today(), at, by: w.by }).next, { ...w, ifMatch: ctx.ifMatch });
}

// PATCH /plans/:id: what the office edits by hand (name, property, autopay, auto-renew, clawback handled).
export async function patchPlan(planId, body = {}, ctx) {
  await getPlan(planId);
  const w = W(ctx);
  return updateRecord("plan", planId, (p) => {
    const next = { ...p };
    if (typeof body.name === "string" && body.name.trim()) next.name = body.name.trim().slice(0, 120);
    if (isId(body.property_id, "property")) next.property_id = body.property_id;
    if (typeof body.autopay === "boolean") next.billing = { ...p.billing, autopay: body.autopay, card_required: body.autopay ? true : p.billing.card_required };
    if (typeof body.auto_renew === "boolean") next.term = { ...p.term, auto_renew: body.auto_renew };
    if (body.clawback === "billed" || body.clawback === "waived") {
      if (!p.cancel || !p.cancel.clawback_cents) throw new ConflictError("There's no clawback on this plan.");
      if (body.clawback === "waived" && !ctx.can("fees:waive")) throw new ConflictError("Waiving needs the fees permission.");
      if (body.clawback === "waived" && !String(body.reason || "").trim()) throw new InputError("Say why it's waived.", "reason");
      next.cancel = { ...p.cancel, clawback_state: body.clawback, clawback_by: w.by, ...(body.reason ? { clawback_reason: String(body.reason).slice(0, 300) } : {}) };
    }
    return next;
  }, { ...w, ifMatch: ctx.ifMatch });
}

// ------------------------------------------------------------ listeners

const firstOf = (c) => String((c && c.contact_name) || "").split(/\s+/)[0];

async function planOfJob(job) {
  if (!isId(job.plan_id, "plan")) return null;
  const g = await getRecord("plan", job.plan_id);
  return g && !g.data.deleted_at ? g.data : null;
}

// job.scheduled/completed/reopened/cancelled: the ordinal follows its job;
// a lights season follows its jobs.
export async function onJobEvent(event, h) {
  const p = event.payload || {};
  const jg = isId(p.job_id, "job") ? await getRecord("job", p.job_id) : null;
  if (!jg) return { result: "skipped:no_job" };
  const job = jg.data;
  const results = [];
  const season = await seasonOfJob(job);
  if (season) results.push((await syncSeason(season, h)).result);
  const plan = await planOfJob(job);
  if (plan) results.push((await syncOrdinal(plan, job, h)).result);
  return { result: results.filter(Boolean).join(",") || "done" };
}

export async function syncOrdinal(plan, job, h, { visitDate } = {}) {
  const o = (plan.ordinals || []).find((x) => x.job_id === job.id);
  if (!o) return { result: "skipped:no_ordinal" };
  const status = ordinalStatusForJob(o, job.status);
  const completed_on = status === "completed" && job.completed_at ? localDate(new Date(job.completed_at)) : undefined;
  const sched = job.schedule || {};
  const vdate = visitDate || (status === "scheduled" ? sched.open_on || sched.first_on : status === "completed" ? sched.last_on || completed_on : undefined);
  if (o.status === status && (!completed_on || o.completed_on === completed_on) && (!vdate || o.visit_date === vdate) && (status !== "unscheduled" || !o.visit_date)) return { result: "same" };
  if (!h.ctx.mayAct({ record: plan })) { await h.ctx.would({ record: plan }, "update", { ordinal: [o.status, status] }); return { result: "would-update" }; }
  let respaced = [];
  await updateRecord("plan", plan.id, (pl) => {
    const cur = (pl.ordinals || []).find((x) => x.job_id === job.id);
    if (!cur) return null;
    const st = ordinalStatusForJob(cur, job.status);
    let ordinals = pl.ordinals.map((x) => {
      if (x !== cur) return x;
      const n = { ...x, status: st };
      if (st === "completed" && completed_on) n.completed_on = completed_on;
      if (vdate && st !== "unscheduled") n.visit_date = vdate;
      if (st === "unscheduled") delete n.visit_date;
      return n;
    });
    // a visit booked for this one: the later unscheduled visits of the term move with it
    if (st === "scheduled" && vdate && cur.visit_date !== vdate) {
      const before = ordinals;
      ordinals = respace({ ...pl, ordinals }, { ...cur, status: st }, vdate);
      respaced = ordinals.filter((x, i) => x.job_id && x.target_month !== before[i].target_month).map((x) => ({ job_id: x.job_id, target_month: x.target_month }));
    }
    const next = { ...pl, ordinals };
    next.sale_value_cents = saleValue(next);
    return JSON.stringify(next) === JSON.stringify(pl) ? null : next;
  }, h.ctx.write());
  // their jobs' due month follows (unscheduled jobs only)
  for (const r of respaced) {
    await updateRecord("job", r.job_id, (j) => (j.status === "unscheduled" && j.target_month !== r.target_month ? { ...j, target_month: r.target_month } : null), h.ctx.write()).catch((e) => console.error(`crm:plans: a job's month not moved (${safeErr(e)})`));
  }
  return { result: `ordinal:${status}` };
}

// visit.scheduled / rescheduled / cancelled / no_access: the ordinal's
// visit date (and the re-spacing), or back to unscheduled.
export async function onVisitEvent(event, h) {
  const p = event.payload || {};
  if (!isId(p.job_id, "job")) return { result: "skipped:no_job" };
  const jg = await getRecord("job", p.job_id);
  if (!jg) return { result: "skipped:no_job" };
  const plan = await planOfJob(jg.data);
  if (!plan) return { result: "skipped:no_plan" };
  const vg = isId(p.visit_id, "visit") ? await getRecord("visit", p.visit_id) : null;
  const live = vg && ["scheduled", "en_route", "in_progress", "paused"].includes(vg.data.status);
  return syncOrdinal(plan, jg.data, h, live ? { visitDate: vg.data.date } : {});
}

// agreement.signed / card.saved: a pending plan that's now ready activates.
export async function onAgreementSigned(event, h) {
  const p = event.payload || {};
  if (!isId(p.plan_id, "plan")) return { result: "skipped:no_plan" };
  const g = await getRecord("plan", p.plan_id);
  if (!g || g.data.status !== "pending") return { result: "skipped:not_pending" };
  const reasons = await readiness(g.data, h.ctx);
  if (reasons.length) {
    if (h.ctx.mayAct({ record: g.data })) await notePending(g.data.id, reasons, h.ctx.write());
    return { result: "skipped:not_ready" };
  }
  const out = await automatedAction(g.data, "activate", {}, h.ctx);
  return { result: out.would ? "would-activate" : "activated" };
}
export async function onCardSaved(event, h) {
  const p = event.payload || {};
  if (!isId(p.contact_id, "contact")) return { result: "skipped" };
  const rows = await listRel("contact-plans", p.contact_id, { limit: 50 });
  let n = 0;
  for (const g of (await getRecords("plan", rows.map((r) => r.id))).filter(Boolean)) {
    if (g.data.status !== "pending" || (await readiness(g.data, h.ctx)).length) continue;
    await automatedAction(g.data, "activate", {}, h.ctx);
    n += 1;
  }
  return { result: `activated:${n}` };
}

// quote.converted: a one-time lights quote ("this season only") became an
// install job: it gets its season (the takedown job and the record).
export async function onQuoteConverted(event, h) {
  const p = event.payload || {};
  const ids = (Array.isArray(p.job_ids) ? p.job_ids : []).filter((x) => isId(x, "job")).slice(0, 10);
  const out = [];
  for (const g of (await getRecords("job", ids)).filter(Boolean)) {
    const job = g.data;
    if (job.kind !== "lights_install" || job.plan_id || job.import || job.deleted_at) continue;
    if (await seasonOfJob(job)) continue;
    out.push((await seasonForInstallJob(job, h)).result);
  }
  return { result: out.join(",") || "skipped:no_lights" };
}

export const listeners = {
  "quote.converted": { handler: onQuoteConverted, mutates: true },
  "job.scheduled": { handler: onJobEvent, mutates: true },
  "job.completed": { handler: onJobEvent, mutates: true },
  "job.reopened": { handler: onJobEvent, mutates: true },
  "job.cancelled": { handler: onJobEvent, mutates: true },
  "visit.scheduled": { handler: onVisitEvent, mutates: true },
  "visit.rescheduled": { handler: onVisitEvent, mutates: true },
  "visit.cancelled": { handler: onVisitEvent, mutates: true },
  "visit.no_access": { handler: onVisitEvent, mutates: true },
  "agreement.signed": { handler: onAgreementSigned, mutates: true },
  "card.saved": { handler: onCardSaved, mutates: true },
};

// ------------------------------------------------------------ sweeps

const liveRows = async () => (await readIndex("plans", "")).rows.filter((r) => LIVE_PLAN.includes(r.st)).sort((a, b) => (a.id < b.id ? -1 : 1));
const lowBudget = (ctx) => ctx.budget && ctx.budget.left() < 15000;

// plans.due (daily 06:00): a pause that reached its end resumes; a cancel
// that reached its date takes effect; a term that ended renews or expires.
export async function plansDue(ctx) {
  const day = today();
  const rows = (await liveRows()).filter((r) => r.id > (ctx.cursor || ""));
  let n = 0;
  let last = ctx.cursor || "";
  for (const r of rows) {
    if (lowBudget(ctx)) return { done: false, cursor: last, progress: n };
    last = r.id;
    const due = (r.st === "paused" && r.pu && day >= r.pu) || (r.st === "cancelling" && r.eff && day >= r.eff) || (r.st === "active" && r.te && day > r.te);
    if (!due) continue;
    const g = await getRecord("plan", r.id);
    if (!g) continue;
    const plan = g.data;
    let action = null;
    if (plan.status === "paused" && plan.pause && plan.pause.until && day >= plan.pause.until) action = "resume";
    else if (plan.status === "cancelling" && plan.cancel && plan.cancel.effective_on && day >= plan.cancel.effective_on) action = "cancel_effective";
    else if (plan.status === "active" && termOver(plan, day)) action = plan.term.auto_renew === false ? "expire" : "renew";
    if (!action) continue;
    try { await automatedAction(plan, action, {}, ctx); n += 1; } catch (e) {
      if (e instanceof BlobsTransientError) throw e;
      console.error(`crm:plans: plans.due ${action} failed (${safeErr(e)})`);
    }
  }
  return { done: true, progress: n };
}

// plans.jobs_backfill (hourly): visits of the current term with no job get
// one, once Scheduling exists (§11.3 feature gates).
export async function jobsBackfill(ctx) {
  if (!has("work.createJobs")) return { done: true, result: "no_scheduling" };
  const rows = (await liveRows()).filter((r) => r.mj > 0 && r.st !== "paused" && r.id > (ctx.cursor || ""));
  let n = 0;
  let last = ctx.cursor || "";
  for (const r of rows) {
    if (lowBudget(ctx)) return { done: false, cursor: last, progress: n };
    last = r.id;
    const g = await getRecord("plan", r.id);
    if (!g) continue;
    const need = ordinalsNeedingJobs(g.data);
    if (!need.length) continue;
    if (!ctx.mayAct({ record: g.data })) { await ctx.would({ record: g.data }, "create", { jobs: need.length }); continue; }
    n += (await ensureJobs(r.id, ctx.write())).length;
  }
  return { done: true, progress: n };
}

// plans.ordinal_sync (hourly): the backstop of the job listener.
export async function ordinalSync(ctx) {
  const rows = (await liveRows()).filter((r) => r.id > (ctx.cursor || ""));
  let n = 0;
  let last = ctx.cursor || "";
  for (const r of rows) {
    if (lowBudget(ctx)) return { done: false, cursor: last, progress: n };
    last = r.id;
    const g = await getRecord("plan", r.id);
    if (!g) continue;
    const plan = g.data;
    const withJobs = (plan.ordinals || []).filter((o) => isId(o.job_id, "job") && o.status !== "skipped");
    if (!withJobs.length) continue;
    const jobs = new Map((await getRecords("job", withJobs.map((o) => o.job_id))).filter(Boolean).map((x) => [x.data.id, x.data]));
    const diff = withJobs.filter((o) => jobs.has(o.job_id) && ordinalStatusForJob(o, jobs.get(o.job_id).status) !== o.status);
    if (!diff.length) continue;
    if (!ctx.mayAct({ record: plan })) { await ctx.would({ record: plan }, "update", { ordinals: diff.length }); continue; }
    const at = (o) => { const j = jobs.get(o.job_id); return j.status === "completed" && j.completed_at ? localDate(new Date(j.completed_at)) : undefined; };
    await updateRecord("plan", plan.id, (p) => {
      let changed = false;
      const ordinals = (p.ordinals || []).map((o) => {
        const j = o.job_id && jobs.get(o.job_id);
        if (!j || o.status === "skipped") return o;
        const st = ordinalStatusForJob(o, j.status);
        if (st === o.status) return o;
        changed = true;
        const x = { ...o, status: st };
        if (st === "completed" && at(o)) x.completed_on = at(o);
        if (st === "unscheduled") delete x.visit_date;
        return x;
      });
      if (!changed) return null;
      const next = { ...p, ordinals };
      next.sale_value_cents = saleValue(next);
      return next;
    }, ctx.write());
    n += diff.length;
  }
  return { done: true, progress: n };
}

// ------------------------------------------------------------ reading

// GET /plans/due?month=: visits due by the month (default this one) that have no visit yet.
export async function plansDueList({ month } = {}) {
  const m = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || "")) ? month : monthOf(today());
  const rows = (await readIndex("plans", "")).rows.filter((r) => ["active", "pending", "cancelling"].includes(r.st) && r.due && r.due <= m).slice(0, 150);
  const plans = (await getRecords("plan", rows.map((r) => r.id))).filter(Boolean).map((g) => g.data);
  const out = [];
  for (const p of plans) {
    for (const o of p.ordinals || []) {
      if (o.status !== "unscheduled" || o.target_month > m) continue;
      out.push({ plan_id: p.id, contact_id: p.contact_id, contact_name: p.contact_name || "", plan_name: p.name, town: p.town || null, term: o.term || 1, n: o.n, target_month: o.target_month, job_id: o.job_id || null, overdue: o.target_month < monthOf(today()) });
    }
  }
  out.sort((a, b) => String(a.town || "~").localeCompare(String(b.town || "~")) || a.target_month.localeCompare(b.target_month) || a.contact_name.localeCompare(b.contact_name));
  return { month: m, visits: out };
}

export async function listPlans({ status, catalog, contact } = {}) {
  if (isId(contact, "contact")) {
    const rel = await listRel("contact-plans", contact, { limit: 100 });
    const recs = (await getRecords("plan", rel.map((r) => r.id))).filter(Boolean).map((g) => g.data).filter((p) => !p.deleted_at && p.contact_id === contact && p.kind !== "one_time_series");
    return recs.map((p) => ({ id: p.id, ...planRowOf(p) }));
  }
  const ix = await readIndex("plans", "");
  const thisMonth = monthOf(today());
  return ix.rows.filter((r) => {
    if (catalog && r.ck !== catalog) return false;
    if (!status || status === "all") return true;
    if (status === "due") return ["active", "cancelling"].includes(r.st) && r.due && r.due <= thisMonth;
    if (status === "clawback") return !!r.cb;
    return r.st === status;
  }).sort((a, b) => String(a.cn).localeCompare(String(b.cn)));
}
export { firstOf };
