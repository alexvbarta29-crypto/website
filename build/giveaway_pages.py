"""Holiday Lights Giveaway pages (docs/GIVEAWAY.md).

  giveaway_page(depth)        -> giveaway.html        entry page; /giveaway and /g/CODE serve it
  giveaway_rules_page(depth)  -> giveaway-rules.html  official rules; /giveaway/rules serves it
  giveaway_admin_page(depth)  -> admin/giveaway.html  office dashboard (key-protected, noindex)

Every number and date comes from sitedata.GIVEAWAY (mirror of
netlify/lib/giveaway-config.mjs). Styling: assets/css/giveaway.css;
behaviour: assets/js/giveaway.js and assets/js/giveaway-admin.js, minified
and cache-busted by the build like the referral program's files.
"""
import components as C
from icons import icon
from sitedata import BIZ, GIVEAWAY as G, XMAS_PHOTO_ALT

PRIZE = f"${G['prize_value']:,}"
COUPON = f"${G['coupon']}"
WINNERS = G["winners"]
WORDS = {1: "one", 2: "two", 3: "three", 4: "four"}


def _assets(depth, name="giveaway"):
    root = C.rel(depth)
    css = f'<link rel="stylesheet" href="{root}assets/css/{name}.min.css?v={C.ASSET_VER}">\n'
    js = f'<script src="{root}assets/js/{name}.min.js?v={C.ASSET_VER}" defer></script>'
    return css, js


def _lp_header(root, rules=False):
    """Standalone landing-page header: the snow-capped logo and nothing that
    leads into the main site. The giveaway is its own page, not a page of
    the website."""
    right = ('<a class="gw-lp-link" href="/giveaway">Back to the giveaway</a>' if rules
             else '<a class="btn gw-lp-cta" href="#enter">Enter to win</a>')
    if rules:
        logo = C._brand_logo(root, "(max-width: 760px) 120px, 150px", 150, 41, xmas=True)
    else:
        # White Christmas mark: the hero is a dark photo.
        stem = f"{root}assets/img/logo-bww-xmas-white"
        logo = (f'<img src="{stem}.png" srcset="{stem}-320w.png 320w, {stem}-480w.png 480w, {stem}.png 765w" '
                f'sizes="(max-width: 760px) 120px, 150px" alt="{BIZ["name"]}" width="150" height="41">')
    return f"""<header class="gw-lp-top"><div class="container gw-lp-top-row">
  <span class="gw-lp-brand">{logo}</span>
  {right}
</div></header>"""


def _lp_end(root):
    """Minimal footer: who runs it, the legal links the rules need, and the
    site script (address autocomplete, reveal animations). No site nav,
    no call bar."""
    return f"""<footer class="gw-lp-foot"><div class="container">
  <p><strong>{G['name']}</strong> by {BIZ['name']}, {BIZ['city']}, {BIZ['state']}.
     Questions? Call or text <a href="tel:{BIZ['phone_href']}">{BIZ['phone_display']}</a>.</p>
  <p class="gw-lp-legal">No purchase necessary. <a href="/giveaway/rules">Official rules</a> &middot;
     <a href="{root}privacy.html">Privacy</a> &middot; Not sponsored or endorsed by Facebook.</p>
</div></footer>
<script src="{root}assets/js/main.min.js?v={C.ASSET_VER}" defer></script>
</body>
</html>"""


def _alt(src):
    return C._esc(XMAS_PHOTO_ALT.get(src, "A home lit up with Christmas lights installed by Barta"))


def _data_attrs():
    return (f'data-closes="{G["closes_iso"]}" data-draw="{G["draw_iso"]}" data-coupon="{G["coupon"]}" '
            f'data-prize="{G["prize_value"]}" data-prefix="{G["code_prefix"]}" '
            f'data-phone="{BIZ["phone_display"]}" data-phone-href="{BIZ["phone_href"]}" '
            f'data-draw-label="{G["draw_short"]}"')


