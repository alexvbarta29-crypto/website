// Team map (Menu → Work → Team map; owners and the office, team_map:read;
// docs/CRM-MAP.md), in the same full-screen layout as Door to door (round
// buttons: find someone, show everyone, filter, street ↔ satellite; the
// people as cards along the bottom): where each person on the clock is, how fresh that is,
// their current or next visit and the day's route. Tap a person for their
// day. It reads GET /map/team every 30 s while it's on screen.
//
// Positions come only from phones that are clocked in, with the app open,
// for people an owner turned on (Settings → Maps and the team map); the
// screen's "How it works" says so, the iPhone limit included.

import { html, attrs, sheet, render, icon } from "../../core/ui.js";
import { initials, dateShort, plural } from "../../core/format.js";
import { poll } from "../../core/poll.js";
import * as mv from "./mapview.js";
import { ensureStyles, MICONS, freshness, staleness, bboxOf, swatch } from "./kit.js";
import { creditsSheet, fabs } from "./knock.js";

let T = null;
const STATUS = { scheduled: "Booked", en_route: "On the way", in_progress: "Working", paused: "Paused", completed: "Done", no_access: "No access", cancelled: "Cancelled" };
const PILL = { en_route: "blue", in_progress: "green", paused: "amber", completed: "", no_access: "red" };
const fmt12 = (hhmm) => {
  if (!/^\d{2}:\d{2}$/.test(hhmm || "")) return "";
  const [h, m] = hhmm.split(":").map(Number);
  return `${((h + 11) % 12) + 1}${m ? ":" + String(m).padStart(2, "0") : ""}${h < 12 ? "a" : "p"}`;
};

async function load(params, ctx) {
  ensureStyles();
  const date = (/[?&]date=(\d{4}-\d{2}-\d{2})/.exec(location.hash) || [])[1] || "";
  const r = await ctx.api("/map/team" + (date ? `?date=${date}` : ""), { cache: date ? false : undefined });
  return { data: r.data, offline: !!r.offline, as_of: r.as_of || null };
}

function statusLine(p) {
  if (!p.sharing) return "Not sharing (off for them in Settings)";
  if (!p.last) return p.clocked_in === false ? "Clocked out" : p.clocked_in ? "On the clock: no position yet (app closed?)" : "No position that day";
  const age = freshness(p.last.age_s);
  return `${p.clocked_in ? "On the clock" : p.clocked_in === false ? "Clocked out" : "Last seen"} · ${age}${p.last.acc > 200 ? ` (±${Math.round(p.last.acc)} m)` : ""}`;
}
const visitLine = (v) => [fmt12(v.s), v.name, v.town].filter(Boolean).join(" · ");

const shown = () => (T.data.people || []).filter((p) => !T.hidden.has(p.id));
function drawLayers() {
  if (!T || !T.map) return;
  const people = shown();
  T.map.setData("trails", mv.collection(people.filter((p) => T.show.trails && p.trail && p.trail.length > 1).map((p) => mv.line(p.trail.map((x) => [x[1], x[0]]), { color: p.color }))));
  T.map.setData("routes", mv.collection(people.filter(() => T.show.routes).map((p) => { const pts = (p.visits || []).filter((v) => v.geo).map((v) => [v.geo[1], v.geo[0]]); return pts.length > 1 ? mv.line(pts, { color: p.color }) : null; })));
  T.map.setData("stops", mv.collection(people.filter(() => T.show.routes).flatMap((p) => (p.visits || []).filter((v) => v.geo).map((v) => mv.point(v.geo[1], v.geo[0], { color: p.color, id: v.id })))));
  // the people: our own 44 px buttons over the map
  const seen = new Set();
  for (const p of people) {
    if (!p.last) continue;
    seen.add(p.id);
    let m = T.markers.get(p.id);
    const el = m ? m.el : document.createElement("div");
    el.className = "mp-person is-" + staleness(p.last.age_s, T.data.every_s);
    render(el, html`<button type="button" class="mp-person-dot" ${attrs({ "data-person": p.id, "aria-label": `${p.name}: ${statusLine(p)}`, style: /^#[0-9a-f]{6}$/i.test(p.color || "") ? `background:${p.color}` : "" })}>${initials(p.name)}</button><span class="mp-person-age" aria-hidden="true">${freshness(p.last.age_s)}</span>`);
    if (!m) {
      // (its button's tap reaches the screen's own [data-person] handler)
      m = { el, h: T.map.marker(el, [p.last.lng, p.last.lat]) };
      T.markers.set(p.id, m);
    } else m.h.move([p.last.lng, p.last.lat]);
  }
  for (const [id, m] of T.markers) if (!seen.has(id)) { m.h.remove(); T.markers.delete(id); }
}

