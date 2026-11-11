// The field panel on the Visit screen (design §9.3 "Visit (field
// actions)", §5.5, §2.5): for whoever is on the visit, whatever their role.
// Drawn inline by work/visit.js through the visitActions contract
// (work/manifest.js); it shows the visit's checklist, work and notes
// itself (replaces), so they can be worked from here.
//
//   On my way (an ETA from where the phone is to the house, editable) and
//   Running late: both text the customer, so both need signal.
//   Start / Pause / Resume the timer; Complete (blocked until the required
//   items are done; stops everyone's timer on the visit); No access.
//   Tick the checklist (photo items by their photo), take before, after and
//   issue photos (the photo keeps its EXIF), add to the job from the price
//   book (credited to you), notes, report an incident.
//
// Everything but the texts works with no signal: the change waits in the
// phone's outbox and goes out in order when signal comes back, and the
// panel shows it done in the meantime (tech-kit.js overlayVisit).

import { html, icon, attrs, toast, sheet } from "../../core/ui.js";
import { money, time as fmtTime, dateShort } from "../../core/format.js";
import { capture, prepare } from "../../core/camera.js";
import { ensureStyles, TICONS, hm, since, send, waiting, overlayVisit, onDrained, here, etaMinutes, toBase64, smsHref, online, FULL_NOTE, offlineLine, tellShell } from "./tech-kit.js";

const OPEN = ["scheduled", "en_route", "in_progress", "paused"];
const TITLE = { scheduled: "Booked", en_route: "On the way", in_progress: "Working", paused: "Paused", completed: "Done", no_access: "No access", cancelled: "Cancelled" };
const itemDone = (i) => !!(i && (i.done_at || (i.value !== undefined && i.value !== null && i.value !== "")));
const MAX_PHOTO = 3000000;
// what the last On my way / Running late text did, per visit, for a few minutes (the screen reloads after it)
const sentFor = new Map();
const SENT_MS = 10 * 60000;

async function load(data, ctx) {
  ensureStyles();
  const v = data.visit;
  let field = {};
  try { field = (await ctx.api(`/visits/${encodeURIComponent(v.id)}/field`)).data || {}; } catch (e) { field = {}; }
  const timers = field.timers || [];
  const items = await waiting(`/visits/${v.id}/`);
  const o = overlayVisit(v, items, ctx.user && ctx.user.id, timers);
  onDrained(() => ctx.refresh());
  const sent = sentFor.get(v.id);
  return { visit: o.visit, timers: o.timers, waiting: o.waiting, offline: !!data.offline, as_of: data.as_of || null, sent: sent && Date.now() - sent.at < SENT_MS ? sent.text : null, last: field.last_notes || null };
}

function myTimer(s, uid) {
  return (s.timers || []).find((t) => !t.end_at && (t.user_ids || []).includes(uid)) || null;
}
const worked = (s) => (s.timers || []).reduce((n, t) => n + (t.end_at ? t.minutes || 0 : since(t.start_at)), 0);

