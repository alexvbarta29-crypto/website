// Notifications (design §5.7.7): the bell. Everything the CRM told this
// person (new leads, replies, approvals waiting, visit changes...), newest
// first; unread ones marked. Tapping one marks it read and opens it.
// The same ones arrive as push on the phones where notifications are on
// (My account).

import { html, icon, toast } from "../../core/ui.js";
import { ago } from "../../core/format.js";

const KIND_ICON = { new_lead: "contacts", reply: "inbox", payment: "money", payment_failed: "money", approval: "check", system: "bell", task: "list", review: "check" };

export default {
  title: "Notifications",
  async load(params, ctx) {
    const r = await ctx.api("/notifications", { cache: false });
    return { items: r.data || [], next: (r.meta || {}).next_cursor || null };
  },
  action(s, ctx) {
    if (!s.items.some((n) => !n.read_at)) return null;
    // the server marks a batch at a time ({ more: true } while unread ones are left)
    return { label: "Mark all read", run: async () => { try { for (let i = 0; i < 25; i++) { const r = await ctx.api("/notifications/read", { method: "POST", body: { all: true } }); if (!(r && r.data && r.data.more)) break; } ctx.refresh(); } catch (e) { toast(e.message, { bad: true }); ctx.refresh(); } } };
  },
  render(s) {
    if (!s.items.length) return html`<div class="stack"><div class="card empty"><div class="art">${icon("bell")}</div><h2>No notifications</h2><p>New leads, replies and approvals land here, and on your phone when notifications are on (My account).</p></div></div>`;
    return html`<div class="stack"><ul class="list">${s.items.map((n) => html`<li><button type="button" class="row" data-open="${n.id}" data-link="${n.link}">
      <span class="ico ${n.read_at ? "" : "coral"}">${icon(KIND_ICON[n.kind] || "bell")}</span>
      <span class="who"><span class="nm two">${n.title}</span><span class="sub two">${n.body}</span></span>
      <span class="end small muted">${n.read_at ? "" : html`<span class="pill red">New</span>`} ${ago(n.created_at)}</span>
    </button></li>`)}</ul></div>`;
  },
  events: {
    "click [data-open]": async (e, el, ctx) => {
      const id = el.getAttribute("data-open");
      const link = el.getAttribute("data-link") || "/today";
      ctx.api("/notifications/read", { method: "POST", body: { ids: [id] } }).catch(() => {});
      ctx.go(link.startsWith("/") ? link : "/today");
    },
  },
};
