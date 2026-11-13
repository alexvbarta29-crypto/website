// The Schedule on a desk (1,100 px and up; the layout report's "drag a
// visit onto a person" and "drag from the tray onto a day"): Week as a
// board (a row per person, a column per day, each visit a chip) and Day as
// lanes (a column per person on a time grid), with the To book tray beside
// them. Drag a visit to another day, another time or another person's row
// or lane (Rotor), or a job from the tray onto a day or a time (Jobber).
//
// A drop goes through the routes the sheets use: GET /schedule/check (the
// warnings; with any, the person is asked first), then PATCH /visits/:id
// with If-Match from a fresh read (a visit someone changed meanwhile is
// never moved on old information) or POST /visits for a booking. The undo
// bar puts it back (the move or assignment as it was, only while nobody
// changed it since; a booking is cancelled, so the job goes back to To
// book). The keyboard way is the visit's side panel (Move, Assign) and the
// tray's Book button. A phone has none of this: a tap opens the visit.
//
// Also here: how full a day is (the fill bars of the month and the board).

import { html, attrs, icon, raw, confirmSheet } from "../../core/ui.js";
import { uuid } from "../../core/api.js";
import { dateShort, clock, plural, money } from "../../core/format.js";
import { addDays, dow, dowShort, dayNum, toMin, fromMin, faces, userById, names, kindLabel, visitPill } from "./office-kit.js";
import { wxMark, dayWx, wxWords } from "./office-weather.js";
import { slotOf, wide } from "./office-vpanel.js";

export const DEAD = ["cancelled", "no_access"];
export const OPEN = ["scheduled", "en_route", "in_progress", "paused"];
export const SNAP = 15;                  // minutes a drop on the lanes snaps to
export const PX_PER_MIN = 1;             // the lanes: 60 px an hour
export const NOBODY = "";                // the "Nobody yet" row's user

// ------------------------------------------------------------ small words

