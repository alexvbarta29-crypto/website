// Field ownership and the three-way merge (design §10.7).
//
// A record cannot hold its own etag, and the CRM rewrites imported records
// for good reasons (stats, listeners, card checks), so a re-run compares the
// fields the import owns (the type's `rotorFields`), never etags:
//
//   - every import write stores record.import = { run_id, at, hash, source }
//     (hash = sha256 of the canonical JSON of the mapped rotorFields, source
//     = the Rotor row it came from, "customers:<id>") and puts those mapped
//     values in ib/{type}/{id} (the import base, import-owned);
//   - on a re-run, per mapped row:
//       created    no record: create it (onlyIfNew);
//       unchanged  the record's rotorFields still hash to import.hash and
//                  Rotor sent the same values: nothing is written at all;
//       updated    untouched by anyone (the hash matches) and Rotor changed:
//                  Rotor's values go into those fields only (CAS);
//       edited     the hash differs: three-way, field by field, against the
//                  base: CRM = base → take Rotor's; Rotor = base → keep the
//                  CRM's; CRM = Rotor → nothing; both differ from the base →
//                  a CONFLICT row imp/{runId}/conflicts/{type}--{id}--{field}
//                  (base, CRM, Rotor), the CRM's value stays and the base
//                  keeps its old value for that field (so an unresolved
//                  conflict comes back next run instead of vanishing);
//       linked     a CRM-created record the identity resolution matched (an
//                  intake contact, no `import` yet): fill only its empty
//                  fields, keep its values, no conflicts, then set `import`
//                  and the base ("linked: N fields kept");
//       relinked   a record whose base came from ANOTHER Rotor row (a lead
//                  that Rotor converted to a customer): three-way, but where
//                  both sides changed the CRM's value is kept quietly (the
//                  base is a different Rotor record, so "both changed" is
//                  the conversion itself, not an edit).
//   - Two kinds of fields never conflict: `rotor` (the import's own bag of
//     Rotor ids and raw values: Rotor's new scalars win, `*_ids` lists are
//     unions) and lists of plain values such as tags (merged as sets:
//     Rotor's additions and removals apply, the CRM's additions stay).
//   - Fields outside rotorFields that the mapped record carries are filled
//     only where the record has nothing (a linked intake contact gains its
//     primary property id); the rest of the record is the CRM's.
//
// Writes use the import's context (origin "import": exempt from the
// parallel-run guard), with ctx.bulk (no index rows; the run rebuilds every
// index it touched at the end) and audit: false (one summary event per phase).

import { createHash } from "node:crypto";
import { getRecord, createRecord, updateRecord, getRaw, putRaw, updatePointerList, addRel, K, ExistsError } from "../../../crm-store.mjs";
import { getType } from "../../core/registry.mjs";
import { InputError } from "../../core/errors.mjs";
import { nowIso } from "../../core/clock.mjs";
import { isId, typeOf } from "../../core/ids.mjs";
import { keySafe } from "../../core/text.mjs";

// ------------------------------------------------------------ pure helpers

const plain = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// Canonical JSON: sorted keys, undefined dropped (what the hash is taken over).
export function canon(v) {
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : canon(x)));
  if (plain(v)) {
    const out = {};
    for (const k of Object.keys(v).sort()) if (v[k] !== undefined) out[k] = canon(v[k]);
    return out;
  }
  return v;
}
export const canonJson = (v) => JSON.stringify(canon(v === undefined ? null : v));
export const sameValue = (a, b) => canonJson(empty(a) ? null : a) === canonJson(empty(b) ? null : b);
export const hashFields = (fields) => createHash("sha256").update(canonJson(fields)).digest("hex");

// "Nothing there": undefined, null, "", [] or {}.
export function empty(v) {
  return v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length) || (plain(v) && !Object.keys(v).length);
}

export const getPath = (o, p) => String(p).split(".").reduce((x, k) => (x == null ? undefined : x[k]), o);
export function setPath(o, p, v) {
  const ks = String(p).split(".");
  let x = o;
  for (const k of ks.slice(0, -1)) { if (!plain(x[k])) x[k] = {}; x = x[k]; }
  const last = ks[ks.length - 1];
  if (v === undefined) delete x[last]; else x[last] = clone(v);
}

