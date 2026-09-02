"""Page chrome for the referral app: <head>, a compact header, the footer and
a few shared section builders.

The app reuses the main website's design system as a snapshot
(public/assets/css/site.css is a copy of its minified stylesheet, the fonts
are the same self-hosted Fontshare files), so the pages look like the brand
without importing anything from the website's own build. All asset and page
URLs are root-absolute: the friend page is served at /r/CODE through a
Netlify rewrite, where relative paths would resolve under /r/.
"""
import html as _html
from config import APP_URL, BIZ
from icons import icon

# Cache-busting version for the app's own CSS/JS, stamped by build.py from
# the files' hashes just before the pages render.
ASSET_VER = "dev"


def esc(s):
    return _html.escape(str(s), quote=True)


def _fonts():
    """Self-hosted Cabinet Grotesk (display) + General Sans (body), the same
    files the main site ships (ITF Free Font License, byte-identical). The
    fallback face pins General Sans' vertical metrics so text doesn't jump
    when the real font arrives."""
    faces = [("Cabinet Grotesk", "CabinetGrotesk-Bold", 700), ("Cabinet Grotesk", "CabinetGrotesk-Extrabold", 800),
             ("Cabinet Grotesk", "CabinetGrotesk-Black", 900), ("General Sans", "GeneralSans-Regular", 400),
             ("General Sans", "GeneralSans-Medium", 500), ("General Sans", "GeneralSans-Semibold", 600),
             ("General Sans", "GeneralSans-Bold", 700)]
    css = "".join(
        f"@font-face{{font-family:'{fam}';src:url('/assets/fonts/{f}.v1.woff2') format('woff2');"
        f"font-weight:{w};font-style:normal;font-display:swap}}" for fam, f, w in faces)
    css += ("@font-face{font-family:'General Sans Fallback';src:local('Roboto'),local('Helvetica Neue'),"
            "local('Arial'),local('DejaVu Sans');ascent-override:101%;descent-override:24%;line-gap-override:10%}")
    preload = "".join(
        f'<link rel="preload" as="font" type="font/woff2" href="/assets/fonts/{f}.v1.woff2" crossorigin>\n'
        for f in ("CabinetGrotesk-Black", "CabinetGrotesk-Extrabold", "GeneralSans-Medium", "GeneralSans-Bold"))
    return preload + f"<style>{css}</style>"


def head(title, desc, path="/", noindex=False, extra_css=(), og_image="/assets/img/og-cover.png"):
    """<head> plus the opening <body> and skip link. `path` is the page's
    root-absolute URL (canonical/OG). The friend page and the office
    dashboard are noindex: one is personal, the other is not for the public."""
    canonical = APP_URL.rstrip("/") + path
    robots = "noindex, follow" if noindex else "index, follow, max-image-preview:large"
    links = "".join(f'<link rel="stylesheet" href="{c}">\n' for c in extra_css)
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<script>document.documentElement.className+=" js";</script>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<meta name="description" content="{esc(desc)}">
<link rel="canonical" href="{canonical}">
<meta name="theme-color" content="#16161b">
<meta name="robots" content="{robots}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="{esc(BIZ['name'])}">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{esc(desc)}">
<meta property="og:url" content="{canonical}">
<meta property="og:image" content="{APP_URL.rstrip('/')}{og_image}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{title}">
<meta name="twitter:description" content="{esc(desc)}">
<meta name="twitter:image" content="{APP_URL.rstrip('/')}{og_image}">
{_fonts()}
<link rel="stylesheet" href="/assets/css/site.css?v={ASSET_VER}">
{links}<link rel="icon" href="/assets/img/favicon.svg" type="image/svg+xml">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
"""


def header():
    """Compact bar in place of the website's full navigation: the logo (back
    to the program page), a link to the main website, and the phone number.
    In-flow rather than fixed, so pages need no top offset."""
    return f"""<header class="app-bar">
  <div class="container app-bar-in">
    <a class="brand" href="/" aria-label="{esc(BIZ['name'])} referral program">
      <img class="brand-logo" src="/assets/img/logo-bww.png" srcset="/assets/img/logo-bww-320w.png 320w, /assets/img/logo-bww.png 765w" sizes="148px" alt="{esc(BIZ['name'])}" width="148" height="40">
    </a>
    <nav class="app-bar-links" aria-label="Primary">
      <a class="app-bar-site" href="{BIZ['site']}">bartawindowwashing.com</a>
      <a class="btn app-bar-call" href="tel:{BIZ['phone_href']}">{icon('phone')} <span>{BIZ['phone_display']}</span></a>
    </nav>
  </div>
