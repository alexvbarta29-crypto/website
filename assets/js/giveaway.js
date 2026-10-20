/* Holiday Lights Giveaway entry page (docs/GIVEAWAY.md).
   Served at /giveaway, /giveaway?t=TOKEN (an entrant's private status page)
   and /g/CODE (a friend's share link; a Netlify rewrite, so the code is read
   back out of the path). Talks only to /api/giveaway. */
(function () {
  "use strict";
  const main = document.querySelector(".gw-page");
  if (!main) return;
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
  const API = "/api/giveaway";
  const D = main.dataset;
  const CLOSES = Date.parse(D.closes);
  const DRAW = Date.parse(D.draw);
  const PHONE = D.phone;
  const RADIUS = 20, ORIGIN = { lat: 45.0419, lng: -93.7891 };

  const params = new URLSearchParams(location.search);
  const token = (params.get("t") || "").trim().toUpperCase();
  const wantsClaim = params.get("claim") === "1";
  const pathCode = (location.pathname.match(/\/g\/([A-Za-z0-9-]+)\/?$/) || [])[1] || "";
  const refCode = (pathCode || params.get("ref") || "").trim().toUpperCase();

  const card = $(".gw-card");
  const form = $("[data-gw-form]");
  const title = $("[data-gw-card-title]");
  const sub = $("[data-gw-card-sub]");
  const errBox = $("[data-gw-error]");
  let lastEntry = null;

  const show = (name) => {
    form.hidden = Boolean(name);
    $$("[data-gw-panel]").forEach((p) => { p.hidden = p.dataset.gwPanel !== name; });
    title.hidden = Boolean(name);
    if (sub) sub.hidden = Boolean(name);
    const panel = name && $(`[data-gw-panel="${name}"]`);
    if (panel) {
      panel.focus({ preventScroll: true });
      if (card.getBoundingClientRect().top < 0) card.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    return panel;
  };
  const setText = (panel, sel, v) => $$(sel, panel).forEach((el) => { el.textContent = v; });
  const fail = (box, msg) => { box.textContent = msg; box.hidden = false; };

  /* ---- Countdown: to entries closing, then to the drawing ---- */
  const cd = $("[data-gw-countdown]");
  const cdLabel = $("[data-gw-cd-label]");
  const pad = (n) => String(n).padStart(2, "0");
  const tick = () => {
    const now = Date.now();
    const target = now < CLOSES ? CLOSES : DRAW;
    cdLabel.textContent = now < CLOSES ? "Entries close in" : "Drawing in";
    let left = Math.max(0, target - now);
    if (now >= DRAW) { cd.classList.add("is-done"); cdLabel.textContent = "Winners drawn"; return false; }
    const d = Math.floor(left / 864e5); left -= d * 864e5;
    const h = Math.floor(left / 36e5); left -= h * 36e5;
    const m = Math.floor(left / 6e4); left -= m * 6e4;
    const s = Math.floor(left / 1e3);
    $('[data-cd="d"]', cd).textContent = d;
    $('[data-cd="h"]', cd).textContent = pad(h);
    $('[data-cd="m"]', cd).textContent = pad(m);
    $('[data-cd="s"]', cd).textContent = pad(s);
    return true;
  };
  if (cd && tick()) { const iv = setInterval(() => { if (!tick()) clearInterval(iv); }, 1000); }

  /* ---- Share tools ---- */
  const fillShare = (panel, url, first) => {
    $$("[data-gw-share-url]", panel).forEach((i) => { i.value = url; });
    const msg = `I just entered to win free Christmas lights from Barta Window Washing. Enter with my link and if you win, we both win: ${url}`;
    $$("[data-gw-sms]", panel).forEach((a) => { a.href = "sms:?&body=" + encodeURIComponent(msg); });
    $$("[data-gw-fb]", panel).forEach((a) => {
      a.href = "https://www.facebook.com/sharer/sharer.php?u=" + encodeURIComponent(url);
    });
    $$("[data-gw-native]", panel).forEach((b) => {
      if (!navigator.share) return;
      b.hidden = false;
      b.onclick = () => navigator.share({ title: "Win free Christmas lights", text: msg, url }).catch(() => {});
    });
    $$("[data-gw-copy]", panel).forEach((b) => {
      b.onclick = () => {
        const done = () => { b.textContent = "Copied!"; setTimeout(() => { b.textContent = "Copy"; }, 1800); };
        if (navigator.clipboard) navigator.clipboard.writeText(url).then(done, () => selectCopy(panel, done));
        else selectCopy(panel, done);
      };
    });
    if (first) setText(panel, "[data-gw-name]", first);
  };
  const selectCopy = (panel, done) => {
    const i = $("[data-gw-share-url]", panel);
    i.select();
    try { document.execCommand("copy"); done(); } catch (e) { /* user can copy by hand */ }
  };
  const entryWord = (n) => (n === 1 ? "entry" : "entries");

  /* ---- Private status page (?t=TOKEN) ---- */
  const renderStatus = (e) => {
    const p = show("status");
    setText(p, "[data-gw-name]", e.first_name);
    setText(p, "[data-gw-entries]", String(e.entries));
    setText(p, "[data-gw-entries-word]", entryWord(e.entries));
    const friends = $("[data-gw-friends-line]", p);
    friends.textContent = e.friends.length
      ? `${e.friends.length} ${e.friends.length === 1 ? "friend has" : "friends have"} entered with your link: ${e.friends.join(", ").replace(/\.$/, "")}.`
      : e.open ? "No friends have entered with your link yet. Send it to a few neighbors!" : "";
    fillShare(p, e.share_url, e.first_name);
    $("[data-gw-status-share]", p).hidden = !e.open;
    const now = Date.now();
    $("[data-gw-won]", p).hidden = !e.won;
    const claimed = Boolean(e.coupon.claimed_at);
    $("[data-gw-claimed]", p).hidden = !(e.drawn && !e.won && claimed);
    $("[data-gw-coupon]", p).hidden = !(e.drawn && !e.won && !claimed && e.coupon.available);
    $("[data-gw-expired]", p).hidden = !(e.drawn && !e.won && !claimed && !e.coupon.available
      && now > Date.parse(e.coupon.expires_at));
    const badge = $("[data-gw-status-badge]", p);
    badge.textContent = e.won ? "Winner!" : e.drawn ? "Drawing complete" : "Your entries";
    if (e.drawn && !e.won && !claimed && e.coupon.available && wantsClaim)
      $("[data-gw-coupon]", p).scrollIntoView({ behavior: "smooth", block: "center" });
  };
  const claimBtn = $("[data-gw-claim]");
  if (claimBtn) claimBtn.addEventListener("click", () => {
    const box = $("[data-gw-claim-error]");
    box.hidden = true;
    claimBtn.disabled = true;
    fetch(API, { method: "POST", headers: { "Content-Type": "application/json" },
                 body: JSON.stringify({ action: "claim", t: token }) })
      .then((r) => r.json().then((b) => ({ r, b })))
      .then(({ r, b }) => {
        if (!r.ok || !b.ok) throw new Error(b.error || "");
        $("[data-gw-coupon]").hidden = true;
        $("[data-gw-claimed]").hidden = false;
        if (typeof fbq === "function") fbq("track", "Lead", { content_name: "Giveaway coupon" });
      })
      .catch((err) => {
        claimBtn.disabled = false;
        fail(box, err.message || `That didn't go through. Call or text us at ${PHONE}.`);
      });
  });

  /* ---- "Already entered?" lookup by phone (for people coming from a text) ---- */
  const checkForm = $("[data-gw-check]");
  if (checkForm) checkForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const box = $("[data-gw-check-error]");
    const out = $("[data-gw-check-result]");
    box.hidden = true;
    const btn = $("button", checkForm);
    btn.disabled = true;
    fetch(API, { method: "POST", headers: { "Content-Type": "application/json" },
                 body: JSON.stringify({ action: "lookup", phone: checkForm.phone.value }) })
      .then((r) => r.json().then((b) => ({ r, b })))
      .then(({ r, b }) => {
        btn.disabled = false;
        if (!r.ok || !b.ok) { out.hidden = true; fail(box, b.error || "Something went wrong."); return; }
        fillShare(out, b.share_url, b.first_name);
        setText(out, "[data-gw-entries]", String(b.entries));
        setText(out, "[data-gw-entries-word]", entryWord(b.entries));
        out.hidden = false;
      })
      .catch(() => { btn.disabled = false; fail(box, `We couldn't reach the server. Call or text ${PHONE}.`); });
  });

  if (token) {
    title.textContent = "Your entries";
    form.hidden = true;
    fetch(API + "?t=" + encodeURIComponent(token), { headers: { Accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((b) => renderStatus(b.entrant))
      .catch(() => show("notfound"));
    return;
  }

  if (Date.now() > CLOSES) { show("closed"); return; }

  /* ---- Invited by a friend (/g/CODE) ---- */
  if (refCode) {
    fetch(API + "?code=" + encodeURIComponent(refCode), { headers: { Accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => {
        if (!b || !b.ok) return;
        const who = b.last_initial ? `${b.first_name} ${b.last_initial}.` : b.first_name;
        $("[data-gw-invite-text]").textContent =
          `${who} invited you! Enter below, and if you win, ${b.first_name} wins too.`;
        $("[data-gw-invite]").hidden = false;
      }).catch(() => {});
  }

  /* ---- Instant service-area feedback on an address pick ---- */
  const areaNote = $("[data-gw-area]");
  const toRad = (d) => (d * Math.PI) / 180;
  const miles = (a, b) => {
    const h = Math.sin(toRad(b.lat - a.lat) / 2) ** 2
      + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(toRad(b.lng - a.lng) / 2) ** 2;
    return 2 * 3958.8 * Math.asin(Math.sqrt(h));
  };
  form.addEventListener("address:picked", (ev) => {
    const d = ev.detail || {};
    areaNote.hidden = true;
    areaNote.className = "gw-area";
    if (!Number.isFinite(d.lat) || !Number.isFinite(d.lng)) return;
    const mi = miles(ORIGIN, d);
    if (mi <= RADIUS) {
      areaNote.textContent = "✓ You're in our service area.";
      areaNote.classList.add("is-in");
    } else {
      areaNote.textContent = "That address looks outside our service area (about " + Math.round(mi) + " miles from Delano).";
      areaNote.classList.add("is-out");
    }
    areaNote.hidden = false;
  });
  form.addEventListener("address:cleared", () => { areaNote.hidden = true; });

  /* ---- Submit ---- */
  const submitBtn = $(".gw-submit", form);
  const btnHTML = submitBtn.innerHTML;
  const fieldFor = (name) => form.querySelector(name === "address" ? "#gw-address"
    : /^(first|last)_name$/.test(name) ? "#gw-name" : `[name="${name}"]`);
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    errBox.hidden = true;
    $$("[aria-invalid]", form).forEach((el) => el.removeAttribute("aria-invalid"));
    if (!form.checkValidity()) { form.reportValidity(); return; }
    const data = Object.fromEntries(new FormData(form).entries());
    // One "Your name" box: first word is the first name, the rest the last.
    const parts = String(data.name || "").trim().split(/\s+/);
    data.first_name = parts.shift() || "";
    data.last_name = parts.join(" ");
    data.consent = form.querySelector('[name="consent"]').checked;
    data.offers = form.querySelector('[name="offers"]').checked;
    data.ref = refCode;
    data.page = location.pathname;
    lastEntry = data;
    submitBtn.disabled = true;
    submitBtn.textContent = "Entering…";
    fetch(API, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
                 body: JSON.stringify(data) })
      .then((r) => r.json().catch(() => ({})).then((b) => ({ r, b })))
      .then(({ r, b }) => {
        submitBtn.disabled = false;
        submitBtn.innerHTML = btnHTML;
        if (r.status === 422 && b.out_of_area) { show("outside"); return; }
        if (r.status === 410) { show("closed"); return; }
        if (!r.ok || !b.ok) {
          fail(errBox, b.error || `Something went wrong. Call or text us at ${PHONE}.`);
          const f = b.field && fieldFor(b.field);
          if (f) { f.setAttribute("aria-invalid", "true"); f.focus(); }
          return;
        }
        if (b.returning) {
          const p = show("returning");
          fillShare(p, b.share_url, b.first_name);
          return;
        }
        const p = show("done");
        fillShare(p, b.share_url, b.first_name);
        setText(p, "[data-gw-entries]", String(b.entries || 1));
        setText(p, "[data-gw-entries-word]", entryWord(b.entries || 1));
        $$("[data-gw-status]", p).forEach((a) => { a.href = b.status_url; });
        if (typeof fbq === "function") fbq("track", "Lead", { content_name: "Giveaway entry" });
        if (typeof gtag === "function") gtag("event", "generate_lead", { form_name: "giveaway" });
      })
      .catch(() => {
        submitBtn.disabled = false;
        submitBtn.innerHTML = btnHTML;
        fail(errBox, `We couldn't reach the server. Check your connection, or call or text ${PHONE}.`);
      });
  });

  /* ---- Out of area: offer a free quote anyway ---- */
  const yes = $("[data-gw-outside-yes]");
  yes.addEventListener("click", () => {
    const box = $("[data-gw-outside-error]");
    box.hidden = true;
    yes.disabled = true;
    fetch(API, { method: "POST", headers: { "Content-Type": "application/json" },
                 body: JSON.stringify({ ...lastEntry, action: "outside_quote" }) })
      .then((r) => r.json().then((b) => ({ r, b })))
      .then(({ r, b }) => {
        if (!r.ok || !b.ok) throw new Error(b.error || "");
        show("outside-done");
      })
      .catch((err) => { yes.disabled = false; fail(box, err.message || `Please call or text ${PHONE}.`); });
  });
  $("[data-gw-outside-no]").addEventListener("click", () => {
    show(null);
    const a = $("#gw-address");
    a.focus();
    a.select();
  });
})();
