// Today (design §9.2, §9.3): the date, a greeting, the bell (unread
// notifications), the Approvals card (bulk sends and owner decisions
// waiting), alerts from the workers for owners and the office, the
// modules' cards (todayCards: calls due, leads that need attention...), and
// quick links. The modules fill the rest as they land: Needs attention (M2+),
// My visits with Clock in/out (M4b), Today's visits by tech (M4a), the
// Money strip (M5). A tech sees their own day only (the work module's card;
// "No visits today" only when no card has anything to show).

import { html, icon, delegate } from "../../core/ui.js";
import { dateLong, plural, dateTime } from "../../core/format.js";
import * as router from "../../core/router.js";
import { MANIFESTS } from "../index.js";

// The modules' Today cards (manifest todayCards: { key, perm, order, load }):
// each loads its own small summary (load(ctx) → state) and renders it
// (render(state, cardCtx) → html``); one that fails is left out. A card may
// also have events ({ "click [data-x]": (event, el, cardCtx) => ... },
// delegated inside the card) and mount(el, state, cardCtx); cardCtx.state
// is the card's own state, and cardCtx.rerender() / refresh() redraw Today.
async function moduleCards(ctx) {
  const defs = MANIFESTS.flatMap((m) => m.todayCards || []).filter((c) => c && typeof c.load === "function" && (!c.perm || ctx.can(c.perm))).sort((a, b) => (a.order || 50) - (b.order || 50));
  const out = await Promise.all(defs.map(async (c) => {
    try { const mod = (await c.load()).default; return { key: c.key, mod, state: mod.load ? await mod.load(ctx) : {} }; } catch (e) { return null; }
  }));
  return out.filter(Boolean);
}
const cardCtx = (c, ctx) => ({ ...ctx, get state() { return c.state; }, set state(v) { c.state = v; }, rerender: () => ctx.rerender && ctx.rerender(), refresh: () => ctx.refresh() });

const greeting = (d) => {
  const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", hourCycle: "h23" }).format(d));
  return h < 12 ? "Morning" : h < 17 ? "Afternoon" : "Evening";
};

export default {
  title: "Today",
  async load(params, ctx) {
    const [badges, health, cards] = await Promise.all([
      ctx.api("/me/badges", { cache: false }).then((r) => r.data).catch(() => null),
      ctx.can("audit:read") ? ctx.api("/admin/health", { cache: false }).then((r) => r.data).catch(() => null) : null,
      moduleCards(ctx),
    ]);
    return { now: new Date(), user: ctx.user || {}, badges, health, cards };
  },
  render(s, ctx) {
    const tech = s.user.role === "tech";
    const b = s.badges || {};
    const alerts = (s.health && s.health.alerts) || [];
    const stuck = s.health && s.health.status && (s.health.status.fast === "stuck" || s.health.status.bulk === "stuck");
    const mode = (s.health && s.health.mode) || {};
    // the modules' cards; one with something to show replaces "Nothing needs you"
    const drawn = (s.cards || []).map((c) => { try { return { c, out: c.mod.render(c.state, cardCtx(c, ctx)) }; } catch (e) { return { c, out: "" }; } });
    const cards = drawn.map(({ c, out }) => (String(out || "").trim() === "" ? "" : html`<div class="today-card" style="display:contents" data-card="${c.key || ""}">${out}</div>`));
    const busy = cards.some((c) => String(c || "").trim() !== "");
    const links = [
      ctx.can("contacts:read_all") && router.has("/contacts") ? html`<a class="tile" href="#/contacts">${icon("contacts")}<span>Contacts</span></a>`
        : ctx.can("contacts:read_all") && router.has("/legacy/customers") ? html`<a class="tile" href="#/legacy/customers">${icon("contacts")}<span>Customers</span></a>` : "",
      ctx.can("outbox:read") ? html`<a class="tile" href="#/outbox">${icon("send")}<span>Outbox</span></a>` : "",
      ctx.can("automations:configure") ? html`<a class="tile" href="#/automations">${icon("bolt")}<span>Automations</span></a>` : "",
      ctx.can("users:manage") ? html`<a class="tile" href="#/team">${icon("team")}<span>Team</span></a>` : "",
      ctx.can("settings:general") ? html`<a class="tile" href="#/settings">${icon("gear")}<span>Settings</span></a>` : "",
      tech ? "" : html`<a class="tile" href="#/me">${icon("me")}<span>My account</span></a>`,
    ].filter(Boolean);
    return html`<div class="stack">
      <div class="row" style="padding:0;min-height:0;align-items:flex-start">
        <div class="hello who"><div class="date">${dateLong(s.now)}</div><h2>${greeting(s.now)}, ${s.user.first_name || s.user.name || "there"}</h2></div>
        <a class="icon-btn bell" href="#/notifications" aria-label="${b.notifications ? `Notifications, ${b.notifications} new` : "Notifications"}">${icon("bell")}${b.notifications ? html`<span class="badge">${b.notifications > 99 ? "99+" : b.notifications}</span>` : ""}</a>
      </div>
      ${mode.paused ? html`<a class="card alert" href="#/settings/data" style="display:block;text-decoration:none;color:inherit"><h2>The CRM is paused</h2><p>${mode.paused_reason === "restore" ? "A backup was restored. " : ""}Nothing is texted, emailed, charged or automated${mode.paused_at ? ` since ${dateTime(mode.paused_at)}` : ""}. An owner resumes it on Settings → Data.</p></a>` : ""}
      ${stuck || alerts.length ? html`<a class="card alert" href="#/settings/data" style="display:block;text-decoration:none;color:inherit"><h2>Needs a look</h2>${stuck ? html`<p>A worker hasn't finished a pass in 3 hours.</p>` : ""}${alerts.slice(0, 3).map((a) => html`<p>${a.text}</p>`)}</a>` : ""}
      ${b.approvals && ctx.can("campaigns:send") ? html`<a class="tile" href="#/approvals">${icon("check")}<span>${plural(b.approvals, "approval")} waiting</span><span class="n">${b.approvals}</span></a>` : ""}
      ${cards}
      ${busy ? "" : tech
        ? html`<div class="card empty"><div class="art">${icon("today")}</div><h2>No visits today</h2><p>Your visits show up here, in route order, once scheduling moves into the CRM.</p></div>`
        : html`<div class="card empty"><div class="art">${icon("sun")}</div><h2>Nothing needs you right now</h2><p>Leads, replies, visits and money show up here as each part of the CRM goes live. Rotor is still in charge until the switch.</p></div>`}
      ${links.length ? html`<div class="section-h">Quick links</div><div class="links">${links}</div>` : ""}
    </div>`;
  },
  // the cards' own events and mount, inside each card (redrawn on every paint)
  mount(view, s, ctx) {
    for (const c of s.cards || []) {
      if (!c.key || !c.mod || !(c.mod.events || c.mod.mount)) continue;
      const el = view.querySelector(`[data-card="${c.key}"]`);
      if (!el || el.dataset.wired) continue;
      el.dataset.wired = "1";
      const cc = cardCtx(c, ctx);
      if (c.mod.events) {
        const wrapped = {};
        for (const [k, fn] of Object.entries(c.mod.events)) wrapped[k] = (e, x) => fn(e, x, cc);
        delegate(el, wrapped);
      }
      if (c.mod.mount) { try { c.mod.mount(el, c.state, cc); } catch (e) { /* a card's mount never breaks Today */ } }
    }
  },
};
