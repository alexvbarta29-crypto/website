// Plans module: the staff API (design §5.4 "Endpoints"). plans:* for plans
// and lights (plans:cancel to cancel), agreements:send for agreements,
// agreement_templates:edit (owners) for the texts. cfg/plans_catalog and
// cfg/lights are owner-only through the core settings routes.
//
//   GET  /plans?status=&catalog=&contact=   · POST /plans (a run)
//   GET  /plans/due?month=                   visits due without a visit (B12)
//   GET  /plans/catalog                      the plan catalog and lights settings (for the office's forms)
//   GET  /plans/:id · PATCH /plans/:id (If-Match: name, property, autopay, auto-renew, clawback billed/waived)
//   POST /plans/:id/activate|pause|resume|skip|cancel|withdraw|renew   runs (one op each)
//   POST /plans/:id/change-price {new_lines, effective_on}
//   GET  /plans/:id/cancel-quote?requested_on=   the policy calculator, before confirming
//   POST /plans/:id/send-agreement {channels}    the plan's agreement, made and sent
//   POST /plans/request-signatures {plan_ids}    a run that ends in a bulk run
//   GET  /agreement-templates · GET/PATCH /agreement-templates/:id · POST /agreement-templates
//   POST /agreement-templates/:id/approve · POST /agreement-templates/preview
//   GET  /agreements?status=&contact=&plan= · GET /agreements/:id · POST /agreements
//   POST /agreements/:id/send · /void · /present
//   GET  /lights/seasons/:season · PATCH /lights/installs/:id · POST /lights/installs/:id/warranty

import { getRecord, getRecords, listRel } from "../../../crm-store.mjs";
import { isId } from "../../core/ids.mjs";
import { now, localDate } from "../../core/clock.mjs";
import { InputError, NotFoundError } from "../../core/errors.mjs";
import { has } from "../../core/services.mjs";
import { adapter } from "../../adapters/index.mjs";
import { loadCatalog, loadLights } from "./catalog.mjs";
import { cancelQuote, ordinalTotals, monthOf } from "./machine.mjs";
import { templateApproved } from "./types.mjs";
import {
  getPlan, listPlans, plansDueList, createStaffPlan, startAction, changePrice, patchPlan, readiness,
} from "./plans.mjs";
import {
  listTemplates, getTemplate, createTemplate, patchTemplate, approveTemplate, listAgreements, getAgreement, agreementView, agreementForPlan, sendAgreement, voidAgreement,
  checkBody, renderBody, agreementVars, companyInfo, strip,
} from "./agreements.mjs";
import { presentLink } from "./portal.mjs";
import { startRequestSignatures } from "./signatures.mjs";
import { seasonBoard, patchSeason, addWarranty, getSeason } from "./lights.mjs";

const R = (method, path, perm, subject, handler, extra = {}) => ({ method, path, auth: "session", perm, subject, mode: "inline", handler, ...extra });
export const features = () => ({ jobs: has("work.createJobs"), money: has("money.cardStatus"), bulk: has("bulk.create") });
async function modeOf(kind) { try { return (await adapter(kind, {})).mode; } catch { return "dry_run"; } }

// ------------------------------------------------------------ plans

async function listRoute(ctx) {
  const q = ctx.query;
  const status = q.get("status") || "";
  const rows = await listPlans({ status: status || undefined, catalog: q.get("catalog") || undefined, contact: q.get("contact") || undefined });
  const all = q.get("contact") ? rows : (await listPlans({}));
  const counts = {};
  const month = monthOf(localDate(now()));
  for (const r of all) {
    counts[r.st] = (counts[r.st] || 0) + 1;
    if (["active", "cancelling"].includes(r.st) && r.due && r.due <= month) counts.due = (counts.due || 0) + 1;
    if (r.cb) counts.clawback = (counts.clawback || 0) + 1;
  }
  return { data: rows, meta: { counts } };
}

async function createRoute(ctx) {
  const out = await createStaffPlan(ctx.body || {}, ctx);
  return { data: out, status: out.run_id ? 202 : 200 };
}

