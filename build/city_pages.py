"""City service pages: /window-cleaning-<town>-mn/.

One directory + index.html per town, so the clean URL the owner asked for
works on every host (Netlify and the GitHub Pages preview alike) with no
rewrite rule. The areas/ pages share one template; these deliberately do
not: each town's copy is hand-written in sitedata.CITY_PAGES and this
module only supplies the frame around it (hero + quote form, services
grid, review and jobs slots, FAQ, CTA) plus the per-town JSON-LD.
"""
import components as C
import schema as S
from icons import icon, ICONS
from sitedata import BIZ, SERVICES, AREAS, CITY_PAGES, LIVE_CITY_PAGES, city_page_path

DEPTH = 1  # window-cleaning-<slug>-mn/index.html

# Services listed on every city page, in the owner's order. Screen cleaning
# is sold as an add-on to a window cleaning and is labelled that way.
CITY_SERVICE_SLUGS = ["exterior-window-cleaning", "interior-window-cleaning", "screen-cleaning",
                      "gutter-cleaning", "pressure-washing", "house-washing"]
ADD_ON = {"screen-cleaning": "Add-on"}

# While the owner is still collecting a real review and job photos for a
# town, the page shows clearly marked placeholder cards where they will go
# (dashed, tagged "Placeholder"). Set this False to publish without them:
# the review slot then falls back to the Google-rating badge and the jobs
# section is left out entirely.
SHOW_PLACEHOLDERS = True

# Meta descriptions longer than this get cut off in search results.
DESC_MAX = 155

_AREA_BY_SLUG = {a["slug"]: a for a in AREAS}
_CITY_BY_SLUG = {c["slug"]: c for c in CITY_PAGES}
_SVC_BY_SLUG = {s["slug"]: s for s in SERVICES}


def href(c, depth):
    return C.rel(depth) + city_page_path(c)


def _icon(name, fallback="check-circle"):
    return icon(name if name in ICONS else fallback)


def _tel(text):
    """Turn the office number in a paragraph into a tap-to-call link (the
    JSON-LD copy of the same text is stripped of tags separately)."""
    return text.replace(BIZ["phone_display"], f'<a href="tel:{BIZ["phone_href"]}">{BIZ["phone_display"]}</a>')


def _nearby_links(c, primary_slugs):
    """Pills for nearby towns that actually have a page: a live city page
    first, else a primary areas/ page. Towns with no page are left out
    rather than rendered as dead text."""
    out = []
    for slug in c.get("nearby", []):
        other = _CITY_BY_SLUG.get(slug)
        if other and other.get("live") and other["slug"] != c["slug"]:
            out.append((other["city"], href(other, DEPTH)))
        elif slug in primary_slugs:
            out.append((_AREA_BY_SLUG[slug]["city"], f"../areas/{slug}.html"))
    return out


# ---------------------------------------------------------------------------
# JSON-LD
# ---------------------------------------------------------------------------
def _local_business(c):
    """The site-wide LocalBusiness node with areaServed narrowed to this
    town, which is the point of the page. Same @id: it is the same business."""
    biz = S.local_business()
    biz["areaServed"] = [{
        "@type": "City",
        "name": f"{c['city']}, MN",
        "containedInPlace": {"@type": "AdministrativeArea", "name": f"{c['county']}, Minnesota"},
    }]
    return biz


def _service_node(c):
    node = S.service_schema(_SVC_BY_SLUG["exterior-window-cleaning"])
    node["name"] = f"Window Cleaning in {c['city']}, MN"
    node["areaServed"] = [{"@type": "City", "name": f"{c['city']}, MN"}]
    node["url"] = BIZ["domain"] + "/" + city_page_path(c)
    return node


# ---------------------------------------------------------------------------
# Sections
# ---------------------------------------------------------------------------
def _service_cards():
    cards = ""
    for i, slug in enumerate(CITY_SERVICE_SLUGS):
        s = _SVC_BY_SLUG[slug]
        tag = f'<span class="addon-tag">{ADD_ON[slug]}</span>' if slug in ADD_ON else ""
        cards += f"""<a class="card svc-card reveal" data-delay="{i % 3}" href="../services/{s['slug']}.html">
        <span class="ic">{icon(s['icon'])}</span><h3>{s['name']}{tag}</h3><p>{s['short']}</p>
        <span class="more">Learn more {icon('arrow')}</span></a>"""
    return cards