// "8a", "12:30p": a chip's time
export function shortTime(hhmm) {
  const n = toMin(hhmm);
  if (n === null) return "";
  const h = Math.floor(n / 60) % 24, mm = n % 60;
  return `${((h + 11) % 12) + 1}${mm ? ":" + String(mm).padStart(2, "0") : ""}${h < 12 ? "a" : "p"}`;
}
// "Alex W.": a chip's customer
export function shortName(name) {
  const w = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!w.length) return "Customer";
  return w.length > 1 ? `${w[0]} ${w[w.length - 1][0].toUpperCase()}.` : w[0];
}
// The Sunday a date's week starts on (the month grid, the week strip and Week all start on Sunday).
export const sundayOf = (d) => addDays(d, -dow(d));
// Drag and drop is for a desk with a mouse (1,100 px and up).
export const desk = () => wide();
const roomy = () => typeof matchMedia === "function" && matchMedia("(min-width: 900px)").matches;
export const colorOf = (users, ids) => { const u = userById(users, (ids || [])[0]); return (u && /^#[0-9a-f]{6}$/i.test(u.color || "") && u.color) || "#85858d"; };
// ------------------------------------------------------------ what a card shows (the gear: "Show on cards")

// Saved per person on this device (no server preference store exists).
export const CARD_DEFAULTS = Object.freeze({ name: true, service: true, price: true, address: false, hideCancelled: false });
const cardsKey = (uid) => `crm-sched-cards:${uid || "me"}`;
export function loadCards(uid) {
  try {
    const raw = JSON.parse(localStorage.getItem(cardsKey(uid)) || "null") || {};
    return Object.fromEntries(Object.entries(CARD_DEFAULTS).map(([k, d]) => [k, typeof raw[k] === "boolean" ? raw[k] : d]));
  } catch (e) { return { ...CARD_DEFAULTS }; }
}
export function saveCards(uid, cards) { try { localStorage.setItem(cardsKey(uid), JSON.stringify(cards)); } catch (e) { /* a private window: this visit only */ } }
// The words a card shows: { title (the first line), where, service, price } by the person's choices.
export function cardBits(v, cards = CARD_DEFAULTS, { prices = false } = {}) {
  const c = { ...CARD_DEFAULTS, ...(cards || {}) };
  const service = v.t || (v.svc || []).join(", ") || "";
  const name = v.cn || "Customer";
  const title = c.name ? name : c.service && service ? service : c.address && (v.ad || v.town) ? v.ad || v.town : name;
  return {
    title,
    short: c.name ? shortName(v.cn) : title,
    where: c.address ? v.ad || v.town || "" : v.town || "",
    service: c.service && (c.name || c.address) ? service : "",
    price: c.price && prices && v.amt > 0 ? money(v.amt).replace(/\.00$/, "") : "",
  };
}

const sameSet = (a = [], b = []) => a.length === b.length && a.every((x) => b.includes(x));

// ------------------------------------------------------------ how full a day is

// The visits a day can take for everyone, or for one person (their share;
// 0 when they're off). null when the server said nothing about the day.
export function capFor(capacity, d, tech = null) {
  if (!capacity || !capacity.days || !Number.isFinite(capacity.days[d])) return null;
  const all = capacity.days[d];
  if (!tech) return all;
  if (!all) return 0;
  return ((capacity.off && capacity.off[d]) || []).includes(tech) ? 0 : Math.max(1, capacity.per_person || 1);
}
// How full: { level: closed | shut (visits on a closed day) | open | some | busy | full | over, pct (of the bar), label }
export function fullness(count, cap) {
  if (cap === null || cap === undefined) return null;
  if (cap <= 0) return count ? { level: "shut", pct: 100, label: `${plural(count, "visit")} on a closed day` } : { level: "closed", pct: 0, label: "Closed" };
  const pct = Math.min(100, Math.round((count / cap) * 100));
  const level = count > cap ? "over" : count === cap ? "full" : count / cap >= 0.75 ? "busy" : count ? "some" : "open";
  return { level, pct, label: `${count} of ${cap} booked${level === "over" ? ", over" : level === "full" ? ", full" : ""}` };
}
// Visits on a day before today that nobody marked done (or cancelled, or no access).
export function notClosed(visits, d, today, tech = null) {
  if (!today || d >= today) return 0;
  return (visits || []).filter((v) => v.d === d && OPEN.includes(v.st) && (!tech || (v.a || []).includes(tech))).length;
}
// The live visits a day counts (for everyone, or for one person).
export const liveOn = (visits, d, tech = null) => (visits || []).filter((v) => v.d === d && !DEAD.includes(v.st) && (!tech || (v.a || []).includes(tech)));

export function fillBar(f, { count = null } = {}) {
  if (!f) return "";
  return html`<span class="${"wk-fill lvl-" + f.level}" ${attrs({ title: f.label })}>${count !== null ? html`<span class="wk-fcount num">${count}</span>` : ""}<span class="wk-fbar"><i ${attrs({ style: `width:${f.pct}%` })}></i></span></span>`;
}

// ------------------------------------------------------------ times (pure)

export const snap = (m, step = SNAP) => Math.round(m / step) * step;
// The open hours of a day in minutes, or null (closed).
export function hoursSpan(hours, d) {
  const span = hours && hours[String(dow(d))];
  return Array.isArray(span) && span.length === 2 && toMin(span[0]) !== null ? [toMin(span[0]), toMin(span[1])] : null;
}
// The first start (every `step` minutes inside the open hours) where `dur` fits beside what's booked.
export function firstFreeSlot(busy, span, dur, step = 30) {
  if (!span) return null;
  for (let t = span[0]; t + dur <= span[1]; t += step) if (!busy.some(([a, b]) => t < b && a < t + dur)) return t;
  return null;
}
// The lanes' grid: the open hours, stretched to every timed visit, whole hours.
export function dayBounds(items, span) {
  let a = span ? span[0] : 8 * 60, b = span ? span[1] : 18 * 60;
  for (const x of items) { const s = toMin(x.s), e = toMin(x.e); if (s !== null && e !== null) { a = Math.min(a, s); b = Math.max(b, e); } }
  return [Math.max(0, Math.floor(a / 60) * 60), Math.min(24 * 60, Math.ceil(b / 60) * 60)];
}
// Side by side where things overlap: each item gets { col, cols, grp } (grp: its overlapping group).
export function lanePack(items) {
  const sorted = [...items].sort((x, y) => x.from - y.from || x.to - y.to);
  const out = new Map();
  let group = [], ends = [], groupEnd = -Infinity;
  let grp = 0;
  const flush = () => { for (const g of group) out.set(g.key, { col: g.col, cols: ends.length, grp }); grp += 1; group = []; ends = []; groupEnd = -Infinity; };
  for (const x of sorted) {
    if (group.length && x.from >= groupEnd) flush();
    let col = ends.findIndex((e) => e <= x.from);
    if (col < 0) { col = ends.length; ends.push(x.to); } else ends[col] = x.to;
    group.push({ key: x.key, col });
    groupEnd = Math.max(groupEnd, x.to);
  }
  flush();
  return out;
}

// ------------------------------------------------------------ planning a drop (pure)

// The people after a drop from `from`'s row onto `to`'s (NOBODY: take `from` off).
export function reassign(ids = [], from = NOBODY, to = NOBODY) {
  const cur = [...new Set(ids || [])];
  if (from === to) return cur;
  if (!to) return cur.filter((x) => x !== from);
  if (cur.includes(to)) return cur.filter((x) => x !== from);
  if (from && cur.includes(from)) return cur.map((x) => (x === from ? to : x));
  return [...cur, to];
}

// A visit row (the schedule's index row) dropped on a target { day, user?, minute? }:
// → { next (the slot after), patch (only what changes), moving }
export function planMove(row, from, t) {
  const dur = Math.max(SNAP, (toMin(row.e) ?? 0) - (toMin(row.s) ?? 0));
  const next = { date: t.day || row.d, start: row.s, end: row.e, assignee_ids: t.user === undefined ? [...(row.a || [])] : reassign(row.a, from, t.user), date_only: row.do === true };
  if (Number.isFinite(t.minute)) {
    const m = Math.max(0, Math.min(24 * 60 - SNAP - dur, snap(t.minute)));
    next.start = fromMin(m);
    next.end = fromMin(Math.min(24 * 60 - 1, m + dur));
    next.date_only = false;
  }
  const patch = {};
  if (next.date !== row.d) patch.date = next.date;
  if (next.start !== row.s) patch.start = next.start;
  if (next.end !== row.e) patch.end = next.end;
  if (next.date_only !== (row.do === true)) patch.date_only = next.date_only;
  if (!sameSet(next.assignee_ids, row.a || [])) patch.assignee_ids = next.assignee_ids;
  return { next, patch, moving: ["date", "start", "end", "date_only"].some((k) => k in patch) };
}

// "Pat S. moved to Thu, Nov 19 at 10:00 AM, now with Tess."
export function moveWords(row, plan, users) {
  const bits = [];
  if ("date" in plan.patch || "start" in plan.patch) bits.push(`moved to ${dateShort(plan.next.date)}${plan.next.date_only ? "" : ` at ${clock(plan.next.start)}`}`);
  if ("assignee_ids" in plan.patch) bits.push(plan.next.assignee_ids.length ? `now with ${names(users, plan.next.assignee_ids)}` : "now with nobody");
  return `${shortName(row.cn)} ${bits.join(", ") || "saved"}.`;
}

// ------------------------------------------------------------ doing it (the API)

const askAnyway = (warnings, yes) => confirmSheet(`${warnings.map((w) => w.message).join(" ")} Go ahead anyway?`, { title: "Heads up", yes });

async function warningsFor(ctx, slot) {
  const q = new URLSearchParams({ date: slot.date, start: slot.start, end: slot.end, users: (slot.users || []).join(","), ...(slot.visit ? { visit: slot.visit } : {}), ...(slot.town ? { town: slot.town } : {}) });
  try { return ((await ctx.api(`/schedule/check?${q}`, { cache: false })).data.warnings) || []; } catch (e) { return []; }
}

// A visit dropped on a day, a time or a person.
// d = { row (index row), from (the row's user, NOBODY) }, t = { day, user?, minute? }
// → { ok, text?, undo?, warnings?, message?, reload?, cancelled?, nothing? }
export async function dropVisit(ctx, d, t, { confirm = askAnyway, users = [] } = {}) {
  const row = d.row;
  const plan = planMove(row, d.from, t);
  if (!Object.keys(plan.patch).length) return { ok: false, nothing: true };
  if (plan.moving && row.st !== "scheduled") return { ok: false, message: "Only a visit that hasn't started can move. Change who goes from its panel." };
  const w = await warningsFor(ctx, { date: plan.next.date, start: plan.next.start, end: plan.next.end, users: plan.next.assignee_ids, visit: row.id, town: row.town });
  if (w.length && !(await confirm(w, plan.moving ? "Move it" : "Assign it"))) return { ok: false, cancelled: true };
  let fresh;
  try { fresh = await ctx.api(`/visits/${encodeURIComponent(row.id)}`, { cache: false }); } catch (e) { return { ok: false, message: (e && e.message) || "That didn't load.", reload: true }; }
  const fv = fresh.data.visit;
  if (fv.date !== row.d || fv.start !== row.s || fv.end !== row.e || fv.status !== row.st || !sameSet(fv.assignee_ids || [], row.a || [])) {
    return { ok: false, message: "This visit just changed. Here's the schedule again.", reload: true };
  }
  try {
    const r = await ctx.api(`/visits/${encodeURIComponent(row.id)}`, { method: "PATCH", body: plan.patch, ifMatch: fresh.etag });
    return { ok: true, text: moveWords(row, plan, users), undo: { kind: "visit", id: row.id, before: slotOf(fv), after: slotOf(r.data.visit) }, warnings: (r.meta && r.meta.warnings) || [] };
  } catch (e) {
    return { ok: false, message: e && e.status === 412 ? "Someone else just changed this visit. Here's the schedule again." : (e && e.message) || "That didn't save.", reload: true };
  }
}

// A job from the tray dropped on a day (the person's first free slot that
// day, else the opening time) or a time on a person's lane.
// d = { job (a tray row) }, t = { day, user?, minute? }; data = the schedule's answer.
export async function dropJob(ctx, d, t, { confirm = askAnyway, data = {}, users = [] } = {}) {
  const job = d.job;
  const dur = (data.defaults && data.defaults.duration_min) || 120;
  const who = t.user ? [t.user] : [];
  let start = Number.isFinite(t.minute) ? Math.max(0, Math.min(24 * 60 - SNAP - dur, snap(t.minute))) : null;
  if (start === null) {
    const span = hoursSpan(data.hours, t.day);
    const busy = (data.visits || []).filter((v) => v.d === t.day && !DEAD.includes(v.st) && !v.do && (t.user ? (v.a || []).includes(t.user) : !(v.a || []).length))
      .map((v) => [toMin(v.s), toMin(v.e)]).filter(([a, b]) => a !== null && b !== null);
    start = firstFreeSlot(busy, span, dur) ?? (span ? span[0] : 8 * 60);
  }
  const slot = { date: t.day, start: fromMin(start), end: fromMin(Math.min(24 * 60 - 1, start + dur)) };
  const w = await warningsFor(ctx, { ...slot, users: who });
  if (w.length && !(await confirm(w, "Book it"))) return { ok: false, cancelled: true };
  try {
    const r = await ctx.api("/visits", { method: "POST", body: { job_id: job.id, ...slot, window: { type: "window", minutes: (data.defaults && data.defaults.window_min) || 120 }, assignee_ids: who, client_id: uuid() } });
    return { ok: true, text: `${shortName(job.cn)} booked ${dateShort(slot.date)} at ${clock(slot.start)}${who.length ? `, with ${names(users, who)}` : ""}.`, undo: { kind: "book", id: r.data.visit.id }, warnings: (r.meta && r.meta.warnings) || [] };
  } catch (e) {
    return { ok: false, message: (e && e.message) || "That didn't book.", reload: true };
  }
}

// Puts a change back. A move or an assignment only while the visit is as
// the change left it; a booking is cancelled (the job goes back to To book).
export async function undoChange(ctx, u) {
  if (!u) return { ok: false };
  if (u.kind === "book") {
    try {
      await ctx.api(`/visits/${encodeURIComponent(u.id)}/cancel`, { method: "POST", body: { reason: "Booked by mistake (undone on the schedule)", late: false } });
      return { ok: true, text: "Undone. The job is back in To book." };
    } catch (e) { return { ok: false, message: (e && e.message) || "That didn't undo." }; }
  }
  let fresh;
  try { fresh = await ctx.api(`/visits/${encodeURIComponent(u.id)}`, { cache: false }); } catch (e) { return { ok: false, message: (e && e.message) || "That didn't undo." }; }
  const now = slotOf(fresh.data.visit);
  if (u.after && (now.date !== u.after.date || now.start !== u.after.start || now.end !== u.after.end || now.date_only !== u.after.date_only || !sameSet(now.assignee_ids, u.after.assignee_ids))) {
    return { ok: false, message: "It changed again since. Open the visit to check." };
  }
  const patch = {};
  for (const k of ["date", "start", "end"]) if (u.before[k] !== now[k]) patch[k] = u.before[k];
  if (u.before.date_only !== now.date_only) patch.date_only = u.before.date_only;
  if (!sameSet(u.before.assignee_ids, now.assignee_ids)) patch.assignee_ids = u.before.assignee_ids;
  if (!Object.keys(patch).length) return { ok: true, text: "Undone." };
  try {
    await ctx.api(`/visits/${encodeURIComponent(u.id)}`, { method: "PATCH", body: patch, ifMatch: fresh.etag });
    return { ok: true, text: "Undone." };
  } catch (e) {
    return { ok: false, message: e && e.status === 409 ? "It can't go back: the visit has started." : e && e.status === 412 ? "It changed again since. Open the visit to check." : (e && e.message) || "That didn't undo." };
  }
}

// ------------------------------------------------------------ dragging (the browser's drag and drop)

let drag = null;     // { kind: "visit", row, from, grab } | { kind: "job", job }
export const dragging = () => drag;

// The schedule hands these its own drop handler: onDrop(ctx, drag, target).
export function dndEvents(onDrop) {
  const start = (e, d) => {
    drag = d;
    try { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", d.kind === "job" ? d.job.id : d.row.id); } catch (x) { /* an old browser */ }
    if (e.target && e.target.classList) e.target.classList.add("lifted");
  };
  const end = (e, el) => { drag = null; el.classList.remove("lifted"); for (const x of document.querySelectorAll(".wk-drop.over")) x.classList.remove("over"); };
  return {
    "dragstart [data-drag]": (e, el, ctx) => {
      const row = (ctx.state.data.visits || []).find((v) => v.id === el.dataset.drag);
      if (!row) { e.preventDefault(); return; }
      const r = el.getBoundingClientRect();
      start(e, { kind: "visit", row, from: el.dataset.from || NOBODY, grab: el.dataset.timed ? Math.max(0, (e.clientY - r.top) / PX_PER_MIN) : 0 });
    },
    "dragstart [data-dragjob]": (e, el, ctx) => {
      const job = ((ctx.state.dtray && ctx.state.dtray.jobs) || []).find((j) => j.id === el.dataset.dragjob);
      if (!job) { e.preventDefault(); return; }
      start(e, { kind: "job", job });
    },
    "dragend [data-drag]": end,
    "dragend [data-dragjob]": end,
    "dragover [data-drop]": (e, el) => {
      if (!drag) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = "move"; } catch (x) { /* fine */ }
      el.classList.add("over");
    },
    "dragleave [data-drop]": (e, el) => { if (!el.contains(e.relatedTarget)) el.classList.remove("over"); },
    "drop [data-drop]": (e, el, ctx) => {
      e.preventDefault();
      el.classList.remove("over");
      const d = drag;
      drag = null;
      if (!d) return;
      const t = { day: el.dataset.dday };
      if (el.dataset.user !== undefined) t.user = el.dataset.user || NOBODY;
      if (el.dataset.top !== undefined) {
        const r = el.getBoundingClientRect();
        t.minute = Number(el.dataset.top) + (e.clientY - r.top) / PX_PER_MIN - (d.grab || 0);
      }
      onDrop(ctx, d, t);
    },
  };
}

// ------------------------------------------------------------ what it draws

// The people with a row or a lane: the technicians, and anyone with a visit
// in view (one person when the schedule shows one).
export function lanePeople(s, visits) {
  const ppl = (s.users || []).filter((u) => u.is_technician || visits.some((v) => (v.a || []).includes(u.id)));
  return s.tech ? ppl.filter((u) => u.id === s.tech) : ppl;
}

const chipState = (st) => (DEAD.includes(st) ? " dead" : st === "completed" ? " done" : "");

function boardChip(s, v, uid, canDrag) {
  const drag = canDrag && OPEN.includes(v.st);
  const b = cardBits(v, s.cards);
  return html`<a class="${"wk-bchip" + chipState(v.st)}" href="${"#/visits/" + encodeURIComponent(v.id)}" ${attrs({ "data-vopen": v.id, draggable: drag ? "true" : "false", "data-drag": drag ? v.id : false, "data-from": drag ? uid : false, style: `--c:${colorOf(s.users, uid ? [uid] : v.a)}`, title: `${v.cn || "Customer"}${v.town ? `, ${v.town}` : ""}` })}>
    <b class="num">${v.do ? "Any" : shortTime(v.s)}</b><span class="nm">${b.short}</span>${b.where ? html`<small>${b.where}</small>` : ""}</a>`;
}

// Week on a desk: a row per person, a column per day (Sunday first, as the month).
export function weekBoard(s, ctx) {
  const start = sundayOf(s.date);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const visits = (s.data.visits || []).filter((v) => !DEAD.includes(v.st));
  const people = lanePeople(s, visits);
  const canDrag = !!(ctx && ctx.can && ctx.can("schedule:write")) && desk();
  const t = s.today;
  const cap = s.data.capacity;
  const rows = [...people.map((u) => ({ id: u.id, u })), ...(s.tech ? [] : [{ id: NOBODY, u: null }])];
  const mine = (v, uid) => (uid ? (v.a || []).includes(uid) : !(v.a || []).length);
  const tasksOn = (d, uid) => (s.data.tasks || []).filter((x) => x.date === d && uid && (x.a || []).includes(uid));
  return html`<div class="wk-board card" ${attrs({ "data-days": "7" })}>
    <div class="wk-brow wk-bhead"><span class="wk-bwho"></span>${days.map((d) => {
      const n = liveOn(s.data.visits, d, s.tech).length;
      const f = fullness(n, capFor(cap, d, s.tech));
      const w = dayWx(s.wx, d);
      return html`<button type="button" class="${"wk-bday" + (d === t ? " today" : "")}" ${attrs({ "data-goday": d, "data-gotech": s.tech || "", "aria-label": `Open ${dateShort(d)}: ${plural(n, "visit")}${f ? `, ${f.label}` : ""}${w ? `, ${wxWords(w)}` : ""}` })}>
        <span class="wk-bdn"><span>${dowShort(d)}</span><b class="num">${dayNum(d)}</b>${wxMark(w)}</span>${fillBar(f, { count: n })}</button>`;
    })}</div>
    ${rows.map(({ id, u }) => html`<div class="wk-brow">
      <span class="wk-bwho">${u ? html`<span class="wk-dot" ${attrs({ style: `background:${u.color || "#4a4a52"}` })}></span><span class="nm">${u.name}</span>` : html`<span class="nm muted">Nobody yet</span>`}</span>
      ${days.map((d) => html`<div class="${"wk-bcell wk-drop" + (d === t ? " today" : "")}" ${attrs({ "data-drop": "", "data-dday": d, "data-user": id })}>
        ${visits.filter((v) => v.d === d && mine(v, id)).sort((a, b) => (a.do ? "00:00" : a.s).localeCompare(b.do ? "00:00" : b.s)).map((v) => boardChip(s, v, id, canDrag))}
        ${tasksOn(d, id).map((x) => html`<a class="wk-bchip task" href="${"#/tasks/" + encodeURIComponent(x.id)}"><b class="num">${shortTime(x.start)}</b><span class="nm">${x.title || "Busy"}</span></a>`)}
      </div>`)}
    </div>`)}
  </div>`;
}

// ------------------------------------------------------------ Day and 3 Day (Rotor's layout)

const CHECK = raw('<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="8.5"/><path d="m8.2 12.3 2.6 2.6 5-5.2"/></svg>');
const MIN_BLOCK = 46;                   // a block is never shorter than a thumb (44 px)
const sumAmt = (list) => list.reduce((n, v) => n + (Number.isFinite(v.amt) ? v.amt : 0), 0);
const dollars = (c) => money(c).replace(/\.00$/, "");
// The current time in minutes of the day in the company's zone (the red line).
export function nowMinutes(at = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(at).map((x) => [x.type, x.value]));
  return (Number(p.hour) % 24) * 60 + Number(p.minute);
}

// A column's head: the name, visits done of all, money done of all (with
// visits:prices) and a bar: done (green), under way (blue), the rest.
export function columnStats(list) {
  const live = list.filter((v) => !DEAD.includes(v.st));
  const done = live.filter((v) => v.st === "completed");
  const going = live.filter((v) => ["en_route", "in_progress", "paused"].includes(v.st));
  return { total: live.length, done: done.length, going: going.length, amt: sumAmt(live), amtDone: sumAmt(done) };
}
function colHead(name, st, { prices, color, cls = "" }) {
  const pct = (n) => (st.total ? Math.round((n / st.total) * 100) : 0);
  return html`<div class="${"wk-chead " + cls}">
    <span class="wk-cname">${color ? html`<span class="wk-dot" ${attrs({ style: `background:${color}` })}></span>` : ""}<span class="nm">${name}</span><span class="wk-cnum num" ${attrs({ title: `${st.done} of ${plural(st.total, "visit")} done` })}>${st.done}/${st.total}</span></span>
    ${prices && st.total ? html`<span class="wk-cmoney num" ${attrs({ title: `${dollars(st.amtDone)} done of ${dollars(st.amt)}` })}>${dollars(st.amtDone)} / ${dollars(st.amt)}</span>` : ""}
    <span class="wk-cbar" aria-hidden="true"><i class="d" ${attrs({ style: `width:${pct(st.done)}%` })}></i><i class="g" ${attrs({ style: `width:${pct(st.going)}%` })}></i></span>
  </div>`;
}

// One visit on a time grid: the customer, the town, the time, the status,
// the amount; done ones faded and struck through with a check, a red $
// when its job isn't paid.
function block(s, v, { uid, top, a, pack, canDrag, prices, compact = false }) {
  const p = pack.get(v.id) || { col: 0, cols: 1 };
  const from = toMin(v.s), to = Math.max(toMin(v.e), from + MIN_BLOCK);
  const pos = `top:${(from - top) * PX_PER_MIN}px;height:${(to - from) * PX_PER_MIN - 2}px;left:calc(${(p.col * 100) / p.cols}% + 2px);width:calc(${100 / p.cols}% - 4px)`;
  const done = v.st === "completed";
  const dr = canDrag && OPEN.includes(v.st);
  const w = (s.data.warnings || {})[v.id];
  const unpaid = done && prices && v.amt > 0 && v.pd === 0;
  const bits = cardBits(v, s.cards, { prices });
  return html`<a class="${"wk-blk" + (done ? " done" : "") + (compact ? " compact" : "")}" href="${"#/visits/" + encodeURIComponent(v.id)}" ${attrs({
    "data-vopen": v.id, draggable: dr ? "true" : "false", "data-drag": dr ? v.id : false, "data-from": dr && uid !== undefined ? uid : false, "data-timed": dr ? "1" : false,
    style: `${pos};--c:${colorOf(s.users, uid ? [uid] : v.a)}`, title: `${v.cn || "Customer"}, ${clock(v.s)} to ${clock(v.e)}${v.town ? `, ${v.town}` : ""}`,
  })}>
    <span class="nm">${compact ? bits.short : bits.title}</span>
    ${bits.where && !compact ? html`<span class="tw">${bits.where}</span>` : ""}
    ${bits.service && !compact ? html`<span class="tw">${bits.service}</span>` : ""}
    <span class="tm num">${compact ? shortTime(v.s) : `${clock(v.s)} - ${clock(v.e)}`}</span>
    ${compact ? "" : html`<span class="st">${visitPill(v.st)}${v.st === "scheduled" && w && w.length ? html`<span class="pill amber" ${attrs({ title: w.map((x) => x.message).join(" ") })}>${icon("bell")}${w.length}</span>` : ""}</span>`}
    <span class="ft">${bits.price && !compact ? html`<b class="num">${bits.price}</b>` : ""}${unpaid ? html`<i class="wk-unpaid" ${attrs({ title: "Not paid yet" })}>$</i>` : ""}${done ? html`<i class="wk-done" ${attrs({ title: "Done" })}>${CHECK}</i>` : ""}</span>
  </a>`;
}

// The time grid both views share: the hours down the side, a column per
// lane, the red line at the current time on today.
function grid(s, ctx, lanes, { day, days, compact = false }) {
  const canDrag = !!(ctx && ctx.can && ctx.can("schedule:write")) && desk();
  const prices = !!(ctx && ctx.can && ctx.can("visits:prices"));
  const timedAll = lanes.flatMap((l) => l.visits.filter((v) => !v.do));
  const tasksAll = lanes.flatMap((l) => l.tasks || []);
  const span = hoursSpan(s.data.hours, day || days[0]);
  const [a, b] = dayBounds([...timedAll, ...tasksAll.map((x) => ({ s: x.start, e: x.end }))], span);
  const hours = Array.from({ length: (b - a) / 60 }, (_, i) => a + i * 60);
  const nowLine = Number.isFinite(s.nowMin) && s.nowMin >= a && s.nowMin <= b ? s.nowMin : null;
  const anyRow = lanes.some((l) => l.visits.some((v) => v.do));
  // a phone's 3 Day has room for two side by side: more than that is one block that opens the day
  const maxCols = compact && !roomy() ? 2 : Infinity;
  const body = (l) => {
    const items = [
      ...l.visits.filter((v) => !v.do).map((v) => ({ key: v.id, from: toMin(v.s), to: Math.max(toMin(v.e), toMin(v.s) + MIN_BLOCK) })),
      ...(l.tasks || []).map((x) => ({ key: x.id, from: toMin(x.start), to: Math.max(toMin(x.end), toMin(x.start) + MIN_BLOCK) })),
    ].filter((x) => x.from !== null);
    const pack = lanePack(items);
    const crowded = new Map();
    for (const it of items) { const p = pack.get(it.key); if (p && p.cols > maxCols) { const g = crowded.get(p.grp) || { from: it.from, to: it.to, n: 0, a: new Set() }; g.from = Math.min(g.from, it.from); g.to = Math.max(g.to, it.to); g.n += 1; crowded.set(p.grp, g); } }
    const roomyOk = (id) => { const p = pack.get(id); return !p || p.cols <= maxCols; };
    const timed = l.visits.filter((v) => !v.do && roomyOk(v.id));
    l = { ...l, tasks: (l.tasks || []).filter((x) => roomyOk(x.id)) };
    const today = l.date === s.today;
    return html`<div class="${"wk-lane wk-drop" + (today && nowLine !== null ? " now" : "")}" ${attrs({ "data-drop": "", "data-dday": l.date, "data-user": l.user, "data-top": String(a), style: `height:${(b - a) * PX_PER_MIN}px` })}>
      ${hours.map((h) => html`<span class="wk-lline" ${attrs({ style: `top:${(h - a) * PX_PER_MIN}px` })}></span>`)}
      ${today && nowLine !== null ? html`<span class="wk-nowline" ${attrs({ style: `top:${(nowLine - a) * PX_PER_MIN}px` })}></span>` : ""}
      ${timed.map((v) => block(s, v, { uid: l.user, top: a, pack, canDrag, prices, compact }))}
      ${[...crowded.values()].map((g) => html`<button type="button" class="wk-blk group" ${attrs({ "data-goday": l.date, "data-gotech": s.tech || "", style: `top:${(g.from - a) * PX_PER_MIN}px;height:${(g.to - g.from) * PX_PER_MIN - 2}px;left:2px;width:calc(100% - 4px)`, "aria-label": `${plural(g.n, "visit")} from ${clock(fromMin(g.from))}: open the day` })}><span class="nm">${plural(g.n, "visit")}</span><span class="tm num">${shortTime(fromMin(g.from))} to ${shortTime(fromMin(g.to))}</span></button>`)}
      ${(l.tasks || []).map((x) => {
        const p = pack.get(x.id) || { col: 0, cols: 1 };
        const from = toMin(x.start), to = Math.max(toMin(x.end), from + MIN_BLOCK);
        const sales = !!l.sales;
        return html`<a class="${"wk-blk task" + (sales ? " sale k-" + x.kind : "")}" href="${"#/tasks/" + encodeURIComponent(x.id)}" ${attrs({ style: `top:${(from - a) * PX_PER_MIN}px;height:${(to - from) * PX_PER_MIN - 2}px;left:calc(${(p.col * 100) / p.cols}% + 2px);width:calc(${100 / p.cols}% - 4px)${sales ? `;--c:${colorOf(s.users, l.user ? [l.user] : x.a)}` : ""}` })}>
          <span class="nm">${sales && x.cn && !compact ? x.cn : x.title || "Busy"}</span>${sales && !compact ? html`<span class="tw">${[TASK_WORD[x.kind], x.cn ? x.title : ""].filter(Boolean).join(" · ")}</span>` : ""}<span class="tm num">${compact ? shortTime(x.start) : `${clock(x.start)} - ${clock(x.end)}`}</span></a>`;
      })}
    </div>`;
  };
  return html`<div class="${"wk-cols card" + (compact ? " three" : "")}" ${attrs({ style: `--lanes:${lanes.length}`, "data-lanes": String(lanes.length) })}>
    <div class="wk-cgrid">
      <span class="wk-gut wk-ghead"></span>${lanes.map((l) => l.head)}
      ${anyRow || canDrag ? html`<span class="wk-gut small muted">Anytime</span>${lanes.map((l) => html`<div class="wk-lany wk-drop" ${attrs({ "data-drop": "", "data-dday": l.date, "data-user": l.user })}>${l.visits.filter((v) => v.do).map((v) => boardChip(s, v, l.user === undefined ? NOBODY : l.user, canDrag))}</div>`)}` : ""}
      <span class="wk-gut wk-ghours">${hours.map((h) => html`<span class="wk-lhour num" ${attrs({ style: `top:${(h - a) * PX_PER_MIN}px` })}>${clock(fromMin(h)).replace(":00", "")}</span>`)}${nowLine !== null && lanes.some((l) => l.date === s.today) ? html`<span class="wk-nowdot" ${attrs({ style: `top:${(nowLine - a) * PX_PER_MIN}px` })}></span>` : ""}</span>
      ${lanes.map(body)}
    </div>
  </div>`;
}

// Day (Rotor's layout, phone and desk): Unassigned, then a column per
// person, each head with done of all and the money; more than two columns
// scroll sideways on a phone. One person when the schedule shows one.
export function dayColumns(s, ctx) {
  const d = s.date;
  const visits = (s.data.visits || []).filter((v) => v.d === d && !DEAD.includes(v.st));
  const tasks = (s.data.tasks || []).filter((x) => x.date === d);
  const people = lanePeople(s, visits);
  const prices = !!(ctx && ctx.can && ctx.can("visits:prices"));
  const mine = (ids, uid) => (uid ? (ids || []).includes(uid) : !(ids || []).length);
  const lanes = [...(s.tech ? [] : [{ id: NOBODY, u: null }]), ...people.map((u) => ({ id: u.id, u }))].map(({ id, u }) => {
    const list = visits.filter((v) => mine(v.a, id));
    return {
      date: d, user: id, visits: list, tasks: id ? tasks.filter((x) => (x.a || []).includes(id)) : [],
      head: colHead(u ? u.name : "Unassigned", columnStats(list), { prices, color: u ? u.color || "#4a4a52" : null, cls: u ? "" : "nobody" }),
    };
  });
  return grid(s, ctx, lanes, { day: d });
}

const TASK_WORD = { estimate_visit: "Estimate visit", meeting: "Meeting", call: "Call", follow_up: "Follow-up", personal: "Busy" };

// Day, "Sales rep": the same columns for the sales side: each person's
// estimate visits, meetings, calls and follow-ups with a time (open tasks,
// from the Sales module), Unassigned first.
export function salesColumns(s, ctx) {
  const d = s.date;
  const tasks = (s.data.sales || []).filter((x) => x.date === d);
  const ppl = (s.users || []).filter((u) => ["owner", "admin"].includes(u.role) || tasks.some((x) => (x.a || []).includes(u.id)));
  const people = s.tech ? ppl.filter((u) => u.id === s.tech) : ppl;
  const mine = (ids, uid) => (uid ? (ids || []).includes(uid) : !(ids || []).length);
  const lanes = [...(s.tech ? [] : [{ id: NOBODY, u: null }]), ...people.map((u) => ({ id: u.id, u }))].map(({ id, u }) => {
    const list = tasks.filter((x) => mine(x.a, id) && !x.do);
    return {
      date: d, user: id, visits: [], tasks: list, sales: true,
      head: html`<div class="${"wk-chead" + (u ? "" : " nobody")}"><span class="wk-cname">${u ? html`<span class="wk-dot" ${attrs({ style: `background:${u.color || "#4a4a52"}` })}></span>` : ""}<span class="nm">${u ? u.name : "Unassigned"}</span><span class="wk-cnum num" ${attrs({ title: plural(list.length, "appointment") })}>${list.length}</span></span></div>`,
    };
  });
  const anytime = tasks.filter((x) => x.do && (!s.tech || (x.a || []).includes(s.tech)));
  return html`${grid(s, { ...ctx, can: (p) => p !== "schedule:write" && ctx.can(p) }, lanes, { day: d })}
    ${anytime.length ? html`<div class="card wk-sany"><h3>Any time today</h3><ul class="list">${anytime.map((x) => html`<li><a class="row" href="${"#/tasks/" + encodeURIComponent(x.id)}"><span class="who"><span class="nm">${x.cn || x.title || "Task"}</span><span class="sub">${[TASK_WORD[x.kind], x.cn ? x.title : ""].filter(Boolean).join(" · ")}</span></span></a></li>`)}</ul></div>` : ""}`;
}

