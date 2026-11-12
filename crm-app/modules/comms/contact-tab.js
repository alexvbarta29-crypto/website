// The contact's Messages tab (design §9.2 Contact → Messages): their
// threads (texts, email) with the latest messages, and a button to text
// them. (A contact tab renders inside the Contact screen, so everything
// here is a link to the thread.)

import { html, icon } from "../../core/ui.js";
import { ago } from "../../core/format.js";
import { ensureStyles, bubble, pendingBubble } from "./kit.js";

export default {
  async load(params, ctx) {
    ensureStyles();
    if (!ctx.can("inbox:read")) return { denied: true };
    const r = await ctx.api(`/inbox/contact/${encodeURIComponent(params.id)}`, { cache: false });
    return { id: params.id, ...r.data };
  },
  render(s, ctx) {
    if (s.denied) return html`<div class="card empty"><h2>Not for this login</h2><p>Messages are for the office and the tech on the visit.</p></div>`;
    const id = encodeURIComponent(s.id);
    const last = [...(s.messages || [])].slice(0, 6).reverse();
    const open = s.conversation ? "#/inbox/" + encodeURIComponent(s.conversation.id) : "#/inbox/" + id;
    return html`<div class="stack">
      <div class="btn-row">${ctx && ctx.can("messages:send") ? html`<a class="btn primary" href="${open}">${icon("text")}${s.conversation ? "Open the conversation" : "Text them"}</a>` : ""}</div>
      ${(s.threads || []).length ? html`<ul class="list">${s.threads.map((t) => html`<li><a class="row" href="${"#/inbox/" + encodeURIComponent(t.id)}">
        <span class="who"><span class="nm">${t.channel === "email" ? "Email" : "Texts"}${t.count ? ` · ${t.count}` : ""}</span><span class="sub">${t.last_direction === "out" ? "You: " : ""}${t.last_preview || ""}</span></span>
        <span class="end"><span class="small muted">${t.last_at ? ago(t.last_at) : ""}</span>${t.needs_reply ? html`<span class="pill amber">Needs reply</span>` : ""}<span class="chev" aria-hidden="true"></span></span></a></li>`)}</ul>` : html`<p class="muted small">No messages with this contact yet.</p>`}
      ${last.length || (s.pending || []).length ? html`<div class="section-h">Latest</div><div class="cm-msgs">${last.map(bubble)}${(s.pending || []).slice(0, 3).map(pendingBubble)}</div>` : ""}
    </div>`;
  },
};
