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


def _alt(src):
    return C._esc(XMAS_PHOTO_ALT.get(src, "A home lit up with Christmas lights installed by Barta"))


def _data_attrs():
    return (f'data-closes="{G["closes_iso"]}" data-draw="{G["draw_iso"]}" data-coupon="{G["coupon"]}" '
            f'data-prize="{G["prize_value"]}" data-prefix="{G["code_prefix"]}" '
            f'data-phone="{BIZ["phone_display"]}" data-phone-href="{BIZ["phone_href"]}" '
            f'data-draw-label="{G["draw_short"]}"')


def _entry_form():
    """Three boxes (name, mobile, address) plus the texting consent. Posts to
    /api/giveaway from giveaway.js. The address field reuses main.js's
    Nominatim autocomplete (data-address-* hooks), which also fills the
    hidden lat/lng the service-area check reads."""
    return f"""<form class="gw-form" data-gw-form novalidate>
          <div class="gw-invite" data-gw-invite hidden>{icon('gift')} <span data-gw-invite-text></span></div>
          <div class="form-row">
            <div class="field"><label for="gw-first">First name</label><input id="gw-first" name="first_name" autocomplete="given-name" required maxlength="60" placeholder="Jane"></div>
            <div class="field"><label for="gw-last">Last name</label><input id="gw-last" name="last_name" autocomplete="family-name" required maxlength="60" placeholder="Doe"></div>
          </div>
          <div class="field"><label for="gw-phone">Mobile number</label><input id="gw-phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" required maxlength="25" placeholder="(763) 555-0123"></div>
          <div class="field addr-field"><label for="gw-address">Home address</label>
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
            <span>Text me about this giveaway: my entry link and count, the drawing results, and the {COUPON}-off offer for entrants who don&rsquo;t win.</span></label>
          <p class="gw-err" data-gw-error role="alert" hidden></p>
          <button type="submit" class="btn btn-lg btn-block gw-submit">Enter the giveaway {icon('arrow')}</button>
          <p class="gw-legal">No purchase necessary. Msg &amp; data rates may apply; reply STOP to opt out. <a href="/giveaway/rules">See official rules.</a></p>
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
          <p class="gw-fine" data-gw-status-wrap>Save your private link to check your entries any time: <a data-gw-status href="#">my entries</a>. We texted it to you too.</p>
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
            <p>We&rsquo;d still love to light up your home. <a href="/services/christmas-light-installation.html?quote=1">Get a free quote</a>.</p>
          </div>
        </div>
        <div class="gw-panel" data-gw-panel="notfound" hidden>
          <h2 class="gw-panel-title">We couldn&rsquo;t find that entry link.</h2>
          <p>Double-check the link from your text, or call or text us at <a href="tel:{BIZ['phone_href']}">{BIZ['phone_display']}</a>.</p>
        </div>"""


def _countdown():
    return """<div class="gw-countdown" data-gw-countdown role="timer" aria-live="off">
            <span class="gw-cd-label" data-gw-cd-label>Drawing in</span>
            <span class="gw-cd-unit"><b data-cd="d">--</b><small>days</small></span>
            <span class="gw-cd-unit"><b data-cd="h">--</b><small>hrs</small></span>
            <span class="gw-cd-unit"><b data-cd="m">--</b><small>min</small></span>
            <span class="gw-cd-unit"><b data-cd="s">--</b><small>sec</small></span>
          </div>"""


