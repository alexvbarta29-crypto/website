// Tasks (design §9.2): tabs Mine · All · Incidents (with "reported N days
// ago") · Touch-ups · Estimate visits. The round button marks one done. A
// technician sees their own tasks only.

import { html, icon, attrs, toast } from "../../core/ui.js";
import { dateShort, time, plural } from "../../core/format.js";
import { ensureStyles, emptyCard, taskKindLabel, PRIORITY } from "./kit.js";

const TABS = [["mine", "Mine"], ["all", "All"], ["incident", "Incidents"], ["touch_up", "Touch-ups"], ["estimate_visit", "Estimate visits"]];

async function load(params, ctx) {
  ensureStyles();
  const office = ctx.can("sales:work");
  const tab = office ? ctx.keep.tab || "mine" : "mine";
  const [mine, all] = await Promise.all([
    ctx.api("/tasks/mine", { cache: false }),
    office ? ctx.api("/tasks", { cache: false }) : null,
  ]);
  return { office, tab, mine: mine.data || [], all: all ? all.data || [] : [] };
}

const daysSince = (date) => {
  if (!date) return null;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
  return Math.max(0, Math.round((Date.parse(today + "T12:00:00Z") - Date.parse(date + "T12:00:00Z")) / 86400000));
};

function when(t) {
  if (t.kind === "incident") { const n = daysSince(t.reported_on); return n === null ? "" : n === 0 ? "Reported today" : `Reported ${plural(n, "day")} ago`; }
  if (t.due_at) {
    const late = Date.parse(t.end_at || t.due_at) < Date.now();
    return `${late ? "Was due " : ""}${dateShort(t.due_at)} ${time(t.due_at)}${t.end_at ? `–${time(t.end_at)}` : ""}`;
  }
  return "No due date";
}

function rows(list) {
  return html`<ul class="list">${list.map((t) => html`<li class="sl-task">
    <a class="row" href="${"#/tasks/" + encodeURIComponent(t.id)}">
      <span class="${"ico" + (t.priority === "high" ? " coral" : "")}">${icon(t.kind === "incident" ? "shield" : t.kind === "estimate_visit" ? "schedule" : t.kind === "call" ? "phone" : "check")}</span>
      <span class="who"><span class="nm">${t.title}</span><span class="sub">${[t.contact_name, when(t)].filter(Boolean).join(" · ")}</span></span>
      <span class="end">${t.priority === "high" ? html`<span class="pill red">${PRIORITY.high}</span>` : ""}</span>
    </a>
    <button type="button" class="sl-done" ${attrs({ "data-done": t.id, "aria-label": "Done: " + t.title })}>${icon("check")}</button>
  </li>`)}</ul>`;
}

export default {
  title: "Tasks",
  load,
  action: (s, ctx) => (ctx.can("sales:work") ? { label: "New", run: () => ctx.go("/tasks/new") } : null),
  render(s) {
    const list = s.tab === "mine" ? s.mine : s.tab === "all" ? s.all : s.all.filter((t) => t.kind === s.tab);
    const sorted = [...list].sort((a, b) => (a.kind === "incident" && b.kind === "incident" ? String(a.reported_on).localeCompare(String(b.reported_on)) : String(a.due_at || "9999").localeCompare(String(b.due_at || "9999"))));
    return html`<div class="stack">
      ${s.office ? html`<div class="chips" role="tablist">${TABS.map(([k, label]) => html`<button type="button" class="chip" role="tab" ${attrs({ "data-tab": k, "aria-pressed": String(s.tab === k) })}>${label} <span class="n">${k === "mine" ? s.mine.length : k === "all" ? s.all.length : s.all.filter((t) => t.kind === k).length}</span></button>`)}</div>` : ""}
      ${sorted.length ? rows(sorted) : emptyCard(s.tab === "mine" ? "Nothing on your list" : "No tasks here", s.tab === "incident" ? "Incidents you add show here with how many days since they were reported." : "Tasks from calls, replies and follow-ups land here.", "check")}
      ${s.office ? html`<p class="foot-note">${taskKindLabel("estimate_visit")}s with a start and an end show on the Schedule once it moves into the CRM.</p>` : ""}
    </div>`;
  },
  events: {
    "click [data-tab]": (e, el, ctx) => { ctx.state.tab = ctx.keep.tab = el.dataset.tab; ctx.rerender(); },
    "click [data-done]": async (e, el, ctx) => {
      el.disabled = true;
      try { await ctx.api(`/tasks/${encodeURIComponent(el.dataset.done)}/done`, { method: "POST", body: {} }); toast("Done"); ctx.refresh(); }
      catch (err) { el.disabled = false; toast(err.message, { bad: true }); }
    },
  },
};
