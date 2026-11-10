// Today (design §9.2, §9.3): the date, a greeting and, for now, an empty
// day. The modules fill it as they land: Needs attention and Approvals
// cards (M1.3+), My visits with Clock in/out (M4b), Today's visits by tech
// (M4a), the Money strip (M5). A tech sees their own day only.

import { html, icon } from "../../core/ui.js";
import { dateLong } from "../../core/format.js";
import * as router from "../../core/router.js";

const greeting = (d) => {
  const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", hourCycle: "h23" }).format(d));
  return h < 12 ? "Morning" : h < 17 ? "Afternoon" : "Evening";
};

export default {
  title: "Today",
  load(params, ctx) {
    return { now: new Date(), user: ctx.user || {} };
  },
  render(s, ctx) {
    const tech = s.user.role === "tech";
    const links = [
      ctx.can("contacts:read_all") && router.has("/legacy/customers") ? html`<a class="tile" href="#/legacy/customers">${icon("contacts")}<span>Customers</span></a>` : "",
      ctx.can("users:manage") ? html`<a class="tile" href="#/team">${icon("team")}<span>Team</span></a>` : "",
      tech ? "" : html`<a class="tile" href="#/me">${icon("me")}<span>My account</span></a>`,
    ].filter(Boolean);
    return html`<div class="stack">
      <div class="hello"><div class="date">${dateLong(s.now)}</div><h2>${greeting(s.now)}, ${s.user.first_name || s.user.name || "there"}</h2></div>
      ${tech
        ? html`<div class="card empty"><div class="art">${icon("today")}</div><h2>No visits today</h2><p>Your visits show up here, in route order, once scheduling moves into the CRM.</p></div>`
        : html`<div class="card empty"><div class="art">${icon("sun")}</div><h2>Nothing needs you right now</h2><p>Leads, replies, visits and money show up here as each part of the CRM goes live. Rotor is still in charge until the switch.</p></div>`}
      ${links.length ? html`<div class="section-h">Quick links</div><div class="links">${links}</div>` : ""}
    </div>`;
  },
};
