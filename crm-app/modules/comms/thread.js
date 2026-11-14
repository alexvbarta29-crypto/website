// A person's thread (the Rotor guide's: guide-gaps §2.3 I4 to I13, §7.2 I14
// to I18; design §9.2 "Thread", §5.7.1): their texts, email and the
// office's internal notes as ONE timeline (each bubble says its channel; a
// failed send says why and links where to fix it), what waits in the
// Outbox as grey "Not sent" bubbles, and the composer: Text | Email | Note,
// the business number it goes from (two or more numbers), the quick links
// (Review · Website · Booking), a template put in the box or sent as is, a
// file (the paperclip, while sending is a dry run), Send and Send later.
// The header's round buttons: call, and the person (their panel: stats,
// how to reach them, Mute automated texts, + Create, Open). Its "...":
// Mark done / Reopen, Assign to..., Move to inbox..., Open customer,
// Outbox. It refreshes every 10 s while open. /inbox/{conversation id}
// (any of the person's threads) or /inbox/{contact id}.
//
// A text needs signal: with no connection nothing is sent and nothing is
// queued for later (a late "on my way" is worse than none); the words stay
// in the box.

import { html, attrs, icon, sheet, toast, seg, rnd, actionSheet, sheetPage, statGrid, contactRows, pillBtn, toggle } from "../../core/ui.js";
import { poll } from "../../core/poll.js";
import { uuid } from "../../core/api.js";
import { phone as fmtPhone, money, dateShort, dateTime } from "../../core/format.js";
import { capture, uploadPhoto } from "../../core/camera.js";
import { ensureStyles, bubble, pendingBubble, dayLabel, reasonText, emptyCard } from "./kit.js";

let live = null;
const isConv = (id) => /^cv_/.test(id);
const allPath = (cid, before) => `/inbox/contact/${encodeURIComponent(cid)}?channel=all${before ? `&before=${encodeURIComponent(before)}` : ""}`;
const CHANNELS = [["sms", "Text"], ["email", "Email"], ["note", "Note"]];
export const MAX_FILES = 3;

async function load(params, ctx) {
  ensureStyles();
  let cid = params.id;
  let first = null;
  if (isConv(params.id)) {
    first = (await ctx.api(`/conversations/${encodeURIComponent(params.id)}`, { cache: false })).data;
    cid = first.conversation.contact_id;
  }
  let d;
  try { d = (await ctx.api(allPath(cid), { cache: false })).data; } catch (e) {
    if (!first) throw e;
    d = { ...first, channel: first.conversation.channel, compose_channel: first.conversation.channel, channels: { [first.conversation.channel]: first.info } };
  }
  const office = ctx.can("contacts:read_all");
  const want = ctx.keep.channel;
  const channel = (want === "note" && office) || want === "sms" || want === "email" ? want : d.compose_channel || "sms";
  const s = { id: params.id, cid, ...d, office, channel, draft: ctx.keep.draft || "", subject: ctx.keep.subject || "", older: [], whole: {}, busy: false, files: [], from: null, users: null };
  const def = (d.numbers || []).find((n) => n.default) || (d.numbers || [])[0];
  s.from = def ? def.e164 : null;
  // opening a thread reads it (each of the person's threads)
  for (const t of d.threads || []) if (t.unread) ctx.api(`/conversations/${t.id}/read`, { method: "POST", body: {} }).then(() => { t.unread = 0; }).catch(() => {});
  return s;
}

const who = (s) => (id) => ((s.users || []).find((u) => u.id === id) || {}).name || "";
function timeline(s) {
  const msgs = [...s.older, ...s.messages].map((m) => (s.whole[m.id] ? { ...m, body_text: s.whole[m.id], more: false } : m));
  const items = [...msgs.map((m) => ({ at: m.sent_at, m })), ...(s.pending || []).map((p) => ({ at: p.at, p }))].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const merged = (s.threads || []).length > 1 || items.some((it) => it.m && it.m.channel !== s.compose_channel);
  const out = [];
  let day = "";
  for (const it of items) {
    const d = dayLabel(it.at);
    if (d !== day) { day = d; out.push(html`<div class="cm-day">${d}</div>`); }
    out.push(it.m ? bubble(it.m, { merged, who: who(s) }) : pendingBubble(it.p, { merged }));
  }
  return out;
}

