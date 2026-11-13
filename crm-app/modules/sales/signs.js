// Signs & flyers (Menu → Sales; signs:manage): every QR code on a yard
// sign, door hanger, flyer or the truck, with what it brought in: scans,
// leads, booked and paid. Tap one for its code to print, its numbers and its
// leads; New makes one. Retired codes keep working (a sign may still be
// out there) and sit under Retired.

import { html, attrs, icon } from "../../core/ui.js";
import { dateShort, ago } from "../../core/format.js";
import { ensureStyles, emptyCard } from "./kit.js";
import { kindLabel, numbers } from "./signs-kit.js";

async function load(params, ctx) {
  ensureStyles();
  const tab = ctx.keep.tab === "retired" ? "retired" : "active";
  const r = await ctx.api(`/qr-codes${tab === "retired" ? "?archived=1" : ""}`, { cache: false });
  return { tab, codes: r.data || [], meta: r.meta || {} };
}

const sub = (c) => [kindLabel(c.kind), c.area, c.placed_on ? `placed ${dateShort(c.placed_on)}` : null].filter(Boolean).join(" · ");

export default {
  title: "Signs & flyers",
  load,
  action: (s, ctx) => ({ label: "New", run: () => ctx.go("/signs/new") }),
  render(s) {
    const t = s.meta.totals || { scans: 0, leads: 0, booked: 0, revenue_cents: 0 };
    const retired = s.tab === "retired";
    return html`<div class="stack">
      ${!retired && s.codes.length ? html`<section class="card sg-total"><h2>All your codes</h2>${numbers(t, { big: true })}</section>` : ""}
      <div class="chips" role="tablist">
        <button type="button" class="chip" role="tab" ${attrs({ "data-tab": "active", "aria-pressed": String(!retired) })}>In use${!retired ? html` <span class="n">${s.codes.length}</span>` : ""}</button>
        <button type="button" class="chip" role="tab" ${attrs({ "data-tab": "retired", "aria-pressed": String(retired) })}>Retired <span class="n">${retired ? s.codes.length : s.meta.archived_count || 0}</span></button>
      </div>
      ${s.codes.length ? html`<ul class="list sg-list">${s.codes.map((c) => html`<li><a class="row sg-row" href="${"#/signs/" + encodeURIComponent(c.id)}">
        <span class="who"><span class="nm">${c.name}</span><span class="sub">${sub(c)}</span>${numbers(c)}<span class="sub">${c.last_scan_at ? `Last scan ${ago(c.last_scan_at)}` : "No scans yet"}</span></span>
        <span class="chev" aria-hidden="true"></span></a></li>`)}</ul>`
        : retired ? emptyCard("Nothing retired", "Codes you retire land here. They keep working for anyone who still scans one.", "grid")
          : html`${emptyCard("No codes yet", "Make one for each yard sign, door hanger or flyer. Every scan is counted, and the leads it brings in show up here with what they booked and paid.", "grid")}
            <a class="btn primary block" href="#/signs/new">${icon("plus")}New code</a>`}
      <p class="foot-note">A lead counts for a code when they scan it and then send the quote form within 30 days, once the website's leads go to the CRM (Settings → Intake mode). Booked and paid come from the CRM's own records.</p>
    </div>`;
  },
  events: {
    "click [data-tab]": (e, el, ctx) => { ctx.keep.tab = el.dataset.tab; ctx.refresh(); },
  },
};
