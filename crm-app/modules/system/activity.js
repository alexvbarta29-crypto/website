// Activity (design §9.2 "Activity", §3.8, §4.10): who did what, by day,
// from the audit feed. Filter by person and by kind of record. Tap a row
// for that record's history (who changed it and when). audit:read.

import { html, attrs, icon, sheet } from "../../core/ui.js";
import { time as fmtTime } from "../../core/format.js";
import { dayBar, nextDay, today } from "./kit.js";

const TYPE_LABEL = { user: "Team", template: "Template", pending_action: "Approval", bulk_run: "Bulk send", file: "File", cfg: "Settings", contact: "Contact", quote: "Quote", job: "Job", visit: "Visit", invoice: "Invoice", payment: "Payment", plan: "Plan" };
const ACTION_LABEL = { create: "created", update: "changed", delete: "deleted", restore: "restored", purge: "removed" };

export default {
  title: "Activity",
  async load(params, ctx) {
    const date = ctx.keep.date || today();
    const user = ctx.keep.user || "";
    const type = ctx.keep.type || "";
    const q = new URLSearchParams({ date });
    if (user) q.set("user", user);
    if (type) q.set("type", type);
    const [feed, users] = await Promise.all([ctx.api(`/audit?${q}`, { cache: false }), ctx.can("users:manage") ? ctx.api("/users").catch(() => ({ data: [] })) : { data: [] }]);
    return { date, user, type, rows: feed.data || [], users: users.data || [] };
  },
  render(s) {
    const names = Object.fromEntries(s.users.map((u) => [u.id, u.name]));
    const who = (a) => names[a] || (a === "system" || a.startsWith("system") ? "The CRM" : a === "import" ? "Import" : a === "portal" ? "A customer" : a === "office" ? "Office password" : "Someone");
    const types = [...new Set(s.rows.map((r) => r.type))].sort();
    return html`<div class="stack">
      ${dayBar(s.date)}
      ${s.users.length ? html`<div class="chips" role="group" aria-label="Person"><button type="button" class="chip" ${attrs({ "aria-pressed": String(!s.user), "data-user": "" })}>Everyone</button>${s.users.map((u) => html`<button type="button" class="chip" ${attrs({ "aria-pressed": String(s.user === u.id), "data-user": u.id })}>${u.first_name || u.name}</button>`)}</div>` : ""}
      ${types.length > 1 || s.type ? html`<div class="chips" role="group" aria-label="Kind"><button type="button" class="chip" ${attrs({ "aria-pressed": String(!s.type), "data-type": "" })}>All</button>${(s.type && !types.includes(s.type) ? [...types, s.type] : types).map((t) => html`<button type="button" class="chip" ${attrs({ "aria-pressed": String(s.type === t), "data-type": t })}>${TYPE_LABEL[t] || t}</button>`)}</div>` : ""}
      ${s.rows.length ? html`<ul class="list">${s.rows.map((r) => html`<li><div class="row" role="button" tabindex="0" ${attrs({ "data-hist": r.type !== "cfg" ? `${r.type}/${r.id}` : null })}>
        <span class="ico">${icon(r.type === "user" ? "team" : r.type === "cfg" ? "gear" : r.type === "template" ? "doc" : "clock")}</span>
        <span class="who"><span class="nm">${who(r.actor)} ${ACTION_LABEL[r.action] || r.action.replace(/_/g, " ")} ${(TYPE_LABEL[r.type] || r.type).toLowerCase()}</span><span class="sub mono">${r.id}</span></span>
        <span class="end small muted">${fmtTime(r.at)}</span>
      </div></li>`)}</ul>` : html`<div class="card empty"><div class="art">${icon("clock")}</div><h2>Nothing that day</h2><p>Every change anyone makes in the CRM shows up here.</p></div>`}
    </div>`;
  },
  events: {
    "click [data-day]": (e, el, ctx) => { ctx.keep.date = nextDay(ctx.state.date, el.getAttribute("data-day")); ctx.refresh(); },
    "click [data-user]": (e, el, ctx) => { ctx.keep.user = el.getAttribute("data-user"); ctx.refresh(); },
    "click [data-type]": (e, el, ctx) => { ctx.keep.type = el.getAttribute("data-type"); ctx.refresh(); },
    "click [data-hist]": async (e, el, ctx) => {
      const [type, id] = el.getAttribute("data-hist").split("/");
      let rows = [];
      let err = "";
      try { rows = (await ctx.api(`/records/${encodeURIComponent(type)}/${encodeURIComponent(id)}/history?limit=30`, { cache: false })).data || []; } catch (x) { err = x.message; }
      const names = Object.fromEntries(ctx.state.users.map((u) => [u.id, u.name]));
      sheet({
        title: TYPE_LABEL[type] || type,
        body: err ? html`<p class="muted">${err}</p>` : html`<ul class="list">${rows.map((h) => html`<li><div class="row"><span class="who"><span class="nm">${ACTION_LABEL[h.action] || h.action.replace(/_/g, " ")}</span><span class="sub">${names[h.actor] || h.actor}</span></span><span class="end small muted">${fmtTime(h.at)}</span></div></li>`)}</ul>`,
      });
    },
  },
};
