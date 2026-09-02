"""Customer-facing pages of the referral app.

  referral_page() -> public/index.html   program page + form + private dashboard (?t=TOKEN)
  friend_page()   -> public/friend.html  what a referred friend lands on (/r/CODE), with the claim form

Both use the app chrome (chrome.head / header / footer) over a snapshot of
the website's design system; page-specific rules live in
public/assets/css/app.css and behaviour in public/assets/js/app.js.
"""
import chrome as C
from icons import icon
from config import BIZ, REFERRAL, SERVICES

# Every number printed on these pages comes from config.REFERRAL so the
# offer can be changed in one place (mirror netlify/lib/referral-config.mjs).
FRIEND_OFF = REFERRAL["friend_discount"]
CREDIT = REFERRAL["referrer_credit"]
GIFT = REFERRAL["referrer_gift_card"]
PREFIX = REFERRAL["code_prefix"]
MAX_FRIENDS = REFERRAL["max_friends"]


def _assets():
    """The app's own stylesheet and script. C.ASSET_VER is stamped by
    build.py just before the pages render, so it is read per call."""
    css = f"/assets/css/app.css?v={C.ASSET_VER}"
    js = f'<script src="/assets/js/app.js?v={C.ASSET_VER}" defer></script>'
    return css, js


def _offer_attrs():
    """The offer as data attributes on <main>. app.js builds its share texts,
    validation messages and dashboard labels from these, so the script never
    carries a dollar amount of its own."""
    return (f'data-friend-off="{FRIEND_OFF}" data-credit="{CREDIT}" data-gift="{GIFT}" '
            f'data-prefix="{PREFIX}" data-max-friends="{MAX_FRIENDS}" '
            f'data-phone="{BIZ["phone_display"]}" data-email="{BIZ["email"]}" data-biz="{C.esc(BIZ["name"])}"')


def _trust_list():
    return f"""<ul class="hero-trust">
          <li>{icon('star')} {BIZ['rating']}&#9733; Google rating</li>
          <li>{icon('shield')} Fully insured</li>
          <li>{icon('house')} Family-owned in {BIZ['city']}</li>
        </ul>"""


def _friend_row(n):
    """One "who are you referring?" block. n numbers the ids and labels; the
    <template> copy passes the literal "__N__", which app.js swaps for a
    fresh number each time it clones a row, so ids stay unique however many
    rows are added and removed."""
    p = f"ref-f{n}"
    return f"""<fieldset class="ref-friend" data-friend>
          <legend>Friend <span data-friend-num>{n}</span></legend>
          <button type="button" class="ref-remove" data-remove-friend aria-label="Remove friend {n}">{icon('x')}<span>Remove</span></button>
          <div class="form-row">
            <div class="field"><label for="{p}-first">First name</label><input type="text" id="{p}-first" name="friend_first_name" data-field="first_name" autocomplete="off" maxlength="60" required placeholder="Jane"></div>
            <div class="field"><label for="{p}-last">Last name <span class="label-hint">(optional)</span></label><input type="text" id="{p}-last" name="friend_last_name" data-field="last_name" autocomplete="off" maxlength="60" placeholder="Doe"></div>
          </div>
          <div class="form-row">
            <div class="field"><label for="{p}-phone">Mobile phone</label><input type="tel" id="{p}-phone" name="friend_phone" data-field="phone" data-ref-phone inputmode="tel" autocomplete="off" required placeholder="(763) 555-0101"></div>
            <div class="field"><label for="{p}-email">Email <span class="label-hint">(optional)</span></label><input type="email" id="{p}-email" name="friend_email" data-field="email" autocomplete="off" maxlength="120" placeholder="jane@email.com"></div>
          </div>
          <div class="field"><label for="{p}-address">Their address <span class="label-hint">(optional, helps us quote faster)</span></label><input type="text" id="{p}-address" name="friend_address" data-field="address" autocomplete="off" maxlength="200" placeholder="123 Main St, Delano"></div>
          <div class="field"><label for="{p}-note">Anything we should know? <span class="label-hint">(optional)</span></label><input type="text" id="{p}-note" name="friend_note" data-field="note" autocomplete="off" maxlength="500" placeholder="Neighbor, two-story house, best after 5pm"></div>
        </fieldset>"""


