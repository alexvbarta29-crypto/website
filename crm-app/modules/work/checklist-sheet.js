// The checklist as Rotor's crew works it (Nov 2026, the owner's screenshots of
// Rotor's "Technician Job Checklist"): a full-height sheet, its title, then
// "Complete in order • 0 of 15 done" under it, and the items in order. The
// next item is outlined red; the ones after it wait (dimmed) until it's
// done. Each item answers the way its kind asks: a checkbox, a pick from a
// list, a number, photos ("0/10 photos"), a group of checkboxes, notes.
// Required items carry "*" and gate Finish.
//
// Opened from the floating "N left" pill (checklistPill below) on the job
// page and on the tech's visit. The visit's own people answer; anyone else
// (the office) sees the answers. Every answer goes through the field
// outbox (tech-kit.js send): with no signal it waits on the phone and goes
// out in order, and the sheet shows it done meanwhile. Ticking "Send On My
// Way Text" also texts On my way (dry run until texting is on; it needs
// signal) and "Arrive + Mark Start Job" starts the visit (works offline);
// the server ticks those two by itself when On my way or Start is tapped
// anywhere else.

import { html, attrs, icon, raw, sheet, toast, render } from "../../core/ui.js";
import { capture, prepare, photoTile } from "../../core/camera.js";
import { send, waiting, overlayVisit, online, here, etaMinutes, toBase64, FULL_NOTE, TICONS, ensureStyles } from "./tech-kit.js";
import { itemsOf, itemDone, progress, locked, progressText, pillText, itemPhotos, applyAnswer, photoAdded, hookStep, canAnswer } from "./checklist-kit.js";

const MAX_PHOTO = 3000000;
const LIST_ICON = raw('<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 6.5l1.6 1.6L8.8 5M4 12.5l1.6 1.6 3.2-3.1M4 18.5l1.6 1.6 3.2-3.1M12 6.5h8M12 12.5h8M12 18.5h8"/></svg>');

// The floating "☑ 15 left" pill (bottom right, above the tab bar), or "" when the visit has no list.
export function checklistPill(visit, { data = { "ck-open": visit && visit.id } } = {}) {
  const items = itemsOf(visit);
  if (!items.length) return "";
  const p = progress(items);
  return html`<button type="button" class="${"ck-pill" + (p.left ? "" : " ok")}" ${attrs({ ...Object.fromEntries(Object.entries(data).map(([k, v]) => [`data-${k}`, v === true ? "" : v])), "aria-haspopup": "dialog", "aria-label": `Checklist: ${p.done} of ${p.total} done` })}>${LIST_ICON}<span>${pillText(p)}</span></button>`;
}

let styled = false;
function styles() {
  ensureStyles();
  if (styled || typeof document === "undefined") return;
  styled = true;
  const l = document.createElement("link");
  l.rel = "stylesheet";
  l.href = "/crm-app/modules/work/checklist.css";
  document.head.appendChild(l);
}

const star = (i) => (i.required ? html`<span class="ck-req" aria-hidden="true"> *</span><span class="sr"> (required)</span>` : "");
const box = (on) => html`<span class="${"ck-box" + (on ? " on" : "")}" aria-hidden="true">${on ? icon("check") : ""}</span>`;

