"""Reusable HTML partials and section builders."""
import json, os
from urllib.parse import quote_plus
from sitedata import BIZ, SERVICES, BADGES, DROPDOWN_SERVICES, HOME_SERVICES, PROMO_PLANS, PROMO_FEATS, IMAGE_ALT
from icons import icon

# Cache-busting version for static assets (set at build time from file hashes).
# Keeps CSS/JS from being served stale by the browser/CDN after a change.
ASSET_VER = "1"

# Navigation grouping for mega-menu
NAV_SERVICES = SERVICES  # all 10 services appear in the Services mega menu

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def rel(depth):
    """Return path prefix to site root given folder depth (0 = root)."""
    return "../" * depth

def _webp(src):
    """Swap a .jpg/.jpeg path for its .webp sibling (generated at build time
    by build.generate_webp_versions() for every real photo)."""
    return src.rsplit(".", 1)[0] + ".webp" if src.lower().endswith((".jpg", ".jpeg")) else src

def _variants_exist(stem):
    """True if 640w/1200w WebP+JPG derivatives exist for this image stem
    (see build.generate_hero_variants — the single place that creates them)."""
    return all(os.path.exists(os.path.join(_ROOT, f"{stem}-{w}w.{fmt}"))
               for w in (640, 1200) for fmt in ("webp", "jpg"))

_SIZE_CACHE = {}
def _real_size(relpath, default=(1125, 1500)):
    """Real pixel dimensions of an assets/img file. Tries Pillow first, then
    a dependency-free JPEG header read, so width/height attributes always
    match the actual file instead of a guessed placeholder value — the
    same fallback strategy build.py's _img_size uses, duplicated here in a
    few lines rather than importing build.py (which itself imports this
    module, so importing the other way would be circular)."""
    if relpath in _SIZE_CACHE:
        return _SIZE_CACHE[relpath]
    full = os.path.join(_ROOT, relpath)
    size = default
    try:
        from PIL import Image
        with Image.open(full) as im:
            size = im.size
    except Exception:
        try:
            with open(full, "rb") as f:
                data = f.read()
            if data[:2] == b"\xff\xd8":
                i = 2
                sof = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}
                while i < len(data) - 9:
                    if data[i] != 0xFF:
                        i += 1
                        continue
                    marker = data[i + 1]
                    if marker in sof:
                        h = (data[i + 5] << 8) + data[i + 6]
                        w = (data[i + 7] << 8) + data[i + 8]
                        size = (w, h)
                        break
                    seg_len = (data[i + 2] << 8) + data[i + 3]
                    i += 2 + seg_len
        except Exception:
            pass
    _SIZE_CACHE[relpath] = size
    return size

def picture(root, src, alt, img_class="", extra_attrs="", sizes=None):
    """<picture> with a WebP source (smaller, modern) + the original JPG as
    the universally-supported <img> fallback.

    If 640w/1200w responsive variants exist on disk (see
    build.generate_hero_variants), emits a full srcset/sizes picture so the
    browser downloads an appropriately-sized file instead of the full
    original — `sizes` should reflect the image's real rendered width
    (e.g. "33vw" for a three-column card), defaulting to "100vw" for
    full-bleed uses. Falls back to a single full-resolution WebP+JPG pair
    when no variants exist.

    Automatically fills width/height from the real file when the caller
    hasn't already supplied them (checked via extra_attrs) and the source
    file exists on disk, so dimensions always match the actual image
    instead of a guessed value. Pass any extra img attributes (loading,
    decoding, onerror...) as a raw string."""
    webp = _webp(src)
    has_dims = "width=" in extra_attrs
    full_src = os.path.join(_ROOT, src)
    dim_attrs = ""
    if not has_dims and os.path.exists(full_src):
        w, h = _real_size(src)
        dim_attrs = f' width="{w}" height="{h}"'
    if webp == src:
        return f'<img class="{img_class}" src="{root}{src}"{dim_attrs} alt="{alt}" {extra_attrs}>'
    stem = src.rsplit(".", 1)[0]
    if _variants_exist(stem):
        sizes_val = sizes or "100vw"
        if not has_dims:
            w, h = _real_size(f"{stem}-1200w.jpg")
            dim_attrs = f' width="{w}" height="{h}"'
        return (f'<picture>'
                f'<source type="image/webp" srcset="{root}{stem}-640w.webp 640w, {root}{stem}-1200w.webp 1200w" sizes="{sizes_val}">'
                f'<img class="{img_class}" src="{root}{stem}-1200w.jpg" '
                f'srcset="{root}{stem}-640w.jpg 640w, {root}{stem}-1200w.jpg 1200w" sizes="{sizes_val}" '
                f'alt="{alt}"{dim_attrs} {extra_attrs}></picture>')
    return (f'<picture><source srcset="{root}{webp}" type="image/webp">'
            f'<img class="{img_class}" src="{root}{src}"{dim_attrs} alt="{alt}" {extra_attrs}></picture>')

