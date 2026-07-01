#!/usr/bin/env python3
"""
Barta Window Washing — static site generator.
Run from repo root:  python3 build/build.py
Outputs HTML pages, sitemap, robots, manifest, and placeholder imagery.
"""
import os, sys, datetime
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

from sitedata import BIZ, SERVICES, AREAS, PLANS, REVIEWS, TEAM, POSTS, FAQS, HOME_SERVICES
from icons import icon
import components as C
import schema as S

PAGES = []  # (relpath, slug, lastmod, priority) for sitemap

def load_reviews_widget():
    """Return the Google reviews embed code if the owner has pasted one,
    else '' so pages fall back to curated review cards."""
    import re
    p = os.path.join(ROOT, "config", "google-reviews-embed.html")
    if not os.path.exists(p):
        return ""
    raw = open(p, encoding="utf-8").read()
    # Ignore the instructional HTML comment(s) — only real markup counts.
    stripped = re.sub(r"<!--.*?-->", "", raw, flags=re.S).strip()
    return raw if stripped else ""

REVIEWS_WIDGET = load_reviews_widget()

def write(relpath, html, slug=None, priority="0.7"):
    path = os.path.join(ROOT, relpath)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(html)
    PAGES.append((relpath, slug if slug is not None else relpath, priority))

BASE_SCHEMA = [S.local_business(), S.organization(), S.website()]

def stars_row():
    return '<span class="stars">' + icon('star') * 5 + '</span>'

# ===========================================================================
# HOMEPAGE
# ===========================================================================
def build_home():
    depth = 0
    svc_cards = "".join(C.picture_card(item, depth, i) for i, item in enumerate(HOME_SERVICES))

    reviews_html = "".join(C.review_card(*r, delay=i % 3) for i, r in enumerate(REVIEWS[:6]))
    areas_html = "".join(
        f'<a class="area-card reveal" data-delay="{i%4}" href="areas/{a["slug"]}.html">{icon("pin")} {a["city"]}</a>'
        for i, a in enumerate(AREAS))

    process_steps = [
        ("01", "Mop", "assets/img/svc-exterior-window-cleaning.jpg",
         "We apply an eco-friendly cleaning solution and work every pane with a T-bar scrubber, lifting loose dirt, dust, and pollen off the glass.", None),
        ("02", "Scrub", None,
         "For stubborn silicone, putty overspray, and grime the T-bar won't touch, we hand-scrub with 0000 steel wool — safe on glass, tough on residue.", "sparkle"),
        ("03", "Squeegee", "assets/img/svc-interior-window-cleaning.jpg",
         "A professional-grade squeegee removes every drop, leaving streak-free glass with zero spotting.", None),
        ("04", "Detail", "assets/img/svc-track-detailing.jpg",
         "We finish by hand-detailing sills, tracks, and frames — the details other companies skip.", None),
    ]
    process_slider_html = C.process_slider(process_steps, depth)

    why = [
        ("shield", "Licensed &amp; fully insured", "Comprehensive liability and workers' comp coverage on every job. Your home and our team are always protected."),
        ("home", "Locally &amp; family owned", "Born and based in Delano. We treat your home like a neighbor's — because you are one."),
        ("leaf", "Safe, eco-friendly methods", "Biodegradable solutions and the right pressure for every surface. Safe for your family, pets, and landscaping."),
        ("award", "Obsessed with detail", "Sills, tracks, screens, downspouts — we sweat the details most companies skip."),
        ("clock", "On time, every time", "We respect your schedule with confirmed windows, text updates, and crews that show up when we say."),
        ("check-circle", "100% satisfaction guarantee", "If any part of your service isn't perfect, we return and re-clean it free. No hassle, no fine print."),
    ]
    why_html = "".join(
        f'<div class="feature reveal" data-delay="{i%3}"><span class="ic">{icon(ic)}</span><div><h4>{t}</h4><p>{d}</p></div></div>'
        for i, (ic, t, d) in enumerate(why))

    plan_teaser = ""
    for p in PLANS:
        feat = " featured" if p["featured"] else ""
        badge = '<span class="plan-badge">Most Popular</span>' if p["featured"] else ""
        incl = "".join(f'<li>{icon("check")} {x}</li>' for x in p["incl"][:4])
        plan_teaser += f"""<div class="plan reveal{feat}">{badge}
        <h3>{p['name']}</h3><p class="tag">{p['tag']}</p>
        <div class="price"><span class="amt">${p['monthly']}</span><span class="per">/mo</span></div>
        <p class="annual">or ${p['annual']}/yr · {p['annual_save']}</p>
        <ul class="incl">{incl}</ul>
        <a class="btn {'btn' if p['featured'] else 'btn-ghost'} btn-block" href="service-plans.html">View plan</a>
      </div>"""

    # Recurring-plan savings cards ("Save money with every service")
    promo_plans = [
        ("Monthly", "150", True, False),
        ("Quarterly", "100", True, True),
        ("Biannual", "50", False, False),
    ]
    promo_feats = ["Priority Scheduling", "7-Day Rain Guarantee", "Free Hard Water Removal"]
    promo_cards = ""
    for i, (name, amt, included, popular) in enumerate(promo_plans):
        cls = "yes" if included else "no"
        mark = icon("check-circle") if included else icon("x")
        feats = "".join(f'<li class="{cls}">{mark} {f}</li>' for f in promo_feats)
        pop_cls = " popular" if popular else ""
        badge = '<span class="promo-badge">Most Popular</span>' if popular else ""
        promo_cards += f"""<div class="promo-card{pop_cls} reveal" data-delay="{i}">{badge}
        <h3 class="promo-name">{name}</h3>
        <div class="promo-price">${amt} <small>OFF</small></div>
        <div class="promo-per">Per Cleaning</div>
        <ul class="promo-feats">{feats}</ul>
        <a class="btn btn-block" href="request-quote.html">Get Your Instant Quote</a>
      </div>"""

    ba_html = "".join(
        f'<div class="reveal" data-delay="{i}">{C.ba_slider(depth=depth, name=n)}</div>'
        for i, n in enumerate(["ba1", "ba2", "ba3"]))

    home_faqs = FAQS[:5]
    schema = BASE_SCHEMA + [S.faq_schema(home_faqs)]

    html = C.head(
        title=f"{BIZ['name']} | Premium Window Cleaning & Exterior Care in Delano, MN",
        desc="Delano's top-rated window cleaning, gutter cleaning, pressure washing & house washing company. Licensed, insured, family-owned. 5.0★ from 100+ reviews. Get your free quote today!",
        slug="index.html", depth=depth, schema=schema, primary_kw="window cleaning Delano MN",
        canonical=BIZ["domain"] + "/")
    html += C.nav(depth)
    html += f"""
<main id="main">
  <!-- HERO -->
  <section class="hero hero-photo-full">
    <img class="hero-bg-img" src="assets/img/hero-home.jpg" alt="The branded Barta Window Washing (BWW) service van in the Delano, MN area" width="1920" height="1442" fetchpriority="high" decoding="async">
    <div class="hero-overlay"></div>
    <div class="container">
      <div class="hero-content reveal in">
        {C.google_badge(depth)}
        <h1>Dirty Windows?<br>We can <em>fix that.</em></h1>
        <p class="lead">Minnesota's trusted exterior cleaning professionals. Brighter views. Spotless results. Satisfaction guaranteed.</p>
        <div class="hero-actions">
          <a class="btn btn-lg" href="request-quote.html">Get Your Free Quote {icon('arrow')}</a>
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
        <h2>Before &amp; after — drag to reveal</h2>
        <p>Real results from real Barta jobs. Slide each image to see the transformation.</p>
      </div>
      <div class="grid cols-3">{ba_html}</div>
      <div class="center mt-4"><a class="btn btn-ghost" href="gallery.html">View the full gallery {icon('arrow')}</a></div>
    </div>
  </section>

  <!-- AREAS -->
  <section>
    <div class="container">
      <div class="section-head center">
        <span class="eyebrow">Areas we serve</span>
        <h2>Proudly cleaning the western Twin Cities</h2>
        <p>Based in Delano and serving homeowners and businesses across Wright, Hennepin, and Carver counties.</p>
      </div>
      <div class="area-grid">{areas_html}</div>
      <div class="center mt-4"><a class="btn btn-ghost" href="service-areas.html">See all service areas {icon('arrow')}</a></div>
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

  {C.cta_band(depth)}
</main>
"""
    html += C.page_end(depth)
    write("index.html", html, slug="", priority="1.0")

