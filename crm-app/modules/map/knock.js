// Door to door (Menu → Sales → Door to door; docs/CRM-MAP.md): the knock
// map. Customers and open leads are houses on the map (green, blue), pins
// are dots in their type's color, areas are drawn outlines (yours bold).
//
// - Tap a house: a sheet with the pin types as big buttons; one tap saves
//   the pin (the address is filled from the map point while you look;
//   Details adds a note, a follow-up date or a typed address).
// - Tap a pin: its knocks, Knocked again, Change type, Note and follow-up,
//   Convert to lead, Delete (yours, the same day).
// - Start knocking: the map follows you, a cross marks where "Pin here"
//   drops, and the screen stays on (wake lock). One hand, big targets.
// - No signal: pins wait on the phone (the outbox, like the tech app's
//   field changes) and go out in order when it's back; the streets need
//   signal, your dot and the pins don't.
// - Owners and the office (canvass:manage) draw areas: Draw area, tap the
//   corners, Done, name it and pick who knocks it.
// The screen is drawn once; the map lives across its own updates (never a
// full re-render under the map).

import { html, attrs, toast, sheet, render, icon } from "../../core/ui.js";
import { uuid } from "../../core/api.js";
import { field, readForm, showError, clearErrors, busy, checkbox } from "../../core/forms.js";
import { dateShort, plural } from "../../core/format.js";
import { send, waiting, online, onDrained, FULL_NOTE, NeedsSignal } from "../work/tech-kit.js";
import * as mv from "./mapview.js";
import { ensureStyles, MICONS, overlayPins, colorOf, labelOf, swatch, addressLine, deviceToday, bboxOf, OUTCOME_LABELS } from "./kit.js";

const AREA_COLORS = ["#2563eb", "#db3a29", "#13a165", "#b7791f", "#7c4dff", "#0f766e", "#be185d"];
let S = null;            // this screen's live state (one at a time)
let lastView = null;     // where the map was, for coming back

const hashParam = (k) => { const q = (location.hash.split("?")[1] || ""); try { return new URLSearchParams(q).get(k); } catch (e) { return null; } };

async function load(params, ctx) {
  ensureStyles();
  const [start, pins, places, items] = await Promise.all([
    ctx.api("/map/knock"),
    ctx.api("/map/pins").catch(() => null),
    ctx.api("/map/places").catch(() => null),
    waiting("/map/pins").catch(() => []),
  ]);
  return {
    start: start.data, offline: !!start.offline, as_of: start.as_of || null,
    pins: pins && pins.data ? pins.data.pins || [] : [], pinsOffline: !pins || !!pins.offline,
    places: places && places.data ? places.data.places || [] : [],
    items,
  };
}

// ------------------------------------------------------------ drawing the layers

function pinsShown() {
  const today = deviceToday();
  const rows = overlayPins(S.pins, S.items, S.start.me.id);
  return mv.collection(rows.map((p) => mv.point(p.ln, p.la, { id: p.id, color: colorOf(S.start.types, p.t), due: !!(p.fu && p.fu <= today), pending: !!p.pending })));
}
function dueRows() {
  const today = deviceToday();
  return overlayPins(S.pins, S.items, S.start.me.id).filter((p) => p.fu && p.fu <= today).sort((a, b) => a.fu.localeCompare(b.fu));
}
function redraw(which = ["pins", "places", "areas"]) {
  if (!S || !S.map) return;
  const L = S.layers;
  if (which.includes("pins")) S.map.setData("pins", L.pins ? pinsShown() : mv.empty());
  if (which.includes("places")) S.map.setData("places", L.places ? mv.collection(S.places.map((p) => mv.point(p.ln, p.la, { k: p.k, c: p.c || "", n: p.n || "", a: p.a || "" }))) : mv.empty());
  if (which.includes("areas")) S.map.setData("areas", L.areas ? mv.collection(S.start.territories.map((t) => mv.polygon(t.polygon, { id: t.id, color: t.color || "#2563eb", mine: !!t.mine }))) : mv.empty());
}
function drawMe() {
  if (!S || !S.map) return;
  S.map.setData("me", S.pos ? mv.collection([mv.point(S.pos.lng, S.pos.lat, {})]) : mv.empty());
}
function drawDrawing() {
  if (!S || !S.map) return;
  const d = S.drawing;
  if (!d || !d.length) { S.map.setData("draw", mv.empty()); return; }
  const ring = d.length >= 3 ? [...d, d[0]] : d;
  S.map.setData("draw", mv.collection([d.length > 1 ? mv.line(ring) : null, ...d.map((p) => mv.point(p[0], p[1], {}))]));
}

