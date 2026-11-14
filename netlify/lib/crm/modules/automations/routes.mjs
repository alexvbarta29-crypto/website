// Automations module: the builder's API (automations:configure: owners and
// the office; never a technician).
//
//   GET    /automations/flows                     the list (on/off, runs, last run, summary), starters, the catalog, choices
//   POST   /automations/flows                     { recipe } or a definition → a new automation (off)
//   POST   /automations/flows/check               { flow } → { summary, problems } (the editor's live sentence)
//   POST   /automations/flows/test                { flow, contact_id } → what would happen (no writes, nothing sent)
//   GET    /automations/flows/:id                 one, with its summary and problems
//   PATCH  /automations/flows/:id                 If-Match; a definition (turning it on needs no problems)
//   POST   /automations/flows/:id/pause · resume  off / on
//   POST   /automations/flows/:id/duplicate       a copy, off
//   DELETE /automations/flows/:id                 soft delete; runs in flight stop at their next step
//   GET    /automations/flows/:id/runs?before=    run history (newest first), each step's outcome
//   GET    /automations/flows/:id/runs/:run       one run, with each text's or email's outcome

import { getRecord, createRecord, updateRecord, softDelete, listRel, listKeys, getRecords, readIndex, getRaw } from "../../../crm-store.mjs";
import { isId } from "../../core/ids.mjs";
import { InputError, NotFoundError, ConflictError } from "../../core/errors.mjs";
import { fromTsKey, now, nowIso } from "../../core/clock.mjs";
import { keySafe } from "../../core/text.mjs";
import { listTemplates } from "../../core/templates.mjs";
import { contactShard } from "../../core/stats.mjs";
import { cleanFlow, summarize, TRIGGERS, FIELDS, OPS, STEP_TYPES, SERVICES, PLAN_TYPES, LIFECYCLES, STATUSES, STATUS_LABELS, DEAL_STAGES, WHO, RECIPES, NOT_YET, WAIT_UNITS, MAX_STEPS } from "./catalog.mjs";
import { simulate, flowSettings, FLOW_SETTINGS } from "./engine.mjs";

const r = (method, path, handler, more = {}) => ({ method, path, auth: "session", perm: "automations:configure", subject: path.includes(":id") ? "required" : "none", mode: "inline", handler, ...more });
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