def _reward_cards():
    """Credit vs gift card, as the same selectable cards the website's quote
    wizard uses for plan frequency (.promo-card.select-card). Credit is
    pre-selected: it is the option most customers pick, and a required radio
    group with nothing checked is a needless extra step."""
    return f"""<div class="ref-rewards" role="radiogroup" aria-labelledby="ref-g3-title" aria-describedby="ref-g3-sub">
          <label class="promo-card select-card popular ref-reward">
            <input type="radio" name="reward_pref" value="credit" id="ref-reward-credit" checked required>
            <span class="promo-badge">Most popular</span>
            <span class="ref-reward-ic">{icon('dollar')}</span>
            <span class="promo-name">Account credit</span>
            <span class="promo-price">${CREDIT}</span>
            <span class="promo-per">toward your next service</span>
            <span class="ref-reward-desc">Applied to your account automatically and taken off your next invoice, nothing to remember.</span>
          </label>
          <label class="promo-card select-card ref-reward">
            <input type="radio" name="reward_pref" value="giftcard" id="ref-reward-giftcard" required>
            <span class="ref-reward-ic">{icon('gift')}</span>
            <span class="promo-name">Gift card</span>
            <span class="promo-price">${GIFT}</span>
            <span class="promo-per">yours to spend anywhere</span>
            <span class="ref-reward-desc">Texted or mailed to you once your friend&rsquo;s first service is complete.</span>
          </label>
        </div>
        <p class="ref-err" id="ref-reward-err" hidden></p>"""


def _share_block(prefix_id, dash=False):
    """Share code + copy-able link + one-tap text/email buttons. Used twice,
    on the success panel and on the private dashboard, so both stay
    identical; prefix_id keeps their ids apart for app.js."""
    extra = " ref-share--dash" if dash else ""
    actions = ""
    if dash:
        actions = f"""
          <div class="ref-share-actions">
            <a class="btn" id="{prefix_id}-sms" href="sms:?&amp;body=">{icon('phone')} Text a friend</a>
            <a class="btn btn-ghost" id="{prefix_id}-email" href="mailto:?subject=&amp;body=">{icon('mail')} Email a friend</a>
          </div>"""
    return f"""<div class="ref-share{extra}">
          <span class="ref-share-label">Your share code</span>
          <strong class="ref-code" id="{prefix_id}-code"></strong>
          <div class="ref-share-url">
            <label class="sr-only" for="{prefix_id}-url">Your share link</label>
            <input type="text" id="{prefix_id}-url" readonly value="">
            <button type="button" class="btn btn-ghost ref-copy" id="{prefix_id}-copy" data-copy="#{prefix_id}-url">{icon('clipboard')} Copy</button>
          </div>
          <span class="ref-copy-status" id="{prefix_id}-copy-status" aria-live="polite"></span>{actions}
        </div>"""


def _fallback(what="add your referrals by hand"):
    """Shown by app.js when the API is unreachable or answers 5xx: a way to
    reach a human rather than a thank-you that goes nowhere."""
    return f"""<div class="form-fallback" hidden>
    <p><strong>We couldn&rsquo;t send that automatically.</strong> Please call or text us at
      <a href="tel:{BIZ['phone_href']}">{BIZ['phone_display']}</a> or email <a href="mailto:{BIZ['email']}">{BIZ['email']}</a>
      and we&rsquo;ll {what}, sorry for the trouble.</p>
    <div class="form-fallback-actions">
      <a class="btn" href="tel:{BIZ['phone_href']}">{icon('phone')} {BIZ['phone_display']}</a>
      <a class="btn btn-ghost" href="mailto:{BIZ['email']}">{icon('mail')} Email us</a>
    </div>
  </div>"""


