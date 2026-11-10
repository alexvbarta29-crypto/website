// Contacts module: merging two contacts (design §5.1 "Merge", §3.6, §11.3
// onMerge). A merge is a run in the bulk lane around a resumable op,
// op/merge--{a}--{b}--{n} (survivor a), so a double tap is one merge and a
// crash half way is finished by ops.resume as the person who asked:
//
//   start       b.merging_into = a; b's Rotor pointers move to a. From here
//               every writer that resolves a contact (intake, inbound texts,
//               payment webhooks, imports) follows merging_into: nothing new
//               lands on b
//   union       a gains b's phones, emails and tags, b's notes under a dated
//               heading, the earlier source, consent "revoked wins, else the
//               latest grant", and whatever a was missing
//   onMerge:*   one step per module that declares onMerge (this module first:
//               properties and other merge candidates), each called once
//   stragglers  every relation family of b is listed again; anything that
//               arrived meanwhile moves to a; the op ends only when b has none
//   stats       b's stats fold into a's (two Stripe customers: both kept and
//               an approval for the owners, "Two Stripe customers after merge")
//   finish      b.merged_into = a, archived as a duplicate, its portal links
//               revoked, the candidate marked merged, contact.merged emitted
//
// No automatic undo: the journal and the events are the record.

import {
  getRecord, getRecords, updateRecord, listRel, addRel, removeRel, getRaw, settledWrite, readIndex, readPointer,
  appendEvent, addActivity, updateStats,
} from "../../../crm-store.mjs";
import { allModules, allTypes, statsPart } from "../../core/registry.mjs";
import { defineOp, runOp, opIdFor, readOp } from "../../core/ops.mjs";
import { defineRun, createRun, runView } from "../../core/lanes.mjs";
import { definePendingKind, createPendingAction } from "../../core/pending.mjs";
import { revokeLinks } from "../../portal/core.mjs";
import { emit } from "../../core/events.mjs";
import { isId } from "../../core/ids.mjs";
import { now, nowIso } from "../../core/clock.mjs";
import { ConflictError, InputError, NotFoundError, BlobsTransientError } from "../../core/errors.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { dateLabel, normName } from "./display.mjs";
import { pairKey, MAX_TAGS } from "./types.mjs";
import { propertiesOf } from "./properties.mjs";

export const MERGE_OP = "contacts.merge";
export const STRAGGLER_ROUNDS = 3;
export const STRIPE_PENDING = "contacts.two_stripe_customers";

definePendingKind(STRIPE_PENDING, { label: "Two Stripe customers after a merge" });

const LIFE_RANK = { customer: 3, former_customer: 2, lead: 1, archived: 0 };
const str = (v) => (v == null ? "" : String(v)).trim();
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const time = (s) => { const t = Date.parse(s || ""); return Number.isNaN(t) ? 0 : t; };

// ------------------------------------------------------------ the pure part

// Consent of one channel after a merge: any "revoked" wins; else the latest grant.
export function mergeConsentState(x = {}, y = {}) {
  const sx = x.state || "unknown", sy = y.state || "unknown";
  if (sx === "revoked" || sy === "revoked") {
    if (sx === "revoked" && sy === "revoked") return time(x.at) >= time(y.at) ? clone(x) : clone(y);
    return clone(sx === "revoked" ? x : y);
  }
  if (sx === "granted" && sy === "granted") return time(x.at) >= time(y.at) ? clone(x) : clone(y);
  if (sx === "granted") return clone(x);
  if (sy === "granted") return clone(y);
  return { state: "unknown" };
}

