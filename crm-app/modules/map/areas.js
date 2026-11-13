// Areas (#/knock/areas; docs/CRM-MAP.md "Territories"): every drawn area,
// who knocks it and this month's doors in it. Owners and the office
// (canvass:manage) rename, recolor, reassign or delete one; drawing a new
// one happens on the map (Door to door → More → Draw an area).

import { html, attrs, sheet, toast, confirmSheet } from "../../core/ui.js";
import { field, readForm, showError, clearErrors, busy } from "../../core/forms.js";
import { plural } from "../../core/format.js";
import { ensureStyles, swatch, deviceToday } from "./kit.js";

const COLORS = ["#2563eb", "#db3a29", "#13a165", "#b7791f", "#7c4dff", "#0f766e", "#be185d"];

async function load(params, ctx) {
  ensureStyles();
  const t = deviceToday();
  const [terr, rep, start] = await Promise.all([
    ctx.api("/map/territories", { cache: false }),
    ctx.api(`/map/report?from=${t.slice(0, 8)}01&to=${t}&group=week`, { cache: false }).catch(() => null),
    ctx.can("canvass:manage") ? ctx.api("/map/knock").catch(() => null) : null,
  ]);
  const counts = new Map(((rep && rep.data && rep.data.territories) || []).map((x) => [x.id, x]));
  return { areas: terr.data || [], counts, people: (start && start.data && start.data.people) || [], manage: ctx.can("canvass:manage") };
}

function editSheet(ctx, a, people) {
  const s = sheet({
    title: a.name,
    body: html`<form data-edit>
      ${field({ label: "Name", name: "name", value: a.name, maxlength: "60" })}
      <fieldset class="mp-colors"><legend>Color</legend>${[...new Set([a.color, ...COLORS])].map((c) => html`<label class="mp-color"><input ${attrs({ type: "radio", name: "color", value: c, checked: c === a.color })}><span style="${"background:" + c}" aria-hidden="true"></span><span class="sr">${c}</span></label>`)}</fieldset>
      ${people.length ? html`<div class="section-h">Who knocks it</div>${people.map((u) => html`<label class="check"><input ${attrs({ type: "checkbox", name: "p_" + u.id, checked: (a.assignee_ids || []).includes(u.id) })}><span>${u.name}</span></label>`)}` : ""}
      <p class="form-err" data-form-err hidden></p>
      <div class="btn-row"><button type="button" class="btn danger" data-del>Delete the area</button><button type="submit" class="btn primary">Save</button></div>
    </form>`,
    events: {
      "submit [data-edit]": async (e, form) => {
        e.preventDefault();
        clearErrors(form);
        const v = readForm(form);
        const btn = form.querySelector("[type=submit]");
        busy(btn, true);
        try {
          const cur = await ctx.api(`/map/territories/${encodeURIComponent(a.id)}`, { cache: false });
          await ctx.api(`/map/territories/${encodeURIComponent(a.id)}`, { method: "PATCH", ifMatch: cur.etag, body: { name: v.name, color: v.color, assignee_ids: people.filter((u) => v["p_" + u.id]).map((u) => u.id) } });
          toast("Area saved");
          s.close();
          ctx.refresh();
        } catch (err) { busy(btn, false); showError(form, err); }
      },
      "click [data-del]": async () => {
        if (!(await confirmSheet(`Delete ${a.name}? Its pins stay on the map.`, { title: "Delete the area?", yes: "Delete", danger: true }))) return;
        try { await ctx.api(`/map/territories/${encodeURIComponent(a.id)}`, { method: "DELETE" }); toast("Area deleted"); s.close(); ctx.refresh(); }
        catch (err) { toast(err.message, { bad: true }); }
      },
    },
  });
}

export default {
  title: "Areas",
  load,
  render(s) {
    return html`<div class="stack">
      ${s.areas.length ? html`<ul class="list">${s.areas.map((a) => {
        const c = s.counts.get(a.id);
        return html`<li class="mp-area-row">
          <a class="row" ${attrs({ href: "#/knock?area=" + encodeURIComponent(a.id) })}>${swatch(a.color)}<span class="who"><span class="nm">${a.name}${a.mine ? html` <span class="pill blue">Yours</span>` : ""}</span><span class="sub">${a.assignees.length ? a.assignees.join(", ") : "Nobody assigned"} · ${plural((c && c.doors) || 0, "door")} this month</span></span></a>
          ${s.manage ? html`<button type="button" class="btn small" ${attrs({ "data-edit": a.id, "aria-label": "Edit " + a.name })}>Edit</button>` : ""}
        </li>`;
      })}</ul>` : html`<div class="card empty"><h2>No areas yet</h2><p class="muted">${s.manage ? "Draw one on the map: Door to door → More → Draw an area." : "An owner draws them on the map and assigns them."}</p></div>`}
      ${s.manage ? html`<div class="btn-row"><a class="btn primary" href="#/knock?draw=1">Draw an area on the map</a></div>` : ""}
    </div>`;
  },
  events: {
    "click [data-edit]": (e, b, ctx) => { const a = ctx.state.areas.find((x) => x.id === b.dataset.edit); if (a) editSheet(ctx, a, ctx.state.people); },
  },
};
