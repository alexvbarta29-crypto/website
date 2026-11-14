// Tasks (design §9.2; guide-gaps §2.11 T1-T5, Rotor's Tasks): two views under
// the section's tabs, Board | List (#/tasks?view=board|list).
//
//   Board  Open → In Progress → Waiting → Done: a stage strip with counts,
//          swiped columns; a card has the title and its priority (High red,
//          Medium orange), the customer, the due day and the people on it,
//          a red edge when overdue; Move opens the status sheet, the round ✓
//          marks it done. Done keeps the last 14 days, struck through.
//   List   two-line rows (the title; the customer · when; the priority or
//          the status) with the round ✓; an incident says how many days
//          since it was reported.
//
// The filter sheet (search is the round button): Mine or Everyone, the kind
// (calls, incidents, touch-ups, to-dos, estimate visits...), the priority,
// only overdue. A technician sees their own tasks only.

import { html, icon, attrs, toast, board, boardCard, boardMount, moveSheet, listRow, listCard, filterSheet } from "../../core/ui.js";
import { dateShort, time, plural, initials } from "../../core/format.js";
import { screenButtons } from "../../core/nav.js";
import { ensureStyles, taskKindLabel, PRIORITY, TASK_KINDS } from "./kit.js";

export const STATUSES = Object.freeze([["open", "Open"], ["in_progress", "In Progress"], ["waiting", "Waiting"], ["done", "Done"]]);
const viewOf = () => { try { return new URLSearchParams((location.hash.split("?")[1]) || "").get("view") === "list" ? "list" : "board"; } catch (e) { return "board"; } };

async function load(params, ctx) {
  ensureStyles();
  const office = ctx.can("sales:work");
  const [mine, all, done, users] = await Promise.all([
    ctx.api("/tasks/mine", { cache: false }),
    office ? ctx.api("/tasks", { cache: false }) : null,
    ctx.api("/tasks/done?days=14", { cache: false }).then((r) => r.data || []).catch(() => []),
    office && ctx.can("schedule:read") ? ctx.api("/users").then((r) => r.data || []).catch(() => []) : [],
  ]);
  const f = ctx.keep.f || { who: office ? "all" : "mine", kind: [], pr: [], late: false };
  return { office, view: viewOf(), mine: mine.data || [], all: all ? all.data || [] : [], done, users: new Map(users.map((u) => [u.id, initials(u.name)])), f, q: ctx.keep.q || "", find: !!ctx.keep.q };
}

const daysSince = (date) => {
  if (!date) return null;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
  return Math.max(0, Math.round((Date.parse(today + "T12:00:00Z") - Date.parse(date + "T12:00:00Z")) / 86400000));
};
export const overdue = (t, now = Date.now()) => t.status !== "done" && !!t.due_at && Date.parse(t.end_at || t.due_at) < now;

function when(t) {
  if (t.kind === "incident") { const n = daysSince(t.reported_on); return n === null ? "" : n === 0 ? "Reported today" : `Reported ${plural(n, "day")} ago`; }
  if (t.status === "done" && t.done_at) return `Done ${dateShort(t.done_at)}`;
  if (t.due_at) return `${overdue(t) ? "Was due " : ""}${dateShort(t.due_at)} ${time(t.due_at)}${t.end_at ? `–${time(t.end_at)}` : ""}`;
  return "No due date";
}

// The tasks a view shows (pure): the person's own or everyone's (and the recent done ones), the filter, the search.
export function shownTasks(s, now = Date.now()) {
  const f = s.f || {};
  const base = s.office && f.who !== "mine" ? s.all : s.mine;
  const me = new Set(s.mine.map((t) => t.id));
  const done = (s.done || []).filter((t) => !(s.office && f.who === "mine") || me.has(t.id) || (t.assignee_ids || []).length === 0);
  const q = String(s.q || "").toLowerCase();
  return [...base, ...done].filter((t) => (!(f.kind || []).length || f.kind.includes(t.kind)) && (!(f.pr || []).length || f.pr.includes(t.priority))
    && (!f.late || overdue(t, now)) && (!q || `${t.title} ${t.contact_name || ""}`.toLowerCase().includes(q)))
    .sort((a, b) => (a.kind === "incident" && b.kind === "incident" ? String(a.reported_on).localeCompare(String(b.reported_on)) : String(a.due_at || "9999").localeCompare(String(b.due_at || "9999"))));
}

const prioPill = (t) => (t.priority === "high" ? { label: PRIORITY.high, tone: "red" } : t.priority === "medium" ? { label: PRIORITY.medium, tone: "orange" } : null);
const doneAct = (t) => (t.status === "done" ? null : { icon: "check", label: "Done: " + t.title, data: { done: t.id } });
export const taskRow = (t) => listRow({
  title: t.title, sub: [t.contact_name, when(t)].filter(Boolean).join(" · "), tag: t.photos_n ? plural(t.photos_n, "photo") : t.kind !== "todo" ? taskKindLabel(t.kind) : null,
  pill: t.status === "done" ? "Done" : prioPill(t) || (t.status !== "open" ? (STATUSES.find(([k]) => k === t.status) || [, t.status])[1] : null),
  href: "#/tasks/" + encodeURIComponent(t.id), action: doneAct(t), edge: overdue(t) ? "red" : null,
});
export const taskCard = (t, users = new Map()) => boardCard({
  title: t.title, pill: prioPill(t), sub: [t.contact_name, taskKindLabel(t.kind)].filter(Boolean).join(" · "),
  meta: [when(t), (t.assignee_ids || []).map((id) => users.get(id)).filter(Boolean).join(" ")].filter(Boolean).join(" · "),
  href: "#/tasks/" + encodeURIComponent(t.id), edge: overdue(t) ? "red" : null, done: t.status === "done",
  move: t.status === "done" ? null : { data: { "task-move": t.id } }, action: doneAct(t),
});

