// Money module: the 1st-of-month run (design §5.6 "The 1st-of-month run",
// §7.6 money.autopay, money.autopay_preview).
//
// Plans billed on the 1st (billing mode first_of_month, and barta_standard
// after the first visit) get ONE plan_cycle invoice per plan per month for
// the visits due that month, charged to the card on file when the plan is
// on autopay. The run is an autopay_run record named by ptr/autopay/{yyyy-mm}
// (its id derives from the month, so it is claimed once):
//   - it lists its items once (one per plan with something due), then
//     works through them, each under its own marker
//     done/autopay/{planId}--{yyyy-mm}, saving each result on the record;
//   - it resumes on every fast-lane pass until every item is final, so a
//     run that died at plan 17 of 33 picks up at 18, and nothing already
//     charged is charged again (the invoice id derives from plan + month,
//     the charge attempt from the invoice);
//   - a run that missed its day (the worker was down) starts on the next
//     pass, marked late, and the owners are told (core/sweeps.mjs).
// BEFORE CUTOVER the run is report-only for every plan Rotor still owns:
// the item says would_charge and NO invoice is made (§3.10): Rotor does the
// real Dec 1 and Jan 1 runs. The preview (the 28th, and the Autopay screen
// any day) lists exactly what a run would bill, plan by plan, so the Jan 1
// preview can be compared line by line with Rotor's Jan 1 charges.

import { getRecord, getRecords, createRecord, updateRecord, readIndex, claimMarker, advanceMarker } from "../../../crm-store.mjs";
import { deriveId, isId } from "../../core/ids.mjs";
import { now, nowIso, localDate } from "../../core/clock.mjs";
import { ExistsError } from "../../core/errors.mjs";
import { sandboxed } from "../../core/context.mjs";
import { notify, approvers } from "../../core/notify.mjs";
import { formatCents } from "../../core/money.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { ordinalTotals } from "../plans/machine.mjs";
import { moneySettings, liveContact, nameOf, mapLimit } from "./common.mjs";
import { cycleInvoiceId, makeInvoice, linesFromJob, linesFromOrdinal } from "./invoices.mjs";
import { cardFor } from "./cards.mjs";
import { mayMoveMoney } from "./gate.mjs";
import { chargeInvoice } from "./charge.mjs";