# ===========================================================================
# SERVICE PAGES
# ===========================================================================
def build_service(svc):
    depth = 1
    benefits_html = "".join(
        f'<div class="feature reveal" data-delay="{i%2}"><span class="ic">{icon("check")}</span><div><h4>{t}</h4><p>{d}</p></div></div>'
        for i, (t, d) in enumerate(svc["benefits"]))
    includes_html = "".join(f'<li>{icon("check-circle")} {x}</li>' for x in svc["includes"])
    related = [x for x in SERVICES if x["slug"] != svc["slug"]][:3]
    related_html = "".join(
        f"""<a class="card svc-card reveal" data-delay="{i}" href="{r['slug']}.html">
        <span class="ic">{icon(r['icon'])}</span><h3>{r['name']}</h3><p>{r['short']}</p>
        <span class="more">Learn more {icon('arrow')}</span></a>"""
        for i, r in enumerate(related))
    reviews_html = "".join(C.review_card(*r, delay=i % 3) for i, r in enumerate(REVIEWS[:3]))

    svc_faqs = [
        (f"How much does {svc['name'].lower()} cost in {BIZ['city']}?",
         f"Every home is different, so we provide free, upfront, all-in quotes with no hidden fees. Pricing for {svc['name'].lower()} depends on the size and accessibility of your property. Request a quote and we'll get you a clear price — often the same day."),
        (f"How often should I schedule {svc['name'].lower()}?",
         f"For most Minnesota homes we recommend {svc['name'].lower()} once or twice per year, though it varies by your home and surroundings. Our membership plans bundle it on the ideal schedule at a member discount — so it's handled automatically."),
        ("Are you licensed and insured?",
         "Yes — Barta is fully licensed and carries liability and workers' compensation insurance. We provide a certificate on request and treat your property with total care."),
        ("Do you guarantee your work?",
         "Always. Every service is backed by our 100% Satisfaction Guarantee. If anything isn't right, call within 48 hours and we'll re-clean it free."),
    ]
    breadcrumb = S.breadcrumb([
        ("Home", BIZ["domain"] + "/"),
        ("Services", BIZ["domain"] + "/residential.html"),
        (svc["name"], BIZ["domain"] + "/services/" + svc["slug"] + ".html"),
    ])
    schema = BASE_SCHEMA + [S.service_schema(svc), S.faq_schema(svc_faqs), breadcrumb]

    kw2 = ", ".join(svc["kw2"])
    html = C.head(
        title=f"{svc['name']} in {BIZ['city']}, MN | {BIZ['name']}",
        desc=f"Professional {svc['name'].lower()} in {BIZ['city']} & the western Twin Cities. {svc['short']} Licensed, insured & guaranteed. Get your free quote from Barta today.",
        slug=f"services/{svc['slug']}.html", depth=depth, schema=schema,
        primary_kw=svc["kw"])
    html += C.nav(depth)
    html += f"""
<main id="main">
  <section class="phero">
    <div class="container">
      {C.crumbs([("Home", "../index.html"), ("Services", "../residential.html"), (svc['name'], None)])}
      <div class="hero-grid">
        <div>
          <span class="eyebrow" style="color:#ff9b86">{svc['name']}</span>
          <h1 class="mt-1">{svc['name']} in {BIZ['city']} &amp; the Western Metro</h1>
          <p class="lead">{svc['hero_sub']}</p>
          <div class="phero-actions">
            <a class="btn btn-lg btn-light" href="#quote-form">Get a Free Quote {icon('arrow')}</a>
            <a class="btn btn-lg btn-outline" style="color:#fff;box-shadow:inset 0 0 0 2px rgba(255,255,255,.4)" href="tel:{BIZ['phone_href']}">{icon('phone')} {BIZ['phone_display']}</a>
          </div>
          <ul class="hero-trust">
            <li>{icon('shield')} Licensed &amp; insured</li>
            <li>{icon('check-circle')} Satisfaction guaranteed</li>
            <li>{icon('star')} {BIZ['rating']}★ rated</li>
          </ul>
        </div>
        <div>{C.lead_form(depth, heading=f"Free {svc['name']} Quote", svc_default=svc['slug'], compact=True)}</div>
      </div>
    </div>
  </section>

  <section>
    <div class="container">
      <div class="split">
        <div class="prose reveal">
          <span class="eyebrow">Overview</span>
          <h2 class="mt-1">Professional {svc['name'].lower()}, done right</h2>
          <p>{svc['intro']}</p>
          <p><strong>{svc['process_note']}</strong></p>
        </div>
        <div class="reveal">{C.ba_slider(depth=depth, name="ba1")}</div>
      </div>
    </div>
  </section>

  <section class="bg-mist">
    <div class="container">
      <div class="section-head center">
        <span class="eyebrow">Why Barta</span>
        <h2>The benefits you'll notice</h2>
      </div>
      <div class="grid cols-2">{benefits_html}</div>
    </div>
  </section>

  <section>
    <div class="container">
      <div class="split reverse">
        <div class="reveal">{C.photo(svc['image'], svc['name'] + " by Barta — professional crew at work in the Twin Cities", ratio="5/4", depth=depth) if svc.get('image') else C.imgph(svc['name'] + " — professional crew at work", ratio="5/4")}</div>
        <div class="reveal">
          <span class="eyebrow">What's included</span>
          <h2 class="mt-1">Every {svc['name'].lower()} includes</h2>
          <ul class="checklist mt-2">{includes_html}</ul>
          <a class="btn mt-3" href="#quote-form">Get my free quote {icon('arrow')}</a>
        </div>
      </div>
    </div>
  </section>

  <section class="bg-grad-sky">
    <div class="container">
      <div class="section-head center"><span class="eyebrow">Loved locally</span><h2>What customers say</h2></div>
      <div class="grid cols-3">{reviews_html}</div>
    </div>
  </section>

  <section>
    <div class="container">
      <div class="section-head center"><span class="eyebrow">Questions</span><h2>{svc['name']} FAQs</h2></div>
      {C.faq_block(svc_faqs)}
    </div>
  </section>

  <section class="bg-mist">
    <div class="container">
      <div class="section-head center"><span class="eyebrow">Complete your exterior</span><h2>You may also need</h2></div>
      <div class="grid cols-3">{related_html}</div>
    </div>
  </section>

  {C.cta_band(depth, heading=f"Ready for spotless results?", text=f"Get your free, no-obligation {svc['name'].lower()} quote today and see why Delano trusts Barta.")}
</main>
"""
    html += C.page_end(depth)
    write(f"services/{svc['slug']}.html", html, slug=f"services/{svc['slug']}.html", priority="0.9")

