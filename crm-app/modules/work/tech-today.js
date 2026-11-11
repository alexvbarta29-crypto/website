// The person's own day on Today (design §9.3 Today, §9.2 "My visits",
// §2.5): a tech's whole Today, and "My visits" for owners and the office
// who go out on visits. The clock bar (Clock in, or "On the clock 3 h 12 m"
// with Clock out), yesterday / today / tomorrow, and the visits in their
// route order: time and arrival window, first name and last initial, town,
// services, badges (plan member, balance due, gate code, pets, first
// visit, lights), the status; Directions (the maps app), Call and Text.
//
// It works with no signal: the day comes from GET /tech/day, and the last
// good copy (today's and tomorrow's) is what shows offline, with "as of"
// and the changes still waiting laid over it. While there is signal it
// keeps a copy of each visit of the day, so a visit opens offline too.

import { html, icon, attrs, toast, sheet } from "../../core/ui.js";
import { dateShort, time as fmtTime, plural } from "../../core/format.js";
import { directionsLink } from "../../core/map.js";
import { slotText, visitPill } from "./office-kit.js";
import { ensureStyles, TICONS, hm, since, send, waiting, overlayDay, prefetch, onDrained, waitingNote, primaryPhone, telHref, smsHref, online, CATEGORY } from "./tech-kit.js";

const SHOW_DONE = ["completed", "no_access"];

async function read(ctx, date) {
  const path = date ? `/tech/day?date=${encodeURIComponent(date)}` : "/tech/day";
  const r = await ctx.api(path);
  return { day: r.data, offline: !!r.offline, as_of: r.as_of || null };
}

async function loadDay(ctx, date) {
  let got;
  try { got = await read(ctx, date); } catch (e) {
    return { date, error: e && e.code === "offline" ? "No signal, and no copy of this day on this phone yet." : (e && e.message) || "Your day didn't load." };
  }
  const items = await waiting();
  const day = overlayDay(got.day, items, ctx.user && ctx.user.id);
  // keep copies for no signal: tomorrow's day, and each visit of this one
  if (!got.offline && online()) {
    setTimeout(() => {
      if (!date || date === got.day.today) {
        read(ctx, got.day.tomorrow).catch(() => {});
        ctx.api("/me/timesheets").catch(() => {});        // Time opens offline too
      }
      prefetch(ctx, got.day.stops).catch(() => {});
    }, 50);
  }
  return { date: got.day.date, day, offline: got.offline, as_of: got.as_of };
}

export default {
  async load(ctx) {
    ensureStyles();
    const u = ctx.user || {};
    if (u.role !== "tech" && !u.is_technician) return { none: true };
    const s = await loadDay(ctx, null);
    // the visit's changes went out: read the day again
    onDrained(() => ctx.refresh && ctx.refresh());
    return { ...s, tech: u.role === "tech" };
  },
  render(s) {
    if (!s || s.none) return html``;
    const head = s.tech ? "" : html`<div class="section-h">My visits</div>`;
    if (s.error) return html`${head}<div class="card empty"><div class="art">${icon("today")}</div><h2>Your day</h2><p>${s.error}</p><div class="btn-row"><button type="button" class="btn" data-day-reload>Try again</button></div></div>`;
    const d = s.day;
    const stops = d.stops || [];
    const left = stops.filter((x) => !SHOW_DONE.includes(x.visit.status)).length;
    const label = d.date === d.today ? "Today" : d.date === d.tomorrow ? "Tomorrow" : d.date === d.yesterday ? "Yesterday" : dateShort(d.date);
    return html`${head}<div class="stack tf-today">
      ${clockBar(d)}
      <div class="tf-days" role="group" aria-label="Which day">
        ${[["Yesterday", d.yesterday], ["Today", d.today], ["Tomorrow", d.tomorrow]].map(([l, date]) => html`<button type="button" class="chip" ${attrs({ "data-day": date, "aria-pressed": date === d.date ? "true" : "false" })}>${l}</button>`)}
      </div>
      <div class="tf-dayline"><b>${label}, ${dateShort(d.date)}</b><span>${stops.length ? `${plural(stops.length, "visit")}${left !== stops.length ? `, ${left} to go` : ""}` : ""}</span></div>
      ${s.offline ? html`<p class="tf-asof">No signal. Your day as of ${fmtTime(s.as_of)}.</p>` : ""}
      ${waitingNote(d.waiting || 0)}
      ${stops.length ? stops.map((x, i) => stopCard(x, i)) : !s.tech ? html`<p class="small muted" style="margin:0 4px">Nothing booked for you ${label === "Today" ? "today" : label === "Tomorrow" ? "tomorrow" : "that day"}.</p>`
        : html`<div class="card empty"><div class="art">${icon("today")}</div><h2>No visits ${label === "Today" ? "today" : label === "Tomorrow" ? "tomorrow" : "that day"}</h2><p>${label === "Today" ? "Nothing booked for you today. The office books visits on the Schedule." : "Nothing booked for you that day."}</p></div>`}
    </div>`;
  },
  events: {
    "click [data-day]": async (e, el, ctx) => {
      const date = el.dataset.day;
      ctx.state = { ...ctx.state, ...(await loadDay(ctx, date === ctx.state.day?.today ? null : date)) };
      ctx.rerender();
    },
    "click [data-day-reload]": async (e, el, ctx) => { ctx.state = { ...ctx.state, ...(await loadDay(ctx, null)) }; ctx.rerender(); },
    "click [data-clock]": async (e, el, ctx) => {
      const action = el.dataset.clock;
      if (action === "in" && ctx.user && ctx.user.role !== "tech") {
        const category = await pickCategory();
        if (!category) return;
        return clock(ctx, el, "in", category);
      }
      return clock(ctx, el, action, "service");
    },
  },
  mount(el) {
    // the "on the clock" time moves on while Today is on screen
    const tick = () => {
      if (!document.contains(el)) { clearInterval(timer); return; }
      for (const x of el.querySelectorAll("[data-since]")) x.textContent = hm(since(x.dataset.since));
    };
    const timer = setInterval(tick, 30000);
  },
};

