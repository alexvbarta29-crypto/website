#!/usr/bin/env python3
"""
Barta Window Washing — static site generator.
Run from repo root:  python3 build/build.py
Outputs HTML pages, sitemap, robots, manifest, and placeholder imagery.
"""
import os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

from sitedata import BIZ, SERVICES, AREAS, REVIEWS, TEAM, POSTS, FAQS, HOME_SERVICES, ZIP_CODES, IMAGE_ALT, PROMO_PLANS
from icons import icon
import components as C
import schema as S

PAGES = []  # (relpath, slug, lastmod, priority) for sitemap

def load_reviews_widget(filename="google-reviews-embed.html"):
    """Return the Google reviews embed code if the owner has pasted one,
    else '' so pages fall back to curated review cards."""
    import re
    p = os.path.join(ROOT, "config", filename)
    if not os.path.exists(p):
        return ""
    raw = open(p, encoding="utf-8").read()
    # Ignore the instructional HTML comment(s) — only real markup counts.
    stripped = re.sub(r"<!--.*?-->", "", raw, flags=re.S).strip()
    return raw if stripped else ""

# Homepage teaser uses one widget; the standalone Reviews page uses another
# (e.g. a compact carousel on the homepage vs. a full grid on reviews.html).
REVIEWS_WIDGET = load_reviews_widget("google-reviews-embed.html")
REVIEWS_WIDGET_PAGE = load_reviews_widget("google-reviews-embed-reviews-page.html") or REVIEWS_WIDGET

def write(relpath, html, slug=None, priority="0.7"):
    path = os.path.join(ROOT, relpath)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(html)
    # Pages whose <meta name="robots"> says noindex (legal/utility pages, PPC
    # landing pages) are deliberately excluded from the sitemap — a sitemap
    # entry for a noindexed URL is a direct contradiction search engines flag.
    if 'name="robots" content="noindex' not in html:
        PAGES.append((relpath, slug if slug is not None else relpath, priority))

def _jpeg_size(path):
    """Pure-stdlib JPEG pixel-size reader (scans SOF0/2/etc. markers) — used
    when Pillow isn't installed so a missing dependency can't silently write
    a wrong, hardcoded aspect ratio into width/height attributes (that's a
    real CLS/layout-shift bug, not just a cosmetic one)."""
    with open(path, "rb") as f:
        data = f.read()
    if data[0:2] != b"\xff\xd8":
        return None
    i = 2
    sof_markers = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
                   0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}
    while i < len(data) - 9:
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        if marker in sof_markers:
            h = (data[i + 5] << 8) + data[i + 6]
            w = (data[i + 7] << 8) + data[i + 8]
            return (w, h)
        seg_len = (data[i + 2] << 8) + data[i + 3]
        i += 2 + seg_len
    return None

_IMG_SIZE_CACHE = {}
def _img_size(relpath, default=(1125, 1500)):
    """Real pixel dimensions of an assets/img file, used for the hero <img>'s
    width/height attributes (correct aspect-ratio hint, no invented numbers).
    Tries Pillow first, then a dependency-free JPEG header read, and only
    falls back to `default` if the file is genuinely missing or unreadable
    — this should never fail the build, but should also never silently
    report the wrong aspect ratio for a file that does exist."""
    if relpath in _IMG_SIZE_CACHE:
        return _IMG_SIZE_CACHE[relpath]
    full = os.path.join(ROOT, relpath)
    size = default
    try:
        from PIL import Image
        with Image.open(full) as im:
            size = im.size
    except Exception:
        try:
            jpeg_size = _jpeg_size(full)
            if jpeg_size:
                size = jpeg_size
        except Exception:
            pass
    _IMG_SIZE_CACHE[relpath] = size
    return size

def _hero_picture_html(root, image_path, hero_pos=None, img_class="svc-hero-img", alt=""):
    """Responsive hero <picture>: WebP source + JPG fallback, each with a
    640w/1200w srcset (see generate_hero_variants()) so a phone downloads the
    small file and only one image request happens either way — never both a
    CSS background and an <img>. Falls back to the single full-resolution
    image (previous behavior) if the responsive variants haven't been
    generated for some reason, so a missing Pillow install can't break a page.
    hero_pos=None omits the inline object-position style, leaving cropping to
    the page's own CSS (including any @media override) — used by the
    homepage hero, whose .hero-bg-img rule already handles this responsively.
    Adds a 1920w candidate to the srcset when one exists on disk (currently
    only the homepage van hero) so a large/high-DPI screen isn't stuck
    stretching the 1200w file."""
    style = f'style="object-position:50% {hero_pos}"' if hero_pos else ""
    stem = image_path.rsplit(".", 1)[0]
    variants_exist = all(
        os.path.exists(os.path.join(ROOT, f"{stem}-{w}w.{fmt}"))
        for w in (640, 1200) for fmt in ("webp", "jpg"))
    if not variants_exist:
        w, h = _img_size(image_path)
        return C.picture(root, image_path, alt, img_class=img_class,
                          extra_attrs=f'width="{w}" height="{h}" fetchpriority="high" decoding="async" {style}')
    has_1920 = all(os.path.exists(os.path.join(ROOT, f"{stem}-1920w.{fmt}")) for fmt in ("webp", "jpg"))
    webp_srcset = f"{root}{stem}-640w.webp 640w, {root}{stem}-1200w.webp 1200w"
    jpg_srcset = f"{root}{stem}-640w.jpg 640w, {root}{stem}-1200w.jpg 1200w"
    default_w = "1200w"
    if has_1920:
        webp_srcset += f", {root}{stem}-1920w.webp 1920w"
        jpg_srcset += f", {root}{stem}-1920w.jpg 1920w"
        default_w = "1920w"
    w_img, h_img = _img_size(f"{stem}-{default_w}.jpg")
    return (f'<picture>'
            f'<source type="image/webp" srcset="{webp_srcset}" sizes="100vw">'
            f'<img class="{img_class}" src="{root}{stem}-{default_w}.jpg" '
            f'srcset="{jpg_srcset}" sizes="100vw" '
            f'alt="{alt}" width="{w_img}" height="{h_img}" fetchpriority="high" decoding="async" {style}>'
            f'</picture>')

BASE_SCHEMA = [S.local_business(), S.organization(), S.website()]

# Only the six primary-tier cities get their own page. The 31 extended-area
# communities are still named on service-areas.html (and counted in the
# coverage copy) but no longer have a page of their own: 37 city pages that
# were 85-98% identical to each other is the doorway-page pattern Google
# targets, and consolidating concentrates the ranking signal on the cities
# the business actually operates out of.
PRIMARY_AREAS = [a for a in AREAS if a["tier"] == "primary"]
EXTENDED_AREAS = [a for a in AREAS if a["tier"] != "primary"]
PRIMARY_SLUGS = {a["slug"] for a in PRIMARY_AREAS}

TITLE_MAX = 60  # Google truncates search-result titles around here

def seo_title(core):
    """Page <title> kept under TITLE_MAX so search results don't cut it off
    mid-word. Appends the full brand when it fits and falls back to the short
    "Barta" form when it doesn't — losing part of the brand name is better
    than losing the end of the page's actual subject. Only affects <title>;
    on-page H1s are set separately and are unchanged."""
    full = f"{core} | {BIZ['name']}"
    if len(full) <= TITLE_MAX:
        return full
    short = f"{core} | Barta"
    return short if len(short) <= TITLE_MAX else core

def stars_row():
    return '<span class="stars">' + icon('star') * 5 + '</span>'

# ===========================================================================
# HOMEPAGE
# ===========================================================================
def build_home():
    depth = 0
    svc_cards = "".join(C.picture_card(item, depth, i) for i, item in enumerate(HOME_SERVICES))

    reviews_html = "".join(C.review_card(*r, delay=i % 3) for i, r in enumerate(REVIEWS[:6]))
    # Full community list, ordered priority-first — sized so the grid's
    # bottom edge lines up with the map beside it (a full square that grows
    # with viewport width); service-areas.html remains the dedicated,
    # detail-per-city page this grid links out to.
    _HOME_AREA_SLUGS = ["delano", "buffalo", "medina", "mound", "plymouth", "st-michael",
                         "maple-grove", "minnetonka", "wayzata", "orono", "excelsior", "chanhassen",
                         "eden-prairie", "golden-valley", "deephaven", "corcoran", "hamel", "long-lake",
                         "minnetrista", "victoria", "rogers", "loretto", "maple-plain", "hanover",
                         "independence", "greenfield", "rockford", "spring-park", "tonka-bay",
                         "minnetonka-beach"]
    _areas_by_slug = {a["slug"]: a for a in AREAS}
    _priority_areas = [_areas_by_slug[slug] for slug in _HOME_AREA_SLUGS]
    def _area_chip(a, i):
        inner = f'{icon("pin")} {a["city"]}'
        if a["slug"] in PRIMARY_SLUGS:
            return f'<a class="area-card reveal" data-delay="{i%4}" href="areas/{a["slug"]}.html">{inner}</a>'
        return f'<span class="area-card area-card--static reveal" data-delay="{i%4}">{inner}</span>'
    areas_html = "".join(_area_chip(a, i) for i, a in enumerate(_priority_areas))

    process_steps = [
        ("01", "Mop", "assets/img/svc-mop-window.jpg",
         "We start by mopping down every window with our T-bar scrubbers, working a cleaning solution into the glass to lift dirt, dust, pollen, and grime off the surface and get each pane ready for a deeper clean.", None),
        ("02", "Scrub", "assets/img/svc-hand-scrubbing.jpg",
         "Next, we scrub the glass by hand with our industrial-grade abrasives, going after the more aggressive buildup — silicone, putty overspray, baked-on bug residue — that a simple wash won't touch, without ever scratching the glass.", None),
        ("03", "Squeegee", "assets/img/svc-interior-window-cleaning.jpg",
         "Then we squeegee the window from edge to edge, pulling every last drop of water and solution off the glass so nothing is left behind to dry into streaks or spots.", None),
        ("04", "Detail", "assets/img/svc-detail-frame.jpg",
         "Finally, we hand-detail the glass, frames, and sills — wiping down every edge and corner so the window looks brand new, not just clean, before we move on to the next one.", None),
    ]
    process_slider_html = C.process_slider(process_steps, depth)

    why = [
        ("shield", "Fully insured", "Full insurance coverage on every job. Your home and our team are always protected."),
        ("home", "Locally &amp; family owned", "Born and based in Delano. We treat your home like a neighbor's — because you are one."),
        ("leaf", "Safe, eco-friendly methods", "Biodegradable solutions and the right pressure for every surface. Safe for your family, pets, and landscaping."),
        ("award", "Obsessed with detail", "Sills, tracks, screens, downspouts — we sweat the details most companies skip."),
        ("clock", "On time, every time", "We respect your schedule with confirmed windows, text updates, and crews that show up when we say."),
        ("check-circle", "100% satisfaction guarantee", "If any part of your service isn't perfect, we return and re-clean it free. No hassle, no fine print."),
    ]
    why_html = "".join(
        f'<div class="feature reveal" data-delay="{i%3}"><span class="ic">{icon(ic)}</span><div><h3>{t}</h3><p>{d}</p></div></div>'
        for i, (ic, t, d) in enumerate(why))

    # Recurring-plan savings cards ("Save money with every service")
    promo_cards = C.promo_plan_cards(depth)

    ba_html = "".join(
        f'<div class="reveal" data-delay="{i}">{C.ba_slider(depth=depth, name=n)}</div>'
        for i, n in enumerate(["ba1", "ba2", "ba3"]))

    home_faqs = FAQS[:5]
    schema = BASE_SCHEMA + [S.faq_schema(home_faqs)]

    html = C.head(
        title=seo_title("Window &amp; Exterior Cleaning in Delano, MN"),
        desc="Professional window and exterior cleaning based in Delano and serving the western Twin Cities. Explore our services and request a free quote.",
        slug="index.html", depth=depth, schema=schema,
        canonical=BIZ["domain"] + "/", uses_reviews_widget=True)
    html += C.nav(depth)
    hero_picture = _hero_picture_html("", "assets/img/hero-home.jpg", img_class="hero-bg-img",
                                       alt="The branded Barta Window Washing (BWW) service van in the Delano, MN area")
    html += f"""
<main id="main">
  <!-- HERO -->
  <section class="hero hero-photo-full">
    {hero_picture}
    <div class="hero-overlay"></div>
    <div class="container">
      <div class="hero-content reveal in">
        {C.google_badge(depth)}
        <h1>Dirty Windows?<br>We can <em>fix that.</em></h1>
        <p class="lead">Professional window and exterior cleaning based in Delano and serving communities throughout the western Twin Cities.</p>
        <div class="hero-actions">
          <a class="btn btn-lg" href="get-quote.html">Get Your Free Quote {icon('arrow')}</a>
        </div>
      </div>
    </div>
  </section>

  <!-- SERVICES (straight after hero) -->
  <section>
    <div class="container">
      <div class="section-head center">
        <span class="eyebrow" style="justify-content:center">Services</span>
        <h2>Our Services</h2>
      </div>
      <div class="svc-grid">{svc_cards}</div>
    </div>
  </section>

  <!-- PLANS / SAVINGS -->
  <section class="bg-mist">
    <div class="container">
      <div class="section-head center">
        <span class="eyebrow" style="justify-content:center">Membership Savings</span>
        <h2>Save money with every service</h2>
        <p>Join a recurring plan and save on every visit — the more often we come, the more you save.</p>
      </div>
      <div class="promo-grid">{promo_cards}</div>
    </div>
  </section>

  <!-- REVIEWS (Google) -->
  <section>
    <div class="container">
      <div class="section-head center">
        <span class="eyebrow" style="justify-content:center">See what your</span>
        <h2>Neighbors are saying</h2>
      </div>
      {C.reviews_block(REVIEWS_WIDGET, reviews_html, depth)}
    </div>
  </section>

  <!-- PROCESS -->
  <section>
    <div class="container">
      <div class="section-head center">
        <span class="eyebrow">How it works</span>
        <h2>Our 4-step process</h2>
        <p>Every job follows the same disciplined routine — mop, scrub, squeegee, detail — for a streak-free finish, every time.</p>
      </div>
      {process_slider_html}
    </div>
  </section>

  <!-- BEFORE / AFTER -->
  <section class="bg-mist">
    <div class="container">
      <div class="section-head center">
        <span class="eyebrow">See the difference</span>
        <h2>Before &amp; After Results</h2>
        <p>Drag the slider to compare the before and after results.</p>
      </div>
      <div class="grid cols-3">{ba_html}</div>
    </div>
  </section>

  <!-- FOLLOW ALONG -->
  <section id="photos">
    <div class="container">
      <div class="section-head center">
        <span class="eyebrow" style="justify-content:center">Follow along</span>
        <h2>Follow along with us</h2>
      </div>
      {C.instagram_carousel(depth)}
      <div class="follow-socials reveal">
        <a href="{BIZ['facebook']}" aria-label="Facebook" target="_blank" rel="noopener">{icon('facebook')}</a>
        <a href="{BIZ['instagram']}" aria-label="Instagram" target="_blank" rel="noopener">{icon('instagram')}</a>
        <a href="{BIZ['tiktok']}" aria-label="TikTok" target="_blank" rel="noopener">{icon('tiktok')}</a>
      </div>
    </div>
  </section>

  <!-- AREAS -->
  <section>
    <div class="container">
      <div class="section-head center">
        <span class="eyebrow">Areas we serve</span>
        <h2>Proudly cleaning Delano &amp; the western Twin Cities</h2>
        <p>Delano is our home base — from there we serve homeowners and businesses across the western Twin Cities metro, including the communities below.</p>
      </div>
      <div class="areas-split">
        {C.gmap_embed(f"{BIZ['legal_name']} on Google Maps — serving {BIZ['city']} and the western Twin Cities", cls="reveal map-pin-left")}
        <div class="area-grid reveal">{areas_html}</div>
      </div>
      <div class="center mt-4"><a class="btn btn-ghost" href="service-areas.html">View All Service Areas {icon('arrow')}</a></div>
    </div>
  </section>

  <!-- FAQ -->
  <section class="bg-mist">
    <div class="container">
      <div class="section-head center">
        <span class="eyebrow">Good to know</span>
        <h2>Frequently asked questions</h2>
        <p>Everything you need to feel confident booking with Barta.</p>
      </div>
      {C.faq_block(home_faqs)}
      <div class="center mt-4"><a class="btn btn-ghost" href="faqs.html">View all FAQs {icon('arrow')}</a></div>
    </div>
  </section>

  {C.cta_band(depth, text="Join homeowners across Delano and the western Twin Cities who trust Barta for spotless, stress-free exterior cleaning. Get your free quote today.")}
</main>
"""
    html += C.page_end(depth)
    write("index.html", html, slug="", priority="1.0")

