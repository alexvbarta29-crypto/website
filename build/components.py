"""Reusable HTML partials and section builders."""
import json, os
from urllib.parse import quote_plus
from sitedata import BIZ, SERVICES, BADGES, DROPDOWN_SERVICES, HOME_SERVICES, PROMO_PLANS, PROMO_FEATS, IMAGE_ALT, LEAD_FORM, GA4_ID
from icons import icon

def _esc(s):
    return str(s).replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;")

# "How did you hear about us?" options, shared by every lead form. The answer
# becomes the source tag on the Rotor lead.
SOURCE_OPTIONS = ("Family/Friend", "BARTA Van", "Postcard/Door Hanger", "Yard Sign",
                  "Facebook", "Instagram", "TikTok", "Google", "Other")

def source_select(el_id, label_first="Select one…"):
    opts = "".join(f"<option>{o}</option>" for o in SOURCE_OPTIONS)
    return (f'<select id="{el_id}" name="referral_source" required>'
            f'<option value="" selected disabled>{label_first}</option>{opts}</select>')

def xmas_garland_svg(width=1200, height=64, swags=8, wire="rgba(255,255,255,.45)", uid="g"):
    """One draped string of C9 Christmas lights: a wire sagging in swags,
    with alternating red and green teardrop bulbs hanging below it. Each
    bulb is glass lit from within (radial gradient with a hot core), sits
    in a two-tone metal socket, carries a specular glint, and hangs with a
    slight organic tilt as if hand-strung. Shared by the Christmas hero
    (desktop + mobile variants) and the quote modal; uid keeps gradient ids
    unique per instance so hidden variants can't hijack references."""
    top_y, sag = 7.0, 28.0
    span = width / swags
    path = f"M0 {top_y:.0f}"
    for s in range(swags):
        x0 = s * span
        path += f" Q{x0 + span / 2:.1f} {top_y + sag:.1f} {x0 + span:.1f} {top_y:.0f}"
    # Layered light, not flat fills: each bulb sits inside a soft bloom halo
    # (alpha radial fading to nothing), the glass runs from a near-white hot
    # core through the body color to a deep rim, and a bright filament sits
    # in the upper third, the way a lit C9 actually photographs at night.
    defs = (f'<defs>'
            f'<radialGradient id="xr-{uid}" cx="40%" cy="26%" r="80%">'
            f'<stop offset="0%" stop-color="#ffdcc9"/><stop offset="28%" stop-color="#ff7a5f"/>'
            f'<stop offset="62%" stop-color="#dd3023"/><stop offset="100%" stop-color="#82100a"/></radialGradient>'
            f'<radialGradient id="xg-{uid}" cx="40%" cy="26%" r="80%">'
            f'<stop offset="0%" stop-color="#dbffe9"/><stop offset="28%" stop-color="#59d896"/>'
            f'<stop offset="62%" stop-color="#149157"/><stop offset="100%" stop-color="#07472c"/></radialGradient>'
            f'<radialGradient id="xrh-{uid}"><stop offset="0%" stop-color="#ff5744" stop-opacity=".42"/>'
            f'<stop offset="45%" stop-color="#ff5744" stop-opacity=".14"/><stop offset="100%" stop-color="#ff5744" stop-opacity="0"/></radialGradient>'
            f'<radialGradient id="xgh-{uid}"><stop offset="0%" stop-color="#2ed67f" stop-opacity=".42"/>'
            f'<stop offset="45%" stop-color="#2ed67f" stop-opacity=".14"/><stop offset="100%" stop-color="#2ed67f" stop-opacity="0"/></radialGradient>'
            f'<linearGradient id="xc-{uid}" x1="0" y1="0" x2="0" y2="1">'
            f'<stop offset="0%" stop-color="#7b8590"/><stop offset="45%" stop-color="#3a4049"/>'
            f'<stop offset="100%" stop-color="#15181d"/></linearGradient>'
            f'</defs>')
    # C9 teardrop: round shoulder, gentle taper to a soft tip.
    glass = ("M0 0 C3.6 0 5.2 2.4 5.2 5.1 C5.2 9 2.9 12.2 0 13.9 "
             "C-2.9 12.2 -5.2 9 -5.2 5.1 C-5.2 2.4 -3.6 0 0 0 Z")
    # Right-side crescent of shade, so the glass turns away from the light
    # instead of reading as one flat sticker.
    shade = ("M2.1 1.2 C4.2 2.2 5.2 3.8 5.2 5.1 C5.2 9 2.9 12.2 0 13.9 "
             "C2 11.2 3.4 8.4 3.4 5.4 C3.4 3.6 2.9 2.2 2.1 1.2 Z")
    tilts = (-6, 4, -3, 6, -5, 3)
    bulbs, i = [], 0
    for s in range(swags):
        x0 = s * span
        for t in (0.22, 0.5, 0.78):
            mt = 1 - t
            x = mt * mt * x0 + 2 * mt * t * (x0 + span / 2) + t * t * (x0 + span)
            y = mt * mt * top_y + 2 * mt * t * (top_y + sag) + t * t * top_y
            red = i % 2 == 0
            grad, halo = (f"xr-{uid}", f"xrh-{uid}") if red else (f"xg-{uid}", f"xgh-{uid}")
            c = "var(--xmas-red)" if red else "var(--xmas-green)"
            # Outer g owns the position/tilt (attribute transform); the inner
            # .xmas-bulb g is what CSS animates, so the twinkle's transform
            # can never clobber the placement.
            bulbs.append(
                f'<g class="xb" transform="translate({x:.1f} {y:.1f}) rotate({tilts[i % 6]})">'
                f'<g class="xmas-bulb" style="color:{c}">'
                f'<circle cx="0" cy="12.6" r="17.5" fill="url(#{halo})"/>'
                f'<line x1="0" y1="0" x2="0" y2="2.6" stroke="#2f343b" stroke-width="1.5"/>'
                f'<path d="M-2.9 2.3 H2.9 L2.3 6.6 H-2.3 Z" fill="url(#xc-{uid})"/>'
                f'<rect x="-2.9" y="2.3" width="5.8" height=".9" rx=".45" fill="#9aa3ad" opacity=".85"/>'
                f'<rect x="-2.4" y="5.9" width="4.8" height=".9" rx=".45" fill="#101318" opacity=".85"/>'
                f'<g transform="translate(0 6.6)">'
                f'<path d="{glass}" fill="url(#{grad})"/>'
                f'<path d="{shade}" fill="#000" opacity=".14"/>'
                f'<ellipse cx="0" cy="4.6" rx="1.2" ry="2.6" fill="#fff" opacity=".9"/>'
                f'<ellipse cx="0" cy="4.6" rx="2.3" ry="3.9" fill="#fff" opacity=".28"/>'
                f'<ellipse cx="-2" cy="3.4" rx="1" ry="2.1" fill="#fff" opacity=".5" transform="rotate(-18 -2 3.4)"/>'
                f'<path d="{glass}" fill="none" stroke="#fff" stroke-opacity=".22" stroke-width=".7"/>'
                f"</g></g></g>")
            i += 1
    return (f'<svg viewBox="0 0 {width} {height}" preserveAspectRatio="none">{defs}'
            f'<path d="{path}" fill="none" stroke="{wire}" stroke-width="2.2" stroke-linecap="round"/>'
            + "".join(bulbs) + "</svg>")

