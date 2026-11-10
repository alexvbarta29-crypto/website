// New lead and Edit contact (design §9.2 "Contact edit / New lead"): name,
// phones, emails, address, source, how they heard, tags, text consent,
// notes. Saving a new contact that shares a phone or an email (or the same
// name and ZIP) with someone on file shows "Possible duplicate" first, with
// the matches to open, or Save anyway. An edit carries the version it
// started from: if someone changed the contact meanwhile, nothing is
// overwritten ("Someone else just changed this").
// The street is typed (no address lookup in v1: the CRM's pages only talk
// to this site).

import { html, sheet, toast, attrs } from "../../core/ui.js";
import { field, select, checkbox, readForm, clearErrors, showError, busy } from "../../core/forms.js";
import { uuid } from "../../core/api.js";
import { ensureStyles, SOURCES, CHANNELS, forgetIndex, cachedRows, phoneText } from "./kit.js";

const PHONE_LABELS = [{ value: "mobile", label: "Mobile" }, { value: "home", label: "Home" }, { value: "work", label: "Work" }, { value: "other", label: "Other" }];

async function load(params, ctx) {
  ensureStyles();
  if (!params.id) return { isNew: true, c: { phones: [], emails: [], tags: [], source: { source: "Phone Call" }, lifecycle: "lead" }, clientId: ctx.keep.clientId || (ctx.keep.clientId = uuid()) };
  const r = await ctx.api(`/contacts/${encodeURIComponent(params.id)}`, { cache: false });
  return { isNew: false, c: r.data.contact, etag: r.etag };
}

const phoneRow = (p, i) => html`<div class="grid2" data-phone-row>
  ${field({ label: i === 0 ? "Phone" : "Another phone", name: `phone_${i}`, type: "tel", value: p.e164 ? phoneText(p.e164) : "" })}
  ${select({ label: "Kind", name: `phone_label_${i}`, value: p.label || "mobile", options: PHONE_LABELS })}
</div>`;

function tagSuggestions(c) {
  const rows = cachedRows() || [];
  const counts = new Map();
  for (const r of rows) for (const t of r.tg || []) counts.set(t, (counts.get(t) || 0) + 1);
  const have = new Set((c.tags || []).map((t) => t.toLowerCase()));
  return [...counts].sort((a, b) => b[1] - a[1]).map(([t]) => t).filter((t) => !have.has(t.toLowerCase())).slice(0, 10);
}

function render(s, ctx) {
  const c = s.c;
  const phones = (c.phones && c.phones.length ? c.phones : [{}]).concat(s.extraPhone ? [{}] : []).slice(0, 3);
  const a = c.billing_address || {};
  const src = c.source || {};
  const sugg = tagSuggestions(c);
  return html`<form class="form stack" id="ct-form" novalidate>
    <div class="err" data-form-err hidden></div>
    <section class="card form">
      <div class="grid2">${field({ label: "First name", name: "first_name", value: c.first_name || "", autocomplete: "given-name", autocapitalize: "words" })}${field({ label: "Last name", name: "last_name", value: c.last_name || "", autocomplete: "family-name", autocapitalize: "words" })}</div>
      ${field({ label: "Company (if a business)", name: "company_name", value: c.company_name || "", autocomplete: "organization" })}
    </section>
    <section class="card form">
      <div class="multi" data-field="phones">${phones.map(phoneRow)}</div>
      ${phones.length < 3 ? html`<button type="button" class="linkish" data-more-phone>Add another phone</button>` : ""}
      ${field({ label: "Email", name: "email", type: "email", value: (c.emails && c.emails[0] && c.emails[0].address) || "" })}
    </section>
    <section class="card form">
      ${field({ label: "Street", name: "street1", value: a.street1 || "", autocomplete: "address-line1" })}
      <div class="addr-grid">${field({ label: "Town", name: "city", value: a.city || "", autocomplete: "address-level2" })}${field({ label: "State", name: "state", value: a.state || "MN", autocomplete: "address-level1", maxlength: 2 })}${field({ label: "ZIP", name: "zip", value: a.zip || "", inputmode: "numeric", autocomplete: "postal-code", maxlength: 10 })}</div>
    </section>
    <section class="card form">
      ${s.isNew ? select({ label: "This is", name: "lifecycle", value: c.lifecycle || "lead", options: [{ value: "lead", label: "A lead (wants a quote)" }, { value: "customer", label: "A customer" }] }) : ""}
      ${select({ label: "Where they came from", name: "source", value: src.source || "Other", options: SOURCES.map((x) => ({ value: x, label: x })) })}
      ${select({ label: "How they heard about us (optional)", name: "channel", value: src.channel || "", options: [{ value: "", label: "Not asked" }, ...CHANNELS.map((x) => ({ value: x, label: x }))] })}
      ${field({ label: "Tags (commas between)", name: "tags", value: (c.tags || []).join(", "), autocapitalize: "words" })}
      ${sugg.length ? html`<div class="varchips">${sugg.map((t) => html`<button type="button" ${attrs({ "data-addtag": t })}>+ ${t}</button>`)}</div>` : ""}
      ${s.isNew ? checkbox({ label: "OK to text them about their quote and visits", name: "sms_service", checked: true }) : ""}
    </section>
    <section class="card form">
      <label class="field" data-field="notes"><span>Notes</span><textarea name="notes" rows="5">${c.notes || ""}</textarea><small class="why" hidden></small></label>
    </section>
    <button type="submit" class="btn primary block">${s.isNew ? "Save lead" : "Save"}</button>
  </form>`;
}