def _points(c):
    cards = ""
    for i, (ic, title, text) in enumerate(c.get("points", [])):
        cards += f"""<div class="card point-card reveal" data-delay="{i % 3}">
        <h3>{_icon(ic)} {title}</h3><p>{text}</p></div>"""
    return cards


def _review_block(c):
    r = c.get("review")
    if r:
        return f"""<div style="max-width:640px;margin-inline:auto">{C.review_card(r['text'], r['name'], r['place'], r['initials'])}</div>
    <p class="center mt-3"><a class="btn btn-ghost" href="{BIZ['google']}" target="_blank" rel="noopener">{icon('star')} See all reviews on Google {icon('arrow')}</a></p>"""
    if SHOW_PLACEHOLDERS:
        return f"""<div class="ph-card" style="max-width:640px;margin-inline:auto">
      <span class="ph-tag">Placeholder</span>
      <h3>A real review from a {c['city']} customer goes here</h3>
      <p>Paste a Google review from a {c['city']} customer: their own words, first name and last initial, and the neighborhood or lake. Nothing is invented; this stays a placeholder until you add one.</p>
    </div>
    <p class="center mt-3">{C.google_badge(DEPTH)}</p>"""
    return C.reviews_block(None, "", DEPTH)


def _jobs_section(c):
    jobs = c.get("jobs") or []
    if jobs:
        cards = ""
        for i, j in enumerate(jobs):
            photo = ""
            if j.get("photo"):
                photo = f'<img src="../{j["photo"]}" alt="{j.get("alt", j["title"])}" loading="lazy" style="width:100%;border-radius:12px;margin-bottom:14px">'
            cards += f"""<div class="card job-card reveal" data-delay="{i % 3}">{photo}<span class="job-meta">{j.get('meta', c['city'] + ', MN')}</span><h3>{j['title']}</h3><p>{j['text']}</p></div>"""
    elif SHOW_PLACEHOLDERS:
        cards = "".join(f"""<div class="ph-card reveal" data-delay="{i}">
      <span class="ph-tag">Placeholder</span>
      <h3>Real job #{i + 1} in {c['city']}</h3>
      <p>A short write-up of a job you actually did here: the neighborhood or lake, what you cleaned, and a before/after photo if you have one.</p>
    </div>""" for i in range(2))
    else:
        return ""
    cols = "cols-2" if len(jobs) in (0, 2) else "cols-3"
    return f"""
  <section><div class="container">
    <div class="section-head center"><span class="eyebrow">Recent work</span><h2>Jobs we&rsquo;ve done in {c['city']}</h2></div>
    <div class="grid {cols}" style="max-width:900px;margin-inline:auto">{cards}</div>
  </div></section>"""


# ---------------------------------------------------------------------------
# Page
# ---------------------------------------------------------------------------
def _check(c):
    assert len(c["desc"]) <= DESC_MAX, f"{c['slug']}: meta description is {len(c['desc'])} chars (max {DESC_MAX})"
    assert c["title"].startswith("Window Cleaning in "), f"{c['slug']}: title must start with 'Window Cleaning in'"
    assert 3 <= len(c["faqs"]) <= 4, f"{c['slug']}: 3-4 FAQs expected"
    assert c["intro"] and c["market"] and c["points"], f"{c['slug']}: intro, market and points are required"


def _check_unique(cities):
    """No copy-paste pages: the prose fields must differ between towns."""
    for field in ("lead", "desc", "intro", "market"):
        seen = {}
        for c in cities:
            key = " ".join(c[field]) if isinstance(c[field], list) else c[field]
            assert key not in seen, f"{c['slug']} and {seen[key]} share the same '{field}' text"
            seen[key] = c["slug"]


