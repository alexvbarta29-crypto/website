// Sales module: enrollments, the one-contact-through-one-cadence record
// (design §5.2, B2), and the sales.enroll / sales.stopAll services.
//
// One open enrollment per (contact, cadence): ptr/enroll/{cid}--{cadenceId}
// is claimed with the open-pointer rule (§3.7: a pointer whose enrollment
// has ended is free). The new enrollment's id is derived from the pointer's
// previous holder, so two requests enrolling the same lead at once (the
// website's double submit, the intake and the lead.created listener) make
// one record, and a retried request lands on the same id.
//
// Texts: a step's text goes through core's sender with origin "cadence"
// and the marker key cad-{enrollmentId}-{n}, so a retried call log never
// texts twice, quiet hours (08:00-20:00) and opt-outs apply, and before
// cutover (or while texting is in dry-run) it lands in the Outbox. Then the
// call list shows Copy text / Open in Messages and asks "Did you send it?"
// (sent_by_hand). A text copied by hand carries no opt-out footer: Rotor's
// texting service adds its own on the business number.

import {
  getRecord, getRecords, createRecord, updateRecord, readPointer, claimOpenPointer, addActivity, getSetting,
} from "../../../crm-store.mjs";
import { deriveId, isId } from "../../core/ids.mjs";
import { nowIso, now } from "../../core/clock.mjs";
import { ExistsError, NotFoundError, ConflictError } from "../../core/errors.mjs";
import { has, call } from "../../core/services.mjs";
import { actorKindOf } from "../../core/guard.mjs";
import { sendMessage } from "../../core/send.mjs";
import { getTemplateByKey, renderTemplate, varsFor } from "../../core/templates.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { OPEN_ENROLLMENT } from "./types.mjs";
import {
  firstStep, logStep, noteStep, setStatus, resume, stepFor, resolveStep, refreshStep, isOpen, entryMatches, textsOn, withStep,
} from "./cadence.mjs";
import { cadenceByKey } from "./seed.mjs";
import { ensureDeal, markDeal, touchDeal } from "./deals.mjs";
import { createTask } from "./tasks.mjs";
import { W, mayActOn, would, loadEnv, contactOf, relRecords, nameOf, leadPeople } from "./common.mjs";

export const enrollKey = (contactId, cadenceId) => `${contactId}--${cadenceId}`;

// A cadence by id (one read; no cache, so an owner's edit applies at once).
export async function cadenceById(id) {
  if (!isId(id, "cadence")) return null;
  const got = await getRecord("cadence", id);
  return got && !got.data.deleted_at ? got.data : null;
}

export async function enrollmentsOf(contactId, { limit = 30 } = {}) {
  return relRecords("contact-enrollments", "enrollment", contactId, { limit });
}
export async function openEnrollmentsOf(contactId) {
  return (await enrollmentsOf(contactId)).filter((e) => OPEN_ENROLLMENT.includes(e.status));
}

const isOpenId = async (id) => {
  if (!isId(id, "enrollment")) return false;
  const got = await getRecord("enrollment", id);
  return !!(got && isOpen(got.data));
};