def head(title, desc, slug, depth=0, schema=None, og_type="website", primary_kw="", canonical=None, noindex=False, uses_reviews_widget=False, base_href=None):
    """<head> block with full SEO + social + JSON-LD.
    noindex=True renders "noindex, follow" (for utility/legal/PPC-landing
    pages that shouldn't compete in search) instead of the default index.
    uses_reviews_widget=True adds the Trustindex preconnect — only pages
    that actually render the widget (home, service pages, reviews.html)
    should pay for that connection.
    primary_kw is accepted for callers that still pass it, but is no longer
    rendered — Google doesn't use <meta name="keywords">, and publishing one
    telegraphs targeted phrases for no ranking benefit.
    base_href, when given, renders a <base> tag so every relative URL on
    the page (nav/footer links, CSS, JS, images — all built assuming
    depth=0) resolves against the site root instead of whatever nested
    path the browser is actually showing. Only 404.html needs this: a
    static host serves 404.html's bytes without changing the visible URL,
    so a 404 hit under e.g. /services/typo.html would otherwise resolve
    "index.html" to /services/index.html instead of the real homepage."""
    root = rel(depth)
    canonical = canonical or (BIZ["domain"] + "/" + slug)
    schema_blocks = ""
    if schema:
        for s in schema:
            schema_blocks += '<script type="application/ld+json">' + json.dumps(s, separators=(",", ":")) + "</script>\n"
    robots = "noindex, follow" if noindex else "index, follow, max-image-preview:large"
    trustindex_preconnect = ('<link rel="preconnect" href="https://cdn.trustindex.io">\n'
                              '<link rel="dns-prefetch" href="https://cdn.trustindex.io">\n') if uses_reviews_widget else ""
    base_tag = f'<base href="{base_href}">\n' if base_href else ""
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
{base_tag}<script>document.documentElement.className+=" js";</script>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<meta name="description" content="{desc}">
<link rel="canonical" href="{canonical}">
<meta name="theme-color" content="#16161b">
<meta name="robots" content="{robots}">
<!-- Open Graph / social -->
<meta property="og:type" content="{og_type}">
<meta property="og:site_name" content="{BIZ['name']}">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{desc}">
<meta property="og:url" content="{canonical}">
<meta property="og:image" content="{BIZ['domain']}/assets/img/og-cover.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{title}">
<meta name="twitter:description" content="{desc}">
<meta name="twitter:image" content="{BIZ['domain']}/assets/img/og-cover.png">
<!-- Fonts — Cabinet Grotesk (display) + General Sans (body) via Fontshare -->
<link rel="preconnect" href="https://api.fontshare.com" crossorigin>
<link rel="preconnect" href="https://cdn.fontshare.com" crossorigin>
{trustindex_preconnect}<link rel="preload" as="style" href="https://api.fontshare.com/v2/css?f[]=cabinet-grotesk@700,800,900&f[]=general-sans@400,500,600,700&display=swap">
<link rel="stylesheet" href="https://api.fontshare.com/v2/css?f[]=cabinet-grotesk@700,800,900&f[]=general-sans@400,500,600,700&display=swap">
<link rel="stylesheet" href="{root}assets/css/styles.min.css?v={ASSET_VER}">
<link rel="icon" href="{root}assets/img/favicon.svg" type="image/svg+xml">
<link rel="manifest" href="{root}site.webmanifest">
{schema_blocks}</head>
<body>
<a class="skip" href="#main">Skip to content</a>
"""

def _menu_item(s, root):
    return (f'<a href="{root}services/{s["slug"]}.html">'
            f'<span class="mi-icon">{icon(s["icon"])}</span>'
            f'<span><span class="mi-title">{s["name"]}</span>'
            f'<span class="mi-desc">{s["short"][:54]}…</span></span></a>')

def nav(depth=0):
    root = rel(depth)
    return f"""<header class="nav-wrap">
  <nav class="nav" aria-label="Primary">
    <a class="brand" href="{root}index.html" aria-label="{BIZ['name']} home">
      <img class="brand-logo" src="{root}assets/img/logo-bww.png" alt="{BIZ['name']}" width="148" height="40">
    </a>
    <ul class="nav-links">
      <li><a class="nav-phone" href="tel:{BIZ['phone_href']}">{icon('phone')} Call Us</a></li>
      <li><a href="{root}about.html">About Us</a></li>
      <li class="nav-item">
        <button class="nav-trigger" aria-haspopup="true" aria-expanded="false">Our Services {icon('chevron')}</button>
        <div class="nav-menu nav-menu-simple" role="menu">
          {"".join(f'<a href="{root}{target}">{label}</a>' for label, target in DROPDOWN_SERVICES)}
        </div>
      </li>
      <li><a href="{root}services/commercial-cleaning.html">Commercial Cleaning</a></li>
      <li><a href="{root}reviews.html">Reviews</a></li>
    </ul>
    <div class="nav-cta">
      <a class="btn" href="{root}get-quote.html">Get a Quote</a>
      <button class="nav-toggle" aria-label="Open menu" aria-expanded="false">{icon('menu')}</button>
    </div>
  </nav>
</header>

<div class="drawer" role="dialog" aria-modal="true" aria-label="Menu">
  <div class="drawer-scrim"></div>
  <div class="drawer-panel">
    <div class="drawer-head">
      <a class="brand" href="{root}index.html"><img class="brand-logo" src="{root}assets/img/logo-bww.png" alt="{BIZ['name']}" width="150" height="32"></a>
      <button class="drawer-close" aria-label="Close menu">{icon('x')}</button>
    </div>
    <nav class="drawer-nav" aria-label="Mobile">
      <a href="{root}index.html">Home</a>
      <details class="drawer-group"><summary>Our Services {icon('chevron')}</summary>
        <div class="sub">{"".join(f'<a href="{root}{target}">{label}</a>' for label, target in DROPDOWN_SERVICES)}</div>
      </details>
      <a href="{root}services/commercial-cleaning.html">Commercial Cleaning</a>
      <a href="{root}residential.html">Residential</a>
      <a href="{root}service-areas.html">Service Areas</a>
      <a href="{root}reviews.html">Reviews</a>
      <a href="{root}why-choose-us.html">Why Choose Us</a>
      <a href="{root}about.html">About</a>
      <a href="{root}blog.html">Blog</a>
      <a href="{root}faqs.html">FAQs</a>
      <a href="{root}financing.html">Financing</a>
    </nav>
    <div class="drawer-foot">
      <a class="btn btn-block" href="{root}get-quote.html">Get My Free Quote</a>
      <a class="btn btn-ghost btn-block" href="tel:{BIZ['phone_href']}">{icon('phone')} {BIZ['phone_display']}</a>
    </div>
  </div>
</div>
"""

def sticky_cta(depth=0):
    root = rel(depth)
    return f"""<div class="sticky-cta">
  <a class="btn btn-call" href="tel:{BIZ['phone_href']}">{icon('phone')} Call</a>
  <a class="btn" href="{root}get-quote.html">Free Quote</a>
