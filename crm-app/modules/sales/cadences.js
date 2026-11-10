// Settings → Cadences (design §9.2, §5.2, D7, D20-D22): the follow-up
// cadences (open one to edit its steps, windows, texts and offers), and the
// sales settings: when a lead needs attention, when a quiet deal is given
// up, when a late step ends its follow-up, the day's cut-off for new leads,
// and how long the thank-you text waits for a call. Texts 5 and 8 of the
// new-lead follow-up are worded like the website (D25); one tap puts the
// playbook's older words back (or the website's again).

import { html, icon, toast, attrs } from "../../core/ui.js";
import { field, readForm, clearErrors, showError, busy } from "../../core/forms.js";
import { timeField } from "../../core/pickers.js";
import { ensureStyles } from "./kit.js";

async function loadDoc(ctx, name) {
  const r = await ctx.api(`/settings/${name}`, { cache: false });
  return { name, data: r.data.data, etag: r.data.etag || "new" };
}

const ENTRY = { "lead.created": "A new lead", "quote.sent": "A quote is sent", "tag.added": "A tag (board)", manual: "By hand" };

// Texts 5 and 8: the website's wording (D25, as seeded) and the playbook's older one.
const REWORDED = {
  cad_new_5: {
    label: "Text 5: how to pick a window cleaner",
    site: "Hey, just missed you again! You're probably getting a few other quotes, so here's a few pointers for how to find the right person for the job. 1) fully insured so you and your property are protected, 2) frames and sills included, not just the glass, and 3) a 100% satisfaction guarantee. PS we do all of those things!",
    old: "Hey, just missed you again! You're probably getting a few other quotes, so here's a few pointers for how to find the right person for the job. 1) fully licensed and insured so you and your property are protected, 2) frames and sills included, not just the glass, and 3) a 100% satisfaction guarantee. PS we do all of those things!",
  },
  cad_new_8: {
    label: "Text 8: the satisfaction guarantee",
    site: "Hey, missed you again today! Real quick, one thing I love about us is our 100% satisfaction guarantee. If you're ever not happy with the job, we'll come back and re-clean it free of charge. So there's truly no risk on your end. Would love to get you that quote whenever you're free!",
    old: "Hey, missed you again today! Real quick, one thing I love about us is our 100% satisfaction guarantee. If you're ever not happy with the job we'll come back and make it right free of charge, and if you're still not happy we'll refund you. So there's truly no risk on your end. Would love to get you that quote whenever you're free!",
  },
};
async function loadReworded(ctx) {
  if (!ctx.can("templates:edit")) return [];
  const list = await ctx.api("/templates?channel=sms", { cache: false }).then((r) => r.data || []).catch(() => []);
  const out = [];
  for (const key of Object.keys(REWORDED)) {
    const row = list.find((t) => t.key === key && t.id);
    if (!row) continue;
    const r = await ctx.api(`/templates/${encodeURIComponent(row.id)}`, { cache: false }).catch(() => null);
    if (r) out.push({ key, id: row.id, body: r.data.body, etag: r.etag });
  }
  return out;
}
function reworded(s) {
  if (!s.reworded || !s.reworded.length) return "";
  return html`<section class="card"><h2>Texts 5 and 8</h2>
    <p class="small muted">Worded like the website: "fully insured", and a free re-clean if they're not happy. You can put the playbook's older words back, or edit them in Templates.</p>
    ${s.reworded.map((t) => {
      const w = REWORDED[t.key];
      const now = t.body === w.site ? "site" : t.body === w.old ? "old" : "edited";
      return html`<div class="stack" style="margin-top:12px"><b>${w.label}</b>
        <div class="bubble grey sl-text">${t.body}</div>
        <p class="small muted">${now === "site" ? "Now: the website's wording." : now === "old" ? "Now: the playbook's older wording." : "Now: edited in Templates."}</p>
        <div class="btn-row">
          ${now !== "old" ? html`<button type="button" class="btn" ${attrs({ "data-words": t.key, "data-to": "old" })}>Use the playbook's older words</button>` : ""}
          ${now !== "site" ? html`<button type="button" class="btn" ${attrs({ "data-words": t.key, "data-to": "site" })}>Use the website's wording</button>` : ""}
          <a class="btn" href="${"#/templates/" + encodeURIComponent(t.id)}">Edit in Templates</a>
        </div></div>`;
    })}
  </section>`;
}

export default {
  title: "Cadences",
  async load(params, ctx) {
    ensureStyles();
    const [list, sales, ack, words] = await Promise.all([
      ctx.api("/cadences", { cache: false }),
      loadDoc(ctx, "sales"),
      ctx.can("automations:configure") ? ctx.api("/automations", { cache: false }).then((r) => (r.data.automations || []).find((a) => a.key === "lead.ack")).catch(() => null) : null,
      loadReworded(ctx).catch(() => []),
    ]);
    return { list: list.data || [], sales, ack, reworded: words };
  },
  render(s) {
    const v = s.sales.data;
    return html`<div class="stack">
      <ul class="list">${s.list.map((c) => html`<li><a class="row" href="${"#/settings/cadences/" + encodeURIComponent(c.id)}">
        <span class="ico${c.active ? " coral" : ""}">${icon(c.board_only ? "list" : "phone")}</span>
        <span class="who"><span class="nm">${c.name}</span><span class="sub">${c.board_only ? "Board only" : `${c.steps} steps · starts when: ${ENTRY[c.entry_on] || c.entry_on}`}${c.unattended === "text_anyway" ? " · texts if nobody calls" : ""}</span></span>
        <span class="end">${c.active ? html`<span class="pill green">On</span>` : html`<span class="pill">Off</span>`}<span class="chev" aria-hidden="true"></span></span></a></li>`)}</ul>
      ${reworded(s)}
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
    "click [data-words]": async (e, el, ctx) => {
      const t = (ctx.state.reworded || []).find((x) => x.key === el.dataset.words);
      if (!t) return;
      el.disabled = true;
      try {
        const r = await ctx.api(`/templates/${encodeURIComponent(t.id)}`, { method: "PATCH", ifMatch: t.etag, body: { body: REWORDED[t.key][el.dataset.to] } });
        t.body = r.data.body; t.etag = r.etag;
        toast("Saved. The Follow-ups page shows it within a minute."); ctx.rerender();
      } catch (err) {
        el.disabled = false;
        if (err.status === 412) { toast("Someone else just changed this text. Showing the latest.", { bad: true }); ctx.refresh(); } else toast(err.message, { bad: true });
      }
    },
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
