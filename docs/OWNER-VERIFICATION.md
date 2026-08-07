# Owner Verification — Required Before Production Launch

This is an internal, non-published checklist. Every claim below is currently live on the site,
sourced from the files noted, and has **not** been independently verified against real business
practice. Nothing here has been invented by an SEO/content pass — these are pre-existing site claims
being surfaced for confirmation, not new copy. Confirm, correct, or explicitly approve each item before
treating the site as production-ready.

This file is intentionally **not linked from any customer-facing page** and carries no `noindex`
concern because it isn't part of the generated site at all — it lives only in the repository.

---

## Audit history

- **Full sitewide technical/production-readiness audit:** every claim below was re-checked against
  the current generated HTML across all 80 pages. All individual claims and the plan-structure
  conflict were still present, worded the same way, and still unverified — nothing new was
  discovered, nothing was resolved. That pass's fixes were purely technical (meta description
  length, a broken image reference, build-dependency robustness) and did not touch any claim,
  price, guarantee, or business fact.
- **Incorrect membership system removed:** at the owner's explicit direction, the
  Clear View / Crystal Plus / Signature Estate monthly-membership system (`PLANS` in
  `build/sitedata.py`, `build.build_plans()`, `service-plans.html`) has been **permanently
  deleted** — it was created by mistake and was never the correct program. See Section 1 below.
