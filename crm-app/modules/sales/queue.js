// Power Dialer → Queue (guide-gaps §2.8 D7, D11, Rotor's Queue): the queue
// picked on top. The built-in Follow-up calls queue is today's call list
// (calls.js: Due now · Later today · Paused · Needs attention, unchanged).
// A named queue lists its people as two-line rows with a drag handle (drag,
// or the arrow keys, to reorder: saved with the version read, If-Match);
// a long press: Call them next, Move to the top, Remove. "...": Rename,
// Clear the queue, Delete it.

import { html, toast, attrs, sheet, actionSheet, dragHandle, dragList, pillTap, confirmSheet, emptyCard, statusPill } from "../../core/ui.js";
import { screenButtons } from "../../core/nav.js";
import { pickFrom, pickContact } from "../../core/pickers.js";
import Calls from "./calls.js";
import { ensureStyles, telHref } from "./kit.js";
import { loadQueue, newQueue, pickedQueue, pickQueue } from "./dialer.js";

const FOLLOWUPS = "followups";
const e164 = (p) => { const d = String(p || "").replace(/[^\d+]/g, ""); return d ? (d.length === 10 ? "+1" + d : d) : ""; };
let stopDrag = null;

const qRow = (r, i, cur) => html`<li class="rs-lrow dl-qrow" ${attrs({ "data-drag-key": r.id, "data-hold": "", "data-q-more": r.id })}>
  <a class="rs-lr-main" ${attrs({ href: "#/contacts/" + encodeURIComponent(r.id) })}><span class="rs-lr-a"><span class="rs-lr-1"><span class="rs-lr-t">${r.n || "No name"}</span></span><span class="rs-lr-2"><span class="rs-lr-s">${[r.src, r.c].filter(Boolean).join(" · ")}</span>${statusPill(i === cur ? "Up next" : r.lc === "lead" ? "Lead" : "Customer", i === cur ? "solid" : r.lc === "lead" ? "blue" : "green")}</span></span></a>
  <span class="rs-acts">${dragHandle(r.id, `Move ${r.n || "this person"}`)}</span></li>`;

export default {
  title: "Queue",
  async load(params, ctx) {
    ensureStyles();
    const queues = (await ctx.api("/dialer/queues")).data || [];
    const qid = queues.some((q) => q.id === pickedQueue()) ? pickedQueue() : FOLLOWUPS;
    if (qid === FOLLOWUPS) return { ...(await Calls.load(params, ctx)), queues, qid };
    return { queues, qid, ...(await loadQueue(ctx, qid)) };
  },
  render(s, ctx) {
    const name = (s.queues.find((x) => x.id === s.qid) || { name: "Queue" }).name;
    const picker = html`<div class="dl-top">${pillTap(`${name} ⌄`, { icon: "list", data: { "q-pick": true }, aria: `Queue: ${name}. Change` })}</div>`;
    if (s.qid === FOLLOWUPS) return html`<div class="stack">${picker}${Calls.render(s, ctx)}</div>`;
    const byId = new Map(s.rows.map((r) => [r.id, r]));
    const order = (s.queue.ids || []).filter((id) => byId.has(id)).map((id) => byId.get(id));
    return html`<div class="stack dl-page">${picker}
      <p class="small muted">${order.length === 1 ? "1 person" : `${order.length} people`} · drag to reorder · hold for more</p>
      ${order.length ? html`<ul class="rs-card flush rs-list dl-queue" aria-label="${name}">${order.map((r, i) => qRow(r, i, s.queue.cursor || 0))}</ul>` : emptyCard({ icon: "phone", title: "Nobody in this queue", text: "Add people one by one, or make a queue from your leads.", action: { label: "Add someone", data: { "q-add": true } } })}
    </div>`;
  },
  mount(view, s, ctx) {
    if (s.qid === FOLLOWUPS) { if (Calls.mount) Calls.mount(view, s, ctx); }
    else {
      if (stopDrag) stopDrag();
      stopDrag = dragList(view.querySelector(".dl-queue"), (keys) => save(ctx, { ids: keys }, "Order saved"));
    }
    screenButtons([{ key: "more", icon: "more", label: "More" }], () => actionSheet("Queue", [[
      { label: "New queue", icon: "plus", run: () => newQueue(ctx) },
      s.qid !== FOLLOWUPS && { label: "Add someone", icon: "userplus", run: () => addSomeone(ctx) },
      s.qid !== FOLLOWUPS && { label: "Rename", icon: "edit", run: () => rename(ctx) },
    ], [
      s.qid !== FOLLOWUPS && { label: "Clear the queue", icon: "close", danger: true, run: () => clearIt(ctx) },
      s.qid !== FOLLOWUPS && { label: "Delete the queue", icon: "trash", danger: true, run: () => deleteIt(ctx) },
    ]]));
  },
  unmount() { if (stopDrag) { stopDrag(); stopDrag = null; } if (Calls.unmount) Calls.unmount(); },
  events: {
    ...Calls.events,
    "click [data-q-pick]": async (e, el, ctx) => {
      const v = await pickFrom({ title: "Queue", items: [...ctx.state.queues.map((q) => ({ value: q.id, label: q.name, sub: q.id === ctx.state.qid ? "now" : q.builtin ? "today's follow-up calls" : `${q.n || 0} people` })), { value: "__new", label: "New queue" }] });
      if (v === "__new") { newQueue(ctx); return; }
      if (v) { pickQueue(v); ctx.refresh(); }
    },
    "click [data-q-add]": (e, el, ctx) => addSomeone(ctx),
    "rs-hold [data-q-more]": (e, el, ctx) => rowMore(ctx, el.dataset.qMore),
  },
};

