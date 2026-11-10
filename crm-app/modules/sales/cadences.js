// Settings → Cadences (design §9.2, §5.2, D7, D20-D22): the follow-up
// cadences (open one to edit its steps, windows, texts and offers), and the
// sales settings: when a lead needs attention, when a quiet deal is given
// up, when a late step ends its follow-up, the day's cut-off for new leads,
// and how long the thank-you text waits for a call.

import { html, icon, toast } from "../../core/ui.js";
import { field, readForm, clearErrors, showError, busy } from "../../core/forms.js";
import { timeField } from "../../core/pickers.js";
import { ensureStyles } from "./kit.js";

async function loadDoc(ctx, name) {
  const r = await ctx.api(`/settings/${name}`, { cache: false });
  return { name, data: r.data.data, etag: r.data.etag || "new" };
}

const ENTRY = { "lead.created": "A new lead", "quote.sent": "A quote is sent", "tag.added": "A tag (board)", manual: "By hand" };

export default {
  title: "Cadences",
  async load(params, ctx) {
    ensureStyles();
    const [list, sales, ack] = await Promise.all([
      ctx.api("/cadences", { cache: false }),
      loadDoc(ctx, "sales"),
      ctx.can("automations:configure") ? ctx.api("/automations", { cache: false }).then((r) => (r.data.automations || []).find((a) => a.key === "lead.ack")).catch(() => null) : null,
    ]);
    return { list: list.data || [], sales, ack };
  },
  render(s) {
    const v = s.sales.data;
    return html`<div class="stack">
      <ul class="list">${s.list.map((c) => html`<li><a class="row" href="${"#/settings/cadences/" + encodeURIComponent(c.id)}">
        <span class="ico${c.active ? " coral" : ""}">${icon(c.board_only ? "list" : "phone")}</span>
        <span class="who"><span class="nm">${c.name}</span><span class="sub">${c.board_only ? "Board only" : `${c.steps} steps · starts when: ${ENTRY[c.entry_on] || c.entry_on}`}${c.unattended === "text_anyway" ? " · texts if nobody calls" : ""}</span></span>
        <span class="end">${c.active ? html`<span class="pill green">On</span>` : html`<span class="pill">Off</span>`}<span class="chev" aria-hidden="true"></span></span></a></li>`)}</ul>
      ${s.ack ? html`<p class="small muted">The thank-you text to a new website lead (lead.ack) waits ${s.ack.settings ? s.ack.settings.delay : 5} minutes for a call during business hours: change it on <a class="linkish" href="#/automations">Automations</a>.</p>` : ""}
      <form class="card form" id="sales-f" novalidate>
        <div class="err" data-form-err hidden></div>
        <h2>Leads and deals</h2>
        ${field({ label: "A lead needs attention after (hours with no call or text)", name: "attention_hours", value: String(v.attention_hours ?? 24), inputmode: "numeric" })}
        ${field({ label: "A paused follow-up needs attention after (days)", name: "paused_attention_days", value: String(v.paused_attention_days ?? 2), inputmode: "numeric" })}
        ${field({ label: "A step this many days late ends its follow-up", name: "expire_days", value: String(v.expire_days ?? 14), inputmode: "numeric" })}
        ${field({ label: "An open deal goes quiet after (days with nothing)", name: "abandon_days", value: String(v.abandon_days ?? 30), inputmode: "numeric" })}
        ${timeField({ label: "A lead after this starts the next business day", name: "day_cutoff", value: v.day_cutoff || "17:00" })}
        <button type="submit" class="btn primary block">Save</button>
      </form>
    </div>`;
  },
  events: {
    "submit #sales-f": async (e, form, ctx) => {
      e.preventDefault(); clearErrors(form);
      const v = readForm(form);
      const num = (k) => (String(v[k] || "").trim() === "" ? undefined : Number(v[k]));
      const btn = form.querySelector("[type=submit]"); busy(btn, true);
      const doc = ctx.state.sales;
      try {
        const r = await ctx.api("/settings/sales", { method: "PUT", ifMatch: doc.etag || "new", body: { ...doc.data, attention_hours: num("attention_hours"), paused_attention_days: num("paused_attention_days"), expire_days: num("expire_days"), abandon_days: num("abandon_days"), day_cutoff: v.day_cutoff || "17:00" } });
        doc.data = r.data.data; doc.etag = r.data.etag;
        busy(btn, false); toast("Saved");
      } catch (err) {
        busy(btn, false);
        if (err.status === 412) { toast("Someone else just changed these settings. Showing the latest.", { bad: true }); ctx.refresh(); } else showError(form, err);
      }
    },
  },
};
