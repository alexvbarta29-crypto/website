// New Invoice (Flyra's phone sheet, the owner's screenshot of Nov 15): a round
// X and "New Invoice"; Customer (the person tile, their name and phone, a
// clear button; the property under it with the house tile and a chevron to
// pick another); Line items ("Add line item", "Add discount"); the Total;
// the Salesperson (picked from the team, the signed-in person to start);
// Notes; and the sticky "Create Invoice", off until there is a customer and
// a line with a price. It makes a draft (POST /invoices) and opens it, where
// Mark as Sent, Send and Payment are. Invoices for finished jobs make
// themselves; this is for everything else (a late-cancel fee, a one-off).
// A full-screen sheet on a phone, a dialog on a desk; its X goes back.

import { html, attrs, sheet, toast } from "../../core/ui.js";
import { busy, showError, clearErrors, readMoney } from "../../core/forms.js";
import { money, phone as fmtPhone } from "../../core/format.js";
import { pickContact, pickFrom } from "../../core/pickers.js";
import { uuid } from "../../core/api.js";
import { ensureStyles, MI } from "./kit.js";
import { qtyMilli } from "./invoice-edit.js";

async function contactOf(api, id) {
  const r = await api(`/contacts/${encodeURIComponent(id)}`, { cache: false }).catch(() => null);
  const c = r && r.data && r.data.contact;
  if (!c) return null;
  const props = ((r.data && r.data.properties) || []).filter((p) => p && p.address && !p.deleted_at);
  const ph = (c.phones || [])[0];
  return { id: c.id, name: c.display_name || [c.first_name, c.last_name].filter(Boolean).join(" ") || "This customer", phone: ph && ph.e164 ? ph.e164 : "", props };
}
const street = (p) => (p && p.address ? [p.address.street1, p.address.street2].filter(Boolean).join(", ") : "");
const town = (p) => (p && p.address ? [[p.address.city, p.address.state].filter(Boolean).join(", "), p.address.zip].filter(Boolean).join(" ") : "");

async function load(params, ctx) {
  ensureStyles();
  const contact = params.contact ? await contactOf(ctx.api, params.contact) : null;
  const me = ctx.user || {};
  return {
    contact, property_id: contact && contact.props[0] ? contact.props[0].id : null, lines: [], note: "", client_id: uuid(),
    salesperson: me.id ? { id: me.id, name: me.name || me.first_name || "Me" } : null,
  };
}

const lineCents = (l) => { const q = qtyMilli(l.qty); const u = readMoney(l.price); if (q === null || u === null) return null; const v = Math.round((q * Math.abs(u)) / 1000); return l.kind === "discount" ? -v : v; };
const totalOf = (st) => Math.max(0, st.lines.reduce((s, l) => s + (lineCents(l) || 0), 0));
const ready = (st) => !!st.contact && st.lines.some((l) => l.kind !== "discount" && l.description.trim() && (lineCents(l) || 0) > 0);

function customerCard(st) {
  const c = st.contact;
  if (!c) return html`<button type="button" class="mn-nv-card mn-nv-row" data-nv-pick><span class="mn-nv-tile">${MI.user}</span><span class="mn-nv-t"><b>Pick a customer</b></span><span class="mn-nv-chev" aria-hidden="true">${MI.chev}</span></button>`;
  const p = c.props.find((x) => x.id === st.property_id) || null;
  return html`<div class="mn-nv-card">
    <div class="mn-nv-row"><span class="mn-nv-tile">${MI.user}</span><span class="mn-nv-t"><b>${c.name}</b>${c.phone ? html`<small>${fmtPhone(c.phone)}</small>` : ""}</span><button type="button" class="mn-nv-clr" data-nv-clear aria-label="Clear the customer">${MI.xc}</button></div>
    <button type="button" class="mn-nv-row mn-nv-prop" data-nv-prop ${attrs({ disabled: c.props.length < 2 && !!p })}><span class="mn-nv-tile">${MI.home}</span><span class="mn-nv-t">${p ? html`<b>${street(p)}</b><small>${town(p)}</small>` : html`<b>No property</b><small>${c.props.length ? "Pick one" : "None on file"}</small>`}</span><span class="mn-nv-chev" aria-hidden="true">${MI.chev}</span></button>
  </div>`;
}