# ===========================================================================
# SERVICE PLANS
# ===========================================================================
def build_plans():
    depth = 0
    plans_html = ""
    for p in PLANS:
        feat = " featured" if p["featured"] else ""
        badge = '<span class="plan-badge">Most Popular</span>' if p["featured"] else ""
        incl = "".join(f'<li>{icon("check")} {x}</li>' for x in p["incl"])
        btn = "btn" if p["featured"] else "btn-ghost"
        plans_html += f"""<div class="plan reveal{feat}">{badge}
        <h3>{p['name']}</h3><p class="tag">{p['tag']}</p>
        <div class="price"><span class="amt">${p['monthly']}</span><span class="per">/month</span></div>
        <p class="annual">or ${p['annual']}/year · {p['annual_save']}</p>
        <ul class="incl">{incl}</ul>
        <a class="btn {btn} btn-block" href="request-quote.html">Join {p['name']} {icon('arrow')}</a>
      </div>"""

    # comparison rows
    rows = [
        ("Window cleanings / year", "2 (exterior)", "2 (in &amp; out)", "4 (in &amp; out)"),
        ("Gutter cleanings / year", "1", "2", "2 + flush"),
        ("House soft wash", "—", "1 / year", "1 / year"),
        ("Pressure washing", "Add-on", "Add-on", "1 / year"),
        ("Screen cleaning", "Add-on", "Included", "Included"),
        ("Member discount", "10%", "15%", "20%"),
        ("Priority scheduling", "yes", "yes", "yes"),
        ("Free annual inspection", "yes", "yes", "yes"),
        ("Automatic reminders", "yes", "yes", "yes"),
        ("Dedicated account manager", "no", "no", "yes"),
        ("Holiday lighting consult", "no", "no", "yes"),
    ]
    def cell(v):
        if v == "yes": return f'<span class="yes">{icon("check-circle")}</span>'
        if v == "no": return f'<span class="no">{icon("x")}</span>'
        return v
    table_rows = "".join(
        f'<tr><td><strong>{r[0]}</strong></td><td>{cell(r[1])}</td><td>{cell(r[2])}</td><td>{cell(r[3])}</td></tr>'
        for r in rows)

    perks = [
        ("bolt", "Priority scheduling", "Members jump the line — especially valuable in peak spring and fall."),
        ("tag", "Exclusive member pricing", "Save 10–20% on every add-on service, all year long."),
        ("calendar", "Automatic reminders", "We track your schedule and reach out — you never have to remember."),
        ("clipboard", "Free annual inspections", "We catch small issues (loose gutters, roof algae) before they get expensive."),
        ("heart", "Locked-in rates", "Your plan price is protected — no surprise seasonal increases."),
        ("headset", "VIP support", "A friendly, familiar team that already knows your home."),
    ]
    perks_html = "".join(
        f'<div class="feature reveal" data-delay="{i%3}"><span class="ic">{icon(ic)}</span><div><h4>{t}</h4><p>{d}</p></div></div>'
        for i, (ic, t, d) in enumerate(perks))

    plan_faqs = [
        ("Can I cancel anytime?", "Yes. Our plans are month-to-month with no long-term contract. Cancel anytime with 30 days' notice — no fees, no hassle. Annual plans can be prorated and refunded for unused services."),
        ("How does scheduling work?", "Once you join, we build your annual maintenance calendar and reach out to confirm each visit ahead of time. You always get priority dates before non-members, and you can reschedule easily."),
        ("What if I need a service not in my plan?", "No problem — members get their discount (10–20%) on any add-on service, from hard water removal to holiday lighting. Just ask and we'll add it to your visit."),
        ("Do unused services roll over?", "Plan services are scheduled within your membership year to keep your home consistently maintained. If you need to shift timing, we'll work with you — just give us a heads up."),
        ("Is there a setup fee?", "None. There are no setup fees, no hidden costs, and no surprises. Your monthly or annual price is exactly what you pay."),
        ("Can I upgrade or downgrade?", "Anytime. As your needs change, move between Clear View, Crystal Plus, and Signature Estate with a quick call — we'll prorate the difference."),
    ]
    schema = BASE_SCHEMA + [S.faq_schema(plan_faqs)]

    html = C.head(
        title=f"Service Plans & Maintenance Memberships | {BIZ['name']} Delano, MN",
        desc="Effortless, year-round exterior cleaning with Barta's maintenance memberships. Priority scheduling, member discounts up to 20%, free inspections & automatic reminders. Plans from $49/mo.",
        slug="service-plans.html", depth=depth, schema=schema, primary_kw="window cleaning maintenance plan Delano MN")
    html += C.nav(depth)
    html += f"""
<main id="main">
  <section class="phero">
    <div class="container">
      {C.crumbs([("Home", "index.html"), ("Service Plans", None)])}
      <div style="max-width:760px">
        <span class="eyebrow" style="color:#ff9b86">Barta Care Memberships</span>
        <h1 class="mt-1">A spotless home, on autopilot</h1>
        <p class="lead">Stop scheduling, stop remembering, stop climbing ladders. Our maintenance memberships keep your windows, gutters, and exterior effortlessly clean all year — with priority scheduling, member-only pricing, and free inspections.</p>
        <div class="phero-actions">
          <a class="btn btn-lg btn-light" href="#plans">See the plans {icon('arrow')}</a>
          <a class="btn btn-lg btn-outline" style="color:#fff;box-shadow:inset 0 0 0 2px rgba(255,255,255,.4)" href="tel:{BIZ['phone_href']}">{icon('phone')} Talk to us</a>
        </div>
      </div>
    </div>
  </section>

  <section id="plans">
    <div class="container">
      <div class="section-head center">
        <span class="eyebrow">Choose your plan</span>
        <h2>Memberships built for Minnesota homes</h2>
        <p>Every plan includes priority scheduling, automatic reminders, a free annual inspection, and our 100% satisfaction guarantee. Pause, change, or cancel anytime.</p>
      </div>
      <div class="plans">{plans_html}</div>
      <p class="center mt-3" style="color:var(--slate-500)">Prices are illustrative examples for an average single-family home and may vary by home size and location. Your exact plan price is confirmed in your free quote.</p>
    </div>
  </section>

  <section class="bg-mist">
    <div class="container">
      <div class="section-head center"><span class="eyebrow">Member perks</span><h2>Why members love it</h2></div>
      <div class="grid cols-3">{perks_html}</div>
    </div>
  </section>

  <section>
    <div class="container">
      <div class="section-head center"><span class="eyebrow">Side by side</span><h2>Compare every plan</h2></div>
      <div class="table-scroll">
        <table class="compare">
          <thead><tr><th>Feature</th><th>Clear View</th><th>Crystal Plus</th><th>Signature Estate</th></tr></thead>
          <tbody>{table_rows}</tbody>
        </table>
      </div>
    </div>
  </section>

  <section class="bg-grad-sky">
    <div class="container">
      <div class="split">
        <div class="reveal">
          <span class="eyebrow">Your annual schedule</span>
          <h2 class="mt-1">Maintenance, perfectly timed</h2>
          <p>We map your services to Minnesota's seasons so your home looks its best year-round — and we handle the calendar for you.</p>
          <ul class="checklist mt-2">
            <li>{icon('check-circle')} <strong>Spring:</strong> exterior windows, gutter clear-out, house soft wash</li>
            <li>{icon('check-circle')} <strong>Summer:</strong> interior windows, screens, pressure washing</li>
            <li>{icon('check-circle')} <strong>Fall:</strong> final gutter cleaning, downspout flush, roof check</li>
            <li>{icon('check-circle')} <strong>Winter:</strong> optional holiday lighting &amp; planning for next year</li>
          </ul>
        </div>
        <div class="reveal">{C.imgph("Seasonal maintenance calendar", ratio="5/4")}</div>
      </div>
    </div>
  </section>

  <section>
    <div class="container">
      <div class="section-head center"><span class="eyebrow">Questions</span><h2>Membership FAQs</h2></div>
      {C.faq_block(plan_faqs)}
    </div>
  </section>

  {C.cta_band(depth, heading="Join the easiest home upgrade you'll make", text="Lock in member pricing and never think about exterior cleaning again. Start with a free quote — we'll recommend the perfect plan.", primary=("Become a Member", "request-quote.html"))}
</main>
"""
    html += C.page_end(depth)
    write("service-plans.html", html, slug="service-plans.html", priority="0.9")

# ===========================================================================
# Generic interior page scaffold
# ===========================================================================
def interior_head(title, desc, slug, eyebrow, h1, lead, depth=0, schema=None,
                  crumb_label=None, primary_kw="", cta_form=False, svc_default=None):
    schema = schema or BASE_SCHEMA
    html = C.head(title=title, desc=desc, slug=slug, depth=depth, schema=schema, primary_kw=primary_kw)
    html += C.nav(depth)
    crumbs = C.crumbs([("Home", C.rel(depth) + "index.html"), (crumb_label or h1, None)])
    if cta_form:
        body = f"""
  <section class="phero">
    <div class="container">
      {crumbs}
      <div class="hero-grid">
        <div>
          <span class="eyebrow" style="color:#ff9b86">{eyebrow}</span>
          <h1 class="mt-1">{h1}</h1>
          <p class="lead">{lead}</p>
          <div class="phero-actions">
            <a class="btn btn-lg btn-light" href="#quote-form">Get a Free Quote {icon('arrow')}</a>
            <a class="btn btn-lg btn-outline" style="color:#fff;box-shadow:inset 0 0 0 2px rgba(255,255,255,.4)" href="tel:{BIZ['phone_href']}">{icon('phone')} {BIZ['phone_display']}</a>
          </div>
        </div>
        <div>{C.lead_form(depth, svc_default=svc_default, compact=True)}</div>
      </div>
    </div>
  </section>"""
    else:
        body = f"""
  <section class="phero">
    <div class="container">
      {crumbs}
      <div style="max-width:760px">
        <span class="eyebrow" style="color:#ff9b86">{eyebrow}</span>
        <h1 class="mt-1">{h1}</h1>
        <p class="lead">{lead}</p>
      </div>
    </div>
  </section>"""
    return html, body

# ===========================================================================
# COMMERCIAL
# ===========================================================================
def build_commercial():
    depth = 0
    svc_list = ["Storefront &amp; office window cleaning", "High-rise &amp; multi-story pure-water cleaning",
                "Pressure washing for lots, walkways &amp; entries", "Building &amp; awning soft washing",
                "Gutter cleaning &amp; maintenance", "Solar array cleaning", "Recurring scheduled service contracts",
                "Post-construction cleanup"]
    industries = [("building", "Office &amp; retail", "Spotless entrances and glass that impress every visitor."),
                  ("home", "Property management", "One reliable vendor for every building in your portfolio."),
                  ("tag", "Restaurants &amp; hospitality", "Sparkling storefronts and patios that invite customers in."),
                  ("wrench", "Industrial &amp; warehouse", "Safe, insured cleaning for large facades and lots."),
                  ("users", "HOAs &amp; communities", "Coordinated service for shared and common areas."),
                  ("award", "Medical &amp; professional", "Discreet, scheduled cleaning that meets a higher standard.")]
    ind_html = "".join(f'<div class="feature reveal" data-delay="{i%3}"><span class="ic">{icon(ic)}</span><div><h4>{t}</h4><p>{d}</p></div></div>'
                       for i, (ic, t, d) in enumerate(industries))
    incl_html = "".join(f'<li>{icon("check-circle")} {x}</li>' for x in svc_list)
    schema = BASE_SCHEMA
    html, body = interior_head(
        title=f"Commercial Window Cleaning & Exterior Services | {BIZ['name']} MN",
        desc="Reliable commercial window cleaning, pressure washing & building washing for offices, retail, restaurants & property managers across the western Twin Cities. Flexible contracts. Free quote.",
        slug="commercial.html", eyebrow="Commercial Services",
        h1="Commercial exterior cleaning your business can rely on",
        lead="From storefronts to multi-building portfolios, Barta keeps your property polished and professional — with flexible scheduling, full insurance, and a single point of contact.",
        depth=depth, schema=schema, crumb_label="Commercial", cta_form=True,
        primary_kw="commercial window cleaning Twin Cities MN")
    html += f"""<main id="main">{body}
  <section>
    <div class="container">
      <div class="split">
        <div class="prose reveal">
          <span class="eyebrow">Built for business</span>
          <h2 class="mt-1">A polished exterior is silent salesmanship</h2>
          <p>Your building is the first impression every customer, tenant, and partner forms about your business. Streaked windows and grimy entrances quietly cost you — clean ones quietly win. Barta delivers dependable, scheduled commercial cleaning that keeps your property looking its absolute best, without you having to manage it.</p>
          <p>We work around your hours, carry full liability and workers' comp coverage, and assign a single account contact so service is effortless. One vendor, every exterior need, zero hassle.</p>
        </div>
        <div class="reveal">{C.photo("assets/img/commercial-building-cleaning.jpg", "Barta crew cleaning a commercial building in the Twin Cities metro", ratio="5/4", depth=depth)}</div>
      </div>
    </div>
  </section>
  <section class="bg-mist">
    <div class="container">
      <div class="section-head center"><span class="eyebrow">Who we serve</span><h2>Trusted across industries</h2></div>
      <div class="grid cols-3">{ind_html}</div>
    </div>
  </section>
  <section>
    <div class="container">
      <div class="split reverse">
        <div class="reveal">{C.imgph("Commercial building soft washing", ratio="5/4")}</div>
        <div class="reveal">
          <span class="eyebrow">Capabilities</span>
          <h2 class="mt-1">Full-service commercial cleaning</h2>
          <ul class="checklist mt-2">{incl_html}</ul>
          <a class="btn mt-3" href="#quote-form">Request a commercial quote {icon('arrow')}</a>
        </div>
      </div>
    </div>
  </section>
  <section class="bg-deep">
    <div class="container">
      <div class="stats">
        <div class="stat reveal"><div class="num" data-count="500" data-suffix="+">500+</div><div class="label">Commercial accounts</div></div>
        <div class="stat reveal" data-delay="1"><div class="num" data-count="100" data-suffix="%">100%</div><div class="label">Insured &amp; bonded</div></div>
        <div class="stat reveal" data-delay="2"><div class="num" data-count="24" data-suffix="hr">24hr</div><div class="label">Quote turnaround</div></div>
        <div class="stat reveal" data-delay="3"><div class="num" data-count="1">1</div><div class="label">Dedicated contact</div></div>
      </div>
    </div>
  </section>
  {C.cta_band(depth, heading="Let's keep your property pristine", text="Request a free commercial quote and we'll build a service plan around your schedule and budget.", primary=("Request a Commercial Quote", "request-quote.html"))}
</main>"""
    html += C.page_end(depth)
    write("commercial.html", html, slug="commercial.html", priority="0.8")

