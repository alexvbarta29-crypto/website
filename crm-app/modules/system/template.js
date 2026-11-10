// One template (design §9.2 "Templates", §5.7.3): name, text or email,
// category, subject, the body with variable chips (tap to insert at the
// cursor), and a live preview with made-up values or a chosen contact's,
// plus the problems the server finds (an unknown variable, STOP text: the
// app adds the opt-out footer itself, so a template never says it).
// Built-in templates keep their key and category. templates:edit.

import { html, attrs, toast, icon, render } from "../../core/ui.js";
import { field, select, checkbox, readForm, clearErrors, showError, busy } from "../../core/forms.js";
import { pickContact } from "../../core/pickers.js";

const CATS = [{ value: "service", label: "Service (their own visits, quotes, invoices)" }, { value: "marketing", label: "Marketing (needs their OK to text)" }, { value: "personal", label: "Personal" }];
const segments = (text) => {
  const gsm = /^[\x20-\x7e\n\r£¥èéùìòÇØøÅåÄÖÑÜäöñüà§¿¡]*$/.test(text);
  const n = Array.from(text).length;
  if (!n) return 0;
  const [one, many] = gsm ? [160, 153] : [70, 67];
  return n <= one ? 1 : Math.ceil(n / many);
};

export default {
  title: (s) => (s.t.id ? s.t.name : "New template"),
  async load(params, ctx) {
    const vars = ((await ctx.api("/templates", { cache: false })).meta || {}).variables || [];
    if (!params.id) return { t: { channel: "sms", category: "service", active: true, body: "", key: "", name: "" }, etag: null, vars, contact: null };
    const r = await ctx.api(`/templates/${encodeURIComponent(params.id)}`, { cache: false });
    return { t: r.data, etag: r.etag, vars, contact: null };
  },
  render(s) {
    const t = s.t;
    const isNew = !t.id;
    return html`<div class="stack">
      <form class="card form" id="tf" novalidate>
        <div class="err" data-form-err hidden></div>
        ${field({ label: "Name", name: "name", value: t.name || "", required: true })}
        ${isNew ? field({ label: "Key (how automations find it)", name: "key", value: t.key || "", autocapitalize: "none", spellcheck: "false", hint: "Lowercase letters, digits and _, like visit_reminder_2d. It never changes." }) : html`<p class="small muted">Key <span class="mono">${t.key}</span>${t.built_in ? " · built-in" : ""}</p>`}
        ${isNew ? select({ label: "Sent as", name: "channel", value: t.channel, options: [{ value: "sms", label: "Text" }, { value: "email", label: "Email" }] }) : ""}
        ${t.built_in ? html`<p class="small">Category: <b>${t.category}</b> (a built-in keeps its category)</p>` : select({ label: "Category", name: "category", value: t.category, options: CATS })}
        ${t.channel === "email" || isNew ? html`<div data-email-only ${attrs({ hidden: t.channel !== "email" })}>${field({ label: "Subject", name: "subject", value: t.subject || "" })}</div>` : ""}
        <label class="field" data-field="body"><span>Message</span><textarea class="body" name="body" rows="6" data-body>${t.body || ""}</textarea><small class="counter" data-count></small><small class="why" hidden></small></label>
        <div class="varchips" aria-label="Insert a variable">${s.vars.map((v) => html`<button type="button" ${attrs({ "data-var": v.name, title: v.label })}>{{${v.name}}}</button>`)}</div>
        <p class="small muted">Add a fallback after a bar for when it's blank: {{first_name|there}}. Leave out "Reply STOP to opt out": the app adds it to the first text and to marketing texts.</p>
        ${checkbox({ label: "On (automations may use it)", name: "active", checked: t.active !== false })}
        <button type="submit" class="btn primary block">${isNew ? "Create" : "Save"}</button>
      </form>
      <div class="section-h">Preview</div>
      <div class="card">
        <div class="stack-head"><b>${s.contact ? `For ${s.contact.name}` : "With made-up values"}</b><button type="button" class="btn" data-for>${icon("contacts")}Preview for…</button></div>
        <div data-preview><p class="small muted">Type to see it.</p></div>
      </div>
    </div>`;
  },
  mount(view, s, ctx) {
    const form = view.querySelector("#tf");
    const body = form.querySelector("[data-body]");
    const out = view.querySelector("[data-preview]");
    const count = form.querySelector("[data-count]");
    let timer = null, seq = 0;
    const channel = () => (form.querySelector("[name=channel]") ? form.querySelector("[name=channel]").value : s.t.channel);
    const run = async () => {
      const my = ++seq;
      const v = readForm(form);
      const ch = channel();
      const box = form.querySelector("[data-email-only]");
      if (box) box.hidden = ch !== "email";
      try {
        const r = await ctx.api("/templates/preview", { method: "POST", body: { channel: ch, body: body.value, subject: v.subject || "", contact_id: s.contact ? s.contact.id : undefined } });
        if (my !== seq) return;
        const p = r.data;
        const segs = ch === "sms" ? segments(p.text || "") : 0;
        count.textContent = ch === "sms" ? `${Array.from(body.value).length} characters · ${segs} text${segs === 1 ? "" : "s"} with values filled in` : "";
        render(out, html`
          ${p.problems && p.problems.length ? html`<div class="err">${p.problems.map((x) => html`<div>${x.message}</div>`)}</div>` : ""}
          ${p.missing_for_contact && p.missing_for_contact.length ? html`<div class="warn-box">This contact has nothing for: ${p.missing_for_contact.join(", ")}. A send would be held back.</div>` : ""}
          ${ch === "email" ? html`<p class="small"><b>${p.subject || "(no subject)"}</b></p>` : ""}
          <div class="bubble">${p.text || " "}</div>`);
      } catch (e) {
        if (my === seq) render(out, html`<p class="small muted">${e.message}</p>`);
      }
    };
    const soon = () => { clearTimeout(timer); timer = setTimeout(run, 350); };
    form.addEventListener("input", soon);
    form.addEventListener("change", soon);
    ctx.preview = run;
    run();
  },
  events: {
    "click [data-var]": (e, el, ctx) => {
      const ta = document.querySelector("[data-body]");
      const token = `{{${el.getAttribute("data-var")}}}`;
      const a = ta.selectionStart ?? ta.value.length;
      const b = ta.selectionEnd ?? ta.value.length;
      ta.value = ta.value.slice(0, a) + token + ta.value.slice(b);
      ta.focus();
      ta.selectionStart = ta.selectionEnd = a + token.length;
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    },
    "click [data-for]": async (e, el, ctx) => {
      const c = await pickContact(ctx.api, { title: "Preview for" });
      if (!c) return;
      ctx.state.contact = c;
      ctx.rerender();
    },
    "submit #tf": async (e, form, ctx) => {
      e.preventDefault();
      clearErrors(form);
      const v = readForm(form);
      const btn = form.querySelector("button[type=submit]");
      busy(btn, true);
      const t = ctx.state.t;
      const body = form.querySelector("[data-body]").value;
      try {
        if (!t.id) {
          const r = await ctx.api("/templates", { method: "POST", body: { key: v.key, name: v.name, channel: v.channel, category: v.category, subject: v.channel === "email" ? v.subject : undefined, body, active: !!v.active } });
          toast("Created");
          ctx.go(`/templates/${encodeURIComponent(r.data.id)}`, { replace: true });
          return;
        }
        const patch = { name: v.name, body, active: !!v.active, ...(t.built_in ? {} : { category: v.category }), ...(t.channel === "email" ? { subject: v.subject } : {}) };
        const r = await ctx.api(`/templates/${encodeURIComponent(t.id)}`, { method: "PATCH", body: patch, ifMatch: ctx.state.etag });
        ctx.state.t = r.data;
        ctx.state.etag = r.etag;
        toast("Saved");
        busy(btn, false);
      } catch (err) {
        busy(btn, false);
        if (err.status === 412) { toast("Someone else just changed this template. Showing the latest.", { bad: true }); ctx.refresh(); return; }
        showError(form, err);
      }
    },
  },
};