const infoOf = (s) => (s.channels && s.channels[s.channel]) || s.info || {};
function notice(s) {
  if (s.channel === "note") return html`<div class="note">A note stays in the CRM: only the team sees it, and it is never sent.</div>`;
  const i = infoOf(s);
  if (i.missing) return html`<div class="warn-box">This contact isn't in the CRM anymore.</div>`;
  if (!i.has_address) return html`<div class="warn-box">${s.channel === "sms" ? "No mobile number on file for texts." : "No email address on file."}</div>`;
  if (i.opted_out) return html`<div class="warn-box">They opted out of ${s.channel === "sms" ? "texts" : "email"}. Nothing can be sent until they opt back in.</div>`;
  if (i.mode === "dry_run") return html`<div class="note">${s.channel === "sms" ? "Texting" : "Email"} isn't switched on yet. What you send lands in the Outbox, not with them.</div>`;
  if (i.mode === "test") return html`<div class="note">Test mode: only the team's own phones get real messages.</div>`;
  return "";
}
const canSend = (s, ctx) => {
  if (s.channel === "note") return s.office;
  const i = infoOf(s);
  return ctx.can("messages:send") && i.has_address && !i.opted_out && !i.missing;
};
const numberLabel = (n) => (n ? `${n.label ? n.label + " " : ""}${fmtPhone(n.e164)}` : "");

function composer(s, ctx) {
  if (!ctx.can("messages:send") && !s.office) return "";
  const can = canSend(s, ctx);
  const note = s.channel === "note";
  const chans = CHANNELS.filter(([k]) => k !== "note" || s.office);
  const nums = s.numbers || [];
  const from = nums.find((n) => n.e164 === s.from);
  return html`<form class="cm-compose" data-compose novalidate>
    ${chans.length > 1 ? seg(chans, s.channel, { name: "ch", label: "Send by" }) : ""}
    ${s.channel === "email" ? html`<input type="text" name="subject" placeholder="Subject" maxlength="150" autocomplete="off" ${attrs({ value: s.subject, "aria-label": "Subject", disabled: can ? null : true })}>` : ""}
    <textarea name="body" rows="2" ${attrs({ maxlength: note ? 4000 : 1600, placeholder: note ? "Note for the team" : s.channel === "sms" ? "Text message" : "Email", "aria-label": note ? "Note" : "Message", class: note ? "note" : null, disabled: can ? null : true })}>${s.draft}</textarea>
    ${!note && s.office ? html`<div class="cm-quick" role="group" aria-label="Put a link in">
      ${s.channel === "sms" && nums.length > 1 ? html`<button type="button" class="chip" data-from ${attrs({ "aria-label": `From ${numberLabel(from)}. Change` })}>From ${numberLabel(from)}</button>` : ""}
      ${s.links ? [["review", "Review"], ["website", "Website"], ["booking", "Booking"]].map(([k, l]) => html`<button type="button" class="chip" ${attrs({ "data-link": k, disabled: can ? null : true })}>${l}</button>`) : ""}
    </div>` : ""}
    ${s.files.length ? html`<div class="cm-files">${s.files.map((f, i) => html`<span class="chip">${icon("doc")}File ${i + 1}<button type="button" class="linkish" ${attrs({ "data-unfile": f.id, "aria-label": `Take file ${i + 1} off` })}>${icon("close")}</button></span>`)}</div>` : ""}
    <div class="cm-send">
      ${!note && s.office ? rnd("clip", "Attach a picture or PDF", { tone: "grey", data: { attach: true }, disabled: !can || s.files.length >= MAX_FILES }) : ""}
      ${!note ? rnd("doc", "Templates", { tone: "grey", data: { templates: true }, disabled: !can }) : ""}
      <span class="cm-count" data-count></span>
      ${!note ? rnd("clock", "Send later", { tone: "grey", data: { later: true }, disabled: !can || s.busy }) : ""}
      <button type="submit" class="rnd red" ${attrs({ "aria-label": note ? "Save the note" : "Send", disabled: can && !s.busy ? null : true })}>${icon(note ? "check" : "send")}</button>
    </div>
  </form>`;
}

