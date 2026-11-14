// Customize Tabs (Rotor's, Nov 2026; replaces the Tab bar page's body):
// each person picks up to five places for their phone's tab bar from the
// main screens (Home, Schedule, Inbox, Customers, Sales, Leads, Pipeline,
// Leaderboard, Map, Quotes, Plans, Invoices: only those they may open and
// whose screen is there). One list: the tabs on the bar above a line, the
// rest under MORE MENU; a round − takes a tab off the bar, a round + puts
// one on (up to five); drag a row by its handle (or hold the row) to
// reorder, or move it with the arrow keys on the handle. The Menu always
// comes last on the bar. Saved on their own user record (PATCH /users/:id
// { tabs }, If-Match), so it follows them to every phone; "Back to the
// standard bar" clears it.
//
// It opens as a sheet page with a red Done (from the person's initials, a
// long press on the bar, Settings → Appearance → Tab bar, the drawer's gear
// for someone without Settings), and #/tab-bar draws the same list as a
// page with Save.

import { html, icon, toast, attrs, rnd, sheetPage } from "../../core/ui.js";
import { TABS, setTabs, STANDARD as BAR } from "../../core/nav.js";
import { match } from "../../core/router.js";
import { api } from "../../core/api.js";

export const CHOICES = Object.freeze(["home", "schedule", "inbox", "contacts", "sales", "leads", "pipeline", "leaderboard", "map", "quotes", "plans", "invoices"]);
// the standard bar (Home · Schedule · Inbox · Map), the Menu after it
export const STANDARD = Object.freeze(BAR.filter((k) => k !== "menu"));
export const MAX = 5;
const LABEL = { leaderboard: "Leaderboard" };
const labelOf = (k) => LABEL[k] || TABS[k].label;
// a place whose screen is there and that this person may open
const usable = (k, can) => {
  const t = TABS[k];
  const paths = t.paths || t.group.map(([p]) => p);
  return paths.some((p) => { const m = match(p); return !!m && (!m.route.perm || can(m.route.perm)); });
};

// What the person has now. → { id, etag, picked, rest }
async function current(can) {
  const me = await api("/me", { cache: false });
  const u = me.data.user;
  // (a pinned Visits is the Schedule now)
  const mine = Array.isArray(u.tabs) && u.tabs.length ? [...new Set(u.tabs.map((k) => (k === "visits" ? "schedule" : k)))] : [...STANDARD];
  const choices = CHOICES.filter((k) => usable(k, can));
  const picked = mine.filter((k) => choices.includes(k)).slice(0, MAX);
  return { id: u.id, etag: me.data.etag, picked, rest: choices.filter((k) => !picked.includes(k)) };
}

// The order after a move: the list is picked, then the line, then the rest; a 6th tab above the line drops below it.
export function settle(order) {
  const i = order.indexOf("|");
  let picked = order.slice(0, i);
  let rest = order.slice(i + 1);
  if (picked.length > MAX) { rest = [...picked.slice(MAX), ...rest]; picked = picked.slice(0, MAX); }
  return { picked, rest };
}
// Moves one place by one step (the arrow keys), across the line too.
export function step(s, key, dir) {
  const order = [...s.picked, "|", ...s.rest];
  const i = order.indexOf(key);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= order.length) return s;
  [order[i], order[j]] = [order[j], order[i]];
  // (onto a full bar from below: it takes the last place, the one it passed goes below the line)
  return settle(order);
}
export function toggle(s, key) {
  if (s.picked.includes(key)) return { picked: s.picked.filter((k) => k !== key), rest: [key, ...s.rest] };
  if (s.picked.length >= MAX) return null;
  return { picked: [...s.picked, key], rest: s.rest.filter((k) => k !== key) };
}

const row = (k, on, n) => html`<li class="ctb-row" ${attrs({ "data-k": k })}>
  <span class="ctb-ic">${icon(TABS[k].icon)}</span><span class="ctb-l">${labelOf(k)}</span>
  ${on ? rnd("minus", `Take ${labelOf(k)} off the bar`, { tone: "grey", sm: true, data: { "ctb-out": k } }) : rnd("plus", `Put ${labelOf(k)} on the bar`, { tone: "grey", sm: true, data: { "ctb-in": k }, disabled: n >= MAX })}
  <button type="button" class="ctb-drag" ${attrs({ "data-ctb-drag": k, "aria-label": `Move ${labelOf(k)}. Use the up and down arrows.` })}>${icon("drag")}</button></li>`;