def render(c, seo_title, primary_slugs):
    _check(c)
    city = c["city"]
    faqs = c["faqs"]
    path = city_page_path(c)
    schema = [_local_business(c), S.organization(), S.website(), _service_node(c),
              S.faq_schema(faqs),
              S.breadcrumb([("Home", BIZ["domain"] + "/"),
                            ("Service Areas", BIZ["domain"] + "/service-areas.html"),
                            (city, BIZ["domain"] + "/" + path)])]
    intro = "".join(f"<p>{p}</p>" for p in c["intro"])
    market = "".join(f"<p>{p}</p>" for p in c["market"])
    nearby = _nearby_links(c, primary_slugs)
    nearby_html = "".join(f'<a class="pill" href="{h}">{n}, MN</a>' for n, h in nearby)
    nearby_section = f"""
  <section class="bg-mist"><div class="container">
    <div class="section-head center"><span class="eyebrow">Nearby</span><h2>Also serving communities near {city}</h2></div>
    <div class="pills" style="justify-content:center">{nearby_html}</div>
    <div class="center mt-3"><a class="btn btn-ghost" href="../service-areas.html">See all service areas {icon('arrow')}</a></div>
  </div></section>""" if nearby else ""
    faq_html = C.faq_block([(q, _tel(a)) for q, a in faqs])

    html = C.head(
        title=seo_title(c["title"]),
        desc=c["desc"],
        slug=path, depth=DEPTH, schema=schema,
        canonical=BIZ["domain"] + "/" + path,
        primary_kw=f"window cleaning {city} MN")
    html += C.nav(DEPTH)
    html += f"""<main id="main">
  <section class="phero"><div class="container">
    {C.crumbs([("Home", "../index.html"), ("Service Areas", "../service-areas.html"), (city, None)])}
    <div class="hero-grid">
      <div>
        <span class="eyebrow">{c['eyebrow']}</span>
        <h1 class="mt-1">Window Cleaning in {city}, MN</h1>
        <p class="lead">{c['lead']}</p>
        <div class="phero-actions">
          <a class="btn btn-lg" href="#quote-form">Get a Free {city} Quote {icon('arrow')}</a>
          <a class="btn btn-lg btn-ghost" href="tel:{BIZ['phone_href']}">{icon('phone')} {BIZ['phone_display']}</a>
        </div>
        <div class="city-proof">
          {C.google_badge(DEPTH, light=True, text=f"{BIZ['review_count']}+ 5-star Google reviews")}
          <span class="proof-item">{icon('shield')} Fully insured</span>
          <span class="proof-item">{icon('check-circle')} 100% satisfaction guarantee</span>
        </div>
      </div>
      <div>{C.lead_form(DEPTH, heading=f"Free Quote in {city}", compact=True)}</div>
    </div>
  </div></section>
  <section><div class="container"><div class="prose reveal" style="max-width:820px;margin-inline:auto">
    <span class="eyebrow">{c['intro_eyebrow']}</span>
    <h2 class="mt-1">{c['intro_heading']}</h2>
    {intro}
  </div></div></section>
  <section class="bg-mist"><div class="container">
    <div class="section-head center"><span class="eyebrow">{c['market_eyebrow']}</span><h2>{c['market_heading']}</h2></div>
    <div class="prose reveal" style="max-width:820px;margin-inline:auto;text-align:center">{market}</div>
    <div class="grid cols-3 mt-4">{_points(c)}</div>
  </div></section>
  <section><div class="container">
    <div class="section-head center"><span class="eyebrow">What we do in {city}</span><h2>Our services</h2><p>{c['services_note']}</p></div>
    <div class="grid cols-3">{_service_cards()}</div>
  </div></section>
  <section class="bg-mist"><div class="container">
    <div class="section-head center"><span class="eyebrow">From a {city} customer</span><h2>What your neighbors say</h2></div>
    {_review_block(c)}
  </div></section>{_jobs_section(c)}{nearby_section}
  <section><div class="container">
    <div class="section-head center"><span class="eyebrow">Questions</span><h2>{city} window cleaning FAQs</h2></div>
    {faq_html}
  </div></section>
  {C.cta_band(DEPTH, heading=f"Ready for cleaner windows in {city}?", text=f"Call {BIZ['phone_display']} or request your free, no-obligation quote online. Every job is backed by our 100% satisfaction guarantee: if a window isn't right, we re-clean it free.")}
</main>"""
    html += C.page_end(DEPTH)
    return html


def build_all(write, seo_title, primary_slugs):
    cities = LIVE_CITY_PAGES
    _check_unique(cities)
    for c in cities:
        path = city_page_path(c)
        write(path + "index.html", render(c, seo_title, primary_slugs), slug=path, priority="0.8")