def _referral_form():
    return f"""<div class="ref-card">
      <form class="form ref-form" id="refer-form" novalidate>
        <input type="hidden" name="token" id="ref-token" value="">
        <div class="ref-form-head">
          <h2 id="ref-form-heading">Refer a friend</h2>
          <p>Takes about a minute. We handle the rest.</p>
        </div>
        <p class="ref-alert" id="ref-alert" role="alert" tabindex="-1" hidden></p>

        <div class="ref-group" role="group" aria-labelledby="ref-g1-title">
          <h3 class="ref-group-title" id="ref-g1-title">About you</h3>
          <p class="ref-locked-note" id="ref-locked-note" hidden>These are your details from your tracking link.</p>
          <div class="ref-group-body">
            <div class="form-row">
              <div class="field"><label for="ref-first">First name</label><input type="text" id="ref-first" name="first_name" autocomplete="given-name" maxlength="60" required placeholder="Alex"></div>
              <div class="field"><label for="ref-last">Last name</label><input type="text" id="ref-last" name="last_name" autocomplete="family-name" maxlength="60" placeholder="Barta"></div>
            </div>
            <div class="form-row">
              <div class="field"><label for="ref-phone">Mobile phone</label><input type="tel" id="ref-phone" name="phone" autocomplete="tel" inputmode="tel" data-ref-phone required placeholder="{BIZ['phone_display']}"></div>
              <div class="field"><label for="ref-email">Email <span class="label-hint">(optional)</span></label><input type="email" id="ref-email" name="email" autocomplete="email" maxlength="120" placeholder="you@email.com"></div>
            </div>
          </div>
        </div>

        <div class="ref-group" role="group" aria-labelledby="ref-g2-title">
          <h3 class="ref-group-title" id="ref-g2-title">Who are you referring?</h3>
          <p class="ref-group-sub">Name and mobile number are all we need. The rest helps us quote them faster.</p>
          <div class="ref-friends" id="ref-friends">
        {_friend_row(1)}
          </div>
          <template id="ref-friend-tpl">{_friend_row("__N__")}</template>
          <div class="ref-friend-tools">
            <button type="button" class="ref-add" id="ref-add-friend">{icon('plus')} Add another friend</button>
            <span class="ref-count" id="ref-friend-count" aria-live="polite">1 of {MAX_FRIENDS} friends added</span>
          </div>
        </div>

        <div class="ref-group">
          <h3 class="ref-group-title" id="ref-g3-title">Your reward</h3>
          <p class="ref-group-sub" id="ref-g3-sub">For every friend who books. Pick whichever you&rsquo;d rather have.</p>
        {_reward_cards()}
        </div>

        <div class="field ref-consent-field">
          <label class="check ref-consent"><input type="checkbox" name="consent" id="ref-consent" required> I have my friends&rsquo; permission to share their contact details, and I agree to the <a href="#ref-terms">program terms</a>.</label>
        </div>
        <button type="submit" class="btn btn-lg btn-block" id="ref-submit">Send my referrals {icon('arrow')}</button>
        <p class="form-note center">We only contact your friends about this offer, never for anything else.</p>
      </form>
      {_fallback()}
      <div class="form-success ref-success" id="ref-success">
        <div class="success-badge">{icon('check-circle')}</div>
        <h2 class="success-title" id="ref-success-title" tabindex="-1">Your referrals are on their way!</h2>
        <p class="success-sub" id="ref-success-sub">We&rsquo;ll reach out to your friends with their ${FRIEND_OFF} off.</p>
        {_share_block("ref")}
        <div class="success-actions">
          <a class="btn" id="ref-sms" href="sms:?&amp;body=">{icon('phone')} Text a friend</a>
          <a class="btn btn-ghost" id="ref-email-share" href="mailto:?subject=&amp;body=">{icon('mail')} Email a friend</a>
        </div>
        <p class="ref-track" id="ref-track-wrap"><a id="ref-track" href="/">Track your referrals {icon('arrow')}</a><span class="ref-track-hint">Bookmark that private link: it shows each friend&rsquo;s progress and your rewards.</span></p>
        <p class="ref-track-none" id="ref-track-none" hidden>Our office has your referrals and will reach out to your friends directly. Tracking isn&rsquo;t available for this one, so give us a call at <a href="tel:{BIZ['phone_href']}">{BIZ['phone_display']}</a> any time you&rsquo;d like an update.</p>
        <button type="button" class="link-btn ref-more" id="ref-more">Refer more friends {icon('plus')}</button>
      </div>
    </div>"""