async function setStatus(ctx, t, status) {
  try {
    if (ctx.state.office) {
      const g = await ctx.api(`/tasks/${encodeURIComponent(t.id)}`, { cache: false });
      await ctx.api(`/tasks/${encodeURIComponent(t.id)}`, { method: "PATCH", body: { status }, ifMatch: g.etag });
    } else await ctx.api(`/tasks/${encodeURIComponent(t.id)}`, { method: "PATCH", body: { status } });
    ctx.keep.col = status;
    toast(status === "done" ? "Done" : `Moved to ${(STATUSES.find(([k]) => k === status) || [, status])[1]}`);
    ctx.refresh();
  } catch (err) { toast(err.message || "That didn't move.", { bad: true }); }
}

async function openFilter(ctx) {
  const s = ctx.state;
  const v = await filterSheet({
    title: "Filter", values: s.f, count: (x) => shownTasks({ ...s, f: x }).length,
    groups: [
      s.office && { key: "who", label: "Whose", type: "radio", default: "all", options: [["all", "Everyone"], ["mine", "Mine"]] },
      { key: "kind", label: "Kind", type: "chips", options: TASK_KINDS.filter((k) => k.value !== "personal").map((k) => [k.value, k.label]) },
      { key: "pr", label: "Priority", type: "chips", options: [["high", "High"], ["medium", "Medium"], ["low", "Low"]] },
      { key: "late", label: "Due", type: "toggle", text: "Only overdue" },
    ],
  });
  if (!v) return;
  s.f = ctx.keep.f = v;
  ctx.rerender();
}

export default {
  title: "Tasks",
  load,
  action: (s, ctx) => (ctx.can("sales:work") ? { label: "New", run: () => ctx.go("/tasks/new") } : null),
  render(s, ctx) {
    const list = shownTasks(s);
    const search = html`<label class="${"ld-search" + (s.find ? " open" : "")}">${icon("search")}<span class="sr">Search tasks</span><input type="search" data-tq ${attrs({ value: s.q, placeholder: "Search tasks", autocomplete: "off" })}></label>`;
    if (s.view === "board") {
      return html`<div class="stack sl-tasks">${search}${board({ name: "tasks", label: "Tasks", on: (ctx && ctx.keep.col) || null, columns: STATUSES.map(([key, label]) => {
        const cards = list.filter((t) => (t.status || "open") === key);
        return { key, label, count: cards.length, empty: key === "done" ? "Nothing done in the last 14 days" : "Nothing here", cards: cards.slice(0, 120).map((t) => taskCard(t, s.users)) };
      }) })}</div>`;
    }
    const open = list.filter((t) => t.status !== "done");
    return html`<div class="stack sl-tasks">${search}
      ${listCard(open.map(taskRow), { label: "Tasks", empty: s.f.who === "mine" || !s.office ? "Nothing on your list. Tasks from calls, replies and follow-ups land here." : "No open tasks." })}
      ${list.length > open.length ? html`<h3 class="rs-label">Done in the last 14 days</h3>${listCard(list.filter((t) => t.status === "done").map(taskRow))}` : ""}
      ${s.office ? html`<p class="foot-note">${taskKindLabel("estimate_visit")}s with a start and an end show on the Schedule.</p>` : ""}
    </div>`;
  },
  mount(view, s, ctx) {
    if (s.view === "board") boardMount(view);
    const f = s.f || {};
    const on = (f.kind || []).length || (f.pr || []).length || f.late || (s.office && f.who === "mine");
    screenButtons([
      { key: "find", icon: "search", label: "Search tasks", on: s.find, expanded: s.find },
      { key: "filter", icon: "filter", label: on ? "Filter (on)" : "Filter", on: !!on },
    ], (key) => {
      if (key === "find") { s.find = !s.find || !!s.q; ctx.rerender(); if (s.find) { const i = document.querySelector("[data-tq]"); if (i) i.focus(); } return; }
      openFilter(ctx);
    });
  },
  events: {
    "input [data-tq]": (e, el, ctx) => {
      ctx.state.q = ctx.keep.q = el.value;
      clearTimeout(ctx.state.t);
      ctx.state.t = setTimeout(() => { const pos = el.selectionStart; ctx.rerender(); const i = document.querySelector("[data-tq]"); if (i) { i.focus(); try { i.setSelectionRange(pos, pos); } catch (x) { /* fine */ } } }, 150);
    },
    "click [data-task-move]": async (e, el, ctx) => {
      const t = shownTasks(ctx.state).find((x) => x.id === el.dataset.taskMove);
      if (!t) return;
      const to = await moveSheet(`Move "${t.title}"`, STATUSES.map(([key, label]) => ({ key, label })), t.status || "open");
      if (to) setStatus(ctx, t, to);
    },
    "click [data-done]": async (e, el, ctx) => {
      el.disabled = true;
      try { await ctx.api(`/tasks/${encodeURIComponent(el.dataset.done)}/done`, { method: "POST", body: {} }); toast("Done"); ctx.refresh(); }
      catch (err) { el.disabled = false; toast(err.message, { bad: true }); }
    },
  },
};
