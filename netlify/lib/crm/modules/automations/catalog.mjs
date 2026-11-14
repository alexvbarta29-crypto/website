// Automations module: the builder's vocabulary (pure, no I/O). What a
// custom automation ("flow") may say: its trigger, its conditions, its
// steps with their waits, the stop conditions, its limits; cleanFlow()
// checks a definition the screen sends, summarize() says it in plain
// English ("When a quote is sent, if no reply in 3 days, text the Day 3
// follow-up, then make a task for the owner."), and RECIPES are the
// starters. docs/CRM-AUTOMATIONS.md describes it.
//
// Flow = {
//   name, enabled,
//   trigger: { type, tag?, days?, at?, dows? },          // TRIGGERS key; at/dows for the daily ones
//   conditions: [{ field, op, value? }],                  // all must hold when it starts
//   steps: [{ id, type, wait?: { n, unit }, at?, business_hours?, ...params }],
//   stop: [{ field, op, value? }],                        // any of them ends the run (checked before every step and send)
//   limits: { per_contact_days },                         // not again for the same customer within N days
//   recipe?,
// }

import { InputError } from "../../core/errors.mjs";
import { isLocalTime } from "../../core/clock.mjs";
import { isId } from "../../core/ids.mjs";
import { squish } from "../../core/text.mjs";

const fail = (msg, field) => { throw new InputError(msg, field); };
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

// ------------------------------------------------------------ triggers

// subject: the record a run is about (its stop conditions read it again).
// schedule: true → checked once a day at `at` (dows: the days of the week)
// instead of by an event.
export const TRIGGERS = Object.freeze({
  "lead.created": { label: "A new lead comes in", phrase: "a new lead comes in", subject: "contact", group: "Sales" },
  "contact.tagged": { label: "A tag is added", phrase: "a tag is added", subject: "contact", group: "Sales", option: "tag" },
  "quote.sent": { label: "A quote is sent", phrase: "a quote is sent", subject: "quote", group: "Quotes" },
  "quote.approved": { label: "A quote is approved", phrase: "a quote is approved", subject: "quote", group: "Quotes" },
  "quote.declined": { label: "A quote is declined", phrase: "a quote is declined", subject: "quote", group: "Quotes" },
  "visit.scheduled": { label: "A visit is booked", phrase: "a visit is booked", subject: "visit", group: "Visits" },
  "visit.started": { label: "A visit starts", phrase: "a visit starts", subject: "visit", group: "Visits" },
  "visit.completed": { label: "A visit is finished", phrase: "a visit is finished", subject: "visit", group: "Visits" },
  "job.completed": { label: "A job is completed", phrase: "a job is completed", subject: "job", group: "Visits" },
  "invoice.sent": { label: "An invoice is sent", phrase: "an invoice is sent", subject: "invoice", group: "Money" },
  "invoice.paid": { label: "An invoice is paid", phrase: "an invoice is paid", subject: "invoice", group: "Money" },
  "invoice.overdue": { label: "An invoice is overdue", phrase: "an invoice is overdue", subject: "invoice", group: "Money", schedule: true, option: "days" },
  "plan.activated": { label: "A plan starts", phrase: "a plan starts", subject: "plan", group: "Plans" },
  "plan.renewing": { label: "A plan is up for renewal", phrase: "a plan is up for renewal", subject: "plan", group: "Plans", schedule: true, option: "days" },
  "plan.renewed": { label: "A plan renews", phrase: "a plan renews", subject: "plan", group: "Plans" },
  "plan.cancelled": { label: "A plan is cancelled", phrase: "a plan is cancelled", subject: "plan", group: "Plans" },
  "review.matched": { label: "A review comes in", phrase: "a review comes in", subject: "review", group: "Messages" },
  "task.due": { label: "A task is due", phrase: "a task is due", subject: "task", group: "Sales", schedule: true },
  "schedule": { label: "On a schedule", phrase: "it's time", subject: "contact", group: "Schedule", schedule: true },
});
export const EVENT_TRIGGERS = Object.freeze(Object.keys(TRIGGERS).filter((k) => !TRIGGERS[k].schedule));
export const isSchedule = (type) => !!(TRIGGERS[type] && TRIGGERS[type].schedule);
// Not offered: a birthday or anniversary (contacts keep no such date yet).
export const NOT_YET = Object.freeze([{ label: "A contact's birthday", why: "Contacts don't keep a birthday yet." }]);