// The rotorFields of a record as { field: value } (missing ones left out).
export function pickFields(rec, fields) {
  const out = {};
  for (const f of fields) { const v = getPath(rec, f); if (v !== undefined) out[f] = clone(v); }
  return out;
}

const scalarList = (v) => v === undefined || v === null || (Array.isArray(v) && v.every((x) => x === null || ["string", "number", "boolean"].includes(typeof x)));
const lk = (x) => (typeof x === "string" ? x.toLowerCase() : JSON.stringify(x));

// A list of plain values merged as a set: Rotor's removals and additions
// since the base apply, the CRM's own additions stay (order: the CRM's).
export function mergeSet(base, crm, rotor) {
  const b = new Set((base || []).map(lk));
  const n = new Set((rotor || []).map(lk));
  const out = [];
  const seen = new Set();
  for (const x of crm || []) { const k = lk(x); if (seen.has(k) || (b.has(k) && !n.has(k))) continue; seen.add(k); out.push(x); }
  for (const x of rotor || []) { const k = lk(x); if (seen.has(k) || b.has(k)) continue; seen.add(k); out.push(x); }
  return out;
}

// The import's own bag (`rotor`): no conflicts. Lists named *_ids are
// unions (an id the import learned once stays: a converted customer keeps
// its lead id); other values follow Rotor when Rotor changed them since
// the base, else keep what the record holds (a patch's fill).
export function mergeBag(base, crm, rotor) {
  if (!plain(crm) && !plain(rotor)) return rotor === undefined ? clone(crm) : clone(rotor);
  const b = plain(base) ? base : {};
  const c = plain(crm) ? crm : {};
  const n = plain(rotor) ? rotor : {};
  const out = clone(c);
  for (const k of new Set([...Object.keys(b), ...Object.keys(n)])) {
    const bv = b[k], cv = c[k], nv = n[k];
    if (/_ids$/.test(k) && (Array.isArray(cv) || Array.isArray(nv))) {
      const seen = new Set();
      out[k] = [...(Array.isArray(cv) ? cv : []), ...(Array.isArray(nv) ? nv : [])].filter((x) => { const s = lk(x); if (seen.has(s)) return false; seen.add(s); return true; });
    } else if (plain(cv) || plain(nv)) out[k] = mergeBag(bv, cv, nv);
    else if (sameValue(nv, bv)) { /* Rotor didn't change it: keep the record's */ }
    else if (nv === undefined) { if (sameValue(cv, bv)) delete out[k]; }
    else out[k] = clone(nv);
  }
  return out;
}

// One field, three ways. → { value, outcome: "same" | "rotor" | "crm" | "conflict" | "merged" }
export function threeWay(field, base, crm, rotor, { quiet = false } = {}) {
  if (field === "rotor") {
    const value = mergeBag(base, crm, rotor);
    return { value, outcome: sameValue(value, crm) ? "same" : "merged" };
  }
  if (sameValue(crm, rotor)) return { value: crm, outcome: "same" };
  if (sameValue(crm, base)) return { value: rotor, outcome: "rotor" };
  if (sameValue(rotor, base)) return { value: crm, outcome: "crm" };
  if (scalarList(base) && scalarList(crm) && scalarList(rotor) && (Array.isArray(crm) || Array.isArray(rotor))) {
    const value = mergeSet(base, crm, rotor);
    return { value, outcome: sameValue(value, crm) ? "same" : "merged" };
  }
  return { value: crm, outcome: quiet ? "crm" : "conflict" };
}

