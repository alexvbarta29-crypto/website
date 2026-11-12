// The door-to-door leaderboard and canvassing report (#/knock/report;
// docs/CRM-MAP.md "Report"): doors knocked (every knock), conversations
// (someone answered), leads (pins converted) and booked, per person, per
// day or week and per area, for a chosen stretch of days.

import { html, attrs } from "../../core/ui.js";
import { dateShort, plural } from "../../core/format.js";
import { ensureStyles } from "./kit.js";

const PRESETS = [["today", "Today"], ["week", "This week"], ["last7", "Last 7 days"], ["month", "This month"], ["last30", "Last 30 days"], ["year", "This year"]];

async function load(params, ctx) {
  ensureStyles();
  const k = ctx.keep;
  const preset = k.preset || "week";
  // a preset is worked out from the server's today (the phone's date may be off)
  const q = new URLSearchParams({ ...(preset === "custom" && k.from && k.to ? { from: k.from, to: k.to } : { preset }), ...(k.group ? { group: k.group } : {}), ...(k.territory ? { territory: k.territory } : {}) });
  const [rep, terr] = await Promise.all([ctx.api("/map/report?" + q.toString(), { cache: false }), ctx.api("/map/territories").catch(() => ({ data: [] }))]);
  return { rep: rep.data, preset, territories: terr.data || [], territory: k.territory || "" };
}

const nums = (x) => html`<span class="mp-n">${x.doors}</span><span class="mp-n">${x.conversations}</span><span class="mp-n">${x.leads}</span><span class="mp-n">${x.booked}</span>`;
const headRow = (first) => html`<div class="mp-trow mp-thead" aria-hidden="true"><span>${first}</span><span class="mp-n">Doors</span><span class="mp-n">Talked</span><span class="mp-n">Leads</span><span class="mp-n">Booked</span></div>`;
const periodName = (key, group) => (group === "week" ? `Week of ${dateShort(key)}` : dateShort(key));

export default {
  title: "Door-to-door report",
  load,
  render(s, ctx) {
    const r = s.rep;
    const t = r.totals;
    const rate = t.doors ? Math.round((t.conversations / t.doors) * 100) : 0;
    return html`<div class="stack mp-report">
      <div class="chips" role="group" aria-label="Days">${PRESETS.map(([k, label]) => html`<button type="button" class="chip" ${attrs({ "data-preset": k, "aria-pressed": String(s.preset === k) })}>${label}</button>`)}</div>
      <div class="mp-filters">
        <label class="field"><span>From</span><input type="date" name="from" ${attrs({ value: r.from, max: r.today })}></label>
        <label class="field"><span>To</span><input type="date" name="to" ${attrs({ value: r.to, max: r.today })}></label>
        <label class="field"><span>By</span><select name="group">${[["day", "Day"], ["week", "Week"]].map(([v, l]) => html`<option ${attrs({ value: v, selected: r.group === v })}>${l}</option>`)}</select></label>
        ${s.territories.length ? html`<label class="field"><span>Area</span><select name="territory"><option value="">Every area</option>${s.territories.map((x) => html`<option ${attrs({ value: x.id, selected: s.territory === x.id })}>${x.name}</option>`)}</select></label>` : ""}
      </div>
      <div class="mp-tiles">
        <div class="card mp-tile"><span class="mp-big-n">${t.doors}</span><span class="muted">doors knocked</span></div>
        <div class="card mp-tile"><span class="mp-big-n">${t.conversations}</span><span class="muted">conversations (${rate}%)</span></div>
        <div class="card mp-tile"><span class="mp-big-n">${t.leads}</span><span class="muted">leads</span></div>
        <div class="card mp-tile"><span class="mp-big-n">${t.booked}</span><span class="muted">booked</span></div>
      </div>
      <div class="section-h">Leaderboard</div>
      ${r.people.length ? html`<div class="mp-table" role="table" aria-label="Leaderboard">${headRow("Person")}${r.people.map((p, i) => html`<div class="${"mp-trow" + (p.id === (ctx.user || {}).id ? " me" : "")}" role="row"><span class="mp-who"><span class="mp-rank">${i + 1}</span>${p.name}</span>${nums(p)}</div>`)}</div>` : html`<div class="card empty"><p class="muted">No doors knocked ${r.from === r.to ? "that day" : "in these days"} yet.</p></div>`}
      ${r.periods.length ? html`<div class="section-h">${r.group === "week" ? "By week" : "By day"}</div><div class="mp-table" role="table" aria-label="${r.group === "week" ? "By week" : "By day"}">${headRow(r.group === "week" ? "Week" : "Day")}${r.periods.map((p) => html`<div class="mp-trow" role="row"><span>${periodName(p.key, r.group)}</span>${nums(p)}</div>`)}</div>` : ""}
      ${r.territories.length ? html`<div class="section-h">By area</div><div class="mp-table" role="table" aria-label="By area">${headRow("Area")}${r.territories.map((x) => html`<div class="mp-trow" role="row"><span><a ${attrs({ href: "#/knock?area=" + encodeURIComponent(x.id) })}>${x.name}</a> <span class="muted small">${plural(x.pins, "door")}</span></span>${nums(x)}</div>`)}</div>` : ""}
      <p class="foot-note small muted">A door counts each time someone knocks it (a pin dropped, or Knocked again). Talked: someone answered (any type that isn't No answer or Don't knock). Leads: pins converted to a lead. Areas count the pins inside them, wherever they were dropped.</p>
    </div>`;
  },
  events: {
    "click [data-preset]": (e, b, ctx) => { ctx.keep.preset = b.dataset.preset; delete ctx.keep.group; ctx.refresh(); },
    "change [name=from], [name=to]": (e, input, ctx) => {
      const box = input.closest(".mp-report");
      const from = box.querySelector("[name=from]").value;
      const to = box.querySelector("[name=to]").value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) return;
      Object.assign(ctx.keep, { preset: "custom", from, to });
      ctx.refresh();
    },
    "change [name=group]": (e, input, ctx) => {
      if (ctx.keep.preset !== "custom") Object.assign(ctx.keep, { preset: "custom", from: ctx.state.rep.from, to: ctx.state.rep.to });
      ctx.keep.group = input.value;
      ctx.refresh();
    },
    "change [name=territory]": (e, input, ctx) => { ctx.keep.territory = input.value || ""; ctx.refresh(); },
  },
};
