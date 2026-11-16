// Settings → Services & pricing → Estimate templates (the owner, Nov 16:
// "make sure you have templates for certain types of estimates"): the
// templates New Quote offers under "Start from a template", in the order
// they show there. Each row: the name, its one line, how many options;
// the arrows move it up or down; a tap opens it (template-edit.js), where
// it is edited or archived. "New template" starts one from scratch; a
// quote's "..." saves the quote as one. Archived ones stay at the bottom
// (Show archived) and can be restored. Owners and the office
// (settings:general).

import { html, attrs, icon, toast } from "../../core/ui.js";
import { ensureStyles } from "./kit.js";

const KIND = { one_time: "One-time", plan: "Plan", lights: "Christmas lights" };

async function load(params, ctx) {
  ensureStyles();
  const r = await ctx.api("/quote-templates?archived=1", { cache: false });
  return { rows: r.data || [], showArchived: false, can: ctx.can("settings:general") };
}

export default {
  title: "Estimate templates",
  load,
  render(s) {
    const live = s.rows.filter((r) => !r.archived);
    const old = s.rows.filter((r) => r.archived);
    const row = (r, i, list) => html`<li class="qt-tpl-row">
      <a class="row" ${attrs({ href: `#/settings/estimate-templates/${encodeURIComponent(r.id)}`, "data-tpl": r.id })}><span class="who"><span class="nm">${r.name}</span><span class="sub">${r.summary || KIND[r.kind] || ""}</span><span class="sub">${KIND[r.kind] || "One-time"} · ${r.options} option${r.options === 1 ? "" : "s"}</span></span><span class="end"><span class="chev" aria-hidden="true"></span></span></a>
      ${s.can && !r.archived ? html`<span class="qt-tpl-move"><button type="button" class="btn small" ${attrs({ "data-tpl-up": r.id, disabled: i === 0, "aria-label": `Move ${r.name} up` })}>${icon("chevdown")}</button><button type="button" class="btn small" ${attrs({ "data-tpl-down": r.id, disabled: i === list.length - 1, "aria-label": `Move ${r.name} down` })}>${icon("chevdown")}</button></span>` : ""}
    </li>`;
    return html`<div class="stack qt-tpl">
      <p class="small muted">New Quote's "Start from a template" shows these, in this order. Prices come from the price book when a template is used; counts come from the customer's property when it has them.</p>
      ${live.length ? html`<ul class="list">${live.map((r, i) => row(r, i, live))}</ul>` : html`<div class="card empty"><p>No templates yet.</p></div>`}
      ${s.can ? html`<a class="btn primary block" href="#/settings/estimate-templates/new" data-tpl-new>${icon("plus")}New template</a>` : ""}
      ${old.length ? html`<button type="button" class="btn block" data-tpl-archived ${attrs({ "aria-expanded": String(s.showArchived) })}>${s.showArchived ? "Hide archived" : `Show archived (${old.length})`}</button>
        ${s.showArchived ? html`<ul class="list">${old.map((r, i) => row(r, i, old))}</ul>` : ""}` : ""}
    </div>`;
  },
  events: {
    "click [data-tpl-archived]": (e, el, ctx) => { ctx.state.showArchived = !ctx.state.showArchived; ctx.rerender(); },
    "click [data-tpl-up]": (e, el, ctx) => move(ctx, el.dataset.tplUp, -1, el),
    "click [data-tpl-down]": (e, el, ctx) => move(ctx, el.dataset.tplDown, 1, el),
  },
};

async function move(ctx, id, by, el) {
  const s = ctx.state;
  const live = s.rows.filter((r) => !r.archived);
  const i = live.findIndex((r) => r.id === id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= live.length) return;
  [live[i], live[j]] = [live[j], live[i]];
  s.rows = [...live, ...s.rows.filter((r) => r.archived)];
  ctx.rerender();
  try { await ctx.api("/quote-templates/reorder", { method: "POST", body: { ids: live.map((r) => r.id) } }); } catch (err) { toast(err.message, { bad: true }); ctx.refresh(); }
  const again = document.querySelector(`[data-tpl-${by < 0 ? "up" : "down"}="${CSS.escape(id)}"]`);
  if (again && !again.disabled) again.focus(); else if (el && el.focus) { try { el.focus(); } catch (x) { /* gone */ } }
}
