// Sales module: its automations and sweeps (design §5.7.4 lead.*, §7.6).
//
//   lead.ack        a new website / Meta / referral lead gets Rotor's
//                   "thanks for reaching out" text (lead_ack) when nobody has
//                   called within 5 minutes during business hours, and right
//                   away outside them (D20; quiet hours still apply). A
//                   provisional "calling" (the Call button) or any call or
//                   text since the lead arrived holds it off.
//   lead.alert      a push to the owners (and the lead's owner) for every new lead
//   lead.attention  run by the hourly sales.attention sweep: one push per lead
//                   per day for leads that need a call
//
//   sales.cadence      every fast pass: task steps make their task, text_anyway
//                      steps text at their window's end, steps overdue past
//                      cfg/sales.expire_days end the enrollment (expired),
//                      missing plans are re-planned
//   sales.attention    hourly: the needs-attention list (kept for the badge)
//                      and its pushes
//   sales.deal_abandon daily 02:00: open or quoted deals idle 30 days after their
//                      last step → abandoned (a would- row for deals Rotor owns)

import { getRecord, readIndex, getRaw, settledWrite, claimMarker, advanceMarker, getSetting } from "../../../crm-store.mjs";
import { now, nowIso, localDate, isBusinessOpen } from "../../core/clock.mjs";
import { isId } from "../../core/ids.mjs";
import { notify, approvers } from "../../core/notify.mjs";
import { runAutomation } from "../../core/automations.mjs";
import { getTemplateByKey, renderTemplate, varsFor } from "../../core/templates.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { TEXT_ACTIONS, OPEN_DEAL } from "./types.mjs";
import { logStep, setStatus, stepOf } from "./cadence.mjs";
import { changeEnrollment, runTaskStep, replan, sendStepText, stepEffects, cadenceById } from "./enroll.mjs";
import { markDeal } from "./deals.mjs";
import { attention, ATTENTION_KEY } from "./calls.mjs";
import { loadEnv, contactOf, firstNameOf, townOf, nameOf } from "./common.mjs";

export const ACK_ORIGINS = Object.freeze(["lead-form", "webhook", "referral", "claim"]);
const DAY = 86400000;

// ------------------------------------------------------------ lead.ack

async function ackRun(input, actx) {
  const p = (input.event && input.event.payload) || {};
  if (!ACK_ORIGINS.includes(p.origin)) { await actx.log(p.contact_id, "skipped:origin"); return { result: "skipped:origin" }; }
  const contact = await contactOf(p.contact_id, actx);
  if (!contact) return { result: "skipped:no_contact" };
  const [hours, calendar] = await Promise.all([getSetting("hours").catch(() => undefined), getSetting("calendar").catch(() => undefined)]);
  const t = now();
  const wait = isBusinessOpen(t, hours, calendar) ? Math.max(0, Number(actx.settings.delay) || 0) : 0;
  const due = new Date(t.getTime() + wait * 60000).toISOString();
  const r = await actx.send({
    contact_id: contact.id, contact, key: `${contact.id}--ack`, template_key: "lead_ack", due_at: due,
    fact_at: p.at || nowIso(), record: contact, expect: { lead_at: p.at || nowIso() },
  });
  return { result: r.queued ? "queued" : `skipped:${r.reason || "done"}` };
}

// Re-checked when the text is due: a call started or logged, or any touch
// since the lead arrived, holds it off.
async function ackRecheck(item) {
  const cid = item.data && item.data.contact_id;
  const leadAt = Date.parse((item.expect && item.expect.lead_at) || item.enqueued_at || 0);
  const st = await getRecord("contact_stats", cid).catch(() => null);
  const s = (st && st.data && st.data.sales) || {};
  if (s.calling_until && Date.parse(s.calling_until) > now().getTime()) return { skip: "calling" };
  const touched = Math.max(Date.parse(s.last_called_at || 0) || 0, Date.parse(s.last_touch_at || 0) || 0);
  if (touched && touched >= leadAt - 60000) return { skip: "touched" };
  const c = await getRecord("contact", cid).catch(() => null);
  if (!c || c.data.lifecycle === "archived" || c.data.merged_into) return { skip: "changed" };
  return {};
}

// ------------------------------------------------------------ lead.alert

async function alertRun(input, actx) {
  const p = (input.event && input.event.payload) || {};
  const contact = await contactOf(p.contact_id, actx);
  if (!contact) return { result: "skipped:no_contact" };
  const owners = await approvers().catch(() => []);
  const people = [...new Set([...owners, ...(isId(contact.owner_id, "user") ? [contact.owner_id] : [])])];
  if (!people.length) return { result: "skipped:nobody" };
  const tpl = await getTemplateByKey("staff_new_lead");
  // a first name and a town only: pushes show on lock screens (§5.7.7)
  const body = tpl ? renderTemplate(tpl, varsFor({ contact: { first_name: contact.first_name }, extra: { town: townOf(contact) || null } })).text : `New lead: ${firstNameOf(contact)}.`;
  await notify(people, { kind: "new_lead", title: "New lead", body, link: `/contacts/${contact.id}` }, actx.write());
  await actx.log(contact.id, "notified");
  return { result: "notified" };
}

