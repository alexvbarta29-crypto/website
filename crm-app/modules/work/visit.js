// The single Visit screen (design §9.2 "Visit"; M4a owns it). The office
// part: who, where, when, what the customer was told, the job's work, the
// crew notes and access, the checklist, the photos, the texts that went (or
// would have gone, in dry-run), and the office's buttons: Move or reassign,
// Mark done, No access, Cancel, Reopen. Everything else arrives through the
// manifests' visitActions (contract in work/manifest.js): M4b's field
// panel for an assignee, Money's "Collect payment". A technician reaches
// only their own visits in the window the server allows; the server strips
// what they may not see.
//
// Built around one big button (the layout report, Nov 2026): above the
// content a row of labelled quick buttons, Call · Navigate · Photos ·
// Checklist, always in that order and place (Navigate is never hidden when
// there is an address); and one big coral button with the visit's next
// step, On my way → Start → Finish → Get paid (work/visit-step.js), fixed
// at the bottom of a phone above the tab bar, in the page's header on a
// desk. A panel that works the visit names the step (its step(state, ctx))
// and runs it (runStep(key, ctx, el)); Get paid is Money's "Collect
// payment", shown only to someone who may collect when something is owed.
// A change made with no signal says "Saved, will send when online".

import { html, icon, attrs, toast, confirmSheet, delegate, sheet, rnd, statusPill, pillBtn, cardHead, personCard, addressCard, lineItems, disclosure } from "../../core/ui.js";
import { TICONS } from "./tech-kit.js";
import { photoTile } from "../../core/camera.js";
import { dateLong, dateShort, money, dateTime, ago, phone } from "../../core/format.js";
import { directionsLink, directionsUrl } from "../../core/map.js";
import { MANIFESTS } from "../index.js";
import { ensureStyles as officeStyles, slotText, kindLabel, faces, names, scheduleSheet, reasonSheet, loadUsers, officeView, VISIT_STATUS } from "./office-kit.js";

const VISIT_TONE = { scheduled: "blue", en_route: "amber", in_progress: "amber", paused: "amber", completed: "green", no_access: "red", cancelled: "red" };
import { owedFrom } from "./visit-step.js";

// The office's stylesheet and the Visit's own (the quick row and the big button).
let styled = false;
function ensureStyles() {
  officeStyles();
  if (styled || typeof document === "undefined") return;
  styled = true;
  const l = document.createElement("link");
  l.rel = "stylesheet";
  l.href = "/crm-app/modules/work/visit-styles.css";
  document.head.appendChild(l);
}

const WHEN_OK = (a, data) => (a.when === "office" ? !!data.can.office : a.when === "assignee" ? !!data.can.assignee : true);

// The visitActions this person gets for this visit, in order.
export function actionsFor(data, can, manifests = MANIFESTS) {
  return manifests.flatMap((m) => (m.visitActions || []).map((a) => ({ ...a, module: m.name })))
    .filter((a) => a && a.key && typeof a.load === "function" && WHEN_OK(a, data) && (!a.perm || can(a.perm)))
    .sort((a, b) => (a.order || 50) - (b.order || 50));
}

async function load(params, ctx) {
  ensureStyles();
  // the last good copy when there's no signal (the tech app works a visit offline, §2.5)
  const r = await ctx.api(`/visits/${encodeURIComponent(params.id)}`);
  const data = r.data;
  if (r.offline) { data.offline = true; data.as_of = r.as_of; }
  const users = officeView() ? await loadUsers(ctx).catch(() => []) : [];
  const acts = actionsFor(data, ctx.can);
  const panels = [];
  const buttons = [];
  for (const a of acts) {
    if (a.panel) {
      try {
        const mod = (await a.load()).default;
        const p = { key: a.key, label: a.label, mod, state: null, replaces: Array.isArray(a.replaces) ? a.replaces : [] };
        p.ctx = { ...ctx, data, get state() { return p.state; }, set state(x) { p.state = x; }, rerender: () => ctx.rerender(), refresh: () => ctx.refresh() };
        p.state = mod.load ? await mod.load(data, p.ctx) : {};
        panels.push(p);
      } catch (e) { panels.push({ key: a.key, label: a.label, failed: (e && e.message) || "That didn't load." }); }
    } else buttons.push(a);
  }
  // Get paid: Money's Collect payment, once the visit is done (as this phone shows it) and something is owed
  const pay = buttons.find((a) => a.key === "money.collect");
  const field = panels.find((p) => p.state && p.state.visit);
  const status = field ? field.state.visit.status : data.visit.status;
  data.collect = pay ? { key: pay.key, owed: false } : null;
  if (pay && status === "completed") {
    try { data.collect.owed = owedFrom((await ctx.api(`/visits/${encodeURIComponent(params.id)}/payment`, { timeout: 5000 })).data); } catch (e) { /* not known: no button */ }
  }
  return { ...data, etag: r.etag, users, panels, buttons };
}

