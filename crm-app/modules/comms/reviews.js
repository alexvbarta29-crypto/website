// Reviews (design §9.2 "Reviews", §5.7.6): the Google reviews the CRM has
// read, which customer each belongs to (a person confirms: names are
// fuzzy), and this week's count per tech. The CRM only reads reviews:
// replies and posts are public and stay with a person.

import { html, icon, sheet, toast } from "../../core/ui.js";
import { dateShort } from "../../core/format.js";
import { pickContact } from "../../core/pickers.js";
import { ensureStyles, stars, emptyCard } from "./kit.js";

async function open(ctx, id) {
  const r = (await ctx.api(`/reviews/${encodeURIComponent(id)}`, { cache: false })).data;
  const match = async (body) => {
    try {
      await ctx.api(`/reviews/${encodeURIComponent(id)}/match`, { method: "POST", body });
      toast("Matched. Their review requests stop.");
      sh.close();
      ctx.refresh();
    } catch (e) { toast((e && e.message) || "That didn't save.", { bad: true }); }
  };
  const sh = sheet({
    title: r.reviewer_name || "A Google review",
    body: html`<div class="stack">
      <p><span class="cm-stars" role="img" aria-label="${r.rating + " stars"}">${stars(r.rating)}</span> <span class="small muted">${dateShort(r.created_at_gbp)}</span></p>
      ${r.comment_excerpt ? html`<div class="preview">${r.comment_excerpt}</div>` : html`<p class="muted small">No words, just stars.</p>`}
      ${r.match ? html`<div class="ok-box">Matched to ${r.match.name || "a customer"}.</div><a class="btn block" href="${"#/contacts/" + encodeURIComponent(r.match.contact_id)}">Open the customer</a>`
        : html`<div class="section-h">Who wrote it?</div>
          ${(r.suggestions || []).length ? html`<ul class="list">${r.suggestions.map((x) => html`<li><button type="button" class="row" data-sug="${x.contact_id}" data-job="${x.job_id || ""}"><span class="who"><span class="nm">${x.name || "A customer"}</span><span class="sub">Job done ${x.on ? dateShort(x.on) : ""}${x.score >= 1 ? " · same name" : " · same first name"}</span></span><span class="chev" aria-hidden="true"></span></button></li>`)}</ul>` : html`<p class="muted small">No recent job fits this name.</p>`}
          <button type="button" class="btn block" data-other>${icon("search")}Pick someone else</button>`}
    </div>`,
    events: {
      "click [data-sug]": (e, el) => match({ contact_id: el.dataset.sug, ...(el.dataset.job ? { job_id: el.dataset.job } : {}) }),
      "click [data-other]": async () => { const c = await pickContact(ctx.api, { title: "Who wrote it?" }); if (c && c.id) match({ contact_id: c.id }); },
    },
  });
}

export default {
  async load(params, ctx) {
    ensureStyles();
    const [r, team] = await Promise.all([ctx.api("/reviews", { cache: false }), ctx.api("/users", { cache: false }).catch(() => ({ data: [] }))]);
    return { rows: r.data || [], meta: r.meta || {}, team: team.data || [] };
  },
  render(s) {
    const per = s.meta.per_tech_week || {};
    const techs = s.team.filter((u) => u.is_technician || per[u.id]);
    const todo = s.rows.filter((x) => !x.matched);
    return html`<div class="stack">
      ${s.meta.mode !== "live" ? html`<div class="note">Google reviews aren't being read here yet. An owner switches that on under Settings → Integrations (Reviews: live). The CRM only reads reviews; it never replies or posts.</div>` : ""}
      ${techs.length ? html`<section class="card stack"><h2>This week</h2><div class="cm-stat">${techs.slice(0, 6).map((u) => html`<div><b>${per[u.id] || 0}</b><span>${u.first_name || u.name} (goal ${s.meta.goal_per_tech_week || 2})</span></div>`)}</div></section>` : ""}
      ${todo.length ? html`<div class="section-h">To match</div>` : ""}
      ${s.rows.length ? html`<ul class="list">${s.rows.map((x) => html`<li><button type="button" class="row" data-review="${x.id}">
        <span class="who"><span class="nm">${x.reviewer_name || "A Google user"}</span><span class="sub"><span class="cm-stars">${stars(x.rating)}</span> ${dateShort(x.created_at_gbp)}</span></span>
        <span class="end">${x.matched ? html`<span class="pill green">Matched</span>` : x.suggestions ? html`<span class="pill amber">${x.suggestions} to check</span>` : html`<span class="pill">No match</span>`}<span class="chev" aria-hidden="true"></span></span></button></li>`)}</ul>`
        : emptyCard("check", "No reviews read yet", "New Google reviews show up here within the hour once reading them is switched on.")}
    </div>`;
  },
  events: { "click [data-review]": (e, el, ctx) => open(ctx, el.dataset.review) },
};