async function catalogRoute() { return { data: { catalog: await loadCatalog(), lights: await loadLights() } }; }

async function dueRoute(ctx) { return { data: await plansDueList({ month: ctx.query.get("month") || undefined }) }; }

async function getRoute(ctx) {
  const g = await getPlan(ctx.params.id);
  const plan = strip(g.data);
  const [contact, agreements, seasons, jobs, cat] = await Promise.all([
    getRecord("contact", plan.contact_id).catch(() => null),
    listAgreements({ plan: plan.id }),
    getRecords("season_install", (plan.season_install_ids || []).slice(-6)),
    getRecords("job", (plan.ordinals || []).map((o) => o.job_id).filter((x) => isId(x, "job")).slice(-40)),
    loadCatalog(),
  ]);
  const c = contact && contact.data;
  const jobsBy = new Map(jobs.filter(Boolean).map((j) => [j.data.id, j.data]));
  const ordinals = (plan.ordinals || []).map((o) => {
    const j = o.job_id ? jobsBy.get(o.job_id) : null;
    return { ...o, total_cents: ordinalTotals(plan, o).total_cents, ...(j ? { job: { id: j.id, number: j.number_label, status: j.status, next_on: (j.schedule && j.schedule.open_on) || null } } : {}) };
  });
  return {
    data: {
      plan: { ...plan, ordinals }, etag: g.etag,
      contact: c ? { id: c.id, name: c.display_name || [c.first_name, c.last_name].filter(Boolean).join(" "), phone: ((c.phones || [])[0] || {}).e164 || null, email: ((c.emails || [])[0] || {}).address || null } : null,
      agreements, seasons: seasons.filter(Boolean).map((s) => strip(s.data)), catalog_entry: cat.plans[plan.catalog_key] || null, perk_names: cat.perk_names,
      readiness: plan.status === "pending" ? await readiness(plan, ctx) : [], features: features(), sms_mode: await modeOf("sms"),
      can: { write: ctx.can("plans:write"), cancel: ctx.can("plans:cancel"), send: ctx.can("agreements:send"), waive: ctx.can("fees:waive") },
    },
    etag: g.etag,
  };
}

async function patchRoute(ctx) {
  const r = await patchPlan(ctx.params.id, ctx.body || {}, ctx);
  return { data: strip(r.data), etag: r.etag };
}

const actionRoute = (action) => async (ctx) => {
  const b = ctx.body || {};
  const args = {};
  if (action === "pause") Object.assign(args, { from: b.from, until: b.until || undefined, reason: b.reason });
  if (action === "skip") Object.assign(args, { term: Number(b.term) || 1, n: Number(b.n) });
  if (action === "cancel") Object.assign(args, { reason: b.reason, requested_on: b.requested_on || undefined, note: b.note });
  if (action === "activate" && b.override_reason) args.override_reason = String(b.override_reason).slice(0, 300);
  if (action === "renew" && b.auto_renew !== undefined) args.auto_renew = b.auto_renew === true;
  if (action === "cancel" && b.reason && !["price", "moving", "service", "not_needed", "other"].includes(b.reason)) throw new InputError("Pick a reason.", "reason");
  if (action === "cancel" && ctx.user && ctx.user.role !== "owner" && !String(b.note || "").trim()) throw new InputError("Add a note on why.", "note");
  return { data: await startAction(ctx.params.id, action, args, ctx), status: 202 };
};

async function priceRoute(ctx) {
  const r = await changePrice(ctx.params.id, ctx.body || {}, ctx);
  return { data: strip(r.data), etag: r.etag };
}

async function cancelQuoteRoute(ctx) {
  const g = await getPlan(ctx.params.id);
  const day = ctx.query.get("requested_on") || localDate(now());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new InputError("Use a date like 2026-11-17.", "requested_on");
  return { data: cancelQuote(g.data, day) };
}

async function sendAgreementRoute(ctx) {
  const a = await agreementForPlan(ctx.params.id, {}, ctx);
  const r = await sendAgreement(a.data.id, { channels: (ctx.body && ctx.body.channels) || ["sms"] }, ctx);
  return { data: { agreement: agreementView(r.data), sms_mode: await modeOf("sms") } };
}