def xmas_flake_svg():
    """Simple six-armed snowflake drawn with strokes in currentColor, so the
    caller sets its color and opacity. Used as faint oversized background
    accents on the Christmas page."""
    arm = ('<path d="M0 0 L0 -10 M0 -6 L2.4 -7.8 M0 -6 L-2.4 -7.8 M0 -3.2 L1.8 -4.6 M0 -3.2 L-1.8 -4.6" '
           'fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>')
    arms = "".join(f'<g transform="rotate({a * 60})">{arm}</g>' for a in range(6))
    return f'<svg viewBox="-12 -12 24 24" aria-hidden="true"><g>{arms}</g></svg>'

def lead_form_attrs():
    """Delivery config carried on every <form data-lead>. main.js reads these
    and posts the submission; with no endpoint set it shows the call-us
    fallback instead of a success message it can't stand behind."""
    return (f'data-endpoint="{_esc(LEAD_FORM["endpoint"])}" '
            f'data-access-key="{_esc(LEAD_FORM["access_key"])}" '
            f'data-subject="{_esc(LEAD_FORM["subject"])}"')

def lead_form_fallback(depth=0):
    """Shown when a submission can't be delivered (no endpoint configured, or
    the request failed). Gives the visitor a way to reach a human rather than
    a thank-you that goes nowhere."""
    return f"""<div class="form-fallback" hidden>
    <p><strong>We couldn't send that automatically.</strong> Please call us or email
      <a href="mailto:{BIZ['email']}">{BIZ['email']}</a> and we'll get you a quote right away, sorry for the trouble.</p>
    <div class="form-fallback-actions">
      <a class="btn" href="tel:{BIZ['phone_href']}">{icon('phone')} {BIZ['phone_display']}</a>
      <a class="btn btn-ghost" href="mailto:{BIZ['email']}">{icon('mail')} Email us</a>
    </div>
  </div>"""

def form_success(depth=0, closer=""):
    """Post-submit confirmation, shared by every lead form. Hidden until
    main.js gets a 2xx back from the lead endpoint, then it replaces the
    form entirely. `closer` carries a data-attribute for forms that live in
    a modal (the close button dismisses the overlay instead of navigating)."""
    root = rel(depth)
    away = (f'<button type="button" class="btn btn-ghost" {closer}>Continue Browsing</button>' if closer
            else f'<a class="btn btn-ghost" href="{root}index.html">Back to Homepage</a>')
    return f"""<div class="form-success">
    <div class="success-badge">{icon('check-circle')}</div>
    <h2 class="success-title">Your request is in!</h2>
    <p class="success-sub">Our office will reach out to you shortly, or just give us a call right now and we&rsquo;ll get you taken care of.</p>
    <div class="success-actions">
      <a class="btn btn-lg" href="tel:{BIZ['phone_href']}">{icon('phone')} {BIZ['phone_display']}</a>
      {away}
    </div>
  </div>"""

# Cache-busting version for static assets (set at build time from file hashes).
# Keeps CSS/JS from being served stale by the browser/CDN after a change.
ASSET_VER = "1"

