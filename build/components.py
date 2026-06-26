"""Reusable HTML partials and section builders."""
import json
from sitedata import BIZ, SERVICES, AREAS, BADGES
from icons import icon

# Navigation grouping for mega-menu
NAV_SERVICES = SERVICES  # all 10 services appear in the Services mega menu

def rel(depth):
    """Return path prefix to site root given folder depth (0 = root)."""
    return "../" * depth

def head(title, desc, slug, depth=0, schema=None, og_type="website", primary_kw="", canonical=None):
    """<head> block with full SEO + social + JSON-LD."""
    root = rel(depth)
    canonical = canonical or (BIZ["domain"] + "/" + slug)
    schema_blocks = ""
    if schema:
        for s in schema:
            schema_blocks += '<script type="application/ld+json">' + json.dumps(s, separators=(",", ":")) + "</script>\n"
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<script>document.documentElement.className+=" js";</script>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<meta name="description" content="{desc}">
{'<meta name="keywords" content="' + primary_kw + '">' if primary_kw else ''}
<link rel="canonical" href="{canonical}">
<meta name="theme-color" content="#16161b">
<meta name="robots" content="index, follow, max-image-preview:large">
<!-- Open Graph / social -->
<meta property="og:type" content="{og_type}">
<meta property="og:site_name" content="{BIZ['name']}">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{desc}">
<meta property="og:url" content="{canonical}">
<meta property="og:image" content="{BIZ['domain']}/assets/img/og-cover.svg">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{title}">
<meta name="twitter:description" content="{desc}">
<!-- Fonts — Cabinet Grotesk (display) + General Sans (body) via Fontshare -->
<link rel="preconnect" href="https://api.fontshare.com" crossorigin>
<link rel="preconnect" href="https://cdn.fontshare.com" crossorigin>
<link rel="preload" as="style" href="https://api.fontshare.com/v2/css?f[]=cabinet-grotesk@700,800,900&f[]=general-sans@400,500,600,700&display=swap">
<link rel="stylesheet" href="https://api.fontshare.com/v2/css?f[]=cabinet-grotesk@700,800,900&f[]=general-sans@400,500,600,700&display=swap">
<link rel="stylesheet" href="{root}assets/css/styles.css">
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
          {"".join(f'<a href="{root}services/{s["slug"]}.html">{s["name"]}</a>' for s in NAV_SERVICES)}
          <a class="nav-menu-all" href="{root}residential.html">View all services {icon('arrow')}</a>
        </div>
      </li>
      <li><a href="{root}service-plans.html">Plans</a></li>
      <li><a href="{root}reviews.html">Reviews</a></li>
    </ul>
    <div class="nav-cta">
      <a class="btn" href="{root}request-quote.html">Get a Quote</a>
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
      <details class="drawer-group"><summary>Services {icon('chevron')}</summary>
        <div class="sub">{"".join(f'<a href="{root}services/{s["slug"]}.html">{s["name"]}</a>' for s in SERVICES)}</div>
      </details>
      <a href="{root}service-plans.html">Service Plans</a>
      <a href="{root}commercial.html">Commercial</a>
      <a href="{root}residential.html">Residential</a>
      <a href="{root}service-areas.html">Service Areas</a>
      <a href="{root}gallery.html">Gallery</a>
      <a href="{root}reviews.html">Reviews</a>
      <a href="{root}why-choose-us.html">Why Choose Us</a>
      <a href="{root}about.html">About</a>
      <a href="{root}team.html">Meet the Team</a>
      <a href="{root}blog.html">Blog</a>
      <a href="{root}faqs.html">FAQs</a>
      <a href="{root}financing.html">Financing</a>
      <a href="{root}careers.html">Careers</a>
      <a href="{root}contact.html">Contact</a>
    </nav>
    <div class="drawer-foot">
      <a class="btn btn-block" href="{root}request-quote.html">Get My Free Quote</a>
      <a class="btn btn-ghost btn-block" href="tel:{BIZ['phone_href']}">{icon('phone')} {BIZ['phone_display']}</a>
    </div>
  </div>
</div>
"""

def sticky_cta(depth=0):
    root = rel(depth)
    return f"""<div class="sticky-cta">
  <a class="btn btn-call" href="tel:{BIZ['phone_href']}">{icon('phone')} Call</a>
  <a class="btn" href="{root}request-quote.html">Free Quote</a>
