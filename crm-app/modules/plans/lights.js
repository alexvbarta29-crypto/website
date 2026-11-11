// Lights season (design §9.2 "Lights season", D30): the season's installs
// by status (sold → install booked → installed → takedown booked → taken
// down → stored), the feet of lights and the bins. Tap a row for its sheet:
// open the install or takedown job to book it, enter the bin (the crew
// writes it on the bin at takedown), add a warranty visit.

import { html, attrs, icon, sheet, toast } from "../../core/ui.js";
import { busy, readForm, showError } from "../../core/forms.js";
import { ensureStyles, SEASON, SEASON_ORDER, emptyCard } from "./kit.js";

const thisSeason = () => { const d = new Date(); const y = d.getFullYear(); return d.getMonth() >= 6 ? y : y - 1; };

async function load(params, ctx) {
  ensureStyles();
  const season = /^\d{4}$/.test(String(params.season || "")) ? Number(params.season) : thisSeason();
  const r = await ctx.api(`/lights/seasons/${season}`, { cache: false });
  return { ...r.data, season };
}

export default {
  title: (s) => (s && s.season ? `Lights ${s.season}` : "Lights season"),
  load,
  render(s) {
    const groups = SEASON_ORDER.filter((st) => (s.counts || {})[st]);
    return html`<div class="stack pl-board">
      <div class="chips">${[s.season - 1, s.season, s.season + 1].map((y) => html`<a class="chip" ${attrs({ href: `#/lights/${y}`, "aria-pressed": String(y === s.season) })}>${y}</a>`)}</div>
      <div class="pl-cols">
        <div class="stat"><b>${s.rows.filter((r) => r.status !== "cancelled").length}</b><small>houses</small></div>
        <div class="stat"><b>${s.footage_ft.toLocaleString("en-US")}</b><small>feet</small></div>
        <div class="stat"><b>${s.needs_bin}</b><small>need a bin</small></div>
      </div>
      ${(s.to_confirm || []).length ? html`<div class="section-h">Waiting for a yes · ${s.to_confirm.length}</div>
        <p class="small muted">Last season's plan customers. Their ${s.season} install is made once they confirm (they get a text in September).</p>
        <ul class="list">${s.to_confirm.map((r) => html`<li><a class="row" href="${"#/plans/" + encodeURIComponent(r.plan_id)}"><span class="ico">${icon("gift")}</span><span class="who"><span class="nm">${r.contact_name || "No name"}</span><span class="sub">${[r.town, r.plan_name].filter(Boolean).join(" · ")}</span></span><span class="chev" aria-hidden="true"></span></a></li>`)}</ul>` : ""}
      ${groups.length ? groups.map((st) => html`<div class="section-h">${SEASON[st]} · ${s.counts[st]}</div><ul class="list">${s.rows.filter((r) => r.status === st).map((r) => html`<li><button type="button" class="row" ${attrs({ "data-season": r.id })}><span class="ico">${icon("gift")}</span><span class="who"><span class="nm">${r.contact_name || "No name"}</span><span class="sub">${[r.town, r.footage_ft ? `${r.footage_ft} ft` : "", r.bin_id ? `bin ${r.bin_id}` : "", r.three_year ? "3-year" : ""].filter(Boolean).join(" · ")}</span></span><span class="chev" aria-hidden="true"></span></button></li>`)}</ul>`)
        : (s.to_confirm || []).length ? "" : emptyCard("No lights this season", "Lights quotes that are approved land here with their install and takedown.")}
    </div>`;
  },
  events: {
    "click [data-season]": (e, el, ctx) => seasonSheet(ctx.state.rows.find((r) => r.id === el.dataset.season), ctx),
  },
};

function seasonSheet(r, ctx) {
  if (!r) return;
  const can = ctx.can("plans:write");
  const sh = sheet({
    title: r.contact_name || "Lights",
    body: html`<div class="stack">
      <p><span class="pill">${SEASON[r.status] || r.status}</span></p>
      <div class="btn-row" style="margin-top:0">
        ${r.install_job_id ? html`<a class="btn" ${attrs({ href: `#/jobs/${encodeURIComponent(r.install_job_id)}` })}>${icon("schedule")}Install job</a>` : ""}
        ${r.takedown_job_id ? html`<a class="btn" ${attrs({ href: `#/jobs/${encodeURIComponent(r.takedown_job_id)}` })}>${icon("schedule")}Takedown job</a>` : ""}
        ${r.plan_id ? html`<a class="btn" ${attrs({ href: `#/plans/${encodeURIComponent(r.plan_id)}` })}>Plan</a>` : ""}
        <a class="btn" ${attrs({ href: `#/contacts/${encodeURIComponent(r.contact_id)}` })}>${icon("contacts")}Contact</a>
      </div>
      ${can ? html`<form class="form" data-bin novalidate>
        ${["taken_down", "stored"].includes(r.status) ? html`<label class="field" data-field="bin_id"><span>Bin</span><input name="bin_id" maxlength="40" autocomplete="off" ${attrs({ value: r.bin_id || "" })}><small class="why" hidden></small></label>` : html`<p class="small muted">The bin goes on once the lights are taken down.</p>`}
        <label class="field" data-field="footage_ft"><span>Feet of lights</span><input name="footage_ft" inputmode="numeric" ${attrs({ value: r.footage_ft || "" })}><small class="why" hidden></small></label>
        <p class="err" data-form-err hidden></p>
        <button type="submit" class="btn primary block">Save</button>
      </form>
      <button type="button" class="btn block" data-warranty>${icon("plus")}Add a warranty visit</button>` : ""}
    </div>`,
    events: {
      "submit [data-bin]": async (e, form) => {
        e.preventDefault();
        const v = readForm(form);
        const btn = form.querySelector("[type=submit]");
        busy(btn, true);
        try {
          await ctx.api(`/lights/installs/${encodeURIComponent(r.id)}`, { method: "PATCH", body: { ...(v.bin_id !== undefined ? { bin_id: v.bin_id } : {}), ...(v.footage_ft ? { footage_ft: Number(v.footage_ft) } : {}) } });
          sh.close(); toast(v.bin_id && r.status === "taken_down" ? "Stored" : "Saved"); ctx.refresh();
        } catch (err) { busy(btn, false); showError(form, err); }
      },
      "click [data-warranty]": async (e, b) => {
        busy(b, true);
        try {
          const w = await ctx.api(`/lights/installs/${encodeURIComponent(r.id)}/warranty`, { method: "POST", body: {} });
          sh.close(); toast("Warranty visit added"); ctx.go(`/jobs/${encodeURIComponent(w.data.job_id)}`);
        } catch (err) { busy(b, false); toast(err.message, { bad: true }); }
      },
    },
  });
}
