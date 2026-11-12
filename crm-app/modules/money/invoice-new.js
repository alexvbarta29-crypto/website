// A new invoice by hand (design §5.6 POST /invoices): the customer, one or
// more lines (what, price), then save it as a draft to look over or issue it
// right away. Invoices for finished jobs make themselves; this is for
// everything else (a late-cancel fee, a one-off charge).

import { html, attrs, icon, toast } from "../../core/ui.js";
import { busy, showError, clearErrors, readMoney } from "../../core/forms.js";
import { money } from "../../core/format.js";
import { pickContact } from "../../core/pickers.js";
import { uuid } from "../../core/api.js";
import { ensureStyles } from "./kit.js";

async function load(params, ctx) {
  ensureStyles();
  let contact = null;
  if (params.contact) {
    const r = await ctx.api(`/contacts/${encodeURIComponent(params.contact)}`, { cache: false }).catch(() => null);
    const c = r && r.data && r.data.contact;
    if (c) contact = { id: c.id, name: c.display_name || [c.first_name, c.last_name].filter(Boolean).join(" ") || "This customer" };
  }
  return { contact, lines: [{ description: "", price: "" }], kind: "standard", client_id: uuid() };
}

const total = (s) => s.lines.reduce((sum, l) => sum + (readMoney(l.price) || 0), 0);

// keeps what was typed before a repaint
function sync(view, s) {
  view.querySelectorAll("[data-line]").forEach((row) => {
    const i = Number(row.dataset.line);
    if (!s.lines[i]) return;
    s.lines[i].description = row.querySelector("[data-desc]").value;
    s.lines[i].price = row.querySelector("[data-price]").value;
  });
  const fee = view.querySelector("[name=kind]");
  if (fee) s.kind = fee.checked ? "fee" : "standard";
}

export default {
  load,
  render(s) {
    return html`<form class="stack form" data-new novalidate>
      <section class="card"><h2>Who is it for?</h2>
        <button type="button" class="btn" data-pick>${icon("contacts")}${s.contact ? s.contact.name : "Pick the customer"}</button>
        <p class="err" data-contact-err hidden></p>
      </section>
      <section class="card"><h2>What for?</h2>
        ${s.lines.map((l, i) => html`<div class="mn-newline" ${attrs({ "data-line": String(i) })}>
          <label class="field" ${attrs({ "data-field": `lines.${i}.description` })}><span>${i === 0 ? "What" : html`<span class="sr">What</span>`}</span><input data-desc autocomplete="off" maxlength="200" placeholder="Exterior window cleaning" ${attrs({ value: l.description })}><small class="why" hidden></small></label>
          <label class="field" ${attrs({ "data-field": `lines.${i}.unit_cents` })}><span>${i === 0 ? "Price" : html`<span class="sr">Price</span>`}</span><input data-price inputmode="decimal" autocomplete="off" placeholder="0.00" ${attrs({ value: l.price })}><small class="why" hidden></small></label>
          <button type="button" class="rm" ${attrs({ "data-rm": String(i), "aria-label": "Remove this line", disabled: s.lines.length < 2 })}>×</button></div>`)}
        <div class="btn-row"><button type="button" class="btn" data-add>${icon("plus")}Another line</button></div>
        <ul class="mn-lines"><li class="tot big"><span class="d">Total</span><span class="a" data-total>${money(total(s))}</span></li></ul>
        <label class="check"><input type="checkbox" name="kind" ${attrs({ checked: s.kind === "fee" })}><span>This is a fee (a late cancel, say), not a service</span></label>
      </section>
      <p class="err" data-form-err hidden></p>
      <div class="btn-row"><button type="submit" class="btn primary" data-go="issue">Issue and send</button><button type="submit" class="btn" data-go="draft">Save as a draft</button></div>
    </form>`;
  },
  events: {
    "click [data-pick]": async (e, el, ctx) => {
      sync(document.querySelector("[data-new]"), ctx.state);
      const c = await pickContact(ctx.api, { title: "Who is it for?" });
      if (c) { ctx.state.contact = c; ctx.rerender(); }
    },
    "click [data-add]": (e, el, ctx) => { sync(el.closest("form"), ctx.state); if (ctx.state.lines.length < 20) ctx.state.lines.push({ description: "", price: "" }); ctx.rerender(); },
    "click [data-rm]": (e, el, ctx) => { sync(el.closest("form"), ctx.state); ctx.state.lines.splice(Number(el.dataset.rm), 1); ctx.rerender(); },
    "input [data-price]": (e, el, ctx) => { sync(el.closest("form"), ctx.state); const t = el.closest("form").querySelector("[data-total]"); if (t) t.textContent = money(total(ctx.state)); },
    "submit [data-new]": async (e, form, ctx) => {
      e.preventDefault();
      const s = ctx.state;
      sync(form, s);
      clearErrors(form);
      const issue = !(e.submitter && e.submitter.dataset.go === "draft");
      const ce = form.querySelector("[data-contact-err]");
      ce.hidden = true;
      if (!s.contact) { ce.textContent = "Pick the customer first."; ce.hidden = false; return; }
      const lines = [];
      for (const [i, l] of s.lines.entries()) {
        if (!l.description.trim() && !l.price.trim() && s.lines.length > 1) continue;
        const cents = readMoney(l.price);
        if (!l.description.trim()) { showError(form, { field: `lines.${i}.description`, message: "What is it for?" }); return; }
        if (cents === null || cents <= 0) { showError(form, { field: `lines.${i}.unit_cents`, message: "Enter a price." }); return; }
        lines.push({ description: l.description.trim(), unit_cents: cents, kind: s.kind === "fee" ? "fee" : "service" });
      }
      if (!lines.length) { showError(form, { message: "Add at least one line." }); return; }
      const btn = e.submitter || form.querySelector("button[type=submit]");
      busy(btn, true);
      try {
        const r = await ctx.api("/invoices", { method: "POST", body: { contact_id: s.contact.id, kind: s.kind, lines, issue, client_id: s.client_id }, idempotencyKey: s.client_id });
        toast(issue ? "Invoice issued" : "Draft saved");
        ctx.go(`/invoices/${r.data.invoice.id}`, { replace: true });
      } catch (err) { busy(btn, false); showError(form, err); }
    },
  },
};
