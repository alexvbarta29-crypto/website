// The single Visit screen (design §9.2 "Visit"; M4a owns it). The office
// part: who, where, when, what the customer was told, the job's work, the
// crew notes and access, the checklist, the texts that went (or would have
// gone, in dry-run), and the office's buttons: Move or reassign, Mark done,
// No access, Cancel, Reopen. Everything else arrives through the
// manifests' visitActions (contract in work/manifest.js): M4b's field
// panel for an assignee, Money's "Collect payment". A technician reaches
// only their own visits in the window the server allows; the server strips
// what they may not see.

import { html, icon, attrs, toast, confirmSheet, delegate } from "../../core/ui.js";
import { dateLong, money, dateTime, ago, phone } from "../../core/format.js";
import { directionsLink } from "../../core/map.js";
import { MANIFESTS } from "../index.js";
import { ensureStyles, slotText, visitPill, kindLabel, faces, names, scheduleSheet, reasonSheet, loadUsers, officeView } from "./office-kit.js";

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
  return { ...data, etag: r.etag, users, panels, buttons };
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

function lines(job, prices) {
  const list = (job && job.lines) || [];
  if (!list.length) return "";
  return html`<div class="card"><h2>The work</h2><ul class="wk-lines">${list.map((l) => html`<li><span>${l.title}${l.qty_milli && l.qty_milli !== 1000 ? html` <span class="muted">× ${l.qty_milli / 1000}</span>` : ""}</span>${prices && l.total_cents != null ? html`<b class="num">${money(l.total_cents)}</b>` : ""}</li>`)}
    ${prices && job.totals ? html`<li class="tot"><span>Total</span><b class="num">${money(job.totals.total_cents)}</b></li>` : ""}</ul></div>`;
}

// An item is done when the crew ticked it (done_at, as the server's finish
// gate reads it, design §5.5) or gave its photo, count or note.
export const itemDone = (i) => !!(i && (i.done_at || i.done === true || (i.value !== undefined && i.value !== null && i.value !== "")));

function checklist(v) {
  const items = (v.checklist && v.checklist.items) || [];
  if (!items.length) return "";
  const done = items.filter(itemDone).length;
  return html`<div class="card"><h2>Checklist <span class="muted small">${done} of ${items.length}</span></h2><ul class="wk-check">${items.map((i) => {
    const ok = itemDone(i);
    return html`<li class="${ok ? "on" : ""}"><span class="box" aria-hidden="true">${ok ? icon("check") : ""}</span><span>${i.label}${i.required ? html` <span class="muted small">(required)</span>` : ""}</span></li>`;
  })}</ul></div>`;
}

