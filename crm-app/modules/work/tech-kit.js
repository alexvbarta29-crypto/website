// Pieces the tech app's screens share (M4b; design §2.5, §9.3): the
// stylesheet, a few icons, how minutes read, and the offline machinery:
//
//   send(ctx, path, body)   a field change: straight to the server when
//        there is signal and nothing is waiting, else into the phone's
//        outbox (core/outbox.js) with queued_offline, queued_at and
//        client_at, replayed in order when signal comes back. Every change
//        carries a client id (a repeat is one change on the server).
//        Anything that texts a customer (on my way, running late) never
//        queues: needsSignal refuses it offline.
//   overlayVisit / overlayDay   what the phone shows while changes wait:
//        the last good copy from the server with the waiting changes laid
//        over it (ticks, notes, photos, the timer, completion), so the
//        screen never goes back on what the tech just did.
//   prefetch(ctx, stops)    keeps a copy of each visit of the day (and its
//        timers) while there is signal, so a visit opens with none.
// No data here, only how things work (design §2.3).

import { raw, html } from "../../core/ui.js";
import { uuid } from "../../core/api.js";
import { localDate, dateShort, time as fmtTime } from "../../core/format.js";
import * as outbox from "../../core/outbox.js";

let styled = false;
export function ensureStyles() {
  if (styled || typeof document === "undefined") return;
  styled = true;
  for (const href of ["/crm-app/modules/work/office-styles.css", "/crm-app/modules/work/tech-styles.css"]) {
    if (document.querySelector(`link[href="${href}"]`)) continue;
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = href;
    document.head.appendChild(l);
  }
}

// ------------------------------------------------------------ icons (static, trusted)

