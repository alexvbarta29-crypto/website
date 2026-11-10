// Pieces the scheduling screens share (M4a): the module's stylesheet, how
// statuses and arrival windows read, the team's chips, local dates, and
// the one sheet that books or moves a visit (date, time, arrival window,
// people) with the schedule's warnings while you pick. No data here, only
// how things read (design §2.3).

import { html, icon, attrs, sheet, toast, render } from "../../core/ui.js";
import { dateShort, localDate, clock, initials } from "../../core/format.js";
import { busy, readMoney } from "../../core/forms.js";
import { uuid } from "../../core/api.js";

let styled = false;
export function ensureStyles() {
  if (styled || typeof document === "undefined") return;
  styled = true;
  const l = document.createElement("link");
  l.rel = "stylesheet";
  l.href = "/crm-app/modules/work/office-styles.css";
  document.head.appendChild(l);
}

// The office's view of the schedule (schedule:read unscoped). A technician
// holds it as "own": their day lives in the tech app.
export function officeView() {
  try { return !!(window.__crm && window.__crm.session && window.__crm.session.perms && window.__crm.session.perms["schedule:read"] === true); } catch (e) { return false; }
}

// ------------------------------------------------------------ dates

export const today = () => localDate(new Date());
export function addDays(date, n) {
  const t = Date.parse(date + "T12:00:00Z") + n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}
export const dow = (date) => new Date(date + "T12:00:00Z").getUTCDay();
// Monday of the date's week.
export const weekStart = (date) => addDays(date, -((dow(date) + 6) % 7));
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const dowShort = (date) => DOW[dow(date)];
export const dayNum = (date) => Number(date.slice(8, 10));
export function dayLabel(date) {
  const t = today();
  if (date === t) return `Today · ${dateShort(date)}`;
  if (date === addDays(t, 1)) return `Tomorrow · ${dateShort(date)}`;
  if (date === addDays(t, -1)) return `Yesterday · ${dateShort(date)}`;
  return dateShort(date);
}
export const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

// ------------------------------------------------------------ times and windows

export const toMin = (hhmm) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || "")); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
export const fromMin = (n) => `${String(Math.floor(Math.max(0, Math.min(1439, n)) / 60)).padStart(2, "0")}:${String(Math.max(0, Math.min(1439, n)) % 60).padStart(2, "0")}`;

// "8:00–10:00 AM" style, for the office: the slot, and the arrival window when there is one.
export function slotText(v) {
  if (!v) return "";
  if (v.date_only || v.do) return "Time not set";
  const s = v.start || v.s, e = v.end || v.e;
  const w = v.window || (v.w ? { type: v.w.t, minutes: v.w.m } : {});
  if (w.type === "anytime") return `Anytime (${short(s)}–${short(e)})`;
  if (w.type === "exact") return `At ${clock(s)}`;
  const end = fromMin((toMin(s) || 0) + (Number(w.minutes) || 0));
  return `Arrive ${range(s, end)}`;
}
const short = (hhmm) => clock(hhmm).replace(":00", "");
export function range(a, b) {
  const x = clock(a), y = clock(b);
  if (!x || !y) return x || y;
  const [tx, px] = x.split(" "), [ty, py] = y.split(" ");
  return px === py ? `${tx}–${ty} ${py}` : `${x}–${y}`;
}
export const WINDOWS = [
  { value: "window:120", label: "2-hour arrival window" }, { value: "window:60", label: "1-hour arrival window" },
  { value: "exact:0", label: "At an exact time" }, { value: "anytime:0", label: "Anytime that day" },
];
export const windowValue = (w) => (w && w.type === "window" ? `window:${w.minutes || 120}` : w && w.type ? `${w.type}:0` : "window:120");
export function windowFrom(value) {
  const [type, m] = String(value || "window:120").split(":");
  return type === "window" ? { type, minutes: Number(m) || 120 } : { type, minutes: 0 };
}

// ------------------------------------------------------------ words