</div>"""

def footer(depth=0):
    root = rel(depth)
    svc_links = "".join(f'<li><a href="{root}services/{s["slug"]}.html">{s["name"]}</a></li>' for s in SERVICES[:8])
    return f"""<footer class="footer">
  <div class="container">
    <div class="footer-top">
      <div class="footer-about">
        <a class="brand" href="{root}index.html"><img class="brand-logo" src="{root}assets/img/logo-bww-white.png" alt="{BIZ['name']}" width="160" height="44"></a>
        <p>{BIZ['tagline']}. Family-owned, fully insured exterior cleaning for homes and businesses across the western Twin Cities metro.</p>
        <ul class="footer-contact">
          <li>{icon('pin')}<span>{BIZ['street']}, {BIZ['city']}, {BIZ['state']} {BIZ['zip']}</span></li>
          <li>{icon('phone')}<a href="tel:{BIZ['phone_href']}">{BIZ['phone_display']}</a></li>
          <li>{icon('mail')}<a href="mailto:{BIZ['email']}">{BIZ['email']}</a></li>
          <li>{icon('clock')}<span>{BIZ['hours']}</span></li>
        </ul>
        <div class="footer-social">
          <a href="{BIZ['facebook']}" aria-label="Facebook">{icon('facebook')}</a>
          <a href="{BIZ['instagram']}" aria-label="Instagram">{icon('instagram')}</a>
          <a href="{BIZ['tiktok']}" aria-label="TikTok">{icon('tiktok')}</a>
          <a href="{BIZ['google']}" aria-label="Google Business Profile">{icon('pin')}</a>
        </div>
      </div>
      <div class="footer-col">
        <h5>Services</h5>
        <ul>{svc_links}</ul>
      </div>
      <div class="footer-col">
        <h5>Company</h5>
        <ul>
          <li><a href="{root}about.html">About Us</a></li>
          <li><a href="{root}why-choose-us.html">Why Choose Us</a></li>
          <li><a href="{root}reviews.html">Reviews</a></li>
          <li><a href="{root}get-quote.html">Get a Quote</a></li>
        </ul>
      </div>
    </div>
    <div class="footer-bottom">
      <span>© <span id="year">2026</span> {BIZ['name']}. All rights reserved. Fully insured in Minnesota.</span>
      <div class="links">
        <a href="{root}get-quote.html">Free Quote</a>
        <a href="{root}faqs.html">FAQs</a>
        <a href="{root}service-areas.html">Service Areas</a>
        <a href="{root}privacy.html">Privacy</a>
        <a href="{root}terms.html">Terms</a>
      </div>
    </div>
  </div>
</footer>"""

def page_end(depth=0):
    return f"""{sticky_cta(depth)}
{footer(depth)}
<script src="{rel(depth)}assets/js/main.min.js?v={ASSET_VER}" defer></script>
</body>
</html>"""

# ---------------------------------------------------------------------------
# Reusable section builders
# ---------------------------------------------------------------------------
# Recurring-plan promo cards (Biannual left, Quarterly center/popular,
# Monthly right). Each card sends the visitor to the quote form with the
# chosen plan pre-attached via ?plan=. PROMO_PLANS/PROMO_FEATS live in
# sitedata.py (the actual source of truth for plans) — see the owner-
# verification note there before changing these numbers.
def promo_plan_cards(depth=0, svc=None):
    root = rel(depth)
    cards = ""
    for i, (name, slug, amt, included, popular) in enumerate(PROMO_PLANS):
        cls = "yes" if included else "no"
        mark = icon("check-circle") if included else icon("x")
        feats = "".join(f'<li class="{cls}">{mark} {f}</li>' for f in PROMO_FEATS)
        pop_cls = " popular" if popular else ""
        badge = '<span class="promo-badge">Most Popular</span>' if popular else ""
        href = f"{root}get-quote.html?plan={slug}" + (f"&svc={svc}" if svc else "")
        cards += f"""<div class="promo-card{pop_cls} reveal" data-delay="{i}">{badge}
        <h3 class="promo-name">{name}</h3>
        <div class="promo-price">${amt} <small>OFF</small></div>
        <div class="promo-per">Per Cleaning</div>
        <ul class="promo-feats">{feats}</ul>
        <a class="btn btn-block" href="{href}">Choose {name}</a>
      </div>"""
    return cards

def service_sidebar(current_target, depth=0):
    """Sticky side nav listing the homepage's residential services, for
    quick jumps between service pages from the detail section. Commercial
    Cleaning has its own top-level nav tab, so it's excluded here."""
    root = rel(depth)
    items = ""
    for item in HOME_SERVICES:
        if item["label"] == "Commercial Cleaning":
            continue
        active = item["target"] == current_target
        marker = '<span class="side-dot"></span>' if active else ""
        arrow = "" if active else icon("arrow")
        items += (f'<a class="side-nav-link{" active" if active else ""}" href="{root}{item["target"]}">'
                  f'{marker}<span>{item["label"]}</span>{arrow}</a>')
    return f'<nav class="service-sidebar" aria-label="Other services">{items}</nav>'

# Maps service-page slugs to their closest homepage-service checkbox slug,
# so svc_default works whether callers pass either kind of identifier.
SERVICE_SLUG_TO_LABEL = {
    "gutter-cleaning": "gutter-cleaning",
    "pressure-washing": "pressure-washing",
    "house-washing": "soft-washing",
    "soft-washing": "soft-washing",
    "roof-cleaning": "soft-washing",
    "solar-panel-cleaning": "solar-panel-cleaning",
    "screen-cleaning": "screen-cleaning-services",
    "hard-water-stain-removal": "exterior-window-cleaning",
    "christmas-light-installation": "christmas-light-installation",
}

