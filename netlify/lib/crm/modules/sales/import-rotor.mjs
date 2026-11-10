// Sales module: the Rotor import phases (design §10.1 contract, §10.2 rows
// 13-15). The framework (staging, the phase runner on the bulk lane, field
// ownership, the report) is M2c's; these phases only map rows.
//
//   row 13  pipelines (4) + stages (24)  → the seeded cadences gain
//           rotor.pipeline_id, the stage → step map and the stage names
//           (ptr/rotor/pipeline/{rid} names the cadence)
//   row 14  opportunities (980)          → collapsed per (contact, pipeline)
//           into one enrollment: every row kept in its history and
//           rotor.opportunity_ids, the live row in the most advanced stage
//           decides the step. Before cutover an imported enrollment is
//           always archived (stop_reason "imported"), so CRM cadences run
//           only on CRM enrollments; the cutover op re-opens recent ones.
//           Each row also lands in the contact's deal history; Won → the
//           deal is won, only Lost/Abandoned rows → lost/abandoned. A lead's
//           deal is the one the contacts phase made for it
//           (idForRotor("deal", "lead:{id}")); a contact Rotor no longer
//           lists gets a placeholder (row 9)
//   row 15  tasks (47)                   → tasks: kind from the name
//           (Incident:, Touch-up:, On-site quote, personal blocks, meetings)
//   row 8   a lead's follow_up_date      → a follow-up task (the contacts phase
//           leaves it to this module once the task type exists)
//
// A phase is { name, entity, after, normalize(row) → row (throws RowError),
// map(row, ctx) → { records, pointers, warnings } }. map() may read what
// earlier rows of the same run wrote (opportunities collapse that way), and
// gives the same output for the same input on a re-run, so an unchanged
// export changes nothing.

import { getRecord, readPointer } from "../../../crm-store.mjs";
import { idForRotor, isId } from "../../core/ids.mjs";
import { nowIso } from "../../core/clock.mjs";
import { RowError, placeholderContact, normalizePerson, toCents } from "../contacts/import-rotor.mjs";
import { rotorKey } from "../contacts/display.mjs";
import { SEED_CADENCES, seedCadenceId } from "./seed.mjs";
import { MAX_HISTORY, MAX_DEAL_HISTORY, OPEN_DEAL } from "./types.mjs";

const str = (v) => (v == null ? "" : String(v)).trim();
const plain = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const ROTOR_ID = /^[A-Za-z0-9_.-]{1,64}$/;
const clone = (v) => JSON.parse(JSON.stringify(v));
const iso = (v) => (v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);

function needId(row, field = "id") {
  if (!plain(row)) throw new RowError("row");
  const id = str(row[field]);
  if (!ROTOR_ID.test(id)) throw new RowError(field);
  return id;
}
function opt(row, k, max = 200) {
  const v = row[k];
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" && typeof v !== "number") throw new RowError(k);
  const s = String(v).trim();
  if (s.length > max) throw new RowError(k);
  return s;
}

// ------------------------------------------------------------ row 13: pipelines and stages

// Rotor's board name → the seeded cadence (rotor-people §5.2).
export function cadenceKeyForPipeline(name) {
  const n = str(name).toLowerCase().replace(/\s+/g, " ");
  if (/^new lead/.test(n)) return "new_lead";
  if (/^received estimate|^estimate/.test(n)) return "estimate_followup";
  if (/^giveaway/.test(n)) return "giveaway";
  if (/^referral/.test(n)) return "referrals";
  return null;
}

// Which step a stage stands for, by its position on the board.
//   new_lead           0-8 → steps 1-9, 9 "Send Estimate" → step 10
//   estimate_followup  0-4 → steps 1-5, 5 "Wait 3 Days" and 6 "Archive" → 5,
//                      7 "Approved - waiting to schedule" → 0 (done)
//   boards             0 (no steps)
export function stepForStage(key, position, steps = 0) {
  const p = Number(position);
  if (!Number.isInteger(p) || p < 0) return 0;
  if (key === "new_lead") return Math.min(p + 1, 10);
  if (key === "estimate_followup") return p >= 7 ? 0 : Math.min(p + 1, 5);
  if (!steps) return 0;
  return Math.min(p + 1, steps);
}

