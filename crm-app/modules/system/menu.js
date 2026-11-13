// Menu (design §9.1; the Nov 2026 layout, after Rotor's "More" page): the
// same places as the Menu sheet (core/nav.js openMenuSheet, menuGroups) as a
// page: your card (initials, name, the company, Edit → My account), then
// rounded rows with round grey icons by group, then a coral Sign out and
// the app's version. The tab bar's Menu button opens the sheet; old links
// to #/menu and a desk land here.

import { html, icon, attrs } from "../../core/ui.js";
import { initials, roleLabel } from "../../core/format.js";
import { menuGroups, signOut, menuRows } from "../../core/nav.js";
import { APP_VERSION } from "../../version.js";

export default {
  title: "Menu",
  load() { return { groups: menuGroups() }; },
  render(s, ctx) {
    const u = ctx.user || {};
    return html`<div class="stack menu-page">
      <a class="card menu-me" href="#/me"><span class="avatar" ${attrs({ style: /^#[0-9a-f]{6}$/i.test(u.color || "") ? `background:${u.color}` : null })}>${initials(u.name)}</span><span class="who"><span class="nm">${u.name || "My account"}</span><span class="sub">${roleLabel(u.role) || "Team"}, Barta Window Washing</span></span><span class="menu-edit">${icon("doc")}Edit</span></a>
      ${menuRows(s.groups)}
      <button type="button" class="btn primary block menu-out" data-signout>${icon("out")}Sign out of this phone</button>
      <p class="foot-note">Version ${APP_VERSION}</p>
    </div>`;
  },
  events: {
    "click [data-signout]": () => signOut(),
  },
};
