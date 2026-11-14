// The customer's account pages (netlify/lib/crm/portal/account.mjs): the
// hub, visits, history, plan, request work, reschedule and your info. No
// inline script (the portal's CSP): the pages carry what this needs in
// data-* attributes. Every POST goes through portalPost() (the X-CRM-Portal
// header, JSON, plain-English errors) with a client id, so a double tap or
// a retry lands once.
//
// - [data-open-kind]: an open quote or invoice opens through a fresh short
//   link (POST /api/portal/hub/open), the hub session keeps working.
// - Request work: photos are shrunk on the phone (1600 px, JPEG) before
//   they go, at most 3.
// - Your info: the text and email switches save as they're flipped.

import { portalPost } from "./core.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const uuid = () => (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}-${Math.random().toString(16).slice(2, 10)}`);
const MAX_PHOTOS = 3;
const MAX_SIDE = 1600;

function say(box, msg) { if (box) { box.textContent = msg || ""; box.hidden = !msg; } }

function openButtons() {
  document.addEventListener("click", async (e) => {
    const b = e.target.closest && e.target.closest("[data-open-kind]");
    if (!b) return;
    e.preventDefault();
    const box = $("[data-open-error]");
    say(box, "");
    b.disabled = true;
    try {
      const r = await portalPost("/api/portal/hub/open", { kind: b.getAttribute("data-open-kind"), id: b.getAttribute("data-open-id") });
      const to = r.data && r.data.location;
      if (typeof to === "string" && to.startsWith("/p/")) { location.assign(to); return; }
      throw new Error("That didn't open. Try again, or call us.");
    } catch (err) {
      b.disabled = false;
      say(box, err.message);
    }
  });
}

// A photo from the phone, shrunk to MAX_SIDE and sent as JPEG base64 (no "data:" prefix).
function shrink(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(img.naturalWidth * k));
      c.height = Math.max(1, Math.round(img.naturalHeight * k));
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      const data = c.toDataURL("image/jpeg", 0.82);
      resolve({ b64: data.slice(data.indexOf(",") + 1), preview: data });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That photo couldn't be read. Try another one.")); };
    img.src = url;
  });
}

function requestForm() {
  const form = $("[data-request-form]");
  if (!form) return;
  const err = $("[data-error]", form);
  const previews = $("[data-photo-previews]", form);
  const input = $("[data-photos]", form);
  const photos = [];
  const clientId = uuid();
  if (input) input.addEventListener("change", async () => {
    say(err, "");
    for (const f of [...(input.files || [])]) {
      if (photos.length >= MAX_PHOTOS) { say(err, `Up to ${MAX_PHOTOS} photos.`); break; }
      try {
        const p = await shrink(f);
        photos.push(p.b64);
        const im = document.createElement("img");
        im.src = p.preview;
        im.alt = `Photo ${photos.length}`;
        previews.appendChild(im);
      } catch (e) { say(err, e.message); }
    }
    input.value = "";
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    say(err, "");
    const services = $$("input[name=services]:checked", form).map((x) => x.value);
    const notes = (form.elements.notes && form.elements.notes.value) || "";
    if (!services.length && !notes.trim()) { say(err, "Pick what you need, or tell us in a note."); return; }
    const btn = $("[data-send]", form);
    btn.disabled = true;
    btn.textContent = "Sending…";
    try {
      await portalPost("/api/portal/requests", {
        client_id: clientId, services, notes, timing: form.elements.timing ? form.elements.timing.value : undefined,
        ...(form.elements.property_id ? { property_id: form.elements.property_id.value } : {}), photos,
      }, { timeout: 45000 });
      location.replace("/p/request?sent=1");
    } catch (x) {
      btn.disabled = false;
      btn.textContent = "Send request";
      say(err, x.message);
    }
  });
}

function rescheduleForm() {
  const box = $("[data-reschedule]");
  const form = $("[data-reschedule-form]");
  if (!box || !form) return;
  const err = $("[data-error]", form);
  const id = box.getAttribute("data-reschedule");
  const clientId = uuid();
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    say(err, "");
    const dates = [form.elements.date1, form.elements.date2].map((x) => x && x.value).filter(Boolean);
    if (!dates.length) { say(err, "Pick a day that works."); return; }
    const btn = $("button[type=submit]", form);
    btn.disabled = true;
    try {
      await portalPost(`/api/portal/visits/${encodeURIComponent(id)}/reschedule-request`, { client_id: clientId, dates, note: form.elements.note ? form.elements.note.value : "" });
      location.replace(`/p/visits/${encodeURIComponent(id)}/reschedule?sent=1`);
    } catch (x) {
      btn.disabled = false;
      say(err, x.message);
      if (x.code === "late") location.reload();
    }
  });
}

function preferences() {
  const box = $("[data-prefs]");
  if (!box) return;
  const done = $("[data-pref-done]", box);
  const err = $("[data-pref-error]", box);
  for (const input of $$("[data-pref]", box)) {
    input.addEventListener("change", async () => {
      say(err, "");
      if (done) done.hidden = true;
      input.disabled = true;
      try {
        await portalPost("/api/portal/preferences", { channel: input.getAttribute("data-pref"), on: input.checked });
        if (done) done.hidden = false;
      } catch (x) {
        input.checked = !input.checked;
        say(err, x.message);
      }
      input.disabled = false;
    });
  }
}

function infoForm() {
  const form = $("[data-info-form]");
  if (!form) return;
  const err = $("[data-error]", form);
  const done = $("[data-done]", form);
  const clientId = uuid();
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    say(err, "");
    const f = form.elements;
    const body = { client_id: clientId, name: f.name.value, phone: f.phone.value, email: f.email.value, note: f.note.value };
    if (!body.name.trim() && !body.phone.trim() && !body.email.trim() && !body.note.trim()) { say(err, "Tell us what changed."); return; }
    const btn = $("button[type=submit]", form);
    btn.disabled = true;
    try {
      await portalPost("/api/portal/contact-info", body);
      if (done) done.hidden = false;
      btn.hidden = true;
    } catch (x) {
      btn.disabled = false;
      say(err, x.message);
    }
  });
}

function start() {
  openButtons();
  requestForm();
  rescheduleForm();
  preferences();
  infoForm();
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
}