# ===========================================================================
# RESIDENTIAL
# ===========================================================================
def build_residential():
    depth = 0
    svc_cards = "".join(C.service_image_card(s, depth, i) for i, s in enumerate(SERVICES))
    html, body = interior_head(
        title=f"Residential Exterior Cleaning Services | {BIZ['name']} Delano, MN",
        desc="Complete residential exterior cleaning in Delano & the western metro — windows, gutters, pressure washing, house & roof washing, and more. Family-owned, insured & guaranteed.",
        slug="residential.html", eyebrow="Residential Services",
        h1="Everything your home's exterior needs, in one trusted team",
        lead="Windows, gutters, siding, roofs, walkways, and seasonal lighting — Barta keeps every inch of your home's exterior beautifully maintained, so you can simply enjoy it.",
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
            <li>{icon('check-circle')} Member discounts up to 20% with a plan</li>
            <li>{icon('check-circle')} Priority scheduling for recurring clients</li>
          </ul>
          <a class="btn mt-3" href="service-plans.html">Explore service plans {icon('arrow')}</a>
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
# WHY CHOOSE US
# ===========================================================================
def build_why():
    depth = 0
    reasons = [
        ("shield", "Fully licensed &amp; insured", "Comprehensive liability and workers' compensation coverage protect your home and our team on every single job. Certificate available on request."),
        ("home", "Local &amp; family owned", "We're your neighbors in Delano, not a faceless franchise. Our name is on every truck and every result — and our reputation is everything."),
        ("award", "Detail you can see", "Sills, tracks, screens, downspouts, and corners — we finish the details most companies rush past. The difference shows."),
        ("leaf", "Safe, proven methods", "We match the right pressure and biodegradable solution to every surface, protecting your home, family, pets, and landscaping."),
        ("clock", "Reliable &amp; on time", "Confirmed arrival windows, text updates, and crews that actually show up when we say. We respect your time."),
        ("check-circle", "100% satisfaction guarantee", "If you're not thrilled, we make it right — re-cleaning free within 48 hours. No fine print, no hassle."),
        ("star", "Top-rated locally", f"{BIZ['rating']}★ from {BIZ['review_count']}+ verified reviews — among the highest-rated exterior cleaners in the western metro."),
        ("users", "Background-checked crews", "Friendly, uniformed, trained professionals you'll feel comfortable having around your home and family."),
        ("tag", "Honest, upfront pricing", "Clear all-in quotes with no hidden fees, no pressure, and no surprises on the final invoice."),
    ]
    cards = "".join(f'<div class="card reveal" data-delay="{i%3}"><span class="ic" style="width:54px;height:54px;border-radius:14px;background:var(--grad-brand);color:#fff;display:grid;place-items:center;box-shadow:var(--sh-glow)">{icon(ic)}</span><h3 class="mt-2" style="font-size:1.2rem">{t}</h3><p class="mt-1">{d}</p></div>'
                    for i, (ic, t, d) in enumerate(reasons))
    reviews_html = "".join(C.review_card(*r, delay=i % 3) for i, r in enumerate(REVIEWS[:3]))
    html, body = interior_head(
        title=f"Why Choose Barta Window Washing | Delano, MN's Top-Rated Cleaners",
        desc="Discover why Delano-area homeowners choose Barta Window Washing: licensed & insured, family-owned, detail-obsessed, eco-safe methods, and a 100% satisfaction guarantee. 5.0★ rated.",
        slug="why-choose-us.html", eyebrow="Why Choose Us",
        h1="The most trusted name in Minnesota exterior cleaning",
        lead="Anyone can squeegee a window. We've built our reputation on the things that actually matter — trust, detail, safety, and results you can count on, every single time.",
        depth=depth, crumb_label="Why Choose Us", primary_kw="best window cleaning company Delano MN")
    html += f"""<main id="main">{body}
  <section><div class="container">
    <div class="grid cols-3">{cards}</div>
  </div></section>
  <section class="bg-deep"><div class="container">
    <div class="stats">
      <div class="stat reveal"><div class="num" data-count="12" data-suffix="+">12+</div><div class="label">Years in business</div></div>
      <div class="stat reveal" data-delay="1"><div class="num" data-count="9400" data-suffix="+">9,400+</div><div class="label">Jobs completed</div></div>
      <div class="stat reveal" data-delay="2"><div class="num" data-count="100" data-suffix="+">100+</div><div class="label">5-star reviews</div></div>
      <div class="stat reveal" data-delay="3"><div class="num" data-count="98" data-suffix="%">98%</div><div class="label">Would refer a friend</div></div>
    </div>
  </div></section>
  <section><div class="container">
    <div class="section-head center"><span class="eyebrow">In their words</span><h2>Don't take our word for it</h2></div>
    <div class="grid cols-3">{reviews_html}</div>
  </div></section>
  {C.cta_band(depth)}
</main>"""
    html += C.page_end(depth)
    write("why-choose-us.html", html, slug="why-choose-us.html", priority="0.7")

# ===========================================================================
# ABOUT
# ===========================================================================
def build_about():
    depth = 0
    values = [("heart", "Treat every home like our own", "If we wouldn't do it on our own house, we won't do it on yours."),
              ("check-circle", "Do it right, not just fast", "Detail and care come first. Speed is a bonus, never the goal."),
              ("users", "People over transactions", "We're building relationships and a reputation, one neighbor at a time."),
              ("leaf", "Respect your home &amp; the planet", "Safe methods, careful protection, and eco-friendly solutions, always.")]
    val_html = "".join(f'<div class="feature reveal" data-delay="{i%2}"><span class="ic">{icon(ic)}</span><div><h4>{t}</h4><p>{d}</p></div></div>'
                       for i, (ic, t, d) in enumerate(values))
    html, body = interior_head(
        title=f"About {BIZ['name']} | Family-Owned Exterior Cleaning in Delano, MN",
        desc="Barta Window Washing is a family-owned, Delano-based exterior cleaning company founded in 2014. Learn our story, our values, and our commitment to your home.",
        slug="about.html", eyebrow="About Us",
        h1="A Delano family business, built on trust",
        lead=f"Founded in {BIZ['founded']}, Barta Window Washing has grown from a single ladder into the western metro's most trusted exterior cleaning team — without ever losing the personal touch that started it all.",
        depth=depth, crumb_label="About", primary_kw="about Barta Window Washing Delano MN")
    html += f"""<main id="main">{body}
  <section><div class="container"><div class="split">
    <div class="prose reveal">
      <span class="eyebrow">Our story</span>
      <h2 class="mt-1">It started with one promise</h2>
      <p>Ryan Barta grew up in Delano and started this company with a single goal: give local homeowners a window cleaner they could actually trust — one who showed up on time, sweated the details, and stood behind the work.</p>
      <p>That promise hasn't changed. We've grown to a full team serving homes and businesses across Wright, Hennepin, and Carver counties, and added gutter cleaning, pressure washing, house and roof soft washing, and holiday lighting along the way. But every job still gets the same care it did on day one — because our name is on it.</p>
      <p>When you call Barta, you're not getting a call center or a rotating cast of subcontractors. You're getting a local, family-owned team that genuinely cares whether your home looks its best.</p>
    </div>
    <div class="reveal">{C.photo("assets/img/team-barta.jpg", "The Barta Window Washing team in Delano, MN", ratio="5/4", depth=depth)}</div>
  </div></div></section>
  <section class="bg-mist"><div class="container"><div class="split reverse">
    <div class="reveal">{C.photo("assets/img/service-van.jpg", "A fully branded Barta Window Washing service van", ratio="5/4", depth=depth)}</div>
    <div class="reveal">
      <span class="eyebrow">On the road near you</span>
      <h2 class="mt-1">Look for the Barta van</h2>
      <p>Our clearly branded, fully stocked service vans are a familiar sight across Delano and the western metro. When one pulls into your driveway, you'll know exactly who's arriving — a uniformed, insured, local crew that treats your home like its own.</p>
      <ul class="checklist mt-2">
        <li>{icon('check-circle')} Uniformed, background-checked technicians</li>
        <li>{icon('check-circle')} Fully stocked with professional-grade equipment</li>
        <li>{icon('check-circle')} Licensed &amp; insured on every visit</li>
      </ul>
    </div>
  </div></div></section>
  <section><div class="container">
    <div class="section-head center"><span class="eyebrow">What we stand for</span><h2>Our values</h2></div>
    <div class="grid cols-2">{val_html}</div>
  </div></section>
  <section><div class="container"><div class="section-head center">
    <span class="eyebrow">The people</span><h2>Meet the team behind the shine</h2>
    <p>Get to know the friendly, hard-working crew who make your home sparkle.</p>
    <a class="btn mt-3" href="team.html">Meet the team {icon('arrow')}</a>
  </div></div></section>
  {C.cta_band(depth)}
</main>"""
    html += C.page_end(depth)
    write("about.html", html, slug="about.html", priority="0.7")

# ===========================================================================
# TEAM
# ===========================================================================
def build_team():
    depth = 0
    cards = ""
    for i, (name, role, initials, bio) in enumerate(TEAM):
        cards += f"""<div class="card reveal" data-delay="{i%3}" style="text-align:center">
        <div class="avatar" style="width:84px;height:84px;font-size:1.6rem;margin:0 auto 16px;border-radius:24px">{initials}</div>
        <h3 style="font-size:1.25rem">{name}</h3>
        <p style="color:var(--blue-600);font-weight:700;font-family:var(--font-head);margin-top:4px">{role}</p>
        <p class="mt-1" style="font-size:.95rem">{bio}</p></div>"""
    html, body = interior_head(
        title=f"Meet the Team | {BIZ['name']} Delano, MN",
        desc="Meet the friendly, professional, background-checked team behind Barta Window Washing — the people who make Delano-area homes and businesses shine.",
        slug="team.html", eyebrow="Meet the Team",
        h1="The crew behind the clean",
        lead="Friendly faces, serious skills. Every Barta team member is trained, background-checked, and genuinely proud of the work they do for your home.",
        depth=depth, crumb_label="Meet the Team", primary_kw="Barta Window Washing team Delano")
    html += f"""<main id="main">{body}
  <section><div class="container"><div class="grid cols-3">{cards}</div></div></section>
  <section class="bg-mist"><div class="container"><div class="section-head center">
    <span class="eyebrow">Join us</span><h2>Want to be part of the team?</h2>
    <p>We're always looking for detail-oriented, friendly people who take pride in their work.</p>
    <a class="btn mt-3" href="careers.html">See open positions {icon('arrow')}</a>
  </div></div></section>
  {C.cta_band(depth)}
</main>"""
    html += C.page_end(depth)
    write("team.html", html, slug="team.html", priority="0.6")

# ===========================================================================
# REVIEWS
# ===========================================================================
def build_reviews():
    depth = 0
    cards = "".join(C.review_card(*r, delay=i % 3) for i, r in enumerate(REVIEWS))
    schema = BASE_SCHEMA
    html, body = interior_head(
        title=f"Reviews & Testimonials | {BIZ['name']} — {BIZ['rating']}★ in Delano, MN",
        desc=f"Read {BIZ['review_count']}+ five-star reviews for Barta Window Washing. See why Delano-area homeowners rate us 5.0★ for window cleaning, gutters, pressure washing & more.",
        slug="reviews.html", eyebrow="Reviews", schema=schema,
        h1=f"{BIZ['rating']}★ rated by {BIZ['review_count']}+ neighbors",
        lead="We've earned our reputation one spotless home at a time. Here's what real customers across the western metro have to say about working with Barta.",
        depth=depth, crumb_label="Reviews", primary_kw="Barta Window Washing reviews Delano MN")
    html += f"""<main id="main">{body}
  <section class="section-tight bg-mist"><div class="container">
    <div class="stats stats-light">
      <div class="stat reveal"><div class="num" data-count="5.0">5.0</div><div class="label">Average rating</div></div>
      <div class="stat reveal" data-delay="1"><div class="num" data-count="100" data-suffix="+">100+</div><div class="label">Verified reviews</div></div>
      <div class="stat reveal" data-delay="2"><div class="num" data-count="98" data-suffix="%">98%</div><div class="label">Five-star ratings</div></div>
      <div class="stat reveal" data-delay="3"><div class="num" data-count="9400" data-suffix="+">9,400+</div><div class="label">Happy customers</div></div>
    </div>
  </div></section>
  <section><div class="container">{C.reviews_block(REVIEWS_WIDGET, cards, depth)}
    <div class="center mt-4">{C.google_badge(depth, light=True)}</div>
  </div></section>
  {C.cta_band(depth, heading="Join hundreds of happy homeowners", text="Experience the Barta difference for yourself. Get your free quote today.")}
</main>"""
    html += C.page_end(depth)
    write("reviews.html", html, slug="reviews.html", priority="0.7")

# ===========================================================================
# GALLERY
# ===========================================================================
def build_gallery():
    depth = 0
    ba_html = "".join(f'<div class="reveal" data-delay="{i%3}">{C.ba_slider(depth=depth, name=n)}</div>'
                      for i, n in enumerate(["ba1", "ba2", "ba3", "ba2", "ba1", "ba3"]))
    captions = ["Window cleaning — Delano", "House washing — Maple Grove", "Roof soft wash — Plymouth",
                "Driveway pressure washing — Wayzata", "Gutter cleaning — Buffalo", "Hard water removal — Waconia",
                "Solar panel cleaning — Medina", "Holiday lighting — Minnetonka", "Commercial storefront — Wayzata"]
    gal = "".join(f'<figure class="reveal" data-delay="{i%3}">{C.imgph(c, ratio="4/3")}<figcaption>{c}</figcaption></figure>'
                  for i, c in enumerate(captions))
    html, body = interior_head(
        title=f"Before & After Gallery | {BIZ['name']} Delano, MN",
        desc="Browse real before & after results from Barta Window Washing: window cleaning, house washing, roof cleaning, pressure washing & more across the western Twin Cities.",
        slug="gallery.html", eyebrow="Gallery",
        h1="See the Barta difference",
        lead="Drag the sliders and browse real transformations from homes and businesses across the western metro. Results like these are exactly what we'll bring to your property.",
        depth=depth, crumb_label="Gallery", primary_kw="window cleaning before after Delano MN")
    html += f"""<main id="main">{body}
  <section><div class="container">
    <div class="section-head center"><span class="eyebrow">Drag to reveal</span><h2>Before &amp; after</h2></div>
    <div class="grid cols-3">{ba_html}</div>
  </div></section>
  <section class="bg-mist"><div class="container">
    <div class="section-head center"><span class="eyebrow">Recent work</span><h2>Project gallery</h2>
      <p>Replace these placeholders with your own high-resolution job photos for maximum impact.</p></div>
    <div class="gallery">{gal}</div>
  </div></section>
  {C.cta_band(depth)}
</main>"""
    html += C.page_end(depth)
    write("gallery.html", html, slug="gallery.html", priority="0.7")

# ===========================================================================
# FAQS
# ===========================================================================
def build_faqs():
    depth = 0
    schema = BASE_SCHEMA + [S.faq_schema(FAQS)]
    html, body = interior_head(
        title=f"Frequently Asked Questions | {BIZ['name']} Delano, MN",
        desc="Answers to common questions about Barta Window Washing — pricing, scheduling, insurance, our guarantee, eco-safe methods, and maintenance plans. Still have questions? Call us.",
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
    cards = "".join(
        f"""<a class="card reveal" data-delay="{i%4}" href="areas/{a['slug']}.html" style="display:flex;align-items:center;gap:14px">
        <span class="ic" style="width:48px;height:48px;border-radius:14px;background:var(--grad-brand);color:#fff;display:grid;place-items:center;flex:none">{icon('pin')}</span>
        <span><span style="font-family:var(--font-head);font-weight:700;color:var(--navy-800);display:block">{a['city']}, MN</span>
        <span style="font-size:.85rem;color:var(--slate-500)">Window, gutter &amp; exterior cleaning</span></span></a>"""
        for i, a in enumerate(AREAS))
    html, body = interior_head(
        title=f"Service Areas | {BIZ['name']} — Delano & Western Twin Cities, MN",
        desc="Barta Window Washing proudly serves Delano, Maple Grove, Plymouth, Wayzata, Minnetonka, Buffalo, Waconia & more across the western Twin Cities metro. Find your city.",
        slug="service-areas.html", eyebrow="Service Areas",
        h1="Proudly serving the western Twin Cities",
        lead="Based in Delano and serving homeowners and businesses across Wright, Hennepin, and Carver counties. Find your community below.",
        depth=depth, crumb_label="Service Areas", primary_kw="window cleaning service areas Twin Cities MN")
    html += f"""<main id="main">{body}
  <section><div class="container"><div class="grid cols-3">{cards}</div>
    <p class="center mt-4" style="color:var(--slate-500)">Don't see your town? We likely serve it too — <a href="contact.html" style="color:var(--blue-600);font-weight:600">just ask</a>.</p>
  </div></section>
  {C.cta_band(depth)}
</main>"""
    html += C.page_end(depth)
    write("service-areas.html", html, slug="service-areas.html", priority="0.8")

# ===========================================================================
# AREA PAGES
# ===========================================================================
def build_area(a):
    depth = 1
    nbhds = ", ".join(a["neighborhoods"])
    svc_cards = "".join(
        f"""<a class="card svc-card reveal" data-delay="{i%4}" href="../services/{s['slug']}.html">
        <span class="ic">{icon(s['icon'])}</span><h3>{s['name']}</h3><p>{s['short']}</p>
        <span class="more">Learn more {icon('arrow')}</span></a>""" for i, s in enumerate(SERVICES[:6]))
    reviews_html = "".join(C.review_card(*r, delay=i % 3) for i, r in enumerate(REVIEWS[:3]))
    area_faqs = [
        (f"Do you serve all of {a['city']}, MN?",
         f"Yes — we serve the entire {a['city']} area, including {nbhds}. Whether you're in town or just outside it, we'd love to give you a free quote."),
        (f"How quickly can you get to my home in {a['city']}?",
         f"As a local company, we're often in the {a['city']} area each week and can usually schedule within a few days. Members always get priority. Call or request a quote to check current availability."),
        ("Are you insured to work in my city?",
         "Absolutely. Barta is fully licensed and insured to work throughout the western Twin Cities metro, including " + a["city"] + ". A certificate of insurance is available on request."),
    ]
    schema = BASE_SCHEMA + [S.faq_schema(area_faqs), S.breadcrumb([
        ("Home", BIZ["domain"] + "/"), ("Service Areas", BIZ["domain"] + "/service-areas.html"),
        (a["city"], BIZ["domain"] + "/areas/" + a["slug"] + ".html")])]
    homebase = " — our home base" if a["note"] == "our home base" else ""
    html = C.head(
        title=f"Window Cleaning & Exterior Services in {a['city']}, MN | {BIZ['name']}",
        desc=f"Top-rated window cleaning, gutter cleaning, pressure washing & house washing in {a['city']}, MN. Local, licensed & insured. Serving {nbhds}. Get your free quote from Barta!",
        slug=f"areas/{a['slug']}.html", depth=depth, schema=schema,
        primary_kw=f"window cleaning {a['city']} MN")
    html += C.nav(depth)
    html += f"""<main id="main">
  <section class="phero"><div class="container">
    {C.crumbs([("Home", "../index.html"), ("Service Areas", "../service-areas.html"), (a['city'], None)])}
    <div class="hero-grid">
      <div>
        <span class="eyebrow" style="color:#ff9b86">Serving {a['city']}, MN{homebase}</span>
        <h1 class="mt-1">Premium exterior cleaning in {a['city']}</h1>
        <p class="lead">Spotless windows, clear gutters, and a fresh-washed exterior for {a['city']} homes and businesses — from a local, family-owned team that treats your property like its own.</p>
        <div class="phero-actions">
          <a class="btn btn-lg btn-light" href="#quote-form">Get a Free {a['city']} Quote {icon('arrow')}</a>
          <a class="btn btn-lg btn-outline" style="color:#fff;box-shadow:inset 0 0 0 2px rgba(255,255,255,.4)" href="tel:{BIZ['phone_href']}">{icon('phone')} {BIZ['phone_display']}</a>
        </div>
      </div>
      <div>{C.lead_form(depth, heading=f"Free Quote in {a['city']}", compact=True)}</div>
    </div>
  </div></section>
  <section><div class="container"><div class="prose reveal" style="max-width:820px;margin-inline:auto;text-align:center">
    <span class="eyebrow" style="justify-content:center">Local experts</span>
    <h2 class="mt-1">Your trusted exterior cleaners in {a['city']}</h2>
    <p>Barta proudly serves homeowners and businesses throughout {a['city']} and the surrounding neighborhoods — including {nbhds}. From Minnesota's pollen-heavy springs to leaf-clogged falls and hard-water spotting in between, we know exactly what local homes need to look their best year-round.</p>
    <p>As a local, family-owned company, we're nearby, responsive, and personally invested in our reputation across {a['city']}. Every job is backed by full insurance and our 100% satisfaction guarantee.</p>
  </div></div></section>
  <section class="bg-mist"><div class="container">
    <div class="section-head center"><span class="eyebrow">In {a['city']}</span><h2>Services we offer locally</h2></div>
    <div class="grid cols-3">{svc_cards}</div>
    <div class="center mt-4"><a class="btn btn-ghost" href="../residential.html">View all services {icon('arrow')}</a></div>
  </div></section>
  <section><div class="container">
    <div class="section-head center"><span class="eyebrow">{a['city']} reviews</span><h2>What your neighbors say</h2></div>
    <div class="grid cols-3">{reviews_html}</div>
  </div></section>
  <section class="bg-mist"><div class="container">
    <div class="section-head center"><span class="eyebrow">Questions</span><h2>{a['city']} service FAQs</h2></div>
    {C.faq_block(area_faqs)}
  </div></section>
  {C.cta_band(depth, heading=f"Ready for a spotless home in {a['city']}?", text=f"Get your free, no-obligation quote today and see why {a['city']} trusts Barta Window Washing.")}
</main>"""
    html += C.page_end(depth)
    write(f"areas/{a['slug']}.html", html, slug=f"areas/{a['slug']}.html", priority="0.7")

# ===========================================================================
# CAREERS
# ===========================================================================
def build_careers():
    depth = 0
    jobs = [("Exterior Cleaning Technician", "Full-time · Delano, MN", "Join our residential crew cleaning windows, gutters, and exteriors. No experience required — we train. Must be reliable, friendly, and comfortable with ladders and heights."),
            ("Crew Lead", "Full-time · Western Metro", "Lead a 2–3 person crew, manage quality and safety, and represent Barta to our customers. 2+ years exterior cleaning or trades experience preferred."),
            ("Seasonal Holiday Lighting Installer", "Seasonal · Sept–Jan", "Help design and install premium holiday lighting displays. Great seasonal income with flexible scheduling. Comfort with heights required.")]
    job_html = "".join(f"""<div class="card reveal" data-delay="{i}">
        <h3 style="font-size:1.25rem">{t}</h3>
        <p style="color:var(--blue-600);font-weight:600;font-family:var(--font-head);margin-top:4px">{meta}</p>
        <p class="mt-1">{d}</p>
        <a class="btn btn-ghost mt-3" href="contact.html">Apply now {icon('arrow')}</a></div>""" for i, (t, meta, d) in enumerate(jobs))
    perks = [("dollar", "Competitive pay", "Above-market wages, performance bonuses, and tips."),
             ("calendar", "Flexible scheduling", "Full-time, part-time, and seasonal options."),
             ("users", "Great team culture", "Supportive crew, real training, and room to grow."),
             ("award", "Advancement", "We promote from within — crew lead and beyond.")]
    perk_html = "".join(f'<div class="feature reveal" data-delay="{i%2}"><span class="ic">{icon(ic)}</span><div><h4>{t}</h4><p>{d}</p></div></div>'
                        for i, (ic, t, d) in enumerate(perks))
    html, body = interior_head(
        title=f"Careers | Join the {BIZ['name']} Team in Delano, MN",
        desc="Join Barta Window Washing — a growing, family-owned exterior cleaning company in Delano, MN. Competitive pay, flexible schedules, training & advancement. Apply today!",
        slug="careers.html", eyebrow="Careers",
        h1="Grow with a team that takes pride in its work",
        lead="We're always looking for friendly, detail-oriented people who want honest work, fair pay, and room to grow. No experience? We'll train the right person.",
        depth=depth, crumb_label="Careers", primary_kw="window cleaning jobs Delano MN")
    html += f"""<main id="main">{body}
  <section><div class="container">
    <div class="section-head center"><span class="eyebrow">Why work here</span><h2>Perks of the job</h2></div>
    <div class="grid cols-2" style="max-width:820px;margin-inline:auto">{perk_html}</div>
  </div></section>
  <section class="bg-mist"><div class="container">
    <div class="section-head center"><span class="eyebrow">Open positions</span><h2>Current openings</h2></div>
    <div class="grid cols-3">{job_html}</div>
  </div></section>
  {C.cta_band(depth, heading="Ready to join the crew?", text="Tell us a bit about yourself and we'll be in touch. We can't wait to meet you.", primary=("Apply Today", "contact.html"))}
</main>"""
    html += C.page_end(depth)
    write("careers.html", html, slug="careers.html", priority="0.5")

# ===========================================================================
# FINANCING
# ===========================================================================
def build_financing():
    depth = 0
    opts = [("money", "Pay over time", "Spread larger projects — like full-home washing or roof cleaning — into easy monthly payments."),
            ("tag", "Membership budgeting", "Our maintenance plans turn big seasonal bills into a small, predictable monthly amount."),
            ("check-circle", "Simple application", "Quick, no-obligation approval decisions so you can move forward with confidence."),
            ("shield", "No surprises", "Clear terms, transparent pricing, and no hidden fees — ever.")]
    opt_html = "".join(f'<div class="feature reveal" data-delay="{i%2}"><span class="ic">{icon(ic)}</span><div><h4>{t}</h4><p>{d}</p></div></div>'
                       for i, (ic, t, d) in enumerate(opts))
    html, body = interior_head(
        title=f"Financing & Flexible Payment Options | {BIZ['name']} Delano, MN",
        desc="Flexible payment and financing options make premium exterior cleaning easy to budget. Spread larger projects into monthly payments or join a maintenance plan. Ask Barta how.",
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

# ===========================================================================
# CONTACT
# ===========================================================================
def build_contact():
    depth = 0
    schema = BASE_SCHEMA
    html, body = interior_head(
        title=f"Contact {BIZ['name']} | Free Quotes in Delano, MN",
        desc=f"Get in touch with Barta Window Washing. Call {BIZ['phone_display']}, email us, or request a free quote online. Serving Delano & the western Twin Cities, {BIZ['hours']}.",
        slug="contact.html", eyebrow="Contact", schema=schema,
        h1="Let's talk about your home",
        lead="Questions, quotes, or scheduling — we're here to help and happy to hear from you. Reach out and a friendly local team member will get right back to you.",
        depth=depth, crumb_label="Contact", primary_kw="contact window cleaning Delano MN")
    info = f"""<div class="card" style="display:grid;gap:18px">
      <a class="feature" href="tel:{BIZ['phone_href']}"><span class="ic">{icon('phone')}</span><div><h4>Call or text</h4><p>{BIZ['phone_display']}</p></div></a>
      <a class="feature" href="mailto:{BIZ['email']}"><span class="ic">{icon('mail')}</span><div><h4>Email</h4><p>{BIZ['email']}</p></div></a>
      <div class="feature"><span class="ic">{icon('pin')}</span><div><h4>Service area</h4><p>{BIZ['street']}, {BIZ['city']}, {BIZ['state']} {BIZ['zip']} &amp; the western metro</p></div></div>
      <div class="feature"><span class="ic">{icon('clock')}</span><div><h4>Hours</h4><p>{BIZ['hours']}</p></div></div>
    </div>"""
    html += f"""<main id="main">{body}
  <section><div class="container"><div class="hero-grid">
    <div class="reveal">
      <span class="eyebrow">Reach us directly</span>
      <h2 class="mt-1">Get in touch</h2>
      <p class="mt-1" style="color:var(--slate-500)">Prefer to talk? Call or text us anytime during business hours — we love hearing from neighbors.</p>
      <div class="mt-3">{info}</div>
    </div>
    <div class="reveal">{C.lead_form(depth, heading="Send us a message", sub="Fill this out and we'll reply quickly — usually the same day.", submit="Send Message")}</div>
  </div></div></section>
  {C.cta_band(depth)}
</main>"""
    html += C.page_end(depth)
    write("contact.html", html, slug="contact.html", priority="0.7")

# ===========================================================================
# REQUEST A QUOTE
# ===========================================================================
def build_quote():
    depth = 0
    schema = BASE_SCHEMA
    trust = "".join(f'<li>{icon("check-circle")} {t}</li>' for t in [
        "Free, no-obligation, same-day quotes", "Licensed &amp; fully insured", "100% satisfaction guarantee",
        "Family-owned &amp; locally trusted", f"{BIZ['rating']}★ from {BIZ['review_count']}+ reviews", "Safe, eco-friendly methods"])
    html, body = interior_head(
        title=f"Request a Free Quote | {BIZ['name']} Delano, MN",
        desc="Request your free, no-obligation exterior cleaning quote from Barta Window Washing. Same-day pricing for window cleaning, gutters, pressure washing & more. Takes 60 seconds.",
        slug="request-quote.html", eyebrow="Free Quote", schema=schema,
        h1="Get your free quote in 60 seconds",
        lead="Tell us a little about your home and the service you need. We'll get back to you fast — usually the same day — with clear, upfront, no-obligation pricing.",
        depth=depth, crumb_label="Request a Quote", cta_form=False, primary_kw="free window cleaning quote Delano MN")
    html += f"""<main id="main">{body}
  <section><div class="container"><div class="hero-grid">
    <div class="reveal">
      <span class="eyebrow">Why request a quote</span>
      <h2 class="mt-1">No pressure. No surprises.</h2>
      <ul class="checklist mt-2" style="font-size:1.05rem">{trust}</ul>
      <div class="card mt-4" style="background:var(--mist);border:0">
        <div class="feature"><span class="ic">{icon('phone')}</span><div><h4>Prefer to call?</h4><p><a href="tel:{BIZ['phone_href']}" style="color:var(--blue-600);font-weight:700">{BIZ['phone_display']}</a> · {BIZ['hours']}</p></div></div>
      </div>
    </div>
    <div class="reveal">{C.lead_form(depth)}</div>
  </div></div></section>
  {C.cta_band(depth, heading="The clearest view starts with a quote", text="Join hundreds of happy Delano-area homeowners. We can't wait to make your home shine.")}
</main>"""
    html += C.page_end(depth)
    write("request-quote.html", html, slug="request-quote.html", priority="0.9")

# ===========================================================================
# PRIVACY (minimal legal)
# ===========================================================================
def build_privacy():
    depth = 0
    html, body = interior_head(
        title=f"Privacy Policy | {BIZ['name']}",
        desc="Privacy policy for Barta Window Washing. Learn how we collect, use, and protect the information you share when requesting a quote or contacting us.",
        slug="privacy.html", eyebrow="Legal", h1="Privacy Policy",
        lead="Your trust matters to us. This policy explains what information we collect and how we use it.",
        depth=depth, crumb_label="Privacy")
    html += f"""<main id="main">{body}<section><div class="container"><div class="prose" style="margin-inline:auto">
    <p><em>Last updated: June 2026. This is a starter template — have it reviewed by legal counsel before launch.</em></p>
    <h2>Information we collect</h2>
    <p>When you request a quote or contact us, we collect the details you provide — such as your name, phone number, email, service address, and notes about your project. We do not sell your personal information to anyone.</p>
    <h2>How we use it</h2>
    <ul><li>To prepare and deliver your quote</li><li>To schedule and perform your service</li><li>To send reminders and follow-ups you opt into</li><li>To improve our services and respond to questions</li></ul>
    <h2>Communications</h2>
    <p>If you opt in to reminders or marketing, you can unsubscribe anytime. We only contact you about your requests and services you've shown interest in.</p>
    <h2>Data security</h2>
    <p>We take reasonable measures to protect your information and limit access to team members who need it to serve you.</p>
    <h2>Contact</h2>
    <p>Questions about this policy? Email <a href="mailto:{BIZ['email']}">{BIZ['email']}</a> or call {BIZ['phone_display']}.</p>
  </div></div></section></main>"""
    html += C.page_end(depth)
    write("privacy.html", html, slug="privacy.html", priority="0.2")

# ===========================================================================
# BLOG HUB + POSTS
# ===========================================================================
def build_blog():
    depth = 0
    cards = ""
    for i, p in enumerate(POSTS):
        cards += f"""<a class="card reveal" data-delay="{i%3}" href="blog/{p['slug']}.html" style="display:flex;flex-direction:column">
        {C.imgph(p['cat'], ratio="16/9")}
        <span class="pill mt-2" style="align-self:flex-start;background:var(--mist-2);border:0;color:var(--blue-600)">{p['cat']}</span>
        <h3 class="mt-1" style="font-size:1.2rem">{p['title']}</h3>
        <p class="mt-1" style="font-size:.95rem">{p['excerpt']}</p>
        <span class="more" style="margin-top:auto;padding-top:14px;display:inline-flex;gap:7px;color:var(--blue-600);font-weight:700;font-family:var(--font-head)">Read article {icon('arrow')}</span>
        <span style="font-size:.8rem;color:var(--slate-400);margin-top:6px">{p['date']} · {p['read']} read</span></a>"""
    html, body = interior_head(
        title=f"Blog | Exterior Cleaning Tips & Guides | {BIZ['name']}",
        desc="Expert tips on window cleaning, gutter care, house & roof washing, and seasonal home maintenance from Barta Window Washing in Delano, MN.",
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
            ("When to soft wash", "Roofs, siding, stucco, screens, and painted surfaces should always be soft washed. High pressure can strip paint, etch stucco, lift shingles, and void roofing warranties. Soft washing cleans gently and kills algae at the root, so results last far longer."),
            ("The bottom line", "A good exterior cleaner uses both — matched to each surface. That's exactly how Barta approaches every home: the right method, the right pressure, the right solution, every time."),
        ],
        "remove-roof-black-streaks": [
            ("What those streaks actually are", "Those dark streaks running down your roof are a blue-green algae called Gloeocapsa magma. It feeds on the limestone filler in asphalt shingles, spreads in humid Minnesota summers, and slowly shortens your roof's life."),
            ("Why pressure washing makes it worse", "Blasting a roof with high pressure tears off the protective granules, drives water under shingles, and can void your manufacturer warranty. It might look better for a week — then the algae comes back faster."),
            ("The safe way to remove it", "The industry-recommended method is soft washing: a low-pressure application of algae-killing solution that dissolves the growth at the root, followed by a gentle rinse. Done right, your roof looks new and stays clean far longer."),
            ("Prevention", "Installing zinc or copper strips near the ridge releases trace metals when it rains, slowing regrowth. We'll assess your roof and recommend the right long-term approach during a free inspection."),
        ],
        "gutter-cleaning-checklist-fall": [
            ("Why fall is critical", "Clogged gutters in winter mean ice dams, overflow, and water pooling against your foundation. Clearing them before the first freeze is one of the cheapest, highest-impact things you can do to protect your home."),
            ("The checklist", "Clear all gutters of leaves and debris by hand. Flush downspouts and confirm water flows freely to the ground and away from the house. Check for sagging sections and loose hangers. Inspect seams for leaks. Look at the roof edge for damage or missing shingles."),
            ("Don't forget the extensions", "Make sure downspout extensions carry water at least four to six feet away from your foundation. Water pooling at the base of your home is a leading cause of basement leaks and foundation issues."),
            ("Let us handle it", "Fall gutter cleaning means ladders, heights, and a mess to haul away. Our crew clears everything by hand, flushes every downspout, bags the debris, and gives you a free inspection report — usually in a single visit."),
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
    }]
    html = C.head(title=f"{p['title']} | {BIZ['name']} Blog", desc=p["excerpt"],
                  slug=f"blog/{p['slug']}.html", depth=depth, schema=schema, og_type="article")
    html += C.nav(depth)
    html += f"""<main id="main">
  <section class="phero"><div class="container">
    {C.crumbs([("Home", "../index.html"), ("Blog", "../blog.html"), (p['cat'], None)])}
    <div style="max-width:760px">
      <span class="eyebrow" style="color:#ff9b86">{p['cat']} · {p['read']} read</span>
      <h1 class="mt-1">{p['title']}</h1>
      <p class="lead">{p['excerpt']}</p>
    </div>
  </div></section>
  <section><div class="container"><div class="split" style="grid-template-columns:1fr 320px;align-items:start">
    <article class="prose reveal">{article}
      <div class="card mt-4" style="background:var(--mist);border:0">
        <h3 style="font-size:1.25rem">Want it handled for you?</h3>
        <p class="mt-1">Skip the ladder and let Barta take care of it. Get a free, no-obligation quote today.</p>
        <a class="btn mt-2" href="../request-quote.html">Get my free quote {icon('arrow')}</a>
      </div>
    </article>
    <aside class="reveal">
      <div class="card"><h4>Related reading</h4><ul class="mt-2" style="display:grid;gap:12px">{rel_html}</ul></div>
      <div class="card mt-2" style="background:var(--grad-deep);color:#fff">
        <h4 style="color:#fff">Free quote</h4>
        <p style="color:rgba(255,255,255,.8);margin-top:8px">Same-day pricing, no obligation.</p>
        <a class="btn btn-light btn-block mt-2" href="../request-quote.html">Get started {icon('arrow')}</a>
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
    {"slug": "free-window-cleaning-quote", "svc": "window-cleaning", "h1": "Free Window Cleaning Quote in Delano, MN",
     "headline": "Streak-free windows, zero hassle — get your free quote today",
     "kw": "free window cleaning quote Delano MN",
     "guarantee": "Streak-Free Guarantee: if it streaks, we re-clean it free."},
    {"slug": "free-pressure-washing-quote", "svc": "pressure-washing", "h1": "Free Pressure Washing Quote in Delano, MN",
     "headline": "Restore your driveway, patio &amp; walkways — free quote in 60 seconds",
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
    {"slug": "commercial-quote", "svc": None, "h1": "Free Commercial Cleaning Quote — Western Twin Cities",
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
    ben_html = "".join(f'<div class="feature reveal" data-delay="{i%2}"><span class="ic">{icon("check")}</span><div><h4>{t}</h4><p>{d}</p></div></div>'
                       for i, (t, d) in enumerate(benefits))
    reviews_html = "".join(C.review_card(*r, delay=i % 3) for i, r in enumerate(REVIEWS[:3]))
    lp_faqs = [
        ("How fast will I get my quote?", "Most quotes are returned the same day during business hours — often within a couple of hours. Many can be priced without an on-site visit."),
        ("Is the quote really free?", "Yes — 100% free and no obligation. We'll give you clear, upfront, all-in pricing with no pressure and no hidden fees."),
        ("Are you licensed and insured?", "Absolutely. Barta is fully licensed and carries liability and workers' comp insurance. Certificate available on request."),
        ("What if I'm not satisfied?", "Every service is backed by our 100% Satisfaction Guarantee. If anything isn't right, we make it right — free."),
    ]
    schema = BASE_SCHEMA + [S.faq_schema(lp_faqs)]
    trust = "".join(f'<li>{icon("check-circle")} {t}</li>' for t in [
        f"{BIZ['rating']}★ from {BIZ['review_count']}+ reviews", "Licensed &amp; fully insured",
        "Same-day, no-obligation quotes", "100% satisfaction guarantee", "Family-owned &amp; local"])
    html = C.head(title=f"{L['h1']} | {BIZ['name']}",
                  desc=f"{L['headline'].replace('&amp;','&')}. Licensed, insured & guaranteed. Serving Delano & the western Twin Cities. Get your free, no-obligation quote from Barta now!",
                  slug=f"landing/{L['slug']}.html", depth=depth, schema=schema, primary_kw=L["kw"])
    html += C.nav(depth)
    html += f"""<main id="main">
  <section class="phero"><div class="container"><div class="hero-grid">
    <div>
      <div class="hero-rating" style="background:rgba(255,255,255,.12)">{stars_row()}<span>{BIZ['rating']}/5 · {BIZ['review_count']}+ reviews</span></div>
      <h1 class="mt-1">{L['headline']}</h1>
      <p class="lead">Trusted, family-owned exterior cleaning across the western Twin Cities. Get clear, upfront pricing with no pressure and no obligation.</p>
      <ul class="hero-trust">
        <li>{icon('shield')} Licensed &amp; insured</li>
        <li>{icon('check-circle')} {L['guarantee'].split(':')[0]}</li>
        <li>{icon('clock')} Same-day quotes</li>
      </ul>
    </div>
    <div>{C.lead_form(depth, heading="Get My Free Quote", sub="Same-day pricing. No obligation. 60 seconds.", svc_default=L['svc'])}</div>
  </div></div></section>

  <section class="section-tight bg-mist"><div class="container">{C.trust_badges()}</div></section>

  <section><div class="container"><div class="split">
    <div class="reveal"><span class="eyebrow">Why Barta</span><h2 class="mt-1">Benefits you'll notice</h2>
      <div class="mt-3" style="display:grid;gap:22px">{ben_html}</div>
    </div>
    <div class="reveal">{C.ba_slider(depth=depth, name="ba1")}</div>
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
    <div class="grid cols-3">{reviews_html}</div>
  </div></section>

  <section class="bg-mist"><div class="container"><div class="hero-grid">
    <div class="reveal"><span class="eyebrow">No risk</span><h2 class="mt-1">Why request your quote now</h2>
      <ul class="checklist mt-2" style="font-size:1.05rem">{trust}</ul>
      <a class="btn mt-3" href="tel:{BIZ['phone_href']}">{icon('phone')} Or call {BIZ['phone_display']}</a>
    </div>
    <div class="reveal">{C.faq_block(lp_faqs)}</div>
  </div></div></section>

  {C.cta_band(depth, heading="Claim your free quote today", text="It takes 60 seconds and there's zero obligation. Let's make your property shine.")}
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
          '<text x="80" y="548" font-family="Arial, sans-serif" font-size="31" fill="#c9c9cf">Premium exterior cleaning · 5.0★ · Licensed &amp; insured</text></svg>')
    write_asset("assets/img/og-cover.svg", og)

def write_asset(relpath, content):
    path = os.path.join(ROOT, relpath)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)

