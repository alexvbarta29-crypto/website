// Merge review (design §9.2 "Merge review", §5.1, §10.4): possible
// duplicates, most certain first. On a phone each pair is stacked with the
// fields that differ highlighted (side by side from 900 px). Keep one and
// merge the other into it, or "Not the same" (remembered: the pair never
// comes back, even after another import). Bulk: dismiss every low-confidence
// pair, or merge every high-confidence pair with the same first name (each
// behind a typed confirmation). A merge runs in the background.

import { html, sheet, toast, attrs } from "../../core/ui.js";
import { field, readForm, clearErrors, showError, busy } from "../../core/forms.js";
import { ensureStyles, lifecyclePill, phoneText, followRun, forgetIndex, emptyCard } from "./kit.js";

const REASON = { phone: "Same phone", email: "Same email", name_zip: "Same name and ZIP", name: "Same name" };
const CONF = { high: ["Very likely", "red"], medium: ["Maybe", "amber"], low: ["Unlikely", ""] };

const FIELDS = [
  ["Phone", (r) => (r.p || []).map(phoneText).join(", ")],
  ["Email", (r) => (r.e || []).join(", ")],
  ["Address", (r) => r.a || ""],
  ["ZIP", (r) => r.z || ""],
  ["Source", (r) => r.src || ""],
  ["Tags", (r) => (r.tg || []).join(", ")],
];

function side(row, other, which) {
  if (row.gone) return html`<div class="side"><h3>Gone</h3><p class="muted small">This contact isn't there anymore.</p></div>`;
  return html`<div class="side">
    <h3><a ${attrs({ href: "#/contacts/" + encodeURIComponent(row.id) })}>${row.n || "No name"}</a> ${lifecyclePill(row.lc)}</h3>
    <dl>${FIELDS.map(([label, get]) => {
      const v = get(row);
      const differs = !other.gone && v !== get(other) && (v || get(other));
      return html`<dt>${label}</dt><dd class="${differs ? "diff" : ""}">${v || "—"}</dd>`;
    })}</dl>
    <span class="sr">${which}</span>
  </div>`;
}

export default {
  title: "Merge review",
  async load(params, ctx) {
    ensureStyles();
    const r = await ctx.api("/merge-candidates?status=pending", { cache: false });
    return { rows: r.data || [], counts: (r.meta && r.meta.counts) || {}, total: (r.meta && r.meta.total) || 0 };
  },
  render(s) {
    const c = s.counts;
    return html`<div class="stack">
      <section class="card"><h2>${s.total ? `${s.total} possible ${s.total === 1 ? "duplicate" : "duplicates"}` : "No duplicates waiting"}</h2>
        <p>${s.total ? `${c.high || 0} very likely, ${c.medium || 0} maybe, ${c.low || 0} unlikely. Merging moves everything into the contact you keep.` : "New pairs show up here when a lead or an import shares a phone, an email or a name with someone on file."}</p>
        ${s.total ? html`<div class="btn-row">${c.low ? html`<button type="button" class="btn" data-bulk="dismiss_low">Dismiss all unlikely</button>` : ""}${c.high ? html`<button type="button" class="btn" data-bulk="merge_high_same_first_name">Merge very likely, same first name</button>` : ""}</div>` : ""}
      </section>
      ${s.rows.length ? s.rows.map((p) => html`<section class="card pair" ${attrs({ "data-id": p.id })}>
        <div class="pair-top"><span class="${"pill " + CONF[p.confidence][1]}">${CONF[p.confidence][0]}</span><span class="small muted">${REASON[p.reason] || p.reason}</span></div>
        <div class="pair-sides">${side(p.a, p.b, "First contact")}${side(p.b, p.a, "Second contact")}</div>
        <div class="pair-acts">
          <button type="button" class="btn" ${attrs({ "data-merge": p.id, "data-keep": "a", disabled: p.a.gone || p.b.gone })}>Keep the first</button>
          <button type="button" class="btn" ${attrs({ "data-merge": p.id, "data-keep": "b", disabled: p.a.gone || p.b.gone })}>Keep the second</button>
          <button type="button" class="btn wide" ${attrs({ "data-dismiss": p.id })}>Not the same person</button>
        </div>
      </section>`) : emptyCard("All clear", "Nothing to review right now.", "check")}
    </div>`;
  },
  events: {
    "click [data-merge]": async (e, el, ctx) => {
      const id = el.dataset.merge;
      el.closest(".pair").querySelectorAll("button").forEach((b) => { b.disabled = true; });
      el.textContent = "Merging…";
      try {
        const r = await ctx.api(`/merge-candidates/${encodeURIComponent(id)}/merge`, { method: "POST", body: { survivor: el.dataset.keep } });
        const run = await followRun(ctx, r.data.run_id);
        forgetIndex();
        toast(run && run.status === "done" ? "Merged" : run && run.status === "failed" ? "That merge stopped. Try again." : "Still merging in the background.", { bad: !!(run && run.status === "failed") });
      } catch (err) { toast(err.message || "That didn't start.", { bad: true }); }
      ctx.refresh();
    },
    "click [data-dismiss]": async (e, el, ctx) => {
      el.disabled = true;
      try { await ctx.api(`/merge-candidates/${encodeURIComponent(el.dataset.dismiss)}/dismiss`, { method: "POST", body: {} }); toast("Marked as two people"); } catch (err) { toast(err.message, { bad: true }); }
      ctx.refresh();
    },
    "click [data-bulk]": (e, el, ctx) => {
      const action = el.dataset.bulk;
      const word = action === "dismiss_low" ? "DISMISS" : "MERGE";
      const what = action === "dismiss_low" ? `Every unlikely pair (${ctx.state.counts.low || 0}) is marked as two people.` : `Every very likely pair (${ctx.state.counts.high || 0}) whose first names match is merged: the customer (or the older contact) is kept.`;
      const s = sheet({
        title: action === "dismiss_low" ? "Dismiss all unlikely" : "Merge very likely pairs",
        body: html`<form class="form" id="bulk-f" novalidate><div class="err" data-form-err hidden></div><p class="muted">${what} This can't be undone.</p>
          ${field({ label: `Type ${word} to confirm`, name: "confirm", autocapitalize: "characters", autocomplete: "off" })}
          <button type="submit" class="btn danger block">${action === "dismiss_low" ? "Dismiss them" : "Merge them"}</button></form>`,
        events: {
          "submit #bulk-f": async (ev, form) => {
            ev.preventDefault(); clearErrors(form);
            const btn = form.querySelector("[type=submit]"); busy(btn, true, "Working…");
            try {
              const r = await ctx.api("/merge-candidates/bulk", { method: "POST", body: { action, confirm: readForm(form).confirm } });
              const run = await followRun(ctx, r.data.run_id, { tries: 40 });
              s.close();
              forgetIndex();
              const res = (run && run.result) || {};
              toast(run && run.status === "done" ? `Done: ${res.merged || 0} merged, ${res.dismissed || 0} dismissed` : "Still working in the background.");
              ctx.refresh();
            } catch (err) { busy(btn, false); showError(form, err); }
          },
        },
      });
    },
  },
};