def _dashboard():
    """The referrer's private view, filled by app.js from
    GET /api/referral?t=TOKEN. Hidden until that returns; the status line
    carries the loading / not-found / error copy."""
    return f"""<div class="ref-dash" id="ref-dash" hidden>
      <div class="ref-dash-head">
        <span class="eyebrow">Your referrals</span>
        <h2 id="ref-dash-title" tabindex="-1">Welcome back, <span id="ref-dash-name"></span></h2>
        <p>Here&rsquo;s where each friend stands. Rewards are issued as soon as a friend&rsquo;s first service is complete.</p>
      </div>
      <div class="stats stats-light ref-stats">
        <div class="stat"><div class="num" id="ref-stat-referred">0</div><div class="label">Referred</div></div>
        <div class="stat"><div class="num" id="ref-stat-booked">0</div><div class="label">Booked</div></div>
        <div class="stat"><div class="num" id="ref-stat-rewards">$0</div><div class="label">Rewards earned</div><div class="ref-stat-detail" id="ref-stat-rewards-detail"></div></div>
        <div class="stat"><div class="num" id="ref-stat-pending">0</div><div class="label">Pending</div></div>
      </div>
      {_share_block("ref-dash", dash=True)}
      <h3 class="ref-list-title">Each referral</h3>
      <ul class="ref-list" id="ref-dash-list"></ul>
      <p class="ref-list-empty" id="ref-dash-empty" hidden>No referrals yet. Add a friend below and they&rsquo;ll show up here.</p>
    </div>
    <p class="ref-note" id="ref-status" role="status" aria-live="polite" hidden></p>"""