export const VISIT_STATUS = { scheduled: "Booked", en_route: "On the way", in_progress: "Working", paused: "Paused", completed: "Done", no_access: "No access", cancelled: "Cancelled" };
const VISIT_CLASS = { scheduled: "blue", en_route: "amber", in_progress: "amber", paused: "amber", completed: "green", no_access: "red", cancelled: "" };
export const visitPill = (st) => html`<span class="${"pill " + (VISIT_CLASS[st] || "")}">${VISIT_STATUS[st] || st}</span>`;
export const JOB_STATUS = { unscheduled: "To book", scheduled: "Booked", in_progress: "Under way", completed: "Done", cancelled: "Cancelled" };
const JOB_CLASS = { unscheduled: "amber", scheduled: "blue", in_progress: "amber", completed: "green", cancelled: "" };
export const jobPill = (st) => html`<span class="${"pill " + (JOB_CLASS[st] || "")}">${JOB_STATUS[st] || st}</span>`;
export const JOB_KINDS = [
  { value: "standard", label: "Regular job" }, { value: "touch_up", label: "Touch-up (no charge)" }, { value: "warranty", label: "Warranty visit (no charge)" },
  { value: "lights_install", label: "Christmas lights install" }, { value: "lights_takedown", label: "Lights takedown (no charge)" }, { value: "lights_warranty", label: "Lights warranty (no charge)" },
];
export const kindLabel = (k) => (JOB_KINDS.find((x) => x.value === k) || { label: k }).label;
export const SERVICE_TYPES = ["Residential Window Cleaning", "Exterior Cleaning", "Christmas Lights"];
export const STALE = { scheduled_past: "Booked, but the date went by", in_progress_stuck: "Under way for days" };
export const emptyCard = (title, text, ico = "schedule") => html`<div class="card empty"><div class="art">${icon(ico)}</div><h2>${title}</h2><p>${text}</p></div>`;

// ------------------------------------------------------------ people

let usersP = null;
export function loadUsers(ctx) {
  if (!usersP) usersP = ctx.api("/users").then((r) => (r.data || []).filter((u) => u.status === undefined || u.status === "active")).catch((e) => { usersP = null; throw e; });
  return usersP;
}
export const userById = (users, id) => (users || []).find((u) => u.id === id) || null;
const firstName = (u) => (u && (u.first_name || String(u.name || "").split(/\s+/)[0])) || "Someone";
// Small round initials in the person's color.
export function faces(users, ids = []) {
  if (!ids || !ids.length) return html`<span class="wk-nobody">Nobody yet</span>`;
  return html`<span class="wk-faces">${ids.map((id) => { const u = userById(users, id); return html`<span class="wk-face" ${attrs({ style: `background:${(u && u.color) || "#4a4a52"}`, title: u ? u.name : "Someone" })}>${initials(u ? u.name : "?")}</span>`; })}</span>`;
}
export const names = (users, ids = []) => ids.map((id) => firstName(userById(users, id))).join(", ") || "Nobody";
// Technicians first, then everyone else.
export const team = (users) => [...(users || [])].sort((a, b) => Number(!!b.is_technician) - Number(!!a.is_technician) || String(a.name).localeCompare(String(b.name)));

// ------------------------------------------------------------ the book / move sheet