export const runIdFor = (month) => deriveId("autopay_run", `run:${month}`);
export const CYCLE_MODES = Object.freeze(["first_of_month", "barta_standard"]);
const FINAL = new Set(["succeeded", "failed", "processing", "skipped_no_card", "skipped_paused", "would_charge", "invoice_only", "nothing_due", "unknown"]);
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export const nextMonth = (ym) => { const [y, m] = ym.split("-").map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`; };
export const thisMonth = () => localDate(now()).slice(0, 7);

// The month a plan visit is billed in: the month it is booked for, else its target month.
const billMonth = (o) => (o.visit_date ? String(o.visit_date).slice(0, 7) : o.target_month);

// The visits of a plan the run of `month` bills (pure).
export function dueOrdinals(plan, month) {
  const mode = (plan.billing && plan.billing.mode) || "barta_standard";
  if (!CYCLE_MODES.includes(mode) || plan.kind === "one_time_series") return [];
  return (plan.ordinals || []).filter((o) => billMonth(o) === month && ["unscheduled", "scheduled", "completed"].includes(o.status) && !isId(o.billed_invoice_id, "invoice")
    && !(mode === "barta_standard" && (o.term || 1) === 1 && o.n === 1));
}

const amountOf = (plan, ords) => ords.reduce((s, o) => s + ordinalTotals(plan, o).total_cents, 0);

// What the run of a month would bill, plan by plan (no writes). → { month, items, totals }
export async function previewAutopay(month, { mode } = {}) {
  const rows = (await readIndex("plans", "")).rows.filter((r) => ["active", "cancelling", "paused"].includes(r.st));
  const plans = (await getRecords("plan", rows.map((r) => r.id))).filter(Boolean).map((g) => g.data);
  const crm = !!mode && mode.system_of_record === "crm";
  const due = plans.map((plan) => ({ plan, ords: dueOrdinals(plan, month) })).filter((x) => x.ords.length && amountOf(x.plan, x.ords) > 0);
  const facts = await mapLimit(due, 12, async ({ plan }) => Promise.all([liveContact(plan.contact_id), cardFor(plan.contact_id, plan)]));
  const items = [];
  for (const [i, { plan, ords }] of due.entries()) {
    const amount = amountOf(plan, ords);
    const [contact, card] = facts[i];
    // before the switch only a sandboxed customer's plan is really billed (money/gate.mjs)
    const own = crm || (!!contact && sandboxed(contact, contact));
    items.push({
      plan_id: plan.id, contact_id: plan.contact_id, contact_name: plan.contact_name || nameOf(contact), plan_name: plan.name, amount_cents: amount,
      visits: ords.map((o) => ({ term: o.term || 1, n: o.n, amount_cents: ordinalTotals(plan, o).total_cents })), autopay: !!(plan.billing && plan.billing.autopay), card: card.usable ? "ok" : card.status,
      paused: plan.status === "paused", imported: !!plan.import,
      would: plan.status === "paused" ? "skipped_paused" : !own ? "would_charge" : !(plan.billing && plan.billing.autopay) ? "invoice_only" : card.usable ? "charge" : "skipped_no_card",
    });
  }
  items.sort((a, b) => String(a.contact_name).localeCompare(String(b.contact_name)) || a.plan_id.localeCompare(b.plan_id));
  const sum = (f) => items.filter(f).reduce((s, i) => s + i.amount_cents, 0);
  return {
    month, at: nowIso(), items,
    totals: {
      plans: items.length, amount_cents: sum(() => true), charge_cents: sum((i) => i.would === "charge"), would_charge_cents: sum((i) => i.would === "would_charge"),
      no_card: items.filter((i) => i.would === "skipped_no_card").length, paused: items.filter((i) => i.paused).length, invoice_only: items.filter((i) => i.would === "invoice_only").length,
    },
  };
}

async function ensureRun(month, w) {
  const id = runIdFor(month);
  const had = await getRecord("autopay_run", id);
  if (had) return had.data;
  try {
    return (await createRecord("autopay_run", { id, month, status: "planned", items: [] }, w)).data;
  } catch (e) {
    if (!(e instanceof ExistsError)) throw e;
    return (await getRecord("autopay_run", id)).data;
  }
}

// money.autopay_preview (the 28th, 09:00): next month's preview kept on its
// run record, and the owners told ("Jan 1: 33 plans, $X, 2 without a card").
export async function previewSweep(ctx) {
  const month = nextMonth(thisMonth());
  const p = await previewAutopay(month, { mode: ctx.mode });
  const run = await ensureRun(month, ctx.write());
  await updateRecord("autopay_run", run.id, (r) => (r.status === "planned" ? { ...r, preview: { at: p.at, totals: p.totals, items: p.items.slice(0, 400) } } : null), ctx.write());
  if (p.items.length) {
    const t = p.totals;
    await notify((await approvers().catch(() => [])).slice(0, 10), {
      kind: "payment", title: `Autopay on the 1st: ${t.plans} plan${t.plans === 1 ? "" : "s"}, ${formatCents(t.amount_cents)}`,
      body: `${t.no_card ? `${t.no_card} without a usable card. ` : ""}${t.would_charge_cents ? "Rotor still bills its own plans; the CRM only reports them. " : ""}Take a look before the 1st.`, link: "/autopay",
    }, ctx.write()).catch(() => {});
  }
  return { result: `${p.totals.plans} plans` };
}

// One plan's item (the invoice, then the charge). → the item's final fields
async function runItem(run, item, ctx) {
  const g = await getRecord("plan", item.plan_id);
  if (!g) return { result: "nothing_due" };
  const plan = g.data;
  const contact = await liveContact(plan.contact_id);
  const invId = cycleInvoiceId(plan.id, run.month);
  const have = await getRecord("invoice", invId);
  const ords = dueOrdinals(plan, run.month);
  if (!have && !ords.length) return { result: "nothing_due" };
  if (!have && plan.status === "paused") return { result: "skipped_paused" };
  // Rotor still owns this plan or this customer: report only, no invoice (§3.10)
  if (!ctx.mayAct({ record: plan, contact }) || !(await mayMoveMoney(plan, { sor: ctx.mode && ctx.mode.system_of_record, contact }))) {
    await ctx.would(plan, "charge", { amount_cents: [null, item.amount_cents] });
    return { result: "would_charge" };
  }
  const card = await cardFor(plan.contact_id, plan);
  const wantsAutopay = !!(plan.billing && plan.billing.autopay);
  let inv = have ? have.data : null;
  if (!inv) {
    const lines = [];
    const jobIds = [];
    for (const o of ords) {
      const jg = isId(o.job_id, "job") ? await getRecord("job", o.job_id).catch(() => null) : null;
      if (jg && !jg.data.deleted_at && jg.data.status !== "cancelled") { lines.push(...linesFromJob(jg.data)); jobIds.push(jg.data.id); } else lines.push(...linesFromOrdinal(plan, o));
    }
    const settings = await moneySettings();
    inv = await makeInvoice({
      invoice: {
        id: invId, kind: "plan_cycle", contact_id: plan.contact_id, ...(plan.property_id ? { property_id: plan.property_id } : {}), job_ids: jobIds, plan_id: plan.id, plan_month: run.month,
        plan_ordinals: ords.map((o) => ({ term: o.term || 1, n: o.n })), lines, origin: "autopay",
      },
      issue: settings.auto_issue !== false, links: { job_ids: jobIds, plan_id: plan.id, plan_ordinals: ords.map((o) => ({ term: o.term || 1, n: o.n })) },
      // the run itself charges it (below): the issue event doesn't start a second charge
      autopay: { eligible: wantsAutopay && card.usable, by_run: true, ...(card.payment_method_id ? { payment_method_id: card.payment_method_id } : {}) },
    }, ctx.write());
  }
  const base = { invoice_id: inv.id, amount_cents: inv.total_cents || item.amount_cents };
  if (inv.status === "paid") return { ...base, result: "succeeded" };
  if (inv.status !== "open") return { ...base, result: "invoice_only" };
  if (!wantsAutopay) return { ...base, result: "invoice_only" };
  if (!card.usable) return { ...base, result: "skipped_no_card" };
  const out = await chargeInvoice(inv.id, { origin: "autopay", by: "system:autopay", n: 1 }, ctx.write());
  if (out.status === "running") return { ...base, result: "pending", attempt_id: out.attempt_id };
  if (out.result === "refused" && out.code === "no_card") return { ...base, result: "skipped_no_card" };
  const result = ["succeeded", "failed", "processing"].includes(out.result) ? out.result : out.result === "would_charge" ? "would_charge" : out.result === "refused" && out.code === "paid" ? "succeeded" : "unknown";
  return { ...base, result, attempt_id: out.attempt_id, ...(out.code ? { code: String(out.code).slice(0, 60) } : {}) };
}

// money.autopay (the 1st, 09:00; resumed every pass until done). ctx: the
// sweep context (instance = "yyyy-mm", cursor, budget, mayAct, would, write).
export async function autopayRun(ctx, { month: forced } = {}) {
  const month = forced || (MONTH_RE.test(String(ctx.instance || "")) ? ctx.instance : thisMonth());
  const w = ctx.write();
  let run = await ensureRun(month, w);
  if (run.status === "done") return { result: "done" };
  const left = () => (ctx.budget ? ctx.budget.left() : Infinity);
  // 1. the list, once
  if (run.status === "planned") {
    const p = await previewAutopay(month, { mode: ctx.mode });
    const items = p.items.map((i) => ({ plan_id: i.plan_id, contact_id: i.contact_id, amount_cents: i.amount_cents, result: "pending" }));
    run = (await updateRecord("autopay_run", run.id, (r) => (r.status !== "planned" ? null : { ...r, status: "running", run_at: nowIso(), items, ...(localDate(now()).slice(8) !== "01" ? { late: true } : {}) }), w)).data;
  }
  // 2. the items, each under its own marker
  let did = 0;
  const holder = String(ctx.holder || "autopay").slice(0, 60);
  for (const item of run.items) {
    if (FINAL.has(item.result)) continue;
    if (left() < 15000) return { done: false, progress: did, cursor: { at: item.plan_id } };
    const claim = await claimMarker("done", "autopay", `${item.plan_id}--${month}`, { holder, leaseMs: 120000 });
    if (!claim.ok && !(claim.marker && ["done", "unknown"].includes(claim.marker.state))) continue;             // another pass holds it: next time
    let fields;
    try {
      fields = await runItem(run, item, ctx);
    } catch (e) {
      if (claim.ok) await advanceMarker(claim.marker, { state: "failed", code: "error", retry_at: nowIso() }).catch(() => {});
      throw e;
    }
    if (fields.result === "pending") { if (claim.ok) await advanceMarker(claim.marker, { state: "failed", code: "running", retry_at: nowIso() }).catch(() => {}); continue; }
    run = (await updateRecord("autopay_run", run.id, (r) => ({ ...r, items: r.items.map((x) => (x.plan_id === item.plan_id ? { ...x, ...fields } : x)) }), w)).data;
    if (claim.ok) await advanceMarker(claim.marker, { state: "done", result: fields.result }).catch(() => {});
    did += 1;
  }
  // 3. finished: every item final
  const open = run.items.filter((i) => !FINAL.has(i.result)).length;
  if (open) return { done: false, progress: did };
  run = (await updateRecord("autopay_run", run.id, (r) => (r.status === "done" ? null : { ...r, status: "done", finished_at: nowIso() }), w)).data;
  await tellOwners(run, w).catch((e) => console.error(`crm:money: the autopay summary wasn't sent (${safeErr(e)})`));
  return { progress: did + 1, result: `${run.items.length} plans` };
}

async function tellOwners(run, w) {
  if (!run.items.length) return;
  const t = run.totals || {};
  const noCard = run.items.filter((i) => i.result === "skipped_no_card").length;
  const would = run.items.filter((i) => i.result === "would_charge").length;
  const parts = [`${formatCents(t.succeeded_cents || 0)} charged`, t.failed ? `${t.failed} failed` : null, noCard ? `${noCard} without a card` : null, would ? `${would} still billed by Rotor (reported only)` : null].filter(Boolean);
  await notify((await approvers().catch(() => [])).slice(0, 10), { kind: t.failed ? "payment_failed" : "payment", title: `Autopay ran${run.late ? " (late)" : ""}: ${run.items.length} plan${run.items.length === 1 ? "" : "s"}`, body: parts.join(", ") + ".", link: `/autopay/${run.id}` }, w);
}

export async function listRuns() {
  return (await readIndex("autopay-runs", "")).rows.sort((a, b) => String(b.m).localeCompare(String(a.m))).slice(0, 36);
}
export { MONTH_RE };
