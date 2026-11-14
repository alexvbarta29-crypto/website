// One group of the Settings hub (#/settings/g/:key; settings.js LAYOUT):
// the group's name as the title, the round back to Settings, its rows in
// one inset card (the coloured tile, the name, Owner on the owners' rows,
// the chevron). Only the rows this person may open; none, and it says so.

import { html } from "../../core/ui.js";
import { pickTheme } from "../../core/nav.js";
import { group, settingRow } from "./settings.js";

export default {
  title: (s) => (s.group ? s.group.label : "Settings"),
  async load(params, ctx) {
    return { key: params.key, group: group(ctx.can, params.key) };
  },
  render(s) {
    const g = s.group;
    if (!g) return html`<div class="rs-page set-grp"><div class="rs-card"><p class="rs-empty">Nothing in this group for your login.</p></div></div>`;
    return html`<div class="rs-page set-grp" data-group-page="${g.key}">
      <ul class="list set-list" aria-label="${g.label}">${g.items.map((x) => settingRow(x, g.tint))}</ul>
    </div>`;
  },
  events: {
    "click [data-theme-row]": () => pickTheme(),
  },
};
