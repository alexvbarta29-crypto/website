# Barta Window Washing — Website

A complete, production-ready, multi-page website for **Barta Window Washing** (Delano, MN) — a
premium exterior cleaning company. Built as a fast, accessible, SEO-optimized **static site** with
an Apple-inspired design language: glassmorphism navigation, smooth scroll animations, before/after
sliders, animated counters, and conversion-focused lead capture on every page.

> **49 pages**, zero runtime dependencies, excellent Core Web Vitals by design.

---

## Quick start

The site is **static HTML/CSS/JS** — open `index.html` in a browser, or serve the folder:

```bash
python3 -m http.server 8000      # then visit http://localhost:8000
```

### Rebuilding pages

All HTML is generated from a small Python toolchain so every page shares one nav, footer, design
system, and SEO scaffold. The core build needs only the standard library; Pillow (see
`requirements.txt`) is used for responsive image/WebP generation and degrades gracefully (with a
console warning) if it isn't installed. After editing content/data, regenerate:

```bash
pip install -r requirements.txt   # one-time, for image processing
python3 build/build.py
```

This rewrites every `.html` file plus `sitemap.xml`, `robots.txt`, `site.webmanifest`, and the
placeholder imagery. Edit content in `build/sitedata.py`; edit layout in `build/components.py` and
`build/build.py`; edit styling in `assets/css/styles.css`.

---

## Project structure

```
.
├── index.html                  # Homepage
├── commercial.html             # Commercial services
├── residential.html            # Residential services hub
├── why-choose-us.html · about.html · team.html
├── reviews.html · gallery.html · faqs.html
├── service-areas.html          # Service-area hub
├── careers.html · financing.html · contact.html
├── request-quote.html          # Primary lead-capture page
├── blog.html · privacy.html
├── services/                   # 10 service pages
│   ├── window-cleaning.html · gutter-cleaning.html · pressure-washing.html
│   ├── house-washing.html · soft-washing.html · roof-cleaning.html
│   ├── solar-panel-cleaning.html · screen-cleaning.html
│   ├── hard-water-stain-removal.html · christmas-light-installation.html
├── areas/                      # 12 local SEO landing pages (Delano, Maple Grove, …)
├── landing/                    # 6 conversion landing pages (Free Window Cleaning Quote, …)
├── blog/                       # 4 articles
├── assets/
│   ├── css/styles.css          # Full design system (tokens, components, responsive)
│   ├── js/main.js              # Nav, drawer, reveal, counters, before/after, forms
│   └── img/                    # Favicon, OG cover, before/after placeholders + README
├── build/                      # Static-site generator (Python; Pillow optional, see requirements.txt)
│   ├── sitedata.py             # Single source of truth: NAP, services, areas, plans, reviews…
│   ├── components.py           # head/SEO, nav, footer, forms, sections
│   ├── icons.py · schema.py · build.py
├── docs/SEO-AND-STRATEGY.md    # Sitemap, per-page SEO, wireframes, palette, CRO, GBP, citations
├── sitemap.xml · robots.txt · site.webmanifest
```

---

## What's included (per the brief)

- **Design** — sticky floating glassmorphism nav, rounded corners, clean white backgrounds, subtle
  gradients, soft shadows, smooth scrolling, scroll-reveal & float animations, premium typography
  (Plus Jakarta Sans + Inter), before/after sliders, hover effects, animated counters, clean inline
  SVG iconography. Mobile-first responsive with a sticky mobile call/quote bar.
- **Accessibility (ADA)** — skip link, semantic landmarks, single H1 per page, labeled form fields,
  `aria` on interactive widgets, visible focus states, `prefers-reduced-motion` support, and
  content that is fully visible without JavaScript.
- **Conversion** — lead form on every key page (Name, Phone, Email, Address, Service, Preferred
  Date/Time, Referral source, Notes, reminder + plan-info checkboxes), multiple CTAs, sticky quote
  button, 6 dedicated landing pages, trust badges, guarantees, social proof.
- **SEO** — unique title/meta/canonical/OG per page, JSON-LD (LocalBusiness, Organization, WebSite,
  Service, FAQPage, BreadcrumbList, BlogPosting), local + nearby-city + neighborhood keywords,
  generated `sitemap.xml` and `robots.txt`. Full strategy in `docs/SEO-AND-STRATEGY.md`.

## Before launch (checklist)

1. **Replace placeholder imagery** in `assets/img/` with real photography — see
   `assets/img/README.md` for a recommended shot list. Swap the `.imgph` placeholders and
   before/after `.svg` files for real `.webp/.jpg`.
2. **Wire up the forms** — `assets/js/main.js` currently captures leads to the console. Point the
   `form[data-lead]` submit handler at your CRM / email service (e.g. a form endpoint, Netlify
   Forms, or an API).
3. **Live Google reviews (optional)** — paste a review-widget embed code into
   `config/google-reviews-embed.html` and rebuild to auto-render your real Google reviews on the
   homepage and Reviews page. Until then, curated reviews show as a fallback. Full instructions are
   inside that file.
3. **Confirm business details** — phone, email, address, hours, and review counts live in
   `build/sitedata.py` (`BIZ`). Update and rebuild.
4. **Set the real domain** in `BIZ["domain"]` so canonical/OG/sitemap URLs are correct.
5. **Have the privacy policy reviewed** by counsel (`privacy.html` is a starter template).
6. Deploy to any static host (Netlify, Vercel, Cloudflare Pages, S3+CloudFront, GitHub Pages).