// sales.enroll(contact_id, cadence_key, { quote_id?, deal_id? }, ctx) → enrollment id | null
// null: no such cadence, a board, inactive, the contact is gone or archived,
// or (automatic entry only) the contact's source or tags keep it out.
export async function enroll(contactId, cadenceKey, opts = {}, ctx = {}) {
  const contact = await contactOf(contactId, ctx);
  if (!contact || contact.lifecycle === "archived" || contact.merged_into || contact.merging_into) return null;
  const cadence = await cadenceByKey(cadenceKey, W(ctx));
  if (!cadence || cadence.active === false || cadence.board_only || !(cadence.steps || []).length) return null;
  const automatic = actorKindOf(W(ctx)) === "automation";
  if (automatic && cadence.entry && cadence.entry.on === "lead.created" && !opts.skip_entry_rules && !entryMatches(cadence, contact).ok) return null;

  const pkey = enrollKey(contact.id, cadence.id);
  const held = await readPointer("enroll", pkey);
  if (held && held.id && await isOpenId(held.id)) return held.id;
  const id = deriveId("enrollment", `enroll--${pkey}`, "sales.enroll", held && held.id ? held.id : "first");

  const existing = await getRecord("enrollment", id);
  if (!existing) {
    const env = await loadEnv();
    let deal = null;
    if (isId(opts.deal_id, "deal")) { const g = await getRecord("deal", opts.deal_id); deal = g ? g.data : null; }
    if (!deal) deal = await ensureDeal(contact, { seed: `deal--${id}`, quote_id: opts.quote_id }, ctx);
    const at = nowIso();
    const plan = firstStep(cadence, { started_at: at, ...env, now: at });
    try {
      await createRecord("enrollment", {
        id, contact_id: contact.id, cadence_id: cadence.id, cadence_key: cadence.key, ...(deal ? { deal_id: deal.id } : {}),
        ...(isId(opts.quote_id, "quote") ? { quote_id: opts.quote_id } : {}), ...plan, history: [], started_at: at,
        contact_name: nameOf(contact), ...(isId(contact.owner_id, "user") ? { owner_id: contact.owner_id } : {}),
        // a lead from a sign's or flyer's QR code says so on the call list (Signs & flyers)
        ...(contact.source && contact.source.qr_code && contact.source.campaign ? { source_label: String(contact.source.campaign).slice(0, 120) } : {}),
      }, W(ctx));
      await addActivity(contact.id, "cadence.started", id, now()).catch(() => {});
    } catch (e) {
      if (!(e instanceof ExistsError)) throw e;
    }
  } else if (!isOpen(existing.data)) {
    return null;
  }
  const claim = await claimOpenPointer("enroll", pkey, { id }, isOpenId);
  if (!claim.ok && claim.current && claim.current.id && claim.current.id !== id) {
    // someone else's enrollment is open for this pair: ours is the duplicate
    await updateRecord("enrollment", id, (e) => setStatus(e, "stopped", { reason: "duplicate", now: now() }), W(ctx)).catch(() => {});
    return claim.current.id;
  }
  return id;
}

// ------------------------------------------------------------ changing one

// Applies mutate(enrollment, cadence, env) → enrollment | null. Automation
// on a record the import owns writes a would- row instead.
// → { changed, data?, would?, etag? }
// opts.cadences: a Map (id → cadence) reused across calls of one request.
export async function changeEnrollment(id, mutate, ctx = {}, { action = "change", env: given, cadences } = {}) {
  if (!isId(id, "enrollment")) throw new NotFoundError("That follow-up isn't there.");
  const got = await getRecord("enrollment", id);
  if (!got) throw new NotFoundError("That follow-up isn't there.");
  let cadence = cadences ? cadences.get(got.data.cadence_id) : undefined;
  if (cadence === undefined) { cadence = await cadenceById(got.data.cadence_id); if (cadences) cadences.set(got.data.cadence_id, cadence); }
  const env = given || await loadEnv();
  const preview = mutate(JSON.parse(JSON.stringify(got.data)), cadence, env);
  if (!preview) return { changed: false, data: got.data, etag: got.etag };
  if (!(await mayActOn(ctx, got.data))) {
    await would(ctx, "sales.enrollment", id, action, { status: [got.data.status, preview.status] });
    return { changed: false, would: true, data: got.data };
  }
  const r = await updateRecord("enrollment", id, (e) => mutate(e, cadence, env), W(ctx));
  // a follow-up that ends starts its deal's quiet days (sales.deal_abandon)
  if (r.changed && r.data.deal_id && isOpen(got.data) && !isOpen(r.data)) await touchDeal(r.data.deal_id, ctx);
  return { changed: r.changed, data: r.data, etag: r.etag };
}

// Stops one enrollment (opted out, won, lost, a person's stop...).
export const stopEnrollment = (id, reason, ctx = {}) => changeEnrollment(id, (e, c, env) => setStatus(e, "stopped", { reason, now: env.now }), ctx, { action: "stop" });
export const pauseEnrollment = (id, reason, ctx = {}) => changeEnrollment(id, (e, c, env) => setStatus(e, "paused", { reason, now: env.now }), ctx, { action: "pause" });
export const resumeEnrollment = (id, ctx = {}, opts = {}) => changeEnrollment(id, (e, c, env) => resume(e, c, env), ctx, { action: "resume", ...opts });
export const completeEnrollment = (id, reason, ctx = {}) => changeEnrollment(id, (e, c, env) => setStatus(e, "completed", { reason, now: env.now }), ctx, { action: "complete" });

