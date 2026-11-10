// Today (design §9.2, §9.3): the date, a greeting, the bell (unread
// notifications), the Approvals card (bulk sends and owner decisions
// waiting), alerts from the workers for owners and the office, and quick
// links. The modules fill the rest as they land: Needs attention (M2+),
// My visits with Clock in/out (M4b), Today's visits by tech (M4a), the
// Money strip (M5). A tech sees their own day only.

import { html, icon } from "../../core/ui.js";
import { dateLong, plural, dateTime } from "../../core/format.js";
import * as router from "../../core/router.js";

const greeting = (d) => {
  const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", hourCycle: "h23" }).format(d));
  return h < 12 ? "Morning" : h < 17 ? "Afternoon" : "Evening";
};

export default {
  title: "Today",
  async load(params, ctx) {
    const [badges, health] = await Promise.all([
      ctx.api("/me/badges", { cache: false }).then((r) => r.data).catch(() => null),
      ctx.can("audit:read") ? ctx.api("/admin/health", { cache: false }).then((r) => r.data).catch(() => null) : null,
    ]);
    return { now: new Date(), user: ctx.user || {}, badges, health };
  },
  render(s, ctx) {
    const tech = s.user.role === "tech";
    const b = s.badges || {};
    const alerts = (s.health && s.health.alerts) || [];
    const stuck = s.health && s.health.status && (s.health.status.fast === "stuck" || s.health.status.bulk === "stuck");
    const mode = (s.health && s.health.mode) || {};
    const links = [
      ctx.can("contacts:read_all") && router.has("/legacy/customers") ? html`<a class="tile" href="#/legacy/customers">${icon("contacts")}<span>Customers</span></a>` : "",
      ctx.can("outbox:read") ? html`<a class="tile" href="#/outbox">${icon("send")}<span>Outbox</span></a>` : "",
      ctx.can("automations:configure") ? html`<a class="tile" href="#/automations">${icon("bolt")}<span>Automations</span></a>` : "",
      ctx.can("users:manage") ? html`<a class="tile" href="#/team">${icon("team")}<span>Team</span></a>` : "",
      ctx.can("settings:general") ? html`<a class="tile" href="#/settings">${icon("gear")}<span>Settings</span></a>` : "",
      tech ? "" : html`<a class="tile" href="#/me">${icon("me")}<span>My account</span></a>`,
    ].filter(Boolean);
    return html`<div class="stack">
      <div class="row" style="padding:0;min-height:0;align-items:flex-start">
        <div class="hello who"><div class="date">${dateLong(s.now)}</div><h2>${greeting(s.now)}, ${s.user.first_name || s.user.name || "there"}</h2></div>
        <a class="icon-btn bell" href="#/notifications" aria-label="${b.notifications ? `Notifications, ${b.notifications} new` : "Notifications"}">${icon("bell")}${b.notifications ? html`<span class="badge">${b.notifications > 99 ? "99+" : b.notifications}</span>` : ""}</a>
      </div>
      ${mode.paused ? html`<a class="card alert" href="#/settings/data" style="display:block;text-decoration:none;color:inherit"><h2>The CRM is paused</h2><p>${mode.paused_reason === "restore" ? "A backup was restored. " : ""}Nothing is texted, emailed, charged or automated${mode.paused_at ? ` since ${dateTime(mode.paused_at)}` : ""}. An owner resumes it on Settings → Data.</p></a>` : ""}
      ${stuck || alerts.length ? html`<a class="card alert" href="#/settings/data" style="display:block;text-decoration:none;color:inherit"><h2>Needs a look</h2>${stuck ? html`<p>A worker hasn't finished a pass in 3 hours.</p>` : ""}${alerts.slice(0, 3).map((a) => html`<p>${a.text}</p>`)}</a>` : ""}
      ${b.approvals && ctx.can("campaigns:send") ? html`<a class="tile" href="#/approvals">${icon("check")}<span>${plural(b.approvals, "approval")} waiting</span><span class="n">${b.approvals}</span></a>` : ""}
      ${tech
        ? html`<div class="card empty"><div class="art">${icon("today")}</div><h2>No visits today</h2><p>Your visits show up here, in route order, once scheduling moves into the CRM.</p></div>`
        : html`<div class="card empty"><div class="art">${icon("sun")}</div><h2>Nothing needs you right now</h2><p>Leads, replies, visits and money show up here as each part of the CRM goes live. Rotor is still in charge until the switch.</p></div>`}
      ${links.length ? html`<div class="section-h">Quick links</div><div class="links">${links}</div>` : ""}
    </div>`;
  },
};
