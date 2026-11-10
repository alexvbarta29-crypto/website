// Barta CRM core: the registry every module plugs into (design §3.14
// defineType, §11.3 extension points).
//
// A module's netlify/lib/crm/modules/<name>/index.mjs default-exports one
// defineModule({...}) call; modules/index.mjs hands every module to
// registerModules() at cold start. Validation happens here, so a manifest
// with an unknown key, a duplicate route/permission/setting/key, or a
// missing `mutates`, `category`, `perm` or `rotorFields` fails at import
// time (and therefore fails `npm test`), never in production at 2 a.m.
//
// The store (crm-store.mjs) reads type definitions, index feeds, settings
// defaults and stats parts from here.

import { RegistryError } from "./errors.mjs";
import { registerPrefix, prefixOf } from "./ids.mjs";
import { provide } from "./services.mjs";
import { MIRRORED_TYPES } from "./guard.mjs";

const isFn = (f) => typeof f === "function";
const isObj = (o) => !!o && typeof o === "object" && !Array.isArray(o);
const fail = (msg) => { throw new RegistryError(msg); };
const needArray = (v, what) => { if (v !== undefined && !Array.isArray(v)) fail(`${what} must be a list`); return v || []; };
const needObj = (v, what) => { if (v !== undefined && !isObj(v)) fail(`${what} must be an object`); return v || {}; };
const unknownKeys = (obj, allowed, what) => {
  for (const k of Object.keys(obj)) if (!allowed.has(k)) fail(`${what}: unknown key "${k}"`);
};

// ---------------------------------------------------------------- types

const TYPE_KEYS = new Set(["type", "prefix", "idType", "v", "validate", "migrate", "rotorFields", "mirrored", "indexes", "rels",
  "pointers", "summary", "techFields", "example", "shadow", "audit", "readPerm"]);

export function defineType(def) {
  if (!isObj(def)) fail("defineType: expected an object");
  unknownKeys(def, TYPE_KEYS, `defineType(${def.type})`);
  const t = def.type;
  if (typeof t !== "string" || !/^[a-z][a-z_]{1,30}$/.test(t)) fail(`defineType: bad type name ${t}`);
  const where = `type ${t}`;
  if (def.prefix !== null && !(typeof def.prefix === "string" && /^[a-z]{2}$/.test(def.prefix))) fail(`${where}: prefix must be two lowercase letters (or null with idType)`);
  if (def.prefix === null && typeof def.idType !== "string") fail(`${where}: a type without a prefix names its idType`);
  if (!Number.isSafeInteger(def.v) || def.v < 1) fail(`${where}: v must be a positive integer`);
  if (!isFn(def.validate)) fail(`${where}: validate() is required`);
  if (!Array.isArray(def.rotorFields) || def.rotorFields.some((f) => typeof f !== "string")) fail(`${where}: rotorFields is required (a list of field names)`);
  if (!Array.isArray(def.techFields) || def.techFields.some((f) => typeof f !== "string")) fail(`${where}: techFields is required (a list of field names)`);
  if (!isFn(def.example)) fail(`${where}: example() is required`);
  const mirrored = def.mirrored === true;
  if (def.mirrored !== undefined && typeof def.mirrored !== "boolean") fail(`${where}: mirrored must be true or false`);
  if (MIRRORED_TYPES.includes(t) && !mirrored) fail(`${where}: this type mirrors Rotor and must say mirrored: true`);
  const migrate = needObj(def.migrate, `${where}: migrate`);
  for (const [v, fn] of Object.entries(migrate)) {
    if (!/^\d+$/.test(v) || +v < 2 || +v > def.v || !isFn(fn)) fail(`${where}: migrate keys are versions 2..v with functions`);
  }
  const indexes = needArray(def.indexes, `${where}: indexes`).map((ix, i) => {
    if (!isObj(ix) || typeof ix.name !== "string" || !isFn(ix.shard) || !isFn(ix.row)) fail(`${where}: indexes[${i}] needs name, shard() and row()`);
    unknownKeys(ix, new Set(["name", "part", "shard", "row", "primary"]), `${where}: indexes[${i}]`);
    // primary: false marks a part that only adds to rows another type owns (the contacts row's stats part)
    return Object.freeze({ name: ix.name, part: ix.part || t, shard: ix.shard, row: ix.row, primary: ix.primary !== false });
  });
  const rels = needArray(def.rels, `${where}: rels`).map((r, i) => {
    if (!isObj(r) || typeof r.rel !== "string" || !isFn(r.parent) || !isFn(r.sort)) fail(`${where}: rels[${i}] needs rel, parent() and sort()`);
    unknownKeys(r, new Set(["rel", "parent", "sort", "value"]), `${where}: rels[${i}]`);
    return Object.freeze({ ...r });
  });
  const pointers = needArray(def.pointers, `${where}: pointers`).map((p, i) => {
    if (!isObj(p) || typeof p.kind !== "string" || !(isFn(p.keys) || isFn(p.key))) fail(`${where}: pointers[${i}] needs kind and keys()`);
    unknownKeys(p, new Set(["kind", "list", "keys", "key"]), `${where}: pointers[${i}]`);
    const keys = isFn(p.keys) ? p.keys : (r) => { const k = p.key(r); return k === null || k === undefined || k === "" ? [] : [k]; };
    return Object.freeze({ kind: p.kind, list: p.list === true, keys });
  });
  if (def.summary !== undefined && !isFn(def.summary)) fail(`${where}: summary must be a function`);
  // readPerm: the permission that reads one record of this type (its history, §4.12); scoped checks pass the record
  if (def.readPerm !== undefined && !(typeof def.readPerm === "string" && /^[a-z_]+:[a-z_]+$/.test(def.readPerm))) fail(`${where}: readPerm must be "resource:action"`);
  return Object.freeze({
    type: t, prefix: def.prefix, idType: def.idType || t, v: def.v, validate: def.validate, migrate: Object.freeze({ ...migrate }),
    rotorFields: Object.freeze([...def.rotorFields]), techFields: Object.freeze([...def.techFields]), example: def.example,
    mirrored, indexes: Object.freeze(indexes), rels: Object.freeze(rels), pointers: Object.freeze(pointers),
    summary: def.summary || ((r) => ({ id: r.id })), shadow: def.shadow !== false, audit: def.audit !== false,
    readPerm: def.readPerm || null,
  });
}