// Books a visit on a job (job_id), or moves one (visit + etag).
// opts: { job_id?, visit?, etag?, town?, title?, date?, onDone(result) }
export async function scheduleSheet(ctx, opts = {}) {
  ensureStyles();
  const users = team(await loadUsers(ctx).catch(() => []));
  const v = opts.visit || {};
  const st = {
    date: v.date || opts.date || addDays(today(), 1), start: v.start || "08:00", end: v.end || "10:00",
    window: windowValue(v.window), people: [...(v.assignee_ids || [])], endTouched: !!opts.visit,
  };
  const clientId = uuid();
  let timer = null;
  let seq = 0;
  const body = () => html`<form class="form" id="wk-slot" novalidate>
    <div class="err" data-form-err hidden></div>
    <div class="wk-when">
      <label class="field" data-field="date"><span>Day</span><input type="date" name="date" ${attrs({ value: st.date })} required></label>
      <div class="grid2">
        <label class="field" data-field="start"><span>Start</span><input type="time" name="start" step="900" ${attrs({ value: st.start })} required></label>
        <label class="field" data-field="end"><span>End</span><input type="time" name="end" step="900" ${attrs({ value: st.end })} required></label>
      </div>
    </div>
    <label class="field" data-field="window"><span>What the customer is told</span><select name="window">${WINDOWS.map((w) => html`<option ${attrs({ value: w.value, selected: w.value === st.window })}>${w.label}</option>`)}</select></label>
    <div class="field" data-field="assignee_ids"><span>Who goes</span>
      <div class="wk-people">${users.map((u) => html`<button type="button" class="chip wk-person" ${attrs({ "data-person": u.id, "aria-pressed": String(st.people.includes(u.id)) })}><span class="wk-dot" ${attrs({ style: `background:${u.color || "#4a4a52"}` })}></span>${u.name}</button>`)}</div>
      <small class="why" hidden></small>
    </div>
    <div data-warn aria-live="polite"></div>
    <button type="submit" class="btn primary block">${opts.visit ? "Save the change" : "Book it"}</button>
  </form>`;
  const s = sheet({
    title: opts.title || (opts.visit ? "Move or reassign" : "Book a visit"),
    body: body(),
    events: {
      "click [data-person]": (e, b) => {
        const id = b.dataset.person;
        st.people = st.people.includes(id) ? st.people.filter((x) => x !== id) : [...st.people, id];
        b.setAttribute("aria-pressed", String(st.people.includes(id)));
        check();
      },
      "change [name=start]": (e, el) => {
        const old = toMin(st.start), dur = Math.max(30, (toMin(st.end) || 0) - (old || 0));
        st.start = el.value;
        if (!st.endTouched || toMin(st.end) <= toMin(st.start)) { st.end = fromMin((toMin(st.start) || 480) + (dur || 120)); s.el.querySelector("[name=end]").value = st.end; }
        check();
      },
      "change [name=end]": (e, el) => { st.end = el.value; st.endTouched = true; check(); },
      "change [name=date]": (e, el) => { st.date = el.value; check(); },
      "change [name=window]": (e, el) => { st.window = el.value; },
      "submit #wk-slot": async (e, form) => {
        e.preventDefault();
        const errBox = form.querySelector("[data-form-err]");
        errBox.hidden = true;
        const btn = form.querySelector("[type=submit]");
        const payload = { date: st.date, start: st.start, end: st.end, window: windowFrom(st.window), assignee_ids: st.people };
        if (!isDate(payload.date) || !payload.start || !payload.end) { errBox.textContent = "Pick a day, a start and an end."; errBox.hidden = false; return; }
        busy(btn, true, "Saving…");
        try {
          const r = opts.visit
            ? await ctx.api(`/visits/${encodeURIComponent(opts.visit.id)}`, { method: "PATCH", body: payload, ifMatch: opts.etag })
            : await ctx.api("/visits", { method: "POST", body: { ...payload, job_id: opts.job_id, client_id: clientId } });
          s.close();
          const warns = (r.meta && r.meta.warnings) || [];
          toast(warns.length ? `Saved. Heads up: ${warns[0].message}` : opts.visit ? "Saved" : "Booked", { ms: warns.length ? 5000 : 2600 });
          if (opts.onDone) opts.onDone(r.data);
        } catch (err) {
          busy(btn, false);
          errBox.textContent = err.status === 412 ? "Someone else just changed this visit. Close this and look again." : err.message || "That didn't save.";
          errBox.hidden = false;
        }
      },
    },
  });
  function check() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const my = ++seq;
      const q = new URLSearchParams({ date: st.date, start: st.start, end: st.end, users: st.people.join(","), ...(opts.visit ? { visit: opts.visit.id } : {}), ...(opts.town ? { town: opts.town } : {}) });
      let r = null;
      try { r = (await ctx.api(`/schedule/check?${q}`, { cache: false })).data; } catch (e) { r = null; }
      if (my !== seq) return;
      const box = s.el.querySelector("[data-warn]");
      if (!box) return;
      const w = (r && r.warnings) || [], h = (r && r.hints) || [];
      render(box, html`${w.length ? html`<div class="warn-box">${w.map((x) => x.message).join(" ")}</div>` : ""}${h.length ? html`<div class="note">${h.map((x) => x.message).join(" ")}</div>` : ""}`);
    }, 250);
  }
  check();
  return s;
}

// Asks why (and, for a customer's own cancel, whether it was under 24 hours). → { reason, late } | null
export function reasonSheet({ title, label = "Why?", late = false, yes = "Cancel it" } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const s = sheet({
      title,
      body: html`<form class="form" id="wk-why" novalidate>
        <label class="field" data-field="reason"><span>${label}</span><textarea name="reason" rows="3" maxlength="300" required></textarea></label>
        ${late ? html`<label class="check"><input type="checkbox" name="late"><span>The customer cancelled less than 24 hours before (an owner decides on the late-cancel fee)</span></label>` : ""}
        <button type="submit" class="btn danger block">${yes}</button>
      </form>`,
      onClose: () => { if (!done) resolve(null); },
      events: {
        "submit #wk-why": (e, form) => {
          e.preventDefault();
          const reason = form.querySelector("[name=reason]").value.trim();
          if (!reason) { form.querySelector("[name=reason]").focus(); return; }
          done = true;
          const lateBox = form.querySelector("[name=late]");
          s.close();
          resolve({ reason, late: !!(lateBox && lateBox.checked) });
        },
      },
    });
  });
}

