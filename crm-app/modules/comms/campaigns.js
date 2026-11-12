// Campaigns (design §9.2 "Campaigns"): every campaign with its status and
// counts (Rotor's past ones included, as history), and the other bulk sends
// waiting for a test or a confirm (rain-day notices, rebooks).

import { html, icon, sheet, toast } from "../../core/ui.js";
import { dateShort } from "../../core/format.js";
import { field, select, readForm } from "../../core/forms.js";
import { ensureStyles, emptyCard } from "./kit.js";

export const STATUS = { draft: ["Draft", ""], tested: ["Tested", "blue"], scheduled: ["Scheduled", "blue"], sending: ["Sending", "amber"], sent: ["Sent", "green"], cancelled: ["Cancelled", ""] };
export const pill = (st) => html`<span class="${"pill " + ((STATUS[st] || [])[1] || "")}">${(STATUS[st] || [st])[0]}</span>`;

function newSheet(ctx) {
  const sh = sheet({
    title: "New campaign",
    body: html`<form class="form" data-new novalidate>
      ${field({ label: "Name", name: "name", required: true, hint: "For you: customers never see it." })}
      ${select({ label: "Channel", name: "channel", value: "sms", options: [{ value: "sms", label: "Text" }, { value: "email", label: "Email" }] })}
      <button type="submit" class="btn primary block">Create</button>
    </form>`,
    events: {
      "submit [data-new]": async (e, form) => {
        e.preventDefault();
        const v = readForm(form);
        if (!String(v.name || "").trim()) { toast("Give it a name.", { bad: true }); return; }
        try {
          const r = await ctx.api("/campaigns", { method: "POST", body: { name: v.name, channel: v.channel } });
          sh.close();
          ctx.go("/campaigns/" + encodeURIComponent(r.data.id));
        } catch (err) { toast((err && err.message) || "That didn't save.", { bad: true }); }
      },
    },
  });
}

export default {
  async load(params, ctx) {
    ensureStyles();
    const r = await ctx.api("/campaigns", { cache: false });
    return { rows: r.data || [], bulk: (r.meta && r.meta.bulk_runs) || [] };
  },
  action: (s, ctx) => ({ label: "New", run: () => newSheet(ctx) }),
  render(s) {
    const mine = s.rows.filter((c) => !c.imported);
    const rotor = s.rows.filter((c) => c.imported);
    const row = (c) => html`<li><a class="row" href="${"#/campaigns/" + encodeURIComponent(c.id)}">
      <span class="who"><span class="nm">${c.name}</span><span class="sub">${c.channel === "email" ? "Email" : "Text"}${c.recipients ? ` · ${c.recipients} people` : ""}${c.send_at && c.status === "scheduled" ? ` · goes out ${dateShort(c.send_at)}` : c.finished_at ? ` · ${dateShort(c.finished_at)}` : ""}</span></span>
      <span class="end">${pill(c.status)}<span class="chev" aria-hidden="true"></span></span></a></li>`;
    return html`<div class="stack">
      ${s.bulk.length ? html`<div class="section-h">Waiting for a test or a confirm</div><ul class="list">${s.bulk.map((b) => html`<li><a class="row" href="#/approvals"><span class="who"><span class="nm">${b.title}</span><span class="sub">${b.recipients} people · ${b.channel === "email" ? "email" : "text"}</span></span><span class="end"><span class="pill amber">${b.status === "tested" ? "Confirm" : "Test first"}</span><span class="chev" aria-hidden="true"></span></span></a></li>`)}</ul>` : ""}
      ${mine.length ? html`<ul class="list">${mine.map(row)}</ul>` : emptyCard("send", "No campaigns yet", "Tap New to pick who it goes to and what it says. Nothing goes out before a test send and your OK.")}
      ${rotor.length ? html`<div class="section-h">From Rotor (history)</div><ul class="list">${rotor.map(row)}</ul>` : ""}
    </div>`;
  },
  events: {},
};
