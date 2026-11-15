// Templates (design §9.2, §5.7.3): the library by category (service,
// marketing, personal, staff), text and email, built-in ones marked.
// Tap one to edit it; New makes one. templates:edit. A row says text or email and built in or
// yours in plain words (the key automations use shows on the template itself). Marketing's fourth tab
// (the Rotor guide's K11): All · Texts · Email as tiles that are the filter;
// a text blast's own words live on its campaign, not in this list.

import { html, icon, attrs, tileRow, tileToggle } from "../../core/ui.js";

const CATS = [["service", "Service"], ["marketing", "Marketing"], ["personal", "Personal"], ["staff", "Staff only"]];
const CH = [["", "All"], ["sms", "Texts"], ["email", "Emails"]];

export default {
  title: "Templates",
  async load(params, ctx) {
    const r = await ctx.api("/templates", { cache: false });
    return { rows: (r.data || []).filter((t) => !/^blast(fu)?_/.test(t.key || "")), channel: ctx.keep.channel || "" };
  },
  action(s, ctx) { return { label: "New template", run: () => ctx.go("/templates/new") }; },
  render(s) {
    const rows = s.rows.filter((t) => !s.channel || t.channel === s.channel);
    return html`<div class="stack">
      ${tileRow(CH.map(([v, l]) => ({ key: v || "all", label: l, value: s.rows.filter((t) => !v || t.channel === v).length })), { name: "tpl", on: s.channel || "all", label: "Show" })}
      ${CATS.map(([cat, label]) => {
        const list = rows.filter((t) => t.category === cat);
        if (!list.length) return "";
        return html`<div><div class="section-h">${label}</div><ul class="list">${list.map((t) => html`<li>${t.id
          ? html`<a class="row" href="${"#/templates/" + encodeURIComponent(t.id)}"><span class="ico">${icon(t.channel === "email" ? "mail" : "text")}</span><span class="who"><span class="nm two">${t.name}</span><span class="sub">${t.channel === "email" ? "Email" : "Text"} · ${t.built_in ? "Built in" : "Yours"}</span></span><span class="end">${t.active ? "" : html`<span class="pill red">Off</span>`}<span class="chev" aria-hidden="true"></span></span></a>`
          : html`<div class="row"><span class="ico">${icon("doc")}</span><span class="who"><span class="nm">${t.name}</span><span class="sub">Being added</span></span></div>`}</li>`)}</ul></div>`;
      })}
      ${rows.length ? "" : html`<div class="card empty"><div class="art">${icon("doc")}</div><h2>No templates yet</h2><p>Reminders, receipts and review requests come built in, and Rotor's come over with the import. Tap + to write one.</p></div>`}
    </div>`;
  },
  events: {
    "click [data-tile=tpl]": (e, el, ctx) => {
      const k = tileToggle(ctx.state.channel || "all", el.dataset.key, "all");
      ctx.state.channel = k === "all" ? "" : k;
      ctx.keep.channel = ctx.state.channel;
      ctx.rerender();
    },
  },
};
