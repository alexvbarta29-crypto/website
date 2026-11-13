// The visit's side panel on the Schedule (a desk, 1,100 px and up): a
// click on a visit in Month, Week, Day or List opens it beside the
// schedule instead of leaving it (the layout report: "tapping a visit
// should open a side panel, as ServiceTitan's job pop-up does, not a new
// page"). It shows the customer, when, where, the work, who, the status,
// the amount (with visits:prices), the notes, and Open visit, Move,
// Assign, Navigate and Call. Esc or ✕ closes it. Its address is
// #/schedule?...&visit=<id> (the office shell's address follows), so the
// link can be shared; on a phone that link opens the Visit screen.
//
// One read: GET /visits/:id (the same answer the Visit screen gets: what
// the server lets this person see, `can` saying which buttons apply).
// Move is the book / move sheet; Assign changes only the people; both say
// the schedule's warnings while you pick, and the change can be undone.

import { html, icon, attrs, sheet, render, toast } from "../../core/ui.js";
import { dateLong, money, phone } from "../../core/format.js";
import { directionsLink } from "../../core/map.js";
import { busy } from "../../core/forms.js";
import { slotText, visitPill, faces, kindLabel, loadUsers, team, scheduleSheet } from "./office-kit.js";

export const PANEL_MEDIA = "(min-width: 1100px)";
export const wide = () => typeof matchMedia === "function" && matchMedia(PANEL_MEDIA).matches;
export const isVisitId = (x) => typeof x === "string" && /^vs_[0-9a-hjkmnp-tv-z]{20}$/.test(x);
const OPEN = ["scheduled", "en_route", "in_progress", "paused"];

// The address of the schedule with the panel open (and without it).
export function panelPath(s, id) {
  const q = new URLSearchParams();
  if (s.view && s.view !== "month") q.set("view", s.view);
  if (s.date) q.set("date", s.date);
  if (id) q.set("visit", id);
  const t = q.toString();
  return "/schedule" + (t ? "?" + t : "");
}
// Puts the address in the frame (no new history entry, no reload) and tells the office shell.
export function setAddress(path) {
  try { history.replaceState(history.state, "", "#" + path); } catch (e) { /* not in a browser */ }
  try { if (window.parent && window.parent !== window) window.parent.postMessage({ type: "crm:route", path }, location.origin); } catch (e) { /* no shell */ }
}

// Opens (or switches) the panel on a visit and reads it.
// hooks: { paint() (redraws when the screen is still there), url: true,
// quiet (read it again behind what it shows: after a change) }
export async function openPanel(ctx, id, hooks = {}) {
  const s = ctx.state;
  const quiet = !!(hooks.quiet && s.panel && s.panel.id === id && s.panel.data);
  if (!quiet) {
    s.panel = { id, loading: true, data: null, etag: null, error: null, focus: true };
    if (hooks.url !== false) setAddress(panelPath(s, id));
    if (hooks.paint) hooks.paint();
  }
  let next;
  try {
    const r = await ctx.api(`/visits/${encodeURIComponent(id)}`, { cache: false });
    next = { id, loading: false, data: r.data, etag: r.etag, error: null, focus: !quiet };
  } catch (e) {
    next = { id, loading: false, data: null, etag: null, error: e && e.status === 404 ? "That visit isn't there any more." : (e && e.message) || "That didn't load.", focus: !quiet };
  }
  if (!s.panel || s.panel.id !== id) return;          // another visit was opened meanwhile, or it was closed
  s.panel = next;
  if (hooks.paint) hooks.paint();
}

export function closePanel(ctx, hooks = {}) {
  const s = ctx.state;
  if (!s.panel) return;
  s.back = s.panel.id;                                // focus goes back to the visit that opened it
  s.panel = null;
  if (hooks.url !== false) setAddress(panelPath(s, null));
  if (hooks.paint) hooks.paint();
}

// ------------------------------------------------------------ what it shows

function accessBits(prop) {
  const a = (prop && prop.access) || {};
  return [
    a.gate_code ? ["Gate code", a.gate_code] : null, a.lockbox ? ["Lockbox", a.lockbox] : null, a.pets ? ["Pets", a.pets] : null,
    a.parking ? ["Parking", a.parking] : null, a.notes ? ["Access", a.notes] : null,
  ].filter(Boolean);
}