export function normalizePipeline(row) {
  return { id: needId(row), name: opt(row, "name", 120) || "", position: Number.isInteger(row.position) ? row.position : null };
}
export function normalizeStage(row) {
  return { id: needId(row), pipeline_id: needId(row, "pipeline_id"), name: opt(row, "name", 120) || "", position: Number.isInteger(row.position) ? row.position : null };
}

// The cadence a pipeline maps to: the one the pointer names, else the seeded
// one for its name (written now if the seed hasn't run yet).
async function cadenceFor(pipelineId, name) {
  const p = await readPointer("rotor/pipeline", rotorKey(pipelineId)).catch(() => null);
  if (p && isId(p.id, "cadence")) {
    const g = await getRecord("cadence", p.id);
    if (g) return g.data;
  }
  const key = cadenceKeyForPipeline(name);
  if (!key) return null;
  const id = seedCadenceId(key);
  const g = await getRecord("cadence", id);
  if (g) return g.data;
  const seed = SEED_CADENCES.find((c) => c.key === key);
  return seed ? { ...clone(seed), id } : null;
}

async function mapPipeline(r) {
  const cadence = await cadenceFor(r.id, r.name);
  if (!cadence) return { warnings: ["pipeline_unknown"] };
  const rotor = { ...(cadence.rotor || {}), pipeline_id: r.id, name: r.name, ...(r.position !== null ? { position: r.position } : {}) };
  return {
    records: [{ type: "cadence", data: { ...strip(cadence), rotor } }],
    pointers: [{ kind: "rotor/pipeline", key: rotorKey(r.id), value: { id: cadence.id } }],
    warnings: [],
  };
}

async function mapStage(r) {
  const p = await readPointer("rotor/pipeline", rotorKey(r.pipeline_id)).catch(() => null);
  if (!p || !isId(p.id, "cadence")) return { warnings: ["stage_pipeline_unknown"] };
  const g = await getRecord("cadence", p.id);
  if (!g) return { warnings: ["stage_pipeline_unknown"] };
  const cadence = g.data;
  const n = stepForStage(cadence.key, r.position, (cadence.steps || []).length);
  const rotor = {
    ...(cadence.rotor || {}),
    stage_ids: { ...((cadence.rotor && cadence.rotor.stage_ids) || {}), [r.id]: n },
    stage_names: { ...((cadence.rotor && cadence.rotor.stage_names) || {}), [r.id]: r.name },
    ...(r.position !== null ? { stage_positions: { ...((cadence.rotor && cadence.rotor.stage_positions) || {}), [r.id]: r.position } } : {}),
  };
  return { records: [{ type: "cadence", data: { ...strip(cadence), rotor } }], warnings: [] };
}

const strip = (r) => { const { _w, ...rest } = r; return rest; };

// ------------------------------------------------------------ row 14: opportunities

const OPP_STATUS = new Set(["Open", "Won", "Lost", "Abandoned"]);

export function normalizeOpportunity(row) {
  const id = needId(row);
  const contactType = str(row.contact_type).toLowerCase();
  if (!["lead", "customer"].includes(contactType)) throw new RowError("contact_type");
  const status = str(row.status);
  if (!OPP_STATUS.has(status)) throw new RowError("status");
  if (row.assigned_to !== undefined && row.assigned_to !== null && !Array.isArray(row.assigned_to)) throw new RowError("assigned_to");
  return {
    id, name: opt(row, "name", 160) || "", pipeline_id: needId(row, "pipeline_id"), stage_id: needId(row, "stage_id"), status,
    value: row.value === null || row.value === undefined ? null : row.value, assigned_to: (row.assigned_to || []).map(str).filter(Boolean),
    contact_id: needId(row, "contact_id"), contact_type: contactType, archived: row.archived === true, created_at: opt(row, "created_at", 40),
  };
}

async function lookupContact(ctx, type, rid) {
  if (ctx && typeof ctx.lookup === "function") {
    const id = await ctx.lookup(type, rid);
    if (id) return id;
  }
  const p = await readPointer(`rotor/${type}`, rotorKey(rid)).catch(() => null);
  return p && isId(p.id, "contact") ? p.id : null;
}