def referral_page():
    """Full HTML for index.html: offer, how it works, the referral form (with
    the private dashboard above it when opened with ?t=TOKEN), program
    terms, and a closing CTA."""
    css, js = _assets()
    html = C.head(
        title=f"Refer a Friend, Give ${FRIEND_OFF} &amp; Get ${CREDIT} | {BIZ['name']}",
        desc=(f"Refer a friend to {BIZ['name']}: they get ${FRIEND_OFF} off their first service and you earn "
              f"a ${CREDIT} account credit or a ${GIFT} gift card every time one of them books."),
        path="/", extra_css=[css])
    html += C.header()

    steps = [
        ("Tell us who to refer",
         f"Add a friend&rsquo;s name and mobile number below, up to {MAX_FRIENDS} at a time, and pick your reward. About a minute, start to finish."),
        (f"We reach out with ${FRIEND_OFF} off",
         f"We contact your friend, mention you by name, and take ${FRIEND_OFF} off their first service. No coupon hunting on their end."),
        (f"You get ${CREDIT}, every time",
         f"Each friend who books earns you a ${CREDIT} account credit, or a ${GIFT} gift card if you&rsquo;d rather. There&rsquo;s no cap."),
    ]
    step_html = "".join(
        f'<div class="ref-step reveal in" data-delay="{i}"><span class="step-num">{i + 1}</span>'
        f'<h3>{t}</h3><p>{d}</p></div>'
        for i, (t, d) in enumerate(steps))

    faqs = [
        ("Who counts as a new customer?",
         f"Anyone whose household hasn&rsquo;t had a service from {BIZ['name']} before. If we&rsquo;ve already cleaned for them, or for someone else at their address, they&rsquo;re already family, so a referral doesn&rsquo;t apply."),
        ("When do I get my reward?",
         f"As soon as your friend&rsquo;s first paid service is complete. We mark the referral booked, issue your ${CREDIT} credit or ${GIFT} gift card, and text you to let you know. Your private tracking link shows every step along the way."),
        ("How is the credit or gift card delivered?",
         f"Account credit is applied automatically and comes off your next invoice with us, there&rsquo;s nothing to remember. A gift card is texted or mailed to you within a few days of your friend&rsquo;s service. You choose when you refer, and you can switch later by calling the office."),
        ("Is there a limit to how many friends I can refer?",
         f"No. Refer as many friends as you like, up to {MAX_FRIENDS} in one go, and earn a reward for every one who books. It&rsquo;s one reward per referred household, and the friend&rsquo;s ${FRIEND_OFF} applies to their first service only."),
        ("Can the program change?",
         "We may adjust or end the program at any time, but every referral you&rsquo;ve already sent is honored under the terms shown when you sent it."),
        ("I have a question about one of my referrals.",
         f"Call or text us at <a href=\"tel:{BIZ['phone_href']}\">{BIZ['phone_display']}</a> or email <a href=\"mailto:{BIZ['email']}\">{BIZ['email']}</a>. We&rsquo;re happy to help."),
    ]

    html += f"""<main id="main" class="ref-page" {_offer_attrs()}>
  <section class="phero ref-hero"><div class="container">
    <div class="ref-hero-grid">
      <div>
        <span class="eyebrow">Referral program</span>
        <h1 class="mt-1"><span>Give ${FRIEND_OFF}.</span> <span>Get ${CREDIT}.</span></h1>
        <p class="lead">Know someone who&rsquo;d love spotless windows? Send them our way: they get ${FRIEND_OFF} off their first service, and you get a ${CREDIT} credit, or a ${GIFT} gift card, every time one of them books.</p>
        {_trust_list()}
        <div class="phero-actions">
          <a class="btn btn-lg" href="#refer-form">Refer a friend {icon('arrow')}</a>
          <a class="btn btn-lg btn-ghost" href="#how">How it works</a>
        </div>
      </div>
      <div class="ref-offer reveal in" data-delay="1">
        <div class="ref-offer-half">
          <span class="ref-offer-who">Your friend gets</span>
          <span class="ref-offer-amt">${FRIEND_OFF}</span>
          <span class="ref-offer-what">off their first service</span>
        </div>
        <div class="ref-offer-half ref-offer-half--you">
          <span class="ref-offer-who">You get</span>
          <span class="ref-offer-amt">${CREDIT}</span>
          <span class="ref-offer-what">in credit, or a ${GIFT} gift card, per friend who books</span>
        </div>
      </div>
    </div>
  </div></section>

  <section id="how"><div class="container">
    <div class="section-head center">
      <span class="eyebrow">How it works</span>
      <h2>Three steps. Zero paperwork.</h2>
      <p>You tell us who, we take care of the rest, and you can follow every referral on your own private link.</p>
    </div>
    <div class="ref-steps">{step_html}</div>
  </div></section>

  <section class="bg-mist" id="refer"><div class="container">
    {_dashboard()}
    {_referral_form()}
  </div></section>

  <section id="ref-terms"><div class="container">
    <div class="section-head center">
      <span class="eyebrow">Program terms</span>
      <h2>The fine print, in plain English</h2>
    </div>
    {C.faq_block(faqs)}
  </div></section>

  {C.cta_band(heading="Know someone who needs us?",
              text=f"Send them ${FRIEND_OFF} off and earn ${CREDIT} for yourself. It takes about a minute, and there is no limit.",
              primary=("Refer a friend", "#refer-form"))}
</main>
{C.footer()}
{C.page_end(js)}"""
    return html