def _entry_form():
    """Three boxes, like the playbook: name, mobile, address. giveaway.js
    splits the name. The address reuses main.js's autocomplete
    (data-address-* hooks), which also fills the hidden lat/lng the
    service-area check reads. Two consent boxes: giveaway texts (required)
    and the post-drawing coupon + occasional offers (optional)."""
    return f"""<form class="gw-form" data-gw-form novalidate>
          <div class="gw-invite" data-gw-invite hidden>{icon('gift')} <span data-gw-invite-text></span></div>
          <div class="field"><label for="gw-name">Your name</label><input id="gw-name" name="name" autocomplete="name" required maxlength="120" placeholder="Jane Doe"></div>
          <div class="field"><label for="gw-phone">Mobile number</label><input id="gw-phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" required maxlength="25" placeholder="(763) 555-0123"></div>
          <div class="field addr-field"><label for="gw-address">Home address <span class="label-hint">(to confirm you&rsquo;re inside the circle)</span></label>
            <input type="text" id="gw-address" name="address" autocomplete="off" required maxlength="200" data-address-input placeholder="Start typing your address…">
            <input type="hidden" name="address_verified" data-address-verified value="no">
            <input type="hidden" name="address_city" data-address-city value="">
            <input type="hidden" name="address_zip" data-address-zip value="">
            <input type="hidden" name="address_state" data-address-state value="">
            <input type="hidden" name="address_country" data-address-country value="">
            <input type="hidden" name="address_lat" data-address-lat value="">
            <input type="hidden" name="address_lng" data-address-lng value="">
            <ul class="addr-suggestions" data-address-list hidden></ul>
            <p class="gw-area" data-gw-area hidden></p>
          </div>
          <input type="text" name="website" class="gw-hp" tabindex="-1" autocomplete="off" aria-hidden="true">
          <label class="check gw-consent"><input type="checkbox" name="consent" required>
            <span>Text me about this giveaway: my entry and share link, up to two reminders, the results, and replies to anything I text back.</span></label>
          <label class="check gw-consent"><input type="checkbox" name="offers">
            <span>Optional: if I don&rsquo;t win, text me the {COUPON}-off coupon, plus a few offers a year.</span></label>
          <p class="gw-err" data-gw-error role="alert" hidden></p>
          <button type="submit" class="btn btn-lg btn-block gw-submit">Enter the giveaway {icon('arrow')}</button>
          <p class="gw-legal">No purchase necessary. Entries close {G['closes'].replace(', 2026', '')}. Msg &amp; data rates may apply; reply STOP to opt out.
            <a href="/giveaway/rules">Official rules</a> &middot; <a href="/privacy.html">Privacy</a></p>
        </form>"""