# ===========================================================================
# SERVICE PAGES
# ===========================================================================
# Three natural, non-identical service-area write-ups grouped by service
# family, each linking a genuinely useful subset of real area pages (never
# a long city/ZIP list) plus the service-areas hub. svc_lower is filled in
# per page; the area links themselves come from _service_area_links().
_SERVICE_AREA_TEMPLATES = {
    # Every family ends on {hub_view_all} — "View all communities we serve." —
    # for a single consistent anchor-text pattern sitewide.
    "glass": "Barta is based in Delano, MN, and provides {svc_lower} for homes throughout the western Twin Cities — including {a1}, {a2}, {a3}, and {a4}. {hub_view_all}",
    "wash": "Based in Delano, Barta brings {svc_lower} to homes across the western Twin Cities metro, from {a1} and {a2} to {a3} and {a4}. {hub_view_all}",
    "specialty": "Barta is based in Delano and serves homeowners and businesses throughout the western Twin Cities, including {a1}, {a2}, {a3}, and {a4}. {hub_view_all}",
}
_SERVICE_AREA_FAMILY = {
    "exterior-window-cleaning": ("glass", ("plymouth", "medina", "st-michael", "buffalo")),
    "interior-window-cleaning": ("glass", ("plymouth", "medina", "st-michael", "buffalo")),
    "track-detailing": ("glass", ("plymouth", "medina", "st-michael", "buffalo")),
    "screen-cleaning": ("glass", ("plymouth", "medina", "st-michael", "buffalo")),
    "hard-water-stain-removal": ("glass", ("mound", "medina", "plymouth", "buffalo")),
    "gutter-cleaning": ("wash", ("buffalo", "mound", "medina", "delano")),
    "pressure-washing": ("wash", ("buffalo", "mound", "medina", "delano")),
    "house-washing": ("wash", ("buffalo", "mound", "medina", "delano")),
    "soft-washing": ("wash", ("buffalo", "mound", "medina", "delano")),
    "solar-panel-cleaning": ("specialty", ("plymouth", "medina", "mound", "st-michael")),
    "commercial-cleaning": ("specialty", ("plymouth", "medina", "st-michael", "mound")),
    "christmas-light-installation": ("specialty", ("plymouth", "medina", "mound", "st-michael")),
}
# Primary-tier only — these are the cities that still have their own page.
_AREA_LABELS = {"plymouth": "Plymouth", "medina": "Medina", "mound": "Mound",
                "buffalo": "Buffalo", "delano": "Delano", "st-michael": "St. Michael"}

def _service_area_section(svc, depth):
    root = C.rel(depth)
    family, area_slugs = _SERVICE_AREA_FAMILY.get(svc["slug"], ("specialty", ("plymouth", "medina", "mound", "buffalo")))
    links = [f'<a href="{root}areas/{slug}.html">{_AREA_LABELS[slug]}</a>' for slug in area_slugs]
    hub_view_all = f'<a href="{root}service-areas.html">View all communities we serve.</a>'
    text = _SERVICE_AREA_TEMPLATES[family].format(
        svc_lower=svc["name"].lower(), a1=links[0], a2=links[1], a3=links[2], a4=links[3],
        hub_view_all=hub_view_all)
    return f"""
  <section class="bg-mist">
    <div class="container">
      <div class="prose" style="max-width:760px;margin-inline:auto;text-align:center">
        <span class="eyebrow" style="justify-content:center">Where we work</span>
        <h2 class="mt-1">Serving Delano &amp; the western Twin Cities</h2>
        <p class="mt-2">{text}</p>
      </div>
    </div>
  </section>"""

def _xmas_garland_svg():
    """Draped string-light garland across the top of the Christmas Lights
    hero — a wavy wire with twinkling colored bulbs, generated rather than
    hand-plotted so the spacing stays even at any width."""
    import math
    colors = ["#fb4d3d", "#18b673", "#f5c344"]
    n = 15
    pts = [(i * (1200 / (n - 1)), 18 + 9 * math.sin(i * 0.9)) for i in range(n)]
    wire = "M" + " ".join(f"{x:.0f} {y:.0f}" for x, y in pts)
    bulbs = "".join(
        f'<circle class="xmas-bulb" cx="{x:.0f}" cy="{y:.0f}" r="5.5" style="fill:{colors[i % 3]};color:{colors[i % 3]}"/>'
        for i, (x, y) in enumerate(pts))
    return (f'<div class="xmas-garland" aria-hidden="true"><svg viewBox="0 0 1200 36" preserveAspectRatio="none">'
            f'<path d="{wire}" fill="none" stroke="rgba(255,255,255,.4)" stroke-width="2"/>{bulbs}</svg></div>')

_XMAS_SNOW_SEED = [
    (2, 5, 12.4, -3.1, -18), (7, 4, 9.8, -8.2, 24), (13, 6, 14.1, -1.5, -30),
    (19, 3, 8.5, -12.0, 15), (24, 5, 11.9, -5.6, -22), (30, 4, 10.4, -9.9, 30),
    (36, 6, 15.6, -2.4, -12), (42, 3, 8.9, -14.3, 20), (48, 5, 12.8, -6.8, -26),
    (54, 4, 9.6, -10.5, 10), (60, 6, 14.9, -1.0, -34), (66, 3, 8.2, -13.6, 18),
    (71, 5, 11.3, -7.4, -16), (77, 4, 10.1, -11.2, 28), (83, 6, 15.2, -3.8, -20),
    (88, 3, 9.1, -9.0, 24), (93, 5, 12.2, -5.1, -28), (97, 4, 10.8, -12.8, 14),
]

def _xmas_snow():
    """A fixed set of falling-snow dots (deterministic so rebuilds never
    diverge) drifting slowly down over the hero photo."""
    spans = "".join(
        f'<span style="left:{left}%;width:{size}px;height:{size}px;'
        f'animation-duration:{dur}s;animation-delay:{delay}s;--drift:{drift}px"></span>'
        for left, size, dur, delay, drift in _XMAS_SNOW_SEED)
    return f'<div class="xmas-snow" aria-hidden="true">{spans}</div>'

def build_service(svc):
    depth = 1
    root = C.rel(depth)
    checkbox_slug = C.SERVICE_SLUG_TO_LABEL.get(svc["slug"], svc["slug"])
    benefits_html = "".join(
        f'<li>{icon("check-circle")} <span><strong>{t}:</strong> {d}</span></li>' for t, d in svc["benefits"])
    includes_html = "".join(f'<li>{icon("check-circle")} {x}</li>' for x in svc["includes"])
    # Homepage-style process slideshow — shown only for exterior/interior window
    # cleaning (the two pages the process actually differs meaningfully for);
    # every other service page skips this section entirely.
    _wc_step_imgs = ["assets/img/svc-mop-window.jpg", "assets/img/svc-hand-scrubbing.jpg",
                     "assets/img/svc-interior-window-cleaning.jpg", "assets/img/svc-detail-frame.jpg"]
    _has_process = svc["slug"] in ("exterior-window-cleaning", "interior-window-cleaning")
    slider_steps = []
    if _has_process:
        for i, (t, d) in enumerate(svc.get("process", [])):
            img = _wc_step_imgs[i] if i < len(_wc_step_imgs) else None
            slider_steps.append((f"{i+1:02d}", t, img, d, svc["icon"]))
    process_section = ""
    if slider_steps:
        process_section = f"""
  <section>
    <div class="container">
      <div class="section-head center">
        <span class="eyebrow">How it works</span>
        <h2>Our {svc['name'].lower()} process</h2>
      </div>
      {C.process_slider(slider_steps, depth)}
    </div>
  </section>"""
    reviews_html = "".join(C.review_card(*r, delay=i % 3) for i, r in enumerate(REVIEWS[:6]))

    # Christmas Light Installation is its own thing: no membership plans (a
    # seasonal, once-a-year job doesn't have a recurring-visit discount), and
    # a lighter, more character-driven "how it works" + benefits section —
    # an inline numbered flow and an icon+text list rather than card grids —
    # right under the hero.
    is_xmas = svc["slug"] == "christmas-light-installation"
    xmas_extra = ""
    if is_xmas:
        _xmas_tone = lambda i: "xmas-red" if i % 2 == 0 else "xmas-green"
        step_items = "".join(
            f'<div class="xmas-step reveal" data-delay="{i%3}">'
            f'<span class="step-num {_xmas_tone(i)}">{i+1}</span>'
            f'<h3>{t}</h3><p>{d}</p></div>'
            for i, (t, d) in enumerate(svc.get("experience_steps", [])))
        benefit_icons = ["sparkle", "gift", "snowflake", "award", "shield", "star"]
        benefit_items = "".join(
            f'<div class="xmas-benefit reveal" data-delay="{i%3}"><span class="ic {_xmas_tone(i)}">{icon(benefit_icons[i % len(benefit_icons)])}</span>'
            f'<div><h3>{t}</h3><p>{d}</p></div></div>'
            for i, (t, d) in enumerate(svc["benefits"]))
        lights_divider = ('<svg class="xmas-lights" viewBox="0 0 1200 50" preserveAspectRatio="none" aria-hidden="true">'
                           '<path d="M0 15 Q100 45 200 15 T400 15 T600 15 T800 15 T1000 15 T1200 15" fill="none" stroke="var(--line)" stroke-width="2"/>'
                           '<circle class="xmas-bulb" cx="70" cy="32" r="6" style="fill:#fb4d3d;color:#fb4d3d"/><circle class="xmas-bulb" cx="270" cy="4" r="6" style="fill:#18b673;color:#18b673"/>'
                           '<circle class="xmas-bulb" cx="470" cy="32" r="6" style="fill:#f5a623;color:#f5a623"/><circle class="xmas-bulb" cx="670" cy="4" r="6" style="fill:#fb4d3d;color:#fb4d3d"/>'
                           '<circle class="xmas-bulb" cx="870" cy="32" r="6" style="fill:#18b673;color:#18b673"/><circle class="xmas-bulb" cx="1070" cy="4" r="6" style="fill:#f5a623;color:#f5a623"/></svg>')
        xmas_extra = f"""
  <div class="xmas-candy-stripe" aria-hidden="true"></div>
  <section class="xmas-highlight">
    <div class="container">
      {lights_divider}
      <p class="pill" style="margin-inline:auto;width:fit-content;text-align:center">{icon('clock')} {svc['process_note']}</p>
      <div class="section-head center mt-3">
        <span class="eyebrow">How it works</span>
        <h2>The Barta Holiday Lighting Experience</h2>
      </div>
      <div class="xmas-steps">{step_items}</div>
    </div>
  </section>
  <div class="xmas-candy-stripe" aria-hidden="true"></div>
  <section class="bg-mist">
    <div class="container">
      <div class="section-head center">
        <span class="eyebrow">Why homeowners choose us</span>
        <h2>Built for Minnesota winters</h2>
      </div>
      <div class="xmas-benefits">{benefit_items}</div>
    </div>
  </section>"""

    # The generic "how often should I schedule this / membership plans bundle
    # it" FAQ is wrong for services that aren't routine recurring maintenance:
    # a one-time restoration project, or a contract-based commercial service.
    # Christmas lights gets a fully custom FAQ set (svc["faqs"]) instead.
    _frequency_faq_overrides = {
        "hard-water-stain-removal": (
            "How often will I need hard water stain removal?",
            "This is a restoration treatment, not routine maintenance — most homes only need it once to remove existing buildup. If sprinklers or hard water exposure are ongoing, we can also apply a protective coating to help keep new deposits from bonding as easily."),
        "commercial-cleaning": (
            "How often should we schedule commercial cleaning?",
            "It depends on your property, foot traffic, and industry — many commercial clients schedule us on a recurring contract (weekly, monthly, or seasonally) rather than a fixed once- or twice-a-year visit. We'll recommend a schedule after seeing your property."),
    }
    if svc.get("faqs"):
        svc_faqs = svc["faqs"]
    else:
        freq_faq = _frequency_faq_overrides.get(svc["slug"], (
            f"How often should I schedule {svc['name'].lower()}?",
            f"For most Minnesota homes we recommend {svc['name'].lower()} once or twice per year, though it varies by your home and surroundings. Our membership plans bundle it on the ideal schedule at a member discount — so it's handled automatically."))
        svc_faqs = [
            (f"How much does {svc['name'].lower()} cost in {BIZ['city']}?",
             f"Every home is different, so we provide free, upfront, all-in quotes with no hidden fees. Pricing for {svc['name'].lower()} depends on the size and accessibility of your property. Request a quote and we'll get you a clear price."),
            freq_faq,
            ("Are you insured?",
             "Yes — Barta is fully insured."),
            ("Do you guarantee your work?",
             "Always. Every service is backed by our 100% Satisfaction Guarantee. If anything isn't right, call us and we'll re-clean it free."),
        ]
    breadcrumb = S.breadcrumb([
        ("Home", BIZ["domain"] + "/"),
        ("Services", BIZ["domain"] + "/residential.html"),
        (svc["name"], BIZ["domain"] + "/services/" + svc["slug"] + ".html"),
    ])
    schema = BASE_SCHEMA + [S.service_schema(svc), S.faq_schema(svc_faqs), breadcrumb]

    kw2 = ", ".join(svc["kw2"])
    html = C.head(
        title=svc.get("seo_title") or f"{svc['name']} in {BIZ['city']}, MN | {BIZ['name']}",
        desc=svc.get("seo_desc") or f"Professional {svc['name'].lower()} in {BIZ['city']} & the western Twin Cities. {svc['short']} Insured & guaranteed. Get your free quote from Barta today.",
        slug=f"services/{svc['slug']}.html", depth=depth, schema=schema,
        uses_reviews_widget=True)
    html += C.nav(depth)

    hero_img = svc.get("image") or "assets/img/hero-home.jpg"
    hero_pos = svc.get("hero_pos", "30%")
    # Empty alt + aria-hidden wrapper: this photo functions as a background
    # layer behind the H1/lead text (same role the CSS background played
    # before), not standalone content — the adjacent heading already states
    # the service and location, so a screen reader shouldn't announce it twice.
    hero_picture = _hero_picture_html(root, hero_img, hero_pos)

    html += f"""
<main id="main"{' class="xmas-page"' if is_xmas else ""}>
  <section class="svc-hero{' xmas-hero' if is_xmas else ''}">
    <div class="svc-hero-media" aria-hidden="true">{hero_picture}</div>
    <div class="svc-hero-overlay" aria-hidden="true"></div>
    {(_xmas_garland_svg() + _xmas_snow()) if is_xmas else ""}
    <div class="container">
      {C.crumbs([("Home", root + "index.html"), ("Services", root + "residential.html"), (svc['name'], None)], light=True)}
      <h1>{svc.get('h1') or svc['name']}</h1>
      <p class="lead">{svc['hero_sub']}</p>
      <div class="hero-actions">
        <a class="btn btn-lg" href="{root}get-quote.html?svc={checkbox_slug}">Get Your Quote {icon('arrow')}</a>
      </div>
    </div>
  </section>
  {xmas_extra}

  {"" if is_xmas else f'''<section class="bg-mist" id="plans">
    <div class="container">
      <div class="section-head center">
        <span class="eyebrow" style="justify-content:center">Membership Savings</span>
        <h2>Save money with every service</h2>
        <p>Join a recurring plan and save on every visit — the more often we come, the more you save.</p>
      </div>
      <div class="promo-grid">{C.promo_plan_cards(depth, svc=checkbox_slug)}</div>
    </div>
  </section>'''}

  <section class="bg-mist">
    <div class="container">
      <div class="section-head center">
        <span class="eyebrow" style="justify-content:center">See what your</span>
        <h2>Neighbors are saying</h2>
      </div>
      {C.reviews_block(REVIEWS_WIDGET, reviews_html, depth)}
    </div>
  </section>

  <section>
    <div class="container">
      <div class="svc-detail-grid">
        <div class="prose reveal">
          <h2 class="mt-0">{svc['name']} at {BIZ['name']}</h2>
          <p>{svc['intro']}</p>
          <h3>The benefits you'll notice</h3>
          <ul class="checklist">{benefits_html}</ul>
          <h3>What's included</h3>
          <ul class="checklist">{includes_html}</ul>
        </div>
        {C.service_sidebar(f"services/{svc['slug']}.html", depth)}
      </div>
    </div>
  </section>

  {process_section}
  {_service_area_section(svc, depth)}

  <section>
    <div class="container">
      <div class="section-head center"><span class="eyebrow">Questions</span><h2>{svc['name']} FAQs</h2></div>
      {C.faq_block(svc_faqs)}
    </div>
  </section>

  {C.cta_band(depth, heading=f"Ready for spotless results?", text=svc.get("cta_text") or f"Get your free, no-obligation {svc['name'].lower()} quote today and see why homeowners across the western Twin Cities trust Barta.")}
</main>
{C.xmas_quote_modal(depth) if is_xmas else ""}
"""
    html += C.page_end(depth)
    write(f"services/{svc['slug']}.html", html, slug=f"services/{svc['slug']}.html", priority="0.9")