// The id field of an event payload that names the run's record.
export const SUBJECT_ID = Object.freeze({ contact: "contact_id", quote: "quote_id", visit: "visit_id", job: "job_id", invoice: "invoice_id", plan: "plan_id", review: "review_id", task: "task_id" });

// ------------------------------------------------------------ conditions

export const SERVICES = Object.freeze([
  { value: "windows", label: "Window cleaning" }, { value: "gutters", label: "Gutters" }, { value: "screens", label: "Screens" },
  { value: "tracks", label: "Tracks" }, { value: "lights", label: "Christmas lights" }, { value: "other", label: "Something else" },
]);
export const serviceKey = (s) => {
  const t = String(s || "").toLowerCase();
  if (/light/.test(t)) return "lights";
  if (/gutter/.test(t)) return "gutters";
  if (/screen/.test(t)) return "screens";
  if (/track/.test(t)) return "tracks";
  if (/window/.test(t)) return "windows";
  return t ? "other" : null;
};
export const PLAN_TYPES = Object.freeze([
  { value: "biannual", label: "Twice a year" }, { value: "quarterly", label: "Quarterly" }, { value: "monthly", label: "Monthly" },
  { value: "lights", label: "Christmas lights" }, { value: "other", label: "Another plan" },
]);
export const LIFECYCLES = Object.freeze([{ value: "lead", label: "Lead" }, { value: "customer", label: "Customer" }, { value: "former_customer", label: "Former customer" }]);
export const STATUSES = Object.freeze({
  quote: ["sent", "viewed", "approved", "changes_requested", "declined", "converted", "archived"],
  visit: ["scheduled", "in_progress", "completed", "cancelled", "no_access"],
  job: ["unscheduled", "scheduled", "in_progress", "completed", "cancelled"],
  invoice: ["open", "paid", "void"],
  plan: ["pending", "active", "paused", "cancelling", "cancelled", "expired"],
  task: ["open", "in_progress", "waiting", "done", "cancelled"],
  contact: ["lead", "customer", "former_customer"],
});
// The words each module's screens use for its statuses (quotes, money and
// plans kit.js STATUS, work office-kit.js VISIT_STATUS and JOB_STATUS, the
// task screen, contacts LIFECYCLE; tests/crm/automations/units.test.mjs
// checks they agree), so a picker never shows a raw value.
export const STATUS_LABELS = Object.freeze({
  quote: { draft: "Draft", sent: "Sent", viewed: "Viewed", changes_requested: "Changes asked", approved: "Approved", converted: "Booked", declined: "Declined", archived: "Archived" },
  visit: { scheduled: "Booked", en_route: "On the way", in_progress: "Working", paused: "Paused", completed: "Done", no_access: "No access", cancelled: "Cancelled" },
  job: { unscheduled: "To book", scheduled: "Booked", in_progress: "Under way", completed: "Done", cancelled: "Cancelled" },
  invoice: { draft: "Draft", open: "Open", paid: "Paid", void: "Void", uncollectible: "Written off" },
  plan: { draft: "Draft", pending: "Waiting", active: "Active", paused: "Paused", cancelling: "Ending", cancelled: "Cancelled", expired: "Ended" },
  task: { open: "Open", in_progress: "Started", waiting: "Waiting", done: "Done", cancelled: "Cancelled" },
  contact: { lead: "Lead", customer: "Customer", former_customer: "Former customer", archived: "Archived" },
});
export const statusLabel = (subject, value) => (STATUS_LABELS[subject] && STATUS_LABELS[subject][value]) || String(value || "").replace(/_/g, " ");