def _panels():
    """Every non-form state of the entry card. giveaway.js shows exactly one."""
    share = """<div class="gw-share">
            <label class="gw-share-label" for="gw-share-url">Your share link</label>
            <div class="gw-share-row">
              <input id="gw-share-url" readonly data-gw-share-url>
              <button type="button" class="btn gw-copy" data-gw-copy>Copy</button>
            </div>
            <div class="gw-share-btns">
              <button type="button" class="btn btn-ghost" data-gw-native hidden>Share</button>
              <a class="btn btn-ghost" data-gw-sms href="#">Text it</a>
              <a class="btn btn-ghost" data-gw-fb href="#" target="_blank" rel="noopener">Facebook</a>
            </div>
          </div>"""
    return f"""<div class="gw-panel" data-gw-panel="done" hidden tabindex="-1">
          <span class="gw-badge">You&rsquo;re in!</span>
          <h2 class="gw-panel-title">Nice, <span data-gw-name></span>. You have <span class="gw-count" data-gw-entries>1</span> <span data-gw-entries-word>entry</span>.</h2>
          <p>Every friend who enters with your link gives you <strong>+1 entry</strong>. And if a friend you invited wins, <strong>you both win</strong>.</p>
          {share}
          <p class="gw-fine" data-gw-status-wrap>Bookmark <a data-gw-status href="#">your private entries page</a>, or come back here any time and use &ldquo;Already entered?&rdquo; with your number.</p>
        </div>
        <div class="gw-panel" data-gw-panel="returning" hidden tabindex="-1">
          <span class="gw-badge">Already entered</span>
          <h2 class="gw-panel-title">You&rsquo;re already in, <span data-gw-name></span>!</h2>
          <p>Keep sharing your link. Every friend who enters with it adds an entry for you.</p>
          {share}
        </div>
        <div class="gw-panel" data-gw-panel="outside" hidden tabindex="-1">
          <span class="gw-badge gw-badge-muted">Outside our area</span>
          <h2 class="gw-panel-title">Sorry, that address is outside our service area.</h2>
          <p>The giveaway is only open to homes within about {G['radius_mi']} miles of Delano, so we can&rsquo;t enter you. But we&rsquo;d still be glad to give you a quick, free quote on Christmas lights if we can make it out your way.</p>
          <div class="gw-actions">
            <button type="button" class="btn" data-gw-outside-yes>Yes, get me a free quote</button>
            <button type="button" class="btn btn-ghost" data-gw-outside-no>Fix my address</button>
          </div>
          <p class="gw-err" data-gw-outside-error role="alert" hidden></p>
        </div>
        <div class="gw-panel" data-gw-panel="outside-done" hidden tabindex="-1">
          <span class="gw-badge">Got it</span>
          <h2 class="gw-panel-title">Thanks! We&rsquo;ll reach out with a quote.</h2>
          <p>Expect a call or text from us soon. Questions? <a href="tel:{BIZ['phone_href']}">{BIZ['phone_display']}</a></p>
        </div>
        <div class="gw-panel" data-gw-panel="closed" hidden>
          <span class="gw-badge gw-badge-muted">Entries closed</span>
          <h2 class="gw-panel-title">Entries closed {G['closes'].split(' at ')[0].split(', ', 1)[1]}.</h2>
          <p>Winners are drawn live {G['draw']}. If you entered, keep an eye on your texts.</p>
        </div>
        <div class="gw-panel" data-gw-panel="status" hidden tabindex="-1">
          <span class="gw-badge" data-gw-status-badge>Your entries</span>
          <h2 class="gw-panel-title">Hi <span data-gw-name></span>! You have <span class="gw-count" data-gw-entries>1</span> <span data-gw-entries-word>entry</span>.</h2>
          <p data-gw-friends-line>No friends have entered with your link yet. Send it to a few neighbors!</p>
          <div data-gw-status-share>{share}</div>
          <div class="gw-result" data-gw-won hidden>
            <h3>You won! {icon('gift')}</h3>
            <p>Congratulations! We&rsquo;ll call you to set up your free installation. Questions? <a href="tel:{BIZ['phone_href']}">{BIZ['phone_display']}</a></p>
          </div>
          <div class="gw-result gw-coupon" data-gw-coupon hidden>
            <h3>You didn&rsquo;t win the big one, but you get {COUPON} off.</h3>
            <p>For entering, take <strong>{COUPON} off</strong> a Christmas light installation this season. Claim it by {G['claim_by']}, and we&rsquo;ll send your quote fast.</p>
            <button type="button" class="btn btn-lg btn-block" data-gw-claim>Claim my {COUPON} off {icon('arrow')}</button>
            <p class="gw-err" data-gw-claim-error role="alert" hidden></p>
          </div>
          <div class="gw-result" data-gw-claimed hidden>
            <h3>Your {COUPON} off is claimed {icon('check-circle')}</h3>
            <p>We&rsquo;ll call or text you shortly with your quote. Want to talk now? <a href="tel:{BIZ['phone_href']}">{BIZ['phone_display']}</a></p>
          </div>
          <div class="gw-result" data-gw-expired hidden>
            <h3>The {COUPON} coupon has expired.</h3>
            <p>We&rsquo;d still love to light up your home. Call or text <a href="tel:{BIZ['phone_href']}">{BIZ['phone_display']}</a> for a free quote.</p>
          </div>
        </div>
        <div class="gw-panel" data-gw-panel="notfound" hidden>
          <h2 class="gw-panel-title">We couldn&rsquo;t find that entry link.</h2>
          <p>Double-check the link from your text, or call or text us at <a href="tel:{BIZ['phone_href']}">{BIZ['phone_display']}</a>.</p>
        </div>"""


def _countdown():
    """One line, like the playbook page: "Drawing in 17d 09h 14m · Fri, Nov 6, 6pm"."""
    return f"""<p class="gw-timer" data-gw-countdown role="timer" aria-live="off">
          <span class="gw-dot" aria-hidden="true"></span>
          <span data-gw-cd-label>Drawing in</span>
          <b><span data-cd="d">--</span>d <span data-cd="h">--</span>h <span data-cd="m">--</span>m <span data-cd="s">--</span>s</b>
          <span class="gw-timer-when">&middot; {G['draw_short']}, 6pm</span>
        </p>"""