async function requestSignaturesRoute(ctx) {
  return { data: await startRequestSignatures((ctx.body || {}).plan_ids, ctx), status: 202 };
}

// ------------------------------------------------------------ templates

async function templatesRoute() { return { data: await listTemplates() }; }
async function templateRoute(ctx) {
  const g = await getTemplate(ctx.params.id);
  return { data: { ...strip(g.data), approved: templateApproved(g.data) }, etag: g.etag };
}
async function templateCreateRoute(ctx) {
  const r = await createTemplate(ctx.body || {}, ctx);
  return { data: strip(r.data), etag: r.etag, status: 201 };
}
async function templatePatchRoute(ctx) {
  if (!ctx.ifMatch) throw new InputError("This change needs the version you edited (If-Match).", "if-match");
  const r = await patchTemplate(ctx.params.id, ctx.body || {}, ctx);
  return { data: { ...strip(r.data), approved: templateApproved(r.data) }, etag: r.etag };
}
async function templateApproveRoute(ctx) {
  const t = await approveTemplate(ctx.params.id, ctx);
  return { data: { ...strip(t), approved: templateApproved(t) } };
}
// A preview with a made-up Quarterly customer (nothing saved).
async function templatePreviewRoute(ctx) {
  const b = ctx.body || {};
  checkBody(b.body_md);
  const cat = await loadCatalog();
  const key = cat.plans[b.catalog_key] ? b.catalog_key : "quarterly";
  const e = cat.plans[key];
  const sample = {
    name: e.name, frequency: e.frequency, visits_per_year: e.visits_per_year, term: { initial_months: e.initial_months }, perks: e.perks,
    policy: { early_cancel_clawback_cents: e.clawback_cents, notice_days: cat.notice_days, late_cancel_fee_cents: cat.late_cancel_fee_cents },
    lines: [{ id: "ln_s", title: "Exterior Window Cleaning", qty_milli: 1000, unit_cents: 29500, total_cents: 29500, scope: { type: "all" } }],
    discounts: e.discount_per_visit_cents ? [{ id: "dc_s", name: "Plan discount", type: "fixed", value: e.discount_per_visit_cents, scope: { type: "all" } }] : [],
  };
  const text = renderBody({ body_md: b.body_md }, agreementVars(sample, { contact: { first_name: "Pat", last_name: "Example" }, company: await companyInfo(), catalog: cat }));
  return { data: { text } };
}

// ------------------------------------------------------------ agreements

async function agreementsRoute(ctx) {
  const q = ctx.query;
  return { data: await listAgreements({ status: q.get("status") || undefined, contact: q.get("contact") || undefined, plan: q.get("plan") || undefined }) };
}
async function agreementRoute(ctx) {
  const g = await getAgreement(ctx.params.id);
  return { data: agreementView(g.data, { body: true }), etag: g.etag };
}
async function agreementCreateRoute(ctx) {
  const b = ctx.body || {};
  if (!isId(b.plan_id, "plan")) throw new InputError("Which plan?", "plan_id");
  const r = await agreementForPlan(b.plan_id, { template_id: isId(b.template_id, "agreement_template") ? b.template_id : undefined, client_id: typeof b.client_id === "string" && /^[A-Za-z0-9-]{8,64}$/.test(b.client_id) ? b.client_id : undefined }, ctx);
  return { data: agreementView(r.data, { body: true }), status: 201 };
}
async function agreementSendRoute(ctx) {
  const r = await sendAgreement(ctx.params.id, { channels: (ctx.body && ctx.body.channels) || ["sms"] }, ctx);
  return { data: { agreement: agreementView(r.data), sms_mode: await modeOf("sms") } };
}
async function agreementVoidRoute(ctx) {
  const r = await voidAgreement(ctx.params.id, { reason: ctx.body && ctx.body.reason }, ctx);
  return { data: agreementView(r.data) };
}
async function agreementPresentRoute(ctx) { return { data: await presentLink(ctx.params.id, ctx) }; }

// ------------------------------------------------------------ lights

