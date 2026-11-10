// Barta CRM core: the contact timeline and the automation run log (design
// §3.6 "Activity timeline", §3.10 "The parallel-run guard", §5.7.4).
//
// - Contact timeline: rel/contact-activity/{cid}/{tsKey}--{kind}--{refId},
//   written by crm-store addActivity() when a module creates something the
//   customer should see. timeline() lists the newest rows and labels them
//   with the modules' activityKinds. Dry-run sends add no activity.
// - Automation run log: alog/{yyyy-mm-dd}/{tsKey}--{key}--{subjectId}--{result},
//   write-once, one row per automation, sweep, listener or queue step that
//   acted, skipped or was held back. While Rotor is the system of record a
//   mutating step on a record the CRM may not touch writes a
//   `would-<action>` row (with the field changes it would have made)
//   instead of acting (§0 rule 12); the Automations screen lists them beside
//   the dry-run outbox.
// - automationCtx(): the write context every sweep, listener and queue
//   handler gets: actor_kind "automation" (so crm-store's backstop guards
//   it), the parallel-run guard's mayAct(), and would().

import { putRaw, listKeys, listActivity, getRaw } from "../../crm-store.mjs";
import { tsKey, localDate, fromTsKey, now } from "./clock.mjs";
import { keySafe } from "./text.mjs";
import { guardFor } from "./context.mjs";
import { allModules } from "./registry.mjs";

export const ALOG = "alog/";

const subjectIdOf = (subject) => {
  if (!subject) return "none";
  if (typeof subject === "string") return subject;
  const r = subject.record !== undefined ? subject.record : subject;
  return (r && (r.id || r.contact_id)) || "none";
};

// One write-once row of the automation run log. `result`: "sent",
// "dry_run", "skipped:<reason>", "would-<action>", "failed:<code>", ...
// details: small and free of personal data (ids, field names, counts).
export async function logAutomation({ key, subject, result, details } = {}, opts = {}) {
  const at = now();
  const k = `${ALOG}${localDate(at)}/${tsKey(at)}--${keySafe(key || "step", 60)}--${keySafe(subjectIdOf(subject), 40)}--${keySafe(result || "done", 40)}`;
  await writeOnceRaw(k, { at: at.toISOString(), key: key || null, subject: subjectIdOf(subject), result: result || "done", ...(details ? { details } : {}) }, opts);
  return k;
}

// A write-once key (onlyIfNew): an unclear answer is asked again; "already
// there" is success.
export async function writeOnceRaw(key, value, opts = {}) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await putRaw(key, value, { onlyIfNew: true }, opts);
      if (!r.ambiguous) return;
    } catch (e) {
      if (i === 2) throw e;
    }
  }
}

// The report-only row of the parallel-run guard: what the step would have
// done (`changes`: field names → [before, after], scalars only).
export function wouldAct({ key, subject, action, changes } = {}, opts = {}) {
  return logAutomation({ key, subject, result: `would-${keySafe(action || "change", 30)}`, details: changes ? { changes } : undefined }, opts);
}

const ROW_RE = /^alog\/(\d{4}-\d{2}-\d{2})\/(\d{8}t\d{9}z)--(.+?)--([a-z]{2}_[0-9a-z]{20}|none|[a-z0-9._@-]+?)--([a-z0-9._@-]+)$/;
// The run log of one local day, newest first: [{ at, key, subject, result, ref }].
export async function listAutomationLog(date, { key, limit = 500 } = {}, opts = {}) {
  const keys = await listKeys(`${ALOG}${date}/`, {}, opts);
  const out = [];
  for (const k of keys) {
    const m = ROW_RE.exec(k);
    if (!m) continue;
    if (key && m[3] !== keySafe(key, 60)) continue;
    const d = fromTsKey(m[2]);
    // keys hold "skipped-<reason>" (":" is outside the key alphabet); rows read as written
    out.push({ at: d ? d.toISOString() : null, key: m[3], subject: m[4], result: m[5].replace(/^(skipped|failed)-/, "$1:"), ref: k });
  }
  return out.sort((a, b) => (a.ref < b.ref ? 1 : -1)).slice(0, limit);
}

export async function getAutomationLogRow(ref, opts = {}) {
  if (typeof ref !== "string" || !ref.startsWith(ALOG)) return null;
  const got = await getRaw(ref, opts);
  return got ? got.data : null;
}

// The write context of automation (sweeps, listeners, queue handlers,
// automations, seeds): crm-store guards it (§3.10), mayAct() asks the guard
// first, would() writes the report-only row.
export function automationCtx({ mode, key, by, requestId, op } = {}) {
  const guard = guardFor(mode);
  const base = { by: by || `system:${keySafe(key || "worker", 40)}`, origin: "worker", actor_kind: "automation", mode, requestId: requestId || "worker", ...(op ? { op } : {}) };
  return {
    ...base,
    guard,
    mayAct: (subject) => guard.mayAct(subject),
    would: (subject, action, changes) => wouldAct({ key, subject, action, changes }, { requestId: base.requestId }),
    log: (subject, result, details) => logAutomation({ key, subject, result, details }, { requestId: base.requestId }),
    write: (extra = {}) => ({ ...base, ...extra }),
  };
}

// A contact's timeline, newest first: [{ at, kind, refId, label, icon }].
// The screen loads the referenced records it shows (bounded, §3.6).
export async function timeline(contactId, { limit = 50, before } = {}, opts = {}) {
  const kinds = {};
  for (const m of allModules()) Object.assign(kinds, m.activityKinds || {});
  const rows = await listActivity(contactId, { limit: Math.min(200, Math.max(1, limit)), before }, opts);
  return rows.map((r) => ({ ...r, label: (kinds[r.kind] && kinds[r.kind].label) || r.kind, icon: (kinds[r.kind] && kinds[r.kind].icon) || null }));
}