# Towns drawn on the service-area map (approximate centers). Only names; the
# circle is the real rule (G["radius_mi"] straight-line miles from Delano).
MAP_TOWNS = [
    ("Delano", 45.042, -93.789), ("Buffalo", 45.172, -93.875), ("St. Michael", 45.210, -93.665),
    ("Rockford", 45.088, -93.734), ("Watertown", 44.964, -93.847), ("Waconia", 44.851, -93.787),
    ("Mound", 44.937, -93.666), ("Wayzata", 44.974, -93.507), ("Plymouth", 45.011, -93.456),
    ("Maple Grove", 45.073, -93.456), ("Medina", 45.035, -93.582), ("Minnetonka", 44.921, -93.468),
    ("Chanhassen", 44.862, -93.531), ("Victoria", 44.859, -93.662),
    ("Howard Lake", 45.061, -94.073), ("Monticello", 45.306, -93.794), ("Otsego", 45.274, -93.591),
    ("Chaska", 44.789, -93.602), ("Mayer", 44.885, -93.888), ("Rogers", 45.189, -93.553),
    ("Cokato", 45.076, -94.190),
]


def _area_map():
    """An SVG of the eligibility circle with the towns inside it, projected
    from lat/lng (miles east/north of Delano). No map tiles to load."""
    import math
    lat0, lng0 = 45.0419, -93.7891
    R = G["radius_mi"]
    size, pad = 420, 34
    scale = (size / 2 - pad) / R          # px per mile
    cx = cy = size / 2
    kx = math.cos(math.radians(lat0)) * 69.0
    pts = []
    for name, lat, lng in MAP_TOWNS:
        x = cx + (lng - lng0) * kx * scale
        y = cy - (lat - lat0) * 69.0 * scale
        pts.append((name, x, y))
    dots = "".join(
        (f'<g class="gw-map-home"><circle cx="{x:.1f}" cy="{y:.1f}" r="7"/>'
         f'<text x="{x:.1f}" y="{y - 13:.1f}" text-anchor="middle">Delano</text></g>') if name == "Delano" else
        (f'<circle class="gw-map-dot" cx="{x:.1f}" cy="{y:.1f}" r="3.6"/>'
         + (f'<text class="gw-map-label" x="{x:.1f}" y="{y + 15:.1f}" text-anchor="middle">{name}</text>'
            if name == "Victoria" else
            f'<text class="gw-map-label" x="{x:.1f}" y="{y - 9:.1f}" text-anchor="middle">{name}</text>'
            if name == "Chanhassen" else
            f'<text class="gw-map-label" x="{x - 6:.1f}" y="{y + 4:.1f}" text-anchor="end">{name}</text>'
            if x > cx + 70 else
            f'<text class="gw-map-label" x="{x + 6:.1f}" y="{y + 4:.1f}">{name}</text>'))
        for name, x, y in pts)
    # the bulb strand around the circle edge
    bulbs = "".join(
        f'<circle class="gw-map-bulb b{i % 3}" cx="{cx + (R * scale) * math.cos(a):.1f}" cy="{cy + (R * scale) * math.sin(a):.1f}" r="3.2"/>'
        for i, a in enumerate([2 * math.pi * k / 48 for k in range(48)]))
    mpls_x = cx + (-93.265 - lng0) * kx * scale
    arrow = ""
    if mpls_x > size - 10:
        my = cy - (44.978 - lat0) * 69.0 * scale
        arrow = (f'<text class="gw-map-label gw-map-out" x="{size - 10}" y="{size - 36}" text-anchor="end">Minneapolis &rarr;</text>')
    return f"""<svg class="gw-map" viewBox="0 0 {size} {size}" role="img"
      aria-label="Map: the giveaway circle reaches {R} miles from Delano, including Buffalo, St. Michael, Maple Grove, Plymouth, Wayzata, Minnetonka, Chanhassen, Waconia and Watertown">
      <rect width="{size}" height="{size}" rx="22" class="gw-map-bg"/>
      <circle cx="{cx}" cy="{cy}" r="{R * scale:.1f}" class="gw-map-circle"/>
      {bulbs}
      {dots}
      {arrow}
      <text class="gw-map-scale" x="{cx}" y="{size - 10}" text-anchor="middle">{R} miles from Delano</text>
    </svg>"""


