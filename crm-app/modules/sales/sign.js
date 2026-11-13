// One sign or flyer code (Signs & flyers): the QR code to print (an 18 × 24
// yard sign or a quarter-page flyer, as a picture or SVG, with its name and
// short address under it), where it sends people, its scans by day and by
// phone, and its leads with what they booked and paid. Edit, Retire.

import { html, raw, attrs, icon, toast, confirmSheet, sheet } from "../../core/ui.js";
import { readForm, clearErrors, showError, busy } from "../../core/forms.js";
import { money, dateShort, dateTime } from "../../core/format.js";
import { qrSvg } from "../../core/qr.js";
import { ensureStyles, copyText } from "./kit.js";
import { kindLabel, numbers, pageLabel, PRINTS, savePrint } from "./signs-kit.js";
import { formBody, readCode } from "./sign-form.js";

async function load(params, ctx) {
  ensureStyles();
  const r = await ctx.api(`/qr-codes/${encodeURIComponent(params.id)}`, { cache: false });
  return { ...r.data, etag: r.etag };
}

function days(s) {
  const list = s.stats.days || [];
  const max = Math.max(1, ...list.map((d) => d.n));
  const total = list.reduce((a, d) => a + d.n, 0);
  return html`<div class="sg-days" role="img" ${attrs({ "aria-label": `${total} scans in the last 30 days` })}>${list.map((d) => html`<span class="${d.n ? "on" : ""}" ${attrs({ style: `height:${Math.max(4, Math.round((d.n / max) * 100))}%`, title: `${dateShort(d.date)}: ${d.n}` })}></span>`)}</div>
    <div class="sg-days-axis"><span>${dateShort(list[0] && list[0].date)}</span><span>Today</span></div>
    <table class="sg-sr"><caption>Scans a day</caption>${list.filter((d) => d.n).map((d) => html`<tr><th>${dateShort(d.date)}</th><td>${d.n}</td></tr>`)}</table>`;
}

const dev = (d = {}) => [["iPhone", d.ios], ["Android", d.android], ["Other", d.other]].filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(" · ") || "None yet";