// type: what value the condition takes; ops: what it may say; of: whose field.
export const FIELDS = Object.freeze({
  source: { label: "Lead source", of: "contact", type: "text", ops: ["is", "is_not"] },
  tags: { label: "Tags", of: "contact", type: "tag", ops: ["has", "has_not"] },
  town: { label: "Town", of: "contact", type: "text", ops: ["is", "is_not"] },
  owner: { label: "Owner", of: "contact", type: "user", ops: ["is", "is_not", "none"] },
  lifecycle: { label: "Lead or customer", of: "contact", type: "enum", options: LIFECYCLES, ops: ["is", "is_not"] },
  service: { label: "Service", of: "record", type: "enum", options: SERVICES, ops: ["includes", "excludes"] },
  plan_type: { label: "Plan type", of: "record", type: "enum", options: PLAN_TYPES, ops: ["is", "is_not"] },
  has_plan: { label: "Has a plan", of: "contact", type: "bool", ops: ["yes", "no"] },
  amount: { label: "Amount", of: "record", type: "money", ops: ["gte", "lte"] },
  status: { label: "Status", of: "record", type: "status", ops: ["is", "is_not"] },
  replied: { label: "They replied", of: "contact", type: "bool", ops: ["yes", "no"] },
  quoted: { label: "Has a quote", of: "contact", type: "bool", ops: ["yes", "no"] },
  reviewed: { label: "Left a review", of: "contact", type: "bool", ops: ["yes", "no"] },
  weekday: { label: "Day of the week", of: "time", type: "days", ops: ["weekday", "weekend"] },
  time: { label: "Time of day", of: "time", type: "time_range", ops: ["between"] },
  date: { label: "Dates", of: "time", type: "date_range", ops: ["between"] },
});
export const OPS = Object.freeze({
  is: "is", is_not: "is not", has: "has", has_not: "doesn't have", none: "is nobody", includes: "includes", excludes: "doesn't include",
  yes: "yes", no: "no", gte: "is at least", lte: "is at most", weekday: "is a weekday", weekend: "is a weekend day", between: "is between",
});
const MD_RE = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const mdLabel = (md) => `${MONTHS[+md.slice(0, 2) - 1]} ${+md.slice(3)}`;

export function cleanCondition(c, f, { subject } = {}) {
  if (!isObj(c)) fail("Pick what to check.", f);
  const def = FIELDS[c.field];
  if (!def) fail("Pick what to check.", `${f}.field`);
  if (!def.ops.includes(c.op)) fail("Pick how to compare it.", `${f}.op`);
  const out = { field: c.field, op: c.op };
  const v = c.value;
  switch (def.type) {
    case "text": case "tag": {
      const s = squish(v).slice(0, 60);
      if (!s) fail(def.type === "tag" ? "Type the tag." : "Type what it should be.", `${f}.value`);
      out.value = s; break;
    }
    case "user":
      if (c.op !== "none") { if (!isId(v, "user")) fail("Pick a person.", `${f}.value`); out.value = v; }
      break;
    case "enum":
      if (!def.options.some((o) => o.value === v)) fail("Pick one.", `${f}.value`);
      out.value = v; break;
    case "status": {
      const allowed = STATUSES[subject] || [];
      if (!allowed.includes(v)) fail("Pick a status.", `${f}.value`);
      out.value = v; break;
    }
    case "money": {
      if (!Number.isInteger(v) || v < 0 || v > 100000000) fail("Type an amount in dollars.", `${f}.value`);
      out.value = v; break;
    }
    case "time_range":
      if (!Array.isArray(v) || v.length !== 2 || !isLocalTime(v[0]) || !isLocalTime(v[1]) || v[0] >= v[1]) fail("Pick a start and an end time.", `${f}.value`);
      out.value = [v[0], v[1]]; break;
    case "date_range":
      if (!Array.isArray(v) || v.length !== 2 || !MD_RE.test(v[0]) || !MD_RE.test(v[1])) fail("Pick a first and a last day.", `${f}.value`);
      out.value = [v[0], v[1]]; break;
    default: break;
  }
  if (def.of === "record" && def.type === "status" && !STATUSES[subject]) fail("This trigger has no status to check.", `${f}.field`);
  return out;
}

// ------------------------------------------------------------ steps

