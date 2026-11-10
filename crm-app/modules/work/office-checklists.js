// Settings → Checklists (design §9.2, §5.5): the crew's checklist for each
// kind of work. A job gets the first active list (by order) whose job kinds
// include its kind, else whose services match its lines. New checklist
// asks for a name and opens the editor.

import { html, icon, attrs, sheet, toast } from "../../core/ui.js";
import { readForm, showError, clearErrors, busy } from "../../core/forms.js";
import { ensureStyles, kindLabel, emptyCard } from "./office-kit.js";

// "Lights install (2026)" → "lights_install_2026"
export function keyOf(s) {
  let k = String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!/^[a-z]/.test(k)) k = "list_" + k;
  k = k.slice(0, 40).replace(/_+$/, "");
  return k.length >= 2 ? k : "list";
}

function newSheet(ctx) {
  const sh = sheet({
    title: "New checklist",
    body: html`<form class="form" id="wk-cl-new" novalidate><div class="err" data-form-err hidden></div>
      <label class="field" data-field="name"><span>Name</span><input name="name" maxlength="80" required placeholder="Screens and tracks"><small class="why" hidden></small></label>
      <button type="submit" class="btn primary block">Make it</button></form>`,
    events: {
      "submit #wk-cl-new": async (e, form) => {
        e.preventDefault();
        clearErrors(form);
        const { name } = readForm(form);
        if (!name) { showError(form, { field: "name", message: "Name it." }); return; }
        const btn = form.querySelector("[type=submit]");
        busy(btn, true);
        try {
          const r = await ctx.api("/checklists", { method: "POST", body: { key: keyOf(name), name, service_types: [], job_kinds: [], items: [], active: false } });
          sh.close(); ctx.go(`/settings/checklists/${r.data.checklist.id}`);
        } catch (err) { busy(btn, false); showError(form, err.field === "key" ? { field: "name", message: err.status === 409 ? "There's a checklist with that name already." : err.message } : err); }
      },
    },
  });
}

export default {
  title: "Checklists",
  async load(params, ctx) {
    ensureStyles();
    return { rows: (await ctx.api("/checklists", { cache: false })).data || [] };
  },
  action: (s, ctx) => ({ label: "New", run: () => newSheet(ctx) }),
  render(s) {
    return html`<div class="stack wk">
      <p class="small muted">The crew ticks these off at each visit. A job gets the first active list whose kinds of job match, else whose services match its work.</p>
      ${s.rows.length ? html`<ul class="list">${s.rows.map((r) => html`<li><a class="row" href="${"#/settings/checklists/" + encodeURIComponent(r.id)}">${icon("check")}
        <span class="who"><span class="nm">${r.n}</span><span class="sub">${[...(r.jk || []).map(kindLabel), ...(r.svc || [])].join(", ") || "Matches nothing yet"} · ${r.ni} ${r.ni === 1 ? "item" : "items"}${r.nr ? `, ${r.nr} required` : ""}</span></span>
        <span class="end">${r.act === false ? html`<span class="pill">Off</span>` : html`<span class="pill green">On</span>`}<span class="chev" aria-hidden="true"></span></span></a></li>`)}</ul>`
        : emptyCard("No checklists", "Make one for each kind of work the crew does.", "check")}
    </div>`;
  },
};