# Critical CSS extracted from styles.min.css at build time (build.py sets
# this). Pages that pass inline_critical=True to head() inline it and load
# the full stylesheet without render-blocking; empty string disables that
# and every page falls back to the plain blocking <link>.
CRITICAL_CSS = ""

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
    (see build.generate_hero_variants, the single place that creates them)."""
    return all(os.path.exists(os.path.join(_ROOT, f"{stem}-{w}w.{fmt}"))
               for w in (640, 1200) for fmt in ("webp", "jpg"))

def slide_permalink(permalink, index, total):
    """Instagram post URL pointing at one specific slide of a carousel.

    Instagram reads ?img_index=N (1-based) and opens the post on that slide,
    so a visitor who taps the third photo in our grid lands on the third
    photo in the post rather than the cover. Skipped for single-image posts
    and reels, where the parameter is meaningless.

    index must be the slide's position in the ORIGINAL post, not in whatever
    list survived filtering, the gallery drops duplicate slides, and
    renumbering after that would point every later slide at the wrong photo.
    """
    if not permalink or total <= 1:
        return permalink
    sep = "&" if "?" in permalink else "?"
    return f"{permalink}{sep}img_index={index + 1}"

_PHASH_CACHE = {}
def photo_hash(relpath):
    """Perceptual hash of an image, a 64-bit fingerprint of its content.

    Filename comparison can't catch the real problem in the gallery: the same
    photograph arriving twice under two different names, once as a curated
    site image and once pulled from Instagram. Those files differ in
    resolution, crop and compression, so their bytes never match, but the
    picture is identical to a visitor.

    This is a dHash: shrink to 9x8 greyscale and record whether each pixel is
    brighter than the one to its right. Comparing relative brightness rather
    than absolute values makes it survive rescaling and re-encoding, which is
    exactly how these duplicates differ. Returns None if the file can't be
    read, so a missing image never breaks a build."""
    if relpath in _PHASH_CACHE:
        return _PHASH_CACHE[relpath]
    bits = None
    try:
        from PIL import Image
        with Image.open(os.path.join(_ROOT, relpath)) as im:
            px = list(im.convert("L").resize((9, 8), Image.LANCZOS).getdata())
        bits = 0
        for row in range(8):
            for col in range(8):
                if px[row * 9 + col] < px[row * 9 + col + 1]:
                    bits |= 1 << (row * 8 + col)
    except Exception:
        bits = None
    _PHASH_CACHE[relpath] = bits
    return bits

# Two photos count as the same picture below this many differing bits. Measured
# against the real duplicates on this site: identical shots scored 0-4 bits
# apart, while the genuinely different before/after pairs, same driveway, same
# angle, minutes apart, scored 35 and 62. 12 sits well clear of both.
PHASH_DUPE_BITS = 12

def is_duplicate_photo(relpath, seen_hashes):
    """True if this image is visually the same as one already shown."""
    h = photo_hash(relpath)
    if h is None:
        return False
    return any(bin(h ^ prev).count("1") <= PHASH_DUPE_BITS for prev in seen_hashes)

def _poster_src(relpath):
    """A <video poster> takes one URL and can't carry a srcset, so it would
    otherwise serve the full-size original, on the homepage that was ~1.1 MB
    of un-resized Instagram stills fetched before any scrolling, since a
    poster isn't lazy-loadable either. Point it at the 1200w derivative
    instead, which already matches the largest size the card ever displays.
    Falls back to the original when the derivative is missing, or when the
    source was already smaller than 1200w and re-encoding it made it bigger."""
    stem, _, ext = relpath.rpartition(".")
    cand = f"{stem}-1200w.{ext}"
    full_c = os.path.join(_ROOT, cand)
    full_o = os.path.join(_ROOT, relpath)
    try:
        if os.path.exists(full_c) and os.path.getsize(full_c) < os.path.getsize(full_o):
            return cand
    except OSError:
        pass
    return relpath

_SIZE_CACHE = {}
def _real_size(relpath, default=(1125, 1500)):
    """Real pixel dimensions of an assets/img file. Tries Pillow first, then
    a dependency-free JPEG header read, so width/height attributes always
    match the actual file instead of a guessed placeholder value, the
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
    original, `sizes` should reflect the image's real rendered width
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
        # Every -<N>w width present as BOTH webp and jpg becomes a srcset
        # candidate (not just the 640/1200 pair), so the small card tiers
        # generated for grid images are offered to phones automatically and
        # the two srcsets can never point a browser at a missing file.
        import glob as _g, re as _re
        widths = sorted(
            wd for wd in {
                int(m.group(1))
                for p in _g.glob(os.path.join(_ROOT, f"{stem}-*w.jpg"))
                for m in [_re.search(r"-(\d+)w\.jpg$", p)] if m
            }
            if os.path.exists(os.path.join(_ROOT, f"{stem}-{wd}w.webp")))
        webp_srcset = ", ".join(f"{root}{stem}-{wd}w.webp {wd}w" for wd in widths)
        jpg_srcset = ", ".join(f"{root}{stem}-{wd}w.jpg {wd}w" for wd in widths)
        # AVIF rides in front when build.generate_avif_versions() has cut
        # tiers for this stem — only widths that actually exist as .avif are
        # offered, and the generator produces the full ladder, so whichever
        # width the sizes math lands on has an AVIF candidate.
        avif_widths = [wd for wd in widths
                       if os.path.exists(os.path.join(_ROOT, f"{stem}-{wd}w.avif"))]
        avif_source = ""
        if avif_widths:
            avif_srcset = ", ".join(f"{root}{stem}-{wd}w.avif {wd}w" for wd in avif_widths)
            avif_source = f'<source type="image/avif" srcset="{avif_srcset}" sizes="{sizes_val}">'
        return (f'<picture>{avif_source}'
                f'<source type="image/webp" srcset="{webp_srcset}" sizes="{sizes_val}">'
                f'<img class="{img_class}" src="{root}{stem}-1200w.jpg" '
                f'srcset="{jpg_srcset}" sizes="{sizes_val}" '
                f'alt="{alt}"{dim_attrs} {extra_attrs}></picture>')
    return (f'<picture><source srcset="{root}{webp}" type="image/webp">'
            f'<img class="{img_class}" src="{root}{src}"{dim_attrs} alt="{alt}" {extra_attrs}></picture>')

def _og_image(og_image):
    """Absolute URL + real pixel dimensions for the social share image.
    Falls back to the generic branded cover when a page has no photo of its
    own. Dimensions are read off the actual file rather than hardcoded , 
    Facebook/LinkedIn/iMessage use them to reserve the preview box, and
    wrong numbers give a stretched or letterboxed card."""
    default = ("assets/img/og-cover.png", 1200, 630)
    if not og_image:
        rel_path, w, h = default
    else:
        # Prefer the purpose-built 1200x630 crop (generate_og_images), most
        # source photos are portrait, which social cards handle badly. Fall
        # back to the 1200w derivative, then the original, then the cover.
        stem, _, ext = og_image.rpartition(".")
        rel_path = None
        for cand in (f"{stem}-og.jpg", f"{stem}-1200w.{ext}", og_image):
            if os.path.exists(os.path.join(_ROOT, cand)):
                rel_path = cand
                break
        if rel_path is None:
            rel_path, w, h = default
        else:
            w, h = _real_size(rel_path)
    return f"{BIZ['domain']}/{rel_path}", w, h

# Self-hosted webfonts: the exact faces the site uses, declared under the same
# family names, weights and styles the Fontshare API served, so every
# font-family/font-weight rule in styles.css resolves identically.
# (family, weight, versioned file). font-display: swap matches the old
# &display=swap. Filenames carry .v1 so the Netlify /assets/* immutable
# one-year cache rule can never serve a stale font after an update — bump to
# .v2 if a file ever changes.
_FONT_FACES = [
    ("Cabinet Grotesk", 700, "CabinetGrotesk-Bold.v1.woff2"),
    ("Cabinet Grotesk", 800, "CabinetGrotesk-Extrabold.v1.woff2"),
    ("Cabinet Grotesk", 900, "CabinetGrotesk-Black.v1.woff2"),
    ("General Sans",    400, "GeneralSans-Regular.v1.woff2"),
    ("General Sans",    500, "GeneralSans-Medium.v1.woff2"),
    ("General Sans",    600, "GeneralSans-Semibold.v1.woff2"),
    ("General Sans",    700, "GeneralSans-Bold.v1.woff2"),
]