def _claim_form():
    """The referred friend's "claim my $25" form. Posts to /api/claim, which
    creates the quote request in the CRM with the referrer and code attached
    and records the claim against the referral."""
    svc_checks = "".join(
        f'<label class="check svc-check"><input type="checkbox" name="services" value="{C.esc(s["name"])}"> {s["name"]}</label>'
        for s in SERVICES)
    svc_checks += '<label class="check svc-check"><input type="checkbox" name="services" value="Something else"> Something else</label>'
    return f"""<div class="ref-card claim-card" id="claim">
      <form class="form ref-form" id="claim-form" novalidate>
        <input type="hidden" name="code" id="claim-code" value="">
        <div class="ref-form-head">
          <h2 id="claim-heading">Claim your ${FRIEND_OFF} off</h2>
          <p>Tell us a little about your home and we&rsquo;ll call or text you with clear, upfront pricing, with your ${FRIEND_OFF} already taken off.</p>
        </div>
        <p class="ref-alert" id="claim-alert" role="alert" tabindex="-1" hidden></p>
        <div class="ref-group" role="group" aria-labelledby="claim-g1-title">
          <h3 class="ref-group-title" id="claim-g1-title">About you</h3>
          <div class="ref-group-body">
            <div class="form-row">
              <div class="field"><label for="claim-first">First name</label><input type="text" id="claim-first" name="first_name" autocomplete="given-name" maxlength="60" required placeholder="Jane"></div>
              <div class="field"><label for="claim-last">Last name</label><input type="text" id="claim-last" name="last_name" autocomplete="family-name" maxlength="60" placeholder="Doe"></div>
            </div>
            <div class="form-row">
              <div class="field"><label for="claim-phone">Mobile phone</label><input type="tel" id="claim-phone" name="phone" autocomplete="tel" inputmode="tel" required placeholder="{BIZ['phone_display']}"></div>
              <div class="field"><label for="claim-email">Email <span class="label-hint">(optional)</span></label><input type="email" id="claim-email" name="email" autocomplete="email" maxlength="120" placeholder="you@email.com"></div>
            </div>
            <div class="field"><label for="claim-address">Home address <span class="label-hint">(optional, helps us quote faster)</span></label><input type="text" id="claim-address" name="address" autocomplete="street-address" maxlength="200" placeholder="123 Main St, Delano, MN 55328"></div>
          </div>
        </div>
        <div class="ref-group" role="group" aria-labelledby="claim-g2-title">
          <h3 class="ref-group-title" id="claim-g2-title">What are you interested in?</h3>
          <p class="ref-group-sub">Optional. Pick anything that applies and we&rsquo;ll come prepared.</p>
          <div class="svc-checks claim-services">{svc_checks}</div>
          <div class="field mt-2"><label for="claim-note">Anything we should know? <span class="label-hint">(optional)</span></label><input type="text" id="claim-note" name="note" autocomplete="off" maxlength="500" placeholder="Two-story house, best to call after 5pm"></div>
        </div>
        <div class="field ref-consent-field">
          <label class="check ref-consent"><input type="checkbox" name="consent" id="claim-consent" required> I agree to be contacted by {BIZ['name']} by call or text about my request. Msg &amp; data rates may apply; reply STOP to opt out. See the <a href="{BIZ['site']}/privacy.html">Privacy Policy</a>.</label>
        </div>
        <button type="submit" class="btn btn-lg btn-block" id="claim-submit">Claim my ${FRIEND_OFF} off {icon('arrow')}</button>
        <p class="form-note center">No obligation and no pressure. Your ${FRIEND_OFF} comes straight off your first invoice.</p>
      </form>
      {_fallback("get you set up with your discount by hand")}
      <div class="form-success ref-success" id="claim-success">
        <div class="success-badge">{icon('check-circle')}</div>
        <h2 class="success-title" id="claim-success-title" tabindex="-1">You&rsquo;re all set!</h2>
        <p class="success-sub" id="claim-success-sub">We&rsquo;ll call or text you shortly to set up your first service, with your ${FRIEND_OFF} off already applied.</p>
        <p class="rd-code-wrap claim-success-code" data-claim-code-wrap hidden><span class="rd-code-label">Your code</span> <strong class="ref-code rd-code" data-claim-code></strong></p>
        <div class="success-actions">
          <a class="btn btn-lg" href="tel:{BIZ['phone_href']}">{icon('phone')} {BIZ['phone_display']}</a>
          <a class="btn btn-ghost" href="{BIZ['site']}">Visit our website</a>
        </div>
      </div>
    </div>"""


