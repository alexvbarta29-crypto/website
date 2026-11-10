// Field ownership and the three-way merge (design §10.7), per Rotor source.
//
// A record cannot hold its own etag, and the CRM rewrites imported records
// for good reasons (stats, listeners, card checks), so a re-run compares the
// fields the import owns (the type's `rotorFields`), never etags.
//
// One record may be written by several Rotor rows ("sources", like
// "customers:<id>", "leads:<id>", "opportunities:<id>"): a lead that Rotor
// converted to a customer, two Rotor customers the owner merged into one
// contact, a deal that both the lead and its opportunities describe. So the
// import base is kept PER SOURCE:
//
//   ib/{type}/{id} = { v: 2, primary, sources: { [source]: { fields, hash, rank, run_id, at, pending? } } }
//   record.import  = { run_id, at, source: primary, hash, src: { [source]: hash } }
//
// `fields` are that source's mapped rotorFields as it last wrote them,
// `hash` names that version; record.import.src[source] repeats it.
// record.import.hash is the hash of the record's rotorFields as the import
// left them (after a restore, which skips ib/, it tells whether anyone
// edited the record since).
//
// Crash safety (write-ahead): before a record write that moves S's base, the
// new base goes into ib/ as sources[S].pending; then the record (whose
// import.src[S] names the new hash); then the base proper. A crash after the
// record write leaves a pending base the record names: the next run takes
// it as the base. A pending base the record doesn't name never happened.
// A base the record names but ib/ lacks altogether is rebuilt from the
// record when nobody edited it since, else its differing fields conflict.
//
// Per mapped row (source S, rank r, Rotor's values N, the record's C, S's base B):
//   created    no record: create it (onlyIfNew), B = N;
//   unchanged  S sent exactly what B holds (and the record agrees): nothing
//              is written at all, whatever other sources or people did;
//   per field  (only the fields S maps, now or before):
//     - N = B             S didn't change it: the record keeps its value;
//     - C = N             nothing to do;
//     - C empty           filled;
//     - C = B             nobody touched it since S wrote it: S's new value;
//     - lists of plain values (tags): merged as sets (S's own additions and
//       removals since B apply; nobody else's are undone); never a conflict;
//     - C = another source T's base value: that source holds the field; S
//       takes it over only when it ranks higher (a customer row over the
//       lead it was converted from), else the record keeps T's value quietly
//       (a merged-away duplicate never overwrites the contact the owner kept);
//     - otherwise C is a person's (or the CRM's own) value: when S has a base
//       and changed the field since, a CONFLICT row
//       imp/{runId}/conflicts/{type}--{id}--{field} (S's base, the CRM's, S's
//       new value); the CRM's value stays and B keeps its old value for the
//       field, so an unresolved conflict comes back next run. A source that
//       never wrote this record (an intake contact the identity matched, a
//       merged duplicate, a new facet) keeps it quietly: "linked".
//   - `rotor` (the import's own bag of Rotor ids and raw values) never
//     conflicts: lists named *_ids are unions; S's changed values apply where
//     the bag still holds S's old value or nothing, or by rank over another
//     source's; a key S no longer sends is removed only if it still holds
//     S's own value (another source's keys are never removed).
//   - A placeholder (flags.placeholder, §10.2 row 9) stands for the row that
//     arrives now: the real row takes over the placeholder's base and its
//     flag is cleared (an edited placeholder conflicts like any record); a
//     placeholder row never overrides anything (rank 0).
//   - No base at all (backups skip ib/, so after a restore): the primary
//     source trusts the record when its rotorFields still hash to
//     import.hash (nobody edited it), else every field that differs from
//     Rotor's becomes a conflict; another source is "new".
//   - Fields outside rotorFields that the mapped record carries are filled
//     only where the record has nothing; the rest of the record is the CRM's.
//
// Ranks: SOURCE_RANK by entity (customers and opportunities 3, leads 2,
// anything else 1, a placeholder row 0); a phase may say `rank` itself.
//
// Writes use the import's context (origin "import": exempt from the
// parallel-run guard), with ctx.bulk (no index rows; the run rebuilds the
// indexes of the types it wrote) and audit: false (one summary event per phase).

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

