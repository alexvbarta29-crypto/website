// One request (the Rotor guide's SR5): the top card (status, where it came
// from, when; the black pill: the next step), the person (call, text) and
// the place (directions), what they asked for and their note, the photos,
// the Assessment card (Schedule assessment: day, time, who → an estimate
// visit on the Schedule's Sales rep column; Mark assessed), and Convert →
// a draft quote (the builder opens) or a job to book. The "..." holds
// Assign, Close (a reason), Reopen and Open customer.

import { html, attrs, sheet, toast, statusPill, pillBtn, cardHead, personCard, addressCard, notesBox } from "../../core/ui.js";
import { dateShort, ago, clock, phone as formatPhone } from "../../core/format.js";
import { readForm, showError, clearErrors, busy } from "../../core/forms.js";
import { directionsUrl } from "../../core/map.js";
import { photoTile } from "../../core/camera.js";
import { pickFrom } from "../../core/pickers.js";
import { loadUsers, team, today, addDays } from "../work/office-kit.js";
import { ensureStyles, STATUS, STATUS_TONE, SOURCE, CLOSE_REASONS } from "./kit.js";

const tel = (ph) => String((ph && ph.e164) || "").replace(/[^+\d]/g, "");
const OPEN = ["new", "assessment_booked", "assessed"];

async function load(params, ctx) {
  ensureStyles();
  const r = await ctx.api(`/requests/${encodeURIComponent(params.id)}`, { cache: false });
  const users = await loadUsers(ctx).catch(() => []);
  return { ...r.data, etag: r.etag, users };
}

const userName = (s, id) => ((s.users || []).find((u) => u.id === id) || {}).name || "Someone";

function topCard(s, ctx) {
  const r = s.request;
  const open = OPEN.includes(r.status);
  const may = ctx.can("requests:write");
  const next = !may ? null
    : r.status === "new" ? pillBtn("Schedule assessment", { tone: "solid", icon: "cal", data: { assess: true } })
      : r.status === "assessment_booked" ? pillBtn("Mark assessed", { tone: "solid", icon: "check", data: { assessed: true } })
        : r.status === "assessed" ? pillBtn("Convert", { tone: "solid", icon: "swap", data: { convert: true } })
          : r.status === "converted" && r.converted ? pillBtn(r.converted.job_id ? "Open job" : "Open quote", { tone: "solid", href: r.converted.job_id ? "#/jobs/" + encodeURIComponent(r.converted.job_id) : "#/quotes/" + encodeURIComponent(r.converted.quote_id) })
            : null;
  return html`<div class="rs-card sv-rtop">
    <div class="sv-rtop-r"><span class="rs-pills">${statusPill(STATUS[r.status] || r.status, STATUS_TONE[r.status] || "grey")}${statusPill(SOURCE[r.source] || r.source, "grey")}</span><span class="rs-sub">${ago(r.created_at)}</span></div>
    <p class="sv-rtitle">${(r.services || []).length ? r.services.join(", ") : "A request"}</p>
    ${r.timing ? html`<p class="rs-sub">When: ${r.timing}</p>` : ""}
    ${r.assignee_id ? html`<p class="rs-sub">With ${userName(s, r.assignee_id)}</p>` : open ? html`<p class="rs-sub sv-amber">Nobody on it yet</p>` : ""}
    ${r.status === "closed" ? html`<p class="warn-box">Closed: ${(CLOSE_REASONS.find(([k]) => k === r.closed_reason) || [0, r.closed_reason])[1]}${r.closed_note ? `. ${r.closed_note}` : ""}</p>` : ""}
    ${next || (may && open && r.status !== "assessed") ? html`<div class="sv-acts">${next}${may && open && r.status !== "assessed" ? pillBtn("Convert", { icon: "swap", data: { convert: true } }) : ""}</div>` : ""}
  </div>`;
}

function assessmentCard(s, ctx) {
  const r = s.request;
  const a = s.assessment;
  const may = ctx.can("requests:write") && OPEN.includes(r.status);
  const add = may ? { label: a ? "Move the assessment" : "Schedule an assessment", data: { assess: true } } : null;
  return html`<div class="rs-card sv-assess">${cardHead("Assessment", { add })}
    ${a ? html`<div class="sv-arow"><span class="${"rs-ci" + (a.done_at ? " ok" : "")}" aria-hidden="true"></span><span class="sv-arow-t"><b>${dateShort(a.date)} · ${clock(a.start)} to ${clock(a.end)}</b><span class="rs-sub">${a.user_name || "Someone"}${a.done_at ? ` · done ${ago(a.done_at)}` : " · on the Schedule"}</span></span>${may && !a.done_at ? pillBtn("Done", { icon: "check", data: { assessed: true }, aria: "Mark assessed" }) : ""}</div>`
      : html`<p class="rs-empty">${may ? "Nobody has been out yet. Schedule a look, or convert it straight to a quote." : "No assessment."}</p>`}
  </div>`;
}

