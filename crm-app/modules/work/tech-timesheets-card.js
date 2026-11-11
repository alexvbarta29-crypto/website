// Time on the office's Today (design §9.2 Today "Approvals": timesheet weeks
// and pending time entries): how many entries wait for a decision, who has
// shifts to approve this week, and who is on the clock. Nothing when
// there's nothing to do.

import { html, icon } from "../../core/ui.js";
import { plural } from "../../core/format.js";
import { ensureStyles } from "./tech-kit.js";

export default {
  async load(ctx) {
    ensureStyles();
    const r = await ctx.api("/timesheets", { cache: false }).catch(() => null);
    return { data: r ? r.data : null };
  },
  render(s) {
    const d = s && s.data;
    if (!d) return html``;
    const pending = (d.pending || []).length;
    const toApprove = (d.weeks || []).filter((w) => w.to_approve).length;
    const onClock = (d.weeks || []).filter((w) => w.open).length;
    if (!pending && !toApprove && !onClock) return html``;
    return html`<div class="links">
      ${pending ? html`<a class="tile" href="#/timesheets">${icon("clock")}<span>${plural(pending, "time entry", "time entries")} to decide</span><span class="n">${pending}</span></a>` : ""}
      ${toApprove ? html`<a class="tile" href="#/timesheets">${icon("check")}<span>${plural(toApprove, "week")} to approve</span><span class="n">${toApprove}</span></a>` : ""}
      ${onClock ? html`<a class="tile" href="#/timesheets">${icon("time")}<span>${plural(onClock, "person", "people")} on the clock</span><span class="n">${onClock}</span></a>` : ""}
    </div>`;
  },
};