const svg = (d) => raw(`<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${d}</svg>`);
export const TICONS = {
  play: svg('<path d="M8 5.5v13l10.5-6.5z"/>'),
  stop: svg('<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>'),
  camera: svg('<path d="M4 8.5A2.5 2.5 0 0 1 6.5 6H8l1.5-2h5L16 6h1.5A2.5 2.5 0 0 1 20 8.5v8a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5z"/><circle cx="12" cy="12.5" r="3.5"/>'),
  flag: svg('<path d="M5.5 21V4M5.5 4.5h11l-2 4 2 4h-11"/>'),
  car: svg('<path d="M5 16.5V12l2-5h10l2 5v4.5M5 16.5h14M5 16.5V19M19 16.5V19"/><circle cx="8" cy="13.5" r="1"/><circle cx="16" cy="13.5" r="1"/>'),
  late: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2M12 2v1.5"/>'),
  lock: svg('<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>'),
  note: svg('<path d="M5 4.5h14v15H5z"/><path d="M8.5 9h7M8.5 12.5h7M8.5 16h4"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  edit: svg('<path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-4-4L4 16z"/><path d="M14 6l4 4"/>'),
  cloud: svg('<path d="M7 18.5a4.5 4.5 0 0 1-.6-9 6 6 0 0 1 11.5 1.6A3.8 3.8 0 0 1 17.5 18.5z"/><path d="M4 4l16 16"/>'),
};

// ------------------------------------------------------------ words

export const hm = (min) => {
  const m = Math.max(0, Math.round(Number(min) || 0));
  const h = Math.floor(m / 60);
  return h ? `${h} h ${String(m % 60).padStart(2, "0")} m` : `${m} min`;
};
export const hours = (min) => (Math.round(((Number(min) || 0) / 60) * 100) / 100).toFixed(2);
export const since = (iso, now = Date.now()) => Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
export const deviceToday = () => localDate(new Date());

// Delano time, whatever zone the phone is in.
const HM = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const DOWS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const hhmmOf = (iso) => { const p = Object.fromEntries(HM.formatToParts(new Date(iso)).map((x) => [x.type, x.value])); return `${p.hour}:${p.minute}`; };
export const dowOf = (isoOrDate) => DOWS[new Date((/^\d{4}-\d{2}-\d{2}$/.test(isoOrDate) ? isoOrDate : localDate(isoOrDate)) + "T12:00:00Z").getUTCDay()];
// The instant of a Delano date and "HH:MM" (DST-safe). → ISO string
export function isoFromLocal(date, hhmm) {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = hhmm.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const off = (ms) => {
    const day = localDate(new Date(ms));
    const [h2, m2] = hhmmOf(new Date(ms)).split(":").map(Number);
    return (Date.UTC(...day.split("-").map((x, i) => (i === 1 ? Number(x) - 1 : Number(x))), h2, m2) - Math.floor(ms / 60000) * 60000) / 60000;
  };
  let t = guess - off(guess) * 60000;
  if (off(t) !== off(guess)) t = guess - off(t) * 60000;
  return new Date(t).toISOString();
}
export const CATEGORY = { service: "Service", sales: "Sales", office: "Office" };
export const STATUS = { open: "On the clock", closed: "Done", pending_approval: "Waiting for the office", approved: "Approved", locked: "Paid period", rejected: "Not counted", adjusted: "Paid as an adjustment" };
export const REASON = {
  queued_mismatch: "the phone's time didn't add up", too_old: "it was more than a week old", future: "the phone's clock was ahead",
  no_device_time: "the phone sent no time", conflict: "the visit had changed", locked_period: "that week is already paid",
  clock_skew: "the phone's clock was off", overlap: "it overlaps other time of theirs", moved: "the visit was moved to another day",
  cancelled: "the visit was cancelled", lost: "they weren't on the visit any more", stale: "it was more than six days old",
};
// "Pat Sample" → "Pat S."
export function shortName(c) {
  const parts = String((c && (c.display_name || c.first_name)) || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "Customer";
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.` : parts[0];
}
export const primaryPhone = (c) => {
  const list = (c && c.phones) || [];
  return (list.find((p) => p && p.primary) || list[0] || {}).e164 || null;
};
export const telHref = (e164) => "tel:" + String(e164 || "").replace(/[^\d+]/g, "");
export const smsHref = (e164, body) => `sms:${String(e164 || "").replace(/[^\d+]/g, "")}${body ? `?&body=${encodeURIComponent(String(body))}` : ""}`;

// ------------------------------------------------------------ sending, online or later

export const online = () => typeof navigator === "undefined" || navigator.onLine !== false;
export class NeedsSignal extends Error {
  constructor(what = "This") { super(`${what} needs signal. Try again when you have some.`); this.code = "needs_signal"; }
}

// → { sent: true, data } | { queued: true, saved }; throws the server's
// refusal. No answer, a timeout or a 5xx: the change waits in the outbox
// under the same Idempotency-Key (and client id), so one that landed is
// never done twice. saved: false when the phone's storage is full (the
// change waits in this page only: FULL_NOTE).
export const FULL_NOTE = "This phone is full; this change isn't saved. Keep the app open until you have signal.";
export async function send(ctx, path, body = {}, { method = "POST", needsSignal = false, what } = {}) {
  const client_at = new Date().toISOString();
  const full = { client_id: uuid(), ...body, client_at };
  const key = uuid();
  const waiting = await outbox.count().catch(() => 0);
  if (needsSignal) {
    if (!online()) throw new NeedsSignal(what);
    try { return { sent: true, data: (await ctx.api(path, { method, body: full, timeout: 8000, idempotencyKey: key })).data }; } catch (e) {
      if (e && e.code === "offline") throw new NeedsSignal(what);
      throw e;
    }
  }
  if (online() && !waiting) {
    try {
      // a short wait when there's signal (6 s; a photo up to 30 s): past it the change waits in the outbox, which gives it the time its size needs
      const r = await ctx.api(path, { method, body: full, timeout: Math.min(30000, Math.max(6000, outbox.timeoutFor(full) - 4000)), idempotencyKey: key });
      return { sent: true, data: r.data, status: r.status };
    } catch (e) {
      if (e && e.code !== "offline" && !(e.status >= 500)) throw e;
      // no answer, or the server stumbled: it waits in the outbox (the client id and key make a landed one a no-op)
    }
  }
  const item = await outbox.enqueue({ method, path, key, body: { ...full, queued_offline: true, queued_at: client_at } });
  outbox.replay().catch(() => {});
  return { queued: true, saved: item.saved !== false };
}

// The changes still waiting on this phone (oldest first), optionally for a path prefix.
// (One the server turned down isn't laid over the screen: it waits for the office's review.)
export async function waiting(prefix = "") {
  const all = (await outbox.list().catch(() => [])).filter((i) => !i.refused);
  return prefix ? all.filter((i) => typeof i.path === "string" && i.path.startsWith(prefix)) : all;
}

// One listener for the screen on show: called when the outbox empties after
// holding changes (the server has them all: time to read again).
let drained = null;
let lastCount = 0;
let hooked = false;
export function onDrained(fn) {
  drained = fn;
  if (hooked) return;
  hooked = true;
  outbox.onChange((n) => {
    const was = lastCount;
    lastCount = n;
    if (was > 0 && n === 0 && typeof drained === "function") { try { drained(); } catch (e) { /* the screen went away */ } }
  });
  outbox.count().then((n) => { lastCount = n; }).catch(() => {});
}

// ------------------------------------------------------------ the waiting changes laid over the last copy (pure)

const clone = (v) => JSON.parse(JSON.stringify(v));
const OPEN = ["scheduled", "en_route", "in_progress", "paused"];

// A visit (as the server last sent it) with this phone's waiting changes on
// it. `timers`: the visit's segments (techFields). → { visit, timers, waiting }
export function overlayVisit(visit, items = [], uid = null, timers = []) {
  const v = clone(visit || {});
  let t = clone(timers || []);
  const prefix = `/visits/${v.id}/`;
  let n = 0;
  for (const it of items) {
    if (!it || typeof it.path !== "string" || !it.path.startsWith(prefix)) continue;
    n += 1;
    const b = it.body || {};
    const at = b.client_at || it.client_at || new Date().toISOString();
    const what = it.path.slice(prefix.length);
    if (what === "timer" && b.action === "start") {
      if (["scheduled", "en_route", "paused"].includes(v.status)) v.status = "in_progress";
      if (!t.some((x) => !x.end_at && (x.user_ids || []).includes(uid))) t.push({ id: `local-${b.client_id}`, client_id: b.client_id, user_ids: [uid], start_at: at, local: true });
    } else if (what === "timer" && b.action === "pause") {
      t = t.map((x) => (!x.end_at && (x.user_ids || []).includes(uid) ? { ...x, end_at: at, minutes: Math.max(0, Math.round((Date.parse(at) - Date.parse(x.start_at)) / 60000)) } : x));
      if (v.status === "in_progress" && !t.some((x) => !x.end_at)) v.status = "paused";
    } else if ((what === "timer" && b.action === "finish") || what === "complete") {
      if (OPEN.includes(v.status)) { v.status = "completed"; v.completion = { at, by: uid, waiting: true }; }
      t = t.map((x) => (!x.end_at ? { ...x, end_at: at, minutes: Math.max(0, Math.round((Date.parse(at) - Date.parse(x.start_at)) / 60000)) } : x));
    } else if (what === "no-access") {
      if (["scheduled", "en_route"].includes(v.status)) v.status = "no_access";
    } else if (what === "checklist") {
      const items2 = ((v.checklist && v.checklist.items) || []).map((i) => {
        if (i.key !== b.key) return i;
        if (!b.done) { const { done_at, done_by, value, ...rest } = i; return rest; }
        return { ...i, done_at: i.done_at || at, done_by: uid, ...(b.value !== undefined ? { value: b.value } : {}) };
      });
      v.checklist = { ...(v.checklist || {}), items: items2 };
    } else if (what === "notes" && b.text) {
      v.tech_notes = v.tech_notes ? `${v.tech_notes}\n\n${b.text}` : String(b.text);
    } else if (what === "photos") {
      v.photos = [...(v.photos || []), { local: true, client_id: b.client_id, tag: b.tag || "other", at, thumb: b.thumb ? `data:image/jpeg;base64,${b.thumb}` : null }];
      if (b.item) v.checklist = { ...(v.checklist || {}), items: ((v.checklist && v.checklist.items) || []).map((i) => (i.key === b.item && !i.done_at ? { ...i, done_at: at, done_by: uid, value: `local-${b.client_id}` } : i)) };
    }
  }
  return { visit: v, timers: t, waiting: n };
}

// The day payload with the waiting changes on its stops and the clock.
export function overlayDay(day, items = [], uid = null) {
  if (!day) return day;
  const d = clone(day);
  d.stops = (d.stops || []).map((s) => {
    const o = overlayVisit(s.visit, items, uid, s.timers);
    return { ...s, visit: o.visit, timers: o.timers, waiting: o.waiting };
  });
  for (const it of items) {
    if (!it || it.path !== "/clock") continue;
    const b = it.body || {};
    const at = b.client_at || it.client_at;
    if (b.action === "in" && !d.clock.open) d.clock.open = { start_at: at, category: b.category || "service", status: "open", local: true, client_id: b.client_id };
    if (b.action === "out") d.clock.open = null;
  }
  // starting a timer clocks in
  if (!d.clock.open && items.some((it) => it && /\/timer$/.test(it.path) && it.body && it.body.action === "start")) {
    const it = items.find((x) => x && /\/timer$/.test(x.path) && x.body && x.body.action === "start");
    d.clock.open = { start_at: it.body.client_at, category: "service", status: "open", local: true, client_id: it.body.client_id };
  }
  d.waiting = items.length;
  return d;
}

// ------------------------------------------------------------ keeping copies for no signal

const fetched = new Map();      // visit id → its updated_at when its copy was taken
export async function prefetch(ctx, stops = []) {
  if (!online()) return;
  for (const s of stops) {
    const v = s && s.visit;
    if (!v || !v.id || fetched.get(v.id) === v.updated_at) continue;
    fetched.set(v.id, v.updated_at);
    try {
      await ctx.api(`/visits/${encodeURIComponent(v.id)}`, { timeout: 6000 });
      await ctx.api(`/visits/${encodeURIComponent(v.id)}/field`, { timeout: 6000 });
    } catch (e) { fetched.delete(v.id); }
  }
}

// ------------------------------------------------------------ the phone's place and the drive

// The phone's location while the app is open (never in the background), or null.
export function here({ timeout = 4000 } = {}) {
  return new Promise((resolve) => {
    try {
      if (typeof navigator === "undefined" || !navigator.geolocation) return resolve(null);
      let done = false;
      const t = setTimeout(() => { if (!done) { done = true; resolve(null); } }, timeout + 500);
      navigator.geolocation.getCurrentPosition((p) => { if (done) return; done = true; clearTimeout(t); resolve([p.coords.latitude, p.coords.longitude]); },
        () => { if (done) return; done = true; clearTimeout(t); resolve(null); }, { enableHighAccuracy: false, timeout, maximumAge: 120000 });
    } catch (e) { resolve(null); }
  });
}

// Minutes to drive between two points: straight-line miles × 1.3 at 35 mph,
// 5 to 120 (what the On my way sheet starts from; the tech can change it).
export function etaMinutes(from, to) {
  if (!Array.isArray(from) || !Array.isArray(to)) return 15;
  const R = 3958.8;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(to[0] - from[0]), dLng = rad(to[1] - from[1]);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(from[0])) * Math.cos(rad(to[0])) * Math.sin(dLng / 2) ** 2;
  const miles = 2 * R * Math.asin(Math.sqrt(a));
  return Math.max(5, Math.min(120, Math.round(((miles * 1.3) / 35) * 60 / 5) * 5 || 5));
}

// ------------------------------------------------------------ photos as text (they wait in the outbox like the rest)

export async function toBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export const waitingNote = (n) => (n ? html`<p class="tf-wait">${TICONS.cloud}<span>${n === 1 ? "1 change waits" : `${n} changes wait`} for signal. They go out by themselves.</span></p>` : "");

// "7:42 AM" today, "Tue, Nov 17, 7:42 PM" another day (the phone's day).
export const asOfText = (iso) => (localDate(new Date(iso)) === deviceToday() ? fmtTime(iso) : `${dateShort(localDate(new Date(iso)))}, ${fmtTime(iso)}`);
// With the screen's own "no signal" line on it (offlineLine below), the
// office shell around the app hides its offline bar too (netlify/lib/
// office-page.mjs takes crm:offline): one bar, not three. Call from mount.
export function tellShell(el) {
  try {
    if (!el || typeof window === "undefined" || window.parent === window) return;
    window.parent.postMessage({ type: "crm:offline", own: !!el.querySelector(".tf-own-offline") }, location.origin);
  } catch (e) { /* no shell */ }
}

// The screen's one line for no signal (when its copy is from, and what
// waits); with it on screen the app's own offline banner steps aside
// (.tf-own-offline, tech-styles.css), so there is one bar, not three.
export function offlineLine({ offline, as_of, waiting = 0, what = "Your day" } = {}) {
  if (!offline) return waitingNote(waiting);
  const n = waiting ? ` ${waiting === 1 ? "1 change waits" : `${waiting} changes wait`}; they go out by themselves.` : "";
  return html`<p class="tf-wait tf-off"><i class="tf-own-offline" hidden></i>${TICONS.cloud}<span>No signal. ${what} as of ${as_of ? asOfText(as_of) : "the last time it loaded"}.${n}</span></p>`;
}