// ------------------------------------------------------------ the overlays

function chips() {
  const L = S.layers;
  const chip = (k, label, on) => html`<button type="button" class="mp-chip" ${attrs({ "data-layer": k, "aria-pressed": String(!!on) })}>${label}</button>`;
  return html`<div class="mp-chips" role="group" aria-label="Show on the map">
    ${chip("pins", "Pins", L.pins)}${chip("places", "Customers", L.places)}${chip("areas", "Areas", L.areas)}
    ${S.start.sources && S.start.sources.aerial ? html`<button type="button" class="mp-chip" ${attrs({ "data-aerial": "1", "aria-pressed": String(!!S.aerial) })}>Aerial</button>` : ""}
  </div>`;
}

function note() {
  const parts = [];
  const pendingN = (S.items || []).filter((i) => !i.refused).length;
  if (pendingN) parts.push(html`<span class="mp-pill amber">${plural(pendingN, "change")} wait for signal</span>`);
  if (S.offline) parts.push(html`<span class="mp-pill">No signal: pins as of ${S.as_of ? dateShort(String(S.as_of).slice(0, 10)) : "the last read"}</span>`);
  if (S.map && S.map.isBlank && online()) parts.push(html`<span class="mp-pill">Streets didn't load. Pins still work.</span>`);
  else if (S.map && S.map.isBlank) parts.push(html`<span class="mp-pill">Streets need signal. Pins still work.</span>`);
  if (S.mapError) parts.push(html`<span class="mp-pill red">${S.mapError}</span>`);
  const due = dueRows();
  if (due.length) parts.push(html`<button type="button" class="mp-pill-btn" data-act="due">${plural(due.length, "door")} to go back to</button>`);
  return parts.length ? html`<div class="mp-notes">${parts}</div>` : html``;
}

function bottom() {
  if (S.drawing) {
    return html`<div class="mp-bar mp-draw-bar">
      <p class="mp-draw-say">${S.drawing.length < 3 ? `Tap the corners of the area (${S.drawing.length} of at least 3).` : `${S.drawing.length} corners. Tap more, or Done.`}</p>
      <div class="mp-bar-row">
        <button type="button" class="btn" data-act="cancel-draw">Cancel</button>
        <button type="button" class="btn" data-act="undo-pt" ${attrs({ disabled: !S.drawing.length })}>${MICONS.undo}Undo</button>
        <button type="button" class="btn primary" data-act="done-draw" ${attrs({ disabled: S.drawing.length < 3 })}>Done</button>
      </div>
    </div>`;
  }
  if (S.knocking) {
    return html`<div class="mp-bar"><div class="mp-bar-row">
      <button type="button" class="mp-round" data-act="stop" aria-label="Stop knocking">${MICONS.stop}</button>
      <button type="button" class="btn primary mp-big" data-act="here">${MICONS.pin}Pin here</button>
      <button type="button" class="mp-round" ${attrs({ "data-act": "follow", "aria-pressed": String(!!S.follow), "aria-label": S.follow ? "Following you" : "Follow me" })}>${MICONS.locate}</button>
    </div>${S.wake && !S.wake.supported ? html`<p class="mp-tiny">This phone can't keep the screen on: set Auto-Lock longer while knocking.</p>` : ""}</div>`;
  }
  return html`<div class="mp-bar"><div class="mp-bar-row">
    <button type="button" class="mp-round" data-act="locate" aria-label="Show where I am">${MICONS.locate}</button>
    <button type="button" class="btn primary mp-big" data-act="knock">${MICONS.walk}Start knocking</button>
    <button type="button" class="mp-round" data-act="more" aria-label="More">${icon("more")}</button>
  </div></div>`;
}

function paintOverlays(which = ["top", "note", "bottom"]) {
  if (!S || !S.el) return;
  const q = (sel) => S.el.querySelector(sel);
  if (which.includes("top") && q("[data-top]")) render(q("[data-top]"), chips());
  if (which.includes("note") && q("[data-note]")) render(q("[data-note]"), note());
  if (which.includes("bottom") && q("[data-bottom]")) render(q("[data-bottom]"), bottom());
  const cross = q("[data-cross]");
  if (cross) cross.hidden = !S.knocking;
  const cr = q("[data-credits]");
  if (cr) cr.textContent = mv.credits(S.start.sources, { aerial: S.aerial });
}

// ------------------------------------------------------------ pins: new

