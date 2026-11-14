// A pay period (design §9.2 "Payroll", §5.8): everyone's pay sheet for the
// period, line by line: hours (straight time per shift), overtime over 40 h
// a week, commissions, tips, the owner's adjustments and late time. While
// open it is worked out live; Lock makes it final (and locks its shifts);
// Mark paid records that it was paid (the CRM never moves money). Each
// person's printable pay sheet, the CSV, and Add adjustment (with a note the
// person sees).

import { html, attrs, toast, confirmSheet, sheet } from "../../core/ui.js";
import { readForm, showError, clearErrors, busy, readMoney, select, field } from "../../core/forms.js";
import { ensureStyles, statusPill, span, dollars, hrs, lineRow, totalsGrid, MODEL } from "./kit.js";

async function load(params, ctx) {
  ensureStyles();
  const r = await ctx.api(`/payroll/periods/${encodeURIComponent(params.id)}`, { cache: false });
  return { ...r.data, run: ctx.can("payroll:run"), open: ctx.keep.open || {} };
}

const api = (id, what) => `/api/crm/payroll/periods/${encodeURIComponent(id)}/${what}`;

async function act(ctx, el, what, label, body = {}) {
  busy(el, true, label);
  try {
    let r = await ctx.api(`/payroll/periods/${encodeURIComponent(ctx.state.period.id)}/${what}`, { method: "POST", body });
    // locking and unlocking go a batch of shifts at a time
    for (let i = 0; r.data && r.data.more && i < 20; i++) r = await ctx.api(`/payroll/periods/${encodeURIComponent(ctx.state.period.id)}/${what}`, { method: "POST", body });
    ctx.refresh();
  } catch (err) { busy(el, false); toast(err.message || "That didn't work.", { bad: true }); }
}

function adjust(ctx) {
  const s = ctx.state;
  const sh = sheet({
    title: "Add to someone's pay",
    body: html`<form class="py-form" novalidate data-adj>
      ${select({ label: "Who", name: "user_id", options: s.people.map((p) => ({ value: p.id, label: p.name })) })}
      <div class="two">${select({ label: "Kind", name: "type", options: [{ value: "bonus", label: "Bonus" }, { value: "adjustment", label: "Adjustment" }] })}${field({ label: "Amount", name: "amount", inputmode: "decimal", placeholder: "25.00", hint: "A minus takes money off" })}</div>
      ${field({ label: "What it's for", name: "note", placeholder: "Two Google reviews", hint: "They see this on their pay sheet" })}
      <p class="err" data-form-err hidden></p>
      <button type="submit" class="btn primary">Add it</button>
    </form>`,
    events: {
      "submit [data-adj]": async (e, form) => {
        e.preventDefault();
        clearErrors(form);
        const v = readForm(form);
        const cents = readMoney(v.amount);
        if (!cents) return showError(form, { field: "amount", message: "Enter an amount, like 25.00." });
        const btn = form.querySelector("button[type=submit]");
        busy(btn, true);
        try {
          await ctx.api(`/payroll/periods/${encodeURIComponent(s.period.id)}/adjustments`, { method: "POST", body: { user_id: v.user_id, type: v.type, amount_cents: cents, note: v.note, label: v.type === "bonus" ? "Bonus" : "Adjustment", client_id: `adj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` } });
          sh.close();
          toast("Added.");
          ctx.refresh();
        } catch (err) { busy(btn, false); showError(form, err); }
      },
    },
  });
}

