// Inbox "..." → Team inboxes (the Rotor guide's "My inboxes / Other
// inboxes": guide-gaps §2.3 I2, S5a): each inbox has a name, who is on it,
// and what lands in it by itself (leads, customers; texts or email).
// Anything can also be moved into one from a thread's "...". The Inbox
// shows each as a tile with its count. settings:messaging.

import { html, attrs, toast, listCard, listRow, emptyCard, sheetPage, formRow, formRows, toggle, actionSheet } from "../../core/ui.js";
import { loadDoc, saveDoc } from "../system/kit.js";
import { ensureStyles } from "./kit.js";

const LC = [["lead", "Leads"], ["customer", "Customers"], ["former_customer", "Former customers"]];
const CH = [["", "Texts and email"], ["sms", "Texts"], ["email", "Email"]];
const ruleText = (m = {}) => {
  const parts = [];
  if (m.lifecycle && m.lifecycle.length) parts.push(m.lifecycle.map((l) => (LC.find((x) => x[0] === l) || [l, l])[1]).join(", "));
  if (m.channel) parts.push(m.channel === "sms" ? "texts" : "email");
  return parts.length ? `Gets ${parts.join(", ")} by itself` : "Only what is moved in";
};

function editor(ctx, i) {
  const s = ctx.state;
  const list = s.doc.data.list || [];
  const cur = i === null ? { name: "", member_ids: [], match: {} } : list[i];
  const v = { name: cur.name, members: new Set(cur.member_ids || []), lc: new Set((cur.match && cur.match.lifecycle) || []), ch: (cur.match && cur.match.channel) || "" };
  const body = () => html`<form class="stack" data-ib-f novalidate>
    ${formRows([
      formRow("Name", html`<input type="text" name="name" maxlength="40" required autocomplete="off" ${attrs({ value: v.name, placeholder: "Sales" })}>`),
    ])}
    <h2 class="rs-label">Lands here by itself</h2>
    ${formRows([...LC.map(([k, l]) => formRow(l, toggle(v.lc.has(k), { data: { lc: k }, label: l }))),
      formRow("Channel", html`<select name="ch">${CH.map(([k, l]) => html`<option ${attrs({ value: k, selected: v.ch === k })}>${l}</option>`)}</select>`)])}
    <h2 class="rs-label">Who is on it</h2>
    ${formRows(s.users.map((u) => formRow(u.name, toggle(v.members.has(u.id), { data: { member: u.id }, label: u.name }))))}
  </form>`;
  const page = sheetPage({
    title: i === null ? "New inbox" : cur.name,
    body,
    done: { label: "Save", run: async (pg) => {
      const f = pg.body.querySelector("[data-ib-f]");
      v.name = f.querySelector("[name=name]").value.trim();
      v.ch = f.querySelector("[name=ch]").value;
      if (!v.name) { toast("Give the inbox a name.", { bad: true }); return false; }
      const item = { ...(i === null ? {} : { key: cur.key }), name: v.name, member_ids: [...v.members], match: { ...(v.lc.size ? { lifecycle: [...v.lc] } : {}), ...(v.ch ? { channel: v.ch } : {}) }, notify_ids: cur.notify_ids || [] };
      const next = i === null ? [...list, item] : list.map((x, j) => (j === i ? item : x));
      await saveDoc(ctx, s.doc, { ...s.doc.data, list: next });
      toast("Saved");
      ctx.rerender();
    } },
    events: {
      "click [data-lc]": (e, el) => { const k = el.dataset.lc; if (v.lc.has(k)) v.lc.delete(k); else v.lc.add(k); el.setAttribute("aria-checked", String(v.lc.has(k))); },
      "click [data-member]": (e, el) => { const k = el.dataset.member; if (v.members.has(k)) v.members.delete(k); else v.members.add(k); el.setAttribute("aria-checked", String(v.members.has(k))); },
    },
  });
}

export default {
  title: "Team inboxes",
  async load(params, ctx) {
    ensureStyles();
    const [doc, users] = await Promise.all([loadDoc(ctx, "inboxes"), ctx.api("/users").then((r) => (r.data || []).filter((u) => u.status === "active")).catch(() => [])]);
    return { doc, users };
  },
  action(s, ctx) { return { label: "New inbox", icon: "plus", run: () => editor(ctx, null) }; },
  render(s) {
    const list = s.doc.data.list || [];
    const name = (id) => (s.users.find((u) => u.id === id) || {}).name || "";
    return html`<div class="stack">
      <p class="small muted">Like Rotor's inboxes: a conversation lands in the first inbox whose rule fits it, or wherever someone moves it (a thread's ..., Move to inbox). Each one is a tile in the Inbox with its count.</p>
      ${list.length ? listCard(list.map((x, i) => listRow({ title: x.name, sub: [ruleText(x.match), x.member_ids.map(name).filter(Boolean).join(", ")].filter(Boolean).join(" · "), data: { "ib-open": String(i) }, hold: { "ib-more": String(i) } })), { label: "Team inboxes" })
        : emptyCard({ icon: "inbox", title: "No team inboxes yet", text: "Make one for sales and one for service, so each side sees its own.", action: { label: "New inbox", icon: "plus", data: { "ib-new": true } } })}
    </div>`;
  },
  events: {
    "click [data-ib-new]": (e, el, ctx) => editor(ctx, null),
    "click [data-ib-open]": (e, el, ctx) => editor(ctx, Number(el.dataset.ibOpen)),
    "rs-hold [data-ib-more]": (e, el, ctx) => {
      const i = Number(el.dataset.ibMore);
      const s = ctx.state;
      actionSheet(s.doc.data.list[i].name, [[{ label: "Edit", icon: "edit", run: () => editor(ctx, i) }], [{ label: "Delete inbox", icon: "trash", danger: true, data: { "ib-del": true }, run: async () => {
        try { await saveDoc(ctx, s.doc, { ...s.doc.data, list: s.doc.data.list.filter((_, j) => j !== i) }); toast("Deleted. Its conversations stay in All."); ctx.rerender(); } catch (err) { toast(err.message, { bad: true }); }
      } }]]);
    },
  },
};
