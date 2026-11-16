// One quote (design §9.2 "Quote view"; Rotor's look, Nov 2026: a top card
// with the price, Send and Present, the customer, Options | Activity, the
// round pencil (Edit) and "..." for the rest): its status and what happened when
// (sent, viewed, approved...), the customer's view of the version they
// have, the versions, the linked deal, plan or jobs; and what to do next:
// Edit, Send (text and/or email), Present to customer (a single-use page
// opened on this phone), Approve by phone, Convert, Archive, Restore,
// Decline, Duplicate, Preview as the customer sees it. On a Christmas
// lights quote, Mockup makes the mockup of the house (mockup.js); "..." has
// "Save as a template" (estimate templates, the owner, Nov 16).

import { html, attrs, icon, sheet, toast, confirmSheet, openExternal, seg, cardHead, sectionLabel, personCard, lineItems, pillBtn, disclosure, statusPill as kitPill } from "../../core/ui.js";
import { busy } from "../../core/forms.js";
import { money, dateShort, dateTime, ago, phone } from "../../core/format.js";
import { ensureStyles, statusPill, waitRun, STATUS, emptyCard, optionTotals, lineTotal, headline, visitsOf, scopeWords, discountText, PLAN_FREQ } from "./kit.js";
import { openMockup } from "./mockup.js";

const isLights = (q) => (q.options || []).some((o) => (o.lines || []).some((l) => l.category === "lights" || /christmas lights/i.test(l.service_type || "")));
const propertyFor = (s) => s.quote.property_id || ((s.properties || [])[0] || {}).id || null;

async function load(params, ctx) {
  ensureStyles();
  const r = await ctx.api(`/quotes/${encodeURIComponent(params.id)}`, { cache: false });
  return { ...r.data, etag: r.etag, can_mockup: ctx.can("quotes:write") };
}

function timeline(q) {
  const ev = [["Made", q.created_at]];
  if (q.sent_at) ev.push([`Sent${(q.sent_via || []).length ? ` by ${q.sent_via.map((c) => (c === "sms" ? "text" : "email")).join(" and ")}` : " (shown in person)"}`, q.sent_at]);
  if (q.viewed_at) ev.push(["Opened by the customer", q.viewed_at]);
  if (q.changes_requested_at) ev.push(["Asked for changes", q.changes_requested_at]);
  if (q.approved_at) ev.push([`Approved${q.approval && q.approval.method === "phone" ? " by phone" : q.approval && q.approval.method === "in_person" ? " in person" : ""}`, q.approved_at]);
  if (q.declined_at) ev.push(["Declined", q.declined_at]);
  if (q.converted_at) ev.push(["Booked", q.converted_at]);
  if (q.archived_at) ev.push([`Archived${q.archive_reason === "expired" ? " (expired)" : q.archive_reason === "cadence_expired" ? " (follow-up ended)" : ""}`, q.archived_at]);
  return ev.filter(([, at]) => at).sort((a, b) => String(a[1]).localeCompare(String(b[1])));
}

const editable = (st) => ["draft", "changes_requested", "sent", "viewed"].includes(st);
const sendable = (st) => ["draft", "sent", "viewed", "changes_requested"].includes(st);

function waiting(s) {
  const q = s.quote;
  if (q.status !== "approved" || s.convertible) return "";
  const v = s.current_version;
  const o = v && q.approval ? (v.options || []).find((x) => x.id === q.approval.option_id) : null;
  const plan = o && o.kind === "plan";
  return html`<p class="note">${plan ? "This plan option can't be made into a plan from here yet." : "This can't be made into a job from here yet."} The approval is saved.</p>`;
}

const optionsOf = (s) => ((s.current_version && s.current_version.options) || s.quote.options || []);
const chosen = (s, o) => ["approved", "converted"].includes(s.quote.status) && s.quote.approval && s.quote.approval.option_id === o.id && s.quote.approval.totals
  ? { ...o, totals: s.quote.approval.totals, recommended: false, chosen: true } : o;