</div>"""

def footer(depth=0):
    root = rel(depth)
    svc_links = "".join(f'<li><a href="{root}services/{s["slug"]}.html">{s["name"]}</a></li>' for s in SERVICES[:8])
    area_links = "".join(f'<li><a href="{root}areas/{a["slug"]}.html">{a["city"]}, MN</a></li>' for a in AREAS[:8])
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
          <a href="{BIZ['google']}" aria-label="Google Business Profile">{icon('pin')}</a>
        </div>
      </div>
      <div class="footer-col">
        <h5>Services</h5>
        <ul>{svc_links}</ul>
      </div>
      <div class="footer-col">
        <h5>Service Areas</h5>
        <ul>{area_links}</ul>
      </div>
      <div class="footer-col">
        <h5>Company</h5>
        <ul>
          <li><a href="{root}about.html">About Us</a></li>
          <li><a href="{root}team.html">Meet the Team</a></li>
          <li><a href="{root}why-choose-us.html">Why Choose Us</a></li>
          <li><a href="{root}service-plans.html">Service Plans</a></li>
          <li><a href="{root}reviews.html">Reviews</a></li>
          <li><a href="{root}gallery.html">Gallery</a></li>
          <li><a href="{root}careers.html">Careers</a></li>
          <li><a href="{root}contact.html">Contact</a></li>
        </ul>
      </div>
    </div>
    <div class="footer-bottom">
      <span>© <span id="year">2026</span> {BIZ['name']}. All rights reserved. Licensed &amp; insured in Minnesota.</span>
      <div class="links">
        <a href="{root}request-quote.html">Free Quote</a>
        <a href="{root}faqs.html">FAQs</a>
        <a href="{root}service-areas.html">Service Areas</a>
        <a href="{root}privacy.html">Privacy</a>
      </div>
    </div>
  </div>
</footer>"""

def page_end(depth=0):
    return f"""{sticky_cta(depth)}
{footer(depth)}
<script src="{rel(depth)}assets/js/main.js" defer></script>
</body>
</html>"""

# ---------------------------------------------------------------------------
# Reusable section builders
# ---------------------------------------------------------------------------
def lead_form(depth=0, heading="Request Your Free Quote", sub="No-obligation, same-day pricing. Takes 60 seconds.",
              submit="Get My Free Quote", svc_default=None, compact=False):
    """Full lead-capture form per spec."""
    svc_options = '<option value="" selected disabled>Select a service…</option>'
    for s in SERVICES:
        sel = " selected" if svc_default == s["slug"] else ""
        svc_options += f'<option value="{s["name"]}"{sel}>{s["name"]}</option>'
    svc_options += '<option value="Multiple Services">Multiple Services</option>'
    svc_options += '<option value="Service Plan / Membership">Service Plan / Membership</option>'
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
    <div class="form-row">
      <div class="field"><label for="lf-name">Full name</label><input type="text" id="lf-name" name="name" autocomplete="name" required placeholder="Jane Doe"></div>
      <div class="field"><label for="lf-phone">Phone</label><input type="tel" id="lf-phone" name="phone" autocomplete="tel" required placeholder="(763) 555-0142"></div>
    </div>
    <div class="form-row">
      <div class="field"><label for="lf-email">Email</label><input type="email" id="lf-email" name="email" autocomplete="email" required placeholder="you@email.com"></div>
      <div class="field"><label for="lf-address">Service address</label><input type="text" id="lf-address" name="address" autocomplete="street-address" placeholder="123 Main St, Delano"></div>
    </div>
    <div class="field"><label for="lf-service">Service requested</label><select id="lf-service" name="service" required>{svc_options}</select></div>{extra_fields}
    <label class="check"><input type="checkbox" name="reminders" checked> Send me seasonal cleaning reminders so I never have to remember.</label>
    <label class="check"><input type="checkbox" name="plan_info"> I'm interested in info about recurring maintenance plans.</label>
    <button type="submit" class="btn btn-lg btn-block">{submit} {icon('arrow')}</button>
    <p class="form-note center">By submitting, you agree to be contacted about your request. We never sell your info.</p>
  </form>
  <div class="form-success">
    {icon('check-circle')}
    <h3>Thank you! Your request is in.</h3>
    <p>A friendly Barta team member will reach out shortly — usually within a few hours during business hours — with your free, no-obligation quote.</p>
    <a class="btn mt-2" href="tel:{BIZ['phone_href']}">{icon('phone')} Or call us now: {BIZ['phone_display']}</a>
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
    """DirtyMint-style large image card with overlaid title (no photo needed —
    uses a branded dark gradient + faint service icon; swap in a real photo via
    the .img-card-bg background-image when available)."""
    root = rel(depth)
    dark = _IMG_CARD_DARKS[idx % len(_IMG_CARD_DARKS)]
    bg = f"radial-gradient(75% 60% at 72% 12%, rgba(251,77,61,.32), transparent 62%), {dark}"
    return (f'<a class="img-card reveal" data-delay="{idx%4}" href="{root}services/{s["slug"]}.html" aria-label="{s["name"]}">'
            f'<span class="img-card-bg" style="background-image:{bg}"></span>'
            f'<span class="img-card-watermark">{icon(s["icon"])}</span>'
            f'<span class="img-card-arrow">{icon("arrow")}</span>'
            f'<span class="img-card-body"><h3>{s["name"]}</h3><p>{s["short"][:62]}</p></span></a>')