export const SOURCE_RANK = Object.freeze({ customers: 3, opportunities: 3, leads: 2 });
export const rankOf = (source) => SOURCE_RANK[String(source || "").split(":")[0]] ?? 1;

const scalarList = (v) => v === undefined || v === null || (Array.isArray(v) && v.every((x) => x === null || ["string", "number", "boolean"].includes(typeof x)));
const lk = (x) => (typeof x === "string" ? x.toLowerCase() : JSON.stringify(x));

// A list of plain values merged as a set: the source's removals and
// additions since its base apply, everyone else's additions stay (order: the record's).
export function mergeSet(base, crm, rotor) {
  const b = new Set((base || []).map(lk));
  const n = new Set((rotor || []).map(lk));
  const out = [];
  const seen = new Set();
  for (const x of crm || []) { const k = lk(x); if (seen.has(k) || (b.has(k) && !n.has(k))) continue; seen.add(k); out.push(x); }
  for (const x of rotor || []) { const k = lk(x); if (seen.has(k) || b.has(k)) continue; seen.add(k); out.push(x); }
  return out;
}
export function union(a, b) {
  const seen = new Set();
  return [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])].filter((x) => { const k = lk(x); if (seen.has(k)) return false; seen.add(k); return true; });
}

const holderOf = (others, pick, c) => others.find((o) => { const v = pick(o.base); return !empty(v) && sameValue(c, v); }) || null;

// The import's own bag (`rotor`). mode: "own" (S has a base) | "new" | "unknown";
// others: [{ rank, base: that source's bag }]. Never a conflict.
export function mergeBag(base, crm, rotor, { mode = "own", rank = 1, others = [] } = {}) {
  if (!plain(crm) && !plain(rotor)) {
    if (mode === "own" && sameValue(rotor, base)) return clone(crm);
    return rotor === undefined ? clone(crm) : empty(crm) || mode !== "new" ? clone(rotor) : clone(crm);
  }
  const b = plain(base) ? base : {};
  const c = plain(crm) ? crm : {};
  const n = plain(rotor) ? rotor : {};
  const out = clone(c);
  const keys = new Set([...Object.keys(n), ...(mode === "own" ? Object.keys(b) : [])]);
  for (const k of keys) {
    const bv = b[k], cv = c[k], nv = n[k];
    if (/_ids$/.test(k) && (Array.isArray(cv) || Array.isArray(nv))) { out[k] = union(cv, nv); continue; }
    if (plain(cv) || plain(nv)) { out[k] = mergeBag(bv, cv, nv, { mode, rank, others: others.map((o) => ({ rank: o.rank, base: plain(o.base) ? o.base[k] : undefined })) }); continue; }
    if (mode === "own" && sameValue(nv, bv)) continue;                 // S didn't change it
    if (nv === undefined) { if (mode === "own" && sameValue(cv, bv)) delete out[k]; continue; }
    if (cv === undefined || sameValue(cv, nv) || (mode === "own" && sameValue(cv, bv))) { out[k] = clone(nv); continue; }
    const holder = holderOf(others, (ob) => (plain(ob) ? ob[k] : undefined), cv);
    if (holder) { if (rank > holder.rank) out[k] = clone(nv); continue; }
    if (mode !== "new") out[k] = clone(nv);                            // nobody edits the bag by hand
  }
  return out;
}

