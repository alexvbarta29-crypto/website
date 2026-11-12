// One plan (design §9.2 "Plan"): the terms, billing, perks, the visits by
// term (each with its job: tap Book to put it on the schedule, or Skip), the
// agreement (send it, present it on this phone, read it), the card (with
// Money), the sale value; and what the plan's status allows: Pause /
// Resume, Cancel (the policy calculator first: when it ends and what comes
// back), Keep the plan, Change the price, Renew, Activate with a reason,
// the clawback billed or waived. Every change is a run the server finishes.

import { html, attrs, icon, sheet, toast, confirmSheet, openExternal } from "../../core/ui.js";
import { busy, readForm, showError, clearErrors, readMoney } from "../../core/forms.js";
import { money, dateShort, dateYear, phone, localDate } from "../../core/format.js";
import { dateField } from "../../core/pickers.js";
import {
  ensureStyles, statusPill, ORD, AGREEMENT, BILLING, PLAN_NAMES, SEASON, CANCEL_REASONS, monthLabel, pendingText, waitRun, cents,
} from "./kit.js";

async function load(params, ctx) {
  ensureStyles();
  const r = await ctx.api(`/plans/${encodeURIComponent(params.id)}`, { cache: false });
  return { ...r.data, etag: r.etag || r.data.etag };
}

const perksText = (p, names) => {
  const out = [];
  if (p.touch_ups) out.push(names.touch_ups);
  if (p.rain_guarantee_days > 0) out.push(names.rain_guarantee);
  if (p.hard_water) out.push(names.hard_water);
  return out.join(", ") || "None";
};
const renewWords = (m) => (m === 1 ? "every month" : m === 12 ? "every year" : `every ${m} months`);

function facts(s) {
  const p = s.plan;
  const t = p.term || {};
  const rows = [
    ["Plan", `${PLAN_NAMES[p.catalog_key] || p.catalog_key} · ${p.visits_per_year} visit${p.visits_per_year === 1 ? "" : "s"} a year`],
    ["Term", `${dateYear(t.start_on)} to ${dateYear(t.initial_end_on)} (${t.initial_months} months)`],
    ...(t.current_term_n > 1 ? [["This term", `${dateYear(t.current_term_start)} to ${dateYear(t.current_term_end)}`]] : []),
    ["Renews", t.auto_renew === false ? "No, it ends with the term" : renewWords(t.renews_every_months)],
    ["Price locked until", dateYear(t.price_locked_until)],
    ["Billing", BILLING[(p.billing || {}).mode] || (p.billing || {}).mode],
    ["Autopay", (p.billing || {}).autopay ? (s.features.money ? "On" : "On (cards arrive with Money)") : "Off"],
    ["Perks", perksText(p.perks || {}, s.perk_names || {})],
    ["This term's value", money(p.sale_value_cents)],
  ];
  if (p.renewal && p.renewal.price_change) rows.push(["New price from", dateYear(p.renewal.price_change.effective_on)]);
  return html`<ul class="pl-facts">${rows.map(([k, v]) => html`<li><span class="k">${k}</span><span class="v">${v}</span></li>`)}</ul>`;
}

function visits(s, ctx) {
  const p = s.plan;
  const terms = [...new Set((p.ordinals || []).map((o) => o.term || 1))];
  const canSkip = ctx.can("plans:write") && p.status === "active";
  return terms.map((n) => html`${terms.length > 1 ? html`<p class="pl-term">Term ${n}</p>` : ""}<ul class="pl-ords">${(p.ordinals || []).filter((o) => (o.term || 1) === n).map((o) => {
    const [cls, label] = ORD[o.status] || ["", o.status];
    const when = o.visit_date ? dateShort(o.visit_date) : o.completed_on ? `Done ${dateShort(o.completed_on)}` : `Due ${monthLabel(o.target_month)}`;
    return html`<li class="pl-ord"><span class="n">${o.n}</span>
      <span class="t"><b>${when}</b><small>${o.job ? `Job ${o.job.number}` : o.status === "unscheduled" ? (s.features.jobs ? "Its job is on the way" : "Jobs arrive with Scheduling") : ""}</small></span>
      <span class="p">${money(o.total_cents)}<br><span class="${"pill " + cls}">${label}</span></span>
      ${o.job && o.status === "unscheduled" ? html`<a class="act" href="${"#/jobs/" + encodeURIComponent(o.job.id)}">Book</a>` : ""}
      ${canSkip && ["unscheduled", "scheduled"].includes(o.status) ? html`<button type="button" class="act" ${attrs({ "data-skip": `${o.term || 1}:${o.n}` })}>Skip</button>` : ""}
    </li>`;
  })}</ul>`);
}