def giveaway_page(depth=0, seo_title=None, schema=None):
    """Single-column landing page laid out like the playbook's example:
    eyebrow, headline, hook, drawing timer, video, the 3-box form, how it
    works, what you get, the eligibility circle, footer."""
    seo_title = seo_title or (lambda s: s)
    root = C.rel(depth)
    css, js = _assets(depth)
    n_word = WORDS.get(WINNERS, str(WINNERS))
    title = f"Win Free Christmas Lights, {G['name']}"
    desc = (f"Barta Window Washing is giving away up to {n_word} free Christmas light installs (up to {PRIZE} each) "
            f"in the west metro. Drawing {G['draw']}. No purchase necessary.")
    html = C.head(title=seo_title(title), desc=desc, slug="giveaway.html", depth=depth, schema=schema,
                  noindex=True, extra_head=css, og_image=G["hero_photo"])
    html += _lp_header(root)

    if G.get("video"):
        video = (f'<video controls playsinline preload="metadata" poster="{root}{G["video_poster"]}" '
                 f'src="{root}{G["video"]}"></video>')
    else:
        # Blank screen until the owner's video is ready (sitedata GIVEAWAY["video"]).
        video = ('<div class="gw-video-blank" aria-label="Video coming soon">'
                 '<span class="gw-play" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></span></div>')

    steps = [
        ("Sign up, get your link", "Enter above. Your own share link pops up on the screen right away."),
        ("Send friends your link", "Every friend who enters through it is one more chance for you. If they win, you win too."),
        ("Watch the drawing", f"Live on Facebook, {G['draw']} at 6pm. We call the winners that night."),
    ]
    step_html = "".join(
        f'<li class="gw-step"><span class="step-num {"xmas-red" if i % 2 == 0 else "xmas-green"}">{i + 1}</span>'
        f'<div><h3>{t}</h3><p>{d}</p></div></li>' for i, (t, d) in enumerate(steps))
    perks = [
        ("No ladders", "We hang every light. You don&rsquo;t touch a thing."),
        ("No tangled cords", "Commercial-grade LEDs, cut to fit your house."),
        ("Bulb goes out? We fix it", "Service calls are included all season."),
        ("No January takedown", "We take it all down after the holidays."),
    ]
    perk_html = "".join(f'<li>{icon("check-circle")}<div><strong>{t}</strong> <span>{d}</span></div></li>' for t, d in perks)
    photo = G["photos"][0]

    html += f"""<main id="main" class="gw-page" {_data_attrs()}>
  <section class="gw-top"><div class="gw-col">
    <span class="gw-eyebrow">West Metro Giveaway</span>
    <h1>We&rsquo;re giving away up to <em>{n_word}</em> free Christmas light installs.</h1>
    <p class="gw-hook"><strong>Free Christmas lights on your house, up to {PRIZE}.</strong>
      Share your link: if a friend wins, you win too. We design it, hang it, and take it down.</p>
    {_countdown()}
    <div class="gw-video">{video}</div>

    <div class="gw-card" id="enter">
      <h2 class="gw-card-title" data-gw-card-title>Enter in 20 seconds</h2>
      <p class="gw-card-sub" data-gw-card-sub>One entry per household. Homes inside the circle only (about {G['radius_mi']} miles around Delano).</p>
      {_entry_form()}
      {_panels()}
    </div>
  </div></section>

  <section class="gw-check" id="check"><div class="gw-col">
    <h2>Already entered?</h2>
    <p>Check how many entries you have and grab your share link.</p>
    <form class="gw-check-form" data-gw-check novalidate>
      <input type="tel" name="phone" inputmode="tel" autocomplete="tel" required maxlength="25" placeholder="Your mobile number" aria-label="Your mobile number">
      <button type="submit" class="btn">Check</button>
    </form>
    <p class="gw-err" data-gw-check-error role="alert" hidden></p>
    <div class="gw-check-result" data-gw-check-result hidden>
      <p class="gw-check-count">Hi <span data-gw-name></span>! You have <span class="gw-count" data-gw-entries>1</span> <span data-gw-entries-word>entry</span>.</p>
      <div class="gw-share">
        <label class="gw-share-label" for="gw-check-url">Your share link</label>
        <div class="gw-share-row"><input id="gw-check-url" readonly data-gw-share-url><button type="button" class="btn gw-copy" data-gw-copy>Copy</button></div>
        <div class="gw-share-btns">
          <button type="button" class="btn btn-ghost" data-gw-native hidden>Share</button>
          <a class="btn btn-ghost" data-gw-sms href="#">Text it</a>
          <a class="btn btn-ghost" data-gw-fb href="#" target="_blank" rel="noopener">Facebook</a>
        </div>
      </div>
    </div>
  </div></section>

  <section class="gw-how"><div class="gw-col">
    <h2>How it works</h2>
    <ol class="gw-steps">{step_html}</ol>
  </div></section>

  <section class="gw-value"><div class="gw-col">
    <h2>The best-looking house on the street. Zero work.</h2>
    <figure class="gw-value-photo">{C.picture(root, photo, _alt(photo), sizes="(max-width: 700px) 100vw, 640px", extra_attrs='loading="lazy" decoding="async"')}</figure>
    <ul class="gw-perks">{perk_html}</ul>
  </div></section>

  <section class="gw-area-sec"><div class="gw-col">
    <h2>Anywhere inside the circle</h2>
    <p>If your home is within about {G['radius_mi']} miles of Delano, you&rsquo;re in: Buffalo, St.&nbsp;Michael, Rockford, Maple&nbsp;Grove, Plymouth, Wayzata, Orono, Mound, Minnetonka, Chanhassen, Victoria, Waconia, Watertown and everything in between. The form checks your address for you.</p>
    {_area_map()}
    <p class="gw-out-link">Outside the circle? <a href="tel:{BIZ['phone_href']}">Call or text {BIZ['phone_display']}</a> for a regular quote.</p>
  </div></section>
</main>
{js}
{_lp_end(root)}"""
    return html