// A whole record's rotorFields from one source.
// opts: { mode: "own" | "new" | "unknown", base (S's fields), crm, rotor (N), others: [{ src, rank, base }], rank }
// → { next, conflicts, kept, changed, base } where `base` is what S's base
// becomes: N, except a field in conflict, whose old base stays.
export function mergeFields(fields, { mode = "own", base = {}, crm = {}, rotor = {}, others = [], rank = 1 } = {}) {
  const next = {}, conflicts = [], kept = [], changed = [], nextBase = {};
  const B = base || {};
  for (const f of fields) {
    const b = B[f], c = crm[f], n = rotor[f];
    let r;
    if (f === "rotor") r = { value: mergeBag(b, c, n, { mode, rank, others: others.map((o) => ({ rank: o.rank, base: o.base ? o.base.rotor : undefined })) }), outcome: "merged" };
    else if (n === undefined && !(mode === "own" && b !== undefined)) r = { value: c, outcome: "silent" };   // S doesn't speak about it
    else if (mode === "own" && sameValue(n, b)) r = { value: c, outcome: "unchanged" };
    else if (sameValue(c, n)) r = { value: c, outcome: "same" };
    else if (empty(c)) r = { value: n, outcome: "rotor" };
    else if (mode === "own" && sameValue(c, b)) r = { value: n, outcome: "rotor" };
    else if (scalarList(b) && scalarList(c) && scalarList(n) && (Array.isArray(c) || Array.isArray(n))) r = { value: mode === "own" ? mergeSet(b, c, n) : union(c, n), outcome: "merged" };
    else {
      const holder = holderOf(others, (ob) => (ob ? ob[f] : undefined), c);
      if (holder) r = rank > holder.rank ? { value: n, outcome: "rotor" } : { value: c, outcome: "crm" };
      else if (mode === "new") r = { value: c, outcome: "crm" };
      else r = { value: c, outcome: "conflict" };
    }
    next[f] = r.value;
    if (r.outcome === "conflict") conflicts.push(f);
    if (r.outcome === "crm") kept.push(f);
    if (!sameValue(r.value, c)) changed.push(f);
    const nb = r.outcome === "conflict" ? (mode === "unknown" ? undefined : b) : r.outcome === "silent" ? b : n;
    if (nb !== undefined) nextBase[f] = clone(nb);
  }
  return { next, conflicts, kept, changed, base: nextBase };
}

// ------------------------------------------------------------ the import base

const ENVELOPE = new Set(["id", "type", "v", "wv", "created_at", "created_by", "updated_at", "updated_by", "deleted_at", "deleted_by", "import", "shadow", "_w", "merged_into", "merging_into"]);
export const ibKey = (type, id) => K.ib(type, id);
export const conflictKey = (runId, type, id, field) => `imp/${runId}/conflicts/${type}--${id}--${keySafe(field, 80)}`;

// ib/{type}/{id} as { primary, sources } (an older one-base value reads as one source).
export async function readBase(type, id) {
  const got = await getRaw(ibKey(type, id));
  const v = got && got.data;
  if (!v) return null;
  if (plain(v.sources)) return { primary: v.primary || Object.keys(v.sources)[0] || null, sources: v.sources };
  if (plain(v.fields)) { const s = v.source || "row"; return { primary: s, sources: { [s]: { fields: v.fields, hash: v.hash || null, rank: rankOf(s), run_id: v.run_id || null, at: v.at || null } } }; }
  return null;
}
async function writeBase(type, id, { primary, sources }) {
  await putRaw(ibKey(type, id), { v: 2, type, id, primary, sources, at: nowIso() });
}