// ------------------------------------------------------------ lead.attention

async function attentionRun(input, actx) {
  const item = input.item || {};
  const date = input.date || localDate(now());
  if (!isId(item.contact_id, "contact")) return { result: "skipped:no_contact" };
  const claim = await claimMarker("done", "lead.attention", `${item.contact_id}--${date}`, { holder: actx.requestId || "sales.attention", leaseMs: 60000 });
  if (!claim.ok) return { result: "skipped:done" };
  const contact = await contactOf(item.contact_id, actx);
  const people = contact && isId(contact.owner_id, "user") ? [contact.owner_id] : await approvers().catch(() => []);
  const why = (item.reasons || []).includes("overdue") ? "a follow-up step is overdue" : (item.reasons || []).includes("paused") ? "their follow-up has been paused for a while" : "nobody has called or texted in a day";
  if (contact && people.length) {
    await notify(people, { kind: "new_lead", title: "Lead needs a call", body: `${firstNameOf(contact)}${townOf(contact) ? " in " + townOf(contact) : ""}: ${why}.`, link: "/calls" }, actx.write());
  }
  await advanceMarker(claim.marker, { state: "done", result: contact ? "notified" : "no_contact" });
  return { result: contact ? "notified" : "skipped:no_contact" };
}

export const automations = [
  { key: "lead.ack", label: "Thank a new lead by text", trigger: "event:lead.created", category: "service", imported: "no", mutates: false,
    defaults: { enabled: true, channels: ["sms"], template_keys: ["lead_ack"], delay: 5 }, run: ackRun, recheck: ackRecheck },
  { key: "lead.alert", label: "Tell the owners about a new lead", trigger: "event:lead.created", category: "staff", imported: "no", mutates: false,
    defaults: { enabled: true, channels: ["sms"], template_keys: ["staff_new_lead"] }, run: alertRun },
  { key: "lead.attention", label: "Leads that need a call", trigger: "sweep", category: "staff", imported: "yes", mutates: false,
    defaults: { enabled: true, channels: ["sms"], template_keys: [] }, run: attentionRun },
];

// ------------------------------------------------------------ sales.cadence (every pass)

const EXPIRE_FLOOR_DAYS = 3;

export async function cadenceSweep(ctx) {
  const ix = await readIndex("enrollments/active", "");
  const t = now();
  const rows = ix.rows.filter((r) => r.st === "active");
  // cheap checks first: most passes touch nothing and read nothing more
  const candidates = rows.filter((r) => !r.due || (r.act === "task" && Date.parse(r.due) <= t.getTime())
    || (r.de && Date.parse(r.de) <= t.getTime() && (TEXT_ACTIONS.includes(r.act) || t.getTime() - Date.parse(r.de) > EXPIRE_FLOOR_DAYS * DAY)));
  if (!candidates.length) return { progress: 0 };
  const env = await loadEnv(t);
  const cads = new Map((await readIndex("cadences", "")).rows.map((c) => [c.k, c]));
  let progress = 0;
  for (const r of candidates) {
    if (ctx.budget && ctx.budget.left() < 6000) return { progress, done: false };
    try {
      if (!r.due) { const x = await replan(r.id, ctx); if (x.changed) progress += 1; continue; }
      if (r.act === "task") { const x = await runTaskStep({ id: r.id, ...(await getRecord("enrollment", r.id)).data }, ctx); if (x.changed) progress += 1; continue; }
      if (r.de && t.getTime() - Date.parse(r.de) > env.sales.expire_days * DAY) {
        const x = await changeEnrollment(r.id, (e, c, en) => setStatus(e, "stopped", { reason: "expired", now: en.now }), ctx, { env, action: "expire" });
        if (x.changed) progress += 1;
        continue;
      }
      const cad = cads.get(r.cad);
      if (cad && cad.ua === "text_anyway" && TEXT_ACTIONS.includes(r.act) && !r.rbs && !r.pd && r.de && Date.parse(r.de) <= t.getTime()) {
        if (await textAnyway(r, ctx, env)) progress += 1;
      }
    } catch (e) {
      console.error(`crm:sales: a cadence step could not run (${safeErr(e)})`);
    }
  }
  return { progress };
}