function render(s, ctx) {
  return html`<div class="cm-thread">
    ${notice(s)}
    ${s.next ? html`<button type="button" class="btn block" data-older>Show earlier messages</button>` : ""}
    <div class="cm-msgs" aria-live="polite">${timeline(s)}</div>
    ${!s.messages.length && !(s.pending || []).length && !s.older.length ? emptyCard("text", "No messages yet", "Write the first one below.") : ""}
    ${composer(s, ctx)}
  </div>`;
}

async function refresh(ctx) {
  const r = await ctx.api(allPath(ctx.state.cid), { cache: false });
  const keep = { channel: ctx.state.channel, from: ctx.state.from };
  Object.assign(ctx.state, r.data, keep);
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
const clearBox = (ctx) => {
  const s = ctx.state;
  s.draft = ""; s.subject = ""; s.files = []; ctx.keep.draft = ""; ctx.keep.subject = "";
  const ta = document.querySelector("[data-compose] textarea");
  if (ta) ta.value = "";
};

async function send(ctx, payload) {
  const s = ctx.state;
  if (s.busy) return;
  s.busy = true;
  try {
    const extra = { ...(s.channel === "sms" && s.from && (s.numbers || []).length > 1 ? { from_number: s.from } : {}), ...(s.files.length && !payload.template_key ? { files: s.files.map((f) => f.id) } : {}) };
    const r = await ctx.api("/messages", { method: "POST", body: { contact_id: s.cid, channel: s.channel, client_id: uuid(), ...extra, ...payload } });
    const d = r.data || {};
    if (d.status === "blocked") toast(`Not sent: ${reasonText(d.blocked_reason)}.`, { bad: true });
    else if (d.status === "dry_run") toast("Saved to the Outbox. Sending isn't switched on, so nothing was sent.");
    else if (d.status === "scheduled" && payload.send_at) toast(`Scheduled for ${dateTime(d.send_at)}. While sending is off it lands in the Outbox then.`);
    else if (d.status === "scheduled") toast("It's quiet hours: it goes out in the morning.");
    else if (d.status === "failed") toast("The provider refused it. See the message for why.", { bad: true });
    else toast("Sent.");
    if (d.status !== "blocked") clearBox(ctx);
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

async function saveNote(ctx, body) {
  const s = ctx.state;
  if (s.busy) return;
  s.busy = true;
  try {
    await ctx.api(`/inbox/contact/${encodeURIComponent(s.cid)}/notes`, { method: "POST", body: { body } });
    toast("Note saved. Only the team sees it.");
    clearBox(ctx);
    await refresh(ctx);
  } catch (e) { toast((e && e.message) || "That didn't save. Try again.", { bad: true }); } finally { s.busy = false; }
}

// Put words in the box where the caret is (a template's text, a link).
function insert(ctx, text) {
  const ta = document.querySelector("[data-compose] textarea");
  if (!ta) return;
  const at = ta.selectionStart ?? ta.value.length;
  const before = ta.value.slice(0, at);
  const sep = before && !/\s$/.test(before) ? " " : "";
  ta.value = before + sep + text + ta.value.slice(ta.selectionEnd ?? at);
  ctx.state.draft = ta.value; ctx.keep.draft = ta.value;
  ta.focus();
  ta.dispatchEvent(new Event("input", { bubbles: true }));
}

async function templates(ctx) {
  const s = ctx.state;
  const list = ((await ctx.api(`/templates?channel=${s.channel}`, { cache: false })).data || []).filter((t) => t.active !== false && t.category !== "staff");
  const listBody = () => (list.length ? html`<ul class="list">${list.map((t) => html`<li><button type="button" class="row" data-tpl="${t.key}"><span class="who"><span class="nm">${t.name}</span><span class="sub">${t.category}</span></span><span class="chev" aria-hidden="true"></span></button></li>`)}</ul>` : html`<p class="muted">No templates for this channel yet.</p>`);
  let text = "";
  const sh = sheet({
    title: "Templates",
    body: listBody(),
    events: {
      "click [data-tpl]": async (e, el) => {
        const key = el.dataset.tpl;
        const p = (await ctx.api("/templates/preview", { method: "POST", body: { template_key: key, contact_id: s.cid } })).data;
        const missing = p.missing_for_contact || [];
        text = p.text || "";
        sh.set(html`<div class="stack">
          ${p.subject ? html`<p><b>${p.subject}</b></p>` : ""}
          <div class="preview">${p.text}</div>
          ${missing.length ? html`<div class="warn-box">This contact has no ${missing.join(", ").replace(/_/g, " ")}: it would not send. Add it to the contact, or write the text yourself.</div>` : ""}
          <div class="btn-row"><button type="button" class="btn" data-back>Back</button><button type="button" class="btn" data-put>Put in the box</button><button type="button" class="btn primary" data-use="${key}" ${attrs({ disabled: missing.length ? true : null })}>Send this</button></div>
        </div>`);
      },
      "click [data-back]": () => sh.set(listBody()),
      "click [data-put]": () => { sh.close(); insert(ctx, text); },
      "click [data-use]": async (e, el) => { sh.close(); await send(ctx, { template_key: el.dataset.use }); },
    },
  });
}

// Send later (Rotor's ⌄ on Send, Flyra's calendar): a time in the next 30 days.
function laterSheet(ctx) {
  const s = ctx.state;
  const form = document.querySelector("[data-compose]");
  const body = form ? form.querySelector("textarea").value.trim() : "";
  const subject = form && form.querySelector("[name=subject]") ? form.querySelector("[name=subject]").value.trim() : "";
  if (!body) { toast("Write a message first.", { bad: true }); return; }
  if (s.channel === "email" && !subject) { toast("An email needs a subject.", { bad: true }); return; }
  const tomorrow = new Date(Date.now() + 86400000);
  const pad = (n) => String(n).padStart(2, "0");
  const val = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}T09:00`;
  const sh = sheet({
    title: "Send later",
    body: html`<form class="form" data-later-f novalidate>
      <label class="field"><span>When</span><input type="datetime-local" name="at" required ${attrs({ value: val })}></label>
      <p class="small muted">It goes out then (in the next 30 days). While sending is off it lands in the Outbox at that time instead.</p>
      <button type="submit" class="btn primary block">${icon("clock")}Schedule it</button>
    </form>`,
    events: {
      "submit [data-later-f]": async (e, f) => {
        e.preventDefault();
        const at = new Date(f.querySelector("[name=at]").value);
        if (!Number.isFinite(at.getTime()) || at.getTime() <= Date.now()) { toast("Pick a time from now on.", { bad: true }); return; }
        sh.close();
        await send(ctx, { body, ...(subject ? { subject } : {}), send_at: at.toISOString() });
      },
    },
  });
}

async function attach(ctx) {
  const s = ctx.state;
  const conv = (s.threads || []).find((t) => t.channel === s.channel) || (s.threads || [])[0] || s.conversation;
  if (!conv) { toast("Send them a first message, then attach files.", { bad: true }); return; }
  const file = await capture({ accept: "image/*,application/pdf", camera: false });
  if (!file) return;
  try {
    const out = await uploadPhoto({ ownerType: "conversation", ownerId: conv.id, kind: "attachment", file });
    s.files = [...s.files, out.file].slice(0, MAX_FILES);
    repaint(ctx);
  } catch (e) { toast(e.message || "That file didn't upload.", { bad: true }); }
}

// ------------------------------------------------------------ the header's round buttons and "..."

// The person, beside their thread (Rotor's customer panel): their numbers,
// how to reach them, Mute automated texts, + Create, Open.
async function panel(ctx) {
  const s = ctx.state;
  let d;
  try { d = (await ctx.api(`/contacts/${encodeURIComponent(s.cid)}`, { cache: false })).data; } catch (e) { ctx.go("/contacts/" + encodeURIComponent(s.cid)); return; }
  const c = d.contact;
  const st = d.stats || {};
  const m = st.money || null;
  const ok = (n) => Number.isSafeInteger(n) && n >= 0;
  const items = [];
  if (ctx.can("invoices:read_all")) {
    items.push({ label: "Lifetime value", value: m && ok(m.lifetime_cents) ? money(m.lifetime_cents) : "-" });
    items.push({ label: "Owed", value: m && ok(m.open_balance_cents) ? money(m.open_balance_cents) : "-", tone: m && m.open_balance_cents > 0 ? "red" : null });
  }
  items.push({ label: "Next visit", value: st.work && st.work.next_visit_on ? dateShort(st.work.next_visit_on) : "-" });
  items.push({ label: "Source", value: (c.source && c.source.source) || "Not known" });
  const ph = (c.phones || [])[0];
  const em = (c.emails || [])[0];
  const rows = [
    ph && ph.e164 && { icon: "phone", label: "Mobile", value: fmtPhone(ph.e164), actions: [{ icon: "call", label: "Call", href: "tel:" + ph.e164 }] },
    em && em.address && { icon: "mail", label: "Email", value: em.address, actions: [{ icon: "mail", label: "Email", href: "mailto:" + em.address }] },
  ].filter(Boolean);
  const muted = !!(c.automations_paused && c.automations_paused.sms);
  const creates = [
    ctx.can("quotes:write") && ["Quote", `#/quotes/new/${c.id}`],
    ctx.can("schedule:write") && ["Job", `#/jobs/new/${c.id}`],
    ctx.can("invoices:write") && ["Invoice", `#/invoices/new/${c.id}`],
    ctx.can("sales:work") && ["Task", `#/tasks/new/${c.id}`],
    ctx.can("plans:write") && ["Plan", `#/plans/new/${c.id}`],
  ].filter(Boolean);
  const body = () => html`<div class="stack cm-panel">
    ${statGrid(items, { label: c.lifecycle === "lead" ? "Lead details" : "Customer details" })}
    ${rows.length ? contactRows(rows) : ""}
    ${ctx.can("consent:edit") ? html`<div class="rs-card rs-frows cm-mute"><div class="rs-frow"><span class="rs-fl">Mute automated texts<small>${muted ? `Muted: ${c.automations_paused.sms.reason || ""}` : "Reminders and follow-ups skip them; your own texts still go."}</small></span>${toggle(muted, { data: { mute: true }, label: "Mute automated texts" })}</div></div>` : ""}
    ${creates.length ? html`<div class="cm-create"><span class="rs-label">Create</span><div class="rs-pills">${creates.map(([l, href]) => pillBtn(l, { icon: "plus", href, tone: "grey" }))}</div></div>` : ""}
    ${pillBtn("Open customer", { icon: "user", href: `#/contacts/${c.id}`, wide: true, tone: "solid" })}
  </div>`;
  const page = sheetPage({
    title: c.display_name || "Customer",
    body,
    events: {
      "click [data-mute]": async (e, el) => {
        el.disabled = true;
        try {
          const r = await ctx.api(`/contacts/${encodeURIComponent(c.id)}/automations-paused`, { method: "PATCH", body: muted ? { channel: "sms", paused: false } : { channel: "sms", paused: true, reason: "Muted from the Inbox" } });
          toast(muted ? "Automated texts back on" : "Automated texts muted");
          page.close();
          if (r && r.data) panel(ctx);
        } catch (err) { el.disabled = false; toast(err.message, { bad: true }); }
      },
      "click a[href^='#/']": () => page.close(),
    },
  });
}

async function pickPerson(ctx) {
  const s = ctx.state;
  if (!s.users) s.users = await ctx.api("/users").then((r) => (r.data || []).filter((u) => u.status === "active")).catch(() => []);
  const cur = (s.threads || [])[0] && s.threads[0].assignee_id;
  actionSheet("Assign to", [
    s.users.map((u) => ({ label: u.name + (u.id === cur ? " (now)" : ""), icon: "user", data: { "assign-to": u.id }, run: () => assignAll(ctx, u.id) })),
    cur && [{ label: "Nobody", icon: "close", run: () => assignAll(ctx, null) }],
  ]);
}
async function assignAll(ctx, uid) {
  const s = ctx.state;
  try {
    for (const t of s.threads || []) await ctx.api(`/conversations/${t.id}/assign`, { method: "POST", body: { user_id: uid } });
    toast(uid ? "Assigned" : "Unassigned");
    await refresh(ctx);
  } catch (e) { toast(e.message, { bad: true }); }
}
async function pickInbox(ctx) {
  const s = ctx.state;
  const c = (await ctx.api("/inbox/counts", { cache: false })).data || {};
  const list = c.list || [];
  if (!list.length) { toast("No team inboxes yet: Inbox, then ..., then Team inboxes.", { bad: true }); return; }
  actionSheet("Move to inbox", [list.map((x) => ({ label: x.name, icon: "inbox", data: { "move-to": x.key }, run: () => moveAll(ctx, x.key) })), [{ label: "Back to where the rules put it", icon: "undo", run: () => moveAll(ctx, null) }]]);
}
async function moveAll(ctx, key) {
  const s = ctx.state;
  try {
    for (const t of s.threads || []) await ctx.api(`/conversations/${t.id}/move`, { method: "POST", body: { inbox: key } });
    toast(key ? "Moved" : "Moved back");
    await refresh(ctx);
  } catch (e) { toast(e.message, { bad: true }); }
}
async function markDone(ctx, done) {
  const s = ctx.state;
  try {
    for (const t of s.threads || []) await ctx.api(`/conversations/${t.id}/done`, { method: "POST", body: { done } });
    toast(done ? "Marked done." : "Reopened.");
    await refresh(ctx);
  } catch (e) { toast(e.message, { bad: true }); }
}
const isOpen = (s) => (s.threads || []).some((t) => t.state === "open" || t.needs_reply);

export default {
  load, render, flush: true,
  title: (s) => (s && s.info && s.info.name) || "Conversation",
  tools: (s, ctx) => {
    const ph = s.contact && (s.contact.phones || [])[0];
    return [
      ph && ph.e164 && { icon: "call", label: "Call " + fmtPhone(ph.e164), href: "tel:" + ph.e164 },
      s.office && s.contact && { icon: "user", label: "Their details", run: () => panel(ctx), data: { panel: true } },
    ];
  },
  more: (s, ctx) => (s.threads && s.threads.length && ctx.can("inbox:read") ? [
    [isOpen(s) ? { label: "Mark done", icon: "check", run: () => markDone(ctx, true), data: { done: "1" } } : { label: "Reopen", icon: "undo", run: () => markDone(ctx, false), data: { done: "0" } },
      s.office && { label: "Assign to...", icon: "user", run: () => pickPerson(ctx), data: { assign: true } },
      s.office && { label: "Move to inbox...", icon: "inbox", run: () => pickInbox(ctx), data: { move: true } }],
    [s.contact && ctx.can("contacts:read_all") && { label: "Open customer", icon: "contacts", href: `#/contacts/${s.cid}` },
      ctx.can("outbox:read") && { label: "Outbox (not sent)", icon: "send", href: "#/outbox" }],
  ] : [[s.contact && ctx.can("contacts:read_all") && { label: "Open customer", icon: "contacts", href: `#/contacts/${s.cid}` }]]),
  mount(el, s, ctx) {
    if (!live || live.for !== ctx) {
      if (live) live.stop();
      live = poll(allPath(s.cid), 10000, (data) => { const keep = { channel: ctx.state.channel, from: ctx.state.from }; Object.assign(ctx.state, data, keep); repaint(ctx); }, { immediate: false });
      live.for = ctx;
      // a thread opens at its newest message
      const sc = el.querySelector(".cm-thread");
      if (sc) sc.scrollTop = sc.scrollHeight;
    }
    if (s.office && !s.users && (s.messages || []).some((m) => m.kind === "note")) {
      ctx.api("/users").then((r) => { s.users = (r.data || []); repaint(ctx); }).catch(() => { s.users = []; });
    }
  },
  unmount() { if (live) { live.stop(); live = null; } },
  events: {
    "submit [data-compose]": async (e, el, ctx) => {
      e.preventDefault();
      const body = el.querySelector("textarea").value.trim();
      const subject = el.querySelector("[name=subject]") ? el.querySelector("[name=subject]").value.trim() : "";
      if (!body) { toast(ctx.state.channel === "note" ? "Write the note first." : "Write a message first.", { bad: true }); return; }
      if (ctx.state.channel === "email" && !subject) { toast("An email needs a subject.", { bad: true }); return; }
      el.querySelector("button[type=submit]").disabled = true;
      if (ctx.state.channel === "note") await saveNote(ctx, body);
      else await send(ctx, { body, ...(subject ? { subject } : {}) });
    },
    "click [data-seg=ch]": (e, el, ctx) => {
      const ta = document.querySelector("[data-compose] textarea");
      if (ta) ctx.state.draft = ta.value;
      ctx.state.channel = el.dataset.key; ctx.keep.channel = el.dataset.key;
      repaint(ctx);
    },
    "input [data-compose] textarea": (e, el, ctx) => {
      ctx.state.draft = el.value; ctx.keep.draft = el.value;
      const n = el.value.length;
      const c = document.querySelector("[data-count]");
      if (c) c.textContent = ctx.state.channel === "sms" && n > 140 ? `${n}${n > 160 ? ` · ${Math.ceil(n / 153)} texts` : ""}` : "";
    },
    "input [data-compose] [name=subject]": (e, el, ctx) => { ctx.state.subject = el.value; ctx.keep.subject = el.value; },
    "click [data-templates]": (e, el, ctx) => templates(ctx),
    "click [data-later]": (e, el, ctx) => laterSheet(ctx),
    "click [data-attach]": (e, el, ctx) => attach(ctx),
    "click [data-unfile]": (e, el, ctx) => { ctx.state.files = ctx.state.files.filter((f) => f.id !== el.dataset.unfile); repaint(ctx); },
    "click [data-link]": (e, el, ctx) => { const l = (ctx.state.links || {})[el.dataset.link]; if (l) insert(ctx, l); },
    "click [data-from]": (e, el, ctx) => {
      const s = ctx.state;
      actionSheet("Send from", [(s.numbers || []).map((n) => ({ label: numberLabel(n) + (n.e164 === s.from ? " (now)" : ""), icon: "phone", data: { "from-pick": n.e164 }, run: () => { s.from = n.e164; repaint(ctx); } }))]);
    },
    "click [data-older]": async (e, el, ctx) => {
      const s = ctx.state;
      const r = await ctx.api(allPath(s.cid, s.next), { cache: false });
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
