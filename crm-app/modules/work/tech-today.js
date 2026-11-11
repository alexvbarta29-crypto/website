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
import { ensureStyles, TICONS, hm, since, send, waiting, overlayDay, prefetch, onDrained, offlineLine, primaryPhone, telHref, smsHref, online, deviceToday, tellShell, CATEGORY, FULL_NOTE } from "./tech-kit.js";

const SHOW_DONE = ["completed", "no_access"];
const addDays = (date, n) => new Date(Date.parse(date + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);

// Always a dated read (the phone's own today), so a copy kept yesterday is
// never shown as today: the morning after, with no signal, it's the copy of
// today taken the day before (tomorrow's prefetch), or a plain "not on
// this phone".
async function read(ctx, date) {
  const r = await ctx.api(`/tech/day?date=${encodeURIComponent(date)}`);
  return { day: r.data, offline: !!r.offline, as_of: r.as_of || null };
}

async function loadDay(ctx, date) {
  let today = deviceToday();
  let want = date || today;
  let days = { date: want, today, yesterday: addDays(today, -1), tomorrow: addDays(today, 1) };
  let got;
  try { got = await read(ctx, want); } catch (e) {
    let err = e;
    if (!date && e && e.status === 400 && e.field === "date") {
      // the phone's date is far off the server's: the server's own today, with signal only (never kept as this phone's copy of a day)
      try {
        const r = await ctx.api("/tech/day", { cache: false });
        got = { day: r.data, offline: false, as_of: null };
        today = r.data.today; want = r.data.date;
        days = { date: want, today, yesterday: r.data.yesterday, tomorrow: r.data.tomorrow };
      } catch (x) { err = x; }
    }
    if (!got) {
      const label = want === today ? "today" : want === days.tomorrow ? "tomorrow" : want === days.yesterday ? "yesterday" : "that day";
      return { ...days, error: err && err.code === "offline" ? `No signal, and ${label === "that day" ? "that day's" : `${label}'s`} list isn't on this phone yet. It loads when you have signal.` : (err && err.message) || "Your day didn't load." };
    }
  }
  const items = await waiting();
  const day = overlayDay(got.day, items, ctx.user && ctx.user.id);
  // keep copies for no signal: tomorrow's day, and each visit of this one
  if (!got.offline && online()) {
    setTimeout(() => {
      if (want === today) {
        read(ctx, days.tomorrow).catch(() => {});
        ctx.api("/me/timesheets").catch(() => {});        // Time opens offline too
      }
      prefetch(ctx, got.day.stops).catch(() => {});
    }, 50);
  }
  return { ...days, day, offline: got.offline, as_of: got.as_of };
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
    const chips = html`<div class="tf-days" role="group" aria-label="Which day">
        ${[["Yesterday", s.yesterday], ["Today", s.today], ["Tomorrow", s.tomorrow]].map(([l, date]) => html`<button type="button" class="chip" ${attrs({ "data-day": date, "aria-pressed": date === s.date ? "true" : "false" })}>${l}</button>`)}
      </div>`;
    const label = s.date === s.today ? "Today" : s.date === s.tomorrow ? "Tomorrow" : s.date === s.yesterday ? "Yesterday" : dateShort(s.date);
    if (s.error) return html`${head}<div class="stack tf-today">${chips}<div class="tf-dayline"><b>${label}, ${dateShort(s.date)}</b><span></span></div><div class="card empty"><div class="art">${icon("today")}</div><h2>Your day</h2><p>${s.error}</p><div class="btn-row"><button type="button" class="btn" data-day-reload>Try again</button></div></div></div>`;
    const d = s.day;
    const stops = d.stops || [];
    const left = stops.filter((x) => !SHOW_DONE.includes(x.visit.status)).length;
    return html`${head}<div class="stack tf-today">
      ${clockBar(d)}
      ${chips}
      <div class="tf-dayline"><b>${label}, ${dateShort(d.date)}</b><span>${stops.length ? `${plural(stops.length, "visit")}${left !== stops.length ? `, ${left} to go` : ""}` : ""}</span></div>
      ${offlineLine({ offline: s.offline, as_of: s.as_of, waiting: d.waiting || 0, what: "Your day" })}
      ${stops.length ? stops.map((x, i) => stopCard(x, i)) : !s.tech ? html`<p class="small muted" style="margin:0 4px">Nothing booked for you ${label === "Today" ? "today" : label === "Tomorrow" ? "tomorrow" : "that day"}.</p>`
        : html`<div class="card empty"><div class="art">${icon("today")}</div><h2>No visits ${label === "Today" ? "today" : label === "Tomorrow" ? "tomorrow" : "that day"}</h2><p>${label === "Today" ? "Nothing booked for you today. The office books visits on the Schedule." : "Nothing booked for you that day."}</p></div>`}
    </div>`;
  },
  events: {
    "click [data-day]": async (e, el, ctx) => {
      const date = el.dataset.day;
      ctx.state = { ...ctx.state, error: null, day: null, ...(await loadDay(ctx, date === deviceToday() ? null : date)) };
      ctx.rerender();
    },
    "click [data-day-reload]": async (e, el, ctx) => { ctx.state = { ...ctx.state, error: null, day: null, ...(await loadDay(ctx, ctx.state.date === deviceToday() ? null : ctx.state.date)) }; ctx.rerender(); },
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
    tellShell(el);
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
  // a clock-out names the shift this phone knows is open (two phones: never the other one's)
  const open = ctx.state.day && ctx.state.day.clock && ctx.state.day.clock.open;
  const shift = action === "out" && open && open.client_id ? { shift_client_id: open.client_id } : {};
  try {
    const r = await send(ctx, "/clock", { action, ...(action === "in" ? { category } : shift) });
    if (r.queued && r.saved === false) toast(FULL_NOTE, { bad: true, ms: 6000 });
    else if (r.data && r.data.pending) toast(r.data.message, { bad: true, ms: 6000 });
    else toast(r.queued ? `${action === "in" ? "Clocked in" : "Clocked out"} on this phone. It goes out when you have signal.` : action === "in" ? "Clocked in" : "Clocked out");
  } catch (err) {
    toast((err && err.message) || "That didn't work.", { bad: true });
  }
  ctx.state = { ...ctx.state, ...(await loadDay(ctx, ctx.state.date && ctx.state.date !== deviceToday() ? ctx.state.date : null)) };
  ctx.rerender();
}
