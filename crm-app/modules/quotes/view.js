// One quote (design §9.2 "Quote view"): its status and what happened when
// (sent, viewed, approved...), the customer's view of the version they
// have, the versions, the linked deal, plan or jobs; and what to do next:
// Edit, Send (text and/or email), Present to customer (a single-use page
// opened on this phone), Approve by phone, Convert, Archive, Restore,
// Decline, Duplicate, Preview as the customer sees it.

import { html, attrs, icon, sheet, toast, confirmSheet, openExternal } from "../../core/ui.js";
import { busy } from "../../core/forms.js";
import { money, dateShort, dateTime, ago, phone } from "../../core/format.js";
import { ensureStyles, statusPill, optionSummary, waitRun, STATUS, emptyCard, optionTotals, lineTotal } from "./kit.js";

async function load(params, ctx) {
  ensureStyles();
  const r = await ctx.api(`/quotes/${encodeURIComponent(params.id)}`, { cache: false });
  return { ...r.data, etag: r.etag };
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

function actions(s, ctx) {
  const q = s.quote;
  const st = q.status;
  const w = ctx.can("quotes:write");
  const send = ctx.can("quotes:send");
  const b = [];
  if (["draft", "changes_requested"].includes(st) && w) b.push(html`<a class="btn primary" href="${"#/quotes/" + encodeURIComponent(q.id) + "/edit"}">${icon("doc")}Edit</a>`);
  if (["draft", "sent", "viewed", "changes_requested"].includes(st) && send) b.push(html`<button type="button" class="btn ${st === "draft" || st === "changes_requested" ? "" : "primary"}" data-act="send">${icon("send")}${q.sent_at ? "Send again" : "Send"}</button>`);
  if (["draft", "sent", "viewed", "changes_requested"].includes(st) && send) b.push(html`<button type="button" class="btn" data-act="present">${icon("phone")}Present to customer</button>`);
  if (["draft", "sent", "viewed", "changes_requested"].includes(st) && w) b.push(html`<button type="button" class="btn" data-act="phone">${icon("check")}Approved by phone</button>`);
  if (["sent", "viewed"].includes(st) && w) b.push(html`<a class="btn" href="${"#/quotes/" + encodeURIComponent(q.id) + "/edit"}">${icon("doc")}Edit</a>`);
  if (st === "approved" && w && s.convertible) b.push(html`<button type="button" class="btn primary" data-act="convert">${icon("check")}Book it</button>`);
  if (["archived", "declined"].includes(st) && w) b.push(html`<button type="button" class="btn primary" data-act="restore">Restore</button>`);
  if (["sent", "viewed", "changes_requested", "draft"].includes(st) && w) b.push(html`<button type="button" class="btn" data-act="decline">Declined</button>`);
  if (st !== "converted" && st !== "archived" && w) b.push(html`<button type="button" class="btn" data-act="archive">Archive</button>`);
  if (w) b.push(html`<button type="button" class="btn" data-act="duplicate">${icon("copy")}Duplicate</button>`);
  if (q.current_version_id) b.push(html`<a class="btn" ${attrs({ href: `/api/crm/quotes/${encodeURIComponent(q.id)}/preview`, target: "_blank", rel: "noopener" })}>Customer view</a>`);
  return b;
}

function waiting(s) {
  const q = s.quote;
  if (q.status !== "approved" || s.convertible) return "";
  const v = s.current_version;
  const o = v && q.approval ? (v.options || []).find((x) => x.id === q.approval.option_id) : null;
  const plan = o && o.kind === "plan";
  return html`<p class="note">${plan ? "Turning a plan option into a plan arrives with Plans." : "Turning this into a job arrives with Scheduling."} The approval is saved.</p>`;
}

export default {
  title: (s) => (s && s.quote ? s.quote.number_label : "Quote"),
  load,
  render(s, ctx) {
    const q = s.quote;
    const c = s.contact || {};
    const v = s.current_version;
    const options = (v && v.options) || q.options || [];
    const prop = (s.properties || []).find((p) => p.id === q.property_id);
    return html`<div class="stack">
      <section class="card qt-head">
        <div class="top-line"><h2>${q.number_label}</h2>${statusPill(q.status)}</div>
        <a class="who-link" href="${"#/contacts/" + encodeURIComponent(q.contact_id)}">${c.name || q.contact_name || "Contact"}</a>
        <p class="small muted">${[prop && prop.address, c.phone && phone(c.phone)].filter(Boolean).join(" · ")}</p>
        ${q.expires_on && ["sent", "viewed"].includes(q.status) ? html`<p class="small">Good through ${dateShort(q.expires_on)}</p>` : ""}
        ${q.status === "draft" && q.current_version_id ? html`<p class="warn-box">Changed since it was sent. The customer still sees version ${v ? v.n : ""} until you send it again.</p>` : ""}
      </section>
      ${q.status === "changes_requested" && q.change_message ? html`<section class="card alert"><h2>They asked for changes</h2><p class="bubble">${q.change_message}</p></section>` : ""}
      ${q.status === "declined" && q.decline_reason ? html`<section class="card"><h2>Declined</h2><p>${q.decline_reason}</p></section>` : ""}
      ${waiting(s)}
      <div class="qt-acts">${actions(s, ctx)}</div>
      ${q.converted_to && (q.converted_to.plan_id || (q.converted_to.job_ids || []).length) ? html`<section class="card"><h2>Booked as</h2><p>${q.converted_to.plan_id ? "A plan" : ""}${q.converted_to.plan_id && (q.converted_to.job_ids || []).length ? " and " : ""}${(q.converted_to.job_ids || []).length ? `${q.converted_to.job_ids.length} job${q.converted_to.job_ids.length === 1 ? "" : "s"}` : ""}.</p></section>` : ""}
      <div class="section-h">${v ? `What the customer sees (version ${v.n})` : "Options (not sent yet)"}</div>
      ${options.length ? html`<div class="qt-opts side">${options.map((o) => optionSummary(["approved", "converted"].includes(q.status) && q.approval && q.approval.option_id === o.id && q.approval.totals ? { ...o, totals: q.approval.totals, recommended: false, name: `${o.name} (chosen)` } : o))}</div>` : emptyCard("No options yet", "Edit the quote to price it.")}
      ${q.client_notes ? html`<section class="card"><h2>Note to the customer</h2><p class="preview">${q.client_notes}</p></section>` : ""}
      ${q.internal_notes ? html`<section class="card"><h2>Office note</h2><p class="preview">${q.internal_notes}</p></section>` : ""}
      <section class="card"><h2>What happened</h2><ul class="qt-timeline">${timeline(q).map(([w, at], i, all) => html`<li><span class="${"dot" + (i === all.length - 1 ? " on" : "")}"></span><span class="w">${w}</span><span class="when">${dateTime(at)}</span></li>`)}</ul></section>
      ${(s.versions || []).length ? html`<section class="card"><h2>Versions</h2><ul class="qt-timeline">${s.versions.map((x) => html`<li><span class="dot"></span><span class="w">Version ${x.n}${(x.sent_via || []).length ? ` · ${x.sent_via.map((ch) => (ch === "sms" ? "text" : "email")).join(" + ")}` : " · in person"}</span><span class="when">${ago(x.sent_at)}</span></li>`)}</ul></section>` : ""}
    </div>`;
  },
  events: {
    "click [data-act=send]": (e, el, ctx) => sendSheet(ctx),
    "click [data-act=present]": (e, el, ctx) => present(el, ctx),
    "click [data-act=phone]": (e, el, ctx) => phoneSheet(ctx),
    "click [data-act=convert]": (e, el, ctx) => runAction(el, ctx, `/quotes/${encodeURIComponent(ctx.state.quote.id)}/convert`, "Booked"),
    "click [data-act=archive]": async (e, el, ctx) => {
      if (!(await confirmSheet("The customer's link stops taking approvals, and any follow-up offers end.", { title: "Archive this quote?", yes: "Archive" }))) return;
      simple(el, ctx, "archive", "Archived");
    },
    "click [data-act=restore]": (e, el, ctx) => simple(el, ctx, "restore", "Back to draft"),
    "click [data-act=decline]": (e, el, ctx) => declineSheet(ctx),
    "click [data-act=duplicate]": async (e, el, ctx) => {
      busy(el, true);
      try {
        const r = await ctx.api(`/quotes/${encodeURIComponent(ctx.state.quote.id)}/duplicate`, { method: "POST", body: {} });
        toast("Copied to a new draft");
        ctx.go(`/quotes/${encodeURIComponent(r.data.id)}/edit`);
      } catch (err) { busy(el, false); toast(err.message, { bad: true }); }
    },
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
        const btn = document.querySelector("[data-act=phone]");
        await runAction(btn, ctx, `/quotes/${encodeURIComponent(s.quote.id)}/approve`, "Approved", { option_id: option.value, by_phone: true, selected_line_ids, name_typed: form.elements.name_typed.value.trim() });
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