// The top card: status pills, good through, the headline price, Send and Present.
function topCard(s, ctx) {
  const q = s.quote;
  const st = q.status;
  const opts = optionsOf(s).map((o) => chosen(s, o));
  const lead = opts.find((o) => o.chosen) || opts.find((o) => o.recommended) || opts[0];
  const h = lead ? headline(lead) : null;
  const send = ctx.can("quotes:send") && sendable(st);
  const w = ctx.can("quotes:write");
  return html`<section class="rs-card qt-top">
    <div class="rs-row"><span class="rs-pills">${statusPill(st)}${q.viewed_at && st === "sent" ? kitPill("Viewed") : ""}</span>${q.expires_on && ["sent", "viewed"].includes(st) ? html`<span class="rs-sub">Good through ${dateShort(q.expires_on)}</span>` : ""}</div>
    ${lead ? html`<p class="qt-what">${lead.name}${lead.chosen ? " (chosen)" : ""}</p>` : ""}
    <div class="rs-kv"><span>${h ? (h.unit === "total" ? "Total" : h.unit === "a visit" ? "A visit" : "First visit") : "Total"}</span><span class="rs-amt">${h ? h.main : money(0)}</span></div>
    ${h && h.sub ? html`<p class="rs-sub qt-sub">${h.sub}</p>` : ""}
    ${st === "draft" && q.current_version_id ? html`<p class="warn-box">Changed since it was sent. The customer still sees version ${s.current_version ? s.current_version.n : ""} until you send it again.</p>` : ""}
    ${send || (st === "approved" && w && s.convertible) ? html`<div class="qt-top-acts">
      ${st === "approved" && w && s.convertible ? pillBtn("Book it", { tone: "solid", icon: "check", data: { act: "convert" } }) : ""}
      ${send ? pillBtn(q.sent_at ? "Send again" : "Send", { tone: "solid", icon: "send", data: { act: "send" } }) : ""}
      ${send ? pillBtn("Present", { icon: "phone", data: { act: "present" }, aria: "Present to customer on this phone" }) : ""}
    </div>` : ""}
  </section>`;
}

function optionCard(o) {
  const t = o.totals || optionTotals(o);
  const plan = o.kind === "plan";
  const v = visitsOf(o);
  const lines = (o.lines || []).map((l) => ({ title: l.optional ? `${l.title} (add-on)` : l.title, sub: [l.scope && l.scope.type !== "all" ? scopeWords(l.scope) : "", l.override ? l.override.reason : "", (l.qty_milli || 1000) !== 1000 ? `${(l.qty_milli || 0) / 1000} × ${money(l.unit_cents)}` : ""].filter(Boolean).join(" · "), amount: lineTotal(l) === 0 ? "Included" : lineTotal(l) }));
  return html`<section class="rs-card qt-opt2">
    <div class="rs-ch"><h3>${o.name}</h3><span class="rs-ch-end">${o.recommended ? kitPill("Recommended", "fill-green") : ""}${o.chosen ? kitPill("Chosen", "green") : ""}</span></div>
    ${plan && o.plan ? html`<p class="rs-sub">${PLAN_FREQ[o.plan.catalog_key] || ""}${o.plan.term_months ? ` · ${o.plan.term_months} months` : ""}</p>` : ""}
    ${lineItems(lines, { discounts: (o.discounts || []).map((d) => ({ label: d.name + (d.scope && d.scope.type !== "all" ? ` (${scopeWords(d.scope)})` : ""), amount: discountText(d) })), total: plan ? t.first_cents : t.first_cents, totalLabel: plan ? (new Set(t.per_visit_cents).size <= 1 ? "Each visit" : "First visit") : "Total" })}
    ${plan ? html`<div class="qt-value"><span class="rs-label">Plan value</span><span>${v.year} visit${v.year === 1 ? "" : "s"} a year · avg ${money(Math.round((t.annual_cents || 0) / Math.max(1, v.year)))} · ${money(t.annual_cents)}</span></div>` : ""}
    ${plan && t.per_visit_cents && new Set(t.per_visit_cents).size > 1 ? html`<p class="rs-sub">${t.per_visit_cents.slice(0, v.year).map((c, i) => `Visit ${i + 1}: ${money(c)}`).join(" · ")}</p>` : ""}
  </section>`;
}