</header>
"""


def footer():
    site = BIZ["site"]
    return f"""<footer class="footer app-footer">
  <div class="container">
    <div class="footer-top app-footer-top">
      <div class="footer-about">
        <a class="brand" href="{site}"><img class="brand-logo" src="/assets/img/logo-bww-white.png" alt="{esc(BIZ['name'])}" width="160" height="44"></a>
        <p>{esc(BIZ['tagline'])}. Family-owned, fully insured exterior cleaning for homes and businesses across the western Twin Cities metro.</p>
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
        <h2 class="footer-col-title">Referral program</h2>
        <ul>
          <li><a href="/">Refer a friend</a></li>
          <li><a href="/#how">How it works</a></li>
          <li><a href="/#ref-terms">Program terms</a></li>
        </ul>
      </div>
      <div class="footer-col">
        <h2 class="footer-col-title">{esc(BIZ['name'])}</h2>
        <ul>
          <li><a href="{site}">Main website</a></li>
          <li><a href="{site}/get-quote.html">Get a quote</a></li>
          <li><a href="{site}/reviews.html">Reviews</a></li>
          <li><a href="{site}/privacy.html">Privacy Policy</a></li>
          <li><a href="{site}/terms.html">Terms &amp; Conditions</a></li>
        </ul>
      </div>
    </div>
    <div class="footer-bottom">
      <span>© <span id="year">2026</span> {esc(BIZ['name'])}. All rights reserved. Fully insured in Minnesota.</span>
    </div>
  </div>
</footer>"""


def page_end(js=""):
    return f"""{js}
<script>(function(){{var y=document.getElementById("year");if(y)y.textContent=new Date().getFullYear();}})();</script>
</body>
</html>"""


def faq_block(items):
    rows = "".join(
        f'<details><summary>{q}<span class="pm">{icon("plus")}</span></summary><div class="ans">{a}</div></details>'
        for q, a in items)
    return f'<div class="faq">{rows}</div>'


def trust_badges():
    items = [("shield", "Insured"), ("check", "Locally &amp; Family Owned"),
             ("star", f"{BIZ['rating']}&#9733; Rated ({BIZ['review_count']}+ reviews)"),
             ("check", "100% Satisfaction Guarantee"), ("leaf", "Safe, Eco-Friendly Methods")]
    return '<div class="badges">' + "".join(f'<span class="badge">{icon(i)} {t}</span>' for i, t in items) + "</div>"


def cta_band(heading, text, primary):
    """Closing call to action over the squeegee photo, as on the website."""
    label, href = primary
    bg = ("linear-gradient(180deg, rgba(8,22,46,.18) 0%, rgba(7,18,40,.32) 45%, rgba(5,13,30,.52) 100%), "
          "url('/assets/img/svc-cta-squeegee-1200w.jpg')")
    return f"""<section><div class="container"><div class="cta-band reveal in" style="background-image:{bg};background-position:center,center 35%">
  <span class="eyebrow" style="color:#ff9b86;justify-content:center">Let's get started</span>
  <h2 class="mt-1">{heading}</h2>
  <p>{text}</p>
  <div class="cta-actions">
    <a class="btn btn-lg" href="tel:{BIZ['phone_href']}">{icon('phone')} Call Us</a>
    <a class="btn btn-lg btn-outline" style="color:#fff;box-shadow:inset 0 0 0 2px rgba(255,255,255,.5)" href="{href}">{label} {icon('arrow')}</a>
  </div>
</div></div></section>"""