// ------------------------------------------------------------ the lines of a job

// The lines editor (New job, Edit job): a title, a price and a quantity per
// line, and the kind of service (what picks the crew's checklist). Lines
// are read back with readLines(form) → [{ id?, title, unit_cents, qty_milli, service_type? }].
const dollars = (cents) => (Number.isFinite(cents) ? (cents / 100).toFixed(2) : "");
export function lineRow(l = {}, i = 0) {
  return html`<li class="wk-line" ${attrs({ "data-line": String(i), "data-id": l.id || "" })}>
    <label class="field"><span>What</span><input name="l_title" maxlength="160" ${attrs({ value: l.title || "", placeholder: "Exterior window cleaning" })}></label>
    <div class="wk-line-nums">
      <label class="field"><span>Price</span><input name="l_price" inputmode="decimal" ${attrs({ value: dollars(l.unit_cents), placeholder: "0.00" })}></label>
      <label class="field"><span>Qty</span><input name="l_qty" inputmode="decimal" ${attrs({ value: l.qty_milli ? String(l.qty_milli / 1000) : "1" })}></label>
      <button type="button" class="icon-btn wk-x" data-unline aria-label="Remove this line">${icon("plus")}</button>
    </div>
    <label class="field"><span>Service</span><select name="l_type">${[["", "Other"], ...SERVICE_TYPES.map((t) => [t, t])].map(([v, label]) => html`<option ${attrs({ value: v, selected: (l.service_type || "") === v })}>${label}</option>`)}</select></label>
  </li>`;
}
export const linesEditor = (lines = []) => html`<div class="field" data-field="lines"><span>The work</span>
  <ul class="wk-lines-ed" data-lines>${(lines.length ? lines : [{}]).map((l, i) => lineRow(l, i))}</ul>
  <small class="why" hidden></small>
  <button type="button" class="btn" data-addline>${icon("plus")}Add a line</button></div>`;
// Add / remove line handlers for a screen's or a sheet's events.
export function addLine(root) {
  const ul = root.querySelector("[data-lines]");
  const tmp = document.createElement("ul");
  render(tmp, lineRow({}, ul.children.length));
  ul.appendChild(tmp.firstElementChild);
  const t = ul.lastElementChild.querySelector("[name=l_title]");
  if (t) t.focus();
}
export function removeLine(btn) {
  const li = btn.closest("[data-line]");
  const ul = li && li.parentElement;
  if (!li || !ul) return;
  if (ul.children.length > 1) li.remove();
  else li.querySelectorAll("input").forEach((x) => { x.value = x.name === "l_qty" ? "1" : ""; });
}
// → { lines } or { error: { field, message } }
export function readLines(form) {
  const out = [];
  const rows = [...form.querySelectorAll("[data-line]")];
  for (const [i, li] of rows.entries()) {
    const title = li.querySelector("[name=l_title]").value.trim();
    const priceText = li.querySelector("[name=l_price]").value.trim();
    const qtyText = li.querySelector("[name=l_qty]").value.trim() || "1";
    const type = li.querySelector("[name=l_type]").value;
    if (!title && !priceText) continue;
    if (!title) return { error: { field: "lines", message: `Line ${i + 1} needs a name.` } };
    const cents = readMoney(priceText || "0");
    if (cents === null || cents < 0) return { error: { field: "lines", message: `Line ${i + 1}: use a price like 295 or 295.50.` } };
    const qty = Number(qtyText);
    if (!Number.isFinite(qty) || qty < 0 || qty > 10000) return { error: { field: "lines", message: `Line ${i + 1}: use a quantity like 1 or 2.5.` } };
    out.push({ ...(li.dataset.id ? { id: li.dataset.id } : {}), title, unit_cents: cents, qty_milli: Math.round(qty * 1000), ...(type ? { service_type: type } : {}) });
  }
  return { lines: out };
}

export { icon };