async function seasonRoute(ctx) {
  const board = await seasonBoard(ctx.params.season);
  return { data: { ...board, lights: await loadLights() } };
}
async function seasonPatchRoute(ctx) {
  await getSeason(ctx.params.id);
  const r = await patchSeason(ctx.params.id, ctx.body || {}, ctx);
  return { data: strip(r.data), etag: r.etag };
}
async function warrantyRoute(ctx) {
  const out = await addWarranty(ctx.params.id, ctx.body || {}, ctx);
  return { data: { season: strip(out.season), job_id: out.job_id }, status: 201 };
}

export const planRoutes = [
  R("GET", "/plans", "plans:read", "none", listRoute),
  R("POST", "/plans", "plans:write", "none", createRoute, { mode: "run", maxCalls: 40 }),
  R("GET", "/plans/due", "plans:read", "none", dueRoute, { maxCalls: 160 }),
  R("GET", "/plans/catalog", "plans:read", "none", catalogRoute),
  R("POST", "/plans/request-signatures", "agreements:send", "none", requestSignaturesRoute, { mode: "run" }),
  R("GET", "/plans/:id", "plans:read", "required", getRoute, { maxCalls: 60 }),
  R("PATCH", "/plans/:id", "plans:write", "required", patchRoute),
  R("POST", "/plans/:id/activate", "plans:write", "required", actionRoute("activate"), { mode: "run", maxCalls: 30 }),
  R("POST", "/plans/:id/pause", "plans:write", "required", actionRoute("pause"), { mode: "run" }),
  R("POST", "/plans/:id/resume", "plans:write", "required", actionRoute("resume"), { mode: "run" }),
  R("POST", "/plans/:id/skip", "plans:write", "required", actionRoute("skip"), { mode: "run" }),
  R("POST", "/plans/:id/renew", "plans:write", "required", actionRoute("renew"), { mode: "run" }),
  R("POST", "/plans/:id/cancel", "plans:cancel", "required", actionRoute("cancel"), { mode: "run" }),
  R("POST", "/plans/:id/withdraw", "plans:cancel", "required", actionRoute("withdraw"), { mode: "run" }),
  R("POST", "/plans/:id/change-price", "plans:write", "required", priceRoute),
  R("GET", "/plans/:id/cancel-quote", "plans:read", "required", cancelQuoteRoute),
  R("POST", "/plans/:id/send-agreement", "agreements:send", "required", sendAgreementRoute, { maxCalls: 50 }),
  R("GET", "/agreement-templates", "plans:read", "none", templatesRoute),
  R("POST", "/agreement-templates", "agreement_templates:edit", "none", templateCreateRoute),
  R("POST", "/agreement-templates/preview", "plans:read", "none", templatePreviewRoute),
  R("GET", "/agreement-templates/:id", "plans:read", "required", templateRoute),
  R("PATCH", "/agreement-templates/:id", "agreement_templates:edit", "required", templatePatchRoute),
  R("POST", "/agreement-templates/:id/approve", "agreement_templates:edit", "required", templateApproveRoute),
  R("GET", "/agreements", "plans:read", "none", agreementsRoute, { maxCalls: 60 }),
  R("POST", "/agreements", "agreements:send", "none", agreementCreateRoute, { maxCalls: 40 }),
  R("GET", "/agreements/:id", "plans:read", "required", agreementRoute),
  R("POST", "/agreements/:id/send", "agreements:send", "required", agreementSendRoute, { maxCalls: 40 }),
  R("POST", "/agreements/:id/void", "agreements:send", "required", agreementVoidRoute, { maxCalls: 40 }),
  R("POST", "/agreements/:id/present", "agreements:send", "required", agreementPresentRoute, { secret: true, idempotent: false }),
  R("GET", "/lights/seasons/:season", "plans:read", "required", seasonRoute),
  R("PATCH", "/lights/installs/:id", "plans:write", "required", seasonPatchRoute, { maxCalls: 50 }),
  R("POST", "/lights/installs/:id/warranty", "plans:write", "required", warrantyRoute, { maxCalls: 80 }),
];

export { listRel, NotFoundError };