function agreementCard(s, ctx) {
  const p = s.plan;
  const a = (s.agreements || []).find((x) => x.id === p.agreement_id) || (s.agreements || [])[0] || null;
  const st = p.agreement_status || "none";
  const send = ctx.can("agreements:send") && !["signed"].includes(st);
  return html`<section class="card"><h2>Agreement</h2>
    <p>${a && a.queued ? "Waiting in a bulk send (test and confirm it under Approvals)" : AGREEMENT[st] || st}${a && a.sent_at && st !== "signed" ? ` · sent ${dateShort(a.sent_at)}` : ""}${a && a.signature ? ` · ${a.signature.name_typed}${a.signature.method === "in_person" ? " (in person)" : ""}, ${dateShort(a.signed_at)}` : ""}</p>
    ${a && a.reminders && a.reminders.count ? html`<p class="small muted">${a.reminders.count} reminder${a.reminders.count === 1 ? "" : "s"} sent</p>` : ""}
    <div class="btn-row">
      ${send ? html`<button type="button" class="btn primary" data-act="send-agreement">${icon("send")}${a && ["sent", "viewed"].includes(a.status) ? "Send it again" : "Send to sign"}</button>` : ""}
      ${send ? html`<button type="button" class="btn" data-act="present-agreement">${icon("phone")}Sign on this phone</button>` : ""}
      ${a ? html`<button type="button" class="btn" ${attrs({ "data-read": a.id })}>${icon("doc")}Read it</button>` : ""}
    </div></section>`;
}

// A lights plan's seasons after the first wait for the customer's yes (the
// September rebook text): no install is made before the office marks it.
function seasonsToConfirm(p) {
  if (p.kind !== "lights_annual" || !["active", "pending", "paused"].includes(p.status)) return [];
  const yes = new Set(p.confirmed_seasons || []);
  const out = new Set();
  for (const o of p.ordinals || []) {
    const y = Number(String(o.target_month).slice(0, 4));
    if ((o.k || o.n) > 1 && o.status === "unscheduled" && !o.job_id && !yes.has(y)) out.add(y);
  }
  const now = new Date();
  const upcoming = now.getMonth() >= 6 ? now.getFullYear() : null;
  if (upcoming && !yes.has(upcoming) && !(p.ordinals || []).some((o) => Number(String(o.target_month).slice(0, 4)) === upcoming && (o.job_id || o.status !== "unscheduled"))) out.add(upcoming);
  return [...out].sort();
}
function seasonsCard(s, ctx) {
  const p = s.plan;
  if (p.kind !== "lights_annual") return "";
  const waiting = seasonsToConfirm(p);
  const can = ctx.can("plans:write");
  return html`<section class="card"><h2>Seasons</h2>
    ${(s.seasons || []).length ? html`<ul class="pl-facts">${s.seasons.map((x) => html`<li><span class="k">${x.season}</span><span class="v"><a href="${"#/lights/" + x.season}">${SEASON[x.status] || x.status}${x.bin_id ? ` · bin ${x.bin_id}` : ""}</a></span></li>`)}</ul>` : ""}
    ${waiting.length ? html`<p class="small muted">A new season goes on the schedule once the customer says yes (they get a text each September).</p>
      ${can ? html`<div class="btn-row">${waiting.map((y) => html`<button type="button" class="btn" ${attrs({ "data-confirm-season": y })}>${icon("check")}They said yes to ${y}</button>`)}</div>` : html`<p>Waiting for ${waiting.join(", ")}.</p>`}` : ""}
  </section>`;
}