# ===========================================================================
# Generic interior page scaffold
# ===========================================================================
def interior_head(title, desc, slug, eyebrow, h1, lead, depth=0, schema=None,
                  crumb_label=None, primary_kw="", cta_form=False, svc_default=None, noindex=False, h1_class="",
                  phero_class="", hero_extra=""):
    schema = list(schema or BASE_SCHEMA)
    schema.append(S.breadcrumb([
        ("Home", BIZ["domain"] + "/"),
        (crumb_label or h1, BIZ["domain"] + "/" + slug),
    ]))
    html = C.head(title=title, desc=desc, slug=slug, depth=depth, schema=schema, primary_kw=primary_kw, noindex=noindex)
    html += C.nav(depth)
    crumbs = C.crumbs([("Home", C.rel(depth) + "index.html"), (crumb_label or h1, None)])
    if cta_form:
        body = f"""
  <section class="phero {phero_class}">
    <div class="container">
      {crumbs}
      <div class="hero-grid">
        <div>
          <span class="eyebrow">{eyebrow}</span>
          <h1 class="mt-1 {h1_class}">{h1}</h1>
          <p class="lead">{lead}</p>
          <div class="phero-actions">
            <a class="btn btn-lg" href="#quote-form">Get a Free Quote {icon('arrow')}</a>
            <a class="btn btn-lg btn-ghost" href="tel:{BIZ['phone_href']}">{icon('phone')} {BIZ['phone_display']}</a>
          </div>
        </div>
        <div>{C.lead_form(depth, svc_default=svc_default, compact=True)}</div>
      </div>
    </div>
  </section>"""
    else:
        body = f"""
  <section class="phero {phero_class}">
    <div class="container">
      {crumbs}
      <div style="max-width:760px">
        <span class="eyebrow">{eyebrow}</span>
        <h1 class="mt-1 {h1_class}">{h1}</h1>
        <p class="lead">{lead}</p>
        {hero_extra}
      </div>
    </div>
  </section>"""
    return html, body

# ===========================================================================
# RESIDENTIAL
# ===========================================================================
def build_residential():
    depth = 0
    svc_cards = "".join(C.service_image_card(s, depth, i) for i, s in enumerate(SERVICES))
    html, body = interior_head(
        title=seo_title("Residential Exterior Cleaning in Delano, MN"),
        desc="Residential exterior cleaning in Delano and the western metro — windows, gutters, pressure washing and house washing. Family-owned, insured, guaranteed.",
        slug="residential.html", eyebrow="Residential Services",
        h1="Everything your home's exterior needs, in one trusted team",
        lead="Windows, gutters, siding, walkways, and seasonal lighting — Barta keeps every inch of your home's exterior beautifully maintained, so you can simply enjoy it.",
        depth=depth, crumb_label="Residential", cta_form=False,
        primary_kw="residential exterior cleaning Delano MN")
    html += f"""<main id="main">{body}
  <section>
    <div class="container">
      <div class="section-head center"><span class="eyebrow">Our home services</span><h2>Pick a service, or bundle and save</h2>
        <p>Every service is delivered by uniformed, insured professionals and backed by our 100% satisfaction guarantee.</p></div>
      <div class="grid cols-3">{svc_cards}</div>
    </div>
  </section>
  <section class="bg-mist">
    <div class="container">
      <div class="split">
        <div class="reveal">
          <span class="eyebrow">Bundle &amp; save</span>
          <h2 class="mt-1">Why homeowners bundle their exterior care</h2>
          <p>Combining services in one visit saves you money and gives your home a complete, cohesive refresh. Most clients pair window cleaning with screens and a house wash — or join a membership for automatic, year-round care.</p>
          <ul class="checklist mt-2">
            <li>{icon('check-circle')} One trip, one team, one tidy result</li>
            <li>{icon('check-circle')} Bundle pricing on combined services</li>
            <li>{icon('check-circle')} Save on every visit with a recurring plan</li>
            <li>{icon('check-circle')} Priority scheduling for recurring clients</li>
          </ul>
          <a class="btn mt-3" href="get-quote.html">See Recurring Plans {icon('arrow')}</a>
        </div>
        <div class="reveal">{C.imgph("Beautiful clean home exterior", ratio="5/4")}</div>
      </div>
    </div>
  </section>
  {C.cta_band(depth)}
</main>"""
    html += C.page_end(depth)
    write("residential.html", html, slug="residential.html", priority="0.8")

# ===========================================================================
# GALLERY
# ===========================================================================
GALLERY_HERO = "assets/img/svc-exterior-window-cleaning.jpg"

