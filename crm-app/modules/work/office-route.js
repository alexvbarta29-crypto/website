// One person's day as a route (design §9.2 "Route"): the stops in drive
// order with a sketch of where they are, Optimize (nearest first inside
// each arrival window, the server's routeOrder), move a stop up or down and
// save, and directions (one stop, or the whole day in Google Maps).

import { html, icon, attrs, toast, openExternal } from "../../core/ui.js";
import { directionsLink, routeSketch } from "../../core/map.js";
import { ensureStyles, officeView, slotText, dayLabel, loadUsers, userById, visitPill } from "./office-kit.js";

async function fetchDay(ctx, params) {
  const r = await ctx.api(`/schedule/route?date=${encodeURIComponent(params.date)}&user=${encodeURIComponent(params.user)}`, { cache: false });
  return r.data;
}

const where = (s) => s.ad || s.town || "";
const geoOf = (s) => (Array.isArray(s.geo) && Number.isFinite(s.geo[0]) && Number.isFinite(s.geo[1]) ? { lat: s.geo[0], lng: s.geo[1] } : null);
function wholeDay(stops) {
  const pts = stops.map((s) => { const g = geoOf(s); return g ? `${g.lat},${g.lng}` : where(s); }).filter(Boolean);
  if (!pts.length) return null;
  const dest = pts[pts.length - 1];
  const way = pts.slice(0, -1).slice(0, 9);
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}${way.length ? `&waypoints=${encodeURIComponent(way.join("|"))}` : ""}&travelmode=driving`;
}

export default {
  title: "Route",
  async load(params, ctx) {
    ensureStyles();
    if (!officeView()) return { denied: true };
    const [day, users] = await Promise.all([fetchDay(ctx, params), loadUsers(ctx).catch(() => [])]);
    return { ...day, order: day.stops.map((s) => s.id), dirty: false, person: userById(users, params.user), miles: null, no_geo: [] };
  },
  action: (s, ctx) => (s.denied || !ctx.can("schedule:write") || !s.stops.length ? null : s.dirty ? { label: "Save", run: () => save(ctx) } : { label: "Optimize", run: () => optimize(ctx) }),
  render(s) {
    if (s.denied) return html`<div class="stack"><div class="card empty"><h2>Not for this login</h2><p>Routes are for the office.</p></div></div>`;
    const byId = new Map(s.stops.map((x) => [x.id, x]));
    const stops = s.order.map((id) => byId.get(id)).filter(Boolean);
    const pts = stops.map((x, i) => { const g = geoOf(x); return g ? { ...g, label: `${i + 1}. ${x.cn || ""}` } : null; }).filter(Boolean);
    const all = wholeDay(stops);
    const missing = stops.filter((x) => !geoOf(x)).length;
    return html`<div class="stack wk">
      <div class="card wk-routehead"><div><b>${s.person ? s.person.name : "Someone"}</b><span class="muted">${dayLabel(s.date)} · ${stops.length} ${stops.length === 1 ? "stop" : "stops"}${s.miles ? ` · about ${s.miles} miles` : ""}</span></div></div>
      ${pts.length ? html`<div class="card wk-sketch">${routeSketch(pts, { width: 320, height: 180 })}</div>` : ""}
      ${missing ? html`<p class="note">${missing === 1 ? "One stop has" : `${missing} stops have`} no map location yet, so ${missing === 1 ? "it goes" : "they go"} last in its window. Fix the address on the property.</p>` : ""}
      ${stops.length ? html`<ol class="list wk-stops">${stops.map((x, i) => html`<li class="wk-stop">
        <span class="wk-n num" aria-hidden="true">${i + 1}</span>
        <a class="who" href="${"#/visits/" + encodeURIComponent(x.id)}"><span class="nm">${x.cn || "Customer"}</span><span class="sub">${slotText(x)}</span><span class="sub">${where(x)}</span></a>
        <span class="wk-stop-acts">
          ${where(x) || geoOf(x) ? html`<a class="icon-btn" ${directionsLink(geoOf(x) || where(x))} aria-label="Directions">${icon("map")}</a>` : ""}
          <button type="button" class="icon-btn" ${attrs({ "data-up": x.id, disabled: i === 0, "aria-label": "Earlier" })}><span class="wk-up">${icon("back")}</span></button>
          <button type="button" class="icon-btn" ${attrs({ "data-down": x.id, disabled: i === stops.length - 1, "aria-label": "Later" })}><span class="wk-down">${icon("back")}</span></button>
        </span></li>`)}</ol>` : html`<div class="card empty"><div class="art">${icon("map")}</div><h2>No stops</h2><p>Nothing booked for ${s.person ? s.person.name : "them"} this day.</p></div>`}
      ${all ? html`<div class="btn-row"><a class="btn" ${openExternal(all)}>${icon("map")}The whole day in Google Maps</a></div>` : ""}
      ${s.dirty ? html`<p class="small muted">Moved by hand: Save to keep this order.</p>` : ""}
    </div>`;
  },
  events: {
    "click [data-up]": (e, el, ctx) => move(ctx, el.dataset.up, -1),
    "click [data-down]": (e, el, ctx) => move(ctx, el.dataset.down, 1),
  },
};

function move(ctx, id, by) {
  const s = ctx.state;
  const i = s.order.indexOf(id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= s.order.length) return;
  const next = s.order.slice();
  [next[i], next[j]] = [next[j], next[i]];
  s.order = next; s.dirty = true;
  ctx.rerender();
}

async function optimize(ctx) {
  const s = ctx.state;
  try {
    const r = await ctx.api("/schedule/route", { method: "POST", body: { date: s.date, user_id: s.user_id } });
    s.order = r.data.order; s.miles = r.data.miles; s.no_geo = r.data.no_geo || []; s.dirty = false;
    toast(r.data.changed ? "Put in drive order" : "Already in drive order");
  } catch (err) { toast(err.message || "That didn't work.", { bad: true }); }
  ctx.rerender();
}

async function save(ctx) {
  const s = ctx.state;
  try {
    await ctx.api("/schedule/route", { method: "POST", body: { date: s.date, user_id: s.user_id, order: s.order } });
    s.dirty = false; toast("Saved");
  } catch (err) {
    toast(err.status === 409 ? "The day changed. Here it is again." : err.message || "That didn't save.", { bad: true });
    if (err.status === 409) { ctx.refresh(); return; }
  }
  ctx.rerender();
}

export { visitPill };