function actions(s, ctx) {
  const p = s.plan;
  const w = ctx.can("plans:write");
  const c = ctx.can("plans:cancel");
  const b = [];
  if (p.status === "pending" && w) b.push(html`<button type="button" class="btn" data-act="activate">${icon("check")}Activate anyway</button>`);
  if (p.status === "active" && w) b.push(html`<button type="button" class="btn" data-act="pause">${icon("pause")}Pause</button>`);
  if (p.status === "paused" && w) b.push(html`<button type="button" class="btn primary" data-act="resume">${icon("check")}Resume</button>`);
  if (p.status === "active" && w) b.push(html`<button type="button" class="btn" data-act="price">${icon("money")}Change price</button>`);
  if (p.status === "expired" && w) b.push(html`<button type="button" class="btn primary" data-act="renew">${icon("check")}Renew</button>`);
  if (p.status === "cancelling" && c) b.push(html`<button type="button" class="btn primary" data-act="withdraw">Keep the plan</button>`);
  if (["active", "paused", "pending"].includes(p.status) && c) b.push(html`<button type="button" class="btn" data-act="cancel">Cancel plan</button>`);
  if (p.cancel && p.cancel.clawback_state === "to_bill" && c) {
    b.push(html`<button type="button" class="btn" data-act="claw-billed">Clawback billed</button>`);
    if (s.can && s.can.waive) b.push(html`<button type="button" class="btn" data-act="claw-waive">Waive clawback</button>`);
  }
  return b;
}

