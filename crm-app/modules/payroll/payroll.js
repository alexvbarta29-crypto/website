// Payroll (design §9.2 "Payroll", §5.8): this week's pay at a glance (each
// person's total so far), the crew scoreboard, and every pay period with its
// status. A period opens its pay sheets (#/payroll/:id). The CRM works pay
// out from approved time, finished jobs and tips; it never moves money.

import { html, attrs, toast } from "../../core/ui.js";
import { ensureStyles, statusPill, span, dollars, hrs } from "./kit.js";
import { boardTable } from "./board.js";

async function load(params, ctx) {
  ensureStyles();
  const list = (await ctx.api("/payroll/periods", { cache: false })).data;
  const [cur, board] = await Promise.all([
    list.current_id ? ctx.api(`/payroll/periods/${list.current_id}`, { cache: false }).then((r) => r.data).catch(() => null) : Promise.resolve(null),
    ctx.api(`/payroll/scoreboard?from=${list.current_start}&to=${list.today}`, { cache: false }).then((r) => r.data).catch(() => null),
  ]);
  return { ...list, cur, board, run: ctx.can("payroll:run") };
}

export default {
  load,
  render(s) {
    const c = s.cur;
    const total = c ? Object.values(c.totals || {}).reduce((a, t) => a + (t.total_cents || 0), 0) : 0;
    const toLock = (s.periods || []).filter((p) => p.status === "open" && p.end_on < s.today);
    return html`<div class="stack py-page">
      ${c ? html`<a class="card py-hero" ${attrs({ href: `#/payroll/${c.period.id}`, "data-current": "" })}>
          <span class="k">This week · ${span(c.period.start_on, c.period.end_on)}</span>
          <span class="big">${dollars(total)}</span>
          <span class="meta">${statusPill(c.period.status)}<span>so far, ${(c.people || []).length} ${(c.people || []).length === 1 ? "person" : "people"}</span></span>
          <ul class="py-lines">${(c.people || []).map((p) => { const t = c.totals[p.id] || {}; return html`<li class="py-line"><span class="who"><span class="nm">${p.name}</span><span class="sub">${hrs(t.regular_hours)}${t.ot_hours ? ` + ${hrs(t.ot_hours)} overtime` : ""}${t.tips_cents ? ` · ${dollars(t.tips_cents)} tips` : ""}</span></span><span class="end"><b class="num">${dollars(t.total_cents)}</b></span></li>`; })}</ul>
        </a>`
        : html`<section class="card"><h2>This week</h2><p>No pay period for this week yet. It starts by itself overnight, or now:</p>${s.run ? html`<div class="py-acts"><button type="button" class="btn primary" ${attrs({ "data-start": s.current_start })}>Start this week's pay period</button></div>` : ""}</section>`}
      ${toLock.length && s.run ? html`<p class="py-warn">${toLock.length === 1 ? "One pay period is over and still open." : `${toLock.length} pay periods are over and still open.`} Check it and lock it to make the pay final.</p>` : ""}
      ${boardTable(s.board, { title: "Crew scoreboard this week" })}
      <div class="section-h">Pay periods</div>
      ${(s.periods || []).length ? html`<ul class="list">${s.periods.map((p) => html`<li><a class="row" ${attrs({ href: `#/payroll/${p.id}` })}>
        <span class="who"><span class="nm">${span(p.start_on, p.end_on)}${p.imported ? " (Rotor)" : ""}</span><span class="sub">${p.people ? `${p.people} ${p.people === 1 ? "person" : "people"} · ${p.hours || 0} h` : "Not worked out yet"}</span></span>
        <span class="end">${statusPill(p.status)}<b class="num">${dollars(p.total_cents)}</b></span><span class="chev" aria-hidden="true"></span></a></li>`)}</ul>`
        : html`<div class="card empty"><h2>No pay periods yet</h2><p>Each Sunday-to-Saturday week gets one.</p></div>`}
    </div>`;
  },
  events: {
    "click [data-start]": async (e, el, ctx) => {
      el.disabled = true;
      try {
        const r = await ctx.api("/payroll/periods", { method: "POST", body: { start_on: el.dataset.start } });
        ctx.go(`/payroll/${r.data.period.id}`);
      } catch (err) { el.disabled = false; toast(err.message || "That didn't work.", { bad: true }); }
    },
  },
};
