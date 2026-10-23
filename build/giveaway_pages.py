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
    logo = C._brand_logo(root, "(max-width: 760px) 120px, 150px", 150, 41, xmas=True)
    return f"""<header class="gw-lp-top"><div class="container gw-lp-top-row">
  <span class="gw-lp-brand">{logo}</span>
  {right}
</div></header>"""


def _lp_end(root):
    """Minimal footer: who runs it, the legal links the rules need, and the
    site script (address autocomplete, reveal animations). No site nav,
    no call bar."""
    return f"""<footer class="gw-lp-foot"><div class="container">
  <p>{BIZ['name']} &middot; {BIZ['city']}, {BIZ['state']} &middot; <a href="tel:{BIZ['phone_href']}">{BIZ['phone_display']}</a></p>
  <p class="gw-lp-legal">No purchase necessary to enter or win; a purchase won&rsquo;t improve your chances. Open to legal
     Minnesota residents 18 and older with a home inside the map area. Entries close {G['closes'].replace(' Central Time', ' CT')};
     drawing {G['draw']}. Void where prohibited. Not sponsored, endorsed or administered by Facebook or Instagram.
     See the <a href="/giveaway/rules">Official Rules</a>.</p>
</div></footer>
<script src="{root}assets/js/main.min.js?v={C.ASSET_VER}" defer></script>
</body>
</html>"""


def _alt(src):
    alt = G.get("photo_alts", {}).get(src) or XMAS_PHOTO_ALT.get(src)
    return C._esc(alt or "A home lit up with Christmas lights installed by Barta")


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
          <div class="field"><label for="gw-name">Your name</label><input id="gw-name" name="name" autocomplete="name" required maxlength="120"></div>
          <div class="field"><label for="gw-phone">Mobile number</label><input id="gw-phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" required maxlength="25"></div>
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
            <span><strong>Text me about the giveaway.</strong> My entry confirmation, up to two reminders, the results, and replies to my texts. Msg &amp; data rates may apply. Reply STOP to opt out, HELP for help.</span></label>
          <label class="check gw-consent"><input type="checkbox" name="offers">
            <span><strong>Yes, send me my {COUPON} off coupon.</strong> If I don&rsquo;t win, text me {COUPON} off a Christmas light install after the drawing, plus a few offers a year. Reply STOP anytime.</span></label>
          <p class="gw-err" data-gw-error role="alert" hidden></p>
          <button type="submit" class="btn btn-lg btn-block gw-submit">Enter the giveaway {icon('arrow')}</button>
          <p class="gw-legal">No purchase necessary. Ends {G['closes'].split(' at ')[0].split(', ', 1)[1]}.
            <a href="/giveaway/rules">Official rules</a> &middot; <a href="/privacy.html">Privacy</a> &middot; <a href="/terms.html">SMS terms</a></p>
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
          <p>The giveaway is only open to homes inside the circle on the map, so we can&rsquo;t enter you. But we&rsquo;d still be glad to give you a quick, free quote on Christmas lights if we can make it out your way.</p>
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
          <p>Winners are drawn {G['draw']}. If you entered, keep an eye on your texts.</p>
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
    """A big countdown block: to entries closing, then to the drawing."""
    unit = lambda k, label: (f'<span class="gw-timer-unit"><b data-cd="{k}">--</b><small>{label}</small></span>')
    return f"""<div class="gw-timer" data-gw-countdown role="timer" aria-live="off">
          <p class="gw-timer-head"><span class="gw-dot" aria-hidden="true"></span><span data-gw-cd-label>Entries close in</span></p>
          <div class="gw-timer-units">{unit('d', 'days')}{unit('h', 'hours')}{unit('m', 'min')}{unit('s', 'sec')}</div>
          <p class="gw-timer-when">Winners drawn {G['draw_short']} at 6pm</p>
        </div>"""