// The people, as a strip of cards along the bottom (tap one for their day).
function strip() {
  const d = T.data;
  const people = shown();
  return html`${!d.enabled ? html`<div class="mp-off"><strong>The team map is off.</strong> ${T.ctx.can("settings:owner") ? html`<a class="btn small" href="#/settings/maps">Turn it on in Settings</a>` : "An owner can turn it on in Settings."}</div>` : ""}
    <ul class="mp-people">${people.map((p) => html`<li><button type="button" class="mp-prow" ${attrs({ "data-person": p.id })}>
      <span class="${"mp-ava is-" + (p.last ? staleness(p.last.age_s, d.every_s) : "none")}" style="${/^#[0-9a-f]{6}$/i.test(p.color || "") ? "background:" + p.color : ""}">${initials(p.name)}</span>
      <span class="who"><span class="nm">${p.name}</span><span class="sub">${statusLine(p)}</span>
      ${p.current ? html`<span class="sub">Now: ${visitLine(p.current)}</span>` : p.next ? html`<span class="sub">Next: ${visitLine(p.next)}</span>` : html`<span class="sub">${plural((p.visits || []).length, "visit")} ${d.date === d.today ? "today" : "that day"}</span>`}</span>
    </button></li>`)}
      <li><button type="button" class="mp-prow mp-help" data-help>${MICONS.info}<span class="who"><span class="nm">How it works</span><span class="sub">What's shared, and when</span></span></button></li>
    </ul>
    ${people.length ? "" : html`<p class="muted small">Nobody goes out on visits yet.</p>`}`;
}