function typeGrid(types, { current } = {}) {
  return html`<div class="mp-types">${types.filter((t) => t.active).map((t) => html`<button type="button" class="mp-type" ${attrs({ "data-type": t.key, "aria-pressed": String(current === t.key) })}>${swatch(t.color)}<span>${t.label}</span></button>`)}</div>`;
}
const addrFields = (a = {}) => html`<div class="mp-addr">
  ${field({ label: "Street", name: "street1", value: a.street1 || "", autocomplete: "off" })}
  <div class="mp-two">${field({ label: "Town", name: "city", value: a.city || "", autocomplete: "off" })}${field({ label: "ZIP", name: "zip", value: a.zip || "", inputmode: "numeric", autocomplete: "off" })}</div>
</div>`;

async function lookUp(ctx, lng, lat) {
  if (!online()) return { address: null, why: "offline" };
  try { return (await ctx.api(`/map/reverse?lat=${lat.toFixed(6)}&lng=${lng.toFixed(6)}`, { cache: false })).data || { address: null }; }
  catch (e) { return { address: null, why: "failed" }; }
}

function newPin(ctx, lng, lat) {
  const st = { address: null, source: null, looking: true, details: false, saved: null };
  const say = () => (st.address ? addressLine(st.address) : st.looking ? "Finding the address…"
    : st.why === "offline" ? "No signal: add the address under Details, or leave it."
    : st.why === "no_result" ? "No address found here: add it under Details, or leave it."
    : "Add the address under Details, or leave it.");
  const body = () => html`<p class="mp-addr-line" data-addr>${say()}</p>
    ${typeGrid(S.start.types)}
    <form class="mp-details" data-details ${attrs({ hidden: !st.details })}>
      <label class="field"><span>Note</span><textarea name="note" rows="2" maxlength="1000" placeholder="Talked to the owner, two stories, wants gutters too"></textarea></label>
      ${field({ label: "Go back on", name: "follow_up_on", type: "date" })}
      ${addrFields(st.address || {})}
      <p class="small muted">Pick the pin type above to save.</p>
    </form>
    ${st.details ? "" : html`<button type="button" class="btn block mp-more-btn" data-details-open>Details: note, go-back date, address</button>`}`;
  const s = sheet({
    title: "New pin",
    body: body(),
    events: {
      "click [data-details-open]": () => { st.details = true; s.set(body()); },
      "click [data-type]": async (e, b) => {
        if (st.saving) return;
        st.saving = true;
        const form = s.el.querySelector("[data-details]");
        const v = form && st.details ? readForm(form) : {};
        const typed = st.details && (v.street1 || v.city || v.zip) ? { street1: v.street1, city: v.city, zip: v.zip, state: (st.address && st.address.state) || "MN" } : null;
        const changedTyped = typed && (!st.address || typed.street1 !== st.address.street1 || typed.city !== st.address.city || typed.zip !== st.address.zip);
        const body2 = {
          lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6, type_key: b.dataset.type,
          ...(v.note ? { note: v.note } : {}), ...(v.follow_up_on ? { follow_up_on: v.follow_up_on } : {}),
          ...(typed ? { address: typed, address_source: changedTyped ? "typed" : "reverse" } : st.address ? { address: st.address, address_source: "reverse" } : {}),
        };
        const client = uuid();
        busy(b, true, "Saving…");
        try {
          const r = await send(ctx, "/map/pins", { ...body2, client_id: client });
          st.saved = r;
          if (r.sent && r.data) {
            S.pins.push({ id: r.data.id, la: r.data.lat, ln: r.data.lng, t: r.data.type_key, o: r.data.outcome, c: r.data.canvasser_id, ...(r.data.follow_up_on ? { fu: r.data.follow_up_on } : {}), d: deviceToday(), n: 1 });
            toast(`${labelOf(S.start.types, b.dataset.type)}${body2.address ? " · " + body2.address.street1 : ""}`);
          } else {
            S.items = await waiting("/map/pins").catch(() => S.items);
            toast(r.saved === false ? FULL_NOTE : "Saved on this phone. It goes out when there's signal.", { bad: r.saved === false, ms: 4000 });
          }
          redraw(["pins"]);
          paintOverlays(["note"]);
          s.close();
          // the address arrived after the tap: put it on the pin
          if (r.sent && r.data && !body2.address) st.patchLater = r.data.id;
        } catch (err) {
          st.saving = false;
          busy(b, false);
          toast(err.message, { bad: true });
        }
      },
    },
  });
  lookUp(ctx, lng, lat).then((r) => {
    st.looking = false;
    st.why = r && r.why;
    if (r && r.address) { st.address = r.address; st.source = "reverse"; }
    const el = s.el.querySelector("[data-addr]");
    if (el) el.textContent = say();
    if (st.details && r && r.address) {
      const form = s.el.querySelector("[data-details]");
      for (const k of ["street1", "city", "zip"]) { const i = form && form.elements[k]; if (i && !i.value) i.value = r.address[k] || ""; }
    }
    if (st.patchLater && r && r.address) send(ctx, `/map/pins/${encodeURIComponent(st.patchLater)}`, { client_id: uuid(), address: r.address, address_source: "reverse" }, { method: "PATCH" }).catch(() => {});
  });
}