// What the survivor a looks like with b folded in (pure).
export function mergedFields(a, b, at = now()) {
  const out = clone(a);
  for (const k of ["first_name", "last_name", "company_name"]) if (!str(out[k]) && str(b[k])) out[k] = b[k];
  const phones = [...(out.phones || [])];
  for (const p of b.phones || []) if (!phones.some((x) => x.e164 === p.e164)) phones.push({ ...p, primary: false });
  out.phones = phones;
  const emails = [...(out.emails || [])];
  for (const e of b.emails || []) if (!emails.some((x) => x.address === e.address)) emails.push({ ...e, primary: false });
  out.emails = emails;
  const tags = [...(out.tags || [])];
  for (const t of b.tags || []) if (!tags.some((x) => x.toLowerCase() === String(t).toLowerCase()) && tags.length < MAX_TAGS) tags.push(t);
  out.tags = tags;
  if (str(b.notes) && !String(out.notes || "").includes(String(b.notes).trim())) {
    const block = `— Merged from ${b.display_name || "a duplicate"}, ${dateLabel(at)} —\n${String(b.notes).trim()}`;
    out.notes = (str(out.notes) ? String(out.notes).replace(/\s+$/, "") + "\n\n" + block : block).slice(0, 10000);
  }
  // the earlier source (who found them first)
  if (b.source && (!out.source || time(b.created_at) < time(a.created_at))) out.source = clone(b.source);
  out.consent = { ...(out.consent || {}) };
  for (const ch of ["sms_service", "sms_marketing", "email_marketing"]) out.consent[ch] = mergeConsentState((a.consent || {})[ch], (b.consent || {})[ch]);
  if (!out.billing_address && b.billing_address) out.billing_address = clone(b.billing_address);
  if (!out.owner_id && b.owner_id) out.owner_id = b.owner_id;
  if (!out.primary_property_id && b.primary_property_id) out.primary_property_id = b.primary_property_id;
  out.watcher_ids = [...new Set([...(out.watcher_ids || []), ...(b.watcher_ids || [])])].slice(0, 20);
  const flags = { ...(out.flags || {}) };
  for (const [k, v] of Object.entries(b.flags || {})) if (v === true && k !== "placeholder") flags[k] = true;
  if (flags.placeholder && !(b.flags || {}).placeholder) delete flags.placeholder;
  out.flags = flags;
  if (b.automations_paused) out.automations_paused = { ...clone(b.automations_paused), ...(out.automations_paused || {}) };
  if ((LIFE_RANK[b.lifecycle] || 0) > (LIFE_RANK[out.lifecycle] || 0)) out.lifecycle = b.lifecycle;
  const ra = out.rotor || {}, rb = b.rotor || {};
  if (Object.keys(rb).length) {
    out.rotor = {
      ...rb, ...ra,
      lead_ids: [...new Set([...(ra.lead_ids || []), ...(rb.lead_ids || [])])],
      ...(ra.customer_id || rb.customer_id ? { customer_id: ra.customer_id || rb.customer_id } : {}),
    };
  }
  if (out.rotor && (out.rotor.customer_id || (out.rotor.lead_ids || []).length)) delete out.intake_pending_rotor;
  else if (!out.intake_pending_rotor && b.intake_pending_rotor) out.intake_pending_rotor = clone(b.intake_pending_rotor);
  return out;
}

// The relation families whose parent is a contact id (found by asking each
// declared relation what parent a record of that contact would have), plus
// the activity timeline.
export function contactFamilies() {
  const probe = "ct_00000000000000000000";
  const out = [];
  for (const t of allTypes()) {
    for (const r of t.rels || []) {
      let p = null;
      try { p = r.parent({ id: "zz_00000000000000000000", type: t.type, contact_id: probe }); } catch { p = null; }
      if (p === probe) out.push({ type: t.type, rel: r.rel });
    }
  }
  out.push({ type: null, rel: "contact-activity" });
  return out;
}

// ------------------------------------------------------------ steps

async function repoint(kind, key, from, to) {
  const k = `ptr/${kind}/${key}`;
  const cur = await getRaw(k);
  if (!cur || !cur.data || cur.data.id !== from) return false;
  const { _w, ...v } = cur.data;
  const w = await settledWrite(k, { ...v, id: to, moved_from: from, at: nowIso() }, { onlyIfMatch: cur.etag });
  return w.ok;
}