// A whole record's rotorFields. mode: "untouched" | "edited" | "relinked" |
// "linked". → { next: { field: value }, conflicts: [field], kept: [field], changed: [field], base: { field: value } }
// `base` is what ib/ keeps after this write: Rotor's value, except for a
// field in conflict, whose old base stays.
export function mergeFields(fields, { mode, base = {}, crm = {}, rotor = {} }) {
  const next = {}, conflicts = [], kept = [], changed = [], nextBase = {};
  for (const f of fields) {
    const b = base[f], c = crm[f], n = rotor[f];
    let r;
    if (mode === "untouched") r = { value: n, outcome: sameValue(c, n) ? "same" : "rotor" };
    else if (mode === "linked") {
      if (f === "rotor") r = { value: mergeBag(undefined, c, n), outcome: "merged" };
      else if (empty(c)) r = { value: n, outcome: empty(n) ? "same" : "rotor" };
      else r = { value: c, outcome: sameValue(c, n) ? "same" : "crm" };
    } else r = threeWay(f, b, c, n, { quiet: mode === "relinked" });
    next[f] = r.value;
    if (r.outcome === "conflict") conflicts.push(f);
    if (r.outcome === "crm" && !sameValue(c, n)) kept.push(f);
    if (!sameValue(r.value, c)) changed.push(f);
    const nb = r.outcome === "conflict" ? b : n;
    if (nb !== undefined) nextBase[f] = clone(nb);
  }
  return { next, conflicts, kept, changed, base: nextBase };
}

// ------------------------------------------------------------ writing one mapped record

const ENVELOPE = new Set(["id", "type", "v", "wv", "created_at", "created_by", "updated_at", "updated_by", "deleted_at", "deleted_by", "import", "shadow", "_w", "merged_into", "merging_into"]);
export const ibKey = (type, id) => K.ib(type, id);
export const conflictKey = (runId, type, id, field) => `imp/${runId}/conflicts/${type}--${id}--${keySafe(field, 80)}`;

// The mapped record as the type's validator leaves it (what the store
// would keep), so Rotor's values compare with stored ones like for like.
function normalized(def, data, ctx) {
  return def.validate(clone(data), { op: "create", ctx });
}

async function readBase(type, id) {
  const got = await getRaw(ibKey(type, id));
  return got && got.data ? got.data : null;
}

async function writeBase(type, id, fields, { runId, hash, source }) {
  await putRaw(ibKey(type, id), { type, id, fields, hash, run_id: runId, source: source || null, at: nowIso() });
}

// The side writes a record implies that a bulk write could have lost to a
// crash (lookup lists, relations): re-asserted when a run meets a record it
// wrote itself (idempotent: nothing is written when they are there).
async function reassertSides(def, rec, ctx) {
  const jobs = [];
  for (const p of def.pointers.filter((x) => x.list)) {
    for (const key of (p.keys(rec) || []).filter((k) => typeof k === "string" && k)) jobs.push(updatePointerList(p.kind, key, (ids) => (ids.includes(rec.id) ? ids : [...ids, rec.id]), ctx));
  }
  for (const r of def.rels) {
    const parent = r.parent(rec);
    if (parent) jobs.push(addRel(r.rel, String(parent), String(r.sort(rec)), rec.id, r.value ? r.value(rec) : {}, ctx));
  }
  await Promise.all(jobs);
}

// A follow of merges for contacts (a mapped id that was merged away writes
// to the surviving contact instead). → { id, data } of the live record.
async function survivor(type, got) {
  let cur = got;
  for (let i = 0; i < 5 && cur && type === "contact"; i++) {
    const next = cur.data.merged_into || cur.data.merging_into;
    if (!next || !isId(next, "contact") || next === cur.data.id) break;
    const g = await getRecord("contact", next);
    if (!g) break;
    cur = g;
  }
  return cur;
}