// ------------------------------------------------------------ pins: one

function knockList(p) {
  const list = [...(p.knocks || [])].reverse().slice(0, 6);
  return html`<ul class="mp-knocks">${list.map((k) => html`<li>${swatch(colorOf(S.start.types, k.type_key))}<span>${labelOf(S.start.types, k.type_key, OUTCOME_LABELS[k.outcome] || "Knock")}</span><span class="muted">${dateShort(String(k.at).slice(0, 10))} · ${k.by_name || ""}</span></li>`)}</ul>`;
}

function rowOf(id) { return overlayPins(S.pins, S.items, S.start.me.id).find((p) => p.id === id) || null; }

async function openPin(ctx, id) {
  const row = rowOf(id);
  if (!row) return;
  if (row.pending && String(id).startsWith("wait-")) {
    sheet({ title: labelOf(S.start.types, row.t), body: html`<p class="muted">This pin is saved on this phone and goes out when there's signal. You can change it then.</p>` });
    return;
  }
  let p = null;
  try { p = (await ctx.api(`/map/pins/${encodeURIComponent(id)}`, { cache: false })).data; } catch (e) { p = null; }
  const st = { mode: "view" };
  const types = S.start.types;
  const t = p ? p.type : { key: row.t, label: labelOf(types, row.t), color: colorOf(types, row.t) };
  const head = () => html`<div class="mp-pin-head">${swatch(t.color)}<strong>${t.label}</strong>${p && (p.contact || p.converted_at) ? html`<span class="mp-pill green">Lead</span>` : ""}</div>
    <p class="mp-addr-line">${p && p.address ? addressLine(p.address) : "No address on this pin"}</p>`;
  const view = () => {
    if (!p) return html`${head()}<p class="muted">No signal: the details show when it's back. You can still log a knock.</p>
      <div class="mp-acts"><button type="button" class="btn primary" data-mode="again">Knocked again</button><button type="button" class="btn" data-mode="change">Change type</button></div>`;
    return html`${head()}
      ${p.note ? html`<p class="mp-note-text">${p.note}</p>` : ""}
      ${p.follow_up_on ? html`<p class="small"><strong>Go back:</strong> ${dateShort(p.follow_up_on)}</p>` : ""}
      ${p.territories && p.territories.length ? html`<p class="small muted">Area: ${p.territories.map((x) => x.name).join(", ")}</p>` : ""}
      <div class="section-h">Knocks</div>${knockList(p)}
      <div class="mp-acts">
        <button type="button" class="btn primary" data-mode="again">Knocked again</button>
        <button type="button" class="btn" data-mode="change">Change type</button>
        <button type="button" class="btn" data-mode="edit">Note and go-back date</button>
        ${p.can && p.can.convert ? html`<button type="button" class="btn" data-mode="convert">Convert to lead</button>` : ""}
        ${p.contact ? html`<a class="btn" ${attrs({ href: "#/contacts/" + encodeURIComponent(p.contact.id) })}>Open ${p.contact.name}</a>` : ""}
        ${p.can && p.can.delete ? html`<button type="button" class="btn danger" data-mode="delete">Delete this pin</button>` : ""}
      </div>`;
  };
  const edit = () => html`<form data-edit>
      <label class="field"><span>Note</span><textarea name="note" rows="3" maxlength="1000">${(p && p.note) || ""}</textarea></label>
      ${field({ label: "Go back on", name: "follow_up_on", type: "date", value: (p && p.follow_up_on) || "", hint: "Leave empty for no date." })}
      ${addrFields((p && p.address) || {})}
      <div class="btn-row"><button type="button" class="btn" data-mode="view">Cancel</button><button type="submit" class="btn primary">Save</button></div>
    </form>`;
  const convert = () => html`<form data-convert>
      <p class="small muted">The lead goes to the CRM with the source Door to Door, this address, and you as its owner. Texts to them stay in the Outbox until texting is turned on.</p>
      <div class="mp-two">${field({ label: "First name", name: "first_name", autocomplete: "off" })}${field({ label: "Last name", name: "last_name", autocomplete: "off" })}</div>
      ${field({ label: "Mobile", name: "phone", type: "tel" })}
      ${field({ label: "Email", name: "email", type: "email" })}
      ${addrFields((p && p.address) || {})}
      <label class="field"><span>What they want</span><textarea name="note" rows="2" maxlength="2000">${(p && p.note) || ""}</textarea></label>
      ${checkbox({ label: "They said we can text them about this quote", name: "sms_consent" })}
      <p class="form-err" data-form-err hidden></p>
      <div class="btn-row"><button type="button" class="btn" data-mode="view">Cancel</button><button type="submit" class="btn primary">Save the lead</button></div>
    </form>`;
  const body = () => (st.mode === "edit" ? edit() : st.mode === "convert" ? convert() : st.mode === "again" || st.mode === "change" ? html`${head()}<p class="small muted">${st.mode === "again" ? "What happened this time?" : "Fix the type of the last knock."}</p>${typeGrid(types, { current: st.mode === "change" ? t.key : null })}<div class="btn-row"><button type="button" class="btn" data-mode="view">Cancel</button></div>` : view());
  const patch = async (b) => {
    const r = await send(ctx, `/map/pins/${encodeURIComponent(id)}`, { ...b, client_id: uuid() }, { method: "PATCH" });
    if (r.sent && r.data) {
      const i = S.pins.findIndex((x) => x.id === id);
      if (i >= 0) S.pins[i] = { ...S.pins[i], t: r.data.type_key, o: r.data.outcome, ...(r.data.follow_up_on ? { fu: r.data.follow_up_on } : { fu: undefined }) };
      p = { ...p, ...r.data, type: types.find((x) => x.key === r.data.type_key) || t };
    } else {
      S.items = await waiting("/map/pins").catch(() => S.items);
      toast(r.saved === false ? FULL_NOTE : "Saved on this phone. It goes out when there's signal.", { bad: r.saved === false });
    }
    redraw(["pins"]);
    paintOverlays(["note"]);
    return r;
  };
  const s = sheet({
    title: "Pin",
    body: body(),
    events: {
      "click [data-mode]": async (e, b) => {
        const m = b.dataset.mode;
        if (m === "delete") {
          busy(b, true, "Deleting…");
          try {
            await ctx.api(`/map/pins/${encodeURIComponent(id)}`, { method: "DELETE" });
            S.pins = S.pins.filter((x) => x.id !== id);
            redraw(["pins"]);
            paintOverlays(["note"]);
            toast("Pin deleted");
            s.close();
          } catch (err) { busy(b, false); toast(err.message, { bad: true }); }
          return;
        }
        st.mode = m;
        s.set(body());
      },
      "click [data-type]": async (e, b) => {
        busy(b, true, "Saving…");
        try {
          await patch(st.mode === "again" ? { type_key: b.dataset.type, knock: true } : { type_key: b.dataset.type });
          toast(st.mode === "again" ? "Knock saved" : "Type changed");
          s.close();
        } catch (err) { busy(b, false); toast(err.message, { bad: true }); }
      },
      "submit [data-edit]": async (e, form) => {
        e.preventDefault();
        clearErrors(form);
        const v = readForm(form);
        const btn = form.querySelector("[type=submit]");
        busy(btn, true);
        try {
          const address = v.street1 || v.city || v.zip ? { street1: v.street1, city: v.city, zip: v.zip, state: (p && p.address && p.address.state) || "MN" } : null;
          await patch({ note: v.note || "", follow_up_on: v.follow_up_on || null, address, address_source: "typed" });
          toast("Saved");
          s.close();
        } catch (err) { busy(btn, false); showError(form, err); }
      },
      "submit [data-convert]": async (e, form) => {
        e.preventDefault();
        clearErrors(form);
        const v = readForm(form);
        const btn = form.querySelector("[type=submit]");
        busy(btn, true);
        try {
          const r = await send(ctx, `/map/pins/${encodeURIComponent(id)}/convert`, {
            first_name: v.first_name, last_name: v.last_name, phone: v.phone, email: v.email, note: v.note, sms_consent: !!v.sms_consent,
            address: { street1: v.street1, city: v.city, zip: v.zip, state: (p && p.address && p.address.state) || "MN" },
          }, { needsSignal: true, what: "Converting to a lead" });
          const d = r.data || {};
          const i = S.pins.findIndex((x) => x.id === id);
          if (i >= 0) S.pins[i] = { ...S.pins[i], lead: true };
          redraw(["pins"]);
          s.close();
          toast(d.already ? "This pin is already a lead." : d.enrolled ? "Lead saved. Its follow-up started." : d.created === false ? "They were already in the CRM: the visit is on their record." : "Lead saved. The office follows up.", { ms: 4000 });
          if (d.contact_id && ctx.can("contacts:read_all")) ctx.go("/contacts/" + encodeURIComponent(d.contact_id));
        } catch (err) {
          busy(btn, false);
          if (err instanceof NeedsSignal) toast(err.message, { bad: true });
          else showError(form, err);
        }
      },
    },
  });
}

