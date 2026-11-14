// Power Dialer → Dialer (guide-gaps §2.8 D2-D5, Rotor's Dialer): one person at
// a time from the queue picked on top ("Follow-up calls ⌄": today's follow-up
// calls, or one of this person's named queues). The current contact's card:
// the name, Lead or Customer, the source and town, the number; round
// Previous and Skip in its head; "Calling from: this phone" (the business
// line comes with Twilio Voice, S10); the call script under it, each part a
// fold. The sticky red "Call" dials from this phone (tel:), and when the
// phone comes back the "How did it go?" sheet opens; once it's logged the
// next person comes up. "Log how it went" does the same without dialing.

import { html, icon, attrs, toast, rnd, pillTap, pillBtn, stickyCta, statusPill, actionSheet, emptyCard } from "../../core/ui.js";
import { screenButtons } from "../../core/nav.js";
import { pickFrom } from "../../core/pickers.js";
import { phone as fmtPhone } from "../../core/format.js";
import { ensureStyles, telHref, outcomeSheet, startCall, watchCalls, unwatchCalls } from "./kit.js";

const e164 = (p) => { const d = String(p || "").replace(/[^\d+]/g, ""); return d ? (d.length === 10 ? "+1" + d : d) : ""; };
const FOLLOWUPS = "followups";
// The queue picked, shared by the Dialer and Queue tabs (kept on this phone; the built-in one when none).
let picked = null;
export function pickedQueue() { if (picked) return picked; try { picked = localStorage.getItem("crm-dialq") || null; } catch (e) { picked = null; } return picked; }
export function pickQueue(id) { picked = id || null; try { if (id) localStorage.setItem("crm-dialq", id); else localStorage.removeItem("crm-dialq"); } catch (e) { /* this visit only */ } }

export async function loadQueue(ctx, id) {
  const r = await ctx.api(`/dialer/queues/${encodeURIComponent(id)}`, { cache: false });
  return { queue: r.data.queue, rows: r.data.rows || [], etag: r.etag || null };
}

// The person up now (pure): the queue's cursor, or the kept one for the built-in queue.
export function current(q, rows, keptCursor = 0) {
  if (!rows.length) return { row: null, i: 0, n: 0 };
  const byId = new Map(rows.map((r) => [r.id, r]));
  const order = (q.ids || []).filter((id) => byId.has(id));
  const i = Math.min(Math.max(q.builtin ? keptCursor : q.cursor || 0, 0), order.length - 1);
  return { row: byId.get(order[i]) || null, i, n: order.length };
}

export const scriptCard = (script) => (script ? html`<section class="rs-card dl-script" aria-label="Call script"><header class="rs-ch"><h2 class="rs-ct">${script.name}</h2></header>
  ${(script.sections || []).map((x, k) => html`<details class="dl-part" ${attrs({ open: k === 0 })}><summary>${x.title}</summary><p>${x.body}</p></details>`)}</section>` : "");

export default {
  title: "Power Dialer",
  async load(params, ctx) {
    ensureStyles();
    const [queues, scripts] = await Promise.all([
      ctx.api("/dialer/queues").then((r) => r.data || []),
      ctx.api("/dialer/scripts").then((r) => r.data || []).catch(() => []),
    ]);
    const qid = queues.some((q) => q.id === pickedQueue()) ? pickedQueue() : FOLLOWUPS;
    const got = await loadQueue(ctx, qid);
    return { queues, qid, ...got, scripts, script: scripts.find((x) => x.id === ctx.keep.script) || scripts[0] || null, fcur: ctx.keep.fcur || 0 };
  },
  render(s) {
    const q = s.queue;
    const cur = current(q, s.rows, s.fcur);
    const r = cur.row;
    const name = (s.queues.find((x) => x.id === s.qid) || { name: "Queue" }).name;
    const head = html`<div class="dl-top">${pillTap(`${name} ⌄`, { icon: "list", data: { "dl-pick": true }, aria: `Queue: ${name}. Change` })}<span class="dl-from">${icon("call")}Calling from: this phone</span></div>`;
    if (!r) return html`<div class="stack dl-page">${head}${emptyCard({ icon: "phone", title: "Nobody to call", text: q.builtin ? "No follow-up calls are due. Pick another queue or make one." : "This queue is empty. Configure it from the Queue tab.", action: { label: "New queue", data: { "dl-new": true } } })}</div>`;
    const tel = e164(r.p);
    return html`<div class="stack dl-page">${head}
      <section class="rs-card dl-card" aria-label="Calling now">
        <header class="dl-ch"><span class="dl-pos num">${cur.i + 1} of ${cur.n}</span><span class="dl-nav">${rnd("chevleft", "Previous", { tone: "grey", data: { "dl-step": "prev" }, disabled: cur.i === 0 })}${rnd("chevright", "Skip", { tone: "grey", data: { "dl-step": "skip" }, disabled: cur.n < 2 })}</span></header>
        <a class="dl-name" ${attrs({ href: "#/contacts/" + encodeURIComponent(r.id) })}><b>${r.n || "No name"}</b>${statusPill(r.lc === "lead" ? "Lead" : "Customer", r.lc === "lead" ? "blue" : "green")}</a>
        <p class="rs-sub">${[r.src, r.c].filter(Boolean).join(" · ") || "No source"}</p>
        <p class="dl-phone num">${tel ? fmtPhone(tel) : "No phone on file"}</p>
        <div class="dl-acts">${pillBtn("Log how it went", { icon: "check", data: { "dl-log": true } })}${tel ? pillBtn("Text", { icon: "chat", href: "sms:" + tel }) : ""}</div>
      </section>
      ${scriptCard(s.script)}
      ${tel ? stickyCta(`Call ${String(r.n || "").split(" ")[0] || "now"}`, { href: telHref(tel), icon: "call", data: { "dl-call": r.id } }) : ""}
    </div>`;
  },
  mount(view, s, ctx) {
    watchCalls(ctx, { done: () => step(ctx, "next") });
    screenButtons([{ key: "more", icon: "more", label: "More" }], () => actionSheet("Power Dialer", [[
      { label: "New queue", icon: "plus", run: () => newQueue(ctx) },
      { label: "Configure the queue", icon: "list", href: "#/calls/queue" },
      s.scripts.length > 1 && { label: "Pick a script", icon: "doc", run: () => pickScript(ctx) },
      ctx.can("settings:messaging") && { label: "Call scripts", icon: "gear", href: "#/settings/call-scripts" },
    ]]));
  },
  unmount() { unwatchCalls(); },
  events: {
    "click [data-dl-pick]": async (e, el, ctx) => {
      const v = await pickFrom({ title: "Queue", items: [...ctx.state.queues.map((q) => ({ value: q.id, label: q.name, sub: q.id === ctx.state.qid ? "now" : q.builtin ? "today's follow-up calls" : `${q.n || 0} people` })), { value: "__new", label: "New queue" }] });
      if (v === "__new") { newQueue(ctx); return; }
      if (v) { pickQueue(v); ctx.refresh(); }
    },
    "click [data-dl-new]": (e, el, ctx) => newQueue(ctx),
    "click [data-dl-step]": (e, el, ctx) => step(ctx, el.dataset.dlStep),
    "click [data-dl-log]": (e, el, ctx) => logIt(ctx),
    "click [data-dl-call]": (e, el, ctx) => {
      const r = current(ctx.state.queue, ctx.state.rows, ctx.state.fcur).row;
      if (r) startCall(ctx, { contact_id: r.id, name: r.n, phone: e164(r.p) });
    },
  },
};

