// A conversation (design §9.2 "Thread", §5.7.1): the messages as bubbles
// (status under each; a failed one says why), what is waiting in the Outbox
// as grey "Not sent" bubbles, and the composer: your own words or a
// template with its preview and missing-variable warnings. It refreshes
// every 10 s while open. /inbox/{conversation id}, or /inbox/{contact id}
// for someone with no conversation yet.
//
// A text needs signal: with no connection nothing is sent and nothing is
// queued for later (a late "on my way" is worse than none); the words stay
// in the box.

import { html, attrs, icon, sheet, toast } from "../../core/ui.js";
import { poll } from "../../core/poll.js";
import { uuid } from "../../core/api.js";
import { phone as fmtPhone } from "../../core/format.js";
import { ensureStyles, bubble, pendingBubble, dayLabel, reasonText, emptyCard } from "./kit.js";

let live = null;
const isConv = (id) => /^cv_/.test(id);
const pathOf = (id, channel) => (isConv(id) ? `/conversations/${encodeURIComponent(id)}` : `/inbox/contact/${encodeURIComponent(id)}${channel ? `?channel=${channel}` : ""}`);

async function load(params, ctx) {
  ensureStyles();
  const r = await ctx.api(pathOf(params.id, ctx.keep.channel), { cache: false });
  const d = r.data;
  const s = { id: params.id, ...d, channel: d.channel || (d.conversation && d.conversation.channel) || "sms", draft: ctx.keep.draft || "", subject: ctx.keep.subject || "", older: [], whole: {}, busy: false };
  // opening a thread reads it
  if (d.conversation && d.conversation.unread) ctx.api(`/conversations/${d.conversation.id}/read`, { method: "POST", body: {} }).then(() => { s.conversation.unread = 0; }).catch(() => {});
  return s;
}

function timeline(s) {
  const msgs = [...s.older, ...s.messages].map((m) => (s.whole[m.id] ? { ...m, body_text: s.whole[m.id], more: false } : m));
  const items = [...msgs.map((m) => ({ at: m.sent_at, m })), ...(s.pending || []).map((p) => ({ at: p.at, p }))].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const out = [];
  let day = "";
  for (const it of items) {
    const d = dayLabel(it.at);
    if (d !== day) { day = d; out.push(html`<div class="cm-day">${d}</div>`); }
    out.push(it.m ? bubble(it.m) : pendingBubble(it.p));
  }
  return out;
}

function notice(s) {
  const i = s.info || {};
  if (i.missing) return html`<div class="warn-box">This contact isn't in the CRM anymore.</div>`;
  if (!i.has_address) return html`<div class="warn-box">${s.channel === "sms" ? "No mobile number on file for texts." : "No email address on file."}</div>`;
  if (i.opted_out) return html`<div class="warn-box">They opted out of ${s.channel === "sms" ? "texts" : "email"}. Nothing can be sent until they opt back in.</div>`;
  if (i.mode === "dry_run") return html`<div class="note">Texting isn't switched on yet. What you send lands in the Outbox, not on their phone.</div>`;
  if (i.mode === "test") return html`<div class="note">Test mode: only the team's own phones get real messages.</div>`;
  return "";
}