function optionsPane(s) {
  const q = s.quote;
  const v = s.current_version;
  const options = optionsOf(s);
  return html`${q.status === "changes_requested" && q.change_message ? html`<section class="rs-card"><h3 class="qt-h3">They asked for changes</h3><p class="bubble">${q.change_message}</p></section>` : ""}
    ${q.status === "declined" && q.decline_reason ? html`<section class="rs-card"><h3 class="qt-h3">Declined</h3><p>${q.decline_reason}</p></section>` : ""}
    ${waiting(s)}
    <div class="rs-row qt-seen">${sectionLabel(v ? `What the customer sees (version ${v.n})` : "Options (not sent yet)")}${q.current_version_id ? html`<a class="rs-pb" ${attrs({ href: `/api/crm/quotes/${encodeURIComponent(q.id)}/preview`, target: "_blank", rel: "noopener" })}>${icon("share")}<span>Customer view</span></a>` : ""}</div>
    ${options.length ? options.map((o) => optionCard(chosen(s, o))) : emptyCard("No options yet", "Edit the quote to price it.")}
    ${isLights(q) && s.can_mockup ? html`<section class="rs-card qt-mk-card">${cardHead("Lights mockup")}<p class="rs-sub">${(q.mockup_file_ids || []).length ? `${q.mockup_file_ids.length} on the quote. Make another from Street View.` : "Their house from Street View with the lights on it, made for you."}</p><button type="button" class="btn block" data-act="mockup">${icon("bulb")}Mockup</button></section>` : ""}
    ${q.client_notes ? html`<section class="rs-card">${cardHead("Note to the customer")}<p class="preview">${q.client_notes}</p></section>` : ""}
    ${q.internal_notes ? html`<section class="rs-card">${cardHead("Office note")}<p class="preview">${q.internal_notes}</p></section>` : ""}`;
}

function activityPane(s) {
  const q = s.quote;
  const ct = q.converted_to || {};
  const links = [
    ct.plan_id && disclosure("Plan", { value: "Open the plan", href: "#/plans/" + encodeURIComponent(ct.plan_id) }),
    ...(ct.job_ids || []).slice(0, 4).map((j, i) => disclosure("Job", { value: (ct.job_ids || []).length > 1 ? `${i + 1} of ${ct.job_ids.length}` : "Open the job", href: "#/jobs/" + encodeURIComponent(j) })),
  ].filter(Boolean);
  return html`${links.length ? html`${sectionLabel("Booked as")}${links}` : ""}
    <section class="rs-card">${cardHead("What happened")}<ul class="qt-timeline">${timeline(q).map(([w, at], i, all) => html`<li><span class="${"dot" + (i === all.length - 1 ? " on" : "")}"></span><span class="w">${w}</span><span class="when">${dateTime(at)}</span></li>`)}</ul></section>
    ${(s.versions || []).length ? html`<section class="rs-card">${cardHead("Versions", { count: String(s.versions.length) })}<ul class="qt-timeline">${s.versions.map((x) => html`<li><span class="dot"></span><span class="w">Version ${x.n}${(x.sent_via || []).length ? ` · ${x.sent_via.map((ch) => (ch === "sms" ? "text" : "email")).join(" + ")}` : " · in person"}</span><span class="when">${ago(x.sent_at)}</span></li>`)}</ul></section>` : ""}`;
}

function moreRows(s, ctx) {
  const q = s.quote;
  const st = q.status;
  const w = ctx.can("quotes:write");
  const send = ctx.can("quotes:send") && sendable(st);
  const id = encodeURIComponent(q.id);
  return [
    [
      send && { label: q.sent_at ? "Send again" : "Send", icon: "send", run: () => sendSheet(ctx), data: { act: "send" } },
      send && { label: "Present to customer", icon: "phone", hint: "on this phone", run: () => present(null, ctx), data: { act: "present" } },
      sendable(st) && w && { label: "Approved by phone", icon: "check", run: () => phoneSheet(ctx), data: { act: "phone" } },
      st === "approved" && w && s.convertible && { label: "Book it", icon: "check", run: () => runAction(null, ctx, `/quotes/${id}/convert`, "Booked"), data: { act: "convert" } },
    ],
    [
      editable(st) && w && { label: "Edit", icon: "edit", href: `#/quotes/${id}/edit`, data: { act: "edit" } },
      w && { label: "Duplicate", icon: "copy", hint: "a new draft", run: () => duplicate(null, ctx), data: { act: "duplicate" } },
      w && isLights(q) && { label: "Lights mockup", icon: "bulb", hint: "of their house", run: () => mockup(ctx), data: { act: "mockup" } },
      ctx.can("settings:general") && (q.options || []).length && { label: "Save as a template", icon: "doc", hint: "for the next quote", run: () => saveTemplate(ctx), data: { act: "template" } },
      q.current_version_id && { label: "Customer view", icon: "share", hint: "opens a tab", run: () => window.open(`/api/crm/quotes/${id}/preview`, "_blank", "noopener"), data: { act: "preview" } },
      { label: "Open customer", icon: "user", href: "#/contacts/" + encodeURIComponent(q.contact_id) },
    ],
    [
      ["archived", "declined"].includes(st) && w && { label: "Restore", icon: "undo", hint: "back to draft", run: () => simple(null, ctx, "restore", "Back to draft"), data: { act: "restore" } },
      sendable(st) && w && { label: "Mark declined", icon: "close", danger: true, run: () => declineSheet(ctx), data: { act: "decline" } },
      st !== "converted" && st !== "archived" && w && { label: "Archive", icon: "trash", danger: true, run: () => archive(null, ctx), data: { act: "archive" } },
    ],
  ];
}