// The live row in the most advanced stage decides; with none live, the newest.
export function decide(history) {
  const live = history.filter((h) => !h.archived);
  const pool = live.length ? live : history;
  return [...pool].sort((a, b) => (b.position ?? -1) - (a.position ?? -1) || String(b.at).localeCompare(String(a.at)))[0] || null;
}

// The deal's status from every opportunity it has seen (pure).
export function dealStatusFrom(rows, current = "open") {
  if (rows.some((r) => r.status_raw === "Won")) return "won";
  if (rows.some((r) => r.status_raw === "Open" && !r.archived)) return OPEN_DEAL.includes(current) ? current : "open";
  if (rows.some((r) => r.status_raw === "Lost")) return "lost";
  if (rows.some((r) => r.status_raw === "Abandoned")) return "abandoned";
  return OPEN_DEAL.includes(current) ? current : "open";
}

async function mapOpportunity(r, ctx) {
  const warnings = [];
  const out = { records: [], pointers: [], warnings };
  const p = await readPointer("rotor/pipeline", rotorKey(r.pipeline_id)).catch(() => null);
  const cg = p && isId(p.id, "cadence") ? await getRecord("cadence", p.id) : null;
  if (!cg) return { warnings: ["opportunity_pipeline_unknown"] };
  const cadence = cg.data;
  const rr = cadence.rotor || {};
  const position = rr.stage_positions && Number.isInteger(rr.stage_positions[r.stage_id]) ? rr.stage_positions[r.stage_id] : null;
  const n = rr.stage_ids && Number.isInteger(rr.stage_ids[r.stage_id]) ? rr.stage_ids[r.stage_id] : 0;
  const stage = (rr.stage_names && rr.stage_names[r.stage_id]) || "";
  if (!stage) warnings.push("opportunity_stage_unknown");

  // the contact (resolved through the pointers; a contact Rotor no longer lists gets a placeholder)
  let contactId = await lookupContact(ctx, r.contact_type, r.contact_id);
  if (!contactId) {
    const ph = placeholderContact(r.contact_id, { name: r.name, kind: r.contact_type });
    out.records.push(ph);
    out.pointers.push({ kind: `rotor/${r.contact_type}`, key: rotorKey(r.contact_id), value: { id: ph.data.id } });
    contactId = ph.data.id;
    warnings.push("opportunity_placeholder_contact");
  }
  const at = iso(r.created_at) || "2026-01-01T00:00:00.000Z";

  // the deal: the lead's (the contacts phase made it), or the customer's
  const dealId = idForRotor("deal", `${r.contact_type}:${r.contact_id}`);
  const dg = await getRecord("deal", dealId);
  const base = dg ? strip(dg.data) : {
    id: dealId, contact_id: contactId, services: [], status: "open", quote_ids: [], job_ids: [], plan_ids: [], history: [], opened_at: at,
    rotor: r.contact_type === "lead" ? { lead_id: r.contact_id } : { customer_id: r.contact_id },
  };
  const dealHist = [...(base.history || []).filter((h) => h.opportunity_id !== r.id), {
    at, kind: "rotor_opportunity", pipeline: rr.name || cadence.name, stage, status_raw: r.status, opportunity_id: r.id, ...(r.archived ? { archived: true } : {}),
  }].sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(-MAX_DEAL_HISTORY);
  const status = dealStatusFrom(dealHist, base.status);
  const deal = {
    ...base, contact_id: base.contact_id || contactId, history: dealHist, status,
    rotor: { ...(base.rotor || {}), opportunity_ids: [...new Set([...((base.rotor && base.rotor.opportunity_ids) || []), r.id])].sort() },
    ...(base.value_cents === undefined && r.value !== null && toCents(r.value) !== null && toCents(r.value) > 0 ? { value_cents: toCents(r.value) } : {}),
    ...(base.opened_at && base.opened_at <= at ? {} : { opened_at: at }),
  };
  if (status === "won" && !deal.won_at) deal.won_at = (dealHist.find((h) => h.status_raw === "Won") || {}).at || at;
  if (status === "lost") { deal.lost_reason = deal.lost_reason || "no_response"; if (!deal.lost_at) deal.lost_at = at; }
  if (status === "abandoned" && !deal.abandoned_at) deal.abandoned_at = at;
  out.records.push({ type: "deal", data: deal });

  // the enrollment: one per (contact, board)
  const enrollmentId = idForRotor("enrollment", `${contactId}:${r.pipeline_id}`);
  const eg = await getRecord("enrollment", enrollmentId);
  const prev = eg ? strip(eg.data) : null;
  const users = (ctx && ctx.users) || new Map();
  const owner = r.assigned_to.map((u) => users.get(u)).find((u) => isId(u, "user"));
  const history = [...((prev && prev.history) || []).filter((h) => h.opportunity_id !== r.id), {
    n, at, action: "rotor_stage", stage, stage_id: r.stage_id, status_raw: r.status, opportunity_id: r.id, by: "import",
    ...(position !== null ? { position } : {}), ...(r.archived ? { archived: true } : {}),
  }].sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(-MAX_HISTORY);
  const best = decide(history) || history[history.length - 1];
  const enrollment = {
    ...(prev || {}), id: enrollmentId, contact_id: contactId, cadence_id: cadence.id, cadence_key: cadence.key, deal_id: dealId,
    status: "archived", stop_reason: "imported", step_n: best.n || 0, history,
    started_at: history[0].at, ended_at: history[history.length - 1].at,
    cur: { label: best.stage || "", action: null, rbs: false },
    ...(owner ? { owner_id: owner } : {}),
    rotor: {
      opportunity_ids: [...new Set(history.map((h) => h.opportunity_id))].sort(), pipeline_id: r.pipeline_id, stage_id: best.stage_id,
      status_raw: best.status_raw, ...(best.archived ? {} : { live_since: best.at }),
    },
  };
  delete enrollment.next_due_at; delete enrollment.due_end; delete enrollment.pending;
  out.records.push({ type: "enrollment", data: enrollment });
  out.pointers.push({ kind: "rotor/opportunity", key: rotorKey(r.id), value: { id: enrollmentId } });
  return out;
}