export default {
  title: (s) => (s && s.plan ? s.plan.name : "Plan"),
  load,
  render(s, ctx) {
    const p = s.plan;
    const c = s.contact || {};
    const acts = actions(s, ctx);
    return html`<div class="stack">
      <section class="card pl-head">
        <div class="top-line"><h2>${p.name}</h2>${statusPill(p.status)}</div>
        <a class="who-link" href="${"#/contacts/" + encodeURIComponent(p.contact_id)}">${c.name || p.contact_name || "Contact"}</a>
        <p class="small muted">${[p.town, c.phone && phone(c.phone)].filter(Boolean).join(" · ")}</p>
        ${p.status === "pending" ? html`<p class="warn-box">Waiting for the ${pendingText(p.pending_reasons) || "agreement"}.</p>` : ""}
        ${p.status === "paused" && p.pause ? html`<p class="note">Paused since ${dateShort(p.pause.from)}${p.pause.until ? `, back ${dateShort(p.pause.until)}` : ""}${p.pause.reason ? `: ${p.pause.reason}` : ""}.</p>` : ""}
        ${p.status === "cancelling" && p.cancel ? html`<p class="warn-box">Ends ${dateYear(p.cancel.effective_on)}${p.cancel.clawback_cents ? `. ${p.cancel.storage_fee_cents ? "Storage fee for leaving the contract early" : "First-visit discount back"}: ${cents(p.cancel.clawback_cents)} (${p.cancel.clawback_state === "to_bill" ? "to bill, waiting for your OK" : p.cancel.clawback_state})` : ""}.</p>` : ""}
        ${p.import ? html`<p class="small muted">From Rotor: Rotor stays in charge of this plan until the switch.</p>` : ""}
        ${p.held ? html`<p class="warn-box">Due to ${({ resume: "pick back up", renew: "renew", activate: "start", confirm_season: "go on" })[p.held.action] || p.held.action} since ${dateShort(p.held.since)}, but Rotor is still in charge of this customer, so the CRM doesn't book visits for them by itself. Do it here by hand.</p>` : ""}
      </section>
      ${acts.length ? html`<div class="pl-acts">${acts}</div>` : ""}
      <section class="card"><h2>Visits</h2>${visits(s, ctx)}</section>
      ${agreementCard(s, ctx)}
      ${seasonsCard(s, ctx)}
      <section class="card"><h2>Terms</h2>${facts(s)}</section>
    </div>`;
  },
  events: {
    "click [data-act=send-agreement]": (e, el, ctx) => sendSheet(ctx),
    "click [data-act=present-agreement]": (e, el, ctx) => present(el, ctx),
    "click [data-read]": (e, el, ctx) => readSheet(el.dataset.read, ctx),
    "click [data-act=pause]": (e, el, ctx) => pauseSheet(ctx),
    "click [data-act=resume]": (e, el, ctx) => act(el, ctx, "resume", {}, "Back on"),
    "click [data-act=renew]": (e, el, ctx) => act(el, ctx, "renew", {}, "Renewed"),
    "click [data-act=withdraw]": async (e, el, ctx) => { if (await confirmSheet("The cancellation is dropped and the plan goes on as before.", { title: "Keep the plan?", yes: "Keep it" })) act(el, ctx, "withdraw", {}, "The plan goes on"); },
    "click [data-act=activate]": (e, el, ctx) => activateSheet(ctx),
    "click [data-act=cancel]": (e, el, ctx) => cancelSheet(ctx),
    "click [data-act=price]": (e, el, ctx) => priceSheet(ctx),
    "click [data-confirm-season]": async (e, el, ctx) => {
      const y = Number(el.dataset.confirmSeason);
      if (!(await confirmSheet(`Their ${y} install and takedown are made, ready to book.`, { title: `They said yes to ${y}?`, yes: "Yes, make them" }))) return;
      act(el, ctx, "confirm-season", { season: y }, `${y} is on`);
    },
    "click [data-act=claw-billed]": (e, el, ctx) => clawback(ctx, "billed"),
    "click [data-act=claw-waive]": (e, el, ctx) => clawback(ctx, "waived"),
    "click [data-skip]": async (e, el, ctx) => {
      const [term, n] = el.dataset.skip.split(":").map(Number);
      if (!(await confirmSheet("The visit comes off and its job is cancelled. Skipping doesn't turn into a credit.", { title: `Skip visit ${n}?`, yes: "Skip it" }))) return;
      act(el, ctx, "skip", { term, n }, "Skipped");
    },
  },
};

// A change is a run: start it, follow it, refresh.
async function act(el, ctx, action, body, done) {
  if (el) busy(el, true, "Working…");
  try {
    const r = await ctx.api(`/plans/${encodeURIComponent(ctx.state.plan.id)}/${action}`, { method: "POST", body });
    const run = await waitRun(ctx.api, r.data.run_id);
    if (!run) toast("Still working. Check back in a minute.");
    else if (run.status === "done") toast(done);
    else toast("That didn't go through. Try again.", { bad: true });
    ctx.refresh();
  } catch (err) { if (el) busy(el, false); toast(err.message, { bad: true }); }
}

function pauseSheet(ctx) {
  const today = localDate();
  const sh = sheet({
    title: "Pause the plan",
    body: html`<form class="form" data-pause novalidate>
      <p class="muted">Booked visits from that day on come off the schedule and the customer gets a text. Visits still to book wait; when the plan picks back up they move by the paused months.</p>
      ${dateField({ label: "From", name: "from", value: today, min: today })}
      ${dateField({ label: "Back on (optional)", name: "until", min: today })}
      <label class="field" data-field="reason"><span>Why (optional)</span><input name="reason" maxlength="300" autocomplete="off"></label>
      <p class="err" data-form-err hidden></p>
      <button type="submit" class="btn primary block">Pause</button></form>`,
    events: {
      "submit [data-pause]": async (e, form) => {
        e.preventDefault();
        const v = readForm(form);
        sh.close();
        await act(null, ctx, "pause", { from: v.from, until: v.until || undefined, reason: v.reason }, "Paused");
      },
    },
  });
}

function activateSheet(ctx) {
  const sh = sheet({
    title: "Activate without a signature",
    body: html`<form class="form" data-activate novalidate><p class="muted">For a customer who signed on paper or said yes another way. Say how, for the record.</p>
      <label class="field" data-field="override_reason"><span>How they agreed</span><input name="override_reason" maxlength="300" autocomplete="off" required></label>
      <p class="err" data-form-err hidden></p><button type="submit" class="btn primary block">Activate</button></form>`,
    events: {
      "submit [data-activate]": async (e, form) => {
        e.preventDefault();
        const v = readForm(form);
        if (!String(v.override_reason || "").trim()) { showError(form, { field: "override_reason", message: "Say how they agreed." }); return; }
        sh.close();
        await act(null, ctx, "activate", { override_reason: v.override_reason.trim() }, "Active");
      },
    },
  });
}

async function cancelSheet(ctx) {
  const p = ctx.state.plan;
  let q;
  try { q = (await ctx.api(`/plans/${encodeURIComponent(p.id)}/cancel-quote`, { cache: false })).data; } catch (err) { toast(err.message, { bad: true }); return; }
  const owner = ctx.user && ctx.user.role === "owner";
  const sh = sheet({
    title: "Cancel the plan",
    body: html`<form class="form" data-cancel novalidate>
      <div class="card" style="margin:0"><ul class="pl-facts">
        <li><span class="k">Ends</span><span class="v">${q.immediate ? "Today" : dateYear(q.effective_on)}</span></li>
        <li><span class="k">Why then</span><span class="v">${q.inside_initial_term ? `${q.notice_days} days' notice in the first term` : "The end of this renewal term"}</span></li>
        <li><span class="k">Visits still happening</span><span class="v">${q.visits_still_happen}</span></li>
        <li><span class="k">${q.storage_fee_cents ? "Storage fee (3-year contract)" : "First-visit discount back"}</span><span class="v">${q.clawback_cents ? `${cents(q.clawback_cents)} (a draft for an owner's OK)` : "None"}</span></li>
      </ul></div>
      <label class="field" data-field="reason"><span>Why</span><select name="reason">${CANCEL_REASONS.map(([v, l]) => html`<option ${attrs({ value: v })}>${l}</option>`)}</select></label>
      <label class="field" data-field="note"><span>${owner ? "Note (optional)" : "Note"}</span><input name="note" maxlength="500" autocomplete="off"><small class="why" hidden></small></label>
      <p class="err" data-form-err hidden></p>
      <button type="submit" class="btn danger block">Cancel the plan</button></form>`,
    events: {
      "submit [data-cancel]": async (e, form) => {
        e.preventDefault();
        clearErrors(form);
        const v = readForm(form);
        if (!owner && !String(v.note || "").trim()) { showError(form, { field: "note", message: "Add a note on why." }); return; }
        sh.close();
        await act(null, ctx, "cancel", { reason: v.reason, note: v.note || undefined }, "Cancellation set");
      },
    },
  });
}

function priceSheet(ctx) {
  const p = ctx.state.plan;
  const sh = sheet({
    title: "Change the price",
    body: html`<form class="form" data-price novalidate>
      <p class="muted">The new price starts at the first renewal on or after the date (at least 30 days out, after ${dateYear(p.term.price_locked_until)}). The customer gets a notice with the renewal.</p>
      ${(p.lines || []).map((l, i) => html`<label class="field"><span>${l.title}</span><input ${attrs({ name: `line_${i}`, inputmode: "decimal", value: ((l.total_cents || 0) / 100).toFixed(2) })}></label>`)}
      ${dateField({ label: "Starting", name: "effective_on" })}
      <p class="err" data-form-err hidden></p>
      <button type="submit" class="btn primary block">Save the new price</button></form>`,
    events: {
      "submit [data-price]": async (e, form) => {
        e.preventDefault();
        clearErrors(form);
        const v = readForm(form);
        const lines = (p.lines || []).map((l, i) => ({ id: l.id, title: l.title, qty_milli: 1000, unit_cents: readMoney(v[`line_${i}`]), scope: l.scope, service_type: l.service_type }));
        if (lines.some((l) => !Number.isInteger(l.unit_cents))) { showError(form, { message: "Use amounts like 245.00." }); return; }
        const btn = form.querySelector("[type=submit]");
        busy(btn, true);
        try {
          await ctx.api(`/plans/${encodeURIComponent(p.id)}/change-price`, { method: "POST", body: { new_lines: lines, effective_on: v.effective_on } });
          sh.close(); toast("New price saved"); ctx.refresh();
        } catch (err) { busy(btn, false); showError(form, err); }
      },
    },
  });
}

async function clawback(ctx, how) {
  let reason;
  if (how === "waived") {
    const sh = await new Promise((resolve) => {
      const s = sheet({
        title: "Waive the clawback",
        body: html`<form class="form" data-waive novalidate><label class="field"><span>Why</span><input name="reason" maxlength="300" autocomplete="off"></label><button type="submit" class="btn primary block">Waive it</button></form>`,
        onClose: () => resolve(null),
        events: { "submit [data-waive]": (e, form) => { e.preventDefault(); const v = readForm(form); if (!String(v.reason || "").trim()) return; resolve(v.reason.trim()); s.close(); } },
      });
    });
    if (!sh) return;
    reason = sh;
  }
  try {
    await ctx.api(`/plans/${encodeURIComponent(ctx.state.plan.id)}`, { method: "PATCH", body: { clawback: how, ...(reason ? { reason } : {}) }, ifMatch: ctx.state.etag });
    toast(how === "waived" ? "Waived" : "Marked billed"); ctx.refresh();
  } catch (err) { toast(err.status === 412 ? "Someone else just changed this plan. Look again." : err.message, { bad: true }); }
}

function sendSheet(ctx) {
  const c = ctx.state.contact || {};
  const dry = ctx.state.sms_mode !== "live" && ctx.state.sms_mode !== "test";
  const sh = sheet({
    title: "Send the agreement",
    body: html`<form class="form" data-send>
      <p class="muted">A link to read and sign it on their phone. It works for 30 days; a reminder goes out each day until it's signed (up to 7).</p>
      <label class="check"><input ${attrs({ type: "checkbox", name: "sms", checked: !!c.phone, disabled: !c.phone })}><span>Text${c.phone ? ` to ${phone(c.phone)}` : " (no mobile on file)"}</span></label>
      <label class="check"><input ${attrs({ type: "checkbox", name: "email", checked: !!c.email && !c.phone, disabled: !c.email })}><span>Email${c.email ? ` to ${c.email}` : " (no email on file)"}</span></label>
      ${dry ? html`<p class="note">Texts and emails don't leave the CRM yet: they land in the Outbox.</p>` : ""}
      <p class="err" data-form-err hidden></p>
      <button type="submit" class="btn primary block">${icon("send")}Send</button></form>`,
    events: {
      "submit [data-send]": async (e, form) => {
        e.preventDefault();
        const channels = ["sms", "email"].filter((k) => form.elements[k] && form.elements[k].checked);
        const err = form.querySelector("[data-form-err]");
        if (!channels.length) { err.textContent = "Pick text, email or both."; err.hidden = false; return; }
        const btn = form.querySelector("[type=submit]");
        busy(btn, true, "Sending…");
        try {
          await ctx.api(`/plans/${encodeURIComponent(ctx.state.plan.id)}/send-agreement`, { method: "POST", body: { channels } });
          sh.close(); toast(dry ? "Sent to the Outbox (dry run)" : "Agreement sent"); ctx.refresh();
        } catch (er) { busy(btn, false); err.textContent = er.message; err.hidden = false; }
      },
    },
  });
}

async function present(el, ctx) {
  busy(el, true, "Getting it ready…");
  try {
    const a = await ctx.api("/agreements", { method: "POST", body: { plan_id: ctx.state.plan.id } });
    const r = await ctx.api(`/agreements/${encodeURIComponent(a.data.id)}/present`, { method: "POST", body: {} });
    busy(el, false);
    sheet({
      title: "Sign on this phone",
      body: html`<div class="stack"><p class="muted">Opens the agreement for the customer on this phone: they read it, type their name, sign with a finger. It works once, for 15 minutes.</p>
        <a class="btn primary block" ${openExternal(r.data.url)}>${icon("phone")}Open for the customer</a></div>`,
    });
  } catch (err) { busy(el, false); toast(err.message, { bad: true }); }
}

async function readSheet(id, ctx) {
  try {
    const r = await ctx.api(`/agreements/${encodeURIComponent(id)}`, { cache: false });
    sheet({ title: r.data.title, body: html`<div class="stack"><p class="small muted">${r.data.status === "signed" ? `Signed ${dateShort(r.data.signed_at)} by ${r.data.signature ? r.data.signature.name_typed : ""}` : "Not signed yet"}</p><div class="pl-doc">${r.data.body_rendered}</div></div>` });
  } catch (err) { toast(err.message, { bad: true }); }
}
