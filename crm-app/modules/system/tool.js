// The office tools inside the CRM (docs/OFFICE.md): Lights, Follow-ups,
// Purchases and Giveaway each fill the screen in a frame under the CRM's
// header and tab bar, and Rotor opens in a new tab. Office sign-in only
// (pseudo-permission office:tools); every tool page checks the office
// cookie again on the server. `css` drops each tool's own logo, header
// extras and sign-out so it reads as part of one app (same origin, so the
// CRM can add a style to the loaded page); `seed` is the sessionStorage
// key the Giveaway admin reads to skip its own admin key (same-origin
// frames share this tab's sessionStorage).

import { html, icon, openExternal } from "../../core/ui.js";

export const TOOLS = {
  lights: { title: "Lights", src: "/lights", css: ".brand{display:none!important}" },
  followups: { title: "Follow-ups", src: "/playbook", css: ".wrap>header>.brand,.wrap>footer{display:none!important}" },
  purchases: { title: "Purchases", src: "/purchases" },
  giveaway: { title: "Giveaway", src: "/admin/giveaway.html", css: "[data-gwa-logout]{display:none!important}", seed: "gwa-key" },
  rotor: { title: "Rotor", href: "https://app.getrotor.com" },
};

function blend(frame, css) {
  if (!css) return;
  try {
    const d = frame.contentDocument;
    if (!d || !d.head || d.getElementById("office-blend")) return;
    const st = d.createElement("style");
    st.id = "office-blend";
    st.textContent = css;
    d.head.appendChild(st);
  } catch (e) { /* not ready, or not same origin */ }
}

export default {
  title: (state) => (state.tool ? state.tool.title : "Office tool"),
  flush: true,
  load(params) {
    const tool = Object.hasOwn(TOOLS, params.id) ? TOOLS[params.id] : null;
    if (tool && tool.seed) { try { if (!sessionStorage.getItem(tool.seed)) sessionStorage.setItem(tool.seed, "office"); } catch (e) { /* no storage */ } }
    return { id: params.id, tool };
  },
  render(state) {
    const t = state.tool;
    if (!t) return html`<div class="stack"><div class="card empty"><div class="art">${icon("shield")}</div><h2>No such tool</h2><p>Open the Menu to see the office tools.</p></div></div>`;
    if (t.href) {
      return html`<div class="stack"><div class="card empty"><div class="art">${icon("link")}</div><h2>${t.title}</h2><p>Rotor opens in a new tab. It stays in charge of texts, invoices and payments until the switch.</p><a class="btn primary block" ${openExternal(t.href)}>Open ${t.title}</a></div></div>`;
    }
    return html`<div class="frame-wrap"><iframe title="${t.title}" src="${t.src}" allow="clipboard-read; clipboard-write; fullscreen"></iframe></div>`;
  },
  mount(view, state) {
    const t = state.tool;
    if (!t || !t.css) return;
    const f = view.querySelector("iframe");
    if (!f) return;
    f.addEventListener("load", () => blend(f, t.css));
    blend(f, t.css);
  },
};