def build_meta_files():
    today = datetime.date.today().isoformat()
    # robots.txt
    write_asset("robots.txt", f"User-agent: *\nAllow: /\n\nSitemap: {BIZ['domain']}/sitemap.xml\n")
    # manifest
    write_asset("site.webmanifest",
        '{"name":"Barta Window Washing","short_name":"Barta","start_url":"/","display":"standalone",'
        '"background_color":"#ffffff","theme_color":"#0b2a4a","icons":[{"src":"/assets/img/favicon.svg","sizes":"any","type":"image/svg+xml"}]}')
    # sitemap
    urls = ""
    for relpath, slug, priority in PAGES:
        loc = BIZ["domain"] + "/" + (slug if slug else "")
        urls += f"  <url><loc>{loc}</loc><lastmod>{today}</lastmod><priority>{priority}</priority></url>\n"
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

def main():
    C.ASSET_VER = _asset_version()
    build_home()
    for s in SERVICES:
        build_service(s)
    build_plans()
    build_commercial()
    build_residential()
    build_why()
    build_about()
    build_team()
    build_reviews()
    build_gallery()
    build_faqs()
    build_service_areas()
    for a in AREAS:
        build_area(a)
    build_careers()
    build_financing()
    build_contact()
    build_quote()
    build_privacy()
    build_blog()
    for i, p in enumerate(POSTS):
        build_post(p, i)
    for L in LANDING:
        build_landing(L)
    build_images()
    build_meta_files()
    print(f"✓ Generated {len(PAGES)} pages + assets.")
    for relpath, slug, pr in PAGES:
        print(f"   {relpath}")

if __name__ == "__main__":
    main()
