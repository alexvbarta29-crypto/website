// Reviews (Marketing's third tab; the Rotor guide's K6 to K8, S27; Flyra's
// star spread and Add review; design §9.2 "Reviews", §5.7.6): the star
// ratings customers tap on their review page (built, off until the switch:
// Settings → Messages → Reviews), as tiles that ARE the filter (All · Needs
// follow-up · Public · the average), the spread of stars and two-line rows
// (name and stars; job, crew, date and "Google ✓"); a low one is called
// back and marked Followed up. Then the Google reviews the CRM has read,
// which customer each belongs to (a person confirms: names are fuzzy), and
// this week's count per tech. The CRM only reads Google reviews: replies
// and posts are public and stay with a person.

import { html, icon, sheet, toast, attrs, tileRow, tileToggle, listCard, listRow, sectionLabel, pillBtn, actionSheet } from "../../core/ui.js";
import { dateShort, initials } from "../../core/format.js";
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

const STARS = (n) => html`<span class="cm-stars" role="img" ${attrs({ "aria-label": `${n} star${n === 1 ? "" : "s"}` })}>${stars(n)}</span>`;
const who = (s, id) => (s.team.find((u) => u.id === id) || {}).name || "";

function ratingSheet(ctx, x) {
  const s = ctx.state;
  const sh = sheet({
    title: x.name || "A customer",
    body: html`<div class="stack">
      <p>${STARS(x.stars)} <span class="small muted">${dateShort(x.at)}${x.source === "manual" ? " · added by hand" : ""}</span></p>
      <div data-rt-words class="preview">${x.has_comment ? "Loading..." : "No words, just stars."}</div>
      ${(x.crew_ids || []).length ? html`<p class="small muted">Crew: ${x.crew_ids.map((id) => who(s, id)).filter(Boolean).join(", ")}</p>` : ""}
      ${x.public_clicked ? html`<div class="ok-box">They opened the Google link.</div>` : ""}
      ${x.needs_follow_up ? html`<div class="warn-box">A low rating: call them back (the guarantee is a free re-clean), then mark it.</div><button type="button" class="btn primary block" data-fu="${x.id}">${icon("check")}Followed up</button>` : ""}
      ${x.contact_id ? html`<a class="btn block" href="${"#/contacts/" + encodeURIComponent(x.contact_id)}">Open the customer</a>` : ""}
    </div>`,
    events: {
      "click [data-fu]": async (e, el) => {
        el.disabled = true;
        try { await ctx.api(`/ratings/${encodeURIComponent(x.id)}/followed-up`, { method: "POST", body: {} }); toast("Marked followed up"); sh.close(); ctx.refresh(); } catch (err) { el.disabled = false; toast(err.message, { bad: true }); }
      },
      "click a[href^='#/']": () => sh.close(),
    },
  });
  if (x.has_comment) ctx.api(`/ratings/${encodeURIComponent(x.id)}`, { cache: false }).then((r) => { const b = sh.el && sh.el.querySelector("[data-rt-words]"); if (b) b.textContent = r.data.comment || ""; }).catch(() => {});
}

function addSheet(ctx) {
  let picked = null;
  const sh = sheet({
    title: "Add a review",
    body: html`<form class="form" data-add-f novalidate>
      <p class="small muted">One they gave you by phone, a card or in person.</p>
      <button type="button" class="btn block" data-add-pick>${icon("search")}<span data-add-who>Pick the customer</span></button>
      <label class="field"><span>Or their name</span><input type="text" name="name" maxlength="80" autocomplete="off"></label>
      <fieldset class="cm-starpick"><legend>Stars</legend>${[1, 2, 3, 4, 5].map((n) => html`<label><input type="radio" name="stars" ${attrs({ value: String(n), checked: n === 5 })}><span>${n}</span></label>`)}</fieldset>
      <label class="field"><span>Their words</span><textarea name="comment" rows="3" maxlength="1000"></textarea></label>
      <button type="submit" class="btn primary block">Save</button>
    </form>`,
    events: {
      "click [data-add-pick]": async (e, el) => { const c = await pickContact(ctx.api, { title: "Who gave it?" }); if (c && c.id) { picked = c; el.querySelector("[data-add-who]").textContent = c.name || "Picked"; } },
      "submit [data-add-f]": async (e, f) => {
        e.preventDefault();
        const body = { stars: Number((f.querySelector("input[name=stars]:checked") || {}).value || 5), comment: f.querySelector("[name=comment]").value.trim(), ...(picked ? { contact_id: picked.id } : { name: f.querySelector("[name=name]").value.trim() }) };
        try { await ctx.api("/ratings", { method: "POST", body }); toast("Saved"); sh.close(); ctx.refresh(); } catch (err) { toast(err.message, { bad: true }); }
      },
    },
  });
}

function boardSheet(ctx) {
  const s = ctx.state;
  const lb = (s.ratings && s.ratings.leaderboard) || [];
  sheet({
    title: "Review leaderboard",
    body: lb.length ? html`<p class="small muted">Star ratings by crew this month.</p>${listCard(lb.map((x, i) => listRow({ title: `${i + 1}. ${who(s, x.user_id) || "Someone"}`, sub: `${x.count} rating${x.count === 1 ? "" : "s"} · ${x.five} five-star`, pill: { label: `${x.avg} ★`, tone: x.avg >= 4.5 ? "green" : x.avg >= 3.5 ? "amber" : "red" }, initials: initials(who(s, x.user_id)) })), { label: "Review leaderboard" })}`
      : html`<p class="muted">No star ratings this month yet.</p>`,
  });
}

function spread(t, dist) {
  const max = Math.max(1, ...dist);
  return html`<section class="rs-card cm-dist" aria-label="Stars">${[5, 4, 3, 2, 1].map((n) => html`<div class="cm-dist-r"><span class="cm-dist-l">${n} ★</span><span class="cm-dist-b"><i ${attrs({ style: `width:${Math.round((dist[n - 1] / max) * 100)}%` })}></i></span><span class="cm-dist-n num">${String(dist[n - 1])}</span></div>`)}
    <p class="small muted">${t.all ? `${t.five_pct}% five-star · ${t.all} rating${t.all === 1 ? "" : "s"}` : "No star ratings yet."}</p></section>`;
}

export default {
  title: "Reviews",
  async load(params, ctx) {
    ensureStyles();
    const tile = ctx.keep.tile || "all";
    const f = tile === "all" ? "" : `?f=${tile}`;
    const [r, team, rt] = await Promise.all([ctx.api("/reviews", { cache: false }), ctx.api("/users", { cache: false }).catch(() => ({ data: [] })), ctx.api(`/ratings${f}`, { cache: false }).catch(() => null)]);
    return { rows: r.data || [], meta: r.meta || {}, team: team.data || [], ratings: rt ? rt.data : null, rmeta: rt ? rt.meta || {} : {}, tile, office: ctx.can("reviews:match") };
  },
  render(s) {
    const per = s.meta.per_tech_week || {};
    const techs = s.team.filter((u) => u.is_technician || per[u.id]);
    const todo = s.rows.filter((x) => !x.matched);
    const rt = s.ratings;
    const t = (rt && rt.tiles) || {};
    return html`<div class="stack cm-reviews">
      ${rt ? html`
        ${tileRow([{ key: "all", label: "All", value: t.all }, { key: "needs_follow_up", label: "Needs follow-up", value: t.needs_follow_up, tone: t.needs_follow_up ? "red" : null }, { key: "public", label: "Public", value: t.public }, { key: "avg", label: "Avg ★", value: t.avg === null || t.avg === undefined ? "-" : String(t.avg), info: true }], { name: "rv", on: s.tile, label: "Star ratings" })}
        ${s.rmeta.ratings_on ? "" : html`<div class="note">Star ratings are built and off until the switch: the review texts still link Google. Turn them on in Settings.</div>`}
        ${s.office ? html`<div class="rs-pills cm-rv-acts">${pillBtn("Add a review", { icon: "plus", data: { "rv-add": true } })}${pillBtn("Leaderboard", { icon: "trophy", data: { "rv-board": true } })}${pillBtn("Settings", { icon: "gear", href: "#/settings/reviews" })}</div>` : ""}
        ${s.tile === "all" ? spread(t, rt.dist || [0, 0, 0, 0, 0]) : ""}
        ${listCard(rt.rows.map((x) => listRow({
          title: x.name || "A customer", amount: null, sub: [dateShort(x.at), (x.crew_ids || []).map((id) => initials(who(s, id))).filter(Boolean).join(" "), x.source === "manual" ? "by hand" : ""].filter(Boolean).join(" · "),
          pill: x.needs_follow_up ? { label: "Call back", tone: "red" } : x.public_clicked ? { label: "Google ✓", tone: "green" } : null,
          tag: stars(x.stars), data: { rating: x.id }, edge: x.needs_follow_up ? "red" : null,
        })), { label: "Star ratings", empty: s.tile === "all" ? "No star ratings yet. They come from the review page once ratings are on." : "Nothing here." })}
      ` : ""}
      ${sectionLabel("Google reviews")}
      ${s.meta.mode !== "live" ? html`<div class="note">Google reviews aren't being read here yet. An owner switches that on under Settings → Integrations (Reviews: live). The CRM only reads reviews; it never replies or posts.</div>` : ""}
      ${techs.length ? html`<section class="card stack"><h2>This week</h2><div class="cm-stat">${techs.slice(0, 6).map((u) => html`<div><b>${per[u.id] || 0}</b><span>${u.first_name || u.name} (goal ${s.meta.goal_per_tech_week || 2})</span></div>`)}</div></section>` : ""}
      ${todo.length ? html`<div class="section-h">To match</div>` : ""}
      ${s.rows.length ? html`<ul class="list">${s.rows.map((x) => html`<li><button type="button" class="row" data-review="${x.id}">
        <span class="who"><span class="nm">${x.reviewer_name || "A Google user"}</span><span class="sub"><span class="cm-stars">${stars(x.rating)}</span> ${dateShort(x.created_at_gbp)}</span></span>
        <span class="end">${x.matched ? html`<span class="pill green">Matched</span>` : x.suggestions ? html`<span class="pill amber">${x.suggestions} to check</span>` : html`<span class="pill">No match</span>`}<span class="chev" aria-hidden="true"></span></span></button></li>`)}</ul>`
        : emptyCard("check", "No reviews read yet", "New Google reviews show up here within the hour once reading them is switched on.")}
    </div>`;
  },
  events: {
    "click [data-review]": (e, el, ctx) => open(ctx, el.dataset.review),
    "click [data-tile=rv]": (e, el, ctx) => { ctx.keep.tile = tileToggle(ctx.state.tile, el.dataset.key, "all"); ctx.refresh(); },
    "click [data-rating]": (e, el, ctx) => { const x = ctx.state.ratings.rows.find((r) => r.id === el.dataset.rating); if (x) ratingSheet(ctx, x); },
    "click [data-rv-add]": (e, el, ctx) => addSheet(ctx),
    "click [data-rv-board]": (e, el, ctx) => boardSheet(ctx),
  },
};