// ---------------------------------------------------------------- modules

export const MODULE_KEYS = Object.freeze(["name", "parts", "types", "statsParts", "settings", "perms", "routes", "portalRoutes", "events", "emits",
  "services", "needs", "sweeps", "queue", "automations", "templates", "seeds", "onMerge", "attention", "approvals", "pushKinds",
  "activityKinds", "exportTypes", "mcpTools", "importPhases", "reports"]);
const MODULE_KEY_SET = new Set(MODULE_KEYS);
const LIST_KEYS = ["types", "perms", "routes", "portalRoutes", "emits", "needs", "sweeps", "automations", "templates", "seeds",
  "attention", "approvals", "pushKinds", "exportTypes", "mcpTools", "importPhases"];
const MAP_KEYS = ["statsParts", "settings", "events", "services", "queue", "activityKinds", "reports"];

export const ROUTE_METHODS = Object.freeze(["GET", "POST", "PATCH", "PUT", "DELETE"]);
export const ROUTE_AUTH = Object.freeze(["session", "session_or_key", "key", "hook", "public", "office_cookie", "session_or_office"]);
// secret: true = the answer carries a bearer secret (a one-time link, an
// API key shown once). Such a route must be idempotent: false, because the
// dispatcher keeps an idempotent route's whole answer in idem/ for 7 days.
const ROUTE_KEYS = new Set(["method", "path", "auth", "perm", "subject", "mode", "body", "maxBody", "idempotent", "replaySafe", "budgetMs", "maxCalls", "handler", "secret"]);
// maintenance: true = keeps running while sys/mode.paused (after a restore, §3.10 "Paused")
const SWEEP_KEYS = new Set(["key", "lane", "every", "at_local", "day", "dow", "mutates", "maintenance", "run", "label"]);
// recheck(item, actx) → { skip? }: core/automations.mjs asks it when a queued send is due
const AUTOMATION_KEYS = new Set(["key", "trigger", "category", "imported", "mutates", "defaults", "run", "label", "recheck"]);
export const AUTOMATION_CATEGORIES = Object.freeze(["service", "marketing", "personal", "staff"]);
export const AUTOMATION_IMPORTED = Object.freeze(["no", "eligible", "yes"]);

