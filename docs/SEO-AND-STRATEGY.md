# Barta Window Washing — Strategy, SEO & Design Deliverables

A single reference covering the sitemap, wireframes, SEO plan, design system, conversion strategy,
and local-SEO playbook for the site. Everything here is already reflected in the built pages; this
document is the "why" and the launch playbook.

---

## 1. Complete sitemap

```
Home (/)
├── Services
│   ├── Window Cleaning            /services/window-cleaning.html
│   ├── Gutter Cleaning            /services/gutter-cleaning.html
│   ├── Pressure Washing           /services/pressure-washing.html
│   ├── House Washing              /services/house-washing.html
│   ├── Soft Washing               /services/soft-washing.html
│   ├── Roof Cleaning              /services/roof-cleaning.html
│   ├── Solar Panel Cleaning       /services/solar-panel-cleaning.html
│   ├── Screen Cleaning            /services/screen-cleaning.html
│   ├── Hard Water Stain Removal   /services/hard-water-stain-removal.html
│   └── Christmas Light Install    /services/christmas-light-installation.html
├── Residential                    /residential.html
├── Commercial                     /commercial.html
├── Service Areas (hub)            /service-areas.html
│   └── Delano, Maple Grove, Plymouth, Wayzata, Minnetonka, Buffalo, Rockford,
│       Waconia, Chanhassen, Medina, Corcoran, Watertown   /areas/<city>.html
├── Why Choose Us                  /why-choose-us.html
├── About Us                       /about.html
├── Meet the Team                  /team.html
├── Reviews                        /reviews.html
├── Gallery                        /gallery.html
├── Blog (hub + 4 posts)           /blog.html · /blog/<slug>.html
├── FAQs                           /faqs.html
├── Careers                        /careers.html
├── Financing                      /financing.html
├── Contact                        /contact.html
├── Request a Quote (primary CTA)  /request-quote.html
├── Lead landing pages             /landing/<slug>.html
│   ├── Free Window Cleaning Quote      ├── House Washing Estimate
│   ├── Free Pressure Washing Quote     ├── Commercial Quote
│   ├── Free Gutter Cleaning Estimate   └── Holiday Lighting Estimate
└── Privacy Policy                 /privacy.html
```

XML sitemap is auto-generated at `/sitemap.xml` and referenced from `/robots.txt`.

---

## 2. Header, navigation & footer structure

**Header (sticky floating glass bar):** Logo · Services mega-menu (all 10) · Plans · Commercial ·
Service Areas · Gallery · Reviews · More mega-menu (About, Team, Why Us, Residential, Blog, FAQs,
Financing, Careers) · Contact · **click-to-call** · **Free Quote** button. Collapses to a slide-in
drawer on mobile with an always-visible sticky Call / Free Quote bar.

**Footer:** Brand + NAP + social · Services column · Service Areas column · Company column · legal
row (copyright, Free Quote, FAQs, Service Areas, Privacy). NAP is identical site-wide for local-SEO
consistency.

---

## 3. Wireframe / section blueprint

**Homepage** (top → bottom): Glass nav → Hero (headline + instant-quote form) → Trust badge strip →
Value proposition (6 reasons) → Services grid (10) → Animated stat counters → How-it-works (4 steps)
→ Before/After sliders → Membership teaser (3 plans) → Reviews (3) → Areas-we-serve grid → FAQ →
Final CTA band → Footer → sticky mobile CTA.

**Service page:** Page hero + side quote form → overview split (copy + before/after) → benefits grid
→ "what's included" checklist → reviews → service FAQ (with FAQ schema) → related services → CTA.

**Service-area page:** Local hero + quote form → local intro (city + neighborhoods) → services →
local reviews → local FAQ → city-specific CTA.

**Landing page:** Hero + form above the fold → trust badges → benefits + before/after → guarantee
band → reviews → "why now" + FAQ → CTA. Minimal nav distractions, conversion-first.

---

## 4. Per-page SEO (titles, meta, keywords, schema)

Every page ships with a unique `<title>`, meta description, canonical, Open Graph/Twitter tags, an
H1, structured H2/H3s, internal links, and JSON-LD. Representative targets:

| Page | Primary keyword | Schema |
| --- | --- | --- |
| Home | window cleaning Delano MN | LocalBusiness, Organization, WebSite, FAQPage |
| Window Cleaning | window cleaning Delano MN | Service, FAQPage, BreadcrumbList |
| Gutter Cleaning | gutter cleaning Delano MN | Service, FAQPage, BreadcrumbList |
| Pressure Washing | pressure washing Delano MN | Service, FAQPage, BreadcrumbList |
| House Washing | house washing Delano MN | Service, FAQPage, BreadcrumbList |
| Roof Cleaning | roof cleaning Delano MN | Service, FAQPage, BreadcrumbList |
| Commercial | commercial window cleaning Twin Cities MN | LocalBusiness |
| Reviews | Barta Window Washing reviews Delano MN | AggregateRating (LocalBusiness) |
| FAQs | window cleaning FAQ Delano MN | FAQPage |
| Area: `<city>` | window cleaning `<city>` MN | Service, FAQPage, BreadcrumbList |
| Landing pages | free `<service>` quote Delano MN | FAQPage |
| Blog posts | topic long-tail (e.g. roof black streaks) | BlogPosting |

**Secondary keyword themes:** "near me", interior/exterior, soft wash, algae/mildew removal, hard
water spots, downspout, curb appeal, residential/commercial, plus nearby-city and neighborhood
modifiers (e.g. *Arbor Lakes*, *Bass Lake*, *Lake Minnewashta*) embedded in the area pages.

**Image alt text:** every functional image has descriptive alt text; before/after images describe
the transformation; placeholder slots carry `aria-label`s ready to copy into real `alt` attributes.

**Internal linking:** services ↔ residential/commercial ↔ areas ↔ plans ↔ quote are cross-linked;
each service page links to 3 related services; area pages link to services and the quote page.

---

## 5. Local SEO playbook

**Google Business Profile (GBP)**
- Primary category: *Window Cleaning Service*; secondary: *Pressure Washing Service*, *Gutter
  Cleaning Service*, *Building Restoration Service*.
- Match name/address/phone exactly to the site footer (NAP consistency).
- Add all services as GBP "Services" with the same names used here; write a keyword-rich business
  description mirroring the homepage value prop.
- Upload real before/after photos weekly; post seasonal offers (spring windows, fall gutters,
  holiday lighting) as GBP Posts.
- Request reviews after every job with a direct review link; respond to all reviews.
- Enable messaging + booking; keep hours and service area current.

**Local citations / directories** (consistent NAP everywhere)
- Bing Places, Apple Business Connect, Yelp, Nextdoor, Angi, Thumbtack, HomeAdvisor, Houzz,
  Facebook, BBB, Yellow Pages, Chamber of Commerce (Delano/Wright County), local HOA directories.

**Nearby-city keyword targets** (each has a dedicated page): Delano, Maple Grove, Plymouth, Wayzata,
Minnetonka, Buffalo, Rockford, Waconia, Chanhassen, Medina, Corcoran, Watertown — expandable in
`build/sitedata.py` (`AREAS`).

**Review velocity & E-E-A-T:** showcase the 4.9★ / 327+ count (LocalBusiness `aggregateRating`),
keep the team page authentic, and publish a steady cadence of helpful local blog content.

---

## 6. Color palette

Built from the Barta logo: the coral **//** mark, heavy black wordmark, and white. Bold, premium,
and unmistakably on-brand.

| Token (CSS var) | Hex | Use |
| --- | --- | --- |
| Coral (`--blue-600`) | `#fb4d3d` | **Primary brand** — CTAs, links, icons, the // mark |
| Coral light (`--blue-500`) | `#ff5e43` | Gradient mid |
| Coral-orange (`--aqua-400`) | `#ff6a3d` | Gradient end |
| Light coral (`--sky-400`) | `#ff8a73` | Focus rings |
| Pale coral (`--aqua-300`) | `#ffb3a3` | Accents/eyebrows on dark |
| Near-black (`--navy-900`) | `#0a0a0c` | Footer, deepest backgrounds |
| Ink (`--navy-800` / `--ink`) | `#16161b` / `#121215` | Headings, dark sections, wordmark |
| Charcoal (`--navy-700`) | `#24242b` | Dark gradient top |
| Gold | `#ffb400` | Star ratings |
| Green | `#18b673` | Success state, guarantee checkmarks |
| Slate 700/500 | `#3b3b42` / `#67676f` | Body / muted text |
| Line / Mist | `#ececee` / `#f7f7f8` | Borders / section backgrounds |
| White | `#ffffff` | Cards, base |

Signature gradient: **`135deg, #fb4d3d → #ff6a3d`** (coral). Dark sections use a near-black gradient
(`#1b1b21 → #08080a`) with soft coral radial glows. The logo mark, favicon, and social card all use
coral-on-black. Variable names are inherited from the prior theme but the values are the brand
palette — change them once in `:root` (assets/css/styles.css) to re-tune site-wide.

---

## 7. Typography