function stateCard(s, ctx) {
  const v = s.visit;
  const uid = ctx.user && ctx.user.id;
  const mine = myTimer(s, uid);
  const anyRunning = (s.timers || []).some((t) => !t.end_at);
  const missing = ((v.checklist && v.checklist.items) || []).filter((i) => i.required && !itemDone(i)).map((i) => i.label);
  const omw = v.on_my_way;
  const late = (v.running_late || [])[v.running_late ? v.running_late.length - 1 : 0];
  let body;
  if (v.status === "completed") {
    body = html`<p class="tf-done">Done${v.completion && v.completion.at ? ` at ${fmtTime(v.completion.at)}` : ""}${v.completion && v.completion.waiting ? " (on this phone, waiting for signal)" : ""}. ${hm(worked(s))} worked.</p>`;
  } else if (v.status === "no_access") {
    body = html`<p class="warn-box">No access${v.no_access && v.no_access.note ? `: ${v.no_access.note}` : ""}. The office will follow up.</p>`;
  } else if (v.status === "cancelled") {
    body = html`<p class="warn-box">This visit was cancelled.</p>`;
  } else {
    const run = mine ? html`<div class="tf-run"><span ${attrs({ "data-since": mine.start_at })}>${hm(since(mine.start_at))}</span><small>Your timer, since ${fmtTime(mine.start_at)}${anyRunning && (s.timers || []).filter((t) => !t.end_at).length > 1 ? " · others are working too" : ""}</small></div>`
      : anyRunning ? html`<p class="small muted">Someone else on this visit is working. Start your own timer when you begin.</p>` : "";
    const big = [];
    if (v.status === "scheduled") big.push(html`<button type="button" class="btn" data-omw>${TICONS.car}On my way</button>`);
    if (["scheduled", "en_route"].includes(v.status)) big.push(html`<button type="button" class="btn primary" data-timer="start">${TICONS.play}Start</button>`);
    if (v.status === "in_progress" && mine) big.push(html`<button type="button" class="btn" data-timer="pause">${icon("pause")}Pause</button>`);
    if (v.status === "in_progress" && !mine) big.push(html`<button type="button" class="btn" data-timer="start">${TICONS.play}Start my timer</button>`);
    if (v.status === "paused") big.push(html`<button type="button" class="btn" data-timer="start">${TICONS.play}Resume</button>`);
    if (["in_progress", "paused"].includes(v.status) || (["scheduled", "en_route"].includes(v.status) && !missing.length)) {
      big.push(html`<button type="button" class="${"btn " + (["in_progress", "paused"].includes(v.status) ? "primary" : "dark") + (big.length % 2 ? "" : " wide")}" data-complete ${attrs({ "aria-disabled": missing.length ? "true" : null })}>${icon("check")}Complete</button>`);
    }
    const small = [];
    if (["scheduled", "en_route"].includes(v.status)) small.push(html`<button type="button" class="btn" data-late>${TICONS.late}Running late</button>`);
    if (["scheduled", "en_route"].includes(v.status)) small.push(html`<button type="button" class="btn" data-noaccess>${TICONS.lock}No access</button>`);
    body = html`${run}
      ${omw ? html`<p class="small muted">On my way at ${fmtTime(omw.at)}, about ${omw.eta_min} min${late ? `; running late at ${fmtTime(late.at)}, about ${late.eta_min} min` : ""}.</p>` : ""}
      ${s.sent ? sentNote(s.sent) : ""}
      <div class="tf-big">${big}</div>
      ${missing.length && ["in_progress", "paused"].includes(v.status) ? html`<p class="tf-missing">Still to do before it's done: ${missing.join(", ")}.</p>` : ""}
      ${small.length ? html`<div class="tf-small">${small}</div>` : ""}`;
  }
  return html`<div class="card tf-state"><div class="tf-state-top"><h2>${TITLE[v.status] || v.status}</h2>${v.minutes_worked && v.status !== "completed" ? html`<span class="small muted">${hm(v.minutes_worked)} so far</span>` : ""}</div>
    ${offlineLine({ offline: s.offline, as_of: s.as_of, waiting: s.waiting, what: "This visit" })}
    ${body}</div>`;
}

function sentNote(r) {
  if (r.status === "sent" || r.status === "queued" || (r.status === "already" && r.mode !== "dry_run")) return html`<p class="tf-sent">Texted the customer.</p>`;
  if (r.status === "dry_run" || (r.status === "already" && r.mode === "dry_run")) {
    return html`<div class="tf-sent">Texts aren't switched on yet, so nothing went out.${r.hand ? html` Send it yourself:<div class="btn-row"><a class="btn" ${attrs({ href: smsHref(r.hand.to, r.hand.body) })}>${icon("text")}Open in Messages</a></div>` : ""}</div>`;
  }
  const why = { quiet_hours: "it's outside texting hours", opted_out: "they opted out of texts", no_consent: "they haven't agreed to texts", no_address: "there's no mobile number", turned_off: "these texts are turned off", paused: "the CRM is paused" }[r.reason] || r.reason || "it was held back";
  return html`<p class="tf-sent">No text went out: ${why}.</p>`;
}