// sales.stopAll(contact_id, reason, ctx) → how many stopped.
export async function stopAll(contactId, reason = "manual", ctx = {}, { filter } = {}) {
  let n = 0;
  for (const e of await openEnrollmentsOf(contactId)) {
    if (filter && !filter(e)) continue;
    const r = await stopEnrollment(e.id, reason, ctx);
    if (r.changed) n += 1;
  }
  return n;
}

// ------------------------------------------------------------ a step's text

const FOOTER = " Reply STOP to opt out.";
async function footerText() {
  const m = await getSetting("messaging").catch(() => ({}));
  return ((m && m.footer && m.footer.text) || FOOTER).trim();
}
// The text as a person sends it by hand: without the opt-out footer the
// sender added (Rotor's texting service adds its own on the business number).
export async function handText(body, footerAppended) {
  const text = String(body || "");
  if (!footerAppended) return text;
  const f = await footerText();
  return text.endsWith(f) ? text.slice(0, -f.length).replace(/\s+$/, "") : text;
}

// The step's template rendered for the contact, as the compose sheet starts it.
export async function previewStep(enrollment, step, { sender } = {}) {
  const [contact, template, company] = await Promise.all([
    getRecord("contact", enrollment.contact_id).then((g) => (g ? g.data : null)),
    step && step.template_key ? getTemplateByKey(step.template_key) : null,
    getSetting("company").catch(() => null),
  ]);
  if (!template) return { text: "", missing: [], template_key: null };
  const r = renderTemplate(template, varsFor({ contact, company, sender, extra: {} }), { company });
  return { text: r.text, missing: r.missing, template_key: template.key };
}

// Sends step n's text (its template, or the words a person edited) through
// the sender. → { status, mode, outbox_id?, text, blocked_reason?, send_at? }
export async function sendStepText(enrollment, step, { body, user, ctx = {} } = {}) {
  const n = enrollment.step_n;
  const wctx = W(ctx);
  const channel = step.action === "email" ? "email" : "sms";
  const msg = {
    contact_id: enrollment.contact_id, channel, category: "service",
    ...(body ? { body: String(body).slice(0, 1600) } : { template_key: step.template_key }),
    origin: { kind: "cadence", id: enrollment.id, ...(user && isId(user.id, "user") ? { user_id: user.id } : {}) },
    ...(user ? { sender: user } : {}),
    related: { enrollment_id: enrollment.id, ...(enrollment.quote_id ? { quote_id: enrollment.quote_id } : {}) },
    // one text per step (its id: positions move when the cadence is edited)
    marker_key: `cad-${enrollment.id}-${enrollment.step_id || n}${body ? "-c" : ""}`,
  };
  const r = await sendMessage(msg, { by: wctx.by, origin: wctx.origin, actor_kind: wctx.actor_kind, requestId: wctx.requestId, mode: wctx.mode });
  let text = body ? String(body) : "";
  let footer = false;
  if (r.outbox_id) {
    const ob = await getRecord("outbox", r.outbox_id).catch(() => null);
    if (ob && ob.data && typeof ob.data.body === "string") { text = ob.data.body; footer = !!ob.data.footer_appended; }
  }
  if (!text) text = (await previewStep(enrollment, step, { sender: user })).text;
  return { ...r, text: await handText(text, footer) };
}