// ------------------------------------------------------------ row 15: tasks

const TASK_STATUS = { open: "open", in_progress: "in_progress", waiting: "waiting", done: "done" };

// The kind of a Rotor task from its name and links (rotor-people §6.2).
export function taskKind(name, { contact = false, assignees = 0 } = {}) {
  const n = str(name);
  if (/^incident\b/i.test(n)) return "incident";
  if (/^touch[- ]?up\b/i.test(n)) return "touch_up";
  if (/on[- ]?site quote|estimate visit/i.test(n)) return "estimate_visit";
  if (/\bmeeting\b/i.test(n)) return "meeting";
  if (!contact && (/\b(gone|off|out|vacation|wknd|weekend|away)\b/i.test(n) || (assignees === 0 && n === n.toUpperCase() && /[A-Z]/.test(n)))) return "personal";
  if (/^call\b|call back|callback/i.test(n)) return "call";
  return "todo";
}
// "Reported: 2026-11-02" in the notes → the incident's reported date.
export function reportedOn(notes) {
  const m = /Reported:\s*(\d{4}-\d{2}-\d{2})/i.exec(String(notes || ""));
  return m ? m[1] : null;
}

export function normalizeTask(row) {
  const id = needId(row);
  const name = opt(row, "name", 400);
  if (!name) throw new RowError("name");
  const status = str(row.status || "open");
  if (!TASK_STATUS[status]) throw new RowError("status");
  const priority = str(row.priority || "medium");
  if (!["low", "medium", "high"].includes(priority)) throw new RowError("priority");
  if (row.assigned_to !== undefined && row.assigned_to !== null && !Array.isArray(row.assigned_to)) throw new RowError("assigned_to");
  const ct = row.contact_type ? str(row.contact_type).toLowerCase() : null;
  if (ct && !["lead", "customer"].includes(ct)) throw new RowError("contact_type");
  return {
    id, name, status, priority, notes: row.notes == null ? "" : String(row.notes).slice(0, 4000), due_date: opt(row, "due_date", 40), end_date: opt(row, "end_date", 40),
    contact_id: row.contact_id ? needId(row, "contact_id") : null, contact_type: ct, assigned_to: (row.assigned_to || []).map(str).filter(Boolean),
    user_id: opt(row, "user_id", 64), created_at: opt(row, "created_at", 40),
  };
}