// The big button's step: the panel working the visit names it; for someone
// not on it (the office), only Get paid once the visit is done and owed.
export function bigStep(s) {
  for (const p of s.panels || []) {
    if (p.failed || !p.mod || typeof p.mod.step !== "function") continue;
    const st = p.mod.step(p.state || {}, p.ctx);
    return st ? { ...st, panel: p.key } : null;
  }
  const c = s.collect;
  return c && c.owed && s.visit && s.visit.status === "completed" ? { key: "pay", label: "Get paid", attr: { "data-vact": c.key } } : null;
}

const STEP_ICON = { omw: () => TICONS.car, start: () => TICONS.play, resume: () => TICONS.play, finish: () => icon("check"), pay: () => icon("money") };

// Call · Navigate · Photos · Checklist, then the big button. One row; CSS
// puts the button at the bottom of a phone and beside the row on a desk.
function actionHead(s, { ph, addr, where, photos, items, done, waiting, sheet: asSheet }) {
  const go = bigStep(s);
  const q = (label, ic, sub, a) => html`<a class="vb-q" ${a}>${ic}<span class="vb-l">${label}</span>${sub ? html`<span class="vb-s">${sub}</span>` : ""}</a>`;
  const off = (label, ic) => html`<span class="vb-q off" aria-disabled="true">${ic}<span class="vb-l">${label}</span></span>`;
  return html`<div class="vb-head">
    <nav class="vb-quick" aria-label="Quick actions">
      ${ph ? q("Call", icon("phone"), "", attrs({ href: "tel:" + String(ph.e164 || "").replace(/[^+\d]/g, "") })) : off("Call", icon("phone"))}
      ${addr ? q("Navigate", icon("map"), "", directionsLink(addr)) : where ? q("Navigate", icon("map"), "", directionsLink(where)) : off("Navigate", icon("map"))}
      <button type="button" class="vb-q" data-jump="photos">${TICONS.camera}<span class="vb-l">Photos</span><span class="vb-s">${String(photos)}</span></button>
      ${items ? html`<button type="button" class="vb-q" ${attrs({ "data-jump": asSheet ? "checksheet" : "check" })}>${icon("check")}<span class="vb-l">Checklist</span><span class="vb-s">${`${done}/${items}`}</span></button>` : off("Checklist", icon("check"))}
    </nav>
    ${go ? html`<div class="vb-bar">
      ${waiting ? html`<p class="vb-saved" role="status">${TICONS.cloud}<span>Saved, will send when online.</span></p>` : ""}
      <button type="button" class="${"btn primary vb-go" + (go.blocked ? " blocked" : "")}" ${attrs({ "data-step": go.key, ...go.attr, "aria-disabled": go.blocked ? "true" : null })}>${(STEP_ICON[go.key] || (() => ""))()}${go.label}</button>
    </div>` : ""}
  </div>`;
}

// The visit's photos for the office (read only; the crew's panel shows its own).
function photosCard(v) {
  const photos = v.photos || [];
  return html`<div class="rs-card" id="vf-photos">${cardHead("Photos", { count: String(photos.length) })}
    ${photos.length ? html`<div class="tf-photos">${photos.slice(-24).map((p) => (p.file_id ? photoTile(p.file_id, { alt: `${p.tag || "other"} photo`, tag: p.tag || "other", cls: "tf-photo" }) : html`<span class="tf-photo">Photo<span class="tag">${p.tag || "other"}</span></span>`))}</div>` : html`<p class="rs-empty">No photos yet. The crew's before and after photos show here.</p>`}</div>`;
}