// The list (html): the tabs on the bar, the MORE MENU line, the rest.
export function tabsList(s) {
  const n = s.picked.length;
  return html`<p class="rs-sub ctb-hint">Drag to reorder. Tabs above the line show on the bar, up to 5. Menu always comes last.</p>
    <ul class="rs-card flush ctb-list" data-ctb aria-label="Your tabs">
      ${s.picked.map((k) => row(k, true, n))}
      <li class="ctb-div" role="separator" data-ctb-line><span>More menu</span></li>
      ${s.rest.map((k) => row(k, false, n))}
    </ul>
    <p class="small muted ctb-n" aria-live="polite">${n >= MAX ? "That's five. Take one off to put another on." : `${n} of ${MAX} on the bar.`}</p>`;
}

// Dragging a row: by its handle at once, or by holding the row (Rotor's
// long press). Rows move in the DOM while the finger moves; on release the
// new order is read back and drawn again. → a function that stops listening
export function dragRows(root, onDrop) {
  let drag = null;
  let hold = null;
  const begin = (li, e) => {
    const list = li.parentElement;
    drag = { li, list, id: e.pointerId, y0: e.clientY };
    li.classList.add("dragging");
    try { li.setPointerCapture(e.pointerId); } catch (x) { /* fine */ }
  };
  const down = (e) => {
    const li = e.target.closest(".ctb-row");
    if (!li || !root.contains(li) || e.button > 0) return;
    if (e.target.closest("[data-ctb-drag]")) { e.preventDefault(); begin(li, e); return; }
    if (e.target.closest("button")) return;
    const x0 = e.clientX, y0 = e.clientY;
    clearTimeout(hold && hold.t);
    hold = { x0, y0, t: setTimeout(() => { hold = null; begin(li, e); }, 450) };
  };
  const move = (e) => {
    if (hold && Math.hypot(e.clientX - hold.x0, e.clientY - hold.y0) > 8) { clearTimeout(hold.t); hold = null; }
    if (!drag || e.pointerId !== drag.id) return;
    e.preventDefault();
    const items = [...drag.list.children].filter((x) => x !== drag.li);
    let before = null;
    for (const x of items) { const r = x.getBoundingClientRect(); if (e.clientY < r.top + r.height / 2) { before = x; break; } }
    if (before !== drag.li.nextElementSibling) drag.list.insertBefore(drag.li, before);
  };
  const up = (e) => {
    if (hold) { clearTimeout(hold.t); hold = null; }
    if (!drag || (e && e.pointerId !== drag.id)) return;
    const { li, list } = drag;
    drag = null;
    li.classList.remove("dragging");
    const order = [...list.children].map((x) => (x.hasAttribute("data-ctb-line") ? "|" : x.dataset.k)).filter(Boolean);
    onDrop(settle(order));
  };
  root.addEventListener("pointerdown", down);
  root.addEventListener("pointermove", move, { passive: false });
  root.addEventListener("pointerup", up);
  root.addEventListener("pointercancel", up);
  return () => { root.removeEventListener("pointerdown", down); root.removeEventListener("pointermove", move); root.removeEventListener("pointerup", up); root.removeEventListener("pointercancel", up); };
}

// Saves (null: back to the standard bar). → the record's new version
async function save(s, tabs) {
  await api(`/users/${encodeURIComponent(s.id)}`, { method: "PATCH", body: { tabs }, ifMatch: s.etag });
  s.etag = (await api("/me", { cache: false })).data.etag;
  setTabs([...(tabs && tabs.length ? tabs : STANDARD), "menu"]);
}
const saveError = (err) => (err.status === 412 ? "Your account changed on another phone. Try again." : err.message || "That didn't save.");