function mockup(ctx) {
  const s = ctx.state;
  const c = s.contact || {};
  openMockup(ctx, { propertyId: propertyFor(s), quoteId: s.quote.id, name: c.name || s.quote.contact_name, studio: ctx.can("office:tools"), onSaved: () => ctx.refresh() });
}

// "Save as a template": its options and note, for the next quote like it.
function saveTemplate(ctx) {
  const q = ctx.state.quote;
  const first = (q.options || []).find((o) => o.recommended) || (q.options || [])[0] || {};
  const sh = sheet({
    title: "Save as a template",
    body: html`<form class="form" data-tpl-save>
      <p class="muted">Its options, line items, discounts and note become a template in New Quote's "Start from a template". Prices come from the price book each time it's used.</p>
      <label class="field"><span>Name</span><input ${attrs({ name: "name", maxlength: 80, value: first.name || "", required: true, autocomplete: "off" })}></label>
      <label class="field"><span>One line about it (optional)</span><input ${attrs({ name: "summary", maxlength: 140, autocomplete: "off", placeholder: "What it is and who it's for" })}></label>
      <p class="err" data-form-err hidden></p>
      <button type="submit" class="btn primary block">Save the template</button>
    </form>`,
    events: {
      "submit [data-tpl-save]": async (e, form) => {
        e.preventDefault();
        const err = form.querySelector("[data-form-err]");
        const name = form.elements.name.value.trim();
        if (!name) { err.textContent = "Name the template."; err.hidden = false; return; }
        const btn = form.querySelector("[type=submit]");
        busy(btn, true, "Saving…");
        try {
          await ctx.api("/quote-templates", { method: "POST", body: { from_quote_id: q.id, name, summary: form.elements.summary.value.trim() } });
          sh.close();
          toast("Saved as a template");
        } catch (er) { busy(btn, false); err.textContent = er.message; err.hidden = false; }
      },
    },
  });
}

async function archive(el, ctx) {
  if (!(await confirmSheet("The customer's link stops taking approvals, and any follow-up offers end.", { title: "Archive this quote?", yes: "Archive" }))) return;
  simple(el, ctx, "archive", "Archived");
}
async function duplicate(el, ctx) {
  busy(el, true);
  try {
    const r = await ctx.api(`/quotes/${encodeURIComponent(ctx.state.quote.id)}/duplicate`, { method: "POST", body: {} });
    toast("Copied to a new draft");
    ctx.go(`/quotes/${encodeURIComponent(r.data.id)}/edit`);
  } catch (err) { busy(el, false); toast(err.message, { bad: true }); }
}

