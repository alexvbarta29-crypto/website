// Barta CRM client: pickers (design §2.3 pickers.js). Each opens a sheet
// and resolves with the choice, or null when it is closed:
//   pickContact(api, { title })   search by name, phone, email or address (GET /search)
//   pickUser(api, { title, filter })  someone on the team (GET /users)
//   pickFrom({ title, items })    any short list [{ value, label, sub? }]
// plus dateField() and timeField(), native inputs with the house style
// (16 px, no iOS zoom).

import { html, sheet, attrs, icon, render as paint } from "./ui.js";
import { roleLabel } from "./format.js";

function listSheet({ title, placeholder, search, render, empty }) {
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    let seq = 0;
    const s = sheet({
      title,
      body: html`<div class="picker">
        ${search ? html`<label class="field"><span class="sr">Search</span><input type="search" ${attrs({ placeholder, autocomplete: "off", autocapitalize: "none", spellcheck: "false", enterkeyhint: "search" })} data-q></label>` : ""}
        <ul class="list picker-list" data-results></ul><p class="muted small" data-empty hidden></p>
      </div>`,
      onClose: () => { if (!done) { done = true; resolve(null); } },
      events: {
        "click [data-pick]": (e, el) => { done = true; const v = JSON.parse(el.getAttribute("data-pick")); s.close(); resolve(v); },
        "input [data-q]": (e, el) => { clearTimeout(timer); timer = setTimeout(() => run(el.value), 220); },
      },
    });
    const box = s.el.querySelector("[data-results]");
    const none = s.el.querySelector("[data-empty]");
    async function run(q) {
      const my = ++seq;
      let rows = [];
      try { rows = await search(String(q || "").trim()); } catch (e) { rows = []; none.textContent = e.message || "That didn't load."; }
      if (my !== seq) return;
      paint(box, html`${rows.map((r) => html`<li><button type="button" class="row" ${attrs({ "data-pick": JSON.stringify(r.value) })}>${render(r)}</button></li>`)}`);
      none.hidden = rows.length > 0;
      if (!rows.length && !none.textContent) none.textContent = empty;
    }
    run("");
    const input = s.el.querySelector("[data-q]");
    if (input) setTimeout(() => { try { input.focus(); } catch (e) { /* old Safari */ } }, 280);
  });
}

// A contact by name, phone, email or address. → { id, name } | null
export function pickContact(api, { title = "Pick a contact" } = {}) {
  return listSheet({
    title, placeholder: "Name, phone, email or address", search: async (q) => {
      if (q.length < 2) return [];
      const r = await api(`/search?q=${encodeURIComponent(q)}`, { cache: false });
      return ((r.data && r.data.contacts) || []).map((c) => ({ value: { id: c.id, name: c.name }, name: c.name, sub: c.sub }));
    },
    render: (r) => html`${icon("contacts")}<span class="who"><span class="nm">${r.name}</span><span class="sub">${r.sub || ""}</span></span>`,
    empty: "Type at least two letters. Contacts arrive with the Contacts module.",
  });
}

// Someone on the team. → { id, name } | null
export function pickUser(api, { title = "Pick someone", filter } = {}) {
  let all = null;
  return listSheet({
    title, placeholder: "Name", search: async (q) => {
      if (!all) all = ((await api("/users")).data || []).filter((u) => u.status === "active" && (!filter || filter(u)));
      const w = q.toLowerCase();
      return all.filter((u) => !w || String(u.name).toLowerCase().includes(w)).map((u) => ({ value: { id: u.id, name: u.name }, name: u.name, sub: roleLabel(u.role) }));
    },
    render: (r) => html`${icon("me")}<span class="who"><span class="nm">${r.name}</span><span class="sub">${r.sub}</span></span>`,
    empty: "Nobody matches.",
  });
}

// One of a few choices. items: [{ value, label, sub? }] → value | null
export function pickFrom({ title = "Pick one", items = [] } = {}) {
  return listSheet({
    title, search: async () => items.map((i) => ({ value: i.value, name: i.label, sub: i.sub })),
    render: (r) => html`<span class="who"><span class="nm">${r.name}</span>${r.sub ? html`<span class="sub">${r.sub}</span>` : ""}</span>`,
    empty: "Nothing to pick.",
  });
}

export function dateField({ label, name, value = "", min, max, hint = "" }) {
  return html`<label class="field" data-field="${name}"><span>${label}</span><input ${attrs({ type: "date", name, value: value || "", min, max })}>${hint ? html`<small>${hint}</small>` : ""}<small class="why" hidden></small></label>`;
}
export function timeField({ label, name, value = "", step = 300, hint = "" }) {
  return html`<label class="field" data-field="${name}"><span>${label}</span><input ${attrs({ type: "time", name, value: value || "", step })}>${hint ? html`<small>${hint}</small>` : ""}<small class="why" hidden></small></label>`;
}