- **Owner review pass (this update):** the owner was asked directly about every unverified claim on
  the site and responded item by item. Resolved this pass:
  - **Fake testimonials removed.** `REVIEWS` in `build/sitedata.py` previously contained 5 invented
    customer quotes attributed to fabricated names — these were never real and have been deleted
    entirely (list is now empty). Every page that showed them (`homepage`, `reviews.html`,
    `why-choose-us.html`, every area page, every landing page) now falls back to a real Google
    rating badge/CTA instead of fabricated cards when no curated quote is available. Note: the site
    already has a real, live Google-reviews widget wired up via Trustindex
    (`config/google-reviews-embed.html`, `config/google-reviews-embed-reviews-page.html`) — the
    fake cards were only ever a fallback shown before that widget loads, so real review content was
    likely already visible to most visitors even before this fix.
  - **Team roles corrected.** Alex and Jacob Barta are real brothers who co-founded the company in
    2024 (confirmed) — but they are not interchangeable in the field. **Alex leads the technicians
    and field crews** on every job site; **Jacob runs the office and sales side** (quotes,
    scheduling, customer contact). Every "why we do it this way" blurb that implied both brothers
    personally perform hands-on cleaning has been rewritten to reflect this (`build/sitedata.py`
    `why_barta` fields, `build/build.py` About/Team page copy).
  - **Google review link confirmed** by the owner — kept as-is (with a minor `&safe=active` param
    added per the owner's paste).
  - **5.0★ rating and 100+ reviews confirmed real** by the owner (also independently corroborated by
    the live Trustindex widget above).
  - **"Bonded" and "workers' compensation" claims removed** — the owner confirmed "licensed and
    insured" but was not able to confirm bonding or workers' comp specifically, so those specific
    claims were dropped sitewide in favor of the confirmed, simpler "licensed and insured."
  - **Solar/soft-wash stats replaced with sourced figures.** The owner asked that any statistic be a
    real one rather than an invented number. The solar-panel "15–25% output loss" claim is now
    "up to 25%," grounded in published soiling-loss research (see sources in commit). The soft-
    washing "lasts 4–6× longer" claim was reworded to "results last for years, not weeks" since no
    citable source supports a precise multiplier, though the general "lasts much longer" direction
    is well supported. The roof-cleaning ARMA claim was independently verified as accurate — ARMA
    does recommend a low-pressure/chemical method over pressure washing, which can void shingle
    warranties — and was left as-is.
  - **Service-area list under review.** Owner's rule: keep a city only if it's a real Minnesota town
    within roughly an hour's drive of Delano; remove/replace any invented neighborhood name within
    each city's entry. Fact-checking against real sources (Wikipedia, city sites) is in progress —
    see item 22 below.
- **Second owner review pass (this update):** owner was asked about the remaining open items,
  plus two pages found to have real problems on inspection. Resolved this pass:
  - **Gallery page removed entirely.** `gallery.html` was showing 9 empty placeholder boxes
    captioned with specific fake job locations (including "Waconia," a town not even in the
    service-area list at the time) under copy claiming "real before & after results" — and had a
    leftover developer note ("Replace these placeholders...") visibly rendering on the live page.
    Owner confirmed there are no real job photos yet, so the page, its nav/footer links, and its
    build function have been deleted rather than left showing fabricated/broken content. Rebuild
    real photos back in via a new `build_gallery()` when photos exist.
  - **Careers page removed entirely.** The 3 "current openings" listed weren't actually open.
    Deleted the page, its nav/footer links, and its build function; `team.html`'s "join us" CTA now
    points to `contact.html` instead of a dead link.
  - **Waconia added to the service-area list** (`build/sitedata.py` → `AREAS`, `ZIP_CODES`) — owner
    confirmed it's a real town they service; independently verified at 31 minutes / 19 miles from
    Delano (well within the 1-hour rule) with real neighborhood/landmark names sourced from the
    city's own site (Downtown Waconia, Lake Waconia shoreline, Lakeview Terrace).
  - **Recurring-plan dollar amounts and perks confirmed real** by the owner — see items 1-6 below,
    now marked confirmed.
  - **"Call within 48 hours" guarantee wording removed** — owner confirmed there's no specific
    guaranteed response-time window. All instances now just say "call us and we'll make it right,"
    with no time limit stated.
  - **Christmas light storage clarified** — it's included in the installation price owner quotes,
    not a separate free perk or paid add-on. Reworded "Free/Optional storage" language throughout
    `christmas-light-installation` to "storage included in your price."
  - **Booking lead-time FAQ corrected** — owner said timing varies (same-day to a couple weeks
    depending on season/schedule), not a fixed "1–2 weeks" recommendation. Wording updated.
- **Third owner review pass (this update):** owner stated directly that Barta does not perform
  roof cleaning/washing. This **supersedes** the note above (line ~55) that the roof-cleaning ARMA
  claim was "independently verified as accurate" — that verification is now moot since the service
  itself has been removed, not because the ARMA fact was wrong.
  - **Roof Cleaning service deleted entirely.** The `roof-cleaning` entry in `SERVICES`
    (`build/sitedata.py`), the generated `services/roof-cleaning.html` page, and every reference to
    it (`_SERVICE_AREA_FAMILY` and `SERVICE_SLUG_TO_LABEL` lookup tables, the blog-photo map, the
    `IMAGE_ALT` entry for its hero image) have been removed. It was already hidden from the main nav
    and footer before this pass, but the standalone page, its FAQs, and its "we handle every
    black-streak and moss job" marketing copy were still live and bookable.
  - **Roof-themed blog post deleted.** "What Those Black Streaks on Your Roof Really Are"
    (`remove-roof-black-streaks`) was dedicated to promoting the roof-cleaning service and used
    first-person claims ("We'll assess your roof and recommend the right long-term approach") —
    deleted along with its generated page rather than left live for a service that no longer exists.
  - **Roof mentions stripped from Soft Washing and Pressure Washing pages too**, at the owner's
    explicit direction, even though those are real services — "roofs" had been listed as one of the
    delicate surfaces soft washing covers. All copy, SEO keywords, and FAQ wording on
    `services/soft-washing.html` and `services/pressure-washing.html` (`build/sitedata.py`) now says
    stucco/siding instead of roofs; the related "Soft Washing vs. Pressure Washing" blog post
    (`build/build.py`) was updated the same way. Roof mentions that describe a genuinely different
    service — the free visual roof check that comes with gutter cleaning, and roof/array access for
    solar panel cleaning — were left as-is since neither claims Barta washes/cleans the roof itself.

---

## 1. Recurring-plan structure — conflict resolved by deletion

This repo previously described **two different, non-reconciled membership systems**: the correct
Biannual/Quarterly/Monthly per-cleaning-discount cards (`PROMO_PLANS`/`PROMO_FEATS`, shown on the
homepage, every service page, and the quote wizard), and an unrelated Clear View/Crystal Plus/
Signature Estate monthly-membership system (`PLANS`, rendered only on the now-deleted
`service-plans.html`).

**At the owner's direction, the Clear View/Crystal Plus/Signature Estate system was created by
mistake and has been permanently removed** — its data block, page-builder function, generated page,
every navigation/footer/body link to it, its sitemap entry, and the one customer testimonial that
referenced "Crystal Plus" are all gone. Nothing was renamed or repurposed to stand in for it.

**Only the Biannual/Quarterly/Monthly program remains**, and it is now the single, uncontested
source of truth for recurring-plan pricing sitewide. Its own numbers (below, items 1-3) were not
part of the conflict and still need independent owner confirmation — removing the conflicting
system did not verify the remaining one's dollar amounts or perks.

---

## 2. Individual claims

| # | Claim | Pages it appears on | Source file | Current wording | Status | Recommended action if inaccurate |
|---|---|---|---|---|---|---|
| 1 | $50 biannual discount | Homepage, all 13 service pages, quote wizard | `build/sitedata.py` → `PROMO_PLANS` | "Biannual … $50 OFF Per Cleaning" | **CONFIRMED by owner** | — |
| 2 | $100 quarterly discount | Same as above | `build/sitedata.py` → `PROMO_PLANS` | "Quarterly … $100 OFF Per Cleaning", marked "Most Popular" | **CONFIRMED by owner** | — |
| 3 | $150 monthly discount | Same as above | `build/sitedata.py` → `PROMO_PLANS` | "Monthly … $150 OFF Per Cleaning" | **CONFIRMED by owner** | — |
| 4 | Priority Scheduling (promo-card perk) | Same as above | `build/sitedata.py` → `PROMO_FEATS` | Listed as included on Quarterly/Monthly, excluded on Biannual | **CONFIRMED by owner** | — |
| 5 | "7-Day Rain Guarantee" | Same as above | `build/sitedata.py` → `PROMO_FEATS` | Listed as included on Quarterly/Monthly, excluded on Biannual | **CONFIRMED by owner** | Owner confirmed the perk is real; the exact terms of what it covers still aren't written down anywhere on the site — worth a dedicated sentence somewhere if customers ask what it means in practice. |
| 6 | "Free Hard Water Removal" (plan perk) | Same as above | `build/sitedata.py` → `PROMO_FEATS` | Listed as included on Quarterly/Monthly, excluded on Biannual | **CONFIRMED by owner** | Owner confirmed the perk is real; whether it means the light spot-treatment already bundled into standard cleaning vs. the full paid Hard Water Stain Removal service is still not spelled out anywhere — worth clarifying in the perk's own wording. |
| 7 | Screens included with every exterior cleaning | `services/exterior-window-cleaning.html` | `build/sitedata.py` → `exterior-window-cleaning.includes/faqs` | "Yes — screens are removed, hand-washed, and reinstalled as part of every exterior window cleaning visit." | Needs Owner Verification | Confirm this is universal, not tier/plan-dependent. |
| 8 | Tracks and sills included with every exterior cleaning | `services/exterior-window-cleaning.html` | Same | "Yes — exterior sills, tracks, and frames are wiped down on every visit, not just the glass." | Needs Owner Verification | Same. |
| 9 | Light mineral/spot treatment included | `services/exterior-window-cleaning.html` | `build/sitedata.py` → `exterior-window-cleaning.benefits/includes/faqs` | "Light spot treatment" benefit; "Spot treatment for light hard-water and mineral marks" (includes); FAQ distinguishes this from the separate Hard Water Stain Removal service | Needs Owner Verification | Confirm light treatment really is standard/included and not upsold. |
| 10 | Streak-free guarantee | `services/exterior-window-cleaning.html`, `services/interior-window-cleaning.html` | `build/sitedata.py` → both services' `benefits` | "We don't leave until every pane is spotless — or we come back free." | Needs Owner Verification | Confirm the "come back free" mechanism and any time limit. |
| 11 | 100% satisfaction guarantee | Homepage, Why Choose Us, About, every area page, every landing page, generic service FAQ | `build/build.py` (multiple call sites), `build/sitedata.py` | "If anything isn't right, call us and we'll re-clean it free" — no time window stated | **Resolved** | Owner confirmed there is **no** guaranteed response-time window — the "within 48 hours" claim was false and has been removed everywhere it appeared. |
| 12 | Free return visit / re-clean | Same pages as #11 | Same | "we return and re-clean it free" | **CONFIRMED by owner** | — |
| 13 | Storage of Christmas lights between seasons | `services/christmas-light-installation.html` | `build/sitedata.py` → `christmas-light-installation.includes/faqs` | Storage is included in the quoted installation price, not a separate free perk or paid add-on | **Resolved** | Owner clarified storage is baked into the price — not "optional"/"free" as separately-worded perks. Copy updated throughout the service page. |
| 14 | Whether Barta supplies the Christmas lights | `services/christmas-light-installation.html` | `build/sitedata.py` → `christmas-light-installation.includes/faqs` | "Premium, commercial-grade LED lights and greenery" (includes); FAQ: "Yes — commercial-grade LED lights and greenery are included in the installation. You don't need to buy or supply anything yourself." | Needs Owner Verification | If customers are ever expected to supply/own their own lights in some cases, this needs to say so. |
| 15 | Liability insurance | Footer (every page), homepage, Why Choose Us, About, every service `why_barta`, every area/landing page | `build/components.py` (`footer()`), `build/build.py` (multiple), `build/sitedata.py` (`why_barta` fields) | "Licensed & insured" | **CONFIRMED by owner** | — |
| 16 | Workers' compensation insurance | — | — | Specific "workers' comp" wording removed sitewide | **Resolved — claim removed** | Owner confirmed "licensed and insured" generally but couldn't confirm workers' comp specifically, so the specific claim was dropped in favor of the confirmed wording. |
| 17 | Licensed status | Same pages as #15 | Same | "fully licensed" | **CONFIRMED by owner** | — |
| 18 | Bonded status | — | — | "Bonded" claim removed from `commercial-cleaning.benefits` | **Resolved — claim removed** | Owner wasn't sure what "bonded" meant / couldn't confirm it — dropped rather than guessed. |
| 19 | Founding year (2024), brothers/co-owners | Homepage stats ("Since 2024"), About/Team pages, schema.org `foundingDate` | `build/sitedata.py` → `BIZ["founded"]`, `TEAM` | `"founded": "2024"`; Alex & Jacob Barta are brothers | **CONFIRMED by owner** | Owner also clarified their actual roles — Alex leads the field crew, Jacob runs office/sales — copy updated accordingly throughout. |
| 20 | Business hours | Footer (every page), Contact page, LocalBusiness schema | `build/sitedata.py` → `BIZ["hours"]`, `build/schema.py` → `openingHoursSpecification` | "Mon–Fri 8am–6pm, Sat 8am–6pm, Sun Closed" | **CONFIRMED by owner — updated to match Google** | Three sources disagreed: this doc said weekdays to 7pm, the schema said 19:00/17:00, and the footer text said 18:00/17:00. Owner confirmed Saturday runs to 6pm (matching their Google listing); the schema and footer are now both 08:00–18:00 Mon–Sat. |
| 21 | Address, phone, email, social links | Footer (every page), Contact page, About, LocalBusiness schema, manifest | `build/sitedata.py` → `BIZ[...]` | 320 3rd St S, Delano, MN 55328 · (763) 314-3400 · office@bartawindowwashing.com · Facebook/Instagram/TikTok | **CONFIRMED by owner** | — |
| 22 | Service-area claims (36 cities + neighborhood names) | Every area page (36), service-area hub, footer | `build/sitedata.py` → `AREAS` | 36 Minnesota communities within ~1hr of Delano, each with neighborhood names | **Resolved** | Owner's rule: keep only real MN towns within ~1hr of Delano, remove fabricated neighborhood names. Research confirmed all 36 cities are genuinely within an hour's drive (farthest checked: Rogers at 38 min). 3 fabricated neighborhood names were found and replaced with real, sourced ones: Delano's "Lake Ridge"→"Highland Ridge" and "Bartholomew"→"Kings Pointe"; St. Michael's "River Pointe"→"Riverview Preserve"; Rockford's "River Edge"→"Downtown Rockford". All other neighborhood names were independently verified as real (city sites, Wikipedia, DNR lake records, realtor neighborhood guides) or are safe generic descriptors ("Downtown X", "X Township", "X Lake shoreline"). |
| 23 | 5.0★ rating / 100+ reviews | Homepage hero, stat counters, Reviews page title/meta/H1, every landing page, OG share image | `build/sitedata.py` → `BIZ["rating"]`, `BIZ["review_count"]` | "5.0★ from 100+ reviews" | **CONFIRMED by owner** | Also independently corroborated: the site's live Trustindex Google-reviews widget (`config/google-reviews-embed*.html`) pulls real reviews. |
| 24 | Late-cancellation/no-show fee | `terms.html` | `build/build.py` → `build_terms()` | "Late cancellations or no-shows may result in a cancellation fee, which will be communicated to you at the time of booking." | Needs Owner Verification | Terms &amp; Conditions was rewritten (owner request, modeled on a competitor's ToS structure) to be a real, comprehensive document instead of a 7-line starter template. This specific clause is standard boilerplate for the industry but wasn't drawn from an existing confirmed Barta policy — confirm whether a cancellation fee is actually charged, and if so on what basis, or remove the clause if it isn't. |
| 25 | Accepted payment methods | `terms.html` | Same | "We accept major debit and credit cards along with other payment methods communicated at the time of booking." | Needs Owner Verification | Deliberately kept generic (no specific card networks named, unlike the competitor template's "Visa, Mastercard, American Express, and Discover") since the actual accepted methods aren't confirmed anywhere else on the site. Update to name specific methods once confirmed. |

### Still open (not yet addressed by the owner)
- Items 7-10 above (screens/tracks/spot-treatment inclusion, the exact "come back free" mechanism
  behind the streak-free guarantee) remain unconfirmed.
- The commercial-cleaning "quotes typically within 24 hours" turnaround claim (`build/sitedata.py` →
  `commercial-cleaning.benefits`) is still unconfirmed.
- The exact terms of the "7-Day Rain Guarantee" and what "Free Hard Water Removal" actually covers
  (see the notes on items 5-6) are confirmed to exist but not yet spelled out anywhere.
- Items 24-25 (cancellation fee, accepted payment methods) — new as of the Terms &amp; Conditions
  rewrite, not yet confirmed. Both `terms.html` and `privacy.html` also still carry the pre-existing
  "not legal advice — have a licensed attorney review" disclaimer; that recommendation stands
  regardless of how complete the copy looks now.

---

- **Fourth owner review pass (this update):** the owner supplied the founding motivation directly,
  which had previously been the one gap on the About page — the story could only state *what* the
  company is, not *why* it exists, because inventing a founding narrative was off the table.
  Owner's words: the company was started by him and his brother **because they want to raise the
  standard of the home service industry**, bringing **old-school customer service with a modern edge
  and feel**. This is now the opening of "Our Story" on `about.html` and the page's meta
  description. **Sourced from the owner, not written by an SEO pass** — treat it as confirmed.
  Owner then asked that Our Story lead with the problem they set out to fix (their words: the
  service industry "was terrible") rather than with the company, and that it **not** describe who
  does which job — the roles are already covered by the team bios lower on the page. The story now
  opens on the industry's low standards, then the founding, then old-school service with a modern
  edge. The critical characterisation of the industry is the owner's own stated position, not an
  invented grievance, and it names no competitor.

---

## Blockers for going live (not claims — things that must be done)

These aren't unverified statements, they're unfinished wiring. Deliberately
deferred by the owner until launch; listed here so they can't be forgotten.

| # | Blocker | Where | Status |
|---|---|---|---|
| A | **Quote forms have no delivery endpoint.** All 45 lead forms POST to `LEAD_FORM["endpoint"]`, which is empty. Until it's set, submitting shows the call-us fallback instead of a confirmation — so no lead is silently lost, but no lead is captured automatically either. Owner uses **Rotor** as their CRM; needs Rotor's inbound-lead/webhook URL, a Zapier/Make catch hook, or a form-to-email service. Must be safe to expose publicly — this is a static site, so a secret API key can't be used without a proxy. | `build/sitedata.py` → `LEAD_FORM`; see `docs/LEAD-FORM-SETUP.md` | **Open — deferred to launch** |
| B | **Custom domain not connected.** GitHub Pages serves the site at `alexvbarta29-crypto.github.io/website/`, but every canonical URL, `og:url`, `sitemap.xml` entry and schema.org record declares `https://www.bartawindowwashing.com`. Until the domain is attached, search engines are told the real address is somewhere that isn't serving the site, and essentially none of the SEO work can take effect. | GitHub repo → Settings → Pages; a `CNAME` file in the deploy artifact | **Open — deferred to launch** |
| C | **No analytics of any kind.** No GA4, no Meta pixel, nothing. There's no way to tell whether the site converts, which pages work, or where leads come from. Worth adding before spending on ads or SEO. | — | **Open** |

---

## How to resolve an item

1. Confirm the fact with the business owner.
2. Update the single source file listed (most are in `build/sitedata.py` or `build/components.py`).
3. Run `python3 build/build.py` to regenerate every page that uses it.
4. Delete the corresponding row from this file once confirmed accurate, or update the "Current
   wording" column if it changed.

Do not mark the site launch-ready while unresolved rows remain above.