def lead_form(depth=0, heading="Request Your Free Quote", sub="Free, no-obligation, and zero pressure.",
              submit="Get My Free Quote", svc_default=None, compact=False):
    """Full lead-capture form. Services are multi-select checkboxes matching
    the 10 homepage service boxes. svc_default: label-slug (or list of them)
    to pre-check; a ?svc= query param on the page URL overrides via JS."""
    if svc_default is None:
        defaults = []
    elif isinstance(svc_default, str):
        defaults = [svc_default]
    else:
        defaults = list(svc_default)
    # accept service-page slugs too (window-cleaning → exterior-window-cleaning …)
    defaults = [SERVICE_SLUG_TO_LABEL.get(d, d) for d in defaults]
    svc_boxes = "".join(
        f'<label class="check svc-check"><input type="checkbox" name="services" value="{item["label"]}" '
        f'data-svc="{_slugify(item["label"])}"> {item["label"]}</label>'
        for item in HOME_SERVICES)
    extra_fields = "" if compact else f"""
    <div class="form-row">
      <div class="field"><label for="lf-date">Preferred date</label><input type="date" id="lf-date" name="preferred_date"></div>
      <div class="field"><label for="lf-time">Preferred time</label>
        <select id="lf-time" name="preferred_time">
          <option value="" selected disabled>Choose a window…</option>
          <option>Morning (7am–11am)</option><option>Midday (11am–2pm)</option>
          <option>Afternoon (2pm–5pm)</option><option>Evening (5pm–7pm)</option><option>Flexible</option>
        </select></div>
    </div>
    <div class="field"><label for="lf-hear">How did you hear about us?</label>
      <select id="lf-hear" name="referral_source">
        <option value="" selected disabled>Select one…</option>
        <option>Google Search</option><option>Google Maps / Reviews</option><option>Facebook / Instagram</option>
        <option>Referral from friend/neighbor</option><option>Saw our crew / vehicle</option><option>Returning customer</option><option>Other</option>
      </select></div>
    <div class="field"><label for="lf-notes">Notes (optional)</label><textarea id="lf-notes" name="notes" placeholder="Tell us about your home, number of windows, or anything special…"></textarea></div>"""
    return f"""<div class="hero-card" id="quote-form">
  <h3>{heading}</h3>
  <p class="form-note">{sub}</p>
  <form class="form mt-2" data-lead novalidate>
    <input type="hidden" name="plan" data-plan-field value="">
    <div class="form-row">
      <div class="field"><label for="lf-name">Full name</label><input type="text" id="lf-name" name="name" autocomplete="name" required placeholder="Jane Doe"></div>
      <div class="field"><label for="lf-phone">Phone</label><input type="tel" id="lf-phone" name="phone" autocomplete="tel" required inputmode="tel" data-validate-phone placeholder="(763) 314-3400"></div>
    </div>
    <div class="form-row">
      <div class="field"><label for="lf-email">Email</label><input type="email" id="lf-email" name="email" autocomplete="email" required placeholder="you@email.com"></div>
      <div class="field addr-field"><label for="lf-address">Service address</label>
        <input type="text" id="lf-address" name="address" autocomplete="off" required data-address-input placeholder="Start typing your address…">
        <input type="hidden" name="address_verified" data-address-verified value="no">
        <ul class="addr-suggestions" data-address-list hidden></ul>
      </div>
    </div>
    <fieldset class="field svc-fieldset"><legend>Services requested <span class="form-note" style="font-weight:400">(select all that apply)</span></legend>
      <div class="svc-checks" data-service-checks data-default-svc="{','.join(defaults)}">{svc_boxes}</div>
    </fieldset>{extra_fields}
    <label class="check"><input type="checkbox" name="reminders" checked> Send me seasonal cleaning reminders so I never have to remember.</label>
    <label class="check"><input type="checkbox" name="plan_info"> I'm interested in info about recurring maintenance plans.</label>
    <button type="submit" class="btn btn-lg btn-block">{submit} {icon('arrow')}</button>
    <p class="form-note center">By submitting, you agree to be contacted about your request. We never sell your info.</p>
  </form>
  <div class="form-success">
    {icon('check-circle')}
    <h3>Thank you! Your request is in.</h3>
    <p>One of the owners will reach out with your free, no-obligation quote.</p>
    <a class="btn mt-2" href="tel:{BIZ['phone_href']}">{icon('phone')} Or call us now: {BIZ['phone_display']}</a>
  </div>
</div>"""

# Services offered in the quote wizard's picker — every homepage service
# except Christmas Light Installation and Commercial Cleaning, which are
# booked/quoted through their own dedicated flows.
WIZARD_SERVICES = [s for s in HOME_SERVICES if s["label"] not in ("Christmas Light Installation", "Commercial Cleaning")]

