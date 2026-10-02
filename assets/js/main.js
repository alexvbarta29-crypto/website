/* =====================================================================
   Barta Window Washing — Interactions
   Vanilla JS, no dependencies. Progressive enhancement.
   ===================================================================== */
(function () {
  "use strict";
  const $ = (s, c = document) => c.querySelector(s);
  const $$ = (s, c = document) => Array.from(c.querySelectorAll(s));
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* Open a connection to a third-party origin just before it's needed,
     instead of holding permanent preconnects in the page head. Set-guarded
     so each origin gets exactly one link no matter how many callers ask. */
  const preconnected = new Set();
  const preconnect = (origin) => {
    if (preconnected.has(origin)) return;
    preconnected.add(origin);
    const l = document.createElement("link");
    l.rel = "preconnect";
    l.href = origin;
    document.head.appendChild(l);
  };

  /* ---- Sticky nav shadow on scroll ---- */
  /* A 1px sentinel parked 12px down the document, watched by an
     IntersectionObserver: the moment it scrolls out of the viewport the
     page is past 12px and the shadow goes on. The old handler read
     window.scrollY, and its initial call during script evaluation forced
     the document's entire first style+layout pass synchronously inside the
     script task — Lighthouse attributed ~166ms of forced reflow to that
     one read (and deferring the read only moves the cost to whenever the
     frame is next dirty). The observer is handed its geometry after layout
     completes, so neither the initial state nor any amount of scrolling
     ever forces layout, and the class still flips at the same 12px line. */
  const navWrap = $(".nav-wrap");
  if (navWrap) {
    const sentinel = document.createElement("div");
    sentinel.setAttribute("aria-hidden", "true");
    sentinel.style.cssText = "position:absolute;top:12px;left:0;width:1px;height:1px;pointer-events:none;visibility:hidden";
    document.body.prepend(sentinel);
    new IntersectionObserver(([e]) => {
      navWrap.classList.toggle("scrolled", !e.isIntersecting);
    }).observe(sentinel);
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
  // Once the slide-up finishes, shed the reveal classes entirely: the "in"
  // end-state pins `transform: none` at html.js specificity, which silently
  // out-ranked every :hover/:active transform (card lifts, plan pops) on
  // revealed elements. Bare elements render identically — opacity 1 and no
  // transform are the defaults — but interactions win again.
  const shed = (el) => el.classList.remove("reveal", "in");
  const reveal = (el) => {
    el.classList.add("in");
    let done = false;
    const finish = () => { if (!done) { done = true; shed(el); } };
    el.addEventListener("transitionend", finish, { once: true });
    setTimeout(finish, 1400); // fallback: transitionend can be swallowed
  };
  const reveals = $$(".reveal");
  if (reveals.length && "IntersectionObserver" in window && !reduce) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (en.isIntersecting) { reveal(en.target); io.unobserve(en.target); }
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -8% 0px" });
    reveals.forEach((el) => io.observe(el));
  } else {
    reveals.forEach(shed);
  }

  /* ---- Lazy-load the 3rd-party Google reviews widget (Trustindex) only as
         its section nears the viewport, so it never delays first paint.
         The curated cards underneath are real, visible HTML from the start —
         this only swaps in the live widget once (and never removes the
         "see all reviews" link, which is static markup either way). ---- */
  /* Staged so the live widget is normally ready well before the visitor
     arrives, while nothing third-party runs during an untouched initial
     load. Measured section distances from the opening viewport: ~4480px on
     a 412px phone, ~3200px on a 1400px desktop. The Trustindex CONNECTION
     opens on the visitor's first meaningful scroll (~4400/3100px out —
     a plain 4000px observer ring would fire during the untouched desktop
     load, so the scroll gate is the safe early trigger; the section is
     unreachable without scrolling, so nothing is lost). The loader SCRIPT
     injects from a 2500px observer ring, which sits outside both untouched
     viewports, and also fires immediately when a visitor lands mid-page
     (refresh near the section, back-navigation scroll restoration). The
     local shell stays VISIBLE until the live widget has actually rendered:
     the widget mounts as an invisible overlay, a ResizeObserver waits for
     real height, and the swap runs only while the section is fully below
     the viewport, so it can never blank the section or shift anything the
     visitor is reading. If the vendor never renders, the shell remains
     permanently. Each vendor script URL is injected at most once
     page-wide. */
  const injectedVendorScripts = new Set();
  $$("[data-lazy-reviews]").forEach((el) => {
    const b64 = el.dataset.widgetB64;
    if (!b64) return;
    // On a page whose whole purpose is the reviews (reviews.html) the section
    // sits at the very top, so the "swap only while it is below the viewport"
    // rule below can never be satisfied and the widget would stay hidden for
    // ever. There, load at once and reveal as soon as it has rendered: a
    // reflow at the top of a page the visitor opened FOR this content is
    // expected, and showing nothing is the worse outcome.
    const isPrimary = el.hasAttribute("data-reviews-primary");
    let loaded = false;
    const load = () => {
      if (loaded) return;
      loaded = true;
      let html;
      try { html = atob(b64); } catch (err) { return; }
      const temp = document.createElement("div");
      temp.innerHTML = html;
      // innerHTML-inserted <script> tags are inert — recreate each one so
      // the widget's loader actually executes (skipping any src already
      // injected by another widget on the page).
      temp.querySelectorAll("script").forEach((old) => {
        const src = old.getAttribute("src") || "";
        if (src && injectedVendorScripts.has(src)) { old.remove(); return; }
        if (src) injectedVendorScripts.add(src);
        const s = document.createElement("script");
        [...old.attributes].forEach((a) => s.setAttribute(a.name, a.value));
        s.textContent = old.textContent;
        old.replaceWith(s);
      });
      const fallback = el.querySelector("[data-reviews-fallback]");
      if (!fallback) { el.insertBefore(temp, el.firstChild); return; }
      // Mount the widget invisibly above the shell; reveal only once it has
      // real rendered height AND the section is outside the viewport, so
      // the shell->widget height change can never register as a layout
      // shift or happen in front of the visitor. In the normal flow the
      // widget finishes rendering while the section is still ~hundreds of
      // px below the fold and swaps immediately; a visitor who outruns it
      // keeps reading the shell (real quotes) and the swap completes the
      // moment the section scrolls back out of view.
      el.style.position = "relative";
      temp.style.cssText = "position:absolute;top:0;left:0;right:0;opacity:0;pointer-events:none";
      el.insertBefore(temp, fallback);
      let ready = false, revealed = false;
      // Swapping is only shift-proof while the section sits fully BELOW the
      // viewport: resizing content above (or inside) the view moves what
      // the visitor is reading. A visitor who outran the widget keeps the
      // shell until the section drops below the fold again; if it never
      // does, the shell (real quotes) simply stays.
      const belowViewport = () => el.getBoundingClientRect().top > innerHeight + 100;
      const reveal = () => {
        if (revealed || !fallback.isConnected) return;
        revealed = true;
        fallback.remove();
        temp.style.cssText = "";
      };
      const maybeReveal = () => {
        if (!ready || revealed) return;
        if (isPrimary || belowViewport()) reveal();
        else addEventListener("scroll", function onS() {
          if (revealed) { removeEventListener("scroll", onS); return; }
          if (belowViewport()) { removeEventListener("scroll", onS); reveal(); }
        }, { passive: true });
      };
      if ("ResizeObserver" in window) {
        const ro = new ResizeObserver(() => {
          if (temp.offsetHeight > 60) { ro.disconnect(); ready = true; maybeReveal(); }
        });
        ro.observe(temp);
      } else {
        setTimeout(() => { if (temp.offsetHeight > 60) { ready = true; maybeReveal(); } }, 2500);
      }
    };
    if (isPrimary) {
      preconnect("https://cdn.trustindex.io");
      load();
    } else if ("IntersectionObserver" in window) {
      // Connection + wide script ring arm on the first meaningful scroll
      // (never during an untouched load — Lighthouse and first paint see no
      // third-party work; the section is unreachable without scrolling, so
      // nothing is lost). Covers scroll restoration too: restored positions
      // either fire a scroll event or leave scrollY non-zero at load.
      const armed = { wide: false };
      const onFirstScroll = () => {
        preconnect("https://cdn.trustindex.io");
        if (armed.wide) return;
        armed.wide = true;
        // 3800px ring: measured under slow-4G at 1200px/s this puts the
        // fully rendered widget in place >1s before the section enters the
        // viewport. Only exists after a scroll, so it can't fire during an
        // untouched load even on the 1400px desktop where the section sits
        // ~3200px out.
        const ioWide = new IntersectionObserver((entries) => {
          entries.forEach((en) => { if (en.isIntersecting) { load(); ioWide.unobserve(en.target); } });
        }, { rootMargin: "3800px 0px" });
        ioWide.observe(el);
      };
      addEventListener("scroll", onFirstScroll, { once: true, passive: true });
      addEventListener("load", () => { if (scrollY > 0) onFirstScroll(); }, { once: true });
      // Base 2500px ring — outside both untouched opening viewports
      // (section sits ~4480px out on mobile, ~3200px on desktop) — fires
      // instantly when a visitor lands mid-page near the section without a
      // scroll event. load() is single-shot, so overlapping rings are safe.
      const ioLoad = new IntersectionObserver((entries) => {
        entries.forEach((en) => { if (en.isIntersecting) { preconnect("https://cdn.trustindex.io"); load(); ioLoad.unobserve(en.target); } });
      }, { rootMargin: "2500px 0px" });
      ioLoad.observe(el);
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
         Ticks down to October 4th in the visitor's own timezone. The build
         seeds the numbers server-side so first paint is already correct;
         this only keeps them live. After the deadline passes, the target
         rolls to next year's October 4th — the offer is seasonal and the
         banner text ("Deal Ends October 4th") stays true either way, so
         the timer never sits at zero for the rest of the year. ---- */
  const cdown = $("[data-countdown]");
  if (cdown) {
    const cd = (k) => $('[data-cd="' + k + '"]', cdown);
    const els = { d: cd("d"), h: cd("h"), m: cd("m"), s: cd("s") };
    const pad = (n) => String(n).padStart(2, "0");
    const tick = () => {
      const now = new Date();
      let t = new Date(now.getFullYear(), 9, 4);
      if (t <= now) t = new Date(now.getFullYear() + 1, 9, 4);
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

  /* ---- Process slider (Mop / Scrub / Squeegee / Detail) ----
         The progress bar under the steps is ONE bar with one leading edge,
         even though the markup splits it into a segment between each pair
         of dots. A single number, pos (in dot units: 0 = empty, k = filled
         up to dot k), drives every segment and every dot's fill, and each
         change animates pos from wherever the edge currently is to the new
         dot. So a jump from step 4 to step 1 is one edge travelling back
         through segments 3, 2 and 1, with each dot going grey as the edge
         passes under it, and a tap mid-motion just redirects the edge.
         Between steps the edge creeps toward the next dot over the dwell,
         as a live countdown to the auto-advance. ---- */
  const AUTOADVANCE_MS = 16000;
  $$(".process-slider").forEach((slider) => {
    const slides = $$(".process-slide", slider);
    const dots = $$(".process-dot", slider);
    const lines = $$(".process-line", slider);
    const prev = $(".process-arrow.prev", slider);
    const next = $(".process-arrow.next", slider);
    const viewport = $(".process-viewport", slider) || $(".process-track", slider);
    const n = slides.length;
    if (!n) return;
    // After a tap or swipe the bar rests on the new dot this long before the
    // countdown toward the next one starts creeping; on an auto-advance
    // there is nothing to rest from.
    const HOLD_MS = 1000;
    // Travel time for the edge, by distance in steps: one step 330ms, a jump
    // across all three 630ms, so the edge moves at a near-constant speed and
    // a long jump still reads as one motion rather than a crawl.
    const sweepMs = (dist) => 180 + 150 * dist;
    // The sweep follows the browser's own "ease" curve (cubic-bezier .25 .1
    // .25 1): under way within the first frame of a tap, never faster than
    // about 17px a frame, and settling gently. A plain cubic ease-out
    // lurched off the mark at 23px a frame, which read as a skip on the
    // 2px line; a cubic ease-in-out sat still for the first tenth of a
    // second, which read as a hitch.
    const bezier = (x1, y1, x2, y2) => {
      const poly = (a1, a2) => [1 - 3 * a2 + 3 * a1, 3 * a2 - 6 * a1, 3 * a1];
      const [ax, bx, cx] = poly(x1, x2), [ay, by, cy] = poly(y1, y2);
      return (x) => {
        let t = x;   // Newton's method on the x polynomial, then y at that t
        for (let k = 0; k < 6; k++) {
          const slope = (3 * ax * t + 2 * bx) * t + cx;
          if (slope < 1e-6) break;
          t -= (((ax * t + bx) * t + cx) * t - x) / slope;
        }
        return ((ay * t + by) * t + cy) * t;
      };
    };
    const easeSweep = bezier(.25, .1, .25, 1);
    const linear = (t) => t;

    /* pos is the edge's position in steps: whole number k means the edge
       sits at the far side of dot k (dot k filled, segment k empty). Within a
       step the edge first crosses the segment, then wipes through the next
       dot, at one speed, so r (the segment's share of a step's length) is
       measured from the layout: 62px line boxes (56px visible, the rest
       tucked 3px under each neighbouring dot) and 38px dots on desktop,
       34px line boxes on phones. The hidden 3px at either end of a line
       cost the edge about a hundredth of a second each, less than a frame. */
    let i = 0, pos = 0, anim = null, raf = 0, hold = null;
    let timer = null, dwellEnd = 0;
    let r = 0.6;
    /* Layout widths (offsetWidth), not on-screen ones: a hovered or pressed
       dot is scaled by CSS and must not skew the ratio. Returns false while
       the stylesheet has not applied yet (the sheet loads without blocking,
       so on a slow connection this script can run first and see 0px). A
       change in r repaints at once and redirects a running countdown creep,
       so it never lands as a jump at the start of the next sweep. */
    const measure = () => {
      if (!lines.length) return true;
      const lw = lines[0].offsetWidth, dw = dots[0].offsetWidth;
      if (!(lw > 0 && dw > 0)) return false;
      const nr = lw / (lw + dw);
      if (Math.abs(nr - r) > 1e-4) {
        r = nr;
        if (anim && anim.ease === linear) anim.to = i + r;
        render();
      }
      return true;
    };
    const fills = lines.map((l) => $(".process-line-fill", l) || l);
    const dotFills = dots.map((d) => $(".process-dot-fill", d));
    const clamp01 = (v) => Math.min(1, Math.max(0, v));
    const last = { lines: [], dots: [], filled: [] };   // only write what changed
    const render = () => {
      lines.forEach((l, k) => {
        const v = `scaleX(${clamp01((pos - k) / r).toFixed(4)})`;
        if (last.lines[k] !== v) { last.lines[k] = v; fills[k].style.transform = v; }
      });
      dots.forEach((d, k) => {
        const f = k === 0 ? 1 : clamp01((pos - (k - 1) - r) / (1 - r));   // dot 1 is always filled
        const v = `inset(0 ${((1 - f) * 100).toFixed(2)}% 0 0)`;
        if (last.dots[k] !== v) { last.dots[k] = v; if (dotFills[k]) dotFills[k].style.clipPath = v; }
        const on = f >= 0.5;                                              // the number turns white as the edge passes its centre
        if (last.filled[k] !== on) { last.filled[k] = on; d.classList.toggle("filled", on); }
      });
    };
    /* Move the edge from where it is now to `to`. Starting a new move
       cancels the old one mid-flight, so there is never a snap. */
    const animate = (to, dur, ease, then) => {
      cancelAnimationFrame(raf);
      anim = null;
      if (reduce || dur <= 0 || Math.abs(to - pos) < 1e-4) {
        pos = to; render();
        if (then) then();
        return;
      }
      const a = { from: pos, to, start: performance.now(), dur, ease, then };
      anim = a;
      const step = (now) => {
        if (anim !== a) return;
        const t = Math.min(1, Math.max(0, (now - a.start) / a.dur));   // a frame stamped before the tap must not run backwards
        pos = a.from + (a.to - a.from) * a.ease(t);
        render();
        if (t < 1) { raf = requestAnimationFrame(step); return; }
        anim = null;
        if (a.then) a.then();
      };
      raf = requestAnimationFrame(step);
    };

    const show = (k, manual = false) => {
      clearTimeout(hold);
      i = (k + n) % n;
      slides.forEach((s, idx) => s.classList.toggle("active", idx === i));
      dots.forEach((d, idx) => d.classList.toggle("active", idx === i));
      const sweep = sweepMs(Math.abs(i - pos));
      animate(i, sweep, easeSweep, () => {
        if (reduce || i >= lines.length) return;   // last step: nothing ahead to count down
        // The creep fills the segment ahead (to the next dot's edge) by the
        // time the dwell clock runs out, so it and the auto-advance always
        // land together, however the dwell was paused or reset; the
        // auto-advance's own sweep then carries the edge through the dot.
        const begin = () => { if (!paused) animate(i + r, Math.max(1000, dwellEnd - performance.now()), linear, null); };
        if (manual) hold = setTimeout(begin, HOLD_MS); else begin();
      });
    };

    /* Auto-advance as a resettable timeout (not an interval) so a finger
       resting on the card can pause it and the release resume the same
       dwell, instead of the step changing under the finger. */
    const schedule = (ms) => {
      clearTimeout(timer); timer = null;
      if (reduce || n < 2) return;
      dwellEnd = performance.now() + ms;
      timer = setTimeout(() => { restart(); show(i + 1); }, ms);  // clock first: show() may start the creep at once
    };
    /* While a finger rests on the card the dwell clock stops, and so does the
       creeping edge, which is that clock made visible; both pick up where
       they left off on release. */
    let paused = false, pausedAt = 0;
    const restart = () => { paused = false; schedule(AUTOADVANCE_MS); };
    const pause = () => {
      if (paused) return;
      paused = true; pausedAt = performance.now();
      clearTimeout(timer); timer = null;
      clearTimeout(hold);
      if (anim && anim.ease === linear) { cancelAnimationFrame(raf); anim = null; }  // the creep, not a sweep
    };
    const resume = () => {
      if (!paused) return;
      paused = false;
      clearTimeout(hold);                               // resume starts the creep itself
      const left = Math.max(50, dwellEnd - pausedAt);
      schedule(left);
      if (!reduce && !anim && i < lines.length) animate(i + r, left, linear, null);
    };

    dots.forEach((d, idx) => d.addEventListener("click", () => { show(idx, true); restart(); }));
    if (prev) prev.addEventListener("click", () => { show(i - 1, true); restart(); });
    if (next) next.addEventListener("click", () => { show(i + 1, true); restart(); });

    /* Swipe between steps (touch, or a mouse drag). The card follows the
       finger one-to-one and the neighbouring step slides in from the side,
       so letting go either carries it the rest of the way or springs back.
       Releasing past a quarter of the card's width commits, and so does a
       quick flick however short. The viewport has touch-action: pan-y, so a
       vertical drag still scrolls the page as normal: the browser takes it
       over and sends pointercancel. Until that happens the gesture stays
       undecided, because a thumb swipe usually starts with a small arc and
       the first few pixels can lean vertical before it turns sideways; only
       a mouse (which has no scroll to defer to) gives up on a vertical
       start. Drags from a button or link are left alone. */
    if (viewport && n > 1) {
      const FLICK = 0.35;     // px per ms that commits regardless of distance
      let sw = null;          // the drag in progress
      let settle = null;      // the previous swipe's slide animation, still finishing
      let swiped = false;     // set for the click that trails a committed mouse swipe
      const width = () => viewport.getBoundingClientRect().width || 1;
      // The incoming slide has to be forced visible (it is normally hidden
      // and faded out); the active one only moves, so a slide still fading
      // in from a step change keeps fading rather than popping to full.
      const place = (s, x, incoming) => {
        if (incoming) { s.style.transition = "none"; s.style.visibility = "visible"; s.style.opacity = "1"; }
        s.style.transform = `translateX(${x}px)`;
      };
      const clear = (s) => { s.style.transition = ""; s.style.visibility = ""; s.style.opacity = ""; s.style.transform = ""; };

      viewport.addEventListener("pointerdown", (e) => {
        if (sw || !e.isPrimary || e.button !== 0 || e.target.closest("button, a")) return;
        // If the last swipe is still sliding into place, land it now so this
        // drag starts from a settled card and a consistent step.
        if (settle) { clearTimeout(settle.timer); settle.done(); }
        // For a mouse, the default is to start dragging the photo as an image
        // or to select text; neither is wanted. Touch scrolling is governed by
        // touch-action, not by this.
        if (e.pointerType === "mouse") e.preventDefault();
        // Capture from the start so a release outside the card still reaches
        // us (touch is captured implicitly; this does not stop touch-action's
        // pointercancel).
        try { viewport.setPointerCapture(e.pointerId); } catch (_) { /* older browsers */ }
        sw = { id: e.pointerId, type: e.pointerType, x0: e.clientX, y0: e.clientY, axis: null, dir: 0,
               step: i, active: slides[i], inc: null, lastX: e.clientX, lastT: performance.now(), v: 0 };
        pause();
      });
      viewport.addEventListener("pointermove", (e) => {
        if (!sw || e.pointerId !== sw.id) return;
        let dx = e.clientX - sw.x0;
        const dy = e.clientY - sw.y0;
        if (sw.axis !== "x") {
          if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
          if (Math.abs(dx) < Math.abs(dy)) {
            if (sw.type === "mouse") sw.axis = "y";   // a mouse drag that heads up or down is not a swipe
            return;                                   // touch: undecided, a scroll will pointercancel us
          }
          if (sw.axis === "y") return;
          sw.axis = "x";
          sw.x0 = e.clientX; dx = 0;                  // follow from here, with no jump by the dead zone
          viewport.classList.add("is-dragging");
        }
        const now = performance.now(), dt = now - sw.lastT;
        if (dt > 0) sw.v = 0.6 * sw.v + 0.4 * ((e.clientX - sw.lastX) / dt);
        sw.lastX = e.clientX; sw.lastT = now;
        const dir = dx < 0 ? 1 : -1;                  // swiping left brings the next step in
        if (dir !== sw.dir) {
          if (sw.inc) clear(sw.inc);
          sw.dir = dir;
          sw.inc = reduce ? null : slides[(sw.step + dir + n) % n];
          if (sw.inc === sw.active) sw.inc = null;
        }
        if (reduce) return;
        const w = width();
        place(sw.active, dx, false);
        if (sw.inc) place(sw.inc, dir * w + dx, true);
      });

      const finish = (commit) => {
        const s = sw; sw = null;
        viewport.classList.remove("is-dragging");
        if (!s || s.axis !== "x") { if (s && s.inc) clear(s.inc); resume(); return; }
        const active = s.active, inc = s.inc, dir = s.dir || 1, w = width();
        if (s.step !== i) {                           // the step changed under the drag: just tidy up
          clear(active); if (inc) clear(inc); resume(); return;
        }
        const swap = () => {
          // The slide animation has already brought the new step in, so the
          // usual crossfade is switched off for this one change.
          slider.classList.add("no-fade");
          show(i + dir, true);
          clear(active); if (inc) clear(inc);
          void viewport.offsetWidth;
          slider.classList.remove("no-fade");
          restart();
        };
        if (reduce || !inc) {
          clear(active); if (inc) clear(inc);
          if (commit) swap(); else resume();
          return;
        }
        const ms = commit ? 260 : 220, ease = "cubic-bezier(.2,.7,.2,1)";
        active.style.transition = `transform ${ms}ms ${ease}, opacity 1.1s ease`;
        inc.style.transition = `transform ${ms}ms ${ease}`;
        void viewport.offsetWidth;                    // start the transitions from the current positions
        active.style.transform = `translateX(${commit ? -dir * w : 0}px)`;
        inc.style.transform = `translateX(${commit ? 0 : dir * w}px)`;
        const done = () => {
          settle = null;
          // A dot or arrow tapped while the swipe was still settling has
          // already moved the step; the swipe then just tidies up.
          if (commit && s.step === i) swap();
          else { clear(active); clear(inc); resume(); }
        };
        settle = { done, timer: setTimeout(done, ms + 20) };
      };
      const onUp = (e) => {
        if (!sw || e.pointerId !== sw.id) return;
        const dx = e.clientX - sw.x0;
        // A finger that has been still for a moment is not flicking, however
        // fast it moved before it stopped.
        const v = performance.now() - sw.lastT > 100 ? 0 : sw.v;
        const flick = Math.abs(v) > FLICK && Math.sign(v) === Math.sign(dx);
        const commit = sw.axis === "x" && (Math.abs(dx) >= Math.min(80, width() * 0.25) || flick);
        if (commit && sw.type === "mouse") { swiped = true; setTimeout(() => { swiped = false; }, 80); }
        finish(commit);
      };
      // On window, not the viewport: a release or cancel must end the drag
      // wherever the pointer is by then.
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", (e) => { if (sw && e.pointerId === sw.id) finish(false); });
      window.addEventListener("blur", () => { if (sw) finish(false); });
      viewport.addEventListener("dragstart", (e) => e.preventDefault());
      // Android Chrome opens an image menu on a long press; a resting finger
      // is part of the gesture here (it pauses the slideshow).
      viewport.addEventListener("contextmenu", (e) => { if (sw) e.preventDefault(); });
      // A click that trails a real mouse swipe must not reach the card.
      viewport.addEventListener("click", (e) => {
        if (swiped) { e.preventDefault(); e.stopPropagation(); }
      }, true);
    }

    /* Start once the layout can be measured; give up waiting after about
       three seconds and run with the default ratio (the first slide is
       already marked active in the markup, so nothing is hidden meanwhile). */
    const start = () => { render(); restart(); show(0); };
    let tries = 0;
    const whenReady = () => { if (measure() || ++tries > 180) start(); else requestAnimationFrame(whenReady); };
    whenReady();
    window.addEventListener("load", measure);
    window.addEventListener("resize", measure, { passive: true });
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
    // Open the Nominatim connection on first focus — comfortably ahead of
    // the first keystroke's request. It used to sit permanently in every
    // page's head, holding an idle socket through the critical load for a
    // service only this field ever contacts.
    input.addEventListener("focus", () => preconnect("https://nominatim.openstreetmap.org"), { once: true });
    const wrap = input.closest(".field") || input.parentElement;
    const panel = input.closest(".wizard-panel") || input.closest("form") || wrap;
    const list = wrap.querySelector("[data-address-list]");
    const verified = wrap.querySelector("[data-address-verified]");
    const cityField = panel.querySelector("[data-address-city]");
    const zipField = panel.querySelector("[data-address-zip]");
    const stateField = panel.querySelector("[data-address-state]");
    const countryField = panel.querySelector("[data-address-country]");
    const status = panel.querySelector("[data-address-status]");
    if (!list) return;
    let timer = null, aborter = null, lastFired = 0, overList = false;
    // Nominatim's usage policy caps clients at 1 request/second, so live
    // as-you-type suggestions run on a leading-edge throttle: the first
    // keystroke queries immediately, further keystrokes re-query on a 1s
    // cadence while typing, and a trailing call catches the final value.
    const INTERVAL = 1000;
    // Nominatim is weak on abbreviated directionals and street suffixes
    // ("123 S Main" finds nothing where "123 South Main" works), so expand
    // standalone tokens in the query we send — never what the visitor sees
    // in the field.
    const ABBR = { n: "north", s: "south", e: "east", w: "west",
      ne: "northeast", nw: "northwest", se: "southeast", sw: "southwest",
      ave: "avenue", blvd: "boulevard", rd: "road", ln: "lane", ct: "court",
      cir: "circle", hwy: "highway", pkwy: "parkway", trl: "trail" };
    // "St"/"Dr" mean Street/Drive as a suffix but Saint/Doctor when they open
    // a name — and St. Michael is one of our service-area cities. A real
    // suffix always trails a street name, so these expand only when they
    // neither open a comma-separated segment nor directly follow a house
    // number: "123 Main St, St Michael" → "…street, St Michael", and
    // "1200 Dr Martin Luther King Blvd" keeps its Dr.
    const SUFFIX_ABBR = { st: "street", dr: "drive" };
    const expand = (q) => {
      let opensSegment = true, afterNumber = false;
      return q.split(/\s+/).map((w) => {
        const [, word, punct] = w.match(/^(.*?)([.,]*)$/);
        const key = word.toLowerCase();
        const suffixOk = !opensSegment && !afterNumber;
        const swap = ABBR[key] || (suffixOk ? SUFFIX_ABBR[key] : null);
        opensSegment = punct.indexOf(",") > -1;
        afterNumber = /^\d+[a-z]?$/i.test(word);
        // Keep a comma (it separates address parts for Nominatim); drop a
        // period, which is just abbreviation punctuation.
        return (swap || word) + punct.replace(/\./g, "");
      }).join(" ");
    };
    // Don't let a throttled refresh swap the list out from under the cursor
    // mid-click — that made picking a suggestion feel like whack-a-mole.
    list.addEventListener("pointerenter", () => { overList = true; });
    list.addEventListener("pointerleave", () => { overList = false; });
    const close = () => { list.hidden = true; list.innerHTML = ""; overList = false; };
    // Builds one suggestion row. houseNo is carried over when the match came
    // from a street-level fallback search, so "320 3rd St S" keeps its 320
    // even though OpenStreetMap only knows the street.
    const addRow = (r, houseNo) => {
      const addr = r.address || {};
      const road = [addr.house_number || houseNo, addr.road].filter(Boolean).join(" ");
      const cityName = addr.city || addr.town || addr.village || addr.hamlet || "";
      // Keep suggestions to street, city, state, ZIP — no county/country clutter.
      const short = [road, cityName, addr.state, addr.postcode].filter(Boolean).join(", ");
      const li = document.createElement("li");
      li.textContent = short || r.display_name;
      li.setAttribute("role", "option");
      li.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        input.value = road || r.display_name;
        if (cityField) cityField.value = cityName || cityField.value;
        if (zipField) zipField.value = addr.postcode || zipField.value;
        // Prefer the two-letter abbreviation ("US-MN" → "MN") over the
        // spelled-out state name Nominatim also returns.
        const iso = addr["ISO3166-2-lvl4"] || "";
        const stateAbbr = iso.indexOf("-") > -1 ? iso.split("-")[1] : "";
        if (stateField) stateField.value = stateAbbr || addr.state || stateField.value;
        if (countryField) countryField.value = (addr.country_code || "").toUpperCase() || countryField.value;
        if (verified) verified.value = "yes";
        if (status) status.hidden = true;
        close();
      });
      list.appendChild(li);
    };
    // OpenStreetMap simply doesn't hold every house number, so the list must
    // never dead-end: this row always sits at the bottom and lets someone
    // proceed with exactly what they typed.
    const addUseTypedRow = (typed) => {
      const li = document.createElement("li");
      li.className = "addr-use-typed";
      li.setAttribute("role", "option");
      li.textContent = "Use “" + typed + "” as typed";
      li.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        input.value = typed;
        if (verified) verified.value = "typed";
        if (status) status.hidden = true;
        close();
      });
      list.appendChild(li);
    };
    const queryUrl = (text) =>
      "https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=5&countrycodes=us" +
      "&viewbox=-94.3,45.4,-93.2,44.7&bounded=0&q=" + encodeURIComponent(expand(text));
    const search = () => {
      const q = input.value.trim();
      if (q.length < 4) { close(); return; }
      if (aborter) aborter.abort();
      aborter = new AbortController();
      // Immediate feedback so a slow network read doesn't just look frozen —
      // Nominatim (free, keyless) typically answers in a few hundred ms, but
      // there's no way to make a public rate-limited API instant.
      if (!overList) {
        list.innerHTML = '<li class="addr-loading" aria-disabled="true">Searching…</li>';
        list.hidden = false;
      }
      const opts = { signal: aborter.signal, headers: { Accept: "application/json" } };
      // A house number OSM has never been told about sinks the whole query, so
      // when the exact address finds nothing, fall back to the street on its
      // own and re-attach the number to whatever the visitor picks.
      const houseNo = (q.match(/^\s*(\d+[a-zA-Z]?)\s+/) || [])[1] || "";
      const streetOnly = houseNo ? q.replace(/^\s*\d+[a-zA-Z]?\s+/, "") : "";
      const paint = (results, carryNo) => {
        if (overList) return; // never rebuild the list mid-interaction
        list.innerHTML = "";
        results.slice(0, 5).forEach((r) => addRow(r, carryNo));
        addUseTypedRow(q);
        list.hidden = false;
      };
      fetch(queryUrl(q), opts)
        .then((r) => r.json())
        .then((results) => {
          if (results.length || !streetOnly || streetOnly.length < 3) { paint(results, ""); return; }
          return fetch(queryUrl(streetOnly), opts)
            .then((r) => r.json())
            .then((streets) => paint(streets, houseNo));
        })
        .catch((e) => { if (e.name !== "AbortError") paint([], ""); });
    };
    input.addEventListener("input", () => {
      if (verified) verified.value = "no";
      clearTimeout(timer);
      const wait = Math.max(0, lastFired + INTERVAL - Date.now());
      timer = setTimeout(() => { lastFired = Date.now(); search(); }, wait);
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

  /* ---- A referred friend: /r/CODE, or ?promo= / ?ref= ----
     /r/CODE is a Netlify rewrite, so the browser keeps the short path and
     no query string ever arrives — read the code back out of the path too.
     The code goes in the promo field (which /api/lead already recognises,
     see netlify/lib/referral-hook.mjs) and the banner tells them, in so many
     words, that the discount is theirs. A code we can't look up stays in the
     field for the office to sort out, but never promises a discount. */
  const refCode = (params.get("promo") || params.get("ref")
    || (location.pathname.match(/\/r\/([A-Za-z0-9-]+)\/?$/) || [])[1] || "").trim();
  if (refCode) {
    const promoField = $("#q-promo");
    if (promoField && !promoField.value) promoField.value = refCode.toUpperCase();
    // Arriving on a referral link answers "How did you hear about us?" by
    // itself — set it whether or not the code checks out, since even a
    // mistyped code came from a friend. Never override a choice already made.
    const source = $("#q-source");
    if (source && !source.value) {
      const opt = Array.from(source.options).find((o) => o.value === "Family/Friend");
      if (opt) source.value = opt.value;
    }
    const banner = $("[data-referral-banner]");
    const slot = banner && $("[data-referral-text]", banner);
    if (slot) {
      fetch("/api/referral?code=" + encodeURIComponent(refCode), { headers: { Accept: "application/json" } })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!d || !d.ok) return;
          const who = String(d.referrer_first_name || "").trim();
          const off = "$" + (Number(d.friend_discount) || 25);
          slot.textContent = (who ? who + " referred you! " : "You've been referred! ")
            + "Your first service is " + off + " off, and we've already applied it below.";
          banner.hidden = false;
        })
        .catch(() => {});
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
      // Nudge people to pick a confirmed address, but never trap them:
      // OpenStreetMap doesn't know every house number, and a visitor who
      // can't submit is a lost customer. The prompt shows once; a second
      // click on submit goes through with the address as typed.
      const addrVerified = form.querySelector("[data-address-verified]");
      const addrStatus = form.querySelector("[data-address-status]");
      if (addrVerified && addrVerified.value === "no") {
        if (addrStatus && addrStatus.hidden) {
          addrStatus.hidden = false;
          const addrInput = form.querySelector("[data-address-input]");
          if (addrInput) addrInput.focus();
          return;
        }
        addrVerified.value = "typed";
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
        // The conversion, reported only once the submission actually landed
        // — never on a click, never on a failure — so Meta optimises toward
        // real quote requests. No-ops when no pixel is configured.
        if (typeof fbq === "function") {
          fbq("track", "Lead", { content_name: data.service_type || form.dataset.subject || "Quote request" });
        }
        if (success) {
          success.classList.add("show");
          success.setAttribute("role", "status");
          success.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
        }
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
        // Same soft nudge as submit: prompt once, then let them continue with
        // what they typed rather than stranding them on this step.
        if (verified && verified.value === "no") {
          if (status && status.hidden) {
            status.hidden = false;
            addrInput.focus();
            return false;
          }
          verified.value = "typed";
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
    // A link can land here with the form already open — for ads and social
    // posts, where the click is the intent and the page is just the wrapper:
    // .../christmas-light-installation.html?quote=1 (or #quote). Any other
    // parameters an ad platform tacks on (fbclid, utm_*) ride along
    // untouched. The first field takes focus so a phone keyboard comes up
    // and the visitor can start typing without a second tap.
    const wantsQuote = new URLSearchParams(location.search).has("quote")
      || location.hash.replace("#", "") === "quote";
    if (wantsQuote) {
      openXmas();
      const first = xmasModal.querySelector("input:not([type=hidden]), select, textarea");
      if (first) first.focus({ preventScroll: true });
    }
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
    /* ResizeObserver replaces the eager call + resize/media listeners: its
       callback runs right after layout completes, so the clientWidth reads
       are free there — calling padEnds() during script evaluation forced
       the document's first layout synchronously, and a plain resize
       listener re-reads mid-dirty frames. It also fires once on observe(),
       which supplies the initial padding, and again whenever the track's
       size changes (every viewport resize or breakpoint flip that could
       change the answer). Re-applying the same padding doesn't resize the
       content box, so it settles immediately instead of looping. */
    if ("ResizeObserver" in window) {
      new ResizeObserver(padEnds).observe(track);
    } else {
      padEnds();
      window.addEventListener("resize", padEnds);
      if (oneUp.addEventListener) oneUp.addEventListener("change", padEnds);
    }

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

  /* ---- Service-area hub: opening a county in the list swaps the map
     beside it to that county's outline (Google's keyless embed draws the
     boundary for a "<County>, MN" search), keeps one county open at a
     time, and points the map's "open in Google Maps" link at the same
     county. The <details> work without any of this; the map then simply
     stays on the first county. ---- */
  const countyMap = document.querySelector("[data-county-map]");
  const countyList = document.querySelector("[data-county-list]");
  if (countyMap && countyList) {
    const frame = countyMap.querySelector("iframe");
    const fallback = countyMap.querySelector(".map-fallback");
    const label = countyMap.querySelector(".ph-label");
    const counties = Array.from(countyList.querySelectorAll("details[data-map-query]"));
    // Closing a taller county above the one just opened pulls the page up
    // under the reader's finger, and the browser's scroll anchoring can't
    // compensate (the anchor is inside the list that just closed). The
    // measurement has to be taken on the press: with name= grouping the
    // browser closes the others itself, before any toggle event runs.
    let pressed = null;
    const markPress = (summary) => { pressed = { summary, top: summary.getBoundingClientRect().top }; };
    const keepInView = (summary) => {
      if (!pressed || pressed.summary !== summary) return;
      const delta = summary.getBoundingClientRect().top - pressed.top;
      pressed = null;
      if (Math.abs(delta) > 1) window.scrollBy(0, delta);
    };
    // The view the map returns to when every county is closed: the whole
    // service area, as rendered by county_map_embed.
    const home = { q: countyMap.dataset.homeQuery, zoom: countyMap.dataset.homeZoom,
                   name: countyMap.dataset.homeName, label: countyMap.dataset.homeLabel };
    const show = (q, name, labelText, zoom) => {
      if (!q || !frame || countyMap.dataset.mapQuery === q) return;
      countyMap.dataset.mapQuery = q;
      const title = "Map of " + name;
      // The placeholder covers the old map until the new one has loaded —
      // the iframe paints the previous county until the new navigation
      // commits, so without this the wrong county sits there meanwhile.
      if (fallback) { fallback.style.display = ""; fallback.style.zIndex = "2"; }
      if (label && label.lastChild && label.lastChild.nodeType === 3) label.lastChild.textContent = labelText;
      frame.title = title;
      frame.src = "https://maps.google.com/maps?q=" + encodeURIComponent(q)
        + (zoom ? "&z=" + zoom : "") + "&output=embed";
      countyMap.href = "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(q);
      countyMap.setAttribute("aria-label", title + ", opens Google Maps in a new tab");
    };
    const showCounty = (d) => {
      const nameEl = d.querySelector(".county-name") || d.querySelector("summary");
      const name = (nameEl ? nameEl.textContent.trim() : d.dataset.mapQuery) + ", Minnesota";
      show(d.dataset.mapQuery, name, name.replace(", Minnesota", ", MN"), "");
    };
    // The iframe's inline onload only hides the placeholder; it must also
    // drop back under the map so a later swap can cover it again.
    if (frame) frame.addEventListener("load", () => { if (fallback) fallback.style.zIndex = ""; });
    counties.forEach((d) => {
      const summary = d.querySelector("summary");
      if (summary) {
        summary.addEventListener("pointerdown", () => markPress(summary));
        summary.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") markPress(summary);
        });
      }
      d.addEventListener("toggle", () => {
        if (!d.open) {
          // Every county closed: back to the whole service area.
          if (!counties.some((o) => o.open)) show(home.q, home.name, home.label, home.zoom);
          return;
        }
        // Older browsers with no name= grouping still need closing by hand.
        counties.forEach((o) => { if (o !== d && o.open) o.open = false; });
        if (summary) keepInView(summary);
        showCounty(d);
      });
    });
  }

  /* ---- Meta Pixel: tapping a phone number is a contact, and on a phone
         it is usually the whole conversion. Delegated, so it covers every
         tel: link on every page including ones added later. No-ops when no
         pixel is configured. ---- */
  document.addEventListener("click", (e) => {
    const tel = e.target.closest && e.target.closest('a[href^="tel:"]');
    if (tel && typeof fbq === "function") fbq("track", "Contact", { content_name: "Phone tap" });
  });

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