// Names for the plain-English sentence and the pickers (lists: the tags,
// sources and towns in use, from the contacts list; only the screens that
// show pickers read it).
async function choices({ lists = false } = {}) {
  const [tpls, users, cads, contacts] = await Promise.all([
    listTemplates().catch(() => []),
    readIndex("users", "").then((x) => x.rows).catch(() => []),
    readIndex("cadences", "").then((x) => x.rows).catch(() => []),
    lists ? readIndex("contacts", contactShard("ct_00000000000000000000")).then((x) => x.rows).catch(() => []) : [],
  ]);
  const templates = tpls.filter((t) => t.category !== "staff" && t.active !== false).map((t) => ({ key: t.key, name: t.name, channel: t.channel, category: t.category }));
  const people = users.filter((u) => u.status === "active").map((u) => ({ id: u.id, name: u.name, role: u.role }));
  const cadences = cads.filter((c) => c.act !== false && !c.bo).map((c) => ({ key: c.k, name: c.n }));
  const count = (pick) => {
    const m = new Map();
    for (const row of contacts) for (const v of pick(row)) if (v) m.set(v, (m.get(v) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([v]) => v);
  };
  return {
    templates, users: people, cadences,
    tags: count((x) => x.tg || []), sources: count((x) => [x.src]), towns: count((x) => [x.c]),
  };
}
const labelsOf = (ch) => ({
  templates: Object.fromEntries(ch.templates.map((t) => [t.key, t.name])),
  users: Object.fromEntries(ch.users.map((u) => [u.id, u.name])),
  cadences: Object.fromEntries(ch.cadences.map((c) => [c.key, c.name])),
});

// What would keep it from working (templates, people, cadences that aren't there).
function problemsOf(flow, ch) {
  const out = [];
  flow.steps.forEach((s, i) => {
    const where = `steps.${i}`;
    if (s.type === "text" || s.type === "email") {
      const t = ch.templates.find((x) => x.key === s.template_key);
      if (!t) out.push({ field: `${where}.template_key`, message: `Step ${i + 1}: that template isn't there.` });
      else if (t.channel !== (s.type === "text" ? "sms" : "email")) out.push({ field: `${where}.template_key`, message: `Step ${i + 1}: pick ${s.type === "text" ? "a text" : "an email"} template.` });
    }
    if (s.type === "cadence" && !ch.cadences.some((c) => c.key === s.cadence_key)) out.push({ field: `${where}.cadence_key`, message: `Step ${i + 1}: that cadence isn't there.` });
    for (const uid of [s.user_id, s.assign, s.to]) if (isId(uid, "user") && !ch.users.some((u) => u.id === uid)) out.push({ field: where, message: `Step ${i + 1}: that person isn't on the team any more.` });
  });
  for (const [list, name] of [[flow.conditions, "conditions"], [flow.stop, "stop"]]) {
    list.forEach((c, i) => { if (c.field === "owner" && isId(c.value, "user") && !ch.users.some((u) => u.id === c.value)) out.push({ field: `${name}.${i}`, message: "That person isn't on the team any more." }); });
  }
  return out;
}

const view = (f, ch) => ({
  id: f.id, name: f.name, enabled: f.enabled === true, trigger: f.trigger, conditions: f.conditions, steps: f.steps, stop: f.stop, limits: f.limits,
  recipe: f.recipe || null, auto_paused: f.auto_paused || null, created_at: f.created_at, updated_at: f.updated_at, wv: f.wv,
  summary: summarize(f, labelsOf(ch)), problems: problemsOf(f, ch),
});

async function runsCount(flowId) {
  const rows = await listRel("flow-runs", flowId, { limit: 1000 });
  const last = rows[0] ? fromTsKey(rows[0].sortKey) : null;
  return { runs: rows.length, last_run_at: last ? last.toISOString() : null };
}

async function live(id) {
  if (!isId(id, "flow")) throw new NotFoundError("That automation isn't there.");
  const got = await getRecord("flow", id);
  if (!got || got.data.deleted_at) throw new NotFoundError("That automation isn't there.");
  return got;
}

// ------------------------------------------------------------ handlers

const CATALOG = Object.freeze({
  triggers: Object.entries(TRIGGERS).map(([key, t]) => ({ key, label: t.label, group: t.group, subject: t.subject, schedule: !!t.schedule, option: t.option || null })),
  not_yet: NOT_YET, fields: Object.entries(FIELDS).map(([key, f]) => ({ key, ...f })), ops: OPS,
  steps: Object.entries(STEP_TYPES).map(([key, s]) => ({ key, label: s.label })), services: SERVICES, plan_types: PLAN_TYPES, lifecycles: LIFECYCLES,
  statuses: STATUSES, status_labels: STATUS_LABELS, deal_stages: DEAL_STAGES, who: WHO, wait_units: Object.keys(WAIT_UNITS), max_steps: MAX_STEPS,
});

async function list() {
  const keys = await listKeys("rel/flows-by-trigger/");
  const ids = [...new Set(keys.map((k) => k.split("--").pop()).filter((x) => isId(x, "flow")))];
  const [got, ch, settings] = await Promise.all([getRecords("flow", ids), choices(), flowSettings()]);
  const flows = got.map((g) => g && g.data).filter((f) => f && !f.deleted_at);
  const counts = await Promise.all(flows.map((f) => runsCount(f.id)));
  const labels = labelsOf(ch);
  return {
    data: {
      flows: flows.map((f, i) => ({ ...view(f, ch), ...counts[i] })).sort((a, b) => a.name.localeCompare(b.name)),
      recipes: RECIPES.map((x) => ({ key: x.key, label: x.label, blurb: x.blurb, summary: summarize(cleanFlow(x.flow), labels) })),
      catalog: CATALOG, choices: ch, settings: { ...FLOW_SETTINGS, ...settings },
    },
  };
}

async function create(ctx) {
  const b = ctx.body || {};
  let def;
  if (typeof b.recipe === "string") {
    const rec = RECIPES.find((x) => x.key === b.recipe);
    if (!rec) throw new InputError("Pick a starter.", "recipe");
    def = { ...rec.flow, recipe: rec.key };
  } else def = b;
  const clean = cleanFlow({ ...def, enabled: false });
  const rec = await createRecord("flow", clean, ctx.write());
  const ch = await choices();
  return { status: 201, data: { flow: view(rec.data, ch) }, etag: rec.etag };
}

// ?catalog=1: with what the editor's pickers offer
async function one(ctx) {
  const got = await live(ctx.params.id);
  const editor = ctx.query.get("catalog") === "1";
  const [ch, counts] = await Promise.all([choices({ lists: editor }), runsCount(got.data.id)]);
  const extra = editor ? { catalog: CATALOG, choices: ch } : {};
  return { data: { flow: { ...view(got.data, ch), ...counts }, ...extra }, etag: got.etag };
}

async function patch(ctx) {
  if (!ctx.ifMatch) throw new InputError("This change needs the version you edited (If-Match).", "if-match");
  const cur = await live(ctx.params.id);
  const b = ctx.body || {};
  const clean = cleanFlow({ ...cur.data, ...b, enabled: b.enabled === undefined ? cur.data.enabled : b.enabled === true });
  const ch = await choices();
  const problems = problemsOf(clean, ch);
  if (clean.enabled && problems.length) throw new InputError(problems[0].message, problems[0].field);
  const r2 = await updateRecord("flow", cur.data.id, (f) => {
    const next = { ...f, ...clean };
    if (!clean.recipe) delete next.recipe;
    if (clean.enabled) delete next.auto_paused;
    return next;
  }, { ...ctx.write(), ifMatch: ctx.ifMatch });
  return { data: { flow: view(r2.data, ch) }, etag: r2.etag };
}

const setOn = (on) => async (ctx) => {
  const cur = await live(ctx.params.id);
  const ch = await choices();
  if (on) {
    const problems = problemsOf(cur.data, ch);
    if (problems.length) throw new ConflictError(`Fix it first: ${problems[0].message}`);
  }
  const r2 = await updateRecord("flow", cur.data.id, (f) => {
    if ((f.enabled === true) === on) return null;
    const next = { ...f, enabled: on };
    if (on) delete next.auto_paused;
    return next;
  }, ctx.write());
  return { data: { flow: view(r2.data, ch) }, etag: r2.etag };
};

async function duplicate(ctx) {
  const cur = await live(ctx.params.id);
  const { id, wv, v, type, created_at, created_by, updated_at, updated_by, auto_paused, ...rest } = cur.data;
  const copy = cleanFlow({ ...rest, name: `${cur.data.name} (copy)`.slice(0, 80), enabled: false });
  const rec = await createRecord("flow", copy, ctx.write());
  return { status: 201, data: { flow: view(rec.data, await choices()) }, etag: rec.etag };
}

async function remove(ctx) {
  const cur = await live(ctx.params.id);
  await softDelete("flow", cur.data.id, ctx.write());
  return { data: { ok: true } };
}

// The editor's live sentence: never a 400 while someone is half way through.
async function check(ctx) {
  const b = isObj(ctx.body) ? ctx.body.flow : null;
  try {
    const clean = cleanFlow({ ...(b || {}), enabled: false });
    const ch = await choices();
    return { data: { summary: summarize(clean, labelsOf(ch)), problems: problemsOf(clean, ch) } };
  } catch (e) {
    if (!(e instanceof InputError)) throw e;
    return { data: { summary: null, problems: [{ field: e.field || null, message: e.message }] } };
  }
}

async function test(ctx) {
  const b = ctx.body || {};
  const flow = cleanFlow({ ...(isObj(b.flow) ? b.flow : {}), enabled: false });
  if (isObj(b.flow) && isId(b.flow.id, "flow")) flow.id = b.flow.id;
  if (!isId(b.contact_id, "contact")) throw new InputError("Pick a customer to test with.", "contact_id");
  const [ch, mode] = await Promise.all([choices(), ctx.sysMode()]);
  const result = await simulate(flow, { contact_id: b.contact_id }, { mode, labels: labelsOf(ch) });
  return { data: { ...result, summary: summarize(flow, labelsOf(ch)) } };
}

const runView = (x) => ({
  id: x.id, status: x.status, trigger: x.trigger, subject: x.subject || null, contact_id: x.contact_id || null, members: x.members ? x.members.length : 1,
  out: x.out ? Object.keys(x.out).length : 0, started_at: x.started_at, finished_at: x.finished_at || null, next_at: x.next_at || null,
  stop_reason: x.stop_reason || null, test: !!x.test, plan: x.plan, steps: x.steps, step: x.step,
});

async function runs(ctx) {
  const cur = await live(ctx.params.id);
  const before = ctx.query.get("before");
  const rows = await listRel("flow-runs", cur.data.id, { ...(before ? { to: before } : {}), limit: 21 });
  const page = rows.filter((x) => !before || x.sortKey < before).slice(0, 20);
  const got = await getRecords("flow_run", page.map((x) => x.id));
  const ids = [...new Set(got.map((g) => g && g.data && g.data.contact_id).filter((c) => isId(c, "contact")))];
  const [contacts, tpls] = await Promise.all([getRecords("contact", ids), listTemplates().catch(() => [])]);
  const names = Object.fromEntries(contacts.filter(Boolean).map((g) => [g.data.id, g.data.display_name || [g.data.first_name, g.data.last_name].filter(Boolean).join(" ")]));
  return {
    data: {
      templates: Object.fromEntries(tpls.map((x) => [x.key, x.name])),
      runs: got.filter((g) => g && g.data).map((g) => ({ ...runView(g.data), contact_name: names[g.data.contact_id] || null })),
      next: rows.length > page.length && page.length ? page[page.length - 1].sortKey : null,
    },
  };
}

// One run: each send step's outcome from its marker (done-dry/ or done/).
async function oneRun(ctx) {
  const cur = await live(ctx.params.id);
  if (!isId(ctx.params.run, "flow_run")) throw new NotFoundError("That run isn't there.");
  const got = await getRecord("flow_run", ctx.params.run);
  if (!got || got.data.flow_id !== cur.data.id) throw new NotFoundError("That run isn't there.");
  const run = got.data;
  const sends = [];
  for (const [i, s] of run.plan.entries()) {
    if (!(s.type === "text" || s.type === "email") || !run.steps[i] || run.steps[i].status !== "queued") continue;
    for (const scope of ["flow.service", "flow.marketing"]) {
      const key = keySafe(`${run.id}--${i}`, 120);
      const [dry, real] = await Promise.all([getRaw(`done-dry/${scope}/${key}`).catch(() => null), getRaw(`done/${scope}/${key}`).catch(() => null)]);
      const m = (real && real.data) || (dry && dry.data);
      if (m) { sends.push({ step: i, state: m.state, result: m.result || null, dry: !!(dry && dry.data && !(real && real.data)) }); break; }
    }
  }
  const [contact, tpls] = await Promise.all([isId(run.contact_id, "contact") ? getRecord("contact", run.contact_id).catch(() => null) : null, listTemplates().catch(() => [])]);
  return { data: { run: { ...runView(run), contact_name: contact ? contact.data.display_name || null : null, out_reasons: run.out || {}, sends }, templates: Object.fromEntries(tpls.map((x) => [x.key, x.name])) } };
}

export const flowRoutes = [
  r("GET", "/automations/flows", list, { maxCalls: 80 }),
  r("POST", "/automations/flows", create, { maxCalls: 40 }),
  r("POST", "/automations/flows/check", check, { maxCalls: 40, idempotent: false }),
  r("POST", "/automations/flows/test", test, { maxCalls: 80, idempotent: false }),
  r("GET", "/automations/flows/:id", one, { maxCalls: 40 }),
  r("PATCH", "/automations/flows/:id", patch, { maxCalls: 40 }),
  r("POST", "/automations/flows/:id/pause", setOn(false), { maxCalls: 40 }),
  r("POST", "/automations/flows/:id/resume", setOn(true), { maxCalls: 40 }),
  r("POST", "/automations/flows/:id/duplicate", duplicate, { maxCalls: 40 }),
  r("DELETE", "/automations/flows/:id", remove),
  r("GET", "/automations/flows/:id/runs", runs, { maxCalls: 60 }),
  r("GET", "/automations/flows/:id/runs/:run", oneRun, { maxCalls: 40 }),
];
