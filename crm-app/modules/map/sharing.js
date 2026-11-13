// The phone's side of the team map (docs/CRM-MAP.md "Team map"), started
// once by main.js through the map manifest's start(). It asks the server
// whether this person shares now (GET /map/sharing: the company's switch,
// the person's, and an open shift), and only then, while the app is open
// on screen:
//
//   - asks once on this phone ("Share your location while on the clock?"),
//     and the browser asks for location permission;
//   - sends where the phone is every ~2 minutes (the owner's setting), on
//     clock in, and when a visit starts or finishes (the app's own writes:
//     api.js "wrote");
//   - shows "Sharing your location while on the clock" across the top of
//     every screen, with a button to stop on this phone for the day.
// It stops at once when the server says no (clocked out, turned off), when
// the app goes to the background (iOS stops a home-screen app anyway) and
// when this person stops it. Nothing is kept on the phone but the yes/no.

import { html, render, sheet, toast } from "../../core/ui.js";
import { ensureStyles } from "./kit.js";

let st = null;
const KEY = (uid) => "crm-loc-consent:" + uid;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
const readConsent = (uid) => { try { return JSON.parse(localStorage.getItem(KEY(uid)) || "null"); } catch (e) { return null; } };
const writeConsent = (uid, v) => { try { localStorage.setItem(KEY(uid), JSON.stringify(v)); } catch (e) { /* private mode: asks again */ } };

export function start(app) {
  if (st || typeof window === "undefined" || typeof navigator === "undefined" || !navigator.geolocation || !app || !app.user) return;
  st = { app, uid: app.user.id, sharing: false, every: 120, timer: null, asking: null };
  app.on("wrote", ({ method, path, body } = {}) => {
    if (path === "/clock") { check(body && body.action === "in" ? "clock_in" : "clock"); return; }
    if (!st.sharing) return;
    if (/^\/visits\/[^/]+\/timer$/.test(path || "") && body && body.action === "start") share("visit_start");
    else if (/^\/visits\/[^/]+\/complete$/.test(path || "") || (/^\/visits\/[^/]+\/timer$/.test(path || "") && body && body.action === "finish")) share("visit_finish");
  });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") check("open"); else pause(); });
  // someone clocked in on another phone or the office turned it on: look again now and then
  setInterval(() => { if (!document.hidden && !st.sharing) check("poll"); }, 5 * 60000);
  check("open");
}

async function check(why) {
  if (!st) return;
  let r = null;
  try { r = (await st.app.api("/map/sharing", { cache: false })).data; } catch (e) { return; }
  if (!r || !r.sharing) { stop(); return; }
  st.every = Math.max(60, Number(r.every_s) || 120);
  if (!(await consented())) { stop(); return; }
  if (!st.sharing) { st.sharing = true; bar(true); }
  share(why === "clock_in" ? "clock_in" : "open");
  schedule();
}

function consented() {
  const c = readConsent(st.uid);
  if (c && c.yes) return Promise.resolve(true);
  if (c && c.no === today()) return Promise.resolve(false);
  if (st.asking) return st.asking;
  ensureStyles();
  st.asking = new Promise((resolve) => {
    let answered = false;
    const s = sheet({
      title: "Share your location while on the clock?",
      body: html`<p>Barta's team map shows the office where you are while you're <strong>clocked in and have this app open</strong>: about every ${Math.round(st.every / 60)} minutes, and when you start or finish a visit.</p>
        <p>Nothing is shared when you're clocked out or the app is closed. A bar across the top says when it's on. Positions are deleted after a few weeks.</p>
        <div class="btn-row"><button type="button" class="btn" data-a="no">Not today</button><button type="button" class="btn primary" data-a="yes">Share while on the clock</button></div>`,
      onClose: () => { if (!answered) { st.asking = null; resolve(false); } },
      events: {
        "click [data-a]": (e, b) => {
          answered = true;
          const yes = b.dataset.a === "yes";
          writeConsent(st.uid, yes ? { yes: true, at: new Date().toISOString() } : { no: today() });
          st.asking = null;
          resolve(yes);
          s.close();
        },
      },
    });
  });
  return st.asking;
}

function schedule() {
  clearTimeout(st.timer);
  if (!st.sharing || document.hidden) return;
  st.timer = setTimeout(() => { share("interval"); schedule(); }, st.every * 1000);
}
function pause() { if (st) clearTimeout(st.timer); }
function stop() {
  if (!st) return;
  clearTimeout(st.timer);
  if (st.sharing) bar(false);
  st.sharing = false;
}

function share(why) {
  navigator.geolocation.getCurrentPosition(async (p) => {
    if (!st || !st.sharing) return;
    try {
      const r = await st.app.api("/map/position", { method: "POST", body: { lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy || 0), why }, timeout: 8000 });
      if (r.data && r.data.sharing === false) stop();
      else if (r.data && r.data.every_s) st.every = Math.max(60, r.data.every_s);
    } catch (e) { /* no signal: the next one tries again (positions aren't kept on the phone) */ }
  }, (e) => {
    if (e && e.code === 1 && st && st.sharing) { stop(); toast("Location is off for Barta Office, so the team map can't show you.", { bad: true, ms: 5000 }); }
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
}

// "Sharing your location while on the clock", across the top of every screen.
function bar(on) {
  ensureStyles();
  let el = document.getElementById("loc-bar");
  if (!on) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement("div");
    el.id = "loc-bar";
    el.className = "loc-bar";
    el.setAttribute("role", "status");
    const main = document.getElementById("main") || document.getElementById("view");
    if (main && main.parentNode) main.parentNode.insertBefore(el, main); else document.body.appendChild(el);
    el.addEventListener("click", (e) => { if (e.target.closest("[data-loc]")) details(); });
  }
  render(el, html`<button type="button" class="loc-btn" data-loc><span class="loc-dot" aria-hidden="true"></span><span>Sharing your location while on the clock</span><span class="loc-more">Details</span></button>`);
}

function details() {
  const s = sheet({
    title: "Your location",
    body: html`<p>The office sees where you are on the team map while you're clocked in and this app is open, about every ${Math.round(st.every / 60)} minutes and when you start or finish a visit. It stops when you clock out or close the app.</p>
      <div class="btn-row"><button type="button" class="btn danger" data-stop>Stop on this phone today</button></div>`,
    events: {
      "click [data-stop]": () => { writeConsent(st.uid, { no: today() }); stop(); s.close(); toast("Stopped for today on this phone"); },
    },
  });
}