// 3 Day: three days side by side, each visit in its first person's color.
export function threeDay(s, ctx) {
  const days = [0, 1, 2].map((i) => addDays(s.date, i));
  const prices = !!(ctx && ctx.can && ctx.can("visits:prices"));
  const mine = (ids) => !s.tech || (ids || []).includes(s.tech);
  const lanes = days.map((d) => {
    const list = (s.data.visits || []).filter((v) => v.d === d && !DEAD.includes(v.st) && mine(v.a));
    const w = dayWx(s.wx, d);
    const st = columnStats(list);
    return {
      date: d, user: undefined, visits: list, tasks: (s.data.tasks || []).filter((x) => x.date === d && mine(x.a)),
      head: html`<button type="button" class="${"wk-chead wk-dhead" + (d === s.today ? " today" : "")}" ${attrs({ "data-goday": d, "data-gotech": s.tech || "", "aria-label": `Open ${dateShort(d)}: ${st.done} of ${plural(st.total, "visit")} done${w ? `, ${wxWords(w)}` : ""}` })}>
        <span class="wk-cname"><span class="nm">${dowShort(d)} <b class="num">${dayNum(d)}</b></span>${wxMark(w)}</span>
        <span class="wk-cnum num">${st.done}/${st.total}${prices && st.total ? html` · ${dollars(st.amt)}` : ""}</span>
        <span class="wk-cbar" aria-hidden="true"><i class="d" ${attrs({ style: `width:${st.total ? Math.round((st.done / st.total) * 100) : 0}%` })}></i><i class="g" ${attrs({ style: `width:${st.total ? Math.round((st.going / st.total) * 100) : 0}%` })}></i></span>
      </button>`,
    };
  });
  return grid(s, ctx, lanes, { days, compact: true });
}