// ------------------------------------------------------------ customers and leads

function openPlace(ctx, props, at) {
  const kind = props.k === "lead" ? "An open lead" : props.k === "former" ? "A former customer" : "A customer";
  const s = sheet({
    title: props.n ? props.n : kind,
    body: html`${props.n ? html`<p class="mp-pin-head"><span class="mp-pill ${props.k === "lead" ? "blue" : "green"}">${props.k === "lead" ? "Lead" : props.k === "former" ? "Former customer" : "Customer"}</span></p>` : html`<p class="muted">${kind} lives here.</p>`}
      ${props.a ? html`<p class="mp-addr-line">${props.a}</p>` : ""}
      <div class="mp-acts">
        ${props.c ? html`<a class="btn primary" ${attrs({ href: "#/contacts/" + encodeURIComponent(props.c) })}>Open</a>` : ""}
        <button type="button" class="btn" data-drop>Drop a pin here anyway</button>
      </div>`,
    events: { "click [data-drop]": () => { s.close(); newPin(ctx, at[0], at[1]); } },
  });
}

// ------------------------------------------------------------ areas

function doneDrawing(ctx) {
  const ring = S.drawing;
  const people = S.start.people || [];
  const s = sheet({
    title: "New area",
    body: html`<form data-area>
      ${field({ label: "Name", name: "name", value: "", placeholder: "North Delano, west of Hwy 12", maxlength: "60" })}
      <fieldset class="mp-colors"><legend>Color</legend>${AREA_COLORS.map((c, i) => html`<label class="mp-color"><input ${attrs({ type: "radio", name: "color", value: c, checked: i === (S.start.territories.length % AREA_COLORS.length) })}><span style="${"background:" + c}" aria-hidden="true"></span><span class="sr">${c}</span></label>`)}</fieldset>
      ${people.length ? html`<div class="section-h">Who knocks it</div>${people.map((u) => html`<label class="check"><input ${attrs({ type: "checkbox", name: "p_" + u.id })}><span>${u.name}</span></label>`)}` : ""}
      <p class="form-err" data-form-err hidden></p>
      <div class="btn-row"><button type="submit" class="btn primary">Save the area</button></div>
    </form>`,
    events: {
      "submit [data-area]": async (e, form) => {
        e.preventDefault();
        clearErrors(form);
        const v = readForm(form);
        const btn = form.querySelector("[type=submit]");
        busy(btn, true);
        try {
          const r = await ctx.api("/map/territories", { method: "POST", body: { name: v.name, color: v.color, polygon: ring, assignee_ids: people.filter((u) => v["p_" + u.id]).map((u) => u.id) } });
          const t = r.data;
          S.start.territories.push({ id: t.id, name: t.name, color: t.color, polygon: t.polygon, assignee_ids: t.assignee_ids, assignees: t.assignees, mine: (t.assignee_ids || []).includes(S.start.me.id) });
          S.drawing = null;
          drawDrawing();
          redraw(["areas"]);
          paintOverlays(["bottom"]);
          toast("Area saved");
          s.close();
        } catch (err) { busy(btn, false); showError(form, err); }
      },
    },
  });
}