function checklistCard(s) {
  const items = (s.visit.checklist && s.visit.checklist.items) || [];
  if (!items.length) return "";
  const done = items.filter(itemDone).length;
  const open = OPEN.includes(s.visit.status);
  return html`<div class="card"><h2>Checklist <span class="muted small">${done} of ${items.length}</span></h2><ul class="tf-items">${items.map((i) => {
    const ok = itemDone(i);
    const sub = i.kind === "count" && i.value !== undefined ? `Count: ${i.value}` : i.kind === "text" && i.value ? String(i.value) : i.kind === "photo" ? (ok ? "Photo taken" : "Take the photo") : "";
    const act = i.kind === "photo" ? (ok ? "" : html`<span class="act">${TICONS.camera}Photo</span>`) : i.kind === "count" ? html`<span class="act">${ok ? "Change" : "Count"}</span>` : i.kind === "text" ? html`<span class="act">${ok ? "Edit" : "Write"}</span>` : "";
    return html`<li><button type="button" class="${"tf-item" + (ok ? " on" : "")}" ${attrs({ "data-item": i.key, "data-kind": i.kind || "check", "aria-pressed": ok ? "true" : "false", disabled: !open && !ok ? true : null })}>
      <span class="box" aria-hidden="true">${ok ? icon("check") : ""}</span>
      <span class="lbl">${i.label}${i.required ? html`<small class="req">Required${sub ? ` · ${sub}` : ""}</small>` : sub ? html`<small>${sub}</small>` : ""}</span>${act}</button></li>`;
  })}</ul></div>`;
}