def quote_wizard(depth=0, svc_default=None):
    """4-step quote form: info -> services -> plan frequency -> address.
    Each step reads as its own full page (no preview of what's next) with
    a plain progress bar spanning the top of the screen. A ?svc= or ?plan=
    query param (from a service page or plan card) is picked up by JS to
    pre-select the matching step-2/step-3 option."""
    root = rel(depth)
    if svc_default is None:
        defaults = []
    elif isinstance(svc_default, str):
        defaults = [svc_default]
    else:
        defaults = list(svc_default)
    defaults = [SERVICE_SLUG_TO_LABEL.get(d, d) for d in defaults]

    svc_boxes = "".join(
        f'<label class="check svc-check"><input type="checkbox" name="services" value="{item["label"]}" '
        f'data-svc="{_slugify(item["label"])}"> {item["label"]}</label>'
        for item in WIZARD_SERVICES)

    # Same promo cards shown on the homepage's "Save with our plans" grid,
    # just made selectable (radio) instead of links, since we're already
    # on the quote form.
    plan_cards = ""
    for name, slug, amt, included, popular in PROMO_PLANS:
        cls = "yes" if included else "no"
        mark = icon("check-circle") if included else icon("x")
        feats = "".join(f'<li class="{cls}">{mark} {f}</li>' for f in PROMO_FEATS)
        pop_cls = " popular" if popular else ""
        badge = '<span class="promo-badge">Most Popular</span>' if popular else ""
        checked = " checked" if slug == "quarterly" else ""
        plan_cards += f"""<label class="promo-card select-card{pop_cls}">
      <input type="radio" name="plan_choice" value="{slug}" required{checked}>{badge}
      <span class="promo-name">{name}</span>
      <span class="promo-price">${amt} <small>OFF</small></span>
      <span class="promo-per">Per Cleaning</span>
      <ul class="promo-feats">{feats}</ul>
    </label>"""

    return f"""<div class="wizard" id="quote-form">
  <h1 class="sr-only">Get Your Free Quote</h1>
  <div class="wizard-progress-bar" aria-hidden="true"><div class="wizard-progress-fill" data-wizard-fill></div></div>
  <form class="form wizard-form" data-lead novalidate>
    <div class="wizard-panel" data-panel="0">
      <h2 class="wizard-hero-title">Let's get to know you!</h2>
      <div class="form-row mt-3">
        <div class="field field-icon">
          <label for="q-first" class="sr-only">First name</label>{icon('user')}
          <input type="text" id="q-first" name="first_name" autocomplete="given-name" required placeholder="First name">
        </div>
        <div class="field field-icon">
          <label for="q-last" class="sr-only">Last name</label>{icon('user')}
          <input type="text" id="q-last" name="last_name" autocomplete="family-name" required placeholder="Last name">
        </div>
      </div>
      <div class="field field-icon">
        <label for="q-email" class="sr-only">Email</label>{icon('mail')}
        <input type="email" id="q-email" name="email" autocomplete="email" required placeholder="Email">
      </div>
      <div class="field field-icon">
        <label for="q-phone" class="sr-only">Phone</label>{icon('phone')}
        <input type="tel" id="q-phone" name="phone" autocomplete="tel" required inputmode="tel" data-validate-phone placeholder="Phone">
      </div>
      <div class="field field-icon">
        <label for="q-promo" class="sr-only">Promo code (optional)</label>{icon('tag')}
        <input type="text" id="q-promo" name="promo_code" autocomplete="off" placeholder="Promo code (optional)">
      </div>
      <label class="check mt-2"><input type="checkbox" name="reminders" required> I agree to receive text messages from {BIZ['name']}, including appointment updates, service notifications, and marketing offers.</label>
      <p class="form-note wizard-disclaimer">By checking this box, you consent to receive recurring SMS messages from {BIZ['name']} at the number provided. Consent is not a condition of purchase. Msg &amp; data rates may apply. Msg frequency varies. Reply STOP to unsubscribe, HELP for help. See our <a href="{root}privacy.html">Privacy Policy</a> and <a href="{root}terms.html">Terms &amp; Conditions</a>.</p>
      <div class="wizard-actions">
        <span></span>
        <button type="button" class="btn btn-lg" data-wizard-next>Next {icon('arrow')}</button>
      </div>
    </div>

    <div class="wizard-panel" data-panel="1" hidden>
      <h2>Which services do you need?</h2>
      <p class="form-note">Select all that apply.</p>
      <div class="svc-checks mt-3" data-service-checks data-default-svc="{','.join(defaults)}">{svc_boxes}</div>
      <div class="wizard-actions">
        <button type="button" class="btn btn-ghost" data-wizard-back>Back</button>
        <button type="button" class="btn btn-lg" data-wizard-next>Next {icon('arrow')}</button>
      </div>
    </div>

    <div class="wizard-panel wizard-panel-wide" data-panel="2" hidden>
      <h2 class="center">Select Your Frequency</h2>
      <p class="form-note center">The more often we come, the more you save.</p>
      <div class="promo-grid mt-3">{plan_cards}</div>
      <div class="wizard-actions">
        <button type="button" class="btn btn-ghost" data-wizard-back>Back</button>
        <button type="button" class="btn btn-lg" data-wizard-next>Next {icon('arrow')}</button>
      </div>
    </div>

    <div class="wizard-panel" data-panel="3" hidden>
      <h2>You're Almost There!</h2>
      <p class="form-note">Start typing and choose your address from the list so we can confirm it.</p>
      <div class="field addr-field mt-3"><label for="q-street">Street address</label>
        <input type="text" id="q-street" name="address_street" autocomplete="off" required data-address-input placeholder="Start typing your address…">
        <input type="hidden" name="address_verified" data-address-verified value="no">
        <ul class="addr-suggestions" data-address-list hidden></ul>
      </div>
      <div class="form-row">
        <div class="field"><label for="q-city">City</label><input type="text" id="q-city" name="address_city" required data-address-city placeholder="Delano"></div>
        <div class="field"><label for="q-zip">ZIP code</label><input type="text" id="q-zip" name="address_zip" required inputmode="numeric" pattern="[0-9]{{5}}" data-address-zip placeholder="55328"></div>
      </div>
      <p class="form-note wizard-address-warning" data-address-status hidden>Please choose your address from the suggestions so we can confirm it's a real, serviceable address.</p>
      <div class="wizard-actions">
        <button type="button" class="btn btn-ghost" data-wizard-back>Back</button>
        <button type="submit" class="btn btn-lg btn-block">Get My Free Quote {icon('arrow')}</button>
      </div>
      <p class="form-note center mt-1">By submitting, you agree to be contacted about your request. We never sell your info.</p>
    </div>
  </form>
  <div class="form-success">
    {icon('check-circle')}
    <h2>Thank you! Your request is in.</h2>
    <p>Someone will reach out shortly.</p>
    <a class="btn mt-2 call-us-btn" href="tel:{BIZ['phone_href']}">Call Us</a>
    <p class="call-us-number">Or call us at <a href="tel:{BIZ['phone_href']}">{BIZ['phone_display']}</a></p>
  </div>
</div>"""

