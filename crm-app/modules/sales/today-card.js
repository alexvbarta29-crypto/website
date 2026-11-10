// The sales card on Today (design §9.2 Today "Needs attention"): calls due
// now (and overdue), leads that need attention, and my open tasks. Links
// only; one or two small reads.

import { html, icon } from "../../core/ui.js";
import { plural } from "../../core/format.js";

export default {
  async load(ctx) {
    const [calls, mine] = await Promise.all([
      ctx.can("sales:work") ? ctx.api("/calls/summary", { cache: false }).then((r) => r.data).catch(() => null) : null,
      ctx.api("/tasks/mine", { cache: false }).then((r) => r.data || []).catch(() => null),
    ]);
    return { calls, tasks: mine };
  },
  render(s) {
    const c = s.calls;
    const tiles = [
      c && c.due ? html`<a class="tile" href="#/calls">${icon("phone")}<span>${plural(c.due, "call")} due${c.overdue ? `, ${c.overdue} late` : ""}</span><span class="n">${c.due}</span></a>` : "",
      c && c.attention ? html`<a class="tile" href="#/calls">${icon("bell")}<span>${plural(c.attention, "lead")} need${c.attention === 1 ? "s" : ""} a call</span><span class="n">${c.attention}</span></a>` : "",
      s.tasks && s.tasks.length ? html`<a class="tile" href="#/tasks">${icon("check")}<span>${plural(s.tasks.length, "task")} for you</span><span class="n">${s.tasks.length}</span></a>` : "",
    ].filter(Boolean);
    if (!tiles.length) return html``;
    return html`<div class="section-h">Needs attention</div><div class="links">${tiles}</div>`;
  },
};