export const STEP_TYPES = Object.freeze({
  text: { label: "Send a text", mutates: false },
  email: { label: "Send an email", mutates: false },
  task: { label: "Make a task", mutates: true },
  tag_add: { label: "Add a tag", mutates: true },
  tag_remove: { label: "Remove a tag", mutates: true },
  deal_stage: { label: "Move the deal", mutates: true },
  assign_owner: { label: "Assign an owner", mutates: true },
  notify: { label: "Tell the team", mutates: false },
  cadence: { label: "Start a follow-up cadence", mutates: true },
  stop_if: { label: "Stop if", mutates: false },
});
export const DEAL_STAGES = Object.freeze([
  { value: "open", label: "Open" }, { value: "quoted", label: "Quoted" }, { value: "won", label: "Won" }, { value: "lost", label: "Lost" }, { value: "abandoned", label: "Abandoned" },
]);
// who a task or a notice is for: the contact's owner (falling back to the owners), every owner, the office, or one person
export const WHO = Object.freeze([{ value: "owner", label: "The contact's owner" }, { value: "owners", label: "The owners" }, { value: "office", label: "The office" }]);
export const WAIT_UNITS = Object.freeze({ minutes: 1, hours: 60, days: 1440 });
export const MAX_STEPS = 12;
export const MAX_CONDITIONS = 8;
export const MAX_WAIT = Object.freeze({ minutes: 1440, hours: 720, days: 365 });

const whoOf = (v, f) => {
  if (WHO.some((w) => w.value === v)) return v;
  if (isId(v, "user")) return v;
  return fail("Pick who it's for.", f);
};

const STEP_ID_RE = /^s[0-9a-z]{1,8}$/;
export function cleanStep(s, i, { subject, stepIds, taken = new Set() } = {}) {
  const f = `steps.${i}`;
  if (!isObj(s)) fail("Pick what this step does.", f);
  if (!STEP_TYPES[s.type]) fail("Pick what this step does.", `${f}.type`);
  let id = typeof s.id === "string" && STEP_ID_RE.test(s.id) && !stepIds.has(s.id) ? s.id : null;
  if (!id) { let n = 1; while (stepIds.has(`s${n}`) || taken.has(`s${n}`)) n += 1; id = `s${n}`; }
  stepIds.add(id);
  const out = { id, type: s.type };
  if (s.wait !== undefined && s.wait !== null) {
    if (!isObj(s.wait) || !WAIT_UNITS[s.wait.unit] || !Number.isInteger(s.wait.n) || s.wait.n < 0 || s.wait.n > MAX_WAIT[s.wait.unit]) fail("Type how long to wait.", `${f}.wait`);
    if (s.wait.n > 0) out.wait = { n: s.wait.n, unit: s.wait.unit };
  }
  if (s.at !== undefined && s.at !== null && s.at !== "") { if (!isLocalTime(s.at)) fail("Use a time like 10:00.", `${f}.at`); out.at = s.at; }
  if (s.business_hours === true) out.business_hours = true;
  switch (s.type) {
    case "text": case "email": {
      if (typeof s.template_key !== "string" || !/^[a-z][a-z0-9_]{1,39}$/.test(s.template_key)) fail("Pick a template.", `${f}.template_key`);
      out.template_key = s.template_key; break;
    }
    case "task": {
      out.title = squish(s.title).slice(0, 120) || fail("Name the task.", `${f}.title`);
      out.assign = whoOf(s.assign || "owner", `${f}.assign`);
      if (s.due_days !== undefined && s.due_days !== null && s.due_days !== "") {
        if (!Number.isInteger(s.due_days) || s.due_days < 0 || s.due_days > 60) fail("Due in 0 to 60 days.", `${f}.due_days`);
        out.due_days = s.due_days;
      }
      break;
    }
    case "tag_add": case "tag_remove":
      out.tag = squish(s.tag).slice(0, 40) || fail("Type the tag.", `${f}.tag`); break;
    case "deal_stage":
      if (!DEAL_STAGES.some((d) => d.value === s.stage)) fail("Pick a stage.", `${f}.stage`);
      out.stage = s.stage; break;
    case "assign_owner":
      if (!isId(s.user_id, "user")) fail("Pick a person.", `${f}.user_id`);
      out.user_id = s.user_id; break;
    case "notify":
      out.to = whoOf(s.to || "owners", `${f}.to`);
      out.message = squish(s.message).slice(0, 160) || fail("Type what to say.", `${f}.message`);
      break;
    case "cadence":
      if (typeof s.cadence_key !== "string" || !/^[a-z][a-z0-9_]{1,39}$/.test(s.cadence_key)) fail("Pick a cadence.", `${f}.cadence_key`);
      out.cadence_key = s.cadence_key; break;
    case "stop_if": {
      const list = Array.isArray(s.conditions) ? s.conditions : [];
      if (!list.length || list.length > MAX_CONDITIONS) fail("Add what to check.", `${f}.conditions`);
      out.conditions = list.map((c, k) => cleanCondition(c, `${f}.conditions.${k}`, { subject }));
      break;
    }
    default: break;
  }
  return out;
}