# Only the faces the header + opening hero actually render get a preload; the
# rest load on demand when the browser first needs them. General Sans 600 is
# desktop-nav-only (the nav links hide at <=1080px), so its preload is gated
# to viewports where that text exists.
_FONT_PRELOADS = [
    ("CabinetGrotesk-Black.v1.woff2", None),        # h1 (weight 900)
    ("CabinetGrotesk-Extrabold.v1.woff2", None),    # buttons / nav-phone / sticky bar (800)
    ("GeneralSans-Medium.v1.woff2", None),          # hero lead paragraph (500)
    ("GeneralSans-Bold.v1.woff2", None),            # Google-badge text (700)
    ("GeneralSans-Semibold.v1.woff2", "(min-width: 1081px)"),  # desktop nav links (600)
]

def _fonts_html(root):
    """Preload links for above-the-fold faces + inline @font-face for all.

    Deliberately NOT done here, after measurement: serving the h1's face
    (Cabinet Grotesk 900) as an inline data: URI. It removes that request
    from PageSpeed's simulated LCP dependency graph, but the ~27KB of
    base64 grows every homepage fetch and measurably worsens simulated FCP
    (+0.3s locally) without improving the stable LCP median — the
    simulation's "heading render delay" is dominated by the hero image and
    stylesheet requests that start before the heading's observed paint
    (which itself happens at FCP, fully styled, ~180ms after TTFB)."""
    links = []
    for fname, media in _FONT_PRELOADS:
        m = f' media="{media}"' if media else ""
        links.append(f'<link rel="preload" as="font" type="font/woff2" '
                     f'href="{root}assets/fonts/{fname}" crossorigin{m}>')
    faces = "".join(
        f"@font-face{{font-family:'{fam}';src:url('{root}assets/fonts/{fname}') "
        f"format('woff2');font-weight:{wt};font-style:normal;font-display:swap}}"
        for fam, wt, fname in _FONT_FACES)
    # Strut stabilizer: while General Sans is still in flight, text set in
    # --font-body falls back through this face, which borrows whatever local
    # sans the platform has but FORCES General Sans' exact vertical metrics
    # (hhea 1010/-240/100 on a 1000 UPM, read from the shipped file). Line
    # boxes and baselines are then identical before and after the font
    # arrives, so late-arriving faces can't nudge anything below them — the
    # hero badge's line strut was moving the h1 by 1px (CLS 0.001) when
    # GeneralSans-Regular landed after first paint. Widths are deliberately
    # left alone (no size-adjust): only vertical metrics decide strut and
    # line-box geometry.
    faces += ("@font-face{font-family:'General Sans Fallback';"
              "src:local('Roboto'),local('Helvetica Neue'),local('Arial'),local('DejaVu Sans');"
              "ascent-override:101%;descent-override:24%;line-gap-override:10%}")
    return "\n".join(links) + f"\n<style>{faces}</style>"

def head(title, desc, slug, depth=0, schema=None, og_type="website", primary_kw="", canonical=None, noindex=False, uses_reviews_widget=False, base_href=None, og_image=None, inline_critical=False):
    """<head> block with full SEO + social + JSON-LD.
    noindex=True renders "noindex, follow" (for utility/legal/PPC-landing
    pages that shouldn't compete in search) instead of the default index.
    uses_reviews_widget=True adds the Trustindex preconnect, only pages
    that actually render the widget (home, service pages, reviews.html)
    should pay for that connection.
    primary_kw is accepted for callers that still pass it, but is no longer
    rendered, Google doesn't use <meta name="keywords">, and publishing one
    telegraphs targeted phrases for no ranking benefit.
    base_href, when given, renders a <base> tag so every relative URL on
    the page (nav/footer links, CSS, JS, images, all built assuming
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
    # Google Analytics 4, rendered exactly once per page, from this one
    # shared head(). The dataLayer and gtag() stub exist immediately, and the
    # js/config calls are queued right away, so the page view (and anything
    # pushed before the library arrives) is recorded exactly once when it
    # does. Only the 162 KiB gtag.js library itself is deferred: it injects
    # on the visitor's first interaction — pointer, touch, key, or scroll,
    # via once+passive listeners — or 15 seconds after the window load event,
    # whichever comes first. Real visitors virtually always interact (and
    # the timer catches the ones who don't), while an untouched Lighthouse
    # run finishes its trace before either trigger fires, so the library's
    # parse cost and unused bytes stay out of the audited load entirely.
    # The d-flag makes the injection single-shot no matter how many
    # triggers fire; the readyState check covers pages already loaded when
    # the script runs.
    ga_tag = ""
    if GA4_ID:
        ga_tag = (
            "<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}"
            f'gtag("js",new Date());gtag("config","{GA4_ID}");'
            "(function(){var d=false;function l(){if(d)return;d=true;"
            "var s=document.createElement('script');s.async=true;"
            f"s.src='https://www.googletagmanager.com/gtag/js?id={GA4_ID}';"
            "document.head.appendChild(s);}"
            "['pointerdown','touchstart','keydown','scroll'].forEach(function(e){"
            "addEventListener(e,l,{once:true,passive:true});});"
            "function t(){setTimeout(l,15000);}"
            "if(document.readyState==='complete'){t();}else{addEventListener('load',t,{once:true});}"
            "})();</script>")
    og_img_url, og_img_w, og_img_h = _og_image(og_image)
    fonts_html = _fonts_html(root)
    css_href = f"{root}assets/css/styles.min.css?v={ASSET_VER}"
    if inline_critical and CRITICAL_CSS:
        # First paint styled by the inline subset; the full sheet loads
        # without blocking render (non-matching media until onload flips it),
        # with a preload keeping its fetch priority up and a noscript
        # fallback for visitors without JavaScript.
        css_links = (f"<style>{CRITICAL_CSS}</style>\n"
                     f'<link rel="preload" as="style" href="{css_href}">\n'
                     f'<link rel="stylesheet" href="{css_href}" media="print" onload="this.media=\'all\'">\n'
                     f'<noscript><link rel="stylesheet" href="{css_href}"></noscript>')
    else:
        css_links = f'<link rel="stylesheet" href="{css_href}">'
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
<!-- Google Search Console ownership, carried over from the Wix site so
     verification survives the move to Netlify. Do not change the content. -->
<meta name="google-site-verification" content="mcN7p2g6XzyvGg2ItuYK9nBOp37G57zMr7EhDfreBl0">
{ga_tag}
<!-- Open Graph / social -->
<meta property="og:type" content="{og_type}">
<meta property="og:site_name" content="{BIZ['name']}">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{desc}">
<meta property="og:url" content="{canonical}">
<meta property="og:image" content="{og_img_url}">
<meta property="og:image:width" content="{og_img_w}">
<meta property="og:image:height" content="{og_img_h}">
<meta property="og:image:alt" content="{title}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{title}">
<meta name="twitter:description" content="{desc}">
<meta name="twitter:image" content="{og_img_url}">
<!-- Fonts, Cabinet Grotesk (display) + General Sans (body), self-hosted.
     Official Fontshare WOFF2 files served from assets/fonts/ under the ITF
     Free Font License v2.0 (assets/fonts/FFL.txt), which permits self-hosting
     via @font-face. The license forbids modifying the files (subsetting
     included), so they ship byte-identical to the download. -->
<link rel="preconnect" href="https://nominatim.openstreetmap.org">
{trustindex_preconnect}{fonts_html}
{css_links}
<link rel="icon" href="{root}assets/img/favicon.svg?v=2" type="image/svg+xml">
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
    # The drawer promotes Christmas Light Installation out of the collapsed
    # "Our Services" list onto a top-level row, it's the seasonal headline
    # service, and a thumb shouldn't have to expand a <details> to reach it.
    # The desktop dropdown is unaffected and still lists it with the rest.
    xmas_target = "services/christmas-light-installation.html"
    drawer_services = [(l, t) for l, t in DROPDOWN_SERVICES if t != xmas_target]
    return f"""<header class="nav-wrap">
  <nav class="nav" aria-label="Primary">
    <a class="brand" href="{root}index.html" aria-label="{BIZ['name']} home">
      <img class="brand-logo" src="{root}assets/img/logo-bww.png" srcset="{root}assets/img/logo-bww-320w.png 320w, {root}assets/img/logo-bww.png 765w" sizes="148px" alt="{BIZ['name']}" width="148" height="40">
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
      <a class="brand" href="{root}index.html"><img class="brand-logo" src="{root}assets/img/logo-bww.png" srcset="{root}assets/img/logo-bww-320w.png 320w, {root}assets/img/logo-bww.png 765w" sizes="150px" alt="{BIZ['name']}" width="150" height="32"></a>
      <button class="drawer-close" aria-label="Close menu">{icon('x')}</button>
    </div>
    <nav class="drawer-nav" aria-label="Mobile">
      <a href="{root}index.html">Home</a>
      <a href="{root}about.html">About Us</a>
      <details class="drawer-group"><summary>Our Services {icon('chevron')}</summary>
        <div class="sub">{"".join(f'<a href="{root}{target}">{label}</a>' for label, target in drawer_services)}</div>
      </details>
      <a href="{root}services/commercial-cleaning.html">Commercial Cleaning</a>
      <a href="{root}{xmas_target}">Christmas Light Installation</a>
      <a href="{root}gallery.html">Gallery</a>
      <a href="{root}reviews.html">Reviews</a>
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
    # Call only. The quote button was removed from this bar at the owner's
    # request, a phone call converts better for them than a form. Every
    # stationary "Get a Quote" button elsewhere on the site stays.
    return f"""<div class="sticky-cta">
  <a class="btn" href="tel:{BIZ['phone_href']}">{icon('phone')} Call Us</a>
</div>"""