function render(s, ctx) {
  const i = s.info || {};
  const c = s.conversation;
  const can = ctx.can("messages:send") && i.has_address && !i.opted_out && !i.missing;
  const ph = s.contact && (s.contact.phones || [])[0];
  return html`<div class="cm-thread">
    <div class="cm-head">
      <span class="who"><span class="nm">${i.name || (c && c.contact_name) || "Conversation"}</span>
        <span class="sub">${[i.lifecycle === "lead" ? "Lead" : i.lifecycle === "customer" ? "Customer" : i.lifecycle === "archived" ? "Archived" : "", i.town, s.channel === "email" ? "Email" : "Texts"].filter(Boolean).join(" · ")}</span></span>
      ${s.contact ? html`<a class="btn" href="${"#/contacts/" + encodeURIComponent(s.contact.id)}">${icon("contacts")}Open</a>` : ""}
      ${ph && ph.e164 ? html`<a class="btn" href="${"tel:" + ph.e164}" ${attrs({ "aria-label": "Call " + fmtPhone(ph.e164) })}>${icon("phone")}Call</a>` : ""}
    </div>
    ${(s.threads || []).length > 1 ? html`<div class="chips">${s.threads.map((t) => html`<a class="chip" ${attrs({ "aria-pressed": String(c && t.id === c.id) })} href="${"#/inbox/" + encodeURIComponent(t.id)}">${t.channel === "email" ? "Email" : "Texts"} <span class="n">${t.count || ""}</span></a>`)}</div>` : ""}
    ${notice(s)}
    ${s.next ? html`<button type="button" class="btn block" data-older>Show earlier messages</button>` : ""}
    <div class="cm-msgs" aria-live="polite">${timeline(s)}</div>
    ${!s.messages.length && !(s.pending || []).length && !s.older.length ? emptyCard("text", "No messages yet", "Write the first one below.") : ""}
    ${c && ctx.can("inbox:read") ? html`<div class="btn-row">${c.state === "open" || c.needs_reply
      ? html`<button type="button" class="btn" data-done="1">${icon("check")}Mark done</button>`
      : html`<button type="button" class="btn" data-done="0">Reopen</button>`}</div>` : ""}
    ${ctx.can("messages:send") ? html`<form class="cm-compose" data-compose novalidate>
      ${s.channel === "email" ? html`<input type="text" name="subject" placeholder="Subject" maxlength="150" autocomplete="off" ${attrs({ value: s.subject, "aria-label": "Subject" })} ${can ? "" : attrs({ disabled: true })}>` : ""}
      <textarea name="body" rows="2" maxlength="1600" placeholder="${s.channel === "sms" ? "Text message" : "Email"}" ${attrs({ "aria-label": "Message", disabled: can ? null : true })}>${s.draft}</textarea>
      <div class="btn-row"><button type="button" class="btn" data-templates ${attrs({ disabled: can ? null : true })}>${icon("doc")}Templates</button>
        <span class="cm-count" data-count></span>
        <button type="submit" class="btn primary" ${attrs({ disabled: can && !s.busy ? null : true })}>${icon("send")}Send</button></div>
    </form>` : ""}
  </div>`;
}

async function refresh(ctx) {
  const r = await ctx.api(pathOf(ctx.state.id, ctx.state.channel), { cache: false });
  Object.assign(ctx.state, r.data);
  repaint(ctx);
}
// Repaints without losing what is being typed or where the thread is
// scrolled: at the newest message it stays there; after "earlier messages"
// the one that was on top stays on top.
const scroller = () => document.querySelector(".cm-thread");
function repaint(ctx, { older = false } = {}) {
  const ta = document.querySelector("[data-compose] textarea");
  const focused = ta && document.activeElement === ta;
  const pos = focused ? ta.selectionStart : null;
  if (ta) ctx.state.draft = ta.value;
  const sc = scroller();
  const top = sc ? sc.scrollTop : 0;
  const fromEnd = sc ? sc.scrollHeight - sc.scrollTop : 0;
  const atEnd = !sc || fromEnd - sc.clientHeight < 80;
  ctx.rerender();
  const now = scroller();
  if (now) now.scrollTop = atEnd ? now.scrollHeight : older ? now.scrollHeight - fromEnd : top;
  const n = document.querySelector("[data-compose] textarea");
  if (n && focused) { n.focus({ preventScroll: true }); try { n.setSelectionRange(pos, pos); } catch (e) { /* not selectable */ } }
}

async function send(ctx, payload) {
  const s = ctx.state;
  if (s.busy) return;
  s.busy = true;
  try {
    const r = await ctx.api("/messages", { method: "POST", body: { contact_id: s.contact.id, channel: s.channel, client_id: uuid(), ...payload } });
    const d = r.data || {};
    if (d.status === "blocked") toast(`Not sent: ${reasonText(d.blocked_reason)}.`, { bad: true });
    else if (d.status === "dry_run") toast("Saved to the Outbox. Texting isn't switched on, so nothing was sent.");
    else if (d.status === "scheduled") toast("It's quiet hours: it goes out in the morning.");
    else if (d.status === "failed") toast("The provider refused it. See the message for why.", { bad: true });
    else toast("Sent.");
    if (d.status !== "blocked") { s.draft = ""; s.subject = ""; ctx.keep.draft = ""; ctx.keep.subject = ""; const ta = document.querySelector("[data-compose] textarea"); if (ta) ta.value = ""; }
    // a first real message makes the conversation: open it by its own address
    if (d.conversation_id && !isConv(s.id)) { ctx.go("/inbox/" + encodeURIComponent(d.conversation_id), { replace: true }); return; }
    await refresh(ctx);
    const sc = scroller();
    if (sc) sc.scrollTop = sc.scrollHeight;
  } catch (e) {
    // no signal: nothing is sent and nothing is queued; the words stay in the box
    toast(e && e.code === "offline" ? "No connection. A text needs signal: nothing was sent, try again when you have it." : (e && e.message) || "That didn't send. Try again.", { bad: true });
  } finally {
    s.busy = false;
    const b = document.querySelector("[data-compose] button[type=submit]");
    if (b) b.disabled = false;
  }
}

async function templates(ctx) {
  const s = ctx.state;
  const list = ((await ctx.api(`/templates?channel=${s.channel}`, { cache: false })).data || []).filter((t) => t.active !== false && t.category !== "staff");
  const listBody = () => (list.length ? html`<ul class="list">${list.map((t) => html`<li><button type="button" class="row" data-tpl="${t.key}"><span class="who"><span class="nm">${t.name}</span><span class="sub">${t.category}</span></span><span class="chev" aria-hidden="true"></span></button></li>`)}</ul>` : html`<p class="muted">No templates for this channel yet.</p>`);
  const sh = sheet({
    title: "Templates",
    body: listBody(),
    events: {
      "click [data-tpl]": async (e, el) => {
        const key = el.dataset.tpl;
        const p = (await ctx.api("/templates/preview", { method: "POST", body: { template_key: key, contact_id: s.contact.id } })).data;
        const missing = p.missing_for_contact || [];
        sh.set(html`<div class="stack">
          ${p.subject ? html`<p><b>${p.subject}</b></p>` : ""}
          <div class="preview">${p.text}</div>
          ${missing.length ? html`<div class="warn-box">This contact has no ${missing.join(", ").replace(/_/g, " ")}: it would not send. Add it to the contact, or write the text yourself.</div>` : ""}
          <div class="btn-row"><button type="button" class="btn" data-back>Back</button><button type="button" class="btn primary" data-use="${key}" ${attrs({ disabled: missing.length ? true : null })}>Send this</button></div>
        </div>`);
      },
      "click [data-back]": () => sh.set(listBody()),
      "click [data-use]": async (e, el) => { sh.close(); await send(ctx, { template_key: el.dataset.use }); },
    },
  });
}

export default {
  load, render, flush: true,
  title: (s) => (s && s.info && s.info.name) || "Conversation",
  mount(el, s, ctx) {
    if (!live || live.for !== ctx) {
      if (live) live.stop();
      const c = s.conversation;
      // (a contact with no conversation yet has nothing to poll)
      live = c ? poll(`/conversations/${encodeURIComponent(c.id)}`, 10000, (data) => { Object.assign(ctx.state, data); repaint(ctx); }, { immediate: false }) : { stop() {} };
      live.for = ctx;
      // a thread opens at its newest message
      const sc = el.querySelector(".cm-thread");
      if (sc) sc.scrollTop = sc.scrollHeight;
    }
  },
  unmount() { if (live) { live.stop(); live = null; } },
  events: {
    "submit [data-compose]": async (e, el, ctx) => {
      e.preventDefault();
      const body = el.querySelector("textarea").value.trim();
      const subject = el.querySelector("[name=subject]") ? el.querySelector("[name=subject]").value.trim() : "";
      if (!body) { toast("Write a message first.", { bad: true }); return; }
      if (ctx.state.channel === "email" && !subject) { toast("An email needs a subject.", { bad: true }); return; }
      el.querySelector("button[type=submit]").disabled = true;
      await send(ctx, { body, ...(subject ? { subject } : {}) });
    },
    "input [data-compose] textarea": (e, el, ctx) => {
      ctx.state.draft = el.value; ctx.keep.draft = el.value;
      const n = el.value.length;
      const c = document.querySelector("[data-count]");
      if (c) c.textContent = n > 140 ? `${n} characters${n > 160 && ctx.state.channel === "sms" ? ` · ${Math.ceil(n / 153)} texts` : ""}` : "";
    },
    "input [data-compose] [name=subject]": (e, el, ctx) => { ctx.state.subject = el.value; ctx.keep.subject = el.value; },
    "click [data-templates]": (e, el, ctx) => templates(ctx),
    "click [data-done]": async (e, el, ctx) => {
      const r = await ctx.api(`/conversations/${ctx.state.conversation.id}/done`, { method: "POST", body: { done: el.dataset.done === "1" } });
      ctx.state.conversation = r.data;
      toast(el.dataset.done === "1" ? "Marked done." : "Reopened.");
      repaint(ctx);
    },
    "click [data-older]": async (e, el, ctx) => {
      const s = ctx.state;
      const r = await ctx.api(`/conversations/${s.conversation.id}?before=${encodeURIComponent(s.next)}`, { cache: false });
      s.older = [...(r.data.messages || []), ...s.older];
      s.next = r.data.next;
      repaint(ctx, { older: true });
    },
    "click [data-whole]": async (e, el, ctx) => {
      const r = await ctx.api(`/messages/${encodeURIComponent(el.dataset.whole)}`, { cache: false });
      ctx.state.whole[el.dataset.whole] = r.data.body_text || "";
      repaint(ctx);
    },
  },
};