// ------------------------------------------------------------ the flow

export const DEFAULT_LIMITS = Object.freeze({ per_contact_days: 1 });

// A definition from the screen → the stored shape (InputError on the first problem).
export function cleanFlow(b = {}) {
  if (!isObj(b)) fail("Expected an automation.", "flow");
  const name = squish(b.name).slice(0, 80);
  if (!name) fail("Name it.", "name");
  const t = isObj(b.trigger) ? b.trigger : {};
  const def = TRIGGERS[t.type];
  if (!def) fail("Pick what starts it.", "trigger.type");
  const trigger = { type: t.type };
  if (def.option === "tag") trigger.tag = squish(t.tag).slice(0, 40) || fail("Type the tag.", "trigger.tag");
  if (def.option === "days") {
    const d = t.days === undefined || t.days === null || t.days === "" ? (t.type === "plan.renewing" ? 30 : 1) : t.days;
    if (!Number.isInteger(d) || d < 0 || d > 365) fail("Use a number of days.", "trigger.days");
    trigger.days = d;
  }
  if (def.schedule) {
    trigger.at = t.at === undefined || t.at === null || t.at === "" ? "10:00" : t.at;
    if (!isLocalTime(trigger.at)) fail("Use a time like 10:00.", "trigger.at");
    const dows = t.dows === undefined ? [1, 2, 3, 4, 5] : t.dows;
    if (!Array.isArray(dows) || !dows.length || dows.some((x) => !Number.isInteger(x) || x < 0 || x > 6)) fail("Pick at least one day.", "trigger.dows");
    trigger.dows = [...new Set(dows)].sort();
  }
  const conds = Array.isArray(b.conditions) ? b.conditions : [];
  if (conds.length > MAX_CONDITIONS) fail(`At most ${MAX_CONDITIONS} conditions.`, "conditions");
  const conditions = conds.map((c, i) => cleanCondition(c, `conditions.${i}`, { subject: def.subject }));
  if (t.type === "schedule" && !conditions.some((c) => FIELDS[c.field].of !== "time")) fail("Say who it's for (a tag, a town, a source...), so it never reaches everyone.", "conditions");
  const list = Array.isArray(b.steps) ? b.steps : [];
  if (!list.length) fail("Add at least one step.", "steps");
  if (list.length > MAX_STEPS) fail(`At most ${MAX_STEPS} steps.`, "steps");
  const stepIds = new Set();
  const taken = new Set(list.map((s) => (isObj(s) && typeof s.id === "string" && STEP_ID_RE.test(s.id) ? s.id : null)).filter(Boolean));
  const steps = list.map((s, i) => cleanStep(s, i, { subject: def.subject, stepIds, taken }));
  if (steps.every((s) => s.type === "stop_if")) fail("Add a step that does something.", "steps");
  const stops = Array.isArray(b.stop) ? b.stop : [];
  if (stops.length > MAX_CONDITIONS) fail(`At most ${MAX_CONDITIONS} stop conditions.`, "stop");
  const stop = stops.map((c, i) => cleanCondition(c, `stop.${i}`, { subject: def.subject }));
  const lim = isObj(b.limits) ? b.limits : {};
  const pcd = lim.per_contact_days === undefined || lim.per_contact_days === null || lim.per_contact_days === "" ? DEFAULT_LIMITS.per_contact_days : lim.per_contact_days;
  if (!Number.isInteger(pcd) || pcd < 0 || pcd > 3650) fail("Use a number of days (0 for no limit).", "limits.per_contact_days");
  return {
    name, enabled: b.enabled === true, trigger, conditions, steps, stop, limits: { per_contact_days: pcd },
    ...(typeof b.recipe === "string" && RECIPES.some((r) => r.key === b.recipe) ? { recipe: b.recipe } : {}),
  };
}