function access(prop, job) {
  const a = (prop && prop.access) || {};
  const bits = [
    a.gate_code ? ["Gate code", a.gate_code] : null, a.lockbox ? ["Lockbox", a.lockbox] : null, a.pets ? ["Pets", a.pets] : null,
    a.parking ? ["Parking", a.parking] : null, a.notes ? ["Access", a.notes] : null,
  ].filter(Boolean);
  const crew = job && job.crew_notes;
  if (!bits.length && !crew) return "";
  return html`<div class="card wk-notes"><h2>For the crew</h2>
    ${bits.length ? html`<dl class="kv">${bits.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>` : ""}
    ${crew ? html`<p class="wk-pre">${crew}</p>` : ""}</div>`;
}

function officeButtons(s) {
  const c = s.can || {};
  const b = [
    c.move ? html`<button type="button" class="btn primary" data-move>${icon("schedule")}Move or reassign</button>` : "",
    c.done ? html`<button type="button" class="btn" data-done>${icon("check")}Mark done</button>` : "",
    c.no_access ? html`<button type="button" class="btn" data-noaccess>No access</button>` : "",
    c.reopen ? html`<button type="button" class="btn" data-reopen>Reopen</button>` : "",
    c.cancel ? html`<button type="button" class="btn danger" data-cancel>Cancel visit</button>` : "",
  ].filter(Boolean);
  return b.length ? html`<div class="btn-row wk-acts">${b}</div>` : "";
}

export default {
  title: (s) => (s && s.contact ? s.contact.display_name || "Visit" : "Visit"),
  load,
  render(s, ctx) {
    const v = s.visit;
    const j = s.job;
    const prop = s.property;
    const addr = prop && prop.address;
    const where = addr ? [addr.street1, addr.city].filter(Boolean).join(", ") : v.address_line || v.town || "";
    const office = !!(s.can && s.can.office);
    const ph = s.contact && (s.contact.phones || []).find((p) => p.primary) || (s.contact && (s.contact.phones || [])[0]);
    const people = (s.people || []);
    // cards a panel shows itself (the field panel: its own checklist, work and notes)
    const shown = new Set(s.panels.filter((p) => !p.failed).flatMap((p) => p.replaces || []));
    return html`<div class="stack wk">
      <div class="card wk-head">
        <div class="wk-head-top"><div class="wk-when-big"><b>${dateLong(v.date)}</b><span>${slotText(v)}</span></div>${visitPill(v.status)}</div>
        ${s.arrival && (v.date_only || (v.window && v.window.type === "anytime")) ? html`<p class="small muted">Customer was told: ${s.arrival}</p>` : ""}
        <dl class="kv">
          <dt>Who</dt><dd class="wk-who">${office ? faces(s.users, v.assignee_ids) : ""}<span>${people.length ? people.map((p) => p.name).join(", ") : "Nobody yet"}</span></dd>
          ${j && j.kind && j.kind !== "standard" ? html`<dt>Kind</dt><dd>${kindLabel(j.kind)}</dd>` : ""}
        </dl>
        ${v.status === "cancelled" && v.cancel_reason ? html`<p class="warn-box">Cancelled: ${v.cancel_reason}${v.late_cancel ? " (late cancel)" : ""}</p>` : ""}
        ${v.status === "no_access" ? html`<p class="warn-box">No access${v.no_access && v.no_access.note ? `: ${v.no_access.note}` : ""}</p>` : ""}
        ${v.completion && v.completion.at && v.status === "completed" ? html`<p class="small muted">Done ${ago(v.completion.at)}${v.completion.office ? " (marked by the office)" : ""}</p>` : ""}
        ${v.moved_by_op ? html`<p class="small muted">Moved by a rain-day move.</p>` : ""}
      </div>
      <ul class="list wk-linkrows">
        ${s.contact ? html`<li><a class="row" ${attrs({ href: "#/contacts/" + encodeURIComponent(s.contact.id) })}>${icon("contacts")}<span class="who"><span class="nm">${s.contact.display_name}</span><span class="sub">Customer</span></span><span class="chev" aria-hidden="true"></span></a></li>` : ""}
        ${ph ? html`<li><a class="row" ${attrs({ href: "tel:" + String(ph.e164 || "").replace(/[^+\d]/g, "") })}>${icon("phone")}<span class="who"><span class="nm">${phone(ph.e164)}</span><span class="sub">Call</span></span></a></li>` : ""}
        ${where ? (addr ? html`<li><a class="row" ${directionsLink(addr)}>${icon("map")}<span class="who"><span class="nm">${where}</span><span class="sub">Directions</span></span></a></li>` : html`<li><div class="row">${icon("map")}<span class="who"><span class="nm">${where}</span></span></div></li>`) : ""}
        ${j && office ? html`<li><a class="row" ${attrs({ href: "#/jobs/" + encodeURIComponent(j.id) })}>${icon("doc")}<span class="who"><span class="nm">${j.title}</span><span class="sub">Job ${j.number_label || v.job_number || ""}</span></span><span class="chev" aria-hidden="true"></span></a></li>` : ""}
        ${j && !office ? html`<li><div class="row">${icon("doc")}<span class="who"><span class="nm">${j.title}</span><span class="sub">The job</span></span></div></li>` : ""}
      </ul>
      ${office ? officeButtons(s) : ""}
      ${s.buttons.length ? html`<div class="btn-row wk-acts">${s.buttons.map((a) => html`<button type="button" class="btn" ${attrs({ "data-vact": a.key })}>${a.icon ? icon(a.icon) : ""}${a.label}</button>`)}</div>` : ""}
      ${access(prop, j)}
      ${s.panels.map((p) => html`<section class="wk-panel" ${attrs({ "data-panel": p.key, "aria-label": p.label || p.key })}>${p.failed ? html`<div class="card empty"><h2>${p.label || "This part"} didn't load</h2><p>${p.failed}</p></div>` : p.mod.render(p.state || {}, p.ctx)}</section>`)}
      ${shown.has("lines") ? "" : lines(j, !!(s.can && s.can.prices))}
      ${shown.has("checklist") ? "" : checklist(v)}
      ${v.tech_notes && !shown.has("notes") ? html`<div class="card"><h2>Notes from the visit</h2><p class="wk-pre">${v.tech_notes}</p></div>` : ""}
      ${office && j && j.office_notes ? html`<div class="card"><h2>Office notes</h2><p class="wk-pre">${j.office_notes}</p></div>` : ""}
      ${s.reminders ? html`<div class="section-h">Texts and emails</div><ul class="list wk-rems">
        ${remindRow("Confirmation", s.reminders.confirm)}${remindRow("Reminder, 2 weeks before", s.reminders.d14)}${remindRow("Reminder, 2 days before", s.reminders.d2)}</ul>` : ""}
      ${office && v.updated_at ? html`<p class="foot-note">Changed ${ago(v.updated_at)}</p>` : ""}
    </div>`;
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
    "click [data-move]": (e, el, ctx) => {
      const s = ctx.state;
      scheduleSheet(ctx, { visit: s.visit, etag: s.etag, town: s.visit.town, onDone: () => ctx.refresh() });
    },
    "click [data-done]": async (e, el, ctx) => {
      if (!(await confirmSheet("Mark this visit done? The tech's timer and checklist stay as they are.", { title: "Mark done", yes: "Mark done" }))) return;
      act(ctx, "done", {}, "Marked done");
    },
    "click [data-noaccess]": async (e, el, ctx) => {
      const r = await reasonSheet({ title: "No access", label: "What happened?", yes: "Mark no access" });
      if (r) act(ctx, "mark-no-access", { note: r.reason }, "Marked no access. An owner decides on the fee.");
    },
    "click [data-cancel]": async (e, el, ctx) => {
      const r = await reasonSheet({ title: "Cancel this visit", late: true });
      if (r) act(ctx, "cancel", { reason: r.reason, late: r.late }, "Cancelled");
    },
    "click [data-reopen]": async (e, el, ctx) => {
      if (!(await confirmSheet("Reopen this visit so the crew can finish it?", { title: "Reopen", yes: "Reopen" }))) return;
      act(ctx, "reopen", {}, "Reopened");
    },
    "click [data-vact]": async (e, el, ctx) => {
      const a = ctx.state.buttons.find((x) => x.key === el.dataset.vact);
      if (!a) return;
      try { const mod = (await a.load()).default; await mod.run(ctx.state, ctx); } catch (err) { toast((err && err.message) || "That didn't work.", { bad: true }); }
    },
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