function clockBar(d) {
  const open = d.clock && d.clock.open;
  if (!open) {
    return html`<div class="card tf-clock"><span class="who"><b>Not clocked in</b><span>${d.clock && d.clock.week_minutes ? `${hm(d.clock.week_minutes)} this week` : "Clock in when you start"}</span></span>
      <button type="button" class="btn primary" data-clock="in">${icon("time")}Clock in</button></div>`;
  }
  return html`<div class="card tf-clock on"><span class="who"><b>On the clock <span ${attrs({ "data-since": open.start_at })}>${hm(since(open.start_at))}</span></b><span>Since ${fmtTime(open.start_at)}${open.category && open.category !== "service" ? ` · ${CATEGORY[open.category] || open.category}` : ""}${d.clock.over_ot ? " · overtime this week" : d.clock.near_ot ? " · close to 40 h" : ""}</span></span>
    <button type="button" class="btn dark" data-clock="out">Clock out</button></div>`;
}

function stopCard(x, i) {
  const v = x.visit;
  const addr = x.property && x.property.address;
  const where = addr || (v.geo ? { lat: v.geo[0], lng: v.geo[1] } : v.address_line || null);
  const ph = primaryPhone(x.contact);
  const services = (v.service_types || []).join(", ") || v.job_title || "";
  const done = SHOW_DONE.includes(v.status);
  return html`<div class="${"tf-stop" + (done ? " done" : "")}">
    <a ${attrs({ href: "#/visits/" + encodeURIComponent(v.id) })}>
      <span class="tf-n">${done ? icon("check") : x.n || i + 1}</span>
      <span class="tf-body">
        <span class="nm">${x.name}</span>
        <span class="when">${slotText(v)}</span>
        <span class="sub">${[v.town, services].filter(Boolean).join(" · ")}</span>
        ${x.badges && x.badges.length ? html`<span class="tf-badges">${x.badges.map((b) => html`<span class="${"pill " + (b.key === "balance" ? "red" : b.key === "first" ? "blue" : b.key === "plan" ? "green" : "")}">${b.label}</span>`)}</span>` : ""}
        ${x.waiting ? html`<span class="sub">Changes waiting for signal</span>` : ""}
      </span>
      ${visitPill(v.status)}
    </a>
    <div class="tf-quick">
      ${where ? html`<a ${directionsLink(where)}>${icon("map")}Directions</a>` : html`<span class="muted">No address</span>`}
      ${ph ? html`<a ${attrs({ href: telHref(ph) })}>${icon("phone")}Call</a><a ${attrs({ href: smsHref(ph) })}>${icon("text")}Text</a>` : ""}
    </div>
  </div>`;
}

function pickCategory() {
  return new Promise((resolve) => {
    let picked = null;
    const s = sheet({
      title: "Clock in for",
      body: html`<ul class="tf-pick">${Object.entries(CATEGORY).map(([k, l]) => html`<li><button type="button" ${attrs({ "data-cat": k })}>${l}<small>${k === "service" ? "Visits and field work" : k === "sales" ? "Estimates and sales calls" : "Office work"}</small></button></li>`)}</ul>`,
      onClose: () => resolve(picked),
      events: { "click [data-cat]": (e, b) => { picked = b.dataset.cat; s.close(); } },
    });
  });
}

async function clock(ctx, el, action, category) {
  el.disabled = true;
  try {
    const r = await send(ctx, "/clock", { action, ...(action === "in" ? { category } : {}) });
    toast(r.queued ? `${action === "in" ? "Clocked in" : "Clocked out"} on this phone. It goes out when you have signal.` : action === "in" ? "Clocked in" : "Clocked out");
  } catch (err) {
    toast((err && err.message) || "That didn't work.", { bad: true });
  }
  ctx.state = { ...ctx.state, ...(await loadDay(ctx, ctx.state.day && ctx.state.day.date !== ctx.state.day.today ? ctx.state.day.date : null)) };
  ctx.rerender();
}