// ------------------------------------------------------------ plain English

const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const UNIT_WORD = { minutes: "minute", hours: "hour", days: "day" };
export const clock12 = (hhmm) => {
  const [h, m] = String(hhmm).split(":").map(Number);
  const hh = h % 12 || 12;
  return `${hh}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "AM" : "PM"}`;
};
const DOW = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
export function daysPhrase(dows) {
  const d = [...(dows || [])].sort().join(",");
  if (d === "0,1,2,3,4,5,6") return "every day";
  if (d === "1,2,3,4,5") return "on weekdays";
  if (d === "0,6") return "on weekends";
  if (d === "1,2,3,4,5,6") return "Monday to Saturday";
  return "on " + (dows || []).map((x) => DOW[x]).join(", ").replace(/, ([^,]*)$/, " and $1");
}

// labels: { templates: { key: name }, users: { id: name }, cadences: { key: name } }
export function conditionPhrase(c, labels = {}) {
  const def = FIELDS[c.field];
  if (!def) return "";
  const name = (id) => (labels.users && labels.users[id]) || "someone";
  switch (c.field) {
    case "source": return `the lead source ${OPS[c.op]} ${c.value}`;
    case "tags": return c.op === "has" ? `they're tagged ${c.value}` : `they're not tagged ${c.value}`;
    case "town": return `the town ${OPS[c.op]} ${c.value}`;
    case "owner": return c.op === "none" ? "nobody owns them" : `the owner ${OPS[c.op]} ${name(c.value)}`;
    case "lifecycle": return `they ${c.op === "is" ? "are" : "aren't"} a ${(LIFECYCLES.find((x) => x.value === c.value) || {}).label.toLowerCase()}`;
    case "service": return `the service ${OPS[c.op]} ${(SERVICES.find((x) => x.value === c.value) || {}).label.toLowerCase()}`;
    case "plan_type": return `the plan ${OPS[c.op]} ${(PLAN_TYPES.find((x) => x.value === c.value) || {}).label.toLowerCase()}`;
    case "has_plan": return c.op === "yes" ? "they have a plan" : "they have no plan";
    case "amount": return `the amount ${OPS[c.op]} $${c.value}`;
    case "status": return `${labels.subject ? `the ${labels.subject}` : "it"} ${c.op === "is" ? "is" : "isn't"} ${statusLabel(labels.subject, c.value).toLowerCase()}`;
    case "replied": return c.op === "yes" ? "they reply" : "they haven't replied";
    case "quoted": return c.op === "yes" ? "they have a quote" : "there's no quote yet";
    case "reviewed": return c.op === "yes" ? "they leave a review" : "they haven't left a review";
    case "weekday": return c.op === "weekday" ? "it's a weekday" : "it's the weekend";
    case "time": return `it's between ${clock12(c.value[0])} and ${clock12(c.value[1])}`;
    case "date": return `it's between ${mdLabel(c.value[0])} and ${mdLabel(c.value[1])}`;
    default: return "";
  }
}
const joinAnd = (list) => (list.length <= 1 ? list.join("") : list.slice(0, -1).join(", ") + " and " + list[list.length - 1]);
const joinOr = (list) => (list.length <= 1 ? list.join("") : list.slice(0, -1).join(", ") + " or " + list[list.length - 1]);

function who(v, labels) {
  if (v === "owner") return "the owner";
  if (v === "owners") return "the owners";
  if (v === "office") return "the office";
  return (labels.users && labels.users[v]) || "someone";
}

export function stepPhrase(s, labels = {}) {
  const tpl = (k) => (labels.templates && labels.templates[k]) || k;
  switch (s.type) {
    case "text": return `text the ${tpl(s.template_key)}`;
    case "email": return `email the ${tpl(s.template_key)}`;
    case "task": return `make a task for ${who(s.assign, labels)}${s.title ? ` ("${s.title}")` : ""}`;
    case "tag_add": return `tag them ${s.tag}`;
    case "tag_remove": return `remove the tag ${s.tag}`;
    case "deal_stage": return `move the deal to ${(DEAL_STAGES.find((d) => d.value === s.stage) || {}).label || s.stage}`;
    case "assign_owner": return `make ${(labels.users && labels.users[s.user_id]) || "someone"} the owner`;
    case "notify": return `tell ${who(s.to, labels)}`;
    case "cadence": return `start the ${(labels.cadences && labels.cadences[s.cadence_key]) || s.cadence_key} follow-up`;
    case "stop_if": return `stop if ${joinOr((s.conditions || []).map((c) => conditionPhrase(c, labels)))}`;
    default: return s.type;
  }
}