function remindRow(label, m) {
  let st;
  if (!m) st = html`<span class="pill">Not yet</span>`;
  else if (m.state === "sent" || m.state === "done") st = html`<span class="${"pill " + (m.dry ? "amber" : "green")}">${m.dry ? "Would have sent" : "Sent"}</span>`;
  else if (m.state === "skipped") st = html`<span class="pill">Skipped</span>`;
  else st = html`<span class="pill">${m.state || "Queued"}</span>`;
  const why = m && m.result && (m.result.reason || m.result.skipped) ? String(m.result.reason || m.result.skipped).replace(/_/g, " ") : "";
  return html`<li class="wk-rem"><span class="who"><span class="nm">${label}</span>${m && m.at ? html`<span class="sub">${dateTime(m.at)}${why ? ` · ${why}` : ""}</span>` : ""}</span>${st}</li>`;
}
const REMINDERS = [["confirm", "Confirmation"], ["d14", "Reminder, 2 weeks before"], ["d2", "Reminder, 2 days before"]];
// "3 to come", "1 sent, 2 to come": the folded Texts and emails card's line.
export function textsLine(r) {
  const all = REMINDERS.map(([k]) => r && r[k]);
  const sent = all.filter((m) => m && (m.state === "sent" || m.state === "done")).length;
  const skipped = all.filter((m) => m && m.state === "skipped").length;
  const rest = all.length - sent - skipped;
  return [sent ? `${sent} sent` : "", skipped ? `${skipped} skipped` : "", rest ? `${rest} to come` : ""].filter(Boolean).join(", ");
}
function textsSheet(s) {
  sheet({ title: "Texts and emails", body: html`<ul class="list wk-rems">${REMINDERS.map(([k, label]) => remindRow(label, s.reminders[k]))}</ul><p class="small muted">While texting is in practice mode, nothing goes out: "Would have sent" says what would have.</p>` });
}

// Pricing: the job's work (prices for whoever may see them).
function lines(job, prices) {
  const list = (job && job.lines) || [];
  if (!list.length) return "";
  return html`<div class="rs-card">${cardHead("Pricing")}${lineItems(list.map((l) => ({
    title: l.title, sub: l.qty_milli && l.qty_milli !== 1000 ? `${l.qty_milli / 1000} × ${prices && l.unit_cents != null ? money(l.unit_cents) : "each"}` : "",
    amount: prices && l.total_cents != null ? money(l.total_cents) : "",
  })), { subtotal: prices && job.totals && (job.discounts || []).length ? job.totals.subtotal_cents : null, discounts: prices && job.totals && job.totals.discount_cents ? [{ label: "Discounts", amount: -job.totals.discount_cents }] : [], total: prices && job.totals ? job.totals.total_cents : null })}</div>`;
}

// An item is done when the crew ticked it (done_at, as the server's finish
// gate reads it, design §5.5) or gave its photo, count or note.
export const itemDone = (i) => !!(i && (i.done_at || i.done === true || (i.value !== undefined && i.value !== null && i.value !== "")));

// The office's checklist, folded to "Checklist · 0 of 8 ›" (a sheet with the list, required items flagged).
function checklist(v) {
  const items = (v.checklist && v.checklist.items) || [];
  if (!items.length) return "";
  const done = items.filter(itemDone).length;
  return html`<div id="vf-check">${disclosure("Checklist", { value: `${done} of ${items.length}`, sub: items.some((i) => i.required && !itemDone(i)) ? "Required items still open" : "", data: { checks: true } })}</div>`;
}
function checklistSheet(v) {
  const items = (v.checklist && v.checklist.items) || [];
  const done = items.filter(itemDone).length;
  sheet({
    title: `Checklist · ${done} of ${items.length}`,
    body: html`<ul class="wk-check">${items.map((i) => {
      const ok = itemDone(i);
      return html`<li class="${ok ? "on" : ""}"><span class="box" aria-hidden="true">${ok ? icon("check") : ""}</span><span>${i.label}${i.required ? html` <span class="pill amber">Required</span>` : ""}${i.value !== undefined && i.value !== null && i.value !== "" && i.kind !== "photo" ? html`<small class="muted"> · ${String(i.value)}</small>` : ""}</span></li>`;
    })}</ul><p class="small muted">The crew ticks these on their phone.</p>`,
  });
}