def xmas_quote_modal(depth=0):
    """Christmas Light Installation gets its own lightweight on-page quote
    form that opens as a modal overlay right on the service page — no
    dedicated page, no multi-step wizard. Any "get a quote" link on this
    page is hijacked by main.js to open it instead of navigating away."""
    root = rel(depth)
    return f"""<div class="xmas-modal" id="xmas-quote-modal" hidden>
  <div class="xmas-modal-scrim" data-xmas-close></div>
  <div class="xmas-modal-panel" role="dialog" aria-modal="true" aria-labelledby="xmas-modal-title">
    <button type="button" class="xmas-modal-close" data-xmas-close aria-label="Close">{icon('x')}</button>
    <div class="xmas-modal-body">
      <span class="eyebrow" style="justify-content:center">Free Estimate</span>
      <h2 id="xmas-modal-title" class="center mt-1">Christmas Lights Installation</h2>
      <p class="form-note center">Fill out the form below and we'll reach out shortly.</p>
      <form class="form mt-3" data-lead novalidate>
        <input type="hidden" name="address_state" value="{BIZ['state']}">
        <h3 class="xmas-modal-section">Contact info</h3>
        <div class="form-row">
          <div class="field"><label for="xq-first" class="sr-only">First name</label><input type="text" id="xq-first" name="first_name" autocomplete="given-name" required placeholder="First name"></div>
          <div class="field"><label for="xq-last" class="sr-only">Last name</label><input type="text" id="xq-last" name="last_name" autocomplete="family-name" required placeholder="Last name"></div>
        </div>
        <div class="form-row">
          <div class="field"><label for="xq-email" class="sr-only">Email</label><input type="email" id="xq-email" name="email" autocomplete="email" required placeholder="Email"></div>
          <div class="field"><label for="xq-phone" class="sr-only">Phone</label><input type="tel" id="xq-phone" name="phone" autocomplete="tel" required inputmode="tel" data-validate-phone placeholder="Cell phone"></div>
        </div>
        <h3 class="xmas-modal-section">Property info</h3>
        <div class="field addr-field"><label for="xq-address" class="sr-only">Address</label>
          <input type="text" id="xq-address" name="address" autocomplete="off" required data-address-input placeholder="Start typing your address…">
          <input type="hidden" name="address_verified" data-address-verified value="no">
          <ul class="addr-suggestions" data-address-list hidden></ul>
        </div>
        <div class="form-row">
          <div class="field"><label for="xq-city" class="sr-only">City</label><input type="text" id="xq-city" name="address_city" required data-address-city placeholder="City"></div>
          <div class="field"><label for="xq-zip" class="sr-only">ZIP code</label><input type="text" id="xq-zip" name="address_zip" required inputmode="numeric" pattern="[0-9]{{5}}" data-address-zip placeholder="ZIP code"></div>
        </div>
        <p class="form-note wizard-address-warning" data-address-status hidden>Please choose your address from the suggestions so we can confirm it's a real, serviceable address.</p>
        <div class="field"><label for="xq-where">Where on your house do you want lights?</label>
          <select id="xq-where" name="light_location" required>
            <option value="" selected disabled>Select one…</option>
            <option>Roofline only</option>
            <option>Roofline + trees &amp; bushes</option>
            <option>Roofline + walkway or driveway</option>
            <option>Full package (roofline, trees &amp; walkway)</option>
            <option>Not sure — help me decide</option>
          </select>
        </div>
        <div class="field"><label for="xq-hear">How did you hear about us?</label>
          <select id="xq-hear" name="referral_source" required>
            <option value="" selected disabled>Select one…</option>
            <option>Google Search</option><option>Google Maps / Reviews</option><option>Facebook / Instagram</option>
            <option>Referral from friend/neighbor</option><option>Saw our crew / vehicle</option><option>Returning customer</option><option>Other</option>
          </select>
        </div>
        <label class="check mt-2"><input type="checkbox" name="reminders" required> I agree to receive text messages from {BIZ['name']}, including appointment updates, service notifications, and marketing offers.</label>
        <p class="form-note wizard-disclaimer">By checking this box, you consent to receive recurring SMS messages from {BIZ['name']} at the number provided. Consent is not a condition of purchase. Msg &amp; data rates may apply. Msg frequency varies. Reply STOP to unsubscribe, HELP for help. See our <a href="{root}privacy.html">Privacy Policy</a> and <a href="{root}terms.html">Terms &amp; Conditions</a>.</p>
        <button type="submit" class="btn btn-lg btn-block mt-2">Submit {icon('arrow')}</button>
      </form>
      <div class="form-success">
        {icon('check-circle')}
        <h3>Thank you! Your request is in.</h3>
        <p>Someone will reach out shortly.</p>
        <a class="btn mt-2 call-us-btn" href="tel:{BIZ['phone_href']}">Call Us</a>
        <p class="call-us-number">Or call us at <a href="tel:{BIZ['phone_href']}">{BIZ['phone_display']}</a></p>
      </div>
    </div>
  </div>
</div>"""

_IMG_CARD_DARKS = [
    "linear-gradient(155deg,#23232b 0%,#0c0c10 100%)",
    "linear-gradient(155deg,#2c1d1a 0%,#110c0c 100%)",
    "linear-gradient(155deg,#1a1a22 0%,#0a0a0e 100%)",
    "linear-gradient(155deg,#322019 0%,#130d0b 100%)",
    "linear-gradient(155deg,#202028 0%,#0b0b0f 100%)",
    "linear-gradient(155deg,#2a1c22 0%,#110c0f 100%)",
]

def service_image_card(s, depth=0, idx=0):
    """DirtyMint-style large image card with overlaid title. Uses the same
    real service photo as the homepage grid when present on disk, falling
    back to a branded dark gradient + faint service icon otherwise."""
    root = rel(depth)
    dark = _IMG_CARD_DARKS[idx % len(_IMG_CARD_DARKS)]
    # Use the service's own real photo (SERVICES[]["image"], the same field
    # its own service page's hero uses) instead of re-guessing a filename
    # from the service name — the guess doesn't always match an actual file
    # on disk (e.g. "House Washing" reuses the "soft-washing" photo).
    img = s.get("image") or "assets/img/hero-home.jpg"
    alt = IMAGE_ALT.get(img, f"{s['name']} service photo")
    img_tag = picture(root, img, alt, img_class="img-card-bg",
                       extra_attrs='loading="lazy" decoding="async" onerror="this.remove()"',
                       sizes="(max-width: 760px) 100vw, 33vw")
    return (f'<a class="img-card reveal" data-delay="{idx%4}" href="{root}services/{s["slug"]}.html" aria-label="{s["name"]}" style="background:{dark}">'
            f'{img_tag}'
            f'<span class="img-card-arrow">{icon("arrow")}</span>'
            f'<span class="img-card-body"><h3>{s["name"]}</h3><p>{s["short"][:62]}</p></span></a>')

def _slugify(s):
    out = "".join(c if c.isalnum() else "-" for c in s.lower())
    while "--" in out:
        out = out.replace("--", "-")
    return out.strip("-")

def picture_card(item, depth=0, idx=0):
    """Homepage 'Our Services' picture box: title always shown, description
    revealed on hover. Uses a real photo if present (assets/img/svc-<name>.jpg),
    otherwise falls back to a branded gradient + faint icon."""
    root = rel(depth)
    dark = _IMG_CARD_DARKS[idx % len(_IMG_CARD_DARKS)]
    img = item.get("img") or ("assets/img/svc-" + _slugify(item["label"]) + ".jpg")
    alt = IMAGE_ALT.get(img, f"{item['label']} service photo")
    feat = " featured" if item.get("featured") else ""
    # Featured cards span 2 of 4 columns (desktop) or the full row (tablet/
    # mobile); non-featured cards are 1 of 4 (desktop), 1 of 2 (tablet), or
    # full-width (mobile) — see .svc-grid in styles.css.
    sizes = ("(max-width: 980px) 100vw, 50vw" if item.get("featured")
             else "(max-width: 560px) 100vw, (max-width: 980px) 50vw, 25vw")
    img_tag = picture(root, img, alt, img_class="img-card-bg",
                       extra_attrs='loading="lazy" decoding="async" onerror="this.remove()"',
                       sizes=sizes)
    href = item["target"]
    return (f'<a class="img-card{feat} reveal" data-delay="{idx%4}" href="{root}{href}" aria-label="{item["label"]}" style="background:{dark}">'
            f'{img_tag}'
            f'<span class="img-card-arrow">{icon("arrow")}</span>'
            f'<span class="img-card-body"><h3>{item["label"]}</h3><p>{item["desc"]}</p></span></a>')