export function waitPhrase(s) {
  const parts = [];
  if (s.wait && s.wait.n) parts.push(plural(s.wait.n, UNIT_WORD[s.wait.unit]));
  return parts.join("");
}

// "When a quote is sent, if no reply in 3 days, text the Day 3 follow-up at
// 10 AM, then make a task for the owner. Stops when the quote is approved."
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
export function summarize(flow, labels = {}) {
  const t = flow.trigger || {};
  const def = TRIGGERS[t.type];
  if (!def) return "";
  const lab = { ...labels, subject: def.subject };
  const checked = () => ` (checked ${daysPhrase(t.dows)} at ${clock12(t.at || "10:00")})`;
  let when;
  if (t.type === "contact.tagged") when = `when someone is tagged ${t.tag || "..."}`;
  else if (t.type === "invoice.overdue") when = `when an invoice is ${plural(t.days ?? 1, "day")} overdue${checked()}`;
  else if (t.type === "plan.renewing") when = `when a plan is ${plural(t.days ?? 30, "day")} from renewal${checked()}`;
  else if (t.type === "task.due") when = `when a task is due${checked()}`;
  else when = `when ${def.phrase}`;
  const conds = (flow.conditions || []).map((c) => conditionPhrase(c, lab)).filter(Boolean);
  const intro = t.type === "schedule"
    ? `${cap(daysPhrase(t.dows))} at ${clock12(t.at || "10:00")}, for everyone where ${joinAnd(conds) || "..."}`
    : `${cap(when)}${conds.length ? ` and ${joinAnd(conds)}` : ""}`;
  const replyStop = (flow.stop || []).some((c) => c.field === "replied" && c.op === "yes");
  const otherStops = (flow.stop || []).filter((c) => !(c.field === "replied" && c.op === "yes"));
  let merged = false;
  const steps = (flow.steps || []).map((s, i) => {
    const w = waitPhrase(s);
    const act = stepPhrase(s, lab) + (s.at ? ` at ${clock12(s.at)}` : "") + (s.business_hours ? " (in business hours)" : "");
    if (w && replyStop && i === 0) { merged = true; return `if no reply in ${w}, ${act}`; }
    if (w) return i === 0 ? `after ${w}, ${act}` : `wait ${w}, then ${act}`;
    return act;
  });
  let text = `${intro}, ${steps.join(", then ")}.`.replace(/, then wait/g, ", wait");
  const stops = [...(replyStop && (!merged || (flow.steps || []).length > 1) ? ["they reply"] : []), ...otherStops.map((c) => conditionPhrase(c, lab))];
  if (stops.length) text += ` Stops when ${joinOr(stops)}.`;
  return text.replace(/\s+/g, " ");
}

// ------------------------------------------------------------ starters

// Built-in texts for the starters (Barta's voice; never "Reply STOP": the
// sender adds the opt-out footer).
export const TEMPLATES = Object.freeze([
  { key: "flow_quote_day3", name: "Day 3 follow-up", channel: "sms", category: "service", tags: ["automation"],
    body: "Hi {{first_name|there}}, it's {{sender_first_name|Alex}} with {{company_name}}. Just checking in on the quote we sent over. Any questions, or want to get on the schedule? Reply here or call {{company_phone}}." },
  { key: "flow_review_ask", name: "Review ask after a visit", channel: "sms", category: "service", tags: ["automation", "review"],
    body: "Hi {{first_name|there}}, thanks for having {{company_name}} out today! If you have a minute, a quick Google review helps our small family business a ton.\n\n{{review_link}}" },
  { key: "flow_invoice_nudge", name: "Overdue invoice nudge", channel: "sms", category: "service", tags: ["automation"],
    body: "Hi {{first_name|there}}, a friendly reminder from {{company_name}}: invoice {{invoice_number}} still has {{balance_due}} open. Questions? Call us at {{company_phone}}." },
  { key: "flow_winback", name: "Win-back for a lapsed plan", channel: "sms", category: "marketing", tags: ["automation"],
    body: "Hi {{first_name|there}}, it's {{sender_first_name|Alex}} with {{company_name}}. It's been a while! Want us back out to get your windows sparkling again? Reply here or call {{company_phone}} and we'll find a day that works." },
  { key: "flow_lights_rebook", name: "Lights season rebook", channel: "sms", category: "service", tags: ["automation", "lights"],
    body: "Hi {{first_name|there}}, it's {{sender_first_name|Alex}} with {{company_name}}! Christmas lights season is coming up. Want us to hang your lights again this year? Reply here or call {{company_phone}} and we'll save you a spot." },
]);