def giveaway_page(depth=0, seo_title=None, schema=None):
    seo_title = seo_title or (lambda s: s)
    root = C.rel(depth)
    css, js = _assets(depth)
    title = f"Win Free Christmas Lights, {G['name']}"
    desc = (f"Enter Barta Window Washing's {G['name']}: {WORDS.get(WINNERS, WINNERS)} homes win a professional "
            f"Christmas light installation (up to {PRIZE} each). Drawing {G['draw']}. No purchase necessary.")
    html = C.head(title=seo_title(title), desc=desc, slug="giveaway.html", depth=depth, schema=schema,
                  noindex=True, extra_head=css, og_image=G["hero_photo"])
    html += C.nav(depth, xmas=True)

    video = ""
    if G.get("video"):
        video = (f'<div class="gw-video"><video controls playsinline preload="metadata" '
                 f'poster="{root}{G["video_poster"]}" src="{root}{G["video"]}"></video></div>')

    steps = [
        ("Enter in 30 seconds", "Name, mobile number and home address. That&rsquo;s it."),
        ("Share your link", "Every friend who enters through your link adds an entry for you. If they win, you both win."),
        (f"Watch the drawing {G['draw_short']}",
         f"We draw {WORDS.get(WINNERS, WINNERS)} winners live on Facebook. Everyone else gets {COUPON} off a light install."),
    ]
    step_html = "".join(
        f'<li class="gw-step reveal" data-delay="{i}"><span class="step-num {"xmas-red" if i % 2 == 0 else "xmas-green"}">{i + 1}</span>'
        f'<div><h3>{t}</h3><p>{d}</p></div></li>' for i, (t, d) in enumerate(steps))
    photos = "".join(
        f'<figure class="gw-photo reveal" data-delay="{i}">'
        + C.picture(root, src, _alt(src), sizes="(max-width: 760px) 100vw, 33vw", extra_attrs='loading="lazy" decoding="async"')
        + "</figure>" for i, src in enumerate(G["photos"]))

    faqs = [
        ("Who can enter?",
         f"Adults 18+ who own (or have the owner&rsquo;s OK to decorate) a home within about {G['radius_mi']} miles of Delano: "
         "the west metro and surrounding towns we serve. One entry per household, plus a bonus entry for every friend who enters with your link."),
        ("What exactly do I win?",
         f"A professional Christmas light installation for the {G['year']} season at your home, worth up to {PRIZE}: "
         "we design it, supply the lights, hang them, and take everything down after the holidays."),
        ("How does &ldquo;you both win&rdquo; work?",
         "When you enter, you get your own share link. If a friend enters through it and their name is drawn, "
         "you win a free installation too. Each friend who enters through your link also adds one entry for you."),
        (f"What if I don&rsquo;t win?",
         f"Everyone who enters and doesn&rsquo;t win gets {COUPON} off a Christmas light installation this season. "
         f"We&rsquo;ll text you the offer right after the drawing; it&rsquo;s good for 72 hours."),
        ("Do I have to buy anything?",
         "No. No purchase is necessary to enter or win, and buying something won&rsquo;t improve your chances."),
    ]

    html += f"""<main id="main" class="gw-page" {_data_attrs()}>
  <section class="gw-hero">
    <div class="gw-hero-bg" aria-hidden="true">
      {C.picture(root, G['hero_photo'], '', img_class='gw-hero-img', sizes='100vw',
                 extra_attrs='loading="eager" fetchpriority="high" decoding="async"')}
    </div>
    <div class="container gw-hero-grid">
      <div class="gw-hero-copy">
        <span class="gw-eyebrow">{icon('gift')} {G['name']} &middot; Drawing {G['draw_short']}</span>
        <h1>Win free Christmas lights for your house.</h1>
        <p class="lead">We&rsquo;re giving away <strong>{WORDS.get(WINNERS, WINNERS)} professional light installs</strong>, up to {PRIZE} each, to homes in the west metro. Enter in 30 seconds, then share your link for more chances.</p>
        <a class="btn btn-lg gw-jump" href="#enter">Enter to win {icon('arrow')}</a>
        {_countdown()}
        {video}
        <ul class="gw-proof">
          <li>{icon('star')} {BIZ['rating']} stars, {BIZ['review_count']}+ Google reviews</li>
          <li>{icon('award')} Best of Delano Area 2026</li>
          <li>{icon('shield')} Family-owned &amp; fully insured</li>
        </ul>
      </div>
      <div class="gw-card" id="enter">
        <h2 class="gw-card-title" data-gw-card-title>Enter to win</h2>
        {_entry_form()}
        {_panels()}
      </div>
    </div>
  </section>

  <section class="gw-how"><div class="container">
    <div class="section-head center">
      <span class="eyebrow">How it works</span>
      <h2>Enter. Share. Friend wins, you both win.</h2>
    </div>
    <ol class="gw-steps">{step_html}</ol>
  </div></section>

  <section class="gw-prize"><div class="container">
    <div class="section-head center">
      <span class="eyebrow">The prize</span>
      <h2>A done-for-you light display, worth up to {PRIZE}</h2>
      <p>Custom design, commercial-grade lights, professional install and January takedown. No ladders, no tangled strands. These are a few homes we lit up last season.</p>
    </div>
    <div class="gw-photos">{photos}</div>
  </div></section>

  <section class="bg-mist"><div class="container">
    <div class="section-head center">
      <span class="eyebrow">Questions</span>
      <h2>The short version of the rules</h2>
    </div>
    {C.faq_block(faqs)}
    <p class="center gw-rules-link"><strong>No purchase necessary.</strong> <a href="/giveaway/rules">Read the official rules</a>.</p>
  </div></section>

  <section class="gw-final"><div class="container center">
    <h2>Your house could be the one everyone drives by to see.</h2>
    <a class="btn btn-lg" href="#enter">Enter the giveaway {icon('arrow')}</a>
  </div></section>
</main>
{js}
{C.page_end(depth, xmas=True)}"""
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
    html += C.nav(depth, xmas=True)
    crumbs = C.crumbs([("Home", root + "index.html"), (G["name"], "/giveaway"), ("Official Rules", None)])
    sponsor = (f"{BIZ['legal_name']} (&ldquo;Barta Window Washing&rdquo; or &ldquo;Sponsor&rdquo;), "
               f"{BIZ['street']}, {BIZ['city']}, {BIZ['state']} {BIZ['zip']}, {BIZ['phone_display']}")
    max_prizes = n * 2
    html += f"""<main id="main" class="gw-rules"><div class="container container-narrow">
  {crumbs}
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
  <p><strong>Entrant offer (not a prize):</strong> every eligible entrant who does not win will be offered {COUPON} off a Christmas light installation from Sponsor for the {G['year']} season. The offer must be claimed by {G['claim_by']} using the link Sponsor texts, and the installation must be booked by {G['coupon_book_by']}. One per household; not redeemable for cash; can&rsquo;t be combined with other offers.</p>
  <p>Prizes are not transferable and have no cash value. No substitution except by Sponsor, which may substitute a prize of equal or greater value if necessary. Winners are responsible for any taxes; a winner receiving $600 or more in prizes may be asked for a completed IRS Form W-9 and will receive a Form 1099.</p>

  <h2>7. Drawing and odds</h2>
  <p>Grand prize winners will be selected in a random drawing on or about {G['draw']}, at approximately {G['draw_time']}, from all eligible entries received, weighted so each entry counts once. Sponsor plans to stream the drawing live on its Facebook page. Odds of winning depend on the number of eligible entries received and on how many entries each entrant has.</p>

  <h2>8. Winner notification</h2>
  <p>Potential winners will be contacted by phone and/or text message within 24 hours of the drawing. A potential winner must respond within 72 hours of the first contact attempt and confirm eligibility, or the prize may be forfeited and an alternate winner selected by random drawing from the remaining eligible entries.</p>

  <h2>9. Text messages</h2>
  <p>By entering, you agree to receive text messages from Sponsor at the number you provide about this Giveaway: your entry link and entry count, a reminder before the drawing, the drawing results, and the entrant offer in section 6 (about 3 to 6 messages in total). Message and data rates may apply. Reply STOP to opt out at any time or HELP for help. Opting out does not remove your entry.</p>

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
{C.page_end(depth, xmas=True)}"""
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
