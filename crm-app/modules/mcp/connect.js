// Connect Claude (OAuth consent, netlify/lib/crm/modules/mcp/oauth.mjs):
// claude.ai sends the owner here after "Connect". The screen says which app
// asks (as it calls itself), where it goes back to, and what it may do;
// Allow sends the one-time code back to the app, Don't allow sends a no.
// Signed in with the person's own CRM login; Allow goes through the
// router's CSRF check. Every change Claude later asks for still waits for
// an owner under Approvals.

import { html, icon, attrs, toast } from "../../core/ui.js";

// Leaves the CRM for the app's address (the server built it from the
// address the app registered: claude.ai, claude.com or this computer).
function leave(url) {
  if (!/^(https:\/\/(claude\.ai|claude\.com)\/|http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\/)/.test(url)) { toast("That address doesn't look right. Nothing was shared.", { bad: true }); return; }
  try { window.top.location.href = url; } catch (e) { window.location.href = url; }
}

export default {
  title: "Connect Claude",
  async load(params, ctx) {
    try {
      const r = await ctx.api(`/mcp/oauth/requests/${encodeURIComponent(params.rid || "")}`, { cache: false });
      return { rid: params.rid, info: r.data, ask: r.data.wants_ask && r.data.can_ask, done: false };
    } catch (e) {
      return { rid: params.rid, gone: (e && e.message) || "This sign-in link has expired. Start again from Claude." };
    }
  },
  render(s) {
    if (s.gone) return html`<div class="stack"><div class="card empty"><div class="art">${icon("link")}</div><h2>This link has expired</h2><p>${s.gone}</p></div></div>`;
    if (s.done) return html`<div class="stack"><div class="card"><p>${s.done}</p></div></div>`;
    const i = s.info;
    return html`<div class="stack oc">
      <div class="card stack">
        <h2 class="oc-h">${icon("plug")}<span><b>${i.client_name}</b> wants to connect to Barta CRM as ${i.you}</span></h2>
        <p class="small muted">That's the name the app gave itself. After you answer you go back to <b>${i.goes_back_to}</b>.${i.claude ? " Only allow this if you just tapped Connect in Claude yourself." : " Only allow this if you just started it on this computer."}</p>
      </div>
      <div class="card stack">
        <div class="section-h">It will be able to</div>
        <label class="check"><input type="checkbox" checked disabled><span><b>Look things up</b>: customers, the schedule, quotes, plans, invoices, messages and reports. Only what you can see.</span></label>
        ${i.wants_ask ? html`<label class="check"><input type="checkbox" data-ask ${attrs({ checked: s.ask, disabled: !i.can_ask })}><span><b>Ask for changes</b>: a text, a task, a quote, a job, a deal move. ${i.can_ask ? "Each one waits under Approvals until an owner taps Approve. Nothing happens before that." : "Your account can't ask for changes."}</span></label>` : ""}
        <p class="small muted">It can never charge a card, send a campaign or change who has access. Disconnect it any time in Settings → Claude connector.</p>
      </div>
      <div class="oc-act">
        <button type="button" class="btn block" data-deny>Don't allow</button>
        <button type="button" class="btn primary block" data-allow>Allow</button>
      </div>
    </div>`;
  },
  events: {
    "change [data-ask]": (e, el, ctx) => { ctx.state.ask = !!el.checked; },
    "click [data-allow]": async (e, btn, ctx) => {
      btn.disabled = true;
      try {
        const r = await ctx.api(`/mcp/oauth/requests/${encodeURIComponent(ctx.state.rid)}/approve`, { method: "POST", body: { ask: !!ctx.state.ask } });
        ctx.state.done = "Connected. Taking you back to Claude…";
        ctx.rerender();
        leave(r.data.redirect_url);
      } catch (err) { btn.disabled = false; toast(err.message, { bad: true }); }
    },
    "click [data-deny]": async (e, btn, ctx) => {
      btn.disabled = true;
      try {
        const r = await ctx.api(`/mcp/oauth/requests/${encodeURIComponent(ctx.state.rid)}/deny`, { method: "POST", body: {} });
        ctx.state.done = "Not connected. Taking you back…";
        ctx.rerender();
        leave(r.data.redirect_url);
      } catch (err) { btn.disabled = false; toast(err.message, { bad: true }); }
    },
  },
};