export default {
  title: (s) => (s && s.quote ? `Quote ${s.quote.number_label}` : "Quote"),
  load,
  tools: (s, ctx) => [editable(s.quote.status) && ctx.can("quotes:write") && { icon: "edit", label: "Edit the quote", href: `#/quotes/${encodeURIComponent(s.quote.id)}/edit`, data: { "edit-quote": true } }],
  more: (s, ctx) => moreRows(s, ctx),
  moreTitle: (s) => (s && s.quote ? `Quote ${s.quote.number_label}` : "Quote"),
  render(s, ctx) {
    const q = s.quote;
    const c = s.contact || {};
    const prop = (s.properties || []).find((p) => p.id === q.property_id);
    const tab = s.tab || ctx.keep.tab || "options";
    return html`<div class="rs-page qt-page">
      ${topCard(s, ctx)}
      ${personCard({ name: c.name || q.contact_name || "Contact", sub: [prop && prop.address, c.phone && phone(c.phone)].filter(Boolean).join(" · "), href: "#/contacts/" + encodeURIComponent(q.contact_id), call: c.phone ? "tel:" + c.phone : null, text: c.phone ? "sms:" + c.phone : null })}
      ${seg([["options", "Options"], ["activity", "Activity"]], tab, { name: "quote", label: "Quote" })}
      ${tab === "activity" ? activityPane(s) : optionsPane(s)}
    </div>`;
  },
  events: {
    "click [data-seg=quote]": (e, el, ctx) => { ctx.state.tab = ctx.keep.tab = el.dataset.key; ctx.rerender(); },
    "click [data-act=send]": (e, el, ctx) => sendSheet(ctx),
    "click [data-act=present]": (e, el, ctx) => present(el, ctx),
    "click [data-act=convert]": (e, el, ctx) => runAction(el, ctx, `/quotes/${encodeURIComponent(ctx.state.quote.id)}/convert`, "Booked"),
    "click .qt-mk-card [data-act=mockup]": (e, el, ctx) => mockup(ctx),
  },
};

async function simple(el, ctx, what, done) {
  busy(el, true);
  try {
    await ctx.api(`/quotes/${encodeURIComponent(ctx.state.quote.id)}/${what}`, { method: "POST", body: {} });
    toast(done);
    ctx.refresh();
  } catch (err) { busy(el, false); toast(err.message, { bad: true }); }
}

async function runAction(el, ctx, path, done, body = {}) {
  busy(el, true, "Working…");
  try {
    const r = await ctx.api(path, { method: "POST", body });
    const run = await waitRun(ctx.api, r.data.run_id);
    if (!run) toast("Still working. Check back in a minute.");
    else if (run.status === "done") toast(run.result && run.result.status === "converted" ? "Approved and booked" : done);
    else toast((run.error && run.error.code === "updated") ? "The quote changed. Take another look." : "That didn't go through. Try again.", { bad: true });
    ctx.refresh();
  } catch (err) { busy(el, false); toast(err.message, { bad: true }); }
}