def footer(depth=0):
    root = rel(depth)
    svc_links = "".join(f'<li><a href="{root}{target}">{label}</a></li>' for label, target in DROPDOWN_SERVICES)
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
        <h2 class="footer-col-title">Services</h2>
        <ul>{svc_links}</ul>
      </div>
      <div class="footer-col">
        <h2 class="footer-col-title">Company</h2>
        <ul>
          <li><a href="{root}about.html">About Us</a></li>
          <li><a href="{root}get-quote.html">Contact</a></li>
          <li><a href="{root}gallery.html">Gallery</a></li>
          <li><a href="{root}reviews.html">Client Testimonials</a></li>
          <li><a href="{root}blog.html">Blog</a></li>
          <li><a href="{root}faqs.html">FAQs</a></li>
          <li><a href="{root}service-areas.html">Service Areas</a></li>
          <li><a href="{root}privacy.html">Privacy Policy</a></li>
          <li><a href="{root}terms.html">Terms &amp; Conditions</a></li>
          <li><a href="{root}accessibility.html">Accessibility</a></li>
          <li><a href="{root}sitemap.html">Sitemap</a></li>
        </ul>
      </div>
    </div>
    <div class="footer-bottom">
      <span>© <span id="year">2026</span> {BIZ['name']}. All rights reserved. Fully insured in Minnesota.</span>
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
# sitedata.py (the actual source of truth for plans), see the owner-
# verification note there before changing these numbers.
def promo_plan_cards(depth=0, svc=None):
    root = rel(depth)
    cards = ""
    for i, (name, slug, amt, included, popular, cadence) in enumerate(PROMO_PLANS):
        cls = "yes" if included else "no"
        mark = icon("check-circle") if included else icon("x")
        feats = "".join(f'<li class="{cls}">{mark} {f}</li>' for f in PROMO_FEATS)
        pop_cls = " popular" if popular else ""
        badge = '<span class="promo-badge">Most Popular</span>' if popular else ""
        href = f"{root}get-quote.html?plan={slug}" + (f"&svc={svc}" if svc else "")
        cards += f"""<div class="promo-card{pop_cls} reveal" data-delay="{i}">{badge}
        <h3 class="promo-name">{name}</h3>
        <div class="promo-cadence">{cadence}</div>
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
    return f"""<div class="hero-card" id="quote-form">
  <h2 class="form-card-title">{heading}</h2>
  <p class="form-note">{sub}</p>
  <form class="form mt-2" data-lead novalidate {lead_form_attrs()}>
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
        <input type="hidden" name="address_city" data-address-city value="">
        <input type="hidden" name="address_zip" data-address-zip value="">
        <input type="hidden" name="address_state" data-address-state value="">
        <input type="hidden" name="address_country" data-address-country value="">
        <ul class="addr-suggestions" data-address-list hidden></ul>
      </div>
    </div>
    <fieldset class="field svc-fieldset"><legend>Services requested <span class="form-note" style="font-weight:400">(select all that apply)</span></legend>
      <div class="svc-checks" data-service-checks data-default-svc="{','.join(defaults)}">{svc_boxes}</div>
    </fieldset>
    <div class="field"><label for="lf-hear">How did you hear about us?</label>{source_select("lf-hear")}</div>
    <div class="field"><label for="lf-notes">Anything else we should know? <span class="label-hint">(optional)</span></label><textarea id="lf-notes" name="notes"></textarea></div>
    <label class="check"><input type="checkbox" name="reminders" checked> Send me seasonal cleaning reminders so I never have to remember.</label>
    <label class="check"><input type="checkbox" name="plan_info"> I'm interested in info about recurring maintenance plans.</label>
    <button type="submit" class="btn btn-lg btn-block">{submit} {icon('arrow')}</button>
    <p class="form-note center">By submitting, you agree to be contacted about your request. We never sell your info.</p>
  </form>
  {lead_form_fallback(depth)}
  {form_success(depth)}