// One item's inside (its li is drawn once; check, group and photo items are drawn again on a change).
function inner(i, v, { work }) {
  const done = itemDone(i);
  const k = i.kind || "check";
  if (k === "check") {
    return html`<button type="button" class="ck-row" ${attrs({ "data-ck-tick": i.key, "aria-pressed": done ? "true" : "false", "aria-disabled": work ? null : "true" })}>${box(done)}<span class="ck-l">${i.label}${star(i)}</span></button>`;
  }
  if (k === "multi") {
    const on = new Set(Array.isArray(i.value) ? i.value : []);
    return html`<fieldset class="ck-group"><legend class="ck-q">${i.label}${star(i)}${(i.min || 1) > 1 && (i.options || []).length > 1 ? html`<span class="ck-hint sr">${(i.min || 1) >= (i.options || []).length ? ", tick all of them" : `, tick at least ${i.min}`}</span>` : ""}</legend>
      ${(i.options || []).map((o, n) => html`<button type="button" class="ck-row sub" ${attrs({ "data-ck-opt": i.key, "data-n": String(n), "aria-pressed": on.has(o) ? "true" : "false", "aria-disabled": work ? null : "true" })}>${box(on.has(o))}<span class="ck-l">${o}</span></button>`)}</fieldset>`;
  }
  if (k === "photo") {
    const shots = itemPhotos(v, i.key);
    const max = i.max || 10;
    return html`<p class="ck-q">${i.label}${star(i)}</p>
      ${shots.length ? html`<div class="ck-shots">${shots.slice(-max).map((p) => (p.file_id && !p.local ? photoTile(p.file_id, { alt: "Checklist photo", cls: "ck-shot" }) : html`<span class="ck-shot wait">${p.thumb ? html`<img ${attrs({ src: p.thumb, alt: "Checklist photo, waiting for signal" })}>` : ""}</span>`))}</div>` : ""}
      <button type="button" class="ck-cam" ${attrs({ "data-ck-photo": i.key, "aria-disabled": work && shots.length < max ? null : "true", "aria-label": `${i.label}: take or upload a photo, ${shots.length} of ${max}` })}>${TICONS.camera}<span>${shots.length}/${max} photos</span></button>`;
  }
  const id = `ck-${i.key}`;
  if (k === "select") {
    return html`<label class="ck-q" ${attrs({ for: id })}>${i.label}${star(i)}</label>
      <span class="ck-sel"><select ${attrs({ id, "data-ck-sel": i.key, required: true, disabled: work ? null : true })}><option value="">Select an option</option>${(i.options || []).map((o) => html`<option ${attrs({ value: o, selected: i.value === o })}>${o}</option>`)}</select></span>`;
  }
  if (k === "count") {
    return html`<label class="ck-q" ${attrs({ for: id })}>${i.label}${star(i)}</label>
      <input class="ck-in" type="number" inputmode="numeric" min="0" max="100000" step="1" ${attrs({ id, "data-ck-num": i.key, value: i.value ?? "", placeholder: i.placeholder || "Enter a number", disabled: work ? null : true })}>`;
  }
  return html`<label class="ck-q" ${attrs({ for: id })}>${i.label}${star(i)}</label>
    <textarea class="ck-in" rows="4" maxlength="500" ${attrs({ id, "data-ck-text": i.key, placeholder: i.placeholder || "Enter detailed answer", disabled: work ? null : true })}>${i.value || ""}</textarea>`;
}

function list(v, opts) {
  const items = itemsOf(v);
  const p = progress(items);
  return html`<ol class="ck-list" aria-label="Checklist items">${items.map((i, n) => html`<li ${attrs({ class: cls(items, n, p, opts), "data-ck": i.key, "data-kind": i.kind || "check" })}>${inner(i, v, opts)}</li>`)}</ol>
    ${opts.work ? "" : html`<p class="ck-foot small muted">${(v.status === "completed" ? "This visit is done. " : "") + "The crew answers these on their phone."}</p>`}`;
}
function cls(items, n, p, { work }) {
  const i = items[n];
  return ["ck-item", itemDone(i) ? "done" : "", work && n === p.next ? "next" : "", work && locked(items, n, p) ? "locked" : ""].filter(Boolean).join(" ");
}

