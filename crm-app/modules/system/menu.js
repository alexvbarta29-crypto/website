// Menu (design §9.1): every screen the bottom bar doesn't hold, as one
// page of labelled sections with large tiles (Work, Sales, Customers,
// Money, Messages & automations, Office tools, Admin), built from the
// manifests' nav entries (core/nav.js menuSections), so a module's screens
// show up in their section as the module ships. Sign out at the bottom.

import { html, icon } from "../../core/ui.js";
import { initials } from "../../core/format.js";
import { menuSections, signOut } from "../../core/nav.js";

export default {
  title: "Menu",
  // My account is the card at the top, not a tile
  load() { return { sections: menuSections().map((sec) => ({ ...sec, items: sec.items.filter((n) => n.path !== "/me") })).filter((sec) => sec.items.length) }; },
  render(s, ctx) {
    const u = ctx.user || {};
    return html`<div class="stack menu-page">
      <a class="card menu-me" href="#/me"><span class="avatar" style="${/^#[0-9a-f]{6}$/i.test(u.color || "") ? `background:${u.color}` : ""}">${initials(u.name)}</span><span class="who"><span class="nm">${u.name || "My account"}</span><span class="sub">${u.role === "owner" ? "Owner" : u.role === "admin" ? "Office" : "Team"} · My account</span></span><span class="chev" aria-hidden="true"></span></a>
      ${s.sections.map((sec) => html`<section class="${"menu-sec sec-" + sec.key}" aria-label="${sec.label}">
        <div class="section-h">${sec.label}</div>
        <div class="menu-grid">${sec.items.map((n) => html`<a class="mtile" href="${"#" + n.path}"><span class="mi">${icon(n.icon || "list")}</span><span class="ml">${n.label}</span></a>`)}</div>
      </section>`)}
      <button type="button" class="btn danger block menu-out" data-signout>${icon("out")}Sign out of this phone</button>
    </div>`;
  },
  events: {
    "click [data-signout]": () => signOut(),
  },
};