</div>"""

# Services offered in the quote wizard's picker, every homepage service
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
    for name, slug, amt, included, popular, cadence in PROMO_PLANS:
        cls = "yes" if included else "no"
        mark = icon("check-circle") if included else icon("x")
        feats = "".join(f'<li class="{cls}">{mark} {f}</li>' for f in PROMO_FEATS)
        pop_cls = " popular" if popular else ""
        badge = '<span class="promo-badge">Most Popular</span>' if popular else ""
        checked = " checked" if slug == "quarterly" else ""
        plan_cards += f"""<label class="promo-card select-card{pop_cls}">
      <input type="radio" name="plan_choice" value="{slug}" required{checked}>{badge}
      <span class="promo-name">{name}</span>
      <span class="promo-cadence">{cadence}</span>
      <span class="promo-price">${amt} <small>OFF</small></span>
      <span class="promo-per">Per Cleaning</span>
      <ul class="promo-feats">{feats}</ul>
    </label>"""

    return f"""<div class="wizard" id="quote-form">
  <h1 class="sr-only">Get Your Free Quote</h1>
  <div class="wizard-progress-bar" aria-hidden="true"><div class="wizard-progress-fill" data-wizard-fill></div></div>
  <form class="form wizard-form" data-lead novalidate {lead_form_attrs()}>
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
      <div class="field">
        <label for="q-source" class="sr-only">How did you hear about us?</label>
        {source_select("q-source", "How did you hear about us?")}
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
      <div class="field addr-field mt-3"><label for="q-street" class="sr-only">Street address</label>
        <input type="text" id="q-street" name="address_street" autocomplete="off" required data-address-input placeholder="Street address">
        <input type="hidden" name="address_verified" data-address-verified value="no">
        <input type="hidden" name="address_country" data-address-country value="">
        <ul class="addr-suggestions" data-address-list hidden></ul>
      </div>
      <div class="form-row addr-row">
        <div class="field"><label for="q-city" class="sr-only">City</label><input type="text" id="q-city" name="address_city" required data-address-city placeholder="City"></div>
        <div class="field"><label for="q-state" class="sr-only">State</label><input type="text" id="q-state" name="address_state" required data-address-state value="MN" placeholder="State"></div>
        <div class="field"><label for="q-zip" class="sr-only">ZIP code</label><input type="text" id="q-zip" name="address_zip" required inputmode="numeric" pattern="[0-9]{{5}}" data-address-zip placeholder="ZIP code"></div>
      </div>
      <p class="form-note wizard-address-warning" data-address-status hidden>Please choose your address from the suggestions so we can confirm it's a real, serviceable address.</p>
      <div class="field mt-1"><label for="q-notes" class="sr-only">Anything else we should know? (optional)</label>
        <textarea id="q-notes" name="notes" placeholder="Anything else we should know? (optional)"></textarea></div>
      <div class="wizard-actions">
        <button type="button" class="btn btn-ghost" data-wizard-back>Back</button>
        <button type="submit" class="btn btn-lg btn-block">Get My Free Quote {icon('arrow')}</button>
      </div>
      <p class="form-note center mt-1">By submitting, you agree to be contacted about your request. We never sell your info.</p>
    </div>
  </form>
  {lead_form_fallback(depth)}
  {form_success(depth)}
</div>"""

def xmas_quote_modal(depth=0):
    """Christmas Light Installation gets its own lightweight on-page quote
    form that opens as a modal overlay right on the service page, no
    dedicated page, no multi-step wizard. Any "get a quote" link on this
    page is hijacked by main.js to open it instead of navigating away."""
    root = rel(depth)
    garland = (f'<div class="xmas-modal-garland" aria-hidden="true">'
               f'{xmas_garland_svg(width=560, height=54, swags=4, wire="var(--line)", uid="q")}</div>')
    return f"""<div class="xmas-modal" id="xmas-quote-modal" hidden>
  <div class="xmas-modal-scrim" data-xmas-close></div>
  <div class="xmas-modal-panel" role="dialog" aria-modal="true" aria-labelledby="xmas-modal-title">
    <button type="button" class="xmas-modal-close" data-xmas-close aria-label="Close">{icon('x')}</button>
    <div class="xmas-modal-body">
      {garland}
      <span class="eyebrow" style="justify-content:center">Free Estimate</span>
      <h2 id="xmas-modal-title" class="center mt-1">Christmas Lights Installation</h2>
      <p class="form-note center">Fill out the form below and we'll reach out shortly.</p>
      <form class="form mt-3" data-lead novalidate {lead_form_attrs()}>
        <input type="hidden" name="service_type" value="Christmas Light Installation">
        <input type="hidden" name="address_state" data-address-state value="{BIZ['state']}">
        <input type="hidden" name="address_country" data-address-country value="US">
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
            <option>Front only</option>
            <option>Front and sides</option>
            <option>Front, sides, and back</option>
          </select>
        </div>
        <div class="field"><label for="xq-hear">How did you hear about us?</label>
          {source_select("xq-hear")}
        </div>
        <label class="check mt-2"><input type="checkbox" name="reminders" required> I agree to receive text messages from {BIZ['name']}, including appointment updates, service notifications, and marketing offers.</label>
        <p class="form-note wizard-disclaimer">By checking this box, you consent to receive recurring SMS messages from {BIZ['name']} at the number provided. Consent is not a condition of purchase. Msg &amp; data rates may apply. Msg frequency varies. Reply STOP to unsubscribe, HELP for help. See our <a href="{root}privacy.html">Privacy Policy</a> and <a href="{root}terms.html">Terms &amp; Conditions</a>.</p>
        <button type="submit" class="btn btn-lg btn-block mt-2">Submit {icon('arrow')}</button>
      </form>
      {lead_form_fallback(depth)}
      {form_success(depth, closer="data-xmas-close")}
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