def _lock_head():
    """Runs before first paint: a visitor who already unlocked this browser
    skips the gate (no flash of the Coming soon screen)."""
    h = G.get("lock_sha256")
    if not h:
        return ""
    return ('<script>(function(){try{if(localStorage.getItem("gw-unlock")==="' + h +
            '")document.documentElement.classList.add("gw-open")}catch(e){}})();</script>\n')


def _lock_gate():
    """Pre-launch gate: a Coming soon screen, and a password box below it.
    The password is checked in the browser against its SHA-256 (sitedata
    GIVEAWAY["lock_sha256"]), so it keeps casual visitors out until launch;
    it isn't account-grade security. Remove the hash to open the page."""
    h = G.get("lock_sha256")
    if not h:
        return ""
    return f"""<div class="gw-gate" data-gw-gate data-hash="{h}">
  <section class="gw-gate-hero"><div class="gw-col">
    <span class="gw-eyebrow">{G['name']}</span>
    <h1>Coming <em>soon.</em></h1>
    <p class="gw-hook">Something merry is headed to the West Metro. Check back shortly.</p>
    <a class="gw-gate-scroll" href="#gw-unlock" aria-label="Scroll to the password box"><span>Have the password?</span>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></a>
  </div></section>
  <section class="gw-gate-pass" id="gw-unlock"><div class="gw-col">
    <form class="gw-card gw-gate-card" data-gw-gate-form novalidate>
      <h2 class="gw-card-title">Have the password?</h2>
      <p class="gw-card-sub">Enter it to see the giveaway early.</p>
      <div class="field"><label for="gw-gate-pw">Password</label>
        <input id="gw-gate-pw" name="password" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" required></div>
      <p class="gw-err" data-gw-gate-error role="alert" hidden>That&rsquo;s not it. Check the spelling and try again.</p>
      <button type="submit" class="btn btn-lg btn-block gw-submit">Unlock {icon('arrow')}</button>
    </form>
  </div></section>
</div>
<script>(function(){{
  var g=document.querySelector("[data-gw-gate]"),f=g&&g.querySelector("[data-gw-gate-form]");
  if(!f)return;
  var err=f.querySelector("[data-gw-gate-error]"),inp=f.querySelector("input");
  function hex(b){{return Array.prototype.map.call(new Uint8Array(b),function(x){{return("0"+x.toString(16)).slice(-2)}}).join("")}}
  f.addEventListener("submit",function(e){{
    e.preventDefault();
    var v=(inp.value||"").toLowerCase().replace(/\\s+/g,"");
    if(!v||!window.crypto||!crypto.subtle){{err.hidden=false;return}}
    crypto.subtle.digest("SHA-256",new TextEncoder().encode(v)).then(function(d){{
      if(hex(d)!==g.getAttribute("data-hash")){{err.hidden=false;inp.select();return}}
      try{{localStorage.setItem("gw-unlock",g.getAttribute("data-hash"))}}catch(x){{}}
      document.documentElement.classList.add("gw-open");
      window.scrollTo(0,0);
    }});
  }});
  inp.addEventListener("input",function(){{err.hidden=true}});
}})();</script>
"""