function placeCards(s) {
  const out = [];
  const c = s.contact;
  if (c) {
    const ph = (c.phones || []).find((p) => p.primary) || (c.phones || [])[0];
    const n = tel(ph);
    out.push(personCard({ name: c.display_name || "Customer", sub: ph && ph.e164 ? formatPhone(ph.e164) : c.lifecycle === "lead" ? "Lead" : "Customer", href: "#/contacts/" + encodeURIComponent(c.id), call: n ? "tel:" + n : null, text: n ? "sms:" + n : null }));
  }
  const a = s.property && s.property.address;
  if (a && (a.street1 || a.city)) out.push(addressCard({ line1: a.street1 || a.city, line2: [a.city, [a.state, a.zip].filter(Boolean).join(" ")].filter(Boolean).join(", "), nav: directionsUrl(a) }));
  return out;
}

// ------------------------------------------------------------ sheets

function assessSheet(ctx) {
  const s = ctx.state;
  const a = s.assessment || {};
  const people = team(s.users || []);
  const me = (ctx.user && ctx.user.id) || null;
  const who = a.user_id || s.request.assignee_id || (people.some((u) => u.id === me) ? me : (people[0] || {}).id);
  const sh = sheet({
    title: a.date ? "Move the assessment" : "Schedule an assessment",
    body: html`<form class="form" data-assess-f novalidate>
      <div class="err" data-form-err hidden></div>
      <label class="field" data-field="date"><span>Day</span><input type="date" name="date" required ${attrs({ value: a.date || addDays(s.today || today(), 1), min: s.today || today() })}><small class="why" hidden></small></label>
      <div class="sv-two"><label class="field" data-field="start"><span>From</span><input type="time" name="start" step="900" required ${attrs({ value: a.start || "10:00" })}><small class="why" hidden></small></label>
      <label class="field" data-field="end"><span>To</span><input type="time" name="end" step="900" required ${attrs({ value: a.end || "10:30" })}><small class="why" hidden></small></label></div>
      <label class="field" data-field="user_id"><span>Who goes</span><select name="user_id">${people.map((u) => html`<option ${attrs({ value: u.id, selected: u.id === who })}>${u.name}</option>`)}</select><small class="why" hidden></small></label>
      <p class="small muted">It goes on the Schedule as an estimate visit for that person.</p>
      <button type="submit" class="btn primary block">Save</button>
    </form>`,
    events: {
      "submit [data-assess-f]": async (e, form) => {
        e.preventDefault();
        clearErrors(form);
        const v = readForm(form);
        const btn = form.querySelector("[type=submit]");
        busy(btn, true);
        try {
          await ctx.api(`/requests/${encodeURIComponent(s.request.id)}/assessment`, { method: "POST", body: { date: v.date, start: v.start, end: v.end, user_id: v.user_id } });
          sh.close(); toast("Assessment booked"); ctx.refresh();
        } catch (err) { busy(btn, false); showError(form, err); }
      },
    },
  });
}

async function convert(ctx) {
  const s = ctx.state;
  const items = [
    ctx.can("quotes:write") && { value: "quote", label: "A quote", sub: "Price it in the builder, then send it" },
    ctx.can("schedule:write") && { value: "job", label: "A job", sub: "Book the work straight away" },
  ].filter(Boolean);
  if (!items.length) { toast("Making quotes and jobs isn't open to this login.", { bad: true }); return; }
  const pick = await pickFrom({ title: "Convert to", items });
  const to = pick && (pick.value || pick);
  if (!to) return;
  try {
    const r = await ctx.api(`/requests/${encodeURIComponent(s.request.id)}/convert`, { method: "POST", body: { to } });
    const d = r.data || {};
    toast(d.job_id ? "A job to book. Set the prices." : "A draft quote. Price it.");
    ctx.go(d.job_id ? `/jobs/${encodeURIComponent(d.job_id)}` : `/quotes/${encodeURIComponent(d.quote_id)}/edit`);
  } catch (err) { toast(err.message || "That didn't convert.", { bad: true }); ctx.refresh(); }
}