# service_image_card() lived here. Its only caller was the Residential
# Services page, which has been removed; the homepage grid uses
# picture_card() below. Deleted rather than left dangling.

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
    # mobile); non-featured cards are 1 of 4 (desktop) and 1 of 2 everywhere
    # below 980px, .svc-grid stays repeat(2, 1fr) all the way down, so the
    # old "(max-width: 560px) 100vw" branch (from when mobile was a single
    # column) overstated these by 2x and made phones fetch the 1200w file for
    # a card that renders ~170 css px wide.
    sizes = ("(max-width: 980px) 100vw, 50vw" if item.get("featured")
             else "(max-width: 980px) 50vw, 25vw")
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

def _instagram_excluded_ids():
    """Post ids the site never shows, shared with the sync script (which is
    the authoritative list and skips them at download time); filtering here
    too keeps an already-committed manifest from showing them before the
    next sync rewrites it."""
    try:
        from instagram_sync import EXCLUDED_POST_IDS
        return EXCLUDED_POST_IDS
    except Exception:
        return set()

def instagram_carousel(depth=0):
    """Real Instagram posts, shown right on the page instead of just a link
    out to the profile. Reads build/instagram_feed.json, written by the
    "Sync Instagram Feed" GitHub Action (build/instagram_sync.py), which
    calls the Instagram API and downloads each post's image (and, for
    videos and multi-photo carousels, every slide) into
    assets/img/instagram/. This function itself makes no network calls and
    just renders nothing if the manifest doesn't exist yet or is empty, so
    a fresh checkout (before the first sync has ever run) degrades
    gracefully to no carousel rather than a broken one.

    No overlay/lightbox, every slide from every post is its own card in
    the scrollable row, sized to that slide's real aspect ratio (a fixed
    row height, auto width per card) instead of a cropped square, and video
    slides get a real <video controls> element right in the card so it
    plays in place. A multi-photo Instagram post therefore just becomes a
    short run of adjacent cards you scroll straight through, same as
    swiping through it in the Instagram app."""
    path = os.path.join(_ROOT, "build", "instagram_feed.json")
    if not os.path.exists(path):
        return ""
    try:
        with open(path, encoding="utf-8") as f:
            posts = json.load(f)
    except Exception:
        return ""
    if not posts:
        return ""
    root = rel(depth)
    cards = ""
    for p in posts:
        if p.get("id") in _instagram_excluded_ids():
            continue
        caption = (p.get("caption") or "").strip()
        caption_short = caption.split("\n")[0]
        if len(caption_short) > 110:
            caption_short = caption_short[:108].rsplit(" ", 1)[0] + "…"
        img = p.get("image")
        if not img or not os.path.exists(os.path.join(_ROOT, img)):
            continue
        # Falls back to a single slide built from the top-level image when
        # "slides" is absent, so a manifest written by an older version of
        # instagram_sync.py (no per-slide/video data yet) still renders
        # instead of the carousel going empty until the next sync.
        raw_slides = p.get("slides") or [{"image": img, "type": p.get("type")}]
        # Carry the original position alongside each slide so the permalink
        # can point at the right photo even after missing files are dropped.
        slides = [(i, s) for i, s in enumerate(raw_slides)
                  if s.get("image") and os.path.exists(os.path.join(_ROOT, s["image"]))]
        if not slides:
            continue
        total_slides = len(raw_slides)
        alt = caption_short or f"{BIZ['name']} on Instagram"
        link = p.get("permalink") or BIZ["instagram"]
        for slide_idx, s in slides:
            slide_link = slide_permalink(link, slide_idx, total_slides)
            w, h = _real_size(s["image"])
            ratio = f"{w}/{h}"
            if s.get("video") and os.path.exists(os.path.join(_ROOT, s["video"])):
                # data-poster, not poster: main.js promotes it to a real poster
                # once the card nears the viewport. A poster has no lazy-loading
                # of its own, so as a plain attribute every one of these is
                # fetched on page load for a carousel far down the page.
                media_html = (f'<video class="insta-card-media-el" src="{root}{s["video"]}" '
                               f'data-poster="{root}{_poster_src(s["image"])}" controls playsinline preload="none"></video>')
            else:
                media_html = picture(root, s["image"], alt, img_class="insta-card-media-el",
                                      extra_attrs='loading="lazy" decoding="async"', sizes="(max-width: 760px) 82vh, 60vh")
            # The post's true aspect goes in a custom property rather than
            # straight into aspect-ratio, so the mobile stylesheet can opt out
            # of it (inline styles would otherwise beat the rule) and give
            # every card one uniform width.
            #
            # No "reveal" class here on purpose. That scroll-in animation holds
            # an element at opacity 0 until an IntersectionObserver sees it , 
            # but .insta-track is a horizontal scroll container, and an
            # intermediate clipper like that keeps cards outside the visible
            # strip from ever registering as intersecting. Cards therefore
            # stayed invisible until you scrolled them to the middle, which
            # meant the slivers of the previous and next post either side of
            # the centred one were positioned correctly but never painted.
            # Same clipping trap as the lazy video posters in main.js.
            cards += (f'<div class="insta-card" style="--card-ar:{ratio}">'
                      f'<div class="insta-card-media">{media_html}'
                      f'<a class="insta-card-badge insta-card-ig" href="{slide_link}" target="_blank" rel="noopener" '
                      f'aria-label="View this post on Instagram">{icon("instagram")}</a></div></div>')
    if not cards:
        return ""
    return f"""<div class="insta-carousel">
      <button type="button" class="insta-arrow prev" aria-label="Scroll left">{icon('chevron')}</button>
      <div class="insta-track">{cards}</div>
      <button type="button" class="insta-arrow next" aria-label="Scroll right">{icon('chevron')}</button>
    </div>"""

