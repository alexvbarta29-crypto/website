"""City service pages: /window-cleaning-<town>-mn/.

Laid out like the individual service pages (services/*.html), per the owner:
a full-width photo hero, the "Save money with every service" plan picker,
a "Why <town>" write-up, a labelled "Jobs we've done in <town>" gallery,
the FAQs, and the closing call-to-action band. No quote form, services
grid or review block: the page is there to rank for "window cleaning in
<town>" and send people to the quote page.

One directory + index.html per town, so the clean URL works on every host
(Netlify and the GitHub Pages preview alike) with no rewrite rule. Each
town's copy is hand-written in sitedata.CITY_PAGES; this module only
supplies the frame and the per-town JSON-LD.
"""
import components as C
import schema as S
from icons import icon
from sitedata import BIZ, SERVICES, CITY_PAGES, LIVE_CITY_PAGES, city_page_path

DEPTH = 1  # window-cleaning-<slug>-mn/index.html

# Meta descriptions longer than this get cut off in search results.
DESC_MAX = 155
# Until a town has real job photos, its "Jobs we've done" section is left
# off the page: dashed "Placeholder" boxes look unfinished to customers and
# to Google. Set True to show JOB_SLOTS placeholder slots instead (useful on
# a preview while collecting photos). A town's section appears on its own
# as soon as its "jobs" list has entries.
SHOW_JOB_PLACEHOLDERS = False
JOB_SLOTS = 3

_WINDOWS = next(s for s in SERVICES if s["slug"] == "exterior-window-cleaning")
# The quote form's service checkbox these pages pre-tick.
_QUOTE_SVC = C.SERVICE_SLUG_TO_LABEL.get(_WINDOWS["slug"], _WINDOWS["slug"])


def _tel(text):
    """Turn the office number in a paragraph into a tap-to-call link (the
    JSON-LD copy of the same text stays plain)."""
    return text.replace(BIZ["phone_display"], f'<a href="tel:{BIZ["phone_href"]}">{BIZ["phone_display"]}</a>')


# ---------------------------------------------------------------------------
# JSON-LD
# ---------------------------------------------------------------------------
def _local_business(c):
    """The site-wide LocalBusiness node with this town first in areaServed.
    Same @id as every other page, so the rest of the service area stays (a
    contradictory areaServed on one page would muddy the entity)."""
    biz = S.local_business()
    town = {"@type": "City", "name": f"{c['city']}, MN",
            "containedInPlace": {"@type": "AdministrativeArea", "name": f"{c['county']}, Minnesota"}}
    biz["areaServed"] = [town] + [a for a in biz["areaServed"] if a["name"] != town["name"]]
    return biz


def _service_node(c):
    node = S.service_schema(_WINDOWS)
    node["name"] = f"Window Cleaning in {c['city']}, MN"
    node["areaServed"] = [{"@type": "City", "name": f"{c['city']}, MN"}]
    node["url"] = BIZ["domain"] + "/" + city_page_path(c)
    node["image"] = BIZ["domain"] + "/" + c["hero"]
    return node


# ---------------------------------------------------------------------------
# Sections
# ---------------------------------------------------------------------------
def _why(c):
    intro = "".join(f"<p>{p}</p>" for p in c["why_intro"])
    points = "".join(f"<h3>{h}</h3><p>{p}</p>" for h, p in c["why_points"])
    return f"""
  <section>
    <div class="container">
      <div class="prose reveal" style="max-width:820px;margin-inline:auto">
        <span class="eyebrow">Why {c['city']}</span>
        <h2 class="mt-1">{c['why_heading']}</h2>
        {intro}
        {points}
      </div>
    </div>
  </section>"""


def _jobs(c):
    """Real jobs render as a photo with its label underneath. Until the owner
    sends some, the slots are dashed, tagged placeholders so nobody mistakes
    them for finished content; never fill these with stock or other towns'
    photos."""
    jobs = c.get("jobs") or []
    if jobs:
        # 4:5 tiles: phone photos are mostly portrait, and a landscape shot
        # still keeps its middle three-fifths.
        cards = "".join(
            f"""<figure class="job-card reveal" data-delay="{i % 3}">
        {C.photo(j["photo"], j.get("alt") or j["label"], ratio="4/5", depth=DEPTH)}
        <figcaption>{j["label"]}</figcaption>
      </figure>""" for i, j in enumerate(jobs))
    elif not SHOW_JOB_PLACEHOLDERS:
        return ""
    else:
        cards = "".join(
            f"""<div class="ph-card job-ph reveal" data-delay="{i}">
        <span class="ph-tag">Placeholder</span>
        <span class="job-ph-photo" aria-hidden="true">{icon('image')}</span>
        <h3>Photo of a real {c['city']} job</h3>
        <p>Label: neighborhood &middot; what we cleaned</p>
      </div>""" for i in range(JOB_SLOTS))
    count = len(jobs) or JOB_SLOTS
    grid = {1: 'cols-1 job-grid-1', 2: 'cols-2 job-grid-2'}.get(count, 'cols-3')
    return f"""
  <section class="bg-mist">
    <div class="container">
      <div class="section-head center">
        <span class="eyebrow" style="justify-content:center">Recent work</span>
        <h2>Jobs we&rsquo;ve done in {c['city']}</h2>
      </div>
      <div class="grid {grid}">{cards}</div>
    </div>
  </section>"""