// Writes one mapped record with field ownership. opts: { runId, source,
// ctx (the import's write context) }. → { outcome, type, id, conflicts?,
// kept?, field? } with outcome created | updated | unchanged | linked |
// conflicted | waiting (the type is not registered yet) | invalid.
export async function writeMapped(rec, { runId, source = null, ctx } = {}) {
  const type = rec && rec.type;
  const def = type ? getType(type) : null;
  if (!def) return { outcome: "waiting", type };
  const data = rec.data || {};
  if (!isId(data.id) || typeOf(data.id) !== (def.prefix ? type : def.idType)) return { outcome: "invalid", type, field: "id" };
  const fields = def.rotorFields;
  let norm;
  try { norm = normalized(def, data, ctx); } catch (e) {
    if (e instanceof InputError) return { outcome: "invalid", type, id: data.id, field: e.field || null };
    throw e;
  }
  const mapped = pickFields(norm, fields);
  const hash = hashFields(mapped);
  const at = nowIso();
  const importBlock = { run_id: runId, at, hash, ...(source ? { source } : {}) };

  let got = await getRecord(type, data.id);
  if (!got) {
    try {
      const created = await createRecord(type, { ...data, import: importBlock }, ctx);
      await writeBase(type, data.id, pickFields(created.data, fields), { runId, hash, source });
      return { outcome: "created", type, id: data.id };
    } catch (e) {
      if (!(e instanceof ExistsError) || !e.id) throw e;   // a taken pointer (not the record) is the row's problem
      got = await getRecord(type, data.id);
      if (!got) throw e;
    }
  }

  // which way this record is reconciled
  let mode, base = null, redirected = false;
  const live = await survivor(type, got);
  if (live && live.data.id !== got.data.id) { got = live; redirected = true; }
  const cur = got.data;
  const id = cur.id;
  if (!cur.import) mode = "linked";
  else {
    const ib = await readBase(type, id);
    if (!ib || !plain(ib.fields)) mode = "linked";
    else {
      base = ib.fields;
      // a placeholder (§10.2 row 9) stands for the row that arrives now: its
      // base counts as this row's, so an edited placeholder conflicts (§10.3)
      const placeholder = !!(cur.flags && cur.flags.placeholder === true);
      if (redirected || (!placeholder && source && ib.source && ib.source !== source)) mode = "relinked";
      else if (hashFields(pickFields(cur, fields)) === cur.import.hash) mode = "untouched";
      else mode = "edited";
    }
  }
  if (mode === "untouched" && cur.import.hash === hash) {
    if (cur.import.run_id === runId) await reassertSides(def, cur, ctx);     // a crash between a bulk write and its side writes
    return { outcome: "unchanged", type, id };
  }

  let plan = null;
  const placeholderGone = cur.flags && cur.flags.placeholder === true && !(norm.flags && norm.flags.placeholder);
  const res = await updateRecord(type, id, (r) => {
    plan = mergeFields(fields, { mode, base: base || {}, crm: pickFields(r, fields), rotor: mapped });
    const next = clone(r);
    for (const f of fields) setPath(next, f, plan.next[f]);
    // outside rotorFields: fill only what the record doesn't have
    for (const [k, v] of Object.entries(norm)) if (!ENVELOPE.has(k) && !fields.includes(k) && !fields.some((f) => f.startsWith(k + ".")) && empty(r[k]) && !empty(v)) next[k] = clone(v);
    if (placeholderGone && next.flags) { delete next.flags.placeholder; }
    const sameImport = r.import && r.import.hash === hash && (r.import.source || null) === (source || null);
    if (!plan.changed.length && sameImport && !placeholderGone && canonJson(next) === canonJson(r)) return null;
    next.import = sameImport && !plan.changed.length ? r.import : importBlock;
    return next;
  }, ctx);
  const nextBase = plan ? plan.base : mapped;
  if (!base || canonJson(base) !== canonJson(nextBase) || (cur.import && (cur.import.source || null) !== (source || null))) await writeBase(type, id, nextBase, { runId, hash, source });
  const conflicts = plan ? plan.conflicts : [];
  for (const f of conflicts) {
    await putRaw(conflictKey(runId, type, id, f), {
      run_id: runId, type, id, field: f, base: clone(base ? base[f] : undefined) ?? null, crm: clone(getPath(res.data, f)) ?? null, rotor: clone(mapped[f]) ?? null,
      at: nowIso(), status: "open",
    });
  }
  if (!res.changed && res.data.import && res.data.import.run_id === runId) await reassertSides(def, res.data, ctx);
  const outcome = conflicts.length ? "conflicted" : mode === "linked" ? "linked" : mode === "relinked" ? "relinked" : res.changed ? "updated" : "unchanged";
  return { outcome, type, id, mode, conflicts, kept: plan ? plan.kept : [], changed: plan ? plan.changed : [] };
}

export { ExistsError };