function logIt(ctx) {
  const r = current(ctx.state.queue, ctx.state.rows, ctx.state.fcur).row;
  if (r) outcomeSheet(ctx, { contact_id: r.id, name: r.n, phone: e164(r.p) }, { done: () => step(ctx, "next") });
}

async function step(ctx, dir) {
  const s = ctx.state;
  const n = current(s.queue, s.rows, s.fcur).n;
  if (s.queue.builtin) {
    const i = s.fcur || 0;
    s.fcur = ctx.keep.fcur = dir === "prev" ? Math.max(0, i - 1) : Math.min(n - 1, i + 1);
    if (dir !== "prev" && i >= n - 1) toast("That was the last one.");
    ctx.rerender();
    return;
  }
  try {
    const r = await ctx.api(`/dialer/queues/${encodeURIComponent(s.queue.id)}/step`, { method: "POST", body: { dir } });
    s.queue = r.data.queue;
    if (dir === "next" && r.data.queue.cursor === n - 1 && n) toast("Last one in this queue.");
    ctx.rerender();
  } catch (err) { toast(err.message || "That didn't move.", { bad: true }); }
}

async function pickScript(ctx) {
  const v = await pickFrom({ title: "Script", items: ctx.state.scripts.map((x) => ({ value: x.id, label: x.name })) });
  if (!v) return;
  ctx.keep.script = v;
  ctx.state.script = ctx.state.scripts.find((x) => x.id === v) || ctx.state.script;
  ctx.rerender();
}

// A new named queue: from the leads in a stage, a pipeline, or empty (add people from the Queue tab).
export async function newQueue(ctx) {
  const kind = await pickFrom({ title: "New queue from", items: [
    { value: "leads:new", label: "New leads" }, { value: "leads:contacted", label: "Contacted leads" }, { value: "leads:quoted", label: "Quoted leads" },
    { value: "leads:follow_up", label: "Leads in Follow-Up" }, { value: "leads:not_ready", label: "Not Ready leads" }, { value: "pipeline", label: "A pipeline" }, { value: "manual", label: "Empty (add people by hand)" },
  ] });
  if (!kind) return;
  let source = { kind: "manual" };
  let name = "My queue";
  if (kind.startsWith("leads:")) { source = { kind: "leads", stage: kind.slice(6) }; name = { new: "New leads", contacted: "Contacted leads", quoted: "Quoted leads", follow_up: "Follow-Up leads", not_ready: "Not Ready leads" }[kind.slice(6)]; }
  if (kind === "pipeline") {
    const cads = await ctx.api("/cadences").then((r) => r.data || []).catch(() => []);
    const key = await pickFrom({ title: "Which pipeline", items: cads.map((c) => ({ value: c.key, label: c.name })) });
    if (!key) return;
    source = { kind: "pipeline", cadence: key };
    name = (cads.find((c) => c.key === key) || {}).name || "Pipeline";
  }
  try {
    const r = await ctx.api("/dialer/queues", { method: "POST", body: { name, source } });
    pickQueue(r.data.queue.id);
    toast(`${name}: ${r.data.queue.ids.length} people`);
    ctx.refresh();
  } catch (err) { toast(err.message || "That didn't save.", { bad: true }); }
}