def process_slider(steps, depth=0):
    """Step slideshow (e.g. Mop / Scrub / Squeegee / Detail): photo on the
    left, numbered description panel on the right, with nav dots + progress
    line. Steps without a real photo yet (img=None) get a branded gradient
    tile with a watermark icon instead."""
    root = rel(depth)

    photo_attrs = 'loading="lazy" decoding="async"'
    # .process-photo is a fixed-height flex panel at ~42% of the track's
    # width on desktop and a 200px fixed column on mobile (see styles.css).
    photo_sizes = "(max-width: 760px) 200px, 42vw"

    def _slide(i, num, title, img, desc, fic):
        if img:
            alt = IMAGE_ALT.get(img, f"{title} step of the Barta Window Washing cleaning process")
            photo_html = f'<div class="process-photo">{picture(root, img, alt, extra_attrs=photo_attrs, sizes=photo_sizes)}</div>'
        else:
            photo_html = f'<div class="process-photo process-photo-fallback"><span class="process-photo-icon">{icon(fic)}</span></div>'
        return (f'<div class="process-slide{" active" if i == 0 else ""}">{photo_html}'
                f'<div class="process-info"><span class="process-num">{num}</span><h3>{title}</h3><p>{desc}</p></div></div>')

    slides = "".join(_slide(i, num, title, img, desc, fic) for i, (num, title, img, desc, fic) in enumerate(steps))
    dots = "".join(
        (f'<span class="process-line"></span>' if i > 0 else "")
        + f'<button type="button" class="process-dot{" active" if i == 0 else ""}" data-i="{i}" aria-label="Step {i+1}: {title}">{i+1}</button>'
        for i, (num, title, img, desc, fic) in enumerate(steps))
    return f"""<div class="process-slider reveal">
    <div class="process-track">
      {slides}
      <button type="button" class="process-arrow prev" aria-label="Previous step">{icon('arrow')}</button>
      <button type="button" class="process-arrow next" aria-label="Next step">{icon('arrow')}</button>
    </div>
    <div class="process-dots">{dots}</div>
    <div class="center mt-4"><a class="btn" href="{root}get-quote.html">Get Your Free Quote</a></div>
  </div>"""

def trust_badges():
    items = "".join(f'<div class="badge reveal" data-delay="{i%4}">{icon(ic)} {label}</div>' for i, (ic, label) in enumerate(BADGES))
    return f'<div class="badges">{items}</div>'

# Slots with real photos on disk (assets/img/{name}-before.jpg / -after.jpg)
# instead of the auto-generated placeholder SVGs.
BA_REAL_PHOTOS = {"ba1": "window", "ba2": "siding", "ba3": "gutter"}

def ba_slider(label_before="Before", label_after="After", depth=0, name="ba1", sizes="(max-width: 760px) 100vw, 33vw"):
    """`sizes` should match the real column width the .ba container renders
    at — defaults to the 3-column grid used on the homepage and gallery;
    pass "(max-width: 960px) 100vw, 50vw" for the 2-column landing-page use."""
    root = rel(depth)
    if name in BA_REAL_PHOTOS:
        slug = BA_REAL_PHOTOS[name]
        before_src, after_src = f"ba-{slug}-before.jpg", f"ba-{slug}-after.jpg"
    else:
        before_src, after_src = f"{name}-before.svg", f"{name}-after.svg"
    ba_attrs = 'loading="lazy" decoding="async"'
    before_img = picture(root, f"assets/img/{before_src}", "Before professional cleaning — visible dirt, algae, and water spots", img_class="ba-img ba-before", extra_attrs=ba_attrs, sizes=sizes)
    after_img = picture(root, f"assets/img/{after_src}", "After Barta professional cleaning — bright, spotless, like-new surface", img_class="ba-img ba-after", extra_attrs=ba_attrs, sizes=sizes)
    return f"""<div class="ba" role="group" aria-label="Before and after comparison slider">
  {before_img}
  {after_img}
  <span class="ba-label before">{label_before}</span>
  <span class="ba-label after">{label_after}</span>
  <span class="ba-handle"></span>
  <span class="ba-knob">{icon('compare')}</span>
  <input class="ba-range" type="range" min="0" max="100" value="50" aria-label="Reveal more of the before or after image">
</div>"""

def cta_band(depth=0, heading="Schedule Your Next Window Cleaning Today!",
             text="Join hundreds of Delano-area homeowners who trust Barta for a spotless, stress-free exterior. Get your free quote today.",
             primary=("Get Your Free Quote", "get-quote.html"),
             image="assets/img/svc-interior-window-cleaning.jpg", image_pos="8%"):
    root = rel(depth)
    # Decorative full-bleed backdrop behind an overlay + text — never the
    # sole carrier of information, so a CSS background (hidden from
    # assistive tech by default) is correct here. Prefer the pre-generated
    # 1200w variant over the multi-hundred-KB original when one exists;
    # CSS background-image has no srcset equivalent, so this is a single
    # fixed choice rather than a responsive one.
    _bg_stem = image.rsplit(".", 1)[0]
    if _variants_exist(_bg_stem):
        image = f"{_bg_stem}-1200w.jpg"
    bg = (f"linear-gradient(180deg, rgba(8,22,46,.18) 0%, rgba(7,18,40,.32) 45%, rgba(5,13,30,.52) 100%), "
          f"url('{root}{image}')")
    return f"""<section><div class="container"><div class="cta-band reveal" style="background-image:{bg};background-position:center,center {image_pos}">
  <span class="eyebrow" style="color:#ff9b86;justify-content:center">Let's get started</span>
  <h2 class="mt-1">{heading}</h2>
  <p>{text}</p>
  <div class="cta-actions">
    <a class="btn btn-lg" href="tel:{BIZ['phone_href']}">{icon('phone')} Call Us</a>
    <a class="btn btn-lg btn-outline" style="color:#fff;box-shadow:inset 0 0 0 2px rgba(255,255,255,.5)" href="{root}{primary[1]}">{primary[0]} {icon('arrow')}</a>
  </div>
</div></div></section>"""