# ---------------------------------------------------------------------------
def giveaway_rules_page(depth=0, seo_title=None, schema=None):
    """The official rules. Plain, complete, printable. Have a lawyer review
    once before launch (rules vary by state; see docs/GIVEAWAY.md)."""
    seo_title = seo_title or (lambda s: s)
    root = C.rel(depth)
    css, _ = _assets(depth)
    n = WINNERS
    html = C.head(title=seo_title(f"Official Rules, {G['name']}"),
                  desc=f"Official rules for the Barta Window Washing {G['name']} {G['year']}.",
                  slug="giveaway-rules.html", depth=depth, schema=schema, noindex=True, extra_head=css)
    html += _lp_header(root, rules=True)
    sponsor = (f"{BIZ['legal_name']} (&ldquo;Barta Window Washing&rdquo; or &ldquo;Sponsor&rdquo;), "
               f"{BIZ['street']}, {BIZ['city']}, {BIZ['state']} {BIZ['zip']}, {BIZ['phone_display']}")
    max_prizes = n * 2
    html += f"""<main id="main" class="gw-rules"><div class="container container-narrow">
  <h1>{G['name']} {G['year']}: Official Rules</h1>
  <p class="gw-rules-lede"><strong>NO PURCHASE NECESSARY TO ENTER OR WIN. A PURCHASE WILL NOT INCREASE YOUR CHANCES OF WINNING. VOID WHERE PROHIBITED.</strong></p>

  <h2>1. Sponsor</h2>
  <p>The {G['name']} (the &ldquo;Giveaway&rdquo;) is sponsored by {sponsor}.</p>

  <h2>2. Who can enter</h2>
  <p>Open only to legal residents of Minnesota who are 18 or older at the time of entry and who own, or have the owner&rsquo;s written permission to decorate, a single-family home or townhome located within {G['radius_mi']} straight-line miles of Delano, MN (the &ldquo;Service Area&rdquo;). Sponsor checks each address when it is entered and may verify eligibility before awarding a prize. Employees of Sponsor and members of their immediate families and households are not eligible.</p>

  <h2>3. Entry period</h2>
  <p>The Giveaway begins {G['starts']} and ends {G['closes']} (the &ldquo;Entry Period&rdquo;). Sponsor&rsquo;s server clock is the official timekeeper.</p>

  <h2>4. How to enter</h2>
  <p>Visit <a href="/giveaway">bartawindowwashing.com/giveaway</a> and complete the entry form with your first and last name, mobile phone number and home address, and agree to receive giveaway text messages. Limit one (1) entry per person and per household (same address). Entries that are incomplete, duplicated, from outside the Service Area, or submitted by automated means are void.</p>

  <h2>5. Bonus entries</h2>
  <p>Each entrant receives a personal share link. Each eligible person who enters through your link during the Entry Period earns you one (1) bonus entry. There is no limit on bonus entries. Entries from your own household, or from fake, duplicate or ineligible people, don&rsquo;t count, and Sponsor may disqualify anyone who tampers with the entry process.</p>

  <h2>6. Prizes</h2>
  <p><strong>Grand prize ({n}):</strong> {n} grand prize winners will each receive one professional Christmas light installation at the winner&rsquo;s eligible home for the {G['year']} holiday season, including design, lights for the season, installation and takedown after the holidays. Approximate retail value (&ldquo;ARV&rdquo;): up to {PRIZE} each. Sponsor determines the design and scope of the installation to fit within the ARV; if a winner wants more than that, the winner may pay the difference at Sponsor&rsquo;s regular prices. The installation will be scheduled at a mutually agreed time and completed by {G['install_by']}, weather permitting.</p>
  <p><strong>Friend bonus prize:</strong> if a grand prize winner entered through another entrant&rsquo;s share link, that entrant also wins one installation as described above (same ARV). As a result, up to {max_prizes} installations may be awarded in total (total ARV up to ${G['prize_value'] * max_prizes:,}).</p>
  <p><strong>Entrant offer (not a prize):</strong> every eligible entrant who does not win and who opted in to offer texts will be offered {COUPON} off a Christmas light installation from Sponsor for the {G['year']} season. The offer must be claimed by {G['claim_by']} using the link Sponsor texts, and the installation must be booked by {G['coupon_book_by']}. One per household; not redeemable for cash; can&rsquo;t be combined with other offers.</p>
  <p>Prizes are not transferable and have no cash value. No substitution except by Sponsor, which may substitute a prize of equal or greater value if necessary. Winners are responsible for any taxes; a winner receiving $600 or more in prizes may be asked for a completed IRS Form W-9 and will receive a Form 1099.</p>

  <h2>7. Drawing and odds</h2>
  <p>Grand prize winners will be selected in a random drawing on or about {G['draw']}, at approximately {G['draw_time']}, from all eligible entries received, weighted so each entry counts once. Sponsor plans to stream the drawing live on its Facebook page. Odds of winning depend on the number of eligible entries received and on how many entries each entrant has.</p>

  <h2>8. Winner notification</h2>
  <p>Potential winners will be contacted by phone and/or text message within 24 hours of the drawing. A potential winner must respond within 72 hours of the first contact attempt and confirm eligibility, or the prize may be forfeited and an alternate winner selected by random drawing from the remaining eligible entries.</p>

  <h2>9. Text messages</h2>
  <p>To enter, you agree to receive text messages from Sponsor at the number you provide about this Giveaway: your entry confirmation and share link, up to two reminders, the drawing results, and replies to messages you send. Separately and optionally, you may also agree to receive the entrant offer in section 6 after the drawing and a few promotional offers a year; that consent is not required to enter or win. Message and data rates may apply. Reply STOP to opt out at any time or HELP for help. Opting out does not remove your entry.</p>

  <h2>10. Privacy</h2>
  <p>Sponsor collects your name, phone number and address to run the Giveaway, contact entrants and winners, and offer its services, as described in its <a href="{root}privacy.html">Privacy Policy</a>. Sponsor does not sell your information.</p>

  <h2>11. Publicity</h2>
  <p>Except where prohibited, accepting a prize constitutes permission for Sponsor to use the winner&rsquo;s first name, last initial, city, and photos of the installed display for promotional purposes without further compensation.</p>

  <h2>12. General conditions</h2>
  <p>By entering, entrants agree to these Official Rules and to Sponsor&rsquo;s decisions, which are final. Sponsor may cancel, suspend or modify the Giveaway if fraud, technical failure or any other factor impairs its integrity, and in that event may select winners from eligible entries received before the action. Sponsor is not responsible for lost, late, incomplete or misdirected entries, or for text messages that are not delivered. To the extent permitted by law, entrants release Sponsor from liability for any injury, loss or damage arising from participation or from acceptance or use of a prize, except for Sponsor&rsquo;s own negligence in performing the installation. This Giveaway is governed by the laws of Minnesota. It is in no way sponsored, endorsed or administered by, or associated with, Facebook or any other social network.</p>

  <h2>13. Winners list</h2>
  <p>For the first name, last initial and city of the winners, call or text {BIZ['phone_display']} or email <a href="mailto:{BIZ['email']}">{BIZ['email']}</a> after {G['draw']}.</p>

  <p class="gw-rules-back"><a class="btn" href="/giveaway">Back to the giveaway {icon('arrow')}</a></p>
</div></main>
{_lp_end(root)}"""
    return html