async function mapTask(r, ctx) {
  const warnings = [];
  const out = { records: [], pointers: [], warnings };
  const users = (ctx && ctx.users) || new Map();
  const assignees = r.assigned_to.map((u) => users.get(u)).filter((u) => isId(u, "user"));
  if (assignees.length < r.assigned_to.length) warnings.push("task_assignee_unknown");
  let contactId = null;
  if (r.contact_id && r.contact_type) {
    contactId = await lookupContact(ctx, r.contact_type, r.contact_id);
    if (!contactId) {
      const ph = placeholderContact(r.contact_id, { kind: r.contact_type });
      out.records.push(ph);
      out.pointers.push({ kind: `rotor/${r.contact_type}`, key: rotorKey(r.contact_id), value: { id: ph.data.id } });
      contactId = ph.data.id;
      warnings.push("task_placeholder_contact");
    }
  }
  const kind = taskKind(r.name, { contact: !!contactId, assignees: r.assigned_to.length });
  const due = iso(r.due_date);
  const end = iso(r.end_date);
  const done = r.status === "done";
  const id = idForRotor("task", r.id);
  const data = {
    id, title: r.name.slice(0, 160), kind, priority: kind === "incident" ? "high" : r.priority, status: TASK_STATUS[r.status],
    ...(due ? { due_at: due } : {}),
    // end_date is the calendar end when there is a due date, and the completion time of a done task without one
    ...(end && due && Date.parse(end) >= Date.parse(due) ? { end_at: end } : {}),
    ...(done ? { done_at: end || iso(r.created_at) || nowIso(), done_by: "import" } : {}),
    ...(contactId ? { contact_id: contactId } : {}), assignee_ids: assignees, notes: r.notes,
    ...(kind === "incident" ? { reported_on: reportedOn(r.notes) || (iso(r.created_at) || nowIso()).slice(0, 10) } : {}),
    rotor: { task_id: r.id, ...(r.user_id ? { creator_id: r.user_id } : {}) },
    ...(iso(r.created_at) ? { created_at: iso(r.created_at) } : {}),
  };
  if (data.reported_on && !/^\d{4}-\d{2}-\d{2}$/.test(data.reported_on)) delete data.reported_on;
  out.records.push({ type: "task", data });
  out.pointers.push({ kind: "rotor/task", key: rotorKey(r.id), value: { id } });
  return out;
}

// ------------------------------------------------------------ row 8: a lead's follow-up date

async function mapLeadFollowUp(r, ctx) {
  const due = iso(r.follow_up_date);
  if (!due) return { warnings: [] };
  const contactId = await lookupContact(ctx, "lead", r.id);
  if (!contactId) return { warnings: ["follow_up_no_contact"] };
  const users = (ctx && ctx.users) || new Map();
  const owner = (r.assigned_to || []).map((u) => users.get(u)).find((u) => isId(u, "user"));
  const id = idForRotor("task", `followup:${r.id}`);
  return {
    records: [{ type: "task", data: { id, title: "Follow up (Rotor follow-up date)", kind: "follow_up", priority: "medium", status: "open", due_at: due, contact_id: contactId, assignee_ids: owner ? [owner] : [], notes: "", rotor: { lead_id: r.id } } }],
    warnings: [],
  };
}

// ------------------------------------------------------------ the phases

export const phases = [
  { name: "sales.pipelines", entity: "pipelines", after: ["system.users"], normalize: normalizePipeline, map: mapPipeline },
  { name: "sales.pipeline_stages", entity: "pipeline_stages", after: ["sales.pipelines"], normalize: normalizeStage, map: mapStage },
  { name: "sales.opportunities", entity: "opportunities", after: ["contacts.leads", "sales.pipeline_stages"], normalize: normalizeOpportunity, map: mapOpportunity },
  { name: "sales.tasks", entity: "tasks", after: ["contacts.leads"], normalize: normalizeTask, map: mapTask },
  { name: "sales.lead_follow_ups", entity: "leads", after: ["contacts.leads"], normalize: normalizePerson, map: mapLeadFollowUp },
];