// D7 "text_anyway": the window passed with no call logged, so the step's
// text goes out at the window's end (never on review-before-send steps).
async function textAnyway(r, ctx, env) {
  const got = await getRecord("enrollment", r.id);
  if (!got || got.data.status !== "active" || got.data.step_n !== r.n || got.data.pending) return false;
  const e = got.data;
  const cadence = await cadenceById(e.cadence_id);
  const step = stepOf(cadence, e.step_n);
  if (!step || step.review_before_send || !TEXT_ACTIONS.includes(step.action) || !cadence || cadence.unattended !== "text_anyway") return false;
  if (!(await ctx.mayAct({ record: e }))) { await ctx.would(e.id, "text"); return false; }
  const sent = await sendStepText(e, step, { ctx });
  const effects = ["blocked", "skipped"].includes(sent.status) ? {} : await stepEffects(e, step, ctx);
  const x = await changeEnrollment(e.id, (en0, c, en) => logStep(en0, c, e.step_n, {
    action: ["blocked", "skipped"].includes(sent.status) ? "text_blocked" : "text", unattended: true, by: "system",
    ...(sent.outbox_id ? { outbox_id: sent.outbox_id } : {}), ...(sent.blocked_reason ? { reason: sent.blocked_reason } : {}), ...(sent.mode ? { mode: sent.mode } : {}), ...effects,
    cid: `anyway-${e.id}-${e.step_n}`,
  }, en), ctx, { env, action: "text" });
  return x.changed;
}

// ------------------------------------------------------------ sales.attention (hourly)

const MAX_PUSHES = 10;

// The needs-attention count kept for the badge ({ at, count, ids }), written
// only when it changed (CAS).
export async function keepAttention(a) {
  const cur = await getRaw(ATTENTION_KEY).catch(() => null);
  const ids = a.items.map((x) => x.contact_id).sort();
  if (cur && cur.data && cur.data.count === a.count && JSON.stringify(cur.data.ids) === JSON.stringify(ids)) return false;
  await settledWrite(ATTENTION_KEY, { at: nowIso(), count: a.count, ids }, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true }).catch(() => {});
  return true;
}
export async function attentionCount() {
  const got = await getRaw(ATTENTION_KEY).catch(() => null);
  return got && got.data && Number.isFinite(got.data.count) ? got.data.count : 0;
}

export async function attentionSweep(ctx) {
  const a = await attention();
  await keepAttention(a);
  const date = localDate(now());
  let pushed = 0;
  for (const item of a.items) {
    if (pushed >= MAX_PUSHES || (ctx.budget && ctx.budget.left() < 5000)) break;
    const r = await runAutomation("lead.attention", { item, date }, { mode: ctx.mode, requestId: ctx.requestId, deploy: ctx.deploy }).catch((e) => ({ result: `failed:${e.name}` }));
    if (r.result === "notified") pushed += 1;
  }
  return { progress: pushed, result: `${a.count} need attention, ${pushed} pushed` };
}

// ------------------------------------------------------------ sales.deal_abandon (daily 02:00)

export async function abandonSweep(ctx) {
  const t = now();
  const env = await loadEnv(t);
  const limit = env.sales.abandon_days * DAY;
  const [deals, enr] = await Promise.all([readIndex("deals/open", ""), readIndex("enrollments/active", "")]);
  const working = new Set(enr.rows.map((r) => r.c));
  const rows = deals.rows.filter((d) => OPEN_DEAL.includes(d.st) && !working.has(d.c)).sort((a, b) => (a.id < b.id ? -1 : 1));
  let progress = 0;
  for (const d of rows) {
    if (ctx.cursor && d.id <= ctx.cursor) continue;
    if (ctx.budget && ctx.budget.left() < 5000) return { done: false, cursor: d.id, progress };
    const last = Date.parse(d.la || d.op || d.u || 0);
    if (!Number.isFinite(last) || t.getTime() - last < limit) continue;
    // a call or a text to the contact since (logged outside a follow-up) is activity too
    const st = await getRecord("contact_stats", d.c).catch(() => null);
    const s = (st && st.data && st.data.sales) || {};
    const touched = Math.max(...[s.last_called_at, s.last_touch_at, s.last_inbound_call_at].map((x) => Date.parse(x || 0) || 0));
    if (touched && t.getTime() - touched < limit) continue;
    const r = await markDeal(d.id, "abandoned", {}, ctx).catch((e) => { console.error(`crm:sales: deal not abandoned (${safeErr(e)})`); return { changed: false }; });
    if (r.changed || r.would) progress += 1;
  }
  return { progress, result: `${progress} idle deals` };
}

export const sweeps = [
  { key: "sales.cadence", label: "Follow-up steps", lane: "fast", every: "pass", mutates: true, run: cadenceSweep },
  { key: "sales.attention", label: "Leads that need a call", lane: "fast", every: "hourly", mutates: false, run: attentionSweep },
  { key: "sales.deal_abandon", label: "Idle deals", lane: "fast", every: "daily", at_local: "02:00", mutates: true, run: abandonSweep },
];

export { nameOf };