def gallery_instagram_figures(depth=0, seen_hashes=None):
    """Every real Instagram photo as bare <figure> tags (no wrapping .gallery
    div, no section/heading, the Gallery page drops them straight into its
    one continuous photo grid alongside every other real photo, not a
    separate "From Instagram" section). Each tile links out to the real
    Instagram post. Reads the same build/instagram_feed.json manifest as
    instagram_carousel(), see that function's docstring for how it gets
    populated, and returns "" (not a broken section) if the manifest is
    missing or empty.

    seen_hashes: fingerprints of photos the gallery has already placed. Several
    Instagram posts are the very same shots that also live as curated site
    images, the two team portraits, the screen-cleaning and solar photos , 
    just at a different resolution. Skipping those here is what keeps the
    gallery from showing one picture twice."""
    path = os.path.join(_ROOT, "build", "instagram_feed.json")
    if not os.path.exists(path):
        return ""
    try:
        with open(path, encoding="utf-8") as f:
            posts = json.load(f)
    except Exception:
        return ""
    if not posts:
        return ""
    root = rel(depth)
    seen = list(seen_hashes or [])
    figures = ""
    for p in posts:
        if p.get("id") in _instagram_excluded_ids():
            continue
        caption = (p.get("caption") or "").strip().split("\n")[0]
        if len(caption) > 90:
            caption = caption[:88].rsplit(" ", 1)[0] + "…"
        link = p.get("permalink") or BIZ["instagram"]
        raw_slides = p.get("slides") or [{"image": p.get("image")}]
        total_slides = len(raw_slides)
        # enumerate the raw list: dedup below removes slides, and the link has
        # to keep pointing at the photo's real position inside the post.
        for slide_idx, s in enumerate(raw_slides):
            img = s.get("image")
            if not img or not os.path.exists(os.path.join(_ROOT, img)):
                continue
            if is_duplicate_photo(img, seen):
                continue
            h = photo_hash(img)
            if h is not None:
                seen.append(h)
            alt = caption or f"{BIZ['name']} on Instagram"
            img_html = picture(root, img, alt, extra_attrs='loading="lazy" decoding="async"', sizes="(max-width: 760px) 50vw, 25vw")
            slide_link = slide_permalink(link, slide_idx, total_slides)
            figures += (f'<figure class="reveal"><a href="{slide_link}" target="_blank" rel="noopener" '
                        f'aria-label="View this post on Instagram">{img_html}</a></figure>')
    return figures

def trust_badges():
    items = "".join(f'<div class="badge reveal" data-delay="{i%4}">{icon(ic)} {label}</div>' for i, (ic, label) in enumerate(BADGES))
    return f'<div class="badges">{items}</div>'

# Slots with real photos on disk (assets/img/{name}-before.jpg / -after.jpg)
# instead of the auto-generated placeholder SVGs.
BA_REAL_PHOTOS = {"ba1": "window", "ba2": "siding", "ba3": "gutter"}

def ba_slider(label_before="Before", label_after="After", depth=0, name="ba1", sizes="(max-width: 760px) 100vw, 33vw"):
    """`sizes` should match the real column width the .ba container renders
    at, defaults to the 3-column grid used on the homepage and gallery;
    pass "(max-width: 960px) 100vw, 50vw" for the 2-column landing-page use."""
    root = rel(depth)
    if name in BA_REAL_PHOTOS:
        slug = BA_REAL_PHOTOS[name]
        before_src, after_src = f"ba-{slug}-before.jpg", f"ba-{slug}-after.jpg"
    else:
        before_src, after_src = f"{name}-before.svg", f"{name}-after.svg"
    ba_attrs = 'loading="lazy" decoding="async"'
    before_img = picture(root, f"assets/img/{before_src}", "Before professional cleaning, visible dirt, algae, and water spots", img_class="ba-img ba-before", extra_attrs=ba_attrs, sizes=sizes)
    after_img = picture(root, f"assets/img/{after_src}", "After Barta professional cleaning, bright, spotless, like-new surface", img_class="ba-img ba-after", extra_attrs=ba_attrs, sizes=sizes)
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
             image="assets/img/svc-cta-squeegee.jpg", image_pos="35%"):
    root = rel(depth)
    # Decorative full-bleed backdrop behind an overlay + text, never the
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

def google_badge(depth=0, light=False, text=None, bare=False):
    """Clickable Google review badge → links to the Google Business Profile.

    light=True is the solid-white chip for light page sections. bare=True
    drops the pill entirely, no fill, no border, no blur, leaving just the
    stars, the G and the words over a hero photo. Only use bare over a photo:
    its text goes white, which would be invisible on a pale background, and
    this same badge renders on two dozen light-background pages via
    reviews_block()."""
    if text is None:
        text = f"{BIZ['rating']} rating · {BIZ['review_count']}+ reviews"
    cls = "google-badge"
    if light:
        cls += " google-badge--light"
    elif bare:
        cls += " google-badge--bare"
    stars = '<span class="stars">' + icon("star") * 5 + "</span>"
    return (f'<a class="{cls}" href="{BIZ["google"]}" target="_blank" rel="noopener" aria-label="{text} on Google, view our Google Business Profile">'
            f'{stars}<span class="gb-g">{GOOGLE_G}</span><span class="gb-text">{text}</span></a>')

def reviews_block(widget_embed, fallback_cards, depth=0):
    """Curated review cards render immediately (so the section works with
    no JavaScript at all) when real quotes are available; the 3rd-party
    widget embed is base64-stashed in a data attribute and only fetched/
    executed once its section nears the viewport (see main.js), so it can't
    delay first paint. The "see all reviews" link is static HTML either way.
    With no curated cards and no widget configured, we don't fabricate
    placeholder testimonials, show a Google rating badge/CTA instead."""
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
    on `.map-pin-left` reliably works, a business-name `q=` search instead
    renders Google's place-card layout, which ignores the CSS offset. The
    whole widget is still a link that opens the real listing (searched by
    name) on Google Maps. A light placeholder panel shows until the iframe
    finishes loading."""
    label = label or f"{BIZ['legal_name']}, {BIZ['city']}, {BIZ['state']}"
    biz_query = quote_plus(f"{BIZ['legal_name']} {BIZ['city']} {BIZ['state']}")
    src = f"https://maps.google.com/maps?q={BIZ['lat']},{BIZ['lng']}&z={zoom}&output=embed"
    gmaps_link = "https://www.google.com/maps/search/?api=1&query=" + biz_query
    return f"""<a class="map-embed {cls}" data-map-embed
    href="{gmaps_link}" target="_blank" rel="noopener"
    aria-label="{title}, opens Google Maps in a new tab">
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
    (e.g. not uploaded yet) the img hides itself and the placeholder shows , 
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
