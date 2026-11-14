// Calendar feed: your visits on your phone's own calendar (Google Calendar
// or Apple Calendar), from a private link only you have. Techs get their
// own visits; owners and the office may pick everyone's. Each visit shows
// the customer's first name, the town and the service, at its time in
// Central time; it follows the schedule as it changes. The link is shown
// once; "New link" stops the old one, "Turn off" stops it at once.

import { html, icon, toast, confirmSheet, attrs, openExternal } from "../../core/ui.js";
import { ago } from "../../core/format.js";

const googleAdd = (webcal) => `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}`;

function scopePicker(s) {
  if (!s.feed.can_all) return "";
  const cur = s.feed.scope || "mine";
  const opt = (v, label, sub) => html`<label class="check"><input ${attrs({ type: "radio", name: "scope", value: v, checked: cur === v })}><span><b>${label}</b><br><span class="small muted">${sub}</span></span></label>`;
  return html`<div class="stack">${opt("mine", "My visits", "The visits you're on.")}${opt("all", "Everyone's visits", "The whole crew's day, with who is on each visit.")}</div>`;
}

function linkCard(s) {
  const m = s.made;
  if (!m) return "";
  return html`<div class="card stack" data-made>
    <div class="warn-box">Copy it now. It's shown only this once.</div>
    <div class="copy-box"><input type="text" readonly ${attrs({ value: m.url, "aria-label": "Calendar link" })}><button type="button" class="btn dark" data-copy>${icon("copy")}Copy</button></div>
    <a class="btn block" ${openExternal(googleAdd(m.webcal_url))}>${icon("today")}Add to Google Calendar</a>
    <p class="small"><b>iPhone (Apple Calendar):</b> open Settings, then Calendar, Accounts, Add Account, Other, Add Subscribed Calendar. Paste the link and tap Next, then Save.</p>
    <p class="small"><b>Google Calendar on a computer:</b> next to Other calendars tap +, then From URL. Paste the link and tap Add calendar.</p>
    <p class="small muted">Google refreshes a subscribed calendar every few hours; Apple about every hour. The CRM's Schedule is always the latest.</p>
  </div>`;
}

export default {
  title: "Calendar feed",
  async load(params, ctx) {
    return { feed: (await ctx.api("/calendar-feed", { cache: false })).data, made: null };
  },
  render(s) {
    const f = s.feed;
    return html`<div class="stack">
      <div class="card"><p class="small">See your visits in Google Calendar or Apple Calendar, next to the rest of your life. Each one shows the customer's first name, the town and the service. No phone numbers, addresses or notes ever go in it.</p></div>
      ${f.on ? html`<div class="card stack">
          <div class="row" style="padding:0;min-height:0">${icon("today")}<span class="who"><span class="nm">On</span><span class="sub">${f.scope === "all" ? "Everyone's visits" : "My visits"} · link …${f.last4}</span></span></div>
          <p class="small muted">Link made ${ago(f.created_at)}.</p>
          ${scopePicker(s)}
          <div class="btn-row"><button type="button" class="btn" data-new>${icon("undo")}New link</button><button type="button" class="btn danger" data-off>Turn off</button></div>
        </div>`
        : html`<div class="card stack">${scopePicker(s)}<button type="button" class="btn primary block" data-on>${icon("today")}Turn on</button></div>`}
      ${linkCard(s)}
      <p class="small muted">Lost your phone or shared the link by mistake? Tap New link: the old one stops working.</p>
    </div>`;
  },
  events: {
    "click [data-on]": async (e, btn, ctx) => {
      btn.disabled = true;
      const picked = document.querySelector("input[name=scope]:checked");
      try {
        const r = await ctx.api("/calendar-feed", { method: "POST", body: picked ? { scope: picked.value } : {} });
        ctx.state.feed = { ...ctx.state.feed, ...r.data };
        ctx.state.made = { url: r.data.url, webcal_url: r.data.webcal_url };
        ctx.rerender();
      } catch (err) { btn.disabled = false; toast(err.message, { bad: true }); }
    },
    "click [data-new]": async (e, btn, ctx) => {
      if (!(await confirmSheet("The calendars subscribed to the old link stop updating. Subscribe again with the new one.", { title: "Make a new link?", yes: "New link" }))) return;
      try {
        const r = await ctx.api("/calendar-feed", { method: "POST", body: {} });
        ctx.state.feed = { ...ctx.state.feed, ...r.data };
        ctx.state.made = { url: r.data.url, webcal_url: r.data.webcal_url };
        ctx.rerender();
      } catch (err) { toast(err.message, { bad: true }); }
    },
    "click [data-off]": async (e, btn, ctx) => {
      if (!(await confirmSheet("Your visits leave the calendars that subscribed to it.", { title: "Turn the calendar feed off?", yes: "Turn off", danger: true }))) return;
      try { await ctx.api("/calendar-feed", { method: "DELETE" }); toast("Turned off"); ctx.state.made = null; ctx.refresh(); } catch (err) { toast(err.message, { bad: true }); }
    },
    "change input[name=scope]": async (e, el, ctx) => {
      if (!ctx.state.feed.on) return;
      try { const r = await ctx.api("/calendar-feed", { method: "PATCH", body: { scope: el.value } }); ctx.state.feed = { ...ctx.state.feed, ...r.data }; toast("Saved"); ctx.rerender(); } catch (err) { toast(err.message, { bad: true }); }
    },
    "click [data-copy]": async (e, btn) => {
      const input = btn.closest(".copy-box").querySelector("input");
      try { await navigator.clipboard.writeText(input.value); toast("Link copied"); } catch (x) { input.select(); toast("Press and hold to copy it."); }
    },
  },
};