export default {
  title: (s) => (s && s.code ? s.code.name : "Code"),
  load,
  render(s) {
    const c = s.code;
    return html`<div class="stack">
      <section class="card sg-head">
        <div class="top-line"><h2>${c.name}</h2>${c.archived ? html`<span class="pill">Retired</span>` : ""}</div>
        <p class="sub">${[kindLabel(c.kind), c.area, c.placed_on ? `placed ${dateShort(c.placed_on)}` : null].filter(Boolean).join(" · ")}</p>
        <p class="small muted">Leads from it show as <b>${c.lead_label}</b>.</p>
      </section>
      <section class="card sg-code">
        <div class="sg-qr">${raw(qrSvg(c.url, { ecl: "Q", label: `QR code for ${c.name}` }))}</div>
        <p class="sg-short">${c.short}</p>
        <p class="small muted">${c.dest && c.dest.kind === "page" ? `Sends people to ${pageLabel(c.dest_path)} (${c.dest_path}).` : "Sends people to the quote page, with the code as the lead's source."}</p>
        <div class="btn-row"><button type="button" class="btn" data-copy>${icon("copy")}Copy the link</button></div>
      </section>
      <section class="card"><h2>Print it</h2>
        <p class="small muted">The code big, with its name and short address under it. Print the picture or hand the SVG to the print shop.</p>
        ${Object.entries(PRINTS).map(([k, p]) => html`<div class="sg-print"><span>${p.label}</span><span class="btn-row">
          <button type="button" class="btn" ${attrs({ "data-print": k, "data-kind": "png" })}>Picture (PNG)</button><button type="button" class="btn" ${attrs({ "data-print": k, "data-kind": "svg" })}>SVG</button></span></div>`)}
      </section>
      <section class="card"><h2>What it brought in</h2>${numbers(c, { big: true })}
        <h3 class="sg-h3">Scans, the last 30 days</h3>${days(s)}
        <dl class="kv sg-kv"><dt>Phones</dt><dd>${dev(s.stats.dev)}</dd>
          <dt>First scan</dt><dd>${s.stats.first_at ? dateTime(s.stats.first_at) : "Not yet"}</dd>
          ${s.stats.last_at ? html`<dt>Last scan</dt><dd>${dateTime(s.stats.last_at)}</dd>` : ""}</dl>
      </section>
      <div class="section-h">Leads from this code</div>
      ${s.leads.length ? html`<ul class="list">${s.leads.map((l) => html`<li><a class="row" href="${"#/contacts/" + encodeURIComponent(l.contact_id)}">
        <span class="who"><span class="nm">${l.name}</span><span class="sub">${[l.town, `came in ${dateShort(l.at)}`].filter(Boolean).join(" · ")}</span></span>
        <span class="end">${l.paid_cents ? html`<span class="num">${money(l.paid_cents)}</span>` : ""}${l.booked ? html`<span class="pill green">Booked</span>` : html`<span class="pill">Lead</span>`}<span class="chev" aria-hidden="true"></span></span></a></li>`)}</ul>`
        : html`<div class="card"><p class="muted">No leads yet. A lead counts when someone scans this code and then sends the quote form.</p></div>`}
      <div class="btn-row">
        <button type="button" class="btn" data-edit>${icon("doc")}Edit</button>
        <button type="button" class="btn" data-archive>${c.archived ? "Use it again" : "Retire it"}</button>
      </div>
    </div>`;
  },
  events: {
    "click [data-copy]": async (e, el, ctx) => { toast((await copyText(ctx.state.code.url)) ? "Link copied" : ctx.state.code.url); },
    "click [data-print]": async (e, el, ctx) => {
      busy(el, true);
      try { const how = await savePrint(ctx.state.code, el.dataset.print, el.dataset.kind); if (how !== "cancelled") toast(how === "shared" ? "Shared" : "Saved"); } catch (err) { toast(err.message || "That picture couldn't be made.", { bad: true }); }
      busy(el, false);
    },
    "click [data-archive]": async (e, el, ctx) => {
      const c = ctx.state.code;
      if (!c.archived && !(await confirmSheet("Retire this code? It leaves the list, but anyone who scans it still gets to the website (and it still counts).", { title: "Retire it", yes: "Retire" }))) return;
      try { await ctx.api(`/qr-codes/${encodeURIComponent(c.id)}/${c.archived ? "restore" : "archive"}`, { method: "POST", body: {} }); toast(c.archived ? "Back in use" : "Retired"); } catch (err) { toast(err.message, { bad: true }); }
      ctx.refresh();
    },
    "click [data-edit]": (e, el, ctx) => {
      const sh = sheet({
        title: "Edit the code",
        body: formBody(ctx.state.code, { isNew: false, note: ctx.state.note }),
        events: {
          "change [name=dest_kind]": (ev, input) => { input.closest("form").querySelector("[data-path]").hidden = input.value !== "page"; },
          "submit form": async (ev, form) => {
            ev.preventDefault(); clearErrors(form);
            const body = readCode(readForm(form));
            if (!body.name) { showError(form, { field: "name", message: "Give it a name you'll know it by." }); return; }
            const btn = form.querySelector("[type=submit]"); busy(btn, true);
            try {
              await ctx.api(`/qr-codes/${encodeURIComponent(ctx.state.code.id)}`, { method: "PATCH", body, ifMatch: ctx.state.etag });
              sh.close(); toast("Saved"); ctx.refresh();
            } catch (err) {
              busy(btn, false);
              if (err.status === 412) { sh.close(); toast("Someone else just changed this code. Showing the latest.", { bad: true }); ctx.refresh(); } else showError(form, err);
            }
          },
        },
      });
    },
  },
};
