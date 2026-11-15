// Menu (design §9.1; the Nov 15 2026 Menu, Flyra's): the same cards as the
// Menu sheet (core/nav.js menuBody, menuGroups) as a page, for old links to
// #/menu: your card (initials, name, the company, Edit → My account), the
// Menu's cards (Home to Leads, the four tiles, Sales, Money, Reports,
// Marketing, Tab bar and Settings), then (a page has the room) More screens:
// each section's screens the rows don't open themselves (the Outbox,
// Timesheets, Light Studio...), then a coral Sign out and the app's
// version. The tab bar's Menu button slides the sheet up itself.

import { html, icon, attrs } from "../../core/ui.js";
import { initials, roleLabel } from "../../core/format.js";
import { menuGroups, menuMore, menuBody, signOut, openCustomizeTabs } from "../../core/nav.js";
import { APP_VERSION } from "../../version.js";

export default {
  title: "Menu",
  load() { const groups = menuGroups(); return { groups, more: menuMore(groups) }; },
  render(s, ctx) {
    const u = ctx.user || {};
    return html`<div class="stack menu-page">
      <a class="card menu-me" href="#/me"><span class="avatar" ${attrs({ style: /^#[0-9a-f]{6}$/i.test(u.color || "") ? `background:${u.color}` : null })}>${initials(u.name)}</span><span class="who"><span class="nm">${u.name || "My account"}</span><span class="sub">${roleLabel(u.role) || "Team"}, Barta Window Washing</span></span><span class="menu-edit">${icon("doc")}Edit</span></a>
      <nav class="menu-rows" aria-label="Menu">${menuBody(s.groups)}</nav>
      ${s.more.length ? html`<nav class="menu-rows" aria-labelledby="menu-more-h"><h2 class="menu-more-h" id="menu-more-h">More screens</h2>${menuBody(s.more)}</nav>` : ""}
      <button type="button" class="btn primary block menu-out" data-signout>${icon("out")}Sign out of this phone</button>
      <p class="foot-note">Version ${APP_VERSION}</p>
    </div>`;
  },
  events: {
    "click [data-signout]": () => signOut(),
    "click [data-fm-tabs]": () => openCustomizeTabs(),
  },
};