function sendSheet(ctx) {
  const s = ctx.state;
  const c = s.contact || {};
  const dry = s.sms_mode !== "live" && s.sms_mode !== "test";
  const sh = sheet({
    title: s.quote.sent_at ? "Send it again" : "Send the quote",
    body: html`<form class="form" data-send>
      <p class="muted">One message per way, with the link to the quote. They pick an option and approve it on their phone.</p>
      <label class="check"><input ${attrs({ type: "checkbox", name: "sms", checked: !!c.phone, disabled: !c.phone })}><span>Text${c.phone ? ` to ${phone(c.phone)}` : " (no mobile on file)"}</span></label>
      <label class="check"><input ${attrs({ type: "checkbox", name: "email", checked: !!c.email, disabled: !c.email })}><span>Email${c.email ? ` to ${c.email}` : " (no email on file)"}</span></label>
      ${dry ? html`<p class="note">Texts and emails don't leave the CRM yet: they land in the Outbox, where you can copy the link to send it yourself.</p>` : ""}
      <p class="err" data-form-err hidden></p>
      <button type="submit" class="btn primary block">${icon("send")}Send</button>
    </form>`,
    events: {
      "submit [data-send]": async (e, form) => {
        e.preventDefault();
        const channels = ["sms", "email"].filter((k) => form.elements[k] && form.elements[k].checked);
        const err = form.querySelector("[data-form-err]");
        if (!channels.length) { err.textContent = "Pick text, email or both."; err.hidden = false; return; }
        const btn = form.querySelector("[type=submit]");
        busy(btn, true, "Sending…");
        try {
          const r = await ctx.api(`/quotes/${encodeURIComponent(s.quote.id)}/send`, { method: "POST", body: { channels } });
          sh.close();
          toast(r.data.sms_mode === "dry_run" ? "Sent to the Outbox (dry run)" : "Quote sent");
          ctx.refresh();
        } catch (er) { busy(btn, false); err.textContent = er.message; err.hidden = false; }
      },
    },
  });
}

async function present(el, ctx) {
  busy(el, true, "Getting it ready…");
  try {
    const r = await ctx.api(`/quotes/${encodeURIComponent(ctx.state.quote.id)}/present`, { method: "POST", body: {} });
    busy(el, false);
    sheet({
      title: "Present to customer",
      body: html`<div class="stack"><p class="muted">Opens the quote on this phone for the customer: they pick an option, sign with a finger and approve. It works once, for 15 minutes, and comes back to you when they're done.</p>
        <a class="btn primary block" ${openExternal(r.data.url)}>${icon("phone")}Open for the customer</a></div>`,
    });
    ctx.refresh();
  } catch (err) { busy(el, false); toast(err.message, { bad: true }); }
}

// The options as the customer has them, each add-on with its box (ticked as
// the quote has it); the price read out follows the boxes, and exactly the
// ticked add-ons are approved.
function phoneSheet(ctx) {
  const s = ctx.state;
  const options = (s.quote.status === "sent" || s.quote.status === "viewed") && s.current_version ? s.current_version.options : s.quote.options;
  const rec = (options.find((o) => o.recommended) || options[0] || {}).id;
  const ticked = (form, o) => new Set([...form.querySelectorAll(`input[name=addon][data-op="${o.id}"]:checked`)].map((i) => i.value));
  const priceOf = (o, picks) => optionTotals({ ...o, lines: (o.lines || []).map((l) => (l.optional ? { ...l, selected: picks.has(l.id) } : l)) }).first_cents;
  const sh = sheet({
    title: "Approved by phone",
    body: html`<form class="form" data-phone>
      <p class="muted">For a customer who said yes on the phone. No signature is taken${options.some((o) => o.kind === "plan") ? "; a plan's agreement still needs theirs" : ""}.</p>
      ${options.map((o) => html`<label class="check"><input ${attrs({ type: "radio", name: "option", value: o.id, checked: o.id === rec })}><span><b>${o.name}</b> · <span ${attrs({ "data-phone-price": o.id })}>${money((o.totals || {}).first_cents)}</span>${o.kind === "plan" ? " first visit" : ""}</span></label>
        ${(o.lines || []).filter((l) => l.optional).map((l) => html`<label class="check sub"><input ${attrs({ type: "checkbox", name: "addon", value: l.id, "data-op": o.id, checked: l.selected === true })}><span>Add-on: ${l.title} (${money(lineTotal({ ...l, optional: false }))})</span></label>`)}`)}
      <label class="field"><span>Who said yes (optional)</span><input name="name_typed" autocomplete="off" maxlength="120"></label>
      <button type="submit" class="btn primary block">Approve</button>
    </form>`,
    events: {
      "change input[name=addon]": (e, el) => {
        const form = el.closest("form");
        const o = options.find((x) => x.id === el.dataset.op);
        const out = o && form.querySelector(`[data-phone-price="${o.id}"]`);
        if (out) out.textContent = money(priceOf(o, ticked(form, o)));
      },
      "submit [data-phone]": async (e, form) => {
        e.preventDefault();
        const option = form.querySelector("input[name=option]:checked");
        if (!option) return;
        const o = options.find((x) => x.id === option.value);
        const selected_line_ids = o ? [...ticked(form, o)] : [];
        sh.close();
        await runAction(null, ctx, `/quotes/${encodeURIComponent(s.quote.id)}/approve`, "Approved", { option_id: option.value, by_phone: true, selected_line_ids, name_typed: form.elements.name_typed.value.trim() });
      },
    },
  });
}

function declineSheet(ctx) {
  const sh = sheet({
    title: "They said no",
    body: html`<form class="form" data-decline><label class="field"><span>Why (optional)</span><input name="reason" maxlength="500" autocomplete="off"></label><button type="submit" class="btn primary block">Mark declined</button></form>`,
    events: {
      "submit [data-decline]": async (e, form) => {
        e.preventDefault();
        try {
          await ctx.api(`/quotes/${encodeURIComponent(ctx.state.quote.id)}/decline`, { method: "POST", body: { reason: form.elements.reason.value.trim() } });
          sh.close(); toast("Marked declined"); ctx.refresh();
        } catch (err) { toast(err.message, { bad: true }); }
      },
    },
  });
}

export { STATUS };
