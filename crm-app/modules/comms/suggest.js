// The Suggested reply in a thread (owner, Nov 16 2026: "auto drafts replies
// to customers, and you can hold down on it, or tell it to change it, have a
// few options to change it"). When the newest message is the customer's and
// nobody has answered, a soft card above the composer holds a draft from
// POST /messages/draft: Use puts it in the message box (it never sends by
// itself), the chips change it (Shorter, Friendlier, More professional, Add
// availability, Ask for their address when none is on file, Change it...),
// and a long press on the words (or the card's "...") opens the same choices
// as a sheet with Copy and Regenerate. The composer's + has "Draft a reply"
// for any thread (a follow-up). The office only, and only once the owner has
// set the Anthropic key (the thread's `drafts`); otherwise no card at all.
// Words only: no customer data is kept here beyond the draft on screen.

import { html, attrs, icon, sheet, toast, actionSheet, rnd } from "../../core/ui.js";
import { SPARKLE } from "./kit.js";

// The chips, in order (the server maps each key to its instruction, drafts.mjs CHIPS).
export const CHIPS = [["shorter", "Shorter"], ["friendlier", "Friendlier"], ["professional", "More professional"], ["availability", "Add availability"], ["ask_details", "Ask for their address"]];
export const chipsFor = (g) => CHIPS.filter(([k]) => k !== "ask_details" || (g && (g.missing || []).includes("address")));

// One draft per customer message (a thread reopened, or the 10 s poll, asks again for nothing).
const cache = new Map();
const hidden = new Set();

const isNote = (m) => m && m.kind === "note";
// The customer's newest message when nothing came after it (a reply, or a send waiting in the Outbox), else null.
export function waitingOn(s) {
  const items = [...(s.older || []), ...(s.messages || [])].filter((m) => !isNote(m)).map((m) => ({ at: m.sent_at, m }));
  for (const p of s.pending || []) items.push({ at: p.at, p });
  items.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const last = items[items.length - 1];
  return last && last.m && last.m.direction === "in" ? last.m : null;
}
export const mayDraft = (s, ctx) => !!(s && s.office && s.drafts && ctx.can("messages:send"));

// The card (or nothing).
export function suggestCard(s) {
  const g = s.sugg;
  if (!g || g.done || s.channel === "note") return "";
  const busy = g.status === "loading" || g.busy;
  return html`<section class="${"cm-sugg" + (busy ? " busy" : "")}" data-sugg aria-label="Suggested reply" ${attrs({ "aria-busy": busy ? "true" : null })}>
    <div class="cm-sugg-h"><span class="cm-sugg-l">${SPARKLE}Suggested reply</span>
      ${g.status === "ready" ? rnd("more", "More choices for the suggestion", { tone: "grey", data: { "sugg-more": true }, popup: true }) : ""}
      ${rnd("close", "Hide the suggestion", { tone: "grey", data: { "sugg-x": true } })}</div>
    ${g.status === "loading" ? html`<p class="cm-sugg-t wait">Writing a reply...</p>`
      : g.status === "error" ? html`<p class="cm-sugg-t wait">${g.msg || "It couldn't write one just now."}</p>`
      : html`<p class="cm-sugg-t" data-sugg-text data-hold tabindex="0" ${attrs({ title: "Hold for more choices" })}>${g.text}</p>`}
    ${g.status === "ready" ? html`<div class="cm-sugg-a">
      <button type="button" class="cm-sugg-use" data-sugg-use ${attrs({ disabled: busy ? true : null })}>${icon("check")}Use</button>
      <div class="cm-sugg-cs" role="group" aria-label="Change it">${chipsFor(g).map(([k, l]) => html`<button type="button" class="cm-sugg-c" ${attrs({ "data-sugg-chip": k, disabled: busy ? true : null })}>${l}</button>`)}<button type="button" class="cm-sugg-c" data-sugg-change ${attrs({ disabled: busy ? true : null })}>${icon("edit")}Change it...</button></div>
    </div>` : g.status === "error" && g.retry ? html`<div class="cm-sugg-a"><button type="button" class="cm-sugg-c" data-sugg-chip="regenerate">Try again</button></div>` : ""}
  </section>`;
}

// Asks for a draft. o: { instruction?, previous? }. env: { repaint(), fill(text) }
async function ask(ctx, env, o = {}) {
  const s = ctx.state;
  const g = s.sugg;
  if (!g) return;
  const key = g.key;
  const channel = s.channel === "email" ? "email" : s.channel === "sms" ? "sms" : undefined;
  try {
    const r = await ctx.api("/messages/draft", { method: "POST", body: { contact_id: s.cid, ...(channel ? { channel } : {}), ...(o.instruction ? { instruction: o.instruction } : {}), ...(o.previous ? { previous_draft: o.previous } : {}) } });
    if (!s.sugg || s.sugg.key !== key) return;
    const d = r.data || {};
    s.sugg = { ...s.sugg, status: "ready", busy: false, text: d.draft || "", missing: d.missing || [] };
    cache.set(key, { text: s.sugg.text, missing: s.sugg.missing });
  } catch (e) {
    if (!s.sugg || s.sugg.key !== key) return;
    const reason = e && e.details && e.details.reason;
    if (reason === "not_set_up") { s.drafts = false; s.sugg = null; }
    else if (g.status === "ready") { s.sugg = { ...s.sugg, busy: false }; toast((e && e.message) || "That didn't change. Try again.", { bad: true }); }
    else s.sugg = { ...s.sugg, status: "error", busy: false, msg: (e && e.message) || "It couldn't write one just now.", retry: !(e && e.status === 429) };
  }
  env.repaint();
}

