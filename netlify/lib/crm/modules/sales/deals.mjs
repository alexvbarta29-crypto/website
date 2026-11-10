// Sales module: deals (design §5.2). A deal is one sales attempt: open →
// quoted → won | lost | abandoned. Its status is derived from events (the
// first quote sent, a quote approved or converted, a job booked without a
// quote, a quote declined or archived, 30 idle days) and a person may set
// it by hand (logged by the store's event history). A returning customer
// asking again gets a new deal; a lead who asks twice while a deal is open
// keeps that one.
//
// markDeal() is the sales.markDeal service. Automation (listeners, sweeps)
// changes a deal the import brought in only after cutover: before that it
// writes a would-mark_<status> row instead (§0 rule 12).

import { getRecord, createRecord, updateRecord } from "../../../crm-store.mjs";
import { deriveId, isId } from "../../core/ids.mjs";
import { nowIso } from "../../core/clock.mjs";
import { InputError, NotFoundError, ExistsError } from "../../core/errors.mjs";
import { OPEN_DEAL, DEAL_STATUSES, LOST_REASONS } from "./types.mjs";
import { W, mayActOn, would, relRecords, nameOf } from "./common.mjs";

// The newest open or quoted deal of a contact, or null.
export async function openDealOf(contactId) {
  const deals = await relRecords("contact-deals", "deal", contactId, { limit: 10 });
  return deals.find((d) => OPEN_DEAL.includes(d.status)) || null;
}

// The contact's open deal, or a new one (id derived from `seed`, so two
// requests racing for the same lead make one deal). → the deal record.
export async function ensureDeal(contact, { seed, services, source, quote_id } = {}, ctx = {}) {
  const open = await openDealOf(contact.id);
  if (open) return open;
  const id = deriveId("deal", seed || `deal--${contact.id}`, "sales.deal", 1);
  try {
    const rec = await createRecord("deal", {
      id, contact_id: contact.id, services: services || [], source: source || (contact.source ? { source: contact.source.source } : undefined),
      status: "open", quote_ids: quote_id ? [quote_id] : [], job_ids: [], plan_ids: [], history: [], opened_at: nowIso(), last_activity_at: nowIso(),
      contact_name: nameOf(contact), ...(isId(contact.owner_id, "user") ? { owner_id: contact.owner_id } : {}),
    }, W(ctx));
    return rec.data;
  } catch (e) {
    if (!(e instanceof ExistsError)) throw e;
    const got = await getRecord("deal", id);
    return got ? got.data : null;
  }
}

const pushId = (list, id) => (id && !(list || []).includes(id) ? [...(list || []), id] : list || []);

// The next version of a deal for an event (pure). → deal | null (no change).
// status: quoted | won | lost | abandoned | open (open: a person reopening).
export function dealFor(d, status, { reason, note, quote_id, job_id, plan_id, force = false, at = nowIso() } = {}) {
  if (!DEAL_STATUSES.includes(status)) throw new InputError("Pick open, quoted, won, lost or abandoned.", "status");
  const next = { ...d, quote_ids: pushId(d.quote_ids, quote_id), job_ids: pushId(d.job_ids, job_id), plan_ids: pushId(d.plan_ids, plan_id), last_activity_at: at };
  const from = d.status;
  if (status === "quoted") {
    if (from === "open") { next.status = "quoted"; next.quoted_at = d.quoted_at || at; }
    else if (!force) return JSON.stringify(next) === JSON.stringify(d) ? null : next;
  } else if (status === "won") {
    if (from === "won") return JSON.stringify(next) === JSON.stringify(d) ? null : next;
    next.status = "won"; next.won_at = at;
    delete next.lost_reason; delete next.lost_note; delete next.lost_at; delete next.abandoned_at;
  } else if (status === "lost") {
    if (from === "won" && !force) return null;
    if (from === "lost" && !force) return null;
    next.status = "lost"; next.lost_at = at;
    next.lost_reason = LOST_REASONS.includes(reason) ? reason : "other";
    if (note) next.lost_note = String(note).slice(0, 500); else delete next.lost_note;
  } else if (status === "abandoned") {
    if (!OPEN_DEAL.includes(from) && !force) return null;
    next.status = "abandoned"; next.abandoned_at = at;
  } else if (status === "open") {
    if (from === "open") return null;
    if (!force) return null;
    next.status = d.quote_ids && d.quote_ids.length ? "quoted" : "open";
    delete next.won_at; delete next.lost_at; delete next.lost_reason; delete next.lost_note; delete next.abandoned_at;
  }
  if (force) next.status_set_by_hand = true;
  return JSON.stringify(next) === JSON.stringify(d) ? null : next;
}

// sales.markDeal(deal_id, status, { reason?, note?, quote_id?, job_id?, plan_id?, force? }, ctx)
// → { changed, deal?, would? }
export async function markDeal(dealId, status, opts = {}, ctx = {}) {
  if (!isId(dealId, "deal")) throw new NotFoundError("That deal isn't there.");
  const got = await getRecord("deal", dealId);
  if (!got) throw new NotFoundError("That deal isn't there.");
  const preview = dealFor(got.data, status, opts);
  if (!preview) return { changed: false, deal: got.data };
  if (!(await mayActOn(ctx, got.data))) {
    await would(ctx, "sales.markDeal", dealId, `mark_${status}`, { status: [got.data.status, preview.status] });
    return { changed: false, would: true, deal: got.data };
  }
  const r = await updateRecord("deal", dealId, (d) => dealFor(d, status, { ...opts, at: nowIso() }), W(ctx));
  return { changed: r.changed, deal: r.data, etag: r.etag };
}

// Touch a deal's last activity (a follow-up ended). Automation on a deal
// the import brought in only reports it (§0 rule 12): Rotor's deal stays as
// the import wrote it, and sales.deal_abandon reads the contact's own
// call and text times besides.
export async function touchDeal(dealId, ctx = {}) {
  if (!isId(dealId, "deal")) return { changed: false };
  const got = await getRecord("deal", dealId).catch(() => null);
  if (!got) return { changed: false };
  if (!(await mayActOn(ctx, got.data))) {
    await would(ctx, "sales.deal", dealId, "touch", { last_activity_at: [got.data.last_activity_at || null, nowIso()] });
    return { changed: false, would: true };
  }
  const r = await updateRecord("deal", dealId, (d) => ({ ...d, last_activity_at: nowIso() }), W(ctx)).catch(() => null);
  return { changed: !!(r && r.changed) };
}