def review_card(text, name, place, initials, delay=0):
    stars = icon('star') * 5
    return f"""<div class="review-card reveal" data-delay="{delay}">
  <div class="stars">{stars}</div>
  <blockquote>“{text}”</blockquote>
  <div class="who"><span class="avatar">{initials}</span><span><b>{name}</b><span>{place}</span></span></div>
</div>"""

GOOGLE_G = ('<svg viewBox="0 0 48 48" aria-hidden="true" width="18" height="18">'
            '<path fill="#4285F4" d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"/>'
            '<path fill="#34A853" d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"/>'
            '<path fill="#FBBC05" d="M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24s.85 6.91 2.34 9.88l7.35-5.7z"/>'
            '<path fill="#EA4335" d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z"/></svg>')

def google_badge(depth=0, light=False, text=None):
    if text is None:
        text = f"{BIZ['rating']} rating · {BIZ['review_count']}+ reviews"
    """Clickable Google review badge → links to the Google Business Profile."""
    cls = "google-badge google-badge--light" if light else "google-badge"
    stars = '<span class="stars">' + icon("star") * 5 + "</span>"
    return (f'<a class="{cls}" href="{BIZ["google"]}" target="_blank" rel="noopener" aria-label="{text} on Google — view our Google Business Profile">'
            f'{stars}<span class="gb-g">{GOOGLE_G}</span><span class="gb-text">{text}</span></a>')

def reviews_block(widget_embed, fallback_cards, depth=0):
    """Curated review cards render immediately (so the section works with
    no JavaScript at all) when real quotes are available; the 3rd-party
    widget embed is base64-stashed in a data attribute and only fetched/
    executed once its section nears the viewport (see main.js), so it can't
    delay first paint. The "see all reviews" link is static HTML either way.
    With no curated cards and no widget configured, we don't fabricate
    placeholder testimonials — show a Google rating badge/CTA instead."""
    if widget_embed and widget_embed.strip():
        import base64
        encoded = base64.b64encode(widget_embed.encode("utf-8")).decode("ascii")
        fallback_inner = fallback_cards if fallback_cards.strip() else f'<div class="center">{google_badge()}</div>'
        return f"""<div class="reviews-embed reveal" data-lazy-reviews data-widget-b64="{encoded}">
  <div class="grid cols-3" data-reviews-fallback>{fallback_inner}</div>
  <p class="center mt-3"><a class="btn btn-ghost" href="{BIZ['google']}">{icon('star')} See all reviews on Google {icon('arrow')}</a></p>
</div>"""
    if not fallback_cards.strip():
        return f"""<div class="center reveal">
  {google_badge()}
  <p class="mt-3"><a class="btn btn-ghost" href="{BIZ['google']}" target="_blank" rel="noopener">{icon('star')} Read our reviews on Google {icon('arrow')}</a></p>
</div>"""
    return f'<div class="grid cols-3">{fallback_cards}</div>'

def faq_block(items):
    rows = ""
    for q, a in items:
        rows += f"""<details><summary>{q}<span class="pm">{icon('plus')}</span></summary><div class="ans">{a}</div></details>"""
    return f'<div class="faq">{rows}</div>'

def gmap_embed(title, label=None, zoom=10, cls=""):
    """Responsive, lazy-loaded Google Maps embed (no API key required) with
    the business's own Google pin. The embedded iframe centers on our raw
    lat/lng (a plain pin, no business-card panel) so the CSS pin-shift trick
    on `.map-pin-left` reliably works — a business-name `q=` search instead
    renders Google's place-card layout, which ignores the CSS offset. The
    whole widget is still a link that opens the real listing (searched by
    name) on Google Maps. A light placeholder panel shows until the iframe
    finishes loading."""
    label = label or f"{BIZ['legal_name']} — {BIZ['city']}, {BIZ['state']}"
    biz_query = quote_plus(f"{BIZ['legal_name']} {BIZ['city']} {BIZ['state']}")
    src = f"https://maps.google.com/maps?q={BIZ['lat']},{BIZ['lng']}&z={zoom}&output=embed"
    gmaps_link = "https://www.google.com/maps/search/?api=1&query=" + biz_query
    return f"""<a class="map-embed {cls}" data-map-embed
    href="{gmaps_link}" target="_blank" rel="noopener"
    aria-label="{title} — opens Google Maps in a new tab">
    <div class="map-fallback" aria-hidden="true"><span class="ph-label">{icon('pin')}<br>{label}</span></div>
    <iframe src="{src}" title="{title}" width="100%" height="100%" tabindex="-1"
      style="border:0" loading="lazy" referrerpolicy="no-referrer-when-downgrade"
      onload="this.previousElementSibling.style.display='none'"></iframe>
    <span class="map-open-hint">{icon('pin')} Open in Google Maps</span>
  </a>"""

def imgph(label, ratio="16/10", depth=0, extra_class=""):
    return f'<div class="imgph {extra_class}" style="aspect-ratio:{ratio}" role="img" aria-label="{label}"><span class="ph-label">{icon("image")}<br>{label}</span></div>'

def photo(src, alt, ratio="5/4", depth=0, cls=""):
    """Real <img> layered over the gradient placeholder. If the file is missing
    (e.g. not uploaded yet) the img hides itself and the placeholder shows —
    no broken-image icons, graceful before and after the photo exists."""
    root = rel(depth)
    img_tag = picture(root, src, alt, extra_attrs='loading="lazy" decoding="async" onerror="this.remove()"')
    return (f'<div class="photo {cls}" style="aspect-ratio:{ratio}" role="img" aria-label="{alt}">'
            f'<span class="imgph" aria-hidden="true"><span class="ph-label">{icon("image")}<br>{alt}</span></span>'
            f'{img_tag}</div>')

def crumbs(items, depth=0, light=False):
    """items = [(label, href_or_None), ...]. light=True renders a pale
    variant for use over a dark photo hero (service/landing page heroes)."""
    parts = []
    for i, (label, href) in enumerate(items):
        if href:
            parts.append(f'<a href="{href}">{label}</a>')
        else:
            parts.append(f'<span>{label}</span>')
        if i < len(items) - 1:
            parts.append(icon('chevron'))
    cls = "crumbs crumbs-light" if light else "crumbs"
    return f'<nav class="{cls}" aria-label="Breadcrumb">' + "".join(parts) + "</nav>"
