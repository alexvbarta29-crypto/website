// Conflicts of one import (design §10.7; owners): a field that someone
// changed in the CRM and Rotor changed too since the last import. Each
// shows the value at the last import, the CRM's and Rotor's; "Take Rotor's"
// writes Rotor's value (as you), "Keep the CRM's" keeps it. Either way the
// field stays quiet until Rotor changes it again. Everything else on the
// record already took Rotor's new values.

import { html, icon, toast, attrs } from "../../core/ui.js";
import { ensureStyles, fieldLabel, valueText, TYPE_LABEL, n } from "./kit.js";

async function page(ctx, id, after = null) {
  const q = new URLSearchParams({ status: "open", ...(after ? { after } : {}) });
  const r = await ctx.api(`/import/runs/${encodeURIComponent(id)}/conflicts?${q}`, { cache: false });
  return { rows: r.data || [], next: (r.meta && r.meta.next_cursor) || null, total: (r.meta && r.meta.total) || 0 };
}

export default {
  title: "Conflicts",
  async load(params, ctx) {
    ensureStyles();
    const p = await page(ctx, params.id);
    return { id: params.id, ...p, done: [] };
  },
  render(s) {
    const open = s.rows.filter((c) => c.status === "open" && !s.done.includes(c.key));
    return html`<div class="stack">
      <section class="card"><h2>${open.length ? `${n(open.length)} ${open.length === 1 ? "field" : "fields"} to settle` : "All settled"}</h2>
        <p>${open.length ? "These changed both here and in Rotor since the last import. Pick which value stays; the rest of each record already has Rotor's new values." : "Nothing changed on both sides. The next import keeps your choices."}</p></section>
      ${open.map((c) => html`<section class="card im-conflict" ${attrs({ "data-key": c.key })}>
        <div class="im-head"><h3>${c.type === "contact" ? html`<a ${attrs({ href: "#/contacts/" + encodeURIComponent(c.id) })}>${c.label || "A contact"}</a>` : html`${c.label || TYPE_LABEL[c.type] || c.type}`}</h3><span class="pill">${fieldLabel(c.field)}</span></div>
        <dl class="kv im-sides">
          <dt>At the last import</dt><dd>${valueText(c.base)}</dd>
          <dt>In the CRM</dt><dd class="im-crm">${valueText(c.crm)}</dd>
          <dt>In Rotor now</dt><dd class="im-rotor">${valueText(c.rotor)}</dd>
        </dl>
        <div class="btn-row"><button type="button" class="btn" data-take="crm">Keep the CRM's</button><button type="button" class="btn primary" data-take="rotor">Take Rotor's</button></div>
      </section>`)}
      ${s.next ? html`<div class="btn-row"><button type="button" class="btn" data-more>${icon("list")}Show more</button></div>` : ""}
    </div>`;
  },
  events: {
    "click [data-take]": async (e, el, ctx) => {
      const card = el.closest("[data-key]");
      const key = card.dataset.key;
      card.querySelectorAll("button").forEach((b) => { b.disabled = true; });
      try {
        await ctx.api(`/import/conflicts/${encodeURIComponent(key)}/resolve`, { method: "POST", body: { take: el.dataset.take } });
        ctx.state.done.push(key);
        toast(el.dataset.take === "rotor" ? "Took Rotor's value" : "Kept the CRM's value");
        ctx.rerender();
      } catch (err) {
        card.querySelectorAll("button").forEach((b) => { b.disabled = false; });
        toast(err.message, { bad: true });
      }
    },
    "click [data-more]": async (e, el, ctx) => {
      el.disabled = true;
      try {
        const p = await page(ctx, ctx.state.id, ctx.state.next);
        ctx.state.rows = [...ctx.state.rows, ...p.rows];
        ctx.state.next = p.next;
        ctx.rerender();
      } catch (err) { el.disabled = false; toast(err.message, { bad: true }); }
    },
  },
};
