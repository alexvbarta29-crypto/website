// The checklist's rules on the phone (Rotor's Technician Job Checklist, Nov
// 2026), pure so the tests walk them (tests/crm/work-field/checklist.test.mjs):
// when an item counts as done, how far along a list is ("3 of 15 done",
// "12 left"), which item is next in order (outlined) and which wait for it
// (dimmed until reached), how an answer changes an item (the same rule the
// server keeps in work/visit-actions.mjs applyAnswer), and what ticking an
// item also does (On my way, Start). No DOM, no I/O.
//
// Kinds: check (a tick), photo (photos, min to max), count (a number), text
// (a note), select (one of its options), multi (a group of ticks, done once
// `min` of them are ticked). `required` items gate Finish; every item counts
// toward "x of N done".

export const KINDS = Object.freeze([
  ["check", "Checkbox"], ["select", "Pick one"], ["count", "Number"], ["photo", "Photos"], ["multi", "Group of checkboxes"], ["text", "Notes"],
]);
export const HOOKS = Object.freeze([["", "Nothing else"], ["on_my_way", "Texts On my way"], ["start", "Starts the visit"]]);
const OPEN = ["scheduled", "en_route", "in_progress", "paused"];

const has = (v) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length);
export const itemsOf = (visit) => (visit && visit.checklist && Array.isArray(visit.checklist.items) ? visit.checklist.items : []);

// An item counts as done: its done time (or, an older copy, a value). A group is done only with its time.
export function itemDone(i) {
  if (!i) return false;
  if (i.kind === "multi") return !!i.done_at;
  return !!(i.done_at || i.done === true || has(i.value));
}

// → { total, done, left, next }: next is the index of the first required
// item not done (-1 when none), the one outlined; the items after it that
// aren't done wait for it (locked).
export function progress(items = []) {
  const done = items.filter(itemDone).length;
  const next = items.findIndex((i) => i && i.required && !itemDone(i));
  return { total: items.length, done, left: items.length - done, next };
}
export const locked = (items, idx, p = progress(items)) => p.next >= 0 && idx > p.next && !itemDone(items[idx]);

// "Complete in order • 3 of 15 done"
export const progressText = (p) => `Complete in order • ${p.done} of ${p.total} done`;
// The floating pill: "15 left", or "All done".
export const pillText = (p) => (p.left > 0 ? `${p.left} left` : "All done");

// The photos taken for an item (the visit's photos carry its key).
export const itemPhotos = (visit, key) => ((visit && visit.photos) || []).filter((p) => p && p.item === key);

// An answer as the phone sends it (PATCH /visits/:id/checklist { key, done, value? })
// applied to an item: the server's rule, so the screen never goes back on a tap.
export function applyAnswer(i, body, { at, by } = {}) {
  if (!body || !body.done) {
    const { done_at, done_by, value, done, ...rest } = i;
    return i.kind === "multi" && Array.isArray(body && body.value) && body.value.length ? { ...rest, value: [...body.value] } : rest;
  }
  if (i.kind === "multi") {
    const want = new Set(Array.isArray(body.value) ? body.value : []);
    const value = (i.options || []).filter((o) => want.has(o));
    const ok = value.length >= Math.max(1, i.min || 1);
    const { done_at, done_by, done, ...rest } = i;
    return ok ? { ...rest, value, done_at: i.done_at || at, done_by: by } : { ...rest, value };
  }
  const same = body.value === undefined || JSON.stringify(i.value) === JSON.stringify(body.value);
  if (itemDone(i) && same) return i;
  return { ...i, done_at: i.done_at && body.value === undefined ? i.done_at : at, done_by: by, ...(body.value !== undefined ? { value: body.value } : {}) };
}

// A photo for an item (on the phone, before the server has it): the item is done once it has its min.
export function photoAdded(visit, key, photo, { at, by } = {}) {
  const photos = [...((visit && visit.photos) || []), { ...photo, item: key }];
  const items = itemsOf(visit).map((i) => {
    if (i.key !== key || i.kind !== "photo" || itemDone(i)) return i;
    return photos.filter((p) => p.item === key).length >= (i.min || 1) ? { ...i, done_at: at, done_by: by, value: photo.file_id || `local-${photo.client_id || "photo"}` } : i;
  });
  return { ...visit, photos, checklist: { ...(visit.checklist || {}), items } };
}

// What ticking an item also does, for the visit as it stands: "omw" (On my
// way: texts the customer, dry run until texting is on), "start" (starts
// the visit and its timer), or null (just the tick).
export function hookStep(item, status) {
  if (!item || item.kind !== "check" || itemDone(item)) return null;
  if (item.hook === "on_my_way" && status === "scheduled") return "omw";
  if (item.hook === "start" && ["scheduled", "en_route", "paused"].includes(status)) return "start";
  return null;
}

// Who may answer: the visit's own people, while it's open (the office sees the answers).
export const canAnswer = (visit, uid, can = () => true) => !!(visit && uid && (visit.assignee_ids || []).includes(uid) && OPEN.includes(visit.status) && can("visits:work"));

// The job's visit the checklist is about: the one under way, else the next open one, else the last.
export function currentVisit(visits = []) {
  const live = visits.filter((v) => v && !["cancelled"].includes(v.status));
  return live.find((v) => ["en_route", "in_progress", "paused"].includes(v.status)) || live.find((v) => v.status === "scheduled") || live[live.length - 1] || null;
}

// Settings → Checklists: an item from the editor's fields (strings), or an error message.
export function readItem({ key, label, kind = "check", required = false, options = "", min = "", max = "", placeholder = "", hook = "" }) {
  const l = String(label || "").trim();
  if (!l) return null;
  const out = { key, label: l, kind, required: !!required };
  if (kind === "select" || kind === "multi") {
    out.options = [...new Set(String(options || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean))].slice(0, 20);
    if (!out.options.length) return { error: `"${l}" needs its choices, one a line.` };
  }
  const n = (v, d) => (String(v || "").trim() === "" ? d : Math.round(Number(v)));
  if (kind === "multi") {
    const m = n(min, 1);
    if (!Number.isFinite(m) || m < 1) return { error: `"${l}": how many boxes must be ticked?` };
    out.min = Math.min(m, out.options.length);
  }
  if (kind === "photo") {
    out.min = n(min, 1);
    out.max = n(max, 10);
    if (!(out.min >= 1 && out.min <= 20 && out.max >= out.min && out.max <= 20)) return { error: `"${l}": photos from 1 to 20, the most at least the fewest.` };
  }
  if ((kind === "count" || kind === "text") && String(placeholder || "").trim()) out.placeholder = String(placeholder).trim().slice(0, 80);
  if (kind === "check" && hook) out.hook = hook;
  return out;
}
