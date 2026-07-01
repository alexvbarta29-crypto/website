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
    drawer.classList.toggle("open", open);
    document.body.style.overflow = open ? "hidden" : "";
    if (openBtn) openBtn.setAttribute("aria-expanded", String(open));
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

  /* ---- Process slider (Scrub / Squeegee / Detail) ---- */
  $$(".process-slider").forEach((slider) => {
    const slides = $$(".process-slide", slider);
    const dots = $$(".process-dot", slider);
    const lines = $$(".process-line", slider);
    const prev = $(".process-arrow.prev", slider);
    const next = $(".process-arrow.next", slider);
    let i = 0, timer = null;
    const show = (n) => {
      i = (n + slides.length) % slides.length;
      slides.forEach((s, idx) => s.classList.toggle("active", idx === i));
      dots.forEach((d, idx) => d.classList.toggle("active", idx === i));
      lines.forEach((l, idx) => l.classList.toggle("filled", idx < i));
    };
    const restart = () => {
      if (timer) clearInterval(timer);
      if (!reduce && slides.length > 1) timer = setInterval(() => show(i + 1), 5000);
    };
    dots.forEach((d, idx) => d.addEventListener("click", () => { show(idx); restart(); }));
    if (prev) prev.addEventListener("click", () => { show(i - 1); restart(); });
    if (next) next.addEventListener("click", () => { show(i + 1); restart(); });
    show(0);
    restart();
  });

  /* ---- Lead form (demo handler) ---- */
  $$("form[data-lead]").forEach((form) => {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!form.checkValidity()) { form.reportValidity(); return; }
      const success = form.parentElement.querySelector(".form-success");
      form.classList.add("sent");
      if (success) { success.classList.add("show"); success.setAttribute("role", "status"); }
      // In production, POST to your CRM / email service here.
      try {
        const data = Object.fromEntries(new FormData(form).entries());
        console.log("[Barta] Lead captured (demo):", data);
      } catch (err) {}
    });
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