// The keys and buttons both the sheet and the page answer. → true when handled
function onTap(s, e, redraw) {
  const out = e.target.closest("[data-ctb-out]");
  const inn = e.target.closest("[data-ctb-in]");
  if (out || inn) {
    const next = toggle(s, (out || inn).dataset[out ? "ctbOut" : "ctbIn"]);
    if (next) { Object.assign(s, next); redraw(); }
    return true;
  }
  return false;
}
function onKey(s, e, redraw, root) {
  const h = e.target.closest && e.target.closest("[data-ctb-drag]");
  if (!h || !["ArrowUp", "ArrowDown"].includes(e.key)) return;
  e.preventDefault();
  const k = h.dataset.ctbDrag;
  Object.assign(s, step(s, k, e.key === "ArrowUp" ? -1 : 1));
  redraw();
  const again = root().querySelector(`[data-ctb-drag="${k}"]`);
  if (again) again.focus();
}

// The sheet: Customize Tabs, a red Done.
export async function openCustomize({ can = () => true } = {}) {
  let s;
  try { s = await current(can); } catch (err) { toast(err.message || "That didn't open.", { bad: true }); return null; }
  let stop = () => {};
  const page = sheetPage({
    title: "Customize Tabs",
    body: () => html`${tabsList(s)}<button type="button" class="rs-card rs-disc ctb-std" data-standard><span class="rs-dl"><span>Back to the standard bar</span><span class="rs-ds">Home, Schedule, Inbox, Map</span></span></button>`,
    done: {
      label: "Done",
      run: async () => {
        if (!s.picked.length) { toast("Keep at least one tab on the bar.", { bad: true }); return false; }
        try { await save(s, s.picked); toast("Your tabs are saved."); return true; } catch (err) { toast(saveError(err), { bad: true }); return false; }
      },
    },
    events: {
      "click [data-ctb-out], [data-ctb-in]": (e) => onTap(s, e, redraw),
      "click [data-standard]": async () => {
        try { await save(s, null); toast("The standard bar is back."); page.close(); } catch (err) { toast(saveError(err), { bad: true }); }
      },
      "keydown [data-ctb-drag]": (e) => onKey(s, e, redraw, () => page.body),
    },
    onClose: () => stop(),
  });
  page.el.classList.add("ctb-sheet");
  page.el.querySelector("[data-sheet-done]").setAttribute("data-save", "");
  function redraw() { page.show(null); }
  stop = dragRows(page.body, (next) => { Object.assign(s, next); redraw(); });
  return page;
}

// #/tab-bar: the same list as a page, with Save.
export default {
  title: "Tab bar",
  async load(params, ctx) {
    const s = await current(ctx.can);
    return { ...s, saving: false };
  },
  render(s) {
    return html`<div class="rs-page ctb-page">
      ${tabsList(s)}
      <div class="btn-row"><button type="button" class="btn primary" data-save ${attrs({ disabled: !s.picked.length || s.saving ? true : null })}>Save my bar</button><button type="button" class="btn" data-standard>Back to the standard bar</button></div>
    </div>`;
  },
  mount(view, s, ctx) {
    if (this._stop) this._stop();
    const list = view.querySelector("[data-ctb]");
    this._stop = list ? dragRows(list, (next) => { Object.assign(ctx.state, next); ctx.rerender(); }) : null;
  },
  unmount() { if (this._stop) { this._stop(); this._stop = null; } },
  events: {
    "click [data-ctb-out], [data-ctb-in]": (e, el, ctx) => onTap(ctx.state, e, () => ctx.rerender()),
    "keydown [data-ctb-drag]": (e, el, ctx) => onKey(ctx.state, e, () => ctx.rerender(), () => document.getElementById("view")),
    "click [data-save]": (e, el, ctx) => pageSave(ctx, ctx.state.picked),
    "click [data-standard]": (e, el, ctx) => pageSave(ctx, null),
  },
};

async function pageSave(ctx, tabs) {
  const s = ctx.state;
  s.saving = true;
  try {
    await save(s, tabs);
    if (!tabs) { const all = [...s.picked, ...s.rest]; s.picked = STANDARD.filter((k) => all.includes(k)); s.rest = CHOICES.filter((k) => all.includes(k) && !s.picked.includes(k)); }
    toast("Your tab bar is saved.");
  } catch (err) {
    toast(saveError(err), { bad: true });
    if (err.status === 412) ctx.refresh();
  }
  s.saving = false;
  ctx.rerender();
}
