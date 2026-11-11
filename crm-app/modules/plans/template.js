// One agreement text (design §9.2 Settings → Agreement templates, D10): the
// body with its variable chips and a preview with a made-up customer; an
// owner saves (a changed text is a new version that needs approving again)
// and approves. Others read it.

import { html, attrs, toast } from "../../core/ui.js";
import { busy } from "../../core/forms.js";
import { ensureStyles } from "./kit.js";

const VARS = ["full_name", "plan_name", "per_visit_price", "visits_per_year", "term_months", "perks_list", "clawback_amount", "notice_days", "late_cancel_fee", "legal_name", "company_name", "company_phone"];

export default {
  title: (s) => (s && s.t ? s.t.name : "Agreement"),
  async load(params, ctx) {
    ensureStyles();
    const r = await ctx.api(`/agreement-templates/${encodeURIComponent(params.id)}`, { cache: false });
    return { t: r.data, etag: r.etag, preview: null };
  },
  render(s, ctx) {
    const t = s.t;
    const edit = ctx.can("agreement_templates:edit");
    return html`<div class="stack">
      <section class="card"><p><span class="${"pill " + (t.approved ? "green" : "amber")}">${t.approved ? `Approved (version ${t.version})` : "Draft, needs owner approval"}</span></p>
        ${!t.approved && edit ? html`<button type="button" class="btn primary block" data-approve>Approve this text</button>` : ""}</section>
      <form class="form" data-tpl novalidate>
        <label class="field"><span>Name</span><input name="name" maxlength="120" ${attrs({ value: t.name, readonly: !edit })}></label>
        ${edit ? html`<div class="pl-vars">${VARS.map((v) => html`<button type="button" ${attrs({ "data-var": v })}>${v}</button>`)}</div>` : ""}
        <label class="field"><span>Text</span><textarea class="pl-body" name="body_md" ${attrs({ readonly: !edit })}>${t.body_md}</textarea><small>Lines starting with ## are headings, - are list items.</small></label>
        <p class="err" data-form-err hidden></p>
        <div class="btn-row"><button type="button" class="btn" data-preview>Preview</button>${edit ? html`<button type="submit" class="btn primary">Save</button>` : ""}</div>
      </form>
      ${s.preview ? html`<section class="card"><h2>Preview</h2><div class="pl-doc">${s.preview}</div></section>` : ""}
    </div>`;
  },
  events: {
    "click [data-var]": (e, el) => {
      const ta = document.querySelector("textarea[name=body_md]");
      if (!ta) return;
      const at = ta.selectionStart || ta.value.length;
      ta.value = `${ta.value.slice(0, at)}{{${el.dataset.var}}}${ta.value.slice(at)}`;
      ta.focus();
    },
    "click [data-preview]": async (e, el, ctx) => {
      const body = (document.querySelector("textarea[name=body_md]") || {}).value || ctx.state.t.body_md;
      try {
        const r = await ctx.api("/agreement-templates/preview", { method: "POST", body: { body_md: body, catalog_key: (ctx.state.t.applies_to && ctx.state.t.applies_to.catalog_keys || [])[0] } });
        ctx.state.preview = r.data.text; ctx.rerender();
      } catch (err) { toast(err.message, { bad: true }); }
    },
    "submit [data-tpl]": async (e, form, ctx) => {
      e.preventDefault();
      const err = form.querySelector("[data-form-err]");
      const btn = form.querySelector("[type=submit]");
      busy(btn, true);
      try {
        await ctx.api(`/agreement-templates/${encodeURIComponent(ctx.state.t.id)}`, { method: "PATCH", ifMatch: ctx.state.etag, body: { name: form.elements.name.value, body_md: form.elements.body_md.value } });
        toast("Saved"); ctx.refresh();
      } catch (er) { busy(btn, false); err.textContent = er.status === 412 ? "Someone else just saved this text. Reload it." : er.message; err.hidden = false; }
    },
    "click [data-approve]": async (e, el, ctx) => {
      busy(el, true);
      try { await ctx.api(`/agreement-templates/${encodeURIComponent(ctx.state.t.id)}/approve`, { method: "POST", body: {} }); toast("Approved"); ctx.refresh(); }
      catch (err) { busy(el, false); toast(err.message, { bad: true }); }
    },
  },
};