// Moves what still hangs off b to a. → how many moved.
async function moveStragglers(a, b, ctx) {
  let moved = 0;
  for (const fam of contactFamilies()) {
    const rows = await listRel(fam.rel, b, { limit: 200 });
    for (const r of rows) {
      if (fam.type) {
        await updateRecord(fam.type, r.id, (rec) => (rec.contact_id === b ? { ...rec, contact_id: a } : null), ctx).catch(async (e) => {
          if (e instanceof NotFoundError) { await removeRel(fam.rel, b, r.sortKey, r.id); return; }
          throw e;
        });
      } else {
        await addRel(fam.rel, a, r.sortKey, r.id);
        await removeRel(fam.rel, b, r.sortKey, r.id);
      }
      moved += 1;
    }
  }
  return moved;
}

async function remaining(b) {
  let n = 0;
  for (const fam of contactFamilies()) n += (await listRel(fam.rel, b, { limit: 5 })).length;
  return n;
}

// The contacts module's own onMerge: b's properties and its other merge candidates.
export async function onMergeContacts(a, b, ctx) {
  for (const p of await propertiesOf(b, ctx)) {
    await updateRecord("property", p.id, (rec) => (rec.contact_id === b ? { ...rec, contact_id: a } : null), ctx);
  }
  const ix = await readIndex("merge-candidates", "");
  for (const row of ix.rows) {
    if (row.st !== "pending") continue;
    if (!(row.a === b || row.b === b) || pairKey(row.a, row.b) === pairKey(a, b)) continue;
    await updateRecord("merge_candidate", row.id, (m) => (m.status !== "pending" ? null : { ...m, status: "dismissed", decided_by: ctx.by || "system", decided_at: nowIso(), note: "One of the two was merged into another contact." }), ctx);
  }
}

// Folds b's stats into a's: first texts and last contact (comms), customer
// since (contacts), Stripe customers (money, when that part exists).
async function foldStats(a, b, ctx) {
  const got = await getRecord("contact_stats", b);
  const sb = got ? got.data : null;
  if (!sb) return { stripe_pair: false };
  if (sb.comms && statsPart("comms")) {
    await updateStats(a, "comms", (p) => {
      const first = { ...(p.first_sms || {}) };
      for (const [num, t] of Object.entries(sb.comms.first_sms || {})) if (!first[num] || time(t) < time(first[num])) first[num] = t;
      const max = (x, y) => (time(y) > time(x) ? y : x);
      return { ...p, first_sms: first, last_contacted_at: max(p.last_contacted_at, sb.comms.last_contacted_at) || null, last_inbound_at: max(p.last_inbound_at, sb.comms.last_inbound_at) || null };
    }, ctx);
  }
  if (sb.contacts && sb.contacts.customer_since && statsPart("contacts")) {
    await updateStats(a, "contacts", (p) => (!p.customer_since || time(sb.contacts.customer_since) < time(p.customer_since) ? { ...p, customer_since: sb.contacts.customer_since } : null), ctx);
  }
  let pair = false;
  const bIds = (sb.money && sb.money.stripe && sb.money.stripe.customer_ids) || [];
  if (bIds.length && statsPart("money")) {
    await updateStats(a, "money", (p) => {
      const stripe = { ...((p && p.stripe) || {}) };
      const had = stripe.customer_ids || [];
      pair = had.length > 0 && bIds.some((x) => !had.includes(x));
      stripe.customer_ids = [...new Set([...had, ...bIds])];
      return { ...p, stripe };
    }, ctx);
  }
  return { stripe_pair: pair };
}