def build_gallery():
    depth = 0
    # Full-bleed photo header in the homepage's style rather than the standard
    # interior text hero. Uses the widest real photo on the site (2048px, the
    # crew actually working) so the full-width banner is a genuine downscale
    # rather than an upscaled portrait phone shot.
    schema = list(BASE_SCHEMA)
    schema.append(S.breadcrumb([
        ("Home", BIZ["domain"] + "/"),
        ("Gallery", BIZ["domain"] + "/gallery.html"),
    ]))
    html = C.head(
        title=seo_title("Photo Gallery — Real Job Photos"),
        desc="Real photos from real jobs — window cleaning, gutter cleaning, pressure washing and more across Delano and the western Twin Cities. No stock photos.",
        slug="gallery.html", depth=depth, schema=schema)
    html += C.nav(depth)

    # Every real photo on the site, not just a curated handful — the more
    # of the actual work visitors can see, the better.
    work_photos = list(IMAGE_ALT.items())
    work_photos.append(("assets/img/service-van.jpg", "A fully branded Barta Window Washing service van"))
    for name, role, _initials, photo, _bio in TEAM:
        work_photos.append((photo, f"{name}, {role} of {BIZ['name']}"))
    root = C.rel(depth)
    def _work_figure(src, alt):
        img_html = C.picture(root, src, alt, extra_attrs='loading="lazy" decoding="async"', sizes="(max-width: 760px) 50vw, 33vw")
        return f'<figure class="reveal">{img_html}</figure>'
    figures = [_work_figure(src, alt) for src, alt in work_photos]

    # The before/after pairs stay in the collage rather than sitting in their
    # own section, but as draggable comparison sliders instead of two flat
    # photos side by side — one tile you scrub through, not a before you have
    # to mentally pair with an after. sizes matches the collage's real column
    # width (3 columns, 2 under 760px).
    ba_tiles = [
        f'<figure class="gallery-ba reveal">'
        f'{C.ba_slider(depth=depth, name=n, sizes="(max-width: 760px) 50vw, 33vw")}</figure>'
        for n in ("ba1", "ba2", "ba3")
        if os.path.exists(os.path.join(ROOT, f"assets/img/ba-{C.BA_REAL_PHOTOS[n]}-before.jpg"))
    ]
    # Spread them through the collage instead of clumping them together.
    step = max(1, len(figures) // (len(ba_tiles) + 1)) if ba_tiles else 0
    for i, tile in enumerate(ba_tiles):
        figures.insert(min(len(figures), step * (i + 1) + i), tile)

    work_html = "".join(figures)
    work_html += C.gallery_instagram_figures(depth)

    hero_picture = _hero_picture_html(root, GALLERY_HERO, img_class="hero-bg-img",
                                       alt=IMAGE_ALT.get(GALLERY_HERO, "Barta Window Washing technicians cleaning windows"))
    # One collage, before/after shots included inline with everything else —
    # they used to sit above in their own "Before & after" section of drag
    # sliders, which split the page into two separate galleries.
    html += f"""<main id="main">
  <section class="hero hero-photo-full hero-photo-band">
    {hero_picture}
    <div class="hero-overlay"></div>
    <div class="container">
      <div class="hero-content reveal in">
        {C.crumbs([("Home", root + "index.html"), ("Gallery", None)], light=True)}
        {C.google_badge(depth, text=f"{BIZ['review_count']}+ 5-star Google reviews")}
        <h1 class="mt-1">See the work for <em>yourself.</em></h1>
        <p class="lead">Real photos from real jobs around {BIZ['city']} and the western Twin Cities — no stock photos.</p>
      </div>
    </div>
  </section>
  <section><div class="container">
    <div class="gallery">{work_html}</div>
  </div></section>"""
    html += f"""
  {C.cta_band(depth)}
</main>"""
    html += C.page_end(depth)
    write("gallery.html", html, slug="gallery.html", priority="0.6")

# ===========================================================================
# ABOUT
# ===========================================================================
def build_about():
    """About page laid out as Our Story -> The Barta Experience -> The Team.
    Every claim here is one already confirmed by the owner and used elsewhere
    on the site (founding year, the brothers' split of duties, the recurring
    plan discounts, the re-clean guarantee, insured status). Nothing about
    the founding motivation or company history is invented — see
    docs/OWNER-VERIFICATION.md."""
    depth = 0
    team_cards = ""
    for i, (name, role, initials, photo, bio) in enumerate(TEAM):
        team_cards += f"""<div class="card reveal" data-delay="{i%3}" style="text-align:center">
        <img src="{photo}" alt="{name}, {role} of {BIZ['name']}" width="420" height="420" style="width:100%;max-width:420px;height:auto;aspect-ratio:1/1;object-fit:cover;object-position:center 22%;border-radius:24px;margin:0 auto 20px;display:block">
        <h3 style="font-size:1.25rem">{name}</h3>
        <p style="color:var(--blue-600);font-weight:700;font-family:var(--font-head);margin-top:4px">{role}</p>
        <p class="mt-1" style="font-size:.95rem">{bio}</p></div>"""

    experience = [
        ("Recurring plans that actually save money",
         f"Book on a repeating schedule and every visit is discounted — ${PROMO_PLANS[0][2]} off biannual, "
         f"${PROMO_PLANS[1][2]} off quarterly, ${PROMO_PLANS[2][2]} off monthly. Quarterly and monthly "
         "members get priority scheduling on top of it."),
        ("A guarantee without the fine print",
         "Every service is backed by our 100% Satisfaction Guarantee. If any part of a job isn't right, "
         "call us and we come back and re-clean it free. No forms, no argument."),
        ("Owner-run, and fully insured",
         "You're dealing with the two people whose name is on the van, not a call center — and every "
         "visit is covered by full insurance, on a crew trained to the standard Alex and Jacob set."),
    ]
    exp_html = "".join(
        f"<li>{icon('check-circle')}<span><strong>{t}.</strong> {d}</span></li>" for t, d in experience)

    html, body = interior_head(
        title=seo_title("About Us — Family-Owned in Delano, MN"),
        desc="Two brothers started Barta Window Washing in Delano, MN to raise the standard of home service — old-school customer care with a modern edge.",
        slug="about.html", eyebrow="About Us",
        h1="A Delano family business, built on trust",
        lead=f"Founded in {BIZ['founded']} by two brothers, Alex and Jacob Barta.",
        depth=depth, crumb_label="About", primary_kw="about Barta Window Washing Delano MN",
        h1_class="h1-tight", phero_class="phero-tight",
        hero_extra=f'<a href="#team" class="about-scroll-cue">Meet Alex &amp; Jacob {icon("chevron")}</a>')

    html += f"""<main id="main">{body}
  <section class="section-tight" style="padding-top:24px"><div class="container">
    <div class="section-head center"><h2>Our Story</h2></div>
    <div class="split mt-3">
      <div class="reveal">
        <p>Two brothers started this company with one goal: to raise the standard of the home
          service industry. Alex and Jacob Barta founded {BIZ['name']} in {BIZ['founded']} out of
          {BIZ['city']}, Minnesota, and they still run it themselves today.</p>
        <p class="mt-2">The idea was to bring back old-school customer service — you call, a real
          person picks up; you book a job, it gets done right — and give it a modern edge. Branded
          vans, trained crews, clear quotes, and none of the guesswork people have gotten used to
          from the trades.</p>
        <p class="mt-2">The split is simple. Alex leads the technicians in the field and holds the crew,
          himself included, to the standard the company was built on. Jacob runs the office — the quotes,
          the scheduling, the phone. Call {BIZ['name']} and you're talking to an owner.</p>
        <p class="mt-2">From {BIZ['city']} we serve homeowners and businesses across the western Twin Cities:
          window cleaning inside and out, gutters, pressure and soft washing, screens and tracks, and
          holiday lighting through the winter. Every visit is fully insured, and every job is backed by
          our satisfaction guarantee.</p>
      </div>
      <div class="reveal">{C.photo("assets/img/service-van.jpg", "A fully branded Barta Window Washing service van", ratio="5/4", depth=depth)}</div>
    </div>
  </div></section>

  <section class="bg-mist"><div class="container">
    <div class="section-head center">
      <span class="eyebrow" style="justify-content:center">Why homeowners stay with us</span>
      <h2>The Barta Experience</h2>
      <p>We'd rather earn a customer for years than a job for a day. In practice, that comes down to
        three things.</p>
    </div>
    <ul class="checklist mt-3" style="max-width:760px;margin-inline:auto">{exp_html}</ul>
    <p class="center mt-3" style="max-width:680px;margin-inline:auto">Ready for an exterior you don't have to
      think about? Call us at <a href="tel:{BIZ['phone_href']}">{BIZ['phone_display']}</a> or
      <a href="get-quote.html">request a free quote</a> — no obligation, and no pressure either way.</p>
  </div></section>

  <section class="section-tight" id="team"><div class="container">
    <div class="section-head center">
      <h2>Meet the Team</h2>
      <p>The brothers behind every job in {BIZ['city']} and the western metro.</p>
    </div>
    <div class="grid cols-2 mt-3">{team_cards}</div>
  </div></section>
  {C.cta_band(depth)}
</main>"""
    html += C.page_end(depth)
    write("about.html", html, slug="about.html", priority="0.7")

# ===========================================================================
# REVIEWS
# ===========================================================================
def build_reviews():
    depth = 0
    cards = "".join(C.review_card(*r, delay=i % 3) for i, r in enumerate(REVIEWS))
    schema = BASE_SCHEMA
    html = C.head(
        title=seo_title(f"Reviews — {BIZ['rating']}★ from {BIZ['review_count']}+ Customers"),
        desc=f"Read {BIZ['review_count']}+ five-star reviews for Barta Window Washing. See why Delano-area homeowners rate us 5.0★ for window cleaning, gutters, pressure washing & more.",
        slug="reviews.html", depth=depth, schema=schema, uses_reviews_widget=True)
    html += C.nav(depth)
    reviews_content = C.reviews_block(REVIEWS_WIDGET_PAGE, cards, depth)
    html += f"""<main id="main">
  <h1 class="sr-only">{BIZ['rating']}★ rated by {BIZ['review_count']}+ neighbors — {BIZ['name']} Reviews</h1>
  <section class="section-tight" style="padding-top:calc(var(--nav-h) + 40px)"><div class="container">{reviews_content}</div></section>
</main>"""
    html += C.page_end(depth)
    write("reviews.html", html, slug="reviews.html", priority="0.7")


# ===========================================================================
# FAQS
# ===========================================================================
def build_faqs():
    depth = 0
    schema = BASE_SCHEMA + [S.faq_schema(FAQS)]
    html, body = interior_head(
        title=seo_title("Frequently Asked Questions"),
        desc="Answers about pricing, scheduling, insurance, our satisfaction guarantee, eco-safe methods, and maintenance plans at Barta Window Washing in Delano, MN.",
        slug="faqs.html", eyebrow="FAQs", schema=schema,
        h1="Frequently asked questions",
        lead="Everything you need to know before booking. Don't see your question? Call us — we're happy to help.",
        depth=depth, crumb_label="FAQs", primary_kw="window cleaning FAQ Delano MN")
    html += f"""<main id="main">{body}
  <section><div class="container">{C.faq_block(FAQS)}</div></section>
  {C.cta_band(depth, heading="Still have questions?", text="Our friendly team is a quick call away — and ready to give you a free, no-obligation quote.")}
</main>"""
    html += C.page_end(depth)
    write("faqs.html", html, slug="faqs.html", priority="0.7")

# ===========================================================================
# SERVICE AREAS (hub)
# ===========================================================================
def build_service_areas():
    depth = 0

    def area_row(a):
        nbhds = ", ".join(a["neighborhoods"])
        # Extended-area cities have no page of their own, so they show the
        # neighbourhoods and route to the quote form instead of a dead link.
        if a["slug"] in PRIMARY_SLUGS:
            cta = f'<a href="areas/{a["slug"]}.html">View services in {a["city"]} {icon("arrow")}</a>'
        else:
            cta = f'<a href="get-quote.html">Get a free quote in {a["city"]} {icon("arrow")}</a>'
        return f"""<details class="reveal">
        <summary>{a['city']}, MN <span class="chev">{icon('chevron')}</span></summary>
        <div class="area-body"><p>{nbhds}</p>{cta}</div>
      </details>"""

    primary_html = "".join(area_row(a) for a in AREAS if a["tier"] == "primary")
    extended_html = "".join(area_row(a) for a in AREAS if a["tier"] == "extended")

    html, body = interior_head(
        title=seo_title("Service Areas — Western Twin Cities, MN"),
        desc="Barta Window Washing proudly serves Delano, Buffalo, Medina, Mound, Plymouth, St. Michael & more across the western Twin Cities metro. Find your city.",
        slug="service-areas.html", eyebrow="Service Areas",
        h1="Proudly serving the western Twin Cities",
        lead="Based in Delano and serving homeowners and businesses across the western Twin Cities metro. Find your community below.",
        depth=depth, crumb_label="Service Areas", primary_kw="window cleaning service areas Twin Cities MN")
    zip_html = "".join(f'<span class="pill" style="background:var(--mist-2);border:0">{z}</span>' for z in ZIP_CODES)
    html += f"""<main id="main">{body}
  <section><div class="container">
    <div class="areas-map-grid">
      {C.gmap_embed(f"Map of the {BIZ['name']} service area, centered on {BIZ['city']}, {BIZ['state']}", cls="reveal")}
      <div class="reveal">
        <div class="areas-group">
          <h2>Primary Service Area</h2>
          <div class="area-list">{primary_html}</div>
        </div>
        <div class="areas-group">
          <h2>Extended Service Area</h2>
          <div class="area-list">{extended_html}</div>
        </div>
      </div>
    </div>
    <p class="center mt-4" style="color:var(--slate-500)">Don't see your town? We likely serve it too — <a href="tel:{BIZ['phone_href']}" style="color:var(--blue-600);font-weight:600">just ask</a>.</p>
  </div></section>
  <section class="bg-mist"><div class="container">
    <div class="section-head center">
      <span class="eyebrow" style="justify-content:center">Coverage</span>
      <h2>ZIP codes we service</h2>
    </div>
    <div class="zip-scroll" style="max-width:820px;margin-inline:auto">{zip_html}</div>
  </div></section>
  {C.cta_band(depth)}
</main>"""
    html += C.page_end(depth)
    write("service-areas.html", html, slug="service-areas.html", priority="0.8")

# ===========================================================================
# AREA PAGES
# ===========================================================================
def _area_region_note(a):
    """One genuinely differentiating sentence per area, derived only from
    the real neighborhood data already in AREAS — not invented per-city
    copy. Groups cities into a couple of real, verifiable local patterns
    (lake shoreline vs. river town) instead of a single generic sentence
    with the city name swapped in."""
    nbhd_text = " ".join(a["neighborhoods"]).lower()
    if "lake minnetonka" in nbhd_text or "lake" in a["city"].lower():
        return ("Many homes here sit on or near the water, where lake spray, humidity, and heavier tree "
                "cover mean faster algae growth on siding and roofs, and more frequent window cleaning "
                "to keep the lake view clear.")
    if "crow river" in nbhd_text:
        return ("As a river-adjacent community, homes here see extra humidity and tree debris near the "
                "water, which is exactly the kind of algae and grime buildup soft washing is built for.")
    return ("Like most homes across the western metro, exteriors here deal with Minnesota's full range of "
            "seasons — spring pollen, summer dust, and winter road spray — which is why most homeowners "
            "pair window cleaning with a seasonal house wash or gutter cleaning.")

def build_area(a):
    depth = 1
    nbhds = ", ".join(a["neighborhoods"])
    svc_cards = "".join(
        f"""<a class="card svc-card reveal" data-delay="{i%4}" href="../services/{s['slug']}.html">
        <span class="ic">{icon(s['icon'])}</span><h3>{s['name']}</h3><p>{s['short']}</p>
        <span class="more">Learn more {icon('arrow')}</span></a>""" for i, s in enumerate(SERVICES[:6]))
    reviews_html = "".join(C.review_card(*r, delay=i % 3) for i, r in enumerate(REVIEWS[:3]))
    nearby = [o for o in AREAS if o["slug"] != a["slug"] and o["tier"] == a["tier"]][:6]
    nearby_html = "".join(f'<a class="pill" href="{o["slug"]}.html">{o["city"]}, MN</a>' for o in nearby)
    area_faqs = [
        (f"Do you serve all of {a['city']}, MN?",
         f"Yes — we serve the entire {a['city']} area, including {nbhds}. Whether you're in town or just outside it, we'd love to give you a free quote."),
        (f"How quickly can you get to my home in {a['city']}?",
         f"As a local company, we're often in the {a['city']} area each week and can usually schedule within a few days. Members always get priority. Call or request a quote to check current availability."),
        ("Are you insured to work in my city?",
         "Absolutely. Barta is fully insured to work throughout the western Twin Cities metro, including " + a["city"] + "."),
    ]
    schema = BASE_SCHEMA + [S.faq_schema(area_faqs), S.breadcrumb([
        ("Home", BIZ["domain"] + "/"), ("Service Areas", BIZ["domain"] + "/service-areas.html"),
        (a["city"], BIZ["domain"] + "/areas/" + a["slug"] + ".html")])]
    homebase = " — our home base" if a["note"] == "our home base" else ""
    html = C.head(
        title=seo_title(f"Exterior Cleaning in {a['city']}, MN"),
        # Neighborhood names are already visible on the page itself (hero +
        # FAQ) — repeating the full list here was pushing every one of the
        # 36 area-page descriptions past 175-200+ characters, well beyond
        # what Google renders before truncating in search results.
        desc=f"Window cleaning, gutter cleaning, pressure washing & house washing in {a['city']}, MN. Local & insured. Get your free quote from Barta.",
        slug=f"areas/{a['slug']}.html", depth=depth, schema=schema,
        primary_kw=f"exterior cleaning services {a['city']} MN")
    html += C.nav(depth)
    html += f"""<main id="main">
  <section class="phero"><div class="container">
    {C.crumbs([("Home", "../index.html"), ("Service Areas", "../service-areas.html"), (a['city'], None)])}
    <div class="hero-grid">
      <div>
        <span class="eyebrow">Serving {a['city']}, MN{homebase}</span>
        <h1 class="mt-1">Premium exterior cleaning in {a['city']}</h1>
        <p class="lead">Spotless windows, clear gutters, and a fresh-washed exterior for {a['city']} homes and businesses — from a local, family-owned team that treats your property like its own.</p>
        <div class="phero-actions">
          <a class="btn btn-lg" href="#quote-form">Get a Free {a['city']} Quote {icon('arrow')}</a>
          <a class="btn btn-lg btn-ghost" href="tel:{BIZ['phone_href']}">{icon('phone')} {BIZ['phone_display']}</a>
        </div>
      </div>
      <div>{C.lead_form(depth, heading=f"Free Quote in {a['city']}", compact=True)}</div>
    </div>
  </div></section>
  <section><div class="container"><div class="prose reveal" style="max-width:820px;margin-inline:auto;text-align:center">
    <span class="eyebrow" style="justify-content:center">Local experts</span>
    <h2 class="mt-1">Your trusted exterior cleaners in {a['city']}</h2>
    <p>Barta proudly serves homeowners and businesses throughout {a['city']} and the surrounding neighborhoods — including {nbhds}. {_area_region_note(a)}</p>
    <p>As a local, family-owned company, we're nearby, responsive, and personally invested in our reputation across {a['city']}. Every job is backed by full insurance and our 100% satisfaction guarantee.</p>
  </div></div></section>
  <section class="bg-mist"><div class="container">
    <div class="section-head center"><span class="eyebrow">In {a['city']}</span><h2>Services we offer locally</h2></div>
    <div class="grid cols-3">{svc_cards}</div>
    <div class="center mt-4"><a class="btn btn-ghost" href="../residential.html">View all services {icon('arrow')}</a></div>
  </div></section>
  <section><div class="container">
    <div class="section-head center"><span class="eyebrow">{a['city']} reviews</span><h2>What your neighbors say</h2></div>
    {C.reviews_block(None, reviews_html, depth)}
  </div></section>
  <section class="bg-mist"><div class="container">
    <div class="section-head center"><span class="eyebrow">Nearby</span><h2>Also serving communities near {a['city']}</h2></div>
    <div class="pills" style="justify-content:center">{nearby_html}</div>
    <div class="center mt-3"><a class="btn btn-ghost" href="../service-areas.html">See all service areas {icon('arrow')}</a></div>
  </div></section>
  <section><div class="container">
    <div class="section-head center"><span class="eyebrow">Questions</span><h2>{a['city']} service FAQs</h2></div>
    {C.faq_block(area_faqs)}
  </div></section>
  {C.cta_band(depth, heading=f"Ready for a spotless home in {a['city']}?", text=f"Get your free, no-obligation quote today and see why {a['city']} trusts Barta Window Washing.")}
</main>"""
    html += C.page_end(depth)
    write(f"areas/{a['slug']}.html", html, slug=f"areas/{a['slug']}.html", priority="0.7")

# ===========================================================================
# FINANCING
# ===========================================================================
def build_financing():
    depth = 0
    opts = [("money", "Pay over time", "Spread larger projects — like full-home washing or gutter cleaning — into easy monthly payments."),
            ("tag", "Membership budgeting", "Our maintenance plans turn big seasonal bills into a small, predictable monthly amount."),
            ("check-circle", "Simple application", "Quick, no-obligation approval decisions so you can move forward with confidence."),
            ("shield", "No surprises", "Clear terms, transparent pricing, and no hidden fees — ever.")]
    opt_html = "".join(f'<div class="feature reveal" data-delay="{i%2}"><span class="ic">{icon(ic)}</span><div><h3>{t}</h3><p>{d}</p></div></div>'
                       for i, (ic, t, d) in enumerate(opts))
    html, body = interior_head(
        title=seo_title("Financing &amp; Flexible Payment Options"),
        desc="Flexible payment options make exterior cleaning easy to budget. Spread larger projects into monthly payments or join a recurring maintenance plan.",
        slug="financing.html", eyebrow="Financing",
        h1="Premium care that fits your budget",
        lead="A clean, well-maintained home shouldn't have to wait. We offer flexible payment options and budget-friendly maintenance plans so you can get the service you want, on terms that work for you.",
        depth=depth, crumb_label="Financing", primary_kw="exterior cleaning financing Delano MN")
    html += f"""<main id="main">{body}
  <section><div class="container">
    <div class="section-head center"><span class="eyebrow">Your options</span><h2>Flexible ways to pay</h2></div>
    <div class="grid cols-2" style="max-width:820px;margin-inline:auto">{opt_html}</div>
    <p class="center mt-4" style="color:var(--slate-500);max-width:640px;margin-inline:auto">Financing availability and terms are confirmed at the time of quote. Ask your Barta estimator which option is the best fit for your project.</p>
  </div></section>
  {C.cta_band(depth, heading="Let's find the right plan for you", text="Request a free quote and we'll walk you through payment and membership options with zero pressure.")}
</main>"""
    html += C.page_end(depth)
    write("financing.html", html, slug="financing.html", priority="0.4")

def build_get_quote():
    """get-quote.html — a bare, distraction-free full-screen quote wizard.
    No site nav, no footer, no sidebar content — just one step at a time,
    each filling the screen, with a slim progress bar as the only chrome."""
    depth = 0
    root = C.rel(depth)
    schema = BASE_SCHEMA + [S.breadcrumb([
        ("Home", BIZ["domain"] + "/"),
        ("Get a Quote", BIZ["domain"] + "/get-quote.html"),
    ])]
    html = C.head(
        title=seo_title("Get Your Free Quote — Delano, MN"),
        desc="Tell us about your home and the services you need, and Barta Window Washing will get back to you with clear, upfront, no-obligation pricing.",
        slug="get-quote.html", depth=depth, schema=schema,
        primary_kw="free exterior cleaning quote Delano MN")
    html += f"""<main id="main" class="quote-flow">
  <div class="quote-flow-inner">{C.quote_wizard(depth)}</div>
</main>
<script src="{root}assets/js/main.min.js?v={C.ASSET_VER}" defer></script>
</body>
</html>"""
    write("get-quote.html", html, slug="get-quote.html", priority="0.9")

# ===========================================================================
# PRIVACY (minimal legal)
# ===========================================================================
def build_privacy():
    depth = 0
    html, body = interior_head(
        title=seo_title("Privacy Policy"),
        desc="Privacy policy for Barta Window Washing. Learn how we collect, use, and protect the information you share when requesting a quote or contacting us.",
        slug="privacy.html", eyebrow="Legal", h1="Privacy Policy",
        lead="Your trust matters to us. This policy explains what information we collect and how we use it.",
        depth=depth, crumb_label="Privacy", noindex=True)
    html += f"""<main id="main">{body}<section><div class="container"><div class="prose" style="margin-inline:auto">
    <p><em>Effective Date: August 2026</em></p>
    <h2>1. Introduction</h2>
    <p>{BIZ['legal_name']} ("{BIZ['short']}," "we," "us," or "our") is committed to protecting your privacy. This Privacy Policy explains how we collect, use, and safeguard your personal information when you contact us, request a quote, or use our services. By using our services, you agree to the terms of this Privacy Policy.</p>
    <h2>2. Information we collect</h2>
    <p>We collect only the information necessary to provide our services and communicate with you effectively. This may include:</p>
    <ul>
      <li>Full name</li>
      <li>Phone number, including consent to receive SMS/text messages</li>
      <li>Email address</li>
      <li>Service address or property location</li>
      <li>Service history and preferences</li>
    </ul>
    <p>We do not collect payment card numbers directly. Payments are processed through secure third-party payment processors.</p>
    <h2>3. How we collect information</h2>
    <p>We collect information you provide directly to us when you:</p>
    <ul>
      <li>Fill out a quote request or contact form on this website</li>
      <li>Call, text, or email us</li>
      <li>Schedule or confirm a service appointment</li>
      <li>Communicate with our team by phone or text</li>
    </ul>
    <h2>4. How we use your information</h2>
    <ul>
      <li>Schedule and perform services at your property</li>
      <li>Send appointment reminders, confirmations, and follow-ups by phone, email, or text</li>
      <li>Respond to your inquiries and provide customer support</li>
      <li>Send promotional offers or seasonal service reminders, only with your consent</li>
      <li>Improve our services and business operations</li>
    </ul>
    <p>We will never sell your personal information to third parties.</p>
    <h2>5. SMS / text messaging</h2>
    <p>By providing your phone number and opting in, you consent to receive text messages from {BIZ['name']} regarding appointment scheduling, service reminders, and updates. Message and data rates may apply, and message frequency varies. You may opt out at any time by replying STOP to any text message, or reply HELP for assistance. We do not share your phone number or SMS opt-in status with third parties for their own marketing purposes.</p>
    <h2>6. Sharing of information</h2>
    <p>We do not sell, trade, or rent your personal information. We may share your information only in the following limited circumstances:</p>
    <ul>
      <li>With service providers who support our operations, such as scheduling or payment tools, under confidentiality obligations</li>
      <li>When required by law, regulation, or valid legal process</li>
      <li>To protect the rights, safety, or property of {BIZ['short']}, our customers, or others</li>
    </ul>
    <h2>7. Data retention</h2>
    <p>We retain your personal information for as long as necessary to provide services to you and to meet our legal and business obligations. You may request deletion of your data at any time by contacting us (see Section 10).</p>
    <h2>8. Data security</h2>
    <p>We use reasonable administrative, technical, and physical safeguards to protect your personal information from unauthorized access, use, or disclosure. However, no method of transmission over the internet or electronic storage is completely secure.</p>
    <h2>9. Your rights</h2>
    <p>Regardless of where you live, we're glad to help you access, correct, or delete the personal information we hold about you, or opt out of promotional communications, any time you ask. Minnesota residents may also have specific rights under Minnesota law, including the Minnesota Consumer Data Privacy Act, where applicable. To exercise any of these rights, contact us using the information in Section 10.</p>
    <h2>10. Contact us</h2>
    <p>If you have questions about this Privacy Policy or wish to exercise your rights, please contact us:</p>
    <p>{BIZ['legal_name']}<br>Email: <a href="mailto:{BIZ['email']}">{BIZ['email']}</a><br>Phone: {BIZ['phone_display']}<br>Address: {BIZ['street']}, {BIZ['city']}, {BIZ['state']} {BIZ['zip']}</p>
    <h2>11. Updates to this policy</h2>
    <p>We may update this Privacy Policy from time to time. Any changes will be posted on this page with a revised effective date. Continued use of our services after changes are posted constitutes your acceptance of the updated policy.</p>
    <p><em>This document is provided for informational purposes and does not constitute legal advice. We recommend having it reviewed by a licensed Minnesota attorney to ensure full compliance with applicable state and federal law.</em></p>
  </div></div></section></main>"""
    html += C.page_end(depth)
    write("privacy.html", html, slug="privacy.html", priority="0.2")

# ===========================================================================
# TERMS & CONDITIONS
# ===========================================================================
def build_terms():
    depth = 0
    html, body = interior_head(
        title=seo_title("Terms &amp; Conditions"),
        desc="Terms and conditions for Barta Window Washing, including scheduling, payment, insurance, and our SMS/text messaging communication policy.",
        slug="terms.html", eyebrow="Legal", h1="Terms &amp; Conditions",
        lead="Please review these terms before requesting a quote or using our services.",
        depth=depth, crumb_label="Terms", noindex=True)
    html += f"""<main id="main">{body}<section><div class="container"><div class="prose" style="margin-inline:auto">
    <p><em>Effective Date: August 2026</em></p>
    <h2>1. Acceptance of terms</h2>
    <p>By requesting a quote, scheduling a service, or otherwise using this website or {BIZ['name']}'s services, you ("Customer") agree to be bound by these Terms and Conditions. If you do not agree, please do not use our services.</p>
    <h2>2. Services</h2>
    <p>{BIZ['name']} provides professional residential and commercial exterior cleaning services — including window cleaning, gutter cleaning, pressure washing, soft washing, solar panel cleaning, screen cleaning, window track detailing, and holiday light installation — throughout {BIZ['city']}, {BIZ['state']} and the surrounding western Twin Cities area. Quotes provided through this site are estimates based on the information you provide and are confirmed after an on-site or photo assessment. We reserve the right to decline or modify any service request at our discretion.</p>
    <h2>3. Scheduling and cancellations</h2>
    <p>Appointments can be scheduled by phone, text, email, or through this website. We ask that cancellations or rescheduling requests be made as far in advance as possible. Late cancellations or no-shows may result in a cancellation fee, which will be communicated to you at the time of booking.</p>
    <h2>4. Access to property</h2>
    <p>You agree to provide {BIZ['short']} reasonable access to the property on the scheduled service date, including unlocked gates and clear access to the areas being serviced. If access is not available at the time of arrival and no advance notice was given, the appointment may be treated as a late cancellation.</p>
    <h2>5. Payment</h2>
    <p>Payment is due upon completion of service unless other arrangements have been made in advance. We accept major debit and credit cards along with other payment methods communicated at the time of booking. Recurring membership plans are billed automatically according to the schedule selected at signup unless cancelled.</p>
    <h2>6. Satisfaction guarantee</h2>
    <p>Your satisfaction matters to us. Every service is backed by our 100% Satisfaction Guarantee — if you're not happy with the results, contact us and we'll return to make it right at no additional charge.</p>
    <h2>7. Limitation of liability</h2>
    <p>{BIZ['name']} takes reasonable precautions while performing services. However, we are not liable for:</p>
    <ul>
      <li>Pre-existing damage to windows, screens, frames, gutters, roofing, siding, or surrounding surfaces</li>
      <li>Damage caused by windows, frames, or fixtures that are improperly installed, aged, or structurally compromised</li>
      <li>Incidental or consequential damages arising from our services</li>
    </ul>
    <p>Our total liability for any claim arising out of or relating to our services will not exceed the amount paid for the specific service giving rise to the claim.</p>
    <h2>8. Insurance</h2>
    <p>{BIZ['name']} is fully insured for our operations. Proof of insurance is available upon request.</p>
    <h2>9. SMS communications</h2>
    <p>If you opt in to text messages, {BIZ['name']} may send appointment updates, service notifications, and marketing offers to the phone number you provide. Consent to receive text messages is not a condition of purchasing any service. Message and data rates may apply, and message frequency varies. Reply STOP at any time to unsubscribe, or HELP for help. See our <a href="{C.rel(depth)}privacy.html">Privacy Policy</a> for more on how we handle your information.</p>
    <h2>10. Governing law</h2>
    <p>These Terms and Conditions are governed by and construed in accordance with the laws of the State of Minnesota, without regard to its conflict of law provisions. Any disputes arising from these terms or our services are subject to the exclusive jurisdiction of the courts located in Minnesota.</p>
    <h2>11. Modifications</h2>
    <p>We may update these Terms and Conditions from time to time. Updated terms will be posted on this page. Continued use of our services after changes are posted constitutes your acceptance of the updated terms.</p>
    <h2>12. Contact us</h2>
    <p>If you have questions about these Terms and Conditions, please contact us:</p>
    <p>{BIZ['legal_name']}<br>Email: <a href="mailto:{BIZ['email']}">{BIZ['email']}</a><br>Phone: {BIZ['phone_display']}<br>Address: {BIZ['street']}, {BIZ['city']}, {BIZ['state']} {BIZ['zip']}</p>
    <p><em>This document is provided for informational purposes and does not constitute legal advice. We recommend having it reviewed by a licensed Minnesota attorney to ensure full compliance with applicable state and federal law.</em></p>
  </div></div></section></main>"""
    html += C.page_end(depth)
    write("terms.html", html, slug="terms.html", priority="0.2")

# ===========================================================================
# SITEMAP (human-readable page — separate from the machine sitemap.xml)
# ===========================================================================
def build_sitemap_page():
    depth = 0
    html, body = interior_head(
        title=seo_title("Sitemap"),
        desc=f"Every page on the {BIZ['name']} site in one place — all services, all 37 service-area communities, blog posts, and company information.",
        slug="sitemap.html", eyebrow="Site map", h1="Sitemap",
        lead="Every page on our site, in one place.",
        depth=depth, crumb_label="Sitemap")

    def _cards(items):
        # (icon-name, label, href) tuples, reusing the homepage's area-card
        # pill styling so this page shares the same visual language.
        return "".join(
            f'<a class="area-card" href="{root}{href}">{icon(ic)} {label}</a>' for ic, label, href in items)

    root = C.rel(depth)
    main_pages = [
        ("house", "Home", "index.html"),
        ("user", "About Us", "about.html"),
        ("image", "Gallery", "gallery.html"),
        ("window", "Residential Services", "residential.html"),
        ("building", "Commercial Cleaning", "services/commercial-cleaning.html"),
        ("pin", "Service Areas", "service-areas.html"),
        ("star", "Reviews", "reviews.html"),
        ("sparkle", "Blog", "blog.html"),
        ("clipboard", "FAQs", "faqs.html"),
        ("dollar", "Financing", "financing.html"),
        ("calendar", "Get a Quote", "get-quote.html"),
        ("shield", "Privacy Policy", "privacy.html"),
        ("clipboard", "Terms &amp; Conditions", "terms.html"),
    ]
    service_items = [(s["icon"], s["name"], f"services/{s['slug']}.html") for s in SERVICES]
    area_items = [("pin", a["city"], f"areas/{a['slug']}.html") for a in PRIMARY_AREAS]
    post_items = [("sparkle", p["title"], f"blog/{p['slug']}.html") for p in POSTS]

    def _section(title, items):
        return f"""<div class="section-head"><h2>{title}</h2></div>
      <div class="area-grid">{_cards(items)}</div>"""

    html += f"""<main id="main">{body}
  <section><div class="container">
    {_section("Main pages", main_pages)}
  </div></section>
  <section class="bg-mist"><div class="container">
    {_section("Services", service_items)}
  </div></section>
  <section><div class="container">
    {_section("Service areas", area_items)}
  </div></section>
  <section class="bg-mist"><div class="container">
    {_section("Blog posts", post_items)}
  </div></section>
  {C.cta_band(depth)}
  </main>"""
    html += C.page_end(depth)
    write("sitemap.html", html, slug="sitemap.html", priority="0.3")

# ===========================================================================
# 404 (custom error page)
# ===========================================================================
def build_404():
    """Static hosts (GitHub Pages included) serve this file's bytes for any
    unmatched URL without changing the address bar, so every relative path
    the shared nav/footer/CSS normally rely on (built assuming depth=0)
    would resolve against whatever nested path the visitor actually hit —
    see the base_href note on components.head(). A <base> tag fixes that
    for the whole page without duplicating the nav/footer markup here."""
    depth = 0
    # Root-relative (no scheme/host) rather than an absolute production URL,
    # so this still resolves correctly under local/preview testing and any
    # other root-domain deploy, not just the final production domain — the
    # only case it doesn't cover is a GitHub Pages *project* page served
    # from a /reponame/ subpath instead of a domain root. The trailing
    # "/404.html" (not just "/") matters too: <base> resolves a bare
    # "#main" fragment against the full base path, so this keeps the
    # skip-link on this same page instead of sending it to the homepage.
    base_href = "/404.html"
    schema = [S.local_business(), S.organization(), S.website()]
    html = C.head(
        title=seo_title("Page Not Found"),
        desc=f"The page you're looking for can't be found. Visit the {BIZ['name']} homepage, browse our services, or request a free quote.",
        slug="404.html", depth=depth, schema=schema, noindex=True,
        canonical=BIZ["domain"] + "/404.html", base_href=base_href)
    html += C.nav(depth)
    html += f"""
<main id="main">
  <section class="phero" style="min-height:56vh;display:flex;align-items:center">
    <div class="container center">
      <span class="eyebrow" style="justify-content:center">404</span>
      <h1 class="mt-1">We can't find that page</h1>
      <p class="lead" style="max-width:560px;margin-inline:auto">The page you're looking for may have been moved, renamed, or no longer exists. Here are a few places to go instead.</p>
      <div class="hero-actions" style="justify-content:center;flex-wrap:wrap">
        <a class="btn btn-lg" href="index.html">Back to Homepage {icon('arrow')}</a>
        <a class="btn btn-lg btn-ghost" href="residential.html">Browse Services</a>
        <a class="btn btn-lg btn-ghost" href="service-areas.html">Service Areas</a>
        <a class="btn btn-lg btn-ghost" href="get-quote.html">Get a Quote</a>
      </div>
      <p class="mt-3"><a href="tel:{BIZ['phone_href']}">{icon('phone')} {BIZ['phone_display']}</a></p>
    </div>
  </section>
</main>"""
    html += C.page_end(depth)
    write("404.html", html, slug="404.html", priority="0.1")

def build_instagram_callback():
    """One-time OAuth redirect target for connecting the Instagram feed
    (see build/instagram_sync.py). Instagram requires a real HTTPS URL to
    redirect back to after login; this page just lifts the ?code= param
    out of the address bar into a copyable box so the owner doesn't have
    to select it out of a URL by hand. Never linked from anywhere on the
    site and excluded from the sitemap/search index — it's a setup
    utility, not a page visitors should ever land on."""
    depth = 0
    schema = [S.local_business(), S.organization(), S.website()]
    html = C.head(
        title=seo_title("Instagram Connect"),
        desc="Instagram connection utility page.",
        slug="instagram-callback.html", depth=depth, schema=schema, noindex=True)
    html += C.nav(depth)
    html += f"""
<main id="main">
  <section class="phero" style="min-height:56vh;display:flex;align-items:center">
    <div class="container center" style="max-width:560px">
      <span class="eyebrow" style="justify-content:center">Setup</span>
      <h1 class="mt-1">Instagram connection code</h1>
      <p class="lead" id="ig-status">Waiting for a code in the URL…</p>
      <div class="field mt-2" style="max-width:480px;margin-inline:auto">
        <input type="text" id="ig-code" readonly style="text-align:center;font-family:monospace" placeholder="No code found">
      </div>
      <button type="button" class="btn mt-2" id="ig-copy">Copy code</button>
    </div>
  </section>
</main>
<script>
  (function() {{
    var params = new URLSearchParams(window.location.search);
    var code = params.get('code');
    var input = document.getElementById('ig-code');
    var status = document.getElementById('ig-status');
    var copyBtn = document.getElementById('ig-copy');
    if (code) {{
      input.value = code;
      status.textContent = 'Copy this code and send it back.';
    }} else {{
      status.textContent = params.get('error_description') || 'No code found in the URL — did the login step fail?';
      copyBtn.disabled = true;
    }}
    copyBtn.addEventListener('click', function() {{
      input.select();
      navigator.clipboard.writeText(input.value).then(function() {{
        copyBtn.textContent = 'Copied!';
      }});
    }});
  }})();
</script>"""
    html += C.page_end(depth)
    write("instagram-callback.html", html, slug="instagram-callback.html", priority="0.0")

# ===========================================================================
# BLOG HUB + POSTS
# ===========================================================================
# Real photo per post (matched to topic) instead of a generic placeholder —
# reused for both the blog.html card thumbnail and the post's own header.
_BLOG_PHOTOS = {
    "how-often-clean-windows-minnesota": "assets/img/svc-exterior-window-cleaning.jpg",
    "soft-washing-vs-pressure-washing": "assets/img/svc-soft-washing.jpg",
    "gutter-cleaning-checklist-fall": "assets/img/svc-gutter-cleaning.jpg",
    "hard-water-stains-windows": "assets/img/svc-hand-scrubbing.jpg",
    "winter-prep-checklist-minnesota": "assets/img/svc-christmas-light-installation.jpg",
    "spring-exterior-cleaning-checklist": "assets/img/svc-pressure-washing.jpg",
    "window-cleaning-mistakes-to-avoid": "assets/img/svc-mop-window.jpg",
}

def build_blog():
    depth = 0
    cards = ""
    for i, p in enumerate(POSTS):
        img = _BLOG_PHOTOS.get(p["slug"], "assets/img/hero-home.jpg")
        alt = IMAGE_ALT.get(img, p["title"])
        cards += f"""<a class="card reveal" data-delay="{i%3}" href="blog/{p['slug']}.html" style="display:flex;flex-direction:column">
        {C.photo(img, alt, ratio="16/9", depth=depth)}
        <span class="pill mt-2" style="align-self:flex-start;background:var(--mist-2);border:0;color:var(--blue-600)">{p['cat']}</span>
        <h2 class="mt-1" style="font-size:1.2rem">{p['title']}</h2>
        <p class="mt-1" style="font-size:.95rem">{p['excerpt']}</p>
        <span class="more">Read article {icon('arrow')}</span>
        <span style="font-size:.8rem;color:var(--slate-400);margin-top:6px">{p['date']} · {p['read']} read</span></a>"""
    html, body = interior_head(
        title=seo_title("Blog — Exterior Cleaning Tips &amp; Guides"),
        desc="Expert tips on window cleaning, gutter care, house washing, and seasonal home maintenance from Barta Window Washing in Delano, MN.",
        slug="blog.html", eyebrow="Blog",
        h1="Tips, guides &amp; exterior care advice",
        lead="Practical, no-nonsense advice from the Barta team to help you protect and beautify your home year-round.",
        depth=depth, crumb_label="Blog", primary_kw="window cleaning tips Minnesota")
    html += f"""<main id="main">{body}
  <section><div class="container"><div class="grid cols-3">{cards}</div></div></section>
  {C.cta_band(depth)}
</main>"""
    html += C.page_end(depth)
    write("blog.html", html, slug="blog.html", priority="0.6")

def build_post(p, idx):
    depth = 1
    others = [x for x in POSTS if x["slug"] != p["slug"]][:3]
    rel_html = "".join(f'<li><a href="{o["slug"]}.html" style="color:var(--blue-600);font-weight:600">{o["title"]}</a></li>' for o in others)
    post_img = _BLOG_PHOTOS.get(p["slug"], "assets/img/hero-home.jpg")
    post_alt = IMAGE_ALT.get(post_img, p["title"])
    body_paras = {
        "how-often-clean-windows-minnesota": [
            ("Why Minnesota windows get dirty faster", "Between spring tree pollen, summer dust and lawn debris, autumn's falling leaves, and winter's salt and ice, Minnesota glass takes a beating every season. Add hard water from sprinklers and a north side that grows algae, and most homes need more frequent cleaning than the national average."),
            ("Our recommended schedule", "For most homes, we recommend cleaning exterior windows twice per year — once in late spring after the pollen settles, and once in early fall before the leaves fly. Interior glass benefits from an annual cleaning, ideally paired with screen washing. Homes near lakes, gravel roads, or heavy trees may want a third visit."),
            ("Signs it's time", "Don't wait for the calendar if you notice spotting, a hazy film, visible pollen, or screens dulling your view. Catching buildup early keeps glass easier to clean and prevents hard-water etching that's far harder to remove later."),
            ("Make it automatic", "The easiest approach? A maintenance plan. We schedule your cleanings at the ideal times, send reminders, and handle everything — so your windows stay clear without you tracking a single date."),
        ],
        "soft-washing-vs-pressure-washing": [
            ("They're not the same thing", "Pressure washing uses high-pressure water to physically blast dirt off hard surfaces. Soft washing uses low pressure plus specialized cleaning solutions to dissolve grime and kill organic growth. Using the wrong one can cause real damage."),
            ("When to pressure wash", "Pressure washing shines on durable hardscapes: concrete driveways, paver patios, sidewalks, and pool decks. It removes embedded dirt, oil, and tire marks that solutions alone can't lift — when applied at the right pressure for the surface."),
            ("When to soft wash", "Siding, stucco, screens, and painted surfaces should always be soft washed. High pressure can strip paint, etch stucco, and damage delicate materials. Soft washing cleans gently and kills algae at the root, so results last far longer."),
            ("The bottom line", "A good exterior cleaner uses both — matched to each surface. That's exactly how Barta approaches every home: the right method, the right pressure, the right solution, every time."),
        ],
        "gutter-cleaning-checklist-fall": [
            ("Why fall is critical", "Clogged gutters in winter mean ice dams, overflow, and water pooling against your foundation. Clearing them before the first freeze is one of the cheapest, highest-impact things you can do to protect your home."),
            ("The checklist", "Clear all gutters of leaves and debris by hand. Flush downspouts and confirm water flows freely to the ground and away from the house. Check for sagging sections and loose hangers. Inspect seams for leaks. Look at the roof edge for damage or missing shingles."),
            ("Don't forget the extensions", "Make sure downspout extensions carry water at least four to six feet away from your foundation. Water pooling at the base of your home is a leading cause of basement leaks and foundation issues."),
            ("Let us handle it", "Fall gutter cleaning means ladders, heights, and a mess to haul away. Our crew clears everything by hand, flushes every downspout, bags the debris, and gives you a free inspection report — usually in a single visit."),
        ],
        "hard-water-stains-windows": [
            ("What's actually causing the haze", "Hard water stains come from minerals — mostly calcium and magnesium — left behind when water evaporates off glass. In Minnesota, the two biggest sources are sprinkler overspray hitting windows all summer and rain mixing with minerals in siding or hard water runoff. The water evaporates; the minerals stay, bonding to the glass surface."),
            ("Why regular cleaning doesn't fix it", "A squeegee and glass cleaner remove dirt and grime, but they can't dissolve mineral deposits that have already bonded to the surface. If your windows still look cloudy or spotted right after a normal cleaning, what you're seeing is mineral buildup, not dirt — it needs a different approach entirely."),
            ("What actually removes it", "Professional restoration uses mineral-dissolving compounds and technique matched to how heavy the buildup is. Light-to-moderate staining usually lifts in one treatment. Years of untreated buildup can etch the glass itself, which limits how much clarity comes back — an honest inspection before starting tells you which situation you're in."),
            ("Preventing it from coming back", "If sprinklers are the cause, the simplest fix is redirecting the head so it doesn't hit the glass. For homes where hard water exposure is unavoidable, a protective glass coating applied after restoration makes it harder for new deposits to bond, so spots wipe away more easily going forward."),
        ],
        "winter-prep-checklist-minnesota": [
            ("Gutters first", "Ice dams form when melting snow refreezes in clogged gutters and backs up under your shingles. Clearing gutters and confirming downspouts drain freely before the first hard freeze is the single most effective thing you can do to prevent winter roof leaks."),
            ("Check your roof while you still can", "Once snow sticks around, a real roof inspection isn't practical until spring. Look now for missing or lifted shingles, and note any black streaking — algae left untreated all winter has months to keep spreading before you can address it."),
            ("Wash the exterior before the salt season", "Road salt spray, sand, and winter grime are much easier to rinse off siding that's already clean than to remove once it's baked on by repeated freeze-thaw cycles. A fall house wash also removes summer's algae growth before it has all winter to set in."),
            ("Windows and screens", "Store or clean screens before winter rather than leaving them dusty in the frame — pollen and grime left all season are harder to remove in spring. If storm windows or interior glass show hard-water spotting from summer sprinklers, treating it now means a clearer view all winter."),
        ],
        "spring-exterior-cleaning-checklist": [
            ("Start with gutters and the roofline", "Winter is hard on gutters — ice, debris, and heavy snow can loosen hangers or leave leaves frozen in place since fall. Clear them first and confirm downspouts flow freely before you tackle anything else, since a clogged system undoes work done lower down the house."),
            ("Wash off the winter grime", "Salt spray, sand, and months of grime dull siding more than most homeowners realize until it's washed. A soft wash in spring also catches algae and mildew that started growing over winter before it spreads further with warmer, wetter weather."),
            ("Driveways and walkways", "Salt stains, tracked-in sand, and de-icer residue build up on concrete all winter. Pressure washing driveways, walkways, and steps in spring removes it before it has all summer to embed further, and it's the fastest visible curb-appeal improvement most homes can make."),
            ("Windows last", "Clean windows and screens after the rest of the exterior work is done — otherwise overspray and dust from washing siding or the driveway just lands back on freshly cleaned glass. This is also when hard-water spots from a full season of sprinklers tend to be most visible."),
        ],
        "window-cleaning-mistakes-to-avoid": [
            ("Cleaning in direct sunlight", "Glass cleaner dries almost instantly in direct sun, leaving streaks behind before you can wipe it off evenly. Professionals work in shade or on overcast days for exactly this reason — it has nothing to do with the product and everything to do with timing."),
            ("Paper towels and newspaper", "Both leave behind lint or ink residue and don't absorb water evenly, which is what causes streaking. A microfiber cloth or a proper squeegee pulls water off in one clean pass instead of smearing it around the glass."),
            ("Dish soap as glass cleaner", "Dish soap is formulated to cut grease, not to rinse cleanly off glass — it often leaves a filmy residue that actually attracts dust faster afterward. A dedicated glass cleaner or a vinegar-water solution rinses clean without that buildup."),
            ("Ignoring the frames, sills, and tracks", "Spotless glass next to a dirty track or grime-lined sill still looks unfinished, and dirt sitting in the track eventually works its way back onto the glass anyway. Wiping down the whole frame, not just the pane, is what makes a cleaning job actually look complete."),
        ],
    }
    paras = body_paras.get(p["slug"], [("Coming soon", "Full article content goes here.")])
    article = "".join(f"<h2>{h}</h2><p>{txt}</p>" for h, txt in paras)
    schema = BASE_SCHEMA + [{
        "@context": "https://schema.org", "@type": "BlogPosting",
        "headline": p["title"], "datePublished": p["date"], "dateModified": p["date"],
        "author": {"@type": "Organization", "name": BIZ["name"]},
        "publisher": {"@id": BIZ["domain"] + "/#org"},
        "description": p["excerpt"], "url": BIZ["domain"] + "/blog/" + p["slug"] + ".html",
        "articleSection": p["cat"],
    }, S.breadcrumb([
        ("Home", BIZ["domain"] + "/"),
        ("Blog", BIZ["domain"] + "/blog.html"),
        (p["title"], BIZ["domain"] + "/blog/" + p["slug"] + ".html"),
    ])]
    html = C.head(title=seo_title(p.get("seo_title") or p["title"]), desc=p["excerpt"],
                  slug=f"blog/{p['slug']}.html", depth=depth, schema=schema, og_type="article")
    html += C.nav(depth)
    html += f"""<main id="main">
  <section class="phero"><div class="container">
    {C.crumbs([("Home", "../index.html"), ("Blog", "../blog.html"), (p['title'], None)])}
    <div style="max-width:760px">
      <span class="eyebrow">{p['cat']} · {p['read']} read</span>
      <h1 class="mt-1">{p['title']}</h1>
      <p class="lead">{p['excerpt']}</p>
    </div>
  </div></section>
  <section><div class="container">
    <div class="reveal" style="max-width:900px;margin-inline:auto">{C.photo(post_img, post_alt, ratio="16/9", depth=depth)}</div>
  </div></section>
  <section><div class="container"><div class="split" style="grid-template-columns:1fr 320px;align-items:start">
    <article class="prose reveal">{article}
      <div class="card mt-4" style="background:var(--mist);border:0">
        <h3 style="font-size:1.25rem">Want it handled for you?</h3>
        <p class="mt-1">Skip the ladder and let Barta take care of it. Get a free, no-obligation quote today.</p>
        <a class="btn mt-2" href="../get-quote.html">Get my free quote {icon('arrow')}</a>
      </div>
    </article>
    <aside class="reveal">
      <div class="card"><h4>Related reading</h4><ul class="mt-2" style="display:grid;gap:12px">{rel_html}</ul></div>
      <div class="card mt-2" style="background:var(--grad-deep);color:#fff">
        <h4 style="color:#fff">Free quote</h4>
        <p style="color:rgba(255,255,255,.8);margin-top:8px">Free pricing, no obligation.</p>
        <a class="btn btn-light btn-block mt-2" href="../get-quote.html">Get started {icon('arrow')}</a>
      </div>
    </aside>
  </div></div></section>
</main>"""
    html += C.page_end(depth)
    write(f"blog/{p['slug']}.html", html, slug=f"blog/{p['slug']}.html", priority="0.5")

# ===========================================================================
# LANDING PAGES (conversion-focused)
# ===========================================================================
LANDING = [
    {"slug": "free-window-cleaning-quote", "svc": "exterior-window-cleaning", "h1": "Free Window Cleaning Quote in Delano, MN",
     "headline": "Streak-free windows, zero hassle — get your free quote today",
     "kw": "free window cleaning quote Delano MN",
     "guarantee": "Streak-Free Guarantee: if it streaks, we re-clean it free."},
    {"slug": "free-pressure-washing-quote", "svc": "pressure-washing", "h1": "Free Pressure Washing Quote in Delano, MN",
     "headline": "Restore your driveway, patio &amp; walkways — get your free quote",
     "kw": "free pressure washing quote Delano MN",
     "guarantee": "Surface-Safe Guarantee: the right pressure for every material, every time."},
    {"slug": "free-gutter-cleaning-estimate", "svc": "gutter-cleaning", "h1": "Free Gutter Cleaning Estimate in Delano, MN",
     "headline": "Protect your home from clogged gutters — get your free estimate",
     "kw": "free gutter cleaning estimate Delano MN",
     "guarantee": "Flow Guarantee: every downspout flushed and tested, debris hauled away."},
    {"slug": "house-washing-estimate", "svc": "house-washing", "h1": "House Washing Estimate in Delano, MN",
     "headline": "Make your whole home look new again — free house washing estimate",
     "kw": "house washing estimate Delano MN",
     "guarantee": "Soft-Wash Safe Guarantee: gentle on siding, tough on algae and grime."},
    {"slug": "commercial-quote", "svc": "commercial-cleaning", "h1": "Free Commercial Cleaning Quote — Western Twin Cities",
     "headline": "Reliable commercial exterior cleaning — request your free quote",
     "kw": "commercial cleaning quote Twin Cities MN",
     "guarantee": "Dependability Guarantee: scheduled, insured, and always on time."},
    {"slug": "holiday-lighting-estimate", "svc": "christmas-light-installation", "h1": "Holiday Lighting Estimate in Delano, MN",
     "headline": "Skip the cold ladder — get a free custom holiday lighting estimate",
     "kw": "Christmas light installation estimate Delano MN",
     "guarantee": "Worry-Free Guarantee: we design, install, maintain, and take it all down."},
]

def build_landing(L):
    depth = 1
    svc = next((s for s in SERVICES if s["slug"] == L["svc"]), None) if L["svc"] else None
    benefits = (svc["benefits"] if svc else [
        ("One reliable vendor", "Every building, every service, one point of contact."),
        ("Fully insured", "Comprehensive coverage on every commercial job."),
        ("Flexible scheduling", "We work around your hours and your tenants."),
        ("Spotless impressions", "Clean glass and entries that win customers."),
    ])
    ben_html = "".join(f'<div class="feature reveal" data-delay="{i%2}"><span class="ic">{icon("check")}</span><div><h3>{t}</h3><p>{d}</p></div></div>'
                       for i, (t, d) in enumerate(benefits))
    reviews_html = "".join(C.review_card(*r, delay=i % 3) for i, r in enumerate(REVIEWS[:3]))
    lp_faqs = [
        ("How does the quote process work?", "Tell us about your home and the services you need, and we'll put together clear, upfront pricing. Many quotes can be priced without an on-site visit."),
        ("Is the quote really free?", "Yes — 100% free and no obligation. We'll give you clear, upfront, all-in pricing with no pressure and no hidden fees."),
        ("Are you insured?", "Absolutely. Barta is fully insured."),
        ("What if I'm not satisfied?", "Every service is backed by our 100% Satisfaction Guarantee. If anything isn't right, we make it right — free."),
    ]
    schema = BASE_SCHEMA + [S.faq_schema(lp_faqs)]
    trust = "".join(f'<li>{icon("check-circle")} {t}</li>' for t in [
        f"{BIZ['rating']}★ from {BIZ['review_count']}+ reviews", "Fully insured",
        "Free, no-obligation quotes", "100% satisfaction guarantee", "Family-owned &amp; local"])
    html = C.head(title=seo_title(L.get("seo_title") or L["h1"]),
                  desc=f"{L['headline'].replace('&amp;','&')}. Insured & guaranteed. Serving Delano & the western Twin Cities. Get your free, no-obligation quote from Barta now!",
                  slug=f"landing/{L['slug']}.html", depth=depth, schema=schema, primary_kw=L["kw"], noindex=True)
    html += C.nav(depth)
    html += f"""<main id="main">
  <section class="phero"><div class="container"><div class="hero-grid">
    <div>
      <div class="hero-rating" style="background:#fff;border:1px solid var(--line);color:var(--slate-700)">{stars_row()}<span>{BIZ['rating']}/5 · {BIZ['review_count']}+ reviews</span></div>
      <h1 class="mt-1">{L['headline']}</h1>
      <p class="lead">Trusted, family-owned exterior cleaning across the western Twin Cities. Get clear, upfront pricing with no pressure and no obligation.</p>
      <ul class="hero-trust">
        <li>{icon('shield')} Fully insured</li>
        <li>{icon('check-circle')} {L['guarantee'].split(':')[0]}</li>
        <li>{icon('clock')} Free, easy quotes</li>
      </ul>
    </div>
    <div>{C.lead_form(depth, heading="Get My Free Quote", sub="Free pricing. No obligation.", svc_default=L['svc'])}</div>
  </div></div></section>

  <section class="section-tight bg-mist"><div class="container">{C.trust_badges()}</div></section>

  <section><div class="container"><div class="split">
    <div class="reveal"><span class="eyebrow">Why Barta</span><h2 class="mt-1">Benefits you'll notice</h2>
      <div class="mt-3" style="display:grid;gap:22px">{ben_html}</div>
    </div>
    <div class="reveal">{C.ba_slider(depth=depth, name="ba1", sizes="(max-width: 960px) 100vw, 50vw")}</div>
  </div></div></section>

  <section class="bg-deep"><div class="container">
    <div class="cta-band" style="background:transparent;padding:0">
      <span class="eyebrow" style="color:#ff9b86;justify-content:center">Our promise to you</span>
      <h2 class="mt-1">{L['guarantee']}</h2>
      <p>Backed by our 100% satisfaction guarantee. If you're not thrilled, we make it right — free.</p>
    </div>
  </div></section>

  <section><div class="container">
    <div class="section-head center"><span class="eyebrow">Real reviews</span><h2>Loved by your neighbors</h2></div>
    {C.reviews_block(None, reviews_html, depth)}
  </div></section>

  <section class="bg-mist"><div class="container"><div class="hero-grid">
    <div class="reveal"><span class="eyebrow">No risk</span><h2 class="mt-1">Why request your quote now</h2>
      <ul class="checklist mt-2" style="font-size:1.05rem">{trust}</ul>
      <a class="btn mt-3" href="tel:{BIZ['phone_href']}">{icon('phone')} Or call {BIZ['phone_display']}</a>
    </div>
    <div class="reveal">{C.faq_block(lp_faqs)}</div>
  </div></div></section>

  {C.cta_band(depth, heading="Claim your free quote today", text="There's zero obligation. Let's make your property shine.")}
</main>"""
    html += C.page_end(depth)
    write(f"landing/{L['slug']}.html", html, slug=f"landing/{L['slug']}.html", priority="0.8")

# ===========================================================================
# STATIC ASSETS: images, sitemap, robots, manifest, favicon
# ===========================================================================
def gradient_svg(stops, w=800, h=500):
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" width="%d" height="%d">' % (w, h, w, h)) + stops + '</svg>'

def build_images():
    # Before/after placeholder pairs — "before" muted/grimy, "after" bright/clean.
    pairs = {
        "ba1": ("#6b6f63", "#8a8f80", "Window — before", "Window — after"),
        "ba2": ("#7a7264", "#938b7c", "Siding — before", "Siding — after"),
        "ba3": ("#5f6660", "#7d847d", "Roof — before", "Roof — after"),
    }
    for name, (b1, b2, blabel, alabel) in pairs.items():
        if name in C.BA_REAL_PHOTOS:
            continue  # real photo on disk — don't overwrite with a placeholder
        before = gradient_svg(
            f'<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="{b1}"/><stop offset="1" stop-color="{b2}"/></linearGradient>'
            f'<filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="linear" slope="0.28"/></feComponentTransfer></filter></defs>'
            f'<rect width="800" height="500" fill="url(#g)"/><rect width="800" height="500" filter="url(#n)" opacity="0.5"/>'
            f'<g opacity="0.3" stroke="#3a3a30" stroke-width="3"><path d="M0 120 H800 M0 250 H800 M0 380 H800 M260 0 V500 M530 0 V500"/></g>'
            f'<text x="40" y="460" font-family="sans-serif" font-size="26" fill="#ffffff" opacity="0.85">{blabel}</text>')
        # "after" = clean, bright glass with a subtle coral sky accent
        after = gradient_svg(
            f'<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#eef0f3"/><stop offset="1" stop-color="#ffffff"/></linearGradient>'
            f'<radialGradient id="s" cx="0.8" cy="0.18" r="0.5"><stop offset="0" stop-color="#ffd9d0"/><stop offset="1" stop-color="#ffd9d0" stop-opacity="0"/></radialGradient></defs>'
            f'<rect width="800" height="500" fill="url(#g)"/><rect width="800" height="500" fill="url(#s)"/>'
            f'<g opacity="0.22" stroke="#9aa0a8" stroke-width="2"><path d="M0 120 H800 M0 250 H800 M0 380 H800 M260 0 V500 M530 0 V500"/></g>'
            f'<g opacity="0.5" fill="#ffffff"><circle cx="640" cy="110" r="60"/><circle cx="690" cy="80" r="26"/></g>'
            f'<text x="40" y="460" font-family="sans-serif" font-size="26" fill="#16161b">{alabel}</text>')
        write_asset(f"assets/img/{name}-before.svg", before)
        write_asset(f"assets/img/{name}-after.svg", after)

    # Favicon — black rounded square with the coral // mark
    favicon = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
               '<rect width="64" height="64" rx="15" fill="#111116"/>'
               '<g fill="#fb4d3d"><path d="M27 14 H38 L27 50 H16 Z"/><path d="M46 14 H57 L46 50 H35 Z"/></g></svg>')
    write_asset("assets/img/favicon.svg", favicon)

    # Standalone logo lockup (coral // + BARTA wordmark) for email sigs, etc.
    logo = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 520 150" width="520" height="150">'
            '<g fill="#fb4d3d"><path d="M40 25 H72 L36 125 H4 Z"/><path d="M96 25 H128 L92 125 H60 Z"/></g>'
            '<text x="150" y="103" font-family="Plus Jakarta Sans, Arial, sans-serif" font-size="92" font-weight="800" letter-spacing="2" fill="#16161b">BARTA</text>'
            '<text x="152" y="132" font-family="Plus Jakarta Sans, Arial, sans-serif" font-size="20" font-weight="700" letter-spacing="9" fill="#67676f">WINDOW WASHING</text></svg>')
    write_asset("assets/img/logo.svg", logo)

    # Header logo lockup matching the official Barta mark (coral // + bold BARTA).
    # Black wordmark for light backgrounds (nav/drawer); white for dark (footer).
    def _logo(text_fill):
        return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 548 120" width="548" height="120">'
                '<g fill="#fb4d3d"><path d="M44 16 H84 L46 104 H6 Z"/><path d="M104 16 H144 L106 104 H66 Z"/></g>'
                f'<text x="166" y="93" font-family="\'Arial Black\',\'Helvetica Neue\',Arial,sans-serif" '
                f'font-size="92" font-weight="900" letter-spacing="0" fill="{text_fill}">BARTA</text></svg>')
    write_asset("assets/img/logo-barta.svg", _logo("#16161b"))
    write_asset("assets/img/logo-barta-white.svg", _logo("#ffffff"))

    # OG cover — black with coral // mark + wordmark
    og = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630">'
          '<rect width="1200" height="630" fill="#111116"/>'
          '<circle cx="1010" cy="110" r="240" fill="#fb4d3d" opacity="0.20"/><circle cx="120" cy="560" r="210" fill="#ff6a3d" opacity="0.16"/>'
          '<g fill="#fb4d3d"><path d="M84 118 H120 L82 232 H46 Z"/><path d="M146 118 H182 L144 232 H108 Z"/></g>'
          '<text x="210" y="210" font-family="Arial, sans-serif" font-size="34" font-weight="700" letter-spacing="6" fill="#ff9b86">BARTA WINDOW WASHING</text>'
          '<text x="80" y="380" font-family="Arial, sans-serif" font-size="80" font-weight="800" fill="#ffffff">The clearest view</text>'
          '<text x="80" y="470" font-family="Arial, sans-serif" font-size="80" font-weight="800" fill="#ffffff">in Delano starts here.</text>'
          '<text x="80" y="548" font-family="Arial, sans-serif" font-size="31" fill="#c9c9cf">Premium exterior cleaning · 5.0★ · Fully insured</text></svg>')
    write_asset("assets/img/og-cover.svg", og)

