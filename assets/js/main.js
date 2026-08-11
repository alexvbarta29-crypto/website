/* =====================================================================
   Barta Window Washing — Interactions
   Vanilla JS, no dependencies. Progressive enhancement.
   ===================================================================== */
(function () {
  "use strict";
  const $ = (s, c = document) => c.querySelector(s);
  const $$ = (s, c = document) => Array.from(c.querySelectorAll(s));
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---- Sticky nav shadow on scroll ---- */
  const navWrap = $(".nav-wrap");
  if (navWrap) {
    const onScroll = () => navWrap.classList.toggle("scrolled", window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
  }

  /* ---- Mobile drawer ---- */
  const drawer = $(".drawer");
  const openBtn = $(".nav-toggle");
  const closeBtn = $(".drawer-close");
  const scrim = $(".drawer-scrim");
  const toggle = (open) => {
    if (!drawer) return;
    const wasOpen = drawer.classList.contains("open");
    drawer.classList.toggle("open", open);
    document.body.style.overflow = open ? "hidden" : "";
    if (openBtn) openBtn.setAttribute("aria-expanded", String(open));
    // Move focus into the dialog when it opens (it's role="dialog"
    // aria-modal="true"), and back to the toggle button on close, so
    // keyboard users land somewhere sensible instead of on a hidden panel.
    // Guarded by wasOpen so e.g. pressing Escape while the drawer is
    // already closed doesn't yank focus to the hamburger button.
    if (open && !wasOpen) { if (closeBtn) closeBtn.focus(); }
    else if (!open && wasOpen) { if (openBtn) openBtn.focus(); }
  };
  if (openBtn) openBtn.addEventListener("click", () => toggle(true));
  if (closeBtn) closeBtn.addEventListener("click", () => toggle(false));
  if (scrim) scrim.addEventListener("click", () => toggle(false));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") toggle(false); });
  $$(".drawer-nav a, .drawer-foot a").forEach((a) => a.addEventListener("click", () => toggle(false)));

  /* ---- Reveal on scroll ---- */
  const reveals = $$(".reveal");
  if (reveals.length && "IntersectionObserver" in window && !reduce) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); }
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -8% 0px" });
    reveals.forEach((el) => io.observe(el));
  } else {
    reveals.forEach((el) => el.classList.add("in"));
  }

  /* ---- Lazy-load the 3rd-party Google reviews widget (Trustindex) only as
         its section nears the viewport, so it never delays first paint.
         The curated cards underneath are real, visible HTML from the start —
         this only swaps in the live widget once (and never removes the
         "see all reviews" link, which is static markup either way). ---- */
  $$("[data-lazy-reviews]").forEach((el) => {
    const b64 = el.dataset.widgetB64;
    if (!b64) return;
    const load = () => {
      let html;
      try { html = atob(b64); } catch (err) { return; }
      const temp = document.createElement("div");
      temp.innerHTML = html;
      // innerHTML-inserted <script> tags are inert — recreate each one so
      // the widget's loader actually executes.
      temp.querySelectorAll("script").forEach((old) => {
        const s = document.createElement("script");
        [...old.attributes].forEach((a) => s.setAttribute(a.name, a.value));
        s.textContent = old.textContent;
        old.replaceWith(s);
      });
      const fallback = el.querySelector("[data-reviews-fallback]");
      if (fallback) fallback.replaceWith(temp);
      else el.insertBefore(temp, el.firstChild);
    };
    if ("IntersectionObserver" in window) {
      const io = new IntersectionObserver((entries) => {
        entries.forEach((en) => { if (en.isIntersecting) { load(); io.unobserve(en.target); } });
      }, { rootMargin: "600px 0px" });
      io.observe(el);
    } else {
      load();
    }
  });

  /* ---- Lazy-load Instagram video posters ----
         A <video poster> takes a single URL, can't carry a srcset, and — unlike
         an <img> — has no loading="lazy", so the browser fetches every poster
         on page load even though the carousel sits far down the homepage. That
         was ~800 KB before a visitor scrolled anywhere. The build emits the URL
         as data-poster instead, and the whole set is promoted once the carousel
         itself nears the viewport.

         Observing the carousel rather than each <video> is deliberate.
         .insta-track is a horizontal scroller several thousand px wide, so most
         cards sit outside it and an intermediate scroll container CLIPS the
         intersection rectangle — rootMargin only inflates the root (the
         viewport), never an ancestor clipper, so per-card observers simply
         never fire for anything scrolled out of the track. Watching the
         container sidesteps that and still costs nothing until you scroll down
         to the section. Without IntersectionObserver, every poster is set
         immediately — same behaviour as before this existed. ---- */
  const setPoster = (v) => {
    if (v.dataset.poster) { v.poster = v.dataset.poster; delete v.dataset.poster; }
  };
  $$(".insta-carousel").forEach((car) => {
    const load = () => $$("video[data-poster]", car).forEach(setPoster);
    if ("IntersectionObserver" in window) {
      const pio = new IntersectionObserver((entries) => {
        entries.forEach((en) => { if (en.isIntersecting) { load(); pio.unobserve(en.target); } });
      }, { rootMargin: "600px 0px" });
      pio.observe(car);
    } else {
      load();
    }
  });

  /* ---- Christmas early-bird countdown ----
         Ticks down to December 1st in the visitor's own timezone. The build
         seeds the numbers server-side so first paint is already correct;
         this only keeps them live. After the deadline passes, the target
         rolls to next year's December 1st — the offer is seasonal and the
         banner text ("Deal Ends December 1st") stays true either way, so
         the timer never sits at zero for eleven months. ---- */
  const cdown = $("[data-countdown]");
  if (cdown) {
    const cd = (k) => $('[data-cd="' + k + '"]', cdown);
    const els = { d: cd("d"), h: cd("h"), m: cd("m"), s: cd("s") };
    const pad = (n) => String(n).padStart(2, "0");
    const tick = () => {
      const now = new Date();
      let t = new Date(now.getFullYear(), 11, 1);
      if (t <= now) t = new Date(now.getFullYear() + 1, 11, 1);
      const secs = Math.max(0, Math.floor((t - now) / 1000));
      els.d.textContent = pad(Math.floor(secs / 86400));
      els.h.textContent = pad(Math.floor(secs / 3600) % 24);
      els.m.textContent = pad(Math.floor(secs / 60) % 60);
      els.s.textContent = pad(secs % 60);
    };
    tick();
    setInterval(tick, 1000);
  }

  /* ---- Animated counters ---- */
  const counters = $$("[data-count]");
  const runCount = (el) => {
    const target = parseFloat(el.dataset.count);
    const dec = (el.dataset.count.split(".")[1] || "").length;
    const suffix = el.dataset.suffix || "";
    const prefix = el.dataset.prefix || "";
    const dur = 1600;
    let start = null;
    const tick = (ts) => {
      if (!start) start = ts;
      const p = Math.min((ts - start) / dur, 1);
      const eased = 1 - Math.pow(1 - p, 3);
      const val = target * eased;
      el.textContent = prefix + val.toFixed(dec).replace(/\B(?=(\d{3})+(?!\d))/g, ",") + suffix;
      if (p < 1) requestAnimationFrame(tick);
      else el.textContent = prefix + target.toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec }) + suffix;
    };
    requestAnimationFrame(tick);
  };
  if (counters.length && "IntersectionObserver" in window && !reduce) {
    const cio = new IntersectionObserver((entries) => {
      entries.forEach((en) => { if (en.isIntersecting) { runCount(en.target); cio.unobserve(en.target); } });
    }, { threshold: 0.5 });
    counters.forEach((el) => cio.observe(el));
  } else {
    counters.forEach((el) => { el.textContent = (el.dataset.prefix || "") + el.dataset.count + (el.dataset.suffix || ""); });
  }

  /* ---- Before / After sliders ---- */
  $$(".ba").forEach((ba) => {
    const after = $(".ba-after", ba);
    const handle = $(".ba-handle", ba);
    const knob = $(".ba-knob", ba);
    const range = $(".ba-range", ba);
    const set = (pct) => {
      pct = Math.max(0, Math.min(100, pct));
      if (after) after.style.clipPath = `inset(0 0 0 ${pct}%)`;
      if (handle) handle.style.left = pct + "%";
      if (knob) knob.style.left = pct + "%";
    };
    if (range) {
      range.addEventListener("input", () => set(parseFloat(range.value)));
      set(parseFloat(range.value || 50));
    }
    // Pointer drag fallback
    let dragging = false;
    const fromEvent = (e) => {
      const r = ba.getBoundingClientRect();
      const x = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
      const pct = (x / r.width) * 100;
      if (range) range.value = pct;
      set(pct);
    };
    const startDrag = (e) => { dragging = true; fromEvent(e); };
    const moveDrag = (e) => { if (dragging) { fromEvent(e); } };
    const endDrag = () => { dragging = false; };
    ba.addEventListener("pointerdown", startDrag);
    window.addEventListener("pointermove", moveDrag);
    window.addEventListener("pointerup", endDrag);
  });

  /* ---- Process slider (Mop / Scrub / Squeegee / Detail) — auto-advances
         every AUTOADVANCE_MS; the line ahead of the active dot fills in
         real time over that same span, acting as a live countdown to the
         next step instead of just snapping over when the step changes. ---- */
  const AUTOADVANCE_MS = 16000;
  $$(".process-slider").forEach((slider) => {
    const slides = $$(".process-slide", slider);
    const dots = $$(".process-dot", slider);
    const lines = $$(".process-line", slider);
    const prev = $(".process-arrow.prev", slider);
    const next = $(".process-arrow.next", slider);
    const SWEEP_MS = 460; // total travel time for the bar, however many segments move
    let i = 0, timer = null, liveLine = null, liveTimer = null;

    /* Current fill of a segment, 0..1, read off the pseudo-element's live
       transform matrix — accurate even mid-transition. */
    const progressOf = (l) => {
      const t = getComputedStyle(l, "::after").transform;
      if (!t || t === "none") return l.classList.contains("filled") ? 1 : 0;
      const m = t.match(/matrix\(([^,]+)/);
      return m ? Math.min(1, Math.max(0, parseFloat(m[1]))) : 0;
    };
    /* Pin a segment exactly where it is, with no transition, so whatever we
       drive it to next animates FROM here. This is what removes the snap:
       a CSS transition can't be re-timed mid-flight, but it can be stopped
       at its current position and restarted toward a new target. */
    const freeze = (l) => {
      const p = progressOf(l);
      l.style.setProperty("--line-dur", "0s");
      l.style.setProperty("--line-delay", "0s");
      l.style.setProperty("--line-scale", p);
      l.classList.remove("filled");
      void l.offsetWidth;
      return p;
    };
    const drive = (l, to, dur, delay, ease) => {
      l.style.setProperty("--line-dur", `${dur}ms`);
      l.style.setProperty("--line-delay", `${delay}ms`);
      l.style.setProperty("--line-ease", ease || "linear");
      if (to >= 1) {
        l.classList.add("filled");
      } else {
        // dropping .filled matters as much as setting the scale: on a full
        // segment the class pins the transform at 1 and would override it
        l.style.setProperty("--line-scale", to);
        l.classList.remove("filled");
      }
    };

    const show = (n) => {
      clearTimeout(liveTimer);
      i = (n + slides.length) % slides.length;
      slides.forEach((s, idx) => s.classList.toggle("active", idx === i));
      dots.forEach((d, idx) => {
        d.classList.toggle("active", idx === i);
        d.classList.toggle("filled", idx <= i);
      });

      /* Pin the in-flight countdown wherever it happens to be. From here it's
         just a partially-filled segment like any other, and the sweep below
         continues its motion — forward to full or retracting to empty —
         instead of blanking it and starting over. On a normal auto-advance
         it sits at ~100%, so its remaining travel is ~0 and the handoff to
         the next segment's countdown is seamless. */
      if (liveLine) { freeze(liveLine); liveLine = null; }

      /* Segments move one after another — each starts as the previous ends —
         so any jump reads as a single line travelling the bar. Time is split
         by how far each segment actually has to travel (a pinned segment may
         only have a fraction left), keeping the sweep's speed constant. */
      const fillLegs = [];   // left-to-right toward the active dot
      const emptyLegs = [];  // right-to-left back toward it
      lines.forEach((l, idx) => {
        let from = l.classList.contains("filled") ? 1 : progressOf(l);
        // pin anything caught mid-flight (a leg of an interrupted sweep), so
        // the new sweep's timing applies to it instead of the stale one's
        if (from > 0 && from < 1) from = freeze(l);
        if (idx < i) {
          if (from < 1) fillLegs.push({ l, dist: 1 - from });
        } else if (from > 0) {
          emptyLegs.push({ l, dist: from });
        }
      });
      emptyLegs.reverse(); // retract starts from the rightmost segment

      const run = (legs, to) => {
        const total = legs.reduce((s, x) => s + x.dist, 0);
        if (!total) return 0;
        // one leg gets a soft curve; chained legs stay linear so the joined
        // motion doesn't pulse at each segment boundary
        const ease = legs.length === 1 ? "cubic-bezier(.4,0,.2,1)" : "linear";
        let at = 0;
        legs.forEach(({ l, dist }) => {
          const dur = Math.max(1, SWEEP_MS * (dist / total));
          drive(l, to, dur, at, ease);
          at += dur;
        });
        return at;
      };
      const fillDone = run(fillLegs, 1);
      const emptyDone = run(emptyLegs, 0);

      /* Live countdown on the segment ahead of the active dot: wait for the
         sweep to finish, then crawl to full across the rest of the dwell so
         it lands just as the next step arrives. Scheduled with a timeout
         rather than a CSS delay because when stepping backwards this same
         segment is retracting as part of the sweep above — re-targeting it
         to full in the same tick would cancel that retract, leaving the bar
         stuck at 1 instead of visibly emptying first. */
      if (!reduce && lines[i]) {
        const l = lines[i];
        liveLine = l;
        const wait = Math.max(fillDone, emptyDone);
        liveTimer = setTimeout(() => {
          if (liveLine !== l) return; // superseded by a later step change
          freeze(l);
          l.addEventListener("transitionend", () => { if (liveLine === l) liveLine = null; }, { once: true });
          drive(l, 1, Math.max(1000, AUTOADVANCE_MS - wait), 0, "linear");
        }, wait + 20);
      }
    };
    const restart = () => {
      if (timer) clearInterval(timer);
      if (!reduce && slides.length > 1) timer = setInterval(() => show(i + 1), AUTOADVANCE_MS);
    };
    dots.forEach((d, idx) => d.addEventListener("click", () => { show(idx); restart(); }));
    if (prev) prev.addEventListener("click", () => { show(i - 1); restart(); });
    if (next) next.addEventListener("click", () => { show(i + 1); restart(); });
    show(0);
    restart();
  });

  /* ---- Phone validation: require a real 10-digit US number ---- */
  $$("input[data-validate-phone]").forEach((input) => {
    const check = () => {
      const digits = input.value.replace(/\D/g, "").replace(/^1/, "");
      input.setCustomValidity(digits.length === 10 ? "" : "Please enter a valid 10-digit phone number.");
    };
    input.addEventListener("input", check);
    check();
  });

  /* ---- Address autocomplete (OpenStreetMap Nominatim — free, keyless).
         Suggestions drop down as you type; picking one marks the address
         verified so every lead carries a real, mappable address. When the
         field has sibling city/zip inputs (the quote wizard), the picked
         suggestion's structured address also fills those in, confirming
         the town is a real, geocodable place. ---- */
  $$("input[data-address-input]").forEach((input) => {
    const wrap = input.closest(".field") || input.parentElement;
    const panel = input.closest(".wizard-panel") || input.closest("form") || wrap;
    const list = wrap.querySelector("[data-address-list]");
    const verified = wrap.querySelector("[data-address-verified]");
    const cityField = panel.querySelector("[data-address-city]");
    const zipField = panel.querySelector("[data-address-zip]");
    const status = panel.querySelector("[data-address-status]");
    if (!list) return;
    let timer = null, aborter = null;
    const close = () => { list.hidden = true; list.innerHTML = ""; };
    const search = () => {
      const q = input.value.trim();
      if (q.length < 4) { close(); return; }
      if (aborter) aborter.abort();
      aborter = new AbortController();
      // Immediate feedback so a slow network read doesn't just look frozen —
      // Nominatim (free, keyless) typically answers in a few hundred ms, but
      // there's no way to make a public rate-limited API instant.
      list.innerHTML = '<li class="addr-loading" aria-disabled="true">Searching…</li>';
      list.hidden = false;
      const url = "https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=5&countrycodes=us" +
        "&viewbox=-94.3,45.4,-93.2,44.7&bounded=0&q=" + encodeURIComponent(q);
      fetch(url, { signal: aborter.signal, headers: { Accept: "application/json" } })
        .then((r) => r.json())
        .then((results) => {
          list.innerHTML = "";
          if (!results.length) { close(); return; }
          results.forEach((r) => {
            const addr = r.address || {};
            const road = [addr.house_number, addr.road].filter(Boolean).join(" ");
            const cityName = addr.city || addr.town || addr.village || addr.hamlet || "";
            // Keep suggestions to street, city, state, ZIP — no county/country clutter.
            const short = [road, cityName, addr.state, addr.postcode].filter(Boolean).join(", ");
            const li = document.createElement("li");
            li.textContent = short || r.display_name;
            li.setAttribute("role", "option");
            li.addEventListener("mousedown", (e) => {
              e.preventDefault();
              input.value = road || r.display_name;
              if (cityField) cityField.value = cityName || cityField.value;
              if (zipField) zipField.value = addr.postcode || zipField.value;
              if (verified) verified.value = "yes";
              if (status) status.hidden = true;
              close();
            });
            list.appendChild(li);
          });
          list.hidden = false;
        })
        .catch(() => close());
    };
    input.addEventListener("input", () => {
      if (verified) verified.value = "no";
      clearTimeout(timer);
      timer = setTimeout(search, 220);
    });
    input.addEventListener("blur", () => setTimeout(close, 150));
  });

  /* ---- Pre-check services: ?svc= param wins, else the page's default ---- */
  const params = new URLSearchParams(location.search);
  const svcParam = params.get("svc");
  $$("[data-service-checks]").forEach((group) => {
    const wanted = svcParam ? [svcParam] : (group.dataset.defaultSvc || "").split(",").filter(Boolean);
    group.querySelectorAll("input[data-svc]").forEach((cb) => {
      if (wanted.includes(cb.dataset.svc)) cb.checked = true;
    });
  });
  const planParam = params.get("plan");
  if (planParam) {
    $$("[data-plan-field]").forEach((f) => { f.value = planParam; });
    $$(`input[name="plan_choice"][value="${planParam}"]`).forEach((r) => { r.checked = true; });
    const badge = $("[data-plan-badge]");
    if (badge) {
      const names = { monthly: "Monthly Plan", quarterly: "Quarterly Plan", biannual: "Biannual Plan" };
      badge.textContent = names[planParam] || planParam;
      badge.parentElement.hidden = false;
    }
  }

  /* ---- Lead form (demo handler) ---- */
  $$("form[data-lead]").forEach((form) => {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const checks = form.querySelectorAll('input[name="services"]');
      if (checks.length && ![...checks].some((c) => c.checked)) {
        checks[0].setCustomValidity("Please select at least one service.");
        form.reportValidity();
        checks.forEach((c) => c.addEventListener("change", () => checks[0].setCustomValidity(""), { once: true }));
        return;
      }
      const addrVerified = form.querySelector("[data-address-verified]");
      if (addrVerified && addrVerified.value !== "yes") {
        const status = form.querySelector("[data-address-status]");
        if (status) status.hidden = false;
        const addrInput = form.querySelector("[data-address-input]");
        if (addrInput) addrInput.focus();
        return;
      }
      if (!form.checkValidity()) { form.reportValidity(); return; }

      const success = form.parentElement.querySelector(".form-success");
      const fallback = form.parentElement.querySelector(".form-fallback");
      const submitBtn = form.querySelector('button[type="submit"]');
      // innerHTML, not textContent — the label carries an inline arrow icon
      // that has to survive the "Sending…" swap.
      const submitLabel = submitBtn ? submitBtn.innerHTML : "";
      const endpoint = form.dataset.endpoint;

      const showSuccess = () => {
        form.classList.add("sent");
        if (success) { success.classList.add("show"); success.setAttribute("role", "status"); }
        const wizardFill = $("[data-wizard-fill]", form.closest(".wizard") || form);
        if (wizardFill) wizardFill.style.width = "100%";
      };
      // Never claim a submission landed when it didn't — send the visitor to
      // the phone/email instead, with their answers still on screen.
      const showFallback = () => {
        if (fallback) {
          fallback.hidden = false;
          fallback.setAttribute("role", "alert");
          fallback.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
        }
        if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = submitLabel; }
      };

      const data = Object.fromEntries(new FormData(form).entries());
      data.services = [...form.querySelectorAll('input[name="services"]:checked')].map((c) => c.value);
      data.page = location.pathname;
      if (form.dataset.subject) data.subject = form.dataset.subject;
      if (form.dataset.accessKey) data.access_key = form.dataset.accessKey;

      if (!endpoint) { showFallback(); return; }

      if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "Sending…"; }

      fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(data),
      })
        .then((res) => { if (!res.ok) throw new Error("HTTP " + res.status); return res; })
        .then(showSuccess)
        .catch(showFallback);
    });
  });

  /* ---- Quote wizard: step-by-step reveal with a top progress bar ---- */
  $$(".wizard").forEach((wizard) => {
    const form = $(".wizard-form", wizard);
    const panels = $$(".wizard-panel", form);
    const fill = $("[data-wizard-fill]", wizard);
    let step = 0;

    const show = (n, scroll) => {
      step = Math.max(0, Math.min(n, panels.length - 1));
      panels.forEach((p, i) => { p.hidden = i !== step; });
      if (fill) fill.style.width = (step / (panels.length - 1)) * 100 + "%";
      if (scroll) window.scrollTo({ top: 0, behavior: "smooth" });
    };

    const validateStep = () => {
      const panel = panels[step];
      const fields = [...panel.querySelectorAll("input, select, textarea")]
        .filter((el) => el.type !== "hidden" && el.name !== "services");
      const invalid = fields.find((el) => !el.checkValidity());
      if (invalid) { invalid.reportValidity(); return false; }

      const svcChecks = panel.querySelectorAll('input[name="services"]');
      if (svcChecks.length && ![...svcChecks].some((c) => c.checked)) {
        svcChecks[0].setCustomValidity("Please select at least one service.");
        svcChecks[0].reportValidity();
        svcChecks.forEach((c) => c.addEventListener("change", () => svcChecks[0].setCustomValidity(""), { once: true }));
        return false;
      }
      if (svcChecks.length) svcChecks.forEach((c) => c.setCustomValidity(""));

      const addrInput = panel.querySelector("[data-address-input]");
      if (addrInput) {
        const verified = panel.querySelector("[data-address-verified]");
        const status = panel.querySelector("[data-address-status]");
        if (!verified || verified.value !== "yes") {
          if (status) status.hidden = false;
          addrInput.focus();
          return false;
        }
        if (status) status.hidden = true;
      }
      return true;
    };

    $$("[data-wizard-next]", form).forEach((btn) => btn.addEventListener("click", () => {
      if (validateStep()) show(step + 1, true);
    }));
    $$("[data-wizard-back]", form).forEach((btn) => btn.addEventListener("click", () => show(step - 1, true)));
    show(0, false);
  });

  /* ---- Christmas Lights: the page's own "get a quote" links open an
         on-page modal instead of navigating to the general quote flow.
         No-ops on every other page since the modal simply isn't there. ---- */
  const xmasModal = $("#xmas-quote-modal");
  if (xmasModal) {
    const openXmas = (e) => { if (e) e.preventDefault(); xmasModal.hidden = false; document.body.style.overflow = "hidden"; };
    const closeXmas = () => { xmasModal.hidden = true; document.body.style.overflow = ""; };
    $$('a[href*="get-quote.html"]').forEach((a) => a.addEventListener("click", openXmas));
    $$("[data-xmas-close]", xmasModal).forEach((el) => el.addEventListener("click", closeXmas));
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !xmasModal.hidden) closeXmas(); });
  }

  /* ---- Instagram carousel: arrow buttons, a self-running auto-advance
         when nobody's touching it, and shared video-pausing so scrolling
         past several video posts doesn't stack up audio. Auto-advance moves
         one card at a time on a fixed interval and bounces back and forth
         at the ends rather than jumping, pauses on hover/touch/drag/
         arrow-click and while a video is playing, and only runs while the
         row is actually on screen. Uses a self-rescheduling timeout (not
         setInterval) tied to real scroll activity — not just pointerup —
         so it never yanks the row out from under a still-settling swipe;
         a touch fling keeps scrolling well after the finger lifts, and the
         old fixed 1200ms-after-pointerup resume used to fight that native
         momentum scroll, which read as the carousel "jumping" mid-browse. */
  $$(".insta-carousel").forEach((carousel) => {
    const track = $(".insta-track", carousel);
    const prev = $(".insta-arrow.prev", carousel);
    const next = $(".insta-arrow.next", carousel);
    if (!track) return;

    const videos = $$(".insta-card-media-el", track).filter((v) => v.tagName === "VIDEO");
    videos.forEach((v) => v.addEventListener("play", () => videos.forEach((o) => { if (o !== v) o.pause(); })));

    const step = () => Math.min(track.clientWidth * 0.8, 420);
    if (prev && next) {
      prev.addEventListener("click", () => { pauseAuto(); resumeAuto(); track.scrollBy({ left: -step(), behavior: reduce ? "auto" : "smooth" }); });
      next.addEventListener("click", () => { pauseAuto(); resumeAuto(); track.scrollBy({ left: step(), behavior: reduce ? "auto" : "smooth" }); });
    }

    const cards = $$(".insta-card", track);
    if (cards.length < 2) return;

    const INTERVAL = 3000; // ms between slides once settled
    const RESUME_DELAY = 2200; // grace period after the user stops interacting
    const SCROLL_SETTLE = 400; // how long scrolling must be quiet before we call it "stopped"
    let dir = 1, inView = false, timer = null, settleTimer = null;

    /* Below 640px the track shows one card at a time and the CSS snaps on
       centre, so the slide being shown should land in the middle of the
       screen rather than flush against the left edge. Above that several
       cards are visible at once and leading-edge alignment is correct, so
       this stays off. The query matches the breakpoint in styles.css — if
       the two disagreed, JS would scroll to one position and snapping would
       drag it to another. */
    const oneUp = window.matchMedia("(max-width: 640px)");
    const centred = () => oneUp.matches;
    const targetFor = (c) => centred()
      ? c.offsetLeft - (track.clientWidth - c.offsetWidth) / 2
      : c.offsetLeft;

    /* Without end padding the browser clamps scrollLeft to 0 and to the far
       end, so the first and last cards can never actually sit centred. */
    const padEnds = () => {
      const last = cards[cards.length - 1];
      const lead = centred() ? Math.max(4, (track.clientWidth - cards[0].offsetWidth) / 2) : 4;
      const tail = centred() ? Math.max(4, (track.clientWidth - last.offsetWidth) / 2) : 4;
      track.style.paddingLeft = lead + "px";
      track.style.paddingRight = tail + "px";
    };
    padEnds();
    window.addEventListener("resize", padEnds);
    if (oneUp.addEventListener) oneUp.addEventListener("change", padEnds);

    const currentIndex = () => {
      let idx = 0, best = Infinity;
      cards.forEach((c, i) => {
        const d = Math.abs(targetFor(c) - track.scrollLeft);
        if (d < best) { best = d; idx = i; }
      });
      return idx;
    };
    const schedule = (delay) => { clearTimeout(timer); timer = setTimeout(advance, delay); };
    const pauseAuto = () => clearTimeout(timer);
    const resumeAuto = () => schedule(RESUME_DELAY);
    const advance = () => {
      if (!inView || videos.some((v) => !v.paused)) { schedule(INTERVAL); return; }
      const max = cards.length - 1;
      let idx = currentIndex() + dir;
      if (idx >= max) { idx = max; dir = -1; }
      else if (idx <= 0) { idx = 0; dir = 1; }
      track.scrollTo({ left: targetFor(cards[idx]), behavior: reduce ? "auto" : "smooth" });
      schedule(INTERVAL);
    };
    if (!reduce) {
      track.addEventListener("pointerenter", pauseAuto);
      track.addEventListener("pointerleave", resumeAuto);
      track.addEventListener("pointerdown", pauseAuto);
      track.addEventListener("scroll", () => {
        pauseAuto();
        clearTimeout(settleTimer);
        settleTimer = setTimeout(resumeAuto, SCROLL_SETTLE);
      }, { passive: true });
      new IntersectionObserver((entries) => { inView = entries[0].isIntersecting; },
        { threshold: 0.2 }).observe(track);
      schedule(INTERVAL);
    }
  });

  /* ---- Service picture cards on touch devices: the card is a link, so a
         plain tap would navigate before the description ever showed. First
         tap reveals it (blurring the photo behind it, see .revealed in the
         CSS), second tap follows the link. Only one card stays open at a
         time, and tapping anywhere else closes it. Pointer devices are left
         alone entirely — they reveal on hover and navigate on first click. ---- */
  if (window.matchMedia("(hover: none)").matches) {
    const picCards = $$(".img-card");
    const closeAll = (except) => picCards.forEach((c) => { if (c !== except) c.classList.remove("revealed"); });
    picCards.forEach((card) => {
      card.addEventListener("click", (e) => {
        if (card.classList.contains("revealed")) return; // already open — let the link through
        e.preventDefault();
        closeAll(card);
        card.classList.add("revealed");
      });
    });
    if (picCards.length) {
      document.addEventListener("click", (e) => { if (!e.target.closest(".img-card")) closeAll(null); });
    }
  }

  /* ---- Active nav state ---- */
  const path = location.pathname.split("/").pop() || "index.html";
  $$(".nav-links a, .drawer-nav a").forEach((a) => {
    const href = a.getAttribute("href");
    if (href && href.split("/").pop() === path) a.setAttribute("aria-current", "page");
  });

  /* ---- Footer year ---- */
  const yr = $("#year");
  if (yr) yr.textContent = new Date().getFullYear();
})();