defineOp(MERGE_OP, {
  lane: "bulk",
  steps(input) {
    const { a, b } = input;
    const steps = [
      {
        name: "start",
        async run(s) {
          const [ra, rb] = await getRecords("contact", [a, b]);
          if (!ra || !rb) throw new NotFoundError("One of those contacts isn't there anymore.");
          if (rb.data.merged_into === a) return { already: true };
          if (rb.data.merged_into || (rb.data.merging_into && rb.data.merging_into !== a)) throw new ConflictError("That contact was already merged into another one.");
          if (ra.data.merged_into || ra.data.merging_into) throw new ConflictError("The contact you keep was merged away. Start from the one that's left.");
          await updateRecord("contact", b, (c) => (c.merging_into === a ? null : { ...c, merging_into: a }), s.ctx);
          const rot = rb.data.rotor || {};
          for (const rid of rot.lead_ids || []) await repoint("rotor/lead", rid, b, a);
          if (rot.customer_id) await repoint("rotor/customer", rot.customer_id, b, a);
          return { started: true };
        },
      },
      {
        name: "union",
        async run(s) {
          const gb = await getRecord("contact", b);
          if (!gb) throw new NotFoundError("That contact isn't there anymore.");
          if (gb.data.merged_into === a) return { already: true };
          await updateRecord("contact", a, (ca) => mergedFields(ca, gb.data), s.ctx);
          return { ok: true };
        },
      },
    ];
    for (const m of allModules()) {
      if (typeof m.onMerge !== "function") continue;
      steps.push({ name: `onMerge:${m.name}`, run: async (s) => { await m.onMerge(a, b, s.ctx); return { ok: true }; } });
    }
    steps.push({
      name: "stragglers",
      async run(s) {
        let moved = 0;
        for (let i = 0; i < STRAGGLER_ROUNDS; i++) {
          moved += await moveStragglers(a, b, s.ctx);
          if (!(await remaining(b))) return { moved };
        }
        throw new BlobsTransientError("Records kept arriving on the merged contact; trying again.");
      },
    });
    steps.push({
      name: "stats",
      async run(s) {
        const r = await foldStats(a, b, s.ctx);
        if (r.stripe_pair) {
          await createPendingAction({ kind: STRIPE_PENDING, title: "Two Stripe customers after merge", requested_by: s.ctx.by || "system", preview: { recipients: [a] }, expires_hours: 24 * 14 }, s.ctx);
        }
        return r;
      },
    });
    steps.push({
      name: "finish",
      async run(s) {
        const r = await updateRecord("contact", b, (c) => {
          if (c.merged_into === a) return null;
          const next = { ...c, merged_into: a, lifecycle: "archived", archived_reason: "duplicate" };
          delete next.merging_into;
          return next;
        }, s.ctx);
        await revokeLinks(b, { by: s.ctx.by || "system" }).catch((e) => console.error(`crm:merge: portal links not revoked (${safeErr(e)})`));
        const p = await readPointer("merge-pair", pairKey(a, b));
        if (p && isId(p.id, "merge_candidate")) {
          await updateRecord("merge_candidate", p.id, (m) => (m.status === "merged" ? null : { ...m, status: "merged", decided_by: s.ctx.by || "system", decided_at: nowIso() }), s.ctx).catch(() => null);
        }
        await Promise.all([
          appendEvent("contact", a, { by: s.ctx.by, origin: s.ctx.origin, action: "merge", merged_id: b, op: s.opId }),
          addActivity(a, "contact.merged", b, now()),
        ]).catch(() => {});
        await emit("contact.merged", { id: b, wv: r.data.wv, survivor_id: a, merged_id: b }, s.ctx).catch((e) => console.error(`crm:merge: contact.merged not queued (${safeErr(e)})`));
        return { survivor_id: a, merged_id: b };
      },
    });
    return steps;
  },
});

// ------------------------------------------------------------ runs

// The person who asked: a merge is a human action (exempt from the parallel-run guard).
const personCtx = (run, rctx) => ({ by: run.requested_by || "system", origin: "api", actor_kind: isId(run.requested_by, "user") ? "user" : "automation", requestId: rctx.holder || "merge", ...(rctx.mode ? { mode: rctx.mode } : {}) });

async function mergeStep(run, rctx) {
  const { a, b, n } = run.input || {};
  const opId = opIdFor(`merge--${a}--${b}`, n);
  const out = await runOp(opId, MERGE_OP, { input: { a, b }, ctx: personCtx(run, rctx), holder: `merge.${run.id}` });
  if (out.status === "done") return { done: true, result: out.result || { survivor_id: a, merged_id: b }, progress: { done: 1, total: 1 } };
  if (out.status === "failed") return { failed: (out.error && out.error.code) || "failed" };
  return { progress: { done: 0, total: 1 } };
}
defineRun("contacts.merge", { lane: "bulk", step: mergeStep, label: "Merge two contacts" });