function collect(form, s) {
  const v = readForm(form);
  const phones = [];
  for (let i = 0; i < 3; i++) if (v[`phone_${i}`]) phones.push({ e164: v[`phone_${i}`], label: v[`phone_label_${i}`] || "mobile", primary: phones.length === 0 });
  const body = {
    first_name: v.first_name, last_name: v.last_name, company_name: v.company_name, phones,
    emails: v.email ? [{ address: v.email, primary: true }] : [],
    billing_address: v.street1 || v.city || v.zip ? { street1: v.street1, city: v.city, state: (v.state || "MN").toUpperCase(), zip: v.zip } : undefined,
    source: { ...(s.c.source || {}), source: v.source, ...(v.channel ? { channel: v.channel } : {}) },
    tags: String(v.tags || "").split(",").map((t) => t.trim()).filter(Boolean),
    notes: v.notes,
  };
  if (!v.channel && body.source) delete body.source.channel;
  if (s.isNew) {
    body.lifecycle = v.lifecycle;
    body.consent = { sms_service: !!v.sms_service };
    body.client_id = s.clientId;
  }
  return body;
}

function duplicateSheet(ctx, matches, onForce) {
  const s = sheet({
    title: "Possible duplicate",
    body: html`<p class="muted">Someone on file shares this ${matches.some((m) => m.reason === "phone") ? "phone" : matches.some((m) => m.reason === "email") ? "email" : "name"}. Open them instead, or save a new contact anyway.</p>
      <ul class="list dup-list">${matches.map((m) => html`<li><a class="row" ${attrs({ href: "#/contacts/" + encodeURIComponent(m.id) })} data-close><span class="who"><span class="nm">${m.name || "A contact"}</span><span class="sub">${{ phone: "Same phone", email: "Same email", name_zip: "Same name and ZIP", name: "Same name" }[m.reason] || m.reason}</span></span><span class="chev" aria-hidden="true"></span></a></li>`)}</ul>
      <button type="button" class="btn block" data-force>Save a new contact anyway</button>`,
    events: { "click [data-close]": () => s.close(), "click [data-force]": () => { s.close(); onForce(); } },
  });
}

async function save(ctx, form, force = false) {
  const s = ctx.state;
  clearErrors(form);
  const body = collect(form, s);
  const btn = form.querySelector("button[type=submit]");
  busy(btn, true);
  try {
    if (s.isNew) {
      const r = await ctx.api("/contacts", { method: "POST", body: { ...body, ...(force ? { force: true } : {}) } });
      ctx.keep.clientId = null;
      forgetIndex();
      toast("Saved");
      ctx.go(`/contacts/${r.data.contact.id}`, { replace: true });
    } else {
      await ctx.api(`/contacts/${encodeURIComponent(s.c.id)}`, { method: "PATCH", body, ifMatch: s.etag });
      forgetIndex();
      toast("Saved");
      ctx.back();
    }
  } catch (err) {
    busy(btn, false);
    if (err.code === "possible_duplicate" && err.details && err.details.matches) { duplicateSheet(ctx, err.details.matches, () => save(ctx, form, true)); return; }
    if (err.status === 412) { toast("Someone else just changed this contact. Showing the latest.", { bad: true }); ctx.refresh(); return; }
    showError(form, err.field && /^phones\.\d/.test(err.field) ? { ...err, field: "phones" } : err.field === "emails.0.address" ? { ...err, field: "email" } : err);
  }
}

export default {
  title: (s) => (s && s.isNew ? "New lead" : "Edit contact"),
  load,
  render,
  events: {
    "submit #ct-form": (e, form, ctx) => { e.preventDefault(); save(ctx, form); },
    "click [data-more-phone]": (e, el, ctx) => {
      // keep what was typed, then show one more phone row
      const form = document.getElementById("ct-form");
      const body = collect(form, ctx.state);
      Object.assign(ctx.state.c, { ...body, billing_address: body.billing_address || ctx.state.c.billing_address, emails: body.emails, phones: body.phones });
      ctx.state.extraPhone = true;
      ctx.rerender();
    },
    "click [data-addtag]": (e, el) => {
      const input = document.querySelector("#ct-form [name=tags]");
      const list = String(input.value || "").split(",").map((t) => t.trim()).filter(Boolean);
      if (!list.some((t) => t.toLowerCase() === el.dataset.addtag.toLowerCase())) list.push(el.dataset.addtag);
      input.value = list.join(", ");
      el.remove();
    },
  },
};