# ---------------------------------------------------------------------------
def giveaway_admin_page(depth=1, seo_title=None):
    """Office dashboard: stats, the drawing, the text broadcasts, every
    entrant. No site chrome, no analytics; the real protection is the admin
    key the API checks on every request."""
    seo_title = seo_title or (lambda s: s)
    css, js = _assets(depth, "giveaway-admin")
    html = C.head(title=seo_title(f"{G['name']} dashboard"), desc="Office dashboard.",
                  slug="admin/giveaway.html", depth=depth, noindex=True, extra_head=css, analytics=False)
    html += f"""<main class="gwa" data-api="/api/giveaway/admin" data-coupon="{G['coupon']}">
  <header class="gwa-top">
    <div class="gwa-brand"><strong>{G['name']}</strong><span>Office dashboard</span></div>
    <div class="gwa-top-actions" data-gwa-authed hidden>
      <button class="gwa-btn gwa-btn-ghost" data-gwa-refresh>Refresh</button>
      <button class="gwa-btn gwa-btn-ghost" data-gwa-csv>Export CSV</button>
      <button class="gwa-btn gwa-btn-ghost" data-gwa-logout>Sign out</button>
    </div>
  </header>

  <section class="gwa-login" data-gwa-login>
    <form data-gwa-login-form>
      <h1>Sign in</h1>
      <p>Enter the admin key (the same one you use for the referral dashboard).</p>
      <input type="password" name="key" autocomplete="current-password" required placeholder="Admin key">
      <button class="gwa-btn" type="submit">Open dashboard</button>
      <p class="gwa-err" data-gwa-login-error hidden></p>
    </form>
  </section>

  <div class="gwa-body" data-gwa-body hidden>
    <section class="gwa-stats" data-gwa-stats></section>

    <section class="gwa-card">
      <div class="gwa-card-head"><h2>Entries per day</h2><span class="gwa-sub" data-gwa-chart-sub></span></div>
      <div data-gwa-chart></div>
    </section>

    <section class="gwa-card">
      <div class="gwa-card-head"><h2>Top sharers</h2><span class="gwa-sub">Most entries from their link</span></div>
      <div data-gwa-leaders></div>
    </section>

    <section class="gwa-card">
      <div class="gwa-card-head"><h2>Drawing</h2><span class="gwa-sub" data-gwa-draw-when></span></div>
      <div data-gwa-draw></div>
    </section>

    <section class="gwa-card">
      <div class="gwa-card-head"><h2>Texts</h2><span class="gwa-sub" data-gwa-sms-state></span></div>
      <div class="gwa-broadcasts" data-gwa-broadcasts></div>
    </section>

    <section class="gwa-card">
      <div class="gwa-card-head"><h2>Entrants</h2>
        <input class="gwa-search" type="search" placeholder="Search name, phone, city…" data-gwa-search>
      </div>
      <div class="gwa-list" data-gwa-list></div>
    </section>

    <section class="gwa-card">
      <div class="gwa-card-head"><h2>Outside the area, asked for a quote</h2></div>
      <div class="gwa-list" data-gwa-outside></div>
    </section>

    <section class="gwa-card gwa-danger">
      <div class="gwa-card-head"><h2>Reset</h2></div>
      <p>Clears every entrant, share link and the drawing from this site (for wiping test entries before launch). Rotor leads are not touched.</p>
      <button class="gwa-btn gwa-btn-danger" data-gwa-wipe>Delete all giveaway data</button>
    </section>
  </div>
  <div class="gwa-toast" data-gwa-toast role="status" hidden></div>
</main>
{js}
</body>
</html>"""
    return html
