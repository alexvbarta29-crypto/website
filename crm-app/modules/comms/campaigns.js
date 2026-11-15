// Campaigns (Marketing's second tab; the Rotor guide's K4, K5, K18; design
// §9.2 "Campaigns"): Rotor's stat tiles over the year's campaigns (sent,
// response, job revenue, attributed ARR, open, click, bounce: open and
// click show "-" until email tracking is connected), then every campaign as
// a two-line row (Rotor's past ones as history), and the other bulk sends
// waiting for a test or a confirm (rain-day notices, rebooks). New: a
// campaign from a template, or a text blast (Flyra's: your own words, a CSV,
// the cost, a follow-up to who didn't reply).

import { html, icon, sheet, toast, tileRow, listCard, listRow, sectionLabel, pillBtn } from "../../core/ui.js";
import { dateShort, money } from "../../core/format.js";
import { field, select, readForm } from "../../core/forms.js";
import { ensureStyles, emptyCard } from "./kit.js";

export const STATUS = { draft: ["Draft", ""], tested: ["Tested", "blue"], scheduled: ["Scheduled", "blue"], sending: ["Sending", "amber"], sent: ["Sent", "green"], cancelled: ["Cancelled", ""] };
export const pill = (st) => html`<span class="${"pill " + ((STATUS[st] || [])[1] || "")}">${(STATUS[st] || [st])[0]}</span>`;

function newSheet(ctx) {
  const sh = sheet({
    title: "New campaign",
    body: html`<form class="form" data-new novalidate>
      ${field({ label: "Name", name: "name", required: true, hint: "For you: customers never see it." })}
      ${select({ label: "Kind", name: "channel", value: "blast", options: [{ value: "blast", label: "Text blast (your own words)" }, { value: "sms", label: "Text from a template" }, { value: "email", label: "Email from a template" }] })}
      <button type="submit" class="btn primary block">Create</button>
    </form>`,
    events: {
      "submit [data-new]": async (e, form) => {
        e.preventDefault();
        const v = readForm(form);
        if (!String(v.name || "").trim()) { toast("Give it a name.", { bad: true }); return; }
        try {
          const r = await ctx.api("/campaigns", { method: "POST", body: v.channel === "blast" ? { name: v.name, kind: "blast", channel: "sms" } : { name: v.name, channel: v.channel } });
          sh.close();
          ctx.go("/campaigns/" + encodeURIComponent(r.data.id));
        } catch (err) { toast((err && err.message) || "That didn't save.", { bad: true }); }
      },
    },
  });
}

const pct = (n) => (n === null || n === undefined ? "-" : `${n}%`);
export function statTiles(t = {}) {
  const split = t.revenue_by_channel || {};
  return [
    { key: "sent", label: "Sent", value: t.sent ?? "-", info: true },
    { key: "resp", label: "Response", value: pct(t.response_pct), info: true },
    { key: "rev", label: "Job revenue", value: money(t.job_revenue_cents || 0).replace(/\.00$/, ""), money: split.email ? `Texts ${money(split.sms || 0).replace(/\.00$/, "")} · Email ${money(split.email).replace(/\.00$/, "")}` : null, info: true },
    { key: "arr", label: "Attributed ARR", value: money(t.arr_cents || 0).replace(/\.00$/, ""), info: true },
    { key: "open", label: "Open", value: pct(t.open_pct), info: true },
    { key: "click", label: "Click", value: pct(t.click_pct), info: true },
    { key: "bounce", label: "Bounce", value: pct(t.bounce_pct), info: true },
  ];
}

export default {
  title: "Campaigns",
  async load(params, ctx) {
    ensureStyles();
    const [r, st] = await Promise.all([ctx.api("/campaigns", { cache: false }), ctx.api("/campaigns/stats", { cache: false }).catch(() => null)]);
    return { rows: r.data || [], bulk: (r.meta && r.meta.bulk_runs) || [], stats: st ? st.data : null };
  },
  action: (s, ctx) => ({ label: "New campaign", run: () => newSheet(ctx) }),
  render(s) {
    const mine = s.rows.filter((c) => !c.imported);
    const rotor = s.rows.filter((c) => c.imported);
    const per = (s.stats && s.stats.per) || {};
    const row = (c) => {
      const st = per[c.id];
      return listRow({
        title: c.name, href: "#/campaigns/" + encodeURIComponent(c.id),
        sub: [c.send_at && c.status === "scheduled" ? `goes out ${dateShort(c.send_at)}` : c.finished_at ? dateShort(c.finished_at) : dateShort(c.created_at), c.channel === "email" ? "Email" : "Text", c.recipients ? `${c.recipients} people` : "", st && st.response_pct !== null ? `${st.response_pct}% replied` : ""].filter(Boolean).join(" · "),
        pill: { label: (STATUS[c.status] || [c.status])[0], tone: ({ draft: "grey", tested: "blue", scheduled: "blue", sending: "amber", sent: "green", cancelled: "grey" })[c.status] || "grey" },
      });
    };
    return html`<div class="stack">
      ${tileRow(statTiles((s.stats && s.stats.totals) || {}), { name: "cm", label: "This year's campaigns" })}
      <div class="rs-pills">${pillBtn("New text blast", { icon: "send", href: "#/campaigns/new?kind=blast", tone: "solid" })}</div>
      ${s.bulk.length ? html`<div class="section-h">Waiting for a test or a confirm</div><ul class="list">${s.bulk.map((b) => html`<li><a class="row" href="#/approvals"><span class="who"><span class="nm">${b.title}</span><span class="sub">${b.recipients} people · ${b.channel === "email" ? "email" : "text"}</span></span><span class="end"><span class="pill amber">${b.status === "tested" ? "Confirm" : "Test first"}</span><span class="chev" aria-hidden="true"></span></span></a></li>`)}</ul>` : ""}
      ${mine.length ? listCard(mine.map(row), { label: "Campaigns" }) : emptyCard("send", "No campaigns yet", "Tap + to pick who it goes to and what it says. Nothing goes out before a test send and your OK.")}
      ${rotor.length ? html`${sectionLabel("From Rotor (history)")}${listCard(rotor.map(row), { label: "From Rotor" })}` : ""}
    </div>`;
  },
  events: {},
};