export function panelView(s, ctx) {
  const p = s.panel;
  if (!p) return "";
  const head = (title, pill) => html`<header class="wk-side-h">
    <h2 id="wk-side-title" tabindex="-1">${title}</h2>${pill || ""}
    <button type="button" class="icon-btn wk-side-x" data-pclose aria-label="Close the panel">✕</button>
  </header>`;
  if (p.loading) {
    return html`<aside class="wk-side card" aria-labelledby="wk-side-title" aria-busy="true">${head("Visit")}<div class="wk-side-b"><span class="sk w70"></span><span class="sk w50"></span><span class="sk w90"></span></div></aside>`;
  }
  if (p.error || !p.data) {
    return html`<aside class="wk-side card" aria-labelledby="wk-side-title">${head("Visit")}<div class="wk-side-b"><p class="muted">${p.error || "That didn't load."}</p>
      <div class="wk-side-acts"><a class="btn" href="${"#/visits/" + encodeURIComponent(p.id)}">${icon("doc")}Open visit</a></div></div></aside>`;
  }
  const d = p.data;
  const v = d.visit || {};
  const j = d.job || null;
  const c = d.contact || null;
  const prop = d.property || null;
  const can = d.can || {};
  const addr = prop && prop.address;
  const where = addr ? [addr.street1, addr.city].filter(Boolean).join(", ") : v.address_line || v.town || "";
  const ph = c && ((c.phones || []).find((x) => x.primary) || (c.phones || [])[0]);
  const tel = ph ? "tel:" + String(ph.e164 || "").replace(/[^+\d]/g, "") : "";
  const what = (j && j.title) || v.job_title || (v.service_types || []).join(", ") || "";
  const total = can.prices && j && j.totals && Number.isFinite(j.totals.total_cents) && j.billable !== false && j.totals.total_cents > 0 ? money(j.totals.total_cents) : "";
  const bits = accessBits(prop);
  const crew = j && j.crew_notes;
  const officeNotes = can.office && j && j.office_notes;
  const users = s.users || [];
  const people = (d.people || []).map((x) => x.name).filter(Boolean);
  const assignable = !!can.office && OPEN.includes(v.status);
  return html`<aside class="wk-side card" aria-labelledby="wk-side-title">
    ${head((c && c.display_name) || v.contact_name || "Visit", visitPill(v.status))}
    <div class="wk-side-b">
      <dl class="kv wk-side-kv">
        <dt>When</dt><dd><span class="wk-side-big">${dateLong(v.date)}</span><span class="sub">${slotText(v)}</span></dd>
        ${where ? html`<dt>Where</dt><dd>${where}</dd>` : ""}
        ${what ? html`<dt>Work</dt><dd>${what}${j && j.kind && j.kind !== "standard" ? html`<span class="sub">${kindLabel(j.kind)}</span>` : ""}${j && j.number_label ? html`<span class="sub">Job ${j.number_label}</span>` : ""}</dd>` : ""}
        <dt>Who</dt><dd class="wk-who">${(v.assignee_ids || []).length ? html`${faces(users, v.assignee_ids)}<span>${people.join(", ") || "Someone"}</span>` : html`<span class="wk-nobody">Nobody yet</span>`}</dd>
        ${total ? html`<dt>Amount</dt><dd class="num">${total}</dd>` : ""}
      </dl>
      ${bits.length || crew ? html`<div class="wk-side-sec"><h3>For the crew</h3>${bits.length ? html`<dl class="kv wk-side-kv">${bits.map(([k, x]) => html`<dt>${k}</dt><dd>${x}</dd>`)}</dl>` : ""}${crew ? html`<p class="wk-pre">${crew}</p>` : ""}</div>` : ""}
      ${v.tech_notes ? html`<div class="wk-side-sec"><h3>Notes from the visit</h3><p class="wk-pre">${v.tech_notes}</p></div>` : ""}
      ${officeNotes ? html`<div class="wk-side-sec"><h3>Office notes</h3><p class="wk-pre">${officeNotes}</p></div>` : ""}
      <div class="wk-side-acts">
        <a class="btn primary" href="${"#/visits/" + encodeURIComponent(v.id || p.id)}">${icon("doc")}Open visit</a>
        ${can.move ? html`<button type="button" class="btn" data-pmove>${icon("schedule")}Move</button>` : ""}
        ${assignable ? html`<button type="button" class="btn" data-passign>${icon("team")}Assign</button>` : ""}
        ${addr || where ? html`<a class="btn" ${directionsLink(addr || where)}>${icon("map")}Navigate</a>` : ""}
        ${tel ? html`<a class="btn" ${attrs({ href: tel, "aria-label": `Call ${phone(ph.e164)}` })}>${icon("phone")}Call</a>` : ""}
      </div>
    </div>
  </aside>`;
}