export const RECIPES = Object.freeze([
  {
    key: "quote_followup", label: "Quote follow-up", blurb: "Three days after a quote goes out with no reply: a text, then a task for the owner to call.",
    flow: {
      name: "Quote follow-up", trigger: { type: "quote.sent" }, conditions: [],
      steps: [
        { type: "text", template_key: "flow_quote_day3", wait: { n: 3, unit: "days" }, at: "10:00", business_hours: true },
        { type: "task", title: "Call about their quote", assign: "owner", due_days: 0 },
      ],
      stop: [{ field: "replied", op: "yes" }, { field: "status", op: "is", value: "approved" }, { field: "status", op: "is", value: "declined" }],
      limits: { per_contact_days: 1 },
    },
  },
  {
    key: "review_after_visit", label: "Review request after a visit", blurb: "Two hours after a visit is finished (in business hours), ask for a Google review, unless they already left one.",
    flow: {
      name: "Review request after a visit", trigger: { type: "visit.completed" }, conditions: [{ field: "reviewed", op: "no" }],
      steps: [{ type: "text", template_key: "flow_review_ask", wait: { n: 2, unit: "hours" }, business_hours: true }],
      stop: [{ field: "reviewed", op: "yes" }, { field: "replied", op: "yes" }],
      limits: { per_contact_days: 180 },
    },
  },
  {
    key: "overdue_invoice", label: "Overdue invoice reminder", blurb: "A week past due: a friendly text, then a task to call three days later if it's still open.",
    flow: {
      name: "Overdue invoice reminder", trigger: { type: "invoice.overdue", days: 7, at: "10:00", dows: [1, 2, 3, 4, 5] }, conditions: [],
      steps: [
        { type: "text", template_key: "flow_invoice_nudge" },
        { type: "task", title: "Call about the overdue invoice", assign: "owner", wait: { n: 3, unit: "days" }, at: "10:00" },
      ],
      stop: [{ field: "status", op: "is", value: "paid" }, { field: "status", op: "is", value: "void" }],
      limits: { per_contact_days: 14 },
    },
  },
  {
    key: "winback_plans", label: "Win-back for lapsed plans", blurb: "Sixty days after a plan is cancelled: a friendly text (marketing consent needed) and a Win-back tag.",
    flow: {
      name: "Win-back for lapsed plans", trigger: { type: "plan.cancelled" }, conditions: [],
      steps: [
        { type: "text", template_key: "flow_winback", wait: { n: 60, unit: "days" }, at: "10:00", business_hours: true },
        { type: "tag_add", tag: "Win-back" },
      ],
      stop: [{ field: "has_plan", op: "yes" }, { field: "replied", op: "yes" }],
      limits: { per_contact_days: 180 },
    },
  },
  {
    key: "lights_rebook", label: "Lights season rebook", blurb: "From mid September to mid October, weekdays at 10: past lights customers get the rebook text (more than 5 at once waits for a test send and your confirm).",
    flow: {
      name: "Lights season rebook", trigger: { type: "schedule", at: "10:00", dows: [1, 2, 3, 4, 5] },
      conditions: [{ field: "service", op: "includes", value: "lights" }, { field: "date", op: "between", value: ["09-15", "10-15"] }],
      steps: [{ type: "text", template_key: "flow_lights_rebook" }],
      stop: [{ field: "replied", op: "yes" }],
      limits: { per_contact_days: 300 },
    },
  },
]);