function paint() {
  if (!T || !T.el) return;
  const box = T.el.querySelector("[data-list]");
  if (box) render(box, strip());
  const top = T.el.querySelector("[data-top]");
  if (top) render(top, fabs({ filtered: T.hidden.size > 0 || !T.show.trails || !T.show.routes || T.data.date !== T.data.today, aerial: T.aerial, hasAerial: !!(T.data.sources && T.data.sources.aerial) }));
  const cr = T.el.querySelector("[data-credits]");
  if (cr) cr.textContent = mv.credits(T.data.sources, { aerial: T.aerial });
  const n = T.el.querySelector("[data-note]");
  const notes = [];
  if (T.data.date !== T.data.today) notes.push(html`<span class="mp-pill blue">${dateShort(T.data.date)}</span>`);
  if (T.offline) notes.push(html`<span class="mp-pill">No signal: as of ${T.as_of ? dateShort(String(T.as_of).slice(0, 10)) : "the last read"}</span>`);
  if (T.mapError) notes.push(html`<span class="mp-pill red">${T.mapError}</span>`);
  if (n) render(n, notes.length ? html`<div class="mp-notes">${notes}</div>` : html``);
}
function fitAll() {
  if (!T || !T.map) return;
  const pts = shown().flatMap((p) => [...(p.last ? [[p.last.lng, p.last.lat]] : []), ...(p.visits || []).filter((v) => v.geo).map((v) => [v.geo[1], v.geo[0]])]);
  const bb = bboxOf(pts);
  if (bb) T.map.fit(bb, 15);
}
function searchPeople(ctx) {
  const s = sheet({
    title: "Find someone",
    body: html`<ul class="list">${(T.data.people || []).map((p) => html`<li><button type="button" class="row" ${attrs({ "data-find": p.id })}><span class="who"><span class="nm">${p.name}</span><span class="sub">${statusLine(p)}</span></span></button></li>`)}</ul>`,
    events: { "click [data-find]": (e, b) => { s.close(); showPerson(b.dataset.find); setTimeout(() => openPerson(ctx, b.dataset.find), 500); } },
  });
}
function showPerson(id) {
  const p = (T.data.people || []).find((x) => x.id === id);
  if (!p || !T.map) return;
  const pts = [...(p.trail || []).map((x) => [x[1], x[0]]), ...(p.visits || []).filter((v) => v.geo).map((v) => [v.geo[1], v.geo[0]])];
  if (p.last) pts.push([p.last.lng, p.last.lat]);
  const bb = bboxOf(pts);
  if (bb) T.map.fit(bb, 16.5);
}
function filterTeam(ctx) {
  const d = T.data;
  const s = sheet({
    title: "Show on the map",
    body: html`<form data-tfilter>
      <label class="check"><input ${attrs({ type: "checkbox", name: "trails", checked: T.show.trails })}><span>Where they've been today (trails)</span></label>
      <label class="check"><input ${attrs({ type: "checkbox", name: "routes", checked: T.show.routes })}><span>Their visits and route</span></label>
      <div class="section-h">People</div>
      ${(d.people || []).map((p) => html`<label class="check"><input ${attrs({ type: "checkbox", name: "p_" + p.id, checked: !T.hidden.has(p.id) })}><span>${swatch(p.color)}${p.name}</span></label>`)}
      <div class="section-h">Day</div>
      <label class="field mp-day"><span class="sr">Day</span><input type="date" name="day" ${attrs({ value: d.date, max: d.today, min: addDays(d.today, -(d.retention_days || 30)) })}></label>
    </form>`,
    events: {
      "change [type=checkbox]": (e, input) => {
        if (input.name === "trails" || input.name === "routes") T.show[input.name] = input.checked;
        else if (input.name.startsWith("p_")) { if (input.checked) T.hidden.delete(input.name.slice(2)); else T.hidden.add(input.name.slice(2)); }
        drawLayers();
        paint();
      },
      "change [name=day]": (e, input) => { const v = input.value; if (/^\d{4}-\d{2}-\d{2}$/.test(v)) { s.close(); ctx.go(v === d.today ? "/team-map" : `/team-map?date=${v}`); } },
    },
  });
}
const addDays = (d, n) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

function openPerson(ctx, id) {
  const p = (T.data.people || []).find((x) => x.id === id);
  if (!p) return;
  const d = T.data;
  sheet({
    title: p.name,
    body: html`<p class="muted">${statusLine(p)}</p>
      ${p.current ? html`<p><strong>Now:</strong> ${visitLine(p.current)}</p>` : ""}
      ${!p.current && p.next ? html`<p><strong>Next:</strong> ${visitLine(p.next)}</p>` : ""}
      <div class="section-h">${d.date === d.today ? "Today" : dateShort(d.date)}</div>
      ${(p.visits || []).length ? html`<ul class="list">${p.visits.map((v, i) => html`<li><a class="row" ${attrs({ href: "#/visits/" + encodeURIComponent(v.id) })}><span class="mp-stop-n">${i + 1}</span><span class="who"><span class="nm">${v.name}</span><span class="sub">${[fmt12(v.s) + (v.e ? "–" + fmt12(v.e) : ""), v.town, (v.svc || []).join(", ")].filter(Boolean).join(" · ")}</span></span><span class="end"><span class="${"pill " + (PILL[v.st] || "")}">${STATUS[v.st] || v.st}</span></span></a></li>`)}</ul>` : html`<p class="muted">No visits.</p>`}
      <div class="btn-row">
        ${p.last || (p.trail || []).length ? html`<button type="button" class="btn" data-show>${MICONS.locate}Show on the map</button>` : ""}
        ${(p.visits || []).length ? html`<a class="btn primary" ${attrs({ href: `#/schedule/route/${d.date}/${encodeURIComponent(p.id)}` })}>Open the route</a>` : ""}
      </div>`,
    events: {
      "click [data-show]": (e, b) => { showPerson(p.id); b.closest(".sheet").querySelector("[data-sheet-x]").click(); },
    },
  });
}