async function save(ctx, patch, ok) {
  const s = ctx.state;
  try {
    const r = await ctx.api(`/dialer/queues/${encodeURIComponent(s.queue.id)}`, { method: "PATCH", body: patch, ifMatch: s.etag });
    s.queue = r.data.queue;
    s.etag = r.etag || s.etag;
    if (ok) toast(ok);
    ctx.rerender();
  } catch (err) {
    toast(err.status === 412 ? "The queue changed. Showing the latest." : err.message || "That didn't save.", { bad: true });
    ctx.refresh();
  }
}
function rowMore(ctx, id) {
  const s = ctx.state;
  const r = s.rows.find((x) => x.id === id);
  if (!r || !s.queue || s.queue.builtin) return;
  const ids = s.queue.ids.filter((x) => x !== id);
  const tel = e164(r.p);
  actionSheet(r.n || "Contact", [[
    { label: "Call them next", icon: "call", run: () => save(ctx, { cursor: s.queue.ids.indexOf(id) }, "Up next") },
    { label: "Move to the top", icon: "swap", run: () => save(ctx, { ids: [id, ...ids], cursor: 0 }, "Moved to the top") },
    tel && { label: "Call now", icon: "call", href: telHref(tel) },
  ], [{ label: "Remove from the queue", icon: "close", danger: true, run: () => save(ctx, { ids }, "Removed") }]]);
}
async function addSomeone(ctx) {
  const who = await pickContact(ctx.api, { title: "Add to this queue" });
  if (!who) return;
  if (ctx.state.queue.ids.includes(who.id)) { toast("They're in it already."); return; }
  save(ctx, { ids: [...ctx.state.queue.ids, who.id] }, `${who.name} added`);
}
function rename(ctx) {
  const sh = sheet({
    title: "Rename the queue",
    body: html`<form class="form" id="dl-name-f" novalidate><label class="field"><span>Name</span><input name="name" maxlength="60" required ${attrs({ value: ctx.state.queue.name })}></label><button type="submit" class="btn primary block">Save</button></form>`,
    events: { "submit #dl-name-f": (e, form) => { e.preventDefault(); const v = form.elements.name.value.trim(); if (!v) return; sh.close(); save(ctx, { name: v.slice(0, 60) }, "Renamed"); } },
  });
}
async function clearIt(ctx) {
  if (!(await confirmSheet("Take everyone out of this queue? The people stay in the CRM.", { title: "Clear the queue", yes: "Clear", danger: true }))) return;
  try { await ctx.api(`/dialer/queues/${encodeURIComponent(ctx.state.queue.id)}/clear`, { method: "POST", body: {} }); toast("Cleared"); ctx.refresh(); }
  catch (err) { toast(err.message || "That didn't clear.", { bad: true }); }
}
async function deleteIt(ctx) {
  if (!(await confirmSheet("Delete this queue? The people stay in the CRM.", { title: "Delete the queue", yes: "Delete", danger: true }))) return;
  try { await ctx.api(`/dialer/queues/${encodeURIComponent(ctx.state.queue.id)}`, { method: "DELETE" }); pickQueue(null); toast("Deleted"); ctx.refresh(); }
  catch (err) { toast(err.message || "That didn't delete.", { bad: true }); }
}
