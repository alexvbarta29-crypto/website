// Menu (design §9.1; the Nov 2026 drawer, Rotor's): the same rows as the
// drawer (core/nav.js drawerList, drawerGroups) as a page, for old links to
// #/menu: your card (initials, name, the company, Edit → My account), the
// drawer's groups (a row with a dot shows its own list in place, "‹ Service"
// goes back), the settings gear, then a coral Sign out and the app's
// version. The tab bar's Menu button opens the drawer itself.

import { html, icon, attrs } from "../../core/ui.js";
import { initials, roleLabel } from "../../core/format.js";
import { drawerGroups, drawerList, drawerFoot, signOut, openCustomizeTabs } from "../../core/nav.js";
import { APP_VERSION } from "../../version.js";

export default {
  title: "Menu",
  load(params, ctx) { return { groups: drawerGroups(), open: ctx.keep.open || null }; },
  render(s, ctx) {
    const u = ctx.user || {};
    return html`<div class="stack menu-page">
      <a class="card menu-me" href="#/me"><span class="avatar" ${attrs({ style: /^#[0-9a-f]{6}$/i.test(u.color || "") ? `background:${u.color}` : null })}>${initials(u.name)}</span><span class="who"><span class="nm">${u.name || "My account"}</span><span class="sub">${roleLabel(u.role) || "Team"}, Barta Window Washing</span></span><span class="menu-edit">${icon("doc")}Edit</span></a>
      <nav class="menu-rows" aria-label="Menu">${drawerList(s.groups, { open: s.open })}</nav>
      <div class="dr-foot">${drawerFoot()}</div>
      <button type="button" class="btn primary block menu-out" data-signout>${icon("out")}Sign out of this phone</button>
      <p class="foot-note">Version ${APP_VERSION}</p>
    </div>`;
  },
  events: {
    "click [data-signout]": () => signOut(),
    "click [data-dr-sub]": (e, el, ctx) => { ctx.state.open = ctx.keep.open = el.dataset.drSub; ctx.rerender(); },
    "click [data-dr-back]": (e, el, ctx) => { ctx.state.open = ctx.keep.open = null; ctx.rerender(); },
    "click [data-dr-tabs]": () => openCustomizeTabs(),
  },
};