function photosCard(s, ctx) {
  const photos = s.visit.photos || [];
  const can = s.visit.status !== "cancelled";
  return html`<div class="card"><h2>Photos <span class="muted small">${photos.length}</span></h2>
    ${photos.length ? html`<div class="tf-photos">${photos.slice(-24).map((p) => {
      const src = p.local ? p.thumb : `/api/crm/files/${encodeURIComponent(p.file_id)}?thumb=1`;
      return html`<span class="${"tf-photo" + (p.local ? " wait" : "")}">${src ? html`<img ${attrs({ src, alt: `${p.tag || "other"} photo`, loading: "lazy" })}>` : "Photo"}<span class="tag">${p.tag || "other"}</span></span>`;
    })}</div>` : html`<p class="small muted">No photos yet. Before and after photos show in the customer's visit history; issue photos stay with the office.</p>`}
    ${can ? html`<div class="tf-small" style="margin-top:12px">
      <button type="button" class="btn" data-photo="before">${TICONS.camera}Before</button>
      <button type="button" class="btn" data-photo="after">${TICONS.camera}After</button>
      <button type="button" class="btn" data-photo="issue">${TICONS.camera}Issue</button>
    </div>` : ""}</div>`;
}

function workCard(s, ctx) {
  const job = ctx.data && ctx.data.job;
  const lines = (job && job.lines) || [];
  const prices = !!(ctx.data && ctx.data.can && ctx.data.can.prices);
  const canAdd = ctx.can("visits:add_line") && OPEN.includes(s.visit.status);
  if (!lines.length && !canAdd) return "";
  return html`<div class="card"><h2>The work</h2>
    ${lines.length ? html`<ul class="wk-lines">${lines.map((l) => html`<li><span>${l.title}${l.qty_milli && l.qty_milli !== 1000 ? html` <span class="muted">× ${l.qty_milli / 1000}</span>` : ""}${l.upsell_user_id ? html` <span class="pill green">Added on site</span>` : ""}</span>${prices && l.total_cents != null ? html`<b class="num">${money(l.total_cents)}</b>` : ""}</li>`)}
      ${prices && job.totals ? html`<li class="tot"><span>Total</span><b class="num">${money(job.totals.total_cents)}</b></li>` : ""}</ul>` : ""}
    ${canAdd ? html`<div class="btn-row"><button type="button" class="btn" data-addline>${TICONS.plus}Add to the job</button></div>` : ""}</div>`;
}

function notesCard(s) {
  const v = s.visit;
  return html`<div class="card"><h2>Notes</h2>
    ${v.tech_notes ? html`<p class="wk-pre">${v.tech_notes}</p>` : html`<p class="small muted">Anything the office or the next crew should know: a sticky gate, a cracked pane, what the customer asked for.</p>`}
    ${v.status !== "cancelled" ? html`<form class="tf-note-form" data-note-form><label class="field"><span class="sr">A note</span><textarea name="text" rows="3" maxlength="1000" placeholder="Add a note"></textarea></label><button type="submit" class="btn">${TICONS.note}Save the note</button></form>` : ""}
    <div class="btn-row"><button type="button" class="btn danger" data-incident>${TICONS.flag}Report an incident</button></div></div>`;
}

function render(s, ctx) {
  if (!s || !s.visit) return html``;
  const last = s.last ? html`<div class="card"><h2>Last time here <span class="muted small">${dateShort(s.last.date)}</span></h2><p class="wk-pre">${s.last.text}</p></div>` : "";
  // on a phone the big buttons sit in a bar over the tab bar, so Start and On my way are never below the fold
  return html`<div class="${"tf-panel" + (OPEN.includes(s.visit.status) ? " has-bar" : "")}">${stateCard(s, ctx)}${last}${checklistCard(s)}${photosCard(s, ctx)}${workCard(s, ctx)}${notesCard(s)}</div>`;
}

// ------------------------------------------------------------ doing things

async function act(ctx, el, path, body, { method, ok, needsSignal, what, then } = {}) {
  if (el) el.disabled = true;
  let r;
  try {
    r = await send(ctx, path, body, { method, needsSignal, what });
  } catch (err) {
    if (el) el.disabled = false;
    toast((err && err.message) || "That didn't work.", { bad: true });
    return null;
  }
  if (r.queued) toast(r.saved === false ? FULL_NOTE : "Saved on this phone. It goes out when you have signal.", r.saved === false ? { bad: true, ms: 6000 } : undefined);
  else if (r.data && r.data.pending) toast(r.data.message || "The office will look at this one.", { bad: true });
  else if (ok) toast(ok);
  if (then) then(r);
  ctx.refresh();
  return r;
}
const keepSent = (ctx) => (r) => { if (r && r.data && r.data.text) sentFor.set(ctx.state.visit.id, { text: r.data.text, at: Date.now() }); };

const vid = (ctx) => encodeURIComponent(ctx.state.visit.id);

function askNumber({ title, label, value = "", yes = "Save", min = 1, max = 240, hint = "" }) {
  return new Promise((resolve) => {
    let out = null;
    const s = sheet({
      title,
      body: html`<form class="stack" data-ask>${hint ? html`<p class="small muted">${hint}</p>` : ""}<label class="field"><span>${label}</span><input name="n" type="number" inputmode="numeric" ${attrs({ min, max, value: String(value) })} required></label><button type="submit" class="btn primary block">${yes}</button></form>`,
      onClose: () => resolve(out),
      events: {
        "submit [data-ask]": (e, f) => {
          e.preventDefault();
          const n = Number(f.elements.n.value);
          if (!Number.isInteger(n) || n < min || n > max) { toast(`Use a whole number from ${min} to ${max}.`, { bad: true }); return; }
          out = n; s.close();
        },
      },
    });
    setTimeout(() => { const i = s.el.querySelector("input"); if (i) i.focus(); }, 300);
  });
}

function askText({ title, label, value = "", yes = "Save", required = true, max = 500, placeholder = "" }) {
  return new Promise((resolve) => {
    let out = null;
    const s = sheet({
      title,
      body: html`<form class="stack" data-ask><label class="field"><span>${label}</span><textarea name="t" rows="4" ${attrs({ maxlength: String(max), placeholder })}>${value}</textarea></label><button type="submit" class="btn primary block">${yes}</button></form>`,
      onClose: () => resolve(out),
      events: {
        "submit [data-ask]": (e, f) => {
          e.preventDefault();
          const t = String(f.elements.t.value || "").trim();
          if (required && !t) { toast("Write it down first.", { bad: true }); return; }
          out = t; s.close();
        },
      },
    });
  });
}

async function etaDefault(ctx) {
  const p = ctx.data && ctx.data.property;
  const to = p && p.geo && Number.isFinite(p.geo.lat) ? [p.geo.lat, p.geo.lng] : Array.isArray(ctx.state.visit.geo) ? ctx.state.visit.geo : null;
  const from = await here();
  return { eta: etaMinutes(from, to), from };
}

async function takePhoto(ctx, el, { tag, item }) {
  const file = await capture();
  if (!file) return;
  if (el) el.disabled = true;
  toast("Preparing the photo...");
  let p;
  try {
    p = await prepare(file, { maxBytes: MAX_PHOTO });
  } catch (err) {
    if (el) el.disabled = false;
    toast((err && err.message) || "This phone couldn't prepare the photo.", { bad: true });
    return;
  }
  const body = { tag, ...(item ? { item } : {}), data: await toBase64(p.full), thumb: await toBase64(p.thumb) };
  await act(ctx, el, `/visits/${vid(ctx)}/photos`, body, { ok: "Photo saved" });
}

const events = {
  "click [data-timer]": (e, el, ctx) => {
    const action = el.dataset.timer;
    // a pause names the segment this phone started (two phones: the server never stops the other one's)
    const mine = action === "pause" ? myTimer(ctx.state, ctx.user && ctx.user.id) : null;
    act(ctx, el, `/visits/${vid(ctx)}/timer`, { action, ...(mine && mine.client_id ? { timer_client_id: mine.client_id } : {}) }, { ok: action === "start" ? "Timer started" : "Timer paused" });
  },
  "click [data-complete]": async (e, el, ctx) => {
    const items = (ctx.state.visit.checklist && ctx.state.visit.checklist.items) || [];
    const missing = items.filter((i) => i.required && !itemDone(i)).map((i) => i.label);
    if (missing.length) { toast(`Finish the checklist first: ${missing.join(", ")}.`, { bad: true }); return; }
    act(ctx, el, `/visits/${vid(ctx)}/complete`, {}, { ok: "Done. Nice work." });
  },
  "click [data-omw]": async (e, el, ctx) => {
    if (!online()) { toast("On my way needs signal. Nothing was sent.", { bad: true }); return; }
    el.disabled = true;
    const { eta, from } = await etaDefault(ctx);
    el.disabled = false;
    const n = await askNumber({ title: "On my way", label: "About how many minutes away?", value: eta, yes: "Text the customer", hint: "The customer gets a text with your first name and this time." });
    if (!n) return;
    await act(ctx, el, `/visits/${vid(ctx)}/on-my-way`, { eta_min: n, ...(from ? { lat: from[0], lng: from[1] } : {}) }, { needsSignal: true, what: "On my way", then: keepSent(ctx) });
  },
  "click [data-late]": async (e, el, ctx) => {
    if (!online()) { toast("Running late needs signal. Nothing was sent.", { bad: true }); return; }
    const n = await askNumber({ title: "Running late", label: "About how many minutes until you're there?", value: 20, yes: "Text the customer" });
    if (!n) return;
    await act(ctx, el, `/visits/${vid(ctx)}/running-late`, { eta_min: n }, { needsSignal: true, what: "Running late", then: keepSent(ctx) });
  },
  "click [data-noaccess]": async (e, el, ctx) => {
    const note = await askText({ title: "No access", label: "What happened?", yes: "Mark no access", placeholder: "Gate locked, nobody home" });
    if (note === null) return;
    act(ctx, el, `/visits/${vid(ctx)}/no-access`, { note }, { ok: "Marked no access. The office will follow up." });
  },
  "click [data-item]": async (e, el, ctx) => {
    const key = el.dataset.item;
    const kind = el.dataset.kind;
    const item = ((ctx.state.visit.checklist && ctx.state.visit.checklist.items) || []).find((i) => i.key === key);
    if (!item) return;
    const done = itemDone(item);
    if (kind === "photo") {
      if (done) return;
      return takePhoto(ctx, el, { tag: /after/i.test(key) ? "after" : /before|walk/i.test(key) ? "before" : "other", item: key });
    }
    if (kind === "count") {
      const n = await askNumber({ title: item.label, label: "How many?", value: item.value ?? "", min: 0, max: 100000 });
      if (n === null) return;
      return act(ctx, null, `/visits/${vid(ctx)}/checklist`, { key, done: true, value: n }, { method: "PATCH" });
    }
    if (kind === "text") {
      const t = await askText({ title: item.label, label: item.label, value: item.value || "" });
      if (t === null) return;
      return act(ctx, null, `/visits/${vid(ctx)}/checklist`, { key, done: true, value: t }, { method: "PATCH" });
    }
    act(ctx, el, `/visits/${vid(ctx)}/checklist`, { key, done: !done }, { method: "PATCH" });
  },
  "click [data-photo]": (e, el, ctx) => takePhoto(ctx, el, { tag: el.dataset.photo }),
  "submit [data-note-form]": (e, f, ctx) => {
    e.preventDefault();
    const text = String(f.elements.text.value || "").trim();
    if (!text) { toast("Write the note first.", { bad: true }); return; }
    act(ctx, f.querySelector("button"), `/visits/${vid(ctx)}/notes`, { text }, { ok: "Note saved" });
  },
  "click [data-incident]": async (e, el, ctx) => {
    const text = await askText({ title: "Report an incident", label: "What happened?", yes: "Report it", max: 2000, placeholder: "Something broke, someone got hurt, a complaint on site" });
    if (!text) return;
    act(ctx, el, `/visits/${vid(ctx)}/incident`, { text }, { ok: "Reported. The owners have it." });
  },
  "click [data-addline]": (e, el, ctx) => addLine(ctx),
};

async function addLine(ctx) {
  let book;
  try { book = (await ctx.api(`/visits/${vid(ctx)}/pricebook`)).data; } catch (err) {
    toast(err && err.code === "offline" ? "The price book needs signal the first time." : (err && err.message) || "The price book didn't load.", { bad: true });
    return;
  }
  const items = book.items || [];
  if (!items.length) { toast("Nothing in the price book to add.", { bad: true }); return; }
  let picked = null;
  const s = sheet({
    title: "Add to the job",
    body: html`<form class="stack" data-line-form>
      <ul class="tf-pick">${items.map((i) => html`<li><button type="button" ${attrs({ "data-pick": i.id, "aria-pressed": "false" })}><span>${i.name}<small>${i.unit && i.unit !== "flat" ? `per ${i.unit}` : "flat"}${book.prices && i.unit_cents ? ` · ${money(i.unit_cents)}` : ""}</small></span></button></li>`)}</ul>
      <label class="field tf-qty"><span>How many</span><input name="qty" type="number" inputmode="numeric" min="1" max="1000" value="1"></label>
      <button type="submit" class="btn primary block">Add it</button></form>`,
    events: {
      "click [data-pick]": (e, b) => {
        picked = b.dataset.pick;
        for (const x of s.el.querySelectorAll("[data-pick]")) x.setAttribute("aria-pressed", x === b ? "true" : "false");
      },
      "submit [data-line-form]": (e, f) => {
        e.preventDefault();
        if (!picked) { toast("Pick what you added.", { bad: true }); return; }
        const qty = Number(f.elements.qty.value);
        if (!Number.isFinite(qty) || qty <= 0 || qty > 1000) { toast("Use a quantity from 1 to 1,000.", { bad: true }); return; }
        s.close();
        act(ctx, null, `/visits/${vid(ctx)}/lines`, { price_item_id: picked, qty }, { ok: "Added to the job" });
      },
    },
  });
}

function mount(el) {
  tellShell(el);
  // the running timer moves on while the visit is on screen
  const timer = setInterval(() => {
    if (!document.contains(el)) { clearInterval(timer); return; }
    for (const x of el.querySelectorAll("[data-since]")) x.textContent = hm(since(x.dataset.since));
  }, 30000);
}

export default { load, render, events, mount };
