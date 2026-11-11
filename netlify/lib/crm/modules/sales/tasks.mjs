// Sales module: tasks (design §5.2 "Task", barta-rules §8 incidents).
// To-dos, call-backs, estimate visits (tasks with a start and an end, which
// the Schedule draws), incidents (high priority, no due date, "reported N
// days ago"), touch-ups, follow-ups, personal blocks, meetings and owner
// approvals. Tasks a cadence or a listener makes have ids derived from what
// made them, so a retried listener never makes two.

import { getRecord, createRecord, updateRecord, addActivity, readIndex } from "../../../crm-store.mjs";
import { deriveId, isId } from "../../core/ids.mjs";
import { nowIso, now, localDate, addLocalDays, zonedToUtc } from "../../core/clock.mjs";
import { ExistsError, NotFoundError, InputError } from "../../core/errors.mjs";
import { OPEN_TASK, TASK_KINDS, TASK_PRIORITIES, TASK_STATUSES } from "./types.mjs";
import { W, relRecords, nameOf } from "./common.mjs";

// Creates a task once (a fixed id when `seed` is given). → the task record.
// Home's "Needs you" row: the open tasks assigned to the person asking (one index read).
export async function myOpenTasks(ctx = {}) {
  const uid = ctx.user && ctx.user.id;
  if (!uid) return 0;
  return (await readIndex("tasks/open", "")).rows.filter((r) => (r.a || []).includes(uid)).length;
}

export async function createTask(data, ctx = {}, { seed } = {}) {
  const id = data.id || (seed ? deriveId("task", seed, "sales.task", 1) : undefined);
  try {
    return (await createRecord("task", { assignee_ids: [], notes: "", ...data, ...(id ? { id } : {}) }, W(ctx))).data;
  } catch (e) {
    if (!(e instanceof ExistsError) || !id) throw e;
    const got = await getRecord("task", id);
    return got ? got.data : null;
  }
}

// An open task of this kind for the contact whose title starts the same
// way (one "Reply from …" task at a time, not one per text).
export async function openTaskLike(contactId, kind, titleStart) {
  if (!isId(contactId, "contact")) return null;
  const list = await relRecords("contact-tasks", "task", contactId, { limit: 20 });
  return list.find((t) => OPEN_TASK.includes(t.status) && t.kind === kind && String(t.title || "").startsWith(titleStart)) || null;
}

// "Tomorrow at 10:00" (local) as an ISO time.
export const tomorrowAt = (hhmm = "10:00") => zonedToUtc(addLocalDays(localDate(now()), 1), hhmm).toISOString();

// A follow-up task for a lead (after a call, a reply, a callback).
export async function followUpTask(contact, { title, kind = "follow_up", due_at, notes = "", assignee_ids = [], enrollment_id, deal_id, seed, dedupe = true } = {}, ctx = {}) {
  if (dedupe) {
    const had = await openTaskLike(contact.id, kind, title.split(":")[0]);
    if (had) return { task: had, created: false };
  }
  const task = await createTask({
    title: title.slice(0, 160), kind, priority: "medium", status: "open", contact_id: contact.id, contact_name: nameOf(contact),
    ...(due_at ? { due_at } : {}), notes: String(notes || "").slice(0, 4000), assignee_ids, ...(enrollment_id ? { enrollment_id } : {}), ...(deal_id ? { deal_id } : {}),
  }, ctx, { seed });
  if (task) await addActivity(contact.id, "task", task.id, now()).catch(() => {});
  return { task, created: true };
}

// The fields a person may set on a task.
export const TASK_EDITABLE = ["title", "kind", "priority", "status", "due_at", "end_at", "contact_id", "property_id", "job_id", "visit_id", "assignee_ids", "notes", "reported_on"];

export function cleanTaskInput(b = {}) {
  const out = {};
  for (const k of TASK_EDITABLE) if (b[k] !== undefined) out[k] = b[k] === "" ? null : b[k];
  if (out.kind !== undefined && out.kind !== null && !TASK_KINDS.includes(out.kind)) throw new InputError("Pick a kind of task.", "kind");
  if (out.priority !== undefined && out.priority !== null && !TASK_PRIORITIES.includes(out.priority)) throw new InputError("Pick low, medium or high.", "priority");
  if (out.status !== undefined && out.status !== null && !TASK_STATUSES.includes(out.status)) throw new InputError("Pick a status.", "status");
  for (const k of Object.keys(out)) if (out[k] === null) out[k] = undefined;
  return out;
}

// Done (idempotent).
export async function completeTask(id, ctx = {}) {
  if (!isId(id, "task")) throw new NotFoundError("That task isn't there.");
  const by = W(ctx).by || "system";
  return updateRecord("task", id, (t) => (t.status === "done" ? null : { ...t, status: "done", done_at: nowIso(), done_by: String(by).slice(0, 80) }), W(ctx));
}