function lineCard(l, i) {
  const t = lineCents(l);
  const disc = l.kind === "discount";
  return html`<div class="mn-nv-card mn-nv-line" ${attrs({ "data-line": String(i) })}>
    <div class="mn-nv-lr" ${attrs({ "data-field": `lines.${i}.description` })}><input class="mn-ed-in" data-desc maxlength="200" autocomplete="off" ${attrs({ value: l.description, placeholder: disc ? "Discount" : "What is it for?", "aria-label": `Line ${i + 1}: description` })}><button type="button" class="mn-ed-bin" ${attrs({ "data-rm": String(i), "aria-label": `Remove line ${i + 1}` })}>${MI.bin}</button><small class="why" hidden></small></div>
    <div class="mn-nv-lr2">
      ${disc ? "" : html`<label class="mn-ed-q"><input class="mn-ed-in" data-qty inputmode="decimal" autocomplete="off" ${attrs({ value: l.qty, "aria-label": `Line ${i + 1}: quantity` })}></label>`}
      <label class="mn-ed-p" ${attrs({ "data-field": `lines.${i}.unit_cents` })}><input class="mn-ed-in" data-price inputmode="decimal" autocomplete="off" ${attrs({ value: l.price, placeholder: disc ? "Amount off" : "Price", "aria-label": `Line ${i + 1}: ${disc ? "amount off" : "price"}` })}><small class="why" hidden></small></label>
      <span ${attrs({ class: "mn-ed-lt num" + (disc ? " green" : ""), "data-lt": String(i) })}>${t === null ? "-" : money(t)}</span>
    </div>
  </div>`;
}

function view(st) {
  return html`<form class="mn-nv" data-new novalidate>
    <p class="mn-nv-l">Customer</p>
    ${customerCard(st)}
    <p class="err" data-contact-err hidden></p>
    <p class="mn-nv-l">Line items</p>
    ${st.lines.map((l, i) => lineCard(l, i))}
    <button type="button" class="mn-nv-card mn-nv-row mn-nv-add" data-add><span class="mn-nv-ic">${MI.plusc}</span><b>Add line item</b></button>
    <button type="button" class="mn-nv-card mn-nv-row mn-nv-add mn-nv-gap" data-add-disc><span class="mn-nv-ic">${MI.tag}</span><b>Add discount</b></button>
    <div class="mn-nv-card mn-nv-tot"><span>Total</span><span class="num" data-total>${money(totalOf(st))}</span></div>
    <button type="button" class="mn-nv-card mn-nv-row mn-nv-sp" data-nv-sales><b>Salesperson</b><span class="mn-nv-v">${st.salesperson ? st.salesperson.name : "Nobody"}</span><span class="mn-nv-ud" aria-hidden="true">${MI.updown}</span></button>
    <label class="mn-nv-l" for="mn-nv-note">Notes</label>
    <textarea class="mn-ed-in mn-nv-note" id="mn-nv-note" name="note" rows="4" maxlength="1000" placeholder="Add a note">${st.note}</textarea>
    <p class="err" data-form-err hidden></p>
    <div class="mn-nv-cta"><button type="submit" class="mn-nv-go" data-go ${attrs({ disabled: !ready(st) })}>Create Invoice</button></div>
  </form>`;
}

// keeps what was typed before a redraw
function sync(root, st) {
  root.querySelectorAll("[data-line]").forEach((row) => {
    const l = st.lines[Number(row.dataset.line)];
    if (!l) return;
    l.description = row.querySelector("[data-desc]").value;
    l.price = row.querySelector("[data-price]").value;
    const q = row.querySelector("[data-qty]");
    if (q) l.qty = q.value;
  });
  const n = root.querySelector("[name=note]");
  if (n) st.note = n.value;
}

let open = null;
let leaving = false;