def write_asset(relpath, content):
    path = os.path.join(ROOT, relpath)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)

def build_meta_files():
    # robots.txt
    write_asset("robots.txt", f"User-agent: *\nAllow: /\n\nSitemap: {BIZ['domain']}/sitemap.xml\n")
    # manifest
    write_asset("site.webmanifest",
        '{"name":"Barta Window Washing","short_name":"Barta","start_url":"/","display":"standalone",'
        '"background_color":"#ffffff","theme_color":"#16161b","icons":[{"src":"/assets/img/favicon.svg","sizes":"any","type":"image/svg+xml"}]}')
    # sitemap — <lastmod> is only included where we actually know a real
    # modification date (blog posts carry one in sitedata.POSTS); every other
    # page type has no tracked per-page date, so we omit lastmod rather than
    # stamp every URL with today's date, which isn't true and isn't useful.
    post_dates = {f"blog/{p['slug']}.html": p["date"] for p in POSTS}
    urls = ""
    for relpath, slug, priority in PAGES:
        loc = BIZ["domain"] + "/" + (slug if slug else "")
        lastmod_tag = f"<lastmod>{post_dates[slug]}</lastmod>" if slug in post_dates else ""
        urls += f"  <url><loc>{loc}</loc>{lastmod_tag}<priority>{priority}</priority></url>\n"
    sitemap = ('<?xml version="1.0" encoding="UTF-8"?>\n'
               '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + urls + '</urlset>\n')
    write_asset("sitemap.xml", sitemap)

# ===========================================================================
# MAIN
# ===========================================================================
def _asset_version():
    """Short hash of the CSS+JS so their URLs change whenever they do."""
    import hashlib
    h = hashlib.md5()
    for rel in ("assets/css/styles.css", "assets/js/main.js"):
        try:
            with open(os.path.join(ROOT, rel), "rb") as f:
                h.update(f.read())
        except FileNotFoundError:
            pass
    return h.hexdigest()[:8]

def minify_assets():
    """Produce minified styles.min.css / main.min.js for production (via
    clean-css-cli / terser, fetched on demand with npx). Falls back to a
    plain copy of the source file if Node/npx isn't available, so the build
    never fails just because minifiers couldn't run."""
    import subprocess, shutil
    css_src = os.path.join(ROOT, "assets/css/styles.css")
    css_out = os.path.join(ROOT, "assets/css/styles.min.css")
    js_src = os.path.join(ROOT, "assets/js/main.js")
    js_out = os.path.join(ROOT, "assets/js/main.min.js")
    try:
        subprocess.run(["npx", "--yes", "clean-css-cli", "-o", css_out, css_src],
                        check=True, capture_output=True, timeout=90)
    except Exception as e:
        print(f"  (css minify skipped: {e}; using unminified copy)")
        shutil.copyfile(css_src, css_out)
    try:
        subprocess.run(["npx", "--yes", "terser", js_src, "-c", "-m", "-o", js_out],
                        check=True, capture_output=True, timeout=90)
    except Exception as e:
        print(f"  (js minify skipped: {e}; using unminified copy)")
        shutil.copyfile(js_src, js_out)

def generate_webp_versions():
    """Generate a .webp sibling for every real photo (assets/img/*.jpg), used
    by components.picture() as the modern-format <picture> source. Skips any
    jpg whose webp is already newer (fast no-op on repeat builds)."""
    import glob
    try:
        from PIL import Image
    except ImportError:
        print("  (Pillow not available — skipping WebP generation)")
        return
    import re
    _is_derived = lambda p: re.search(r"-(640|1200|1920)w\.jpg$", p)
    insta_jpgs = [p for p in glob.glob(os.path.join(ROOT, "assets/img/instagram/*.jpg")) if not _is_derived(p)]
    # Must exclude the same -640w/-1200w/-1920w derivatives here too — those
    # are generate_hero_variants()'s output, re-encoded from the true
    # original at a deliberately chosen quality. Without this filter, this
    # glob picks them up as if they were source photos and overwrites their
    # already-correct .webp sibling by re-compressing the *already-resized*
    # jpg at this function's flat quality=80 — compounding two lossy passes
    # into one, and permanently masking the mistake because the resulting
    # fresh mtime then makes generate_hero_variants() skip it as "up to date".
    jpgs = [p for p in glob.glob(os.path.join(ROOT, "assets/img/*.jpg")) if not _is_derived(p)] + insta_jpgs
    for jpg in jpgs:
        webp = jpg.rsplit(".", 1)[0] + ".webp"
        if os.path.exists(webp) and os.path.getmtime(webp) >= os.path.getmtime(jpg):
            continue
        try:
            Image.open(jpg).convert("RGB").save(webp, "WEBP", quality=80, method=6)
        except Exception as e:
            print(f"  (webp skipped for {os.path.basename(jpg)}: {e})")

# (max_width, format, quality) — never upscales: target_width = min(max_width,
# source_width), so a variant wider than its source is just the source
# re-encoded at that quality, not stretched. Every current hero/service photo
# is a ~1100-1126px-wide portrait phone photo, meaning the 1200w tier already
# sits at native resolution — there's no higher-resolution tier to add for
# these, so the previous q40/q50 settings were pure compression artifacts,
# visible as fuzziness on the large full-bleed hero display. Raised quality
# substantially (owner explicitly prioritized sharpness over the extra file
# size) while still compressing meaningfully vs. the untouched original.
_HERO_VARIANT_SPECS = [(1200, "webp", 72), (1200, "jpg", 78), (640, "webp", 72), (640, "jpg", 78)]

# Extra large-desktop/high-DPI tier for the homepage van hero specifically —
# its source is exactly 1920px wide (no higher-res original exists), so this
# never upscales; it's a straight re-encode at a higher quality than the
# 1200w tier so the full-bleed hero stays sharp on large/retina screens
# instead of the browser stretching the 1200w file to fill the viewport.
_HERO_1920_SPECS = [(1920, "webp", 75), (1920, "jpg", 82)]
# Both of these render full-bleed edge to edge, and both have sources wider
# than 1920 (or exactly 1920), so this tier is always a real downscale — it
# never upscales. GALLERY_HERO is the Gallery page's photo header.
_HERO_1920_PATHS = {"assets/img/hero-home.jpg", GALLERY_HERO}

# Every individual service page's hero photo gets this higher-quality tier —
# it's the single largest, most-scrutinized image on that page (the proof
# the crew actually does the work), and each page only loads its own one
# hero, so the extra weight never compounds the way it would on a page
# showing many photos at once (gallery, Instagram feed). Those stay on the
# lighter default tier above on purpose. Originally added just for the
# Christmas Lights night shot, whose deep shadows and small bright bulbs
# are exactly the content JPEG/WebP compress worst — kept as the top tier
# and extended to every service hero at the owner's request.
_HERO_HIGH_Q_SPECS = [(1200, "webp", 88), (1200, "jpg", 92), (640, "webp", 84), (640, "jpg", 88)]
_HERO_HIGH_Q_PATHS = {s["image"] for s in SERVICES if s.get("image")}

def generate_hero_variants():
    """Responsive, capped-size derivatives of every hero, process-slider, and
    before/after photo (assets/img/<stem>-{640,1200}w.{webp,jpg}), used via
    srcset so a phone downloads the small file and a desktop downloads the
    mid-size one — never the full multi-hundred-KB original. Source JPGs are
    never modified or replaced; these are new sibling files, skipped once
    already up to date."""
    try:
        from PIL import Image
    except ImportError:
        print("  (Pillow not available — skipping responsive image variant generation)")
        return
    hero_paths = {"assets/img/hero-home.jpg", "assets/img/svc-mop-window.jpg", "assets/img/svc-detail-frame.jpg",
                  "assets/img/svc-cta-squeegee.jpg"}
    for s in SERVICES:
        hero_paths.add(s.get("image") or "assets/img/hero-home.jpg")
    for name in ("window", "siding", "gutter"):
        hero_paths.add(f"assets/img/ba-{name}-before.jpg")
        hero_paths.add(f"assets/img/ba-{name}-after.jpg")
    # Instagram-synced photos land as full-size originals (often 1-2MB each,
    # unresized) — the Gallery page shows every one of them at once, so
    # without responsive variants that's dozens of megabytes on one page.
    # Excludes already-generated "-640w"/"-1200w" siblings from the glob —
    # otherwise a second build run treats last run's output as new source
    # images and resizes them again into "-640w-640w.jpg"-style junk.
    import glob as _glob, re as _re
    for p in _glob.glob(os.path.join(ROOT, "assets/img/instagram/*.jpg")):
        if _re.search(r"-(640|1200|1920)w\.jpg$", p):
            continue
        hero_paths.add(os.path.relpath(p, ROOT).replace(os.sep, "/"))
    for rel in sorted(hero_paths):
        src = os.path.join(ROOT, rel)
        if not os.path.exists(src):
            continue
        stem = rel.rsplit(".", 1)[0]
        src_mtime = os.path.getmtime(src)
        base = None
        base_specs = _HERO_HIGH_Q_SPECS if rel in _HERO_HIGH_Q_PATHS else _HERO_VARIANT_SPECS
        specs = base_specs + (_HERO_1920_SPECS if rel in _HERO_1920_PATHS else [])
        for max_w, fmt, quality in specs:
            out_rel = f"{stem}-{max_w}w.{fmt}"
            out_path = os.path.join(ROOT, out_rel)
            if os.path.exists(out_path) and os.path.getmtime(out_path) >= src_mtime:
                continue
            try:
                if base is None:
                    base = Image.open(src).convert("RGB")
                w, h = base.size
                target_w = min(max_w, w)
                img = base.resize((target_w, round(h * target_w / w)), Image.LANCZOS) if target_w < w else base
                save_fmt = "WEBP" if fmt == "webp" else "JPEG"
                kwargs = {"quality": quality, "optimize": True}
                if fmt == "webp":
                    kwargs["method"] = 6
                img.save(out_path, save_fmt, **kwargs)
            except Exception as e:
                print(f"  (hero variant skipped for {out_rel}: {e})")

def main():
    generate_webp_versions()
    generate_hero_variants()
    minify_assets()
    C.ASSET_VER = _asset_version()
    build_home()
    for s in SERVICES:
        build_service(s)
    build_residential()
    build_gallery()
    build_about()
    build_reviews()
    build_faqs()
    build_service_areas()
    for a in PRIMARY_AREAS:
        build_area(a)
    build_financing()
    build_get_quote()
    build_privacy()
    build_terms()
    build_404()
    build_instagram_callback()
    build_blog()
    for i, p in enumerate(POSTS):
        build_post(p, i)
    for L in LANDING:
        build_landing(L)
    build_sitemap_page()
    build_images()
    build_meta_files()
    print(f"✓ Generated {len(PAGES)} pages + assets.")
    for relpath, slug, pr in PAGES:
        print(f"   {relpath}")

if __name__ == "__main__":
    main()