// ------------------------------------------------------------ knocking mode

function startKnocking(ctx) {
  S.knocking = true;
  S.follow = true;
  S.wake = mv.keepAwake();
  S.stopWatch = mv.watchPosition((pos) => {
    if (!S) return;
    S.pos = pos;
    drawMe();
    if (S.follow && S.map) S.map.flyTo([pos.lng, pos.lat], Math.max(S.map.zoom(), 17.5));
  }, () => { toast("Location is off for this app. Pins drop where the cross is.", { bad: true, ms: 4500 }); S.follow = false; paintOverlays(["bottom"]); });
  paintOverlays();
}
function stopKnocking() {
  if (!S) return;
  S.knocking = false;
  if (S.stopWatch) { S.stopWatch(); S.stopWatch = null; }
  if (S.wake) { S.wake.release(); S.wake = null; }
  paintOverlays();
}

function moreSheet(ctx) {
  const s = sheet({
    title: "Door to door",
    body: html`<div class="mp-links">
      <a class="row" href="#/knock/report"><span class="ico">${icon("chart")}</span><span class="who"><span class="nm">Leaderboard and report</span><span class="sub">Doors, conversations, leads, booked</span></span></a>
      <a class="row" href="#/knock/areas"><span class="ico">${icon("map")}</span><span class="who"><span class="nm">Areas</span><span class="sub">${plural(S.start.territories.length, "area")}${S.start.territories.some((t) => t.mine) ? ", some yours" : ""}</span></span></a>
      ${S.start.me.manage ? html`<button type="button" class="row" data-draw><span class="ico">${MICONS.draw}</span><span class="who"><span class="nm">Draw an area</span><span class="sub">Tap its corners on the map</span></span></button>` : ""}
      ${ctx.can("settings:general") ? html`<a class="row" href="#/settings/knock"><span class="ico">${icon("gear")}</span><span class="who"><span class="nm">Pin types</span><span class="sub">Names, colors, what each counts as</span></span></a>` : ""}
      <button type="button" class="row" data-credits-sheet><span class="ico">${MICONS.info}</span><span class="who"><span class="nm">Map credits and privacy</span><span class="sub">Where the map comes from</span></span></button>
    </div>`,
    events: {
      "click [data-draw]": () => { s.close(); stopKnocking(); S.drawing = []; drawDrawing(); paintOverlays(); toast("Tap the first corner of the area"); },
      "click [data-credits-sheet]": () => { s.close(); creditsSheet(); },
    },
  });
}