# ---------------------------------------------------------------------------
# Page
# ---------------------------------------------------------------------------
_REQUIRED = ("title", "desc", "hero", "hero_sub", "why_heading", "why_intro", "why_points", "faqs")


def _check(c):
    missing = [k for k in _REQUIRED if not c.get(k)]
    assert not missing, f"{c['slug']}: missing {', '.join(missing)}"
    assert len(c["desc"]) <= DESC_MAX, f"{c['slug']}: meta description is {len(c['desc'])} chars (max {DESC_MAX})"
    assert c["title"] == f"Window Cleaning in {c['city']}, MN", f"{c['slug']}: title must be 'Window Cleaning in {c['city']}, MN'"
    assert 3 <= len(c["faqs"]) <= 4, f"{c['slug']}: 3-4 FAQs expected"


def _check_unique(cities):
    """No copy-paste pages: prose must differ between towns, including the
    answers to the FAQ questions every town shares."""
    def texts(c):
        yield "hero_sub", c["hero_sub"]
        yield "desc", c["desc"]
        yield "why_heading", c["why_heading"]
        for p in c["why_intro"]:
            yield "why_intro", p
        for h, p in c["why_points"]:
            yield "why_points", p
        for q, a in c["faqs"]:
            yield "faq answer", a
    seen = {}
    for c in cities:
        for field, t in texts(c):
            key = t.strip().lower()
            assert key not in seen or seen[key] == c["slug"], \
                f"{c['slug']} and {seen[key]} share the same {field} text"
            seen[key] = c["slug"]


def render(c, seo_title, hero_picture):
    _check(c)
    city = c["city"]
    root = C.rel(DEPTH)
    path = city_page_path(c)
    faqs = c["faqs"]
    schema = [_local_business(c), S.organization(), S.website(), _service_node(c),
              S.faq_schema(faqs),
              S.breadcrumb([("Home", BIZ["domain"] + "/"),
                            ("Service Areas", BIZ["domain"] + "/service-areas.html"),
                            (city, BIZ["domain"] + "/" + path)])]
    html = C.head(
        title=seo_title(c["title"]),
        desc=c["desc"],
        slug=path, depth=DEPTH, schema=schema,
        canonical=BIZ["domain"] + "/" + path,
        og_image=c["hero"],
        primary_kw=f"window cleaning {city} MN")
    html += C.nav(DEPTH)
    html += f"""
<main id="main">
  <section class="svc-hero">
    <div class="svc-hero-media" aria-hidden="true">{hero_picture(root, c["hero"], c.get("hero_pos"))}</div>
    <div class="svc-hero-overlay" aria-hidden="true"></div>
    <div class="container">
      {C.crumbs([("Home", root + "index.html"), ("Service Areas", root + "service-areas.html"), (city, None)], light=True)}
      <h1>Window Cleaning in {city},&nbsp;MN</h1>
      <p class="lead">{c['hero_sub']}</p>
      <div class="hero-actions">
        <a class="btn btn-lg" href="{root}get-quote.html?svc={_QUOTE_SVC}">Get Your Quote {icon('arrow')}</a>
      </div>
    </div>
  </section>

  <section class="bg-mist" id="plans">
    <div class="container">
      <div class="section-head center">
        <span class="eyebrow" style="justify-content:center">Membership Savings</span>
        <h2>Save money with every service</h2>
        <p>Join a recurring plan and save on every visit, the more often we come, the more you save.</p>
      </div>
      <div class="promo-grid">{C.promo_plan_cards(DEPTH, svc=_QUOTE_SVC)}</div>
    </div>
  </section>
{_why(c)}
{_jobs(c)}

  <section>
    <div class="container">
      <div class="section-head center"><span class="eyebrow">Questions</span><h2>{city} window cleaning FAQs</h2></div>
      {C.faq_block([(q, _tel(a)) for q, a in faqs])}
    </div>
  </section>

  {C.cta_band(DEPTH, heading=f"Ready for cleaner windows in {city}?",
              text=f"Get your free, no-obligation window cleaning quote today and see why {city} homeowners trust Barta.")}
</main>"""
    html += C.page_end(DEPTH)
    return html


def build_all(write, seo_title, hero_picture):
    _check_unique(LIVE_CITY_PAGES)
    for c in LIVE_CITY_PAGES:
        path = city_page_path(c)
        write(path + "index.html", render(c, seo_title, hero_picture), slug=path, priority="0.8")