// Starts a merge (survivor a, merged b). → the run.
export async function startMerge(a, b, ctx) {
  if (!isId(a, "contact") || !isId(b, "contact") || a === b) throw new InputError("Pick two different contacts.", "other_id");
  const [ra, rb] = await getRecords("contact", [a, b]);
  if (!ra || !rb || ra.data.deleted_at || rb.data.deleted_at) throw new NotFoundError("One of those contacts isn't there anymore.");
  if (ra.data.merged_into || ra.data.merging_into) throw new ConflictError("The contact you keep was merged away. Start from the one that's left.");
  if (rb.data.merged_into) throw new ConflictError("That contact was already merged.");
  const opId = opIdFor(`merge--${a}--${b}`, rb.data.wv || 1);
  const j = await readOp(opId);
  return createRun("contacts.merge", { a, b, n: rb.data.wv || 1, op: opId, ...(j ? { joined: true } : {}) }, ctx);
}

// ------------------------------------------------------------ bulk decisions

export const BULK_ACTIONS = Object.freeze({ dismiss_low: "DISMISS", merge_high_same_first_name: "MERGE" });

// Which of two contacts survives a bulk merge: the customer, else the older one.
export function survivorOf(x, y) {
  const rx = LIFE_RANK[x.lifecycle] || 0, ry = LIFE_RANK[y.lifecycle] || 0;
  if (rx !== ry) return rx > ry ? [x, y] : [y, x];
  return time(x.created_at) <= time(y.created_at) ? [x, y] : [y, x];
}

async function bulkStep(run, rctx) {
  const { action } = run.input || {};
  const cp = run.checkpoint || { done: [], merged: 0, dismissed: 0 };
  const doneSet = new Set(cp.done);
  const ix = await readIndex("merge-candidates", "");
  const rows = ix.rows.filter((r) => r.st === "pending" && !doneSet.has(r.id) && (action === "dismiss_low" ? r.cf === "low" : r.cf === "high"));
  const ctx = personCtx(run, rctx);
  for (const row of rows) {
    if (rctx.budget && rctx.budget.left() < 20000) return { checkpoint: { ...cp, done: [...doneSet] }, progress: { done: doneSet.size, total: doneSet.size + rows.length } };
    doneSet.add(row.id);
    if (action === "dismiss_low") {
      await updateRecord("merge_candidate", row.id, (m) => (m.status !== "pending" ? null : { ...m, status: "dismissed", decided_by: ctx.by, decided_at: nowIso(), note: "Dismissed with every low-confidence pair." }), ctx);
      cp.dismissed += 1;
      continue;
    }
    const [x, y] = await getRecords("contact", [row.a, row.b]);
    if (!x || !y || x.data.merged_into || y.data.merged_into) continue;
    if (!normName(x.data.first_name) || normName(x.data.first_name) !== normName(y.data.first_name)) continue;
    const [keep, drop] = survivorOf(x.data, y.data);
    const out = await runOp(opIdFor(`merge--${keep.id}--${drop.id}`, drop.wv || 1), MERGE_OP, { input: { a: keep.id, b: drop.id }, ctx, holder: `merge-bulk.${run.id}` });
    if (out.status === "done") cp.merged += 1;
  }
  return { done: true, checkpoint: { ...cp, done: [...doneSet] }, result: { merged: cp.merged, dismissed: cp.dismissed }, progress: { done: doneSet.size, total: doneSet.size } };
}
defineRun("contacts.merge_bulk", { lane: "bulk", step: bulkStep, label: "Work the merge queue" });

export async function startBulk(action, confirm, ctx) {
  if (!Object.hasOwn(BULK_ACTIONS, action)) throw new InputError("Pick what to do.", "action");
  if (confirm !== BULK_ACTIONS[action]) throw new InputError(`Type ${BULK_ACTIONS[action]} to confirm.`, "confirm");
  return createRun("contacts.merge_bulk", { action }, ctx);
}

export { runView };