// Merges a module's parts ({ parts: [office, field] }) into one manifest.
function compose(manifest) {
  const parts = needArray(manifest.parts, `module ${manifest.name}: parts`);
  if (!parts.length) return { ...manifest };
  const out = { ...manifest };
  delete out.parts;
  for (const [i, part] of parts.entries()) {
    if (!isObj(part)) fail(`module ${manifest.name}: parts[${i}] must be an object`);
    unknownKeys(part, new Set(MODULE_KEYS.filter((k) => k !== "name" && k !== "parts")), `module ${manifest.name}: parts[${i}]`);
    for (const [k, v] of Object.entries(part)) {
      if (LIST_KEYS.includes(k)) out[k] = [...needArray(out[k], `${manifest.name}.${k}`), ...needArray(v, `${manifest.name}.parts[${i}].${k}`)];
      else if (MAP_KEYS.includes(k)) {
        const base = { ...needObj(out[k], `${manifest.name}.${k}`) };
        for (const [kk, vv] of Object.entries(needObj(v, `${manifest.name}.parts[${i}].${k}`))) {
          if (Object.hasOwn(base, kk)) fail(`module ${manifest.name}: ${k}.${kk} is declared twice`);
          base[kk] = vv;
        }
        out[k] = base;
      } else if (k === "onMerge") {
        if (!isFn(v)) fail(`module ${manifest.name}: onMerge must be a function`);
        const prev = out.onMerge;
        out.onMerge = prev ? async (...a) => { await prev(...a); await v(...a); } : v;
      } else fail(`module ${manifest.name}: parts[${i}].${k} cannot be composed`);
    }
  }
  return out;
}

function checkRoute(r, where) {
  if (!isObj(r)) fail(`${where}: a route must be an object`);
  unknownKeys(r, ROUTE_KEYS, where);
  if (!ROUTE_METHODS.includes(r.method)) fail(`${where}: method must be one of ${ROUTE_METHODS.join(", ")}`);
  if (typeof r.path !== "string" || !r.path.startsWith("/")) fail(`${where}: path must start with /`);
  if (!ROUTE_AUTH.includes(r.auth)) fail(`${where}: auth is required (${ROUTE_AUTH.join(" | ")})`);
  if (!Object.hasOwn(r, "perm") || !(r.perm === null || (typeof r.perm === "string" && /^[a-z_]+:[a-z_]+$/.test(r.perm)))) fail(`${where}: perm is required ("resource:action", or null for public and hook routes)`);
  if (r.perm === null && !["public", "hook"].includes(r.auth)) fail(`${where}: only public and hook routes may have perm: null`);
  if (!["required", "none"].includes(r.subject)) fail(`${where}: subject is required ("required" | "none")`);
  if (!["inline", "run"].includes(r.mode)) fail(`${where}: mode is required ("inline" | "run")`);
  if (!isFn(r.handler)) fail(`${where}: handler is required`);
  if (r.secret === true && r.idempotent !== false) fail(`${where}: a secret route must be idempotent: false (its answer would be stored in idem/)`);
}