// Open the sheet. visit: as the opener shows it (its waiting changes laid
// over it). → the sheet; onClose(changed) when it goes.
export async function openChecklist(ctx, { visit, property = null, onClose } = {}) {
  styles();
  const uid = ctx.user && ctx.user.id;
  // the phone's own waiting changes on top (a job page opener has the server's copy only)
  let v = visit;
  try { v = overlayVisit(visit, await waiting(`/visits/${visit.id}/`), uid, []).visit; } catch (e) { v = visit; }
  let changed = false;
  let told = false;
  const opts = () => ({ work: canAnswer(v, uid, (p) => ctx.can(p)) });
  const name = (v.checklist && v.checklist.name) || "Checklist";
  const sh = sheet({
    title: name, className: "rs-sheetpage ck-sheet", body: list(v, opts()),
    onClose: () => { if (onClose) onClose(changed); },
    events: {
      "click [data-ck-tick]": (e, el) => tick(el.dataset.ckTick),
      "click [data-ck-opt]": (e, el) => groupTick(el.dataset.ckOpt, Number(el.dataset.n)),
      "change [data-ck-sel]": (e, el) => answer(el.dataset.ckSel, el.value ? { done: true, value: el.value } : { done: false }, el),
      "change [data-ck-num]": (e, el) => {
        const raw = String(el.value || "").trim();
        if (!raw) return answer(el.dataset.ckNum, { done: false }, el);
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 0 || n > 100000) { toast("Use a whole number.", { bad: true }); return null; }
        return answer(el.dataset.ckNum, { done: true, value: n }, el);
      },
      "change [data-ck-text]": (e, el) => { const t = String(el.value || "").trim(); return answer(el.dataset.ckText, t ? { done: true, value: t.slice(0, 500) } : { done: false }, el); },
      "click [data-ck-photo]": (e, el) => photo(el.dataset.ckPhoto, el),
      // a tap on a dimmed item says what comes first
      "click .ck-item.locked": (e) => { if (e.target.closest("button")) return; const it = itemsOf(v)[progress(itemsOf(v)).next]; if (it) toast(`Complete in order: "${it.label}" first.`); },
    },
  });
  // "Complete in order • 0 of 15 done" sits under the title (not in the scroll)
  const sub = document.createElement("p");
  sub.className = "ck-sub";
  sub.setAttribute("role", "status");
  sh.el.querySelector(".sheet-head").after(sub);
  paint();

  const itemOf = (key) => itemsOf(v).find((i) => i.key === key);
  const gate = (key) => {
    if (!opts().work) return false;
    const items = itemsOf(v);
    const n = items.findIndex((i) => i.key === key);
    if (n < 0) return false;
    if (locked(items, n)) { const it = items[progress(items).next]; toast(`Complete in order: "${it.label}" first.`); return false; }
    return true;
  };

  // the item's li and the progress line, after a change (the inputs keep their focus)
  function paint(redraw = null) {
    const items = itemsOf(v);
    const p = progress(items);
    sub.textContent = progressText(p);
    for (const li of sh.el.querySelectorAll("[data-ck]")) {
      const n = items.findIndex((i) => i.key === li.dataset.ck);
      if (n < 0) continue;
      li.className = cls(items, n, p, opts());
      const off = !opts().work || locked(items, n, p);
      for (const c of li.querySelectorAll("select, input, textarea")) c.disabled = off;
      if (redraw === items[n].key || (redraw === "*" && li.dataset.kind !== "text" && li.dataset.kind !== "count" && li.dataset.kind !== "select")) render(li, inner(items[n], v, opts()));
    }
  }

  async function answer(key, body, el) {
    if (!gate(key)) { if (el && el.tagName !== "BUTTON") el.value = valueOf(itemOf(key)); return; }
    const before = v;
    const item = itemOf(key);
    v = { ...v, checklist: { ...v.checklist, items: itemsOf(v).map((i) => (i.key === key ? applyAnswer(i, body, { at: new Date().toISOString(), by: uid }) : i)) } };
    changed = true;
    paint(["check", "multi"].includes(item.kind || "check") ? key : null);
    try {
      const r = await send(ctx, `/visits/${encodeURIComponent(v.id)}/checklist`, { key, ...body }, { method: "PATCH" });
      queued(r);
    } catch (err) {
      v = before;
      paint(key);
      if (el && el.tagName !== "BUTTON") el.value = valueOf(itemOf(key));
      toast((err && err.message) || "That didn't save.", { bad: true });
    }
  }
  function queued(r) {
    if (!r || !r.queued || told) return;
    told = true;
    toast(r.saved === false ? FULL_NOTE : "Saved, will send when online.", r.saved === false ? { bad: true, ms: 6000 } : undefined);
  }

  async function tick(key) {
    const item = itemOf(key);
    if (!item || !gate(key)) return;
    const on = !itemDone(item);
    const step = on ? hookStep(item, v.status) : null;
    if (step === "omw") {
      // On my way texts the customer: it needs signal, never waits for later
      if (!online()) { toast("On my way needs signal. Nothing was sent; it's ticked when you send it.", { bad: true }); return; }
      const p = property && property.geo && Number.isFinite(property.geo.lat) ? [property.geo.lat, property.geo.lng] : Array.isArray(v.geo) ? v.geo : null;
      let eta = 15;
      try { eta = etaMinutes(await here(), p); } catch (e) { /* the default */ }
      try {
        const r = await send(ctx, `/visits/${encodeURIComponent(v.id)}/on-my-way`, { eta_min: Math.min(240, Math.max(1, eta || 15)) }, { needsSignal: true, what: "On my way" });
        const t = r.data && r.data.text;
        v = { ...v, status: "en_route" };
        toast(t && (t.status === "dry_run" || t.mode === "dry_run") ? "On my way. Texts aren't switched on yet, so nothing went out." : t && t.status === "sent" ? "On my way: texted the customer." : "On my way.");
      } catch (err) { toast((err && err.message) || "On my way didn't go through.", { bad: true }); return; }
    } else if (step === "start") {
      try {
        const r = await send(ctx, `/visits/${encodeURIComponent(v.id)}/timer`, { action: "start" });
        queued(r);
        v = { ...v, status: "in_progress" };
        if (!r.queued) toast("Started. The timer is running.");
      } catch (err) { toast((err && err.message) || "Start didn't go through.", { bad: true }); return; }
    }
    return answer(key, { done: on });
  }

  function groupTick(key, n) {
    const item = itemOf(key);
    if (!item || !gate(key)) return;
    const o = (item.options || [])[n];
    if (o === undefined) return;
    const cur = new Set(Array.isArray(item.value) ? item.value : []);
    if (cur.has(o)) cur.delete(o); else cur.add(o);
    const value = (item.options || []).filter((x) => cur.has(x));
    return answer(key, value.length ? { done: true, value } : { done: false });
  }

  async function photo(key, el) {
    const item = itemOf(key);
    if (!item || !gate(key)) return;
    if (itemPhotos(v, key).length >= (item.max || 10)) { toast(`That's all ${item.max || 10} photos for this one.`); return; }
    const file = await capture();
    if (!file) return;
    el.setAttribute("aria-busy", "true");
    let p;
    try { p = await prepare(file, { maxBytes: MAX_PHOTO }); } catch (err) {
      el.removeAttribute("aria-busy");
      toast((err && err.message) || "This phone couldn't prepare the photo.", { bad: true });
      return;
    }
    const data = await toBase64(p.full), thumb = await toBase64(p.thumb);
    const tag = /after/i.test(key) ? "after" : /before|sides|walk/i.test(key) ? "before" : "other";
    const before = v;
    const cid = `ck-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    v = photoAdded(v, key, { local: true, client_id: cid, tag, thumb: `data:image/jpeg;base64,${thumb}` }, { at: new Date().toISOString(), by: uid });
    changed = true;
    paint(key);
    try {
      const r = await send(ctx, `/visits/${encodeURIComponent(v.id)}/photos`, { tag, item: key, data, thumb });
      queued(r);
      // the server's copy (the photo's file id, the item done) once it has it
      if (r.sent && r.data && r.data.visit) { v = overlayVisit(r.data.visit, await waiting(`/visits/${v.id}/`), uid, []).visit; paint(key); }
    } catch (err) {
      v = before;
      paint(key);
      toast((err && err.message) || "That photo didn't save.", { bad: true });
    }
  }
  return sh;
}

const valueOf = (i) => (i && i.value !== undefined && i.value !== null && !Array.isArray(i.value) ? String(i.value) : "");

export { LIST_ICON, styles as checklistStyles };