// ------------------------------------------------------------ Move and Assign

// The fields a move or an assignment can change, as the visit has them now.
export const slotOf = (v) => ({ date: v.date, start: v.start, end: v.end, assignee_ids: [...(v.assignee_ids || [])], date_only: v.date_only === true });

// Move: the book / move sheet (date, time, window, people, with the warnings while you pick).
// onDone({ before, after }) once it saved.
export function moveFromPanel(ctx, onDone) {
  const p = ctx.state.panel;
  if (!p || !p.data) return;
  const v = p.data.visit;
  const before = slotOf(v);
  scheduleSheet(ctx, { visit: v, etag: p.etag, town: v.town, onDone: (data) => onDone && onDone({ before, after: data && data.visit ? slotOf(data.visit) : null }) });
}

// Assign: only the people, with the schedule's warnings for them at the visit's time.
export async function assignSheet(ctx, onDone) {
  const p = ctx.state.panel;
  if (!p || !p.data) return null;
  const v = p.data.visit;
  const users = team(await loadUsers(ctx).catch(() => []));
  const before = slotOf(v);
  let people = [...(v.assignee_ids || [])];
  let seq = 0;
  const body = html`<form class="form" id="wk-assign" novalidate>
    <div class="err" data-form-err hidden></div>
    <p class="small muted">${dateLong(v.date)} · ${slotText(v)}</p>
    <div class="field"><span>Who goes</span><div class="wk-people">${users.map((u) => html`<button type="button" class="chip wk-person" ${attrs({ "data-aperson": u.id, "aria-pressed": String(people.includes(u.id)) })}><span class="wk-dot" ${attrs({ style: `background:${u.color || "#4a4a52"}` })}></span>${u.name}</button>`)}</div></div>
    <div data-warn aria-live="polite"></div>
    <button type="submit" class="btn primary block">Save who goes</button>
  </form>`;
  const sh = sheet({
    title: "Assign",
    body,
    events: {
      "click [data-aperson]": (e, b) => {
        const id = b.dataset.aperson;
        people = people.includes(id) ? people.filter((x) => x !== id) : [...people, id];
        b.setAttribute("aria-pressed", String(people.includes(id)));
        check();
      },
      "submit #wk-assign": async (e, form) => {
        e.preventDefault();
        const err = form.querySelector("[data-form-err]");
        err.hidden = true;
        const btn = form.querySelector("[type=submit]");
        busy(btn, true, "Saving…");
        try {
          const r = await ctx.api(`/visits/${encodeURIComponent(v.id)}`, { method: "PATCH", body: { assignee_ids: people }, ifMatch: p.etag });
          sh.close();
          const warns = (r.meta && r.meta.warnings) || [];
          if (warns.length) toast(`Saved. Heads up: ${warns[0].message}`, { ms: 5000 });
          if (onDone) onDone({ before, after: slotOf(r.data.visit) });
        } catch (x) {
          busy(btn, false);
          err.textContent = x.status === 412 ? "Someone else just changed this visit. Close this and look again." : x.message || "That didn't save.";
          err.hidden = false;
        }
      },
    },
  });
  async function check() {
    const my = ++seq;
    const q = new URLSearchParams({ date: v.date, start: v.start, end: v.end, users: people.join(","), visit: v.id });
    let w = [];
    try { w = ((await ctx.api(`/schedule/check?${q}`, { cache: false })).data.warnings) || []; } catch (e) { w = []; }
    if (my !== seq) return;
    const box = sh.el.querySelector("[data-warn]");
    if (box) render(box, w.length ? html`<div class="warn-box">${w.map((x) => x.message).join(" ")}</div>` : html``);
  }
  check();
  return sh;
}