export function defineModule(input) {
  if (!isObj(input)) fail("defineModule: expected an object");
  unknownKeys(input, MODULE_KEY_SET, `defineModule(${input.name})`);
  if (typeof input.name !== "string" || !/^[a-z][a-z0-9_-]*$/.test(input.name)) fail(`defineModule: bad module name ${input.name}`);
  const m = compose(input);
  const name = m.name;
  const types = needArray(m.types, `${name}.types`).map((t) => (t && t.validate && Object.isFrozen(t) ? t : defineType(t)));
  const perms = needArray(m.perms, `${name}.perms`);
  for (const p of perms) {
    if (!isObj(p) || typeof p.key !== "string" || !/^[a-z_]+:[a-z_]+$/.test(p.key) || typeof p.label !== "string" || !isObj(p.roles)) fail(`${name}: a permission needs key "resource:action", label and roles`);
  }
  const routes = needArray(m.routes, `${name}.routes`);
  routes.forEach((r, i) => checkRoute(r, `${name}.routes[${i}] ${r && r.method} ${r && r.path}`));
  const settings = needObj(m.settings, `${name}.settings`);
  for (const [s, d] of Object.entries(settings)) {
    if (!isObj(d) || !isObj(d.defaults) || !isFn(d.validate)) fail(`${name}: setting ${s} needs defaults and validate()`);
    if (typeof d.perm !== "string" || !d.perm) fail(`${name}: setting ${s} needs a perm`);
  }
  const statsParts = needObj(m.statsParts, `${name}.statsParts`);
  for (const [p, d] of Object.entries(statsParts)) if (!isObj(d) || !isObj(d.defaults) || !isFn(d.row)) fail(`${name}: stats part ${p} needs defaults and row()`);
  const sweeps = needArray(m.sweeps, `${name}.sweeps`);
  for (const s of sweeps) {
    if (!isObj(s)) fail(`${name}: a sweep must be an object`);
    unknownKeys(s, SWEEP_KEYS, `${name}: sweep ${s.key}`);
    if (typeof s.key !== "string" || !["fast", "bulk"].includes(s.lane) || !["pass", "hourly", "daily", "weekly", "monthly"].includes(s.every) || !isFn(s.run)) fail(`${name}: sweep ${s.key} needs key, lane, every and run()`);
    if (typeof s.mutates !== "boolean") fail(`${name}: sweep ${s.key} must declare mutates`);
    if (s.maintenance !== undefined && typeof s.maintenance !== "boolean") fail(`${name}: sweep ${s.key}: maintenance is true or false`);
    if (s.at_local !== undefined && !(typeof s.at_local === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s.at_local))) fail(`${name}: sweep ${s.key}: at_local is "HH:MM"`);
    if (s.dow !== undefined && !(Number.isInteger(s.dow) && s.dow >= 0 && s.dow <= 6)) fail(`${name}: sweep ${s.key}: dow is 0 (Sunday) to 6`);
    if (s.day !== undefined && !(Number.isInteger(s.day) && s.day >= 1 && s.day <= 28)) fail(`${name}: sweep ${s.key}: day is 1 to 28`);
  }
  const queue = needObj(m.queue, `${name}.queue`);
  for (const [k, q] of Object.entries(queue)) {
    if (!isObj(q) || !isFn(q.handler)) fail(`${name}: queue kind ${k} needs a handler`);
    if (typeof q.mutates !== "boolean") fail(`${name}: queue kind ${k} must declare mutates`);
  }
  const events = needObj(m.events, `${name}.events`);
  for (const [k, l] of Object.entries(events)) {
    if (!isObj(l) || !isFn(l.handler)) fail(`${name}: listener for ${k} needs a handler`);
    if (typeof l.mutates !== "boolean") fail(`${name}: listener for ${k} must declare mutates`);
  }
  const automations = needArray(m.automations, `${name}.automations`);
  for (const a of automations) {
    if (!isObj(a)) fail(`${name}: an automation must be an object`);
    unknownKeys(a, AUTOMATION_KEYS, `${name}: automation ${a.key}`);
    if (typeof a.key !== "string" || typeof a.trigger !== "string" || !isFn(a.run)) fail(`${name}: automation ${a.key} needs key, trigger and run()`);
    if (!AUTOMATION_CATEGORIES.includes(a.category)) fail(`${name}: automation ${a.key} must declare a category`);
    if (!AUTOMATION_IMPORTED.includes(a.imported)) fail(`${name}: automation ${a.key} must declare imported`);
    if (typeof a.mutates !== "boolean") fail(`${name}: automation ${a.key} must declare mutates`);
    if (a.recheck !== undefined && !isFn(a.recheck)) fail(`${name}: automation ${a.key}: recheck must be a function`);
  }
  const templates = needArray(m.templates, `${name}.templates`);
  for (const t of templates) {
    if (!isObj(t) || typeof t.key !== "string" || typeof t.body !== "string" || typeof t.channel !== "string" || typeof t.category !== "string") fail(`${name}: a template needs key, channel, category and body`);
  }
  const services = needObj(m.services, `${name}.services`);
  for (const [s, fn] of Object.entries(services)) if (!isFn(fn)) fail(`${name}: service ${s} must be a function`);
  const seeds = needArray(m.seeds, `${name}.seeds`);
  for (const s of seeds) if (!isObj(s) || !Number.isSafeInteger(s.v) || !isFn(s.run)) fail(`${name}: a seed needs v and run()`);
  if (m.onMerge !== undefined && !isFn(m.onMerge)) fail(`${name}: onMerge must be a function`);
  for (const k of ["emits", "needs", "pushKinds", "exportTypes"]) {
    for (const v of needArray(m[k], `${name}.${k}`)) if (typeof v !== "string") fail(`${name}: ${k} holds names`);
  }
  return Object.freeze({
    ...m, name, types: Object.freeze(types), perms, routes, settings, statsParts, sweeps, queue, events, automations, templates, services, seeds,
    emits: needArray(m.emits, ""), needs: needArray(m.needs, ""), portalRoutes: needArray(m.portalRoutes, ""), attention: needArray(m.attention, ""),
    approvals: needArray(m.approvals, ""), pushKinds: needArray(m.pushKinds, ""), activityKinds: needObj(m.activityKinds, ""),
    exportTypes: needArray(m.exportTypes, ""), mcpTools: needArray(m.mcpTools, ""), importPhases: needArray(m.importPhases, ""), reports: needObj(m.reports, ""),
  });
}

