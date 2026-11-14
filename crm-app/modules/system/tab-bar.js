// Menu → Tab bar (the Nov 2026 look, Flyra's): each person picks up
// to five places for their phone's tab bar from the main screens (Home,
// Schedule, Inbox, Customers, Sales, Leads, Pipeline, Leaderboard,
// Map, Quotes, Plans, Invoices: only those they may open and whose screen
// is there), in the order they tick them; the Menu always comes last. Saved
// on their own user record (PATCH /users/:id { tabs }, If-Match), so it
// follows them to every phone; "Back to the standard bar" clears it.

import { html, icon, toast, attrs } from "../../core/ui.js";
import { TABS, setTabs, STANDARD as BAR } from "../../core/nav.js";
import { match } from "../../core/router.js";

export const CHOICES = Object.freeze(["home", "schedule", "inbox", "contacts", "sales", "leads", "pipeline", "leaderboard", "map", "quotes", "plans", "invoices"]);
// the standard bar (Flyra's: Home · Schedule · Inbox · Map), the Menu after it
export const STANDARD = Object.freeze(BAR.filter((k) => k !== "menu"));
const MAX = 5;
const LABEL = { leaderboard: "Leaderboard" };
const pathOf = (k) => (TABS[k].paths ? TABS[k].paths[0] : TABS[k].group[0][0]);
// a place whose screen is there and that this person may open
const usable = (k, ctx) => {
  const t = TABS[k];
  const paths = t.paths || t.group.map(([p]) => p);
  return paths.some((p) => { const m = match(p); return !!m && (!m.route.perm || ctx.can(m.route.perm)); });
};

export default {
  title: "Tab bar",
  async load(params, ctx) {
    const me = await ctx.api("/me", { cache: false });
    const u = me.data.user;
    // (a pinned Visits is the Schedule now)
    const mine = Array.isArray(u.tabs) && u.tabs.length ? [...new Set(u.tabs.map((k) => (k === "visits" ? "schedule" : k)))] : STANDARD;
    return { id: u.id, etag: me.data.etag, picked: mine.filter((k) => CHOICES.includes(k) && usable(k, ctx)), choices: CHOICES.filter((k) => usable(k, ctx)), saving: false };
  },
  render(s) {
    const n = s.picked.length;
    return html`<div class="stack tb-page">
      <p class="muted">Pick up to five for the bar at the bottom of your phone, in the order you want them. Menu always comes last.</p>
      <div class="tb-prev" aria-label="Your bar">${s.picked.map((k) => html`<span class="tb-chip">${icon(TABS[k].icon)}<span>${LABEL[k] || TABS[k].label}</span></span>`)}<span class="tb-chip menu">${icon("menu")}<span>Menu</span></span></div>
      <ul class="list">${s.choices.map((k) => {
        const i = s.picked.indexOf(k);
        const on = i >= 0;
        return html`<li><button type="button" class="row tb-row" ${attrs({ "data-pick": k, "aria-pressed": on ? "true" : "false", disabled: !on && n >= MAX ? true : null })}>
          <span class="ico">${icon(TABS[k].icon)}</span><span class="who"><span class="nm">${LABEL[k] || TABS[k].label}</span><span class="sub">${pathOf(k) === "/today" ? "Your first screen" : ""}</span></span>
          <span class="end">${on ? html`<span class="tb-n">${String(i + 1)}</span>` : html`<span class="tb-n off"></span>`}</span></button></li>`;
      })}</ul>
      <p class="small muted">${n >= MAX ? "That's five. Untick one to pick another." : `${n} of ${MAX} picked.`}</p>
      <div class="btn-row"><button type="button" class="btn primary" data-save ${attrs({ disabled: !n || s.saving ? true : null })}>Save my bar</button><button type="button" class="btn" data-standard>Back to the standard bar</button></div>
    </div>`;
  },
  events: {
    "click [data-pick]": (e, el, ctx) => {
      const s = ctx.state;
      const k = el.dataset.pick;
      s.picked = s.picked.includes(k) ? s.picked.filter((x) => x !== k) : s.picked.length < MAX ? [...s.picked, k] : s.picked;
      ctx.rerender();
    },
    "click [data-save]": (e, el, ctx) => save(ctx, ctx.state.picked),
    "click [data-standard]": (e, el, ctx) => save(ctx, null),
  },
};

async function save(ctx, tabs) {
  const s = ctx.state;
  s.saving = true;
  try {
    await ctx.api(`/users/${encodeURIComponent(s.id)}`, { method: "PATCH", body: { tabs }, ifMatch: s.etag });
    // the record's new version, for the next change
    s.etag = (await ctx.api("/me", { cache: false })).data.etag;
    setTabs([...(tabs && tabs.length ? tabs : STANDARD), "menu"]);
    if (!tabs) s.picked = [...STANDARD];
    toast("Your tab bar is saved.");
  } catch (err) {
    toast(err.status === 412 ? "Your account changed on another phone. Try again." : err.message || "That didn't save.", { bad: true });
    if (err.status === 412) ctx.refresh();
  }
  s.saving = false;
  ctx.rerender();
}