def friend_page():
    """Full HTML for friend.html, what a friend lands on from /r/CODE. The
    generic offer is rendered server-side so the page is complete before (or
    without) JavaScript; app.js personalizes it with the referrer's first
    name and the code once GET /api/referral?code= answers, and runs the
    claim form. noindex: it is personal and thin as a search result."""
    css, js = _assets()
    html = C.head(
        title=f"You&rsquo;ve Been Referred, ${FRIEND_OFF} Off Your First Service | {BIZ['name']}",
        desc=(f"A friend referred you to {BIZ['name']}, so your first service is ${FRIEND_OFF} off. "
              f"Window cleaning, gutters, house washing and more across the western Twin Cities."),
        path="/friend.html", noindex=True, extra_css=[css])
    html += C.header()

    svc_cards = "".join(
        f'<div class="feature rd-svc reveal in" data-delay="{i}"><span class="ic">{icon(s["icon"])}</span>'
        f'<div><h3><a href="{BIZ["site"]}/services/{s["slug"]}.html">{s["name"]}</a></h3><p>{s["short"]}</p></div></div>'
        for i, s in enumerate(SERVICES))

    html += f"""<main id="main" class="rd-page" {_offer_attrs()}>
  <section class="phero rd-hero"><div class="container">
    <div class="rd-hero-inner">
      <span class="eyebrow">You&rsquo;ve been referred</span>
      <h1 class="mt-1 h1-tight" id="rd-title">You&rsquo;ve been referred: ${FRIEND_OFF} off your first service</h1>
      <p class="lead" id="rd-lead">A friend thinks you&rsquo;ll love how we treat a home. Your first service with {BIZ['name']} is ${FRIEND_OFF} off, no strings attached.</p>
      <p class="rd-code-wrap" id="rd-code-wrap" hidden><span class="rd-code-label">Your code</span> <strong class="ref-code rd-code" id="rd-code"></strong> <span class="rd-code-hint">is already attached to the form below, or mention it when you call.</span></p>
      <div class="phero-actions">
        <a class="btn btn-lg" id="rd-claim" href="#claim">Claim my ${FRIEND_OFF} off {icon('arrow')}</a>
        <a class="btn btn-lg btn-ghost" href="tel:{BIZ['phone_href']}">{icon('phone')} {BIZ['phone_display']}</a>
      </div>
      {_trust_list()}
    </div>
  </div></section>

  <section class="bg-mist section-tight"><div class="container">
    {_claim_form()}
  </div></section>

  <section><div class="container">
    <div class="section-head center">
      <span class="eyebrow">What Barta does</span>
      <h2>Exterior cleaning, done properly</h2>
      <p>Windows, gutters, siding, concrete: one careful crew, no ladders in your flower beds, and results you can see from the street.</p>
    </div>
    <div class="grid cols-4 rd-services">{svc_cards}</div>
  </div></section>

  <section class="section-tight bg-mist"><div class="container">
    {C.trust_badges()}
    <p class="rd-how center">How the discount works: your ${FRIEND_OFF} comes straight off your first invoice. Claim it above, or mention your code when you call, and it&rsquo;s applied.</p>
  </div></section>

  {C.cta_band(heading=f"Ready to claim your ${FRIEND_OFF}?",
              text="Tell us about your home and we will get back to you with clear, upfront pricing. No obligation, no pressure.",
              primary=(f"Claim my ${FRIEND_OFF} off", "#claim"))}
</main>
{C.footer()}
{C.page_end(js)}"""
    return html
