// Templates (design §9.2, §5.7.3): the library by category (service,
// marketing, personal, staff), text and email, built-in ones marked.
// Tap one to edit it; New makes one. templates:edit.

import { html, icon, attrs } from "../../core/ui.js";

const CATS = [["service", "Service"], ["marketing", "Marketing"], ["personal", "Personal"], ["staff", "Staff only"]];
const CH = [["", "All"], ["sms", "Texts"], ["email", "Emails"]];

export default {
  title: "Templates",
  async load(params, ctx) {
    const r = await ctx.api("/templates", { cache: false });
    return { rows: r.data || [], channel: ctx.keep.channel || "" };
  },
  action(s, ctx) { return { label: "New", run: () => ctx.go("/templates/new") }; },
  render(s) {
    const rows = s.rows.filter((t) => !s.channel || t.channel === s.channel);
    return html`<div class="stack">
      <div class="chips" role="group" aria-label="Show">${CH.map(([v, l]) => html`<button type="button" class="chip" ${attrs({ "aria-pressed": String(s.channel === v), "data-ch": v })}>${l} <span class="n">${s.rows.filter((t) => !v || t.channel === v).length}</span></button>`)}</div>
      ${CATS.map(([cat, label]) => {
        const list = rows.filter((t) => t.category === cat);
        if (!list.length) return "";
        return html`<div><div class="section-h">${label}</div><ul class="list">${list.map((t) => html`<li>${t.id
          ? html`<a class="row" href="${"#/templates/" + encodeURIComponent(t.id)}"><span class="ico">${icon(t.channel === "email" ? "mail" : "text")}</span><span class="who"><span class="nm">${t.name}</span><span class="sub mono">${t.key}</span></span><span class="end">${t.built_in ? html`<span class="pill">Built-in</span>` : ""}${t.active ? "" : html`<span class="pill red">Off</span>`}<span class="chev" aria-hidden="true"></span></span></a>`
          : html`<div class="row"><span class="ico">${icon("doc")}</span><span class="who"><span class="nm">${t.name}</span><span class="sub">Being added</span></span></div>`}</li>`)}</ul></div>`;
      })}
      ${rows.length ? "" : html`<div class="card empty"><div class="art">${icon("doc")}</div><h2>No templates yet</h2><p>Reminders, receipts and review requests come built in, and Rotor's come over with the import. Tap New to write one.</p></div>`}
    </div>`;
  },
  events: {
    "click [data-ch]": (e, el, ctx) => {
      ctx.state.channel = el.getAttribute("data-ch");
      ctx.keep.channel = ctx.state.channel;
      ctx.rerender();
    },
  },
};