// Called on every paint: a card for the customer's newest unanswered message.
export function maybeSuggest(ctx, env) {
  const s = ctx.state;
  if (!mayDraft(s, ctx)) { if (s.sugg) s.sugg = null; return; }
  const g = s.sugg;
  if (g && !g.auto) return;                                  // a draft asked for from + stays until used or hidden
  const m = waitingOn(s);
  if (!m) { if (g) { s.sugg = null; setTimeout(env.repaint, 0); } return; }
  const key = `${s.cid}|${m.id}`;
  if (g && g.key === key) return;
  if (hidden.has(key)) { if (g) { s.sugg = null; setTimeout(env.repaint, 0); } return; }
  const had = cache.get(key);
  s.sugg = had ? { key, auto: true, status: "ready", ...had } : { key, auto: true, status: "loading" };
  setTimeout(() => { env.repaint(); if (!had) ask(ctx, env); }, 0);
}

// The composer's + "Draft a reply": a fresh draft for any thread (a follow-up too).
export function draftNow(ctx, env) {
  const s = ctx.state;
  s.sugg = { key: `${s.cid}|ask|${Date.now()}`, auto: false, status: "loading" };
  env.repaint();
  ask(ctx, env);
}
export const plusItem = (s, ctx, env) => (s.office && ctx.can("messages:send") && s.channel !== "note"
  ? { label: "Draft a reply", icon: "bulb", hint: s.drafts ? "a suggestion to edit" : "needs the Anthropic key (Netlify)", disabled: !s.drafts, run: () => draftNow(ctx, env), data: { "draft-reply": true } }
  : null);

function change(ctx, env, instruction) {
  const s = ctx.state;
  const g = s.sugg;
  if (!g || g.status !== "ready" || g.busy) return;
  s.sugg = { ...g, busy: true };
  env.repaint();
  ask(ctx, env, { instruction, previous: g.text });
}
function hide(ctx, env) {
  const s = ctx.state;
  if (s.sugg) { hidden.add(s.sugg.key); s.sugg = null; }
  env.repaint();
}
// Use: the words go in the message box, to edit and send yourself. Nothing is sent.
function use(ctx, env) {
  const g = ctx.state.sugg;
  if (!g || g.status !== "ready") return;
  hidden.add(g.key);
  ctx.state.sugg = null;
  env.fill(g.text);
}
function changeSheet(ctx, env) {
  const sh = sheet({
    title: "Change it",
    body: html`<form class="form" data-sugg-f novalidate>
      <label class="field"><span>What should it say differently?</span><textarea name="ins" rows="3" maxlength="300" placeholder="Say we can come Thursday" aria-label="What to change"></textarea></label>
      <button type="submit" class="btn primary block">Change it</button>
    </form>`,
    events: {
      "submit [data-sugg-f]": (e, f) => {
        e.preventDefault();
        const ins = f.querySelector("textarea").value.trim();
        if (!ins) { toast("Say what to change.", { bad: true }); return; }
        sh.close();
        change(ctx, env, ins);
      },
    },
  });
  setTimeout(() => { const ta = document.querySelector(".sheet.on [data-sugg-f] textarea"); if (ta) ta.focus(); }, 60);
}
// The long press (or "..."): the same choices as a sheet, plus Copy and Regenerate.
export function holdSheet(ctx, env) {
  const g = ctx.state.sugg;
  if (!g || g.status !== "ready") return;
  actionSheet("Suggested reply", [
    [{ label: "Use", icon: "check", hint: "put it in the box", run: () => use(ctx, env), data: { "sugg-h": "use" } }],
    [...chipsFor(g).map(([k, l]) => ({ label: l, icon: "edit", run: () => change(ctx, env, k), data: { "sugg-h": k } })),
      { label: "Change it...", icon: "chat", hint: "say what to change", run: () => changeSheet(ctx, env), data: { "sugg-h": "change" } }],
    [{ label: "Copy", icon: "copy", run: () => copy(g.text), data: { "sugg-h": "copy" } },
      { label: "Regenerate", icon: "undo", hint: "a fresh one", run: () => change(ctx, env, "regenerate"), data: { "sugg-h": "regenerate" } }],
  ]);
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast("Copied."); } catch (e) { toast("Copy didn't work here. Use it, then copy from the box.", { bad: true }); }
}

// The thread's events for the card (thread.js spreads these into its own).
export const suggestEvents = (env) => ({
  "click [data-sugg-use]": (e, el, ctx) => use(ctx, env(ctx)),
  "click [data-sugg-chip]": (e, el, ctx) => {
    const s = ctx.state;
    if (s.sugg && s.sugg.status === "error") { s.sugg = { ...s.sugg, status: "loading" }; env(ctx).repaint(); ask(ctx, env(ctx)); return; }
    change(ctx, env(ctx), el.dataset.suggChip);
  },
  "click [data-sugg-change]": (e, el, ctx) => changeSheet(ctx, env(ctx)),
  "click [data-sugg-x]": (e, el, ctx) => hide(ctx, env(ctx)),
  "click [data-sugg-more]": (e, el, ctx) => holdSheet(ctx, env(ctx)),
  "rs-hold [data-sugg-text]": (e, el, ctx) => holdSheet(ctx, env(ctx)),
  "keydown [data-sugg-text]": (e, el, ctx) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); holdSheet(ctx, env(ctx)); } },
});