def trust_badges():
    items = "".join(f'<div class="badge reveal" data-delay="{i%4}">{icon(ic)} {label}</div>' for i, (ic, label) in enumerate(BADGES))
    return f'<div class="badges">{items}</div>'

def ba_slider(label_before="Before", label_after="After", depth=0, name="ba1"):
    root = rel(depth)
    return f"""<div class="ba" role="group" aria-label="Before and after comparison slider">
  <img class="ba-img ba-before" src="{root}assets/img/{name}-before.svg" alt="Before professional cleaning — visible dirt, algae, and water spots" loading="lazy" width="800" height="500">
  <img class="ba-img ba-after" src="{root}assets/img/{name}-after.svg" alt="After Barta professional cleaning — bright, spotless, like-new surface" loading="lazy" width="800" height="500">
  <span class="ba-label before">{label_before}</span>
  <span class="ba-label after">{label_after}</span>
  <span class="ba-handle"></span>
  <span class="ba-knob">{icon('compare')}</span>
  <input class="ba-range" type="range" min="0" max="100" value="50" aria-label="Reveal more of the before or after image">
</div>"""

def cta_band(depth=0, heading="Ready for windows that wow?",
             text="Join hundreds of Delano-area homeowners who trust Barta for a spotless, stress-free exterior. Get your free quote today.",
             primary=("Get Your Free Quote", "request-quote.html")):
    root = rel(depth)
    return f"""<section><div class="container"><div class="cta-band reveal">
  <span class="eyebrow" style="color:#ff9b86;justify-content:center">Let's get started</span>
  <h2 class="mt-1">{heading}</h2>
  <p>{text}</p>
  <div class="cta-actions">
    <a class="btn btn-lg btn-light" href="{root}{primary[1]}">{primary[0]} {icon('arrow')}</a>
    <a class="btn btn-lg btn-outline" style="color:#fff;box-shadow:inset 0 0 0 2px rgba(255,255,255,.5)" href="tel:{BIZ['phone_href']}">{icon('phone')} {BIZ['phone_display']}</a>
  </div>
</div></div></section>"""

def review_card(text, name, place, initials, delay=0):
    stars = icon('star') * 5
    return f"""<div class="review-card reveal" data-delay="{delay}">
  <div class="stars">{stars}</div>
  <blockquote>“{text}”</blockquote>
  <div class="who"><span class="avatar">{initials}</span><span><b>{name}</b><span>{place}</span></span></div>
</div>"""

def reviews_block(widget_embed, fallback_cards, depth=0):
    """Render the live Google reviews widget when configured, else the curated
    fallback cards. Either way it sits inside a `.grid cols-3` container on the
    caller's page, so we only swap the inner content."""
    if widget_embed and widget_embed.strip():
        root = rel(depth)
        return f"""<div class="reviews-embed reveal" data-google-reviews>
{widget_embed}
  <p class="center mt-3"><a class="btn btn-ghost" href="{BIZ['google']}">{icon('star')} See all reviews on Google {icon('arrow')}</a></p>
</div>"""
    return f'<div class="grid cols-3">{fallback_cards}</div>'

def faq_block(items):
    rows = ""
    for q, a in items:
        rows += f"""<details><summary>{q}<span class="pm">{icon('plus')}</span></summary><div class="ans">{a}</div></details>"""
    return f'<div class="faq">{rows}</div>'

def imgph(label, ratio="16/10", depth=0, extra_class=""):
    return f'<div class="imgph {extra_class}" style="aspect-ratio:{ratio}" role="img" aria-label="{label}"><span class="ph-label">{icon("image")}<br>{label}</span></div>'

def photo(src, alt, ratio="5/4", depth=0, cls=""):
    """Real <img> layered over the gradient placeholder. If the file is missing
    (e.g. not uploaded yet) the img hides itself and the placeholder shows —
    no broken-image icons, graceful before and after the photo exists."""
    root = rel(depth)
    return (f'<div class="photo {cls}" style="aspect-ratio:{ratio}" role="img" aria-label="{alt}">'
            f'<span class="imgph" aria-hidden="true"><span class="ph-label">{icon("image")}<br>{alt}</span></span>'
            f'<img src="{root}{src}" alt="{alt}" loading="lazy" decoding="async" '
            f'onerror="this.remove()"></div>')

def crumbs(items, depth=0):
    """items = [(label, href_or_None), ...]"""
    parts = []
    for i, (label, href) in enumerate(items):
        if href:
            parts.append(f'<a href="{href}">{label}</a>')
        else:
            parts.append(f'<span>{label}</span>')
        if i < len(items) - 1:
            parts.append(icon('chevron'))
    return '<nav class="crumbs" aria-label="Breadcrumb">' + "".join(parts) + "</nav>"