function openNew(ctx) {
  const st = ctx.state;
  const draw = () => { sh.set(view(st)); };
  const refresh = () => {
    const t = sh.el.querySelector("[data-total]");
    if (t) t.textContent = money(totalOf(st));
    st.lines.forEach((l, i) => { const el = sh.el.querySelector(`[data-lt="${i}"]`); if (el) { const v = lineCents(l); el.textContent = v === null ? "-" : money(v); } });
    const go = sh.el.querySelector("[data-go]");
    if (go) go.disabled = !ready(st);
  };
  const focusLast = (sel) => { const all = sh.el.querySelectorAll(sel); if (all.length) all[all.length - 1].focus(); };
  const sh = sheet({
    title: "New Invoice",
    className: "mn-fs mn-nvsheet",
    body: view(st),
    onClose: () => { open = null; if (!leaving) ctx.back(); },
    events: {
      "click [data-nv-pick]": async () => {
        sync(sh.el, st);
        const c = await pickContact(ctx.api, { title: "Who is it for?" });
        if (!c) return;
        st.contact = (await contactOf(ctx.api, c.id)) || { id: c.id, name: c.name, phone: "", props: [] };
        st.property_id = st.contact.props[0] ? st.contact.props[0].id : null;
        draw();
      },
      "click [data-nv-clear]": () => { sync(sh.el, st); st.contact = null; st.property_id = null; draw(); },
      "click [data-nv-prop]": async () => {
        sync(sh.el, st);
        const p = await pickFrom({ title: "Which property?", items: st.contact.props.map((x) => ({ value: x.id, label: street(x) || "Property", sub: town(x) })) });
        if (p) { st.property_id = p; draw(); }
      },
      "click [data-nv-sales]": async () => {
        sync(sh.el, st);
        let team = [];
        try { team = ((await ctx.api("/users")).data || []).filter((u) => !u.status || u.status === "active"); } catch (e) { team = []; }
        const u = await pickFrom({ title: "Salesperson", items: [{ value: { id: null, name: "Nobody" }, label: "Nobody" }, ...team.map((x) => ({ value: { id: x.id, name: x.name }, label: x.name }))] });
        if (u) { st.salesperson = u.id ? u : null; draw(); }
      },
      "click [data-add]": () => { sync(sh.el, st); if (st.lines.length < 20) st.lines.push({ kind: "service", description: "", qty: "1", price: "" }); draw(); focusLast("[data-line] [data-desc]"); },
      "click [data-add-disc]": () => { sync(sh.el, st); if (st.lines.length < 20) st.lines.push({ kind: "discount", description: "Discount", qty: "1", price: "" }); draw(); focusLast("[data-line] [data-price]"); },
      "click [data-rm]": (e, el) => { sync(sh.el, st); st.lines.splice(Number(el.dataset.rm), 1); draw(); },
      "input [data-line]": () => { sync(sh.el, st); refresh(); },
      "submit [data-new]": async (e, form) => {
        e.preventDefault();
        sync(form, st);
        clearErrors(form);
        const ce = form.querySelector("[data-contact-err]");
        ce.hidden = true;
        if (!st.contact) { ce.textContent = "Pick the customer first."; ce.hidden = false; return; }
        const lines = [];
        for (const [i, l] of st.lines.entries()) {
          if (!l.description.trim() && !l.price.trim()) continue;
          const cents = readMoney(l.price);
          const q = l.kind === "discount" ? 1000 : qtyMilli(l.qty);
          if (!l.description.trim()) { showError(form, { field: `lines.${i}.description`, message: "What is it for?" }); return; }
          if (cents === null || cents === 0) { showError(form, { field: `lines.${i}.unit_cents`, message: "Enter a price." }); return; }
          if (q === null) { showError(form, { field: `lines.${i}.unit_cents`, message: "A quantity, like 1 or 2.5." }); return; }
          lines.push({ description: l.description.trim(), unit_cents: Math.abs(cents), qty_milli: q, kind: l.kind === "discount" || cents < 0 ? "discount" : "service" });
        }
        if (!lines.some((l) => l.kind !== "discount")) { showError(form, { message: "Add a line item with a price." }); return; }
        const btn = form.querySelector("[data-go]");
        busy(btn, true, "Creating…");
        try {
          const r = await ctx.api("/invoices", {
            method: "POST", idempotencyKey: st.client_id,
            body: { contact_id: st.contact.id, lines, issue: false, client_id: st.client_id, ...(st.property_id ? { property_id: st.property_id } : {}), ...(st.salesperson && st.salesperson.id ? { salesperson_id: st.salesperson.id } : {}), ...(st.note.trim() ? { customer_note: st.note.trim() } : {}) },
          });
          toast("Invoice created");
          leaving = true;
          sh.close();
          ctx.go(`/invoices/${r.data.invoice.id}`, { replace: true });
        } catch (err) { busy(btn, false); showError(form, err); }
      },
    },
  });
  return sh;
}

export default {
  load,
  // the page under the sheet (seen only for a moment, or after a sheet was closed by the system)
  render() {
    return html`<div class="rs-page"><section class="rs-card"><p class="rs-sub">New Invoice</p></section></div>`;
  },
  mount(el, st, ctx) {
    leaving = false;
    if (!open) open = openNew(ctx);
  },
  unmount() {
    if (!open) return;
    leaving = true;
    try { open.close(); } catch (e) { /* gone */ }
    open = null;
  },
};
