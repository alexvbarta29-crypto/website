// One deal (design §5.2): one sales attempt and how it ended. Its status
// follows what happened (a quote sent, approved, declined, a job booked, 30
// quiet days); a person may set it by hand (the change is kept in its
// history). Rotor's board rows show under "From Rotor".

import { html, icon, sheet, toast } from "../../core/ui.js";
import { select, field, readForm, busy, showError, clearErrors } from "../../core/forms.js";
import { dateShort, dateTime, money } from "../../core/format.js";
import { ensureStyles, dealPill, enrollmentPill, LOST_REASONS, DEAL_STATUS } from "./kit.js";

async function load(params, ctx) {
  ensureStyles();
  const r = await ctx.api(`/deals/${encodeURIComponent(params.id)}`, { cache: false });
  return { ...r.data, etag: r.etag };
}

function loseSheet(ctx) {
  const s = sheet({
    title: "Mark as lost",
    body: html`<form class="form" id="lose-f" novalidate><div class="err" data-form-err hidden></div>
      ${select({ label: "Why", name: "reason", value: "no_response", options: LOST_REASONS })}
      <label class="field" data-field="note"><span>Note (optional)</span><textarea name="note" rows="3" maxlength="500"></textarea><small class="why" hidden></small></label>
      <button type="submit" class="btn danger block">Mark as lost</button></form>`,
    events: {
      "submit #lose-f": async (e, form) => {
        e.preventDefault(); clearErrors(form);
        const v = readForm(form);
        const btn = form.querySelector("[type=submit]"); busy(btn, true);
        try { await ctx.api(`/deals/${encodeURIComponent(ctx.state.deal.id)}/lose`, { method: "POST", body: { reason: v.reason, note: v.note } }); s.close(); toast("Marked as lost"); ctx.refresh(); }
        catch (err) { busy(btn, false); showError(form, err); }
      },
    },
  });
}

function valueSheet(ctx) {
  const d = ctx.state.deal;
  const s = sheet({
    title: "Deal",
    body: html`<form class="form" id="deal-f" novalidate><div class="err" data-form-err hidden></div>
      ${field({ label: "Title", name: "title", value: d.title || "" })}
      ${field({ label: "Value", name: "value", value: d.value_cents != null ? (d.value_cents / 100).toFixed(2) : "", inputmode: "decimal", hint: "The quote's first visit, or a plan's yearly value." })}
      ${select({ label: "Status", name: "status", value: d.status, options: Object.entries(DEAL_STATUS).map(([value, label]) => ({ value, label })) })}
      <button type="submit" class="btn primary block">Save</button></form>`,
    events: {
      "submit #deal-f": async (e, form) => {
        e.preventDefault(); clearErrors(form);
        const v = readForm(form);
        const cents = String(v.value || "").trim() === "" ? undefined : Math.round(Number(String(v.value).replace(/[$,]/g, "")) * 100);
        if (cents !== undefined && !Number.isFinite(cents)) { showError(form, { field: "value", message: "Use an amount like 243.10." }); return; }
        const btn = form.querySelector("[type=submit]"); busy(btn, true);
        try {
          await ctx.api(`/deals/${encodeURIComponent(d.id)}`, { method: "PATCH", ifMatch: ctx.state.etag, body: { title: v.title, ...(cents !== undefined ? { value_cents: cents } : {}), ...(v.status !== d.status ? { status: v.status } : {}) } });
          s.close(); toast("Saved"); ctx.refresh();
        } catch (err) { busy(btn, false); if (err.status === 412) { s.close(); toast("Someone else just changed this deal. Showing the latest.", { bad: true }); ctx.refresh(); } else showError(form, err); }
      },
    },
  });
}

export default {
  title: (s) => (s && s.deal ? s.deal.title : "Deal"),
  load,
  render(s) {
    const d = s.deal;
    const rotorRows = (d.history || []).filter((h) => h.kind === "rotor_opportunity");
    return html`<div class="stack">
      <section class="card">
        <div class="row" style="padding:0;min-height:0"><h2 style="flex:1;margin:0">${d.title}</h2>${dealPill(d.status)}</div>
        <dl class="kv sl-kv" style="margin-top:10px">
          ${s.contact ? html`<dt>Contact</dt><dd><a class="linkish" href="${"#/contacts/" + encodeURIComponent(s.contact.id)}">${s.contact.name}</a></dd>` : ""}
          ${d.source && (d.source.campaign || d.source.source) ? html`<dt>Source</dt><dd>${d.source.qr_code && d.source.campaign ? `${d.source.campaign} (QR code)` : d.source.source}</dd>` : ""}
          <dt>Value</dt><dd class="num">${d.value_cents != null ? money(d.value_cents) : "Not quoted yet"}</dd>
          ${(d.services || []).length ? html`<dt>Services</dt><dd>${d.services.join(", ")}</dd>` : ""}
          <dt>Opened</dt><dd>${dateShort(d.opened_at)}</dd>
          ${d.quoted_at ? html`<dt>Quoted</dt><dd>${dateShort(d.quoted_at)}</dd>` : ""}
          ${d.won_at ? html`<dt>Won</dt><dd>${dateShort(d.won_at)}</dd>` : ""}
          ${d.lost_at ? html`<dt>Lost</dt><dd>${dateShort(d.lost_at)} · ${(LOST_REASONS.find((r) => r.value === d.lost_reason) || {}).label || d.lost_reason || ""}</dd>` : ""}
          ${d.lost_note ? html`<dt>Note</dt><dd>${d.lost_note}</dd>` : ""}
          ${d.abandoned_at ? html`<dt>Went quiet</dt><dd>${dateShort(d.abandoned_at)}</dd>` : ""}
          ${(d.quote_ids || []).length ? html`<dt>Quotes</dt><dd>${d.quote_ids.length} (they open with Quotes)</dd>` : ""}
        </dl>
      </section>
      <div class="btn-row" style="margin-top:0">
        <button type="button" class="btn" data-edit>${icon("doc")}Edit</button>
        ${["open", "quoted"].includes(d.status) ? html`<button type="button" class="btn danger" data-lose>Mark as lost</button>` : ""}
      </div>
      ${(s.enrollments || []).length ? html`<div class="section-h">Follow-ups</div><ul class="list">${s.enrollments.map((e) => html`<li><a class="row" href="${"#/enrollments/" + encodeURIComponent(e.id)}">
        <span class="who"><span class="nm">${e.cadence_name || e.cadence_key}</span><span class="sub">${(e.cur && e.cur.label) || ""}</span></span>
        <span class="end">${enrollmentPill(e.status)}<span class="chev" aria-hidden="true"></span></span></a></li>`)}</ul>` : ""}
      ${rotorRows.length ? html`<div class="section-h">From Rotor</div><section class="card"><ul class="sl-hist">${rotorRows.map((h) => html`<li><span>${h.pipeline}: ${h.stage} (${h.status_raw}${h.archived ? ", archived" : ""})</span><span class="w">${dateTime(h.at)}</span></li>`)}</ul></section>` : ""}
    </div>`;
  },
  events: {
    "click [data-lose]": (e, el, ctx) => loseSheet(ctx),
    "click [data-edit]": (e, el, ctx) => valueSheet(ctx),
  },
};