// The To book tray beside the board (jobs waiting for a visit, due by the month).
export function deskTray(s, ctx) {
  if (!(ctx && ctx.can && ctx.can("schedule:write"))) return "";
  const t = s.dtray;
  return html`<aside class="wk-dtray card" aria-labelledby="wk-dtray-h">
    <header class="wk-dtray-h"><h2 id="wk-dtray-h">To book</h2>${t ? html`<span class="pill">${t.jobs.length}</span>` : ""}</header>
    <p class="small muted">Drag a job onto a day or a person, or Book it.</p>
    ${!t ? html`<div class="wk-dtray-b"><span class="sk w70"></span><span class="sk w50"></span></div>`
      : t.jobs.length ? html`<ul class="wk-tcards">${t.jobs.map((j) => html`<li class="wk-tcard" ${attrs({ draggable: "true", "data-dragjob": j.id })}>
        <span class="who"><span class="nm">${j.cn || "Customer"}</span><span class="sub">${[j.n, j.t].filter(Boolean).join(" · ")}</span><span class="sub">${[j.k && j.k !== "standard" ? kindLabel(j.k) : null, j.tm ? `due ${j.tm}` : null, j.pl ? "plan visit" : null].filter(Boolean).join(" · ")}</span></span>
        <button type="button" class="btn small" ${attrs({ "data-book": j.id, "aria-label": `Book ${j.cn || "this job"}` })}>${icon("plus")}Book</button></li>`)}</ul>`
      : html`<p class="wk-dtray-none">${icon("check")}Nothing waiting.</p>`}
    ${t && t.later ? html`<p class="small muted">${plural(t.later, "more job")} due later.</p>` : ""}
  </aside>`;
}

export { faces };