function helpSheet() {
  sheet({
    title: "How the team map works",
    body: html`<p>While someone is <strong>clocked in and has Barta Office open</strong>, their phone shares where it is about every ${Math.round(((T && T.data.every_s) || 120) / 60)} minutes, and when they start or finish a visit. They see "Sharing your location while on the clock" whenever it's on.</p>
      <p>Nothing is shared when they're clocked out or the app is closed. <strong>An iPhone home-screen app can't share its location in the background</strong>: when the phone is locked or another app is in front, their dot stays where it last was and shows how long ago that was ("12 min ago").</p>
      <p>Positions are kept ${(T && T.data.retention_days) || 30} days, then deleted. Owners turn the map on or off for the company and for each person in Settings → Maps and the team map.</p>
      <button type="button" class="btn block" data-credits-sheet>Map credits</button>`,
    events: { "click [data-credits-sheet]": () => creditsSheet(T && T.data.sources) },
  });
}

export default {
  title: "Team map",
  flush: true,
  load,
  render() {
    return html`<div class="mp-screen mp-full mp-team">
      <div class="mp-map" data-map role="application" aria-label="Team map"></div>
      <div class="mp-top" data-top></div>
      <div class="mp-note" data-note role="status"></div>
      <p class="mp-credits" data-credits></p>
      <div class="mp-bottom mp-strip" data-list aria-label="People"></div>
    </div>`;
  },
  async mount(el, s, ctx) {
    if (T) teardown();
    T = { el, ctx, data: s.data, offline: s.offline, as_of: s.as_of, markers: new Map(), map: null, hidden: new Set(), show: { trails: true, routes: true }, aerial: false };
    const mine = T;
    paint();
    const people = (s.data.people || []).filter((p) => p.last);
    const center = people.length ? { lng: people[0].last.lng, lat: people[0].last.lat } : { lng: -93.7891, lat: 45.0419 };
    try {
      const m = await mv.createMap(el.querySelector("[data-map]"), { sources: s.data.sources, center, zoom: 11 });
      if (T !== mine) { m.remove(); return; }
      T.map = m;
      await m.ready;
      if (T !== mine) return;
      drawLayers();
      const pts = (s.data.people || []).flatMap((p) => [...(p.last ? [[p.last.lng, p.last.lat]] : []), ...(p.visits || []).filter((v) => v.geo).map((v) => [v.geo[1], v.geo[0]])]);
      const bb = bboxOf(pts);
      if (bb) m.fit(bb, 15);
    } catch (e) {
      T.mapError = e.message || "The map didn't load.";
      paint();
    }
    // fresh positions every 30 s (today only; an earlier day doesn't change)
    if (s.data.date === s.data.today) {
      T.poll = poll("/map/team", 30000, (data) => {
        if (!T || T !== mine || !data) return;
        T.data = data;
        T.offline = false;
        paint();
        drawLayers();
      }, { immediate: false });
    }
  },
  unmount() { teardown(); },
  events: {
    "click [data-person]": (e, b, ctx) => openPerson(ctx, b.dataset.person),
    "click [data-help]": () => helpSheet(),
    "click [data-fab=search]": (e, b, ctx) => searchPeople(ctx),
    "click [data-fab=locate]": () => fitAll(),
    "click [data-fab=filter]": (e, b, ctx) => filterTeam(ctx),
    "click [data-fab=layers]": () => { T.aerial = !T.aerial; if (T.map) T.map.setAerial(T.aerial); paint(); },
  },
};

function teardown() {
  if (!T) return;
  if (T.poll) T.poll.stop();
  for (const m of T.markers.values()) m.h.remove();
  if (T.map) T.map.remove();
  T = null;
}