export default {
  load,
  title: (s) => (s && s.period ? span(s.period.start_on, s.period.end_on) : "Pay period"),
  render(s) {
    const p = s.period;
    const total = Object.values(s.totals || {}).reduce((a, t) => a + (t.total_cents || 0), 0);
    const w = s.warnings || {};
    const waits = [w.pending ? `${w.pending} time ${w.pending === 1 ? "entry waits" : "entries wait"} for a decision` : "", w.to_approve ? `${w.to_approve} ${w.to_approve === 1 ? "shift isn't" : "shifts aren't"} approved yet (they count)` : "", w.open_shifts ? `${w.open_shifts} ${w.open_shifts === 1 ? "shift is" : "shifts are"} still clocked in` : ""].filter(Boolean);
    return html`<div class="stack py-page">
      <section class="card py-hero">
        <span class="k">Pay period · ${span(p.start_on, p.end_on)}${p.weeks > 1 ? ` · ${p.weeks} weeks` : ""}</span>
        <span class="big">${dollars(total)}</span>
        <span class="meta">${statusPill(p.status)}<span>${p.status === "open" ? (s.ended ? "over, not locked yet" : "worked out live so far") : p.status === "locked" ? "final; not marked paid yet" : "paid"}</span></span>
        ${p.status === "open" && waits.length ? html`<p class="py-warn">${waits.join(". ")}. Timesheets settles them.</p>` : ""}
        <div class="py-acts">
          ${s.run && p.status === "open" ? html`<button type="button" class="btn" data-act="add">Add bonus or adjustment</button>` : ""}
          ${s.run && p.status === "open" ? html`<button type="button" class="btn primary" ${attrs({ "data-act": "lock", disabled: !s.ended })}>Lock${s.ended ? "" : " (once it's over)"}</button>` : ""}
          ${s.run && p.status === "locked" ? html`<button type="button" class="btn primary" data-act="paid">Mark paid</button><button type="button" class="btn" data-act="unlock">Unlock</button>` : ""}
          <a class="btn" ${attrs({ href: api(p.id, "export.csv"), download: "" })}>Export CSV</a>
        </div>
      </section>
      ${(s.people || []).length ? s.people.map((person) => {
        const t = s.totals[person.id] || {};
        const mine = (s.lines || []).filter((l) => l.user_id === person.id);
        return html`<section class="card py-person">
          <div class="top"><span class="who"><span class="nm">${person.name}</span><span class="sub">${MODEL[t.model_applied] || String(t.model_applied || "").replace(/_/g, " ")}${t.rate_is_standard ? " · standard $20 rate" : ""}</span></span><b class="amt">${dollars(t.total_cents)}</b></div>
          ${totalsGrid(t)}
          ${t.adjustments_cents ? html`<p class="py-note">Bonuses and adjustments: ${dollars(t.adjustments_cents)}</p>` : ""}
          ${t.pending_minutes ? html`<p class="py-note">${hrs(t.pending_minutes / 60)} waits for the office and isn't counted.</p>` : ""}
          <details ${attrs({ open: !!s.open[person.id], "data-person": person.id })}><summary>${mine.length} ${mine.length === 1 ? "line" : "lines"}</summary>
            <ul class="py-lines">${mine.map((l) => lineRow(l, { voidable: s.run && p.status === "open" }))}</ul>
          </details>
          <div class="py-acts"><a class="btn" ${attrs({ href: api(p.id, `sheet/${person.id}`), target: "_blank", rel: "noopener" })}>Pay sheet</a></div>
        </section>`;
      }) : html`<div class="card empty"><h2>Nobody to pay in this period</h2><p>Approved time, finished jobs and tips land here.</p></div>`}
      <p class="py-note">Hours are paid at each shift's rate; a week over 40 hours adds half the week's average rate for each hour over. Tips are split as they came in. Struck-out lines are not paid.</p>
    </div>`;
  },
  events: {
    "click [data-act=add]": (e, el, ctx) => adjust(ctx),
    "click [data-act=lock]": async (e, el, ctx) => { if (await confirmSheet("Lock this pay period? The pay becomes final, its shifts are locked, and time added later goes to the next period.", { title: "Lock the period", yes: "Lock it" })) act(ctx, el, "lock", "Locking…"); },
    "click [data-act=unlock]": async (e, el, ctx) => { if (await confirmSheet("Unlock it? The pay is worked out again from the time, jobs and tips.", { title: "Unlock", yes: "Unlock" })) act(ctx, el, "unlock", "Unlocking…"); },
    "click [data-act=paid]": async (e, el, ctx) => { if (await confirmSheet("Mark this period paid? This only records it; nothing is sent anywhere.", { title: "Mark paid", yes: "Mark paid" })) act(ctx, el, "paid", "Saving…"); },
    "click [data-void]": async (e, el, ctx) => {
      if (!(await confirmSheet("Strike this line out? It won't be paid.", { title: "Strike out", yes: "Strike it out", danger: true }))) return;
      try { await ctx.api(`/payroll/lines/${encodeURIComponent(el.dataset.void)}/void`, { method: "POST", body: {} }); ctx.refresh(); } catch (err) { toast(err.message || "That didn't work.", { bad: true }); }
    },
    "click [data-person] summary": (e, el, ctx) => { const d = el.closest("details"); if (d) ctx.keep.open = { ...(ctx.keep.open || {}), [d.dataset.person]: !d.open }; },
  },
};