// ---------------------------------------------------------------- registry state

const state = () => ({
  modules: new Map(), types: new Map(), settings: new Map(), statsParts: new Map(), indexes: new Map(),
  perms: new Map(), routes: new Map(), sweeps: new Map(), queue: new Map(), listeners: new Map(),
  automations: new Map(), templates: new Map(), emits: new Map(),
});
let R = state();

const claim = (map, key, owner, what) => {
  if (map.has(key)) fail(`${what} ${key} is declared by ${map.get(key).module} and ${owner}`);
};

// Adds one type (modules do this through registerModule; tests may call it directly).
export function registerType(def, module = "system") {
  const t = def && def.validate && Object.isFrozen(def) ? def : defineType(def);
  claim(R.types, t.type, module, "type");
  if (t.prefix) {
    const had = prefixOf(t.type);
    if (had && had !== t.prefix) fail(`type ${t.type}: prefix ${t.prefix} differs from the id table's ${had}`);
    registerPrefix(t.type, t.prefix);
  }
  R.types.set(t.type, { ...t, module });
  for (const ix of t.indexes) {
    const entry = R.indexes.get(ix.name) || { primary: null, feeds: [] };
    if (entry.feeds.some((f) => f.part === ix.part)) fail(`index ${ix.name}: part ${ix.part} is fed twice`);
    entry.feeds.push({ type: t.type, part: ix.part, shard: ix.shard, row: ix.row, module });
    if (!entry.primary && ix.primary) entry.primary = ix.part;
    R.indexes.set(ix.name, entry);
  }
  return R.types.get(t.type);
}