// What happens after a step's text was handled (sent, or sent by hand):
// the offer on the quote (followup_50, ten_free_screens) and the archive
// step. Quotes arrive in M3a: until then the offer and the archive wait
// (noted in the history) and the archive step still closes the deal as
// lost, no response. Automation on a deal or quote the import owns only
// reports (§3.10).
export async function stepEffects(enrollment, step, ctx = {}) {
  const notes = {};
  if (!step) return notes;
  if (step.offer) {
    if (enrollment.quote_id && has("quotes.applyOffer")) {
      try { await call("quotes.applyOffer", enrollment.quote_id, step.offer, { enrollment_id: enrollment.id }, ctx); notes.offer = step.offer; } catch (e) {
        console.error(`crm:sales: offer not applied (${safeErr(e)})`);
        notes.offer_failed = step.offer;
      }
    } else notes.offer_waits = step.offer;
  }
  if (step.archive_quote) {
    if (enrollment.quote_id && has("quotes.archive")) {
      try { await call("quotes.archive", enrollment.quote_id, { reason: "no_response", enrollment_id: enrollment.id }, ctx); notes.archived = true; } catch (e) {
        console.error(`crm:sales: quote not archived (${safeErr(e)})`);
      }
    } else notes.archive_waits = true;
    if (enrollment.deal_id) await markDeal(enrollment.deal_id, "lost", { reason: "no_response", note: "The estimate follow-up archived the quote." }, ctx).catch((e) => console.error(`crm:sales: deal not closed (${safeErr(e)})`));
  }
  return notes;
}

// A task step: makes the step's task (once) and moves on.
export async function runTaskStep(enrollment, ctx = {}) {
  const cadence = await cadenceById(enrollment.cadence_id);
  const step = stepFor(cadence, enrollment);
  if (!step || step.action !== "task") return { changed: false };
  // automation on a follow-up the import owns only reports (§0 rule 12)
  if (!(await mayActOn(ctx, enrollment))) {
    await would(ctx, "sales.enrollment", enrollment.id, "task_step", { step: [enrollment.step_n, enrollment.step_n + 1] });
    return { changed: false, would: true };
  }
  const contact = await contactOf(enrollment.contact_id, ctx);
  const lastCaller = [...(enrollment.history || [])].reverse().find((h) => isId(h.by, "user"));
  // the lead's owner, else whoever last called, else the owners' first
  const assignee = enrollment.owner_id || (contact && contact.owner_id) || (lastCaller && lastCaller.by) || (contact ? (await leadPeople(contact))[0] : null) || null;
  const task = contact ? await createTask({
    title: `${step.task_title || "Follow up"}: ${nameOf(contact)}`.slice(0, 160), kind: "todo", priority: "medium", status: "open",
    contact_id: contact.id, contact_name: nameOf(contact), enrollment_id: enrollment.id, ...(enrollment.deal_id ? { deal_id: enrollment.deal_id } : {}),
    assignee_ids: assignee ? [assignee] : [], notes: `From the ${enrollment.cadence_key || "follow-up"} cadence, step ${enrollment.step_n}.`,
  }, ctx, { seed: `${enrollment.id}--step${enrollment.step_id || enrollment.step_n}` }) : null;
  return changeEnrollment(enrollment.id, (e, c, env) => logStep(e, c, enrollment.step_n, { action: "task_created", ...(task ? { task_id: task.id } : {}), by: W(ctx).by || "system", touch: false }, env), ctx, { action: "advance" });
}

// Re-plans the current step from now (a missing plan).
export const replan = (id, ctx = {}, opts = {}) => changeEnrollment(id, (e, c, env) => {
  if (!isOpen(e)) return null;
  const at = resolveStep(c, e);
  const next = withStep(e, c, at.index < 0 ? ((c && c.steps) || []).length + 1 : at.index + 1, { ...env, prev: null });
  return JSON.stringify(next) === JSON.stringify(e) ? null : next;
}, ctx, { action: "replan", ...opts });

// Brings an enrollment up to date with its cadence's steps (see refreshStep).
export const refresh = (id, ctx = {}, opts = {}) => changeEnrollment(id, (e, c, env) => refreshStep(e, c, env), ctx, { action: "refresh", ...opts });

export { noteStep, logStep, setStatus };
export const enrollmentView = (e) => { if (!e) return e; const { _w, _etag, ...rest } = e; return rest; };
export const isOpenEnrollment = isOpen;
export function assertOpen(e) { if (!isOpen(e)) throw new ConflictError("This follow-up has ended."); }
