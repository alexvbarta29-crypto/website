// One expense, new or saved (Flyra's): the receipt photo (the camera, or a
// file), the amount, the day, the category, the vendor and a note. Saved
// once per tap (a client id); the receipt uploads after (it belongs to the
// expense). The round "..." deletes it.

import { html, attrs, toast, confirmSheet, pillBtn } from "../../core/ui.js";
import { readForm, showError, clearErrors, busy, readMoney } from "../../core/forms.js";
import { capture, uploadPhoto, photoTile } from "../../core/camera.js";
import { ensureStyles, CATS, localToday } from "./kit.js";

const cid = () => (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : `ex-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);

async function load(params, ctx) {
  ensureStyles();
  if (!params.id) return { expense: null, client_id: cid(), file: null, today: ctx.keep.today || localToday() };
  const r = await ctx.api(`/expenses/${encodeURIComponent(params.id)}`, { cache: false });
  return { expense: r.data.expense, etag: r.etag, file: null, today: localToday() };
}

export default {
  title: (s) => (s && s.expense ? "Expense" : "New expense"),
  load,
  more: (s, ctx) => (s && s.expense && ctx.can("expenses:write") ? [[{ label: "Delete the expense", icon: "trash", danger: true, run: () => del(ctx), data: { "ex-del": true } }]] : []),
  render(s, ctx) {
    const e = s.expense || {};
    const may = ctx.can("expenses:write");
    return html`<div class="rs-page ex-one"><form class="form" data-ex-f novalidate>
      <div class="err" data-form-err hidden></div>
      <div class="field ex-receipt"><span>Receipt</span>
        ${e.receipt_id ? html`<div class="sv-photos">${photoTile(e.receipt_id, { alt: "The receipt" })}</div>` : ""}
        ${may ? pillBtn(s.file ? `Receipt: ${s.file.name || "photo"} (tap to change)` : e.receipt_id ? "A new photo" : "Take a photo of the receipt", { icon: "camera", data: { "ex-cam": true } }) : ""}</div>
      <label class="field" data-field="amount_cents"><span>Amount</span><input name="amount" inputmode="decimal" autocomplete="off" placeholder="45.99" ${attrs({ value: e.amount_cents ? (e.amount_cents / 100).toFixed(2) : "", disabled: !may })}><small class="why" hidden></small></label>
      <label class="field" data-field="date"><span>Day</span><input type="date" name="date" ${attrs({ value: e.date || s.today, max: s.today, disabled: !may })}><small class="why" hidden></small></label>
      <label class="field" data-field="category"><span>Category</span><select name="category" ${attrs({ disabled: !may })}>${CATS.map(([k, l]) => html`<option ${attrs({ value: k, selected: k === (e.category || "supplies") })}>${l}</option>`)}</select></label>
      <label class="field" data-field="vendor"><span>Where</span><input name="vendor" maxlength="120" autocomplete="off" placeholder="The store" ${attrs({ value: e.vendor || "", disabled: !may })}><small class="why" hidden></small></label>
      <label class="field" data-field="note"><span>Note</span><textarea name="note" rows="2" maxlength="1000" ${attrs({ disabled: !may })}>${e.note || ""}</textarea></label>
      ${may ? html`<button type="submit" class="btn primary block">${s.expense ? "Save" : "Add the expense"}</button>` : ""}
    </form></div>`;
  },
  events: {
    "click [data-ex-cam]": async (e, el, ctx) => {
      const f = await capture({ accept: "image/*,application/pdf" });
      if (f) { ctx.state.file = f; ctx.rerender(); }
    },
    "submit [data-ex-f]": async (e, form, ctx) => {
      e.preventDefault();
      clearErrors(form);
      const s = ctx.state;
      const v = readForm(form);
      const amount = readMoney(v.amount);
      if (!(amount > 0)) { showError(form, { field: "amount_cents", message: "Enter the amount, like 45.99." }); return; }
      const body = { amount_cents: amount, date: v.date, category: v.category, vendor: v.vendor, note: v.note };
      const btn = form.querySelector("[type=submit]");
      busy(btn, true);
      try {
        const r = s.expense
          ? await ctx.api(`/expenses/${encodeURIComponent(s.expense.id)}`, { method: "PATCH", body, ifMatch: s.etag })
          : await ctx.api("/expenses", { method: "POST", body: { ...body, client_id: s.client_id } });
        let ex = r.data.expense;
        if (s.file) {
          try {
            const up = await uploadPhoto({ ownerType: "expense", ownerId: ex.id, kind: "photo", file: s.file });
            const fresh = await ctx.api(`/expenses/${encodeURIComponent(ex.id)}`, { cache: false });
            await ctx.api(`/expenses/${encodeURIComponent(ex.id)}`, { method: "PATCH", body: { receipt_id: up.file.id }, ifMatch: fresh.etag });
          } catch (err) { toast(`Saved, but the receipt didn't upload: ${err.message || "try again"}`, { bad: true }); }
        }
        toast(s.expense ? "Saved" : "Expense added");
        ctx.go(`/expenses`, { replace: !s.expense });
      } catch (err) { busy(btn, false); showError(form, err.status === 412 ? { message: "Someone else just changed it. Go back and look again." } : err); }
    },
  },
};

async function del(ctx) {
  if (!(await confirmSheet("Delete this expense?", { title: "Delete", yes: "Delete", danger: true }))) return;
  try { await ctx.api(`/expenses/${encodeURIComponent(ctx.state.expense.id)}`, { method: "DELETE" }); toast("Deleted"); ctx.go("/expenses", { replace: true }); }
  catch (err) { toast(err.message || "That didn't delete.", { bad: true }); }
}