async function closeIt(ctx) {
  const s = ctx.state;
  const pick = await pickFrom({ title: "Why close it?", items: CLOSE_REASONS.map(([value, label]) => ({ value, label })) });
  const reason = pick && (pick.value || pick);
  if (!reason) return;
  try { await ctx.api(`/requests/${encodeURIComponent(s.request.id)}/close`, { method: "POST", body: { reason } }); toast("Closed"); }
  catch (err) { toast(err.message || "That didn't close.", { bad: true }); }
  ctx.refresh();
}

async function assign(ctx) {
  const s = ctx.state;
  const pick = await pickFrom({ title: "Who works it?", items: team(s.users || []).map((u) => ({ value: u.id, label: u.name })) });
  const id = pick && (pick.value || pick);
  if (!id) return;
  try { await ctx.api(`/requests/${encodeURIComponent(s.request.id)}`, { method: "PATCH", body: { assignee_id: id }, ifMatch: s.etag }); toast("Assigned"); }
  catch (err) { toast(err.status === 412 ? "Someone else just changed it. Here it is again." : err.message || "That didn't save.", { bad: true }); }
  ctx.refresh();
}

async function post(ctx, path, ok) {
  try { await ctx.api(`/requests/${encodeURIComponent(ctx.state.request.id)}/${path}`, { method: "POST", body: {} }); toast(ok); }
  catch (err) { toast(err.message || "That didn't save.", { bad: true }); }
  ctx.refresh();
}

async function saveNotes(ctx, value) {
  const s = ctx.state;
  if ((s.request.notes || "") === value) return;
  try {
    const r = await ctx.api(`/requests/${encodeURIComponent(s.request.id)}`, { method: "PATCH", body: { notes: value }, ifMatch: s.etag });
    s.etag = r.etag || s.etag; s.request = { ...s.request, notes: value }; toast("Saved");
  } catch (err) { toast(err.status === 412 ? "Someone else just changed it. Here it is again." : err.message || "That didn't save.", { bad: true }); ctx.refresh(); }
}

export default {
  title: "Request",
  load,
  more: (s, ctx) => {
    if (!s || !s.request) return [];
    const r = s.request;
    const may = ctx.can("requests:write");
    const open = OPEN.includes(r.status);
    return [
      [may && open && { label: "Assign", icon: "user", run: () => assign(ctx), data: { assign: true } },
        may && open && { label: s.assessment ? "Move the assessment" : "Schedule assessment", icon: "cal", run: () => assessSheet(ctx) },
        may && open && { label: "Convert", icon: "swap", hint: "quote or job", run: () => convert(ctx) }],
      [s.contact && { label: "Open customer", icon: "user", href: "#/contacts/" + encodeURIComponent(s.contact.id) }],
      [may && r.status === "closed" && { label: "Reopen", icon: "undo", run: () => post(ctx, "reopen", "Reopened") },
        may && open && { label: "Close request", icon: "close", danger: true, run: () => closeIt(ctx), data: { "close-req": true } }],
    ];
  },
  render(s, ctx) {
    const r = s.request;
    const may = ctx.can("requests:write");
    return html`<div class="rs-page sv sv-req">
      ${topCard(s, ctx)}
      ${placeCards(s)}
      ${assessmentCard(s, ctx)}
      <div class="rs-card">${cardHead("Their note")}${may && OPEN.includes(r.status) ? notesBox(r.notes, { name: "req", label: "Their note", placeholder: "What they told you..." }) : r.notes ? html`<p class="wk-pre">${r.notes}</p>` : html`<p class="rs-empty">No note.</p>`}</div>
      ${(r.photo_ids || []).length ? html`<div class="rs-card">${cardHead("Photos")}<div class="sl-photos sv-photos">${r.photo_ids.map((id) => photoTile(id, { alt: "A photo the customer sent" }))}</div></div>` : ""}
      ${r.task_id ? html`<p class="foot-note"><a href="${"#/tasks/" + encodeURIComponent(r.task_id)}">The office task for it</a></p>` : ""}
    </div>`;
  },
  events: {
    "click [data-assess]": (e, el, ctx) => assessSheet(ctx),
    "click [data-assessed]": (e, el, ctx) => post(ctx, "assessed", "Marked assessed"),
    "click [data-convert]": (e, el, ctx) => convert(ctx),
    "change [data-notes=req]": (e, el, ctx) => saveNotes(ctx, el.value),
  },
};