A premium, modern pairing (DirtyMint-style design language) served from Fontshare:

- **Headings:** *Cabinet Grotesk* (800–900) — bold, characterful display grotesk; big and friendly.
- **Body / UI:** *General Sans* (400–700) — clean geometric-humanist sans, highly legible.
- Loaded via `https://api.fontshare.com/v2/css?f[]=cabinet-grotesk@700,800,900&f[]=general-sans@400,500,600,700`
- Fluid type scale via `clamp()` (H1 ≈ 2.6–4.6rem, weight 900). Softer corner radii (cards 28px,
  panels 38px) for the rounded, premium feel.
- Fallback chain keeps *Plus Jakarta Sans* / system fonts if the web fonts are slow, so text always
  renders cleanly. To self-host instead (no third-party CDN), download the woff2 files from Fontshare
  into `assets/fonts/` and add `@font-face` rules — see README.

---

## 8. Button & component styles

- **Primary button:** gradient fill, pill radius, soft glow shadow, lift + gradient-shift on hover.
- **Light / ghost / outline** variants for use on dark, light, and tinted backgrounds.
- **Cards:** white, 1px hairline border, soft shadow, lift on hover; service cards animate their
  icon to the brand gradient on hover.
- **Iconography:** inline stroke SVG (currentColor) — zero extra requests, crisp at any size, easily
  recolored. Library in `build/icons.py`.
- **Before/After slider:** drag handle + range input, keyboard/touch/pointer accessible.
- **Animated counters:** count up on scroll into view; show final value if JS/IO is unavailable.

---

## 9. Animation recommendations (implemented)

- Scroll-reveal (fade + rise) with staggered delays; **disabled** under `prefers-reduced-motion` and
  fully visible without JS (the hidden state is gated behind an `html.js` class).
- Smooth scrolling, nav shadow/condense on scroll, hover lifts, gentle float on hero accents,
  count-up stats, animated before/after reveal. Keep it subtle — motion supports, never distracts.

---

## 10. Conversion-rate-optimization (CRO) strategy

- **Above-the-fold quote form** on the homepage, every service, every area, and every landing page.
- **Multiple CTAs per page** with action verbs: *Get Your Free Quote*, *Book Today*, *Call Now*,
  *Join Our Maintenance Plan*, *Schedule Online*.
- **Sticky mobile CTA bar** (Call + Free Quote) always within thumb reach.
- **Trust stack** repeated: 4.9★ rating, review count, licensed & insured, family-owned, guarantee.
- **Friction reducers:** "60 seconds", "no obligation", "same-day pricing", reminder opt-in checked
  by default, success state with a fallback click-to-call.
- **Social proof near decisions:** reviews appear on service, area, landing, and home pages.

### Live Google reviews

The site supports **auto-updating Google reviews** via a drop-in widget. Paste your provider's
embed code (Featurable, Trustindex, Elfsight, EmbedSocial — all Google-approved and free-tier
friendly) into `config/google-reviews-embed.html`, then run `python3 build/build.py`. Your live
reviews render on the **homepage reviews section** and the **Reviews page**; until then, the curated
written reviews show automatically as a fallback (no empty section). Curated highlight cards remain
on service/area/landing pages to protect page speed. Note: Google's own API caps at 5 reviews per
location, which is why a widget (full review set, auto-refresh, compliant caching) is recommended.
- **Risk reversal:** explicit 100% satisfaction guarantee, plus per-service guarantee lines on
  landing pages.
- **Recurring revenue:** membership teaser on the homepage funnels to the plans page; plan-info
  opt-in on every form.
- **Next steps:** install analytics + conversion tracking (GA4 + Google Ads), add call tracking,
  A/B test hero headlines and form length, and consider exit-intent + click-to-text.

---

## 11. Mobile layout recommendations (implemented)

- Mobile-first CSS; single-column stacking for grids, forms, and splits at ≤760px.
- Slide-in drawer nav with grouped Services; condensed glass bar.
- Sticky bottom Call/Quote bar; body padding reserves space for it.
- Large tap targets (44px+), readable 16px base (prevents iOS zoom), no horizontal scroll.
- Plans collapse to one column with the featured plan surfaced first.

---

## 12. Forms

Every key page includes the full lead form: **Name, Phone, Email, Address, Service Requested,
Preferred Date, Preferred Time, How did you hear about us?, Notes**, plus **reminder** and
**maintenance-plan info** checkboxes, and contextual submit buttons (*Get My Free Quote / Request
Estimate / Book My Service / Send Message*). Client-side validation + success state are built in;
connect the handler in `assets/js/main.js` to your CRM before launch.