export function registerModule(manifest) {
  const m = manifest && Object.isFrozen(manifest) && manifest.name ? manifest : defineModule(manifest);
  if (R.modules.has(m.name)) {
    if (R.modules.get(m.name) === m) return m;   // the same import seen twice
    fail(`module ${m.name} is registered twice`);
  }
  // check everything before changing anything, so a bad module leaves no half state
  for (const t of m.types) claim(R.types, t.type, m.name, "type");
  for (const s of Object.keys(m.settings)) claim(R.settings, s, m.name, "setting");
  for (const p of Object.keys(m.statsParts)) claim(R.statsParts, p, m.name, "stats part");
  for (const p of m.perms) claim(R.perms, p.key, m.name, "permission");
  for (const r of m.routes) claim(R.routes, `${r.method} ${r.path}`, m.name, "route");
  for (const s of m.sweeps) claim(R.sweeps, s.key, m.name, "sweep");
  for (const k of Object.keys(m.queue)) claim(R.queue, k, m.name, "queue kind");
  for (const a of m.automations) claim(R.automations, a.key, m.name, "automation");
  for (const t of m.templates) claim(R.templates, t.key, m.name, "template");

  for (const t of m.types) registerType(t, m.name);
  for (const [s, d] of Object.entries(m.settings)) R.settings.set(s, { ...d, module: m.name });
  for (const [p, d] of Object.entries(m.statsParts)) R.statsParts.set(p, { ...d, module: m.name });
  for (const p of m.perms) R.perms.set(p.key, { ...p, module: m.name });
  for (const r of m.routes) R.routes.set(`${r.method} ${r.path}`, { ...r, module: m.name });
  for (const s of m.sweeps) R.sweeps.set(s.key, { ...s, module: m.name });
  for (const [k, q] of Object.entries(m.queue)) R.queue.set(k, { ...q, kind: k, module: m.name });
  for (const a of m.automations) R.automations.set(a.key, { ...a, module: m.name });
  for (const t of m.templates) R.templates.set(t.key, { ...t, module: m.name });
  for (const e of m.emits) R.emits.set(e, [...(R.emits.get(e) || []), m.name]);   // several modules may emit one event (consent.changed)
  for (const [e, l] of Object.entries(m.events)) {
    const list = R.listeners.get(e) || [];
    list.push({ ...l, event: e, module: m.name });
    R.listeners.set(e, list);
  }
  for (const [s, fn] of Object.entries(m.services)) provide(s, fn, { module: m.name });
  R.modules.set(m.name, m);
  return m;
}

export function registerModules(list) {
  for (const m of list) registerModule(m);
  return allModules();
}

// Settings defined by core code outside a module (§11.3 defineSettings).
export function defineSettings(name, { defaults, validate, perm, module = "system" } = {}) {
  if (!isObj(defaults) || !isFn(validate)) fail(`setting ${name} needs defaults and validate()`);
  if (typeof perm !== "string" || !perm) fail(`setting ${name} needs a perm`);
  claim(R.settings, name, module, "setting");
  R.settings.set(name, { defaults, validate, perm, module });
}

// ---------------------------------------------------------------- readers

export const getType = (type) => R.types.get(type) || null;
export function requireType(type) {
  const t = R.types.get(type);
  if (!t) throw new RegistryError(`unknown record type ${type}`);
  return t;
}
export const allTypes = () => [...R.types.values()];
export const getModule = (name) => R.modules.get(name) || null;
export const allModules = () => [...R.modules.values()];
export const getSettingsDef = (name) => R.settings.get(name) || null;
export const allSettings = () => [...R.settings.entries()].map(([name, d]) => ({ name, ...d }));
export const statsPart = (part) => R.statsParts.get(part) || null;
export const allStatsParts = () => [...R.statsParts.entries()];
export const indexFeeds = (name) => (R.indexes.get(name) || { feeds: [] }).feeds;
export const indexPrimary = (name) => (R.indexes.get(name) || {}).primary || null;
export const allIndexes = () => [...R.indexes.keys()];
export const allPerms = () => [...R.perms.values()];
export const allRoutes = () => [...R.routes.values()];
export const allSweeps = () => [...R.sweeps.values()];
export const queueKind = (kind) => R.queue.get(kind) || null;
export const listenersFor = (event) => R.listeners.get(event) || [];
export const allAutomations = () => [...R.automations.values()];
export const allTemplates = () => [...R.templates.values()];
export const isEmitted = (event) => R.emits.has(event);

// Adds a feed to an index for derived parts that are not record types (the
// contacts index "stats" part, fed by contact_stats). Core only.
export function registerIndexFeed(name, feed) {
  const entry = R.indexes.get(name) || { primary: null, feeds: [] };
  if (entry.feeds.some((f) => f.part === feed.part)) fail(`index ${name}: part ${feed.part} is fed twice`);
  entry.feeds.push({ ...feed });
  if (!entry.primary && feed.primary !== false) entry.primary = feed.part;
  R.indexes.set(name, entry);
}

// Tests only: start from an empty registry.
export function __resetRegistryForTests() { R = state(); }
