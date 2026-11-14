// Reports (the office's KPI views, docs/DASHBOARD.md; Menu → Money → Reports) inside the CRM: the
// Overview · Money · Sales · Plans · Jobs views of /dashboard?embed=1 in a
// frame under the CRM's own header and tab bar. Office sign-in only (the
// pseudo-permission office:tools = this phone has the office cookie); the
// dashboard page checks it again on the server.
//
// The view buttons switch the frame's #hash in place (the Dashboard tab
// stays the screen, so no back arrow and the tab stays lit), and only once
// the frame has loaded: changing a frame's location while its page is still
// loading makes Safari drop that page and leave the frame blank. The last
// view is kept for this screen; /dashboard/:view opens one view directly
// (old #money links from the office land there).

import { html } from "../../core/ui.js";

export const VIEWS = [
  ["overview", "Overview"],
  ["money", "Money"],
  ["sales", "Sales"],
  ["plans", "Plans"],
  ["jobs", "Jobs"],
];
const known = (id) => VIEWS.some(([v]) => v === id);

export default {
  title: "Reports",
  flush: true,
  load(params, ctx) {
    const want = params.view || (ctx && ctx.keep && ctx.keep.view);
    return { view: known(want) ? want : "overview" };
  },
  render(state) {
    return html`<nav class="seg-bar" aria-label="Report views">${VIEWS.map(([id, label]) => html`<button type="button" class="${"seg" + (id === state.view ? " on" : "")}" data-view="${id}" aria-pressed="${id === state.view ? "true" : "false"}">${label}</button>`)}</nav>
<div class="frame-wrap"><iframe title="Reports" src="${"/dashboard?embed=1#" + state.view}"></iframe></div>`;
  },
  mount(view, state, ctx) {
    const f = view.querySelector("iframe");
    const bar = view.querySelector(".seg-bar");
    if (!f || !bar) return;
    // the selected view's button may sit off-screen in the scrolling row
    const sel = bar.querySelector(".seg.on");
    if (sel) { try { sel.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch (e) { /* old Safari */ } }
    let loaded = false;
    let pending = null;
    const show = (id) => {
      try { if (f.contentWindow.location.hash !== "#" + id) f.contentWindow.location.hash = id; } catch (e) { /* not reachable */ }
    };
    f.addEventListener("load", () => {
      loaded = true;
      if (pending) { const id = pending; pending = null; show(id); }
    });
    bar.addEventListener("click", (e) => {
      const b = e.target.closest("[data-view]");
      if (!b || !known(b.dataset.view)) return;
      const id = b.dataset.view;
      bar.querySelectorAll("[data-view]").forEach((x) => {
        const on = x === b;
        x.classList.toggle("on", on);
        x.setAttribute("aria-pressed", String(on));
      });
      if (ctx && ctx.keep) ctx.keep.view = id;
      try { b.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch (e) { /* old Safari */ }
      if (loaded) show(id); else pending = id;
    });
  },
};