export function creditsSheet(sources = S && S.start.sources) {
  sheet({
    title: "Map credits",
    body: html`<p>Streets: ${sources && sources.streets ? sources.streets.attribution : ""}. © OpenStreetMap contributors (data under the Open Database License).</p>
      ${sources && sources.aerial ? html`<p>${sources.aerial.attribution}.</p>` : ""}
      <p>The map is drawn on your phone by MapLibre GL JS (BSD license), served from Barta's own site.</p>
      <p class="small muted">Your phone fetches map pictures from ${sources && sources.streets ? sources.streets.label : "the map service"}${sources && sources.aerial ? " and " + sources.aerial.label : ""}: those requests say which part of the map you're looking at, never a customer's name. When you drop a pin, its address is looked up from the two coordinates only (OpenStreetMap's Nominatim, through Barta's server).</p>`,
  });
}

function dueSheet(ctx) {
  const rows = dueRows();
  const s = sheet({
    title: "Doors to go back to",
    body: rows.length ? html`<ul class="list">${rows.map((p) => html`<li><button type="button" class="row" ${attrs({ "data-go": p.id })}>${swatch(colorOf(S.start.types, p.t))}<span class="who"><span class="nm">${labelOf(S.start.types, p.t)}</span><span class="sub">Go back ${dateShort(p.fu)}</span></span></button></li>`)}</ul>` : html`<p class="muted">Nothing due.</p>`,
    events: {
      "click [data-go]": (e, b) => {
        const p = rowOf(b.dataset.go);
        s.close();
        if (p && S.map) { S.map.flyTo([p.ln, p.la], 18); setTimeout(() => openPin(ctx, p.id), 650); }
      },
    },
  });
}

// ------------------------------------------------------------ the screen