function accessBits(prop) {
  const a = (prop && prop.access) || {};
  return [
    a.gate_code ? ["Gate code", a.gate_code] : null, a.lockbox ? ["Lockbox", a.lockbox] : null, a.pets ? ["Pets", a.pets] : null,
    a.parking ? ["Parking", a.parking] : null, a.notes ? ["Access", a.notes] : null,
  ].filter(Boolean);
}
function access(prop, job) {
  const bits = accessBits(prop);
  const crew = job && job.crew_notes;
  if (!bits.length && !crew) return "";
  return html`<div class="rs-card wk-notes">${cardHead("For the crew")}
    ${bits.length ? html`<dl class="kv">${bits.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>` : ""}
    ${crew ? html`<p class="wk-pre wk-crewbox">${crew}</p>` : ""}</div>`;
}

// The visit's top card: status and window, the day, the job, who goes (the
// pencil moves or reassigns), what the customer was told, how it ended.
function topCard(s, { office }) {
  const v = s.visit;
  const j = s.job;
  const c = s.can || {};
  const people = s.people || [];
  const field = (s.panels || []).find((p) => !p.failed && p.state && p.state.visit);
  const st = field ? field.state.visit.status : v.status;
  return html`<div class="rs-card wk-head wk-vtop">
    <div class="wk-jtop-r"><span class="rs-pills">${statusPill(VISIT_STATUS[st] || st, VISIT_TONE[st] || "grey")}${j && j.kind && j.kind !== "standard" ? statusPill(kindLabel(j.kind), "grey") : ""}</span><span class="rs-sub num">${slotText(v)}</span></div>
    <div class="wk-when-big"><b>${dateLong(v.date)}</b>${j ? html`<span>${j.title}</span>` : ""}</div>
    ${s.arrival && (v.date_only || (v.window && v.window.type === "anytime")) ? html`<p class="rs-sub">Customer was told: ${s.arrival}</p>` : ""}
    <div class="wk-vwho"><span class="rs-label wk-vwho-l">Who</span><span class="wk-who">${office ? faces(s.users, v.assignee_ids) : ""}<span>${people.length ? people.map((p) => p.name).join(", ") : "Nobody yet"}</span></span>
      ${office && c.move ? rnd("edit", "Move or reassign", { tone: "grey", sm: true, data: { move: true }, popup: true }) : ""}</div>
    ${v.status === "cancelled" && v.cancel_reason ? html`<p class="warn-box">Cancelled: ${v.cancel_reason}${v.late_cancel ? " (late cancel)" : ""}</p>` : ""}
    ${v.status === "no_access" ? html`<p class="warn-box">No access${v.no_access && v.no_access.note ? `: ${v.no_access.note}` : ""}</p>` : ""}
    ${v.completion && v.completion.at && v.status === "completed" ? html`<p class="rs-sub">Done ${ago(v.completion.at)}${v.completion.office ? " (marked by the office)" : ""}</p>` : ""}
    ${v.moved_by_op ? html`<p class="rs-sub">Moved by a rain-day move.</p>` : ""}
    ${s.collectPill ? html`<div class="wk-jtop-act">${pillBtn(s.collectPill.label, { icon: "money", data: { vact: s.collectPill.key } })}</div>` : ""}
  </div>`;
}

function people(s, { office, addr, where, ph }) {
  const out = [];
  const c = s.contact;
  const n = ph ? String(ph.e164 || "").replace(/[^+\d]/g, "") : "";
  if (c) out.push(personCard({ name: c.display_name || "Customer", sub: ph ? phone(ph.e164) : "Customer", href: office ? "#/contacts/" + encodeURIComponent(c.id) : null, call: n ? "tel:" + n : null, text: n ? "sms:" + n : null }));
  if (where) {
    const p = s.property;
    const a = (p && p.access) || {};
    const second = addr ? [[addr.city, [addr.state, addr.zip].filter(Boolean).join(" ")].filter(Boolean).join(", "), a.gate_code ? `gate ${a.gate_code}` : ""].filter(Boolean).join(" · ") : "";
    out.push(addressCard({ line1: addr ? addr.street1 || addr.city : where, line2: second, nav: directionsUrl(addr || where), edit: office && p && p.id ? { label: "Edit the place and its access", href: "#/properties/" + encodeURIComponent(p.id) } : null }));
  }
  return out;
}

// The "..." sheet: the office's buttons, the crew's (from the field panel),
// Collect payment, and the way to the job and the customer.
function moreRows(s, ctx) {
  if (!s || !s.visit) return [];
  const c = s.can || {};
  const office = !!c.office;
  const panelRows = (s.panels || []).filter((p) => !p.failed && p.mod && typeof p.mod.moreRows === "function").flatMap((p) => { try { return p.mod.moreRows(p.state || {}, p.ctx, { office }) || []; } catch (e) { return []; } });
  const collect = s.buttons.map((a) => ({ label: a.label, icon: a.icon || "money", run: () => runAction(ctx, a.key), data: { vact: a.key } }));
  return [
    office ? [c.move && { label: "Move or reassign", icon: "cal", run: () => move(ctx), data: { move: true } },
      c.done && { label: "Mark done", icon: "check", run: () => markDone(ctx), data: { done: true } },
      c.no_access && { label: "No access", icon: "flag", run: () => noAccess(ctx), data: { noaccess: true } },
      c.reopen && { label: "Reopen", icon: "undo", run: () => reopen(ctx), data: { reopen: true } }] : [],
    [...collect, ...panelRows],
    [office && s.job && { label: "Open job", icon: "doc", hint: s.job.number_label || "", href: "#/jobs/" + encodeURIComponent(s.job.id) },
      office && s.contact && { label: "Open customer", icon: "user", href: "#/contacts/" + encodeURIComponent(s.contact.id) }],
    [office && c.cancel && { label: "Cancel visit", icon: "close", danger: true, run: () => cancel(ctx), data: { cancel: true } }],
  ];
}

const move = (ctx) => { const s = ctx.state; scheduleSheet(ctx, { visit: s.visit, etag: s.etag, town: s.visit.town, onDone: () => ctx.refresh() }); };
async function markDone(ctx) {
  if (!(await confirmSheet("Mark this visit done? The tech's timer and checklist stay as they are.", { title: "Mark done", yes: "Mark done" }))) return;
  act(ctx, "done", {}, "Marked done");
}
async function noAccess(ctx) {
  const r = await reasonSheet({ title: "No access", label: "What happened?", yes: "Mark no access" });
  if (r) act(ctx, "mark-no-access", { note: r.reason }, "Marked no access. An owner decides on the fee.");
}
async function cancel(ctx) {
  const r = await reasonSheet({ title: "Cancel this visit", late: true });
  if (r) act(ctx, "cancel", { reason: r.reason, late: r.late }, "Cancelled");
}
async function reopen(ctx) {
  if (!(await confirmSheet("Reopen this visit so the crew can finish it?", { title: "Reopen", yes: "Reopen" }))) return;
  act(ctx, "reopen", {}, "Reopened");
}
async function runAction(ctx, key) {
  const a = ctx.state.buttons.find((x) => x.key === key);
  if (!a) return;
  try { const mod = (await a.load()).default; await mod.run(ctx.state, ctx); } catch (err) { toast((err && err.message) || "That didn't work.", { bad: true }); }
}

export default {
  title: (s) => (s && s.visit && s.visit.date ? `Visit · ${dateShort(s.visit.date)}` : "Visit"),
  moreTitle: (s) => (s && s.contact ? s.contact.display_name || "Visit" : "Visit"),
  more: (s, ctx) => moreRows(s, ctx),
  load,
  render(s, ctx) {
    const v = s.visit;
    const j = s.job;
    const prop = s.property;
    const addr = prop && prop.address;
    const where = addr ? [addr.street1, addr.city].filter(Boolean).join(", ") : v.address_line || v.town || "";
    const office = !!(s.can && s.can.office);
    const ph = s.contact && (s.contact.phones || []).find((p) => p.primary) || (s.contact && (s.contact.phones || [])[0]);
    // cards a panel shows itself (the field panel: its own checklist, work and notes)
    const shown = new Set(s.panels.filter((p) => !p.failed).flatMap((p) => p.replaces || []));
    // what the quick buttons count: the panel's copy when one works the visit (the phone's own changes on it)
    const field = s.panels.find((p) => !p.failed && p.state && p.state.visit);
    const fv = field ? field.state.visit : v;
    const items = (fv.checklist && fv.checklist.items) || [];
    // (Get paid on the big button is Money's Collect payment: not twice on screen; otherwise a pill on the top card)
    const go = bigStep(s);
    const side = s.buttons.filter((a) => !(go && go.key === "pay" && a.key === go.attr["data-vact"]));
    s.collectPill = side[0] || null;
    const head = actionHead(s, { ph, addr, where, photos: (fv.photos || []).length, items: items.length, done: items.filter(itemDone).length, waiting: field ? field.state.waiting || 0 : 0, sheet: !shown.has("checklist") });
    // two columns on a wide desk: the visit on the left, the people and places and texts on the
    // right (a phone shows one column: wk-vmain/wk-vside are display:contents there)
    return html`<div class="${"stack rs-page wk wk-vpage" + (go ? " vb-has-go" : "")}">${head}<div class="wk-vmain">
      ${topCard(s, { office })}
      ${access(prop, j)}
      ${s.panels.map((p) => html`<section class="wk-panel" ${attrs({ "data-panel": p.key, "aria-label": p.label || p.key })}>${p.failed ? html`<div class="card empty"><h2>${p.label || "This part"} didn't load</h2><p>${p.failed}</p></div>` : p.mod.render(p.state || {}, p.ctx)}</section>`)}
      ${shown.has("lines") ? "" : lines(j, !!(s.can && s.can.prices))}
      ${shown.has("checklist") ? "" : checklist(v)}
      ${shown.has("photos") ? "" : photosCard(v)}
      ${v.tech_notes && !shown.has("notes") ? html`<div class="rs-card">${cardHead("Notes from the visit")}<p class="wk-pre">${v.tech_notes}</p></div>` : ""}
      ${office && j && j.office_notes ? html`<div class="rs-card">${cardHead("Office notes")}<p class="wk-pre">${j.office_notes}</p></div>` : ""}
      </div><div class="wk-vside">
      ${people(s, { office, addr, where, ph })}
      ${j && office ? disclosure("Job", { value: j.number_label || v.job_number || "", sub: j.title, href: "#/jobs/" + encodeURIComponent(j.id) }) : ""}
      ${s.reminders ? html`<div class="wk-late">${disclosure("Texts and emails", { sub: textsLine(s.reminders), data: { texts: true } })}</div>` : ""}
      ${office && v.updated_at ? html`<p class="foot-note wk-late">Changed ${ago(v.updated_at)}</p>` : ""}
    </div></div>`;
  },
  mount(view, s) {
    for (const p of s.panels || []) {
      if (!p.mod || !p.mod.events) continue;
      const el = view.querySelector(`[data-panel="${p.key}"]`);
      if (!el || el.dataset.wired) continue;
      el.dataset.wired = "1";
      const wrapped = {};
      for (const [k, fn] of Object.entries(p.mod.events)) wrapped[k] = (e, x) => fn(e, x, p.ctx);
      delegate(el, wrapped);
      if (p.mod.mount) { try { p.mod.mount(el, p.state, p.ctx); } catch (e) { /* a panel's mount never breaks the visit */ } }
    }
  },
  events: {
    // the big button: the panel working the visit runs its step; Get paid is Money's Collect payment ([data-vact] below)
    "click [data-step]": (e, el, ctx) => {
      const go = bigStep(ctx.state);
      if (!go || go.key !== el.dataset.step || go.key === "pay") return;
      if (go.blocked) { toast(`Finish the checklist first: ${go.blocked.join(", ")}.`, { bad: true }); return; }
      const p = ctx.state.panels.find((x) => x.key === go.panel);
      if (p && p.mod && typeof p.mod.runStep === "function") p.mod.runStep(go.key, p.ctx, el);
    },
    "click [data-jump]": (e, el, ctx) => {
      if (el.dataset.jump === "checksheet") { checklistSheet(ctx.state.visit); return; }
      const to = document.getElementById(el.dataset.jump === "photos" ? "vf-photos" : "vf-check");
      if (to) to.scrollIntoView({ behavior: "smooth", block: "start" });
    },
    "click [data-checks]": (e, el, ctx) => checklistSheet(ctx.state.visit),
    "click [data-texts]": (e, el, ctx) => textsSheet(ctx.state),
    "click [data-move]": (e, el, ctx) => move(ctx),
    "click [data-vact]": (e, el, ctx) => runAction(ctx, el.dataset.vact),
  },
};

async function act(ctx, path, body, ok) {
  try {
    await ctx.api(`/visits/${encodeURIComponent(ctx.state.visit.id)}/${path}`, { method: "POST", body, ifMatch: ctx.state.etag });
    toast(ok);
  } catch (err) {
    toast(err.status === 412 ? "Someone else just changed this visit. Here it is again." : err.message || "That didn't save.", { bad: true });
  }
  ctx.refresh();
}

export { names };
