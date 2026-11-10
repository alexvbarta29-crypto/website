// Dashboard (the office's KPI views, docs/DASHBOARD.md) inside the CRM: the
// Overview · Money · Sales · Plans · Jobs views of /dashboard?embed=1 in a
// frame under the CRM's own header and tab bar. Office sign-in only (the
// pseudo-permission office:tools = this phone has the office cookie); the
// dashboard page checks it again on the server. Each view is its own route,
// so a new frame loads with the view already in its #hash (never change a
// frame's location before its page has loaded: Safari blanks it).

import { html } from "../../core/ui.js";

export const VIEWS = [
  ["overview", "Overview"],
  ["money", "Money"],
  ["sales", "Sales"],
  ["plans", "Plans"],
  ["jobs", "Jobs"],
];

export default {
  title: "Dashboard",
  flush: true,
  load(params) {
    const view = VIEWS.some(([id]) => id === params.view) ? params.view : "overview";
    return { view };
  },
  render(state) {
    return html`<nav class="seg-bar" aria-label="Dashboard views">${VIEWS.map(([id, label]) => html`<a class="${"seg" + (id === state.view ? " on" : "")}" href="${"#/dashboard/" + id}" aria-current="${id === state.view ? "page" : "false"}">${label}</a>`)}</nav>
<div class="frame-wrap"><iframe title="Dashboard" src="${"/dashboard?embed=1#" + state.view}"></iframe></div>`;
  },
};