export default {
  title: "Door to door",
  flush: true,
  load,
  action: (s, ctx) => ({ label: "Report", run: () => ctx.go("/knock/report") }),
  render(s) {
    return html`<div class="mp-screen mp-knock">
      <div class="mp-map" data-map role="application" aria-label="Door-to-door map. Tap a house to drop a pin."></div>
      <div class="mp-cross" data-cross hidden aria-hidden="true"></div>
      <div class="mp-top" data-top></div>
      <div class="mp-note" data-note role="status"></div>
      <p class="mp-credits" data-credits></p>
      <div class="mp-bottom" data-bottom></div>
    </div>`;
  },
  async mount(el, s, ctx) {
    if (S && S.map && S.el === el && el.querySelector("[data-map]") === S.mapEl) return;
    if (S) teardown();
    const mapEl = el.querySelector("[data-map]");
    S = {
      el, mapEl, ctx, start: s.start, pins: s.pins, places: s.places, items: s.items, offline: s.offline, as_of: s.as_of,
      layers: { pins: true, places: true, areas: true }, aerial: false, knocking: false, follow: false, drawing: null, pos: null, map: null,
    };
    const mine = S;
    paintOverlays();
    const area = hashParam("area");
    const focus = area ? S.start.territories.find((t) => t.id === area) : null;
    const center = lastView ? { lng: lastView.lng, lat: lastView.lat } : S.start.center;
    try {
      const m = await mv.createMap(mapEl, { sources: S.start.sources, center, zoom: lastView ? lastView.zoom : 15 });
      if (S !== mine) { m.remove(); return; }
      S.map = m;
      m.onTap(({ lng, lat, hit }) => {
        if (!S) return;
        if (S.drawing) { S.drawing.push([Math.round(lng * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6]); drawDrawing(); paintOverlays(["bottom"]); return; }
        if (hit && hit.layer === "mp-pins") { openPin(ctx, hit.props.id); return; }
        if (hit && hit.layer === "mp-places") { openPlace(ctx, hit.props, hit.at); return; }
        newPin(ctx, lng, lat);
      });
      m.map.on("dragstart", () => { if (S && S.knocking && S.follow) { S.follow = false; paintOverlays(["bottom"]); } });
      m.map.on("moveend", () => { if (S && S.map) lastView = { ...S.map.center(), zoom: S.map.zoom() }; });
      await m.ready;
      if (S !== mine) return;
      redraw();
      paintOverlays(["note"]);
      if (hashParam("draw") && S.start.me.manage) { S.drawing = []; drawDrawing(); paintOverlays(); }
      if (focus) m.fit(bboxOf(focus.polygon));
      else if (!lastView) {
        mv.locateOnce().then((pos) => {
          if (!S || S !== mine || !pos || pos.denied) return;
          S.pos = pos;
          drawMe();
          S.map.flyTo([pos.lng, pos.lat], 16);
        });
      }
    } catch (e) {
      S.mapError = e.message || "The map didn't load.";
      paintOverlays(["note"]);
    }
    onDrained(async () => {
      if (!S || S !== mine) return;
      try {
        const r = await ctx.api("/map/pins", { cache: false });
        S.pins = r.data.pins || [];
      } catch (e) { /* keep what we have */ }
      S.items = await waiting("/map/pins").catch(() => []);
      redraw(["pins"]);
      paintOverlays(["note"]);
    });
  },
  unmount() { teardown(); },
  events: {
    "click [data-layer]": (e, b) => { S.layers[b.dataset.layer] = !S.layers[b.dataset.layer]; redraw([b.dataset.layer]); paintOverlays(["top"]); },
    "click [data-aerial]": () => { S.aerial = !S.aerial; if (S.map) S.map.setAerial(S.aerial); paintOverlays(["top"]); },
    "click [data-act=locate]": async (e, b, ctx) => {
      const pos = await mv.locateOnce();
      if (!pos || pos.denied) { toast(pos && pos.denied ? "Location is off for this app (Settings → Privacy → Location)." : "Couldn't find you just now.", { bad: true }); return; }
      S.pos = pos;
      drawMe();
      if (S.map) S.map.flyTo([pos.lng, pos.lat], 17.5);
    },
    "click [data-act=knock]": (e, b, ctx) => startKnocking(ctx),
    "click [data-act=stop]": () => stopKnocking(),
    "click [data-act=follow]": () => { S.follow = !S.follow; if (S.follow && S.pos && S.map) S.map.flyTo([S.pos.lng, S.pos.lat]); paintOverlays(["bottom"]); },
    "click [data-act=here]": (e, b, ctx) => {
      const at = S.follow && S.pos ? S.pos : S.map ? S.map.center() : null;
      if (!at) { toast("The map isn't ready yet.", { bad: true }); return; }
      newPin(ctx, at.lng, at.lat);
    },
    "click [data-act=more]": (e, b, ctx) => moreSheet(ctx),
    "click [data-act=due]": (e, b, ctx) => dueSheet(ctx),
    "click [data-act=cancel-draw]": () => { S.drawing = null; drawDrawing(); paintOverlays(); },
    "click [data-act=undo-pt]": () => { if (S.drawing) S.drawing.pop(); drawDrawing(); paintOverlays(["bottom"]); },
    "click [data-act=done-draw]": (e, b, ctx) => { if (S.drawing && S.drawing.length >= 3) doneDrawing(ctx); },
  },
};

function teardown() {
  if (!S) return;
  if (S.stopWatch) S.stopWatch();
  if (S.wake) S.wake.release();
  if (S.map) S.map.remove();
  S = null;
}