// The mapped record as the type's validator leaves it (what the store
// would keep), so Rotor's values compare with stored ones like for like.
function normalized(def, data, ctx) {
  return def.validate(clone(data), { op: "create", ctx });
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
// to the surviving contact instead). → { data, etag } of the live record.
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

// The import block's hash after a write, made right when the type's
// validator changed a rotorField on the way in (rare).
async function settleHash(type, fields, data, ctx) {
  const h = hashFields(pickFields(data, fields));
  if (!data.import || data.import.hash === h) return;
  await updateRecord(type, data.id, (r) => (r.import && r.import.hash !== hashFields(pickFields(r, fields)) ? { ...r, import: { ...r.import, hash: hashFields(pickFields(r, fields)) } } : null), ctx);
}

// Writes one mapped record with field ownership. opts: { runId, source
// ("customers:<id>"), ctx (the import's write context), rank }.
// → { outcome, type, id, mode?, conflicts?, kept?, changed?, field? } with outcome
// created | updated | unchanged | linked | conflicted | waiting (the type
// is not registered yet) | invalid.
export async function writeMapped(rec, { runId, source = null, ctx, rank } = {}) {
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
  const src = source || "row";
  const placeholderRow = !!(norm.flags && norm.flags.placeholder === true);
  const myRank = placeholderRow ? 0 : Number.isInteger(rank) ? rank : rankOf(src);
  const mapped = pickFields(norm, fields);
  const hashN = hashFields(mapped);
  const at = nowIso();

  let got = await getRecord(type, data.id);
  if (!got) {
    try {
      const created = await createRecord(type, { ...data, import: { run_id: runId, at, source: src, hash: hashN, src: { [src]: hashN } } }, ctx);
      await writeBase(type, data.id, { primary: src, sources: { [src]: { fields: mapped, hash: hashN, rank: myRank, run_id: runId, at } } });
      await settleHash(type, fields, created.data, ctx);
      return { outcome: "created", type, id: data.id };
    } catch (e) {
      if (!(e instanceof ExistsError) || !e.id) throw e;   // a taken pointer (not the record) is the row's problem
      got = await getRecord(type, data.id);
      if (!got) throw e;
    }
  }
  const live = await survivor(type, got);
  if (live) got = live;
  const cur = got.data;
  const id = cur.id;
  const ib = await readBase(type, id);
  const tags = (cur.import && cur.import.src) || {};
  // settle what a crash between the record write and the base write left: a
  // pending base the record's tag names becomes the base; a pending one it
  // doesn't name never happened
  let baseDirty = false;
  const sources = {};
  for (const [k, e] of Object.entries(ib ? ib.sources : {})) {
    if (!plain(e)) continue;
    const { pending, ...kept } = e;
    if (pending && tags[k] !== undefined && tags[k] === pending.hash && tags[k] !== e.hash) { sources[k] = { ...kept, fields: pending.fields, hash: pending.hash, run_id: pending.run_id || kept.run_id || null, at: pending.at || kept.at || null }; baseDirty = true; }
    else if (plain(e.fields)) { sources[k] = kept; if (pending) baseDirty = true; }
    else baseDirty = true;
  }
  let primary = (ib && ib.primary) || (cur.import && cur.import.source) || null;
  const untouchedSinceImport = !!(cur.import && cur.import.hash && hashFields(pickFields(cur, fields)) === cur.import.hash);
  // the record's own values as a base, for the fields this source speaks about
  const recordAsBase = (extra = []) => pickFields(cur, fields.filter((f) => mapped[f] !== undefined || extra.includes(f)));

  // a placeholder stands for the row that arrives now: the real row takes over its base
  let takeover = null;
  if (!placeholderRow && cur.flags && cur.flags.placeholder === true && !sources[src]) {
    const ph = Object.keys(sources).find((k) => k !== src);
    if (ph) { sources[src] = { ...sources[ph], rank: myRank }; delete sources[ph]; takeover = ph; primary = src; }
    else if (cur.import && untouchedSinceImport) { sources[src] = { fields: recordAsBase(), hash: null, rank: myRank }; takeover = cur.import.source || "placeholder"; primary = src; }
  }

  let Bs = sources[src] || null;
  let mode = null;
  let repaired = false;
  if (Bs) {
    const tag = tags[src];
    if (!takeover && tag !== undefined && Bs.hash && tag !== Bs.hash) {
      // the record names a base this one isn't (an older ib/ write, or one lost without its pending copy)
      if (tag === hashN) { Bs = { ...Bs, fields: mapped, hash: hashN }; repaired = true; }
      else if (untouchedSinceImport) { Bs = { ...Bs, fields: recordAsBase(Object.keys(Bs.fields || {})), hash: null }; repaired = true; }
      else mode = "unknown";
    }
    if (!mode && !takeover && Bs.hash === hashN && (tag === undefined || tag === hashN)) {
      if (repaired || baseDirty) { sources[src] = { ...Bs, run_id: runId, at }; await writeBase(type, id, { primary: primary || src, sources }); }
      if (cur.import && cur.import.run_id === runId) await reassertSides(def, cur, ctx);     // a crash between a bulk write and its side writes
      return { outcome: "unchanged", type, id };
    }
    mode = mode || "own";
  } else if (cur.import && !Object.keys(sources).length) {
    // no import base at all (backups skip ib/, so every record after a restore)
    if (!cur.import.source || cur.import.source === src) {
      if (untouchedSinceImport) { Bs = { fields: recordAsBase(), hash: null, rank: myRank }; mode = "own"; } else mode = "unknown";
    } else {
      mode = "new";
      if (untouchedSinceImport) sources[cur.import.source] = { fields: recordAsBase(), hash: null, rank: rankOf(cur.import.source) };
    }
  } else mode = "new";
  const others = Object.entries(sources).filter(([k]) => k !== src).map(([k, v]) => ({ src: k, rank: Number.isInteger(v.rank) ? v.rank : rankOf(k), base: v.fields || {} }));
  const primaryRank = primary && primary !== src ? (others.find((o) => o.src === primary) || { rank: rankOf(primary) }).rank : -1;
  const nextPrimary = !primary || primary === src || myRank > primaryRank ? src : primary;

  // write-ahead: the base this write will leave goes into ib/ as pending
  // first, so a crash between the record write and the base write loses nothing
  const first = mergeFields(fields, { mode, base: Bs ? Bs.fields : {}, crm: pickFields(cur, fields), rotor: mapped, others, rank: myRank });
  const firstHash = hashFields(first.base);
  if (!Bs || firstHash !== Bs.hash) {
    const ahead = { ...sources, [src]: { ...(sources[src] || { rank: myRank }), pending: { fields: first.base, hash: firstHash, run_id: runId, at } } };
    if (takeover) ahead[src] = { rank: myRank, pending: ahead[src].pending };
    await writeBase(type, id, { primary: (ib && ib.primary) || primary || src, sources: takeover ? { ...(ib ? ib.sources : {}), [src]: ahead[src] } : ahead });
    baseDirty = true;
  }

  let plan = null;
  const res = await updateRecord(type, id, (r) => {
    plan = mergeFields(fields, { mode, base: Bs ? Bs.fields : {}, crm: pickFields(r, fields), rotor: mapped, others, rank: myRank });
    const next = clone(r);
    for (const f of plan.changed) setPath(next, f, plan.next[f]);
    // outside rotorFields: fill only what the record doesn't have (a placeholder row fills nothing)
    if (!placeholderRow) {
      for (const [k, v] of Object.entries(norm)) if (!ENVELOPE.has(k) && !fields.includes(k) && !fields.some((f) => f.startsWith(k + ".")) && empty(r[k]) && !empty(v)) next[k] = clone(v);
    }
    const clearFlag = !placeholderRow && !!(r.flags && r.flags.placeholder === true) && (!!takeover || myRank > 0 && nextPrimary === src);
    if (clearFlag) delete next.flags.placeholder;
    const srcTags = { ...((r.import && r.import.src) || {}), [src]: hashFields(plan.base) };
    if (takeover) delete srcTags[takeover];
    const sameImport = r.import && r.import.source === nextPrimary && canonJson(r.import.src || {}) === canonJson(srcTags);
    if (!plan.changed.length && sameImport && !clearFlag && canonJson({ ...next, import: null }) === canonJson({ ...r, import: null })) return null;
    next.import = { run_id: runId, at, source: nextPrimary, src: srcTags, hash: hashFields(pickFields(next, fields)) };
    return next;
  }, ctx);
  sources[src] = { fields: plan.base, hash: hashFields(plan.base), rank: myRank, run_id: runId, at };
  if (!ib || baseDirty || canonJson({ p: ib.primary, s: ib.sources }) !== canonJson({ p: nextPrimary, s: sources })) await writeBase(type, id, { primary: nextPrimary, sources });
  if (res.changed) await settleHash(type, fields, res.data, ctx);
  const conflicts = plan.conflicts;
  for (const f of conflicts) {
    await putRaw(conflictKey(runId, type, id, f), {
      run_id: runId, type, id, field: f, source: src, base: clone(Bs && Bs.fields ? Bs.fields[f] : undefined) ?? null, crm: clone(getPath(res.data, f)) ?? null, rotor: clone(mapped[f]) ?? null,
      at: nowIso(), status: "open",
    });
  }
  if (!res.changed && cur.import && cur.import.run_id === runId) await reassertSides(def, res.data, ctx);
  const outcome = conflicts.length ? "conflicted" : mode === "new" ? "linked" : res.changed ? "updated" : "unchanged";
  return { outcome, type, id, mode, conflicts, kept: plan.kept, changed: plan.changed };
}

export { ExistsError };