def _area_map():
    """The giveaway circle: the same map as the intro reel (17 miles around
    Delano, every town inside labeled). Static image, rendered from Esri map
    tiles; its file hash rides on the URL because /assets/ is cached
    immutably. Tapping it opens Google Maps."""
    import hashlib, os
    base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    def ver(rel):
        with open(os.path.join(base, rel), "rb") as f:
            return hashlib.md5(f.read()).hexdigest()[:10]
    jpg, webp = "assets/img/giveaway-map.jpg", "assets/img/giveaway-map.webp"
    link = f"https://www.google.com/maps/@{BIZ['lat']},{BIZ['lng']},10z"
    alt = ("Map of the giveaway circle: 17 miles around Delano, covering Buffalo, Rockford, Montrose, Waverly, "
           "Howard Lake, Maple Lake, Albertville, St. Michael, Hanover, Rogers, Corcoran, Loretto, Medina, Maple Plain, "
           "Orono, Wayzata, Mound, Minnetrista, St. Bonifacius, Victoria, Waconia, Mayer, Watertown, Winsted and Lester Prairie")
    return f"""<figure class="gw-map">
      <a href="{link}" target="_blank" rel="noopener" aria-label="Open the area around Delano in Google Maps">
        <picture><source type="image/webp" srcset="/{webp}?v={ver(webp)}">
        <img src="/{jpg}?v={ver(jpg)}" width="1080" height="1080" alt="{alt}" loading="lazy" decoding="async"></picture>
      </a>
      <figcaption>Map: Esri, HERE, Garmin, &copy; OpenStreetMap contributors</figcaption>
    </figure>"""


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
                  noindex=True, extra_head=css + _lock_head(), og_image=G["hero_photo"])
    html += _lp_header(root)
    html += _lock_gate()

    if G.get("video"):
        # /assets/ is cached as immutable, so the file's hash rides on its URL:
        # re-exported under the same name, it is still fetched fresh.
        import hashlib, os
        vpath = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), G["video"])
        with open(vpath, "rb") as f:
            vfp = hashlib.md5(f.read()).hexdigest()[:10]
        video = (f'<video controls playsinline preload="metadata" poster="{root}{G["video_poster"]}" '
                 f'src="{root}{G["video"]}?v={vfp}"></video>')
    else:
        # Blank screen until the owner's video is ready (sitedata GIVEAWAY["video"]).
        video = ('<div class="gw-video-blank" aria-label="Video coming soon">'
                 '<span class="gw-play" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></span></div>')

    steps = [
        ("Sign up, get your link", "Name, number, address: about 20 seconds. Your own link pops up right away."),
        ("Send friends your link", "Friends enter in about 20 seconds. Each one is one more chance for you, and if they win, you win too."),
        ("We draw the winners", f"{G['draw_short']} at 6pm. Winners get a call from Alex."),
    ]
    step_html = "".join(
        f'<li class="gw-step"><span class="step-num {"xmas-red" if i % 2 == 0 else "xmas-green"}">{i + 1}</span>'
        f'<div><h3>{t}</h3><p>{d}</p></div></li>' for i, (t, d) in enumerate(steps))
    perks = [
        ("No ladders.", "We hang every light."),
        ("No tangled cords.", "Commercial-grade LEDs, cut to fit your house."),
        ("No dead bulbs.", "One goes out during the season? We fix it."),
        ("No January takedown in the cold.", "We take it all down after the holidays."),
    ]
    perk_html = "".join(f'<li>{icon("check-circle")}<div><strong>{t}</strong> <span>{d}</span></div></li>' for t, d in perks)
    lazy = 'loading="lazy" decoding="async"'

    def _ph(src, cls, sizes):
        return (f'<figure class="gw-photo {cls}">'
                f'{C.picture(root, src, _alt(src), sizes=sizes, extra_attrs=lazy)}</figure>')
    ph = G["photos"]
    photos_html = _ph(ph[0], "gw-photo--big", "(max-width: 700px) 100vw, 640px") + "".join(
        _ph(p, "gw-photo--half", "(max-width: 700px) 50vw, 320px") for p in ph[1:3])

    html += f"""<main id="main" class="gw-page" {_data_attrs()}>
  <section class="gw-top"><div class="gw-col">
    <span class="gw-eyebrow">West Metro Giveaway</span>
    <h1>We&rsquo;re giving away up to <em>{n_word}</em> free Christmas light installs.</h1>
    <p class="gw-hook"><strong>Free Christmas lights on your house, up to {PRIZE}.</strong>
      Share your link: if a friend wins, you win too. We design it, hang it, and take it down.</p>
    {_countdown()}
    {f'<p class="gw-watch">{icon("arrow")} Watch (1:40)</p>' if G.get('video') else ''}
    <div class="gw-video{' gw-video--tall' if G.get('video') else ''}">{video}</div>

    <div class="gw-card" id="enter">
      <h2 class="gw-card-title" data-gw-card-title>Enter in 20 seconds</h2>
      <p class="gw-card-sub" data-gw-card-sub>One entry per household. Homes inside the circle on the map only.</p>
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
    <div class="gw-photos">{photos_html}</div>
    <p class="gw-photos-note">Real Barta installs around the West Metro.</p>
    <ul class="gw-perks">{perk_html}</ul>
  </div></section>

  <section class="gw-area-sec"><div class="gw-col">
    <h2>Anywhere inside the circle</h2>
    <p>If your home is inside the circle, you can enter. It runs from Buffalo and St.&nbsp;Michael down to Waconia and Victoria, from Howard Lake over to Wayzata and Rogers, and every town in between. Enter your address and the form checks it for you.</p>
    {_area_map()}
    <p class="gw-out-link"><a href="/get-quote.html?svc=christmas-light-installation">Outside the circle? Get a regular quote &rarr;</a></p>
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
  <p>Open only to legal residents of Minnesota who are 18 or older at the time of entry and who own, or have the owner&rsquo;s written permission to decorate, a single-family home or townhome located inside the circle centered on Delano, MN shown on the map at bartawindowwashing.com/giveaway (the &ldquo;Service Area&rdquo;). Sponsor checks each address when it is entered and may verify eligibility before awarding a prize. Employees of Sponsor and members of their immediate families and households are not eligible.</p>

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
  <p>Grand prize winners will be selected in a random drawing on or about {G['draw']}, at approximately {G['draw_time']}, from all eligible entries received, weighted so each entry counts once. Odds of winning depend on the number of eligible entries received and on how many entries each entrant has.</p>

  <h2>8. Winner notification</h2>
  <p>Potential winners will be contacted by phone and/or text message within 24 hours of the drawing. A potential winner must respond within 72 hours of the first contact attempt and confirm eligibility, or the prize may be forfeited and an alternate winner selected by random drawing from the remaining eligible entries.</p>

  <h2>9. Text messages</h2>
  <p>To enter, you agree to receive text messages from Sponsor at the number you provide about this Giveaway: your entry confirmation and share link, up to two reminders, the drawing results, and replies to messages you send. Separately and optionally, you may also agree to receive the entrant offer in section 6 after the drawing and a few promotional offers a year; that consent is not required to enter or win. Message and data rates may apply. Reply STOP to opt out at any time or HELP for help. Opting out does not remove your entry.</p>

  <h2>10. Privacy</h2>
  <p>Sponsor collects your name, phone number and address to run the Giveaway, contact entrants and winners, and offer its services, as described in its <a href="{root}privacy.html">Privacy Policy</a>. Sponsor does not sell your information.</p>

  <h2>11. Publicity</h2>
  <p>Except where prohibited, accepting a prize constitutes permission for Sponsor to use the winner&rsquo;s first name, last initial, city, and photos of the installed display for promotional purposes without further compensation.</p>

  <h2>12. General conditions</h2>
  <p>By entering, entrants agree to these Official Rules and to Sponsor&rsquo;s decisions, which are final. Sponsor may cancel, suspend or modify the Giveaway if fraud, technical failure or any other factor impairs its integrity, and in that event may select winners from eligible entries received before the action. Sponsor is not responsible for lost, late, incomplete or misdirected entries, or for text messages that are not delivered. To the extent permitted by law, entrants release Sponsor from liability for any injury, loss or damage arising from participation or from acceptance or use of a prize, except for Sponsor&rsquo;s own negligence in performing the installation. This Giveaway is governed by the laws of Minnesota. It is in no way sponsored, endorsed or administered by, or associated with, Facebook, Instagram or any other social network.</p>

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
      <p class="gwa-sub">Tap anyone to call or text them, edit their details or coupon status, add a note, or delete them.</p>
      <div class="gwa-filters" data-gwa-filters></div>
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
